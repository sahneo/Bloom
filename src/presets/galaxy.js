import computeSource from '../shaders/galaxy_compute.wgsl?raw';
import renderSource  from '../shaders/galaxy.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from './../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

// GALAXY — a spiral galaxy as the music's body: track energy spins the
// disk, kick flares the core, a drop detonates a supernova whose
// shockwave rolls through the arms and heals over ~8 s.

const N = 400_000;

export class GalaxyPreset {
  constructor() {
    this.frameCount = 0;
    this._params = null;
    this._energy = 0;
    this._prevDrop = 0;
    this._nova = { x: 0, z: 0, age: 99, strength: 0 };
    this._extra = new Float32Array(4);
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;

    const computeModule = device.createShaderModule({ label: 'galaxy-compute', code: computeSource });
    const renderModule  = device.createShaderModule({ label: 'galaxy-render',  code: renderSource  });

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Star seeding: exponential disk + 2 log-spiral arms + bulge + halo
    this.starBuffer = device.createBuffer({
      size: N * 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const data = new Float32Array(N * 8);
    const TWO_PI = Math.PI * 2;
    const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 0.8;
    for (let i = 0; i < N; i++) {
      const roll = Math.random();
      let r, th, z, pop;
      if (roll < 0.15) {                    // bulge
        pop = 1;
        r  = Math.abs(gauss()) * 0.16 + 0.01;
        th = Math.random() * TWO_PI;
        z  = gauss() * 0.07;
      } else if (roll < 0.18) {             // halo
        pop = 2;
        r  = 0.4 + Math.random() * 1.1;
        th = Math.random() * TWO_PI;
        z  = gauss() * 0.35;
      } else {                              // arms
        pop = 0;
        r  = 0.18 + (-Math.log(Math.max(Math.random(), 1e-4))) * 0.34;
        if (r > 1.5) r = 0.18 + Math.random() * 1.1;   // resample — a hard clamp drew a rim ring
        const arm = (Math.random() < 0.5) ? 0 : Math.PI;
        // log spiral: θ grows with ln r; gaussian spread widens outward
        th = arm + Math.log(r / 0.14) * 2.4 + gauss() * (0.22 + r * 0.26);
        z  = gauss() * 0.030 * (0.4 + r);
      }
      const o = i * 8;
      data[o]     = r;
      data[o + 1] = th;
      data[o + 2] = z;
      data[o + 3] = Math.random();          // seed → size/brightness variety
      data[o + 4] = r;                      // home radius
      data[o + 5] = pop;
      data[o + 6] = th;                     // arm phase for snare shimmer
      data[o + 7] = 0;
    }
    device.queue.writeBuffer(this.starBuffer, 0, data);

    const computeBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const renderBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    const bg = (layout) => device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.starBuffer } },
      ],
    });
    this.computeBindGroup = bg(computeBGL);
    this.renderBindGroup  = bg(renderBGL);

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

  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._params = params;
    this._dtMs = deltaMs;
    const dt = Math.min(deltaMs * 0.001, 0.04);

    // energy EMA → rotation speed
    const e = ((bands.bass ?? 0) + (bands.mid ?? 0) + (bands.high ?? 0)) / 3;
    this._energy += (e - this._energy) * (1 - Math.exp(-dt / 1.0));

    // drop → supernova somewhere in the mid-disk
    const drop = params.dropPulse ?? 0;
    if (drop > 0.5 && this._prevDrop <= 0.5 && this._nova.age > 4) {
      const a = Math.random() * Math.PI * 2;
      const r = 0.35 + Math.random() * 0.55;
      this._nova = { x: Math.cos(a) * r, z: Math.sin(a) * r, age: 0, strength: 1 };
    }
    this._prevDrop = drop;
    this._nova.age += dt;

    const { gain } = PostFX.trailFactors(params, deltaMs);
    const u = buildUniforms(bands, timeMs, deltaMs, params, this.canvas, this.frameCount, gain);
    u[41] = this._energy;   // _r1: rotation speed
    device.queue.writeBuffer(this.uniformBuffer, 0, u);
    this._extra[0] = this._nova.x;
    this._extra[1] = this._nova.z;
    this._extra[2] = this._nova.age;
    this._extra[3] = this._nova.strength;
    device.queue.writeBuffer(this.uniformBuffer, RIPPLE_OFFSET, this._extra);

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.computePipeline);
    pass.setBindGroup(0, this.computeBindGroup);
    pass.dispatchWorkgroups(Math.ceil(N / 64));
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  draw(device, view) {
    this.post.ensureTargets();
    const { fade } = PostFX.trailFactors(this._params, this._dtMs ?? 16.7);

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
    this.starBuffer?.destroy();
    this.post?.destroy();
  }
}
