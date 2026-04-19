struct Uniforms {
  time:       f32, sub_bass:    f32, bass:       f32, mid:        f32,
  high:       f32, delta:       f32, res_x:      f32, res_y:      f32,
  frame:      f32, mul_sb:      f32, mul_bass:   f32, mul_mid:    f32,
  mul_high:   f32, spring:      f32, kick:       f32, snare:      f32,
  mode_drums: f32, mode_bass:   f32, mode_lead:  f32, mode_atmos: f32,
  mode_pads:  f32, color_mode:  f32, tonality:   f32, pulse:       f32,
  dissonance: f32, dis_strength: f32, _p2:         f32, _p3:        f32,
  ripple_pos_age: array<vec4f, 8>,
  ripple_color:   array<vec4f, 8>,
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
  @builtin(position) pos:       vec4f,
  @location(0)       local:     vec2f,
  @location(1)       life:      f32,
  @location(2)       band:      f32,
  @location(3)       speed:     f32,
  @location(4)       world_pos: vec2f,
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

  // Dissonance: each particle shakes at a unique phase — strong enough to see at field level
  let pi_f   = f32(pi);
  let dis    = u.dissonance * u.dis_strength;
  let jitter = dis * 0.055 * vec2f(
    sin(u.time * 11.0 + pi_f * 0.37) + 0.4 * sin(u.time * 19.0 + pi_f * 0.71),
    cos(u.time *  8.0 + pi_f * 0.53) + 0.4 * cos(u.time * 23.0 + pi_f * 0.91),
  );
  let clip = vec2f((p.pos.x + offset.x + jitter.x) / aspect, p.pos.y + offset.y + jitter.y);
  return VSOut(vec4f(clip, 0.0, 1.0), c, p.life, p.band, spd, p.pos);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  // Dissonance warps the particle boundary into an irregular, animated shape.
  // Consonance → clean circles; dissonance → jagged, unstable edges.
  let angle = atan2(in.local.y, in.local.x);
  let t     = u.time;
  let dis   = u.dissonance * u.dis_strength;
  let warp  = dis * (
    0.50 * sin(angle * 2.0 + t * 3.10) +
    0.35 * sin(angle * 3.0 - t * 2.30) +
    0.22 * sin(angle * 5.0 + t * 1.73)
  );
  let d = length(in.local) * (1.0 + warp);
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
  else if (bi == 1u) { opacity = clamp(u.mul_bass * 0.115, 0.04, 0.55); }
  else if (bi == 2u) { opacity = 0.60; }
  else if (bi == 3u) { opacity = 0.45; }
  else               { opacity = 0.18; }   // pads: barely visible, texture only

  let alpha = in.life * edge;
  // Dissonance flicker: rapid per-particle brightness instability
  let flicker = 1.0 + dis * 0.7 * sin(u.time * 31.0 + in.band * 4.3 + in.speed * 17.0);
  let bright = (base + core) * alpha * opacity * max(flicker, 0.0);

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

  // Ripple color tint — particles on the wave front take on the ripple color
  var rwave_sum: f32   = 0.0;
  var rcol_sum:  vec3f = vec3f(0.0);
  for (var ri = 0u; ri < 8u; ri++) {
    let rpa   = u.ripple_pos_age[ri];
    if (rpa.z < 0.0) { continue; }
    let dist  = length(in.world_pos - rpa.xy);
    let dring = (dist - rpa.z * 0.55) / 0.15;
    let env   = exp(-rpa.z * 2.0) * max(0.0, 1.0 - rpa.z / 2.5);
    let wave  = exp(-dring * dring) * env;
    rwave_sum += wave;
    rcol_sum  += u.ripple_color[ri].rgb * wave;
  }
  let tint = clamp(rwave_sum, 0.0, 1.0);

  var c = rgb * (bright + pulse_boost * alpha);
  if (tint > 0.02) {
    let avg_col = rcol_sum / (rwave_sum + 0.001);
    c = mix(c, avg_col * (bright * 1.6 + 0.03 * alpha), tint * 0.70);
  }
  return vec4f(c, bright + pulse_boost * alpha);
}
