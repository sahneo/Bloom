import computeSource from '../shaders/frost_compute.wgsl?raw';
import renderSource  from '../shaders/frost_render.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

// FROST — frost crystals growing across dark glass, macro-photography style.
// A half-res cell grid (ping-pong storage buffers, physarum idiom) stores
// (freezeAge, latticeAngle) per cell. Feathery dendrites creep out from seed
// points with 6-fold hexagonal anisotropy and lace the pane; the DROP
// shatters it (voronoi crack web flashes, shards glint, grid dissolves) and
// regrowth starts immediately — the regrow after the drop is the narrative.
// Music: mid/melody = growth rate, bass = deep glow in thick ice, kick =
// seed bursts + front flash, snare = sparkle glitter, quiet = slow melt,
// tension = faster growth + deeper blue. Tap plants a dendrite fan at your
// finger; in HANDS mode an open palm is local warmth that melts the ice.

export class FrostPreset {
  constructor() {
    this.frameCount = 0;
    this._params = null;
    this._extra = new Float32Array(64);
    this._cur = 0;
    this._gw = 0; this._gh = 0;
    this._kickEnv = 0; this._snareEnv = 0; this._shatterEnv = 0;
    this._prevKick = 0; this._prevSnare = 0; this._prevDrop = 0;
    this._prevTapN = null;
    this._dissolveT = 0;
    this._act = 0;             // smoothed energy → quiet detection
    this._bassEnv = 0;
    this._seedQueue = [];      // { x, y, lat, t } t = earliest timeMs to plant
    this._kickSeedCd = 0;
    this._reseedT = 0;
    this._shatterSeed = 0;
    this._needInitialSeeds = true;

    // ── camera travel phases (VJ feedback: full pane gets boring) ─────
    // STATIC: camera still, frost freezes over. TRAVEL: viewport glides,
    // fresh glass slides in at the leading edge and the frost front chases
    // it. A near-full pane (GPU coverage readback) triggers travel early.
    this._phase = 'static';
    this._phaseT = 0;
    this._phaseDur = 20 + Math.random() * 15;      // static 20–35 s
    this._travelTotal = [0, 0];    // camera displacement this phase, in cells
    this._shiftFracX = 0; this._shiftFracY = 0;    // sub-cell accumulator
    this._camU = 0; this._camV = 0;  // accumulated camera offset, UV units
    this._coverage = 0;              // frozen fraction 0..1 (256-pt readback)
    this._covT = 0;
    this._covRequest = false;
    this._covPending = false;
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;
    this._computeModule = device.createShaderModule({ label: 'frost-compute', code: computeSource });
    this._renderModule  = device.createShaderModule({ label: 'frost-render',  code: renderSource  });

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // coverage counter (cs_coverage) + staging buffer for mapAsync readback
    this.covBuffer = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.covStaging = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    this._covZero = new Uint32Array(1);

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

    this._covBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });

    this.growPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._computeBGL] }),
      compute: { module: this._computeModule, entryPoint: 'cs_grow' },
    });
    this.covPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._covBGL] }),
      compute: { module: this._computeModule, entryPoint: 'cs_coverage' },
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

    // test/debug hook — force phases deterministically, inspect coverage
    if (typeof window !== 'undefined') {
      const self = this;
      window.__frost = {
        get phase()    { return self._phase; },
        get phaseT()   { return self._phaseT; },
        get phaseDur() { return self._phaseDur; },
        get coverage() { return self._coverage; },
        get cam()      { return { u: self._camU, v: self._camV }; },
        forceTravel(durS, angle, cross) { self._startTravel(durS, angle, cross); },
        forceStatic() {
          self._phase = 'static'; self._phaseT = 0;
          self._phaseDur = 20 + Math.random() * 15;
        },
      };
    }
  }

  // begin a TRAVEL phase: pick duration, drift direction and how far the
  // pane crosses the screen; all overridable (debug hook / tests)
  _startTravel(durS, angle, cross) {
    this._phase = 'travel';
    this._phaseT = 0;
    this._phaseDur = durS ?? (8 + Math.random() * 7);         // 8–15 s
    const a = angle ?? Math.random() * Math.PI * 2;
    const f = cross ?? (0.30 + Math.random() * 0.30);         // 30–60 % of screen
    this._travelTotal = [Math.cos(a) * f * this._gw, Math.sin(a) * f * this._gh];
  }

  // cell grid at half canvas resolution (capped) — rebuilt on resize
  _ensureGrid() {
    const gw = Math.min(Math.max(Math.round(this.canvas.width  / 2), 256), 1440);
    const gh = Math.min(Math.max(Math.round(this.canvas.height / 2), 160), 900);
    if (gw === this._gw && gh === this._gh) return;
    this._gw = gw; this._gh = gh;
    this.gridBuffers?.forEach(b => b.destroy());
    const size = gw * gh * 8;                    // vec2f per cell
    this.gridBuffers = [0, 1].map(() => this.device.createBuffer({
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    }));
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
    this._covBG = [0, 1].map(i => this.device.createBindGroup({
      layout: this._covBGL,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.gridBuffers[i] } },
        { binding: 3, resource: { buffer: this.covBuffer } },
      ],
    }));
    this._cur = 0;
    this._needInitialSeeds = true;               // fresh (zeroed) pane
    // grid rebuilt → travel state is meaningless, restart static
    this._phase = 'static'; this._phaseT = 0;
    this._phaseDur = 20 + Math.random() * 15;
    this._shiftFracX = 0; this._shiftFracY = 0;
    this._camU = 0; this._camV = 0;
    this._coverage = 0;
  }

  _plantInitialSeeds(timeMs, sceneSeed) {
    const h = n => {
      const v = Math.sin(n * 12.9898 + sceneSeed * 78.233) * 43758.5453;
      return v - Math.floor(v);
    };
    const n = 3;
    for (let i = 0; i < n; i++) {
      this._seedQueue.push({
        x: 0.12 + h(i * 3 + 1) * 0.76,
        y: 0.12 + h(i * 3 + 2) * 0.76,
        lat: h(i * 3 + 3),
        t: timeMs + i * 120,
      });
    }
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

    // ── camera phase machine: STATIC freeze ↔ TRAVEL glide ────────────
    this._phaseT += dt;
    this._covT += dt;
    if (this._covT > 2) { this._covT = 0; this._covRequest = true; }
    let kx = 0, ky = 0, travelEnv = 0;
    if (this._phase === 'static') {
      // pane nearly full → don't let it sit boring, start travel soon
      if (this._coverage > 0.65 && this._phaseT > 8) {
        this._phaseDur = Math.min(this._phaseDur, this._phaseT + 2.5);
      }
      if (this._phaseT >= this._phaseDur) this._startTravel();
    } else {
      // raised-cosine velocity envelope: zero at both ends (no jerk when
      // the phase switches), peak mid-phase; ∫env dτ = ½ hence the ×2 so
      // the full _travelTotal displacement is covered over the phase
      const tau = Math.min(this._phaseT / this._phaseDur, 1);
      travelEnv = 0.5 - 0.5 * Math.cos(tau * Math.PI * 2);
      const rate = 2 * travelEnv * dt / this._phaseDur;
      this._shiftFracX += this._travelTotal[0] * rate;
      this._shiftFracY += this._travelTotal[1] * rate;
      // integer part shifts the grid this frame; remainder stays fractional
      kx = Math.trunc(this._shiftFracX); ky = Math.trunc(this._shiftFracY);
      this._shiftFracX -= kx; this._shiftFracY -= ky;
      if (kx !== 0 || ky !== 0) {
        this._camU += kx / this._gw; this._camV += ky / this._gh;
        // queued seeds are world-anchored — glide with the content
        for (let i = this._seedQueue.length - 1; i >= 0; i--) {
          const s = this._seedQueue[i];
          s.x -= kx / this._gw; s.y -= ky / this._gh;
          if (s.x < -0.02 || s.x > 1.02 || s.y < -0.02 || s.y > 1.02) {
            this._seedQueue.splice(i, 1);       // slid off the pane
          }
        }
      }
      if (this._phaseT >= this._phaseDur) {
        this._phase = 'static'; this._phaseT = 0;
        this._phaseDur = 20 + Math.random() * 15;
      }
    }
    // empty pane = nothing anchored on screen → fold the accumulated camera
    // offset back before it erodes f32 precision in the texture noise
    if (this._coverage < 0.03 && this._phase === 'static'
        && (Math.abs(this._camU) > 8 || Math.abs(this._camV) > 8)) {
      this._camU = 0; this._camV = 0;
    }

    // ── percussive envelopes ──────────────────────────────────────────
    const kick = bands.kick ?? 0, snare = bands.snare ?? 0;
    if (kick > 0.45 && this._prevKick <= 0.45) {
      this._kickEnv = Math.min(0.5 + kick * 0.8, 1.2);
      // kick = burst of new seed points (rate-limited so the pane
      // doesn't fill with clutter on a four-on-the-floor kick)
      if (timeMs > this._kickSeedCd && this._dissolveT <= 0) {
        this._kickSeedCd = timeMs + 1100;
        const n = kick > 0.8 ? 2 : 1;
        for (let i = 0; i < n; i++) {
          this._seedQueue.push({
            x: 0.08 + Math.random() * 0.84,
            y: 0.08 + Math.random() * 0.84,
            lat: Math.random(), t: timeMs,
          });
        }
      }
    }
    if (snare > 0.5 && this._prevSnare <= 0.5) this._snareEnv = Math.min(0.4 + snare * 0.7, 1);
    this._prevKick = kick; this._prevSnare = snare;
    this._kickEnv  *= Math.exp(-dt * 5);
    this._snareEnv *= Math.exp(-dt * 6);

    // ── DROP → shatter, then immediate regrowth ───────────────────────
    const drop = params.dropPulse ?? 0;
    if (drop > 0.5 && this._prevDrop <= 0.5) {
      this._shatterEnv = 1;
      this._dissolveT = 0.45;
      this._shatterSeed = Math.random() * 100;
      // long travel history + full pane reset: the crack flash hides the
      // texture-anchor jump, and fresh regrowth won't notice it
      if (Math.abs(this._camU) > 4 || Math.abs(this._camV) > 4) {
        this._camU = 0; this._camV = 0;
      }
      const nSeeds = 4;
      for (let i = 0; i < nSeeds; i++) {
        this._seedQueue.push({
          x: 0.10 + Math.random() * 0.80,
          y: 0.10 + Math.random() * 0.80,
          lat: Math.random(),
          t: timeMs + 520 + i * 90,
        });
      }
    }
    this._prevDrop = drop;
    this._shatterEnv *= Math.exp(-dt * 2.1);
    this._dissolveT = Math.max(0, this._dissolveT - dt);

    // ── tap → plant a dendrite fan at the finger ──────────────────────
    const tapN = params.cymTapN ?? 0;
    if (this._prevTapN === null) this._prevTapN = tapN;
    if (tapN !== this._prevTapN) {
      this._prevTapN = tapN;
      this._seedQueue.push({
        x: params.cymTapX ?? 0.5,
        y: params.cymTapY ?? 0.5,
        lat: Math.random(),
        t: this._dissolveT > 0 ? timeMs + 600 : timeMs,
      });
    }

    // ── music → growth / melt ─────────────────────────────────────────
    const energy = ((bands.bass ?? 0) + (bands.mid ?? 0) + (bands.high ?? 0)) / 3;
    this._act += (energy - this._act) * Math.min(1, dt * 1.4);
    const melt = Math.max(0, 0.20 - this._act) * 5.5;          // quiet → front retreats
    const growth = this._dissolveT > 0 ? 0
      : 18 + (bands.mid ?? 0) * (params.mulMid ?? 1) * 130
      + (params.tension ?? 0) * 55
      + this._kickEnv * 45
      + travelEnv * 30;   // travel: the front visibly chases the camera
    this._bassEnv = Math.max((bands.bass ?? 0) * (params.mulBass ?? 1), this._bassEnv * Math.exp(-dt * 2.5));

    // insurance: after a long melt-out, quietly replant so music can regrow
    this._reseedT += dt;
    if (this._reseedT > 6 && energy > 0.08 && this._dissolveT <= 0) {
      this._reseedT = 0;
      this._seedQueue.push({
        x: 0.10 + Math.random() * 0.80,
        y: 0.10 + Math.random() * 0.80,
        lat: Math.random(), t: timeMs,
      });
    }

    // ── hands (gesture mode 2): open palm = local warmth ──────────────
    const hands = (params.gestMode === 2 && params.hands) ? params.hands.h : null;

    // ── extra slots (documented in frost_compute.wgsl) ────────────────
    const e = this._extra;
    e[0] = this._gw; e[1] = this._gh; e[2] = growth; e[3] = melt;
    e[4] = this._shatterEnv; e[5] = this._kickEnv; e[6] = this._snareEnv;
    e[7] = this._dissolveT > 0 ? 1 : 0;
    // up to 4 seeds planted this frame
    let slot = 0;
    for (let i = 0; i < this._seedQueue.length && slot < 4;) {
      const s = this._seedQueue[i];
      if (s.t <= timeMs) {
        e[8 + slot * 4] = s.x; e[9 + slot * 4] = s.y;
        e[10 + slot * 4] = 1;  e[11 + slot * 4] = s.lat;
        this._seedQueue.splice(i, 1);
        slot++;
      } else i++;
    }
    for (; slot < 4; slot++) e[10 + slot * 4] = 0;
    for (let h = 0; h < 2; h++) {
      const s = hands?.[h];
      e[24 + h * 4] = s?.x ?? 0.5;
      e[25 + h * 4] = s?.y ?? 0.5;
      e[26 + h * 4] = s ? (1 - (s.grip ?? 0)) * (s.present ?? 0) : 0;  // open palm = warmth
      e[27 + h * 4] = s?.present ?? 0;
    }
    e[32] = this._bassEnv;
    e[33] = this._snareEnv;
    e[34] = 11.0;                   // growth/lace-gate fbm scale
    e[35] = this._shatterSeed;
    // camera travel (extra[9], extra[10] — see frost_compute.wgsl)
    e[36] = kx; e[37] = ky; e[38] = travelEnv; e[39] = 0;
    e[40] = this._shiftFracX; e[41] = this._shiftFracY;
    e[42] = this._camU; e[43] = this._camV;

    const u = buildUniforms(bands, timeMs, deltaMs, params, this.canvas, this.frameCount, 1);
    device.queue.writeBuffer(this.uniformBuffer, 0, u);
    device.queue.writeBuffer(this.uniformBuffer, RIPPLE_OFFSET, e);
  }

  draw(device, view) {
    this.post.ensureTargets();
    const enc = device.createCommandEncoder();

    const cp = enc.beginComputePass();
    cp.setPipeline(this.growPipeline);
    cp.setBindGroup(0, this._computeBG[this._cur]);
    cp.dispatchWorkgroups(Math.ceil(this._gw / 16), Math.ceil(this._gh / 16));
    cp.end();
    this._cur = 1 - this._cur;

    // coverage readback (~every 2 s): count a 256-point lattice on the
    // just-written buffer, copy 4 bytes to staging, mapAsync after submit
    const readCov = this._covRequest && !this._covPending;
    if (readCov) {
      this._covRequest = false;
      this._covPending = true;
      device.queue.writeBuffer(this.covBuffer, 0, this._covZero);
      const cc = enc.beginComputePass();
      cc.setPipeline(this.covPipeline);
      cc.setBindGroup(0, this._covBG[this._cur]);
      cc.dispatchWorkgroups(1);
      cc.end();
      enc.copyBufferToBuffer(this.covBuffer, 0, this.covStaging, 0, 4);
    }

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

    if (readCov) {
      this.covStaging.mapAsync(GPUMapMode.READ).then(() => {
        if (!this.covStaging) return;
        const n = new Uint32Array(this.covStaging.getMappedRange())[0];
        this.covStaging.unmap();
        this._coverage = n / 256;
        this._covPending = false;
      }).catch(() => { this._covPending = false; });
    }
  }

  destroy() {
    this.gridBuffers?.forEach(b => b.destroy());
    this.covBuffer?.destroy();
    this.covStaging?.destroy();
    this.covStaging = null;
    this.post?.destroy();
    if (typeof window !== 'undefined' && window.__frost) delete window.__frost;
  }
}
