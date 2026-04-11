import { Renderer }        from './renderer.js';
import { AudioAnalyser }   from './audio.js';
import { ParticlesPreset } from './presets/particles.js';

const canvas      = document.getElementById('canvas');
const errorEl     = document.getElementById('error');
const uiEl        = document.getElementById('ui');
const statusAudio = document.getElementById('status-audio');
const btnSystem   = document.getElementById('btn-system');
const btnMic      = document.getElementById('btn-mic');
const btnFile     = document.getElementById('btn-file');
const fileInput   = document.getElementById('file-input');

function resize() {
  const dpr = Math.min(devicePixelRatio, 1.5);
  canvas.width  = Math.round(window.innerWidth  * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
}
window.addEventListener('resize', resize);
resize();

const renderer = new Renderer(canvas);
const audio    = new AudioAnalyser();

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

  function frame(ts) {
    renderer.render(ts, audio.update());
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

init();
