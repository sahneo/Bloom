// BeatTracker — tempo + beat phase from the onset-strength envelope.
//
// v2: autocorrelation instead of inter-onset histograms. Discrete IOIs fall
// apart on syncopated / broken-kick rhythms (intervals between neighbouring
// kicks are not the beat period). Autocorrelating a 100 Hz onset-strength
// signal (kick + snare derivatives) accumulates ALL periodicity evidence at
// once, so off-grid hits only dilute the peak instead of voting for a wrong
// tempo. Tempo changes need 3 consecutive agreeing analyses (hysteresis) —
// the estimate stays put through fills and breakdowns.
//
// Outputs:
//   beatT — beats elapsed, monotonic float (fract = phase within the beat)
//   conf  — 0..1 periodicity confidence; gate beat-synced effects on it
//   bpm   — current tempo estimate

const ENV_HZ    = 100;        // onset envelope sample rate
const ENV_LEN   = 1024;       // ring buffer ≈ 10.2 s
const MIN_LAG   = 33;         // 1.0 s ... 0.33 s → 60–180 BPM candidates
const MAX_LAG   = 100;
const ACF_LAG   = 400;        // up to 4× the slowest candidate (comb harmonics)
const ANALYZE_S = 2;
const OFF_COMB  = 0.15;       // mild off-beat subtraction; 0.7 favored 3:2 impostors on 8th-hats

export class BeatTracker {
  constructor() {
    this.period = 0.5;        // s/beat (120 BPM default)
    this.conf   = 0;
    this.beatT  = 0;

    this._env     = new Float32Array(ENV_LEN);
    this._envPos  = 0;
    this._envAcc  = 0;
    this._envFrac = 0;
    this._prevK   = 0;
    this._prevS   = 0;
    this._prevH   = 0;
    this._slotEnergy = new Float32Array(4);   // downbeat voting
    this._barOffset  = 0;
    this._lastAnalysis = 0;
    this._candPeriod   = 0;   // tempo-change hypothesis
    this._candVotes    = 0;
    this._scoreEma     = new Float32Array(MAX_LAG + 1);  // evidence across analyses
    this._lastLoggedBpm = 0;
  }

  get bpm() { return 60 / this.period; }

  // Bar position 0..4 with the detected downbeat at 0
  barPos() {
    return ((this.beatT - this._barOffset) % 4 + 4) % 4;
  }

  // Call every frame with raw kick/snare/high envelopes (0..1), dt in seconds.
  update(timeS, kick, snare, high, dt) {
    // Onset strength = positive derivatives (transients, not sustained level).
    // High band (hats) is essential: with a half-time kick the quarter-note
    // grid lives ONLY in the hats — kick+snare alone honestly report half tempo.
    const dK = Math.max(0, kick - this._prevK);
    const dS = Math.max(0, snare - this._prevS);
    const dH = Math.max(0, high - this._prevH);
    this._prevK = kick;
    this._prevS = snare;
    this._prevH = high;
    const strength = dK + dS * 0.8 + dH * 0.9;

    // Downbeat voting: kick energy per beat slot within a 4-beat bar
    if (dK > 0.15 && this.conf > 0.2) {
      const slot = Math.floor(this.beatT % 4);
      this._slotEnergy[slot] += dK;
    }

    // Resample into the 100 Hz ring (max within each 10 ms slot)
    this._envAcc = Math.max(this._envAcc, strength);
    this._envFrac += dt;
    while (this._envFrac >= 1 / ENV_HZ) {
      this._envFrac -= 1 / ENV_HZ;
      this._env[this._envPos % ENV_LEN] = this._envAcc;
      this._envPos++;
      this._envAcc = 0;
    }

    // PLL: strong KICK/SNARE onsets pull predicted phase toward themselves;
    // hats are excluded — offbeat hats (house!) would drag phase half a beat.
    // Hits far from the predicted beat (likely syncopation) pull weakly.
    const phasePull = dK + dS * 0.8;
    if (phasePull > 0.25 && this.conf > 0.15) {
      const phase = this.beatT % 1;
      const err = phase < 0.5 ? phase : phase - 1;
      const w = Math.max(0, 1 - Math.abs(err) * 2.5);
      this.beatT -= err * 0.35 * w;
    }

    if (timeS - this._lastAnalysis > ANALYZE_S) {
      this._lastAnalysis = timeS;
      this._analyze();
    }

    if (this.conf > 0.05) this.beatT += dt / this.period;
  }

  _analyze() {
    const N = Math.min(this._envPos, ENV_LEN);
    if (N < 4 * ENV_HZ) return;                       // need ≥ 4 s of signal

    // Linearize window, remove mean
    const x = new Float32Array(N);
    let mean = 0;
    for (let i = 0; i < N; i++) {
      x[i] = this._env[(this._envPos - N + i) % ENV_LEN];
      mean += x[i];
    }
    mean /= N;
    if (mean < 1e-4) {                                // silence
      this.conf = Math.max(0, this.conf - 0.3);
      return;
    }

    // Normalized autocorrelation
    const maxLag = Math.min(ACF_LAG, N - 1);
    const ac = new Float32Array(maxLag + 1);
    let ac0 = 1e-9;
    for (let i = 0; i < N; i++) { const v = x[i] - mean; ac0 += v * v; }
    const lagLo = Math.floor(MIN_LAG / 2) - 1;            // off-comb needs 0.5×lag
    for (let lag = lagLo; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = lag; i < N; i++) s += (x[i] - mean) * (x[i - lag] - mean);
      ac[lag] = s / ac0;
    }

    // Comb-filter tempo salience: the true beat lag correlates at ALL integer
    // multiples (on-comb) and dips at half-integer multiples (off-comb).
    // A half-tempo impostor gets its on-comb hits subtracted right back by
    // the off-comb (the true beats land at its 0.5×/1.5×), and 8th-note hats
    // inflate both combs equally — this is what point-fixes (1.5× penalty,
    // half-lag fallback) kept getting wrong for one rhythm or another.
    // Log-gaussian tempo prior ~115 BPM resolves remaining octave ties.
    // Scores are EMA-smoothed across analyses so one noisy window can't
    // flip the winner (mid-track BPM wandering).
    let bestLag = 0, bestScore = -1;
    for (let lag = MIN_LAG; lag <= MAX_LAG; lag++) {
      let on = 0, off = 0, wOn = 0, wOff = 0;
      for (let k = 1; k <= 4; k++) {
        const w = 1 / k;
        const li = k * lag;
        if (li <= maxLag) { on += w * ac[li]; wOn += w; }
        const lo = Math.round((k - 0.5) * lag);
        if (lo <= maxLag) { off += w * ac[lo]; wOff += w; }
      }
      let sc = on / wOn - OFF_COMB * (wOff ? off / wOff : 0);
      const bpm = 60 * ENV_HZ / lag;
      const dev = Math.log2(bpm / 115) / 0.6;
      sc *= Math.exp(-0.5 * dev * dev);
      this._scoreEma[lag] = this._scoreEma[lag] * 0.65 + sc * 0.35;
      if (this._scoreEma[lag] > bestScore) { bestScore = this._scoreEma[lag]; bestLag = lag; }
    }
    if (bestLag === 0) return;

    // Downbeat: rotate bar so the strongest-kick slot becomes "1"
    let maxSlot = 0;
    for (let i = 1; i < 4; i++) {
      if (this._slotEnergy[i] > this._slotEnergy[maxSlot]) maxSlot = i;
    }
    this._barOffset = maxSlot;
    for (let i = 0; i < 4; i++) this._slotEnergy[i] *= 0.6;   // slow forget

    // Parabolic interpolation around the peak → sub-bin (~ms) precision
    const y1 = ac[bestLag - 1], y2 = ac[bestLag], y3 = ac[bestLag + 1];
    const den = y1 - 2 * y2 + y3;
    let shift = den !== 0 ? 0.5 * (y1 - y3) / den : 0;
    shift = Math.max(-0.5, Math.min(0.5, shift));
    const newPeriod = (bestLag + shift) / ENV_HZ;

    // Confidence from peak prominence over the candidate range
    let avg = 0;
    for (let lag = MIN_LAG; lag <= MAX_LAG; lag++) avg += Math.max(0, ac[lag]);
    avg /= MAX_LAG - MIN_LAG + 1;
    const prominence = Math.max(0, ac[bestLag] - avg);
    const targetConf = Math.min(1, prominence * 5 + Math.max(0, ac[bestLag]) * 0.8);

    // Tempo hysteresis: small deviations track smoothly; a different tempo
    // must win 3 analyses in a row before being adopted
    const rel = Math.abs(newPeriod - this.period) / this.period;
    if (rel < 0.05) {
      this.period = this.period * 0.65 + newPeriod * 0.35;
      this._candVotes = 0;
      this.conf += (targetConf - this.conf) * 0.5;
    } else {
      const relCand = this._candPeriod > 0
        ? Math.abs(newPeriod - this._candPeriod) / this._candPeriod : 1;
      if (relCand < 0.05) this._candVotes++;
      else { this._candPeriod = newPeriod; this._candVotes = 1; }
      if (this._candVotes >= 3) {
        this.period = this._candPeriod;
        this._candVotes = 0;
        this.conf = Math.min(this.conf, 0.45);        // re-earn confidence
      } else {
        this.conf = Math.max(0, this.conf - 0.1);     // unstable → drift down
      }
    }

    const bpmNow = Math.round(this.bpm);
    if (this.conf > 0.35 && Math.abs(bpmNow - this._lastLoggedBpm) >= 2) {
      this._lastLoggedBpm = bpmNow;
      console.log(`[beat] ~${bpmNow} BPM (conf ${this.conf.toFixed(2)})`);
    }
  }
}
