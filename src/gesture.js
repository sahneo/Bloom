// Gesture control (CAM button) — webcam hand tracking via MediaPipe
// HandLandmarker, Motion-Lab style. Vocabulary:
//   one hand:  palm pans the composition, thumb-index pinch zooms
//   two hands: spread apart = zoom in/out, tilt the line between them
//              = rotate the whole picture, midpoint pans
//   fist:      clench = time slows (visuals freeze-crawl)…
//   release:   …snap it open = shockwave (fires every mode's drop reaction)
//   swipe:     fast palm move = zoom punch
// This module only exposes smoothed values; main.js maps them onto params.
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
    this.hands   = 0;      // detected hand count (last detection)
    this.x = 0.5;          // palm / two-hand midpoint, mirrored, 0..1
    this.y = 0.5;          // 0 = top
    this.pinch = 0;        // 0..1 thumb-index pinch (best hand)
    this.grip  = 0;        // 0..1 fist clench (best hand)
    this.spread = 0.4;     // two-hand palm distance, cam units
    this.angle  = 0;       // two-hand line tilt, radians (x-sorted, ±π/2)
    this.vel = 0;          // palm speed, screen-units/s, smoothed
    this.releaseFlag = false;  // one-shot: fist snapped open — consumer clears
    this._raw = { x: 0.5, y: 0.5 };
    this._pinchRaw = 0; this._gripRaw = 0; this._presentRaw = 0;
    this._spreadRaw = 0.4; this._angleRaw = 0;
    this._gripHeldMs = 0;
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
        numHands: 2,
      },
    );
    this.active = true;
  }

  // palm centre (mirrored x), pinch and fist measures for one hand
  _measure(lm) {
    const palm = lm[9];
    const ref  = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y) + 1e-5;
    const pinchD = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y);
    // fist: how far the four fingertips sit from the wrist, vs palm size
    let tips = 0;
    for (const i of [8, 12, 16, 20]) tips += Math.hypot(lm[i].x - lm[0].x, lm[i].y - lm[0].y);
    const openness = clamp((tips / 4 / ref - 0.9) / 1.0, 0, 1);
    return {
      x: 1 - palm.x, y: palm.y,
      pinch: clamp(1 - (pinchD / ref - 0.25) / 0.85, 0, 1),
      grip:  1 - openness,
    };
  }

  // Call once per frame; detection itself is throttled to ~30 Hz
  update(dt) {
    if (!this.active || this.video.readyState < 2) return;
    const now = performance.now();
    if (now - this._lastDetectMs >= 33) {
      const stepMs = now - this._lastDetectMs;
      this._lastDetectMs = now;
      let hands = [];
      try { hands = this.landmarker.detectForVideo(this.video, now).landmarks ?? []; }
      catch (_) { /* a dropped frame must not kill the render loop */ }
      this.hands = hands.length;
      if (hands.length) {
        const m = hands.map(lm => this._measure(lm));
        let nx, ny;
        if (m.length >= 2) {
          const [a, b] = m[0].x <= m[1].x ? [m[0], m[1]] : [m[1], m[0]];
          nx = (a.x + b.x) / 2; ny = (a.y + b.y) / 2;
          this._spreadRaw = Math.hypot(b.x - a.x, b.y - a.y);
          this._angleRaw  = Math.atan2(b.y - a.y, b.x - a.x);
        } else {
          nx = m[0].x; ny = m[0].y;
          this._angleRaw = 0;
        }
        const step = Math.max(stepMs * 0.001, 0.01);
        const inst = Math.hypot(nx - this._raw.x, ny - this._raw.y) / step;
        this.vel += (inst - this.vel) * 0.35;
        this._raw = { x: nx, y: ny };
        this._pinchRaw = Math.max(...m.map(h => h.pinch));
        this._gripRaw  = Math.max(...m.map(h => h.grip));
        this._presentRaw = 1;
        // fist held then snapped open → one-shot release event
        if (this._gripRaw > 0.75) this._gripHeldMs += stepMs;
        else if (this._gripRaw < 0.35) {
          if (this._gripHeldMs > 180) this.releaseFlag = true;
          this._gripHeldMs = 0;
        }
      } else {
        this._presentRaw = 0;
        this._gripRaw = 0;
        this._gripHeldMs = 0;
        this.vel *= 0.8;
      }
    }
    const k = 1 - Math.exp(-dt * 9);
    this.x      += (this._raw.x - this.x) * k;
    this.y      += (this._raw.y - this.y) * k;
    this.pinch  += (this._pinchRaw - this.pinch) * k;
    this.grip   += (this._gripRaw - this.grip) * k;
    this.spread += (this._spreadRaw - this.spread) * k;
    this.angle  += (this._angleRaw - this.angle) * k;
    this.present += (this._presentRaw - this.present) * (1 - Math.exp(-dt * 4));
  }

  stop() {
    this.active = false;
    this.landmarker?.close();
    this.landmarker = null;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.video = null;
    this.present = 0; this.pinch = 0; this.grip = 0; this.vel = 0;
    this.releaseFlag = false;
  }
}
