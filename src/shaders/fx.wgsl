// STUDIO — Ladybug-style live effects over user media, sound-reactive.
// Eight stylizations, each with its own dial set (p0..p5 from the panel)
// plus a React dial that scales all music modulation:
//   0 ASCII    p: cell, contrast, colorize, invert
//   1 HALFTONE p: cell, angle, gain, mono
//   2 DUOTONE  p: levels, hueA, hueB, contrast
//   3 GLITCH   p: blocks, rgbSplit, scanlines, rate
//   4 EDGES    p: thickness, glow, hue, bgMix
//   5 RISO     p: cell, inkHue, misreg, paper
//   6 CONTOUR  p: levels, thickness, glow, flow
//   7 MATRIX   p: cell, gap, palette, glow
//
// extra[7]  = (effect, react, kickEnv, snareEnv)
// extra[11] = (p0, p1, p2, p3)
// extra[12] = (p4, p5, invertFlash, hasMedia)
// extra[13] = (texAspect, -, -, -)

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

fn src(uv0: vec2f) -> vec3f {
  let hasMedia = u.extra[12].w;
  let aspect = u.res_x / max(u.res_y, 1.0);
  if (hasMedia < 0.5) {
    let p = (uv0 - 0.5) * vec2f(aspect, 1.0);
    let n = vnoise(p * 2.5 + vec2f(u.time * 0.06, -u.time * 0.04))
          + vnoise(p * 5.0 - vec2f(0.0, u.time * 0.09)) * 0.5;
    return vec3f(n * (0.4 + u.bass * 0.5));
  }
  var tuv = uv0 - 0.5;
  let texA = u.extra[13].x;
  if (texA > aspect) { tuv.x *= aspect / texA; }
  else               { tuv.y *= texA / aspect; }
  return textureSampleLevel(media, samp, clamp(tuv + 0.5, vec2f(0.002), vec2f(0.998)), 0.0).rgb;
}

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

fn glyph(level: f32, q: vec2f) -> f32 {
  let l = clamp(level, 0.0, 1.0);
  var g = 0.0;
  let d = length(q - 0.5);
  if (l > 0.10) { g = max(g, step(d, 0.08)); }
  if (l > 0.28) { g = max(g, step(abs(q.y - 0.5), 0.06) * step(abs(q.x - 0.5), 0.32)); }
  if (l > 0.45) { g = max(g, step(abs(q.x - 0.5), 0.06) * step(abs(q.y - 0.5), 0.32)); }
  if (l > 0.62) { g = max(g, step(abs(q.x - q.y), 0.09) + step(abs(q.x + q.y - 1.0), 0.09)); }
  if (l > 0.80) { g = max(g, step(max(abs(q.x - 0.5), abs(q.y - 0.5)), 0.38)
                          * (0.75 + 0.25 * step(0.5, fract((q.x + q.y) * 3.0)))); }
  return clamp(g, 0.0, 1.0);
}

fn dotScreen(uv: vec2f, ang: f32, cell: f32, v: f32) -> f32 {
  let ca = cos(ang); let sa = sin(ang);
  let r = vec2f(uv.x * ca - uv.y * sa, uv.x * sa + uv.y * ca) * cell;
  let f = fract(r) - 0.5;
  return 1.0 - smoothstep(v * 0.72 - 0.06, v * 0.72 + 0.06, length(f) * 1.9);
}

@fragment
fn fs_render(in: VSOut) -> @location(0) vec4f {
  let E  = u.extra[7];    // effect, react, kickEnv, snareEnv
  let Pa = u.extra[11];   // p0..p3
  let Pb = u.extra[12];   // p4, p5, invert, hasMedia
  let fxI   = i32(E.x + 0.5);
  let react = E.y;
  let kickE = E.z * react;
  let snrE  = E.w * react;
  let res = vec2f(u.res_x, u.res_y);
  let aspR = res.x / res.y;
  var uv = in.uv;
  var col: vec3f;

  if (fxI == 0) {
    // ── ASCII: cell, contrast, colorize, invert ─────────────────────────
    let cell = mix(150.0, 34.0, Pa.x) * (1.0 - kickE * 0.22);
    let g = vec2f(cell * aspR, cell);
    let id = floor(uv * g);
    let q  = fract(uv * g);
    let c  = src((id + 0.5) / g);
    var l  = clamp((luma(c) - 0.5) * (0.6 + Pa.y * 1.8) + 0.5, 0.0, 1.0);
    l = l * (0.85 + u.mid * u.mul_mid * 0.5 * react);
    if (Pa.w > 0.5) { l = 1.0 - l; }
    let ink = glyph(l, q);
    let tint = mix(vec3f(1.0), c / max(luma(c), 0.2), Pa.z);
    col = tint * ink * (0.75 + l * 0.5);
  } else if (fxI == 1) {
    // ── HALFTONE: cell, angle, gain, mono ───────────────────────────────
    let cell = mix(200.0, 45.0, Pa.x);
    let base = Pa.y * 3.14159;
    let c = src(uv);
    let gain = (0.6 + Pa.z * 0.8) * (1.0 + u.bass * u.mul_bass * 0.5 * react + kickE * 0.3);
    let uva = uv * vec2f(aspR, 1.0);
    let paper = vec3f(0.96, 0.94, 0.90);
    if (Pa.w > 0.5) {
      let k = dotScreen(uva, base + 0.79, cell, (1.0 - luma(c)) * gain);
      col = mix(paper, vec3f(0.10, 0.10, 0.12), k);
    } else {
      let k1 = dotScreen(uva, base + 0.26, cell, (1.0 - c.r) * gain);
      let k2 = dotScreen(uva, base + 1.05, cell, (1.0 - c.g) * gain);
      let k3 = dotScreen(uva, base + 1.83, cell, (1.0 - c.b) * gain);
      col = paper;
      col *= mix(vec3f(1.0), vec3f(0.15, 0.65, 0.85), k1 * 0.9);
      col *= mix(vec3f(1.0), vec3f(0.90, 0.20, 0.55), k2 * 0.9);
      col *= mix(vec3f(1.0), vec3f(0.12, 0.12, 0.14), k3 * 0.95);
    }
  } else if (fxI == 2) {
    // ── DUOTONE: levels, hueA, hueB, contrast ───────────────────────────
    let c = src(uv);
    var l = clamp((luma(c) - 0.5) * (0.6 + Pa.w * 1.8) + 0.5, 0.0, 1.0);
    l = pow(max(l, 1e-3), 1.0 + u.tension * 0.4 * react);
    let steps = mix(14.0, 2.0, Pa.x);
    let lq = floor(l * steps + 0.5) / steps;
    let colA = hsv2rgb(vec3f(Pa.y, 0.75, 0.14));
    let colB = hsv2rgb(vec3f(Pa.z, 0.60, 1.05 + kickE * 0.3));
    col = mix(colA, colB, lq);
  } else if (fxI == 3) {
    // ── GLITCH: blocks, rgbSplit, scanlines, rate ───────────────────────
    if (kickE > 0.02 || Pa.w > 0.6) {
      let bn = mix(6.0, 26.0, Pa.x);
      let blk = floor(uv * vec2f(bn, bn * 0.7));
      let h = hash21(blk + floor(u.time * mix(4.0, 18.0, Pa.w)));
      if (h > 0.72) { uv.x = fract(uv.x + (h - 0.86) * max(kickE, Pa.w * 0.5) * 1.4); }
    }
    uv.x += sin(uv.y * 340.0 + u.time * 60.0) * snrE * 0.012;
    let sp = (Pa.y * 0.012 + kickE * 0.008 + u.dissonance * 0.003 * react);
    col = vec3f(src(uv + vec2f(sp, 0.0)).r, src(uv).g, src(uv - vec2f(sp, 0.0)).b);
    col *= 1.0 - Pa.z * 0.35 * (0.5 + 0.5 * sin(uv.y * res.y * 1.6 + u.time * 8.0));
  } else if (fxI == 4) {
    // ── EDGES: thickness, glow, hue, bgMix ──────────────────────────────
    let e = (0.8 + Pa.x * 2.4) / res;
    let gx = luma(src(uv + vec2f(e.x, 0.0))) - luma(src(uv - vec2f(e.x, 0.0)));
    let gy = luma(src(uv + vec2f(0.0, e.y))) - luma(src(uv - vec2f(0.0, e.y)));
    let edge = pow(clamp(length(vec2f(gx, gy)) * 6.0, 0.0, 1.0), 1.3);
    let hue = Pa.z + edge * 0.15;
    let neon = hsv2rgb(vec3f(hue, 0.85, 1.0)) * edge
             * (0.6 + Pa.y * 1.6) * (1.0 + u.mid * u.mul_mid * 1.4 * react + kickE * 0.6);
    col = src(uv) * Pa.w + neon * 1.6;
  } else if (fxI == 5) {
    // ── RISO: cell, inkHue, misreg, paper ───────────────────────────────
    let c = src(uv);
    let cell = mix(220.0, 60.0, Pa.x);
    let mis = Pa.z * 0.006 * (1.0 + snrE * 2.0);
    let l1 = 1.0 - luma(src(uv + vec2f(mis, mis * 0.6)));
    let l2 = 1.0 - luma(src(uv - vec2f(mis, mis * 0.4)));
    let uva = uv * vec2f(aspR, 1.0);
    let k1 = dotScreen(uva, 0.35, cell, l1 * (0.9 + kickE * 0.35));
    let k2 = dotScreen(uva, 1.22, cell * 0.98, pow(max(l2 - 0.35, 0.0) * 1.5, 1.2));
    let paper = mix(vec3f(0.93, 0.90, 0.84), vec3f(0.99, 0.97, 0.94), Pa.w);
    let ink1 = hsv2rgb(vec3f(Pa.y, 0.85, 0.95));
    let ink2 = hsv2rgb(vec3f(Pa.y + 0.45, 0.80, 0.60));
    col = paper;
    col *= mix(vec3f(1.0), ink1, k1 * 0.92);
    col *= mix(vec3f(1.0), ink2, k2 * 0.85);
    // riso glow: bright ink floods slightly (HDR → bloom)
    col += ink1 * k1 * 0.20 * (1.0 + u.mid * react);
  } else if (fxI == 6) {
    // ── CONTOUR: levels, thickness, glow, flow ──────────────────────────
    let c = src(uv);
    let flow = Pa.w * (u.time * 0.06 + u.bar_pos * 0.02 * react);
    let l = luma(c) + vnoise(uv * 3.0 + vec2f(flow * 2.0)) * 0.04;
    let N = mix(4.0, 22.0, Pa.x);
    let f = fract(l * N + flow * 3.0);
    let w = 0.03 + Pa.y * 0.10 + kickE * 0.04;
    let line = smoothstep(w, w * 0.4, min(f, 1.0 - f));
    let hue = u.key_hue + floor(l * N) / N * 0.25;
    col = vec3f(0.012, 0.014, 0.02) + src(uv) * 0.05
        + hsv2rgb(vec3f(hue, 0.7, 1.0)) * line
        * (0.55 + Pa.z * 1.3) * (1.0 + u.mid * u.mul_mid * 1.2 * react);
  } else {
    // ── MATRIX: cell, gap, palette, glow ────────────────────────────────
    let cell = mix(160.0, 30.0, Pa.x);
    let g = vec2f(cell * aspR, cell);
    let id = floor(uv * g);
    let q  = fract(uv * g) - 0.5;
    let c  = src((id + 0.5) / g);
    var l  = luma(c) * (0.9 + u.bass * u.mul_bass * 0.4 * react + kickE * 0.3);
    // refresh sweep down the panel
    l *= 0.8 + 0.35 * pow(0.5 + 0.5 * sin(uv.y * 6.28 - u.time * 3.0), 4.0);
    let r = mix(0.44, 0.20, Pa.y);
    let led = smoothstep(r, r * 0.6, length(q));
    var lcol: vec3f;
    if      (Pa.z < 0.33) { lcol = vec3f(0.25, 1.0, 0.35); }              // green CRT
    else if (Pa.z < 0.66) { lcol = vec3f(1.0, 0.65, 0.15); }              // amber
    else                  { lcol = c / max(luma(c), 0.25); }              // RGB
    col = lcol * led * l * (0.9 + Pa.w * 1.4);
  }

  col = mix(col, vec3f(1.0) - col, clamp(Pb.z, 0.0, 1.0));
  return vec4f(col, 1.0);
}
