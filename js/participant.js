// Participant flow:
//   consent -> background -> "practise first?" -> (practice) -> display explanation
//   -> [case intro -> edit -> confidence + submit] x (structures x contours per structure)
//   -> end questionnaire -> thank you
// The reference contour is never downloaded to the participant's browser; scoring happens on the
// admin side (admin page or analysis/recompute_metrics.py).

import { createBackend, APP_VERSION, DEFAULT_STUDY_CONFIG, lsGet, lsSet, lsDel } from './backend.js';
import { loadParticipantPackage } from './casebuilder.js';
import { AnchoredUncertainty } from './uncertainty.js';
import { createDisplay, displayGraphic, FRIENDLY } from './displays.js';
import { SliceEditor, buildToolbar, buildSliceSlider } from './viewer.js';
import { rleEncode, rleDecode } from './rle.js';
import { maskToPatientContours } from './contour.js';
import { makePracticeCase, dice2 } from './practice.js';
import { ROLE_LABELS, planBlocks as blocksOf } from './allocation.js';

const app = document.getElementById('app');
const S = {};
if (new URLSearchParams(location.search).has('debug')) window.__study = S; // automated tests only
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const title = () => (window.STUDY_CONFIG && window.STUDY_CONFIG.studyTitle) || 'Contour editing study';
const brand = () => `<div class="brand"><span class="dot"></span>${esc(title())}</div>`;
const sessionKey = () => `fucp-session:${S.study.id}`;
const saveSession = () => lsSet(sessionKey(), S.session);

function show(html) { app.innerHTML = html; window.scrollTo(0, 0); }
function page(inner) { show(`<div class="page">${brand()}<div class="card">${inner}</div></div>`); }
function fatal(msg) {
  page(`<h1>Something went wrong</h1><div class="error-box">${esc(msg)}</div><div class="actions"><button onclick="location.reload()">Reload</button></div>`);
}
function modal(html, buttons, validate = null) {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal">${html}<div class="actions">${buttons.map((b, i) => `<button data-i="${i}" class="${b.cls || ''}">${esc(b.label)}</button>`).join('')}</div></div>`;
    bg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]');
      if (!b) return;
      const val = buttons[+b.dataset.i].value;
      if (val && validate && !validate(bg)) return;
      const extra = validate ? validate(bg) : null;
      bg.remove();
      resolve(val ? (extra || val) : val);
    });
    document.body.appendChild(bg);
  });
}
function likert(id, q, n, lo, hi) {
  return `<div class="likert" data-id="${id}"><div class="q">${q}</div>
    <div class="scale">${Array.from({ length: n }, (_, i) => `<label><input type="radio" name="${id}" value="${i + 1}" required><span>${i + 1}</span></label>`).join('')}</div>
    <div class="ends" style="max-width:${n * 44}px"><span>${lo}</span><span>${hi}</span></div></div>`;
}
function clientInfo() {
  return {
    ua: navigator.userAgent, screen: [screen.width, screen.height], viewport: [innerWidth, innerHeight],
    dpr: devicePixelRatio, fine_pointer: matchMedia('(pointer: fine)').matches, touch: navigator.maxTouchPoints || 0,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
const structureNames = () => (S.caseHeader?.structures || []).map((s) => s.name);
const K = () => S.cfg.contours_per_structure || 3;
const planSummary = () => {
  const names = structureNames();
  if (!names.length) return 'several proposed contours';
  return `${names.length * K()} proposed contours: ${names.map((n) => `${K()} × ${esc(n)}`).join(', ')}`;
};
// plan = one entry per case [{trial_index, block_index, structure_index, display_mode}]
const planList = () => (Array.isArray(S.session?.plan) && S.session.plan.every((x) => 'trial_index' in x) ? S.session.plan : []);
const planBlocks = () => blocksOf(planList());
const planDisplays = () => [...new Set(planList().map((t) => t.display_mode))];
const assignment = () => S.cfg.display_assignment || 'per_contour';
const structName = (si) => S.case?.structures[si]?.name || S.caseHeader?.structures?.[si]?.name || 'structure';
const WORDS = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'];
const ORD = ['', '1st', '2nd', '3rd', '4th', '5th', '6th'];
function progressHTML(done, total) {
  const pctDone = total ? Math.round((100 * done) / total) : 0;
  return `<div class="progress" style="margin:14px 0 4px"><div style="width:${pctDone}%"></div></div>
    <div class="muted" style="font-size:.85rem">${done} of ${total} contours done</div>`;
}
/** Position of a trial in its part: {part, nParts, index, n} */
function partInfo(trial) {
  const blocks = planBlocks();
  const b = blocks.find((x) => x.block_index === trial.block_index);
  const first = b ? b.first : blocks.filter((x) => x.block_index < trial.block_index).reduce((a, x) => a + x.n, 0);
  return { part: (trial.block_index ?? 0) + 1, nParts: blocks.length || 1, index: trial.trial_index - first + 1, n: b ? b.n : K() };
}

// ------------------------------------------------------------------ startup
async function init() {
  try {
    S.backend = createBackend();
    S.study = await S.backend.getActiveStudy();
  } catch (e) { return fatal(e.message); }
  if (!S.study) {
    return page(`<h1>No active study</h1><p>There is no study open at the moment. If you are the researcher, publish a case from the <a href="admin.html">admin console</a>.</p>`);
  }
  S.cfg = { ...DEFAULT_STUDY_CONFIG, ...(S.study.config || {}) };
  S.session = lsGet(sessionKey());
  S.casePromise = (async () => {
    const c = await loadParticipantPackage(await S.backend.loadPackage(S.study));
    S.caseHeader = c.header;
    return c;
  })();
  S.casePromise.catch(() => {});
  if (S.session?.finished) return doneScreen();
  if (!S.session?.participantId) return welcomeScreen();
  if (S.session.stage === 'practice_question') return practiceQuestion();
  if (S.session.stage === 'questionnaire') return questionnaireScreen();
  return nextCase();
}

// ------------------------------------------------------------------ consent + background
async function welcomeScreen() {
  try { await S.casePromise; } catch { /* shown later */ }
  const intro = S.cfg.intro_html || `
    <p>This study looks at how clinicians edit proposed contours on CT, and how the way a contouring
    model's <b>uncertainty</b> is presented affects those edits.</p>
    <p>You will:</p>
    <ol>
      <li>answer a few questions about your background (no identifying information),</li>
      <li>optionally practise the editing tools on a simple phantom (about 2 minutes),</li>
      <li>edit ${planSummary()} on a head-and-neck CT, slice by slice. ${{
    per_participant: 'The model\'s uncertainty is shown in one way (assigned at random)',
    per_structure: 'Each structure comes with a different way of showing the model\'s uncertainty (assigned at random)',
  }[assignment()] || `Each contour comes with one of ${WORDS[(S.cfg.display_modes || []).length]?.toLowerCase() || 'several'} ways of showing the model's uncertainty (including none), in a random order; you will meet every way on each structure`},</li>
      <li>answer a short questionnaire${assignment() === 'per_participant' ? '' : ', including ranking the displays'}.</li>
    </ol>
    <p>Please use a desktop or laptop computer with a mouse if possible, and allow about 30–45 minutes.
    Your progress is saved after every contour, so you can take a break between contours.
    Your edited contours, timings, interactions with the tool and questionnaire answers are stored anonymously for research.</p>`;
  page(`<h1>Welcome</h1>${intro}
    <label class="check"><input type="checkbox" id="consent"> <span>I have read the information above, I am a radiotherapy professional, and I agree to take part. I understand my anonymous data will be used for research.</span></label>
    <div class="actions"><button class="primary big" id="go" disabled>Continue</button></div>`);
  const c = document.getElementById('consent'), go = document.getElementById('go');
  c.addEventListener('change', () => { go.disabled = !c.checked; });
  go.addEventListener('click', () => profileScreen(new Date().toISOString()));
}

function profileScreen(consentAt) {
  const sel = (id, opts) => `<select id="${id}" required><option value="">– select –</option>${opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>`;
  page(`<h1>About you</h1>
    <form id="f">
      <div class="form-row"><label for="role">Professional role</label>${sel('role', Object.entries(ROLE_LABELS))}</div>
      <div class="form-row"><label for="years">Years working in radiotherapy</label><input type="number" id="years" min="0" max="60" step="0.5" required></div>
      <div class="form-row"><label for="hn">How often do you contour or edit head-and-neck structures?</label>
        ${sel('hn', [['never', 'Never'], ['lt_monthly', 'Less than once a month'], ['monthly', '1–4 cases per month'], ['weekly', 'More than 4 cases per month']])}</div>
      <div class="form-row"><label for="ai">Experience editing AI / auto-contours in clinical practice</label>
        ${sel('ai', [['never', 'Never'], ['occasional', 'Occasionally'], ['routine', 'Routinely']])}</div>
      <div class="form-row"><label for="cvd">Do you have a colour-vision deficiency (colour blindness)?</label>
        ${sel('cvd', [['no', 'No'], ['yes', 'Yes'], ['unsure', 'Not sure / prefer not to say']])}</div>
      <div class="form-row"><label for="input">What are you using to draw right now?</label>
        ${sel('input', [['mouse', 'Mouse'], ['trackpad', 'Trackpad'], ['pen', 'Pen / stylus'], ['touch', 'Touchscreen'], ['other', 'Other']])}</div>
      <div class="form-row"><label for="country">Country of practice <span class="muted">(optional)</span></label><input type="text" id="country" maxlength="60"></div>
      ${S.cfg.access_code || S.cfg.requires_access_code ? '<div class="form-row"><label for="code">Study access code</label><input type="text" id="code" required autocomplete="off"></div>' : ''}
      <div id="err"></div>
      <div class="actions"><button class="primary big" type="submit">Continue</button></div>
    </form>`);
  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = (id) => (document.getElementById(id) || {}).value || '';
    const profile = {
      role: v('role'), years_experience: parseFloat(v('years')), hn_frequency: v('hn'), ai_experience: v('ai'),
      colour_vision_deficiency: v('cvd'), input_device: v('input'), country: v('country').trim(),
      consent_at: consentAt, client: clientInfo(), app_version: APP_VERSION, access_code: v('code'),
    };
    const btn = e.submitter; btn.disabled = true;
    try {
      const r = await S.backend.registerParticipant(S.study.id, profile);
      delete profile.access_code;
      S.session = { participantId: r.participantId, token: r.token, profile, stage: 'practice_question', done: [] };
      saveSession();
      practiceQuestion();
    } catch (err) {
      btn.disabled = false;
      document.getElementById('err').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    }
  });
}

// ------------------------------------------------------------------ practice (optional)
function practiceQuestion() {
  const proceed = (chosen) => {
    S.session.practice = { offered: !!S.cfg.offer_practice, chosen };
    S.session.stage = 'cases';
    saveSession();
    if (chosen) practiceScreen(); else nextCase();
  };
  if (!S.cfg.offer_practice) return proceed(false);
  page(`<h1>Before you start</h1>
    <p style="font-size:1.1rem">Would you like to practise using the available contouring tools before you start?</p>
    <p class="muted">The practice uses a simple phantom, not the study CT, and takes about 2 minutes. It is not recorded as study data.</p>
    <div class="actions"><button class="big" id="no">No, start the study</button><button class="primary big" id="yes">Yes, practise first</button></div>`);
  document.getElementById('yes').onclick = () => proceed(true);
  document.getElementById('no').onclick = () => proceed(false);
}

function workspaceHTML(topLeft, topRight, sideHTML) {
  return `<div class="workspace">
    <div class="topbar"><span class="title">${topLeft}</span><span class="spacer"></span>${topRight}</div>
    <div id="tb"></div>
    <div class="ws-body"><div id="ed"></div><div class="ws-side">${sideHTML}</div></div>
    <div id="sl"></div>
  </div>`;
}
const helpHTML = `<h3>How to edit</h3><ul class="help-list">
  <li><b>Scroll wheel</b> or <kbd>↑</kbd><kbd>↓</kbd>: change slice</li>
  <li><b>Brush</b> <kbd>1</kbd>: paint to add (hold <kbd>Shift</kbd> to erase)</li>
  <li><b>Eraser</b> <kbd>2</kbd>, <b>Draw +</b> <kbd>3</kbd> / <b>Draw −</b> <kbd>4</kbd>: outline an area to add / cut</li>
  <li><kbd>[</kbd> <kbd>]</kbd> brush size · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo</li>
  <li><b>Zoom</b>: − / + buttons, <kbd>Ctrl</kbd>+scroll, <kbd>+</kbd> <kbd>−</kbd> keys or pinch</li>
  <li><b>Pan</b>: Pan tool <kbd>5</kbd>, middle-drag or <kbd>Space</kbd>+drag</li>
  <li><b>Window/level</b>: presets menu, or right-drag on the image</li>
  <li><kbd>H</kbd> hide contour · click the sagittal/coronal views to jump to a slice</li></ul>`;

function practiceScreen() {
  const P = makePracticeCase();
  const mask = P.auto.slice();
  const t0 = performance.now();
  show(workspaceHTML('Practice: learn the editing tools', '<span class="pill">Practice – not recorded as study data</span>', `
    <div><h3>Your task</h3><p style="font-size:.9rem">Make the <b style="color:#19d3ff">blue contour</b> match the <b style="color:#ffd84d">dashed yellow outline</b> on every slice.
    Try each tool: brush, eraser, Draw + and Draw −, undo, zoom, window/level and moving between slices. One slice has a spurious blob; the top slice is missing.</p>
    <div class="note-box">Match with target: <b id="match">–</b></div></div>
    ${helpHTML}<div class="grow"></div>
    <button class="primary big" id="done">I'm ready – start the study</button>`));
  const ed = new SliceEditor(document.getElementById('ed'), {
    grid: P.grid, ct: P.ct, mask, window: P.window, referenceViews: false,
    overlays: [{ mask: P.target, color: '#ffd84d', dash: [6, 4], width: 1.5 }],
    onChange: () => upd(),
  });
  S.editor = ed;
  buildToolbar(document.getElementById('tb'), ed);
  buildSliceSlider(document.getElementById('sl'), ed);
  const upd = () => { document.getElementById('match').textContent = `${Math.round(dice2(mask, P.target) * 100)}%`; };
  upd();
  document.getElementById('done').addEventListener('click', () => {
    Object.assign(S.session.practice, { seconds: Math.round((performance.now() - t0) / 1000), edits: ed.nEdits, final_match: +dice2(mask, P.target).toFixed(3) });
    saveSession();
    ed.destroy();
    nextCase();
  });
}

// ------------------------------------------------------------------ cases
async function nextCase() {
  page('<p>Preparing your next contour…</p><div class="spinner"></div>');
  let trial;
  try {
    [trial, S.case] = await Promise.all([S.backend.nextTrial(S.session.participantId, S.session.token), S.casePromise]);
  } catch (e) { return fatal(`Could not continue: ${e.message}`); }
  if (!trial) {
    S.session.stage = 'questionnaire';
    saveSession();
    return questionnaireScreen();
  }
  S.trial = trial;
  if (trial.plan) S.session.plan = trial.plan;
  S.session.mode = trial.display_mode;
  saveSession();
  if (!S.session.introSeen) return introScreen(trial);
  caseIntro(trial);
}

function makeDisplay(trial) {
  const params = { threshold: S.cfg.threshold, heatmapMin: S.cfg.heatmap_min, redgreenAgree: S.cfg.redgreen_agreement ?? 0.5 };
  if (S.cfg.redgreen_threshold_mm) params.redgreenMm = S.cfg.redgreen_threshold_mm;
  const st = S.case.structures[trial.structure_index];
  const s = st && st.students.get(trial.student_id);
  if (!s) throw new Error('Assigned contour not found in the case file.');
  const au = new AnchoredUncertainty(S.case.grid, s.mask, s.unc);
  return { display: createDisplay(trial.display_mode, au, params), au, original: s.mask, params };
}

// One visual page introducing every display this participant will meet.
function introScreen(trial) {
  const blocks = planBlocks().length ? planBlocks()
    : [{ block_index: 0, structure_index: trial.structure_index, displays: [trial.display_mode], n: trial.n_total, first: 0 }];
  const displays = [...new Set(blocks.flatMap((b) => b.displays))];
  const onePerBlock = displays.length > 1 && blocks.every((b) => new Set(b.displays).size === 1);
  const card = (d, size, extra = '') => `<div class="intro-card">${displayGraphic(d, size)}${extra}
      <div class="intro-name">${FRIENDLY[d].name}</div><div class="intro-line">${FRIENDLY[d].line}</div></div>`;
  let cards, sub;
  const parts = `${blocks.length} part${blocks.length === 1 ? '' : 's'}${blocks.length > 1 ? ` (${blocks.map((b) => esc(structName(b.structure_index))).join(', ')})` : ''} · ${blocks[0].n} contour${blocks[0].n === 1 ? '' : 's'} each`;
  if (displays.length === 1) {
    cards = card(displays[0], 300);
    sub = parts;
  } else if (onePerBlock) {
    cards = blocks.map((b) => card(b.displays[0], 260, `<div class="intro-part">Part ${b.block_index + 1} · ${esc(structName(b.structure_index))}</div>`)).join('');
    sub = parts;
  } else {
    cards = displays.map((d) => card(d, 230)).join('');
    sub = `${parts} · every contour uses one of these ${WORDS[displays.length]?.toLowerCase() || displays.length} displays, so you will see each of them on ${blocks.length > 1 ? 'every structure' : 'this structure'}. Before each contour you will be shown which one comes next.`;
  }
  page(`<h1>How the model's uncertainty will be shown</h1>
    <p class="muted">${sub}</p>
    <div class="intro-grid">${cards}</div>
    <div class="note-box"><b>For every contour:</b> ${esc(S.cfg.task_instruction)}</div>
    <div class="actions"><button class="primary big" id="start">Start part 1</button></div>`);
  document.getElementById('start').addEventListener('click', () => {
    S.session.introSeen = true;
    S.session.lastBlockShown = trial.block_index ?? 0;
    S.session.lastModeShown = trial.display_mode;
    saveSession();
    trialScreen(trial);
  });
}

// Before each contour: the display card when the display or the structure changes, otherwise a short
// "next contour" step.
function caseIntro(trial) {
  const name = structName(trial.structure_index);
  const info = partInfo(trial);
  const resumed = !!lsGet(`fucp-autosave:${trial.id}`);
  const newPart = (trial.block_index ?? 0) !== S.session.lastBlockShown;
  const newMode = trial.display_mode !== S.session.lastModeShown;
  const done = (S.session.done || []).length;
  const f = FRIENDLY[trial.display_mode];
  const where = `Part ${info.part} of ${info.nParts} · contour ${info.index} of ${info.n}`;
  const label = resumed ? 'Continue editing' : newPart ? `Start part ${info.part}` : 'Start this contour';
  if (newPart || newMode) {
    page(`<div class="muted">${newPart ? `<b>New structure.</b> ` : ''}${where}</div>
      <h1>${esc(name)}</h1>
      <p class="muted">${resumed ? 'Your earlier edits to this contour were saved; continue where you left off.' : done ? 'Previous contour saved. Take a break if you like.' : ''}</p>
      <div class="part-intro">${displayGraphic(trial.display_mode, 300)}<div><div class="muted" style="font-size:.85rem">This contour is shown with</div>
        <div class="intro-name">${f.name}</div><div class="intro-line">${f.line}</div></div></div>
      ${progressHTML(done, trial.n_total)}
      <div class="actions"><button class="primary big" id="start">${label}</button></div>`);
  } else {
    page(`<div class="muted">Part ${info.part} of ${info.nParts} · ${f.name}</div>
      <h1>${esc(name)} – contour ${info.index} of ${info.n}</h1>
      <p>${resumed ? 'Your earlier edits to this contour were saved; continue where you left off.' : 'Saved. Take a break if you like, then start the next contour.'}</p>
      ${progressHTML(done, trial.n_total)}
      <div class="actions"><button class="primary big" id="start">${resumed ? 'Continue editing' : 'Start'}</button></div>`);
  }
  document.getElementById('start').addEventListener('click', () => {
    S.session.lastBlockShown = trial.block_index ?? 0;
    S.session.lastModeShown = trial.display_mode;
    saveSession();
    trialScreen(trial);
  });
}

class Tracker {
  constructor(nz, saved) {
    this.t0 = performance.now();
    this.prevWall = saved?.wall_ms || 0;
    this.dwell = saved?.dwell ? Float64Array.from(saved.dwell) : new Float64Array(nz);
    this.active = saved?.active_ms || 0;
    this.uncHidden = saved?.unc_hidden_ms || 0;
    this.log = saved?.log || [];
    this.counts = saved?.counts || {};
    this.sessions = (saved?.sessions || 0) + 1;
    this.lastAct = this.lastTick = performance.now();
  }
  now() { return Math.round(this.prevWall + performance.now() - this.t0); }
  event(type, data) {
    this.counts[type] = (this.counts[type] || 0) + 1;
    if (this.log.length < 20000) this.log.push([this.now(), type, data]);
    this.activity();
  }
  activity() { this.lastAct = performance.now(); }
  tick(k, uncHidden) {
    const t = performance.now(), dt = t - this.lastTick;
    this.lastTick = t;
    if (document.visibilityState !== 'visible') return;
    this.dwell[k] += dt;
    if (t - this.lastAct < 30000) this.active += dt;
    if (uncHidden) this.uncHidden += dt;
  }
  state() {
    return { wall_ms: this.now(), dwell: Array.from(this.dwell, Math.round), active_ms: Math.round(this.active), unc_hidden_ms: Math.round(this.uncHidden), log: this.log, counts: this.counts, sessions: this.sessions };
  }
}

function trialScreen(trial) {
  const C = S.case, g = C.grid;
  const autosaveKey = `fucp-autosave:${trial.id}`;
  const saved = lsGet(autosaveKey);
  let D;
  try { D = makeDisplay(trial); } catch (e) { return fatal(e.message); }
  const { display, au, original, params } = D;
  let mask = original.slice();
  if (saved?.mask) { try { mask = rleDecode(saved.mask, original.length); } catch { /* start fresh */ } }
  const tracker = new Tracker(g.nz, saved?.tracker);
  const name = C.structures[trial.structure_index].name;
  const info = partInfo(trial);
  show(workspaceHTML(`${esc(name)} – edit the proposed contour`, `<span class="pill">Part ${info.part}/${info.nParts} · contour ${info.index}/${info.n}</span><span class="pill">${trial.trial_index + 1} of ${trial.n_total} overall</span>`, `
    <div><h3>${FRIENDLY[trial.display_mode].name}</h3>${display.legendHTML()}</div>
    <div class="note-box" style="font-size:.88rem">${esc(S.cfg.task_instruction)}</div>
    <details class="help"${trial.trial_index === 0 ? ' open' : ''}><summary>How to edit</summary>${helpHTML.replace('<h3>How to edit</h3>', '')}</details>
    <div class="grow"></div>
    <div class="finish-wrap"><div class="muted" id="savestate" style="font-size:.8rem"></div>
    <button class="primary big" id="finish">Finish &amp; submit</button></div>`));
  const ed = new SliceEditor(document.getElementById('ed'), {
    grid: g, ct: C.ct, mask, display, window: C.header.window, referenceViews: S.cfg.reference_views !== false,
    startSlice: saved?.k,
    onLog: (type, data) => tracker.event(type, data),
    onChange: () => scheduleSave(),
  });
  S.editor = ed;
  buildToolbar(document.getElementById('tb'), ed);
  buildSliceSlider(document.getElementById('sl'), ed);
  const ac = new AbortController();
  tracker.event('start', { mode: trial.display_mode, structure: trial.structure_index, student: trial.student_id, resumed: !!saved });
  ['pointerdown', 'pointermove', 'keydown', 'wheel'].forEach((t) => window.addEventListener(t, () => tracker.activity(), { passive: true, signal: ac.signal }));
  document.addEventListener('visibilitychange', () => tracker.event('visibility', { state: document.visibilityState }), { signal: ac.signal });
  const timer = setInterval(() => tracker.tick(ed.k, display.hasOverlay && !ed.showUncertainty), 250);
  S.backend.startTrial(trial.id, S.session.token).catch(() => {});
  let saveTimer = null;
  const doSave = () => {
    lsSet(autosaveKey, { mask: Array.from(rleEncode(ed.mask)), k: ed.k, tracker: tracker.state(), edited: [...ed.editedSlices], nEdits: ed.nEdits });
    const el = document.getElementById('savestate');
    if (el) el.textContent = `Progress saved in this browser ${new Date().toLocaleTimeString()}`;
  };
  const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(doSave, 800); };
  const periodic = setInterval(doSave, 15000);
  window.addEventListener('beforeunload', (e) => { doSave(); e.preventDefault(); e.returnValue = ''; }, { signal: ac.signal });
  if (saved?.edited) saved.edited.forEach((k) => ed.editedSlices.add(k));
  if (saved?.nEdits) ed.nEdits = saved.nEdits;

  document.getElementById('finish').addEventListener('click', async () => {
    const changed = ed.nEdits;
    const res = await modal(`<h3>Submit this contour?</h3><p>${changed ? `You made ${changed} edit${changed === 1 ? '' : 's'} on ${ed.editedSlices.size} slice${ed.editedSlices.size === 1 ? '' : 's'}.` : 'You have not changed the proposed contour. That is fine if you accept it as it is.'}</p>
      ${likert('confidence', 'How confident are you that this contour is now clinically acceptable?', 7, 'Not at all', 'Completely')}
      <p class="muted">You cannot change the contour after submitting.</p>`,
    [{ label: 'Keep editing', value: false }, { label: 'Submit', value: true, cls: 'primary' }],
    (bg) => { const c = bg.querySelector('input[name=confidence]:checked'); if (!c) { bg.querySelector('.likert .q').style.color = '#ff8080'; return null; } return { confidence: +c.value }; });
    if (!res) return;
    tracker.event('finish', {});
    tracker.tick(ed.k, false);
    clearInterval(timer); clearInterval(periodic); clearTimeout(saveTimer);
    ac.abort();
    doSave();
    const result = buildResult(trial, ed, tracker, au, params, res.confidence);
    lsSet(`fucp-pending:${trial.id}`, result);
    ed.destroy();
    submitCase(trial, result, autosaveKey);
  });
}

function buildResult(trial, ed, tracker, au, params, confidence) {
  const st = tracker.state();
  const dwell = {};
  st.dwell.forEach((v, k) => { if (v > 0) dwell[k] = v; });
  const editsByTool = {};
  for (const [, type, data] of st.log) if (type === 'edit') editsByTool[data.tool] = (editsByTool[data.tool] || 0) + 1;
  return {
    edited_mask_rle: Array.from(rleEncode(ed.mask)),
    edited_contours: maskToPatientContours(ed.mask, S.case.grid),
    duration_s: +(st.wall_ms / 1000).toFixed(1),
    active_time_s: +(st.active_ms / 1000).toFixed(1),
    n_edit_actions: ed.nEdits,
    n_slices_edited: ed.editedSlices.size,
    questionnaire: { confidence },
    interaction: {
      edits_by_tool: editsByTool, counts: st.counts, slice_dwell_ms: dwell, uncertainty_hidden_ms: st.unc_hidden_ms,
      slices_edited: [...ed.editedSlices].sort((a, b) => a - b), page_sessions: st.sessions, log: st.log,
      practice: S.session.practice || null,
    },
    display_params: { mode: trial.display_mode, ...params, leave_one_out: au.loo, n_pool: au.nContributors },
    app_version: APP_VERSION,
    package_sha256: S.study.package_sha256 || null,
    client_info: clientInfo(),
    submitted_at_client: new Date().toISOString(),
  };
}

async function submitCase(trial, result, autosaveKey) {
  page('<h1>Saving…</h1><div class="spinner"></div>');
  try {
    await S.backend.submitTrial(trial.id, S.session.token, result);
  } catch (e) {
    page(`<h1>Could not save this contour</h1><div class="error-box">${esc(e.message)}</div>
      <p>Your work is kept in this browser. Check your connection and try again.</p>
      <div class="actions"><button class="primary" id="retry">Try again</button></div>`);
    document.getElementById('retry').onclick = () => submitCase(trial, result, autosaveKey);
    return;
  }
  lsDel(`fucp-pending:${trial.id}`);
  lsDel(autosaveKey);
  S.session.done = [...(S.session.done || []), trial.id];
  saveSession();
  nextCase();
}

// ------------------------------------------------------------------ end questionnaire (with ranking)
function questionnaireScreen() {
  const displays = planDisplays().length ? planDisplays() : (S.session.mode ? [S.session.mode] : []);
  const ranking = displays.length > 1;
  const single = !ranking && displays[0] && displays[0] !== 'none';
  page(`<h1>A few final questions</h1>
    <form id="q">
      ${ranking ? `<div class="rank" id="rank">
        <div class="q">Rank the ${(WORDS[displays.length] || String(displays.length)).toLowerCase()} ways the contours were shown, from most helpful (1st) to least helpful (${ORD[displays.length]}) for editing.</div>
        <div class="muted" style="font-size:.85rem;margin-bottom:6px">Click a rank for each row. Picking a rank that is already taken swaps the two.</div>
        ${displays.map((d) => `<div class="rank-row" data-d="${d}">${displayGraphic(d, 120)}<div class="rank-name">${FRIENDLY[d].name}</div>
          <div class="rank-btns">${displays.map((_, i) => `<button type="button" data-r="${i + 1}">${ORD[i + 1]}</button>`).join('')}</div></div>`).join('')}
      </div>` : ''}
      ${likert('trust', 'Overall, how much did you trust the proposed contours before editing?', 7, 'Not at all', 'Completely')}
      ${single ? likert('display_helpful', 'How helpful was the uncertainty information for deciding where to edit?', 7, 'Not at all', 'Extremely') : ''}
      ${single ? likert('display_understandable', 'How easy was the uncertainty information to understand?', 7, 'Very difficult', 'Very easy') : ''}
      ${likert('mental_effort', 'How much mental effort did the task require overall?', 9, 'Very, very low', 'Very, very high')}
      <div class="form-row"><label for="comments">Comments <span class="muted">(optional)</span></label><textarea id="comments" maxlength="2000"></textarea></div>
      <div id="qerr"></div>
      <div class="actions"><button class="primary big" type="submit">Submit</button></div>
    </form>`);
  const ranks = {};
  const paint = () => document.querySelectorAll('.rank-row').forEach((row) => {
    row.querySelectorAll('button').forEach((b) => b.classList.toggle('active', ranks[row.dataset.d] === +b.dataset.r));
    row.classList.toggle('ranked', !!ranks[row.dataset.d]);
  });
  document.querySelectorAll('.rank-row button').forEach((b) => b.addEventListener('click', () => {
    const d = b.closest('.rank-row').dataset.d, r = +b.dataset.r;
    const other = Object.keys(ranks).find((x) => ranks[x] === r && x !== d);
    if (other) { if (ranks[d]) ranks[other] = ranks[d]; else delete ranks[other]; } // swap
    ranks[d] = r;
    if (Object.keys(ranks).length === displays.length - 1) { // fill the last one automatically
      const left = displays.find((x) => !ranks[x]);
      const free = displays.map((_, i) => i + 1).find((x) => !Object.values(ranks).includes(x));
      if (left && free) ranks[left] = free;
    }
    paint();
    if (Object.keys(ranks).length === displays.length) document.getElementById('qerr').innerHTML = '';
  }));
  document.getElementById('q').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (ranking && Object.keys(ranks).length < displays.length) {
      document.getElementById('qerr').innerHTML = '<div class="error-box">Please rank all displays.</div>';
      document.getElementById('rank').scrollIntoView({ block: 'center' });
      return;
    }
    const fd = new FormData(e.target);
    const q = { displays, practice: S.session.practice || null };
    if (ranking) { q.ranking = { ...ranks }; q.ranking_order = [...displays].sort((a, b) => ranks[a] - ranks[b]); }
    for (const [k, v] of fd.entries()) q[k] = +v;
    q.comments = document.getElementById('comments').value.trim();
    e.submitter.disabled = true;
    try {
      await S.backend.submitQuestionnaire(S.session.participantId, S.session.token, q);
      S.session.finished = true;
      S.session.stage = 'done';
      saveSession();
      doneScreen();
    } catch (err) {
      e.submitter.disabled = false;
      document.getElementById('qerr').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    }
  });
}

function doneScreen() {
  page(`<h1>Thank you!</h1><p>Your contours and answers have been recorded.</p><p class="muted">You can close this window.</p>`);
}

init();
