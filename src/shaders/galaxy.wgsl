// GALAXY render — stars as tiny additive quads, projected from a 3/4
// orbital view (disk tilted, slow azimuth drift). Populations: bulge =
// warm core, arms = blue-white young stars in key-tinted gas, halo =
// faint embers. Kick flares the core; a supernova adds a blinding flash
// and an expanding shockwave ring of overbrightened stars.

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

struct Star {
  a: vec4f,   // r, theta, z, seed
  b: vec4f,   // homeR, pop, armPhase, spare
}

@group(0) @binding(0) var<uniform>             u:     Uniforms;
@group(0) @binding(1) var<storage, read> stars: array<Star>;

fn hsv2rgb(c: vec3f) -> vec3f {
  let k = fract(vec3f(c.x, c.x + 2.0 / 3.0, c.x + 1.0 / 3.0)) * 6.0;
  let rgb = clamp(abs(k - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  return c.z * mix(vec3f(1.0), rgb, c.y);
}

struct VSOut {
  @builtin(position) pos:   vec4f,
  @location(0)       local: vec2f,
  @location(1)       col:   vec3f,
  @location(2)       alpha: f32,
}

const TILT: f32 = 1.12;   // mostly face-on — spiral arms must read
const CAMD: f32 = 2.15;

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  let si = vi / 6u;
  let ci = vi % 6u;
  let s  = stars[si];

  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f( 1.0, -1.0), vec2f(-1.0,  1.0),
    vec2f(-1.0,  1.0), vec2f( 1.0, -1.0), vec2f( 1.0,  1.0),
  );
  let c = corners[ci];

  let r  = s.a.x;
  let th = s.a.y;
  let pos2 = vec2f(cos(th), sin(th)) * r;
  var p = vec3f(pos2.x, s.a.z, pos2.y);

  // slow azimuth drift + micro roll
  let az = u.time * 0.08 + u.drift_rot * 0.25;
  let ca = cos(az); let sa = sin(az);
  p = vec3f(p.x * ca + p.z * sa, p.y, -p.x * sa + p.z * ca);
  // tilt around x
  let ct = cos(TILT); let st = sin(TILT);
  p = vec3f(p.x, p.y * ct - p.z * st, p.y * st + p.z * ct);

  let depth = max(CAMD + p.z, 0.4);
  let aspect = u.res_x / max(u.res_y, 1.0);

  let pop = s.b.y;
  // sizes: bulge slightly bigger; everything shrinks with depth
  let size = (2.2 + select(0.0, 0.9, pop > 0.5) + s.a.w * 1.1) / u.res_y * (2.6 / depth);

  // ── brightness ────────────────────────────────────────────────────────
  var bright = (0.5 + s.a.w * 0.5) / (depth * depth) * 1.8;
  // kick flares the core
  if (pop > 0.5 && pop < 1.5) {
    bright *= 1.0 + u.kick * 1.6 + exp(-fract(u.beat_t) * 6.0) * u.beat_conf * 0.5;
  }
  // Spiral arms as a DENSITY WAVE: stars stream through a rigidly rotating
  // two-armed brightness pattern — the arms never wind away, exactly like
  // a real galaxy. Busy music sharpens the contrast.
  var armF = 0.0;
  if (pop < 0.5) {
    let phase = th - log(max(r, 0.06) / 0.14) * 2.4 - u.time * 0.05;
    armF = pow(0.5 + 0.5 * cos(2.0 * phase), 3.0);
    bright *= 0.28 + (1.9 + u.mid * u.mul_mid * 1.3) * armF;
    // snare shimmer sweeps around the disk
    bright *= 1.0 + u.snare * 0.8 * pow(max(sin(s.b.z + u.time * 2.0), 0.0), 6.0);
  }
  // supernova: blinding flash near the blast + expanding shell
  let nova = u.extra[0];
  if (nova.w > 0.01 && nova.z < 4.0) {
    let d = distance(pos2, nova.xy);
    let ring  = exp(-pow((d - nova.z * 0.72) / 0.09, 2.0)) * exp(-nova.z * 0.8);
    let flash = exp(-nova.z * 6.0) * exp(-d * d * 2.5);
    bright *= 1.0 + ring * 3.5 + flash * 6.0;
  }

  // ── colour by population ──────────────────────────────────────────────
  let warm = clamp(u.tonality * 0.5 + 0.5, 0.0, 1.0);
  var col: vec3f;
  if (pop > 1.5) {          // halo: faint embers
    col = vec3f(0.55, 0.30, 0.22);
  } else if (pop > 0.5) {   // bulge: warm core
    col = vec3f(1.00, 0.72, 0.42);
  } else {                  // arms: young stars in key-tinted gas
    let gas  = hsv2rgb(vec3f(u.key_hue, 0.55 * u.key_conf + 0.15, 1.0));
    let star = mix(vec3f(0.62, 0.74, 1.05), vec3f(1.02, 0.88, 0.66), warm);
    // arm crests glow blue-white with gas; inter-arm dust is dim and warm
    col = mix(mix(star, gas, 0.35) * 0.72 + vec3f(0.08, 0.05, 0.03),
              mix(star, gas, 0.45) * 1.18 + vec3f(0.04, 0.07, 0.14),
              armF);
  }

  let clip = vec2f((p.x / depth * 2.9 + c.x * size) / aspect,
                    p.y / depth * 2.9 + c.y * size);
  return VSOut(vec4f(clip, 0.0, 1.0), c, col, bright);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let d = length(in.local);
  if (d > 1.0) { discard; }
  let edge = smoothstep(1.0, 0.15, d);
  let a = edge * in.alpha * u.trail_gain * 0.11;
  return vec4f(in.col * a, a);   // premultiplied, one/one blend
}
