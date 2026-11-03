'use strict';

/*
 * Site cache, ORIGIN side (docs/site-cache.md).
 *
 * A site cache is a small always-on box on a site's LAN (lib/site-cache/node.js). This module is
 * everything the origin knows about one: which screens it serves, the manifest of bytes those
 * screens need, what to put in a capable player's payload, and what the box last reported.
 *
 * THE ENTITLEMENT RULE, which every function here exists to hold:
 *
 *   A cache serves a screen only the bytes that screen's OWN payload references.
 *
 * Not "the workspace's library", not "anything the box happens to hold". The manifest is built by
 * running the same payload builder that feeds the screen (ws/deviceSocket buildPlaylistPayload), so
 * the cache's idea of entitlement cannot drift from what the screen actually plays. A corporate
 * item from head office on a store screen is entitled because it IS in that screen's payload; a file
 * from another workspace with a guessed sha256 is not, because no assigned screen's payload names it.
 *
 * Tenancy: a cache row belongs to one workspace. Assignments are validated against that workspace
 * when they are written AND re-checked when they are read (a device moved between workspaces keeps
 * no assignment — lib/device-move.js — but the read-side check is what makes a missed writer
 * harmless).
 *
 * ⚠️ The origin NEVER connects to `lan_url`. It is an address for SCREENS on the site's network,
 * typed by an admin, and fetching it from here would be an SSRF door into whatever network this
 * server sits on. The box dials out to us; we only ever answer it.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const tokens = require('./tokens');

/** How often a node polls its manifest. Sent to the node so one server-side change retunes a fleet. */
const POLL_SECONDS = 60;
/*
 * Player tokens live a week and are re-minted on every payload, so a screen that loses its origin
 * keeps using its cache for days. The expiry is BUCKETED to the day, so the token in a payload is
 * byte-stable across a day's pushes: nothing about a payload should churn on the clock alone.
 */
const TOKEN_TTL_SECONDS = 7 * 86400;
const TOKEN_BUCKET_SECONDS = 86400;
/** A node is "online" if it reported within this many poll intervals (plus slack). */
const ONLINE_POLLS = 3;
/*
 * The manifest a node just fetched is what its blob requests are checked against. The node's own
 * manifest request always rebuilds (fresh), so a playlist change reaches the box on its next poll.
 */
const MEMO_MS = 60_000;

const nowSec = () => Math.floor(Date.now() / 1000);

/* ------------------------------------------------------------------ input ------------------ */

/**
 * The address SCREENS will use for the box: http(s), a host, an optional port, nothing else.
 * A path, a query or credentials in it would be carried into every player's fetch URL, so they are
 * refused rather than stripped — an admin who typed one meant something we would not do.
 */
function validateLanUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { error: 'Enter the address screens use to reach the cache, for example http://10.0.0.5:8088.' };
  if (s.length > 200) return { error: 'That address is too long.' };
  let u;
  try { u = new URL(s); } catch (_) { return { error: 'That is not a valid address. Use the form http://10.0.0.5:8088.' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'The address must start with http:// or https://.' };
  if (!u.hostname) return { error: 'The address needs a host name or IP.' };
  if (u.username || u.password) return { error: 'The address must not contain a user name or password.' };
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) return { error: 'Enter only the scheme, host and port, with no path.' };
  return { url: `${u.protocol}//${u.host}` };
}

function normaliseInput(body, prev) {
  const b = body && typeof body === 'object' ? body : {};
  const fields = {};
  if (b.name !== undefined || !prev) {
    const name = String(b.name == null ? '' : b.name).trim();
    if (!name) return { error: 'Give the cache a name, for example "Main campus".' };
    if (name.length > 80) return { error: 'The name is too long (80 characters at most).' };
    fields.name = name;
  }
  if (b.lan_url !== undefined || !prev) {
    const v = validateLanUrl(b.lan_url);
    if (v.error) return { error: v.error };
    fields.lan_url = v.url;
  }
  if (b.enabled !== undefined) fields.enabled = b.enabled ? 1 : 0;
  return { fields };
}

/* ------------------------------------------------------------------ rows ------------------- */

function newNodeToken() { return 'stcn_' + crypto.randomBytes(32).toString('base64url'); }
function sealedKey() { return require('../secretbox').encrypt(crypto.randomBytes(32).toString('hex')); }

function createCache(db, { workspaceId, name, lanUrl, userId }) {
  const id = crypto.randomUUID();
  const token = newNodeToken();
  db.prepare(`INSERT INTO site_caches (id, workspace_id, name, lan_url, token_hash, fetch_key, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, workspaceId, name, lanUrl, tokens.hashSecret(token), sealedKey(), userId || null);
  forget(id);
  return { row: db.prepare('SELECT * FROM site_caches WHERE id = ?').get(id), token };
}

/**
 * New node token AND new fetch key. Both, because whoever held the old node token could read the
 * old fetch key out of the manifest and mint screen tokens with it; rotating only the first would
 * leave that door open. The caller re-pushes payloads so screens pick up tokens under the new key.
 */
function rotateSecrets(db, id) {
  const token = newNodeToken();
  db.prepare("UPDATE site_caches SET token_hash = ?, fetch_key = ?, updated_at = strftime('%s','now') WHERE id = ?")
    .run(tokens.hashSecret(token), sealedKey(), id);
  forget(id);
  return token;
}

function fetchKeyOf(row) {
  if (!row || !row.fetch_key) return null;
  return require('../secretbox').decrypt(row.fetch_key);
}

/** The cache row an `Authorization: Bearer stcn_…` header names, or null. Disabled rows still sign in. */
function authenticateNode(db, authHeader) {
  const m = /^Bearer\s+(stcn_[A-Za-z0-9_-]{20,100})\s*$/.exec(String(authHeader || ''));
  if (!m) return null;
  return db.prepare('SELECT * FROM site_caches WHERE token_hash = ?').get(tokens.hashSecret(m[1])) || null;
}

/* ------------------------------------------------------------------ assignment ------------- */

/**
 * The cache a screen uses, or null. DEVICE BEATS GROUP, like power schedules: a screen assigned
 * directly is decided by that row alone (a disabled cache there means "none", not "fall back to
 * the group's"), so an admin can take one screen off a group's cache without leaving the group.
 * Among several groups the lowest group id wins — deterministic, and the dashboard only offers one
 * cache per group so a real tie needs two groups with different caches.
 *
 * Every join re-checks the workspace: the cache, the group and the device must all be the same one.
 */
function cacheForDevice(db, deviceId, deviceWorkspaceId) {
  let wsId = deviceWorkspaceId;
  if (wsId === undefined) {
    const d = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(deviceId);
    if (!d) return null;
    wsId = d.workspace_id;
  }
  if (!wsId) return null;
  const direct = db.prepare(`SELECT c.* FROM site_cache_assignments a JOIN site_caches c ON c.id = a.site_cache_id
                              WHERE a.device_id = ? AND c.workspace_id = ? AND a.workspace_id = c.workspace_id`).get(deviceId, wsId);
  if (direct) return direct.enabled ? direct : null;
  const viaGroup = db.prepare(`SELECT c.* FROM site_cache_assignments a
                                 JOIN site_caches c ON c.id = a.site_cache_id
                                 JOIN device_groups g ON g.id = a.group_id
                                 JOIN device_group_members m ON m.group_id = a.group_id
                                WHERE m.device_id = ? AND c.workspace_id = ? AND g.workspace_id = c.workspace_id
                                  AND a.workspace_id = c.workspace_id
                                ORDER BY a.group_id ASC LIMIT 1`).get(deviceId, wsId);
  return viaGroup && viaGroup.enabled ? viaGroup : null;
}

/** Every screen this cache serves: candidates from its assignments, each confirmed by cacheForDevice. */
function devicesForCache(db, cache) {
  if (!cache || !cache.enabled) return [];
  const ids = db.prepare(`SELECT d.id, d.workspace_id FROM devices d
                           WHERE d.workspace_id = ? AND (
                             d.id IN (SELECT device_id FROM site_cache_assignments WHERE site_cache_id = ? AND device_id IS NOT NULL)
                             OR d.id IN (SELECT m.device_id FROM device_group_members m
                                           JOIN site_cache_assignments a ON a.group_id = m.group_id
                                          WHERE a.site_cache_id = ?))
                           ORDER BY d.id`).all(cache.workspace_id, cache.id, cache.id);
  return ids.filter((d) => {
    const c = cacheForDevice(db, d.id, d.workspace_id);
    return c && c.id === cache.id;
  }).map((d) => d.id);
}

function assignmentsOf(db, cacheId) {
  const rows = db.prepare('SELECT device_id, group_id FROM site_cache_assignments WHERE site_cache_id = ?').all(cacheId);
  return {
    device_ids: rows.filter((r) => r.device_id).map((r) => r.device_id),
    group_ids: rows.filter((r) => r.group_id).map((r) => r.group_id),
  };
}

/**
 * Replace this cache's assignments. Ids that are not in the cache's workspace are an error, not a
 * silent skip: the dashboard only offers this workspace's screens, so a foreign id is either a bug
 * or someone probing, and either way the caller should hear about it.
 *
 * A screen or group already on ANOTHER cache moves to this one (one cache per target is a database
 * rule). Returns every device whose effective cache may have changed, for the caller to re-push.
 */
function setAssignments(db, cache, { device_ids: deviceIds, group_ids: groupIds }) {
  const devs = [...new Set((Array.isArray(deviceIds) ? deviceIds : []).map(String))];
  const grps = [...new Set((Array.isArray(groupIds) ? groupIds : []).map(String))];
  if (devs.length > 5000 || grps.length > 1000) return { error: 'Too many screens or groups in one request.' };
  for (const id of devs) {
    const d = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(id);
    if (!d || d.workspace_id !== cache.workspace_id) return { error: 'One of those screens is not in this workspace.' };
  }
  for (const id of grps) {
    const g = db.prepare('SELECT workspace_id FROM device_groups WHERE id = ?').get(id);
    if (!g || g.workspace_id !== cache.workspace_id) return { error: 'One of those groups is not in this workspace.' };
  }
  const before = new Set(devicesForCache(db, cache));
  const touched = new Set(before);
  db.transaction(() => {
    // Screens currently served through a group or a direct row that is about to change.
    const oldRows = db.prepare('SELECT device_id, group_id FROM site_cache_assignments WHERE site_cache_id = ?').all(cache.id);
    for (const r of oldRows) {
      if (r.device_id) touched.add(r.device_id);
      if (r.group_id) for (const m of db.prepare('SELECT device_id FROM device_group_members WHERE group_id = ?').all(r.group_id)) touched.add(m.device_id);
    }
    db.prepare('DELETE FROM site_cache_assignments WHERE site_cache_id = ?').run(cache.id);
    const delDevice = db.prepare('DELETE FROM site_cache_assignments WHERE device_id = ?');
    const delGroup = db.prepare('DELETE FROM site_cache_assignments WHERE group_id = ?');
    const ins = db.prepare('INSERT INTO site_cache_assignments (id, site_cache_id, workspace_id, device_id, group_id) VALUES (?, ?, ?, ?, ?)');
    for (const id of devs) { delDevice.run(id); ins.run(crypto.randomUUID(), cache.id, cache.workspace_id, id, null); touched.add(id); }
    for (const id of grps) {
      delGroup.run(id);
      ins.run(crypto.randomUUID(), cache.id, cache.workspace_id, null, id);
      for (const m of db.prepare('SELECT device_id FROM device_group_members WHERE group_id = ?').all(id)) touched.add(m.device_id);
    }
  })();
  forgetAll();
  return { devices: [...touched] };
}

/* ------------------------------------------------------------------ what a screen needs ---- */

/** Every content id a payload can make a screen fetch: items, the standby image, trigger media. */
function contentIdsInPayload(payload) {
  const out = new Set();
  if (!payload || typeof payload !== 'object') return out;
  const add = (it) => {
    if (!it || typeof it !== 'object') return;
    if (it.content_id && !it.remote_url) out.add(String(it.content_id));
    // A slide's own photos and clips (ws/deviceSocket.js refreshWidgetRevs, lib/slide-media.js).
    if (Array.isArray(it.widget_media)) for (const m of it.widget_media) add(m);
  };
  for (const it of Array.isArray(payload.assignments) ? payload.assignments : []) add(it);
  // 3.0 campaigns: every zone and full-screen item a campaign step can show.
  for (const it of require('../campaign').campaignItems(payload.campaign)) add(it);
  add(payload.default_content);
  for (const t of Array.isArray(payload.triggers) ? payload.triggers : []) {
    for (const it of Array.isArray(t && t.items) ? t.items : []) add(it);
  }
  return out;
}

/**
 * Digest + size for content rows that have bytes we can vouch for. A row with no byte_digest yet is
 * left out (that screen fetches it from the origin as it always did) and queued for a lazy hash, so
 * the next manifest includes it. Remote/YouTube rows have no bytes here at all.
 */
function digestsFor(db, contentIds) {
  const out = new Map();
  const ids = [...contentIds];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const rows = db.prepare(`SELECT id, byte_digest, file_size, filepath, remote_url, mime_type FROM content
                              WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk);
    for (const r of rows) {
      if (!r.filepath || r.remote_url) continue;
      if (tokens.isSha256(r.byte_digest) && r.file_size > 0) {
        out.set(r.id, { sha256: r.byte_digest, size: r.file_size, mime_type: r.mime_type || null });
      } else {
        queueDigest(db, r);
      }
    }
  }
  return out;
}

/*
 * LAZY DIGEST BACKFILL. byte_digest is NULL on every row uploaded before 2.x content distribution,
 * and a site cache can only vouch for bytes it can name. Hashing every legacy file at boot would put
 * minutes of disk reads in front of the first heartbeat (lib/content-digest.js has the numbers), so
 * rows are hashed one at a time, streamed, and only when a site cache actually needs them.
 */
const digestQueue = [];
const digestQueued = new Set();
let digestRunning = false;
function queueDigest(db, row) {
  if (!row || !row.filepath || digestQueued.has(row.id) || digestQueued.size > 10000) return;
  let config;
  try { config = require('../../config'); } catch (_) { return; }
  const abs = path.join(config.contentDir, path.basename(String(row.filepath)));
  try { if (!fs.statSync(abs).isFile()) return; } catch (_) { return; }   // stored elsewhere: not ours to hash
  digestQueued.add(row.id);
  digestQueue.push({ id: row.id, abs });
  if (!digestRunning) runDigests(db);
}
async function runDigests(db) {
  digestRunning = true;
  const { digestFile } = require('../content-digest');
  try {
    while (digestQueue.length) {
      const job = digestQueue.shift();
      const hex = await digestFile(job.abs);
      // IS NULL guard: a replace that landed while we hashed has written the true digest of the NEW
      // bytes, and ours would be the digest of the file it replaced.
      if (hex) { try { db.prepare('UPDATE content SET byte_digest = ? WHERE id = ? AND byte_digest IS NULL').run(hex, job.id); } catch (_) { /* closed db in a test */ } }
      digestQueued.delete(job.id);
    }
  } finally { digestRunning = false; }
}

function defaultBuildPayload() {
  const fn = require('../../ws/deviceSocket').buildPlaylistPayload;
  return typeof fn === 'function' ? fn : null;
}

/*
 * The node's manifest: per screen, the digests it may fetch; and the set of files to pre-warm.
 * Memoised briefly because a node's blob requests are checked against the manifest it just pulled,
 * and rebuilding every screen's payload per blob would be the expensive way to answer the same
 * question.
 */
const memo = new Map();   // cacheId -> { at, manifest, shaToContent: Map, deviceShas: Map }
function forget(cacheId) { memo.delete(cacheId); }
function forgetAll() { memo.clear(); }

function manifestFor(db, cache, { buildPayload, fresh = false } = {}) {
  const hit = memo.get(cache.id);
  if (!fresh && hit && Date.now() - hit.at < MEMO_MS) return hit;
  const build = buildPayload || defaultBuildPayload();
  const devices = {};
  const files = new Map();          // sha -> { sha256, size }
  const shaToContent = new Map();   // sha -> content id (the row the blob route serves from)
  for (const deviceId of devicesForCache(db, cache)) {
    let payload = null;
    try { payload = build ? build(deviceId) : null; } catch (e) { payload = null; }
    // A suspended screen (plan limit) gets an empty payload, and so an empty entitlement.
    const digests = digestsFor(db, contentIdsInPayload(payload));
    const shas = [];
    for (const [cid, f] of digests) {
      shas.push(f.sha256);
      if (!files.has(f.sha256)) files.set(f.sha256, { sha256: f.sha256, size: f.size, mime_type: f.mime_type });
      if (!shaToContent.has(f.sha256)) shaToContent.set(f.sha256, cid);
    }
    devices[deviceId] = [...new Set(shas)].sort();
  }
  const fileList = [...files.values()].sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1));
  const manifest = {
    cache_id: cache.id,
    enabled: !!cache.enabled,
    poll_seconds: POLL_SECONDS,
    devices,
    files: fileList,
  };
  const entry = { at: Date.now(), manifest, shaToContent };
  memo.set(cache.id, entry);
  return entry;
}

/** The content row a node may download for `sha`, or null when no screen of this cache needs it. */
function contentForBlob(db, cache, sha, opts) {
  if (!tokens.isSha256(sha) || !cache.enabled) return null;
  const { shaToContent } = manifestFor(db, cache, opts);
  const cid = shaToContent.get(sha);
  if (!cid) return null;
  const row = db.prepare('SELECT * FROM content WHERE id = ?').get(cid);
  // Re-checked: the row could have been replaced (new bytes, new digest) since the memo was built.
  return row && row.byte_digest === sha ? row : null;
}

/* ------------------------------------------------------------------ the player payload ----- */

/**
 * What a CAPABLE player gets in its payload (top-level `site_cache`, outside the item list, so it
 * never enters the structural fingerprint and never restarts playback): where the box is, a token
 * for this screen, and the digest of each asset it may fetch from there. null when this screen has
 * no cache or nothing the cache could hold — and then the payload carries nothing new at all.
 */
function payloadFor(db, deviceId, device, payload, { now } = {}) {
  const cache = cacheForDevice(db, deviceId, device ? device.workspace_id : undefined);
  if (!cache || !cache.lan_url) return null;
  const key = fetchKeyOf(cache);
  if (!key) return null;
  const digests = digestsFor(db, contentIdsInPayload(payload));
  if (!digests.size) return null;
  const files = {};
  for (const [cid, f] of digests) files[cid] = { sha256: f.sha256, size: f.size };
  const t = now == null ? nowSec() : now;
  const exp = Math.ceil((t + TOKEN_TTL_SECONDS) / TOKEN_BUCKET_SECONDS) * TOKEN_BUCKET_SECONDS;
  return {
    id: cache.id,
    url: cache.lan_url,
    token: tokens.mintPlayerToken(key, { cacheId: cache.id, deviceId, exp }),
    expires_at: exp,
    files,
  };
}

/* ------------------------------------------------------------------ status ----------------- */

const int = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER) : null;
};
const text = (v, max) => (v == null ? null : String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) || null);

/** What a node said about itself. Display only: every number is clamped, every string bounded. */
function recordReport(db, cache, body) {
  const b = body && typeof body === 'object' ? body : {};
  const vals = {
    node_version: text(b.version, 40),
    disk_used: int(b.disk_used), disk_free: int(b.disk_free),
    files_held: int(b.files_held), files_wanted: int(b.files_wanted), bytes_wanted: int(b.bytes_wanted),
    hits: int(b.hits) ?? 0, misses: int(b.misses) ?? 0,
    bytes_served: int(b.bytes_served) ?? 0, bytes_from_origin: int(b.bytes_from_origin) ?? 0,
    last_sync_at: int(b.last_sync_at),
    last_error: text(b.last_error, 300),
  };
  db.prepare(`UPDATE site_caches SET last_seen_at = @seen, node_version = @node_version, disk_used = @disk_used,
               disk_free = @disk_free, files_held = @files_held, files_wanted = @files_wanted, bytes_wanted = @bytes_wanted,
               hits = @hits, misses = @misses, bytes_served = @bytes_served, bytes_from_origin = @bytes_from_origin,
               last_sync_at = @last_sync_at, last_error = @last_error WHERE id = @id`)
    .run({ ...vals, seen: nowSec(), id: cache.id });
}

function touchSeen(db, cache) {
  try { db.prepare('UPDATE site_caches SET last_seen_at = ? WHERE id = ?').run(nowSec(), cache.id); } catch (_) { /* display only */ }
}

/** The dashboard's view of a cache. Never the token hash, never the fetch key. */
function present(db, row) {
  const seen = row.last_seen_at || 0;
  const lookups = (row.hits || 0) + (row.misses || 0);
  return {
    id: row.id,
    name: row.name,
    lan_url: row.lan_url,
    enabled: !!row.enabled,
    created_at: row.created_at,
    online: !!seen && nowSec() - seen <= POLL_SECONDS * ONLINE_POLLS + 30,
    last_seen_at: row.last_seen_at || null,
    last_sync_at: row.last_sync_at || null,
    node_version: row.node_version || null,
    disk_used: row.disk_used, disk_free: row.disk_free,
    files_held: row.files_held, files_wanted: row.files_wanted, bytes_wanted: row.bytes_wanted,
    hits: row.hits || 0, misses: row.misses || 0,
    hit_rate: lookups ? (row.hits || 0) / lookups : null,
    bytes_served: row.bytes_served || 0,
    bytes_from_origin: row.bytes_from_origin || 0,
    // What the WAN did not carry: every byte a screen got from the box, less the one download the
    // box itself made of it.
    bytes_saved: Math.max(0, (row.bytes_served || 0) - (row.bytes_from_origin || 0)),
    last_error: row.last_error || null,
    assignments: assignmentsOf(db, row.id),
    screens: devicesForCache(db, row).length,
  };
}

module.exports = {
  POLL_SECONDS, TOKEN_TTL_SECONDS,
  validateLanUrl, normaliseInput,
  createCache, rotateSecrets, fetchKeyOf, authenticateNode,
  cacheForDevice, devicesForCache, assignmentsOf, setAssignments,
  contentIdsInPayload, digestsFor, manifestFor, contentForBlob, payloadFor,
  recordReport, touchSeen, present, forget, forgetAll,
  _digestIdle: () => !digestRunning && !digestQueue.length,
};
