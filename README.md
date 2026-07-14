# cung.wav

Mô hình vật lý đàn bầu và đàn tranh — physical models of Vietnamese traditional
instruments, synthesized in real time with digital waveguides.

## Run it

Double-click **START.bat** — it launches a local server and opens the app in
your browser. Then click the start screen and play.
(AudioWorklets require `http://`, so opening index.html directly won't work.)

## Files

| file | what it is |
|---|---|
| `START.bat` | double-click launcher (server + browser) |
| `index.html` | page markup |
| `style.css` | UI styling |
| `app.js` | main thread: input, gestures, canvas string physics, rendering |
| `dsp-worklet.js` | the audio engine (all DSP, runs in an AudioWorklet) |
| `analysis/analyze.py` | DSP analyzer that measures real đàn bầu recordings |
| `analysis/results.json` | measurements from 398 notes of three solo recordings |

## Instruments

- **Đàn bầu** — keys 1–7 pluck at harmonic nodes (harmonics 2–8), mouse Y bends
  the pitch rod, Space = rung, Shift = nhấn, V = vỗ.
- **Đàn tranh** — keys Z…/ then A…' pluck 16/17/19/21 strings, drag down on a
  string for microtonal press bends, scroll = pluck position, Shift = hard pick.

## Measurement-driven voicing

The đàn bầu is calibrated against DSP analysis of solo recordings by
Vân-Ánh Vanessa Võ and Thanh Tùng (`analysis/`): harmonic balance per pitch
band (low notes overtone-dominant, mids H1≈H2 with a steep cliff above H3,
highs nearly pure), T60 ≈ 5.5 s at the sounding pitch, rung 5.5 Hz ± 28 cents,
negligible string inharmonicity, a ~300 Hz–1.3 kHz pickup/amp passband with a
~42 dB/oct cliff (8th-order), and a light 1.6 s room reverb.
