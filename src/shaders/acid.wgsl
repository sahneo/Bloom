// ACID — gradient-noise mode (мудборд neobjects/gradient-noise), SLOW & HAZY:
// a full-frame domain-warped acid smoke field under HEAVY (steady) film
// grain, in five looks: 0 acid riso / 1 UV glow / 2 thermal posterize /
// 3 electric veins / 4 ink swirl. The grain IS the identity of this mode.
// Four wobbly blobs act as gradient sources riding on top of the smoke.
// Looks CROSS-DISSOLVE into each other (lookMix) — no hard switch.
//
// Sound → visual (all envelopes are EMA'd in JS, no raw-band twitch):
//   bass   → gentle tide: field swells ~12-15%
//   kick   → a low-contrast luminance wave rolls out slowly (~2s crossing)
//   mid    → flow speed (flowT, integrated in JS) + warp depth
//   snare  → barely-there shimmer (grain does NOT surge)
//   tension→ mild saturation + slightly tighter coil
//   drop   → look cross-dissolve + soft colour bloom (NO invert flash)
//
// extra[0..3] = blobs (x, y, radius, brightness)
// extra[7]    = (look, grain, ring0Env, dropBloom)
// extra[8]    = colour A rgb + bassEnv
// extra[9]    = colour B rgb + midEnv
// extra[10]   = background rgb + snareEnv
// extra[11]   = (ring0Age, flowT, lookPrev, lookMix)
// extra[12]   = (ring1Env, ring1Age, -, -)

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

// One wobbly (pen-tool) blob intensity, 0..~1
fn blobI(wp: vec2f, i: i32) -> f32 {
  let L = u.extra[i];
  if (L.w < 0.005) { return 0.0; }
  let sd = f32(i) * 9.13 + u.scene_seed;
  let dx = wp.x - L.x;
  let dy = wp.y - L.y;
  let ang = atan2(dy, dx);
  let rMod = 1.0
           + 0.30 * sin(2.0 * ang + u.time * 0.09 + sd * 7.0)
           + 0.20 * sin(3.0 * ang - u.time * 0.07 + sd * 3.0);
  let s = max(L.z * rMod, 0.05);
  return L.w * exp(-(dx * dx + dy * dy) / (s * s) * 1.8);
}

// soft luminance wave: wide gaussian shell crossing the frame in ~2s
fn ringI(wp: vec2f, env: f32, age: f32) -> f32 {
  return env * exp(-pow(length(wp) - age * 1.1, 2.0) * 3.0);
}

// thermal ramp: deep blue → violet → red → orange → cream (desaturated ~20%)
fn thermal(x: f32) -> vec3f {
  let c0 = vec3f(0.047, 0.063, 0.215);
  let c1 = vec3f(0.323, 0.123, 0.403);
  let c2 = vec3f(0.764, 0.284, 0.204);
  let c3 = vec3f(0.934, 0.614, 0.254);
  let c4 = vec3f(0.990, 0.950, 0.830);
  if (x < 0.25) { return mix(c0, c1, x * 4.0); }
  if (x < 0.50) { return mix(c1, c2, (x - 0.25) * 4.0); }
  if (x < 0.75) { return mix(c2, c3, (x - 0.50) * 4.0); }
  return mix(c3, c4, (x - 0.75) * 4.0);
}

// one look's colour — factored out so two looks can cross-dissolve
fn lookColor(look: i32, wp: vec2f, uv: vec2f, sm: f32, w1: f32, q0: vec2f,
             ft: f32, f0: f32, f1: f32, f2: f32, f3: f32,
             ring: f32, kickE: f32, midE: f32, warp: f32, coil: f32,
             flowT: f32, colA: vec3f, colB: vec3f, bg: vec3f) -> vec3f {
  if (look == 0) {
    // acid riso: two-colour smoke amoebas over the full frame
    let a  = pow(sm, 1.35);
    let b2 = pow(clamp(fbm(q0 * 1.9 + vec2f(-w1 * warp * 1.5, w1 * warp * 1.2)
                           + vec2f(17.3, 4.9)) * 1.2 - 0.12 + ring * 0.08, 0.0, 1.0), 1.5);
    return bg + colA * (a * 0.72 + (f0 + f2) * 0.42)
              + colB * (b2 * 0.68 + (f1 + f3) * 0.38);
  } else if (look == 1) {
    // UV glow: gentle airbrushed light in the smoke, blobs intensify
    let g = pow(sm, 1.7);
    return bg + colA * (g * (0.6 + ft * 0.45) + ring * 0.10)
              + colB * (pow(clamp(w1 * 1.3 - 0.25, 0.0, 1.0), 2.2) * 0.45 + f1 * 0.25);
  } else if (look == 2) {
    // thermal: posterized heat map, dithered band edges, compressed ends
    let x = clamp(sm * 0.62 + ft * 0.24 + ring * 0.08, 0.0, 1.0);
    let N = 7.0;
    let d = (hash21(uv * u.res_x * 0.5) - 0.5) / N;   // dither the bands
    return thermal(clamp(floor((x + d) * N) / N * 0.88 + 0.05, 0.0, 1.0)) * 0.82;
  } else if (look == 3) {
    // electric veins riding the smoke field
    let q = wp * 2.1 * coil + vec2f(sm * 1.5, -sm * 1.1) + vec2f(0.0, flowT * 0.04);
    let r1 = 1.0 - abs(fbm(q) * 2.0 - 1.0);
    let r2 = 1.0 - abs(fbm(q * 1.7 + vec2f(5.1, 2.3)) * 2.0 - 1.0);
    let vein = pow(max(r1 * r2, 1e-3), 5.0);
    return bg * (0.6 + sm * 0.9)
         + colA * vein * (0.9 + midE * 1.1 + ring * 0.6 + kickE * 0.25)
         + colB * (ft * 0.22 + sm * 0.15);
  }
  // ink swirl: monochrome smoke
  let smoke = pow(sm, 1.55);
  return bg + colA * smoke * (0.82 + ft * 0.35 + ring * 0.15);
}

@fragment
fn fs_render(in: VSOut) -> @location(0) vec4f {
  let aspect = u.res_x / max(u.res_y, 1.0);
  let wp = vec2f((in.uv.x - 0.5) * 2.0 * aspect, (0.5 - in.uv.y) * 2.0);

  let P     = u.extra[7];             // look, grain, ring0Env, dropBloom
  let look  = i32(P.x + 0.5);
  let flash = P.w;
  let colA   = u.extra[8].rgb;  let bassE  = u.extra[8].w;
  let colB   = u.extra[9].rgb;  let midE   = u.extra[9].w;
  let bg     = u.extra[10].rgb; let snareE = u.extra[10].w;
  let ring0Age = u.extra[11].x;
  let flowT    = u.extra[11].y;
  let lookPrev = i32(u.extra[11].z + 0.5);
  let lookMix  = clamp(u.extra[11].w, 0.0, 1.0);

  let f0 = blobI(wp, 0);
  let f1 = blobI(wp, 1);
  let f2 = blobI(wp, 2);
  let f3 = blobI(wp, 3);
  let ft = clamp(f0 + f1 + f2 + f3, 0.0, 2.0);

  // kick: up to two soft luminance waves roll out (~2s to cross)
  let ring = ringI(wp, P.z, ring0Age) + ringI(wp, u.extra[12].x, u.extra[12].y);
  let kickE = P.z + u.extra[12].x;

  // bass tide: the field swells gently; tension coils it slightly tighter
  let coil   = 1.0 + u.tension * 0.3;
  let fscale = (1.6 - bassE * 0.22) * coil;

  // mid drives flow speed (flowT integrated in JS) and warp depth
  let warp = 0.9 + midE * 0.8 + ring * 0.25;
  let q0 = wp * fscale + vec2f(flowT * 0.045, -flowT * 0.03);
  let w1 = fbm(q0 + vec2f(ft * 0.5, -ft * 0.35));
  let w2 = fbm(q0 * 1.55 + vec2f(w1 * warp * 1.8, w1 * warp * 1.4) + vec2f(3.7, 9.1));
  let sm = clamp(w2 * 1.25 - 0.08 + ring * 0.10 + bassE * 0.06, 0.0, 1.0);

  var col = lookColor(look, wp, in.uv, sm, w1, q0, ft, f0, f1, f2, f3,
                      ring, kickE, midE, warp, coil, flowT, colA, colB, bg);
  // cross-dissolve from the previous look while lookMix rises 0→1
  if (lookMix < 0.999) {
    let colP = lookColor(lookPrev, wp, in.uv, sm, w1, q0, ft, f0, f1, f2, f3,
                         ring, kickE, midE, warp, coil, flowT, colA, colB, bg);
    col = mix(colP, col, smoothstep(0.0, 1.0, lookMix));
  }

  // kick wave: a subtle brightness lean as it passes
  col *= 1.0 + ring * 0.18 + kickE * 0.03;

  // tension: colours saturate mildly toward the drop
  let luma = dot(col, vec3f(0.299, 0.587, 0.114));
  col = mix(vec3f(luma), col, 1.0 + u.tension * 0.25);

  // snare: barely-there colour shimmer
  col += (colA * 0.6 + colB * 0.4) * snareE * 0.04;

  // drop: soft colour bloom while the looks cross-dissolve (no invert)
  let fl = clamp(flash, 0.0, 1.0);
  col += (colA * 0.55 + colB * 0.45) * fl * 0.18;

  // soft knee: compress highlights — no pure whites inside the smoke
  let lum2 = dot(col, vec3f(0.299, 0.587, 0.114));
  col /= 1.0 + max(lum2 - 0.85, 0.0) * 0.6;

  // ── the signature: heavy two-scale film grain, STEADY (no surging) ─────
  let gAmt = P.y * (1.0 + snareE * 0.15);
  let g1 = hash21(in.uv * u.res_x + vec2f(fract(u.time * 1.3) * 19.0));
  let g2 = vnoise(in.uv * u.res_x * 0.22 + vec2f(fract(u.time * 0.7) * 31.0));
  col *= 1.0 + (g1 - 0.5) * gAmt;
  col += vec3f(g2 - 0.5) * gAmt * 0.10;

  return vec4f(max(col, vec3f(0.0)), 1.0);
}
