import shaderSource from '../shaders/dither.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

// RESOLVER — 1-bit ordered-dither VJ over the user's own images/videos.
// A media playlist cuts on musical boundaries; the shader dithers the
// current frame and runs a glitch deck (row shifts, mirror tiling,
// inverts, live spectrogram strips) on transients. See dither.wgsl.

// ── media playlist (module-level so it survives preset re-instantiation
//    when the user switches modes back and forth) ─────────────────────────
const playlist = {
  items: [],        // { kind: 'video'|'image', el, w, h }
  index: 0,
  onchange: null,
};

// Only the ACTIVE video plays — 7 playing at once gets background decoders
// evicted by Chrome and copyExternalImageToTexture starts throwing
// ("no back resource"), which killed the render loop.
function syncPlayback() {
  playlist.items.forEach((it, i) => {
    if (it.kind !== 'video') return;
    if (i === playlist.index) it.el.play().catch(() => {});
    else if (!it.el.paused) it.el.pause();
  });
}

export async function addMediaFiles(files) {
  for (const file of files) {
    const url = URL.createObjectURL(file);
    if (file.type.startsWith('video')) {
      const v = document.createElement('video');
      v.src = url; v.muted = true; v.loop = true; v.playsInline = true;
      await new Promise((res, rej) => {
        v.oncanplay = res; v.onerror = rej;
      }).catch(() => null);
      if (v.videoWidth) {
        playlist.items.push({ kind: 'video', el: v, url, name: file.name, w: v.videoWidth, h: v.videoHeight });
      }
    } else if (file.type.startsWith('image')) {
      const bmp = await createImageBitmap(file).catch(() => null);
      if (bmp) playlist.items.push({ kind: 'image', el: bmp, name: file.name, w: bmp.width, h: bmp.height });
    }
  }
  syncPlayback();
  playlist.onchange?.();
  return playlist.items.length;
}

export function mediaCount() { return playlist.items.length; }
export function currentMediaItem() { return playlist.items[playlist.index] ?? null; }

// Playlist editing API for the RESOLVER panel
export const mediaApi = {
  list:  () => playlist.items.map(i => ({ name: i.name, kind: i.kind })),
  index: () => playlist.index,
  onchange: (fn) => { playlist.onchange = fn; },
  select(i) {
    if (playlist.items[i]) { playlist.index = i; syncPlayback(); playlist.onchange?.(); }
  },
  remove(i) {
    const item = playlist.items[i];
    if (!item) return;
    if (item.kind === 'video') { item.el.pause(); URL.revokeObjectURL(item.url); }
    playlist.items.splice(i, 1);
    if (playlist.index >= playlist.items.length) playlist.index = 0;
    syncPlayback();
    playlist.onchange?.();
  },
};

export class DitherPreset {
  constructor() {
    this.frameCount = 0;
    this._params = null;
    this._extra = new Float32Array(64);

    // glitch state
    this._kickEnv = 0; this._mirrorEnv = 0; this._invert = 0;
    this._prevKick = 0; this._prevSnare = 0; this._prevDrop = 0;
    this._seed = 1; this._mirrorN = 2;
    this._specShow = 0; this._cutFlash = 0;

    // playlist / Ken Burns state
    this._texFor = null;      // media item currently in this.mediaTex
    this._kbSeed = Math.random() * 10;
    this._itemAge = 0;
    this._prevBar = 0; this._bars = 0;

    // spectrogram ring: 48 columns of mid+high energy
    this._spec = new Float32Array(48);
    this._specHead = 0;
    this._specTimer = 0;
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;
    const module = device.createShaderModule({ label: 'dither', code: shaderSource });

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    // 1×1 placeholder until media arrives
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
      fragment: { module, entryPoint: 'fs_render', targets: [{ format: ACCUM_FORMAT }] },
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

  _cut() {
    if (playlist.items.length > 1) {
      playlist.index = (playlist.index + 1) % playlist.items.length;
      syncPlayback();
      playlist.onchange?.();
    }
    this._kbSeed = Math.random() * 10;
    this._itemAge = 0;
    this._cutFlash = 1;
    // fresh glitch flavour per cut
    this._mirrorN = Math.random() < 0.5 ? 2 : 3;
  }

  _updateMedia() {
    const item = playlist.items[playlist.index];
    if (!item) return false;
    if (this._texFor !== item) {
      this.mediaTex.destroy();
      this.mediaTex = this._makeTex(item.w, item.h);
      this._texFor = item;
      this._rebind();
      if (item.kind === 'image') {
        try {
          this.device.queue.copyExternalImageToTexture(
            { source: item.el }, { texture: this.mediaTex }, [item.w, item.h]);
        } catch (_) { /* keep last frame */ }
      }
      if (item.kind === 'video') item.el.play().catch(() => {});
    }
    if (item.kind === 'video') {
      const rate = this._params?.rsSpeed ?? 1;
      if (Math.abs(item.el.playbackRate - rate) > 0.01) item.el.playbackRate = rate;
    }
    if (item.kind === 'video' && item.el.readyState >= 2) {
      // Chrome can momentarily drop the video's GPU frame (seek, loop wrap,
      // decoder pressure) — one missed copy must never kill the loop
      try {
        this.device.queue.copyExternalImageToTexture(
          { source: item.el }, { texture: this.mediaTex }, [item.w, item.h]);
      } catch (_) { /* keep last frame */ }
    }
    return true;
  }

  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._params = params;
    const dt = Math.min(deltaMs * 0.001, 0.05);
    const t  = timeMs * 0.001;
    const speed  = params.rsSpeed  ?? 1;   // animation slow-down
    const glitch = params.rsGlitch ?? 1;   // glitch intensity
    this._itemAge += dt;
    this._anim = (this._anim ?? 0) + dt * speed;

    const hasMedia = this._updateMedia();

    // ── musical cutting: every 2 bars, or on a drop ──────────────────────
    const cutBars = params.rsCutBars ?? 2;       // 0 = no auto-cutting
    const barPos = params.barPos ?? 0;
    if (barPos < this._prevBar - 1.0) {
      this._bars++;
      if (cutBars > 0 && this._bars % cutBars === 0 && (params.beatConf ?? 0) > 0.15) this._cut();
    }
    this._prevBar = barPos;
    if (cutBars > 0 && this._itemAge > 9 + cutBars * 3) this._cut();   // no-beat fallback

    const drop = params.dropPulse ?? 0;
    if (drop > 0.5 && this._prevDrop <= 0.5) {
      this._cut();
      this._invert = 1;
      this._specShow = 1;
    }
    this._prevDrop = drop;

    // ── transients → glitch envelopes ────────────────────────────────────
    const kick = bands.kick ?? 0, snare = bands.snare ?? 0;
    if (kick > 0.45 && this._prevKick <= 0.45) {
      this._kickEnv = Math.min(0.5 + kick * 0.7, 1.3);
      this._seed = Math.random() * 100;
    }
    if (snare > 0.5 && this._prevSnare <= 0.5 && Math.random() < 0.55) {
      this._mirrorEnv = 0.4 + snare * 0.5;
    }
    this._prevKick = kick; this._prevSnare = snare;
    this._kickEnv   *= Math.exp(-dt * 9);
    this._mirrorEnv *= Math.exp(-dt * 3.5);
    this._invert    *= Math.exp(-dt * 2.2);
    this._specShow  *= Math.exp(-dt * 0.55);
    this._cutFlash  *= Math.exp(-dt * 22);

    // spectrogram ring: one column per 70 ms
    this._specTimer += deltaMs;
    while (this._specTimer >= 70) {
      this._specTimer -= 70;
      this._spec[this._specHead % 48] =
        Math.min((bands.mid ?? 0) * 0.9 + (bands.high ?? 0) * 0.7 + (bands.bass ?? 0) * 0.4, 1);
      this._specHead++;
    }

    // ── Ken Burns for stills; videos play as-is with a hair of zoom ──────
    const item = playlist.items[playlist.index];
    const still = item?.kind === 'image';
    const kbT = (this._anim ?? 0) * (still ? 0.05 : 0.012);
    const kbZoom = 1.10 + Math.sin(kbT * 2.0 + this._kbSeed) * (still ? 0.09 : 0.02);
    const kbPanX = Math.sin(kbT * 1.3 + this._kbSeed * 2.0) * (still ? 0.06 : 0.012);
    const kbPanY = Math.cos(kbT * 1.7 + this._kbSeed) * (still ? 0.05 : 0.010);

    // ── uniforms ─────────────────────────────────────────────────────────
    const u = buildUniforms(bands, timeMs, deltaMs, params, this.canvas, this.frameCount, 1);
    // cell size: base grows with kick and drops in quiet passages
    const energy = ((bands.bass ?? 0) + (bands.mid ?? 0)) * 0.5;
    u[41] = (4.0 + energy * 3.0 + this._kickEnv * 5.0 * glitch)
          * (params.rsCell ?? 1) * Math.min(devicePixelRatio, 1.5);
    u[42] = this._bars % 6 < 2 ? 0 : this._bars % 6 < 4 ? 1 : 2;   // pattern rotates by phrase
    u[43] = hasMedia ? 1 : 0;
    device.queue.writeBuffer(this.uniformBuffer, 0, u);

    const e = this._extra;
    e[0] = this._kickEnv * glitch;
    e[1] = this._mirrorEnv * glitch;
    e[2] = (this._invert + drop * 0.3) * Math.min(glitch, 1.2);
    e[3] = 1.15 + (params.tension ?? 0) * 1.1 * glitch;    // contrast
    e[4] = kbZoom; e[5] = kbPanX; e[6] = kbPanY;
    e[7] = item ? item.w / item.h : 1.77;
    e[8] = this._specShow;
    e[9] = this._seed;
    e[10] = this._mirrorN;
    e[11] = this._cutFlash;
    for (let i = 0; i < 48; i++) {
      // oldest → newest left to right
      e[16 + i] = this._spec[(this._specHead + i) % 48];
    }
    device.queue.writeBuffer(this.uniformBuffer, RIPPLE_OFFSET, e);
  }

  draw(device, view) {
    this.post.ensureTargets();
    const enc = device.createCommandEncoder();
    this.post.fadePass(enc, 0, this._params);   // hard 1-bit look — no trails
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
