// MITOSIS — living cells under a dark-field microscope. A colony of soft
// cells floats in black fluid: rim-lit membranes with a chromatic fringe,
// translucent cytoplasm shaded brighter toward the membrane (dark-field
// scattering), a denser stained nucleus per cell, and shimmering organelle
// specks. Cells DIVIDE: two SDF lobes separate under a smin bridge whose
// waist narrows until the membrane snaps. JS owns the colony simulation
// (storage buffer below); this shader only draws.
//
// Storage buffer `cells` — array<Cell, 24>, 3 × vec4f per cell:
//   c0 = (x, y, radius, seed)          world coords: x∈[-aspect,aspect], y up
//   c1 = (divideQ, dirX, dirY, wob)    q 0..1 division progress, dir = axis,
//                                      wob = jiggle/poke energy
//   c2 = (alpha, born, dentX, dentY)   alpha = life fade (apoptosis),
//                                      born = post-division glow,
//                                      dent = poke dent dir × amplitude
//
// Uniform extra region (u.extra, 16 vec4f at byte offset 176):
//   extra[0] = (bassEnv, midEnv, highEnv, kickEnv)   smoothed envelopes
//   extra[1] = (snareEnv, cellCount, dropEnv, dimEnv) dim = quiet-passage fade
//   extra[2..15] unused

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

struct Cell {
  c0: vec4f,
  c1: vec4f,
  c2: vec4f,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> cells: array<Cell, 24>;

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

fn hash21(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn hash22(p: vec2f) -> vec2f {
  let q = vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)));
  return fract(sin(q) * 43758.5453);
}

fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let w = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i),                  hash21(i + vec2f(1.0, 0.0)), w.x),
             mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), w.x), w.y);
}

fn fbm(p: vec2f) -> f32 {
  var v = 0.0;
  var a = 0.5;
  var q = p;
  for (var i = 0; i < 3; i++) {
    v += a * vnoise(q);
    q = q * 2.03 + vec2f(11.7, 5.3);
    a *= 0.5;
  }
  return v;
}

fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// Stained nucleus: dense body + envelope rim + nucleolus speck.
fn nucleus(p: vec2f, cn: vec2f, rn: f32, seed: f32, kick: f32) -> vec3f {
  let hue  = fract(u.key_hue + 0.5);            // histology counterstain
  let body = hsv2rgb(vec3f(hue, 0.55, 1.0));
  let dn = length(p - cn) - rn;
  var v = vec3f(0.0);
  // chromatin body — soft dense disk, faintly kick-flashed
  v += body * 0.115 * smoothstep(0.006, -rn * 0.45, dn) * (1.0 + kick * 1.5);
  // mottled chromatin texture
  if (dn < 0.0) {
    let n = fbm((p - cn) * (9.0 / max(rn, 1e-3)) * 0.35 + vec2f(seed * 13.1, -seed * 7.7));
    v += body * n * 0.10 * smoothstep(0.0, -rn * 0.3, dn);
  }
  // nuclear envelope — thin rim
  v += body * exp(-dn * dn / (0.0028 * 0.0028)) * 0.14;
  // nucleolus
  let cno = cn + vec2f(sin(seed * 41.0), cos(seed * 33.0)) * rn * 0.35;
  let dno = length(p - cno);
  v += body * exp(-dno * dno / (rn * rn * 0.02)) * 0.17 * (1.0 + kick * 1.2);
  return v;
}

@fragment
fn fs_render(in: VSOut) -> @location(0) vec4f {
  let aspect = u.res_x / max(u.res_y, 1.0);
  let p = vec2f((in.uv.x - 0.5) * 2.0 * aspect, (0.5 - in.uv.y) * 2.0);

  let E0 = u.extra[0];    // bass, mid, high, kick
  let E1 = u.extra[1];    // snare, count, dropEnv, dim
  let count = i32(E1.y + 0.5);
  let dim = E1.w;
  let t = u.time;
  let ss = u.scene_seed;

  // ── dark-field fluid: near-black with faint illumination + dust ─────────
  var col = vec3f(0.0030, 0.0040, 0.0055) * (0.65 + 0.35 * exp(-dot(p, p) * 0.30));
  let haze = fbm(p * 0.8 + vec2f(t * 0.012 + ss, -t * 0.009));
  col += vec3f(0.006, 0.008, 0.011) * haze * haze;
  // drifting dust motes, two depth layers, whisper-faint
  for (var l = 0; l < 2; l++) {
    let fl = f32(l);
    let sc = 7.0 + fl * 6.0;
    let g = p * sc + vec2f(t * (0.05 + fl * 0.04), t * (0.03 - fl * 0.05)) + vec2f(ss * 9.0 + fl * 37.0);
    let id = floor(g);
    let fr = fract(g);
    let h = hash22(id);
    if (h.y > 0.82) {
      let mp = 0.5 + 0.34 * sin(h * 43.0 + t * vec2f(0.31, 0.43));
      let md = length(fr - mp);
      col += vec3f(0.012, 0.015, 0.019)
           * exp(-md * md * (110.0 + fl * 160.0))
           * (0.4 + 0.6 * sin(t * (0.5 + h.x) + h.y * 30.0))
           * (0.7 + E0.z * 0.8);
    }
  }

  // ── colony ──────────────────────────────────────────────────────────────
  let memCol = hsv2rgb(vec3f(u.key_hue, 0.52, 1.0));
  let cytoCol = hsv2rgb(vec3f(fract(u.key_hue + 0.04), 0.15, 1.0));

  for (var i = 0; i < 24; i++) {
    if (i >= count) { break; }
    let C = cells[i];
    let c = C.c0.xy;
    let r = C.c0.z;
    if (r < 0.004) { continue; }
    // cheap bound: lobes reach at most c ± 1.05r, lobe radius 0.74r, + halo
    let rel = p - c;
    if (dot(rel, rel) > (r * 2.0 + 0.22) * (r * 2.0 + 0.22)) { continue; }

    let seed  = C.c0.w;
    let q     = C.c1.x;
    let wob   = C.c1.w;
    let alpha = C.c2.x;
    let born  = C.c2.y;
    let dent  = C.c2.zw;

    // breathing on the bass — per-cell phase so the colony never pulses as one
    let br = 1.0 + E0.x * 0.06 * (0.45 + 0.55 * sin(t * 2.3 + seed * 29.0));

    // ── SDF: single body, or two lobes with a narrowing waist ─────────────
    var d: f32;
    var cA = c;
    var cB = c;
    var rl = r * br;
    if (q > 0.001) {
      let dir = C.c1.yz;
      let sep = r * (0.35 * smoothstep(0.0, 0.4, q) + 0.70 * smoothstep(0.4, 1.0, q));
      rl = r * mix(0.88, 0.74, smoothstep(0.0, 0.9, q)) * br;
      let kk = r * mix(0.50, 0.030, smoothstep(0.30, 0.92, q));
      cA = c + dir * sep;
      cB = c - dir * sep;
      d = smin(length(p - cA) - rl, length(p - cB) - rl, kk);
    } else {
      d = length(rel) - rl;
    }

    // membrane wobble — low-order angular harmonics riding the mids;
    // poked or newborn cells (wob) tremble harder and faster
    let ang = atan2(rel.y, rel.x);
    // static low-order irregularity: no cell is a perfect circle
    d -= (sin(ang * 2.0 + seed * 11.0) * 0.55 + sin(ang * 3.0 + seed * 47.0) * 0.45) * r * 0.028;
    let wamp = r * (0.016 + E0.y * 0.042 + wob * 0.05);
    d -= (sin(ang * 3.0 + seed * 9.0 + t * 0.9)  * 0.55
        + sin(ang * 5.0 - t * 1.3 + seed * 23.0) * 0.30
        + sin(ang * 7.0 + t * (2.1 + wob * 6.0) + seed * 5.0) * 0.15) * wamp;

    // poke dent — membrane caves in on the tapped side
    let dAmp = length(dent);
    if (dAmp > 0.001) {
      let dd = dent / dAmp;
      d += dAmp * r * 0.55 * pow(max(dot(normalize(rel), dd), 0.0), 8.0);
    }

    // ── membrane: dark-field rim with chromatic fringe ────────────────────
    let w = 0.0045 + r * 0.011;
    let cf = w * 0.85;
    let gR = exp(-(d - cf) * (d - cf) / (w * w));
    let gG = exp(-d * d / (w * w));
    let gB = exp(-(d + cf) * (d + cf) / (w * w));
    var rimI = (0.44 + born * 0.60 + wob * 0.20 + E1.z * 0.30 + E0.w * 0.05)
             * (0.72 + 0.28 * dim);
    // rim never uniform: light comes from one side of the field
    rimI *= 0.75 + 0.25 * sin(ang + 2.2 + seed);
    col += vec3f(gR * memCol.r, gG * memCol.g, gB * memCol.b) * rimI * alpha;
    // scattered halo just outside the membrane
    col += memCol * exp(-max(d, 0.0) * 24.0) * 0.040 * alpha * (0.6 + 0.4 * dim);

    // ── interior ──────────────────────────────────────────────────────────
    let inside = smoothstep(0.004, -0.008, d);
    if (inside > 0.004) {
      let depth = clamp(-d / max(r, 1e-3), 0.0, 1.0);   // 0 at membrane → core
      // cytoplasm: edge-lit translucency (dark-field scatters at boundaries)
      let cytoI = mix(0.135, 0.028, smoothstep(0.0, 0.55, depth));
      let lc = rel / max(r, 1e-3);
      let mottle = fbm(lc * 3.2 + vec2f(seed * 7.0, -seed * 3.0) + vec2f(t * 0.03, -t * 0.02));
      // near the membrane the cytoplasm picks up the rim's stain
      let cCol = mix(cytoCol, memCol, smoothstep(0.35, 0.0, depth) * 0.45);
      var interior = cCol * cytoI * (0.55 + 0.85 * mottle) * dim;

      // organelles — shimmering specks in cell-local coords (drift with cell)
      let og = lc * 5.5 + vec2f(seed * 3.7, seed * 8.1);
      let oid = floor(og);
      let ofr = fract(og);
      var spark = 0.0;
      for (var oy = -1; oy <= 1; oy++) {
        for (var ox = -1; ox <= 1; ox++) {
          let off = vec2f(f32(ox), f32(oy));
          let h = hash22(oid + off);
          if (h.x < 0.42) { continue; }
          let op = off + 0.5 + 0.32 * sin(h * 47.0 + t * (0.4 + h.x * 0.5));
          let od = length(ofr - op);
          let tw = 0.5 + 0.5 * sin(t * (2.5 + h.x * 8.0) + h.y * 40.0);
          spark += exp(-od * od * 95.0) * (0.45 + E0.z * 1.3 * tw);
        }
      }
      interior += cytoCol * spark * 0.22 * smoothstep(0.10, 0.35, depth) * dim;

      // nucleus / nuclei — the nucleus divides first, then the cell follows
      if (q > 0.05) {
        interior += nucleus(p, cA, rl * 0.33, seed,        E0.w) * dim;
        interior += nucleus(p, cB, rl * 0.33, seed + 4.7,  E0.w) * dim;
      } else {
        let no = vec2f(sin(t * 0.11 + seed * 31.0), cos(t * 0.09 + seed * 17.0)) * r * 0.16;
        interior += nucleus(p, c + no, rl * 0.33, seed, E0.w) * dim;
      }

      col += interior * inside * alpha;
    }
  }

  // ── field finish: vignette + faint sensor grain ─────────────────────────
  col *= 1.0 - dot(p, p) * 0.055;
  let g = hash21(in.uv * u.res_x + vec2f(fract(t) * 17.0, fract(t * 0.7) * 9.0));
  col *= 1.0 + (g - 0.5) * 0.10;

  return vec4f(max(col, vec3f(0.0)), 1.0);
}
