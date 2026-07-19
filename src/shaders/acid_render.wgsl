// ACID — render. Projects the fluid solver's dye field like a 1960s liquid
// light show: filmic dye response, thin-film iridescence on dye-density
// gradients (oil-on-glass hue drift), soft projector vignette, light grain.
// Extra slots (see acid_compute.wgsl header):
//   extra[0]  = (gridW, gridH, dt, shimmer)
//   extra[13] = (bg.rgb, grain)

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
@group(0) @binding(1) var<storage, read> dye: array<vec4f>;

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

fn dyeAt(c: vec2i, gw: i32, gh: i32) -> vec4f {
  let q = clamp(c, vec2i(0), vec2i(gw - 1, gh - 1));
  return dye[u32(q.y * gw + q.x)];
}

fn sampleDye(uv: vec2f, gw: i32, gh: i32) -> vec4f {
  let g = vec2f(uv.x * f32(gw), uv.y * f32(gh)) - 0.5;
  let i0 = vec2i(i32(floor(g.x)), i32(floor(g.y)));
  let f = fract(g);
  let a = mix(dyeAt(i0, gw, gh),               dyeAt(i0 + vec2i(1, 0), gw, gh), f.x);
  let b = mix(dyeAt(i0 + vec2i(0, 1), gw, gh), dyeAt(i0 + vec2i(1, 1), gw, gh), f.x);
  return mix(a, b, f.y);
}

fn hsv2rgb(c: vec3f) -> vec3f {
  let k = fract(vec3f(c.x, c.x + 2.0 / 3.0, c.x + 1.0 / 3.0)) * 6.0;
  let rgb = clamp(abs(k - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  return c.z * mix(vec3f(1.0), rgb, c.y);
}

fn hash12(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q += vec2f(dot(q, q + 45.32));
  return fract(q.x * q.y);
}

@fragment
fn fs_render(in: VSOut) -> @location(0) vec4f {
  let gw = i32(u.extra[0].x);
  let gh = i32(u.extra[0].y);
  let shimmer = u.extra[0].w;
  let aspect = u.res_x / max(u.res_y, 1.0);

  // high band → tiny surface shimmer (render-only, never touches the sim)
  var uv = in.uv;
  if (shimmer > 0.01) {
    let n1 = hash12(in.uv * 731.7 + u.time * 3.1) - 0.5;
    let n2 = hash12(in.uv * 613.3 - u.time * 2.7) - 0.5;
    uv += vec2f(n1, n2) * shimmer * 0.0035;
  }

  let d = sampleDye(uv, gw, gh);

  // filmic dye response — thin washes stay translucent, dense cores glow
  var col = (vec3f(1.0) - exp(-d.rgb * 1.05)) * 0.70;
  // saturation push — projected dye is dense, not washed out
  let bodyLum = dot(col, vec3f(0.299, 0.587, 0.114));
  col = clamp(mix(vec3f(bodyLum), col, 1.22), vec3f(0.0), vec3f(1.4));

  // thin-film iridescence: hue drifts along dye-thickness gradients,
  // like light through the skin of an oil blob
  let px = 1.5 / f32(gw);
  let py = 1.5 / f32(gh);
  let gx = sampleDye(uv + vec2f(px, 0.0), gw, gh).w - sampleDye(uv - vec2f(px, 0.0), gw, gh).w;
  let gy = sampleDye(uv + vec2f(0.0, py), gw, gh).w - sampleDye(uv - vec2f(0.0, py), gw, gh).w;
  let gmag = length(vec2f(gx, gy));
  let edge = smoothstep(0.02, 0.26, gmag);
  let lum = dot(d.rgb, vec3f(0.299, 0.587, 0.114));
  let ang = atan2(gy, gx) * 0.15915494;                    // /2π
  let iriHue = fract(u.key_hue + 0.12 + ang * 0.35 + d.w * 0.30);
  let iri = hsv2rgb(vec3f(iriHue, 0.72, 1.0));
  col += iri * edge * smoothstep(0.02, 0.35, lum) * (0.11 + shimmer * 0.08);

  // projector plate: warm dark glass + soft round vignette
  let bg = u.extra[13].rgb;
  let vd = (in.uv - vec2f(0.5)) * vec2f(aspect, 1.0);
  let vign = 1.0 - smoothstep(0.42, 1.05, length(vd));
  col = bg + col;
  col *= mix(0.28, 1.0, vign);

  // light film grain — identity, kept subtle
  let grain = u.extra[13].w;
  let g = hash12(in.pos.xy + fract(u.frame * 0.10373) * 100.0) - 0.5;
  col += vec3f(g) * grain * 0.10;

  return vec4f(max(col, vec3f(0.0)), 1.0);
}
