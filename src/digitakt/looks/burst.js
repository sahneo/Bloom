// ---------------------------------------------------------------------------
// BURST — eight voices on a ring, each throws its own kind of light:
//   kick → shockwave from the centre that shoves every particle outward
//   snare / clap → radial spark bursts      toms → orbiting arcs
//   cowbell → a square that spins out       hats / cymbal → fine fast sparks
//   MIDI A–H → streaks toward the centre, angle by pitch
// Knob turns on a track spin its particles into a vortex; muted voices go
// dashed and silent. The outer ring of 16 ticks is the sequencer step.
// ---------------------------------------------------------------------------

import { TRACK_RGB } from '../state.js';
import { rgba } from '../iso.js';

const LINE = [150, 158, 170];
const MAX = 2400;

export class BurstLook {
  constructor() {
    this.name = 'BURST';
    // struct-of-arrays particle pool
    this.x = new Float32Array(MAX); this.y = new Float32Array(MAX);
    this.vx = new Float32Array(MAX); this.vy = new Float32Array(MAX);
    this.life = new Float32Array(MAX); this.max = new Float32Array(MAX);
    this.tr = new Uint8Array(MAX); this.kind = new Uint8Array(MAX);
    this.head = 0;
    this.seen = 0;          // hits consumed
    this.lastId = -1;
    this.waves = [];        // {t, vel, track, kind}
    this.spin = 0;
  }

  _emit(x, y, vx, vy, life, tr, kind = 0) {
    const i = this.head; this.head = (this.head + 1) % MAX;
    this.x[i] = x; this.y[i] = y; this.vx[i] = vx; this.vy[i] = vy;
    this.life[i] = life; this.max[i] = life; this.tr[i] = tr; this.kind[i] = kind;
  }

  draw(ctx, w, h, st, now, dt, dpr) {
    const W = w * dpr, H = h * dpr;
    const cx = W / 2, cy = H / 2;
    const R = Math.min(W, H) * 0.33;
    const n = st.trackCount;
    const s = dt / 1000;
    this.spin += s * 0.05 * (1 + st.energy);

    const node = (i) => {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2 + this.spin;
      const r = i < 8 ? R : R * 0.62;
      return [cx + Math.cos(a) * r, cy + Math.sin(a) * r, a];
    };

    // consume new hits (state keeps a ring; track by timestamp)
    if (this.lastId < 0) this.lastId = st.hitSeq;   // don't replay history on first show
    for (const hit of st.hits) {
      if (hit.id <= this.lastId) continue;
      this.lastId = hit.id;
      if (now - hit.t > 250) continue;
      if (hit.track >= n || st.tracks[hit.track].muted) continue;
      this._spawn(hit, node(hit.track), cx, cy, R, dpr);
    }

    // ring + step ticks
    ctx.lineWidth = 1 * dpr;
    ctx.strokeStyle = rgba(LINE, 0.18);
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    if (n > 8) { ctx.beginPath(); ctx.arc(cx, cy, R * 0.62, 0, Math.PI * 2); ctx.stroke(); }
    const step = st.step(now);
    for (let k = 0; k < 16; k++) {
      const a = -Math.PI / 2 + (k / 16) * Math.PI * 2;
      const on = k === step;
      const r0 = R * 1.18, r1 = R * (on ? 1.32 : (k % 4 === 0 ? 1.25 : 1.22));
      ctx.strokeStyle = on ? 'rgba(240,244,250,0.95)' : rgba(LINE, k % 4 === 0 ? 0.4 : 0.2);
      ctx.lineWidth = (on ? 3 : 1.2) * dpr;
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); ctx.stroke();
    }

    // kick shockwaves push everything out
    let push = 0;
    ctx.globalCompositeOperation = 'lighter';
    this.waves = this.waves.filter(wv => now - wv.t < 1400);
    for (const wv of this.waves) {
      const age = (now - wv.t) / 1400;
      const rr = R * (0.1 + 2.2 * Math.pow(age, 0.6));
      const rgb = TRACK_RGB[wv.track];
      ctx.lineWidth = (1 + 5 * wv.vel * (1 - age)) * dpr;
      if (wv.kind === 1) {   // cowbell square
        ctx.save(); ctx.translate(wv.x, wv.y); ctx.rotate(age * 2.5);
        const sz = 20 * dpr + R * 0.7 * age;
        ctx.strokeStyle = rgba(rgb, 0.8 * (1 - age));
        ctx.strokeRect(-sz / 2, -sz / 2, sz, sz);
        ctx.restore();
      } else {
        ctx.strokeStyle = rgba(rgb, 0.7 * (1 - age) * wv.vel);
        ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.stroke();
        if (age < 0.35) push += (0.35 - age) * wv.vel;
      }
    }

    // particles
    const drag = Math.exp(-s * 1.6);
    ctx.lineCap = 'round';
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= s;
      if (this.life[i] <= 0) continue;
      const t = this.tr[i];
      const tr = st.tracks[t];
      let dx = this.x[i] - cx, dy = this.y[i] - cy;
      const d = Math.hypot(dx, dy) + 1;
      // vortex from knob turns on this track, push from kick waves
      const swirl = (tr.modShown - 0.5) * 2 * (0.3 + tr.modTouch) * 420 * dpr;
      this.vx[i] += (-dy / d * swirl + dx / d * push * 2600 * dpr) * s;
      this.vy[i] += (dx / d * swirl + dy / d * push * 2600 * dpr) * s;
      if (this.kind[i] === 2) {   // tom arcs orbit the centre
        this.vx[i] += -dy / d * 900 * dpr * s - dx / d * 300 * dpr * s;
        this.vy[i] += dx / d * 900 * dpr * s - dy / d * 300 * dpr * s;
      }
      this.vx[i] *= drag; this.vy[i] *= drag;
      const px = this.x[i], py = this.y[i];
      this.x[i] += this.vx[i] * s; this.y[i] += this.vy[i] * s;
      const lf = this.life[i] / this.max[i];
      ctx.strokeStyle = rgba(TRACK_RGB[t], lf * (this.kind[i] === 3 ? 0.9 : 0.75));
      ctx.lineWidth = (this.kind[i] === 3 ? 0.9 : 1.6) * dpr * (0.5 + lf);
      // streak = last frame's travel ×2.5 for a motion-blur trail
      ctx.beginPath();
      ctx.moveTo(px - (this.x[i] - px) * 1.5, py - (this.y[i] - py) * 1.5);
      ctx.lineTo(this.x[i], this.y[i]);
      ctx.stroke();
    }

    // nodes
    for (let i = 0; i < n; i++) {
      const tr = st.tracks[i];
      const [x, y] = node(i);
      const rgb = TRACK_RGB[i];
      const lit = tr.flash * (1 - tr.mute);
      const r = (8 + 10 * lit) * dpr;
      if (tr.muted) ctx.setLineDash([3 * dpr, 3 * dpr]);
      ctx.lineWidth = 1.4 * dpr;
      ctx.strokeStyle = tr.muted ? rgba(LINE, 0.3) : rgba(rgb, 0.45 + 0.55 * lit);
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      if (lit > 0.05) {
        const g = ctx.createRadialGradient(x, y, 0, x, y, r * 3.2);
        g.addColorStop(0, rgba(rgb, 0.7 * lit)); g.addColorStop(1, rgba(rgb, 0));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 3.2, 0, Math.PI * 2); ctx.fill();
      }
      // knob arc on the node while turned
      if (tr.modTouch > 0.03) {
        ctx.strokeStyle = rgba(rgb, tr.modTouch);
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath(); ctx.arc(x, y, r + 7 * dpr, -Math.PI * 0.75, -Math.PI * 0.75 + Math.PI * 1.5 * tr.modShown); ctx.stroke();
      }
    }
    ctx.globalCompositeOperation = 'source-over';

    // labels
    ctx.font = `600 ${Math.round(9 * dpr)}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i < n; i++) {
      const [x, y, a] = node(i);
      const off = (i < 8 ? 30 : -30) * dpr;
      ctx.fillStyle = rgba(st.tracks[i].flash > 0.1 ? TRACK_RGB[i] : LINE, st.tracks[i].muted ? 0.2 : 0.55);
      ctx.fillText(st.tracks[i].name, x + Math.cos(a) * off, y + Math.sin(a) * off);
    }
  }

  _spawn(hit, [x, y, a], cx, cy, R, dpr) {
    const t = hit.track, v = hit.vel;
    const rnd = Math.random;
    const out = (sp, spread, cnt, life, kind = 0) => {
      for (let k = 0; k < cnt; k++) {
        const aa = a + (rnd() - 0.5) * spread;
        const ss = sp * (0.4 + rnd() * 0.8) * dpr;
        this._emit(x, y, Math.cos(aa) * ss, Math.sin(aa) * ss, life * (0.6 + rnd() * 0.6), t, kind);
      }
    };
    if (t >= 8) {   // MIDI tracks: streak toward the centre, pitch → angle
      const pa = (hit.note % 12) / 12 * Math.PI * 2;
      for (let k = 0; k < 14; k++) {
        const ss = (300 + 500 * v) * (0.6 + rnd() * 0.5) * dpr;
        const dx = cx + Math.cos(pa) * R * 0.15 - x, dy = cy + Math.sin(pa) * R * 0.15 - y, d = Math.hypot(dx, dy);
        this._emit(x, y, dx / d * ss + (rnd() - 0.5) * 60 * dpr, dy / d * ss + (rnd() - 0.5) * 60 * dpr, 1.1, t, 0);
      }
      return;
    }
    switch (t) {
      case 0:   // kick
        this.waves.push({ t: performance.now(), vel: v, track: 0, kind: 0 });
        out(260 + 300 * v, Math.PI * 2, 30 + 30 * v, 1.0);
        break;
      case 1: case 3:   // snare, clap
        out(500 + 600 * v, Math.PI * 2, 50 + 50 * v, 0.8);
        if (t === 3) out(200, Math.PI * 2, 30, 1.2, 3);
        break;
      case 2:   // tom
        out(300 + 200 * v, 1.2, 36, 1.6, 2);
        break;
      case 4:   // cowbell
        this.waves.push({ t: performance.now(), vel: v, track: 4, kind: 1, x, y });
        out(280, Math.PI * 2, 16, 0.7);
        break;
      default:  // hats / cymbal: fine fast sparks, open hat + cymbal last longer
        out(700 + 500 * v, 1.4, t === 5 ? 14 : 26, t === 5 ? 0.35 : 0.9, 3);
    }
  }
}
