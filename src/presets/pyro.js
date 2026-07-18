import flameSource   from '../shaders/pyro.wgsl?raw';
import computeSource from '../shaders/pyro_ember_compute.wgsl?raw';
import renderSource  from '../shaders/pyro_ember_render.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

// PYRO — a living bonfire rising from the bottom of a black frame.
//
// The fullscreen shader (pyro.wgsl) is the flame body + coal bed + smoke;
// a GPU-resident particle system (pyro_ember_*.wgsl) is the spark column.
// This side owns the fire choreography:
//   bass   → flame height/volume (fast attack, slow release)
//   kick   → upward surge + a burst of embers
//   snare  → sideways crackle sparks
//   high   → faster lick flicker
//   tension→ the fire leans harder and roars taller
//   drop   → flashover: white-hot wall engulfs the frame, then collapses
//   quiet  → flames die to a breathing coal bed with occasional pops
//   tap    → fuel thrown at that point: local burst + ember shower
//   hands  → (gestMode 2) palm bends the flames toward the hand
// All envelopes are dt-scaled. Extra-region slot map lives in pyro.wgsl.

const N_EMBERS = 4096;

export class PyroPreset {
  constructor() {
    this.frameCount = 0;
    this._params    = null;
    this._extra     = new Float32Array(64);

    // smoothed music state
    this._bassSm = 0;
    this._highSm = 0;
    this._energy = 0.3;

    // event envelopes
    this._surge = 0;      // kick → flame jumps up
    this._burst = 0;      // kick/drop → ember emission spike
    this._side  = 0;      // snare → sideways crackle
    this._sideDir = 1;
    this._fo    = 0;      // drop flashover
    this._quiet = 0;      // sustained silence 0..1
    this._pop   = 0;      // coal pop during quiet
    this._popX  = 0;
    this._popTimer = 2;
    this._prevKick  = 0;
    this._prevSnare = 0;
    this._prevDrop  = 0;

    // flame lean: slow wander + hand bend
    this._leanPhase = Math.random() * 20;
    this._lean      = 0;
    this._handBend  = 0;

    // fuel tap
    this._prevTapN = null;   // null = not yet synced (ignore stale taps)
    this._tapEnv   = 0;
    this._tapAge   = 9;
    this._tapX     = 0;
    this._tapY     = 0;
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;

    const flameModule   = device.createShaderModule({ label: 'pyro-flame',         code: flameSource });
    const computeModule = device.createShaderModule({ label: 'pyro-ember-compute', code: computeSource });
    const renderModule  = device.createShaderModule({ label: 'pyro-ember-render',  code: renderSource });

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Ember pool: pos.xy, vel.xy, life, heat, seed, kind — starts all dead
    this.emberBuffer = device.createBuffer({
      size: N_EMBERS * 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.emberBuffer, 0, new Float32Array(N_EMBERS * 8));

    // Explicit bind group layouts ('auto' drops unused bindings)
    const flameBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
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

    this.flameBindGroup = device.createBindGroup({
      layout: flameBGL,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
    const emberEntries = [
      { binding: 0, resource: { buffer: this.uniformBuffer } },
      { binding: 1, resource: { buffer: this.emberBuffer } },
    ];
    this.computeBindGroup = device.createBindGroup({ layout: computeBGL, entries: emberEntries });
    this.renderBindGroup  = device.createBindGroup({ layout: renderBGL,  entries: emberEntries });

    this.flamePipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [flameBGL] }),
      vertex:   { module: flameModule, entryPoint: 'vs_fullscreen' },
      fragment: {
        module: flameModule,
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
    this.computePipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [computeBGL] }),
      compute: { module: computeModule, entryPoint: 'cs_main' },
    });
    this.emberPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [renderBGL] }),
      vertex:   { module: renderModule, entryPoint: 'vs_main' },
      fragment: {
        module: renderModule,
        entryPoint: 'fs_main',
        targets: [{
          format: ACCUM_FORMAT,
          blend: {   // premultiplied additive
            color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.post = new PostFX();
    this.post.init(device, format, canvas);
  }

  _updateMusic(bands, dt, params) {
    const kick  = bands.kick  ?? 0;
    const snare = bands.snare ?? 0;
    const drop  = params.dropPulse ?? 0;
    const tension = params.tension ?? 0;

    // bass → body: fast attack, slow release so the fire "holds" its size
    const bass = (bands.bass ?? 0) * 0.75 + (bands.subBass ?? 0) * 0.25;
    this._bassSm += (bass - this._bassSm)
                  * (1 - Math.exp(-dt / (bass > this._bassSm ? 0.09 : 0.45)));
    this._highSm += ((bands.high ?? 0) - this._highSm) * (1 - Math.exp(-dt / 0.15));
    const eTarget = ((bands.bass ?? 0) + (bands.mid ?? 0) + (bands.high ?? 0)) / 3;
    this._energy += (eTarget - this._energy) * (1 - Math.exp(-dt / 1.0));

    // sustained silence → the fire dies down to breathing coals
    const qT = this._energy < 0.05 ? 1 : 0;
    this._quiet += (qT - this._quiet)
                 * (1 - Math.exp(-dt / (qT > this._quiet ? 2.2 : 0.5)));

    // kick → surge upward + ember burst
    if (kick > 0.45 && this._prevKick <= 0.35) {
      this._surge = Math.max(this._surge, 0.45 + kick * 0.55);
      this._burst = Math.max(this._burst, 0.5 + kick * 0.5);
    }
    this._prevKick = kick;

    // snare → sideways crackle sparks
    if (snare > 0.4 && this._prevSnare <= 0.32) {
      this._side = Math.max(this._side, 0.5 + snare * 0.5);
      this._sideDir = Math.random() < 0.5 ? -1 : 1;
    }
    this._prevSnare = snare;

    // drop → flashover + massive ember wall
    if (drop > 0.6 && this._prevDrop <= 0.6) {
      this._fo    = 1;
      this._burst = Math.max(this._burst, 3);
      this._surge = Math.max(this._surge, 1.2);
    }
    this._prevDrop = drop;

    // dt-scaled decays
    this._surge *= Math.exp(-dt * 4.5);
    this._burst *= Math.exp(-dt * 7);
    this._side  *= Math.exp(-dt * 8);
    this._fo    *= Math.exp(-dt * 1.15);   // engulf ~1 s, then collapse
    this._pop   *= Math.exp(-dt * 5.5);

    // occasional coal pops while quiet
    if (this._quiet > 0.5) {
      this._popTimer -= dt;
      if (this._popTimer <= 0) {
        this._popTimer = 1.2 + Math.random() * 3.0;
        this._pop  = 1;
        this._popX = (Math.random() - 0.5) * 1.3;
      }
    }

    // lean: slow non-uniform wander, amplified by tension; palm bends it
    this._leanPhase += dt * (0.30 + tension * 0.55);
    const wander = Math.sin(this._leanPhase)
                 * (0.55 + Math.sin(this._leanPhase * 0.37) * 0.45)
                 * 0.11 * (1 + tension * 2.0);
    let bendT = 0;
    if (params.gestMode === 2 && params.hands) {
      const asp = this.canvas.width / Math.max(this.canvas.height, 1);
      let best = null;
      for (const h of params.hands.h ?? []) {
        if (h && (h.present ?? 0) > 0.25 && (!best || h.present > best.present)) best = h;
      }
      if (best) bendT = (best.x * 2 - 1) * asp * 0.28 * Math.min(best.present, 1);
    }
    this._handBend += (bendT - this._handBend) * (1 - Math.exp(-dt / 0.25));
    this._lean += (wander + this._handBend - this._lean) * (1 - Math.exp(-dt / 0.6));
  }

  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._params = params;
    const dt = Math.min(deltaMs, 50) * 0.001;

    this._updateMusic(bands, dt, params);

    // ── tap = throw fuel on the fire at that point ────────────────────────
    const tapN = params.cymTapN ?? 0;
    if (this._prevTapN === null) this._prevTapN = tapN;
    if (tapN !== this._prevTapN) {
      this._prevTapN = tapN;
      const asp = this.canvas.width / Math.max(this.canvas.height, 1);
      this._tapX = ((params.cymTapX ?? 0.5) * 2 - 1) * asp;
      this._tapY = 1 - (params.cymTapY ?? 0.5) * 2;
      this._tapEnv = 1;
      this._tapAge = 0;
    }
    this._tapAge += dt;
    this._tapEnv *= Math.exp(-dt * 1.6);   // burns out over ~1.5 s

    // ── flame body params ─────────────────────────────────────────────────
    const tension = params.tension ?? 0;
    const height = (0.30 + this._bassSm * 0.95 + tension * 0.40 + this._surge * 0.50)
                 * (1 - this._quiet * 0.72) + 0.08;
    const width  = (0.34 + this._bassSm * 0.28 + this._surge * 0.10)
                 * (1 - this._quiet * 0.5);
    const roar    = Math.min(1.5, tension * 0.8 + this._surge * 0.6 + this._fo);
    const flicker = this._highSm * 2.4;

    // ember emission (respawn prob per dead particle per second)
    const rBase  = (0.012 + this._energy * 0.10) * (1 - this._quiet * 0.8) + 0.004;
    const rBurst = this._burst * 0.9;
    const rSide  = this._side * 0.7;

    // Persistence LOW — flames must stay crisp; embers keep short hot streaks
    const alpha = 1 - 0.45 * PostFX.effTrail(params);
    const u = buildUniforms(bands, timeMs, deltaMs, params, this.canvas, this.frameCount, alpha);
    device.queue.writeBuffer(this.uniformBuffer, 0, u);

    const e = this._extra;
    e[0]  = height;        e[1]  = width;         e[2]  = this._lean;   e[3]  = roar;
    e[4]  = flicker;       e[5]  = this._surge;   e[6]  = this._fo;     e[7]  = this._quiet;
    e[8]  = this._tapX;    e[9]  = this._tapY;    e[10] = this._tapEnv; e[11] = this._tapAge;
    e[12] = rBase;         e[13] = rBurst;        e[14] = rSide;        e[15] = this._sideDir;
    e[16] = this._pop;     e[17] = this._popX;    e[18] = 0;            e[19] = 0;
    device.queue.writeBuffer(this.uniformBuffer, RIPPLE_OFFSET, e);

    const enc  = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.computePipeline);
    pass.setBindGroup(0, this.computeBindGroup);
    pass.dispatchWorkgroups(Math.ceil(N_EMBERS / 64));
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  draw(device, view) {
    this.post.ensureTargets();
    const enc = device.createCommandEncoder();
    // Echo copies last frame; the flame pass alpha does the actual decay
    this.post.fadePass(enc, 1, this._params);

    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.post.accumView, loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(this.flamePipeline);
    pass.setBindGroup(0, this.flameBindGroup);
    pass.draw(3);
    pass.setPipeline(this.emberPipeline);
    pass.setBindGroup(0, this.renderBindGroup);
    pass.draw(N_EMBERS * 6);
    pass.end();

    this.post.finish(enc, view, this._params);
    device.queue.submit([enc.finish()]);
  }

  destroy() {
    this.post?.destroy();
    this.emberBuffer?.destroy();
    this.uniformBuffer?.destroy();
  }
}
