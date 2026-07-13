// TERRA — flight over a landscape built by the music itself.
//
// A ring buffer of "history rows" (one per ~90ms, appended in JS) is bound
// as a storage buffer. World z maps linearly onto row index, so the terrain
// IS the track's recent past: bass raises broad mountain masses, highs carve
// sharp ridge detail, kicks push up crest spikes, quiet passages leave
// plains. The camera flies forward at exactly the row-append rate, so new
// ground rises at the horizon shaped by what is playing NOW and scrolls
// toward the viewer. Sun and sky wear the key colour; a drop detonates a
// volcano ahead of the flight path.

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
// _r1 = rowsFloat (continuous head of the history ring, in rows)
// _r2 = eruption envelope 0..1   _r3 = eruption world row
// extra[0] = (eruptX, eruptAge s, camera shake, quietness 0..1)

@group(0) @binding(0) var<uniform> u: Uniforms;
// 256 rows × 2 vec4: [subBass, bass, mid, high], [kick, snare, tension, beat]
@group(0) @binding(1) var<storage, read> hist: array<vec4f>;

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

const ROWS: i32        = 256;
const ROW_SPACING: f32 = 0.55;   // world units per history row
const HORIZON_ROWS: f32 = 50.0;  // camera flies this many rows behind "now"
const FAR: f32         = 28.0;   // ≈ HORIZON_ROWS × ROW_SPACING
const MAX_STEPS: i32   = 104;

fn hsv2rgb(c: vec3f) -> vec3f {
  let k = fract(vec3f(c.x, c.x + 2.0 / 3.0, c.x + 1.0 / 3.0)) * 6.0;
  let rgb = clamp(abs(k - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  return c.z * mix(vec3f(1.0), rgb, c.y);
}

fn rot2(a: f32) -> mat2x2f {
  let c = cos(a); let s = sin(a);
  return mat2x2f(vec2f(c, s), vec2f(-s, c));
}

fn hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 345.45));
  q += dot(q, q + 34.345);
  return fract(q.x * q.y);
}

fn vnoise(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p);
  let w = f * f * (3.0 - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2f(1.0, 0.0));
  let c = hash21(i + vec2f(0.0, 1.0));
  let d = hash21(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

fn fbm2(p: vec2f) -> f32 {
  return vnoise(p) * 0.65 + vnoise(p * 2.13 + vec2f(5.2, 1.7)) * 0.35;
}

// ridged: crest lines for high-frequency mountain detail
fn ridged2(p: vec2f) -> f32 {
  let n1 = 1.0 - abs(vnoise(p) * 2.0 - 1.0);
  let n2 = 1.0 - abs(vnoise(p * 2.2 + vec2f(9.7, 3.1)) * 2.0 - 1.0);
  return n1 * 0.7 + n2 * 0.3;
}

// ── history rows ─────────────────────────────────────────────────────────
// Returns (broad, high, kick, mid) amplitudes for integer row i, weighted so
// rows near the head grow smoothly from flat (new ground "rises" at horizon).
fn fetchRow(i: i32) -> vec4f {
  let fi = f32(i);
  let w0 = clamp((u._r1 - fi) * 0.35, 0.0, 1.0);
  let w  = w0 * w0 * (3.0 - 2.0 * w0);
  var idx = i % ROWS;
  if (idx < 0) { idx += ROWS; }
  let a = hist[idx * 2];
  let b = hist[idx * 2 + 1];
  let broad = a.x * 0.8 + a.y;                 // subBass + bass → mountain mass
  return vec4f(broad, a.w + b.x * 0.4, b.x, a.z) * w;
}

// Catmull-Rom across 4 rows so the terrain is smooth along z, not stripey.
fn sampleRows(z: f32) -> vec4f {
  let rf = z / ROW_SPACING;
  let i1 = i32(floor(rf));
  let t  = fract(rf);
  let p0 = fetchRow(i1 - 1);
  let p1 = fetchRow(i1);
  let p2 = fetchRow(i1 + 1);
  let p3 = fetchRow(i1 + 2);
  let t2 = t * t; let t3 = t2 * t;
  let v = 0.5 * ((2.0 * p1) + (-p0 + p2) * t
        + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
        + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3);
  return max(v, vec4f(0.0));
}

// ── heightfield ──────────────────────────────────────────────────────────
fn terrainH(xz: vec2f) -> f32 {
  let r = sampleRows(xz.y);
  let B = r.x;   // broad mountain mass (bass)
  let H = r.y;   // ridge sharpness (highs + kick)
  let K = r.z;   // kick crest
  let M = r.w;   // mids → general energy

  let s = u.scene_seed * 3.7;
  // where mountains clump laterally — low-frequency static noise
  let mass = fbm2(vec2f(xz.x * 0.16, xz.y * 0.11) + vec2f(s, s * 1.3));
  // gentle central valley so the flight path reads as a canyon route
  let side = 0.55 + 0.45 * smoothstep(1.2, 8.0, abs(xz.x));
  var h = B * (0.35 + 1.55 * mass * mass) * 2.7 * side;
  // sharp ridge crests carved by hats / bright timbre
  h += H * ridged2(vec2f(xz.x * 0.62, xz.y * 0.46) + vec2f(s * 0.7, 0.0)) * 1.7;
  // kick rows push up a narrow crest across the valley
  h += K * (1.0 - abs(vnoise(vec2f(xz.x * 0.3 + 7.0, xz.y * 0.85)) * 2.0 - 1.0)) * 0.9;
  // static rock detail, scaled by how loud that moment was
  let loud = min(B * 0.35 + H * 0.5 + M * 0.3, 1.0);
  h += (vnoise(xz * 1.7) + vnoise(xz * 3.6 + vec2f(2.3, 8.1)) * 0.45)
     * (0.06 + 0.26 * loud);

  // volcano cone (drop): rises fast, keeps its mass while lava cools
  let env = u._r2;
  if (env > 0.002) {
    let vp = vec2f(u.extra[0].x, u._r3 * ROW_SPACING);
    let dv = xz - vp;
    h += env * 3.4 * exp(-dot(dv, dv) * 0.05);
  }
  return h;
}

// Broad-mass-only height (no ridges/spikes/rock noise) — the camera path
// rides this so the flight glides instead of jittering over detail
fn terrainLow(xz: vec2f) -> f32 {
  let r = sampleRows(xz.y);
  let s = u.scene_seed * 3.7;
  let mass = fbm2(vec2f(xz.x * 0.16, xz.y * 0.11) + vec2f(s, s * 1.3));
  let side = 0.55 + 0.45 * smoothstep(1.2, 8.0, abs(xz.x));
  // conservative UPPER BOUND: broad mass + max possible ridge/kick/rock
  // detail. The camera glides over this, so it never needs a full-detail
  // probe (a single such probe was the vertical jerk).
  return r.x * (0.35 + 1.55 * mass * mass) * 2.7 * side
       + r.y * 1.5 + r.z * 0.9 + 0.37;
}

// ── sky ──────────────────────────────────────────────────────────────────
fn skyColor(rd: vec3f, sunDir: vec3f, sunCol: vec3f, keyCol: vec3f, quiet: f32) -> vec3f {
  let up = max(rd.y, 0.0);
  let horizon = keyCol * 0.55 + sunCol * 0.06;
  let zenith  = keyCol * 0.10 + vec3f(0.010, 0.014, 0.030);
  var col = mix(horizon, zenith, pow(max(up, 1e-3), 0.55));

  let ca = max(dot(rd, sunDir), 0.0);
  col += sunCol * pow(max(ca, 1e-3), 5.0)  * 0.22;   // broad warm wash
  col += sunCol * pow(max(ca, 1e-3), 55.0) * 0.85;   // inner halo
  col += sunCol * smoothstep(0.99930, 0.99965, ca) * 4.5;  // HDR disc → bloom

  // stars + faint nebula in quiet passages
  if (rd.y > 0.04 && quiet > 0.03) {
    let sp = rd.xz / max(rd.y, 0.08) * 26.0;
    let hcell = hash21(floor(sp));
    let twinkle = 0.5 + 0.5 * sin(u.time * 2.4 + hcell * 87.0);
    let star = step(0.991, hcell)
             * smoothstep(0.04, 0.28, rd.y)
             * (0.35 + 0.65 * twinkle);
    col += vec3f(0.75, 0.82, 1.0) * star * quiet * 0.9;
    col += hsv2rgb(vec3f(u.key_hue + 0.12, 0.6, 0.06))
         * fbm2(rd.xz / max(rd.y, 0.2) * 2.0 + vec2f(u.scene_seed * 9.0, 0.0))
         * quiet * smoothstep(0.05, 0.4, rd.y);
  }
  return col;
}

@fragment
fn fs_render(in: VSOut) -> @location(0) vec4f {
  let aspect = u.res_x / max(u.res_y, 1.0);
  // NOTE: uv.y grows downward — flip so +sp.y is up on screen
  let sp = vec2f((in.uv.x - 0.5) * 2.0 * aspect, (0.5 - in.uv.y) * 2.0);

  // ── palette from the music's key ───────────────────────────────────────
  let warm   = clamp(u.tonality * 0.5 + 0.5, 0.0, 1.0);   // minor→0, major→1
  let sunHue = mix(0.60, 0.07, warm);
  let sunCol = hsv2rgb(vec3f(sunHue, mix(0.10, 0.55, warm), 1.0)) * 1.15;
  let keyCol = hsv2rgb(vec3f(u.key_hue, 0.42 + 0.28 * u.key_conf, 0.30));
  let sunEl  = 0.11 + u.tension * 0.10 + sin(u.time * 0.05 + u.scene_seed) * 0.025;
  let sunDir = normalize(vec3f(0.30 + sin(u.scene_seed * 2.0) * 0.25, sunEl, 1.0));
  let quiet  = u.extra[0].w;

  // ── camera: glued to the history — one row per row-append ─────────────
  // Altitude rides the LOW-FREQUENCY terrain mass averaged over a long
  // window ahead (≈1.5 s of flight), so the aircraft glides over ridge
  // spikes instead of tracking every bump; one near full-detail probe
  // only prevents actual clipping through a freak spike.
  let head = u._r1;
  let camZ = (head - HORIZON_ROWS) * ROW_SPACING;
  let wx   = sin(camZ * 0.055 + u.scene_seed) * 1.1 + u.drift_x * 1.2;
  var gsum = 0.0;
  for (var k = 0; k <= 5; k++) {
    gsum += terrainLow(vec2f(wx, camZ + f32(k) * 1.7));
  }
  let camY = gsum / 6.0 + 1.35 + sin(u.time * 0.31) * 0.10;
  var ro = vec3f(wx, camY, camZ);
  // eruption shockwave shakes the airframe
  let shake = u.extra[0].z;
  ro += vec3f(sin(u.time * 61.0), cos(u.time * 53.0), 0.0) * shake * 0.10;

  // forward look, slight down pitch, bank into the weave
  let weaveD = cos(camZ * 0.055 + u.scene_seed) * 0.11;
  let fwd = normalize(vec3f(weaveD * 0.9, -0.10, 1.0));
  var rt  = normalize(cross(vec3f(0.0, 1.0, 0.0), fwd));
  var upv = cross(fwd, rt);
  let bank = rot2(-weaveD * 1.1 + u.drift_rot * 0.15);
  let br = bank * vec2f(1.0, 0.0);
  let rt2 = rt * br.x + upv * br.y;
  let up2 = upv * br.x - rt * br.y;
  let rd  = normalize(fwd * 1.30 + rt2 * sp.x + up2 * sp.y);

  // ── march the heightfield ──────────────────────────────────────────────
  var t = 0.06;
  var hit = false;
  var tPrev = t;
  for (var i = 0; i < MAX_STEPS; i++) {
    let p = ro + rd * t;
    let d = p.y - terrainH(p.xz);
    if (d < 0.0016 * t + 0.001) { hit = true; break; }
    tPrev = t;
    t += max(d * clamp(0.38 + t * 0.014, 0.38, 0.62), 0.010);
    if (t > FAR) { break; }
  }
  if (!hit && t <= FAR) { hit = true; }   // step budget spent → treat as hit
  if (hit) {
    // binary-search refine between the last two samples
    var a = tPrev; var b = t;
    for (var j = 0; j < 6; j++) {
      let m = 0.5 * (a + b);
      let pm = ro + rd * m;
      if (pm.y - terrainH(pm.xz) < 0.0) { b = m; } else { a = m; }
    }
    t = 0.5 * (a + b);
  }

  let beat = 1.0 + exp(-fract(u.beat_t) * 5.0) * u.beat_conf * 0.16;
  var col: vec3f;

  if (hit) {
    let p = ro + rd * t;
    // normal from height gradient; eps grows with distance (cheap LOD/AA)
    let e  = max(0.02 * t, 0.02);
    let hx = terrainH(p.xz + vec2f(e, 0.0)) - terrainH(p.xz - vec2f(e, 0.0));
    let hz = terrainH(p.xz + vec2f(0.0, e)) - terrainH(p.xz - vec2f(0.0, e));
    let n  = normalize(vec3f(-hx, 2.0 * e, -hz));

    // rock albedo tinted toward the key — dark so ridges read as stone
    var alb = mix(vec3f(0.16, 0.135, 0.12),
                  hsv2rgb(vec3f(u.key_hue, 0.45, 0.22)),
                  0.28 + 0.30 * u.key_conf);
    alb *= 0.70 + 0.60 * vnoise(p.xz * 2.3);      // strata
    // snow high up, only where slopes are gentle — cliffs stay dark rock
    let snowLine = 2.6;
    let snow = smoothstep(snowLine, snowLine + 0.9, p.y)
             * smoothstep(0.60, 0.88, n.y);
    alb = mix(alb, vec3f(0.92, 0.96, 1.06), snow);

    let dif = max(dot(n, sunDir), 0.0);
    let amb = (n.y * 0.5 + 0.5) * (keyCol + vec3f(0.05, 0.07, 0.11)) * 0.45;
    // rim/backlight: ridges silhouetted against the sun catch a hot edge —
    // this is what makes the relief read as cinematic instead of flat
    let rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0)
            * pow(max(dot(rd, sunDir), 0.0), 3.0);
    // valleys sink into darkness, peaks take the light
    let hAo = clamp(p.y * 0.20 + 0.42, 0.42, 1.0);
    col = alb * (sunCol * dif * 1.75 + amb + vec3f(0.016)) * hAo * beat;
    col += sunCol * rim * 0.85;
    // high peaks catch extra light — they should read from far away
    col += vec3f(0.42, 0.48, 0.62) * snow * smoothstep(snowLine + 0.6, snowLine + 1.8, p.y) * 0.5;

    // ── lava (drop eruption) ────────────────────────────────────────────
    let env = u._r2;
    if (env > 0.002) {
      let vp  = vec2f(u.extra[0].x, u._r3 * ROW_SPACING);
      let dl  = length(p.xz - vp);
      let age = u.extra[0].y;
      let front = 1.6 + age * 1.9;                     // flow spreads outward
      let prox  = exp(-pow(max(dl - front * 0.45, 0.0), 2.0) / (front * 1.1));
      let vein  = pow(max(ridged2(p.xz * 1.1 + vec2f(0.0, -age * 0.7)), 1e-3), 3.0);
      col += vec3f(4.2, 1.1, 0.14) * vein * prox * env * 1.9;    // rivers of fire
      col += vec3f(8.0, 2.6, 0.5) * exp(-dl * dl * 0.20) * env;  // crater core
    }

    // key-tinted fog toward the horizon, sun-warmed in the sun's direction
    let fogC = mix(keyCol * 0.55 + sunCol * 0.05,
                   sunCol * 0.55,
                   pow(max(dot(rd, sunDir), 0.0), 4.0));
    let fd = 0.036 + u.tension * 0.015;
    col = mix(fogC, col, exp(-t * fd));
  } else {
    col = skyColor(rd, sunDir, sunCol, keyCol, quiet);
  }

  // eruption plume: a hot glow column above the volcano lights the air
  let envG = u._r2;
  if (envG > 0.002) {
    let vtop = vec3f(u.extra[0].x, envG * 3.4 + 1.4, u._r3 * ROW_SPACING);
    let toV  = vtop - ro;
    let proj = clamp(dot(toV, rd), 0.0, FAR);
    // only glow if the volcano isn't occluded by nearer terrain
    if (!hit || proj < t) {
      let dline = length(toV - rd * proj);
      col += vec3f(3.5, 1.1, 0.2) * exp(-dline * dline * 0.30) * envG * 0.9;
    }
  }

  // eruption lights the whole sky for a beat
  col *= 1.0 + u.drop_pulse * 0.14;
  // MIDI note attacks flash gently
  col *= 1.0 + u.pulse * 0.18;

  return vec4f(col, u.trail_gain);
}
