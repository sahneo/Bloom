// FROST — render. Macro-photography frost on dark glass: bilinear-sampled
// age field gives the ice body; fine fbm ridges are stretched along each
// crystal's lattice axis; the newest cells (small age) glint just over the
// bloom threshold; old ice goes matte. A faint cold gradient refracts
// through the ice. During shatter a voronoi crack web flashes white and
// shards displace/catch light.
// Extra slots (see frost_compute.wgsl):
//   extra[0] = (gridW, gridH, growthRate, meltRate)
//   extra[1] = (shatterEnv, kickEnv, snareEnv, dissolve)
//   extra[8] = (bassEnv, sparkleEnv, growthTexScale, shatterSeed)
//   extra[9] = (shiftIntX, shiftIntY, travelEnv, 0)  camera travel phase
//   extra[10] = (shiftFracX, shiftFracY, camU, camV)  sub-cell shift
//              remainder (cells) + accumulated camera offset (UV) — the
//              remainder smooths the cell-quantized glide, the offset keeps
//              ridge/lace textures anchored to the ice, and drives a subtle
//              background parallax

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
@group(0) @binding(1) var<storage, read> grid: array<vec2f>;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0)       uv:  vec2f,
}

@vertex
fn vs_fullscreen(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
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

fn fbm(p: vec2f) -> f32 {
  var v = 0.0; var amp = 0.5; var q = p;
  for (var i = 0; i < 4; i++) {
    v += vnoise(q) * amp;
    q = q * 2.07 + vec2f(13.7, 7.9);
    amp *= 0.5;
  }
  return v * 1.07;
}

fn hsv2rgb(c: vec3f) -> vec3f {
  let k = fract(vec3f(c.x, c.x + 2.0 / 3.0, c.x + 1.0 / 3.0)) * 6.0;
  let rgb = clamp(abs(k - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  return c.z * mix(vec3f(1.0), rgb, c.y);
}

fn cellAt(x: i32, y: i32) -> vec2f {
  let gw = i32(u.extra[0].x);
  let gh = i32(u.extra[0].y);
  let cx = clamp(x, 0, gw - 1);
  let cy = clamp(y, 0, gh - 1);
  return grid[u32(cy * gw + cx)];
}

// bilinear age — soft ice boundary; nearest lattice for ridge orientation
fn ageBilinear(uv: vec2f) -> f32 {
  let gw = u.extra[0].x; let gh = u.extra[0].y;
  let g = vec2f(uv.x * gw, uv.y * gh) - 0.5;
  let i = vec2i(i32(floor(g.x)), i32(floor(g.y)));
  let f = fract(g);
  let a = mix(cellAt(i.x, i.y).x,     cellAt(i.x + 1, i.y).x,     f.x);
  let b = mix(cellAt(i.x, i.y + 1).x, cellAt(i.x + 1, i.y + 1).x, f.x);
  return mix(a, b, f.y);
}

// wide tent sample — one-cell dendrite filaments become soft feathery
// strokes instead of pixel grit
fn ageSmooth(uv: vec2f) -> f32 {
  let gw = u.extra[0].x; let gh = u.extra[0].y;
  let d = vec2f(0.9 / gw, 0.9 / gh);
  return ageBilinear(uv) * 0.4
       + (ageBilinear(uv + vec2f( d.x,  d.y)) + ageBilinear(uv + vec2f(-d.x,  d.y))
        + ageBilinear(uv + vec2f( d.x, -d.y)) + ageBilinear(uv + vec2f(-d.x, -d.y))) * 0.15;
}

// voronoi crack web: returns (F1, F2, cellId.x, cellId.y)
fn voro(p: vec2f, seed: f32) -> vec4f {
  let i = floor(p); let f = fract(p);
  var f1 = 8.0; var f2 = 8.0; var id = vec2f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let g = vec2f(f32(x), f32(y));
      let o = vec2f(hash12(i + g + seed), hash12(i + g + seed + 7.3));
      let d = length(g + o - f);
      if (d < f1) { f2 = f1; f1 = d; id = i + g; }
      else if (d < f2) { f2 = d; }
    }
  }
  return vec4f(f1, f2, id);
}

// faint cold night-glass gradient behind the ice; cam = parallax offset —
// during camera travel the sheen drifts at a fraction of the ice speed
fn background(uv: vec2f, asp: f32, cam: vec2f) -> vec3f {
  let pa = vec2f(uv.x * asp, uv.y);
  var c = mix(vec3f(0.004, 0.007, 0.016), vec3f(0.010, 0.020, 0.046),
              smoothstep(1.15, -0.15, uv.y));
  // slow drifting cold sheen, barely there
  let n = fbm((pa + cam) * 1.6 + vec2f(u.time * 0.014, -u.time * 0.009) + u.scene_seed);
  c += vec3f(0.006, 0.013, 0.026) * smoothstep(0.45, 0.95, n);
  return c;
}

@fragment
fn fs_render(in: VSOut) -> @location(0) vec4f {
  let E0 = u.extra[0];
  let E1 = u.extra[1];
  let E8 = u.extra[8];
  let asp = u.res_x / max(u.res_y, 1.0);
  let shatter = E1.x;

  // ── shatter: voronoi shards displace the pane, cracks flash ─────────
  var suv = in.uv;
  var crack = 0.0;
  var facet = 0.5;
  if (shatter > 0.01) {
    let v = voro(vec2f(in.uv.x * asp, in.uv.y) * 5.0 + E8.w * 17.0, E8.w);
    crack = 1.0 - smoothstep(0.0, 0.045, v.y - v.x);
    facet = hash12(v.zw * 1.3 + E8.w);
    suv += (vec2f(facet, hash12(v.zw + 9.1)) - 0.5) * 0.020 * shatter;
  }

  // camera travel: the compute pass shifts whole cells; the fractional
  // remainder is applied here as a sampling offset so the glide is
  // sub-cell smooth instead of stepping cell by cell
  let E10 = u.extra[10];
  let gw  = E0.x; let gh = E0.y;
  let cuv = suv + vec2f(E10.x / gw, E10.y / gh);
  let aB  = ageSmooth(cuv);
  let lat = cellAt(i32(cuv.x * gw), i32(cuv.y * gh)).y;

  // ice body mask — melting softens the boundary
  let meltSoft = clamp(E0.w * 0.8, 0.0, 1.0);
  var m     = clamp(aB * mix(9.0, 3.5, meltSoft), 0.0, 1.0);
  var fresh = exp(-max(aB - 0.05, 0.0) * 2.1) * m;    // newest ice ≈ 1
  var thick = smoothstep(2.5, 11.0, aB);              // old, thick ice
  // while the crack web flashes, the old pane hides — dissolving debris
  // must not read as confetti under the flash
  let hide = 1.0 - clamp(shatter * 1.35, 0.0, 0.93);
  m *= hide; fresh *= hide; thick *= hide;

  // ── crystalline ridges stretched along the lattice axis ─────────────
  // world-anchored (camera offset added) so the striations travel WITH the
  // ice instead of swimming under it during camera motion
  let pa = vec2f((cuv.x + E10.z) * asp, cuv.y + E10.w);
  let ca = cos(lat); let sa = sin(lat);
  let q  = vec2f(dot(pa, vec2f(ca, sa)), dot(pa, vec2f(-sa, ca)));
  let ridge = fbm(q * vec2f(24.0, 110.0) + u.scene_seed * 5.0);
  // micro grain stays screen-anchored: at ×240 frequency a large world
  // offset would exhaust f32 hash precision, and at 0.022 amplitude the
  // swim is invisible anyway
  let qs = vec2f(suv.x * asp, suv.y);
  let q2 = vec2f(dot(qs, vec2f(ca, sa)), dot(qs, vec2f(-sa, ca)));
  let ridge2 = fbm(q2 * vec2f(60.0, 240.0) + 31.7);

  // lace density — same macro gate the growth uses, so shading follows
  // the dendrite structure: thin translucent ice near the dark veins
  let lace = 0.30 + 0.70 * smoothstep(0.44, 0.64, fbm(pa * E8.z + u.scene_seed * 7.31));

  // ── cold palette: key hue folded into the blue/cyan band ────────────
  let hue = 0.52 + fract(u.key_hue) * 0.14 + u.tension * 0.045;
  let sat = 0.52 + thick * 0.14 + u.tension * 0.18;
  let iceCol   = hsv2rgb(vec3f(hue, sat, 1.0));
  let glintCol = hsv2rgb(vec3f(hue - 0.02, 0.30, 1.0));  // pale ice-blue glint

  // ── compose ─────────────────────────────────────────────────────────
  // glass with subtle refraction shimmer through the ice
  let refr = (ridge - 0.5) * 0.020 * m;
  let camPar = vec2f(E10.z * asp, E10.w) * 0.35;   // background lags the ice
  var col = background(suv + refr, asp, camPar) * (1.0 - m * 0.72 * lace);

  // matte ice body: dark, contrasty, striated along the crystal axis
  let body = (0.014 + ridge * ridge * 0.085 + ridge2 * 0.022 + thick * 0.022) * lace;
  col += iceCol * body * m;

  // growth front: sparkling glint just over the 0.30 bloom threshold
  let flick = 0.72 + 0.28 * hash12(floor(in.pos.xy * 0.5) + floor(u.time * 18.0) * 3.1);
  col += glintCol * fresh * (0.36 + E1.y * 0.55 + u.drop_pulse * 0.3) * flick
       * (0.45 + ridge * 1.0);

  // bass: deep glow pulsing inside thick ice
  col += hsv2rgb(vec3f(hue + 0.02, 0.85, 1.0)) * thick * lace * E8.x * 0.14;

  // snare-driven glitter: rare hot flecks only on ridge crests
  let spN = hash12(floor(in.pos.xy * 0.31) + floor(u.time * 11.0) * 5.3);
  let thr = 0.9993 - E8.y * 0.0018 - u.high * 0.0004;
  col += vec3f(0.95, 1.05, 1.20) * step(thr, spN) * m
       * smoothstep(0.45, 0.7, ridge2) * (0.3 + E8.y * 1.2 + u.high * 0.5);

  // shatter: shards catch light, crack web flashes hot white-blue
  if (shatter > 0.01) {
    col *= 1.0 + shatter * (facet - 0.35) * 0.9 * (0.25 + m);
    col += vec3f(0.85, 0.95, 1.15) * crack * shatter * shatter * 1.7;
  }

  // vignette keeps it a dark pane, not a wallpaper
  let d = in.uv - vec2f(0.5);
  col *= 1.0 - dot(d, d) * 0.72;

  return vec4f(col, 1.0);
}
