// PYRO spark render — velocity-stretched streaks, not dots. Each spark is an
// instanced quad elongated along its velocity vector (length ∝ clamped
// speed, width 1–2 px) with a bright head and a fading tail inside the quad.
// A spark reads as a glowing streak of motion; brightness follows heat² so
// cooled embers dim to a barely-there dull red before they die.

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

struct Spark {
  pos:  vec2f,
  vel:  vec2f,
  heat: f32,
  life: f32,
  seed: f32,
  pad:  f32,
}

@group(0) @binding(0) var<uniform>       u:      Uniforms;
@group(0) @binding(1) var<storage, read> sparks: array<Spark>;

fn fire_ramp(t: f32) -> vec3f {
  let x = clamp(t, 0.0, 1.0);
  var c = vec3f(pow(x, 0.55), pow(x, 1.85) * 0.88, pow(x, 4.8) * 0.68);
  c += vec3f(0.55, 0.62, 0.62) * smoothstep(0.84, 1.0, x);
  return c;
}

struct VSOut {
  @builtin(position) pos:   vec4f,
  @location(0)       local: vec2f,   // x: −1 tail → +1 head, y: across
  @location(1)       heat:  f32,
  @location(2)       seed:  f32,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  let gi = vi / 6u;
  let ci = vi % 6u;
  let s  = sparks[gi];

  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f( 1.0, -1.0), vec2f(-1.0,  1.0),
    vec2f(-1.0,  1.0), vec2f( 1.0, -1.0), vec2f( 1.0,  1.0),
  );
  let c = corners[ci];
  if (s.life <= 0.0) {
    return VSOut(vec4f(2e4, 2e4, 0.0, 1.0), c, 0.0, 0.0);
  }

  let res = vec2f(u.res_x, u.res_y);
  // pixel space (y up) so the streak aligns with on-screen motion
  let P = s.pos * res;
  let velPx = s.vel * res;
  let spd = length(velPx);
  var dir = vec2f(0.0, 1.0);
  if (spd > 1e-3) { dir = velPx / spd; }
  let perp = vec2f(-dir.y, dir.x);

  // length follows clamped speed (≈ the distance covered in ~1/14 s);
  // width stays 1–2 px — a streak, never a disc
  let len = clamp(spd * 0.07, 5.0, 44.0) * (0.8 + s.seed * 0.4);
  let wid = 0.8 + s.heat * 0.9;

  // head sits just past the particle position, tail trails behind
  let along = mix(-len, wid * 2.0, c.x * 0.5 + 0.5);
  let off = dir * along + perp * (c.y * wid);
  let clip = (P + off) / res * 2.0 - 1.0;
  return VSOut(vec4f(clip, 0.0, 1.0), c, s.heat, s.seed);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let across = exp(-in.local.y * in.local.y * 3.2);
  let sN = in.local.x * 0.5 + 0.5;              // 0 tail → 1 head
  let tail = pow(sN, 1.7);                      // fading tail
  let head = exp(-pow((in.local.x - 0.72) * 3.2, 2.0)) * 0.75;  // hot head knot
  let heat = clamp(in.heat, 0.0, 1.0);
  let b = (0.07 + heat * heat * 1.05) * (tail + head) * across;

  var col = fire_ramp(0.16 + heat * 0.82);
  return vec4f(col * b, b * 0.05);   // premultiplied, one/one additive
}
