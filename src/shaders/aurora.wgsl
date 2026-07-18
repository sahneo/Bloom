// AURORA — polar aurora over a dark arctic night.
//
// Tall curtains of light rippling and folding across the sky, each one a
// domain-warped band with fine vertical "picket fence" ray structure — the
// thin rays are what sells the realism. Up to 6 curtains live at once, each
// owned by JS (position, envelope, kick-wave) and re-generated procedurally
// here from its seed. Depth comes from a per-curtain z (from the seed):
// far curtains are small, slow, desaturated and hug the horizon; near ones
// tower overhead with faster shimmer and stronger parallax.
//
// Music mapping (fields computed JS-side, uploaded via `extra`):
//   bass  → sway amplitude of whole curtains (slow horizontal breathing)
//   mid   → fold amplitude (ripples in the curtain fabric)
//   high  → ray flicker speed + contrast (shimmer)
//   kick  → brightness wave traveling ALONG a curtain (waveX/waveAmp)
//   snare → short global shimmer flicker (extra[12].y)
//   tension → curtains reach higher + saturate (extra[12].w)
//   drop  → substorm (extra[12].x): all curtains erupt, corona blooms at
//           the zenith (extra[13].x), colors shift red→purple, then calm.
//
// extra slot layout (16 × vec4f at byte offset 176):
//   extra[0..5]  per curtain i: (x_center -1..1, seed, age_s, amp)
//   extra[6..11] per curtain i: (width, waveX_local, waveAmp, ignite)
//   extra[12]    (substorm, snareFlicker, energySmooth, raise/tension)
//   extra[13]    (coronaEnv, tapFlash, 0, 0)
//   extra[14..15] reserved
//
// Bright ray cores reach 2-5 HDR so the shared bloom chain (threshold 0.30)
// makes them glow; the frame stays dark with few hot highlights.

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

// 3-octave variant for the per-curtain shape curves (cheaper: 6 curtains
// each sample several of these per pixel).
fn fbm3(p: vec2f) -> f32 {
  var v = 0.0;
  var amp = 0.55;
  var q = p;
  for (var i = 0; i < 3; i++) {
    v += amp * noise2(q);
    q = q * 2.13 + vec2f(13.7, 7.9);
    amp *= 0.48;
  }
  return v;
}

// Physical aurora palette along altitude t (0 = lower border, 1 = top).
// 557.7 nm atomic-oxygen green dominates; the lower border carries a thin
// pink/blue nitrogen fringe; tops fade through red into purple. Substorms
// push the tops toward saturated purple.
fn aurora_palette(t: f32, storm: f32) -> vec3f {
  let green    = vec3f(0.10, 1.00, 0.32);
  let teal     = vec3f(0.05, 0.72, 0.55);
  let top      = mix(vec3f(0.85, 0.15, 0.38), vec3f(0.66, 0.13, 0.86), 0.35 + storm * 0.5);
  let fringe   = vec3f(0.60, 0.19, 0.74);
  var c = mix(green, top, smoothstep(0.34, 0.95, t));
  c = mix(c, teal, smoothstep(0.30, 0.02, t) * 0.22);
  c = mix(fringe, c, smoothstep(0.0, 0.06, t));
  return c;
}

@fragment
fn fs_render(in: VSOut) -> @location(0) vec4f {
  let aspect = u.res_x / max(u.res_y, 1.0);
  // centred coords, y up, x spans ±aspect
  let sp = vec2f((in.uv.x - 0.5) * 2.0 * aspect, (0.5 - in.uv.y) * 2.0);

  let substorm = u.extra[12].x;
  let flick    = u.extra[12].y;
  let energy   = u.extra[12].z;
  let raise    = u.extra[12].w;
  let corona   = u.extra[13].x;
  let tapflash = u.extra[13].y;

  let key_col = hsv2rgb(vec3f(u.key_hue, 0.6, 1.0));
  let key_amt = clamp(u.key_conf, 0.0, 1.0);

  // music → motion character
  let sway_amp   = 0.14 + u.bass * u.mul_bass * 0.34 + substorm * 0.18;
  let fold_amp   = 0.30 + u.mid  * u.mul_mid  * 0.55 + substorm * 0.25;
  let flick_spd  = 1.0 + u.high * u.mul_high * 6.5 + flick * 5.0 + substorm * 3.0;
  let ray_contr  = 0.40 + u.high * u.mul_high * 0.50 + flick * 0.45 + substorm * 0.35;

  // ── Sky: near-black arctic night, faint blue gradient ─────────────────
  let up = clamp(sp.y * 0.75 + 0.6, 0.0, 1.0);
  var col = mix(vec3f(0.010, 0.015, 0.032), vec3f(0.002, 0.003, 0.008), up);
  col += key_col * exp(-abs(sp.y + 0.66) * 3.2) * 0.018 * max(key_amt, 0.2);

  // ── Curtains ──────────────────────────────────────────────────────────
  var alum = 0.0;   // accumulated aurora luminance (dims stars, lights snow)
  for (var i = 0; i < 6; i++) {
    let ca = u.extra[i];       // x_center, seed, age, amp
    let cb = u.extra[i + 6];   // width, waveX, waveAmp, ignite
    let amp = ca.w;
    if (amp < 0.012) { continue; }
    let seed = ca.y;
    let z = 0.20 + 0.80 * hash11(seed * 3.31);           // depth: 0 far → 1 near
    let cx = ca.x * aspect;
    let xl = sp.x - cx;
    let env = exp(-xl * xl / max(cb.x * cb.x, 1e-4));    // horizontal extent
    if (env < 0.004) { continue; }

    let px = sp.x + u.drift_x * (0.12 + 0.38 * z);       // parallax drift
    let tt = u.time * (0.45 + 0.55 * z);                 // near layers move faster

    // whole-curtain sway (bass) + meandering lower border
    let sway = (fbm3(vec2f(px * 0.5 + seed * 7.1, tt * 0.055 + seed)) - 0.5) * sway_amp * 2.0;
    let xs = px + sway;
    let yb = mix(-0.30, -0.58, z)
           + (fbm3(vec2f(xs * 0.72 + seed * 13.0, tt * 0.045)) - 0.5) * 0.48;
    let h = sp.y - yb;
    if (h < -0.06) { continue; }

    // curtain height varies along its length; tension raises the whole sheet
    let hgt = mix(0.50, 2.0, z) * (1.0 + raise * 0.7 + substorm * 0.5)
            * (0.70 + 0.55 * fbm3(vec2f(xs * 0.9 + seed * 3.0, tt * 0.030)));

    // folds (mid) shear the ray coordinate; fine rays = picket fence
    let fold = (fbm3(vec2f(xs * 1.7 + seed * 5.0, tt * 0.085)) - 0.5) * fold_amp;
    let shear = (hash11(seed * 9.13) - 0.5) * 0.55 + sway * 0.4;
    let rc = (xs + fold + h * shear) * 19.0;
    let r1 = noise2(vec2f(rc,              seed * 17.0 + u.time * flick_spd * 0.13));
    let r2 = noise2(vec2f(rc * 2.6 + 31.0, seed *  7.0 + u.time * flick_spd * 0.21));
    var fine = clamp((r1 * 0.62 + r2 * 0.38) * 2.0 - 0.68, 0.0, 1.0);
    fine = fine * fine * (3.0 - 2.0 * fine);
    let rays = 0.22 + fine * (0.9 + ray_contr * 1.8);

    // folds doubling the sheet over itself → broad brightness variation
    let fb = fbm3(vec2f(xs * 1.15 + seed * 2.2, tt * 0.06 + 4.0));
    let fold_bright = 0.45 + 1.5 * fb * fb;

    // vertical profile: sharp lower border, exponential falloff upward;
    // bright rays reach higher (tall streamers)
    let low_edge = smoothstep(-0.045, 0.035, h);
    let fall = exp(-max(h, 0.0) * (2.1 / max(hgt * (0.45 + 1.0 * fine), 0.05)));
    let prof = low_edge * fall;

    // kick: brightness wave traveling along the curtain
    let wdx = (xl - cb.y) / 0.24;
    let wave = 1.0 + cb.z * exp(-wdx * wdx);

    // altitude → physical palette
    let tcol = clamp(h / max(hgt, 0.2), 0.0, 1.0);
    var acol = aurora_palette(tcol, substorm);
    // subtle key tint, stronger when detection is confident
    acol = mix(acol, dot(acol, vec3f(0.35, 0.5, 0.15)) * key_col * 1.9,
               0.10 * key_amt);
    // far curtains desaturate slightly (air perspective)
    acol = mix(acol, vec3f(dot(acol, vec3f(0.33))), (1.0 - z) * 0.25);

    let inten = amp * env * prof * rays * fold_bright * wave
              * mix(0.60, 1.35, z) * (1.0 + substorm * 1.5);
    col += acol * inten;
    // newborn curtains ignite with a white-hot lower border
    col += vec3f(0.85, 1.0, 0.92) * cb.w * env * low_edge
         * exp(-max(h, 0.0) * 5.0) * 0.6;
    alum += inten;
  }

  // ── Corona: substorm rays converging at the zenith ────────────────────
  if (corona > 0.01) {
    let cp = sp - vec2f(0.0, 1.02);
    let d = length(cp);
    let ang = atan2(cp.x, -cp.y);
    let cr1 = noise2(vec2f(ang * 5.5,        u.time * 0.9));
    let cr2 = noise2(vec2f(ang * 13.0 + 7.0, u.time * 1.5));
    let cr = pow(clamp((cr1 * 0.6 + cr2 * 0.4) * 1.9 - 0.38, 0.0, 1.0), 1.5);
    let radial = exp(-d * 1.1) + 0.35 * exp(-abs(d - 0.6) * 3.5);
    let ccol = mix(vec3f(0.45, 0.95, 0.50), vec3f(0.70, 0.18, 0.88),
                   clamp(d * 1.25, 0.0, 1.0));
    let cint = cr * radial * corona * 5.5;
    col += ccol * cint;
    alum += cint;
  }

  // substorm: the whole sky washes green for the first moments of eruption
  col += vec3f(0.10, 0.45, 0.24) * substorm * substorm * 0.14
       * (0.4 + 0.6 * exp(-abs(sp.y + 0.25) * 1.1));

  // ── Stars: two hashed grids, twinkling, washed out under bright aurora ─
  let star_dim = exp(-alum * 2.6);
  for (var s = 0; s < 2; s++) {
    let sc = select(14.0, 27.0, s == 1);
    let sg = sp * sc + vec2f(u.scene_seed * 7.7, f32(s) * 4.3);
    let cell = floor(sg);
    let hh = hash21(cell);
    let spos = vec2f(hash21(cell + 7.1), hash21(cell + 3.7));
    let sd = length(fract(sg) - spos);
    let tw = 0.55 + 0.45 * sin(u.time * (1.2 + hh * 4.0) + hh * 43.0);
    let br = max(hh - 0.86, 0.0) / 0.14;
    col += vec3f(0.72, 0.80, 1.0)
         * smoothstep(0.06, 0.0, sd) * step(0.86, hh)
         * tw * (0.10 + br * br * 0.55) * star_dim;
  }

  // ── Ground: dark treeline silhouette + snow catching the aurora ───────
  let tn = fbm(vec2f(sp.x * 2.4 + u.scene_seed * 11.0, u.scene_seed));
  let spiky = noise2(vec2f(sp.x * 26.0 + u.scene_seed * 5.0, 2.0));
  let yg = -0.80 + tn * 0.10 + spiky * spiky * 0.05;
  let ground = smoothstep(yg + 0.005, yg - 0.005, sp.y);
  let gcol = vec3f(0.002, 0.004, 0.008) + col * 0.07
           + aurora_palette(0.15, substorm) * alum * 0.02;
  col = mix(col, gcol, ground);

  // MIDI note attacks + tap flash nudge the whole frame
  col *= 1.0 + u.pulse * 0.14 + tapflash * 0.10;

  // trail_gain carries the motion-blur alpha (persistence) from JS
  return vec4f(col, u.trail_gain);
}
