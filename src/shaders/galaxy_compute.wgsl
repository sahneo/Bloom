// GALAXY compute — half a million stars on polar orbits.
// Differential rotation ω(r) = speed/(0.35+r) winds the spiral arms; track
// energy (JS EMA in _r1) is the global speed. A supernova (extra[0]:
// x, z, age, strength) shoves stars radially away from the blast point;
// a weak spring pulls every star back to its home radius afterwards.

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
  a: vec4f,   // r, theta, z, seed
  b: vec4f,   // homeR, pop (0 arm / 1 bulge / 2 halo), armPhase, spare
}

@group(0) @binding(0) var<uniform>             u:     Uniforms;
@group(0) @binding(1) var<storage, read_write> stars: array<Star>;

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= arrayLength(&stars)) { return; }
  var s = stars[idx];
  let dt = clamp(u.delta, 0.0, 0.04);

  var r  = s.a.x;
  var th = s.a.y;

  // supernova shove in the disk plane
  let nova = u.extra[0];
  if (nova.w > 0.01 && nova.z < 3.0) {
    var pos = vec2f(cos(th), sin(th)) * r;
    let dv  = pos - nova.xy;
    let d2  = dot(dv, dv);
    let push = nova.w * exp(-nova.z * 1.8) * exp(-d2 * 1.4) * dt * 2.6;
    pos += (dv + vec2f(1e-4)) / sqrt(max(d2, 1e-6)) * push;
    r  = length(pos);
    th = atan2(pos.y, pos.x);
  }

  // differential rotation, sped up by the track's energy
  th += dt * (0.10 + u._r1 * 0.85) / (0.35 + r);

  // spring back to the home radius (heals the nova wound over ~8 s)
  r += (s.b.x - r) * (1.0 - exp(-dt * 0.30));

  s.a.x = r;
  s.a.y = th;
  stars[idx] = s;
}
