// Researcher console: load DICOM, define 1..6 structures (reference + student contours each), review,
// configure, publish (participant file without reference + private reference file); score and export results.

import { createBackend, DEFAULT_STUDY_CONFIG } from './backend.js';
import { loadDicomFiles, listROIs, buildCase, computeBaselines, computeStructureUncertainty, makePackages, loadReferencePackage, scoreTrial } from './casebuilder.js';
import { buildVolume } from './volume.js';
import { AnchoredUncertainty } from './uncertainty.js';
import { createDisplay, MODES, MODE_IDS } from './displays.js';
import { SliceEditor, buildToolbar, buildSliceSlider } from './viewer.js';
import { STRATA } from './allocation.js';

const root = document.getElementById('admin');
const A = { slots: [], activeSlot: 0, reviewSi: 0 };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const f2 = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '–' : Number(v).toFixed(d));
const $ = (sel) => root.querySelector(sel);
const tick = () => new Promise((r) => setTimeout(r, 0));
const REF_RE = /(^|[\s_-])(ref|reference|gt|gold|truth|expert|consensus)([\s_-]|$)/i;
const MAX_SLOTS = 6;

function quantiles(arr) {
  const s = arr.filter((v) => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const q = (p) => { const pos = (s.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos); return s[lo] + (s[hi] - s[lo]) * (pos - lo); };
  return { med: q(0.5), q1: q(0.25), q3: q(0.75), min: s[0], max: s[s.length - 1] };
}
function download(name, data, type = 'application/octet-stream') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function alertBox(sel, msg) { $(sel).innerHTML = `<div class="error-box">${esc(msg)}</div>`; }
function progressIn(sel) {
  $(sel).innerHTML = '<div class="progress" style="margin-top:10px"><div></div></div><div class="muted pmsg"></div>';
  return (f, m) => { const el = $(sel); if (!el || !el.querySelector('.progress')) return; el.querySelector('.progress div').style.width = `${f * 100}%`; el.querySelector('.pmsg').textContent = m; };
}

// structure-name helpers: "OralCavity_REF" -> tokens ["oral","cavity"]
function coreTokens(name) {
  return name.replace(REF_RE, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean).map((t) => t.toLowerCase());
}
const prettyName = (name) => {
  const t = name.replace(REF_RE, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean).join(' ');
  return t ? t[0].toUpperCase() + t.slice(1) : name;
};
const tokenRegex = (name) => new RegExp(coreTokens(name).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\W_]*'), 'i');

// ------------------------------------------------------------------ shell
async function init() {
  try { A.backend = createBackend(); } catch (e) { root.innerHTML = `<div class="error-box">${esc(e.message)}</div>`; return; }
  if (A.backend.mode === 'supabase') {
    const s = await A.backend.adminSession().catch(() => null);
    if (!s || s.notAdmin) return loginScreen(s && s.notAdmin ? `${s.email} is signed in but is not listed in admin_users.` : '');
  }
  shell();
}

function loginScreen(msg = '') {
  root.innerHTML = `<div class="page"><div class="brand"><span class="dot"></span>Study admin</div>
    <div class="card"><h1>Researcher sign-in</h1>
    <form id="lf"><div class="form-row"><label>Email</label><input type="email" id="em" required style="min-width:280px"></div>
    <div class="form-row"><label>Password</label><input type="password" id="pw" required style="min-width:280px"></div>
    <div id="lerr">${msg ? `<div class="error-box">${esc(msg)}</div>` : ''}</div>
    <div class="actions"><button class="primary" type="submit">Sign in</button></div></form></div></div>`;
  $('#lf').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const s = await A.backend.adminSignIn($('#em').value, $('#pw').value);
      if (!s || s.notAdmin) throw new Error('This account is not an admin (add its user id to admin_users).');
      shell();
    } catch (err) { $('#lerr').innerHTML = `<div class="error-box">${esc(err.message)}</div>`; }
  });
}

function shell() {
  const local = A.backend.mode === 'local';
  root.innerHTML = `
    <div class="brand"><span class="dot"></span>Study admin ${local ? '<span class="tag warn">Local demo mode – data stays in this browser</span>' : '<span class="tag ok">Supabase</span>'}
      <span style="flex:1"></span>${local ? '' : '<button id="logout">Sign out</button>'}</div>
    <div class="steps" id="tabs">
      <span data-tab="setup" class="on">1 · Set up case</span><span data-tab="studies">2 · Studies</span><span data-tab="results">3 · Results</span>
    </div>
    <div id="tab"></div>`;
  $('#tabs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (!t) return;
    root.querySelectorAll('#tabs span').forEach((s) => s.classList.toggle('on', s === t));
    ({ setup: setupTab, studies: studiesTab, results: resultsTab })[t.dataset.tab]();
  });
  if (!local) $('#logout').onclick = async () => { await A.backend.adminSignOut(); location.reload(); };
  setupTab();
}
function dropEditor() { if (A.editor) { A.editor.destroy(); A.editor = null; } }

// ------------------------------------------------------------------ A. load DICOM
function setupTab() {
  dropEditor();
  $('#tab').innerHTML = `
    <div class="card"><h2 style="margin-top:0">A · Load the CT series and structure set(s)</h2>
      <p class="muted">Drop the folder containing the CT slices and RTSTRUCT file(s). Several RTSTRUCT files are fine (e.g. one per delegate).
      Files are read in your browser; only the processed, cropped case is uploaded when you publish.</p>
      <div class="dropzone" id="dz">Drag &amp; drop a folder or files here<br><br>
        <label class="btn" style="display:inline-block">Choose folder<input type="file" id="fdir" webkitdirectory multiple hidden></label>
        <label class="btn" style="display:inline-block">Choose files<input type="file" id="ffiles" multiple hidden></label></div>
      <div id="loadstat" style="margin-top:12px"></div>
    </div>
    <div id="roiCard"></div><div id="reviewCard"></div><div id="publishCard"></div>`;
  const dz = $('#dz');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', async (e) => { e.preventDefault(); dz.classList.remove('drag'); loadFiles(await filesFromDrop(e.dataTransfer)); });
  $('#fdir').addEventListener('change', (e) => loadFiles([...e.target.files]));
  $('#ffiles').addEventListener('change', (e) => loadFiles([...e.target.files]));
  if (A.loaded) renderLoaded();
  if (A.case) { renderReview(); renderPublish(); }
}

async function filesFromDrop(dt) {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const out = [];
  const walk = async (entry) => {
    if (entry.isFile) out.push(await new Promise((res, rej) => entry.file(res, rej)));
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const b of batch) await walk(b);
      }
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

async function loadFiles(files) {
  const prog = progressIn('#loadstat');
  A.loaded = await loadDicomFiles(files, prog);
  A.case = null; A.slots = []; A.activeSlot = 0;
  $('#reviewCard').innerHTML = ''; $('#publishCard').innerHTML = '';
  renderLoaded();
}

function renderLoaded() {
  const L = A.loaded;
  const st = $('#loadstat');
  if (!L.series.length) {
    st.innerHTML = `<div class="error-box">No readable CT images found.${L.errors.length ? `\n${L.errors.slice(0, 8).join('\n')}` : ''}</div>`;
    return;
  }
  const structSeries = new Set(L.structs.map((s) => s.rt.referencedSeriesUID).filter(Boolean));
  const defaultSeries = L.series.find((s) => structSeries.has(s.seriesUID)) || L.series[0];
  A.seriesUID = A.seriesUID && L.series.some((s) => s.seriesUID === A.seriesUID) ? A.seriesUID : defaultSeries.seriesUID;
  st.innerHTML = `
    <div class="kv"><b>Image series</b><span><select id="series">${L.series.map((s) => `<option value="${s.seriesUID}" ${s.seriesUID === A.seriesUID ? 'selected' : ''}>${esc(s.modality)} · ${esc(s.description || 'no description')} · ${s.slices.length} slices</option>`).join('')}</select></span>
    <b>Structure sets</b><span>${L.structs.length} file(s), ${listROIs(L.structs).length} ROIs</span>
    ${L.skipped.length ? `<b>Skipped</b><span>${L.skipped.length} non-CT/RTSTRUCT file(s)</span>` : ''}
    ${L.errors.length ? `<b>Unreadable</b><span><details><summary>${L.errors.length} file(s)</summary><pre style="white-space:pre-wrap;font-size:.8rem">${esc(L.errors.join('\n'))}</pre></details></span>` : ''}</div>`;
  $('#series').addEventListener('change', (e) => { A.seriesUID = e.target.value; A.case = null; });
  if (!L.structs.length) { $('#roiCard').innerHTML = '<div class="card"><div class="error-box">No RTSTRUCT file found.</div></div>'; return; }
  A.rois = listROIs(L.structs);
  if (!A.slots.length) autoSlots();
  renderROIs();
}

// ------------------------------------------------------------------ B. structures
function suggestStudents(slot) {
  const ref = A.rois.find((r) => r.key === slot.ref);
  if (!ref) return;
  const re = tokenRegex(ref.name);
  const refs = new Set(A.slots.map((s) => s.ref));
  A.rois.forEach((r) => { if (!refs.has(r.key) && !REF_RE.test(r.name) && re.test(r.name)) slot.students.add(r.key); });
}
function autoSlots() {
  const refs = A.rois.filter((r) => REF_RE.test(r.name)).slice(0, MAX_SLOTS);
  A.slots = refs.length ? refs.map((r) => ({ name: prettyName(r.name), ref: r.key, students: new Set() })) : [{ name: 'Structure 1', ref: null, students: new Set() }];
  A.slots.forEach(suggestStudents);
}

function renderROIs() {
  const rois = A.rois;
  const slot = A.slots[A.activeSlot];
  const refKeys = new Set(A.slots.map((s) => s.ref).filter(Boolean));
  $('#roiCard').innerHTML = `<div class="card"><h2 style="margin-top:0">B · Structures: reference and student contours</h2>
    <p class="muted">Each participant edits several delegate contours of every structure listed here (set the number in step D). Reference contours are never sent to participants.</p>
    <div class="steps" id="slotTabs">${A.slots.map((s, i) => `<span data-slot="${i}" class="${i === A.activeSlot ? 'on' : ''}">${i + 1} · ${esc(s.name || 'unnamed')} <small>(${s.ref ? '✓ ref' : 'no ref'}, ${s.students.size})</small></span>`).join('')}
      ${A.slots.length < MAX_SLOTS ? '<span data-slot="add">+ Add structure</span>' : ''}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
      <label>Name shown to participants <input type="text" id="slotName" value="${esc(slot.name)}" style="min-width:220px"></label>
      ${A.slots.length > 1 ? '<button id="slotDel" class="danger">Remove this structure</button>' : ''}
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
      <button id="selSuggest">Suggest students from the reference name</button>
      <input type="text" id="rx" placeholder="or a regular expression, e.g. Parotid" style="min-width:240px">
      <button id="selRx">Select matching</button>
      <button id="selNone">Clear students</button>
      <span class="muted" id="selCount"></span></div>
    <div class="scroll-box"><table class="data"><thead><tr><th>Reference</th><th>Student</th><th>ROI name</th><th>File / set</th><th class="num">Contours</th><th class="num">Slices</th><th>Used in</th></tr></thead>
    <tbody>${rois.map((r) => {
      const usedIn = A.slots.map((s, i) => (s.ref === r.key ? `${i + 1} ref` : s.students.has(r.key) ? `${i + 1}` : null)).filter(Boolean).join(', ');
      return `<tr><td><input type="radio" name="ref" value="${r.key}" ${slot.ref === r.key ? 'checked' : ''}></td>
      <td><input type="checkbox" data-k="${r.key}" ${slot.students.has(r.key) ? 'checked' : ''} ${refKeys.has(r.key) ? 'disabled' : ''}></td>
      <td>${esc(r.name)}</td><td class="muted">${esc(r.file)}${r.setLabel ? ` · ${esc(r.setLabel)}` : ''}</td><td class="num">${r.nContours}</td><td class="num">${r.nSlices}</td><td class="muted">${usedIn}</td></tr>`;
    }).join('')}</tbody></table></div>
    <div class="grid2" style="margin-top:14px">
      <div class="form-row"><label>In-plane crop margin around all structures (mm)</label><input type="number" id="mmargin" value="${A.marginMm ?? 40}" min="5" max="200"><div class="hint">Context visible to participants. Larger = more anatomy, bigger file.</div></div>
      <div class="form-row"><label>Extra slices above/below</label><input type="number" id="smargin" value="${A.marginSlices ?? 4}" min="0" max="40"></div>
    </div>
    <div class="actions"><button class="primary" id="build">Build case (${A.slots.length} structure${A.slots.length === 1 ? '' : 's'})</button></div>
    <div id="buildstat"></div></div>`;
  const rerender = () => { A.marginMm = +$('#mmargin').value; A.marginSlices = +$('#smargin').value; renderROIs(); };
  $('#slotTabs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-slot]');
    if (!t) return;
    if (t.dataset.slot === 'add') { A.slots.push({ name: `Structure ${A.slots.length + 1}`, ref: null, students: new Set() }); A.activeSlot = A.slots.length - 1; } else A.activeSlot = +t.dataset.slot;
    rerender();
  });
  $('#slotName').addEventListener('change', (e) => { slot.name = e.target.value.trim(); rerender(); });
  const del = $('#slotDel');
  if (del) del.onclick = () => { A.slots.splice(A.activeSlot, 1); A.activeSlot = 0; rerender(); };
  root.querySelectorAll('#roiCard input[name=ref]').forEach((r) => r.addEventListener('change', () => {
    slot.ref = r.value;
    A.slots.forEach((s) => s.students.delete(r.value));
    const roi = A.rois.find((x) => x.key === r.value);
    if (/^Structure \d+$/.test(slot.name) && roi) slot.name = prettyName(roi.name);
    rerender();
  }));
  root.querySelectorAll('#roiCard input[data-k]').forEach((c) => c.addEventListener('change', () => {
    if (c.checked) slot.students.add(c.dataset.k); else slot.students.delete(c.dataset.k);
    $('#selCount').textContent = `${slot.students.size} student contour(s) selected for this structure`;
  }));
  $('#selSuggest').onclick = () => { if (!slot.ref) return alertBox('#buildstat', 'Choose the reference first.'); suggestStudents(slot); rerender(); };
  $('#selRx').onclick = () => {
    let re;
    try { re = new RegExp($('#rx').value, 'i'); } catch { return alertBox('#buildstat', 'Invalid regular expression'); }
    rois.forEach((r) => { if (re.test(r.name) && !refKeys.has(r.key)) slot.students.add(r.key); });
    rerender();
  };
  $('#selNone').onclick = () => { slot.students.clear(); rerender(); };
  $('#build').onclick = () => doBuild();
  $('#selCount').textContent = `${slot.students.size} student contour(s) selected for this structure`;
}

async function doBuild() {
  A.marginMm = +$('#mmargin').value; A.marginSlices = +$('#smargin').value;
  for (const [i, s] of A.slots.entries()) {
    if (!s.ref) return alertBox('#buildstat', `Structure ${i + 1} (${s.name}) has no reference.`);
    if (s.students.size < 2) return alertBox('#buildstat', `Structure ${i + 1} (${s.name}) needs at least two student contours.`);
    if (!s.name) return alertBox('#buildstat', `Structure ${i + 1} needs a name.`);
  }
  const prog = progressIn('#buildstat');
  try {
    const series = A.loaded.series.find((s) => s.seriesUID === A.seriesUID);
    const vol = buildVolume(series.slices);
    const byKey = new Map(A.rois.map((r) => [r.key, r]));
    const structures = A.slots.map((s) => ({
      name: s.name, refRoi: byKey.get(s.ref).roi, refName: byKey.get(s.ref).name,
      studentRois: [...s.students].map((k) => byKey.get(k)).map((r) => ({ roi: r.roi, name: `${r.name} [${r.file}]` })),
    }));
    const forMismatch = A.slots.flatMap((s) => [s.ref, ...s.students]).map((k) => byKey.get(k)).filter((r) => r.forUID && vol.forUID && r.forUID !== vol.forUID);
    A.case = await buildCase({ volume: vol, structures, marginMm: A.marginMm, marginSlices: A.marginSlices }, (f, m) => prog(f * 0.3, m));
    if (forMismatch.length) A.case.warnings.push(`${forMismatch.length} structure(s) reference a different Frame of Reference UID than the CT.`);
    A.baselines = await computeBaselines(A.case, (f, m) => prog(0.3 + f * 0.3, m));
    A.flags = A.case.structures.map((st, si) => st.students.map((s, i) => ({ pool: !s.empty, eligible: !s.empty && A.baselines[si][i].dsc > 0 })));
    A.loo = false;
    A.unc = [];
    for (let si = 0; si < A.case.structures.length; si++) {
      A.unc.push(await computeStructureUncertainty(A.case, si, A.flags[si], A.loo, (f, m) => prog(0.6 + (0.4 * (si + f)) / A.case.structures.length, m)));
    }
    A.rgTouched = false; A.reviewSi = 0;
    $('#buildstat').innerHTML = '';
    renderReview();
    renderPublish();
  } catch (e) {
    console.error(e);
    alertBox('#buildstat', e.message);
  }
}

// ------------------------------------------------------------------ C. review
async function recomputeStructure(si) {
  const st = $('#recalc');
  if (st) st.textContent = `Recomputing uncertainty for ${A.case.structures[si].name}…`;
  await tick();
  A.unc[si] = await computeStructureUncertainty(A.case, si, A.flags[si], A.loo);
  if (st) st.textContent = '';
}

function renderReview() {
  const c = A.case, g = c.grid, si = A.reviewSi, st = c.structures[si], B = A.baselines[si];
  const qd = quantiles(B.map((b) => b.dsc)), qs = quantiles(B.map((b) => b.sdsc[2])), qh = quantiles(B.map((b) => b.hd95));
  A.rg = A.rg ?? DEFAULT_STUDY_CONFIG.redgreen_agreement;
  A.band = A.band ?? DEFAULT_STUDY_CONFIG.threshold;
  const agree = A.unc[si].agreement;
  $('#reviewCard').innerHTML = `<div class="card"><h2 style="margin-top:0">C · Review</h2>
    <div class="kv"><b>Cropped grid</b><span>${g.nx} × ${g.ny} × ${g.nz} voxels, ${f2(g.dx)} × ${f2(g.dy)} × ${f2(g.dz)} mm</span>
      ${c.warnings.length ? `<b>Warnings</b><span>${c.warnings.map(esc).join('<br>')}</span>` : ''}</div>
    <div class="steps" id="revTabs" style="margin-top:12px">${c.structures.map((s, i) => `<span data-si="${i}" class="${i === si ? 'on' : ''}">${esc(s.name)}</span>`).join('')}</div>
    <div class="kv"><b>Reference</b><span>${esc(st.refName)}</span>
      <b>Students</b><span>${st.students.length} (median DSC ${f2(qd.med)} [IQR ${f2(qd.q1)}–${f2(qd.q3)}], surface DSC 2 mm ${f2(qs.med)}, HD95 ${f2(qh?.med, 1)} mm)</span></div>
    <p class="muted" style="margin-top:12px"><b>Pool</b> = used to compute the uncertainty. <b>Eligible</b> = may be given to participants to edit.
      <b>Unc. AUC</b> = how well the uncertainty tracks that contour's own errors (0.5 = uninformative, 1 = perfect).
      Empty contours are excluded. Student ROI names and the reference are never put in the participant file.</p>
    <div class="scroll-box"><table class="data" id="stab"><thead><tr><th>#</th><th>Source ROI</th><th>Pool</th><th>Eligible</th><th class="num">DSC</th><th class="num">sDSC 1/2/3 mm</th><th class="num">HD95</th><th class="num">MSD</th><th class="num">APL@1mm</th><th class="num">Vol cc</th><th class="num">Unc. AUC</th><th></th></tr></thead>
    <tbody>${st.students.map((s, i) => `<tr><td>${i + 1}</td><td>${esc(s.sourceName)}</td>
      <td><input type="checkbox" data-f="pool" data-i="${i}" ${A.flags[si][i].pool ? 'checked' : ''} ${s.empty ? 'disabled' : ''}></td>
      <td><input type="checkbox" data-f="eligible" data-i="${i}" ${A.flags[si][i].eligible ? 'checked' : ''} ${s.empty ? 'disabled' : ''}></td>
      <td class="num">${f2(B[i].dsc, 3)}</td><td class="num">${f2(B[i].sdsc[1])}/${f2(B[i].sdsc[2])}/${f2(B[i].sdsc[3])}</td>
      <td class="num">${f2(B[i].hd95, 1)}</td><td class="num">${f2(B[i].msd, 2)}</td><td class="num">${f2(B[i].apl_mm[1], 0)}</td><td class="num">${f2(B[i].vol_test_cc, 1)}</td>
      <td class="num">${agree.has(i) && agree.get(i).auc !== null ? agree.get(i).auc.toFixed(2) : '–'}</td>
      <td>${A.flags[si][i].eligible ? `<button data-view="${i}">View</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
    <div class="muted" id="recalc"></div>
    <h3>Preview exactly what participants will see</h3>
    <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
      <label>Display <select id="pmode">${MODE_IDS.map((m) => `<option value="${m}" ${A.pmode === m ? 'selected' : ''}>${MODES[m].label}</option>`).join('')}</select></label>
      <label>Contour <select id="pstud">${st.students.map((s, i) => (A.flags[si][i].eligible ? `<option value="${i}" ${A.pstud === i ? 'selected' : ''}>#${i + 1} ${esc(s.sourceName)}</option>` : '')).join('')}</select></label>
      <label title="Band = phat >= threshold; 0.10 is the central 80% interval for the true boundary">Band threshold <input type="range" id="pthr" min="0.02" max="0.45" step="0.01" value="${A.band}"> <span id="pthrv"></span></label>
      <label title="Red where fewer than this share of all contours agree with the reference within 2 mm">Red/green: red below <input type="range" id="prg" min="0.1" max="0.9" step="0.05" value="${A.rg}"> <span id="prgv"></span></label>
      <label class="check" style="display:flex"><input type="checkbox" id="ploo" ${A.loo ? 'checked' : ''}> Leave-one-out</label>
      <label class="check" style="display:flex"><input type="checkbox" id="pref" ${A.pref === false ? '' : 'checked'}> Show reference (admin only)</label>
    </div>
    <div class="muted" id="redstat" style="margin-bottom:6px"></div>
    <div class="preview-wrap"><div id="ptb"></div><div id="ped" style="min-height:0"></div><div id="psl"></div></div>
  </div>`;
  $('#revTabs').addEventListener('click', (e) => { const t = e.target.closest('[data-si]'); if (!t) return; A.reviewSi = +t.dataset.si; A.pstud = undefined; dropEditor(); renderReview(); });
  root.querySelectorAll('#stab input[data-f]').forEach((cb) => cb.addEventListener('change', async () => {
    A.flags[si][+cb.dataset.i][cb.dataset.f] = cb.checked;
    await recomputeStructure(si);
    renderReview();
  }));
  root.querySelectorAll('#stab button[data-view]').forEach((b) => b.addEventListener('click', () => { A.pstud = +b.dataset.view; $('#pstud').value = b.dataset.view; refreshPreview(); $('#ped').scrollIntoView({ block: 'center' }); }));
  $('#pmode').addEventListener('change', () => { A.pmode = $('#pmode').value; refreshPreview(); });
  $('#pstud').addEventListener('change', () => { A.pstud = +$('#pstud').value; refreshPreview(); });
  $('#pref').addEventListener('change', () => { A.pref = $('#pref').checked; refreshPreview(); });
  $('#ploo').addEventListener('change', async () => {
    A.loo = $('#ploo').checked;
    for (let s = 0; s < c.structures.length; s++) await recomputeStructure(s);
    syncPublish(); renderReview();
  });
  const lab = () => { $('#pthrv').textContent = (+$('#pthr').value).toFixed(2); $('#prgv').textContent = `${Math.round(100 * +$('#prg').value)}% agreement`; };
  ['#pthr', '#prg'].forEach((id) => $(id).addEventListener('input', () => {
    A.band = +$('#pthr').value; A.rg = +$('#prg').value; lab();
    clearTimeout(A._thrT); A._thrT = setTimeout(() => { refreshPreview(); syncPublish(); }, 200);
  }));
  lab();
  refreshPreview();
  syncPublish();
}

function refreshPreview() {
  const c = A.case, si = A.reviewSi, st = c.structures[si];
  const sel = $('#pstud');
  if (!sel || !sel.value) { $('#redstat').textContent = 'No eligible contours for this structure.'; dropEditor(); return; }
  const i = +sel.value;
  const data = A.unc[si].perStudent.get(i);
  const au = new AnchoredUncertainty(c.grid, st.students[i].mask, data);
  const disp = createDisplay($('#pmode').value, au, { threshold: A.band, redgreenAgree: A.rg });
  const k = A.editor ? A.editor.k : undefined;
  dropEditor();
  A.editor = new SliceEditor($('#ped'), {
    grid: c.grid, ct: c.ct, mask: st.students[i].mask.slice(), display: disp, readOnly: true, window: c.window || undefined,
    startSlice: k, overlays: $('#pref').checked ? [{ mask: st.gt, color: '#ff4d4d', dash: [5, 4], width: 1.5 }] : [],
  });
  buildToolbar($('#ptb'), A.editor);
  buildSliceSlider($('#psl'), A.editor);
  // red fraction (all structures) and informativeness for this structure
  let red = 0, tot = 0;
  A.unc.forEach((u) => { for (const d of u.perStudent.values()) for (const v of d.agree) { tot++; if (v < A.rg) red++; } });
  const aucs = [...A.unc[si].agreement.values()].map((a) => a.auc);
  const q = quantiles(aucs);
  $('#redstat').textContent = `Red/green (red where < ${Math.round(100 * A.rg)}% of contours agree within 2 mm): ${tot ? Math.round((100 * red) / tot) : 0}% of all eligible contour length would be red. `
    + `${st.name}: agreement of all contours with the reference (mean surface Dice 2 mm) ${data.overall2 ? Math.round(100 * data.overall2[0]) : '–'}% (not shown to participants). `
    + `${st.name}: uncertainty–error agreement (AUC) median ${q ? q.med.toFixed(2) : '–'} [${q ? `${q.min.toFixed(2)}–${q.max.toFixed(2)}` : ''}], pool ${A.unc[si].poolIdx.length} contours.`;
}

// ------------------------------------------------------------------ D. publish
function renderPublish() {
  const d = DEFAULT_STUDY_CONFIG;
  const nStruct = A.case.structures.length;
  $('#publishCard').innerHTML = `<div class="card"><h2 style="margin-top:0">D · Study settings and publish</h2>
    <div class="grid2">
      <div class="form-row"><label>Study name (internal)</label><input type="text" id="sname" value="FALCON H&N uncertainty display study"></div>
      <div class="form-row"><label>Contours per structure per participant</label><input type="number" id="cps" value="${d.contours_per_structure}" min="1" max="10">
        <div class="hint" id="cpshint"></div></div>
      <div class="form-row"><label>Display arms</label>${MODE_IDS.map((m) => `<label class="check"><input type="checkbox" data-mode="${m}" checked> ${MODES[m].label}</label>`).join('')}
        <div class="hint">Keep the control arm: it is the comparator for every display.</div></div>
      <div class="form-row"><label>How displays are assigned</label>
        <select id="assign"><option value="per_contour">Every display on every structure, one contour each (recommended)</option>
          <option value="per_structure">${nStruct > 1 ? `${nStruct} displays per participant, one per structure` : 'One display per structure'}</option>
          <option value="per_participant">One display per participant for all contours</option></select>
        <div class="hint" id="assignhint"></div></div>
      <div>
        <div class="form-row"><label>Band threshold <span class="muted">(0.10 = 80% interval for the true boundary)</span></label><input type="number" id="thr" value="${A.band ?? d.threshold}" min="0.02" max="0.45" step="0.01"></div>
        <div class="form-row"><label>Red/green: red where fewer than this share of contours agree within 2 mm</label><input type="number" id="rgthr" value="${A.rg ?? d.redgreen_agreement}" min="0.05" max="0.95" step="0.05"></div>
        <div class="form-row"><label>Heat-map transparency cut-off</label><input type="number" id="hmin" value="${d.heatmap_min}" min="0" max="0.5" step="0.01"></div>
        <div class="form-row"><label>APL tolerance (mm) for the main APL column</label><select id="apltol">${[0, 1, 2, 3].map((t) => `<option ${t === d.apl_tolerance_mm ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      </div>
      <div>
        <label class="check"><input type="checkbox" id="loo" ${A.loo ? 'checked' : ''} disabled> Leave-one-out uncertainty (set in the preview above)</label>
        <label class="check"><input type="checkbox" id="refv" checked> Show sagittal/coronal reference views</label>
        <label class="check"><input type="checkbox" id="prac" checked> Offer tool practice ("Would you like to practise…?")</label>
      </div>
      <div class="form-row"><label>Access code <span class="muted">(optional – participants must enter it)</span></label><input type="text" id="acode"></div>
      <div class="form-row" style="grid-column:1/-1"><label>Task instruction (shown for every contour)</label><textarea id="instr">${esc(d.task_instruction)}</textarea></div>
      <div class="form-row" style="grid-column:1/-1"><label>Custom welcome text (HTML, optional – replaces the default study information)</label><textarea id="intro" placeholder="Leave empty to use the default text"></textarea></div>
    </div>
    <div class="actions"><button class="primary big" id="pub">Publish &amp; make active</button></div>
    <div id="pubstat"></div></div>`;
  const hint = () => {
    const k = +$('#cps').value || 1;
    $('#cpshint').textContent = `${nStruct} structure${nStruct === 1 ? '' : 's'} × ${k} = ${nStruct * k} contours per participant (about ${Math.round(nStruct * k * 4)} min).`;
    const modes = [...root.querySelectorAll('[data-mode]')].filter((c) => c.checked).map((c) => c.dataset.mode);
    const others = modes.filter((m) => m !== 'none').length;
    const a = $('#assign').value;
    $('#assignhint').textContent = a === 'per_contour'
      ? (k % modes.length === 0
        ? `Each participant sees all ${modes.length} displays on every structure (${k / modes.length} contour${k === modes.length ? '' : 's'} per display per structure). Display order is counterbalanced (Williams design; the second structure in reverse order). They rank all ${modes.length} at the end.`
        : `Set contours per structure to ${modes.length} (or a multiple) so every display appears equally often on every structure. With ${k}, displays rotate across structures.`)
      : a === 'per_participant'
      ? 'Each participant sees one display throughout; displays are compared between people.'
      : (modes.includes('none') && nStruct > 1
        ? `Each participant sees control + ${Math.min(nStruct, modes.length) - 1} of the ${others} other displays, one per structure, balanced across participants. They rank the displays at the end.`
        : `Each participant sees ${Math.min(nStruct, modes.length)} of the selected displays, one per structure.`);
  };
  $('#cps').addEventListener('input', hint);
  $('#assign').addEventListener('change', hint);
  root.querySelectorAll('[data-mode]').forEach((c) => c.addEventListener('change', hint));
  hint();
  $('#pub').onclick = () => publish();
}

function syncPublish() {
  const t = $('#thr'); if (t) t.value = A.band;
  const r = $('#rgthr'); if (r) r.value = A.rg;
  const l = $('#loo'); if (l) l.checked = A.loo;
}

function readConfig() {
  return {
    ...DEFAULT_STUDY_CONFIG,
    structure_names: A.case.structures.map((s) => s.name),
    display_modes: [...root.querySelectorAll('[data-mode]')].filter((c) => c.checked).map((c) => c.dataset.mode),
    contours_per_structure: Math.max(1, +$('#cps').value || 1),
    display_assignment: $('#assign').value,
    threshold: +$('#thr').value,
    redgreen_agreement: +$('#rgthr').value,
    heatmap_min: +$('#hmin').value,
    apl_tolerance_mm: +$('#apltol').value,
    leave_one_out: A.loo,
    reference_views: $('#refv').checked,
    offer_practice: $('#prac').checked,
    access_code: $('#acode').value.trim(),
    task_instruction: $('#instr').value.trim() || DEFAULT_STUDY_CONFIG.task_instruction,
    intro_html: $('#intro').value.trim(),
  };
}

async function publish() {
  const cfg = readConfig();
  if (cfg.display_modes.length < 2) return alertBox('#pubstat', 'Select at least two display arms.');
  for (const [si, st] of A.case.structures.entries()) {
    if (A.flags[si].filter((f) => f.pool).length < 2) return alertBox('#pubstat', `${st.name}: the uncertainty pool needs at least two contours.`);
    const ne = A.flags[si].filter((f) => f.eligible).length;
    if (ne < cfg.contours_per_structure) return alertBox('#pubstat', `${st.name}: only ${ne} eligible contours, fewer than ${cfg.contours_per_structure} per participant.`);
  }
  $('#pubstat').innerHTML = '<div class="spinner"></div>';
  try {
    const pk = await makePackages(A.case, { caseLabel: 'case', structureNames: cfg.structure_names }, A.flags, A.unc, A.loo);
    const students = [];
    pk.kept.forEach((ids, si) => ids.forEach((orig, n) => students.push({
      structure_index: si, student_id: n, label: `S${String(n + 1).padStart(2, '0')}`, source_name: A.case.structures[si].students[orig].sourceName,
      baseline: { ...A.baselines[si][orig], unc_agreement: A.unc[si].agreement.get(orig) || null },
      included: !!A.flags[si][orig].eligible, in_pool: !!A.flags[si][orig].pool,
    })));
    cfg.n_students = A.case.structures.map((_, si) => pk.kept[si].length);
    cfg.reference_names = A.case.structures.map((s) => s.refName);
    const st = await A.backend.publishStudy({
      name: $('#sname').value.trim() || 'Study', config: cfg, packageBytes: pk.participant.bytes, sha256: pk.participant.sha256,
      referenceBytes: pk.reference.bytes, referenceSha256: pk.reference.sha256, students,
    });
    const link = new URL('index.html', location.href).href;
    $('#pubstat').innerHTML = `<div class="note-box"><b>Published and active.</b> Study id <code>${esc(st.id)}</code>.
      Participant file ${(pk.participant.bytes.length / 1048576).toFixed(1)} MB (no reference); reference file ${(pk.reference.bytes.length / 1024).toFixed(0)} KB (admin only).<br>
      Participant link: <a href="${link}" target="_blank">${esc(link)}</a></div>`;
  } catch (e) {
    console.error(e);
    alertBox('#pubstat', e.message);
  }
}

// ------------------------------------------------------------------ studies
async function studiesTab() {
  dropEditor();
  $('#tab').innerHTML = '<div class="card"><div class="spinner"></div></div>';
  try {
    const studies = await A.backend.listStudies();
    $('#tab').innerHTML = `<div class="card"><h2 style="margin-top:0">Studies</h2>
      ${studies.length ? `<table class="data"><thead><tr><th>Name</th><th>Created</th><th>Structures</th><th>Arms</th><th>Status</th><th></th></tr></thead><tbody>
      ${studies.map((s) => `<tr><td>${esc(s.name)}<div class="muted" style="font-size:.78rem">${esc(s.id)}</div></td><td>${new Date(s.created_at).toLocaleString()}</td>
        <td>${(s.config?.structure_names || []).map(esc).join(', ')} <span class="muted">× ${s.config?.contours_per_structure ?? '?'}</span>
          <div class="muted" style="font-size:.78rem">${{ per_participant: 'one display per participant', per_structure: 'one display per structure' }[s.config?.display_assignment] || 'every display on every structure'}</div></td>
        <td>${(s.config?.display_modes || []).map((m) => `<span class="tag">${m}</span>`).join(' ')}</td>
        <td>${s.is_active ? '<span class="tag ok">active</span>' : ''}</td>
        <td><button data-dl="${s.id}" title="Participant case file (no reference)">Case file</button>
          <button data-dlref="${s.id}" title="Reference file, needed by analysis/recompute_metrics.py">Reference file</button>
          ${s.is_active ? '' : `<button data-act="${s.id}">Make active</button>`}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No studies yet.</p>'}
      ${A.backend.mode === 'local' ? '<div class="actions"><button class="danger" id="reset">Delete all local demo data</button></div>' : ''}<div id="sterr"></div></div>`;
    root.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => { await A.backend.setActiveStudy(b.dataset.act); studiesTab(); }));
    const dl = async (id, ref) => {
      const st = studies.find((x) => x.id === id);
      try { download(ref ? `reference_${st.id}.fucp` : `case_${st.id}.fucp`, ref ? await A.backend.loadReference(st) : await A.backend.loadPackage(st)); } catch (e) { alertBox('#sterr', e.message); }
    };
    root.querySelectorAll('[data-dl]').forEach((b) => b.addEventListener('click', () => dl(b.dataset.dl, false)));
    root.querySelectorAll('[data-dlref]').forEach((b) => b.addEventListener('click', () => dl(b.dataset.dlref, true)));
    const r = $('#reset');
    if (r) r.onclick = async () => { await A.backend.resetLocalData(); Object.keys(localStorage).filter((k) => k.startsWith('fucp-')).forEach((k) => localStorage.removeItem(k)); studiesTab(); };
  } catch (e) { alertBox('#tab', e.message); }
}

// ------------------------------------------------------------------ results (+ scoring against the reference)
async function scoreNew(study, rows, onProgress) {
  const todo = rows.filter((r) => r.status === 'completed' && !r.scored_at && r.edited_mask_rle);
  if (!todo.length) return 0;
  A.refCache = A.refCache || new Map();
  if (!A.refCache.has(study.id)) A.refCache.set(study.id, await loadReferencePackage(await A.backend.loadReference(study)));
  const ref = A.refCache.get(study.id);
  const contours = await A.backend.studentContours(study.id);
  const agree = new Map(contours.map((s) => [`${s.structure_index}:${s.student_id}`, s.baseline?.unc_agreement || null]));
  const tol = study.config?.apl_tolerance_mm ?? 1;
  let n = 0;
  for (const r of todo) {
    onProgress(n / todo.length, `Scoring ${n + 1}/${todo.length}`);
    await tick();
    const cols = scoreTrial(ref, r, tol);
    cols.uncertainty_quality = agree.get(`${r.structure_index}:${r.student_id}`) || null;
    await A.backend.updateTrialScores(r.id, cols);
    Object.assign(r, cols);
    n++;
  }
  return n;
}

async function resultsTab() {
  dropEditor();
  $('#tab').innerHTML = '<div class="card"><div class="spinner"></div></div>';
  try {
    const studies = await A.backend.listStudies();
    if (!studies.length) { $('#tab').innerHTML = '<div class="card"><p class="muted">No studies yet.</p></div>'; return; }
    const cur = A.resultsStudy && studies.find((s) => s.id === A.resultsStudy) ? A.resultsStudy : (studies.find((s) => s.is_active) || studies[0]).id;
    A.resultsStudy = cur;
    const study = studies.find((s) => s.id === cur);
    const rows = await A.backend.fetchResults(cur);
    $('#tab').innerHTML = '<div class="card"><h2 style="margin-top:0">Results</h2><div id="scorestat"></div></div>';
    let scored = 0;
    try { scored = await scoreNew(study, rows, progressIn('#scorestat')); } catch (e) { console.error(e); A.scoreError = e.message; }
    const names = study.config?.structure_names || [];
    const modes = study.config?.display_modes || MODE_IDS;
    const strata = [...new Set(Object.values(STRATA))];
    const parts = new Map();
    for (const r of rows) {
      const p = parts.get(r.participant_id) || { stratum: r.stratum, total: 0, done: 0, q: r.participant?.questionnaire };
      p.total++; if (r.status === 'completed') p.done++;
      parts.set(r.participant_id, p);
    }
    const pc = (m, s) => {
      const tr = rows.filter((r) => r.display_mode === m && r.stratum === s);
      return `${tr.filter((r) => r.status === 'completed').length} / ${tr.length}`;
    };
    const finished = [...parts.values()].filter((p) => p.q);
    const rankStats = modes.map((m) => {
      const rs = finished.map((p) => p.q.ranking?.[m]).filter((v) => v);
      return { m, n: rs.length, mean: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null, first: rs.filter((v) => v === 1).length };
    });
    const done = rows.filter((r) => r.status === 'completed');
    $('#tab').innerHTML = `<div class="card"><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <h2 style="margin:0">Results</h2><select id="rs">${studies.map((s) => `<option value="${s.id}" ${s.id === cur ? 'selected' : ''}>${esc(s.name)} (${new Date(s.created_at).toLocaleDateString()})</option>`).join('')}</select>
        <span style="flex:1"></span><button id="csv">Download CSV</button><button id="json">Download full JSON</button><button id="refresh">Refresh</button></div>
      <p class="muted">${scored ? `${scored} newly submitted contour(s) were scored against the reference just now. ` : ''}${A.scoreError ? `<span style="color:#ff9b9b">Scoring failed: ${esc(A.scoreError)}</span>` : ''}
        Metrics are computed here in the admin page, because participants never receive the reference.</p>
      <p>${parts.size} participant(s) started, ${[...parts.values()].filter((p) => p.done === p.total).length} finished all contours, ${finished.length} completed the questionnaire.</p>
      <div class="grid2"><div>
      <h3>Contours per display (submitted / assigned)</h3>
      <table class="data"><thead><tr><th>Display</th>${strata.map((s) => `<th class="num">${s}</th>`).join('')}</tr></thead><tbody>
      ${modes.map((m) => `<tr><td>${esc(MODES[m]?.label || m)}</td>${strata.map((s) => `<td class="num">${pc(m, s)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <div><h3>End-of-study ranking (1 = most helpful)</h3>
      <table class="data"><thead><tr><th>Display</th><th class="num">Ranked by</th><th class="num">Mean rank</th><th class="num">Ranked 1st</th></tr></thead><tbody>
      ${rankStats.map((r) => `<tr><td>${esc(MODES[r.m]?.label || r.m)}</td><td class="num">${r.n}</td><td class="num">${f2(r.mean, 2)}</td><td class="num">${r.n ? `${r.first} (${Math.round((100 * r.first) / r.n)}%)` : '–'}</td></tr>`).join('')}</tbody></table>
      <div class="muted" style="font-size:.8rem">Each participant ranks the displays they used; analysis/analyze.py fits a Plackett–Luce model.</div></div></div>
      <h3>Submitted contours (${done.length})</h3>
      <div class="scroll-box"><table class="data"><thead><tr><th>When</th><th>Participant</th><th>Role</th><th>Part</th><th>Display</th><th>Structure</th><th class="num">#</th><th class="num">sDSC 2 mm before → after</th><th class="num">DSC after</th><th class="num">HD95</th><th class="num">Edited path</th><th class="num">Active min</th><th class="num">Conf.</th></tr></thead><tbody>
      ${done.map((r) => `<tr><td>${new Date(r.completed_at).toLocaleString()}</td><td class="muted">${esc(String(r.participant_id).slice(0, 8))} · ${r.trial_index + 1}</td><td>${esc(r.participant?.role || '')}</td><td class="num">${(r.block_index ?? 0) + 1}</td><td>${esc(r.display_mode)}</td>
        <td>${esc(names[r.structure_index] ?? r.structure_index)}</td><td class="num">${r.student_id}</td>
        <td class="num">${f2(r.baseline_sdsc_2mm, 3)} → <b>${f2(r.sdsc_2mm, 3)}</b></td><td class="num">${f2(r.dsc, 3)}</td>
        <td class="num">${f2(r.hd95_mm, 1)}</td><td class="num">${f2(r.edit_apl_mm, 0)}</td><td class="num">${f2((r.active_time_s || 0) / 60, 1)}</td><td class="num">${r.questionnaire?.confidence ?? ''}</td></tr>`).join('')}</tbody></table></div>
    </div>`;
    A.scoreError = null;
    $('#rs').onchange = (e) => { A.resultsStudy = e.target.value; resultsTab(); };
    $('#refresh').onclick = () => resultsTab();
    $('#csv').onclick = () => download(`results_${cur}.csv`, toCSV(rows, names), 'text/csv');
    $('#json').onclick = async () => {
      const students = await A.backend.studentContours(cur);
      download(`results_${cur}.json`, JSON.stringify({ study, students, trials: rows }), 'application/json');
    };
  } catch (e) { alertBox('#tab', e.message); }
}

export function flattenRow(r, names = []) {
  const p = r.participant || {};
  const prof = p.profile || {};
  const m = r.metrics || {};
  const fo = m.final_vs_ref || {}, ob = m.original_vs_ref || {}, ch = m.original_vs_final || {};
  const pq = p.questionnaire || {};
  const it = r.interaction || {};
  const pr = it.practice || {};
  return {
    trial_id: r.id, participant_id: r.participant_id, study_id: r.study_id, case_order: r.trial_index, status: r.status,
    role: p.role ?? prof.role, stratum: r.stratum, years_experience: prof.years_experience, hn_frequency: prof.hn_frequency,
    ai_experience: prof.ai_experience, colour_vision_deficiency: prof.colour_vision_deficiency, input_device: prof.input_device, country: prof.country,
    display_mode: r.display_mode, block_index: r.block_index ?? 0, structure_index: r.structure_index, structure: names[r.structure_index] ?? '', student_id: r.student_id,
    assigned_at: r.assigned_at, started_at: r.started_at, completed_at: r.completed_at, scored_at: r.scored_at,
    duration_s: r.duration_s, active_time_s: r.active_time_s, n_edit_actions: r.n_edit_actions, n_slices_edited: r.n_slices_edited, changed_voxels: r.changed_voxels,
    dsc: r.dsc, sdsc_1mm: r.sdsc_1mm, sdsc_2mm: r.sdsc_2mm, sdsc_3mm: r.sdsc_3mm, hd_mm: r.hd_mm, hd95_mm: r.hd95_mm, msd_mm: r.msd_mm, apl_mm: r.apl_mm,
    apl_0mm: fo.apl_mm?.[0], apl_2mm: fo.apl_mm?.[2], apl_3mm: fo.apl_mm?.[3], edit_apl_mm: r.edit_apl_mm,
    baseline_dsc: r.baseline_dsc, baseline_sdsc_1mm: ob.sdsc?.[1], baseline_sdsc_2mm: r.baseline_sdsc_2mm, baseline_sdsc_3mm: ob.sdsc?.[3],
    baseline_hd_mm: ob.hd, baseline_hd95_mm: r.baseline_hd95_mm, baseline_msd_mm: ob.msd, baseline_apl_mm: r.baseline_apl_mm,
    change_dsc: ch.dsc, change_hd_mm: ch.hd,
    q_case_confidence: r.questionnaire?.confidence,
    rank_of_this_display: pq.ranking?.[r.display_mode], displays_seen: (pq.displays || []).join('|'), ranking_order: (pq.ranking_order || []).join('>'),
    ...Object.fromEntries(MODE_IDS.map((m) => [`rank_${m}`, pq.ranking?.[m] ?? ''])),
    q_trust: pq.trust, q_display_helpful: pq.display_helpful, q_display_understandable: pq.display_understandable,
    q_display_reliance: pq.display_reliance, q_display_clinical: pq.display_clinical, q_mental_effort: pq.mental_effort, q_comments: pq.comments,
    practice_offered: pr.offered, practice_chosen: pr.chosen, practice_seconds: pr.seconds, practice_edits: pr.edits,
    uncertainty_hidden_ms: it.uncertainty_hidden_ms, page_sessions: it.page_sessions,
    unc_auc: r.uncertainty_quality?.auc, unc_mean_E_mm: r.uncertainty_quality?.mean_E,
    leave_one_out: r.display_params?.leave_one_out, band_threshold: r.display_params?.threshold, redgreen_agreement: r.display_params?.redgreenAgree,
    app_version: r.app_version,
  };
}

function toCSV(rows, names) {
  const flat = rows.map((r) => flattenRow(r, names));
  if (!flat.length) return '';
  const cols = Object.keys(flat[0]);
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...flat.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
}

init();
