// SWARM render — birds as tiny elongated quads oriented along velocity,
// projected with a simple pinhole camera. Warm dusk light tinted by the
// music key; banking birds catch the light; depth fog dims the far ones.
// A very faint fullscreen dusk gradient sits behind the flock.
//
// Repurposed slots: _r1 = strike, _r2 = restlessness, _r3 = snare surge.
// extra[] — see swarm_compute.wgsl.

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

struct Boid {
  pos: vec4f,
  vel: vec4f,
}

@group(0) @binding(0) var<uniform>       u:     Uniforms;
@group(0) @binding(1) var<storage, read> boids: array<Boid>;

fn hsv2rgb(c: vec3f) -> vec3f {
  let k = fract(vec3f(c.x, c.x + 2.0 / 3.0, c.x + 1.0 / 3.0)) * 6.0;
  let rgb = clamp(abs(k - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  return c.z * mix(vec3f(1.0), rgb, c.y);
}

// ── dusk sky: faint vertical gradient, key-hue horizon glow ──────────────

struct SkyOut {
  @builtin(position) pos: vec4f,
  @location(0)       uv:  vec2f,
}

@vertex
fn vs_sky(@builtin(vertex_index) vi: u32) -> SkyOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(3.0, 1.0), vec2f(-1.0, 1.0));
  let xy = p[vi];
  return SkyOut(vec4f(xy, 0.0, 1.0), vec2f(xy.x * 0.5 + 0.5, 0.5 - xy.y * 0.5));
}

@fragment
fn fs_sky(in: SkyOut) -> @location(0) vec4f {
  // uv.y: 0 at top → 1 at bottom. Warm glow low, cold whisper high.
  let horizon = pow(max(in.uv.y, 1e-3), 2.6);
  let key  = hsv2rgb(vec3f(u.key_hue, 0.55, 1.0));
  let dusk = mix(vec3f(1.0, 0.52, 0.30), key, u.key_conf * 0.45);
  var col  = dusk * horizon * 0.045;
  col += vec3f(0.010, 0.014, 0.032) * (1.0 - in.uv.y) * 0.5;
  return vec4f(col * u.trail_gain, 0.0);
}

// ── birds ────────────────────────────────────────────────────────────────

struct VSOut {
  @builtin(position) pos:   vec4f,
  @location(0)       local: vec2f,
  @location(1)       col:   vec3f,
  @location(2)       alpha: f32,
}

const FOCAL: f32 = 1.55;

@vertex
fn vs_bird(@builtin(vertex_index) vi: u32) -> VSOut {
  let gi = vi / 6u;
  let ci = vi % 6u;
  let b  = boids[gi];
  let hash = b.pos.w;

  // camera: fixed, with the gentlest drift pan + roll (the flock moves, not us)
  let roll = u.drift_rot * 0.2;
  let cr = cos(roll);
  let sr = sin(roll);
  var p = b.pos.xyz - vec3f(u.drift_x * 0.22, u.drift_y * 0.15, 0.0);
  p = vec3f(cr * p.x - sr * p.y, sr * p.x + cr * p.y, p.z);
  let v = vec3f(cr * b.vel.x - sr * b.vel.y, sr * b.vel.x + cr * b.vel.y, b.vel.z);

  // pinhole projection into screen-proportional space (x scaled by aspect later)
  let z  = max(p.z, 0.35);
  let s0 = p.xy * (FOCAL / z);
  let p2 = p + v * 0.05;
  let z2 = max(p2.z, 0.35);
  let s1 = p2.xy * (FOCAL / z2);
  let dir  = normalize(s1 - s0 + vec2f(1e-5, 2e-5));
  let perp = vec2f(-dir.y, dir.x);

  // elongated along flight direction; wing-flap modulates the width
  let spd  = length(v);
  let size = (0.016 + min(spd, 1.6) * 0.007) * (0.75 + 0.5 * hash) / z;
  let flap = 0.70 + 0.30 * sin(u.time * (8.0 + 7.0 * hash) + hash * 41.0);
  let wid  = size * 0.40 * flap;

  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f( 1.0, -1.0), vec2f(-1.0,  1.0),
    vec2f(-1.0,  1.0), vec2f( 1.0, -1.0), vec2f( 1.0,  1.0),
  );
  let c   = corners[ci];
  let s   = s0 + dir * (c.x * size) + perp * (c.y * wid);
  let asp = u.res_x / u.res_y;

  // light: banking birds catch the low sun; depth fog dims the far ones
  let bank = abs(v.y) / max(spd, 1e-3);
  let fog  = exp(-(z - 1.1) * 0.55);
  var bright = (0.32 + 0.24 * hash) * (0.55 + bank * 0.90) * fog;
  bright *= 1.0 + u._r1 * 0.8 + u.drop_pulse * 0.5;             // strike flash
  bright *= 1.0 + exp(-fract(u.beat_t) * 6.0) * u.beat_conf * 0.10;

  let key = hsv2rgb(vec3f(u.key_hue, 0.40, 1.0));
  var rgb = mix(vec3f(1.05, 0.78, 0.55), key, u.key_conf * 0.45);
  let temp = select(
    mix(vec3f(1.0), vec3f(0.82, 0.88, 1.10), -u.tonality),
    mix(vec3f(1.0), vec3f(1.08, 0.97, 0.86),  u.tonality),
    u.tonality > 0.0);
  rgb *= temp;
  // banking wings catch the low warm sun
  rgb = mix(rgb, vec3f(1.15, 0.72, 0.40), bank * 0.35);
  // aerial perspective: distance shifts birds toward the cool sky tone
  rgb = mix(vec3f(0.45, 0.50, 0.70), rgb, clamp(fog * 1.2, 0.0, 1.0));

  return VSOut(vec4f(s.x / asp, s.y, 0.0, 1.0), c, rgb * bright, 0.12 * u.trail_gain);
}

@fragment
fn fs_bird(in: VSOut) -> @location(0) vec4f {
  let d = length(in.local);
  if (d > 1.0) { discard; }
  let edge = smoothstep(1.0, 0.25, d);
  let a = edge * in.alpha;
  return vec4f(in.col * a, a);   // premultiplied, one/one blend
}
