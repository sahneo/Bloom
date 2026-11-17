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
- ✅ UI v3: welcome card (1 Sound · 2 MIDI optional · 3 World, each button says what/why), Demo beat source
  (src/demo-track.js renders the test track in-browser), HUD: ‹ WORLD › + palette (M), STAGE look chips + CAM,
  live pills (audio/MIDI/BPM), AUTO-VJ, LOOK/OUTPUT/SETUP menus with captions, fullscreen, ? shortcuts sheet.
  Idle auto-hide after 2.6 s (cursor too), H = hard hide (double-tap on touch), toast on world/look change.
  All old element ids kept → main.js handlers, share links and preset bank unchanged.
- ✅ Mobile (iPhone 15, Playwright WebKit, taps): no horizontal overflow, ☰ bottom sheet, 2-col palette; STAGE renders.
- ✅ No-WebGPU fallback verified (navigator.gpu removed in WebKit) → boots into STAGE on WebGL2, 0 errors.
- tools/ui-shots.mjs — desktop + iPhone UI walkthrough with screenshots.
- ✅ Governor v2: share of slow (>20 ms) frames per 2 s window — lone hitches ignored. Verified: with 25 ms/frame
  CPU load STAGE drops q3→q0 in ~6 s and main.js lowers canvas dpr; normal run stays q3 at 60 fps.
- ✅ Regression: all 28 modes cycled with demo audio — 0 console errors, 0 render errors. Vite build OK
  (STAGE is its own lazy chunk: 856 kB / 234 kB gzip).
- ✅ tools/record-looks.mjs → 12 s webm per look (breakdown → build → drop) in ../shots-3d/video/.

## Next ideas
- ASCII: per-look glyph sets (katakana / box-drawing), mono phosphor variant, MIDI notes typing words on screens.
- Screens showing the live 2D worlds as textures (render a 2D preset into a texture → hanging screens).
- More halls (rooftop, flooded tunnel), selected by genre; laser fans on drops; crowd density from energy.
- Tune analyser drop rules on real techno sets (synthetic track only needed the pads moved out of the bass band).
- ✅ PR #2 https://github.com/sahneo/Bloom/pull/2 · preview https://bloom-git-feature-3d-stage-sakhph-5193s-projects.vercel.app (behind Vercel login)
