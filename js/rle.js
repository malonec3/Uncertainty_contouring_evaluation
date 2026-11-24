// Run-length encoding for binary masks. Runs alternate starting with a run of zeros
// (which may be 0 long). Example: [0,0,1,1,1,0] -> [2,3,1]

export function rleEncode(mask) {
  const runs = [];
  let cur = 0, len = 0;
  for (let q = 0; q < mask.length; q++) {
    const v = mask[q] ? 1 : 0;
    if (v === cur) len++;
    else { runs.push(len); cur = v; len = 1; }
  }
  runs.push(len);
  return Uint32Array.from(runs);
}

export function rleDecode(runs, n) {
  const out = new Uint8Array(n);
  let pos = 0, v = 0;
  for (let r = 0; r < runs.length; r++) {
    const len = runs[r];
    if (v) out.fill(1, pos, Math.min(n, pos + len));
    pos += len;
    v ^= 1;
  }
  if (pos !== n) throw new Error(`RLE length mismatch: ${pos} vs ${n}`);
  return out;
}
