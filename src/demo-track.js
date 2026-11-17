// Demo track: 126 BPM techno-ish arrangement with a real structure the
// analysers can find (used by the "Demo beat" source and automated tests) —
//   0–15 s   intro      kick + hats
//  15–38 s   groove     + bass + minor stabs
//  38–53 s   breakdown  pads only (an octave up, out of the bass band), no kick
//  53–61 s   build      snare roll accelerating + noise riser
//  61–92 s   drop       everything, louder, major stabs
// Pure JS, no deps — runs in the browser and in Node.
export function renderDemoTrack(SR = 44100) {
  const BPM = 126, DUR = 92;
  const beat = 60 / BPM;
  const N = SR * DUR;
  const L = new Float32Array(N);
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

  const add = (t0, len, fn) => {
    const s0 = Math.floor(t0 * SR), n = Math.floor(len * SR);
    for (let i = 0; i < n && s0 + i < N; i++) L[s0 + i] += fn(i / SR);
  };
  const kick = (t, g = 1) => add(t, 0.35, x => g * 0.9 * Math.sin(2 * Math.PI * (45 * x + 90 * (1 - Math.exp(-x * 30)) / 30)) * Math.exp(-x * 9));
  const hat  = (t, g = 1) => add(t, 0.05, x => g * 0.18 * rnd() * Math.exp(-x * 90));
  const snare = (t, g = 1) => add(t, 0.18, x => g * (0.35 * rnd() + 0.2 * Math.sin(2 * Math.PI * 190 * x)) * Math.exp(-x * 22));
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
  const bass = (t, m, len, g = 1) => add(t, len, x => g * 0.4 * Math.tanh(3 * Math.sin(2 * Math.PI * mtof(m) * x)) * Math.min(1, x * 200) * Math.exp(-x * 3));
  const chord = (t, notes, len, g = 1) => add(t, len, x => g * 0.11 * notes.reduce((a, m) =>
    a + Math.sin(2 * Math.PI * mtof(m) * x) + 0.5 * Math.sin(4 * Math.PI * mtof(m) * x), 0) * Math.min(1, x * 80) * Math.exp(-x * 4));
  const pad = (t, notes, len, g = 1) => add(t, len, x => g * 0.06 * notes.reduce((a, m) =>
    a + Math.sin(2 * Math.PI * mtof(m) * x + Math.sin(x * 3)), 0) * Math.min(1, x / 1.5) * Math.min(1, (len - x) / 1.0));

  const MINOR = [[57, 60, 64], [53, 57, 60], [55, 59, 62], [52, 55, 59]];   // Am F G Em
  const MAJOR = [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]];   // C G Am F
  const sec = { intro: 15, groove: 38, brk: 53, build: 61 };

  for (let b = 0; b * beat < DUR; b++) {
    const t = b * beat, bar = Math.floor(b / 4);
    const inBrk = t >= sec.groove && t < sec.brk;
    const inBuild = t >= sec.brk && t < sec.build;
    const drop = t >= sec.build;
    if (!inBrk && !inBuild) kick(t, drop ? 1.15 : 1);
    if (!inBrk) { hat(t + beat / 2, drop ? 1.3 : 1); if (drop || t > sec.intro) hat(t + beat / 4, 0.5); }
    if ((t >= sec.intro && t < sec.groove) || drop) {
      const prog = drop ? MAJOR : MINOR;
      const root = prog[bar % 4][0] - 24;
      bass(t + beat / 2, root, beat * 0.45, drop ? 1.2 : 1);
      if (b % 4 === 2) chord(t + beat * 0.75, prog[bar % 4], beat * 0.6, drop ? 1.3 : 1);
      if (drop && b % 2 === 1) snare(t, 0.8);
    }
    if (inBrk && b % 8 === 0) pad(t, MINOR[bar % 4].map(m => m + 12), beat * 8, 0.8);
  }
  // build: snare roll 1/4 → 1/8 → 1/16, rising noise
  for (let t = sec.brk; t < sec.build; ) {
    const k = (t - sec.brk) / (sec.build - sec.brk);
    snare(t, 0.4 + 0.8 * k);
    t += k < 0.5 ? beat : k < 0.8 ? beat / 2 : beat / 4;
  }
  add(sec.brk, sec.build - sec.brk, x => 0.12 * rnd() * Math.pow(x / (sec.build - sec.brk), 2));
  let peak = 0;
  for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]));
  for (let i = 0; i < N; i++) L[i] = (L[i] / peak) * 0.9;
  return L;
}

// mono Float32 [-1,1] → 16-bit PCM WAV bytes
export function toWav(L, SR = 44100) {
  const N = L.length;
  const buf = new DataView(new ArrayBuffer(44 + N * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) buf.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); buf.setUint32(4, 36 + N * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); buf.setUint32(16, 16, true); buf.setUint16(20, 1, true); buf.setUint16(22, 1, true);
  buf.setUint32(24, SR, true); buf.setUint32(28, SR * 2, true); buf.setUint16(32, 2, true); buf.setUint16(34, 16, true);
  str(36, 'data'); buf.setUint32(40, N * 2, true);
  for (let i = 0; i < N; i++) buf.setInt16(44 + i * 2, Math.max(-32767, Math.min(32767, Math.round(L[i] * 32767))), true);
  return new Uint8Array(buf.buffer);
}
