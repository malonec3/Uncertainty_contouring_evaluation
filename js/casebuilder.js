// Turning DICOM files into a study case (admin side) and loading the case files (both sides).
//
// Two files are produced when a study is published:
//   participant package (public)  CT + the contours that may be shown + their precomputed uncertainty.
//                                  It contains NO reference contour and no information about its location.
//   reference package (private)   reference masks + all student masks, for scoring (admin page / Python).

import { parseDicom, modalityOf, readImageSlice, readRTStruct } from './dicom.js';
import { buildVolume, groupSeries, rasterizeROI, roiBBox, unionBBox, cropBox, cropGrid, cropData } from './volume.js';
import { computeMetrics, roundMetrics } from './metrics.js';
import { rleEncode, rleDecode } from './rle.js';
import { encodePackage, decodePackage, sha256Hex } from './package.js';
import { UncertaintyModel, AnchoredUncertainty, uncertaintyErrorAgreement } from './uncertainty.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Parse a list of File/ArrayBuffer-like objects. Each item: {name, arrayBuffer()} */
export async function loadDicomFiles(files, onProgress = () => {}) {
  const images = [], structs = [], errors = [], skipped = [];
  let i = 0;
  for (const f of files) {
    i++;
    if (i % 10 === 0) { onProgress(i / files.length, `Reading ${i}/${files.length}`); await tick(); }
    try {
      const buf = await f.arrayBuffer();
      const ds = await parseDicom(buf);
      const mod = modalityOf(ds);
      if (mod === 'RTSTRUCT') structs.push({ file: f.name, rt: readRTStruct(ds) });
      else if (mod === 'CT' || mod === 'MR' || mod === 'PT' || mod === 'OT') images.push(readImageSlice(ds));
      else skipped.push(`${f.name} (${mod})`);
    } catch (e) {
      errors.push(`${f.name}: ${e.message}`);
    }
  }
  onProgress(1, 'Done');
  return { images, series: groupSeries(images), structs, errors, skipped };
}

/** Flat list of all ROIs in all structure sets, with a stable key. */
export function listROIs(structs) {
  const out = [];
  structs.forEach((s, fi) => {
    for (const roi of s.rt.rois) {
      const slices = new Set(roi.contours.map((c) => c.points[2].toFixed(2)));
      out.push({
        key: `${fi}:${roi.number}`, fileIndex: fi, file: s.file, setLabel: s.rt.label, name: roi.name,
        number: roi.number, nContours: roi.contours.length, nSlices: slices.size, color: roi.color, roi,
        forUID: s.rt.forUID,
      });
    }
  });
  return out;
}

/**
 * Build the cropped case with one or more structures.
 * opts: { volume, structures: [{ name, refRoi, refName, studentRois: [{roi, name}] }], marginMm, marginSlices }
 */
export async function buildCase(opts, onProgress = () => {}) {
  const { volume } = opts;
  const marginMm = opts.marginMm ?? 40, marginSlices = opts.marginSlices ?? 4;
  const g = volume.grid;
  let bb = null;
  for (const st of opts.structures) {
    const rb = roiBBox(st.refRoi, g);
    if (!rb) throw new Error(`The reference for "${st.name}" has no contours on this CT series.`);
    bb = unionBBox(bb, rb);
    for (const s of st.studentRois) bb = unionBBox(bb, roiBBox(s.roi, g));
  }
  const box = cropBox(g, bb, marginMm, marginSlices);
  const grid = cropGrid(g, box);
  const ct = cropData(volume.data, g, box);
  const warnings = [...(volume.warnings || [])];
  const total = opts.structures.reduce((a, st) => a + 1 + st.studentRois.length, 0);
  let done = 0;
  const structures = [];
  for (const st of opts.structures) {
    onProgress(done / total, `Rasterising ${st.name}`);
    await tick();
    const ref = rasterizeROI(st.refRoi, grid);
    done++;
    if (ref.skipped) warnings.push(`${st.name} reference: ${ref.skipped} contour(s) did not match a CT slice and were ignored.`);
    const students = [];
    for (const sr of st.studentRois) {
      if (done % 5 === 0) { onProgress(done / total, `Rasterising ${st.name}: ${students.length + 1}/${st.studentRois.length}`); await tick(); }
      const r = rasterizeROI(sr.roi, grid);
      done++;
      if (r.skipped) warnings.push(`${st.name} / ${sr.name}: ${r.skipped} contour(s) off-grid ignored.`);
      students.push({ mask: r.mask, sourceName: sr.name, empty: !r.mask.some((v) => v) });
    }
    structures.push({ name: st.name, refName: st.refName || '', gt: ref.mask, students });
  }
  onProgress(1, 'Done');
  return {
    grid, ct, structures, box, warnings,
    source: {
      seriesUID: volume.seriesUID, studyUID: volume.studyUID, forUID: volume.forUID,
      fullDims: [g.nx, g.ny, g.nz], crop: box, sliceUIDs: volume.sliceUIDs.slice(box.k0, box.k1 + 1),
    },
    window: volume.window,
  };
}

/** Baseline metrics of every student vs its reference. Returns [structure][student]. */
export async function computeBaselines(c, onProgress = () => {}, aplTol = [0, 1, 2, 3]) {
  const out = [];
  const total = c.structures.reduce((a, s) => a + s.students.length, 0);
  let done = 0;
  for (const st of c.structures) {
    const arr = [];
    for (const s of st.students) {
      if (done % 3 === 0) { onProgress(done / total, `Metrics ${st.name}: ${arr.length + 1}/${st.students.length}`); await tick(); }
      arr.push(roundMetrics(computeMetrics(s.mask, st.gt, c.grid, { aplTolerances: aplTol })));
      done++;
    }
    out.push(arr);
  }
  onProgress(1, 'Done');
  return out;
}

/**
 * Uncertainty for every eligible contour of one structure (what participants will see).
 * flags[i] = { pool, eligible }. Returns { model, poolIdx, perStudent: Map i -> data, agreement: Map i -> {...} }
 */
export async function computeStructureUncertainty(c, si, flags, leaveOneOut, onProgress = () => {}) {
  const st = c.structures[si];
  const poolIdx = st.students.map((_, i) => i).filter((i) => flags[i].pool && !st.students[i].empty);
  const model = new UncertaintyModel(st.gt, poolIdx.map((i) => st.students[i].mask), c.grid);
  const perStudent = new Map(), agreement = new Map();
  const elig = st.students.map((_, i) => i).filter((i) => flags[i].eligible && !st.students[i].empty);
  for (let n = 0; n < elig.length; n++) {
    const i = elig[n];
    if (n % 2 === 0) { onProgress(n / elig.length, `Uncertainty ${st.name}: ${n + 1}/${elig.length}`); await tick(); }
    const data = model.forContour(st.students[i].mask, poolIdx.indexOf(i), leaveOneOut);
    perStudent.set(i, data);
    agreement.set(i, uncertaintyErrorAgreement(new AnchoredUncertainty(c.grid, st.students[i].mask, data), st.gt, c.grid));
  }
  onProgress(1, 'Done');
  return { model, poolIdx, perStudent, agreement };
}

/**
 * Write both case files.
 * flags[si][i] = {pool, eligible}; unc[si] = result of computeStructureUncertainty.
 * Student ids: per structure, the kept students (pool or eligible) are numbered 0..n-1 in both files.
 */
export async function makePackages(c, meta, flags, unc, leaveOneOut) {
  const kept = c.structures.map((st, si) => st.students.map((_, i) => i).filter((i) => !st.students[i].empty && (flags[si][i].pool || flags[si][i].eligible)));
  const label = (n) => `S${String(n + 1).padStart(2, '0')}`;
  const pHeader = {
    created: new Date().toISOString(),
    case: { label: meta.caseLabel || 'Case' },
    grid: c.grid,
    window: c.window || { center: 40, width: 400 },
    uncertainty: { leave_one_out: !!leaveOneOut },
    structures: c.structures.map((st, si) => ({
      name: meta.structureNames?.[si] || st.name,
      n_pool: unc[si].poolIdx.length,
      students: kept[si].map((i, n) => ({ id: n, label: label(n) })).filter((s) => flags[si][kept[si][s.id]].eligible),
    })),
  };
  const pBlobs = { ct: c.ct };
  c.structures.forEach((st, si) => {
    kept[si].forEach((i, n) => {
      if (!flags[si][i].eligible) return;
      const d = unc[si].perStudent.get(i);
      if (!d) throw new Error(`Uncertainty missing for ${st.name} contour ${i + 1}`);
      pBlobs[`m${si}_${n}`] = rleEncode(st.students[i].mask);
      pBlobs[`ec${si}_${n}`] = d.counts;
      pBlobs[`ev${si}_${n}`] = Uint16Array.from(d.values, (v) => Math.min(65535, Math.round(v * 100)));
      pBlobs[`c${si}_${n}`] = Float32Array.from(d.certainty);
      pBlobs[`ea${si}_${n}`] = Uint16Array.from(d.agree, (v) => Math.round(v * 1000));
      pBlobs[`os${si}_${n}`] = Float32Array.from(d.overall2);
    });
  });
  const rHeader = {
    created: pHeader.created,
    kind: 'reference',
    grid: c.grid,
    source: { forUID: c.source.forUID, seriesUID: c.source.seriesUID, crop: c.source.crop, fullDims: c.source.fullDims, sliceUIDs: c.source.sliceUIDs },
    structures: c.structures.map((st, si) => ({
      name: pHeader.structures[si].name, reference_name: st.refName,
      students: kept[si].map((i, n) => ({ id: n, label: label(n), source_name: st.students[i].sourceName, pool: !!flags[si][i].pool, eligible: !!flags[si][i].eligible })),
    })),
  };
  const rBlobs = {};
  c.structures.forEach((st, si) => {
    rBlobs[`g${si}`] = rleEncode(st.gt);
    kept[si].forEach((i, n) => { rBlobs[`s${si}_${n}`] = rleEncode(st.students[i].mask); });
  });
  const pBytes = await encodePackage(pHeader, pBlobs);
  const rBytes = await encodePackage(rHeader, rBlobs);
  return {
    participant: { bytes: pBytes, header: pHeader, sha256: await sha256Hex(pBytes) },
    reference: { bytes: rBytes, header: rHeader, sha256: await sha256Hex(rBytes) },
    kept,
  };
}

/** Participant side: CT + displayable contours + their uncertainty. No reference. */
export async function loadParticipantPackage(bytes) {
  const { header, blobs } = await decodePackage(bytes);
  const g = header.grid;
  const n = g.nx * g.ny * g.nz;
  if (header.kind === 'reference' || blobs.g0) throw new Error('This is a reference file, not a participant case file.');
  const structures = header.structures.map((st, si) => {
    const students = new Map();
    for (const s of st.students) {
      students.set(s.id, {
        label: s.label,
        mask: rleDecode(blobs[`m${si}_${s.id}`], n),
        unc: {
          counts: blobs[`ec${si}_${s.id}`],
          values: Float32Array.from(blobs[`ev${si}_${s.id}`], (v) => v / 100),
          certainty: blobs[`c${si}_${s.id}`],
          agree: blobs[`ea${si}_${s.id}`] ? Float32Array.from(blobs[`ea${si}_${s.id}`], (v) => v / 1000) : null,
          overall2: blobs[`os${si}_${s.id}`] || null,
          loo: !!header.uncertainty?.leave_one_out,
          nPool: header.uncertainty?.leave_one_out ? st.n_pool - 1 : st.n_pool,
        },
      });
    }
    return { name: st.name, students };
  });
  return { header, grid: g, ct: blobs.ct, structures };
}

/** Admin / analysis side: reference masks and all student masks. */
export async function loadReferencePackage(bytes) {
  const { header, blobs } = await decodePackage(bytes);
  const g = header.grid;
  const n = g.nx * g.ny * g.nz;
  const structures = header.structures.map((st, si) => ({
    name: st.name,
    gt: rleDecode(blobs[`g${si}`], n),
    students: new Map(st.students.map((s) => [s.id, { ...s, mask: rleDecode(blobs[`s${si}_${s.id}`], n) }])),
  }));
  return { header, grid: g, structures };
}

/** Score one submitted case against the reference. Returns the columns + metrics json stored in the DB. */
export function scoreTrial(ref, trial, aplTol = 1) {
  const st = ref.structures[trial.structure_index];
  if (!st) throw new Error(`Structure ${trial.structure_index} not in reference file`);
  const orig = st.students.get(trial.student_id);
  if (!orig) throw new Error(`Contour ${trial.student_id} not in reference file`);
  const g = ref.grid;
  const n = g.nx * g.ny * g.nz;
  const final = rleDecode(trial.edited_mask_rle, n);
  const tolList = [...new Set([0, 1, 2, 3, aplTol])];
  const mFinal = roundMetrics(computeMetrics(final, st.gt, g, { aplTolerances: tolList }));
  const mOrig = roundMetrics(computeMetrics(orig.mask, st.gt, g, { aplTolerances: tolList }));
  // reference = final, test = original -> APL = path the participant drew
  const mChange = roundMetrics(computeMetrics(orig.mask, final, g, { aplTolerances: tolList }));
  let changed = 0;
  for (let q = 0; q < n; q++) changed += final[q] !== orig.mask[q];
  return {
    dsc: mFinal.dsc, sdsc_1mm: mFinal.sdsc[1], sdsc_2mm: mFinal.sdsc[2], sdsc_3mm: mFinal.sdsc[3],
    hd_mm: mFinal.hd, hd95_mm: mFinal.hd95, msd_mm: mFinal.msd, apl_mm: mFinal.apl_mm[aplTol],
    edit_apl_mm: mChange.apl_mm[aplTol], changed_voxels: changed,
    baseline_dsc: mOrig.dsc, baseline_sdsc_2mm: mOrig.sdsc[2], baseline_hd95_mm: mOrig.hd95, baseline_apl_mm: mOrig.apl_mm[aplTol],
    metrics: { final_vs_ref: mFinal, original_vs_ref: mOrig, original_vs_final: mChange, apl_tolerance_mm: aplTol },
    scored_at: new Date().toISOString(),
  };
}
