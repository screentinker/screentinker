'use strict';

/*
 * /api/corporate/emergency — head office EMERGENCY ALERTS (spec §5). Registered on the corporate
 * router (routes/corporate.js), so it inherits its mount: JWT-only (D12; an API token gets 403
 * CORPORATE_TOKEN), tenancy resolved. Every route is for the organization's owners and admins (and
 * platform admins); anyone else gets 403 CORPORATE_EMERGENCY.
 *
 *   GET    /emergency                      every alert, with scope, coverage and any live activation
 *   POST   /emergency                      create (a triggers row, kind 'emergency', in the HQ workspace)
 *   PUT    /emergency/:id                  edit (partial)
 *   DELETE /emergency/:id                  delete (ends a live activation first)
 *   GET    /emergency/:id/coverage         who it reaches, and why not, per screen
 *   GET    /emergency/:id/installer-sheet  per screen: IP, ports, secret, codes, ready curl/UDP lines (audited)
 *   POST   /emergency/:id/rotate-secrets   new trigger secret on every screen in scope (audited)
 *   POST   /emergency/:id/activate         "Activate now": {duration_sec 60..3600}
 *   POST   /emergency/:id/clear            end the live activation
 *
 * ⚠️ Emergency alerts do not depend on the corporate resolver views, so — unlike the rest of
 * /api/corporate — these routes keep working in degraded mode (§2.7).
 *
 * Two ways to set one off, both only on screens with triggers enabled (the user's rule): the store's
 * alarm system sends the alert's code to the screen over the LAN (works with the WAN down; the
 * installer sheet is how a store gets what it needs), or an admin presses Activate now (works for
 * screens that are online; offline ones get it when they reconnect while it is live).
 */

const { db } = require('../db/database');
const { v4: uuidv4 } = require('uuid');
const guard = require('../lib/corporate/guard');
const em = require('../lib/corporate/emergency');
const live = require('../lib/corporate/emergency-live');
const { validateTriggerBody, columnsFrom } = require('../lib/trigger-validate');

const noCodes = (r) => ({ ...r, match_token: undefined, clear_token: undefined, codes_changed: undefined });

function register(router, h) {
  const { loadOrg, refuse, auditCorp } = h;

  /** Org owner/admin (JWT) or refuse. Returns the org, or null when a response was sent. */
  function adminOrg(req, res) {
    const org = loadOrg(req, res);
    if (!org) return null;
    if (req.viaToken) { refuse(res, 'CORPORATE_TOKEN'); return null; }
    if (!guard.isOrgAdmin(req, org.id)) { refuse(res, 'CORPORATE_EMERGENCY'); return null; }
    return org;
  }

  function loadAlert(req, res, org) {
    const t = db.prepare(`SELECT t.* FROM triggers t JOIN workspaces w ON w.id = t.workspace_id
        WHERE t.id = ? AND t.kind = 'emergency' AND w.organization_id = ?`).get(req.params.id, org.id);
    if (!t) { res.status(404).json({ error: 'Emergency alert not found' }); return null; }
    return t;
  }

  function view(t, { withCoverage = true } = {}) {
    const out = {
      ...t,
      source_http: !!t.source_http, source_udp: !!t.source_udp, enabled: !!t.enabled,
      scopes: em.scopesOf(db, t.id),
      active_activation: live.liveFor(t.id),
      // 'missing' | 'unpublished' | 'empty' | null — it would fire and show nothing (lib/corporate/reconcile.js).
      target_problem: require('../lib/corporate/reconcile').emergencyTargetProblem(db, t),
    };
    if (withCoverage) {
      const c = em.coverage(db, t.id);
      out.coverage = c ? { total: c.total, trigger_ready: c.trigger_ready, activate_ready: c.activate_ready, online: c.online } : null;
    }
    return out;
  }

  function pushAround(req, before, triggerId) {
    const { devicesForTrigger } = require('../lib/device-triggers');
    const ids = new Set(before || []);
    for (const id of devicesForTrigger(db, triggerId)) ids.add(id);
    require('../lib/corporate/fanout').pushDevices(req, [...ids]);
    return ids.size;
  }

  /** Validate a full (merged) body. Returns null or sends the error. */
  function validateAlert(req, res, org, body, { id = null } = {}) {
    if (!org.hq_workspace_id) {
      res.status(400).json({ error: 'Choose a head office workspace first (Settings → Organization → Corporate content) — emergency alerts and their playlists live there.' });
      return null;
    }
    const bad = validateTriggerBody(db, org.hq_workspace_id, body, { id, kind: 'emergency' });
    if (bad) { res.status(400).json({ error: bad }); return null; }
    const sc = em.validateScopes(db, org.id, body.scopes);
    if (!sc.ok) { res.status(sc.status).json({ error: sc.error, ...(sc.code ? { code: sc.code } : {}) }); return null; }
    const scopeRows = sc.rows || em.scopesOf(db, id || '').map((r) => ({ scope_kind: r.scope_kind, scope_id: r.scope_id }));
    const clash = em.tokenClash(db, org.id, [body.match_token, body.clear_token], { id, scopeRows });
    if (clash) { res.status(clash.status).json({ error: clash.error, code: clash.code }); return null; }
    return { scopeRows: sc.rows };
  }

  router.get('/emergency', (req, res) => {
    const org = adminOrg(req, res);
    if (!org) return;
    const rows = db.prepare(`SELECT t.* FROM triggers t JOIN workspaces w ON w.id = t.workspace_id
        WHERE t.kind = 'emergency' AND w.organization_id = ? ORDER BY t.priority DESC, t.name`).all(org.id);
    res.json({ enabled_for_org: !!org.emergency_triggers_enabled, hq_workspace_id: org.hq_workspace_id || null, triggers: rows.map((t) => view(t)) });
  });

  router.post('/emergency', (req, res) => {
    const org = adminOrg(req, res);
    if (!org) return;
    const b = { ...(req.body || {}) };
    if (b.mode === undefined) b.mode = 'until_cleared';
    const ok = validateAlert(req, res, org, b);
    if (!ok) return;
    const id = uuidv4();
    const c = columnsFrom(b, { kind: 'emergency' });
    db.transaction(() => {
      db.prepare(`INSERT INTO triggers
          (id, workspace_id, name, match_token, clear_token, source_http, source_udp,
           target_kind, target_ref, position, width, height, opacity, border_radius,
           mode, max_duration_sec, lease_sec, priority, enabled, kind)
          VALUES (@id, @workspace_id, @name, @match_token, @clear_token, @source_http, @source_udp,
                  @target_kind, @target_ref, @position, @width, @height, @opacity, @border_radius,
                  @mode, @max_duration_sec, @lease_sec, @priority, @enabled, 'emergency')`)
        .run({ id, workspace_id: org.hq_workspace_id, ...c });
      em.setScopes(db, id, ok.scopeRows || []);
    })();
    const t = db.prepare('SELECT * FROM triggers WHERE id = ?').get(id);
    const screens = pushAround(req, [], id);
    auditCorp(req, 'corporate.emergency.create', { organization_id: org.id, workspace_id: org.hq_workspace_id, trigger_id: id, name: c.name, scopes: ok.scopeRows || [], screens });
    console.log(`[emergency] created ${id} "${c.name}" mode=${c.mode}`);
    res.status(201).json(view(t));
  });

  router.put('/emergency/:id', (req, res) => {
    const org = adminOrg(req, res);
    if (!org) return;
    const existing = loadAlert(req, res, org);
    if (!existing) return;
    const b0 = req.body || {};
    // Partial: anything not sent keeps its stored value.
    const merged = {
      name: existing.name, match_token: existing.match_token, clear_token: existing.clear_token,
      source_http: existing.source_http, source_udp: existing.source_udp, target_kind: existing.target_kind,
      target_ref: existing.target_ref, mode: existing.mode, max_duration_sec: existing.max_duration_sec,
      lease_sec: existing.lease_sec, priority: existing.priority, enabled: existing.enabled,
      ...b0,
    };
    // Switching mode drops the other mode's field rather than refusing the stored value.
    if (b0.mode && b0.mode !== existing.mode) {
      if (b0.mode === 'once' && b0.lease_sec === undefined) merged.lease_sec = null;
      if (b0.mode === 'until_cleared' && b0.max_duration_sec === undefined) merged.max_duration_sec = null;
    }
    if (merged.mode === 'until_cleared' && (merged.max_duration_sec === 0)) merged.max_duration_sec = null;
    const ok = validateAlert(req, res, org, merged, { id: existing.id });
    if (!ok) return;
    const { devicesForTrigger } = require('../lib/device-triggers');
    const before = devicesForTrigger(db, existing.id);
    const c = columnsFrom(merged, { kind: 'emergency' });
    db.transaction(() => {
      db.prepare(`UPDATE triggers SET
          name=@name, match_token=@match_token, clear_token=@clear_token,
          source_http=@source_http, source_udp=@source_udp, target_kind=@target_kind, target_ref=@target_ref,
          mode=@mode, max_duration_sec=@max_duration_sec, lease_sec=@lease_sec, priority=@priority, enabled=@enabled,
          updated_at=strftime('%s','now') WHERE id=@id`).run({ id: existing.id, ...c });
      if (ok.scopeRows) em.setScopes(db, existing.id, ok.scopeRows);
    })();
    // Turning an alert off ends it if it is live: an "off" alert must not keep a screen.
    if (!c.enabled && live.liveFor(existing.id)) live.end(db, existing.id, { userId: req.user.id, reason: 'disabled' });
    const screens = pushAround(req, before, existing.id);
    const action = b0.enabled !== undefined && !!b0.enabled !== !!existing.enabled
      ? (c.enabled ? 'corporate.emergency.enable' : 'corporate.emergency.disable') : 'corporate.emergency.update';
    auditCorp(req, action, {
      organization_id: org.id, workspace_id: existing.workspace_id, trigger_id: existing.id, name: c.name, screens,
      // The codes stay out of the activity log: HQ members who are not admins can read it.
      before: noCodes(existing), after: noCodes(c), scopes: ok.scopeRows || undefined,
    });
    res.json(view(db.prepare('SELECT * FROM triggers WHERE id = ?').get(existing.id)));
  });

  router.delete('/emergency/:id', (req, res) => {
    const org = adminOrg(req, res);
    if (!org) return;
    const existing = loadAlert(req, res, org);
    if (!existing) return;
    if (live.liveFor(existing.id)) live.end(db, existing.id, { userId: req.user.id, reason: 'deleted' });
    // ⚠️ Read the screens BEFORE the row goes: the scope rows cascade with it.
    const { devicesForTrigger } = require('../lib/device-triggers');
    const before = devicesForTrigger(db, existing.id);
    db.prepare('DELETE FROM triggers WHERE id = ?').run(existing.id);
    require('../lib/corporate/fanout').pushDevices(req, before);
    auditCorp(req, 'corporate.emergency.delete', { organization_id: org.id, workspace_id: existing.workspace_id, trigger_id: existing.id, name: existing.name, screens: before.length });
    res.json({ success: true });
  });

  router.get('/emergency/:id/coverage', (req, res) => {
    const org = adminOrg(req, res);
    if (!org) return;
    const t = loadAlert(req, res, org);
    if (!t) return;
    res.json({ ...em.coverage(db, t.id), target_problem: require('../lib/corporate/reconcile').emergencyTargetProblem(db, t) });
  });

  router.get('/emergency/:id/installer-sheet', (req, res) => {
    const org = adminOrg(req, res);
    if (!org) return;
    const t = loadAlert(req, res, org);
    if (!t) return;
    const sheet = em.installerSheet(db, t.id);
    // The one place head office reads every in-scope screen's secret: every read is on record.
    auditCorp(req, 'corporate.emergency.sheet', { organization_id: org.id, workspace_id: t.workspace_id, trigger_id: t.id, screens: sheet.screens.length });
    res.json(sheet);
  });

  router.post('/emergency/:id/rotate-secrets', (req, res) => {
    const org = adminOrg(req, res);
    if (!org) return;
    const t = loadAlert(req, res, org);
    if (!t) return;
    // A secret a store learnt before head office took over stops working everywhere in scope.
    const ids = em.rotateSecrets(db, t.id);
    require('../lib/corporate/fanout').pushDevices(req, ids);
    auditCorp(req, 'corporate.emergency.rotate', { organization_id: org.id, workspace_id: t.workspace_id, trigger_id: t.id, screens: ids.length });
    res.json({ success: true, rotated: ids.length, ...em.installerSheet(db, t.id) });
  });

  router.post('/emergency/:id/activate', (req, res) => {
    const org = adminOrg(req, res);
    if (!org) return;
    const t = loadAlert(req, res, org);
    if (!t) return;
    if (!org.emergency_triggers_enabled) return refuse(res, 'CORPORATE_EMERGENCY_OFF');
    if (!t.enabled) return refuse(res, 'CORPORATE_EMERGENCY_DISABLED', { name: t.name });
    if (live.liveFor(t.id)) return refuse(res, 'CORPORATE_EMERGENCY_ACTIVE', { name: t.name });
    const b = req.body || {};
    const dur = Number(b.duration_sec);
    if (b.duration_sec === undefined || b.duration_sec === null || !Number.isInteger(dur) || dur < live.minSec() || dur > live.MAX_SEC) {
      return res.status(400).json({ error: `duration_sec is required: ${live.minSec()}-${live.MAX_SEC} seconds. An alert started from here always ends on its own.` });
    }
    live.setIo(req.app && req.app.get('io'));
    const out = live.activate(db, t, { userId: req.user.id, durationSec: dur });
    auditCorp(req, 'corporate.emergency.activate', {
      organization_id: org.id, workspace_id: t.workspace_id, trigger_id: t.id, name: t.name, duration_sec: dur,
      note: b.note ? String(b.note).slice(0, 500) : null, activation_id: out.activation.id,
      online: out.reached.online, offline: out.reached.offline_will_get_on_reconnect, not_eligible: out.reached.not_eligible.length,
    });
    res.status(201).json(out);
  });

  router.post('/emergency/:id/clear', (req, res) => {
    const org = adminOrg(req, res);
    if (!org) return;
    const t = loadAlert(req, res, org);
    if (!t) return;
    live.setIo(req.app && req.app.get('io'));
    const out = live.end(db, t.id, { userId: req.user.id, reason: 'cleared' });
    if (out) auditCorp(req, 'corporate.emergency.clear', { organization_id: org.id, workspace_id: t.workspace_id, trigger_id: t.id, name: t.name, activation_id: out.activation.id, screens: out.screens });
    res.json({ success: true, ended: !!out, activation: out ? out.activation : null });
  });
}

module.exports = { register };
