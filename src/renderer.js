export class Renderer {
  constructor(canvas) {
    this.canvas   = canvas;
    this.device   = null;
    this.context  = null;
    this.format   = null;
    this.preset   = null;
    this._lastTs  = null;
  }

  async init() {
    if (!navigator.gpu) throw new Error('WebGPU not supported. Use Chrome 113+.');

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter found.');

    this.device  = await adapter.requestDevice();
    this.context = this.canvas.getContext('webgpu');
    this.format  = navigator.gpu.getPreferredCanvasFormat();

    this.context.configure({
      device:    this.device,
      format:    this.format,
      alphaMode: 'opaque',
    });
  }

  async loadPreset(PresetClass) {
    if (this.preset?.destroy) this.preset.destroy();
    this.preset  = new PresetClass();
    this._lastTs = null;
    await this.preset.init(this.device, this.format, this.canvas);
  }

  render(timeMs, bands, params) {
    const delta  = this._lastTs === null ? 16.67 : timeMs - this._lastTs;
    this._lastTs = timeMs;
    if (!this.preset) return;
    this.preset.tick(this.device, bands, timeMs, delta, params);
    this.preset.draw(this.device, this.context.getCurrentTexture().createView());
  }
}
