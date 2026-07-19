// ACID — 1960s liquid light show. A real 2D incompressible fluid solver
// (Stam stable fluids) at half resolution: music never sets pixels, it only
// applies FORCES; the fluid integrates them into inherently smooth motion.
//
// Per frame: advect velocity (semi-Lagrangian) → forces + vorticity
// confinement → divergence → Jacobi pressure (~24 iters, warm-started) →
// project → advect dye (rgb = pigment, a = heat/thickness for buoyancy).
//
// Extra slots (vec4f at RIPPLE_OFFSET — written by src/presets/acid.js):
//   extra[0]  = (gridW, gridH, dt, shimmer)          shimmer = high env (render)
//   extra[1]  = (lamp0.x, lamp0.y, lamp0.heat, lampR_cells)
//   extra[2]  = (lamp1.x, lamp1.y, lamp1.heat, stir)  stir = mid env 0..1
//   extra[3]  = (lamp2.x, lamp2.y, lamp2.heat, velDampFactor)  per-frame mult
//   extra[4]  = (jet.x, jet.y, jetDir.x, jetDir.y)    positions in UV, y down
//   extra[5]  = (jetEnv, dropEnv, tapEnv, dropDyeEnv)
//   extra[6]  = (tap.x, tap.y, tapDir.x, tapDir.y)
//   extra[7]  = (hand0.x, hand0.y, hand0.vx, hand0.vy) pos UV, vel UV/s
//   extra[8]  = (hand0.present, hand0.grip, hand1.present, hand1.grip)
//   extra[9]  = (hand1.x, hand1.y, hand1.vx, hand1.vy)
//   extra[10] = (colA.rgb, vortEps)                    lamp dye colours
//   extra[11] = (colB.rgb, quiet)                      quiet 1 = silence
//   extra[12] = (colC.rgb, energy)                     colC = clashing accent
//   extra[13] = (bg.rgb, grain)                        render only
//   extra[14] = (buoy, injRate, dyeDampFactor, heatDampFactor)
//   extra[15] = (tapCol.rgb, aspect)

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
@group(0) @binding(1) var<storage, read>       velIn:  array<vec2f>;
@group(0) @binding(2) var<storage, read_write> velOut: array<vec2f>;
@group(0) @binding(3) var<storage, read>       dyeIn:  array<vec4f>;
@group(0) @binding(4) var<storage, read_write> dyeOut: array<vec4f>;
@group(0) @binding(5) var<storage, read>       pIn:    array<f32>;
@group(0) @binding(6) var<storage, read_write> pOut:   array<f32>;
@group(0) @binding(7) var<storage, read_write> divg:   array<f32>;

fn cidx(c: vec2i, gw: i32) -> u32 { return u32(c.y * gw + c.x); }

fn cc(c: vec2i, gw: i32, gh: i32) -> vec2i {
  return clamp(c, vec2i(0), vec2i(gw - 1, gh - 1));
}

fn velAt(c: vec2i, gw: i32, gh: i32) -> vec2f {
  return velIn[cidx(cc(c, gw, gh), gw)];
}

fn sampleVel(p: vec2f, gw: i32, gh: i32) -> vec2f {
  let q = clamp(p, vec2f(0.0), vec2f(f32(gw) - 1.001, f32(gh) - 1.001));
  let i0 = vec2i(floor(q));
  let f = q - floor(q);
  let a = mix(velAt(i0, gw, gh),               velAt(i0 + vec2i(1, 0), gw, gh), f.x);
  let b = mix(velAt(i0 + vec2i(0, 1), gw, gh), velAt(i0 + vec2i(1, 1), gw, gh), f.x);
  return mix(a, b, f.y);
}

fn dyeAt(c: vec2i, gw: i32, gh: i32) -> vec4f {
  return dyeIn[cidx(cc(c, gw, gh), gw)];
}

fn sampleDye(p: vec2f, gw: i32, gh: i32) -> vec4f {
  let q = clamp(p, vec2f(0.0), vec2f(f32(gw) - 1.001, f32(gh) - 1.001));
  let i0 = vec2i(floor(q));
  let f = q - floor(q);
  let a = mix(dyeAt(i0, gw, gh),               dyeAt(i0 + vec2i(1, 0), gw, gh), f.x);
  let b = mix(dyeAt(i0 + vec2i(0, 1), gw, gh), dyeAt(i0 + vec2i(1, 1), gw, gh), f.x);
  return mix(a, b, f.y);
}

fn curlAt(c: vec2i, gw: i32, gh: i32) -> f32 {
  let L = velAt(c + vec2i(-1, 0), gw, gh);
  let R = velAt(c + vec2i( 1, 0), gw, gh);
  let U = velAt(c + vec2i(0, -1), gw, gh);
  let D = velAt(c + vec2i(0,  1), gw, gh);
  return 0.5 * ((R.y - L.y) - (D.x - U.x));
}

// ── pass 1: semi-Lagrangian velocity advection ──────────────────────────
@compute @workgroup_size(16, 16)
fn cs_advect_vel(@builtin(global_invocation_id) gid: vec3u) {
  let gw = i32(u.extra[0].x);
  let gh = i32(u.extra[0].y);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= gw || y >= gh) { return; }
  let i = cidx(vec2i(x, y), gw);
  if (x == 0 || y == 0 || x == gw - 1 || y == gh - 1) { velOut[i] = vec2f(0.0); return; }
  let dt = u.extra[0].z;
  let damp = u.extra[3].w;
  let v = velIn[i];
  let p = vec2f(f32(x), f32(y)) - v * dt;
  velOut[i] = sampleVel(p, gw, gh) * damp;
}

// ── pass 2: forces (music → impulses) + vorticity confinement ───────────
@compute @workgroup_size(16, 16)
fn cs_forces(@builtin(global_invocation_id) gid: vec3u) {
  let gw = i32(u.extra[0].x);
  let gh = i32(u.extra[0].y);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= gw || y >= gh) { return; }
  let i = cidx(vec2i(x, y), gw);
  if (x == 0 || y == 0 || x == gw - 1 || y == gh - 1) { velOut[i] = vec2f(0.0); return; }

  let dt   = u.extra[0].z;
  let gwf  = f32(gw); let ghf = f32(gh);
  let gv   = vec2f(gwf, ghf);
  let pos  = vec2f(f32(x), f32(y));
  let c    = vec2i(x, y);
  var v    = velIn[i];

  // vorticity confinement — sharpens and sustains vortices (the "alive" look)
  let vortEps = u.extra[10].w;
  let wC = curlAt(c, gw, gh);
  let eta = 0.5 * vec2f(
    abs(curlAt(c + vec2i(1, 0), gw, gh)) - abs(curlAt(c + vec2i(-1, 0), gw, gh)),
    abs(curlAt(c + vec2i(0, 1), gw, gh)) - abs(curlAt(c + vec2i(0, -1), gw, gh)),
  );
  let el = length(eta);
  if (el > 1e-5) {
    let n = eta / el;
    v += vortEps * vec2f(n.y, -n.x) * wC * dt;
  }

  // buoyancy — hot dye rises (y is down, so up = -y)
  let buoy = u.extra[14].x;
  let heat = dyeIn[i].w;
  v.y -= buoy * heat * dt;

  // lamps — gentle heat plumes (bass makes them billow)
  let lampR = u.extra[1].w;
  for (var k = 0; k < 3; k++) {
    let L = u.extra[1 + k];
    let d = pos - L.xy * gv;
    let g = exp(-dot(d, d) / (lampR * lampR));
    v.y -= g * L.z * 80.0 * dt;
    // slight convergence at the lamp mouth so plumes neck like a lava lamp
    if (dot(d, d) > 1.0) {
      v -= normalize(d) * g * L.z * 18.0 * dt;
    }
  }

  // mid stir — two slow counter-rotating gyres wander the tank
  let stir = u.extra[2].w;
  if (stir > 0.005) {
    let t = u.time;
    let c1 = vec2f(0.32 + 0.10 * sin(t * 0.11), 0.42 + 0.09 * cos(t * 0.09)) * gv;
    let c2 = vec2f(0.68 + 0.10 * cos(t * 0.07), 0.58 + 0.09 * sin(t * 0.13)) * gv;
    let d1 = pos - c1; let d2 = pos - c2;
    let s2 = gwf * 0.30; let s2q = s2 * s2;
    let g1 = exp(-dot(d1, d1) / s2q);
    let g2 = exp(-dot(d2, d2) / s2q);
    let rot = vec2f(-d1.y, d1.x) / max(length(d1), 4.0) * g1
            - vec2f(-d2.y, d2.x) / max(length(d2), 4.0) * g2;
    v += rot * stir * 34.0 * dt;
  }

  // kick jet — one impulse whose vortex then lives and dies on its own
  let jetEnv = u.extra[5].x;
  if (jetEnv > 0.005) {
    let J = u.extra[4];
    let d = pos - J.xy * gv;
    let g = exp(-dot(d, d) / (26.0 * 26.0));
    v += J.zw * jetEnv * 950.0 * g * dt;
  }

  // drop — one strong radial+tangential surge from centre; the whole tank swirls
  let dropEnv = u.extra[5].y;
  if (dropEnv > 0.005) {
    let ctr = vec2f(0.5, 0.5) * gv;
    let d = pos - ctr;
    let r = max(length(d), 4.0);
    let dir = d / r;
    let tang = vec2f(-dir.y, dir.x);
    let g = exp(-r * r / (gwf * gwf * 0.16));
    v += (dir * 0.8 + tang * 0.55) * dropEnv * 520.0 * g * dt;
  }

  // tap — finger stir
  let tapEnv = u.extra[5].z;
  if (tapEnv > 0.005) {
    let T = u.extra[6];
    let d = pos - T.xy * gv;
    let r = max(length(d), 2.0);
    let g = exp(-dot(d, d) / (24.0 * 24.0));
    v += (T.zw * 650.0 + (d / r) * 220.0) * tapEnv * g * dt;
  }

  // hands — palm drags the fluid along its own motion; fist = suction
  for (var h = 0; h < 2; h++) {
    var H: vec4f; var present: f32; var grip: f32;
    if (h == 0) { H = u.extra[7]; present = u.extra[8].x; grip = u.extra[8].y; }
    else        { H = u.extra[9]; present = u.extra[8].z; grip = u.extra[8].w; }
    if (present > 0.1) {
      let d = pos - H.xy * gv;
      let rh = gwf * 0.10;
      let g = exp(-dot(d, d) / (rh * rh));
      let hv = H.zw * gv;                       // hand velocity in cells/s
      let open = present * (1.0 - grip);
      v += (hv - v) * min(1.0, 5.0 * dt) * g * open;
      if (grip > 0.3) {
        let r = max(length(d), 3.0);
        v -= (d / r) * grip * present * 340.0 * g * dt;
      }
    }
  }

  // speed clamp keeps the solver stable under stacked impulses
  let sp = length(v);
  if (sp > 320.0) { v *= 320.0 / sp; }
  velOut[i] = v;
}

// ── pass 3: divergence of velocity ──────────────────────────────────────
@compute @workgroup_size(16, 16)
fn cs_divergence(@builtin(global_invocation_id) gid: vec3u) {
  let gw = i32(u.extra[0].x);
  let gh = i32(u.extra[0].y);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= gw || y >= gh) { return; }
  let c = vec2i(x, y);
  let L = velAt(c + vec2i(-1, 0), gw, gh);
  let R = velAt(c + vec2i( 1, 0), gw, gh);
  let U = velAt(c + vec2i(0, -1), gw, gh);
  let D = velAt(c + vec2i(0,  1), gw, gh);
  divg[cidx(c, gw)] = 0.5 * ((R.x - L.x) + (D.y - U.y));
}

// ── pass 4: Jacobi pressure iteration (ping-ponged, warm-started) ───────
@compute @workgroup_size(16, 16)
fn cs_jacobi(@builtin(global_invocation_id) gid: vec3u) {
  let gw = i32(u.extra[0].x);
  let gh = i32(u.extra[0].y);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= gw || y >= gh) { return; }
  let c = vec2i(x, y);
  let pL = pIn[cidx(cc(c + vec2i(-1, 0), gw, gh), gw)];
  let pR = pIn[cidx(cc(c + vec2i( 1, 0), gw, gh), gw)];
  let pU = pIn[cidx(cc(c + vec2i(0, -1), gw, gh), gw)];
  let pD = pIn[cidx(cc(c + vec2i(0,  1), gw, gh), gw)];
  let i = cidx(c, gw);
  pOut[i] = (pL + pR + pU + pD - divg[i]) * 0.25;
}

// ── pass 5: subtract pressure gradient → divergence-free velocity ───────
@compute @workgroup_size(16, 16)
fn cs_project(@builtin(global_invocation_id) gid: vec3u) {
  let gw = i32(u.extra[0].x);
  let gh = i32(u.extra[0].y);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= gw || y >= gh) { return; }
  let i = cidx(vec2i(x, y), gw);
  if (x == 0 || y == 0 || x == gw - 1 || y == gh - 1) { velOut[i] = vec2f(0.0); return; }
  let c = vec2i(x, y);
  let pL = pIn[cidx(cc(c + vec2i(-1, 0), gw, gh), gw)];
  let pR = pIn[cidx(cc(c + vec2i( 1, 0), gw, gh), gw)];
  let pU = pIn[cidx(cc(c + vec2i(0, -1), gw, gh), gw)];
  let pD = pIn[cidx(cc(c + vec2i(0,  1), gw, gh), gw)];
  velOut[i] -= 0.5 * vec2f(pR - pL, pD - pU);
}

// ── pass 6: dye advection + gentle diffusion + music-driven injection ───
@compute @workgroup_size(16, 16)
fn cs_advect_dye(@builtin(global_invocation_id) gid: vec3u) {
  let gw = i32(u.extra[0].x);
  let gh = i32(u.extra[0].y);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= gw || y >= gh) { return; }
  let i = cidx(vec2i(x, y), gw);
  let dt  = u.extra[0].z;
  let gv  = vec2f(f32(gw), f32(gh));
  let pos = vec2f(f32(x), f32(y));
  let c   = vec2i(x, y);

  let v = velIn[i];
  var d = sampleDye(pos - v * dt, gw, gh);

  // gentle diffusion — a touch stronger in silence (colours melt together)
  let quiet = u.extra[11].w;
  let nb = 0.25 * (dyeAt(c + vec2i(-1, 0), gw, gh) + dyeAt(c + vec2i(1, 0), gw, gh)
                 + dyeAt(c + vec2i(0, -1), gw, gh) + dyeAt(c + vec2i(0, 1), gw, gh));
  d = mix(d, nb, 0.022 + quiet * 0.05);

  // dissipation (rgb pigment slow, heat faster)
  let E14 = u.extra[14];
  d = vec4f(d.rgb * E14.z, d.w * E14.w);

  // lamp injection — each lamp bleeds its own colour, dimming when quiet
  let injRate = E14.y;
  let dropDye = u.extra[5].w;
  let lampR = u.extra[1].w * 0.55;
  let colA = u.extra[10].rgb;
  let colB = u.extra[11].rgb;
  let colC = u.extra[12].rgb;
  for (var k = 0; k < 3; k++) {
    let L = u.extra[1 + k];
    let dd = pos - L.xy * gv;
    let g = exp(-dot(dd, dd) / (lampR * lampR));
    var col = colA;
    if (k == 1) { col = colB; }
    if (k == 2) { col = mix(colA, colB, 0.5); }
    let inj = col * L.z * injRate * (1.0 + dropDye * 7.0) * g * dt;
    d += vec4f(inj, dot(inj, vec3f(0.35)) * 1.5);
  }

  // kick jet carries a streak of the clashing accent
  let jetEnv = u.extra[5].x;
  if (jetEnv > 0.005) {
    let J = u.extra[4];
    let dd = pos - J.xy * gv;
    let g = exp(-dot(dd, dd) / (14.0 * 14.0));
    let inj = colC * jetEnv * 5.5 * g * dt;
    d += vec4f(inj, jetEnv * 3.0 * g * dt);
  }

  // drop pours fresh accent colour into the centre — the tank re-schemes
  if (dropDye > 0.005) {
    let dd = pos - vec2f(0.5, 0.5) * gv;
    let g = exp(-dot(dd, dd) / (f32(gw) * f32(gw) * 0.006));
    let inj = colC * dropDye * 5.0 * g * dt;
    d += vec4f(inj, dropDye * 2.5 * g * dt);
  }

  // tap dye
  let tapEnv = u.extra[5].z;
  if (tapEnv > 0.005) {
    let T = u.extra[6];
    let dd = pos - T.xy * gv;
    let g = exp(-dot(dd, dd) / (21.0 * 21.0));
    let inj = u.extra[15].rgb * tapEnv * 10.0 * g * dt;
    d += vec4f(inj, tapEnv * 4.0 * g * dt);
  }

  dyeOut[i] = min(d, vec4f(3.0, 3.0, 3.0, 1.8));
}
