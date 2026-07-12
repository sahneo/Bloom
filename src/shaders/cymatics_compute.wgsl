// CYMATICS compute — Chladni-plate sand physics.
// Grains are pulled toward the nodal lines (P = 0) of a vibrating plate:
//   P(x,y) = cos(nπx)·cos(mπy) − cos(mπx)·cos(nπy)
// Force = −∇(P²)·k (analytic gradient). Two (n,m) pairs are crossfaded so the
// figure MORPHS as the music changes. Kick = plate strike (radial scatter),
// snare = high-frequency shake, antinode agitation keeps lines alive.
//
// Repurposed uniform slots (this preset owns its uniform buffer):
//   _r1 = pattern crossfade 0..1     _r2 = strike envelope (kick/drop)
//   _r3 = shake envelope (snare)     extra[0] = (nA, mA, nB, mB)

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

struct Grain {
  pos: vec2f,
  vel: vec2f,
}

@group(0) @binding(0) var<uniform>             u:      Uniforms;
@group(0) @binding(1) var<storage, read_write> grains: array<Grain>;

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rnd(seed: u32) -> f32 { return f32(pcg(seed)) / 4294967295.0; }

const PI: f32 = 3.14159265;

// Returns (P, dP/dx, dP/dy) in plate coordinates, normalized so the force
// scale is comparable across (n,m) pairs (gradient grows with mode number).
fn chladni(p: vec2f, n: f32, m: f32) -> vec3f {
  let nx = n * PI * p.x;
  let my = m * PI * p.y;
  let mx = m * PI * p.x;
  let ny = n * PI * p.y;
  let cnx = cos(nx); let cmy = cos(my);
  let cmx = cos(mx); let cny = cos(ny);
  let P    = cnx * cmy - cmx * cny;
  let dPdx = -n * PI * sin(nx) * cmy + m * PI * sin(mx) * cny;
  let dPdy = -m * PI * cnx * sin(my) + n * PI * cmx * sin(ny);
  let norm = 1.0 / (PI * max(n, m));           // mode-independent force scale
  return vec3f(P, dPdx * norm, dPdy * norm);
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= arrayLength(&grains)) { return; }

  var g    = grains[idx];
  let dt   = clamp(u.delta, 0.0, 0.04);
  let asp  = u.res_x / u.res_y;
  let seed = pcg(idx + u32(u.frame) * 83721u);

  // ── world → plate coordinates (slow drift offset + rotation) ─────────
  // The plate itself turns continuously — the whole figure slowly rotates,
  // so even a settled pattern is never a still image.
  let rot = u.drift_rot + u.time * 0.05;
  let c   = vec2f(u.drift_x, u.drift_y) * 0.5;
  let ct  = cos(rot);
  let st  = sin(rot);
  let rel = g.pos - c;
  let q   = vec2f(ct * rel.x + st * rel.y, -st * rel.x + ct * rel.y);
  let p   = vec2f(q.x / asp, q.y);

  // ── Chladni force: two patterns crossfaded ────────────────────────────
  let pat = u.extra[0];                        // (nA, mA, nB, mB)
  let cf  = clamp(u._r1, 0.0, 1.0);
  let ca  = chladni(p, pat.x, pat.y);
  let cb  = chladni(p, pat.z, pat.w);

  // plate vibration amplitude from the music — louder music = faster migration
  let amp = 0.35 + u.bass * 1.0 + u.sub_bass * 0.4 + u.mid * 0.6 + u.high * 0.3;

  // F = −P·∇P per pattern, blended. Kept quasi-overdamped vs. the drag below
  // so grains settle ONTO the nodal lines instead of oscillating across them.
  let fa = -ca.x * ca.yz;
  let fb = -cb.x * cb.yz;
  var fp = mix(fa, fb, cf) * amp * 16.0;       // force in plate space

  // plate → world (undo aspect scale, redo rotation)
  let fq = vec2f(fp.x / asp, fp.y);
  var f  = vec2f(ct * fq.x - st * fq.y, st * fq.x + ct * fq.y);

  // ── tangential flow: sand streams ALONG the nodal lines ───────────────
  // The line direction is perpendicular to ∇P (P changes sign across the
  // line). A steady circulation makes settled figures visibly alive —
  // rivers of sand — with speed riding the melody bands.
  let gblend = mix(ca.yz, cb.yz, cf);
  let Pblend = mix(ca.x, cb.x, cf);
  let glen   = length(gblend);
  if (glen > 0.001) {
    let tangent = vec2f(-gblend.y, gblend.x) / glen;
    let online  = 1.0 / (1.0 + abs(Pblend) * 9.0);       // 1 on the line
    let flow_p  = tangent * online * (0.5 + u.mid * u.mul_mid * 1.6 + u.high * 0.8);
    // plate → world for the flow too
    let flow_q  = vec2f(flow_p.x / asp, flow_p.y);
    f += vec2f(ct * flow_q.x - st * flow_q.y, st * flow_q.x + ct * flow_q.y);
  }

  // ── antinode agitation: sand bounces where the plate moves (|P| large) ─
  let absP = mix(abs(ca.x), abs(cb.x), cf) * 0.5;   // 0..1
  let jdir = normalize(vec2f(rnd(seed ^ 0x9E37u) * 2.0 - 1.0,
                             rnd(seed ^ 0x3B7Fu) * 2.0 - 1.0) + vec2f(0.0001));
  f += jdir * (0.02 + absP * amp * 0.5);

  // ── kick / drop: plate strike — violent scatter, then swing BACK ──────
  // Modelled as one damped plate oscillation: radial force flips sign as the
  // strike ages (cos), so the net impulse is ~zero and sand returns to the
  // figure instead of being pumped to the screen edges kick after kick.
  let strike = u._r2;
  if (strike > 0.003) {
    let age   = u.extra[1].x;                  // seconds since the strike
    let osc   = cos(age * 26.0);
    let rdir  = normalize(rel + vec2f(0.0001));
    let sdir  = normalize(vec2f(rnd(seed ^ 0xA3C5u) * 2.0 - 1.0,
                                rnd(seed ^ 0x5F2Bu) * 2.0 - 1.0) + vec2f(0.0001));
    // stronger near the strike point, but the whole plate jumps
    let fall = 0.45 + 0.55 * exp(-dot(rel, rel) * 1.6);
    f += (rdir * 0.85 * osc + sdir * 0.35) * strike * 95.0 * fall;
  }

  // ── snare: brief high-frequency shake ────────────────────────────────
  let shake = u._r3;
  if (shake > 0.003) {
    let hseed = pcg((idx ^ u32(u.time * 47.0)) * 2654435761u);
    let hdir  = normalize(vec2f(f32(hseed & 0xffffu) / 32767.5 - 1.0,
                                f32(hseed >> 16u)    / 32767.5 - 1.0) + vec2f(0.0001));
    f += hdir * shake * 35.0;
  }

  // build-up tension: plate hums harder — grains tremble, pattern tightens
  f += jdir * u.tension * 1.2;
  f -= rel * u.tension * 0.4;

  // whisper-weak centering: counters residual outward diffusion from strikes
  f -= rel * 0.06;

  // ── integrate (quasi-overdamped: v ≈ F/drag → clean settling) ─────────
  let drag = 12.0;
  g.vel *= exp(-drag * dt);
  g.vel += f * dt;
  let spd = length(g.vel);
  if (spd > 9.0) { g.vel *= 9.0 / spd; }
  g.pos += g.vel * dt;

  // wrap at screen bounds — P is exactly periodic over the visible plate
  // (period 2 in plate coords = one screen), so wrapping is seamless and
  // the edges never become an energy sink that drains sand from the figure
  if (g.pos.x >  asp) { g.pos.x -= 2.0 * asp; }
  if (g.pos.x < -asp) { g.pos.x += 2.0 * asp; }
  if (g.pos.y >  1.0) { g.pos.y -= 2.0; }
  if (g.pos.y < -1.0) { g.pos.y += 2.0; }

  grains[idx] = g;
}
