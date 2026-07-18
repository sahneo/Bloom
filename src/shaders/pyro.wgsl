// PYRO — a living bonfire filmed on macro at night.
//
// Fullscreen flame body: upward-advected, domain-warped FBM whose potential
// field (lateral gaussian − vertical falloff + noise licks) is shaded with a
// blackbody temperature ramp — deep red sheath → orange → yellow → white-hot
// core at 4+ HDR so the shared bloom chain (threshold 0.30) burns. A coal bed
// breathes at the base, faint key-tinted smoke wisps drift above, and drops
// fire a flashover — a white-hot wall that engulfs the frame then collapses.
// Embers are a separate instanced particle pass (pyro_ember_*.wgsl).
//
// Extra region (16 vec4f at RIPPLE_OFFSET) — shared with the ember shaders:
//   extra[0] = (height, width, lean, roar)        flame body, JS-smoothed
//   extra[1] = (flicker, surge, flashover, quiet)
//   extra[2] = (tapX, tapY, tapEnv, tapAge)       thrown fuel, world coords
//   extra[3] = (rBase, rBurst, rSide, sideDir)    ember spawn rates (compute)
//   extra[4] = (popEnv, popX, 0, 0)               quiet-passage coal pops

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

fn fbm(p: vec2f) -> f32 {
  var v = 0.0;
  var amp = 0.5;
  var q = p;
  for (var i = 0; i < 5; i++) {
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
  c += vec3f(0.58, 0.66, 0.66) * smoothstep(0.80, 1.0, x);
  return c;
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

  let hy = sp.y + 1.0;                       // 0 at fire base, 2 at frame top
  let px = sp.x - lean * hy * hy * 0.45;     // lean shears with height²
  let hn = hy / height;

  // ── flame body: upward-advected, domain-warped FBM ─────────────────────
  let rise = 1.15 + flick * 0.9 + roar * 0.5;
  let q  = vec2f(px * 2.1, hy * 1.55 - u.time * rise)
         + vec2f(u.scene_seed * 7.3, u.scene_seed * 3.1);
  let wa = 0.55 + min(hn, 2.0) * 0.85 + roar * 0.30;    // turbulence grows upward
  let w  = vec2f(fbm(q * 1.9 + vec2f(0.0, -u.time * rise * 0.35)),
                 fbm(q * 1.9 + vec2f(4.7, -u.time * rise * 0.31 + 2.2)));
  let n  = fbm(q * 1.15 + (w - 0.5) * wa);

  // potential: lateral gaussian − vertical falloff + noise licks (noise term
  // dominates near the tip → sharp separating tongues, not a blob)
  let wd = width * (1.0 - min(hn, 1.6) * 0.42) * (0.8 + n * 0.4) + 0.05;
  let g  = exp(-(px * px) / (wd * wd));
  var v  = g * 1.05 - hn * (0.76 + 0.33 * hn) + (n - 0.5) * (0.55 + 0.95 * min(hn, 2.2));

  // thrown fuel (canvas tap): local burst that lifts and burns out.
  // Kept separate from the body falloff — fuel burns where it lands.
  var tapv = 0.0;
  if (tap.z > 0.004) {
    let ty = tap.y + tap.w * 0.30;
    let dv = vec2f(sp.x - tap.x, (sp.y - ty) * 0.85);
    let tn = fbm(vec2f(sp.x * 3.4, sp.y * 2.4 - u.time * 2.6) + tap.x * 5.0);
    tapv = tap.z * exp(-dot(dv, dv) * 10.0) * (0.40 + tn * 1.0);
    v += tapv * 0.35;
  }

  // flashover: white-hot turbulent wall engulfing the frame on drops
  v += fo * fo * (1.30 - hy * 0.16) * (0.55 + n * 0.75);

  // coal-bed pops during quiet passages
  v += popEnv * exp(-(sp.x - popX) * (sp.x - popX) * 42.0)
             * exp(-hy * hy * 9.0) * (0.5 + n * 0.6);

  // temperature: hotter low in the flame, cool red at the tips
  var t = clamp(v * (1.42 - clamp(hn, 0.0, 1.2) * 0.78), 0.0, 1.0);
  t *= smoothstep(0.0, 0.07, v);        // kill sub-zero haze — frame stays black
  t *= 1.0 - quiet * 0.58 * (1.0 - fo); // dying fire cools white → orange
  t = clamp(t + tapv * 1.05, 0.0, 1.02);  // fresh fuel flares even on a dying fire

  var col = fire_ramp(t) * (0.30 * t + 3.7 * pow(t, 2.6));

  // ── coal bed: always breathing at the base, dominant when music dies ───
  let coalN  = noise2(vec2f(sp.x * 9.0 + u.scene_seed * 11.0, sp.y * 18.0));
  let coalN2 = noise2(vec2f(sp.x * 28.0, sp.y * 42.0) + u.scene_seed);
  let bed    = exp(-hy * hy * 14.0) * exp(-sp.x * sp.x * 0.55);
  let coal   = smoothstep(0.52, 0.92, coalN * 0.7 + coalN2 * 0.3) * bed;
  let breath = 0.55 + 0.45 * sin(u.time * 1.1 + coalN * 12.0 + coalN2 * 5.0);
  let coalT  = coal * (0.30 + 0.22 * breath) * (0.5 + quiet * 0.9 + u.bass * u.mul_bass * 0.4);
  col += fire_ramp(clamp(coalT * 2.0, 0.0, 0.62)) * coalT * 1.7;

  // ── smoke wisps above the flame — faint, subtly key-tinted ─────────────
  let key_col = hsv2rgb(vec3f(u.key_hue, 0.45, 1.0));
  let sq = vec2f(sp.x * 1.05 - lean * hy * 0.25, hy * 0.8 - u.time * 0.38) + u.scene_seed;
  let sn = fbm(sq * 1.5 + (w - 0.5) * 0.8);
  let smMask = smoothstep(height * 0.75, height * 1.9, hy) * smoothstep(2.35, 1.2, hy);
  let smoke  = smoothstep(0.45, 0.85, sn) * smMask * (1.0 - fo);
  let smokeTint = mix(vec3f(0.50, 0.47, 0.44), key_col, 0.30 * u.key_conf);
  col += smokeTint * smoke * (0.030 + quiet * 0.015);

  // warm air glow hugging the fire
  col += fire_ramp(0.45) * exp(-hy * 1.5) * exp(-px * px * 1.2)
       * (0.05 + u.bass * u.mul_bass * 0.05) * (1.0 - quiet * 0.6);

  // near-black night backdrop
  col = max(col, vec3f(0.004, 0.003, 0.003));

  // MIDI note attacks nudge the whole frame
  col *= 1.0 + u.pulse * 0.15;

  // trail_gain carries the per-frame persistence alpha from JS
  return vec4f(col, u.trail_gain);
}
