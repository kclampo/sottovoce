/*
 * sotto voce — drive.js
 *
 * Route 1: Google Drive from the browser. NO backend, NO cloud service of ours.
 *
 * ⛔ §5b SECRETS
 * The client ID is public and ships in this bundle — that is correct and
 * expected. There is NO client secret. Never create one, never commit one.
 * The access token is held IN MEMORY ONLY — never localStorage, never a cookie.
 *
 * ⛔ §5c TOKEN LIFECYCLE — the part that gets skipped and then breaks
 * GIS token client, response_type 'token'. Access token lives ~1 hour. There is
 * no refresh token. On 401, request a new one with prompt:'none' (silent, works
 * while a Google session exists). Only if THAT fails, show "Tap to reconnect".
 *
 * ⭐ Because the app is LOCAL-FIRST, an expired token is never a data-loss
 * event. Writes land in IndexedDB first and sync later. The editor is never
 * blocked on the network. This is the single most important resilience property.
 */

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = 'sotto voce';
const MIME_FOLDER = 'application/vnd.google-apps.folder';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

/* ------------------------------------------------------------ token state */
let CLIENT_ID = null;          // public, set by app from settings
let _token = null;              // IN MEMORY ONLY
let _tokenExp = 0;              // epoch ms
let _client = null;
let _onNeedReconnect = null;

export function configure({ clientId, onNeedReconnect }) {
  if (clientId) CLIENT_ID = clientId;
  if (onNeedReconnect) _onNeedReconnect = onNeedReconnect;
}

export function hasClientId() { return !!CLIENT_ID; }
export function isConnected() { return !!_token && Date.now() < _tokenExp; }

function loadGis() {
  return new Promise((res, rej) => {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) return res();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    s.onload = () => res();
    s.onerror = () => rej(new Error('Could not load Google Identity Services.'));
    document.head.appendChild(s);
  });
}

/**
 * Get a token. silent:true uses prompt:'none' which succeeds while a Google
 * session exists in the browser and needs no UI. If it fails there, we call the
 * reconnect callback — never a silent dead end.
 */
export async function token({ silent = false, interactive = false } = {}) {
  if (!CLIENT_ID) throw new Error('No Google client ID configured.');
  if (isConnected()) return _token;
  await loadGis();

  return new Promise((res, rej) => {
    try {
      if (!_client) {
        _client = window.google.accounts.oauth2.initTokenClient({
          client_id: CLIENT_ID,
          scope: SCOPE,
          callback: () => {},        // replaced per-call below
        });
      }
      _client.callback = resp => {
        if (resp && resp.access_token) {
          _token = resp.access_token;
          const ttl = Number(resp.expires_in || 3600);
          _tokenExp = Date.now() + (ttl - 60) * 1000;
          res(_token);
        } else {
          if (!silent && _onNeedReconnect) _onNeedReconnect();
          rej(new Error(resp && resp.error ? resp.error : 'No token returned.'));
        }
      };
      _client.requestAccessToken({ prompt: silent ? 'none' : (interactive ? 'consent' : '') });
    } catch (err) {
      if (_onNeedReconnect) _onNeedReconnect();
      rej(err);
    }
  });
}

export function disconnect() {
  if (_token && window.google && window.google.accounts && window.google.accounts.oauth2) {
    try { window.google.accounts.oauth2.revoke(_token, () => {}); } catch {}
  }
  _token = null; _tokenExp = 0;
}

/* ------------------------------------------------------------ HTTP helper */
async function api(path, { method = 'GET', headers = {}, body = null, retry = true } = {}) {
  const t = await token({ silent: true });
  const r = await fetch(path.startsWith('http') ? path : API + path, {
    method,
    headers: { Authorization: `Bearer ${t}`, ...headers },
    body,
  });

  // §5c: a 401 gets ONE silent retry before we ask her to reconnect.
  if (r.status === 401 && retry) {
    _token = null; _tokenExp = 0;
    try {
      await token({ silent: true });
    } catch {
      if (_onNeedReconnect) _onNeedReconnect();
      throw new Error('Google session expired. Tap to reconnect.');
    }
    return api(path, { method, headers, body, retry: false });
  }
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json()).error?.message || ''; } catch {}
    throw new Error(`Drive ${r.status}${detail ? ': ' + detail : ''}`);
  }
  return r;
}

/* --------------------------------------------------------------- folders */
async function findChild(name, parentId) {
  const q = parentId
    ? `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed=false`
    : `name='${name.replace(/'/g, "\\'")}' and trashed=false`;
  const r = await api(`/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&spaces=drive`);
  const j = await r.json();
  return (j.files && j.files[0]) || null;
}

async function createFolder(name, parentId) {
  const meta = { name, mimeType: MIME_FOLDER };
  if (parentId) meta.parents = [parentId];
  const r = await api('/files?fields=id,name', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(meta),
  });
  return r.json();
}

export async function ensureFolder(name, parentId = null) {
  const found = await findChild(name, parentId);
  if (found) return found.id;
  const made = await createFolder(name, parentId);
  return made.id;
}

/** The tree: app folder → notes/ + outbox/
 *  ⛔ NO meta/ FOLDER (2026-11-01: "you can drop the cursor"). §3 originally
 *  specified meta/device.json for a device id + sync cursor. Sync never used one
 *  — pull lists notes/ and compares by entry id — so it was an empty folder
 *  appearing in her Drive for no reason. Dropped from the spec and the code. */
export async function ensureTree() {
  const root = await ensureFolder(FOLDER_NAME);
  const notes = await ensureFolder('notes', root);
  const outbox = await ensureFolder('outbox', root);
  return { root, notes, outbox };
}

/* ------------------------------------------------------------ file writes */
/**
 * §3a ONE ENTRY = ONE FILE. Not one big notebook file. Re-uploading the same
 * entry overwrites the same file, so writes are idempotent and two devices
 * produce independent files that need no reconciliation.
 * ⚠️ Drive has no append API — every write is a full replace, which is exactly
 * why one-file-per-entry is the right shape.
 */
export async function writeFile({ parentId, name, content, mime = 'application/json', fileId = null }) {
  const boundary = '----sotto' + Math.random().toString(16).slice(2);
  const meta = fileId ? { name } : { name, parents: [parentId] };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n${content}\r\n` +
    `--${boundary}--`;

  const url = fileId
    ? `${UPLOAD}/${fileId}?uploadType=multipart&fields=id,name`
    : `${UPLOAD}?uploadType=multipart&fields=id,name`;

  const r = await api(url, {
    method: fileId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return r.json();
}

export async function listFiles(parentId) {
  const out = [];
  let pageToken = '';
  do {
    const q = encodeURIComponent(`'${parentId}' in parents and trashed=false`);
    const r = await api(`/files?q=${q}&fields=nextPageToken,files(id,name,modifiedTime)&pageSize=200${pageToken ? `&pageToken=${pageToken}` : ''}`);
    const j = await r.json();
    (j.files || []).forEach(f => out.push(f));
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return out;
}

export async function readFile(fileId) {
  const r = await api(`/files/${fileId}?alt=media`);
  return r.text();
}
