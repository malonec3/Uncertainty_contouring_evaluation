// Voxel grids, CT volume assembly, contour rasterisation and cropping.
//
// A grid is { nx, ny, nz, dx, dy, dz, origin:[3], row:[3], col:[3], normal:[3], slicePos:[nz] }
//   voxel (i, j, k) centre in patient mm = origin + i*dx*row + j*dy*col + (slicePos[k]-slicePos[0])*normal
//   i = column index (x on screen), j = row index (y on screen), k = slice index.
// Volumes are stored as flat typed arrays, index = k*nx*ny + j*nx + i.

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

export function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Group image slices by series and return [{seriesUID, description, slices, ...}] sorted by size. */
export function groupSeries(slices) {
  const map = new Map();
  for (const s of slices) {
    if (!map.has(s.seriesUID)) map.set(s.seriesUID, { seriesUID: s.seriesUID, description: s.seriesDescription, modality: s.modality, forUID: s.forUID, slices: [] });
    map.get(s.seriesUID).slices.push(s);
  }
  return [...map.values()].sort((a, b) => b.slices.length - a.slices.length);
}

/** Assemble a CT volume from slices of one series. */
export function buildVolume(slices) {
  if (!slices.length) throw new Error('No image slices');
  const s0 = slices[0];
  const iop = s0.iop;
  if (!iop || iop.length !== 6) throw new Error('Missing ImageOrientationPatient');
  const row = iop.slice(0, 3), col = iop.slice(3, 6);
  const normal = cross(row, col);
  const warnings = [];
  for (const s of slices) {
    if (s.rows !== s0.rows || s.cols !== s0.cols) throw new Error('Slices have different matrix sizes');
    if (s.iop.some((v, i) => Math.abs(v - iop[i]) > 1e-3)) throw new Error('Slices have different orientations (tilted/mixed series?)');
  }
  const sorted = [...slices].sort((a, b) => dot(a.ipp, normal) - dot(b.ipp, normal));
  // drop exact duplicates (same position)
  const uniq = [];
  for (const s of sorted) {
    if (uniq.length && Math.abs(dot(s.ipp, normal) - dot(uniq[uniq.length - 1].ipp, normal)) < 1e-3) {
      warnings.push(`Duplicate slice position ${dot(s.ipp, normal).toFixed(2)} ignored`);
      continue;
    }
    uniq.push(s);
  }
  const slicePos = uniq.map((s) => dot(s.ipp, normal));
  const gaps = slicePos.slice(1).map((p, i) => p - slicePos[i]);
  const dz = gaps.length ? median(gaps) : (s0.sliceThickness || 1);
  if (gaps.some((g) => Math.abs(g - dz) > 0.01 * dz + 1e-3)) warnings.push('Non-uniform slice spacing detected; metrics use the median spacing in z.');
  // in-plane alignment check
  for (const s of uniq) {
    const d = sub(s.ipp, uniq[0].ipp);
    if (Math.abs(dot(d, row)) > 0.05 || Math.abs(dot(d, col)) > 0.05) { warnings.push('Slice origins are not aligned in-plane (gantry tilt?).'); break; }
  }
  const nx = s0.cols, ny = s0.rows, nz = uniq.length;
  const data = new Int16Array(nx * ny * nz);
  uniq.forEach((s, k) => data.set(s.hu, k * nx * ny));
  const ps = s0.pixelSpacing; // [row spacing, column spacing]
  return {
    grid: { nx, ny, nz, dx: ps[1], dy: ps[0], dz, origin: [...uniq[0].ipp], row, col, normal, slicePos },
    data,
    sliceUIDs: uniq.map((s) => s.sopUID),
    seriesUID: s0.seriesUID, studyUID: s0.studyUID, forUID: s0.forUID,
    window: s0.window, warnings,
  };
}

/** Patient coordinate (mm) -> continuous voxel coordinates {u, v, w} (w = slice index, float). */
export function patientToVoxel(grid, p) {
  const s = dot(p, grid.normal);
  const w = (s - grid.slicePos[0]) / grid.dz;
  const k = Math.max(0, Math.min(grid.nz - 1, Math.round(w)));
  const ipp = slicePosition(grid, k);
  const d = sub(p, ipp);
  return { u: dot(d, grid.row) / grid.dx, v: dot(d, grid.col) / grid.dy, w, k, sliceDist: s - grid.slicePos[k] };
}

/** Patient position of voxel (0,0,k). */
export function slicePosition(grid, k) {
  const t = grid.slicePos[k] - grid.slicePos[0];
  return [grid.origin[0] + t * grid.normal[0], grid.origin[1] + t * grid.normal[1], grid.origin[2] + t * grid.normal[2]];
}

export function voxelToPatient(grid, u, v, k) {
  const o = slicePosition(grid, k);
  return [
    o[0] + u * grid.dx * grid.row[0] + v * grid.dy * grid.col[0],
    o[1] + u * grid.dx * grid.row[1] + v * grid.dy * grid.col[1],
    o[2] + u * grid.dx * grid.row[2] + v * grid.dy * grid.col[2],
  ];
}

/**
 * Even-odd polygon fill (toggle) on one slice. Pixel (i,j) is inside if its centre is inside.
 * xs, ys are continuous pixel coordinates. Toggling gives XOR composition of multiple polygons,
 * which is how holes in RTSTRUCT are represented.
 */
export function fillPolygonToggle(mask, offset, nx, ny, xs, ys) {
  const n = xs.length;
  if (n < 3) return;
  let minY = Infinity, maxY = -Infinity;
  for (let q = 0; q < n; q++) { if (ys[q] < minY) minY = ys[q]; if (ys[q] > maxY) maxY = ys[q]; }
  const j0 = Math.max(0, Math.ceil(minY)), j1 = Math.min(ny - 1, Math.floor(maxY));
  const xsect = [];
  for (let j = j0; j <= j1; j++) {
    xsect.length = 0;
    for (let a = 0, b = n - 1; a < n; b = a++) {
      const ya = ys[a], yb = ys[b];
      if ((ya <= j && yb > j) || (yb <= j && ya > j)) {
        xsect.push(xs[a] + ((j - ya) * (xs[b] - xs[a])) / (yb - ya));
      }
    }
    xsect.sort((p, q) => p - q);
    const rowOff = offset + j * nx;
    for (let t = 0; t + 1 < xsect.length; t += 2) {
      const i0 = Math.max(0, Math.ceil(xsect[t]));
      const i1 = Math.min(nx - 1, Math.ceil(xsect[t + 1]) - 1);
      for (let i = i0; i <= i1; i++) mask[rowOff + i] ^= 1;
    }
  }
}

/** Fill polygon with a fixed value (set=1 or clear=0) instead of toggling. */
export function fillPolygonSet(mask, offset, nx, ny, xs, ys, value) {
  const tmp = new Uint8Array(nx * ny);
  fillPolygonToggle(tmp, 0, nx, ny, xs, ys);
  for (let q = 0; q < nx * ny; q++) if (tmp[q]) mask[offset + q] = value;
}

/** Contours of an ROI in voxel coordinates: [{k, xs, ys}] (contours off-grid are dropped). */
export function roiToVoxelContours(roi, grid, tolMm = null) {
  const tol = tolMm ?? grid.dz * 0.5;
  const out = [];
  let skipped = 0;
  for (const c of roi.contours) {
    if (c.type !== 'CLOSED_PLANAR' && c.type !== 'OPEN_NONPLANAR' && c.type !== 'OPEN_PLANAR') continue;
    const P = c.points;
    const np = P.length / 3;
    if (np < 3) continue;
    const first = patientToVoxel(grid, [P[0], P[1], P[2]]);
    if (Math.abs(first.sliceDist) > tol || first.w < -0.5 || first.w > grid.nz - 0.5) { skipped++; continue; }
    const k = first.k;
    const ipp = slicePosition(grid, k);
    const xs = new Float64Array(np), ys = new Float64Array(np);
    for (let q = 0; q < np; q++) {
      const d = [P[3 * q] - ipp[0], P[3 * q + 1] - ipp[1], P[3 * q + 2] - ipp[2]];
      xs[q] = dot(d, grid.row) / grid.dx;
      ys[q] = dot(d, grid.col) / grid.dy;
    }
    out.push({ k, xs, ys });
  }
  return { contours: out, skipped };
}

/** Rasterise an ROI onto a grid. Returns Uint8Array mask (0/1). */
export function rasterizeROI(roi, grid) {
  const { nx, ny, nz } = grid;
  const mask = new Uint8Array(nx * ny * nz);
  const { contours, skipped } = roiToVoxelContours(roi, grid);
  for (const c of contours) fillPolygonToggle(mask, c.k * nx * ny, nx, ny, c.xs, c.ys);
  return { mask, skipped, used: contours.length };
}

/** Bounding box (voxel index space) of ROI contours: {i0,i1,j0,j1,k0,k1} or null */
export function roiBBox(roi, grid) {
  const { contours } = roiToVoxelContours(roi, grid);
  if (!contours.length) return null;
  const b = { i0: Infinity, i1: -Infinity, j0: Infinity, j1: -Infinity, k0: Infinity, k1: -Infinity };
  for (const c of contours) {
    for (let q = 0; q < c.xs.length; q++) {
      b.i0 = Math.min(b.i0, c.xs[q]); b.i1 = Math.max(b.i1, c.xs[q]);
      b.j0 = Math.min(b.j0, c.ys[q]); b.j1 = Math.max(b.j1, c.ys[q]);
    }
    b.k0 = Math.min(b.k0, c.k); b.k1 = Math.max(b.k1, c.k);
  }
  return b;
}

export function unionBBox(a, b) {
  if (!a) return b; if (!b) return a;
  return { i0: Math.min(a.i0, b.i0), i1: Math.max(a.i1, b.i1), j0: Math.min(a.j0, b.j0), j1: Math.max(a.j1, b.j1), k0: Math.min(a.k0, b.k0), k1: Math.max(a.k1, b.k1) };
}

/** Integer crop box from a bbox with margins in mm (in-plane) and slices. */
export function cropBox(grid, bbox, marginMm, marginSlices) {
  const mi = Math.ceil(marginMm / grid.dx), mj = Math.ceil(marginMm / grid.dy);
  return {
    i0: Math.max(0, Math.floor(bbox.i0) - mi), i1: Math.min(grid.nx - 1, Math.ceil(bbox.i1) + mi),
    j0: Math.max(0, Math.floor(bbox.j0) - mj), j1: Math.min(grid.ny - 1, Math.ceil(bbox.j1) + mj),
    k0: Math.max(0, bbox.k0 - marginSlices), k1: Math.min(grid.nz - 1, bbox.k1 + marginSlices),
  };
}

/** Sub-grid for a crop box. */
export function cropGrid(grid, box) {
  const o = voxelToPatient(grid, box.i0, box.j0, box.k0);
  return {
    nx: box.i1 - box.i0 + 1, ny: box.j1 - box.j0 + 1, nz: box.k1 - box.k0 + 1,
    dx: grid.dx, dy: grid.dy, dz: grid.dz, origin: o, row: [...grid.row], col: [...grid.col], normal: [...grid.normal],
    slicePos: grid.slicePos.slice(box.k0, box.k1 + 1),
  };
}

export function cropData(data, grid, box, Ctor = data.constructor) {
  const nx = box.i1 - box.i0 + 1, ny = box.j1 - box.j0 + 1, nz = box.k1 - box.k0 + 1;
  const out = new Ctor(nx * ny * nz);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      const src = (box.k0 + k) * grid.nx * grid.ny + (box.j0 + j) * grid.nx + box.i0;
      out.set(data.subarray(src, src + nx), k * nx * ny + j * nx);
    }
  }
  return out;
}

export function maskVolumeCC(mask, grid) {
  let n = 0;
  for (let q = 0; q < mask.length; q++) n += mask[q];
  return (n * grid.dx * grid.dy * grid.dz) / 1000;
}

/** Slices (k) that contain any voxel of mask. */
export function maskSliceRange(mask, grid) {
  const per = grid.nx * grid.ny;
  let k0 = -1, k1 = -1;
  for (let k = 0; k < grid.nz; k++) {
    const off = k * per;
    for (let q = 0; q < per; q++) if (mask[off + q]) { if (k0 < 0) k0 = k; k1 = k; break; }
  }
  return k0 < 0 ? null : [k0, k1];
}
