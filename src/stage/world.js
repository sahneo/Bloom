import * as THREE from 'three/webgpu';
import {
  Fn, vec2, vec3, vec4, float, uv, positionLocal, positionWorld, instanceIndex, hash,
  sin, cos, abs, fract, floor, step, smoothstep, mix, exp, max, min, clamp, length, pow,
  normalView, positionViewDirection, dot, attribute,
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// HALLE — an imagined post-industrial hall, not any real club: a long
// concrete nave with pillar rows, a ceiling truss, a booth under a pixel
// wall, a floating ring of light bars over the floor, hanging screens on
// cables, fixed beam rigs and a crowd of silhouettes.
//
// Everything that moves with the music is TSL running on the GPU, fed by
// the shared uniforms (U). JS only animates a handful of transforms.
//
// Units are metres; floor at y=0, booth at z=BOOTH_Z, crowd centre at CROWD_Z.
export const HALL = { w: 44, d: 90, h: 15, z0: 22 };   // spans z ∈ [z0-d, z0]
export const BOOTH_Z = -40;
export const CROWD_Z = -16;

const SCREEN_N = 9;
const BEAM_N = 14;
const HALO_N = 56;

const pulse01 = (x) => exp(fract(x).mul(-6));            // sharp attack each integer
const sat = (x) => clamp(x, 0, 1);

export function buildWorld(scene, U, quality) {
  const upd = [];   // per-frame JS updaters
  const meshes = {};

  // ── Atmosphere ──────────────────────────────────────────────────────
  scene.background = new THREE.Color(0x020203);
  scene.fog = new THREE.FogExp2(0x05060a, 0.022);

  const hemi = new THREE.HemisphereLight(0x8899aa, 0x101010, 0.6);
  scene.add(hemi);

  // Four moving coloured point lights give the crowd + floor real shading
  const lights = [];
  for (let i = 0; i < 4; i++) {
    const l = new THREE.PointLight(0xffffff, 0, 34, 1.4);
    l.position.set((i - 1.5) * 9, 6, CROWD_Z - 6);
    scene.add(l);
    lights.push(l);
  }

  // ── Shell: floor, walls, ceiling ────────────────────────────────────
  {
    const floorMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.32, metalness: 0.0 });
    floorMat.colorNode = Fn(() => {
      const p = positionWorld.xz;
      // poured-concrete slabs with dark seams + grime noise
      const seam = max(step(0.97, fract(p.x.div(4))), step(0.97, fract(p.y.div(4))));
      const grime = hash(floor(p.mul(1.7)).dot(vec2(1, 57))).mul(0.04);
      return vec3(0.055).add(grime).mul(float(1).sub(seam.mul(0.6)));
    })();
    // Kick → expanding light ring on the floor around the crowd centre
    floorMat.emissiveNode = Fn(() => {
      const d = length(positionWorld.xz.sub(vec2(0, CROWD_Z)));
      const r = U.kickAge.mul(22);
      const ring = exp(abs(d.sub(r)).mul(-1.6)).mul(exp(U.kickAge.mul(-2.2)));
      const under = exp(length(positionWorld.xz.sub(vec2(0, BOOTH_Z + 4))).mul(-0.18)).mul(U.bass.mul(0.5).add(0.1));
      return U.colA.mul(ring.mul(0.9)).add(U.colB.mul(under.mul(0.35)));
    })();
    const floor_ = new THREE.Mesh(new THREE.PlaneGeometry(HALL.w, HALL.d), floorMat);
    floor_.rotation.x = -Math.PI / 2;
    floor_.position.z = HALL.z0 - HALL.d / 2;
    scene.add(floor_);

    const wallMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, side: THREE.BackSide });
    wallMat.colorNode = vec3(0.06, 0.06, 0.066);
    // vertical LED slits along the long walls — they sparkle with the highs
    wallMat.emissiveNode = Fn(() => {
      const p = positionWorld;
      const sideWall = step(HALL.w / 2 - 0.3, abs(p.x));
      const slit = step(0.94, fract(p.z.div(6))).mul(step(1.5, p.y)).mul(step(p.y, HALL.h - 2));
      const seg = floor(p.y.mul(1.5)).add(floor(p.z.div(6)).mul(7.1));
      const tw = step(0.55, hash(seg.add(floor(U.time.mul(8))))).mul(U.high.mul(1.6)).add(0.04);
      const chase = pulse01(U.beatT.mul(0.5).sub(p.z.div(36))).mul(U.beatConf);
      return mix(U.colA, vec3(1), 0.3).mul(slit.mul(sideWall).mul(tw.add(chase.mul(0.8))));
    })();
    const shell = new THREE.Mesh(new THREE.BoxGeometry(HALL.w, HALL.h, HALL.d), wallMat);
    shell.position.set(0, HALL.h / 2 - 0.01, HALL.z0 - HALL.d / 2);
    scene.add(shell);
  }

  // ── Pillars (instanced) with a light band that chases down the nave ──
  {
    const rows = [];
    for (let z = HALL.z0 - 10; z > HALL.z0 - HALL.d + 6; z -= 9) rows.push(z);
    const n = rows.length * 2;
    const geo = new THREE.BoxGeometry(0.9, HALL.h, 0.9);
    geo.translate(0, HALL.h / 2, 0);
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85 });
    mat.colorNode = vec3(0.07, 0.07, 0.075);
    mat.emissiveNode = Fn(() => {
      const y = positionLocal.y;
      const band = step(3.2, y).mul(step(y, 3.5)).add(step(9.0, y).mul(step(y, 9.15)));
      const row = floor(float(instanceIndex).div(2));
      const chase = pulse01(U.beatT.sub(row.mul(0.25))).mul(U.beatConf.mul(0.8).add(0.2));
      return U.colB.mul(band.mul(chase.mul(2.2).add(U.drop.mul(3))));
    })();
    const im = new THREE.InstancedMesh(geo, mat, n);
    const m = new THREE.Matrix4();
    rows.forEach((z, i) => {
      im.setMatrixAt(i * 2,     m.makeTranslation(-13, 0, z));
      im.setMatrixAt(i * 2 + 1, m.makeTranslation( 13, 0, z));
    });
    scene.add(im);
  }

  // ── Ceiling truss: thin instanced beams in a grid (reads great as ASCII) ─
  {
    const bars = [];
    for (let x = -18; x <= 18; x += 6) bars.push({ p: [x, HALL.h - 2.5, HALL.z0 - HALL.d / 2], s: [0.25, 0.25, HALL.d - 4] });
    for (let z = HALL.z0 - 6; z > HALL.z0 - HALL.d; z -= 6) bars.push({ p: [0, HALL.h - 2.5, z], s: [HALL.w - 6, 0.2, 0.2] });
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.5, metalness: 0.6 });
    mat.colorNode = vec3(0.12);
    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, bars.length);
    const m = new THREE.Matrix4();
    bars.forEach((b, i) => im.setMatrixAt(i, m.compose(new THREE.Vector3(...b.p), new THREE.Quaternion(), new THREE.Vector3(...b.s))));
    scene.add(im);
  }

  // ── Booth + pixel wall (the "installation" behind the DJ) ────────────
  {
    const riser = new THREE.Mesh(new THREE.BoxGeometry(14, 1.2, 6),
      new THREE.MeshStandardNodeMaterial({ color: 0x0b0b0c, roughness: 0.7 }));
    riser.position.set(0, 0.6, BOOTH_Z);
    scene.add(riser);
    const booth = new THREE.Mesh(new THREE.BoxGeometry(4.5, 1.1, 1.4),
      new THREE.MeshStandardNodeMaterial({ color: 0x111113, roughness: 0.4, metalness: 0.5 }));
    booth.position.set(0, 1.75, BOOTH_Z + 1.2);
    scene.add(booth);

    const wallW = 30, wallH = 10;
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.colorNode = Fn(() => {
      const grid = vec2(72, 24);
      const cell = floor(uv().mul(grid));
      const f = fract(uv().mul(grid)).sub(0.5);
      const led = smoothstep(0.5, 0.22, length(f));                     // round LED dots
      const c = cell.div(grid);
      // spectrum skyline from the centre outwards + travelling key-coloured wave
      const fromC = abs(c.x.sub(0.5)).mul(2);
      const level = mix(mix(U.sub, U.bass, sat(fromC.mul(3))), mix(U.mid, U.high, sat(fromC.mul(2).sub(1))), sat(fromC.mul(1.5).sub(0.2)));
      const sky = step(c.y, level.mul(0.85).add(0.04).add(hash(cell.x.add(floor(U.time.mul(6)))).mul(0.05)));
      const wave = smoothstep(0.85, 1.0, sin(c.x.mul(9).add(c.y.mul(4)).sub(U.beatT.mul(3.14159))).mul(0.5).add(0.5));
      const flash = pulse01(U.beatT).mul(U.kick).mul(0.6);
      const strobe = U.strobe.mul(step(0.5, hash(cell.x.add(cell.y.mul(91)).add(floor(U.time.mul(20))))));
      const col = U.colA.mul(sky.mul(1.4)).add(U.colB.mul(wave.mul(0.8))).add(vec3(1).mul(flash.add(strobe).add(U.drop.mul(0.8))));
      return col.mul(led).add(vec3(0.012));
    })();
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(wallW, wallH), mat);
    wall.position.set(0, 1.4 + wallH / 2, BOOTH_Z - 3.2);
    scene.add(wall);
    meshes.pixelWall = wall;
  }

  // ── HALO: a ring of hanging light bars over the floor ────────────────
  const halo = new THREE.Group();
  {
    const geo = new THREE.BoxGeometry(0.16, 3.2, 0.16);
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.colorNode = Fn(() => {
      const k = float(instanceIndex).div(HALO_N);
      const chase = pulse01(k.mul(4).sub(U.beatT.mul(0.5))).mul(U.beatConf.mul(0.7).add(0.3));
      const spec = mix(U.bass, U.high, abs(sin(k.mul(6.2832).add(U.time.mul(0.3)))));
      const yfade = smoothstep(-1.6, 1.6, positionLocal.y.mul(sin(U.time.add(k.mul(12))).sign()));
      const lit = chase.mul(1.4).add(spec.mul(0.9)).add(U.drop.mul(2)).add(U.strobe).mul(yfade.mul(0.7).add(0.3));
      return mix(U.colA, U.colB, step(0.5, fract(k.mul(8)))).mul(lit.mul(1.6)).add(vec3(0.015));
    })();
    const im = new THREE.InstancedMesh(geo, mat, HALO_N);
    const m = new THREE.Matrix4();
    for (let i = 0; i < HALO_N; i++) {
      const a = (i / HALO_N) * Math.PI * 2;
      im.setMatrixAt(i, m.makeTranslation(Math.cos(a) * 7.5, 0, Math.sin(a) * 7.5));
    }
    halo.add(im);
    halo.position.set(0, 9.5, CROWD_Z);
    scene.add(halo);
  }

  // ── Hanging screens on cables ─────────────────────────────────────────
  const screens = [];
  {
    const geo = new THREE.BoxGeometry(4, 2.25, 0.08);
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.colorNode = Fn(() => {
      const id = float(instanceIndex);
      const t = id.mod(4);
      const p = uv();
      // 0: spectrum bars
      const bx = floor(p.x.mul(18));
      const lvl = mix(mix(U.sub, U.bass, sat(bx.div(6))), mix(U.mid, U.high, sat(bx.div(6).sub(1.5))), sat(bx.div(9).sub(0.6)));
      const bars = step(p.y, lvl.mul(0.9).add(0.05)).mul(step(0.15, fract(p.x.mul(18))));
      // 1: scan stripes scrolling on the beat
      const stripes = step(0.82, fract(p.y.mul(9).sub(U.beatT.add(id.mul(0.13)))));
      // 2: concentric pulse
      const rings = step(0.75, fract(length(p.sub(0.5).mul(vec2(1.78, 1))).mul(7).sub(U.beatT)));
      // 3: bar-locked checkerboard that inverts every beat
      const chk = abs(step(0.5, fract(p.x.mul(8))).sub(step(0.5, fract(p.y.mul(4.5)))));
      const checker = abs(chk.sub(step(0.5, fract(U.beatT.mul(0.5)))));
      const pat = select4(t, bars, stripes, rings, checker);
      const midiHit = U.note.mul(exp(abs(id.div(SCREEN_N - 1).sub(U.notePos)).mul(-6)));
      const tint = mix(U.colA, U.colB, step(1.5, t).mul(0.7));
      const bright = pat.mul(U.energy.mul(1.2).add(0.35)).add(midiHit.mul(1.5)).add(U.drop).add(U.strobe.mul(0.8));
      const frame = max(step(0.985, abs(p.x.sub(0.5)).mul(2)), step(0.97, abs(p.y.sub(0.5)).mul(2)));
      return tint.mul(bright.mul(1.5)).add(vec3(frame.mul(0.08))).add(vec3(0.01));
    })();
    const im = new THREE.InstancedMesh(geo, mat, SCREEN_N);
    scene.add(im);
    meshes.screens = im;
    for (let i = 0; i < SCREEN_N; i++) {
      const a = (i / SCREEN_N) * Math.PI * 2 + 0.4;
      const r = 3 + (i % 3) * 3.6;
      screens.push({
        x: Math.cos(a) * r * 1.3, z: CROWD_Z + Math.sin(a) * r * 1.1 - 2,
        y: 5.2 + (i % 4) * 0.9, yaw: a + Math.PI / 2 + (i % 2) * 0.6,
        swing: 0.2 + (i % 3) * 0.1, ph: i * 1.7,
      });
    }
    // cables: 2 per screen, ceiling → top corners
    const cableGeo = new THREE.BufferGeometry();
    cableGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SCREEN_N * 4 * 3), 3));
    const cables = new THREE.LineSegments(cableGeo, new THREE.LineBasicNodeMaterial({ color: 0x3a3a40 }));
    cables.frustumCulled = false;
    scene.add(cables);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(1, 1, 1);
    const pos = new THREE.Vector3(), corner = new THREE.Vector3();
    upd.push((t, U_) => {
      const sway = U_.bass.value * 0.25 + U_.drop.value * 0.4;
      const arr = cableGeo.attributes.position.array;
      screens.forEach((sc, i) => {
        e.set(Math.sin(t * 0.7 + sc.ph) * 0.05 * (1 + sway * 4), sc.yaw + Math.sin(t * 0.21 + sc.ph) * sc.swing, Math.sin(t * 0.5 + sc.ph) * 0.03 * (1 + sway * 3));
        q.setFromEuler(e);
        pos.set(sc.x, sc.y + Math.sin(t * 0.33 + sc.ph) * 0.25, sc.z);
        m.compose(pos, q, s);
        im.setMatrixAt(i, m);
        for (let c = 0; c < 2; c++) {
          corner.set(c ? 1.9 : -1.9, 1.12, 0).applyMatrix4(m);
          const o = (i * 4 + c * 2) * 3;
          arr[o] = corner.x; arr[o + 1] = HALL.h - 2.5; arr[o + 2] = corner.z;
          arr[o + 3] = corner.x; arr[o + 4] = corner.y; arr[o + 5] = corner.z;
        }
      });
      im.instanceMatrix.needsUpdate = true;
      cableGeo.attributes.position.needsUpdate = true;
    });
  }

  // ── Beam rigs: additive volumetric cones sweeping through the haze ────
  const beams = [];
  {
    const len = 34;
    const geo = new THREE.CylinderGeometry(0.06, 2.6, len, 20, 1, true);
    geo.translate(0, -len / 2, 0);
    geo.rotateX(-Math.PI / 2);                     // apex at origin, cone along +Z
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    mat.fog = false;
    mat.colorNode = Fn(() => {
      const z = attribute('position', 'vec3').z;          // geometry space (pre-instance)
      const along = exp(z.mul(-0.07)).mul(smoothstep(0.0, 1.2, z));
      const edge = pow(abs(dot(normalView, positionViewDirection)), 2.2);
      const k = float(instanceIndex);
      const gate = mix(float(1), step(0.5, fract(U.beatT.mul(2).add(k.mul(0.5)))), U.tension.mul(0.6));
      const lvl = U.energy.mul(0.5).add(0.12).add(U.drop.mul(1.4)).add(U.strobe.mul(1.5)).mul(gate).mul(U.haze.mul(0.8).add(0.4));
      const col = mix(U.colA, U.colB, step(0.5, fract(k.mul(0.5)))).add(vec3(U.strobe.mul(0.6)));
      return col.mul(along.mul(edge).mul(lvl).mul(1.1));
    })();
    const im = new THREE.InstancedMesh(geo, mat, BEAM_N);
    im.frustumCulled = false;
    scene.add(im);
    meshes.beams = im;
    for (let i = 0; i < BEAM_N; i++) {
      const front = i < 8;
      beams.push({
        origin: new THREE.Vector3(front ? (i - 3.5) * 3.2 : (i % 2 ? 16 : -16), front ? HALL.h - 2.7 : 9, front ? BOOTH_Z + 2 : CROWD_Z + ((i - 8) >> 1) * 8 - 4),
        ph: i * 0.37,
      });
    }
    const m = new THREE.Matrix4(), tgt = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const look = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1);
    upd.push((t, U_, st) => {
      const bt = U_.beatT.value;
      const pattern = st.beamPattern;          // switches on phrases/drops
      beams.forEach((b, i) => {
        let ax, az;
        if (pattern === 0) {                    // slow fan sweep
          ax = Math.sin(t * 0.35 + b.ph) * 10; az = CROWD_Z + Math.cos(t * 0.27 + b.ph * 2) * 8;
        } else if (pattern === 1) {             // beat-stepped crossing
          const step_ = Math.floor(bt) % 4;
          ax = ((i + step_) % 4 - 1.5) * 7; az = CROWD_Z + ((i >> 1) % 3 - 1) * 7;
        } else {                                // converge on the halo centre, breathing
          ax = Math.sin(t * 1.3 + b.ph) * (2 + U_.bass.value * 4); az = CROWD_Z + Math.cos(t * 1.1 + b.ph) * 3;
        }
        tgt.set(ax, 0, az);
        look.lookAt(tgt, b.origin, up);         // +Z of the cone → from origin toward target
        q.setFromRotationMatrix(look);
        m.compose(b.origin, q, s);
        im.setMatrixAt(i, m);
      });
      im.instanceMatrix.needsUpdate = true;
      // point lights ride the same colours, punch on kicks
      lights.forEach((l, i) => {
        l.color.copy(i % 2 ? U_.colB.value : U_.colA.value);
        l.intensity = (60 + U_.kick.value * 200 + U_.drop.value * 400 + U_.strobe.value * 300) * (0.5 + U_.energy.value);
        l.position.x = Math.sin(t * 0.4 + i * 1.6) * 12;
        l.position.z = CROWD_Z + Math.cos(t * 0.3 + i) * 10;
      });
      hemi.intensity = 0.55 + U_.strobe.value * 2.5 + U_.drop.value * 0.8;
    });
  }

  // ── Crowd: instanced silhouettes bouncing on the beat ─────────────────
  {
    const body = new THREE.CapsuleGeometry(0.22, 0.75, 3, 8);
    body.translate(0, 0.98, 0);
    const head = new THREE.SphereGeometry(0.13, 8, 6);
    head.translate(0, 1.66, 0);
    const geo = mergeGeometries([body.toNonIndexed(), head.toNonIndexed()]);
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.75, metalness: 0.1 });
    const seed = hash(float(instanceIndex).mul(1.37));
    const seed2 = hash(float(instanceIndex).mul(7.11).add(3));
    mat.positionNode = Fn(() => {
      // two dancer "types": bouncers (on every beat) and swayers (half time)
      const bouncer = step(0.35, seed);
      const ph = U.beatT.add(seed2.mul(0.25));
      const bounce = abs(sin(ph.mul(3.14159))).mul(mix(0.04, 0.16, U.energy)).mul(bouncer);
      const jump = U.drop.mul(0.55).mul(step(0.5, seed2)).mul(abs(sin(ph.mul(3.14159))));
      const swayX = sin(ph.mul(1.5708).add(seed.mul(6))).mul(0.12).mul(positionLocal.y.sub(0.2).max(0)).mul(float(1).sub(bouncer.mul(0.6)));
      return positionLocal.add(vec3(swayX, bounce.add(jump), 0));
    })();
    mat.colorNode = vec3(0.03, 0.03, 0.035);
    // rim of key colour so silhouettes separate from the dark (ASCII needs edges)
    mat.emissiveNode = Fn(() => {
      const rim = pow(float(1).sub(abs(dot(normalView, positionViewDirection))), 3);
      return mix(U.colA, U.colB, seed).mul(rim.mul(U.energy.mul(0.6).add(0.15).add(U.drop)));
    })();
    const maxN = 700;
    const im = new THREE.InstancedMesh(geo, mat, maxN);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
    let n = 0, guard = 0;
    while (n < maxN && guard++ < 20000) {
      const x = (Math.random() * 2 - 1) * 15;
      const z = CROWD_Z + (Math.random() * 2 - 1) * 15;
      const e = (x / 15) ** 2 + ((z - CROWD_Z) / 15) ** 2;
      if (e > 1 || Math.random() < e * 0.6) continue;                 // denser in the middle
      if (Math.abs(x) < 2.4 && z > CROWD_Z + 3) continue;                // keep a lane for the floor camera
      const hgt = 0.88 + Math.random() * 0.24;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI + (Math.random() - 0.5) * 1.2 + Math.atan2(x, z - BOOTH_Z) * 0.6);
      m.compose(p.set(x, 0, z), q, sc.set(1, hgt, 1));
      im.setMatrixAt(n++, m);
    }
    im.count = n;
    im.userData.maxCount = n;
    scene.add(im);
    meshes.crowd = im;
  }

  return {
    meshes, halo, screens,
    update(t, st) {
      halo.rotation.y = t * 0.06 + U.beatT.value * 0.0;
      halo.position.y = 9.5 - U.drop.value * 2.2 - U.tension.value * 1.2;
      for (const f of upd) f(t, U, st);
      scene.fog.density = 0.008 + U.haze.value * 0.03;
      scene.fog.color.copy(U.colA.value).multiplyScalar(0.025 + U.strobe.value * 0.2);
    },
    setQuality(level) {
      // crowd density follows the quality tier
      const c = meshes.crowd;
      c.count = Math.round(c.userData.maxCount * [0.35, 0.55, 0.8, 1][level]);
    },
  };
}

// 4-way select by an integer-valued float (0..3)
function select4(t, a, b, c, d) {
  const w0 = step(t, 0.5);
  const w1 = step(0.5, t).mul(step(t, 1.5));
  const w2 = step(1.5, t).mul(step(t, 2.5));
  const w3 = step(2.5, t);
  return a.mul(w0).add(b.mul(w1)).add(c.mul(w2)).add(d.mul(w3));
}
