// PYRO spark compute — embers as physical particles seeded from the sim.
// A dead slot occasionally probes random points; where the grid says "hot
// tongue with cool air just above" (the top surface of a flame), a spark is
// born with the local gas velocity. Alive sparks ride a curl-noise swirl,
// stay buoyant while hot, cool to dull red and vanish mid-air. Rendered as
// velocity-stretched streaks (pyro_spark_render.wgsl) — never round dots.
// Extra-slot map lives in pyro_sim.wgsl (extra[6].xy = rate, burst).

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

struct Spark {
  pos:  vec2f,   // sim uv, y up
  vel:  vec2f,   // uv/s
  heat: f32,
  life: f32,
  seed: f32,
  pad:  f32,
}

@group(0) @binding(0) var<uniform>             u:      Uniforms;
@group(0) @binding(1) var<storage, read>       grid:   array<vec2f>;
@group(0) @binding(2) var<storage, read_write> sparks: array<Spark>;

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rand01(v: u32) -> f32 { return f32(pcg(v) & 0xffffffu) / 16777215.0; }

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
fn curl2(q: vec2f) -> vec2f {
  let e = 0.12;
  let nx1 = vnoise(q + vec2f(e, 0.0));
  let nx2 = vnoise(q - vec2f(e, 0.0));
  let ny1 = vnoise(q + vec2f(0.0, e));
  let ny2 = vnoise(q - vec2f(0.0, e));
  return vec2f(ny1 - ny2, -(nx1 - nx2)) / (2.0 * e);
}

fn sampleT(p: vec2f, gw: i32, gh: i32) -> f32 {
  let pc = p * vec2f(f32(gw), f32(gh)) - 0.5;
  let x = clamp(pc.x, 0.0, f32(gw) - 1.001);
  let y = clamp(pc.y, 0.0, f32(gh) - 1.001);
  let x0 = i32(floor(x)); let y0 = i32(floor(y));
  let fx = x - f32(x0);   let fy = y - f32(y0);
  let x1 = min(x0 + 1, gw - 1); let y1 = min(y0 + 1, gh - 1);
  let a = grid[u32(y0 * gw + x0)].x; let b = grid[u32(y0 * gw + x1)].x;
  let c = grid[u32(y1 * gw + x0)].x; let d = grid[u32(y1 * gw + x1)].x;
  return mix(mix(a, b, fx), mix(c, d, fx), fy);
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= arrayLength(&sparks)) { return; }
  var s = sparks[i];
  let dt = u.delta;
  let gw = i32(u.extra[0].x);
  let gh = i32(u.extra[0].y);
  let E6 = u.extra[6];
  let asp = u.res_x / max(u.res_y, 1.0);
  let fr = u32(u.frame);

  if (s.life <= 0.0) {
    // ── spawn lottery: probe hot tongue surfaces in the sim ─────────────
    let rate = E6.x + E6.y;
    if (rand01(i * 7919u + fr * 104729u) < rate * dt * 4.0) {
      for (var k = 0u; k < 4u; k++) {
        let h1 = rand01(i * 3u + fr * 7717u + k * 131u);
        let h2 = rand01(i * 5u + fr * 6949u + k * 631u + 17u);
        let cand = vec2f(0.5 + (h1 - 0.5) * 0.85, 0.06 + h2 * h2 * 0.72);
        let T   = sampleT(cand, gw, gh);
        let Tup = sampleT(cand + vec2f(0.0, 0.05), gw, gh);
        if (T > 0.50 && Tup < 0.32) {
          let h3 = rand01(i * 11u + fr * 5099u + k);
          let h4 = rand01(i * 13u + fr * 4409u + k + 5u);
          s.pos  = cand;
          s.vel  = vec2f((h3 - 0.5) * 0.22, 0.26 + T * 0.32 + h4 * 0.16);
          s.heat = 0.72 + h4 * 0.33;
          s.life = 1.0;
          s.seed = h3;
          break;
        }
      }
    }
  } else {
    // ── flight: curl swirl + buoyancy while hot, drag, slow heat decay ──
    let q = vec2f(s.pos.x * asp * 4.0, s.pos.y * 4.0 - u.time * 0.8) + s.seed * 17.0;
    s.vel += curl2(q) * dt * (0.15 + s.heat * 0.85);
    s.vel.y += (0.85 * s.heat - 0.18) * dt;
    s.vel *= exp(-dt * 1.25);
    s.pos += s.vel * dt;
    s.heat *= exp(-dt / (0.50 + s.seed * 0.95));
    s.life = s.heat;
    // dim to dull red and vanish mid-air; cull offscreen
    if (s.heat < 0.11 || s.pos.y > 1.06 || s.pos.x < -0.06 || s.pos.x > 1.06) {
      s.life = 0.0;
    }
  }
  sparks[i] = s;
}
