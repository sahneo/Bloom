// INK — GPU stable-fluids (Jos Stam) on a square sim grid:
//   advect velocity → audio forces → divergence → Jacobi pressure solve →
//   gradient subtract → advect + inject dye → render dye to the accum buffer.
// Velocity lives in grid-UV units/s in a ping-ponged rgba16float texture (rg).

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
  ripple_pos_age: array<vec4f, 8>,
  ripple_color:   array<vec4f, 8>,
}

struct SimParams {
  dt:       f32,
  vel_diss: f32,
  dye_diss: f32,
  aspect:   f32,   // canvas aspect (for world→uv mapping of splats)
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var<uniform> u: Uniforms;
@group(0) @binding(2) var<uniform> sim: SimParams;
@group(0) @binding(3) var tex_a: texture_2d<f32>;   // main input of each pass
@group(0) @binding(4) var tex_b: texture_2d<f32>;   // auxiliary input
@group(0) @binding(5) var tex_c: texture_2d<f32>;   // second auxiliary (density)

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

// Statically references every binding so each entry point gets the SAME
// 'auto' pipeline layout — one bind-group shape for all passes. Returns 0.
fn touch_all(uv: vec2f) -> f32 {
  return (sim.dt + u.time + textureSample(tex_b, samp, uv).x + textureSample(tex_c, samp, uv).x) * 0.0;
}

fn hash1(n: f32) -> f32 { return fract(sin(n * 127.1) * 43758.5453); }

// Kick blobs spawn at a new pseudo-random spot each beat (lava-lamp style)
fn kick_blob_uv() -> vec2f {
  let bi = select(floor(u.time * 1.5), floor(u.beat_t), u.beat_conf > 0.1);
  let bx = (hash1(bi + u.scene_seed * 0.01) * 1.4 - 0.7) * sim.aspect * 0.7;
  let by = 0.7 - hash1(bi * 1.7 + 3.0) * 1.4;
  return world_to_uv(vec2f(bx, by));
}

// World (x ∈ ±aspect, y ∈ ±1, y up) → sim UV
fn world_to_uv(w: vec2f) -> vec2f {
  return vec2f((w.x / max(sim.aspect, 0.001) + 1.0) * 0.5, (1.0 - w.y) * 0.5);
}

// ── velocity advection (semi-Lagrangian) ────────────────────────────────
@fragment
fn fs_advect_vel(in: VSOut) -> @location(0) vec4f {
  let _t = touch_all(in.uv);
  let v   = textureSample(tex_a, samp, in.uv).xy;
  let uvb = in.uv - v * sim.dt;
  return vec4f(textureSample(tex_a, samp, uvb).xy * sim.vel_diss + vec2f(_t), 0.0, 0.0);
}

// ── curl (vorticity) of the velocity field ──────────────────────────────
@fragment
fn fs_curl(in: VSOut) -> @location(0) vec4f {
  let _t = touch_all(in.uv);
  let t = 1.0 / vec2f(textureDimensions(tex_a));
  let l = textureSample(tex_a, samp, in.uv - vec2f(t.x, 0.0)).y;
  let r = textureSample(tex_a, samp, in.uv + vec2f(t.x, 0.0)).y;
  let b = textureSample(tex_a, samp, in.uv + vec2f(0.0, t.y)).x;
  let tp = textureSample(tex_a, samp, in.uv - vec2f(0.0, t.y)).x;
  return vec4f((r - l) * 0.5 - (b - tp) * 0.5 + _t, 0.0, 0.0, 0.0);
}

// ── audio forces + vorticity confinement (tex_b = curl) ─────────────────
@fragment
fn fs_forces(in: VSOut) -> @location(0) vec4f {
  let _t = touch_all(in.uv);
  var v = textureSample(tex_a, samp, in.uv).xy;

  // Vorticity confinement: push velocity around existing swirl centres —
  // restores the small curls that semi-Lagrangian advection smears away
  {
    let t = 1.0 / vec2f(textureDimensions(tex_b));
    let cl = abs(textureSample(tex_b, samp, in.uv - vec2f(t.x, 0.0)).x);
    let cr = abs(textureSample(tex_b, samp, in.uv + vec2f(t.x, 0.0)).x);
    let cb = abs(textureSample(tex_b, samp, in.uv + vec2f(0.0, t.y)).x);
    let ct = abs(textureSample(tex_b, samp, in.uv - vec2f(0.0, t.y)).x);
    let w  = textureSample(tex_b, samp, in.uv).x;
    var n  = vec2f(cr - cl, cb - ct);
    n = n / (length(n) + 1e-5);
    v += vec2f(n.y, -n.x) * w * 5.0 * sim.dt;
  }

  // ── Lava-lamp dynamics (tex_c = density) ──
  // Buoyancy cycles slowly: blobs rise for a while, then sink — and the
  // sub-bass literally heats the lamp. uv y points down, so up = -y.
  let dens = textureSample(tex_c, samp, in.uv).x;
  let heat = sin(u.time * 0.10) * 0.7 + u.sub_bass * 0.6;
  v += vec2f(0.0, -1.0) * dens * 0.035 * max(u._r1, 1.0) * heat;

  // Surface-tension-ish cohesion: pull velocity toward denser fluid so blobs
  // round up and MERGE on contact instead of smearing past each other
  {
    let t2 = 1.0 / vec2f(textureDimensions(tex_c));
    let dl  = textureSample(tex_c, samp, in.uv - vec2f(t2.x, 0.0)).x;
    let dr  = textureSample(tex_c, samp, in.uv + vec2f(t2.x, 0.0)).x;
    let db  = textureSample(tex_c, samp, in.uv + vec2f(0.0, t2.y)).x;
    let dt2 = textureSample(tex_c, samp, in.uv - vec2f(0.0, t2.y)).x;
    let grad = vec2f(dr - dl, db - dt2);
    v += grad * 0.12 * max(u._r1, 1.0) * smoothstep(0.02, 0.25, dens);
  }

  let wc  = world_to_uv(vec2f(u.drift_x, u.drift_y));
  let d   = in.uv - wc;
  let r   = length(d) + 1e-4;
  let dir = d / r;

  // Per-variant tempo: mercury fmul=1 (lazy), legacy ferro fmul=2.4 (punchy)
  let fmul = max(u._r1, 1.0);

  // Kick punches momentum into the freshly spawned blob
  let kuv = kick_blob_uv();
  let kd  = in.uv - kuv;
  v += normalize(kd + vec2f(1e-4)) * u.kick * 0.15 * fmul * exp(-dot(kd, kd) / 0.01);

  v -= dir * u.tension * 0.03;                          // build-up implosion
  v += dir * u.drop_pulse * 0.5 * exp(-r * 3.0);        // drop blast

  // Snare: turbulence — makes blob surfaces gurgle
  let wig = sin(in.uv.yx * 43.0 + u.time * 3.0);
  v += wig * u.snare * 0.03 * fmul * smoothstep(0.05, 0.3, dens);

  // MIDI notes shove nearby fluid
  for (var i = 0u; i < 8u; i++) {
    let rp = u.ripple_pos_age[i];
    if (rp.z < 0.0 || rp.z > 0.25) { continue; }
    let ruv = world_to_uv(rp.xy);
    let rd  = in.uv - ruv;
    v += normalize(rd + vec2f(1e-4)) * exp(-dot(rd, rd) / 0.005) * 0.25 * fmul;
  }

  return vec4f(v + vec2f(_t), 0.0, 0.0);
}

// ── divergence ──────────────────────────────────────────────────────────
@fragment
fn fs_divergence(in: VSOut) -> @location(0) vec4f {
  let _t = touch_all(in.uv);
  let t = 1.0 / vec2f(textureDimensions(tex_a));
  let l = textureSample(tex_a, samp, in.uv - vec2f(t.x, 0.0)).x;
  let r = textureSample(tex_a, samp, in.uv + vec2f(t.x, 0.0)).x;
  let b = textureSample(tex_a, samp, in.uv + vec2f(0.0, t.y)).y;
  let tp = textureSample(tex_a, samp, in.uv - vec2f(0.0, t.y)).y;
  return vec4f(0.5 * ((r - l) + (b - tp)) + _t, 0.0, 0.0, 0.0);
}

// ── Jacobi pressure iteration (tex_a = pressure, tex_b = divergence) ────
@fragment
fn fs_jacobi(in: VSOut) -> @location(0) vec4f {
  let _t = touch_all(in.uv);
  let t = 1.0 / vec2f(textureDimensions(tex_a));
  let l = textureSample(tex_a, samp, in.uv - vec2f(t.x, 0.0)).x;
  let r = textureSample(tex_a, samp, in.uv + vec2f(t.x, 0.0)).x;
  let b = textureSample(tex_a, samp, in.uv + vec2f(0.0, t.y)).x;
  let tp = textureSample(tex_a, samp, in.uv - vec2f(0.0, t.y)).x;
  let div = textureSample(tex_b, samp, in.uv).x;
  return vec4f((l + r + b + tp - div) * 0.25 + _t, 0.0, 0.0, 0.0);
}

// ── pressure gradient subtraction (tex_a = velocity, tex_b = pressure) ──
@fragment
fn fs_gradient(in: VSOut) -> @location(0) vec4f {
  let _t = touch_all(in.uv);
  let t = 1.0 / vec2f(textureDimensions(tex_b));
  let l = textureSample(tex_b, samp, in.uv - vec2f(t.x, 0.0)).x;
  let r = textureSample(tex_b, samp, in.uv + vec2f(t.x, 0.0)).x;
  let b = textureSample(tex_b, samp, in.uv + vec2f(0.0, t.y)).x;
  let tp = textureSample(tex_b, samp, in.uv - vec2f(0.0, t.y)).x;
  var v = textureSample(tex_a, samp, in.uv).xy;
  v -= 0.5 * vec2f(r - l, b - tp);
  return vec4f(v, 0.0, 0.0);
}

// ── density advection + blob injection (tex_a = density, tex_b = velocity)
// The fluid is a MONOCHROME density field — discrete blobs, not coloured
// smoke. Colour and gloss happen at render time (ferrofluid look).
@fragment
fn fs_advect_dye(in: VSOut) -> @location(0) vec4f {
  let _t = touch_all(in.uv);
  let v   = textureSample(tex_b, samp, in.uv).xy;
  let uvb = in.uv - v * sim.dt;
  var dens = textureSample(tex_a, samp, uvb).x * sim.dye_diss;

  // Kick births a dense round blob at this beat's spot
  let kuv = kick_blob_uv();
  let kd  = in.uv - kuv;
  dens += u.kick * 35.0 * sim.dt * exp(-dot(kd, kd) / 0.005);

  // Snare spits a small satellite blob near the kick blob
  let suv = kuv + vec2f(hash1(floor(u.beat_t * 2.0)) - 0.5, hash1(floor(u.beat_t * 2.0) + 9.0) - 0.5) * 0.3;
  let sd  = in.uv - suv;
  dens += u.snare * 12.0 * sim.dt * exp(-dot(sd, sd) / 0.002);

  // MIDI notes: blobs where the ripples land
  for (var i = 0u; i < 8u; i++) {
    let rp = u.ripple_pos_age[i];
    if (rp.z < 0.0 || rp.z > 0.30) { continue; }
    let ruv = world_to_uv(rp.xy);
    let rd  = in.uv - ruv;
    dens += 28.0 * sim.dt * exp(-dot(rd, rd) / 0.003);
  }

  // Quiet ember so the lamp never goes fully dark
  let wc = world_to_uv(vec2f(u.drift_x, u.drift_y));
  let d  = in.uv - wc;
  dens += (0.10 + u.sub_bass * 0.8) * sim.dt * exp(-dot(d, d) / 0.006);

  // Drop: one huge blob erupts
  dens += u.drop_pulse * u.drop_pulse * 8.0 * sim.dt * exp(-dot(d, d) / 0.01);

  return vec4f(min(dens, 3.0) + _t, 0.0, 0.0, 1.0);
}

// ── LEGACY "ferro" render: the original ferrofluid look — hard white blobs
// on black with a key-hue rim, harsher and punchier than the mercury mode.
// (Force speed differs via u._r1, set per-variant from JS.)
@fragment
fn fs_render_ferro(in: VSOut) -> @location(0) vec4f {
  let _t = touch_all(in.uv);
  let dens = textureSample(tex_a, samp, in.uv).x;

  let aa    = fwidth(dens) * 1.5;
  let softw = max(mix(0.10, 0.02, u.sharpness), aa);
  let th    = 0.20;
  let body  = smoothstep(th - softw, th + softw, dens);

  let t = 1.0 / vec2f(textureDimensions(tex_a));
  let gx = textureSample(tex_a, samp, in.uv + vec2f(t.x, 0.0)).x
         - textureSample(tex_a, samp, in.uv - vec2f(t.x, 0.0)).x;
  let gy = textureSample(tex_a, samp, in.uv + vec2f(0.0, t.y)).x
         - textureSample(tex_a, samp, in.uv - vec2f(0.0, t.y)).x;
  let n    = normalize(vec3f(-gx * 8.0, -gy * 8.0, 1.0));
  let ldir = normalize(vec3f(-0.45, -0.55, 0.65));
  let spec = pow(max(dot(n, ldir), 0.0), 24.0) * body;

  let rim = body * (1.0 - smoothstep(th + softw, th + softw + 0.35, dens));
  let key_rgb = hsv2rgb(vec3f(u.key_hue, 0.85, 1.0));

  let beat_flash = exp(-fract(u.beat_t) * 6.0) * u.beat_conf * 0.20;
  let boost = (1.0 + beat_flash) * (1.0 + u.tension * 0.25 + u.drop_pulse * 0.6);

  var c = vec3f(0.92) * body
        + key_rgb * rim * 0.40 * u.key_conf
        + vec3f(1.0) * spec * 0.9;
  c *= boost;
  return vec4f(c + vec3f(_t), body);
}

// ── liquid metal at night: dark mercury under moonlight. The blob body is
// near-black metal shaded by a fake normal (density gradient); the moon —
// a fixed cool light high to the left — draws a hard specular glint and a
// fresnel rim. Timbre controls the meniscus: saw = razor, sine = mist.
// fwidth-based AA keeps contours clean at any canvas scale.
@fragment
fn fs_render(in: VSOut) -> @location(0) vec4f {
  let _t = touch_all(in.uv);
  let dens = textureSample(tex_a, samp, in.uv).x;

  let aa    = fwidth(dens) * 1.5;
  let softw = max(mix(0.10, 0.03, u.sharpness), aa);
  let th    = 0.20;
  let body  = smoothstep(th - softw, th + softw, dens);

  // Fake surface normal from density gradient — the "dome" of each blob
  let t = 1.0 / vec2f(textureDimensions(tex_a));
  let gx = textureSample(tex_a, samp, in.uv + vec2f(t.x, 0.0)).x
         - textureSample(tex_a, samp, in.uv - vec2f(t.x, 0.0)).x;
  let gy = textureSample(tex_a, samp, in.uv + vec2f(0.0, t.y)).x
         - textureSample(tex_a, samp, in.uv - vec2f(0.0, t.y)).x;
  let n = normalize(vec3f(-gx * 10.0, -gy * 10.0, 1.0));

  let moon  = vec3f(0.85, 0.90, 1.00);          // cold moonlight
  let deep  = vec3f(0.006, 0.008, 0.016);       // near-black metal body
  let ldir  = normalize(vec3f(-0.35, -0.75, 0.55));
  let half_ = normalize(ldir + vec3f(0.0, 0.0, 1.0));

  let ndl     = max(dot(n, ldir), 0.0);
  let spec    = pow(max(dot(n, half_), 0.0), 96.0);
  let fresnel = pow(1.0 - abs(n.z), 2.5);

  let beat_flash = exp(-fract(u.beat_t) * 6.0) * u.beat_conf * 0.15;
  let boost = (1.0 + beat_flash) * (1.0 + u.tension * 0.20 + u.drop_pulse * 0.5);

  var c = mix(deep, moon * 0.16, ndl * ndl) * body   // near-black metallic body
        + moon * spec * 2.6 * body                    // blazing moon glint
        + moon * fresnel * 0.70 * body;               // silver rim
  // A whisper of the key colour lives in the shadows
  c += hsv2rgb(vec3f(u.key_hue, 0.6, 1.0)) * 0.025 * body * u.key_conf;
  c *= boost;
  return vec4f(c + vec3f(_t), body * 0.8);
}
