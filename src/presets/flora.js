import computeSource from '../shaders/flora_compute.wgsl?raw';
import renderSource  from '../shaders/flora_render.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

const MAX_PETALS = 6000;

// FLORA — the app's namesake: petals bloom at the golden angle on musical
// onsets (beats, kicks, MIDI notes) and wilt away, growing a living flower.
export class FloraPreset {
  constructor() {
    this.frameCount = 0;
    this._params = null;
    this._dtMs   = 16.67;
    this._nextSlot = 0;   // ring cursor over petal slots
    this._bloomN   = 0;   // global phyllotaxis counter
    this._prevBeat = 0;
    this._prevKick = 0;
    this._prevPulse = 0;
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;

    const computeModule = device.createShaderModule({ label: 'flora-compute', code: computeSource });
    const renderModule  = device.createShaderModule({ label: 'flora-render',  code: renderSource  });

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.spawnBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // Zero-initialized → dur 0 → all petals invisible until spawned
    this.petalBuffer = device.createBuffer({
      size: MAX_PETALS * 32,
      usage: GPUBufferUsage.STORAGE,
    });

    const computeBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
    const renderBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });

    this.computeBindGroup = device.createBindGroup({
      layout: computeBGL,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.petalBuffer } },
        { binding: 2, resource: { buffer: this.spawnBuffer } },
      ],
    });
    this.renderBindGroup = device.createBindGroup({
      layout: renderBGL,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.petalBuffer } },
      ],
    });

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
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'one',       dstFactor: 'one', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.post = new PostFX();
    this.post.init(device, format, canvas);
  }

  // Musical onsets → how many petals open this frame
  _spawnCount(bands, params) {
    let count = 0;
    let amp = 0.4;

    const beatIdx = Math.floor(params.beatT ?? 0);
    if ((params.beatConf ?? 0) > 0.4 && beatIdx !== this._prevBeat) {
      count += (params.barPos ?? 1) < 1 ? 7 : 3;   // downbeat blooms harder
      amp = Math.max(amp, 0.5);
    }
    this._prevBeat = beatIdx;

    if (bands.kick > 0.55 && this._prevKick < 0.3) {
      count += 4;
      amp = Math.max(amp, bands.kick);
    }
    this._prevKick = bands.kick;

    const pulse = params.pulse ?? 0;
    if (pulse > this._prevPulse + 0.18) {   // MIDI note attack
      count += 5;
      amp = Math.max(amp, pulse);
    }
    this._prevPulse = pulse;

    // A drop scatters a full corolla at once
    if ((params.dropPulse ?? 0) > 0.95) count += 40;

    return { count: Math.min(count, 48), amp };
  }

  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._params = params;
    this._dtMs   = deltaMs;

    const { gain } = PostFX.trailFactors(params, deltaMs);
    const u = buildUniforms(bands, timeMs, deltaMs, params, this.canvas, this.frameCount, gain);
    device.queue.writeBuffer(this.uniformBuffer, 0, u);
    if (params.rippleData) {
      device.queue.writeBuffer(this.uniformBuffer, RIPPLE_OFFSET, params.rippleData);
    }

    const { count, amp } = this._spawnCount(bands, params);
    if (count === 0) return;

    device.queue.writeBuffer(this.spawnBuffer, 0, new Float32Array([
      this._nextSlot, count, this._bloomN, amp,
    ]));
    this._nextSlot = (this._nextSlot + count) % MAX_PETALS;
    this._bloomN  += count;

    const enc  = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.computePipeline);
    pass.setBindGroup(0, this.computeBindGroup);
    pass.dispatchWorkgroups(Math.ceil(MAX_PETALS / 64));
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  draw(device, view) {
    this.post.ensureTargets();
    const { fade } = PostFX.trailFactors(this._params, this._dtMs);

    const enc = device.createCommandEncoder();
    this.post.fadePass(enc, fade);

    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.post.accumView, loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(this.renderPipeline);
    pass.setBindGroup(0, this.renderBindGroup);
    pass.draw(MAX_PETALS * 6);
    pass.end();

    this.post.finish(enc, view, this._params);
    device.queue.submit([enc.finish()]);
  }

  destroy() {
    this.post?.destroy();
  }
}
