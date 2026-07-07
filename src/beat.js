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
    this._priorCenter = 115;  // log-gaussian tempo prior (genre presets narrow it)
    this._priorSigma  = 0.6;

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
    this._phX = 0;            // circular mean of onset phases (phase-lock)
    this._phY = 0;
    this._scoreEma     = new Float32Array(MAX_LAG + 1);  // evidence across analyses
    this._lastLoggedBpm = 0;
  }

  get bpm() { return 60 / this.period; }

  // Genre presets center the tempo prior (e.g. DnB ~172, hip-hop ~90).
  // Score memory resets so the old prior's ranking doesn't linger.
  setTempoPrior(center, sigma) {
    this._priorCenter = center;
    this._priorSigma  = sigma;
    this._scoreEma.fill(0);
    this._candVotes = 0;
  }

  // Tap-tempo hint: the user tapped a steady rhythm — treat it as strong
  // evidence. Adopts the tapped tempo directly (folding octaves into a sane
  // 65–185 range), tightens the prior around it so analyses keep re-finding
  // it, and aligns the beat phase to the last tap.
  tapHint(bpm, lastTapTimeS) {
    let b = bpm;
    while (b < 65)  b *= 2;
    while (b > 185) b /= 2;
    this.period = 60 / b;
    this.setTempoPrior(b, 0.18);
    this.conf = Math.max(this.conf, 0.5);
    // Phase: the tap instant is a beat — snap beatT to a whole beat there
    if (lastTapTimeS !== undefined) {
      this.beatT = Math.round(this.beatT);
    }
    console.log(`[beat] tap-tempo hint: ${b.toFixed(1)} BPM`);
  }

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

    // Phase lock: strong KICK/SNARE onsets vote for the grid offset via a
    // circular mean (vector average of onset phases). A proportional pull with
    // a dead zone gets stuck when the grid settles ~half a beat off (measured:
    // phase 0.44 at true kicks, correction weight 0 there) — the circular mean
    // converges from ANY initial offset. Hats are excluded — offbeat hats
    // (house!) would drag phase half a beat.
    const phasePull = dK + dS * 0.8;
    if (phasePull > 0.25 && this.conf > 0.15) {
      const ang = (this.beatT % 1) * 2 * Math.PI;
      const w   = Math.min(phasePull, 1);
      this._phX = this._phX * 0.9 + Math.cos(ang) * w;
      this._phY = this._phY * 0.9 + Math.sin(ang) * w;
      const mag = Math.hypot(this._phX, this._phY);
      if (mag > 0.8) {
        // Mean onset phase relative to the predicted beat, in beats (-0.5..0.5]
        const meanErr = Math.atan2(this._phY, this._phX) / (2 * Math.PI);
        const shift   = meanErr * 0.25 * Math.min(mag / 3, 1);
        this.beatT -= shift;
        // Rotate accumulated votes along with the grid so they don't
        // re-report the offset we just corrected
        const rot = -shift * 2 * Math.PI;
        const nx  = this._phX * Math.cos(rot) - this._phY * Math.sin(rot);
        const ny  = this._phX * Math.sin(rot) + this._phY * Math.cos(rot);
        this._phX = nx;
        this._phY = ny;
      }
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
    const curLag = this.period * ENV_HZ;
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
      const dev = Math.log2(bpm / this._priorCenter) / this._priorSigma;
      sc *= Math.exp(-0.5 * dev * dev);
      // Continuity bonus: once locked, competing metrical levels (3:2, 4:3,
      // 2:1 impostors) often score within a few % of the winner and trade
      // places between windows — real tracks measured 97↔140 BPM flapping.
      // Reward staying near the current tempo, in proportion to confidence.
      const relDev = Math.abs(lag - curLag) / curLag;
      if (relDev < 0.06) sc *= 1 + 0.30 * this.conf;
      this._scoreEma[lag] = this._scoreEma[lag] * 0.75 + sc * 0.25;
      if (this._scoreEma[lag] > bestScore) { bestScore = this._scoreEma[lag]; bestLag = lag; }
    }
    if (bestLag === 0) return;

    // Downbeat: rotate bar so the strongest-kick slot becomes "1".
    // Hysteresis: re-electing the downbeat every analysis made the bar dots
    // hop around — a challenger slot must now beat the rest by 30% three
    // analyses in a row before the bar rotates.
    let maxSlot = 0;
    for (let i = 1; i < 4; i++) {
      if (this._slotEnergy[i] > this._slotEnergy[maxSlot]) maxSlot = i;
    }
    let second = 0;
    for (let i = 0; i < 4; i++) {
      if (i !== maxSlot) second = Math.max(second, this._slotEnergy[i]);
    }
    if (maxSlot !== this._barOffset && this._slotEnergy[maxSlot] > second * 1.3) {
      if (maxSlot === this._barCand) this._barVotes = (this._barVotes ?? 0) + 1;
      else { this._barCand = maxSlot; this._barVotes = 1; }
      if (this._barVotes >= 3) {
        this._barOffset = maxSlot;
        this._barVotes  = 0;
      }
    } else {
      this._barVotes = 0;
    }
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
    // must keep winning analyses before being adopted. Metrically-related
    // candidates (2:1, 3:2, 4:3 — the DnB/half-time impostors) need far more
    // evidence than an unrelated tempo (a real change, e.g. a DJ transition):
    // flipping metrical level mid-track looks broken, while locking onto a
    // genuinely new tempo a few seconds late is invisible.
    const rel = Math.abs(newPeriod - this.period) / this.period;
    if (rel < 0.05) {
      this.period = this.period * 0.65 + newPeriod * 0.35;
      this._candVotes = 0;
      this.conf += (targetConf - this.conf) * 0.5;
    } else if (this.conf < 0.3) {
      // Not meaningfully locked yet (startup, or after long instability) —
      // adopt the winning candidate fast; strictness here only delays first
      // lock. EXCEPT metrical relatives of the current tempo: a breakdown
      // saps confidence, and without this guard the 3:2 impostor walked in
      // through the fast path during quiet sections (108 → 162 mid-track).
      const ratio = Math.max(newPeriod, this.period) / Math.min(newPeriod, this.period);
      const metrical = [2, 3, 4, 1.5, 4 / 3].some(r => Math.abs(ratio - r) / r < 0.06);
      const relCand = this._candPeriod > 0
        ? Math.abs(newPeriod - this._candPeriod) / this._candPeriod : 1;
      if (relCand < 0.05) this._candVotes++;
      else { this._candPeriod = newPeriod; this._candVotes = 1; }
      // conf ≈ 0 means nothing was ever locked (startup) — the "current"
      // period is just the 120 BPM default, not evidence worth defending
      if (this._candVotes >= (metrical && this.conf > 0.05 ? 5 : 2)) {
        this.period = this._candPeriod;
        this._candVotes = 0;
      }
    } else {
      const ratio = Math.max(newPeriod, this.period) / Math.min(newPeriod, this.period);
      let metrical = [2, 3, 4, 1.5, 4 / 3].some(r => Math.abs(ratio - r) / r < 0.06);

      // Octave-escape exception: a half-tempo lock (the most common octave
      // error) below 100 BPM being challenged by its double is very likely a
      // correction, not a flip — let it through on the fast track. The full
      // metrical guard would defend the wrong octave for 16 s or forever.
      const doubling = Math.abs(ratio - 2) < 0.12 && newPeriod < this.period;
      if (doubling && this.bpm < 100) metrical = false;

      // A challenger only counts if it clearly out-scores the incumbent tempo —
      // near-ties are exactly the flapping we're suppressing
      const curLagInt = Math.round(this.period * ENV_HZ);
      const curScore  = (curLagInt >= MIN_LAG && curLagInt <= MAX_LAG)
        ? this._scoreEma[curLagInt] : 0;
      const margin = curScore > 1e-6 ? bestScore / curScore : 2;
      const clearWin = margin > (metrical ? 1.15 : 1.05);

      const relCand = this._candPeriod > 0
        ? Math.abs(newPeriod - this._candPeriod) / this._candPeriod : 1;
      if (relCand < 0.05 && clearWin) this._candVotes++;
      else if (relCand < 0.05)        this._candVotes = Math.max(0, this._candVotes - 1);
      else { this._candPeriod = newPeriod; this._candVotes = clearWin ? 1 : 0; }

      const votesNeeded = metrical ? 8 : 3;   // 16 s vs 6 s of consistent evidence
      if (this._candVotes >= votesNeeded) {
        this.period = this._candPeriod;
        this._candVotes = 0;
        this.conf = Math.min(this.conf, 0.45);        // re-earn confidence
      } else {
        this.conf = Math.max(0, this.conf - 0.05);    // unstable → drift down
      }
    }

    const bpmNow = Math.round(this.bpm);
    if (this.conf > 0.35 && Math.abs(bpmNow - this._lastLoggedBpm) >= 2) {
      this._lastLoggedBpm = bpmNow;
      console.log(`[beat] ~${bpmNow} BPM (conf ${this.conf.toFixed(2)})`);
    }
  }
}
