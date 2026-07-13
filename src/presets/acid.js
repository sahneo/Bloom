import shaderSource from '../shaders/acid.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

// ACID — gradient-noise engine. Five looks rotate in epochs (and on
// drops); four wobbly blobs drive every look's gradient field. Heavy
// film grain everywhere — that's the identity.

// look-paired palettes from the moodboard [colA, colB, bg] (linear-ish RGB)
const LOOKS = [
  { name: 'acid',    A: [0.72, 1.00, 0.13], B: [0.36, 0.27, 0.80], bg: [0.135, 0.115, 0.185], grain: 0.42 },
  { name: 'uv',      A: [0.46, 0.34, 1.00], B: [0.15, 0.36, 1.00], bg: [0.015, 0.008, 0.030], grain: 0.38 },
  { name: 'thermal', A: [1, 1, 1],          B: [1, 1, 1],          bg: [0.02, 0.03, 0.10],    grain: 0.30 },
  { name: 'veins',   A: [0.16, 0.52, 1.00], B: [0.55, 0.80, 1.00], bg: [0.030, 0.034, 0.045], grain: 0.45 },
  { name: 'ink',     A: [0.93, 0.90, 0.83], B: [0.6, 0.6, 0.55],   bg: [0.008, 0.008, 0.008], grain: 0.34 },
];

const BANDS_ = ['bass', 'mid', 'subBass', 'high'];

export class AcidPreset {
  constructor() {
    this.frameCount = 0;
    this._params = null;
    this._extra = new Float32Array(64);
    this._seed = Math.random() * 100;
    this._look = (Math.random() * LOOKS.length) | 0;
    this._epochT = 0;
    this._epochLen = 30;
    this._prevDrop = 0;
    this._prevKick = 0;
    this._kickEnv = 0;
    this._orbit = Math.random() < 0.5;
    this._pos = [0, 1, 2, 3].map(() => ({ x: 0, y: 0 }));
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;
    const module = device.createShaderModule({ label: 'acid', code: shaderSource });
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex:   { module, entryPoint: 'vs_fullscreen' },
      fragment: { module, entryPoint: 'fs_render', targets: [{ format: ACCUM_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });
    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
    this.post = new PostFX();
    this.post.init(device, format, canvas);
  }

  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._params = params;
    const dt = Math.min(deltaMs * 0.001, 0.05);
    const t  = timeMs * 0.001;
    const aspect = this.canvas.width / Math.max(this.canvas.height, 1);

    // look epochs; drops jump to a new look immediately
    const drop = params.dropPulse ?? 0;
    this._epochT += dt;
    if (this._epochT > this._epochLen || (drop > 0.5 && this._prevDrop <= 0.5)) {
      this._epochT = 0;
      this._epochLen = 24 + Math.random() * 20;
      this._look = (this._look + 1 + ((Math.random() * (LOOKS.length - 1)) | 0)) % LOOKS.length;
      this._orbit = Math.random() < 0.4;
    }
    this._prevDrop = drop;

    const kick = bands.kick ?? 0;
    if (kick > 0.45 && this._prevKick <= 0.45) this._kickEnv = Math.min(0.5 + kick * 0.8, 1.4);
    this._prevKick = kick;
    this._kickEnv *= Math.exp(-dt * 6);

    const look = LOOKS[this._look];
    const ease = 1 - Math.exp(-dt * 0.6);
    const e = this._extra;
    for (let i = 0; i < 4; i++) {
      const s = this._seed + i * 11.3;
      let tx, ty;
      if (this._orbit) {
        const a = t * (0.05 + i * 0.023) + s;
        const r = 0.35 + i * 0.16;
        tx = Math.cos(a) * r * aspect * 0.7;
        ty = Math.sin(a) * r;
      } else {
        tx = Math.sin(t * (0.045 + i * 0.017) + s) * 0.6 * aspect;
        ty = Math.cos(t * (0.038 + i * 0.021) + s * 1.7) * 0.55;
      }
      const P = this._pos[i];
      P.x += (tx - P.x) * ease;
      P.y += (ty - P.y) * ease;
      const level = bands[BANDS_[i]] ?? 0;
      e[i * 4]     = P.x;
      e[i * 4 + 1] = P.y;
      e[i * 4 + 2] = (0.45 + i * 0.14) * (1 + level * 0.35 + (params.tension ?? 0) * 0.2);
      e[i * 4 + 3] = 0.35 + level * 0.75 + drop * 0.5;
    }
    e[28] = this._look;
    e[29] = look.grain;
    e[30] = this._kickEnv;
    for (let k = 0; k < 3; k++) {
      e[32 + k] = look.A[k];
      e[36 + k] = look.B[k];
      e[40 + k] = look.bg[k];
    }

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
    this.post?.destroy();
  }
}
