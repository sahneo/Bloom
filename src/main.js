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
  modeDrums: 1, modeBass: 0, modeLead: 0, modeAtmos: 0, modePads: 0,
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
  btnTune.style.bottom = hidden ? '20px' : (tunePanel.offsetHeight + 32) + 'px';
});

// ── Reset to defaults ────────────────────────────────────────────────
const DEFAULTS = {
  mulSb: 1, mulBass: 3, mulMid: 1, mulHigh: 1, spring: 0.3,
  dissonanceStrength: 1,
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

// ── Tutorial ─────────────────────────────────────────────────────────
const TUTORIAL_STEPS = [
  { el: null,                title: 'Welcome to Bloom',  text: 'Bloom turns sound into light. Connect a MIDI keyboard or audio source and 25,000 particles react in real time.\n\nThis tour explains each control.' },
  { el: '#btn-midi',         title: 'MIDI',              text: 'Connect a MIDI keyboard or controller. Each note fires a ripple wave — pitch maps to horizontal position on screen.' },
  { el: '#btn-system',       title: 'Audio Source',      text: 'System Audio captures everything playing on your Mac, no driver needed. Or use Microphone, or load a file.\n\nEach audio band (bass, drums, melody) drives its own particle layer independently.' },
  { el: '#btn-tune',         title: 'Tune',              text: 'Open this panel to mute or solo each instrument band, switch movement styles (Burst, Shockwave…), or adjust sensitivity sliders.\n\nThe Bass slider controls how many particles are visible.' },
  { el: '#btn-color',        title: 'Band Colors',       text: 'Toggle debug colors:\nRed = drums\nBlue = bass\nGreen = lead\nMagenta = atmosphere\nOrange = pads\n\nUseful for tuning your mix.' },
  { el: '#btn-oscillo',      title: 'Oscilloscope',      text: 'Switch to waveform mode to see the raw stereo audio signal instead of particles.' },
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

btnHelp.addEventListener('click', () => tutStep >= 0 ? closeTutorial() : openTutorial());
tutNextBtn.addEventListener('click', () => {
  if (tutStep === TUTORIAL_STEPS.length - 1) { closeTutorial(); return; }
  showTutStep(++tutStep);
});
tutPrevBtn.addEventListener('click', () => { if (tutStep > 0) showTutStep(--tutStep); });
tutSkipBtn.addEventListener('click', closeTutorial);

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
    try {
      await audio.connectFile(file);
      onConnected(file.name);
      showTransport(file.name);
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
      transportPlayBtn.textContent = '↩';
    } else {
      transportPlayBtn.textContent = audio.isPlaying ? '⏸' : '▶';
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
    } else if (audio.isPlaying) {
      audio.pause();
    } else {
      audio.play();
    }
    updateTransportUI();
  });

  transportScrub.addEventListener('mousedown',  () => { transportScrub._seeking = true; });
  transportScrub.addEventListener('touchstart', () => { transportScrub._seeking = true; }, { passive: true });
  const _commitScrub = () => {
    audio.seek(parseFloat(transportScrub.value) / 100);
    transportScrub._seeking = false;
  };
  transportScrub.addEventListener('mouseup',  _commitScrub);
  transportScrub.addEventListener('touchend', _commitScrub);

  transportRemBtn.addEventListener('click', () => {
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
    if (_recorder && _recorder.state === 'recording') stopRecording();
    else startRecording();
  });

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
