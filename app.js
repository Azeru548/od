/* ==========================================================================
   Security Dues — a tiny offline-first ledger for neighbourhood security fees.
   No build step, no dependencies. Records live in localStorage and sync to a
   single Firebase Firestore document (see FIREBASE below).
   ========================================================================== */

'use strict';

const STORE_KEY = 'security-dues.v1';
const APP_VERSION = '1.0.7';

/* ---------- small helpers ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function r2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function sum(list, fn = (x) => x) {
  return list.reduce((acc, item) => acc + (Number(fn(item)) || 0), 0);
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/* ---------- dates ---------- */

function pad2(n) { return String(n).padStart(2, '0'); }

function isoDate(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function monthKeyOf(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

function parseMonth(key) {
  const [y, m] = String(key || '').split('-').map(Number);
  if (!y || !m) return new Date();
  return new Date(y, m - 1, 1);
}

function addMonths(key, n) {
  const d = parseMonth(key);
  d.setMonth(d.getMonth() + n);
  return monthKeyOf(d);
}

function monthDiff(a, b) {
  const da = parseMonth(a);
  const db = parseMonth(b);
  return (db.getFullYear() - da.getFullYear()) * 12 + (db.getMonth() - da.getMonth());
}

function monthsRange(start, end) {
  if (!start || !end || end < start) return [];
  const out = [];
  let m = start;
  let guard = 0;
  while (m <= end && guard++ < 480) {
    out.push(m);
    m = addMonths(m, 1);
  }
  return out;
}

function monthLabel(key, short = false) {
  if (!key) return '—';
  const d = parseMonth(key);
  return d.toLocaleDateString(undefined, short
    ? { month: 'short', year: '2-digit' }
    : { month: 'long', year: 'numeric' });
}

function fmtDate(iso, { withYear = true } = {}) {
  if (!iso) return '—';
  const d = new Date(iso + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, withYear
    ? { day: 'numeric', month: 'short', year: 'numeric' }
    : { day: 'numeric', month: 'short' });
}

function daysSince(iso) {
  if (!iso) return Infinity;
  const then = new Date(iso + 'T12:00:00').getTime();
  if (Number.isNaN(then)) return Infinity;
  return Math.floor((Date.now() - then) / 86400000);
}

/* ---------- money ---------- */

function currency() {
  return state.settings.currency || '';
}

function money(value, { compact = false } = {}) {
  const n = Number(value) || 0;
  const cur = String(state.settings.currency || '').replace(/[<>&"']/g, '');
  const frac = Math.abs(n % 1) > 0.004;
  let text;

  if (compact && Math.abs(n) >= 1000000) {
    text = (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  } else if (compact && Math.abs(n) >= 10000) {
    text = Math.round(n / 1000) + 'k';
  } else {
    text = new Intl.NumberFormat(undefined, {
      minimumFractionDigits: frac ? 2 : 0,
      maximumFractionDigits: 2
    }).format(n);
  }

  const gap = /^[A-Za-z]{2,}$/.test(cur) ? ' ' : '';
  return cur ? `${cur}${gap}${text}` : text;
}

/* ---------- app state ---------- */

function defaultState() {
  return {
    version: 1,
    updatedAt: null,
    settings: {
      communityName: '',
      currency: '₦',
      defaultFee: 1000,
      dueDay: 5,
      theme: 'system',
      setupComplete: false,
      lastBackupAt: null,
      receiptSeq: 1
    },
    residents: [],
    payments: []
  };
}

function loadState() {
  const base = defaultState();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw);
    return {
      ...base,
      ...parsed,
      settings: { ...base.settings, ...(parsed.settings || {}) },
      residents: Array.isArray(parsed.residents) ? parsed.residents : [],
      payments: Array.isArray(parsed.payments) ? parsed.payments : []
    };
  } catch (err) {
    console.error('Could not read saved data', err);
    return base;
  }
}

let state = loadState();

let ui = {
  view: 'dashboard',
  month: monthKeyOf(),
  residentId: null,
  search: '',
  filter: 'all',
  payMonth: 'all',
  paySearch: '',
  reportYear: new Date().getFullYear()
};

let paidIndex = new Map();
let monthCollected = new Map();

function rebuildIndexes() {
  paidIndex = new Map();
  monthCollected = new Map();
  for (const p of state.payments) {
    const amount = Number(p.amount) || 0;
    const key = p.residentId + '|' + p.month;
    paidIndex.set(key, r2((paidIndex.get(key) || 0) + amount));
    monthCollected.set(p.month, r2((monthCollected.get(p.month) || 0) + amount));
  }
}

/* ---------- cloud sync (Firebase Firestore) ---------- */

/* Web config values are public by design — they identify the Firebase project.
   They are not credentials. What can read and write the ledger is decided by the
   Firestore security rules for databases/(default), not by this block. */
const FIREBASE = {
  apiKey: 'AIzaSyCEg3QJDpqbuLqJxk44547rquadCrxs1vM',
  projectId: 'ragaops-548'
};

const FIRESTORE_DOC = 'ledgers/main';
const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE.projectId}`
  + `/databases/(default)/documents/${FIRESTORE_DOC}`;
const FIRESTORE_MASK = 'updateMask.fieldPaths=data&updateMask.fieldPaths=updatedAt';

let serverSyncState = 'unknown';
let serverSyncTimer = null;
let serverSyncError = '';
let serverSyncRetry = 0;

function firestoreField(fields, key) {
  const value = fields && fields[key];
  if (!value || typeof value.stringValue !== 'string') return null;
  return value.stringValue;
}

function persistLocal() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    return true;
  } catch (err) {
    console.error(err);
    toast('Could not save — device storage may be full', 'error');
    return false;
  }
}

function save() {
  state.updatedAt = new Date().toISOString();
  const ok = persistLocal();
  queueServerSave();
  return ok;
}

function syncLabel() {
  if (serverSyncState === 'synced') return 'Saved to Firestore';
  if (serverSyncState === 'denied') return 'Firestore refused the write';
  if (serverSyncState === 'offline') return 'Not saved to Firestore — kept in this browser';
  if (serverSyncState === 'pending') return 'Saving…';
  return 'Not checked yet';
}

function syncProblem() {
  if (serverSyncState === 'denied') {
    return {
      text: 'Firestore is refusing saves from this device.',
      detail: serverSyncError || `The security rules are blocking writes to ${FIRESTORE_DOC}.`
    };
  }
  if (serverSyncState === 'offline') {
    return {
      text: 'Not saved to the cloud yet.',
      detail: serverSyncError || 'This device could not reach Firestore. Your changes are safe in this browser and will upload when it can reconnect.'
    };
  }
  return null;
}

function updateSyncStatus() {
  for (const el of $$('[data-sync-status]')) el.textContent = syncLabel();

  const problem = syncProblem();
  for (const slot of $$('[data-sync-slot]')) {
    if (!problem) { slot.innerHTML = ''; continue; }
    slot.innerHTML = `<div class="banner banner--danger" role="alert">
      <span style="color:var(--danger)">${icon('wifiOff', 20)}</span>
      <div class="grow"><strong>${esc(problem.text)}</strong> ${esc(problem.detail)}</div>
      <button class="btn btn--ghost btn--sm" data-action="sync-retry">${icon('cloud', 15)} Retry</button>
    </div>`;
  }
}

function scheduleSyncRetry() {
  if (serverSyncRetry >= 6) return;
  const delay = Math.min(60000, 4000 * Math.pow(2, serverSyncRetry));
  serverSyncRetry += 1;
  if (serverSyncTimer) clearTimeout(serverSyncTimer);
  serverSyncTimer = setTimeout(() => {
    serverSyncTimer = null;
    pushStateToServer();
  }, delay);
}

/* A save queued a moment before the tab is closed would otherwise never leave. */
function flushPendingSave() {
  if (!serverSyncTimer) return;
  clearTimeout(serverSyncTimer);
  serverSyncTimer = null;
  pushStateToServer({ keepalive: true });
}

function queueServerSave() {
  serverSyncState = 'pending';
  serverSyncError = '';
  updateSyncStatus();
  if (serverSyncTimer) clearTimeout(serverSyncTimer);
  serverSyncTimer = setTimeout(() => {
    serverSyncTimer = null;
    pushStateToServer();
  }, 350);
}

async function pushStateToServer({ keepalive = false } = {}) {
  if (location.protocol === 'file:') {
    serverSyncState = 'offline';
    serverSyncError = 'The app is open as a file, so it cannot reach Firestore. Open it from its web address or http://localhost.';
    updateSyncStatus();
    return false;
  }
  if (!state.updatedAt) state.updatedAt = new Date().toISOString();
  try {
    // PATCH creates the document when it does not exist yet.
    const res = await fetch(`${FIRESTORE_URL}?key=${encodeURIComponent(FIREBASE.apiKey)}&${FIRESTORE_MASK}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      keepalive,
      body: JSON.stringify({
        fields: {
          data: { stringValue: JSON.stringify(state) },
          updatedAt: { stringValue: state.updatedAt }
        }
      })
    });
    if (res.status === 401 || res.status === 403) {
      serverSyncState = 'denied';
      serverSyncError = `Firestore answered HTTP ${res.status} for a write to ${FIRESTORE_DOC}.`;
      updateSyncStatus();
      console.warn(`Firestore denied the write to ${FIRESTORE_DOC}. Check the security rules.`);
      return false;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const payload = await res.json().catch(() => ({}));
    const storedAt = firestoreField(payload.fields, 'updatedAt');
    if (storedAt && storedAt !== state.updatedAt) {
      state.updatedAt = storedAt;
      persistLocal();
    }
    serverSyncState = 'synced';
    serverSyncError = '';
    serverSyncRetry = 0;
    updateSyncStatus();
    return true;
  } catch (err) {
    console.warn('Could not save to Firestore', err);
    serverSyncState = 'offline';
    serverSyncError = (err && err.message ? 'Firestore request failed: ' + err.message : 'Firestore could not be reached.');
    updateSyncStatus();
    scheduleSyncRetry();
    return false;
  }
}

function adoptState(parsed, updatedAt) {
  const base = defaultState();
  state = {
    ...base,
    ...parsed,
    settings: { ...base.settings, ...(parsed.settings || {}) },
    residents: Array.isArray(parsed.residents) ? parsed.residents : [],
    payments: Array.isArray(parsed.payments) ? parsed.payments : []
  };
  if (updatedAt) state.updatedAt = updatedAt;
  rebuildIndexes();
  persistLocal();
  parseHash();
  render();
}

async function syncWithServer() {
  if (location.protocol === 'file:') {
    serverSyncState = 'offline';
    return;
  }
  try {
    const res = await fetch(`${FIRESTORE_URL}?key=${encodeURIComponent(FIREBASE.apiKey)}`, { cache: 'no-store' });

    if (res.status === 401 || res.status === 403) {
      serverSyncState = 'denied';
      serverSyncError = `Firestore answered HTTP ${res.status} for a read of ${FIRESTORE_DOC}.`;
      updateSyncStatus();
      console.warn(`Firestore denied the read of ${FIRESTORE_DOC}. Check the security rules.`);
      return;
    }
    if (!res.ok && res.status !== 404) throw new Error('HTTP ' + res.status);

    let remote = null;
    let remoteUpdatedAt = null;
    if (res.status !== 404) {
      const payload = await res.json();
      remoteUpdatedAt = firestoreField(payload.fields, 'updatedAt');
      const raw = firestoreField(payload.fields, 'data');
      try {
        remote = raw ? JSON.parse(raw) : null;
      } catch (err) {
        console.error('Stored ledger is not valid JSON', err);
        remote = null;
      }
    }

    // A missing or unreadable document means the cloud has nothing usable yet.
    if (!remote || !remote.settings || !Array.isArray(remote.residents) || !Array.isArray(remote.payments)) {
      const hasLocal = state.settings.setupComplete || state.residents.length || state.payments.length;
      if (hasLocal) await pushStateToServer();
      else {
        serverSyncState = 'synced';
        updateSyncStatus();
      }
      return;
    }

    const remoteAt = Date.parse(remoteUpdatedAt || remote.updatedAt || '') || 0;
    const localAt = Date.parse(state.updatedAt || '') || 0;
    const hasLocal = state.settings.setupComplete || state.residents.length || state.payments.length;

    if (!hasLocal || remoteAt > localAt) {
      adoptState(remote, remoteUpdatedAt);
      serverSyncState = 'synced';
      updateSyncStatus();
    } else if (localAt > remoteAt) {
      await pushStateToServer();
    } else {
      serverSyncState = 'synced';
      updateSyncStatus();
    }
  } catch (err) {
    console.warn('Could not reach Firestore', err);
    serverSyncState = 'offline';
    serverSyncError = (err && err.message ? 'Firestore request failed: ' + err.message : 'Firestore could not be reached.');
    updateSyncStatus();
    scheduleSyncRetry();
  }
}

function commit({ render: shouldRender = true } = {}) {
  rebuildIndexes();
  save();
  if (shouldRender) render();
}

/* ---------- domain helpers ---------- */

function residentById(id) {
  return state.residents.find((r) => r.id === id);
}

function rateEntry(history, month) {
  if (!Array.isArray(history) || !history.length) return null;
  const entries = history
    .filter((entry) => entry && /^\d{4}-\d{2}$/.test(String(entry.from || '')))
    .sort((a, b) => String(a.from).localeCompare(String(b.from)));
  if (!entries.length) return null;
  let found = null;
  for (const entry of entries) {
    if (entry.from <= month) found = entry;
    else break;
  }
  return found || entries[0];
}

function upsertRate(history, from, amount) {
  const entries = Array.isArray(history) ? history.slice() : [];
  const index = entries.findIndex((entry) => entry && entry.from === from);
  const record = { from, amount };
  if (index >= 0) entries[index] = record;
  else entries.push(record);
  return entries
    .filter((entry) => entry && /^\d{4}-\d{2}$/.test(String(entry.from || '')))
    .sort((a, b) => String(a.from).localeCompare(String(b.from)));
}

function defaultFeeFor(month = monthKeyOf()) {
  const entry = rateEntry(state.settings.feeHistory, month);
  if (entry && entry.amount != null) {
    const amount = Number(entry.amount);
    if (Number.isFinite(amount) && amount >= 0) return amount;
  }
  const fallback = Number(state.settings.defaultFee);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
}

function feeOf(resident, month = monthKeyOf()) {
  if (resident) {
    const entry = rateEntry(resident.feeHistory, month);
    if (entry) {
      if (entry.amount == null) return defaultFeeFor(month);
      const amount = Number(entry.amount);
      if (Number.isFinite(amount) && amount > 0) return amount;
      return defaultFeeFor(month);
    }
    const own = Number(resident.fee);
    if (Number.isFinite(own) && own > 0) return own;
  }
  return defaultFeeFor(month);
}

function isBilled(resident, month) {
  if (!resident) return false;
  if (resident.billingStart && month < resident.billingStart) return false;
  if (resident.billingEnd && month > resident.billingEnd) return false;
  return true;
}

function isArchived(resident) {
  return Boolean(resident && resident.billingEnd);
}

function isActive(resident, month = ui.month) {
  return !resident.billingEnd || resident.billingEnd >= month;
}

function paidFor(residentId, month) {
  return paidIndex.get(residentId + '|' + month) || 0;
}

function paidForExcluding(residentId, month, excludePaymentId) {
  let total = 0;
  for (const p of state.payments) {
    if (p.residentId === residentId && p.month === month && p.id !== excludePaymentId) {
      total += Number(p.amount) || 0;
    }
  }
  return r2(total);
}

function statusOf(resident, month) {
  if (!isBilled(resident, month)) return { kind: 'na', paid: 0, due: 0 };
  const due = feeOf(resident, month);
  const paid = paidFor(resident.id, month);
  let kind = 'unpaid';
  if (due <= 0) kind = 'na';
  else if (paid >= due - 0.005) kind = 'paid';
  else if (paid > 0) kind = 'partial';
  return { kind, paid, due };
}

function arrearsOf(resident, asOf = monthKeyOf()) {
  if (!resident || !resident.billingStart) return 0;
  const end = resident.billingEnd && resident.billingEnd < asOf ? resident.billingEnd : asOf;
  if (end < resident.billingStart) return 0;
  let total = 0;
  for (const m of monthsRange(resident.billingStart, end)) {
    total += Math.max(0, feeOf(resident, m) - paidFor(resident.id, m));
  }
  return r2(total);
}

function totalPaid(resident) {
  return r2(sum(state.payments.filter((p) => p.residentId === resident.id), (p) => p.amount));
}

function statsForMonth(month) {
  const billed = state.residents.filter((r) => isBilled(r, month));
  let expected = 0;
  let outstanding = 0;
  let paid = 0;
  let partial = 0;
  let unpaid = 0;

  for (const r of billed) {
    const s = statusOf(r, month);
    expected += s.due;
    outstanding += Math.max(0, s.due - s.paid);
    if (s.kind === 'paid') paid += 1;
    else if (s.kind === 'partial') partial += 1;
    else if (s.kind === 'unpaid') unpaid += 1;
  }

  const collected = monthCollected.get(month) || 0;
  return {
    month,
    count: billed.length,
    expected: r2(expected),
    collected: r2(collected),
    outstanding: r2(outstanding),
    paid,
    partial,
    unpaid,
    rate: expected > 0 ? Math.round((collected / expected) * 100) : 0
  };
}

function totalArrears(asOf = monthKeyOf()) {
  return r2(sum(state.residents, (r) => arrearsOf(r, asOf)));
}

function cmpResident(a, b) {
  const ha = (a.house || '~').trim();
  const hb = (b.house || '~').trim();
  return ha.localeCompare(hb, undefined, { numeric: true, sensitivity: 'base' })
    || String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' });
}

function matchesQuery(resident, query) {
  if (!query) return true;
  const hay = `${resident.name || ''} ${resident.house || ''} ${resident.phone || ''}`.toLowerCase();
  return hay.includes(query.toLowerCase());
}

function nextReceiptNo() {
  const n = Number(state.settings.receiptSeq) || 1;
  state.settings.receiptSeq = n + 1;
  return `R-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`;
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function avatarClass(id) {
  let hash = 0;
  for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return 'abcdef'[hash % 6];
}

function avatar(resident, large = false) {
  return `<span class="avatar avatar--${avatarClass(resident.id)}${large ? ' avatar--lg' : ''}" aria-hidden="true">${esc(initials(resident.name))}</span>`;
}

function pill(kind) {
  const map = {
    paid: ['paid', 'Paid'],
    partial: ['partial', 'Partial'],
    unpaid: ['unpaid', 'Unpaid'],
    na: ['na', 'Not billed']
  };
  const [cls, label] = map[kind] || map.na;
  return `<span class="pill pill--${cls}"><i></i>${label}</span>`;
}

function sortPayments(list) {
  return list.slice().sort((a, b) => {
    const byDate = String(b.paidOn || '').localeCompare(String(a.paidOn || ''));
    if (byDate) return byDate;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
}

/* ---------- icons ---------- */

const ICONS = {
  home: '<path d="M3 10.7 12 3l9 7.7"/><path d="M5.5 9.5V21h13V9.5"/><path d="M9.5 21v-6h5v6"/>',
  users: '<path d="M15.5 21v-1.8a4 4 0 0 0-4-4H6.5a4 4 0 0 0-4 4V21"/><circle cx="9" cy="7" r="3.6"/><path d="M17 3.3a3.6 3.6 0 0 1 0 7"/><path d="M21.5 21v-1.8a4 4 0 0 0-3-3.8"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z"/><path d="M9.5 8h5"/><path d="M9.5 12h5"/><path d="M9.5 16h3"/>',
  chart: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
  sliders: '<path d="M4 7h6"/><path d="M14 7h6"/><path d="M4 17h10"/><path d="M18 17h2"/><circle cx="12" cy="7" r="2"/><circle cx="16" cy="17" r="2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  check: '<path d="m5 13 4 4L19 7"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.4 2.1L8.1 9.9a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.4c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.7 2z"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  upload: '<path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M5 3h14"/>',
  printer: '<path d="M6 9V3h12v6"/><path d="M6 18H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4"/><path d="m15.4 6.5-6.8 4"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v11h14V9"/><path d="M10 13h4"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/>',
  shield: '<path d="M12 2 20 5.5V11c0 5.2-3.4 9.2-8 11-4.6-1.8-8-5.8-8-11V5.5L12 2z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  wifiOff: '<path d="m2 2 20 20"/><path d="M8.5 8.5a10.9 10.9 0 0 1 12 2.3"/><path d="M5 12.6a10.9 10.9 0 0 1 5-2.5"/><path d="M8.5 16.2a6 6 0 0 1 7 0"/><path d="M12 20h.01"/>',
  cloud: '<path d="M17.5 19a4.5 4.5 0 0 0 .5-9 6 6 0 0 0-11.6-1.5A4 4 0 0 0 6.5 19z"/>',
  arrowUpRight: '<path d="M7 17 17 7"/><path d="M8 7h9v9"/>'
};

function icon(name, size = 20) {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

function shieldMark(size = 22) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 2.4 20 6v5.2c0 5.1-3.4 9-8 10.8-4.6-1.8-8-5.7-8-10.8V6l8-3.6Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="m8.4 11.8 2.4 2.4 4.8-5.4" stroke="#e9c46a" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

/* ---------- data actions ---------- */

function addPayment(payment) {
  const record = {
    id: uid(),
    residentId: payment.residentId,
    month: payment.month,
    amount: r2(payment.amount),
    paidOn: payment.paidOn || isoDate(),
    method: payment.method || 'Cash',
    ref: payment.ref || '',
    note: payment.note || '',
    receiptNo: nextReceiptNo(),
    groupId: payment.groupId || null,
    createdAt: new Date().toISOString()
  };
  state.payments.push(record);
  return record;
}

function allocate(amount, months, resident, excludePaymentId = null) {
  let remaining = r2(amount);
  const result = [];

  // Fill months oldest-first, fully where possible, with the remainder on the last one.
  for (const m of months) {
    const need = Math.max(0, r2(feeOf(resident, m) - paidForExcluding(resident.id, m, excludePaymentId)));
    const applied = Math.min(remaining, need);
    result.push({ month: m, amount: r2(applied) });
    remaining = r2(remaining - applied);
  }

  // Anything left over is recorded as credit on the last selected month.
  if (remaining > 0 && result.length) {
    result[result.length - 1].amount = r2(result[result.length - 1].amount + remaining);
  }

  return result;
}

/* ==========================================================================
   Rendering
   ========================================================================== */

function applyTheme() {
  const theme = state.settings.theme || 'system';
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);

  const dark = theme === 'dark'
    || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0b110e' : '#f4f6f2');
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [seg, id] = raw.split('/').filter(Boolean);
  const known = ['dashboard', 'residents', 'payments', 'reports', 'settings'];

  if (seg === 'residents' && id) {
    ui.view = 'resident';
    ui.residentId = id;
  } else if (known.includes(seg)) {
    ui.view = seg;
  } else {
    ui.view = 'dashboard';
  }
}

function navLink(view, label, path) {
  const active = ui.view === view || (view === 'residents' && ui.view === 'resident');
  return `<a href="#/${path}" ${active ? 'aria-current="page"' : ''}>${label}</a>`;
}

function tabItem(view, label, iconName, path) {
  const active = ui.view === view || (view === 'residents' && ui.view === 'resident');
  return `<a href="#/${path}" ${active ? 'aria-current="page"' : ''}>
    ${icon(iconName, 21)}<span>${label}</span>
  </a>`;
}

function shell() {
  const name = state.settings.communityName || 'Security Dues';
  return `
    <header class="topbar">
      <div class="topbar__inner">
        <a class="brand" href="#/dashboard">
          <span class="brand__mark">${shieldMark(22)}</span>
          <span class="brand__text">
            <strong>${esc(name)}</strong>
            <span>Security dues ledger</span>
          </span>
        </a>
        <nav class="topnav" aria-label="Main">
          ${navLink('dashboard', 'Overview', 'dashboard')}
          ${navLink('residents', 'Households', 'residents')}
          ${navLink('payments', 'Payments', 'payments')}
          ${navLink('reports', 'Reports', 'reports')}
        </nav>
        <div class="topbar__actions">
          <button class="btn btn--primary btn--sm topbar-record" data-action="open-payment">
            ${icon('plus', 16)}<span>Record payment</span>
          </button>
          <a class="icon-btn" href="#/settings" aria-label="Settings">${icon('sliders')}</a>
        </div>
      </div>
    </header>
    <main class="wrap"><div data-sync-slot></div>${viewContent()}</main>
    <nav class="tabbar" aria-label="Main">
      ${tabItem('dashboard', 'Home', 'home', 'dashboard')}
      ${tabItem('residents', 'Households', 'users', 'residents')}
      <a href="#" class="tab-primary" data-action="open-payment" aria-label="Record payment">${icon('plus', 22)}<span>Record</span></a>
      ${tabItem('payments', 'Payments', 'receipt', 'payments')}
      ${tabItem('reports', 'Reports', 'chart', 'reports')}
    </nav>`;
}

function pageHead(title, sub, extra = '') {
  return `<section class="pagehead">
    <div>
      <h1>${esc(title)}</h1>
      ${sub ? `<p class="pagehead__sub">${sub}</p>` : ''}
    </div>
    ${extra}
  </section>`;
}

function monthSwitchHTML() {
  const m = ui.month;
  const isCurrent = m === monthKeyOf();
  return `<div class="month-switch">
    <button class="ms-arrow" data-action="month-prev" aria-label="Previous month">${icon('chevronLeft', 18)}</button>
    <label>
      <span>${esc(monthLabel(m))}</span>
      ${icon('calendar', 15)}
      <input class="js-month" type="month" value="${esc(m)}" aria-label="Choose month">
    </label>
    ${isCurrent ? '' : '<button class="ms-today" data-action="month-today">Today</button>'}
    <button class="ms-arrow" data-action="month-next" aria-label="Next month">${icon('chevronRight', 18)}</button>
  </div>`;
}

function statCard(label, value, note, tone = '') {
  return `<div class="stat ${tone ? 'stat--' + tone : ''}">
    <p class="stat__label">${esc(label)}</p>
    <p class="stat__value">${value}</p>
    ${note ? `<p class="stat__note">${note}</p>` : ''}
  </div>`;
}

function viewContent() {
  switch (ui.view) {
    case 'resident': return viewResident();
    case 'residents': return viewResidents();
    case 'payments': return viewPayments();
    case 'reports': return viewReports();
    case 'settings': return viewSettings();
    default: return viewDashboard();
  }
}

function render() {
  applyTheme();
  const app = $('#app');
  if (!app) return;

  if (!state.settings.setupComplete) {
    document.body.classList.add('is-setup');
    app.innerHTML = viewSetup();
    updateSyncStatus();
    return;
  }

  document.body.classList.remove('is-setup');
  app.innerHTML = shell();
  updateSyncStatus();
}

/* ---------- setup ---------- */

function currencyDatalist() {
  const list = ['₦', 'KSh', 'GH₵', 'R', '$', '£', '€', 'TSh', 'USh', 'ZK', 'P', 'FCFA'];
  return `<datalist id="currency-list">${list.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist>`;
}

function viewSetup() {
  const defaultFee = state.settings.defaultFee || 1000;
  return `<div class="setup">
    <div class="setup__panel">
      <div class="setup__brand">
        <span class="brand__mark">${shieldMark(22)}</span>
        <span>Security Dues</span>
      </div>
      <h1>Set up your neighbourhood ledger</h1>
      <p class="setup__lede">Keep a clear record of who has paid their monthly security fee, who still owes, and hand out receipts in seconds.</p>

      <div data-sync-slot></div>

      <form class="setup__form form" data-form="setup">
        <div class="field">
          <label for="setup-name">Estate or community name</label>
          <input id="setup-name" name="communityName" placeholder="e.g. Riverside Estate" maxlength="60" required autofocus>
        </div>
        <div class="grid-2">
          <div class="field">
            <label for="setup-currency">Currency</label>
            <input id="setup-currency" name="currency" list="currency-list" value="${esc(state.settings.currency || '₦')}" maxlength="6" required>
            ${currencyDatalist()}
            <span class="hint">Symbol or code, e.g. ₦, $, £</span>
          </div>
          <div class="field">
            <label for="setup-fee">Default monthly fee</label>
            <input id="setup-fee" name="defaultFee" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(defaultFee)}" required>
            <span class="hint">You can set a different fee per household</span>
          </div>
        </div>
        <p class="form-error" data-error></p>
        <button class="btn btn--primary btn--block" type="submit">Start tracking</button>
      </form>

      <ul class="setup__points">
        <li>${icon('check', 16)} Works offline — no internet needed</li>
        <li>${icon('check', 16)} No account, no subscription</li>
        <li>${icon('check', 16)} Export a backup any time</li>
      </ul>
      <p class="setup__fine">Records are stored only on this device and browser. Download a backup regularly.</p>
    </div>
    <aside class="setup__art" aria-hidden="true">
      <div class="setup__art-inner">
        <div class="setup__art-shield">${shieldMark(92)}</div>
        <h2>One ledger for the whole street</h2>
        <p>Monthly fees, arrears, receipts and reports — all in one place, even without a signal.</p>
      </div>
    </aside>
  </div>`;
}

/* ---------- dashboard ---------- */

function backupBanner() {
  if (state.payments.length < 3) return '';
  if (daysSince(state.settings.lastBackupAt) < 30) return '';
  return `<div class="banner">
    <span style="color:var(--gold)">${icon('cloud', 20)}</span>
    <div class="grow">
      <strong>Keep a backup.</strong>
      ${state.settings.lastBackupAt ? 'It has been over a month since your last one.' : 'Your records live only on this device.'}
    </div>
    <button class="btn btn--ghost btn--sm" data-action="export-backup">Download</button>
  </div>`;
}

function viewDashboard() {
  const m = ui.month;
  const st = statsForMonth(m);
  const arrears = totalArrears();
  const rate = st.expected > 0 ? Math.round((st.collected / st.expected) * 100) : 0;
  const attention = state.residents
    .filter((r) => isBilled(r, m))
    .map((r) => ({ r, s: statusOf(r, m), owed: arrearsOf(r) }))
    .filter((x) => x.s.kind === 'unpaid' || x.s.kind === 'partial')
    .sort((a, b) => b.owed - a.owed || cmpResident(a.r, b.r));
  const recent = sortPayments(state.payments).slice(0, 6);
  const cashReceived = r2(sum(state.payments.filter((p) => String(p.paidOn || '').slice(0, 7) === m), (p) => p.amount));

  let attentionHTML;
  if (!state.residents.length) {
    attentionHTML = `<section class="empty" style="margin-top:16px">
      <div class="empty__icon">${icon('users', 24)}</div>
      <h2>Add your first household</h2>
      <p>Start by adding the people on your street, then record their monthly security fee.</p>
      <button class="btn btn--primary" data-action="add-resident">${icon('plus', 16)} Add household</button>
    </section>`;
  } else if (!attention.length) {
    attentionHTML = `<section class="card" style="margin-top:16px">
      <div class="card__head"><div><h2>Needs attention</h2><p class="muted">Everyone billed in ${esc(monthLabel(m, true))} has paid.</p></div></div>
      <div class="empty" style="padding:26px 18px;border-style:solid">
        <div class="empty__icon">${icon('check', 24)}</div>
        <h3>All settled</h3>
        <p>No outstanding balances for this month.</p>
      </div>
    </section>`;
  } else {
    attentionHTML = `<section class="card" style="margin-top:16px">
      <div class="card__head">
        <div>
          <h2>Needs attention</h2>
          <p class="muted">${attention.length} household${attention.length === 1 ? '' : 's'} still owe for ${esc(monthLabel(m, true))}</p>
        </div>
        <button class="btn btn--soft btn--sm" data-action="open-payment">${icon('plus', 15)} Record</button>
      </div>
      <div class="rows">
        ${attention.map(({ r, s, owed }) => `<button class="row" data-action="quick-pay" data-resident="${r.id}" data-month="${m}">
          ${avatar(r)}
          <div class="row__main">
            <div class="row__title">${esc(r.name)}</div>
            <div class="row__meta">${r.house ? 'House ' + esc(r.house) + ' · ' : ''}${s.kind === 'partial' ? money(s.due - s.paid) + ' short' : money(s.due) + ' due'}${owed > s.due - s.paid ? ' · ' + money(owed) + ' in arrears' : ''}</div>
          </div>
          <div class="row__end">${pill(s.kind)}</div>
        </button>`).join('')}
      </div>
    </section>`;
  }

  return `
    ${pageHead('Overview', `${esc(monthLabel(m))} · ${st.count} household${st.count === 1 ? '' : 's'} billed`, monthSwitchHTML())}
    <section class="hero">
      <div class="hero__row">
        <div>
          <p class="hero__label">Fees collected for ${esc(monthLabel(m, true))}</p>
          <p class="hero__amount">${money(st.collected)}</p>
          <p class="hero__sub">of ${money(st.expected)} expected this month</p>
        </div>
        <div class="hero__badge">${st.expected > 0 ? rate + '%' : '—'}<span>collected</span></div>
      </div>
      <div class="bars" aria-hidden="true"><span style="width:${clamp(rate, 0, 100)}%"></span></div>
      <div class="hero__foot">
        <span><b>${st.paid}</b> paid</span>
        <span><b>${st.partial}</b> partial</span>
        <span><b>${st.unpaid}</b> unpaid</span>
        <span><b>${money(st.outstanding)}</b> still due</span>
        ${Math.abs(cashReceived - st.collected) > 0.005 ? `<span><b>${money(cashReceived)}</b> cash received</span>` : ''}
      </div>
    </section>

    <div class="statgrid">
      ${statCard('Households', String(st.count), 'billed this month')}
      ${statCard('Fully paid', String(st.paid), st.count ? 'of ' + st.count + ' households' : 'no households yet', 'accent')}
      ${statCard('Outstanding', money(st.outstanding), 'still due this month', st.outstanding > 0 ? 'warn' : '')}
      ${statCard('Arrears', money(arrears), 'across all months', arrears > 0 ? 'danger' : '')}
    </div>

    ${backupBanner()}
    ${attentionHTML}

    ${state.payments.length ? `<section class="card" style="margin-top:16px">
      <div class="card__head">
        <div><h2>Recent payments</h2><p class="muted">Latest recorded receipts</p></div>
        <a class="btn btn--ghost btn--sm" href="#/payments">View all</a>
      </div>
      <div class="rows">
        ${recent.map((p) => {
          const r = residentById(p.residentId);
          return `<button class="row" data-action="open-receipt" data-ids="${p.id}">
            ${r ? avatar(r) : ''}
            <div class="row__main">
              <div class="row__title">${esc(r ? r.name : 'Removed household')}</div>
              <div class="row__meta">${esc(monthLabel(p.month, true))} · paid ${fmtDate(p.paidOn)}</div>
            </div>
            <div class="row__end">
              <span class="row__amount">${money(p.amount)}</span>
              <span class="row__sub">${esc(p.receiptNo || '')}</span>
            </div>
          </button>`;
        }).join('')}
      </div>
    </section>` : ''}
  `;
}

/* ---------- residents ---------- */

function filterCounts() {
  const billed = state.residents.filter((r) => isBilled(r, ui.month));
  const counts = { all: billed.length, paid: 0, partial: 0, unpaid: 0, archived: state.residents.filter(isArchived).length };
  for (const r of billed) {
    const kind = statusOf(r, ui.month).kind;
    if (counts[kind] != null) counts[kind] += 1;
  }
  return counts;
}

function filteredResidents() {
  const q = ui.search.trim();
  return state.residents
    .filter((r) => {
      if (ui.filter === 'archived') return isArchived(r);
      if (r.billingEnd && r.billingEnd < ui.month) return false;
      const kind = statusOf(r, ui.month).kind;
      if (ui.filter === 'all') return true;
      return kind === ui.filter;
    })
    .filter((r) => matchesQuery(r, q))
    .sort(cmpResident);
}

function residentListHTML() {
  const list = filteredResidents();
  if (!list.length) {
    return `<div class="empty">
      <div class="empty__icon">${icon('search', 24)}</div>
      <h2>${state.residents.length ? 'No households match' : 'No households yet'}</h2>
      <p>${state.residents.length ? 'Try a different search or filter.' : 'Add the people on your street to start tracking their security fees.'}</p>
      <button class="btn btn--primary" data-action="add-resident">${icon('plus', 16)} Add household</button>
    </div>`;
  }

  return `<div class="list list--card">
    ${list.map((r) => {
      const s = statusOf(r, ui.month);
      let amount = '—';
      if (s.kind === 'paid' || s.kind === 'partial') amount = money(s.paid);
      else if (s.kind === 'unpaid') amount = money(s.due);
      return `<a class="row" href="#/residents/${r.id}">
        ${avatar(r)}
        <div class="row__main">
          <div class="row__title">${esc(r.name)}</div>
          <div class="row__meta">${r.house ? 'House ' + esc(r.house) : 'No house no.'}${r.phone ? ' · ' + esc(r.phone) : ''}${isArchived(r) ? ' · moved out' : ''}</div>
        </div>
        <div class="row__end">
          ${pill(s.kind)}
          <span class="row__amount">${amount}</span>
        </div>
      </a>`;
    }).join('')}
  </div>`;
}

function viewResidents() {
  const counts = filterCounts();
  const filters = [
    ['all', 'All'],
    ['paid', 'Paid'],
    ['partial', 'Partial'],
    ['unpaid', 'Unpaid'],
    ['archived', 'Moved out']
  ];

  return `
    ${pageHead('Households', `${counts.all} billed for ${esc(monthLabel(ui.month, true))}`, monthSwitchHTML())}
    <div class="toolbar">
      <div class="search">
        ${icon('search', 18)}
        <input id="resident-search" type="search" placeholder="Search name, house or phone" value="${esc(ui.search)}" aria-label="Search households">
      </div>
      <button class="btn btn--primary" data-action="add-resident">${icon('plus', 16)}<span>Add household</span></button>
    </div>
    <div class="chips" role="group" aria-label="Filter households">
      ${filters.map(([key, label]) => `<button class="chip" data-action="set-filter" data-filter="${key}" aria-pressed="${ui.filter === key}">${label}<span class="count">${counts[key] || 0}</span></button>`).join('')}
    </div>
    <div id="resident-results">${residentListHTML()}</div>
  `;
}

/* ---------- resident detail ---------- */

function viewResident() {
  const r = residentById(ui.residentId);
  if (!r) {
    return `<div class="empty">
      <div class="empty__icon">${icon('users', 24)}</div>
      <h2>Household not found</h2>
      <p>It may have been removed.</p>
      <a class="btn btn--primary" href="#/residents">Back to households</a>
    </div>`;
  }

  const m = ui.month;
  const s = statusOf(r, m);
  const owed = arrearsOf(r);
  const paidAllTime = totalPaid(r);

  const gridStart = r.billingStart && r.billingStart > addMonths(m, -11) ? r.billingStart : addMonths(m, -11);
  const gridMonths = monthsRange(gridStart, m);
  const payments = sortPayments(state.payments.filter((p) => p.residentId === r.id));

  return `
    <a class="back" href="#/residents">${icon('arrowLeft', 16)} Households</a>
    <section class="detail-head">
      ${avatar(r, true)}
      <div class="detail-head__main">
        <h1>${esc(r.name)}</h1>
        <div class="detail-head__meta">
          ${r.house ? `<span>House ${esc(r.house)}</span>` : ''}
          ${r.phone ? `<a href="tel:${esc(String(r.phone).replace(/[^+\d]/g, ''))}">${icon('phone', 14)} ${esc(r.phone)}</a>` : ''}
          <span>${money(feeOf(r))} / month</span>
          ${isArchived(r) ? `<span class="pill pill--na">Moved out ${esc(monthLabel(r.billingEnd, true))}</span>` : ''}
        </div>
      </div>
      <div class="detail-head__actions">
        <button class="btn btn--ghost btn--sm" data-action="edit-resident" data-resident="${r.id}">${icon('edit', 15)} Edit</button>
        <button class="btn btn--primary btn--sm" data-action="quick-pay" data-resident="${r.id}" data-month="${m}">${icon('plus', 15)} Record</button>
      </div>
    </section>

    <div class="statgrid detail-stats">
      ${statCard('This month', money(s.paid) + (s.due ? ' / ' + money(s.due) : ''), monthLabel(m), '')}
      ${statCard('Paid all time', money(paidAllTime), payments.length + ' payment' + (payments.length === 1 ? '' : 's'), 'accent')}
      ${statCard('Outstanding', money(owed), owed > 0 ? 'total arrears' : 'all settled', owed > 0 ? 'danger' : '')}
    </div>

    ${r.notes ? `<div class="card" style="margin-top:16px"><p style="font-size:.86rem;color:var(--ink-soft)">${esc(r.notes)}</p></div>` : ''}

    <section class="card" style="margin-top:16px">
      <div class="card__head">
        <div><h2>Payment record</h2><p class="muted">Last 12 months up to ${esc(monthLabel(m, true))}</p></div>
        <div>${pill(s.kind)}</div>
      </div>
      ${gridMonths.length ? `<div class="month-grid">
        ${gridMonths.map((mm) => {
          const st = statusOf(r, mm);
          const action = st.kind === 'paid' ? 'month-detail' : st.kind === 'na' ? '' : 'quick-pay';
          const value = st.kind === 'na' ? '—' : st.kind === 'unpaid' ? money(st.due) : money(st.paid);
          return `<button class="mcell mcell--${st.kind}" ${action ? `data-action="${action}" data-resident="${r.id}" data-month="${mm}"` : 'disabled'}>
            <span class="mcell__label">${esc(monthLabel(mm, true))}</span>
            <span class="mcell__value">${value}</span>
          </button>`;
        }).join('')}
      </div>` : '<p class="muted" style="font-size:.86rem">Billing starts in ' + esc(monthLabel(r.billingStart)) + '.</p>'}
      <div class="legend">
        <span><i class="l-paid"></i> Paid</span>
        <span><i class="l-partial"></i> Partial</span>
        <span><i class="l-unpaid"></i> Unpaid</span>
        <span><i></i> Not billed</span>
      </div>
    </section>

    <section class="card">
      <div class="card__head">
        <div><h2>Payments</h2><p class="muted">${payments.length} record${payments.length === 1 ? '' : 's'} on file</p></div>
        <button class="btn btn--soft btn--sm" data-action="statement" data-resident="${r.id}">${icon('printer', 15)} Statement</button>
      </div>
      ${payments.length ? `<div class="rows">
        ${payments.map((p) => `<button class="row" data-action="open-receipt" data-ids="${p.id}">
          <div class="row__main">
            <div class="row__title">${esc(monthLabel(p.month))}</div>
            <div class="row__meta">Paid ${fmtDate(p.paidOn)} · ${esc(p.method || 'Cash')}${p.ref ? ' · ' + esc(p.ref) : ''}</div>
          </div>
          <div class="row__end">
            <span class="row__amount">${money(p.amount)}</span>
            <span class="row__sub">${esc(p.receiptNo || '')}</span>
          </div>
        </button>`).join('')}
      </div>` : `<p class="muted" style="font-size:.86rem">No payments recorded yet.</p>`}
    </section>

    <section class="card danger-zone">
      <h2>Household settings</h2>
      <p>${isArchived(r) ? 'This household is marked as moved out. Their records are kept for your history.' : 'Archive a household when they move out. Their history stays intact and they stop appearing in monthly totals.'}</p>
      <div class="actions">
        ${isArchived(r)
          ? `<button class="btn btn--ghost btn--sm" data-action="unarchive-resident" data-resident="${r.id}">${icon('archive', 15)} Restore household</button>`
          : `<button class="btn btn--ghost btn--sm" data-action="archive-resident" data-resident="${r.id}">${icon('archive', 15)} Archive (moved out)</button>`}
        <button class="btn btn--danger-ghost btn--sm" data-action="delete-resident" data-resident="${r.id}">${icon('trash', 15)} Delete household</button>
      </div>
    </section>
  `;
}

/* ---------- payments ---------- */

function filteredPayments() {
  const q = ui.paySearch.trim().toLowerCase();
  return sortPayments(state.payments.filter((p) => {
    if (ui.payMonth !== 'all' && p.month !== ui.payMonth) return false;
    if (!q) return true;
    const r = residentById(p.residentId);
    const hay = `${r ? r.name : ''} ${r ? r.house : ''} ${p.method || ''} ${p.ref || ''} ${p.note || ''} ${monthLabel(p.month)}`.toLowerCase();
    return hay.includes(q);
  }));
}

function paymentsListHTML() {
  const rows = filteredPayments();
  const total = r2(sum(rows, (p) => p.amount));

  let list;
  if (!rows.length) {
    list = `<div class="empty">
      <div class="empty__icon">${icon('receipt', 24)}</div>
      <h2>${state.payments.length ? 'No payments match' : 'No payments yet'}</h2>
      <p>${state.payments.length ? 'Try another month or search term.' : 'Recorded payments will appear here with their receipts.'}</p>
      <button class="btn btn--primary" data-action="open-payment">${icon('plus', 16)} Record payment</button>
    </div>`;
  } else {
    list = `<div class="list list--card">
      ${rows.map((p) => {
        const r = residentById(p.residentId);
        return `<button class="row" data-action="open-receipt" data-ids="${p.id}">
          ${r ? avatar(r) : ''}
          <div class="row__main">
            <div class="row__title">${esc(r ? r.name : 'Removed household')}</div>
            <div class="row__meta">${esc(monthLabel(p.month, true))} · paid ${fmtDate(p.paidOn)} · ${esc(p.method || 'Cash')}${p.ref ? ' · ' + esc(p.ref) : ''}</div>
          </div>
          <div class="row__end">
            <span class="row__amount">${money(p.amount)}</span>
            <span class="row__sub">${esc(p.receiptNo || '')}</span>
          </div>
        </button>`;
      }).join('')}
    </div>`;
  }

  return `<div class="ledger-summary"><strong>${money(total)}</strong><span>from ${rows.length} payment${rows.length === 1 ? '' : 's'}${ui.payMonth === 'all' ? '' : ' for ' + esc(monthLabel(ui.payMonth, true))}</span></div>${list}`;
}

function viewPayments() {
  const months = Array.from(new Set([...state.payments.map((p) => p.month), monthKeyOf()])).sort().reverse();
  return `
    ${pageHead('Payments', 'Every receipt in one ledger')}
    <div class="toolbar">
      <div class="search">
        ${icon('search', 18)}
        <input id="payment-search" type="search" placeholder="Search household, method or reference" value="${esc(ui.paySearch)}" aria-label="Search payments">
      </div>
      <select class="select" id="pay-month-filter" aria-label="Filter by month covered">
        <option value="all" ${ui.payMonth === 'all' ? 'selected' : ''}>All months</option>
        ${months.map((m) => `<option value="${m}" ${ui.payMonth === m ? 'selected' : ''}>${esc(monthLabel(m))}</option>`).join('')}
      </select>
      <button class="btn btn--primary" data-action="open-payment">${icon('plus', 16)}<span>Record</span></button>
    </div>
    <div id="payments-results" style="margin-top:14px">${paymentsListHTML()}</div>
  `;
}

/* ---------- reports ---------- */

function viewReports() {
  const year = ui.reportYear;
  const rows = Array.from({ length: 12 }, (_, i) => statsForMonth(`${year}-${pad2(i + 1)}`));
  const totals = {
    expected: r2(sum(rows, (r) => r.expected)),
    collected: r2(sum(rows, (r) => r.collected)),
    outstanding: r2(sum(rows, (r) => r.outstanding))
  };
  const maxExpected = Math.max(1, ...rows.map((r) => r.expected));
  const arrearsList = state.residents
    .map((r) => ({ r, owed: arrearsOf(r) }))
    .filter((x) => x.owed > 0)
    .sort((a, b) => b.owed - a.owed)
    .slice(0, 10);

  return `
    ${pageHead('Reports', 'Collection performance and outstanding balances', `<div class="month-switch">
      <button class="ms-arrow" data-action="year-prev" aria-label="Previous year">${icon('chevronLeft', 18)}</button>
      <label style="cursor:default"><span>${year}</span></label>
      <button class="ms-arrow" data-action="year-next" aria-label="Next year">${icon('chevronRight', 18)}</button>
    </div>`)}

    <div class="statgrid" style="margin-top:0">
      ${statCard('Expected in ' + year, money(totals.expected), 'all billed months')}
      ${statCard('Collected', money(totals.collected), totals.expected ? Math.round((totals.collected / totals.expected) * 100) + '% of expected' : '—', 'accent')}
      ${statCard('Outstanding', money(totals.outstanding), 'still owed for ' + year, totals.outstanding > 0 ? 'warn' : '')}
      ${statCard('Arrears to date', money(totalArrears()), 'all years, all households', totalArrears() > 0 ? 'danger' : '')}
    </div>

    <section class="card" style="margin-top:16px">
      <div class="card__head">
        <div><h2>Monthly collection</h2><p class="muted">Share of expected fees collected each month</p></div>
      </div>
      <div class="chart" role="img" aria-label="Collected share by month for ${year}">
        ${rows.map((r, i) => {
          const height = maxExpected > 0 ? Math.round((r.collected / maxExpected) * 100) : 0;
          const name = parseMonth(r.month).toLocaleDateString(undefined, { month: 'short' });
          const isCurrent = r.month === monthKeyOf();
          return `<div class="chart__col ${r.expected ? '' : 'is-empty'} ${isCurrent ? 'is-current' : ''}" title="${esc(monthLabel(r.month))}: ${money(r.collected)} of ${money(r.expected)}">
            <div class="chart__track"><div class="chart__fill" style="height:${height}%"></div></div>
            <span class="chart__label">${name}</span>
          </div>`;
        }).join('')}
      </div>
      <div class="chart-legend"><span>Collected per month</span><span>Peak scale ${money(maxExpected)}</span></div>
    </section>

    <section class="card">
      <div class="card__head">
        <div><h2>${year} at a glance</h2><p class="muted">Expected is based on each household's fee and billing period</p></div>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Month</th><th class="num">Expected</th><th class="num">Collected</th><th class="num">Outstanding</th><th>Rate</th></tr></thead>
          <tbody>
            ${rows.map((r) => {
              const rate = r.expected > 0 ? Math.round((r.collected / r.expected) * 100) : 0;
              return `<tr>
                <td>${esc(monthLabel(r.month, true))}</td>
                <td class="num">${r.expected ? money(r.expected) : '—'}</td>
                <td class="num">${r.collected ? money(r.collected) : '—'}</td>
                <td class="num" style="${r.outstanding > 0 ? 'color:var(--danger)' : ''}">${r.outstanding ? money(r.outstanding) : '—'}</td>
                <td>${r.expected ? `<span class="rate"><span class="rate__track"><span class="rate__fill" style="width:${clamp(rate, 0, 100)}%"></span></span><span class="rate__pct">${rate}%</span></span>` : '—'}</td>
              </tr>`;
            }).join('')}
          </tbody>
          <tfoot><tr>
            <td>Total</td>
            <td class="num">${money(totals.expected)}</td>
            <td class="num">${money(totals.collected)}</td>
            <td class="num">${money(totals.outstanding)}</td>
            <td>${totals.expected ? Math.round((totals.collected / totals.expected) * 100) + '%' : '—'}</td>
          </tr></tfoot>
        </table>
      </div>
    </section>

    <section class="card">
      <div class="card__head">
        <div><h2>Largest outstanding balances</h2><p class="muted">Households with the biggest unpaid totals</p></div>
      </div>
      ${arrearsList.length ? `<div class="rows">
        ${arrearsList.map(({ r, owed }) => `<a class="row" href="#/residents/${r.id}">
          ${avatar(r)}
          <div class="row__main">
            <div class="row__title">${esc(r.name)}</div>
            <div class="row__meta">${r.house ? 'House ' + esc(r.house) : 'No house no.'}${isArchived(r) ? ' · moved out' : ''}</div>
          </div>
          <div class="row__end"><span class="row__amount" style="color:var(--danger)">${money(owed)}</span></div>
        </a>`).join('')}
      </div>` : '<p class="muted" style="font-size:.86rem">No outstanding balances. Every household is up to date.</p>'}
    </section>

    <section class="card">
      <div class="card__head"><div><h2>Export &amp; backup</h2><p class="muted">Spreadsheets for Excel, or a full backup file</p></div></div>
      <div class="setting-row">
        <div class="setting-row__text"><strong>Payments spreadsheet</strong><span>Every payment with household, month and receipt number</span></div>
        <div class="setting-row__control"><button class="btn btn--soft btn--sm" data-action="export-payments-csv">${icon('download', 15)} CSV</button></div>
      </div>
      <div class="setting-row">
        <div class="setting-row__text"><strong>Households spreadsheet</strong><span>Balances, fees and contact details</span></div>
        <div class="setting-row__control"><button class="btn btn--soft btn--sm" data-action="export-households-csv">${icon('download', 15)} CSV</button></div>
      </div>
      <div class="setting-row">
        <div class="setting-row__text"><strong>Full backup</strong><span>Restore everything later on this or another device</span></div>
        <div class="setting-row__control"><button class="btn btn--soft btn--sm" data-action="export-backup">${icon('download', 15)} JSON</button></div>
      </div>
    </section>
  `;
}

/* ---------- settings ---------- */

function viewSettings() {
  const s = state.settings;
  const bytes = new Blob([JSON.stringify(state)]).size;
  const installable = Boolean(deferredInstallPrompt);

  return `
    ${pageHead('Settings', 'Community details, appearance and data')}

    <form class="form" data-form="settings">
      <div class="card">
        <div class="card__head"><div><h2>Community</h2><p class="muted">Shown on receipts and in the app header</p></div></div>
        <div class="grid-2">
          <div class="field">
            <label for="set-name">Estate or community name</label>
            <input id="set-name" name="communityName" value="${esc(s.communityName)}" maxlength="60" required>
          </div>
          <div class="field">
            <label for="set-currency">Currency</label>
            <input id="set-currency" name="currency" list="currency-list" value="${esc(s.currency)}" maxlength="6" required>
            ${currencyDatalist()}
          </div>
          <div class="field">
            <label for="set-fee">Default monthly fee</label>
            <input id="set-fee" name="defaultFee" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(s.defaultFee)}" required>
            <span class="hint">Used by households without their own fee</span>
          </div>
          <div class="field">
            <label for="set-due">Fee due day</label>
            <input id="set-due" name="dueDay" type="number" min="1" max="28" step="1" value="${esc(s.dueDay || 5)}">
            <span class="hint">A reminder of your collection day</span>
          </div>
        </div>
        <div class="field" style="margin-top:14px">
          <label for="set-fee-from">New default applies from</label>
          <input id="set-fee-from" name="feeFrom" type="month" value="${esc(monthKeyOf())}">
          <span class="hint">Only used when you change the default fee. Earlier months keep their old fee.</span>
        </div>
        <p class="form-error" data-error style="margin-top:14px"></p>
        <div style="margin-top:16px"><button class="btn btn--primary" type="submit">Save changes</button></div>
      </div>
    </form>

    <div class="section-title"><h2>Appearance</h2></div>
    <div class="card">
      <div class="setting-row">
        <div class="setting-row__text"><strong>Theme</strong><span>Follow your device or pick one</span></div>
        <div class="segmented" role="group" aria-label="Theme">
          ${['system', 'light', 'dark'].map((t) => `<button type="button" data-action="set-theme" data-theme="${t}" aria-pressed="${(s.theme || 'system') === t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-row__text"><strong>Install on this device</strong><span>${installable ? 'Add it to your home screen for one-tap access' : 'Use your browser menu → "Add to Home screen" to install'}</span></div>
        <div class="setting-row__control">
          ${installable ? `<button type="button" class="btn btn--soft btn--sm" data-action="install-app">${icon('download', 15)} Install app</button>` : `<span class="pill">Offline ready</span>`}
        </div>
      </div>
    </div>

    <div class="section-title"><h2>Data</h2></div>
    <div class="card">
      <div class="setting-row">
        <div class="setting-row__text"><strong>Database</strong><span>Firebase Firestore · ${esc(FIREBASE.projectId)}</span></div>
        <div class="setting-row__control">
          <span class="pill" data-sync-status>${syncLabel()}</span>
          <button type="button" class="btn btn--ghost btn--sm" data-action="sync-retry">Sync now</button>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-row__text"><strong>Backup</strong><span>${s.lastBackupAt ? 'Last backup ' + fmtDate(s.lastBackupAt) : 'No backup downloaded yet'}</span></div>
        <div class="setting-row__control"><button type="button" class="btn btn--soft btn--sm" data-action="export-backup">${icon('download', 15)} Download</button></div>
      </div>
      <div class="setting-row">
        <div class="setting-row__text"><strong>Restore from backup</strong><span>Replace all current data with a backup file</span></div>
        <div class="setting-row__control"><button type="button" class="btn btn--ghost btn--sm" data-action="import-backup">${icon('upload', 15)} Choose file</button></div>
      </div>
      <div class="setting-row">
        <div class="setting-row__text"><strong>Export spreadsheets</strong><span>Payments and household balances as CSV</span></div>
        <div class="setting-row__control">
          <button type="button" class="btn btn--ghost btn--sm" data-action="export-payments-csv">Payments</button>
          <button type="button" class="btn btn--ghost btn--sm" data-action="export-households-csv">Households</button>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-row__text"><strong>Delete records</strong><span>Remove every household and payment, keep community settings</span></div>
        <div class="setting-row__control"><button type="button" class="btn btn--danger-ghost btn--sm" data-action="delete-records">${icon('trash', 15)} Delete records</button></div>
      </div>
      <p class="storage-note"><b>${state.residents.length}</b> households · <b>${state.payments.length}</b> payments · about <b>${Math.max(1, Math.round(bytes / 1024))} KB</b> cached in this browser and synced to <b>Firestore</b>.</p>
    </div>

    <div class="section-title"><h2>About</h2></div>
    <div class="card">
      <p style="font-size:.86rem;color:var(--ink-soft)">
        <strong style="color:var(--ink)">Security Dues</strong> v${APP_VERSION}. A small offline ledger for neighbourhood security fees.
        Records are saved in this browser and synced to Firebase Firestore. Clearing browser data will not remove the database, but download a backup now and then for safekeeping.
      </p>
      <div class="setting-row" style="margin-top:6px">
        <div class="setting-row__text"><strong>Start over</strong><span>Erase everything and run setup again</span></div>
        <div class="setting-row__control"><button type="button" class="btn btn--ghost btn--sm" data-action="reset-app">Reset app</button></div>
      </div>
    </div>
  `;
}

/* ==========================================================================
   Modals
   ========================================================================== */

const PAY_METHODS = ['Cash', 'M-Pesa', 'Bank transfer', 'Mobile money', 'Cheque', 'Other'];

let lastFocused = null;
let pendingConfirm = null;
let deferredInstallPrompt = null;

function openModal({ title, body, size = '', onMount = null }) {
  const root = $('#modal-root');
  lastFocused = document.activeElement;
  root.innerHTML = `<div class="modal-backdrop" data-action="close-modal"></div>
    <div class="modal ${size}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <header class="modal__head">
        <h2 id="modal-title">${esc(title)}</h2>
        <button class="icon-btn" type="button" data-action="close-modal" aria-label="Close">${icon('x', 20)}</button>
      </header>
      <div class="modal__body">${body}</div>
    </div>`;
  root.classList.add('is-open');
  root.setAttribute('aria-hidden', 'false');
  document.body.classList.add('no-scroll');

  window.setTimeout(() => {
    const target = root.querySelector('[autofocus], input:not([type="hidden"]), select, textarea, .modal button');
    if (target) target.focus({ preventScroll: true });
  }, 40);

  if (onMount) onMount(root);
}

function closeModal() {
  const root = $('#modal-root');
  if (!root.classList.contains('is-open')) return;
  root.classList.remove('is-open');
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = '';
  document.body.classList.remove('no-scroll');

  if (pendingConfirm) {
    const resolve = pendingConfirm;
    pendingConfirm = null;
    resolve(false);
  }
  if (lastFocused && document.contains(lastFocused)) {
    lastFocused.focus({ preventScroll: true });
  }
  lastFocused = null;
}

function askConfirm({ title, message, confirmText = 'Confirm', danger = true }) {
  return new Promise((resolve) => {
    pendingConfirm = resolve;
    openModal({
      title,
      body: `<p class="modal-text">${message}</p>
        <div class="modal-actions">
          <button type="button" class="btn btn--ghost" data-action="close-modal">Cancel</button>
          <button type="button" class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-confirm="1">${esc(confirmText)}</button>
        </div>`
    });
  });
}

/* ---------- toast ---------- */

function toast(message, tone = '') {
  const root = $('#toast-root');
  const el = document.createElement('div');
  el.className = `toast ${tone ? 'toast--' + tone : ''}`;
  el.innerHTML = `${tone === 'success' ? icon('check', 16) : tone === 'error' ? icon('info', 16) : ''}<span>${esc(message)}</span>`;
  root.appendChild(el);
  window.setTimeout(() => {
    el.classList.add('leaving');
    window.setTimeout(() => el.remove(), 220);
  }, 3200);
}

/* ---------- payment modal ---------- */

function defaultMonthFor(resident) {
  const cur = monthKeyOf();
  if (!resident) return cur;
  if (isBilled(resident, cur) && statusOf(resident, cur).kind !== 'paid') return cur;

  const start = resident.billingStart || cur;
  for (const m of monthsRange(start, cur)) {
    const kind = statusOf(resident, m).kind;
    if (kind === 'unpaid' || kind === 'partial') return m;
  }
  for (const m of monthsRange(cur, addMonths(cur, 3))) {
    if (isBilled(resident, m) && statusOf(resident, m).kind !== 'paid') return m;
  }
  return cur;
}

function openPaymentModal({ residentId = null, month = null, editId = null } = {}) {
  const editing = editId ? state.payments.find((p) => p.id === editId) : null;
  if (editId && !editing) return;

  if (!state.residents.length) {
    toast('Add a household first');
    openResidentForm(null);
    return;
  }

  let currentResident = editing
    ? residentById(editing.residentId)
    : (residentId ? residentById(residentId) : null);

  if (!currentResident) {
    const sorted = state.residents.slice().sort(cmpResident);
    currentResident = sorted.find((r) => statusOf(r, monthKeyOf()).kind !== 'paid' && isBilled(r, monthKeyOf())) || sorted[0];
  }

  const initialMonth = editing ? editing.month : (month || defaultMonthFor(currentResident));
  const selected = new Set();
  if (editing) {
    selected.add(editing.month);
  } else if (isBilled(currentResident, initialMonth) && statusOf(currentResident, initialMonth).kind !== 'paid') {
    selected.add(initialMonth);
  } else {
    const fallback = defaultMonthFor(currentResident);
    if (isBilled(currentResident, fallback) && statusOf(currentResident, fallback).kind !== 'paid') selected.add(fallback);
  }

  const sortedResidents = state.residents.slice().sort(cmpResident);
  const options = sortedResidents.map((r) => `<option value="${r.id}" ${r.id === currentResident.id ? 'selected' : ''}>${esc((r.house ? r.house + ' · ' : '') + r.name)}${isArchived(r) ? ' (moved out)' : ''}</option>`).join('');
  const methods = PAY_METHODS.map((m) => `<option value="${m}" ${editing && editing.method === m ? 'selected' : ''}>${m}</option>`).join('');

  const body = `
    <form class="form" data-form="payment" novalidate>
      <input type="hidden" name="editId" value="${editing ? editing.id : ''}">
      <div class="field">
        <label for="pay-resident">Household</label>
        <select id="pay-resident" name="residentId" ${editing ? 'disabled' : ''}>${options}</select>
      </div>
      ${editing
        ? `<div class="field"><span class="field__label">Month covered</span><span class="pill" style="align-self:flex-start;padding:7px 12px">${esc(monthLabel(editing.month))}</span></div>`
        : `<div class="field">
            <label>Months covered <span class="hint" id="month-hint"></span></label>
            <div class="month-picks" id="month-picks" role="group" aria-label="Months covered"></div>
          </div>`}
      <div class="grid-2">
        <div class="field">
          <label for="pay-amount">Amount received</label>
          <input id="pay-amount" name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" required
            value="${editing ? esc(editing.amount) : ''}" placeholder="0.00">
          <p class="helper" id="amount-hint"></p>
        </div>
        <div class="field">
          <label for="pay-date">Date paid</label>
          <input id="pay-date" name="paidOn" type="date" value="${editing ? esc(editing.paidOn) : isoDate()}" max="${isoDate()}" required>
        </div>
      </div>
      <div class="grid-2">
        <div class="field">
          <label for="pay-method">Method</label>
          <select id="pay-method" name="method">${methods}</select>
        </div>
        <div class="field">
          <label for="pay-ref">Reference</label>
          <input id="pay-ref" name="ref" maxlength="40" value="${editing ? esc(editing.ref || '') : ''}" placeholder="e.g. M-Pesa code">
        </div>
      </div>
      <div class="field">
        <label for="pay-note">Note</label>
        <input id="pay-note" name="note" maxlength="120" value="${editing ? esc(editing.note || '') : ''}" placeholder="Optional">
      </div>
      <div class="breakdown" id="pay-breakdown"></div>
      <p class="form-error" data-error></p>
      <div class="modal-actions">
        <button type="button" class="btn btn--ghost" data-action="close-modal">Cancel</button>
        <button type="submit" class="btn btn--primary">${editing ? 'Save changes' : 'Save payment'}</button>
      </div>
    </form>`;

  openModal({
    title: editing ? 'Edit payment' : 'Record payment',
    body,
    onMount(root) {
      const form = root.querySelector('form');
      const select = form.querySelector('[name="residentId"]');
      const grid = form.querySelector('#month-picks');
      const amountInput = form.querySelector('#pay-amount');
      const amountHint = form.querySelector('#amount-hint');
      const monthHint = form.querySelector('#month-hint');
      const breakdown = form.querySelector('#pay-breakdown');
      let dirty = false;

      if (editing) {
        if (amountHint) amountHint.textContent = `Editing receipt ${editing.receiptNo || ''}`;
        return;
      }

      const resident = () => residentById(select.value) || currentResident;

      function billableMonths(r) {
        if (!r) return [];
        const cur = monthKeyOf();
        const end = r.billingEnd && r.billingEnd < cur ? r.billingEnd : addMonths(cur, 3);
        const start = r.billingStart || cur;
        let list = monthsRange(start, end);
        if (list.length > 120) list = list.slice(-120);
        return list;
      }

      function needFor(r, m) {
        return Math.max(0, r2(feeOf(r, m) - paidForExcluding(r.id, m, editing ? editing.id : null)));
      }

      function renderGrid() {
        const r = resident();
        if (!r || !grid) return;
        const months = billableMonths(r);
        grid.innerHTML = months.map((m) => {
          const need = needFor(r, m);
          const isPaid = need <= 0;
          const isOn = selected.has(m);
          return `<button type="button" class="mpick ${isPaid ? 'mpick--paid' : ''}" data-month="${m}" aria-pressed="${isOn}" ${isPaid ? 'disabled' : ''}>
            <span>${esc(monthLabel(m, true))}</span>
            <span class="mpick__amt">${isPaid ? 'Paid' : money(need)}</span>
          </button>`;
        }).join('') || '<p class="fine" style="padding:8px">No billable months for this household.</p>';
        if (monthHint) monthHint.textContent = months.length ? '' : '';
      }

      function renderBreakdown() {
        if (!breakdown) return;
        const months = [...selected].sort();
        const amount = Number(amountInput.value) || 0;
        if (!months.length || amount <= 0) { breakdown.innerHTML = ''; return; }
        const r = resident();
        const alloc = allocate(amount, months, r, editing ? editing.id : null);
        const total = r2(sum(alloc, (a) => a.amount));
        breakdown.innerHTML = alloc.map((a) => `<div><span>${esc(monthLabel(a.month))}</span><b>${money(a.amount)}</b></div>`).join('')
          + (alloc.length > 1 ? `<div style="border-top:1px solid var(--line);margin-top:4px;padding-top:5px"><span>Total applied</span><b>${money(total)}</b></div>` : '');
      }

      function recalc({ resetAmount = false } = {}) {
        const months = [...selected].sort();
        const r = resident();
        const expected = r2(sum(months, (m) => needFor(r, m)));
        if (monthHint) {
          monthHint.textContent = months.length
            ? `${months.length} month${months.length === 1 ? '' : 's'} selected`
            : 'pick at least one';
        }
        if (resetAmount || !dirty) {
          amountInput.value = expected ? String(expected) : '';
        }
        if (amountHint) {
          const entered = Number(amountInput.value) || 0;
          const short = months.length && entered > 0 && entered < expected - 0.005;
          amountHint.textContent = months.length
            ? `Expected ${money(expected)} for ${months.length} month${months.length === 1 ? '' : 's'}${short ? ' · ' + money(expected - entered) + ' short' : ''}`
            : 'Select the months being paid';
          amountHint.classList.toggle('helper--warn', short);
        }
        renderBreakdown();
      }

      if (grid) {
        renderGrid();
        grid.addEventListener('click', (event) => {
          const btn = event.target.closest('[data-month]');
          if (!btn || btn.disabled) return;
          const m = btn.getAttribute('data-month');
          if (selected.has(m)) selected.delete(m);
          else selected.add(m);
          btn.setAttribute('aria-pressed', selected.has(m) ? 'true' : 'false');
          recalc();
        });

        select.addEventListener('change', () => {
          const r = resident();
          currentResident = r;
          selected.clear();
          const fallback = month || defaultMonthFor(r);
          if (isBilled(r, fallback) && statusOf(r, fallback).kind !== 'paid') selected.add(fallback);
          else {
            const next = defaultMonthFor(r);
            if (isBilled(r, next) && statusOf(r, next).kind !== 'paid') selected.add(next);
          }
          dirty = false;
          renderGrid();
          recalc({ resetAmount: true });
        });
      }

      amountInput.addEventListener('input', () => {
        dirty = true;
        const months = [...selected].sort();
        const r = resident();
        const expected = r2(sum(months, (m) => needFor(r, m)));
        if (amountHint) {
          const entered = Number(amountInput.value) || 0;
          const short = months.length && entered > 0 && entered < expected - 0.005;
          amountHint.textContent = months.length
            ? `Expected ${money(expected)} for ${months.length} month${months.length === 1 ? '' : 's'}${short ? ' · ' + money(expected - entered) + ' short' : ''}`
            : 'Select the months being paid';
          amountHint.classList.toggle('helper--warn', short);
        }
        renderBreakdown();
      });

      recalc();
      form._selectedMonths = () => [...selected].sort();
    }
  });
}

/* ---------- resident modal ---------- */

function openResidentForm(id = null) {
  const resident = id ? residentById(id) : null;
  const cur = monthKeyOf();
  const body = `
    <form class="form" data-form="resident" novalidate>
      <input type="hidden" name="id" value="${resident ? resident.id : ''}">
      <div class="field">
        <label for="res-name">Full name</label>
        <input id="res-name" name="name" maxlength="80" required autofocus value="${resident ? esc(resident.name) : ''}" placeholder="e.g. Jane Doe">
      </div>
      <div class="grid-2">
        <div class="field">
          <label for="res-house">House / plot number</label>
          <input id="res-house" name="house" maxlength="20" value="${resident ? esc(resident.house || '') : ''}" placeholder="e.g. 12B">
        </div>
        <div class="field">
          <label for="res-phone">Phone</label>
          <input id="res-phone" name="phone" type="tel" maxlength="30" value="${resident ? esc(resident.phone || '') : ''}" placeholder="Optional">
        </div>
      </div>
      <div class="grid-2">
        <div class="field">
          <label for="res-fee">Monthly fee for this household</label>
          <input id="res-fee" name="fee" type="number" inputmode="decimal" min="0" step="0.01"
            value="${resident && resident.fee != null ? esc(resident.fee) : ''}" placeholder="Default: ${esc(state.settings.defaultFee)}">
          <span class="hint">Leave empty to use the default (${money(state.settings.defaultFee)})</span>
        </div>
        <div class="field">
          <label for="res-start">Billing starts</label>
          <input id="res-start" name="billingStart" type="month" value="${resident && resident.billingStart ? resident.billingStart : cur}" required>
          <span class="hint">The first month this household owes a fee</span>
        </div>
      </div>
      ${resident ? `<div class="field">
        <label for="res-fee-from">Fee change applies from</label>
        <input id="res-fee-from" name="feeFrom" type="month" value="${cur}">
        <span class="hint">Past months keep their previous fee. Set this to an older month only when correcting a wrong amount.</span>
      </div>` : ''}
      <div class="field">
        <label for="res-notes">Notes</label>
        <textarea id="res-notes" name="notes" maxlength="300" placeholder="Optional">${resident ? esc(resident.notes || '') : ''}</textarea>
      </div>
      <p class="form-error" data-error></p>
      <div class="modal-actions">
        <button type="button" class="btn btn--ghost" data-action="close-modal">Cancel</button>
        <button type="submit" class="btn btn--primary">${resident ? 'Save changes' : 'Add household'}</button>
      </div>
    </form>`;
  openModal({ title: resident ? 'Edit household' : 'Add household', body });
}

/* ---------- month detail ---------- */

function openMonthModal(residentId, month) {
  const r = residentById(residentId);
  if (!r) return;
  const st = statusOf(r, month);
  const payments = sortPayments(state.payments.filter((p) => p.residentId === r.id && p.month === month));
  const balance = Math.max(0, st.due - st.paid);

  const body = `
    <div class="kv"><span>Status</span><strong>${pill(st.kind)}</strong></div>
    <div class="kv"><span>Expected</span><strong>${money(st.due)}</strong></div>
    <div class="kv"><span>Received</span><strong>${money(st.paid)}</strong></div>
    <div class="kv"><span>Balance</span><strong>${money(balance)}</strong></div>
    <div class="rows" style="margin-top:14px">
      ${payments.map((p) => `<button class="row" data-action="open-receipt" data-ids="${p.id}">
        <div class="row__main">
          <div class="row__title">${money(p.amount)} · ${esc(p.method || 'Cash')}</div>
          <div class="row__meta">Paid ${fmtDate(p.paidOn)} · ${esc(p.receiptNo || '')}</div>
        </div>
        <div class="row__end"><span class="row__cta">Receipt</span></div>
      </button>`).join('')}
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn--ghost" data-action="close-modal">Close</button>
      <button type="button" class="btn btn--primary" data-action="quick-pay" data-resident="${r.id}" data-month="${month}">${icon('plus', 15)} Add payment</button>
    </div>`;
  openModal({ title: monthLabel(month), body });
}

/* ---------- receipts ---------- */

function receiptHTML(payment) {
  const r = residentById(payment.residentId);
  const st = r ? statusOf(r, payment.month) : { due: 0, paid: 0 };
  const balance = Math.max(0, st.due - st.paid);
  const credit = Math.max(0, st.paid - st.due);
  const community = state.settings.communityName || 'Security dues';

  return `<article class="receipt">
    <div class="receipt__head">
      <div class="receipt__brand">
        <span class="receipt__mark">${shieldMark(19)}</span>
        <div><strong>${esc(community)}</strong><span>Security dues</span></div>
      </div>
      <div class="receipt__meta">
        <em>Receipt</em>
        <b>${esc(payment.receiptNo || '—')}</b>
        <span>${fmtDate(payment.paidOn)}</span>
      </div>
    </div>
    <div class="receipt__body">
      <div class="kv"><span>Received from</span><strong>${esc(r ? r.name : '—')}</strong></div>
      ${r && r.house ? `<div class="kv"><span>House / plot</span><strong>${esc(r.house)}</strong></div>` : ''}
      <div class="kv"><span>Covering</span><strong>${esc(monthLabel(payment.month))}</strong></div>
      <div class="kv"><span>Method</span><strong>${esc(payment.method || 'Cash')}${payment.ref ? ' · ' + esc(payment.ref) : ''}</strong></div>
      ${payment.note ? `<div class="kv"><span>Note</span><strong>${esc(payment.note)}</strong></div>` : ''}
      <div class="kv kv--total"><span>Amount received</span><strong>${money(payment.amount)}</strong></div>
      <div class="kv"><span>${credit > 0 ? 'Credit on this month' : 'Balance for this month'}</span><strong>${money(credit > 0 ? credit : balance)}</strong></div>
    </div>
    <div class="receipt__foot">
      <span>${esc(community)} · Monthly security fee</span>
      <b>${balance <= 0 ? 'Paid in full' : 'Part payment'}</b>
    </div>
  </article>`;
}

function openReceipts(ids, { justSaved = false } = {}) {
  const payments = ids.map((id) => state.payments.find((p) => p.id === id)).filter(Boolean);
  if (!payments.length) return;

  const body = `
    ${justSaved ? `<div class="success">
      <span class="success__icon">${icon('check', 18)}</span>
      <div><strong>Payment recorded</strong><span>${payments.length > 1 ? payments.length + ' receipts are ready' : 'The receipt is ready to print or share'}</span></div>
    </div>` : ''}
    <div class="receipt-stack">${payments.map(receiptHTML).join('')}</div>
    ${payments.length === 1 ? `<div class="receipt-actions" style="justify-content:flex-end">
      <button type="button" data-action="edit-payment" data-id="${payments[0].id}">Edit</button>
      <button type="button" class="del" data-action="delete-payment" data-id="${payments[0].id}">Delete</button>
    </div>` : ''}
    <div class="modal-actions">
      <button type="button" class="btn btn--ghost" data-action="close-modal">Done</button>
      <button type="button" class="btn btn--soft" data-action="share-receipts" data-ids="${payments.map((p) => p.id).join(',')}">${icon('share', 16)} Share</button>
      <button type="button" class="btn btn--primary" data-action="print-receipts" data-ids="${payments.map((p) => p.id).join(',')}">${icon('printer', 16)} Print</button>
    </div>`;
  openModal({ title: payments.length > 1 ? payments.length + ' receipts' : 'Receipt', body, size: 'wide' });
}

function printReceipts(ids) {
  const payments = ids.map((id) => state.payments.find((p) => p.id === id)).filter(Boolean);
  if (!payments.length) return;
  const community = esc(state.settings.communityName || 'Security dues');
  $('#print-root').innerHTML = `<div class="print-sheet">
    <div class="print-head"><strong>${community}</strong><span>Security dues receipts</span></div>
    ${payments.map(receiptHTML).join('')}
  </div>`;
  window.print();
}

async function shareReceipts(ids) {
  const payments = ids.map((id) => state.payments.find((p) => p.id === id)).filter(Boolean);
  if (!payments.length) return;
  const community = state.settings.communityName || 'Security dues';
  const text = payments.map((p) => {
    const r = residentById(p.residentId);
    return `Security dues receipt ${p.receiptNo || ''}\n${r ? r.name : 'Household'}${r && r.house ? ' (House ' + r.house + ')' : ''}\nFor ${monthLabel(p.month)}\nAmount: ${money(p.amount)}\nPaid: ${fmtDate(p.paidOn)}`;
  }).join('\n\n') + `\n\n${community}`;

  if (navigator.share) {
    try {
      await navigator.share({ title: 'Security dues receipt', text });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('Receipt copied to clipboard', 'success');
  } catch (err) {
    toast('Sharing is not available on this device', 'error');
  }
}

/* ---------- statement ---------- */

function printStatement(residentId) {
  const r = residentById(residentId);
  if (!r) return;
  const cur = monthKeyOf();
  const end = r.billingEnd && r.billingEnd < cur ? r.billingEnd : cur;
  const start = r.billingStart || cur;
  const months = monthsRange(start, end);
  let totalDue = 0;
  let totalPaid = 0;

  const rows = months.map((m) => {
    const s = statusOf(r, m);
    totalDue += s.due;
    totalPaid += s.paid;
    const balance = Math.max(0, s.due - s.paid);
    return `<tr>
      <td style="padding:7px 9px;border-bottom:1px solid #ddd">${esc(monthLabel(m))}</td>
      <td style="padding:7px 9px;border-bottom:1px solid #ddd;text-align:right">${money(s.due)}</td>
      <td style="padding:7px 9px;border-bottom:1px solid #ddd;text-align:right">${money(s.paid)}</td>
      <td style="padding:7px 9px;border-bottom:1px solid #ddd;text-align:right;color:${balance > 0 ? '#b14435' : 'inherit'}">${money(balance)}</td>
    </tr>`;
  }).join('');

  $('#print-root').innerHTML = `<div class="print-sheet">
    <div class="print-head"><strong>${esc(state.settings.communityName || 'Security dues')}</strong><span>Statement of account</span></div>
    <div style="margin-bottom:16px">
      <div style="font-size:16px;font-weight:650">${esc(r.name)}</div>
      <div style="font-size:12px;color:#555">${r.house ? 'House ' + esc(r.house) : ''}${r.phone ? ' · ' + esc(r.phone) : ''} · current fee ${money(feeOf(r))} per month</div>
      <div style="font-size:11px;color:#777;margin-top:2px">Period: ${esc(monthLabel(start))} — ${esc(monthLabel(end))} · Printed ${fmtDate(isoDate())}</div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr>
        <th style="text-align:left;padding:7px 9px;border-bottom:2px solid #0e3a2b">Month</th>
        <th style="text-align:right;padding:7px 9px;border-bottom:2px solid #0e3a2b">Due</th>
        <th style="text-align:right;padding:7px 9px;border-bottom:2px solid #0e3a2b">Paid</th>
        <th style="text-align:right;padding:7px 9px;border-bottom:2px solid #0e3a2b">Balance</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr>
        <td style="padding:9px;border-top:2px solid #0e3a2b;font-weight:650">Total</td>
        <td style="padding:9px;border-top:2px solid #0e3a2b;text-align:right;font-weight:650">${money(totalDue)}</td>
        <td style="padding:9px;border-top:2px solid #0e3a2b;text-align:right;font-weight:650">${money(totalPaid)}</td>
        <td style="padding:9px;border-top:2px solid #0e3a2b;text-align:right;font-weight:650;color:${totalDue - totalPaid > 0 ? '#b14435' : 'inherit'}">${money(Math.max(0, totalDue - totalPaid))}</td>
      </tr></tfoot>
    </table>
    <p style="margin-top:18px;font-size:10px;color:#777">Outstanding balance: ${money(Math.max(0, totalDue - totalPaid))} · Statement generated from the Security Dues ledger.</p>
  </div>`;
  window.print();
}

/* ==========================================================================
   Export, import & install
   ========================================================================== */

function downloadFile(filename, content, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function csvFile(rows) {
  return '\ufeff' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

function exportBackup() {
  const payload = {
    app: 'security-dues',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: state.settings,
    residents: state.residents,
    payments: state.payments
  };
  downloadFile(`security-dues-backup-${isoDate()}.json`, JSON.stringify(payload, null, 2), 'application/json');
  state.settings.lastBackupAt = isoDate();
  save();
  render();
  toast('Backup downloaded', 'success');
}

function exportPaymentsCSV() {
  const rows = [['Receipt', 'Household', 'House', 'Month covered', 'Amount', 'Date paid', 'Method', 'Reference', 'Note']];
  for (const p of sortPayments(state.payments)) {
    const r = residentById(p.residentId);
    rows.push([
      p.receiptNo || '',
      r ? r.name : 'Removed household',
      r ? r.house || '' : '',
      monthLabel(p.month),
      p.amount,
      p.paidOn,
      p.method || '',
      p.ref || '',
      p.note || ''
    ]);
  }
  downloadFile(`security-dues-payments-${isoDate()}.csv`, csvFile(rows), 'text/csv;charset=utf-8');
  toast('Payments CSV downloaded', 'success');
}

function exportHouseholdsCSV() {
  const rows = [['Name', 'House', 'Phone', 'Current monthly fee', 'Billing start', 'Billing end', 'Status', 'Total paid', 'Outstanding']];
  for (const r of state.residents.slice().sort(cmpResident)) {
    rows.push([
      r.name,
      r.house || '',
      r.phone || '',
      feeOf(r),
      r.billingStart || '',
      r.billingEnd || '',
      isArchived(r) ? 'Moved out' : 'Active',
      totalPaid(r),
      arrearsOf(r)
    ]);
  }
  downloadFile(`security-dues-households-${isoDate()}.csv`, csvFile(rows), 'text/csv;charset=utf-8');
  toast('Households CSV downloaded', 'success');
}

function importBackup() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
      if (!data || !Array.isArray(data.residents) || !Array.isArray(data.payments)) throw new Error('Invalid backup shape');
    } catch (err) {
      toast('That file is not a valid backup', 'error');
      return;
    }

    const ok = await askConfirm({
      title: 'Restore this backup?',
      message: `It contains <strong>${data.residents.length} household${data.residents.length === 1 ? '' : 's'}</strong> and <strong>${data.payments.length} payment${data.payments.length === 1 ? '' : 's'}</strong>. Everything currently on this device will be replaced.`,
      confirmText: 'Restore backup'
    });
    if (!ok) return;

    const base = defaultState();
    state = {
      ...base,
      ...data,
      settings: { ...base.settings, ...(data.settings || {}), setupComplete: true },
      residents: data.residents,
      payments: data.payments
    };
    rebuildIndexes();
    save();
    ui.month = monthKeyOf();
    ui.reportYear = new Date().getFullYear();
    parseHash();
    render();
    toast('Backup restored', 'success');
  });
  input.click();
}

async function deleteAllRecords() {
  const ok = await askConfirm({
    title: 'Delete all records?',
    message: `This removes <strong>${state.residents.length} household${state.residents.length === 1 ? '' : 's'}</strong> and <strong>${state.payments.length} payment record${state.payments.length === 1 ? '' : 's'}</strong>. Community settings stay. This cannot be undone.`,
    confirmText: 'Delete everything'
  });
  if (!ok) return;
  state.residents = [];
  state.payments = [];
  state.settings.receiptSeq = 1;
  state.settings.lastBackupAt = null;
  commit();
  toast('All records deleted');
}

async function resetApp() {
  const ok = await askConfirm({
    title: 'Reset the app?',
    message: 'Every household, payment and setting will be erased and you will return to setup. This cannot be undone.',
    confirmText: 'Reset everything'
  });
  if (!ok) return;
  try { localStorage.removeItem(STORE_KEY); } catch (err) { /* ignore */ }
  state = defaultState();
  ui = {
    view: 'dashboard',
    month: monthKeyOf(),
    residentId: null,
    search: '',
    filter: 'all',
    payMonth: 'all',
    paySearch: '',
    reportYear: new Date().getFullYear()
  };
  history.replaceState(null, '', location.pathname + location.search);
  lastHash = '';
  rebuildIndexes();
  save();
  render();
  toast('App reset');
}

async function installApp() {
  if (!deferredInstallPrompt) {
    toast('Use your browser menu → Add to Home screen');
    return;
  }
  deferredInstallPrompt.prompt();
  try { await deferredInstallPrompt.userChoice; } catch (err) { /* ignore */ }
  deferredInstallPrompt = null;
  render();
}

/* ==========================================================================
   Events
   ========================================================================== */

function setFormError(form, message) {
  const el = form.querySelector('[data-error]');
  if (el) el.textContent = message || '';
}

async function archiveResident(id) {
  const r = residentById(id);
  if (!r) return;
  const lastMonth = monthKeyOf() < (r.billingStart || '') ? r.billingStart : monthKeyOf();
  const ok = await askConfirm({
    title: 'Archive household?',
    message: `<strong>${esc(r.name)}</strong> will be billed up to <strong>${esc(monthLabel(lastMonth))}</strong> and stop appearing in monthly totals. Their payment history stays.`,
    confirmText: 'Archive household',
    danger: false
  });
  if (!ok) return;
  r.billingEnd = lastMonth;
  commit();
  toast('Household archived');
}

function unarchiveResident(id) {
  const r = residentById(id);
  if (!r) return;
  delete r.billingEnd;
  commit();
  toast('Household restored');
}

async function deleteResident(id) {
  const r = residentById(id);
  if (!r) return;
  const count = state.payments.filter((p) => p.residentId === id).length;
  const ok = await askConfirm({
    title: 'Delete household?',
    message: `<strong>${esc(r.name)}</strong> and <strong>${count} payment record${count === 1 ? '' : 's'}</strong> will be permanently deleted. To keep the history, archive them instead.`,
    confirmText: 'Delete household'
  });
  if (!ok) return;
  state.residents = state.residents.filter((x) => x.id !== id);
  state.payments = state.payments.filter((p) => p.residentId !== id);
  commit(false);
  if (ui.view === 'resident' && ui.residentId === id) {
    location.hash = '#/residents';
  } else {
    render();
  }
  toast('Household deleted');
}

async function deletePayment(id) {
  const p = state.payments.find((x) => x.id === id);
  if (!p) return;
  const ok = await askConfirm({
    title: 'Delete payment?',
    message: `Receipt <strong>${esc(p.receiptNo || '')}</strong> for <strong>${money(p.amount)}</strong> will be permanently removed.`,
    confirmText: 'Delete payment'
  });
  if (!ok) return;
  state.payments = state.payments.filter((x) => x.id !== id);
  closeModal();
  commit();
  toast('Payment deleted');
}

document.addEventListener('click', async (event) => {
  const confirmBtn = event.target.closest('[data-confirm]');
  if (confirmBtn) {
    event.preventDefault();
    const resolve = pendingConfirm;
    pendingConfirm = null;
    const yes = confirmBtn.getAttribute('data-confirm') === '1';
    closeModal();
    if (resolve) resolve(yes);
    return;
  }

  const el = event.target.closest('[data-action]');
  if (!el) return;
  const action = el.getAttribute('data-action');
  if (el.tagName === 'A' || el.tagName === 'BUTTON') event.preventDefault();

  switch (action) {
    case 'month-prev':
      ui.month = addMonths(ui.month, -1);
      render();
      break;
    case 'month-next':
      ui.month = addMonths(ui.month, 1);
      render();
      break;
    case 'month-today':
      ui.month = monthKeyOf();
      render();
      break;
    case 'year-prev':
      ui.reportYear -= 1;
      render();
      break;
    case 'year-next':
      ui.reportYear += 1;
      render();
      break;
    case 'open-payment':
      openPaymentModal({
        residentId: el.getAttribute('data-resident') || null,
        month: el.getAttribute('data-month') || null
      });
      break;
    case 'quick-pay':
      openPaymentModal({
        residentId: el.getAttribute('data-resident'),
        month: el.getAttribute('data-month') || null
      });
      break;
    case 'month-detail':
      openMonthModal(el.getAttribute('data-resident'), el.getAttribute('data-month'));
      break;
    case 'open-receipt':
      openReceipts(String(el.getAttribute('data-ids') || '').split(',').filter(Boolean));
      break;
    case 'edit-payment':
      closeModal();
      openPaymentModal({ editId: el.getAttribute('data-id') });
      break;
    case 'delete-payment':
      await deletePayment(el.getAttribute('data-id'));
      break;
    case 'print-receipts':
      printReceipts(String(el.getAttribute('data-ids') || '').split(',').filter(Boolean));
      break;
    case 'share-receipts':
      shareReceipts(String(el.getAttribute('data-ids') || '').split(',').filter(Boolean));
      break;
    case 'add-resident':
      openResidentForm(null);
      break;
    case 'edit-resident':
      openResidentForm(el.getAttribute('data-resident'));
      break;
    case 'archive-resident':
      await archiveResident(el.getAttribute('data-resident'));
      break;
    case 'unarchive-resident':
      unarchiveResident(el.getAttribute('data-resident'));
      break;
    case 'delete-resident':
      await deleteResident(el.getAttribute('data-resident'));
      break;
    case 'statement':
      printStatement(el.getAttribute('data-resident'));
      break;
    case 'set-filter':
      ui.filter = el.getAttribute('data-filter') || 'all';
      render();
      break;
    case 'set-theme':
      state.settings.theme = el.getAttribute('data-theme') || 'system';
      save();
      applyTheme();
      $$('.segmented button[data-action="set-theme"]').forEach((btn) => {
        btn.setAttribute('aria-pressed', String(btn.getAttribute('data-theme') === state.settings.theme));
      });
      break;
    case 'export-backup':
      exportBackup();
      break;
    case 'export-payments-csv':
      exportPaymentsCSV();
      break;
    case 'export-households-csv':
      exportHouseholdsCSV();
      break;
    case 'import-backup':
      importBackup();
      break;
    case 'delete-records':
      await deleteAllRecords();
      break;
    case 'reset-app':
      await resetApp();
      break;
    case 'install-app':
      installApp();
      break;
    case 'sync-retry':
      serverSyncRetry = 0;
      serverSyncState = 'pending';
      updateSyncStatus();
      toast('Checking Firestore…');
      if (await pushStateToServer()) toast('Saved to Firestore', 'success');
      break;
    case 'close-modal':
      closeModal();
      break;
    default:
      break;
  }
});

document.addEventListener('change', (event) => {
  const target = event.target;

  if (target.classList && target.classList.contains('js-month')) {
    const value = target.value;
    if (/^\d{4}-\d{2}$/.test(value)) {
      ui.month = value;
      render();
    }
    return;
  }

  if (target.id === 'pay-month-filter') {
    ui.payMonth = target.value;
    const results = $('#payments-results');
    if (results) results.innerHTML = paymentsListHTML();
  }
});

document.addEventListener('input', (event) => {
  const target = event.target;

  if (target.id === 'resident-search') {
    ui.search = target.value;
    const results = $('#resident-results');
    if (results) results.innerHTML = residentListHTML();
    return;
  }

  if (target.id === 'payment-search') {
    ui.paySearch = target.value;
    const results = $('#payments-results');
    if (results) results.innerHTML = paymentsListHTML();
  }
});

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  setFormError(form, '');

  const kind = form.getAttribute('data-form');
  const data = new FormData(form);

  if (kind === 'setup') {
    const name = String(data.get('communityName') || '').trim();
    const currencyValue = String(data.get('currency') || '').trim();
    const fee = Number(data.get('defaultFee'));

    if (!name) { setFormError(form, 'Give your community a name.'); return; }
    if (!currencyValue) { setFormError(form, 'Add a currency symbol or code.'); return; }
    if (!Number.isFinite(fee) || fee < 0) { setFormError(form, 'Enter a valid monthly fee.'); return; }

    state.settings.communityName = name;
    state.settings.currency = currencyValue;
    state.settings.defaultFee = r2(fee);
    state.settings.setupComplete = true;
    commit();
    toast('Your ledger is ready', 'success');
    return;
  }

  if (kind === 'settings') {
    const name = String(data.get('communityName') || '').trim();
    const currencyValue = String(data.get('currency') || '').trim();
    const fee = Number(data.get('defaultFee'));
    const dueDay = Number(data.get('dueDay'));
    const feeFromRaw = String(data.get('feeFrom') || '');
    const feeFrom = /^\d{4}-\d{2}$/.test(feeFromRaw) ? feeFromRaw : monthKeyOf();

    if (!name) { setFormError(form, 'Community name is required.'); return; }
    if (!currencyValue) { setFormError(form, 'Currency is required.'); return; }
    if (!Number.isFinite(fee) || fee < 0) { setFormError(form, 'Enter a valid default fee.'); return; }

    const nextFee = r2(fee);
    const prevFee = Number(state.settings.defaultFee) || 0;
    if (nextFee !== prevFee) {
      if (!Array.isArray(state.settings.feeHistory) || !state.settings.feeHistory.length) {
        state.settings.feeHistory = [{ from: '2000-01', amount: prevFee }];
      }
      state.settings.feeHistory = upsertRate(state.settings.feeHistory, feeFrom, nextFee);
    }
    state.settings.communityName = name;
    state.settings.currency = currencyValue;
    state.settings.defaultFee = nextFee;
    state.settings.dueDay = clamp(Number.isFinite(dueDay) ? dueDay : 5, 1, 28);
    save();
    render();
    toast('Settings saved', 'success');
    return;
  }

  if (kind === 'resident') {
    const id = String(data.get('id') || '');
    const name = String(data.get('name') || '').trim();
    const house = String(data.get('house') || '').trim();
    const phone = String(data.get('phone') || '').trim();
    const notes = String(data.get('notes') || '').trim();
    const billingStart = String(data.get('billingStart') || '') || monthKeyOf();
    const feeRaw = String(data.get('fee') || '').trim();
    const feeValue = feeRaw === '' ? null : Number(feeRaw);
    const feeFromRaw = String(data.get('feeFrom') || '');
    const feeFrom = /^\d{4}-\d{2}$/.test(feeFromRaw) ? feeFromRaw : monthKeyOf();

    if (!name) { setFormError(form, 'A name is required.'); return; }
    if (feeValue != null && (!Number.isFinite(feeValue) || feeValue < 0)) {
      setFormError(form, 'Enter a valid monthly fee, or leave it empty.');
      return;
    }
    if (!/^\d{4}-\d{2}$/.test(billingStart)) { setFormError(form, 'Choose a valid billing start month.'); return; }

    if (id) {
      const r = residentById(id);
      if (!r) return;
      const oldHasFee = r.fee != null;
      const newHasFee = feeValue != null;
      const feeChanged = oldHasFee !== newHasFee || (newHasFee && Number(r.fee) !== Number(feeValue));
      if (feeChanged) {
        const effectiveFrom = feeFrom < billingStart ? billingStart : feeFrom;
        if (!Array.isArray(r.feeHistory) || !r.feeHistory.length) {
          r.feeHistory = [{ from: billingStart, amount: feeOf(r, billingStart) }];
        }
        r.feeHistory = upsertRate(r.feeHistory, effectiveFrom, feeValue);
      }
      r.name = name;
      r.house = house;
      r.phone = phone;
      r.notes = notes;
      r.fee = feeValue;
      r.billingStart = billingStart;
      commit(false);
      closeModal();
      render();
      toast('Household updated', 'success');
    } else {
      const r = {
        id: uid(),
        name,
        house,
        phone,
        notes,
        fee: feeValue,
        billingStart,
        billingEnd: null,
        createdAt: new Date().toISOString()
      };
      state.residents.push(r);
      commit(false);
      closeModal();
      location.hash = '#/residents/' + r.id;
      toast('Household added', 'success');
    }
    return;
  }

  if (kind === 'payment') {
    const editId = String(data.get('editId') || '');
    const amount = r2(Number(data.get('amount')));
    const paidOn = String(data.get('paidOn') || '') || isoDate();
    const method = String(data.get('method') || 'Cash');
    const ref = String(data.get('ref') || '').trim();
    const note = String(data.get('note') || '').trim();

    if (!Number.isFinite(amount) || amount <= 0) { setFormError(form, 'Enter an amount greater than zero.'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) { setFormError(form, 'Choose the date the payment was made.'); return; }

    if (editId) {
      const payment = state.payments.find((p) => p.id === editId);
      if (!payment) return;
      payment.amount = amount;
      payment.paidOn = paidOn;
      payment.method = method;
      payment.ref = ref;
      payment.note = note;
      commit(false);
      closeModal();
      render();
      toast('Payment updated', 'success');
      openReceipts([payment.id]);
      return;
    }

    const residentId = String(data.get('residentId') || '');
    const resident = residentById(residentId);
    const months = typeof form._selectedMonths === 'function' ? form._selectedMonths() : [];

    if (!resident) { setFormError(form, 'Choose a household.'); return; }
    if (!months.length) { setFormError(form, 'Select at least one month being paid.'); return; }
    if (months.some((m) => !isBilled(resident, m))) { setFormError(form, 'One of those months is outside this household\'s billing period.'); return; }

    const allocation = allocate(amount, months, resident);
    const groupId = uid();
    const createdIds = [];

    for (const part of allocation) {
      if (part.amount <= 0) continue;
      const created = addPayment({
        residentId,
        month: part.month,
        amount: part.amount,
        paidOn,
        method,
        ref,
        note,
        groupId
      });
      createdIds.push(created.id);
    }

    if (!createdIds.length) { setFormError(form, 'Nothing to record — check the amount.'); return; }

    commit(false);
    closeModal();
    render();
    toast(createdIds.length > 1 ? `${createdIds.length} payments recorded` : 'Payment recorded', 'success');
    openReceipts(createdIds, { justSaved: true });
  }
});

/* ==========================================================================
   Boot
   ========================================================================== */

let lastHash = '';

function handleRoute() {
  parseHash();
  render();
  if (location.hash !== lastHash) {
    window.scrollTo(0, 0);
    lastHash = location.hash;
  }
}

window.addEventListener('hashchange', handleRoute);

window.addEventListener('pagehide', flushPendingSave);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushPendingSave();
});
window.addEventListener('online', () => {
  if (serverSyncState === 'offline' || serverSyncState === 'pending') {
    serverSyncRetry = 0;
    pushStateToServer();
  }
});

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  if (ui.view === 'settings') render();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  toast('App installed', 'success');
});

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker failed', err));
  });
}

function boot() {
  parseHash();
  rebuildIndexes();
  applyTheme();
  render();
  lastHash = location.hash;
  registerServiceWorker();
  syncWithServer();

  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => applyTheme();
  if (media.addEventListener) media.addEventListener('change', onChange);
  else if (media.addListener) media.addListener(onChange);
}

boot();

