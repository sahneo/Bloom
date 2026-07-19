import bgSource      from '../shaders/abyss_bg.wgsl?raw';
import computeSource from '../shaders/abyss_compute.wgsl?raw';
import renderSource  from '../shaders/abyss_render.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

// ABYSS — підводне світло. Deep water rendered as pure light: no creature
// bodies, nothing figurative. A fullscreen background pass draws the water
// column (god rays refracted through caustic interference, depth fog,
// 3-layer marine snow); a 200k GPU plankton field drifts in curl-noise
// currents, mostly invisible, and SOUND ignites it:
//   kick   → pressure wavefront expands/sinks through the field (~1.5 s)
//   bass   → ambient bioluminescent fog breathing (EMA)
//   mid    → the current's swirl energy (slew-limited — heavy water)
//   high   → rare individual sparkles
//   snare  → brief local glitter cloud
//   drop   → the whole abyss ignites; a crest sweeps the frame, ~3 s fade
//   quiet  → near-black: just rays, snow, and the lone stray sparkle
// Tap = disturbance vortex (ignited eddy, snow swirls). gestMode 2:
// palm = current source, fist = suction vortex.
//
// Grace discipline: every audio coupling goes through asymmetric EMAs
// (fast attack, 1–2 s release); fast events only ever change LIGHT.

const N = 200_000;               // plankton count
const WAVES = 4;                 // concurrent kick wavefronts

// asymmetric EMA: fast attack, slow release
function ema(cur, target, dt, atkS, relS) {
  const tau = target > cur ? atkS : relS;
  return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}

export class AbyssPreset {
  constructor() {
    this.frameCount = 0;
    this._params = null;
    this._dtMs   = 16.67;

    // smoothed audio couplings
    this._ambient = 0;           // bass → fog
    this._swirl   = 0;           // mid  → current energy (slew-limited)
    this._sparkle = 0;           // high → sparkle rate
    this._eSlow   = 0;           // quiet detector
    this._flowT   = 0;           // monotonic flow clock, swirl-scaled

    // events
    this._waves = Array.from({ length: WAVES }, () => ({ x: 0, y: 0, age: 9, str: 0 }));
    this._prevKick  = 0;
    this._prevSnare = 0;
    this._prevDrop  = 0;
    this._kickCd    = 0;
    this._dropAge   = 99;
    this._snare     = { x: 0, y: 0, env: 0, age: 9 };

    // tap vortex
    this._prevTapN = null;       // null = not yet synced with params.cymTapN
    this._tap      = { x: 0, y: 0, env: 0, age: 9 };

    this._extra = new Float32Array(64);   // 16 × vec4f
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;

    const bgModule      = device.createShaderModule({ label: 'abyss-bg',      code: bgSource });
    const computeModule = device.createShaderModule({ label: 'abyss-compute', code: computeSource });
    const renderModule  = device.createShaderModule({ label: 'abyss-render',  code: renderSource });

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // plankton storage: N × 16 bytes (pos.xy, vel.xy)
    this.particleBuffer = device.createBuffer({
      size: N * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const seed = new Float32Array(N * 4);
    const asp = Math.max(canvas.width / canvas.height, 0.5) || 1.6;
    for (let i = 0; i < N; i++) {
      seed[i * 4]     = (Math.random() * 2 - 1) * (asp + 0.15);
      seed[i * 4 + 1] = (Math.random() * 2 - 1) * 1.15;
      seed[i * 4 + 2] = 0;
      seed[i * 4 + 3] = 0;
    }
    device.queue.writeBuffer(this.particleBuffer, 0, seed);

    // explicit bind group layouts
    const bgBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    const computeBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const renderBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX,                           buffer: { type: 'read-only-storage' } },
      ],
    });

    this.bgBindGroup = device.createBindGroup({
      layout: bgBGL,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
    const withParticles = (layout) => device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.particleBuffer } },
      ],
    });
    this.computeBindGroup = withParticles(computeBGL);
    this.renderBindGroup  = withParticles(renderBGL);

    const additive = {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    };
    this.bgPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bgBGL] }),
      vertex:   { module: bgModule, entryPoint: 'vs_main' },
      fragment: { module: bgModule, entryPoint: 'fs_main',
                  targets: [{ format: ACCUM_FORMAT, blend: additive }] },
      primitive: { topology: 'triangle-list' },
    });
    this.computePipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [computeBGL] }),
      compute: { module: computeModule, entryPoint: 'cs_main' },
    });
    this.renderPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [renderBGL] }),
      vertex:   { module: renderModule, entryPoint: 'vs_main' },
      fragment: { module: renderModule, entryPoint: 'fs_main',
                  targets: [{ format: ACCUM_FORMAT, blend: additive }] },
      primitive: { topology: 'triangle-list' },
    });

    this.post = new PostFX();
    this.post.init(device, format, canvas);

    if (typeof window !== 'undefined') window.__abyss = this;
  }

  _spawnWave(x, y, str) {
    // reuse the slot whose wave contributes the least light right now
    let best = this._waves[0], bestEnv = Infinity;
    for (const w of this._waves) {
      const tn = Math.min(w.age / 1.5, 1);
      const env = w.str * Math.pow(1 - tn, 1.7);
      if (env < bestEnv) { bestEnv = env; best = w; }
    }
    best.x = x; best.y = y; best.age = 0; best.str = str;
  }

  _updateMusic(bands, dt, params) {
    const asp = Math.max(this.canvas.width / this.canvas.height, 0.5) || 1.6;
    const bass = (bands.bass ?? 0) * 0.75 + (bands.subBass ?? 0) * 0.25;
    const mid  = bands.mid  ?? 0;
    const high = bands.high ?? 0;

    // asymmetric EMAs — grace discipline
    this._ambient = ema(this._ambient, bass, dt, 0.25, 1.8);
    this._sparkle = ema(this._sparkle, high, dt, 0.15, 1.0);
    let swirlT = ema(this._swirl, mid, dt, 0.30, 2.0);
    // slew limit on top: the current never changes faster than 0.5/s
    this._swirl += Math.max(-0.5 * dt, Math.min(0.5 * dt, swirlT - this._swirl));

    const e = (bass + mid + high) / 3;
    this._eSlow = ema(this._eSlow, e, dt, 1.5, 3.0);

    // flow clock: current visibly speeds with melody, phase-continuous
    this._flowT += dt * (0.6 + this._swirl * 2.6);

    // kick rising edge → pressure wavefront
    this._kickCd = Math.max(0, this._kickCd - dt);
    const kick = bands.kick ?? 0;
    if (kick > 0.45 && this._prevKick < 0.35 && this._kickCd <= 0) {
      this._spawnWave(
        (Math.random() * 2 - 1) * asp * 0.7,
        -0.1 + Math.random() * 0.8,
        0.55 + kick * 0.55);
      this._kickCd = 0.22;
    }
    this._prevKick = kick;
    for (const w of this._waves) w.age += dt;

    // snare rising edge → glitter cloud at a random spot
    const snare = bands.snare ?? 0;
    if (snare > 0.35 && this._prevSnare < 0.3) {
      this._snare.x = (Math.random() * 2 - 1) * asp * 0.75;
      this._snare.y = Math.random() * 1.4 - 0.7;
      this._snare.env = Math.max(this._snare.env, snare * 0.9);
      this._snare.age = 0;
    }
    this._prevSnare = snare;
    this._snare.age += dt;
    this._snare.env *= Math.exp(-dt * 4.5);            // ~0.5 s glitter

    // drop rising edge → the whole abyss ignites
    const drop = params.dropPulse ?? 0;
    if (drop > 0.5 && this._prevDrop <= 0.5) this._dropAge = 0;
    this._prevDrop = drop;
    this._dropAge += dt;
  }

  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._params = params;
    this._dtMs   = deltaMs;
    const dt = Math.min(deltaMs * 0.001, 0.05);

    this._updateMusic(bands, dt, params);

    // ── tap → disturbance vortex ──────────────────────────────────────────
    const tapN = params.cymTapN ?? 0;
    if (this._prevTapN === null) this._prevTapN = tapN;  // ignore stale taps
    if (tapN !== this._prevTapN) {
      this._prevTapN = tapN;
      const asp = Math.max(this.canvas.width / this.canvas.height, 0.5) || 1.6;
      this._tap.x = ((params.cymTapX ?? 0.5) * 2 - 1) * asp;
      this._tap.y = 1 - (params.cymTapY ?? 0.5) * 2;
      this._tap.env = 1;
      this._tap.age = 0;
    }
    this._tap.age += dt;
    this._tap.env *= Math.exp(-dt * 1.1);              // slow, heavy ~2 s eddy

    const { gain } = PostFX.trailFactors(params, deltaMs);
    const u = buildUniforms(bands, timeMs, deltaMs, params, this.canvas, this.frameCount, gain);
    u[41] = this._ambient;       // _r1
    u[42] = this._swirl;         // _r2
    u[43] = this._sparkle;       // _r3
    device.queue.writeBuffer(this.uniformBuffer, 0, u);

    const e = this._extra;
    for (let i = 0; i < WAVES; i++) {
      const w = this._waves[i];
      e[i * 4]     = w.x;
      e[i * 4 + 1] = w.y;
      e[i * 4 + 2] = w.age;
      e[i * 4 + 3] = w.age < 1.55 ? w.str : 0;
    }
    const dropEnv = this._dropAge < 6 ? Math.exp(-this._dropAge * 1.05) : 0;
    const quiet   = Math.max(0, Math.min(1, 1 - this._eSlow * 2.5));
    e[16] = this._dropAge; e[17] = dropEnv; e[18] = quiet; e[19] = 0;
    e[20] = this._snare.x; e[21] = this._snare.y; e[22] = this._snare.env; e[23] = this._snare.age;
    e[24] = this._tap.x;   e[25] = this._tap.y;   e[26] = this._tap.env;   e[27] = this._tap.age;

    // hands (gestMode 2): up to two — palm = source, fist = suction vortex
    e[28] = e[29] = e[30] = e[31] = 0;
    e[32] = e[33] = e[34] = e[35] = 0;
    if (params.gestMode === 2 && params.hands?.h) {
      const asp = Math.max(this.canvas.width / this.canvas.height, 0.5) || 1.6;
      for (let s = 0; s < 2; s++) {
        const h = params.hands.h[s];
        if (!h || (h.present ?? 0) < 0.05) continue;
        e[28 + s * 4]     = (h.x * 2 - 1) * asp;
        e[28 + s * 4 + 1] = 1 - h.y * 2;
        e[28 + s * 4 + 2] = h.present;
        e[28 + s * 4 + 3] = h.grip ?? 0;
      }
    }
    e[36] = this._flowT;
    device.queue.writeBuffer(this.uniformBuffer, RIPPLE_OFFSET, e);

    const enc  = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.computePipeline);
    pass.setBindGroup(0, this.computeBindGroup);
    pass.dispatchWorkgroups(Math.ceil(N / 64));
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  draw(device, view) {
    this.post.ensureTargets();
    const { fade } = PostFX.trailFactors(this._params, this._dtMs);

    const enc = device.createCommandEncoder();
    this.post.fadePass(enc, fade, this._params);

    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.post.accumView, loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(this.bgPipeline);
    pass.setBindGroup(0, this.bgBindGroup);
    pass.draw(3);
    pass.setPipeline(this.renderPipeline);
    pass.setBindGroup(0, this.renderBindGroup);
    pass.draw(N * 6);
    pass.end();

    this.post.finish(enc, view, this._params);
    device.queue.submit([enc.finish()]);
  }

  destroy() {
    this.post?.destroy();
    if (typeof window !== 'undefined' && window.__abyss === this) delete window.__abyss;
  }
}
