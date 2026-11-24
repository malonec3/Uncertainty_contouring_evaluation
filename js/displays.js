// Uncertainty display modes. Every mode is driven by the same AnchoredUncertainty, so the arms differ
// only in how the information is presented (plus granularity, which is intrinsic to each format).
//
//   none        control: contour only
//   heatmap     colour wash of p(x) (probability the model is wrong at x)
//   bands       shaded band where p(x) >= threshold
//   redgreen    the contour is red where fewer than `redgreenAgree` of all contours agree within 2 mm
//   numeric     model certainty for the current slice as a percentage (changes as you scroll)

export const MODES = {
  none: { label: 'No uncertainty display (control)' },
  redgreen: { label: 'Red/green contour' },
  heatmap: { label: 'Heat map' },
  bands: { label: 'Uncertainty band' },
  numeric: { label: 'Certainty % per slice' },
};
export const MODE_IDS = Object.keys(MODES);

export const DEFAULT_DISPLAY_PARAMS = {
  threshold: 0.1,        // band = region where the displayed field >= threshold (contour-anchored: 0.1 = 80% interval)
  heatmapMin: 0.05,      // heat-map values below this are fully transparent
  redgreenAgree: 0.5,    // red where fewer than this share of all contours agree within 2 mm
  redgreenMm: 2.5,       // fallback for case files without agreement data: red where expected error >= this (mm)
  contourColor: '#19d3ff',
  contourWidth: 2,
};

const STOPS = [
  [0.0, [255, 255, 178]], [0.25, [254, 204, 92]], [0.5, [253, 141, 60]], [0.75, [240, 59, 32]], [1.0, [189, 0, 38]],
];
export function heatColor(p) {
  for (let s = 1; s < STOPS.length; s++) {
    if (p <= STOPS[s][0]) {
      const [p0, c0] = STOPS[s - 1], [p1, c1] = STOPS[s];
      const t = (p - p0) / (p1 - p0);
      return [0, 1, 2].map((i) => Math.round(c0[i] + (c1[i] - c0[i]) * t));
    }
  }
  return STOPS[STOPS.length - 1][1];
}
const GRADIENT_CSS = `linear-gradient(to right, ${STOPS.map(([p, c]) => `rgb(${c.join(',')}) ${p * 100}%`).join(', ')})`;
const pct = (v) => `${Math.round(v * 100)}%`;

class BaseDisplay {
  constructor(id, uview, params) {
    this.id = id;
    this.u = uview;
    this.p = { ...DEFAULT_DISPLAY_PARAMS, ...(params || {}) };
  }
  get hasOverlay() { return this.id !== 'none'; }
  drawBeneath() {}
  drawContour(ctx, view, k, lines) { view.strokeLines(ctx, lines, this.p.contourColor, this.p.contourWidth); }
  hudHTML() { return ''; }
  legendHTML() { return ''; }
  explanationHTML() { return ''; }
}

class NoneDisplay extends BaseDisplay {
  legendHTML() {
    return `<div class="legend-row"><span class="swatch-line" style="background:${this.p.contourColor}"></span> Proposed contour</div>`;
  }
  explanationHTML() {
    return `<p>You will see the proposed contour only. No information about the model's uncertainty is shown.</p>`;
  }
}

class HeatmapDisplay extends BaseDisplay {
  constructor(...a) { super(...a); this._cache = new Map(); }
  _image(k) {
    if (this._cache.has(k)) return this._cache.get(k);
    const { nx, ny } = this.u.grid;
    const ps = this.u.pSlice(k);
    const scale = this.u.heatScale || 1;
    const img = new ImageData(nx, ny);
    const d = img.data;
    const lut = [];
    for (let i = 0; i <= 255; i++) lut.push(heatColor(i / 255));
    for (let q = 0; q < nx * ny; q++) {
      const p = Math.min(1, ps[q] * scale);
      if (p < this.p.heatmapMin) continue;
      const c = lut[Math.min(255, Math.round(p * 255))];
      d[4 * q] = c[0]; d[4 * q + 1] = c[1]; d[4 * q + 2] = c[2];
      d[4 * q + 3] = Math.round(255 * (0.3 + 0.4 * Math.min(1, p / 0.8)));
    }
    if (this._cache.size > 40) this._cache.clear();
    this._cache.set(k, img);
    return img;
  }
  drawBeneath(ctx, view, k) { view.drawSliceImage(ctx, this._image(k), true); }
  legendHTML() {
    return `<div class="legend-row"><span class="swatch-line" style="background:${this.p.contourColor}"></span> Proposed contour</div>
      <div class="legend-title">Model uncertainty</div>
      <div class="legend-gradient" style="background:${GRADIENT_CSS}"></div>
      <div class="legend-scale"><span>low</span><span>high</span></div>
      <div class="legend-note">Colour shows how likely the model is to be wrong at each location (transparent below ${pct(this.p.heatmapMin)}).</div>`;
  }
  explanationHTML() {
    return `<p>A <b>colour map</b> is overlaid on the image. Colour shows how likely the model is to be wrong at each location:
      pale yellow = some uncertainty, through orange, to dark red = high uncertainty. Areas with no colour are areas where the model is confident.</p>
      <div class="legend-gradient" style="background:${GRADIENT_CSS};max-width:320px"></div>
      <div class="legend-scale" style="max-width:320px"><span>low</span><span>high</span></div>`;
  }
}

class BandsDisplay extends BaseDisplay {
  constructor(...a) { super(...a); this._cache = new Map(); }
  _lines(k) {
    if (this._cache.has(k)) return this._cache.get(k);
    const lines = this.u.isolinesAt(k, this.p.threshold);
    if (this._cache.size > 60) this._cache.clear();
    this._cache.set(k, lines);
    return lines;
  }
  drawBeneath(ctx, view, k) {
    const lines = this._lines(k);
    if (!lines.length) return;
    ctx.save();
    ctx.beginPath();
    for (const l of lines) view.tracePath(ctx, l);
    ctx.fillStyle = 'rgba(255, 196, 0, 0.30)';
    ctx.fill('evenodd');
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 196, 0, 0.95)';
    ctx.stroke();
    ctx.restore();
  }
  legendHTML() {
    return `<div class="legend-row"><span class="swatch-line" style="background:${this.p.contourColor}"></span> Proposed contour</div>
      <div class="legend-row"><span class="swatch-box" style="background:rgba(255,196,0,.35);border:1px dashed #ffc400"></span> Uncertainty band</div>
      <div class="legend-note">Shaded band = zone where the model is uncertain about the boundary. Outside the band the model is confident.</div>`;
  }
  explanationHTML() {
    return `<p>A <b>shaded yellow band</b> with a dashed outline marks the zone where the model is uncertain about the boundary.
      The model is confident everywhere outside the band. A contour that runs through the band may need checking there.</p>`;
  }
}

class RedGreenDisplay extends BaseDisplay {
  drawContour(ctx, view, k, lines) {
    const red = [], green = [], grey = [];
    const useA = this.u.hasAgreement;
    for (const l of lines) {
      const n = l.length / 2;
      for (let q = 0; q < n; q++) {
        const a = 2 * q, b = 2 * ((q + 1) % n);
        const x = (l[a] + l[b]) / 2, y = (l[a + 1] + l[b + 1]) / 2;
        const v = useA ? this.u.sampleAgreement(k, x, y) : this.u.sampleLocal(k, x, y);
        const isRed = useA ? v < this.p.redgreenAgree : v >= this.p.redgreenMm;
        (Number.isNaN(v) ? grey : isRed ? red : green).push(l[a], l[a + 1], l[b], l[b + 1]);
      }
    }
    view.strokeSegments(ctx, grey, '#c9d1d9', this.p.contourWidth);
    view.strokeSegments(ctx, green, '#2ee06b', this.p.contourWidth + 0.5);
    view.strokeSegments(ctx, red, '#ff2d2d', this.p.contourWidth + 0.5);
  }
  legendHTML() {
    return `<div class="legend-row"><span class="swatch-line" style="background:#2ee06b"></span> Model confident here</div>
      <div class="legend-row"><span class="swatch-line" style="background:#ff2d2d"></span> Model uncertain here</div>
      <div class="legend-row"><span class="swatch-line" style="background:#c9d1d9"></span> Drawn away from the model's contour (no information)</div>`;
  }
  explanationHTML() {
    return `<p>The contour is <span style="color:#ff2d2d;font-weight:600">red</span> where most of the model's contours disagree by more than 2 mm, and
      <span style="color:#2ee06b;font-weight:600">green</span> where they agree.</p>`;
  }
}

class NumericDisplay extends BaseDisplay {
  hudHTML(k) {
    const m = this.u.sliceMean[k];
    return `<div class="num-box">
      <div class="num-label">Model certainty – this slice</div>
      <div class="num-value">${Number.isFinite(m) ? pct(m) : '–'}</div>
    </div>`;
  }
  legendHTML() {
    return `<div class="legend-row"><span class="swatch-line" style="background:${this.p.contourColor}"></span> Proposed contour</div>
      <div class="legend-note">The number in the image is the model's certainty for the slice you are viewing (100% = fully confident). It changes as you move between slices.</div>`;
  }
  explanationHTML() {
    return `<p>A <b>number</b> in the top-left corner of the image shows the model's certainty for the slice you are viewing
      (100% = fully confident; lower = less confident). It changes as you move between slices.</p>
      <div class="num-box static"><div class="num-label">Model certainty – this slice</div><div class="num-value">82%</div></div>`;
  }
}

export function createDisplay(mode, uview, params) {
  switch (mode) {
    case 'heatmap': return new HeatmapDisplay(mode, uview, params);
    case 'bands': return new BandsDisplay(mode, uview, params);
    case 'redgreen': return new RedGreenDisplay(mode, uview, params);
    case 'numeric': return new NumericDisplay(mode, uview, params);
    default: return new NoneDisplay('none', uview, params);
  }
}

// ------------------------------------------------------------------ participant-facing names, one-liners, graphics
export const FRIENDLY = {
  none: { name: 'No uncertainty shown', line: 'Proposed contour only.' },
  heatmap: { name: 'Heat map', line: 'Colour around the contour. Redder and wider = less certain.' },
  bands: { name: 'Uncertainty band', line: 'The true edge is probably inside the yellow band. Wider = less certain.' },
  redgreen: { name: 'Red / green contour', line: 'Red = model uncertain here. Green = model confident.' },
  numeric: { name: 'Certainty % per slice', line: 'How certain the model is on the slice you are viewing.' },
};

let svgSeq = 0;
// Organ outline as a polygon, optionally offset outwards by w(theta) px (negative = inwards).
// The right-hand side is the "uncertain" side: offsets taper smoothly from wl (left) to wr (right).
function blobPath(wl = 0, wr = 0, sign = 1) {
  const pts = [];
  for (let i = 0; i < 96; i++) {
    const t = (2 * Math.PI * i) / 96;
    const c = Math.cos(t), sn = Math.sin(t);
    const s = Math.min(1, Math.max(0, (c + 0.25) / 1.0));
    const sm = s * s * (3 - 2 * s);
    const w = sign * (wl + (wr - wl) * sm);
    const wob = 1 + 0.06 * Math.sin(3 * t + 0.6);
    pts.push([126 + (58 * wob + w) * c, 84 + (42 * wob + w) * sn, sm]);
  }
  return pts;
}
const toD = (pts) => `M${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L')} Z`;
const bandD = (wl, wr) => `${toD(blobPath(wl, wr, 1))} ${toD(blobPath(wl, wr, -1))}`;

/** Small, self-contained illustration of a display (same colours as the real rendering). */
export function displayGraphic(mode, size = 240) {
  const id = `g${++svgSeq}`;
  const h = Math.round((size * 160) / 240);
  const line = toD(blobPath());
  const contour = (color = '#19d3ff', w = 3) => `<path d="${line}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linejoin="round"/>`;
  let defs = '', under = '', over = contour();
  if (mode === 'heatmap') {
    defs = `<filter id="${id}b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.2"/></filter>`;
    under = `<g filter="url(#${id}b)" fill-rule="evenodd">
      <path d="${bandD(3, 20)}" fill="#fecc5c" opacity=".75"/>
      <path d="${bandD(1.5, 12)}" fill="#fd8d3c" opacity=".9"/>
      <path d="${bandD(0.5, 5)}" fill="#bd0026" opacity=".9"/></g>`;
  } else if (mode === 'bands') {
    under = `<path d="${bandD(3, 15)}" fill="rgba(255,196,0,.38)" fill-rule="evenodd" stroke="#ffc400" stroke-width="1.2" stroke-dasharray="4 3"/>`;
  } else if (mode === 'redgreen') {
    const pts = blobPath();
    let red = '', green = '';
    pts.forEach((p, i) => {
      const q = pts[(i + 1) % pts.length];
      const seg = `M${p[0].toFixed(1)},${p[1].toFixed(1)} L${q[0].toFixed(1)},${q[1].toFixed(1)} `;
      if ((p[2] + q[2]) / 2 > 0.5) red += seg; else green += seg;
    });
    over = `<path d="${green}" stroke="#2ee06b" stroke-width="4" stroke-linecap="round"/><path d="${red}" stroke="#ff2d2d" stroke-width="4" stroke-linecap="round"/>`;
  } else if (mode === 'numeric') {
    over = `${contour()}<rect x="10" y="10" width="70" height="40" rx="6" fill="rgba(8,12,18,.85)" stroke="rgba(120,170,220,.6)"/>
      <text x="18" y="24" font-size="8.5" fill="#b9c6d3" font-family="system-ui,sans-serif" letter-spacing=".04em">THIS SLICE</text>
      <text x="18" y="43" font-size="18" font-weight="700" fill="#fff" font-family="system-ui,sans-serif">82%</text>
      <text x="230" y="150" font-size="9" fill="#9aa7b4" text-anchor="end" font-family="system-ui,sans-serif">changes slice by slice</text>`;
  }
  return `<svg class="disp-graphic" viewBox="0 0 240 160" width="${size}" height="${h}" role="img" aria-label="${FRIENDLY[mode]?.name || mode}">
    <defs>${defs}</defs>
    <rect width="240" height="160" rx="10" fill="#15181c"/>
    <ellipse cx="122" cy="84" rx="112" ry="74" fill="#4a4f55"/>
    <path d="${line}" fill="#666c73"/>
    ${under}${over}</svg>`;
}
