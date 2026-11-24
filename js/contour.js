// Marching squares iso-lines on a 2-D slice of a scalar/binary field.
// Coordinates are continuous pixel indices (pixel centre (i,j) at x=i, y=j).
// Values outside the slice are treated as 0 so contours always close.

import { voxelToPatient } from './volume.js';

// segments per case: pairs of edges (0=top,1=right,2=bottom,3=left)
// bits: 1=TL, 2=TR, 4=BR, 8=BL
const SEG = [
  [], [[3, 0]], [[0, 1]], [[3, 1]], [[1, 2]], null, [[0, 2]], [[3, 2]],
  [[2, 3]], [[0, 2]], null, [[1, 2]], [[3, 1]], [[0, 1]], [[3, 0]], [],
];

/**
 * @param get   function (i, j) -> value, only called for 0<=i<nx, 0<=j<ny
 * @returns     array of closed polylines, each a Float32Array [x0,y0,x1,y1,...]
 */
export function isolines(get, nx, ny, level, bbox = null) {
  const W = nx + 2;
  const val = (i, j) => (i < 0 || j < 0 || i >= nx || j >= ny ? 0 : get(i, j));
  const ci0 = bbox ? Math.max(-1, bbox.i0 - 1) : -1, ci1 = bbox ? Math.min(nx - 1, bbox.i1 + 1) : nx - 1;
  const cj0 = bbox ? Math.max(-1, bbox.j0 - 1) : -1, cj1 = bbox ? Math.min(ny - 1, bbox.j1 + 1) : ny - 1;
  const pos = new Map();   // edgeId -> [x, y]
  const adj = new Map();   // edgeId -> [a, b]
  const link = (a, b) => {
    const la = adj.get(a); if (la) la.push(b); else adj.set(a, [b]);
    const lb = adj.get(b); if (lb) lb.push(a); else adj.set(b, [a]);
  };
  for (let j = cj0; j <= cj1; j++) {
    for (let i = ci0; i <= ci1; i++) {
      const tl = val(i, j), tr = val(i + 1, j), br = val(i + 1, j + 1), bl = val(i, j + 1);
      const c = (tl >= level ? 1 : 0) | (tr >= level ? 2 : 0) | (br >= level ? 4 : 0) | (bl >= level ? 8 : 0);
      if (c === 0 || c === 15) continue;
      let segs = SEG[c];
      if (segs === null) {
        const centre = (tl + tr + br + bl) / 4 >= level;
        if (c === 5) segs = centre ? [[3, 2], [0, 1]] : [[3, 0], [1, 2]];
        else segs = centre ? [[3, 0], [1, 2]] : [[0, 1], [2, 3]];
      }
      const I = i + 1, J = j + 1;
      const eid = [
        (J * W + I) * 2,           // top: h(i,j)
        (J * W + I + 1) * 2 + 1,   // right: v(i+1,j)
        ((J + 1) * W + I) * 2,     // bottom: h(i,j+1)
        (J * W + I) * 2 + 1,       // left: v(i,j)
      ];
      for (const [ea, eb] of segs) {
        for (const e of [ea, eb]) {
          const id = eid[e];
          if (pos.has(id)) continue;
          let x, y, a, b;
          if (e === 0) { a = tl; b = tr; x = i + (level - a) / (b - a); y = j; }
          else if (e === 2) { a = bl; b = br; x = i + (level - a) / (b - a); y = j + 1; }
          else if (e === 3) { a = tl; b = bl; x = i; y = j + (level - a) / (b - a); }
          else { a = tr; b = br; x = i + 1; y = j + (level - a) / (b - a); }
          pos.set(id, [x, y]);
        }
        link(eid[ea], eid[eb]);
      }
    }
  }
  const visited = new Set();
  const lines = [];
  for (const start of adj.keys()) {
    if (visited.has(start)) continue;
    const pts = [];
    let prev = -1, cur = start;
    while (cur !== undefined && !visited.has(cur)) {
      visited.add(cur);
      const p = pos.get(cur);
      pts.push(p[0], p[1]);
      const nb = adj.get(cur);
      let next;
      for (const n of nb) if (n !== prev && !visited.has(n)) { next = n; break; }
      prev = cur;
      cur = next;
    }
    if (pts.length >= 6) lines.push(Float32Array.from(pts));
  }
  return lines;
}

/** Contours of a binary mask slice k. */
export function maskSliceContours(mask, grid, k, bbox = null) {
  const { nx, ny } = grid;
  const off = k * nx * ny;
  return isolines((i, j) => mask[off + j * nx + i], nx, ny, 0.5, bbox);
}

/** Bounding box of foreground on slice k ({i0,i1,j0,j1}) or null. */
export function sliceBBox(mask, grid, k) {
  const { nx, ny } = grid;
  const off = k * nx * ny;
  let i0 = nx, i1 = -1, j0 = ny, j1 = -1;
  for (let j = 0; j < ny; j++) {
    const r = off + j * nx;
    for (let i = 0; i < nx; i++) {
      if (mask[r + i]) { if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j; }
    }
  }
  return i1 < 0 ? null : { i0, i1, j0, j1 };
}

/** Whole mask as RTSTRUCT-like contours in patient mm: [{k, z, points:[x,y,z,...]}] */
export function maskToPatientContours(mask, grid, decimals = 2) {
  const out = [];
  const f = 10 ** decimals;
  for (let k = 0; k < grid.nz; k++) {
    const bb = sliceBBox(mask, grid, k);
    if (!bb) continue;
    for (const line of maskSliceContours(mask, grid, k, bb)) {
      const pts = [];
      for (let q = 0; q < line.length; q += 2) {
        const p = voxelToPatient(grid, line[q], line[q + 1], k);
        pts.push(Math.round(p[0] * f) / f, Math.round(p[1] * f) / f, Math.round(p[2] * f) / f);
      }
      out.push({ k, points: pts });
    }
  }
  return out;
}

/** Chaikin corner cutting on a closed polyline (display only). */
export function smoothClosed(line, iterations = 2) {
  let cur = line;
  for (let it = 0; it < iterations; it++) {
    const n = cur.length / 2;
    if (n < 4) return cur;
    const out = new Float32Array(n * 4);
    for (let q = 0; q < n; q++) {
      const a = 2 * q, b = 2 * ((q + 1) % n);
      out[4 * q] = 0.75 * cur[a] + 0.25 * cur[b];
      out[4 * q + 1] = 0.75 * cur[a + 1] + 0.25 * cur[b + 1];
      out[4 * q + 2] = 0.25 * cur[a] + 0.75 * cur[b];
      out[4 * q + 3] = 0.25 * cur[a + 1] + 0.75 * cur[b + 1];
    }
    cur = out;
  }
  return cur;
}

/** Polyline length (in mm) helper. */
export function polylineLengthMm(line, dx, dy) {
  let L = 0;
  const n = line.length / 2;
  for (let q = 0; q < n; q++) {
    const a = q * 2, b = ((q + 1) % n) * 2;
    L += Math.hypot((line[b] - line[a]) * dx, (line[b + 1] - line[a + 1]) * dy);
  }
  return L;
}
