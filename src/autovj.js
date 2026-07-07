// ---------------------------------------------------------------------------
// AutoVJ — re-stages the visuals on musical events from StructureAnalyzer,
// the way a VJ works a set: rotate movement modes on phrase boundaries,
// shuffle the scene on drops, stretch trails through breakdowns.
//
// It only ever *nudges* — user mode selections stay authoritative between
// events, and the whole system can be toggled off.
// ---------------------------------------------------------------------------

const BAND_KEYS = ['drums', 'bass', 'lead', 'atmos', 'pads'];
// Lead/atmos changes read as "new scene" without breaking the groove;
// drums/bass swaps are more disruptive, so they're rarer.
const ROTATE_WEIGHTS = { drums: 0.10, bass: 0.15, lead: 0.30, atmos: 0.30, pads: 0.15 };
const PARAM_KEY = { drums: 'modeDrums', bass: 'modeBass', lead: 'modeLead', atmos: 'modeAtmos', pads: 'modePads' };

export class AutoVJ {
  constructor(params, { onModeChange } = {}) {
    this.enabled = true;
    this.params  = params;
    this.pools   = { drums: [0, 1, 2], bass: [0, 1, 2, 3], lead: [0, 1, 2], atmos: [0, 1, 2], pads: [0, 1, 2] };
    this.phraseProb = 0.55;
    this._onModeChange = onModeChange ?? (() => {});
    this._trailBias = 0;
    this._phrasesSinceScene = 0;
    this._offTargetX = 0; this._offTargetY = 0;   // scene composition centre
    this._offX = 0;       this._offY = 0;         // smoothed
  }

  setGenre(genre) {
    this.pools      = genre.modePools;
    this.phraseProb = genre.vj.phraseProb;
  }

  _pickBand() {
    let r = Math.random(), acc = 0;
    for (const k of BAND_KEYS) {
      acc += ROTATE_WEIGHTS[k];
      if (r < acc) return k;
    }
    return 'lead';
  }

  _rotateOne() {
    // Try a few times to find a band whose pool offers an actual change
    for (let tries = 0; tries < 4; tries++) {
      const band = this._pickBand();
      const pool = this.pools[band] ?? [0];
      const cur  = this.params[PARAM_KEY[band]] ?? 0;
      const options = pool.filter(m => m !== cur);
      if (!options.length) continue;
      const next = options[Math.floor(Math.random() * options.length)];
      this.params[PARAM_KEY[band]] = next;
      this._onModeChange(band, next);
      return { band, mode: next };
    }
    return null;
  }

  // A "new scene" re-rolls everything that defines the look at once:
  // field layout (seed), colour scheme, composition centre, and symmetry
  _newScene() {
    this.params.sceneSeed = Math.random() * 1000;
    this._phrasesSinceScene = 0;
    // Palette roles: mono / duotone / complementary / analogous
    const pr = Math.random();
    this.params.paletteMode = pr < 0.25 ? 0 : pr < 0.50 ? 1 : pr < 0.80 ? 2 : 3;
    // Kaleidoscope: rare spice — a mandala every ~8th scene, never the dull 2-mirror
    const kr = Math.random();
    this.params.kaleidoK = kr < 0.88 ? 0 : kr < 0.95 ? 4 : 6;
    // Composition centre: ~40% centred, else committed off-centre
    // (rule-of-thirds territory); lerped toward in update() so it glides
    if (Math.random() < 0.4) {
      this._offTargetX = 0;
      this._offTargetY = 0;
    } else {
      this._offTargetX = (Math.random() < 0.5 ? -1 : 1) * (0.25 + Math.random() * 0.30);
      this._offTargetY = (Math.random() < 0.5 ? -1 : 1) * (0.10 + Math.random() * 0.20);
    }
  }

  update(st) {
    if (!this.enabled) { this._trailBias *= 0.98; this.params.trailBias = this._trailBias; return; }

    if (st.onPhrase) {
      this._phrasesSinceScene++;
      if (Math.random() < this.phraseProb) this._rotateOne();
      // Fresh scene every 8 phrases (~2 min at 128 BPM) even without a drop
      if (this._phrasesSinceScene >= 8) this._newScene();
    }

    if (st.onDrop) {
      // Drop: new scene + shuffle a couple of layers at once
      this._newScene();
      const n = 2 + (Math.random() < 0.5 ? 1 : 0);
      for (let i = 0; i < n; i++) this._rotateOne();
    }

    // Trail bias by section: breakdowns float (long trails), builds tighten
    const target = st.state === 'breakdown' ? 0.30
                 : st.state === 'build'     ? -0.15
                 : 0;
    this._trailBias += (target - this._trailBias) * 0.02;
    this.params.trailBias = this._trailBias;

    // Composition centre glides toward the scene's target over ~10 s
    this._offX += (this._offTargetX - this._offX) * 0.006;
    this._offY += (this._offTargetY - this._offY) * 0.006;
    this.params.sceneOffX = this._offX;
    this.params.sceneOffY = this._offY;
  }
}
