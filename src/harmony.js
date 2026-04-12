// ---------------------------------------------------------------------------
// Harmony analysis
//
// Maintains a rolling Harmonic Histogram Buffer.  Pitch class weights decay
// over time; the buffer drives a continuous tonality scalar rather than a
// discrete enum, so colour transitions are always smooth.
// ---------------------------------------------------------------------------

// Krumhansl-Schmuckler key profiles (1990)
// Weighted by how strongly each scale degree implies the key —
// unlike binary templates these DO discriminate major from minor.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

// Rotate profile so index 0 maps to pitch class `root`
function rotateTo(profile, root) {
  return Array.from({ length: 12 }, (_, i) => profile[(i - root + 12) % 12]);
}

function dot(a, b) {
  return a.reduce((s, v, i) => s + v * b[i], 0);
}

export class HarmonyAnalyzer {
  constructor({ bufferMs = 3000 } = {}) {
    this.bufferMs   = bufferMs;
    this.activeNotes = new Map(); // pitch → { velocity, startMs }
    this.expiredNotes = [];       // { pitch, velocity, durationMs, endMs }

    // Smoothed output — updated every frame via lerp
    this.tonality = 0;    // current display value, -1 → +1
    this._targetTonality = 0;
    this.pulse    = 0;    // current display value, decays to 0
    this._silenceMs = 0;  // ms since last note-on
    this._lastUpdateMs = performance.now();
  }

  // Called on MIDI note-on
  noteOn(pitch, velocity) {
    this.activeNotes.set(pitch, { velocity, startMs: performance.now() });
    // Pulse proportional to velocity
    this.pulse = Math.min(1, this.pulse + (velocity / 127) * 0.8);
    this._silenceMs = 0;
  }

  // Called on MIDI note-off
  noteOff(pitch) {
    const note = this.activeNotes.get(pitch);
    if (!note) return;
    this.activeNotes.delete(pitch);
    // Store velocity-based weight only — duration doesn't matter
    this.expiredNotes.push({
      pitch,
      weight: note.velocity / 127,
      endMs:  performance.now(),
    });
  }

  // Call once per frame; returns { tonality, pulse, energy }
  update(fftEnergy = 0) {
    const now      = performance.now();
    const deltaMs  = now - this._lastUpdateMs;
    this._lastUpdateMs = now;

    // --- Prune expired notes older than bufferMs ---
    const cutoff = now - this.bufferMs;
    this.expiredNotes = this.expiredNotes.filter(n => n.endMs > cutoff);

    // --- Build pitch class histogram ---
    const histogram = new Float32Array(12);

    // Still-active (held) notes: full velocity weight
    for (const [pitch, note] of this.activeNotes) {
      histogram[pitch % 12] += note.velocity / 127;
    }

    // Expired notes: slow exponential decay so chord-note order doesn't bias tonality
    // (linear decay would give the last-pressed note 3× the weight of the first)
    for (const note of this.expiredNotes) {
      const age   = now - note.endMs;
      const decay = Math.exp(-age / (this.bufferMs * 1.5)); // tau = 4500ms, pruned at 3000ms
      histogram[note.pitch % 12] += note.weight * decay;
    }

    // Normalize
    const histMax = Math.max(...histogram, 0.001);
    for (let i = 0; i < 12; i++) histogram[i] /= histMax;

    // --- Compute tonality: compare best major vs best minor key match ---
    let bestMajor = 0, bestMinor = 0;
    for (let root = 0; root < 12; root++) {
      bestMajor = Math.max(bestMajor, dot(histogram, rotateTo(MAJOR_PROFILE, root)));
      bestMinor = Math.max(bestMinor, dot(histogram, rotateTo(MINOR_PROFILE, root)));
    }

    const total = bestMajor + bestMinor;
    const hasNotes = total > 0.1;

    // Debug: log every second
    if (!this._lastDebugMs || now - this._lastDebugMs > 1000) {
      this._lastDebugMs = now;
      const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
      const histStr = Array.from(histogram).map((v,i) => v > 0.05 ? `${NOTE_NAMES[i]}:${v.toFixed(2)}` : null).filter(Boolean).join(' ');
      console.log(`[Harmony] maj=${bestMajor.toFixed(2)} min=${bestMinor.toFixed(2)} total=${total.toFixed(2)} hasNotes=${hasNotes} target=${this._targetTonality.toFixed(3)} current=${this.tonality.toFixed(3)} | ${histStr || '(empty)'} | expired=${this.expiredNotes.length} active=${this.activeNotes.size}`);
    }

    // --- Silence tracking ---
    if (this.activeNotes.size === 0) this._silenceMs += deltaMs;
    else this._silenceMs = 0;

    // Tonality target: if enough notes → computed; if silent > 5s → decay to 0
    if (hasNotes) {
      const raw = (bestMajor - bestMinor) / total; // typically ±0.2–0.6
      // Amplify with a power curve so small differences produce clear colour shifts
      this._targetTonality = Math.tanh(raw * 25);
    } else if (this._silenceMs > 5000) {
      this._targetTonality = 0;
    }

    // --- Lerp smoothed values ---
    const tonalitySpeed = 0.004 * deltaMs; // ~0.5s transition at 60fps
    this.tonality += (this._targetTonality - this.tonality) * Math.min(tonalitySpeed, 1);

    const pulseDecay  = Math.pow(0.92, deltaMs / 16.67); // ~0.92 per frame at 60fps
    this.pulse *= pulseDecay;

    // FFT energy contributes a floor to pulse (keeps shader alive on audio-only tracks)
    const displayPulse = Math.max(this.pulse, fftEnergy * 0.35);

    return {
      tonality: this.tonality,
      pulse:    displayPulse,
      energy:   fftEnergy,
    };
  }

  // Audio-based tonality: accepts a 12-bin chromagram instead of MIDI events.
  // Runs the same K-S correlation; used when MIDI is silent.
  updateFromChroma(chroma, fftEnergy = 0) {
    const now     = performance.now();
    const deltaMs = now - this._lastUpdateMs;
    this._lastUpdateMs = now;

    // Normalise chromagram to [0,1]
    let histMax = 0.001;
    for (let i = 0; i < 12; i++) histMax = Math.max(histMax, chroma[i]);
    const histogram = new Float32Array(12);
    for (let i = 0; i < 12; i++) histogram[i] = chroma[i] / histMax;

    // K-S correlation — identical to update()
    let bestMajor = 0, bestMinor = 0;
    for (let root = 0; root < 12; root++) {
      bestMajor = Math.max(bestMajor, dot(histogram, rotateTo(MAJOR_PROFILE, root)));
      bestMinor = Math.max(bestMinor, dot(histogram, rotateTo(MINOR_PROFILE, root)));
    }

    const total      = bestMajor + bestMinor;
    const hasContent = total > 0.1 && fftEnergy > 0.04;

    if (hasContent) {
      const raw = (bestMajor - bestMinor) / total;
      this._targetTonality = Math.tanh(raw * 25);
    } else if (fftEnergy < 0.02) {
      this._targetTonality *= 0.997;   // slow decay to neutral on silence
    }

    // Smooth tonality (same speed as MIDI path)
    const tonalitySpeed = 0.004 * deltaMs;
    this.tonality += (this._targetTonality - this.tonality) * Math.min(tonalitySpeed, 1);

    // No MIDI velocity → pulse driven purely by FFT energy floor
    const pulseDecay   = Math.pow(0.92, deltaMs / 16.67);
    this.pulse        *= pulseDecay;
    const displayPulse = Math.max(this.pulse, fftEnergy * 0.35);

    return { tonality: this.tonality, pulse: displayPulse, energy: fftEnergy };
  }

  // Manually override tonality (manual key selector)
  setManualTonality(value) {
    this._targetTonality = Math.max(-1, Math.min(1, value));
  }
}
