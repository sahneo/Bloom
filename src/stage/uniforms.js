import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';

// Shared TSL uniforms for the whole STAGE scene. Written once per frame by
// StagePreset.tick() from Bloom's analysis (bands, beat grid, harmony,
// structure); every material/post node reads from here — so the world
// builders never touch audio code (harmony/audio stay separate from render).
export function createStageUniforms() {
  return {
    time:     uniform(0),     // seconds, tension-warped field clock
    beatT:    uniform(0),     // beats elapsed (fract = phase)
    barPos:   uniform(0),     // 0..4 within the bar
    beatConf: uniform(0),
    kick:     uniform(0),
    snare:    uniform(0),
    sub:      uniform(0),
    bass:     uniform(0),
    mid:      uniform(0),
    high:     uniform(0),
    energy:   uniform(0),     // smoothed overall loudness 0..1
    tension:  uniform(0),     // build-up 0..1
    drop:     uniform(0),     // drop shockwave envelope
    strobe:   uniform(0),     // 0/1 strobe gate (first bars after a drop)
    kickAge:  uniform(10),    // seconds since the last kick onset → floor rings
    haze:     uniform(0.5),   // fog thickness 0..1 (breakdowns fill the room)
    note:     uniform(0),     // MIDI note flash envelope
    notePos:  uniform(0.5),   // last MIDI pitch, 0..1 across the keyboard
    colA:     uniform(new THREE.Color(0.2, 0.5, 1.0)),   // key colour
    colB:     uniform(new THREE.Color(1.0, 0.3, 0.6)),   // counter colour
  };
}

// Key hue (circle of fifths, 0..1) + tonality (-1 minor .. +1 major) →
// two stage colours. Minor leans cool/deep, major warm/bright — same rule as
// the 2D modes so a track keeps its colour identity across worlds.
const _tmp = new THREE.Color();
export function paletteFromHarmony(keyHue, tonality, keyConf, outA, outB) {
  const warmShift = tonality * 0.06;
  const h = ((keyHue + warmShift) % 1 + 1) % 1;
  const sat = 0.55 + 0.4 * Math.min(1, keyConf + 0.3);
  const light = 0.5 + tonality * 0.06;
  _tmp.setHSL(h, sat, light);
  outA.lerp(_tmp, 0.04);
  // counter colour: split-complement, closer for major (consonant), wider for minor
  _tmp.setHSL((h + (tonality > 0 ? 0.42 : 0.58)) % 1, sat, 0.55);
  outB.lerp(_tmp, 0.04);
}
