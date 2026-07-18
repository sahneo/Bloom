// PYRO ember compute — spark particles rising from the fire on turbulent
// paths, cooling from white-hot to dull red as they climb. Fully GPU-resident:
// dead particles respawn stochastically from per-category emission rates so
// the CPU only writes envelopes.
//
// Extra region slots (see pyro.wgsl header for the full map):
//   extra[0] = (height, width, lean, roar)
//   extra[2] = (tapX, tapY, tapEnv, tapAge)   → tap shower spawns
//   extra[3] = (rBase, rBurst, rSide, sideDir)
//   extra[4] = (popEnv, popX, 0, 0)           → quiet pop fountains
//
// Rates are "respawn probability per dead particle per second" — with a
// mostly-dead pool of N=4096 an rBase of 0.05 ≈ 150–200 embers/s.

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

// kind: 0 base drift, 1 kick/drop burst, 2 snare crackle, 3 tap shower, 4 pop
struct Ember {
  pos:  vec2f,
  vel:  vec2f,
  life: f32,
  heat: f32,
  seed: f32,
  kind: f32,
}

@group(0) @binding(0) var<uniform>             u:      Uniforms;
@group(0) @binding(1) var<storage, read_write> embers: array<Ember>;

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rnd(i: u32, k: u32) -> f32 {
  return f32(pcg((i * 2654435761u) ^ (k * 747796405u)) & 0xffffffu) / 16777216.0;
}
fn hash21(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn noise2(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let s = f * f * (3.0 - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2f(1.0, 0.0));
  let c = hash21(i + vec2f(0.0, 1.0));
  let d = hash21(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= arrayLength(&embers)) { return; }
  var e = embers[i];
  let dt   = u.delta;
  let asp  = u.res_x / max(u.res_y, 1.0);
  let lean = u.extra[0].z;
  let roar = u.extra[0].w;

  if (e.life > 0.0) {
    // turbulent buoyant flight: hotter embers rise faster
    let t1 = noise2(e.pos * 2.4 + vec2f(u.time * 0.70, e.seed * 9.1));
    let t2 = noise2(e.pos * 2.4 + vec2f(e.seed * 5.3, u.time * 0.66 + 31.7));
    let turb = vec2f(t1 - 0.5, t2 - 0.5) * (1.7 + roar * 1.6);
    let buoy = vec2f(lean * 0.55, 0.40 + e.heat * 1.15);
    e.vel += (buoy + turb) * dt;
    e.vel *= exp(-dt * 1.6);
    e.pos += e.vel * dt;
    // cooling: white-hot → dull red; crackle/tap sparks burn out fast
    let coolRate = select(0.62, 1.5, e.kind > 1.5 && e.kind < 3.5);
    e.heat *= exp(-dt * coolRate);
    e.life -= dt;
    if (e.pos.y > 1.15 || abs(e.pos.x) > asp + 0.25 || e.pos.y < -1.1) { e.life = 0.0; }
  } else {
    let fs     = u32(u.frame);
    let rates  = u.extra[3];              // rBase, rBurst, rSide, sideDir
    let rTap   = u.extra[2].z * 1.1;
    let rPop   = u.extra[4].x * 1.4;
    let total  = rates.x + rates.y + rates.z + rTap + rPop;
    if (rnd(i, fs * 2u + 1u) < total * dt) {
      let h1 = rnd(i, fs * 3u + 7u);
      let h2 = rnd(i, fs * 5u + 11u);
      let h3 = rnd(i, fs * 7u + 13u);
      let h4 = rnd(i, fs * 11u + 17u);
      let pick   = h1 * total;
      let width  = u.extra[0].y;
      e.seed = h4 * 10.0 + 1.0;
      if (pick < rates.x) {
        // base: slow drifting ember out of the flame
        e.kind = 0.0;
        e.pos  = vec2f((h2 - 0.5) * width * 1.7, -1.0 + h3 * 0.15);
        e.vel  = vec2f((h4 - 0.5) * 0.25, 0.25 + h2 * 0.55);
        e.life = 1.6 + h3 * 2.4;
        e.heat = 0.55 + h3 * 0.35;
      } else if (pick < rates.x + rates.y) {
        // kick / drop burst: fast white-hot column
        e.kind = 1.0;
        e.pos  = vec2f((h2 - 0.5) * width * 1.3, -0.98 + h3 * 0.10);
        e.vel  = vec2f((h4 - 0.5) * 0.9, 0.9 + h2 * 1.3);
        e.life = 1.0 + h3 * 1.4;
        e.heat = 0.85 + h3 * 0.15;
      } else if (pick < rates.x + rates.y + rates.z) {
        // snare crackle: short-lived sideways sparks
        e.kind = 2.0;
        e.pos  = vec2f((h2 - 0.5) * width * 0.9, -0.95 + h3 * 0.35);
        e.vel  = vec2f(rates.w * (0.9 + h4 * 1.5), 0.25 + h2 * 0.7);
        e.life = 0.45 + h3 * 0.6;
        e.heat = 1.0;
      } else if (pick < rates.x + rates.y + rates.z + rTap) {
        // thrown fuel: radial shower at the tap point
        e.kind = 3.0;
        let a  = h2 * 6.2831853;
        let r  = h3 * 0.12;
        e.pos  = vec2f(u.extra[2].x, u.extra[2].y) + vec2f(cos(a), sin(a)) * r;
        e.vel  = vec2f(cos(a) * (0.3 + h4 * 0.6), abs(sin(a)) * 0.6 + 0.4);
        e.life = 0.5 + h3 * 0.9;
        e.heat = 0.95;
      } else {
        // quiet pop: small fountain out of the coal bed
        e.kind = 4.0;
        e.pos  = vec2f(u.extra[4].y + (h2 - 0.5) * 0.06, -0.96);
        e.vel  = vec2f((h4 - 0.5) * 0.7, 0.7 + h2 * 0.9);
        e.life = 0.9 + h3 * 1.2;
        e.heat = 1.0;
      }
    }
  }
  embers[i] = e;
}
