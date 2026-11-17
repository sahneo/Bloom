// Open Digitakt mode against the real device, record a short video + state samples.
import { chromium } from 'playwright';
const url = process.env.BLOOM_URL ?? 'http://localhost:5192/';
const out = process.argv[2] ?? '../shots-3d/digitakt-live';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: out, size: { width: 1280, height: 800 } } });
await ctx.grantPermissions(['midi', 'midi-sysex'], { origin: new URL(url).origin });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => m.type() === 'error' && errs.push(m.text()));
await page.goto(url + '?digitakt=1');
await page.waitForFunction(() => window.__digitakt?.state.seq, null, { timeout: 8000 }).catch(() => {});
if (process.env.FAKE_START) await page.evaluate(() => window.__digitakt.state.feed([0xfa], performance.now(), 'midi'));
const samples = [];
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(250);
  if (i === 20) { await page.keyboard.press(']'); }
  samples.push(await page.evaluate(() => {
    const m = window.__digitakt, st = m.state, now = performance.now();
    return [Math.round(now), st.playing ? 'P' : 'S', st.bpm.toFixed(1), st.patternName(), st.seq ? 'seq' : '---', m.demo.running ? 'DEMO' : '', st.viewTrack(), st.viewPage(now), st.playKey(now),
      [...Array(16)].map((_, k) => st.trigOnKey(k, now)).join(''), m.dump?.fails, m.dump?.err ?? ''].join(' ');
  }));
}
await page.screenshot({ path: out + '/live.png' });
console.log(samples.join('\n')); console.log('errors', errs);
await ctx.close(); await browser.close();
