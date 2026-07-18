// FROST — dendritic ice growth on a half-res cell grid (compute, ping-pong).
// Cell = vec2f(age, lattice). age 0 = clear glass; age > 0 = seconds frozen.
// lattice = crystal-axis angle inherited from the seed. Unfrozen cells
// adjacent to ice freeze stochastically, weighted by 6-fold hexagonal
// anisotropy around the neighbour's lattice axis — that directional bias is
// what turns round blobs into feathery dendrite arms. A static fbm gate
// carves gaps so the lace never fills into a solid sheet.
// Extra slots (offset RIPPLE_OFFSET, 16 × vec4f):
//   extra[0] = (gridW, gridH, growthRate, meltRate)
//   extra[1] = (shatterEnv, kickEnv, snareEnv, dissolve 0/1)
//   extra[2] = seed0 (x, y, active, lattice01)   canvas UV, y down
//   extra[3] = seed1        "
//   extra[4] = seed2        "
//   extra[5] = seed3        "
//   extra[6] = (hand0 x, y, meltStrength, present)
//   extra[7] = (hand1 x, y, meltStrength, present)
//   extra[8] = (bassEnv, sparkleEnv, growthTexScale, shatterSeed)

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
@group(0) @binding(1) var<storage, read> src: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec2f>;

fn hash12(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 345.45));
  q += dot(q, q + 34.345);
  return fract(q.x * q.y);
}

fn vnoise(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p);
  let w = f * f * (3.0 - 2.0 * f);
  let a = hash12(i);
  let b = hash12(i + vec2f(1.0, 0.0));
  let c = hash12(i + vec2f(0.0, 1.0));
  let d = hash12(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

fn fbm(p: vec2f) -> f32 {
  var v = 0.0; var amp = 0.5; var q = p;
  for (var i = 0; i < 3; i++) {
    v += vnoise(q) * amp;
    q = q * 2.03 + vec2f(17.0, 9.1);
    amp *= 0.5;
  }
  return v * 1.14;
}

@compute @workgroup_size(16, 16)
fn cs_grow(@builtin(global_invocation_id) gid: vec3u) {
  let E0 = u.extra[0];
  let gw = i32(E0.x);
  let gh = i32(E0.y);
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (x >= gw || y >= gh) { return; }
  let idx = u32(y * gw + x);

  let E1 = u.extra[1];
  let E8 = u.extra[8];
  let dt = min(u.delta, 0.05);
  let fx = f32(x); let fy = f32(y);
  let p  = vec2f((fx + 0.5) / f32(gw), (fy + 0.5) / f32(gh));
  let asp = u.res_x / max(u.res_y, 1.0);

  // per-frame stochastic draw for this cell
  let rnd = hash12(vec2f(fx, fy) + fract(u.frame * 0.618034) * 61.7);

  // hand warmth (open palm melts ice locally)
  var handMelt = 0.0;
  for (var h = 0u; h < 2u; h++) {
    let H = u.extra[6u + h];
    if (H.w < 0.05) { continue; }
    let d = vec2f((H.x - p.x) * asp, H.y - p.y);
    let r = length(d);
    if (r < 0.17) { handMelt += H.z * (1.0 - r / 0.17); }
  }

  let c = src[idx];

  if (c.x > 0.0) {
    // ── frozen: age, or melt away ─────────────────────────────────────
    // shatter dissolve — the pane crumbles in ~0.4s, in clustered chunks
    // (spatial noise gate) rather than per-cell salt-and-pepper
    if (E1.w > 0.5) {
      let chunk = 0.35 + 0.65 * vnoise(p * vec2f(asp, 1.0) * 16.0 + u.extra[8].w);
      if (rnd < dt * 24.0 * chunk) { dst[idx] = vec2f(0.0); return; }
    }
    // palm warmth
    if (handMelt > 0.02 && rnd < handMelt * dt * 10.0) { dst[idx] = vec2f(0.0); return; }
    // quiet-passage melt: only the growth front (cells touching clear glass)
    // retreats, so the lace thins from its edges inward
    if (E0.w > 0.001) {
      var onFront = false;
      if (x > 0      && src[idx - 1u].x        <= 0.0) { onFront = true; }
      if (x < gw - 1 && src[idx + 1u].x        <= 0.0) { onFront = true; }
      if (y > 0      && src[u32((y - 1) * gw + x)].x <= 0.0) { onFront = true; }
      if (y < gh - 1 && src[u32((y + 1) * gw + x)].x <= 0.0) { onFront = true; }
      if (onFront && rnd < E0.w * dt) { dst[idx] = vec2f(0.0); return; }
    }
    dst[idx] = vec2f(min(c.x + dt, 90.0), c.y);
    return;
  }

  // ── clear glass: seeds stamp first (a tap wins over everything) ─────
  for (var i = 0u; i < 4u; i++) {
    let S = u.extra[2u + i];
    if (S.z < 0.5) { continue; }
    let d = vec2f(S.x * f32(gw) - fx, S.y * f32(gh) - fy);
    if (dot(d, d) < 3.5) {
      dst[idx] = vec2f(0.001, S.w * 6.28318);
      return;
    }
  }

  // no regrowth while dissolving, none under a warm palm
  if (E1.w > 0.5 || handMelt > 0.18) { dst[idx] = vec2f(0.0); return; }

  // ── growth: freeze next to ice, biased along the crystal axis ───────
  var best = 0.0;
  var lat  = 0.0;
  var nFrozen = 0;
  for (var oy = -1; oy <= 1; oy++) {
    for (var ox = -1; ox <= 1; ox++) {
      if (ox == 0 && oy == 0) { continue; }
      let nx = x + ox; let ny = y + oy;
      if (nx < 0 || nx >= gw || ny < 0 || ny >= gh) { continue; }
      let n = src[u32(ny * gw + nx)];
      if (n.x <= 0.0) { continue; }
      nFrozen++;
      // direction from the frozen neighbour toward this cell
      let phi = atan2(f32(-oy), f32(-ox));
      let dphi = phi - n.y;
      // needle + feather: a sharp main axis races ahead, weaker 6-fold
      // lobes sprout side branches at ±60°, everything else crawls —
      // that hierarchy is what reads as ice instead of mold
      let wMain   = pow(abs(cos(dphi)), 18.0);
      let wBranch = 0.12 * pow(abs(cos(dphi * 3.0)), 6.0);
      var w = max(max(wMain, wBranch), 0.003);
      if (ox != 0 && oy != 0) { w *= 0.62; }   // diagonals are farther
      if (w > best) { best = w; lat = n.y; }
    }
  }
  // snowflake-CA thinness rule: a lone frozen neighbour = a growing tip
  // (freeze readily); dense ice nearby = diffusion-starved (grows slowly).
  // Needles race ahead, then plumes thicken behind them over seconds.
  if (nFrozen == 2) { best *= 0.25; }
  else if (nFrozen >= 3) { best *= 0.03; }
  if (best > 0.0005) {
    // hard fbm lace gate: part of the pane can never freeze → permanent
    // dark veins between dendrite ferns instead of a solid sheet
    let pa = p * vec2f(asp, 1.0);
    let n1 = fbm(pa * E8.z + u.scene_seed * 7.31);
    let n2 = vnoise(pa * E8.z * 4.3 + u.scene_seed * 3.1);
    var g = 0.08 + 0.92 * smoothstep(0.44, 0.58, n1);   // macro lace
    g *= 0.15 + 0.85 * smoothstep(0.30, 0.62, n2);      // feather serration
    let cellVar = 0.35 + 0.65 * hash12(vec2f(fx, fy) * 1.71 + u.scene_seed * 3.7);
    let prob = min(E0.z * dt * best * g * cellVar, 0.95);
    if (rnd < prob) { dst[idx] = vec2f(0.001, lat); return; }
  }

  dst[idx] = vec2f(0.0);
}
