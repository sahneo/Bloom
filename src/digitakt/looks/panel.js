// ---------------------------------------------------------------------------
// PANEL — line-art isometric Digitakt that plays along.
//
// trig key n  = track n (1–8 audio, 9–16 MIDI A–H): flashes in the track
//               colour and throws rising outline echoes on every note
// step cursor = runs over the 16 keys from MIDI clock; trigs that landed on
//               a step leave a learned "LED" on it, like the real grid
// knobs A–H   = rotate from CC, value arc lights up while being turned
// mute (CC94) = the track key goes dark and dashed
// PLAY/STOP, PTN, page LEDs, screen = transport, pattern, tempo
// ---------------------------------------------------------------------------

import { PANEL, CONTROLS, QUICK_MUTE } from '../layout.js';
import { Iso, roundRectPts, circlePts, prism, polyPath, rgba } from '../iso.js';
import { TRACK_RGB, TRACK_NAMES } from '../state.js';

const THICK = 46;            // case height in panel units
const KEY_H = 9, TRIG_H = 11, KNOB_H = 22;
const LINE = [150, 158, 170];
const KNOB_ANG = (v) => (-135 + 270 * v) * Math.PI / 180;

const trigIndex = (id) => +id.split('_')[1] - 1;

export class PanelLook {
  constructor() {
    this.name = 'PANEL';
    this.iso = new Iso();
    this.items = CONTROLS.map(c => ({ ...c }));
    this.panelPts = roundRectPts(0, 0, PANEL.w, PANEL.h, PANEL.r, 6);
  }

  draw(ctx, w, h, st, now, dt, dpr) {
    const iso = this.iso;
    const portrait = h > w * 1.1;
    const sway = Math.sin(now / 9000) * 0.06;
    const yaw = (portrait ? -1.0 : -0.52) + sway;
    const elev = portrait ? 0.86 : 0.74;
    const lift = st.kick * 5;
    iso.setView(w, h, yaw, elev, { x0: 0, y0: 0, x1: PANEL.w, y1: PANEL.h, z0: -THICK, z1: KNOB_H + 30 }, portrait ? 0.96 : 0.86, portrait ? -0.04 : 0.02);

    this._floor(ctx, iso, st, now, dpr);

    const base = rgba(LINE, 0.62);
    const zTop = lift;

    // case
    prism(ctx, iso, this.panelPts, -THICK + lift, zTop, { fill: '#07080a', side: '#050607', stroke: base, lw: 1.2, dpr });
    // inner bevel line
    ctx.lineWidth = 1 * dpr; ctx.strokeStyle = rgba(LINE, 0.18);
    polyPath(ctx, iso, roundRectPts(10, 10, PANEL.w - 20, PANEL.h - 20, 14, 4), zTop, dpr); ctx.stroke();

    this._prints(ctx, iso, st, zTop, dpr);

    // controls, far → near so near ones overlap
    const items = this.items;
    for (const it of items) it.d = iso.depth(it.cx, it.cy);
    items.sort((a, b) => a.d - b.d);
    for (const it of items) {
      if (it.kind === 'knob') this._knob(ctx, iso, it, st, zTop, now, dpr);
      else if (it.kind === 'trig') this._trig(ctx, iso, it, st, zTop, now, dpr);
      else if (it.kind === 'key') this._key(ctx, iso, it, st, zTop, dpr);
      else if (it.kind === 'screen') this._screen(ctx, iso, it, st, zTop, now, dpr);
      else if (it.kind === 'led') this._pageLeds(ctx, iso, it, st, zTop, now, dpr);
    }
    this._echoes(ctx, iso, st, zTop, now, dpr);
  }

  // Desk grid under the box — scrolls one cell per 16th from the clock
  _floor(ctx, iso, st, now, dpr) {
    const z = -THICK - 2;
    const pos = st.stepPos(now);
    const scroll = pos >= 0 ? (pos % 1) * 60 : (now / 120) % 60;
    ctx.lineWidth = 1 * dpr;
    for (let gy = -600; gy <= PANEL.h + 600; gy += 60) {
      const y = gy + scroll;
      const fade = 1 - Math.min(1, Math.abs(y - PANEL.h / 2) / 900);
      ctx.strokeStyle = rgba(LINE, 0.07 * fade + st.kick * 0.04 * fade);
      polyPath(ctx, iso, [[-700, y], [PANEL.w + 700, y]], z, dpr, false); ctx.stroke();
    }
    for (let x = -700; x <= PANEL.w + 700; x += 60) {
      const fade = 1 - Math.min(1, Math.abs(x - PANEL.w / 2) / 1100);
      ctx.strokeStyle = rgba(LINE, 0.06 * fade);
      polyPath(ctx, iso, [[x, -600], [x, PANEL.h + 600]], z, dpr, false); ctx.stroke();
    }
  }

  // Panel printing: track names under trig keys, small wordmark, quick-mute bracket
  _prints(ctx, iso, st, z, dpr) {
    iso.plane(ctx, z, dpr);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '600 9px ui-monospace, Menlo, monospace';
    for (let i = 0; i < 16; i++) {
      const c = this.items.find(it => it.id === `key.trig_${i + 1}`);
      const tr = st.tracks[i];
      const lit = tr.flash * (1 - tr.mute);
      const name = i < 8 ? TRACK_NAMES[i] : (st.usedMidiTracks ? TRACK_NAMES[i].replace('MIDI ', 'MIDI·') : '');
      ctx.fillStyle = lit > 0.05 ? rgba(TRACK_RGB[i], 0.45 + 0.55 * lit) : rgba(LINE, tr.muted ? 0.18 : 0.42);
      ctx.fillText(name, c.cx, c.cy + c.h / 2 + 10);
    }
    ctx.font = '700 22px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = rgba(LINE, 0.55);
    ctx.fillText('d i g i t a k t', 166, 268);
    ctx.font = '500 9px ui-monospace, Menlo, monospace';
    ctx.fillStyle = rgba(LINE, 0.32);
    ctx.fillText('8 VOICE DRUM COMPUTER · LINE STUDY', 166, 92);
    ctx.textAlign = 'right';
    ctx.fillText('bloom', 812, 60);
    iso.screen(ctx, dpr);
    // quick-mute bracket
    ctx.strokeStyle = rgba(LINE, 0.3); ctx.lineWidth = 1 * dpr;
    polyPath(ctx, iso, [[QUICK_MUTE.cx - 14, 515], [QUICK_MUTE.cx - 6, 515], [QUICK_MUTE.cx - 6, 640], [QUICK_MUTE.cx - 14, 640]], z, dpr, false);
    ctx.stroke();
  }

  _knob(ctx, iso, it, st, z, now, dpr) {
    let value = 0.5, touch = 0, rgb = LINE;
    if (it.id.startsWith('knob.') && it.id.length === 6) {
      const k = st.knobs['abcdefgh'.indexOf(it.id[5])];
      value = k.shown; touch = k.touch; rgb = TRACK_RGB[k.track];
    } else if (it.id === 'enc.level_data') {
      value = st.levelKnob.shown; touch = st.levelKnob.touch; rgb = TRACK_RGB[st.activeTrack];
    } else {
      value = 0.72;
    }
    const r = it.w / 2 * 0.78;
    // value ring printed around the knob
    ctx.lineWidth = 1 * dpr;
    for (let i = 0; i <= 20; i++) {
      const v = i / 20, a = KNOB_ANG(v) - Math.PI / 2;
      const on = v <= value + 1e-3;
      const r0 = r + 5, r1 = r + (i % 5 === 0 ? 11 : 8);
      ctx.strokeStyle = on && touch > 0.02 ? rgba(rgb, 0.25 + 0.75 * touch) : rgba(LINE, on ? 0.38 : 0.16);
      polyPath(ctx, iso, [[it.cx + Math.cos(a) * r0, it.cy + Math.sin(a) * r0], [it.cx + Math.cos(a) * r1, it.cy + Math.sin(a) * r1]], z, dpr, false);
      ctx.stroke();
    }
    const hz = z + KNOB_H + touch * 3;
    prism(ctx, iso, circlePts(it.cx, it.cy, r, 28), z, hz, {
      fill: touch > 0.02 ? rgba(rgb.map(c => c * 0.12), 1) : '#0a0b0d',
      side: '#060708', stroke: touch > 0.02 ? rgba(rgb, 0.5 + 0.5 * touch) : rgba(LINE, 0.66), lw: 1.1, dpr,
    });
    // cap rim + pointer
    ctx.strokeStyle = rgba(LINE, 0.3);
    polyPath(ctx, iso, circlePts(it.cx, it.cy, r * 0.72, 20), hz, dpr); ctx.stroke();
    const a = KNOB_ANG(value) - Math.PI / 2;
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = touch > 0.02 ? rgba(rgb, 0.6 + 0.4 * touch) : rgba([235, 238, 242], 0.85);
    polyPath(ctx, iso, [[it.cx + Math.cos(a) * r * 0.25, it.cy + Math.sin(a) * r * 0.25], [it.cx + Math.cos(a) * r * 0.95, it.cy + Math.sin(a) * r * 0.95]], hz, dpr, false);
    ctx.stroke();
    if (it.label.length === 1) this._label(ctx, iso, it.label, it.cx, it.cy + it.h / 2 + 14, z, dpr, touch > 0.05 ? rgba(rgb, 0.9) : rgba(LINE, 0.45));
  }

  _key(ctx, iso, it, st, z, dpr) {
    let glow = 0, rgb = [235, 240, 245];
    if (it.id === 'btn.play') { glow = st.playing ? 0.35 + 0.65 * st.transportFlash : 0; rgb = [90, 240, 140]; }
    if (it.id === 'btn.stop') { glow = st.stopFlash; rgb = [240, 240, 240]; }
    if (it.id === 'btn.rec') { glow = 0; }
    if (it.id === 'btn.ptn') { glow = st.patternFlash; rgb = [255, 150, 60]; }
    if (it.id === 'btn.tempo' && st.playing && st.hasClock) {
      const p = st.stepPos(performance.now()); glow = Math.max(0, 1 - (p % 4) / 1.2) * 0.8; rgb = [255, 120, 60];
    }
    const press = glow > 0.6 ? 3 : 0;
    const pts = roundRectPts(it.cx - it.w / 2, it.cy - it.h / 2, it.w, it.h, 4, 2);
    prism(ctx, iso, pts, z, z + KEY_H - press, {
      fill: glow > 0.02 ? rgba(rgb.map(c => c * 0.25 * glow), 1) : '#0b0c0e', side: '#060708',
      stroke: glow > 0.02 ? rgba(rgb, 0.4 + 0.6 * glow) : rgba(LINE, 0.55), lw: 1, dpr,
    });
    this._label(ctx, iso, it.label, it.cx, it.cy, z + KEY_H - press, dpr, glow > 0.02 ? rgba(rgb, 0.9) : rgba(LINE, 0.55), 8);
  }

  _trig(ctx, iso, it, st, z, now, dpr) {
    const i = trigIndex(it.id);
    const tr = st.tracks[i];
    const rgb = TRACK_RGB[i];
    const visible = i < st.trackCount;
    const flash = visible ? tr.flash * (1 - tr.mute * 0.85) : 0;
    const step = st.step(now);
    const isStep = step === i;
    // learned trig LED for the most recently played track (what the grid would show)
    const focus = st.hits.length ? st.hits[st.hits.length - 1].track : 0;
    const led = st.tracks[focus].steps[i];
    const press = flash * 4;
    const zt = z + TRIG_H - press;
    const pts = roundRectPts(it.cx - it.w / 2, it.cy - it.h / 2, it.w, it.h, 5, 2);
    const fillA = Math.min(1, flash * 0.9 + (isStep ? 0.18 : 0) + led * 0.12);
    const fillRGB = isStep && flash < 0.1 ? [230, 236, 245] : (flash > 0.05 ? rgb : TRACK_RGB[focus]);
    prism(ctx, iso, pts, z, zt, {
      fill: fillA > 0.01 ? rgba(fillRGB.map(c => c * fillA * 0.55), 1) : '#0b0c0e',
      side: '#060708',
      stroke: flash > 0.05 ? rgba(rgb, 0.5 + 0.5 * flash) : rgba(LINE, tr.muted ? 0.22 : (isStep ? 0.95 : 0.6)),
      lw: isStep ? 1.6 : 1, dpr,
    });
    // inner LED window
    const inset = roundRectPts(it.cx - it.w / 2 + 8, it.cy - it.h / 2 + 8, it.w - 16, it.h - 16, 3, 2);
    ctx.lineWidth = 1 * dpr;
    if (tr.muted && visible) {
      ctx.setLineDash([3 * dpr, 3 * dpr]);
      ctx.strokeStyle = rgba(LINE, 0.35);
      polyPath(ctx, iso, inset, zt, dpr); ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.strokeStyle = flash > 0.05 ? rgba([255, 255, 255], 0.35 + 0.6 * flash) : rgba(LINE, 0.22);
      polyPath(ctx, iso, inset, zt, dpr); ctx.stroke();
    }
    if (flash > 0.05) {   // additive bloom on the top face
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = rgba(rgb, 0.35 * flash);
      polyPath(ctx, iso, roundRectPts(it.cx - it.w / 2 - 6, it.cy - it.h / 2 - 6, it.w + 12, it.h + 12, 8, 2), zt, dpr); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
    this._label(ctx, iso, it.label, it.cx, it.cy, zt, dpr, flash > 0.3 ? 'rgba(255,255,255,0.95)' : rgba(LINE, tr.muted ? 0.25 : 0.6), 11);
  }

  // Rising outline echoes from each track's key — the "sound leaving the box"
  _echoes(ctx, iso, st, z, now, dpr) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 1.2 * dpr;
    for (let k = st.hits.length - 1; k >= 0; k--) {
      const h = st.hits[k];
      const age = (now - h.t) / 900;
      if (age > 1) break;
      if (age < 0 || h.track >= st.trackCount) continue;
      const c = this.items.find(it => it.id === `key.trig_${h.track + 1}`);
      const grow = 1 + age * 0.6;
      const w = c.w * grow, hh = c.h * grow;
      ctx.strokeStyle = rgba(TRACK_RGB[h.track], (1 - age) * (0.3 + 0.7 * h.vel));
      polyPath(ctx, iso, roundRectPts(c.cx - w / 2, c.cy - hh / 2, w, hh, 5, 2), z + TRIG_H + age * (90 + 140 * h.vel), dpr);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  _screen(ctx, iso, it, st, z, now, dpr) {
    const x0 = it.cx - it.w / 2, y0 = it.cy - it.h / 2;
    const pts = roundRectPts(x0 - 8, y0 - 8, it.w + 16, it.h + 16, 4, 2);
    ctx.lineWidth = 1 * dpr; ctx.strokeStyle = rgba(LINE, 0.55);
    polyPath(ctx, iso, pts, z, dpr); ctx.fillStyle = '#030304'; ctx.fill(); ctx.stroke();
    const sz = z + 0.5;
    iso.plane(ctx, sz, dpr);
    const fg = 'rgba(236,240,246,0.92)', dim = 'rgba(236,240,246,0.35)';
    ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    ctx.font = '700 15px ui-monospace, Menlo, monospace';
    ctx.fillStyle = st.patternFlash > 0.1 ? `rgba(255,160,70,${0.5 + 0.5 * st.patternFlash})` : fg;
    ctx.fillText(st.patternName(), x0 + 6, y0 + 5);
    ctx.textAlign = 'right';
    ctx.font = '600 12px ui-monospace, Menlo, monospace';
    ctx.fillStyle = fg;
    ctx.fillText(st.bpm > 0 ? `${st.bpm.toFixed(1)} BPM` : '--- BPM', x0 + it.w - 6, y0 + 7);
    ctx.textAlign = 'left';
    ctx.font = '500 9px ui-monospace, Menlo, monospace';
    ctx.fillStyle = dim;
    ctx.fillText(st.playing ? '▶ PLAY' : '■ STOP', x0 + 60, y0 + 9);

    const touched = st.knobs.reduce((m, k) => k.touch > m.touch ? k : m, st.knobs[0]);
    const midY = y0 + 30, midH = 52;
    if (touched.touch > 0.08) {
      ctx.font = '700 13px ui-monospace, Menlo, monospace';
      ctx.fillStyle = rgba(TRACK_RGB[touched.track], 0.4 + 0.6 * touched.touch);
      ctx.fillText(`${st.tracks[touched.track].name} · ${touched.name}`, x0 + 6, midY + 4);
      ctx.strokeStyle = dim; ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 6, midY + 26, it.w - 12, 10);
      ctx.fillStyle = rgba(TRACK_RGB[touched.track], 0.85);
      ctx.fillRect(x0 + 6, midY + 26, (it.w - 12) * touched.shown, 10);
    } else {
      // mixer: one bar per track
      const n = st.trackCount, bw = (it.w - 12) / n;
      for (let i = 0; i < n; i++) {
        const tr = st.tracks[i];
        const v = tr.muted ? 0.04 : Math.max(0.04, tr.flash);
        ctx.fillStyle = tr.muted ? dim : rgba(TRACK_RGB[i], 0.35 + 0.65 * tr.flash);
        ctx.fillRect(x0 + 6 + i * bw + 1.5, midY + midH - v * midH, bw - 3, v * midH);
      }
    }
    // 16-step strip with playhead
    const step = st.step(now);
    const sw = (it.w - 12) / 16;
    for (let s = 0; s < 16; s++) {
      ctx.fillStyle = s === step ? fg : (s % 4 === 0 ? 'rgba(236,240,246,0.3)' : 'rgba(236,240,246,0.14)');
      ctx.fillRect(x0 + 6 + s * sw + 1, y0 + it.h - 14, sw - 2, s === step ? 8 : 4);
    }
    iso.screen(ctx, dpr);
  }

  _pageLeds(ctx, iso, it, st, z, now, dpr) {
    const pos = st.stepPos(now);
    const page = pos >= 0 ? Math.floor(pos / 16) % 4 : -1;
    for (let i = 0; i < 4; i++) {
      const cx = it.cx - it.w / 2 + (i + 0.5) * (it.w / 4);
      ctx.lineWidth = 1 * dpr;
      ctx.strokeStyle = rgba(LINE, 0.5);
      polyPath(ctx, iso, circlePts(cx, it.cy, 3.5, 10), z, dpr);
      if (i === page) { ctx.fillStyle = 'rgba(255,90,60,0.95)'; ctx.fill(); }
      ctx.stroke();
    }
  }

  _label(ctx, iso, text, x, y, z, dpr, color, size = 9) {
    if (!text) return;
    iso.plane(ctx, z, dpr);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `600 ${size}px ui-monospace, Menlo, monospace`;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    iso.screen(ctx, dpr);
  }
}
