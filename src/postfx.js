import postSource from './shaders/postfx.wgsl?raw';

// Shared HDR post chain: trails (fade) → bloom → camera/kaleido composite.
// Presets render additively into `accumView` between beginFrame() and finish().
export const ACCUM_FORMAT = 'rgba16float';

export class PostFX {
  constructor() {
    this._w = 0;
    this._h = 0;
  }

  init(device, canvasFormat, canvas) {
    this.device = device;
    this.canvas = canvas;

    const module = device.createShaderModule({ label: 'postfx', code: postSource });

    this._sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this._paramsBuf = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const pipeline = (entryPoint, format, blend) => device.createRenderPipeline({
      layout: 'auto',
      vertex:   { module, entryPoint: 'vs_fullscreen' },
      fragment: { module, entryPoint, targets: [{ format, blend }] },
      primitive: { topology: 'triangle-list' },
    });

    this.fadePipeline = pipeline('fs_fade', ACCUM_FORMAT, {
      color: { srcFactor: 'zero', dstFactor: 'constant', operation: 'add' },
      alpha: { srcFactor: 'zero', dstFactor: 'constant', operation: 'add' },
    });
    this.brightPipeline    = pipeline('fs_bright',    ACCUM_FORMAT);
    this.blurHPipeline     = pipeline('fs_blur_h',    ACCUM_FORMAT);
    this.blurVPipeline     = pipeline('fs_blur_v',    ACCUM_FORMAT);
    this.compositePipeline = pipeline('fs_composite', canvasFormat);
  }

  // (Re)create offscreen targets when the canvas size changes
  ensureTargets() {
    const w = this.canvas.width, h = this.canvas.height;
    if (this._w === w && this._h === h) return;
    this._w = w;
    this._h = h;
    const device = this.device;

    for (const t of [this.accumTex, this.bloomTexA, this.bloomTexB]) t?.destroy();

    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.accumTex = device.createTexture({ size: [w, h], format: ACCUM_FORMAT, usage });
    // 1/8 res: the gaussian is the priciest pass, and bloom is low-frequency
    // by definition — the extra downsample is invisible but 4× cheaper
    const bw = Math.max(1, w >> 3), bh = Math.max(1, h >> 3);
    this.bloomTexA = device.createTexture({ size: [bw, bh], format: ACCUM_FORMAT, usage });
    this.bloomTexB = device.createTexture({ size: [bw, bh], format: ACCUM_FORMAT, usage });

    this.accumView  = this.accumTex.createView();
    this.bloomViewA = this.bloomTexA.createView();
    this.bloomViewB = this.bloomTexB.createView();

    const bg = (pipeline, entries) => device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries,
    });
    this.brightBG = bg(this.brightPipeline, [
      { binding: 0, resource: this._sampler },
      { binding: 1, resource: this.accumView },
    ]);
    this.blurHBG = bg(this.blurHPipeline, [
      { binding: 0, resource: this._sampler },
      { binding: 1, resource: this.bloomViewA },
    ]);
    this.blurVBG = bg(this.blurVPipeline, [
      { binding: 0, resource: this._sampler },
      { binding: 1, resource: this.bloomViewB },
    ]);
    this.compositeBG = bg(this.compositePipeline, [
      { binding: 0, resource: this._sampler },
      { binding: 1, resource: this.accumView },
      { binding: 2, resource: this.bloomViewA },
      { binding: 3, resource: { buffer: this._paramsBuf } },
    ]);
  }

  // Effective trail length: user slider + AutoVJ section bias
  static effTrail(params) {
    return Math.min(1, Math.max(0, (params?.trail ?? 0.5) + (params?.trailBias ?? 0)));
  }

  // Trail retention this frame + the brightness gain that compensates it
  static trailFactors(params, dtMs) {
    const trail = PostFX.effTrail(params);
    const r60   = trail <= 0.005 ? 0 : 0.72 + 0.26 * trail;
    return {
      fade: Math.pow(r60, (dtMs ?? 16.67) / 16.67),
      gain: Math.pow(1 - r60, 0.7) * 0.9 + 0.1,
    };
  }

  // Pass 1: fade the accumulation buffer (leaves trails)
  fadePass(enc, fade) {
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.accumView, loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(this.fadePipeline);
    pass.setBlendConstant({ r: fade, g: fade, b: fade, a: fade });
    pass.draw(3);
    pass.end();
  }

  // Passes 3-4: bloom chain + camera/kaleido composite to the canvas
  finish(enc, view, params) {
    this.device.queue.writeBuffer(this._paramsBuf, 0, new Float32Array([
      (params?.glow ?? 1) * 0.85,
      1.05,
      params?.kaleidoK ?? 0,
      params?.camZoom  ?? 1,
      params?.camRot   ?? 0,
      this.canvas.width / this.canvas.height,
      0, 0,
    ]));

    const fullPass = (pipeline, bindGroup, targetView) => {
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: targetView, loadOp: 'clear', storeOp: 'store' }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
    };
    fullPass(this.brightPipeline,    this.brightBG,    this.bloomViewA);
    fullPass(this.blurHPipeline,     this.blurHBG,     this.bloomViewB);
    fullPass(this.blurVPipeline,     this.blurVBG,     this.bloomViewA);
    fullPass(this.compositePipeline, this.compositeBG, view);
  }

  destroy() {
    for (const t of [this.accumTex, this.bloomTexA, this.bloomTexB]) t?.destroy();
    this._w = this._h = 0;
  }
}
