// ---------------------------------------------------------------------------
// GenerativeDrift — slow pseudo-random macro-motion so no two minutes of a
// steady track look identical. Sums of incommensurate sines (periods 30–90 s)
// wander the composition centre, rotate the flow field's coordinate frame,
// and breathe the field scale. Re-seeded per audio source connection.
// ---------------------------------------------------------------------------

export class GenerativeDrift {
  constructor() {
    this.reseed();
    this._t = 0;
  }

  reseed() {
    this._p = Array.from({ length: 6 }, () => Math.random() * 1000);
  }

  // energy 0..1 — louder music drifts a bit faster
  update(dtS, energy = 0) {
    this._t += dtS * (0.7 + energy * 0.6);
    const t = this._t, p = this._p;

    // Composition centre wanders inside ±0.22 of screen space
    this.offX = 0.22 * (Math.sin(t / 41 + p[0]) * 0.6 + Math.sin(t / 67 + p[1]) * 0.4);
    this.offY = 0.18 * (Math.sin(t / 53 + p[2]) * 0.6 + Math.sin(t / 31 + p[3]) * 0.4);
    // Flow-field frame slowly rotates ±0.6 rad
    this.rot = 0.6 * Math.sin(t / 73 + p[4]);
    // Field scale breathes 0.75..1.35
    this.scale = 1.05 + 0.30 * Math.sin(t / 47 + p[5]);
    return this;
  }
}
