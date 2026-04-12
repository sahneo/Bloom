// Oscilloscope XY mode — left channel = X, right channel = Y.
// Waveform buffer: N_FRAMES snapshots × N_SAMPLES (L,R) pairs, interleaved.
// Frame 0 = most recent (brightest); frame N_FRAMES-1 = oldest (dimmest).
//
// Each segment is a quad. We interpolate `side` from -1→+1 across the quad;
// abs(side) == 0 at the centre line → gaussian glow peaks there → phosphor look.

const N_SAMPLES : u32 = 2048u;
const N_FRAMES  : u32 = 8u;
const HALF_W    : f32 = 0.012;   // line half-width in NDC Y units (~6px on 1080p)

struct Uniforms {
  res_x:    f32,
  res_y:    f32,
  tonality: f32,
  _pad:     f32,
}

@group(0) @binding(0) var<uniform>       u:        Uniforms;
@group(0) @binding(1) var<storage, read> waveform: array<f32>;

struct VSOut {
  @builtin(position) pos:   vec4f,
  @location(0)       side_v: f32,   // -1..+1 across line width; abs → dist from centre
  @location(1)       age:   f32,   // 0 = newest, 1 = oldest
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

  // Sample indices in the flat waveform buffer
  let base = frame * N_SAMPLES * 2u + seg * 2u;
  let ax = waveform[base];
  let ay = waveform[base + 1u];
  let bx = waveform[base + 2u];
  let by = waveform[base + 3u];

  // Map audio [-1,1] to NDC; scale X by 1/aspect so circles stay circular
  let aspect = u.res_x / u.res_y;
  let a = vec2f(ax / aspect, ay);
  let b = vec2f(bx / aspect, by);

  // Perpendicular to the segment direction
  let dv  = b - a;
  let len = length(dv);
  var perp: vec2f;
  if (len > 0.00001) {
    let nd = dv / len;
    perp = vec2f(-nd.y, nd.x);
  } else {
    perp = vec2f(0.0, 1.0);
  }

  // Two triangles forming a quad along the segment.
  // side = ±1 marks the two opposite edges; interpolated value in fragment = 0 at centreline.
  // Layout: tri0 = (A-, A+, B-)   tri1 = (B-, A+, B+)
  var end_t: f32;
  var side:  f32;
  if      (corner == 0u) { end_t = 0.0; side = -1.0; }
  else if (corner == 1u) { end_t = 0.0; side =  1.0; }
  else if (corner == 2u) { end_t = 1.0; side = -1.0; }
  else if (corner == 3u) { end_t = 1.0; side = -1.0; }
  else if (corner == 4u) { end_t = 0.0; side =  1.0; }
  else                   { end_t = 1.0; side =  1.0; }

  let center = mix(a, b, end_t);

  // Perpendicular offset: maintain equal pixel width in both axes
  let hw    = HALF_W * u.res_y / u.res_x;   // X-axis correction for aspect
  let pos2d = center + vec2f(perp.x * hw, perp.y * HALF_W) * side;

  let age = f32(frame) / f32(N_FRAMES);

  // Pass side RAW so interpolation gives 0 at centreline, ±1 at edges
  return VSOut(vec4f(pos2d, 0.0, 1.0), side, age, u.tonality);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  // dist = 0 at centre, 1 at edges (interpolated across the quad)
  let dist = abs(in.side_v);

  // Gaussian glow: tight bright core + wide soft halo
  let core  = exp(-dist * dist * 14.0);   // ~0 at dist > 0.5
  let halo  = exp(-dist * dist *  2.5);   // still visible at dist = 1
  let glow  = core * 0.7 + halo * 0.3;

  // Phosphor fade: newest = bright, oldest = dim
  let fade = pow(1.0 - in.age, 1.6);

  // Tonality colour: cool (minor) ↔ neutral ↔ warm (major)
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
