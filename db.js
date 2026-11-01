/*
 * sotto voce — db.js
 *
 * IndexedDB is the SOURCE OF TRUTH. localStorage is never used for entries
 * (§2 — synchronous, size-capped, one bad blob loses the notebook).
 *
 * ⛔ §1a THE ID RULE — NON-NEGOTIABLE
 * An id is a UUID generated at creation and never recomputed. It is never
 * derived from position, list index, or array offset. Ember shipped v1.0→v1.3.2
 * with positional ids (++n); inserting one record renumbered every id after it,
 * so stored state keyed by old ids silently pointed at different records.
 * Nothing threw. check.sh fails the build on any id matching /-[0-9]{3}$/.
 */

const DB_NAME = 'sotto-voce';
const DB_VERSION = 1;
const STORE_ENTRIES = 'entries';
const STORE_SETTINGS = 'settings';

let _db = null;

export function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_ENTRIES)) {
        const s = db.createObjectStore(STORE_ENTRIES, { keyPath: 'id' });
        s.createIndex('created_at', 'created_at');
        s.createIndex('state', 'state');
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => { _db = req.result; res(_db); };
    req.onerror = () => rej(req.error);
  });
}

function tx(store, mode) {
  return open().then(db => db.transaction(store, mode).objectStore(store));
}
const wrap = req => new Promise((res, rej) => {
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});

/* ---------------------------------------------------------------- entries */

/** New entry with an IMMUTABLE uuid. Never positional, never recomputed. */
export function newEntry() {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    body: '',
    created_at: now,
    updated_at: now,
    state: 'draft',
    sent_at: null,
    rev: 1,
    drive_file_id: null,
    deleted: false,
    enc: false,
    iv: null,
  };
}

export async function putEntry(e) {
  e.updated_at = new Date().toISOString();
  const s = await tx(STORE_ENTRIES, 'readwrite');
  await wrap(s.put(e));
  return e;
}

export async function getEntry(id) {
  const s = await tx(STORE_ENTRIES, 'readonly');
  return wrap(s.get(id));
}

/** All non-deleted entries, newest first. Chronological only — a journal has no feed. */
export async function listEntries() {
  const s = await tx(STORE_ENTRIES, 'readonly');
  const all = await wrap(s.getAll());
  return all
    .filter(e => !e.deleted)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export async function allRaw() {
  const s = await tx(STORE_ENTRIES, 'readonly');
  return wrap(s.getAll());
}

/** Tombstone, never a hard delete — a delete must not resurrect on the next pull (§6). */
export async function tombstone(id) {
  const e = await getEntry(id);
  if (!e) return null;
  e.deleted = true;
  e.rev += 1;
  return putEntry(e);
}

export async function entriesNeedingSync() {
  const all = await allRaw();
  return all.filter(e => !e.synced_at || e.updated_at > e.synced_at);
}

export async function markSynced(id, driveFileId) {
  const e = await getEntry(id);
  if (!e) return null;
  e.synced_at = new Date().toISOString();
  if (driveFileId) e.drive_file_id = driveFileId;
  const s = await tx(STORE_ENTRIES, 'readwrite');
  await wrap(s.put(e));
  return e;
}

/* --------------------------------------------------------------- settings */

export async function getSetting(key, dflt = null) {
  const s = await tx(STORE_SETTINGS, 'readonly');
  const row = await wrap(s.get(key));
  return row ? row.value : dflt;
}

export async function setSetting(key, value) {
  const s = await tx(STORE_SETTINGS, 'readwrite');
  await wrap(s.put({ key, value }));
  return value;
}

/* ------------------------------------------------------------- durability */

/**
 * ⛔ §2a THE PHONE IS NEVER THE ONLY COPY. Android Auto Backup does NOT back up
 * a PWA — its bytes are Chrome "site data", the material "Delete browsing data"
 * wipes. So: persist() is requested, its RESULT is surfaced in Settings, and
 * export/import is a first-class button. Drive sync is the real backup.
 */
export async function requestPersistence() {
  if (!navigator.storage || !navigator.storage.persist) return 'unsupported';
  try {
    const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    if (already) return 'granted';
    const ok = await navigator.storage.persist();
    return ok ? 'granted' : 'denied';
  } catch {
    return 'error';
  }
}

/* --------------------------------------------------------- export/import */

export async function exportJSON() {
  const rows = await allRaw();
  return JSON.stringify({
    format: 'sotto-voce/1',
    exported_at: new Date().toISOString(),
    count: rows.length,
    entries: rows,
  }, null, 2);
}

export async function exportMarkdown() {
  const rows = (await allRaw())
    .filter(e => !e.deleted)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const out = ['# sotto voce — archive', '', `Exported ${new Date().toISOString()}`, ''];
  for (const e of rows) {
    const mark = e.state === 'sent' ? '●' : '○';
    out.push(`## ${mark} ${e.created_at}${e.sent_at ? ` · sent ${e.sent_at}` : ''}`);
    out.push('');
    out.push(e.body || '_(empty)_');
    out.push('');
  }
  return out.join('\n');
}

/**
 * ⭐ §6 MERGE RULE FOR ONE ENTRY — the single source of truth.
 *
 * Before 2026-11-01 this logic lived only inside importJSON, so a RESTORE got the
 * §6 treatment and a SYNC did not. pull() skipped any id it already had, which is
 * why a newer Drive copy never came down. Both now call this.
 *
 *    no local copy        → add it
 *    remote.rev higher    → take remote; if the bodies differ, keep the local text
 *                           as a NEW entry first, so nothing is discarded
 *    remote.rev equal/lower → keep local (it wins, nothing lost)
 */
export async function mergeEntry(incoming) {
  if (!incoming || typeof incoming.id !== 'string') return 'skip';
  const local = await getEntry(incoming.id);
  if (!local) { await putEntry({ ...incoming }); return 'added'; }
  if (incoming.rev > local.rev) {
    if (local.body && incoming.body && local.body !== incoming.body) {
      const rec = newEntry();
      rec.body = local.body;
      rec.created_at = local.created_at;
      await putEntry(rec);
      await putEntry({ ...incoming });
      return 'recovered';
    }
    await putEntry({ ...incoming });
    return 'merged';
  }
  /* ⭐ EQUAL REV, DIFFERENT TEXT — a real conflict the rev rule does not order:
     both devices incremented from the same base independently. Neither is
     "higher", so local stays — but §6's promise is that no text is discarded,
     not merely that the highest rev wins. Keep the incoming text as a copy.
     ⚠️ DEDUPE BY BODY, or every subsequent sync would add another copy of it
     (the local rev never moves, so the pair stays "equal but different" forever). */
  if (incoming.rev === local.rev && local.body && incoming.body && local.body !== incoming.body) {
    const all = await allRaw();
    if (all.some(e => e.body === incoming.body)) return 'kept-local';
    const rec = newEntry();
    rec.body = incoming.body;
    rec.created_at = incoming.created_at || local.created_at;
    await putEntry(rec);
    return 'recovered';
  }
  return 'kept-local';
}

/**
 * Import is full-fidelity: ids and state are preserved, so an import into a
 * cleared profile restores exactly what was exported. Delegates to mergeEntry so
 * the §6 rule cannot drift between restore and sync.
 */
export async function importJSON(text) {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.entries)) throw new Error('Not a sotto voce export.');
  let added = 0, merged = 0, recovered = 0;
  for (const incoming of data.entries) {
    const r = await mergeEntry(incoming);
    if (r === 'added') added++;
    else if (r === 'merged') merged++;
    else if (r === 'recovered') { merged++; recovered++; }
  }
  return { added, merged, recovered };
}
