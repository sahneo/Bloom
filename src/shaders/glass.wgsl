// GLASS — fluted (reeded) glass, редизайн за мудбордом neobjects/glass-material:
// soft organic colour fields drift BEHIND a full-screen wall of vertical
// glass ribs. Each rib is a cylindrical lens: it refracts horizontally and
// smears vertically (anisotropic blur), so the blobs become elegant striped
// gradients. Thin specular lines ride the rib crests, edges get chromatic
// dispersion, and a heavy frost grain finishes the material.
//
// Lights from JS in extra[]: extra[i] = (x, y, depth, brightness),
// extra[8+i] = (hue, sat, size, -), 8 blobs. _r1 = rib melt (drops),
// _r2 = bass breath.

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

const RIBS: f32 = 42.0;   // vertical flutes across the width

// Colour field behind the glass: anisotropic gaussians — tight in x, long
// in y — so the flutes read as smearing everything into vertical streaks.
fn light_field(wp: vec2f, stretch: f32) -> vec3f {
  var col = vec3f(0.0);
  for (var i = 0; i < 8; i++) {
    let L = u.extra[i];          // x, y, depth, brightness
    let C = u.extra[8 + i];      // hue, sat, size, -
    if (L.w < 0.003) { continue; }
    let dx = wp.x - L.x;
    let dy = wp.y - L.y;
    // depth → focus: near blobs are tighter and hotter
    let s  = C.z * mix(1.9, 0.8, L.z);
    let sx = s * 0.55;
    let sy = s * (1.6 + stretch * 1.4);
    let g = L.w * exp(-(dx * dx / (sx * sx) + dy * dy / (sy * sy)) * 2.2);
    col += hsv2rgb(vec3f(C.x, C.y, 1.0)) * g;
  }
  return col;
}

@fragment
fn fs_render(in: VSOut) -> @location(0) vec4f {
  let aspect = u.res_x / max(u.res_y, 1.0);
  let wp0 = vec2f((in.uv.x - 0.5) * 2.0 * aspect, (0.5 - in.uv.y) * 2.0);

  // ── fluted glass: one cylindrical lens per rib ─────────────────────────
  // melt (drops) widens the lens action; a hair of per-rib variance keeps
  // the wall hand-made rather than mechanical
  let melt = u._r1;
  let xr   = (wp0.x + aspect) * RIBS / (2.0 * aspect);
  let rib  = floor(xr);
  let f    = fract(xr) - 0.5;                    // -0.5..0.5 across the rib
  let rh   = hash21(vec2f(rib, u.scene_seed)) - 0.5;
  // cylindrical refraction: strongest at rib edges, zero at the crest
  let bend = -f * (0.34 + rh * 0.05) * melt;
  let ribW = 2.0 * aspect / RIBS;

  // dispersion: R/G/B refract slightly differently near the rib edges
  let disp = abs(f) * 0.22 * melt;
  let wpG = vec2f(wp0.x + bend * ribW * 6.0, wp0.y);
  let wpR = vec2f(wp0.x + bend * (1.0 + disp) * ribW * 6.0, wp0.y);
  let wpB = vec2f(wp0.x + bend * (1.0 - disp) * ribW * 6.0, wp0.y);

  let stretch = 1.0;
  var col = vec3f(
    light_field(wpR, stretch).r,
    light_field(wpG, stretch).g,
    light_field(wpB, stretch).b,
  );

  // ── rib crest speculars: two thin vertical lines per flute ─────────────
  // brightness follows what's behind + kick; hats make them shimmer
  let behind = light_field(vec2f(wp0.x, wp0.y), 1.4);
  let lum = dot(behind, vec3f(0.35, 0.5, 0.15));
  let crest = exp(-pow((abs(f) - 0.30) / 0.045, 2.0));
  let shimmer = 1.0 + u.high * u.mul_high * 0.5
              * sin(u.time * 14.0 + rib * 3.1 + wp0.y * 5.0);
  let spec = crest * (0.10 + lum * 1.5) * (1.0 + u.kick * 0.8) * shimmer;
  col += vec3f(0.92, 0.95, 1.0) * spec * 0.35;

  // soft shadow in the rib grooves — gives the wall its relief
  col *= 0.82 + 0.18 * cos(f * 6.28318);

  // ── frost: heavy fine grain, the matte surface itself ──────────────────
  let grain = hash21(in.uv * u.res_x + vec2f(fract(u.time * 0.9) * 17.0));
  col *= 0.90 + grain * 0.20;
  // faint cool ambient so black stays airy, breathing with the bass
  col += vec3f(0.012, 0.014, 0.018) * (1.0 + u._r2 * 0.9);

  return vec4f(col, u.trail_gain);
}
