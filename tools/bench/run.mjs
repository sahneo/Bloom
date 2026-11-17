#!/usr/bin/env node
// Bloom analysis bench — scores src/ analysis against synthetic ground truth.
//
//   node tools/bench/run.mjs                 # current working tree (src/)
//   node tools/bench/run.mjs --ref master    # a git ref (extracted to .cache)
//   node tools/bench/run.mjs --json out.json
//
// What a visual "sees" is what gets scored: band envelopes crossing 0.5 count
// as hits, bass/melody notes are whatever the pipeline exposes (or the best a
// preset could derive from the old outputs when no detector exists).
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { renderTrack, TRACK_NAMES, SR } from './synth.mjs';
import { loadPipeline, runTrack } from './sim.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ref = opt('--ref', null);
const only = opt('--track', null);
const jsonOut = opt('--json', null);

let srcDir = 'src', workletPath = 'public/onset-worklet.js';
if (ref) {
  const dir = join('tools/bench/.cache/ref-' + ref.replace(/\W/g, '_'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (const f of ['audio.js', 'beat.js', 'harmony.js', 'structure.js', 'pitch.js']) {
    try { writeFileSync(join(dir, 'src', f), execSync(`git show ${ref}:src/${f}`, { stdio: ['ignore', 'pipe', 'ignore'] })); } catch {}
  }
  writeFileSync(join(dir, 'onset-worklet.js'), execSync(`git show ${ref}:public/onset-worklet.js`));
  srcDir = join(dir, 'src'); workletPath = join(dir, 'onset-worklet.js');
}

const pipeline = await loadPipeline(srcDir, workletPath);

// ── helpers ───────────────────────────────────────────────────────────────
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const hzMidi = (hz) => 69 + 12 * Math.log2(hz / 440);
const pc = (m) => ((Math.round(m) % 12) + 12) % 12;

function onsetF1(det, ref, lo = -0.03, hi = 0.07) {
  const used = new Uint8Array(det.length); let tp = 0; const lat = [];
  for (const r of ref) {
    let best = -1, bd = 1e9;
    for (let i = 0; i < det.length; i++) {
      if (used[i]) continue;
      const d = det[i] - r;
      if (d >= lo && d <= hi && Math.abs(d) < bd) { bd = Math.abs(d); best = i; }
    }
    if (best >= 0) { used[best] = 1; tp++; lat.push(det[best] - r); }
  }
  const p = det.length ? tp / det.length : 0, rc = ref.length ? tp / ref.length : 0;
  return { f1: p + rc ? 2 * p * rc / (p + rc) : 0, p, r: rc, lat: median(lat) };
}

class Edge {   // rising-edge detector with refractory period
  constructor(th, refr) { this.th = th; this.refr = refr; this.prev = 0; this.last = -1; this.out = []; }
  push(t, v) { if (v >= this.th && this.prev < this.th && t - this.last > this.refr) { this.out.push(t); this.last = t; } this.prev = v; }
}

const activeAt = (notes, t, grace = 0.05) => notes.find(n => t >= n.t + grace && t < n.end);

// ── per-track scoring ─────────────────────────────────────────────────────
async function scoreTrack(name) {
  const { samples, truth } = renderTrack(name);
  const eK = new Edge(0.5, 0.08), eS = new Edge(0.5, 0.08), eH = new Edge(0.5, 0.05), eHd = new Edge(0.08, 0.05);
  let prevHigh = 0;
  const bpmErr = [], bpmOk = [], phaseOk = [];
  const bass = { n: 0, pc: 0, exact: 0, voiced: 0, falseOn: 0, silentN: 0 };
  const mel = { n: 0, pc: 0, exact: 0 };
  const key = { n: 0, root: 0, mode: 0 };
  const drops = [];
  let bdN = 0, bdOk = 0;
  let beatIdx = 0;
  const tempoAt = (t) => { let b = truth.tempo[0]; for (const s of truth.tempo) if (t >= s.t) b = s; return b; };
  const tempoChanges = truth.tempo.filter((s, i) => i === 0 || Math.abs(s.bpm - truth.tempo[i - 1].bpm) > 0.5).map(s => s.t);

  const perf = await runTrack(pipeline, samples, (t, { raw, beat, harm, st, audio }) => {
    eK.push(t, raw.kick); eS.push(t, raw.snare);
    if (raw.hat !== undefined) eH.push(t, raw.hat);
    eHd.push(t, raw.high - prevHigh); prevHigh = raw.high;

    // tempo: skip 8 s after start / each tempo change (lock-in time is scored separately)
    const sinceChange = t - Math.max(...tempoChanges.filter(c => c <= t));
    const tb = tempoAt(t).bpm;
    if (sinceChange > 8) {
      const e = Math.abs(beat.bpm - tb) / tb;
      bpmErr.push(e * 100); bpmOk.push(e < 0.03 ? 1 : 0);
    }
    // beat phase at each true beat instant
    while (beatIdx < truth.beats.length && truth.beats[beatIdx].t <= t) {
      const bt = truth.beats[beatIdx++];
      if (bt.t - Math.max(...tempoChanges.filter(c => c <= bt.t)) <= 8) continue;
      const ago = t - bt.t;
      const ph = beat.beatT - ago / beat.period;
      const err = Math.abs(ph - Math.round(ph));
      phaseOk.push(beat.conf > 0.3 && err < 0.1 ? 1 : 0);
    }

    // bass note
    const tb2 = activeAt(truth.bass, t);
    let bassGuess = null;
    if (raw.bassNote !== undefined) bassGuess = raw.bassNote >= 0 ? raw.bassNote : null;
    else {
      const d = audio.dataArray, binHz = SR / audio.analyser.fftSize;
      let bi = -1, bv = 0;
      for (let i = Math.floor(28 / binHz); i <= Math.ceil(300 / binHz); i++) if (d[i] > bv) { bv = d[i]; bi = i; }
      bassGuess = bv > 120 ? hzMidi(bi * binHz) : null;
    }
    const anyBass = truth.bass.some(n => t >= n.t && t < n.end + 0.15);
    if (tb2) {
      bass.n++;
      if (bassGuess !== null) { bass.voiced++; if (pc(bassGuess) === pc(tb2.midi)) bass.pc++; if (Math.round(bassGuess) === tb2.midi) bass.exact++; }
    } else if (!anyBass) { bass.silentN++; if (bassGuess !== null) bass.falseOn++; }

    // melody note
    const tm = activeAt(truth.mel, t);
    if (tm) {
      mel.n++;
      if (raw.melNote !== undefined) {
        if (raw.melNote >= 0) { if (pc(raw.melNote) === pc(tm.midi)) mel.pc++; if (Math.round(raw.melNote) === tm.midi) mel.exact++; }
      } else {
        const c = audio.chromagram; let bi = 0; for (let i = 1; i < 12; i++) if (c[i] > c[bi]) bi = i;
        if (c[bi] > 0 && bi === pc(tm.midi)) mel.pc++;
      }
    }

    // key (after 10 s of music)
    if (t > 10) {
      key.n++;
      const hueIdx = Math.round(harm.keyHue * 12) % 12;
      const root = (hueIdx * 7) % 12;
      if (harm.keyConf > 0.3 && root === truth.key.root) key.root++;
      if ((harm.tonality < 0) === truth.key.minor && Math.abs(harm.tonality) > 0.05) key.mode++;
    }

    // structure
    if (st.onDrop) drops.push(t);
    if (t > 14) {
      const inBd = truth.breakdowns.some(([a, b]) => t >= a + 2 && t < b);
      const nearEdge = truth.breakdowns.some(([a, b]) => Math.abs(t - a) < 2 || Math.abs(t - b) < 1);
      if (!nearEdge) { bdN++; if ((st.state === 'breakdown') === inBd) bdOk++; }
    }
  });

  const hatDet = raw0HasHat(eH) ? eH.out : eHd.out;
  const dropHits = truth.drops.filter(d => drops.some(x => x - d >= -0.25 && x - d <= 0.75)).length;
  return {
    name,
    kick: onsetF1(eK.out, truth.kick), snare: onsetF1(eS.out, truth.snare), hat: onsetF1(hatDet, truth.hat),
    bpmAcc: bpmOk.reduce((a, b) => a + b, 0) / Math.max(1, bpmOk.length),
    bpmErr: median(bpmErr),
    phaseAcc: phaseOk.reduce((a, b) => a + b, 0) / Math.max(1, phaseOk.length),
    bassPc: bass.pc / Math.max(1, bass.n), bassExact: bass.exact / Math.max(1, bass.n),
    bassFalse: bass.falseOn / Math.max(1, bass.silentN),
    melPc: mel.pc / Math.max(1, mel.n), melExact: mel.exact / Math.max(1, mel.n),
    keyRoot: key.root / Math.max(1, key.n), keyMode: key.mode / Math.max(1, key.n),
    drops: { truth: truth.drops.length, hit: dropHits, fired: drops.length },
    breakdownAcc: bdOk / Math.max(1, bdN),
    perf,
  };
}
function raw0HasHat(e) { return e.out.length > 0 || e.prev !== 0; }

// ── run + report ──────────────────────────────────────────────────────────
const names = only ? [only] : TRACK_NAMES;
const results = [];
for (const n of names) results.push(await scoreTrack(n));

const pct = (v) => isNaN(v) ? '  —  ' : (v * 100).toFixed(0).padStart(4) + '%';
const ms = (v) => isNaN(v) ? '  — ' : ((v * 1000).toFixed(0) + 'ms').padStart(6);
console.log(`\nBloom analysis bench — ${ref ? 'ref ' + ref : 'working tree'}\n`);
console.log('track            kickF1 lat   snrF1 lat   hatF1  bpm±3% phase  bassPC bassOct bassFP melPC melOct keyRt keyMd drops   bdown');
for (const r of results) {
  console.log(
    r.name.padEnd(16),
    pct(r.kick.f1), ms(r.kick.lat), pct(r.snare.f1), ms(r.snare.lat), pct(r.hat.f1),
    ' ', pct(r.bpmAcc), pct(r.phaseAcc), ' ', pct(r.bassPc), ' ', pct(r.bassExact), pct(r.bassFalse),
    pct(r.melPc), pct(r.melExact), pct(r.keyRoot), pct(r.keyMode),
    ` ${r.drops.hit}/${r.drops.truth}(${r.drops.fired})`.padEnd(8), pct(r.breakdownAcc),
  );
}
const mean = (f) => results.reduce((a, r) => a + f(r), 0) / results.length;
const summary = {
  kickF1: mean(r => r.kick.f1), snareF1: mean(r => r.snare.f1), hatF1: mean(r => r.hat.f1),
  bpmAcc: mean(r => r.bpmAcc), phaseAcc: mean(r => r.phaseAcc),
  bassPc: mean(r => r.bassPc), bassExact: mean(r => r.bassExact), bassFalse: mean(r => r.bassFalse),
  melPc: mean(r => r.melPc), melExact: mean(r => r.melExact),
  keyRoot: mean(r => r.keyRoot), keyMode: mean(r => r.keyMode),
  dropsHit: results.reduce((a, r) => a + r.drops.hit, 0), dropsTruth: results.reduce((a, r) => a + r.drops.truth, 0),
  dropsFired: results.reduce((a, r) => a + r.drops.fired, 0), breakdownAcc: mean(r => r.breakdownAcc),
  mainMsPerFrame: mean(r => r.perf.mainMsPerFrame), workletMsPerSec: mean(r => r.perf.workletMsPerSecAudio),
};
console.log(
  'MEAN'.padEnd(16), pct(summary.kickF1), '      ', pct(summary.snareF1), '      ', pct(summary.hatF1), ' ',
  pct(summary.bpmAcc), pct(summary.phaseAcc), ' ', pct(summary.bassPc), ' ', pct(summary.bassExact), pct(summary.bassFalse),
  pct(summary.melPc), pct(summary.melExact), pct(summary.keyRoot), pct(summary.keyMode),
  ` ${summary.dropsHit}/${summary.dropsTruth}(${summary.dropsFired})`.padEnd(8), pct(summary.breakdownAcc));
console.log(`\ncost: main thread ${summary.mainMsPerFrame.toFixed(3)} ms/frame (node), worklet ${summary.workletMsPerSec.toFixed(1)} ms per audio-second`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ ref: ref ?? 'working', summary, results }, null, 1));
