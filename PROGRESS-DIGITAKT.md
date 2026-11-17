# Digitakt mode — progress

Branch `feature/digitakt-mode` (worktree `~/Documents/Bloom/Code-digitakt`). Does not touch `feature/3d-stage`.

## Done (17.11.2026)
- `src/digitakt/` — standalone module, Canvas2D (runs without WebGPU, so phones work too):
  - `state.js` — raw MIDI → state. Notes 0–7 → tracks 1–8; channel n → track n (9–16 = MIDI A–H); AUTO ch (10, `?dtauto=N`) → active track; CC94 mute, CC95 level, other CCs → knob A–H (Appendix B table); clock 24 ppqn → BPM + step; start/stop/continue; program change → A01…H16.
  - `demo.js` — demo stream in the same byte format: 122 BPM with swing, kick/snare/clap/hats/toms/cowbell, MIDI A bass on ch 9, knob gestures, hat/kick mutes, pattern changes.
  - looks: `PANEL` (line-art isometric Digitakt from `layout.js`, geometry from the manual §3.1 diagram), `PILLARS`, `ROLL`, `BURST`.
  - `index.js` — overlay, its own Web MIDI listener (`addEventListener`, so the main `onmidimessage` keeps working), HUD, MIDI monitor.
- Hook into the app: `main.js` +3 lines (import, `installDigitakt()`, renderer pause while the overlay is open), `index.html` +1 button `DT`.
- Checks: `~/Documents/Bloom/shots-digitakt/check.mjs` (Playwright 1.63 in `/tmp/pwdt`, fake Web MIDI port "Elektron Digitakt"). Result: 60 fps on all 4 looks (desktop Chromium + iPhone 15 WebKit), 0 console errors, `vite build` OK. Screenshots + videos are in `shots-digitakt/`.

## Not verified
- The Digitakt was not connected over USB during this session. The mapping comes from the manual and the 17.09.2026 notes in `~/code/knobs/devices/digitakt/README.md`. Still to check on the device: are audio-track sequencer trigs sent as notes on channels 1–8? (Not every OS sends them — see below.)

## Next
- Connect the Digitakt, `?digitakt&dtmon` (or the `I` key) → check channels and notes in the monitor.
- If audio-track trigs don't come over MIDI: duplicate the pattern on MIDI tracks A–H (CHAN 11–16), or play live with TRIG KEY DEST = INT+EXT.
- After `feature/3d-stage` merges: move the `DT` button into the new UI (one line).
