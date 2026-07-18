// PHYSARUM — render. Bilinear-samples the two-species trail grid and
// colors species A with the track's key hue, species B with its
// complement — two living networks weaving through each other.
// extra[0] = (gridW, gridH, agentN, dropEnv); extra[3].w = kickEnv

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
@group(0) @binding(1) var<storage, read> trail: array<f32>;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0)       uv:  vec2f,
}

@vertex
fn vs_fullscreen(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  let xy = p[vi];
  return VSOut(vec4f(xy, 0.0, 1.0), vec2f(xy.x * 0.5 + 0.5, 0.5 - xy.y * 0.5));
}

fn cell(x: i32, y: i32, gw: i32, gh: i32, sp: i32) -> f32 {
  let cx = (x + gw) % gw;
  let cy = (y + gh) % gh;
  return trail[u32((cy * gw + cx) * 2 + sp)];
}

fn sampleTrail(uv: vec2f, gw: i32, gh: i32, sp: i32) -> f32 {
  let g = vec2f(uv.x * f32(gw), uv.y * f32(gh)) - 0.5;
  let i = vec2i(i32(floor(g.x)), i32(floor(g.y)));
  let f = fract(g);
  let a = mix(cell(i.x, i.y, gw, gh, sp),     cell(i.x + 1, i.y, gw, gh, sp),     f.x);
  let b = mix(cell(i.x, i.y + 1, gw, gh, sp), cell(i.x + 1, i.y + 1, gw, gh, sp), f.x);
  return mix(a, b, f.y);
}

fn hsv2rgb(c: vec3f) -> vec3f {
  let k = fract(vec3f(c.x, c.x + 2.0 / 3.0, c.x + 1.0 / 3.0)) * 6.0;
  let rgb = clamp(abs(k - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  return c.z * mix(vec3f(1.0), rgb, c.y);
}

@fragment
fn fs_render(in: VSOut) -> @location(0) vec4f {
  let E0 = u.extra[0];
  let gw = i32(E0.x);
  let gh = i32(E0.y);
  let kickEnv = u.extra[3].w;

  let tA = sampleTrail(in.uv, gw, gh, 0);
  let tB = sampleTrail(in.uv, gw, gh, 1);

  // vein response: soft toe so faint filaments read, hot cores bloom
  let vA = pow(clamp(tA * 0.75, 0.0, 2.2), 1.5);
  let vB = pow(clamp(tB * 0.75, 0.0, 2.2), 1.5);

  let hueA = u.key_hue;
  let hueB = fract(u.key_hue + 0.47);
  let colA = hsv2rgb(vec3f(hueA, 0.72 - vA * 0.10, 1.0));
  let colB = hsv2rgb(vec3f(hueB, 0.70 - vB * 0.10, 1.0));

  var col = colA * vA * 0.62 + colB * vB * 0.62;
  // kick lifts the whole organism for a beat
  col *= 1.0 + kickEnv * 0.35 + u.drop_pulse * 0.5;

  // breathing depth: faint dark vignette keeps focus centred
  let d = in.uv - vec2f(0.5);
  col *= 1.0 - dot(d, d) * 0.55;

  return vec4f(col, 1.0);
}
