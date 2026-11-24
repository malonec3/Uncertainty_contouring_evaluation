// Balanced allocation, mirrored exactly in SQL (supabase/schema.sql: next_trial).
//
// On a participant's first request a complete plan is made. The participant edits one block of
// `perStructure` contours for each structure (S structures).
//
// display_assignment = 'per_contour' (default): every display on every structure
//   Each block shows every enabled display once (with 5 displays and 5 contours per structure: one contour
//   per display), so every participant sees every display, and display x structure is balanced within
//   each participant.
//   1. Display order: one sequence from a Williams design (D displays: D sequences if D is even, 2D if odd),
//      so across participants every display is equally often in every position and follows every other
//      display equally often (first-order carry-over balanced). The second block uses the same sequence
//      reversed, so within each participant every display has the same average position (learning and
//      fatigue cannot favour a display). Blocks with more contours than displays repeat the sequence;
//      with fewer, the displays continue round-robin into the next block.
//   2. Structure order: chosen together with the sequence by minimisation within the participant's
//      stratum: the (sequence, order) pair used least, then the sequence used least, then the order used
//      least; ties random.
//   3. Contours: per block, the contours of that structure used least overall (ties random); they are then
//      matched to the positions (and so to the displays) to minimise how often each contour has already
//      been seen with that display, then in that position (exhaustive for up to 7 contours, greedy above).
// display_assignment = 'per_structure': one display per structure block: control + (S-1) of the other
//   displays (minimisation over the possible sets), display-to-block permutation balancing display x
//   structure and display x position, contours least used with that display; order within a block shuffled.
// display_assignment = 'per_participant': one display for all blocks.
// "Active" = completed, or assigned within the reservation window (abandoned plans stop counting).

export const STRATA = {
  radiation_oncologist: 'RO', radiation_oncology_trainee: 'RO',
  radiation_therapist: 'RTT', dosimetrist: 'RTT',
  medical_physicist: 'OTHER', other: 'OTHER',
};
export const ROLE_LABELS = {
  radiation_oncologist: 'Radiation oncologist (consultant / attending)',
  radiation_oncology_trainee: 'Radiation oncology trainee / resident',
  radiation_therapist: 'Radiation therapist (RTT)',
  dosimetrist: 'Dosimetrist / planner',
  medical_physicist: 'Medical physicist',
  other: 'Other',
};

function pickMin(items, score, rnd) {
  let best = [], bestScore = null;
  for (const it of items) {
    const s = score(it);
    let cmp = -1;
    if (bestScore !== null) { cmp = 0; for (let i = 0; i < s.length && !cmp; i++) if (s[i] !== bestScore[i]) cmp = s[i] < bestScore[i] ? -1 : 1; }
    if (cmp < 0) { best = [it]; bestScore = s; } else if (cmp === 0) best.push(it);
  }
  return best.length ? best[Math.floor(rnd() * best.length)] : null;
}

function shuffle(a, rnd) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export function combinations(arr, k) {
  if (k === 0) return [[]];
  const out = [];
  arr.forEach((x, i) => { for (const rest of combinations(arr.slice(i + 1), k - 1)) out.push([x, ...rest]); });
  return out;
}

export function permutations(n) {
  if (n === 0) return [[]];
  const out = [];
  for (const p of permutations(n - 1)) for (let i = 0; i <= p.length; i++) out.push([...p.slice(0, i), n - 1, ...p.slice(i)]);
  return out;
}

/** Candidate display sets for a participant. */
export function candidateSets(modes, nBlocks, assignment) {
  const m = assignment === 'per_participant' ? 1 : Math.min(nBlocks, modes.length);
  if (m <= 1) return modes.map((x) => [x]);
  if (modes.includes('none')) return combinations(modes.filter((x) => x !== 'none'), m - 1).map((c) => ['none', ...c]);
  return combinations(modes, m);
}

const setKey = (s) => [...new Set(s)].sort().join(',');

/** Williams design: sequences of 0..n-1 (n rows if n is even, 2n if odd). */
export function williams(n) {
  if (n <= 1) return [Array.from({ length: n }, (_, i) => i)];
  const first = [0];
  let lo = 1, hi = n - 1;
  for (let j = 1; j < n; j++) first.push(j % 2 ? lo++ : hi--);
  const rows = Array.from({ length: n }, (_, i) => first.map((x) => (x + i) % n));
  return n % 2 ? [...rows, ...rows.map((r) => [...r].reverse())] : rows;
}

/** Displays of block b (K contours) for display sequence seq. */
export function blockDisplays(seq, b, K) {
  const D = seq.length;
  if (K % D === 0) {
    const base = b % 2 ? [...seq].reverse() : seq;
    return Array.from({ length: K }, (_, p) => base[p % D]);
  }
  return Array.from({ length: K }, (_, p) => seq[(b * K + p) % D]);
}

function permsOf(arr) {
  return permutations(arr.length).map((p) => p.map((i) => arr[i]));
}

const isActive = (t, now, reservationMinutes) => t.status === 'completed'
  || (t.status === 'assigned' && now - new Date(t.assigned_at).getTime() < reservationMinutes * 60000);

/**
 * @param trials       all trials of the study [{participant_id, stratum, display_mode, block_index, structure_index, student_id, trial_index, status, assigned_at}]
 * @param participant  {id, stratum}
 * @param modes        enabled display modes
 * @param eligible     eligible contour ids per structure: [[ids of structure 0], ...]
 * @param perStructure contours per structure (= per block)
 * @returns [{trial_index, block_index, display_mode, structure_index, student_id}]
 */
export function makePlan(trials, participant, modes, eligible, perStructure, opts = {}) {
  const { assignment = 'per_contour', now = Date.now(), reservationMinutes = 240, rnd = Math.random } = opts;
  const active = trials.filter((t) => isActive(t, now, reservationMinutes));
  const structures = eligible.map((_, si) => si).filter((si) => eligible[si].length);
  if (assignment === 'per_contour') return planPerContour(trials, active, participant, modes, eligible, structures, perStructure, rnd);
  return planPerStructure(active, participant, modes, eligible, structures, perStructure, assignment, rnd);
}

function planPerContour(trials, active, participant, modes, eligible, structures, K, rnd) {
  // 1./2. display sequence and structure order
  const peerIds = new Set(active.filter((t) => t.stratum === participant.stratum && t.participant_id !== participant.id).map((t) => t.participant_id));
  const peers = [...peerIds].map((pid) => {
    const mine = trials.filter((t) => t.participant_id === pid).sort((a, b) => a.trial_index - b.trial_index);
    const blocks = [...new Map(mine.map((t) => [t.block_index, t.structure_index])).entries()].sort((a, b) => a[0] - b[0]);
    return { k0: mine.filter((t) => t.block_index === 0).map((t) => t.display_mode).join(','), ok: blocks.map((b) => b[1]).join(',') };
  });
  const cands = [];
  for (const w of williams(modes.length)) {
    const seq = w.map((i) => modes[i]);
    for (const ord of permsOf(structures)) {
      const n0 = Math.min(K, eligible[ord[0]].length);
      cands.push({ seq, ord, k0: blockDisplays(seq, 0, K).slice(0, n0).join(','), ok: ord.join(',') });
    }
  }
  const pick = pickMin(cands, (c) => [
    peers.filter((p) => p.k0 === c.k0 && p.ok === c.ok).length,
    peers.filter((p) => p.k0 === c.k0).length,
    peers.filter((p) => p.ok === c.ok).length,
  ], rnd);
  // 3. contours per block
  const pos = new Map(); // trial -> position within its block
  const first = new Map();
  for (const t of trials) {
    const key = `${t.participant_id}|${t.block_index}`;
    first.set(key, Math.min(first.get(key) ?? Infinity, t.trial_index));
  }
  for (const t of trials) pos.set(t, t.trial_index - first.get(`${t.participant_id}|${t.block_index}`));
  const plan = [];
  pick.ord.forEach((si, b) => {
    const n = Math.min(K, eligible[si].length);
    const ds = blockDisplays(pick.seq, b, K).slice(0, n);
    const act = active.filter((t) => t.structure_index === si);
    const nUse = (id) => act.filter((t) => t.student_id === id).length;
    const nCD = (id, d) => act.filter((t) => t.student_id === id && t.display_mode === d).length;
    const nCP = (id, p) => act.filter((t) => t.student_id === id && pos.get(t) === p).length;
    const sel = [];
    for (let r = 0; r < n; r++) sel.push(pickMin(eligible[si].filter((id) => !sel.includes(id)), (id) => [nUse(id)], rnd));
    let order;
    if (n <= 7) {
      const cost = sel.map((id) => ds.map((d, p) => [nCD(id, d), nCP(id, p)]));
      order = pickMin(permutations(n), (perm) => perm.reduce((a, ci, p) => [a[0] + cost[ci][p][0], a[1] + cost[ci][p][1]], [0, 0]), rnd).map((ci) => sel[ci]);
    } else {
      order = [];
      ds.forEach((d, p) => order.push(pickMin(sel.filter((id) => !order.includes(id)), (id) => [nCD(id, d), nCP(id, p)], rnd)));
    }
    order.forEach((id, p) => plan.push({ trial_index: plan.length, block_index: b, display_mode: ds[p], structure_index: si, student_id: id }));
  });
  return plan;
}

function planPerStructure(active, participant, modes, eligible, structures, perStructure, assignment, rnd) {
  const peers = active.filter((t) => t.stratum === participant.stratum && t.participant_id !== participant.id);
  // display sets and blocks of active peers
  const peerSets = new Map(), blocks = new Map();
  for (const t of peers) {
    const s = peerSets.get(t.participant_id) || new Set();
    s.add(t.display_mode);
    peerSets.set(t.participant_id, s);
    blocks.set(`${t.participant_id}|${t.block_index}`, t);
  }
  const sets = [...peerSets.values()].map((s) => setKey([...s]));
  const nB = structures.length;
  const cands = candidateSets(modes, nB, assignment);
  const set = pickMin(cands, (c) => [
    sets.filter((k) => k === setKey(c)).length,
    c.reduce((a, d) => a + [...peerSets.values()].filter((s) => s.has(d)).length, 0),
  ], rnd);
  const ext = Array.from({ length: nB }, (_, b) => set[b % set.length]);
  const order = shuffle([...structures], rnd);
  const blockList = [...blocks.values()];
  const nDS = (d, si) => blockList.filter((t) => t.display_mode === d && t.structure_index === si).length;
  const nDP = (d, b) => blockList.filter((t) => t.display_mode === d && t.block_index === b).length;
  const perm = pickMin(permutations(nB), (p) => [p.reduce((a, pi, b) => a + nDS(ext[pi], order[b]) + nDP(ext[pi], b), 0)], rnd);
  const plan = [];
  order.forEach((si, b) => {
    const mode = ext[perm[b]];
    const picked = [];
    const n = Math.min(perStructure, eligible[si].length);
    const use = (id, m) => active.filter((t) => t.structure_index === si && t.student_id === id && (m === null || t.display_mode === m)).length;
    for (let r = 0; r < n; r++) {
      const cand = eligible[si].filter((id) => !picked.includes(id));
      picked.push(pickMin(cand, (id) => [use(id, mode), use(id, null)], rnd));
    }
    for (const id of shuffle(picked, rnd)) plan.push({ trial_index: plan.length, block_index: b, display_mode: mode, structure_index: si, student_id: id });
  });
  return plan;
}

/** Compact per-case plan handed to the participant page. */
export function planList(trials) {
  return [...trials].sort((a, b) => a.trial_index - b.trial_index)
    .map((t) => ({ trial_index: t.trial_index, block_index: t.block_index, structure_index: t.structure_index, display_mode: t.display_mode }));
}

/** Blocks of a participant's plan: [{block_index, structure_index, displays: [display per case], n, first}] */
export function planBlocks(plan) {
  const m = new Map();
  for (const t of [...plan].sort((a, b) => a.trial_index - b.trial_index)) {
    const b = m.get(t.block_index) || { block_index: t.block_index, structure_index: t.structure_index, displays: [], n: 0, first: t.trial_index };
    b.displays.push(t.display_mode);
    b.n++;
    m.set(t.block_index, b);
  }
  return [...m.values()].sort((a, b) => a.block_index - b.block_index);
}
