// SILK — ribbon advection. Each thread owns one ribbon: advances its head
// through a curl flow field driven by the music, then shifts the segment
// history back, so the ribbon body traces the head's path like silk in wind.

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
  ripple_pos_age: array<vec4f, 8>,
  ripple_color:   array<vec4f, 8>,
}

const SEG: u32 = 24u;

@group(0) @binding(0) var<uniform>             u: Uniforms;
@group(0) @binding(1) var<storage, read_write> pts:   array<vec4f>;  // (x, y, _, _) × RIBBONS×SEG
@group(0) @binding(2) var<storage, read_write> state: array<vec4f>;  // (life, max_life, vel.x, vel.y)

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rnd(seed: u32) -> f32 { return f32(pcg(seed)) / 4294967295.0; }

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
  let r = gid.x;
  if (r * SEG >= arrayLength(&pts)) { return; }

  let base = r * SEG;
  var st   = state[r];
  let seed = pcg(r + u32(u.frame) * 92821u);
  let asp  = u.res_x / u.res_y;
  let dt   = clamp(u.delta, 0.0, 0.04);
  let t    = u.time + u.scene_seed;
  let role = r % 3u;   // 0 bass — wide slow, 1 mid — turbulent, 2 high — fine fast
  let drift_c = vec2f(u.drift_x, u.drift_y);

  // Respawn: collapse all segments onto a fresh point
  if (st.x <= 0.0) {
    let px = (rnd(seed) * 2.0 - 1.0) * asp * 0.9;
    let py =  rnd(seed + 1u) * 2.0 - 1.0;
    for (var i = 0u; i < SEG; i++) { pts[base + i] = vec4f(px, py, 0.0, 0.0); }
    state[r] = vec4f(1.0, 6.0 + rnd(seed + 2u) * 8.0, 0.0, 0.0);
    return;
  }

  var pos = pts[base].xy;
  var vel = st.zw;
  var f   = vec2f(0.0);

  // Rotating, breathing coordinate frame (generative drift)
  let dc = cos(u.drift_rot);
  let ds = sin(u.drift_rot);
  let fpos = mat2x2f(vec2f(dc, ds), vec2f(-ds, dc)) * (pos - drift_c);

  if (role == 0u) {
    // BASS: broad slow silk — big arcs, amplitude rides the bass
    f += curl_field(fpos * 0.45 * u.drift_scale, t * 0.12) * (0.4 + u.bass * u.mul_bass * 1.2);
    let pd = length(pos) + 0.001;
    f += (pos / pd) * sin(pd * 5.0 - t * 2.5) * u.bass * 6.0;
  } else if (role == 1u) {
    // MID: main turbulent layer + kick flare
    f += curl_field(fpos * 0.85 * u.drift_scale, t * 0.25) * (0.6 + u.mid * u.mul_mid * 4.0);
    f += normalize(pos + vec2f(0.0001)) * u.kick * 5.0 * exp(-length(pos) * 0.9);
  } else {
    // HIGH: fine fast filaments + shimmer jitter
    f += curl_field(fpos * 1.6 * u.drift_scale, t * 0.45) * (0.5 + u.high * u.mul_high * 5.0);
    let j = vec2f(rnd(seed ^ 0x1234u) - 0.5, rnd(seed ^ 0x9876u) - 0.5);
    f += j * u.high * 4.0;
  }

  // Shared musical dynamics (same language as the particles preset)
  f -= (pos - drift_c) * u.spring * 0.8;
  let beat_env = exp(-fract(u.beat_t) * 7.0) * u.beat_conf;
  f += normalize(pos + vec2f(0.0001)) * beat_env * 1.0;
  f -= pos * u.tension * 1.2;
  f += normalize(pos + vec2f(0.0001)) * u.drop_pulse * 22.0 * exp(-length(pos) * 1.1);

  // Ripple waves push silk too
  for (var ri = 0u; ri < 8u; ri++) {
    let rpa = u.ripple_pos_age[ri];
    if (rpa.z < 0.0) { continue; }
    let to_p  = pos - rpa.xy;
    let dist  = length(to_p) + 0.001;
    let dring = (dist - rpa.z * 0.55) / 0.15;
    let env   = exp(-rpa.z * 2.0) * max(0.0, 1.0 - rpa.z / 2.5);
    f += normalize(to_p) * exp(-dring * dring) * env * 12.0;
  }

  let drag = select(2.2, 1.6, role == 0u);
  vel *= exp(-drag * dt);
  vel += f * dt;
  pos += vel * dt;

  // Soft wrap
  if (pos.x >  asp + 0.1) { pos.x -= 2.0 * asp + 0.2; }
  if (pos.x < -asp - 0.1) { pos.x += 2.0 * asp + 0.2; }
  if (pos.y >  1.1)  { pos.y -= 2.2; }
  if (pos.y < -1.1)  { pos.y += 2.2; }

  // Shift history back, write new head
  var i = SEG - 1u;
  loop {
    pts[base + i] = pts[base + i - 1u];
    i--;
    if (i == 0u) { break; }
  }
  pts[base] = vec4f(pos, 0.0, 0.0);

  st.x -= dt / st.y;
  state[r] = vec4f(st.x, st.y, vel);
}
