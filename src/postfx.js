import postSource from './shaders/postfx.wgsl?raw';

// Shared HDR post chain: echo/feedback trails → bloom → nebula/camera/kaleido
// composite with aberration, grain, and drop flavours (flash/invert).
// Accumulation is ping-ponged: the echo pass warps last frame's buffer into
// the other one (feedback zoom = infinite tunnel), then geometry renders on top.
export const ACCUM_FORMAT = 'rgba16float';

export class PostFX {
  constructor() {
    this._w = 0;
    this._h = 0;
    this._ping = 0;
  }

  init(device, canvasFormat, canvas) {
    this.device = device;
    this.canvas = canvas;

    const module = device.createShaderModule({ label: 'postfx', code: postSource });

    this._sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this._paramsBuf = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._echoBuf = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const pipeline = (entryPoint, format) => device.createRenderPipeline({
      layout: 'auto',
      vertex:   { module, entryPoint: 'vs_fullscreen' },
      fragment: { module, entryPoint, targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });

    this.echoPipeline      = pipeline('fs_echo',      ACCUM_FORMAT);
    this.brightPipeline    = pipeline('fs_bright',    ACCUM_FORMAT);
    this.blurHPipeline     = pipeline('fs_blur_h',    ACCUM_FORMAT);
    this.blurVPipeline     = pipeline('fs_blur_v',    ACCUM_FORMAT);
    this.compositePipeline = pipeline('fs_composite', canvasFormat);
  }

  ensureTargets() {
    const w = this.canvas.width, h = this.canvas.height;
    if (this._w === w && this._h === h) return;
    this._w = w;
    this._h = h;
    const device = this.device;

    for (const t of [...(this.accumTex ?? []), this.bloomTexA, this.bloomTexB]) t?.destroy();

    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.accumTex  = [0, 1].map(() => device.createTexture({ size: [w, h], format: ACCUM_FORMAT, usage }));
    this.accumViews = this.accumTex.map(t => t.createView());
    const bw = Math.max(1, w >> 3), bh = Math.max(1, h >> 3);
    this.bloomTexA = device.createTexture({ size: [bw, bh], format: ACCUM_FORMAT, usage });
    this.bloomTexB = device.createTexture({ size: [bw, bh], format: ACCUM_FORMAT, usage });
    this.bloomViewA = this.bloomTexA.createView();
    this.bloomViewB = this.bloomTexB.createView();

    const bg = (pipeline, entries) => device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries,
    });
    // Per-accum-buffer bind groups (index = which accum is being READ)
    this.echoBG = this.accumViews.map(v => bg(this.echoPipeline, [
      { binding: 0, resource: this._sampler },
      { binding: 1, resource: v },
      { binding: 4, resource: { buffer: this._echoBuf } },
    ]));
    this.brightBG = this.accumViews.map(v => bg(this.brightPipeline, [
      { binding: 0, resource: this._sampler },
      { binding: 1, resource: v },
    ]));
    this.compositeBG = this.accumViews.map(v => bg(this.compositePipeline, [
      { binding: 0, resource: this._sampler },
      { binding: 1, resource: v },
      { binding: 2, resource: this.bloomViewA },
      { binding: 3, resource: { buffer: this._paramsBuf } },
    ]));
    this.blurHBG = bg(this.blurHPipeline, [
      { binding: 0, resource: this._sampler },
      { binding: 1, resource: this.bloomViewA },
    ]);
    this.blurVBG = bg(this.blurVPipeline, [
      { binding: 0, resource: this._sampler },
      { binding: 1, resource: this.bloomViewB },
    ]);
  }

  // Current accumulation target — presets render their geometry into this
  get accumView() { return this.accumViews[this._ping]; }

  static effTrail(params) {
    return Math.min(1, Math.max(0, (params?.trail ?? 0.5) + (params?.trailBias ?? 0)));
  }

  static trailFactors(params, dtMs) {
    const trail = PostFX.effTrail(params);
    const r60   = trail <= 0.005 ? 0 : 0.72 + 0.26 * trail;
    return {
      fade: Math.pow(r60, (dtMs ?? 16.67) / 16.67),
      gain: Math.pow(1 - r60, 0.7) * 0.9 + 0.1,
    };
  }

  // Pass 1: echo/feedback — warp + damp last frame's accum into the other
  // buffer. echoZoom/echoRot are per-frame steps (1/0 = classic static trails).
  fadePass(enc, fade, params) {
    const dtN = 1;   // steps are already frame-rate corrected by caller
    const src = this._ping;
    const dst = 1 - src;
    this.device.queue.writeBuffer(this._echoBuf, 0, new Float32Array([
      fade,
      params?.echoZoom ?? 1,
      params?.echoRot  ?? 0,
      this.canvas.width / this.canvas.height,
    ]));
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.accumViews[dst], loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(this.echoPipeline);
    pass.setBindGroup(0, this.echoBG[src]);
    pass.draw(3);
    pass.end();
    this._ping = dst;
  }

  finish(enc, view, params) {
    this.device.queue.writeBuffer(this._paramsBuf, 0, new Float32Array([
      (params?.glow ?? 1) * 0.85,
      1.05,
      params?.kaleidoK ?? 0,
      params?.camZoom  ?? 1,
      params?.camRot   ?? 0,
      this.canvas.width / this.canvas.height,
      (params?.timeS ?? 0),
      params?.keyHue  ?? 0,
      params?.keyConf ?? 0,
      params?.tonality ?? 0,
      params?.subBassLevel ?? 0,
      0.4 + (params?.dissonance ?? 0) * (params?.dissonanceStrength ?? 1) * 1.6
          + (params?.dropPulse ?? 0) * 2.5,          // aberration
      0.035,                                          // grain
      params?.dropFlash  ?? 0,
      params?.dropInvert ?? 0,
      params?.anamorphic ?? 0.2,
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
    fullPass(this.brightPipeline,    this.brightBG[this._ping], this.bloomViewA);
    fullPass(this.blurHPipeline,     this.blurHBG,              this.bloomViewB);
    fullPass(this.blurVPipeline,     this.blurVBG,              this.bloomViewA);
    fullPass(this.compositePipeline, this.compositeBG[this._ping], view);
  }

  destroy() {
    for (const t of [...(this.accumTex ?? []), this.bloomTexA, this.bloomTexB]) t?.destroy();
    this._w = this._h = 0;
  }
}
