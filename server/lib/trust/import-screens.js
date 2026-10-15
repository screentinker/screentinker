'use strict';

/*
 * "Move your screens" — after an organization import (docs/move-server.md).
 *
 * An imported screen is a device row with no player behind it yet: offline, no device token (tokens
 * never leave a server), and a fresh enrolment key of THIS server. A player becomes it in one of
 * four ways, the first that applies:
 *
 *   1. Handover from the old server (both servers up, the old one on 3.0): the old server tells each
 *      connected player to switch address (the existing set_server_url command, #312), carrying this
 *      server's enrolment key for that screen. A web player arrives here already enrolled as the
 *      imported screen. An Android player switches, is told it is unknown here, asks for a pairing
 *      code — and the fingerprint it presents matches the imported screen's (device_fingerprints
 *      travels with the export), so it is handed the imported screen at once.
 *   2. The old server's own "Move to a new server" (any 3.x or 2.x): same switch; Android players
 *      rematch by fingerprint as above, web players show a pairing code (their old server's key
 *      means nothing here) — then 4.
 *   3. The enrolment link: open this server's /player?k=<key> on the screen (web players, kiosks).
 *   4. Pair into the imported screen: the screen shows a pairing code, the administrator types it
 *      on the screen's row here, and the new player takes over the imported screen's id —
 *      name, groups, playlist, schedules and settings — instead of becoming a new screen.
 *
 * The old server being gone changes only 1: nothing can tell its players to switch, so they keep
 * trying the dead address until someone points them at this one (DNS, or 3/4 by hand).
 */

const T = require('./import-tables');
const enrolKey = require('../enrol-key');

const HANDOVER_FORMAT = 'screentinker-screen-handover-v1';

/* Columns a player reports about itself: the new player's own values win when it takes a screen over. */
const PLAYER_OWNED = new Set([
  'id', 'pairing_code', 'device_token', 'enrol_key', 'status', 'last_heartbeat', 'ip_address', 'android_version', 'app_version',
  'screen_width', 'screen_height', 'client_type', 'client_version', 'platform', 'contract_version', 'hardware_model',
  'hardware_serial', 'hardware_os_version', 'hardware_edid', 'output_index', 'capabilities', 'tier', 'foreign_device_owner',
  'can_write_settings', 'accessibility_enabled', 'overlay_granted', 'media_volume', 'system_brightness', 'window_brightness',
  'screen_off_timeout_ms', 'reported_timezone', 'reported_utc', 'reported_at', 'offline_reason', 'offline_reason_at',
  'offline_detail', 'heartbeat_expected_by', 'created_at', 'render_width', 'render_height', 'ota_status', 'ota_target_version',
  'ota_attempts', 'ota_updated_at', 'ota_channel_served', 'attached_node_id', 'power_source', 'trigger_status',
  'trigger_status_at', 'claim_secret', 'view_token_hash', 'view_token_enc', 'screen_profile', 'reported_orientation', 'reported_board',
]);

function jobWorkspaces(db, job) {
  return db.prepare("SELECT new_id FROM org_import_ids WHERE job_id = ? AND tbl = 'workspaces'").all(job.id).map((r) => r.new_id)
    .filter((id) => db.prepare('SELECT 1 FROM workspaces WHERE id = ? AND organization_id = ?').get(id, job.organization_id));
}

/** The imported screens, with how each can be reached. `origin` is this server's public address. */
function listScreens(db, job, origin) {
  const ws = jobWorkspaces(db, job);
  if (!ws.length) return [];
  const source = new Map(db.prepare("SELECT old_id, new_id FROM org_import_ids WHERE job_id = ? AND tbl = 'devices'").all(job.id).map((r) => [r.new_id, r.old_id]));
  const rows = db.prepare(`SELECT d.id, d.name, d.status, d.client_type, d.platform, d.enrol_key, d.last_heartbeat, d.device_token IS NOT NULL AS claimed_by_player,
                                  w.name AS workspace_name
                             FROM devices d JOIN workspaces w ON w.id = d.workspace_id
                            WHERE d.workspace_id IN (${ws.map(() => '?').join(',')}) ORDER BY w.name, d.name`).all(...ws);
  const fp = db.prepare('SELECT COUNT(*) AS n FROM device_fingerprints WHERE device_id = ?');
  return rows.map((d) => ({
    id: d.id, name: d.name, workspace: d.workspace_name, status: d.status, client_type: d.client_type, platform: d.platform,
    moved: !!d.claimed_by_player, last_seen: d.last_heartbeat || null,
    source_id: source.get(d.id) || null,
    // Only this screen's own fingerprint lets an Android player rematch on its own.
    rematches_by_fingerprint: fp.get(d.id).n > 0,
    enrol_url: d.enrol_key ? enrolKey.playerUrl(origin, d.enrol_key) : null,
  }));
}

/**
 * The handover file the OLD server reads: this server's address and, per old screen id, the
 * enrolment key the screen should arrive with. It is a credential for those screens (anyone holding
 * it can enrol a player as them), so it is shown only to the organization's administrators and
 * should be deleted once used.
 */
function handoverDoc(db, job, origin, orgName) {
  const screens = listScreens(db, job, origin).filter((s) => s.source_id && !s.moved);
  const keys = new Map(db.prepare(`SELECT id, enrol_key FROM devices WHERE id IN (${screens.map(() => '?').join(',') || "''"})`).all(...screens.map((s) => s.id)).map((r) => [r.id, r.enrol_key]));
  return {
    format: HANDOVER_FORMAT,
    server: origin,
    organization: orgName || null,
    issued_at: new Date().toISOString(),
    screens: screens.map((s) => ({ source_id: s.source_id, name: s.name, enrol_key: keys.get(s.id) })).filter((s) => s.enrol_key),
  };
}

/*
 * SOURCE SIDE: send each screen of the caller's organization named in a handover file to the new
 * server. Uses the same command, the same capability checks and the same head office rules as
 * "Move to a new server" (lib/device-command.js deliverCommand); a screen not in the caller's
 * organization is ignored, whatever the file says.
 */
function applyHandover(db, { doc, orgId, deviceNs, actor, onlyIds = null }) {
  if (!doc || doc.format !== HANDOVER_FORMAT || !Array.isArray(doc.screens)) throw Object.assign(new Error('That is not a screen handover file from the new server.'), { status: 400, code: 'bad_handover' });
  const { validateCommand, deliverCommand } = require('../device-command');
  const url = String(doc.server || '').trim().replace(/\/+$/, '');
  const v = validateCommand('set_server_url', { url });
  if (!v.ok) throw Object.assign(new Error('The handover file names no valid server address.'), { status: 400, code: 'bad_handover' });
  const want = onlyIds ? new Set(onlyIds.map(String)) : null;
  const results = [];
  for (const s of doc.screens.slice(0, 5000)) {
    const id = String(s && s.source_id || '');
    if (!id || (want && !want.has(id))) continue;
    const device = db.prepare('SELECT d.* FROM devices d JOIN workspaces w ON w.id = d.workspace_id WHERE d.id = ? AND w.organization_id = ?').get(id, orgId);
    if (!device) { results.push({ device_id: id, status: 'not_found' }); continue; }
    const key = enrolKey.looksLikeEnrolKey(s.enrol_key) ? s.enrol_key : null;
    const r = deliverCommand(deviceNs, device, 'set_server_url', { url }, { actor, enrolKey: key });
    results.push({ device_id: id, name: device.name, status: r.status, ...(r.error ? { error: r.error } : {}) });
  }
  return { server: url, results, sent: results.filter((r) => r.status === 'sent' || r.status === 'relayed').length };
}

/*
 * DESTINATION SIDE: a player showing a pairing code takes over an imported screen. The new player's
 * row (made when it asked for a code) receives the imported screen's settings, every reference to the
 * imported screen is moved to it, and the imported row goes — so the screen keeps its name, groups,
 * walls, playlist, schedules and history, and the player keeps the identity it already holds.
 */
function pairInto(db, { importedId, code, orgId }) {
  const imported = db.prepare('SELECT d.* FROM devices d JOIN workspaces w ON w.id = d.workspace_id WHERE d.id = ? AND w.organization_id = ?').get(importedId, orgId);
  if (!imported) return { error: 'Screen not found', status: 404 };
  const prov = db.prepare('SELECT * FROM devices WHERE pairing_code = ?').get(String(code || ''));
  if (!prov) return { error: 'No screen is showing that pairing code', status: 404, guess: true };
  if (prov.user_id || prov.workspace_id) return { error: 'That pairing code belongs to a screen that is already in use', status: 409 };
  if (require('../pair-lockout').isCodeExpired(prov.last_heartbeat || prov.created_at)) return { error: 'Pairing code expired - restart the display to get a new code', status: 410 };

  const cols = db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name).filter((c) => !PLAYER_OWNED.has(c));
  const refs = deviceReferences(db);
  db.transaction(() => {
    db.pragma('defer_foreign_keys = ON');
    // The imported row's unique values are freed first, then given to the player's row.
    db.prepare('UPDATE devices SET enrol_key = NULL WHERE id = ?').run(imported.id);
    db.prepare(`UPDATE devices SET ${cols.map((c) => `"${c}" = ?`).join(', ')}, pairing_code = NULL, enrol_key = ?, updated_at = strftime('%s','now') WHERE id = ?`)
      .run(...cols.map((c) => imported[c]), enrolKey.generateEnrolKey(), prov.id);
    for (const { table, column, notnull } of refs) {
      try { db.prepare(`UPDATE OR IGNORE "${table}" SET "${column}" = ? WHERE "${column}" = ?`).run(prov.id, imported.id); } catch (_) { /* a table this build does not have */ }
      // What could not move (the player's row already had one of its own) is let go, as the
      // imported screen itself is about to be.
      try { db.prepare(notnull ? `DELETE FROM "${table}" WHERE "${column}" = ?` : `UPDATE "${table}" SET "${column}" = NULL WHERE "${column}" = ?`).run(imported.id); } catch (_) { /* */ }
    }
    try { db.prepare('UPDATE experiment_units SET device_ids = REPLACE(device_ids, ?, ?) WHERE device_ids LIKE ?').run(imported.id, prov.id, `%${imported.id}%`); } catch (_) { /* */ }
    db.prepare('DELETE FROM devices WHERE id = ?').run(imported.id);
  })();
  return { device: db.prepare('SELECT * FROM devices WHERE id = ?').get(prov.id), previous_id: imported.id };
}

/** Every column on this server that names a device: declared foreign keys, and the import's own list. */
function deviceReferences(db) {
  const out = [];
  const seen = new Set();
  const add = (table, column) => {
    const k = `${table}.${column}`;
    if (seen.has(k)) return;
    let info = null;
    try { info = db.prepare(`PRAGMA table_info("${table}")`).all().find((c) => c.name === column); } catch (_) { info = null; }
    if (!info) return;
    seen.add(k);
    out.push({ table, column, notnull: !!info.notnull || !!info.pk });
  };
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
    if (name === 'devices') continue;
    for (const f of db.prepare(`PRAGMA foreign_key_list("${name}")`).all()) if (f.table === 'devices') add(name, f.from);
  }
  for (const [table, cols] of Object.entries(T.REFS)) for (const [c, target] of Object.entries(cols)) if (target === 'devices' || target === '*') add(table, c);
  return out;
}

module.exports = { listScreens, handoverDoc, applyHandover, pairInto, deviceReferences, HANDOVER_FORMAT };
