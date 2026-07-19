// ABYSS render — the plankton as light. Instanced additive soft quads
// (premultiplied, one/one). The field is mostly INVISIBLE; sound ignites it:
//   kick  → expanding, slowly sinking pressure wavefront lights plankton
//           as it passes (eased ~1.5 s envelope)
//   bass  → ambient bioluminescent fog breathing (u._r1, JS EMA)
//   high  → rare individual sparkles (u._r3 gates the rate)
//   snare → brief local glitter cloud at a random spot
//   drop  → the whole abyss ignites: a bright crest sweeps down the frame,
//           then everything fades back to darkness over ~3 s
//   tap   → swirling eddy of ignited plankton around the point
//   palm  → faint ignition along the hand's outflow
//
// Repurposed uniform slots (owned by the ABYSS preset):
//   _r1 = ambient fog (bass EMA)   _r3 = sparkle level (high EMA)
//   extra[0..3] = kick waves (x, y, ageS, strength); strength 0 = inactive
//   extra[4] = (dropAge s, dropEnv 0..1, quiet 0..1, —)
//   extra[5] = (snareX, snareY, snareEnv, snareAge)
//   extra[6] = (tapX, tapY, tapEnv, tapAge)
//   extra[7] = (h1x, h1y, h1present, h1grip)
//   extra[8] = (h2x, h2y, h2present, h2grip)

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

@group(0) @binding(0) var<uniform>       u:         Uniforms;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;

fn hsv2rgb(c: vec3f) -> vec3f {
  let k = fract(vec3f(c.x, c.x + 2.0 / 3.0, c.x + 1.0 / 3.0)) * 6.0;
  let rgb = clamp(abs(k - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  return c.z * mix(vec3f(1.0), rgb, c.y);
}

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn hashf(v: u32) -> f32 { return f32(pcg(v) & 0xffffffu) / 16777215.0; }

struct VSOut {
  @builtin(position) pos:    vec4f,
  @location(0)       local:  vec2f,
  @location(1)       bright: f32,
  @location(2)       hot:    f32,   // 0 = teal glow, 1 = white-hot sparkle
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  let gi = vi / 6u;
  let ci = vi % 6u;
  let pt = particles[gi];
  let p  = pt.pos;

  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f( 1.0, -1.0), vec2f(-1.0,  1.0),
    vec2f(-1.0,  1.0), vec2f( 1.0, -1.0), vec2f( 1.0,  1.0),
  );
  let c    = corners[ci];
  let asp  = u.res_x / max(u.res_y, 1.0);
  let h1   = hashf(gi * 2654435761u);
  let h2   = hashf(gi ^ 0x5bf03635u);

  var bright = 0.010;                                  // near-invisible base
  var hot    = 0.0;

  // ── ambient fog: bass breathing, spatially uneven ─────────────────────
  let fogSpace = 0.5 + 0.5 * sin(p.x * 1.9 + h1 * 6.28)
                           * sin(p.y * 2.6 + u.time * 0.11 + h2 * 6.28);
  bright += u._r1 * 0.075 * (0.35 + 0.65 * fogSpace);

  // ── kick pressure wavefronts: expanding, sinking rings of light ───────
  for (var w = 0u; w < 4u; w++) {
    let wv = u.extra[w];
    if (wv.w < 0.01) { continue; }
    let age = wv.z;
    let tn  = clamp(age / 1.5, 0.0, 1.0);
    let R   = 0.18 + 1.75 * (1.0 - (1.0 - tn) * (1.0 - tn));   // ease-out
    let ctr = vec2f(wv.x, wv.y - age * 0.20);                  // wave sinks
    let d   = distance(p, ctr);
    let ring = exp(-(d - R) * (d - R) / 0.045);
    let env  = wv.w * min(age / 0.06, 1.0) * pow(1.0 - tn, 1.7);
    bright += env * ring * 0.60;
  }

  // ── drop: the whole abyss ignites, crest sweeps down, ~3 s fade ───────
  let dropv   = u.extra[4];
  let dropEnv = dropv.y;
  if (dropEnv > 0.005) {
    let fy    = 1.15 - dropv.x * 1.7;                  // crest sweeps top→down
    let crest = exp(-(p.y - fy) * (p.y - fy) / 0.16);
    bright += dropEnv * (0.14 + crest * 0.85);
    hot    += dropEnv * crest * 0.30;
  }

  // ── snare: brief glitter cloud at a random spot ───────────────────────
  let sn = u.extra[5];
  if (sn.z > 0.01) {
    let d2 = dot(p - sn.xy, p - sn.xy);
    let tw = 0.5 + 0.5 * sin(u.time * 34.0 + h1 * 80.0);
    let gl = sn.z * exp(-d2 * 7.0) * step(0.55, h2) * tw;
    bright += gl * 1.5;
    hot    += gl * 1.2;
  }

  // ── high: rare individual sparkles (lone fireflies of the deep) ───────
  let slotLen = 0.8;
  let slot  = floor(u.time / slotLen + h1 * 9.7);
  let r     = hashf((u32(slot + 7.0) * 2246822519u) ^ gi);
  let rate  = 0.0006 + u._r3 * 0.007;
  if (r < rate) {
    let ph  = fract(u.time / slotLen + h1 * 9.7);
    let env = sin(3.14159 * ph);
    bright += env * env * 2.2;
    hot    += env * env;
  }

  // ── tap: swirling ignited eddy around the disturbance ─────────────────
  let tap = u.extra[6];
  if (tap.z > 0.01) {
    let rel = p - tap.xy;
    let d   = length(rel);
    let ang = atan2(rel.y, rel.x);
    let spiral = 0.5 + 0.5 * sin(ang * 3.0 + d * 10.0 - tap.w * 6.0);
    let ig = tap.z * exp(-d * 2.6) * (0.25 + 0.75 * spiral);
    bright += ig * 1.3;
    hot    += ig * 0.3;
  }

  // ── palm: faint ignition along the hand's current ─────────────────────
  for (var s = 0u; s < 2u; s++) {
    let h = u.extra[7u + s];
    if (h.z < 0.05) { continue; }
    let d = distance(p, h.xy);
    let fist = smoothstep(0.4, 0.75, h.w);
    bright += h.z * exp(-d * 2.0) * mix(0.16, 0.34, fist);
  }

  bright = min(bright, 6.0);
  hot    = min(hot, 1.0);

  // lit plankton swells slightly — light, not motion
  let size = (5.2 / u.res_y) * (0.55 + h2 * 0.9) * (1.0 + min(bright, 1.5) * 0.5);
  let clip = vec2f((p.x + c.x * size) / asp, p.y + c.y * size);
  return VSOut(vec4f(clip, 0.0, 1.0), c, bright, hot);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let d = length(in.local);
  if (d > 1.0) { discard; }
  let edge = smoothstep(1.0, 0.15, d);

  // bioluminescent cyan-teal, pulled toward the track's key
  let base = vec3f(0.05, 0.88, 0.80);
  let key  = hsv2rgb(vec3f(u.key_hue, 0.60, 1.0));
  var rgb  = mix(base, key, u.key_conf * 0.40);
  rgb = mix(rgb, vec3f(0.92, 0.99, 1.0), in.hot);      // sparkles whiten

  let a = edge * 0.20 * u.trail_gain;
  return vec4f(rgb * in.bright * a, in.bright * a);    // premultiplied
}
