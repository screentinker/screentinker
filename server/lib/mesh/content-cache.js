'use strict';

/*
 * Scale-out C3 — the REPLICA's content cache (docs/scale-out-design.md §6a; docs/scale-out.md
 * "Replica content cache").
 *
 * Copied content ROWS arrive by replication; their BYTES do not. Under a `caches-content` edge this
 * module keeps those bytes on this node's own disk so a dashboard or an attached player can read
 * media while the primary is unreachable — for files this node has already seen.
 *
 * ⚠️ DERIVED, NEVER AUTHORED. A file is stored only for a name a COPIED content row carries
 * (filepath / thumbnail_path), under that exact basename in this node's uploads/content, so the
 * unchanged static route and /api/content/:id/file serve it as a plain local hit. This module never
 * writes a content row (C1's rule) and never invents a file: a miss with the primary down is the
 * caller's 503, not ours.
 *
 * ⚠️ I9. The origin is PRIMARY_URL — operator-typed, the same address every write goes to — and
 * only that. One bounded, resumable attempt chain per file (lib/mesh/pull-download.js), then give
 * up and let the caller serve through. No second URL, no other replica, no compiled host.
 *
 * ⚠️ BOUNDED. REPLICA_CACHE_BYTES per edge; LRU by last_read_at; a file larger than the cap is
 * never stored. Deleted on the primary -> the copied row goes -> the orphan sweep unlinks the file.
 * Edge revoked or role removed -> every file cached for it goes on the next sweep.
 */

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const { downloadResumable } = require('./pull-download');
const { digestFileSync } = require('../content-digest');

const asList = (v) => (Array.isArray(v) ? v : store.safeParseArray(v));
const nowSec = () => Math.floor(Date.now() / 1000);
/** How often a hit refreshes last_read_at (a fleet of players reading one file must not write per request). */
const TOUCH_EVERY_S = 60;
const SWEEP_EVERY_MS = 10 * 60 * 1000;

function cachesContent(edge) {
  const caps = asList(edge.role_capabilities);
  const grant = asList(edge.grant_categories);
  // An edge whose token has expired is not an edge: the role ends with the pairing, not with the row.
  if (!require('./pairing').edgeIsActive(edge, Math.floor(Date.now() / 1000))) return false;
  return edge.direction === 'down' && !edge.revoked_at &&
         caps.includes('caches-content') && caps.includes('serves-dashboard') &&
         grant.includes('workspace-replication');
}

function cachingEdges(db) {
  try {
    return db.prepare("SELECT * FROM mesh_edges WHERE direction = 'down' AND revoked_at IS NULL").all().filter(cachesContent);
  } catch (e) { return []; }
}

/** The caching edge for a content row, or null (own row, uncopied workspace, no role, no edge). */
function edgeForContent(db, content) {
  if (!content || !content.workspace_id) return null;
  let ws = null;
  try { ws = db.prepare('SELECT origin_node_id FROM workspaces WHERE id = ?').get(content.workspace_id); } catch (e) { return null; }
  if (!ws || !ws.origin_node_id) return null;
  return cachingEdges(db).find((e) => e.peer_node_id === ws.origin_node_id) || null;
}

/** The copied content row a /uploads/content name belongs to, or null. */
function contentForName(db, name) {
  if (!name || /[\/\\]/.test(name)) return null;
  try {
    const rows = db.prepare(`SELECT c.* FROM content c JOIN workspaces w ON w.id = c.workspace_id
                              WHERE w.origin_node_id IS NOT NULL AND (c.filepath LIKE '%' || ? OR c.thumbnail_path LIKE '%' || ?)`).all(name, name);
    const base = (p) => String(p || '').split(/[\/\\]/).pop();
    return rows.find((r) => base(r.filepath) === name || base(r.thumbnail_path) === name) || null;
  } catch (e) { return null; }
}

/* ------------------------------ accounting ------------------------------ */

function usedBytes(db, edgeId) {
  try { return db.prepare('SELECT COALESCE(SUM(bytes), 0) AS b FROM mesh_content_cache WHERE edge_id = ?').get(edgeId).b; } catch (e) { return 0; }
}

function unlinkQuiet(contentDir, name) {
  if (!name) return;
  const p = path.resolve(contentDir, path.basename(name));
  if (!p.startsWith(path.resolve(contentDir))) return;
  try { fs.unlinkSync(p); } catch (e) { /* already gone */ }
}

function dropEntry(db, contentDir, row) {
  unlinkQuiet(contentDir, row.filename);
  unlinkQuiet(contentDir, row.thumb_filename);
  db.prepare('DELETE FROM mesh_content_cache WHERE content_id = ?').run(row.content_id);
}

/*
 * ⚠️ PINNED: a file any copied playlist item or device default still names is never evicted —
 * last_read_at says nothing about the slide that is ON SCREEN after an outage (players read it
 * once and cache it; the replica may not have served it for days). Only unreferenced files are
 * LRU candidates. If the pinned set alone exceeds the cap, new files are served through, and
 * status() says so.
 */
const PINNED_SQL = `content_id IN (SELECT content_id FROM playlist_items WHERE content_id IS NOT NULL)
                    OR content_id IN (SELECT default_content_id FROM devices WHERE default_content_id IS NOT NULL)`;

/** Evict least-recently-read UNPINNED entries of this edge until `need` bytes fit under the cap. */
function makeRoom(db, contentDir, edgeId, need, capBytes) {
  if (need > capBytes) return false;
  while (usedBytes(db, edgeId) + need > capBytes) {
    const victim = db.prepare(`SELECT * FROM mesh_content_cache WHERE edge_id = ? AND NOT (${PINNED_SQL})
                               ORDER BY last_read_at ASC, fetched_at ASC LIMIT 1`).get(edgeId);
    if (!victim) break;
    dropEntry(db, contentDir, victim);
  }
  return usedBytes(db, edgeId) + need <= capBytes;
}

function pinnedBytes(db, edgeId) {
  try { return db.prepare(`SELECT COALESCE(SUM(bytes), 0) AS b FROM mesh_content_cache WHERE edge_id = ? AND (${PINNED_SQL})`).get(edgeId).b; } catch (e) { return 0; }
}

/* ------------------------------ fetching ------------------------------ */

/**
 * Fetch one file from the primary into `contentDir/<name>`, verified. Returns {ok} or {ok:false,
 * reason}. `expectedBytes` null means "unknown" (a thumbnail): whatever arrives is kept if the GET
 * succeeded; a known size is enforced by the puller and the sha256 by us.
 */
async function fetchFile({ config, name, expectedBytes, digest, fetchImpl }) {
  const base = config.primaryUrl;
  if (!base) return { ok: false, reason: 'PRIMARY_URL is not set' };
  const dest = path.resolve(config.contentDir, path.basename(name));
  if (!dest.startsWith(path.resolve(config.contentDir))) return { ok: false, reason: 'bad name' };
  const staged = dest + '.part';
  const url = `${base}/uploads/content/${encodeURIComponent(path.basename(name))}`;
  let r;
  if (typeof expectedBytes === 'number' && expectedBytes > 0) {
    r = await downloadResumable({ url, stagedPath: staged, expectedBytes, fetchImpl });
  } else {
    r = await fetchWhole({ url, stagedPath: staged, fetchImpl });
  }
  if (!r.ok) { try { fs.unlinkSync(staged); } catch (e) { /* */ } return r; }
  if (digest && /^[0-9a-f]{64}$/.test(digest)) {
    let got = null;
    try { got = digestFileSync(staged); } catch (e) { got = null; }
    if (got !== digest) { try { fs.unlinkSync(staged); } catch (e) { /* */ } return { ok: false, reason: 'the bytes did not match the row\'s digest' }; }
  }
  try { fs.renameSync(staged, dest); } catch (e) { try { fs.unlinkSync(staged); } catch (e2) { /* */ } return { ok: false, reason: e && e.message }; }
  let bytes = 0;
  try { bytes = fs.statSync(dest).size; } catch (e) { bytes = 0; }
  return { ok: true, bytes };
}

/** A plain GET to a file for something whose size the row does not record (thumbnails). One attempt. */
async function fetchWhole({ url, stagedPath, fetchImpl }) {
  const doFetch = fetchImpl || global.fetch;
  if (!doFetch) return { ok: false, reason: 'This server cannot fetch content.' };
  fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
  let res;
  try {
    res = await doFetch(url, { redirect: 'error', signal: AbortSignal.timeout ? AbortSignal.timeout(120_000) : undefined });
  } catch (e) { return { ok: false, reason: (e && e.message) || 'the connection failed' }; }
  if (res.status === 404 || res.status === 410) return { ok: false, reason: 'That file is no longer available from the other server.' };
  if (!res.ok) return { ok: false, reason: `the other server answered ${res.status}` };
  try {
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(stagedPath, buf);
  } catch (e) { return { ok: false, reason: (e && e.message) || 'the transfer was interrupted' }; }
  return { ok: true };
}

/**
 * Make sure a copied content row's bytes are on this disk. Idempotent; a hit is a stat.
 * @returns {{ok:true, hit:boolean} | {ok:false, reason:string}}
 */
async function ensure(db, config, content, { fetchImpl, edge: edgeIn } = {}) {
  const edge = edgeIn || edgeForContent(db, content);
  if (!edge) return { ok: false, reason: 'not cacheable' };
  if (!content.filepath) return { ok: false, reason: 'no file' };
  const name = path.basename(content.filepath);
  const thumb = content.thumbnail_path ? path.basename(content.thumbnail_path) : null;
  const dest = path.resolve(config.contentDir, name);
  const have = db.prepare('SELECT * FROM mesh_content_cache WHERE content_id = ?').get(content.id);
  if (have && fs.existsSync(dest) && (!thumb || thumb === name || fs.existsSync(path.resolve(config.contentDir, thumb)))) {
    return { ok: true, hit: true };
  }
  const need = Number(content.file_size) || 0;
  /*
   * ⚠️ A 0-byte asset is refused on purpose. The primary's ingest never records one (the sniff
   * has nothing to sniff), so a copied row with file_size 0 is an old or broken row — and a cached
   * empty file would turn "hit" into "blank slot" while looking healthy. Serve through instead.
   */
  if (need <= 0) { setError(edge.id, `${name}: the row records no bytes; not cached`); return { ok: false, reason: 'empty asset' }; }
  const cap = config.replicaCacheBytes;
  if (!makeRoom(db, config.contentDir, edge.id, need, cap)) {
    setError(edge.id, `${name} (${need} bytes) does not fit the ${cap}-byte cache`);
    return { ok: false, reason: 'exceeds cache' };
  }
  let bytes = 0;
  if (!fs.existsSync(dest)) {
    // ⚠️ The size is enforced by the puller and the sha256 here — the SAME lib/content-digest
    // function the primary stored byte_digest with. A partial or altered body never gets the
    // basename: it stays a .part until the attempt chain ends, then is removed (fetchFile).
    const r = await fetchFile({ config, name, expectedBytes: need, digest: content.byte_digest, fetchImpl });
    if (!r.ok) { setError(edge.id, `${name}: ${r.reason}`); return { ok: false, reason: r.reason }; }
    bytes = r.bytes;
  } else {
    try { bytes = fs.statSync(dest).size; } catch (e) { bytes = 0; }
  }
  if (thumb && thumb !== name && !fs.existsSync(path.resolve(config.contentDir, thumb))) {
    // A missing thumbnail is not a missing asset: the dashboard shows a placeholder.
    const t = await fetchFile({ config, name: thumb, expectedBytes: null, digest: null, fetchImpl });
    if (t.ok) bytes += t.bytes;
  }
  db.prepare(`INSERT INTO mesh_content_cache (content_id, edge_id, filename, thumb_filename, bytes, fetched_at, last_read_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(content_id) DO UPDATE SET edge_id = excluded.edge_id, filename = excluded.filename, thumb_filename = excluded.thumb_filename,
                bytes = excluded.bytes, fetched_at = excluded.fetched_at, last_read_at = excluded.last_read_at`)
    .run(content.id, edge.id, name, thumb && thumb !== name ? thumb : null, bytes, nowSec(), nowSec());
  clearError(edge.id);
  return { ok: true, hit: false };
}

/* ------------------------------ sweeping ------------------------------ */

/**
 * Drop what no longer belongs: entries whose content row is gone (deleted on the primary), whose
 * row is no longer a copy, or whose edge no longer caches. Returns how many were dropped.
 */
function sweep(db, config) {
  let dropped = 0;
  let rows = [];
  try { rows = db.prepare('SELECT * FROM mesh_content_cache').all(); } catch (e) { return 0; }
  const edges = cachingEdges(db);
  for (const row of rows) {
    const edge = edges.find((e) => e.id === row.edge_id);
    let content = null;
    try { content = db.prepare('SELECT id, filepath, thumbnail_path, workspace_id FROM content WHERE id = ?').get(row.content_id); } catch (e) { content = null; }
    const stillCopied = content && edge && edgeForContent(db, content) && edgeForContent(db, content).id === edge.id;
    const renamed = content && path.basename(content.filepath || '') !== row.filename;
    if (!stillCopied || renamed) { dropEntry(db, config.contentDir, row); dropped++; }
  }
  return dropped;
}

/* ------------------------------ hits ------------------------------ */

const lastTouch = new Map();   // filename -> sec
function touch(db, name) {
  const t = nowSec();
  if ((lastTouch.get(name) || 0) > t - TOUCH_EVERY_S) return;
  lastTouch.set(name, t);
  try { db.prepare('UPDATE mesh_content_cache SET last_read_at = ? WHERE filename = ? OR thumb_filename = ?').run(t, name, name); } catch (e) { /* */ }
}

/* ------------------------------ status + errors ------------------------------ */

const lastError = new Map();   // edgeId -> string
function setError(edgeId, msg) { lastError.set(edgeId, String(msg).slice(0, 200)); }
function clearError(edgeId) { lastError.delete(edgeId); }

function status(db, config) {
  return cachingEdges(db).map((e) => {
    let files = 0, bytes = 0;
    try { const r = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM mesh_content_cache WHERE edge_id = ?').get(e.id); files = r.n; bytes = r.b; } catch (err) { /* */ }
    return { node_id: e.peer_node_id, files, bytes, pinned_bytes: pinnedBytes(db, e.id), cap_bytes: config.replicaCacheBytes,
             last_error: lastError.get(e.id) || null, prefetch_pending: queue.length };
  });
}

/* ------------------------------ prefetch worker (lazy) ------------------------------ */

const queue = [];
let worker = null;
let sweeper = null;
let busy = false;
let deps = null;

/**
 * ws/index hands in db/config once the mesh namespace is up. Creates NO timer: the worker starts on
 * the first cacheable row and a stock install never has one (test_replica_cache_absent_on_a_stock_install).
 */
function attach(d) { deps = d; }
function detach() {
  if (worker) clearInterval(worker); if (sweeper) clearInterval(sweeper);
  worker = null; sweeper = null; queue.length = 0; deps = null;
}

function startWorker() {
  if (worker || !deps) return;
  worker = setInterval(drain, 1000); if (worker.unref) worker.unref();
  sweeper = setInterval(() => { try { sweep(deps.db, deps.config); } catch (e) { /* */ } }, SWEEP_EVERY_MS); if (sweeper.unref) sweeper.unref();
}

async function drain() {
  if (busy || !deps || !queue.length) return;
  busy = true;
  try {
    const id = queue.shift();
    const content = deps.db.prepare('SELECT * FROM content WHERE id = ?').get(id);
    if (content) await ensure(deps.db, deps.config, content, { fetchImpl: deps.fetchImpl });
  } catch (e) { /* the next request fetches on demand */ }
  finally { busy = false; }
}

/**
 * Called by the replica loop after rows land: prefetch content of cached workspaces that is not
 * here yet, and drop what no longer belongs. A node with no caches-content edge does nothing —
 * not even create the timer.
 */
function onApplied(wsIds) {
  if (!deps) return;
  const edges = cachingEdges(deps.db);
  if (!edges.length) return;
  try { sweep(deps.db, deps.config); } catch (e) { /* */ }
  for (const wsId of wsIds || []) {
    let rows = [];
    try {
      rows = deps.db.prepare(`SELECT c.id FROM content c JOIN workspaces w ON w.id = c.workspace_id
                              WHERE c.workspace_id = ? AND w.origin_node_id IS NOT NULL AND c.filepath IS NOT NULL
                                AND c.id NOT IN (SELECT content_id FROM mesh_content_cache)`).all(wsId);
    } catch (e) { rows = []; }
    for (const r of rows) if (!queue.includes(r.id)) queue.push(r.id);
  }
  if (queue.length) startWorker();
}

function isWorkerRunning() { return !!worker; }

module.exports = {
  TOUCH_EVERY_S, cachesContent, cachingEdges, edgeForContent, contentForName,
  usedBytes, pinnedBytes, makeRoom, fetchFile, ensure, sweep, touch, status,
  attach, detach, onApplied, isWorkerRunning, _queue: queue,
};
