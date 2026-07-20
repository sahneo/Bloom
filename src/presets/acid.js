import computeSource from '../shaders/acid_compute.wgsl?raw';
import renderSource  from '../shaders/acid_render.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

// ACID — a real liquid light show. A 2D incompressible fluid solver (stable
// fluids, half-res grid ≤640×400) is the ONLY thing that moves pixels; music
// never sets visual parameters directly, it only applies FORCES:
//   bass  → heat at 2-3 slowly wandering projector "lamps" (blobs billow up)
//   kick  → one impulse jet at a random angle near a lamp (≤1 per 0.35 s);
//           the vortex it sheds then lives and decays on its own
//   mid   → slow global stir (two wandering counter-rotating gyres)
//   high  → render-only surface shimmer
//   tension → viscosity drops, the fluid gets livelier toward the drop
//   drop  → strong radial surge + fresh accent dye poured in the centre —
//           the tank swirls itself into a new colour scheme over seconds
// Quiet = lamps dim to a lava-lamp idle; dye diffuses gently.
// Tap = finger stir (velocity + dye splat). HANDS: palm drags, fist sucks.

const JACOBI_ITERS = 24;

// EMA envelope: fast attack, slow release (seconds)
function ema(cur, target, dt, atk, rel) {
  const tau = target > cur ? atk : rel;
  return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}

function hsvToRgb(h, s, v) {
  h = ((h % 1) + 1) % 1;
  const f = (n) => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

export class AcidPreset {
  constructor() {
    this.frameCount = 0;
    this._params = null;
    this._extra = new Float32Array(64);
    this._gw = 0; this._gh = 0;
    this._dyeCur = 0;
    this._seed = Math.random() * 100;

    // band envelopes
    this._env = { bass: 0, mid: 0, high: 0 };
    this._quiet = 1;

    // kick jet
    this._prevKick = 0;
    this._jetGap = 10;
    this._jetEnv = 0;
    this._jet = { x: 0.5, y: 0.7, dx: 0, dy: -1 };

    // drop
    this._prevDrop = 0;
    this._dropEnv = 0;
    this._dropDyeEnv = 0;

    // tap
    this._prevTapN = null;
    this._tapEnv = 0;
    this._tap = { x: 0.5, y: 0.5, dx: 0, dy: 0 };
    this._tapCycle = 0;

    // hands: smoothed velocities
    this._hand = [
      { px: 0.5, py: 0.5, vx: 0, vy: 0 },
      { px: 0.5, py: 0.5, vx: 0, vy: 0 },
    ];

    // palette (eased; snapped on drops — the dye field itself crossfades)
    this._palShift = 0;
    this._accentOff = 0.47;
    this._cA = hsvToRgb(0.3, 0.95, 1);
    this._cB = hsvToRgb(0.4, 0.88, 0.95);
    this._cC = hsvToRgb(0.8, 1, 1);
    this._cBg = [0.03, 0.025, 0.035];
    this._tapCol = [...this._cC];

    // lamp positions (eased toward slow wander targets)
    this._lamps = [0, 1, 2].map(i => ({ x: 0.25 + i * 0.25, y: 0.72, heat: 0 }));
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;
    this._computeModule = device.createShaderModule({ label: 'acid-compute', code: computeSource });
    this._renderModule  = device.createShaderModule({ label: 'acid-render',  code: renderSource  });

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const C = GPUShaderStage.COMPUTE;
    const uni = { binding: 0, visibility: C, buffer: { type: 'uniform' } };
    const ro  = (b) => ({ binding: b, visibility: C, buffer: { type: 'read-only-storage' } });
    const rw  = (b) => ({ binding: b, visibility: C, buffer: { type: 'storage' } });

    // explicit BGLs per pass — bindings match acid_compute.wgsl numbering
    this._bglAdvVel  = device.createBindGroupLayout({ entries: [uni, ro(1), rw(2)] });
    this._bglForces  = device.createBindGroupLayout({ entries: [uni, ro(1), rw(2), ro(3)] });
    this._bglDiv     = device.createBindGroupLayout({ entries: [uni, ro(1), rw(7)] });
    this._bglJacobi  = device.createBindGroupLayout({ entries: [uni, ro(5), rw(6), rw(7)] });
    this._bglProject = device.createBindGroupLayout({ entries: [uni, rw(2), ro(5)] });
    this._bglAdvDye  = device.createBindGroupLayout({ entries: [uni, ro(1), ro(3), rw(4)] });
    this._bglRender  = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });

    const cpipe = (bgl, entryPoint) => device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      compute: { module: this._computeModule, entryPoint },
    });
    this.pipeAdvVel  = cpipe(this._bglAdvVel,  'cs_advect_vel');
    this.pipeForces  = cpipe(this._bglForces,  'cs_forces');
    this.pipeDiv     = cpipe(this._bglDiv,     'cs_divergence');
    this.pipeJacobi  = cpipe(this._bglJacobi,  'cs_jacobi');
    this.pipeProject = cpipe(this._bglProject, 'cs_project');
    this.pipeAdvDye  = cpipe(this._bglAdvDye,  'cs_advect_dye');

    this.renderPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._bglRender] }),
      vertex:   { module: this._renderModule, entryPoint: 'vs_fullscreen' },
      fragment: { module: this._renderModule, entryPoint: 'fs_render', targets: [{ format: ACCUM_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });

    this._ensureGrid();
    this.post = new PostFX();
    this.post.init(device, format, canvas);
  }

  // half-res sim grid, capped 640×400 — rebuilt on resize
  _ensureGrid() {
    const gw = Math.min(Math.max(Math.round(this.canvas.width  / 2), 160), 640);
    const gh = Math.min(Math.max(Math.round(this.canvas.height / 2), 100), 400);
    if (gw === this._gw && gh === this._gh) return;
    this._gw = gw; this._gh = gh;
    const device = this.device;
    const n = gw * gh;

    for (const b of [...(this._velBuf ?? []), ...(this._pBuf ?? []), ...(this._dyeBuf ?? []), this._divBuf]) b?.destroy();
    const mk = (bytes) => device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE });
    this._velBuf = [mk(n * 8), mk(n * 8)];   // vec2f, A = canonical, B = scratch
    this._pBuf   = [mk(n * 4), mk(n * 4)];   // pressure ping-pong (result in [0])
    this._divBuf = mk(n * 4);
    this._dyeBuf = [mk(n * 16), mk(n * 16)]; // vec4f rgb + heat

    const u = { binding: 0, resource: { buffer: this.uniformBuffer } };
    const r = (b, buf) => ({ binding: b, resource: { buffer: buf } });
    const bg = (layout, entries) => device.createBindGroup({ layout, entries });

    this._bgAdvVel = bg(this._bglAdvVel, [u, r(1, this._velBuf[0]), r(2, this._velBuf[1])]);
    this._bgForces = [0, 1].map(d => bg(this._bglForces,
      [u, r(1, this._velBuf[1]), r(2, this._velBuf[0]), r(3, this._dyeBuf[d])]));
    this._bgDiv = bg(this._bglDiv, [u, r(1, this._velBuf[0]), r(7, this._divBuf)]);
    this._bgJacobi = [0, 1].map(j => bg(this._bglJacobi,
      [u, r(5, this._pBuf[j]), r(6, this._pBuf[1 - j]), r(7, this._divBuf)]));
    this._bgProject = bg(this._bglProject, [u, r(2, this._velBuf[0]), r(5, this._pBuf[0])]);
    this._bgAdvDye = [0, 1].map(d => bg(this._bglAdvDye,
      [u, r(1, this._velBuf[0]), r(3, this._dyeBuf[d]), r(4, this._dyeBuf[1 - d])]));
    this._bgRender = [0, 1].map(d => bg(this._bglRender, [u, r(1, this._dyeBuf[d])]));
    this._dyeCur = 0;
  }

  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._params = params;
    this._ensureGrid();
    const dt = Math.min(deltaMs * 0.001, 0.033);
    const t  = timeMs * 0.001;

    // ── envelopes: forces are shaped here, motion is shaped by the fluid ──
    this._env.bass = ema(this._env.bass, bands.bass ?? 0, dt, 0.12, 1.4);
    this._env.mid  = ema(this._env.mid,  bands.mid  ?? 0, dt, 0.10, 0.9);
    this._env.high = ema(this._env.high, bands.high ?? 0, dt, 0.08, 0.5);
    const energy = (this._env.bass + this._env.mid + this._env.high) / 3;
    this._quiet = ema(this._quiet, 1 - Math.min(energy * 3, 1), dt, 2.0, 1.0);
    const tension = params.tension ?? 0;

    // ── kick → one impulse jet near a lamp, rate-limited 0.35 s ──────────
    const kick = bands.kick ?? 0;
    this._jetGap += dt;
    if (kick > 0.42 && this._prevKick <= 0.42 && this._jetGap > 0.24) {
      this._jetGap = 0;
      const lamp = this._lamps[(Math.random() * 3) | 0];
      const a = Math.random() * Math.PI * 2;
      this._jet = {
        x: lamp.x + (Math.random() - 0.5) * 0.10,
        y: lamp.y + (Math.random() - 0.5) * 0.08,
        dx: Math.cos(a), dy: Math.sin(a),
      };
      this._jetEnv = Math.min(0.85 + kick * 0.7, 1.6);
    }
    this._prevKick = kick;
    this._jetEnv *= Math.exp(-dt * 9);      // ~110 ms of push; the vortex outlives it

    // ── drop → radial surge + fresh dye, palette re-rolls ────────────────
    const drop = params.dropPulse ?? 0;
    if (drop > 0.5 && this._prevDrop <= 0.5) {
      this._dropEnv = 1;
      this._dropDyeEnv = 1;
      this._palShift = 0.15 + Math.random() * 0.7;
      this._accentOff = 0.42 + Math.random() * 0.16;
      this._snapPalette(params);            // fresh dye arrives in the new scheme
    }
    this._prevDrop = drop;
    this._dropEnv    *= Math.exp(-dt * 2.0);
    this._dropDyeEnv *= Math.exp(-dt * 0.5);

    // ── tap → finger stir ────────────────────────────────────────────────
    const tapN = params.cymTapN ?? 0;
    if (this._prevTapN === null) this._prevTapN = tapN;
    if (tapN !== this._prevTapN) {
      this._prevTapN = tapN;
      const a = Math.random() * Math.PI * 2;
      this._tap = { x: params.cymTapX ?? 0.5, y: params.cymTapY ?? 0.5, dx: Math.cos(a), dy: Math.sin(a) };
      this._tapEnv = 1;
      this._tapCycle = (this._tapCycle + 1) % 3;
      this._tapCol = [this._cC, this._cA, this._cB][this._tapCycle].slice();
    }
    this._tapEnv *= Math.exp(-dt * 5);

    // ── lamps wander slowly; bass is their heat ──────────────────────────
    const heat = (0.24 + this._env.bass * 1.7) * (1 - this._quiet * 0.28);
    const easeL = 1 - Math.exp(-dt * 0.5);
    for (let i = 0; i < 3; i++) {
      const s = this._seed + i * 17.9;
      const tx = 0.25 + i * 0.25 + Math.sin(t * (0.017 + i * 0.006) + s) * 0.13;
      const ty = 0.70 + Math.sin(t * (0.023 + i * 0.005) + s * 2.3) * 0.11;
      const L = this._lamps[i];
      L.x += (tx - L.x) * easeL;
      L.y += (ty - L.y) * easeL;
      // episodic "burps" — lamps breathe out discrete blobs like a lava lamp
      const burp = Math.pow(0.5 + 0.5 * Math.sin(t * (0.24 + i * 0.06) + s), 2.5);
      L.heat = heat * (0.45 + 1.15 * burp);
    }

    // ── hands: smoothed palm velocity (drag force in the shader) ─────────
    const hands = (params.gestMode === 2 && params.hands) ? params.hands.h : null;
    for (let h = 0; h < 2; h++) {
      const s = hands?.[h];
      const H = this._hand[h];
      if (s?.present > 0.1) {
        const k = 1 - Math.exp(-dt / 0.12);
        H.vx += ((s.x - H.px) / Math.max(dt, 1e-3) - H.vx) * k;
        H.vy += ((s.y - H.py) / Math.max(dt, 1e-3) - H.vy) * k;
        H.vx = Math.max(-3, Math.min(3, H.vx));
        H.vy = Math.max(-3, Math.min(3, H.vy));
        H.px = s.x; H.py = s.y;
      } else {
        H.vx *= Math.exp(-dt * 8); H.vy *= Math.exp(-dt * 8);
        H.px = s?.x ?? H.px; H.py = s?.y ?? H.py;
      }
    }

    // ── palette: saturated acid colours keyed to keyHue ──────────────────
    this._easePalette(params, dt);

    // ── pack extra slots (layout documented in acid_compute.wgsl) ────────
    const e = this._extra;
    e[0] = this._gw; e[1] = this._gh; e[2] = dt; e[3] = this._env.high;
    const lampR = this._gw * 0.075;
    for (let i = 0; i < 3; i++) {
      const L = this._lamps[i];
      e[4 + i * 4] = L.x; e[5 + i * 4] = L.y; e[6 + i * 4] = L.heat;
    }
    e[7]  = lampR;
    e[11] = this._env.mid * 1.5;                             // stir
    e[15] = Math.exp(-dt * (0.9 - tension * 0.62));          // velocity damping
    e[16] = this._jet.x;  e[17] = this._jet.y;  e[18] = this._jet.dx; e[19] = this._jet.dy;
    e[20] = this._jetEnv; e[21] = this._dropEnv; e[22] = this._tapEnv; e[23] = this._dropDyeEnv;
    e[24] = this._tap.x;  e[25] = this._tap.y;  e[26] = this._tap.dx; e[27] = this._tap.dy;
    const h0 = this._hand[0], h1 = this._hand[1];
    e[28] = h0.px; e[29] = h0.py; e[30] = h0.vx; e[31] = h0.vy;
    e[32] = hands?.[0]?.present ?? 0; e[33] = hands?.[0]?.grip ?? 0;
    e[34] = hands?.[1]?.present ?? 0; e[35] = hands?.[1]?.grip ?? 0;
    e[36] = h1.px; e[37] = h1.py; e[38] = h1.vx; e[39] = h1.vy;
    e[40] = this._cA[0]; e[41] = this._cA[1]; e[42] = this._cA[2];
    e[43] = 2.4 + tension * 1.2;                             // vorticity confinement ε
    e[44] = this._cB[0]; e[45] = this._cB[1]; e[46] = this._cB[2];
    e[47] = this._quiet;
    e[48] = this._cC[0]; e[49] = this._cC[1]; e[50] = this._cC[2];
    e[51] = energy;
    e[52] = this._cBg[0]; e[53] = this._cBg[1]; e[54] = this._cBg[2];
    e[55] = 0.55;                                            // grain (light)
    e[56] = 78;                                              // buoyancy
    e[57] = 2.4;                                             // dye injection rate
    e[58] = Math.exp(-dt * 0.16);                            // dye dissipation
    e[59] = Math.exp(-dt * 0.60);                            // heat dissipation
    e[60] = this._tapCol[0]; e[61] = this._tapCol[1]; e[62] = this._tapCol[2];
    e[63] = this.canvas.width / Math.max(this.canvas.height, 1);

    const u = buildUniforms(bands, timeMs, deltaMs, params, this.canvas, this.frameCount, 1);
    device.queue.writeBuffer(this.uniformBuffer, 0, u);
    device.queue.writeBuffer(this.uniformBuffer, RIPPLE_OFFSET, e);
  }

  _paletteTargets(params) {
    const base = ((params?.keyHue ?? 0) + this._palShift) % 1;
    return {
      A:  hsvToRgb(base, 0.95, 1.0),
      B:  hsvToRgb(base + 0.10, 0.88, 0.95),
      C:  hsvToRgb(base + this._accentOff, 1.0, 1.0),
      Bg: hsvToRgb(base + 0.55, 0.35, 0.05),
    };
  }

  _snapPalette(params) {
    const T = this._paletteTargets(params);
    this._cA = T.A; this._cB = T.B; this._cC = T.C; this._cBg = T.Bg;
  }

  _easePalette(params, dt) {
    const T = this._paletteTargets(params);
    const k = 1 - Math.exp(-dt / 2.0);
    for (let i = 0; i < 3; i++) {
      this._cA[i]  += (T.A[i]  - this._cA[i])  * k;
      this._cB[i]  += (T.B[i]  - this._cB[i])  * k;
      this._cC[i]  += (T.C[i]  - this._cC[i])  * k;
      this._cBg[i] += (T.Bg[i] - this._cBg[i]) * k;
    }
  }

  draw(device, view) {
    this.post.ensureTargets();
    const enc = device.createCommandEncoder();

    const wx = Math.ceil(this._gw / 16), wy = Math.ceil(this._gh / 16);
    const cp = enc.beginComputePass();
    cp.setPipeline(this.pipeAdvVel);  cp.setBindGroup(0, this._bgAdvVel);              cp.dispatchWorkgroups(wx, wy);
    cp.setPipeline(this.pipeForces);  cp.setBindGroup(0, this._bgForces[this._dyeCur]); cp.dispatchWorkgroups(wx, wy);
    cp.setPipeline(this.pipeDiv);     cp.setBindGroup(0, this._bgDiv);                 cp.dispatchWorkgroups(wx, wy);
    cp.setPipeline(this.pipeJacobi);
    for (let it = 0; it < JACOBI_ITERS; it++) {              // even count → result lands in pBuf[0]
      cp.setBindGroup(0, this._bgJacobi[it & 1]);
      cp.dispatchWorkgroups(wx, wy);
    }
    cp.setPipeline(this.pipeProject); cp.setBindGroup(0, this._bgProject);             cp.dispatchWorkgroups(wx, wy);
    cp.setPipeline(this.pipeAdvDye);  cp.setBindGroup(0, this._bgAdvDye[this._dyeCur]); cp.dispatchWorkgroups(wx, wy);
    cp.end();
    this._dyeCur = 1 - this._dyeCur;

    this.post.fadePass(enc, 0, this._params);
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.post.accumView, loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(this.renderPipeline);
    pass.setBindGroup(0, this._bgRender[this._dyeCur]);
    pass.draw(3);
    pass.end();
    this.post.finish(enc, view, this._params);
    device.queue.submit([enc.finish()]);
  }

  destroy() {
    for (const b of [...(this._velBuf ?? []), ...(this._pBuf ?? []), ...(this._dyeBuf ?? []), this._divBuf]) b?.destroy();
    this.post?.destroy();
  }
}
