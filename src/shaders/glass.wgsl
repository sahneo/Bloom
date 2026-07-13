// GLASS — fluted (reeded) glass, tunable material.
//
// Background = either procedural colour blobs (band-bound, key palette) or
// the user's video/image (shared media playlist) — both physically bent by
// one cylindrical lens per rib with chromatic dispersion at rib edges.
// The material is fully parametric: rib count, refraction strength, frost
// blur, light/dark studio, grain amount, crest speculars on/off — from the
// dark glossy look to the matte editorial one, to the transparent
// plants-behind-glass look.
//
// extra[0..6]  = 7 blobs (x, y, depth, brightness)
// extra[8..14] = blob colours (hue, sat, size, -)
// extra[7]     = (ribs, refraction, blur, light)
// extra[15]    = (grain, spec on/off, media on/off, media aspect)
// _r1 = rib melt (drops), _r2 = bass breath

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
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var media: texture_2d<f32>;

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

// Procedural blobs: anisotropic gaussians, smeared vertically by blur
fn blob_field(wp: vec2f, blur: f32) -> vec3f {
  var col = vec3f(0.0);
  for (var i = 0; i < 7; i++) {
    let L = u.extra[i];
    let C = u.extra[8 + i];
    if (L.w < 0.003) { continue; }
    let dx = wp.x - L.x;
    let dy = wp.y - L.y;
    let s  = C.z * mix(1.9, 0.8, L.z);
    let sx = s * 0.60;
    let sy = s * (0.9 + blur * 2.2);
    col += hsv2rgb(vec3f(C.x, C.y, 1.0))
         * L.w * exp(-(dx * dx / (sx * sx) + dy * dy / (sy * sy)) * 2.2);
  }
  return col;
}

// Media sample, cover-fit, with a vertical frost smear
fn media_field(wp: vec2f, blur: f32, aspect: f32, texA: f32) -> vec3f {
  var tuv = vec2f(wp.x / aspect, -wp.y) * 0.5;
  if (texA > aspect) { tuv.x *= aspect / texA; }
  else               { tuv.y *= texA / aspect; }
  var c = vec3f(0.0);
  for (var k = -2; k <= 2; k++) {
    let off = f32(k) * 0.014 * blur;
    c += textureSampleLevel(media, samp,
           clamp(tuv + vec2f(0.0, off) + 0.5, vec2f(0.002), vec2f(0.998)), 0.0).rgb;
  }
  return c * 0.2;
}

fn background(wp: vec2f, blur: f32, light: f32, aspect: f32) -> vec3f {
  let Q = u.extra[15];
  if (Q.z > 0.5) {
    // media brightness lifts slightly in light mode
    return media_field(wp, blur, aspect, Q.w) * (0.85 + light * 0.5);
  }
  // studio backdrop: near-black ↔ warm editorial paper, key-tinted
  let paper = mix(vec3f(0.012, 0.014, 0.018),
                  vec3f(0.78, 0.76, 0.74) + hsv2rgb(vec3f(u.key_hue, 0.35, 0.10)),
                  light);
  return paper * (1.0 + u._r2 * 0.25 * (1.0 - light)) + blob_field(wp, blur);
}

@fragment
fn fs_render(in: VSOut) -> @location(0) vec4f {
  let aspect = u.res_x / max(u.res_y, 1.0);
  let wp0 = vec2f((in.uv.x - 0.5) * 2.0 * aspect, (0.5 - in.uv.y) * 2.0);

  let P = u.extra[7];     // ribs, refraction, blur, light
  let Q = u.extra[15];    // grain, spec, media, texAspect
  let RIBS = max(P.x, 4.0);

  // ── fluted lens per rib ────────────────────────────────────────────────
  let melt = u._r1;
  let xr   = (wp0.x + aspect) * RIBS / (2.0 * aspect);
  let rib  = floor(xr);
  let f    = fract(xr) - 0.5;
  let rh   = hash21(vec2f(rib, u.scene_seed)) - 0.5;
  let bend = -f * (0.34 + rh * 0.05) * melt * P.y;
  let ribW = 2.0 * aspect / RIBS;

  // dispersion at rib edges
  let disp = abs(f) * 0.22 * melt * min(P.y, 1.5);
  let shift = bend * ribW * 6.0;
  var col = vec3f(
    background(vec2f(wp0.x + shift * (1.0 + disp), wp0.y), P.z, P.w, aspect).r,
    background(vec2f(wp0.x + shift,                wp0.y), P.z, P.w, aspect).g,
    background(vec2f(wp0.x + shift * (1.0 - disp), wp0.y), P.z, P.w, aspect).b,
  );

  // ── crest speculars (optional): thin lines that catch the light ───────
  if (Q.y > 0.5) {
    let lum = dot(background(wp0, P.z + 0.5, P.w, aspect), vec3f(0.35, 0.5, 0.15));
    let crest = exp(-pow((abs(f) - 0.30) / 0.045, 2.0));
    let shimmer = 1.0 + u.high * u.mul_high * 0.5
                * sin(u.time * 14.0 + rib * 3.1 + wp0.y * 5.0);
    col += vec3f(0.92, 0.95, 1.0)
         * crest * (0.10 + lum * 1.5) * (1.0 + u.kick * 0.8) * shimmer * 0.35;
  }

  // groove shading: soft in matte/light, crisp gloss edge highlight in dark
  let relief = mix(0.13, 0.22, clamp(P.y * 0.7, 0.0, 1.0));
  col *= (1.0 - relief) + relief * cos(f * 6.28318);
  // glossy sheen: smooth broad reflection running down each rib flank
  let gloss = clamp(1.0 - Q.x * 1.4, 0.0, 1.0);   // grain kills gloss
  let sheen = pow(max(cos((f + 0.18) * 3.14159), 0.0), 8.0);
  col += (vec3f(0.06, 0.065, 0.075) + col * 0.35) * sheen * gloss;

  // ── grain: the matte surface (0 = polished) ───────────────────────────
  let g1 = hash21(in.uv * u.res_x + vec2f(fract(u.time * 0.9) * 17.0));
  col *= 1.0 + (g1 - 0.5) * Q.x * 0.55;

  return vec4f(col, u.trail_gain);
}
