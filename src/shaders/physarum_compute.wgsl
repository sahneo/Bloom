// PHYSARUM — slime-mold agents + trail chemistry (compute).
// Two species deposit into their own channel of the trail grid and sense
// their own minus the rival's — two living networks compete for space.
// Extra slots:
//   extra[0] = (gridW, gridH, agentN, dropEnv)
//   extra[1] = (hand0 x, y, grip, present)      x,y canvas UV, y down
//   extra[2] = (hand1 x, y, grip, present)
//   extra[3] = (tapX, tapY, tapEnv, kickEnv)
//   extra[4] = (snareEnv, tension, speedMul, senseMul)
//   extra[5] = (depositMul, decay, pinch0, pinch1)

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
@group(0) @binding(1) var<storage, read_write> agents: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> trail: array<f32>;
@group(0) @binding(3) var<storage, read_write> trailOut: array<f32>;

fn hash1(n: f32) -> f32 {
  return fract(sin(n * 127.1 + 311.7) * 43758.5453);
}

fn cellIndex(p: vec2f, gw: f32, gh: f32, sp: u32) -> u32 {
  let cx = u32(clamp(p.x, 0.0, 0.9999) * gw);
  let cy = u32(clamp(p.y, 0.0, 0.9999) * gh);
  return (cy * u32(gw) + cx) * 2u + sp;
}

// sense own trail minus rival's at a normalized point
fn sense(p: vec2f, gw: f32, gh: f32, sp: u32) -> f32 {
  let q = fract(p);
  let i = cellIndex(q, gw, gh, sp);
  let j = cellIndex(q, gw, gh, 1u - sp);
  return trail[i] - trail[j] * 0.6;
}

@compute @workgroup_size(256)
fn cs_agents(@builtin(global_invocation_id) gid: vec3u) {
  let E0 = u.extra[0];
  let n  = u32(E0.z);
  let idx = gid.x;
  if (idx >= n) { return; }

  let gw = E0.x;
  let gh = E0.y;
  let dropEnv = E0.w;
  let E3 = u.extra[3];
  let E4 = u.extra[4];
  let E5 = u.extra[5];

  var a = agents[idx];
  var pos = a.xy;
  var ang = a.z;
  let sp   = u32(floor(a.w));
  let seed = fract(a.w);

  // ── sense: three whiskers, steer toward the strongest own-trail ──
  let sDist = (5.5 / gw) * E4.w;
  let sAng  = 0.42 + u.mid * 0.25;
  let dt    = min(u.delta, 0.05);
  let fwd   = vec2f(cos(ang), sin(ang));
  let wL = sense(pos + vec2f(cos(ang - sAng), sin(ang - sAng)) * sDist, gw, gh, sp);
  let wC = sense(pos + fwd * sDist, gw, gh, sp);
  let wR = sense(pos + vec2f(cos(ang + sAng), sin(ang + sAng)) * sDist, gw, gh, sp);

  let turn = (4.6 + u.high * 4.0) * dt;
  let jitterAmp = 0.25 + E4.x * 2.0 + E3.w * 1.2;
  let rnd = hash1(f32(idx) + u.frame * 0.37 + seed * 91.0);
  if (wC >= wL && wC >= wR) {
    ang += (rnd - 0.5) * 0.2 * jitterAmp;
  } else if (wL > wR) {
    ang -= turn * (1.0 + (rnd - 0.5) * jitterAmp);
  } else {
    ang += turn * (1.0 + (rnd - 0.5) * jitterAmp);
  }

  // ── hands: open palm attracts its species' network, fist repels all ──
  let asp = u.res_x / max(u.res_y, 1.0);
  for (var h = 0u; h < 2u; h++) {
    let H = u.extra[1u + h];
    if (H.w < 0.05) { continue; }
    var d = vec2f((H.x - pos.x) * asp, H.y - pos.y);
    let r = length(d);
    if (r > 0.45 || r < 1e-4) { continue; }
    let dir = d / r;
    let goal = atan2(dir.y, dir.x);
    var da = goal - ang;
    da = atan2(sin(da), cos(da));            // shortest arc
    let w = (1.0 - r / 0.45) * H.w;
    if (H.z > 0.55) {
      // fist: flee + panic speed
      ang -= da * min(1.0, 6.0 * dt) * w * (H.z - 0.55) * 4.0;
    } else if (h == sp) {
      // each palm shepherds its own species (right=amber net, left=key net)
      ang += da * min(1.0, 4.0 * dt) * w * (1.0 - H.z);
    }
  }

  // ── drop: radial blast from centre, then the network regrows ──
  if (dropEnv > 0.02) {
    let c = vec2f(0.5, 0.5);
    let d = pos - c;
    let r = max(length(d), 1e-3);
    let goal = atan2(d.y / r, d.x / r);
    var da = goal - ang;
    da = atan2(sin(da), cos(da));
    ang += da * min(1.0, dropEnv * 8.0 * dt);
  }

  // ── move (normalized units/s), wrap edges ──
  let speed = (0.045 + u.bass * u.mul_bass * 0.04 + E3.w * 0.04)
            * E4.z * (1.0 + dropEnv * 2.2);
  pos += vec2f(cos(ang), sin(ang)) * speed * dt;
  pos = fract(pos);

  // ── pinch: the hand seeds fresh agents of its species ──
  for (var h = 0u; h < 2u; h++) {
    let pinchAmt = select(E5.z, E5.w, h == 1u);
    if (pinchAmt > 0.35 && h == sp) {
      let H = u.extra[1u + h];
      if (H.w > 0.4 && hash1(f32(idx) * 3.7 + u.frame) < pinchAmt * 0.012) {
        let ra = rnd * 6.28318;
        pos = vec2f(H.x + cos(ra) * 0.02 / asp, H.y + sin(ra) * 0.02);
        ang = ra;
      }
    }
  }

  // ── deposit pheromone ──
  let ci = cellIndex(pos, gw, gh, sp);
  trail[ci] = trail[ci] + 0.05 * E5.x;

  agents[idx] = vec4f(pos, ang, f32(sp) + seed);
}

// ── diffuse + decay + food sources (hands / tap) ────────────────────
@compute @workgroup_size(16, 16)
fn cs_diffuse(@builtin(global_invocation_id) gid: vec3u) {
  let E0 = u.extra[0];
  let gw = i32(E0.x);
  let gh = i32(E0.y);
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (x >= gw || y >= gh) { return; }

  let E3 = u.extra[3];
  let E5 = u.extra[5];
  let decay = E5.y;

  for (var sp = 0; sp < 2; sp++) {
    var sum = 0.0;
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        let sx = (x + dx + gw) % gw;
        let sy = (y + dy + gh) % gh;
        sum += trail[u32((sy * gw + sx) * 2 + sp)];
      }
    }
    var v = (sum / 9.0) * decay;

    // food: tap drops a meal for both nets; open palms feed their own
    let p = vec2f((f32(x) + 0.5) / f32(gw), (f32(y) + 0.5) / f32(gh));
    let asp = u.res_x / max(u.res_y, 1.0);
    if (E3.z > 0.02) {
      let d = vec2f((E3.x - p.x) * asp, E3.y - p.y);
      v += exp(-dot(d, d) * 900.0) * E3.z * 0.55;
    }
    let H = u.extra[1u + u32(sp)];
    if (H.w > 0.05 && H.z < 0.55) {
      let d = vec2f((H.x - p.x) * asp, H.y - p.y);
      v += exp(-dot(d, d) * 1400.0) * H.w * (1.0 - H.z) * 0.22;
    }

    trailOut[u32((y * gw + x) * 2 + sp)] = min(v, 2.5);
  }
}
