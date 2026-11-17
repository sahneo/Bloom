// ---------------------------------------------------------------------------
// PILLARS — every track is a wire-frame column of light on an isometric floor.
// note → the column shoots up (height = velocity) and throws a beam;
// held notes keep it up; knob turns on a track twist its column;
// mute → only a dashed footprint stays; the clock walks a row of 16 floor
// tiles in front, tiles light where trigs landed.
// ---------------------------------------------------------------------------

import { Iso, prism, polyPath, rgba } from '../iso.js';
import { TRACK_RGB } from '../state.js';

const LINE = [150, 158, 170];
const CELL = 110, BASE = 64;

export class PillarsLook {
  constructor() {
    this.name = 'PILLARS';
    this.iso = new Iso();
    this.h = new Float32Array(16);
  }

  draw(ctx, w, h, st, now, dt, dpr) {
    const iso = this.iso;
    const n = st.trackCount;
    const rows = n > 8 ? 2 : 1;
    const W = 8 * CELL, D = rows * CELL + 240;
    const portrait = h > w * 1.1;
    iso.setView(w, h, -0.62 + Math.sin(now / 11000) * 0.08, portrait ? 0.62 : 0.52,
      { x0: -40, y0: -40, x1: W + 40, y1: D, z0: 0, z1: 300 }, portrait ? 1.05 : 0.98, 0);

    // floor grid
    ctx.lineWidth = 1 * dpr;
    for (let x = -CELL * 2; x <= W + CELL * 2; x += CELL / 2) {
      ctx.strokeStyle = rgba(LINE, 0.07);
      polyPath(ctx, iso, [[x, -CELL * 2], [x, D + CELL]], 0, dpr, false); ctx.stroke();
    }
    for (let y = -CELL * 2; y <= D + CELL; y += CELL / 2) {
      ctx.strokeStyle = rgba(LINE, 0.07);
      polyPath(ctx, iso, [[-CELL * 2, y], [W + CELL * 2, y]], 0, dpr, false); ctx.stroke();
    }

    // step tiles: a row of 16 in front of the pillars
    const step = st.step(now);
    const tw = W / 16, ty = rows * CELL + 60;
    for (let s = 0; s < 16; s++) {
      const x0 = s * tw + 4, pts = [[x0, ty], [x0 + tw - 8, ty], [x0 + tw - 8, ty + 70], [x0, ty + 70]];
      let lit = 0, rgb = LINE;
      for (let i = 0; i < n; i++) if (st.tracks[i].steps[s] > lit) { lit = st.tracks[i].steps[s]; rgb = TRACK_RGB[i]; }
      polyPath(ctx, iso, pts, 0, dpr);
      if (s === step) { ctx.fillStyle = 'rgba(235,240,248,0.55)'; ctx.fill(); }
      else if (lit > 0.05) { ctx.fillStyle = rgba(rgb, 0.12 + 0.3 * lit); ctx.fill(); }
      ctx.strokeStyle = rgba(LINE, s % 4 === 0 ? 0.45 : 0.25);
      ctx.stroke();
    }

    // pillars far → near
    const order = [];
    for (let i = 0; i < n; i++) {
      const row = i < 8 ? rows - 1 : 0;
      const cx = (i % 8) * CELL + CELL / 2, cy = row * CELL + CELL / 2;
      order.push({ i, cx, cy, d: iso.depth(cx, cy) });
    }
    order.sort((a, b) => a.d - b.d);

    ctx.lineJoin = 'round';
    for (const { i, cx, cy } of order) {
      const tr = st.tracks[i];
      const rgb = TRACK_RGB[i];
      const target = tr.muted ? 0 : 14 + 300 * tr.flash * (0.4 + 0.6 * tr.vel) + (tr.gate > 0 ? 40 : 0);
      this.h[i] += (target - this.h[i]) * (target > this.h[i] ? 0.55 : 0.12);
      const hh = this.h[i];
      const half = BASE / 2;
      const foot = [[cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half], [cx - half, cy + half]];

      if (tr.mute > 0.5) {
        ctx.setLineDash([4 * dpr, 4 * dpr]);
        ctx.strokeStyle = rgba(rgb, 0.3);
        polyPath(ctx, iso, foot, 0, dpr); ctx.stroke();
        ctx.setLineDash([]);
        continue;
      }
      // twisted top: knob value on this track rotates the cap
      const tw = (tr.modShown - 0.5) * Math.PI * 0.9;
      const top = foot.map(([x, y]) => {
        const dx = x - cx, dy = y - cy;
        return [cx + dx * Math.cos(tw) - dy * Math.sin(tw), cy + dx * Math.sin(tw) + dy * Math.cos(tw)];
      });
      const glow = Math.min(1, tr.flash + tr.modTouch * 0.3);
      // body: fill dark, then edges
      if (Math.abs(tw) < 0.05) {
        prism(ctx, iso, foot, 0, hh, { fill: rgba(rgb.map(c => c * 0.12 * (0.3 + glow)), 1), side: '#050608', stroke: rgba(rgb, 0.35 + 0.65 * glow), lw: 1.3, dpr });
      } else {
        ctx.lineWidth = 1.3 * dpr; ctx.strokeStyle = rgba(rgb, 0.35 + 0.65 * glow);
        polyPath(ctx, iso, foot, 0, dpr); ctx.stroke();
        polyPath(ctx, iso, top, hh, dpr); ctx.fillStyle = rgba(rgb.map(c => c * 0.12 * (0.3 + glow)), 1); ctx.fill(); ctx.stroke();
        ctx.beginPath();
        for (let k = 0; k < 4; k++) {
          const a = iso.P(foot[k][0], foot[k][1], 0), b = iso.P(top[k][0], top[k][1], hh);
          ctx.moveTo(a[0] * dpr, a[1] * dpr); ctx.lineTo(b[0] * dpr, b[1] * dpr);
        }
        ctx.stroke();
      }
      // horizontal rings climbing the column
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = 1 * dpr;
      for (let r = 1; r * 26 < hh; r++) {
        const z = r * 26, f = z / Math.max(hh, 1);
        const ring = foot.map(([x, y], k) => [x + (top[k][0] - x) * f, y + (top[k][1] - y) * f]);
        ctx.strokeStyle = rgba(rgb, (0.08 + 0.3 * glow) * (1 - f * 0.5));
        polyPath(ctx, iso, ring, z, dpr); ctx.stroke();
      }
      // beam
      if (tr.flash > 0.08) {
        const a = iso.P(cx, cy, hh), b = iso.P(cx, cy, hh + 260 * tr.flash);
        const g = ctx.createLinearGradient(a[0] * dpr, a[1] * dpr, b[0] * dpr, b[1] * dpr);
        g.addColorStop(0, rgba(rgb, 0.8 * tr.flash)); g.addColorStop(1, rgba(rgb, 0));
        ctx.strokeStyle = g; ctx.lineWidth = (2 + 10 * tr.flash) * dpr;
        ctx.beginPath(); ctx.moveTo(a[0] * dpr, a[1] * dpr); ctx.lineTo(b[0] * dpr, b[1] * dpr); ctx.stroke();
        // floor splash ring
        const rr = half + 70 * (1 - tr.flash);
        ctx.lineWidth = 1.2 * dpr; ctx.strokeStyle = rgba(rgb, 0.5 * tr.flash);
        polyPath(ctx, iso, [[cx - rr, cy - rr], [cx + rr, cy - rr], [cx + rr, cy + rr], [cx - rr, cy + rr]], 0, dpr); ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // names on the floor
    ctx.font = `600 ${Math.round(Math.max(9, 11 * iso.S) * dpr)}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = 'center';
    for (const { i, cx, cy } of order) {
      const p = iso.P(cx, cy + BASE / 2 + 18, 0);
      ctx.fillStyle = rgba(st.tracks[i].flash > 0.1 ? TRACK_RGB[i] : LINE, st.tracks[i].muted ? 0.2 : 0.55);
      ctx.fillText(st.tracks[i].name, p[0] * dpr, p[1] * dpr);
    }
  }
}
