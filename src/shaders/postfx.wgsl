// Shared post-processing chain (all HDR presets render through this):
//   1. fade      — multiplies the accumulation buffer by a retention factor
//                  (blend constant), leaving light trails behind geometry
//   2. bright    — thresholds + downsamples the accum buffer to 1/4 res
//   3. blur_h/v  — separable 9-tap gaussian on the bright buffer
//   4. composite — camera (zoom/rot) + kaleidoscope → accum + glow → tonemap

struct PostParams {
  glow:      f32,   // bloom strength multiplier
  exposure:  f32,   // tonemap exposure
  kaleido_k: f32,   // mirror segments; <2 = off
  cam_zoom:  f32,   // ≥1 = punch in
  cam_rot:   f32,   // radians
  aspect:    f32,   // canvas w/h
  _p0:       f32,
  _p1:       f32,
}

@group(0) @binding(0) var samp:      sampler;
@group(0) @binding(1) var src:       texture_2d<f32>;
@group(0) @binding(2) var bloom_tex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> post: PostParams;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0)       uv:  vec2f,
}

@vertex
fn vs_fullscreen(@builtin(vertex_index) vi: u32) -> VSOut {
  // Single oversized triangle covering the screen
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(3.0, 1.0), vec2f(-1.0, 1.0));
  let xy = p[vi];
  return VSOut(vec4f(xy, 0.0, 1.0), vec2f(xy.x * 0.5 + 0.5, 0.5 - xy.y * 0.5));
}

// Output is irrelevant — blend is (src*0 + dst*constant); the constant is the
// per-frame trail retention factor set from JS.
@fragment
fn fs_fade(in: VSOut) -> @location(0) vec4f {
  return vec4f(0.0);
}

// Soft-threshold bright pass, rendered at 1/4 resolution
@fragment
fn fs_bright(in: VSOut) -> @location(0) vec4f {
  let c = textureSample(src, samp, in.uv).rgb;
  let t = 0.30;
  let bright = max(c - vec3f(t), vec3f(0.0));
  return vec4f(bright, 1.0);
}

fn blur(uv: vec2f, dir: vec2f) -> vec3f {
  var w = array<f32, 5>(0.227027, 0.194594, 0.121621, 0.054054, 0.016216);
  let texel = dir / vec2f(textureDimensions(src));
  var c = textureSample(src, samp, uv).rgb * w[0];
  for (var i = 1; i < 5; i++) {
    let off = texel * f32(i);
    c += textureSample(src, samp, uv + off).rgb * w[i];
    c += textureSample(src, samp, uv - off).rgb * w[i];
  }
  return c;
}

@fragment
fn fs_blur_h(in: VSOut) -> @location(0) vec4f { return vec4f(blur(in.uv, vec2f(1.0, 0.0)), 1.0); }

@fragment
fn fs_blur_v(in: VSOut) -> @location(0) vec4f { return vec4f(blur(in.uv, vec2f(0.0, 1.0)), 1.0); }

// Camera + kaleidoscope warp, applied at composite time so it affects the
// whole accumulated image (trails included) coherently
fn warp_uv(uv: vec2f) -> vec2f {
  var p = (uv - 0.5) * vec2f(post.aspect, 1.0);
  let cr = cos(post.cam_rot);
  let sr = sin(post.cam_rot);
  p = mat2x2f(vec2f(cr, sr), vec2f(-sr, cr)) * p / max(post.cam_zoom, 0.5);
  let k = post.kaleido_k;
  if (k >= 2.0) {
    let seg = 6.28318530718 / k;
    let r   = length(p);
    var a   = atan2(p.y, p.x);
    a = a - seg * floor(a / seg);   // fold into one segment
    a = abs(a - seg * 0.5);         // mirror inside it
    p = vec2f(cos(a), sin(a)) * r;
  }
  return p / vec2f(post.aspect, 1.0) + 0.5;
}

@fragment
fn fs_composite(in: VSOut) -> @location(0) vec4f {
  let uv   = warp_uv(in.uv);
  let base = textureSample(src, samp, uv).rgb;
  let glow = textureSample(bloom_tex, samp, uv).rgb;
  var c = base + glow * post.glow;
  // Soft exponential tonemap — trails accumulate unbounded HDR energy in the
  // rgba16float buffer; this rolls bright regions off to white instead of clipping
  c = vec3f(1.0) - exp(-c * post.exposure);
  c += vec3f(0.0, 0.0, 0.02);   // original deep-blue background tint
  return vec4f(c, 1.0);
}
