// PYRO — a bonfire filmed at night.
//
// The flame is a volume, not a sprite: three independently advected,
// domain-warped flame layers composited back → front (deep dim red sheath →
// orange body → hot core). Each layer has its own seed, scale, parallax and
// rise speed so their edges never align; a slow low-frequency "pocket" field
// displaces the noise domain laterally as it rises, mushrooming the interior.
// Edges are soft density ramps that tear off into detached tongues. A slow
// light-spill envelope (JS-smoothed, light inertia) lets the fire illuminate
// the smoke above and the air around the base. HDR peaks ~2.5–3 so the shared
// bloom (threshold 0.30) glows instead of blowing the frame out.
//
// Extra region (16 vec4f at RIPPLE_OFFSET) — shared with the ember shaders:
//   extra[0] = (height, width, lean, roar)        flame body, JS-smoothed
//   extra[1] = (flicker, surge, flashover, quiet)
//   extra[2] = (tapX, tapY, tapEnv, tapAge)       thrown fuel, world coords
//   extra[3] = (rBase, rBurst, rSide, sideDir)    ember spawn rates (compute)
//   extra[4] = (popEnv, popX, glow, 0)            glow = slow light spill

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

fn hash21(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }

fn noise2(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let s = f * f * (3.0 - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2f(1.0, 0.0));
  let c = hash21(i + vec2f(0.0, 1.0));
  let d = hash21(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}

fn fbm(p: vec2f, oct: i32) -> f32 {
  var v = 0.0;
  var amp = 0.5;
  var q = p;
  for (var i = 0; i < oct; i++) {
    v += amp * noise2(q);
    q = q * 2.03 + vec2f(17.3, 9.2);
    amp *= 0.5;
  }
  return v;
}

// Blackbody-style temperature ramp: 0 black → deep red → orange → yellow →
// near-white. Values above ~0.82 pick up the white-hot core boost.
fn fire_ramp(t: f32) -> vec3f {
  let x = clamp(t, 0.0, 1.0);
  var c = vec3f(pow(x, 0.55), pow(x, 1.85) * 0.88, pow(x, 4.8) * 0.68);
  c += vec3f(0.58, 0.66, 0.66) * smoothstep(0.82, 1.0, x);
  return c;
}

// One flame layer: fake-fluid advection — the noise domain rises with a
// height-dependent speed (tongues stretch as they climb), gets displaced
// laterally by a slow low-frequency pocket field (mushrooming vortices), then
// is domain-warped by its own advected fbm. Returns (potential, pocket).
fn flame_field(px: f32, hy: f32, height: f32, width: f32,
               rise: f32, seed: f32, oct: i32) -> vec2f {
  let hn = hy / height;
  let adv = u.time * rise * (0.72 + min(hn, 1.6) * 0.50);
  var q = vec2f(px * 2.05, hy * 1.50 - adv) + vec2f(seed * 7.3, seed * 3.1);

  // rising hot pockets — slow, low-freq, they climb at ~half speed and shove
  // the finer noise sideways → the interior visibly churns and mushrooms
  let pk = noise2(vec2f(px * 1.25 + seed * 5.0, hy * 1.05 - u.time * rise * 0.50 + seed));
  q.x += (pk - 0.5) * (0.45 + min(hn, 1.8) * 0.85);

  let w = vec2f(fbm(q * 1.6 + vec2f(0.0, -u.time * rise * 0.42), oct),
                fbm(q * 1.6 + vec2f(5.2, -u.time * rise * 0.36 + 2.2), oct));
  let wa = 0.55 + min(hn, 2.0) * 0.85;
  let n  = fbm(q * 1.05 + (w - 0.5) * wa, oct);

  // potential: lateral gaussian − vertical falloff + noise licks (noise term
  // dominates near the tip → detached tongues, never a solid silhouette)
  let wd = width * (1.0 - min(hn, 1.6) * 0.40) * (0.72 + n * 0.55) + 0.05;
  let g  = exp(-(px * px) / (wd * wd));
  let v  = g * 1.02 - hn * (0.70 + 0.32 * hn) + (n - 0.5) * (0.50 + 0.95 * min(hn, 2.2));
  return vec2f(v, pk);
}

@fragment
fn fs_render(in: VSOut) -> @location(0) vec4f {
  let aspect = u.res_x / max(u.res_y, 1.0);
  // centred coords, y up, base of the fire at y = -1
  let sp = vec2f((in.uv.x - 0.5) * 2.0 * aspect, (0.5 - in.uv.y) * 2.0);

  let height = max(u.extra[0].x, 0.06);
  let width  = max(u.extra[0].y, 0.10);
  let lean   = u.extra[0].z;
  let roar   = u.extra[0].w;
  let flick  = u.extra[1].x;
  let fo     = u.extra[1].z;          // flashover 0..1
  let quiet  = u.extra[1].w;
  let tap    = u.extra[2];
  let popEnv = u.extra[4].x;
  let popX   = u.extra[4].y;
  let glow   = u.extra[4].z;          // slow light-spill envelope (light inertia)

  let hy = sp.y + 1.0;                       // 0 at fire base, 2 at frame top
  let px = sp.x - lean * hy * hy * 0.45;     // lean shears with height²
  let hn = hy / height;

  // audio only nudges the advection speed — the turbulence itself is the
  // fast motion, so the fire stays alive even when the music is static
  let rise = 1.05 + flick * 0.45 + roar * 0.35;

  // ── three flame layers: parallax, scale, speed and seed all differ ─────
  // back: wide, slow, deep red sheath   mid: the orange body   front: hot core
  let f0 = flame_field(px * 0.90 + 0.05, hy, height * 1.14, width * 1.50, rise * 0.72, u.scene_seed + 3.7,  4);
  let f1 = flame_field(px,               hy, height * 1.00, width * 1.12, rise * 1.00, u.scene_seed + 11.9, 4);
  let f2 = flame_field(px * 1.06 - 0.04, hy, height * 0.88, width * 0.80, rise * 1.28, u.scene_seed + 27.3, 5);
  var v0 = f0.x;
  var v1 = f1.x;
  var v2 = f2.x;

  // thrown fuel (canvas tap): local burst that lifts and burns out
  var tapv = 0.0;
  if (tap.z > 0.004) {
    let ty = tap.y + tap.w * 0.30;
    let dv = vec2f(sp.x - tap.x, (sp.y - ty) * 0.85);
    let tn = fbm(vec2f(sp.x * 3.4, sp.y * 2.4 - u.time * 2.6) + tap.x * 5.0, 4);
    tapv = tap.z * exp(-dot(dv, dv) * 10.0) * (0.40 + tn * 1.0);
    v2 += tapv * 0.40;
    v1 += tapv * 0.20;
  }

  // flashover: turbulent wall engulfing the frame on drops (JS-eased attack)
  let foAdd = fo * fo * (1.30 - hy * 0.16);
  v1 += foAdd * (0.45 + f1.y * 0.55);
  v2 += foAdd * (0.55 + f2.y * 0.60);

  // coal-bed pops during quiet passages — mid layer flare
  v1 += popEnv * exp(-(sp.x - popX) * (sp.x - popX) * 42.0)
              * exp(-hy * hy * 9.0) * (0.5 + f1.y * 0.6);

  // ── temperatures: hotter deep inside and low down, cool red at the tips ─
  let coolv = clamp(hn, 0.0, 1.25);
  var t0 = clamp(v0 * (0.72 - coolv * 0.28), 0.0, 0.48);
  var t1 = clamp(v1 * (1.05 - coolv * 0.42), 0.0, 0.85);
  var t2 = clamp(v2 * (1.22 - coolv * 0.55), 0.0, 1.0);

  // soft densities — wispy semi-transparent edges, no hard silhouette
  let d1 = smoothstep(0.02, 0.50, v1);
  let d2 = smoothstep(0.03, 0.48, v2);

  // interior hot pockets ride the pocket field upward through the body
  t1 += smoothstep(0.60, 0.92, f1.y) * d1 * 0.10;
  t2 += smoothstep(0.60, 0.92, f2.y) * d2 * 0.16;

  // dying fire cools white → orange; fresh fuel flares even on a dying fire
  let cooldn = 1.0 - quiet * 0.55 * (1.0 - fo);
  t0 *= cooldn; t1 *= cooldn; t2 *= cooldn;
  t2 = clamp(t2 + tapv * 1.40, 0.0, 1.02);

  // ── composite back → front with soft occlusion (depth, not addition) ───
  let occ0 = clamp(1.0 - d1 * 0.40 - d2 * 0.30, 0.0, 1.0);
  let occ1 = clamp(1.0 - d2 * 0.45, 0.0, 1.0);
  var col = fire_ramp(t0) * (0.12 * t0 + 0.85 * t0 * t0) * occ0;
  col += fire_ramp(t1) * (0.26 * t1 + 1.15 * pow(t1, 2.3)) * occ1;
  col += fire_ramp(t2) * (0.30 * t2 + 1.35 * pow(t2, 2.5));

  // ── coal bed: always breathing at the base, dominant when music dies ───
  let coalN  = noise2(vec2f(sp.x * 9.0 + u.scene_seed * 11.0, sp.y * 18.0));
  let coalN2 = noise2(vec2f(sp.x * 28.0, sp.y * 42.0) + u.scene_seed);
  let bed    = exp(-hy * hy * 14.0) * exp(-sp.x * sp.x * 1.20);
  let coal   = smoothstep(0.52, 0.92, coalN * 0.7 + coalN2 * 0.3) * bed;
  let breath = 0.55 + 0.45 * sin(u.time * 1.1 + coalN * 12.0 + coalN2 * 5.0);
  let coalT  = coal * (0.30 + 0.22 * breath) * (0.5 + quiet * 1.1 + u.bass * u.mul_bass * 0.4);
  col += fire_ramp(clamp(coalT * 2.0, 0.0, 0.62)) * coalT * 1.8;

  // ── smoke above the flame, lit from below by the fire (slow flicker) ───
  let key_col = hsv2rgb(vec3f(u.key_hue, 0.45, 1.0));
  let sq = vec2f(sp.x * 1.05 - lean * hy * 0.25, hy * 0.8 - u.time * 0.38) + u.scene_seed;
  let sn = fbm(sq * 1.5, 3);
  let smMask = smoothstep(height * 0.70, height * 1.8, hy) * smoothstep(2.35, 1.1, hy);
  let smoke  = smoothstep(0.42, 0.85, sn) * smMask * (1.0 - fo);
  // warm-lit low, grey and key-tinted higher up
  let smWarm = mix(fire_ramp(0.40) * 1.3, mix(vec3f(0.50, 0.47, 0.44), key_col, 0.30 * u.key_conf),
                   clamp(hn * 0.65 - 0.15, 0.0, 1.0));
  col += smWarm * smoke * (0.018 + glow * 0.075);

  // ── light spill: broad warm radial glow with light inertia (glow is a
  // slow JS envelope) plus a very slow in-shader breathing flicker ─────────
  let gf = 0.82 + 0.18 * noise2(vec2f(u.time * 0.55, u.scene_seed * 9.0));
  let spill = exp(-(px * px * 0.50 + hy * hy * 0.85)) * (0.030 + glow * 0.10) * gf;
  col += fire_ramp(0.42) * spill;

  // near-black night backdrop
  col = max(col, vec3f(0.004, 0.003, 0.003));

  // MIDI note attacks nudge the whole frame
  col *= 1.0 + u.pulse * 0.15;

  // trail_gain carries the per-frame persistence alpha from JS
  return vec4f(col, u.trail_gain);
}
