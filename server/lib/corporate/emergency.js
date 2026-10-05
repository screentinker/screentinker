'use strict';

/*
 * Head office EMERGENCY ALERTS (spec §5) — everything about a definition except going live
 * (lib/corporate/emergency-live.js): its scope, its token namespace, who it can reach and why not.
 *
 * An emergency alert is an ordinary `triggers` row with kind = 'emergency', living in the org's head
 * office workspace (so the FK cascade, the payload's tenant-scoped target lookup and the offline
 * validator all work unchanged), scoped through emergency_trigger_scopes (org / workspace / group /
 * device) rather than trigger_assignments. lib/device-triggers.js projects it to every screen in
 * scope, ahead of — and strictly above — every store trigger.
 *
 * "ONLY IF TRIGGERS WERE ENABLED" (the user's rule, §5.2) is the reachability rule here: a screen is
 * reached only when the org switch is on AND the screen's own listener is on. A store that switched
 * its listener off before head office switched emergency alerts on keeps that choice; coverage
 * reports it (`listener_off`) instead of overriding it. After the switch, the listener, ports, secret
 * and clear-all token of an in-scope screen are org-admin-only (routes/devices.js).
 */

const { EMERGENCY_SCOPE_MATCH } = require('../device-triggers');

function dbOf() { return require('../../db/database').db; }

const SCOPE_KINDS = new Set(['org', 'workspace', 'group', 'device']);
const TOKEN_RE = /^[\x21-\x7E]{1,64}$/;

/** Is this trigger an emergency alert? (a row, or an id) */
function isEmergency(db, triggerOrId) {
  if (!triggerOrId) return false;
  if (typeof triggerOrId === 'object') return triggerOrId.kind === 'emergency';
  try { return (db || dbOf()).prepare('SELECT kind FROM triggers WHERE id = ?').get(triggerOrId)?.kind === 'emergency'; } catch (_) { return false; }
}

/** Scope rows of a trigger, each with a human name for the dashboard. */
function scopesOf(db, triggerId) {
  db = db || dbOf();
  const rows = db.prepare('SELECT scope_kind, scope_id FROM emergency_trigger_scopes WHERE trigger_id = ? ORDER BY scope_kind, scope_id').all(triggerId);
  return rows.map((r) => ({ ...r, name: scopeName(db, r) }));
}

function scopeName(db, r) {
  try {
    if (r.scope_kind === 'org') return db.prepare('SELECT name FROM organizations WHERE id = ?').get(r.scope_id)?.name || null;
    if (r.scope_kind === 'workspace') return db.prepare('SELECT name FROM workspaces WHERE id = ?').get(r.scope_id)?.name || null;
    if (r.scope_kind === 'group') return db.prepare('SELECT name FROM device_groups WHERE id = ?').get(r.scope_id)?.name || null;
    if (r.scope_kind === 'device') return db.prepare('SELECT name FROM devices WHERE id = ?').get(r.scope_id)?.name || null;
  } catch (_) { /* fall through */ }
  return null;
}

/**
 * Validate a proposed scope list for an org. Returns {ok, rows} or {ok: false, status, error, code?}.
 * Every id must belong to this org; a workspace that is replicated over the mesh is refused (the
 * scope table is not replicated, so a replica would never see the alert — spec §6.4).
 */
function validateScopes(db, orgId, scopes) {
  db = db || dbOf();
  if (scopes === undefined) return { ok: true, rows: null };
  if (!Array.isArray(scopes)) return { ok: false, status: 400, error: 'scopes must be an array of {scope_kind, scope_id}' };
  const guard = require('./guard');
  const rows = [];
  const seen = new Set();
  for (const s of scopes) {
    const kind = s && s.scope_kind;
    if (!SCOPE_KINDS.has(kind)) return { ok: false, status: 400, error: `invalid scope_kind: ${kind} — use org, workspace, group or device` };
    const id = kind === 'org' ? orgId : String((s && s.scope_id) || '');
    if (kind === 'org' && s.scope_id && s.scope_id !== orgId) return { ok: false, status: 400, error: 'an org scope must name this organization' };
    let wsId = null;
    if (kind === 'workspace') {
      const w = db.prepare('SELECT id, organization_id FROM workspaces WHERE id = ?').get(id);
      if (!w || w.organization_id !== orgId) return { ok: false, status: 400, error: `workspace ${id} is not in this organization` };
      wsId = w.id;
    } else if (kind === 'group') {
      const g = db.prepare('SELECT g.id, g.workspace_id, w.organization_id FROM device_groups g JOIN workspaces w ON w.id = g.workspace_id WHERE g.id = ?').get(id);
      if (!g || g.organization_id !== orgId) return { ok: false, status: 400, error: `group ${id} is not in this organization` };
      wsId = g.workspace_id;
    } else if (kind === 'device') {
      const d = db.prepare('SELECT d.id, d.workspace_id, w.organization_id FROM devices d JOIN workspaces w ON w.id = d.workspace_id WHERE d.id = ?').get(id);
      if (!d || d.organization_id !== orgId) return { ok: false, status: 400, error: `screen ${id} is not in this organization` };
      wsId = d.workspace_id;
    }
    if (wsId && guard.isReplicatedWorkspace(db, wsId)) {
      const name = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(wsId)?.name;
      const e = guard.err('CORPORATE_MESH_UNSUPPORTED', { workspace: `"${name || wsId}"` });
      return { ok: false, status: e.status, error: e.message, code: e.code };
    }
    const key = `${kind}|${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ scope_kind: kind, scope_id: id });
  }
  return { ok: true, rows };
}

/** Replace a trigger's scope rows (inside the caller's transaction). */
function setScopes(db, triggerId, rows) {
  db = db || dbOf();
  db.prepare('DELETE FROM emergency_trigger_scopes WHERE trigger_id = ?').run(triggerId);
  const ins = db.prepare('INSERT OR IGNORE INTO emergency_trigger_scopes (trigger_id, scope_kind, scope_id) VALUES (?, ?, ?)');
  for (const r of rows) ins.run(triggerId, r.scope_kind, r.scope_id);
}

/*
 * Devices a scope list reaches, WITHOUT a stored trigger (create/edit validation runs before the
 * rows exist). Same rule as EMERGENCY_SCOPE_MATCH.
 */
function devicesForScopes(db, orgId, rows) {
  db = db || dbOf();
  const out = new Map();
  const add = (list) => { for (const d of list) out.set(d.id, d); };
  const cols = 'd.id, d.name, d.workspace_id, d.trigger_clear_all_token';
  for (const r of rows || []) {
    if (r.scope_kind === 'org') {
      add(db.prepare(`SELECT ${cols} FROM devices d JOIN workspaces w ON w.id = d.workspace_id WHERE w.organization_id = ?`).all(orgId));
    } else if (r.scope_kind === 'workspace') {
      add(db.prepare(`SELECT ${cols} FROM devices d WHERE d.workspace_id = ?`).all(r.scope_id));
    } else if (r.scope_kind === 'device') {
      add(db.prepare(`SELECT ${cols} FROM devices d WHERE d.id = ?`).all(r.scope_id));
    } else if (r.scope_kind === 'group') {
      add(db.prepare(`SELECT ${cols} FROM devices d JOIN device_group_members m ON m.device_id = d.id
          JOIN device_groups g ON g.id = m.group_id AND g.workspace_id = d.workspace_id WHERE g.id = ?`).all(r.scope_id));
    }
  }
  return [...out.values()];
}

/**
 * THE TOKEN NAMESPACE, checked org-wide (§5.2). An emergency token must not equal:
 *   - any other trigger's fire or clear token anywhere in the org (normal or emergency) — evaluate()
 *     takes the first match, and while an emergency is listed first, the store trigger sharing its
 *     token would be silently unfirable (and the reverse on a screen the emergency doesn't reach);
 *   - the clear-all token of any screen in its scope — clear-all is checked BEFORE every trigger, so
 *     a store's clear-all equal to the emergency's fire token makes it unfirable on that screen.
 * Returns null, or {status: 409, error}.
 */
function tokenClash(db, orgId, tokens, { id = null, scopeRows = [] } = {}) {
  db = db || dbOf();
  const list = tokens.filter(Boolean).map(String);
  if (!list.length) return null;
  const rows = db.prepare(`SELECT t.id, t.name, t.match_token, t.clear_token, t.kind FROM triggers t
      JOIN workspaces w ON w.id = t.workspace_id WHERE w.organization_id = ? AND t.id != ?`).all(orgId, id || '');
  for (const r of rows) {
    for (const tok of list) {
      if (tok === r.match_token || (r.clear_token && tok === r.clear_token)) {
        return { status: 409, code: 'CORPORATE_EMERGENCY_TOKEN', error: `"${tok}" is already used as a fire or clear token by the ${r.kind === 'emergency' ? 'emergency alert' : 'trigger'} "${r.name}" in your organization — every screen resolves tokens in one namespace, so a duplicate would make one of them unfirable.` };
      }
    }
  }
  for (const d of devicesForScopes(db, orgId, scopeRows)) {
    if (d.trigger_clear_all_token && list.includes(d.trigger_clear_all_token)) {
      return { status: 409, code: 'CORPORATE_EMERGENCY_TOKEN', error: `"${d.trigger_clear_all_token}" is the clear-all token of the screen "${d.name}" — clear-all is checked before every trigger, so the alert could never fire there. Choose another token.` };
    }
  }
  return null;
}

/** May this clear-all token be set on a device? Null, or an error string (generic on purpose). */
function clearAllClash(db, deviceId, token) {
  db = db || dbOf();
  if (!token) return null;
  try {
    const hit = db.prepare(`SELECT 1 FROM triggers t JOIN workspaces tw ON tw.id = t.workspace_id
        JOIN workspaces dw ON dw.organization_id = tw.organization_id JOIN devices d ON d.workspace_id = dw.id
       WHERE d.id = ? AND t.kind = 'emergency' AND (t.match_token = ? OR t.clear_token = ?) LIMIT 1`).get(deviceId, token, token);
    // Deliberately not naming the alert or its other token: the codes of head office's alerts are
    // not the store's to read.
    if (hit) return `"${token}" is reserved by your head office's emergency alerts — choose another clear-all token`;
  } catch (_) { /* no kind column */ }
  return null;
}

/**
 * Enabled emergency alerts covering this device while its org has the switch on — i.e. the ones
 * that make its trigger settings head office's (§5.2, D13). Empty on any install without them.
 */
function lockingTriggers(db, deviceId) {
  db = db || dbOf();
  if (!require('./runtime').emergencyActive(db)) return [];
  try {
    return db.prepare(`SELECT t.id, t.name FROM triggers t
        JOIN workspaces tw ON tw.id = t.workspace_id
        JOIN organizations o ON o.id = tw.organization_id AND o.emergency_triggers_enabled = 1
        JOIN devices d ON d.id = ?
        JOIN workspaces dw ON dw.id = d.workspace_id AND dw.organization_id = tw.organization_id
       WHERE t.kind = 'emergency' AND t.enabled = 1 AND ${EMERGENCY_SCOPE_MATCH}`).all(deviceId);
  } catch (_) { return []; }
}

/**
 * Refuse a change to a device's trigger listener / ports / secret / clear-all by anyone but the
 * org's admins while an emergency alert covers it. Throws a CorporateError (403).
 */
function assertTriggerSettingsWritable(who, deviceId) {
  const db = dbOf();
  const locking = lockingTriggers(db, deviceId);
  if (!locking.length) return;
  const guard = require('./guard');
  const orgId = guard.orgOfDevice(db, deviceId);
  if (guard.isOrgAdmin(who, orgId)) return;
  throw guard.err('CORPORATE_DEVICE_CONTROL', { emergency: true }, {
    device_id: deviceId,
    corporate: { emergency: true, emergency_alerts: locking.map((t) => ({ id: t.id, name: t.name })) },
  });
}

/* ── Coverage (§5.5): who an alert reaches, and why not ─────────────────────────────────────── */

function deviceRowsInScope(db, triggerId) {
  return db.prepare(`
    SELECT d.id, d.name, d.workspace_id, dw.name AS workspace_name, d.status, d.last_heartbeat,
           d.platform, d.client_type, d.android_version,
           d.triggers_accept_http, d.triggers_accept_udp, d.trigger_secret, d.trigger_clear_all_token,
           d.trigger_http_port, d.trigger_udp_port
      FROM triggers t
      JOIN workspaces tw ON tw.id = t.workspace_id
      JOIN workspaces dw ON dw.organization_id = tw.organization_id
      JOIN devices d ON d.workspace_id = dw.id
     WHERE t.id = ? AND t.kind = 'emergency' AND ${EMERGENCY_SCOPE_MATCH}
     ORDER BY dw.name, d.name`).all(triggerId);
}

/*
 * ⚠️ platform_no_triggers is decided by PLATFORM, not by the declared `trigger.http`/`trigger.udp`
 * capabilities the spec named: those are not in the server's capability vocabulary, the web player
 * declares them only once a listener has BOUND, and the Android and native players never declare
 * them at all — reading them would mark every Android screen unreachable. Tizen is the platform
 * that has no trigger listener (tizen/js/capabilities.js).
 */
function platformCannotTrigger(d) {
  return require('../player-capabilities').platformFamily(d) === 'tizen';
}

/** Why device d cannot be reached by alert t over the LAN trigger path, and by Activate now. */
function reasonsFor(t, org, d) {
  const trig = [];
  const act = [];
  if (!org || !org.emergency_triggers_enabled) { trig.push('org_switch_off'); act.push('org_switch_off'); }
  if (platformCannotTrigger(d)) { trig.push('platform_no_triggers'); act.push('platform_no_triggers'); }
  const httpOk = !!d.triggers_accept_http && !!t.source_http;
  const udpOk = !!d.triggers_accept_udp && !!t.source_udp;
  const anyListener = !!d.triggers_accept_http || !!d.triggers_accept_udp;
  if (!httpOk && !udpOk) trig.push('listener_off');
  if (!anyListener) act.push('listener_off');
  if ((httpOk || udpOk) && !d.trigger_secret) trig.push('no_secret');
  if (d.trigger_clear_all_token && (d.trigger_clear_all_token === t.match_token || d.trigger_clear_all_token === t.clear_token)) trig.push('clear_all_collision');
  if (!d.last_heartbeat || (t.updated_at && d.last_heartbeat < t.updated_at)) trig.push('not_synced');
  if (!t.enabled) { trig.push('disabled'); act.push('disabled'); }
  if (d.status !== 'online') act.push('offline');
  return { trigger: [...new Set(trig)], activate: [...new Set(act)] };
}

/**
 * @returns {{total, trigger_ready, activate_ready, online, unreachable: [{device_id, name, workspace, reasons, activate_reasons}]}}
 * `activate_ready` counts screens Activate now would switch over (online or not: an offline one gets it
 * when it reconnects while the alert is live); `online` is how many of those are connected right now.
 */
function coverage(db, triggerId) {
  db = db || dbOf();
  const t = db.prepare('SELECT * FROM triggers WHERE id = ?').get(triggerId);
  if (!t) return null;
  const org = db.prepare('SELECT o.* FROM organizations o JOIN workspaces w ON w.organization_id = o.id WHERE w.id = ?').get(t.workspace_id);
  const out = { total: 0, trigger_ready: 0, activate_ready: 0, online: 0, unreachable: [] };
  for (const d of deviceRowsInScope(db, triggerId)) {
    out.total++;
    const r = reasonsFor(t, org, d);
    const actBlock = r.activate.filter((x) => x !== 'offline');
    if (!r.trigger.length) out.trigger_ready++;
    if (!actBlock.length) { out.activate_ready++; if (d.status === 'online') out.online++; }
    if (r.trigger.length || r.activate.length) {
      out.unreachable.push({ device_id: d.id, name: d.name, workspace: d.workspace_name, reasons: r.trigger, activate_reasons: r.activate });
    }
  }
  return out;
}

/** Devices Activate now switches over (eligible, online or not) and the ones it can't, with why. */
function activationTargets(db, triggerId) {
  db = db || dbOf();
  const t = db.prepare('SELECT * FROM triggers WHERE id = ?').get(triggerId);
  if (!t) return { eligible: [], not_eligible: [] };
  const org = db.prepare('SELECT o.* FROM organizations o JOIN workspaces w ON w.organization_id = o.id WHERE w.id = ?').get(t.workspace_id);
  const eligible = [];
  const notEligible = [];
  for (const d of deviceRowsInScope(db, triggerId)) {
    const block = reasonsFor(t, org, d).activate.filter((x) => x !== 'offline');
    if (block.length) notEligible.push({ device_id: d.id, reason: block[0], reasons: block });
    else eligible.push({ id: d.id, online: d.status === 'online' });
  }
  return { eligible, not_eligible: notEligible };
}

/* ── Installer sheet (§5.5) ─────────────────────────────────────────────────────────────────── */

const DEFAULT_HTTP_PORT = 8079;   // server/player/index.html: Number(triggerConfig.http_port) || 8079
const DEFAULT_UDP_PORT = 7847;    // …udp_port || 7847

function installerSheet(db, triggerId) {
  db = db || dbOf();
  const t = db.prepare('SELECT * FROM triggers WHERE id = ?').get(triggerId);
  if (!t) return null;
  const ipOf = db.prepare('SELECT local_ip FROM device_telemetry WHERE device_id = ? AND local_ip IS NOT NULL ORDER BY reported_at DESC LIMIT 1');
  const screens = deviceRowsInScope(db, triggerId).map((d) => {
    let ip = null;
    try { ip = ipOf.get(d.id)?.local_ip || null; } catch (_) { ip = null; }
    const httpPort = d.trigger_http_port || DEFAULT_HTTP_PORT;
    const udpPort = d.trigger_udp_port || DEFAULT_UDP_PORT;
    const host = ip || '<screen-ip>';
    const secret = d.trigger_secret || null;
    const lines = [];
    if (secret) {
      const q = (tok) => `secret=${encodeURIComponent(secret)}&token=${encodeURIComponent(tok)}`;
      if (t.source_http && d.triggers_accept_http) {
        lines.push({ kind: 'http_fire', line: `curl -s "http://${host}:${httpPort}/?${q(t.match_token)}"` });
        if (t.clear_token) lines.push({ kind: 'http_clear', line: `curl -s "http://${host}:${httpPort}/?${q(t.clear_token)}"` });
      }
      if (t.source_udp && d.triggers_accept_udp) {
        lines.push({ kind: 'udp_fire', line: `printf 'ST1 ${secret} ${t.match_token}' | nc -u -w1 ${host} ${udpPort}` });
        if (t.clear_token) lines.push({ kind: 'udp_clear', line: `printf 'ST1 ${secret} ${t.clear_token}' | nc -u -w1 ${host} ${udpPort}` });
      }
    }
    return {
      device_id: d.id, workspace: d.workspace_name, screen: d.name, lan_ip: ip,
      accept_http: !!d.triggers_accept_http, accept_udp: !!d.triggers_accept_udp,
      http_port: httpPort, udp_port: udpPort, secret, lines,
    };
  });
  return {
    trigger: { id: t.id, name: t.name, match_token: t.match_token, clear_token: t.clear_token || null, source_http: !!t.source_http, source_udp: !!t.source_udp },
    screens,
  };
}

/** Rotate the trigger secret of every screen in scope. Returns the device ids rotated. */
function rotateSecrets(db, triggerId) {
  db = db || dbOf();
  const crypto = require('crypto');
  const ids = deviceRowsInScope(db, triggerId).map((d) => d.id);
  const upd = db.prepare("UPDATE devices SET trigger_secret = ?, updated_at = strftime('%s','now') WHERE id = ?");
  db.transaction(() => { for (const id of ids) upd.run(crypto.randomBytes(16).toString('hex'), id); })();
  return ids;
}

/* ── Store-trigger policy impact (§5.3) ─────────────────────────────────────────────────────── */

/**
 * Store triggers that a policy would cap ('leased') or hide ('off') on the org's mandated screens.
 * Empty when nothing is mandated (the policy only ever touches mandated screens).
 */
function storeTriggerImpact(db, orgId, policy, cap) {
  db = db || dbOf();
  if (policy !== 'leased' && policy !== 'off') return [];
  if (!require('./runtime').active(db)) return [];
  let mandated;
  try {
    mandated = db.prepare(`SELECT r.device_id FROM device_resolved_playlist r JOIN devices d ON d.id = r.device_id
        JOIN workspaces w ON w.id = d.workspace_id WHERE w.organization_id = ? AND r.source = 'corporate'`).all(orgId).map((r) => r.device_id);
  } catch (_) { return []; }
  if (!mandated.length) return [];
  const mset = new Set(mandated);
  const rows = db.prepare(`SELECT t.*, w.name AS workspace_name FROM triggers t JOIN workspaces w ON w.id = t.workspace_id
      WHERE w.organization_id = ? AND t.kind = 'normal' AND t.enabled = 1 ORDER BY w.name, t.name`).all(orgId);
  const out = [];
  const { devicesForTrigger } = require('../device-triggers');
  for (const t of rows) {
    const screens = devicesForTrigger(db, t.id).filter((id) => mset.has(id)).length;
    if (!screens) continue;
    let affected = policy === 'off';
    if (policy === 'leased') {
      affected = t.mode === 'until_cleared' ? (!t.lease_sec || t.lease_sec > cap) : (!t.max_duration_sec || t.max_duration_sec > cap);
    }
    if (!affected) continue;
    out.push({
      trigger_id: t.id, name: t.name, workspace_id: t.workspace_id, workspace_name: t.workspace_name,
      mode: t.mode, lease_sec: t.lease_sec == null ? null : t.lease_sec, max_duration_sec: t.max_duration_sec || 0, screens,
    });
  }
  return out;
}

module.exports = {
  SCOPE_KINDS, TOKEN_RE, isEmergency, scopesOf, validateScopes, setScopes, devicesForScopes, tokenClash,
  clearAllClash, lockingTriggers, assertTriggerSettingsWritable, coverage, activationTargets, reasonsFor,
  installerSheet, rotateSecrets, storeTriggerImpact, platformCannotTrigger, DEFAULT_HTTP_PORT, DEFAULT_UDP_PORT,
};
