// SILK — ribbon rendering: each pair of consecutive history points becomes a
// tapered quad; additive HDR into the shared accumulation buffer.

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

const SEG: u32 = 24u;

@group(0) @binding(0) var<uniform>           u: Uniforms;
@group(0) @binding(1) var<storage, read>     pts:   array<vec4f>;
@group(0) @binding(2) var<storage, read>     state: array<vec4f>;

fn hsv2rgb(c: vec3f) -> vec3f {
  let k = fract(vec3f(c.x, c.x + 2.0 / 3.0, c.x + 1.0 / 3.0)) * 6.0;
  let rgb = clamp(abs(k - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  return c.z * mix(vec3f(1.0), rgb, c.y);
}

struct VSOut {
  @builtin(position) pos:   vec4f,
  @location(0)       edge:  f32,   // -1..1 across ribbon width
  @location(1)       along: f32,   // 0 head → 1 tail
  @location(2)       role:  f32,
  @location(3)       life:  f32,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  let quads  = SEG - 1u;
  let ribbon = vi / (6u * quads);
  let q      = (vi / 6u) % quads;
  let ci     = vi % 6u;
  let base   = ribbon * SEG;

  var corners = array<vec2f, 6>(
    vec2f(-1.0, 0.0), vec2f(1.0, 0.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, 0.0), vec2f( 1.0, 1.0),
  );
  let c  = corners[ci];
  let p0 = pts[base + q].xy;
  let p1 = pts[base + q + 1u].xy;
  let st = state[ribbon];
  let role = f32(ribbon % 3u);

  var d = p1 - p0;
  let len = length(d);
  // Screen-wrap seams produce absurdly long segments — collapse them
  var w_kill = 1.0;
  if (len > 0.5) { w_kill = 0.0; }
  d = select(d / max(len, 0.0001), vec2f(1.0, 0.0), len < 0.0001);
  let perp = vec2f(-d.y, d.x);

  let along = (f32(q) + c.y) / f32(SEG);
  // Width: role-dependent base, tapers toward the tail, breathes with its band
  var wbase = 0.016;
  var amp   = u.bass;
  if (role == 1.0) { wbase = 0.009; amp = u.mid; }
  if (role == 2.0) { wbase = 0.005; amp = u.high; }
  let beat_size = 1.0 + exp(-fract(u.beat_t) * 8.0) * u.beat_conf * 0.18;
  let width = wbase * (0.35 + amp * 1.4) * (1.0 - along * 0.85) * beat_size * w_kill;

  let world = mix(p0, p1, c.y) + perp * c.x * width;
  let aspect = u.res_x / u.res_y;
  return VSOut(vec4f(world.x / aspect, world.y, 0.0, 1.0), c.x, along, role, st.x);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let role = u32(in.role + 0.5);

  // Map silk roles onto the palette director's band roles
  // (bass ribbon → bass, mid → lead accent, high → atmosphere)
  var bi = 1u;
  if (role == 1u) { bi = 2u; }
  if (role == 2u) { bi = 3u; }

  var key_sat = 0.72 + u.tonality * 0.10;
  let key_val = 0.92 + max(u.tonality, 0.0) * 0.08;
  var hue = u.key_hue;
  let pm  = u32(u.palette_mode + 0.5);
  if (pm == 1u) {
    if (bi == 3u) { hue = fract(hue + 0.5); key_sat *= 0.55; }
  } else if (pm == 2u) {
    if (bi == 2u)      { hue = fract(hue + 0.5); }
    else if (bi == 3u) { hue = fract(hue + 0.07); }
  } else if (pm == 3u) {
    hue = fract(hue + (f32(bi) - 2.0) * 0.06);
  }
  let key_rgb = hsv2rgb(vec3f(hue, key_sat, key_val));

  let cool_hue    = vec3f(0.28, 0.42, 1.00);
  let neutral_hue = vec3f(0.82, 0.85, 1.00);
  let warm_hue    = vec3f(1.00, 0.60, 0.08);
  var tone_rgb: vec3f;
  if (u.tonality > 0.0) { tone_rgb = mix(neutral_hue, warm_hue,  u.tonality); }
  else                  { tone_rgb = mix(neutral_hue, cool_hue, -u.tonality); }
  let rgb = mix(tone_rgb, key_rgb, u.key_conf * 0.80);

  // Soft edge across width, fade toward tail, life fade near respawn
  let edge = 1.0 - abs(in.edge);
  let soft = edge * edge * (1.0 - in.along);
  let lifef = smoothstep(0.0, 0.08, in.life) * smoothstep(1.0, 0.92, in.life);

  var amp = u.bass;
  if (role == 1u) { amp = u.mid; }
  if (role == 2u) { amp = u.high; }
  let beat_flash = exp(-fract(u.beat_t) * 6.0) * u.beat_conf * 0.22;
  let struct_boost = 1.0 + u.tension * 0.22 + u.drop_pulse * 0.9;

  let bright = (0.30 + amp * 2.0 + u.pulse * 0.4)
             * soft * lifef * (1.0 + beat_flash) * struct_boost * u.trail_gain;
  return vec4f(rgb * bright, bright);
}
