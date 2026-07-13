import shaderSource from '../shaders/glass.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

// GLASS — coloured lights behind a wall of frosted glass blocks.
// 8 JS-side lights, each bound to a band; positions drift on
// incommensurate sines, flashes decay dt-scaled. See glass.wgsl.

// band → light binding: depth (0 far … 1 near), hue offset from the key,
// drift speed, base size
// Moodboard palette logic: large organic blobs, mostly analogous hues with
// one complementary accent — foliage-behind-glass, not disco
const LIGHTS = [
  { band: 'kick',    depth: 0.85, hueOff: 0.02,  speed: 0.07, size: 0.60 },
  { band: 'snare',   depth: 0.65, hueOff: 0.50,  speed: 0.09, size: 0.45 },
  { band: 'bass',    depth: 0.25, hueOff: 0.07,  speed: 0.035, size: 0.95 },
  { band: 'subBass', depth: 0.10, hueOff: -0.05, speed: 0.022, size: 1.15 },
  { band: 'mid',     depth: 0.55, hueOff: 0.12,  speed: 0.12, size: 0.55 },
  { band: 'mid',     depth: 0.45, hueOff: -0.10, speed: 0.14, size: 0.50 },
  { band: 'high',    depth: 0.75, hueOff: 0.18,  speed: 0.18, size: 0.32 },
  { band: 'high',    depth: 0.90, hueOff: -0.15, speed: 0.21, size: 0.26 },
];

export class GlassPreset {
  constructor() {
    this.frameCount = 0;
    this._params = null;
    this._flash = LIGHTS.map(() => 0);
    this._prevKick = 0;
    this._prevSnare = 0;
    this._bassEma = 0;
    this._seed = Math.random() * 100;
    this._extra = new Float32Array(64);
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;
    const module = device.createShaderModule({ label: 'glass', code: shaderSource });
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex:   { module, entryPoint: 'vs_fullscreen' },
      fragment: {
        module,
        entryPoint: 'fs_render',
        targets: [{
          format: ACCUM_FORMAT,
          blend: {   // alpha = motion-blur persistence (Trail slider)
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
          },
        }],
      },
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

    const kBass = 1 - Math.exp(-dt / 0.6);
    this._bassEma += ((bands.bass ?? 0) - this._bassEma) * kBass;

    // transient flashes, dt-decayed
    const kick = bands.kick ?? 0, snare = bands.snare ?? 0;
    if (kick > 0.45 && this._prevKick <= 0.45) this._flash[0] = Math.min(0.6 + kick, 1.6);
    if (snare > 0.5 && this._prevSnare <= 0.5) this._flash[1] = Math.min(0.5 + snare, 1.4);
    this._prevKick = kick; this._prevSnare = snare;
    const drop = params.dropPulse ?? 0;
    for (let i = 0; i < 8; i++) {
      this._flash[i] = Math.max(this._flash[i] * Math.exp(-dt * 5.5), drop * 1.3);
    }

    // light positions + brightness
    const e = this._extra;
    for (let i = 0; i < 8; i++) {
      const L = LIGHTS[i];
      const s = this._seed + i * 13.7;
      const w = t * L.speed;
      const x = Math.sin(w * 1.00 + s) * 0.62 * aspect + Math.sin(w * 0.37 + s * 2.1) * 0.25;
      const y = Math.cos(w * 0.83 + s * 1.7) * 0.58 + Math.sin(w * 0.29 + s * 0.6) * 0.22;
      const level = bands[L.band] ?? 0;
      const bright = 0.04 + level * 0.50 + this._flash[i] * 0.6
                   + (L.band === 'bass' ? this._bassEma * 0.25 : 0);
      e[i * 4]     = x;
      e[i * 4 + 1] = y;
      e[i * 4 + 2] = L.depth;
      e[i * 4 + 3] = bright;
      e[32 + i * 4]     = (params.keyHue ?? 0) + L.hueOff;
      e[32 + i * 4 + 1] = 0.72;
      e[32 + i * 4 + 2] = L.size;
    }

    const alpha = 1 - 0.6 * PostFX.effTrail(params);
    const u = buildUniforms(bands, timeMs, deltaMs, params, this.canvas, this.frameCount, alpha);
    u[41] = 1 + drop * 0.9;      // _r1: refraction — drops ripple the glass
    u[42] = this._bassEma;       // _r2: global breath
    device.queue.writeBuffer(this.uniformBuffer, 0, u);
    device.queue.writeBuffer(this.uniformBuffer, RIPPLE_OFFSET, e);
  }

  draw(device, view) {
    this.post.ensureTargets();
    const enc = device.createCommandEncoder();
    this.post.fadePass(enc, 1, this._params);   // alpha does the decay
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
