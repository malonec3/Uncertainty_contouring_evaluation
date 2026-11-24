// Geometric agreement metrics between binary masks on the same grid.
//
// Definitions (chosen to be reproducible with scipy / MedPy, see analysis/recompute_metrics.py):
//  * DSC      = 2|A∩B| / (|A|+|B|)  (1 if both empty)
//  * Surface  = voxels of the mask with at least one 6-neighbour outside the mask
//               (voxels on the grid edge count as surface) - MedPy convention.
//  * d(a,∂B)  = exact Euclidean distance (mm, anisotropic spacing) from surface-voxel centre a
//               to the nearest surface-voxel centre of B.
//  * HD       = max of both directed maxima.     HD95 = 95th percentile of the pooled
//               distances of both directions (MedPy hd95, numpy linear interpolation).
//  * MSD      = average symmetric surface distance = (mean d(∂A,∂B) + mean d(∂B,∂A)) / 2.
//  * sDSC@τ   = (#{a∈∂A: d(a,∂B)≤τ} + #{b∈∂B: d(b,∂A)≤τ}) / (|∂A|+|∂B|)  (Nikolov et al., voxel-count form)
//  * APL@τ    = Added path length (Vaassen et al. 2020): per axial slice, number of 2-D boundary
//               pixels (4-connectivity) of the REFERENCE that are further than τ from the 2-D
//               boundary of the TEST, times the in-plane pixel size; summed over slices (mm).

const INF = 1e20;

/** 1-D squared Euclidean distance transform (Felzenszwalb & Huttenlocher) with weight w=spacing^2. */
function edt1d(f, n, w, out, v, z) {
  let k = -1;
  for (let q = 0; q < n; q++) {
    if (f[q] >= INF) continue;
    if (k < 0) { k = 0; v[0] = q; z[0] = -Infinity; z[1] = Infinity; continue; }
    let s;
    for (;;) {
      const p = v[k];
      s = ((f[q] + w * q * q) - (f[p] + w * p * p)) / (2 * w * (q - p));
      if (s <= z[k]) k--; else break;
    }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  if (k < 0) { for (let q = 0; q < n; q++) out[q] = INF; return; }
  let j = 0;
  for (let q = 0; q < n; q++) {
    while (z[j + 1] < q) j++;
    const d = q - v[j];
    out[q] = w * d * d + f[v[j]];
  }
}

/**
 * Squared EDT (mm^2) on a box, in place. vol: Float64Array nx*ny*nz with 0 at features, INF elsewhere.
 */
export function edtSquared(vol, nx, ny, nz, dx, dy, dz) {
  const m = Math.max(nx, ny, nz);
  const f = new Float64Array(m), out = new Float64Array(m), v = new Int32Array(m), z = new Float64Array(m + 1);
  // x
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
    const o = k * nx * ny + j * nx;
    for (let i = 0; i < nx; i++) f[i] = vol[o + i];
    edt1d(f, nx, dx * dx, out, v, z);
    for (let i = 0; i < nx; i++) vol[o + i] = out[i];
  }
  // y
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const o = k * nx * ny + i;
    for (let j = 0; j < ny; j++) f[j] = vol[o + j * nx];
    edt1d(f, ny, dy * dy, out, v, z);
    for (let j = 0; j < ny; j++) vol[o + j * nx] = out[j];
  }
  // z
  if (nz > 1) {
    const per = nx * ny;
    for (let q = 0; q < per; q++) {
      for (let k = 0; k < nz; k++) f[k] = vol[q + k * per];
      edt1d(f, nz, dz * dz, out, v, z);
      for (let k = 0; k < nz; k++) vol[q + k * per] = out[k];
    }
  }
  return vol;
}

/** Bounding box of (A or B) in voxel indices, or null. */
function bboxUnion(A, B, grid) {
  const { nx, ny, nz } = grid;
  let i0 = nx, i1 = -1, j0 = ny, j1 = -1, k0 = nz, k1 = -1;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      const r = k * nx * ny + j * nx;
      for (let i = 0; i < nx; i++) {
        if (A[r + i] || B[r + i]) {
          if (i < i0) i0 = i; if (i > i1) i1 = i;
          if (j < j0) j0 = j; if (j > j1) j1 = j;
          if (k < k0) k0 = k; if (k > k1) k1 = k;
        }
      }
    }
  }
  return i1 < 0 ? null : { i0, i1, j0, j1, k0, k1 };
}

/** 3-D surface (6-connectivity) of mask inside box; returns Uint8Array over the box. */
function surface3d(M, grid, b) {
  const { nx, ny, nz } = grid;
  const bx = b.i1 - b.i0 + 1, by = b.j1 - b.j0 + 1, bz = b.k1 - b.k0 + 1;
  const S = new Uint8Array(bx * by * bz);
  const per = nx * ny;
  for (let k = b.k0; k <= b.k1; k++) for (let j = b.j0; j <= b.j1; j++) for (let i = b.i0; i <= b.i1; i++) {
    const q = k * per + j * nx + i;
    if (!M[q]) continue;
    const edge = i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1;
    if (edge || !M[q - 1] || !M[q + 1] || !M[q - nx] || !M[q + nx] || !M[q - per] || !M[q + per]) {
      S[(k - b.k0) * bx * by + (j - b.j0) * bx + (i - b.i0)] = 1;
    }
  }
  return S;
}

function directedDistances(Sfrom, Sto, bx, by, bz, dx, dy, dz) {
  const n = bx * by * bz;
  const vol = new Float64Array(n);
  for (let q = 0; q < n; q++) vol[q] = Sto[q] ? 0 : INF;
  edtSquared(vol, bx, by, bz, dx, dy, dz);
  const d = [];
  for (let q = 0; q < n; q++) if (Sfrom[q]) d.push(Math.sqrt(vol[q]));
  return Float64Array.from(d);
}

export function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * p / 100;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** 2-D boundary (4-connectivity, slice edge counts as outside) of slice k inside box -> Uint8Array bx*by */
function boundary2d(M, grid, k, b) {
  const { nx, ny } = grid;
  const bx = b.i1 - b.i0 + 1, by = b.j1 - b.j0 + 1;
  const S = new Uint8Array(bx * by);
  const off = k * nx * ny;
  let count = 0;
  for (let j = b.j0; j <= b.j1; j++) for (let i = b.i0; i <= b.i1; i++) {
    const q = off + j * nx + i;
    if (!M[q]) continue;
    if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1 || !M[q - 1] || !M[q + 1] || !M[q - nx] || !M[q + nx]) {
      S[(j - b.j0) * bx + (i - b.i0)] = 1; count++;
    }
  }
  return { S, count };
}

/**
 * Added path length: reference boundary (2-D, per slice) not within `tolMm` of the test boundary.
 * Returns {mm: {tol: value}, pixels: {tol: count}}.
 */
export function addedPathLength(test, ref, grid, tolerances = [0, 1, 2, 3], box = null) {
  const b = box || bboxUnion(test, ref, grid);
  const res = { mm: {}, pixels: {} };
  for (const t of tolerances) { res.mm[t] = 0; res.pixels[t] = 0; }
  if (!b) return res;
  const pix = (grid.dx + grid.dy) / 2;
  const bx = b.i1 - b.i0 + 1, by = b.j1 - b.j0 + 1;
  const vol = new Float64Array(bx * by);
  for (let k = b.k0; k <= b.k1; k++) {
    const R = boundary2d(ref, grid, k, b);
    if (!R.count) continue;
    const T = boundary2d(test, grid, k, b);
    if (!T.count) {
      for (const t of tolerances) res.pixels[t] += R.count;
      continue;
    }
    for (let q = 0; q < vol.length; q++) vol[q] = T.S[q] ? 0 : INF;
    edtSquared(vol, bx, by, 1, grid.dx, grid.dy, 1);
    for (let q = 0; q < vol.length; q++) {
      if (!R.S[q]) continue;
      const d = Math.sqrt(vol[q]);
      for (const t of tolerances) if (d > t + 1e-6) res.pixels[t]++;
    }
  }
  for (const t of tolerances) res.mm[t] = res.pixels[t] * pix;
  return res;
}

/**
 * Full metric set. A = test (e.g. edited contour), B = reference (e.g. ground truth).
 */
export function computeMetrics(A, B, grid, opts = {}) {
  const tolerances = opts.sdscTolerances || [1, 2, 3];
  const aplTol = opts.aplTolerances || [0, 1, 2, 3];
  const { dx, dy, dz } = grid;
  const voxCC = (dx * dy * dz) / 1000;
  let nA = 0, nB = 0, nAB = 0;
  for (let q = 0; q < A.length; q++) { const a = A[q], b = B[q]; nA += a; nB += b; nAB += a & b; }
  const out = {
    dsc: nA + nB === 0 ? 1 : (2 * nAB) / (nA + nB),
    vol_test_cc: nA * voxCC, vol_ref_cc: nB * voxCC,
    sdsc: {}, hd: null, hd95: null, msd: null, msd_test_to_ref: null, msd_ref_to_test: null,
    apl_mm: {}, apl_px: {},
    empty_test: nA === 0, empty_ref: nB === 0,
  };
  const box = bboxUnion(A, B, grid);
  const apl = addedPathLength(A, B, grid, aplTol, box);
  out.apl_mm = apl.mm; out.apl_px = apl.pixels;
  if (nA === 0 || nB === 0) {
    for (const t of tolerances) out.sdsc[t] = nA + nB === 0 ? 1 : 0;
    return out;
  }
  const bx = box.i1 - box.i0 + 1, by = box.j1 - box.j0 + 1, bz = box.k1 - box.k0 + 1;
  const SA = surface3d(A, grid, box), SB = surface3d(B, grid, box);
  const dAB = directedDistances(SA, SB, bx, by, bz, dx, dy, dz);
  const dBA = directedDistances(SB, SA, bx, by, bz, dx, dy, dz);
  let maxAB = 0, maxBA = 0, sumAB = 0, sumBA = 0;
  for (const d of dAB) { if (d > maxAB) maxAB = d; sumAB += d; }
  for (const d of dBA) { if (d > maxBA) maxBA = d; sumBA += d; }
  out.hd = Math.max(maxAB, maxBA);
  const pooled = new Float64Array(dAB.length + dBA.length);
  pooled.set(dAB); pooled.set(dBA, dAB.length);
  pooled.sort();
  out.hd95 = percentile(pooled, 95);
  out.msd_test_to_ref = sumAB / dAB.length;
  out.msd_ref_to_test = sumBA / dBA.length;
  out.msd = (out.msd_test_to_ref + out.msd_ref_to_test) / 2;
  for (const t of tolerances) {
    let c = 0;
    for (const d of dAB) if (d <= t + 1e-6) c++;
    for (const d of dBA) if (d <= t + 1e-6) c++;
    out.sdsc[t] = c / (dAB.length + dBA.length);
  }
  out.n_surface_test = dAB.length;
  out.n_surface_ref = dBA.length;
  return out;
}

/** Per-slice 2-D DSC between A and B (both empty -> 1). Float32Array nz. */
export function sliceDice(A, B, grid) {
  const { nx, ny, nz } = grid;
  const per = nx * ny;
  const out = new Float32Array(nz);
  for (let k = 0; k < nz; k++) {
    let a = 0, b = 0, ab = 0;
    const o = k * per;
    for (let q = o; q < o + per; q++) { a += A[q]; b += B[q]; ab += A[q] & B[q]; }
    out[k] = a + b === 0 ? 1 : (2 * ab) / (a + b);
  }
  return out;
}

/** Round all numbers in a (nested) metrics object for storage. */
export function roundMetrics(m, digits = 5) {
  if (m === null || m === undefined) return m;
  if (typeof m === 'number') return Number.isFinite(m) ? Number(m.toFixed(digits)) : null;
  if (Array.isArray(m)) return m.map((x) => roundMetrics(x, digits));
  if (typeof m === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(m)) o[k] = roundMetrics(v, digits);
    return o;
  }
  return m;
}

/** Flatten the metric object to the column names used in the database. */
export function primaryColumns(m, aplTol = 1) {
  return {
    dsc: m.dsc, sdsc_1mm: m.sdsc[1] ?? null, sdsc_2mm: m.sdsc[2] ?? null, sdsc_3mm: m.sdsc[3] ?? null,
    hd_mm: m.hd, hd95_mm: m.hd95, msd_mm: m.msd, apl_mm: m.apl_mm[aplTol] ?? null,
  };
}
