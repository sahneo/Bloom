// STORM — flight through a volumetric thunderstorm.
//
// Dark rolling clouds built from three parallax layers of domain-warped FBM,
// scrolling toward the camera at different speeds. Musical transients spawn
// branching lightning bolts (data in the ripple uniform region: one vec4 per
// bolt — x position, seed, age, intensity; the jagged path is re-generated
// procedurally here from the seed). Bolt light feeds back into the cloud
// shading with distance falloff, which is what sells the volume. Bass keeps
// a dull key-coloured glow breathing deep inside the far layer; tension
// darkens and thickens the deck; drops fire a wall of simultaneous strikes
// plus a whole-sky flash (passed in _r1).
//
// Bolt cores sit at 5-8 HDR so the shared bloom chain (threshold 0.30)
// makes them burn.

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
  ripple_pos_age: array<vec4f, 8>,   // per bolt: x, seed, age, intensity
  ripple_color:   array<vec4f, 8>,   // per bolt: slant, width, branch seed, 0
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

fn hash11(p: f32) -> f32 { return fract(sin(p * 127.1 + 11.3) * 43758.5453); }
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
  for (var i = 0; i < 4; i++) {
    v += amp * noise2(q);
    q = q * 2.03 + vec2f(17.3, 9.2);
    amp *= 0.5;
  }
  return v;
}

fn sd_seg(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

// ── Lightning channel ─────────────────────────────────────────────────────
// Jagged main channel from cloud top toward the ground, re-generated from
// the bolt's seed: 12 random-walk segments + two tapering side branches at
// seed-chosen nodes. Returns distance from p to the nearest channel point
// (branch distances are padded so branches read thinner than the trunk).
const SEG: i32 = 20;

// Stepped-leader model: the channel is a random WALK (each step inherits the
// previous offset) that stays near-vertical — small lateral steps, a rare
// sharp kink, gentle overall curvature. Branches split off downward at
// steep angles and taper. This is what real strikes look like, not a
// sawtooth around a straight line.
fn bolt_dist(p: vec2f, x0: f32, seed: f32, slant: f32) -> f32 {
  let ytop = 1.08;
  let ybot = -0.80;
  var xoff = (hash11(seed) - 0.5) * 0.06;
  var a = vec2f(x0 + xoff, ytop);
  var dmin = 1e9;
  let jb1 = 4 + i32(hash11(seed + 5.1) * 6.9);
  let jb2 = 9 + i32(hash11(seed + 9.7) * 7.9);
  for (var j = 0; j < SEG; j++) {
    let t = (f32(j) + 1.0) / f32(SEG);
    let h = hash11(seed + f32(j) * 17.13);
    // random walk: small steps, occasional hard kink (~1 in 6)
    var step = (h - 0.5) * 0.055;
    if (hash11(seed + f32(j) * 41.7) < 0.16) { step *= 3.2; }
    xoff += step;
    // curvature: the whole channel leans smoothly, leader-style
    let b = vec2f(x0 + slant * t * t + xoff, mix(ytop, ybot, t));
    // taper: distance padding grows toward the ground → thinner tip
    dmin = min(dmin, sd_seg(p, a, b) + t * 0.0022);
    if (j == jb1 || j == jb2) {
      var ba = a;
      let bdir = sign(hash11(seed + f32(j) * 3.7) - 0.5);
      let bs = seed + f32(j) * 31.7;
      var bx = 0.0;
      for (var k = 0; k < 5; k++) {
        // branches dive steeply: mostly down, drifting outward
        bx += bdir * (0.015 + hash11(bs + f32(k) * 7.3) * 0.035);
        let bb = ba + vec2f(bx * 0.5 + bdir * 0.01,
                            -(0.045 + hash11(bs + f32(k) * 13.1) * 0.075));
        dmin = min(dmin, sd_seg(p, ba, bb) + (f32(k) + 1.0) * 0.0050 + t * 0.002);
        ba = bb;
      }
    }
    a = b;
  }
  return dmin;
}

// One cloud layer: domain-warped FBM density + a cheap top-light shade term
// from the vertical density gradient. Returns (density 0..1, shade 0..1).
fn cloud_layer(sp: vec2f, scale: f32, speed: f32, seed: f32, cov: f32) -> vec2f {
  var q = sp * scale + vec2f(u.drift_x, u.drift_y) * 0.3 + vec2f(seed * 7.7, seed * 3.1);
  q.x += u.time * speed;
  q.y -= u.time * speed * 0.23;
  let w = vec2f(fbm(q * 1.6 + vec2f(0.0, u.time * 0.10)),
                fbm(q * 1.6 + vec2f(5.2, u.time * 0.09 + 1.3)));
  let qq = q + (w - 0.5) * (1.7 + u.bass * u.mul_bass * 0.9);
  let n = fbm(qq);
  let d = smoothstep(cov, cov + 0.40, n);
  // density thins upward → surface faces the sky → lit
  let n_up = fbm(qq + vec2f(0.0, 0.16));
  let shade = clamp(0.45 + (n - n_up) * 3.2, 0.0, 1.0);
  return vec2f(d, shade);
}

// Thin falling dashes on a hashed grid; slanted, wrapping vertically
fn rain_layer(sp: vec2f, scale: f32, speed: f32) -> f32 {
  let p = vec2f(sp.x * scale * 0.55 + sp.y * 1.2, (sp.y + u.time * speed) * scale * 0.16);
  let i = floor(p);
  let f = fract(p);
  let h = hash11(i.x * 91.7 + i.y * 37.3);
  let on = step(0.70, h);
  return on * smoothstep(0.10, 0.0, abs(f.x - 0.5)) * smoothstep(0.50, 0.30, abs(f.y - 0.5));
}

@fragment
fn fs_render(in: VSOut) -> @location(0) vec4f {
  let aspect = u.res_x / max(u.res_y, 1.0);
  // centred coords, y up, x spans ±aspect
  let sp = vec2f((in.uv.x - 0.5) * 2.0 * aspect, (0.5 - in.uv.y) * 2.0);

  let key_col = hsv2rgb(vec3f(u.key_hue, 0.55, 1.0));
  let key_amt = max(u.key_conf, 0.25);

  // ── Bolts: distance field → core / inner glow / wide cloud light ──────
  var bolt_core  = 0.0;
  var bolt_glow  = 0.0;
  var cloud_light = 0.0;   // wide falloff — illuminates the cloud interior
  for (var i = 0; i < 8; i++) {
    let pa = u.ripple_pos_age[i];   // x, seed, age, intensity
    let ex = u.ripple_color[i];     // slant, width, branch seed, -
    let inten = pa.w;
    let age = pa.z;
    if (inten < 0.01 || age > 1.4) { continue; }
    // strike envelope: hard flash, two re-strikes, fast decay + flicker
    let env = (exp(-age * 9.0)
             + 0.55 * exp(-abs(age - 0.11) * 45.0)
             + 0.35 * exp(-abs(age - 0.21) * 55.0))
            * (0.74 + 0.26 * sin(age * 110.0 + pa.y * 37.0));
    let aglow = exp(-age * 4.5);    // thunder afterglow, ~0.8 s
    let bx = pa.x * aspect * 0.88;
    let d = bolt_dist(sp, bx, pa.y, ex.x);
    let w = max(ex.y, 0.4);
    bolt_core  += inten * env * exp(-d * d / (0.000045 * w * w));
    bolt_glow  += inten * env * exp(-d * (17.0 / w));
    cloud_light += inten * (env * 1.15 + aglow * 0.26) / (1.0 + d * d * 20.0);
  }

  // ── Sky behind the deck: near-black night, faint key-hue horizon ──────
  let horizon = exp(-abs(sp.y + 0.62) * 2.6);
  var col = vec3f(0.005, 0.006, 0.010)
          + key_col * horizon * 0.028 * key_amt;

  // ── Cloud deck: 3 parallax layers, far → near ──────────────────────────
  let energy   = clamp(u._r2, 0.0, 1.0);
  let cov      = 0.34 - u.tension * 0.10 - energy * 0.03;      // thicken on builds
  let lightmul = 1.0 - u.tension * 0.50;                        // darken on builds
  let flash    = clamp(u._r1, 0.0, 2.0) * 1.05 + u.drop_pulse * 0.45;  // sky-wide discharge
  // vertical mass: heavy overhead, ragged toward the horizon
  let vmask = 0.38 + 0.62 * smoothstep(-0.9, 0.25, sp.y);

  // deep bass glow, breathing inside the far layer
  let deep_mask = smoothstep(0.52, 0.85, fbm(sp * 0.85 + vec2f(u.scene_seed * 3.7, u.time * 0.03)));
  let breathe = 0.75 + 0.25 * sin(u.time * 1.4 + u.scene_seed);
  let deep_glow = key_col * deep_mask * breathe
                * (u.bass * u.mul_bass * 0.20 + u.sub_bass * u.mul_sb * 0.12);

  let albedo = vec3f(0.26, 0.29, 0.36);
  let lightning_tint = mix(key_col, vec3f(1.0), clamp(cloud_light * 0.40, 0.0, 0.65));

  // far layer — slow, holds the deep glow
  let far = cloud_layer(sp, 1.15, 0.020, u.scene_seed + 1.0, cov);
  let far_d = far.x * vmask;
  var lc = albedo * (0.105 + far.y * 0.115 + flash * 0.12) * lightmul
         + lightning_tint * cloud_light * 0.18
         + deep_glow;
  col = mix(col, lc, far_d * 0.85);

  // mid layer — the bolts live just in front of this one
  let mid = cloud_layer(sp, 1.95, 0.052, u.scene_seed + 2.0, cov + 0.02);
  let mid_d = mid.x * vmask;
  lc = albedo * (0.080 + mid.y * 0.125 + flash * 0.16) * lightmul
     + lightning_tint * cloud_light * 0.50
     + deep_glow * 0.4;
  col = mix(col, lc, mid_d * 0.9);

  // ── Bolts render between mid and near layers ──────────────────────────
  // near layer occludes them, selling the "inside the storm" depth
  let near = cloud_layer(sp, 3.1, 0.115, u.scene_seed + 3.0, cov + 0.05);
  let near_d = near.x * vmask;
  let occl = 1.0 - near_d * 0.82;
  col += (vec3f(1.0, 0.98, 0.95) * bolt_core * 6.5
        + key_col * bolt_glow * 1.5) * occl;

  // near layer — fast scud, mostly silhouette, rim-lit by the discharge
  lc = albedo * (0.048 + near.y * 0.085 + flash * 0.18) * lightmul
     + lightning_tint * cloud_light * 0.32;
  col = mix(col, lc, near_d * 0.92);

  // ── Rain: two parallax layers of streaks, revealed by the light ───────
  // Rain is nearly invisible in the dark and flares up whenever a bolt or
  // sheet flash lights the air — like real storm footage.
  let rain_amt = 0.25 + energy * 0.75;
  let rlight   = 0.18 + flash * 1.6 + cloud_light * 1.1 + bolt_glow * 0.8;
  let rn = rain_layer(sp, 16.0, 2.6) + rain_layer(sp, 27.0, 3.8) * 0.6;
  col += vec3f(0.62, 0.70, 0.86) * rn * rain_amt * rlight * 0.22;

  // ── Sky-wide flash on drops (clouds already brightened via `flash`) ────
  col += vec3f(1.0, 0.97, 0.92) * flash * 0.12 * (0.4 + 0.6 * vmask);

  // MIDI note attacks nudge the whole frame
  col *= 1.0 + u.pulse * 0.18;

  // trail_gain carries the motion-blur alpha (persistence) from JS
  return vec4f(col, u.trail_gain);
}
