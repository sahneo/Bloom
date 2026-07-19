import shaderSource from '../shaders/pendulum.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

// PENDULUM — a monumental pendulum-wave installation: 96 glowing bobs hang
// into a dark stage on faint wires, each with a slightly different frequency.
// The choreography is a single master swing phase ψ plus a slow cycle c whose
// "winding" W(c) fans per-pendulum phase offsets 0 → Wmax → 0: unison →
// traveling waves → helix → dense shimmer → back to unison, hypnotically.
//
// Beat-native physics: with a locked beat, ψ phase-pulls onto the beat grid
// (one full swing per bar-ish, coupling ∝ beat_conf) and the cycle rate locks
// to 64 beats (16 bars) with its unison point pulled onto phrase boundaries —
// so wave patterns travel per-bar and collapse to unison on the phrase.
// kick   → energy wave travels along the array (amplitude boost front)
// snare  → sparkle on bobs at motion extremes
// bass   → swing amplitude baseline (EMA)         high → brightness shimmer
// tension→ winding tightens toward order          DROP → snap to unison +
// flash, then the spread re-diverges — the rebirth of complexity is the show.
// Tap    → grab-and-release: nearest pendulums get a phase + amplitude kick.
// HANDS  → palm height conducts a local amplitude envelope; fist damps all
// toward rest; releasing the fist fires a drop-style unison restart.

const N = 96;
const FLOOR_Y = -0.62;
const TAU = Math.PI * 2;

const smoothstep = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

export class PendulumPreset {
  constructor() {
    this.frameCount = 0;
    this._params = null;
    this._dtMs   = 16.67;

    // choreography clocks
    this._psi  = Math.random() * TAU;   // master swing phase
    this._c    = 0.10;                  // cycle 0..1 (winding envelope)
    this._seed = Math.random() * 10;

    // beat-rate estimation (mirrors FIREFLIES)
    this._prevBeatT = 0;
    this._bps       = 0;
    this._confSm    = 0;

    // music EMAs + events
    this._bassSm    = 0;
    this._energySm  = 0;
    this._tensionSm = 0;
    this._prevKick  = 0;
    this._kickCd    = 0;
    this._fronts    = [];   // traveling energy waves {age, dir, str}
    this._frontDir  = 1;
    this._prevSnare = 0;
    this._sparkle   = 0;
    this._prevDrop  = 0;
    this._dropFlash = 0;
    this._unison    = 0;    // drop: collapse winding → all in phase
    this._uniSm     = 0;    // ~80 ms smoothing so the snap sweeps, not jumps
    this._dampEnv   = 0;    // fist: damp all toward rest

    // per-pendulum state
    this._excite   = new Float32Array(N);   // kick-wave amplitude boost
    this._tapAmp   = new Float32Array(N);   // tap amplitude kick
    this._tapPhase = new Float32Array(N);   // tap phase kick
    this._seedArr  = Float32Array.from({ length: N }, () => Math.random());
    this._inst     = new Float32Array(N * 8);
    this._extra    = new Float32Array(8);

    this._prevTapN = null;
    this._hands = [
      { x: 0, amp: 0, grip: 0, fisted: false },
      { x: 0, amp: 0, grip: 0, fisted: false },
    ];
  }

  _asp() {
    return Math.max(this.canvas.width / Math.max(this.canvas.height, 1), 0.5) || 1.6;
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;

    const module = device.createShaderModule({ label: 'pendulum', code: shaderSource });
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.instBuffer = device.createBuffer({
      size: N * 8 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this._bgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.bindGroup = device.createBindGroup({
      layout: this._bgl,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.instBuffer } },
      ],
    });

    const additive = {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    };
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this._bgl] });
    const pipe = (vs, fs) => device.createRenderPipeline({
      layout,
      vertex:   { module, entryPoint: vs },
      fragment: { module, entryPoint: fs, targets: [{ format: ACCUM_FORMAT, blend: additive }] },
      primitive: { topology: 'triangle-list' },
    });
    this.bgPipeline   = pipe('vs_bg',   'fs_bg');
    this.wirePipeline = pipe('vs_wire', 'fs_wire');
    this.reflPipeline = pipe('vs_refl', 'fs_refl');
    this.bobPipeline  = pipe('vs_bob',  'fs_bob');

    this.post = new PostFX();
    this.post.init(device, format, canvas);
  }

  // ── music → choreography drivers ──────────────────────────────────────
  _updateMusic(bands, dt, params) {
    // beats/second from the beat_t derivative, EMA-smoothed and tempo-gated
    const beatT = params.beatT ?? 0;
    const raw   = dt > 0 ? (beatT - this._prevBeatT) / dt : 0;
    this._prevBeatT = beatT;
    if (raw > 0.3 && raw < 6) this._bps += (raw - this._bps) * (1 - Math.exp(-dt / 1.2));
    const conf = params.beatConf ?? 0;
    const tau  = conf > this._confSm ? 0.6 : 2.5;
    this._confSm += (conf - this._confSm) * (1 - Math.exp(-dt / tau));

    // bass → swing amplitude baseline; overall energy → dim/quiet state
    const ab = 1 - Math.exp(-dt / 0.45);
    this._bassSm += (((bands.bass ?? 0) + (bands.subBass ?? 0) * 0.7) - this._bassSm) * ab;
    const energy = ((bands.bass ?? 0) + (bands.mid ?? 0) + (bands.high ?? 0)) / 3;
    this._energySm += (energy - this._energySm) * (1 - Math.exp(-dt / 0.8));
    this._tensionSm += ((params.tension ?? 0) - this._tensionSm) * (1 - Math.exp(-dt / 1.0));

    // kick → an amplitude wave races along the array from alternating ends
    const kick = bands.kick ?? 0;
    this._kickCd = Math.max(0, this._kickCd - dt);
    if (kick > 0.45 && this._prevKick < 0.35 && this._kickCd <= 0) {
      if (this._fronts.length < 5) {
        this._fronts.push({ age: 0, dir: this._frontDir, str: 0.55 + kick * 0.55 });
        this._frontDir = -this._frontDir;
      }
      this._kickCd = 0.14;
    }
    this._prevKick = kick;
    for (const f of this._fronts) f.age += dt;
    this._fronts = this._fronts.filter(f => f.age < 1.1);

    // snare → brief sparkle on bobs caught at their extremes
    const snare = bands.snare ?? 0;
    if (snare > 0.35 && this._prevSnare < 0.3) {
      this._sparkle = Math.max(this._sparkle, 0.5 + snare * 0.5);
    }
    this._prevSnare = snare;
    this._sparkle *= Math.exp(-dt * 6);

    // DROP → winding collapses (unison snap) + flash, then re-diverges
    const drop = params.dropPulse ?? 0;
    if (drop > 0.5 && this._prevDrop <= 0.5) {
      this._unison    = 1;
      this._dropFlash = 1;
    }
    this._prevDrop = drop;
    this._dropFlash *= Math.exp(-dt * 3.2);
    this._unison    *= Math.exp(-dt * 0.55);          // re-diverge over ~3–5 s
    this._uniSm += (this._unison - this._uniSm) * (1 - Math.exp(-dt / 0.08));
  }

  // ── hands: palm conducts local amplitude, fist damps, release = restart ─
  _updateHands(dt, params) {
    const active = params.gestMode === 2 && params.hands;
    const asp    = this._asp();
    for (let s = 0; s < 2; s++) {
      const st = this._hands[s];
      const h  = active ? params.hands.h?.[s] : null;
      const pres = h?.present ?? 0;
      if (!h || pres < 0.02) {
        st.amp *= Math.exp(-dt * 3.5);
        st.grip *= Math.exp(-dt * 3.5);
        st.fisted = false;
        continue;
      }
      st.x = ((h.x ?? 0.5) * 2 - 1) * asp;
      st.grip += ((h.grip ?? 0) - st.grip) * (1 - Math.exp(-dt / 0.12));
      const height = Math.min(Math.max(1.15 - (h.y ?? 0.5) * 1.3, 0), 1);
      const target = pres * (1 - st.grip) * height;
      st.amp += (target - st.amp) * (1 - Math.exp(-dt / 0.25));
      if (st.grip > 0.65 && !st.fisted) st.fisted = true;
      if (st.fisted && st.grip < 0.45) {            // release → unison restart
        st.fisted = false;
        this._unison    = 1;
        this._dropFlash = Math.max(this._dropFlash, 0.55);
      }
    }
    const anyFist = this._hands.some(st => st.fisted);
    const tgt = anyFist ? 1 : 0;
    this._dampEnv += (tgt - this._dampEnv) * (1 - Math.exp(-dt / (anyFist ? 0.35 : 0.9)));
  }

  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._params = params;
    this._dtMs   = deltaMs;
    const dt     = Math.min(deltaMs * 0.001, 0.05);
    const timeS  = timeMs * 0.001;
    const asp    = this._asp();

    this._updateMusic(bands, dt, params);
    this._updateHands(dt, params);

    // pointer tap → grab-and-release kick on the nearest pendulums
    const tapN = params.cymTapN ?? 0;
    if (this._prevTapN === null) this._prevTapN = tapN;   // ignore stale taps
    if (tapN !== this._prevTapN) {
      this._prevTapN = tapN;
      const tx = ((params.cymTapX ?? 0.5) * 2 - 1) * asp;
      const sig = 0.20 * asp;
      for (let i = 0; i < N; i++) {
        const ax = (-0.97 + 1.94 * (i / (N - 1))) * asp;
        const g  = Math.exp(-((ax - tx) * (ax - tx)) / (2 * sig * sig));
        this._tapAmp[i]   += 0.32 * g;
        this._tapPhase[i] += 1.35 * g;
      }
    }
    const tapAmpDecay   = Math.exp(-dt * 1.1);
    const tapPhaseDecay = Math.exp(-dt * 0.9);
    const exciteDecay   = Math.exp(-dt * 1.5);

    // ── swing phase ψ: free-runs, phase-pulls onto the beat grid ─────────
    const hasBeat = this._bps > 0.2 && this._confSm > 0.02;
    let div = 4;
    if (hasBeat) {                       // pick swing = bps/div nearest 0.45 Hz
      let bd = 1e9;
      for (const d of [2, 4, 8]) {
        const f = this._bps / d;
        const err = Math.abs(Math.log(f / 0.45));
        if (f > 0.15 && f < 1.2 && err < bd) { bd = err; div = d; }
      }
    }
    const fBeat  = hasBeat ? this._bps / div : 0.42;
    const fSwing = 0.42 + (fBeat - 0.42) * this._confSm;
    this._psi += TAU * fSwing * dt;
    if (hasBeat) {
      const grid = TAU * ((params.beatT ?? 0) / div);
      this._psi += Math.sin(grid - this._psi) * this._confSm * 1.6 * dt;
    }
    if (this._psi > 1e4) this._psi -= TAU * Math.floor(this._psi / TAU);

    // ── cycle c: winding envelope; locks to 64 beats, unison on the phrase ─
    const rateFree = 1 / 34;
    const rate = hasBeat ? rateFree + (this._bps / 64 - rateFree) * this._confSm : rateFree;
    this._c = (this._c + rate * dt) % 1;
    if (hasBeat) {
      const cg = ((params.beatT ?? 0) / 64) % 1;
      this._c += Math.sin(TAU * (cg - this._c)) * this._confSm * 0.10 * dt;
      this._c = ((this._c % 1) + 1) % 1;
    }

    // winding: waves across the array. 0 → Wmax → 0 per cycle; tension
    // tightens toward order; drop collapses it (unison) then re-fans it.
    const Wmax = 8 + 3.5 * Math.sin(timeS * 0.021 + this._seed);
    const W = Wmax * 0.5 * (1 - Math.cos(TAU * this._c))
            * (1 - 0.35 * this._tensionSm)
            * (1 - this._uniSm);

    // amplitude baseline: bass-driven majesty, fist-damped, quiet = whisper
    const A0 = (0.055 + this._bassSm * 0.50 + this._tensionSm * 0.04)
             * (1 - 0.93 * this._dampEnv);
    const dim = (0.22 + 0.78 * smoothstep(0.02, 0.20, this._energySm))
              * (1 - 0.80 * this._dampEnv);

    // ── per-pendulum: integrate + write instances ────────────────────────
    const inst = this._inst;
    for (let i = 0; i < N; i++) {
      const t  = i / (N - 1);
      const sd = this._seedArr[i];

      // kick fronts racing along the array
      let boost = 0;
      for (const f of this._fronts) {
        const pos = f.dir > 0 ? f.age * 1.55 : 1 - f.age * 1.55;
        const dx  = (t - pos) / 0.06;
        boost += Math.exp(-f.age * 1.9) * f.str * Math.exp(-dx * dx);
      }
      this._excite[i] = Math.max(this._excite[i] * exciteDecay, Math.min(boost, 1));
      this._tapAmp[i]   *= tapAmpDecay;
      this._tapPhase[i] *= tapPhaseDecay;

      // per-pendulum detune wobble, suppressed as the beat locks
      const dn = 0.10 * (1 - 0.7 * this._confSm)
               * Math.sin(timeS * (0.11 + sd * 0.13) + sd * 43);

      const phi = this._psi + TAU * t * W + this._tapPhase[i] + dn;
      const sw  = Math.sin(phi);

      // hands: local conducting envelope
      let hb = 0;
      for (const st of this._hands) {
        if (st.amp < 0.01) continue;
        const ax = (-0.97 + 1.94 * t) * asp;
        const dxh = (ax - st.x) / (0.45 * asp);
        hb += st.amp * 1.6 * Math.exp(-dxh * dxh);
      }

      const amp = Math.min(A0 * (1 + hb) + this._excite[i] * 0.30 + this._tapAmp[i], 0.78);

      // geometry: pendulums swing toward/away from the camera (the museum
      // view where the wave snake reads). Projection: +s (toward viewer) →
      // lower on screen, slightly bigger and brighter. Beam recedes gently
      // in Z left→near, right→far.
      const L    = 1.30 - 0.30 * t;
      const ancX = (-0.97 + 1.94 * t) * asp;
      const ancY = 1.06 - 0.16 * t;
      const s    = amp * L * sw;                      // swing depth, projected
      const bobX = ancX + s * 0.06 * (ancX / asp);    // subtle radial parallax
      const bobY = Math.max(ancY - L - s * 0.40, FLOOR_Y + 0.05);
      const persp = 1 + s * 0.18;

      const extreme = Math.abs(sw);
      const ex = this._excite[i];
      const bright = ((0.16 + 0.90 * amp) * dim
                    + 0.30 * extreme * extreme * extreme * dim
                    + ex * 0.25 * dim
                    + this._dropFlash * 1.0)
                   * (1 - 0.35 * t) * (1 + s * 0.15);
      const sizePx = (6.0 - 2.6 * t) * persp * (1 + ex * 0.2 + this._dropFlash * 0.25);

      const o = i * 8;
      inst[o]     = bobX;  inst[o + 1] = bobY;
      inst[o + 2] = ancX;  inst[o + 3] = ancY;
      inst[o + 4] = sizePx;
      inst[o + 5] = bright;
      inst[o + 6] = extreme;
      inst[o + 7] = t;
    }
    device.queue.writeBuffer(this.instBuffer, 0, inst);

    const { gain } = PostFX.trailFactors(params, deltaMs);
    const u = buildUniforms(bands, timeMs, deltaMs, params, this.canvas, this.frameCount, gain);
    device.queue.writeBuffer(this.uniformBuffer, 0, u);

    const e = this._extra;
    e[0] = this._sparkle;
    e[1] = this._dropFlash;
    e[2] = this._uniSm;
    e[3] = dim;
    e[4] = FLOOR_Y;
    e[5] = 1 - smoothstep(0.02, 0.15, this._energySm);   // quiet → glints
    e[6] = N;
    e[7] = 0;
    device.queue.writeBuffer(this.uniformBuffer, RIPPLE_OFFSET, e);
  }

  draw(device, view) {
    this.post.ensureTargets();
    const { fade } = PostFX.trailFactors(this._params, this._dtMs);

    const enc = device.createCommandEncoder();
    this.post.fadePass(enc, fade, this._params);

    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.post.accumView, loadOp: 'load', storeOp: 'store' }],
    });
    pass.setBindGroup(0, this.bindGroup);
    pass.setPipeline(this.bgPipeline);
    pass.draw(3);
    pass.setPipeline(this.wirePipeline);
    pass.draw(N * 6);
    pass.setPipeline(this.reflPipeline);
    pass.draw(N * 6);
    pass.setPipeline(this.bobPipeline);
    pass.draw(N * 6);
    pass.end();

    this.post.finish(enc, view, this._params);
    device.queue.submit([enc.finish()]);
  }

  destroy() {
    this.instBuffer?.destroy();
    this.post?.destroy();
  }
}
