// ABYSS compute — bioluminescent plankton advected by deep-water currents.
// Particles do NOT react to sound with motion (grace discipline: fast events
// are only ever LIGHT). The water flows via curl noise whose amplitude and
// evolution speed follow the smoothed, slew-limited melody energy, so the
// current visibly changes but never twitches. Velocity is eased toward the
// field with a ~0.7 s time constant — everything moves like heavy water.
//
// Repurposed uniform slots (owned by the ABYSS preset):
//   _r2 = current swirl energy 0..1 (JS-side EMA + slew limit)
//   extra[6] = (tapX, tapY, tapEnv, tapAge) — tap = disturbance vortex:
//              tangential eddy + slight indraw, curl locally strengthened
//   extra[7] = (h1x, h1y, h1present, h1grip) — gestMode 2 hands:
//   extra[8] = (h2x, h2y, h2present, h2grip)   palm = current source
//                                              (outflow), fist = suction
//                                              vortex (indraw + spin)
//   extra[9] = (flowTime, —, —, —) — monotonic clock advanced at a rate
//              scaled by swirl energy (phase-continuous flow speed-up)
//
// World coords: y UP, x ∈ [−asp, asp] (+margin), y ∈ [−1, 1] (+margin).

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

struct Particle {
  pos: vec2f,
  vel: vec2f,
}

@group(0) @binding(0) var<uniform>             u:         Uniforms;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;

fn hash21(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let s = f * f * (3.0 - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2f(1.0, 0.0));
  let c = hash21(i + vec2f(0.0, 1.0));
  let d = hash21(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}

// stream function ψ — 2 octaves, domain drifts with the flow clock
fn psi(p: vec2f, ft: f32) -> f32 {
  let q1 = p * 0.85 + vec2f(ft * 0.050, ft * 0.031) + vec2f(u.scene_seed * 13.7);
  let q2 = p * 1.90 + vec2f(-ft * 0.037, ft * 0.043) + vec2f(u.scene_seed * 7.3, 21.9);
  return vnoise(q1) * 0.68 + vnoise(q2) * 0.32;
}

// curl of ψ → divergence-free current (the water can't compress)
fn curl(p: vec2f, ft: f32) -> vec2f {
  let e = 0.16;
  let dx = psi(p + vec2f(e, 0.0), ft) - psi(p - vec2f(e, 0.0), ft);
  let dy = psi(p + vec2f(0.0, e), ft) - psi(p - vec2f(0.0, e), ft);
  return vec2f(dy, -dx) / (2.0 * e);
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= arrayLength(&particles)) { return; }

  var pt  = particles[idx];
  let dt  = clamp(u.delta, 0.0, 0.04);
  let asp = u.res_x / max(u.res_y, 1.0);
  let ft  = u.extra[9].x;                     // flow clock (swirl-scaled)
  let swirl = clamp(u._r2, 0.0, 1.0);

  // ── ambient current: curl noise + a whisper of lateral drift + sink ────
  let tap = u.extra[6];
  let tapRel  = pt.pos - tap.xy;
  let tapD    = length(tapRel);
  let tapNear = tap.z * exp(-tapD * 2.4);     // local curl strengthening

  let amp = 0.045 + swirl * 0.20 + tapNear * 0.30;
  var vt  = curl(pt.pos, ft) * amp;
  vt += vec2f(0.010 + swirl * 0.014, -0.006);  // lateral drift, gentle sink

  // ── tap: disturbance vortex — tangential eddy + slight indraw ──────────
  if (tap.z > 0.005) {
    let safe = max(tapD, 0.04);
    let radial = tapRel / safe;
    let tang   = vec2f(-radial.y, radial.x);
    let fall   = exp(-tapD * 2.4);
    vt += (tang * 0.40 - radial * 0.18) * tap.z * fall;
  }

  // ── hands (gestMode 2): palm = current source, fist = suction vortex ───
  for (var s = 0u; s < 2u; s++) {
    let h = u.extra[7u + s];
    if (h.z < 0.05) { continue; }
    let rel  = pt.pos - h.xy;
    let d    = max(length(rel), 0.05);
    let dir  = rel / d;
    let tang = vec2f(-dir.y, dir.x);
    let fall = exp(-d * 1.7);
    let fist = smoothstep(0.4, 0.75, h.w);
    // palm: water streams outward from the hand; fist: indraw + spin
    vt += dir  * (1.0 - fist) * h.z * fall * 0.11;
    vt += (tang * 0.50 - dir * 0.30) * fist * h.z * fall;
  }

  // gentle brownian dispersal: refills vortex-core voids, keeps the field
  // evenly seeded without visible jitter (smoothed by the inertia below)
  let jx = hash21(pt.pos * 91.7 + vec2f(f32(u.frame) * 0.37, 0.0)) - 0.5;
  let jy = hash21(pt.pos * 47.3 + vec2f(0.0, f32(u.frame) * 0.53)) - 0.5;
  vt += vec2f(jx, jy) * 0.07;

  // ── heavy-water integration: ease velocity toward the field ───────────
  pt.vel += (vt - pt.vel) * (1.0 - exp(-dt / 0.5));
  let spd = length(pt.vel);
  if (spd > 1.2) { pt.vel *= 1.2 / spd; }
  pt.pos += pt.vel * dt;

  // wrap with a margin so particles never pop at the frame edge
  let mx = asp + 0.15;
  if (pt.pos.x >  mx)   { pt.pos.x -= 2.0 * mx; }
  if (pt.pos.x < -mx)   { pt.pos.x += 2.0 * mx; }
  if (pt.pos.y >  1.15) { pt.pos.y -= 2.3; }
  if (pt.pos.y < -1.15) { pt.pos.y += 2.3; }

  particles[idx] = pt;
}
