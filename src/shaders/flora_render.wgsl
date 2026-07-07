// FLORA — petal rendering. Each petal is a quad oriented outward from the
// flower's heart; a teardrop SDF shapes it, an age envelope blooms and wilts
// it. Additive HDR into the shared accumulation buffer.

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
  ripple_pos_age: array<vec4f, 8>,
  ripple_color:   array<vec4f, 8>,
}

@group(0) @binding(0) var<uniform>         u: Uniforms;
@group(0) @binding(1) var<storage, read>   petals: array<vec4f>;

fn hsv2rgb(c: vec3f) -> vec3f {
  let k = fract(vec3f(c.x, c.x + 2.0 / 3.0, c.x + 1.0 / 3.0)) * 6.0;
  let rgb = clamp(abs(k - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  return c.z * mix(vec3f(1.0), rgb, c.y);
}

struct VSOut {
  @builtin(position) pos:    vec4f,
  @location(0)       local:  vec2f,  // x: -1..1 width, y: 0..1 base→tip
  @location(1)       age01:  f32,    // age / duration
  @location(2)       hueoff: f32,
  @location(3)       seed:   f32,
  @location(4)       depth:  f32,    // perspective factor for fog
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  let pi = vi / 6u;
  let ci = vi % 6u;
  let a  = petals[pi * 2u];
  let b  = petals[pi * 2u + 1u];
  let seed = f32(pi % 997u);

  var corners = array<vec2f, 6>(
    vec2f(-1.0, 0.0), vec2f(1.0, 0.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, 0.0), vec2f( 1.0, 1.0),
  );
  let c = corners[ci];

  let age = u.time - a.z;
  let dur = max(a.w, 0.001);
  var env = 0.0;
  if (age >= 0.0 && age <= dur && a.w > 0.0) {
    // Bloom in fast with a little overshoot, hold, wilt away
    let grow = smoothstep(0.0, 0.5, age) * (1.0 + 0.15 * exp(-age * 3.0) * sin(age * 9.0));
    let wilt = 1.0 - smoothstep(dur * 0.65, dur, age);
    env = grow * wilt;
  }

  // Sway rides the lead band; kick + beat pulse the whole flower hard
  let sway  = sin(u.time * 1.3 + seed * 0.37) * (0.04 + u.mid * u.mul_mid * 0.22) * env;
  let angle = b.x + sway;
  let beat_size = 1.0 + exp(-fract(u.beat_t) * 8.0) * u.beat_conf * 0.18
                + u.kick * 0.30 + u.bass * 0.12;

  // ── 3D: petals live at (xy, z); the camera orbits the flower — petals do
  // NOT follow it, so near ones sweep past while far ones creep (parallax)
  let theta = u.time * 0.07 + u.scene_seed * 0.13;
  let ct = cos(theta);
  let st = sin(theta);
  let w3 = vec3f(a.xy, b.w);
  let rx = w3.x * ct - w3.z * st;         // orbit around the vertical axis
  let rz = w3.x * st + w3.z * ct;
  let cam_d = 2.1;
  let bob   = sin(u.time * 0.11) * 0.12;  // slow vertical camera float
  let viewz = rz + cam_d;
  let persp = cam_d / max(viewz, 0.4);

  let L = b.y * env * beat_size * (1.0 + u.pulse * 0.3);
  let W = L * 0.42;
  // Petal orientation foreshortens as the flower turns
  let dir2 = vec2f(cos(angle), sin(angle));
  let sdir = normalize(vec2f(dir2.x * ct, dir2.y) + vec2f(0.0001));
  let sperp = vec2f(-sdir.y, sdir.x);
  let centre2 = vec2f(rx, w3.y - bob);
  let world = (centre2 + sdir * (c.y * L) + sperp * (c.x * W)) * persp;

  let aspect = u.res_x / u.res_y;
  return VSOut(vec4f(world.x / aspect, world.y, 0.0, 1.0), c, age / dur, b.z, seed, persp);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  // Teardrop petal: narrow base, widest ~55% out, closes to a pointed tip
  let widen = mix(0.25, 1.0, smoothstep(0.0, 0.55, in.local.y))
            * (1.0 - smoothstep(0.55, 1.0, in.local.y) * 0.95);
  let d = abs(in.local.x) / max(widen, 0.05);
  if (d > 1.0 || in.local.y < 0.0) { discard; }
  let shape = smoothstep(1.0, 0.55, d);
  // Central vein highlight
  let vein = exp(-in.local.x * in.local.x * 40.0) * 0.35;

  // Palette: petals live on the key hue (with per-petal variation); the
  // complementary scheme flips every third petal to the accent colour
  var key_sat = 0.65 + u.tonality * 0.10;
  let key_val = 0.95;
  var hue = fract(u.key_hue + in.hueoff * 0.07);
  let pm = u32(u.palette_mode + 0.5);
  if (pm == 1u && in.seed % 3.0 < 1.0) { hue = fract(hue + 0.5); key_sat *= 0.6; }
  if (pm == 2u && in.seed % 3.0 < 1.0) { hue = fract(hue + 0.5); }
  if (pm == 3u) { hue = fract(hue + (in.seed % 5.0 - 2.0) * 0.03); }
  let key_rgb = hsv2rgb(vec3f(hue, key_sat, key_val));

  let neutral = vec3f(0.85, 0.87, 1.0);
  let rgb = mix(neutral, key_rgb, max(u.key_conf, 0.25));

  // Older petals dim and desaturate toward decay
  let decay = 1.0 - smoothstep(0.6, 1.0, in.age01) * 0.5;

  let beat_flash = exp(-fract(u.beat_t) * 6.0) * u.beat_conf * 0.35;
  let struct_boost = 1.0 + u.tension * 0.20 + u.drop_pulse * 0.8;

  // Depth fog: petals behind the flower dim and cool, near ones glow
  let fog = mix(0.35, 1.25, smoothstep(0.6, 1.5, in.depth));

  // Hats shimmer petals individually; kick/snare light the whole corolla
  let shimmer = 1.0 + u.high * 0.7 * sin(u.time * 23.0 + in.seed * 1.7);
  let bright = (0.14 + u.mid * 0.60 + u.bass * 0.35 + u.kick * 0.45 + u.snare * 0.30)
             * (shape + vein) * decay * fog * (1.0 + beat_flash) * shimmer * struct_boost * u.trail_gain;
  return vec4f(rgb * bright, bright);
}
