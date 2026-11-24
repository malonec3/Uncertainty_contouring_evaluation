// A small synthetic phantom used to practise the editing tools (no anatomy from the study case).

export function makePracticeCase() {
  const nx = 140, ny = 120, nz = 7, dx = 1, dy = 1, dz = 3;
  const grid = { nx, ny, nz, dx, dy, dz, origin: [0, 0, 0], row: [1, 0, 0], col: [0, 1, 0], normal: [0, 0, 1], slicePos: Array.from({ length: nz }, (_, k) => k * dz) };
  const per = nx * ny;
  const ct = new Int16Array(per * nz);
  const target = new Uint8Array(per * nz);
  const auto = new Uint8Array(per * nz);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < nz; k++) {
    const t = (k - 3) / 3; // -1..1
    const rx = 28 * Math.sqrt(Math.max(0, 1 - 0.6 * t * t)), ry = 20 * Math.sqrt(Math.max(0, 1 - 0.6 * t * t));
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const q = k * per + j * nx + i;
      const bx = (i - 70) / 62, by = (j - 60) / 54;
      let hu = bx * bx + by * by < 1 ? 40 : -1000;
      const lob = ((i - 70) / rx) ** 2 + ((j - 58) / ry) ** 2 < 1 || (((i - 88) / 9) ** 2 + ((j - 74) / 8) ** 2 < 1 && Math.abs(t) < 0.8);
      if (lob) { hu = 130; target[q] = 1; }
      if (((i - 40) / 6) ** 2 + ((j - 85) / 6) ** 2 < 1) hu = 700;
      ct[q] = hu + Math.round((rnd() - 0.5) * 30);
      // auto contour: shifted 5 px, misses the lobe, with a spurious bump; empty on top slice
      const a = ((i - 75) / rx) ** 2 + ((j - 56) / ry) ** 2 < 1 || (k === 2 && ((i - 52) / 7) ** 2 + ((j - 46) / 7) ** 2 < 1);
      if (a && k < nz - 1) auto[q] = 1;
    }
  }
  return { grid, ct, target, auto, window: { center: 60, width: 400 } };
}

export function dice2(a, b) {
  let na = 0, nb = 0, nab = 0;
  for (let q = 0; q < a.length; q++) { na += a[q]; nb += b[q]; nab += a[q] & b[q]; }
  return na + nb ? (2 * nab) / (na + nb) : 1;
}
