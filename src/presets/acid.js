import shaderSource from '../shaders/acid.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

// ACID — gradient-noise engine, tuned SLOW & HAZY. Five looks rotate in long
// epochs and cross-dissolve into each other (~3s); drops dissolve faster
// (~1.75s) with a soft colour bloom + one slow expanding wave — no invert,
// no strobe. A full-frame domain-warped smoke field is the canvas, four
// wobbly blobs ride on top. Steady heavy film grain is the identity.
//
// Reactivity (all EMA'd — fast attack, slow release, no raw-band twitch):
//   bass  → gentle tide: field swells ~12-15% over seconds
//   kick  → low-contrast luminance wave (~2s crossing, rate-limited, max 2)
//   mid   → flow speed + warp depth (halved from v1)
//   snare → barely-there shimmer; grain stays STEADY
//   drop  → look cross-dissolve + soft wave (transformation, not flash)

// look-paired palettes from the moodboard [colA, colB, bg] (linear-ish RGB)
const LOOKS = [
  { name: 'acid',    A: [0.72, 1.00, 0.13], B: [0.36, 0.27, 0.80], bg: [0.135, 0.115, 0.185], grain: 0.42 },
  { name: 'uv',      A: [0.46, 0.34, 1.00], B: [0.15, 0.36, 1.00], bg: [0.030, 0.022, 0.055], grain: 0.38 },
  { name: 'thermal', A: [1, 1, 1],          B: [1, 1, 1],          bg: [0.02, 0.03, 0.10],    grain: 0.30 },
  { name: 'veins',   A: [0.16, 0.52, 1.00], B: [0.55, 0.80, 1.00], bg: [0.040, 0.045, 0.058], grain: 0.45 },
  { name: 'ink',     A: [0.93, 0.90, 0.83], B: [0.6, 0.6, 0.55],   bg: [0.018, 0.018, 0.019], grain: 0.34 },
];

// desaturate every palette ~20% at load — the smoke should glow, not blaze
for (const L of LOOKS) {
  L.A = desat(L.A, 0.8);
  L.B = desat(L.B, 0.8);
}

const BANDS_ = ['bass', 'mid', 'subBass', 'high'];
// per-band EMA release (s): bass is a tide (2.5s), mid/high settle in 1.5s
const RELEASE_ = { bass: 2.5, subBass: 2.5, mid: 1.5, high: 1.5 };

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

function desat(rgb, f) {
  const [h, s, v] = rgbToHsv(rgb[0], rgb[1], rgb[2]);
  return hsvToRgb(h, s * f, v);
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
    this._lookPrev = this._look;
    this._lookMix = 1;            // 1 = fully on the current look
    this._lookFadeRate = 1 / 3;
    this._epochT = 0;
    this._epochLen = 50;
    this._prevDrop = 0;
    this._prevKick = 0;
    this._prevSnare = 0;
    // two ring slots (alternating) — never more than 2 waves in flight
    this._rings = [{ env: 0, age: 10 }, { env: 0, age: 10 }];
    this._ringSlot = 0;
    this._ringGap = 10;           // seconds since last accepted wave
    this._snareEnv = 0;
    this._flash = 0;              // soft drop bloom (no invert)
    this._flowT = 0;              // mid-warped flow clock (monotonic)
    this._env = { bass: 0, mid: 0, subBass: 0, high: 0 };
    this._orbit = Math.random() < 0.5;
    this._pos = [0, 1, 2, 3].map(() => ({ x: 0, y: 0 }));
    // eased palette (always glides — drops dissolve, never snap)
    const L = LOOKS[this._look];
    this._cA  = [...L.A];
    this._cB  = [...L.B];
    this._cBg = [...L.bg];
  }

  _triggerRing(env) {
    this._ringSlot ^= 1;
    const r = this._rings[this._ringSlot];
    r.env = env;
    r.age = 0;
    this._ringGap = 0;
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

    // band envelopes: attack ~0.18s, per-band release (bass = slow tide)
    for (const k of BANDS_) this._env[k] = ema(this._env[k], bands[k] ?? 0, dt, 0.18, RELEASE_[k]);
    const bassEnv = this._env.bass;
    const midEnv  = this._env.mid;

    // look epochs (40-70s); drops cross-dissolve to a new look in ~1.75s
    const drop = params.dropPulse ?? 0;
    const dropEdge = drop > 0.5 && this._prevDrop <= 0.5;
    this._epochT += dt;
    if (this._epochT > this._epochLen || dropEdge) {
      this._epochT = 0;
      this._epochLen = 40 + Math.random() * 30;
      this._lookPrev = this._look;
      this._lookMix = 0;
      this._lookFadeRate = dropEdge ? 1 / 1.75 : 1 / 3;
      this._look = (this._look + 1 + ((Math.random() * (LOOKS.length - 1)) | 0)) % LOOKS.length;
      this._orbit = Math.random() < 0.4;
      if (dropEdge) {
        this._flash = 1.0;          // soft colour bloom during the dissolve
        this._triggerRing(0.45);    // one slow expanding soft wave
      }
    }
    this._prevDrop = drop;
    this._flash *= Math.exp(-dt * 1.6);
    this._lookMix = Math.min(this._lookMix + dt * this._lookFadeRate, 1);

    // kick: low-contrast luminance wave — rate-limited (>=0.8s apart, so at
    // techno tempo only every other kick lands), two slots max, ~2s crossing
    const kick = bands.kick ?? 0;
    if (kick > 0.4 && this._prevKick <= 0.4 && this._ringGap > 0.8) {
      this._triggerRing(Math.min(0.18 + kick * 0.22, 0.4));
    }
    this._prevKick = kick;
    this._ringGap += dt;
    for (const r of this._rings) { r.env *= Math.exp(-dt * 0.9); r.age += dt; }

    // snare: barely-there shimmer (grain itself stays steady)
    const snare = bands.snare ?? 0;
    if (snare > 0.35 && this._prevSnare <= 0.35) {
      this._snareEnv = Math.min(0.15 + snare * 0.2, 0.4);
    }
    this._prevSnare = snare;
    this._snareEnv *= Math.exp(-dt * 1.8);

    // mid drives the smoke's flow clock (monotonic — no phase jumps);
    // halved vs v1: the smoke evolves over ~5-10s, it doesn't seethe
    this._flowT += dt * (0.3 + midEnv * 1.1);

    // palette: keyHue steers the look colours; always glides (~1s tau)
    const look = LOOKS[this._look];
    const steerAmt = (params.keyConf ?? 0) * 0.5;
    const tA  = hueSteer(look.A, params.keyHue ?? 0, steerAmt);
    const tB  = hueSteer(look.B, params.keyHue ?? 0, steerAmt);
    const kPal = 1 - Math.exp(-dt * 1.2);
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
        const a = t * (0.028 + i * 0.013) + s;
        const r = 0.35 + i * 0.16;
        tx = Math.cos(a) * r * aspect * 0.7;
        ty = Math.sin(a) * r;
      } else {
        tx = Math.sin(t * (0.025 + i * 0.01) + s) * 0.6 * aspect;
        ty = Math.cos(t * (0.021 + i * 0.012) + s * 1.7) * 0.55;
      }
      const P = this._pos[i];
      P.x += (tx - P.x) * ease;
      P.y += (ty - P.y) * ease;
      const level = this._env[BANDS_[i]];    // enveloped, not raw
      e[i * 4]     = P.x;
      e[i * 4 + 1] = P.y;
      e[i * 4 + 2] = (0.45 + i * 0.14) * (1 + bassEnv * 0.12 + level * 0.15 + (params.tension ?? 0) * 0.12);
      e[i * 4 + 3] = 0.35 + level * 0.45;
    }
    e[28] = this._look;
    e[29] = look.grain;
    e[30] = this._rings[0].env;
    e[31] = this._flash;
    for (let k = 0; k < 3; k++) {
      e[32 + k] = this._cA[k];
      e[36 + k] = this._cB[k];
      e[40 + k] = this._cBg[k];
    }
    e[35] = bassEnv;
    e[39] = midEnv;
    e[43] = this._snareEnv;
    e[44] = this._rings[0].age;
    e[45] = this._flowT;
    e[46] = this._lookPrev;
    e[47] = this._lookMix;
    e[48] = this._rings[1].env;
    e[49] = this._rings[1].age;

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
