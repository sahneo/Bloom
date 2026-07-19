// ACID — gradient-noise mode (мудборд neobjects/gradient-noise):
// a full-frame domain-warped acid smoke field under HEAVY film grain, in
// five rotating looks: 0 acid riso / 1 UV glow / 2 thermal posterize /
// 3 electric veins / 4 ink swirl. The grain IS the identity of this mode.
// Four wobbly blobs act as gradient sources riding on top of the smoke.
//
// Sound → visual (all envelopes are EMA'd in JS, no raw-band twitch):
//   bass   → the whole field breathes: billows swell + densify
//   kick   → a brightness/turbulence ring rolls out through the smoke
//   mid    → flow speed (flowT, integrated in JS) + warp depth
//   snare  → grain surge + brief colour shimmer
//   tension→ colours saturate, field coils tighter
//   drop   → look slam + full-frame invert/flash
//
// extra[0..3] = blobs (x, y, radius, brightness)
// extra[7]    = (look, grain, kickEnv, dropFlash)
// extra[8]    = colour A rgb + bassEnv
// extra[9]    = colour B rgb + midEnv
// extra[10]   = background rgb + snareEnv
// extra[11]   = (kickAge, flowT, -, -)

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
           + 0.30 * sin(2.0 * ang + u.time * 0.17 + sd * 7.0)
           + 0.20 * sin(3.0 * ang - u.time * 0.12 + sd * 3.0);
  let s = max(L.z * rMod, 0.05);
  return L.w * exp(-(dx * dx + dy * dy) / (s * s) * 1.8);
}

// thermal ramp: deep blue → violet → red → orange → cream
fn thermal(x: f32) -> vec3f {
  let c0 = vec3f(0.04, 0.06, 0.25);
  let c1 = vec3f(0.35, 0.10, 0.45);
  let c2 = vec3f(0.85, 0.25, 0.15);
  let c3 = vec3f(1.00, 0.60, 0.15);
  let c4 = vec3f(1.00, 0.95, 0.80);
  if (x < 0.25) { return mix(c0, c1, x * 4.0); }
  if (x < 0.50) { return mix(c1, c2, (x - 0.25) * 4.0); }
  if (x < 0.75) { return mix(c2, c3, (x - 0.50) * 4.0); }
  return mix(c3, c4, (x - 0.75) * 4.0);
}

@fragment
fn fs_render(in: VSOut) -> @location(0) vec4f {
  let aspect = u.res_x / max(u.res_y, 1.0);
  let wp = vec2f((in.uv.x - 0.5) * 2.0 * aspect, (0.5 - in.uv.y) * 2.0);

  let P     = u.extra[7];             // look, grain, kickEnv, dropFlash
  let look  = i32(P.x + 0.5);
  let kickE = P.z;
  let flash = P.w;
  let colA   = u.extra[8].rgb;  let bassE  = u.extra[8].w;
  let colB   = u.extra[9].rgb;  let midE   = u.extra[9].w;
  let bg     = u.extra[10].rgb; let snareE = u.extra[10].w;
  let kickAge = u.extra[11].x;
  let flowT   = u.extra[11].y;

  let f0 = blobI(wp, 0);
  let f1 = blobI(wp, 1);
  let f2 = blobI(wp, 2);
  let f3 = blobI(wp, 3);
  let ft = clamp(f0 + f1 + f2 + f3, 0.0, 2.0);

  // kick: a turbulence/brightness ring rolls out from the centre
  let ring = kickE * exp(-pow(length(wp) - kickAge * 2.6, 2.0) * 5.0);

  // bass breathes the whole field (billows swell); tension coils it tighter
  let coil   = 1.0 + u.tension * 0.5;
  let fscale = (1.6 - bassE * 0.5) * coil;

  // mid drives flow speed (flowT integrated in JS) and warp depth
  let warp = 0.9 + midE * 1.7 + ring * 0.8;
  let q0 = wp * fscale + vec2f(flowT * 0.045, -flowT * 0.03);
  let w1 = fbm(q0 + vec2f(ft * 0.5, -ft * 0.35));
  let w2 = fbm(q0 * 1.55 + vec2f(w1 * warp * 1.8, w1 * warp * 1.4) + vec2f(3.7, 9.1));
  let sm = clamp(w2 * 1.4 - 0.15 + ring * 0.3 + bassE * 0.12, 0.0, 1.0);

  var col = bg;

  if (look == 0) {
    // acid riso: two-colour smoke amoebas over the full frame
    let a  = pow(sm, 1.35);
    let b2 = pow(clamp(fbm(q0 * 1.9 + vec2f(-w1 * warp * 1.5, w1 * warp * 1.2)
                           + vec2f(17.3, 4.9)) * 1.4 - 0.2 + ring * 0.25, 0.0, 1.0), 1.5);
    col = bg + colA * (a * 0.85 + (f0 + f2) * 0.5)
             + colB * (b2 * 0.8 + (f1 + f3) * 0.45);
  } else if (look == 1) {
    // UV glow: the smoke itself carries the airbrushed light, blobs intensify
    let g = pow(sm, 1.9);
    col = bg + colA * (g * (0.7 + ft * 0.6) + ring * 0.3) * 1.25
             + colB * (pow(clamp(w1 * 1.3 - 0.25, 0.0, 1.0), 2.2) * 0.55 + f1 * 0.3);
  } else if (look == 2) {
    // thermal: posterized heat map over the whole frame, dithered band edges
    let x = clamp(sm * 0.62 + ft * 0.28 + ring * 0.22, 0.0, 1.0);
    let N = 7.0;
    let d = (hash21(in.uv * u.res_x * 0.5) - 0.5) / N;   // dither the bands
    col = thermal(floor((x + d) * N) / N) * 0.92;
  } else if (look == 3) {
    // electric veins riding the smoke field
    let q = wp * 2.1 * coil + vec2f(sm * 1.5, -sm * 1.1) + vec2f(0.0, flowT * 0.04);
    let r1 = 1.0 - abs(fbm(q) * 2.0 - 1.0);
    let r2 = 1.0 - abs(fbm(q * 1.7 + vec2f(5.1, 2.3)) * 2.0 - 1.0);
    let vein = pow(max(r1 * r2, 1e-3), 5.0);
    col = bg * (0.6 + sm * 0.9)
        + colA * vein * (1.1 + midE * 2.3 + ring * 2.0 + kickE * 0.7)
        + colB * (ft * 0.22 + sm * 0.15);
  } else {
    // ink swirl: monochrome smoke
    let smoke = pow(sm, 1.55);
    col = bg + colA * smoke * (0.85 + ft * 0.4 + ring * 0.4);
  }

  // kick pulse: the ring brightens the smoke as it passes + a light thump
  col *= 1.0 + ring * 0.5 + kickE * 0.07;

  // tension: colours saturate toward the drop
  let luma = dot(col, vec3f(0.299, 0.587, 0.114));
  col = mix(vec3f(luma), col, 1.0 + u.tension * 0.55);

  // snare: brief colour shimmer
  col += (colA * 0.6 + colB * 0.4) * snareE * 0.12;

  // drop slam: full-frame invert/flash while the look switches
  let fl = clamp(flash, 0.0, 1.0);
  col = mix(col, vec3f(1.1) - col * 0.85, fl * 0.85) + vec3f(fl * fl * 0.4);

  // ── the signature: heavy two-scale film grain, surging on snare ────────
  let gAmt = P.y * (1.0 + snareE * 1.1);
  let g1 = hash21(in.uv * u.res_x + vec2f(fract(u.time * 1.3) * 19.0));
  let g2 = vnoise(in.uv * u.res_x * 0.22 + vec2f(fract(u.time * 0.7) * 31.0));
  col *= 1.0 + (g1 - 0.5) * gAmt;
  col += vec3f(g2 - 0.5) * gAmt * 0.10;

  return vec4f(max(col, vec3f(0.0)), 1.0);
}
