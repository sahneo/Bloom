// KINO — kinotype.xyz-style moving typographic graphics (fullscreen modes).
// Modes rendered here: 0 TEXT HALFTONE, 1 EDGE ASCII, 2 STIPPLE,
// 6 SCATTER FIELD, 7 PIXEL SORT. Modes 3/4/5 (flow field / scribbles /
// text flow) render as instanced sprites via kino_glyph.wgsl.
//
// extra slot map (shared with kino_glyph.wgsl — envelopes pre-scaled by React):
//  extra[0] = (mode, react, kickEnv, snareEnv)
//  extra[1] = (p0, p1, p2, p3)                      per-mode dials
//  extra[2] = (texAspect, invertFlash, dropEnv, kickAge)
//  extra[3] = (bassSm, midSm, highSm, energySm)     EMA-smoothed bands × React
//  extra[4] = (twinkleRate, keyTint, seed, textLen)
//  extra[5] = (atlasCols, cellAspect, dotSlot, wordBase)
//  extra[6] = (wordCount, glyphAdv, sweepPos, -)
//  extra[7] = (-, -, -, -)                          reserved / sprite pipeline
//
// textBuf layout (array<f32>):
//  [0..15]  brightness level → atlas slot LUT (0 = darkest; -1 = blank)
//  [16..19] direction glyph slots for y-down contour angles 0/45/90/135°: — \ | /
//  [20..79] knText char → atlas slot sequence (space = -1)
//  [96..]   word table: (startChar, len) f32 pairs, extra[6].x entries

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
@group(0) @binding(3) var atlas: texture_2d<f32>;
@group(0) @binding(4) var<storage, read> tb: array<f32>;

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

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

// cover-fit sample of the media/procedural source
fn srcC(uv0: vec2f) -> vec3f {
  let aspect = u.res_x / max(u.res_y, 1.0);
  var tuv = uv0 - 0.5;
  let texA = max(u.extra[2].x, 0.01);
  if (texA > aspect) { tuv.x *= aspect / texA; }
  else               { tuv.y *= texA / aspect; }
  return textureSampleLevel(media, samp, clamp(tuv + 0.5, vec2f(0.002), vec2f(0.998)), 0.0).rgb;
}

fn lumAt(uv: vec2f) -> f32 { return luma(srcC(uv)); }

// sample one glyph cell of the atlas strip; q = cell-local 0..1
fn glyphInk(slot: f32, q: vec2f) -> f32 {
  if (slot < -0.5) { return 0.0; }
  if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) { return 0.0; }
  let cols = max(u.extra[5].x, 1.0);
  let uvx = (slot + 0.05 + q.x * 0.90) / cols;
  return textureSampleLevel(atlas, samp, vec2f(uvx, 0.04 + q.y * 0.92), 0.0).r;
}

// kick → a ring pulse expanding from screen centre
fn kickRipple(uv: vec2f) -> f32 {
  let aspR = u.res_x / max(u.res_y, 1.0);
  let uvc = (uv - 0.5) * vec2f(aspR, 1.0);
  let age = u.extra[2].w;
  let d = length(uvc);
  return exp(-pow((d - age * 1.5) * 6.0, 2.0)) * u.extra[0].z;
}

// mono ink → final colour: near-white ink on black, subtle key tint;
// invD flips to paper-white with dark ink; invertFlash (drop) negates.
fn paperize(v: f32, invD: f32) -> vec3f {
  let keyTint = clamp(u.extra[4].y, 0.0, 1.0);
  var col: vec3f;
  if (invD > 0.5) {
    let inkDark = mix(vec3f(0.06, 0.06, 0.075), hsv2rgb(vec3f(u.key_hue, 0.65, 0.28)), keyTint);
    col = mix(vec3f(0.90, 0.89, 0.86), inkDark, clamp(v, 0.0, 1.0));
  } else {
    let inkC = mix(vec3f(1.0), hsv2rgb(vec3f(u.key_hue, 0.50, 1.0)), keyTint);
    col = inkC * v;
  }
  let fl = clamp(u.extra[2].y, 0.0, 1.0);
  col = mix(col, vec3f(1.02) - col, fl);
  return col;
}

fn axisUV(t: f32, o: f32, vert: f32) -> vec2f {
  return select(vec2f(t, o), vec2f(o, t), vert > 0.5);
}
fn lum1(t: f32, o: f32, vert: f32) -> f32 {
  return lumAt(axisUV(t, o, vert));
}

@fragment
fn fs_render(in: VSOut) -> @location(0) vec4f {
  let E0 = u.extra[0];
  let P  = u.extra[1];
  let mode = i32(E0.x + 0.5);
  let aspR = u.res_x / max(u.res_y, 1.0);
  let uv = in.uv;
  let snr = u.extra[0].w;
  var v = 0.0;
  var invD = 0.0;
  if (mode <= 2) { invD = P.w; }

  if (mode == 0) {
    // ── 0 TEXT HALFTONE: glyph grid, char weight by local brightness ──────
    let rows = mix(64.0, 15.0, P.x);
    let ca = max(u.extra[5].y, 0.3);
    let g = vec2f(rows * aspR / ca, rows);
    let id = floor(uv * g);
    let cuv = (id + 0.5) / g;
    let rip = kickRipple(cuv);
    var q = fract(uv * g);
    q += (vec2f(hash21(id + 4.2), hash21(id + 9.3)) - 0.5) * snr * 0.5;
    let breathe = 1.0 + u.extra[3].x * 0.20 + rip * 0.35;
    q = (q - 0.5) / breathe + 0.5;
    var level = clamp((lumAt(cuv) - 0.5) * (0.5 + P.y * 2.4) + 0.5, 0.0, 1.0);
    let twk = u.extra[4].x;
    let tw = hash21(id * 0.37 + floor(u.time * twk + hash21(id) * 3.0) * vec2f(3.7, 9.1));
    level = clamp(level + (tw - 0.5) * P.z * 0.5 + rip * 0.4, 0.0, 1.0);
    if (invD > 0.5) { level = 1.0 - level; }
    let slot = tb[u32(level * 15.99)];
    v = glyphInk(slot, q) * (0.55 + level * 0.6 + rip * 0.4);

  } else if (mode == 1) {
    // ── 1 EDGE ASCII: oriented strokes trace contours, dots fill flats ────
    let rows = mix(84.0, 26.0, P.x);
    let ca = max(u.extra[5].y, 0.3);
    let g = vec2f(rows * aspR / ca, rows);
    let id = floor(uv * g);
    let cuv = (id + 0.5) / g;
    let rip = kickRipple(cuv);
    var q = fract(uv * g);
    q += (vec2f(hash21(id + 2.7), hash21(id + 6.1)) - 0.5) * snr * 0.5;
    let breathe = 1.0 + u.extra[3].x * 0.15 + rip * 0.3;
    q = (q - 0.5) / breathe + 0.5;
    let e = 1.2 / g;
    let l00 = lumAt(cuv + vec2f(-e.x, -e.y));
    let l10 = lumAt(cuv + vec2f( 0.0, -e.y));
    let l20 = lumAt(cuv + vec2f( e.x, -e.y));
    let l01 = lumAt(cuv + vec2f(-e.x,  0.0));
    let l21 = lumAt(cuv + vec2f( e.x,  0.0));
    let l02 = lumAt(cuv + vec2f(-e.x,  e.y));
    let l12 = lumAt(cuv + vec2f( 0.0,  e.y));
    let l22 = lumAt(cuv + vec2f( e.x,  e.y));
    let gxv = (l20 + 2.0 * l21 + l22) - (l00 + 2.0 * l01 + l02);
    let gyv = (l02 + 2.0 * l12 + l22) - (l00 + 2.0 * l10 + l20);
    let mag = length(vec2f(gxv, gyv)) * (0.5 + P.y * 3.5);
    let lc = lumAt(cuv);
    if (mag > 0.5) {
      var angC = atan2(gyv, gxv) + 1.5707963;
      angC = angC - floor(angC / 3.1415926) * 3.1415926;
      let idx = i32(floor(angC / 0.7853981 + 0.5)) % 4;
      let slot = tb[16 + idx];
      v = glyphInk(slot, q) * clamp(0.55 + mag * 0.45, 0.0, 1.25);
    } else {
      let h = hash21(id * 1.31);
      var flat_l = lc;
      if (invD > 0.5) { flat_l = 1.0 - flat_l; }
      if (h < P.z * (0.10 + flat_l * 0.85)) {
        v = glyphInk(u.extra[5].z, q) * (0.35 + flat_l * 0.5);
      }
    }
    v *= 1.0 + rip * 0.8;

  } else if (mode == 2) {
    // ── 2 STIPPLE: breathing halftone dot field (hex-packed) ──────────────
    let rows = mix(64.0, 14.0, P.x);
    let gy2 = rows; let gx2 = rows * aspR;
    let fy = uv.y * gy2;
    let row = floor(fy);
    let sh = select(0.0, 0.5, (i32(row) & 1) == 1);
    let fx = uv.x * gx2 + sh;
    let colI = floor(fx);
    let id = vec2f(colI, row);
    let q = vec2f(fract(fx), fract(fy)) - 0.5;
    let cuv = vec2f((colI + 0.5 - sh) / gx2, (row + 0.5) / gy2);
    let rip = kickRipple(cuv);
    var lev = clamp((lumAt(cuv) - 0.5) * 1.7 + 0.5, 0.0, 1.0);
    if (invD > 0.5) { lev = 1.0 - lev; }
    let h = hash21(id * 0.61);
    let br = 1.0 + P.z * 0.30 * sin(u.time * (0.5 + h * 0.9) + h * 6.2832)
           + u.extra[3].x * 0.35 + rip * 0.8;
    let r = (0.06 + P.y * 0.44) * pow(lev, 1.15) * br;
    let cJ = q - (vec2f(hash21(id + 3.3), hash21(id + 5.9)) - 0.5) * 0.14
           - (vec2f(hash21(id + 8.8), hash21(id + 1.6)) - 0.5) * snr * 0.35;
    v = smoothstep(r, r - 0.09, length(cJ)) * (0.60 + lev * 0.5);

  } else if (mode == 6) {
    // ── 6 SCATTER FIELD: drifting words weighted by the image ─────────────
    let cells = mix(4.5, 15.0, P.x);
    let g = vec2f(floor(cells * aspR + 0.5), cells);
    let id = floor(uv * g);
    let q6 = fract(uv * g);
    let seed = u.extra[4].z;
    let h1 = hash21(id * 0.71 + seed);
    let h2 = hash21(id * 1.37 + 4.2 + seed);
    let dsp = 0.02 + P.z * 0.10;
    let drift = vec2f(vnoise(id * 0.53 + vec2f(u.time * dsp, 0.0)),
                      vnoise(id * 0.53 + vec2f(7.7, -u.time * dsp))) - 0.5;
    let cuv = (id + 0.5) / g;
    let lc = lumAt(clamp(cuv + drift * 0.06, vec2f(0.0), vec2f(1.0)));
    let rip = kickRipple(cuv);
    let wcount = max(u.extra[6].x, 1.0);
    let w = min(floor(hash21(id * 2.13 + 1.1) * wcount), wcount - 1.0);
    let wb = u32(u.extra[5].w);
    let start = tb[wb + u32(w) * 2u];
    let len = tb[wb + u32(w) * 2u + 1u];
    if (start > -0.5 && len > 0.5 && h1 < P.y * (0.2 + lc * 1.3)) {
      let adv = max(u.extra[6].y, 0.3);
      var gh = (0.10 + h2 * 0.28) * (0.4 + P.w * 1.3);
      gh = min(gh, 0.85 / (len * adv));
      let wordW = len * adv * gh;
      let boom = u.extra[2].z;
      let off = (vec2f(h1, h2) - 0.5) * boom * 1.8;
      let x0 = 0.5 - wordW * 0.5 + drift.x * 0.35 + off.x;
      let y0 = 0.5 - gh * 0.5 + drift.y * 0.35 + off.y;
      let kx = (q6.x - x0) / (adv * gh);
      let qy = (q6.y - y0) / gh;
      if (kx >= 0.0 && kx < len && qy >= 0.0 && qy <= 1.0) {
        let slot = tb[20u + u32(start) + u32(kx)];
        let tw = 0.80 + 0.20 * sin(u.time * u.extra[4].x * 0.6 + h2 * 6.2832);
        v = glyphInk(slot, vec2f(fract(kx), qy))
          * (0.42 + pow(lc, 0.7) * 0.85) * tw * (1.0 + rip * 0.8);
      }
    }

  } else {
    // ── 7 PIXEL SORT: brightness-sorted streaks sweep across the image ────
    let res = mix(90.0, 380.0, P.x);
    let vert = select(0.0, 1.0, P.w > 0.5);
    let tA = select(uv.x, uv.y, vert > 0.5);
    let oA = select(uv.y, uv.x, vert > 0.5);
    let stepT = 1.0 / res;
    let boom = u.extra[2].z;
    let sw = u.extra[6].z;
    var dsw = abs(oA - sw);
    dsw = min(dsw, 1.0 - dsw);
    var act = smoothstep(0.20, 0.02, dsw);
    // random streak bands flicking on/off across the frame (kinotype glitch)
    let band = floor(oA * 36.0);
    let bph = hash21(vec2f(band, floor(u.time * 0.8 + hash21(vec2f(band, 3.3)))));
    act = max(act, step(bph, 0.30 + u.extra[0].z * 0.25));
    let th = mix(0.12, 0.80, P.y) - u.extra[0].z * 0.15;
    let effTh = mix(1.5, th, max(act, min(boom * 1.4, 1.0)));
    let t0 = (floor(tA * res) + 0.5) * stepT;
    if (lum1(t0, oA, vert) < effTh) {
      v = lumAt(uv) * 0.92;
    } else {
      var s = tA; var e2 = tA;
      for (var k = 1; k <= 88; k++) {
        let t = tA - f32(k) * stepT;
        if (t < 0.0 || lum1(t, oA, vert) < effTh) { break; }
        s = t;
      }
      for (var k = 1; k <= 88; k++) {
        let t = tA + f32(k) * stepT;
        if (t > 1.0 || lum1(t, oA, vert) < effTh) { break; }
        e2 = t;
      }
      let L = max(e2 - s, stepT);
      let o = clamp((tA - s) / L, 0.0, 0.999);
      var ls: array<f32, 16>;
      for (var i = 0; i < 16; i++) {
        ls[i] = lum1(s + (f32(i) + 0.5) / 16.0 * L, oA, vert);
      }
      var best = 0; var bestD = 9.0;
      for (var i = 0; i < 16; i++) {
        var rank = 0.0;
        for (var j = 0; j < 16; j++) {
          if (ls[j] < ls[i] || (ls[j] == ls[i] && j < i)) { rank += 1.0; }
        }
        let d = abs((rank + 0.5) / 16.0 - o);
        if (d < bestD) { bestD = d; best = i; }
      }
      // contrast-stretch the sorted ramp so streaks read hard-edged
      v = pow(ls[best], 1.9) * 1.30;
    }
  }

  return vec4f(paperize(v, invD), 1.0);
}
