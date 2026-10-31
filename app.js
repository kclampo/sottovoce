/*
 * sotto voce — app.js
 *
 * Two screens: the score and the editor. Settings is a panel, not a third screen.
 *
 * ⛔ §7b DO-NOT-BUILD — never add: streaks, "days written", word counts,
 * reminders, read receipts, "seen", typing indicators, notifications to him,
 * AI prompts, mood logging, weekly reports, auto-send, scheduled send,
 * send-all, ordering by "important". If a feature adds an observer, a metric
 * or a deadline, it is out.
 *
 * ⛔ Buttons say Send and New. Never Play / Perform / Resound — the metaphor
 * lives in the app's voice and empty states, never in a control she has to decode.
 */

import { APP_VERSION } from './version.js';
import { GOOGLE_CLIENT_ID } from './config.js';
import {
  newEntry, putEntry, getEntry, listEntries, tombstone,
  getSetting, setSetting, requestPersistence,
  exportJSON, exportMarkdown, importJSON, markSynced,
} from './db.js';
import { configure, token, isConnected, hasClientId, disconnect } from './drive.js';
import { fullSync, writeOutbox, buildMailto, lastSyncInfo, resetTreeCache } from './sync.js';

const $ = id => document.getElementById(id);

const VIEWS = { score: $('scoreView'), editor: $('editorView'), settings: $('settingsView') };
function show(name) {
  for (const [k, el] of Object.entries(VIEWS)) el.hidden = (k !== name);
}

let current = null;        // entry being edited
let saveTimer = null;
let syncTimer = null;

/* ─────────────────────────────────────────────────────────── helpers */
function toast(msg, ms = 1600) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

const pad = n => String(n).padStart(2, '0');
const MONTH = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const WEEK = ['SUN','MON','TUE','WED','THU','FRI','SAT'];

function dayKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function dayLabel(iso) {
  const d = new Date(iso);
  // ⛔ No "Today" / "Yesterday" — the app does not narrate time at her.
  return { d: `${d.getDate()} ${MONTH[d.getMonth()]}`, w: WEEK[d.getDay()] };
}
function clock(iso) {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** Display title is DERIVED from the first line at render time. Never stored. */
function firstLine(body) {
  const line = (body || '').trim().split('\n')[0].trim();
  return line || '—';
}

/* ─────────────────────────────────────────────────────────── the score */
async function renderScore() {
  const entries = await listEntries();
  const systems = $('systems');
  systems.replaceChildren();

  $('emptyWrite').hidden = entries.length > 0;

  const sentCount = entries.filter(e => e.state === 'sent').length;
  const everShown = await getSetting('empty_sent_shown', false);
  if (entries.length > 0 && sentCount === 0 && !everShown) {
    $('emptySent').hidden = false;
    await setSetting('empty_sent_shown', true);
  } else {
    $('emptySent').hidden = true;
  }

  // group chronologically by day — one day = one system
  const byDay = new Map();
  for (const e of entries) {
    const k = dayKey(e.created_at);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(e);
  }

  const keys = [...byDay.keys()].sort().reverse();   // newest day first
  for (const k of keys) {
    const rows = byDay.get(k).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const sys = document.createElement('div');
    sys.className = 'system';

    const lab = dayLabel(rows[0].created_at);
    const head = document.createElement('div');
    head.className = 'dateHead';
    head.innerHTML = `<span>${lab.d}</span><span class="w">${lab.w}</span>`;
    sys.appendChild(head);

    const staffTop = document.createElement('div');
    staffTop.className = 'staff';
    sys.appendChild(staffTop);

    for (const e of rows) {
      const b = document.createElement('button');
      b.className = 'note ' + (e.state === 'sent' ? 'inked' : 'pencilled');
      b.type = 'button';
      b.dataset.id = e.id;

      const g = document.createElement('span');
      g.className = 'g';
      const head2 = document.createElement('i');
      head2.className = 'head';
      g.appendChild(head2);
      if (e.state === 'sent') {
        const stem = document.createElement('i');
        stem.className = 'stem';
        g.appendChild(stem);
      }

      const body = document.createElement('span');
      body.className = 'body';
      body.textContent = firstLine(e.body);

      const t = document.createElement('span');
      t.className = 't';
      t.textContent = clock(e.created_at);

      b.append(g, body, t);
      b.addEventListener('click', () => openEditor(e.id));
      sys.appendChild(b);
    }

    const staffBot = document.createElement('div');
    staffBot.className = 'staff';
    sys.appendChild(staffBot);

    systems.appendChild(sys);
  }
  updateSyncDot();
}

async function updateSyncDot() {
  const el = $('syncDot');
  if (!navigator.onLine) { el.textContent = '⚠ offline'; el.className = 'dot warn'; return; }
  if (!hasClientId()) { el.textContent = ''; el.className = 'dot'; return; }
  try {
    const { at, err } = await lastSyncInfo();
    if (err) { el.textContent = '⚠'; el.className = 'dot warn'; el.title = err; return; }
    if (!at) { el.textContent = '○'; el.className = 'dot'; el.title = 'not synced yet'; return; }
    el.textContent = '● synced';
    el.className = 'dot ok';
    el.title = 'last sync ' + new Date(at).toLocaleString();
  } catch {
    el.textContent = '○'; el.className = 'dot';
  }
}

/* ─────────────────────────────────────────────────────────── the editor */
async function openEditor(id) {
  current = id ? await getEntry(id) : null;
  if (!current) return;

  const ed = $('editor');
  const sent = current.state === 'sent';

  ed.value = current.body || '';
  ed.readOnly = sent;

  $('editorMeta').textContent = sent ? 'sent' : 'draft';
  $('sentNote').hidden = !sent;
  if (sent) $('sentAt').textContent = new Date(current.sent_at || current.updated_at).toLocaleString();

  const name = await getSetting('display_name', '');
  const recip = await getSetting('recipient', '');
  $('recipientName').textContent = name ? recipDisplay(recip) : recipDisplay(recip);
  $('sendBtn').disabled = sent || !recip;

  $('moreMenu').hidden = true;
  show('editor');
  if (!sent) {
    // cursor live — writing starts in under one second
    ed.focus();
    ed.setSelectionRange(ed.value.length, ed.value.length);
  }
}

const recipDisplay = e => (e ? '@' + e.split('@')[0] : 'them');

async function persistNow() {
  if (!current || current.state === 'sent') return;
  current.body = $('editor').value;
  $('editorMeta').textContent = current.body.trim() ? 'draft' : 'draft';
  const saved = await putEntry(current);
  current = saved;
}

function queueSave() {
  if (!current || current.state === 'sent') return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => { await persistNow(); updateSyncDot(); }, 500);
}

/* ─────────────────────────────────────────────────────────── send */
async function doSend() {
  if (!current) return;
  const recip = await getSetting('recipient', '');
  if (!recip) { toast('Add a recipient in Settings first.'); return; }

  await persistNow();
  if (!current.body.trim()) { toast('Nothing to send yet.'); return; }

  // Freeze it. §1b — a sent entry is the record of what she actually sent him.
  current.state = 'sent';
  current.sent_at = new Date().toISOString();
  current.rev += 1;
  current = await putEntry(current);

  // A — the durable copy. Failure here must NOT block the send (§5c: local-first).
  let outboxOk = true;
  try {
    await writeOutbox(current);
  } catch (err) {
    outboxOk = false;
    await setSetting('last_sync_error', 'outbox: ' + String(err.message || err));
  }

  // B — mailto handoff. The final tap is hers, in her own mail client.
  const { url, truncated } = buildMailto({
    recipient: recip,
    subject: 'a note',
    body: current.body,
  });
  window.location.href = url;

  $('editorMeta').textContent = 'sent';
  $('sentNote').hidden = false;
  $('sentAt').textContent = new Date(current.sent_at).toLocaleString();
  $('editor').readOnly = true;
  $('sendBtn').disabled = true;

  toast('Played.');
  await renderScore();
  if (outboxOk) { fullSync().then(updateSyncDot).catch(() => {}); }
  if (!outboxOk) toast('Saved here. Drive copy will follow.');
}

/* ─────────────────────────────────────────────────────────── settings */
async function loadSettings() {
  $('recipient').value = await getSetting('recipient', '');
  $('displayName').value = await getSetting('display_name', '');

  const { at, err } = await lastSyncInfo();
  $('lastSync').textContent = at ? new Date(at).toLocaleString() : 'never';
  $('driveState').textContent = isConnected()
    ? 'connected'
    : (hasClientId()
        ? 'not connected — tap Connect Google Drive'
        : 'sync not set up in this build');
  if (err) $('lastSync').textContent += '  ⚠ ' + err;

  const st = await getSetting('persist_state', 'unknown');
  $('storageState').textContent = st;

  const warn = $('persistWarn');
  if (st === 'denied' || st === 'error' || st === 'unsupported') {
    warn.hidden = false;
    warn.className = 'plain warn';
    warn.textContent = 'The browser did not grant persistent storage, so it may clear this app\'s data under pressure. Export regularly, and keep Drive sync on.';
  } else {
    warn.hidden = true;
  }
}

function download(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ─────────────────────────────────────────────────────────── wiring */
$('newBtn').addEventListener('click', async () => {
  const e = newEntry();
  await putEntry(e);
  openEditor(e.id);
});

$('backBtn').addEventListener('click', async () => {
  await persistNow();
  $('moreMenu').hidden = true;
  show('score');
  await renderScore();
});

$('editor').addEventListener('input', queueSave);
$('editor').addEventListener('blur', persistNow);
$('sendBtn').addEventListener('click', doSend);

$('moreBtn').addEventListener('click', () => {
  $('moreMenu').hidden = !$('moreMenu').hidden;
});

$('exportEntryBtn').addEventListener('click', () => {
  if (!current) return;
  download(`note-${current.id.slice(0, 8)}.md`, `# ${current.created_at}\n\n${current.body}\n`, 'text/markdown');
  $('moreMenu').hidden = true;
});

$('deleteBtn').addEventListener('click', async () => {
  if (!current) return;
  await tombstone(current.id);      // tombstone, never a hard delete
  $('moreMenu').hidden = true;
  current = null;
  show('score');
  await renderScore();
  toast('Deleted.');
});

$('settingsBtn').addEventListener('click', async () => {
  await loadSettings();
  show('settings');
});
$('closeSettingsBtn').addEventListener('click', async () => {
  show('score');
  await renderScore();
});

$('recipient').addEventListener('input', async e => {
  const v = e.target.value.trim();
  e.target.value = v;
  await setSetting('recipient', v);
});
$('displayName').addEventListener('input', async e => {
  await setSetting('display_name', e.target.value.trim());
});
$('connectBtn').addEventListener('click', async () => {
  if (!hasClientId()) {
    $('settingsMsg').textContent = 'Drive sync is not set up in this build. Everything else works — writing, sending, export.';
    return;
  }
  try {
    await token({ interactive: true });
    $('settingsMsg').textContent = 'Connected.';
    resetTreeCache();
    await loadSettings();
    syncNow();
  } catch (err) {
    $('settingsMsg').textContent = 'Could not connect: ' + String(err.message || err);
  }
});

$('syncNowBtn').addEventListener('click', () => syncNow(true));

$('exportJsonBtn').addEventListener('click', async () => {
  download(`sotto-voce-${new Date().toISOString().slice(0, 10)}.json`, await exportJSON());
});
$('exportMdBtn').addEventListener('click', async () => {
  download(`sotto-voce-${new Date().toISOString().slice(0, 10)}.md`, await exportMarkdown(), 'text/markdown');
});
$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  try {
    const res = await importJSON(await f.text());
    $('settingsMsg').textContent = `Imported — ${res.added} added, ${res.merged} merged, ${res.recovered} recovered.`;
    await renderScore();
  } catch (err) {
    $('settingsMsg').textContent = 'Import failed: ' + String(err.message || err);
  }
  e.target.value = '';
});

$('reconnect').addEventListener('click', async () => {
  try { await token({ interactive: true }); $('reconnect').hidden = true; syncNow(); } catch {}
});

/* ─────────────────────────────────────────────────────────── sync loop */
async function syncNow(manual = false) {
  if (!hasClientId() || !isConnected()) {
    if (manual) $('settingsMsg').textContent = 'Connect Google Drive first.';
    return;
  }
  try {
    const r = await fullSync();
    updateSyncDot();
    if (manual) $('settingsMsg').textContent = `Synced — ${r.pushed} pushed, ${r.pulled} pulled.`;
    await loadSettingsIfVisible();
  } catch (err) {
    updateSyncDot();
    if (manual) $('settingsMsg').textContent = 'Sync failed: ' + String(err.message || err);
  }
}

async function loadSettingsIfVisible() {
  if (!VIEWS.settings.hidden) await loadSettings();
}

function startSyncTimers() {
  clearInterval(syncTimer);
  // ⛔ iOS has no Background Sync. Timers are foreground-only by design.
  syncTimer = setInterval(() => { if (!document.hidden) syncNow(); }, 5 * 60 * 1000);
}

document.addEventListener('visibilitychange', async () => {
  if (document.hidden) {
    await persistNow();
    syncNow();
  } else {
    await updateSyncDot();
  }
});

/* ─────────────────────────────────────────────────────────── boot */
(async function boot() {
  try {
    const clientId = GOOGLE_CLIENT_ID;
    configure({
      clientId,
      onNeedReconnect: () => { $('reconnect').hidden = false; },
    });

    const st = await requestPersistence();
    await setSetting('persist_state', st);

    if ('serviceWorker' in navigator) {
      try { await navigator.serviceWorker.register('./sw.js', { scope: './' }); } catch {}
    }

    await renderScore();
    show('score');

    // §5c silent reconnect if a client ID exists and a Google session is live
    if (hasClientId()) {
      token({ silent: true }).then(() => { resetTreeCache(); syncNow(); }).catch(() => {});
    }
    startSyncTimers();
    window.APP_VERSION = APP_VERSION;
  } catch (err) {
    console.error('boot failed', err);
    toast('Something went wrong opening the notebook.');
  }
})();
