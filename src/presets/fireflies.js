import computeSource from '../shaders/fireflies_compute.wgsl?raw';
import renderSource  from '../shaders/fireflies_render.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

// FIREFLIES — a pitch-dark summer forest full of fireflies that gradually
// SYNCHRONIZE their blinking to the music, like real Photinus carolinus.
// Every firefly is a Kuramoto phase oscillator: it free-runs at its own
// natural blink rate; when the beat tracker locks, coupling (gated on
// beat_conf) pulls all phases toward the global beat phase and waves of
// synchronous flashing sweep the swarm. Kick = coupling surge ripple,
// snare = a cluster startles and scatters, DROP = one giant unison flash
// followed by desynchronization and a slow re-lock over a few bars — the
// resync is the show. extra[] slot map lives in fireflies_compute.wgsl.

const N = 5000;

export class FirefliesPreset {
  constructor() {
    this.frameCount = 0;
    this._params    = null;
    this._dtMs      = 16.67;

    // beat-rate estimation (bps = d(beatT)/dt) + smoothed confidence
    this._prevBeatT = 0;
    this._bps       = 0;
    this._confSm    = 0;

    // musical event state
    this._prevKick  = 0;
    this._kickCd    = 0;
    this._surge     = 0;   // kick coupling-surge envelope
    this._surgeAge  = 9;
    this._surgeX    = 0;
    this._surgeY    = 0;
    this._prevSnare = 0;
    this._snEnv     = 0;   // snare cluster-startle envelope
    this._snAge     = 9;
    this._snX       = 0;
    this._snY       = 0;
    this._prevDrop  = 0;
    this._dropSync  = 0;   // 1 for exactly one frame → unison phase collapse
    this._dropFlash = 0;   // screen flash envelope
    this._kSup      = 0;   // post-drop coupling suppression 1→0

    // ambience
    this._bassSm = 0;
    this._windT  = Math.random() * 100;

    // pointer tap → local startle
    this._prevTapN = null;
    this._tapEnv   = 0;
    this._tapAge   = 9;
    this._tapX     = 0;
    this._tapY     = 0;

    // hands (gestMode 2): open palm attracts a curious cloud, fist scatters
    this._hands = [
      { x: 0, y: 0, grip: 0, attract: 0, scatter: 0, fisted: false },
      { x: 0, y: 0, grip: 0, attract: 0, scatter: 0, fisted: false },
    ];

    this._extra = new Float32Array(28);   // extra[0..6], see WGSL header
  }

  _asp() {
    return Math.max(this.canvas.width / Math.max(this.canvas.height, 1), 0.5) || 1.6;
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;

    const computeModule = device.createShaderModule({ label: 'fireflies-compute', code: computeSource });
    const renderModule  = device.createShaderModule({ label: 'fireflies-render',  code: renderSource  });

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Fly storage: N × 32 B (pos.xy, vel.xy, phase, detune, depth, startle)
    this.flyBuffer = device.createBuffer({
      size: N * 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const seed = new Float32Array(N * 8);
    const asp  = this._asp();
    for (let i = 0; i < N; i++) {
      const o = i * 8;
      seed[o]     = (Math.random() * 2 - 1) * (asp + 0.1);
      seed[o + 1] = Math.random() * 2.2 - 1.1;
      seed[o + 2] = 0;
      seed[o + 3] = 0;
      seed[o + 4] = Math.random();                  // phase — fully incoherent
      seed[o + 5] = Math.random() * 2 - 1;          // detune
      // depth layers: 50% far, 35% mid, 15% near (few big bright leaders)
      const r = Math.random();
      seed[o + 6] = r < 0.5  ? 0.06 + Math.random() * 0.2
                  : r < 0.85 ? 0.42 + Math.random() * 0.22
                  :            0.8  + Math.random() * 0.2;
      seed[o + 7] = 0;                              // startle
    }
    device.queue.writeBuffer(this.flyBuffer, 0, seed);

    const computeBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const renderBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX,                           buffer: { type: 'read-only-storage' } },
      ],
    });
    const makeBindGroup = (layout) => device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.flyBuffer } },
      ],
    });
    this.computeBindGroup = makeBindGroup(computeBGL);
    this.renderBindGroup  = makeBindGroup(renderBGL);

    this.computePipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [computeBGL] }),
      compute: { module: computeModule, entryPoint: 'cs_main' },
    });

    const additive = {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    };
    const renderLayout = device.createPipelineLayout({ bindGroupLayouts: [renderBGL] });
    this.bgPipeline = device.createRenderPipeline({
      layout: renderLayout,
      vertex:   { module: renderModule, entryPoint: 'vs_bg' },
      fragment: { module: renderModule, entryPoint: 'fs_bg',
                  targets: [{ format: ACCUM_FORMAT, blend: additive }] },
      primitive: { topology: 'triangle-list' },
    });
    this.flyPipeline = device.createRenderPipeline({
      layout: renderLayout,
      vertex:   { module: renderModule, entryPoint: 'vs_fly' },
      fragment: { module: renderModule, entryPoint: 'fs_fly',
                  targets: [{ format: ACCUM_FORMAT, blend: additive }] },
      primitive: { topology: 'triangle-list' },
    });

    this.post = new PostFX();
    this.post.init(device, format, canvas);
  }

  // ── music → sync-model drivers ──────────────────────────────────────────
  _updateMusic(bands, dt, params) {
    const asp = this._asp();

    // beats/second from the beat_t derivative, EMA-smoothed and gated to a
    // sane tempo range; fireflies lock their blink rate to this
    const beatT = params.beatT ?? 0;
    const raw   = dt > 0 ? (beatT - this._prevBeatT) / dt : 0;
    this._prevBeatT = beatT;
    if (raw > 0.3 && raw < 6) {
      this._bps += (raw - this._bps) * (1 - Math.exp(-dt / 1.2));
    }
    // confidence: fast rise (lock reads within ~1 s), slow fall (no jitter)
    const conf = params.beatConf ?? 0;
    const tau  = conf > this._confSm ? 0.6 : 2.5;
    this._confSm += (conf - this._confSm) * (1 - Math.exp(-dt / tau));

    // bass → slow swarm breathing; wind → shared drift that is never still
    const ab = 1 - Math.exp(-dt / 0.5);
    this._bassSm += (((bands.bass ?? 0) + (bands.subBass ?? 0) * 0.6) - this._bassSm) * ab;
    this._windT += dt;
    this._windX = Math.sin(this._windT * 0.11 + 1.7) * 0.012;
    this._windY = Math.sin(this._windT * 0.07 + 4.1) * 0.006;

    // kick → coupling surge: a ripple of alignment from a random epicenter
    const kick = bands.kick ?? 0;
    this._kickCd = Math.max(0, this._kickCd - dt);
    if (kick > 0.45 && this._prevKick < 0.35 && this._kickCd <= 0) {
      this._surge    = 1;
      this._surgeAge = 0;
      this._surgeX   = (Math.random() * 2 - 1) * asp * 0.6;
      this._surgeY   = (Math.random() * 2 - 1) * 0.6;
      this._kickCd   = 0.15;
    }
    this._prevKick = kick;
    this._surgeAge += dt;
    this._surge *= Math.exp(-dt * 2.0);

    // snare → a random cluster startles and scatters briefly
    const snare = bands.snare ?? 0;
    if (snare > 0.35 && this._prevSnare < 0.3) {
      this._snEnv = Math.max(this._snEnv, 0.5 + snare * 0.5);
      this._snAge = 0;
      this._snX   = (Math.random() * 2 - 1) * asp * 0.7;
      this._snY   = (Math.random() * 2 - 1) * 0.7;
    }
    this._prevSnare = snare;
    this._snAge += dt;
    this._snEnv *= Math.exp(-dt * 4.5);

    // DROP → unison flash (dropSync = 1 for exactly this frame), then
    // coupling suppression so the swarm falls apart and re-locks over bars
    const drop = params.dropPulse ?? 0;
    this._dropSync = 0;
    if (drop > 0.5 && this._prevDrop <= 0.5) {
      this._dropSync  = 1;
      this._dropFlash = 1;
      this._kSup      = 1;
    }
    this._prevDrop = drop;
    this._dropFlash *= Math.exp(-dt * 4.0);
    this._kSup      *= Math.exp(-dt * 0.45);   // ~2–3 bars to full re-lock
  }

  // ── hands: open palm gathers a curious cloud, fist scatters it ─────────
  _updateHands(dt, params) {
    const active = params.gestMode === 2 && params.hands;
    const asp    = this._asp();
    for (let s = 0; s < 2; s++) {
      const st = this._hands[s];
      const h  = active ? params.hands.h?.[s] : null;
      const pres = h?.present ?? 0;
      if (!h || pres < 0.02) {
        st.attract *= Math.exp(-dt * 4.0);
        st.scatter *= Math.exp(-dt * 3.5);
        st.fisted = false;
        continue;
      }
      st.x = ((h.x ?? 0.5) * 2 - 1) * asp;   // canvas UV (y down) → world
      st.y = 1 - (h.y ?? 0.5) * 2;
      st.grip += ((h.grip ?? 0) - st.grip) * (1 - Math.exp(-dt / 0.12));
      const target = pres * (1 - st.grip);
      st.attract += (target - st.attract) * (1 - Math.exp(-dt / 0.25));
      if (st.grip > 0.65 && !st.fisted) { st.scatter = 1; st.fisted = true; }
      if (st.grip < 0.45) st.fisted = false;
      st.scatter *= Math.exp(-dt * 3.5);
    }
  }

  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._params = params;
    this._dtMs   = deltaMs;

    const dt = Math.min(deltaMs * 0.001, 0.05);
    this._updateMusic(bands, dt, params);
    this._updateHands(dt, params);

    // pointer tap → nearby fireflies startle: scatter + local phase noise
    const tapN = params.cymTapN ?? 0;
    if (this._prevTapN === null) this._prevTapN = tapN;   // ignore stale taps
    if (tapN !== this._prevTapN) {
      this._prevTapN = tapN;
      const asp = this._asp();
      this._tapX = ((params.cymTapX ?? 0.5) * 2 - 1) * asp;
      this._tapY = 1 - (params.cymTapY ?? 0.5) * 2;
      this._tapEnv = 1;
      this._tapAge = 0;
    }
    this._tapAge += dt;
    this._tapEnv *= Math.exp(-dt * 3.2);

    const { gain } = PostFX.trailFactors(params, deltaMs);
    const u = buildUniforms(bands, timeMs, deltaMs, params, this.canvas, this.frameCount, gain);
    device.queue.writeBuffer(this.uniformBuffer, 0, u);

    const e = this._extra;
    e[0]  = this._bps;      e[1]  = this._confSm;  e[2]  = this._surge;    e[3]  = this._kSup;
    e[4]  = this._surgeX;   e[5]  = this._surgeY;  e[6]  = this._surgeAge; e[7]  = this._dropSync;
    e[8]  = this._dropFlash; e[9] = this._bassSm;  e[10] = this._windX;    e[11] = this._windY;
    e[12] = this._snX;      e[13] = this._snY;     e[14] = this._snEnv;    e[15] = this._snAge;
    e[16] = this._tapX;     e[17] = this._tapY;    e[18] = this._tapEnv;   e[19] = this._tapAge;
    for (let s = 0; s < 2; s++) {
      const st = this._hands[s];
      const o  = 20 + s * 4;
      e[o]     = st.x;
      e[o + 1] = st.y;
      e[o + 2] = st.attract;
      e[o + 3] = st.scatter;
    }
    device.queue.writeBuffer(this.uniformBuffer, RIPPLE_OFFSET, e);

    const enc  = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.computePipeline);
    pass.setBindGroup(0, this.computeBindGroup);
    pass.dispatchWorkgroups(Math.ceil(N / 64));
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  draw(device, view) {
    this.post.ensureTargets();
    const { fade } = PostFX.trailFactors(this._params, this._dtMs);

    const enc = device.createCommandEncoder();
    this.post.fadePass(enc, fade, this._params);

    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.post.accumView, loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(this.bgPipeline);        // faint forest, additive
    pass.setBindGroup(0, this.renderBindGroup);
    pass.draw(3);
    pass.setPipeline(this.flyPipeline);       // firefly sprites on top
    pass.draw(N * 6);
    pass.end();

    this.post.finish(enc, view, this._params);
    device.queue.submit([enc.finish()]);
  }

  destroy() {
    this.post?.destroy();
  }
}
