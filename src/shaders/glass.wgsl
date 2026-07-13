// GLASS — parametric glass wall in three shapes:
//   0 FLUTES   — vertical reeded ribs (cylindrical lenses)
//   1 WATER    — a living water surface: evolving directional waves refract
//                the background, glossy glints + caustic filaments
//   2 HAMMERED — dimpled artisan glass, per-cell lenses with sparkle
//
// Background = 7 organic colour blobs (pen-tool silhouettes, lava-lamp
// morphing) or the shared media playlist. On the light "paper" studio the
// blobs blend as PIGMENT (multiplicative) so colours stay rich on white.
//
// extra[0..6] blobs, extra[8..14] blob colours,
// extra[7]  = (ribs, refraction, blur, light)
// extra[15] = (grain, spec+shape*2, media, mediaAspect)
// _r1 = melt (drops), _r2 = bass breath

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

fn vnoise(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p);
  let w = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), w.x),
             mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), w.x), w.y);
}

// Organic pen-tool blobs (lava-lamp morphing) — see previous revision
fn blob_field(wp: vec2f, blur: f32) -> vec3f {
  var col = vec3f(0.0);
  for (var i = 0; i < 7; i++) {
    let L = u.extra[i];
    let C = u.extra[8 + i];
    if (L.w < 0.003) { continue; }
    let sd = f32(i) * 7.31 + u.scene_seed * 1.7;
    let stretchP = 1.0 + 0.45 * sin(u.time * 0.055 + sd * 2.2);
    var dx = (wp.x - L.x) / stretchP;
    var dy = (wp.y - L.y) * stretchP / (1.0 + blur * 1.6);
    let ang = atan2(dy, dx);
    let a2 = 0.24 + 0.14 * sin(u.time * 0.043 + sd);
    let a3 = 0.18 + 0.12 * sin(u.time * 0.061 + sd * 3.1);
    let rMod = 1.0
             + a2 * sin(2.0 * ang + u.time * 0.19 + sd * 11.0)
             + a3 * sin(3.0 * ang - u.time * 0.14 + sd * 5.7)
             + 0.10 * sin(5.0 * ang + u.time * 0.23 + sd * 3.3);
    let s = C.z * mix(1.9, 0.8, L.z) * 0.85 * rMod;
    let d2 = (dx * dx + dy * dy) / (s * s);
    col += hsv2rgb(vec3f(C.x, C.y, 1.0)) * L.w * exp(-d2 * 2.0);
  }
  return col;
}

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
    return media_field(wp, blur, aspect, Q.w) * (0.85 + light * 0.5);
  }
  let b = blob_field(wp, blur);
  // dark studio: blobs are LIGHT (additive). light studio: blobs are
  // PIGMENT — multiplicative ink on paper, so colour stays rich on white
  let paper = vec3f(0.82, 0.80, 0.78) + hsv2rgb(vec3f(u.key_hue, 0.35, 0.06));
  let lum = dot(b, vec3f(0.299, 0.587, 0.114));
  let tint = b / max(lum, 0.30);                        // normalized hue
  let amt  = clamp(lum * 1.5, 0.0, 0.92);
  let pigment = paper * mix(vec3f(1.0), tint * 0.85, amt);
  let dark = vec3f(0.012, 0.014, 0.018) * (1.0 + u._r2 * 0.25) + b;
  return mix(dark, pigment, light);
}

// ── WATER surface: sum of drifting directional waves + noise wobble ──────
// Returns height; analytic-ish gradient via the same sum.
fn waterG(p: vec2f, t: f32) -> vec2f {
  var g = vec2f(0.0);
  // four wave trains in incommensurate directions/speeds
  let D = array<vec2f, 4>(vec2f(0.83, 0.55), vec2f(-0.62, 0.78),
                          vec2f(0.31, -0.95), vec2f(-0.97, -0.24));
  let F = array<f32, 4>(2.1, 3.3, 4.7, 6.1);
  let S = array<f32, 4>(0.55, -0.42, 0.68, -0.83);
  let A = array<f32, 4>(0.42, 0.30, 0.20, 0.12);
  for (var k = 0; k < 4; k++) {
    let ph = dot(D[k], p) * F[k] + t * S[k] + u.scene_seed * f32(k + 1);
    g += D[k] * F[k] * A[k] * cos(ph);
  }
  // slow chaotic wobble so it never loops
  let e = 0.06;
  let n0 = vnoise(p * 1.7 + vec2f(t * 0.11, -t * 0.07));
  g.x += (vnoise(p * 1.7 + vec2f(e, 0.0) + vec2f(t * 0.11, -t * 0.07)) - n0) / e * 0.35;
  g.y += (vnoise(p * 1.7 + vec2f(0.0, e) + vec2f(t * 0.11, -t * 0.07)) - n0) / e * 0.35;
  return g;
}

// caustic filaments: ridged noise advected with the water
fn caustics(p: vec2f, t: f32) -> f32 {
  let q = p * 2.6 + vec2f(t * 0.13, t * 0.09);
  let n1 = 1.0 - abs(vnoise(q) * 2.0 - 1.0);
  let n2 = 1.0 - abs(vnoise(q * 1.9 + vec2f(7.7, 3.1) - vec2f(t * 0.11, 0.0)) * 2.0 - 1.0);
  return pow(max(n1 * n2, 1e-3), 3.5);
}

@fragment
fn fs_render(in: VSOut) -> @location(0) vec4f {
  let aspect = u.res_x / max(u.res_y, 1.0);
  let wp0 = vec2f((in.uv.x - 0.5) * 2.0 * aspect, (0.5 - in.uv.y) * 2.0);

  let P = u.extra[7];
  let Q = u.extra[15];
  let qi = i32(Q.y + 0.5);
  let specOn = (qi & 1) == 1;
  let shape  = qi >> 1;
  let gloss  = clamp(1.0 - Q.x * 1.4, 0.0, 1.0);   // grain kills gloss
  let melt   = u._r1;

  var off    = vec2f(0.0);     // refraction offset
  var shade  = 1.0;            // surface relief shading
  var specC  = vec3f(0.0);     // additive speculars/caustics
  var fRib   = 0.0;            // flute-local coord (spec lines)
  var ribId  = 0.0;

  if (shape == 1) {
    // ── WATER ─────────────────────────────────────────────────────────
    let g = waterG(wp0 * 0.9, u.time * (0.55 + u.tension * 0.5)) * (0.6 + u.bass * u.mul_bass * 0.35);
    off = g * 0.055 * P.y * melt;
    let n3 = normalize(vec3f(-g.x, -g.y, 2.4));
    // glossy glints: two lights, tight HDR highlights that bloom
    let L1 = normalize(vec3f(0.45, 0.65, 0.62));
    let L2 = normalize(vec3f(-0.55, -0.30, 0.78));
    let glint = pow(max(dot(n3, L1), 0.0), 90.0) * 2.8
              + pow(max(dot(n3, L2), 0.0), 140.0) * 1.8;
    specC += vec3f(0.95, 0.97, 1.0) * glint * gloss * (1.0 + u.kick * 0.7);
    specC += vec3f(0.85, 0.92, 1.0) * caustics(wp0, u.time) * gloss * P.y
           * (0.10 + 0.5 * clamp(P.w, 0.0, 1.0)) * (1.0 + u.kick * 0.4);
    shade = 0.9 + 0.28 * n3.y;
  } else if (shape == 2) {
    // ── HAMMERED: jittered cell dimples, each its own little lens ──────
    let k = 7.0;
    let cell = floor(wp0 * k);
    let ch = hash21(cell + u.scene_seed);
    let ctr = (cell + 0.5 + (vec2f(ch, fract(ch * 7.7)) - 0.5) * 0.6) / k;
    let d = wp0 - ctr;
    let r = length(d) * k * 1.8;
    let bump = exp(-r * r);
    off = -d * bump * 2.2 * P.y * melt;
    let n3 = normalize(vec3f(off * 4.0, 1.0));
    let glint = pow(max(dot(n3, normalize(vec3f(0.4, 0.6, 0.68))), 0.0), 70.0);
    specC += vec3f(0.95, 0.97, 1.0) * glint * gloss * 1.6 * (0.5 + ch);
    shade = 0.86 + 0.14 * cos(r * 2.2);
  } else {
    // ── FLUTES ─────────────────────────────────────────────────────────
    let RIBS = max(P.x, 4.0);
    let xr   = (wp0.x + aspect) * RIBS / (2.0 * aspect);
    ribId = floor(xr);
    fRib  = fract(xr) - 0.5;
    let rh   = hash21(vec2f(ribId, u.scene_seed)) - 0.5;
    let ribW = 2.0 * aspect / RIBS;
    off = vec2f(-fRib * (0.34 + rh * 0.05) * melt * P.y * ribW * 6.0, 0.0);
    let relief = mix(0.13, 0.22, clamp(P.y * 0.7, 0.0, 1.0));
    shade = (1.0 - relief) + relief * cos(fRib * 6.28318);
    let sheen = pow(max(cos((fRib + 0.18) * 3.14159), 0.0), 8.0);
    specC += vec3f(0.06, 0.065, 0.075) * sheen * gloss * 2.0;
  }

  // dispersion: R/B refract slightly differently
  let disp = 0.10 * min(P.y, 1.5);
  var col = vec3f(
    background(wp0 + off * (1.0 + disp), P.z, P.w, aspect).r,
    background(wp0 + off,                P.z, P.w, aspect).g,
    background(wp0 + off * (1.0 - disp), P.z, P.w, aspect).b,
  );

  col *= shade;
  col += specC * (0.25 + dot(col, vec3f(0.5)) * 0.6);

  // optional flute crest lines
  if (specOn && shape == 0) {
    let lum = dot(background(wp0, P.z + 0.5, P.w, aspect), vec3f(0.35, 0.5, 0.15));
    let crest = exp(-pow((abs(fRib) - 0.30) / 0.045, 2.0));
    let shimmer = 1.0 + u.high * u.mul_high * 0.5
                * sin(u.time * 14.0 + ribId * 3.1 + wp0.y * 5.0);
    col += vec3f(0.92, 0.95, 1.0) * crest * (0.10 + lum * 1.5)
         * (1.0 + u.kick * 0.8) * shimmer * 0.35;
  }

  // grain (matte surface); 0 = polished
  let g1 = hash21(in.uv * u.res_x + vec2f(fract(u.time * 0.9) * 17.0));
  col *= 1.0 + (g1 - 0.5) * Q.x * 0.55;

  return vec4f(col, u.trail_gain);
}
