// Automated visual check: dev server must be running (npm run dev).
// node tools/shoot.mjs <outDir> [--looks] [--mobile] [--secs=N]
// Loads the synthetic track, switches to STAGE, screenshots each look at
// several song sections, logs fps + console errors.
import { chromium, webkit, devices } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const out = resolve(process.argv[2] ?? '../shots-3d');
const args = process.argv.slice(3);
const URL_ = process.env.BLOOM_URL ?? 'http://localhost:5173/';
const track = resolve(process.env.BLOOM_TRACK ?? '../shots-3d/test-track.wav');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
await page.goto(URL_);
await page.waitForTimeout(1500);
await page.setInputFiles('#file-input', track);
await page.waitForTimeout(500);
await page.evaluate(() => window.__setMode('stage'));
await page.waitForTimeout(2500);

const fps = (ms = 3000) => page.evaluate((ms) => new Promise(r => {
  let n = 0; const t0 = performance.now();
  const f = () => { n++; if (performance.now() - t0 < ms) requestAnimationFrame(f); else r(n * 1000 / (performance.now() - t0)); };
  requestAnimationFrame(f);
}), ms);
const stats = () => page.evaluate(() => ({ ...window.__bloom.renderer.preset?.stats?.(), state: window.__bloom.params.structState, bpm: +window.__bloom.beat.bpm.toFixed(1), conf: +window.__bloom.beat.conf.toFixed(2), canvas: [document.getElementById('canvas').width, document.getElementById('canvas').height] }));
const seek = (s) => page.evaluate((s) => window.__bloom.audio.seek(s / window.__bloom.audio.getDuration()), s);

const report = [];
const sections = [['groove', 24], ['breakdown', 44], ['build', 57], ['drop', 63.5]];
const looks = args.includes('--looks') ? [0, 1, 2, 3] : [0];
for (const li of looks) {
  await page.evaluate((i) => window.__bloom.renderer.preset.setLook(i), li);
  for (const [name, t] of sections) {
    await seek(t - 2.5);
    await page.waitForTimeout(2500);
    const f = await fps(1500);
    const s = await stats();
    const file = `${out}/stage-${s.look}-${name}.png`;
    await page.screenshot({ path: file });
    report.push({ look: s.look, section: name, fps: +f.toFixed(1), ...s });
    console.log(JSON.stringify(report.at(-1)));
  }
}
writeFileSync(`${out}/report.json`, JSON.stringify({ report, errors }, null, 2));
console.log('errors:', errors.length ? errors.slice(0, 20).join('\n') : 'none');
await browser.close();
