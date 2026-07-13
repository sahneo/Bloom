import shaderSource from '../shaders/prism.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

// PRISM — liquid chrome glass metaballs. Bass fuses the droplets into one
// molten mass, quiet passages let them drift apart, drops SHATTER them
// outward (spring pulls them home). See prism.wgsl.

const N = 5;

export class PrismPreset {
  constructor() {
    this.frameCount = 0;
    this._params = null;
    this._extra = new Float32Array(32);
    this._seed = Math.random() * 100;
    this._bassEma = 0.3;
    this._kickEnv = 0;
    this._prevKick = 0;
    this._prevDrop = 0;
    // shatter velocities per ball
    this._vel = Array.from({ length: N }, () => ({ x: 0, y: 0, z: 0 }));
    this._off = Array.from({ length: N }, () => ({ x: 0, y: 0, z: 0 }));
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;
    const module = device.createShaderModule({ label: 'prism', code: shaderSource });
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

    const kBass = 1 - Math.exp(-dt / 0.8);
    this._bassEma += ((bands.bass ?? 0) - this._bassEma) * kBass;

    const kick = bands.kick ?? 0;
    if (kick > 0.45 && this._prevKick <= 0.45) this._kickEnv = Math.min(0.5 + kick * 0.8, 1.4);
    this._prevKick = kick;
    this._kickEnv *= Math.exp(-dt * 7);
    const snare = bands.snare ?? 0;
    if (snare > 0.5 && (this._prevSnare ?? 0) <= 0.5) this._snareEnv = Math.min(0.5 + snare * 0.7, 1.2);
    this._prevSnare = snare;
    this._snareEnv = (this._snareEnv ?? 0) * Math.exp(-dt * 5);

    // drop → shatter: radial impulse, spring home over ~2s
    const drop = params.dropPulse ?? 0;
    if (drop > 0.5 && this._prevDrop <= 0.5) {
      for (const v of this._vel) {
        const a = Math.random() * Math.PI * 2;
        const e = Math.random() * Math.PI - Math.PI / 2;
        const s = 3.5 + Math.random() * 2;
        v.x += Math.cos(a) * Math.cos(e) * s;
        v.y += Math.sin(e) * s;
        v.z += Math.sin(a) * Math.cos(e) * s * 0.5;
      }
    }
    this._prevDrop = drop;

    // bass fuses the mass: high bass → tight cluster, quiet → drifting drops
    const spread = 1.05 - this._bassEma * 0.55;
    const e = this._extra;
    for (let i = 0; i < N; i++) {
      const s = this._seed + i * 17.3;
      const O = this._off[i], V = this._vel[i];
      // shatter physics: integrate impulse, spring back, damp
      O.x += V.x * dt; O.y += V.y * dt; O.z += V.z * dt;
      const spring = 6.0, damp = Math.exp(-dt * 3.2);
      V.x = (V.x - O.x * spring * dt) * damp;
      V.y = (V.y - O.y * spring * dt) * damp;
      V.z = (V.z - O.z * spring * dt) * damp;

      e[i * 4]     = Math.sin(t * (0.11 + i * 0.023) + s) * 0.72 * spread + O.x;
      e[i * 4 + 1] = Math.cos(t * (0.09 + i * 0.031) + s * 1.7) * 0.55 * spread + O.y;
      e[i * 4 + 2] = Math.sin(t * (0.07 + i * 0.027) + s * 0.6) * 0.45 * spread + O.z;
      e[i * 4 + 3] = 0.34 + (i % 3) * 0.10 + (bands.subBass ?? 0) * 0.10;
    }
    e[24] = this._snareEnv ?? 0;                        // strip-bank flash
    e[25] = (params.prismClassic ?? false) ? 1 : 0;     // classic minimal env
    e[28] = this._kickEnv;                              // key-light flare
    e[29] = 0.5 + (params.dissonance ?? 0) * 0.7;       // iridescence amount
    e[30] = bands.mid ?? 0;
    e[31] = bands.high ?? 0;

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
