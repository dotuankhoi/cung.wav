# cung.wav

Mô hình vật lý đàn bầu và đàn tranh — physical models of Vietnamese traditional
instruments, synthesized in real time with digital waveguides.

Everything lives in a single file: open `index.html` in Chrome or Edge and click
to begin. No dependencies, no build step.

## Instruments

- **Đàn bầu** — one string, harmonic-node touch (keys 1–7), flexible pitch rod
  (mouse Y), rung/nhấn/vỗ gestures (Space / Shift / V), magnetic pickup model.
- **Đàn tranh** — 16/17/19/21 strings (keys Z…/ and A…'), continuous microtonal
  press bends behind the bridges (drag down on a string), sympathetic resonance
  through a shared bridge bus.

## Engine

All DSP runs in an AudioWorklet: bidirectional waveguides with a movable
finger/scattering junction, Hermite fractional delays, dispersion allpasses,
frequency-dependent bridge impedance normalized at f₀, modal body resonators,
and physically derived per-string inharmonicity. The canvas renders
finite-difference strings with real traveling waves.
