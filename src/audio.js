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
    this._kickHarmMax   = 0.001;
    this._snareBandMax  = 0.001;
    this._kick  = 0;
    this._snare = 0;
    // Template matching
    this._templates  = {};
    this._tapSamples = [];
    this._tapTarget  = null;
    // Chromagram
    this.chromagram   = new Float32Array(12);
    this.chromaAnalyser = null;
    this.chromaData     = null;
    // Stereo waveform for oscilloscope
    this.analyserL = null;
    this.analyserR = null;
    this.waveformL = null;
    this.waveformR = null;
    // File playback state
    this._buffer      = null;   // decoded AudioBuffer
    this._isPlaying   = false;
    this._startTime   = 0;      // context.currentTime when last started
    this._pauseOffset = 0;      // seconds into file when paused
    // Stream source tracking — prevents echo when switching between stream and file
    this._activeStreamSource = null;
    // Media stream output for video recording
    this._mediaStreamDest = null;
  }

  // ── Public connection API ───────────────────────────────────────────

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

    // Disconnect stream source — was feeding system audio back into the same analyser,
    // causing the file audio played through destination to be re-captured, creating echo.
    if (this._activeStreamSource) {
      try { this._activeStreamSource.disconnect(); } catch (_) {}
      this._activeStreamSource = null;
    }

    // Clean up old file source
    if (this._fileSource) {
      this._isPlaying = false;
      try { this._fileSource.stop(); } catch (_) {}
      try { this._fileSource.disconnect(); } catch (_) {}
      this._fileSource = null;
    }

    this._ensureAnalyser();
    // Only file playback needs analyser → speakers; stream sources are analysis-only
    this.analyser.connect(this.context.destination);

    this._buffer = buf;
    this._pauseOffset = 0;
    this._ensureChromaAnalyser();
    this._startSource(0);
  }

  // ── File playback controls ─────────────────────────────────────────

  play() {
    if (this._isPlaying || !this._buffer) return;
    this._startSource(this._pauseOffset);
  }

  pause() {
    if (!this._isPlaying || !this._fileSource) return;
    this._pauseOffset = this.getPlaybackTime();
    this._isPlaying   = false;   // set before stop() so onended doesn't reset offset
    try { this._fileSource.stop(); } catch (_) {}
    this._fileSource = null;
  }

  // ratio: 0–1 relative to total duration
  seek(ratio) {
    if (!this._buffer) return;
    const offset = Math.max(0, Math.min(ratio * this._buffer.duration, this._buffer.duration));
    const wasPlaying = this._isPlaying;
    if (this._isPlaying) {
      this._isPlaying = false;
      try { this._fileSource.stop(); } catch (_) {}
      this._fileSource = null;
    }
    this._pauseOffset = offset;
    if (wasPlaying) this._startSource(offset);
  }

  removeFile() {
    if (this._fileSource) {
      this._isPlaying = false;
      try { this._fileSource.stop(); } catch (_) {}
      try { this._fileSource.disconnect(); } catch (_) {}
      this._fileSource = null;
    }
    try { this.analyser.disconnect(this.context.destination); } catch (_) {}
    this._buffer      = null;
    this._pauseOffset = 0;
  }

  getPlaybackTime() {
    if (!this._buffer) return 0;
    if (!this._isPlaying) return this._pauseOffset;
    const t = this._pauseOffset + (this.context.currentTime - this._startTime);
    return Math.min(t, this._buffer.duration);
  }

  getDuration()   { return this._buffer ? this._buffer.duration : 0; }
  get hasFile()   { return !!this._buffer; }
  get isPlaying() { return this._isPlaying; }

  // Returns an audio MediaStream for video recording (creates on first call)
  enableMediaStreamOutput() {
    if (!this.context || !this.analyser) return null;
    if (!this._mediaStreamDest) {
      this._mediaStreamDest = this.context.createMediaStreamDestination();
      this.analyser.connect(this._mediaStreamDest);
    }
    return this._mediaStreamDest.stream;
  }

  // ── Internal ───────────────────────────────────────────────────────

  _startSource(offset) {
    if (this._fileSource) {
      try { this._fileSource.stop(); } catch (_) {}
      try { this._fileSource.disconnect(); } catch (_) {}
    }
    this._fileSource = this.context.createBufferSource();
    this._fileSource.buffer = this._buffer;
    this._fileSource.loop   = false;
    this._fileSource.connect(this.analyser);
    try { this._fileSource.connect(this.chromaAnalyser); } catch (_) {}
    this._connectStereo(this._fileSource);
    if (this._mediaStreamDest) {
      try { this._fileSource.connect(this._mediaStreamDest); } catch (_) {}
    }
    this._fileSource.start(0, offset);
    this._startTime   = this.context.currentTime;
    this._pauseOffset = offset;
    this._isPlaying   = true;
    this._fileSource.onended = () => {
      // Only reset to beginning on natural end (not when we stop manually)
      if (this._isPlaying) {
        this._isPlaying   = false;
        this._pauseOffset = 0;
      }
    };
  }

  _connectStream(stream) {
    this._ensureContext();
    this._ensureAnalyser();
    // Remove old stream source to prevent double-input
    if (this._activeStreamSource) {
      try { this._activeStreamSource.disconnect(); } catch (_) {}
    }
    const source = this.context.createMediaStreamSource(stream);
    this._activeStreamSource = source;
    source.connect(this.analyser);
    try {
      this._ensureChromaAnalyser();
      source.connect(this.chromaAnalyser);
    } catch (e) {
      console.warn('Chroma analyser setup failed:', e);
    }
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

  _ensureChromaAnalyser() {
    if (this.chromaAnalyser) return;
    this.chromaAnalyser = this.context.createAnalyser();
    this.chromaAnalyser.fftSize = 8192;
    this.chromaAnalyser.smoothingTimeConstant = 0.0;
    this.chromaData = new Uint8Array(this.chromaAnalyser.frequencyBinCount);
  }

  _ensureAnalyser() {
    if (this.analyser) return;
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.0;
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
  }

  // ── Frame update ───────────────────────────────────────────────────

  update() {
    if (!this.analyser) return this.bands;
    this.analyser.getByteFrequencyData(this.dataArray);

    const binHz = this.context.sampleRate / this.analyser.fftSize;

    const raw = {
      subBass:     this._avg(20,   80,    binHz),
      bass:        this._avg(80,   250,   binHz),
      mid:         this._avg(250,  2000,  binHz),
      high:        this._avg(2000, 16000, binHz),
      kickRaw:     this._avg(35,   70,    binHz),
      kickHarmRaw: this._avg(150,  450,   binHz),
      snareRaw:    this._avg(2500, 7000,  binHz),
    };

    const energy = (raw.subBass + raw.bass + raw.mid + raw.high) / 4;
    this._maxEnergy = Math.max(this._maxEnergy * 0.998, energy + 0.001);
    const gain = 1 / this._maxEnergy;

    this._kickBandMax  = Math.max(this._kickBandMax  * 0.999, raw.kickRaw     + 0.0005);
    this._kickHarmMax  = Math.max(this._kickHarmMax  * 0.999, raw.kickHarmRaw + 0.0005);
    this._snareBandMax = Math.max(this._snareBandMax * 0.999, raw.snareRaw    + 0.0005);

    const kickRawNorm  = raw.kickRaw     / this._kickBandMax;
    const kickHarmNorm = raw.kickHarmRaw / this._kickHarmMax;
    const snareRawNorm = raw.snareRaw    / this._snareBandMax;

    const harmRatio = Math.min(kickHarmNorm / (kickRawNorm + 0.05), 3.0) / 3.0;
    const kickScore = kickRawNorm * (1.0 - harmRatio * 0.75);

    this._kickBaseline  = this._kickBaseline  * 0.95 + kickScore    * 0.05;
    this._snareBaseline = this._snareBaseline * 0.93 + snareRawNorm * 0.07;

    const kickTransient  = Math.max(0, kickScore    - this._kickBaseline)  * 10;
    const snareTransient = Math.max(0, snareRawNorm - this._snareBaseline) * 9;

    this._kick  = Math.max(Math.min(kickTransient,  1), this._kick  * 0.72);
    this._snare = Math.max(Math.min(snareTransient, 1), this._snare * 0.68);

    const kickGate  = 1.0 - this._kick  * 0.85;
    const snareGate = 1.0 - this._snare * 0.70;

    const nSubBass = Math.min(raw.subBass * gain, 1) * kickGate;
    const nBass    = Math.min(raw.bass    * gain, 1) * kickGate;
    const nMid     = Math.min(raw.mid     * gain, 1) * snareGate;
    const nHigh    = Math.min(raw.high    * gain, 1);

    this._smoothed.subBass = nSubBass > this._smoothed.subBass
      ? this._smoothed.subBass * 0.94 + nSubBass * 0.06
      : this._smoothed.subBass * 0.85 + nSubBass * 0.15;

    this._smoothed.bass = nBass > this._smoothed.bass
      ? this._smoothed.bass * 0.91 + nBass * 0.09
      : this._smoothed.bass * 0.80 + nBass * 0.20;

    this._smoothed.mid = nMid > this._smoothed.mid
      ? this._smoothed.mid * 0.84 + nMid * 0.16
      : this._smoothed.mid * 0.75 + nMid * 0.25;

    this._smoothed.high = this._smoothed.high * 0.65 + nHigh * 0.35;

    if (this.chromaAnalyser) {
      this.chromaAnalyser.getByteFrequencyData(this.chromaData);
      const chromaBinHz = this.context.sampleRate / this.chromaAnalyser.fftSize;
      this.chromagram = this._computeChromagram(chromaBinHz, this.chromaData);
    } else {
      this.chromagram = this._computeChromagram(binHz, this.dataArray);
    }

    if (this.analyserL) {
      this.analyserL.getFloatTimeDomainData(this.waveformL);
      this.analyserR.getFloatTimeDomainData(this.waveformR);

      let dotLR = 0, magL = 0, magR = 0;
      for (let i = 0; i < 256; i++) {
        dotLR += this.waveformL[i] * this.waveformR[i];
        magL  += this.waveformL[i] * this.waveformL[i];
        magR  += this.waveformR[i] * this.waveformR[i];
      }
      const corr = (magL > 1e-6 && magR > 1e-6) ? dotLR / Math.sqrt(magL * magR) : 1.0;
      if (corr > 0.90) {
        const delay = 128;
        for (let i = 0; i < this.waveformR.length; i++) {
          this.waveformR[i] = this.waveformL[(i + delay) % this.waveformL.length];
        }
      }
    }

    if (Object.keys(this._templates).length > 0) {
      const spec = new Float32Array(this.dataArray.length);
      for (let i = 0; i < this.dataArray.length; i++) spec[i] = this.dataArray[i] / 255;
      this._kick  *= this._tmplGate('kick',  spec);
      this._snare *= this._tmplGate('snare', spec);
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

  // ── Template training API ──────────────────────────────────────────

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

  _tmplGate(band, currentSpec, lo = 0.35, hi = 0.75) {
    if (!this._templates[band] || !currentSpec) return 1.0;
    const sim = this._cosSim(currentSpec, this._templates[band]);
    return Math.min(Math.max((sim - lo) / (hi - lo), 0), 1);
  }

  _computeChromagram(binHz, data) {
    const chroma = new Float32Array(12);
    if (!data) return chroma;
    for (let pc = 0; pc < 12; pc++) {
      let energy = 0, totalW = 0;
      for (let oct = 2; oct <= 7; oct++) {
        const midiNote = (oct + 1) * 12 + pc;
        const freq = 440 * Math.pow(2, (midiNote - 69) / 12);
        if (freq > 18000) break;
        const bin = Math.round(freq / binHz);
        if (bin < 4 || bin >= data.length - 4) continue;
        const w    = 1.0 / oct;
        const peak = (data[bin-1]/255 * 0.5 + data[bin]/255 + data[bin+1]/255 * 0.5) / 2.0;
        const floor = (data[bin-4]/255 + data[bin-3]/255 + data[bin+3]/255 + data[bin+4]/255) / 4.0;
        energy += Math.max(0, peak - floor) * w;
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
