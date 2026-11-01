/*
 * sotto voce — sync.js
 *
 * Direction (§6, amended 2026-11-01): PULL AND MERGE FIRST, then push. The spec
 * originally said push-then-pull, but that order can downgrade a newer Drive copy:
 * a device holding an unsynced rev 2 would overwrite a remote rev 3 before ever
 * reading it. Merging first means the highest rev always survives, and §6's
 * "never silently discard text" actually holds.
 *
 * ⛔ iOS has NO Background Sync / Periodic Sync. Never design on it. Triggers are
 * explicit: launch, send, visibilitychange→hidden, and every 5 min foreground.
 */

import {
  allRaw, getEntry, putEntry, markSynced, entriesNeedingSync, getSetting, setSetting,
  mergeEntry,
} from './db.js';
import { ensureTree, writeFile, listFiles, readFile } from './drive.js';

let _tree = null;
let _busy = false;

export async function tree() {
  if (_tree) return _tree;
  const cached = await getSetting('drive_tree', null);
  if (cached && cached.notes && cached.outbox) { _tree = cached; return _tree; }
  const t = await ensureTree();
  await setSetting('drive_tree', t);
  _tree = t;
  return _tree;
}

function entryJSON(e) {
  return JSON.stringify({
    id: e.id, body: e.body, created_at: e.created_at, updated_at: e.updated_at,
    state: e.state, sent_at: e.sent_at, rev: e.rev, deleted: !!e.deleted,
    enc: false, iv: null,
  }, null, 2);
}

/** Push: every local entry newer than its last sync → notes/<id>.json */
export async function push() {
  const t = await tree();
  const pending = await entriesNeedingSync();
  let n = 0;
  for (const e of pending) {
    const res = await writeFile({
      parentId: t.notes,
      name: `${e.id}.json`,
      content: entryJSON(e),
      mime: 'application/json',
      fileId: e.drive_file_id || null,
    });
    await markSynced(e.id, res.id);
    n++;
  }
  return n;
}

/** Pull: EVERY remote file, compared by rev — not just the ones we lack.
 *
 *  ⛔ 2026-11-01 BUG: this used to do `if (local.has(id)) continue;`, so a Drive
 *  copy newer than the local one never came down. An edit made on another device
 *  brought the phone nothing, and the two drifted apart with no error. It also
 *  meant a replaced phone restored fine (no ids local) while an existing phone
 *  never updated — the exact opposite of what "sync" should do.
 *
 *  Now every remote entry goes through mergeEntry (§6): no local copy → add;
 *  higher rev → take it, preserving our text as a copy if it differs. */
export async function pull() {
  const t = await tree();
  const remote = await listFiles(t.notes);
  const local = new Map((await allRaw()).map(e => [e.id, e]));
  let n = 0;
  for (const f of remote) {
    const id = f.name.replace(/\.json$/, '');
    let parsed;
    try { parsed = JSON.parse(await readFile(f.id)); } catch { continue; }
    if (!parsed || parsed.id !== id) continue;          // ignore anything malformed
    const mine = local.get(id);
    // Cheap guard: skip only when we are certain the remote is not newer.
    if (mine && !(parsed.rev > mine.rev)) continue;
    const r = await mergeEntry({ ...parsed, synced_at: new Date().toISOString(), drive_file_id: f.id });
    if (r === 'added' || r === 'merged' || r === 'recovered') n++;
  }
  return n;
}

export async function fullSync() {
  if (_busy) return { skipped: true };
  _busy = true;
  try {
    /* ⭐ PULL FIRST, THEN PUSH. With push first, a device holding an unsynced
       rev 2 would overwrite a remote rev 3 before it ever read it — a silent
       downgrade. Merging first means the higher rev always wins (§6). */
    const pulled = await pull();
    const pushed = await push();
    await setSetting('last_sync', new Date().toISOString());
    await setSetting('last_sync_error', null);
    return { pushed, pulled };
  } catch (err) {
    await setSetting('last_sync_error', String(err.message || err));
    throw err;
  } finally {
    _busy = false;
  }
}

/**
 * ⭐ §4 THE SEND — BOTH A and B, in this order. They are not alternatives.
 *   A. write outbox/<id>.md  — the durable, permanent copy. The ONLY shareable folder.
 *   B. open mailto: — her own mail app, pre-filled, SHE taps send. Nothing is
 *      transmitted on her behalf without her finger on it. That is the correct
 *      amount of friction for this specific act.
 *
 * ⚠️ The mailto body is built by the caller; this returns the durable copy result.
 * Returns { mailto, truncated }.
 */
const MAILTO_LIMIT = 1800;   // practical cap is ~2000 chars for the whole URL

export function buildMailto({ recipient, subject, body }) {
  let b = body || '';
  let truncated = false;
  if (b.length > MAILTO_LIMIT) {
    b = b.slice(0, 1200).trimEnd() +
      '\n\n[This entry is longer than a mail link can carry. The full text is in the shared '
      + 'Drive folder: sotto voce → outbox.]';
    truncated = true;
  }
  const u = `mailto:${encodeURIComponent(recipient)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(b)}`;
  return { url: u, truncated };
}

/** Write the durable outbox copy. Path is the only shareable one; drafts never are. */
export async function writeOutbox(e) {
  const t = await tree();
  const stamp = (e.sent_at || new Date().toISOString()).replace(/[:.]/g, '-');
  const res = await writeFile({
    parentId: t.outbox,
    name: `${stamp}_${e.id.slice(0, 8)}.md`,
    content: `# ${e.created_at}\n\n${e.body}\n`,
    mime: 'text/markdown',
  });
  return res;
}

export function resetTreeCache() { _tree = null; }

export async function lastSyncInfo() {
  const at = await getSetting('last_sync', null);
  const err = await getSetting('last_sync_error', null);
  return { at, err };
}
