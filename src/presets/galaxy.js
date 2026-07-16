import renderSource from '../shaders/galaxy.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

// GALAXY — deep-space flythrough. The camera drifts forward through a
// parallax starfield dotted with 12 living star clusters (globular knots
// wrapped in nebula gas). Music drives the space itself:
//   kick   → the most prominent cluster flares
//   bass   → nebula cores breathe (inflate + brighten)
//   snare  → hot blue sparkles across the field
//   drop   → supernova: a cluster ahead detonates, warp burst, the
//            shockwave shell rolls through every star
//   quiet  → slow majestic drift, gentle twinkle
// Fully procedural: star positions are hashes of vertex index, so there
// are no storage buffers and no compute pass (galaxy_compute.wgsl unused).

// must match galaxy.wgsl
const M         = 12;
const DEPTH     = 24;
const N_FIELD   = 150_000;
const N_CLUSTER = 108_000;
const N_GAS     = 720;

export class GalaxyPreset {
  constructor() {
    this.frameCount = 0;
    this._params = null;
    this._dtMs   = 16.67;

    this._camZ   = 0;
    this._energy = 0;       // fast EMA → fly speed
    this._eSlow  = 0;       // slow EMA → quiet detector
    this._warp   = 0;       // drop speed burst
    this._snare  = 0;
    this._breath = 0;       // bass-follow with slow release
    this._flare  = new Float32Array(M);
    this._nova   = { x: 0, y: 0, z: -99, age: 99, strength: 0 };

    this._prevKick  = 0;
    this._prevSnare = 0;
    this._prevDrop  = 0;
    this._kickCd    = 0;

    this._clusters = [];
    for (let i = 0; i < M; i++) {
      const c = { x: 0, y: 0, z: 0 };
      this._respawnCluster(c, 1.5 + i * 2.4 + Math.random() * 1.4);
      this._clusters.push(c);
    }

    this._extra = new Float32Array(64);   // 16 × vec4f
  }

  _respawnCluster(c, ahead) {
    c.z = this._camZ + ahead;
    const ang = Math.random() * Math.PI * 2;
    // bias toward the flight axis so some clusters pass close by (flybys)
    const rad = 0.45 + Math.pow(Math.random(), 1.35) * 3.2;
    c.x = Math.cos(ang) * rad * 1.3;
    c.y = Math.sin(ang) * rad * 0.72;
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;

    const module = device.createShaderModule({ label: 'galaxy-render', code: renderSource });

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
    this.bindGroup = device.createBindGroup({
      layout: bgl,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });

    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const additive = {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    };
    const pipeline = (vs, fs) => device.createRenderPipeline({
      layout,
      vertex:   { module, entryPoint: vs },
      fragment: { module, entryPoint: fs, targets: [{ format: ACCUM_FORMAT, blend: additive }] },
      primitive: { topology: 'triangle-list' },
    });
    this.bgPipeline   = pipeline('vs_bg',   'fs_bg');
    this.gasPipeline  = pipeline('vs_gas',  'fs_gas');
    this.starPipeline = pipeline('vs_star', 'fs_star');

    this.post = new PostFX();
    this.post.init(device, format, canvas);
  }

  // ── music → space ───────────────────────────────────────────────────────
  _updateMusic(bands, dt, params, timeS) {
    const bass = bands.bass ?? 0;
    const e = (bass + (bands.mid ?? 0) + (bands.high ?? 0)) / 3;
    this._energy += (e - this._energy) * (1 - Math.exp(-dt / 0.8));
    this._eSlow  += (e - this._eSlow)  * (1 - Math.exp(-dt / 2.5));

    // bass → nebula breath: fast attack, slow release
    const tau = bass > this._breath ? 0.05 : 0.35;
    this._breath += (bass - this._breath) * (1 - Math.exp(-dt / tau));

    // drop → supernova on a cluster ahead + warp burst
    const drop = params.dropPulse ?? 0;
    if (drop > 0.5 && this._prevDrop <= 0.5 && this._nova.age > 4) {
      let best = null, bestScore = Infinity;
      for (let i = 0; i < M; i++) {
        const c = this._clusters[i];
        const zA = c.z - this._camZ;
        if (zA < 4 || zA > 16) continue;
        const score = Math.hypot(c.x - this._camX, c.y - this._camY) / zA;
        if (score < bestScore) { bestScore = score; best = i; }
      }
      if (best === null) best = 0;
      const c = this._clusters[best];
      this._nova = { x: c.x, y: c.y, z: c.z, age: 0, strength: 1 };
      this._flare[best] = Math.max(this._flare[best], 2.5);
      this._warp = 1;
    }
    this._prevDrop = drop;
    this._nova.age += dt;
    this._warp *= Math.exp(-dt * 1.15);

    // kick rising edge → flare the most screen-prominent cluster
    this._kickCd = Math.max(0, this._kickCd - dt);
    const kick = bands.kick ?? 0;
    if (kick > 0.45 && this._prevKick < 0.35 && this._kickCd <= 0) {
      let best = 0, bestW = -1;
      for (let i = 0; i < M; i++) {
        const zA = this._clusters[i].z - this._camZ;
        if (zA < 1.5 || zA > 16) continue;
        const w = (1 / zA) * (0.6 + Math.random() * 0.8);
        if (w > bestW) { bestW = w; best = i; }
      }
      this._flare[best] = Math.max(this._flare[best], 0.8 + kick * 0.7);
      this._kickCd = 0.30;
    }
    this._prevKick = kick;
    for (let i = 0; i < M; i++) this._flare[i] *= Math.exp(-dt * 3.2);

    // snare rising edge → sparkle wave
    const snare = bands.snare ?? 0;
    if (snare > 0.35 && this._prevSnare < 0.3) {
      this._snare = Math.max(this._snare, snare * 0.9);
    }
    this._prevSnare = snare;
    this._snare *= Math.exp(-dt * 6);

    // flight: base drift + energy + warp; camera sways gently
    const speed = 0.55 + this._energy * 1.8 + this._warp * 6.5;
    this._camZ += dt * speed;
    this._speed = speed;
    const s = (params.sceneSeed ?? 0) * 6.28318;
    this._camX = 0.45 * Math.sin(timeS * 0.10 + s) + 0.28 * Math.sin(timeS * 0.053 + s * 2.3)
               + (params.driftX ?? 0) * 0.5;
    this._camY = 0.28 * Math.sin(timeS * 0.071 + s * 1.7) + 0.16 * Math.sin(timeS * 0.043 + s * 3.1)
               + (params.driftY ?? 0) * 0.35;
    this._roll = 0.12 * Math.sin(timeS * 0.037 + s * 0.9) + (params.driftRot ?? 0) * 0.2;

    // recycle clusters that fell behind the camera
    for (const c of this._clusters) {
      if (c.z - this._camZ < 0.35) this._respawnCluster(c, 26 + Math.random() * 8);
    }
  }

  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._params = params;
    this._dtMs   = deltaMs;
    const dt = Math.min(deltaMs * 0.001, 0.05);

    this._updateMusic(bands, dt, params, timeMs * 0.001);

    const { gain } = PostFX.trailFactors(params, deltaMs);
    const u = buildUniforms(bands, timeMs, deltaMs, params, this.canvas, this.frameCount, gain);
    device.queue.writeBuffer(this.uniformBuffer, 0, u);

    const quiet = Math.max(0, Math.min(1, 1 - this._eSlow * 2.5));
    const e = this._extra;
    e[0] = this._camZ;  e[1] = this._camX;      e[2]  = this._camY;      e[3]  = this._roll;
    e[4] = this._speed; e[5] = this._warp;      e[6]  = this._snare;     e[7]  = this._breath;
    e[8] = this._nova.x; e[9] = this._nova.y;   e[10] = this._nova.z;    e[11] = this._nova.age;
    e[12] = this._nova.strength; e[13] = quiet; e[14] = this._energy;    e[15] = 0;
    for (let i = 0; i < M; i++) {
      const c = this._clusters[i];
      e[16 + i * 4]     = c.x;
      e[16 + i * 4 + 1] = c.y;
      e[16 + i * 4 + 2] = c.z;
      e[16 + i * 4 + 3] = this._flare[i];
    }
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
    pass.setPipeline(this.gasPipeline);
    pass.draw(N_GAS * 6);
    pass.setPipeline(this.starPipeline);
    pass.draw((N_FIELD + N_CLUSTER) * 6);
    pass.end();

    this.post.finish(enc, view, this._params);
    device.queue.submit([enc.finish()]);
  }

  destroy() {
    this.post?.destroy();
  }
}
