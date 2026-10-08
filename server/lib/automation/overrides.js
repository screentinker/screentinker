'use strict';

/*
 * Temporary playlist overrides: "switch these screens to that playlist for N minutes", started by an
 * inbound hook or the Zapier action, and ended by the clock (or a matching "stop" call).
 *
 * The payload builder (ws/deviceSocket.js) asks overrideFor() after head office's emergency alert
 * and CAP alerts, so an emergency still outranks it, and never for a screen on a head office
 * (corporate) playlist: a store's automation must not be a way round a locked playlist.
 *
 * Scopes are workspace / group / device / tag. A tag is resolved to its screens when the override
 * starts, the way an operator reading "screens tagged lobby" would expect at that moment.
 */

const crypto = require('crypto');

function dbOf() { return require('../../db/database').db; }

const MAX_MINUTES = 24 * 60;
let clock = () => Math.floor(Date.now() / 1000);
let io = null;

function setIo(ref) { io = ref || null; }

/** Screens a scope list reaches, in this workspace. */
function devicesFor(db, workspaceId, scopes) {
  const ids = new Set();
  for (const s of scopes || []) {
    if (s.scope_kind === 'workspace') {
      for (const r of db.prepare('SELECT id FROM devices WHERE workspace_id = ?').all(workspaceId)) ids.add(r.id);
    } else if (s.scope_kind === 'group') {
      for (const r of db.prepare(`SELECT m.device_id AS id FROM device_group_members m JOIN devices d ON d.id = m.device_id
          WHERE m.group_id = ? AND d.workspace_id = ?`).all(s.scope_id, workspaceId)) ids.add(r.id);
    } else if (s.scope_kind === 'device') {
      if (db.prepare('SELECT 1 FROM devices WHERE id = ? AND workspace_id = ?').get(s.scope_id, workspaceId)) ids.add(s.scope_id);
    } else if (s.scope_kind === 'tag') {
      const tag = String(s.scope_id || '').replace(/^#/, '').toLowerCase();
      for (const r of db.prepare('SELECT id, tags FROM devices WHERE workspace_id = ? AND tags IS NOT NULL').all(workspaceId)) {
        let tags = [];
        try { tags = JSON.parse(r.tags || '[]'); } catch { tags = []; }
        if (Array.isArray(tags) && tags.some((t) => String(t).toLowerCase() === tag)) ids.add(r.id);
      }
    }
  }
  return [...ids];
}

function push(deviceIds) {
  if (!io || !deviceIds.length) return;
  try {
    const { buildPlaylistPayload } = require('../../ws/deviceSocket');
    const commandQueue = require('../command-queue');
    for (const id of new Set(deviceIds)) commandQueue.queueOrEmitPlaylistUpdate(io.of('/device'), id, buildPlaylistPayload);
  } catch (_) { /* the next payload build reads the same rows */ }
}

/**
 * Start an override. Screens are recorded one row each (a tag or group is resolved now). Returns
 * { id, devices, ends_at } or { error }.
 */
function start(db, { workspaceId, hookId = null, playlistId, minutes, scopes }) {
  const pl = db.prepare('SELECT id, published_snapshot FROM playlists WHERE id = ? AND workspace_id = ?').get(playlistId, workspaceId);
  if (!pl) return { error: 'playlist_id must be a playlist in this workspace' };
  if (!pl.published_snapshot) return { error: 'That playlist has not been published yet.' };
  const m = Math.max(1, Math.min(MAX_MINUTES, parseInt(minutes, 10) || 0));
  if (!parseInt(minutes, 10)) return { error: `minutes must be 1–${MAX_MINUTES}` };
  const devices = devicesFor(db, workspaceId, scopes);
  const now = clock();
  const id = crypto.randomUUID();
  const endsAt = now + m * 60;
  db.transaction(() => {
    // A new override from the same hook replaces its previous one, so "switch for 30 minutes" sent
    // twice is 30 minutes from the second call, not two overlapping rows.
    if (hookId) db.prepare('DELETE FROM automation_overrides WHERE hook_id = ?').run(hookId);
    const ins = db.prepare(`INSERT INTO automation_overrides (id, workspace_id, hook_id, scope_kind, scope_id, playlist_id, starts_at, ends_at)
      VALUES (?, ?, ?, 'device', ?, ?, ?, ?)`);
    for (const d of devices) ins.run(`${id}:${d}`, workspaceId, hookId, d, playlistId, now, endsAt);
  })();
  push(devices);
  return { id, devices: devices.length, ends_at: endsAt };
}

/** Stop a hook's override (or every override in a workspace scope list). Returns screens released. */
function stop(db, { workspaceId, hookId = null, scopes = null }) {
  let rows;
  if (hookId) rows = db.prepare('SELECT id, scope_id FROM automation_overrides WHERE hook_id = ? AND workspace_id = ?').all(hookId, workspaceId);
  else {
    const ids = new Set(devicesFor(db, workspaceId, scopes || [{ scope_kind: 'workspace' }]));
    rows = db.prepare('SELECT id, scope_id FROM automation_overrides WHERE workspace_id = ?').all(workspaceId).filter((r) => ids.has(r.scope_id));
  }
  const del = db.prepare('DELETE FROM automation_overrides WHERE id = ?');
  db.transaction(() => { for (const r of rows) del.run(r.id); })();
  const devices = [...new Set(rows.map((r) => r.scope_id))];
  push(devices);
  return devices.length;
}

/** The override this screen plays now, or null. One cheap indexed query. */
function overrideFor(db, deviceId) {
  const now = clock();
  const row = db.prepare(`SELECT o.* FROM automation_overrides o JOIN devices d ON d.id = o.scope_id AND d.workspace_id = o.workspace_id
    WHERE o.scope_id = ? AND o.starts_at <= ? AND o.ends_at > ? ORDER BY o.starts_at DESC LIMIT 1`).get(deviceId, now, now);
  if (!row) return null;
  const pl = db.prepare('SELECT published_snapshot, published_playback_order FROM playlists WHERE id = ? AND workspace_id = ?').get(row.playlist_id, row.workspace_id);
  let items = [];
  try { items = pl && pl.published_snapshot ? JSON.parse(pl.published_snapshot) : []; } catch { items = []; }
  if (!Array.isArray(items) || !items.length) return null;   // never switch a screen to nothing
  return { override: row, items, playback_order: (pl && pl.published_playback_order) || 'sequential' };
}

/** Expire overrides: delete ended rows and push the screens they held, so they go back on time. */
function tick(db = dbOf()) {
  const now = clock();
  const ended = db.prepare('SELECT id, scope_id FROM automation_overrides WHERE ends_at <= ?').all(now);
  if (!ended.length) return 0;
  const del = db.prepare('DELETE FROM automation_overrides WHERE id = ?');
  db.transaction(() => { for (const r of ended) del.run(r.id); })();
  push([...new Set(ended.map((r) => r.scope_id))]);
  return ended.length;
}

function _setClock(fn) { clock = fn || (() => Math.floor(Date.now() / 1000)); }

module.exports = { start, stop, overrideFor, tick, devicesFor, setIo, MAX_MINUTES, _setClock };
