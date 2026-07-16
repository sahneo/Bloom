import { Renderer }           from './renderer.js';
import { AudioAnalyser }      from './audio.js';
import { MIDIHandler }        from './midi.js';
import { HarmonyAnalyzer }    from './harmony.js';
import { RippleManager }      from './ripples.js';
import { BeatTracker }        from './beat.js';
import { StructureAnalyzer }  from './structure.js';
import { AutoVJ }             from './autovj.js';
import { GenerativeDrift }    from './drift.js';
import { GENRES }             from './genres.js';
import { ParticlesPreset }    from './presets/particles.js';
import { OscilloscopePreset } from './presets/oscilloscope.js';
import { AsciiPreset }        from './presets/ascii.js';
import { SilkPreset }         from './presets/silk.js';
import { FloraPreset }        from './presets/flora.js';
import { FluidPreset, FerroPreset } from './presets/fluid.js';
import { VoidPreset }         from './presets/void.js';
import { CymaticsPreset }     from './presets/cymatics.js';
import { StormPreset }        from './presets/storm.js';
import { TerraPreset }        from './presets/terra.js';
import { SwarmPreset }        from './presets/swarm.js';
import { GalaxyPreset }       from './presets/galaxy.js';
import { GlassPreset }        from './presets/glass.js';
import { DitherPreset, addMediaFiles, mediaApi } from './presets/dither.js';
import { AcidPreset }         from './presets/acid.js';
import { PrismPreset }        from './presets/prism.js';
import { FxPreset }           from './presets/fx.js';
import { TypePreset }         from './presets/type.js';
import { WledSync }           from './wled.js';
import { GestureControl }     from './gesture.js';
import posthogLib from 'posthog-js';

// Analytics key comes from the environment (.env.local / Vercel env) — never
// hardcode it: the client bundle is public. Without a key, analytics no-op.
const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY;
const posthog = POSTHOG_KEY ? posthogLib : { capture: () => {} };
if (POSTHOG_KEY) {
  posthogLib.init(POSTHOG_KEY, {
    api_host: 'https://us.i.posthog.com',
    autocapture: false,
  });
}
const _sessionStart = Date.now();

const canvas      = document.getElementById('canvas');
const errorEl     = document.getElementById('error');
const uiEl        = document.getElementById('ui');
const statusAudio = document.getElementById('status-audio');
const btnSystem   = document.getElementById('btn-system');
const btnMic      = document.getElementById('btn-mic');
const btnFile     = document.getElementById('btn-file');
const fileInput   = document.getElementById('file-input');
const btnTune     = document.getElementById('btn-tune');
const tunePanel   = document.getElementById('tune');
const btnTrain    = document.getElementById('btn-train');
const trainPanel  = document.getElementById('train');
const btnMidi          = document.getElementById('btn-midi');
const statusMidi       = document.getElementById('status-midi');
const btnRippleColor   = document.getElementById('btn-ripple-color');
const rippleColorInput = document.getElementById('ripple-color-input');

let dprCap = 1.5;   // adaptive: lowered when frame time sags, restored when idle
function resize() {
  const dpr = Math.min(devicePixelRatio, dprCap);
  canvas.width  = Math.round(window.innerWidth  * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
}
window.addEventListener('resize', resize);
resize();

// ── Band mute / solo ────────────────────────────────────────────────
const BANDS = ['drums', 'bass', 'lead', 'atmos', 'pads'];
const bandState = Object.fromEntries(BANDS.map(k => [k, { enabled: true, solo: false }]));

function isBandActive(k) {
  const anySolo = BANDS.some(b => bandState[b].solo);
  return anySolo ? bandState[k].solo : bandState[k].enabled;
}

function applyBandMutes(bands) {
  return {
    ...bands,
    kick:    isBandActive('drums') ? bands.kick    : 0,
    snare:   isBandActive('drums') ? bands.snare   : 0,
    bass:    isBandActive('bass')  ? bands.bass    : 0,
    mid:     isBandActive('lead')  ? bands.mid     : 0,
    high:    isBandActive('atmos') ? bands.high    : 0,
    subBass: isBandActive('pads')  ? bands.subBass : 0,
  };
}

function updateBandUI() {
  const anySolo = BANDS.some(k => bandState[k].solo);
  BANDS.forEach(k => {
    const row      = document.getElementById(`band-${k}`);
    const soloBtn  = document.getElementById(`solo-${k}`);
    soloBtn.classList.toggle('active', bandState[k].solo);
    row.classList.toggle('muted',  !anySolo && !bandState[k].enabled);
    row.classList.toggle('dimmed',  anySolo && !bandState[k].solo);
  });
}

const modeParamKey = { drums: 'modeDrums', bass: 'modeBass', lead: 'modeLead', atmos: 'modeAtmos', pads: 'modePads' };

BANDS.forEach(k => {
  document.getElementById(`tog-${k}`).addEventListener('change', e => {
    bandState[k].enabled = e.target.checked;
    posthog.capture('band_muted', { band: k, muted: !e.target.checked });
    updateBandUI();
  });
  document.getElementById(`solo-${k}`).addEventListener('click', () => {
    bandState[k].solo = !bandState[k].solo;
    posthog.capture('band_soloed', { band: k, soloed: bandState[k].solo });
    updateBandUI();
  });
  const sel = document.getElementById(`mode-${k}`);
  if (sel) sel.addEventListener('change', () => {
    params[modeParamKey[k]] = parseInt(sel.value);
    posthog.capture('band_mode_changed', { band: k, mode: sel.value, mode_name: sel.options[sel.selectedIndex]?.text });
  });
});

// ── Debug overlay ───────────────────────────────────────────────────
const debugEl  = document.getElementById('debug');
const btnDebug = document.getElementById('btn-debug');
const btnColor = document.getElementById('btn-color');

btnDebug.addEventListener('click', () => {
  const hidden = debugEl.classList.toggle('hidden');
  btnDebug.classList.toggle('active', !hidden);
});

btnColor.addEventListener('click', () => {
  params.colorMode = params.colorMode > 0.5 ? 0 : 1;
  btnColor.classList.toggle('active', params.colorMode > 0.5);
  posthog.capture('color_mode_toggled', { on: params.colorMode > 0.5 });
});

// ── BPM tracker + metronome widget ──────────────────────────────────
const beat       = new BeatTracker();
const btnBpm     = document.getElementById('btn-bpm');
const bpmWidget  = document.getElementById('bpm-widget');
const bpmValue   = document.getElementById('bpm-value');
const bpmConf    = document.getElementById('bpm-conf');
const bpmBeat    = document.getElementById('bpm-beat');
const bpmBarDots = [...document.querySelectorAll('#bpm-bar span')];

btnBpm.addEventListener('click', () => {
  const hidden = bpmWidget.classList.toggle('hidden');
  btnBpm.classList.toggle('active', !hidden);
  posthog.capture('bpm_widget_toggled', { on: !hidden });
});

function updateBpmWidget() {
  const locked = beat.conf > 0.15;
  bpmValue.textContent = locked ? Math.round(beat.bpm) + '' : '--';
  bpmConf.textContent  = 'conf ' + beat.conf.toFixed(2);
  // dot flashes ON the predicted beat, decays over the first 40% of it
  const phase = beat.beatT % 1;
  const flash = Math.pow(Math.max(0, 1 - phase * 2.5), 2) * Math.min(1, beat.conf * 2);
  bpmBeat.style.opacity = (0.08 + 0.92 * flash).toFixed(3);
  const barPos = Math.floor(beat.barPos());
  bpmBarDots.forEach((d, i) => d.classList.toggle('on', locked && i === barPos));
}

const DB_BANDS = [
  { key: 'kick',    label: 'KICK',  color: '#ff4444' },
  { key: 'snare',   label: 'SNARE', color: '#ff9944' },
  { key: 'bass',    label: 'BASS',  color: '#4488ff' },
  { key: 'mid',     label: 'MID',   color: '#44ff88' },
  { key: 'high',    label: 'HIGH',  color: '#cc44ff' },
  { key: 'subBass', label: 'SUB',   color: '#ffdd44' },
];

function updateDebug(bands, harm, st) {
  if (debugEl.classList.contains('hidden')) return;
  if (st) {
    document.getElementById('db-bar-tension').style.width = (st.tension * 100).toFixed(1) + '%';
    document.getElementById('db-val-struct').textContent  = st.state;
  }
  DB_BANDS.forEach(({ key, color }) => {
    const val = bands[key] ?? 0;
    document.getElementById(`db-bar-${key}`).style.width = (val * 100).toFixed(1) + '%';
    document.getElementById(`db-bar-${key}`).style.background = color;
    document.getElementById(`db-val-${key}`).textContent = val.toFixed(2);
  });
  // Tonality: -1 (minor/cool) → 0 (neutral) → +1 (major/warm)
  // Show as a needle at 50% + offset
  if (harm) {
    const t = harm.tonality;
    const pct = (t * 50).toFixed(1);  // ±50% from center
    const bar = document.getElementById('db-bar-tonal');
    const color = t > 0 ? `#ff8c00` : `#4488ff`;
    bar.style.left = t >= 0 ? '50%' : (50 + parseFloat(pct)) + '%';
    bar.style.width = Math.abs(parseFloat(pct)) + '%';
    bar.style.background = color;
    document.getElementById('db-val-tonal').textContent = t.toFixed(2);
    document.getElementById('db-val-tonal').style.color = color;
  }
}

// ── Tunable params (linked to sliders) ──────────────────────────────
const params = {
  mulSb: 1, mulBass: 3, mulMid: 1, mulHigh: 1, spring: 0.3,
  modeDrums: 1, modeBass: 0, modeLead: 0, modeAtmos: 0, modePads: 0,
  colorMode: 0,
  tonality:   0,   // -1 minor → +1 major (from HarmonyAnalyzer)
  pulse:      0,   // 0→1 note-attack flash (from HarmonyAnalyzer)
  dissonance:         0,   // 0 consonant → 1 dissonant (from HarmonyAnalyzer)
  dissonanceStrength: 1,   // user-controlled multiplier for the dissonance visual effect
  keyHue:  0,      // 0..1 tonic hue on the circle of fifths (from HarmonyAnalyzer)
  keyConf: 0,      // 0..1 key detection confidence
  trail:   0.5,    // 0 = no trails, 1 = very long light trails
  glow:    1,      // bloom post-process strength
  trailBias: 0,    // AutoVJ section bias added to trail (breakdowns float)
  tension:   0,    // structure: build-up 0..1
  dropPulse: 0,    // structure: drop shockwave
  driftScale: 1, driftRot: 0, driftX: 0, driftY: 0,   // generative drift
  sceneSeed: 0,    // re-rolls all time-driven field layouts
  paletteMode: 0,  // palette director: mono/duotone/complementary/analogous
  kaleidoK: 0,     // kaleidoscope segments (0 = off), picked per scene
  camZoom: 1, camRot: 0,   // composite-pass camera
  cymTapX: 0.5, cymTapY: 0.5, cymTapN: 0,   // canvas tap strike (CYMATICS)
};

function bindSlider(id, valId, key) {
  const sl = document.getElementById(id);
  const vl = document.getElementById(valId);
  sl.addEventListener('input', () => {
    params[key] = parseFloat(sl.value);
    vl.textContent = parseFloat(sl.value).toFixed(2);
  });
}
bindSlider('sl-sb',     'v-sb',     'mulSb');
bindSlider('sl-bass',   'v-bass',   'mulBass');
bindSlider('sl-mid',    'v-mid',    'mulMid');
bindSlider('sl-high',   'v-high',   'mulHigh');
bindSlider('sl-spring',      'v-spring',      'spring');
bindSlider('sl-dissonance',  'v-dissonance',  'dissonanceStrength');
bindSlider('sl-trail',       'v-trail',       'trail');
bindSlider('sl-glow',        'v-glow',        'glow');
bindSlider('sl-timbre',      'v-timbre',      'timbreStrength');

btnTune.addEventListener('click', () => {
  const hidden = tunePanel.classList.toggle('hidden');
  btnTune.classList.toggle('active', !hidden);
  btnTune.style.bottom = hidden ? '20px' : (tunePanel.offsetHeight + 32) + 'px';
  posthog.capture('tune_panel_toggled', { open: !hidden });
});

// ── Reset to defaults ────────────────────────────────────────────────
const DEFAULTS = {
  mulSb: 1, mulBass: 3, mulMid: 1, mulHigh: 1, spring: 0.3,
  dissonanceStrength: 1, trail: 0.5, glow: 1, timbreStrength: 1,
  modeDrums: 1, modeBass: 0, modeLead: 0, modeAtmos: 0, modePads: 0,
};

function resetToDefaults() {
  Object.assign(params, DEFAULTS);
  [
    ['sl-sb',         'v-sb',         'mulSb'],
    ['sl-bass',       'v-bass',       'mulBass'],
    ['sl-mid',        'v-mid',        'mulMid'],
    ['sl-high',       'v-high',       'mulHigh'],
    ['sl-spring',     'v-spring',     'spring'],
    ['sl-dissonance', 'v-dissonance', 'dissonanceStrength'],
    ['sl-trail',      'v-trail',      'trail'],
    ['sl-glow',       'v-glow',       'glow'],
    ['sl-timbre',     'v-timbre',     'timbreStrength'],
  ].forEach(([slId, vlId, key]) => {
    const sl = document.getElementById(slId);
    const vl = document.getElementById(vlId);
    sl.value = DEFAULTS[key];
    vl.textContent = parseFloat(DEFAULTS[key]).toFixed(2);
  });
  Object.entries(modeParamKey).forEach(([band, key]) => {
    const sel = document.getElementById(`mode-${band}`);
    if (sel) sel.value = String(DEFAULTS[key] ?? 0);
  });
}

document.getElementById('btn-reset-tune').addEventListener('click', resetToDefaults);

function randomizeTune() {
  const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];

  const rand = {
    mulSb:              rnd(0.2, 3.0),
    mulBass:            rnd(0.5, 5.0),
    mulMid:             rnd(0.2, 3.0),
    mulHigh:            rnd(0.2, 3.0),
    spring:             rnd(0.05, 1.0),
    dissonanceStrength: rnd(0.0, 2.5),
    trail:              rnd(0.0, 0.85),
    glow:               rnd(0.3, 1.8),
    modeDrums: pick([0,1,2,3]),
    modeBass:  pick([0,1,2,3,4]),
    modeLead:  pick([0,1,2,3]),
    modeAtmos: pick([0,1,2,3]),
    modePads:  pick([0,1,2]),
  };

  Object.assign(params, rand);

  [
    ['sl-sb',         'v-sb',         'mulSb'],
    ['sl-bass',       'v-bass',       'mulBass'],
    ['sl-mid',        'v-mid',        'mulMid'],
    ['sl-high',       'v-high',       'mulHigh'],
    ['sl-spring',     'v-spring',     'spring'],
    ['sl-dissonance', 'v-dissonance', 'dissonanceStrength'],
    ['sl-trail',      'v-trail',      'trail'],
    ['sl-glow',       'v-glow',       'glow'],
  ].forEach(([slId, vlId, key]) => {
    const sl = document.getElementById(slId);
    const vl = document.getElementById(vlId);
    sl.value = rand[key];
    vl.textContent = parseFloat(rand[key]).toFixed(2);
  });

  Object.entries(modeParamKey).forEach(([band, key]) => {
    const sel = document.getElementById(`mode-${band}`);
    if (sel) sel.value = String(rand[key] ?? 0);
  });

  posthog.capture('tune_randomized');
}

document.getElementById('btn-random-tune').addEventListener('click', randomizeTune);

// ── Tutorial ─────────────────────────────────────────────────────────
const TUTORIAL_STEPS = [
  { el: null,                title: 'Welcome to Bloom',  text: 'Bloom turns sound into light. Connect a MIDI keyboard or audio source and 25,000 particles react in real time.\n\nThis tour explains each control.' },
  { el: '#btn-midi',         title: 'MIDI',              text: 'Connect a MIDI keyboard or controller. Each note fires a ripple wave — pitch maps to horizontal position on screen.' },
  { el: '#btn-system',       title: 'Audio Source',      text: 'System Audio captures everything playing on your Mac, no driver needed. Or use Microphone, or load a file.\n\nEach audio band (bass, drums, melody) drives its own particle layer independently.' },
  { el: '#btn-tune',         title: 'Tune',              text: 'Open this panel to mute or solo each instrument band, switch movement styles (Burst, Shockwave…), or adjust sensitivity sliders.\n\nThe Bass slider controls how many particles are visible.' },
  { el: '#btn-color',        title: 'Band Colors',       text: 'Toggle debug colors:\nRed = drums\nBlue = bass\nGreen = lead\nMagenta = atmosphere\nOrange = pads\n\nUseful for tuning your mix.' },
  { el: '#mode-select',      title: 'Visual modes',      text: 'Pick a world: particles, silk ribbons, liquid metal, a fractal cathedral, sand resonance figures, a thunderstorm and more.' },
  { el: '#btn-train',        title: 'Train',             text: 'Teach Bloom which frequencies belong to which instrument by tapping along in rhythm with each band.\n\nHelps when automatic detection is off.' },
  { el: '#btn-ripple-color', title: 'Ripple Color',      text: 'Pick the accent color for MIDI note ripple waves using this color swatch.' },
];

let tutStep = -1;
const tutOverlay   = document.getElementById('tutorial-overlay');
const tutSpotlight = document.getElementById('tutorial-spotlight');
const tutTitleEl   = document.getElementById('tutorial-title');
const tutTextEl    = document.getElementById('tutorial-text');
const tutCounter   = document.getElementById('tutorial-counter');
const tutCard      = document.getElementById('tutorial-card');
const tutPrevBtn   = document.getElementById('tutorial-prev');
const tutNextBtn   = document.getElementById('tutorial-next');
const tutSkipBtn   = document.getElementById('tutorial-skip');
const btnHelp      = document.getElementById('btn-help');

function positionTutCard(rect) {
  const pad = 16, cardW = 280, cardH = 200;
  const vw = window.innerWidth, vh = window.innerHeight;
  let cy = rect ? rect.bottom + pad : vh / 2 - cardH / 2;
  if (rect && cy + cardH > vh - 20) cy = rect.top - pad - cardH;
  cy = Math.max(20, Math.min(cy, vh - cardH - 20));
  let cx = rect ? rect.left + rect.width / 2 - cardW / 2 : vw / 2 - cardW / 2;
  cx = Math.max(20, Math.min(cx, vw - cardW - 20));
  tutCard.style.cssText = `left:${cx}px; top:${cy}px; width:${cardW}px;`;
}

function showTutStep(n) {
  const step = TUTORIAL_STEPS[n];
  document.querySelectorAll('.tut-highlight').forEach(e => e.classList.remove('tut-highlight'));
  tutTitleEl.textContent  = step.title;
  tutTextEl.textContent   = step.text;
  tutCounter.textContent  = `${n + 1} / ${TUTORIAL_STEPS.length}`;
  tutPrevBtn.disabled     = n === 0;
  tutNextBtn.textContent  = n === TUTORIAL_STEPS.length - 1 ? 'Done ✓' : 'Next →';

  if (step.el) {
    const target = document.querySelector(step.el);
    if (target) {
      target.classList.add('tut-highlight');
      const r = target.getBoundingClientRect();
      const p = 10;
      Object.assign(tutSpotlight.style, {
        left:    (r.left - p) + 'px',
        top:     (r.top  - p) + 'px',
        width:   (r.width  + p * 2) + 'px',
        height:  (r.height + p * 2) + 'px',
        opacity: '1',
      });
      positionTutCard(r);
    }
  } else {
    tutSpotlight.style.opacity = '0';
    positionTutCard(null);
  }
}

function openTutorial() {
  tutStep = 0;
  tutOverlay.classList.add('active');
  uiEl.classList.remove('faded');
  uiEl.classList.add('tutorial-open');
  btnHelp.classList.add('active');
  showTutStep(0);
}

function closeTutorial() {
  tutStep = -1;
  tutOverlay.classList.remove('active');
  uiEl.classList.remove('tutorial-open');
  btnHelp.classList.remove('active');
  document.querySelectorAll('.tut-highlight').forEach(e => e.classList.remove('tut-highlight'));
}

btnHelp.addEventListener('click', () => {
  if (tutStep >= 0) { closeTutorial(); posthog.capture('tutorial_closed', { step: tutStep }); }
  else { openTutorial(); posthog.capture('tutorial_opened'); }
});
tutNextBtn.addEventListener('click', () => {
  if (tutStep === TUTORIAL_STEPS.length - 1) {
    closeTutorial();
    posthog.capture('tutorial_completed');
    return;
  }
  showTutStep(++tutStep);
  posthog.capture('tutorial_step', { step: tutStep, title: TUTORIAL_STEPS[tutStep].title });
});
tutPrevBtn.addEventListener('click', () => { if (tutStep > 0) showTutStep(--tutStep); });
tutSkipBtn.addEventListener('click', () => {
  posthog.capture('tutorial_skipped', { step: tutStep });
  closeTutorial();
});

// ── Template training ────────────────────────────────────────────────
const TRAIN_BANDS = ['kick', 'snare', 'bass', 'lead', 'atmos', 'pads'];
let trainTarget = null;   // which band button is selected

function updateTrainUI() {
  TRAIN_BANDS.forEach(k => {
    const btn = document.getElementById(`train-band-${k}`);
    btn.classList.toggle('active', trainTarget === k);
    btn.classList.toggle('has-tmpl', audio.hasTemplate(k));
  });
  const tapBtn    = document.getElementById('train-tap');
  const saveBtn   = document.getElementById('train-save');
  const clearBtn  = document.getElementById('train-clear');
  const countEl   = document.getElementById('train-count');
  const statusEl  = document.getElementById('train-status');

  const active = trainTarget !== null;
  tapBtn.disabled   = !active;
  saveBtn.disabled  = !active || audio.tapCount() === 0;
  clearBtn.disabled = !active || !audio.hasTemplate(trainTarget);

  if (!active) {
    statusEl.textContent = 'Select a band to train';
    countEl.textContent  = '';
  } else {
    const n = audio.tapCount();
    countEl.textContent  = n > 0 ? `${n} tap${n > 1 ? 's' : ''}` : '';
    if (audio.hasTemplate(trainTarget) && n === 0) {
      statusEl.textContent = 'Template saved — tap to retrain';
    } else if (n === 0) {
      statusEl.textContent = 'Tap in rhythm with the instrument';
    } else {
      statusEl.textContent = `${n >= 4 ? 'Ready to save' : 'Keep tapping'} (min 4 taps)`;
      saveBtn.disabled = n < 4;
    }
  }
}

btnTrain.addEventListener('click', () => {
  const hidden = trainPanel.classList.toggle('hidden');
  btnTrain.classList.toggle('active', !hidden);
  if (hidden) { trainTarget = null; audio.startTap(null); }
  posthog.capture('train_panel_toggled', { open: !hidden });
  updateTrainUI();
});

TRAIN_BANDS.forEach(k => {
  document.getElementById(`train-band-${k}`).addEventListener('click', () => {
    trainTarget = (trainTarget === k) ? null : k;
    audio.startTap(trainTarget);   // resets tap buffer for new target
    updateTrainUI();
  });
});

// Tap-tempo: TRAIN taps are rhythmic by design ("tap in rhythm with the
// instrument") — a steady series doubles as a tempo hint for the BeatTracker.
// Born from a user instinctively tapping the kick to fix a half-tempo lock.
const _tapTimes = [];
function registerTapTempo() {
  const now = performance.now();
  if (_tapTimes.length && now - _tapTimes[_tapTimes.length - 1] > 3000) _tapTimes.length = 0;
  _tapTimes.push(now);
  if (_tapTimes.length < 4) return;
  const recent = _tapTimes.slice(-8);
  const ints   = recent.slice(1).map((t, i) => t - recent[i]);
  const median = [...ints].sort((a, b) => a - b)[ints.length >> 1];
  if (ints.every(iv => Math.abs(iv - median) / median < 0.18)) {
    beat.tapHint(60000 / median, now / 1000);
    posthog.capture('tap_tempo_hint', { bpm: Math.round(60000 / median) });
  }
}

document.getElementById('train-tap').addEventListener('click', () => {
  if (!trainTarget) return;
  audio.recordTap();
  registerTapTempo();
  updateTrainUI();
});

document.getElementById('train-save').addEventListener('click', () => {
  if (audio.commitTemplate()) {
    posthog.capture('template_saved', { band: trainTarget });
    updateTrainUI();
  }
});

document.getElementById('train-clear').addEventListener('click', () => {
  if (!trainTarget) return;
  posthog.capture('template_cleared', { band: trainTarget });
  audio.clearTemplate(trainTarget);
  audio.startTap(trainTarget);
  updateTrainUI();
});

// Space = tap shortcut when training panel is open
window.addEventListener('keydown', e => {
  if (e.code === 'Space' && trainTarget && !trainPanel.classList.contains('hidden')) {
    e.preventDefault();
    audio.recordTap();
    registerTapTempo();
    // Flash the TAP button
    const tapBtn = document.getElementById('train-tap');
    tapBtn.classList.add('flash');
    setTimeout(() => tapBtn.classList.remove('flash'), 100);
    updateTrainUI();
  }
});

// ── Audio + MIDI + Harmony ───────────────────────────────────────────
const renderer = new Renderer(canvas);
const audio    = new AudioAnalyser();
const harmony  = new HarmonyAnalyzer({ bufferMs: 3000 });
const ripples  = new RippleManager();
let   lastMidiMs = 0;   // timestamp of most recent MIDI note-on
const midi     = new MIDIHandler({
  onNoteOn:  (pitch, velocity) => {
    harmony.noteOn(pitch, velocity);
    ripples.spawn(pitch);
    lastMidiMs = performance.now();
  },
  onNoteOff: (pitch) => harmony.noteOff(pitch),
  onCC:      (cc, value) => handleMidiCC(cc, value),
});

// ── MIDI learn: hardware knobs → Tune sliders ────────────────────────
// MAP arms learn mode; click a slider, turn a knob — bound. Bindings feed
// values through the sliders' normal input events, so every existing
// wiring (params, labels) works unchanged. Persisted in localStorage.
let midiMap  = {};   // cc number → slider element id
try { midiMap = JSON.parse(localStorage.getItem('bloom-midi-map') ?? '{}'); } catch (_) {}
let mapArmed = false;
let learnTarget = null;

function handleMidiCC(cc, value) {
  if (mapArmed && learnTarget) {
    midiMap[cc] = learnTarget;
    localStorage.setItem('bloom-midi-map', JSON.stringify(midiMap));
    const el = document.getElementById(learnTarget);
    if (el) el.style.outline = '';
    learnTarget = null;
    const btn = document.getElementById('btn-midi-map');
    btn.textContent = 'MAP ✓';
    setTimeout(() => { btn.textContent = mapArmed ? 'MAP…' : 'MAP'; }, 900);
    return;
  }
  const id = midiMap[cc];
  if (!id) return;
  const sl = document.getElementById(id);
  if (!sl) return;
  const min = parseFloat(sl.min), max = parseFloat(sl.max);
  sl.value = min + (value / 127) * (max - min);
  sl.dispatchEvent(new Event('input', { bubbles: true }));
}

function initMidiLearn() {
  const btn = document.getElementById('btn-midi-map');
  btn.addEventListener('click', () => {
    mapArmed = !mapArmed;
    btn.classList.toggle('active', mapArmed);
    btn.textContent = mapArmed ? 'MAP…' : 'MAP';
    if (!mapArmed && learnTarget) {
      const el = document.getElementById(learnTarget);
      if (el) el.style.outline = '';
      learnTarget = null;
    }
  });
  // While armed, clicking any Tune slider selects it as the learn target
  document.getElementById('tune').addEventListener('pointerdown', (e) => {
    if (!mapArmed || e.target.type !== 'range') return;
    if (learnTarget) {
      const prev = document.getElementById(learnTarget);
      if (prev) prev.style.outline = '';
    }
    learnTarget = e.target.id;
    e.target.style.outline = '1px solid rgba(120,200,255,0.8)';
  });
}
initMidiLearn();

// ── Structure + AutoVJ + generative drift + genre presets ───────────
const structure = new StructureAnalyzer();
const drift     = new GenerativeDrift();
const autovj    = new AutoVJ(params, {
  onModeChange: (band, mode) => {
    const sel = document.getElementById(`mode-${band}`);
    if (sel) sel.value = String(mode);
  },
});

const genreSelect = document.getElementById('genre-select');
const btnVj       = document.getElementById('btn-vj');

function applyGenre(key) {
  const g = GENRES[key] ?? GENRES.auto;
  audio.setBandRanges(g.bands);
  beat.setTempoPrior(g.tempo.center, g.tempo.sigma);
  autovj.setGenre(g);
  // Genre aesthetic defaults → params + sliders
  for (const [k, slId, vlId] of [['trail', 'sl-trail', 'v-trail'], ['glow', 'sl-glow', 'v-glow']]) {
    params[k] = g.defaults[k];
    const sl = document.getElementById(slId), vl = document.getElementById(vlId);
    if (sl) { sl.value = g.defaults[k]; vl.textContent = g.defaults[k].toFixed(2); }
  }
  genreSelect.classList.toggle('set', key !== 'auto');
  posthog.capture('genre_changed', { genre: key });
}

genreSelect.addEventListener('change', () => applyGenre(genreSelect.value));

btnVj.addEventListener('click', () => {
  autovj.enabled = !autovj.enabled;
  btnVj.classList.toggle('active', autovj.enabled);
  posthog.capture('autovj_toggled', { on: autovj.enabled });
});

// ── WLED strip mirror (needs the local relay: node tools/wled-relay.mjs) ──
const wled      = new WledSync(canvas);
const btnWled   = document.getElementById('btn-wled');
const wledHost  = document.getElementById('wled-host');
wledHost.value  = localStorage.getItem('bloom-wled-host') ?? '';

btnWled.addEventListener('click', async () => {
  if (wled.active) {
    wled.stop();
    btnWled.classList.remove('active');
    return;
  }
  const host = wledHost.value.trim();
  if (!host) {
    wledHost.classList.add('bad');
    wledHost.focus();
    setTimeout(() => wledHost.classList.remove('bad'), 1500);
    return;
  }
  btnWled.textContent = '...';
  try {
    const info = await wled.start(host);
    localStorage.setItem('bloom-wled-host', host);
    btnWled.textContent = 'WLED';
    btnWled.classList.add('active');
    btnWled.title = `Mirroring to "${info.name}" (${info.leds} LEDs)`;
    posthog.capture('wled_connected', { leds: info.leds });
  } catch (e) {
    btnWled.textContent = 'WLED ✕';
    wledHost.classList.add('bad');
    btnWled.title = `Not connected — is the relay running? (node tools/wled-relay.mjs)  ${e.message}`;
    setTimeout(() => { btnWled.textContent = 'WLED'; wledHost.classList.remove('bad'); }, 2500);
  }
});
wledHost.addEventListener('keydown', e => { if (e.key === 'Enter') btnWled.click(); });

// ── Projector: mirror the canvas into a clean second window ──────────
// canvas.captureStream costs nothing extra on the GPU — the projector
// window is just a fullscreen <video>. Drag it to the second display and
// double-click for fullscreen; the main window keeps all controls.
const btnProj = document.getElementById('btn-proj');
let projWin = null;

btnProj.addEventListener('click', () => {
  if (projWin && !projWin.closed) {
    projWin.close();
    projWin = null;
    btnProj.classList.remove('active');
    return;
  }
  projWin = window.open('', 'bloom-projector', 'width=960,height=540');
  if (!projWin) return;   // popup blocked
  projWin.document.write(
    '<!DOCTYPE html><title>Bloom — Projector</title>' +
    '<style>html,body{margin:0;height:100%;background:#000;overflow:hidden;cursor:none}' +
    'video{width:100vw;height:100vh;object-fit:contain}</style>' +
    '<body title="Double-click for fullscreen"></body>');
  const v = projWin.document.createElement('video');
  v.muted = true;
  v.autoplay = true;
  v.srcObject = canvas.captureStream(60);
  projWin.document.body.appendChild(v);
  projWin.document.body.addEventListener('dblclick', () => {
    if (projWin.document.fullscreenElement) projWin.document.exitFullscreen();
    else projWin.document.body.requestFullscreen();
  });
  btnProj.classList.add('active');
  const watch = setInterval(() => {
    if (!projWin || projWin.closed) {
      clearInterval(watch);
      btnProj.classList.remove('active');
      projWin = null;
    }
  }, 1500);
  posthog.capture('projector_opened');
});

// Debug/test handle — lets automated tests read live analysis state
window.__bloom = { beat, harmony, audio, params, structure, autovj, drift, midiCC: handleMidiCC };

// ── Preset / mode ────────────────────────────────────────────────────
let currentMode = 'particles';  // 'particles' | 'oscilloscope' | 'ascii' | 'silk' | 'flora'

function onConnected(label) {
  statusAudio.textContent = `Audio: ${label}`;
  statusAudio.classList.add('active');
  drift.reseed();   // each source/track gets its own generative character
  setTimeout(() => uiEl.classList.add('faded'), 1800);
}

async function init() {
  try {
    await renderer.init();
    await renderer.loadPreset(ParticlesPreset);
  } catch (e) {
    errorEl.style.display = 'block';
    errorEl.textContent   = e.message;
    return;
  }

  // Mode switch: particles ↔ oscilloscope ↔ ascii ↔ silk ↔ flora
  const MODES = {
    particles:    ParticlesPreset,
    oscilloscope: OscilloscopePreset,
    ascii:        AsciiPreset,
    silk:         SilkPreset,
    flora:        FloraPreset,
    fluid:        FluidPreset,
    ferro:        FerroPreset,
    void:         VoidPreset,
    cymatics:     CymaticsPreset,
    storm:        StormPreset,
    terra:        TerraPreset,
    swarm:        SwarmPreset,
    galaxy:       GalaxyPreset,
    glass:        GlassPreset,
    dither:       DitherPreset,
    acid:         AcidPreset,
    prism:        PrismPreset,
    fx:           FxPreset,
    type:         TypePreset,
  };
  const modeSelect = document.getElementById('mode-select');

  // Mode-specific controls appear only in their mode
  function updateModeControls(mode) {
    document.getElementById('btn-pal').style.display         = mode === 'void'     ? '' : 'none';
    document.getElementById('btn-sand-color').style.display  = mode === 'cymatics' ? '' : 'none';
    document.getElementById('btn-ascii-color').style.display = mode === 'ascii'    ? '' : 'none';
    document.getElementById('resolver-panel').classList.toggle('hidden', mode !== 'dither');
    document.getElementById('glass-panel').classList.toggle('hidden', mode !== 'glass');
    document.getElementById('btn-prism-env').style.display = mode === 'prism' ? '' : 'none';
    document.getElementById('fx-panel').classList.toggle('hidden', mode !== 'fx');
    document.getElementById('type-panel').classList.toggle('hidden', mode !== 'type');
  }
  updateModeControls('particles');

  async function setMode(mode) {
    currentMode = mode;
    await renderer.loadPreset(MODES[mode]);
    modeSelect.value = mode;
    updateModeControls(mode);
    posthog.capture('mode_changed', { mode });
  }
  window.__setMode = setMode;   // tests + AutoVJ preset rotation

  // CYMATICS: tap the plate — strike position in canvas UV (y down)
  canvas.addEventListener('pointerdown', (e) => {
    if (currentMode !== 'cymatics') return;
    const r = canvas.getBoundingClientRect();
    params.cymTapX = (e.clientX - r.left) / r.width;
    params.cymTapY = (e.clientY - r.top) / r.height;
    params.cymTapN++;
  });

  // Cinematic switch: 'fade' dips through black (phrase boundaries, manual
  // picks), 'flash' hides the cut inside a white drop flash (drops)
  let _switching = false;
  async function switchModeCinematic(mode, style = 'fade') {
    if (_switching || mode === currentMode) return;
    _switching = true;
    try {
      if (style === 'flash') {
        params.dropFlash = Math.max(params.dropFlash ?? 0, 0.9);
        await setMode(mode);
      } else {
        canvas.style.transition = 'opacity 0.45s ease';
        canvas.style.opacity = '0';
        await new Promise(r => setTimeout(r, 460));
        await setMode(mode);
        canvas.style.opacity = '1';
      }
    } finally {
      _switching = false;
    }
  }

  let lastManualModeMs = 0;
  // Shared media playlist — each media-capable panel (RESOLVER / STUDIO /
  // GLASS) has its own + MEDIA button and playlist editor, all backed by
  // the same list. Click a row = play now, ✕ = remove.
  const mediaInput = document.getElementById('media-input');
  const addMediaBtns = [...document.querySelectorAll('.btn-add-media')];
  for (const btn of addMediaBtns) btn.addEventListener('click', () => mediaInput.click());
  mediaInput.addEventListener('change', async () => {
    if (!mediaInput.files?.length) return;
    const n = await addMediaFiles(mediaInput.files);
    mediaInput.value = '';
    posthog.capture('media_loaded', { count: n });
  });

  const mediaListEls = [...document.querySelectorAll('.media-list')];
  function renderMediaList() {
    const items = mediaApi.list();
    const cur = mediaApi.index();
    for (const listEl of mediaListEls) {
      listEl.textContent = '';
      items.forEach((it, i) => {
        const row = document.createElement('div');
        row.className = 'media-row' + (i === cur ? ' playing' : '');
        const kind = document.createElement('span');
        kind.className = 'm-kind';
        kind.textContent = it.kind === 'video' ? 'VID' : 'IMG';
        const name = document.createElement('span');
        name.className = 'm-name';
        name.textContent = it.name ?? `item ${i + 1}`;
        const del = document.createElement('button');
        del.className = 'm-del';
        del.textContent = '\u2715';
        del.addEventListener('click', (e) => { e.stopPropagation(); mediaApi.remove(i); });
        row.addEventListener('click', () => mediaApi.select(i));
        row.append(kind, name, del);
        listEl.append(row);
      });
    }
    for (const btn of addMediaBtns)
      btn.textContent = items.length ? `+ MEDIA (${items.length})` : '+ MEDIA';
  }
  mediaApi.onchange(renderMediaList);

  // RESOLVER sliders → params
  for (const [id, key, vid] of [['rs-glitch', 'rsGlitch', 'rs-v-glitch'],
                                 ['rs-cell', 'rsCell', 'rs-v-cell'],
                                 ['rs-speed', 'rsSpeed', 'rs-v-speed']]) {
    const sl = document.getElementById(id);
    sl.addEventListener('input', () => {
      params[key] = parseFloat(sl.value);
      document.getElementById(vid).textContent = parseFloat(sl.value).toFixed(2);
    });
  }
  document.getElementById('rs-cut').addEventListener('change', e => {
    params.rsCutBars = parseInt(e.target.value, 10);
  });

  // GLASS panel → params
  const GL_SLIDERS = [['gl-ribs', 'glRibs', 'gl-v-ribs', 0],
                      ['gl-refr', 'glRefr', 'gl-v-refr', 2],
                      ['gl-blur', 'glBlur', 'gl-v-blur', 2],
                      ['gl-light', 'glLight', 'gl-v-light', 2],
                      ['gl-grain', 'glGrain', 'gl-v-grain', 2]];
  for (const [id, key, vid, dec] of GL_SLIDERS) {
    const sl = document.getElementById(id);
    sl.addEventListener('input', () => {
      params[key] = parseFloat(sl.value);
      document.getElementById(vid).textContent = parseFloat(sl.value).toFixed(dec);
    });
  }
  document.getElementById('gl-spec').addEventListener('change', e => { params.glSpec = e.target.checked; });
  document.getElementById('gl-shape').addEventListener('change', e => { params.glShape = parseInt(e.target.value, 10); });
  // STUDIO: per-effect dial sets (Ladybug-style), rendered dynamically
  const FX_DIALS = [
    /* ascii    */ [['Cell', 0.55], ['Contrast', 0.5], ['Colorize', 0.65], ['Invert', 0]],
    /* halftone */ [['Cell', 0.5], ['Angle', 0.1], ['Gain', 0.5], ['Mono', 0]],
    /* duotone  */ [['Levels', 0.45], ['Hue A', 0.62], ['Hue B', 0.12], ['Contrast', 0.5]],
    /* glitch   */ [['Blocks', 0.5], ['RGB split', 0.35], ['Scanlines', 0.5], ['Rate', 0.4]],
    /* edges    */ [['Thickness', 0.35], ['Glow', 0.6], ['Hue', 0.55], ['BG mix', 0.06]],
    /* riso     */ [['Cell', 0.55], ['Ink hue', 0.02], ['Misreg', 0.5], ['Paper', 0.5]],
    /* contour  */ [['Levels', 0.5], ['Thickness', 0.35], ['Glow', 0.6], ['Flow', 0.5]],
    /* matrix   */ [['Cell', 0.5], ['Gap', 0.4], ['Palette', 0.9], ['Glow', 0.5]],
  ];
  params.fxP = FX_DIALS[0].map(d => d[1]);
  const fxDialsEl = document.getElementById('fx-dials');
  function renderFxDials() {
    const fx = params.fxEffect ?? 0;
    params.fxP = FX_DIALS[fx].map(d => d[1]);
    fxDialsEl.textContent = '';
    FX_DIALS[fx].forEach(([label, def], i) => {
      const row = document.createElement('div');
      row.className = 'tune-row';
      const lb = document.createElement('span');
      lb.className = 'tune-label';
      lb.textContent = label;
      const sl = document.createElement('input');
      sl.type = 'range'; sl.min = '0'; sl.max = '1'; sl.step = '0.02'; sl.value = def;
      const vl = document.createElement('span');
      vl.className = 'tune-val';
      vl.textContent = def.toFixed(2);
      sl.addEventListener('input', () => {
        params.fxP[i] = parseFloat(sl.value);
        vl.textContent = parseFloat(sl.value).toFixed(2);
      });
      row.append(lb, sl, vl);
      fxDialsEl.append(row);
    });
  }
  document.getElementById('fx-effect').addEventListener('change', e => {
    params.fxEffect = parseInt(e.target.value, 10);
    renderFxDials();
  });
  renderFxDials();
  document.getElementById('fx-react').addEventListener('input', e => {
    params.fxReact = parseFloat(e.target.value);
    document.getElementById('fx-v-react').textContent = parseFloat(e.target.value).toFixed(2);
  });
  // TYPE panel
  document.getElementById('ty-text').addEventListener('input', e => { params.tyText = e.target.value; });
  document.getElementById('ty-mode').addEventListener('change', e => { params.tyMode = parseInt(e.target.value, 10); });
  for (const k of ['size', 'interval', 'amp', 'freq', 'speed']) {
    const sl = document.getElementById('ty-' + k);
    sl.addEventListener('input', () => {
      params['ty' + k[0].toUpperCase() + k.slice(1)] = parseFloat(sl.value);
      document.getElementById('ty-v-' + k).textContent = parseFloat(sl.value).toFixed(2);
    });
  }
  {
    const btn = document.getElementById('ty-color-btn');
    const inp = document.getElementById('ty-color');
    let picked = false;
    btn.addEventListener('click', () => {
      if (picked) { picked = false; params.tyColor = null; btn.style.background = 'rgba(255,255,255,0.25)'; }
      else inp.click();
    });
    inp.addEventListener('input', e => {
      picked = true;
      const hex = e.target.value;
      params.tyColor = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
      btn.style.background = hex;
    });
  }
  const btnPrismEnv = document.getElementById('btn-prism-env');
  btnPrismEnv.addEventListener('click', () => {
    params.prismClassic = !params.prismClassic;
    btnPrismEnv.textContent = params.prismClassic ? 'CLASSIC' : 'STUDIO';
  });
  document.getElementById('gl-src').addEventListener('change', e => { params.glSrc = e.target.value; });
  function glApplyPreset(vals) {
    for (const [id, key, vid, dec] of GL_SLIDERS) {
      if (key in vals) {
        const sl = document.getElementById(id);
        sl.value = vals[key];
        params[key] = vals[key];
        document.getElementById(vid).textContent = vals[key].toFixed(dec);
      }
    }
    document.getElementById('gl-spec').checked = !!vals.glSpec;
    params.glSpec = !!vals.glSpec;
  }
  document.getElementById('gl-preset-gloss').addEventListener('click', () =>
    glApplyPreset({ glRefr: 1.15, glBlur: 0.45, glLight: 0.1, glGrain: 0.03, glSpec: false }));
  document.getElementById('gl-preset-matte').addEventListener('click', () =>
    glApplyPreset({ glRefr: 0.55, glBlur: 1.55, glLight: 0.55, glGrain: 0.65, glSpec: false }));

  modeSelect.addEventListener('change', () => {
    lastManualModeMs = performance.now();
    switchModeCinematic(modeSelect.value, 'fade');
  });

  // ── AutoVJ preset rotation: whole worlds rotate on big musical borders ──
  // (drops sometimes, every 16 phrases otherwise). Backs off for 45 s after
  // a manual pick so the user always wins.
  // city/galaxy join the pool once their presets land (stubs render black)
  const VJ_PRESET_POOL = ['particles', 'silk', 'flora', 'fluid', 'void', 'cymatics', 'storm', 'terra', 'swarm', 'galaxy', 'glass', 'acid', 'prism', 'type'];   // fx needs media — manual only
  let _phrasesSincePreset = 0;

  function rotatePreset(style) {
    const options = VJ_PRESET_POOL.filter(m => m !== currentMode && MODES[m]);
    const next = options[(Math.random() * options.length) | 0];
    _phrasesSincePreset = 0;
    switchModeCinematic(next, style);
  }

  function autoRotate(st) {
    if (!autovj.enabled || _switching) return;
    if (performance.now() - lastManualModeMs < 45000) return;
    if (st.onPhrase && ++_phrasesSincePreset >= 16) rotatePreset('fade');
    else if (st.onDrop && Math.random() < 0.35) rotatePreset('flash');
  }
  window.__autoRotate = { rotatePreset };   // test hook

  btnMidi.addEventListener('click', async () => {
    try {
      const inputs = await midi.connect();
      statusMidi.textContent = `MIDI: ${inputs.length ? inputs.join(', ') : 'connected'}`;
      statusMidi.classList.add('active');
      btnMidi.classList.add('active');
      posthog.capture('midi_connected', { input_count: inputs.length });
    } catch (e) {
      statusMidi.textContent = 'MIDI: ' + e.message;
      statusMidi.classList.add('error');
      console.error('MIDI:', e);
    }
  });

  // VOID palette cycler (persisted)
  const PAL_NAMES = ['KEY', 'EMBER', 'GLACIER', 'SYNTH', 'BONE'];
  const btnPal = document.getElementById('btn-pal');
  params.voidPalette = parseInt(localStorage.getItem('bloom-void-pal') ?? '0', 10) || 0;
  btnPal.textContent = params.voidPalette ? PAL_NAMES[params.voidPalette] : 'PAL';
  btnPal.addEventListener('click', () => {
    params.voidPalette = (params.voidPalette + 1) % PAL_NAMES.length;
    localStorage.setItem('bloom-void-pal', String(params.voidPalette));
    btnPal.textContent = PAL_NAMES[params.voidPalette];
    btnPal.classList.toggle('active', params.voidPalette > 0);
  });

  // Gesture control: webcam hand steers the composition (Motion Lab style)
  const gesture    = new GestureControl();
  const btnCam     = document.getElementById('btn-cam');
  const camPreview = document.getElementById('cam-preview');
  const camDot     = document.getElementById('cam-dot');
  btnCam.addEventListener('click', async () => {
    if (gesture.active) {
      gesture.stop();
      camPreview.querySelector('video')?.remove();
      camPreview.classList.add('hidden');
      btnCam.classList.remove('active');
      return;
    }
    btnCam.textContent = '...';
    try {
      await gesture.start();
      camPreview.prepend(gesture.video);
      camPreview.classList.remove('hidden');
      btnCam.classList.add('active');
      btnCam.textContent = 'CAM';
      posthog.capture('gesture_enabled');
    } catch (e) {
      console.error('gesture:', e);
      btnCam.textContent = 'ERR';
      setTimeout(() => { btnCam.textContent = 'CAM'; }, 1500);
    }
  });

  // Cymatics sand colour
  const btnSandColor   = document.getElementById('btn-sand-color');
  const sandColorInput = document.getElementById('sand-color-input');
  btnSandColor.addEventListener('click', () => sandColorInput.click());
  sandColorInput.addEventListener('input', e => {
    const hex = e.target.value;
    params.sandColor = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
    btnSandColor.style.background  = hex + '59';
    btnSandColor.style.borderColor = hex + 'a6';
  });

  const btnAsciiColor   = document.getElementById('btn-ascii-color');
  const asciiColorInput = document.getElementById('ascii-color-input');
  btnAsciiColor.addEventListener('click', () => asciiColorInput.click());
  asciiColorInput.addEventListener('input', e => {
    const hex = e.target.value;
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    params.asciiColor = [r, g, b];
    btnAsciiColor.style.background  = hex + '59';   // 35% alpha
    btnAsciiColor.style.borderColor = hex + 'a6';   // 65% alpha
    posthog.capture('ascii_color_changed', { color: hex });
  });

  btnRippleColor.addEventListener('click', () => rippleColorInput.click());
  rippleColorInput.addEventListener('input', e => {
    const hex = e.target.value;
    ripples.setColor(hex);
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    btnRippleColor.style.background  = `rgba(${r},${g},${b},0.2)`;
    btnRippleColor.style.borderColor = `rgba(${r},${g},${b},0.5)`;
  });

  function showAudioError(e) {
    statusAudio.textContent = 'Audio: ' + (e.name === 'NotAllowedError' ? 'cancelled' : e.message);
    statusAudio.classList.remove('active');
    statusAudio.classList.add('error');
  }

  btnSystem.addEventListener('click', async () => {
    statusAudio.classList.remove('error');
    try { await audio.connectSystemAudio(); onConnected('system'); posthog.capture('audio_connected', { source: 'system' }); }
    catch (e) { console.error('System audio:', e); showAudioError(e); posthog.capture('audio_connect_failed', { source: 'system', error: e.message }); }
  });

  btnMic.addEventListener('click', async () => {
    statusAudio.classList.remove('error');
    try { await audio.connectMicrophone(); onConnected('microphone'); posthog.capture('audio_connected', { source: 'microphone' }); }
    catch (e) { console.error('Mic:', e); showAudioError(e); posthog.capture('audio_connect_failed', { source: 'microphone', error: e.message }); }
  });

  btnFile.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      await audio.connectFile(file);
      onConnected(file.name);
      showTransport(file.name);
      posthog.capture('audio_connected', { source: 'file', file_type: file.type, file_size_mb: (file.size / 1048576).toFixed(1) });
    } catch (err) { console.error('File:', err); }
  });

  updateTrainUI();

  // ── Transport ──────────────────────────────────────────────────────
  const transportEl      = document.getElementById('transport');
  const transportNameEl  = document.getElementById('transport-name');
  const transportTimeEl  = document.getElementById('transport-time');
  const transportDurEl   = document.getElementById('transport-duration');
  const transportScrub   = document.getElementById('transport-scrub');
  const transportPlayBtn = document.getElementById('transport-playpause');
  const transportRemBtn  = document.getElementById('transport-remove');
  let   _transportTimer  = null;

  function fmtTime(s) {
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }

  function updateTransportUI() {
    if (!audio.hasFile) return;
    const t   = audio.getPlaybackTime();
    const dur = audio.getDuration();
    transportTimeEl.textContent = fmtTime(t);
    transportDurEl.textContent  = fmtTime(dur);
    if (!transportScrub._seeking) transportScrub.value = dur > 0 ? (t / dur) * 100 : 0;
    if (!audio.isPlaying && t >= dur - 0.05 && dur > 0) {
      transportPlayBtn.textContent = '↺';
    } else {
      transportPlayBtn.textContent = audio.isPlaying ? '||' : '▶';
    }
  }

  function showTransport(filename) {
    transportNameEl.textContent = filename.length > 22 ? filename.slice(0, 20) + '…' : filename;
    transportEl.classList.remove('hidden');
    updateTransportUI();
    if (_transportTimer) clearInterval(_transportTimer);
    _transportTimer = setInterval(updateTransportUI, 200);
  }

  function hideTransport() {
    transportEl.classList.add('hidden');
    if (_transportTimer) { clearInterval(_transportTimer); _transportTimer = null; }
  }

  transportPlayBtn.addEventListener('click', () => {
    if (!audio.hasFile) return;
    const t = audio.getPlaybackTime(), dur = audio.getDuration();
    if (!audio.isPlaying && t >= dur - 0.05 && dur > 0) {
      audio.seek(0);
      audio.play();
      posthog.capture('file_played', { restart: true });
    } else if (audio.isPlaying) {
      audio.pause();
      posthog.capture('file_paused', { position_s: Math.round(t) });
    } else {
      audio.play();
      posthog.capture('file_played', { position_s: Math.round(t) });
    }
    updateTransportUI();
  });

  // 'input' fires during drag — update time display without seeking (avoids audio glitches)
  transportScrub.addEventListener('input', () => {
    transportScrub._seeking = true;
    transportTimeEl.textContent = fmtTime((parseFloat(transportScrub.value) / 100) * audio.getDuration());
  });
  // 'change' fires reliably on mouseup/touchend even if pointer drifts off element
  transportScrub.addEventListener('change', () => {
    const ratio = parseFloat(transportScrub.value) / 100;
    audio.seek(ratio);
    transportScrub._seeking = false;
    posthog.capture('file_seeked', { position_pct: Math.round(ratio * 100) });
    updateTransportUI();
  });

  transportRemBtn.addEventListener('click', () => {
    posthog.capture('file_removed');
    audio.removeFile();
    hideTransport();
    statusAudio.textContent = 'Audio: not connected';
    statusAudio.classList.remove('active');
    uiEl.classList.remove('faded');
  });

  // ── Video recording ────────────────────────────────────────────────
  const btnRecord = document.getElementById('btn-record');
  let   _recorder = null;
  let   _recChunks = [];

  function startRecording() {
    const videoStream = canvas.captureStream(30);
    const tracks = [...videoStream.getVideoTracks()];
    const audioStream = audio.enableMediaStreamOutput();
    if (audioStream) tracks.push(...audioStream.getAudioTracks());
    const combined = new MediaStream(tracks);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus' : 'video/webm';
    _recorder  = new MediaRecorder(combined, { mimeType: mime });
    _recChunks = [];
    _recorder.ondataavailable = e => { if (e.data.size > 0) _recChunks.push(e.data); };
    _recorder.onstop = () => {
      const blob = new Blob(_recChunks, { type: 'video/webm' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `bloom-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.webm`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      btnRecord.classList.remove('active');
      btnRecord.textContent = 'REC';
    };
    _recorder.start(1000);
    btnRecord.classList.add('active');
    btnRecord.textContent = '■ STOP';
  }

  function stopRecording() {
    if (_recorder && _recorder.state !== 'inactive') _recorder.stop();
  }

  btnRecord.addEventListener('click', () => {
    if (_recorder && _recorder.state === 'recording') {
      stopRecording();
      posthog.capture('recording_stopped');
    } else {
      startRecording();
      posthog.capture('recording_started');
    }
  });

  window.addEventListener('beforeunload', () => {
    posthog.capture('session_end', { duration_s: Math.round((Date.now() - _sessionStart) / 1000) });
  });

  let lastFrameTs = 0;
  let fieldMs     = 0;   // tension-warped clock for the shader: builds run hot
  let _kaleidoSpin = 0;

  // Adaptive resolution: when frame time sags, step render scale down
  // (1.5 → 1.0 dpr) before the sag becomes visible stutter; recover slowly.
  let _frameEmaMs = 16.7;
  let _lastDprAdjust = 0;
  function adaptDpr(ts, dtMs) {
    _frameEmaMs = _frameEmaMs * 0.95 + dtMs * 0.05;
    if (ts - _lastDprAdjust < 2000) return;
    if (_frameEmaMs > 19 && dprCap > 1.0) {
      dprCap = Math.max(1.0, dprCap - 0.25);
      _lastDprAdjust = ts;
      resize();
    } else if (_frameEmaMs < 13 && dprCap < 1.5 && ts - _lastDprAdjust > 10000) {
      dprCap = Math.min(1.5, dprCap + 0.25);
      _lastDprAdjust = ts;
      resize();
    }
  }

  function frame(ts) {
    const dtS = Math.min(ts - (lastFrameTs || ts), 50) / 1000;
    adaptDpr(ts, dtS * 1000);
    lastFrameTs = ts;

    const rawBands = audio.update();
    const bands = applyBandMutes(rawBands);

    // Beat tracking on unmuted kick+snare+high (band mutes shouldn't kill tempo)
    beat.update(ts / 1000, rawBands.kick, rawBands.snare, rawBands.high, dtS);
    params.beatT    = beat.beatT;
    params.beatConf = beat.conf;
    params.barPos   = beat.barPos();
    if (!bpmWidget.classList.contains('hidden')) updateBpmWidget();

    // Harmony: MIDI drives tonality when active; audio chromagram as fallback
    const fftEnergy    = (bands.bass + bands.mid + bands.high) / 3;
    const midiSilentMs = performance.now() - lastMidiMs;
    const harm = (lastMidiMs > 0 && midiSilentMs < 8000)
      ? harmony.update(fftEnergy)
      : harmony.updateFromChroma(audio.chromagram, fftEnergy);
    params.tonality   = harm.tonality;
    params.pulse      = harm.pulse;
    params.dissonance = harm.dissonance;
    params.keyHue     = harm.keyHue;
    params.keyConf    = harm.keyConf;

    // Structure → AutoVJ → generative drift
    const st = structure.update(rawBands, beat, dtS);
    autovj.update(st, dtS);
    autoRotate(st);
    drift.update(dtS, fftEnergy);
    params.tension    = st.tension;
    params.dropPulse  = st.dropPulse;
    params.driftScale = drift.scale;
    params.driftRot   = drift.rot;
    // Composition centre = slow generative wander + the scene's committed offset
    params.driftX     = drift.offX + (params.sceneOffX ?? 0);
    params.driftY     = drift.offY + (params.sceneOffY ?? 0);

    // Composite camera: builds punch in, drops kick, drift breathes slowly.
    // An active kaleidoscope gets a constant slow spin — static mandalas bore.
    if (params.kaleidoK >= 2) _kaleidoSpin += dtS * 0.06;
    params.camZoom = 1 + st.tension * 0.15 + st.dropPulse * 0.25
                   + (params.zoomPunch ?? 0) * 0.35
                   + Math.max(0, (drift.scale - 1.05)) * 0.30;
    params.camRot  = drift.rot * 0.35 + _kaleidoSpin;

    // Gesture: hand pans the composition, pinch zooms, fast swipe pops
    if (gesture.active) {
      gesture.update(dtS);
      const g = gesture.present;
      params.driftX  += (gesture.x - 0.5) * 0.9 * g;
      params.driftY  += (0.5 - gesture.y) * 0.7 * g;
      params.camZoom += gesture.pinch * 0.45 * g;
      if (gesture.vel > 1.5 && g > 0.5)
        params.zoomPunch = Math.max(params.zoomPunch ?? 0, Math.min(gesture.vel * 0.18, 0.6));
      camDot.style.left = (gesture.x * 100) + '%';
      camDot.style.top  = (gesture.y * 100) + '%';
      camDot.style.opacity = g > 0.3 ? 1 : 0;
    }

    // Post-chain inputs: nebula/grain clock, sub-bass breathing, echo steps
    // (scene picks a per-frame step at 60 fps; correct it for real frame time)
    const dt60 = dtS * 1000 / 16.67;
    params.anamorphic   = currentMode === 'fluid' ? 1.3 : (params.anamorphicScene ?? 0);
    params.timeS        = ts / 1000;
    params.subBassLevel = bands.subBass;
    // Timbre reaction, scaled by the user's Timbre slider (0 = off)
    params.sharpness    = audio.sharpness * (params.timbreStrength ?? 1);
    params.echoZoom     = Math.pow(params.echoZoomBase ?? 1, dt60);
    params.echoRot      = (params.echoRotBase ?? 0) * dt60;

    params.rippleData = ripples.getUniforms();
    ripples.update();

    updateDebug(bands, harm, st);

    // Push stereo waveform to oscilloscope preset if active
    if (currentMode === 'oscilloscope' && renderer.preset && audio.waveformL) {
      renderer.preset.pushFrame(audio.waveformL, audio.waveformR);
    }

    // Warped clock: tension accelerates all field motion, monotonic so the
    // field phase never jumps when tension eases off
    fieldMs += dtS * 1000 * (1 + st.tension * 0.6);
    // A preset throwing once must not kill the whole animation loop
    try {
      renderer.render(fieldMs, bands, params);
    } catch (e) {
      if ((window.__renderErrs = (window.__renderErrs ?? 0) + 1) < 5) console.error('[render]', e);
    }
    wled.update(ts);
    // If the relay died mid-stream WledSync gives up on its own — reflect that
    if (!wled.active && btnWled.classList.contains('active')) btnWled.classList.remove('active');
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ── Share preset via URL ───────────────────────────────────────────
  // SHARE snapshots the mode + every control into a base64url hash and
  // copies the link; opening such a link restores the exact look.
  const SHARE_SKIP = new Set(['mode-select', 'media-input', 'file-input',
                              'wled-host', 'ty-color', 'transport-scrub']);
  function snapshotPreset() {
    const els = {};
    for (const el of document.querySelectorAll('input[id], select[id]')) {
      if (SHARE_SKIP.has(el.id) || el.type === 'file') continue;
      els[el.id] = el.type === 'checkbox' ? el.checked : el.value;
    }
    return {
      mode: currentMode,
      els,
      fxP: [...(params.fxP ?? [])],
      pal: params.voidPalette ?? 0,
      prismClassic: !!params.prismClassic,
      tyColor: params.tyColor ? document.getElementById('ty-color').value : null,
    };
  }
  async function applyPreset(s) {
    if (MODES[s.mode]) await setMode(s.mode);
    // selects first — fx-effect's change re-renders its dial set
    for (const pass of ['SELECT', 'INPUT']) {
      for (const [id, v] of Object.entries(s.els ?? {})) {
        const el = document.getElementById(id);
        if (!el || el.tagName !== pass) continue;
        if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
        el.dispatchEvent(new Event(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', { bubbles: true }));
      }
    }
    document.querySelectorAll('#fx-dials input').forEach((sl, i) => {
      if (s.fxP?.[i] === undefined) return;
      sl.value = s.fxP[i];
      sl.dispatchEvent(new Event('input', { bubbles: true }));
    });
    params.voidPalette = s.pal ?? 0;
    btnPal.textContent = params.voidPalette ? PAL_NAMES[params.voidPalette] : 'PAL';
    btnPal.classList.toggle('active', params.voidPalette > 0);
    params.prismClassic = !!s.prismClassic;
    btnPrismEnv.textContent = params.prismClassic ? 'CLASSIC' : 'STUDIO';
    if (s.tyColor) {
      const inp = document.getElementById('ty-color');
      inp.value = s.tyColor;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  const b64e = (o) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const b64d = (s) => JSON.parse(new TextDecoder().decode(
    Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))));

  const btnShare = document.getElementById('btn-share');
  btnShare.addEventListener('click', async () => {
    const hash = '#p=' + b64e(snapshotPreset());
    history.replaceState(null, '', hash);
    try { await navigator.clipboard.writeText(location.origin + location.pathname + hash); } catch (_) {}
    btnShare.textContent = 'COPIED';
    setTimeout(() => { btnShare.textContent = 'SHARE'; }, 1200);
    posthog.capture('preset_shared', { mode: currentMode });
  });
  if (location.hash.startsWith('#p=')) {
    try { await applyPreset(b64d(location.hash.slice(3))); }
    catch (e) { console.warn('preset link parse failed', e); }
  }
}

init();
