import fsSource     from '../shaders/kino.wgsl?raw';
import spriteSource from '../shaders/kino_glyph.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';
import { currentMediaItem } from './dither.js';

// KINO — a faithful port of kinotype.xyz's eight "moving typographic
// graphics" modes over the shared media playlist, with audio reactivity.
// Fullscreen shader modes (0/1/2/6) live in kino.wgsl; particle/pen/text
// sprite modes (3/4/5) are CPU-simulated over a small luminance+Sobel field
// of the source and rendered via kino_glyph.wgsl into the PostFX accum
// (flow field & scribbles rely on accum persistence for their trails).
// Mode 7 (pixel sort) is a CPU Kim-Asendorf sort: the source is downsampled
// to the dial resolution, contiguous bright runs per row/column are sorted
// by luminance in JS, and the result is uploaded to a texture the shader
// displays full-frame (chunky nearest pixels).
// With an empty playlist a procedural grayscale "galaxy" is the source.
// Audio: EMA-smoothed bands (attack .15s / release 1s) breathe cells & dots,
// kick = ring pulse from centre, snare = glyph jitter, high = twinkle rate,
// DROP = per-mode burst (invert flash / full-frame sort / particle scatter /
// letters exploding outward). All scaled by the React dial (params.knReact).

export const KINO_DIALS = [
  /* 0 halftone  */ [['Cell', 0.45], ['Contrast', 0.5], ['Jitter', 0.25], ['Invert', 0]],
  /* 1 edgeascii */ [['Density', 0.5], ['Edge sens', 0.5], ['Fill', 0.4], ['Invert', 0]],
  /* 2 stipple   */ [['Density', 0.5], ['Dot size', 0.55], ['Breathe', 0.5], ['Invert', 0]],
  /* 3 flowfield */ [['Particles', 0.6], ['Detail', 0.4], ['Speed', 0.5], ['Trail', 0.7]],
  /* 4 scribbles */ [['Pens', 0.5], ['Stroke', 0.4], ['Detail', 0.5], ['Speed', 0.5]],
  /* 5 textflow  */ [['Density', 0.5], ['Threshold', 0.5], ['Size', 0.45], ['Speed', 0.5]],
  /* 6 scatter   */ [['Grid', 0.5], ['Coverage', 0.5], ['Drift', 0.4], ['Size', 0.5]],
  /* 7 pixelsort */ [['Resolution', 0.5], ['Threshold', 0.45], ['Sweep', 0.5], ['Vertical', 0]],
];

const RAMP     = '.:-=+*#%@';
const DIRCHARS = ['—', '\\', '|', '/'];   // y-down contour angles 0/45/90/135°
const DOTCHAR  = '·';
const MAX_INST  = 12000;
const TB_LEN    = 128;                    // floats in the text lookup buffer
const WORD_BASE = 96;
const LW = 192, LH = 120;                 // CPU luminance/Sobel field
const MAXP = 3200;                        // flow-field particles
const MAXPENS = 64;

const mixN = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const frac = (x) => x - Math.floor(x);
const h2 = (x, y) => frac(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);

export class KinoPreset {
  constructor() {
    this.frameCount = 0;
    this._params = null;
    this._extra = new Float32Array(64);
    this._inst = new Float32Array(MAX_INST * 8);
    this._count = 0;
    this._mode = 0;
    this._dtMs = 16.7;
    this._t = 0;

    // atlas / text
    this._atlasFor = null;
    this._slotOf = new Map();
    this._ink = null;
    this._cells = 1;
    this._cellAspect = 0.6;
    this._textLen = 0;
    this._wordCount = 0;
    this._seed = Math.random() * 10;

    // media / field
    this._texFor = null;
    this._fieldSource = null;
    this._fieldStatic = true;
    this._fieldAt = 0;
    this._fieldA = 0;
    this._fieldVer = 0;
    this._luma = new Float32Array(LW * LH);
    this._gradX = new Float32Array(LW * LH);
    this._gradY = new Float32Array(LW * LH);

    // envelopes (EMA attack .15s / release 1s on bands)
    this._bassSm = 0; this._midSm = 0; this._highSm = 0; this._energySm = 0;
    this._kickEnv = 0; this._kickAge = 9; this._snareEnv = 0;
    this._invertFlash = 0; this._dropEnv = 0; this._scatterEnv = 0;
    this._prevKick = 0; this._prevSnare = 0; this._prevDrop = 0;
    this._sweep = 0;

    // mode 3 particles / mode 4 pens
    this._fp = null;
    this._pens = null;
    this._fade60 = 0;
    this._sketchT = 0;
    this._clearEnv = 0;

    // mode 5 text flow
    this._tfL = null;
    this._tfKey = '';
    this._tfBudget = 0;
    this._tfFade = 1;
    this._tfGh = 0.05;

    // mode 7 pixel sort (CPU Asendorf)
    this._sortTex = null;
    this._sortW = 0;
    this._sortH = 0;
    this._sortLum = null;
    this._runBuf = [];
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.instBuffer = device.createBuffer({
      size: MAX_INST * 8 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.textBuffer = device.createBuffer({
      size: TB_LEN * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this._sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    const fsModule = device.createShaderModule({ label: 'kino-fs', code: fsSource });
    const spModule = device.createShaderModule({ label: 'kino-sprite', code: spriteSource });

    this._fsBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.fsPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._fsBGL] }),
      vertex:   { module: fsModule, entryPoint: 'vs_fullscreen' },
      fragment: { module: fsModule, entryPoint: 'fs_render', targets: [{ format: ACCUM_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });

    this._spBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.spritePipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._spBGL] }),
      vertex:   { module: spModule, entryPoint: 'vs_main' },
      fragment: {
        module: spModule,
        entryPoint: 'fs_main',
        targets: [{
          format: ACCUM_FORMAT,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this._fieldCvs = document.createElement('canvas');
    this._fieldCvs.width = LW; this._fieldCvs.height = LH;
    this._fieldCtx = this._fieldCvs.getContext('2d', { willReadFrequently: true });

    this._sortCvs = document.createElement('canvas');
    this._sortCvs.width = 4; this._sortCvs.height = 4;
    this._sortCtx = this._sortCvs.getContext('2d', { willReadFrequently: true });

    this._makeProcSource();
    this.mediaTex = this._makeTex(1, 1);
    this.atlasTex = null;
    this._ensureAtlas('BLOOM');

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
    if (!this.atlasTex) return;
    this.fsBG = this.device.createBindGroup({
      layout: this._fsBGL,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this._sampler },
        { binding: 2, resource: this.mediaTex.createView() },
        { binding: 3, resource: this.atlasTex.createView() },
        { binding: 4, resource: { buffer: this.textBuffer } },
      ],
    });
    this.spriteBG = this.device.createBindGroup({
      layout: this._spBGL,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this._sampler },
        { binding: 2, resource: this.atlasTex.createView() },
        { binding: 3, resource: { buffer: this.instBuffer } },
      ],
    });
    // mode 7 variant: the CPU-sorted frame replaces the media texture
    this.fsBGSort = !this._sortTex ? null : this.device.createBindGroup({
      layout: this._fsBGL,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this._sampler },
        { binding: 2, resource: this._sortTex.createView() },
        { binding: 3, resource: this.atlasTex.createView() },
        { binding: 4, resource: { buffer: this.textBuffer } },
      ],
    });
  }

  // ── glyph atlas: one row of fixed-width monospace cells ──────────────────
  _ensureAtlas(text) {
    if (text === this._atlasFor) return;
    this._atlasFor = text;
    const seen = new Set();
    const list = [];
    const add = (c) => { if (c !== ' ' && !seen.has(c) && list.length < 80) { seen.add(c); list.push(c); } };
    for (const c of RAMP) add(c);
    DIRCHARS.forEach(add); add(DOTCHAR);
    for (const c of text) add(c);

    const H = 72;
    const cvs = document.createElement('canvas');
    const ctx = cvs.getContext('2d', { willReadFrequently: true });
    const font = `700 ${Math.floor(H * 0.74)}px "SF Mono", Menlo, monospace`;
    ctx.font = font;
    const cw = Math.ceil(Math.max(...list.map(c => ctx.measureText(c).width), 8) + 6);
    cvs.width = cw * list.length; cvs.height = H;
    ctx.font = font;
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    list.forEach((c, i) => ctx.fillText(c, i * cw + cw / 2, H * 0.54));

    // ink coverage per glyph (for the brightness → char LUT)
    const img = ctx.getImageData(0, 0, cvs.width, H).data;
    const ink = new Float32Array(list.length);
    for (let i = 0; i < list.length; i++) {
      let s = 0;
      for (let y = 0; y < H; y += 2) {
        for (let x = i * cw; x < (i + 1) * cw; x += 2) s += img[(y * cvs.width + x) * 4 + 3];
      }
      ink[i] = s;
    }
    this._ink = ink;
    this._slotOf = new Map(list.map((c, i) => [c, i]));
    this._cells = list.length;
    this._cellAspect = cw / H;

    this.atlasTex?.destroy();
    this.atlasTex = this._makeTex(cvs.width, H);
    this.device.queue.copyExternalImageToTexture({ source: cvs }, { texture: this.atlasTex }, [cvs.width, H]);

    this._buildTextBuf(text);
    this._rebind();
    this._tfKey = '';           // text flow layout depends on the char set
  }

  _buildTextBuf(text) {
    const tb = new Float32Array(TB_LEN).fill(-1);
    // LUT: darkest → brightest glyph, blank as level 0
    const uniq = [...new Set([...text].filter(c => c !== ' ' && this._slotOf.has(c)))];
    const src = uniq.length >= 2 ? uniq : [...RAMP];
    const sorted = src.slice().sort((a, b) => this._ink[this._slotOf.get(a)] - this._ink[this._slotOf.get(b)]);
    const lut = [-1, ...sorted.map(c => this._slotOf.get(c))];
    for (let i = 0; i < 16; i++) tb[i] = lut[Math.round(i / 15 * (lut.length - 1))];
    DIRCHARS.forEach((c, i) => { tb[16 + i] = this._slotOf.get(c); });

    const chars = [...text].slice(0, 60);
    chars.forEach((c, i) => { tb[20 + i] = c === ' ' ? -1 : (this._slotOf.get(c) ?? -1); });
    this._textLen = chars.length;
    this._charSeq = chars.map(c => c === ' ' ? -1 : (this._slotOf.get(c) ?? -1));

    let wc = 0, i = 0;
    while (i < chars.length && wc < 16) {
      while (i < chars.length && chars[i] === ' ') i++;
      const s = i;
      while (i < chars.length && chars[i] !== ' ') i++;
      if (i > s) { tb[WORD_BASE + wc * 2] = s; tb[WORD_BASE + wc * 2 + 1] = Math.min(i - s, 14); wc++; }
    }
    this._wordCount = wc;
    this.device.queue.writeBuffer(this.textBuffer, 0, tb);
  }

  // ── procedural default source: soft grayscale fbm galaxy ─────────────────
  _makeProcSource() {
    const W = 560, H = 350;
    const cvs = document.createElement('canvas');
    cvs.width = W; cvs.height = H;
    const ctx = cvs.getContext('2d');
    const img = ctx.createImageData(W, H);
    const d = img.data;
    const noise = (x, y) => {
      const ix = Math.floor(x), iy = Math.floor(y);
      const fx = x - ix, fy = y - iy;
      const wx = fx * fx * (3 - 2 * fx), wy = fy * fy * (3 - 2 * fy);
      return mixN(mixN(h2(ix, iy), h2(ix + 1, iy), wx),
                  mixN(h2(ix, iy + 1), h2(ix + 1, iy + 1), wx), wy);
    };
    const fbm = (x, y) => noise(x, y) * 0.5 + noise(x * 2.1, y * 2.1) * 0.27
                        + noise(x * 4.3, y * 4.3) * 0.15 + noise(x * 8.9, y * 8.9) * 0.08;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const nx = (x / W - 0.5) * 2 * (W / H), ny = (y / H - 0.5) * 2;
        const r = Math.hypot(nx, ny);
        const a = Math.atan2(ny, nx) + (1.6 - Math.min(r, 1.6)) * 2.4;
        const px = Math.cos(a) * r, py = Math.sin(a) * r;
        const v = fbm(px * 2.2 + 3.7, py * 2.2 + 1.3);
        const arm = Math.pow(0.5 + 0.5 * Math.cos(a * 2 - r * 3.5), 1.6);
        let l = (v * 0.75 + arm * 0.6) * Math.exp(-r * r * 0.85)
              + Math.exp(-r * r * 16) * 1.1;
        if (h2(x * 7.13, y * 5.71) > 0.9986) l = Math.max(l, 0.85);
        l = clamp01(l);
        const o = (y * W + x) * 4;
        const c = Math.round(l * 255);
        d[o] = c; d[o + 1] = c; d[o + 2] = c; d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    this._procCvs = cvs;
  }

  // ── media → texture (fx.js pattern) with procedural fallback ─────────────
  _updateMedia() {
    const item = currentMediaItem();
    if (!item) {
      if (this._texFor !== 'proc') {
        const c = this._procCvs;
        this.mediaTex.destroy();
        this.mediaTex = this._makeTex(c.width, c.height);
        this._texFor = 'proc';
        try {
          this.device.queue.copyExternalImageToTexture({ source: c }, { texture: this.mediaTex }, [c.width, c.height]);
        } catch (_) {}
        this._rebind();
        this._fieldSource = c;
        this._fieldStatic = true;
        this._refreshField(true);
      }
      return this._procCvs.width / this._procCvs.height;
    }
    if (this._texFor !== item) {
      this.mediaTex.destroy();
      this.mediaTex = this._makeTex(item.w, item.h);
      this._texFor = item;
      this._rebind();
      if (item.kind === 'image') {
        try {
          this.device.queue.copyExternalImageToTexture({ source: item.el }, { texture: this.mediaTex }, [item.w, item.h]);
        } catch (_) {}
      }
      if (item.kind === 'video') item.el.play().catch(() => {});
      this._fieldSource = item.el;
      this._fieldStatic = item.kind !== 'video';
      this._refreshField(true);
      this._tfKey = '';
    }
    if (item.kind === 'video' && item.el.readyState >= 2) {
      try {
        this.device.queue.copyExternalImageToTexture({ source: item.el }, { texture: this.mediaTex }, [item.w, item.h]);
      } catch (_) {}
    }
    return item.w / item.h;
  }

  // ── CPU luminance + Sobel field over the source (screen-cover mapped) ────
  _refreshField(force) {
    const el = this._fieldSource;
    if (!el) return;
    const now = performance.now();
    const asp = this.canvas.width / Math.max(this.canvas.height, 1);
    if (!force && Math.abs(asp - this._fieldA) > 0.02) force = true;
    if (!force && (this._fieldStatic || now - this._fieldAt < 180)) return;
    this._fieldAt = now;
    this._fieldA = asp;
    const sw = el.videoWidth ?? el.width, sh = el.videoHeight ?? el.height;
    if (!sw || !sh) return;
    const texA = sw / sh;
    let cw = sw, ch = sh, cx = 0, cy = 0;
    if (texA > asp) { cw = sh * asp; cx = (sw - cw) / 2; }
    else            { ch = sw / asp; cy = (sh - ch) / 2; }
    const ctx = this._fieldCtx;
    try { ctx.drawImage(el, cx, cy, cw, ch, 0, 0, LW, LH); } catch (_) { return; }
    const d = ctx.getImageData(0, 0, LW, LH).data;
    const L = this._luma, GX = this._gradX, GY = this._gradY;
    for (let i = 0; i < LW * LH; i++) {
      L[i] = (d[i * 4] * 0.2126 + d[i * 4 + 1] * 0.7152 + d[i * 4 + 2] * 0.0722) / 255;
    }
    for (let y = 1; y < LH - 1; y++) {
      for (let x = 1; x < LW - 1; x++) {
        const i = y * LW + x;
        GX[i] = (L[i - LW + 1] + 2 * L[i + 1] + L[i + LW + 1])
              - (L[i - LW - 1] + 2 * L[i - 1] + L[i + LW - 1]);
        GY[i] = (L[i + LW - 1] + 2 * L[i + LW] + L[i + LW + 1])
              - (L[i - LW - 1] + 2 * L[i - LW] + L[i - LW + 1]);
      }
    }
    this._fieldVer++;
  }

  // bilinear field sample at world coords (x ∈ [-asp, asp], y ∈ [-1, 1], y up)
  _field(x, y, asp) {
    const fx = clamp01((x / asp) * 0.5 + 0.5) * (LW - 1.001);
    const fy = clamp01(1 - (y * 0.5 + 0.5)) * (LH - 1.001);
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = fx - ix, ty = fy - iy;
    const i = iy * LW + ix;
    const L = this._luma, GX = this._gradX, GY = this._gradY;
    const bl = (A) => mixN(mixN(A[i], A[i + 1], tx), mixN(A[i + LW], A[i + LW + 1], tx), ty);
    return { l: bl(L), gx: bl(GX), gy: -bl(GY) };   // gy flipped to y-up world
  }

  // ── mode 7: CPU pixel sort (Kim Asendorf) ────────────────────────────────
  // Downsample the source cover-fit to the dial resolution, then per row
  // (or column when Vertical) find contiguous runs of pixels brighter than a
  // threshold and sort the run's actual pixels by luminance — each run becomes
  // a smooth monotonic gradient streak with hard stops at the threshold
  // boundaries. The threshold breathes with bass, a sweep band lowers it
  // locally, kick sends a dip ripple from centre, snare flips a few rows'
  // sort direction, DROP floors it so the whole frame sorts.
  _ensureSortTex(W, H) {
    if (this._sortW === W && this._sortH === H && this._sortTex) return;
    this._sortW = W; this._sortH = H;
    this._sortCvs.width = W; this._sortCvs.height = H;
    this._sortTex?.destroy();
    this._sortTex = this._makeTex(W, H);
    if (!this._sortLum || this._sortLum.length !== W * H) this._sortLum = new Float32Array(W * H);
    this._rebind();
  }

  _sortFrame(asp, p, react) {
    const el = this._fieldSource;
    if (!el) return;
    const sw = el.videoWidth ?? el.width, sh = el.videoHeight ?? el.height;
    if (!sw || !sh) return;
    const W = Math.round(mixN(96, 640, clamp01(p[0])));
    const H = Math.max(16, Math.min(512, Math.round(W / Math.max(asp, 0.2))));
    this._ensureSortTex(W, H);

    // cover-fit crop of the source into the sort canvas (same as _refreshField)
    const texA = sw / sh;
    let cw = sw, ch = sh, cx = 0, cy = 0;
    if (texA > asp) { cw = sh * asp; cx = (sw - cw) / 2; }
    else            { ch = sw / asp; cy = (sh - ch) / 2; }
    const ctx = this._sortCtx;
    let img;
    try {
      ctx.drawImage(el, cx, cy, cw, ch, 0, 0, W, H);
      img = ctx.getImageData(0, 0, W, H);
    } catch (_) { return; }
    const d = img.data;
    const lum = this._sortLum;
    const n = W * H;
    for (let i = 0; i < n; i++) {
      lum[i] = (d[i * 4] * 0.2126 + d[i * 4 + 1] * 0.7152 + d[i * 4 + 2] * 0.0722) / 255;
    }

    const vert = p[3] > 0.5;
    const lines = vert ? W : H;
    const len = vert ? H : W;
    // threshold: dial base, breathing down with bass (runs grow on the beat)
    const thBase = 0.12 + clamp01(p[1]) * 0.78 - this._bassSm * react * 0.22;
    const dropT = Math.min(this._dropEnv * 1.4, 1);
    const kickE = Math.min(this._kickEnv * react, 1);
    const snr = this._snareEnv * react;
    const swPos = this._sweep;
    const front = this._kickAge * 1.6;          // kick dip ripple radius
    const frameSeed = Math.floor(this._t * 24);
    const run = this._runBuf;
    const cmp = (a, b) => a - b;

    for (let li = 0; li < lines; li++) {
      const o = lines > 1 ? li / (lines - 1) : 0;
      let th = thBase;
      let dsw = Math.abs(o - swPos);
      dsw = Math.min(dsw, 1 - dsw);
      th -= Math.exp(-((dsw / 0.09) ** 2)) * 0.30;             // sweep band
      const d2 = Math.abs(Math.abs(o - 0.5) * 2 - front);
      th -= kickE * Math.exp(-((d2 * 5) ** 2)) * 0.25;         // kick ripple
      th = mixN(th, 0.02, dropT);                              // drop: sort all
      th = Math.min(Math.max(th, 0.02), 0.97);
      const desc = snr > 0.05 && h2(li * 1.7 + 0.31, frameSeed) < snr * 0.25;
      const base = vert ? li : li * W;
      const stride = vert ? W : 1;
      let rs = -1;
      for (let k = 0; k <= len; k++) {
        const on = k < len && lum[base + k * stride] > th;
        if (on) { if (rs < 0) rs = k; continue; }
        if (rs >= 0) {
          const rl = k - rs;
          if (rl >= 3) {
            run.length = rl;
            for (let m = 0; m < rl; m++) {
              const i = base + (rs + m) * stride;
              const q = i * 4;
              // pack sort key (10-bit luminance) + 24-bit colour in one number
              run[m] = Math.round(lum[i] * 1023) * 16777216
                     + (d[q] << 16) + (d[q + 1] << 8) + d[q + 2];
            }
            run.sort(cmp);
            for (let m = 0; m < rl; m++) {
              const c = run[desc ? rl - 1 - m : m] % 16777216;
              const q = (base + (rs + m) * stride) * 4;
              d[q] = (c >> 16) & 255; d[q + 1] = (c >> 8) & 255; d[q + 2] = c & 255;
            }
          }
          rs = -1;
        }
      }
    }

    ctx.putImageData(img, 0, 0);
    try {
      this.device.queue.copyExternalImageToTexture(
        { source: this._sortCvs }, { texture: this._sortTex }, [W, H]);
    } catch (_) {}
  }

  _noise2(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const wx = fx * fx * (3 - 2 * fx), wy = fy * fy * (3 - 2 * fy);
    return mixN(mixN(h2(ix, iy), h2(ix + 1, iy), wx),
                mixN(h2(ix, iy + 1), h2(ix + 1, iy + 1), wx), wy);
  }

  _respawnSpot(asp, tries, wantEdges) {
    let bx = 0, by = 0, bs = -1;
    for (let t = 0; t < tries; t++) {
      const rx = (Math.random() * 2 - 1) * asp * 0.98;
      const ry = Math.random() * 1.96 - 0.98;
      const f = this._field(rx, ry, asp);
      const m = Math.hypot(f.gx, f.gy);
      const sc = wantEdges ? Math.min(m * 5, 1) + f.l * 0.3
                           : f.l * 0.6 + Math.min(m * 5, 1);
      if (sc > bs) { bs = sc; bx = rx; by = ry; }
    }
    return [bx, by];
  }

  _pushSolid(x, y, ang, thick, len, br) {
    if (this._count >= MAX_INST) return;
    const o = this._count * 8;
    const I = this._inst;
    I[o] = x; I[o + 1] = y; I[o + 2] = ang; I[o + 3] = thick;
    I[o + 4] = len; I[o + 5] = 0; I[o + 6] = br; I[o + 7] = 1;
    this._count++;
  }

  _pushGlyph(x, y, ang, gh, slot, br) {
    if (this._count >= MAX_INST || slot < 0) return;
    const o = this._count * 8;
    const I = this._inst;
    I[o] = x; I[o + 1] = y; I[o + 2] = ang; I[o + 3] = gh;
    I[o + 4] = (slot + 0.05) / this._cells;
    I[o + 5] = (slot + 0.95) / this._cells;
    I[o + 6] = br; I[o + 7] = 0;
    this._count++;
  }

  // ── mode 3: flow-field particles retracing the image along its contours ──
  _simFlow(dt, asp, p, energy) {
    if (!this._fp) {
      this._fp = new Float32Array(MAXP * 5);
      for (let i = 0; i < MAXP; i++) {
        const o = i * 5;
        this._fp[o] = (Math.random() * 2 - 1) * asp;
        this._fp[o + 1] = Math.random() * 2 - 1;
        this._fp[o + 2] = Math.random() < 0.5 ? -1 : 1;
        this._fp[o + 3] = Math.random() * 4 + 0.5;
        this._fp[o + 4] = Math.random() * 10;
      }
    }
    const N = Math.min(Math.floor(500 + p[0] * 2500), MAXP);
    const spd = (0.25 + p[2] * 0.9) * (1 + energy * 0.5);
    const detail = p[1];
    const f60 = 0.90 + p[3] * 0.088;
    this._fade60 = f60;
    const dep = (1 - f60) * 8.0 * Math.min(dt * 60, 2);   // framerate-independent deposit
    const fp = this._fp;
    const scat = this._scatterEnv;
    for (let i = 0; i < N; i++) {
      const o = i * 5;
      let x = fp[o], y = fp[o + 1];
      const sgn = fp[o + 2], ph = fp[o + 4];
      const f = this._field(x, y, asp);
      const m = Math.hypot(f.gx, f.gy);
      const mB = Math.min(m * 6, 1);
      let dx = 0, dy = 0;
      if (m > 1e-4) { dx = (-f.gy / m) * sgn; dy = (f.gx / m) * sgn; }
      const nf = 1.5 * (0.5 + detail * 2.5);
      const na = this._noise2(x * nf + ph, y * nf - this._t * 0.06) * 12.566;
      let vx = dx * mB + Math.cos(na) * (1 - mB) * (0.4 + detail * 0.6);
      let vy = dy * mB + Math.sin(na) * (1 - mB) * (0.4 + detail * 0.6);
      const vm = Math.hypot(vx, vy) || 1;
      const sp = spd * (0.15 + mB * 0.75 + f.l * 0.25);
      vx = (vx / vm) * sp; vy = (vy / vm) * sp;
      if (scat > 0.01) {
        const r = Math.hypot(x, y) || 1;
        vx += (x / r) * scat * 1.8; vy += (y / r) * scat * 1.8;
      }
      const nx = x + vx * dt, ny = y + vy * dt;
      const len = Math.max(Math.hypot(nx - x, ny - y) * 2.2, 0.004);
      const br = dep * (0.14 + Math.pow(f.l, 1.5) * 1.15) * (1 + this._kickEnv * 0.6);
      this._pushSolid((x + nx) / 2, (y + ny) / 2, Math.atan2(ny - y, nx - x), 0.0035, len, br);
      let life = fp[o + 3] - dt * (0.2 + frac(ph) * 0.15);
      if (life <= 0 || Math.abs(nx) > asp + 0.05 || Math.abs(ny) > 1.05) {
        const [rx, ry] = this._respawnSpot(asp, 4, false);
        fp[o] = rx; fp[o + 1] = ry; fp[o + 3] = 2 + Math.random() * 3;
      } else {
        fp[o] = nx; fp[o + 1] = ny; fp[o + 3] = life;
      }
    }
  }

  // ── mode 4: wandering pens sketching the image with hand-drawn strokes ───
  _simPens(dt, asp, p, energy) {
    if (!this._pens) {
      this._pens = new Float32Array(MAXPENS * 5);
      this._resetPens(asp);
    }
    const N = Math.min(Math.floor(8 + p[0] * 52), MAXPENS);
    const spd = (0.09 + p[3] * 0.38) * (1 + energy * 0.4);
    const strokeW = 0.0016 + p[1] * 0.0062;
    const detail = p[2];
    const pens = this._pens;
    const sub = 3;
    const scat = this._scatterEnv;
    this._sketchT += dt;
    const cycleLen = 22 - p[3] * 12;
    if (this._sketchT > cycleLen) {
      this._sketchT = 0;
      this._clearEnv = 1;
      this._resetPens(asp);
    }
    this._clearEnv *= Math.exp(-dt * 4);
    this._fade60 = this._clearEnv > 0.25 ? 0.80 : 0.9985;
    const dep = 0.20 * Math.min(dt * 60, 2);

    for (let i = 0; i < N; i++) {
      const o = i * 5;
      let x = pens[o], y = pens[o + 1], hd = pens[o + 2];
      const sgn = pens[o + 3], seed = pens[o + 4];
      for (let s = 0; s < sub; s++) {
        const dtS = dt / sub;
        const f = this._field(x, y, asp);
        const m = Math.hypot(f.gx, f.gy);
        const wob = (this._noise2(seed * 9 + this._t * 0.8, i * 1.7) * 2 - 1) * (1.3 - detail * 0.9);
        let desired;
        if (m > 0.02) desired = Math.atan2(f.gx * sgn, -f.gy * sgn) + wob * 0.8;
        else          desired = hd + wob;
        let turn = desired - hd;
        turn = ((turn + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
        const maxT = (3 + detail * 6) * dtS;
        hd += Math.max(-maxT, Math.min(maxT, turn));
        let sp = spd * (0.3 + Math.min(m * 5, 1) * 0.7 + f.l * 0.3);
        let vx = Math.cos(hd) * sp, vy = Math.sin(hd) * sp;
        if (scat > 0.01) {
          const r = Math.hypot(x, y) || 1;
          vx += (x / r) * scat * 1.5; vy += (y / r) * scat * 1.5;
        }
        const nx = x + vx * dtS, ny = y + vy * dtS;
        const dLen = Math.hypot(nx - x, ny - y);
        const br = dep * (0.25 + f.l * 1.2) * (1 + this._kickEnv * 0.4);
        this._pushSolid((x + nx) / 2, (y + ny) / 2, Math.atan2(ny - y, nx - x),
                        strokeW, Math.max(dLen * 1.4, strokeW), br);
        x = nx; y = ny;
        if (Math.abs(x) > asp + 0.02 || Math.abs(y) > 1.02) {
          const [rx, ry] = this._respawnSpot(asp, 6, true);
          x = rx; y = ry; hd = Math.random() * 6.28;
        }
      }
      pens[o] = x; pens[o + 1] = y; pens[o + 2] = hd;
    }
  }

  _resetPens(asp) {
    for (let i = 0; i < MAXPENS; i++) {
      const o = i * 5;
      const [rx, ry] = this._respawnSpot(asp, 6, true);
      this._pens[o] = rx; this._pens[o + 1] = ry;
      this._pens[o + 2] = Math.random() * 6.28;
      this._pens[o + 3] = Math.random() < 0.5 ? -1 : 1;
      this._pens[o + 4] = Math.random() * 10;
    }
  }

  // ── mode 5: words pour into the bright shape of the image ────────────────
  _layoutTF(p, asp) {
    const gh = mixN(0.028, 0.085, p[2]);
    const lineStep = gh * mixN(1.7, 1.0, p[0]);
    const adv = this._cellAspect;
    const chw = adv * gh;
    const th = mixN(0.25, 0.72, p[1]);
    const seq = this._charSeq?.length ? this._charSeq : [0];
    const out = [];
    let ci = 0;
    for (let y = 1 - gh; y > -1 + gh * 0.5; y -= lineStep) {
      let runStart = -1;
      for (let x = -asp + chw * 0.5; x < asp; x += chw) {
        const f = this._field(x, y - gh * 0.4, asp);
        if (f.l > th) {
          if (runStart < 0) runStart = out.length;
          const slot = seq[ci % seq.length]; ci++;
          out.push({ x, y, slot, rx: Math.random() * 2 - 1, ry: Math.random() * 2 - 1 });
        } else {
          if (runStart >= 0 && out.length - runStart < 3) out.length = runStart;
          runStart = -1;
          ci++;
        }
        if (out.length >= MAX_INST - 10) break;
      }
      if (runStart >= 0 && out.length - runStart < 3) out.length = runStart;
      if (out.length >= MAX_INST - 10) break;
    }
    this._tfL = out;
    this._tfGh = gh;
    this._tfBudget = 0;
    this._tfFade = 1;
  }

  _tickTextFlow(dt, asp, p, energy) {
    const key = [this._atlasFor, p[0].toFixed(2), p[1].toFixed(2), p[2].toFixed(2), asp.toFixed(2)].join('|');
    if (this._tfKey !== key || !this._tfL) { this._layoutTF(p, asp); this._tfKey = key; }
    const total = this._tfL.length;
    const cps = (40 + p[3] * 320) * (0.8 + energy * 0.6);
    if (this._tfBudget < total + cps * 3.0) {
      this._tfBudget += dt * cps;      // fill, then hold ~3s worth
      this._tfFade = Math.min(1, this._tfFade + dt * 2);
    } else {
      this._tfFade -= dt / 1.2;        // fade out, then re-pour
      if (this._tfFade <= 0) {
        this._refreshField(!this._fieldStatic);
        this._layoutTF(p, asp);
      }
    }
    const gh = this._tfGh;
    const boom = this._dropEnv;
    const snr = this._snareEnv;
    const pop = 1 + this._kickEnv * 0.12;
    const brBase = (0.95 + this._midSm * 0.5) * Math.max(this._tfFade, 0);
    const lim = Math.min(this._tfBudget + 1, total);
    for (let k = 0; k < lim; k++) {
      const it = this._tfL[k];
      const a = clamp01(this._tfBudget - k);
      if (a <= 0) break;
      let x = it.x, y = it.y, ang = 0;
      if (boom > 0.005) {
        const r = Math.hypot(x, y) || 1;
        const kick2 = Math.pow(boom, 1.4) * (0.4 + frac(Math.abs(it.rx) * 7.7) * 0.9);
        x += (x / r) * kick2 + it.rx * kick2 * 0.35;
        y += (y / r) * kick2 + it.ry * kick2 * 0.35;
        ang = it.rx * boom * 2.2;
      }
      if (snr > 0.01) { x += it.rx * snr * 0.01; y += it.ry * snr * 0.01; }
      this._pushGlyph(x, y, ang, gh * pop * (0.7 + 0.3 * a), it.slot, a * brBase);
    }
  }

  _ema(prev, cur, dt) {
    const tau = cur > prev ? 0.15 : 1.0;
    return prev + (cur - prev) * (1 - Math.exp(-dt / tau));
  }

  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._params = params;
    this._dtMs = deltaMs;
    const dt = Math.min(deltaMs * 0.001, 0.05);
    this._t = timeMs * 0.001;
    const asp = this.canvas.width / Math.max(this.canvas.height, 1);
    const mode = params.knMode ?? 0;
    this._mode = mode;
    const react = params.knReact ?? 1;
    const text = (params.knText ?? '').trim() || 'BLOOM';
    const defs = KINO_DIALS[mode];
    const kp = params.knP ?? [];
    const p = defs.map((d, i) => kp[i] ?? d[1]);

    this._ensureAtlas(text);
    const texAspect = this._updateMedia();
    if (mode >= 3 && mode <= 5) this._refreshField(false);

    // envelopes
    const kick = bands.kick ?? 0, snare = bands.snare ?? 0;
    if (kick > 0.45 && this._prevKick <= 0.45) {
      this._kickEnv = Math.min(0.5 + kick * 0.8, 1.3);
      this._kickAge = 0;
    }
    if (snare > 0.5 && this._prevSnare <= 0.5) this._snareEnv = Math.min(0.4 + snare * 0.6, 1);
    this._prevKick = kick; this._prevSnare = snare;
    this._kickAge += dt;
    this._kickEnv    *= Math.exp(-dt * 3.2);
    this._snareEnv   *= Math.exp(-dt * 8);
    this._invertFlash *= Math.exp(-dt * 5);
    this._dropEnv    *= Math.exp(-dt * 1.6);
    this._scatterEnv *= Math.exp(-dt * 2.0);
    const drop = params.dropPulse ?? 0;
    if (drop > 0.5 && this._prevDrop <= 0.5) {
      this._dropEnv = 1;
      if (mode <= 2 || mode === 6) this._invertFlash = 1;
      if (mode === 3 || mode === 4) this._scatterEnv = 1;
    }
    this._prevDrop = drop;

    this._bassSm = this._ema(this._bassSm, bands.bass ?? 0, dt);
    this._midSm  = this._ema(this._midSm,  bands.mid  ?? 0, dt);
    this._highSm = this._ema(this._highSm, bands.high ?? 0, dt);
    const energyRaw = ((bands.bass ?? 0) + (bands.mid ?? 0) + (bands.high ?? 0)) / 3;
    this._energySm = this._ema(this._energySm, energyRaw, dt);
    const eEnergy = this._energySm * react;

    this._sweep = frac(this._sweep + dt * (0.04 + p[2] * 0.32) * (0.5 + eEnergy * 0.8));

    if (mode === 7) this._sortFrame(asp, p, react);

    // sprite modes: rebuild instances
    this._count = 0;
    if (mode === 3)      this._simFlow(dt, asp, p, eEnergy);
    else if (mode === 4) this._simPens(dt, asp, p, eEnergy);
    else if (mode === 5) this._tickTextFlow(dt, asp, p, eEnergy);
    if (this._count > 0) {
      device.queue.writeBuffer(this.instBuffer, 0, this._inst, 0, this._count * 8);
    }

    const e = this._extra;
    e[0] = mode;                       e[1] = react;
    e[2] = this._kickEnv * react;      e[3] = this._snareEnv * react;
    e[4] = p[0]; e[5] = p[1]; e[6] = p[2]; e[7] = p[3];
    e[8] = texAspect || 1.6;           e[9] = this._invertFlash;
    e[10] = this._dropEnv;             e[11] = this._kickAge;
    e[12] = this._bassSm * react;      e[13] = this._midSm * react;
    e[14] = this._highSm * react;      e[15] = eEnergy;
    e[16] = 0.6 + this._highSm * react * 5.0;                     // twinkle rate
    e[17] = 0.38 * Math.min(react, 1) * (params.keyConf ?? 0);    // key tint
    e[18] = this._seed;                e[19] = this._textLen;
    e[20] = this._cells;               e[21] = this._cellAspect;
    e[22] = this._slotOf.get(DOTCHAR) ?? 0;
    e[23] = WORD_BASE;
    e[24] = this._wordCount;           e[25] = this._cellAspect;
    e[26] = this._sweep;               e[27] = 0;

    const u = buildUniforms(bands, timeMs, deltaMs, params, this.canvas, this.frameCount, 1);
    device.queue.writeBuffer(this.uniformBuffer, 0, u);
    device.queue.writeBuffer(this.uniformBuffer, RIPPLE_OFFSET, e);
  }

  draw(device, view) {
    this.post.ensureTargets();
    const mode = this._mode ?? 0;
    let fade = 0;
    if (mode === 3 || mode === 4) {
      fade = Math.pow(this._fade60 || 0.95, (this._dtMs || 16.7) / 16.7);
    }
    const enc = device.createCommandEncoder();
    this.post.fadePass(enc, fade, this._params);
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.post.accumView, loadOp: 'load', storeOp: 'store' }],
    });
    if (mode >= 3 && mode <= 5) {
      if (this._count > 0) {
        pass.setPipeline(this.spritePipeline);
        pass.setBindGroup(0, this.spriteBG);
        pass.draw(this._count * 6);
      }
    } else {
      pass.setPipeline(this.fsPipeline);
      pass.setBindGroup(0, mode === 7 && this.fsBGSort ? this.fsBGSort : this.fsBG);
      pass.draw(3);
    }
    pass.end();
    this.post.finish(enc, view, this._params);
    device.queue.submit([enc.finish()]);
  }

  destroy() {
    this.mediaTex?.destroy();
    this.atlasTex?.destroy();
    this._sortTex?.destroy();
    this.instBuffer?.destroy();
    this.textBuffer?.destroy();
    this.post?.destroy();
  }
}
