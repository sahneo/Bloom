import flameSource   from '../shaders/pyro.wgsl?raw';
import computeSource from '../shaders/pyro_ember_compute.wgsl?raw';
import renderSource  from '../shaders/pyro_ember_render.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

// PYRO — a living bonfire rising from the bottom of a black frame.
//
// The fullscreen shader (pyro.wgsl) is the volumetric flame body (3 advected
// layers) + coal bed + lit smoke; a GPU-resident particle system
// (pyro_ember_*.wgsl) is the ember drift. This side owns the fire
// choreography, and its cardinal rule is SMOOTHNESS: the flame's own
// turbulence supplies all the fast motion — audio only modulates it slowly.
//   bass   → flame height/volume (EMA ~0.15s attack / ~1.2s release + slew)
//   kick   → eased surge envelope (~0.6s) + a modest extra ember puff
//   snare  → a few sideways crackle sparks (eased)
//   high   → advection flicker (EMA'd)
//   tension→ the fire leans harder and roars taller
//   drop   → flashover: eased white wall engulfs the frame, then collapses
//   quiet  → flames die to a breathing coal bed with occasional pops
//   tap    → fuel thrown at that point: local burn + ember trickle
//   hands  → (gestMode 2) palm bends the flames toward the hand
// All envelopes are dt-scaled. Extra-region slot map lives in pyro.wgsl.

const N_EMBERS = 4096;

// asymmetric EMA helper: fast attack, slow release (time constants in s)
function ema(cur, target, dt, tauA, tauR) {
  return cur + (target - cur) * (1 - Math.exp(-dt / (target > cur ? tauA : tauR)));
}
// slew limiter: max units/s up and down
function slew(cur, target, dt, up, dn) {
  return cur + Math.max(-dn * dt, Math.min(up * dt, target - cur));
}

export class PyroPreset {
  constructor() {
    this.frameCount = 0;
    this._params    = null;
    this._extra     = new Float32Array(64);

    // smoothed music state (all EMA'd — raw bands never reach the shader)
    this._bassSm = 0;
    this._highSm = 0;
    this._energy = 0.3;
    this._glow   = 0.3;   // light-spill envelope — light inertia

    // slew-limited body
    this._height = 0.45;
    this._width  = 0.35;

    // event envelopes: two-stage (peak decays slowly, env chases peak)
    // so every hit is an eased swell, never a frame-step jump
    this._surge = 0; this._surgePk = 0;   // kick → flame swells up
    this._burst = 0; this._burstPk = 0;   // kick/drop → ember emission
    this._side  = 0; this._sidePk  = 0;   // snare → sideways crackle
    this._fo    = 0; this._foPk    = 0;   // drop flashover
    this._sideDir = 1;
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

    // every band input is EMA'd: ~0.15s attack, ~1s release — the fire
    // breathes with the music instead of twitching with it
    const bass = (bands.bass ?? 0) * 0.75 + (bands.subBass ?? 0) * 0.25;
    this._bassSm = ema(this._bassSm, bass,            dt, 0.15, 1.2);
    this._highSm = ema(this._highSm, bands.high ?? 0, dt, 0.15, 0.9);
    const eTarget = ((bands.bass ?? 0) + (bands.mid ?? 0) + (bands.high ?? 0)) / 3;
    this._energy += (eTarget - this._energy) * (1 - Math.exp(-dt / 1.5));

    // sustained silence → the fire dies down to breathing coals
    const qT = this._energy < 0.05 ? 1 : 0;
    this._quiet += (qT - this._quiet)
                 * (1 - Math.exp(-dt / (qT > this._quiet ? 2.2 : 0.8)));

    // kick → surge: sets a slowly-decaying peak; the visible envelope eases
    // toward it (attack ~0.13s, gone in ~0.6s) — a swell, not a jump
    if (kick > 0.45 && this._prevKick <= 0.35) {
      this._surgePk = Math.max(this._surgePk, 0.30 + kick * 0.35);
      this._burstPk = Math.max(this._burstPk, 0.22 + kick * 0.28);
    }
    this._prevKick = kick;

    // snare → a gentle sideways crackle
    if (snare > 0.4 && this._prevSnare <= 0.32) {
      this._sidePk  = Math.max(this._sidePk, 0.30 + snare * 0.35);
      this._sideDir = Math.random() < 0.5 ? -1 : 1;
    }
    this._prevSnare = snare;

    // drop → flashover (eased attack ~0.18s) + a strong-but-soft ember wave
    if (drop > 0.6 && this._prevDrop <= 0.6) {
      this._foPk    = 1;
      this._burstPk = Math.max(this._burstPk, 1.2);
      this._surgePk = Math.max(this._surgePk, 0.9);
    }
    this._prevDrop = drop;

    // two-stage envelopes: peak decays, visible env chases it (eased both ways)
    this._surgePk *= Math.exp(-dt / 0.35);
    this._burstPk *= Math.exp(-dt / 0.30);
    this._sidePk  *= Math.exp(-dt / 0.28);
    this._foPk    *= Math.exp(-dt * 1.15);   // engulf ~1 s, then collapse
    this._surge += (this._surgePk - this._surge) * (1 - Math.exp(-dt / 0.13));
    this._burst += (this._burstPk - this._burst) * (1 - Math.exp(-dt / 0.10));
    this._side  += (this._sidePk  - this._side)  * (1 - Math.exp(-dt / 0.09));
    this._fo    += (this._foPk    - this._fo)    * (1 - Math.exp(-dt / 0.18));
    this._pop   *= Math.exp(-dt * 5.5);

    // light spill follows overall fire intensity with heavy inertia (~0.7s)
    const gTarget = 0.20 + this._energy * 0.9 + this._surge * 0.35 + this._fo * 0.8;
    this._glow += (gTarget - this._glow) * (1 - Math.exp(-dt / 0.7));

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

    // ── flame body params: EMA'd inputs + slew limit = no frame jumps ────
    const tension = params.tension ?? 0;
    const hTarget = (0.42 + this._bassSm * 0.95 + tension * 0.38 + this._surge * 0.45)
                  * (1 - this._quiet * 0.70) + 0.10;
    const wTarget = (0.34 + this._bassSm * 0.26 + this._surge * 0.08)
                  * (1 - this._quiet * 0.5);
    this._height = slew(this._height, hTarget, dt, 0.80, 0.45);
    this._width  = slew(this._width,  wTarget, dt, 0.50, 0.30);
    const roar    = Math.min(1.2, tension * 0.7 + this._surge * 0.5 + this._fo * 0.9);
    const flicker = this._highSm * 1.1;

    // ember emission: a continuous leak scaled by flame intensity —
    // fewer, larger, softer sparks (render pass draws them as soft motes)
    const rBase  = (0.002 + this._energy * 0.014 + this._bassSm * 0.006)
                 * (1 - this._quiet * 0.8) + 0.001;
    const rBurst = this._burst * 0.35;
    const rSide  = this._side * 0.30;

    // Persistence LOW — flames must stay crisp; embers keep short hot streaks
    const alpha = 1 - 0.45 * PostFX.effTrail(params);
    const u = buildUniforms(bands, timeMs, deltaMs, params, this.canvas, this.frameCount, alpha);
    device.queue.writeBuffer(this.uniformBuffer, 0, u);

    const e = this._extra;
    e[0]  = this._height;  e[1]  = this._width;   e[2]  = this._lean;   e[3]  = roar;
    e[4]  = flicker;       e[5]  = this._surge;   e[6]  = this._fo;     e[7]  = this._quiet;
    e[8]  = this._tapX;    e[9]  = this._tapY;    e[10] = this._tapEnv; e[11] = this._tapAge;
    e[12] = rBase;         e[13] = rBurst;        e[14] = rSide;        e[15] = this._sideDir;
    e[16] = this._pop;     e[17] = this._popX;    e[18] = this._glow;   e[19] = 0;
    device.queue.writeBuffer(this.uniformBuffer, RIPPLE_OFFSET, e);
    if (typeof window !== 'undefined' && window.__pyroDebug) {
      window.__pyroDbg = { height: this._height, width: this._width, fo: this._fo,
        surge: this._surge, quiet: this._quiet, bassSm: this._bassSm,
        energy: this._energy, glow: this._glow, roar, flicker, rBase };
    }

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
