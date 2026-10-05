'use strict';

/*
 * Move screens to another workspace (POST /api/devices/move-workspace) — of the SAME organization,
 * except for platform admins, who may also move screens to another organization (crossOrg below).
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
 * bring_playlist: the screen's OWN playlist (with its nested playlists, content, widgets...), its own
 * layout and default content are COPIED into the new workspace and kept on the screen, so it plays
 * exactly what it played (lib/device-bring.js says what counts and why it is a copy).
 *
 * Another organization (platform admins only, acknowledge_other_org): additionally the screen is
 * handed to the new organization's owner (devices.user_id — plan limits count by it) and the OLD
 * organization's head office rows naming it (a device mandate, an emergency scope, slot content)
 * go, because that organization no longer has it. Copied credentials are blanked.
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

/**
 * Move one device row's workspace-scoped state; returns what was dropped (for the activity log).
 * opts.bring: copy the screen's own playlist / layout / default content along (lib/device-bring.js).
 * opts.crossOrg: the screen changes ORGANIZATION (platform admins only): it is handed to the new
 * organization's owner, and the old organization's head office rows naming it go.
 */
function moveOne(db, device, toWs, opts = {}) {
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

  let brought = null;
  if (opts.bring) {
    const bringLib = require('./device-bring');
    const p = bringLib.plan(db, device, toWs, { crossOrg: !!opts.crossOrg });
    if (p) {
      const r = bringLib.apply(db, p, toWs, { userId: opts.ownerId, actorId: opts.actorId });
      if (opts.fileOps) opts.fileOps.push(...r.fileOps);
      const set = [];
      const args = [];
      if (r.playlist_id) { set.push('playlist_id = ?'); args.push(r.playlist_id); if (tableHas(db, 'devices', 'playlist_source')) set.push("playlist_source = 'device'"); delete dropped.playlist; }
      if (r.layout_id) { set.push('layout_id = ?'); args.push(r.layout_id); delete dropped.layout; }
      if (r.default_content_id) { set.push('default_content_id = ?'); args.push(r.default_content_id); delete dropped.default_content; }
      if (set.length) db.prepare(`UPDATE devices SET ${set.join(', ')} WHERE id = ?`).run(...args, id);
      brought = { ...p.summary, copied: r.copied, playlist_id: r.playlist_id, layout_id: r.layout_id, default_content_id: r.default_content_id };
    }
  }

  if (opts.crossOrg) {
    // The screen now belongs to the other organization: its owner (plan limits, ownership) and none
    // of the old organization's head office rows may follow it.
    if (opts.ownerId) db.prepare('UPDATE devices SET user_id = ?, team_id = NULL WHERE id = ?').run(opts.ownerId, id);
    dropped.head_office = run(db, "DELETE FROM corporate_mandates WHERE target_kind = 'device' AND target_id = ?", id)
      + run(db, "DELETE FROM emergency_trigger_scopes WHERE scope_kind = 'device' AND scope_id = ?", id)
      + run(db, "DELETE FROM corporate_slot_fills WHERE scope_kind = 'device' AND scope_id = ?", id);
  }
  for (const k of Object.keys(dropped)) if (!dropped[k]) delete dropped[k];
  return { device_id: id, from_workspace_id: from, dropped, ...(brought ? { brought } : {}) };
}

/** The new organization's owner (falls back to the earliest admin, then null). */
function orgOwnerOf(db, orgId) {
  try {
    const r = db.prepare(`SELECT user_id FROM organization_members WHERE organization_id = ?
        ORDER BY CASE role WHEN 'org_owner' THEN 0 WHEN 'org_admin' THEN 1 ELSE 2 END, joined_at ASC LIMIT 1`).get(orgId);
    return r ? r.user_id : null;
  } catch (_) { return null; }
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
  const { isPlatformRole } = require('../middleware/auth');
  let crossOrg = false;
  const fromOrgIds = new Set();
  const devices = [];
  for (const id of ids) {
    const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
    if (!d) return { status: 404, error: `Screen ${id} not found` };
    if (!d.workspace_id) return { status: 403, error: 'Device not assigned to a workspace' };
    if (d.workspace_id === target.id) continue;                 // already there: a no-op, not an error
    const src = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(d.workspace_id);
    if (!src || !canAdminWorkspace(db, req.user, src)) return { status: 403, error: `You need to be an admin of the workspace "${src ? src.name : ''}" that "${d.name}" is in` };
    if (src.organization_id !== target.organization_id) {
      // ⚠️ Only the platform's own admins move screens BETWEEN organizations (an org admin of both is
      // not enough: a screen and everything copied with it would change tenant on one person's say).
      if (!isPlatformRole(req.user && req.user.role)) return { status: 400, error: 'Screens can only move between workspaces of the same organization', code: 'MOVE_OTHER_ORG' };
      crossOrg = true;
      fromOrgIds.add(src.organization_id);
    }
    if (guard.isReplicatedWorkspace(db, src.id)) return { status: 409, error: `"${src.name}" is shared with another server, so its screens are managed there`, code: 'MOVE_REPLICATED' };
    devices.push(d);
  }
  if (crossOrg && devices.some((d) => {
    const w = db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(d.workspace_id);
    return w && w.organization_id === target.organization_id;
  })) {
    // One move, one meaning: a selection mixing same-org and other-org screens would need two
    // different confirmations for one button.
    return { status: 400, error: 'Move screens from another organization separately from screens of this one', code: 'MOVE_MIXED_ORGS' };
  }
  const targetOrg = db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(target.organization_id) || { id: target.organization_id, name: '' };
  return {
    devices, target, crossOrg, targetOrg,
    fromOrgIds: [...fromOrgIds],
    ownerId: crossOrg ? (orgOwnerOf(db, target.organization_id) || (req.user && req.user.id)) : null,
    bring: body.bring_playlist === true || body.bring_playlist === 1 || body.bring_playlist === '1' || body.bring_playlist === 'true',
    actorId: req.user && req.user.id,
  };
}

/**
 * Do the move (call inside assertNoMandateLoss). Returns the per-screen results.
 * opts: { bring, crossOrg, ownerId, actorId, fileOps } — fileOps collects the filesystem copies to
 * run once the transaction has committed (device-bring.runFileOps).
 */
function moveDevices(db, devices, toWsId, opts = {}) {
  db = db || dbOf();
  const out = [];
  db.transaction(() => { for (const d of devices) out.push(moveOne(db, d, toWsId, opts)); })();
  return out;
}

/*
 * What a "bring its playlist" move would charge against storage, refused BEFORE anything is
 * written when a plan cannot hold it. Bytes on disk are shared (refcounted), but storage allowances
 * count content rows, so a copy counts — that is what the allowance measures everywhere else.
 * Returns null (fine) or { status, error, code }.
 */
function bringBudget(db, v) {
  if (!v.bring) return null;
  const bringLib = require('./device-bring');
  const perUser = new Map();
  for (const d of v.devices) {
    const p = bringLib.plan(db, d, v.target.id, { crossOrg: v.crossOrg });
    if (!p) continue;
    for (const c of p.content.values()) {
      const u = v.crossOrg ? v.ownerId : c.user_id;
      if (!u) continue;
      perUser.set(u, (perUser.get(u) || 0) + (Number(c.file_size) || 0));
    }
  }
  let sub = null;
  try { sub = require('../middleware/subscription'); } catch (_) { return null; }
  for (const [u, bytes] of perUser) {
    if (!bytes) continue;
    let room = null;
    try { room = sub.storageRoomBytes(u); } catch (_) { room = null; }
    if (room != null && bytes > room) {
      const mb = (n) => Math.ceil(Math.max(0, n) / (1024 * 1024));
      return { status: 403, code: 'STORAGE_LIMIT',
        error: `Copying this screen's playlist needs ${mb(bytes)} MB of storage and the account it is copied to has ${mb(room)} MB left. Move it without its playlist, or free some space first.` };
    }
  }
  return null;
}

/*
 * Plan limits for a move into another organization (preview only): the screens join the new
 * owner's account. A platform admin may move past the limit — it is the platform's own decision —
 * but is told so first.
 */
function planWarning(db, v) {
  if (!v.crossOrg || !v.ownerId) return null;
  let sub = null;
  try { sub = require('../middleware/subscription'); } catch (_) { return null; }
  let plan = null;
  try { plan = sub.getUserPlan(v.ownerId); } catch (_) { plan = null; }
  if (!plan || plan.max_devices == null || plan.max_devices === -1) return null;
  let current = 0;
  try { current = db.prepare('SELECT COUNT(*) AS n FROM devices WHERE user_id = ?').get(v.ownerId).n; } catch (_) { current = 0; }
  const after = current + v.devices.length;
  if (after <= plan.max_devices) return null;
  return { devices_after: after, devices_limit: plan.max_devices, plan: plan.plan_display_name || plan.plan_name || '' };
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
function simulate(db, req, devices, target, opts = {}) {
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
      const moved = guard.assertNoMandateLoss(req, devices.map((d) => d.id), () => moveDevices(db, devices, target.id, { ...opts, fileOps: [] }),
        ({ name }) => `Moving this screen to "${target.name}" would change what it plays (head office's "${name || ''}"). Ask your organization admin to do it.`,
        { cause: 'move', dryRun: true });
      const imp = req.corpMembershipImpact || {};
      out = {
        screens: moved.map((m) => {
          const d = devices.find((x) => x.id === m.device_id);
          return {
            device_id: m.device_id, name: d && d.name, from_workspace_id: m.from_workspace_id, dropped: m.dropped,
            ...(m.brought ? { brought: m.brought } : {}),
            has_own: !!(d && (require('./device-bring').ownPlaylistOf(db, d))),
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

module.exports = { validate, moveDevices, simulate, triggersLeaving, bringBudget, planWarning, orgOwnerOf, MAX_DEVICES };
