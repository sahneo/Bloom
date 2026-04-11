struct Uniforms {
  time:     f32,
  sub_bass: f32,
  bass:     f32,
  mid:      f32,
  high:     f32,
  delta:    f32,
  res_x:    f32,
  res_y:    f32,
  frame:    f32,
  _p0: f32, _p1: f32, _p2: f32,
}

struct Particle {
  pos:  vec2f,
  vel:  vec2f,
  life: f32,
  max_life: f32,
  size: f32,
  _pad: f32,
}

@group(0) @binding(0) var<uniform>             u: Uniforms;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rnd(seed: u32) -> f32 { return f32(pcg(seed)) / 4294967295.0; }

fn respawn(idx: u32, seed: u32) -> Particle {
  var p: Particle;
  let asp  = u.res_x / u.res_y;
  // Scatter uniformly across the entire screen
  p.pos      = vec2f((rnd(seed)      * 2.0 - 1.0) * asp,
                      rnd(seed + 1u) * 2.0 - 1.0);
  p.vel      = vec2f(0.0);
  p.life     = 1.0;
  p.max_life = 50.0 + rnd(seed + 2u) * 50.0;  // 50-100 seconds
  p.size     = 0.003 + rnd(seed + 3u) * 0.004;
  return p;
}

// Vortex force: swirls particles around center c
fn vortex(pos: vec2f, c: vec2f, strength: f32) -> vec2f {
  let d     = pos - c;
  let dist2 = dot(d, d);
  let perp  = vec2f(-d.y, d.x);
  return perp * strength / (dist2 + 0.08);
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= arrayLength(&particles)) { return; }

  var p    = particles[idx];
  let seed = pcg(idx + u32(u.frame) * 83721u);
  let asp  = u.res_x / u.res_y;

  // Rarely respawn: only when dead or very near end of life
  let spawn_prob = 0.001 + (u.sub_bass + u.bass) * 0.004;
  if (p.life <= 0.0 || (p.life < 0.015 && rnd(seed) < spawn_prob)) {
    particles[idx] = respawn(idx, seed);
    return;
  }

  let dt = clamp(u.delta, 0.0, 0.04);
  var f  = vec2f(0.0);

  // --- SUB-BASS: global tremble + slow drift ---
  // Each particle has a unique tremble direction that updates slowly
  let tseed = pcg(idx ^ u32(u.time * 4.0));
  let tdir  = normalize(vec2f(f32(tseed & 0xffffu) / 32767.5 - 1.0,
                               f32(tseed >> 16u)    / 32767.5 - 1.0) + vec2f(0.0001));
  f += tdir * u.sub_bass * 5.0;

  // Shared slow directional drift (direction rotates very slowly)
  let drift_ang = u.time * 0.07;
  f += vec2f(cos(drift_ang), sin(drift_ang)) * u.sub_bass * 1.8;

  // --- MID: moving vortices — direction slowly reverses per vortex ---
  let t   = u.time;
  // sin() oscillates -1..+1 at different rates → each vortex flips independently
  let d1  = sin(t * 0.07);
  let d2  = sin(t * 0.05 + 2.09);
  let d3  = sin(t * 0.09 + 4.18);
  let v1  = vec2f(sin(t * 0.21) * 0.7 * asp, cos(t * 0.17) * 0.55);
  let v2  = vec2f(cos(t * 0.18 + 2.09) * 0.65 * asp, sin(t * 0.23) * 0.6);
  let v3  = vec2f(sin(t * 0.14 + 4.18) * 0.8 * asp, cos(t * 0.19 + 1.0) * 0.5);
  f += vortex(p.pos, v1, u.mid * 0.55) * d1;
  f += vortex(p.pos, v2, u.mid * 0.45) * d2;
  f += vortex(p.pos, v3, u.mid * 0.50) * d3;

  // --- HIGH: wide radial bursts — wide enough to form visible waves ---
  let h1_ang    = t * 0.73;
  let h1_center = vec2f(cos(h1_ang) * 0.35 * asp, sin(h1_ang * 0.8) * 0.3);
  let h1_d      = p.pos - h1_center;
  let h1_dist   = length(h1_d);
  f += normalize(h1_d + vec2f(0.0001)) * u.high * 14.0 * exp(-h1_dist * h1_dist * 0.7);

  let h2_ang    = t * 0.61 + 2.09;
  let h2_center = vec2f(sin(h2_ang) * 0.45 * asp, cos(h2_ang * 0.9) * 0.35);
  let h2_d      = p.pos - h2_center;
  let h2_dist   = length(h2_d);
  f += normalize(h2_d + vec2f(0.0001)) * u.high * 10.0 * exp(-h2_dist * h2_dist * 0.9);

  // --- BASS PULSE: radial burst from center on beat ---
  let dist_c = length(p.pos);
  f += normalize(p.pos + vec2f(0.0001)) * u.bass * 10.0 * exp(-dist_c * dist_c * 0.6);

  // --- AMBIENT DRIFT: barely visible slow motion when audio is silent ---
  let energy  = clamp(u.sub_bass + u.bass + u.mid + u.high, 0.0, 1.0);
  let silence = 1.0 - energy;
  let aseed   = pcg(idx ^ u32(u.time * 0.4));  // direction changes every ~2.5s
  let adir    = normalize(vec2f(f32(aseed & 0xffffu) / 32767.5 - 1.0,
                                 f32(aseed >> 16u)    / 32767.5 - 1.0) + vec2f(0.0001));
  f += adir * silence * 0.12;

  // Low drag — particles hold momentum between beats
  p.vel *= exp(-1.8 * dt);

  p.vel  += f * dt;
  p.pos  += p.vel * dt;
  p.life -= dt / p.max_life;

  // Wrap around edges
  if (p.pos.x >  asp + 0.05) { p.pos.x -= 2.0 * asp + 0.1; }
  if (p.pos.x < -asp - 0.05) { p.pos.x += 2.0 * asp + 0.1; }
  if (p.pos.y >  1.05)       { p.pos.y -= 2.1; }
  if (p.pos.y < -1.05)       { p.pos.y += 2.1; }

  particles[idx] = p;
}
