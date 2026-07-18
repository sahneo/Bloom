// PYRO ember render — soft additive gaussian sparks. Fresh embers glow
// yellow-white just over the bloom threshold; as heat decays they slide down
// the same blackbody ramp as the flame (yellow → orange → dull red) and
// finally dim to near-dark before their life fades — like real embers
// vanishing into the night. Larger, softer, dimmer than a "popper" spark:
// no hard-edged confetti dots.

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

struct Ember {
  pos:  vec2f,
  vel:  vec2f,
  life: f32,
  heat: f32,
  seed: f32,
  kind: f32,
}

@group(0) @binding(0) var<uniform>       u:      Uniforms;
@group(0) @binding(1) var<storage, read> embers: array<Ember>;

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

fn fire_ramp(t: f32) -> vec3f {
  let x = clamp(t, 0.0, 1.0);
  var c = vec3f(pow(x, 0.55), pow(x, 1.85) * 0.88, pow(x, 4.8) * 0.68);
  c += vec3f(0.58, 0.66, 0.66) * smoothstep(0.82, 1.0, x);
  return c;
}

struct VSOut {
  @builtin(position) pos:   vec4f,
  @location(0)       local: vec2f,
  @location(1)       heat:  f32,
  @location(2)       life:  f32,
  @location(3)       hash:  f32,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  let gi = vi / 6u;
  let ci = vi % 6u;
  let e  = embers[gi];

  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f( 1.0, -1.0), vec2f(-1.0,  1.0),
    vec2f(-1.0,  1.0), vec2f( 1.0, -1.0), vec2f( 1.0,  1.0),
  );
  let c    = corners[ci];
  let asp  = u.res_x / max(u.res_y, 1.0);
  let hash = f32(pcg(gi * 2654435761u) & 0xffffu) / 65535.0;

  if (e.life <= 0.0) {
    return VSOut(vec4f(2e4, 2e4, 0.0, 1.0), c, 0.0, 0.0, hash);
  }

  // ~5–9 px soft glows, hot embers a touch larger (screen height = 2 units)
  let size = (9.0 / u.res_y) * (0.55 + hash * 0.90) * (0.55 + e.heat * 0.55);
  let clip = vec2f((e.pos.x + c.x * size) / asp, e.pos.y + c.y * size);
  return VSOut(vec4f(clip, 0.0, 1.0), c, e.heat, e.life, hash);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let d = length(in.local);
  if (d > 1.0) { discard; }
  // pure gaussian falloff — a glowing mote, not a disc
  let soft = exp(-d * d * 4.5) - exp(-4.5);

  let heat = clamp(in.heat, 0.0, 1.0);
  // die-out fade + gentle slow per-ember shimmer
  let lf = smoothstep(0.0, 0.45, in.life)
         * (0.88 + 0.12 * sin(u.time * (4.0 + in.hash * 6.0) + in.hash * 40.0));
  // brightness follows heat³ — cooled embers dim to a barely-there dull red
  // well before the frame top, like real sparks vanishing into the night
  let b  = (0.04 + heat * heat * heat * 1.30) * lf;

  var col = fire_ramp(0.10 + heat * 0.88);
  // keyHue: only the cooled tail picks up a subtle key tint
  let key = hsv2rgb(vec3f(u.key_hue, 0.55, 1.0));
  col = mix(col, key * dot(col, vec3f(0.35, 0.5, 0.15)), 0.18 * u.key_conf * (1.0 - heat));

  let a = soft * b;
  return vec4f(col * a, a * 0.04);   // premultiplied, one/one additive
}
