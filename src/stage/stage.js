import * as THREE from 'three/webgpu';
import { createStageUniforms, paletteFromHarmony } from './uniforms.js';
import { buildWorld } from './world.js';
import { Director } from './director.js';
import { Looks, LOOKS } from './looks.js';

// STAGE — 3D mode. Implements Bloom's preset interface (init/tick/draw/
// destroy) so main.js treats it like any 2D world. Three.js WebGPURenderer
// borrows Bloom's GPUDevice + canvas context; without WebGPU (device null)
// three falls back to its WebGL2 backend on the same canvas.
//
// Reads (from params): beatT, beatConf, barPos, keyHue, keyConf, tonality,
// pulse, tension, dropPulse, structState, phrase, dropCount, noteQueue.
let _lookIdx = 0;   // survives mode switches within a session

export class StagePreset {
  static get LOOKS() { return LOOKS; }
  get selfPresent() { return true; }

  async init(device, format, canvas) {
    this.canvas = canvas;
    const opts = { canvas, antialias: false, alpha: false, powerPreference: 'high-performance' };
    if (device) { opts.device = device; opts.context = canvas.getContext('webgpu'); }
    else opts.forceWebGL = true;
    this.r = new THREE.WebGPURenderer(opts);
    await this.r.init();
    this.r.setPixelRatio(1);
    this.r.setSize(canvas.width, canvas.height, false);
    this.r.toneMapping = THREE.ACESFilmicToneMapping;
    this.r.toneMappingExposure = 1.35;
    this.backend = this.r.backend.isWebGPUBackend ? 'webgpu' : 'webgl2';

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, canvas.width / canvas.height, 0.1, 160);
    this.U = createStageUniforms();
    this.world = buildWorld(this.scene, this.U);
    this.director = new Director(this.camera);
    this.looks = new Looks(this.r, this.scene, this.camera, this.U);
    this.looks.set(_lookIdx);

    this.quality = 3;
    this._frameEma = 16.7;
    this._qT = 0;
    this._energy = 0;
    this._kickAge = 10;
    this._prevKick = 0;
    this._dropAt = -1e9;
    this._dropSeen = null;
    this._t = 0;
    this._note = 0;

    // compile all pipelines up-front so the first frames don't hitch
    try { await this.r.compileAsync(this.scene, this.camera); } catch (_) {}
  }

  // public controls (keyboard / UI)
  get lookLabel() { return this.looks.current.label; }
  cycleLook(d = 1) { this.looks.set(this.looks.idx + d); _lookIdx = this.looks.idx; return this.looks.current; }
  setLook(i) { this.looks.set(i); _lookIdx = this.looks.idx; return this.looks.current; }
  nextShot() { this.director.next(true); return this.director.shot; }
  flash() { this._flashUntil = performance.now() + 650; this.director.shake = Math.max(this.director.shake, 0.5); }

  tick(device, bands, timeMs, deltaMs, params) {
    const dt = Math.min(deltaMs, 50) / 1000;
    this._t += dt;
    const U = this.U;

    // quality governor: real frame time (deltaMs is Bloom's tension-warped
    // field clock, so measure wall time here) → 4 tiers (render scale + crowd)
    const now = performance.now();
    const realMs = this._lastNow ? Math.min(now - this._lastNow, 100) : 16.7;
    this._lastNow = now;
    this._frameEma = this._frameEma * 0.94 + realMs * 0.06;
    // Under vsync frame time never drops below the refresh period, so "fast"
    // means: no missed frames for a while. Each fall-back doubles the wait
    // before the next upgrade attempt, so it can't oscillate.
    this._qT += dt;
    if (this._t > 3 && this._qT > 2 && this._frameEma > 20 && this.quality > 0) { this._upWait = Math.min((this._upWait ?? 10) * 2, 120); this._setQuality(this.quality - 1); }
    else if (this._qT > (this._upWait ?? 10) && this._frameEma < 17.6 && this.quality < 3) this._setQuality(this.quality + 1);

    // ── audio → uniforms ──
    const kick = bands.kick ?? 0;
    if (kick > 0.45 && this._prevKick <= 0.45) this._kickAge = 0;
    this._prevKick = kick;
    this._kickAge += dt;
    const e = Math.min(1, ((bands.bass ?? 0) * 0.5 + (bands.mid ?? 0) * 0.3 + (bands.high ?? 0) * 0.4));
    this._energy += (e - this._energy) * Math.min(1, dt * 3);

    const dropCount = params.dropCount ?? 0;
    if (this._dropSeen === null) this._dropSeen = dropCount;
    if (dropCount !== this._dropSeen) { this._dropSeen = dropCount; this._dropAt = this._t; }
    // Backup impact: a build that resolves into full energy is a drop for the
    // stage even when the analyser's stricter drop test stays silent
    const stNow = params.structState ?? 'quiet';
    if (this._prevState === 'build' && stNow !== 'build' && this._energy > 0.3 && this._t - this._dropAt > 8) {
      this._dropAt = this._t;
      this.director.impact();
    }
    this._prevState = stNow;
    const sinceDrop = this._t - this._dropAt;
    const beatT = params.beatT ?? 0;
    // strobe: 16th-note gate for ~2 bars after a drop (or the user's flash key)
    const strobeOn = (sinceDrop < 4 && sinceDrop > 0) || (this._flashUntil ?? 0) > performance.now();
    const strobe = strobeOn ? (((beatT * 4) % 1) < 0.35 ? 1 : 0) : 0;

    // MIDI notes → screen flash travelling across the screens by pitch
    const q = params.noteQueue;
    if (q && q.length) {
      for (const n of q) { this._note = Math.max(this._note, n.vel); U.notePos.value = Math.min(1, Math.max(0, (n.pitch - 36) / 60)); }
      q.length = 0;
    }
    this._note *= Math.exp(-dt * 4);

    U.time.value = timeMs / 1000;
    U.beatT.value = beatT;
    U.barPos.value = params.barPos ?? 0;
    U.beatConf.value = params.beatConf ?? 0;
    U.kick.value = kick;
    U.snare.value = bands.snare ?? 0;
    U.sub.value = bands.subBass ?? 0;
    U.bass.value = bands.bass ?? 0;
    U.mid.value = bands.mid ?? 0;
    U.high.value = bands.high ?? 0;
    U.energy.value = this._energy;
    U.tension.value = params.tension ?? 0;
    U.drop.value = Math.max(params.dropPulse ?? 0, (params.dropFlash ?? 0) * 0.5, (params.pulse ?? 0) > 0.6 ? 0.2 : 0);
    U.strobe.value = strobe;
    U.kickAge.value = this._kickAge;
    U.note.value = this._note;
    const st = params.structState ?? 'quiet';
    const hazeTarget = st === 'breakdown' ? 1 : st === 'build' ? 0.75 : st === 'quiet' ? 0.6 : sinceDrop < 3 ? 0.15 : 0.4;
    U.haze.value += (hazeTarget - U.haze.value) * Math.min(1, dt * 0.6);
    paletteFromHarmony(params.keyHue ?? 0.6, params.tonality ?? 0, params.keyConf ?? 0, U.colA.value, U.colB.value);

    this.director.update(dt, {
      state: st, tension: params.tension ?? 0, drop: params.dropPulse ?? 0,
      dropCount, phrase: params.phrase ?? 0, beatT, energy: this._energy,
    });
    this.world.update(this._t, this.director);

    // follow Bloom's canvas size (main.js owns resolution + dpr)
    const w = this.canvas.width, h = this.canvas.height;
    if (w !== this._w || h !== this._h) {
      this._w = w; this._h = h;
      this.r.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.looks.cellPx.value = Math.max(7, Math.round(h / 90));
    }
  }

  _setQuality(q) {
    this.quality = q;
    this._qT = 0;
    this.looks.setQuality(q);
    this.world.setQuality(q);
  }

  draw() {
    this.looks.render();
  }

  stats() {
    return { backend: this.backend, quality: this.quality, frameMs: +this._frameEma.toFixed(2), look: this.looks.current.id, shot: this.director.shot };
  }

  destroy() {
    this.looks?.dispose();
    this.scene?.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    this.r?.dispose();
  }
}
