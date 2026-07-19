// PENDULUM — a science-museum pendulum-wave installation as a dark stage
// piece. JS integrates the choreography (master swing phase + slow cycle
// winding) and writes one instance per pendulum each frame; this shader
// renders four layers into the HDR accum:
//   vs_bg/fs_bg     — near-black stage, faint haze, floor plane, drop flash
//   vs_wire/fs_wire — thin low-alpha wires from the beam down to each bob
//   vs_refl/fs_refl — squashed under-glow reflection below the floor line
//   vs_bob/fs_bob   — soft HDR orbs with snare sparkle + quiet glints
// Instance = (bobX, bobY, ancX, ancY, sizePx, bright, extreme, depth).
// extra[0] = (sparkleEnv, dropFlash, unisonSm, dim)
// extra[1] = (floorY, quiet, nPend, -)

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
@group(0) @binding(1) var<storage, read> inst: array<f32>;

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rnd(seed: u32) -> f32 { return f32(pcg(seed)) / 4294967295.0; }

fn hsv2rgb(c: vec3f) -> vec3f {
  let k = fract(vec3f(c.x, c.x + 2.0 / 3.0, c.x + 1.0 / 3.0)) * 6.0;
  let rgb = clamp(abs(k - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  return c.z * mix(vec3f(1.0), rgb, c.y);
}

// bob body colour: warm tungsten pulled toward the track key, cooled by minor
fn bobColor(hash: f32) -> vec3f {
  var col = vec3f(1.0, 0.86 + hash * 0.08, 0.66);
  let key = hsv2rgb(vec3f(u.key_hue, 0.55, 1.0));
  col = mix(col, key, u.key_conf * 0.35);
  // tonality tilt: minor → cooler, major → warmer
  let warm = clamp(u.tonality * 0.5 + 0.5, 0.0, 1.0);
  col *= mix(vec3f(0.82, 0.92, 1.18), vec3f(1.10, 0.97, 0.82), warm);
  return col;
}

// ═════════════════════════ background stage ═════════════════════════

struct BGOut {
  @builtin(position) pos: vec4f,
  @location(0)       ndc: vec2f,
}

@vertex
fn vs_bg(@builtin(vertex_index) vi: u32) -> BGOut {
  var v = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let p = v[vi];
  return BGOut(vec4f(p, 0.0, 1.0), p);
}

@fragment
fn fs_bg(in: BGOut) -> @location(0) vec4f {
  let asp = u.res_x / max(u.res_y, 1.0);
  let p   = vec2f(in.ndc.x * asp, in.ndc.y);

  // void: barely-there blue-black, a hint lighter toward the beam
  var col = mix(vec3f(0.0026, 0.0032, 0.0048),
                vec3f(0.0060, 0.0074, 0.0110),
                clamp(p.y * 0.5 + 0.5, 0.0, 1.0));

  // soft stage haze behind the swing plane
  let hz = exp(-(p.x * p.x * 0.22 + (p.y - 0.10) * (p.y - 0.10) * 1.1));
  col += vec3f(0.0038, 0.0047, 0.0072) * hz;

  // floor plane with a pool of light under the array
  let fy = u.extra[1].x;
  let fm = smoothstep(fy + 0.015, fy - 0.08, p.y);
  let pool = exp(-p.x * p.x * 0.30) * exp(-(fy - p.y) * 2.4);
  col = mix(col, vec3f(0.0052, 0.0063, 0.0092) + vec3f(0.009, 0.010, 0.013) * pool, fm);
  // contact line where the wall meets the floor
  col += vec3f(0.0065, 0.0075, 0.0100) * exp(-abs(p.y - fy) * 34.0) * exp(-p.x * p.x * 0.22);

  // DROP: warm unison flash washing the whole stage
  let flash = u.extra[0].y;
  col += vec3f(0.90, 0.74, 0.50) * flash * 0.20
         * (1.0 - 0.35 * length(vec2f(p.x / asp, p.y)));

  return vec4f(col * u.trail_gain, 0.0);
}

// ══════════════════════════════ wires ══════════════════════════════

struct WireOut {
  @builtin(position) pos: vec4f,
  @location(0)       uv:  vec2f,   // x across width -1..1, y 0 anchor → 1 bob
  @location(1)       wb:  f32,
}

@vertex
fn vs_wire(@builtin(vertex_index) vi: u32) -> WireOut {
  let ii = vi / 6u;
  let ci = vi % 6u;
  let o  = ii * 8u;
  let bob   = vec2f(inst[o],      inst[o + 1u]);
  let anc   = vec2f(inst[o + 2u], inst[o + 3u]);
  let brt   = inst[o + 5u];
  let depth = inst[o + 7u];

  let asp = u.res_x / max(u.res_y, 1.0);
  // pixel space so wire width stays crisp at any resolution
  let aP = vec2f(anc.x / asp * u.res_x, anc.y * u.res_y) * 0.5;
  let bP = vec2f(bob.x / asp * u.res_x, bob.y * u.res_y) * 0.5;
  var d  = bP - aP;
  let n  = vec2f(-d.y, d.x) / max(length(d), 1e-4) * (0.85 - depth * 0.30);

  var along  = array<f32, 6>(0.0, 0.0, 1.0, 1.0, 0.0, 1.0);
  var across = array<f32, 6>(-1.0, 1.0, -1.0, -1.0, 1.0, 1.0);
  let P = mix(aP, bP, along[ci]) + n * across[ci];
  let clip = vec2f(P.x / (u.res_x * 0.5), P.y / (u.res_y * 0.5));

  let wb = (0.040 + brt * 0.022) * (1.0 - 0.45 * depth);
  return WireOut(vec4f(clip, 0.0, 1.0), vec2f(across[ci], along[ci]), wb);
}

@fragment
fn fs_wire(in: WireOut) -> @location(0) vec4f {
  let a = max(1.0 - in.uv.x * in.uv.x, 0.0);
  // fade out toward the beam so wires dissolve into the dark
  let fadeTop = 0.25 + 0.75 * in.uv.y;
  let col = vec3f(0.34, 0.42, 0.58) * (in.wb * a * fadeTop);
  return vec4f(col * u.trail_gain, 0.0);
}

// ═══════════════════════════ glowing bobs ═══════════════════════════

struct BobOut {
  @builtin(position) pos:     vec4f,
  @location(0)       local:   vec2f,
  @location(1)       bright:  f32,
  @location(2)       extreme: f32,
  @location(3)       hash:    f32,
  @location(4)       flick:   f32,
}

@vertex
fn vs_bob(@builtin(vertex_index) vi: u32) -> BobOut {
  let ii = vi / 6u;
  let ci = vi % 6u;
  let o  = ii * 8u;
  let bob     = vec2f(inst[o], inst[o + 1u]);
  let sizePx  = inst[o + 4u];
  let extreme = inst[o + 6u];

  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f( 1.0, -1.0), vec2f(-1.0,  1.0),
    vec2f(-1.0,  1.0), vec2f( 1.0, -1.0), vec2f( 1.0,  1.0),
  );
  let c    = corners[ci];
  let asp  = u.res_x / max(u.res_y, 1.0);
  let hash = rnd(ii * 2654435761u);
  let flick = rnd(pcg(ii * 1663u + u32(u.frame) * 2246822519u));

  // high band → per-bob brightness shimmer
  var b = inst[o + 5u] * (1.0 + u.high * u.mul_high * (flick - 0.5) * 0.9);

  let sPx  = sizePx * 3.0;                 // halo extent, px
  let clip = vec2f(bob.x / asp + c.x * sPx * 2.0 / u.res_x,
                   bob.y       + c.y * sPx * 2.0 / u.res_y);
  return BobOut(vec4f(clip, 0.0, 1.0), c, b, extreme, hash, flick);
}

@fragment
fn fs_bob(in: BobOut) -> @location(0) vec4f {
  let d2 = dot(in.local, in.local);
  if (d2 > 1.0) { discard; }
  let g = exp(-d2 * 11.0) + 0.06 * exp(-d2 * 2.4);

  var col = bobColor(in.hash);

  // snare sparkle on bobs caught at their motion extremes
  let spark = u.extra[0].x * smoothstep(0.80, 0.98, in.extreme) * step(0.55, in.flick);
  // quiet: rare slow glints so near-stillness still breathes
  let q  = u.extra[1].y;
  let gl = q * pow(max(sin(u.time * (0.22 + in.hash * 0.4) + in.hash * 41.0), 0.0), 24.0) * 0.35;

  var b = in.bright * (1.0 + spark * 1.5) + gl;
  // hottest moments whiten at the core
  let hot = clamp(b - 0.85, 0.0, 0.8) * (1.0 - d2);
  col = mix(col, vec3f(1.0, 0.98, 0.92), hot * 0.7);

  let v = g * b * u.trail_gain;
  return vec4f(col * v, v * 0.25);
}

// ══════════════════ floor reflection (under-glow) ══════════════════

@vertex
fn vs_refl(@builtin(vertex_index) vi: u32) -> BobOut {
  let ii = vi / 6u;
  let ci = vi % 6u;
  let o  = ii * 8u;
  let bob     = vec2f(inst[o], inst[o + 1u]);
  let sizePx  = inst[o + 4u];
  let extreme = inst[o + 6u];

  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f( 1.0, -1.0), vec2f(-1.0,  1.0),
    vec2f(-1.0,  1.0), vec2f( 1.0, -1.0), vec2f( 1.0,  1.0),
  );
  let c    = corners[ci];
  let asp  = u.res_x / max(u.res_y, 1.0);
  let hash = rnd(ii * 2654435761u);

  let fy   = u.extra[1].x;
  let ry   = 2.0 * fy - bob.y;                       // mirror about floor
  let dist = max(bob.y - fy, 0.0);                   // height above floor
  let b    = inst[o + 5u] * 0.10 * clamp(1.6 - dist * 1.3, 0.25, 1.0);

  let sPx  = sizePx * 3.0 * 1.5;
  let clip = vec2f(bob.x / asp + c.x * sPx * 2.4 / u.res_x,      // smeared wide
                   ry          + c.y * sPx * 2.0 / u.res_y * 0.45); // squashed
  return BobOut(vec4f(clip, 0.0, 1.0), c, b, extreme, hash, 0.0);
}

@fragment
fn fs_refl(in: BobOut) -> @location(0) vec4f {
  let d2 = dot(in.local, in.local);
  if (d2 > 1.0) { discard; }
  let g = exp(-d2 * 4.2);
  let col = bobColor(in.hash);
  let v = g * in.bright * u.trail_gain;
  return vec4f(col * v, v * 0.15);
}
