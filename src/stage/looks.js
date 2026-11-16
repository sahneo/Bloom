import * as THREE from 'three/webgpu';
import {
  Fn, pass, vec2, vec3, vec4, float, uniform, screenUV, screenSize, texture,
  floor, fract, step, smoothstep, mix, clamp, pow, length, max, min, abs, dot, sin, hash, luminance,
  perspectiveDepthToViewZ, viewZToOrthographicDepth, cameraNear, cameraFar, atan,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

// STAGE looks — the 3D scene is rendered once, then re-drawn by one of
// these post passes. ASCII is the signature; the others are alternatives.
export const LOOKS = [
  { id: 'ascii',   label: 'ASCII',   hint: 'the hall rebuilt from glyphs' },
  { id: 'bitmap',  label: '1-BIT',   hint: 'two-ink ordered dither, newsprint rave' },
  { id: 'thermal', label: 'THERMAL', hint: 'heat camera: near = hot, light = hotter' },
  { id: 'clean',   label: 'RAW',     hint: 'the render itself, with bloom' },
];

// Glyph atlas: candidate characters are drawn once, measured for ink
// coverage and sorted — so the ramp is truly dark→bright for whatever
// monospace font the system has.
const GLYPH_N = 16;
function makeGlyphAtlas() {
  const cand = [' ', '.', '`', ',', ':', ';', '~', '=', '+', '*', 'x', 'o', 'a', '%', '#', '&', '@', 'M', 'W', '8', '0', '$'];
  const cw = 48, ch = 80;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d', { willReadFrequently: true });
  c.width = cw; c.height = ch;
  const font = `bold ${ch * 0.82}px "SF Mono", Menlo, Consolas, monospace`;
  const cover = cand.map(g => {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cw, ch);
    ctx.fillStyle = '#fff'; ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(g, cw / 2, ch / 2 + 2);
    const d = ctx.getImageData(0, 0, cw, ch).data;
    let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i];
    return { g, s };
  }).sort((a, b) => a.s - b.s);
  // pick GLYPH_N evenly across the coverage range (keeps blank + densest)
  const picks = [];
  for (let i = 0; i < GLYPH_N; i++) picks.push(cover[Math.round(i * (cover.length - 1) / (GLYPH_N - 1))].g);
  const atlas = document.createElement('canvas');
  atlas.width = cw * GLYPH_N; atlas.height = ch;
  const a = atlas.getContext('2d');
  a.fillStyle = '#000'; a.fillRect(0, 0, atlas.width, ch);
  a.fillStyle = '#fff'; a.font = font; a.textAlign = 'center'; a.textBaseline = 'middle';
  picks.forEach((g, i) => a.fillText(g, cw * i + cw / 2, ch / 2 + 2));
  // second row: line glyphs for depth edges  | / - \
  const lines = ['|', '/', '-', '\\'];
  const edge = document.createElement('canvas');
  edge.width = cw * 4; edge.height = ch;
  const e = edge.getContext('2d');
  e.fillStyle = '#000'; e.fillRect(0, 0, edge.width, ch);
  e.fillStyle = '#fff'; e.font = font; e.textAlign = 'center'; e.textBaseline = 'middle';
  lines.forEach((g, i) => e.fillText(g, cw * i + cw / 2, ch / 2 + 2));
  const mk = (cv) => {
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.NoColorSpace;
    tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    return tex;
  };
  return { fill: mk(atlas), edge: mk(edge) };
}

export class Looks {
  constructor(renderer, scene, camera, U) {
    this.renderer = renderer;
    this.U = U;
    this.scenePass = pass(scene, camera);
    this.pipeline = new THREE.RenderPipeline(renderer);
    const at = makeGlyphAtlas();
    this.atlas = at.fill;
    this.edgeAtlas = at.edge;
    this.cellPx = uniform(9);           // ASCII cell height in canvas px
    this.idx = 0;
    this.resScale = 1;
    this.set(0);
  }

  get current() { return LOOKS[this.idx]; }

  set(i) {
    this.idx = ((i % LOOKS.length) + LOOKS.length) % LOOKS.length;
    const id = LOOKS[this.idx].id;
    this.pipeline.outputNode = this[id]();
    this.pipeline.needsUpdate = true;
    this._applyRes();
  }

  // Quality tier → internal render scale. Glyph/dither looks quantise the
  // image anyway, so they render the 3D scene at a fraction of the canvas.
  setQuality(level) {
    this.resScale = [0.45, 0.6, 0.8, 1][level];
    this._applyRes();
  }
  _applyRes() {
    const id = LOOKS[this.idx].id;
    const lookScale = id === 'ascii' ? 0.5 : id === 'bitmap' ? 0.5 : id === 'thermal' ? 0.6 : 1;
    this.scenePass.setResolutionScale(Math.max(0.25, this.resScale * lookScale));
  }

  render() { this.pipeline.render(); }

  // ── ASCII ───────────────────────────────────────────────────────────
  ascii() {
    const U = this.U;
    const tex = this.scenePass.getTextureNode('output');
    const depthTex = this.scenePass.getTextureNode('depth');
    const atlas = texture(this.atlas);
    const edgeAtlas = texture(this.edgeAtlas);
    const cellPx = this.cellPx;
    const lin = (p) => viewZToOrthographicDepth(perspectiveDepthToViewZ(depthTex.sample(p).x, cameraNear, cameraFar), cameraNear, cameraFar);
    return Fn(() => {
      const cell = vec2(cellPx.mul(0.6), cellPx);                    // monospace aspect
      const grid = screenSize.div(cell);
      const id = floor(screenUV.mul(grid));
      const f = fract(screenUV.mul(grid));
      const cuv = id.add(0.5).div(grid);
      const c = tex.sample(cuv).rgb;
      const lum = luminance(c);
      // tone curve: true black stays blank, so structure reads instead of fog
      const v = pow(smoothstep(0.004, 0.55, lum), 0.62);
      const gi = floor(v.mul(GLYPH_N - 0.01));
      const g = atlas.sample(vec2(gi.add(f.x).div(GLYPH_N), f.y)).r;
      // depth edges → line glyphs oriented along the silhouette
      const du = vec2(float(1).div(grid.x), 0), dv = vec2(0, float(1).div(grid.y));
      const d0 = lin(cuv);
      const gx = lin(cuv.add(du)).sub(lin(cuv.sub(du)));
      const gy = lin(cuv.add(dv)).sub(lin(cuv.sub(dv)));
      const edgeK = smoothstep(0.03, 0.1, length(vec2(gx, gy)).div(max(d0, 0.004)));
      // gradient angle → tangent direction → one of | / - \
      const ang = atan(gy, gx).div(3.14159).add(1).mul(4);            // 0..8
      const ei = floor(ang.add(0.5)).mod(4);
      const eg = edgeAtlas.sample(vec2(ei.add(f.x).div(4), f.y)).r;
      // colour: hue of the scene, normalised so dim cells still carry colour
      const hueC = c.div(max(max(c.r, c.g), max(c.b, 0.02)));
      const ink = mix(vec3(0.75, 0.8, 0.78), hueC, 0.8).mul(v.mul(1.1).add(0.1));
      const edgeInk = mix(hueC, vec3(0.9), 0.45).mul(float(0.55).add(v.mul(0.6)));
      const glyph = mix(ink.mul(g), edgeInk.mul(eg), edgeK);
      // rare glitch rows on drops/strobes
      const glitch = step(0.985, hash(id.y.add(floor(U.time.mul(14))))).mul(U.drop.add(U.strobe));
      const out = glyph.add(c.mul(0.05)).add(vec3(glitch.mul(g).mul(0.6)));
      return vec4(out, 1);
    })();
  }

  // ── 1-BIT ordered dither ────────────────────────────────────────────
  bitmap() {
    const U = this.U;
    const tex = this.scenePass.getTextureNode('output');
    return Fn(() => {
      const px = float(2);                                            // chunky pixels
      const ip = floor(screenUV.mul(screenSize).div(px));
      const c = tex.sample(ip.add(0.5).mul(px).div(screenSize)).rgb;
      const lum = clamp(pow(luminance(c).mul(1.15), 0.75), 0, 1);
      // 4×4 Bayer from bit tricks: threshold per pixel position
      const x = ip.x.mod(4), y = ip.y.mod(4);
      const b = bayer4(x, y);
      const on = step(b, lum);
      const paper = mix(vec3(0.93, 0.9, 0.82), U.colA.mul(0.35).add(0.62), 0.25);
      const ink = mix(vec3(0.04, 0.04, 0.06), U.colB.mul(0.12), 0.5);
      const flashInv = step(0.5, U.strobe);
      const o = mix(ink, paper, on);
      return vec4(mix(o, vec3(1).sub(o), flashInv), 1);
    })();
  }

  // ── THERMAL ─────────────────────────────────────────────────────────
  thermal() {
    const U = this.U;
    const tex = this.scenePass.getTextureNode('output');
    const depth = this.scenePass.getLinearDepthNode();
    return Fn(() => {
      const c = tex.sample(screenUV).rgb;
      const near = depth.mul(cameraFar).mul(-1 / 14).exp();            // metres → warmth
      const heat = clamp(pow(luminance(c), 1.1).mul(0.75).add(near.mul(0.22)).add(U.drop.mul(0.12)), 0, 1);
      const scan = sin(screenUV.y.mul(screenSize.y).mul(1.5)).mul(0.04);
      const n = hash(screenUV.mul(screenSize).add(floor(U.time.mul(30)))).mul(0.05);
      return vec4(ironbow(clamp(heat.add(scan).add(n), 0, 1)), 1);
    })();
  }

  // ── RAW + bloom ─────────────────────────────────────────────────────
  clean() {
    const tex = this.scenePass.getTextureNode('output');
    const b = bloom(tex, 0.9, 0.5, 0.18);
    return Fn(() => {
      const col = tex.rgb.add(b.rgb);
      const vig = smoothstep(1.25, 0.35, length(screenUV.sub(0.5).mul(vec2(1.6, 1.2))));
      return vec4(col.mul(vig), 1);
    })();
  }

  dispose() {
    this.atlas.dispose();
    this.edgeAtlas.dispose();
    this.scenePass.dispose?.();
    this.pipeline.dispose?.();
  }
}

// 4×4 Bayer threshold for integer-valued float coords (0..3)
const bayer4 = (x, y) => {
  const M = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  let acc = float(0);
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
    const w = step(abs(x.sub(i)), 0.5).mul(step(abs(y.sub(j)), 0.5));
    acc = acc.add(w.mul((M[j * 4 + i] + 0.5) / 16));
  }
  return acc;
};

// black → indigo → magenta → orange → yellow → white
const ironbow = (h) => {
  const c0 = vec3(0.0, 0.0, 0.02), c1 = vec3(0.18, 0.02, 0.45), c2 = vec3(0.75, 0.05, 0.45);
  const c3 = vec3(1.0, 0.45, 0.02), c4 = vec3(1.0, 0.92, 0.25), c5 = vec3(1, 1, 1);
  const s = h.mul(5);
  let col = mix(c0, c1, clamp(s, 0, 1));
  col = mix(col, c2, clamp(s.sub(1), 0, 1));
  col = mix(col, c3, clamp(s.sub(2), 0, 1));
  col = mix(col, c4, clamp(s.sub(3), 0, 1));
  return mix(col, c5, clamp(s.sub(4), 0, 1));
};
