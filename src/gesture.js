// Gesture control (CAM button) — webcam hand tracking via MediaPipe
// HandLandmarker, Motion-Lab style. One hand steers the composition:
// palm position pans the drift centre, thumb-index pinch zooms in,
// a fast swipe fires a zoom punch. This module only exposes smoothed
// values; main.js maps them onto params so every mode reacts.
//
// The WASM runtime ships in the bundle (vite ?url assets); only the
// 7.5 MB landmark model streams from Google's model CDN on first start.

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

export class GestureControl {
  constructor() {
    this.active  = false;
    this.present = 0;      // 0..1 smoothed hand presence
    this.x = 0.5;          // palm centre, mirrored (move right = right), 0..1
    this.y = 0.5;          // 0 = top
    this.pinch = 0;        // 0..1 thumb-index pinch
    this.vel = 0;          // palm speed, screen-units/s, smoothed
    this._raw = { x: 0.5, y: 0.5 };
    this._pinchRaw = 0;
    this._presentRaw = 0;
    this._lastDetectMs = 0;
  }

  async start() {
    const [{ HandLandmarker }, loader, binary] = await Promise.all([
      import('@mediapipe/tasks-vision'),
      import('@mediapipe/tasks-vision/vision_wasm_internal.js?url'),
      import('@mediapipe/tasks-vision/vision_wasm_internal.wasm?url'),
    ]);
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240, facingMode: 'user' },
      audio: false,
    });
    this.video = document.createElement('video');
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    this.landmarker = await HandLandmarker.createFromOptions(
      { wasmLoaderPath: loader.default, wasmBinaryPath: binary.default },
      {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 1,
      },
    );
    this.active = true;
  }

  // Call once per frame; detection itself is throttled to ~30 Hz
  update(dt) {
    if (!this.active || this.video.readyState < 2) return;
    const now = performance.now();
    if (now - this._lastDetectMs >= 33) {
      const step = (now - this._lastDetectMs) * 0.001;
      this._lastDetectMs = now;
      let lm = null;
      try { lm = this.landmarker.detectForVideo(this.video, now).landmarks?.[0]; }
      catch (_) { /* a dropped frame must not kill the render loop */ }
      if (lm) {
        const palm = lm[9];                       // middle-finger base ≈ palm centre
        const nx = 1 - palm.x, ny = palm.y;       // mirror x → moving right pans right
        const inst = Math.hypot(nx - this._raw.x, ny - this._raw.y) / Math.max(step, 0.01);
        this.vel += (inst - this.vel) * 0.35;
        this._raw = { x: nx, y: ny };
        // pinch distance normalized by palm size so it works at any range
        const d   = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y);
        const ref = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y) + 1e-5;
        this._pinchRaw = clamp(1 - (d / ref - 0.25) / 0.85, 0, 1);
        this._presentRaw = 1;
      } else {
        this._presentRaw = 0;
        this.vel *= 0.8;
      }
    }
    const k = 1 - Math.exp(-dt * 9);
    this.x     += (this._raw.x - this.x) * k;
    this.y     += (this._raw.y - this.y) * k;
    this.pinch += (this._pinchRaw - this.pinch) * k;
    this.present += (this._presentRaw - this.present) * (1 - Math.exp(-dt * 4));
  }

  stop() {
    this.active = false;
    this.landmarker?.close();
    this.landmarker = null;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.video = null;
    this.present = 0; this.pinch = 0; this.vel = 0;
  }
}
