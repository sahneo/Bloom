// UI check on desktop Chrome + iPhone 15 (Playwright WebKit, touch taps).
// Dev server must be running. node tools/ui-shots.mjs <outDir>
import { chromium, webkit, devices } from 'playwright';
import { mkdirSync } from 'node:fs';
const out = process.argv[2] ?? '../shots-3d/ui';
mkdirSync(out, { recursive: true });
const URL_ = process.env.BLOOM_URL ?? 'http://localhost:5173/';
const watch = (p, tag, errs) => {
  p.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(`[${tag}] ${m.text()}`); });
  p.on('pageerror', e => errs.push(`[${tag}] PE ${e.message}`));
};
const errs = [];

// ── desktop ──
{
  const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  watch(p, 'desktop', errs);
  await p.goto(URL_); await p.waitForTimeout(1500);
  await p.screenshot({ path: `${out}/desktop-1-welcome.png` });
  await p.click('.world-btn[data-mode="stage"]'); await p.waitForTimeout(1800);
  await p.click('#btn-demo'); await p.waitForTimeout(3500);
  await p.mouse.move(700, 400);
  await p.screenshot({ path: `${out}/desktop-2-stage-hud.png` });
  await p.click('.menu:nth-child(2) .menu-btn'); await p.waitForTimeout(300);
  await p.screenshot({ path: `${out}/desktop-3-output-menu.png` });
  await p.keyboard.press('Escape');
  await p.keyboard.press('m'); await p.waitForTimeout(300);
  await p.screenshot({ path: `${out}/desktop-4-palette.png` });
  await p.keyboard.press('Escape');
  await p.keyboard.press('?'); await p.waitForTimeout(300);
  await p.screenshot({ path: `${out}/desktop-5-help.png` });
  await p.keyboard.press('Escape');
  await p.keyboard.press('l'); await p.waitForTimeout(600);
  await p.screenshot({ path: `${out}/desktop-6-look-toast.png` });
  await p.keyboard.press('ArrowRight'); await p.waitForTimeout(2000);
  const mode = await p.evaluate(() => document.getElementById('mode-name').textContent);
  await p.waitForTimeout(3500);   // idle → HUD hides
  const idle = await p.evaluate(() => document.body.classList.contains('idle'));
  await p.screenshot({ path: `${out}/desktop-7-idle-${mode}.png` });
  console.log('desktop: after → mode', mode, 'idle hidden', idle);
  await b.close();
}

// ── iPhone 15 ──
{
  const w = await webkit.launch();
  const ctx = await w.newContext({ ...devices['iPhone 15'] });
  const p = await ctx.newPage();
  watch(p, 'iphone', errs);
  await p.goto(URL_); await p.waitForTimeout(2500);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth || [...document.querySelectorAll('#hud button')].some(b => { const r = b.getBoundingClientRect(); return r.width && (r.right > innerWidth + 1 || r.left < -1); }));
  await p.screenshot({ path: `${out}/iphone-1-welcome.png` });
  await p.tap('.world-btn[data-mode="stage"]'); await p.waitForTimeout(2000);
  await p.tap('#btn-demo'); await p.waitForTimeout(4000);
  await p.tap('#canvas', { position: { x: 200, y: 500 } }); await p.waitForTimeout(400);
  await p.screenshot({ path: `${out}/iphone-2-stage.png` });
  await p.tap('#btn-more'); await p.waitForTimeout(400);
  await p.screenshot({ path: `${out}/iphone-3-sheet.png` });
  await p.tap('#canvas', { position: { x: 200, y: 150 } }); await p.waitForTimeout(300);
  await p.tap('#btn-mode'); await p.waitForTimeout(400);
  await p.screenshot({ path: `${out}/iphone-4-palette.png` });
  await p.tap('.pal-tile[data-mode="aurora"]'); await p.waitForTimeout(2500);
  const st = await p.evaluate(() => ({ mode: document.getElementById('mode-name').textContent, gpu: !!navigator.gpu, stats: window.__bloom.renderer.preset?.stats?.() ?? null }));
  await p.screenshot({ path: `${out}/iphone-5-aurora.png` });
  console.log('iphone: overflow', overflow, JSON.stringify(st));
  await w.close();
}
console.log('errors:', errs.length ? errs.join('\n') : 'none');
