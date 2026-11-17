// Probe a real Digitakt over Web MIDI in Chrome: ports, traffic, SysEx dump reply.
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: process.argv.slice(2) });
const ctx = await browser.newContext();
await ctx.grantPermissions(['midi', 'midi-sysex'], { origin: 'http://localhost:5192' });
const page = await ctx.newPage();
await page.goto('http://localhost:5192/');
const r = await page.evaluate(async () => {
  const { buildPatternRequest, parsePatternDump } = await import('/src/digitakt/sysex.js');
  const a = await navigator.requestMIDIAccess({ sysex: true });
  const ins = [...a.inputs.values()], outs = [...a.outputs.values()];
  const log = { ins: ins.map(i => i.name), outs: outs.map(o => o.name), sysexEnabled: a.sysexEnabled, counts: {}, sysex: [], other: [] };
  const t0 = performance.now();
  for (const i of ins) i.onmidimessage = (e) => {
    const d = e.data, k = d[0] >= 0xf0 ? d[0].toString(16) : (d[0] & 0xf0).toString(16) + '/ch' + ((d[0] & 15) + 1);
    log.counts[k] = (log.counts[k] ?? 0) + 1;
    if (d[0] === 0xf0 || log.sxOpen) {
      log.sysex.push({ t: Math.round(performance.now() - t0), len: d.length, head: [...d.slice(0, 12)].map(b => b.toString(16)).join(' '), tail: [...d.slice(-6)].map(b => b.toString(16)).join(' ') });
      const p = parsePatternDump(d);
      if (p) log.sysex.at(-1).parsed = p.error ?? { slot: p.slot, len: p.length, bpm: p.bpm, counts: p.tracks.map(t => t.count + '/' + t.len).join(' ') };
    } else if (d[0] < 0xf8 && log.other.length < 30) log.other.push([...d].map(b => b.toString(16)).join(' '));
  };
  const o = outs.find(o => /digitakt|elektron/i.test(o.name));
  await new Promise(r => setTimeout(r, 1500));
  for (const slot of [0, 1]) { o?.send(buildPatternRequest(slot)); log.sentAt = log.sentAt ?? Math.round(performance.now() - t0); await new Promise(r => setTimeout(r, 2500)); }
  return log;
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
