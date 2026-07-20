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
const FFT_LAT   = 0.035;      // frame-path onsets lag the true hit ~35 ms (FFT window centroid + frame)

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
    this._slotEnergy = new Float32Array(4);   // downbeat voting: kick accents
    this._slotSnare  = new Float32Array(4);   // backbeat voting: snares live on 2 & 4
    this._slotFlux   = new Float32Array(4);   // novelty voting: arrangements change on "1"
    this._barOffset  = 0;
    this._lastAnalysis = 0;
    this._candPeriod   = 0;   // tempo-change hypothesis
    this._candVotes    = 0;
    this._phX = 0;            // circular mean of onset phases (phase-lock)
    this._phY = 0;
    this._scoreEma     = new Float32Array(MAX_LAG + 1);  // evidence across analyses
    this._lastLoggedBpm = 0;
    this._shiftEma      = 0;  // 2nd-order PLL: one-sided phase corrections = period bias
    this._acfPeriod     = 0;  // latest ACF opinion — anchors how far the PLL may trim
    this._nowS          = 0;
    this._lastPreciseAt = -10; // when the last worklet onset event arrived
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

  // Precise onset from the AudioWorklet path: the hit happened agoS seconds
  // before now (already corrected for output latency by the caller). Votes
  // phase at the HIT time — frame-time votes are a frame + FFT window late,
  // which is exactly the on-screen misalignment at higher tempos.
  onsetEvent(agoS, kickMag, snareMag) {
    this._lastPreciseAt = this._nowS;
    const w = Math.min(kickMag + snareMag * 0.8, 1);
    // Sharpen the ACF input too: deposit the hit into the envelope ring at
    // its true position (the frame path smears it into a later 10 ms bin).
    // Triangular 3-bin kernel, not a single bin — single-bin spikes make the
    // ACF peaks so narrow that integer-lag comb sampling misses them when the
    // true period isn't bin-aligned (measured: 174 BPM collapsed to half-tempo).
    const binsAgo = Math.min(Math.round(agoS * ENV_HZ), ENV_LEN - 1);
    if (this._envPos > binsAgo + 1) {
      for (let o = -1; o <= 1; o++) {
        const idx = (((this._envPos - 1 - binsAgo + o) % ENV_LEN) + ENV_LEN) % ENV_LEN;
        const dep = w * (o === 0 ? 1 : 0.5);
        this._env[idx] = Math.max(this._env[idx], dep);
      }
    }
    if (w < 0.25 || this.conf <= 0.15) return;
    const ph = (((this.beatT - agoS / this.period) % 1) + 1) % 1;
    this._votePhase(ph, w, 0.45);
  }

  // Shared phase-vote: circular mean + correction pull + 2nd-order PLL.
  // ph in beats [0..1), w = vote weight, pull = correction gain per vote.
  _votePhase(ph, w, pull) {
    const ang = ph * 2 * Math.PI;
    this._phX = this._phX * 0.9 + Math.cos(ang) * w;
    this._phY = this._phY * 0.9 + Math.sin(ang) * w;
    const mag = Math.hypot(this._phX, this._phY);
    if (mag <= 0.8) return;
    // Mean onset phase relative to the predicted beat, in beats (-0.5..0.5]
    const meanErr = Math.atan2(this._phY, this._phX) / (2 * Math.PI);
    const shift   = meanErr * pull * Math.min(mag / 3, 1);
    this.beatT -= shift;
    // 2nd-order PLL: phase corrections that stay one-sided mean the PERIOD
    // is biased (ACF bins are 10 ms — up to ~1% tempo error survives the
    // parabolic fit), and a 1st-order pull then chases a drift it can never
    // finish. Trim the period a little in the drift's direction; the ACF
    // estimate stays the anchor (trim confined to ±5% of it, and skipped
    // entirely if ACF currently disagrees with the running period — that's
    // a metrical-impostor window, not a calibration signal).
    // Gain sits just under critical damping (k2 ≈ k1²/4 per vote) — at 0.35
    // the loop rang ±3 BPM around the true tempo with a ~12 s period.
    this._shiftEma = this._shiftEma * 0.85 + shift * 0.15;
    if (this.conf > 0.3 && this._acfPeriod > 0
        && Math.abs(this._acfPeriod - this.period) / this.period < 0.1) {
      const trim = Math.max(-0.0015, Math.min(0.0015, this._shiftEma * 0.10));
      this.period = Math.max(this._acfPeriod * 0.95,
                    Math.min(this._acfPeriod * 1.05, this.period * (1 + trim)));
    }
    // Rotate accumulated votes along with the grid so they don't
    // re-report the offset we just corrected
    const rot = -shift * 2 * Math.PI;
    const nx  = this._phX * Math.cos(rot) - this._phY * Math.sin(rot);
    const ny  = this._phX * Math.sin(rot) + this._phY * Math.cos(rot);
    this._phX = nx;
    this._phY = ny;
  }

  // Call every frame with raw kick/snare/high envelopes (0..1), dt in seconds.
  update(timeS, kick, snare, high, dt, flux = 0) {
    this._nowS = timeS;
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

    // Downbeat voting — three independent ears, each votes onset mass into
    // the NEAREST beat slot (floor() let early onsets vote one slot back):
    //  · kick accents (works for breakbeat/hip-hop where "1" is heaviest;
    //    harmless in four-on-the-floor where all slots tie)
    //  · snare/clap backbeat — in most electronic music snares live on 2 & 4,
    //    which pins the bar to within a 2-beat ambiguity
    //  · spectral-flux novelty — arrangements change layers on "1"
    if (this.conf > 0.2) {
      const slot = ((Math.round(this.beatT) % 4) + 4) % 4;
      if (dK > 0.15)   this._slotEnergy[slot] += dK;
      if (dS > 0.12)   this._slotSnare[slot]  += dS;
      if (flux > 0.55) this._slotFlux[slot]   += flux - 0.4;
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

    // Phase lock (frame path): strong KICK/SNARE onsets vote for the grid
    // offset via a circular mean (vector average of onset phases). A
    // proportional pull with a dead zone gets stuck when the grid settles
    // ~half a beat off (measured: phase 0.44 at true kicks, correction weight
    // 0 there) — the circular mean converges from ANY initial offset. Hats
    // are excluded — offbeat hats (house!) would drag phase half a beat.
    // These envelope onsets observe the hit ~FFT_LAT late, so the vote is
    // cast at the phase the grid had back at the true hit time. Muted while
    // the AudioWorklet supplies precise events (onsetEvent) — the two paths
    // see the same hits at different times and would fight over the grid.
    const precise   = timeS - this._lastPreciseAt < 2;
    const phasePull = dK + dS * 0.8;
    if (!precise && phasePull > 0.25 && this.conf > 0.15) {
      const ph = (((this.beatT - FFT_LAT / this.period) % 1) + 1) % 1;
      this._votePhase(ph, Math.min(phasePull, 1), 0.25);
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

    // Downbeat: score each candidate "1" by how well the evidence pattern
    // fits it — kick accent ON the candidate, snares on its 2 & 4, novelty
    // spikes ON it. This survives four-on-the-floor (where kick voting alone
    // was a coin toss and the bar dots wandered).
    // Hysteresis: a challenger must beat the runner-up by 25% three analyses
    // in a row before the bar rotates.
    const K = this._slotEnergy, S = this._slotSnare, F = this._slotFlux;
    const normK = K[0] + K[1] + K[2] + K[3] + 1e-6;
    const normS = S[0] + S[1] + S[2] + S[3] + 1e-6;
    const normF = F[0] + F[1] + F[2] + F[3] + 1e-6;
    const score = new Float32Array(4);
    for (let d = 0; d < 4; d++) {
      score[d] = (K[d] / normK) * 0.6
               + ((S[(d + 1) % 4] + S[(d + 3) % 4]) / normS) * 1.0
               + (F[d] / normF) * 1.2;
    }
    let maxSlot = 0;
    for (let i = 1; i < 4; i++) if (score[i] > score[maxSlot]) maxSlot = i;
    let second = 0;
    for (let i = 0; i < 4; i++) if (i !== maxSlot) second = Math.max(second, score[i]);
    if (maxSlot !== this._barOffset && score[maxSlot] > second * 1.25) {
      if (maxSlot === this._barCand) this._barVotes = (this._barVotes ?? 0) + 1;
      else { this._barCand = maxSlot; this._barVotes = 1; }
      if (this._barVotes >= 3) {
        this._barOffset = maxSlot;
        this._barVotes  = 0;
      }
    } else {
      this._barVotes = 0;
    }
    for (let i = 0; i < 4; i++) {                              // slow forget
      this._slotEnergy[i] *= 0.6;
      this._slotSnare[i]  *= 0.6;
      this._slotFlux[i]   *= 0.6;
    }

    // Parabolic interpolation around the peak → sub-bin (~ms) precision
    const y1 = ac[bestLag - 1], y2 = ac[bestLag], y3 = ac[bestLag + 1];
    const den = y1 - 2 * y2 + y3;
    let shift = den !== 0 ? 0.5 * (y1 - y3) / den : 0;
    shift = Math.max(-0.5, Math.min(0.5, shift));
    const newPeriod = (bestLag + shift) / ENV_HZ;
    this._acfPeriod = newPeriod;   // PLL trim anchor (see _votePhase)

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
      // While the worklet PLL is actively calibrating the period against
      // real hit times, the quantized ACF opinion gets less say — otherwise
      // every 2 s analysis drags the period back to the nearest 10 ms bin
      // and re-introduces the drift the PLL just cancelled.
      const pll   = this._nowS - this._lastPreciseAt < 2 && this.conf > 0.5;
      const blend = pll ? 0.15 : 0.35;
      this.period = this.period * (1 - blend) + newPeriod * blend;
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
