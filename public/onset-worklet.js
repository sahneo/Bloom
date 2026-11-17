// Low-latency drum onset processor — runs on the AUDIO thread.
//
// v2: kick / snare / hat as separate detectors with spectral-shape gating.
// v1 had one bandpass per drum and a fixed "fast minus 1.4× slow" envelope —
// hats (which carry plenty of 2.5–7 kHz) fired the snare, and offbeat bass
// notes fired the kick (bench: snare precision 31 %, kick precision 70 %).
//
// Per 128-sample block (~2.7 ms) we measure energy in five bands:
//   L  lowpass 100 Hz        kick fundamental (and sub-bass)
//   P  bandpass 330 Hz       bass-note harmonics — kicks barely excite it
//   B  bandpass 200 Hz       snare body
//   M  bandpass 1.8 kHz      snare crack / noise
//   H  highpass 7 kHz        hats, shakers, cymbals
// Each band's onset strength is the dB rise of short-term energy over its own
// recent reference — level-invariant, so quiet and loud masters behave alike.
// Classification:
//   kick  — L rises, and L's energy jump dwarfs P's (a bass note lifts both)
//   snare — M rises, and the jump is broadband (M carries real weight vs H);
//           a hat's noise is tilted to the top octave
//   hat   — H rises without a snare explaining it
// Posts continuous strengths {k, s, h} (0..1) each block plus discrete events.
// A classified hit always lands ≥ 0.55 (visuals threshold around 0.5);
// how far above scales with how hard it rose.

const BANDS = 5;          // L P B M H
const SHORT = [3, 3, 3, 2, 2];          // short-window length in blocks
const REF_TAU = [0.10, 0.10, 0.08, 0.08, 0.06]; // reference EMA (s)
const LAG = 3;            // reference is lagged so the hit itself can't raise it

class OnsetProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sr = sampleRate;
    const s = this.sr;
    this.filt = [
      [this._biq('lp', 100, 0.707), this._biq('lp', 100, 0.707)],
      [this._biq('bp', 330, 1.4)],
      [this._biq('bp', 200, 1.2)],
      [this._biq('bp', 1800, 0.6)],
      [this._biq('hp', 7000, 0.707), this._biq('hp', 7000, 0.707)],
    ];
    this.hist = Array.from({ length: BANDS }, () => new Float64Array(16)); // block energies
    this.ref  = new Float64Array(BANDS).fill(1e-9);
    this.peak = new Float64Array(BANDS).fill(1e-6);   // slow running max for noise gating
    this.prevO = new Float64Array(BANDS);
    this.blk = 0;
    this.blockDt = 128 / s;
    this.lastK = -1; this.lastS = -1; this.lastH = -1;
    this.kEnv = 0; this.sEnv = 0; this.hEnv = 0;
  }

  _biq(type, f0, q) {
    const w0 = 2 * Math.PI * f0 / this.sr, cw = Math.cos(w0), al = Math.sin(w0) / (2 * q);
    let b0, b1, b2;
    if (type === 'lp')      { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; }
    else if (type === 'hp') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; }
    else                    { b0 = al; b1 = 0; b2 = -al; }
    const a0 = 1 + al;
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: -2 * cw / a0, a2: (1 - al) / a0, z0: 0, z1: 0 };
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    const n = ch.length;
    const e = [0, 0, 0, 0, 0];
    for (let b = 0; b < BANDS; b++) {
      const chain = this.filt[b];
      let acc = 0;
      for (let i = 0; i < n; i++) {
        let y = ch[i];
        for (let c = 0; c < chain.length; c++) {
          const f = chain[c];
          const o = f.b0 * y + f.z0;
          f.z0 = f.b1 * y - f.a1 * o + f.z1;
          f.z1 = f.b2 * y - f.a2 * o;
          y = o;
        }
        acc += y * y;
      }
      e[b] = acc / n;
    }

    const pos = this.blk++ & 15;
    const o = [0, 0, 0, 0, 0];      // onset strength, dB over reference
    const S = [0, 0, 0, 0, 0];      // short-term energy
    for (let b = 0; b < BANDS; b++) {
      const h = this.hist[b];
      h[pos] = e[b];
      let s = 0;
      for (let k = 0; k < SHORT[b]; k++) s += h[(pos - k + 16) & 15];
      s /= SHORT[b];
      S[b] = s;
      // reference: EMA of the energy LAG blocks ago
      const lagged = h[(pos - LAG - SHORT[b] + 32) & 15];
      const a = 1 - Math.exp(-this.blockDt / REF_TAU[b]);
      this.ref[b] += (lagged - this.ref[b]) * a;
      this.peak[b] = Math.max(this.peak[b] * 0.99995, s);
      const gate = s > this.peak[b] * 1e-4;     // ignore anything 40 dB under the band's peak
      o[b] = gate ? 10 * Math.log10((s + 1e-12) / (this.ref[b] + 1e-12)) : 0;
    }

    const t = currentTime;
    const ev = [];
    // Any band crossing its threshold opens a ~8 ms judging window; the band
    // rises are max-held across it (H often peaks a block before M, the kick
    // sweep reaches B before L) and the hit is classified when it closes.
    // Measured rise patterns (dB) that the rules below separate:
    //   kick   L 8–31 ≫ B,  M small         snare  B 7–14, M 4–20, L < B
    //   hat    H 7–30, B/P ≤ 0              bass   P/B 3–5, L ~0
    const crossed = (o[0] > 5 && this.prevO[0] <= 5) || (o[3] > 4 && this.prevO[3] <= 4)
                 || (o[2] > 6 && this.prevO[2] <= 6) || (o[4] > 6 && this.prevO[4] <= 6);
    if (crossed && this.win === undefined) { this.win = t; this.mx = o.slice(); }
    if (this.win !== undefined) {
      for (let b = 0; b < BANDS; b++) this.mx[b] = Math.max(this.mx[b], o[b]);
      // close after 12 ms — or up to 20 ms while L is still climbing (the
      // 100 Hz lowpass rises slowest; closing early misfiles the kick as a snare)
      const lClimbing = o[0] > this.prevO[0] + 0.5 && o[0] > 1;
      if (t - this.win >= 0.020 || (t - this.win >= 0.012 && !lClimbing)) {
        const [L, , B, M, H] = this.mx, t0 = this.win;
        let t0k = t0;
        this.win = undefined;
        // second kick form: L diluted by a sustained bassline, but the whole
        // low-mid jumps hard while the top stays quiet relative to the click
        const [, P] = this.mx;
        const isKick  = ((L > 5 && L > B - 4) || (P > 8 && B > 10 && H < M - 3))
                     && t0 - this.lastK > 0.09;
        // second form: crack without much body, sitting on a hat (H loud) — a
        // bare hat lifts M by ~1 dB, a snare under it by 4+
        const isSnare = ((B > 6 && M > 3.5 && L < B - 2) || (M > 4 && L < 3 && B > -2))
                     && !isKick && t0 - this.lastS > 0.09;
        // snare noise reaches the top octave too — only a clearly separate
        // HF burst on top of a snare counts as a hat as well
        const isHat   = H > 6 && t0 - this.lastH > 0.05 && (!isSnare || H > 20);
        // kick under a clap/snare: the snare wins the first window and L
        // only crosses a few blocks later — stamp the kick at the shared hit
        if (isKick && t0 - this.lastS < 0.045 && t0 - this.lastS > 0) t0k = this.lastS;
        if (isKick)  { this.lastK = t0k; const m = Math.min(1, 0.6 + (L - 5) / 40);         ev.push({ type: 'k', t: t0k, mag: m }); this.kEnv = Math.max(this.kEnv, m); }
        if (isSnare) { this.lastS = t0; const m = Math.min(1, 0.6 + Math.max(B, M) / 50); ev.push({ type: 's', t: t0, mag: m }); this.sEnv = Math.max(this.sEnv, m); }
        if (isHat)   { this.lastH = t0; const m = Math.min(1, 0.55 + (H - 6) / 60);         ev.push({ type: 'h', t: t0, mag: m }); this.hEnv = Math.max(this.hEnv, m); }
      }
    }
    for (let b = 0; b < BANDS; b++) this.prevO[b] = o[b];

    // Continuous strengths: event peak-hold with ~40/60/25 ms decay
    const msg = { k: this.kEnv, s: this.sEnv, h: this.hEnv, t, v: 2 };
    if (ev.length) msg.ev = ev;
    this.port.postMessage(msg);
    this.kEnv *= Math.exp(-this.blockDt / 0.04);
    this.sEnv *= Math.exp(-this.blockDt / 0.06);
    this.hEnv *= Math.exp(-this.blockDt / 0.025);
    return true;
  }
}

registerProcessor('onset-processor', OnsetProcessor);
