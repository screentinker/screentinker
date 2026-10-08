'use strict';

/*
 * Dynamic device groups: a group whose membership comes from rules over device fields.
 *
 * ⚠️ MEMBERSHIP IS MATERIALISED, NOT EVALUATED AT READ TIME. Every consumer of a group (playlist
 * inheritance views, schedules, triggers, emergency scopes, corporate mandates, group sync, power
 * schedules, endpoints, PiP, talk) reads device_group_members with a live join. Teaching each of
 * them to evaluate rules would be twenty places to keep in step, so instead this module keeps the
 * membership rows equal to what the rules say, and every consumer keeps working unchanged. The
 * rows are rewritten whenever an input changes (a device's tags or name, a group's rules, pairing,
 * a wall or workspace move) and a sweep catches anything that changed by another path (import,
 * mesh replication).
 *
 * WHO NEVER MATCHES: a screen on a video wall (a wall member is never in a group — joining a wall
 * deletes its memberships, routes/video-walls.js), and a screen in another workspace.
 *
 * Callers decide the corporate question, not this module: an operator's edit is wrapped in
 * corpGuard.assertNoMandateLoss as that operator, while pairing, moves and the sweep run as the
 * system, because there the membership follows rules someone already set.
 */

const { normalizeTags, parseTags } = require('./content-tags');

const FIELDS = {
  tag: ['has', 'lacks'],
  name: ['contains', 'starts_with', 'eq'],
  platform: ['eq', 'neq'],
  timezone: ['eq', 'neq'],
};
const MAX_RULES = 20;
const MAX_VALUE = 80;

/**
 * undefined = not given (leave as is); null = clear (a hand-built group again); an object =
 * the normalised rule set; false = invalid. Mirrors lib/smart-playlist.js's normalizer shape.
 */
function normalizeRules(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  let obj = v;
  if (typeof v === 'string') { try { obj = JSON.parse(v); } catch { return false; } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const match = obj.match == null ? 'all' : obj.match;
  if (match !== 'all' && match !== 'any') return false;
  if (!Array.isArray(obj.rules) || obj.rules.length === 0 || obj.rules.length > MAX_RULES) return false;
  const rules = [];
  for (const r of obj.rules) {
    if (!r || typeof r !== 'object') return false;
    const ops = FIELDS[r.field];
    if (!ops || !ops.includes(r.op)) return false;
    let value = r.value == null ? '' : String(r.value).trim().slice(0, MAX_VALUE);
    if (r.field === 'tag') {
      const t = normalizeTags([value]);
      if (!t || !t.length) return false;
      value = t[0];
    }
    if (!value) return false;
    rules.push({ field: r.field, op: r.op, value });
  }
  return { match, rules };
}

function parseRules(raw) {
  if (!raw) return null;
  const r = normalizeRules(typeof raw === 'string' ? raw : JSON.stringify(raw));
  return r || null;
}

function ruleMatches(device, r) {
  switch (r.field) {
    case 'tag': {
      const has = parseTags(device.tags).includes(r.value);
      return r.op === 'has' ? has : !has;
    }
    case 'name': {
      const n = String(device.name || '').toLowerCase();
      const v = r.value.toLowerCase();
      if (r.op === 'contains') return n.includes(v);
      if (r.op === 'starts_with') return n.startsWith(v);
      return n === v;
    }
    case 'platform':
    case 'timezone': {
      const eq = String(device[r.field] || '').toLowerCase() === r.value.toLowerCase();
      return r.op === 'eq' ? eq : !eq;
    }
    default: return false;
  }
}

/** Pure: does this device row satisfy the rule set? */
function deviceMatches(device, rules) {
  if (!device || !rules || !rules.rules || !rules.rules.length) return false;
  return rules.match === 'any'
    ? rules.rules.some((r) => ruleMatches(device, r))
    : rules.rules.every((r) => ruleMatches(device, r));
}

const DEVICE_COLS = 'd.id, d.name, d.tags, d.platform, d.timezone, d.workspace_id';

function onWall(db, deviceId) {
  return !!db.prepare('SELECT 1 FROM video_wall_devices WHERE device_id = ?').get(deviceId);
}

/**
 * What membership a dynamic group SHOULD have against what it has. `rules` overrides the stored
 * rules (for planning a change before it is saved). Returns { add, remove } of device ids.
 */
function planGroup(db, group, rules = parseRules(group.rules)) {
  if (!rules) return { add: [], remove: [] };
  const candidates = db.prepare(`SELECT ${DEVICE_COLS} FROM devices d
    WHERE d.workspace_id = ? AND d.id NOT IN (SELECT device_id FROM video_wall_devices)`).all(group.workspace_id);
  const want = new Set(candidates.filter((d) => deviceMatches(d, rules)).map((d) => d.id));
  const have = new Set(db.prepare('SELECT device_id FROM device_group_members WHERE group_id = ?')
    .all(group.id).map((r) => r.device_id));
  return {
    add: [...want].filter((id) => !have.has(id)),
    remove: [...have].filter((id) => !want.has(id)),
  };
}

/**
 * Every dynamic group in the device's workspace that this device should join or leave. `overrides`
 * are field values not yet written (a PUT being planned). Returns [{ group, op: 'add'|'remove' }].
 */
function planDevice(db, deviceId, overrides = {}) {
  const row = db.prepare(`SELECT ${DEVICE_COLS} FROM devices d WHERE d.id = ?`).get(deviceId);
  if (!row) return [];
  const device = { ...row, ...overrides };
  const walled = onWall(db, deviceId);
  const groups = db.prepare('SELECT * FROM device_groups WHERE workspace_id = ? AND rules IS NOT NULL').all(device.workspace_id);
  const out = [];
  for (const g of groups) {
    const rules = parseRules(g.rules);
    if (!rules) continue;
    const want = !walled && deviceMatches(device, rules);
    const have = !!db.prepare('SELECT 1 FROM device_group_members WHERE group_id = ? AND device_id = ?').get(g.id, deviceId);
    if (want && !have) out.push({ group: g, op: 'add', deviceId });
    if (!want && have) out.push({ group: g, op: 'remove', deviceId });
  }
  // A device moved out of the workspace keeps no membership of a dynamic group left behind.
  for (const g of db.prepare(`SELECT g.* FROM device_groups g JOIN device_group_members m ON m.group_id = g.id
      WHERE m.device_id = ? AND g.rules IS NOT NULL AND g.workspace_id IS NOT ?`).all(deviceId, device.workspace_id)) {
    out.push({ group: g, op: 'remove', deviceId });
  }
  return out;
}

/** The ops of planGroup in the planDevice shape. */
function groupOps(group, plan) {
  return [
    ...plan.add.map((deviceId) => ({ group, op: 'add', deviceId })),
    ...plan.remove.map((deviceId) => ({ group, op: 'remove', deviceId })),
  ];
}

/** Write the membership rows. Call inside the caller's guard / transaction. */
function applyOps(db, ops) {
  const { clearInheritedCopy } = require('./resolve-device-playlist');
  const ins = db.prepare('INSERT OR IGNORE INTO device_group_members (device_id, group_id) VALUES (?, ?)');
  const del = db.prepare('DELETE FROM device_group_members WHERE device_id = ? AND group_id = ?');
  for (const o of ops) {
    if (o.op === 'add') ins.run(o.deviceId, o.group.id);
    else {
      del.run(o.deviceId, o.group.id);
      // Same as a manual removal: a leftover copy of the group's playlist must not outlive it.
      clearInheritedCopy(o.deviceId);
      // A leader that left a sync group stops being its pinned leader.
      db.prepare('UPDATE device_groups SET leader_device_id = NULL WHERE id = ? AND leader_device_id = ?').run(o.group.id, o.deviceId);
    }
  }
}

/**
 * Who needs a fresh payload: every device whose membership changed, plus the remaining members of
 * any SYNC group that changed — their peer list and leader flag ride in the same payload, and a
 * peer that is not re-pushed keeps syncing against a member that left.
 */
function devicesToPush(db, ops) {
  const ids = new Set(ops.map((o) => o.deviceId));
  for (const g of new Map(ops.map((o) => [o.group.id, o.group])).values()) {
    const fresh = db.prepare('SELECT sync_enabled FROM device_groups WHERE id = ?').get(g.id);
    if (!fresh || !fresh.sync_enabled) continue;
    for (const r of db.prepare('SELECT device_id FROM device_group_members WHERE group_id = ?').all(g.id)) ids.add(r.device_id);
  }
  return [...ids];
}

function pushTo(io, deviceIds) {
  if (!io || !deviceIds.length) return;
  try {
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    const commandQueue = require('./command-queue');
    for (const id of deviceIds) commandQueue.queueOrEmitPlaylistUpdate(io.of('/device'), id, buildPlaylistPayload);
  } catch (e) { /* best effort: the DB is the source of truth */ }
}

/**
 * Bring one device's dynamic memberships up to date AS THE SYSTEM (pairing, wall leave, workspace
 * move). Membership here follows rules an operator already set, so no one is prompted; the
 * corporate guard still records what changed. Never throws. Returns the ops applied.
 */
function reconcileDeviceAsSystem(db, io, deviceId) {
  try {
    const actor = require('./corporate/actor');
    const corpGuard = require('./corporate/guard');
    return actor.runAsSystem(() => {
      const ops = planDevice(db, deviceId);
      if (!ops.length) return [];
      corpGuard.assertNoMandateLoss(null, [deviceId], () => { applyOps(db, ops); return true; });
      pushTo(io, devicesToPush(db, ops));
      return ops;
    });
  } catch (e) {
    console.warn(`[groups] dynamic membership for ${deviceId} not updated: ${e.message}`);
    return [];
  }
}

/** The sweep: every dynamic group, as the system. Returns the number of membership rows changed. */
function sweep(db, io) {
  let changed = 0;
  let groups;
  try { groups = db.prepare('SELECT * FROM device_groups WHERE rules IS NOT NULL').all(); } catch { return 0; }
  const actor = require('./corporate/actor');
  const corpGuard = require('./corporate/guard');
  for (const g of groups) {
    try {
      actor.runAsSystem(() => {
        const ops = groupOps(g, planGroup(db, g));
        if (!ops.length) return;
        corpGuard.assertNoMandateLoss(null, ops.map((o) => o.deviceId), () => { applyOps(db, ops); return true; });
        pushTo(io, devicesToPush(db, ops));
        changed += ops.length;
      });
    } catch (e) {
      console.warn(`[groups] sweep of dynamic group ${g.id} failed: ${e.message}`);
    }
  }
  return changed;
}

module.exports = {
  FIELDS, MAX_RULES,
  normalizeRules, parseRules, deviceMatches,
  planGroup, planDevice, groupOps, applyOps, devicesToPush, pushTo,
  reconcileDeviceAsSystem, sweep,
};
