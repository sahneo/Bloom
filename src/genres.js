// ---------------------------------------------------------------------------
// Genre presets — within one genre, instruments live in predictable frequency
// ranges and tempo lives in a narrow window, so detection can be tuned much
// tighter than one-size-fits-all:
//   bands     → frequency ranges fed to AudioAnalyser (Hz)
//   tempo     → BeatTracker log-gaussian prior (center BPM, sigma in octaves)
//   modePools → which movement modes AutoVJ may rotate through per band
//   defaults  → slider defaults that suit the genre's aesthetics
//   vj        → AutoVJ pacing (probability of a change per 4-bar phrase)
// ---------------------------------------------------------------------------

export const GENRES = {
  auto: {
    label: 'AUTO',
    tempo: { center: 115, sigma: 0.6 },
    bands: null,   // keep universal defaults
    modePools: { drums: [0, 1, 2], bass: [0, 1, 2, 3], lead: [0, 1, 2], atmos: [0, 1, 2], pads: [0, 1, 2] },
    defaults: { trail: 0.5, glow: 1.0 },
    vj: { phraseProb: 0.55 },
  },

  techno: {
    label: 'TECHNO',
    tempo: { center: 132, sigma: 0.28 },
    bands: {
      subBass: [25, 70],  bass: [70, 200],  mid: [200, 1800], high: [2500, 16000],
      kick: [40, 80],     kickHarm: [150, 400], snare: [2500, 7000],
    },
    modePools: { drums: [1, 2], bass: [3, 0], lead: [1, 2], atmos: [0, 2], pads: [0, 2] },
    defaults: { trail: 0.45, glow: 1.1 },
    vj: { phraseProb: 0.6 },
  },

  house: {
    label: 'HOUSE',
    tempo: { center: 124, sigma: 0.22 },
    bands: {
      subBass: [25, 75],  bass: [75, 220],  mid: [220, 2000], high: [2500, 16000],
      kick: [40, 90],     kickHarm: [150, 420], snare: [2200, 6500],
    },
    modePools: { drums: [0, 1], bass: [1, 3], lead: [0, 1], atmos: [0, 1], pads: [0, 1] },
    defaults: { trail: 0.55, glow: 1.0 },
    vj: { phraseProb: 0.55 },
  },

  dnb: {
    label: 'DNB',
    tempo: { center: 172, sigma: 0.30 },
    bands: {
      subBass: [25, 60],  bass: [60, 150],  mid: [200, 2000], high: [3000, 16000],
      kick: [45, 100],    kickHarm: [180, 450], snare: [2800, 8000],
    },
    modePools: { drums: [2, 1], bass: [0, 2], lead: [2, 1], atmos: [0, 1], pads: [2, 0] },
    defaults: { trail: 0.35, glow: 1.2 },
    vj: { phraseProb: 0.7 },
  },

  hiphop: {
    label: 'HIP-HOP',
    tempo: { center: 90, sigma: 0.35 },
    bands: {
      subBass: [25, 70],  bass: [70, 180],  mid: [200, 1800], high: [2000, 14000],
      kick: [40, 90],     kickHarm: [150, 400], snare: [1800, 6000],
    },
    modePools: { drums: [0], bass: [1, 2], lead: [0, 2], atmos: [2, 0], pads: [1, 2] },
    defaults: { trail: 0.6, glow: 0.9 },
    vj: { phraseProb: 0.4 },
  },

  ambient: {
    label: 'AMBIENT',
    tempo: { center: 100, sigma: 1.2 },   // near-flat prior: tempo barely matters
    bands: null,
    modePools: { drums: [0], bass: [2], lead: [0], atmos: [2, 1], pads: [2, 1] },
    defaults: { trail: 0.8, glow: 1.3 },
    vj: { phraseProb: 0.25 },
  },
};
