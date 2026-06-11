import shaderSource from '../shaders/ascii.wgsl?raw';

// Luminance ramp; final order is re-sorted at init by measured ink coverage.
const RAMP = " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";
const ATLAS_COLS = 16;
const GLYPH_W = 16, GLYPH_H = 32;   // must match GLYPH_PX in ascii.wgsl

// Scene ids — must match scene_density() in ascii.wgsl
// 0 clouds, 1 waves, 2 forest, 3 rain, 4 stars, 5 mountains,
// 6 palms (hotline miami), 7 car, 8 city, 9 matrix, 10 eye,
// 11 storm, 12 invaders
const CALM      = [0, 4, 5, 8, 10];
const ENERGETIC = [1, 3, 7, 9, 11];
const N_SCENES  = 13;
const N_SILS    = 6;                // skull, raven, wolf, figure, hand, tree

export class AsciiPreset {
  constructor() {
    this.device        = null;
    this.canvas        = null;
    this.pipeline      = null;
    this.uniformBuffer = null;
    this.bindGroup     = null;
    this.glyphTex      = null;
    this.silTex        = null;

    // ── Scene director state ──
    this.sceneA = 0;                       // start on clouds
    this.sceneB = 0;
    this.blend  = 0;
    this.fading = false;
    this.sceneTimer    = 0;
    this.sceneDuration = 18 + Math.random() * 15;
    this.seedA  = Math.random() * 100;
    this.seedB  = 0;
    this.scroll = 0;

    this.silState  = 'cooldown';           // none|reveal|hold|dissolve|cooldown
    this.silIndex  = -1;
    this.reveal    = 0;
    this.silTimer  = 0;
    this.cooldown  = 25;
    this.holdDur   = 0;
    this.revealDur = 4;
    this._silCheck = 0;

    this.energyAvg = 0;
    // Smoothed band envelopes (fast attack, slow release) — raw FFT values
    // straight into uniforms at 120fps read as jitter, not as reactivity
    this._s = { bass: 0, mid: 0, high: 0, subBass: 0, kick: 0, snare: 0 };
    this._flickerT    = 0;
    this._flickerSeed = 0;

    this._glyphCount = RAMP.length;
    this._atlasRows  = Math.ceil(RAMP.length / ATLAS_COLS);
    this._u = new Float32Array(32);
  }

  async init(device, format, canvas) {
    this.device = device;
    this.canvas = canvas;

    this.glyphTex = this._uploadTexture(device, buildGlyphAtlas());
    this.silTex   = this._uploadTexture(device, buildSilhouetteAtlas());

    this.uniformBuffer = device.createBuffer({
      size:  128,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.sampler = device.createSampler({
      magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    });

    const module = device.createShaderModule({ label: 'ascii', code: shaderSource });

    const bgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer:  { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });

    this.bindGroup = device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.glyphTex.createView() },
        { binding: 2, resource: this.silTex.createView() },
        { binding: 3, resource: this.sampler },
      ],
    });

    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex:   { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });

    // Arrow keys switch scenes manually (auto-rotation resumes after)
    this._onKey = (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const dir  = e.key === 'ArrowRight' ? 1 : -1;
      const next = ((this.sceneA + dir) % N_SCENES + N_SCENES) % N_SCENES;
      this.sceneA = next;
      this.sceneB = next;
      this.blend  = 0;
      this.fading = false;
      this.sceneTimer = 0;
      this.seedA = Math.random() * 100;
    };
    window.addEventListener('keydown', this._onKey);
  }

  _uploadTexture(device, sourceCanvas) {
    const tex = device.createTexture({
      size:   [sourceCanvas.width, sourceCanvas.height],
      format: 'rgba8unorm',
      // RENDER_ATTACHMENT is required by copyExternalImageToTexture
      usage:  GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
              GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture(
      { source: sourceCanvas }, { texture: tex },
      [sourceCanvas.width, sourceCanvas.height],
    );
    return tex;
  }

  // ── Scene director ──────────────────────────────────────────────────

  _pickScene() {
    const hot = this.energyAvg > 0.3;
    const pool = [];
    for (let s = 0; s < N_SCENES; s++) {
      if (s === this.sceneA) continue;
      let w = 1;
      if (hot  && ENERGETIC.includes(s)) w = 3;
      if (!hot && CALM.includes(s))      w = 3;
      for (let i = 0; i < w; i++) pool.push(s);
    }
    return pool[(Math.random() * pool.length) | 0];
  }

  _director(bands, dt) {
    // Motion accelerates with bass; kick gives punchy speed surges per hit
    this.scroll += dt * (0.04 + bands.bass * 0.30 + bands.kick * 0.25);

    // Slow energy average (drives scene weighting + silhouette probability)
    const e = (bands.bass + bands.kick) / 2;
    this.energyAvg += (e - this.energyAvg) * Math.min(1, dt * 0.5);

    // Scene crossfade
    if (this.fading) {
      this.blend = Math.min(1, this.blend + dt / 6);
      if (this.blend >= 1) {
        this.sceneA = this.sceneB;
        this.seedA  = this.seedB;
        this.blend  = 0;
        this.fading = false;
        this.sceneDuration = 15 + Math.random() * 25;
        this.sceneTimer = 0;
      }
    } else {
      this.sceneTimer += dt;
      if (this.sceneTimer > this.sceneDuration) {
        this.sceneB = this._pickScene();
        this.seedB  = Math.random() * 100;
        this.fading = true;
      }
    }

    // Silhouette lifecycle
    switch (this.silState) {
      case 'cooldown':
        this.silTimer += dt;
        if (this.silTimer > this.cooldown) {
          this._silCheck += dt;
          if (this._silCheck > 1) {              // roll once per second
            this._silCheck = 0;
            if (Math.random() < 0.15 + this.energyAvg * 0.5) {
              this.silIndex  = (Math.random() * N_SILS) | 0;
              this.revealDur = 3 + Math.random() * 2;
              this.silState  = 'reveal';
            }
          }
        }
        break;
      case 'reveal':
        this.reveal = Math.min(1, this.reveal + dt / this.revealDur);
        if (this.reveal >= 1) {
          this.silState = 'hold';
          this.holdDur  = 6 + Math.random() * 6;
          this.silTimer = 0;
        }
        break;
      case 'hold':
        this.silTimer += dt;
        this.reveal = Math.min(1, this.reveal + dt * 0.5);
        if (bands.snare > 0.6) this.reveal = Math.max(0.85, this.reveal - 0.07);  // shimmer
        if (this.silTimer > this.holdDur) this.silState = 'dissolve';
        break;
      case 'dissolve':
        this.reveal -= dt / this.revealDur;
        if (this.reveal <= 0) {
          this.reveal   = 0;
          this.silIndex = -1;
          this.silState = 'cooldown';
          this.cooldown = 20 + Math.random() * 40;
          this.silTimer = 0;
        }
        break;
    }
  }

  tick(device, bands, timeMs, deltaMs, params) {
    const dt = Math.min(deltaMs, 50) / 1000;

    // Asymmetric envelope follower: rises fast, falls slow → "breathing"
    const s = this._s;
    const follow = (v, cur, up, down) =>
      cur + (v - cur) * (1 - Math.exp(-dt * (v > cur ? up : down)));
    s.bass    = follow(bands.bass,    s.bass,    14, 3.0);
    s.mid     = follow(bands.mid,     s.mid,     14, 3.0);
    s.high    = follow(bands.high,    s.high,    14, 3.5);
    s.subBass = follow(bands.subBass, s.subBass,  8, 2.0);
    s.kick    = follow(bands.kick,    s.kick,    30, 6.0);
    s.snare   = follow(bands.snare,   s.snare,   30, 6.0);

    // Flicker/tear seed at ~10Hz, not every frame — 120fps re-rolls read as noise
    this._flickerT += dt;
    if (this._flickerT > 0.1) {
      this._flickerT    = 0;
      this._flickerSeed = Math.random() * 1000;
    }

    this._director(s, dt);

    const w = this.canvas.width, h = this.canvas.height;
    const cellW = Math.max(7, Math.round(w / 160));
    const cellH = cellW * 2;

    // Silhouette atlas region: 4×2 grid
    const si = this.silIndex;
    const silU = si >= 0 ? (si % 4) * 0.25 : 0;
    const silV = si >= 0 ? Math.floor(si / 4) * 0.5 : 0;

    // Eased crossfade — linear mix reads as an abrupt switch at the ends
    const b = this.blend;
    const blendEased = b * b * (3 - 2 * b);

    const u = this._u;
    u[0] = w;            u[1] = h;             u[2] = cellW;            u[3] = cellH;
    u[4] = timeMs / 1000; u[5] = this._flickerSeed; u[6] = this._glyphCount; u[7] = ATLAS_COLS;
    u[8] = this.sceneA;  u[9] = this.sceneB;   u[10] = blendEased;      u[11] = this.scroll;
    u[12] = si;          u[13] = this.reveal;  u[14] = this.seedA;      u[15] = this._atlasRows;
    u[16] = silU;        u[17] = silV;         u[18] = 0.25;            u[19] = 0.5;
    u[20] = s.bass;      u[21] = s.mid;        u[22] = s.high;          u[23] = s.subBass;
    u[24] = s.kick;      u[25] = s.snare;      u[26] = 0;               u[27] = params.pulse ?? 0;
    u[28] = (params.dissonance ?? 0) * (params.dissonanceStrength ?? 1);
    u[29] = params.tonality ?? 0;
    u[30] = this.seedB;  u[31] = 0;
    device.queue.writeBuffer(this.uniformBuffer, 0, u);
  }

  draw(device, view) {
    const enc  = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp:  'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  destroy() {
    if (this._onKey) window.removeEventListener('keydown', this._onKey);
    this.uniformBuffer?.destroy();
    this.glyphTex?.destroy();
    this.silTex?.destroy();
  }
}

// ── Glyph atlas ───────────────────────────────────────────────────────
// White glyphs on opaque black (shader samples .r — sidesteps premultiplied
// alpha). Ramp is sorted by measured ink coverage so brightness is monotonic.

function buildGlyphAtlas() {
  const cols = ATLAS_COLS, rows = Math.ceil(RAMP.length / cols);
  const cv = document.createElement('canvas');
  cv.width  = cols * GLYPH_W;
  cv.height = rows * GLYPH_H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });

  const drawAll = (chars) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 24px Menlo, "SF Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < chars.length; i++) {
      const x = (i % cols) * GLYPH_W + GLYPH_W / 2;
      const y = Math.floor(i / cols) * GLYPH_H + GLYPH_H / 2;
      ctx.fillText(chars[i], x, y);
    }
  };

  drawAll(RAMP);
  const coverage = [...RAMP].map((ch, i) => {
    const x = (i % cols) * GLYPH_W, y = Math.floor(i / cols) * GLYPH_H;
    const d = ctx.getImageData(x, y, GLYPH_W, GLYPH_H).data;
    let s = 0;
    for (let j = 0; j < d.length; j += 4) s += d[j];
    return { ch, s };
  });
  coverage.sort((a, b) => a.s - b.s);
  drawAll(coverage.map(c => c.ch).join(''));
  return cv;
}

// ── Silhouette atlas ──────────────────────────────────────────────────
// 1024×1024, 4×2 grid of 256×512 portrait regions. Each shape is drawn
// twice: a blurred halo pass (soft falloff for the dissolve) then crisp.
// Legibility rule at ~160×55 cells: shapes fill 60-80% of the region, no
// feature thinner than ~13px (≈3 grid cells on screen).

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSilhouetteAtlas() {
  const cv = document.createElement('canvas');
  cv.width = 1024;
  cv.height = 1024;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cv.width, cv.height);

  // 0-5 = emerging silhouettes; 6-7 = scenery art for palm/car scenes
  const shapes = [drawSkull, drawRaven, drawWolf, drawFigure, drawHand, drawTree, drawPalm, drawCar];
  shapes.forEach((fn, i) => {
    const ox = (i % 4) * 256, oy = Math.floor(i / 4) * 512;
    for (const [blur, alpha] of [[6, 0.65], [0, 1]]) {
      ctx.save();
      ctx.translate(ox, oy);
      ctx.beginPath();
      ctx.rect(0, 0, 256, 512);
      ctx.clip();
      ctx.filter = blur ? `blur(${blur}px)` : 'none';
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#fff';
      fn(ctx);
      ctx.restore();
    }
  });
  return cv;
}

function drawSkull(ctx) {
  ctx.beginPath();
  ctx.ellipse(128, 190, 96, 104, 0, 0, Math.PI * 2);   // cranium
  ctx.fill();
  ctx.beginPath();                                      // jaw
  ctx.moveTo(56, 244); ctx.lineTo(200, 244); ctx.lineTo(174, 350);
  ctx.quadraticCurveTo(128, 372, 82, 350);
  ctx.closePath(); ctx.fill();
  // punch out eyes / nose / tooth gaps
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath(); ctx.ellipse(88, 196, 28, 34, -0.15, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(168, 196, 28, 34, 0.15, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.moveTo(128, 240); ctx.lineTo(108, 292); ctx.lineTo(148, 292);
  ctx.closePath(); ctx.fill();
  for (const x of [104, 128, 152]) ctx.fillRect(x - 5, 318, 10, 40);
  ctx.globalCompositeOperation = 'source-over';
}

function drawRaven(ctx) {
  ctx.beginPath(); ctx.ellipse(140, 280, 64, 96, 0.35, 0, Math.PI * 2); ctx.fill(); // body
  ctx.beginPath(); ctx.arc(92, 168, 42, 0, Math.PI * 2); ctx.fill();                // head
  ctx.beginPath();                                                                  // neck
  ctx.moveTo(70, 180); ctx.lineTo(130, 160); ctx.lineTo(170, 250); ctx.lineTo(90, 260);
  ctx.closePath(); ctx.fill();
  ctx.beginPath();                                                                  // beak
  ctx.moveTo(60, 150); ctx.lineTo(8, 176); ctx.lineTo(62, 192);
  ctx.closePath(); ctx.fill();
  ctx.beginPath();                                                                  // raised wing
  ctx.moveTo(120, 230);
  ctx.quadraticCurveTo(230, 150, 244, 210);
  ctx.quadraticCurveTo(220, 300, 150, 330);
  ctx.closePath(); ctx.fill();
  ctx.beginPath();                                                                  // tail
  ctx.moveTo(150, 340); ctx.lineTo(230, 470); ctx.lineTo(170, 470); ctx.lineTo(120, 360);
  ctx.closePath(); ctx.fill();
  ctx.lineWidth = 14; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(120, 360); ctx.lineTo(104, 430); ctx.stroke();        // legs
  ctx.beginPath(); ctx.moveTo(150, 366); ctx.lineTo(146, 436); ctx.stroke();
}

function drawWolf(ctx) {
  // howling wolf — muzzle raised up-right, ear spike, chest column
  ctx.beginPath();
  ctx.moveTo(214, 96);                                  // muzzle tip
  ctx.lineTo(146, 152);                                 // forehead
  ctx.lineTo(132, 70);                                  // ear tip
  ctx.lineTo(96, 152);                                  // ear base / back of head
  ctx.lineTo(64, 230);                                  // nape
  ctx.lineTo(52, 350);                                  // back
  ctx.lineTo(46, 470);
  ctx.lineTo(196, 470);                                 // bottom front
  ctx.lineTo(178, 340);                                 // chest
  ctx.lineTo(152, 250);                                 // throat
  ctx.lineTo(196, 142);                                 // jaw under muzzle
  ctx.closePath(); ctx.fill();
}

function drawFigure(ctx) {
  ctx.beginPath(); ctx.arc(128, 86, 36, 0, Math.PI * 2); ctx.fill();   // head
  ctx.beginPath();                                                     // torso
  ctx.moveTo(70, 140); ctx.lineTo(186, 140); ctx.lineTo(166, 300); ctx.lineTo(90, 300);
  ctx.closePath(); ctx.fill();
  ctx.lineCap = 'round';
  ctx.lineWidth = 24;                                                  // arms, angled away from torso
  ctx.beginPath(); ctx.moveTo(78, 150);  ctx.lineTo(36, 296);  ctx.stroke();
  ctx.beginPath(); ctx.moveTo(178, 150); ctx.lineTo(220, 296); ctx.stroke();
  ctx.lineWidth = 28;                                                  // legs, spread
  ctx.beginPath(); ctx.moveTo(106, 300); ctx.lineTo(86, 470);  ctx.stroke();
  ctx.beginPath(); ctx.moveTo(150, 300); ctx.lineTo(170, 470); ctx.stroke();
}

function drawHand(ctx) {
  // open palm, fingers splayed — gaps between fingers must stay ≥16px
  // (≈3 grid cells) or they melt together at ASCII resolution
  ctx.lineCap = 'round';
  ctx.beginPath();                                                     // palm
  ctx.moveTo(74, 300);
  ctx.quadraticCurveTo(64, 420, 130, 440);
  ctx.quadraticCurveTo(196, 432, 202, 360);
  ctx.lineTo(200, 300);
  ctx.closePath(); ctx.fill();
  ctx.lineWidth = 20;                                                  // fingers
  const fingers = [[86, 305, 62, 158], [122, 298, 114, 124], [158, 298, 166, 142], [192, 308, 212, 212]];
  for (const [x1, y1, x2, y2] of fingers) {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  ctx.lineWidth = 24;                                                  // thumb
  ctx.beginPath(); ctx.moveTo(80, 345); ctx.lineTo(22, 268); ctx.stroke();
}

function drawPalm(ctx) {
  ctx.lineCap = 'round';
  // curved trunk
  ctx.lineWidth = 18;
  ctx.beginPath(); ctx.moveTo(58, 502); ctx.quadraticCurveTo(78, 370, 122, 250); ctx.stroke();
  ctx.lineWidth = 14;
  ctx.beginPath(); ctx.moveTo(104, 300); ctx.quadraticCurveTo(118, 258, 132, 218); ctx.stroke();
  // fronds radiating from the crown, drooping
  const cx = 132, cy = 212;
  ctx.lineWidth = 14;
  const fronds = [
    [-95, -30, -150,  30], [-80, -60, -140, -40], [-40, -85, -85, -115],
    [ 10, -90,  40, -125], [ 65, -60, 120,  -55], [ 85, -25, 150,  15],
    [ 70,  10, 130,  75],
  ];
  for (const [mx, my, ex, ey] of fronds) {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.quadraticCurveTo(cx + mx, cy + my, cx + ex, cy + ey);
    ctx.stroke();
  }
  // coconuts
  ctx.beginPath(); ctx.arc(120, 224, 11, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(146, 228, 11, 0, Math.PI * 2); ctx.fill();
}

function drawCar(ctx) {
  // sports car in profile, facing left, drawn in the middle band of the region
  ctx.beginPath();
  ctx.moveTo(16, 305);
  ctx.lineTo(22, 282);                                  // front bumper
  ctx.quadraticCurveTo(60, 268, 92, 262);               // hood
  ctx.lineTo(112, 232);                                 // windshield
  ctx.lineTo(178, 232);                                 // roof
  ctx.quadraticCurveTo(206, 252, 226, 272);             // rear deck
  ctx.lineTo(240, 280);
  ctx.lineTo(238, 305);
  ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.arc(70, 308, 26, 0, Math.PI * 2);  ctx.fill();   // wheels
  ctx.beginPath(); ctx.arc(190, 308, 26, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = 'destination-out';                     // windows
  ctx.beginPath();
  ctx.moveTo(120, 240); ctx.lineTo(170, 240); ctx.lineTo(184, 262); ctx.lineTo(112, 262);
  ctx.closePath(); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
}

function drawTree(ctx) {
  ctx.lineCap = 'round';
  const rand = mulberry32(1234);   // deterministic so halo + crisp passes match
  const branch = (x, y, ang, len, w, depth) => {
    const x2 = x + Math.cos(ang) * len;
    const y2 = y - Math.sin(ang) * len;
    ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
    if (depth === 0 || w < 7) return;
    const spread = 0.45 + rand() * 0.25;
    branch(x2, y2, ang + spread, len * 0.72, w * 0.62, depth - 1);
    branch(x2, y2, ang - spread, len * 0.72, w * 0.62, depth - 1);
    if (rand() < 0.4) branch(x2, y2, ang + (rand() - 0.5) * 0.3, len * 0.6, w * 0.55, depth - 1);
  };
  branch(128, 500, Math.PI / 2, 130, 26, 4);
}
