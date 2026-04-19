const MAX_RIPPLES     = 8;
const RIPPLE_LIFETIME = 2500; // ms

export class RippleManager {
  constructor() {
    this._ripples = [];
    this._color   = [0.0, 0.85, 1.0]; // default cyan
  }

  setColor(hex) {
    this._color = [
      parseInt(hex.slice(1, 3), 16) / 255,
      parseInt(hex.slice(3, 5), 16) / 255,
      parseInt(hex.slice(5, 7), 16) / 255,
    ];
  }

  // World space: x in [-aspect, aspect], y in [-1, 1]
  // Low pitch → left, high pitch → right
  spawn(pitch) {
    const aspect = window.innerWidth / window.innerHeight;
    const pitchT = Math.max(0, Math.min(1, (pitch - 21) / 87));
    const x = (pitchT * 2.0 - 1.0) * aspect * 0.80;
    const y = (Math.random() * 2.0 - 1.0) * 0.65;
    if (this._ripples.length >= MAX_RIPPLES) this._ripples.shift();
    this._ripples.push({ x, y, birthMs: performance.now(), color: [...this._color] });
  }

  update() {
    const cutoff = performance.now() - RIPPLE_LIFETIME;
    this._ripples = this._ripples.filter(r => r.birthMs > cutoff);
  }

  // Returns Float32Array(64) written at uniform buffer offset 112:
  //   [0..31]  — 8 × vec4f: (x, y, age_sec, 0)   ripple_pos_age
  //   [32..63] — 8 × vec4f: (r, g, b, 0)           ripple_color
  getUniforms() {
    const data = new Float32Array(64);
    // Default all ages to -1 (inactive)
    for (let i = 0; i < MAX_RIPPLES; i++) data[i * 4 + 2] = -1;

    for (let i = 0; i < this._ripples.length; i++) {
      const r = this._ripples[i];
      data[i * 4]     = r.x;
      data[i * 4 + 1] = r.y;
      data[i * 4 + 2] = (performance.now() - r.birthMs) / 1000;
      // data[i*4+3] = 0 (padding)
      data[32 + i * 4]     = r.color[0];
      data[32 + i * 4 + 1] = r.color[1];
      data[32 + i * 4 + 2] = r.color[2];
      // data[32+i*4+3] = 0 (padding)
    }
    return data;
  }
}
