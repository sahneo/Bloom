import shaderSource from '../shaders/storm.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

// STORM — flight through a volumetric thunderstorm.
//
// The shader does layered domain-warped FBM clouds; this side owns the
// lightning choreography: transient rising edges (kick / snare) spawn bolts,
// a detected drop fires a wall of 5 simultaneous strikes plus a sky-wide
// flash. Bolts are uploaded through the ripple uniform region as one vec4
// per bolt (x, seed, age, intensity) + extras (slant, width) — the jagged
// path itself is re-generated procedurally in WGSL from the seed.
const MAX_BOLTS = 8;
const BOLT_LIFE = 1.4;     // seconds incl. afterglow; slot reusable after this

export class StormPreset {
  constructor() {
    this.frameCount = 0;
    this._params = null;
    this.bolts = Array.from({ length: MAX_BOLTS }, () => ({
      x: 0, seed: 0, age: BOLT_LIFE + 1, intensity: 0, slant: 0, width: 1,
    }));
    this.boltData = new Float32Array(64);
    this.prevKick = 0;
    this.prevSnare = 0;
    this.prevDrop = 0;
    this.lastKickAt = -1;
    this.lastSnareAt = -1;
    this.skyFlash = 0;   // → _r1: whole-sky discharge glow
    this.energy = 0;     // → _r2: smoothed band energy (cloud churn)
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;
    const module = device.createShaderModule({ label: 'storm', code: shaderSource });
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
          blend: {
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

  // Claim the stalest slot — dead ones first, else the oldest strike.
  _spawn(x, intensity, slant, width) {
    let best = 0;
    let bestAge = -1;
    for (let i = 0; i < MAX_BOLTS; i++) {
      if (this.bolts[i].age > bestAge) { bestAge = this.bolts[i].age; best = i; }
    }
    const b = this.bolts[best];
    b.x = x;
    b.seed = Math.random() * 100;
    b.age = 0;
    b.intensity = intensity;
    b.slant = slant;
    b.width = width;
  }

  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._params = params;
    const dt = Math.min(deltaMs, 50) * 0.001;
    const t = timeMs * 0.001;

    for (const b of this.bolts) b.age += dt;

    const kick  = bands.kick  ?? 0;
    const snare = bands.snare ?? 0;
    const drop  = params.dropPulse ?? 0;

    // Strike choreography: real storms discharge irregularly. Most kicks
    // only light the clouds from inside (sheet lightning); a full visible
    // channel lands every ~1.5–4 s, kept unpredictable by a dice roll.
    if (kick > 0.5 && this.prevKick <= 0.5) {
      const since = t - this.lastKickAt;
      if (since > 1.4 && (Math.random() < 0.4 || since > 4.0)) {
        this.lastKickAt = t;
        this._spawn((Math.random() * 2 - 1) * 0.85,
                    0.65 + kick * 0.4,
                    (Math.random() - 0.5) * 0.55,
                    1.0 + Math.random() * 0.35);
      } else {
        // sheet lightning: soft interior flash, no channel
        this.skyFlash = Math.max(this.skyFlash, 0.10 + kick * 0.14);
      }
    }
    // Snare: occasional thin distant strike, mostly nothing
    if (snare > 0.55 && this.prevSnare <= 0.55 && t - this.lastSnareAt > 2.6 && Math.random() < 0.25) {
      this.lastSnareAt = t;
      this._spawn((Math.random() * 2 - 1) * 0.95,
                  0.40 + snare * 0.3,
                  (Math.random() - 0.5) * 0.8,
                  0.6);
    }
    // Drop: wall of simultaneous discharges + whole-sky flash
    if (drop > 0.6 && this.prevDrop <= 0.6) {
      const n = 5;
      for (let i = 0; i < n; i++) {
        this._spawn(-0.85 + (i / (n - 1)) * 1.7 + (Math.random() - 0.5) * 0.15,
                    0.85 + Math.random() * 0.3,
                    (Math.random() - 0.5) * 0.5,
                    1.1 + Math.random() * 0.3);
      }
      this.skyFlash = 1.0;
    }
    this.prevKick = kick;
    this.prevSnare = snare;
    this.prevDrop = drop;

    // dt-scaled decays / smoothing
    this.skyFlash *= Math.exp(-dt * 5.5);
    const target = ((bands.bass ?? 0) + (bands.mid ?? 0) + (bands.high ?? 0)) / 3;
    this.energy += (target - this.energy) * (1 - Math.exp(-dt * 1.5));

    // Persistence LOW by default — flashes must stay crisp
    const alpha = 1 - 0.45 * PostFX.effTrail(params);
    const u = buildUniforms(bands, timeMs, deltaMs, params, this.canvas, this.frameCount, alpha);
    u[41] = this.skyFlash;   // _r1
    u[42] = this.energy;     // _r2
    device.queue.writeBuffer(this.uniformBuffer, 0, u);

    // Bolt upload: ripple_pos_age = (x, seed, age, intensity),
    //              ripple_color   = (slant, width, 0, 0)
    const d = this.boltData;
    for (let i = 0; i < MAX_BOLTS; i++) {
      const b = this.bolts[i];
      const live = b.age <= BOLT_LIFE ? b.intensity : 0;
      d[i * 4 + 0] = b.x;
      d[i * 4 + 1] = b.seed;
      d[i * 4 + 2] = b.age;
      d[i * 4 + 3] = live;
      d[32 + i * 4 + 0] = b.slant;
      d[32 + i * 4 + 1] = b.width;
      d[32 + i * 4 + 2] = 0;
      d[32 + i * 4 + 3] = 0;
    }
    device.queue.writeBuffer(this.uniformBuffer, RIPPLE_OFFSET, d);
  }

  draw(device, view) {
    this.post.ensureTargets();
    const enc = device.createCommandEncoder();
    // Copy last frame through the echo warp (fade 1 — alpha does the decay)
    this.post.fadePass(enc, 1, this._params);
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
