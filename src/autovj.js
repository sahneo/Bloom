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
    this._kaleidoBurstMs = 0;
    this._kaleidoPrev    = 0;
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
    // Kaleidoscope retired — it kept reading as a cheap mandala
    this.params.kaleidoK = 0;
    // Anamorphic streaks: a rare scene flavour (~1 in 10), not a constant
    this.params.anamorphicScene = Math.random() < 0.10 ? 0.7 : 0;
    // Composition centre: ~40% centred, else committed off-centre
    // (rule-of-thirds territory); lerped toward in update() so it glides
    if (Math.random() < 0.4) {
      this._offTargetX = 0;
      this._offTargetY = 0;
    } else {
      this._offTargetX = (Math.random() < 0.5 ? -1 : 1) * (0.25 + Math.random() * 0.30);
      this._offTargetY = (Math.random() < 0.5 ? -1 : 1) * (0.10 + Math.random() * 0.20);
    }
    // Echo feedback: mostly plain trails; sometimes the trail buffer flows
    // inward (tunnel) or spirals. No zoom-out — it sampled past the borders
    // and smeared edge pixels inward.
    const er = Math.random();
    if      (er < 0.60) { this.params.echoZoomBase = 1.0;    this.params.echoRotBase = 0; }
    else if (er < 0.80) { this.params.echoZoomBase = 1.006;  this.params.echoRotBase = 0; }
    else if (er < 0.90) { this.params.echoZoomBase = 1.0025; this.params.echoRotBase = 0; }
    else                { this.params.echoZoomBase = 1.003;  this.params.echoRotBase = 0.0028 * (Math.random() < 0.5 ? -1 : 1); }
  }

  update(st, dtS = 0.0167) {
    // Drop-flavour decays run even when AutoVJ is toggled off mid-effect
    this.params.dropFlash  = (this.params.dropFlash  ?? 0) * Math.exp(-dtS * 7);
    this.params.dropInvert = (this.params.dropInvert ?? 0) * Math.exp(-dtS * 3.5);
    this.params.zoomPunch  = (this.params.zoomPunch  ?? 0) * Math.exp(-dtS * 3);

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

      // Drop flavour deck — the physics shockwave always fires (dropPulse),
      // but the visual garnish varies so drops stay surprising
      const fx = Math.random();
      if      (fx < 0.40) { /* pure shockwave */ }
      else if (fx < 0.65) { this.params.dropFlash = 0.85; }
      else if (fx < 0.85) { this.params.dropInvert = 1; }
      else { this.params.zoomPunch = 1; }
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
