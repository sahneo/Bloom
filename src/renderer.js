export class Renderer {
  constructor(canvas) {
    this.canvas   = canvas;
    this.device   = null;
    this.context  = null;
    this.format   = null;
    this.preset   = null;
    this._lastTs  = null;
    this.webgpu   = false;   // false → only self-presenting presets (STAGE on WebGL2) can run
  }

  async init() {
    if (!navigator.gpu) throw new Error('WebGPU not supported. Use Chrome 113+.');

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter found.');

    this.device  = await adapter.requestDevice();
    // Surface silent validation failures — headless Chrome doesn't always
    // print these to the console on its own
    this.device.addEventListener('uncapturederror', (e) => {
      console.error('[WebGPU]', e.error?.message ?? e.error);
    });
    this.context = this.canvas.getContext('webgpu');
    this.format  = navigator.gpu.getPreferredCanvasFormat();
    this._configure();
    this.webgpu = true;
  }

  _configure() {
    this.context.configure({
      device:    this.device,
      format:    this.format,
      alphaMode: 'opaque',
    });
  }

  async loadPreset(PresetClass) {
    const wasSelf = this.preset?.selfPresent;
    if (this.preset?.destroy) this.preset.destroy();
    this.preset  = null;
    // a self-presenting preset (Three.js STAGE) reconfigured the shared
    // canvas context — hand it back to the raw-WebGPU presets
    if (wasSelf && this.webgpu && !PresetClass.prototype.selfPresent) this._configure();
    const preset = new PresetClass();
    this._lastTs = null;
    await preset.init(this.device, this.format, this.canvas);
    this.preset = preset;
  }

  render(timeMs, bands, params) {
    const delta  = this._lastTs === null ? 16.67 : timeMs - this._lastTs;
    this._lastTs = timeMs;
    if (!this.preset) return;
    this.preset.tick(this.device, bands, timeMs, delta, params);
    if (this.preset.selfPresent) { this.preset.draw(); return; }
    this.preset.draw(this.device, this.context.getCurrentTexture().createView());
  }
}
