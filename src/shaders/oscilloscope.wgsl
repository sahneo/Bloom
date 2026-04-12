// Oscilloscope XY mode — left channel = X, right channel = Y.
// Waveform data: N_FRAMES consecutive snapshots, each N_SAMPLES (L,R) pairs.
// Frame 0 = most recent (brightest); frame N_FRAMES-1 = oldest (dimmest).
//
// Each segment is drawn as a quad with gaussian glow falloff,
// giving a phosphor-screen appearance.

const N_SAMPLES : u32 = 2048u;
const N_FRAMES  : u32 = 8u;
const HALF_W    : f32 = 0.005;   // line half-width in NDC Y units

struct Uniforms {
  res_x:    f32,
  res_y:    f32,
  tonality: f32,
  _pad:     f32,
}

@group(0) @binding(0) var<uniform>       u:        Uniforms;
@group(0) @binding(1) var<storage, read> waveform: array<f32>;
// waveform layout: [frame0_s0_L, frame0_s0_R, frame0_s1_L, frame0_s1_R, … frame7_…]

struct VSOut {
  @builtin(position) pos:  vec4f,
  @location(0)       dist: f32,   // |perpendicular offset| normalised to HALF_W
  @location(1)       age:  f32,   // 0 = newest, 1 = oldest
  @location(2)       tonal: f32,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  let segs_per_frame  = N_SAMPLES - 1u;
  let verts_per_frame = segs_per_frame * 6u;

  let frame  = vi / verts_per_frame;
  let local  = vi % verts_per_frame;
  let seg    = local / 6u;
  let corner = local % 6u;

  // Sample indices in the flat buffer
  let base = frame * N_SAMPLES * 2u + seg * 2u;
  let ax = waveform[base];
  let ay = waveform[base + 1u];
  let bx = waveform[base + 2u];
  let by = waveform[base + 3u];

  // Map audio [-1,1] to NDC, correct X for aspect ratio so circles look circular
  let aspect = u.res_x / u.res_y;
  let a = vec2f(ax / aspect, ay);
  let b = vec2f(bx / aspect, by);

  // Perpendicular vector (corrected back to NDC for the offset)
  let dv  = b - a;
  let len = length(dv);
  var perp: vec2f;
  if (len > 0.00001) {
    let nd = dv / len;
    perp = vec2f(-nd.y, nd.x);
  } else {
    perp = vec2f(0.0, 1.0);
  }

  // Quad corners: two CCW triangles
  // tri0: (A-, A+, B-)   tri1: (B-, A+, B+)
  var end_t: f32;
  var side:  f32;
  switch (corner) {
    case 0u: { end_t = 0.0; side = -1.0; }
    case 1u: { end_t = 0.0; side =  1.0; }
    case 2u: { end_t = 1.0; side = -1.0; }
    case 3u: { end_t = 1.0; side = -1.0; }
    case 4u: { end_t = 0.0; side =  1.0; }
    case 5u: { end_t = 1.0; side =  1.0; }
    default: { end_t = 0.0; side =  0.0; }
  }

  let center = mix(a, b, end_t);
  // Apply perpendicular offset in screen-space width (uniform across all directions)
  let hw = HALF_W * u.res_y / u.res_x;  // keep pixel width consistent on X axis too
  let pos2d = center + vec2f(perp.x * hw, perp.y * HALF_W) * side;

  let age = f32(frame) / f32(N_FRAMES);

  return VSOut(vec4f(pos2d, 0.0, 1.0), abs(side), age, u.tonality);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  // Gaussian glow: bright core, soft outer halo
  let core_glow  = exp(-in.dist * in.dist * 6.0);
  let outer_glow = exp(-in.dist * in.dist * 24.0);
  let glow = core_glow * 0.6 + outer_glow * 0.4;

  // Phosphor fade: newest = full brightness, oldest = almost gone
  let fade = pow(1.0 - in.age, 1.8);

  // Tonality color: -1=minor(cool blue-violet), 0=neutral, +1=major(warm amber)
  let cool    = vec3f(0.22, 0.55, 1.00);
  let neutral = vec3f(0.65, 0.90, 1.00);
  let warm    = vec3f(1.00, 0.65, 0.08);
  var rgb: vec3f;
  if (in.tonal > 0.0) {
    rgb = mix(neutral, warm, in.tonal);
  } else {
    rgb = mix(neutral, cool, -in.tonal);
  }

  let intensity = glow * fade;
  return vec4f(rgb * intensity, intensity);
}
