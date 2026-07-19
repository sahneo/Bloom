import simSource         from '../shaders/pyro_sim.wgsl?raw';
import renderSource      from '../shaders/pyro_render.wgsl?raw';
import sparkSimSource    from '../shaders/pyro_spark_compute.wgsl?raw';
import sparkRenderSource from '../shaders/pyro_spark_render.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

// PYRO — a real bonfire filmed at night.
//
// v3: the flame is a genuine 2D fire SIMULATION on a half-res temperature
// grid (ping-pong storage buffers, frost/physarum idiom) — semi-Lagrangian
// advection with buoyancy + curl-noise churn, noise-shredded cooling, and a
// bed of wandering hot spots injecting heat at the base. The churning,
// licking, tearing motion comes out of the sim itself: no scrolling noise
// layers (v2's banding), no point-sprite embers (v2's glitter). Sparks are
// sim-seeded particles rendered as velocity-stretched streaks.
//
// Music mapping (all EMA'd / eased — raw bands never reach the shader):
//   bass   → hot-spot intensity (attack ~0.15s, release ~1.2s)
//   kick   → eased brief injection boost + a modest spark puff
//   high   → bed flicker rate
//   tension→ hotter, taller fire (cooling drops, injection up)
//   drop   → flashover: heat floods the whole base + cooling drops briefly
//   quiet  → injection nearly off → glowing dying coal bed with pops
//   tap    → mid-air heat burst at that point (fireball rises, dissolves)
// Extra-region slot map is documented in pyro_sim.wgsl.

const N_SPARKS = 384;
const N_SPOTS  = 6;

// asymmetric EMA helper: fast attack, slow release (time constants in s)
function ema(cur, target, dt, tauA, tauR) {
  return cur + (target - cur) * (1 - Math.exp(-dt / (target > cur ? tauA : tauR)));
}

export class PyroPreset {
  constructor() {
    this.frameCount = 0;
    this._params = null;
    this._extra  = new Float32Array(64);
    this._cur = 0;
    this._gw = 0; this._gh = 0;

    // smoothed music state
    this._bassSm = 0;
    this._highSm = 0;
    this._energy = 0.3;
    this._glow   = 0.3;      // light-spill envelope — light inertia
    this._quiet  = 0;

    // event envelopes: two-stage (peak decays, visible env chases it) so
    // every hit is an eased swell, never a frame-step jump
    this._surge = 0; this._surgePk = 0;   // kick → injection boost
    this._puff  = 0; this._puffPk  = 0;   // kick → spark puff
    this._fo    = 0; this._foPk    = 0;   // drop flashover
    this._prevKick = 0;
    this._prevDrop = 0;

    // coal pops during quiet
    this._pop = 0; this._popX = 0.5; this._popTimer = 2;

    // wind lean: slow non-uniform wander (+ palm bend in hands mode)
    this._leanPhase = Math.random() * 20;
    this._lean = 0;
    this._handBend = 0;

    // coal-bed hot spots: wandering positions, per-spot flicker
    this._spots = Array.from({ length: N_SPOTS }, (_, k) => ({
      off: (k / (N_SPOTS - 1)) * 2 - 1,          // home position −1..1
      ph1: Math.random() * 6.283, sp1: 0.05 + Math.random() * 0.06,
      ph2: Math.random() * 6.283, sp2: 0.11 + Math.random() * 0.09,
      fph: Math.random() * 6.283, fsp: 1.3 + Math.random() * 2.4,
    }));

    // tap fireball
    this._prevTapN = null;   // null = not yet synced (ignore stale taps)
    this._tapEnv = 0; this._tapAge = 9; this._tapX = 0.5; this._tapY = 0.5;
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;

    const simModule         = device.createShaderModule({ label: 'pyro-sim',          code: simSource });
    const renderModule      = device.createShaderModule({ label: 'pyro-render',       code: renderSource });
    const sparkSimModule    = device.createShaderModule({ label: 'pyro-spark-sim',    code: sparkSimSource });
    const sparkRenderModule = device.createShaderModule({ label: 'pyro-spark-render', code: sparkRenderSource });

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // spark pool: pos.xy, vel.xy, heat, life, seed, pad — starts all dead
    this.sparkBuffer = device.createBuffer({
      size: N_SPARKS * 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.sparkBuffer, 0, new Float32Array(N_SPARKS * 8));

    // explicit bind group layouts ('auto' drops unused bindings)
    this._simBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    this._renderBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    this._sparkSimBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    this._sparkRenderBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });

    this.simPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._simBGL] }),
      compute: { module: simModule, entryPoint: 'cs_sim' },
    });
    this.renderPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._renderBGL] }),
      vertex:   { module: renderModule, entryPoint: 'vs_fullscreen' },
      fragment: { module: renderModule, entryPoint: 'fs_render', targets: [{ format: ACCUM_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });
    this.sparkSimPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._sparkSimBGL] }),
      compute: { module: sparkSimModule, entryPoint: 'cs_main' },
    });
    this.sparkRenderPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._sparkRenderBGL] }),
      vertex:   { module: sparkRenderModule, entryPoint: 'vs_main' },
      fragment: {
        module: sparkRenderModule,
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

    this.sparkRenderBG = device.createBindGroup({
      layout: this._sparkRenderBGL,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.sparkBuffer } },
      ],
    });

    this._ensureGrid();
    this.post = new PostFX();
    this.post.init(device, format, canvas);
  }

  // temperature grid at half canvas resolution (capped ~720×450), rebuilt
  // on resize — frost/physarum pattern
  _ensureGrid() {
    const gw = Math.min(Math.max(Math.round(this.canvas.width  / 2), 180), 720);
    const gh = Math.min(Math.max(Math.round(this.canvas.height / 2), 120), 450);
    if (gw === this._gw && gh === this._gh) return;
    this._gw = gw; this._gh = gh;
    this.gridBuffers?.forEach(b => b.destroy());
    const size = gw * gh * 8;                    // vec2f(temperature, smoke)
    this.gridBuffers = [0, 1].map(() => this.device.createBuffer({
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    }));
    this._simBG = [0, 1].map(i => this.device.createBindGroup({
      layout: this._simBGL,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.gridBuffers[i] } },
        { binding: 2, resource: { buffer: this.gridBuffers[1 - i] } },
      ],
    }));
    this._renderBG = [0, 1].map(i => this.device.createBindGroup({
      layout: this._renderBGL,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.gridBuffers[i] } },
      ],
    }));
    this._sparkSimBG = [0, 1].map(i => this.device.createBindGroup({
      layout: this._sparkSimBGL,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.gridBuffers[i] } },
        { binding: 2, resource: { buffer: this.sparkBuffer } },
      ],
    }));
    this._cur = 0;
  }

  _updateMusic(bands, dt, params) {
    const kick = bands.kick ?? 0;
    const drop = params.dropPulse ?? 0;
    const tension = params.tension ?? 0;

    // every band input is EMA'd (~0.15s attack / ~1.2s release) — the fire
    // breathes with the music instead of twitching with it
    const bass = (bands.bass ?? 0) * 0.75 + (bands.subBass ?? 0) * 0.25;
    this._bassSm = ema(this._bassSm, bass,            dt, 0.15, 1.2);
    this._highSm = ema(this._highSm, bands.high ?? 0, dt, 0.15, 0.9);
    const eTarget = ((bands.bass ?? 0) + (bands.mid ?? 0) + (bands.high ?? 0)) / 3;
    this._energy += (eTarget - this._energy) * (1 - Math.exp(-dt / 1.5));

    // sustained silence → injection dies down to breathing coals
    const qT = this._energy < 0.05 ? 1 : 0;
    this._quiet += (qT - this._quiet)
                 * (1 - Math.exp(-dt / (qT > this._quiet ? 3.2 : 0.8)));

    // kick → eased brief injection boost + a modest spark puff (not a burst)
    if (kick > 0.45 && this._prevKick <= 0.35) {
      this._surgePk = Math.max(this._surgePk, 0.25 + kick * 0.30);
      this._puffPk  = Math.max(this._puffPk,  0.20 + kick * 0.25);
    }
    this._prevKick = kick;

    // drop → flashover: heat floods the base, cooling drops (in-shader),
    // the sim itself produces the engulfing wall — then recovers
    if (drop > 0.6 && this._prevDrop <= 0.6) {
      this._foPk    = 1;
      this._surgePk = Math.max(this._surgePk, 0.8);
      this._puffPk  = Math.max(this._puffPk, 0.9);
    }
    this._prevDrop = drop;

    // two-stage envelopes: peak decays, visible env chases it (eased)
    this._surgePk *= Math.exp(-dt / 0.35);
    this._puffPk  *= Math.exp(-dt / 0.30);
    this._foPk    *= Math.exp(-dt * 1.15);   // engulf ~1s, then recover
    this._surge += (this._surgePk - this._surge) * (1 - Math.exp(-dt / 0.13));
    this._puff  += (this._puffPk  - this._puff)  * (1 - Math.exp(-dt / 0.10));
    this._fo    += (this._foPk    - this._fo)    * (1 - Math.exp(-dt / 0.18));
    this._pop   *= Math.exp(-dt * 4.5);

    // light spill follows overall fire intensity with heavy inertia (~0.7s)
    const gTarget = 0.15 + this._energy * 0.9 + this._surge * 0.3 + this._fo * 0.9;
    this._glow += (gTarget - this._glow) * (1 - Math.exp(-dt / 0.7));

    // occasional coal pops while quiet — a lick of flame off one coal
    if (this._quiet > 0.5) {
      this._popTimer -= dt;
      if (this._popTimer <= 0) {
        this._popTimer = 1.4 + Math.random() * 3.2;
        this._pop  = 1;
        this._popX = 0.5 + (Math.random() - 0.5) * 0.4;
      }
    }

    // wind lean: slow non-uniform wander, amplified by tension; palm bends
    this._leanPhase += dt * (0.28 + tension * 0.5);
    const wander = Math.sin(this._leanPhase)
                 * (0.55 + Math.sin(this._leanPhase * 0.37) * 0.45)
                 * 0.30 * (1 + tension * 1.4);
    let bendT = 0;
    if (params.gestMode === 2 && params.hands) {
      let best = null;
      for (const h of params.hands.h ?? []) {
        if (h && (h.present ?? 0) > 0.25 && (!best || h.present > best.present)) best = h;
      }
      if (best) bendT = (best.x * 2 - 1) * 0.9 * Math.min(best.present, 1);
    }
    this._handBend += (bendT - this._handBend) * (1 - Math.exp(-dt / 0.25));
    this._lean += (wander + this._handBend - this._lean) * (1 - Math.exp(-dt / 0.6));
  }

  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._params = params;
    this._ensureGrid();
    const dt = Math.min(deltaMs, 50) * 0.001;
    const t  = timeMs * 0.001;

    this._updateMusic(bands, dt, params);

    // ── tap = mid-air heat burst at that point ────────────────────────────
    const tapN = params.cymTapN ?? 0;
    if (this._prevTapN === null) this._prevTapN = tapN;
    if (tapN !== this._prevTapN) {
      this._prevTapN = tapN;
      this._tapX = params.cymTapX ?? 0.5;
      this._tapY = 1 - (params.cymTapY ?? 0.5);   // sim uv is y-up
      this._tapEnv = 1;
      this._tapAge = 0;
    }
    this._tapAge += dt;
    this._tapEnv *= Math.exp(-dt * 1.6);

    // ── hot-spot bed: positions wander slowly, intensity = smoothed bass ──
    const tension = params.tension ?? 0;
    const spread = 0.62 + this._bassSm * 0.30 - this._quiet * 0.30;
    const iBase = (0.32 + this._bassSm * 0.72 + this._surge * 0.50 + tension * 0.22)
                * (1 - this._quiet * 0.90) + 0.13 + this._quiet * 0.20;
    let cxAcc = 0, iAcc = 0;
    const spotVals = [];
    for (const s of this._spots) {
      let x = 0.5 + s.off * 0.26 * spread
            + Math.sin(t * s.sp1 * 6.283 + s.ph1) * 0.085
            + Math.sin(t * s.sp2 * 6.283 + s.ph2) * 0.045
            + this._lean * 0.04;
      x = Math.min(0.92, Math.max(0.08, x));
      // per-spot flicker: faster when highs are busy, deeper when quiet
      const flick = 0.62 + 0.38 * Math.sin(t * s.fsp * (1 + this._highSm * 1.5) + s.fph);
      const dim = this._quiet > 0.4 ? (0.72 + 0.28 * Math.sin(t * 0.9 + s.fph * 3)) : 1;
      const I = Math.min(1.35, iBase * flick * dim);
      spotVals.push(x, I);
      cxAcc += x * I; iAcc += I;
    }
    const bedCx = iAcc > 1e-4 ? cxAcc / iAcc : 0.5;

    // ── cooling: quiet chokes the flame, bass/tension/drop let it climb ───
    const coolMul = Math.min(2.8, Math.max(0.5,
      (1.05 + this._quiet * 1.5 - this._bassSm * 0.28 - tension * 0.12
        - this._surge * 0.10) * (1 - this._fo * 0.55)
        * (1 - this._tapEnv * 0.45)));   // let a tap fireball live and rise

    // ── sparks: continuous leak from hot tongue tips; kick = modest puff ──
    const sparkRate = (0.10 + this._energy * 0.85 + this._bassSm * 0.30)
                    * (1 - this._quiet * 0.97);
    const sparkBurst = this._puff * 1.3;

    // no accumulation trails — the sim supplies all motion; streaks are
    // geometric. fadePass(0) clears, flame writes opaque, sparks add.
    const u = buildUniforms(bands, timeMs, deltaMs, params, this.canvas, this.frameCount, 1);
    device.queue.writeBuffer(this.uniformBuffer, 0, u);

    const e = this._extra;
    e[0] = this._gw;  e[1] = this._gh;    e[2] = this._quiet; e[3] = 0;
    e[4] = coolMul;   e[5] = this._lean;  e[6] = this._fo;    e[7] = 0;
    e[8] = this._tapX; e[9] = this._tapY; e[10] = this._tapEnv; e[11] = this._tapAge;
    for (let k = 0; k < N_SPOTS * 2; k++) e[12 + k] = spotVals[k];   // extra[3..5]
    e[24] = sparkRate; e[25] = sparkBurst; e[26] = this._glow; e[27] = this._energy;
    e[28] = bedCx;     e[29] = this._highSm; e[30] = this._pop; e[31] = this._popX;
    device.queue.writeBuffer(this.uniformBuffer, RIPPLE_OFFSET, e);

    if (typeof window !== 'undefined' && window.__pyroDebug) {
      window.__pyroDbg = { bassSm: this._bassSm, energy: this._energy,
        quiet: this._quiet, fo: this._fo, surge: this._surge, glow: this._glow,
        coolMul, sparkRate, bedCx, lean: this._lean };
    }
  }

  draw(device, view) {
    this.post.ensureTargets();
    const enc = device.createCommandEncoder();

    // fire sim step (ping-pong), then sparks sample the fresh grid
    const cp = enc.beginComputePass();
    cp.setPipeline(this.simPipeline);
    cp.setBindGroup(0, this._simBG[this._cur]);
    cp.dispatchWorkgroups(Math.ceil(this._gw / 16), Math.ceil(this._gh / 16));
    cp.end();
    this._cur = 1 - this._cur;
    const sp = enc.beginComputePass();
    sp.setPipeline(this.sparkSimPipeline);
    sp.setBindGroup(0, this._sparkSimBG[this._cur]);
    sp.dispatchWorkgroups(Math.ceil(N_SPARKS / 64));
    sp.end();

    this.post.fadePass(enc, 0, this._params);
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.post.accumView, loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(this.renderPipeline);
    pass.setBindGroup(0, this._renderBG[this._cur]);
    pass.draw(3);
    pass.setPipeline(this.sparkRenderPipeline);
    pass.setBindGroup(0, this.sparkRenderBG);
    pass.draw(N_SPARKS * 6);
    pass.end();
    this.post.finish(enc, view, this._params);
    device.queue.submit([enc.finish()]);
  }

  destroy() {
    this.gridBuffers?.forEach(b => b.destroy());
    this.sparkBuffer?.destroy();
    this.uniformBuffer?.destroy();
    this.post?.destroy();
  }
}
