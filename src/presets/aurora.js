import shaderSource from '../shaders/aurora.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

// AURORA — polar aurora over a dark arctic night.
//
// The shader draws layered fbm curtains with fine vertical ray structure;
// this side owns the curtain choreography: a population of up to 6 curtains
// ignites/retires with musical activity, kicks send a brightness wave
// traveling along the brightest curtain, snares flicker the shimmer, a
// detected drop fires a magnetospheric substorm (every curtain erupts +
// a corona blooms at the zenith, then calms over a few seconds). Taps
// ignite a fresh curtain at the tapped x. Curtain state is uploaded through
// the extra uniform region — layout documented in aurora.wgsl.
const MAX_CURTAINS = 6;

export class AuroraPreset {
  constructor() {
    this.frameCount = 0;
    this._params = null;
    this.curtains = Array.from({ length: MAX_CURTAINS }, () => ({
      x: 0, seed: Math.random() * 100, age: 999, amp: 0, target: 0,
      life: 0, width: 1, waveX: 0, waveAmp: 0, waveTarget: 0, waveDir: 1,
      ignite: 0, igniteT: 0,
    }));
    this.extra = new Float32Array(64);
    this.prevKick = 0;
    this.prevSnare = 0;
    this.prevDrop = 0;
    this.prevTap = null;      // null → first frame never reads a ghost tap
    // All envelopes below are follower/target pairs: the *T target is set by
    // transients and decays; the follower EMA-eases toward it so the shader
    // never sees a single-frame jump. Real aurora flows — it never snaps.
    this.substorm = 0;  this.substormT = 0;  // drop: whole-sky eruption
    this.corona = 0;    this.coronaT = 0;    // zenith corona bloom
    this.flicker = 0;   this.flickerT = 0;   // snare shimmer (subtle)
    this.tapFlash = 0;  this.tapFlashT = 0;
    this.energy = 0;          // smoothed band energy
    this.raise = 0;           // slew-limited tension → curtains creep higher
    this.raiseT = 0;          // EMA stage feeding this.raise
    this.nextSpawnAt = 0;
    // asymmetric EMA (attack ~0.2 s / release ~1-2 s) of every raw band —
    // the only audio state the uniforms ever receive
    this.sm = { sub: 0, bass: 0, mid: 0, high: 0, kick: 0, snare: 0, pulse: 0 };
    // slew-limited motion-character drivers uploaded in extra[14]
    this.swayAmp = 0.14;      // quiet-state baselines match the shader's old
    this.foldAmp = 0.30;      //   constants exactly, so silence is unchanged
    this.rayContr = 0.40;
    this.flickPhase = null;   // integrated ray-flicker phase (init to t)
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;
    const module = device.createShaderModule({ label: 'aurora', code: shaderSource });
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const bgl = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      }],
    });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex:   { module, entryPoint: 'vs_fullscreen' },
      fragment: {
        module,
        entryPoint: 'fs_render',
        targets: [{
          format: ACCUM_FORMAT,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.bindGroup = device.createBindGroup({
      layout: bgl,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
    this.post = new PostFX();
    this.post.init(device, format, canvas);
  }

  // Pick a spawn x far from existing bright curtains (spread across the sky).
  _placeX() {
    let bestX = 0, bestD = -1;
    for (let k = 0; k < 4; k++) {
      const x = (Math.random() * 2 - 1) * 0.85;
      let d = 2;
      for (const c of this.curtains)
        if (c.amp > 0.1) d = Math.min(d, Math.abs(c.x - x));
      if (d > bestD) { bestD = d; bestX = x; }
    }
    return bestX;
  }

  // Ignite a curtain in the stalest slot.
  _spawn(x, amp, life, opts = {}) {
    let best = 0, bestScore = 1e9;
    for (let i = 0; i < MAX_CURTAINS; i++) {
      const c = this.curtains[i];
      const score = Math.max(c.amp, c.target);
      if (score < bestScore) { bestScore = score; best = i; }
    }
    const c = this.curtains[best];
    c.x = Math.max(-0.95, Math.min(0.95, x));
    c.seed = Math.random() * 100;
    c.age = 0;
    c.target = amp;
    c.life = life;
    c.width = opts.width ?? (0.45 + Math.random() * 0.85);
    c.waveAmp = 0;
    c.waveTarget = 0;
    c.igniteT = opts.ignite ?? 0.45;   // eased in by the follower, not snapped
    return c;
  }

  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._params = params;
    const dt = Math.min(deltaMs, 50) * 0.001;
    const t = timeMs * 0.001;

    const kick  = bands.kick  ?? 0;
    const snare = bands.snare ?? 0;
    const drop  = params.dropPulse ?? 0;

    // asymmetric EMA: fast-ish attack, slow release (tau in seconds)
    const ema = (cur, tgt, tauA, tauR) =>
      cur + (tgt - cur) * (1 - Math.exp(-dt / (tgt > cur ? tauA : tauR)));
    // slew limiter: cap |d/dt| at `rate` units per second
    const slew = (cur, tgt, rate) =>
      cur + Math.max(-rate * dt, Math.min(rate * dt, tgt - cur));

    // ── Band smoothing: raw FFT frames never reach the uniforms ─────────
    const S = this.sm;
    S.sub   = ema(S.sub,   bands.subBass ?? 0, 0.20, 1.5);
    S.bass  = ema(S.bass,  bands.bass    ?? 0, 0.20, 1.5);
    S.mid   = ema(S.mid,   bands.mid     ?? 0, 0.20, 1.5);
    S.high  = ema(S.high,  bands.high    ?? 0, 0.20, 1.2);
    S.kick  = ema(S.kick,  kick,               0.15, 1.0);
    S.snare = ema(S.snare, snare,              0.15, 1.0);
    S.pulse = ema(S.pulse, params.pulse ?? 0,  0.09, 0.35);  // MIDI flash → swell

    // smoothed musical state (dt-scaled) — fed by the smoothed bands
    const e = (S.bass + S.mid + S.high) / 3;
    this.energy += (e - this.energy) * (1 - Math.exp(-dt * 1.2));
    this.raiseT += ((params.tension ?? 0) - this.raiseT) * (1 - Math.exp(-dt * 2.0));
    this.raise = slew(this.raise, this.raiseT, 0.35);  // curtain height creeps, never yanks

    // ── Population: quiet music = one faint slow curtain; activity grows it
    const desired = this.substorm > 0.35
      ? MAX_CURTAINS
      : 1 + Math.round(Math.min(1, this.energy * 1.7 + this.raise * 0.5) * 2.5);
    let live = 0;
    for (const c of this.curtains) if (c.amp > 0.02 || c.target > 0.02) live++;
    if (live < desired && t > this.nextSpawnAt) {
      this._spawn(this._placeX(),
                  0.45 + this.energy * 0.75 + Math.random() * 0.2,
                  9 + Math.random() * 14);
      this.nextSpawnAt = t + 1.0 + Math.random() * 2.5;
    } else if (live > desired + 1 && this.substorm < 0.2) {
      let dim = null;
      for (const c of this.curtains)
        if (c.target > 0.02 && (!dim || c.amp < dim.amp)) dim = c;
      if (dim) dim.target = 0;
    }

    // per-curtain envelopes (all dt-scaled)
    for (const c of this.curtains) {
      c.age += dt;
      c.life -= dt;
      if (c.life < 0 && c.target > 0 && this.substorm < 0.3) c.target = 0;
      // ignite faster than fade; substorms bloom quicker (~0.3 s) but still ease
      const k = c.target > c.amp ? 1.1 + this.substorm * 2.5 : 0.35;
      c.amp += (c.target - c.amp) * (1 - Math.exp(-dt * k));
      c.igniteT *= Math.exp(-dt * 2.4);
      c.ignite = ema(c.ignite, c.igniteT, 0.15, 0.45);      // white border swells, no pop
      // kick wave: target decays while the follower eases in (~0.22 s) and
      // out (~0.6 s) → each wave is a ~1 s traveling envelope, never a jump
      c.waveTarget *= Math.exp(-dt * 1.6);
      c.waveAmp = ema(c.waveAmp, c.waveTarget, 0.22, 0.6);
      if (c.waveAmp > 0.01) {
        c.waveX += c.waveDir * dt * (1.5 + this.energy * 1.2);
        if (Math.abs(c.waveX) > c.width * 2.4) c.waveTarget = 0;  // fade off the edge
      }
    }

    // ── Transients ──────────────────────────────────────────────────────
    // kick: brightness wave travels along the brightest curtain
    if (kick > 0.5 && this.prevKick <= 0.5) {
      let best = null;
      for (const c of this.curtains)
        if (c.amp > 0.1 && (!best || c.amp > best.amp)) best = c;
      if (best) {
        // only relaunch from the edge if no wave is mid-flight — resetting
        // waveX on a live wave would teleport the bright spot
        if (best.waveAmp < 0.15) {
          best.waveDir = Math.random() < 0.5 ? 1 : -1;
          best.waveX = -best.waveDir * best.width * 1.7;
        }
        best.waveTarget = Math.max(best.waveTarget,
                                   Math.min(1.2, 0.55 + kick * 0.55));
      }
    }
    // snare: subtle shimmer — small target, eased follower (not a flash)
    if (snare > 0.55 && this.prevSnare <= 0.55)
      this.flickerT = Math.max(this.flickerT, 0.22 + snare * 0.18);
    // drop: magnetospheric substorm — everything erupts, corona at zenith
    if (drop > 0.6 && this.prevDrop <= 0.6) {
      this.substormT = 1;
      this.coronaT = 1;
      for (const c of this.curtains) {
        if (c.amp < 0.12 && c.target < 0.12) {
          c.x = this._placeX();
          c.seed = Math.random() * 100;
          c.age = 0;
          c.width = 0.5 + Math.random() * 0.9;
        }
        // eruption blooms over ~0.3 s (substorm-boosted attack in the
        // envelope loop) instead of snapping bright in one frame
        c.target = 1.05 + Math.random() * 0.35;
        c.life = Math.max(c.life, 5 + Math.random() * 4);
        c.igniteT = Math.max(c.igniteT, 0.5);
        // traveling waves race along every curtain (eased in like kick waves)
        c.waveDir = Math.random() < 0.5 ? 1 : -1;
        c.waveX = -c.waveDir * c.width * 1.7;
        c.waveTarget = Math.max(c.waveTarget, 0.55 + Math.random() * 0.4);
      }
    }
    this.prevKick = kick;
    this.prevSnare = snare;
    this.prevDrop = drop;

    // ── Tap: a new curtain ignites at the tapped x ──────────────────────
    const tapN = params.cymTapN ?? 0;
    if (this.prevTap !== null && tapN !== this.prevTap) {
      this._spawn((params.cymTapX ?? 0.5) * 2 - 1,
                  0.85 + Math.random() * 0.25,
                  10 + Math.random() * 8,
                  { ignite: 1.0, width: 0.5 + Math.random() * 0.5 });
      this.tapFlashT = 1;
    }
    this.prevTap = tapN;

    // bonus: palms drag the nearest curtain (gesture HANDS mode)
    if (params.gestMode === 2 && params.hands?.h) {
      for (const hand of params.hands.h) {
        if (!hand?.present) continue;
        const hx = hand.x * 2 - 1;
        let near = null, nd = 0.6;
        for (const c of this.curtains) {
          if (c.amp < 0.1) continue;
          const d = Math.abs(c.x - hx);
          if (d < nd) { nd = d; near = c; }
        }
        if (near) near.x += (hx - near.x) * (1 - Math.exp(-dt * 3.0));
      }
    }

    // global decays: targets decay, followers ease toward them (attack/release)
    this.substormT *= Math.exp(-dt * 0.45);   // calms over ~4-6 s
    this.coronaT   *= Math.exp(-dt * 0.75);
    this.flickerT  *= Math.exp(-dt * 3.0);
    this.tapFlashT *= Math.exp(-dt * 4.0);
    this.substorm = ema(this.substorm, this.substormT, 0.25, 0.30);
    this.corona   = ema(this.corona,   this.coronaT,   0.30, 0.35);
    this.flicker  = ema(this.flicker,  this.flickerT,  0.12, 0.25);
    this.tapFlash = ema(this.tapFlash, this.tapFlashT, 0.08, 0.30);

    // ── Motion character (was computed per-pixel from raw bands in WGSL) ──
    // Quiet baselines (0.14 / 0.30 / 0.40 / rate 1.0) match the shader's old
    // constants exactly, so the approved quiet look is untouched. Amplitudes
    // are slew-limited so a loud transient cannot yank a curtain.
    const swayTgt = 0.14 + S.bass * (params.mulBass ?? 1) * 0.34 + this.substorm * 0.18;
    this.swayAmp = slew(this.swayAmp, swayTgt, 0.30);
    const foldTgt = 0.30 + S.mid * (params.mulMid ?? 1) * 0.55 + this.substorm * 0.25;
    this.foldAmp = slew(this.foldAmp, foldTgt, 0.45);
    const rayTgt = Math.min(1.15,
      0.40 + S.high * (params.mulHigh ?? 1) * 0.50 + this.flicker * 0.45 + this.substorm * 0.35);
    this.rayContr = slew(this.rayContr, rayTgt, 0.60);
    // ray flicker: integrate a phase at a capped rate — the shader used
    // u.time * rate, so any per-frame rate change scrambled the phase by
    // rate_delta * elapsed_seconds (the main strobe source)
    const flickRate = Math.min(5.5,
      1.0 + S.high * (params.mulHigh ?? 1) * 3.5 + this.flicker * 2.0 + this.substorm * 2.0);
    if (this.flickPhase === null) this.flickPhase = t;  // continuity with u.time
    this.flickPhase += flickRate * dt;

    // low persistence — ray structure must stay crisp
    const alpha = 1 - 0.5 * PostFX.effTrail(params);
    // the uniforms receive only the smoothed bands — never raw FFT frames
    const smBands = { subBass: S.sub, bass: S.bass, mid: S.mid, high: S.high,
                      kick: S.kick, snare: S.snare };
    const u = buildUniforms(smBands, timeMs, deltaMs, params, this.canvas, this.frameCount, alpha);
    device.queue.writeBuffer(this.uniformBuffer, 0, u);

    // extra region upload — layout documented in aurora.wgsl header
    const d = this.extra;
    for (let i = 0; i < MAX_CURTAINS; i++) {
      const c = this.curtains[i];
      d[i * 4 + 0] = c.x;
      d[i * 4 + 1] = c.seed;
      d[i * 4 + 2] = c.age;
      d[i * 4 + 3] = c.amp;
      d[24 + i * 4 + 0] = c.width;
      d[24 + i * 4 + 1] = c.waveX;
      d[24 + i * 4 + 2] = c.waveAmp;
      d[24 + i * 4 + 3] = c.ignite;
    }
    d[48] = this.substorm;
    d[49] = this.flicker;
    d[50] = this.energy;
    d[51] = this.raise;
    d[52] = this.corona;
    d[53] = this.tapFlash;
    d[54] = S.pulse;         // smoothed MIDI pulse (extra[13].z)
    d[56] = this.swayAmp;    // extra[14]: slew-limited motion character
    d[57] = this.foldAmp;
    d[58] = this.flickPhase;
    d[59] = this.rayContr;
    device.queue.writeBuffer(this.uniformBuffer, RIPPLE_OFFSET, d);
  }

  draw(device, view) {
    this.post.ensureTargets();
    const enc = device.createCommandEncoder();
    // warp last frame through the echo pass (fade 1 — alpha does the decay)
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
    this.post?.destroy();
  }
}
