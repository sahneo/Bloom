import { PostFX } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE } from './uniforms.js';

// MitosisPreset — stub, implementation in progress.

export class MitosisPreset {
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
