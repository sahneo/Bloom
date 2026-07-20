// Low-latency onset processor — runs on the AUDIO thread.
// The rAF path samples the AnalyserNode once per frame (~16 ms late, plus a
// ~23 ms FFT-window centroid); percussive timing that feeds the beat grid
// then arrives up to ~40 ms behind the actual hit. This worklet detects
// kick/snare transients from raw samples at 128-sample granularity (~2.9 ms
// at 48 kHz) with time-domain bandpass filters and posts the freshest
// envelope back, so beat phase locks to where the drums really are.

class OnsetProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sr = sampleRate;
    // 2nd-order bandpass biquads (RBJ) for the kick and snare bands
    this.kick  = this._bp(52, 0.7);
    this.snare = this._bp(4200, 0.8);
    this.kZ = [0, 0]; this.sZ = [0, 0];   // filter state (transposed direct form II)
    // envelope followers per band: fast rectified level vs slow baseline
    this.kFast = 0; this.kSlow = 0;
    this.sFast = 0; this.sSlow = 0;
    this.frame = 0;
  }

  _bp(f0, q) {
    const w0 = 2 * Math.PI * f0 / this.sr;
    const alpha = Math.sin(w0) / (2 * q);
    const b0 = alpha, b1 = 0, b2 = -alpha;
    const a0 = 1 + alpha, a1 = -2 * Math.cos(w0), a2 = 1 - alpha;
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }

  _run(c, z, x) {
    // transposed direct form II: y = b0*x + z0 ; update states
    const y = c.b0 * x + z[0];
    z[0] = c.b1 * x - c.a1 * y + z[1];
    z[1] = c.b2 * x - c.a2 * y;
    return y;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    const n = ch.length;
    // attack/release coefficients (per-sample)
    const aFast = 1 - Math.exp(-1 / (0.002 * this.sr));   // ~2 ms
    const aSlow = 1 - Math.exp(-1 / (0.12  * this.sr));   // ~120 ms baseline
    for (let i = 0; i < n; i++) {
      const x = ch[i];
      const k = Math.abs(this._run(this.kick,  this.kZ, x));
      const s = Math.abs(this._run(this.snare, this.sZ, x));
      this.kFast += (k - this.kFast) * aFast;
      this.kSlow += (k - this.kSlow) * aSlow;
      this.sFast += (s - this.sFast) * aFast;
      this.sSlow += (s - this.sSlow) * aSlow;
    }
    // transient = how far the fast follower jumped above its baseline
    const kT = Math.max(0, this.kFast - this.kSlow * 1.4);
    const sT = Math.max(0, this.sFast - this.sSlow * 1.4);
    // post every block; main thread normalizes with its own running maxima
    this.port.postMessage({ k: kT, s: sT, t: currentTime });
    return true;
  }
}

registerProcessor('onset-processor', OnsetProcessor);
