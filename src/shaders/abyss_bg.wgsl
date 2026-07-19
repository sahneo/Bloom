// ABYSS background — the water itself. Fullscreen additive pass drawn under
// the plankton field:
//   • depth gradient: deep teal near the surface (top) → absolute black below
//   • volumetric god rays lancing down, animated by caustic interference —
//     the product of two slowly drifting cosine wavefront sums (NOT noise),
//     so the shafts sway and interfere like real refracted surface light
//   • marine snow: 3 parallax layers of sparse hashed particulate, slowly
//     sinking with the current, brighter where a ray shaft passes through
//
// World coords: y UP, x ∈ [−asp, asp], y ∈ [−1, 1].
//
// Repurposed uniform slots (owned by the ABYSS preset):
//   _r1 = ambient bioluminescent fog (smoothed bass)
//   _r2 = current swirl energy (smoothed mid, slew-limited)
//   _r3 = sparkle level (smoothed high)
//   extra[4] = (dropAge s, dropEnv 0..1, quiet 0..1, flowTime)
//   extra[6] = (tapX, tapY, tapEnv 0..1, tapAge s) — tap swirls the snow
//   extra[9] = (flowTime, —, —, —) — monotonic clock scaled by swirl energy

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

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0)       uv:  vec2f,   // clip coords, y up, [−1,1]
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(3.0, 1.0), vec2f(-1.0, 1.0));
  return VSOut(vec4f(p[vi], 0.0, 1.0), p[vi]);
}

fn hsv2rgb(c: vec3f) -> vec3f {
  let k = fract(vec3f(c.x, c.x + 2.0 / 3.0, c.x + 1.0 / 3.0)) * 6.0;
  let rgb = clamp(abs(k - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  return c.z * mix(vec3f(1.0), rgb, c.y);
}

fn hash21(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

// ── god rays: caustic interference of moving cosine wavefronts ────────────
// Two independent wavefront sums, each sheared differently with depth, are
// multiplied — their interference makes shafts brighten, split and drift
// exactly like sun rays refracted through a wavy surface.
fn rays(p: vec2f, t: f32) -> f32 {
  let s = u.scene_seed * 17.31;
  // shear grows with depth → rays fan out as they descend
  let x1 = p.x + (1.0 - p.y) * (0.28 + 0.05 * sin(t * 0.023 + s));
  let x2 = p.x + (1.0 - p.y) * (0.42 + 0.04 * sin(t * 0.031 + s * 1.7));
  let c1 = cos(x1 * 2.3 + t * 0.110 + s)
         + cos(x1 * 4.9 - t * 0.079 + s * 2.1)
         + cos(x1 * 8.1 + t * 0.061 + s * 3.7);
  let c2 = cos(x2 * 3.4 - t * 0.093 + s * 1.3)
         + cos(x2 * 6.6 + t * 0.071 + s * 2.9);
  let n1 = pow(clamp((c1 + 3.0) / 6.0, 0.0, 1.0), 4.5);
  let n2 = pow(clamp((c2 + 2.0) / 4.0, 0.0, 1.0), 3.0);
  // vertical extinction: light dies with depth
  let fade = pow(clamp(p.y * 0.62 + 0.62, 0.0, 1.0), 2.6);
  return n1 * (0.35 + 0.65 * n2) * fade;
}

// tap disturbance: whirl the sampling coords around the tap point
fn tapWhirl(p: vec2f, par: f32) -> vec2f {
  let tap = u.extra[6];
  if (tap.z < 0.01) { return p; }
  let rel  = p - tap.xy;
  let d    = length(rel);
  let ang  = tap.z * exp(-d * 3.0) * 1.6 * par;
  let ca   = cos(ang);
  let sa   = sin(ang);
  return tap.xy + vec2f(ca * rel.x - sa * rel.y, sa * rel.x + ca * rel.y);
}

// one parallax layer of marine snow; returns brightness at p
fn snowLayer(p: vec2f, t: f32, scale: f32, sink: f32, layer: f32, rayHere: f32) -> f32 {
  // the current sways the snow sideways; deeper layers lag behind
  let sway = vec2f(
    sin(t * 0.041 + layer * 2.7) * 0.10 + t * (0.006 + u._r2 * 0.012),
    t * sink);
  let q    = tapWhirl(p, 0.5 + layer * 0.35) + sway;
  let cell = floor(q * scale);
  let h    = hash21(cell + vec2f(layer * 71.3, u.scene_seed * 9.1));
  if (h > 0.16) { return 0.0; }                       // sparse: ~1 in 6 cells
  let jit  = vec2f(hash21(cell + vec2f(3.7, layer)), hash21(cell + vec2f(9.2, layer)));
  let fp   = fract(q * scale) - (0.15 + 0.7 * jit);
  let d    = length(fp) / scale;                       // world-space distance
  let r    = (2.6 / u.res_y) * (1.7 - layer * 0.4);    // near layers larger
  let dot_ = smoothstep(r, r * 0.25, d);
  // twinkle very slowly; rays light the snow as they pass
  let tw   = 0.75 + 0.25 * sin(t * 0.9 + h * 251.0);
  return dot_ * tw * (0.15 + rayHere * 1.6) * (1.0 - layer * 0.22);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let asp = u.res_x / max(u.res_y, 1.0);
  let p   = in.uv * vec2f(asp, 1.0);
  let t   = u.time;
  let dropv = u.extra[4];
  let dropEnv = dropv.y;

  // ── water body: teal near the surface, absolute black below ────────────
  let depth = clamp((1.0 - p.y) * 0.5, 0.0, 1.0);      // 0 top → 1 bottom
  let keyTint = hsv2rgb(vec3f(u.key_hue, 0.5, 1.0));
  var waterCol = mix(vec3f(0.012, 0.10, 0.115), keyTint * 0.10, u.key_conf * 0.35);
  var col = waterCol * exp(-depth * 4.2) * (1.0 + u._r1 * 0.5 + dropEnv * 0.7);

  // ── god rays ───────────────────────────────────────────────────────────
  let rayI = rays(p, t);
  let rayCol = mix(vec3f(0.30, 0.72, 0.78), keyTint, u.key_conf * 0.30);
  col += rayCol * rayI * (0.085 + u._r1 * 0.10 + dropEnv * 0.30);

  // ── ambient bioluminescent fog: bass breathing in the deep ─────────────
  let fogBand = exp(-(p.y + 0.35) * (p.y + 0.35) * 1.4);
  let fogWob  = 0.7 + 0.3 * sin(p.x * 1.7 + t * 0.13) * sin(p.y * 2.3 - t * 0.09);
  let planktonCol = mix(vec3f(0.05, 0.85, 0.80), keyTint, u.key_conf * 0.4);
  col += planktonCol * u._r1 * 0.035 * fogBand * fogWob;

  // ── marine snow: 3 parallax depths ─────────────────────────────────────
  let snowCol = vec3f(0.55, 0.72, 0.75);
  var snow = 0.0;
  snow += snowLayer(p * 1.00, t, 11.0, 0.020, 0.0, rayI);
  snow += snowLayer(p * 1.35, t, 17.0, 0.032, 1.0, rayI);
  snow += snowLayer(p * 1.80, t, 26.0, 0.047, 2.0, rayI);
  col += snowCol * snow * 0.16 * (1.0 + dropEnv * 0.8);

  let a = u.trail_gain;
  return vec4f(col * a, a);
}
