// ---------------------------------------------------------------------------
// Digitakt state — everything the looks need, fed by raw MIDI bytes.
//
// Kept free of rendering and of Web MIDI: `feed(bytes, t)` is the only entry,
// so the real device, the demo sequencer and the Playwright tests all go
// through exactly the same path.
//
// How the Digitakt talks over USB (manual OS 1.53 §8.4, §15.5, Appendix B;
// checked on Artem's unit 2026-09-17, see ~/code/knobs/devices/digitakt):
//   • notes 0–7 on any channel   → tracks 1–8 (trig keys / external trigs)
//   • channel n (1–16, not AUTO) → track n  (1–8 audio, 9–16 shown as MIDI A–H)
//   • AUTO channel (default 10)  → "the active track"
//   • CC 94 on a track channel   → mute on/off
//   • CC 95                      → track level; other CCs → knob A–H by table
//   • 0xF8 clock (24 ppqn), 0xFA start, 0xFB continue, 0xFC stop
//   • program change             → pattern A01…H16
// ---------------------------------------------------------------------------

export const TRACK_NAMES = [
  'KICK', 'SNARE', 'TOM', 'CLAP', 'COWBELL', 'CL HAT', 'OP HAT', 'CYMBAL',
  'MIDI A', 'MIDI B', 'MIDI C', 'MIDI D', 'MIDI E', 'MIDI F', 'MIDI G', 'MIDI H',
];

// One hue per track — warm low end (kick/snare) to cool top (hats/cymbal);
// MIDI tracks A–H get a paler second ring of the same wheel.
const HUES = [14, 36, 58, 160, 186, 205, 255, 300];
export const TRACK_COLORS = Array.from({ length: 16 }, (_, i) => {
  const h = HUES[i % 8];
  return i < 8 ? `hsl(${h} 95% 60%)` : `hsl(${h} 70% 78%)`;
});
export const TRACK_RGB = Array.from({ length: 16 }, (_, i) => hslToRgb(HUES[i % 8], i < 8 ? 0.95 : 0.7, i < 8 ? 0.6 : 0.78));

// CC → knob letter (0–7 = A–H) and parameter name. Built from the manual's
// Appendix B by page (knobs project, cc-knobs.json). Same CC on different
// pages lands on the same letter, which is all the panel needs.
const CC_KNOB = {
  3: [0, 'NOTE'], 4: [1, 'VEL'], 5: [2, 'LEN'], 7: [7, 'VOL'], 10: [6, 'PAN'],
  13: [4, 'FLTR TRIG'], 14: [5, 'LFO TRIG'], 16: [0, 'TUNE'], 17: [1, 'PLAY'],
  18: [2, 'BIT RED'], 19: [3, 'SAMPLE'], 20: [4, 'SRC E'], 21: [5, 'SRC F'],
  22: [6, 'SRC G'], 23: [7, 'SMPL LEV'], 24: [0, 'PRE-DLY'], 25: [1, 'DECAY'],
  26: [2, 'SHELF F'], 27: [3, 'SHELF G'], 28: [4, 'REV HPF'], 29: [5, 'REV LPF'],
  30: [6, 'REV COMP'], 31: [7, 'REV MIX'], 70: [0, 'ATTACK'], 71: [1, 'DECAY'],
  72: [2, 'SUSTAIN'], 73: [3, 'RELEASE'], 74: [4, 'FREQ'], 75: [5, 'RESO'],
  76: [6, 'TYPE'], 77: [7, 'ENV DEP'], 78: [0, 'AMP ATK'], 79: [1, 'HOLD'],
  80: [2, 'AMP DEC'], 81: [3, 'OVERDRV'], 82: [4, 'DELAY'], 83: [5, 'REVERB'],
  84: [2, 'BASE'], 85: [3, 'WIDTH'], 86: [0, 'ENV DLY'], 87: [1, 'SRR'],
  88: [4, 'SRR RT'], 89: [4, 'DLY HPF'], 90: [5, 'DLY LPF'], 91: [6, 'REV SEND'],
  92: [7, 'DLY MIX'], 102: [0, 'LFO SPD'], 103: [1, 'LFO MULT'], 104: [2, 'LFO FADE'],
  105: [3, 'LFO DEST'], 106: [4, 'LFO WAVE'], 107: [5, 'LFO PHASE'], 108: [6, 'LFO MODE'],
  109: [7, 'LFO DEPTH'], 111: [5, 'THRESH'], 112: [0, 'LFO2 SPD'], 113: [1, 'LFO2 MLT'],
  114: [2, 'LFO2 FADE'], 115: [3, 'LFO2 DEST'], 116: [4, 'LFO2 WAVE'], 117: [5, 'LFO2 PH'],
  118: [6, 'LFO2 MODE'], 119: [7, 'LFO2 DEP'],
};
export const CC_MUTE  = 94;
export const CC_LEVEL = 95;

const HIT_RING = 256;          // recent hits kept for the looks
const MONITOR_LINES = 14;

export class DTState {
  constructor({ autoChannel = 10 } = {}) {
    this.autoChannel = autoChannel;        // 1-based, like the Digitakt menu
    this.tracks = Array.from({ length: 16 }, (_, i) => ({
      name: TRACK_NAMES[i],
      flash: 0,          // 0..1, set on note-on, decays in update()
      vel: 0,            // last velocity 0..1
      gate: 0,           // held notes
      muted: false,
      mute: 0,           // smoothed 0 (open) .. 1 (muted)
      level: 100 / 127,
      lastHit: -1e9,
      hits: 0,
      steps: new Float32Array(16),   // learned trig mask over the last bars
      mod: 0.5, modShown: 0.5, modTouch: 0,   // last knob value turned on this track
    }));
    this.activeTrack = 0;
    this.usedMidiTracks = false;     // any traffic on tracks 9–16 → show them

    // Knobs A–H: value 0..1, smoothed angle value, touch glow
    this.knobs = Array.from({ length: 8 }, () => ({ value: 0.5, shown: 0.5, touch: 0, name: '', track: 0 }));
    this.levelKnob = { value: 100 / 127, shown: 100 / 127, touch: 0 };
    this.lastParam = '';

    // Transport / clock
    this.playing = false;
    this.clocks = 0;             // clock ticks since start (24 ppqn)
    this.lastClockT = 0;
    this.clockIntervals = [];
    this.bpm = 0;                // 0 = unknown
    this.hasClock = false;
    this.transportFlash = 0;     // play/stop button flash
    this.stopFlash = 0;
    this.pattern = 0;            // 0..127 → A01..H16
    this.patternFlash = 0;

    // Pattern read from the box over SysEx (see sysex.js). When present the
    // trigs are played back from MIDI clock — the Digitakt itself never
    // sends its audio-track sequencer as notes.
    this.seq = null;             // { slot, tracks:[{trigs,vel,len}], length, at }
    this.focusTrack = -1;        // track whose trigs the keys show; -1 = auto
    this.stepFlash = new Float32Array(16);   // per trig-key flash in step view
    this.stepTrack = new Uint8Array(16);     // which track lit that key last
    this.seqStep = -1;           // absolute 16th since PLAY (sequencer view)

    this.hits = [];              // ring of {id, track, vel, note, t, step, off}
    this.hitSeq = 0;
    this.monitor = [];           // human-readable recent messages
    this.lastRealT = -1e9;       // last message from a real device
    this.energy = 0;             // smoothed hit density 0..1
    this.kick = 0;               // kick-ish envelope (track 1)
  }

  // ── derived timing ────────────────────────────────────────────────────
  /** Continuous 16th-step position (fractional), or -1 when stopped. */
  stepPos(now) {
    if (!this.playing || !this.hasClock) return -1;
    const tickMs = this.bpm > 0 ? 60000 / (this.bpm * 24) : 20;
    const extra = Math.min((now - this.lastClockT) / tickMs, 1);   // interpolate between ticks
    return (this.clocks + extra) / 6;
  }
  step(now) { const p = this.stepPos(now); return p < 0 ? -1 : Math.floor(p) % 16; }

  patternName() {
    const p = this.pattern;
    return 'ABCDEFGH'[(p >> 4) & 7] + String((p & 15) + 1).padStart(2, '0');
  }

  // ── MIDI in ───────────────────────────────────────────────────────────
  feed(data, t, source = 'midi') {
    const status = data[0];
    if (source !== 'demo') this.lastRealT = t;

    if (status >= 0xf8) { this._realtime(status, t); return; }
    const type = status & 0xf0;
    const ch = (status & 0x0f) + 1;
    const d1 = data[1] ?? 0, d2 = data[2] ?? 0;

    if (type === 0x90 && d2 > 0) { if ((ch - 1) >= 8 && ch !== this.autoChannel) this.usedMidiNotes = true; this._noteOn(d1, d2, ch, t); }
    else if (type === 0x80 || type === 0x90) this._noteOff(d1, ch);
    else if (type === 0xb0) this._cc(d1, d2, ch, t);
    else if (type === 0xc0) {
      this.pattern = d1; this.patternFlash = 1;
      this._log(t, `PATTERN → ${this.patternName()}`);
    }
  }

  trackFor(note, ch) {
    if (note >= 0 && note <= 7) return note;
    if (ch === this.autoChannel) return this.activeTrack;
    return ch - 1;
  }

  _noteOn(note, vel, ch, t) {
    const i = this.trackFor(note, ch);
    if (i >= 8) this.usedMidiTracks = true;
    this._hit(i, vel / 127, note, t, this.step(t));
    this._log(t, `${this.tracks[i].name.padEnd(7)} note ${note} vel ${vel} · ch ${ch}`);
  }

  _hit(i, v, note, t, step) {
    const tr = this.tracks[i];
    tr.flash = Math.max(tr.flash, 0.35 + 0.65 * v);
    tr.vel = v;
    tr.gate++;
    tr.lastHit = t;
    tr.hits++;
    if (step >= 0) {
      if (!this.seq) tr.steps[step] = 1;
      const k = step % 16;
      if (i === this.viewTrack() || !this.seq) { this.stepFlash[k] = Math.max(this.stepFlash[k], 0.35 + 0.65 * v); this.stepTrack[k] = i; }
    }
    this.energy = Math.min(1, this.energy + 0.08 + 0.1 * v);
    if (i === 0) this.kick = Math.max(this.kick, 0.5 + 0.5 * v);
    this.hits.push({ id: ++this.hitSeq, track: i, vel: v, note, t, step, off: 0 });
    if (this.hits.length > HIT_RING) this.hits.shift();
  }

  // ── pattern from SysEx ────────────────────────────────────────────────
  setPattern(p, t) {
    const first = !this.seq;
    this.seq = { ...p, at: t };
    // MIDI tracks A–H that hold trigs → show the second row of tracks
    if (p.tracks.slice(8).some(tr => tr.count)) this.usedMidiTracks = true;
    for (let i = 0; i < 16; i++) {
      const tr = this.tracks[i], pt = p.tracks[i];
      for (let s = 0; s < 16; s++) tr.steps[s] = 0;
      for (let s = 0; s < pt.len; s++) if (pt.trigs[s]) tr.steps[s % 16] = 1;
    }
    if (first) this._log(t, `PATTERN ${this.patternName()} read · ${p.tracks.reduce((a, tr) => a + tr.count, 0)} trigs`);
  }

  /** Track the trig keys show in step view: picked (T), last knob-touched, or first with trigs. */
  viewTrack() {
    if (this.focusTrack >= 0) return this.focusTrack;
    if (this.activeKnown) return this.activeTrack;
    if (!this.seq) return this.hits.length ? this.hits[this.hits.length - 1].track : 0;
    for (let i = 0; i < 8; i++) if (this.seq.tracks[i].count) return i;   // first track with trigs
    return 0;
  }

  /** Page (0..3) of the viewed track currently under the playhead. */
  viewPage(now) {
    const pos = this.stepPos(now);
    if (!this.seq || pos < 0) return pos < 0 ? -1 : Math.floor(pos / 16) % 4;
    const len = this.seq.tracks[this.viewTrack()].len;
    return Math.floor((Math.floor(pos) % len) / 16);
  }

  /** Is there a trig on key k (0..15) of the viewed track's current page? */
  trigOnKey(k, now) {
    if (!this.seq) return this.tracks[this.viewTrack()].steps[k];
    const pt = this.seq.tracks[this.viewTrack()];
    const s = Math.max(0, this.viewPage(now)) * 16 + k;
    return s < pt.len && pt.trigs[s] ? 1 : 0;
  }

  /** Key (0..15) the playhead is on for the viewed track, or -1. */
  playKey(now) {
    const pos = this.stepPos(now);
    if (pos < 0) return -1;
    const len = this.seq ? this.seq.tracks[this.viewTrack()].len : 16;
    return (Math.floor(pos) % len) % 16;
  }

  _seqFire(abs, t) {
    const seq = this.seq;
    if (!seq) return;
    this.seqStep = abs;
    for (let i = 0; i < 16; i++) {
      // MIDI tracks A–H send their own notes on their channel — don't double them
      if (i >= 8 && this.usedMidiNotes) continue;
      const pt = seq.tracks[i];
      if (!pt.count) continue;
      const s = abs % pt.len;
      if (!pt.trigs[s] || this.tracks[i].muted) continue;
      this._hit(i, pt.vel[s], -1, t, s);
    }
  }

  _noteOff(note, ch) {
    const i = this.trackFor(note, ch);
    const tr = this.tracks[i];
    tr.gate = Math.max(0, tr.gate - 1);
    for (let k = this.hits.length - 1; k >= 0; k--) {
      const h = this.hits[k];
      if (h.track === i && h.note === note && !h.off) { h.off = performance.now(); break; }
    }
  }

  _cc(cc, val, ch, t) {
    const i = ch === this.autoChannel ? this.activeTrack : ch - 1;
    const v = val / 127;
    if (cc === CC_MUTE) {
      this.tracks[i].muted = val > 0;
      this._log(t, `${this.tracks[i].name} ${val > 0 ? 'MUTED' : 'unmuted'} · ch ${ch}`);
      return;
    }
    if (cc === CC_LEVEL) {
      this.tracks[i].level = v;
      this.levelKnob.value = v; this.levelKnob.touch = 1;
      this.lastParam = `${this.tracks[i].name} LEVEL ${val}`;
      return;
    }
    // knobs always act on the active track, so a CC on a track channel
    // tells us which one that is (TRK + TRIG itself sends nothing)
    if (ch !== this.autoChannel) { this.activeTrack = i; this.activeKnown = true; }
    const k = CC_KNOB[cc];
    if (k) {
      const knob = this.knobs[k[0]];
      knob.value = v; knob.touch = 1; knob.name = k[1]; knob.track = i;
      this.tracks[i].mod = v; this.tracks[i].modTouch = 1;
      this.lastParam = `${this.tracks[i].name} ${k[1]} ${val}`;
    } else {
      this.lastParam = `CC${cc} ${val}`;
    }
    if (this.monitor.length === 0 || !this.monitor[0].endsWith(`cc${cc}`)) this._log(t, `${this.lastParam} · ch ${ch}`, `cc${cc}`);
  }

  _realtime(status, t) {
    if (status === 0xf8) {
      if (this.lastClockT) {
        const dt = t - this.lastClockT;
        if (dt > 2 && dt < 200) {
          this.clockIntervals.push(dt);
          if (this.clockIntervals.length > 48) this.clockIntervals.shift();
          // median, not mean: USB delivers clock in bursts (worse while a SysEx
          // dump is on the wire), and one late tick shouldn't swing the tempo
          const srt = [...this.clockIntervals].sort((a, b) => a - b);
          const med = srt[srt.length >> 1];
          const ok = srt.filter(x => Math.abs(x - med) < med * 0.5);
          this.bpm = 60000 / ((ok.reduce((a, b) => a + b, 0) / ok.length) * 24);
        }
      }
      this.lastClockT = t;
      this.hasClock = true;
      if (this.playing) {
        // first clock after START is step 1 → fire steps on clocks 0, 6, 12…
        if (this.clocks % 6 === 0) this._seqFire(this.clocks / 6, t);
        this.clocks++;
        // new bar → let the learned trig masks forget slowly (no pattern read)
        if (!this.seq && this.clocks % 96 === 0) for (const tr of this.tracks) for (let s = 0; s < 16; s++) tr.steps[s] *= 0.55;
      }
    } else if (status === 0xfa) {
      this.playing = true; this.clocks = 0; this.transportFlash = 1;
      this._log(t, 'PLAY');
    } else if (status === 0xfb) {
      this.playing = true; this.transportFlash = 1;
      this._log(t, 'CONTINUE');
    } else if (status === 0xfc) {
      this.playing = false; this.stopFlash = 1;
      this._log(t, 'STOP');
    }
  }

  _log(t, line, tag = '') {
    this.monitor.unshift(`${(t / 1000).toFixed(2).padStart(8)}  ${line}${tag ? '​' + tag : ''}`);
    if (this.monitor.length > MONITOR_LINES) this.monitor.pop();
  }

  // ── per-frame decay ───────────────────────────────────────────────────
  update(dtMs) {
    const f = (ms) => Math.exp(-dtMs / ms);
    for (const tr of this.tracks) {
      tr.flash *= f(tr.gate > 0 ? 420 : 170);
      tr.mute += ((tr.muted ? 1 : 0) - tr.mute) * (1 - f(90));
      tr.modShown += (tr.mod - tr.modShown) * (1 - f(60));
      tr.modTouch *= f(1200);
    }
    for (const k of this.knobs) {
      k.shown += (k.value - k.shown) * (1 - f(45));
      k.touch *= f(900);
    }
    this.levelKnob.shown += (this.levelKnob.value - this.levelKnob.shown) * (1 - f(45));
    this.levelKnob.touch *= f(900);
    for (let k = 0; k < 16; k++) this.stepFlash[k] *= f(180);
    this.transportFlash *= f(500);
    this.stopFlash *= f(500);
    this.patternFlash *= f(700);
    this.energy *= f(900);
    this.kick *= f(140);
  }

  /** Visible tracks: 8 audio, plus MIDI A–H once they show up. */
  get trackCount() { return this.usedMidiTracks ? 16 : 8; }
}

function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)].map(x => Math.round(x * 255));
}
