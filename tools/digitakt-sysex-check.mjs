// End-to-end check of the Digitakt pattern sync without the hardware:
// a fake "Elektron Digitakt" Web MIDI port answers the SysEx pattern
// request with a synthetic dump and runs MIDI clock at 124 BPM.
// Usage: npm run dev (port in BLOOM_URL), then
//   node tools/digitakt-sysex-check.mjs [outDir]
import { chromium, webkit, devices } from 'playwright';
import { mkdirSync } from 'node:fs';
import { buildPatternResponse, makePatternPayload } from '../src/digitakt/sysex.js';

const URL = process.env.BLOOM_URL ?? 'http://localhost:5173/';
const out = process.argv[2] ?? '../shots-3d/digitakt-sysex';
mkdirSync(out, { recursive: true });

// four-on-the-floor kick, snare on 2/4, offbeat hats, a 32-step clap
const TRIGS = [[0, 0], [0, 4], [0, 8], [0, 12], [1, 4, 127], [1, 12, 127],
  [5, 2], [5, 6], [5, 10], [5, 14], [3, 15], [3, 31]];
const payload = makePatternPayload(TRIGS, { length: 16, bpm: 124 });
const lens = { 3: 32 };
// track 4 (CLAP) runs 32 steps: patch its length word in the payload
{ const v = new DataView(payload.buffer); v.setUint16(4 + 3 * 911 + 904, lens[3]); }
const RESP = [...buildPatternResponse(2, payload)];   // slot 2 = A03

const mock = (resp) => {
  const listeners = new Set();
  const emit = (data) => { const e = new Event('midimessage'); e.data = Uint8Array.from(data); e.target; for (const l of listeners) l(e); };
  const input = { name: 'Elektron Digitakt', id: 'in1', addEventListener: (t, f) => t === 'midimessage' && listeners.add(f), removeEventListener: (t, f) => listeners.delete(f), onmidimessage: null };
  window.__dtReqs = [];
  const output = { name: 'Elektron Digitakt', id: 'out1', send: (d) => { window.__dtReqs.push([...d]); if (d[0] === 0xf0 && d[6] === 0x61) setTimeout(() => emit(resp), 40); } };
  const access = { sysexEnabled: true, inputs: new Map([['in1', input]]), outputs: new Map([['out1', output]]), addEventListener() {} };
  navigator.requestMIDIAccess = async () => access;
  window.__dtDevice = {
    pc: (n) => emit([0xc0, n]),
    play: () => {
      emit([0xfa]);
      const tick = 60000 / (124 * 24);
      let n = 0; const t0 = performance.now();
      const run = () => { const due = Math.floor((performance.now() - t0) / tick); while (n <= due) { emit([0xf8]); n++; } window.__dtClock = setTimeout(run, 4); };
      run();
    },
    stop: () => { clearTimeout(window.__dtClock); emit([0xfc]); },
  };
};

const results = [];
async function run(name, browserType, ctxOpts) {
  const browser = await browserType.launch(browserType === chromium ? { channel: 'chrome', args: ['--enable-unsafe-webgpu'] } : {});
  const page = await (await browser.newContext(ctxOpts)).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(mock, RESP);
  await page.goto(URL + '?digitakt=1');
  await page.waitForFunction(() => window.__digitakt?.dtOut);
  await page.evaluate(() => window.__dtDevice.pc(2));
  await page.waitForFunction(() => window.__digitakt.state.seq, null, { timeout: 5000 });
  await page.evaluate(() => window.__dtDevice.play());
  await page.waitForTimeout(2100);   // ~ 1 bar at 124
  const r = await page.evaluate(() => {
    const st = window.__digitakt.state;
    const by = {};
    for (const h of st.hits) (by[st.tracks[h.track].name] ??= new Set()).add(h.step);
    return {
      reqs: window.__dtReqs.length, slot: window.__dtReqs[0]?.[9],
      view: st.tracks[st.viewTrack()].name,
      keys: [...Array(16)].map((_, k) => st.trigOnKey(k, performance.now())).join(''),
      hits: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, [...v].sort((a, b) => a - b)])),
      hud: window.__digitakt.hud.textContent.split('\n')[0],
    };
  });
  // catch a kick lighting key 1 / snare key 5 on screen
  await page.waitForFunction(() => window.__digitakt.state.stepFlash[4] > 0.6, null, { timeout: 3000 });
  await page.screenshot({ path: `${out}/${name}-step5-flash.png` });
  // T → snare track view
  await page.keyboard.press('t'); await page.keyboard.press('t');
  r.viewAfterT = await page.evaluate(() => window.__digitakt.state.tracks[window.__digitakt.state.viewTrack()].name);
  r.keysAfterT = await page.evaluate(() => [...Array(16)].map((_, k) => window.__digitakt.state.trigOnKey(k, performance.now())).join(''));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/${name}-snare-view.png` });
  r.errors = errors;
  results.push([name, r]);
  await browser.close();
}

await run('desktop', chromium, { viewport: { width: 1440, height: 900 } });
await run('iphone', webkit, { ...devices['iPhone 15'] });
for (const [n, r] of results) console.log(n, JSON.stringify(r, null, 1));
