/*
 * sotto voce — sync.js
 *
 * Direction: push local unsynced entries, then pull remote ids not present
 * locally. Union merge ON ID — two devices writing offline produce two
 * independent files, so there is no conflict to resolve (§6).
 *
 * ⛔ iOS has NO Background Sync / Periodic Sync. Never design on it. Triggers are
 * explicit: launch, send, visibilitychange→hidden, and every 5 min foreground.
 */

import {
  allRaw, getEntry, putEntry, markSynced, entriesNeedingSync, getSetting, setSetting,
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

/** Pull: remote ids not present locally → create locally. Union merge on id. */
export async function pull() {
  const t = await tree();
  const remote = await listFiles(t.notes);
  const local = new Map((await allRaw()).map(e => [e.id, e]));
  let n = 0;
  for (const f of remote) {
    const id = f.name.replace(/\.json$/, '');
    if (local.has(id)) continue;
    let parsed;
    try { parsed = JSON.parse(await readFile(f.id)); } catch { continue; }
    if (!parsed || parsed.id !== id) continue;          // ignore anything malformed
    await putEntry({ ...parsed, synced_at: new Date().toISOString(), drive_file_id: f.id });
    n++;
  }
  return n;
}

export async function fullSync() {
  if (_busy) return { skipped: true };
  _busy = true;
  try {
    const pushed = await push();
    const pulled = await pull();
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
