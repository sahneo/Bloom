// Offline Web Audio stand-in: feeds a rendered track through the REAL
// src/audio.js, beat.js, harmony.js, structure.js and public/onset-worklet.js
// at 60 fps, exactly in the order main.js frame() calls them.
//
// Emulated pieces (spec-faithful, not approximations of our code):
//  · AnalyserNode.getByteFrequencyData — Blackman window, |X|/N, dB → byte
//    with minDecibels −100 / maxDecibels −30, smoothingTimeConstant 0
//  · getFloatTimeDomainData — last fftSize samples
//  · AudioWorklet — the processor class runs on 128-sample blocks; its port
//    messages are delivered to the main thread before the next frame
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SR } from './synth.mjs';

// ── FFT (radix-2, in place) ───────────────────────────────────────────────
const fftCache = new Map();
function fftTables(n) {
  if (fftCache.has(n)) return fftCache.get(n);
  const rev = new Uint32Array(n), bits = Math.log2(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) { const x = i / n; win[i] = 0.42 - 0.5 * Math.cos(2 * Math.PI * x) + 0.08 * Math.cos(4 * Math.PI * x); }
  const t = { rev, cos, sin, win, re: new Float64Array(n), im: new Float64Array(n) };
  fftCache.set(n, t);
  return t;
}
function magSpectrum(samples, end, n, outDb) {
  const { rev, cos, sin, win, re, im } = fftTables(n);
  for (let i = 0; i < n; i++) { const j = end - n + i; const v = j >= 0 && j < samples.length ? samples[j] : 0; re[rev[i]] = v * win[i]; im[rev[i]] = 0; }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) for (let k = 0; k < half; k++) {
      const c = cos[k * step], s = sin[k * step];
      const a = i + k, b = a + half;
      const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
  for (let k = 0; k < n / 2; k++) outDb[k] = 20 * Math.log10(Math.hypot(re[k], im[k]) / n + 1e-20);
}

class FakeAnalyser {
  constructor(sim) { this.sim = sim; this.fftSize = 2048; this.smoothingTimeConstant = 0.8; this.minDecibels = -100; this.maxDecibels = -30; this._db = null; this._dbAt = -1; }
  get frequencyBinCount() { return this.fftSize / 2; }
  connect() {} disconnect() {}
  _spec() {
    if (this._dbAt !== this.sim.pos || !this._db || this._db.length !== this.fftSize / 2) {
      this._db = this._db?.length === this.fftSize / 2 ? this._db : new Float64Array(this.fftSize / 2);
      magSpectrum(this.sim.samples, this.sim.pos, this.fftSize, this._db);
      this._dbAt = this.sim.pos;
    }
    return this._db;
  }
  getByteFrequencyData(arr) {
    const db = this._spec(), r = this.maxDecibels - this.minDecibels;
    for (let i = 0; i < arr.length; i++) arr[i] = Math.max(0, Math.min(255, Math.floor(255 * (db[i] - this.minDecibels) / r)));
  }
  getFloatFrequencyData(arr) { const db = this._spec(); for (let i = 0; i < arr.length; i++) arr[i] = db[i]; }
  getFloatTimeDomainData(arr) {
    const s = this.sim.samples, end = this.sim.pos;
    for (let i = 0; i < arr.length; i++) { const j = end - arr.length + i; arr[i] = j >= 0 && j < s.length ? s[j] : 0; }
  }
}

class FakeNode { connect() {} disconnect() {} }

function fakeContext(sim) {
  return {
    sampleRate: SR,
    get currentTime() { return sim.pos / SR; },
    outputLatency: 0,
    createAnalyser: () => new FakeAnalyser(sim),
    createChannelSplitter: () => new FakeNode(),
    createBufferSource: () => Object.assign(new FakeNode(), { start() {}, stop() {} }),
    createMediaStreamSource: () => new FakeNode(),
    createBiquadFilter: () => Object.assign(new FakeNode(), { frequency: {}, Q: {}, type: '' }),
    createGain: () => Object.assign(new FakeNode(), { gain: {} }),
    destination: new FakeNode(),
    audioWorklet: { addModule: async () => {} },
  };
}

// Load a src/ module with browser-only bits patched (import.meta.env)
async function loadModule(srcDir, file, cacheDir) {
  let code = readFileSync(join(srcDir, file), 'utf8');
  code = code.replace(/import\.meta\.env\.BASE_URL/g, "''");
  // relative imports → absolute file URLs of the patched copies
  code = code.replace(/from\s+['"]\.\/([\w-]+\.js)['"]/g, (_, f) => `from '${pathToFileURL(join(cacheDir, f)).href}'`);
  const out = join(cacheDir, file);
  writeFileSync(out, code);
  return out;
}

export async function loadPipeline(srcDir, workletPath) {
  srcDir = resolve(srcDir);
  const cacheDir = join(resolve('tools/bench/.cache'), Buffer.from(srcDir).toString('base64url').slice(-24));
  mkdirSync(cacheDir, { recursive: true });
  const files = ['audio.js', 'beat.js', 'harmony.js', 'structure.js'];
  try { readFileSync(join(srcDir, 'pitch.js')); files.push('pitch.js'); } catch {}
  for (const f of files) await loadModule(srcDir, f, cacheDir);
  const mods = {};
  for (const f of files) mods[f] = await import(pathToFileURL(join(cacheDir, f)).href + '?v=' + Date.now());
  const workletSrc = readFileSync(workletPath, 'utf8');
  return { mods, workletSrc };
}

function instantiateWorklet(src, sim) {
  let Proc = null;
  const port = { onmessage: null, postMessage: (d) => sim.msgs.push(d) };
  class AudioWorkletProcessor { constructor() { this.port = port; } }
  const env = { get currentTime() { return sim.blockTime; } };
  const fn = new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', 'env',
    src.replace(/\bcurrentTime\b/g, 'env.currentTime'));
  fn(AudioWorkletProcessor, (name, cls) => { Proc = cls; }, SR, env);
  return { proc: new Proc(), port };
}

// Runs the track; calls onFrame(t, state) every frame with everything the
// visuals would read. Returns nothing — the scorer collects what it needs.
export async function runTrack(pipeline, samples, onFrame, { fps = 60 } = {}) {
  const { mods, workletSrc } = pipeline;
  const sim = { samples, pos: 0, msgs: [], blockTime: 0 };
  let simMs = 0;
  Object.defineProperty(globalThis, 'performance', { value: { now: () => simMs }, configurable: true, writable: true });
  const origLog = console.log; console.log = () => {};
  const origWarn = console.warn; console.warn = () => {};

  globalThis.AudioWorkletNode = class { constructor() { this.port = workletPort; } connect() {} disconnect() {} };
  const { proc, port: workletPort } = instantiateWorklet(workletSrc, sim);

  const audio = new mods['audio.js'].AudioAnalyser();
  audio.context = fakeContext(sim);
  audio._ensureAnalyser();
  audio._ensureChromaAnalyser();
  await audio._ensureOnsetWorklet();
  audio._fileSource = null;                     // treat as a stream: no output-latency correction
  if (audio._ensurePitch) audio._ensurePitch?.();
  const beat = new mods['beat.js'].BeatTracker();
  const harmony = new mods['harmony.js'].HarmonyAnalyzer();
  const structure = new mods['structure.js'].StructureAnalyzer();

  const frameSamples = SR / fps;
  const block = 128;
  const input = new Float32Array(block);
  let nextFrame = frameSamples, frameIdx = 0;
  const workletCost = { ms: 0 }, mainCost = { ms: 0 };
  for (let b = 0; b + block <= samples.length; b += block) {
    for (let i = 0; i < block; i++) input[i] = samples[b + i];
    sim.blockTime = b / SR;
    const w0 = process.hrtime.bigint();
    proc.process([[input]], [[]]);
    workletCost.ms += Number(process.hrtime.bigint() - w0) / 1e6;
    if (b + block >= nextFrame) {
      sim.pos = b + block;
      const t = sim.pos / SR;
      simMs = t * 1000;
      // deliver worklet messages (async port → main thread)
      if (workletPort.onmessage) for (const d of sim.msgs) workletPort.onmessage({ data: d });
      sim.msgs.length = 0;
      const m0 = process.hrtime.bigint();
      const dtS = 1 / fps;
      const raw = audio.update();
      beat.update(t, raw.kick, raw.snare, raw.high, dtS, raw.flux ?? 0);
      for (const ev of audio.drainOnsetEvents()) beat.onsetEvent(ev.ago, ev.kick, ev.snare, ev.hat ?? 0);
      const fftEnergy = (raw.bass + raw.mid + raw.high) / 3;
      const harm = harmony.updateFromChroma(audio.chromagram, fftEnergy, audio.pitch?.chromaWeight ?? 1);
      const st = structure.update(raw, beat, dtS);
      mainCost.ms += Number(process.hrtime.bigint() - m0) / 1e6;
      onFrame(t, { raw, beat, harm, st, audio });
      frameIdx++;
      nextFrame += frameSamples;
    }
  }
  console.log = origLog; console.warn = origWarn;
  return { frames: frameIdx, mainMsPerFrame: mainCost.ms / frameIdx, workletMsPerSecAudio: workletCost.ms / (samples.length / SR) };
}
