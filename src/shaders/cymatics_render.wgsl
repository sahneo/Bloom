// CYMATICS render — tiny additive sand grains, warm gold tinted by the
// music key. Fast grains sparkle (velocity → brightness) so plate strikes
// glitter; settled nodal lines read as dense glowing sand figures.
//
// Repurposed uniform slots: _r1 = crossfade, _r2 = strike, _r3 = shake,
// extra[0] = (nA, mA, nB, mB) — see cymatics_compute.wgsl.

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
  sharpness:  f32, _r1:         f32, _r2:       f32, _r3:        f32,
  extra: array<vec4f, 16>,
}

struct Grain {
  pos: vec2f,
  vel: vec2f,
}

@group(0) @binding(0) var<uniform>       u:      Uniforms;
@group(0) @binding(1) var<storage, read> grains: array<Grain>;

fn hsv2rgb(c: vec3f) -> vec3f {
  let k = fract(vec3f(c.x, c.x + 2.0 / 3.0, c.x + 1.0 / 3.0)) * 6.0;
  let rgb = clamp(abs(k - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  return c.z * mix(vec3f(1.0), rgb, c.y);
}

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

struct VSOut {
  @builtin(position) pos:   vec4f,
  @location(0)       local: vec2f,
  @location(1)       speed: f32,
  @location(2)       hash:  f32,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  let gi = vi / 6u;
  let ci = vi % 6u;
  let g  = grains[gi];

  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f( 1.0, -1.0), vec2f(-1.0,  1.0),
    vec2f(-1.0,  1.0), vec2f( 1.0, -1.0), vec2f( 1.0,  1.0),
  );
  let c    = corners[ci];
  let asp  = u.res_x / u.res_y;
  let hash = f32(pcg(gi * 2654435761u) & 0xffffu) / 65535.0;

  // ~1.5 px grains with per-grain variation (world units: screen height = 2)
  let size = (2.6 / u.res_y) * (0.75 + hash * 0.7);
  let spd  = length(g.vel);

  let clip = vec2f((g.pos.x + c.x * size) / asp, g.pos.y + c.y * size);
  return VSOut(vec4f(clip, 0.0, 1.0), c, spd, hash);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let d = length(in.local);
  if (d > 1.0) { discard; }
  let edge = smoothstep(1.0, 0.25, d);

  // ── brightness: settled sand is dim, moving sand sparkles ─────────────
  let sparkle = min(in.speed * 0.8, 1.6);
  var bright  = 0.16 + 0.08 * in.hash + sparkle;

  // strike flash: whole field flares when the plate is hit
  bright *= 1.0 + u._r2 * 1.1 + u.drop_pulse * 0.9;
  // subtle beat breath, gated on tracker confidence
  bright *= 1.0 + exp(-fract(u.beat_t) * 7.0) * u.beat_conf * 0.14;

  // ── colour: desaturated white-gold sand, gently pulled toward key hue ─
  let sand = u.extra[2].xyz;   // user-pickable sand colour
  let key  = hsv2rgb(vec3f(u.key_hue, 0.35, 1.0));
  var rgb  = mix(sand, key, u.key_conf * 0.22);
  // minor keys cool the sand slightly, major warms it
  let temp = select(
    mix(vec3f(1.0), vec3f(0.80, 0.88, 1.12), -u.tonality),
    mix(vec3f(1.0), vec3f(1.08, 0.98, 0.85),  u.tonality),
    u.tonality > 0.0);
  rgb *= temp;
  // fast grains whiten — hot sparks
  rgb = mix(rgb, vec3f(1.0, 0.96, 0.88), min(sparkle * 0.28, 0.55));

  let a = edge * 0.09 * u.trail_gain;
  return vec4f(rgb * bright * a, bright * a);   // premultiplied, one/one blend
}
