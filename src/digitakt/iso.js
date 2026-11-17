// ---------------------------------------------------------------------------
// Orthographic "isometric" camera for Canvas2D line art.
//
// World: x → right, y → toward the viewer (panel units), z → up.
// Because the projection is orthographic, every horizontal plane z = const
// maps to the screen by an affine transform — so text, arcs and rounded
// rects can be drawn in panel coordinates with plain Canvas2D calls after
// `plane(ctx, z)`. Strokes are made after `screen(ctx)` so line widths stay
// in device pixels instead of being skewed by the plane transform.
// ---------------------------------------------------------------------------

export class Iso {
  constructor() {
    this.S = 1; this.ox = 0; this.oy = 0;
    this.ca = 1; this.sa = 0; this.se = 1; this.ce = 0;
    this.cx = 0; this.cy = 0;
  }

  /**
   * yaw/elev in radians; box = {x0,y0,x1,y1,z0,z1} world bounds to fit;
   * fill = fraction of the viewport the box may take.
   */
  setView(w, h, yaw, elev, box, fill = 0.82, offsetY = 0) {
    this.ca = Math.cos(yaw); this.sa = Math.sin(yaw);
    this.se = Math.sin(elev); this.ce = Math.cos(elev);
    this.cx = (box.x0 + box.x1) / 2; this.cy = (box.y0 + box.y1) / 2;
    this.S = 1; this.ox = 0; this.oy = 0;
    let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
    for (const x of [box.x0, box.x1]) for (const y of [box.y0, box.y1]) for (const z of [box.z0, box.z1]) {
      const [sx, sy] = this.P(x, y, z);
      mnx = Math.min(mnx, sx); mxx = Math.max(mxx, sx); mny = Math.min(mny, sy); mxy = Math.max(mxy, sy);
    }
    this.S = Math.min((w * fill) / (mxx - mnx), (h * fill) / (mxy - mny));
    this.ox = w / 2 - this.S * (mnx + mxx) / 2;
    this.oy = h / 2 - this.S * (mny + mxy) / 2 + offsetY * h;
  }

  /** world → screen */
  P(x, y, z) {
    const X = x - this.cx, Y = y - this.cy;
    return [
      this.ox + this.S * (this.ca * X - this.sa * Y),
      this.oy + this.S * (this.se * (this.sa * X + this.ca * Y) - this.ce * z),
    ];
  }

  /** depth along the view (bigger = nearer) — for painter's sorting */
  depth(x, y) { return this.sa * (x - this.cx) + this.ca * (y - this.cy); }

  /** Is a vertical face with outward floor-normal (nx, ny) facing the camera? */
  faces(nx, ny) { return nx * this.sa + ny * this.ca > 0; }

  /** Canvas transform so 2D drawing in panel units lands on plane z. */
  plane(ctx, z, dpr = 1) {
    const S = this.S * dpr;
    const a = S * this.ca, b = S * this.se * this.sa, c = -S * this.sa, d = S * this.se * this.ca;
    const e = this.ox * dpr - a * this.cx - c * this.cy;
    const f = this.oy * dpr - b * this.cx - d * this.cy - S * this.ce * z;
    ctx.setTransform(a, b, c, d, e, f);
  }

  /** Back to device pixels (all path helpers here emit device-pixel coords). */
  screen(ctx) { ctx.setTransform(1, 0, 0, 1, 0, 0); }
}

/** Rounded rect as a closed polyline (panel units). */
export function roundRectPts(x, y, w, h, r, seg = 4) {
  const pts = [];
  const corner = (cx, cy, a0) => {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * Math.PI / 2;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  };
  corner(x + w - r, y + r, -Math.PI / 2);
  corner(x + w - r, y + h - r, 0);
  corner(x + r, y + h - r, Math.PI / 2);
  corner(x + r, y + r, Math.PI);
  return pts;
}

export function circlePts(cx, cy, r, seg = 24) {
  const pts = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

/**
 * Extruded prism from a clockwise (screen-space, y down) polygon: fills the
 * camera-facing side quads and the top, then strokes silhouette + top rim.
 */
export function prism(ctx, iso, pts, z0, z1, { fill = '#08090b', stroke, lw = 1, side = null, dpr = 1 } = {}) {
  ctx.lineWidth = lw * dpr;
  ctx.strokeStyle = stroke;
  const n = pts.length;
  // side faces
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % n];
    // outward normal of a CW polygon in y-down space
    const nx = y1 - y0, ny = -(x1 - x0);
    if (!iso.faces(nx, ny)) continue;
    const a = iso.P(x0, y0, z0), b = iso.P(x1, y1, z0), c = iso.P(x1, y1, z1), d = iso.P(x0, y0, z1);
    ctx.moveTo(a[0] * dpr, a[1] * dpr); ctx.lineTo(b[0] * dpr, b[1] * dpr);
    ctx.lineTo(c[0] * dpr, c[1] * dpr); ctx.lineTo(d[0] * dpr, d[1] * dpr); ctx.closePath();
  }
  ctx.fillStyle = side ?? fill;
  ctx.fill();
  // bottom silhouette edges + vertical edges at silhouette corners
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % n];
    if (!iso.faces(y1 - y0, -(x1 - x0))) continue;
    const a = iso.P(x0, y0, z0), b = iso.P(x1, y1, z0);
    ctx.moveTo(a[0] * dpr, a[1] * dpr); ctx.lineTo(b[0] * dpr, b[1] * dpr);
    const [xp, yp] = pts[(i - 1 + n) % n];
    if (!iso.faces(y0 - yp, -(x0 - xp))) {   // corner where visibility starts
      const t = iso.P(x0, y0, z1); ctx.moveTo(a[0] * dpr, a[1] * dpr); ctx.lineTo(t[0] * dpr, t[1] * dpr);
    }
    const [x2, y2] = pts[(i + 2) % n];
    if (!iso.faces(y2 - y1, -(x2 - x1))) {   // corner where visibility ends
      const t = iso.P(x1, y1, z1); ctx.moveTo(b[0] * dpr, b[1] * dpr); ctx.lineTo(t[0] * dpr, t[1] * dpr);
    }
  }
  ctx.stroke();
  // top face
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const p = iso.P(pts[i][0], pts[i][1], z1);
    if (i) ctx.lineTo(p[0] * dpr, p[1] * dpr); else ctx.moveTo(p[0] * dpr, p[1] * dpr);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.stroke();
}

export function polyPath(ctx, iso, pts, z, dpr = 1, close = true) {
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const p = iso.P(pts[i][0], pts[i][1], z);
    if (i) ctx.lineTo(p[0] * dpr, p[1] * dpr); else ctx.moveTo(p[0] * dpr, p[1] * dpr);
  }
  if (close) ctx.closePath();
}

export const rgba = (rgb, a) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
