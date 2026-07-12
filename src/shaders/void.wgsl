// VOID — raymarched flight through an infinite fractal cathedral.
//
// A Mandelbox lattice repeats in all three axes; the camera flies down a
// corridor between the cells, weaving gently. Music sculpts the geometry:
// tonality rounds/sharpens the folds, timbre hardens the highlights, the
// kick lurches the camera forward, drops briefly collapse the fractal
// scale so the whole cathedral folds in on itself and recovers.
//
// One fullscreen pass, distance-estimated sphere tracing. Cost is bounded
// by MAX_STEPS × ITER map evaluations; adaptive DPR upstream handles the
// rest. Renders into the shared HDR accum with alpha blending — the alpha
// is the motion-blur persistence (driven by the Trail slider).

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

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0)       uv:  vec2f,
}

@vertex
fn vs_fullscreen(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(3.0, 1.0), vec2f(-1.0, 1.0));
  let xy = p[vi];
  return VSOut(vec4f(xy, 0.0, 1.0), vec2f(xy.x * 0.5 + 0.5, 0.5 - xy.y * 0.5));
}

fn hsv2rgb(c: vec3f) -> vec3f {
  let k = fract(vec3f(c.x, c.x + 2.0 / 3.0, c.x + 1.0 / 3.0)) * 6.0;
  let rgb = clamp(abs(k - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  return c.z * mix(vec3f(1.0), rgb, c.y);
}

fn rot2(a: f32) -> mat2x2f {
  let c = cos(a); let s = sin(a);
  return mat2x2f(vec2f(c, s), vec2f(-s, c));
}

const CELL: f32 = 11.0;      // lattice period; corridor runs along cell corners
const ITER: i32 = 8;         // mandelbox folds
const MAX_STEPS: i32 = 96;
const FAR: f32 = 34.0;

// Geometry morph parameters, derived once per fragment from the music.
// scale: breathes slowly, collapses on drops (dropPulse spikes → recovers)
// fold:  tonality — major widens/rounds the vaults, minor pulls them gothic
struct Morph { scale: f32, fold: f32, min_r2: f32 }

fn morph() -> Morph {
  var m: Morph;
  let slow = sin(u.time * 0.031 + u.scene_seed * 7.3);
  m.scale  = 2.55 + slow * 0.22 + u.tonality * 0.12 - u.drop_pulse * 1.35;
  m.fold   = 1.0 + u.tonality * 0.14 + sin(u.time * 0.023 + u.scene_seed) * 0.08;
  m.min_r2 = 0.28 + sin(u.time * 0.017 + u.scene_seed * 3.1) * 0.10;
  return m;
}

// Mandelbox distance estimator with an orbit trap for colouring.
// Returns (distance, trap).
fn map(p: vec3f, m: Morph) -> vec2f {
  // Infinite lattice: fold world space into one cell centred on origin
  var q = (fract(p / CELL + 0.5) - 0.5) * CELL;
  // Slow rotation of every cell keeps the architecture drifting; the bar
  // downbeat is woven in so the space subtly "turns a corner" each bar
  let a = u.time * 0.02 + u.drift_rot * 0.4;
  let rq = rot2(a) * q.xy;
  q = vec3f(rq.x, rq.y, q.z);

  var z  = q;
  var dr = 1.0;
  var trap = 1e9;
  for (var i = 0; i < ITER; i++) {
    // box fold
    z = clamp(z, vec3f(-m.fold), vec3f(m.fold)) * 2.0 - z;
    // sphere fold
    let r2 = dot(z, z);
    trap = min(trap, r2);
    if (r2 < m.min_r2) {
      let t = 1.0 / m.min_r2;
      z *= t; dr *= t;
    } else if (r2 < 1.0) {
      let t = 1.0 / r2;
      z *= t; dr *= t;
    }
    z = z * m.scale + q;
    dr = dr * abs(m.scale) + 1.0;
  }
  return vec2f(length(z) / abs(dr), trap);
}

fn normal_at(p: vec3f, m: Morph, eps: f32) -> vec3f {
  // tetrahedron gradient — 4 taps
  let k = vec2f(1.0, -1.0);
  return normalize(
    k.xyy * map(p + k.xyy * eps, m).x +
    k.yyx * map(p + k.yyx * eps, m).x +
    k.yxy * map(p + k.yxy * eps, m).x +
    k.xxx * map(p + k.xxx * eps, m).x);
}

@fragment
fn fs_render(in: VSOut) -> @location(0) vec4f {
  let aspect = u.res_x / max(u.res_y, 1.0);
  var sp = (in.uv - 0.5) * 2.0;
  sp.x *= aspect;

  let m = morph();

  // ── Camera: flies down the corridor between cells ──────────────────
  // u.time is the tension-warped clock, so builds accelerate the flight;
  // each beat adds a forward lurch that eases off through the beat.
  let lurch = exp(-fract(u.beat_t) * 5.0) * u.beat_conf * 0.55;
  let zf    = u.time * 2.1 + lurch + u.beat_t * 0.12;
  // Weave around the corridor centre (cell corner), never near the boxes
  let corner = CELL * 0.5;
  var ro = vec3f(
    corner + sin(zf * 0.13 + u.scene_seed) * 0.9 + u.drift_x * 0.8,
    corner + cos(zf * 0.11 + u.scene_seed * 2.0) * 0.9 + u.drift_y * 0.8,
    zf);
  // Look slightly into the weave so turns feel banked
  var fwd = normalize(vec3f(
    cos(zf * 0.13 + u.scene_seed) * 0.13,
    -sin(zf * 0.11 + u.scene_seed * 2.0) * 0.11,
    1.0));
  // Roll from generative drift
  let roll = rot2(u.drift_rot * 0.5);
  var rt = normalize(cross(vec3f(0.0, 1.0, 0.0), fwd));
  var up = cross(fwd, rt);
  let rr = roll * vec2f(1.0, 0.0);
  let rt2 = rt * rr.x + up * rr.y;
  let up2 = up * rr.x - rt * rr.y;
  let rd = normalize(fwd * 1.35 + rt2 * sp.x + up2 * sp.y);

  // ── March ────────────────────────────────────────────────────────────
  var t = 0.02;
  var d = 0.0;
  var trap = 0.0;
  var steps = 0;
  var hit = false;
  for (var i = 0; i < MAX_STEPS; i++) {
    steps = i;
    let h = map(ro + rd * t, m);
    d = h.x;
    trap = h.y;
    if (d < 6e-4 * t) { hit = true; break; }
    t += d * 0.9;
    if (t > FAR) { break; }
  }

  // ── Shade ────────────────────────────────────────────────────────────
  // Fog colour: near-black with the key tint, breathing with sub-bass
  let fog_col = hsv2rgb(vec3f(u.key_hue, 0.55, 0.028 + u.sub_bass * 0.03))
              * max(u.key_conf, 0.25);
  var col = fog_col;

  if (hit) {
    let p = ro + rd * t;
    let n = normal_at(p, m, max(3e-4 * t, 2e-4));

    // Crevice measure: many steps = tight geometry → this is where light
    // veins live. AO darkens broad faces so veins pop.
    let ao      = clamp(1.0 - f32(steps) / f32(MAX_STEPS) * 1.4, 0.0, 1.0);
    let crevice = pow(1.0 - ao, 3.2);   // selective: only tight geometry glows

    // Palette: orbit trap sweeps a wide hue band around the key colour so
    // the architecture reads as carved from different minerals
    let hue  = u.key_hue + fract(trap * 0.23) * 0.28 - 0.14
             + u.palette_mode * 0.07;
    let sat  = 0.55 + u.key_conf * 0.25;
    let alb  = hsv2rgb(vec3f(hue, sat, 1.0));

    // Two-source light: camera headlight (kick-flashed) + a cool top light
    // so broad faces get a gradient instead of reading flat
    let ndl  = max(dot(n, -rd), 0.0);
    let head = ndl * (0.30 + u.kick * 0.45 + u.snare * 0.12);
    let sky  = (n.y * 0.5 + 0.5) * 0.14;

    // Specular: timbre drives the surface finish — saw = glassy hard,
    // sine = soft matte
    let spec_pow = mix(8.0, 60.0, u.sharpness);
    let spec = pow(max(dot(reflect(rd, n), -rd), 0.0), spec_pow)
             * (0.15 + u.sharpness * 0.8);

    // Emissive veins: crevices glow with the music, pulsing on the beat.
    // Clamped — a loud mix must never white the walls out.
    let beat_glow = 1.0 + exp(-fract(u.beat_t) * 4.0) * u.beat_conf * 0.9;
    let vein = min(crevice * (0.25 + u.mid * u.mul_mid * 0.9 + u.high * u.mul_high * 0.7)
             * beat_glow, 1.4);
    let vein_col = hsv2rgb(vec3f(hue + 0.45, 0.65, 1.0));   // complementary

    // God-light along the corridor axis: an endless beam we fly inside,
    // pulsing on the beat — it lights nearby walls and pulls the eye deeper
    let cxy = vec2f(corner) + CELL * round((p.xy - vec2f(corner)) / CELL);
    let ld  = length(p.xy - cxy);
    let beam_amp = 0.30 + exp(-fract(u.beat_t) * 4.0) * u.beat_conf * 0.45 + u.kick * 0.35;
    let beam = beam_amp / (0.5 + ld * ld * 0.22);
    let beam_col = hsv2rgb(vec3f(u.key_hue, 0.45, 1.0));

    col = alb * ((head + sky) * ao + 0.020)
        + vein_col * vein * 0.7
        + beam_col * beam * 0.16
        + vec3f(spec) * ao;

    // Depth fog — bass thickens it so heavy sections close the space in
    let fog_d = 0.08 + u.bass * u.mul_bass * 0.02 - u.tension * 0.025;
    col = mix(fog_col, col, exp(-t * max(fog_d, 0.03)));
  }

  // Vanishing-point glow: rays aligned with the flight axis pick up light
  // from the depths — the corridor centre breathes instead of dying black.
  // Far hits get the full amount, near walls almost none.
  let depth_w  = select(1.0, min(t / FAR * 1.6, 1.0), hit);
  let beat_amp = 0.10 + exp(-fract(u.beat_t) * 4.0) * u.beat_conf * 0.12 + u.kick * 0.08;
  col += hsv2rgb(vec3f(u.key_hue, 0.4, 1.0)) * beat_amp * depth_w
       * pow(max(dot(rd, vec3f(0.0, 0.0, 1.0)), 0.0), 7.0);

  // Drop shockwave: white-hot radial flash from the corridor vanishing point
  col += vec3f(1.0, 0.96, 0.9) * u.drop_pulse * 0.35 * pow(max(1.0 - length(sp) * 0.7, 0.0), 2.0);

  // MIDI note attacks flash the whole space gently
  col *= 1.0 + u.pulse * 0.25;

  // trail_gain carries the motion-blur alpha (persistence) from JS
  return vec4f(col, u.trail_gain);
}
