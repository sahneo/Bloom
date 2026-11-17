// Records a ~12 s clip per STAGE look through breakdown → build → drop.
// Dev server must be running. node tools/record-looks.mjs <outDir>
import { chromium } from 'playwright';
import { mkdirSync, renameSync } from 'node:fs';
const out = process.argv[2] ?? '../shots-3d/video';
mkdirSync(out, { recursive: true });
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required'] });
const looks = ['ascii', 'bitmap', 'thermal', 'clean'];
for (let i = 0; i < looks.length; i++) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: out, size: { width: 1280, height: 720 } } });
  const p = await ctx.newPage();
  await p.goto(process.env.BLOOM_URL ?? 'http://localhost:5173/'); await p.waitForTimeout(1000);
  await p.click('.world-btn[data-mode="stage"]'); await p.waitForTimeout(1500);
  await p.click('#btn-demo'); await p.waitForTimeout(800);
  await p.evaluate((i) => window.__bloom.renderer.preset.setLook(i), i);
  await p.evaluate(() => window.__bloom.audio.seek(51 / window.__bloom.audio.getDuration()));
  await p.keyboard.press('h');                    // performance mode: no UI
  await p.waitForTimeout(13000);
  const fps = await p.evaluate(() => window.__bloom.renderer.preset.stats());
  const v = p.video();
  await ctx.close();
  renameSync(await v.path(), `${out}/stage-${looks[i]}.webm`);
  console.log(looks[i], JSON.stringify(fps));
}
await b.close();
