import computeSource from '../shaders/bz_compute.wgsl?raw';
import renderSource  from '../shaders/bz_render.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

// REAGENT — the Belousov–Zhabotinsky reaction as a hypnotic mode. An
// excitable-medium simulation (Barkley-form FitzHugh–Nagumo, see
// bz_compute.wgsl) on a half-res ping-pong grid: target-pattern rings and
// rotating spiral waves, annihilating where they collide, leaving deep
// complementary trails of refractory chemistry.
// Music is coupled as chemistry, never as direct visuals (all EMA'd):
//   bass  → excitability (threshold b drops — the whole dish breathes,
//           waves get fatter and hungrier)
//   mid   → wave speed (reaction–diffusion substeps per frame)
//   high  → sparkle of single-cell micro-excitations (mostly subcritical)
//   kick  → a fresh target-pattern ring is BORN on the beat, placed along
//           a slowly orbiting locus (rate-limited 1 / 0.4 s); tension pulls
//           the locus toward screen centre and saturates the palette
//   snare → a brief arc of excitation
//   DROP  → a wall of excitation sweeps the dish wiping the old pattern;
//           new spirals self-organize from the wake over ~4 s
//   quiet → threshold rises, substeps drop — delicate slow filigree
// Tap = touch the dish (a ring blooms from your finger). HANDS mode:
// open palm = held pacemaker source, fist = inhibitor that carves black.

export class BzPreset {
  constructor() {
    this.frameCount = 0;
    this._params = null;
    this._extra = new Float32Array(40);     // 10 × vec4 of the extra region
    this._cur = 0;                          // ping-pong index
    this._gw = 0; this._gh = 0;
    this._steps = 0; this._stepAcc = 0;
    this._bassE = 0; this._midE = 0; this._highE = 0;
    this._act = 0.2;                        // slow energy EMA → quiet detect
    this._kickEnv = 0; this._snareEnv = 0; this._tapEnv = 0; this._dropFlash = 0;
    this._prevKick = 0; this._prevSnare = 0; this._prevDrop = 0;
    this._prevTapN = null;
    this._kickCd = 0; this._snareCd = 0;
    this._orbit = Math.random() * Math.PI * 2;   // kick-seed locus angle
    this._dropT = -1;                       // <0 = no sweep running
    this._seedQueue = [];                   // { x, y, angle, code, t }
    this._reseedT = 0;
    this._needInitialSeeds = true;
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;
    this._computeModule = device.createShaderModule({ label: 'bz-compute', code: computeSource });
    this._renderModule  = device.createShaderModule({ label: 'bz-render',  code: renderSource  });

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._computeBGL = device.createBindGroupLayout({
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

    const computeLayout = device.createPipelineLayout({ bindGroupLayouts: [this._computeBGL] });
    this.seedPipeline = device.createComputePipeline({
      layout: computeLayout,
      compute: { module: this._computeModule, entryPoint: 'cs_seed' },
    });
    this.stepPipeline = device.createComputePipeline({
      layout: computeLayout,
      compute: { module: this._computeModule, entryPoint: 'cs_step' },
    });
    this.renderPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._renderBGL] }),
      vertex:   { module: this._renderModule, entryPoint: 'vs_fullscreen' },
      fragment: { module: this._renderModule, entryPoint: 'fs_render', targets: [{ format: ACCUM_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });

    this._ensureGrid();
    this.post = new PostFX();
    this.post.init(device, format, canvas);

    // debug/test hook
    if (typeof window !== 'undefined') {
      const self = this;
      window.__bz = {
        get steps() { return self._steps; },
        get grid()  { return { w: self._gw, h: self._gh }; },
        get b()     { return self._b; },
      };
    }
  }

  // reagent grid at half canvas resolution (capped) — rebuilt on resize
  _ensureGrid() {
    const gw = Math.min(Math.max(Math.round(this.canvas.width  / 2), 256), 720);
    const gh = Math.min(Math.max(Math.round(this.canvas.height / 2), 160), 450);
    if (gw === this._gw && gh === this._gh) return;
    this._gw = gw; this._gh = gh;
    this.gridBuffers?.forEach(b => b.destroy());
    const size = gw * gh * 8;               // vec2f(u, v) per cell
    this.gridBuffers = [0, 1].map(() => this.device.createBuffer({
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    }));
    // computeBG[i]: read buffers[i] → write buffers[1-i]
    this._computeBG = [0, 1].map(i => this.device.createBindGroup({
      layout: this._computeBGL,
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
    this._cur = 0;
    this._seedQueue.length = 0;
    this._needInitialSeeds = true;
  }

  // a few phase-broken wavefronts (→ spiral pairs) + one ring, staggered
  _plantInitialSeeds(timeMs, sceneSeed) {
    const h = n => {
      const v = Math.sin(n * 12.9898 + sceneSeed * 78.233) * 43758.5453;
      return v - Math.floor(v);
    };
    for (let i = 0; i < 4; i++) {
      this._seedQueue.push({
        x: 0.18 + h(i * 4 + 1) * 0.64,
        y: 0.20 + h(i * 4 + 2) * 0.60,
        angle: h(i * 4 + 3) * Math.PI * 2,
        code: 3,
        t: timeMs + i * 200,
      });
    }
    this._seedQueue.push({
      x: 0.15 + h(13) * 0.70, y: 0.2 + h(14) * 0.6,
      angle: 0, code: 2, t: timeMs + 700,
    });
  }

  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._params = params;
    this._ensureGrid();
    const dt = Math.min(deltaMs * 0.001, 0.05);

    if (this._needInitialSeeds) {
      this._needInitialSeeds = false;
      this._plantInitialSeeds(timeMs, params.sceneSeed ?? 0);
    }

    // ── EMA'd bands: music arrives as slow chemistry, not flicker ──────
    const bass = Math.min(1, (bands.bass ?? 0) * ((params.mulBass ?? 3) / 3));
    const mid  = Math.min(1, (bands.mid  ?? 0) * (params.mulMid  ?? 1));
    const high = Math.min(1, (bands.high ?? 0) * (params.mulHigh ?? 1));
    this._bassE += (bass - this._bassE) * Math.min(1, dt * 5);
    this._midE  += (mid  - this._midE)  * Math.min(1, dt * 4);
    this._highE += (high - this._highE) * Math.min(1, dt * 7);
    const energy = (bass + mid + high) / 3;
    this._act += (energy - this._act) * Math.min(1, dt * 1.1);
    const quiet = Math.min(1, Math.max(0, (0.16 - this._act) / 0.16));
    const tension = params.tension ?? 0;

    // ── kick: a target-pattern ring is born on the beat ────────────────
    this._orbit += dt * 0.30;                    // locus orbits slowly
    const kick = bands.kick ?? 0, snare = bands.snare ?? 0;
    if (kick > 0.45 && this._prevKick <= 0.45) {
      this._kickEnv = Math.min(0.5 + kick * 0.7, 1.1);
      if (timeMs > this._kickCd) {
        this._kickCd = timeMs + 400;             // rate limit 1 / 0.4 s
        const asp = this.canvas.width / Math.max(this.canvas.height, 1);
        const r = 0.30 * (1 - 0.55 * tension);   // tension pulls births centreward
        this._seedQueue.push({
          x: 0.5 + Math.cos(this._orbit) * r / asp,
          y: 0.5 + Math.sin(this._orbit) * r,
          angle: 0, code: 1, t: timeMs,
        });
      }
    }
    // ── snare: a brief arc of excitation ───────────────────────────────
    if (snare > 0.5 && this._prevSnare <= 0.5) {
      this._snareEnv = Math.min(0.4 + snare * 0.6, 1);
      if (timeMs > this._snareCd) {
        this._snareCd = timeMs + 350;
        this._seedQueue.push({
          x: 0.18 + Math.random() * 0.64,
          y: 0.18 + Math.random() * 0.64,
          angle: Math.random() * Math.PI * 2,
          code: 4, t: timeMs,
        });
      }
    }
    this._prevKick = kick; this._prevSnare = snare;
    this._kickEnv  *= Math.exp(-dt * 6);
    this._snareEnv *= Math.exp(-dt * 7);

    // ── DROP: wall of excitation wipes the dish; rebirth over ~4 s ─────
    const drop = params.dropPulse ?? 0;
    if (drop > 0.5 && this._prevDrop <= 0.5) {
      this._dropT = 0;
      this._dropFlash = 1;
      this._seedQueue.length = 0;                // old plans died with the pattern
      for (let i = 0; i < 3; i++) {
        this._seedQueue.push({                   // spirals reborn from the wake
          x: 0.22 + Math.random() * 0.56,
          y: 0.22 + Math.random() * 0.56,
          angle: Math.random() * Math.PI * 2,
          code: 3, t: timeMs + 1300 + i * 700,
        });
      }
      this._seedQueue.push({
        x: 0.25 + Math.random() * 0.5, y: 0.25 + Math.random() * 0.5,
        angle: 0, code: 2, t: timeMs + 3400,
      });
    }
    this._prevDrop = drop;
    let wallPos = 0, wallActive = 0;
    if (this._dropT >= 0) {
      this._dropT += dt;
      wallPos = -0.06 + (this._dropT / 0.85) * 1.18;
      wallActive = 1;
      if (this._dropT > 0.85) this._dropT = -1;
    }
    this._dropFlash *= Math.exp(-dt * 2.2);

    // ── tap: touch the dish — a ring from your finger ──────────────────
    const tapN = params.cymTapN ?? 0;
    if (this._prevTapN === null) this._prevTapN = tapN;
    if (tapN !== this._prevTapN) {
      this._prevTapN = tapN;
      this._tapEnv = 1;
      this._seedQueue.push({
        x: params.cymTapX ?? 0.5, y: params.cymTapY ?? 0.5,
        angle: 0, code: 2, t: timeMs,
      });
    }
    this._tapEnv *= Math.exp(-dt * 3);

    // insurance: keep the dish inhabited — briskly with music, slowly in
    // silence (the filigree must never die out entirely)
    this._reseedT += dt;
    if (this._reseedT > (energy > 0.06 ? 9 : 16) && this._dropT < 0) {
      this._reseedT = 0;
      this._seedQueue.push({
        x: 0.2 + Math.random() * 0.6, y: 0.2 + Math.random() * 0.6,
        angle: Math.random() * Math.PI * 2, code: 3, t: timeMs,
      });
    }

    // ── kinetics from music ────────────────────────────────────────────
    // excitability threshold b: bass makes the dish hungry, quiet starves it
    const b = Math.min(0.105, Math.max(0.030,
      0.078 - this._bassE * 0.045 - tension * 0.010 + quiet * 0.010));
    this._b = b;
    // wave speed: substep budget, dt-scaled with a fractional accumulator
    const rate = (180 + this._midE * 280) * (1 - quiet * 0.5);   // substeps/s
    this._stepAcc = Math.min(this._stepAcc + rate * dt, 30);
    this._steps = Math.min(Math.floor(this._stepAcc), 24);
    this._stepAcc -= this._steps;
    // high-band sparkle; the drop wake also crackles as it re-organizes
    let noiseRate = this._highE * 0.0007;
    if (this._dropT < 0 && this._dropFlash > 0.15) noiseRate += 0.0010 * this._dropFlash;

    // ── hands: palm = pacemaker, fist = inhibitor ──────────────────────
    const hands = (params.gestMode === 2 && params.hands) ? params.hands.h : null;

    // ── extra slots (documented in bz_compute.wgsl) ────────────────────
    const e = this._extra;
    // reaction must be FASTER than per-cell diffusion or fronts pin and die:
    // ku ≈ 2–3.5 gives a front ~1 cell wide travelling ~1 cell per time unit
    e[0] = this._gw; e[1] = this._gh; e[2] = 0.15; e[3] = b;
    e[4] = 0.75; e[5] = 2.6 + this._bassE * 1.2; e[6] = 0.08; e[7] = noiseRate;
    // up to 3 seeds stamped this frame
    let slot = 0;
    for (let i = 0; i < this._seedQueue.length && slot < 3;) {
      const s = this._seedQueue[i];
      if (s.t <= timeMs) {
        e[8 + slot * 4]  = s.x;     e[9 + slot * 4]  = s.y;
        e[10 + slot * 4] = s.angle; e[11 + slot * 4] = s.code;
        this._seedQueue.splice(i, 1);
        slot++;
      } else i++;
    }
    for (; slot < 3; slot++) e[11 + slot * 4] = 0;
    e[20] = wallPos; e[21] = wallActive; e[22] = 1.0; e[23] = 0.4;   // .w = Dv
    for (let h = 0; h < 2; h++) {
      const s = hands?.[h];
      const present = s?.present ?? 0;
      const grip = s?.grip ?? 0;
      e[24 + h * 4] = s?.x ?? 0.5;
      e[25 + h * 4] = s?.y ?? 0.5;
      e[26 + h * 4] = present * Math.max(0, 1 - grip * 1.6);          // palm
      e[27 + h * 4] = present * Math.max(0, (grip - 0.55) * 2.2);     // fist
    }
    e[32] = (this.frameCount * 0.618034 % 1) * 97.0;
    e[33] = quiet; e[34] = tension; e[35] = 0;
    e[36] = this._kickEnv; e[37] = this._snareEnv;
    e[38] = this._dropFlash; e[39] = this._tapEnv;

    const u = buildUniforms(bands, timeMs, deltaMs, params, this.canvas, this.frameCount, 1);
    device.queue.writeBuffer(this.uniformBuffer, 0, u);
    device.queue.writeBuffer(this.uniformBuffer, RIPPLE_OFFSET, e);
  }

  draw(device, view) {
    this.post.ensureTargets();
    const enc = device.createCommandEncoder();

    const wx = Math.ceil(this._gw / 16), wy = Math.ceil(this._gh / 16);
    const cp = enc.beginComputePass();
    let c = this._cur;
    cp.setPipeline(this.seedPipeline);        // copy + stamp events
    cp.setBindGroup(0, this._computeBG[c]);
    cp.dispatchWorkgroups(wx, wy);
    c ^= 1;
    cp.setPipeline(this.stepPipeline);        // N reaction–diffusion substeps
    for (let i = 0; i < this._steps; i++) {
      cp.setBindGroup(0, this._computeBG[c]);
      cp.dispatchWorkgroups(wx, wy);
      c ^= 1;
    }
    cp.end();
    this._cur = c;                            // c = last-written buffer

    this.post.fadePass(enc, 0, this._params);
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.post.accumView, loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(this.renderPipeline);
    pass.setBindGroup(0, this._renderBG[this._cur]);
    pass.draw(3);
    pass.end();
    this.post.finish(enc, view, this._params);
    device.queue.submit([enc.finish()]);
  }

  destroy() {
    this.gridBuffers?.forEach(b => b.destroy());
    this.post?.destroy();
    if (typeof window !== 'undefined' && window.__bz) delete window.__bz;
  }
}
