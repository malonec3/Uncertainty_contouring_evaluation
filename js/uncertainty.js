// Uncertainty proxy derived from the population of student contours vs the reference.
//
// ADMIN SIDE (has the reference):
//   p(x) = fraction of pool contours that disagree with the reference at voxel x.
//   For every point of a displayed contour, E (mm) = integral of p along the contour normal = the mean
//   absolute distance between the pool boundaries and the reference boundary there ("how far off contours
//   typically are here"). E is computed once per displayed contour and shipped to participants as numbers
//   attached to that contour, together with the per-slice certainty (mean ± SD of the pool's 2-D Dice).
//
// PARTICIPANT SIDE (never has the reference): AnchoredUncertainty rebuilds every display from the
// displayed contour + its E values. The true boundary is modelled along each normal as
// Normal(displayed boundary, sigma = E*sqrt(pi/2)), so the heat map shows phat(x) = 1 - Phi(|d|/sigma)
// (probability that the voxel's label is wrong) and the band is {phat >= threshold}.
// Nothing in the participant's data reveals where the reference boundary is.
//
// Two further quantities, also from all pool contours:
//   A (0..1) at each displayed contour point = share of pool contours whose boundary lies within 2 mm
//            (in-plane) of the reference boundary at that location (the local surface-Dice idea);
//            red/green colours the contour red where A < threshold (default 0.5: most contours disagree).
//   overall  = mean surface Dice at 2 mm of the pool contours vs the reference: one number per structure.

import { sliceDice, edtSquared, computeMetrics } from './metrics.js';
import { isolines, maskSliceContours, sliceBBox } from './contour.js';

const SAMPLE_MM = 0.5;      // spacing of samples along the contour
const SMOOTH_MM = 2;        // smoothing of E along the contour (+-)
const NORMAL_RANGE_MM = 10; // how far along the normal p is integrated
const MAX_DIST_MM = 10;     // red/green: further than this from the original contour = no information
const REACH_MM = 16;        // heat map / band drawn up to this distance from the contour
export const AGREE_TOL_MM = 2;  // red/green and overall certainty: agreement within 2 mm (surface-Dice tolerance)

// ------------------------------------------------------------------ shared helpers
export function normCdf(z) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

function bilinear(f, nx, ny, x, y) {
  if (x < 0 || y < 0 || x > nx - 1 || y > ny - 1) return 0;
  const i0 = Math.floor(x), j0 = Math.floor(y);
  const i1 = Math.min(nx - 1, i0 + 1), j1 = Math.min(ny - 1, j0 + 1);
  const fx = x - i0, fy = y - j0;
  return (f[j0 * nx + i0] * (1 - fx) + f[j0 * nx + i1] * fx) * (1 - fy) + (f[j1 * nx + i0] * (1 - fx) + f[j1 * nx + i1] * fx) * fy;
}

function meanSD(values) {
  const n = values.length;
  if (!n) return { mean: NaN, sd: NaN };
  let s = 0;
  for (const v of values) s += v;
  const mean = s / n;
  let ss = 0;
  for (const v of values) ss += (v - mean) * (v - mean);
  return { mean, sd: n > 1 ? Math.sqrt(ss / (n - 1)) : 0 };
}

/**
 * Deterministic sample points along the contour(s) of `mask` on slice k, ~0.5 mm apart, each with a
 * unit normal in mm space. The same code runs on the admin and participant side, so E values can be
 * shipped as a bare list in this order.
 */
export function contourSamplePoints(mask, grid, k) {
  const { dx, dy } = grid;
  const bb = sliceBBox(mask, grid, k);
  const out = [];
  if (!bb) return out;
  for (const line of maskSliceContours(mask, grid, k, bb)) {
    const n = line.length / 2;
    const pts = [];
    for (let q = 0; q < n; q++) {
      const a = 2 * q, b = 2 * ((q + 1) % n);
      const segLen = Math.hypot((line[b] - line[a]) * dx, (line[b + 1] - line[a + 1]) * dy);
      const m = Math.max(1, Math.round(segLen / SAMPLE_MM));
      for (let s = 0; s < m; s++) pts.push([line[a] + ((line[b] - line[a]) * s) / m, line[a + 1] + ((line[b + 1] - line[a + 1]) * s) / m]);
    }
    const m = pts.length;
    const start = out.length;
    for (let q = 0; q < m; q++) {
      const A = pts[(q - 3 + m) % m], B = pts[(q + 3) % m];
      let tx = (B[0] - A[0]) * dx, ty = (B[1] - A[1]) * dy;
      const L = Math.hypot(tx, ty) || 1;
      tx /= L; ty /= L;
      out.push({ x: pts[q][0], y: pts[q][1], nx: -ty, ny: tx, line: start, len: m });
    }
  }
  return out;
}

// ------------------------------------------------------------------ admin side
export class UncertaintyModel {
  /** gt: reference mask; students: masks of the uncertainty pool. */
  constructor(gt, students, grid) {
    this.grid = grid;
    this.gt = gt;
    this.students = students;
    this.N = students.length;
    const n = gt.length;
    this.errCount = new Uint16Array(n);
    this.dsc3d = new Float32Array(this.N);
    this.sliceDsc = [];
    students.forEach((s, idx) => {
      let a = 0, b = 0, ab = 0;
      for (let q = 0; q < n; q++) {
        const sv = s[q], gv = gt[q];
        if (sv !== gv) this.errCount[q]++;
        a += sv; b += gv; ab += sv & gv;
      }
      this.dsc3d[idx] = a + b === 0 ? 1 : (2 * ab) / (a + b);
      this.sliceDsc.push(sliceDice(s, gt, grid));
    });
    this._agreement();
  }

  /** Local 2 mm agreement of every pool contour at every reference boundary pixel, and overall surface Dice. */
  _agreement() {
    const g = this.grid, { nx, ny, nz, dx, dy } = g, per = nx * ny, tol = AGREE_TOL_MM;
    const isB = (M, off, q) => {
      if (!M[off + q]) return false;
      const i = q % nx, j = (q / nx) | 0;
      return i === 0 || j === 0 || i === nx - 1 || j === ny - 1 || !M[off + q - 1] || !M[off + q + 1] || !M[off + q - nx] || !M[off + q + nx];
    };
    const gtB = [], gtSlice = [];
    this.gtBySlice = Array.from({ length: nz }, () => []);
    for (let k = 0; k < nz; k++) {
      const off = k * per;
      for (let q = 0; q < per; q++) if (isB(this.gt, off, q)) { this.gtBySlice[k].push(gtB.length); gtB.push(q); gtSlice.push(k); }
    }
    this.gtB = Int32Array.from(gtB);
    this.gtSlice = Int32Array.from(gtSlice);
    const nB = gtB.length;
    this.agreeMat = new Uint8Array(this.N * nB);
    this.agreeCount = new Uint16Array(nB);
    const dist = new Float64Array(per);
    this.students.forEach((s, idx) => {
      for (let k = 0; k < nz; k++) {
        const list = this.gtBySlice[k];
        if (!list.length) continue;
        const off = k * per;
        let any = false;
        for (let q = 0; q < per; q++) { const b = isB(s, off, q); dist[q] = b ? 0 : 1e20; any = any || b; }
        if (!any) continue;
        edtSquared(dist, nx, ny, 1, dx, dy, 1);
        for (const bi of list) if (dist[gtB[bi]] <= tol * tol + 1e-6) { this.agreeMat[idx * nB + bi] = 1; this.agreeCount[bi]++; }
      }
    });
    this.sdsc = Float32Array.from(this.students, (s) => computeMetrics(s, this.gt, g, { sdscTolerances: [tol], aplTolerances: [] }).sdsc[tol]);
  }

  /** p field, optionally leaving out pool member `loo` (index into the pool, or -1). */
  pField(loo = -1) {
    const n = this.gt.length;
    const shown = loo >= 0 ? this.students[loo] : null;
    const denom = shown && this.N > 1 ? this.N - 1 : this.N;
    const p = new Float32Array(n);
    for (let q = 0; q < n; q++) {
      let c = this.errCount[q];
      if (shown && this.N > 1 && shown[q] !== this.gt[q]) c--;
      p[q] = c / denom;
    }
    return p;
  }

  /** Per-slice and whole-structure certainty (mean ± SD of Dice over the pool). */
  certainty(loo = -1) {
    const idx = [...Array(this.N).keys()].filter((i) => !(loo >= 0 && this.N > 1 && i === loo));
    const nz = this.grid.nz;
    const out = new Float32Array(2 * nz + 2);
    for (let k = 0; k < nz; k++) {
      const r = meanSD(idx.map((i) => this.sliceDsc[i][k]));
      out[k] = r.mean; out[nz + k] = r.sd;
    }
    const o = meanSD(idx.map((i) => this.dsc3d[i]));
    out[2 * nz] = o.mean; out[2 * nz + 1] = o.sd;
    return out;
  }

  /**
   * Everything a participant needs for one displayed contour: E per contour sample (rounded to
   * 0.01 mm, exactly as shipped) and the certainty array.
   * poolIndex: index of this contour in the pool (-1 if it is not in the pool); loo: leave it out.
   */
  forContour(mask, poolIndex, leaveOneOut) {
    const loo = leaveOneOut ? poolIndex : -1;
    const p = this.pField(loo);
    const g = this.grid, per = g.nx * g.ny;
    const counts = new Uint32Array(g.nz);
    const vals = [];
    const step = 0.5, eps = 0.02;
    for (let k = 0; k < g.nz; k++) {
      const samples = contourSamplePoints(mask, g, k);
      counts[k] = samples.length;
      if (!samples.length) continue;
      const src = p.subarray(k * per, (k + 1) * per);
      const raw = samples.map((s) => {
        const v0 = bilinear(src, g.nx, g.ny, s.x, s.y);
        let total = v0 * step;
        for (const dir of [1, -1]) {
          let started = v0 > eps, quiet = 0;
          for (let t = step; t <= NORMAL_RANGE_MM; t += step) {
            const v = bilinear(src, g.nx, g.ny, s.x + (dir * t * s.nx) / g.dx, s.y + (dir * t * s.ny) / g.dy);
            if (v > eps) { started = true; quiet = 0; total += v * step; } else if (started) { quiet += step; if (quiet >= 1.5) break; }
          }
        }
        return total;
      });
      const w = Math.round(SMOOTH_MM / SAMPLE_MM);
      samples.forEach((s, q) => {
        const base = s.line, m = s.len, local = q - base;
        let sum = 0;
        for (let o = -w; o <= w; o++) sum += raw[base + ((local + o + m) % m)];
        vals.push(Math.round((sum / (2 * w + 1)) * 100) / 100);
      });
    }
    // local 2 mm agreement at every sample (nearest reference boundary pixel on the same slice)
    const nB = this.gtB.length;
    const denom = loo >= 0 && this.N > 1 ? this.N - 1 : this.N;
    const agree = [];
    for (let k = 0; k < g.nz; k++) {
      const samples = contourSamplePoints(mask, g, k);
      if (!samples.length) continue;
      const list = this.gtBySlice[k];
      const raw = samples.map((sp) => {
        if (!list.length) return 1 - bilinear(p.subarray(k * per, (k + 1) * per), g.nx, g.ny, sp.x, sp.y);
        let best = Infinity, bb = -1;
        for (const bi of list) {
          const q = this.gtB[bi];
          const ddx = ((q % g.nx) - sp.x) * g.dx, ddy = (((q / g.nx) | 0) - sp.y) * g.dy;
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 < best) { best = d2; bb = bi; }
        }
        let c = this.agreeCount[bb];
        if (loo >= 0 && this.N > 1) c -= this.agreeMat[loo * nB + bb];
        return c / denom;
      });
      const w = Math.round(1 / SAMPLE_MM);
      samples.forEach((sp, q) => {
        const base = sp.line, m = sp.len, local = q - base;
        let sum = 0;
        for (let o = -w; o <= w; o++) sum += raw[base + ((local + o + m) % m)];
        agree.push(Math.round((sum / (2 * w + 1)) * 1000) / 1000);
      });
    }
    const idx = [...Array(this.N).keys()].filter((i) => !(loo >= 0 && this.N > 1 && i === loo));
    const o = meanSD(idx.map((i) => this.sdsc[i]));
    return {
      counts, values: Float32Array.from(vals), certainty: this.certainty(loo), loo: loo >= 0, nPool: denom,
      agree: Float32Array.from(agree), overall2: Float32Array.from([o.mean, o.sd]),
    };
  }
}

// ------------------------------------------------------------------ both sides: what the displays use
export class AnchoredUncertainty {
  /**
   * @param grid
   * @param anchorMask  the displayed (unedited) contour
   * @param data        { counts (Uint32 nz), values (E per sample), agree (A per sample), certainty (Float32 2nz+2),
   *                      overall2 ([mean, SD] surface Dice 2 mm), loo, nPool }
   */
  constructor(grid, anchorMask, data) {
    this.grid = grid;
    this.anchorMask = anchorMask;
    this.data = data;
    this.heatScale = 2; // phat peaks at 0.5 on the contour
    const nz = grid.nz;
    const c = data.certainty;
    this.sliceMean = c.subarray(0, nz);
    this.sliceSD = c.subarray(nz, 2 * nz);
    this.overallMean = c[2 * nz];
    this.overallSD = c[2 * nz + 1];
    this.loo = !!data.loo;
    this.nContributors = data.nPool;
    this.hasAgreement = !!(data.agree && data.agree.length);
    this.overallSurface = data.overall2 ? data.overall2[0] : NaN;
    this.overallSurfaceSD = data.overall2 ? data.overall2[1] : NaN;
    this.offsets = new Uint32Array(nz + 1);
    for (let k = 0; k < nz; k++) this.offsets[k + 1] = this.offsets[k] + data.counts[k];
    this._cache = new Map();
    this.mismatch = false;
  }

  contourSamples(k) {
    const pts = contourSamplePoints(this.anchorMask, this.grid, k);
    const n = this.data.counts[k];
    if (pts.length !== n) { this.mismatch = true; return []; }
    const off = this.offsets[k];
    const ag = this.data.agree;
    return pts.map((p, i) => ({ x: p.x, y: p.y, E: this.data.values[off + i], A: ag && ag.length ? ag[off + i] : NaN }));
  }

  _slice(k) {
    if (this._cache.has(k)) return this._cache.get(k);
    const g = this.grid, { nx, ny, dx, dy } = g;
    const per = nx * ny;
    const E = new Float32Array(per).fill(NaN);
    const A = new Float32Array(per).fill(NaN);
    const phat = new Float32Array(per);
    const samples = this.contourSamples(k);
    if (samples.length) {
      const bb = sliceBBox(this.anchorMask, g, k);
      const ri = Math.ceil(REACH_MM / dx), rj = Math.ceil(REACH_MM / dy);
      const i0 = Math.max(0, bb.i0 - ri), i1 = Math.min(nx - 1, bb.i1 + ri), j0 = Math.max(0, bb.j0 - rj), j1 = Math.min(ny - 1, bb.j1 + rj);
      const sx = Float64Array.from(samples, (s) => s.x * dx), sy = Float64Array.from(samples, (s) => s.y * dy), sE = Float64Array.from(samples, (s) => s.E);
      const sA = Float64Array.from(samples, (s) => s.A);
      const ns = samples.length;
      for (let j = j0; j <= j1; j++) {
        const Y = j * dy;
        for (let i = i0; i <= i1; i++) {
          const X = i * dx;
          let best = Infinity, bi = 0;
          for (let s = 0; s < ns; s++) {
            const ddx = X - sx[s], ddy = Y - sy[s];
            const d2 = ddx * ddx + ddy * ddy;
            if (d2 < best) { best = d2; bi = s; }
          }
          const d = Math.sqrt(best);
          const q = j * nx + i;
          if (d <= MAX_DIST_MM) { E[q] = sE[bi]; A[q] = sA[bi]; }
          const sigma = Math.max(0.25, sE[bi] * Math.sqrt(Math.PI / 2));
          if (d <= REACH_MM) phat[q] = 1 - normCdf(d / sigma);
        }
      }
    }
    const res = { E, A, phat };
    if (this._cache.size > 80) this._cache.clear();
    this._cache.set(k, res);
    return res;
  }

  /** Field drawn by the heat map / band (probability that a voxel's label is wrong). */
  pSlice(k) { return this._slice(k).phat; }

  /** Local expected boundary error (mm) near the displayed contour; NaN = no displayed contour nearby. */
  localErrorSlice(k) { return this._slice(k).E; }

  /** Share of pool contours agreeing within 2 mm near (x, y) on slice k (NaN if > 10 mm from the displayed contour). */
  sampleAgreement(k, x, y) { return this._sampleField(this._slice(k).A, x, y); }

  /** E at continuous pixel coords (x, y) on slice k (NaN if > 10 mm from the displayed contour). */
  sampleLocal(k, x, y) { return this._sampleField(this._slice(k).E, x, y); }

  _sampleField(f, x, y) {
    const { nx, ny } = this.grid;
    const i = Math.round(x), j = Math.round(y);
    if (i < 0 || j < 0 || i >= nx || j >= ny) return NaN;
    const i0 = Math.max(0, Math.min(nx - 2, Math.floor(x))), j0 = Math.max(0, Math.min(ny - 2, Math.floor(y)));
    const v = [f[j0 * nx + i0], f[j0 * nx + i0 + 1], f[(j0 + 1) * nx + i0], f[(j0 + 1) * nx + i0 + 1]];
    if (v.some((t) => Number.isNaN(t))) return f[j * nx + i];
    const fx = Math.max(0, Math.min(1, x - i0)), fy = Math.max(0, Math.min(1, y - j0));
    return (v[0] * (1 - fx) + v[1] * fx) * (1 - fy) + (v[2] * (1 - fx) + v[3] * fx) * fy;
  }

  isolinesAt(k, level) {
    const s = this.pSlice(k);
    const { nx, ny } = this.grid;
    let i0 = nx, i1 = -1, j0 = ny, j1 = -1;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      if (s[j * nx + i] >= level) { if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j; }
    }
    if (i1 < 0) return [];
    return isolines((i, j) => s[j * nx + i], nx, ny, level, { i0, i1, j0, j1 });
  }
}

// ------------------------------------------------------------------ admin side: informativeness
/**
 * How well E tracks the actual error of the displayed contour (needs the reference).
 * True error at each contour sample = in-plane distance (mm) to the nearest reference boundary pixel
 * on the same slice (40 mm if the reference is empty there).
 * Returns { auc, n, frac_error, mean_E }; auc = P(E at an erroneous point > E at a correct point),
 * erroneous = true error > errMm. 0.5 = uninformative for this contour, 1 = perfect.
 */
export function uncertaintyErrorAgreement(au, gt, grid, { errMm = 2 } = {}) {
  const { nx, ny, nz, dx, dy } = grid;
  const per = nx * ny;
  const err = [], unc = [];
  const dist = new Float64Array(per);
  for (let k = 0; k < nz; k++) {
    const samples = au.contourSamples(k);
    if (!samples.length) continue;
    const off = k * per;
    let gAny = false;
    for (let q = 0; q < per; q++) {
      const i = q % nx, j = (q / nx) | 0;
      const b = gt[off + q] && (i === 0 || j === 0 || i === nx - 1 || j === ny - 1 || !gt[off + q - 1] || !gt[off + q + 1] || !gt[off + q - nx] || !gt[off + q + nx]);
      dist[q] = b ? 0 : 1e20;
      if (b) gAny = true;
    }
    if (gAny) edtSquared(dist, nx, ny, 1, dx, dy, 1);
    for (const s of samples) {
      err.push(gAny ? Math.sqrt(bilinear(dist, nx, ny, s.x, s.y)) : 40);
      unc.push(s.E);
    }
  }
  const pos = [], neg = [];
  err.forEach((e, i) => (e > errMm ? pos : neg).push(unc[i]));
  let auc = null;
  if (pos.length && neg.length) {
    const all = pos.map((v) => [v, 1]).concat(neg.map((v) => [v, 0])).sort((a, b) => a[0] - b[0]);
    let rankSumPos = 0;
    for (let i = 0; i < all.length;) {
      let j = i;
      while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++;
      const r = (i + j) / 2 + 1;
      for (let t = i; t <= j; t++) if (all[t][1]) rankSumPos += r;
      i = j + 1;
    }
    auc = (rankSumPos - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
  }
  const meanE = unc.length ? unc.reduce((a, b) => a + b, 0) / unc.length : null;
  return { auc, n: err.length, frac_error: err.length ? pos.length / err.length : null, mean_E: meanE };
}
