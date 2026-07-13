// STUDIO — Ladybug-style live effects over the user's media, sound-reactive.
// One shader, five stylizations picked by the panel:
//   0 ASCII     — character-cell rebuild, cell size breathes with the kick
//   1 HALFTONE  — rotated CMYK-ish dot screens, dot gain rides the bass
//   2 DUOTONE   — two-colour gradient map in the track's key, posterize dial
//   3 GLITCH    — RGB split + block displacement + scanlines on transients
//   4 EDGES     — neon contour extraction, glow rides the mids
//
// extra[7]  = (effect, amount, scale, kickEnv)
// extra[15] = (snareEnv, invert, texAspect, hasMedia)

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

// cover-fit sample of the media (or animated smoke fallback)
fn src(uv0: vec2f) -> vec3f {
  let Q = u.extra[15];
  let aspect = u.res_x / max(u.res_y, 1.0);
  if (Q.w < 0.5) {
    let p = (uv0 - 0.5) * vec2f(aspect, 1.0);
    let n = vnoise(p * 2.5 + vec2f(u.time * 0.06, -u.time * 0.04))
          + vnoise(p * 5.0 - vec2f(0.0, u.time * 0.09)) * 0.5;
    return vec3f(n * (0.4 + u.bass * 0.5));
  }
  var tuv = uv0 - 0.5;
  let texA = Q.z;
  if (texA > aspect) { tuv.x *= aspect / texA; }
  else               { tuv.y *= texA / aspect; }
  return textureSampleLevel(media, samp, clamp(tuv + 0.5, vec2f(0.002), vec2f(0.998)), 0.0).rgb;
}

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

// procedural glyph: density level → analytic character shapes
fn glyph(level: f32, q: vec2f) -> f32 {
  let l = clamp(level, 0.0, 1.0);
  var g = 0.0;
  let d = length(q - 0.5);
  if (l > 0.10) { g = max(g, step(d, 0.08)); }                         // ·
  if (l > 0.28) { g = max(g, step(abs(q.y - 0.5), 0.06) * step(abs(q.x - 0.5), 0.32)); }   // -
  if (l > 0.45) { g = max(g, step(abs(q.x - 0.5), 0.06) * step(abs(q.y - 0.5), 0.32)); }   // +
  if (l > 0.62) { g = max(g, step(abs(q.x - q.y), 0.09) + step(abs(q.x + q.y - 1.0), 0.09)); } // x
  if (l > 0.80) { g = max(g, step(max(abs(q.x - 0.5), abs(q.y - 0.5)), 0.38)
                          * (0.75 + 0.25 * step(0.5, fract((q.x + q.y) * 3.0)))); }        // block
  return clamp(g, 0.0, 1.0);
}

// one rotated halftone screen
fn dotScreen(uv: vec2f, ang: f32, cell: f32, v: f32) -> f32 {
  let ca = cos(ang); let sa = sin(ang);
  let r = vec2f(uv.x * ca - uv.y * sa, uv.x * sa + uv.y * ca) * cell;
  let f = fract(r) - 0.5;
  return 1.0 - smoothstep(v * 0.72 - 0.06, v * 0.72 + 0.06, length(f) * 1.9);
}

@fragment
fn fs_render(in: VSOut) -> @location(0) vec4f {
  let P = u.extra[7];     // effect, amount, scale, kickEnv
  let Q = u.extra[15];    // snareEnv, invert, texAspect, hasMedia
  let fxI = i32(P.x + 0.5);
  let amt = P.y;
  let res = vec2f(u.res_x, u.res_y);
  var uv = in.uv;
  var col: vec3f;

  if (fxI == 3) {
    // ── GLITCH: transient-driven destruction ────────────────────────────
    // block displacement on kick
    if (P.w > 0.02) {
      let blk = floor(uv * vec2f(14.0, 10.0));
      let h = hash21(blk + floor(u.time * 9.0));
      if (h > 0.72) { uv.x = fract(uv.x + (h - 0.86) * P.w * amt * 1.4); }
    }
    // scanline jitter on snare
    uv.x += sin(uv.y * 340.0 + u.time * 60.0) * Q.x * amt * 0.012;
    // RGB split grows with dissonance + kick
    let sp = (0.002 + P.w * 0.01 + u.dissonance * 0.004) * amt;
    col = vec3f(src(uv + vec2f(sp, 0.0)).r, src(uv).g, src(uv - vec2f(sp, 0.0)).b);
    // rolling scanlines
    col *= 1.0 - 0.18 * amt * (0.5 + 0.5 * sin(uv.y * res.y * 1.6 + u.time * 8.0));
  } else if (fxI == 0) {
    // ── ASCII ───────────────────────────────────────────────────────────
    let cell = mix(140.0, 40.0, clamp(P.z, 0.0, 1.0)) * (1.0 - P.w * 0.25);
    let g = vec2f(cell * res.x / res.y, cell);
    let id = floor(uv * g);
    let q  = fract(uv * g);
    let c  = src((id + 0.5) / g);
    let l  = luma(c) * (0.8 + u.mid * u.mul_mid * 0.5);
    let ink = glyph(l, q);
    let tint = mix(vec3f(1.0), c / max(luma(c), 0.2), 0.65);
    col = mix(src(uv) * (1.0 - amt), tint * ink * (0.75 + l * 0.5), amt);
  } else if (fxI == 1) {
    // ── HALFTONE: three rotated screens (C/M/K-ish) ────────────────────
    let cell = mix(180.0, 50.0, clamp(P.z, 0.0, 1.0));
    let c = src(uv);
    let gain = 0.85 + u.bass * u.mul_bass * 0.45 + P.w * 0.3;
    let k1 = dotScreen(uv * vec2f(res.x / res.y, 1.0), 0.26, cell, (1.0 - c.r) * gain);
    let k2 = dotScreen(uv * vec2f(res.x / res.y, 1.0), 1.05, cell, (1.0 - c.g) * gain);
    let k3 = dotScreen(uv * vec2f(res.x / res.y, 1.0), 1.83, cell, (1.0 - c.b) * gain);
    let paper = vec3f(0.96, 0.94, 0.90);
    var ht = paper;
    ht *= mix(vec3f(1.0), vec3f(0.15, 0.65, 0.85), k1 * 0.9);
    ht *= mix(vec3f(1.0), vec3f(0.90, 0.20, 0.55), k2 * 0.9);
    ht *= mix(vec3f(1.0), vec3f(0.12, 0.12, 0.14), k3 * 0.95);
    col = mix(c, ht, amt);
  } else if (fxI == 2) {
    // ── DUOTONE: key-colour gradient map + posterize ───────────────────
    let c = src(uv);
    let l = pow(max(luma(c), 1e-3), 0.9 + u.tension * 0.5);
    let steps = mix(12.0, 3.0, clamp(P.z, 0.0, 1.0));
    let lq = floor(l * steps + 0.5) / steps;
    let colA = hsv2rgb(vec3f(u.key_hue, 0.75, 0.16));
    let colB = hsv2rgb(vec3f(u.key_hue + 0.5, 0.55, 1.05 + P.w * 0.3));
    col = mix(c, mix(colA, colB, lq), amt);
  } else {
    // ── EDGES: neon contours, glow rides the mids ──────────────────────
    let e = 1.6 / res;
    let gx = luma(src(uv + vec2f(e.x, 0.0))) - luma(src(uv - vec2f(e.x, 0.0)));
    let gy = luma(src(uv + vec2f(0.0, e.y))) - luma(src(uv - vec2f(0.0, e.y)));
    let edge = pow(clamp(length(vec2f(gx, gy)) * 6.0, 0.0, 1.0), 1.3);
    let hue = u.key_hue + edge * 0.15 + uv.y * 0.08;
    let neon = hsv2rgb(vec3f(hue, 0.85, 1.0)) * edge
             * (0.9 + u.mid * u.mul_mid * 1.6 + P.w * 0.8);
    col = mix(src(uv), src(uv) * 0.06 + neon * 1.6, amt);
  }

  // drop invert flash
  col = mix(col, vec3f(1.0) - col, clamp(Q.y, 0.0, 1.0));

  return vec4f(col, 1.0);
}
