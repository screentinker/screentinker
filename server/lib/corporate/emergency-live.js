'use strict';

/*
 * "ACTIVATE NOW" — a head office emergency alert set off from the dashboard (spec §5.6). No player
 * change: for the duration, every covered screen's BASE payload is the alert's playlist (an
 * ordinary playlist change on every player, Android included), and it goes back when the
 * activation ends.
 *
 * Covered = in the alert's scope, the org switch on, the alert enabled, and "triggers enabled" on
 * the screen (its HTTP or UDP listener is on; the user's rule — §5.2 rule 4) on a platform that
 * has triggers at all (not Tizen). A store's choice to keep triggers off stands here too.
 *
 * ⚠️ A HARD SERVER-SIDE CAP. Every activation has expires_at (60..3600 s after it starts); a
 * setTimeout per activation ends it, and a 30-second sweep is the belt for a timer lost to a sleep
 * or a clock jump. Ending pushes the same screens back to their normal payload. Nothing here
 * depends on a request: expiry happens with nobody watching.
 *
 * ⚠️ RESTART-SAFE. Live activations are rows in emergency_activations; the in-memory set is loaded
 * from them (lazily, on first use, and by init() at boot), so a restart mid-activation restores it.
 * Rows that expired while the server was down are ended at load.
 *
 * Deviation from the spec's Map<deviceId, activation>: the in-memory set is keyed by TRIGGER, and a
 * device's coverage is checked against it when its payload is built. With no live activation (every
 * moment but an emergency) that check is one Map.size test; during one it is a single indexed query
 * per live alert — and it can never go stale when a screen joins or leaves a group mid-alert, which
 * a per-device map would need every membership route to remember to rebuild.
 */

const { EMERGENCY_SCOPE_MATCH } = require('../device-triggers');

function dbOf() { return require('../../db/database').db; }

const SWEEP_MS = 30 * 1000;
function minSec() {
  // Test-only seam (NODE_ENV=test): lets a route test watch a real expiry without waiting a minute.
  const v = Number(process.env.CORPORATE_TEST_EMERGENCY_MIN_SEC);
  if (process.env.NODE_ENV === 'test' && Number.isFinite(v) && v >= 1) return v;
  return 60;
}
const MAX_SEC = 3600;

let io = null;
let loaded = false;
const live = new Map();     // trigger_id -> activation row
const timers = new Map();   // activation id -> timeout
let sweepTimer = null;
let clock = () => Math.floor(Date.now() / 1000);

function setIo(ref) { io = ref || null; }

function init(ioRef) {
  setIo(ioRef);
  load(dbOf());
  if (!sweepTimer) {
    const { bindSystem } = require('./actor');
    sweepTimer = setInterval(bindSystem(() => { try { sweep(); } catch (e) { console.warn(`[emergency] sweep: ${e && e.message}`); } }), SWEEP_MS);
    if (sweepTimer.unref) sweepTimer.unref();
  }
}

function load(db) {
  db = db || dbOf();
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  live.clear();
  loaded = true;
  let rows = [];
  try { rows = db.prepare('SELECT * FROM emergency_activations WHERE ended_at IS NULL ORDER BY started_at').all(); } catch (_) { return; }
  const now = clock();
  for (const r of rows) {
    if (r.expires_at <= now) {
      // Expired while the server was down: its screens get their normal payload when they reconnect.
      try { db.prepare("UPDATE emergency_activations SET ended_at = ?, ended_by = 'expired' WHERE id = ? AND ended_at IS NULL").run(r.expires_at, r.id); } catch (_) { /* */ }
      continue;
    }
    live.set(r.trigger_id, r);
    schedule(r);
  }
  if (live.size) console.log(`[emergency] restored ${live.size} live activation(s)`);
}

function ensure(db) { if (!loaded) load(db); }

function schedule(row) {
  const old = timers.get(row.id);
  if (old) clearTimeout(old);
  const ms = Math.max(0, (row.expires_at - clock()) * 1000);
  const { bindSystem } = require('./actor');
  // setTimeout caps at 2^31-1 ms; MAX_SEC is far below it.
  const t = setTimeout(bindSystem(() => { try { expire(row.id); } catch (e) { console.warn(`[emergency] expiry: ${e && e.message}`); } }), ms);
  if (t.unref) t.unref();
  timers.set(row.id, t);
}

const COVERED_SQL = `
  SELECT d.platform, d.client_type, d.android_version FROM triggers t
    JOIN workspaces tw ON tw.id = t.workspace_id
    JOIN organizations o ON o.id = tw.organization_id AND o.emergency_triggers_enabled = 1
    JOIN devices d ON d.id = ?
    JOIN workspaces dw ON dw.id = d.workspace_id AND dw.organization_id = tw.organization_id
   WHERE t.id = ? AND t.kind = 'emergency' AND t.enabled = 1
     AND (d.triggers_accept_http = 1 OR d.triggers_accept_udp = 1)
     AND ${EMERGENCY_SCOPE_MATCH}`;

/**
 * The live activation covering this device, with its trigger — or null. Called on EVERY payload
 * build, so the common case (nothing live) costs one Map.size test.
 */
function activationFor(db, deviceId) {
  db = db || dbOf();
  ensure(db);
  if (!live.size || !deviceId) return null;
  const now = clock();
  let best = null;
  for (const a of live.values()) {
    if (a.expires_at <= now) continue;   // the timer / sweep ends it; never show a lapsed alert
    let hit;
    try { hit = db.prepare(COVERED_SQL).get(deviceId, a.trigger_id); } catch (_) { hit = null; }
    if (!hit) continue;
    if (require('./emergency').platformCannotTrigger(hit)) continue;
    const t = db.prepare('SELECT * FROM triggers WHERE id = ?').get(a.trigger_id);
    if (!t) continue;
    // Two live alerts on one screen: the higher priority shows, then the later start (the trigger
    // path's own rule: ties go to the last arrival).
    if (!best || t.priority > best.trigger.priority || (t.priority === best.trigger.priority && a.started_at >= best.activation.started_at)) {
      best = { activation: a, trigger: t };
    }
  }
  return best;
}

function liveFor(triggerId) {
  ensure(dbOf());
  const a = live.get(triggerId);
  if (!a) return null;
  return { ...a, remaining_sec: Math.max(0, a.expires_at - clock()) };
}

function pushDevices(ids) {
  if (!ids || !ids.length) return { online: 0, queued: 0 };
  let online = 0;
  let queued = 0;
  try {
    if (!io) return { online: 0, queued: ids.length };
    const { buildPlaylistPayload } = require('../../ws/deviceSocket');
    const commandQueue = require('../command-queue');
    const ns = io.of('/device');
    for (const id of new Set(ids)) {
      const r = commandQueue.queueOrEmitPlaylistUpdate(ns, id, buildPlaylistPayload);
      if (r && r.delivered) online++; else queued++;
    }
  } catch (e) { console.warn(`[emergency] push failed: ${e && e.message}`); }
  return { online, queued };
}

/**
 * Start an activation. Caller has checked: admin, switch on, trigger enabled, none live.
 * @returns {{activation, reached: {online, offline_will_get_on_reconnect, not_eligible}}}
 */
function activate(db, trigger, { userId, durationSec }) {
  db = db || dbOf();
  ensure(db);
  const dur = Math.round(Number(durationSec));
  if (!Number.isFinite(dur) || dur < minSec() || dur > MAX_SEC) throw new RangeError(`duration_sec must be ${minSec()}-${MAX_SEC}`);
  const id = require('crypto').randomUUID();
  const started = clock();
  db.prepare('INSERT INTO emergency_activations (id, trigger_id, started_by, started_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, trigger.id, userId || 'unknown', started, started + dur);
  const row = db.prepare('SELECT * FROM emergency_activations WHERE id = ?').get(id);
  live.set(trigger.id, row);
  schedule(row);
  const targets = require('./emergency').activationTargets(db, trigger.id);
  const ids = targets.eligible.map((d) => d.id);
  const pushed = pushDevices(ids);
  console.log(`[emergency] ACTIVATED "${trigger.name}" (${trigger.id}) for ${dur}s on ${ids.length} screen(s)`);
  return {
    activation: { ...row, remaining_sec: dur },
    reached: {
      online: pushed.online,
      offline_will_get_on_reconnect: ids.length - pushed.online,
      not_eligible: targets.not_eligible.map((n) => ({ device_id: n.device_id, reason: n.reason })),
    },
  };
}

/** End the live activation of a trigger (clear, disable, delete, switch off, expiry). */
function end(db, triggerId, { userId = null, reason = 'cleared' } = {}) {
  db = db || dbOf();
  ensure(db);
  const a = live.get(triggerId);
  if (!a) return null;
  // The screens to send back are the ones covered NOW (before the row is ended).
  let ids = [];
  try { ids = require('./emergency').activationTargets(db, triggerId).eligible.map((d) => d.id); } catch (_) { ids = []; }
  const endedAt = Math.min(clock(), a.expires_at);
  try {
    db.prepare('UPDATE emergency_activations SET ended_at = ?, ended_by = ? WHERE id = ? AND ended_at IS NULL')
      .run(endedAt, userId || reason, a.id);
  } catch (_) { /* row gone with its trigger (delete cascades) */ }
  live.delete(triggerId);
  const t = timers.get(a.id);
  if (t) clearTimeout(t);
  timers.delete(a.id);
  const pushed = pushDevices(ids);
  console.log(`[emergency] ended ${triggerId} (${reason}); ${ids.length} screen(s) back to normal`);
  return { activation: { ...a, ended_at: endedAt, ended_by: userId || reason }, screens: ids.length, ...pushed };
}

/** Screens a live activation covers right now (for pushing around a delete, whose rows cascade). */
function coveredNow(db, triggerId) {
  if (!live.has(triggerId)) return [];
  try { return require('./emergency').activationTargets(db || dbOf(), triggerId).eligible.map((d) => d.id); } catch (_) { return []; }
}

function expire(activationId) {
  for (const [triggerId, a] of live) {
    if (a.id === activationId) {
      end(dbOf(), triggerId, { reason: 'expired' });
      try {
        require('../audit').audit('corporate.emergency.expire', { userId: null, workspaceId: null, details: { trigger_id: triggerId, activation_id: a.id } });
      } catch (_) { /* never */ }
      return true;
    }
  }
  return false;
}

/** Belt for the per-activation timer. */
function sweep() {
  const now = clock();
  let n = 0;
  for (const a of [...live.values()]) if (a.expires_at <= now && expire(a.id)) n++;
  return n;
}

/** End every live activation of an org's alerts (the org switch turned off). */
function endAllForOrg(db, orgId, opts) {
  db = db || dbOf();
  ensure(db);
  const out = [];
  for (const triggerId of [...live.keys()]) {
    const r = db.prepare('SELECT 1 FROM triggers t JOIN workspaces w ON w.id = t.workspace_id WHERE t.id = ? AND w.organization_id = ?').get(triggerId, orgId);
    if (r) out.push(end(db, triggerId, opts));
  }
  return out;
}

/* Test seams. */
function _setClock(fn) { clock = fn || (() => Math.floor(Date.now() / 1000)); }
function _reset() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear(); live.clear(); loaded = false;
}

module.exports = {
  init, setIo, load, activationFor, liveFor, activate, end, endAllForOrg, coveredNow, sweep, expire,
  minSec, MAX_SEC, _setClock, _reset,
};
