// Writes the demo track (src/demo-track.js) to a WAV for automated checks.
// Usage: node tools/gen-test-track.mjs out.wav
import { writeFileSync } from 'node:fs';
import { renderDemoTrack, toWav } from '../src/demo-track.js';

const out = process.argv[2] ?? 'test-track.wav';
writeFileSync(out, toWav(renderDemoTrack(44100), 44100));
console.log('wrote', out);
