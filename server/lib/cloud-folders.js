'use strict';

/*
 * SharePoint / OneDrive folder sync (cloud_folders): a folder in the organization's Microsoft 365,
 * kept in step with the workspace content library — and, optionally, with a playlist of its own.
 *
 *   new file upstream      -> downloaded and added exactly like an upload (lib/content-ingest)
 *   changed file upstream  -> downloaded and REPLACED through lib/content-replace, so the item keeps
 *                             its id, its revision bumps and every screen's cached copy is evicted.
 *                             (Never written over in place: that would skip the revision bump.)
 *   file gone upstream     -> taken out of the folder's playlist, and deleted from the library if
 *                             nothing else uses it; kept (and unlinked from the sync) if something does
 *
 * Only images, video and audio are synced. Office files cannot be played as files — show those
 * with a cloud document widget and the file's Embed link (lib/cloud-docs.js). They are counted and
 * reported as skipped, so a folder of PowerPoints does not look like a sync that silently did nothing.
 *
 * Quotas: each file's size is known before it is downloaded, so it is refused up front against the
 * owner's plan (middleware/subscription storageRoomBytes) and the server's MAX_FILE_SIZE.
 *
 * Scale-out: a sync takes a short lease on its row (sync_lease_until), so two nodes never sync the
 * same folder at once. The lease is renewed after every file, and every renewal and the final clear
 * are conditional on sync_lease_until still holding the value THIS sync wrote: a sync that outlived
 * its lease (another node took the folder over) stops at the next file and leaves the row alone.
 *
 * Removal is the dangerous direction, so it runs only on a COMPLETE listing. A folder over
 * MAX_FILES media files, or one too long to page through, syncs its first MAX_FILES and removes
 * nothing; the summary says so.
 *
 * A sync runs as the person who set the folder up. If they can no longer write to the workspace, or
 * the workspace (or its organization) is gone, the folder is paused (enabled = 0) with the reason.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const m365 = require('./m365');

function dbOf() { return require('../db/database').db; }

const TICK_MS = 60 * 1000;
const LEASE_SEC = 15 * 60;
const MIN_INTERVAL_MIN = 5;
const MAX_INTERVAL_MIN = 24 * 60;
const DEFAULT_INTERVAL_MIN = 15;
let MAX_FILES = 500;            // media files per folder; _setMaxFiles in tests

let io = null;
let timer = null;
const running = new Set();

/* ============================== input ============================== */

function normaliseInput(body, existing = null) {
  const b = body || {};
  const out = {};
  if (!existing || b.name !== undefined) {
    const name = String(b.name || '').trim().slice(0, 120);
    if (!name && !existing) out.name = null;   // filled from the folder's own name
    else if (name) out.name = name;
  }
  if (!existing || b.interval_min !== undefined) {
    const n = Math.round(Number(b.interval_min ?? DEFAULT_INTERVAL_MIN));
    if (!Number.isFinite(n) || n < MIN_INTERVAL_MIN || n > MAX_INTERVAL_MIN) return { error: `Sync every ${MIN_INTERVAL_MIN} to ${MAX_INTERVAL_MIN} minutes.` };
    out.interval_min = n;
  }
  if (!existing || b.default_duration_sec !== undefined) {
    const d = Math.round(Number(b.default_duration_sec ?? 10));
    if (!Number.isFinite(d) || d < 1 || d > 86400) return { error: 'Image duration must be 1 to 86400 seconds.' };
    out.default_duration_sec = d;
  }
  if (b.enabled !== undefined) out.enabled = b.enabled ? 1 : 0;
  if (!existing || b.auto_playlist !== undefined) out.auto_playlist = b.auto_playlist === false || b.auto_playlist === 0 ? 0 : 1;
  return { fields: out };
}

function present(row) {
  let summary = null;
  try { summary = row.last_summary ? JSON.parse(row.last_summary) : null; } catch { summary = null; }
  return {
    id: row.id, name: row.name, provider: row.provider, share_url: row.share_url, web_url: row.web_url,
    playlist_id: row.playlist_id, auto_playlist: !!row.auto_playlist,
    interval_min: row.interval_min, default_duration_sec: row.default_duration_sec, enabled: !!row.enabled,
    last_sync_at: row.last_sync_at, last_status: row.last_status, last_error: row.last_error, last_summary: summary,
    file_count: (() => { try { return dbOf().prepare('SELECT COUNT(*) n FROM cloud_folder_items WHERE folder_id = ?').get(row.id).n; } catch { return 0; } })(),
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

/* ============================== playlist ============================== */

function ensurePlaylist(db, folder) {
  if (!folder.auto_playlist) return null;
  if (folder.playlist_id && db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(folder.playlist_id)) return folder.playlist_id;
  const id = require('./auto-playlist').createAutoGeneratedPlaylist(db, {
    name: `${folder.name} (SharePoint)`, workspaceId: folder.workspace_id, userId: folder.user_id,
    description: 'Kept in step with a SharePoint/OneDrive folder. Changes made here are overwritten by the next sync.',
  });
  db.prepare('UPDATE cloud_folders SET playlist_id = ? WHERE id = ?').run(id, folder.id);
  folder.playlist_id = id;
  return id;
}

/**
 * Make the folder's playlist hold exactly the synced items, in file-name order. Items a person added
 * by hand (other content, widgets) are kept, after the synced ones. Returns true if anything changed.
 */
function syncPlaylistItems(db, folder) {
  const pid = ensurePlaylist(db, folder);
  if (!pid) return false;
  const synced = db.prepare(`SELECT i.content_id, c.mime_type, c.duration_sec FROM cloud_folder_items i
    JOIN content c ON c.id = i.content_id WHERE i.folder_id = ? ORDER BY i.name COLLATE NOCASE, i.remote_id`).all(folder.id);
  const syncedIds = new Set(synced.map((r) => r.content_id));
  const allSynced = new Set(db.prepare('SELECT content_id FROM cloud_folder_items WHERE folder_id = ?').all(folder.id).map((r) => r.content_id));
  const current = db.prepare('SELECT id, content_id, widget_id, sort_order FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order, id').all(pid);
  const before = current.map((r) => `${r.content_id || ''}|${r.widget_id || ''}`).join(',');
  let changed = false;
  db.transaction(() => {
    // Drop items for files that left the folder (rows still pointing at content this sync owned once).
    const owned = new Set(db.prepare('SELECT content_id FROM cloud_folder_removed WHERE folder_id = ?').all(folder.id).map((r) => r.content_id));
    for (const r of current) {
      if (r.content_id && owned.has(r.content_id) && !syncedIds.has(r.content_id)) {
        db.prepare('DELETE FROM playlist_items WHERE id = ?').run(r.id);
      }
    }
    const left = db.prepare('SELECT id, content_id, widget_id FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order, id').all(pid);
    const have = new Map(left.filter((r) => r.content_id && allSynced.has(r.content_id)).map((r) => [r.content_id, r.id]));
    const manual = left.filter((r) => !(r.content_id && allSynced.has(r.content_id)));
    let order = 0;
    const ins = db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES (?, ?, ?, ?)');
    const setOrder = db.prepare('UPDATE playlist_items SET sort_order = ? WHERE id = ?');
    for (const s of synced) {
      const dur = s.mime_type && /^(video|audio)\//.test(s.mime_type) && s.duration_sec ? Math.max(1, Math.round(s.duration_sec)) : folder.default_duration_sec;
      if (have.has(s.content_id)) setOrder.run(order++, have.get(s.content_id));
      else ins.run(pid, s.content_id, order++, dur);
    }
    for (const m of manual) setOrder.run(order++, m.id);
  })();
  const after = db.prepare('SELECT content_id, widget_id FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order, id').all(pid)
    .map((r) => `${r.content_id || ''}|${r.widget_id || ''}`).join(',');
  changed = before !== after;
  return changed;
}

/** Publish the folder's playlist, unless the workspace requires review (then it waits as a draft). */
function publishIfAllowed(db, folder) {
  if (!folder.playlist_id) return 'none';
  try {
    if (require('./release-policy').approvalRequired(db, folder.workspace_id)) return 'pending_review';
    require('./releases').releasePlaylist(db, folder.playlist_id, io, { actor: { userId: null, kind: 'system', label: 'SharePoint sync' }, source: 'cloud-folder' });
    return 'published';
  } catch (e) {
    console.warn(`[cloud-folders] publish ${folder.id} failed: ${e && e.message}`);
    return 'publish_failed';
  }
}

/* ============================== sync ============================== */

/** Take the folder's lease. Returns the expiry written (this sync's token for it), or null if held. */
function takeLease(db, id) {
  const now = Math.floor(Date.now() / 1000);
  const r = db.prepare('UPDATE cloud_folders SET sync_lease_until = ? WHERE id = ? AND (sync_lease_until IS NULL OR sync_lease_until < ?)')
    .run(now + LEASE_SEC, id, now);
  return r.changes === 1 ? now + LEASE_SEC : null;
}
/**
 * Push the lease out again, but only if it is still ours. Returns the new expiry, or null if another
 * node has taken the folder over (ours ran out). A later taker always writes a later expiry than any
 * of ours (it can take only once ours is in the past), so the value is a safe holder token.
 */
function renewLease(db, id, held) {
  const until = Math.max(held, Math.floor(Date.now() / 1000) + LEASE_SEC);
  // Run even when the expiry would not move: the WHERE is the "still ours?" check.
  const r = db.prepare('UPDATE cloud_folders SET sync_lease_until = ? WHERE id = ? AND sync_lease_until = ?').run(until, id, held);
  return r.changes === 1 ? until : null;
}
function releaseLease(db, id, held) {
  try { db.prepare('UPDATE cloud_folders SET sync_lease_until = NULL WHERE id = ? AND sync_lease_until = ?').run(id, held); } catch { /* */ }
}

class LeaseLost extends Error {}

/** Pause a folder that can no longer sync, with the reason, so the poller stops picking it up. */
function pauseFolder(db, id, reason) {
  try { db.prepare("UPDATE cloud_folders SET enabled = 0, updated_at = strftime('%s','now') WHERE id = ?").run(id); } catch { /* */ }
  return new m365.M365Error(reason);
}

/**
 * Why this folder must not sync any more, or null. The workspace and its organization must still
 * exist (and still be the folder's), and the person it syncs as must still be able to write there:
 * a workspace editor or admin, or an owner/admin of the organization.
 */
function cannotSync(db, folder) {
  const ws = db.prepare('SELECT id, organization_id FROM workspaces WHERE id = ?').get(folder.workspace_id);
  if (!ws) return 'This folder\'s workspace no longer exists. The sync is paused.';
  if (ws.organization_id !== folder.organization_id || !db.prepare('SELECT 1 FROM organizations WHERE id = ?').get(folder.organization_id)) {
    return 'This folder\'s workspace is no longer in the organization it was set up in. The sync is paused.';
  }
  const owner = folder.user_id && db.prepare('SELECT id FROM users WHERE id = ?').get(folder.user_id);
  if (!owner) return 'The person who set up this folder no longer has an account. The sync is paused: remove it and have an organization admin add it again.';
  const wsRole = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(folder.workspace_id, folder.user_id);
  const orgRole = db.prepare('SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?').get(folder.organization_id, folder.user_id);
  const canWrite = (wsRole && wsRole.role !== 'workspace_viewer') || (orgRole && (orgRole.role === 'org_owner' || orgRole.role === 'org_admin'));
  if (!canWrite) return 'The person who set up this folder can no longer edit this workspace. The sync is paused: remove it and have an organization admin add it again.';
  return null;
}

function maxBytesFor(userId) {
  let room = null;
  try { room = require('../middleware/subscription').storageRoomBytes(userId); } catch { room = null; }
  return { room, cap: config.maxFileSize };
}

/** Delete a library item the sync created, if nothing outside its own playlist still uses it. */
function retireContent(db, folder, contentId) {
  const c = db.prepare('SELECT * FROM content WHERE id = ?').get(contentId);
  if (!c) return 'gone';
  const elsewhere = db.prepare('SELECT COUNT(*) n FROM playlist_items WHERE content_id = ? AND playlist_id IS NOT ?').get(contentId, folder.playlist_id || null).n
    + db.prepare('SELECT COUNT(*) n FROM playlists WHERE id IS NOT ? AND published_snapshot LIKE ?').get(folder.playlist_id || null, `%${contentId}%`).n
    + [['schedules', 'content_id'], ['video_walls', 'content_id'], ['devices', 'default_content_id'], ['assignments', 'content_id']]
      .reduce((n, [t, col]) => { try { return n + db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${col} = ?`).get(contentId).n; } catch { return n; } }, 0);
  if (elsewhere > 0) return 'kept';
  const purge = require('../routes/content').purgeContentRow;
  if (typeof purge !== 'function') return 'kept';
  const affected = db.transaction(() => purge(c))();
  require('./content-replace').pushDevices(io, affected || []);
  return 'deleted';
}

/**
 * Sync one folder now. Returns the summary it stored. Never throws for an upstream problem — it
 * records it on the row (last_status / last_error) — but does throw for "already syncing".
 */
async function syncFolder(folderId, { trigger = 'schedule' } = {}) {
  const db = dbOf();
  if (running.has(folderId)) { const e = new Error('This folder is already syncing.'); e.status = 409; throw e; }
  let lease = takeLease(db, folderId);
  if (!lease) { const e = new Error('This folder is already syncing.'); e.status = 409; throw e; }
  running.add(folderId);
  const summary = { trigger, added: 0, updated: 0, removed: 0, kept: 0, unchanged: 0, skipped_other: 0, skipped_too_large: 0, failed: 0, playlist: 'none', errors: [] };
  let status = 'ok';
  let lastError = null;
  let leaseLost = false;
  const heartbeat = () => { lease = renewLease(db, folderId, lease); if (!lease) throw new LeaseLost(); };
  try {
    const folder = db.prepare('SELECT * FROM cloud_folders WHERE id = ?').get(folderId);
    if (!folder) return null;
    const why = cannotSync(db, folder);
    if (why) throw pauseFolder(db, folder.id, why);

    const listing = await m365.listFolder(folder.organization_id, folder.drive_id, folder.item_id, { maxMedia: MAX_FILES + 1 });
    heartbeat();
    const allMedia = listing.files.filter((f) => f.media);
    const media = allMedia.slice(0, MAX_FILES);
    // Only a complete listing can say a file has gone; otherwise nothing is removed this time.
    const complete = listing.complete && allMedia.length <= MAX_FILES;
    summary.listing_complete = complete;
    if (allMedia.length > MAX_FILES) summary.errors.push(`Only the first ${MAX_FILES} media files are synced, and nothing is removed while the folder holds more.`);
    else if (!complete) summary.errors.push('The folder is too large to list in full, so nothing is removed this time.');
    summary.skipped_other = listing.files.filter((f) => !f.media).length;

    const mapped = new Map(db.prepare('SELECT * FROM cloud_folder_items WHERE folder_id = ?').all(folder.id).map((r) => [r.remote_id, r]));
    const actor = { userId: null, kind: 'system', label: 'SharePoint sync' };
    /*
     * WHO the bytes are written for (lib/content-replace.js `writer`): the folder's creator. Without
     * it the sync runs as system, and a synced file that head office later put in a corporate
     * playlist would be rewritten on every mandated screen from SharePoint — the same hole the Canva
     * sync had. A refused file is a per-file error in the summary; the rest of the folder syncs.
     */
    const ownerRow = db.prepare('SELECT id, role FROM users WHERE id = ?').get(folder.user_id);
    const writer = ownerRow ? require('./corporate/actor').fromUser(ownerRow) : null;
    const { ingestUploadedFile } = require('./content-ingest');
    const { replaceContentBytes } = require('./content-replace');

    for (const f of media) {
      const row = mapped.get(f.id);
      const live = row && db.prepare('SELECT * FROM content WHERE id = ?').get(row.content_id);
      if (row && live && row.tag === f.tag) {
        if (row.name !== f.name) db.prepare('UPDATE cloud_folder_items SET name = ? WHERE folder_id = ? AND remote_id = ?').run(f.name, folder.id, f.id);
        summary.unchanged++;
        continue;
      }
      const { room, cap } = maxBytesFor(folder.user_id);
      if ((cap && f.size > cap) || (room != null && f.size > room)) {
        summary.skipped_too_large++;
        if (summary.errors.length < 10) summary.errors.push(`${f.name}: ${cap && f.size > cap ? 'larger than this server accepts' : 'not enough storage left on the plan'}`);
        continue;
      }
      let tmp = null;
      try {
        tmp = await m365.downloadFile(folder.organization_id, folder.drive_id, f.id, { destDir: config.contentDir, maxBytes: Math.min(cap || Infinity, room == null ? Infinity : room) });
        const file = { path: tmp.path, size: tmp.size, originalname: f.name };
        if (row && live) {
          const r = await replaceContentBytes({ content: live, file, actor, writer, reqOrIo: io });
          if (r.status !== 200) throw new Error(r.body && r.body.error ? r.body.error : `replace failed (${r.status})`);
          db.prepare('UPDATE cloud_folder_items SET tag = ?, name = ?, size = ? WHERE folder_id = ? AND remote_id = ?').run(f.tag, f.name, f.size, folder.id, f.id);
          summary.updated++;
        } else {
          const content = await ingestUploadedFile({ file, userId: folder.user_id, workspaceId: folder.workspace_id });
          db.prepare(`INSERT INTO cloud_folder_items (folder_id, remote_id, content_id, name, tag, size) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(folder_id, remote_id) DO UPDATE SET content_id = excluded.content_id, name = excluded.name, tag = excluded.tag, size = excluded.size`)
            .run(folder.id, f.id, content.id, f.name, f.tag, f.size);
          summary.added++;
        }
      } catch (e) {
        summary.failed++;
        if (summary.errors.length < 10) summary.errors.push(`${f.name}: ${e && e.message}`);
      } finally {
        // ingest/replace rename the .part on success; anything left is ours to remove.
        if (tmp && fs.existsSync(tmp.path)) { try { fs.unlinkSync(tmp.path); } catch { /* */ } }
      }
      heartbeat();
    }

    // Files that left the folder — known only from a complete listing.
    const present = new Set(media.map((f) => f.id));
    for (const [remoteId, row] of complete ? mapped : []) {
      if (present.has(remoteId)) continue;
      db.prepare('DELETE FROM cloud_folder_items WHERE folder_id = ? AND remote_id = ?').run(folder.id, remoteId);
      db.prepare('INSERT OR IGNORE INTO cloud_folder_removed (folder_id, content_id) VALUES (?, ?)').run(folder.id, row.content_id);
      summary.removed++;
    }

    const changed = syncPlaylistItems(db, folder);
    // Retire removed content only after it has left the playlist.
    for (const r of db.prepare('SELECT content_id FROM cloud_folder_removed WHERE folder_id = ?').all(folder.id)) {
      const outcome = retireContent(db, folder, r.content_id);
      if (outcome === 'kept') summary.kept++;
      db.prepare('DELETE FROM cloud_folder_removed WHERE folder_id = ? AND content_id = ?').run(folder.id, r.content_id);
    }
    if (changed || summary.added || summary.removed) summary.playlist = publishIfAllowed(db, folder);
    if (summary.failed || summary.skipped_too_large) status = 'partial';
  } catch (e) {
    status = 'error';
    if (e instanceof LeaseLost) { leaseLost = true; lastError = 'This sync ran past its lease and another server took the folder over; it stopped.'; }
    else lastError = String((e && e.message) || e).slice(0, 500);
  } finally {
    // Only while the lease is still ours: a node that took the folder over records its own outcome.
    if (lease && !leaseLost) {
      try {
        db.prepare("UPDATE cloud_folders SET last_sync_at = strftime('%s','now'), last_status = ?, last_error = ?, last_summary = ?, sync_lease_until = NULL WHERE id = ? AND sync_lease_until = ?")
          .run(status, lastError, JSON.stringify(summary), folderId, lease);
      } catch { releaseLease(db, folderId, lease); }
    }
    running.delete(folderId);
  }
  return { status, error: lastError, summary };
}

/* ============================== create ============================== */

async function createFolder({ workspaceId, organizationId, userId, shareUrl, fields }) {
  const db = dbOf();
  const target = await m365.resolveFolder(organizationId, shareUrl);
  const dup = db.prepare('SELECT id FROM cloud_folders WHERE workspace_id = ? AND drive_id = ? AND item_id = ?').get(workspaceId, target.driveId, target.itemId);
  if (dup) { const e = new Error('This folder is already synced into this workspace.'); e.status = 409; throw e; }
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO cloud_folders (id, workspace_id, organization_id, user_id, provider, name, share_url, drive_id, item_id, web_url,
      interval_min, default_duration_sec, auto_playlist, enabled)
      VALUES (?, ?, ?, ?, 'm365', ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    .run(id, workspaceId, organizationId, userId, fields.name || target.name, m365.validateShareUrl(shareUrl), target.driveId, target.itemId,
      target.webUrl, fields.interval_min, fields.default_duration_sec, fields.auto_playlist);
  return db.prepare('SELECT * FROM cloud_folders WHERE id = ?').get(id);
}

/* ============================== poller ============================== */

function tick() {
  const db = dbOf();
  let due = [];
  try {
    due = db.prepare(`SELECT id FROM cloud_folders WHERE enabled = 1
      AND (last_sync_at IS NULL OR last_sync_at + interval_min * 60 <= strftime('%s','now'))
      AND (sync_lease_until IS NULL OR sync_lease_until < strftime('%s','now'))`).all();
  } catch { return; }
  for (const { id } of due) {
    if (running.has(id)) continue;
    syncFolder(id).catch((e) => { if (e && e.status !== 409) console.warn(`[cloud-folders] ${id}: ${e && e.message}`); });
  }
}

function start(ioRef) {
  io = ioRef || null;
  if (timer) return;
  timer = setInterval(() => { try { tick(); } catch (e) { console.warn(`[cloud-folders] tick: ${e && e.message}`); } }, TICK_MS);
  if (timer.unref) timer.unref();
}

function _setIo(ref) { io = ref || null; }
function _setMaxFiles(n) { MAX_FILES = n; }

module.exports = { normaliseInput, present, syncFolder, createFolder, syncPlaylistItems, start, tick, _setIo, MIN_INTERVAL_MIN, MAX_INTERVAL_MIN, _setMaxFiles };
