import { Renderer }           from './renderer.js';
import { AudioAnalyser }      from './audio.js';
import { MIDIHandler }        from './midi.js';
import { HarmonyAnalyzer }    from './harmony.js';
import { RippleManager }      from './ripples.js';
import { ParticlesPreset }    from './presets/particles.js';
import { OscilloscopePreset } from './presets/oscilloscope.js';

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
const btnOscillo       = document.getElementById('btn-oscillo');
const btnRippleColor   = document.getElementById('btn-ripple-color');
const rippleColorInput = document.getElementById('ripple-color-input');

function resize() {
  const dpr = Math.min(devicePixelRatio, 1.5);
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
    updateBandUI();
  });
  document.getElementById(`solo-${k}`).addEventListener('click', () => {
    bandState[k].solo = !bandState[k].solo;
    updateBandUI();
  });
  const sel = document.getElementById(`mode-${k}`);
  if (sel) sel.addEventListener('change', () => { params[modeParamKey[k]] = parseInt(sel.value); });
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
});

const DB_BANDS = [
  { key: 'kick',    label: 'KICK',  color: '#ff4444' },
  { key: 'snare',   label: 'SNARE', color: '#ff9944' },
  { key: 'bass',    label: 'BASS',  color: '#4488ff' },
  { key: 'mid',     label: 'MID',   color: '#44ff88' },
  { key: 'high',    label: 'HIGH',  color: '#cc44ff' },
  { key: 'subBass', label: 'SUB',   color: '#ffdd44' },
];

function updateDebug(bands, harm) {
  if (debugEl.classList.contains('hidden')) return;
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
  modeDrums: 0, modeBass: 0, modeLead: 0, modeAtmos: 0, modePads: 0,
  colorMode: 0,
  tonality:   0,   // -1 minor → +1 major (from HarmonyAnalyzer)
  pulse:      0,   // 0→1 note-attack flash (from HarmonyAnalyzer)
  dissonance:         0,   // 0 consonant → 1 dissonant (from HarmonyAnalyzer)
  dissonanceStrength: 1,   // user-controlled multiplier for the dissonance visual effect
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

btnTune.addEventListener('click', () => {
  const hidden = tunePanel.classList.toggle('hidden');
  btnTune.classList.toggle('active', !hidden);
  // When panel is open, keep it in bottom-right; move button up
  btnTune.style.bottom = hidden ? '20px' : (tunePanel.offsetHeight + 32) + 'px';
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
  updateTrainUI();
});

TRAIN_BANDS.forEach(k => {
  document.getElementById(`train-band-${k}`).addEventListener('click', () => {
    trainTarget = (trainTarget === k) ? null : k;
    audio.startTap(trainTarget);   // resets tap buffer for new target
    updateTrainUI();
  });
});

document.getElementById('train-tap').addEventListener('click', () => {
  if (!trainTarget) return;
  audio.recordTap();
  updateTrainUI();
});

document.getElementById('train-save').addEventListener('click', () => {
  if (audio.commitTemplate()) updateTrainUI();
});

document.getElementById('train-clear').addEventListener('click', () => {
  if (!trainTarget) return;
  audio.clearTemplate(trainTarget);
  audio.startTap(trainTarget);
  updateTrainUI();
});

// Space = tap shortcut when training panel is open
window.addEventListener('keydown', e => {
  if (e.code === 'Space' && trainTarget && !trainPanel.classList.contains('hidden')) {
    e.preventDefault();
    audio.recordTap();
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
});

// ── Preset / mode ────────────────────────────────────────────────────
let currentMode = 'particles';  // 'particles' | 'oscilloscope'

function onConnected(label) {
  statusAudio.textContent = `Audio: ${label}`;
  statusAudio.classList.add('active');
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

  // Mode switch: particles ↔ oscilloscope
  btnOscillo.addEventListener('click', async () => {
    if (currentMode === 'oscilloscope') {
      currentMode = 'particles';
      await renderer.loadPreset(ParticlesPreset);
      btnOscillo.classList.remove('active');
    } else {
      currentMode = 'oscilloscope';
      await renderer.loadPreset(OscilloscopePreset);
      btnOscillo.classList.add('active');
    }
  });

  btnMidi.addEventListener('click', async () => {
    try {
      const inputs = await midi.connect();
      statusMidi.textContent = `MIDI: ${inputs.length ? inputs.join(', ') : 'connected'}`;
      statusMidi.classList.add('active');
      btnMidi.classList.add('active');
    } catch (e) {
      statusMidi.textContent = 'MIDI: ' + e.message;
      statusMidi.classList.add('error');
      console.error('MIDI:', e);
    }
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

  btnSystem.addEventListener('click', async () => {
    try { await audio.connectSystemAudio(); onConnected('system'); }
    catch (e) { console.error('System audio:', e); }
  });

  btnMic.addEventListener('click', async () => {
    try { await audio.connectMicrophone(); onConnected('microphone'); }
    catch (e) { console.error('Mic:', e); }
  });

  btnFile.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try { await audio.connectFile(file); onConnected(file.name); }
    catch (e) { console.error('File:', e); }
  });

  updateTrainUI();

  function frame(ts) {
    const bands = applyBandMutes(audio.update());

    // Harmony: MIDI drives tonality when active; audio chromagram as fallback
    const fftEnergy    = (bands.bass + bands.mid + bands.high) / 3;
    const midiSilentMs = performance.now() - lastMidiMs;
    const harm = (lastMidiMs > 0 && midiSilentMs < 8000)
      ? harmony.update(fftEnergy)
      : harmony.updateFromChroma(audio.chromagram, fftEnergy);
    params.tonality   = harm.tonality;
    params.pulse      = harm.pulse;
    params.dissonance = harm.dissonance;

    params.rippleData = ripples.getUniforms();
    ripples.update();

    updateDebug(bands, harm);

    // Push stereo waveform to oscilloscope preset if active
    if (currentMode === 'oscilloscope' && renderer.preset && audio.waveformL) {
      renderer.preset.pushFrame(audio.waveformL, audio.waveformR);
    }

    renderer.render(ts, bands, params);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

init();
