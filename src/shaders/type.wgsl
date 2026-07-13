// TYPE — kinetic text snakes (TEXTR-style). JS lays glyph instances along
// wavy paths every frame; this shader just expands textured quads from the
// instance buffer and tints them. Instance = (x, y, angle, scale,
// u0, u1, bright, flags) — uv rect indexes the text atlas strip.

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
// extra[0] = text colour rgb + useKeyHue flag
// extra[1] = (glyphH_world, atlasAspect, invertFlash, -)

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var atlas: texture_2d<f32>;
@group(0) @binding(3) var<storage, read> inst: array<f32>;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0)       uv:  vec2f,
  @location(1)       bright: f32,
}

fn hsv2rgb(c: vec3f) -> vec3f {
  let k = fract(vec3f(c.x, c.x + 2.0 / 3.0, c.x + 1.0 / 3.0)) * 6.0;
  let rgb = clamp(abs(k - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  return c.z * mix(vec3f(1.0), rgb, c.y);
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  let ii = vi / 6u;
  let ci = vi % 6u;
  let o = ii * 8u;
  let x = inst[o]; let y = inst[o + 1u];
  let ang = inst[o + 2u]; let sc = inst[o + 3u];
  let u0 = inst[o + 4u]; let u1 = inst[o + 5u];
  let bright = inst[o + 6u];

  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  );
  let c = corners[ci];
  let P = u.extra[1];
  let gh = P.x * sc;                       // glyph height in world units
  let gw = gh * (u1 - u0) * P.y;           // width from uv slice × atlas aspect

  // local quad centred, rotated
  var l = vec2f((c.x - 0.5) * gw, (0.5 - c.y) * gh);
  let ca = cos(ang); let sa = sin(ang);
  l = vec2f(l.x * ca - l.y * sa, l.x * sa + l.y * ca);

  let aspect = u.res_x / max(u.res_y, 1.0);
  let clip = vec2f((x + l.x) / aspect, y + l.y);
  return VSOut(vec4f(clip, 0.0, 1.0),
               vec2f(mix(u0, u1, c.x), c.y),
               bright);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let a = textureSample(atlas, samp, in.uv).r;
  if (a < 0.02) { discard; }
  let C = u.extra[0];
  var col = C.rgb;
  if (C.w > 0.5) { col = hsv2rgb(vec3f(u.key_hue, 0.6, 1.0)); }
  // drop flash inverts to hot white
  col = mix(col, vec3f(1.2), clamp(u.extra[1].z, 0.0, 1.0));
  let v = a * in.bright;
  return vec4f(col * v, v);   // premultiplied, additive
}
