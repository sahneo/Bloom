// Preset 01 — Membrane
// Organic fluid driven by frequency bands.
// Sub-bass: base motion speed
// Bass: warm amber bloom
// Mid: teal texture
// High: bright shimmer

struct Uniforms {
  time:     f32,
  sub_bass: f32,
  bass:     f32,
  mid:      f32,
  high:     f32,
  _pad:     f32,
  res:      vec2f,
}
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f( 1.0, -1.0), vec2f(-1.0,  1.0),
    vec2f(-1.0,  1.0), vec2f( 1.0, -1.0), vec2f( 1.0,  1.0),
  );
  let pos = p[vi];
  return VSOut(vec4f(pos, 0.0, 1.0), pos);
}

// --- Noise ---

fn hash2(p: vec2f) -> vec2f {
  let q = vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)));
  return fract(sin(q) * 43758.5453);
}

fn gnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = dot(hash2(i)                  * 2.0 - 1.0, f);
  let b = dot(hash2(i + vec2f(1.0,0.0)) * 2.0 - 1.0, f - vec2f(1.0,0.0));
  let c = dot(hash2(i + vec2f(0.0,1.0)) * 2.0 - 1.0, f - vec2f(0.0,1.0));
  let d = dot(hash2(i + vec2f(1.0,1.0)) * 2.0 - 1.0, f - vec2f(1.0,1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm(p: vec2f) -> f32 {
  var v = 0.0;
  var a = 0.5;
  var q = p;
  for (var i = 0; i < 3; i++) {
    v += a * gnoise(q);
    q = q * 2.01 + vec2f(3.1, 1.7);
    a *= 0.5;
  }
  return v;
}

// Single-pass domain warp
fn warp(uv: vec2f) -> f32 {
  let speed = 0.10 + u.sub_bass * 0.07;
  let t = u.time * speed;

  let q = vec2f(
    fbm(uv + t * vec2f(0.10, 0.13)),
    fbm(uv + vec2f(5.2, 1.3) + t * vec2f(0.12, 0.09)),
  );

  return fbm(uv + 2.0 * q + u.bass * 0.3);
}

// Palette
fn palette(f: f32) -> vec3f {
  let base  = vec3f(0.01, 0.01, 0.04);
  let blue  = vec3f(0.05, 0.18, 0.55) * smoothstep(-0.15, 0.45, f);
  let amber = vec3f(0.70, 0.32, 0.04) * u.bass * smoothstep(0.20, 0.72, f);
  let teal  = vec3f(0.04, 0.50, 0.42) * u.mid  * smoothstep(0.10, 0.55, f);
  let shine = vec3f(0.75, 0.88, 1.00) * u.high * smoothstep(0.55, 1.00, f);
  return base + blue + amber + teal + shine;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let aspect = u.res.x / u.res.y;
  let uv = in.uv * vec2f(aspect, 1.0) * 0.9;

  let f = warp(uv * 1.4);

  var col = palette(f);

  // Filmic tone map + gentle gamma
  col = col / (col + vec3f(0.28));
  col = pow(max(col, vec3f(0.0)), vec3f(0.88));

  return vec4f(col, 1.0);
}
