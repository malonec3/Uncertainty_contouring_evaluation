// Axial slice editor: CT display, contour editing tools, uncertainty overlays, reference views.

import { maskSliceContours, sliceBBox, isolines, smoothClosed } from './contour.js';
import { fillPolygonSet } from './volume.js';

export const WINDOW_PRESETS = [
  { id: 'soft', name: 'Soft tissue', center: 40, width: 400 },
  { id: 'narrow', name: 'Narrow soft tissue', center: 50, width: 250 },
  { id: 'brain', name: 'Brain', center: 40, width: 80 },
  { id: 'bone', name: 'Bone', center: 400, width: 1800 },
  { id: 'lung', name: 'Lung', center: -600, width: 1500 },
];

export const TOOLS = {
  brush: { label: 'Brush', key: '1', icon: '●', hint: 'Paint to add. Hold Shift to erase.' },
  eraser: { label: 'Eraser', key: '2', icon: '○', hint: 'Paint to remove.' },
  lassoAdd: { label: 'Draw +', key: '3', icon: '✚', hint: 'Draw a closed outline to add the enclosed area.' },
  lassoCut: { label: 'Draw −', key: '4', icon: '✂', hint: 'Draw a closed outline to cut the enclosed area.' },
  pan: { label: 'Pan', key: '5', icon: '✥', hint: 'Drag to move the image.' },
};

const UNDO_LIMIT = 300;

export class SliceEditor {
  /**
   * @param {HTMLElement} el container
   * @param {object} o  { grid, ct, mask, display, window, readOnly, overlays, referenceViews,
   *                      startSlice, brushMm, onLog, onChange, onSlice }
   */
  constructor(el, o) {
    this.el = el;
    this.grid = o.grid;
    this.ct = o.ct;
    this.mask = o.mask;
    this.display = o.display || null;
    this.readOnly = !!o.readOnly;
    this.overlays = o.overlays || [];
    this.showRefViews = o.referenceViews !== false;
    this.onLog = o.onLog || (() => {});
    this.onChange = o.onChange || (() => {});
    this.onSlice = o.onSlice || (() => {});
    this.win = { ...(o.window || WINDOW_PRESETS[0]) };
    this.tool = this.readOnly ? 'pan' : 'brush';
    this.brushMm = o.brushMm || 3;
    this.showContour = true;
    this.showUncertainty = true;
    this.per = this.grid.nx * this.grid.ny;
    this.undoStack = [];
    this.redoStack = [];
    this.editedSlices = new Set();
    this.nEdits = 0;
    this._contourCache = new Map();
    this._ctCache = { k: -1, key: '' };
    this._pointers = new Map();
    this.k = o.startSlice ?? this._defaultSlice();
    this._buildDOM();
    this.fitToMask();
    this.cross = this._defaultCross();
    this._bind();
    this.requestRender();
  }

  // ------------------------------------------------------------------ setup
  _defaultSlice() {
    let k0 = -1, k1 = -1;
    for (let k = 0; k < this.grid.nz; k++) if (sliceBBox(this.mask, this.grid, k)) { if (k0 < 0) k0 = k; k1 = k; }
    return k0 < 0 ? Math.floor(this.grid.nz / 2) : Math.round((k0 + k1) / 2);
  }
  _defaultCross() {
    const bb = sliceBBox(this.mask, this.grid, this.k);
    return bb ? { i: Math.round((bb.i0 + bb.i1) / 2), j: Math.round((bb.j0 + bb.j1) / 2) } : { i: this.grid.nx >> 1, j: this.grid.ny >> 1 };
  }

  _buildDOM() {
    this.el.classList.add('ed-root');
    this.el.innerHTML = `
      <div class="ed-main">
        <canvas class="ed-canvas" tabindex="0"></canvas>
        <div class="ed-hud-tl"></div>
        <div class="ed-hud-bl"></div>
        <div class="ed-hud-tr"></div>
      </div>
      <div class="ed-refs"${this.showRefViews ? '' : ' hidden'}>
        <div class="ed-ref"><div class="ed-ref-label">Sagittal</div><canvas class="ed-sag"></canvas></div>
        <div class="ed-ref"><div class="ed-ref-label">Coronal</div><canvas class="ed-cor"></canvas></div>
      </div>`;
    this.canvas = this.el.querySelector('.ed-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.hudTL = this.el.querySelector('.ed-hud-tl');
    this.hudBL = this.el.querySelector('.ed-hud-bl');
    this.hudTR = this.el.querySelector('.ed-hud-tr');
    this.sag = this.el.querySelector('.ed-sag');
    this.cor = this.el.querySelector('.ed-cor');
    this.off = document.createElement('canvas');
    this.off.width = this.grid.nx; this.off.height = this.grid.ny;
    this.offCtx = this.off.getContext('2d');
    this.off2 = document.createElement('canvas');
    this.off2.width = this.grid.nx; this.off2.height = this.grid.ny;
    this.off2Ctx = this.off2.getContext('2d');
    this._resizeObs = new ResizeObserver(() => { this._resize(); });
    this._resizeObs.observe(this.el.querySelector('.ed-main'));
    this._resize();
  }

  _resize() {
    const main = this.el.querySelector('.ed-main');
    const r = main.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.W = Math.max(50, r.width); this.H = Math.max(50, r.height);
    this.canvas.width = Math.round(this.W * dpr); this.canvas.height = Math.round(this.H * dpr);
    this.canvas.style.width = `${this.W}px`; this.canvas.style.height = `${this.H}px`;
    this.dpr = dpr;
    if (!this.scale) this.fitToMask();
    this.requestRender();
  }

  destroy() {
    this._resizeObs.disconnect();
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('keyup', this._onKeyUp);
    this.el.innerHTML = '';
  }

  // ------------------------------------------------------------------ view transform
  fitToMask(marginMm = 25) {
    const g = this.grid;
    let bb = null;
    for (let k = 0; k < g.nz; k++) {
      const b = sliceBBox(this.mask, g, k);
      if (b) bb = bb ? { i0: Math.min(bb.i0, b.i0), i1: Math.max(bb.i1, b.i1), j0: Math.min(bb.j0, b.j0), j1: Math.max(bb.j1, b.j1) } : b;
    }
    if (!bb) bb = { i0: 0, i1: g.nx - 1, j0: 0, j1: g.ny - 1 };
    const wmm = (bb.i1 - bb.i0) * g.dx + 2 * marginMm, hmm = (bb.j1 - bb.j0) * g.dy + 2 * marginMm;
    this.scale = Math.min((this.W || 600) / wmm, (this.H || 600) / hmm);
    this.cx = ((bb.i0 + bb.i1) / 2) * g.dx;
    this.cy = ((bb.j0 + bb.j1) / 2) * g.dy;
    this.requestRender();
  }
  fitAll() {
    const g = this.grid;
    this.scale = Math.min(this.W / (g.nx * g.dx), this.H / (g.ny * g.dy));
    this.cx = ((g.nx - 1) / 2) * g.dx; this.cy = ((g.ny - 1) / 2) * g.dy;
    this.requestRender();
  }
  // pixel coords -> screen (CSS px)
  sx(x) { return (x * this.grid.dx - this.cx) * this.scale + this.W / 2; }
  sy(y) { return (y * this.grid.dy - this.cy) * this.scale + this.H / 2; }
  // screen -> pixel coords
  px(sx) { return ((sx - this.W / 2) / this.scale + this.cx) / this.grid.dx; }
  py(sy) { return ((sy - this.H / 2) / this.scale + this.cy) / this.grid.dy; }

  // helpers given to display renderers
  drawSliceImage(ctx, imageData, smooth = true) {
    this.off2Ctx.putImageData(imageData, 0, 0);
    ctx.imageSmoothingEnabled = smooth;
    const g = this.grid;
    ctx.drawImage(this.off2, this.sx(-0.5), this.sy(-0.5), g.nx * g.dx * this.scale, g.ny * g.dy * this.scale);
  }
  tracePath(ctx, line) {
    ctx.moveTo(this.sx(line[0]), this.sy(line[1]));
    for (let q = 2; q < line.length; q += 2) ctx.lineTo(this.sx(line[q]), this.sy(line[q + 1]));
    ctx.closePath();
  }
  strokeLines(ctx, lines, color, width, dash = null) {
    if (!lines.length) return;
    ctx.save();
    ctx.beginPath();
    for (const l of lines) this.tracePath(ctx, l);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color; ctx.lineWidth = width;
    if (dash) ctx.setLineDash(dash);
    ctx.stroke();
    ctx.restore();
  }
  strokeSegments(ctx, segs, color, width) {
    if (!segs.length) return;
    ctx.save();
    ctx.beginPath();
    for (let q = 0; q < segs.length; q += 4) {
      ctx.moveTo(this.sx(segs[q]), this.sy(segs[q + 1]));
      ctx.lineTo(this.sx(segs[q + 2]), this.sy(segs[q + 3]));
    }
    ctx.lineCap = 'round';
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.stroke();
    ctx.restore();
  }

  // ------------------------------------------------------------------ rendering
  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }

  _ctImage(k) {
    const key = `${k}:${this.win.center}:${this.win.width}`;
    if (this._ctCache.key === key) return;
    const { nx, ny } = this.grid;
    const img = this.offCtx.createImageData(nx, ny);
    const d = img.data;
    const lo = this.win.center - this.win.width / 2, w = this.win.width;
    const src = this.ct.subarray(k * this.per, (k + 1) * this.per);
    for (let q = 0; q < this.per; q++) {
      let v = ((src[q] - lo) / w) * 255;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      d[4 * q] = d[4 * q + 1] = d[4 * q + 2] = v; d[4 * q + 3] = 255;
    }
    this.offCtx.putImageData(img, 0, 0);
    this._ctCache.key = key;
  }

  contours(k) {
    if (this._contourCache.has(k)) return this._contourCache.get(k);
    const bb = sliceBBox(this.mask, this.grid, k);
    const lines = bb ? maskSliceContours(this.mask, this.grid, k, bb).map((l) => smoothClosed(l)) : [];
    this._contourCache.set(k, lines);
    return lines;
  }

  render() {
    const ctx = this.ctx, g = this.grid, k = this.k;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.W, this.H);
    this._ctImage(k);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.off, this.sx(-0.5), this.sy(-0.5), g.nx * g.dx * this.scale, g.ny * g.dy * this.scale);
    const unc = this.display && this.showUncertainty;
    if (unc) this.display.drawBeneath(ctx, this, k);
    for (const ov of this.overlays) {
      if (ov.visible === false) continue;
      const bb = sliceBBox(ov.mask, g, k);
      if (bb) this.strokeLines(ctx, maskSliceContours(ov.mask, g, k, bb).map((l) => smoothClosed(l)), ov.color, ov.width || 1.5, ov.dash || null);
    }
    if (this.showContour) {
      const lines = this.contours(k);
      if (unc) this.display.drawContour(ctx, this, k, lines);
      else this.strokeLines(ctx, lines, this.display ? this.display.p.contourColor : '#19d3ff', this.display ? this.display.p.contourWidth : 2);
    }
    // lasso in progress
    if (this._lasso && this._lasso.length > 2) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(this.sx(this._lasso[0]), this.sy(this._lasso[1]));
      for (let q = 2; q < this._lasso.length; q += 2) ctx.lineTo(this.sx(this._lasso[q]), this.sy(this._lasso[q + 1]));
      ctx.strokeStyle = this.tool === 'lassoCut' ? '#ff8080' : '#ffffff';
      ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    }
    // brush cursor
    if (this._hover && (this.tool === 'brush' || this.tool === 'eraser') && !this.readOnly) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(this.sx(this._hover.x), this.sy(this._hover.y), this.brushMm * this.scale, 0, Math.PI * 2);
      const erase = this.tool === 'eraser' || this._shift;
      ctx.strokeStyle = erase ? 'rgba(255,128,128,.9)' : 'rgba(255,255,255,.9)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
    // HUD
    const z = g.slicePos[k];
    this.hudBL.textContent = `Slice ${k + 1} / ${g.nz}   z = ${z.toFixed(1)} mm`;
    this.hudTR.textContent = `W ${Math.round(this.win.width)}  L ${Math.round(this.win.center)}`;
    const hud = unc ? this.display.hudHTML(k) : '';
    if (hud !== this._lastHud) { this.hudTL.innerHTML = hud; this._lastHud = hud; }
    if (this.showRefViews) this._renderRefs();
  }

  _renderRefs() {
    const g = this.grid;
    const i = Math.max(0, Math.min(g.nx - 1, this.cross.i)), j = Math.max(0, Math.min(g.ny - 1, this.cross.j));
    // sagittal: horizontal = j (dy), vertical = k (dz), superior (high k) at top
    this._renderRef(this.sag, g.ny, g.dy, (a, k) => k * this.per + a * g.nx + i, j);
    this._renderRef(this.cor, g.nx, g.dx, (a, k) => k * this.per + j * g.nx + a, i);
  }

  _renderRef(canvas, na, da, idx, crossA) {
    const g = this.grid, nz = g.nz;
    const box = canvas.parentElement.getBoundingClientRect();
    const dpr = this.dpr;
    const wmm = na * da, hmm = nz * g.dz;
    const s = Math.min((box.width - 4) / wmm, 180 / hmm, 3);
    const W = Math.max(10, wmm * s), H = Math.max(10, hmm * s);
    if (canvas.width !== Math.round(W * dpr)) { canvas.width = Math.round(W * dpr); canvas.style.width = `${W}px`; }
    if (canvas.height !== Math.round(H * dpr)) { canvas.height = Math.round(H * dpr); canvas.style.height = `${H}px`; }
    canvas._map = { s, da, na, nz };
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // CT
    if (!canvas._off || canvas._off.width !== na || canvas._off.height !== nz) {
      canvas._off = document.createElement('canvas'); canvas._off.width = na; canvas._off.height = nz;
    }
    const octx = canvas._off.getContext('2d');
    const img = octx.createImageData(na, nz);
    const lo = this.win.center - this.win.width / 2, w = this.win.width;
    const m = new Float32Array(na * nz);
    for (let k = 0; k < nz; k++) for (let a = 0; a < na; a++) {
      const q = idx(a, k);
      let v = ((this.ct[q] - lo) / w) * 255;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      const r = (nz - 1 - k) * na + a;
      img.data[4 * r] = img.data[4 * r + 1] = img.data[4 * r + 2] = v; img.data[4 * r + 3] = 255;
      m[r] = this.mask[q];
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(canvas._off, 0, 0, W, H);
    // contour
    const lines = isolines((a, r) => m[r * na + a], na, nz, 0.5);
    ctx.save();
    ctx.beginPath();
    const X = (a) => (a + 0.5) * da * s, Y = (r) => (r + 0.5) * g.dz * s;
    for (const l of lines) {
      ctx.moveTo(X(l[0]), Y(l[1]));
      for (let q = 2; q < l.length; q += 2) ctx.lineTo(X(l[q]), Y(l[q + 1]));
      ctx.closePath();
    }
    ctx.strokeStyle = this.display ? this.display.p.contourColor : '#19d3ff';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    // current slice + cross line
    ctx.strokeStyle = 'rgba(255,230,0,.85)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath();
    const yk = Y(nz - 1 - this.k);
    ctx.moveTo(0, yk); ctx.lineTo(W, yk);
    ctx.moveTo(X(crossA), 0); ctx.lineTo(X(crossA), H);
    ctx.stroke();
    ctx.restore();
  }

  // ------------------------------------------------------------------ state changes
  setSlice(k, source = 'nav') {
    k = Math.max(0, Math.min(this.grid.nz - 1, k));
    if (k === this.k) return;
    this.k = k;
    this.onSlice(k);
    this.onLog('slice', { k, source });
    this.requestRender();
  }
  setTool(t) {
    if (!TOOLS[t] || (this.readOnly && t !== 'pan')) return;
    this.tool = t;
    this.canvas.style.cursor = t === 'pan' ? 'grab' : 'crosshair';
    this.onLog('tool', { tool: t });
    this._emitUI();
    this.requestRender();
  }
  setBrush(mm) {
    this.brushMm = Math.max(0.5, Math.min(20, mm));
    this._emitUI();
    this.requestRender();
  }
  setWindow(center, width, source = 'preset') {
    this.win = { center, width: Math.max(1, width) };
    this.onLog('window', { center: Math.round(center), width: Math.round(width), source });
    this._emitUI();
    this.requestRender();
  }
  toggleContour(v = !this.showContour) { this.showContour = v; this.onLog('toggle_contour', { visible: v }); this._emitUI(); this.requestRender(); }
  toggleUncertainty(v = !this.showUncertainty) {
    if (!this.display || this.display.id === 'none') return;
    this.showUncertainty = v; this.onLog('toggle_uncertainty', { visible: v }); this._emitUI(); this.requestRender();
  }
  zoomBy(f, ax = this.W / 2, ay = this.H / 2) {
    const mx = this.px(ax) * this.grid.dx, my = this.py(ay) * this.grid.dy;
    this.scale = Math.max(0.3, Math.min(60, this.scale * f));
    this.cx = mx - (ax - this.W / 2) / this.scale;
    this.cy = my - (ay - this.H / 2) / this.scale;
    this._zoomLogT = this._zoomLogT || 0;
    if (performance.now() - this._zoomLogT > 500) { this.onLog('zoom', { scale: +this.scale.toFixed(2) }); this._zoomLogT = performance.now(); }
    this.requestRender();
  }
  set uiListener(fn) { this._ui = fn; }
  _emitUI() { if (this._ui) this._ui(this); }

  // ------------------------------------------------------------------ editing
  _sliceCopy(k) { return this.mask.slice(k * this.per, (k + 1) * this.per); }
  _beginEdit() { this._before = this._sliceCopy(this.k); this._beforeK = this.k; }
  _commitEdit(tool) {
    const k = this._beforeK, before = this._before;
    this._before = null;
    if (!before) return;
    const off = k * this.per;
    let changed = 0;
    for (let q = 0; q < this.per; q++) if (before[q] !== this.mask[off + q]) changed++;
    if (!changed) return;
    this.undoStack.push({ k, data: before });
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    this.editedSlices.add(k);
    this.nEdits++;
    this._contourCache.delete(k);
    this.onLog('edit', { tool, k, voxels: changed });
    this.onChange({ k, tool });
    this._emitUI();
    this.requestRender();
  }
  _restore(from, to, type) {
    const e = from.pop();
    if (!e) return;
    to.push({ k: e.k, data: this._sliceCopy(e.k) });
    this.mask.set(e.data, e.k * this.per);
    this._contourCache.delete(e.k);
    if (e.k !== this.k) this.setSlice(e.k, type);
    this.onLog(type, { k: e.k });
    this.onChange({ k: e.k, tool: type });
    this._emitUI();
    this.requestRender();
  }
  undo() { if (!this.readOnly) this._restore(this.undoStack, this.redoStack, 'undo'); }
  redo() { if (!this.readOnly) this._restore(this.redoStack, this.undoStack, 'redo'); }

  copyFromSlice(delta) {
    if (this.readOnly) return;
    const src = this.k + delta;
    if (src < 0 || src >= this.grid.nz) return;
    this._beginEdit();
    this.mask.copyWithin(this.k * this.per, src * this.per, (src + 1) * this.per);
    this._commitEdit(delta < 0 ? 'copy_below' : 'copy_above');
  }
  clearSlice() {
    if (this.readOnly) return;
    this._beginEdit();
    this.mask.fill(0, this.k * this.per, (this.k + 1) * this.per);
    this._commitEdit('clear_slice');
  }

  _stamp(x, y, value) {
    const g = this.grid, r = this.brushMm;
    const ri = Math.ceil(r / g.dx), rj = Math.ceil(r / g.dy);
    const ci = Math.round(x), cj = Math.round(y);
    const off = this.k * this.per;
    for (let j = cj - rj; j <= cj + rj; j++) {
      if (j < 0 || j >= g.ny) continue;
      const ddy = (j - y) * g.dy;
      for (let i = ci - ri; i <= ci + ri; i++) {
        if (i < 0 || i >= g.nx) continue;
        const ddx = (i - x) * g.dx;
        if (ddx * ddx + ddy * ddy <= r * r) this.mask[off + j * g.nx + i] = value;
      }
    }
  }
  _strokeTo(x, y, value) {
    const last = this._last;
    if (last) {
      const g = this.grid;
      const d = Math.hypot((x - last.x) * g.dx, (y - last.y) * g.dy);
      const steps = Math.max(1, Math.ceil(d / Math.max(0.3, this.brushMm * 0.4)));
      for (let s = 1; s <= steps; s++) this._stamp(last.x + ((x - last.x) * s) / steps, last.y + ((y - last.y) * s) / steps, value);
    } else this._stamp(x, y, value);
    this._last = { x, y };
    this._contourCache.delete(this.k);
    this.requestRender();
  }
  _finishLasso() {
    const pts = this._lasso;
    this._lasso = null;
    if (!pts || pts.length < 6) { this.requestRender(); return; }
    const xs = [], ys = [];
    for (let q = 0; q < pts.length; q += 2) { xs.push(pts[q]); ys.push(pts[q + 1]); }
    this._beginEdit();
    fillPolygonSet(this.mask, this.k * this.per, this.grid.nx, this.grid.ny, xs, ys, this._lassoValue);
    this._contourCache.delete(this.k);
    this._commitEdit(this._lassoValue ? 'lasso_add' : 'lasso_cut');
  }

  // ------------------------------------------------------------------ events
  _bind() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => this._down(e));
    c.addEventListener('pointermove', (e) => this._move(e));
    c.addEventListener('pointerup', (e) => this._up(e));
    c.addEventListener('pointercancel', (e) => this._up(e, true));
    c.addEventListener('pointerleave', () => { this._hover = null; this.requestRender(); });
    c.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    this._onKey = (e) => this._key(e);
    this._onKeyUp = (e) => { if (e.key === 'Shift') { this._shift = false; this.requestRender(); } if (e.code === 'Space') this._space = false; };
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('keyup', this._onKeyUp);
    for (const cv of [this.sag, this.cor]) {
      const handler = (e) => {
        if (e.type === 'pointermove' && !(e.buttons & 1)) return;
        const r = cv.getBoundingClientRect();
        const m = cv._map; if (!m) return;
        const row = Math.floor((e.clientY - r.top) / (m.s * this.grid.dz));
        this.setSlice(m.nz - 1 - row, 'reference_view');
      };
      cv.addEventListener('pointerdown', handler);
      cv.addEventListener('pointermove', handler);
    }
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    const ax = e.clientX - r.left, ay = e.clientY - r.top;
    return { ax, ay, x: this.px(ax), y: this.py(ay) };
  }

  _down(e) {
    this.canvas.focus({ preventScroll: true });
    this.canvas.setPointerCapture(e.pointerId);
    const p = this._pos(e);
    this._pointers.set(e.pointerId, p);
    if (this._pointers.size === 2) {
      // pinch: cancel any active stroke
      this._cancelStroke();
      const [a, b] = [...this._pointers.values()];
      this._pinch = { d: Math.hypot(a.ax - b.ax, a.ay - b.ay), mx: (a.ax + b.ax) / 2, my: (a.ay + b.ay) / 2 };
      this._mode = 'pinch';
      return;
    }
    if (e.button === 2) { this._mode = 'wl'; this._wl0 = { ...this.win, ax: p.ax, ay: p.ay }; return; }
    if (e.button === 1 || this.tool === 'pan' || this._space) {
      this._mode = 'pan'; this._pan0 = { ax: p.ax, ay: p.ay, cx: this.cx, cy: this.cy }; this.canvas.style.cursor = 'grabbing'; return;
    }
    if (this.readOnly || e.button !== 0) return;
    if (this.tool === 'brush' || this.tool === 'eraser') {
      this._mode = 'brush';
      this._brushValue = this.tool === 'brush' && !e.shiftKey ? 1 : 0;
      this._beginEdit();
      this._last = null;
      this._strokeTo(p.x, p.y, this._brushValue);
    } else if (this.tool === 'lassoAdd' || this.tool === 'lassoCut') {
      this._mode = 'lasso';
      this._lassoValue = this.tool === 'lassoAdd' && !e.shiftKey ? 1 : 0;
      this._lasso = [p.x, p.y];
      this._beginEdit();
      this._before = null; // lasso snapshots at finish
    }
  }

  _move(e) {
    const p = this._pos(e);
    this._shift = e.shiftKey;
    if (this._pointers.has(e.pointerId)) this._pointers.set(e.pointerId, p);
    if (this._mode === 'pinch' && this._pointers.size === 2) {
      const [a, b] = [...this._pointers.values()];
      const d = Math.hypot(a.ax - b.ax, a.ay - b.ay), mx = (a.ax + b.ax) / 2, my = (a.ay + b.ay) / 2;
      this.cx -= (mx - this._pinch.mx) / this.scale; this.cy -= (my - this._pinch.my) / this.scale;
      if (this._pinch.d > 10) this.zoomBy(d / this._pinch.d, mx, my);
      this._pinch = { d, mx, my };
      this.requestRender();
      return;
    }
    this._hover = { x: p.x, y: p.y };
    if (!this._mode) {
      if (this.showRefViews && !(e.buttons & 1)) {
        const i = Math.round(p.x), j = Math.round(p.y);
        if (i >= 0 && j >= 0 && i < this.grid.nx && j < this.grid.ny) this.cross = { i, j };
      }
      this.requestRender();
      return;
    }
    if (this._mode === 'pan') {
      this.cx = this._pan0.cx - (p.ax - this._pan0.ax) / this.scale;
      this.cy = this._pan0.cy - (p.ay - this._pan0.ay) / this.scale;
      this.requestRender();
    } else if (this._mode === 'wl') {
      const w = Math.max(1, this._wl0.width + (p.ax - this._wl0.ax) * 4);
      const c = this._wl0.center - (p.ay - this._wl0.ay) * 2;
      this.win = { center: c, width: w };
      this._emitUI();
      this.requestRender();
    } else if (this._mode === 'brush') {
      this._strokeTo(p.x, p.y, this._brushValue);
    } else if (this._mode === 'lasso') {
      const L = this._lasso;
      const lx = L[L.length - 2], ly = L[L.length - 1];
      if (Math.hypot(p.x - lx, p.y - ly) > 0.3) { L.push(p.x, p.y); this.requestRender(); }
    }
  }

  _cancelStroke() {
    if (this._mode === 'brush' && this._before) {
      this.mask.set(this._before, this._beforeK * this.per);
      this._contourCache.delete(this._beforeK);
      this._before = null;
    }
    this._lasso = null;
    this._mode = null;
  }

  _up(e, cancelled = false) {
    this._pointers.delete(e.pointerId);
    const mode = this._mode;
    if (mode === 'pinch') { if (this._pointers.size === 0) this._mode = null; return; }
    this._mode = null;
    if (cancelled) { this._cancelStroke(); this.requestRender(); return; }
    if (mode === 'brush') this._commitEdit(this._brushValue ? 'brush' : 'eraser');
    else if (mode === 'lasso') this._finishLasso();
    else if (mode === 'wl') this.onLog('window', { center: Math.round(this.win.center), width: Math.round(this.win.width), source: 'drag' });
    else if (mode === 'pan') { this.canvas.style.cursor = this.tool === 'pan' ? 'grab' : 'crosshair'; this.onLog('pan', {}); }
    this._last = null;
  }

  _wheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const r = this.canvas.getBoundingClientRect();
      this.zoomBy(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.002)), e.clientX - r.left, e.clientY - r.top);
      return;
    }
    if (this._mode === 'brush' || this._mode === 'lasso') return; // no slice change mid-stroke
    const d = e.deltaMode ? e.deltaY * 40 : e.deltaY;
    if (Math.abs(d) >= 50) { this.setSlice(this.k + (d < 0 ? 1 : -1), 'wheel'); this._wacc = 0; return; }
    this._wacc = (this._wacc || 0) + d;
    if (Math.abs(this._wacc) >= 50) { this.setSlice(this.k + (this._wacc < 0 ? 1 : -1), 'wheel'); this._wacc = 0; }
  }

  _key(e) {
    if (!this.el.isConnected || this.el.offsetParent === null) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (e.key === 'Shift') { this._shift = true; this.requestRender(); }
    if (e.code === 'Space') { this._space = true; e.preventDefault(); return; }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
    if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); this.redo(); return; }
    if (mod) return;
    switch (e.key) {
      case 'ArrowUp': case 'PageUp': e.preventDefault(); this.setSlice(this.k + 1, 'key'); break;
      case 'ArrowDown': case 'PageDown': e.preventDefault(); this.setSlice(this.k - 1, 'key'); break;
      case '[': this.setBrush(this.brushMm - 0.5); break;
      case ']': this.setBrush(this.brushMm + 0.5); break;
      case 'h': case 'H': this.toggleContour(); break;
      case 'u': case 'U': this.toggleUncertainty(); break;
      case 'r': case 'R': this.fitToMask(); break;
      case '+': case '=': this.zoomBy(1.25); break;
      case '-': case '_': this.zoomBy(0.8); break;
      default: {
        const tool = Object.entries(TOOLS).find(([, v]) => v.key === e.key);
        if (tool) this.setTool(tool[0]);
      }
    }
  }
}

/** Standard toolbar bound to an editor. Returns the toolbar element. */
export function buildToolbar(container, ed, { showUncertaintyToggle = true } = {}) {
  container.classList.add('toolbar');
  const tools = Object.entries(TOOLS).filter(([id]) => !ed.readOnly || id === 'pan');
  container.innerHTML = `
    <div class="tb-group tb-tools">
      ${tools.map(([id, t]) => `<button data-tool="${id}" title="${t.label} (${t.key}) – ${t.hint}"><span class="ic">${t.icon}</span>${t.label}</button>`).join('')}
    </div>
    ${ed.readOnly ? '' : `
    <div class="tb-group">
      <label class="tb-brush" title="Brush radius ([ and ] keys)">Brush <input type="range" min="1" max="15" step="0.5" value="${ed.brushMm}"> <span class="tb-brush-val"></span></label>
    </div>
    <div class="tb-group">
      <button data-act="undo" title="Undo (Ctrl+Z)">↶ Undo</button>
      <button data-act="redo" title="Redo (Ctrl+Y)">↷ Redo</button>
    </div>
    <div class="tb-group">
      <button data-act="copyBelow" title="Replace this slice with the slice below">Copy ↓</button>
      <button data-act="copyAbove" title="Replace this slice with the slice above">Copy ↑</button>
      <button data-act="clear" title="Clear the contour on this slice">Clear slice</button>
    </div>`}
    <div class="tb-group">
      <select data-act="window" title="Window / level (right-drag on the image to adjust)">
        ${WINDOW_PRESETS.map((w) => `<option value="${w.id}">${w.name}</option>`).join('')}
        <option value="custom" hidden>Custom</option>
      </select>
      <button data-act="contour" title="Show/hide contour (H)">Contour</button>
      ${showUncertaintyToggle && ed.display && ed.display.id !== 'none' ? '<button data-act="unc" title="Show/hide uncertainty (U)">Uncertainty</button>' : ''}
    </div>
    <div class="tb-group">
      <button data-act="zoomOut" title="Zoom out (− key, Ctrl+scroll, pinch)">−</button>
      <span class="tb-zoom" title="Zoom">Zoom</span>
      <button data-act="zoomIn" title="Zoom in (+ key, Ctrl+scroll, pinch)">+</button>
      <button data-act="fit" title="Reset view (R)">Reset view</button>
    </div>`;
  container.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tool) ed.setTool(b.dataset.tool);
    const a = b.dataset.act;
    if (a === 'undo') ed.undo();
    if (a === 'redo') ed.redo();
    if (a === 'copyBelow') ed.copyFromSlice(-1);
    if (a === 'copyAbove') ed.copyFromSlice(1);
    if (a === 'clear') ed.clearSlice();
    if (a === 'contour') ed.toggleContour();
    if (a === 'unc') ed.toggleUncertainty();
    if (a === 'fit') { ed.fitToMask(); ed.onLog('reset_view', {}); }
    if (a === 'zoomIn') ed.zoomBy(1.25);
    if (a === 'zoomOut') ed.zoomBy(0.8);
    ed.canvas.focus({ preventScroll: true });
  });
  const range = container.querySelector('.tb-brush input');
  if (range) range.addEventListener('input', () => ed.setBrush(parseFloat(range.value)));
  const sel = container.querySelector('select[data-act=window]');
  sel.addEventListener('change', () => {
    const w = WINDOW_PRESETS.find((p) => p.id === sel.value);
    if (w) ed.setWindow(w.center, w.width);
    ed.canvas.focus({ preventScroll: true });
  });
  const update = () => {
    container.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === ed.tool));
    const v = container.querySelector('.tb-brush-val');
    if (v) v.textContent = `${ed.brushMm.toFixed(1)} mm`;
    if (range && parseFloat(range.value) !== ed.brushMm) range.value = ed.brushMm;
    const u = container.querySelector('[data-act=undo]');
    if (u) u.disabled = !ed.undoStack.length;
    const r = container.querySelector('[data-act=redo]');
    if (r) r.disabled = !ed.redoStack.length;
    container.querySelector('[data-act=contour]').classList.toggle('off', !ed.showContour);
    const uu = container.querySelector('[data-act=unc]');
    if (uu) uu.classList.toggle('off', !ed.showUncertainty);
    const preset = WINDOW_PRESETS.find((p) => p.center === ed.win.center && p.width === ed.win.width);
    sel.value = preset ? preset.id : 'custom';
  };
  ed.uiListener = update;
  update();
  return container;
}

/** Slice slider bound to an editor. */
export function buildSliceSlider(container, ed) {
  container.classList.add('slice-slider');
  container.innerHTML = `<span>Inf</span><input type="range" min="0" max="${ed.grid.nz - 1}" step="1" value="${ed.k}"><span>Sup</span>`;
  const r = container.querySelector('input');
  r.addEventListener('input', () => ed.setSlice(parseInt(r.value, 10), 'slider'));
  const prev = ed.onSlice;
  ed.onSlice = (k) => { r.value = k; prev(k); };
  return container;
}
