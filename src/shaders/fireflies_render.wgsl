// FIREFLIES render — two entry-point pairs sharing one file:
//   vs_bg/fs_bg   — near-black night sky + faintest fbm tree-line silhouettes
//   vs_fly/fs_fly — instanced additive quads, soft round warm-amber sprites.
// Blink brightness comes straight from the Kuramoto phase: sharp attack at
// phase wrap, exponential decay tail. Depth: near flies are bigger, brighter
// and blurrier (wider gaussian). Startled flies go dark.
// Extra slot map documented in fireflies_compute.wgsl.

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

struct Fly {
  pos:     vec2f,
  vel:     vec2f,
  phase:   f32,
  detune:  f32,
  depth:   f32,
  startle: f32,
}

@group(0) @binding(0) var<uniform>       u:     Uniforms;
@group(0) @binding(1) var<storage, read> flies: array<Fly>;

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

// ═══════════════════════ background: night forest ═══════════════════════

fn hash21(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
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
fn fbm(p: vec2f) -> f32 {
  var v = 0.0;
  var a = 0.5;
  var q = p;
  for (var i = 0; i < 4; i++) {
    v += a * vnoise(q);
    q = q * 2.13 + vec2f(17.7, 9.2);
    a *= 0.5;
  }
  return v;
}

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
  let p   = vec2f(in.ndc.x * asp, in.ndc.y);     // world coords, y up
  let sd  = u.scene_seed * 13.7;

  // moonless-night sky: barely-there blue, a touch lighter up top
  var col = mix(vec3f(0.0032, 0.0048, 0.0075),
                vec3f(0.0085, 0.0125, 0.0195),
                clamp(p.y * 0.5 + 0.5, 0.0, 1.0));
  // faint moon haze behind the canopy, position rolled by sceneSeed
  let moon = vec2f((fract(sd * 0.373) - 0.5) * asp * 1.2, 0.55 + fract(sd * 0.617) * 0.35);
  col += vec3f(0.010, 0.012, 0.015) * exp(-dot(p - moon, p - moon) * 2.2);

  // tree-line silhouette along the bottom — irregular fbm ridge
  let ridge = -0.62 + fbm(vec2f(p.x * 1.15 + sd, sd * 0.7)) * 0.55;
  let mTree = smoothstep(ridge + 0.05, ridge - 0.05, p.y);
  let fol   = fbm(p * vec2f(2.6, 3.8) + sd);
  col = mix(col, vec3f(0.0012, 0.0022, 0.0012) + fol * vec3f(0.0022, 0.0034, 0.0016), mTree);

  // hanging canopy across the top
  let can = 0.80 - fbm(vec2f(p.x * 0.95 + sd * 1.7, 4.2 + sd)) * 0.38;
  let mCan = smoothstep(can - 0.06, can + 0.06, p.y);
  col = mix(col, vec3f(0.0012, 0.0022, 0.0012) + fol * 0.002, mCan * 0.92);

  // DROP: screen-filling soft warm flash (the unison super-flash)
  let flash = u.extra[2].x;
  col += vec3f(1.0, 0.80, 0.45) * flash * 0.28
         * (1.0 - 0.3 * length(vec2f(p.x / asp, p.y)));

  return vec4f(col * u.trail_gain, 0.0);   // additive into faded accum
}

// ═══════════════════════════ firefly sprites ═══════════════════════════

struct VSOut {
  @builtin(position) pos:   vec4f,
  @location(0)       local: vec2f,
  @location(1)       glow:  f32,
  @location(2)       depth: f32,
  @location(3)       hash:  f32,
}

@vertex
fn vs_fly(@builtin(vertex_index) vi: u32) -> VSOut {
  let fi = vi / 6u;
  let ci = vi % 6u;
  let F  = flies[fi];

  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f( 1.0, -1.0), vec2f(-1.0,  1.0),
    vec2f(-1.0,  1.0), vec2f( 1.0, -1.0), vec2f( 1.0,  1.0),
  );
  let c    = corners[ci];
  let asp  = u.res_x / max(u.res_y, 1.0);
  let hash = rnd(fi * 2654435761u);

  // blink envelope: instant attack at phase wrap, exp decay measured in
  // SECONDS (phase/freq), so a flash is always a short ~0.2–0.35 s pop no
  // matter how slow the fly's cycle is. Freq formula mirrors the compute
  // shader exactly (same hash derivation) — keep the two in sync.
  let bps     = u.extra[0].x;
  let confSm  = u.extra[0].y;
  let kSup    = u.extra[0].w;
  let hasBeat = confSm * step(0.25, bps);
  let natural = 0.12 + hash * 0.25;
  let musical = max(bps, 0.25) * (1.0 + F.detune * (0.04 + kSup * 0.12));
  let freq    = mix(natural, musical, hasBeat);
  let secs    = F.phase / max(freq, 0.05);
  let env     = exp(-secs * (6.0 + freq * 2.5));
  // high-band sparkle: tiny per-fly per-frame brightness variance
  let flick = rnd(pcg(fi * 1663u + u32(u.frame) * 2246822519u));
  var glow = env * (1.0 - F.startle * 0.88)
             * (1.0 + u.high * u.mul_high * (flick - 0.5) * 1.6);
  glow *= 0.35 + F.depth * 0.9;                        // near = brighter
  glow += u.extra[2].x * (0.5 + F.depth * 0.7);        // drop unison flash

  // near = bigger + blurrier; lit flies swell slightly
  let px   = (2.5 + F.depth * 10.0) * (0.8 + hash * 0.5) * (1.0 + env * 0.35);
  let size = px / u.res_y;
  let clip = vec2f((F.pos.x + c.x * size) / asp, F.pos.y + c.y * size);
  return VSOut(vec4f(clip, 0.0, 1.0), c, glow, F.depth, hash);
}

@fragment
fn fs_fly(in: VSOut) -> @location(0) vec4f {
  let d2 = dot(in.local, in.local);
  if (d2 > 1.0) { discard; }

  // soft gaussian core + wide faint halo; near flies blur wider
  let soft = mix(9.0, 3.2, in.depth);
  let g    = exp(-d2 * soft) + exp(-d2 * 1.6) * 0.12;

  // warm amber, whisper of green variation per fly, subtle keyHue pull;
  // far flies read slightly cooler/dimmer through the night air
  var col = vec3f(1.0, 0.62 + in.hash * 0.16, 0.16);
  let key = hsv2rgb(vec3f(u.key_hue, 0.55, 1.0));
  col = mix(col, key, u.key_conf * 0.22);
  col = mix(col * vec3f(0.72, 0.86, 1.05), col, 0.35 + in.depth * 0.65);
  // the brightest moments whiten at the core — hot filament
  let hot = clamp(in.glow - 1.0, 0.0, 0.6) * (1.0 - d2);
  col = mix(col, vec3f(1.0, 0.94, 0.78), hot);

  // barely-visible resting body so the dark swarm still breathes
  let body = 0.005 * (0.3 + in.depth);
  let b = body + in.glow * 1.1;

  let a = g * u.trail_gain;
  return vec4f(col * b * a, b * a * 0.25);   // premultiplied, one/one additive
}
