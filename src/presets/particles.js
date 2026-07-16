import computeSource from '../shaders/particles_compute.wgsl?raw';
import renderSource  from '../shaders/particles_render.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

const N = 25_000; // particle count — tune for performance

export class ParticlesPreset {
  constructor() {
    this.device          = null;
    this.canvas          = null;
    this.computePipeline = null;
    this.renderPipeline  = null;
    this.uniformBuffer   = null;
    this.particleBuffer  = null;
    this.computeBindGroup = null;
    this.renderBindGroup  = null;
    this.frameCount      = 0;
    this._params  = null;
    this._dtMs    = 16.67;
    // Merged ripple + hand-gesture uniform region (written at RIPPLE_OFFSET).
    // Hand data rides in the .w lanes ripples never use — see the packing
    // comment in particles_compute.wgsl. Ripple ages default to -1 (inactive).
    this._extra = new Float32Array(64);
    for (let i = 0; i < 8; i++) this._extra[i * 4 + 2] = -1;
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;

    const computeModule = device.createShaderModule({ label: 'particles-compute', code: computeSource });
    const renderModule  = device.createShaderModule({ label: 'particles-render',  code: renderSource  });

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Particle storage: N × 32 bytes (pos, vel, life, max_life, size, _pad)
    this.particleBuffer = device.createBuffer({
      size: N * 32,
      usage: GPUBufferUsage.STORAGE,
    });

    // Separate BGL for compute (read_write) and render (read-only)
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
        { binding: 1, resource: { buffer: this.particleBuffer } },
      ],
    });

    this.computeBindGroup = makeBindGroup(computeBGL);
    this.renderBindGroup  = makeBindGroup(renderBGL);

    this.computePipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [computeBGL] }),
      compute: { module: computeModule, entryPoint: 'cs_main' },
    });

    // Particles render into the shared HDR accumulation buffer, not the canvas
    this.renderPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [renderBGL] }),
      vertex:   { module: renderModule, entryPoint: 'vs_main' },
      fragment: {
        module: renderModule,
        entryPoint: 'fs_main',
        targets: [{
          format: ACCUM_FORMAT,
          blend: {
            // Additive — particles accumulate light
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

  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._params = params;
    this._dtMs   = deltaMs;

    const { gain } = PostFX.trailFactors(params, deltaMs);
    const u = buildUniforms(bands, timeMs, deltaMs, params, this.canvas, this.frameCount, gain);
    device.queue.writeBuffer(this.uniformBuffer, 0, u);
    // Ripple data + hand-gesture data share the extra uniform region: ripples
    // own the .xyz lanes, hands the .w lanes (see particles_compute.wgsl).
    const hands = (params.gestMode === 2 && params.hands) ? params.hands : null;
    if (params.rippleData || hands) {
      if (params.rippleData) this._extra.set(params.rippleData);
      const X = this._extra;
      for (let s = 0; s < 2; s++) {
        const h    = hands?.h?.[s];
        const on   = h && (h.present ?? 0) > 0;
        const base = s === 0 ? 0 : 32;         // hand0 → pos_age .w, hand1 → color .w
        X[base + 3]  = on ? h.x : 0;
        X[base + 7]  = on ? h.y : 0;
        X[base + 11] = on ? h.grip : 0;
        X[base + 15] = on ? h.pinch : 0;
        X[base + 19] = on ? h.present : 0;
      }
      device.queue.writeBuffer(this.uniformBuffer, RIPPLE_OFFSET, this._extra);
    }

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

    // Particles rendered additively on top of the faded history
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
