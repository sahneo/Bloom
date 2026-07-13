import voidSource from '../shaders/void.wgsl?raw';
import { PostFX, ACCUM_FORMAT } from '../postfx.js';
import { buildUniforms, UNIFORM_SIZE, RIPPLE_OFFSET } from './uniforms.js';

// VOID — raymarched flight through an infinite fractal cathedral.
// Single fullscreen pass; alpha blending over last frame's accum gives
// motion blur, with persistence steered by the Trail slider.
export class VoidPreset {
  constructor() {
    this.frameCount = 0;
    this._params = null;
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;

    const module = device.createShaderModule({ label: 'void', code: voidSource });

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex:   { module, entryPoint: 'vs_fullscreen' },
      fragment: {
        module,
        entryPoint: 'fs_render',
        targets: [{
          format: ACCUM_FORMAT,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });

    this.post = new PostFX();
    this.post.init(device, format, canvas);
  }

  tick(device, bands, timeMs, deltaMs, params) {
    this.frameCount++;
    this._params = params;

    // Persistence: Trail 0 = crisp, Trail 1 = heavy dreamlike smear.
    // Written into the trail_gain slot — the shader emits it as alpha.
    const alpha = 1 - 0.72 * PostFX.effTrail(params);
    const u = buildUniforms(bands, timeMs, deltaMs, params, this.canvas, this.frameCount, alpha);
    u[41] = params.voidPalette ?? 0;   // _r1: palette bank selector
    device.queue.writeBuffer(this.uniformBuffer, 0, u);
    if (params.rippleData) {
      device.queue.writeBuffer(this.uniformBuffer, RIPPLE_OFFSET, params.rippleData);
    }
  }

  draw(device, view) {
    this.post.ensureTargets();

    const enc = device.createCommandEncoder();
    // Copy last frame through the echo warp (fade 1 — alpha does the decay)
    this.post.fadePass(enc, 1, this._params);

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
