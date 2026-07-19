import { PostFX } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE } from './uniforms.js';

// KINO — kinotype.xyz-style moving typographic graphics (stub).
// Per-mode dial sets, rendered by main.js into #kn-dials (FX_DIALS pattern).
export const KINO_DIALS = [
  /* halftone  */ [['Cell', 0.5], ['Contrast', 0.5], ['Jitter', 0.3], ['Invert', 0]],
  /* edgeascii */ [['Density', 0.5], ['Edge sens', 0.4], ['Fill', 0.5], ['Invert', 0]],
  /* stipple   */ [['Density', 0.5], ['Dot size', 0.5], ['Breathe', 0.5], ['Invert', 0]],
  /* flowfield */ [['Particles', 0.5], ['Detail', 0.5], ['Speed', 0.5], ['Trail', 0.5]],
  /* scribbles */ [['Pens', 0.5], ['Stroke', 0.5], ['Detail', 0.5], ['Speed', 0.5]],
  /* textflow  */ [['Density', 0.5], ['Threshold', 0.5], ['Size', 0.5], ['Speed', 0.5]],
  /* scatter   */ [['Grid', 0.5], ['Coverage', 0.4], ['Drift', 0.4], ['Size', 0.5]],
  /* pixelsort */ [['Resolution', 0.5], ['Threshold', 0.5], ['Sweep', 0.5], ['Vertical', 0]],
];

export class KinoPreset {
  constructor() { this.frameCount = 0; this._params = null; }
  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.post = new PostFX();
    this.post.init(device, format, canvas);
  }
  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._params = params;
    const u = buildUniforms(bands, timeMs, deltaMs, params, this.canvas, this.frameCount, 1);
    device.queue.writeBuffer(this.uniformBuffer, 0, u);
  }
  draw(device, view) {
    this.post.ensureTargets();
    const enc = device.createCommandEncoder();
    this.post.fadePass(enc, 0, this._params);
    this.post.finish(enc, view, this._params);
    device.queue.submit([enc.finish()]);
  }
  destroy() { this.post?.destroy(); }
}
