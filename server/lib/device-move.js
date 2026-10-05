'use strict';

/*
 * Move screens to another workspace of the SAME organization (POST /api/devices/move-workspace).
 *
 * A workspace is a store, so moving a screen hands it to another store: everything the old store
 * attached to it stays with the old store, and the screen arrives with the new store's defaults.
 * Concretely, inside one transaction, per screen:
 *   - devices.workspace_id = the new workspace;
 *   - its group memberships and wall seat in the old workspace are dropped (groups and walls are
 *     workspace-scoped; a member of another workspace's group is a cross-tenant leak), and it stops
 *     leading any of them;
 *   - what the old store chose for it is cleared where it points into the old workspace: its own
 *     playlist / 'none' (it inherits in the new workspace), layout (templates are kept), default
 *     content, and the scheduler's columns (the new store's schedules apply on the next tick);
 *   - the old store's per-screen rows go: content schedules, power schedules, endpoints, trigger
 *     assignments, and head office slot content the OLD store filled for this one screen;
 *   - head office's own rows naming the screen (a device mandate, an emergency scope) stay: they
 *     are the organization's, and the organization does not change.
 * History (play logs, kiosk sessions, activity, alerts) stays with the store it happened in.
 *
 * ⚠️ The whole move runs inside corpGuard.assertNoMandateLoss, the one membership choke point: a
 * screen that would gain, lose or swap a head office mandate needs an org admin, and one that would
 * NEWLY come under head office lists the store triggers that stop showing there and needs
 * acknowledge_impact (409 CORPORATE_STORE_TRIGGERS_IMPACT). With no corporate machinery it is just
 * the transaction.
 */

const MAX_DEVICES = 200;

function dbOf() { return require('../db/database').db; }

function tableHas(db, table, column) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column); } catch (_) { return false; }
}

function run(db, sql, ...args) {
  try { return db.prepare(sql).run(...args).changes; } catch (e) {
    if (/no such (table|column)/i.test(String(e && e.message))) return 0;   // older schema / fixture
    throw e;
  }
}

/** Move one device row's workspace-scoped state; returns what was dropped (for the activity log). */
function moveOne(db, device, toWs) {
  const id = device.id;
  const from = device.workspace_id;
  const dropped = {};
  dropped.groups = run(db, 'DELETE FROM device_group_members WHERE device_id = ? AND group_id IN (SELECT id FROM device_groups WHERE workspace_id IS NOT ?)', id, toWs);
  run(db, 'UPDATE device_groups SET leader_device_id = NULL WHERE leader_device_id = ? AND workspace_id IS NOT ?', id, toWs);
  dropped.wall = run(db, 'DELETE FROM video_wall_devices WHERE device_id = ?', id);
  run(db, 'UPDATE video_walls SET leader_device_id = NULL WHERE leader_device_id = ?', id);
  dropped.schedules = run(db, 'DELETE FROM schedules WHERE device_id = ?', id);
  dropped.power_schedules = run(db, 'DELETE FROM display_power_schedules WHERE device_id = ?', id);
  dropped.endpoints = run(db, 'DELETE FROM device_endpoints WHERE device_id = ?', id);
  dropped.trigger_assignments = run(db, `DELETE FROM trigger_assignments WHERE target_type = 'device' AND target_id = ?
      AND trigger_id IN (SELECT t.id FROM triggers t WHERE t.workspace_id IS NOT ?)`, id, toWs);
  dropped.slot_content = run(db, "DELETE FROM corporate_slot_fills WHERE scope_kind = 'device' AND scope_id = ? AND workspace_id IS NOT ?", id, toWs);

  const sets = ['workspace_id = @to', 'wall_id = NULL'];
  // Its own playlist (or a deliberate 'none') was the old store's choice; it inherits in the new one.
  const pl = device.playlist_id ? db.prepare('SELECT workspace_id FROM playlists WHERE id = ?').get(device.playlist_id) : null;
  if (device.playlist_source === 'none' || (device.playlist_id && (!pl || pl.workspace_id !== toWs))) {
    sets.push('playlist_id = NULL'); dropped.playlist = 1;
    if (tableHas(db, 'devices', 'playlist_source')) sets.push('playlist_source = NULL');
  }
  if (device.layout_id) {
    const l = db.prepare('SELECT workspace_id, is_template FROM layouts WHERE id = ?').get(device.layout_id);
    if (!l || (!l.is_template && l.workspace_id !== toWs)) { sets.push('layout_id = NULL'); dropped.layout = 1; }
  }
  if (device.default_content_id) {
    const c = db.prepare('SELECT workspace_id FROM content WHERE id = ?').get(device.default_content_id);
    if (!c || (c.workspace_id && c.workspace_id !== toWs)) { sets.push('default_content_id = NULL'); dropped.default_content = 1; }
  }
  if (tableHas(db, 'devices', 'scheduled_playlist_id')) sets.push('scheduled_playlist_id = NULL', 'scheduled_layout_id = NULL');
  db.prepare(`UPDATE devices SET ${sets.join(', ')}, updated_at = strftime('%s','now') WHERE id = @id`).run({ id, to: toWs });
  for (const k of Object.keys(dropped)) if (!dropped[k]) delete dropped[k];
  return { device_id: id, from_workspace_id: from, dropped };
}

/**
 * Validate a move request. Returns { devices, target } or { status, error, code }.
 * The caller must be able to ADMIN every source workspace and the target workspace (an org admin
 * can; a workspace admin of both stores can); workspaces must be in the same organization.
 */
function validate(db, req, body) {
  const { canAdminWorkspace } = require('./permissions');
  if (req.viaToken) return { status: 403, error: 'Moving screens between workspaces needs a signed-in admin, not an API token' };
  const ids = Array.isArray(body.device_ids) ? [...new Set(body.device_ids.map(String))] : (body.device_id ? [String(body.device_id)] : []);
  if (!ids.length) return { status: 400, error: 'device_ids required' };
  if (ids.length > MAX_DEVICES) return { status: 400, error: `At most ${MAX_DEVICES} screens per move` };
  const toWsId = body.workspace_id ? String(body.workspace_id) : null;
  if (!toWsId) return { status: 400, error: 'workspace_id required' };
  const target = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(toWsId);
  if (!target) return { status: 404, error: 'Workspace not found' };
  if (!canAdminWorkspace(db, req.user, target)) return { status: 403, error: `You need to be an admin of "${target.name}" to move screens into it` };
  const guard = require('./corporate/guard');
  if (guard.isReplicatedWorkspace(db, target.id)) return { status: 409, error: `"${target.name}" is shared with another server, so its screens are managed there`, code: 'MOVE_REPLICATED' };
  const devices = [];
  for (const id of ids) {
    const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
    if (!d) return { status: 404, error: `Screen ${id} not found` };
    if (!d.workspace_id) return { status: 403, error: 'Device not assigned to a workspace' };
    if (d.workspace_id === target.id) continue;                 // already there: a no-op, not an error
    const src = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(d.workspace_id);
    if (!src || !canAdminWorkspace(db, req.user, src)) return { status: 403, error: `You need to be an admin of the workspace "${src ? src.name : ''}" that "${d.name}" is in` };
    if (src.organization_id !== target.organization_id) return { status: 400, error: 'Screens can only move between workspaces of the same organization', code: 'MOVE_OTHER_ORG' };
    if (guard.isReplicatedWorkspace(db, src.id)) return { status: 409, error: `"${src.name}" is shared with another server, so its screens are managed there`, code: 'MOVE_REPLICATED' };
    devices.push(d);
  }
  return { devices, target };
}

/** Do the move (call inside assertNoMandateLoss). Returns the per-screen results. */
function moveDevices(db, devices, toWsId) {
  db = db || dbOf();
  const out = [];
  db.transaction(() => { for (const d of devices) out.push(moveOne(db, d, toWsId)); })();
  return out;
}

/*
 * The store triggers that reach these screens NOW and will not after the move — every one of them
 * belongs to the workspace a screen leaves (triggers are workspace-scoped), so leaving the store
 * takes the screen off its triggers, an evacuation relay among them. Read with the current
 * store-trigger policy, so a trigger head office already hides here is not counted twice.
 */
function triggersLeaving(db, devices, toWsId) {
  const { triggersForDevice } = require('./device-triggers');
  const byTrigger = new Map();
  for (const d of devices) {
    let rows = [];
    try { rows = triggersForDevice(db, d.id, { skipEmergency: true }); } catch (_) { rows = []; }
    for (const t of rows) {
      if (t.workspace_id === toWsId) continue;
      const cur = byTrigger.get(t.id) || { trigger_id: t.id, name: t.name, workspace_id: t.workspace_id, mode: t.mode, screens: 0, reason: 'left_store' };
      cur.screens += 1;
      byTrigger.set(t.id, cur);
    }
  }
  const out = [...byTrigger.values()];
  for (const r of out) {
    try { r.workspace_name = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(r.workspace_id)?.name || ''; } catch (_) { r.workspace_name = ''; }
  }
  return out.sort((a, b) => (a.workspace_name || '').localeCompare(b.workspace_name || '') || (a.name || '').localeCompare(b.name || ''));
}

function mandateLabel(m) { return m ? (m.dark ? 'Turned off by head office' : (m.playlist_name || 'head office')) : null; }

/**
 * Run the move in a transaction that is ALWAYS rolled back and report what it would do: per screen
 * what is dropped, which head office playlist drives it before and after, the store triggers it
 * leaves behind (`leaving`) and the ones head office would hide in the new workspace (`hidden`).
 * The corporate membership guard runs inside it (dry run), so a move a store admin may not make is
 * refused HERE, before anyone is asked to acknowledge anything. Throws what the guard throws.
 */
function simulate(db, req, devices, target) {
  db = db || dbOf();
  const guard = require('./corporate/guard');
  const resolve = require('./corporate/resolve');
  const ROLLBACK = new Error('move-preview-rollback');
  let out = null;
  try {
    db.transaction(() => {
      const leaving = triggersLeaving(db, devices, target.id);
      const before = new Map(devices.map((d) => [d.id, resolve.mandateFor(db, d.id)]));
      req.corpMembershipImpact = null;
      const moved = guard.assertNoMandateLoss(req, devices.map((d) => d.id), () => moveDevices(db, devices, target.id),
        ({ name }) => `Moving this screen to "${target.name}" would change what it plays (head office's "${name || ''}"). Ask your organization admin to do it.`,
        { cause: 'move', dryRun: true });
      const imp = req.corpMembershipImpact || {};
      out = {
        screens: moved.map((m) => {
          const d = devices.find((x) => x.id === m.device_id);
          return {
            device_id: m.device_id, name: d && d.name, from_workspace_id: m.from_workspace_id, dropped: m.dropped,
            head_office_before: mandateLabel(before.get(m.device_id)), head_office_after: mandateLabel(resolve.mandateFor(db, m.device_id)),
          };
        }),
        leaving,
        hidden: (imp.store_triggers_hidden || []).map((i) => ({ ...i, reason: 'head_office' })),
        showing_again: imp.store_triggers_showing_again || 0,
      };
      throw ROLLBACK;
    })();
  } catch (e) { if (e !== ROLLBACK) throw e; }
  req.corpMembershipImpact = null;
  return out;
}

module.exports = { validate, moveDevices, simulate, triggersLeaving, MAX_DEVICES };
