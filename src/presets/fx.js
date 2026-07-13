import shaderSource from '../shaders/fx.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';
import { currentMediaItem, mediaApi } from './dither.js';

// STUDIO — Ladybug-style sound-reactive effects over the shared media
// playlist: ASCII / halftone / duotone / glitch / neon edges, with
// Amount + Scale dials. Drops cut to the next media item and flash-invert.

export class FxPreset {
  constructor() {
    this.frameCount = 0;
    this._params = null;
    this._extra = new Float32Array(64);
    this._texFor = null;
    this._kickEnv = 0; this._snareEnv = 0; this._invert = 0;
    this._prevKick = 0; this._prevSnare = 0; this._prevDrop = 0;
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;
    const module = device.createShaderModule({ label: 'fx', code: shaderSource });
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.mediaTex = this._makeTex(1, 1);
    this._bgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._bgl] }),
      vertex:   { module, entryPoint: 'vs_fullscreen' },
      fragment: { module, entryPoint: 'fs_render', targets: [{ format: ACCUM_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });
    this._rebind();
    this.post = new PostFX();
    this.post.init(device, format, canvas);
  }

  _makeTex(w, h) {
    return this.device.createTexture({
      size: [w, h],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  _rebind() {
    this.bindGroup = this.device.createBindGroup({
      layout: this._bgl,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this._sampler },
        { binding: 2, resource: this.mediaTex.createView() },
      ],
    });
  }

  _updateMedia() {
    const item = currentMediaItem();
    if (!item) return 0;
    if (this._texFor !== item) {
      this.mediaTex.destroy();
      this.mediaTex = this._makeTex(item.w, item.h);
      this._texFor = item;
      this._rebind();
      if (item.kind === 'image') {
        try {
          this.device.queue.copyExternalImageToTexture(
            { source: item.el }, { texture: this.mediaTex }, [item.w, item.h]);
        } catch (_) {}
      }
      if (item.kind === 'video') item.el.play().catch(() => {});
    }
    if (item.kind === 'video' && item.el.readyState >= 2) {
      try {
        this.device.queue.copyExternalImageToTexture(
          { source: item.el }, { texture: this.mediaTex }, [item.w, item.h]);
      } catch (_) {}
    }
    return item.w / item.h;
  }

  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._params = params;
    const dt = Math.min(deltaMs * 0.001, 0.05);

    const texAspect = this._updateMedia();

    const kick = bands.kick ?? 0, snare = bands.snare ?? 0;
    if (kick > 0.45 && this._prevKick <= 0.45) this._kickEnv = Math.min(0.5 + kick * 0.8, 1.4);
    if (snare > 0.5 && this._prevSnare <= 0.5) this._snareEnv = Math.min(0.4 + snare * 0.7, 1.2);
    this._prevKick = kick; this._prevSnare = snare;
    this._kickEnv  *= Math.exp(-dt * 8);
    this._snareEnv *= Math.exp(-dt * 6);
    this._invert   *= Math.exp(-dt * 3);

    const drop = params.dropPulse ?? 0;
    if (drop > 0.5 && this._prevDrop <= 0.5) {
      this._invert = 1;
      const n = mediaApi.list().length;
      if (n > 1) mediaApi.select((mediaApi.index() + 1) % n);
    }
    this._prevDrop = drop;

    const e = this._extra;
    e[28] = params.fxEffect ?? 0;
    e[29] = params.fxAmount ?? 1;
    e[30] = params.fxScale  ?? 0.5;
    e[31] = this._kickEnv;
    e[60] = this._snareEnv;
    e[61] = this._invert;
    e[62] = texAspect || 1.77;
    e[63] = texAspect > 0 ? 1 : 0;

    const u = buildUniforms(bands, timeMs, deltaMs, params, this.canvas, this.frameCount, 1);
    device.queue.writeBuffer(this.uniformBuffer, 0, u);
    device.queue.writeBuffer(this.uniformBuffer, RIPPLE_OFFSET, e);
  }

  draw(device, view) {
    this.post.ensureTargets();
    const enc = device.createCommandEncoder();
    this.post.fadePass(enc, 0, this._params);
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.post.accumView, loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
    pass.end();
    this.post.finish(enc, view, this._params);
    device.queue.submit([enc.finish()]);
  }

  destroy() {
    this.mediaTex?.destroy();
    this.post?.destroy();
  }
}
