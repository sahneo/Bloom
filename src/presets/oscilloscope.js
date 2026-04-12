import shaderSource from '../shaders/oscilloscope.wgsl?raw';

const N_SAMPLES = 2048;   // must match shader constant
const N_FRAMES  = 8;      // trail length (phosphor persistence)

export class OscilloscopePreset {
  constructor() {
    this.device         = null;
    this.canvas         = null;
    this.pipeline       = null;
    this.uniformBuffer  = null;
    this.waveformBuffer = null;
    this.bindGroup      = null;

    // Ring buffer of recent waveform frames (index 0 = most recent)
    this._frames     = [];
    this._emptyFrame = new Float32Array(N_SAMPLES * 2); // zeros
    // Auto-gain: tracks peak amplitude, slow decay so quiet passages fill the screen
    this._scopePeak  = 0.01;
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;

    // Uniform buffer: 4 × f32 = 16 bytes
    this.uniformBuffer = device.createBuffer({
      size:  16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Waveform buffer: N_FRAMES × N_SAMPLES × 2 channels × 4 bytes
    this.waveformBuffer = device.createBuffer({
      size:  N_FRAMES * N_SAMPLES * 2 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    const module = device.createShaderModule({ label: 'oscilloscope', code: shaderSource });

    const bgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX,                           buffer: { type: 'read-only-storage' } },
      ],
    });

    this.bindGroup = device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.waveformBuffer } },
      ],
    });

    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex:   { module, entryPoint: 'vs_main' },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [{
          format,
          blend: {
            // Additive — phosphor glow accumulates
            color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'one',       dstFactor: 'one', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  // Call each frame with stereo PCM Float32Arrays (length = N_SAMPLES each).
  pushFrame(leftData, rightData) {
    const n = Math.min(leftData.length, rightData.length, N_SAMPLES);

    // Auto-gain: find peak this frame, then slow-decay the tracker.
    // Fast attack (instantly clamps loud signals), slow release (~10s to fully open).
    let peak = 0.001;
    for (let i = 0; i < n; i++) {
      peak = Math.max(peak, Math.abs(leftData[i]), Math.abs(rightData[i]));
    }
    this._scopePeak = Math.max(this._scopePeak * 0.998, peak);
    const gain = Math.min(0.88 / this._scopePeak, 12.0);  // target 88% of NDC range

    const frame = new Float32Array(N_SAMPLES * 2);
    for (let i = 0; i < n; i++) {
      frame[i * 2]     = leftData[i]  * gain;
      frame[i * 2 + 1] = rightData[i] * gain;
    }

    // Prepend new frame; keep only N_FRAMES
    this._frames.unshift(frame);
    if (this._frames.length > N_FRAMES) this._frames.pop();

    // Upload all frames to GPU (frame 0 = newest, at byte offset 0)
    for (let f = 0; f < N_FRAMES; f++) {
      const data   = this._frames[f] ?? this._emptyFrame;
      const offset = f * N_SAMPLES * 2 * 4;
      this.device.queue.writeBuffer(this.waveformBuffer, offset, data);
    }
  }

  tick(device, bands, timeMs, deltaMs, params) {
    // Waveform data is pushed via pushFrame() from the main loop.
    // Here we just update the uniform buffer.
    const u = new Float32Array([
      this.canvas.width,
      this.canvas.height,
      params.tonality ?? 0,
      0,                      // padding
    ]);
    device.queue.writeBuffer(this.uniformBuffer, 0, u);
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
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw((N_SAMPLES - 1) * N_FRAMES * 6);
    pass.end();
    device.queue.submit([enc.finish()]);
  }
}
