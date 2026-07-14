# -*- coding: utf-8 -*-
"""
Đàn bầu recording analyzer.

Decodes MP3s with ffmpeg, segments the performance into sustained notes,
and for each note measures:
  - fundamental (sounding pitch) via NSDF (McLeod) pitch tracking
  - exact harmonic frequencies (quadratic sub-bin interpolation)
  - inharmonicity coefficient B      (f_n = n f0 sqrt(1 + B n^2))
  - per-harmonic T60 decay times     (bandpass + Hilbert envelope + dB fit)
  - harmonic amplitude ratios        (timbre signature, dB rel H1)
  - vibrato (rung) rate and depth    (FFT of the detrended f0 track)
  - attack rise time (10% -> 90% of envelope peak)
Plus a per-file long-term average spectrum of the voiced material.

Aggregates across all notes/files into model-tuning targets, written to
analysis/results.json.

Usage:  python analyze.py file1.mp3 [file2.mp3 ...]
Only numpy/scipy required; decoding is delegated to ffmpeg.
"""
import json
import subprocess
import sys
import numpy as np
import scipy.signal as sig

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SR = 48000
FRAME = 4096          # pitch analysis frame
HOP = 512
FMIN, FMAX = 90.0, 1400.0
LAG_MIN = int(SR / FMAX)
LAG_MAX = int(SR / FMIN)


def decode(path):
    p = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR),
         "-f", "f32le", "pipe:1"],
        capture_output=True)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.decode(errors="replace"))
    return np.frombuffer(p.stdout, dtype=np.float32).copy()


def nsdf_frame(x):
    """McLeod normalized square difference; returns (f0, clarity)."""
    w = len(x)
    fft = np.fft.rfft(x, 2 * w)
    ac = np.fft.irfft(fft * np.conj(fft))[:w]
    e = np.cumsum(x * x)
    tot = e[-1]
    # m[tau] = energy(x[0:w-tau]) + energy(x[tau:w])
    m = (e[w - 1 - np.arange(w)]) + (tot - np.concatenate(([0.0], e[:-1])))
    m[m < 1e-12] = 1e-12
    nsdf = 2.0 * ac / m
    seg = nsdf[LAG_MIN:LAG_MAX]
    if len(seg) < 3:
        return 0.0, 0.0
    # key-maximum picking: all local maxima above 0.8 * global max
    gmax = np.max(seg)
    if gmax < 0.3:
        return 0.0, gmax
    idx = sig.argrelmax(seg, order=2)[0]
    idx = idx[seg[idx] > 0.80 * gmax]
    if len(idx) == 0:
        idx = [int(np.argmax(seg))]
    tau = idx[0] + LAG_MIN            # first strong peak = fundamental period
    if 1 <= tau < w - 1:              # parabolic refinement
        a, b, c = nsdf[tau - 1], nsdf[tau], nsdf[tau + 1]
        den = a - 2 * b + c
        if abs(den) > 1e-12:
            tau = tau + 0.5 * (a - c) / den
    return SR / tau, float(gmax)


def track_pitch(y):
    n = (len(y) - FRAME) // HOP
    f0 = np.zeros(n)
    cl = np.zeros(n)
    rms = np.zeros(n)
    for i in range(n):
        fr = y[i * HOP: i * HOP + FRAME]
        rms[i] = np.sqrt(np.mean(fr * fr))
        f0[i], cl[i] = nsdf_frame(fr)
    return f0, cl, rms


def segment_notes(f0, cl, rms):
    """Contiguous voiced runs with stable (vibrato-tolerant) pitch."""
    floor = np.percentile(rms[rms > 0], 10) if np.any(rms > 0) else 0
    voiced = (cl > 0.70) & (f0 > FMIN) & (f0 < FMAX) & (rms > 3.0 * floor)
    notes = []
    i, n = 0, len(f0)
    while i < n:
        if not voiced[i]:
            i += 1
            continue
        j = i
        gap = 0
        ref = []
        while j < n:
            if voiced[j]:
                med = np.median(ref[-15:]) if ref else f0[j]
                if abs(1200 * np.log2(f0[j] / med)) > 90:
                    break
                ref.append(f0[j])
                gap = 0
            else:
                gap += 1
                if gap > 4:
                    break
            j += 1
        if len(ref) * HOP / SR >= 0.35:
            notes.append((i, j - gap))
        i = max(j, i + 1)
    return notes


def quad_peak(mag, k):
    if 0 < k < len(mag) - 1:
        a, b, c = mag[k - 1], mag[k], mag[k + 1]
        den = a - 2 * b + c
        if abs(den) > 1e-12:
            return k + 0.5 * (a - c) / den
    return float(k)


def harmonic_peaks(y, center, f0, nharm=8, win=8192, zp=4):
    s = int(center - win // 2)
    s = max(0, min(s, len(y) - win))
    fr = y[s:s + win] * np.hanning(win)
    nfft = win * zp
    mag = np.abs(np.fft.rfft(fr, nfft))
    bw = SR / nfft
    out = []
    for h in range(1, nharm + 1):
        tf = f0 * h
        if tf > SR * 0.45:
            break
        half = max(3, int((f0 * 0.05 * h) / bw))
        k0 = int(tf / bw)
        lo, hi = max(1, k0 - half), min(len(mag) - 2, k0 + half)
        if hi <= lo:
            break
        k = lo + int(np.argmax(mag[lo:hi]))
        kk = quad_peak(mag, k)
        out.append((kk * bw, float(mag[k])))
    return out


def fit_B(peaks):
    """(f_n/(n f1))^2 - 1 = B n^2 through the measured partials."""
    if len(peaks) < 3:
        return None
    f1 = peaks[0][0]
    X, Y = [], []
    for i, (fn, _) in enumerate(peaks):
        n = i + 1
        X.append(n ** 4)  # weight higher partials (they carry the signal)
        Y.append(((fn / (n * f1)) ** 2 - 1) * n * n)
    B = float(np.linalg.lstsq(np.array(X)[:, None], np.array(Y),
                              rcond=None)[0][0])
    return B


def band_t60(y, fn, t0, t1):
    """T60 of one partial: bandpass, Hilbert envelope, dB-slope fit."""
    lo = max(30.0, fn * 0.94)
    hi = min(SR / 2 - 100, fn * 1.06)
    if hi <= lo:
        return None
    seg = y[t0:t1]
    if len(seg) < int(0.3 * SR):
        return None
    sos = sig.butter(2, [lo, hi], btype="bandpass", fs=SR, output="sos")
    env = np.abs(sig.hilbert(sig.sosfiltfilt(sos, seg)))
    env = sig.medfilt(env[:: 32], 21)          # decimate + smooth
    t = np.arange(len(env)) * 32 / SR
    pk = int(np.argmax(env))
    env, t = env[pk:], t[pk:] - t[pk]
    if len(env) < 30 or env[0] <= 0:
        return None
    db = 20 * np.log10(np.maximum(env, 1e-9) / env[0])
    # fit between -3 dB and -30 dB (or as deep as the note actually decays)
    deep = max(np.min(db), -30.0)
    if deep > -12.0:
        return None                            # interrupted by next note
    m = (db <= -3.0) & (db >= deep)
    if np.sum(m) < 10:
        return None
    slope = np.polyfit(t[m], db[m], 1)[0]
    if slope >= -1e-3:
        return None
    return float(-60.0 / slope)


def vibrato(f0seg):
    """Rate (Hz) and depth (± cents) of periodic pitch modulation."""
    if len(f0seg) < 80:
        return None
    cents = 1200 * np.log2(f0seg / np.median(f0seg))
    trend = sig.medfilt(cents, 31)
    dev = cents - trend
    fr = SR / HOP
    nfft = 1024
    spec = np.abs(np.fft.rfft(dev * np.hanning(len(dev)), nfft))
    fx = np.fft.rfftfreq(nfft, 1 / fr)
    band = (fx >= 3.0) & (fx <= 9.0)
    if not np.any(band):
        return None
    k = np.where(band)[0][int(np.argmax(spec[band]))]
    rate = float(fx[k])
    depth = float(np.sqrt(2) * np.std(dev))
    if depth < 4.0:                             # no meaningful vibrato
        return None
    return {"rate_hz": round(rate, 2), "depth_cents": round(depth, 1)}


def attack_ms(y, t0_samp):
    seg = y[max(0, t0_samp - int(0.05 * SR)): t0_samp + int(0.30 * SR)]
    if len(seg) < 512:
        return None
    env = np.abs(sig.hilbert(seg))
    env = sig.medfilt(env[::16], 9)
    pk = np.max(env)
    if pk <= 0:
        return None
    i90 = int(np.argmax(env >= 0.9 * pk))
    i10 = 0
    for i in range(i90, -1, -1):
        if env[i] <= 0.1 * pk:
            i10 = i
            break
    return float((i90 - i10) * 16 / SR * 1000)


def ltas(y, f0, cl, rms):
    floor = np.percentile(rms[rms > 0], 10) if np.any(rms > 0) else 0
    voiced = (cl > 0.7) & (rms > 3 * floor)
    frames = [y[i * HOP: i * HOP + FRAME] * np.hanning(FRAME)
              for i in range(len(voiced)) if voiced[i]]
    if not frames:
        return None
    psd = np.zeros(FRAME // 2 + 1)
    for fr in frames:
        psd += np.abs(np.fft.rfft(fr)) ** 2
    psd /= len(frames)
    fx = np.fft.rfftfreq(FRAME, 1 / SR)
    edges = 100 * 2 ** (np.arange(0, 22) / 3.0)   # third-octave, 100 Hz up
    bands = []
    for a, b in zip(edges[:-1], edges[1:]):
        m = (fx >= a) & (fx < b)
        if np.any(m):
            bands.append((round(float(np.sqrt(a * b)), 1),
                          float(10 * np.log10(np.mean(psd[m]) + 1e-20))))
    ref = max(v for _, v in bands)
    return [(f, round(v - ref, 1)) for f, v in bands]


def analyze(path):
    y = decode(path)
    print(f"\n=== {path.split(chr(92))[-1]}  ({len(y)/SR:.1f}s) ===")
    f0, cl, rms = track_pitch(y)
    spans = segment_notes(f0, cl, rms)
    print(f"  {len(spans)} sustained notes found")
    notes = []
    for (a, b) in spans:
        s0, s1 = a * HOP, b * HOP + FRAME
        fmed = float(np.median(f0[a:b][f0[a:b] > 0]))
        center = s0 + int(0.10 * SR) + FRAME // 2
        peaks = harmonic_peaks(y, center, fmed)
        if len(peaks) < 2:
            continue
        B = fit_B(peaks)
        h1 = peaks[0][1] + 1e-12
        ratios = [round(20 * np.log10(p[1] / h1), 1) for p in peaks]
        # decay window may extend past the note into the following silence
        t_end = min(len(y), s1 + int(1.2 * SR))
        t60s = {}
        for hi_ in range(min(3, len(peaks))):
            v = band_t60(y, peaks[hi_][0], s0, t_end)
            if v:
                t60s[f"h{hi_+1}"] = round(v, 2)
        vib = vibrato(f0[a:b])
        atk = attack_ms(y, s0)
        notes.append({
            "t": round(s0 / SR, 2), "dur": round((s1 - s0) / SR, 2),
            "f0": round(fmed, 1),
            "harmonics": [round(p[0], 1) for p in peaks],
            "ratios_db": ratios,
            "B": None if B is None else float(f"{B:.3e}"),
            "t60": t60s, "vib": vib,
            "attack_ms": None if atk is None else round(atk, 1)})
    return {"file": path.split(chr(92))[-1], "notes": notes,
            "ltas": ltas(y, f0, cl, rms)}


def aggregate(files):
    allnotes = [n for f in files for n in f["notes"]]
    def med(vals):
        vals = [v for v in vals if v is not None]
        return round(float(np.median(vals)), 3) if vals else None
    bands = {"low_<300": lambda f: f < 300,
             "mid_300_600": lambda f: 300 <= f < 600,
             "high_>600": lambda f: f >= 600}
    t60_by = {}
    for name, test in bands.items():
        t60_by[name] = med([n["t60"].get("h1") for n in allnotes
                            if test(n["f0"]) and n["t60"]])
    nr = [n["ratios_db"] for n in allnotes if len(n["ratios_db"]) >= 5]
    ratios = [med([r[i] for r in nr if len(r) > i]) for i in range(8)]
    vibs = [n["vib"] for n in allnotes if n["vib"]]
    return {
        "n_notes": len(allnotes),
        "f0_range": [med([min(n["f0"] for n in allnotes)]),
                     med([max(n["f0"] for n in allnotes)])],
        "t60_h1_by_band_s": t60_by,
        "t60_h2_median_s": med([n["t60"].get("h2") for n in allnotes]),
        "t60_h3_median_s": med([n["t60"].get("h3") for n in allnotes]),
        "harmonic_ratios_db_rel_h1": ratios,
        "inharmonicity_B_median": med([n["B"] for n in allnotes
                                       if n["B"] is not None and 0 < n["B"] < 0.01]),
        "vibrato_rate_hz": med([v["rate_hz"] for v in vibs]),
        "vibrato_depth_cents": med([v["depth_cents"] for v in vibs]),
        "attack_ms_median": med([n["attack_ms"] for n in allnotes]),
    }


if __name__ == "__main__":
    results = {"files": [analyze(p) for p in sys.argv[1:]]}
    results["aggregate"] = aggregate(results["files"])
    out = "results.json"
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(results, fh, indent=1, ensure_ascii=False)
    print("\n===== AGGREGATE TUNING TARGETS =====")
    print(json.dumps(results["aggregate"], indent=2))
    print(f"\nFull detail written to {out}")
