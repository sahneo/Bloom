# PROGRESS — 3D STAGE + UI (branch feature/3d-stage)

Worktree: ~/Documents/Bloom/Code-3d · shots: ~/Documents/Bloom/shots-3d/

## Decisions
- **Three.js r187 `three/webgpu` + TSL**, lazy-loaded (dynamic import) only when STAGE is picked → 2D start-up untouched.
  - Shares Bloom's existing GPUDevice + canvas context (`new WebGPURenderer({ canvas, device, context })`),
    so PROJ / REC / WLED SCRN (all read the canvas) keep working with no extra plumbing.
  - Same TSL code compiles to WGSL *and* GLSL → when WebGPU is missing (iOS WebKit without WebGPU,
    old Safari) the app no longer dies: it boots straight into STAGE on the WebGL2 backend.
  - Raw WGSL raymarching was the alternative (fits the 25 existing presets) but no fallback,
    and instanced crowd/screens/beams are cheaper as real geometry than SDF repetition.
- STAGE plugs into the preset interface (init/tick/draw/destroy) — main loop, analysis, AutoVJ untouched.

## Log
- ✅ STAGE scene "HALLE": nave with pillars, truss, booth + pixel wall, HALO ring of bars, 9 hanging screens
  on cables, 14 beam cones, ~600 instanced dancers (TSL vertex bounce on beatT, jump on drops), kick floor rings.
- ✅ Director: build → RUSH push-in (lens narrows with tension), drop → hard cut + FOV punch + shake,
  breakdown → FLOAT, steady → glide every 2 phrases; blends arc over the crowd.
- ✅ Looks: ASCII (luminance glyph ramp sorted by measured ink + depth-edge line glyphs | / - \), 1-BIT Bayer, THERMAL, RAW+bloom.
- ✅ Quality governor (wall-clock frame EMA, 4 tiers: scene-pass scale + crowd density, hysteresis).
- ✅ tools/gen-test-track.mjs (126 BPM intro/groove/breakdown/build/drop) + tools/shoot.mjs (Playwright, Chrome WebGPU).
  Headless Chrome on Apple Silicon: 60 fps all looks at 2160×1350 canvas, 0 console errors. Drop detected at ~61 s.
