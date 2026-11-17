import { MODE_GROUPS, MODE_META, metaFor } from './modes-meta.js';

// Performance HUD: welcome card, top bar, world palette, grouped menus,
// shortcuts, idle auto-hide, toast. It never re-implements an action — it
// clicks the existing controls (their handlers live in main.js), so every
// path (mouse, key, MIDI-learn, share links) stays one code path.
//
// api: { getMode(), switchMode(id), modeIds(), stage() → StagePreset|null,
//        webgpu, beat, onDemo() }
const $ = (id) => document.getElementById(id);
const IDLE_MS = 2600;

export function initHud(api) {
  const body = document.body;
  const ui = $('ui');
  let hiddenLock = false;     // H: stay hidden even when the mouse moves
  let idleTimer = 0;

  // ── toast ──────────────────────────────────────────────────────────
  const toast = $('preset-label');
  let toastT = 0;
  function say(main, sub = '') {
    toast.innerHTML = '';
    const a = document.createElement('div'); a.className = 't-main'; a.textContent = main;
    toast.append(a);
    if (sub) { const b = document.createElement('div'); b.className = 't-sub'; b.textContent = sub; toast.append(b); }
    toast.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => toast.classList.remove('show'), 1600);
  }

  // ── idle auto-hide ─────────────────────────────────────────────────
  const anyPanelOpen = () => !!document.querySelector('.menu.open, #palette.open, #help.open, #tutorial-overlay.active, body.sheet-open')
    || !ui.classList.contains('done');
  function wake() {
    if (hiddenLock) return;
    body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!anyPanelOpen()) body.classList.add('idle'); }, IDLE_MS);
  }
  ['pointermove', 'pointerdown', 'keydown', 'touchstart'].forEach(ev => window.addEventListener(ev, wake, { passive: true }));
  wake();

  function setHidden(on) {
    hiddenLock = on;
    body.classList.toggle('idle', on);
    if (on) { closeMenus(); say('UI hidden', 'press H (or tap twice) to bring it back'); }
    else wake();
  }
  // double-tap on the canvas = H on touch screens
  let lastTap = 0;
  $('canvas').addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch') return;
    const now = performance.now();
    if (now - lastTap < 320) setHidden(!hiddenLock);
    lastTap = now;
  });

  // ── welcome card ───────────────────────────────────────────────────
  function closeWelcome() { ui.classList.add('done'); wake(); }
  function openWelcome() { ui.classList.remove('done'); body.classList.remove('idle'); }
  $('btn-welcome-close').addEventListener('click', closeWelcome);
  $('pill-audio').addEventListener('click', openWelcome);
  $('btn-demo').addEventListener('click', () => api.onDemo());
  document.querySelectorAll('.world-btn').forEach(b => b.addEventListener('click', () => {
    api.switchMode(b.dataset.mode);
    document.querySelectorAll('.world-btn').forEach(x => x.classList.toggle('active', x === b));
  }));

  // ── menus (LOOK / OUTPUT / SETUP) ──────────────────────────────────
  const menus = [...document.querySelectorAll('.menu')];
  function closeMenus(except) { menus.forEach(m => { if (m !== except) m.classList.remove('open'); }); }
  menus.forEach(m => m.querySelector('.menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !m.classList.contains('open');
    closeMenus(m);
    m.classList.toggle('open', open);
  }));
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.menu, #btn-more')) { closeMenus(); body.classList.remove('sheet-open'); }
  });
  $('btn-more').addEventListener('click', () => body.classList.toggle('sheet-open'));

  // ── world palette ──────────────────────────────────────────────────
  const pal = $('palette');
  const grid = $('palette-grid');
  const available = new Set(api.modeIds());
  for (const g of MODE_GROUPS) {
    const items = MODE_META.filter(m => m.group === g.id && available.has(m.id));
    if (!items.length) continue;
    const h = document.createElement('div'); h.className = 'pal-group'; h.textContent = g.label;
    grid.append(h);
    for (const m of items) {
      const b = document.createElement('button');
      b.className = 'pal-tile' + (m.group === '3d' ? ' is-3d' : '');
      b.dataset.mode = m.id;
      b.innerHTML = `<b></b><small></small>`;
      b.querySelector('b').textContent = m.name;
      b.querySelector('small').textContent = m.desc;
      if (!api.webgpu && m.id !== 'stage') { b.disabled = true; b.title = 'Needs WebGPU (Chrome 113+ / Safari 26+)'; }
      b.addEventListener('click', () => { api.switchMode(m.id); togglePalette(false); });
      grid.append(b);
    }
  }
  if (document.getElementById('btn-digitakt')) {
    const h = document.createElement('div'); h.className = 'pal-group'; h.textContent = 'Instruments';
    const b = document.createElement('button');
    b.className = 'pal-tile';
    b.innerHTML = '<b>DIGITAKT</b><small>Line-art Elektron Digitakt with looks driven by its MIDI — tracks, knobs, mutes. Works on phones too.</small>';
    b.addEventListener('click', () => { togglePalette(false); $('btn-digitakt').click(); });
    grid.append(h, b);
  }
  function togglePalette(on = !pal.classList.contains('open')) {
    pal.classList.toggle('open', on);
    if (on) { closeMenus(); grid.querySelectorAll('.pal-tile').forEach(t => t.classList.toggle('active', t.dataset.mode === api.getMode())); }
    wake();
  }
  $('btn-mode').addEventListener('click', () => togglePalette());
  $('palette-close').addEventListener('click', () => togglePalette(false));
  pal.addEventListener('click', (e) => { if (e.target === pal) togglePalette(false); });

  // prev/next walk the palette order
  const order = MODE_META.map(m => m.id).filter(id => available.has(id));
  function step(d) {
    if (!api.webgpu) return;
    const i = order.indexOf(api.getMode());
    api.switchMode(order[(i + d + order.length) % order.length]);
  }
  $('btn-prev').addEventListener('click', () => step(-1));
  $('btn-next').addEventListener('click', () => step(1));

  // ── STAGE controls: look chips + next shot ─────────────────────────
  const stageCtl = $('stage-ctl');
  const lookWrap = $('stage-looks');
  function renderLooks() {
    const st = api.stage();
    stageCtl.classList.toggle('hidden', !st);
    if (!st) return;
    if (!lookWrap.childElementCount) {
      st.constructor.LOOKS.forEach((l, i) => {
        const b = document.createElement('button');
        b.className = 'chip'; b.textContent = l.label; b.title = `${l.hint}  (L cycles)`;
        b.addEventListener('click', () => { const lk = st.setLook ? api.stage().setLook(i) : null; if (lk) say('STAGE · ' + lk.label, lk.hint); renderLooks(); });
        lookWrap.append(b);
      });
    }
    const cur = st.looks.idx;
    [...lookWrap.children].forEach((b, i) => b.classList.toggle('active', i === cur));
  }
  $('btn-shot').addEventListener('click', () => { const s = api.stage()?.nextShot(); if (s) say('camera · ' + s); });

  // ── mode change hook (called by main.js after every switch) ────────
  function onMode(id) {
    const m = metaFor(id);
    $('mode-name').textContent = m.name;
    const st = api.stage();
    $('mode-sub').textContent = st ? st.lookLabel : (m.group === '3d' ? '' : '2D');
    renderLooks();
    say(m.name + (st ? ' · ' + st.lookLabel : ''), m.desc);
    document.querySelectorAll('.world-btn').forEach(x => x.classList.toggle('active',
      x.dataset.mode === id || (x.dataset.mode !== 'stage' && id !== 'stage')));
  }

  // ── live pills: audio / MIDI / BPM ─────────────────────────────────
  function syncStatus() {
    const sa = $('status-audio'), sm = $('status-midi');
    const pa = $('pill-audio'), pm = $('pill-midi');
    pa.textContent = sa.classList.contains('active') ? sa.textContent.replace('Audio: ', '● ') : '○ add sound';
    pa.classList.toggle('on', sa.classList.contains('active'));
    pm.textContent = sm.classList.contains('active') ? 'MIDI ●' : 'MIDI';
    pm.classList.toggle('on', sm.classList.contains('active'));
  }
  new MutationObserver(syncStatus).observe($('status-audio'), { childList: true, attributes: true, characterData: true, subtree: true });
  new MutationObserver(syncStatus).observe($('status-midi'), { childList: true, attributes: true, characterData: true, subtree: true });
  syncStatus();
  $('pill-midi').addEventListener('click', () => $('btn-midi').click());
  const pillBpm = $('pill-bpm');
  setInterval(() => {
    const b = api.beat;
    pillBpm.textContent = b.conf > 0.15 ? `${Math.round(b.bpm)} BPM` : '— BPM';
    pillBpm.classList.toggle('on', b.conf > 0.15);
  }, 500);
  pillBpm.addEventListener('click', () => $('btn-bpm').click());

  // ── fullscreen ─────────────────────────────────────────────────────
  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }
  $('btn-full').addEventListener('click', toggleFull);

  // ── help ───────────────────────────────────────────────────────────
  const help = $('help');
  const toggleHelp = (on = !help.classList.contains('open')) => { help.classList.toggle('open', on); wake(); };
  $('btn-help').addEventListener('click', () => toggleHelp());
  $('help-close').addEventListener('click', () => toggleHelp(false));
  $('help-tour').addEventListener('click', () => { toggleHelp(false); api.openTour?.(); });
  help.addEventListener('click', (e) => { if (e.target === help) toggleHelp(false); });

  // ── keyboard ───────────────────────────────────────────────────────
  const click = (id) => $(id)?.click();
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (api.keysBlocked?.()) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (!$('zone-panel').classList.contains('hidden')) return;     // WLED calibration owns the keys
    const k = e.key;
    let handled = true;
    if (k === 'ArrowRight') step(1);
    else if (k === 'ArrowLeft') step(-1);
    else if (k === 'm' || k === 'M' || k === 'Tab') togglePalette();
    else if (k === 's' || k === 'S') api.switchMode('stage');
    else if (k === 'l' || k === 'L') { const st = api.stage(); if (st) { const lk = st.cycleLook(e.shiftKey ? -1 : 1); say('STAGE · ' + lk.label, lk.hint); onModeSub(); } else handled = false; }
    else if (k === 'c' || k === 'C') click('btn-shot');
    else if (k === 'v' || k === 'V') { click('btn-vj'); say($('btn-vj').classList.contains('active') ? 'Auto-VJ on' : 'Auto-VJ off', 'rotates worlds on phrases and drops'); }
    else if (k === 'h' || k === 'H') setHidden(!hiddenLock);
    else if (k === 'f' || k === 'F') toggleFull();
    else if (k === 't' || k === 'T') click('btn-tune');
    else if (k === 'b' || k === 'B') click('btn-bpm');
    else if (k === 'g' || k === 'G') click('btn-debug');   // D belongs to Digitakt (src/digitakt)
    else if (k === 'p' || k === 'P') click('btn-proj');
    else if (k === 'x' || k === 'X') { const st = api.stage(); if (st) { st.flash?.(); } else handled = false; }
    else if (k === '?' || k === '/') toggleHelp();
    else if (k === 'Escape') { togglePalette(false); toggleHelp(false); closeMenus(); body.classList.remove('sheet-open'); if (!ui.classList.contains('done') && api.hasSource()) closeWelcome(); }
    else handled = false;
    if (handled) e.preventDefault();
  });
  function onModeSub() { const st = api.stage(); if (st) $('mode-sub').textContent = st.lookLabel; renderLooks(); }

  return { onMode, say, closeWelcome, openWelcome, wake };
}
