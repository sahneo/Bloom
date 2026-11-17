// ---------------------------------------------------------------------------
// ROLL — a piano roll you fly over. One lane per track; every note becomes a
// box that leaves the "now" line and drifts toward the horizon, length = how
// long it was held, height = velocity. Beat lines come from the MIDI clock
// (bars brightest). Turning a knob bends the whole road; mute dims the lane.
// ---------------------------------------------------------------------------

import { TRACK_RGB } from '../state.js';
import { rgba } from '../iso.js';

const LINE = [150, 158, 170];
const SHORT = ['BD', 'SD', 'LT', 'CP', 'CB', 'CH', 'OH', 'CY', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const STEP_UNITS = 46;         // road length of one 16th
const FAR = 2200, CAM_H = 150;

export class RollLook {
  constructor() { this.name = 'ROLL'; this.curve = 0; }

  draw(ctx, w, h, st, now, dt, dpr) {
    const W = w * dpr, H = h * dpr;
    const n = st.trackCount;
    const portrait = h > w * 1.1;
    const f = Math.min(W, H * 1.6);
    const horizon = H * (portrait ? 0.36 : 0.3);
    // camera distance so the now-line sits low on screen, lanes fill the width
    const NEAR = f * CAM_H / (H * 0.8 - horizon);
    const laneW = (portrait ? 0.94 : 0.8) * W * NEAR / (f * n);
    const cx = W / 2;
    const bpm = st.bpm > 0 ? st.bpm : 120;
    const stepMs = 60000 / (bpm * 4);
    const speed = STEP_UNITS / stepMs;

    // road bend follows whichever knob was touched last
    let k = st.knobs[0];
    for (const kn of st.knobs) if (kn.touch > k.touch) k = kn;
    const targetCurve = k.touch > 0.02 ? (k.shown - 0.5) * 0.0002 : 0;
    this.curve += (targetCurve - this.curve) * Math.min(1, dt / 600);
    const sway = Math.sin(now / 5200) * 0.00002;
    const bend = (z) => (this.curve + sway) * z * z;

    const P = (x, y, z) => {
      const zz = z + NEAR;
      return [cx + f * (x + bend(z)) / zz, horizon + f * (CAM_H - y) / zz];
    };

    // horizon glow
    const g = ctx.createLinearGradient(0, horizon - H * 0.12, 0, horizon + H * 0.05);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.7, `rgba(60,70,90,${0.22 + st.kick * 0.2})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, horizon - H * 0.12, W, H * 0.17);

    const x0 = -n * laneW / 2;
    const zs = [];
    for (let z = 0; z <= FAR; z += 60) zs.push(z);

    // lane edges as curves
    ctx.lineWidth = 1 * dpr;
    for (let i = 0; i <= n; i++) {
      const x = x0 + i * laneW;
      const tr = st.tracks[Math.min(i, n - 1)];
      ctx.strokeStyle = rgba(LINE, i === 0 || i === n ? 0.4 : (tr.muted ? 0.06 : 0.16));
      ctx.beginPath();
      zs.forEach((z, j) => { const p = P(x, 0, z); j ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); });
      ctx.stroke();
    }

    // beat lines from the clock (time-based when there's no clock)
    const pos = st.stepPos(now) >= 0 ? st.stepPos(now) : now / stepMs;
    for (let s = Math.floor(pos); s > pos - FAR / STEP_UNITS; s--) {
      const z = (pos - s) * STEP_UNITS;
      const fade = 1 - z / FAR;
      const a = s % 16 === 0 ? 0.55 : (s % 4 === 0 ? 0.25 : 0.07);
      ctx.strokeStyle = rgba(LINE, a * fade);
      ctx.lineWidth = (s % 16 === 0 ? 1.6 : 1) * dpr;
      ctx.beginPath();
      for (let i = 0; i <= 8; i++) {
        const p = P(x0 + (i / 8) * n * laneW, 0, z);
        i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]);
      }
      ctx.stroke();
    }

    // notes, far first
    ctx.lineJoin = 'round';
    for (let idx = 0; idx < st.hits.length; idx++) {
      const hit = st.hits[idx];
      if (hit.track >= n) continue;
      const zFar = (now - hit.t) * speed;
      if (zFar > FAR + 200) continue;
      let zNear = hit.off ? (now - hit.off) * speed : 0;
      zNear = Math.min(zNear, Math.max(0, zFar - STEP_UNITS * 0.45));
      const fade = 1 - Math.min(1, zFar / FAR);
      const rgb = TRACK_RGB[hit.track];
      const xa = x0 + hit.track * laneW + 6, xb = xa + laneW - 12;
      const hh = 8 + 70 * hit.vel;
      const muted = st.tracks[hit.track].mute;
      const alpha = fade * (1 - muted * 0.7);
      const q = (x, y, z) => P(x, y, z);
      const fa = q(xa, 0, zNear), fb = q(xb, 0, zNear), ft = q(xb, hh, zNear), fu = q(xa, hh, zNear);
      const ba = q(xa, hh, zFar), bb = q(xb, hh, zFar);
      // top face
      ctx.beginPath(); ctx.moveTo(fu[0], fu[1]); ctx.lineTo(ft[0], ft[1]); ctx.lineTo(bb[0], bb[1]); ctx.lineTo(ba[0], ba[1]); ctx.closePath();
      ctx.fillStyle = rgba(rgb, 0.1 * alpha); ctx.fill();
      ctx.strokeStyle = rgba(rgb, 0.75 * alpha); ctx.lineWidth = 1.2 * dpr; ctx.stroke();
      // front face — bright while the note is fresh
      const fresh = Math.max(0, 1 - zFar / 400);
      ctx.beginPath(); ctx.moveTo(fa[0], fa[1]); ctx.lineTo(fb[0], fb[1]); ctx.lineTo(ft[0], ft[1]); ctx.lineTo(fu[0], fu[1]); ctx.closePath();
      ctx.fillStyle = rgba(rgb, (0.15 + 0.6 * fresh) * alpha); ctx.fill(); ctx.stroke();
      // floor shadow line
      const sa = q(xa, 0, zFar), sb = q(xb, 0, zFar);
      ctx.beginPath(); ctx.moveTo(fa[0], fa[1]); ctx.lineTo(sa[0], sa[1]); ctx.moveTo(fb[0], fb[1]); ctx.lineTo(sb[0], sb[1]);
      ctx.strokeStyle = rgba(rgb, 0.25 * alpha); ctx.lineWidth = 1 * dpr; ctx.stroke();
    }

    // the "now" line: one key per lane that flashes on hits
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < n; i++) {
      const tr = st.tracks[i];
      const a = P(x0 + i * laneW + 3, 0, 0), b = P(x0 + (i + 1) * laneW - 3, 0, 0);
      const lit = tr.flash * (1 - tr.mute);
      ctx.strokeStyle = lit > 0.05 ? rgba(TRACK_RGB[i], 0.4 + 0.6 * lit) : rgba(LINE, tr.muted ? 0.12 : 0.4);
      ctx.lineWidth = (2 + 5 * lit) * dpr;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      if (lit > 0.05) {
        const up = P(x0 + (i + 0.5) * laneW, 120 * lit, 0), base = P(x0 + (i + 0.5) * laneW, 0, 0);
        const gr = ctx.createLinearGradient(base[0], base[1], up[0], up[1]);
        gr.addColorStop(0, rgba(TRACK_RGB[i], 0.5 * lit)); gr.addColorStop(1, rgba(TRACK_RGB[i], 0));
        ctx.strokeStyle = gr; ctx.lineWidth = (laneW * f / NEAR) * 0.5;
        ctx.beginPath(); ctx.moveTo(base[0], base[1]); ctx.lineTo(up[0], up[1]); ctx.stroke();
      }
    }
    ctx.globalCompositeOperation = 'source-over';

    // lane names under the now-line
    ctx.font = `600 ${Math.round((portrait ? 8 : 10) * dpr)}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = 'center';
    for (let i = 0; i < n; i++) {
      const p = P(x0 + (i + 0.5) * laneW, 0, 0);
      ctx.fillStyle = rgba(st.tracks[i].flash > 0.1 ? TRACK_RGB[i] : LINE, st.tracks[i].muted ? 0.2 : 0.6);
      const lanePx = W * (portrait ? 0.94 : 0.8) / n;
      ctx.fillText(lanePx < 70 * dpr ? SHORT[i] : st.tracks[i].name, p[0], p[1] + 16 * dpr);
    }
  }
}
