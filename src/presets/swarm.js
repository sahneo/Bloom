import computeSource from '../shaders/swarm_compute.wgsl?raw';
import renderSource  from '../shaders/swarm.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

// SWARM — a starling murmuration. ~25k boids flock as one super-organism
// against a dusk sky. Melody steers the wander target (busy passages make
// the flock restless), the kick is a predator striking into the flock's
// heart (scatter → re-gather), a drop tears the flock into two bodies that
// later merge, snare sends an alignment shiver through the whole flock.

const N = 25_000;

const SPLIT_S      = 6.0;    // how long a drop keeps the flock in two bodies
const SPLIT_MERGE  = 1.5;    // last N seconds of the split ramp back together
const SPLIT_SEP    = 0.85;   // how far apart the two targets fly

// HANDS gesture mode — hand-as-predator. Must match swarm.wgsl's camera.
const FOCAL   = 1.55;        // pinhole focal length (see vs_bird)
const HAND_Z  = 2.25;        // depth at which the hand ray meets the flock
const HAND_EXTRA = 12;       // hand data starts at extra[3] (float index 12)

export class SwarmPreset {
  constructor() {
    this.frameCount = 0;
    this._params    = null;
    this._dtMs      = 16.67;

    this._wt        = Math.random() * 100;   // wander phase (advances w/ music)
    this._restless  = 0.3;                   // melody-energy EMA
    this._tgtA      = [0, 0, 2.25];
    this._tgtB      = [0, 0, 2.25];

    this._strike    = 0;                     // predator-strike envelope
    this._strikeAge = 9;
    this._strikePt  = [0, 0, 2.25];
    this._snare     = 0;                     // alignment-surge envelope
    this._split     = 0;                     // drop split factor 0..1
    this._splitT    = 0;
    this._splitDir  = [1, 0, 0];

    this._prevKick  = 0;
    this._prevSnare = 0;
    this._prevDrop  = 0;
    this._kickCd    = 0;

    this._extra = new Float32Array(40);   // [0..11] music, [12..39] hands

    // per-hand-slot predator state (slot identity is stable upstream)
    this._hands = [
      { init: false, x: 0.5, y: 0.5, vx: 0, vy: 0, strike: 0, grip: 0, burst: 0, fisted: false },
      { init: false, x: 0.5, y: 0.5, vx: 0, vy: 0, strike: 0, grip: 0, burst: 0, fisted: false },
    ];
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;

    const computeModule = device.createShaderModule({ label: 'swarm-compute', code: computeSource });
    const renderModule  = device.createShaderModule({ label: 'swarm-render',  code: renderSource  });

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Boid storage: N × 32 B (pos.xyz+hash, vel.xyz+pad) — seeded as one
    // loose ball mid-air with gentle random headings
    this.boidBuffer = device.createBuffer({
      size: N * 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const seed = new Float32Array(N * 8);
    for (let i = 0; i < N; i++) {
      const r  = Math.cbrt(Math.random()) * 0.45;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(Math.random() * 2 - 1);
      seed[i * 8]     = r * Math.sin(ph) * Math.cos(th);
      seed[i * 8 + 1] = r * Math.sin(ph) * Math.sin(th) * 0.7;
      seed[i * 8 + 2] = 2.25 + r * Math.cos(ph) * 0.8;
      seed[i * 8 + 3] = Math.random();               // per-boid hash
      seed[i * 8 + 4] = (Math.random() - 0.5) * 0.3;
      seed[i * 8 + 5] = (Math.random() - 0.5) * 0.2;
      seed[i * 8 + 6] = (Math.random() - 0.5) * 0.3;
      seed[i * 8 + 7] = 0;
    }
    device.queue.writeBuffer(this.boidBuffer, 0, seed);

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
    const makeBindGroup = (layout) => device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.boidBuffer } },
      ],
    });
    this.computeBindGroup = makeBindGroup(computeBGL);
    this.renderBindGroup  = makeBindGroup(renderBGL);

    this.computePipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [computeBGL] }),
      compute: { module: computeModule, entryPoint: 'cs_main' },
    });

    const additive = {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    };
    const renderLayout = device.createPipelineLayout({ bindGroupLayouts: [renderBGL] });
    this.skyPipeline = device.createRenderPipeline({
      layout: renderLayout,
      vertex:   { module: renderModule, entryPoint: 'vs_sky' },
      fragment: { module: renderModule, entryPoint: 'fs_sky',
                  targets: [{ format: ACCUM_FORMAT, blend: additive }] },
      primitive: { topology: 'triangle-list' },
    });
    this.birdPipeline = device.createRenderPipeline({
      layout: renderLayout,
      vertex:   { module: renderModule, entryPoint: 'vs_bird' },
      fragment: { module: renderModule, entryPoint: 'fs_bird',
                  targets: [{ format: ACCUM_FORMAT, blend: additive }] },
      primitive: { topology: 'triangle-list' },
    });

    this.post = new PostFX();
    this.post.init(device, format, canvas);
  }

  // ── music → flock behaviour ──────────────────────────────────────────
  _updateMusic(bands, dt, params) {
    // melody energy → restlessness (busy passages agitate, pads becalm)
    const a = 1 - Math.exp(-dt / 0.6);
    const busy = Math.min(1, (bands.mid ?? 0) * 1.1 + (bands.high ?? 0) * 0.8);
    this._restless += (busy - this._restless) * a;

    // wander target on smooth incommensurate sines, phase speed rides melody
    this._wt += dt * (0.4 + this._restless * 1.7);
    const s  = (params.sceneSeed ?? 0) * 6.28318 + 1.3;
    const wt = this._wt;
    const base = [
      0.55 * Math.sin(wt * 0.230 + s)       + 0.25 * Math.sin(wt * 0.109 + s * 2.3),
      0.22 * Math.sin(wt * 0.171 + s * 1.4) + 0.10 * Math.sin(wt * 0.083 + s * 3.1),
      2.05 + 0.35 * Math.sin(wt * 0.131 + s * 0.7) + 0.15 * Math.sin(wt * 0.077 + s * 1.9),
    ];

    // drop → the flock is torn in two (plus a strike at the tear point)
    const drop = params.dropPulse ?? 0;
    if (drop > 0.6 && this._prevDrop <= 0.6) {
      this._splitT = SPLIT_S;
      const th = Math.random() * Math.PI * 2;
      let d = [Math.cos(th), (Math.random() - 0.5) * 0.4, Math.sin(th) * 0.55];
      const l = Math.hypot(d[0], d[1], d[2]);
      this._splitDir = d.map(v => v / l);
      this._strike    = Math.max(this._strike, 1.25);
      this._strikeAge = 0;
      this._strikePt  = base.slice();
    }
    this._prevDrop = drop;
    this._splitT = Math.max(0, this._splitT - dt);
    const goal = this._splitT > SPLIT_MERGE ? 1 : this._splitT / SPLIT_MERGE;
    this._split += (goal - this._split) * (1 - Math.exp(-dt * 2.5));

    const sep = SPLIT_SEP * this._split;
    // keep both bodies inside the camera frustum even at full separation
    const lim = (t) => [
      Math.max(-0.90, Math.min(0.90, t[0])),
      Math.max(-0.42, Math.min(0.42, t[1])),
      Math.max( 1.70, Math.min(3.00, t[2])),
    ];
    this._tgtA = lim(base.map((v, i) => v - this._splitDir[i] * sep));
    this._tgtB = lim(base.map((v, i) => v + this._splitDir[i] * sep));

    // kick rising edge → predator strike into the flock's heart
    this._kickCd = Math.max(0, this._kickCd - dt);
    const kick = bands.kick ?? 0;
    if (kick > 0.45 && this._prevKick < 0.35 && this._kickCd <= 0) {
      this._strike    = Math.max(this._strike, 0.55 + kick * 0.55);
      this._strikeAge = 0;
      this._kickCd    = 0.35;
      this._strikePt  = this._tgtA.map(v => v + (Math.random() - 0.5) * 0.3);
    }
    this._prevKick = kick;
    this._strikeAge += dt;
    this._strike *= Math.exp(-dt * 4.5);      // ~250 ms of terror, then re-gather

    // snare rising edge → alignment shiver
    const snare = bands.snare ?? 0;
    if (snare > 0.35 && this._prevSnare < 0.3) {
      this._snare = Math.max(this._snare, snare * 0.9);
    }
    this._prevSnare = snare;
    this._snare *= Math.exp(-dt * 7);
  }

  // ── hands → predators ─────────────────────────────────────────────────
  // Converts each present hand (canvas UV) into a world-space view ray at
  // flock depth and derives three envelopes per slot: strike (fast palm ⇒
  // panic scatter), grip (fist ⇒ grab vortex) and burst (clench moment ⇒
  // outward ring). Writes extra[3..9]; all zero unless in HANDS mode, so
  // the compute shader's hand block is inert and behaviour is unchanged.
  _updateHands(dt, params) {
    const e = this._extra;
    e.fill(0, HAND_EXTRA);                      // inert by default

    const active = params.gestMode === 2 && params.hands;
    const asp    = this.canvas.width / Math.max(this.canvas.height, 1);
    // invert the render camera: it pans by drift and rolls by driftRot*0.2
    const roll = (params.driftRot ?? 0) * 0.2;
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const offX = (params.driftX ?? 0) * 0.22;
    const offY = (params.driftY ?? 0) * 0.15;

    for (let s = 0; s < 2; s++) {
      const st = this._hands[s];
      const h  = active ? params.hands.h?.[s] : null;
      const pres = h?.present ?? 0;

      if (!h || pres < 0.02) {                  // slot empty → decay + reset
        st.init   = false;
        st.strike *= Math.exp(-dt * 3.0);
        st.burst  *= Math.exp(-dt * 3.5);
        st.grip   *= Math.exp(-dt * 6.0);
        st.fisted  = false;
        continue;
      }

      if (!st.init) {                           // fresh appearance: no fake velocity
        st.x = h.x; st.y = h.y; st.vx = 0; st.vy = 0; st.init = true;
      }
      // palm velocity in UV/s (EMA ~80 ms so a strike reads within a frame or two)
      const kv = 1 - Math.exp(-dt / 0.08);
      st.vx += ((h.x - st.x) / Math.max(dt, 1e-3) - st.vx) * kv;
      st.vy += ((h.y - st.y) / Math.max(dt, 1e-3) - st.vy) * kv;
      st.x = h.x; st.y = h.y;

      // strike envelope: fast palm ⇒ panic (0.45 UV/s onset, saturates ~1.4)
      const spd = Math.max(Math.hypot(st.vx, st.vy), params.hands.vel ?? 0);
      const t   = Math.min(Math.max((spd - 0.45) / 0.95, 0), 1);
      st.strike = Math.max(st.strike * Math.exp(-dt * 3.0), t * t * (3 - 2 * t));

      // grip smoothing + one burst impulse per clench
      st.grip += ((h.grip ?? 0) - st.grip) * (1 - Math.exp(-dt / 0.12));
      if (st.grip > 0.65 && !st.fisted) { st.burst = 1; st.fisted = true; }
      if (st.grip < 0.45) { st.fisted = false; }
      st.burst *= Math.exp(-dt * 3.5);

      // UV → world view ray (undo mirror-free UV → NDC, aspect, roll, drift)
      const ndcx = h.x * 2 - 1, ndcy = 1 - h.y * 2;    // UV y is down
      const dx = ndcx * asp / FOCAL, dy = ndcy / FOCAL;
      let wx = cr * dx + sr * dy, wy = -sr * dx + cr * dy, wz = 1;
      const dl = Math.hypot(wx, wy, wz);
      wx /= dl; wy /= dl; wz /= dl;
      const rt = HAND_Z / wz;                          // ray point at flock depth

      // palm velocity in world units at flock depth (for strike direction)
      const sx = 2 * asp * HAND_Z / FOCAL, sy = -2 * HAND_Z / FOCAL;
      const wvx = cr * (st.vx * sx) + sr * (st.vy * sy);
      const wvy = -sr * (st.vx * sx) + cr * (st.vy * sy);

      const base = HAND_EXTRA + s * 12;                // extra[3 + s*3]
      e[base]      = offX + wx * rt;
      e[base + 1]  = offY + wy * rt;
      e[base + 2]  = wz * rt;
      e[base + 3]  = pres;
      e[base + 4]  = wx; e[base + 5] = wy; e[base + 6] = wz;
      e[base + 7]  = st.grip;
      e[base + 8]  = wvx; e[base + 9] = wvy; e[base + 10] = 0;
      e[base + 11] = st.strike;
      e[36 + s]    = st.burst;                         // extra[9].x / .y
    }
  }

  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._params = params;
    this._dtMs   = deltaMs;

    const dt = Math.min(deltaMs * 0.001, 0.05);
    this._updateMusic(bands, dt, params);
    this._updateHands(dt, params);

    const { gain } = PostFX.trailFactors(params, deltaMs);
    const u = buildUniforms(bands, timeMs, deltaMs, params, this.canvas, this.frameCount, gain);
    u[41] = this._strike;               // _r1
    u[42] = this._restless;             // _r2
    u[43] = this._snare;                // _r3
    device.queue.writeBuffer(this.uniformBuffer, 0, u);

    const e = this._extra;
    e[0] = this._tgtA[0]; e[1] = this._tgtA[1]; e[2]  = this._tgtA[2];    e[3]  = this._restless;
    e[4] = this._tgtB[0]; e[5] = this._tgtB[1]; e[6]  = this._tgtB[2];    e[7]  = this._split;
    e[8] = this._strikePt[0]; e[9] = this._strikePt[1]; e[10] = this._strikePt[2]; e[11] = this._strikeAge;
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
    pass.setPipeline(this.skyPipeline);
    pass.setBindGroup(0, this.renderBindGroup);
    pass.draw(3);
    pass.setPipeline(this.birdPipeline);
    pass.setBindGroup(0, this.renderBindGroup);
    pass.draw(N * 6);
    pass.end();

    this.post.finish(enc, view, this._params);
    device.queue.submit([enc.finish()]);
  }

  destroy() {
    this.post?.destroy();
  }
}
