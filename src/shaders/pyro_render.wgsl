// PYRO render — fullscreen pass over the temperature/smoke grid.
// Temperature → blackbody ramp (deep red → orange → yellow → white ~1.6 HDR
// only in the hottest core; mid-flame crosses the 0.30 bloom threshold
// gently). Soft wide-smoothstep body falloff, grey smoke wisps from the
// second channel, warm radial light spill (JS glow envelope with inertia),
// and a granular breathing coal bed built from the same hot-spot profile
// the sim injects from. Extra-slot map lives in pyro_sim.wgsl.

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

@group(0) @binding(0) var<uniform>       u:    Uniforms;
@group(0) @binding(1) var<storage, read> grid: array<vec2f>;

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

fn hash12(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 345.45));
  q += dot(q, q + 34.345);
  return fract(q.x * q.y);
}

fn vnoise(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p);
  let w = f * f * (3.0 - 2.0 * f);
  let a = hash12(i);
  let b = hash12(i + vec2f(1.0, 0.0));
  let c = hash12(i + vec2f(0.0, 1.0));
  let d = hash12(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

// blackbody-style ramp: deep red 1000K → orange → yellow → near-white
fn fire_ramp(t: f32) -> vec3f {
  let x = clamp(t, 0.0, 1.0);
  var c = vec3f(pow(x, 0.55), pow(x, 1.85) * 0.88, pow(x, 4.8) * 0.68);
  c += vec3f(0.55, 0.62, 0.62) * smoothstep(0.84, 1.0, x);
  return c;
}

fn sampleGrid(pc: vec2f, gw: i32, gh: i32) -> vec2f {
  let x = clamp(pc.x, 0.0, f32(gw) - 1.001);
  let y = clamp(pc.y, 0.0, f32(gh) - 1.001);
  let x0 = i32(floor(x)); let y0 = i32(floor(y));
  let fx = x - f32(x0);   let fy = y - f32(y0);
  let x1 = min(x0 + 1, gw - 1); let y1 = min(y0 + 1, gh - 1);
  let a = grid[u32(y0 * gw + x0)]; let b = grid[u32(y0 * gw + x1)];
  let c = grid[u32(y1 * gw + x0)]; let d = grid[u32(y1 * gw + x1)];
  return mix(mix(a, b, fx), mix(c, d, fx), fy);
}

@fragment
fn fs_render(in: VSOut) -> @location(0) vec4f {
  let E0 = u.extra[0];
  let gw = i32(E0.x);
  let gh = i32(E0.y);
  let quiet = E0.z;
  let E6 = u.extra[6];
  let glow  = E6.z;
  let E7 = u.extra[7];
  let asp = u.res_x / max(u.res_y, 1.0);

  // sim space: y up, row 0 at screen bottom
  let p = vec2f(in.uv.x, 1.0 - in.uv.y);
  let g = sampleGrid(p * vec2f(f32(gw), f32(gh)) - 0.5, gw, gh);
  let T = g.x;

  // ── flame body ────────────────────────────────────────────────────────
  // Render-side striation: fine advected noise splits the smooth sim field
  // into licking tongues (detail the half-res grid can't carry itself)
  let dq = vec2f(p.x * asp * 13.0, p.y * 8.0 - u.time * 3.6) + u.scene_seed * 4.7;
  let det = 0.58 + 0.78 * (vnoise(dq) * 0.65 + vnoise(dq * 2.3 + vec2f(11.7, 3.9)) * 0.35);
  let Td = T * mix(1.0, det, smoothstep(0.06, 0.40, T));
  // tight toe: lukewarm haze is invisible — no dark drapery around the fire
  let body = smoothstep(0.14, 0.52, Td);
  let Tc = clamp(Td, 0.0, 1.15);
  // ramp evaluated at 0.92·T: white only appears in the genuinely hottest
  // core; mid-flame sits orange-yellow, gently over the 0.30 bloom threshold
  var col = fire_ramp(Tc * 0.92) * (0.10 * Tc + 0.95 * pow(Tc, 2.3)) * body;

  // ── warm radial light spill around the bed (slow JS inertia) ──────────
  let sd = vec2f((p.x - E7.x) * asp, p.y + 0.05);
  let spill = exp(-(sd.x * sd.x * 0.9 + sd.y * sd.y * 2.6)) * (0.022 + glow * 0.085 + quiet * 0.02);
  col += fire_ramp(0.42) * spill;

  // ── granular breathing coal bed (dominant when the music dies) ────────
  if (p.y < 0.15) {
    var prof = 0.0;
    for (var k = 0u; k < 3u; k++) {
      let sp = u.extra[3u + k];
      var dx = (p.x - sp.x) * asp;
      prof += sp.y * exp(-dx * dx / 0.014);
      dx = (p.x - sp.z) * asp;
      prof += sp.w * exp(-dx * dx / 0.014);
    }
    let g1 = vnoise(vec2f(p.x * asp * 90.0, p.y * 140.0) + u.scene_seed * 13.0);
    let g2 = vnoise(vec2f(p.x * asp * 28.0 + 7.0, p.y * 40.0 - u.time * 0.20));
    let grain = smoothstep(0.42, 0.95, g1 * 0.6 + g2 * 0.4);
    let breath = 0.60 + 0.40 * sin(u.time * 1.25 + g1 * 9.0 + p.x * 30.0);
    let coal = grain * min(prof * 2.2, 1.2) * exp(-p.y / 0.05) * breath;
    col += fire_ramp(clamp(0.28 + coal * 0.42, 0.0, 0.72)) * coal * (0.75 + quiet * 2.2);
  }

  // near-black night backdrop; MIDI note attacks nudge the whole frame
  col = max(col, vec3f(0.004, 0.003, 0.003));
  col *= 1.0 + u.pulse * 0.12;
  return vec4f(col, 1.0);
}
