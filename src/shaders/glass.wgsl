// GLASS — glassmorphism: coloured lights drifting and flashing at different
// depths BEHIND a wall of frosted glass blocks. Each block is a convex lens
// that genuinely refracts the light field (the light positions are warped
// per-tile before evaluation, like real склоблоки), with a bevel sheen where
// blocks meet. Depth = blur: far lights are wide soft blobs, near lights are
// tight and hot.
//
// Lights come from JS in the extra[] region: extra[i] = (x, y, depth,
// brightness), extra[8+i] = (hue, sat, size, spare), 8 lights. High band
// adds procedural micro-twinkles. _r1 = refraction strength (drops ripple
// the glass), _r2 = global brightness breath.

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

fn hash21(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

const GRID_X: f32 = 6.0;   // glass blocks across the width

// Evaluate the light field at a (already warped) world position.
// Analytic gaussians — "frost blur" is just a bigger sigma with depth,
// so the whole depth-of-field look costs nothing.
fn light_field(wp: vec2f) -> vec3f {
  var col = vec3f(0.0);
  for (var i = 0; i < 8; i++) {
    let L = u.extra[i];          // x, y, depth, brightness
    let C = u.extra[8 + i];      // hue, sat, size, -
    if (L.w < 0.003) { continue; }
    let d2 = dot(wp - L.xy, wp - L.xy);
    // depth → blur: far (depth 0) huge and soft, near (1) tight and hot
    let sigma = C.z * mix(2.6, 0.55, L.z);
    let g = L.w * exp(-d2 / (sigma * sigma * 0.045));
    // near lights get a hot core on top of the glow
    let core = L.w * L.z * 0.6 * exp(-d2 / (sigma * sigma * 0.006));
    col += hsv2rgb(vec3f(C.x, C.y, 1.0)) * (g + core);
  }
  // procedural micro-twinkles riding the high band — tiny POINTS inside
  // their cells (a whole-cell glow read as square confetti through the
  // blocks)
  let twp = wp * 5.0 + vec2f(u.scene_seed * 7.0);
  let h = hash21(floor(twp));
  let f = fract(twp) - vec2f(0.3 + h * 0.4, 0.3 + fract(h * 7.7) * 0.4);
  let point = exp(-dot(f, f) * 90.0);
  let tw = pow(max(sin(u.time * (1.5 + h * 3.0) + h * 40.0), 0.0), 24.0)
         * step(0.55, h) * u.high * u.mul_high * 1.6 * point;
  col += hsv2rgb(vec3f(u.key_hue + h * 0.3 - 0.15, 0.55, 1.0)) * tw;
  return col * 1.25;
}

@fragment
fn fs_render(in: VSOut) -> @location(0) vec4f {
  let aspect = u.res_x / max(u.res_y, 1.0);
  // world coords: x ∈ ±aspect, y ∈ ±1
  let wp0 = vec2f((in.uv.x - 0.5) * 2.0 * aspect, (0.5 - in.uv.y) * 2.0);

  // ── glass-block lattice ────────────────────────────────────────────────
  let grid = vec2f(GRID_X, floor(GRID_X / aspect + 0.5)) / vec2f(2.0 * aspect, 2.0);
  let gp   = (wp0 + vec2f(aspect, 1.0)) * grid;       // lattice space
  let cell = floor(gp);
  var q    = fract(gp) * 2.0 - 1.0;                   // tile-local ∈ ±1
  let ch   = hash21(cell + u.scene_seed);

  // convex lens per tile: barrel distortion, slight per-tile axis variance
  let refr = u._r1;
  let r2   = dot(q, q);
  var off  = q * r2 * (0.22 + ch * 0.10) * refr;
  // subtle per-tile shear so blocks feel hand-made, not perfect
  off += vec2f(q.y, q.x) * (ch - 0.5) * 0.05 * refr;
  let wp = wp0 + off;

  // ── light field seen through the glass ────────────────────────────────
  var col = light_field(wp);
  // a faint second refraction ghost (double image at tile edges)
  col += light_field(wp0 + off * 2.3) * 0.22 * smoothstep(0.25, 0.95, r2);

  // ── the glass itself ──────────────────────────────────────────────────
  // bevel: light catches where blocks meet
  let edge  = max(abs(q.x), abs(q.y));
  let bevel = smoothstep(0.80, 0.985, edge);
  col *= 1.0 + bevel * 0.9;
  col += vec3f(0.9, 0.95, 1.05) * bevel * (0.012 + length(col) * 0.05);

  // frosted grain — fine surface noise
  let grain = hash21(in.uv * u.res_x + vec2f(fract(u.time) * 13.0));
  col *= 0.95 + grain * 0.10;

  // cool ambient sheen so the wall reads as a surface, breathing with sub
  let sheen = (0.010 + u.sub_bass * u.mul_sb * 0.012)
            * (0.6 + 0.4 * sin(wp0.x * 0.7 + wp0.y * 1.3 + u.time * 0.1));
  col += vec3f(0.55, 0.62, 0.75) * sheen;

  // global breath (bass EMA from JS)
  col *= 0.9 + u._r2 * 0.35;

  return vec4f(col, u.trail_gain);
}
