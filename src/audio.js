// Universal band ranges (Hz) — genre presets narrow these for better separation
const DEFAULT_RANGES = {
  subBass: [20, 80],   bass: [80, 250],      mid: [250, 2000], high: [2000, 16000],
  kick:    [35, 70],   kickHarm: [150, 450], snare: [2500, 7000],
};

export class AudioAnalyser {
  constructor() {
    this.context = null;
    this.analyser = null;
    this.dataArray = null;
    this.ranges = { ...DEFAULT_RANGES };
    this.bands = { subBass: 0, bass: 0, mid: 0, high: 0, kick: 0, snare: 0 };
    this.sharpness = 0;   // 0 = sine-soft timbre, 1 = saw-bright (spectral centroid)
    this._smoothed = { subBass: 0, bass: 0, mid: 0, high: 0 };
    this._maxEnergy = 0.001;
    // Per-band AGC: each band normalizes against its own ceiling/floor so a
    // bass-heavy master can't crush mids/highs (and vice versa)
    this._agc = {
      subBass: { max: 0.05, floor: 0 }, bass: { max: 0.05, floor: 0 },
      mid:     { max: 0.05, floor: 0 }, high: { max: 0.05, floor: 0 },
    };
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
    // Picking a window (not the entire screen), or leaving "share audio"
    // unchecked, yields a video-only stream — fail loudly instead of silently
    if (stream.getAudioTracks().length === 0) {
      throw new Error('no audio — share the ENTIRE screen with "Also share system audio" on');
    }
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
    this._ensureOnsetWorklet().then(() => {
      if (this._onsetNode && this._fileSource) {
        try { this._fileSource.connect(this._onsetNode); } catch (_) {}
      }
    });
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
    if (this._onsetNode) { try { this._fileSource.connect(this._onsetNode); } catch (_) {} }
    this._connectStereo(this._fileSource);
    if (this._mediaStreamDest) {
      try { this._fileSource.connect(this._mediaStreamDest); } catch (_) {}
    }
    this._fileSource.start(0, offset);
    this._startTime   = this.context.currentTime;
    this._pauseOffset = offset;
    this._isPlaying   = true;
    // Capture reference so stale onended events from old sources are ignored.
    // Race: pause() calls src.stop() then sets _fileSource=null; stop() queues
    // onended asynchronously. If play() fires before onended arrives, a new source
    // is active. The guard `_fileSource !== captured` makes the old event a no-op,
    // preventing it from resetting _isPlaying and _pauseOffset on the new playback.
    const captured = this._fileSource;
    this._fileSource.onended = () => {
      if (this._fileSource !== captured) return;   // stale event — ignore
      this._isPlaying   = false;
      this._pauseOffset = 0;
      this._fileSource  = null;
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
    this._ensureOnsetWorklet().then(() => {
      if (this._onsetNode) { try { source.connect(this._onsetNode); } catch (_) {} }
    });
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

  // Optional low-latency onset path: an AudioWorklet detects kick/snare
  // transients on the audio thread and streams the freshest values. If the
  // worklet can't load (older browser, module error) the app silently keeps
  // using the rAF FFT path — nothing downstream depends on it existing.
  async _ensureOnsetWorklet() {
    if (this._onsetNode || this._onsetFailed) return;
    try {
      // Served verbatim from public/ (Vite won't emit a side-effect-only
      // worklet module from src/); base-relative so it resolves under any deploy path
      await this.context.audioWorklet.addModule(import.meta.env.BASE_URL + 'onset-worklet.js');
      this._onsetNode = new AudioWorkletNode(this.context, 'onset-processor');
      this._onsetNode.connect(this.context.destination, 0);   // 0 channels out = silent sink keeps it alive
      this._liveKick = 0; this._liveSnare = 0;
      this._liveKickMax = 0.001; this._liveSnareMax = 0.001;
      this._liveKickBase = 0; this._liveSnareBase = 0;
      this._onsetEvents = [];
      this._evPrevK = 0; this._evPrevS = 0;
      this._evLastK = -1; this._evLastS = -1;
      this._onsetNode.port.onmessage = (e) => {
        const { k, s, t } = e.data;
        this._liveKickMax  = Math.max(this._liveKickMax  * 0.9995, k + 1e-5);
        this._liveSnareMax = Math.max(this._liveSnareMax * 0.9995, s + 1e-5);
        this._liveKickBase  = this._liveKickBase  * 0.98 + (k / this._liveKickMax)  * 0.02;
        this._liveSnareBase = this._liveSnareBase * 0.98 + (s / this._liveSnareMax) * 0.02;
        const kn = Math.max(0, k / this._liveKickMax  - this._liveKickBase)  * 6;
        const sn = Math.max(0, s / this._liveSnareMax - this._liveSnareBase) * 6;
        // peak-hold with fast decay — the main loop reads the latest peak
        this._liveKick  = Math.max(Math.min(kn, 1), this._liveKick  * 0.6);
        this._liveSnare = Math.max(Math.min(sn, 1), this._liveSnare * 0.6);
        // Discrete onset EVENTS stamped with the block's audio-clock time —
        // the beat tracker votes phase at the true hit instant instead of the
        // frame instant (up to a frame + FFT window late). Rising edge with a
        // refractory period; thresholds sit high so only solid hits anchor.
        if (kn > 0.45 && this._evPrevK <= 0.45 && t - this._evLastK > 0.10) {
          this._evLastK = t;
          this._onsetEvents.push({ t, kick: Math.min(kn, 1), snare: 0 });
          if (this._onsetEvents.length > 64) this._onsetEvents.shift();
        }
        if (sn > 0.5 && this._evPrevS <= 0.5 && t - this._evLastS > 0.10) {
          this._evLastS = t;
          this._onsetEvents.push({ t, kick: 0, snare: Math.min(sn, 1) });
          if (this._onsetEvents.length > 64) this._onsetEvents.shift();
        }
        this._evPrevK = kn;
        this._evPrevS = sn;
      };
      this.hasLiveOnset = true;
    } catch (e) {
      this._onsetFailed = true;
      console.warn('onset worklet unavailable, using FFT path:', e.message);
    }
  }

  // Worklet onset events converted to "seconds ago as HEARD by the user".
  // File playback: the worklet sees samples outputLatency before the speakers
  // do, so that lag is subtracted. Captured system audio: the capture delay is
  // unknowable here — the Sync ms slider covers that residual.
  drainOnsetEvents() {
    const q = this._onsetEvents;
    if (!q || q.length === 0) return [];
    this._onsetEvents = [];
    const now = this.context.currentTime;
    const oL  = this._fileSource ? (this.context.outputLatency || 0) : 0;
    for (const ev of q) ev.ago = Math.max(0, now - ev.t - oL);
    return q;
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

    const R = this.ranges;
    const raw = {
      subBass:     this._avg(R.subBass[0],  R.subBass[1],  binHz),
      bass:        this._avg(R.bass[0],     R.bass[1],     binHz),
      mid:         this._avg(R.mid[0],      R.mid[1],      binHz),
      high:        this._avg(R.high[0],     R.high[1],     binHz),
      kickRaw:     this._avg(R.kick[0],     R.kick[1],     binHz),
      kickHarmRaw: this._avg(R.kickHarm[0], R.kickHarm[1], binHz),
      snareRaw:    this._avg(R.snare[0],    R.snare[1],    binHz),
    };

    const energy = (raw.subBass + raw.bass + raw.mid + raw.high) / 4;
    this._maxEnergy = Math.max(this._maxEnergy * 0.998, energy + 0.001);

    // Per-band AGC: ceiling follows each band's own peaks (~8 s memory),
    // floor follows its quiet level (fast down, slow up), output spans the
    // range between them. Quiet masters and loud masters land the same.
    const agcNorm = (name, v) => {
      const a = this._agc[name];
      a.max = Math.max(a.max * 0.9985, v + 0.001);
      if (v < a.floor) a.floor = a.floor * 0.9 + v * 0.1;
      else             a.floor = Math.min(a.floor + (v - a.floor) * 0.0012, a.max * 0.5);
      if (a.max < 0.03) return 0;                       // silence: don't amplify noise
      return Math.min(Math.max((v - a.floor) / Math.max(a.max - a.floor, 0.02), 0), 1) * 0.92;
    };

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

    // Prefer the audio-thread onset when available: it leads the FFT path by
    // ~1-2 frames, so drum-driven visuals and beat phase land on the hit.
    // Blend rather than replace — the FFT path carries the harmonic-gated
    // kick score that rejects bass notes, which the raw band filter can't.
    if (this.hasLiveOnset) {
      this._kick  = Math.max(this._kick,  this._liveKick  * (0.5 + kickScore * 0.5));
      this._snare = Math.max(this._snare, this._liveSnare * 0.9);
    }

    const kickGate  = 1.0 - this._kick  * 0.85;
    const snareGate = 1.0 - this._snare * 0.70;

    const nSubBass = agcNorm('subBass', raw.subBass) * kickGate;
    const nBass    = agcNorm('bass',    raw.bass)    * kickGate;
    const nMid     = agcNorm('mid',     raw.mid)     * snareGate;
    const nHigh    = agcNorm('high',    raw.high);

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

    // ── Spectral flux: positive spectral change per frame (novelty) ─────
    // Catches texture changes that loudness misses — a new synth entering,
    // a filter opening, the mix transforming at a drop.
    {
      if (!this._prevSpec) this._prevSpec = new Float32Array(this.dataArray.length);
      let flux = 0;
      for (let i = 2; i < this.dataArray.length; i++) {
        const v = this.dataArray[i] / 255;
        const d = v - this._prevSpec[i];
        if (d > 0) flux += d;
        this._prevSpec[i] = v;
      }
      this._fluxMax = Math.max((this._fluxMax ?? 0.1) * 0.998, flux + 0.01);
      this.flux = Math.min(flux / this._fluxMax, 1);
    }

    // ── Timbre sharpness: spectral centroid of the tonal range ──────────
    // A saw wave spreads energy up its 1/n harmonic series → high centroid;
    // a sine keeps it at the fundamental → low. Robustness against the mix:
    //  · amplitude-SQUARED weighting — synth harmonics are tall peaks, hat/
    //    noise energy is spread thin per bin, so squaring buries the noise
    //  · percussive gate — frames during kick/snare transients barely count
    //  · slow symmetric smoothing — 30 ms hat frames can't yank the value
    {
      let num = 0, den = 0;
      const lo = Math.max(2, Math.floor(150 / binHz));
      const hi = Math.min(Math.ceil(5000 / binHz), this.dataArray.length - 1);
      for (let i = lo; i <= hi; i++) {
        const v = this.dataArray[i] / 255;
        num += v * v * i * binHz;
        den += v * v;
      }
      const gate = 1 - Math.min(1, (this._kick + this._snare) * 1.5);
      if (den > 0.05 && gate > 0.2) {
        const centroid = num / den;
        const raw = Math.min(1, Math.max(0, Math.log2(centroid / 260) / 2.2));
        this.sharpness += (raw - this.sharpness) * 0.06 * gate;
      }
    }

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
      flux:    this.flux ?? 0,
    };
    return this.bands;
  }

  // Genre presets override band frequency ranges; null restores defaults.
  // Normalization state resets so old maxima from other ranges don't linger.
  setBandRanges(ranges) {
    this.ranges = { ...DEFAULT_RANGES, ...(ranges ?? {}) };
    this._kickBandMax = this._kickHarmMax = this._snareBandMax = 0.001;
    this._maxEnergy = 0.001;
    for (const a of Object.values(this._agc)) { a.max = 0.05; a.floor = 0; }
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
