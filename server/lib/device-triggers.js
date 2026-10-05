'use strict';

/*
 * Which triggers apply to a device, and what the device needs to fire them offline.
 * docs/triggers-design.md.
 *
 * ⚠️ This runs on the SERVER, at sync time, and never at fire time. The device answers a datagram
 * from its own cached copy of this result with the WAN down — that is the whole feature. Everything
 * the device needs to decide must therefore be IN the payload; a field left out here is a field the
 * device cannot go and fetch when it matters.
 */

/*
 * ⚠️ EMERGENCY ALERTS (head office, spec §5). A trigger with kind = 'emergency' lives in the org's
 * head office workspace and reaches screens through emergency_trigger_scopes (org / workspace /
 * group / device) instead of trigger_assignments. It is projected with priority
 * EMERGENCY_PRIORITY_BASE + p, p clamped to 0..1000, and normal triggers are clamped to
 * -1000..1000 — so on every player (web/BrightSign number compare, Android Int, native int()) an
 * emergency is STRICTLY greater than any normal trigger: a normal fire while an emergency shows is
 * dropped, and an emergency takes the screen from any normal one (holding an until_cleared one).
 * No player change.
 */
const EMERGENCY_PRIORITY_BASE = 100000;

/*
 * Device D is in emergency trigger t's scope. Needs `d` (devices), `dw` (D's workspace) and `t`
 * (triggers) in the enclosing query. A group only counts in D's own workspace — a scope row naming
 * another workspace's group (a stale id, a bad import) never reaches across.
 */
const EMERGENCY_SCOPE_MATCH = `EXISTS (SELECT 1 FROM emergency_trigger_scopes es WHERE es.trigger_id = t.id AND (
      (es.scope_kind = 'org'       AND es.scope_id = dw.organization_id)
   OR (es.scope_kind = 'workspace' AND es.scope_id = d.workspace_id)
   OR (es.scope_kind = 'device'    AND es.scope_id = d.id)
   OR (es.scope_kind = 'group'     AND es.scope_id IN (
         SELECT m.group_id FROM device_group_members m
           JOIN device_groups g ON g.id = m.group_id AND g.workspace_id = d.workspace_id
          WHERE m.device_id = d.id))))`;

/*
 * The emergency triggers that reach device D (§5.2 rules 1-3): the org has switched emergency
 * alerts on, the trigger is enabled, its head office workspace is in D's org, and D is in scope.
 * `corporate_enabled` is deliberately NOT consulted: an org may use emergency alerts without
 * corporate playlists. Rule 4 (does D's listener accept the transport) is the player's, as for
 * every trigger.
 */
const EMERGENCY_FOR_DEVICE_SQL = `
  SELECT t.* FROM triggers t
    JOIN workspaces tw ON tw.id = t.workspace_id
    JOIN organizations o ON o.id = tw.organization_id AND o.emergency_triggers_enabled = 1
    JOIN devices d ON d.id = ?
    JOIN workspaces dw ON dw.id = d.workspace_id AND dw.organization_id = tw.organization_id
   WHERE t.kind = 'emergency' AND t.enabled = 1 AND ${EMERGENCY_SCOPE_MATCH}
   ORDER BY t.priority DESC, t.name`;

const NORMAL_SQL = (kindClause) => `
    SELECT DISTINCT t.*
      FROM triggers t
      JOIN trigger_assignments ta ON ta.trigger_id = t.id
      JOIN devices d ON d.id = ?
     WHERE t.enabled = 1${kindClause}
       AND t.workspace_id = d.workspace_id
       AND (
         (ta.target_type = 'device' AND ta.target_id = d.id)
         OR (ta.target_type = 'group' AND ta.target_id IN (
               SELECT group_id FROM device_group_members WHERE device_id = d.id))
       )
     ORDER BY t.priority DESC, t.name
  `;

/** The emergency triggers covering a device (empty when none, or on a schema without them). */
function emergencyTriggersForDevice(db, deviceId) {
  if (!require('./corporate/runtime').emergencyActive(db)) return [];
  try { return db.prepare(EMERGENCY_FOR_DEVICE_SQL).all(deviceId); } catch (_) { return []; }
}

/**
 * Store triggers on a screen head office's playlist drives (§5.3), by the org's
 * `store_triggers_under_mandate`: 'allow' (default) = unchanged; 'leased' = a stuck sender's
 * trigger ends after the cap (it does NOT bound a store that keeps sending — re-fires renew); 'off'
 * = not projected at all, the only setting that stops a store covering corporate content.
 * Returns null whenever nothing changes: no corporate machinery, no mandate, or 'allow'.
 */
function storeTriggerPolicyFor(db, deviceId, mandated) {
  const runtime = require('./corporate/runtime');
  if (mandated === false) return null;
  if (mandated === undefined) {
    if (!runtime.active(db)) return null;
    if (!require('./corporate/resolve').mandateFor(db, deviceId)) return null;
  }
  try {
    const o = db.prepare(`SELECT o.store_triggers_under_mandate AS policy, o.store_trigger_cap_sec AS cap
        FROM devices d JOIN workspaces w ON w.id = d.workspace_id JOIN organizations o ON o.id = w.organization_id
       WHERE d.id = ?`).get(deviceId);
    if (!o || !o.policy || o.policy === 'allow') return null;
    return { policy: o.policy, cap: Number(o.cap) > 0 ? Number(o.cap) : 300 };
  } catch (_) { return null; }
}

/** What 'leased' does to one trigger row (a copy; the stored row is never touched). */
function leasedRow(t, cap) {
  if (t.mode === 'until_cleared') return { ...t, lease_sec: Math.min(Number(t.lease_sec) || cap, cap) };
  return { ...t, max_duration_sec: Math.min(Number(t.max_duration_sec) || cap, cap) };
}

/**
 * Triggers assigned to a device, directly or through any group it belongs to — and, ahead of them,
 * any head office emergency alert covering it.
 *
 * ⚠️ Assignment is by device OR group and a device can be in several groups, so the same trigger can
 * match more than once. DISTINCT is not decoration: two rows would sync as two triggers with the
 * same match_token, and the device's resolver would then have to pick one — turning a normal
 * configuration (assign to a group AND to a screen in it) into ambiguous behaviour.
 *
 * ⚠️ Emergency rows come FIRST: evaluate() (lib/trigger-resolve.js) takes the first match, so an
 * emergency token is always met before any store trigger's. With no emergency rows (every install
 * that never switched them on) the result is byte-identical to before: the extra query does not even
 * run, and the normal query differs only by `AND t.kind = 'normal'`.
 *
 * `opts.mandated` — is the device driven by a head office mandate? (buildPlaylistPayloadUnchecked
 * already knows; omitted, it is looked up.) Decides the store-trigger policy.
 * `opts.emergencyOnly` — only the emergency rows (a screen showing an "Activate now" alert keeps its
 * emergency definitions armed, and nothing else). `opts.skipEmergency` — only the normal rows.
 */
function triggersForDevice(db, deviceId, opts = {}) {
  const emergency = opts.skipEmergency ? [] : emergencyTriggersForDevice(db, deviceId);
  if (opts.emergencyOnly) return emergency;
  let normal;
  try { normal = db.prepare(NORMAL_SQL("\n       AND t.kind = 'normal'")).all(deviceId); } catch (e) {
    // A hand-built schema without the kind column (older fixtures): every row is a normal trigger.
    if (!/no such column/i.test(String(e && e.message))) throw e;
    normal = db.prepare(NORMAL_SQL('')).all(deviceId);
  }
  const policy = normal.length ? storeTriggerPolicyFor(db, deviceId, opts.mandated) : null;
  if (policy && policy.policy === 'off') normal = [];
  else if (policy && policy.policy === 'leased') normal = normal.map((t) => leasedRow(t, policy.cap));
  return emergency.length ? [...emergency, ...normal] : normal;
}

const clampInt = (v, lo, hi, def) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
};

// "[triggers] clamped priority ..." once per trigger per boot — it applies to installs without the
// corporate feature too, so it has to be visible, but a fleet re-syncing must not flood the log.
const _clampLogged = new Set();

/**
 * Shape one trigger for the wire.
 *
 * `items` is the resolved playlist, carried inline rather than referenced: the device cannot resolve
 * a playlist id offline, and the moment it has to, the trigger stops working on exactly the day it
 * is needed.
 */
function projectTrigger(t, items) {
  const emergency = t.kind === 'emergency';
  let priority = t.priority || 0;
  if (emergency) {
    priority = EMERGENCY_PRIORITY_BASE + clampInt(priority, 0, 1000, 0);
  } else {
    // Belt: the validator holds -1000..1000, but a row from an import, mesh or a hand fix-up could
    // carry anything — and a normal trigger at 200000 would outrank head office's emergency alert.
    const c = clampInt(priority, -1000, 1000, 0);
    if (c !== priority && !_clampLogged.has(t.id)) {
      _clampLogged.add(t.id);
      if (_clampLogged.size > 5000) _clampLogged.clear();
      console.warn(`[triggers] clamped priority of "${t.name}" from ${priority}`);
    }
    priority = c;
  }
  let lease = t.lease_sec == null ? null : t.lease_sec;
  let maxDur = t.max_duration_sec == null ? 0 : t.max_duration_sec;
  if (emergency) {
    // Belt for the emergency validator (§5.1): no player caps an until_cleared trigger by wall clock,
    // so the lease is what ends a stuck sender's alert — never unbounded, never over 5 minutes.
    if (t.mode === 'until_cleared') lease = clampInt(lease == null ? 120 : lease, 5, 300, 120);
    else maxDur = clampInt(maxDur || 600, 60, 3600, 600);
  }
  const out = {
    id: t.id,
    name: t.name,
    match_token: t.match_token,
    clear_token: t.clear_token || null,
    source_http: !!t.source_http,
    source_udp: !!t.source_udp,
    target_kind: t.target_kind,
    // ⚠️ target_ref travels too, but only so the player can LOG which playlist it rendered. It is
    // never resolved on the device; `items` is the content.
    target_ref: t.target_ref || null,
    /*
     * ⚠️ position / width / height / opacity / border_radius are DELIBERATELY NOT PROJECTED.
     *
     * They were copied wholesale from the PiP contract and are dead in every direction: no client
     * writes them (frontend/js/views/triggers.js sets none), four of the five never entered the
     * player's change signature so an edit could not reach a device anyway, the renderer discards
     * all five (triggerFire hardcodes inset:0 opaque black), the Android/shared contract
     * (TriggerResolve.kt, shared/trigger-vectors.json) has never had them, and no test asserts one.
     *
     * Sending a field the device provably ignores is how the next person concludes it works. The
     * COLUMNS stay — this schema treats unused columns as the no-migration hook, and SQLite would
     * need a table rebuild to drop them. If a non-fullscreen mode is wanted later, the right shape
     * is ONE semantic field (takeover | banner), which is also what the mass-notification vendors
     * expose, rather than five raw CSS primitives.
     */
    mode: t.mode,
    max_duration_sec: maxDur,
    lease_sec: lease,
    priority,
    items: Array.isArray(items) ? items : [],
  };
  // Only on emergency rows, so a normal trigger's projection stays byte-identical. Players ignore
  // it (the priority alone decides); it is there for logs and the dashboard preview.
  if (emergency) out.kind = 'emergency';
  return out;
}

/**
 * Every content URL a device must hold to fire its triggers offline.
 *
 * ⚠️ THIS IS WHAT MAKES PINNING WORK, and it is not optional. The service worker's
 * pruneToPlaylist() deletes any content-cache entry that is not in the set the player sends it — so
 * a trigger target is not merely un-prefetched, it is ACTIVELY EVICTED unless it appears here. The
 * player appends these to the same st-cache-playlist message it already sends for the base playlist.
 */
function triggerMediaUrls(triggers, mediaUrl) {
  const out = [];
  for (const t of triggers || []) {
    for (const item of t.items || []) {
      const u = mediaUrl(item);
      if (u) out.push(u);
    }
  }
  return out;
}

/**
 * Every device that would render this trigger — directly assigned, or via a group.
 *
 * ⚠️ THIS IS WHAT MAKES A NEW TRIGGER ARRIVE. Creating, editing, assigning or deleting a trigger
 * used to reach devices only on their next reconnect, which for a panel that has been up for
 * weeks means never. The definition would sit in the database looking configured while the screen
 * knew nothing about it — and the media it needs would not be pinned either, so the first time
 * anyone found out was when the alarm fired against nothing.
 */
function devicesForTrigger(db, triggerId) {
  const ids = db.prepare(`
    SELECT DISTINCT d.id
      FROM devices d
      JOIN triggers t ON t.id = ? AND t.workspace_id = d.workspace_id
      JOIN trigger_assignments ta ON ta.trigger_id = t.id
     WHERE (
       (ta.target_type = 'device' AND ta.target_id = d.id)
       OR (ta.target_type = 'group' AND ta.target_id IN (
             SELECT group_id FROM device_group_members WHERE device_id = d.id))
     )
  `).all(triggerId).map((r) => r.id);
  // + every screen in an emergency alert's scope (a separate table: emergency alerts are never in
  // trigger_assignments). Not gated on the org switch: a push to a screen that then projects nothing
  // is harmless, a missed one leaves a definition behind.
  const extra = devicesInEmergencyScope(db, triggerId);
  if (!extra.length) return ids;
  return [...new Set([...ids, ...extra])];
}

/** Every device in an emergency trigger's scope, in the trigger's org (empty for a normal trigger). */
function devicesInEmergencyScope(db, triggerId) {
  try {
    return db.prepare(`
      SELECT d.id FROM triggers t
        JOIN workspaces tw ON tw.id = t.workspace_id
        JOIN workspaces dw ON dw.organization_id = tw.organization_id
        JOIN devices d ON d.workspace_id = dw.id
       WHERE t.id = ? AND t.kind = 'emergency' AND ${EMERGENCY_SCOPE_MATCH}`).all(triggerId).map((r) => r.id);
  } catch (_) { return []; }
}

/**
 * Every device that holds this playlist as a TRIGGER TARGET rather than as its base playlist.
 *
 * ⚠️ Publishing a playlist pushed only to devices whose `playlist_id` matched it, so a screen that
 * referenced it solely through a trigger never heard about the edit. The operator swaps the
 * evacuation notice, sees "Published", and every panel keeps firing the OLD items — with the old
 * asset still pinned and the new one never fetched.
 */
function devicesForTriggerTarget(db, playlistId) {
  const ids = db.prepare(`
    SELECT DISTINCT d.id
      FROM devices d
      JOIN triggers t ON t.workspace_id = d.workspace_id
                     AND t.enabled = 1
                     AND t.target_kind = 'playlist'
                     AND t.target_ref = ?
      JOIN trigger_assignments ta ON ta.trigger_id = t.id
     WHERE (
       (ta.target_type = 'device' AND ta.target_id = d.id)
       OR (ta.target_type = 'group' AND ta.target_id IN (
             SELECT group_id FROM device_group_members WHERE device_id = d.id))
     )
  `).all(playlistId).map((r) => r.id);
  // + screens holding it through a head office emergency alert (its playlist is an HQ playlist the
  // screen's own workspace never names). An "Activate now" in progress reads the same snapshot, so
  // this push is also what carries a republished alert to screens showing it right now.
  let extra = [];
  try {
    extra = db.prepare(`
      SELECT DISTINCT d.id FROM triggers t
        JOIN workspaces tw ON tw.id = t.workspace_id
        JOIN workspaces dw ON dw.organization_id = tw.organization_id
        JOIN devices d ON d.workspace_id = dw.id
       WHERE t.kind = 'emergency' AND t.enabled = 1 AND t.target_kind = 'playlist' AND t.target_ref = ?
         AND ${EMERGENCY_SCOPE_MATCH}`).all(playlistId).map((r) => r.id);
  } catch (_) { extra = []; }
  if (!extra.length) return ids;
  return [...new Set([...ids, ...extra])];
}

module.exports = {
  triggersForDevice, projectTrigger, triggerMediaUrls,
  devicesForTrigger, devicesForTriggerTarget,
  EMERGENCY_PRIORITY_BASE, EMERGENCY_SCOPE_MATCH, emergencyTriggersForDevice, devicesInEmergencyScope,
  storeTriggerPolicyFor,
};
