import shaderSource from '../shaders/glass.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';
import { currentMediaItem } from './dither.js';

// GLASS — parametric fluted glass. Background is either 7 procedural
// band-bound colour blobs or the shared media playlist (video/images),
// refracted through the rib wall. All material params live in the GLASS
// panel: params.glRibs/glRefr/glBlur/glLight/glGrain/glSpec/glSrc.

const LIGHTS = [
  { band: 'kick',    depth: 0.85, speed: 0.07,  size: 0.60 },
  { band: 'snare',   depth: 0.65, speed: 0.09,  size: 0.45 },
  { band: 'bass',    depth: 0.25, speed: 0.035, size: 0.95 },
  { band: 'subBass', depth: 0.10, speed: 0.022, size: 1.15 },
  { band: 'mid',     depth: 0.55, speed: 0.12,  size: 0.55 },
  { band: 'mid',     depth: 0.45, speed: 0.14,  size: 0.50 },
  { band: 'high',    depth: 0.80, speed: 0.18,  size: 0.34 },
];

// Harmonious palettes: per-blob hue offsets from the track key + saturation.
// One scheme rules an epoch, then rotates.
const PALETTES = [
  { name: 'analogous',  off: [0, 0.05, 0.10, -0.05, -0.09, 0.07, -0.03], sat: 0.72 },
  { name: 'pastel',     off: [0, 0.04, 0.08, -0.04, -0.08, 0.06, -0.02], sat: 0.42 },
  { name: 'duotone',    off: [0, 0, 0.5, 0.5, 0, 0.5, 0],                sat: 0.68 },
  { name: 'triadic',    off: [0, 0.33, 0.66, 0, 0.33, 0.66, 0],          sat: 0.60 },
  { name: 'split-comp', off: [0, 0.42, 0.58, 0, 0.42, 0.58, 0.5],        sat: 0.66 },
];

// Movement epochs: the blobs' choreography itself changes over time.
// Targets are eased into, so switches glide instead of jumping.
const MOVES = ['drift', 'orbit', 'lava', 'chase'];

export class GlassPreset {
  constructor() {
    this.frameCount = 0;
    this._params = null;
    this._flash = LIGHTS.map(() => 0);
    this._prevKick = 0;
    this._prevSnare = 0;
    this._bassEma = 0;
    this._seed = Math.random() * 100;
    this._extra = new Float32Array(64);
    this._texFor = null;

    // choreography epochs
    this._move = 0;
    this._pal  = (Math.random() * PALETTES.length) | 0;
    this._epochT = 0;
    this._epochLen = 24;
    this._pos = LIGHTS.map(() => ({ x: 0, y: 0 }));
  }

  _moveTarget(mode, i, t, aspect) {
    const L = LIGHTS[i];
    const s = this._seed + i * 13.7;
    switch (MOVES[mode]) {
      case 'orbit': {
        // everyone circles a slowly wandering centre, each on its own ring
        const cx = Math.sin(t * 0.031 + this._seed) * 0.3 * aspect;
        const cy = Math.cos(t * 0.024 + this._seed * 2) * 0.25;
        const r  = 0.25 + (i / LIGHTS.length) * 0.55;
        const a  = t * L.speed * 2.2 + s;
        return { x: cx + Math.cos(a) * r * aspect * 0.7, y: cy + Math.sin(a) * r };
      }
      case 'lava': {
        // near-vertical columns, blobs slowly floating up and down
        const col = ((i / LIGHTS.length) * 2 - 1) * 0.75 * aspect;
        return {
          x: col + Math.sin(t * 0.05 + s) * 0.12 * aspect,
          y: Math.sin(t * L.speed * 3.0 + s * 1.7) * 0.75,
        };
      }
      case 'chase': {
        // a leader roams; everyone follows the same path with a lag
        const td = t - i * 0.9;
        return {
          x: Math.sin(td * 0.16 + this._seed) * 0.6 * aspect,
          y: Math.cos(td * 0.13 + this._seed * 1.7) * 0.55,
        };
      }
      default: {   // drift — free incommensurate wander
        const w = t * L.speed;
        return {
          x: Math.sin(w + s) * 0.62 * aspect + Math.sin(w * 0.37 + s * 2.1) * 0.25,
          y: Math.cos(w * 0.83 + s * 1.7) * 0.58 + Math.sin(w * 0.29 + s * 0.6) * 0.22,
        };
      }
    }
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;
    const module = device.createShaderModule({ label: 'glass', code: shaderSource });
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.mediaTex = this._makeTex(1, 1);

    this._bgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._bgl] }),
      vertex:   { module, entryPoint: 'vs_fullscreen' },
      fragment: {
        module,
        entryPoint: 'fs_render',
        targets: [{
          format: ACCUM_FORMAT,
          blend: {   // alpha = motion-blur persistence (Trail slider)
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this._rebind();
    this.post = new PostFX();
    this.post.init(device, format, canvas);
  }

  _makeTex(w, h) {
    return this.device.createTexture({
      size: [w, h],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  _rebind() {
    this.bindGroup = this.device.createBindGroup({
      layout: this._bgl,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this._sampler },
        { binding: 2, resource: this.mediaTex.createView() },
      ],
    });
  }

  // Media background (shared playlist) — same guarded copy as RESOLVER
  _updateMedia() {
    const item = currentMediaItem();
    if (!item) return 0;
    if (this._texFor !== item) {
      this.mediaTex.destroy();
      this.mediaTex = this._makeTex(item.w, item.h);
      this._texFor = item;
      this._rebind();
      if (item.kind === 'image') {
        try {
          this.device.queue.copyExternalImageToTexture(
            { source: item.el }, { texture: this.mediaTex }, [item.w, item.h]);
        } catch (_) {}
      }
      if (item.kind === 'video') item.el.play().catch(() => {});
    }
    if (item.kind === 'video' && item.el.readyState >= 2) {
      try {
        this.device.queue.copyExternalImageToTexture(
          { source: item.el }, { texture: this.mediaTex }, [item.w, item.h]);
      } catch (_) {}
    }
    return item.w / item.h;
  }

  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._params = params;
    const dt = Math.min(deltaMs * 0.001, 0.05);
    const t  = timeMs * 0.001;
    const aspect = this.canvas.width / Math.max(this.canvas.height, 1);

    const kBass = 1 - Math.exp(-dt / 0.6);
    this._bassEma += ((bands.bass ?? 0) - this._bassEma) * kBass;

    const kick = bands.kick ?? 0, snare = bands.snare ?? 0;
    if (kick > 0.45 && this._prevKick <= 0.45) this._flash[0] = Math.min(0.6 + kick, 1.6);
    if (snare > 0.5 && this._prevSnare <= 0.5) this._flash[1] = Math.min(0.5 + snare, 1.4);
    this._prevKick = kick; this._prevSnare = snare;
    const drop = params.dropPulse ?? 0;
    for (let i = 0; i < LIGHTS.length; i++) {
      this._flash[i] = Math.max(this._flash[i] * Math.exp(-dt * 5.5), drop * 1.3);
    }

    const wantMedia = params.glSrc === 'media';
    const texAspect = wantMedia ? this._updateMedia() : 0;

    // choreography epoch: movement mode + palette rotate every 20-45 s
    // (and on drops), targets eased so the change glides in
    this._epochT += dt;
    if (this._epochT > this._epochLen || (drop > 0.5 && this._prevDrop <= 0.5)) {
      this._epochT = 0;
      this._epochLen = 20 + Math.random() * 25;
      this._move = (this._move + 1 + ((Math.random() * (MOVES.length - 1)) | 0)) % MOVES.length;
      this._pal  = (this._pal  + 1 + ((Math.random() * (PALETTES.length - 1)) | 0)) % PALETTES.length;
    }
    this._prevDrop = drop;
    const pal = PALETTES[this._pal];
    const ease = 1 - Math.exp(-dt * 0.7);

    const e = this._extra;
    for (let i = 0; i < LIGHTS.length; i++) {
      const L = LIGHTS[i];
      const tg = this._moveTarget(this._move, i, t, aspect);
      const P = this._pos[i];
      P.x += (tg.x - P.x) * ease;
      P.y += (tg.y - P.y) * ease;
      const level = bands[L.band] ?? 0;
      const bright = 0.04 + level * 0.50 + this._flash[i] * 0.6
                   + (L.band === 'bass' ? this._bassEma * 0.25 : 0);
      e[i * 4]     = P.x;
      e[i * 4 + 1] = P.y;
      e[i * 4 + 2] = L.depth;
      e[i * 4 + 3] = bright;
      e[32 + i * 4]     = (params.keyHue ?? 0) + pal.off[i];
      e[32 + i * 4 + 1] = pal.sat;
      e[32 + i * 4 + 2] = L.size;
    }
    // material params → extra[7] and extra[15]
    e[28] = params.glRibs  ?? 42;
    e[29] = params.glRefr  ?? 1;
    e[30] = params.glBlur  ?? 1;
    e[31] = params.glLight ?? 0;
    e[60] = params.glGrain ?? 0.08;
    e[61] = (params.glSpec ?? false) ? 1 : 0;
    e[62] = wantMedia && texAspect > 0 ? 1 : 0;
    e[63] = texAspect || 1.77;

    const alpha = 1 - 0.6 * PostFX.effTrail(params);
    const u = buildUniforms(bands, timeMs, deltaMs, params, this.canvas, this.frameCount, alpha);
    u[41] = 1 + drop * 0.9;      // _r1: rib melt on drops
    u[42] = this._bassEma;       // _r2: breath
    device.queue.writeBuffer(this.uniformBuffer, 0, u);
    device.queue.writeBuffer(this.uniformBuffer, RIPPLE_OFFSET, e);
  }

  draw(device, view) {
    this.post.ensureTargets();
    const enc = device.createCommandEncoder();
    this.post.fadePass(enc, 1, this._params);
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
    this.mediaTex?.destroy();
    this.post?.destroy();
  }
}
