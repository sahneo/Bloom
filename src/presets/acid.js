import shaderSource from '../shaders/acid.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

// ACID — gradient-noise engine. Five looks rotate in epochs (and slam on
// drops with a full-frame invert flash); a full-frame domain-warped smoke
// field is the canvas, four wobbly blobs ride on top of it. Heavy film
// grain everywhere — that's the identity.
//
// Reactivity (all EMA'd — fast attack, slow release, no raw-band twitch):
//   bass  → whole field breathes scale/density   kick  → ring rolls through
//   mid   → flow speed + warp depth              snare → grain surge/shimmer
//   tension → saturation + tighter coil          drop  → look slam + flash

// look-paired palettes from the moodboard [colA, colB, bg] (linear-ish RGB)
const LOOKS = [
  { name: 'acid',    A: [0.72, 1.00, 0.13], B: [0.36, 0.27, 0.80], bg: [0.135, 0.115, 0.185], grain: 0.42 },
  { name: 'uv',      A: [0.46, 0.34, 1.00], B: [0.15, 0.36, 1.00], bg: [0.015, 0.008, 0.030], grain: 0.38 },
  { name: 'thermal', A: [1, 1, 1],          B: [1, 1, 1],          bg: [0.02, 0.03, 0.10],    grain: 0.30 },
  { name: 'veins',   A: [0.16, 0.52, 1.00], B: [0.55, 0.80, 1.00], bg: [0.030, 0.034, 0.045], grain: 0.45 },
  { name: 'ink',     A: [0.93, 0.90, 0.83], B: [0.6, 0.6, 0.55],   bg: [0.008, 0.008, 0.008], grain: 0.34 },
];

const BANDS_ = ['bass', 'mid', 'subBass', 'high'];

// EMA envelope step: fast attack, slow release (seconds)
function ema(cur, target, dt, atk, rel) {
  const tau = target > cur ? atk : rel;
  return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}

function rgbToHsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === r)      h = ((g - b) / d + 6) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else               h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, mx > 1e-6 ? d / mx : 0, mx];
}

function hsvToRgb(h, s, v) {
  const f = (n) => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

// steer a palette colour's hue toward keyHue (circular, keeps s/v)
function hueSteer(rgb, keyHue, amt) {
  if (amt < 0.01) return rgb;
  const [h, s, v] = rgbToHsv(rgb[0], rgb[1], rgb[2]);
  if (s < 0.08) return rgb;               // grey/white palettes keep their look
  let d = keyHue - h;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return hsvToRgb(((h + d * amt) % 1 + 1) % 1, s, v);
}

export class AcidPreset {
  constructor() {
    this.frameCount = 0;
    this._params = null;
    this._extra = new Float32Array(64);
    this._seed = Math.random() * 100;
    this._look = (Math.random() * LOOKS.length) | 0;
    this._epochT = 0;
    this._epochLen = 30;
    this._prevDrop = 0;
    this._prevKick = 0;
    this._prevSnare = 0;
    this._kickEnv = 0;
    this._kickAge = 10;          // seconds since last kick (ring already gone)
    this._snareEnv = 0;
    this._flash = 0;
    this._flowT = 0;             // mid-warped flow clock (monotonic)
    this._env = { bass: 0, mid: 0, subBass: 0, high: 0 };
    this._orbit = Math.random() < 0.5;
    this._pos = [0, 1, 2, 3].map(() => ({ x: 0, y: 0 }));
    // eased palette (snaps on drops, glides on epoch rolls)
    const L = LOOKS[this._look];
    this._cA  = [...L.A];
    this._cB  = [...L.B];
    this._cBg = [...L.bg];
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;
    const module = device.createShaderModule({ label: 'acid', code: shaderSource });
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex:   { module, entryPoint: 'vs_fullscreen' },
      fragment: { module, entryPoint: 'fs_render', targets: [{ format: ACCUM_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });
    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
    this.post = new PostFX();
    this.post.init(device, format, canvas);
  }

  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._params = params;
    const dt = Math.min(deltaMs * 0.001, 0.05);
    const t  = timeMs * 0.001;
    const aspect = this.canvas.width / Math.max(this.canvas.height, 1);

    // band envelopes: attack ~0.18s, release ~1.2s — beats read, no twitch
    for (const k of BANDS_) this._env[k] = ema(this._env[k], bands[k] ?? 0, dt, 0.18, 1.2);
    const bassEnv = this._env.bass;
    const midEnv  = this._env.mid;

    // look epochs; drops slam to a new look immediately with a flash
    const drop = params.dropPulse ?? 0;
    const dropEdge = drop > 0.5 && this._prevDrop <= 0.5;
    let snapPalette = false;
    this._epochT += dt;
    if (this._epochT > this._epochLen || dropEdge) {
      this._epochT = 0;
      this._epochLen = 24 + Math.random() * 20;
      this._look = (this._look + 1 + ((Math.random() * (LOOKS.length - 1)) | 0)) % LOOKS.length;
      this._orbit = Math.random() < 0.4;
      if (dropEdge) {
        this._flash = 1.0;                              // full-frame invert slam
        this._kickEnv = Math.max(this._kickEnv, 1.0);   // shockwave ring too
        this._kickAge = 0;
        snapPalette = true;
      } else {
        this._flash = Math.max(this._flash, 0.3);       // soften the epoch pop
      }
    }
    this._prevDrop = drop;
    this._flash *= Math.exp(-dt * 3.5);

    // kick: retrigger the ring on each hit, envelope rings out ~0.5s
    const kick = bands.kick ?? 0;
    if (kick > 0.4 && this._prevKick <= 0.4) {
      this._kickEnv = Math.min(0.55 + kick * 0.7, 1.2);
      this._kickAge = 0;
    }
    this._prevKick = kick;
    this._kickEnv *= Math.exp(-dt * 2.0);
    this._kickAge += dt;

    // snare: brief grain surge / colour shimmer
    const snare = bands.snare ?? 0;
    if (snare > 0.35 && this._prevSnare <= 0.35) {
      this._snareEnv = Math.min(0.45 + snare * 0.65, 1.1);
    }
    this._prevSnare = snare;
    this._snareEnv *= Math.exp(-dt * 2.5);

    // mid drives the smoke's flow clock (monotonic — no phase jumps)
    this._flowT += dt * (0.55 + midEnv * 2.4);

    // palette: keyHue steers the look colours; glide between looks, snap on drops
    const look = LOOKS[this._look];
    const steerAmt = (params.keyConf ?? 0) * 0.5;
    const tA  = hueSteer(look.A, params.keyHue ?? 0, steerAmt);
    const tB  = hueSteer(look.B, params.keyHue ?? 0, steerAmt);
    const kPal = snapPalette ? 1 : 1 - Math.exp(-dt * 2.5);
    for (let k = 0; k < 3; k++) {
      this._cA[k]  += (tA[k]      - this._cA[k])  * kPal;
      this._cB[k]  += (tB[k]      - this._cB[k])  * kPal;
      this._cBg[k] += (look.bg[k] - this._cBg[k]) * kPal;
    }

    const ease = 1 - Math.exp(-dt * 0.6);
    const e = this._extra;
    for (let i = 0; i < 4; i++) {
      const s = this._seed + i * 11.3;
      let tx, ty;
      if (this._orbit) {
        const a = t * (0.05 + i * 0.023) + s;
        const r = 0.35 + i * 0.16;
        tx = Math.cos(a) * r * aspect * 0.7;
        ty = Math.sin(a) * r;
      } else {
        tx = Math.sin(t * (0.045 + i * 0.017) + s) * 0.6 * aspect;
        ty = Math.cos(t * (0.038 + i * 0.021) + s * 1.7) * 0.55;
      }
      const P = this._pos[i];
      P.x += (tx - P.x) * ease;
      P.y += (ty - P.y) * ease;
      const level = this._env[BANDS_[i]];    // enveloped, not raw
      e[i * 4]     = P.x;
      e[i * 4 + 1] = P.y;
      e[i * 4 + 2] = (0.45 + i * 0.14) * (1 + bassEnv * 0.3 + level * 0.25 + (params.tension ?? 0) * 0.2);
      e[i * 4 + 3] = 0.4 + level * 0.65;
    }
    e[28] = this._look;
    e[29] = look.grain;
    e[30] = this._kickEnv;
    e[31] = this._flash;
    for (let k = 0; k < 3; k++) {
      e[32 + k] = this._cA[k];
      e[36 + k] = this._cB[k];
      e[40 + k] = this._cBg[k];
    }
    e[35] = bassEnv;
    e[39] = midEnv;
    e[43] = this._snareEnv;
    e[44] = this._kickAge;
    e[45] = this._flowT;

    const u = buildUniforms(bands, timeMs, deltaMs, params, this.canvas, this.frameCount, 1);
    device.queue.writeBuffer(this.uniformBuffer, 0, u);
    device.queue.writeBuffer(this.uniformBuffer, RIPPLE_OFFSET, e);
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
  }
}
