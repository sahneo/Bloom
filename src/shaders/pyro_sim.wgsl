// PYRO sim — a real 2D fire simulation on a half-res grid (ping-pong storage
// buffers, physarum/frost idiom). Cell = vec2f(temperature, smoke).
//
// Per frame, semi-Lagrangian advection: newT(cell) = T(cell − flow·dt), where
// flow = buoyant upward velocity (scales with local T) + curl-noise lateral
// churn (divergence-free eddies that rise with the gas) + inward convergence
// near the base. Then cooling (stronger higher up + per-cell noise so tongue
// tips shred and tear), a tiny diffusion, and heat injection at the bottom
// from a bed of wandering hot spots. All the licking/churning motion comes
// out of the sim itself — no scrolling noise, no layer compositing.
//
// Grid convention: row 0 = BOTTOM of the screen, p = uv with y up.
//
// Extra region (16 vec4f at RIPPLE_OFFSET) — shared by all pyro pipelines:
//   extra[0] = (gridW, gridH, quiet, 0)
//   extra[1] = (coolMul, windLean, flashover, 0)
//   extra[2] = (tapX, tapY, tapEnv, tapAge)          sim uv, y up
//   extra[3] = (spot0.x, spot0.i, spot1.x, spot1.i)  coal-bed hot spots
//   extra[4] = (spot2.x, spot2.i, spot3.x, spot3.i)
//   extra[5] = (spot4.x, spot4.i, spot5.x, spot5.i)
//   extra[6] = (sparkRate, sparkBurst, glow, energy) sparks + light spill
//   extra[7] = (bedCx, flicker, popEnv, popX)        bed centroid, coal pops

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

@group(0) @binding(0) var<uniform>             u:   Uniforms;
@group(0) @binding(1) var<storage, read>       src: array<vec2f>;
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

fn fbm2(p: vec2f) -> f32 {
  return vnoise(p) * 0.62 + vnoise(p * 2.13 + vec2f(19.1, 7.3)) * 0.38;
}

// divergence-free lateral churn: curl of a scalar noise field
fn curl2(q: vec2f) -> vec2f {
  let e = 0.11;
  let nx1 = fbm2(q + vec2f(e, 0.0));
  let nx2 = fbm2(q - vec2f(e, 0.0));
  let ny1 = fbm2(q + vec2f(0.0, e));
  let ny2 = fbm2(q - vec2f(0.0, e));
  return vec2f(ny1 - ny2, -(nx1 - nx2)) / (2.0 * e);
}

// bilinear sample of the src grid at fractional cell coords
fn sampleSrc(pc: vec2f, gw: i32, gh: i32) -> vec2f {
  let x = clamp(pc.x, 0.0, f32(gw) - 1.001);
  let y = clamp(pc.y, 0.0, f32(gh) - 1.001);
  let x0 = i32(floor(x)); let y0 = i32(floor(y));
  let fx = x - f32(x0);   let fy = y - f32(y0);
  let x1 = min(x0 + 1, gw - 1); let y1 = min(y0 + 1, gh - 1);
  let a = src[u32(y0 * gw + x0)]; let b = src[u32(y0 * gw + x1)];
  let c = src[u32(y1 * gw + x0)]; let d = src[u32(y1 * gw + x1)];
  return mix(mix(a, b, fx), mix(c, d, fx), fy);
}

// gas velocity in uv/s at point p (y up), given the local temperature
fn flowVel(p: vec2f, T: f32, asp: f32, windLean: f32) -> vec2f {
  let t = u.time;
  // eddies travel upward with the gas (the churn field itself rises)
  let q = vec2f(p.x * asp * 4.6, p.y * 3.4 - t * 1.15) + u.scene_seed * 7.1;
  var v = curl2(q) * 0.19 * (0.18 + min(T, 1.2));
  // fine fast wiggle inside the hot column
  v.x += sin(p.y * 26.0 - t * 7.5 + p.x * 15.0) * 0.028 * min(T, 1.0);
  // buoyancy — hotter gas rises faster (this is what makes tongues stretch)
  v.y += 0.04 + min(T, 1.3) * 0.50;
  // inward convergence near the base + wind lean growing with height
  let cx = 0.5 + windLean * 0.15;
  v.x += (cx - p.x) * 0.80 * exp(-p.y * 4.0);
  v.x += windLean * (0.06 + p.y * 0.38);
  return v;
}

@compute @workgroup_size(16, 16)
fn cs_sim(@builtin(global_invocation_id) gid: vec3u) {
  let E0 = u.extra[0];
  let gw = i32(E0.x);
  let gh = i32(E0.y);
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (x >= gw || y >= gh) { return; }
  let idx = u32(y * gw + x);

  let E1 = u.extra[1];
  let coolMul  = E1.x;
  let windLean = E1.y;
  let fo       = E1.z;
  let tap      = u.extra[2];
  let E7       = u.extra[7];
  let asp = u.res_x / max(u.res_y, 1.0);
  let dt  = u.delta;
  let p   = vec2f((f32(x) + 0.5) / f32(gw), (f32(y) + 0.5) / f32(gh));

  // ── semi-Lagrangian advection ─────────────────────────────────────────
  let here = src[idx];
  let vel  = flowVel(p, here.x, asp, windLean);
  let velC = vel * vec2f(f32(gw), f32(gh));
  var c = sampleSrc(vec2f(f32(x), f32(y)) - velC * dt, gw, gh);

  // tiny diffusion — softens pixel noise without blurring the tongues
  let l  = src[u32(y * gw + max(x - 1, 0))];
  let r  = src[u32(y * gw + min(x + 1, gw - 1))];
  let dn = src[u32(max(y - 1, 0) * gw + x)];
  let up = src[u32(min(y + 1, gh - 1) * gw + x)];
  c = mix(c, (l + r + up + dn) * 0.25, 0.05);

  var T = c.x;
  var S = c.y;

  // ── cooling: stronger higher up, per-cell noise shreds the tongue tips ─
  let cn = vnoise(vec2f(p.x * asp * 7.5, p.y * 7.5 - u.time * 1.9) + u.scene_seed * 3.0);
  let coolY = 0.52 + 1.65 * pow(p.y, 1.2);
  let shred = pow(cn, 2.0) * 3.2 * smoothstep(0.04, 0.40, p.y);
  // hotter cells cool faster — keeps the white core small and near the bed
  T -= dt * (coolY + shred) * coolMul * (0.22 + T * 0.95);

  // ── smoke: born where flame cools, decays and drifts up with the flow ──
  let gen = smoothstep(0.05, 0.28, T) * (1.0 - smoothstep(0.45, 0.85, T));
  S = S * exp(-dt * 0.40) + dt * gen * (1.1 + p.y * 1.2);
  S = min(S, 1.3);

  // ── heat injection: bed of wandering hot spots at the bottom ──────────
  var inj = 0.0;
  if (p.y < 0.10) {
    let grain = 0.70 + 0.55 * vnoise(vec2f(p.x * asp * 55.0, u.time * 2.6) + u.scene_seed);
    var bed = 0.0;
    for (var k = 0u; k < 3u; k++) {
      let sp = u.extra[3u + k];
      var dx = (p.x - sp.x) * asp;
      bed += sp.y * exp(-dx * dx / 0.011);
      dx = (p.x - sp.z) * asp;
      bed += sp.w * exp(-dx * dx / 0.011);
    }
    // coal pop flare during quiet passages
    let pdx = (p.x - E7.w) * asp;
    bed += E7.z * 0.6 * exp(-pdx * pdx / 0.004);
    inj = bed * grain * exp(-p.y / 0.032);
  }
  // drop flashover — heat floods a tall column over the whole base; the sim
  // itself produces the engulfing wall, then recovers as fo eases out
  if (fo > 0.004) {
    let fn2 = 0.80 + 0.35 * vnoise(vec2f(p.x * asp * 9.0 - u.time * 2.0, u.time * 3.1));
    inj = max(inj, fo * 1.45 * fn2 * exp(-p.y / (0.06 + fo * 0.75)));
  }
  // tap — mid-air heat burst: the injection centre itself drifts upward as
  // the envelope fades, so the fireball visibly rises, then dissolves
  if (tap.z > 0.02 && tap.w < 1.1) {
    let cy = tap.y + tap.w * 0.22;
    let d = vec2f((p.x - tap.x) * asp, p.y - cy);
    inj = max(inj, tap.z * 2.0 * exp(-dot(d, d) / 0.012));
  }
  T = max(T, min(inj, 1.45));

  dst[idx] = vec2f(clamp(T, 0.0, 1.6), S);
}
