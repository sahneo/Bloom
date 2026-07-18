// PYRO ember compute — embers LEAK from the upper flame body continuously
// (rate follows flame intensity), rise on buoyant turbulent paths with
// per-ember drag, swirl in slow vortices, and cool white → orange → dull red
// → dark over seconds. Kicks add a modest extra puff out of the flame top —
// never a radial starburst. Fully GPU-resident: dead particles respawn
// stochastically from per-category emission rates; the CPU only writes
// envelopes.
//
// Extra region slots (see pyro.wgsl header for the full map):
//   extra[0] = (height, width, lean, roar)
//   extra[2] = (tapX, tapY, tapEnv, tapAge)   → tap ember trickle
//   extra[3] = (rBase, rBurst, rSide, sideDir)
//   extra[4] = (popEnv, popX, glow, 0)        → quiet pop fountains
//
// Rates are "respawn probability per dead particle per second".

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

// kind: 0 flame-top leak, 1 kick puff, 2 snare crackle, 3 tap trickle, 4 pop
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
  let dt     = u.delta;
  let asp    = u.res_x / max(u.res_y, 1.0);
  let height = max(u.extra[0].x, 0.06);
  let width  = max(u.extra[0].y, 0.10);
  let lean   = u.extra[0].z;
  let roar   = u.extra[0].w;

  if (e.life > 0.0) {
    // buoyant turbulent flight — hotter embers rise faster, cool ones drift
    let t1 = noise2(e.pos * 2.1 + vec2f(u.time * 0.55, e.seed * 9.1));
    let t2 = noise2(e.pos * 2.1 + vec2f(e.seed * 5.3, u.time * 0.52 + 31.7));
    let turb = vec2f(t1 - 0.5, t2 - 0.5) * (1.1 + roar * 1.0);
    // slow vortex swirl: perpendicular flow whose strength wanders per ember
    let sw = (noise2(e.pos * 0.9 + vec2f(u.time * 0.14, e.seed * 3.3)) - 0.5) * 2.0;
    let swirl = vec2f(-(t2 - 0.5), t1 - 0.5) * sw * 0.9;
    let buoy = vec2f(lean * 0.45, 0.22 + e.heat * 0.85);
    e.vel += (buoy + turb + swirl) * dt;
    // per-ember drag: cooled embers lose momentum and get carried by the air
    e.vel *= exp(-dt * (1.1 + (1.0 - clamp(e.heat, 0.0, 1.0)) * 1.4));
    e.pos += e.vel * dt;
    // slow cooling: white → orange → dull red → dark; crackle burns out fast
    let coolRate = select(0.55, 1.25, e.kind > 1.5 && e.kind < 3.5);
    e.heat *= exp(-dt * coolRate);
    e.life -= dt;
    if (e.pos.y > 1.15 || abs(e.pos.x) > asp + 0.25 || e.pos.y < -1.1) { e.life = 0.0; }
  } else {
    let fs     = u32(u.frame);
    let rates  = u.extra[3];              // rBase, rBurst, rSide, sideDir
    let rTap   = u.extra[2].z * 0.18;
    let rPop   = u.extra[4].x * 0.9;
    let total  = rates.x + rates.y + rates.z + rTap + rPop;
    if (rnd(i, fs * 2u + 1u) < total * dt) {
      let h1 = rnd(i, fs * 3u + 7u);
      let h2 = rnd(i, fs * 5u + 11u);
      let h3 = rnd(i, fs * 7u + 13u);
      let h4 = rnd(i, fs * 11u + 17u);
      let pick = h1 * total;
      e.seed = h4 * 10.0 + 1.0;
      if (pick < rates.x) {
        // leak from the upper flame body: born where the tongues tear off
        e.kind = 0.0;
        let yr = 0.35 + h3 * 0.55;                    // fraction of flame height
        let y  = -1.0 + height * yr;
        let wAt = width * (1.0 - min(yr, 1.1) * 0.40);
        e.pos  = vec2f((h2 - 0.5) * wAt * 1.5 + lean * (y + 1.0) * (y + 1.0) * 0.45, y);
        e.vel  = vec2f((h4 - 0.5) * 0.14, 0.10 + h2 * 0.22);
        e.life = 2.0 + h3 * 2.4;
        e.heat = 0.70 + h3 * 0.30;
      } else if (pick < rates.x + rates.y) {
        // kick puff: a modest extra breath of embers out of the flame top
        e.kind = 1.0;
        let yr = 0.65 + h3 * 0.45;
        let y  = -1.0 + height * yr;
        e.pos  = vec2f((h2 - 0.5) * width * 1.1 + lean * (y + 1.0) * (y + 1.0) * 0.45, y);
        e.vel  = vec2f((h4 - 0.5) * 0.30, 0.35 + h2 * 0.45);
        e.life = 1.8 + h3 * 1.8;
        e.heat = 0.85 + h3 * 0.15;
      } else if (pick < rates.x + rates.y + rates.z) {
        // snare crackle: a few short-lived sparks nudged sideways
        e.kind = 2.0;
        e.pos  = vec2f((h2 - 0.5) * width * 0.9, -0.95 + h3 * height * 0.5);
        e.vel  = vec2f(rates.w * (0.30 + h4 * 0.55), 0.22 + h2 * 0.45);
        e.life = 0.7 + h3 * 0.8;
        e.heat = 0.95;
      } else if (pick < rates.x + rates.y + rates.z + rTap) {
        // thrown fuel: embers trickle upward from the burn site
        e.kind = 3.0;
        e.pos  = vec2f(u.extra[2].x + (h2 - 0.5) * 0.22, u.extra[2].y + (h3 - 0.5) * 0.14);
        e.vel  = vec2f((h4 - 0.5) * 0.30, 0.22 + h2 * 0.40);
        e.life = 1.4 + h3 * 1.8;
        e.heat = 0.90;
      } else {
        // quiet pop: a soft little fountain out of the coal bed
        e.kind = 4.0;
        e.pos  = vec2f(u.extra[4].y + (h2 - 0.5) * 0.06, -0.96);
        e.vel  = vec2f((h4 - 0.5) * 0.40, 0.45 + h2 * 0.55);
        e.life = 1.4 + h3 * 1.6;
        e.heat = 1.0;
      }
    }
  }
  embers[i] = e;
}
