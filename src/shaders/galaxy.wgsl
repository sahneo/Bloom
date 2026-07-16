// GALAXY — deep-space flythrough. The camera drifts forward through a
// 3D starfield (strong parallax: near stars streak past, far ones crawl)
// dotted with living star clusters — globular knots wrapped in nebula gas.
// Kick flares a cluster, bass makes nebula cores breathe, snare throws hot
// blue sparkles, a drop detonates a supernova whose shockwave rolls through
// the whole field. Everything is procedural (hash of index + scene seed) —
// no storage buffers, no compute pass.
//
// extra[] layout (written by galaxy.js each frame):
//   extra[0] = camZ, camX, camY, roll
//   extra[1] = flySpeed, warp, snareEnv, bassBreath
//   extra[2] = novaX, novaY, novaZ(world), novaAge
//   extra[3] = novaStrength, quiet, energy, 0
//   extra[4+c] (c = 0..11) = clusterX, clusterY, clusterZ(world), flareEnv

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

// ── constants (must match galaxy.js) ─────────────────────────────────────
const DEPTH:     f32 = 24.0;      // field wrap depth
const FOCAL:     f32 = 1.15;
const N_FIELD:   u32 = 150000u;
const N_CLUSTER: u32 = 108000u;
const M:         u32 = 12u;       // cluster count

// ── hashes ────────────────────────────────────────────────────────────────
fn pcg(v: u32) -> u32 {
  var s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn h4(n: u32) -> vec4f {
  var s = pcg(n);
  let a = f32(s) * (1.0 / 4294967296.0); s = pcg(s);
  let b = f32(s) * (1.0 / 4294967296.0); s = pcg(s);
  let c = f32(s) * (1.0 / 4294967296.0); s = pcg(s);
  let d = f32(s) * (1.0 / 4294967296.0);
  return vec4f(a, b, c, d);
}

fn hsv2rgb(c: vec3f) -> vec3f {
  let k = fract(vec3f(c.x, c.x + 2.0 / 3.0, c.x + 1.0 / 3.0)) * 6.0;
  let rgb = clamp(abs(k - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  return c.z * mix(vec3f(1.0), rgb, c.y);
}

fn rotAxis(v: vec3f, ax: vec3f, ang: f32) -> vec3f {
  let cs = cos(ang); let sn = sin(ang);
  return v * cs + cross(ax, v) * sn + ax * dot(ax, v) * (1.0 - cs);
}

// value noise + fbm (background & gas wisps)
fn vhash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p);
  let s = f * f * (3.0 - 2.0 * f);
  let a = vhash(i);
  let b = vhash(i + vec2f(1.0, 0.0));
  let c = vhash(i + vec2f(0.0, 1.0));
  let d = vhash(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}
fn fbm(p: vec2f) -> f32 {
  var v = 0.0; var amp = 0.55; var q = p;
  for (var i = 0; i < 3; i++) {
    v += vnoise(q) * amp;
    q = q * 2.13 + vec2f(17.3, 9.1);
    amp *= 0.5;
  }
  return v;
}

struct VSOut {
  @builtin(position) pos:   vec4f,
  @location(0)       local: vec2f,   // capsule frame: x in ±ext, y in ±1
  @location(1)       col:   vec3f,
  @location(2)       alpha: f32,
  @location(3)       ext:   f32,     // stars: elongation | gas: noise seed
}

fn dead() -> VSOut {
  return VSOut(vec4f(2.0e5, 2.0e5, 0.0, 1.0), vec2f(0.0), vec3f(0.0), 0.0, 1.0);
}

const CORNERS = array<vec2f, 6>(
  vec2f(-1.0, -1.0), vec2f( 1.0, -1.0), vec2f(-1.0,  1.0),
  vec2f(-1.0,  1.0), vec2f( 1.0, -1.0), vec2f( 1.0,  1.0),
);

// ═══════════════════════════ BACKGROUND ═══════════════════════════════════
// Deep-space gradient + a faint milky band + key-tinted far nebulosity.

struct BGOut {
  @builtin(position) pos: vec4f,
  @location(0)       uv:  vec2f,
}

@vertex
fn vs_bg(@builtin(vertex_index) vi: u32) -> BGOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(3.0, 1.0), vec2f(-1.0, 1.0));
  return BGOut(vec4f(p[vi], 0.0, 1.0), p[vi]);
}

@fragment
fn fs_bg(in: BGOut) -> @location(0) vec4f {
  let cam  = u.extra[0];
  let nova = u.extra[2];
  let glob = u.extra[3];
  let aspect = u.res_x / max(u.res_y, 1.0);
  var p = in.uv * vec2f(aspect, 1.0);
  // far layer barely parallaxes — the deepest depth cue
  p += vec2f(-cam.y * 0.05, -cam.z * 0.05);
  let sd = u.scene_seed * 43.7;

  // diagonal milky band, drifting imperceptibly with travel
  let bd = normalize(vec2f(0.42, 1.0));
  let bc = dot(p, bd) + sin(sd) * 0.6 + cam.x * 0.002;
  let band = exp(-bc * bc * 2.4);

  let n1 = fbm(p * 1.5 + vec2f(sd, cam.x * 0.012));
  let n2 = fbm(p * 3.4 + vec2f(cam.x * 0.03, sd * 0.31));

  let neb = hsv2rgb(vec3f(u.key_hue, 0.55, 1.0));
  var col = vec3f(0.005, 0.007, 0.014)
    + band * (0.026 + 0.034 * n1) * vec3f(0.45, 0.55, 0.85)
    + n1 * n1 * neb * 0.030 * (0.45 + glob.z * 0.9)
    + n2 * n2 * n2 * vec3f(0.75, 0.82, 1.0) * 0.016;

  // supernova lights the whole sky for a beat
  col *= 1.0 + glob.x * exp(-nova.w * 2.2) * 4.5;

  let a = u.trail_gain;
  return vec4f(col * a, a);
}

// ═══════════════════════════ STARS ════════════════════════════════════════
// One draw covers field stars (parallax layers) and cluster stars (knots).

@vertex
fn vs_star(@builtin(vertex_index) vi: u32) -> VSOut {
  let qi = vi / 6u;
  let ci = vi % 6u;
  var corners = CORNERS;
  let c = corners[ci];

  let cam  = u.extra[0];   // camZ camX camY roll
  let dyn  = u.extra[1];   // speed warp snare breath
  let nova = u.extra[2];   // x y z age
  let glob = u.extra[3];   // novaStrength quiet energy -

  var rel: vec3f;
  var bright: f32;
  var col: vec3f;
  var sizeW: f32;
  var fadeMul = 1.0;
  var sparkleGate = 0.0;

  if (qi < N_FIELD) {
    // ── free-field star: fixed z lane, x/y re-rolled every wrap cycle ──
    let hz = h4(qi * 2654435761u + 17u + u32(u.scene_seed * 1024.0));
    let z0 = hz.x * DEPTH;
    let w  = z0 - cam.x;
    let cyc = floor(w / DEPTH);
    let zA = w - DEPTH * cyc;
    let seed = pcg(qi ^ (bitcast<u32>(i32(cyc)) * 0x27d4eb2du));
    let r = h4(seed);
    rel = vec3f((r.x * 2.0 - 1.0) * 17.0 - cam.y,
                (r.y * 2.0 - 1.0) * 10.5 - cam.z,
                zA);

    let temp = r.z;
    col = mix(vec3f(0.72, 0.82, 1.15), vec3f(1.10, 0.90, 0.68), temp);
    bright = 0.5 + hz.y * hz.y * 1.3;
    sizeW  = 0.010 + hz.w * hz.w * 0.022;
    if (r.w > 0.988) {   // rare orange giant
      col = vec3f(1.20, 0.55, 0.28);
      bright *= 2.2; sizeW *= 1.5;
    }
    // twinkle — gentle at rest, agitated by highs
    let tw = sin(u.time * (1.5 + r.w * 5.0) + r.w * 61.7);
    bright *= 1.0 + tw * (0.16 + u.high * u.mul_high * 0.35);
    sparkleGate = step(0.90, hz.z);
  } else {
    // ── cluster star: gaussian knot around a living cluster centre ──
    let li  = qi - N_FIELD;
    let cid = li % M;
    let c4  = u.extra[4u + cid];
    let zA  = c4.z - cam.x;
    if (zA < 0.3) { return dead(); }

    // cluster identity from its (re-rolled) centre position
    let csd = pcg(bitcast<u32>(c4.x * 37.77 + c4.y * 91.3 + c4.z * 0.173));
    let cr  = h4(csd);
    let radius = 0.40 + cr.x * 0.55;
    var hue    = fract(u.key_hue + (cr.y - 0.5) * 0.26 + 1.0);
    // dodge the muddy olive band — push green-yellows to teal/cyan
    if (hue > 0.14 && hue < 0.42) { hue = fract(hue + 0.30); }
    let flare  = c4.w;

    let r  = h4(li * 747796405u + 13u);
    let r2 = h4(li * 2246822519u + 29u);
    let r3 = h4(li * 3266489917u + 101u);
    var off = vec3f(r.x + r.y + r.z - 1.5,
                    r.w + r2.x + r2.y - 1.5,
                    r2.z + r2.w + r3.x - 1.5) * 0.8;
    // per-cluster anisotropy — some knots are round, some are torn wisps
    off *= vec3f(0.70 + cr.z * 1.10, 0.55 + cr.w * 0.80, 0.70 + cr.x * 1.00);
    let len2 = dot(off, off);
    // differential swirl — the knot slowly churns, faster near the core
    let ax = normalize(vec3f(cr.y - 0.5, 1.0, cr.z - 0.5));
    let sw = u.time * (0.10 + 0.55 / (0.35 + len2)) * mix(0.6, 1.4, cr.w);
    off = rotAxis(off, ax, sw);

    // bass breath inflates the knot; kick flare kicks it outward
    let scale = radius * (1.0 + dyn.w * 0.20 + flare * 0.10
                          + glob.y * 0.06 * sin(u.time * 0.5 + f32(cid) * 2.1));
    rel = vec3f(c4.x - cam.y, c4.y - cam.z, zA) + off * scale;

    let q = exp(-len2 * 1.3);   // core concentration
    bright = (0.35 + r3.y * 0.9) * (0.35 + q * 1.9);
    bright *= 1.0 + flare * (1.6 + q * 2.8);
    col = mix(hsv2rgb(vec3f(hue, 0.66, 1.0)),
              vec3f(0.98, 1.00, 1.25),
              clamp(q * 0.72 + flare * 0.25, 0.0, 0.9));
    sizeW = 0.010 + r3.z * r3.z * 0.024 + q * 0.008;
    sparkleGate = step(0.84, r3.w);
    fadeMul = smoothstep(DEPTH + 2.0, DEPTH * 0.65, zA)
            * smoothstep(0.35, 1.2, zA);   // dissolve as we plunge through
  }

  // ── snare: hot blue-white glints on a random subset ──────────────────
  let spk = dyn.z * sparkleGate;
  bright *= 1.0 + spk * 7.0;
  col = mix(col, vec3f(0.75, 0.90, 1.50), clamp(spk * 1.2, 0.0, 0.8));

  // ── supernova shockwave: brighten + shove everything near the shell ──
  if (glob.x > 0.01 && nova.w < 6.0) {
    let nrel = vec3f(nova.x - cam.y, nova.y - cam.z, nova.z - cam.x);
    let dv = rel - nrel;
    let d  = length(dv);
    let rs = nova.w * 5.0;
    let shell = exp(-pow((d - rs) / 1.5, 2.0));
    let amp = glob.x * exp(-nova.w * 0.55);
    let flash = glob.x * exp(-nova.w * 3.0);
    bright *= 1.0 + shell * amp * 7.0 + flash * 4.0 / (1.0 + d * 0.2);
    rel += (dv / max(d, 0.05)) * shell * amp * 1.1;
    col = mix(col, vec3f(1.10, 0.95, 0.80),
              clamp(shell * amp * 0.5 + flash * 0.3, 0.0, 0.65));
  }

  let pz = rel.z;
  if (pz < 0.3) { return dead(); }

  // depth fog: far stars dim and cool — the depth carpet
  let fog = smoothstep(DEPTH, DEPTH * 0.55, pz);
  var a = bright * fadeMul * smoothstep(0.42, 1.1, pz) * mix(0.22, 1.0, fog);
  col = mix(col * vec3f(0.55, 0.65, 1.00), col, max(fog, 0.35));

  // project + camera roll
  var s = rel.xy * (FOCAL / pz);
  let cr_ = cos(cam.w); let sr_ = sin(cam.w);
  s = vec2f(s.x * cr_ - s.y * sr_, s.x * sr_ + s.y * cr_);

  // screen-space velocity → motion streak (long at warp, subtle at drift)
  let sv = s * (dyn.x / pz) * 0.085;
  let sl = length(sv);
  var dir = vec2f(1.0, 0.0);
  if (sl > 1.0e-4) { dir = sv / sl; }
  let slc = min(sl, 0.45);

  var sz = sizeW * FOCAL / pz;
  let szMin = 1.6 / u.res_y;
  let szMax = 30.0 / u.res_y;
  a *= min(1.0, (sz * sz) / (szMin * szMin));   // sub-pixel → dim, not alias
  sz = clamp(sz, szMin, szMax);

  let halfL = sz + slc * 0.5;
  let ext = halfL / sz;
  a /= (0.5 + 0.5 * ext);                        // streaks conserve energy

  let aspect = u.res_x / max(u.res_y, 1.0);
  let px = dir * (c.x * halfL);
  let py = vec2f(-dir.y, dir.x) * (c.y * sz);
  let clip = vec2f((s.x + px.x + py.x) / aspect, s.y + px.y + py.y);
  // soft frame vignette: keeps the feedback-echo mirror at the border from
  // stamping crisp streak copies (herringbone), reads as a lens falloff
  let edge = max(abs(clip.x), abs(clip.y));
  a *= 1.0 - 0.65 * smoothstep(0.86, 1.05, edge);
  return VSOut(vec4f(clip, 0.0, 1.0), vec2f(c.x * ext, c.y), col, a, ext);
}

@fragment
fn fs_star(in: VSOut) -> @location(0) vec4f {
  // capsule falloff: round endpoints, streaked middle
  let cap = max(in.ext - 1.0, 0.0);
  let px = max(abs(in.local.x) - cap, 0.0);
  let d = length(vec2f(px, in.local.y));
  if (d > 1.0) { discard; }
  let edge = smoothstep(1.0, 0.0, d);
  let a = edge * edge * in.alpha * u.trail_gain * 0.16;
  return vec4f(in.col * a, a);   // premultiplied, one/one blend
}

// ═══════════════════════════ NEBULA GAS ═══════════════════════════════════
// Big soft wispy sprites hugging each cluster — the glow that breathes.

@vertex
fn vs_gas(@builtin(vertex_index) vi: u32) -> VSOut {
  let qi = vi / 6u;
  let ci = vi % 6u;
  var corners = CORNERS;
  let c = corners[ci];

  let cam  = u.extra[0];
  let dyn  = u.extra[1];
  let nova = u.extra[2];
  let glob = u.extra[3];

  let cid = qi % M;
  let c4  = u.extra[4u + cid];
  let zA  = c4.z - cam.x;
  if (zA < 0.6 || zA > DEPTH + 2.0) { return dead(); }

  let csd = pcg(bitcast<u32>(c4.x * 37.77 + c4.y * 91.3 + c4.z * 0.173));
  let cr  = h4(csd);
  let radius = 0.40 + cr.x * 0.55;
  var hue    = fract(u.key_hue + (cr.y - 0.5) * 0.26 + 1.0);
  if (hue > 0.14 && hue < 0.42) { hue = fract(hue + 0.30); }
  let flare  = c4.w;

  let r  = h4(qi * 1597334677u + 3u);
  let r2 = h4(qi * 3812015801u + 71u);
  var off = vec3f(r.x + r.y - 1.0, r.z + r.w - 1.0, r2.x + r2.y - 1.0) * radius * 1.05;
  off *= vec3f(0.75 + cr.z * 1.0, 0.60 + cr.w * 0.7, 0.8);

  // breath: bass inflates the pocket; flares puff it up further
  var w = radius * (0.70 + r2.w * 1.30) * (1.0 + dyn.w * 0.28 + flare * 0.18);

  let rel = vec3f(c4.x - cam.y, c4.y - cam.z, zA) + off;
  let pz = max(rel.z, 0.4);

  var s = rel.xy * (FOCAL / pz);
  let cr_ = cos(cam.w); let sr_ = sin(cam.w);
  s = vec2f(s.x * cr_ - s.y * sr_, s.x * sr_ + s.y * cr_);

  let sz = clamp(w * FOCAL / pz, 4.0 / u.res_y, 0.55);

  // core hue near centre, drifting toward a second tint at the rim
  let hue2 = fract(hue + 0.09 * (cr.w - 0.5) * 2.0 + 1.0);
  var col = hsv2rgb(vec3f(mix(hue, hue2, r2.z), 0.72, 1.0));
  col = mix(col, vec3f(1.0, 0.95, 0.85), flare * 0.3);

  var a = 0.042 * (0.55 + dyn.w * 0.70 + flare * 1.60 + glob.y * 0.15);
  a *= smoothstep(DEPTH + 2.0, DEPTH * 0.6, zA);   // fade in from the deep
  a *= smoothstep(0.6, 1.8, zA);                   // dissolve as we fly through
  // nova: the chosen cluster's gas ignites, neighbours catch the light
  if (glob.x > 0.01 && nova.w < 5.0) {
    let dn = distance(vec3f(c4.x, c4.y, c4.z), nova.xyz);
    a *= 1.0 + exp(-dn * dn * 0.12) * glob.x * exp(-nova.w * 1.3) * 9.0;
  }

  // slow per-puff rotation keeps the gas alive
  let ang = r.w * 6.2832 + u.time * 0.05 * (r.x - 0.5);
  let ca = cos(ang); let sa = sin(ang);
  let lc = vec2f(c.x * ca - c.y * sa, c.x * sa + c.y * ca);

  let aspect = u.res_x / max(u.res_y, 1.0);
  let clip = vec2f((s.x + lc.x * sz) / aspect, s.y + lc.y * sz);
  return VSOut(vec4f(clip, 0.0, 1.0), c, col, a, r.y * 90.0 + f32(cid) * 7.0);
}

@fragment
fn fs_gas(in: VSOut) -> @location(0) vec4f {
  let d = length(in.local);
  if (d > 1.0) { discard; }
  let n = fbm(in.local * 2.6 + vec2f(in.ext, in.ext * 0.37) + vec2f(u.time * 0.02));
  let body = smoothstep(1.0, 0.08, d);
  let a = body * body * (0.30 + 0.70 * n) * in.alpha * u.trail_gain;
  return vec4f(in.col * a, a);
}
