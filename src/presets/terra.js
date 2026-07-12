import shaderSource from '../shaders/terra.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

// TERRA — the music literally builds the landscape.
//
// Every ROW_MS we append one "history row" (band levels averaged since the
// last row, kick/snare peaks) into a 256-row ring stored in a GPU storage
// buffer. The shader maps world z onto row index and raymarches the
// resulting heightfield; the camera advances exactly one row-spacing per
// ROW_MS, so terrain is glued to the history: new ground rises at the
// horizon shaped by what plays NOW and scrolls under the viewer.
// A drop spawns a volcanic eruption ahead of the flight path.

const ROWS      = 256;   // ring capacity (~23 s of history at 90 ms/row)
const ROW_BYTES = 32;    // 2 × vec4f
const ROW_MS    = 90;    // history resolution / scroll rate

export class TerraPreset {
  constructor() {
    this.frameCount = 0;
    this._params = null;

    // history ring state
    this._head = 0;          // rows written so far
    this._rowTimer = 0;      // ms since last row append
    this._acc = { sb: 0, bass: 0, mid: 0, high: 0, n: 0, kick: 0, snare: 0 };
    this._rowData = new Float32Array(8);

    // eruption state (drop → volcano)
    this._eruptAge = 99;
    this._eruptRow = -1e4;
    this._eruptX = 0;
    this._prevDrop = 0;

    this._quietEma = 0.4;    // smoothed energy → stars when quiet
    this._extra = new Float32Array(4);
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;

    const module = device.createShaderModule({ label: 'terra', code: shaderSource });

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.histBuffer = device.createBuffer({
      size: ROWS * ROW_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Explicit layout: the vertex stage doesn't touch the history buffer,
    // so layout:'auto' would drop binding 1 — declare it ourselves.
    const bgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' } },
      ],
    });

    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex:   { module, entryPoint: 'vs_fullscreen' },
      fragment: {
        module,
        entryPoint: 'fs_render',
        targets: [{
          format: ACCUM_FORMAT,
          blend: {   // alpha = motion-blur persistence (Trail slider)
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.bindGroup = device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.histBuffer } },
      ],
    });

    this.post = new PostFX();
    this.post.init(device, format, canvas);
  }

  _appendRow(device, params) {
    const a = this._acc;
    const n = Math.max(a.n, 1);
    const r = this._rowData;
    // averaged band levels, scaled by the user's band multipliers so the
    // sliders sculpt the landscape too
    r[0] = (a.sb   / n) * (params.mulSb   ?? 1);
    r[1] = (a.bass / n) * (params.mulBass ?? 1);
    r[2] = (a.mid  / n) * (params.mulMid  ?? 1);
    // bright timbre makes the highs carve harder
    r[3] = (a.high / n) * (params.mulHigh ?? 1) * (0.6 + 0.6 * (params.sharpness ?? 0));
    r[4] = a.kick;                    // peaks, not averages — spikes matter
    r[5] = a.snare;
    r[6] = params.tension  ?? 0;
    r[7] = params.beatConf ?? 0;
    device.queue.writeBuffer(this.histBuffer, (this._head % ROWS) * ROW_BYTES, r);
    this._head++;
    a.sb = a.bass = a.mid = a.high = a.kick = a.snare = 0;
    a.n = 0;
  }

  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._params = params;
    const dt = Math.min(deltaMs * 0.001, 0.05);

    // accumulate this frame into the pending row
    const a = this._acc;
    a.sb   += bands.subBass ?? 0;
    a.bass += bands.bass    ?? 0;
    a.mid  += bands.mid     ?? 0;
    a.high += bands.high    ?? 0;
    a.kick  = Math.max(a.kick,  bands.kick  ?? 0);
    a.snare = Math.max(a.snare, bands.snare ?? 0);
    a.n++;

    this._rowTimer += deltaMs;
    while (this._rowTimer >= ROW_MS) {
      this._rowTimer -= ROW_MS;
      this._appendRow(device, params);
    }
    const rowsFloat = this._head + this._rowTimer / ROW_MS;

    // quietness → stars/nebula in the sky
    const energy = ((bands.bass ?? 0) + (bands.mid ?? 0) + (bands.high ?? 0)) / 3;
    this._quietEma += (energy - this._quietEma) * (1 - Math.exp(-dt / 1.5));

    // drop rising edge → volcano ahead of the camera
    const drop = params.dropPulse ?? 0;
    if (drop > 0.5 && this._prevDrop <= 0.5 && this._eruptAge > 2.5) {
      this._eruptAge = 0;
      // ~38 rows ahead of the camera (camera sits HORIZON_ROWS=50 behind head)
      // → we fly toward the eruption for ~3.4 s, then over the lava field
      this._eruptRow = rowsFloat - 50 + 38;
      this._eruptX = (Math.random() * 2 - 1) * 3.0;
    }
    this._prevDrop = drop;
    this._eruptAge += dt;
    // fast rise (~0.25 s), lava cools over ~6-8 s
    const env = Math.min(this._eruptAge / 0.25, 1)
              * Math.exp(-Math.max(this._eruptAge - 0.25, 0) * 0.32);

    const alpha = 1 - 0.45 * PostFX.effTrail(params);
    const u = buildUniforms(bands, timeMs, deltaMs, params, this.canvas, this.frameCount, alpha);
    u[41] = rowsFloat;                  // _r1: history head (continuous)
    u[42] = env < 0.002 ? 0 : env;      // _r2: eruption envelope
    u[43] = this._eruptRow;             // _r3: eruption world row
    device.queue.writeBuffer(this.uniformBuffer, 0, u);

    this._extra[0] = this._eruptX;
    this._extra[1] = this._eruptAge;
    this._extra[2] = drop;                                        // camera shake
    this._extra[3] = Math.max(0, 1 - this._quietEma * 3.5);       // quietness
    device.queue.writeBuffer(this.uniformBuffer, RIPPLE_OFFSET, this._extra);
  }

  draw(device, view) {
    this.post.ensureTargets();

    const enc = device.createCommandEncoder();
    this.post.fadePass(enc, 1, this._params);   // alpha handles the decay

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
