// ---------------------------------------------------------------------------
// DIGITAKT mode — self-contained overlay: own canvas (2D, works without
// WebGPU, so phones get it too), own Web MIDI listener, own demo stream.
//
// Hook into the app with one call:  toggleDigitakt()  (or mountDigitakt()).
// Keys inside the mode:
//   L / → / ←  next / previous look      1–4  pick a look
//   X          demo on/off                I    MIDI monitor
//   F          fullscreen                 Esc  leave the mode
//   T          which track the trig keys show (auto → 1…8 → auto)
//
// The Digitakt doesn't send its audio sequencer as MIDI notes, so the mode
// reads the pattern over SysEx (needs the MIDI+SysEx permission) and plays
// the trigs back from MIDI clock. Re-read on PLAY, pattern change and every
// ~1.5 s, so trigs placed in GRID mode show up without saving.
// Tap (phone): next look. URL: ?digitakt[=look][&dtauto=10]
// ---------------------------------------------------------------------------

import { DTState } from './state.js';
import { DemoSequencer } from './demo.js';
import { buildPatternRequest, parsePatternDump } from './sysex.js';
import { PanelLook } from './looks/panel.js';
import { PillarsLook } from './looks/pillars.js';
import { RollLook } from './looks/roll.js';
import { BurstLook } from './looks/burst.js';

const LOOKS = [PanelLook, PillarsLook, RollLook, BurstLook];
const REAL_GRACE_MS = 4000;   // HUD shows the device as live this long after a message

let instance = null;

export function mountDigitakt(opts = {}) {
  if (!instance) instance = new DigitaktMode(opts);
  instance.mount();
  return instance;
}
export function unmountDigitakt() { instance?.unmount(); }
export function toggleDigitakt(opts) {
  if (instance?.mounted) instance.unmount(); else mountDigitakt(opts);
}

class DigitaktMode {
  constructor({ look = 0, autoChannel, onExit } = {}) {
    const q = new URLSearchParams(location.search);
    this.autoChannel = autoChannel ?? (+q.get('dtauto') || 10);
    this.lookIdx = Math.max(0, Math.min(LOOKS.length - 1, look));
    this.onExit = onExit;
    this.mounted = false;
    this.state = new DTState({ autoChannel: this.autoChannel });
    this.looks = LOOKS.map(L => new L());
    this.demo = new DemoSequencer((b, t) => this.state.feed(b, t, 'demo'));
    this.demoWanted = true;
    this.source = '';
    this.showMonitor = q.has('dtmon');
    this.hudUntil = 0;
    this._frame = this._frame.bind(this);
    this._key = this._key.bind(this);
    this._resize = this._resize.bind(this);
    this._onMidi = this._onMidi.bind(this);
    this.fps = 60; this._fpsAcc = 0; this._fpsN = 0;
  }

  mount() {
    if (this.mounted) return;
    this.mounted = true;
    const root = this.root = document.createElement('div');
    root.id = 'digitakt-mode';
    root.style.cssText = 'position:fixed;inset:0;z-index:9000;background:#040506;touch-action:manipulation;user-select:none;-webkit-user-select:none';
    const cv = this.canvas = document.createElement('canvas');
    cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
    root.appendChild(cv);

    this.hud = document.createElement('div');
    this.hud.style.cssText = 'position:absolute;left:max(14px,env(safe-area-inset-left));bottom:max(12px,env(safe-area-inset-bottom));font:500 11px/1.5 ui-monospace,Menlo,monospace;color:rgba(230,235,242,.7);letter-spacing:.04em;pointer-events:none;transition:opacity .6s;white-space:pre-wrap;max-width:calc(100vw - 28px)';
    root.appendChild(this.hud);

    this.mon = document.createElement('pre');
    this.mon.style.cssText = 'position:absolute;right:14px;top:52px;margin:0;padding:8px 10px;font:500 10px/1.45 ui-monospace,Menlo,monospace;color:rgba(230,235,242,.85);background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.12);pointer-events:none;display:none;max-width:60vw;overflow:hidden';
    root.appendChild(this.mon);

    const close = document.createElement('button');
    close.textContent = '×';
    close.title = 'Leave Digitakt mode (Esc)';
    close.style.cssText = 'position:absolute;right:max(10px,env(safe-area-inset-right));top:max(10px,env(safe-area-inset-top));width:36px;height:36px;border-radius:18px;border:1px solid rgba(255,255,255,.18);background:rgba(0,0,0,.35);color:rgba(255,255,255,.75);font:300 22px/1 system-ui;cursor:pointer';
    close.addEventListener('click', (e) => { e.stopPropagation(); this.unmount(); });
    root.appendChild(close);

    root.addEventListener('pointerdown', (e) => {
      if (e.target === close) return;
      this.setLook(this.lookIdx + 1);
    });

    document.body.appendChild(root);
    this.ctx = cv.getContext('2d', { alpha: false });
    window.addEventListener('resize', this._resize);
    window.addEventListener('keydown', this._key, true);
    this._resize();
    this.hudUntil = performance.now() + 5000;
    this._connectMidi();
    this._last = performance.now();
    this._raf = requestAnimationFrame(this._frame);
    window.__digitakt = this;   // tests + console
  }

  unmount() {
    if (!this.mounted) return;
    this.mounted = false;
    cancelAnimationFrame(this._raf);
    this.demo.stop(performance.now());
    window.removeEventListener('resize', this._resize);
    window.removeEventListener('keydown', this._key, true);
    if (this.midi) for (const inp of this.midi.inputs.values()) inp.removeEventListener('midimessage', this._onMidi);
    this.root.remove();
    this.onExit?.();
  }

  setLook(i) {
    this.lookIdx = (i + LOOKS.length) % LOOKS.length;
    this.hudUntil = performance.now() + 2500;
  }

  // ── MIDI ────────────────────────────────────────────────────────────
  async _connectMidi() {
    if (!navigator.requestMIDIAccess) { this.source = 'no Web MIDI here — demo'; return; }
    try {
      // SysEx lets us read the pattern; if refused, fall back to notes/clock only
      try { this.midi = await navigator.requestMIDIAccess({ sysex: true }); this.sysex = true; }
      catch (_) { this.midi = await navigator.requestMIDIAccess({ sysex: false }); this.sysex = false; }
      const attach = () => {
        const names = [];
        for (const inp of this.midi.inputs.values()) {
          // addEventListener, not onmidimessage: the main app's handler keeps working
          inp.removeEventListener('midimessage', this._onMidi);
          inp.addEventListener('midimessage', this._onMidi);
          names.push(inp.name);
        }
        const dt = names.find(n => /digitakt|elektron/i.test(n));
        this.inputNames = names;
        this.deviceName = dt ?? '';
        this.dtOut = this.sysex ? [...this.midi.outputs.values()].find(o => /digitakt|elektron/i.test(o.name)) ?? null : null;
        this.dump = { pending: 0, last: -1e9, fails: 0, ms: 0, slot: -1, ...(this.dump ?? {}), want: true };
        this.hudUntil = performance.now() + 4000;
      };
      attach();
      this.midi.addEventListener('statechange', attach);
    } catch (e) {
      this.source = 'MIDI blocked — demo';
    }
  }

  _onMidi(e) {
    if (!this.mounted) return;
    const now = performance.now();
    const d = e.data;
    if (d[0] === 0xf0 || (this._sx && !(d.length === 1 && d[0] >= 0xf8))) { this._sysexIn(d, now); return; }
    this.realName = e.target?.name ?? 'MIDI';
    // first real message: the demo steps aside for good (X brings it back)
    if (!this.realSeen) {
      this.realSeen = true; this.demoWanted = false; this.hudUntil = now + 3000;
      // stop the demo *before* the real message lands, so its STOP doesn't
      // cancel the device's own transport state
      if (this.demo.running) {
        this.demo.stop(now);
        for (const tr of this.state.tracks) { tr.muted = false; tr.steps.fill(0); }   // forget the demo's mutes/grid
        this.state.usedMidiTracks = false;
      }
    }
    const st = this.state;
    const wasPlaying = st.playing, pat = st.pattern;
    st.feed(d, now, 'midi');
    // re-read the pattern when it can have changed under us
    if ((d[0] & 0xf0) === 0xc0) this.pcSeen = true;
    if ((st.playing && !wasPlaying) || st.pattern !== pat) this._wantDump();
  }

  // ── pattern over SysEx ──────────────────────────────────────────────
  _wantDump() { if (this.dump) this.dump.want = true; }

  _pollDump(now) {
    const D = this.dump;
    if (!D || !this.dtOut) return;
    if (D.pending) {
      if (now - D.pending > 3000) { D.pending = 0; D.fails++; this._sx = null; D.last = now; }
      return;
    }
    if (D.fails >= 4) return;                       // box doesn't answer — give up quietly
    // a dump is ~28 KB and briefly holds up the clock — while playing, re-read
    // rarely (PLAY / pattern change still trigger an immediate read)
    const every = (this.state.playing ? 5000 : 1500) + D.ms * 3;
    if (!D.want && now - D.last < every) return;
    if (now - D.last < 250) return;
    D.want = false; D.pending = now; D.slot = this.state.pattern;
    try { this.dtOut.send(buildPatternRequest(D.slot)); } catch (_) { D.pending = 0; D.fails++; }
  }

  _sysexIn(d, now) {
    if (d[0] === 0xf0) this._sx = [];
    if (!this._sx) return;
    for (const b of d) this._sx.push(b);
    if (this._sx[this._sx.length - 1] !== 0xf7) return;
    const msg = Uint8Array.from(this._sx);
    this._sx = null;
    const p = parsePatternDump(msg);
    const D = this.dump;
    if (!p || !D) return;
    this.state.lastRealT = now;
    if (p.error) { D.err = p.error; D.fails++; D.pending = 0; D.last = now; return; }
    D.ms = now - (D.pending || now); D.pending = 0; D.last = now; D.fails = 0; D.err = '';
    if (p.slot !== this.state.pattern) { D.want = true; return; }   // stale answer for a pattern we left
    if (!this.realSeen) { this.realSeen = true; this.demoWanted = false; if (this.demo.running) { this.demo.stop(now); for (const tr of this.state.tracks) tr.muted = false; } }
    this.state.setPattern(p, now);
  }

  // ── loop ────────────────────────────────────────────────────────────
  _frame(now) {
    if (!this.mounted) return;
    this._raf = requestAnimationFrame(this._frame);
    const dt = Math.min(now - this._last, 100);
    this._last = now;
    this._fpsAcc += dt; this._fpsN++;
    if (this._fpsAcc > 500) { this.fps = 1000 * this._fpsN / this._fpsAcc; this._fpsAcc = 0; this._fpsN = 0; }

    const st = this.state;
    const realActive = now - st.lastRealT < REAL_GRACE_MS;
    if (this.demoWanted && !this.demo.running) this.demo.start(now);
    if (!this.demoWanted && this.demo.running) this.demo.stop(now);
    this.demo.update(now);
    this._pollDump(now);
    st.update(dt);

    const { ctx, w, h, dpr } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#040506';
    ctx.fillRect(0, 0, w * dpr, h * dpr);
    // vignette-ish backdrop glow that breathes with the kick
    const g = ctx.createRadialGradient(w * dpr / 2, h * dpr * 0.55, 0, w * dpr / 2, h * dpr * 0.55, Math.max(w, h) * dpr * 0.7);
    g.addColorStop(0, `rgba(28,32,40,${0.55 + st.kick * 0.25})`);
    g.addColorStop(1, 'rgba(4,5,6,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w * dpr, h * dpr);

    this.looks[this.lookIdx].draw(ctx, w, h, st, now, dt, dpr);
    this._hud(now, realActive);
  }

  _hud(now, realActive) {
    const st = this.state;
    const look = this.looks[this.lookIdx].name;
    const src = this.demo.running ? (this.w < 600 ? 'DEMO' : 'DEMO (no Digitakt signal)') : (realActive ? (this.realName || 'MIDI') : (this.source || (this.deviceName ? `${this.deviceName} · waiting` : 'waiting for MIDI · X = demo')));
    const bpm = st.bpm > 0 && st.playing ? ` · ${st.bpm.toFixed(0)} BPM` : '';
    const showHelp = now < this.hudUntil;
    const narrow = this.w < 600;
    const D = this.dump;
    const sync = this.demo.running ? '' : !this.midi ? '' : !this.sysex ? ' · no SysEx permission — trigs only from notes'
      : !this.dtOut ? '' : st.seq ? ` · ${st.tracks[st.viewTrack()].name}${st.focusTrack < 0 ? ' (T)' : ''}`
      : D?.fails >= 4 ? ` · pattern not readable${D.err ? ' (' + D.err + ')' : ''} — see I` : ' · reading pattern…';
    const text = `DIGITAKT · ${this.lookIdx + 1}/${LOOKS.length} ${look} · ${src}${bpm} · ${st.patternName()}${sync}` +
      (showHelp ? (narrow ? '\ntap = next look' : '\nL next look · 1–4 pick · T track · [ ] pattern · X demo · I monitor · F fullscreen · Esc exit · tap = next look') : '') +
      (showHelp && this.patternManual && !this.pcSeen ? '\nDigitakt sends no pattern changes: SETTINGS › MIDI CONFIG › SYNC › PROG CH SEND = ON' : '');
    if (text !== this._hudText) { this.hud.textContent = text; this._hudText = text; }
    this.hud.style.opacity = showHelp ? '1' : '0.45';
    if (this.showMonitor) {
      this.mon.style.display = 'block';
      const m = st.monitor.map(l => l.split('​')[0]).join('\n');
      const D = this.dump;
      const sx = !this.sysex ? 'SysEx: no permission' : !this.dtOut ? 'SysEx: no Digitakt output' : st.seq ? `SysEx: ${st.patternName()} ok · ${D.ms.toFixed(0)} ms` : `SysEx: ${D.fails} fails${D.err ? ' · ' + D.err : ''}`;
      const head = `MIDI in: ${(this.inputNames ?? []).join(', ') || '—'} · auto ch ${st.autoChannel} · ${this.fps.toFixed(0)} fps\n${sx}\n`;
      if (m + head !== this._monText) { this.mon.textContent = head + m; this._monText = m + head; }
    } else this.mon.style.display = 'none';
  }

  _key(e) {
    if (!this.mounted || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
    const k = e.key.toLowerCase();
    let used = true;
    if (k === 'l' || e.key === 'ArrowRight') this.setLook(this.lookIdx + 1);
    else if (e.key === 'ArrowLeft') this.setLook(this.lookIdx - 1);
    else if (k >= '1' && k <= String(LOOKS.length)) this.setLook(+k - 1);
    else if (k === 'x') { this.demoWanted = !this.demoWanted; if (this.demoWanted) this.state.seq = null; this.hudUntil = performance.now() + 2500; }
    else if (k === 'i') this.showMonitor = !this.showMonitor;
    else if (e.key === '[' || e.key === ']') {   // pick the pattern by hand when the box doesn't send Program Change
      const s = this.state; s.pattern = (s.pattern + (e.key === ']' ? 1 : 127)) % 128; s.patternFlash = 1; s.seq = null;
      this.patternManual = true; this._wantDump(); this.hudUntil = performance.now() + 4000;
    }
    else if (k === 't') { const s = this.state; s.focusTrack = s.focusTrack >= 7 ? -1 : s.focusTrack + 1; this.hudUntil = performance.now() + 2500; }
    else if (k === 'f') { if (document.fullscreenElement) document.exitFullscreen(); else this.root.requestFullscreen?.(); }
    else if (e.key === 'Escape') this.unmount();
    else if (k === 'd') this.unmount();
    else if (k === 'h') this.hudUntil = performance.now() + 5000;
    else used = false;
    if (used) { e.preventDefault(); e.stopImmediatePropagation(); }
  }

  _resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth; this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }
}

/**
 * The whole hook into the app: D toggles the mode, a #btn-digitakt button
 * (if present) toggles it, ?digitakt[=1..4] opens it on load — before any
 * WebGPU init, so it also runs where WebGPU doesn't (phones).
 */
export function installDigitakt() {
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (/INPUT|TEXTAREA|SELECT/.test(e.target?.tagName ?? '')) return;
    if (e.key.toLowerCase() === 'd' && !instance?.mounted) { e.preventDefault(); mountDigitakt(); }
  });
  document.getElementById('btn-digitakt')?.addEventListener('click', () => toggleDigitakt());
  const q = new URLSearchParams(location.search);
  if (q.has('digitakt')) mountDigitakt({ look: (+q.get('digitakt') || 1) - 1 });
}

/** True while the overlay covers the screen — the main renderer can skip frames. */
export const digitaktActive = () => !!instance?.mounted;
