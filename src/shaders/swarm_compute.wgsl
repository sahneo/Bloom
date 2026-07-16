// SWARM compute — starling murmuration boids in 3D.
// ~25k birds; classic separation/alignment/cohesion approximated with
// STOCHASTIC neighbours (12 pseudo-random others per frame, gaussian
// distance weighting) — indistinguishable from true boids at flock scale.
// A wander target steers the flock as one body; a swirl field folds it
// internally. Kick = predator strike (radial explosion from a point near
// the flock heart), drop = the flock splits in two, snare = alignment snap.
//
// Repurposed uniform slots (this preset owns its uniform buffer):
//   _r1 = strike envelope    _r2 = restlessness (mid/high EMA)
//   _r3 = snare align surge
//   extra[0].xyz = target A   extra[1].xyz = target B  extra[1].w = split
//   extra[2].xyz = strike point   extra[2].w = strike age (s)
//
// HANDS gesture mode — each webcam hand is a live predator (falcon) in the
// flock. Per hand slot s in {0,1}, base = 3 + s*3:
//   extra[base+0].xyz = world point on the hand's view ray at flock depth
//   extra[base+0].w   = presence gate 0..1 (0 ⇒ slot fully inert)
//   extra[base+1].xyz = view-ray direction (unit)   .w = grip (fist) 0..1
//   extra[base+2].xyz = hand world velocity          .w = strike envelope
//   extra[9].x / .y   = fist-clench burst impulse for slot 0 / 1
// All hand slots are zero unless the preset is in HANDS mode, so this block
// costs one branch per slot and the flock behaves exactly as before.

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

struct Boid {
  pos: vec4f,   // xyz + per-boid hash in w
  vel: vec4f,   // xyz + unused
}

@group(0) @binding(0) var<uniform>             u:     Uniforms;
@group(0) @binding(1) var<storage, read_write> boids: array<Boid>;

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rnd(seed: u32) -> f32 { return f32(pcg(seed)) / 4294967295.0; }

fn safeN(v: vec3f) -> vec3f { return normalize(v + vec3f(1e-4, 2e-4, -1e-4)); }

fn clampLen(v: vec3f, m: f32) -> vec3f {
  let l = length(v);
  if (l > m) { return v * (m / l); }
  return v;
}

// Cheap incommensurate-sine swirl field — folds the flock's interior so the
// body has flowing internal structure instead of being a uniform gas cloud.
fn swirl(p: vec3f, t: f32) -> vec3f {
  return vec3f(
    sin(p.y * 3.1 + t * 0.7) + sin(p.z * 2.3 - t * 0.53),
    sin(p.z * 2.9 + t * 0.61) + sin(p.x * 2.1 + t * 0.41),
    sin(p.x * 2.7 - t * 0.57) + sin(p.y * 1.9 + t * 0.47)) * 0.5;
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  let n   = arrayLength(&boids);
  if (idx >= n) { return; }

  var b    = boids[idx];
  let dt   = clamp(u.delta, 0.0, 0.04);
  let pos  = b.pos.xyz;
  var vel  = b.vel.xyz;
  let hash = b.pos.w;
  let restless = u._r2;

  // ── stochastic boids: 12 pseudo-random flockmates this frame ──────────
  var sep  = vec3f(0.0);
  var ali  = vec3f(0.0);
  var coh  = vec3f(0.0);
  var wsum = 0.0;
  let sbase = pcg(idx ^ (u32(u.frame) * 2654435761u));
  for (var k = 0u; k < 12u; k++) {
    let j = pcg(sbase + k * 7919u) % n;
    if (j == idx) { continue; }
    let o  = boids[j];
    let d  = o.pos.xyz - pos;
    let d2 = dot(d, d);
    sep -= d * exp(-d2 * 40.0);            // personal space ~0.16
    let w = exp(-d2 * 9.0);                // social radius ~0.33
    ali += o.vel.xyz * w;
    coh += d * w;
    wsum += w;
  }

  let cruise = 0.42 + restless * 0.30;
  var f = sep * 14.0;
  if (wsum > 0.005) {
    // alignment steers toward the neighbours' mean heading at cruise speed;
    // snare surge multiplies it — a shiver of coordination runs through
    let desired = safeN(ali) * cruise;
    f += (desired - vel) * (2.0 + u._r3 * 5.0);
    // cohesion toward the weighted local centre
    f += (coh / max(wsum, 0.05)) * (0.95 + u._r3 * 1.0) * min(wsum * 2.0, 1.0);
  }

  // ── follow the wander target (split: hash picks flock A or B) ─────────
  let tA  = u.extra[0].xyz;
  let tB  = u.extra[1].xyz;
  let tgt = select(tA, tB, hash > 0.5);
  let to  = tgt - pos;
  let tl  = length(to);
  f += (to / max(tl, 0.001)) * (0.45 + tl * 0.55);

  // ── internal folding: swirl field rides the melody bands (spatial freq
  // above the flock diameter so it folds the body instead of shoving it)
  f += swirl(pos * 2.6, u.time * 0.5) * (0.32 + u.mid * u.mul_mid * 1.0 + u.high * 0.5);

  // per-boid wiggle — individuals are never perfectly obedient
  let jdir = safeN(vec3f(rnd(sbase ^ 0x9E37u), rnd(sbase ^ 0x3B7Fu), rnd(sbase ^ 0x715Eu)) * 2.0 - 1.0);
  f += jdir * 0.22;

  // soft containment box (camera at origin looking +z)
  let bmin = vec3f(-1.15, -0.70, 1.50);
  let bmax = vec3f( 1.15,  0.70, 3.40);
  f += (max(bmin - pos, vec3f(0.0)) - max(pos - bmax, vec3f(0.0))) * 6.0;

  // turn-rate limit: birds can't turn on a dime — busy music turns faster
  f = clampLen(f, 4.0 + restless * 4.0 + u._r3 * 4.0);

  // ── predator strike (kick / drop): explode away from the strike point ─
  // applied AFTER the clamp — terror overrides aerodynamics
  if (u._r1 > 0.01) {
    let sd   = pos - u.extra[2].xyz;
    let dl   = length(sd);
    let fall = exp(-dl * 1.6);           // local: a hole torn into the flock
    f += (sd / max(dl, 0.04)) * u._r1 * 22.0 * fall;
    f += jdir * u._r1 * 7.0 * fall;
  }

  // ── hand predators (HANDS mode): a hand is a falcon in the flock ──────
  // Distance is measured to the hand's VIEW RAY (a screen point covers all
  // depths), so the reaction reads exactly where the hand is on screen.
  // Also post-clamp: fleeing a predator overrides aerodynamics.
  var fear = 0.0;
  for (var hs = 0u; hs < 2u; hs++) {
    let hp   = u.extra[3u + hs * 3u];             // ray point, w = presence
    let pres = hp.w;
    if (pres < 0.003) { continue; }
    let hd   = u.extra[4u + hs * 3u];             // ray dir,   w = grip
    let hv   = u.extra[5u + hs * 3u];             // hand vel,  w = strike env

    let rel    = pos - hp.xyz;
    let radial = rel - hd.xyz * dot(rel, hd.xyz); // offset ⊥ to the view ray
    let rl     = length(radial);
    let rdir   = radial / max(rl, 0.03);

    // open hand hovering: soft exclusion — the flock keeps a respectful
    // distance and slides around the hand like around a drifting hawk shadow
    let hover = exp(-rl * rl * 12.0) * pres;
    f += rdir * hover * 2.2;
    let slide = vel - rdir * dot(vel, rdir);      // keep moving, but sideways
    f += safeN(slide) * hover * 1.6;

    // fast hand = STRIKE: panic scatter away from the ray, biased along the
    // hand's direction of travel — the stoop tears a wake through the flock
    let strike = hv.w * pres;
    if (strike > 0.01) {
      let fall = exp(-rl * 1.5);
      let hdir = hv.xyz / max(length(hv.xyz), 1e-3);
      f += (rdir * 13.0 + hdir * 11.0) * strike * fall;
      f += jdir * strike * 6.0 * fall;            // panic breaks formation
      fear = max(fear, strike * fall);
    }

    // fist = the predator grabs: hard exclusion core + tangential swirl —
    // boids caught near the fist spiral outward in a tight panic vortex
    let grip = hd.w * pres;
    if (grip > 0.02) {
      let fall = exp(-rl * rl * 12.0);
      f += (rdir * 8.0 + cross(hd.xyz, rdir) * 9.0) * grip * fall;
      fear = max(fear, grip * fall * 0.6);
    }
    // clench moment: one burst ring blown outward from the grab point
    let burst = select(u.extra[9].y, u.extra[9].x, hs == 0u) * pres;
    if (burst > 0.01) {
      let fall = exp(-rl * 1.8);
      f += (rdir * 18.0 + jdir * 7.0) * burst * fall;
      fear = max(fear, burst * fall);
    }
  }

  // ── integrate ──────────────────────────────────────────────────────────
  vel += f * dt;
  vel *= exp(-dt * 0.6);                     // light air drag
  let spd  = length(vel);
  // frightened birds surge: fear locally raises the speed ceiling
  let vmax = (0.55 + restless * 0.40) * (0.80 + 0.40 * hash) + u._r1 * 1.4 + fear * 1.6;
  let vmin = 0.15;
  var nspd = spd;
  if (spd > vmax) { nspd = mix(spd, vmax, 1.0 - exp(-dt * 5.0)); }  // soft brake
  if (nspd < vmin) { nspd = vmin; }
  vel = vel * (nspd / max(spd, 1e-5));

  b.pos = vec4f(pos + vel * dt, hash);
  b.vel = vec4f(vel, 0.0);
  boids[idx] = b;
}
