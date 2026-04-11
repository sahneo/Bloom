struct Uniforms {
  time:     f32,
  sub_bass: f32,
  bass:     f32,
  mid:      f32,
  high:     f32,
  delta:    f32,
  res_x:    f32,
  res_y:    f32,
  frame:    f32,
  _p0: f32, _p1: f32, _p2: f32,
}

struct Particle {
  pos:  vec2f,
  vel:  vec2f,
  life: f32,
  max_life: f32,
  size: f32,
  _pad: f32,
}

@group(0) @binding(0) var<uniform>       u:         Uniforms;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;

struct VSOut {
  @builtin(position) pos:   vec4f,
  @location(0)       local: vec2f,
  @location(1)       life:  f32,
  @location(2)       speed: f32,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  let pi = vi / 6u;
  let ci = vi % 6u;
  let p  = particles[pi];

  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f( 1.0, -1.0), vec2f(-1.0,  1.0),
    vec2f(-1.0,  1.0), vec2f( 1.0, -1.0), vec2f( 1.0,  1.0),
  );
  let c      = corners[ci];
  let aspect = u.res_x / u.res_y;
  let spd    = length(p.vel);

  var offset: vec2f;
  if (spd > 0.01) {
    let vd      = p.vel / spd;
    let vp      = vec2f(-vd.y, vd.x);
    // Elongate strongly with speed — creates line/wave effect on fast particles
    let stretch = 1.0 + spd * 4.0;
    offset = vd * c.y * p.size * stretch + vp * c.x * p.size;
  } else {
    offset = c * p.size;
  }

  let clip = vec2f((p.pos.x + offset.x) / aspect, p.pos.y + offset.y);
  return VSOut(vec4f(clip, 0.0, 1.0), c, p.life, spd);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let d = length(in.local);
  if (d > 1.0) { discard; }

  // Sharp edge — crisp particles, not blobs
  let edge  = smoothstep(1.0, 0.75, d);

  // Bright core only on fast particles (high freq streaks glow more)
  let core  = smoothstep(0.4, 0.0, d) * clamp(in.speed * 3.0, 0.0, 0.6);

  let alpha = in.life * edge;
  let luma  = (0.75 + core) * alpha * 0.28;  // dim per-particle; density builds brightness

  return vec4f(luma, luma, luma, luma);
}
