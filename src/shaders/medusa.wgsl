// MEDUSA — deep-sea bioluminescent jellyfish ballet (BBC-documentary mood).
// Black water, faint caustic shafts wavering from above, marine snow, seven
// moon-jellies at different depths (far = small / dim / soft-edged). Each
// bell is a translucent parametric dome with internal anatomy — radial
// canals, a four-lobe gonad ring, apex glow — plus a fringe curtain, four
// frilly oral arms and two long marginal tentacles rendered as
// phase-delayed sine curves so they LAG the bell's motion. Contraction
// (extra A.w, driven kick-locked from JS) narrows + heightens the bell and
// pushes the bioluminescent cores past the bloom threshold.
//
// extra[0..13]  7 medusae × 2 slots, sorted far → near:
//                 A = (x, y, depth, contraction)
//                 B = (heading, glow, size, sway)
// extra[14]     (tapX, tapY, tapEnv, dropWave)
// extra[15]     (snareEnv, midEma, highEma, bassEma)

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

fn hash11(p: f32) -> f32 {
  return fract(sin(p * 127.1 + 13.7) * 43758.5453);
}

// Bioluminescence tint: abyssal cyan pulled toward the track's key.
fn bio_col() -> vec3f {
  let cyan = vec3f(0.28, 0.82, 1.00);
  let keyc = hsv2rgb(vec3f(u.key_hue, 0.58, 1.0));
  return mix(cyan, keyc, clamp(u.key_conf, 0.0, 1.0) * 0.55);
}

// Soft light shafts from the surface, slowly wavering.
fn caustics(sp: vec2f) -> f32 {
  let x = sp.x + sp.y * 0.22;
  var v = sin(x * 2.1 + u.time * 0.110)
        + sin(x * 3.7 - u.time * 0.073 + 1.7)
        + sin(x * 6.3 + u.time * 0.127 + 4.2);
  v = max(v - 1.35, 0.0);
  return v * v * 0.34 * smoothstep(-0.6, 1.1, sp.y);
}

// Marine snow: sparse drifting motes, gently twinkling.
fn snow_layer(p: vec2f, cells: f32, t: f32, fall: f32, tw: f32) -> f32 {
  let q = p * cells + vec2f(sin(t * 0.05) * 0.4, t * fall);
  let id = floor(q);
  let r1 = hash21(id);
  if (r1 < 0.62) { return 0.0; }
  let r2 = hash21(id + vec2f(71.7, 13.3));
  let f = fract(q) - 0.5;
  let off = (vec2f(r1, r2) - 0.5) * 0.8;
  let d = length(f - off);
  let sz = 0.035 + r2 * 0.05;
  let twk = 0.5 + 0.5 * sin(t * (0.6 + r2 * 2.4) + r1 * 40.0);
  return smoothstep(sz, sz * 0.25, d) * (0.35 + twk * tw);
}

// One medusa: returns premultiplied rgb (xyz) + occlusion alpha (w).
fn draw_medusa(sp: vec2f, i: i32, bio: vec3f) -> vec4f {
  let A = u.extra[i * 2];
  let B = u.extra[i * 2 + 1];
  let depth = A.z;
  let scale = B.z * mix(0.34, 1.05, depth);
  let d0 = sp - A.xy;
  if (dot(d0, d0) > scale * scale * 12.0) { return vec4f(0.0); }

  let dirv = vec2f(sin(B.x), cos(B.x));
  let perp = vec2f(dirv.y, -dirv.x);
  let lp = vec2f(dot(d0, perp), dot(d0, dirv)) / scale;
  if (abs(lp.x) > 1.6 || lp.y > 1.2 || lp.y < -3.0) { return vec4f(0.0); }

  let contr = A.w;
  let glow  = B.y;
  let sway  = B.w;
  let soft  = mix(2.8, 1.0, depth);      // far bodies blur out
  let bmul  = mix(0.26, 1.0, depth);     // ...and dim into the water
  let seed  = hash11(f32(i) * 13.7 + u.scene_seed);
  // slight per-body tint variation so the shoal isn't monochrome
  let jit  = (seed - 0.5) * 0.24;
  let mcol = bio * vec3f(1.0 - jit, 1.0, 1.0 + jit);

  var rgb   = vec3f(0.0);
  var alpha = 0.0;

  // ── bell: contraction narrows and heightens the dome ────────────────────
  let bw   = 0.60 * (1.0 - 0.22 * contr);
  let bh   = 0.46 * (1.0 + 0.34 * contr);
  let cutY = -0.10;
  let ang  = atan2(lp.x, max(lp.y, 0.001) + 0.15);
  let scal = 1.0 + sin(ang * 16.0 + seed * 20.0) * 0.014;   // scalloped rim
  // below the equator the margin curls inward — rounds the corners off
  let rr   = length(vec2f(lp.x / bw * (1.0 + max(-lp.y, 0.0) * 1.2),
                          max(lp.y, 0.0) / bh)) * scal;
  let ew   = 0.020 * soft;

  if (lp.y > cutY && rr < 1.0 + ew) {
    let inb    = smoothstep(1.0 + ew, 1.0 - ew, rr)
               * smoothstep(cutY, cutY + 0.07, lp.y);
    let topLit = 0.55 + 0.45 * smoothstep(-0.1, 1.0, lp.y / bh);
    // translucent membrane fill
    let fill = inb * 0.15 * topLit;
    // fresnel-ish rim — tangential view through more jelly
    let rim = pow(smoothstep(0.42, 1.0, rr), 4.0) * inb;
    // apex glow — the thick gelatinous crown
    let apex = exp(-length(vec2f(lp.x / bw, lp.y / bh - 0.40)) * 3.0) * inb;
    // radial canals fanning apex → rim
    let canal = pow(abs(sin(ang * 8.0 + seed * 6.283)), 30.0)
              * smoothstep(0.22, 0.72, rr) * inb;
    rgb += mcol * (fill  * (0.36 + glow * 0.80)
                 + rim   * (0.42 + glow * 1.55)
                 + apex  * (0.14 + glow * 0.50)
                 + canal * (0.13 + glow * 0.70));
    alpha += inb * 0.34;

    // gonad ring — four glowing lobes around the bell centre (moon jelly).
    // These are the hot cores that cross the bloom threshold on a pulse.
    for (var k = 0; k < 4; k++) {
      let gx = (f32(k) - 1.5) * 0.42 * bw;
      let gy = 0.30 * bh;
      let gp = vec2f((lp.x - gx) / (0.14 * bw + 0.02 * soft * scale),
                     (lp.y - gy) / (0.11 * bh + 0.02 * soft * scale));
      let gonad = exp(-dot(gp, gp) * 1.5) * inb;
      let gcol = mix(mcol, vec3f(1.0, 0.66, 0.58), 0.34);
      rgb += gcol * gonad * (0.22 + glow * 1.55);
    }
  }

  // ── fringe curtain: short tentacles under the rim, phase-delayed ────────
  let sBase = cutY - lp.y;                 // >0 below the bell margin
  if (sBase > -0.05 && sBase < 0.55 && abs(lp.x) < bw * 1.08) {
    let s   = clamp(sBase / 0.5, 0.0, 1.0);
    let swx = sway * 0.09 * sin(lp.y * 5.0 - u.time * 2.0 + seed * 30.0) * s;
    let hx  = (lp.x - swx) / bw;
    let strand = pow(abs(sin(hx * 26.0 + seed * 40.0)), 10.0 / soft);
    let mask = smoothstep(1.02, 0.88, abs(hx)) * smoothstep(1.0, 0.35, s);
    let fr = strand * mask * 0.45;
    rgb += mcol * fr * (0.26 + glow * 0.80);
    alpha += fr * 0.22;
  }

  // ── four frilly oral arms — the sway amplitude LAGS the bell (JS EMA) ──
  if (sBase > 0.0 && sBase < 1.9) {
    let sl = sBase / 1.9;
    for (var k = 0; k < 4; k++) {
      let fk = f32(k);
      let x0 = (fk - 1.5) * 0.20 * bw;
      let amp = sway * 0.34 + 0.05;
      let cx = x0 * (1.0 + sl * 1.1)
             + amp * sin(sBase * 4.2 - u.time * 1.7 + fk * 1.9 + seed * 20.0) * sl
             + sin(sBase * 13.0 + u.time * 2.6 + fk * 3.1) * 0.02 * sl;
      let w = mix(0.050, 0.007, sl) * (0.75 + 0.25 * sin(sBase * 30.0 + fk * 2.0));
      let arm = smoothstep(w + 0.014 * soft, max(w - 0.008, 0.0), abs(lp.x - cx))
              * pow(1.0 - sl, 0.6);
      rgb += mcol * arm * (0.13 + glow * 0.38);
      alpha += arm * 0.15;
    }
  }

  // ── two long marginal tentacles, thin and slow ──────────────────────────
  if (sBase > 0.0 && sBase < 2.8) {
    let sl = sBase / 2.8;
    for (var k = 0; k < 2; k++) {
      let sgn = f32(k) * 2.0 - 1.0;
      let cx = sgn * bw * 0.80 * (1.0 + sl * 0.35)
             + (sway * 0.5 + 0.04) * sin(sBase * 2.6 - u.time * 1.3 + sgn * 2.1 + seed * 10.0) * sl;
      let tn = smoothstep(0.010 + 0.008 * soft, 0.002, abs(lp.x - cx))
             * pow(1.0 - sl, 0.5);
      rgb += mcol * tn * (0.10 + glow * 0.30);
      alpha += tn * 0.10;
    }
  }

  return vec4f(rgb * bmul, min(alpha, 0.85));
}

@fragment
fn fs_render(in: VSOut) -> @location(0) vec4f {
  let aspect = u.res_x / max(u.res_y, 1.0);
  let sp = vec2f((in.uv.x - 0.5) * 2.0 * aspect, (0.5 - in.uv.y) * 2.0);
  let G0 = u.extra[14];   // tapX, tapY, tapEnv, dropWave
  let G1 = u.extra[15];   // snareEnv, midEma, highEma, bassEma
  let bio = bio_col();

  // ── black water, faintly denser (bluer) when the bass swells ────────────
  var col = vec3f(0.004, 0.009, 0.015);
  col += vec3f(0.008, 0.022, 0.032) * smoothstep(-1.2, 1.1, sp.y) * (0.55 + G1.w * 0.9);
  col += bio * caustics(sp) * (0.085 + G1.w * 0.14);

  // marine snow coordinates: taps stir a slow swirl into the water
  var sps = sp;
  {
    let dv = sp - G0.xy;
    let r  = length(dv);
    let a  = G0.z * exp(-r * 2.6) * 2.2;
    let ca = cos(a); let sa = sin(a);
    sps = G0.xy + vec2f(dv.x * ca - dv.y * sa, dv.x * sa + dv.y * ca);
  }

  // far snow (behind the shoal)
  col += bio * snow_layer(sps + vec2f(u.scene_seed), 22.0, u.time, 0.09, G1.z * 0.7) * 0.07;

  // ── the shoal, far → near ───────────────────────────────────────────────
  for (var i = 0; i < 7; i++) {
    let m = draw_medusa(sp, i, bio);
    col = col * (1.0 - m.w * 0.55) + m.xyz;
  }

  // near snow (in front) — high band makes the plankton shimmer
  col += bio * snow_layer(sps * 0.6 + vec2f(u.scene_seed * 2.0, 3.7), 14.0, u.time, 0.13, G1.z * 1.3) * 0.15;

  // snare → a brief glitter cloud of startled plankton
  if (G1.x > 0.015) {
    let cid = floor(u.beat_t) + u.scene_seed;
    let cc  = (vec2f(hash21(vec2f(cid, 3.1)), hash21(vec2f(cid, 7.7))) - 0.5)
            * vec2f(aspect * 1.3, 1.2);
    let fall = exp(-length(sp - cc) * 2.4);
    let g = snow_layer(sp + vec2f(cid * 7.0), 42.0, u.time * 3.0, 0.4, 1.0);
    col += bio * g * fall * G1.x * 1.6;
  }

  // drop → bioluminescent shockwave sweeping through the water
  if (G0.w > 0.01) {
    let wr = (1.0 - G0.w) * 2.8;
    col += bio * exp(-abs(length(sp) - wr) * 3.2) * G0.w * 0.55;
  }

  // tap → soft expanding ring where the water was touched
  if (G0.z > 0.01) {
    let tr = (1.0 - G0.z) * 0.9 + 0.05;
    col += bio * exp(-abs(length(sp - G0.xy) - tr) * 9.0) * G0.z * G0.z * 0.30;
  }

  // documentary finish: vignette + grain so the black never reads digital
  col *= 1.0 - dot(sp / vec2f(aspect, 1.0), sp / vec2f(aspect, 1.0)) * 0.16;
  let g = hash21(in.uv * u.res_x + vec2f(fract(u.time) * 13.0));
  col *= 1.0 + (g - 0.5) * 0.07;

  return vec4f(col, 1.0);
}
