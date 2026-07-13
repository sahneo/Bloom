// PRISM — liquid chrome glass (мудборд neobjects/refraction):
// raymarched metaball glass mass floating in a dark studio. Real
// per-channel refraction (dispersion: R/G/B use different IOR), hard
// HDR speculars from three studio lights, iridescent rim at grazing
// angles. Bass pulls the droplets together into one molten form; the
// kick flares the key light; a drop SHATTERS the mass apart.
//
// extra[0..4] = 5 metaballs (x, y, z, radius)
// extra[7]    = (kickEnv, iridescence, midE, highE)

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

fn hash21(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// Liquid mass: five metaballs, surfaces gently rippled so highlights swim
fn map(p: vec3f) -> f32 {
  var d = 1e5;
  for (var i = 0; i < 5; i++) {
    let B = u.extra[i];
    let ds = length(p - B.xyz) - B.w;
    d = smin(d, ds, 0.38);
  }
  // slow surface ripple — molten, not rigid
  d += sin(p.x * 6.1 + u.time * 0.7) * sin(p.y * 5.3 - u.time * 0.5)
     * sin(p.z * 4.7 + u.time * 0.6) * 0.012;
  return d;
}

fn normal_at(p: vec3f) -> vec3f {
  let k = vec2f(1.0, -1.0);
  let e = 0.0015;
  return normalize(
    k.xyy * map(p + k.xyy * e) +
    k.yyx * map(p + k.yyx * e) +
    k.yxy * map(p + k.yxy * e) +
    k.xxx * map(p + k.xxx * e));
}

// Studio environment (direction-indexed): dark void + three lights.
// Music rides the lamps: kick flares the key, mid/high feed the others.
fn env(d: vec3f) -> vec3f {
  let P = u.extra[7];
  var c = vec3f(0.010) + vec3f(0.020, 0.022, 0.028) * (d.y * 0.5 + 0.5);
  // wide softbox — the broad white bands liquid chrome lives on
  c += vec3f(1.0, 0.99, 0.97)
     * pow(max(dot(d, normalize(vec3f(0.35, 0.60, -0.72))), 0.0), 9.0)
     * (1.6 + P.x * 1.2);
  // key light — hard hot core inside the softbox, kick-flared
  c += vec3f(1.0, 0.98, 0.95)
     * pow(max(dot(d, normalize(vec3f(0.45, 0.68, -0.55))), 0.0), 320.0)
     * (22.0 + P.x * 26.0);
  // broad cool fill
  c += vec3f(0.70, 0.78, 0.95)
     * pow(max(dot(d, normalize(vec3f(-0.70, 0.05, -0.60))), 0.0), 14.0)
     * (0.9 + P.z * 1.8);
  // low warm strip
  c += vec3f(1.0, 0.80, 0.55)
     * pow(max(dot(d, normalize(vec3f(0.05, -0.80, -0.45))), 0.0), 30.0)
     * (0.8 + P.w * 3.0);
  return c;
}

@fragment
fn fs_render(in: VSOut) -> @location(0) vec4f {
  let aspect = u.res_x / max(u.res_y, 1.0);
  let sp = vec2f((in.uv.x - 0.5) * 2.0 * aspect, (0.5 - in.uv.y) * 2.0);

  let P = u.extra[7];
  // camera with a slow orbital drift
  let az = u.time * 0.04 + u.drift_rot * 0.2;
  let ro0 = vec3f(0.0, 0.0, -3.1);
  let ca = cos(az); let sa = sin(az);
  let ro = vec3f(ro0.x * ca + ro0.z * sa, sin(u.time * 0.03) * 0.15, -ro0.x * sa + ro0.z * ca);
  let fwd = normalize(-ro);
  let rt  = normalize(cross(vec3f(0.0, 1.0, 0.0), fwd));
  let up  = cross(fwd, rt);
  let rd  = normalize(fwd * 1.7 + rt * sp.x + up * sp.y);

  // ── march ──────────────────────────────────────────────────────────────
  var t = 0.0;
  var hit = false;
  for (var i = 0; i < 72; i++) {
    let d = map(ro + rd * t);
    if (d < 0.0012) { hit = true; break; }
    t += d;
    if (t > 8.0) { break; }
  }

  var col: vec3f;
  if (hit) {
    let p = ro + rd * t;
    let n = normal_at(p);
    let fres = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);

    // reflection: hard chrome highlights
    let refl = env(reflect(rd, n));

    // refraction with dispersion — R/G/B bend differently through the mass
    let rR = refract(rd, n, 0.655);
    let rG = refract(rd, n, 0.670);
    let rB = refract(rd, n, 0.685);
    let refr = vec3f(env(rR).r, env(rG).g, env(rB).b) * vec3f(0.94, 0.96, 0.98);

    col = mix(refr, refl * 1.25, clamp(0.30 + fres * 0.75, 0.0, 1.0));

    // iridescent film at grazing angles — the oily rainbow rim
    let irid = hsv2rgb(vec3f(fract(fres * 1.8 + dot(n, vec3f(0.3, 0.5, 0.2)) + u.key_hue),
                             0.75, 1.0));
    col += irid * pow(fres, 2.5) * P.y * (0.25 + u.beat_conf * exp(-fract(u.beat_t) * 5.0) * 0.20);
  } else {
    // void: near-black with the faintest floor bounce
    col = vec3f(0.005, 0.005, 0.007)
        + vec3f(0.010, 0.011, 0.014) * pow(max(-rd.y, 0.0), 2.0);
  }

  // subtle grain so the black isn't digital-dead
  let g = hash21(in.uv * u.res_x + vec2f(fract(u.time) * 13.0));
  col *= 1.0 + (g - 0.5) * 0.08;

  return vec4f(col, 1.0);
}
