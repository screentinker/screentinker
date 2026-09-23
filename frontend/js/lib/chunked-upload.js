/*
 * Resumable uploads, client side.
 *
 * ⚠️ THE BUG THIS EXISTS FOR, measured rather than imagined. A customer in Perth uploading to a
 * Hetzner box failed seven times at exactly 125.008–125.012 seconds — a hard ceiling at Cloudflare,
 * not a flaky network — while his 65 successful uploads in the same session peaked at 114.2s. He
 * was living inside a ten-second margin. Selecting several files made failure certain, because the
 * dashboard sent them as ONE request (#212): the bytes scaled with the selection, the 125 seconds
 * did not. His report was "it stays on 1%", which is exactly what an aggregate progress bar does
 * when it is measuring half a gigabyte that will never arrive.
 *
 * So: one session per FILE, one request per CHUNK. Each chunk gets its own budget, and a dropped
 * connection costs one chunk instead of a gigabyte.
 *
 * ⚠️ AND IT SURVIVES A RELOAD. The session id is kept in localStorage against a fingerprint of the
 * file, so closing the tab, a crash, or a laptop lid does not throw away 340MB of progress. The
 * offset is never stored here — it is asked of the server, which reads it from the bytes on disk.
 * A local counter would be a second source of truth that disagrees with reality exactly when it
 * matters, which is after the crash.
 */
import { getAuthHeaders } from '../api.js';

const STORE_KEY = 'st_upload_sessions';
/* A resumable session is worth offering for a day; the server collects them on the same clock. */
const STORE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Identify a file well enough to match it to a session on a later visit.
 *
 * Name + size + last-modified. Not a hash: hashing 500MB in the browser to decide whether to offer
 * a resume would cost more than the resume saves, and the server re-checks the size at finalize —
 * so the worst case of a false match is a refused finalize, not a corrupt file.
 */
function fingerprint(file, folderId) {
  return [file.name, file.size, file.lastModified || 0, folderId || ''].join('|');
}

function readStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    const now = Date.now();
    let changed = false;
    for (const k of Object.keys(raw)) {
      if (!raw[k] || typeof raw[k].at !== 'number' || now - raw[k].at > STORE_TTL_MS) { delete raw[k]; changed = true; }
    }
    if (changed) { try { localStorage.setItem(STORE_KEY, JSON.stringify(raw)); } catch (_) { /* full or blocked */ } }
    return raw;
  } catch (_) {
    // Private windows, blocked site data, corrupt JSON. Resume is an optimisation; losing it must
    // never stop an upload.
    return {};
  }
}

function remember(fp, id) {
  try {
    const store = readStore();
    store[fp] = { id, at: Date.now() };
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch (_) { /* see readStore */ }
}

function forget(fp) {
  try {
    const store = readStore();
    delete store[fp];
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch (_) { /* see readStore */ }
}

async function jsonOrThrow(res) {
  let body = null;
  try { body = await res.json(); } catch (_) { /* some responses have no body */ }
  if (!res.ok) throw Object.assign(new Error((body && body.error) || `HTTP ${res.status}`), { status: res.status, body });
  return body;
}

/** Ask the server where an existing session got to. Returns null when it is gone or foreign. */
async function describe(id) {
  try {
    const res = await fetch(`/api/content/uploads/${encodeURIComponent(id)}`, { headers: getAuthHeaders() });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

/**
 * Upload one file, resuming a previous attempt when there is one.
 *
 * @param {File} file
 * @param {object} opts
 * @param {string|null} opts.folderId
 * @param {(sent:number, total:number)=>void} opts.onProgress  bytes, so the caller can aggregate
 * @param {(info:{offset:number,total:number})=>Promise<boolean>|boolean} opts.onResumeOffer
 *        asked before reusing a session from a previous visit; false starts over
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<object>} the created content row
 */
export async function uploadFileResumable(file, opts = {}) {
  const { folderId = null, onProgress = () => {}, onResumeOffer = null, signal } = opts;
  const fp = fingerprint(file, folderId);

  let session = null;
  let offset = 0;

  // 1. Is there a session from a previous attempt, and does the server still have it?
  const remembered = readStore()[fp];
  if (remembered && remembered.id) {
    const info = await describe(remembered.id);
    if (info && info.declared_size === file.size && info.offset < file.size) {
      const accept = onResumeOffer ? await onResumeOffer({ offset: info.offset, total: file.size }) : true;
      if (accept) {
        session = { id: info.id, chunk_size: info.chunk_size };
        offset = info.offset;
      } else {
        // They chose to start over: drop the server's bytes rather than leaving them to the sweeper.
        try {
          await fetch(`/api/content/uploads/${encodeURIComponent(info.id)}`, { method: 'DELETE', headers: getAuthHeaders() });
        } catch (_) { /* the sweeper will get it */ }
        forget(fp);
      }
    } else {
      forget(fp);
    }
  }

  // 2. Otherwise open a new one.
  if (!session) {
    const created = await jsonOrThrow(await fetch('/api/content/uploads', {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, size: file.size, folder_id: folderId }),
    }));
    session = { id: created.id, chunk_size: created.chunk_size };
    offset = created.offset || 0;
    remember(fp, session.id);
  }

  onProgress(offset, file.size);

  // 3. Send the rest, one chunk at a time.
  const chunkSize = session.chunk_size || 5 * 1024 * 1024;
  while (offset < file.size) {
    if (signal && signal.aborted) throw Object.assign(new Error('cancelled'), { cancelled: true });

    const end = Math.min(offset + chunkSize, file.size);
    const res = await fetch(`/api/content/uploads/${encodeURIComponent(session.id)}`, {
      method: 'PATCH',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/octet-stream', 'Upload-Offset': String(offset) },
      body: file.slice(offset, end),
      signal,
    });

    if (res.status === 409) {
      /*
       * The server and we disagree about where we are — a response we never saw, or a retry of a
       * chunk that had in fact landed. It TELLS us the offset, so this is a one-round-trip
       * correction rather than a restart. This is why the 409 carries a number.
       */
      const body = await res.json().catch(() => null);
      if (body && Number.isFinite(body.offset)) { offset = body.offset; onProgress(offset, file.size); continue; }
    }

    const body = await jsonOrThrow(res);
    offset = body.offset;
    onProgress(offset, file.size);
  }

  // 4. Assemble and ingest.
  const content = await jsonOrThrow(await fetch(`/api/content/uploads/${encodeURIComponent(session.id)}/finalize`, {
    method: 'POST',
    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
    body: '{}',
  }));
  forget(fp);
  return content;
}

/**
 * Upload several files, one after another.
 *
 * ⚠️ SEQUENTIAL ON PURPOSE. Uploading in parallel would put the same total bytes in flight at once
 * and re-create the original problem in a new shape — several slow requests all racing the same
 * ceiling, on a link that is the bottleneck anyway. One at a time also means a failure is one
 * file's problem rather than the whole selection's, which is exactly what was wrong before.
 */
export async function uploadFilesResumable(files, opts = {}) {
  const { onProgress = () => {}, onFileDone = () => {}, ...rest } = opts;
  const total = files.reduce((n, f) => n + f.size, 0);
  let done = 0;
  const results = [];

  for (const file of files) {
    const content = await uploadFileResumable(file, {
      ...rest,
      onProgress: (sent) => onProgress(done + sent, total, file),
    });
    done += file.size;
    results.push(content);
    onFileDone(content, results.length, files.length);
  }
  return results;
}

export { fingerprint as _fingerprint, STORE_KEY as _STORE_KEY };
