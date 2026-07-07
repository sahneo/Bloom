import fluidSource from '../shaders/fluid.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

const SIM    = 384;   // square sim grid — resolution-independent cost
const JACOBI = 20;    // pressure solve iterations

// INK — real fluid simulation. Two variants share the sim core:
//   'metal' — slow mercury under moonlight (near-B&W, anamorphic)
//   'ferro' — the original ferrofluid: hard white blobs, punchy forces
export class FluidPreset {
  constructor(variant = 'metal') {
    this.variant = variant;
    this.frameCount = 0;
    this._params = null;
    this._dtMs   = 16.67;
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;

    const module = device.createShaderModule({ label: 'fluid', code: fluidSource });

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.simBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    const mk = () => device.createTexture({ size: [SIM, SIM], format: 'rgba16float', usage });
    this.vel   = [mk(), mk()];
    this.dye   = [mk(), mk()];
    this.press = [mk(), mk()];
    this.div   = mk();
    this.curl  = mk();
    this.velV   = this.vel.map(t => t.createView());
    this.dyeV   = this.dye.map(t => t.createView());
    this.pressV = this.press.map(t => t.createView());
    this.divV   = this.div.createView();
    this.curlV  = this.curl.createView();

    this._sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    const pipeline = (entryPoint, format_) => device.createRenderPipeline({
      layout: 'auto',
      vertex:   { module, entryPoint: 'vs_fullscreen' },
      fragment: { module, entryPoint, targets: [{ format: format_ }] },
      primitive: { topology: 'triangle-list' },
    });
    this.pAdvectVel = pipeline('fs_advect_vel', 'rgba16float');
    this.pCurl      = pipeline('fs_curl',       'rgba16float');
    this.pForces    = pipeline('fs_forces',     'rgba16float');
    this.pDiv       = pipeline('fs_divergence', 'rgba16float');
    this.pJacobi    = pipeline('fs_jacobi',     'rgba16float');
    this.pGradient  = pipeline('fs_gradient',   'rgba16float');
    this.pAdvectDye = pipeline('fs_advect_dye', 'rgba16float');
    // Dye → accum is additive so trails/echo keep working underneath
    this.pRender = device.createRenderPipeline({
      layout: 'auto',
      vertex:   { module, entryPoint: 'vs_fullscreen' },
      fragment: {
        module,
        entryPoint: this.variant === 'ferro' ? 'fs_render_ferro' : 'fs_render',
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

    // Bind group factory: (pipeline, texA, texB, texC)
    this._bg = (pipeline, a, b, c) => device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this._sampler },
        { binding: 1, resource: { buffer: this.uniformBuffer } },
        { binding: 2, resource: { buffer: this.simBuffer } },
        { binding: 3, resource: a },
        { binding: 4, resource: b },
        { binding: 5, resource: c },
      ],
    });
    // Pre-built bind groups for both ping-pong parities. Unused aux slots
    // still need a binding (touch_all samples every texture) — dummies must
    // never be the pass's own render target.
    const dummy = this.divV;
    this.bgAdvectVel = this.velV.map(v => this._bg(this.pAdvectVel, v, dummy, dummy));
    this.bgCurl      = this.velV.map(v => this._bg(this.pCurl, v, this.pressV[0], this.pressV[0]));
    // forces reads (vel, curl, density) — density ping-pongs too: [velI*2+dyeI]
    this.bgForces    = [0, 1].flatMap(vi => this.dyeV.map(dv => this._bg(this.pForces, this.velV[vi], this.curlV, dv)));
    this.bgDiv       = this.velV.map(v => this._bg(this.pDiv, v, this.pressV[0], this.pressV[0]));
    this.bgJacobi    = this.pressV.map(p => this._bg(this.pJacobi, p, this.divV, this.curlV));
    this.bgGradient  = [0, 1].flatMap(vi => this.pressV.map(p => this._bg(this.pGradient, this.velV[vi], p, dummy)));
    // dye advect needs (dye, vel): 2×2 combos
    this.bgAdvectDye = [0, 1].flatMap(di => this.velV.map(v => this._bg(this.pAdvectDye, this.dyeV[di], v, dummy)));
    this.bgRender    = this.dyeV.map(d => this._bg(this.pRender, d, dummy, dummy));

    this._velI = 0;
    this._dyeI = 0;
    this._pressI = 0;

    this.post = new PostFX();
    this.post.init(device, format, canvas);
  }

  _pass(enc, pipeline, bindGroup, targetView) {
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: targetView, loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._params = params;
    this._dtMs   = deltaMs;

    // Dye is a continuous medium — advection already IS the trail, so the
    // accum history is cleared each frame (gain 1, no compensation needed)
    const u = buildUniforms(bands, timeMs, deltaMs, params, this.canvas, this.frameCount, 1);
    u[41] = this.variant === 'ferro' ? 2.4 : 1.0;   // _r1: force-speed multiplier
    device.queue.writeBuffer(this.uniformBuffer, 0, u);
    if (params.rippleData) {
      device.queue.writeBuffer(this.uniformBuffer, RIPPLE_OFFSET, params.rippleData);
    }
    device.queue.writeBuffer(this.simBuffer, 0, new Float32Array([
      Math.min(deltaMs / 1000, 0.033),
      this.variant === 'ferro' ? 0.999 : 0.994,   // ferro punchy, mercury lazy
      this.variant === 'ferro' ? 0.988 : 0.992,   // density dissipation
      this.canvas.width / this.canvas.height,
    ]));

    const enc = device.createCommandEncoder();
    // 1. advect velocity: vel[i] → vel[1-i]
    this._pass(enc, this.pAdvectVel, this.bgAdvectVel[this._velI], this.velV[1 - this._velI]);
    this._velI = 1 - this._velI;
    // 2. curl of vel[i] → curl tex (for vorticity confinement)
    this._pass(enc, this.pCurl, this.bgCurl[this._velI], this.curlV);
    // 3. forces + vorticity + buoyancy/cohesion from density: vel[i] → vel[1-i]
    this._pass(enc, this.pForces, this.bgForces[this._velI * 2 + this._dyeI], this.velV[1 - this._velI]);
    this._velI = 1 - this._velI;
    // 3. divergence of vel[i] → div
    this._pass(enc, this.pDiv, this.bgDiv[this._velI], this.divV);
    // 4. Jacobi: press ping-pong (warm-started from last frame)
    for (let k = 0; k < JACOBI; k++) {
      this._pass(enc, this.pJacobi, this.bgJacobi[this._pressI], this.pressV[1 - this._pressI]);
      this._pressI = 1 - this._pressI;
    }
    // 5. subtract pressure gradient: (vel[i], press[j]) → vel[1-i]
    this._pass(enc, this.pGradient, this.bgGradient[this._velI * 2 + this._pressI], this.velV[1 - this._velI]);
    this._velI = 1 - this._velI;
    // 6. advect + inject dye: (dye[d], vel[i]) → dye[1-d]
    this._pass(enc, this.pAdvectDye, this.bgAdvectDye[this._dyeI * 2 + this._velI], this.dyeV[1 - this._dyeI]);
    this._dyeI = 1 - this._dyeI;

    device.queue.submit([enc.finish()]);
  }

  draw(device, view) {
    this.post.ensureTargets();

    const enc = device.createCommandEncoder();
    this.post.fadePass(enc, 0, this._params);   // clear history — dye self-trails

    // Dye rendered additively into the accum buffer
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.post.accumView, loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(this.pRender);
    pass.setBindGroup(0, this.bgRender[this._dyeI]);
    pass.draw(3);
    pass.end();

    this.post.finish(enc, view, this._params);
    device.queue.submit([enc.finish()]);
  }

  destroy() {
    for (const t of [...this.vel, ...this.dye, ...this.press, this.div, this.curl]) t?.destroy();
    this.post?.destroy();
  }
}

// Legacy ferrofluid mode as its own preset entry
export class FerroPreset extends FluidPreset {
  constructor() { super('ferro'); }
}
