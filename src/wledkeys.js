// ---------------------------------------------------------------------------
// WledKeys — plays the LED strip like an instrument, straight from MIDI.
//
// Alternative frame source for WledSync (mode "KEYS"): instead of mirroring
// the canvas, every key on the controller lights its own spot on the strip.
//
//   pitch    → position along the strip (C2..C7 spans the whole length)
//   pitch    → hue via the circle of fifths, so related keys share colours
//   velocity → brightness + a short white pop on the attack
//   low keys → wide warm washes, high keys → narrow sparks
//   pads     → (channel 10) full-strip flash in the pad's colour
//   mod wheel→ afterglow length (down = tight, up = long fading trails)
//   sustain  → holds lights exactly like it holds notes
// ---------------------------------------------------------------------------

const PITCH_LO = 36;   // C2 — left end of the strip
const PITCH_HI = 96;   // C7 — right end (Launchkey octave shift reaches both)
const RELEASE_S = 0.28;
const FLASH_S   = 0.09;   // white attack pop
const PAD_S     = 0.16;   // full-strip pad flash decay

// Circle of fifths → hue: neighbouring keys get neighbouring colours,
// tritones sit opposite on the wheel
function pitchHue(pitch) {
  return (((pitch % 12) * 7) % 12) / 12;
}

function hsv2rgb(h, s, v, out, o) {
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q;
  }
  out[o] += r; out[o + 1] += g; out[o + 2] += b;
}

export class WledKeys {
  constructor() {
    this._notes   = new Map();  // pitch → {vel, pos, sigma, hue, onS, offS, sustained}
    this._pads    = [];         // {hue, vel, onS}
    this._sustain = false;
    this._mod     = 0.25;       // mod wheel 0..1 → trail length
    this._trail   = null;       // Float32Array leds*3 — afterglow
    this._frame   = null;       // Float32Array leds*3 — this frame, linear
    this._out     = null;       // Uint8Array  leds*3
    this._lastS   = 0;
    this._ambHue  = -1;         // hue of the last note — faint idle breathing
    this._ambPh   = 0;
  }

  noteOn(pitch, velocity, channel = 0) {
    const vel = velocity / 127;
    const now = performance.now() / 1000;
    if (channel === 9) {                       // drum pads: whole-strip flash
      this._pads.push({ hue: pitchHue(pitch), vel, onS: now });
      if (this._pads.length > 12) this._pads.shift();
      return;
    }
    const t = (pitch - PITCH_LO) / (PITCH_HI - PITCH_LO);
    this._notes.set(pitch, {
      vel,
      pos:   Math.min(Math.max(t, 0), 1),
      sigma: 0.085 - 0.065 * Math.min(Math.max(t, 0), 1),  // bass wide, treble narrow
      hue:   pitchHue(pitch),
      onS:   now,
      offS:  0,
      sustained: false,
    });
    this._ambHue = pitchHue(pitch);
  }

  noteOff(pitch, channel = 0) {
    if (channel === 9) return;
    const n = this._notes.get(pitch);
    if (!n || n.offS) return;
    if (this._sustain) { n.sustained = true; return; }
    n.offS = performance.now() / 1000;
  }

  cc(cc, value) {
    if (cc === 1) this._mod = value / 127;
    if (cc === 64) {
      const on = value >= 64;
      if (this._sustain && !on) {
        const now = performance.now() / 1000;
        for (const n of this._notes.values()) {
          if (n.sustained && !n.offS) n.offS = now;
        }
      }
      this._sustain = on;
    }
  }

  // Frame source for WledSync: returns leds*3 RGB bytes for "now"
  render(nowMs, leds) {
    const now = nowMs / 1000;
    // real elapsed time — trail decay must not slow down when frames are
    // sparse (exp handles any dt); only the breathing phase gets clamped
    const dt  = Math.max(now - this._lastS, 0);
    this._lastS = now;

    if (!this._frame || this._frame.length !== leds * 3) {
      this._frame = new Float32Array(leds * 3);
      this._trail = new Float32Array(leds * 3);
      this._out   = new Uint8Array(leds * 3);
    }
    const frame = this._frame, trail = this._trail;
    frame.fill(0);

    // Afterglow fades over 0.3–3 s depending on the mod wheel
    const tau = 0.3 + this._mod * 2.7;
    const dec = Math.exp(-dt / tau);
    for (let i = 0; i < trail.length; i++) trail[i] *= dec;

    // rAF timestamps share the performance.now() timeline the note clocks use
    const perf = now;

    for (const [pitch, n] of this._notes) {
      let amp;
      if (n.offS) {
        amp = n.vel * 0.8 * Math.exp(-(perf - n.offS) / RELEASE_S);
        if (amp < 0.01) { this._notes.delete(pitch); continue; }
      } else {
        // held: sustain level with a slow subtle shimmer so it feels alive
        amp = n.vel * (0.8 + 0.08 * Math.sin((perf - n.onS) * 5 + pitch));
      }
      const flash  = Math.exp(-(perf - n.onS) / FLASH_S) * n.vel; // white pop
      const sat    = Math.max(0.35, 0.95 - flash * 0.8);
      const center = n.pos * (leds - 1);
      const sigmaL = Math.max(n.sigma * leds, 1.2);
      const span   = Math.ceil(sigmaL * 3);
      const lo = Math.max(0, Math.floor(center - span));
      const hi = Math.min(leds - 1, Math.ceil(center + span));
      for (let i = lo; i <= hi; i++) {
        const g = Math.exp(-((i - center) ** 2) / (2 * sigmaL * sigmaL));
        const v = Math.min(amp * g * (1 + flash * 0.6), 1);
        if (v > 0.004) hsv2rgb(n.hue, sat, v, frame, i * 3);
      }
    }

    // Deposit into the afterglow (max, not add — trails don't self-amplify)
    for (let i = 0; i < frame.length; i++) {
      if (frame[i] * 0.75 > trail[i]) trail[i] = frame[i] * 0.75;
    }

    // Pad flashes wash the whole strip — after the trail deposit, so a pad
    // hit is a clean strobe and doesn't smear afterglow over every key spot
    for (let p = this._pads.length - 1; p >= 0; p--) {
      const pad = this._pads[p];
      const amp = pad.vel * Math.exp(-(perf - pad.onS) / PAD_S);
      if (amp < 0.01) { this._pads.splice(p, 1); continue; }
      for (let i = 0; i < leds; i++) hsv2rgb(pad.hue, 0.7, amp * 0.85, frame, i * 3);
    }

    // Faint ambient breathing in the last-played colour, so between phrases
    // the desk keeps a pulse instead of going pitch black
    let ar = 0, ag = 0, ab = 0;
    if (this._ambHue >= 0) {
      this._ambPh += dt * 0.8;
      const breathe = 0.03 + 0.02 * Math.sin(this._ambPh);
      const tmp = [0, 0, 0];
      hsv2rgb(this._ambHue, 0.85, breathe, tmp, 0);
      ar = tmp[0]; ag = tmp[1]; ab = tmp[2];
    }

    const out = this._out;
    for (let i = 0; i < leds; i++) {
      for (let c = 0; c < 3; c++) {
        const amb = c === 0 ? ar : c === 1 ? ag : ab;
        const v = Math.min(Math.max(frame[i * 3 + c], trail[i * 3 + c], amb), 1);
        // same soft gamma lift as the screen mirror — mids must read on LEDs
        out[i * 3 + c] = Math.pow(v, 0.8) * 255;
      }
    }
    return out;
  }
}
