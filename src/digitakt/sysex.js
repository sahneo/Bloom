// ---------------------------------------------------------------------------
// Digitakt (Mk1, OS 1.5x) pattern read over SysEx.
//
// Why: the Digitakt never sends its audio-track sequencer as MIDI notes —
// over USB we only get clock + start/stop. To light the trig keys the way
// the box does, we ask it for the pattern (the same undocumented dump
// request Elektron Transfer uses) and play the trigs back from MIDI clock.
//
// Port of ~/code/knobs/site/lib/sysex.ts (offsets checked there on real
// Mk1 dumps). Read-only: only 0x6n *request* opcodes are ever built.
// ---------------------------------------------------------------------------

export const REQ_PATTERN = 0x61;          // pattern only (no kit)
const RES_PATTERN = 0x51, RES_PATTERN_KIT = 0x50;
const FAMILY = 0x0a;                      // Digitakt Mk1
const SIZE_PATTERN = 25088, SIZE_PATTERN_KIT = 27648;
const STEPS = 64, TRACKS = 16, TRACK_SIZE = 911, TRACKS_AT = 4;
const T_VELOCITY = 192, T_DEF_VEL = 897, T_TRACK_LEN = 904;
const P_TEMPO = 24996, P_LENGTH = 25000;

/** `F0 00 20 3C 0A 00 61 01 01 <slot> 00 00 00 05 F7` */
export function buildPatternRequest(slot) {
  return Uint8Array.from([0xf0, 0x00, 0x20, 0x3c, FAMILY, 0x00, REQ_PATTERN, 0x01, 0x01, slot & 0x7f, 0x00, 0x00, 0x00, 0x05, 0xf7]);
}

export function decode7(wire) {
  const out = new Uint8Array(wire.length - Math.ceil(wire.length / 8));
  let o = 0;
  for (let g = 0; g < wire.length; g += 8) {
    const head = wire[g], end = Math.min(g + 8, wire.length);
    for (let i = g + 1; i < end; i++) out[o++] = wire[i] | ((head << (i - g)) & 0x80);
  }
  return out;
}

export function encode7(data) {
  const out = new Uint8Array(data.length + Math.ceil(data.length / 7));
  let o = 0;
  for (let g = 0; g < data.length; g += 7) {
    const end = Math.min(g + 7, data.length);
    let head = 0;
    for (let i = g; i < end; i++) head |= (data[i] & 0x80) >> (i - g + 1);
    out[o++] = head;
    for (let i = g; i < end; i++) out[o++] = data[i] & 0x7f;
  }
  return out;
}

const sum14 = (a) => { let s = 0; for (const b of a) s += b; return s & 0x3fff; };

/** Builds a full dump *response* — only used by tests/mocks to fake a device. */
export function buildPatternResponse(slot, payload) {
  const enc = encode7(payload);
  const ck = sum14(enc), n = (enc.length + 5) & 0x3fff;
  return Uint8Array.from([0xf0, 0x00, 0x20, 0x3c, FAMILY, 0x00, RES_PATTERN, 0x01, 0x01, slot & 0x7f, ...enc, (ck >> 7) & 0x7f, ck & 0x7f, (n >> 7) & 0x7f, n & 0x7f, 0xf7]);
}

/**
 * One complete F0…F7 message → pattern snapshot, or null if it isn't a
 * valid Digitakt pattern dump. Never throws on foreign data.
 */
export function parsePatternDump(bytes) {
  if (bytes.length < 20 || bytes[0] !== 0xf0 || bytes[1] !== 0x00 || bytes[2] !== 0x20 || bytes[3] !== 0x3c) return null;
  if (bytes[4] !== FAMILY || bytes[5] !== 0x00) return null;
  if (bytes[6] !== RES_PATTERN && bytes[6] !== RES_PATTERN_KIT) return null;
  const enc = bytes.subarray(10, bytes.length - 5);
  const ck = (bytes[bytes.length - 5] << 7) | bytes[bytes.length - 4];
  if (sum14(enc) !== ck) return { error: 'checksum' };
  const p = decode7(enc);
  if (p.length !== SIZE_PATTERN && p.length !== SIZE_PATTERN_KIT) return { error: `size ${p.length}` };
  const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const ver = v.getUint32(0);
  if (ver !== 9 && ver !== 10) return { error: `struct v${ver}` };   // 9 = OS 1.52, 10 = OS 1.53 (same layout)
  const tracks = [];
  for (let t = 0; t < TRACKS; t++) {
    const base = TRACKS_AT + t * TRACK_SIZE;
    const trigs = new Uint8Array(STEPS), vel = new Float32Array(STEPS);
    const defVel = p[base + T_DEF_VEL];
    let count = 0;
    for (let s = 0; s < STEPS; s++) {
      trigs[s] = v.getUint16(base + s * 2) & 1;
      count += trigs[s];
      const raw = p[base + T_VELOCITY + s];
      vel[s] = (raw === 0xff ? defVel : raw) / 127;
    }
    const len = v.getUint16(base + T_TRACK_LEN);
    tracks.push({ trigs, vel, len: len >= 1 && len <= 64 ? len : 16, count });
  }
  const master = v.getUint16(P_LENGTH);
  return { slot: bytes[9], tracks, length: master >= 1 && master <= 64 ? master : 16, bpm: v.getUint32(P_TEMPO) / 120 };
}

/** Synthetic pattern payload for tests: trigs = [[track, step, vel?], …]. */
export function makePatternPayload(trigs, { length = 16, bpm = 120 } = {}) {
  const p = new Uint8Array(SIZE_PATTERN);
  const v = new DataView(p.buffer);
  v.setUint32(0, 9);
  for (let t = 0; t < TRACKS; t++) {
    const base = TRACKS_AT + t * TRACK_SIZE;
    p.fill(0xff, base + T_VELOCITY, base + T_VELOCITY + STEPS);
    p[base + T_DEF_VEL] = 100;
    v.setUint16(base + T_TRACK_LEN, length);
  }
  for (const [t, s, vel] of trigs) {
    const base = TRACKS_AT + t * TRACK_SIZE;
    v.setUint16(base + s * 2, 0x0281);
    if (vel != null) p[base + T_VELOCITY + s] = vel;
  }
  v.setUint32(P_TEMPO, Math.round(bpm * 120));
  v.setUint16(P_LENGTH, length);
  return p;
}
