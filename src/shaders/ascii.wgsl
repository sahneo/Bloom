// ASCII visualizer — fullscreen pass.
// Screen is quantized into a character grid; a procedural density field is
// evaluated at each cell center and mapped to a glyph from the atlas.
// Monochrome: white/gray glyphs on black.

struct Uniforms {
  res_x: f32,       res_y: f32,    cell_w: f32,      cell_h: f32,
  time_s: f32,      seed: f32,     glyph_count: f32, atlas_cols: f32,
  scene_a: f32,     scene_b: f32,  blend: f32,       scroll: f32,
  sil_index: f32,   reveal: f32,   seed_a: f32,      atlas_rows: f32,
  sil_uv: vec4f,                       // region offset.xy + scale.zw in atlas UV
  bass: f32,        mid: f32,      high: f32,        sub_bass: f32,
  kick: f32,        snare: f32,    beat_t: f32,      pulse: f32,
  dissonance: f32,  tonality: f32, seed_b: f32,      beat_conf: f32,
  anim: vec4f,                         // walker_x, bird_x, bird_y, bird_frame (<0 = hidden)
  anim2: vec4f,                        // walker_frame, _, _, _
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var glyph_tex: texture_2d<f32>;
@group(0) @binding(2) var sil_tex:   texture_2d<f32>;
@group(0) @binding(3) var samp:      sampler;

// Glyph cell size in the atlas, must match GLYPH_W/GLYPH_H in ascii.js
const GLYPH_PX = vec2f(16.0, 32.0);

// Scenery / sprite art lives in regions of the silhouette atlas (4×3 grid)
const REG_V    = 0.3333333;
const PALM_UV  = vec4f(0.5,  REG_V,       0.25, REG_V);   // region 6
const CAR_UV   = vec4f(0.75, REG_V,       0.25, REG_V);   // region 7
const BIRD_A_UV = vec4f(0.25, REG_V * 2.0, 0.25, REG_V);  // region 9 (wings up)
const BIRD_B_UV = vec4f(0.5,  REG_V * 2.0, 0.25, REG_V);  // region 10 (wings down)
const WALK_A_UV = vec4f(0.0,  REG_V,       0.25, REG_V);  // region 4 (stride)
const WALK_B_UV = vec4f(0.0,  REG_V * 2.0, 0.25, REG_V);  // region 8 (legs passing)

// ── Hash / noise ─────────────────────────────────────────────────────
// Integer hash (no sin — sin-based hashes show banding on Apple GPUs).
fn hash21(p: vec2f) -> f32 {
  let q = bitcast<vec2u>(vec2i(floor(p * 1024.0)));
  var n = (q.x * 1597334673u) ^ (q.y * 3812015801u);
  n = (n ^ (n >> 16u)) * 2246822519u;
  n = (n ^ (n >> 13u)) * 3266489917u;
  return f32(n ^ (n >> 16u)) * (1.0 / 4294967296.0);
}

fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let s = f * f * (3.0 - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2f(1.0, 0.0));
  let c = hash21(i + vec2f(0.0, 1.0));
  let d = hash21(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}

fn fbm(p0: vec2f) -> f32 {
  var p = p0;
  var amp = 0.5;
  var sum = 0.0;
  for (var i = 0; i < 5; i++) {
    sum += amp * vnoise(p);
    p = p * 2.03 + vec2f(17.7, 9.2);
    amp *= 0.5;
  }
  return sum;
}

// Ridged fbm — jagged variant for minor tonality
fn rfbm(p0: vec2f) -> f32 {
  var p = p0;
  var amp = 0.5;
  var sum = 0.0;
  for (var i = 0; i < 4; i++) {
    sum += amp * abs(vnoise(p) * 2.0 - 1.0);
    p = p * 2.07 + vec2f(11.3, 5.1);
    amp *= 0.5;
  }
  return sum;
}

// ── Scenes ───────────────────────────────────────────────────────────
// p: cell center, aspect-corrected, centered, y up (y in [-0.5, 0.5]).
// t: accumulated scroll (audio-paced). seed: per-scene layout seed.
// Return density 0..1.

fn scene_clouds(p: vec2f, t: f32, seed: f32) -> f32 {
  let q = p * 2.2 + vec2f(t * 0.5 + seed, t * 0.07);
  let warp_amp = 0.55 + u.bass * 1.1;
  let smooth_w = vec2f(fbm(q + vec2f(0.0, 3.7)), fbm(q + vec2f(5.2, 1.3)));
  let jagged_w = vec2f(rfbm(q + vec2f(0.0, 3.7)), rfbm(q + vec2f(5.2, 1.3)));
  let w = mix(jagged_w, smooth_w, clamp(u.tonality * 0.5 + 0.5, 0.0, 1.0));
  let n = fbm(q + (w - 0.5) * warp_amp * 2.0);
  return smoothstep(0.38, 0.78, n);
}

fn scene_waves(p: vec2f, t: f32, seed: f32) -> f32 {
  // sea level: bass swell + a gentle breath locked to the beat
  let level = -0.06 + u.bass * 0.28 + u.beat_conf * 0.04 * sin(6.2832 * u.beat_t);
  let n = fbm(vec2f(p.x * 1.6 + t * 1.2 + seed, p.y * 5.0 + t * 0.2));
  let ripple = sin(p.x * 9.0 - t * 5.0 + p.y * 24.0) * (0.035 + u.kick * 0.05);
  let surf = level + (n - 0.5) * (0.28 + u.mid * 0.2) + ripple;
  let depth = surf - p.y;                              // > 0 under the surface
  var d = smoothstep(0.0, 0.35, depth) * 0.8;          // water body
  d += smoothstep(0.03, 0.0, abs(depth)) * 0.6;        // bright crest line
  // sky: faint horizontal streaks
  d += step(depth, 0.0)
     * smoothstep(0.6, 0.9, fbm(vec2f(p.x * 1.2 + t * 0.3 + seed, p.y * 6.0))) * 0.25;
  return clamp(d, 0.0, 1.0);
}

fn scene_forest(p: vec2f, t: f32, seed: f32) -> f32 {
  let sx = p.x + t * 0.15 + seed;
  let col = floor(sx * 26.0);
  let presence = step(hash21(vec2f(col, seed)), 0.55);
  let cx = fract(sx * 26.0) - 0.5;
  let width = 0.10 + hash21(vec2f(col, 7.7)) * 0.14;
  let top = -0.1 + hash21(vec2f(col, 3.1)) * 0.55;
  let trunk = presence * step(abs(cx), width) * step(p.y, top) * 0.85;
  // canopy
  let can = fbm(vec2f(sx * 2.5, p.y * 3.0)) * smoothstep(0.0, 0.3, p.y);
  var d = max(trunk, smoothstep(0.45 - u.mid * 0.18, 0.8, can));
  // ground fog (sub bass)
  d = max(d, smoothstep(-0.25, -0.5, p.y) * (0.15 + u.sub_bass * 0.8)
            * fbm(vec2f(sx * 3.0 + t, p.y * 8.0)));
  return clamp(d, 0.0, 1.0);
}

fn scene_rain(p: vec2f, t: f32, seed: f32) -> f32 {
  let col = floor((p.x + seed) * 70.0);
  let ch = hash21(vec2f(col, seed));
  let speed = 1.2 + ch * 2.0;
  let v = p.y * 0.9 + t * speed + ch * 13.0;
  let phase = fract(v);
  let sid = floor(v);
  let drop = step(hash21(vec2f(col, sid)), 0.3 + u.high * 0.5);
  let streak = drop * smoothstep(0.45, 0.0, phase);
  // heavy clouds at the top
  let cl = smoothstep(0.55, 0.85, fbm(vec2f(p.x * 2.0 + t * 0.3 + seed, p.y * 3.0)))
         * smoothstep(0.15, 0.45, p.y) * 0.55;
  return clamp(max(streak, cl), 0.0, 1.0);
}

fn scene_stars(p: vec2f, t: f32, seed: f32) -> f32 {
  let g = floor(p * 44.0 + seed);
  let h = hash21(g);
  let tw = 0.5 + 0.5 * sin(u.time_s * (2.0 + h * 5.0) + h * 40.0);
  var star = step(0.985, h) * (0.45 + 0.55 * tw + u.snare * 1.2);
  let neb = fbm(p * 1.8 + vec2f(t * 0.15 + seed, 0.0));
  return clamp(star + smoothstep(0.55, 0.95, neb) * (0.3 + u.mid * 0.3), 0.0, 1.0);
}

fn scene_mountains(p: vec2f, t: f32, seed: f32) -> f32 {
  var d = 0.0;
  for (var i = 0; i < 3; i++) {
    let fi = f32(i);
    let ridge = -0.32 + fi * 0.14 + u.bass * 0.07 * (1.0 - fi * 0.3)
      + fbm(vec2f(p.x * (1.2 + fi * 0.7) + t * (0.1 + fi * 0.15) + fi * 37.0 + seed, fi * 5.0))
      * (0.45 - fi * 0.1);
    let below = step(p.y, ridge);
    let shade = 0.85 - fi * 0.27;                 // nearer = denser
    let tex = 0.75 + 0.25 * fbm(p * (6.0 + fi * 2.0) + seed);
    d = max(d, below * shade * tex);
    d = max(d, smoothstep(0.015, 0.0, abs(p.y - ridge)) * (0.4 + u.mid * 1.0));
  }
  return clamp(d, 0.0, 1.0);
}

fn sample_atlas(region: vec4f, lp: vec2f) -> f32 {
  if (any(lp < vec2f(0.0)) || any(lp > vec2f(1.0))) { return 0.0; }
  return textureSampleLevel(sil_tex, samp, region.xy + lp * region.zw, 0.0).r;
}

fn scene_palms(p: vec2f, t: f32, seed: f32) -> f32 {
  var d = 0.0;
  // synthwave sun with scanline gaps that widen toward the horizon
  let r = length(vec2f(p.x, p.y - 0.04));
  if (r < 0.31) {
    var sun = 1.0 - smoothstep(0.285, 0.31, r);
    let gap = smoothstep(0.20, -0.20, p.y) * 0.5;
    if (fract((p.y - t * 0.04) * 16.0) < gap) { sun = 0.0; }
    d = max(d, sun * 0.95);
  }
  // sea shimmer below the horizon
  if (p.y < -0.14) {
    let row = floor(p.y * 44.0);
    let sh = step(hash21(vec2f(row, floor(t * 2.5) + seed)), 0.4);
    d = max(d, sh * smoothstep(-0.55, -0.14, p.y) * (0.2 + u.bass * 0.35)
             * fbm(vec2f(p.x * 3.0 - t * 1.5, row)));
  }
  // black palms on both sides, top sways with mid
  let lpy = 0.45 - p.y;
  let sway = sin(t * 1.6 + lpy * 2.0) * (0.012 + u.mid * 0.05) * (1.0 - lpy);
  let mL = sample_atlas(PALM_UV, vec2f((p.x + 0.86) / 0.5 + sway, lpy));
  let mR = sample_atlas(PALM_UV, vec2f((0.86 - p.x) / 0.5 - sway, lpy));
  let palm = max(mL, mR);
  return clamp(max(d * (1.0 - palm * 0.95), palm * 0.14), 0.0, 1.0);
}

fn scene_car(p: vec2f, t: f32, seed: f32) -> f32 {
  var d = 0.0;
  // distant ridge
  let ridge = -0.02 + fbm(vec2f(p.x * 1.5 + t * 0.15 + seed, 3.0)) * 0.12;
  d = max(d, step(p.y, ridge) * smoothstep(ridge - 0.25, ridge, p.y) * 0.22);
  // road
  if (p.y < -0.19) {
    d = max(d, 0.10 + fbm(vec2f(p.x * 6.0 - t * 3.0, p.y * 8.0)) * 0.12);
    let dash = step(fract(p.x * 2.5 - t * 5.0), 0.45)
             * smoothstep(0.018, 0.0, abs(p.y + 0.30));
    d = max(d, dash * 0.85);
    d = max(d, smoothstep(0.010, 0.0, abs(p.y + 0.205)) * 0.5);
  }
  // speed streaks flying past (high band adds more)
  let row = floor(p.y * 30.0 + seed);
  let rh = hash21(vec2f(row, seed));
  let sx = p.x * (0.8 + rh) - t * (6.0 + rh * 4.0) + rh * 9.0;
  let streak = step(hash21(vec2f(row, floor(sx))), 0.10 + u.high * 0.25)
             * smoothstep(0.5, 0.0, fract(sx))
             * step(p.y, 0.45) * step(-0.18, p.y);
  d = max(d, streak * 0.4);
  // the car — bobs on kick; dark halo carves it out of the background
  let bob = u.kick * 0.025 + sin(t * 8.0) * 0.004;
  let m = sample_atlas(CAR_UV, vec2f((p.x + 0.35) / 0.7, (0.62 - p.y + bob) / 1.4));
  d = d * (1.0 - smoothstep(0.03, 0.30, m) * 0.85);
  d = max(d, smoothstep(0.45, 0.60, m) * 0.95);
  return clamp(d, 0.0, 1.0);
}

fn scene_city(p: vec2f, t: f32, seed: f32) -> f32 {
  var d = 0.0;
  // moon
  d = max(d, (1.0 - smoothstep(0.06, 0.075, length(p - vec2f(-0.55, 0.30)))) * 0.9);
  // two skyline layers with parallax
  for (var i = 0; i < 2; i++) {
    let fi = f32(i);                                  // 0 = far, 1 = near
    let scale = 9.0 + fi * 5.0;
    let bx = p.x + t * (0.05 + fi * 0.10) + fi * 13.7 + seed;
    let col = floor(bx * scale);
    let h = hash21(vec2f(col, seed + fi * 5.0));
    let top = -0.15 + h * (0.30 + fi * 0.22);
    let in_b = step(p.y, top) * step(0.12, fract(bx * scale));   // gaps between towers
    var v = in_b * (0.10 + fi * 0.12);                // towers as dark masses
    // lit windows, gentle flicker, brighten with high band
    let g = floor(vec2f(bx * scale * 6.0, p.y * 26.0));
    let lit = step(0.80, hash21(g + seed))
            * step(hash21(g + floor(u.time_s * 1.5)), 0.97);
    v = max(v, in_b * lit * (0.5 + u.high * 0.4));
    d = max(d, v);
  }
  return clamp(d, 0.0, 1.0);
}

fn scene_matrix(p: vec2f, t: f32, seed: f32) -> f32 {
  // dense digital rain: bright heads falling, tails fading above them
  let col = floor((p.x + seed) * 48.0);
  let ch = hash21(vec2f(col, seed));
  let v = p.y * 1.2 + t * (1.2 + ch * 3.5) + ch * 31.0;
  let phase = fract(v);
  let stream = step(hash21(vec2f(col, floor(v))), 0.65);
  var d = stream * pow(1.0 - phase, 2.2) * 0.75;
  d = max(d, stream * step(phase, 0.06));            // white-hot head cell
  return clamp(d * (0.55 + u.mid * 0.5), 0.0, 1.0);
}

fn scene_eye(p: vec2f, t: f32, seed: f32) -> f32 {
  var d = 0.0;
  // blink cycle on wall clock (~8s) — scroll is too slow in silence
  let c = fract(u.time_s * 0.12 + seed);
  let open = smoothstep(0.0, 0.05, c) * (1.0 - smoothstep(0.95, 1.0, c));
  if (abs(p.x) < 0.66) {
    let xn = p.x / 0.66;
    let lid = 0.30 * open * (1.0 - xn * xn);
    let inside = step(abs(p.y), lid);
    d = inside * 0.13;                               // sclera
    let r = length(p);
    let ang = atan2(p.y, p.x);
    // iris with radial streaks
    let iris = inside * step(r, 0.17)
             * (0.35 + 0.35 * fbm(vec2f(ang * 3.0, r * 14.0) + seed) + u.mid * 0.2);
    d = max(d, iris);
    let pupil = 0.05 + u.bass * 0.05;                // dilates with bass
    d = d * (1.0 - step(r, pupil));
    d = max(d, (1.0 - smoothstep(0.0, 0.025, length(p - vec2f(0.05, 0.06)))) * 0.9 * inside);
    // bright lash line — becomes a single closed-lid line mid-blink
    d = max(d, smoothstep(0.025, 0.0, abs(abs(p.y) - lid)) * 0.75 * step(abs(p.y), lid + 0.03));
  }
  // murk around the eye
  d = max(d, smoothstep(0.7, 1.2, length(p)) * 0.12 * fbm(p * 3.0 + vec2f(t * 0.2, 0.0)));
  return clamp(d, 0.0, 1.0);
}

fn scene_storm(p: vec2f, t: f32, seed: f32) -> f32 {
  // heavy cloud deck
  var d = smoothstep(0.5, 0.85, fbm(vec2f(p.x * 1.8 + t * 0.6 + seed, p.y * 2.5 - t * 0.1)))
        * smoothstep(-0.05, 0.3, p.y) * 0.7;
  // ground silhouette
  let g = -0.38 + fbm(vec2f(p.x * 2.0 + seed, 7.0)) * 0.08;
  d = max(d, step(p.y, g) * 0.5);
  // lightning in ~0.7s windows; loud snares strike more often
  let cell = floor(u.time_s * 1.43);
  let strike = step(hash21(vec2f(cell, seed)), 0.18 + u.snare * 0.55);
  let flash = strike * exp(-fract(u.time_s * 1.43) * 9.0);
  let bx = (hash21(vec2f(cell, 3.0)) - 0.5) * 1.2;
  let bolt_x = bx + (vnoise(vec2f(p.y * 6.0, cell * 7.0)) - 0.5) * 0.3 * (0.45 - p.y);
  let bolt = smoothstep(0.022, 0.0, abs(p.x - bolt_x)) * step(p.y, 0.5) * step(g - 0.02, p.y);
  d = max(d, bolt * flash * 1.2);
  d += flash * 0.15;                                 // whole-sky flash
  return clamp(d, 0.0, 1.0);
}

fn scene_invaders(p: vec2f, t: f32, seed: f32) -> f32 {
  // classic crab invader, two animation frames, 11×8 bit sprites
  var rows_a = array<u32, 8>(0x104u, 0x088u, 0x1FCu, 0x36Eu, 0x7FFu, 0x5FDu, 0x505u, 0x0D8u);
  var rows_b = array<u32, 8>(0x104u, 0x489u, 0x5FDu, 0x777u, 0x7FFu, 0x3FEu, 0x104u, 0x202u);
  var d = 0.0;
  // faint stars
  d = max(d, step(0.992, hash21(floor(p * 40.0 + seed))) * 0.35);
  // march clock: locked to detected beats when confident, else scroll
  var step8 = floor(t * 6.0);
  if (u.beat_conf > 0.5) { step8 = floor(u.beat_t); }
  let frame = u32(step8) % 2u;
  let zig = abs(f32(i32(step8) % 12 - 6));
  let off_x = (zig - 3.0) * 0.045;
  let anchor = vec2f(-0.78 + off_x, 0.42);
  let rel = vec2f(p.x - anchor.x, anchor.y - p.y);
  let cell = floor(rel / vec2f(0.32, 0.24));
  if (cell.x >= 0.0 && cell.x < 5.0 && cell.y >= 0.0 && cell.y < 3.0) {
    let local = (rel - cell * vec2f(0.32, 0.24)) / 0.020;
    let px = i32(local.x);
    let py = i32(local.y);
    if (px >= 0 && px < 11 && py >= 0 && py < 8) {
      let bits = select(rows_a[py], rows_b[py], frame == 1u);
      if (((bits >> u32(10 - px)) & 1u) == 1u) {
        let glow = 0.7 + 0.3 * hash21(cell + seed);
        d = max(d, glow * (0.85 + u.kick * 0.35));   // invaders pop on kicks
      }
    }
  }
  // cannon sliding below + a looping shot
  let ship_x = sin(t * 0.9) * 0.45;
  let sp = vec2f(p.x - ship_x, p.y + 0.42);
  d = max(d, step(abs(sp.x), 0.06) * step(abs(sp.y), 0.02) * 0.85);
  d = max(d, step(abs(sp.x), 0.012) * step(abs(sp.y - 0.03), 0.016) * 0.85);
  let shot_y = -0.38 + fract(t * 1.6) * 0.85;
  d = max(d, step(abs(p.x - ship_x), 0.006) * step(abs(p.y - shot_y), 0.03) * 0.7);
  return clamp(d, 0.0, 1.0);
}

fn scene_rim(p: vec2f, t: f32, seed: f32) -> f32 {
  var d = 0.0;
  let r = length(p);
  let ang = atan2(p.y, p.x);
  // spin locked to the beat: 144° per beat (×5 spokes → full visual cycle
  // every 5 beats); falls back to scroll-driven spin without a beat lock
  var rot = t * 2.0;
  if (u.beat_conf > 0.4) { rot = u.beat_t * 2.513; }
  let a = ang + rot;

  // tire: dark body, bright rotating tread blocks on the outer edge only
  let tire = smoothstep(0.46, 0.445, r) * smoothstep(0.30, 0.315, r);
  d = max(d, tire * 0.10);
  d = max(d, smoothstep(0.46, 0.43, r) * step(0.415, r) * step(0.55, fract(a * 3.82)) * 0.55);
  d = max(d, smoothstep(0.010, 0.0, abs(r - 0.455)) * 0.6);

  // chrome rim lip — double bright ring
  d = max(d, smoothstep(0.020, 0.0, abs(r - 0.30)) * 0.95);
  d = max(d, smoothstep(0.012, 0.0, abs(r - 0.27)) * 0.5);

  // 5 twin chrome spokes on a near-black interior, brighter on kick
  let spoke = pow(abs(sin(a * 2.5)), 6.0);
  let in_spoke = smoothstep(0.30, 0.28, r) * smoothstep(0.055, 0.075, r);
  d = max(d, in_spoke * spoke * (0.85 + u.kick * 0.3));

  // hub cap + 5 lug bolts
  d = max(d, smoothstep(0.060, 0.045, r) * 0.9);
  let bolt = pow(abs(sin(a * 2.5 + 0.628)), 40.0);
  d = max(d, smoothstep(0.10, 0.085, r) * smoothstep(0.06, 0.075, r) * bolt * 0.9);

  // fixed specular glint — stays put while the wheel spins (chrome!)
  let glint = pow(max(0.0, cos(ang - 0.7)), 30.0);
  d += smoothstep(0.32, 0.24, r) * step(0.075, r) * glint * 0.3;

  // speed lines flying past, outside the wheel
  let row = floor(p.y * 26.0 + seed);
  let rh = hash21(vec2f(row, seed));
  let sx = p.x * (0.9 + rh) + t * (7.0 + rh * 5.0);
  let streak = step(hash21(vec2f(row, floor(sx))), 0.10 + u.high * 0.2)
             * smoothstep(0.5, 0.0, fract(sx)) * step(0.49, r);
  d = max(d, streak * 0.35);

  // road rushing underneath
  d = max(d, step(p.y, -0.47) * (0.15 + fbm(vec2f(p.x * 5.0 + t * 6.0, p.y * 10.0)) * 0.2));

  return clamp(d, 0.0, 1.0);
}

fn scene_walker(p: vec2f, t: f32, seed: f32) -> f32 {
  var d = 0.0;
  // sparse stars + drifting fog
  d = max(d, step(0.994, hash21(floor(p * 38.0 + seed))) * 0.5);
  d = max(d, smoothstep(0.55, 0.95, fbm(p * 1.5 + vec2f(t * 0.25 + seed, 0.0))) * 0.16);
  // moon
  d = max(d, (1.0 - smoothstep(0.045, 0.06, length(p - vec2f(0.55, 0.32)))) * 0.85);
  // ground line + texture rushing past underfoot
  d = max(d, smoothstep(0.012, 0.0, abs(p.y + 0.42)) * 0.55);
  d = max(d, step(p.y, -0.42) * fbm(vec2f(p.x * 4.0 - t * 1.5 + seed, p.y * 9.0)) * 0.18);
  // the walker, feet on the ground line
  let lp = vec2f((p.x - u.anim.x) / 0.4 + 0.5, 0.5 - (p.y + 0.089) / 0.8);
  var wuv = WALK_A_UV;
  if (u.anim2.x > 0.5) { wuv = WALK_B_UV; }
  d = max(d, sample_atlas(wuv, lp) * 0.95);
  return clamp(d, 0.0, 1.0);
}

fn scene_acid(p: vec2f, t: f32, seed: f32) -> f32 {
  var d = 0.0;

  // psychedelic ring field, warped by noise, pumping outward on the beat
  let wob = (fbm(p * 2.2 + vec2f(t * 0.4 + seed, t * 0.25)) - 0.5) * (0.35 + u.bass * 0.7);
  let rr  = length(p) + wob;
  let rings = abs(sin(rr * 20.0 - t * 1.5 - u.beat_t * 3.14159));
  d = max(d, smoothstep(0.9, 1.0, rings) * (0.15 + u.mid * 0.22));

  // the smiley melts: domain-warp the face coords (drips downward, grows with
  // bass) and swell the whole face on the kick
  let pulse = 1.0 / (1.0 + u.kick * 0.12 + u.beat_conf * 0.05 * sin(6.2832 * u.beat_t));
  let melt = vec2f(fbm(p * 3.2 + vec2f(seed, t * 0.6)) - 0.5,
                   fbm(p * 3.2 + vec2f(9.1, t * 0.9 + seed)) - 0.5);
  let q = p * pulse + melt * vec2f(0.05 + u.bass * 0.10, 0.10 + u.bass * 0.22);
  let r = length(q);
  let R = 0.36;

  // bright face outline over a dim fill so the features read
  d = max(d, smoothstep(0.030, 0.012, abs(r - R)) * 0.95);
  d = max(d, step(r, R - 0.012) * 0.16);

  // two tall oval eyes
  let eL = length((q - vec2f(-0.13, 0.10)) / vec2f(0.05, 0.085));
  let eR = length((q - vec2f( 0.13, 0.10)) / vec2f(0.05, 0.085));
  d = max(d, step(min(eL, eR), 1.0) * 0.98);

  // grin: lower arc of a circle centered above the mouth, widens on the kick
  let mc = vec2f(0.0, 0.07);
  let mR = 0.22 + u.kick * 0.025;
  let grin = smoothstep(0.035, 0.0, abs(length(q - mc) - mR))
           * step(q.y, mc.y - 0.02) * step(abs(q.x), 0.21);
  d = max(d, grin * 0.98);

  return clamp(d, 0.0, 1.0);
}

fn scene_density(id: i32, p: vec2f, t: f32, seed: f32) -> f32 {
  if (id == 0)  { return scene_clouds(p, t, seed); }
  if (id == 1)  { return scene_waves(p, t, seed); }
  if (id == 2)  { return scene_forest(p, t, seed); }
  if (id == 3)  { return scene_rain(p, t, seed); }
  if (id == 4)  { return scene_stars(p, t, seed); }
  if (id == 5)  { return scene_mountains(p, t, seed); }
  if (id == 6)  { return scene_palms(p, t, seed); }
  if (id == 7)  { return scene_car(p, t, seed); }
  if (id == 8)  { return scene_city(p, t, seed); }
  if (id == 9)  { return scene_matrix(p, t, seed); }
  if (id == 10) { return scene_eye(p, t, seed); }
  if (id == 11) { return scene_storm(p, t, seed); }
  if (id == 12) { return scene_invaders(p, t, seed); }
  if (id == 13) { return scene_rim(p, t, seed); }
  if (id == 14) { return scene_walker(p, t, seed); }
  return scene_acid(p, t, seed);
}

// ── Pipeline ─────────────────────────────────────────────────────────

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let res  = vec2f(u.res_x, u.res_y);
  let cell = vec2f(u.cell_w, u.cell_h);
  var cell_id = floor(frag.xy / cell);

  // Dissonance row tear: some rows shift sideways and flash
  let row_h = hash21(vec2f(cell_id.y, floor(u.seed)));
  let torn = step(row_h, u.dissonance * 0.22);
  if (torn > 0.5) {
    cell_id.x += floor((hash21(vec2f(cell_id.y, u.seed)) - 0.5) * 7.0);
  }

  // Density is sampled at the cell center → one glyph per cell
  let center = (cell_id + 0.5) * cell;
  var p = (center - res * 0.5) / res.y;
  p.y = -p.y;                                          // y up

  let t = u.scroll;
  var density = scene_density(i32(u.scene_a), p, t, u.seed_a);
  if (u.blend > 0.001) {
    density = mix(density, scene_density(i32(u.scene_b), p, t, u.seed_b), u.blend);
  }

  // Silhouette emerging from the noise (cell-by-cell dissolve)
  if (u.sil_index >= 0.0 && u.reveal > 0.001) {
    var sil = 0.0;
    // figure spans 80% of screen height, region aspect 1:2
    let lp = vec2f(p.x / 0.4 + 0.5, 0.5 - p.y / 0.8);
    if (all(lp >= vec2f(0.0)) && all(lp <= vec2f(1.0))) {
      let suv = u.sil_uv.xy + lp * u.sil_uv.zw;
      let mask = textureSampleLevel(sil_tex, samp, suv, 0.0).r;
      let thr = hash21(cell_id * 1.37 + vec2f(u.sil_index * 31.7 + 7.0, u.sil_index * 13.3));
      let show = smoothstep(0.0, 0.15, u.reveal - thr);
      sil = mask * show;
    }
    density = max(density * mix(1.0, 0.18, u.reveal), sil);
  }

  // Ambient bird crossing the screen, flapping on the beat
  if (u.anim.w >= 0.0) {
    let bp = vec2f((p.x - u.anim.y) / 0.26 + 0.5, 0.5 - (p.y - u.anim.z) / 0.52);
    var buv = BIRD_A_UV;
    if (u.anim.w > 0.5) { buv = BIRD_B_UV; }
    density = max(density, sample_atlas(buv, bp) * 0.9);
  }

  density = clamp(density, 0.0, 1.0);

  // Soft global lift on kick — no spatial pattern, just a breath of brightness.
  // With a confident beat, a predictive flash lands exactly ON the beat.
  let beat_flash = u.beat_conf * 0.14 * pow(max(0.0, 1.0 - fract(u.beat_t) * 2.5), 2.0);
  var bright = 0.5 + 0.5 * density + u.pulse * 0.25 + u.kick * 0.3 + beat_flash + torn * 0.2;

  // Glyph index + high-band flicker
  var idx = i32(density * (u.glyph_count - 1.0) + 0.5);
  let fl = (hash21(cell_id + vec2f(u.seed, u.seed * 1.7)) - 0.5) * u.high * 4.0;
  idx = clamp(idx + i32(fl), 0, i32(u.glyph_count) - 1);

  // Sample the glyph (half-texel inset against bleed between atlas cells)
  let gx = f32(idx % i32(u.atlas_cols));
  let gy = f32(idx / i32(u.atlas_cols));
  let inset = 0.5 / GLYPH_PX;
  let sub = clamp(fract(frag.xy / cell), inset, vec2f(1.0) - inset);
  let guv = (vec2f(gx, gy) + sub) / vec2f(u.atlas_cols, u.atlas_rows);
  let cov = textureSampleLevel(glyph_tex, samp, guv, 0.0).r;

  let c = clamp(cov * bright, 0.0, 1.0);
  // Glyph colour from the user picker (anim2.yzw), white by default
  return vec4f(u.anim2.yzw * c, 1.0);
}
