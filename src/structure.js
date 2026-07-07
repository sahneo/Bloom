// ---------------------------------------------------------------------------
// StructureAnalyzer — tracks the macro-shape of the music so visuals can
// re-stage themselves when the track does something: builds, drops,
// breakdowns, and 4-bar phrase boundaries.
//
// Everything works on band envelopes already computed by AudioAnalyser plus
// the BeatTracker grid — no extra FFT work.
//
// Outputs per frame:
//   state     — 'quiet' | 'steady' | 'build' | 'breakdown'
//   tension   — 0..1 build-up intensity (rising energy over ~6 s)
//   dropPulse — 1.0 on a detected drop, exponential decay (~0.5 s)
//   onDrop    — true for exactly one frame when a drop fires
//   onPhrase  — true for one frame at each 4-bar phrase boundary (beat-locked)
//   phrase    — running phrase counter
// ---------------------------------------------------------------------------

export class StructureAnalyzer {
  constructor() {
    this.state     = 'quiet';
    this.tension   = 0;
    this.dropPulse = 0;
    this.onDrop    = false;
    this.onPhrase  = false;
    this.phrase    = 0;

    // Energy followers (fast reacts in ~0.3 s, slow is the ~10 s norm)
    this._fast = 0; this._slow = 0;
    this._bassFast = 0; this._bassSlow = 0;
    this._highFast = 0; this._highSlow = 0;

    // 8 s history of _fast sampled at 4 Hz — for rise-over-time (builds)
    this._ring    = new Float32Array(32);
    this._ringPos = 0;
    this._ringT   = 0;

    this._bassLowMs  = 0;      // how long bass has been well below its norm
    this._sinceDropMs = 1e9;
    this._playMs      = 0;     // total time with signal — norms need warm-up
    this._prevBarPos  = 0;
    this._bars        = 0;
    this._dropPendingMs = 0;   // energy condition met, waiting for the beat
    this._prevBeatPhase = 0;
  }

  // bands: raw (unmuted) band envelopes; beat: BeatTracker; dtS: seconds
  update(bands, beat, dtS) {
    const dtMs = dtS * 1000;
    this.onDrop   = false;
    this.onPhrase = false;

    const total = bands.bass * 0.45 + bands.mid * 0.30 + bands.high * 0.25;
    const bass  = Math.max(bands.bass, bands.subBass);

    const ema = (cur, x, tauS) => cur + (x - cur) * Math.min(dtS / tauS, 1);
    this._fast     = ema(this._fast,     total,      0.35);
    this._slow     = ema(this._slow,     total,      10);
    this._bassFast = ema(this._bassFast, bass,       0.30);
    // Bass norm only tracks while bass is actually present. During a
    // breakdown the norm otherwise decays toward zero, and the first riser
    // swell blows past it — that's what fired drops seconds early.
    if (bass > this._bassSlow * 0.5 || this._bassSlow < 0.05) {
      this._bassSlow = ema(this._bassSlow, bass, 12);
    }
    this._highFast = ema(this._highFast, bands.high, 0.60);
    this._highSlow = ema(this._highSlow, bands.high, 10);

    // 4 Hz ring of the fast envelope
    this._ringT += dtS;
    while (this._ringT >= 0.25) {
      this._ringT -= 0.25;
      this._ring[this._ringPos % 32] = this._fast;
      this._ringPos++;
    }
    const ago6s = this._ring[(this._ringPos - 24 + 64) % 32];  // ~6 s ago

    const playing  = this._slow > 0.03 || this._fast > 0.05;
    if (playing) this._playMs += dtMs;
    const bassNorm = Math.max(this._bassSlow, 0.05);
    const bassRel  = this._bassFast / bassNorm;

    // ── Breakdown: bass/kick pulled out while the track keeps playing ──
    if (playing && bassRel < 0.45 && this._fast > 0.04) {
      this._bassLowMs += dtMs;
    } else {
      this._bassLowMs = Math.max(0, this._bassLowMs - dtMs * 2);
    }
    const inBreakdown = this._bassLowMs > 1600;

    // ── Tension: sustained energy rise + hats getting busier (risers) ──
    let tTarget = 0;
    if (playing && this._ringPos >= 24) {
      const rise     = this._fast - ago6s;                        // 6 s slope
      const highRise = this._highFast - this._highSlow;
      tTarget = Math.min(1, Math.max(0, rise * 4 + highRise * 2.5));
      if (tTarget < 0.12) tTarget = 0;                            // noise gate
    }
    // Breakdowns often ARE the build (bass gone, riser up) — let tension grow there
    const tRate = tTarget > this.tension ? 1.8 : 1.0;             // attack/release s
    this.tension += (tTarget - this.tension) * Math.min(dtS / tRate, 1);

    // ── Drop: bass slams back after a breakdown or a tense build ──
    // Warm-up guard: the slow norms need ~12 s of material before bassRel is
    // meaningful — without it every intro's first bass entry fires a "drop".
    //
    // Beat quantization: envelope detection inevitably lags the real hit by
    // 100–300 ms (live input has no lookahead), so a raw trigger lands between
    // beats and reads as a miss. Real drops land on the beat — so the energy
    // condition only ARMS the drop; the blast FIRES on the beat grid: right
    // away if a beat just passed, else exactly on the next predicted beat.
    this._sinceDropMs += dtMs;
    const primed = inBreakdown || this._bassLowMs > 1200 || this.tension > 0.7;
    const energyJump = this._fast > this._slow * 1.15;   // the mix actually got louder
    if (playing && primed && this._playMs > 12000
        && bassRel > 1.0 && bands.kick > 0.5 && energyJump
        && this._sinceDropMs > 8000 && this._dropPendingMs <= 0) {
      this._dropPendingMs = beat.conf > 0.4 ? beat.period * 1200 : 1;  // ≤1.2 beats
    }
    if (this._dropPendingMs > 0) {
      const phase   = beat.beatT % 1;
      const wrapped = phase < this._prevBeatPhase;
      this._dropPendingMs -= dtMs;
      if (beat.conf < 0.4 || phase < 0.25 || wrapped || this._dropPendingMs <= 0) {
        this.onDrop      = true;
        this.dropPulse   = 1;
        this.tension     = Math.min(this.tension, 0.15);
        this._bassLowMs  = 0;
        this._sinceDropMs   = 0;
        this._dropPendingMs = 0;
      }
    }
    this._prevBeatPhase = beat.beatT % 1;
    this.dropPulse *= Math.exp(-dtS * 2.2);

    // ── State ──
    this.state = !playing     ? 'quiet'
               : inBreakdown  ? 'breakdown'
               : this.tension > 0.45 ? 'build'
               : 'steady';

    // ── Phrase boundaries: every 4 bars, locked to the beat grid ──
    if (beat.conf > 0.5) {
      const barPos = beat.barPos();
      if (this._prevBarPos > 3 && barPos < 1) {
        this._bars++;
        if (this._bars % 4 === 0) {
          this.phrase++;
          this.onPhrase = true;
        }
      }
      this._prevBarPos = barPos;
    }

    return this;
  }
}
