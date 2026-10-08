'use strict';
// #150 — fingerprint-keyed device settings that survive device-row deletion.
//
// Delete + re-pair (Bold's MDM churn) mints a BRAND-NEW device row whose INSERT omits every
// per-device setting, so orientation/name/playlist/etc silently reset to defaults. This module
// snapshots a device's settings (keyed by its durable hardware/canvas fingerprint) at DELETE
// time, and re-applies them on the next re-pair for the SAME fingerprint — automatically and
// silently. The same apply path also backs the operator "re-adopt" action for the case where
// the fingerprint changed (factory reset / new hardware), see routes/devices.js.
//
// The table has NO FK to devices, so device deletion can't cascade it away. On workspace/user/
// org deletion the rows ARE purged (purgeWorkspaces) so settings can never bleed across tenants.
const { db } = require('../db/database');

const ORIENTATIONS = new Set(['landscape', 'portrait', 'landscape-flipped', 'portrait-flipped']);
const validOrientation = (o) => (ORIENTATIONS.has(o) ? o : 'landscape');

// The devices-row columns we preserve/restore (approved scope: orientation, name, timezone,
// notes, default_content_id, layout_id, playlist_id, blocked, team_id, tags). sort_order is out of
// scope by decision; wall membership (video_wall_devices grid geometry) is a deferred follow-up.
const _selDevice = db.prepare(
  `SELECT name, orientation, timezone, notes, default_content_id, layout_id, playlist_id,
          blocked, team_id, tags, workspace_id, last_heartbeat
     FROM devices WHERE id = ?`
);
const _fpForDevice = db.prepare(
  'SELECT fingerprint FROM device_fingerprints WHERE device_id = ? ORDER BY last_seen DESC LIMIT 1'
);
const _upsert = db.prepare(`
  INSERT INTO device_settings
    (fingerprint, workspace_id, device_name, orientation, timezone, notes, default_content_id,
     layout_id, playlist_id, blocked, team_id, tags, last_seen, removed_at)
  VALUES
    (@fingerprint, @workspace_id, @device_name, @orientation, @timezone, @notes, @default_content_id,
     @layout_id, @playlist_id, @blocked, @team_id, @tags, @last_seen, @removed_at)
  ON CONFLICT(fingerprint) DO UPDATE SET
    workspace_id=excluded.workspace_id, device_name=excluded.device_name, orientation=excluded.orientation,
    timezone=excluded.timezone, notes=excluded.notes, default_content_id=excluded.default_content_id,
    layout_id=excluded.layout_id, playlist_id=excluded.playlist_id, blocked=excluded.blocked,
    team_id=excluded.team_id, tags=excluded.tags, last_seen=excluded.last_seen, removed_at=excluded.removed_at
`);

// Snapshot a device's current settings keyed by its fingerprint, called BEFORE the row is
// deleted. No-op (returns null) if the device has no fingerprint link yet — a never-fully-
// provisioned device has no durable key and no user settings worth preserving. UPSERT keyed on
// fingerprint => repeated delete/re-pair cycles update one row, never duplicate.
function snapshot(deviceId, now = Math.floor(Date.now() / 1000)) {
  const d = _selDevice.get(deviceId);
  if (!d) return null;
  const fpRow = _fpForDevice.get(deviceId);
  if (!fpRow || !fpRow.fingerprint) return null;
  _upsert.run({
    fingerprint: fpRow.fingerprint,
    workspace_id: d.workspace_id || null,
    device_name: d.name || null,
    orientation: validOrientation(d.orientation),
    timezone: d.timezone || null,
    notes: d.notes || null,
    default_content_id: d.default_content_id || null,
    layout_id: d.layout_id || null,
    playlist_id: d.playlist_id || null,
    blocked: d.blocked ? 1 : 0,
    team_id: d.team_id || null,
    tags: d.tags || null,
    last_seen: d.last_heartbeat || now,
    removed_at: now,
  });
  return fpRow.fingerprint;
}

// Apply saved settings for `fingerprint` onto `deviceId`. Backs BOTH the automatic re-pair
// restore and the operator re-adopt. Orientation is enum-validated (invalid stored value ->
// landscape). FK settings (playlist/layout/default_content) are existence-guarded so a
// since-deleted target is skipped rather than written as a dangling id. Returns the applied
// snapshot row, or null if there was nothing to apply.
function applyToDevice(deviceId, fingerprint) {
  const s = db.prepare('SELECT * FROM device_settings WHERE fingerprint = ?').get(fingerprint);
  if (!s) return null;

  // A snapshot only ever applies inside the workspace it was taken in.
  //
  // The lookup keys on fingerprint alone, and a fingerprint is hardware-derived: the same panel
  // moved between customers presents the same one. Without this comparison, a screen deleted from
  // one workspace and paired into another inherited the FIRST workspace's playlist_id, blocked flag
  // and team_id — and the per-field guards below did not stop it, because they only check that the
  // referenced row still exists, never who it belongs to. The manual restore route already compares
  // workspaces before calling this (routes/devices.js), so the automatic re-pair path was the one
  // place the check was missing.
  //
  // Mismatch is a no-op, not an error: re-pairing a second-hand panel into a new workspace is a
  // legitimate thing to do, it just must not drag the previous owner's configuration along.
  const dev = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(deviceId);
  if (!dev) return null;
  // ⚠️ AUDIT F07: a row with NO workspace is never a restore target. The automatic re-pair path
  // used to call this on the freshly INSERTed provisioning row, which never has a workspace_id
  // (it only gets one at the claim), so the `dev.workspace_id &&` below short-circuited the guard
  // to "apply" on EVERY automatic restore: workspace A's playlist/layout/default content/team were
  // written onto the unclaimed row, the claim never cleared them, and tenant B's screen played A's
  // content. The restore now runs from the claim (restoreOnClaim), after workspace_id is set, where
  // the comparison below actually means something.
  if (!dev.workspace_id) return null;
  if (s.workspace_id && s.workspace_id !== dev.workspace_id) return null;
  const sets = [], vals = [];
  const put = (col, val) => { sets.push(`${col} = ?`); vals.push(val); };

  put('orientation', validOrientation(s.orientation));
  if (s.device_name != null) put('name', s.device_name);
  if (s.timezone != null) put('timezone', s.timezone);
  if (s.notes != null) put('notes', s.notes);
  put('blocked', s.blocked ? 1 : 0);          // security: a blocked device stays blocked across re-pair
  if (s.team_id != null) put('team_id', s.team_id);
  // Tags come back too, so a re-paired screen rejoins its dynamic groups (the claim reconciles).
  if (s.tags != null) put('tags', s.tags);
  // FK-existence guards — only restore if the referenced row still exists.
  if (s.playlist_id && db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(s.playlist_id)) put('playlist_id', s.playlist_id);
  if (s.layout_id && db.prepare('SELECT 1 FROM layouts WHERE id = ?').get(s.layout_id)) put('layout_id', s.layout_id);
  if (s.default_content_id && db.prepare('SELECT 1 FROM content WHERE id = ?').get(s.default_content_id)) put('default_content_id', s.default_content_id);
  // TODO #150 follow-up: wall membership (video_wall_devices grid geometry) is NOT restored —
  // it lives in a separate CASCADE-deleted table with grid positions. Deferred; note in release.

  vals.push(deviceId);
  db.prepare(`UPDATE devices SET ${sets.join(', ')}, updated_at = strftime('%s','now') WHERE id = ?`).run(...vals);
  return s;
}

// #150 automatic restore, run by the pairing CLAIM (/api/provision/pair) once the row has been
// moved into the claiming workspace. Looks up the fingerprint the device registered with (the
// provisioning path links it to the new row) and applies the snapshot — which applyToDevice only
// does when the snapshot was taken in that SAME workspace. Returns the applied snapshot or null.
function restoreOnClaim(deviceId) {
  const fpRow = _fpForDevice.get(deviceId);
  if (!fpRow || !fpRow.fingerprint) return null;
  return applyToDevice(deviceId, fpRow.fingerprint);
}

// The "previously removed devices" browser — snapshots for the given workspace(s).
function listRemoved(workspaceIds) {
  const ids = (Array.isArray(workspaceIds) ? workspaceIds : [workspaceIds]).filter(Boolean);
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  return db.prepare(
    `SELECT fingerprint, workspace_id, device_name, orientation, playlist_id, layout_id,
            timezone, blocked, last_seen, removed_at
       FROM device_settings WHERE workspace_id IN (${ph}) ORDER BY removed_at DESC`
  ).all(...ids);
}

function getByFingerprint(fingerprint) {
  return db.prepare('SELECT * FROM device_settings WHERE fingerprint = ?').get(fingerprint);
}

// Purge snapshots for whole workspaces (workspace/user/org deletion). Runs on the caller's
// db handle (user-deletion runs inside a transaction). Prevents cross-tenant settings bleed.
function purgeWorkspaces(dbConn, workspaceIds) {
  const ids = (workspaceIds || []).filter(Boolean);
  if (!ids.length) return 0;
  const ph = ids.map(() => '?').join(',');
  return (dbConn || db).prepare(`DELETE FROM device_settings WHERE workspace_id IN (${ph})`).run(...ids).changes;
}

/**
 * Mirror a device's blocked flag onto its SAVED settings.
 *
 * applyToDevice deliberately restores `blocked` across a re-pair, so a block cannot be shrugged off
 * by deleting the device. That is right — but it also means the saved copy is the real authority for
 * anything that outlives the device row, and unblocking used to touch only `devices`. The saved copy
 * stayed 1, so the very next delete-and-re-pair restored the block: from the operator's side, unblock
 * simply did not take, and there was no way out of it from the dashboard at all.
 *
 * No-ops when the device has no fingerprint yet (nothing to key the saved row on).
 */
function setBlockedByDevice(deviceId, blocked) {
  const fp = _fpForDevice.get(deviceId)?.fingerprint;
  if (!fp) return false;
  const r = db.prepare("UPDATE device_settings SET blocked = ?, last_seen = strftime('%s','now') WHERE fingerprint = ?")
    .run(blocked ? 1 : 0, fp);
  return r.changes > 0;
}

module.exports = { snapshot, applyToDevice, restoreOnClaim, listRemoved, getByFingerprint, purgeWorkspaces, setBlockedByDevice, validOrientation, ORIENTATIONS };
