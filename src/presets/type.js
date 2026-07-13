import shaderSource from '../shaders/type.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

// TYPE — kinetic text snakes (TEXTR-style), fully editable: your own text
// rides wavy paths in three choreographies. Panel params:
//   tyText, tyMode (0 rows / 1 columns / 2 spiral), tySize, tyInterval,
//   tyAmp, tyFreq, tySpeed, tyColor [r,g,b] or null → key hue
// Music: mid swells the wave amplitude, energy drives flow speed, kick
// pops glyph scale, snare jitters, drops flash the text white.

const MAX_INST = 9000;

export class TypePreset {
  constructor() {
    this.frameCount = 0;
    this._params = null;
    this._extra = new Float32Array(8);
    this._inst = new Float32Array(MAX_INST * 8);
    this._atlasFor = '';
    this._chars = [];        // { u0, u1, adv } per char of the phrase
    this._atlasAspect = 1;
    this._phase = 0;         // integrated flow (speed varies smoothly)
    this._kickEnv = 0; this._snareEnv = 0; this._invert = 0;
    this._prevKick = 0; this._prevSnare = 0; this._prevDrop = 0;
    this._seed = Math.random() * 10;
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;
    const module = device.createShaderModule({ label: 'type', code: shaderSource });
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.instBuffer = device.createBuffer({
      size: MAX_INST * 8 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this._sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.atlasTex = null;

    this._bgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._bgl] }),
      vertex:   { module, entryPoint: 'vs_main' },
      fragment: {
        module,
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
    this._ensureAtlas('BLOOM ');
    this.post = new PostFX();
    this.post.init(device, format, canvas);
  }

  // Render the phrase once into a canvas strip; measure per-char uv rects
  _ensureAtlas(text) {
    if (text === this._atlasFor) return;
    this._atlasFor = text;
    const H = 96;
    const cvs = document.createElement('canvas');
    const ctx = cvs.getContext('2d');
    ctx.font = `700 ${H * 0.72}px "SF Mono", Menlo, monospace`;
    const widths = [...text].map(ch => ctx.measureText(ch).width);
    const W = Math.max(Math.ceil(widths.reduce((a, b) => a + b, 0)) + 8, 16);
    cvs.width = W; cvs.height = H;
    ctx.font = `700 ${H * 0.72}px "SF Mono", Menlo, monospace`;
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    let x = 4;
    this._chars = [];
    for (let i = 0; i < text.length; i++) {
      ctx.fillText(text[i], x, H * 0.54);
      this._chars.push({ u0: x / W, u1: (x + widths[i]) / W, adv: widths[i] / H });
      x += widths[i];
    }
    this._atlasAspect = W / H;
    this.atlasTex?.destroy();
    this.atlasTex = this.device.createTexture({
      size: [W, H],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.copyExternalImageToTexture({ source: cvs }, { texture: this.atlasTex }, [W, H]);
    this.bindGroup = this.device.createBindGroup({
      layout: this._bgl,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this._sampler },
        { binding: 2, resource: this.atlasTex.createView() },
        { binding: 3, resource: { buffer: this.instBuffer } },
      ],
    });
  }

  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._params = params;
    const dt = Math.min(deltaMs * 0.001, 0.05);
    const aspect = this.canvas.width / Math.max(this.canvas.height, 1);

    this._ensureAtlas((params.tyText || 'BLOOM') + ' ');

    const kick = bands.kick ?? 0, snare = bands.snare ?? 0;
    if (kick > 0.45 && this._prevKick <= 0.45) this._kickEnv = Math.min(0.5 + kick * 0.8, 1.3);
    if (snare > 0.5 && this._prevSnare <= 0.5) this._snareEnv = Math.min(0.4 + snare * 0.6, 1);
    this._prevKick = kick; this._prevSnare = snare;
    this._kickEnv  *= Math.exp(-dt * 7);
    this._snareEnv *= Math.exp(-dt * 8);
    this._invert   *= Math.exp(-dt * 3.5);
    const drop = params.dropPulse ?? 0;
    if (drop > 0.5 && this._prevDrop <= 0.5) this._invert = 1;
    this._prevDrop = drop;

    // flow: base speed + track energy, integrated so tempo changes glide
    const energy = ((bands.bass ?? 0) + (bands.mid ?? 0) + (bands.high ?? 0)) / 3;
    this._phase += dt * (params.tySpeed ?? 0.5) * (0.6 + energy * 1.4);

    const mode = params.tyMode ?? 0;
    const size = (params.tySize ?? 0.5) * 0.10 + 0.025;      // glyph height, world
    const gap  = 1 + (params.tyInterval ?? 0.3) * 3;         // letter spacing mult
    const amp  = (params.tyAmp ?? 0.5) * 0.45
               * (1 + (bands.mid ?? 0) * (params.mulMid ?? 1) * 0.8);
    const freq = 1 + (params.tyFreq ?? 0.5) * 5;
    const t = this._phase;
    const chars = this._chars;
    const inst = this._inst;
    let n = 0;
    const push = (x, y, ang, sc, u0, u1, br) => {
      if (n >= MAX_INST) return;
      const o = n * 8;
      inst[o] = x; inst[o + 1] = y; inst[o + 2] = ang; inst[o + 3] = sc;
      inst[o + 4] = u0; inst[o + 5] = u1; inst[o + 6] = br;
      n++;
    };
    const kpop = 1 + this._kickEnv * 0.35;
    const jit = this._snareEnv * 0.012;

    if (mode === 0) {
      // ── wavy rows of running text ───────────────────────────────────────
      const rows = Math.max(3, Math.floor(1.8 / (size * 2.2)));
      for (let r = 0; r < rows; r++) {
        const dir = r % 2 === 0 ? 1 : -1;
        const y0 = -0.92 + (r + 0.5) / rows * 1.84;
        const ph = r * 1.7 + this._seed;
        let x = -aspect - ((t * dir * 0.35 + ph) % (size * gap * 20));
        let ci = r % chars.length;
        while (x < aspect + 0.2) {
          const ch = chars[ci % chars.length];
          const w = ch.adv * size * gap;
          const wavA = amp * Math.sin(x * freq + ph + t * dir);
          const slope = amp * freq * Math.cos(x * freq + ph + t * dir);
          push(x, y0 + wavA + (Math.random() - 0.5) * jit,
               Math.atan(slope * 0.8), kpop,
               ch.u0, ch.u1, 0.55 + (bands.mid ?? 0) * 0.5);
          x += w; ci++;
        }
      }
    } else if (mode === 1) {
      // ── word columns on vertical S-paths, scale easing (SIGNAL style) ──
      const cols = Math.max(3, Math.floor(aspect / (size * this._atlasAspect * 0.9)));
      const wordU1 = chars[chars.length - 1] ? 1 : 1;
      for (let c = 0; c < cols; c++) {
        const x0 = -aspect + (c + 0.5) / cols * 2 * aspect;
        const ph = c * 2.3 + this._seed * 3;
        const step = size * 1.15;
        for (let y = -1.05; y < 1.05; y += step) {
          const sway = amp * 0.7 * Math.sin(y * freq + ph + t * (c % 2 ? 1 : -1));
          const sc = (0.55 + 0.45 * Math.sin(y * freq * 0.7 + ph + t)) * kpop;
          push(x0 + sway, y + (Math.random() - 0.5) * jit, 0, sc,
               0, wordU1, 0.5 + (bands.high ?? 0) * 0.5);
        }
      }
    } else {
      // ── spiral: characters orbit outward, radius breathes with bass ───
      const turns = 5 + freq;
      const count = Math.min(chars.length * 40, 900);
      for (let i = 0; i < count; i++) {
        const s = i / count;
        const a = s * turns * Math.PI * 2 + t * 0.5;
        const r = (0.08 + s * 0.95) * (1 + (bands.bass ?? 0) * (params.mulBass ?? 1) * 0.15)
                * (1 + amp * 0.3 * Math.sin(s * 12 + t * 2));
        const ch = chars[i % chars.length];
        push(Math.cos(a) * r * aspect * 0.75, Math.sin(a) * r,
             a + Math.PI / 2, (0.5 + s) * kpop,
             ch.u0, ch.u1, 0.4 + s * 0.5 + (bands.mid ?? 0) * 0.4);
      }
    }

    this._count = n;
    device.queue.writeBuffer(this.instBuffer, 0, inst, 0, n * 8);

    const col = params.tyColor;
    this._extra[0] = col ? col[0] : 0;
    this._extra[1] = col ? col[1] : 0;
    this._extra[2] = col ? col[2] : 0;
    this._extra[3] = col ? 0 : 1;            // no colour picked → key hue
    this._extra[4] = size;
    this._extra[5] = this._atlasAspect;
    this._extra[6] = this._invert;

    const u = buildUniforms(bands, timeMs, deltaMs, params, this.canvas, this.frameCount,
                            PostFX.trailFactors(params, deltaMs).gain);
    device.queue.writeBuffer(this.uniformBuffer, 0, u);
    device.queue.writeBuffer(this.uniformBuffer, RIPPLE_OFFSET, this._extra);
  }

  draw(device, view) {
    this.post.ensureTargets();
    const { fade } = PostFX.trailFactors(this._params, 16.7);
    const enc = device.createCommandEncoder();
    this.post.fadePass(enc, fade, this._params);
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.post.accumView, loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw((this._count ?? 0) * 6);
    pass.end();
    this.post.finish(enc, view, this._params);
    device.queue.submit([enc.finish()]);
  }

  destroy() {
    this.atlasTex?.destroy();
    this.instBuffer?.destroy();
    this.post?.destroy();
  }
}
