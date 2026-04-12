export class AudioAnalyser {
  constructor() {
    this.context = null;
    this.analyser = null;
    this.dataArray = null;
    this.bands = { subBass: 0, bass: 0, mid: 0, high: 0, kick: 0, snare: 0 };
    this._smoothed = { subBass: 0, bass: 0, mid: 0, high: 0 };
    this._maxEnergy = 0.001;
    this._fileSource = null;
    // Transient detection
    this._kickBaseline  = 0;
    this._snareBaseline = 0;
    this._kickBandMax   = 0.001;
    this._kickHarmMax   = 0.001;  // tracks 150-450Hz for spectral shape check
    this._snareBandMax  = 0.001;
    this._kick  = 0;
    this._snare = 0;
    // Template matching
    this._templates  = {};   // band -> Float32Array(frequencyBinCount)
    this._tapSamples = [];   // snapshots accumulated during tap training
    this._tapTarget  = null; // band name being trained right now
    // Chromagram (12-bin pitch class energy, computed every frame from FFT)
    this.chromagram  = new Float32Array(12);
    // Stereo waveform for oscilloscope (time-domain PCM, L and R channels)
    this.analyserL   = null;
    this.analyserR   = null;
    this.waveformL   = null;
    this.waveformR   = null;
  }

  async connectSystemAudio() {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    stream.getVideoTracks().forEach(t => t.stop());
    this._connectStream(stream);
  }

  async connectMicrophone() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this._connectStream(stream);
  }

  async connectFile(file) {
    this._ensureContext();
    const buf = await this.context.decodeAudioData(await file.arrayBuffer());
    if (this._fileSource) { this._fileSource.stop(); this._fileSource.disconnect(); }
    this._ensureAnalyser();
    this._fileSource = this.context.createBufferSource();
    this._fileSource.buffer = buf;
    this._fileSource.loop = true;
    this._fileSource.connect(this.analyser);
    this.analyser.connect(this.context.destination);
    this._connectStereo(this._fileSource);
    this._fileSource.start();
  }

  _connectStream(stream) {
    this._ensureContext();
    this._ensureAnalyser();
    const source = this.context.createMediaStreamSource(stream);
    source.connect(this.analyser);
    this._connectStereo(source);
  }

  _connectStereo(sourceNode) {
    this._ensureStereoAnalysers();
    try {
      const splitter = this.context.createChannelSplitter(2);
      sourceNode.connect(splitter);
      splitter.connect(this.analyserL, 0);
      splitter.connect(this.analyserR, 1);
    } catch (_) {
      // Mono fallback: connect same source to both channels
      sourceNode.connect(this.analyserL);
      sourceNode.connect(this.analyserR);
    }
  }

  _ensureStereoAnalysers() {
    if (this.analyserL) return;
    const fftSize = 2048;
    this.analyserL = this.context.createAnalyser();
    this.analyserR = this.context.createAnalyser();
    this.analyserL.fftSize = fftSize;
    this.analyserR.fftSize = fftSize;
    this.analyserL.smoothingTimeConstant = 0;
    this.analyserR.smoothingTimeConstant = 0;
    this.waveformL = new Float32Array(fftSize);
    this.waveformR = new Float32Array(fftSize);
  }

  _ensureContext() {
    if (!this.context) this.context = new AudioContext();
  }

  _ensureAnalyser() {
    if (this.analyser) return;
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.0; // no built-in smoothing — we do our own per-band
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
  }

  update() {
    if (!this.analyser) return this.bands;
    this.analyser.getByteFrequencyData(this.dataArray);

    const binHz = this.context.sampleRate / this.analyser.fftSize;

    const raw = {
      subBass:     this._avg(20,   80,    binHz),
      bass:        this._avg(80,   250,   binHz),
      mid:         this._avg(250,  2000,  binHz),
      high:        this._avg(2000, 16000, binHz),
      kickRaw:     this._avg(35,   70,    binHz),   // kick sub fundamental
      kickHarmRaw: this._avg(150,  450,   binHz),   // spectral shape check (bass harmonics live here)
      snareRaw:    this._avg(2500, 7000,  binHz),   // snare crack — above bass harmonic range
    };

    // AGC — always on raw values, before any gating
    const energy = (raw.subBass + raw.bass + raw.mid + raw.high) / 4;
    this._maxEnergy = Math.max(this._maxEnergy * 0.998, energy + 0.001);
    const gain = 1 / this._maxEnergy;

    // ── Transient detection — per-band normalization ──────────────────
    this._kickBandMax  = Math.max(this._kickBandMax  * 0.999, raw.kickRaw     + 0.0005);
    this._kickHarmMax  = Math.max(this._kickHarmMax  * 0.999, raw.kickHarmRaw + 0.0005);
    this._snareBandMax = Math.max(this._snareBandMax * 0.999, raw.snareRaw    + 0.0005);

    const kickRawNorm  = raw.kickRaw     / this._kickBandMax;
    const kickHarmNorm = raw.kickHarmRaw / this._kickHarmMax;
    const snareRawNorm = raw.snareRaw    / this._snareBandMax;

    // Spectral shape check for kick:
    //   Kick  → large sub (35-70Hz), tiny harmonics (150-450Hz) → ratio low  → full score
    //   Bass note → small sub,       large harmonics             → ratio high → score suppressed
    //   Bass+kick → kick lifts sub much more than harmonics      → ratio drops → still detected
    const harmRatio  = Math.min(kickHarmNorm / (kickRawNorm + 0.05), 3.0) / 3.0; // 0–1
    const kickScore  = kickRawNorm * (1.0 - harmRatio * 0.75);

    // Baseline = sustained floor; transient = spike above it
    this._kickBaseline  = this._kickBaseline  * 0.95 + kickScore      * 0.05;
    this._snareBaseline = this._snareBaseline * 0.93 + snareRawNorm   * 0.07;

    const kickTransient  = Math.max(0, kickScore    - this._kickBaseline)  * 10;
    const snareTransient = Math.max(0, snareRawNorm - this._snareBaseline) * 9;

    this._kick  = Math.max(Math.min(kickTransient,  1), this._kick  * 0.72);
    this._snare = Math.max(Math.min(snareTransient, 1), this._snare * 0.68);

    // ── Step 2: sidechain gating ──────────────────────────────────────
    // When kick fires, suppress the low-freq sustained signals so the same
    // frequency content doesn't bleed into both drums AND bass visuals.
    // snare gate reduces mid bleed when snare hits.
    const kickGate  = 1.0 - this._kick  * 0.85;
    const snareGate = 1.0 - this._snare * 0.70;

    const nSubBass = Math.min(raw.subBass * gain, 1) * kickGate;
    const nBass    = Math.min(raw.bass    * gain, 1) * kickGate;
    const nMid     = Math.min(raw.mid     * gain, 1) * snareGate;
    const nHigh    = Math.min(raw.high    * gain, 1);

    // ── Step 3: asymmetric sustained envelopes ────────────────────────
    // Slow attack = doesn't respond to brief transients (kick lasts ~14 frames,
    // bass note lasts hundreds). Fast-ish decay so visuals stay alive.
    //
    // sub-bass / pads: very slow attack (τ ≈ 0.27s), medium decay
    this._smoothed.subBass = nSubBass > this._smoothed.subBass
      ? this._smoothed.subBass * 0.94 + nSubBass * 0.06
      : this._smoothed.subBass * 0.85 + nSubBass * 0.15;

    // bass: slow attack (τ ≈ 0.18s), medium decay — sustained bass lines only
    this._smoothed.bass = nBass > this._smoothed.bass
      ? this._smoothed.bass * 0.91 + nBass * 0.09
      : this._smoothed.bass * 0.80 + nBass * 0.20;

    // mid / lead: medium attack (τ ≈ 0.10s) — melodic content
    this._smoothed.mid = nMid > this._smoothed.mid
      ? this._smoothed.mid * 0.84 + nMid * 0.16
      : this._smoothed.mid * 0.75 + nMid * 0.25;

    // high / atmos: fast and symmetric — high freq is naturally transient-like
    this._smoothed.high = this._smoothed.high * 0.65 + nHigh * 0.35;

    // ── Chromagram (12-bin pitch class energy for audio tonality) ────
    this.chromagram = this._computeChromagram(binHz);

    // ── Stereo waveform for oscilloscope ─────────────────────────────
    if (this.analyserL) {
      this.analyserL.getFloatTimeDomainData(this.waveformL);
      this.analyserR.getFloatTimeDomainData(this.waveformR);
      // Pseudo-stereo for mono: delay R by 1/4 buffer ≈ 90° phase shift
      let rEnergy = 0;
      for (let i = 0; i < this.waveformR.length; i++) rEnergy += this.waveformR[i] * this.waveformR[i];
      if (rEnergy < 0.001) {
        const delay = this.waveformL.length >> 2;   // 512 samples ≈ 11.6ms
        for (let i = 0; i < this.waveformR.length; i++) {
          this.waveformR[i] = this.waveformL[(i + delay) % this.waveformL.length];
        }
      }
    }

    // ── Template gating (when templates are trained) ─────────────────
    // Build a snapshot of the current spectrum for cosine similarity.
    // Only pay the cost when at least one template exists.
    if (Object.keys(this._templates).length > 0) {
      const spec = new Float32Array(this.dataArray.length);
      for (let i = 0; i < this.dataArray.length; i++) spec[i] = this.dataArray[i] / 255;

      // Transient bands — gate the final kick/snare signals
      this._kick  *= this._tmplGate('kick',  spec);
      this._snare *= this._tmplGate('snare', spec);

      // Sustained bands — gate the smoothed envelope
      this._smoothed.bass    *= this._tmplGate('bass',  spec);
      this._smoothed.mid     *= this._tmplGate('lead',  spec);
      this._smoothed.high    *= this._tmplGate('atmos', spec);
      this._smoothed.subBass *= this._tmplGate('pads',  spec);
    }

    this.bands = {
      subBass: this._smoothed.subBass,
      bass:    this._smoothed.bass,
      mid:     this._smoothed.mid,
      high:    this._smoothed.high,
      kick:    this._kick,
      snare:   this._snare,
    };
    return this.bands;
  }

  // ── Template training API ───────────────────────────────────────────
  startTap(band) {
    this._tapTarget  = band;
    this._tapSamples = [];
  }

  recordTap() {
    if (!this._tapTarget || !this.dataArray) return 0;
    const snap = new Float32Array(this.dataArray.length);
    for (let i = 0; i < this.dataArray.length; i++) snap[i] = this.dataArray[i] / 255;
    this._tapSamples.push(snap);
    return this._tapSamples.length;
  }

  commitTemplate() {
    if (!this._tapTarget || this._tapSamples.length === 0) return false;
    const n   = this._tapSamples.length;
    const len = this._tapSamples[0].length;
    const avg = new Float32Array(len);
    for (const snap of this._tapSamples) {
      for (let i = 0; i < len; i++) avg[i] += snap[i] / n;
    }
    this._templates[this._tapTarget] = avg;
    this._tapTarget  = null;
    this._tapSamples = [];
    return true;
  }

  clearTemplate(band)  { delete this._templates[band]; }
  hasTemplate(band)    { return !!this._templates[band]; }
  tapCount()           { return this._tapSamples.length; }

  _cosSim(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na  += a[i] * a[i];
      nb  += b[i] * b[i];
    }
    const denom = Math.sqrt(na * nb);
    return denom < 1e-9 ? 0 : dot / denom;
  }

  // Gate value: 0 when sim ≤ lo, 1 when sim ≥ hi — smooth ramp between
  _tmplGate(band, currentSpec, lo = 0.35, hi = 0.75) {
    if (!this._templates[band] || !currentSpec) return 1.0;
    const sim = this._cosSim(currentSpec, this._templates[band]);
    return Math.min(Math.max((sim - lo) / (hi - lo), 0), 1);
  }

  // 12-bin chromagram from FFT — sums note harmonics across octaves C2–C7
  _computeChromagram(binHz) {
    const chroma = new Float32Array(12);
    if (!this.dataArray) return chroma;
    for (let pc = 0; pc < 12; pc++) {
      let energy = 0, totalW = 0;
      for (let oct = 2; oct <= 7; oct++) {
        const midiNote = (oct + 1) * 12 + pc;           // C2=36, C3=48 …
        const freq = 440 * Math.pow(2, (midiNote - 69) / 12);
        if (freq > 18000) break;
        const bin = Math.round(freq / binHz);
        if (bin < 1 || bin >= this.dataArray.length - 1) continue;
        const w = 1.0 / oct;                             // lower octaves weighted more
        energy += (this.dataArray[bin-1]/255 * 0.5 +
                   this.dataArray[bin  ]/255 * 1.0 +
                   this.dataArray[bin+1]/255 * 0.5) / 2.0 * w;
        totalW += w;
      }
      chroma[pc] = totalW > 0 ? energy / totalW : 0;
    }
    return chroma;
  }

  _avg(minHz, maxHz, binHz) {
    const lo = Math.floor(minHz / binHz);
    const hi = Math.min(Math.ceil(maxHz / binHz), this.dataArray.length - 1);
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += this.dataArray[i] / 255;
    return sum / (hi - lo + 1);
  }
}
