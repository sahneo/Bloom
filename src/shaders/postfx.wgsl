// Shared post-processing chain (all HDR presets render through this):
//   1. echo      — reads last frame's accum, applies a feedback warp
//                  (zoom/rotate = infinite tunnel) and damping, writes the
//                  other accum buffer (ping-pong)
//   2. bright    — thresholds + downsamples the accum buffer
//   3. blur_h/v  — separable 9-tap gaussian on the bright buffer
//   4. composite — camera + kaleidoscope → nebula bg + accum + glow →
//                  chromatic aberration → tonemap → invert/flash → grain

struct PostParams {
  glow:      f32,   // bloom strength multiplier
  exposure:  f32,   // tonemap exposure
  kaleido_k: f32,   // mirror segments; <2 = off
  cam_zoom:  f32,   // ≥1 = punch in
  cam_rot:   f32,   // radians
  aspect:    f32,   // canvas w/h
  time:      f32,
  key_hue:   f32,   // tonic hue 0..1 (nebula tint)
  key_conf:  f32,
  tonality:  f32,
  sub_bass:  f32,   // nebula breathing
  aberration: f32,  // chromatic aberration strength (dissonance/drops)
  grain:     f32,   // film grain amplitude
  flash:     f32,   // drop flash 0..1
  invert:    f32,   // drop negative 0..1
  anamorphic: f32,  // horizontal lens-flare streak strength
}

struct EchoParams {
  fade:   f32,   // trail retention this frame
  zoom:   f32,   // feedback zoom per frame (1 = none, >1 = tunnel inward)
  rot:    f32,   // feedback rotation per frame (radians)
  aspect: f32,
}

@group(0) @binding(0) var samp:      sampler;
@group(0) @binding(1) var src:       texture_2d<f32>;
@group(0) @binding(2) var bloom_tex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> post: PostParams;
@group(0) @binding(4) var<uniform> echo: EchoParams;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0)       uv:  vec2f,
}

@vertex
fn vs_fullscreen(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(3.0, 1.0), vec2f(-1.0, 1.0));
  let xy = p[vi];
  return VSOut(vec4f(xy, 0.0, 1.0), vec2f(xy.x * 0.5 + 0.5, 0.5 - xy.y * 0.5));
}

fn hsv2rgb(c: vec3f) -> vec3f {
  let k = fract(vec3f(c.x, c.x + 2.0 / 3.0, c.x + 1.0 / 3.0)) * 6.0;
  let rgb = clamp(abs(k - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  return c.z * mix(vec3f(1.0), rgb, c.y);
}

// Mirror-repeat fold: out-of-range uv reflects back into [0,1]. Seamless at
// the borders — no clamped-pixel smears, no hard black blocks.
fn mirror_uv(uv: vec2f) -> vec2f {
  return vec2f(1.0) - abs(fract(uv * 0.5) * 2.0 - vec2f(1.0));
}

// ── 1. Echo/feedback pass: prev accum → warped, damped → next accum ────
@fragment
fn fs_echo(in: VSOut) -> @location(0) vec4f {
  var p = (in.uv - 0.5) * vec2f(echo.aspect, 1.0);
  let cr = cos(-echo.rot);
  let sr = sin(-echo.rot);
  p = mat2x2f(vec2f(cr, sr), vec2f(-sr, cr)) * p / echo.zoom;
  let uv = mirror_uv(p / vec2f(echo.aspect, 1.0) + 0.5);
  return textureSample(src, samp, uv) * echo.fade;
}

// ── 2. Bloom bright pass ────────────────────────────────────────────────
@fragment
fn fs_bright(in: VSOut) -> @location(0) vec4f {
  let c = textureSample(src, samp, in.uv).rgb;
  let t = 0.30;
  return vec4f(max(c - vec3f(t), vec3f(0.0)), 1.0);
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

// ── 4. Composite ────────────────────────────────────────────────────────

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
    a = a - seg * floor(a / seg);
    a = abs(a - seg * 0.5);
    p = vec2f(cos(a), sin(a)) * r;
  }
  return p / vec2f(post.aspect, 1.0) + 0.5;
}

fn hash2(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), u.x),
             mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), u.x), u.y);
}

fn fbm(p: vec2f) -> f32 {
  var v = 0.0;
  var a = 0.5;
  var q = p;
  for (var i = 0; i < 3; i++) {
    v += a * vnoise(q);
    q = q * 2.13 + vec2f(17.0, 9.2);
    a *= 0.5;
  }
  return v;
}

@fragment
fn fs_composite(in: VSOut) -> @location(0) vec4f {
  // Camera/kaleido can look past the buffer — mirror-wrap continues the
  // image seamlessly instead of smearing edges or dropping to black
  let uv = mirror_uv(warp_uv(in.uv));

  // Chromatic aberration: radial RGB split, driven by dissonance and drops
  let ab   = post.aberration * 0.0035;
  let dirv = uv - 0.5;
  let base = vec3f(
    textureSample(src, samp, uv + dirv * ab).r,
    textureSample(src, samp, uv).g,
    textureSample(src, samp, uv - dirv * ab).b,
  );
  let glow = textureSample(bloom_tex, samp, uv).rgb;

  // Nebula background: barely-there FBM fog in the key colour, breathing
  // with sub-bass — kills the dead-black void without competing for focus
  let np   = (in.uv - 0.5) * vec2f(post.aspect, 1.0);
  let neb1 = fbm(np * 2.2 + vec2f(post.time * 0.016, post.time * 0.009));
  let neb2 = fbm(np * 3.7 - vec2f(post.time * 0.011, post.time * 0.019));
  let neb  = neb1 * neb2;
  let neb_col = hsv2rgb(vec3f(post.key_hue, 0.55, 1.0));
  let neb_amt = 0.030 + post.sub_bass * 0.075;
  let nebula  = mix(vec3f(0.5, 0.6, 1.0), neb_col, post.key_conf) * neb * neb_amt;

  // Anamorphic lens streaks: bright spots smear into wide horizontal rays
  // with the classic cool-blue cast of anamorphic glass
  var streak = vec3f(0.0);
  if (post.anamorphic > 0.01) {
    var wsum = 0.0;
    for (var i = 1; i <= 6; i++) {
      let off = f32(i) * f32(i) * 0.010;
      let w   = 1.0 / f32(i);
      streak += textureSample(bloom_tex, samp, uv + vec2f(off, 0.0)).rgb * w;
      streak += textureSample(bloom_tex, samp, uv - vec2f(off, 0.0)).rgb * w;
      wsum   += w * 2.0;
    }
    streak = streak / wsum * vec3f(0.45, 0.62, 1.15) * post.anamorphic;
  }

  var c = nebula + base + glow * post.glow + streak;
  c = vec3f(1.0) - exp(-c * post.exposure);
  c += vec3f(0.0, 0.0, 0.02);

  // Drop flavours: negative frame, white flash
  c = mix(c, vec3f(1.0) - c, clamp(post.invert, 0.0, 1.0));
  c += vec3f(post.flash);

  // Film grain — removes digital sterility, animated per frame
  let g = hash2(in.uv * 941.7 + vec2f(fract(post.time * 61.3) * 17.0));
  c += vec3f(g - 0.5) * post.grain;

  return vec4f(c, 1.0);
}
