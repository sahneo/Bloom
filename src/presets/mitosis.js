import shaderSource from '../shaders/mitosis.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

// MITOSIS — living cells under a dark-field microscope. JS simulates the
// colony (soft-body repulsion, Brownian drift, division/apoptosis lifecycle)
// and hands cell state to a fullscreen SDF shader via a storage buffer.
//
// Lifecycle: drops and every N bars pinch a mature cell in two (~1.6 s:
// stretch → waist → snap → daughters jiggle apart). Quiet passages shrink
// small cells away (apoptosis) so the colony breathes with the set.
// Music: bass = breathing, mid = membrane ripple, high = organelle shimmer,
// snare = Brownian jolt, kick = nuclei flash, tension = colony packs tight.
// Taps poke the nearest cell (dent + jiggle + drift); a poke deep inside a
// big cell triggers its division. Hands (gestMode 2) herd cells away.

const MAX_CELLS   = 24;
const CELL_STRIDE = 12;           // floats per cell (3 × vec4)
const DIVIDE_SECS = 1.6;

const rand  = () => Math.random();
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5);

export class MitosisPreset {
  constructor() {
    this.frameCount = 0;
    this._params = null;
    this._extra = new Float32Array(64);
    this._cellData = new Float32Array(MAX_CELLS * CELL_STRIDE);
    this._cells = [];
    this._bassEnv = 0; this._midEnv = 0; this._highEnv = 0;
    this._kickEnv = 0; this._snareEnv = 0; this._dropEnv = 0;
    this._prevKick = 0; this._prevSnare = 0; this._prevDrop = 0;
    this._prevTapN = null;
    this._prevBar = null;
    this._barCount = 0;
    this._energyEma = 0.3;
    this._lastDeathT = -10;
    this._prevSceneSeed = null;
  }

  // ── colony helpers ───────────────────────────────────────────────────────

  _spawnCell(x, y, r, opts = {}) {
    return {
      x, y, r,
      vx: opts.vx ?? 0, vy: opts.vy ?? 0,
      seed: rand() * 100,
      sizeVar: 0.85 + rand() * 0.35,
      state: 0,               // 0 alive, 1 dividing, 2 dying
      q: 0, dirX: 0, dirY: 0,
      wob: opts.wob ?? 0,
      born: opts.born ?? 0,
      alpha: 1,
      dentX: 0, dentY: 0,
    };
  }

  _seedColony(asp) {
    this._cells = [];
    const n = 8 + Math.floor(rand() * 4);
    for (let tries = 0; tries < 400 && this._cells.length < n; tries++) {
      const r = 0.16 + rand() * 0.10;
      const x = (rand() * 2 - 1) * (asp * 0.7 - r);
      const y = (rand() * 2 - 1) * (0.72 - r);
      let ok = true;
      for (const c of this._cells) {
        if (Math.hypot(c.x - x, c.y - y) < c.r + r + 0.03) { ok = false; break; }
      }
      if (ok) this._cells.push(this._spawnCell(x, y, r));
    }
  }

  _matureR() {
    const pop = this._cells.length;
    return Math.min(0.34, Math.max(0.13, 1.35 / Math.sqrt(pop * 2 + 6)));
  }

  // Start dividing the largest ready cell. fromDrop divisions are never
  // skipped: at the population cap the smallest cell is sacrificed first.
  _divideOne(fromDrop, preferred = null) {
    if (this._cells.length >= MAX_CELLS) {
      if (!fromDrop) return false;
      this._killSmallest();
      if (this._cells.length >= MAX_CELLS) return false;
    }
    let cell = preferred;
    if (!cell || cell.state !== 0) {
      cell = null;
      for (const c of this._cells) {
        if (c.state === 0 && c.r > 0.10 && (!cell || c.r > cell.r)) cell = c;
      }
    }
    if (!cell) return false;
    cell.state = 1;
    cell.q = 0;
    const a = rand() * Math.PI * 2;
    cell.dirX = Math.cos(a);
    cell.dirY = Math.sin(a);
    cell.wob = Math.min(cell.wob + 0.35, 1.2);
    return true;
  }

  _killSmallest() {
    let cell = null;
    for (const c of this._cells) {
      if (c.state === 0 && (!cell || c.r < cell.r)) cell = c;
    }
    if (cell) { cell.state = 2; this._lastDeathT = this._t; }
  }

  // ── GPU setup ────────────────────────────────────────────────────────────

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;
    const module = device.createShaderModule({ label: 'mitosis', code: shaderSource });

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.cellBuffer = device.createBuffer({
      size: MAX_CELLS * CELL_STRIDE * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.bgl = device.createBindGroupLayout({
      label: 'mitosis-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' } },
      ],
    });
    this.pipeline = device.createRenderPipeline({
      label: 'mitosis',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bgl] }),
      vertex:   { module, entryPoint: 'vs_fullscreen' },
      fragment: { module, entryPoint: 'fs_render', targets: [{ format: ACCUM_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });
    this.bindGroup = device.createBindGroup({
      layout: this.bgl,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.cellBuffer } },
      ],
    });

    this._seedColony(canvas.width / Math.max(canvas.height, 1));

    this.post = new PostFX();
    this.post.init(device, format, canvas);
    if (typeof window !== 'undefined') window.__mitosis = this;   // debug/test hook
  }

  // ── simulation ───────────────────────────────────────────────────────────

  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._params = params;
    const dt  = Math.min(deltaMs * 0.001, 0.05);
    const t   = timeMs * 0.001;
    this._t = t;
    const asp = this.canvas.width / Math.max(this.canvas.height, 1);
    const cells = this._cells;

    // envelopes: fast attack, musical release
    const env = (cur, x, atk, rel) =>
      cur + (x - cur) * (1 - Math.exp(-dt / (x > cur ? atk : rel)));
    this._bassEnv = env(this._bassEnv, bands.bass ?? 0, 0.05, 0.30);
    this._midEnv  = env(this._midEnv,  bands.mid  ?? 0, 0.05, 0.25);
    this._highEnv = env(this._highEnv, bands.high ?? 0, 0.03, 0.18);

    const kick = bands.kick ?? 0;
    if (kick > 0.45 && this._prevKick <= 0.45) this._kickEnv = Math.min(0.4 + kick * 0.7, 1.1);
    this._prevKick = kick;
    this._kickEnv *= Math.exp(-dt * 8);

    const snare = bands.snare ?? 0;
    const snareHit = snare > 0.5 && this._prevSnare <= 0.5;
    if (snareHit) this._snareEnv = Math.min(0.5 + snare * 0.6, 1.1);
    this._prevSnare = snare;
    this._snareEnv *= Math.exp(-dt * 6);

    // sceneSeed re-roll: new organelle layouts, same colony geometry
    const ss = params.sceneSeed ?? 0;
    if (this._prevSceneSeed !== null && ss !== this._prevSceneSeed) {
      for (const c of cells) c.seed = rand() * 100;
    }
    this._prevSceneSeed = ss;

    // ── division triggers ──────────────────────────────────────────────────
    const drop = params.dropPulse ?? 0;
    if (drop > 0.5 && this._prevDrop <= 0.5) {
      this._dropEnv = 1;
      this._divideOne(true);
    }
    this._prevDrop = drop;
    this._dropEnv *= Math.exp(-dt * 3);

    const bp = params.barPos ?? 0;
    if (this._prevBar !== null && bp < this._prevBar - 2) {
      this._barCount++;
      const interval = cells.length < 8 ? 4 : 12;
      if (this._barCount % interval === 0) this._divideOne(false);
    }
    this._prevBar = bp;

    // low population failsafe (even without beat tracking)
    if (cells.length < 5 && this.frameCount % 240 === 0) this._divideOne(false);

    // ── apoptosis in quiet passages ────────────────────────────────────────
    const energy = ((bands.bass ?? 0) + (bands.mid ?? 0) + (bands.high ?? 0)) / 3;
    this._energyEma = env(this._energyEma, energy, 2.5, 2.5);
    if (this._energyEma < 0.10 && cells.length > 9 && t - this._lastDeathT > 6) {
      this._killSmallest();
    }

    // ── tap poke ───────────────────────────────────────────────────────────
    const tapN = params.cymTapN ?? 0;
    if (this._prevTapN === null) {
      this._prevTapN = tapN;
    } else if (tapN !== this._prevTapN) {
      this._prevTapN = tapN;
      const tx = ((params.cymTapX ?? 0.5) * 2 - 1) * asp;
      const ty = 1 - (params.cymTapY ?? 0.5) * 2;
      let best = null, bestD = 1e9;
      for (const c of cells) {
        const d = Math.hypot(c.x - tx, c.y - ty) - c.r;
        if (d < bestD) { bestD = d; best = c; }
      }
      if (best) {
        const dx = best.x - tx, dy = best.y - ty;
        const len = Math.hypot(dx, dy) || 1e-4;
        const px = dx / len, py = dy / len;          // away from the tap
        best.vx += px * 0.55;
        best.vy += py * 0.55;
        best.wob = Math.min(best.wob + 0.9, 1.4);
        const amp = 0.55;
        best.dentX = -px * amp;                       // dent on the tapped side
        best.dentY = -py * amp;
        // a hard poke deep inside a big cell splits it
        if (bestD < -best.r * 0.15 && best.state === 0 &&
            best.r > this._matureR() * 0.9 && cells.length < MAX_CELLS) {
          this._divideOne(false, best);
          best.dirX = -py; best.dirY = px;            // cleave across the poke
        }
      }
    }

    // ── per-cell dynamics ──────────────────────────────────────────────────
    const matureR = this._matureR();
    const center  = 0.05 + (params.tension ?? 0) * 0.55;
    const hands   = (params.gestMode === 2 && params.hands) ? params.hands.h : null;

    for (let i = cells.length - 1; i >= 0; i--) {
      const c = cells[i];

      // growth toward the (population-dependent) mature radius
      if (c.state === 0) {
        c.r += (matureR * c.sizeVar - c.r) * (1 - Math.exp(-dt / 14));
      }

      // division progress → snap into daughters
      if (c.state === 1) {
        c.q += dt / DIVIDE_SECS;
        if (c.q >= 1) {
          const sep = c.r * 1.05, rl = c.r * 0.74;
          for (const s of [1, -1]) {
            const d = this._spawnCell(
              c.x + c.dirX * sep * s, c.y + c.dirY * sep * s, rl,
              { vx: c.vx + c.dirX * 0.22 * s, vy: c.vy + c.dirY * 0.22 * s,
                wob: 0.9, born: 1 });
            cells.push(d);
          }
          cells.splice(i, 1);
          continue;
        }
      }

      // apoptosis shrink
      if (c.state === 2) {
        c.r *= Math.exp(-dt / 1.8);
        c.alpha = Math.max(c.alpha - dt / 3.5, 0);
        if (c.r < 0.03 || c.alpha <= 0) { cells.splice(i, 1); continue; }
      }

      // Brownian drift (OU) + snare jolt
      const sigma = 0.11;
      c.vx += gauss() * sigma * Math.sqrt(dt);
      c.vy += gauss() * sigma * Math.sqrt(dt);
      if (snareHit) {
        const a = rand() * Math.PI * 2, s = 0.10 + rand() * 0.12;
        c.vx += Math.cos(a) * s;
        c.vy += Math.sin(a) * s;
      }

      // tension pulls the colony toward centre
      c.vx += -c.x * center * dt;
      c.vy += -c.y * center * dt;

      // hands herd cells away, like a pipette tip
      if (hands) {
        for (let h = 0; h < 2; h++) {
          const s = hands[h];
          if (!s || !(s.present > 0.5)) continue;
          const hx = (s.x * 2 - 1) * asp, hy = 1 - s.y * 2;
          const dx = c.x - hx, dy = c.y - hy;
          const d = Math.hypot(dx, dy);
          if (d < 0.75 && d > 1e-4) {
            const f = (0.75 - d) * 2.4 * dt;
            c.vx += (dx / d) * f;
            c.vy += (dy / d) * f;
          }
        }
      }

      // damping + integrate
      const damp = Math.exp(-dt * 1.4);
      c.vx *= damp; c.vy *= damp;
      c.x += c.vx * dt;
      c.y += c.vy * dt;

      // soft containment in the field of view
      const bx = asp - c.r - 0.06, by = 1 - c.r - 0.06;
      if (c.x >  bx) c.vx -= (c.x - bx) * 10 * dt;
      if (c.x < -bx) c.vx -= (c.x + bx) * 10 * dt;
      if (c.y >  by) c.vy -= (c.y - by) * 10 * dt;
      if (c.y < -by) c.vy -= (c.y + by) * 10 * dt;

      // envelopes decay
      c.wob *= Math.exp(-dt * 1.8);
      c.born *= Math.exp(-dt * 2.2);
      c.dentX *= Math.exp(-dt * 2.5);
      c.dentY *= Math.exp(-dt * 2.5);
    }

    // soft-body repulsion — cells tile without overlapping
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i], b = cells[j];
        const ra = a.r * (1 + a.q * 0.5), rb = b.r * (1 + b.q * 0.5);
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 1e-4;
        const minD = ra + rb + 0.025;
        if (dist < minD) {
          const push = (minD - dist) * 5.5 * dt;
          const nx = dx / dist, ny = dy / dist;
          a.vx -= nx * push; a.vy -= ny * push;
          b.vx += nx * push; b.vy += ny * push;
        }
      }
    }

    // ── pack GPU buffers ───────────────────────────────────────────────────
    const f = this._cellData;
    f.fill(0);
    for (let i = 0; i < cells.length && i < MAX_CELLS; i++) {
      const c = cells[i], o = i * CELL_STRIDE;
      f[o]     = c.x;    f[o + 1] = c.y;    f[o + 2]  = c.r;     f[o + 3]  = c.seed;
      f[o + 4] = c.q;    f[o + 5] = c.dirX; f[o + 6]  = c.dirY;  f[o + 7]  = c.wob;
      f[o + 8] = c.alpha; f[o + 9] = c.born; f[o + 10] = c.dentX; f[o + 11] = c.dentY;
    }

    const e = this._extra;
    e[0] = this._bassEnv; e[1] = this._midEnv; e[2] = this._highEnv; e[3] = this._kickEnv;
    e[4] = this._snareEnv;
    e[5] = Math.min(cells.length, MAX_CELLS);
    e[6] = this._dropEnv;
    e[7] = 0.62 + Math.min(this._energyEma * 1.6, 0.38);   // quiet-passage dim

    const u = buildUniforms(bands, timeMs, deltaMs, params, this.canvas, this.frameCount, 1);
    device.queue.writeBuffer(this.uniformBuffer, 0, u);
    device.queue.writeBuffer(this.uniformBuffer, RIPPLE_OFFSET, e);
    device.queue.writeBuffer(this.cellBuffer, 0, f);
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
    this.cellBuffer?.destroy();
    if (typeof window !== 'undefined' && window.__mitosis === this) delete window.__mitosis;
  }
}
