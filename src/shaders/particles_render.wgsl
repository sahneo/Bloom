struct Uniforms {
  time:       f32, sub_bass:    f32, bass:       f32, mid:        f32,
  high:       f32, delta:       f32, res_x:      f32, res_y:      f32,
  frame:      f32, mul_sb:      f32, mul_bass:   f32, mul_mid:    f32,
  mul_high:   f32, spring:      f32, kick:       f32, snare:      f32,
  mode_drums: f32, mode_bass:   f32, mode_lead:  f32, mode_atmos: f32,
  mode_pads:  f32, color_mode:  f32, tonality:   f32, pulse:       f32,
}

struct Particle {
  pos:      vec2f,
  vel:      vec2f,
  life:     f32,
  max_life: f32,
  size:     f32,
  band:     f32,
}

@group(0) @binding(0) var<uniform>       u:         Uniforms;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;

struct VSOut {
  @builtin(position) pos:   vec4f,
  @location(0)       local: vec2f,
  @location(1)       life:  f32,
  @location(2)       band:  f32,
  @location(3)       speed: f32,
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
  if (spd > 0.008) {
    let vd      = p.vel / spd;
    let vp      = vec2f(-vd.y, vd.x);
    let stretch = 1.0 + spd * 4.5;
    offset = vd * c.y * p.size * stretch + vp * c.x * p.size;
  } else {
    offset = c * p.size;
  }

  let clip = vec2f((p.pos.x + offset.x) / aspect, p.pos.y + offset.y);
  return VSOut(vec4f(clip, 0.0, 1.0), c, p.life, p.band, spd);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let d  = length(in.local);
  if (d > 1.0) { discard; }

  let bi = u32(in.band + 0.5);

  // Each band reacts to its own audio signal
  // Base brightness per band
  var base: f32;
  if      (bi == 0u) { base = 0.30 + u.kick * 0.65 + u.snare * 0.35; }  // drums: dark → very bright on hit
  else if (bi == 1u) { base = 0.25 + u.bass * 0.55; }                    // bass: moderate, beat-reactive
  else if (bi == 2u) { base = 0.35 + u.mid  * 0.50 + u.kick  * 0.20; }  // lead: brightest, some kick cross
  else if (bi == 3u) { base = 0.10 + u.high * 0.70 + u.snare * 0.25; }  // atmos: dim sparkles, snare cross
  else               { base = 0.15 + u.sub_bass * 0.30; }                // pads: very dim, sub-bass glow

  // Shape: pads are soft blobs, drums are crisp, rest are normal dots
  var edge: f32;
  if (bi == 4u) {
    // Pads: very soft falloff — large diffuse blob
    edge = smoothstep(1.0, 0.0, d * d);
  } else if (bi == 0u) {
    // Drums: hard edge — sharp dot
    edge = smoothstep(1.0, 0.6, d);
  } else {
    // Default: medium crisp
    edge = smoothstep(1.0, 0.72, d);
  }

  // Speed-driven bright core — visible on fast-moving particles
  var core_scale = 0.0;
  if      (bi == 2u) { core_scale = 3.5; }   // lead: most streak-visible
  else if (bi == 0u) { core_scale = 2.5; }   // drums: visible streaks on impact
  else if (bi == 1u) { core_scale = 2.0; }   // bass: mild streak
  else if (bi == 3u) { core_scale = 4.0; }   // atmos: bright needle streaks
  else               { core_scale = 0.5; }   // pads: almost no streak (slow)
  let core = smoothstep(0.45, 0.0, d) * clamp(in.speed * core_scale, 0.0, 0.55);

  // Opacity scale per band — pads very transparent, lead most visible
  var opacity = 0.30;
  if      (bi == 0u) { opacity = 0.50; }
  else if (bi == 1u) { opacity = 0.35; }
  else if (bi == 2u) { opacity = 0.60; }
  else if (bi == 3u) { opacity = 0.45; }
  else               { opacity = 0.18; }   // pads: barely visible, texture only

  let alpha = in.life * edge;
  let bright = (base + core) * alpha * opacity;

  // Tonality color: -1=minor(cool blues/purples), 0=neutral, +1=major(warm ambers)
  let cool_hue    = vec3f(0.28, 0.42, 1.00);   // blue-violet for minor
  let neutral_hue = vec3f(0.82, 0.85, 1.00);   // faint cool white for neutral
  let warm_hue    = vec3f(1.00, 0.60, 0.08);   // amber-orange for major
  var tone_rgb: vec3f;
  if (u.tonality > 0.0) {
    tone_rgb = mix(neutral_hue, warm_hue, u.tonality);
  } else {
    tone_rgb = mix(neutral_hue, cool_hue, -u.tonality);
  }

  // Pulse: brief brightness flash on MIDI note attacks
  let pulse_boost = u.pulse * 0.25;

  // Color mode: each band gets a distinct hue for debugging
  var rgb: vec3f;
  if (u.color_mode > 0.5) {
    var band_rgb: vec3f;
    if      (bi == 0u) { band_rgb = vec3f(1.00, 0.15, 0.10); } // drums:  red
    else if (bi == 1u) { band_rgb = vec3f(0.10, 0.35, 1.00); } // bass:   blue
    else if (bi == 2u) { band_rgb = vec3f(0.10, 1.00, 0.25); } // lead:   green
    else if (bi == 3u) { band_rgb = vec3f(0.90, 0.10, 1.00); } // atmos:  magenta
    else               { band_rgb = vec3f(1.00, 0.55, 0.05); } // pads:   orange
    // In debug mode: mix band color with tonality (30% tonality tint)
    rgb = mix(band_rgb, band_rgb * tone_rgb * 1.6, 0.30);
  } else {
    rgb = tone_rgb;
  }

  let c = rgb * (bright + pulse_boost * alpha);
  return vec4f(c, bright + pulse_boost * alpha);
}
