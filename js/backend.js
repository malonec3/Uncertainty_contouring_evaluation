// Storage backends. SupabaseBackend is used when config.js has a Supabase URL + anon key;
// otherwise LocalBackend keeps everything in this browser (IndexedDB) for testing/demo.

import { makePlan, planList, STRATA } from './allocation.js';
import { sha256Hex } from './package.js';

export const APP_VERSION = '5.0.0';
const DEMO_VERSION = 5; // bump when the bundled demo case changes

export const DEFAULT_STUDY_CONFIG = {
  display_modes: ['none', 'redgreen', 'heatmap', 'bands', 'numeric'],
  contours_per_structure: 5,      // each participant edits this many contours of every structure
  display_assignment: 'per_contour', // 'per_contour': every display on every structure (one contour per display);
                                     // 'per_structure': one display per structure block; 'per_participant': one display
  leave_one_out: false,
  threshold: 0.1,                 // band: phat >= 0.1 = central 80% interval for the true boundary
  heatmap_min: 0.05,
  redgreen_agreement: 0.5,        // red/green: red where fewer than 50% of all contours agree within 2 mm
  apl_tolerance_mm: 1,
  reservation_minutes: 240,
  reference_views: true,
  offer_practice: true,           // ask "Would you like to practise ...?"
  access_code: '',
  intro_html: '',
  task_instruction: 'Edit the proposed contour slice by slice until you would accept it for clinical treatment planning. If a slice needs no change, leave it as it is.',
};

// ------------------------------------------------------------------ tiny IndexedDB key-value store
class KV {
  constructor(name = 'fucp-local') { this.name = name; this.mem = new Map(); }
  async _db() {
    if (this.db !== undefined) return this.db;
    this.db = await new Promise((res) => {
      try {
        const r = indexedDB.open(this.name, 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
      } catch { res(null); }
    });
    return this.db;
  }
  async get(key, dflt = null) {
    const db = await this._db();
    if (!db) return this.mem.has(key) ? this.mem.get(key) : dflt;
    return new Promise((res) => {
      const r = db.transaction('kv').objectStore('kv').get(key);
      r.onsuccess = () => res(r.result === undefined ? dflt : r.result);
      r.onerror = () => res(dflt);
    });
  }
  async set(key, val) {
    const db = await this._db();
    if (!db) { this.mem.set(key, val); return; }
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(val, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
}

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
}));

export function lsGet(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
export function lsSet(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ } }
export function lsDel(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } }

// ------------------------------------------------------------------ local backend
export class LocalBackend {
  constructor() { this.mode = 'local'; this.kv = new KV(); }

  async _studies() { return (await this.kv.get('studies')) || []; }

  async getActiveStudy() {
    let st = (await this._studies()).find((s) => s.is_active);
    if (st && (!st.config?.structure_names || (st.demo && st.config?.demo_version !== DEMO_VERSION))) st = null; // saved by an older version of this app
    if (!st) st = await this._installDemo();
    return st;
  }

  async _fetchBytes(base) {
    const r = await fetch(`${base}.fucp`).catch(() => null);
    if (r && r.ok) return new Uint8Array(await r.arrayBuffer());
    // base64 text copy, for hosts that refuse unknown file types
    const t = await fetch(`${base}.b64.txt`).catch(() => null);
    if (!t || !t.ok) return null;
    const bin = atob((await t.text()).trim());
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  async _installDemo() {
    try {
      const bytes = await this._fetchBytes('demo/demo_case');
      if (!bytes) return null;
      const meta = await fetch('demo/demo_study.json').then((x) => (x.ok ? x.json() : null)).catch(() => null);
      if (!meta) return null;
      return this.publishStudy({
        name: 'Demo (synthetic case)', config: { ...DEFAULT_STUDY_CONFIG, ...(meta.config || {}), demo_version: DEMO_VERSION },
        packageBytes: bytes, sha256: await sha256Hex(bytes),
        referenceBytes: null, referenceSha256: null, // fetched only by the admin page when it scores (never by participants)
        students: meta.students, demo: true,
      });
    } catch { return null; }
  }

  async loadPackage(study) {
    const b = await this.kv.get(`pkg:${study.id}`);
    if (!b) throw new Error('Case file not found in this browser');
    return b;
  }
  async loadReference(study) {
    let b = await this.kv.get(`ref:${study.id}`);
    if (!b && study.demo) {
      b = await this._fetchBytes('demo/demo_reference');
      if (b) await this.kv.set(`ref:${study.id}`, b);
    }
    if (!b) throw new Error('Reference file not found in this browser');
    return b;
  }

  async registerParticipant(studyId, profile) {
    const st = (await this._studies()).find((s) => s.id === studyId);
    if (st.config.access_code && profile.access_code !== st.config.access_code) throw new Error('Incorrect access code');
    const parts = (await this.kv.get('participants')) || [];
    const p = { id: uuid(), study_id: studyId, role: profile.role, stratum: STRATA[profile.role] || 'OTHER', profile: { ...profile }, created_at: new Date().toISOString() };
    delete p.profile.access_code;
    parts.push(p);
    await this.kv.set('participants', parts);
    return { participantId: p.id, token: uuid() };
  }

  async nextTrial(participantId) {
    const parts = (await this.kv.get('participants')) || [];
    const p = parts.find((x) => x.id === participantId);
    if (!p) throw new Error('Unknown participant');
    const st = (await this._studies()).find((s) => s.id === p.study_id);
    const trials = (await this.kv.get('trials')) || [];
    let mine = trials.filter((t) => t.participant_id === p.id);
    if (!mine.length) {
      const nStruct = Math.max(0, ...st.students.map((s) => s.structure_index)) + 1;
      const eligible = Array.from({ length: nStruct }, (_, si) => st.students.filter((s) => s.structure_index === si && s.included !== false).map((s) => s.student_id));
      const plan = makePlan(trials.filter((t) => t.study_id === st.id), p, st.config.display_modes, eligible, st.config.contours_per_structure || 3,
        { assignment: st.config.display_assignment || 'per_contour', reservationMinutes: st.config.reservation_minutes || 240 });
      const now = new Date().toISOString();
      mine = plan.map((x) => ({ id: uuid(), study_id: st.id, participant_id: p.id, stratum: p.stratum, ...x, status: 'assigned', assigned_at: now }));
      trials.push(...mine);
      await this.kv.set('trials', trials);
    }
    const open = mine.filter((t) => t.status === 'assigned').sort((a, b) => a.trial_index - b.trial_index)[0];
    return open ? { ...open, n_total: mine.length, plan: planList(mine) } : null;
  }

  async _updateTrial(id, fn) {
    const trials = (await this.kv.get('trials')) || [];
    const t = trials.find((x) => x.id === id);
    if (!t) throw new Error('Unknown trial');
    fn(t);
    await this.kv.set('trials', trials);
    return t;
  }
  async startTrial(trialId) { return this._updateTrial(trialId, (t) => { t.started_at = t.started_at || new Date().toISOString(); }); }
  async submitTrial(trialId, token, payload) {
    return this._updateTrial(trialId, (t) => {
      if (t.status !== 'assigned') throw new Error('Case already submitted');
      Object.assign(t, payload, { status: 'completed', completed_at: new Date().toISOString() });
    });
  }
  async submitQuestionnaire(participantId, token, answers) {
    const parts = (await this.kv.get('participants')) || [];
    const p = parts.find((x) => x.id === participantId);
    p.questionnaire = answers;
    p.completed_at = new Date().toISOString();
    await this.kv.set('participants', parts);
  }

  // admin
  async adminSession() { return { email: 'local' }; }
  async adminSignIn() { return { email: 'local' }; }
  async adminSignOut() {}
  async listStudies() { return this._studies(); }
  async publishStudy({ name, config, packageBytes, sha256, referenceBytes, referenceSha256, students, demo = false }) {
    const studies = await this._studies();
    const id = uuid();
    await this.kv.set(`pkg:${id}`, packageBytes);
    if (referenceBytes) await this.kv.set(`ref:${id}`, referenceBytes);
    studies.forEach((s) => { s.is_active = false; });
    const st = { id, name, config, package_path: `local:${id}`, package_sha256: sha256, reference_sha256: referenceSha256, is_active: true, created_at: new Date().toISOString(), students, demo };
    studies.push(st);
    await this.kv.set('studies', studies);
    return st;
  }
  async setActiveStudy(id) {
    const studies = await this._studies();
    studies.forEach((s) => { s.is_active = s.id === id; });
    await this.kv.set('studies', studies);
  }
  async fetchResults(studyId) {
    const parts = (await this.kv.get('participants')) || [];
    const trials = ((await this.kv.get('trials')) || []).filter((t) => t.study_id === studyId);
    return trials.map((t) => ({ ...t, participant: parts.find((p) => p.id === t.participant_id) || null }));
  }
  async updateTrialScores(trialId, cols) { return this._updateTrial(trialId, (t) => Object.assign(t, cols)); }
  async studentContours(studyId) {
    return ((await this._studies()).find((s) => s.id === studyId) || {}).students || [];
  }
  async resetLocalData() {
    for (const k of ['studies', 'participants', 'trials']) await this.kv.set(k, []);
  }
}

// ------------------------------------------------------------------ Supabase backend
export class SupabaseBackend {
  constructor(cfg) {
    if (!window.supabase) throw new Error('Supabase client library failed to load (vendor/supabase.js)');
    this.mode = 'supabase';
    this.cfg = cfg;
    this.bucket = cfg.packageBucket || 'case-packages';
    this.refBucket = cfg.referenceBucket || 'case-references';
    this.sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true } });
  }
  _check({ data, error }) {
    if (error) throw new Error(error.message || String(error));
    return data;
  }
  async getActiveStudy() {
    return this._check(await this.sb.from('studies').select('id,name,config,package_path,package_sha256').eq('is_active', true).maybeSingle());
  }
  async loadPackage(study) {
    const { data } = this.sb.storage.from(this.bucket).getPublicUrl(study.package_path);
    const r = await fetch(data.publicUrl, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`Could not download the case (${r.status})`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (study.package_sha256) {
      const h = await sha256Hex(bytes);
      if (h !== study.package_sha256) throw new Error('Case file checksum mismatch – please reload');
    }
    return bytes;
  }
  async loadReference(study) {
    const blob = this._check(await this.sb.storage.from(this.refBucket).download(study.reference_path));
    return new Uint8Array(await blob.arrayBuffer());
  }
  async registerParticipant(studyId, profile) {
    const token = uuid();
    const id = this._check(await this.sb.rpc('register_participant', {
      p_study_id: studyId, p_token: token, p_role: profile.role, p_access_code: profile.access_code || '', p_profile: profile,
    }));
    return { participantId: id, token };
  }
  async nextTrial(participantId, token) {
    return this._check(await this.sb.rpc('next_trial', { p_participant_id: participantId, p_token: token }));
  }
  async startTrial(trialId, token) {
    return this._check(await this.sb.rpc('start_trial', { p_trial_id: trialId, p_token: token }));
  }
  async submitTrial(trialId, token, payload) {
    return this._check(await this.sb.rpc('submit_trial', { p_trial_id: trialId, p_token: token, p_payload: payload }));
  }
  async submitQuestionnaire(participantId, token, answers) {
    return this._check(await this.sb.rpc('submit_questionnaire', { p_participant_id: participantId, p_token: token, p_answers: answers }));
  }

  // admin
  async adminSession() {
    const { data } = await this.sb.auth.getSession();
    if (!data.session) return null;
    const isAdmin = this._check(await this.sb.rpc('is_admin'));
    return isAdmin ? { email: data.session.user.email } : { email: data.session.user.email, notAdmin: true };
  }
  async adminSignIn(email, password) {
    this._check(await this.sb.auth.signInWithPassword({ email, password }));
    return this.adminSession();
  }
  async adminSignOut() { await this.sb.auth.signOut(); }
  async listStudies() {
    return this._check(await this.sb.from('studies').select('*').order('created_at', { ascending: false }));
  }
  async publishStudy({ name, config, packageBytes, sha256, referenceBytes, referenceSha256, students }) {
    const id = uuid();
    const path = `${id}/case.fucp`, refPath = `${id}/reference.fucp`;
    const up = async (bucket, p, bytes) => this._check(await this.sb.storage.from(bucket).upload(p, new Blob([bytes], { type: 'application/octet-stream' }), { upsert: true, contentType: 'application/octet-stream' }));
    await up(this.bucket, path, packageBytes);
    await up(this.refBucket, refPath, referenceBytes);
    const { access_code: accessCode, ...cfg } = config;
    cfg.requires_access_code = !!accessCode;
    this._check(await this.sb.from('studies').insert({ id, name, config: cfg, access_code: accessCode || null, package_path: path, package_sha256: sha256, reference_path: refPath, reference_sha256: referenceSha256, is_active: false }));
    const rows = students.map((s) => ({ study_id: id, structure_index: s.structure_index, student_id: s.student_id, label: s.label, source_name: s.source_name, baseline: s.baseline, included: s.included !== false, in_pool: s.in_pool !== false }));
    for (let i = 0; i < rows.length; i += 200) this._check(await this.sb.from('student_contours').insert(rows.slice(i, i + 200)));
    await this.setActiveStudy(id);
    return { id, name, config, package_path: path, package_sha256: sha256, is_active: true };
  }
  async setActiveStudy(id) { this._check(await this.sb.rpc('activate_study', { p_study_id: id })); }
  async fetchResults(studyId) {
    const out = [];
    for (let from = 0; ; from += 500) {
      const rows = this._check(await this.sb.from('trials').select('*, participant:participants(*)').eq('study_id', studyId).order('assigned_at').order('trial_index').range(from, from + 499));
      out.push(...rows);
      if (rows.length < 500) break;
    }
    return out;
  }
  async updateTrialScores(trialId, cols) { this._check(await this.sb.from('trials').update(cols).eq('id', trialId)); }
  async studentContours(studyId) {
    return this._check(await this.sb.from('student_contours').select('*').eq('study_id', studyId).order('structure_index').order('student_id'));
  }
}

export function createBackend() {
  const cfg = window.STUDY_CONFIG || {};
  if (cfg.supabaseUrl && cfg.supabaseAnonKey) return new SupabaseBackend(cfg);
  return new LocalBackend();
}
