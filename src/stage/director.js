import * as THREE from 'three/webgpu';
import { BOOTH_Z, CROWD_Z } from './world.js';

// Camera director: the track's structure decides the shot.
//   build      → RUSH: slow push toward the booth, lens narrows with tension, shake grows
//   drop       → hard CUT to a fresh vantage + FOV punch + shake impulse
//   breakdown/quiet → FLOAT: drift up through the screens, wide and slow
//   steady     → every 2 phrases a smooth 3 s glide to the next shot
// Every shot is a function of time so the camera never freezes.

const SHOTS = {
  // eye height inside the crowd, slow walk toward the booth
  floor: (t) => ({ p: [Math.sin(t * 0.11) * 0.8, 1.65, CROWD_Z + 15 - 5 * (0.5 - 0.5 * Math.cos(t * 0.05))], l: [Math.sin(t * 0.07) * 4, 3.2, BOOTH_Z] }),
  // high orbit around the halo
  orbit: (t) => ({ p: [Math.sin(t * 0.06) * 17, 10.5, CROWD_Z + Math.cos(t * 0.06) * 17], l: [0, 2, CROWD_Z - 2] }),
  // from behind the booth looking out over the crowd
  booth: (t) => ({ p: [Math.sin(t * 0.09) * 3, 3.4, BOOTH_Z + 2.4], l: [Math.sin(t * 0.13) * 6, 1.6, CROWD_Z + 6] }),
  // low, close, the crowd as a forest of legs and light
  low:   (t) => ({ p: [17 + Math.sin(t * 0.1) * 1.5, 0.7, CROWD_Z + 4 + Math.cos(t * 0.08) * 6], l: [0, 3.2, CROWD_Z - 6] }),
  // float up between hanging screens (breakdowns)
  float: (t) => ({ p: [Math.sin(t * 0.05) * 5, 6.5 + Math.sin(t * 0.09) * 1.5, CROWD_Z + 6 + Math.cos(t * 0.05) * 4], l: [Math.sin(t * 0.04 + 1) * 3, 5.5, CROWD_Z - 6] }),
  // build: push from the back of the hall toward the wall
  rush:  (t, k) => ({ p: [0, 2.2 + k * 1.5, CROWD_Z + 14 - k * 22], l: [0, 4.2, BOOTH_Z - 3] }),
};
const CUT_POOL = ['floor', 'orbit', 'booth', 'low'];
const ease = (x) => x * x * (3 - 2 * x);

export class Director {
  constructor(camera) {
    this.cam = camera;
    this.shot = 'orbit';
    this.prev = null;
    this.blend = 1;          // 0→1 progress from prev to shot
    this.blendDur = 3;
    this.shotT = 0;          // per-shot local clock
    this.prevT = 0;
    this.shake = 0;
    this.fovPunch = 0;
    this._phraseSeen = -1;
    this._dropSeen = -1;
    this._lastState = '';
    this._phrasesInShot = 0;
    this._buildK = 0;
    this._p = new THREE.Vector3(); this._l = new THREE.Vector3();
    this._p2 = new THREE.Vector3(); this._l2 = new THREE.Vector3();
    this.beamPattern = 0;
    this.manualHold = 0;     // seconds; keyboard shot picks hold the director
  }

  cut(name, dur = 0) {
    if (name === this.shot && dur > 0) return;
    this.prev = this.shot; this.prevT = this.shotT;
    this.shot = name; this.shotT = name === 'rush' ? 0 : Math.random() * 60;
    this.blend = dur > 0 ? 0 : 1;
    this.blendDur = dur;
    this._phrasesInShot = 0;
  }

  // hard cut + punch, used for drops (analyser or the stage's own backup)
  impact() {
    if (this.manualHold <= 0) this.next();
    this.blend = 1; this.shake = 1; this.fovPunch = 1;
    this.beamPattern = (this.beamPattern + 1 + (Math.random() * 2 | 0)) % 3;
  }

  next(manual = false) {
    const pool = CUT_POOL.filter(s => s !== this.shot);
    this.cut(pool[(Math.random() * pool.length) | 0], manual ? 1.2 : 3);
    if (manual) this.manualHold = 20;
  }

  update(dt, s) {
    // s: { state, tension, drop, dropCount, phrase, beatT, energy }
    this.shotT += dt; this.prevT += dt;
    this.manualHold = Math.max(0, this.manualHold - dt);
    const auto = this.manualHold <= 0;

    if (s.dropCount !== this._dropSeen) {
      const first = this._dropSeen < 0;
      this._dropSeen = s.dropCount;
      if (!first) {
        this.impact();                                       // drops are hard cuts
      }
    }
    if (s.phrase !== this._phraseSeen) {
      const first = this._phraseSeen < 0;
      this._phraseSeen = s.phrase;
      if (!first) {
        this._phrasesInShot++;
        if (s.state === 'steady' && auto && this._phrasesInShot >= 2) this.next();
        if (Math.random() < 0.35) this.beamPattern = (this.beamPattern + 1) % 3;
      }
    }
    if (s.state !== this._lastState) {
      if (auto) {
        if (s.state === 'build') { this.cut('rush', 2.5); this._buildK = 0; }
        else if (s.state === 'breakdown' || s.state === 'quiet') this.cut(this._lastState === '' ? 'orbit' : 'float', 4);
        else if (this.shot === 'rush' || this.shot === 'float') { if (this._lastState === 'build') this.impact(); else this.next(); }
      }
      this._lastState = s.state;
    }

    if (this.blend < 1) this.blend = Math.min(1, this.blend + dt / Math.max(this.blendDur, 0.01));
    // build progress only moves forward while the build lasts
    this._buildK = Math.min(1, Math.max(this._buildK, s.tension * 0.9 + Math.min(this.shotT / 16, 1) * 0.3));

    const A = SHOTS[this.shot](this.shotT, this._buildK);
    this._p.fromArray(A.p); this._l.fromArray(A.l);
    if (this.prev && this.blend < 1) {
      const B = SHOTS[this.prev](this.prevT, this._buildK);
      const w = ease(this.blend);
      this._p.lerpVectors(this._p2.fromArray(B.p), this._p, w);
      this._l.lerpVectors(this._l2.fromArray(B.l), this._l, w);
      this._p.y += Math.sin(Math.PI * w) * 3;   // arc over the crowd, never through heads
    }

    // handheld: breathing + beat-locked nod + decaying shake impulse
    this.shake = Math.max(this.shake * Math.exp(-dt * 2.5), this.shot === 'rush' ? s.tension * 0.35 : 0);
    this.fovPunch *= Math.exp(-dt * 3);
    const tt = performance.now() / 1000;
    const sh = this.shake * 0.35;
    const nod = Math.pow(1 - (s.beatT % 1), 4) * 0.035 * s.energy * (this.shot === 'floor' ? 1 : 0.3);
    this._p.x += Math.sin(tt * 17.3) * sh + Math.sin(tt * 0.7) * 0.05;
    this._p.y += Math.sin(tt * 23.1) * sh * 0.6 - nod + Math.sin(tt * 0.9) * 0.04;
    this._l.x += Math.sin(tt * 13.7) * sh * 2;

    this.cam.position.copy(this._p);
    this.cam.lookAt(this._l);
    const baseFov = this.shot === 'rush' ? 70 - this._buildK * 26 : this.shot === 'low' ? 78 : this.shot === 'orbit' ? 55 : 66;
    const fov = baseFov + this.fovPunch * 18;
    const k = this.blend >= 1 && this.blendDur === 0 ? 1 : Math.min(1, dt * 2.5);   // hard cuts snap
    const nf = this.cam.fov + (fov - this.cam.fov) * (this.fovPunch > 0.05 ? 1 : k);
    if (Math.abs(this.cam.fov - nf) > 0.01) { this.cam.fov = nf; this.cam.updateProjectionMatrix(); }
  }
}
