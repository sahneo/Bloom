// ---------------------------------------------------------------------------
// PitchTracker — bass note, melody note and a cleaner chromagram from the
// 8192-point analyser the chroma path already owns (no extra audio nodes).
//
//   bass    YIN on the time-domain window, lowpassed and decimated ×8 to
//           6 kHz (28–300 Hz → lags 20–214). YIN is a period detector, so
//           the fundamental wins even when the 2nd/3rd harmonic is louder
//           (the FFT-argmax approach reported harmonics and kick thumps).
//           Kick hits are periodic for ~100 ms too — the note is held
//           through them instead of re-detected.
//   melody  harmonic-sum salience over MIDI 55–96 on the linear magnitude
//           spectrum, top-line preference (the highest pitch whose salience
//           is close to the strongest — melodies sit above pads).
//   chroma  log-frequency chroma from the linear spectrum with a running
//           per-bin median over 5 frames (HPSS-lite: drums are vertical
//           lines in the spectrogram, a median along time removes them),
//           bass register included at reduced weight.
//
// All per-frame, main thread: ~0.3 ms on a laptop (bench reports it).
// ---------------------------------------------------------------------------

const DEC = 8;              // decimation for the bass path
const BASS_MIN_HZ = 28, BASS_MAX_HZ = 230;   // A#0 … A#3
const BASS_WIN = 4096;      // newest samples used (85 ms @ 48 kHz) — short notes fill it
const MEL_LO = 55, MEL_HI = 96;   // MIDI range for melody
const MED_N = 5;            // temporal median length (frames) for chroma

const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);
const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

function biquadLP(sr, f0, q = 0.707) {
  const w0 = 2 * Math.PI * f0 / sr, cw = Math.cos(w0), al = Math.sin(w0) / (2 * q), a0 = 1 + al;
  return { b0: (1 - cw) / 2 / a0, b1: (1 - cw) / a0, b2: (1 - cw) / 2 / a0, a1: -2 * cw / a0, a2: (1 - al) / a0 };
}

export class PitchTracker {
  constructor(sampleRate, fftSize = 8192) {
    this.sr = sampleRate;
    this.fftSize = fftSize;
    this.binHz = sampleRate / fftSize;
    this.time = new Float32Array(fftSize);
    this.db   = new Float32Array(fftSize / 2);
    this.mag  = new Float32Array(fftSize / 2);
    this._lp = [biquadLP(sampleRate, 220), biquadLP(sampleRate, 220)];
    this._bassPeak = 1e-4;   // running max of the bass-band level (relative gate)
    this._dec = new Float32Array(Math.floor(Math.min(BASS_WIN, fftSize) / DEC));
    this._minLag = Math.floor(sampleRate / DEC / BASS_MAX_HZ);
    this._maxLag = Math.ceil(sampleRate / DEC / BASS_MIN_HZ);
    this._d = new Float32Array(this._maxLag + 2);

    // outputs
    this.bassNote = -1;  this.bassPitch = 0; this.bassConf = 0;
    this.melNote  = -1;  this.melPitch  = 0; this.melConf  = 0;
    this.chroma   = new Float32Array(12);

    this._bassCand = -1; this._bassCandN = 0; this._bassMiss = 0;
    this._melCand  = -1; this._melCandN  = 0; this._melMiss  = 0;

    // chroma bin map: each FFT bin 55 Hz–5 kHz → pitch class + weight
    const lo = Math.ceil(55 / this.binHz), hi = Math.floor(5000 / this.binHz);
    this._cLo = lo; this._cHi = hi;
    this._cPc = new Int8Array(hi + 1); this._cW = new Float32Array(hi + 1);
    for (let k = lo; k <= hi; k++) {
      const m = hzToMidi(k * this.binHz);
      const near = Math.round(m), dev = Math.abs(m - near);
      this._cPc[k] = ((near % 12) + 12) % 12;
      // bins between semitones count little; bass register at half weight
      // (it is mostly root notes — good for key, but it shouldn't dominate)
      this._cW[k] = Math.max(0, 1 - dev * 2.5) * (m < 48 ? 0.5 : 1);
    }
    this._medRing = Array.from({ length: MED_N }, () => new Float32Array(hi + 1));
    this._medPos = 0;
    this._medTmp = new Float32Array(MED_N);
  }

  // analyser: AnalyserNode with fftSize === this.fftSize. kick: 0..1 envelope.
  update(analyser, kick = 0) {
    analyser.getFloatTimeDomainData(this.time);
    analyser.getFloatFrequencyData(this.db);
    for (let i = 0; i < this.mag.length; i++) {
      const d = this.db[i];
      this.mag[i] = d > -140 ? Math.pow(10, d / 20) : 0;
    }
    this._bass(kick);
    this._melody();
    this._chroma(kick);
  }

  // ── bass: YIN ─────────────────────────────────────────────────────────
  _bass(kick) {
    // lowpass (two biquads, run fresh over the window) + decimate
    const x = this.time, n = x.length, start = n - this._dec.length * DEC;
    let z = [0, 0, 0, 0];
    let peak = 0;
    for (let i = start, j = 0; i < n; i++) {
      let y = x[i];
      for (let s = 0; s < 2; s++) {
        const c = this._lp[s];
        const o = c.b0 * y + z[s * 2];
        z[s * 2]     = c.b1 * y - c.a1 * o + z[s * 2 + 1];
        z[s * 2 + 1] = c.b2 * y - c.a2 * o;
        y = o;
      }
      if ((i - start) % DEC === DEC - 1) { this._dec[j++] = y; peak = Math.max(peak, Math.abs(y)); }
    }
    const d = this._d, buf = this._dec;
    const W = buf.length - this._maxLag - 1;
    let pitch = 0, conf = 0;
    // relative gate: the bass band must be within ~16 dB of its recent peak
    // (pads leaking through the lowpass otherwise yield sub-harmonic "notes")
    this._bassPeak = Math.max(this._bassPeak * 0.998, peak);
    if (peak > 0.005 && peak > this._bassPeak * 0.16) {
      // difference function + cumulative mean normalisation
      d[0] = 1;
      let run = 0;
      for (let tau = 1; tau <= this._maxLag; tau++) {
        let s = 0;
        for (let i = 0; i < W; i++) { const v = buf[i] - buf[i + tau]; s += v * v; }
        run += s;
        d[tau] = run > 0 ? s * tau / run : 1;
      }
      // global minimum, then prefer a sub-multiple lag (octave / twelfth
      // above) whose dip is nearly as deep — a lag of 2T fits a periodic
      // signal as well as T, and the window-edge bias can make it win
      let tau = -1, dmin = 1e9;
      for (let t = this._minLag; t <= this._maxLag; t++) if (d[t] < dmin) { dmin = d[t]; tau = t; }
      if (dmin > 0.35) tau = -1;
      if (tau > 0) {
        for (const k of [4, 3, 2]) {
          const tk = Math.round(tau / k);
          if (tk < this._minLag) continue;
          let lm = tk;
          for (let t = Math.max(this._minLag, tk - 2); t <= Math.min(this._maxLag, tk + 2); t++) if (d[t] < d[lm]) lm = t;
          if (d[lm] < dmin + 0.12) { tau = lm; break; }
        }
      }
      if (tau > 0) {
        const a = d[tau - 1], b = d[tau], c = d[tau + 1] ?? b;
        const den = a - 2 * b + c;
        const sh = den !== 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0;
        pitch = hzToMidi(this.sr / DEC / (tau + sh));
        conf = 1 - b;
      }
    }
    // Harmonic-sum check on the 8192 spectrum. A kick (and its tail) is a
    // lone partial at 40–60 Hz; a bass note is a harmonic series. YIN alone
    // reads the kick+bass MIXTURE's common period (an octave below the note).
    // Salience over C1…A#3 with the fundamental under-weighted decides the
    // pitch class/octave; YIN only confirms "something periodic is there".
    const sal = this._bassSalience();
    if (sal.note > 0 && conf > 0.5 && sal.strength > 0.25) {
      pitch = sal.note; conf = Math.max(conf, sal.strength);
    } else conf = 0;
    // Kick hits: hold the current note through the attack
    if (kick > 0.45 && this.bassNote >= 0) { this.bassConf = conf; return; }
    this._commit('bass', pitch, conf, 0.6, 2);
  }

  // Harmonic PRODUCT over the first 4 partials (geometric mean): a
  // candidate an octave below the note collects the note's partials as its
  // even harmonics but has nothing at its 3rd — the product punishes that
  // gap where a weighted sum rewarded it. A kick tail is a lone partial, so
  // no candidate gets a full series from it. Floor ε keeps a pure-sine sub
  // bass (fundamental only) detectable, just with lower strength.
  _bassSalience() {
    const mag = this.mag, bh = this.binHz;
    const peakAt = (f) => {
      const k = f / bh, span = Math.max(1, Math.round(k * 0.017));   // ±0.3 semitone
      let p = 0;
      for (let i = Math.max(1, Math.round(k) - span); i <= Math.round(k) + span; i++) p = Math.max(p, mag[i]);
      return p;
    };
    let mx = 1e-9;
    for (let i = Math.floor(30 / bh); i <= Math.ceil(950 / bh); i++) mx = Math.max(mx, mag[i]);
    const eps = mx * 0.03;
    let best = -1, bestS = 0, total = 0, cnt = 0;
    // D1 … E3: above that a pad's lowest voice would read as "bass"
    for (let m = 26; m <= 52; m++) {
      const f = midiToHz(m);
      let lp = 0;
      // low notes need more partials: a semitone at 41 Hz is under one FFT bin
      const H = f < 70 ? 6 : 4;
      for (let h = 1; h <= H; h++) lp += Math.log(peakAt(f * h) + eps);
      const sc = Math.exp(lp / H);
      total += sc; cnt++;
      if (sc > bestS) { bestS = sc; best = m; }
    }
    const strength = cnt ? Math.min(1, (bestS / (total / cnt) - 1) / 2) : 0;
    return { note: best, strength };
  }

  // ── melody: harmonic-sum salience, top-line ───────────────────────────
  _melody() {
    const mag = this.mag, bh = this.binHz, N = mag.length;
    const sal = new Float32Array(MEL_HI - MEL_LO + 1);
    let maxS = 0;
    for (let m = MEL_LO; m <= MEL_HI; m++) {
      const f = midiToHz(m);
      let s = 0;
      for (let h = 1; h <= 6; h++) {
        const k = f * h / bh;
        if (k >= N - 2) break;
        // peak within ±0.4 semitone of the harmonic
        const span = Math.max(1, Math.round(k * 0.023));
        let p = 0;
        for (let i = Math.max(1, Math.round(k) - span); i <= Math.round(k) + span; i++) p = Math.max(p, mag[i]);
        s += p * Math.pow(0.8, h - 1);
      }
      // subharmonic guard: if the octave below explains this peak as its
      // 2nd harmonic, salience moves there (handled by top-line + check below)
      sal[m - MEL_LO] = s;
      maxS = Math.max(maxS, s);
    }
    let pick = -1;
    if (maxS > 1e-4) {
      // local maxima above 0.7 × max; prefer the highest unless it is just a
      // harmonic (octave/12th) of a stronger lower candidate
      const peaks = [];
      for (let i = 0; i < sal.length; i++) {
        const l = i > 0 ? sal[i - 1] : 0, r = i < sal.length - 1 ? sal[i + 1] : 0;
        if (sal[i] >= l && sal[i] >= r && sal[i] > 0.7 * maxS) peaks.push(i);
      }
      for (let p = peaks.length - 1; p >= 0; p--) {
        const i = peaks[p];
        const harmOf = peaks.some(j => j < i && [12, 19, 24].includes(i - j) && sal[j] > sal[i] * 0.9);
        if (!harmOf) { pick = i + MEL_LO; break; }
      }
    }
    const conf = maxS > 1e-4 ? Math.min(1, maxS * 40) : 0;
    this._commit('mel', pick > 0 ? pick : 0, pick > 0 ? conf : 0, 0.15, 2);
  }

  // Stable output: a new note must win `need` frames running; brief dropouts
  // (≤ 3 frames) keep the last note
  _commit(which, pitch, conf, minConf, need) {
    const note = conf >= minConf && pitch > 0 ? Math.round(pitch) : -1;
    const cand = which === 'bass' ? '_bassCand' : '_melCand';
    const candN = cand + 'N', miss = which === 'bass' ? '_bassMiss' : '_melMiss';
    const outN = which === 'bass' ? 'bassNote' : 'melNote';
    if (note < 0) {
      if (++this[miss] > 3) this[outN] = -1;
    } else {
      this[miss] = 0;
      if (note === this[outN]) this[candN] = 0;
      else if (note === this[cand]) { if (++this[candN] >= need) { this[outN] = note; this[candN] = 0; } }
      else { this[cand] = note; this[candN] = 1; }
      if (this[outN] < 0 && need <= 1) this[outN] = note;
    }
    if (which === 'bass') { this.bassPitch = pitch; this.bassConf = conf; }
    else { this.melPitch = pitch; this.melConf = conf; }
  }

  // ── chroma: log-frequency, median-filtered over time ──────────────────
  _chroma(kick) {
    const ring = this._medRing[this._medPos];
    this._medPos = (this._medPos + 1) % MED_N;
    for (let k = this._cLo; k <= this._cHi; k++) ring[k] = this.mag[k];
    const c = new Float32Array(12), tmp = this._medTmp;
    for (let k = this._cLo; k <= this._cHi; k++) {
      const w = this._cW[k];
      if (w <= 0) continue;
      for (let r = 0; r < MED_N; r++) tmp[r] = this._medRing[r][k];
      // median of 5 via partial sort
      for (let a = 0; a < 3; a++) for (let b = a + 1; b < MED_N; b++) if (tmp[b] < tmp[a]) { const t = tmp[a]; tmp[a] = tmp[b]; tmp[b] = t; }
      c[this._cPc[k]] += tmp[2] * w;
    }
    let mx = 1e-9;
    for (let i = 0; i < 12; i++) mx = Math.max(mx, c[i]);
    for (let i = 0; i < 12; i++) this.chroma[i] = c[i] / mx;
    this.chromaEnergy = mx;
  }
}
