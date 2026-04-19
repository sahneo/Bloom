import computeSource from '../shaders/particles_compute.wgsl?raw';
import renderSource  from '../shaders/particles_render.wgsl?raw';

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
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;

    const computeModule = device.createShaderModule({ label: 'particles-compute', code: computeSource });
    const renderModule  = device.createShaderModule({ label: 'particles-render',  code: renderSource  });

    // Uniform buffer: 28 × f32 base (112 bytes) + 64 × f32 ripple data (256 bytes) = 368 bytes
    this.uniformBuffer = device.createBuffer({
      size: 368,
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

    this.renderPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [renderBGL] }),
      vertex:   { module: renderModule, entryPoint: 'vs_main' },
      fragment: {
        module: renderModule,
        entryPoint: 'fs_main',
        targets: [{
          format,
          blend: {
            // Additive — particles accumulate light
            color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'one',       dstFactor: 'one', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  _writeUniforms(bands, timeMs, deltaMs, params) {
    const u = new Float32Array([
      timeMs * 0.001,
      bands.subBass ?? 0,
      bands.bass    ?? 0,
      bands.mid     ?? 0,
      bands.high    ?? 0,
      Math.min(deltaMs * 0.001, 0.04),
      this.canvas.width,
      this.canvas.height,
      this.frameCount,
      params.mulSb,
      params.mulBass,
      params.mulMid,
      params.mulHigh,
      params.spring,
      bands.kick       ?? 0,
      bands.snare      ?? 0,
      params.modeDrums ?? 0,
      params.modeBass  ?? 0,
      params.modeLead  ?? 0,
      params.modeAtmos ?? 0,
      params.modePads   ?? 0,
      params.colorMode  ?? 0,  // color_mode
      params.tonality   ?? 0,  // tonality: -1 minor → +1 major
      params.pulse      ?? 0,  // pulse: MIDI note-attack flash
      params.dissonance         ?? 0,  // dissonance: 0 consonant → 1 dissonant
      params.dissonanceStrength ?? 1,  // user multiplier for dissonance effect
      0, 0,                            // padding to align to 112 bytes
    ]);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, u);

    // Ripple data at offset 112: 8 × vec4f pos_age + 8 × vec4f color = 256 bytes
    if (params.rippleData) {
      this.device.queue.writeBuffer(this.uniformBuffer, 112, params.rippleData);
    }
  }

  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._writeUniforms(bands, timeMs, deltaMs, params);

    const enc  = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.computePipeline);
    pass.setBindGroup(0, this.computeBindGroup);
    pass.dispatchWorkgroups(Math.ceil(N / 64));
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  draw(device, view) {
    const enc  = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view,
        clearValue: { r: 0.0, g: 0.0, b: 0.02, a: 1.0 },
        loadOp:  'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(this.renderPipeline);
    pass.setBindGroup(0, this.renderBindGroup);
    pass.draw(N * 6);
    pass.end();
    device.queue.submit([enc.finish()]);
  }
}
