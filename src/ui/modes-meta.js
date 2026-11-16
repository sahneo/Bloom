// Human-facing catalogue of worlds for the mode palette + HUD.
// id must match MODES keys in main.js and <option> values of #mode-select.
export const MODE_GROUPS = [
  { id: '3d',    label: '3D' },
  { id: 'peak',  label: 'Energy' },
  { id: 'calm',  label: 'Calm' },
  { id: 'type',  label: 'Type & media' },
];

export const MODE_META = [
  { id: 'stage',     name: 'STAGE',     group: '3d',   desc: 'Inside an imagined warehouse club — crowd, screens, beams. ASCII by default.' },
  { id: 'particles', name: 'BLOOM',     group: 'peak', desc: '25k particles, each instrument band pushes its own layer' },
  { id: 'swarm',     name: 'SWARM',     group: 'peak', desc: 'Starling murmuration; the kick is a predator strike' },
  { id: 'void',      name: 'VOID',      group: 'peak', desc: 'Flight through an endless fractal cathedral' },
  { id: 'storm',     name: 'STORM',     group: 'peak', desc: 'Volumetric thunderstorm, lightning on hits' },
  { id: 'cymatics',  name: 'CYMATICS',  group: 'peak', desc: 'Sand figures on a vibrating plate; tap to strike' },
  { id: 'terra',     name: 'TERRA',     group: 'peak', desc: 'The music builds the landscape row by row' },
  { id: 'acid',      name: 'ACID',      group: 'peak', desc: 'Liquid light show on a real fluid solver' },
  { id: 'prism',     name: 'PRISM',     group: 'peak', desc: 'Chrome metaballs: bass fuses, drops shatter' },
  { id: 'galaxy',    name: 'GALAXY',    group: 'peak', desc: 'Deep-space flythrough of living star clusters' },
  { id: 'abyss',     name: 'ABYSS',     group: 'calm', desc: 'Deep water, plankton ignites on kicks' },
  { id: 'fireflies', name: 'FIREFLIES', group: 'calm', desc: '5k fireflies learning to blink on the beat' },
  { id: 'aurora',    name: 'AURORA',    group: 'calm', desc: 'Polar light curtains, substorm on drops' },
  { id: 'frost',     name: 'FROST',     group: 'calm', desc: 'Ice crystals grow, shatter on drops' },
  { id: 'glass',     name: 'GLASS',     group: 'calm', desc: 'Light through fluted glass (or your media)' },
  { id: 'silk',      name: 'SILK',      group: 'calm', desc: 'Flowing silk ribbons' },
  { id: 'flora',     name: 'FLORA',     group: 'calm', desc: 'Petals bloom at the golden angle on onsets' },
  { id: 'fluid',     name: 'INK',       group: 'calm', desc: 'Ink in water, anamorphic' },
  { id: 'ferro',     name: 'FERRO',     group: 'calm', desc: 'Liquid metal spikes' },
  { id: 'physarum',  name: 'MYCELIUM',  group: 'calm', desc: 'Slime-mould networks; tap to drop food' },
  { id: 'bz',        name: 'REAGENT',   group: 'calm', desc: 'Belousov–Zhabotinsky spiral waves' },
  { id: 'pendulum',  name: 'PENDULUM',  group: 'calm', desc: 'Wave-wall of pendulums, drops snap unison' },
  { id: 'ascii',     name: 'ASCII',     group: 'type', desc: 'Generative scenes drawn in glyphs' },
  { id: 'type',      name: 'TYPE',      group: 'type', desc: 'Your own words riding kinetic paths' },
  { id: 'kino',      name: 'KINO',      group: 'type', desc: '8 typographic treatments of your media' },
  { id: 'fx',        name: 'STUDIO',    group: 'type', desc: 'Effects over your images/videos' },
  { id: 'dither',    name: 'RESOLVER',  group: 'type', desc: 'Your media, glitch-resolved on the bar' },
  { id: 'oscilloscope', name: 'SCOPE',  group: 'type', desc: 'Stereo XY oscilloscope' },
];

export const metaFor = (id) => MODE_META.find(m => m.id === id) ?? { id, name: id.toUpperCase(), desc: '' };
