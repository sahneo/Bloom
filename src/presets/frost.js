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

    this.growPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._computeBGL] }),
      compute: { module: this._computeModule, entryPoint: 'cs_grow' },
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
    this._cur = 0;
    this._needInitialSeeds = true;               // fresh (zeroed) pane
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
      + this._kickEnv * 45;
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
  }
}
