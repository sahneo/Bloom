// RESOLVER — 1-bit ordered-dither VJ over user media (images/video).
// Source frame → luma → contrast curve → ordered dithering at a musical
// cell size (kick inflates the lattice), with a glitch deck cut to the
// music: kick = row shifts, snare = mirror tiling, drop = invert + a live
// spectrogram strip (band history from JS). No media loaded → procedural
// FBM smoke so the mode still performs.
//
// Slots: _r1 = cell size (px), _r2 = pattern index, _r3 = hasMedia
// extra[0] = (kickEnv, mirrorEnv, invert, contrast)
// extra[1] = (kbZoom, kbPanX, kbPanY, texAspect)
// extra[2] = (specShow, glitchSeed, mirrorN, cutFlash)
// extra[4..15] = 48-column band-energy ring (spectrogram strip)

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

fn hash21(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn vnoise(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p);
  let w = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), w.x),
             mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), w.x), w.y);
}

fn fbm(p: vec2f) -> f32 {
  var v = 0.0; var a = 0.5; var q = p;
  for (var i = 0; i < 4; i++) {
    v += a * vnoise(q);
    q = q * 2.07 + vec2f(13.1, 7.7);
    a *= 0.5;
  }
  return v;
}

// Bayer 4×4 ordered threshold (0..1)
fn bayer4(c: vec2u) -> f32 {
  var m = array<f32, 16>(
     0.0,  8.0,  2.0, 10.0,
    12.0,  4.0, 14.0,  6.0,
     3.0, 11.0,  1.0,  9.0,
    15.0,  7.0, 13.0,  5.0);
  return (m[(c.y % 4u) * 4u + (c.x % 4u)] + 0.5) / 16.0;
}

// Ordered threshold in one of three lattice styles
fn threshold(cell: vec2f, pattern: i32) -> f32 {
  if (pattern == 1) {
    // crosshatch: two diagonal line families
    let d1 = fract((cell.x + cell.y) * 0.25);
    let d2 = fract((cell.x - cell.y) * 0.25);
    return min(abs(d1 - 0.5), abs(d2 - 0.5)) * 2.4 + 0.06;
  }
  if (pattern == 2) {
    // halftone dots: radial threshold inside 4×4 blocks
    let f = fract(cell * 0.25) - 0.5;
    return clamp(length(f) * 2.6, 0.02, 0.98);
  }
  return bayer4(vec2u(u32(cell.x), u32(cell.y)));
}

@fragment
fn fs_render(in: VSOut) -> @location(0) vec4f {
  let res    = vec2f(u.res_x, u.res_y);
  let g      = u.extra[0];    // kickEnv, mirrorEnv, invert, contrast
  let kb     = u.extra[1];    // zoom, panX, panY, texAspect
  let fx     = u.extra[2];    // specShow, seed, mirrorN, cutFlash
  var uv     = in.uv;

  // ── glitch deck (in screen space, before sampling) ────────────────────
  // snare: mirror tiling
  if (g.y > 0.03) {
    let n = max(fx.z, 2.0);
    let tiled = abs(fract(uv * n * 0.5) * 2.0 - 1.0);
    uv = mix(uv, tiled, smoothstep(0.0, 0.25, g.y));
  }
  // kick: horizontal band shifts
  if (g.x > 0.02) {
    let row = floor(uv.y * 22.0);
    let h = hash21(vec2f(row, fx.y));
    if (h > 0.62) {
      uv.x = fract(uv.x + (h - 0.8) * g.x * 0.9);
    }
  }

  // ── source luma ────────────────────────────────────────────────────────
  var luma: f32;
  if (u._r3 > 0.5) {
    // cover-fit the media, then Ken Burns
    let scrA = res.x / res.y;
    var tuv = uv - 0.5;
    if (kb.w > scrA) { tuv.x *= scrA / kb.w; }   // media wider → crop x
    else             { tuv.y *= kb.w / scrA; }   // media taller → crop y
    tuv = tuv / kb.x + vec2f(kb.y, kb.z);
    let c = textureSampleLevel(media, samp, clamp(tuv + 0.5, vec2f(0.001), vec2f(0.999)), 0.0).rgb;
    luma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  } else {
    // fallback: slow smoke so the mode performs with no media loaded
    let p = (uv - 0.5) * vec2f(res.x / res.y, 1.0);
    luma = fbm(p * 2.1 + vec2f(u.time * 0.05, -u.time * 0.03))
         * (0.55 + u.bass * u.mul_bass * 0.5);
    luma += fbm(p * 5.0 - vec2f(0.0, u.time * 0.10)) * 0.25 * u.mid;
  }

  // contrast curve: builds overdrive the image toward crushed blacks/whites
  let contrast = g.w;
  luma = clamp((luma - 0.5) * contrast + 0.5 + u.kick * 0.06, 0.0, 1.0);
  // invert (drop flavour)
  luma = mix(luma, 1.0 - luma, clamp(g.z, 0.0, 1.0));

  // ── spectrogram strip (real band history), dithered along with all ────
  if (fx.x > 0.02 && in.uv.x > 0.52 && in.uv.y < 0.34) {
    let col = i32(clamp((in.uv.x - 0.52) / 0.48 * 48.0, 0.0, 47.0));
    let v = u.extra[4 + col / 4][col % 4];
    let bar = v * (0.6 + 0.4 * sin(in.uv.y * 140.0 + f32(col) * 1.7));
    luma = mix(luma, bar * 1.2, fx.x);
  }

  // ── ordered dithering at a musical cell size ───────────────────────────
  let cellPx = max(u._r1, 1.5);
  let cell   = floor(in.uv * res / cellPx);
  let th     = threshold(cell, i32(u._r2 + 0.5));
  var b      = step(th, luma);

  // cut flash: one-frame white blink on media switches
  b = max(b, fx.w);

  let v = b * (0.95 + u.kick * 0.25);
  return vec4f(vec3f(v), 1.0);
}
