// FLORA — petal spawner. The CPU decides how many petals to open this frame
// (beats, kicks, MIDI notes); this pass initializes exactly those slots.
// Petal placement follows phyllotaxis: each new petal sits at the golden
// angle (137.5°) from the previous one, radius ∝ √n — a sunflower's layout.

struct Uniforms {
  time:       f32, sub_bass:    f32, bass:      f32, mid:       f32,
  high:       f32, delta:       f32, res_x:     f32, res_y:    f32,
  frame:      f32, mul_sb:      f32, mul_bass:  f32, mul_mid:  f32,
  mul_high:   f32, spring:      f32, kick:      f32, snare:    f32,
  mode_drums: f32, mode_bass:   f32, mode_lead: f32, mode_atmos: f32,
  mode_pads:  f32, color_mode:  f32, tonality:  f32, pulse:      f32,
  dissonance: f32, dis_strength: f32, beat_t:   f32, beat_conf:  f32,
  bar_pos:    f32, key_hue:     f32, key_conf:  f32, trail_gain: f32,
  tension:    f32, drop_pulse:  f32, drift_scale: f32, drift_rot: f32,
  drift_x:    f32, drift_y:     f32, scene_seed: f32, palette_mode: f32,
  ripple_pos_age: array<vec4f, 8>,
  ripple_color:   array<vec4f, 8>,
}

struct SpawnParams {
  start:  f32,   // first slot to initialize
  count:  f32,   // how many slots
  base_n: f32,   // global bloom counter for phyllotaxis
  amp:    f32,   // spawn energy (velocity / kick strength) → petal size
}

@group(0) @binding(0) var<uniform>             u: Uniforms;
@group(0) @binding(1) var<storage, read_write> petals: array<vec4f>;  // 2 × vec4 per petal
@group(0) @binding(2) var<uniform>             sp: SpawnParams;

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rnd(seed: u32) -> f32 { return f32(pcg(seed)) / 4294967295.0; }

const GOLDEN: f32 = 2.39996323;   // golden angle, radians

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  let max_petals = arrayLength(&petals) / 2u;
  if (idx >= max_petals) { return; }

  let start = u32(sp.start + 0.5);
  let count = u32(sp.count + 0.5);
  let rel   = (idx + max_petals - start) % max_petals;
  if (rel >= count) { return; }

  let n    = u32(sp.base_n + 0.5) + rel;
  let seed = pcg(n * 7919u + u32(u.frame));

  // Phyllotaxis: spiral resets every 350 blooms so the flower re-grows;
  // longer petal lives keep the corolla dense from heart to rim. Every 7th
  // petal blooms near the heart so the centre never sits empty while the
  // spiral is out at the rim.
  var nn = f32(n % 350u);
  if (n % 7u == 0u) { nn = f32(n % 60u); }
  let radius = 0.048 * sqrt(nn) * (0.85 + rnd(seed) * 0.3);
  let angle  = f32(n) * GOLDEN + (rnd(seed + 1u) - 0.5) * 0.15;
  // Keep the flower near the world origin — the 3D camera orbits it, so a
  // strongly offset centre would sweep the whole flower in wide arcs
  let centre = vec2f(u.drift_x, u.drift_y) * 0.35;
  let pos    = centre + vec2f(cos(angle), sin(angle)) * radius;

  let dur   = 5.0 + rnd(seed + 2u) * 5.0;
  let scale = (0.045 + rnd(seed + 3u) * 0.05) * (0.6 + sp.amp * 0.8);
  let hue_off = rnd(seed + 4u) - 0.5;

  // Depth: the flower is a 3D dome — the heart sits proud of the rim,
  // with per-petal scatter so the orbiting camera reads real parallax
  let z = 0.45 * exp(-nn / 160.0) - 0.10 + (rnd(seed + 5u) - 0.5) * 0.30;

  petals[idx * 2u]      = vec4f(pos, u.time, dur);
  petals[idx * 2u + 1u] = vec4f(angle, scale, hue_off, z);
}
