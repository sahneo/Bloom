// GALAXY compute — differential orbital rotation, density-wave arm herding,
// and supernova radial displacement with a spring back to the home orbit.
//
// Star state is polar: (r home radius, theta angle, z thickness, seed) plus a
// cartesian displacement (dx,dz + vx,vz) used only by the supernova shockwave.
// Inner stars orbit faster (omega = base/(0.4+r)) which shears the disk; a
// gentle pull toward the nearest arm of a rigidly-rotating log-spiral pattern
// balances that shear so the arms stay readable forever (density-wave style)
// while individual stars visibly stream through them.
//
// Repurposed uniform slots (this preset owns its uniform buffer):
//   _r1 = rotation speed multiplier (JS energy EMA)
//   extra[0] = (patternRot, numArms, shimmerArm, cameraAzimuth)
//   extra[1] = (novaX, novaZ, novaAge, novaStrength)

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

struct Star {
  r:     f32,   // home orbital radius
  theta: f32,   // current angle
  z:     f32,   // vertical (disk thickness) offset, static
  seed:  f32,   // per-star random 0..1 (also selects field vs arm population)
  dx:    f32,   // nova displacement, galaxy plane
  dz:    f32,
  vx:    f32,   // nova displacement velocity
  vz:    f32,
}

@group(0) @binding(0) var<uniform>             u:     Uniforms;
@group(0) @binding(1) var<storage, read_write> stars: array<Star>;

const TAU:   f32 = 6.28318530;
const PITCH: f32 = 0.36;          // log-spiral pitch (tan of pitch angle)
const HALO_END:   u32 = 72000u;   // bulge+halo below this index (no herding)
const GLOW_START: u32 = 399740u;  // core-glow + nova sprites: static, skipped

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rnd(seed: u32) -> f32 { return f32(pcg(seed)) / 4294967295.0; }

fn spiral_theta(r: f32) -> f32 { return log(max(r, 0.04)) / PITCH; }

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= arrayLength(&stars) || idx >= GLOW_START) { return; }

  var s  = stars[idx];
  let dt = clamp(u.delta, 0.0, 0.04);
  let speed = max(u._r1, 0.05);

  // ── differential rotation: inner stars orbit faster ───────────────────
  let omega = 0.14 / (0.4 + s.r);
  s.theta += omega * speed * dt;

  // per-star jitter keeps the arms fuzzy-alive instead of frozen
  let seed = pcg(idx * 7919u + u32(u.frame));
  s.theta += (rnd(seed) - 0.5) * dt * 0.05;

  // ── density-wave herding (disk stars only) ─────────────────────────────
  // Pull toward the nearest arm of the rigid spiral pattern. Equilibrium
  // between this pull and the rotational shear gives naturally fuzzy arms;
  // stars with seed < 0.25 barely herd and form the inter-arm field.
  if (idx >= HALO_END) {
    let n_arms = max(u.extra[0].y, 1.0);
    let p      = (s.theta - u.extra[0].x - spiral_theta(s.r)) * n_arms;
    let dwrap  = p - TAU * round(p / TAU);
    var herd   = mix(0.15, 0.85, clamp((s.seed - 0.25) / 0.75, 0.0, 1.0));
    if (s.seed < 0.25) { herd = s.seed * 0.1; }
    s.theta -= (dwrap / n_arms) * herd * dt;
  }

  // ── supernova shockwave: radial impulse from the blast point ──────────
  let nova = u.extra[1];   // (x, z, age, strength)
  if (nova.w > 0.002) {
    let base = vec2f(s.r * cos(s.theta), s.r * sin(s.theta)) + vec2f(s.dx, s.dz);
    let dvec = base - nova.xy;
    let d2   = dot(dvec, dvec);
    let dir  = dvec / sqrt(max(d2, 1e-5));
    // hard shove for ~0.15 s, 1/(1+d^2) falloff across the disk
    let blast = 6.0 * exp(-nova.z * 7.0) / (1.0 + d2 * 4.0);
    s.vx += dir.x * blast * dt;
    s.vz += dir.y * blast * dt;
  }

  // displaced stars drift home: weak spring + drag → the galaxy heals ~8 s
  s.vx -= s.dx * 0.35 * dt;
  s.vz -= s.dz * 0.35 * dt;
  let damp = exp(-dt * 0.9);
  s.vx *= damp;
  s.vz *= damp;
  s.dx += s.vx * dt;
  s.dz += s.vz * dt;

  stars[idx] = s;
}
