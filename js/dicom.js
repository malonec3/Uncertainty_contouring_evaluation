// Minimal, dependency-free DICOM reader for uncompressed CT series and RTSTRUCT.
// Supports: Part-10 files (with or without preamble), implicit VR LE, explicit VR LE,
// deflated explicit VR LE. Compressed pixel data (JPEG etc.) is reported as an error;
// convert with e.g. `gdcmconv --raw in.dcm out.dcm` or `dcmdjpeg`.

const TS_IMPLICIT_LE = '1.2.840.10008.1.2';
const TS_EXPLICIT_LE = '1.2.840.10008.1.2.1';
const TS_DEFLATED_LE = '1.2.840.10008.1.2.1.99';
const TS_EXPLICIT_BE = '1.2.840.10008.1.2.2';

const VR_LONG = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV']);
const UNDEF = 0xffffffff;

// VRs for the tags we use (needed for implicit VR transfer syntax).
const DICT = {
  '00020010': 'UI', '00080016': 'UI', '00080018': 'UI', '00080060': 'CS', '0008103E': 'LO',
  '00100010': 'PN', '00100020': 'LO', '0020000D': 'UI', '0020000E': 'UI', '00200052': 'UI',
  '00200013': 'IS', '00200032': 'DS', '00200037': 'DS', '00180050': 'DS', '00185100': 'CS',
  '00280002': 'US', '00280004': 'CS', '00280008': 'IS', '00280010': 'US', '00280011': 'US',
  '00280030': 'DS', '00280100': 'US', '00280101': 'US', '00280102': 'US', '00280103': 'US',
  '00281050': 'DS', '00281051': 'DS', '00281052': 'DS', '00281053': 'DS', '7FE00010': 'OW',
  '00081150': 'UI', '00081155': 'UI', '00081115': 'SQ', '00081140': 'SQ',
  '30060002': 'SH', '30060004': 'LO', '30060010': 'SQ', '30060012': 'SQ', '30060014': 'SQ',
  '30060016': 'SQ', '30060020': 'SQ', '30060022': 'IS', '30060024': 'UI', '30060026': 'LO',
  '30060036': 'CS', '30060039': 'SQ', '3006002A': 'IS', '30060040': 'SQ', '30060042': 'CS',
  '30060046': 'IS', '30060048': 'IS', '30060050': 'DS', '30060080': 'SQ', '30060082': 'IS',
  '30060084': 'IS', '300600A4': 'CS', '300600A6': 'PN',
};

export const TAG = {
  TransferSyntaxUID: '00020010', SOPClassUID: '00080016', SOPInstanceUID: '00080018',
  Modality: '00080060', SeriesDescription: '0008103E', PatientName: '00100010', PatientID: '00100020',
  StudyInstanceUID: '0020000D', SeriesInstanceUID: '0020000E', FrameOfReferenceUID: '00200052',
  InstanceNumber: '00200013', ImagePositionPatient: '00200032', ImageOrientationPatient: '00200037',
  SliceThickness: '00180050', SamplesPerPixel: '00280002', NumberOfFrames: '00280008',
  Rows: '00280010', Columns: '00280011', PixelSpacing: '00280030', BitsAllocated: '00280100',
  BitsStored: '00280101', PixelRepresentation: '00280103', WindowCenter: '00281050',
  WindowWidth: '00281051', RescaleIntercept: '00281052', RescaleSlope: '00281053', PixelData: '7FE00010',
  StructureSetLabel: '30060002', ReferencedFrameOfReferenceSequence: '30060010',
  RTReferencedStudySequence: '30060012', RTReferencedSeriesSequence: '30060014',
  StructureSetROISequence: '30060020', ROINumber: '30060022', ROIName: '30060026',
  ROIContourSequence: '30060039', ROIDisplayColor: '3006002A', ContourSequence: '30060040',
  ContourGeometricType: '30060042', ContourData: '30060050', ReferencedROINumber: '30060084',
  RTROIObservationsSequence: '30060080', RTROIInterpretedType: '300600A4',
};

const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');

class Reader {
  constructor(bytes, littleEndian = true) {
    this.bytes = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.le = littleEndian;
  }
  u16(p) { return this.dv.getUint16(p, this.le); }
  u32(p) { return this.dv.getUint32(p, this.le); }
  ascii(p, n) {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.bytes[p + i]);
    return s;
  }
}

function readHeader(r, pos, explicit) {
  const group = r.u16(pos);
  const elem = r.u16(pos + 2);
  const key = hex4(group) + hex4(elem);
  if (group === 0xfffe) return { key, group, elem, vr: null, length: r.u32(pos + 4), valuePos: pos + 8 };
  if (explicit) {
    const vr = r.ascii(pos + 4, 2);
    if (VR_LONG.has(vr)) return { key, group, elem, vr, length: r.u32(pos + 8), valuePos: pos + 12 };
    if (/^[A-Z]{2}$/.test(vr)) return { key, group, elem, vr, length: r.u16(pos + 6), valuePos: pos + 8 };
    // Not a valid VR: fall back to implicit for this element.
  }
  return { key, group, elem, vr: DICT[key] || 'UN', length: r.u32(pos + 4), valuePos: pos + 8, implicit: true };
}

// Parse a sequence starting at pos; returns { items, end }
function parseSequence(r, pos, length, explicit) {
  const items = [];
  const end = length === UNDEF ? r.bytes.length : pos + length;
  while (pos < end) {
    const group = r.u16(pos), elem = r.u16(pos + 2), len = r.u32(pos + 4);
    if (group === 0xfffe && elem === 0xe000) {
      const res = parseDataset(r, pos + 8, len === UNDEF ? r.bytes.length : pos + 8 + len, explicit, len === UNDEF);
      items.push(res.ds);
      pos = res.end;
    } else if (group === 0xfffe && elem === 0xe0dd) {
      pos += 8;
      break;
    } else {
      throw new Error(`Malformed sequence at byte ${pos}`);
    }
  }
  return { items, end: pos };
}

function skipEncapsulated(r, pos) {
  // Encapsulated pixel data: items until sequence delimiter
  while (pos < r.bytes.length) {
    const group = r.u16(pos), elem = r.u16(pos + 2), len = r.u32(pos + 4);
    pos += 8;
    if (group === 0xfffe && elem === 0xe0dd) break;
    pos += len;
  }
  return pos;
}

function parseDataset(r, pos, end, explicit, untilItemDelim = false, stopGroup = null) {
  const ds = { _r: r, _el: new Map() };
  while (pos < end && pos + 8 <= r.bytes.length) {
    const group = r.u16(pos);
    if (stopGroup !== null && group !== stopGroup) break;
    const h = readHeader(r, pos, explicit);
    if (h.group === 0xfffe && h.elem === 0xe00d) { pos += 8; return { ds, end: pos }; }
    if (h.group === 0xfffe) { pos = h.valuePos; continue; }
    let valueEnd;
    const isSeq = h.vr === 'SQ' || (h.length === UNDEF && h.key !== TAG.PixelData);
    if (isSeq) {
      // UN with undefined length is implicit-VR encoded (PS3.5 6.2.2)
      const seqExplicit = h.vr === 'UN' ? false : explicit;
      const res = parseSequence(r, h.valuePos, h.length, seqExplicit);
      ds._el.set(h.key, { vr: 'SQ', items: res.items });
      valueEnd = res.end;
    } else if (h.length === UNDEF) {
      ds._el.set(h.key, { vr: h.vr, encapsulated: true, offset: h.valuePos, length: 0 });
      valueEnd = skipEncapsulated(r, h.valuePos);
    } else {
      ds._el.set(h.key, { vr: h.vr, offset: h.valuePos, length: h.length });
      valueEnd = h.valuePos + h.length;
    }
    pos = valueEnd;
  }
  if (untilItemDelim) return { ds, end: pos };
  return { ds, end: pos };
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Parse a DICOM file (ArrayBuffer or Uint8Array). Returns a dataset object. */
export async function parseDicom(input) {
  let bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let r = new Reader(bytes, true);
  let pos = 0;
  let ts = TS_IMPLICIT_LE;
  let meta = null;
  if (bytes.length > 132 && r.ascii(128, 4) === 'DICM') {
    const m = parseDataset(r, 132, bytes.length, true, false, 0x0002);
    meta = m.ds;
    pos = m.end;
    ts = getString(meta, TAG.TransferSyntaxUID) || TS_EXPLICIT_LE;
  } else {
    // Raw dataset without preamble: guess explicit vs implicit by peeking at the VR bytes.
    const vr = r.ascii(4, 2);
    ts = /^[A-Z]{2}$/.test(vr) ? TS_EXPLICIT_LE : TS_IMPLICIT_LE;
  }
  if (ts === TS_EXPLICIT_BE) throw new Error('Big-endian DICOM is not supported. Convert to little endian first.');
  if (ts === TS_DEFLATED_LE) {
    const inflated = await inflateRaw(bytes.subarray(pos));
    bytes = inflated;
    r = new Reader(bytes, true);
    pos = 0;
    ts = TS_EXPLICIT_LE;
  }
  const explicit = ts !== TS_IMPLICIT_LE;
  const { ds } = parseDataset(r, pos, bytes.length, explicit);
  ds._ts = ts;
  ds._compressed = !(ts === TS_IMPLICIT_LE || ts === TS_EXPLICIT_LE);
  ds._meta = meta;
  return ds;
}

// ----------------------------------------------------------------- value accessors
export function has(ds, key) { return ds._el.has(key); }

export function getString(ds, key) {
  const e = ds._el.get(key);
  if (!e || e.items || e.encapsulated) return null;
  const b = ds._r.bytes;
  let s = '';
  for (let i = 0; i < e.length; i++) s += String.fromCharCode(b[e.offset + i]);
  return s.replace(/[\0\s]+$/, '').replace(/^\s+/, '');
}

export function getNumbers(ds, key) {
  const e = ds._el.get(key);
  if (!e || e.items) return null;
  const r = ds._r;
  if (e.vr === 'US' || e.vr === 'SS') {
    const out = [];
    for (let i = 0; i + 2 <= e.length; i += 2) out.push(e.vr === 'US' ? r.u16(e.offset + i) : r.dv.getInt16(e.offset + i, true));
    return out;
  }
  if (e.vr === 'UL' || e.vr === 'SL') {
    const out = [];
    for (let i = 0; i + 4 <= e.length; i += 4) out.push(e.vr === 'UL' ? r.u32(e.offset + i) : r.dv.getInt32(e.offset + i, true));
    return out;
  }
  if (e.vr === 'FL' || e.vr === 'FD') {
    const n = e.vr === 'FL' ? 4 : 8;
    const out = [];
    for (let i = 0; i + n <= e.length; i += n) out.push(n === 4 ? r.dv.getFloat32(e.offset + i, true) : r.dv.getFloat64(e.offset + i, true));
    return out;
  }
  const s = getString(ds, key);
  if (s === null || s === '') return [];
  return s.split('\\').map((t) => parseFloat(t));
}

export function getNumber(ds, key, dflt = null) {
  const v = getNumbers(ds, key);
  return v && v.length && Number.isFinite(v[0]) ? v[0] : dflt;
}

export function getUS(ds, key, dflt = null) {
  // US elements read as raw uint16 regardless of the VR lookup
  const e = ds._el.get(key);
  if (!e || e.items) return dflt;
  if (e.length === 2) return ds._r.u16(e.offset);
  if (e.length === 4) return ds._r.u32(e.offset);
  return getNumber(ds, key, dflt);
}

export function getSeq(ds, key) {
  const e = ds._el.get(key);
  if (!e) return [];
  if (e.items) return e.items;
  // Known sequence stored with defined length but parsed as raw (implicit VR, unknown tag)
  if (e.length > 0) {
    try { return parseSequence(ds._r, e.offset, e.length, ds._ts !== TS_IMPLICIT_LE).items; } catch { return []; }
  }
  return [];
}

export function modalityOf(ds) {
  const m = getString(ds, TAG.Modality);
  if (m) return m.toUpperCase();
  const sop = getString(ds, TAG.SOPClassUID) || '';
  if (sop === '1.2.840.10008.5.1.4.1.1.481.3') return 'RTSTRUCT';
  if (sop.startsWith('1.2.840.10008.5.1.4.1.1.2')) return 'CT';
  return 'OT';
}

// ----------------------------------------------------------------- CT slices
export function readImageSlice(ds) {
  const rows = getUS(ds, TAG.Rows), cols = getUS(ds, TAG.Columns);
  const pixel = ds._el.get(TAG.PixelData);
  if (!pixel) throw new Error('No pixel data');
  if (pixel.encapsulated || ds._compressed) {
    throw new Error(`Compressed pixel data (transfer syntax ${ds._ts}) is not supported. ` +
      'Export the CT uncompressed or convert with "gdcmconv --raw".');
  }
  const frames = getNumber(ds, TAG.NumberOfFrames, 1);
  if (frames > 1) throw new Error('Multi-frame images are not supported');
  const bitsAlloc = getUS(ds, TAG.BitsAllocated, 16);
  const bitsStored = getUS(ds, TAG.BitsStored, bitsAlloc);
  const signed = getUS(ds, TAG.PixelRepresentation, 0) === 1;
  const slope = getNumber(ds, TAG.RescaleSlope, 1);
  const intercept = getNumber(ds, TAG.RescaleIntercept, 0);
  const n = rows * cols;
  const hu = new Int16Array(n);
  const r = ds._r;
  if (bitsAlloc === 16) {
    const shift = 32 - bitsStored;
    for (let i = 0; i < n; i++) {
      let v = r.dv.getUint16(pixel.offset + 2 * i, true);
      if (signed) v = bitsStored < 16 ? ((v << shift) >> shift) : (v << 16) >> 16;
      else if (bitsStored < 16) v &= (1 << bitsStored) - 1;
      let h = Math.round(v * slope + intercept);
      hu[i] = h < -32768 ? -32768 : h > 32767 ? 32767 : h;
    }
  } else if (bitsAlloc === 8) {
    for (let i = 0; i < n; i++) hu[i] = Math.round(r.bytes[pixel.offset + i] * slope + intercept);
  } else {
    throw new Error(`BitsAllocated=${bitsAlloc} not supported`);
  }
  const wc = getNumber(ds, TAG.WindowCenter, null);
  const ww = getNumber(ds, TAG.WindowWidth, null);
  return {
    modality: modalityOf(ds),
    sopUID: getString(ds, TAG.SOPInstanceUID),
    seriesUID: getString(ds, TAG.SeriesInstanceUID),
    studyUID: getString(ds, TAG.StudyInstanceUID),
    forUID: getString(ds, TAG.FrameOfReferenceUID),
    seriesDescription: getString(ds, TAG.SeriesDescription) || '',
    instance: getNumber(ds, TAG.InstanceNumber, 0),
    ipp: getNumbers(ds, TAG.ImagePositionPatient),
    iop: getNumbers(ds, TAG.ImageOrientationPatient),
    pixelSpacing: getNumbers(ds, TAG.PixelSpacing),
    sliceThickness: getNumber(ds, TAG.SliceThickness, null),
    rows, cols, hu, window: wc !== null && ww !== null ? { center: wc, width: ww } : null,
  };
}

// ----------------------------------------------------------------- RTSTRUCT
export function readRTStruct(ds) {
  const rois = new Map();
  for (const it of getSeq(ds, TAG.StructureSetROISequence)) {
    const num = getNumber(it, TAG.ROINumber);
    rois.set(num, { number: num, name: getString(it, TAG.ROIName) || `ROI ${num}`, color: null, type: '', contours: [] });
  }
  for (const it of getSeq(ds, TAG.RTROIObservationsSequence)) {
    const num = getNumber(it, TAG.ReferencedROINumber);
    if (rois.has(num)) rois.get(num).type = getString(it, TAG.RTROIInterpretedType) || '';
  }
  for (const it of getSeq(ds, TAG.ROIContourSequence)) {
    const num = getNumber(it, TAG.ReferencedROINumber);
    if (!rois.has(num)) rois.set(num, { number: num, name: `ROI ${num}`, color: null, type: '', contours: [] });
    const roi = rois.get(num);
    const col = getNumbers(it, TAG.ROIDisplayColor);
    if (col && col.length === 3) roi.color = col;
    for (const c of getSeq(it, TAG.ContourSequence)) {
      const type = (getString(c, TAG.ContourGeometricType) || 'CLOSED_PLANAR').toUpperCase();
      const pts = getNumbers(c, TAG.ContourData) || [];
      if (pts.length >= 9) roi.contours.push({ type, points: Float64Array.from(pts) });
    }
  }
  let refSeries = null;
  for (const f of getSeq(ds, TAG.ReferencedFrameOfReferenceSequence)) {
    for (const st of getSeq(f, TAG.RTReferencedStudySequence)) {
      for (const se of getSeq(st, TAG.RTReferencedSeriesSequence)) {
        refSeries = refSeries || getString(se, TAG.SeriesInstanceUID);
      }
    }
  }
  return {
    sopUID: getString(ds, TAG.SOPInstanceUID),
    label: getString(ds, TAG.StructureSetLabel) || '',
    forUID: getString(ds, TAG.FrameOfReferenceUID),
    referencedSeriesUID: refSeries,
    rois: [...rois.values()],
  };
}
