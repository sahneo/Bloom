// Synthetic test tracks with exact ground truth for the analysis bench.
// Every hit, bass note, melody note, chord, key, tempo and section boundary is
// known by construction, so detector output can be scored instead of eyeballed.
//
// Deterministic (seeded noise) — the same track renders bit-identically every run.

export const SR = 48000;

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 * 2 - 1; };
}

// ── Instruments (additive into a Float32Array) ─────────────────────────────

function kick(buf, t0, gain = 0.9) {
  const i0 = Math.round(t0 * SR), n = Math.round(0.38 * SR);
  let ph = 0;
  for (let i = 0; i < n && i0 + i < buf.length; i++) {
    const t = i / SR;
    const f = 45 + 110 * Math.exp(-t / 0.035);
    ph += 2 * Math.PI * f / SR;
    const env = Math.exp(-t / 0.16);
    const click = i < 96 ? (1 - i / 96) * 0.35 : 0;
    buf[i0 + i] += gain * (Math.sin(ph) * env + click * Math.sin(ph * 7));
  }
}

function snare(buf, t0, rnd, gain = 0.55) {
  const i0 = Math.round(t0 * SR), n = Math.round(0.22 * SR);
  let lp = 0, prev = 0;
  for (let i = 0; i < n && i0 + i < buf.length; i++) {
    const t = i / SR;
    const w = rnd();
    lp += (w - lp) * 0.55;                  // mild lowpass
    const hp = lp - prev; prev = lp;        // then highpass → 2–8 kHz-ish noise
    const noise = hp * 2.2 * Math.exp(-t / 0.07);
    const body = Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t / 0.05) * 0.5;
    buf[i0 + i] += gain * (noise + body);
  }
}

function hat(buf, t0, rnd, gain = 0.22, open = false) {
  const i0 = Math.round(t0 * SR), n = Math.round((open ? 0.18 : 0.05) * SR);
  let p1 = 0, p2 = 0;
  for (let i = 0; i < n && i0 + i < buf.length; i++) {
    const t = i / SR;
    const w = rnd();
    const hp = w - 2 * p1 + p2; p2 = p1; p1 = w;   // 2nd-difference → strong HF tilt
    buf[i0 + i] += gain * 0.5 * hp * Math.exp(-t / (open ? 0.06 : 0.014));
  }
}

// Band-limited-ish saw through a one-pole lowpass, amp envelope
function tone(buf, t0, dur, midi, { gain = 0.3, harm = 12, tilt = 1, lpHz = 0, attack = 0.005, release = 0.03, vib = 0 } = {}) {
  const i0 = Math.round(t0 * SR), n = Math.round((dur + release) * SR);
  const f = midiHz(midi);
  const H = Math.max(1, Math.min(harm, Math.floor(16000 / f)));
  const a = lpHz ? 1 - Math.exp(-2 * Math.PI * lpHz / SR) : 1;
  let lp = 0, ph = 0;
  for (let i = 0; i < n && i0 + i < buf.length; i++) {
    const t = i / SR;
    ph += 2 * Math.PI * f * (1 + vib * Math.sin(2 * Math.PI * 5.5 * t)) / SR;
    let s = 0;
    for (let h = 1; h <= H; h++) s += Math.sin(ph * h) / Math.pow(h, tilt);
    let env = Math.min(1, t / attack);
    if (t > dur) env *= Math.max(0, 1 - (t - dur) / release);
    lp += (s - lp) * a;
    buf[i0 + i] += gain * env * lp;
  }
}

function riser(buf, t0, dur, rnd, gain = 0.25) {
  const i0 = Math.round(t0 * SR), n = Math.round(dur * SR);
  let p = 0;
  for (let i = 0; i < n && i0 + i < buf.length; i++) {
    const x = i / n;
    const w = rnd(); const hp = w - p; p = w;
    buf[i0 + i] += gain * x * x * hp;
  }
}

// ── Track scores ───────────────────────────────────────────────────────────
// Patterns in 16th-note steps (16 per 4/4 bar).
const NOTE = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };

const CHORDS = {   // pitch classes (root first) + quality
  Am: [9, 0, 4], F: [5, 9, 0], C: [0, 4, 7], G: [7, 11, 2], Dm: [2, 5, 9], Bb: [10, 2, 5],
  Em: [4, 7, 11], B: [11, 3, 6], E: [4, 8, 11], Bm: [11, 2, 6], D: [2, 6, 9],
};

const TRACKS = [
  {
    name: 'house_Am_124', key: { root: NOTE.A, minor: true },
    tempo: [{ bar: 0, bpm: 124 }], bars: 32,
    sections: [
      { from: 0, to: 8, type: 'intro', kick: 1, hat: 1, bass: 1, chords: 0, mel: 0, snare: 1 },
      { from: 8, to: 16, type: 'main', kick: 1, hat: 1, bass: 1, chords: 1, mel: 1, snare: 1 },
      { from: 16, to: 24, type: 'breakdown', kick: 0, hat: 0, bass: 0, chords: 1, mel: 1, snare: 0, riser: [20, 24] },
      { from: 24, to: 32, type: 'drop', kick: 1, hat: 1, bass: 1, chords: 1, mel: 1, snare: 1 },
    ],
    kick: [0, 4, 8, 12], snare: [4, 12], hat: [2, 6, 10, 14], hatClosed: [0, 4, 8, 12],
    chords: ['Am', 'F', 'C', 'G'],
    bassRhythm: [2, 6, 10, 14], bassOct: 2,            // offbeat house bass, A2=45
    mel: [ // [step, lenSteps, midi] over a 4-bar phrase (64 steps), A minor
      [0, 4, 76], [4, 2, 74], [6, 2, 72], [8, 6, 69], [16, 4, 72], [20, 4, 74], [24, 8, 76],
      [32, 4, 77], [36, 4, 76], [40, 4, 74], [44, 4, 72], [48, 6, 71], [56, 8, 69],
    ],
  },
  {
    name: 'pop_C_100to128', key: { root: NOTE.C, minor: false },
    tempo: [{ bar: 0, bpm: 100 }, { bar: 12, bpm: 128 }], bars: 28,
    sections: [
      { from: 0, to: 12, type: 'verse', kick: 1, hat: 1, bass: 1, chords: 1, mel: 1, snare: 1 },
      { from: 12, to: 28, type: 'chorus', kick: 1, hat: 1, bass: 1, chords: 1, mel: 1, snare: 1 },
    ],
    kick: [0, 4, 8, 12], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], hatClosed: [],
    chords: ['C', 'G', 'Am', 'F'],
    bassRhythm: [0, 3, 6, 8, 11, 14], bassOct: 2,
    mel: [
      [0, 2, 72], [2, 2, 74], [4, 4, 76], [8, 4, 79], [12, 4, 76], [16, 4, 74], [20, 4, 71], [24, 8, 74],
      [32, 4, 72], [36, 4, 76], [40, 4, 81], [44, 4, 79], [48, 8, 77], [56, 8, 76],
    ],
  },
  {
    name: 'dnb_Em_172', key: { root: NOTE.E, minor: true },
    tempo: [{ bar: 0, bpm: 172 }], bars: 32,
    sections: [
      { from: 0, to: 16, type: 'main', kick: 1, hat: 1, bass: 1, chords: 1, mel: 1, snare: 1 },
      { from: 16, to: 24, type: 'breakdown', kick: 0, hat: 0, bass: 0, chords: 1, mel: 1, snare: 0, riser: [20, 24] },
      { from: 24, to: 32, type: 'drop', kick: 1, hat: 1, bass: 1, chords: 1, mel: 1, snare: 1 },
    ],
    kick: [0, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], hatClosed: [],
    chords: ['Em', 'Am', 'Em', 'B'],
    bassRhythm: [0, 10], bassLen: 6, bassOct: 1,      // long sub notes, E1=28
    mel: [
      [0, 8, 71], [8, 8, 67], [16, 8, 69], [24, 8, 72], [32, 8, 71], [40, 8, 67], [48, 8, 66], [56, 8, 64],
    ],
  },
  {
    name: 'hiphop_F_90', key: { root: NOTE.F, minor: false },
    tempo: [{ bar: 0, bpm: 90 }], bars: 16,
    sections: [
      { from: 0, to: 16, type: 'main', kick: 1, hat: 1, bass: 1, chords: 1, mel: 1, snare: 1 },
    ],
    kick: [0, 7, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], hatClosed: [],
    chords: ['F', 'Dm', 'Bb', 'C'],
    bassRhythm: [0, 7, 10], bassLen: 3, bassOct: 2,
    mel: [
      [0, 4, 77], [6, 2, 76], [8, 8, 72], [16, 4, 74], [22, 2, 72], [24, 8, 69],
      [32, 4, 70], [36, 4, 72], [40, 8, 74], [48, 4, 72], [52, 4, 69], [56, 8, 65],
    ],
  },
];

export const TRACK_NAMES = TRACKS.map(t => t.name);

// Bar → start time (s), supporting tempo changes at bar boundaries
function barTimes(tr) {
  const times = [0];
  for (let b = 0; b < tr.bars; b++) {
    let bpm = tr.tempo[0].bpm;
    for (const s of tr.tempo) if (b >= s.bar) bpm = s.bpm;
    times.push(times[b] + 4 * 60 / bpm);
  }
  return times;
}

function pcToMidi(pc, oct) { return (oct + 1) * 12 + pc; }

export function renderTrack(name) {
  const tr = TRACKS.find(t => t.name === name);
  const bt = barTimes(tr);
  const dur = bt[tr.bars] + 0.5;
  const buf = new Float32Array(Math.ceil(dur * SR));
  const rnd = rng(1234 + name.length);
  const truth = {
    name, duration: dur, key: tr.key, kick: [], snare: [], hat: [], bass: [], mel: [], chords: [],
    beats: [], tempo: [], sections: [], drops: [], breakdowns: [],
  };

  for (const s of tr.sections) {
    truth.sections.push({ t: bt[s.from], type: s.type });
    if (s.type === 'breakdown') truth.breakdowns.push([bt[s.from], bt[s.to]]);
    if (s.type === 'drop') truth.drops.push(bt[s.from]);
  }

  for (let b = 0; b < tr.bars; b++) {
    const t0 = bt[b], barDur = bt[b + 1] - bt[b], step = barDur / 16;
    const sec = tr.sections.find(s => b >= s.from && b < s.to);
    for (let q = 0; q < 4; q++) truth.beats.push({ t: t0 + q * barDur / 4, bar: b, beat: q });
    truth.tempo.push({ t: t0, bpm: 240 / barDur });

    const chordName = tr.chords[b % tr.chords.length];
    const ch = CHORDS[chordName];
    truth.chords.push({ t: t0, end: t0 + barDur, name: chordName, pcs: ch });

    if (sec.kick) for (const s of tr.kick) { kick(buf, t0 + s * step); truth.kick.push(t0 + s * step); }
    if (sec.snare) for (const s of tr.snare) { snare(buf, t0 + s * step, rnd); truth.snare.push(t0 + s * step); }
    if (sec.hat) {
      for (const s of tr.hat) { hat(buf, t0 + s * step, rnd, 0.22, tr.hatClosed.length > 0); truth.hat.push(t0 + s * step); }
      for (const s of tr.hatClosed) { hat(buf, t0 + s * step, rnd, 0.12); truth.hat.push(t0 + s * step); }
    }
    if (sec.chords) {
      for (const pc of ch) {
        const m = pcToMidi(pc, 4) - (pc > 7 ? 12 : 0);   // voiced around C4..G4
        tone(buf, t0, barDur - 0.02, m, { gain: 0.06, harm: 10, tilt: 1.3, lpHz: 2500, attack: 0.08, release: 0.15 });
      }
    }
    if (sec.bass) {
      const root = ch[0];
      const m = pcToMidi(root, tr.bassOct);
      const len = (tr.bassLen ?? 1.6) * step;
      for (const s of tr.bassRhythm) {
        const ts = t0 + s * step;
        tone(buf, ts, len, m, { gain: 0.32, harm: 8, tilt: 1.6, lpHz: 500, attack: 0.004, release: 0.02 });
        truth.bass.push({ t: ts, end: ts + len, midi: m });
      }
    }
    if (sec.mel) {
      const phraseBar = b % 4;
      for (const [s, len, m] of tr.mel) {
        if (Math.floor(s / 16) !== phraseBar) continue;
        const ts = t0 + (s % 16) * step, d = len * step * 0.9;
        tone(buf, ts, d, m, { gain: 0.13, harm: 6, tilt: 1.0, lpHz: 6000, attack: 0.01, release: 0.05, vib: 0.002 });
        truth.mel.push({ t: ts, end: ts + d, midi: m });
      }
    }
    if (sec.riser && b === sec.riser[0]) riser(buf, t0, bt[sec.riser[1]] - t0, rnd);
  }

  // Normalize to −1 dBFS peak
  let peak = 0;
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
  const g = 0.89 / peak;
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
  return { samples: buf, truth };
}
