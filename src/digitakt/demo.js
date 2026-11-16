// ---------------------------------------------------------------------------
// Demo sequencer — a believable Digitakt MIDI stream with no device attached.
//
// Emits raw MIDI bytes (clock, start/stop, notes, CC, mutes, program change)
// in the same shape the real box sends over USB, so the looks can't tell the
// difference. Clock-driven: `update(now)` emits every 24-ppqn tick that is
// due, and the drum events land exactly on those ticks.
// ---------------------------------------------------------------------------

const PPQN = 24, TICKS_PER_STEP = 6;

// 16-step patterns per track (velocity 0..127, 0 = no trig). Two variations
// so the bar-to-bar picture keeps moving.
const PATTERNS = [
  {
    0: [120, 0, 0, 0, 118, 0, 0, 0, 120, 0, 0, 0, 118, 0, 0, 64],            // kick
    1: [0, 0, 0, 0, 110, 0, 0, 0, 0, 0, 0, 0, 112, 0, 0, 0],                  // snare
    3: [0, 0, 0, 0, 96, 0, 0, 0, 0, 0, 0, 0, 100, 0, 30, 0],                  // clap
    5: [70, 0, 96, 40, 70, 0, 100, 40, 70, 0, 96, 40, 70, 0, 100, 52],        // closed hat
    6: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    4: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 80, 0, 0, 0, 0],                     // cowbell
  },
  {
    0: [120, 0, 0, 0, 118, 0, 0, 52, 120, 0, 0, 0, 118, 0, 0, 0],
    1: [0, 0, 0, 0, 110, 0, 0, 28, 0, 0, 34, 0, 112, 0, 0, 0],
    3: [0, 0, 0, 0, 96, 0, 0, 0, 0, 0, 0, 0, 100, 0, 0, 0],
    5: [70, 30, 0, 40, 70, 30, 0, 40, 70, 30, 0, 40, 70, 30, 0, 52],
    6: [0, 0, 96, 0, 0, 0, 96, 0, 0, 0, 96, 0, 0, 0, 96, 0],                   // open hat on the offbeat
    7: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
];
const FILL = {   // last bar of every 8: toms walk down, snare rolls
  2: [0, 0, 0, 0, 0, 0, 0, 0, 100, 0, 90, 0, 84, 0, 110, 0],
  1: [0, 0, 0, 0, 110, 0, 0, 0, 60, 70, 80, 90, 100, 110, 120, 127],
  7: [127, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
};
// MIDI track A (ch 9): a little bass line, note + gate length in steps
const BASS = [[36, 2], 0, 0, [36, 1], 0, 0, [39, 2], 0, [36, 1], 0, [43, 2], 0, 0, [41, 1], [39, 1], 0];
const NOTE = 60;   // audio-track trigs: the Digitakt sends its NOTE param (C4 default)

// Knob gestures the demo "performs": [cc, channel, from, to, bars]
const GESTURES = [
  [74, 1, 40, 118, 2],    // kick filter opens
  [75, 6, 20, 100, 1],    // hat resonance
  [16, 2, 64, 90, 1],     // snare tune up
  [83, 4, 0, 110, 2],     // clap reverb send
  [81, 1, 0, 90, 1],      // kick overdrive
  [102, 6, 30, 100, 2],   // hat LFO speed
  [87, 5, 0, 70, 1],      // cowbell SRR
  [74, 9, 30, 120, 2],    // bass filter
];

export class DemoSequencer {
  constructor(emit, { bpm = 122 } = {}) {
    this.emit = emit;            // (Uint8Array-like bytes, timeMs) => void
    this.bpm = bpm;
    this.running = false;
    this.nextTickT = 0;
    this.tick = 0;
    this.noteOffs = [];          // [tick, bytes]
    this.gesture = null;
    this.rand = mulberry(7);
  }

  start(now) {
    this.running = true;
    this.tick = 0;
    this.nextTickT = now + 30;
    this.emit([0xc0, 0], now);
    this.emit([0xfa], now);
  }

  stop(now) {
    if (!this.running) return;
    this.running = false;
    for (const [, b] of this.noteOffs) this.emit(b, now);
    this.noteOffs = [];
    this.emit([0xfc], now);
  }

  update(now) {
    if (!this.running) return;
    const tickMs = 60000 / (this.bpm * PPQN);
    if (now - this.nextTickT > 500) this.nextTickT = now;   // tab was hidden — don't burst
    while (this.nextTickT <= now) {
      this._tick(this.nextTickT);
      this.nextTickT += tickMs;
    }
  }

  _tick(t) {
    const tick = this.tick++;
    this.emit([0xf8], t);

    for (let i = this.noteOffs.length - 1; i >= 0; i--) {
      if (this.noteOffs[i][0] <= tick) { this.emit(this.noteOffs[i][1], t); this.noteOffs.splice(i, 1); }
    }

    // swing: odd 16ths land one tick late
    const stepTick = tick % TICKS_PER_STEP;
    const absStep = Math.floor(tick / TICKS_PER_STEP);
    const step = absStep % 16, bar = Math.floor(absStep / 16);
    const swing = step % 2 === 1 ? 1 : 0;

    if (stepTick === 0) this._bar(bar, step, t, tick);
    if (stepTick === swing) this._step(bar, step, t, tick);
    this._knob(tick, t);
  }

  _bar(bar, step, t) {
    if (step !== 0) return;
    // every 8 bars: next pattern; bars 4–5 of 8: mute hats for the "drop"
    if (bar > 0 && bar % 8 === 0) this.emit([0xc0, (bar / 8) % 4], t);
    if (bar % 8 === 4) this.emit([0xb0 | 5, 94, 127], t);
    if (bar % 8 === 6) this.emit([0xb0 | 5, 94, 0], t);
    if (bar % 16 === 12) this.emit([0xb0 | 0, 94, 127], t);   // kick out for a bar
    if (bar % 16 === 13) this.emit([0xb0 | 0, 94, 0], t);
    if (bar % 2 === 0 && !this.gesture) {
      const g = GESTURES[(bar / 2) % GESTURES.length];
      this.gesture = { cc: g[0], ch: g[1], from: g[2], to: g[3], startTick: this.tick, len: g[4] * 96, last: -1 };
    }
  }

  _step(bar, step, t, tick) {
    const pat = PATTERNS[Math.floor(bar / 4) % 2];
    const fill = bar % 8 === 7 && step >= 8;
    for (let tr = 0; tr < 8; tr++) {
      let v = (fill && FILL[tr]) ? FILL[tr][step] : (pat[tr]?.[step] ?? 0);
      if (tr === 5 && v && this.rand() < 0.12) v = 0;                 // humanised hats
      if (tr === 2 && !fill && step === 15 && bar % 4 === 3) v = 90;  // tom pickup
      if (!v) continue;
      v = Math.max(1, Math.min(127, Math.round(v * (0.9 + this.rand() * 0.2))));
      this.emit([0x90 | tr, NOTE, v], t);
      this.noteOffs.push([tick + (tr === 6 ? 9 : 3), [0x80 | tr, NOTE, 0]]);
    }
    const b = BASS[step];
    if (b && bar % 8 !== 7) {
      const note = b[0] + (Math.floor(bar / 2) % 2 ? 5 : 0);
      this.emit([0x98, note, 96 + Math.floor(this.rand() * 24)], t);
      this.noteOffs.push([tick + b[1] * TICKS_PER_STEP - 1, [0x88, note, 0]]);
    }
  }

  _knob(tick, t) {
    const g = this.gesture;
    if (!g || tick % 2) return;
    const p = (tick - g.startTick) / g.len;
    if (p >= 1) { this.gesture = null; return; }
    const shape = 0.5 - 0.5 * Math.cos(p * Math.PI * 2);   // there and back
    const val = Math.round(g.from + (g.to - g.from) * shape);
    if (val !== g.last) { this.emit([0xb0 | (g.ch - 1), g.cc, val], t); g.last = val; }
  }
}

function mulberry(a) {
  return () => {
    a |= 0; a = a + 0x6d2b79f5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
