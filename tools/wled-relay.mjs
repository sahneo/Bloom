#!/usr/bin/env node
// ---------------------------------------------------------------------------
// WLED relay — bridges Bloom (browser) to a WLED strip over the LAN.
//
// Browsers can't send UDP, so Bloom POSTs raw RGB frames to this tiny local
// server, which forwards them to WLED as DDP packets (port 4048). WLED treats
// DDP as a realtime override: when the stream stops, it falls back to its
// normal state (and Home Assistant control) after its realtime timeout.
//
// Usage:  node tools/wled-relay.mjs                 (address set in Bloom UI)
//         node tools/wled-relay.mjs 192.168.1.42    (fallback default address)
//
// The WLED address normally comes from the browser per request (?host=...),
// typed into Bloom's WLED field; a CLI argument acts as the default.
//
// Zero dependencies. Endpoints:
//   GET  /info   → { leds, name, host }   (LED count queried from WLED itself)
//   POST /frame  → body = leds*3 raw RGB bytes, forwarded immediately
// ---------------------------------------------------------------------------

import http  from 'node:http';
import dgram from 'node:dgram';

const DEFAULT_HOST = process.argv[2] ?? 'wled.local';
const DDP_PORT  = 4048;
const HTTP_PORT = 8127;
const CHUNK     = 1440;             // max DDP payload (480 LEDs) per packet

// Per-request target from the browser (?host=ip[:port]); CLI arg is the default
function targetOf(url) {
  const h = url.searchParams.get('host') || DEFAULT_HOST;
  if (!/^[a-zA-Z0-9.:\-]+$/.test(h)) return null;
  return h;
}

const udp = dgram.createSocket('udp4');
udp.on('error', e => console.error('UDP error:', e.message));
let seq = 1;
let sendErrLogged = false;

function sendDDP(rgb, host) {
  const udpHost = host.split(':')[0];   // UDP always goes to the bare host
  for (let off = 0; off < rgb.length; off += CHUNK) {
    const data = rgb.subarray(off, Math.min(off + CHUNK, rgb.length));
    const push = off + CHUNK >= rgb.length;
    const hdr  = Buffer.alloc(10);
    hdr[0] = 0x40 | (push ? 0x01 : 0);  // ver 1, push on last chunk
    hdr[1] = seq;
    hdr[2] = 0x01;                      // data type: RGB 8-bit
    hdr[3] = 0x01;                      // output ID
    hdr.writeUInt32BE(off, 4);
    hdr.writeUInt16BE(data.length, 8);
    udp.send(Buffer.concat([hdr, data]), DDP_PORT, udpHost, err => {
      // A dead host/DNS must not crash the relay — log once, keep serving
      if (err && !sendErrLogged) { sendErrLogged = true; console.error('UDP send failed:', err.message); }
      if (!err) sendErrLogged = false;
    });
  }
  seq = (seq % 15) + 1;
}

// CORS + Chrome's Private Network Access preflight (needed when the Bloom
// page is served over https and talks to this localhost relay)
const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Private-Network': 'true',
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, HEADERS); return res.end(); }

  const url  = new URL(req.url, 'http://localhost');
  const host = targetOf(url);
  if (!host) { res.writeHead(400, HEADERS); return res.end('bad host'); }

  if (req.method === 'GET' && url.pathname === '/info') {
    try {
      const r    = await fetch(`http://${host}/json/info`, { signal: AbortSignal.timeout(3000) });
      const info = await r.json();
      res.writeHead(200, { ...HEADERS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ leds: info.leds.count, name: info.name, host }));
    } catch (e) {
      res.writeHead(502, { ...HEADERS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: `WLED unreachable at ${host}: ${e.message}` }));
    }
  }

  if (req.method === 'POST' && url.pathname === '/frame') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      sendDDP(Buffer.concat(chunks), host);
      res.writeHead(200, HEADERS);
      res.end();
    });
    return;
  }

  res.writeHead(404, HEADERS);
  res.end();
});

server.listen(HTTP_PORT, () => {
  console.log(`WLED relay on http://localhost:${HTTP_PORT} — default target ${DEFAULT_HOST}:${DDP_PORT} (DDP)`);
  console.log('Open Bloom, enter your WLED address, and hit the WLED button.');
});
