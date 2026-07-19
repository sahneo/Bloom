// REAGENT — Belousov–Zhabotinsky excitable medium on a half-res ping-pong
// grid. Cell = vec2f(u, v): u = fast excitation (the chemical wavefront),
// v = slow recovery (the refractory wake). Barkley-form kinetics with the
// two timescales pulled apart so the front spans a few grid cells:
//   du/dt = Du·∇²u + ku·u(1−u)(u − (v+b)/a)
//   dv/dt = Dv·∇²v + kv·(u − v)
// b is the excitation threshold — LOW b = hungry dish (fat fast waves),
// HIGH b = barely-excitable filigree. Waves annihilate head-on (each
// front dies in the other's refractory wake) and a BROKEN front curls at
// its free ends into a pair of counter-rotating spirals — the canonical
// BZ spiral regime. Explicit Euler, unconditionally bounded by clamping
// u,v to [0,1] (the cubic pushes inward at both rails).
// cs_seed runs once per frame: copies src→dst and stamps excitation
// shapes (kick rings, snare arcs, spiral segments, tap, hands, drop
// wall, high-band sparkle). cs_step = one reaction–diffusion substep,
// dispatched N times per frame (N = wave speed).
// Extra slots (offset RIPPLE_OFFSET, 16 × vec4f):
//   extra[0] = (gridW, gridH, dtSub, b)
//   extra[1] = (a, ku, kv, noiseRate)
//   extra[2..4] = seed slots (x, y, angle, code)  canvas UV, y down
//                 code 0=off 1=small disc 2=big disc 3=spiral segment
//                 (excite strip + one-sided refractory shadow) 4=thin arc
//   extra[5] = (wallPos, wallActive, wipe, Dv)   drop sweep, wallPos UV x
//   extra[6] = (hand0 x, y, palm, fist)  palm = pacemaker source,
//   extra[7] = (hand1 x, y, palm, fist)  fist = local inhibitor (u→0,v→1)
//   extra[8] = (frameRand, quiet, tension, 0)
//   extra[9] = (kickEnv, snareEnv, dropFlash, tapEnv)   render accents

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

// clamped read = no-flux (Neumann) boundary; waves meet the dish edge and die
fn C(x: i32, y: i32, gw: i32, gh: i32) -> vec2f {
  return src[u32(clamp(y, 0, gh - 1) * gw + clamp(x, 0, gw - 1))];
}

// ── one reaction–diffusion substep ────────────────────────────────────
@compute @workgroup_size(16, 16)
fn cs_step(@builtin(global_invocation_id) gid: vec3u) {
  let E0 = u.extra[0];
  let gw = i32(E0.x);
  let gh = i32(E0.y);
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (x >= gw || y >= gh) { return; }
  let idx = u32(y * gw + x);

  let dt = E0.z;
  let b  = E0.w;
  let E1 = u.extra[1];
  let a  = E1.x;
  let ku = E1.y;
  let kv = E1.z;
  let dv = u.extra[5].w;

  let c = src[idx];
  // 9-point Laplacian (isotropic — spirals stay round, not square)
  let lap = (C(x, y - 1, gw, gh) + C(x, y + 1, gw, gh)
           + C(x - 1, y, gw, gh) + C(x + 1, y, gw, gh)) * 0.2
          + (C(x - 1, y - 1, gw, gh) + C(x + 1, y - 1, gw, gh)
           + C(x - 1, y + 1, gw, gh) + C(x + 1, y + 1, gw, gh)) * 0.05
          - c;

  let uu = c.x;
  let vv = c.y;
  let uth = (vv + b) / a;
  let nu = uu + (lap.x        + ku * uu * (1.0 - uu) * (uu - uth)) * dt;
  let nv = vv + (lap.y * dv   + kv * (uu - vv)) * dt;
  dst[idx] = clamp(vec2f(nu, nv), vec2f(0.0), vec2f(1.0));
}

// ── per-frame seeding / stamping pass (also the ping-pong copy) ───────
@compute @workgroup_size(16, 16)
fn cs_seed(@builtin(global_invocation_id) gid: vec3u) {
  let E0 = u.extra[0];
  let gw = i32(E0.x);
  let gh = i32(E0.y);
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (x >= gw || y >= gh) { return; }
  let idx = u32(y * gw + x);
  let fx = f32(x); let fy = f32(y);
  let px = (fx + 0.5) / f32(gw);
  let py = (fy + 0.5) / f32(gh);
  let asp = u.res_x / max(u.res_y, 1.0);

  var c = src[idx];
  let E1 = u.extra[1];
  let E8 = u.extra[8];

  // high-band sparkle: single-cell micro-excitations. Mostly subcritical
  // (they glimmer and die); when bass has the dish hungry they can ignite.
  if (E1.w > 0.0) {
    let rnd = hash12(vec2f(fx, fy) + E8.x);
    if (rnd < E1.w && c.y < 0.30 && c.x < 0.35) { c.x = max(c.x, 0.50); }
  }

  // generic seed slots (kick ring / tap / snare arc / spiral segment)
  for (var i = 0u; i < 3u; i++) {
    let S = u.extra[2u + i];
    if (S.w < 0.5) { continue; }
    let rel = vec2f(fx - S.x * f32(gw), fy - S.y * f32(gh));
    if (S.w < 1.5) {                                  // small disc → ring
      if (dot(rel, rel) < 20.0) { c = vec2f(1.0, min(c.y, 0.15)); }
    } else if (S.w < 2.5) {                           // big disc → fat ring
      if (dot(rel, rel) < 46.0) { c = vec2f(1.0, min(c.y, 0.15)); }
    } else {
      let dir = vec2f(cos(S.z), sin(S.z));
      let along = dot(rel, dir);
      let perp  = dot(rel, vec2f(-dir.y, dir.x));
      if (S.w < 3.5) {
        // spiral segment: excited strip, refractory shadow on ONE side —
        // the front can only run the other way; its free ends curl into
        // a pair of counter-rotating spiral cores
        if (abs(along) < 26.0 && abs(perp) < 2.0) { c = vec2f(1.0, min(c.y, 0.10)); }
        else if (abs(along) < 32.0 && perp > 2.0 && perp < 16.0) { c = vec2f(0.0, max(c.y, 0.88)); }
      } else {
        // thin arc: fires both directions → an expanding lens (snare)
        if (abs(along) < 42.0 && abs(perp) < 1.6) { c = vec2f(1.0, min(c.y, 0.20)); }
      }
    }
  }

  // hands: open palm = held pacemaker (emits rings at the dish's natural
  // frequency), fist = inhibitor (u killed, v saturated — carves black)
  for (var h = 0u; h < 2u; h++) {
    let H = u.extra[6u + h];
    let d = vec2f((H.x - px) * asp, H.y - py);
    let r = length(d);
    if (H.z > 0.05 && r < 0.032) { c = vec2f(1.0, min(c.y, 0.2)); }
    if (H.w > 0.05 && r < 0.045 + 0.05 * H.w) { c = vec2f(0.0, 1.0); }
  }

  // drop wall: a plane of excitation sweeps left→right; everything behind
  // it is wiped to blank refractory medium — the old pattern is erased and
  // new chemistry self-organizes in the wake
  let W = u.extra[5];
  if (W.y > 0.5) {
    if (px < W.x - 0.014) { c = vec2f(0.0, max(c.y, 0.92 * W.z)); }
    else if (abs(px - W.x) <= 0.014) { c = vec2f(1.0, min(c.y, 0.25)); }
  }

  dst[idx] = clamp(c, vec2f(0.0), vec2f(1.0));
}
