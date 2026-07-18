import computeSource from '../shaders/physarum_compute.wgsl?raw';
import renderSource  from '../shaders/physarum.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

// PHYSARUM — slime-mold organism. 400k agents deposit pheromone trails,
// sense and follow each other, and the diffusing trail map becomes a
// living vein network. Two species (key-hue vs complement) compete.
// Music: bass = crawl speed, mid = sensor reach breathes, high = turn
// agility, snare = panic jitter, kick = whole-organism brightness pulse,
// drop = radial blast + fast decay (the network shatters and regrows).
// HANDS mode: an open palm feeds its species (the net crawls to your
// hand), a fist scatters everything near it, pinch seeds fresh agents.
// Tap anywhere = drop food, veins converge on the meal.

const N = 400_000;

export class PhysarumPreset {
  constructor() {
    this.frameCount = 0;
    this._params = null;
    this._extra = new Float32Array(24);
    this._kickEnv = 0; this._snareEnv = 0; this._dropEnv = 0; this._tapEnv = 0;
    this._prevKick = 0; this._prevSnare = 0; this._prevDrop = 0;
    this._prevTapN = null;
    this._tapX = 0.5; this._tapY = 0.5;
    this._cur = 0;                 // ping-pong index of the current trail
    this._gw = 0; this._gh = 0;
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;
    this._computeModule = device.createShaderModule({ label: 'physarum-compute', code: computeSource });
    this._renderModule  = device.createShaderModule({ label: 'physarum-render',  code: renderSource  });

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // agents: (x, y, angle, species+seed), positions normalized 0..1
    this.agentBuffer = device.createBuffer({
      size: N * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const seed = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) {
      seed[i * 4]     = Math.random();
      seed[i * 4 + 1] = Math.random();
      seed[i * 4 + 2] = Math.random() * Math.PI * 2;
      seed[i * 4 + 3] = (i % 2) + Math.random() * 0.98;
    }
    device.queue.writeBuffer(this.agentBuffer, 0, seed);

    this._agentBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    this._diffuseBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    this._renderBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });

    this.agentPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._agentBGL] }),
      compute: { module: this._computeModule, entryPoint: 'cs_agents' },
    });
    this.diffusePipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._diffuseBGL] }),
      compute: { module: this._computeModule, entryPoint: 'cs_diffuse' },
    });
    this.renderPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._renderBGL] }),
      vertex:   { module: this._renderModule, entryPoint: 'vs_fullscreen' },
      fragment: { module: this._renderModule, entryPoint: 'fs_render', targets: [{ format: ACCUM_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });

    this._ensureGrid();
    this.post = new PostFX();
    this.post.init(device, format, canvas);
  }

  // trail grid at half canvas resolution (capped) — rebuilt on resize
  _ensureGrid() {
    const gw = Math.min(Math.max(Math.round(this.canvas.width  / 2), 256), 1440);
    const gh = Math.min(Math.max(Math.round(this.canvas.height / 2), 160), 900);
    if (gw === this._gw && gh === this._gh) return;
    this._gw = gw; this._gh = gh;
    this.trailBuffers?.forEach(b => b.destroy());
    const size = gw * gh * 2 * 4;
    this.trailBuffers = [0, 1].map(() => this.device.createBuffer({
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    }));
    // bind groups per ping-pong direction
    this._agentBG = [0, 1].map(i => this.device.createBindGroup({
      layout: this._agentBGL,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.agentBuffer } },
        { binding: 2, resource: { buffer: this.trailBuffers[i] } },
      ],
    }));
    this._diffuseBG = [0, 1].map(i => this.device.createBindGroup({
      layout: this._diffuseBGL,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 2, resource: { buffer: this.trailBuffers[i] } },
        { binding: 3, resource: { buffer: this.trailBuffers[1 - i] } },
      ],
    }));
    this._renderBG = [0, 1].map(i => this.device.createBindGroup({
      layout: this._renderBGL,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.trailBuffers[i] } },
      ],
    }));
    this._cur = 0;
  }

  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._params = params;
    this._ensureGrid();
    const dt = Math.min(deltaMs * 0.001, 0.05);

    const kick = bands.kick ?? 0, snare = bands.snare ?? 0;
    if (kick > 0.45 && this._prevKick <= 0.45) this._kickEnv = Math.min(0.5 + kick * 0.8, 1.3);
    if (snare > 0.5 && this._prevSnare <= 0.5) this._snareEnv = Math.min(0.4 + snare * 0.6, 1);
    this._prevKick = kick; this._prevSnare = snare;
    this._kickEnv  *= Math.exp(-dt * 6);
    this._snareEnv *= Math.exp(-dt * 7);
    const drop = params.dropPulse ?? 0;
    if (drop > 0.5 && this._prevDrop <= 0.5) this._dropEnv = 1;
    this._prevDrop = drop;
    this._dropEnv *= Math.exp(-dt * 1.6);

    // tap = food bomb (shares the canvas-tap wiring with cymatics)
    const tapN = params.cymTapN ?? 0;
    if (this._prevTapN === null) this._prevTapN = tapN;
    if (tapN !== this._prevTapN) {
      this._prevTapN = tapN;
      this._tapX = params.cymTapX ?? 0.5;
      this._tapY = params.cymTapY ?? 0.5;
      this._tapEnv = 1;
    }
    this._tapEnv *= Math.exp(-dt * 0.55);   // a meal lasts a few seconds

    const hands = (params.gestMode === 2 && params.hands) ? params.hands.h : null;
    const energy = ((bands.bass ?? 0) + (bands.mid ?? 0) + (bands.high ?? 0)) / 3;

    const e = this._extra;
    e[0] = this._gw; e[1] = this._gh; e[2] = N; e[3] = this._dropEnv;
    for (let h = 0; h < 2; h++) {
      const s = hands?.[h];
      e[4 + h * 4] = s?.x ?? 0.5;
      e[5 + h * 4] = s?.y ?? 0.5;
      e[6 + h * 4] = s?.grip ?? 0;
      e[7 + h * 4] = s?.present ?? 0;
    }
    e[12] = this._tapX; e[13] = this._tapY; e[14] = this._tapEnv; e[15] = this._kickEnv;
    e[16] = this._snareEnv;
    e[17] = params.tension ?? 0;
    e[18] = 0.8 + energy * 0.9;                                   // speed mult
    e[19] = 1 + (bands.mid ?? 0) * (params.mulMid ?? 1) * 0.9;    // sense reach
    e[20] = 1 + energy * 0.8;                                     // deposit
    e[21] = 0.94 - this._dropEnv * 0.05 - (params.tension ?? 0) * 0.006; // decay
    e[22] = hands?.[0]?.pinch ?? 0;
    e[23] = hands?.[1]?.pinch ?? 0;

    const u = buildUniforms(bands, timeMs, deltaMs, params, this.canvas, this.frameCount, 1);
    device.queue.writeBuffer(this.uniformBuffer, 0, u);
    device.queue.writeBuffer(this.uniformBuffer, RIPPLE_OFFSET, e);
  }

  draw(device, view) {
    this.post.ensureTargets();
    const enc = device.createCommandEncoder();

    const cp = enc.beginComputePass();
    cp.setPipeline(this.agentPipeline);
    cp.setBindGroup(0, this._agentBG[this._cur]);
    cp.dispatchWorkgroups(Math.ceil(N / 256));
    cp.setPipeline(this.diffusePipeline);
    cp.setBindGroup(0, this._diffuseBG[this._cur]);
    cp.dispatchWorkgroups(Math.ceil(this._gw / 16), Math.ceil(this._gh / 16));
    cp.end();
    this._cur = 1 - this._cur;

    this.post.fadePass(enc, 0, this._params);
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.post.accumView, loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(this.renderPipeline);
    pass.setBindGroup(0, this._renderBG[this._cur]);
    pass.draw(3);
    pass.end();
    this.post.finish(enc, view, this._params);
    device.queue.submit([enc.finish()]);
  }

  destroy() {
    this.agentBuffer?.destroy();
    this.trailBuffers?.forEach(b => b.destroy());
    this.post?.destroy();
  }
}
