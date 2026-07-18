import shaderSource from '../shaders/medusa.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

// MEDUSA — deep-sea bioluminescent jellyfish ballet. Seven moon-jellies
// drift in black water at different depths. They swim the way real medusae
// do: the bell CONTRACTS (thrust — the body accelerates) then relaxes
// (glide — drag bleeds the speed off), and the contraction is LOCKED TO THE
// KICK: each kick fires the medusa that has waited longest, so a steady
// beat sends waves of pulses travelling through the shoal instead of one
// robotic twitch. Bells flash brighter while contracting (real
// bioluminescence fires on disturbance). Everything steers through
// slew-limited headings and EMA'd audio — no jitter, no collisions, motion
// changes over tens of seconds. Render side: medusa.wgsl.
//
// Music: bass EMA = ambient glow + water density · mid = tentacle sway
// amplitude · high = plankton shimmer · snare = glitter cloud · kick =
// one bell contracts · DROP = staggered flash-bloom across the whole shoal.

const N = 7;
const TAU = Math.PI * 2;

function angDiff(a, b) {   // shortest signed arc a → b
  let d = (b - a) % TAU;
  if (d > Math.PI)  d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export class MedusaPreset {
  constructor() {
    this.frameCount = 0;
    this._params = null;
    this._extra = new Float32Array(64);
    this._seed = Math.random() * 100;
    this._t = 0;
    this._bassEma = 0; this._midEma = 0; this._highEma = 0;
    this._prevKick = 0; this._prevSnare = 0; this._prevDrop = 0;
    this._snareEnv = 0; this._dropWave = 0;
    this._tapX = 0; this._tapY = 0; this._tapEnv = 0; this._prevTapN = null;
    this._prevGrip = 0;

    const R = (i) => {
      const x = Math.sin(this._seed * 12.9898 + i * 78.233) * 43758.5453;
      return x - Math.floor(x);
    };
    // shuffle depth ranks so spatial neighbours sit at different depths
    const ranks = Array.from({ length: N }, (_, i) => i)
      .sort((a, b) => R(a + 40) - R(b + 40));
    // loose-formation anchors: evenly spaced across the frame with jitter,
    // so the shoal always fills the picture instead of clumping in a corner
    this._bodies = Array.from({ length: N }, (_, i) => ({
      homeX: ((i + 0.5) / N - 0.5) * 2.7 + (R(i + 80) - 0.5) * 0.5,
      homeY: (R(i + 90) - 0.5) * 1.1,
      x: (R(i) - 0.5) * 2.6,
      y: (R(i + 10) - 0.5) * 1.4,
      depth: 0.12 + 0.88 * (ranks[i] / (N - 1)),
      size: 0.44 + R(i + 20) * 0.30,
      heading: (R(i + 30) - 0.5) * 0.9,
      baseDir: (R(i + 30) - 0.5) * 0.9,
      seed: R(i + 50),
      v: 0.03,
      pulseT: 0.5 + R(i + 60) * 4.0,   // staggered — never move as one robot
      pulseStrength: 0.6,
      period: 3.8 + R(i + 70) * 2.6,
      flash: 0,
      fleeX: 0, fleeY: 0, fleeT: 0,
      sway: 0.3,
    }));
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;
    const module = device.createShaderModule({ label: 'medusa', code: shaderSource });
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const bgl = device.createBindGroupLayout({
      label: 'medusa-bgl',
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      }],
    });
    this.pipeline = device.createRenderPipeline({
      label: 'medusa-pipeline',
      layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex:   { module, entryPoint: 'vs_fullscreen' },
      fragment: { module, entryPoint: 'fs_render', targets: [{ format: ACCUM_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });
    this.bindGroup = device.createBindGroup({
      layout: bgl,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
    this.post = new PostFX();
    this.post.init(device, format, canvas);
    window.__medusa = this;   // test hook (same idiom as other presets)
  }

  // Contraction trigger. delay > 0 = the wave reaches this body later.
  _trigger(b, strength, delay = 0) {
    if (b.pulseT < 0.35) return;   // still contracting (or queued) — skip
    b.pulseT = -delay;
    b.pulseStrength = Math.min(strength, 1.5);
  }

  // Contraction envelope: fast attack (~160 ms), gentle release (~550 ms).
  _env(b) {
    const t = b.pulseT;
    if (t < 0) return 0;
    return Math.min(t / 0.16, 1) * Math.exp(-Math.max(t - 0.16, 0) / 0.55) * b.pulseStrength;
  }

  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._params = params;
    const dt = Math.min(deltaMs * 0.001, 0.05);
    this._t += dt;
    const t = this._t;
    const asp = this.canvas.width / Math.max(this.canvas.height, 1);

    // ── smoothed audio: every coupling goes through an EMA (no jitter) ──
    this._bassEma += ((bands.bass ?? 0) - this._bassEma) * (1 - Math.exp(-dt / 0.45));
    this._midEma  += ((bands.mid  ?? 0) - this._midEma)  * (1 - Math.exp(-dt / 0.35));
    this._highEma += ((bands.high ?? 0) - this._highEma) * (1 - Math.exp(-dt / 0.25));
    const energy = this._bassEma * 0.7 + this._midEma * 0.3;

    // ── kick → the medusa that has waited longest contracts ──
    const kick = bands.kick ?? 0;
    if (kick > 0.45 && this._prevKick <= 0.45) {
      const ready = this._bodies.filter(b => b.pulseT > 0.45)
                                .sort((a, b) => b.pulseT - a.pulseT);
      if (ready[0]) this._trigger(ready[0], 0.75 + kick * 0.55);
      if (kick > 0.85 && ready[1]) this._trigger(ready[1], 0.6 + kick * 0.4, 0.10);
    }
    this._prevKick = kick;

    const snare = bands.snare ?? 0;
    if (snare > 0.5 && this._prevSnare <= 0.5) {
      this._snareEnv = Math.min(0.4 + snare * 0.8, 1.2);
    }
    this._prevSnare = snare;
    this._snareEnv *= Math.exp(-dt * 5.5);

    // ── DROP → flash-bloom wave: every bell contracts, staggered by x so
    // the pulse visibly sweeps through the shoal, then everything calms ──
    const drop = params.dropPulse ?? 0;
    if (drop > 0.5 && this._prevDrop <= 0.5) {
      [...this._bodies].sort((a, b) => a.x - b.x).forEach((b, i) => {
        b.pulseT = -(i * 0.075);
        b.pulseStrength = 1.2;
        b.flash = Math.max(b.flash, 0.8);
      });
      this._dropWave = 1;
    }
    this._prevDrop = drop;
    this._dropWave *= Math.exp(-dt * 1.5);

    // ── tap: a touch in the water — nearby medusae flash and dart away ──
    const tapN = params.cymTapN ?? 0;
    if (this._prevTapN === null) this._prevTapN = tapN;
    if (tapN !== this._prevTapN) {
      this._prevTapN = tapN;
      this._tapX = ((params.cymTapX ?? 0.5) * 2 - 1) * asp;
      this._tapY = 1 - (params.cymTapY ?? 0.5) * 2;
      this._tapEnv = 1;
      for (const b of this._bodies) {
        const dx = b.x - this._tapX, dy = b.y - this._tapY;
        const d = Math.hypot(dx, dy);
        if (d < 0.85) {
          const f = 1 - d / 0.85;
          this._trigger(b, 0.9 + f * 0.5, d * 0.25);
          b.flash = Math.max(b.flash, 0.45 + f * 0.6);
          b.fleeX = dx / (d + 1e-4);
          b.fleeY = dy / (d + 1e-4);
          b.fleeT = 2.2;
        }
      }
    }
    this._tapEnv *= Math.exp(-dt * 2.2);

    // ── hands (optional): open palm = curiosity, fist = scatter ──
    let attX = 0, attY = 0, attOn = false, repX = 0, repY = 0, repOn = false, maxGrip = 0;
    if (params.gestMode === 2 && params.hands?.h) {
      for (const h of params.hands.h) {
        if (!h.present) continue;
        const hx = (h.x * 2 - 1) * asp, hy = 1 - h.y * 2;
        maxGrip = Math.max(maxGrip, h.grip);
        if (h.grip > 0.7)       { repX = hx; repY = hy; repOn = true; }
        else if (h.grip < 0.4)  { attX = hx; attY = hy; attOn = true; }
      }
      if (repOn && maxGrip > 0.7 && this._prevGrip <= 0.7) {
        for (const b of this._bodies) {
          const d = Math.hypot(b.x - repX, b.y - repY);
          if (d < 1.0) { this._trigger(b, 1.1, d * 0.3); b.flash = Math.max(b.flash, 0.5); }
        }
      }
    }
    this._prevGrip = maxGrip;

    // centroid for loose-formation cohesion
    let mx = 0, my = 0;
    for (const b of this._bodies) { mx += b.x; my += b.y; }
    mx /= N; my /= N;

    for (const b of this._bodies) {
      b.pulseT += dt;

      // natural pulse timer — quiet passages slow the rhythm right down
      const per = b.period * (1.55 - Math.min(energy, 1) * 0.75);
      if (b.pulseT > per) this._trigger(b, 0.42 + energy * 0.45);
      const env = this._env(b);

      // thrust while contracting, drag while gliding (dt-scaled physics)
      if (b.pulseT >= 0 && b.pulseT < 0.5) b.v += env * 2.3 * dt;
      b.v *= Math.exp(-dt * 1.05);
      b.v = Math.min(Math.max(b.v, 0.018), 0.55);

      // ── steering: everything acts on the HEADING only, slew-limited —
      // direction changes take tens of seconds, nothing can jump ──
      const wander = b.baseDir
        + Math.sin(t * 0.043 + b.seed * 37) * 0.55
        + Math.sin(t * 0.011 + b.seed * 91) * 0.35;
      let sx = Math.sin(wander), sy = Math.cos(wander);
      // jellies stay mostly upright — but the up-bias fades as a body
      // rises so the shoal never parks at the top of the frame
      sy += 0.55 - Math.min(Math.max(b.y, 0) * 1.0, 1.2);
      // stay in frame + drift back toward the group; recall hardens with
      // distance so a drop can never fling anyone out of the picture
      const exX = Math.max(0, Math.abs(b.x) - asp * 0.75);
      const exY = Math.max(0, Math.abs(b.y) - 0.55);
      sx += (b.homeX - b.x) * 0.42 + (mx - b.x) * 0.08 - b.x * exX * 2.0;
      sy += (b.homeY - b.y) * 0.60 + (my - b.y) * 0.08 - b.y * exY * 3.5;
      // gentle separation from the nearest neighbour (no collisions, ever)
      let nd = 1e9, nx = 0, ny = 0;
      for (const o of this._bodies) {
        if (o === b) continue;
        const d = Math.hypot(o.x - b.x, o.y - b.y);
        if (d < nd) { nd = d; nx = o.x; ny = o.y; }
      }
      if (nd < 0.6) {
        const w = (0.6 - nd) * 3.0;
        sx += (b.x - nx) / (nd + 1e-4) * w;
        sy += (b.y - ny) / (nd + 1e-4) * w;
      }
      let rate = 0.45;   // rad/s turn limit — the "grace" knob
      if (exX > 0.15 || exY > 0.15) rate = 0.7;   // straying: turn home sooner
      if (b.fleeT > 0) {
        const w = (b.fleeT / 2.2) * 2.0;
        sx += b.fleeX * w; sy += b.fleeY * w;
        rate = 0.85;
        b.fleeT -= dt;
      }
      if (attOn) { sx += (attX - b.x) * 0.35; sy += (attY - b.y) * 0.35; }
      if (repOn) {
        const d = Math.hypot(b.x - repX, b.y - repY) + 1e-4;
        const w = Math.max(0, 1.2 - d) * 1.6;
        sx += (b.x - repX) / d * w;
        sy += (b.y - repY) / d * w;
        rate = 0.7;
      }
      const dh = angDiff(b.heading, Math.atan2(sx, sy));
      const maxStep = rate * dt;
      b.heading += Math.max(-maxStep, Math.min(maxStep, dh));

      // integrate: swim along heading, sink slowly, ride a faint current
      const par = 0.55 + b.depth * 0.7;   // parallax: near = faster apparent
      b.x += Math.sin(b.heading) * b.v * par * dt
           + Math.sin(t * 0.047 + b.seed * 6.1) * 0.010 * dt;
      b.y += Math.cos(b.heading) * b.v * par * dt
           - (0.035 + Math.max(b.y, 0) * 0.045) * par * dt;

      b.flash *= Math.exp(-dt * 3.2);
      // tentacle sway follows the body's motion through a slow EMA — the
      // ~0.85 s lag is what makes the arms trail instead of stick
      const swTarget = Math.min(1.4, b.v * 2.2 + env * 0.7) * (0.55 + this._midEma * 1.5);
      b.sway += (swTarget - b.sway) * (1 - Math.exp(-dt / 0.85));
    }

    // documentary camera: the frame slowly tracks the shoal, so sustained
    // pulsing (which lifts real jellies too) can't crowd the picture edge
    for (const b of this._bodies) {
      b.x -= mx * dt * 0.30;
      b.y -= my * dt * 0.45;
    }

    // ── write extra region, sorted far → near for painter compositing ──
    const e = this._extra;
    [...this._bodies].sort((a, b) => a.depth - b.depth).forEach((b, i) => {
      const env = this._env(b);
      e[i * 8]     = b.x;
      e[i * 8 + 1] = b.y;
      e[i * 8 + 2] = b.depth;
      e[i * 8 + 3] = Math.min(env, 1.3);
      e[i * 8 + 4] = b.heading;
      e[i * 8 + 5] = 0.22 + energy * 0.30 + env * 1.15 + b.flash + this._dropWave * 0.35;
      e[i * 8 + 6] = b.size;
      e[i * 8 + 7] = b.sway;
    });
    e[56] = this._tapX;    e[57] = this._tapY;   e[58] = this._tapEnv;  e[59] = this._dropWave;
    e[60] = this._snareEnv; e[61] = this._midEma; e[62] = this._highEma; e[63] = this._bassEma;

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
    if (window.__medusa === this) delete window.__medusa;
    this.post?.destroy();
  }
}
