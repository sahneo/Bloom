// REAGENT — render. Maps the (u, v) chemistry field to a duotone dish:
// dark medium, glowing wavefronts (u high, v still low = the leading edge —
// crosses the 0.30 bloom threshold gently), and a deep complementary tint
// in the refractory wake (v high). Relief shading from ∇u gives the waves
// physical thickness, like ripples of reagent in a petri dish under raking
// light. keyHue steers the pair: front = key hue, wake = complement.
// Extra slots (see bz_compute.wgsl):
//   extra[0] = (gridW, gridH, dtSub, b)
//   extra[5] = (wallPos, wallActive, wipe, Dv)     drop sweep highlight
//   extra[8] = (frameRand, quiet, tension, 0)
//   extra[9] = (kickEnv, snareEnv, dropFlash, tapEnv)

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

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> grid: array<vec2f>;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0)       uv:  vec2f,
}

@vertex
fn vs_fullscreen(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  let xy = p[vi];
  return VSOut(vec4f(xy, 0.0, 1.0), vec2f(xy.x * 0.5 + 0.5, 0.5 - xy.y * 0.5));
}

fn hash12(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 345.45));
  q += dot(q, q + 34.345);
  return fract(q.x * q.y);
}

fn hsv2rgb(c: vec3f) -> vec3f {
  let k = fract(vec3f(c.x, c.x + 2.0 / 3.0, c.x + 1.0 / 3.0)) * 6.0;
  let rgb = clamp(abs(k - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  return c.z * mix(vec3f(1.0), rgb, c.y);
}

fn cellAt(x: i32, y: i32) -> vec2f {
  let gw = i32(u.extra[0].x);
  let gh = i32(u.extra[0].y);
  return grid[u32(clamp(y, 0, gh - 1) * gw + clamp(x, 0, gw - 1))];
}

fn fieldAt(uv: vec2f) -> vec2f {
  let gw = u.extra[0].x; let gh = u.extra[0].y;
  let g = vec2f(uv.x * gw, uv.y * gh) - 0.5;
  let i = vec2i(i32(floor(g.x)), i32(floor(g.y)));
  let f = fract(g);
  let a = mix(cellAt(i.x, i.y),     cellAt(i.x + 1, i.y),     f.x);
  let b = mix(cellAt(i.x, i.y + 1), cellAt(i.x + 1, i.y + 1), f.x);
  return mix(a, b, f.y);
}

@fragment
fn fs_render(in: VSOut) -> @location(0) vec4f {
  let E0 = u.extra[0];
  let E8 = u.extra[8];
  let E9 = u.extra[9];
  let gw = E0.x; let gh = E0.y;
  let quiet   = E8.y;
  let tension = E8.z;

  let c = fieldAt(in.uv);
  let U = c.x; let V = c.y;

  // ∇u for relief — waves get physical thickness under raking light
  let dx = vec2f(1.1 / gw, 0.0);
  let dy = vec2f(0.0, 1.1 / gh);
  let gx = fieldAt(in.uv + dx).x - fieldAt(in.uv - dx).x;
  let gy = fieldAt(in.uv + dy).x - fieldAt(in.uv - dy).x;
  let n  = normalize(vec3f(-gx * 2.4, -gy * 2.4, 1.0));
  let rel = clamp(dot(n, normalize(vec3f(-0.45, -0.62, 0.65))), 0.0, 1.0);

  // masks: excited body / bright leading edge / recovering wake
  let sU   = smoothstep(0.12, 0.50, U);
  let edge = sU * (1.0 - smoothstep(0.05, 0.55, V));       // front, not plateau
  let wake = smoothstep(0.06, 0.55, V) * (1.0 - sU * 0.80);

  // duotone palette: front = key hue, wake = complement; tension saturates
  let hueF = fract(u.key_hue);
  let hueW = fract(hueF + 0.5 + u.tonality * 0.04);
  let sat  = clamp(0.55 + tension * 0.28, 0.0, 0.92);
  let frontCol = hsv2rgb(vec3f(hueF, sat * 0.60, 1.0));
  let bodyCol  = hsv2rgb(vec3f(hueF, sat, 1.0));
  let wakeCol  = hsv2rgb(vec3f(hueW, min(sat + 0.18, 0.95), 1.0));

  // quiet passages thin the glow to delicate filigree
  let frontGain = 1.0 - quiet * 0.45;

  // dark dish with the faintest complementary cast
  var col = wakeCol * 0.010 + vec3f(0.0025);
  // excited plateau body — dim, so the EDGE reads as the wave
  col += bodyCol * sU * 0.14 * frontGain;
  // glowing leading edge, gently over the bloom threshold
  col += frontCol * edge * (0.62 * frontGain + E9.x * 0.26 + E9.z * 0.45
                            + u.pulse * 0.10 + E9.y * edge * 0.18);
  // refractory wake — deep complementary chemistry trail
  col += wakeCol * wake * (0.13 + tension * 0.035);

  // relief: raking light across the u-field slopes
  col *= 1.0 + (rel - 0.62) * 0.60 * smoothstep(0.02, 0.25, U + V * 0.5);

  // drop wall sweep: a hot line crossing the dish
  let W = u.extra[5];
  if (W.y > 0.5) {
    let d = abs(in.uv.x - W.x);
    col += vec3f(1.0, 0.97, 0.90) * exp(-d * 90.0) * 0.9 * W.z;
  }

  // very light grain — chemistry, not plastic
  col += (hash12(in.pos.xy + fract(u.time) * 61.7) - 0.5) * 0.007;

  // vignette keeps it a dish, not a wallpaper
  let dd = in.uv - vec2f(0.5);
  col *= 1.0 - dot(dd, dd) * 0.62;

  return vec4f(max(col, vec3f(0.0)), 1.0);
}
