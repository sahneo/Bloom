// KINO sprite pipeline — modes 3 (flow field), 4 (scribbles), 5 (text flow).
// JS builds the instance list every frame; this shader expands rotated quads.
// Instance stride 8: (x, y, angle, h, a, b, bright, flag)
//   flag 0 → glyph quad: a/b = atlas u0/u1; width = h·(b−a)·atlasCols·cellAspect
//   flag 1 → solid streak: a = width in world units (no atlas sample)
// Shares the KINO uniform buffer — extra slot map documented in kino.wgsl.

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

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var atlas: texture_2d<f32>;
@group(0) @binding(3) var<storage, read> inst: array<f32>;

struct VSOut {
  @builtin(position) pos:    vec4f,
  @location(0)       uv:     vec2f,
  @location(1)       bright: f32,
  @location(2)       flag:   f32,
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
  let x = inst[o];       let y = inst[o + 1u];
  let ang = inst[o + 2u]; let gh = inst[o + 3u];
  let a = inst[o + 4u];  let b = inst[o + 5u];
  let bright = inst[o + 6u];
  let flag = inst[o + 7u];

  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  );
  let c = corners[ci];
  let cols = max(u.extra[5].x, 1.0);
  let cellA = max(u.extra[5].y, 0.3);
  let gw = select(gh * (b - a) * cols * cellA, a, flag > 0.5);

  var l = vec2f((c.x - 0.5) * gw, (0.5 - c.y) * gh);
  let ca = cos(ang); let sa = sin(ang);
  l = vec2f(l.x * ca - l.y * sa, l.x * sa + l.y * ca);

  let aspect = u.res_x / max(u.res_y, 1.0);
  let clip = vec2f((x + l.x) / aspect, y + l.y);
  return VSOut(vec4f(clip, 0.0, 1.0),
               vec2f(mix(a, b, c.x), 0.04 + c.y * 0.92),
               bright, flag);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  var v = in.bright;
  if (in.flag < 0.5) {
    let ink = textureSampleLevel(atlas, samp, in.uv, 0.0).r;
    if (ink < 0.02) { discard; }
    v *= ink;
  }
  if (v <= 0.0) { discard; }
  let keyTint = clamp(u.extra[4].y, 0.0, 1.0);
  var col = mix(vec3f(1.0), hsv2rgb(vec3f(u.key_hue, 0.50, 1.0)), keyTint);
  col = mix(col, vec3f(1.3), clamp(u.extra[2].y, 0.0, 1.0));
  return vec4f(col * v, v);   // premultiplied, additive
}
