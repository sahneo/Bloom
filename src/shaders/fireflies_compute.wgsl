// FIREFLIES compute — a swarm of Kuramoto phase oscillators wandering a
// night forest. Each firefly free-runs at its own natural blink rate; when
// the beat tracker locks (beat_conf), coupling K pulls every phase toward
// the global beat phase fract(beat_t), so waves of synchrony sweep the
// swarm until thousands blink as one — Photinus carolinus style.
// Kick = coupling surge (a ripple of alignment expanding from an epicenter),
// snare = a random cluster startles and scatters, DROP = every phase is
// collapsed to zero (one giant unison flash) and then coupling is
// suppressed so the swarm desynchronizes and re-locks over a few bars.
//
// Preset extra[] slots (written by fireflies.js every frame):
//   extra[0] = (bps, confSm, surgeEnv, kSuppress)
//       bps       — beats/second from d(beat_t)/dt, EMA-smoothed
//       confSm    — smoothed beat confidence 0..1 (gates all coupling)
//       surgeEnv  — kick coupling-surge envelope 0..1
//       kSuppress — post-drop desync envelope 1→0 (kills K, widens detune)
//   extra[1] = (surgeX, surgeY, surgeAge s, dropSync)
//       dropSync = 1 for exactly one frame on a drop → phases collapse
//   extra[2] = (dropFlash, bassSm, windX, windY)
//   extra[3] = (snareX, snareY, snareEnv, snareAge s)  — startled cluster
//   extra[4] = (tapX,   tapY,   tapEnv,   tapAge s)    — pointer startle
//   extra[5] = (handAX, handAY, attractA, scatterA)    — open palm / fist
//   extra[6] = (handBX, handBY, attractB, scatterB)
// World coords: y up, x ∈ [-asp, asp], y ∈ [-1, 1] (+ wrap margin).

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

struct Fly {
  pos:     vec2f,   // world position
  vel:     vec2f,   // world velocity
  phase:   f32,     // Kuramoto phase, cycles 0..1 — wrap = flash
  detune:  f32,     // individual frequency offset −1..1
  depth:   f32,     // 0 far → 1 near (size / brightness / parallax)
  startle: f32,     // scared envelope 0..1 (glow off, phase noise)
}

@group(0) @binding(0) var<uniform>             u:     Uniforms;
@group(0) @binding(1) var<storage, read_write> flies: array<Fly>;

const TAU: f32 = 6.28318530718;

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rnd(seed: u32) -> f32 { return f32(pcg(seed)) / 4294967295.0; }

// Localized scare source: (vel kick xy, startle amount)
fn scare(pos: vec2f, pt: vec2f, env: f32, radius: f32, jit: vec2f) -> vec3f {
  let v    = pos - pt;
  let d    = length(v);
  let fall = max(1.0 - d / radius, 0.0);
  let amt  = env * fall * fall;
  if (amt < 0.002) { return vec3f(0.0); }
  let dir = v / max(d, 0.04);
  return vec3f((dir + jit * 0.5) * amt, amt);
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= arrayLength(&flies)) { return; }

  var F    = flies[idx];
  let dt   = clamp(u.delta, 0.0, 0.04);
  let asp  = u.res_x / max(u.res_y, 1.0);
  let hash = rnd(idx * 2654435761u);
  let seed = pcg(idx + u32(u.frame) * 83721u);

  // ── Kuramoto phase ─────────────────────────────────────────────────────
  let bps     = u.extra[0].x;
  let confSm  = u.extra[0].y;
  let surge   = u.extra[0].z;
  let kSup    = u.extra[0].w;
  let hasBeat = confSm * step(0.25, bps);

  // free-run blink rate 0.12–0.37 Hz (a flash every 3–8 s — real firefly
  // pacing, keeps the frame dark); locked rate = tempo ± detune.
  // kSuppress widens the detune after a drop so phases genuinely spread.
  // NOTE: formula duplicated in fireflies_render.wgsl vs_fly — keep in sync.
  let natural = 0.12 + hash * 0.25;
  let musical = max(bps, 0.25) * (1.0 + F.detune * (0.04 + kSup * 0.12));
  let freq    = mix(natural, musical, hasBeat);

  // coupling toward the global beat phase, gated on confidence
  var K = 2.2 * hasBeat * (1.0 - kSup);
  // kick: a wavefront of extra coupling expands from the surge epicenter —
  // a visible ripple of alignment sweeping across the swarm
  let sp = u.extra[1];
  if (surge > 0.01) {
    let sd = distance(F.pos, sp.xy);
    K += surge * exp(-abs(sd - sp.z * 2.4) * 3.0) * 7.0
         * (1.0 - kSup) * step(0.25, bps);
  }

  let theta = fract(u.beat_t);
  F.phase += freq * dt + (K * dt / TAU) * sin(TAU * (theta - F.phase));

  // ── startle: snare cluster, pointer tap, fist scatter ─────────────────
  let jit = vec2f(rnd(seed ^ 0x9E37u) * 2.0 - 1.0,
                  rnd(seed ^ 0x3B7Fu) * 2.0 - 1.0);
  var kickV = vec2f(0.0);
  var amt   = 0.0;
  var s3 = scare(F.pos, u.extra[3].xy, u.extra[3].z, 0.55, jit);
  var s4 = scare(F.pos, u.extra[4].xy, u.extra[4].z, 0.45, jit);
  var s5 = scare(F.pos, u.extra[5].xy, u.extra[5].w, 0.55, jit);
  var s6 = scare(F.pos, u.extra[6].xy, u.extra[6].w, 0.55, jit);
  kickV = s3.xy + s4.xy + s5.xy + s6.xy;
  amt   = min(s3.z + s4.z + s5.z + s6.z, 1.0);

  F.vel += kickV * dt * 16.0;
  F.startle = max(F.startle * exp(-dt * 3.0), amt);
  // scared flies go dark and lose the beat — local phase decoherence
  F.phase += (rnd(seed ^ 0x51EDu) - 0.5) * F.startle * 6.0 * dt;

  // ── DROP: unison flash, then the desync/re-lock IS the show ───────────
  if (u.extra[1].w > 0.5) {
    F.phase = rnd(idx * 7919u + 13u) * 0.03;   // everyone at attack, together
  }
  F.phase = fract(F.phase);

  // ── wander: curl-ish drift + vertical bob + wind + bass breathing ─────
  let dpf = 0.35 + F.depth * 0.9;              // parallax: near moves more
  let t   = u.time * 0.1;
  let s   = u.scene_seed * 9.7 + F.depth * 2.3;
  let flow = vec2f(
    sin(F.pos.y * 2.1 + t * 1.3 + s) + 0.6 * sin(F.pos.y * 5.3 - t * 2.1 + s * 1.6),
    0.8 * cos(F.pos.x * 2.7 - t * 1.1 + s)  + 0.5 * cos(F.pos.x * 4.9 + t * 1.9 + s * 2.2),
  );
  var vT = flow * 0.05 * dpf * u.drift_scale;
  vT.y += sin(u.time * (0.7 + hash * 1.1) + hash * 43.0) * 0.035 * dpf;

  let bassSm = u.extra[2].y;
  vT += u.extra[2].zw * (1.0 + bassSm * 2.0) * dpf;          // night wind
  vT += F.pos * sin(u.time * 0.4) * bassSm * 0.06;           // slow breathing

  // ── open palm: a curious cloud gathers, keeping polite distance ───────
  for (var hIdx = 5u; hIdx <= 6u; hIdx++) {
    let H = u.extra[hIdx];
    if (H.z > 0.02) {
      let hv   = H.xy - F.pos;
      let hd   = length(hv);
      let near = exp(-hd * hd * 1.4);
      let pull = hv / max(hd, 0.05) * (hd - 0.22);   // orbit ring, not a point
      vT += pull * H.z * near * 1.3 * (0.4 + hash);  // some flies more curious
    }
  }

  // ── integrate ─────────────────────────────────────────────────────────
  F.vel += (vT - F.vel) * (1.0 - exp(-dt * 1.8));
  let spd = length(F.vel);
  if (spd > 2.0) { F.vel *= 2.0 / spd; }
  F.pos += F.vel * dt;

  // seamless wrap slightly offscreen so nothing pops at the frame edge
  let mx = asp + 0.15;
  let my = 1.15;
  if (F.pos.x >  mx) { F.pos.x -= 2.0 * mx; }
  if (F.pos.x < -mx) { F.pos.x += 2.0 * mx; }
  if (F.pos.y >  my) { F.pos.y -= 2.0 * my; }
  if (F.pos.y < -my) { F.pos.y += 2.0 * my; }

  flies[idx] = F;
}
