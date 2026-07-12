import computeSource from '../shaders/cymatics_compute.wgsl?raw';
import renderSource  from '../shaders/cymatics_render.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

// CYMATICS — Chladni-plate sand. Grains migrate to the nodal lines of a
// vibrating plate; the music selects the resonance pattern (n,m) and the
// figure morphs. Kick = plate strike (scatter → reform), snare = shake.

const N = 400_000;               // grain count

// (n,m) pools by spectral emphasis — low modes for bass-heavy music,
// dense high modes for bright material. n≠m always (n=m degenerates to P≡0).
const POOL_LOW  = [[1, 2], [1, 3], [2, 3], [2, 4], [1, 4]];
const POOL_MID  = [[3, 4], [2, 5], [3, 5], [4, 5], [2, 6]];
const POOL_HIGH = [[4, 7], [5, 6], [5, 7], [6, 8], [4, 6], [3, 7]];
const POOL_DROP = [[1, 7], [2, 7], [1, 6], [3, 8], [2, 8]];

const XFADE_S      = 1.2;        // pattern crossfade duration
const XFADE_DROP_S = 0.45;       // faster morph on a drop

export class CymaticsPreset {
  constructor() {
    this.frameCount = 0;
    this._params    = null;
    this._dtMs      = 16.67;

    // pattern state: A → B crossfade
    this._patA   = [2, 3];
    this._patB   = [1, 4];
    this._cross  = 1;            // 1 = fully on B
    this._xfadeS = XFADE_S;

    // musical event state
    this._strike     = 0;        // kick/drop scatter envelope
    this._strikeAge  = 9;        // seconds since last strike (drives the
                                 // out-then-back plate oscillation in WGSL)
    this._shake      = 0;        // snare shake envelope
    this._prevKick   = 0;
    this._prevSnare  = 0;
    this._prevDrop   = 0;
    this._kickCd     = 0;        // strike cooldown (s)
    this._prevBarPos = 0;
    this._bars       = 0;
    this._sinceSwitch = 0;       // seconds since last pattern change
    this._emphasis   = 'low';    // smoothed spectral emphasis category
    this._eLow  = 0.5;           // EMA band levels
    this._eMid  = 0.3;
    this._eHigh = 0.2;

    this._extra = new Float32Array(8);   // [0]=(nA,mA,nB,mB) [1]=(strikeAge,...)
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;

    const computeModule = device.createShaderModule({ label: 'cymatics-compute', code: computeSource });
    const renderModule  = device.createShaderModule({ label: 'cymatics-render',  code: renderSource  });

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Grain storage: N × 16 bytes (pos.xy, vel.xy), seeded with random spread
    this.grainBuffer = device.createBuffer({
      size: N * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const seedData = new Float32Array(N * 4);
    const asp = Math.max(canvas.width / canvas.height, 0.5) || 1.6;
    for (let i = 0; i < N; i++) {
      seedData[i * 4]     = (Math.random() * 2 - 1) * asp;
      seedData[i * 4 + 1] = Math.random() * 2 - 1;
      seedData[i * 4 + 2] = 0;
      seedData[i * 4 + 3] = 0;
    }
    device.queue.writeBuffer(this.grainBuffer, 0, seedData);

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
        { binding: 1, resource: { buffer: this.grainBuffer } },
      ],
    });
    this.computeBindGroup = makeBindGroup(computeBGL);
    this.renderBindGroup  = makeBindGroup(renderBGL);

    this.computePipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [computeBGL] }),
      compute: { module: computeModule, entryPoint: 'cs_main' },
    });
    this.renderPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [renderBGL] }),
      vertex:   { module: renderModule, entryPoint: 'vs_main' },
      fragment: {
        module: renderModule,
        entryPoint: 'fs_main',
        targets: [{
          format: ACCUM_FORMAT,
          blend: {   // additive, premultiplied in the shader
            color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.post = new PostFX();
    this.post.init(device, format, canvas);
  }

  // ── pattern selection from the music ────────────────────────────────────
  _pickPattern(pool) {
    let pick;
    do {
      pick = pool[(Math.random() * pool.length) | 0];
    } while (pick[0] === this._patB[0] && pick[1] === this._patB[1]);
    return pick;
  }

  _switchPattern(pool, xfadeS) {
    this._patA = this._patB;         // finish any in-flight morph at B
    this._patB = this._pickPattern(pool);
    this._cross = 0;
    this._xfadeS = xfadeS;
    this._sinceSwitch = 0;
  }

  _updateMusic(bands, dt, params) {
    // smoothed spectral emphasis
    const a = 1 - Math.exp(-dt / 0.8);
    this._eLow  += (((bands.subBass ?? 0) + (bands.bass ?? 0)) - this._eLow)  * a;
    this._eMid  += ((bands.mid  ?? 0) - this._eMid)  * a;
    this._eHigh += ((bands.high ?? 0) - this._eHigh) * a;
    const emphasis =
      this._eHigh > this._eLow * 0.85 && this._eHigh >= this._eMid ? 'high' :
      this._eMid  > this._eLow * 1.05                              ? 'mid'  : 'low';
    const pool = emphasis === 'high' ? POOL_HIGH : emphasis === 'mid' ? POOL_MID : POOL_LOW;

    this._sinceSwitch += dt;
    this._kickCd = Math.max(0, this._kickCd - dt);

    // drop: dramatic new figure + full-field strike
    const drop = params.dropPulse ?? 0;
    if (drop > 0.5 && this._prevDrop <= 0.5) {
      this._switchPattern(POOL_DROP, XFADE_DROP_S);
      this._strike = Math.max(this._strike, 1.5);
      this._strikeAge = 0;
    }
    this._prevDrop = drop;

    // bar boundaries drive musical pattern changes
    const barPos = params.barPos ?? 0;
    const barWrapped = barPos < this._prevBarPos - 1.0;
    this._prevBarPos = barPos;
    if (barWrapped) this._bars++;

    const emphasisChanged = emphasis !== this._emphasis;
    this._emphasis = emphasis;
    if (this._sinceSwitch > 1.2) {
      if (barWrapped && (emphasisChanged || this._bars % 2 === 0)) {
        this._switchPattern(pool, XFADE_S);
      } else if (this._sinceSwitch > 5) {
        this._switchPattern(pool, XFADE_S);   // fallback when no beat grid
      }
    }

    // kick rising edge → plate strike
    const kick = bands.kick ?? 0;
    if (kick > 0.45 && this._prevKick < 0.35 && this._kickCd <= 0) {
      this._strike = Math.max(this._strike, 0.45 + kick * 0.65);
      this._strikeAge = 0;
      this._kickCd = 0.11;
    }
    this._prevKick = kick;

    // snare → shake
    const snare = bands.snare ?? 0;
    if (snare > 0.35 && this._prevSnare < 0.3) {
      this._shake = Math.max(this._shake, snare * 0.85);
    }
    this._prevSnare = snare;

    // envelopes: strike decays ~140 ms (matches the cos(26·age) oscillation
    // in the shader so the return swing still has amplitude), shake ~70 ms
    this._strikeAge += dt;
    this._strike *= Math.exp(-dt * 7);
    this._shake  *= Math.exp(-dt * 14);

    // crossfade ramp
    this._cross = Math.min(1, this._cross + dt / this._xfadeS);
  }

  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._params = params;
    this._dtMs   = deltaMs;

    const dt = Math.min(deltaMs * 0.001, 0.05);
    this._updateMusic(bands, dt, params);

    const { gain } = PostFX.trailFactors(params, deltaMs);
    const u = buildUniforms(bands, timeMs, deltaMs, params, this.canvas, this.frameCount, gain);
    const c = this._cross;
    u[41] = c * c * (3 - 2 * c);       // _r1: smoothstep-eased crossfade
    u[42] = this._strike;              // _r2
    u[43] = this._shake;               // _r3
    device.queue.writeBuffer(this.uniformBuffer, 0, u);
    this._extra[0] = this._patA[0];
    this._extra[1] = this._patA[1];
    this._extra[2] = this._patB[0];
    this._extra[3] = this._patB[1];
    this._extra[4] = this._strikeAge;
    device.queue.writeBuffer(this.uniformBuffer, RIPPLE_OFFSET, this._extra);

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
    pass.setPipeline(this.renderPipeline);
    pass.setBindGroup(0, this.renderBindGroup);
    pass.draw(N * 6);
    pass.end();

    this.post.finish(enc, view, this._params);
    device.queue.submit([enc.finish()]);
  }

  destroy() {
    this.post?.destroy();
  }
}
