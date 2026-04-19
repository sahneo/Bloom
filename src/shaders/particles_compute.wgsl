struct Uniforms {
  // row 0
  time:       f32, sub_bass:    f32, bass:      f32, mid:       f32,
  // row 1
  high:       f32, delta:       f32, res_x:     f32, res_y:    f32,
  // row 2
  frame:      f32, mul_sb:      f32, mul_bass:  f32, mul_mid:  f32,
  // row 3
  mul_high:   f32, spring:      f32, kick:      f32, snare:    f32,
  // row 4 — per-band visualization mode (0, 1, 2, ...)
  mode_drums: f32, mode_bass:   f32, mode_lead: f32, mode_atmos: f32,
  // row 5
  mode_pads:  f32, color_mode:  f32, tonality:  f32, pulse:      f32,
  // row 6
  dissonance: f32, dis_strength: f32, _p2:       f32, _p3:        f32,
  // rows 7-14: ripple data — (x, y, age_sec, _) per slot; age<0 = inactive
  ripple_pos_age: array<vec4f, 8>,
  // rows 15-22: ripple colors — (r, g, b, _)
  ripple_color:   array<vec4f, 8>,
}

struct Particle {
  pos:      vec2f,
  vel:      vec2f,
  life:     f32,
  max_life: f32,
  size:     f32,
  band:     f32,
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
  p.pos    = vec2f((rnd(seed) * 2.0 - 1.0) * asp, rnd(seed + 1u) * 2.0 - 1.0);
  p.vel    = vec2f(0.0);
  p.life   = 1.0;
  p.band   = f32(idx % 5u);
  let bi   = idx % 5u;
  if      (bi == 0u) { p.max_life = 40.0 + rnd(seed+2u)*30.0; p.size = 0.008+rnd(seed+3u)*0.007; }
  else if (bi == 1u) { p.max_life = 70.0 + rnd(seed+2u)*50.0; p.size = (0.004+rnd(seed+3u)*0.005) * clamp(u.mul_bass / 3.0, 0.15, 2.2); }
  else if (bi == 2u) { p.max_life = 50.0 + rnd(seed+2u)*40.0; p.size = 0.003+rnd(seed+3u)*0.004; }
  else if (bi == 3u) { p.max_life = 18.0 + rnd(seed+2u)*20.0; p.size = 0.001+rnd(seed+3u)*0.002; }
  else               { p.max_life = 120.0+ rnd(seed+2u)*80.0; p.size = 0.010+rnd(seed+3u)*0.010; }
  return p;
}

fn curl_field(pos: vec2f, t: f32) -> vec2f {
  let a = 1.7; let b = 0.22; let c = 2.1; let d = 0.28;
  let e = 2.4; let g = 0.17; let h = 1.5; let k = 0.21;
  let u1 = -c * sin(a * pos.x + b * t) * sin(c * pos.y + d * t);
  let v1 = -a * cos(a * pos.x + b * t) * cos(c * pos.y + d * t);
  let u2 =  h * cos(e * pos.x + g * t) * cos(h * pos.y + k * t);
  let v2 =  e * sin(e * pos.x + g * t) * sin(h * pos.y + k * t);
  return vec2f(u1 + u2, v1 + v2);
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let idx  = gid.x;
  if (idx >= arrayLength(&particles)) { return; }

  var p    = particles[idx];
  let seed = pcg(idx + u32(u.frame) * 83721u);
  let asp  = u.res_x / u.res_y;
  let band = u32(p.band + 0.5);

  let mode_drums = u32(u.mode_drums + 0.5);
  let mode_bass  = u32(u.mode_bass  + 0.5);
  let mode_lead  = u32(u.mode_lead  + 0.5);
  let mode_atmos = u32(u.mode_atmos + 0.5);
  let mode_pads  = u32(u.mode_pads  + 0.5);

  let spawn_prob = 0.001;
  if (p.life <= 0.0 || (p.life < 0.015 && rnd(seed) < spawn_prob)) {
    particles[idx] = respawn(idx, seed);
    return;
  }

  let dt = clamp(u.delta, 0.0, 0.04);
  let t  = u.time;
  var f  = vec2f(0.0);

  // Weak spring toward center — keeps all particles on screen
  f -= p.pos * u.spring;

  // ── BAND 0: DRUMS ───────────────────────────────────────────────────
  if (band == 0u) {
    if (mode_drums == 0u) {
      // BURST: kick = concentrated radial push near centre; Gaussian keeps force ~0 at edges
      let dc = length(p.pos);
      let falloff = exp(-dc * dc * 5.0); // ≈1 at centre, ≈0.01 at dc=0.7 → no edge pile-up
      f += normalize(p.pos + vec2f(0.0001)) * u.kick  * u.mul_sb * 8.0 * falloff;
      let sdir = normalize(vec2f(rnd(seed^0xA3C5u)*2.0-1.0, rnd(seed^0x5F2Bu)*2.0-1.0) + vec2f(0.0001));
      f += sdir * u.snare * u.mul_sb * 6.0 * falloff;
      // Extra centripetal on top of global spring — snaps drums back to centre
      f -= p.pos * 0.30;

    } else if (mode_drums == 1u) {
      // SHOCKWAVE: expanding ring tied to kick decay; particles get pushed as ring passes
      // When kick=1 (just hit) wave_r=0 (at center). As kick decays wave expands outward.
      let wave_r = (1.0 - u.kick) * 2.8;
      let pdist  = length(p.pos);
      let wave_w = 0.22;
      let ring_d = abs(pdist - wave_r);
      let wave_push = exp(-ring_d * ring_d / (wave_w * wave_w));
      f += normalize(p.pos + vec2f(0.0001)) * u.kick * u.mul_sb * wave_push * 28.0;
      // Snare: inward slam then release
      f -= normalize(p.pos + vec2f(0.0001)) * u.snare * u.mul_sb * 10.0;

    } else {
      // SLAM: kick pulls everything toward center (implosion), snare spins tangentially
      f -= normalize(p.pos + vec2f(0.0001)) * u.kick * u.mul_sb * 18.0;
      let ptang = vec2f(-p.pos.y, p.pos.x) / (length(p.pos) + 0.001);
      let spin_dir = select(-1.0, 1.0, (idx % 2u) == 0u);
      f += ptang * spin_dir * u.snare * u.mul_sb * 12.0;
    }
    // Base ambient so drums don't freeze between hits
    let da = t * 0.09 + f32(idx) * 0.001;
    f += vec2f(cos(da), sin(da)) * 0.04;
  }

  // ── BAND 1: BASS ────────────────────────────────────────────────────
  else if (band == 1u) {
    if (mode_bass == 0u) {
      // RIPPLE: radial standing wave — bass drives amplitude instantly, no travel delay.
      // sin(r*k - wt) is a spatial wave pattern already present everywhere;
      // bass turns up the volume on it so all particles react simultaneously.
      let pdist2 = length(p.pos);
      let wave   = sin(pdist2 * 6.5 - t * 3.8);
      f += normalize(p.pos + vec2f(0.0001)) * u.bass * wave * 33.0;
      let da_r = t * 0.07 + 1.5;
      f += vec2f(cos(da_r), sin(da_r)) * 0.028;

    } else if (mode_bass == 1u) {
      // WELLS: 3 orbiting wells with harmonic restoring force around r0.
      // Repels particles that get too close, attracts from afar → stable orbits, no collapse.
      for (var i = 0u; i < 3u; i++) {
        let angle    = t * 0.20 + f32(i) * 2.094;
        let well_pos = vec2f(cos(angle) * 0.38, sin(angle) * 0.38);
        let to_well  = well_pos - p.pos;
        let dist     = max(length(to_well), 0.001);
        let r0       = 0.13;
        // Cap bass_mod so constant bass signal doesn't freeze particles at equilibrium
        let bass_mod = 0.5 + min(u.bass * 2.1, 1.4);
        // Softer spring — prevents too-rigid lock-in
        let spring_f = (dist - r0) * bass_mod * 3.5;
        f += normalize(to_well) * spring_f;
        // Strong tangential: ensures orbiting even at equilibrium
        let orb_dir = select(-1.0, 1.0, (idx % 2u) == 0u);
        let tang_w  = vec2f(-to_well.y, to_well.x) * orb_dir / dist;
        f += tang_w * (bass_mod * 3.5 + 0.8);
        // Random jitter breaks perfect equilibrium and keeps wells lively
        let jx = rnd(seed ^ (i * 997u  + 1u)) * 2.0 - 1.0;
        let jy = rnd(seed ^ (i * 1337u + 1u)) * 2.0 - 1.0;
        f += vec2f(jx, jy) * 0.14;
      }

    } else if (mode_bass == 2u) {
      // SWELL: sinusoidal flow field. No min-floor: silent = nearly still, bass = big sweeps.
      let bass_str = u.bass;
      let wx = cos(p.pos.y * 1.3 + t * 0.18) * bass_str * 16.5;
      let wy = sin(p.pos.x * 1.1 + t * 0.14) * bass_str * 13.5;
      f += vec2f(wx, wy);
      // Bare minimum drift so particles don't freeze completely
      let da_sw = t * 0.05 + f32(idx % 7u) * 0.9;
      f += vec2f(cos(da_sw), sin(da_sw)) * 0.018;

    } else {
      // RING: speaker-cone membrane. Ring radius = 0 when silent, expands on bass hit.
      // Whole field collapses to center between beats and explodes outward on the beat.
      let bass_str  = u.bass;
      let pdist_r   = length(p.pos);
      let ring_r    = 0.12 + bass_str * 0.90;
      let pull_str  = 4.5 + bass_str * 12.0;
      let ring_pull = (ring_r - pdist_r) * pull_str;
      f += normalize(p.pos + vec2f(0.0001)) * ring_pull;
      let orb_dir = select(-1.0, 1.0, (idx % 2u) == 0u);
      let tangent = vec2f(-p.pos.y, p.pos.x) * orb_dir / (pdist_r + 0.001);
      f += tangent * bass_str * 6.0;
    }
    // Anti-freeze: constant bass signals create equilibrium; this breaks it
    let da_bass = t * 0.11 + f32(idx) * 0.0013;
    f += vec2f(cos(da_bass), sin(da_bass)) * 0.035;
  }

  // ── BAND 2: LEAD SYNTH ──────────────────────────────────────────────
  else if (band == 2u) {
    let mid_str = max(u.mid, 0.05) * u.mul_mid;

    if (mode_lead == 0u) {
      // CURL: divergence-free curl field — persistent vortices
      let cf = curl_field(p.pos * 0.75, t * 0.28);
      f += cf * mid_str * 6.0;
      // Cross-reaction to kick — lead flares on the beat
      f += normalize(p.pos + vec2f(0.0001)) * u.kick * u.mul_mid * 8.0 * exp(-length(p.pos) * 0.8);
      f -= p.pos * 0.06;

    } else if (mode_lead == 1u) {
      // VORTEX: one powerful vortex whose center drifts slowly around screen
      let vcx = sin(t * 0.13) * 0.28 + cos(t * 0.07) * 0.15;
      let vcy = cos(t * 0.17) * 0.22 + sin(t * 0.11) * 0.10;
      let vc       = vec2f(vcx, vcy);
      let from_vc  = p.pos - vc;
      let vdist    = length(from_vc) + 0.001;
      // Tangential spin
      let vtan = vec2f(-from_vc.y, from_vc.x) / vdist;
      f += vtan * mid_str * 6.0 / (vdist + 0.25);
      // Mild pull toward vortex center
      f += normalize(vc - p.pos) * mid_str * 2.0;
      // Kick moves the vortex center abruptly — particles feel centrifugal burst
      f += normalize(p.pos - vc) * u.kick * u.mul_mid * 10.0 * exp(-vdist * 2.0);

    } else {
      // PINBALL: 3 repellers orbit; mid freq energizes them; chaotic trajectories
      for (var i = 0u; i < 3u; i++) {
        let angle  = t * (0.14 + f32(i) * 0.06) + f32(i) * 2.094;
        let rep    = vec2f(cos(angle) * 0.32, sin(angle) * 0.32);
        let from_r = p.pos - rep;
        let rdist  = max(length(from_r), 0.04);
        f += normalize(from_r) * mid_str * 4.0 / (rdist * rdist);
      }
      f -= p.pos * 0.05; // mild centripetal to keep inside screen
    }
  }

  // ── BAND 3: ATMOSPHERE ──────────────────────────────────────────────
  else if (band == 3u) {
    let high_str = u.high * u.mul_high;

    if (mode_atmos == 0u) {
      // SPARKS: irregular burst points — high freq triggers local explosions
      for (var i = 0u; i < 3u; i++) {
        let rate  = 4.0 + f32(i) * 2.0;
        let tick  = u32(t * rate);
        let bseed = pcg(tick * 10007u + i * 997u + idx % 8u);
        let bc    = vec2f((f32(bseed & 0xffffu) / 32767.5 - 1.0) * asp * 0.70,
                           f32(bseed >> 16u)    / 32767.5 - 1.0) * 0.70;
        let phase = fract(t * rate);
        let pulse = exp(-phase * 12.0);
        let bd    = p.pos - bc;
        let bdist = length(bd) + 0.001;
        f += normalize(bd) * high_str * 12.0 * pulse / (bdist + 0.18);
      }
      // Snare cross-reaction
      let sdir2 = normalize(vec2f(rnd(seed^0x9E37u)*2.0-1.0, rnd(seed^0x3B7Fu)*2.0-1.0) + vec2f(0.0001));
      f += sdir2 * u.snare * u.mul_high * 10.0;

    } else if (mode_atmos == 1u) {
      // RAIN: gravity downward; high freq = heavier rain
      let gravity = 1.2 + high_str * 2.5;
      f += vec2f(sin(t * 0.4 + p.pos.y * 1.5) * high_str * 0.4, -gravity);

    } else {
      // STARS: near-stationary brownian motion; high freq = brief twinkle burst
      let bseed2 = pcg(idx ^ u32(t * 6.0));
      let bdir   = normalize(vec2f(f32(bseed2 & 0xffffu)/32767.5-1.0,
                                    f32(bseed2 >> 16u)   /32767.5-1.0) + vec2f(0.0001));
      f += bdir * (0.015 + high_str * 0.4);
    }
    // Base drift when silent
    let da4 = t * 0.17 + f32(idx) * 0.002;
    f += vec2f(cos(da4), sin(da4)) * 0.02;
  }

  // ── BAND 4: PADS ────────────────────────────────────────────────────
  else {
    let sb_str = max(u.sub_bass, 0.02) * u.mul_sb;

    if (mode_pads == 0u) {
      // ROTATE: slow rotation, sub_bass controls speed and gentle expansion
      let angle    = atan2(p.pos.y, p.pos.x);
      let orbit_d  = select(-1.0, 1.0, sin(t * 0.05) > 0.0); // slowly reverses
      let tangent  = vec2f(-sin(angle), cos(angle)) * orbit_d;
      f += tangent * sb_str * 1.8;
      f += normalize(p.pos + vec2f(0.0001)) * u.sub_bass * u.mul_sb * 1.5;

    } else if (mode_pads == 1u) {
      // BREATHE: radial in/out timed to a slow cycle driven by sub_bass
      let breathe   = sin(t * 0.22 + f32(idx % 13u) * 0.48) * 0.5 + 0.5;
      let target_r  = 0.12 + breathe * 0.55;
      let pdist_pb  = length(p.pos);
      let radial    = (target_r - pdist_pb) * 2.0;
      f += normalize(p.pos + vec2f(0.0001)) * radial;
      f += normalize(p.pos + vec2f(0.0001)) * sb_str * 2.5;

    } else {
      // FOG: barely-there brownian drift; almost stationary cloud
      let fseed = pcg(idx ^ u32(t * 0.9));
      let fdir  = normalize(vec2f(f32(fseed & 0xffffu)/32767.5-1.0,
                                   f32(fseed >> 16u)   /32767.5-1.0) + vec2f(0.0001));
      f += fdir * (0.006 + sb_str * 0.12);
    }
    // Base slow drift for all pad modes
    let da5 = t * 0.04 + f32(idx) * 0.0005;
    f += vec2f(cos(da5), sin(da5)) * 0.016;
  }

  // Ripple wave forces — one expanding ring per MIDI note hit
  for (var ri = 0u; ri < 8u; ri++) {
    let rpa   = u.ripple_pos_age[ri];
    let r_age = rpa.z;
    if (r_age < 0.0) { continue; }
    let to_p   = p.pos - rpa.xy;
    let dist   = length(to_p) + 0.001;
    let ring_r = r_age * 0.55;
    let dring  = (dist - ring_r) / 0.15;
    let env    = exp(-r_age * 2.0) * max(0.0, 1.0 - r_age / 2.5);
    let wave   = exp(-dring * dring) * env;
    f += normalize(to_p) * wave * 20.0;
  }

  // Ambient drift when fully silent — all bands stay alive
  let energy  = clamp(u.sub_bass + u.bass + u.mid + u.high + u.kick + u.snare, 0.0, 1.0);
  let silence = max(0.0, 1.0 - energy * 3.0);
  let aseed   = pcg(idx ^ u32(t * 0.35));
  let adir    = normalize(vec2f(f32(aseed & 0xffffu)/32767.5-1.0,
                                 f32(aseed >> 16u)   /32767.5-1.0) + vec2f(0.0001));
  f += adir * silence * 0.06;

  // Per-band drag
  var drag = 4.5;
  if      (band == 0u) { drag = 6.0; }   // drums: high drag so burst snaps back fast
  else if (band == 1u) { drag = 2.8; }
  else if (band == 2u) { drag = 2.5; }
  else if (band == 3u) {
    // Rain mode: lower drag so they actually fall
    drag = select(9.0, 3.5, mode_atmos == 1u);
  }
  else {
    // Pads: high drag (slow drift), fog even higher
    drag = select(7.0, 10.0, mode_pads == 2u);
  }

  p.vel *= exp(-drag * dt);
  p.vel  += f * dt;
  p.pos  += p.vel * dt;
  p.life -= dt / p.max_life;

  // Wrap at screen edges (rain wraps bottom→top naturally)
  if (p.pos.x >  asp + 0.05) { p.pos.x -= 2.0 * asp + 0.1; }
  if (p.pos.x < -asp - 0.05) { p.pos.x += 2.0 * asp + 0.1; }
  if (p.pos.y >  1.05)        { p.pos.y -= 2.1; }
  if (p.pos.y < -1.05)        { p.pos.y += 2.1; }

  particles[idx] = p;
}
