// ---------------------------------------------------------------------------
// WledSync — mirrors the rendered canvas onto a WLED LED strip in real time.
//
// Each LED gets the average colour of one vertical screen slice (left edge of
// the screen = first LED), so the strip is a 1-D projection of whatever
// preset is playing. Browsers can't send UDP, so frames go over HTTP to a
// tiny local relay (tools/wled-relay.mjs) that forwards them to WLED as DDP.
// ---------------------------------------------------------------------------

const FRAME_MS = 33;        // ~30 fps — plenty for LEDs, easy on WiFi
const SAMPLE_ROWS = 16;     // vertical resolution folded into each LED

export class WledSync {
  constructor(canvas, relayUrl = 'http://localhost:8127') {
    this.canvas = canvas;
    this.relay  = relayUrl;
    this.active = false;
    this.leds   = 0;
    this._lastMs   = 0;
    this._inflight = false;
    this._fails    = 0;
    this._q        = '';
    // Optional frame source: (leds, nowMs) → Uint8Array leds*3, already
    // LED-ready. When set, the canvas mirror path is skipped entirely.
    this.source    = null;
  }

  // host: WLED IP/hostname, forwarded to the relay per request; empty string
  // falls back to the relay's CLI default
  async start(host = '') {
    this._q = host ? `?host=${encodeURIComponent(host)}` : '';
    const r    = await fetch(`${this.relay}/info${this._q}`, { signal: AbortSignal.timeout(4000) });
    const info = await r.json();
    if (info.error) throw new Error(info.error);
    this.leds = info.leds;

    this._sample = document.createElement('canvas');
    this._sample.width  = this.leds;
    this._sample.height = SAMPLE_ROWS;
    this._ctx = this._sample.getContext('2d', { willReadFrequently: true });

    this.active = true;
    this._fails = 0;
    return info;
  }

  stop() { this.active = false; }

  update(nowMs) {
    if (!this.active || this._inflight || nowMs - this._lastMs < FRAME_MS) return;
    this._lastMs = nowMs;

    if (this.source) {
      this._send(this.source(this.leds, nowMs));
      return;
    }

    this._ctx.drawImage(this.canvas, 0, 0, this.leds, SAMPLE_ROWS);
    const px  = this._ctx.getImageData(0, 0, this.leds, SAMPLE_ROWS).data;
    const out = new Uint8Array(this.leds * 3);

    for (let i = 0; i < this.leds; i++) {
      let r = 0, g = 0, b = 0;
      for (let y = 0; y < SAMPLE_ROWS; y++) {
        const o = (y * this.leds + i) * 4;
        r += px[o]; g += px[o + 1]; b += px[o + 2];
      }
      r /= SAMPLE_ROWS; g /= SAMPLE_ROWS; b /= SAMPLE_ROWS;

      // LEDs wash out screen colours: push saturation and lift with a soft
      // gamma so mids read, while true black stays off
      const gray = (r + g + b) / 3;
      r = gray + (r - gray) * 1.6;
      g = gray + (g - gray) * 1.6;
      b = gray + (b - gray) * 1.6;
      out[i * 3]     = Math.pow(Math.min(Math.max(r, 0), 255) / 255, 0.80) * 255;
      out[i * 3 + 1] = Math.pow(Math.min(Math.max(g, 0), 255) / 255, 0.80) * 255;
      out[i * 3 + 2] = Math.pow(Math.min(Math.max(b, 0), 255) / 255, 0.80) * 255;
    }

    this._send(out);
  }

  _send(out) {
    this._inflight = true;
    fetch(`${this.relay}/frame${this._q}`, { method: 'POST', body: out })
      .then(() => { this._fails = 0; })
      .catch(() => { if (++this._fails > 30) this.stop(); })   // relay gone → give up quietly
      .finally(() => { this._inflight = false; });
  }
}
