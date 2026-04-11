export class AudioAnalyser {
  constructor() {
    this.context = null;
    this.analyser = null;
    this.dataArray = null;
    this.bands = { subBass: 0, bass: 0, mid: 0, high: 0 };
    this._smoothed = { subBass: 0, bass: 0, mid: 0, high: 0 };
    this._maxEnergy = 0.001;
    this._fileSource = null;
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
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await this.context.decodeAudioData(arrayBuffer);

    if (this._fileSource) {
      this._fileSource.stop();
      this._fileSource.disconnect();
    }

    this._ensureAnalyser();

    this._fileSource = this.context.createBufferSource();
    this._fileSource.buffer = audioBuffer;
    this._fileSource.loop = true;
    this._fileSource.connect(this.analyser);
    this.analyser.connect(this.context.destination);
    this._fileSource.start();
  }

  _connectStream(stream) {
    this._ensureContext();
    this._ensureAnalyser();
    const source = this.context.createMediaStreamSource(stream);
    source.connect(this.analyser);
  }

  _ensureContext() {
    if (!this.context) this.context = new AudioContext();
  }

  _ensureAnalyser() {
    if (this.analyser) return;
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.75;
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
  }

  update() {
    if (!this.analyser) return this.bands;

    this.analyser.getByteFrequencyData(this.dataArray);

    const binHz = this.context.sampleRate / this.analyser.fftSize;

    const raw = {
      subBass: this._avgRange(20, 80, binHz),
      bass:    this._avgRange(80, 250, binHz),
      mid:     this._avgRange(250, 2000, binHz),
      high:    this._avgRange(2000, 16000, binHz),
    };

    // AGC: normalize against running peak so any volume level looks good
    const energy = (raw.subBass + raw.bass + raw.mid + raw.high) / 4;
    this._maxEnergy = Math.max(this._maxEnergy * 0.998, energy + 0.001);
    const gain = 1.0 / this._maxEnergy;

    // Per-band smoothing (different rates for different bands)
    const smoothBass = 0.80;
    const smoothHigh = 0.65;
    this._smoothed.subBass = this._smoothed.subBass * smoothBass + Math.min(raw.subBass * gain, 1) * (1 - smoothBass);
    this._smoothed.bass    = this._smoothed.bass    * smoothBass + Math.min(raw.bass    * gain, 1) * (1 - smoothBass);
    this._smoothed.mid     = this._smoothed.mid     * 0.72      + Math.min(raw.mid     * gain, 1) * 0.28;
    this._smoothed.high    = this._smoothed.high    * smoothHigh + Math.min(raw.high   * gain, 1) * (1 - smoothHigh);

    this.bands = { ...this._smoothed };
    return this.bands;
  }

  _avgRange(minHz, maxHz, binHz) {
    const lo = Math.floor(minHz / binHz);
    const hi = Math.min(Math.ceil(maxHz / binHz), this.dataArray.length - 1);
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += this.dataArray[i] / 255;
    return sum / (hi - lo + 1);
  }
}
