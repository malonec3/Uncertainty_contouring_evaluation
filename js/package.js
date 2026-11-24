// Case package: a single gzip-compressed binary file holding the cropped CT, the reference
// mask and all student masks (RLE), plus a JSON header. Readable from Python with
// analysis/case_package.py.
//
// Layout (before gzip):  "FUCP" | u32 version | u32 headerBytes | header JSON | pad to 8 | blobs
// header.blobs = [{ name, dtype, length (elements), offset (bytes from start of blob area) }]

const MAGIC = 'FUCP';
const VERSION = 1;
const DTYPES = { int16: Int16Array, uint8: Uint8Array, uint16: Uint16Array, uint32: Uint32Array, float32: Float32Array };
const dtypeOf = (arr) => {
  for (const [k, C] of Object.entries(DTYPES)) if (arr instanceof C) return k;
  throw new Error('Unsupported array type');
};

async function gzip(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function gunzip(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

export async function encodePackage(header, blobs) {
  const entries = [];
  let off = 0;
  for (const [name, arr] of Object.entries(blobs)) {
    entries.push({ name, dtype: dtypeOf(arr), length: arr.length, offset: off });
    off += arr.byteLength;
    off = Math.ceil(off / 8) * 8;
  }
  const h = { ...header, format: 'fucp', version: VERSION, blobs: entries };
  const hBytes = new TextEncoder().encode(JSON.stringify(h));
  const headLen = Math.ceil((12 + hBytes.length) / 8) * 8;
  const total = headLen + off;
  const buf = new Uint8Array(total);
  buf.set(new TextEncoder().encode(MAGIC), 0);
  const dv = new DataView(buf.buffer);
  dv.setUint32(4, VERSION, true);
  dv.setUint32(8, hBytes.length, true);
  buf.set(hBytes, 12);
  for (const e of entries) {
    const arr = blobs[e.name];
    buf.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), headLen + e.offset);
  }
  return gzip(buf);
}

export async function decodePackage(input) {
  let bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes);
  const magic = new TextDecoder().decode(bytes.subarray(0, 4));
  if (magic !== MAGIC) throw new Error('Not a case package file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hLen = dv.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + hLen)));
  const headLen = Math.ceil((12 + hLen) / 8) * 8;
  const blobs = {};
  for (const e of header.blobs) {
    const C = DTYPES[e.dtype];
    const start = headLen + e.offset;
    // copy -> aligned buffer
    blobs[e.name] = new C(bytes.slice(start, start + e.length * C.BYTES_PER_ELEMENT).buffer);
  }
  return { header, blobs };
}

export async function sha256Hex(bytes) {
  const h = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
