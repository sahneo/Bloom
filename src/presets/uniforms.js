// Shared uniform-buffer layout for all HDR presets (particles, silk, flora, fluid).
// Must match the Uniforms struct in each preset's WGSL:
//   44 × f32 base (176 bytes) + 64 × f32 ripple data at offset 176 = 432 bytes.
export const UNIFORM_SIZE   = 432;
export const RIPPLE_OFFSET  = 176;

export function buildUniforms(bands, timeMs, deltaMs, params, canvas, frameCount, trailGain) {
  return new Float32Array([
    timeMs * 0.001,
    bands.subBass ?? 0,
    bands.bass    ?? 0,
    bands.mid     ?? 0,
    bands.high    ?? 0,
    Math.min(deltaMs * 0.001, 0.04),
    canvas.width,
    canvas.height,
    frameCount,
    params.mulSb,
    params.mulBass,
    params.mulMid,
    params.mulHigh,
    params.spring,
    bands.kick       ?? 0,
    bands.snare      ?? 0,
    params.modeDrums ?? 0,
    params.modeBass  ?? 0,
    params.modeLead  ?? 0,
    params.modeAtmos ?? 0,
    params.modePads   ?? 0,
    params.colorMode  ?? 0,
    params.tonality   ?? 0,   // -1 minor → +1 major
    params.pulse      ?? 0,   // MIDI note-attack flash
    params.dissonance         ?? 0,
    params.dissonanceStrength ?? 1,
    params.beatT      ?? 0,   // beats elapsed; fract = phase within the beat
    params.beatConf   ?? 0,
    params.barPos     ?? 0,   // position within the 4-beat bar, downbeat at 0
    params.keyHue     ?? 0,   // tonic hue on the circle of fifths 0..1
    params.keyConf    ?? 0,
    trailGain ?? 1,           // brightness compensation for trail accumulation
    params.tension    ?? 0,   // structure: build-up 0..1
    params.dropPulse  ?? 0,   // structure: drop shockwave
    params.driftScale ?? 1,   // generative drift
    params.driftRot   ?? 0,
    params.driftX     ?? 0,
    params.driftY     ?? 0,
    params.sceneSeed  ?? 0,   // re-rolls all time-driven field layouts
    params.paletteMode ?? 0,  // palette director scheme
    params.sharpness  ?? 0,   // timbre: 0 sine-soft → 1 saw-bright
    0, 0, 0,                  // padding to 176 bytes
  ]);
}
