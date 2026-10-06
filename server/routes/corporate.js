'use strict';

/*
 * /api/corporate — head office (corporate) playlists: settings, the corporate playlists
 * themselves, and "Where it plays" (mandates). JWT-only (config/api-surface.js, decision D12).
 *
 * Stage B (spec 10, §9): local slots, the stores' content that fills them and the per-store
 * composition live in routes/corporate-slots.js, registered on this router below. Stage C:
 * emergency alerts live in routes/corporate-emergency.js (registered the same way); this router
 * holds their org switch and the store-trigger policy (settings).
 *
 * Every write is audited (activity_log, action `corporate.*`), with before/after for mandates.
 * Every write answers 503 CORPORATE_UNAVAILABLE in degraded mode (the per-boot resolver check
 * failed; lib/corporate/runtime.js) — reads keep working so an admin can see what is configured.
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { resourceAccess } = require('../lib/tenancy');
const guard = require('../lib/corporate/guard');
const runtime = require('../lib/corporate/runtime');
const fanout = require('../lib/corporate/fanout');
const resolve = require('../lib/corporate/resolve');
const { audit } = require('../lib/audit');
const { MANDATE_EXPR } = require('../lib/playlist-resolver-sql');

const TARGET_KINDS = new Set(['org', 'workspace', 'group', 'wall', 'device']);
const AUTHOR_MODES = new Set(['org_admins', 'org_admins_and_hq_editors']);

function loadOrg(req, res) {
  if (!req.organizationId) { res.status(403).json({ error: 'No organization context' }); return null; }
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.organizationId);
  if (!org) { res.status(404).json({ error: 'Organization not found' }); return null; }
  return org;
}

function refuse(res, code, vars, details, status) {
  const e = guard.err(code, vars, details, status);
  return guard.send(res, e) || true;
}

function requireAvailable(res) {
  if (runtime.isViewsDegraded()) { refuse(res, 'CORPORATE_UNAVAILABLE'); return false; }
  return true;
}

function requireAdmin(req, res, org) {
  if (req.viaToken) { refuse(res, 'CORPORATE_TOKEN'); return false; }
  if (!guard.isOrgAdmin(req, org.id)) { refuse(res, 'CORPORATE_ADMIN_REQUIRED'); return false; }
  return true;
}

function requireAuthor(req, res, org) {
  if (req.viaToken) { refuse(res, 'CORPORATE_TOKEN'); return false; }
  if (!guard.canAuthor(req, org.id)) { refuse(res, 'CORPORATE_AUTHOR_REQUIRED'); return false; }
  return true;
}

// Read access to corporate playlists: authors, org admins, and members of the HQ workspace.
function canReadHq(req, org) {
  if (guard.canAuthor(req, org.id) || guard.isOrgAdmin(req, org.id) || req.isPlatformStaff) return true;
  if (!org.hq_workspace_id) return false;
  return !!db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(org.hq_workspace_id, req.user.id);
}

function orgWorkspaces(orgId) {
  return db.prepare('SELECT id, name FROM workspaces WHERE organization_id = ? ORDER BY name').all(orgId);
}

function playlistScreens(playlistId) {
  try {
    return db.prepare("SELECT COUNT(*) AS n FROM device_resolved_playlist WHERE playlist_id = ? AND source = 'corporate'").get(playlistId).n;
  } catch (_) { return 0; }
}

function auditCorp(req, action, details) {
  audit(action, { userId: req.user && req.user.id, workspaceId: details && details.workspace_id || req.workspaceId || null, ip: req.ip || null, details });
}

/*
 * Local slots, fills and reports (routes/corporate-slots.js). Declared here, ABOVE every route, so no
 * handler can ever reach `helpers` in its temporal dead zone; the functions it names are hoisted.
 */
const helpers = { loadOrg, refuse, requireAvailable, requireAdmin, requireAuthor, auditCorp, loadHqPlaylist, canReadHq };
require('./corporate-slots').register(router, helpers);
require('./corporate-emergency').register(router, helpers);

/* ──────────────────────────────────────────────────────────────────── settings */

router.get('/settings', (req, res) => {
  const org = loadOrg(req, res);
  if (!org) return;
  const isAdmin = guard.isOrgAdmin(req, org.id);
  const hq = org.hq_workspace_id ? db.prepare('SELECT id, name FROM workspaces WHERE id = ?').get(org.hq_workspace_id) : null;
  let activeMandated = false;
  try {
    activeMandated = runtime.active(db) && !!db.prepare(`SELECT 1 FROM devices d JOIN device_resolved_playlist r ON r.device_id = d.id
       WHERE d.workspace_id = ? AND r.source = 'corporate' LIMIT 1`).get(req.workspaceId);
  } catch (_) { activeMandated = false; }
  const out = {
    organization_id: org.id,
    organization_name: org.name,
    corporate_enabled: !!org.corporate_enabled,
    hq_workspace_id: org.hq_workspace_id || null,
    hq_workspace_name: hq ? hq.name : null,
    corporate_authors: org.corporate_authors || 'org_admins',
    emergency_triggers_enabled: !!org.emergency_triggers_enabled,
    store_triggers_under_mandate: org.store_triggers_under_mandate || 'off',
    store_trigger_cap_sec: org.store_trigger_cap_sec || 300,
    available: !runtime.isViewsDegraded(),
    can_author: guard.canAuthor(req, org.id) && !req.viaToken,
    is_admin: isAdmin && !req.viaToken,
    active_workspace_is_hq: !!org.hq_workspace_id && org.hq_workspace_id === req.workspaceId,
    active_workspace_mandated: activeMandated,
  };
  if (isAdmin) {
    out.workspaces = orgWorkspaces(org.id).map((w) => ({ ...w, replicated: guard.isReplicatedWorkspace(db, w.id) }));
    out.corporate_playlists = db.prepare(`SELECT COUNT(*) AS n FROM playlists p JOIN workspaces w ON w.id = p.workspace_id
        WHERE p.corporate = 1 AND w.organization_id = ?`).get(org.id).n;
    out.mandates = db.prepare('SELECT COUNT(*) AS n FROM corporate_mandates WHERE organization_id = ?').get(org.id).n;
  }
  res.json(out);
});

const STORE_TRIGGER_POLICIES = new Set(['allow', 'leased', 'off']);
const EMERGENCY_KEYS = ['emergency_triggers_enabled'];

/** Devices of an org whose resolved playlist is head office's (mandated), for a policy push. */
function mandatedDevicesOfOrg(orgId) {
  if (!runtime.active(db)) return [];
  try {
    return db.prepare(`SELECT r.device_id FROM device_resolved_playlist r JOIN devices d ON d.id = r.device_id
        JOIN workspaces w ON w.id = d.workspace_id WHERE w.organization_id = ? AND r.source = 'corporate'`).all(orgId).map((r) => r.device_id);
  } catch (_) { return []; }
}

/** Every device of an org in the scope of any of its emergency alerts. */
function emergencyScopedDevicesOfOrg(orgId) {
  const { devicesInEmergencyScope } = require('../lib/device-triggers');
  const ids = new Set();
  for (const t of db.prepare(`SELECT t.id FROM triggers t JOIN workspaces w ON w.id = t.workspace_id
      WHERE w.organization_id = ? AND t.kind = 'emergency'`).all(orgId)) {
    for (const id of devicesInEmergencyScope(db, t.id)) ids.add(id);
  }
  return [...ids];
}

/*
 * What head office's store-trigger policy would change (§5.3): every store trigger that a policy
 * would cap ('leased') or hide ('off') on the org's mandated screens — including until_cleared ones
 * fired by one-shot senders such as evacuation relays, which would END after the cap. The settings
 * PUT requires acknowledge_impact: true whenever this list is not empty.
 */
router.get('/settings/store-trigger-impact', (req, res) => {
  const org = loadOrg(req, res);
  if (!org) return;
  if (!requireAdmin(req, res, org)) return;
  const policy = String(req.query.policy || '');
  if (!STORE_TRIGGER_POLICIES.has(policy)) return res.status(400).json({ error: 'policy must be one of: allow, leased, off' });
  const cap = req.query.cap_sec !== undefined ? Number(req.query.cap_sec) : (org.store_trigger_cap_sec || 300);
  if (!Number.isInteger(cap) || cap < 30 || cap > 3600) return res.status(400).json({ error: 'cap_sec must be 30-3600' });
  const impact = require('../lib/corporate/emergency').storeTriggerImpact(db, org.id, policy, cap);
  res.json({ policy, cap_sec: cap, impact, workspaces: [...new Set(impact.map((i) => i.workspace_id))].length });
});

router.put('/settings', (req, res) => {
  const org = loadOrg(req, res);
  if (!org) return;
  const b = req.body || {};
  /*
   * Emergency alerts do not depend on the resolver views, so the emergency switch keeps working in
   * degraded mode (§2.7); everything else here is corporate-playlist machinery and answers 503.
   */
  const onlyEmergency = Object.keys(b).every((k) => EMERGENCY_KEYS.includes(k));
  if (!onlyEmergency && !requireAvailable(res)) return;
  if (!requireAdmin(req, res, org)) return;

  const next = {
    corporate_enabled: b.corporate_enabled !== undefined ? (b.corporate_enabled ? 1 : 0) : (org.corporate_enabled ? 1 : 0),
    hq_workspace_id: b.hq_workspace_id !== undefined ? (b.hq_workspace_id || null) : (org.hq_workspace_id || null),
    corporate_authors: b.corporate_authors !== undefined ? b.corporate_authors : (org.corporate_authors || 'org_admins'),
    emergency_triggers_enabled: b.emergency_triggers_enabled !== undefined ? (b.emergency_triggers_enabled ? 1 : 0) : (org.emergency_triggers_enabled ? 1 : 0),
    store_triggers_under_mandate: b.store_triggers_under_mandate !== undefined ? b.store_triggers_under_mandate : (org.store_triggers_under_mandate || 'off'),
    store_trigger_cap_sec: b.store_trigger_cap_sec !== undefined ? Number(b.store_trigger_cap_sec) : (org.store_trigger_cap_sec || 300),
  };
  if (!AUTHOR_MODES.has(next.corporate_authors)) {
    return res.status(400).json({ error: `corporate_authors must be one of: ${[...AUTHOR_MODES].join(', ')}` });
  }
  if (!STORE_TRIGGER_POLICIES.has(next.store_triggers_under_mandate)) {
    return res.status(400).json({ error: 'store_triggers_under_mandate must be one of: allow, leased, off' });
  }
  if (!Number.isInteger(next.store_trigger_cap_sec) || next.store_trigger_cap_sec < 30 || next.store_trigger_cap_sec > 3600) {
    return res.status(400).json({ error: 'store_trigger_cap_sec must be a whole number of seconds, 30-3600' });
  }
  if (next.hq_workspace_id !== (org.hq_workspace_id || null)) {
    if (next.hq_workspace_id) {
      const ws = db.prepare('SELECT id, name, organization_id FROM workspaces WHERE id = ?').get(next.hq_workspace_id);
      if (!ws || ws.organization_id !== org.id) return res.status(400).json({ error: 'The head office workspace must be one of this organization\'s workspaces.' });
      if (guard.isReplicatedWorkspace(db, ws.id)) return refuse(res, 'CORPORATE_MESH_UNSUPPORTED', { workspace: `"${ws.name}"` });
    }
    // Locked once corporate playlists exist: they live in the HQ workspace, and moving the label
    // would leave them corporate in a workspace that is no longer head office. Emergency alerts
    // live there too.
    if (org.hq_workspace_id) {
      const n = db.prepare('SELECT COUNT(*) AS n FROM playlists WHERE workspace_id = ? AND corporate = 1').get(org.hq_workspace_id).n;
      if (n) {
        return res.status(409).json({
          code: 'CORPORATE_HQ_LOCKED',
          error: `The head office workspace can't be changed while it holds ${n} corporate playlist${n === 1 ? '' : 's'}. Make them ordinary playlists first.`,
        });
      }
      const e = db.prepare("SELECT COUNT(*) AS n FROM triggers WHERE workspace_id = ? AND kind = 'emergency'").get(org.hq_workspace_id).n;
      if (e) {
        return res.status(409).json({
          code: 'CORPORATE_HQ_LOCKED',
          error: `The head office workspace can't be changed while it holds ${e} emergency alert${e === 1 ? '' : 's'}. Delete them first.`,
        });
      }
    }
  }
  if (next.corporate_enabled && !next.hq_workspace_id) {
    return res.status(400).json({ error: 'Choose a head office workspace before turning corporate playlists on.' });
  }

  /*
   * Store-trigger policy: limiting or hiding store triggers on head office's screens can END a store's
   * own safety notice (an evacuation relay that sends once). The admin must have seen the list.
   */
  const policyChanged = next.store_triggers_under_mandate !== (org.store_triggers_under_mandate || 'off')
    || (next.store_triggers_under_mandate === 'leased' && next.store_trigger_cap_sec !== (org.store_trigger_cap_sec || 300));
  let impact = [];
  if (policyChanged && next.store_triggers_under_mandate !== 'allow') {
    impact = require('../lib/corporate/emergency').storeTriggerImpact(db, org.id, next.store_triggers_under_mandate, next.store_trigger_cap_sec);
  }
  /*
   * Switching corporate playlists ON (or moving head office) can bring screens under existing
   * mandates at once. Under 'off'/'leased' that hides or caps their store triggers, so it is asked
   * exactly like a policy change: simulate the write, list what it newly covers.
   */
  const coverageMayGrow = (next.corporate_enabled && !org.corporate_enabled) || next.hq_workspace_id !== (org.hq_workspace_id || null);
  if (coverageMayGrow && next.store_triggers_under_mandate !== 'allow' && !runtime.isViewsDegraded()) {
    const sim = simulate(org, [], () => {
      db.prepare(`UPDATE organizations SET corporate_enabled = ?, hq_workspace_id = ?, store_triggers_under_mandate = ?, store_trigger_cap_sec = ? WHERE id = ?`)
        .run(next.corporate_enabled, next.hq_workspace_id, next.store_triggers_under_mandate, next.store_trigger_cap_sec, org.id);
    }, (newlyCovered) => storeTriggersNewlyAffected(org, newlyCovered, next.store_triggers_under_mandate, next.store_trigger_cap_sec));
    const seen = new Set(impact.map((i) => i.trigger_id));
    for (const i of (sim && sim.inspected) || []) if (!seen.has(i.trigger_id)) impact.push(i);
  }
  if (impact.length && b.acknowledge_impact !== true) {
    return refuse(res, 'CORPORATE_IMPACT_UNACKNOWLEDGED', { n: impact.length }, { impact });
  }

  const before = {
    corporate_enabled: !!org.corporate_enabled, hq_workspace_id: org.hq_workspace_id || null, corporate_authors: org.corporate_authors,
    emergency_triggers_enabled: !!org.emergency_triggers_enabled,
    store_triggers_under_mandate: org.store_triggers_under_mandate || 'off', store_trigger_cap_sec: org.store_trigger_cap_sec || 300,
  };
  const emergencyChanged = next.emergency_triggers_enabled !== (org.emergency_triggers_enabled ? 1 : 0);
  // Who must hear about the emergency switch: turning it ON reaches every screen in an alert's scope;
  // turning it OFF must reach the same screens (to drop the definitions and their pinned media).
  const emergencyPush = emergencyChanged ? emergencyScopedDevicesOfOrg(org.id) : [];
  if (emergencyChanged && !next.emergency_triggers_enabled) {
    // Off ends any live "Activate now" first — its screens go back to their own playlist.
    require('../lib/corporate/emergency-live').endAllForOrg(db, org.id, { userId: req.user.id, reason: 'switch_off' });
  }
  const policyPushBefore = policyChanged ? mandatedDevicesOfOrg(org.id) : [];
  const write = () => {
    db.prepare(`UPDATE organizations SET corporate_enabled = ?, hq_workspace_id = ?, corporate_authors = ?,
        emergency_triggers_enabled = ?, store_triggers_under_mandate = ?, store_trigger_cap_sec = ? WHERE id = ?`)
      .run(next.corporate_enabled, next.hq_workspace_id, next.corporate_authors, next.emergency_triggers_enabled,
        next.store_triggers_under_mandate, next.store_trigger_cap_sec, org.id);
  };
  let changed = [];
  if (runtime.isViewsDegraded()) write();   // emergency-only (checked above): no resolution to diff
  else changed = fanout.withResolutionDiff(req, orgWorkspaces(org.id).map((w) => w.id), write).changed;
  const extra = [...new Set([...emergencyPush, ...policyPushBefore, ...(policyChanged ? mandatedDevicesOfOrg(org.id) : [])])]
    .filter((id) => !changed.includes(id));
  fanout.pushDevices(req, extra);

  const after = { ...next, corporate_enabled: !!next.corporate_enabled, emergency_triggers_enabled: !!next.emergency_triggers_enabled };
  auditCorp(req, 'corporate.settings', { organization_id: org.id, before, after, screens_changed: changed.length });
  if (emergencyChanged) {
    auditCorp(req, 'corporate.emergency.switch', { organization_id: org.id, enabled: !!next.emergency_triggers_enabled, screens: emergencyPush.length });
  }
  if (impact.length) {
    // The stores whose triggers this limits are told in their own activity feed.
    auditStoreTriggersLimited(req, org, impact, next.store_triggers_under_mandate, next.store_trigger_cap_sec, policyChanged ? 'policy' : 'coverage');
  }
  res.json({ success: true, screens_changed: changed.length, ...after, store_triggers_affected: impact.length });
});

/* ──────────────────────────────────────────────────────────── corporate playlists */

function corporatePlaylistRow(p) {
  const mandates = db.prepare('SELECT COUNT(*) AS n FROM corporate_mandates WHERE playlist_id = ?').get(p.id).n;
  const items = db.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?').get(p.id).n;
  // Slots placed in the draft (what the editor shows); a removed slot stays retired, not counted.
  const slots = db.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ? AND slot_id IS NOT NULL').get(p.id).n;
  return {
    id: p.id, name: p.name, description: p.description, status: p.status, workspace_id: p.workspace_id,
    corporate: true, item_count: items, slot_count: slots, places: mandates, screens: playlistScreens(p.id),
    has_published: p.published_snapshot !== null && p.published_snapshot !== undefined,
    updated_at: p.updated_at,
  };
}

router.get('/playlists', (req, res) => {
  const org = loadOrg(req, res);
  if (!org) return;
  if (!canReadHq(req, org)) return refuse(res, 'CORPORATE_AUTHOR_REQUIRED');
  const rows = db.prepare(`SELECT p.* FROM playlists p JOIN workspaces w ON w.id = p.workspace_id
      WHERE p.corporate = 1 AND w.organization_id = ? ORDER BY p.name`).all(org.id);
  res.json({ hq_workspace_id: org.hq_workspace_id || null, playlists: rows.map(corporatePlaylistRow) });
});

router.post('/playlists', (req, res) => {
  const org = loadOrg(req, res);
  if (!org) return;
  if (!requireAvailable(res) || !requireAuthor(req, res, org)) return;
  if (!org.hq_workspace_id) return res.status(400).json({ error: 'Choose a head office workspace first (Settings → Organization → Corporate content).' });
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = uuidv4();
  db.prepare('INSERT INTO playlists (id, user_id, workspace_id, name, description, corporate) VALUES (?, ?, ?, ?, ?, 1)')
    .run(id, req.user.id, org.hq_workspace_id, name, String((req.body && req.body.description) || '').trim());
  auditCorp(req, 'corporate.playlist.create', { organization_id: org.id, playlist_id: id, name, workspace_id: org.hq_workspace_id });
  res.status(201).json(corporatePlaylistRow(db.prepare('SELECT * FROM playlists WHERE id = ?').get(id)));
});

function loadHqPlaylist(req, res, org) {
  const p = db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id);
  if (!p || !org.hq_workspace_id || p.workspace_id !== org.hq_workspace_id) {
    res.status(404).json({ error: 'Playlist not found in the head office workspace' });
    return null;
  }
  return p;
}

router.post('/playlists/:id/promote', (req, res) => {
  const org = loadOrg(req, res);
  if (!org) return;
  if (!requireAvailable(res) || !requireAuthor(req, res, org)) return;
  const p = loadHqPlaylist(req, res, org);
  if (!p) return;
  if (p.corporate) return res.json(corporatePlaylistRow(p));
  if (p.smart_rules) return refuse(res, 'CORPORATE_SMART');
  if (p.is_auto_generated) return res.status(400).json({ error: 'A generated playlist (a schedule\'s or a screen\'s own) can\'t become corporate. Make a new corporate playlist instead.' });
  let deck = null;
  try { deck = db.prepare('SELECT 1 FROM slide_decks WHERE playlist_id = ? LIMIT 1').get(p.id); } catch (_) { deck = null; }
  if (deck) return res.status(400).json({ error: 'A slide deck\'s playlist can\'t become corporate. Put the deck inside a corporate playlist instead.' });
  if (db.prepare('SELECT 1 FROM playlist_items WHERE child_playlist_id = ? LIMIT 1').get(p.id)) return refuse(res, 'CORPORATE_NESTED');
  db.prepare('UPDATE playlists SET corporate = 1 WHERE id = ?').run(p.id);
  auditCorp(req, 'corporate.playlist.promote', { organization_id: org.id, playlist_id: p.id, name: p.name, workspace_id: p.workspace_id });
  res.json(corporatePlaylistRow(db.prepare('SELECT * FROM playlists WHERE id = ?').get(p.id)));
});

function mandatedRefusal(playlistId) {
  const rows = db.prepare('SELECT id, target_kind, target_id FROM corporate_mandates WHERE playlist_id = ?').all(playlistId);
  if (!rows.length) return null;
  return guard.err('CORPORATE_MANDATED', { n: rows.length, screens: playlistScreens(playlistId) },
    { mandates: rows.map((m) => ({ id: m.id, target_kind: m.target_kind, target_id: m.target_id, label: guard.targetLabel(db, m) })) });
}

router.post('/playlists/:id/demote', (req, res) => {
  const org = loadOrg(req, res);
  if (!org) return;
  if (!requireAvailable(res) || !requireAuthor(req, res, org)) return;
  const p = loadHqPlaylist(req, res, org);
  if (!p) return;
  if (!p.corporate) return res.json({ ...p, corporate: false });
  const refusal = mandatedRefusal(p.id);
  if (refusal) return guard.send(res, refusal, req);
  // Local slots exist only in corporate playlists (the backstop refuses a slot row anywhere else),
  // and stores' content hangs off them: they go first, explicitly.
  const slotCount = db.prepare('SELECT COUNT(*) AS n FROM corporate_slots WHERE playlist_id = ? AND retired_at IS NULL').get(p.id).n;
  if (slotCount) {
    return res.status(409).json({ code: 'CORPORATE_HAS_SLOTS', error: `This playlist has ${slotCount} local slot${slotCount === 1 ? '' : 's'}. Remove ${slotCount === 1 ? 'it' : 'them'} first — stores fill them with their own content.` });
  }
  // The composable is head office's view of this playlist; an ordinary playlist has none. Left in
  // place, a later promote would put this (by then stale) loop back on every mandated screen.
  db.prepare('UPDATE playlists SET corporate = 0, published_composable = NULL, published_composable_of = NULL, published_rev = published_rev + 1 WHERE id = ?').run(p.id);
  auditCorp(req, 'corporate.playlist.demote', { organization_id: org.id, playlist_id: p.id, name: p.name, workspace_id: p.workspace_id });
  res.json({ ...db.prepare('SELECT * FROM playlists WHERE id = ?').get(p.id), corporate: false });
});

router.get('/playlists/:id', (req, res) => {
  const org = loadOrg(req, res);
  if (!org) return;
  if (!canReadHq(req, org)) return refuse(res, 'CORPORATE_AUTHOR_REQUIRED');
  const p = loadHqPlaylist(req, res, org);
  if (!p) return;
  if (!p.corporate) return res.status(404).json({ error: 'Not a corporate playlist' });
  const slots = db.prepare('SELECT * FROM corporate_slots WHERE playlist_id = ? ORDER BY created_at, id').all(p.id).map((sl) => helpers.slotView(sl));
  res.json({ ...corporatePlaylistRow(p), mandates: listMandates(org.id).filter((m) => m.playlist_id === p.id), slots });
});

/* ──────────────────────────────────────────────────────────────────── mandates */

function targetRow(orgId, kind, id) {
  if (kind === 'org') return id === orgId ? { id, name: 'Whole organization', workspace_id: null } : null;
  if (kind === 'workspace') {
    const w = db.prepare('SELECT id, name, organization_id FROM workspaces WHERE id = ?').get(id);
    return w && w.organization_id === orgId ? { id: w.id, name: w.name, workspace_id: w.id } : null;
  }
  const table = kind === 'group' ? 'device_groups' : kind === 'wall' ? 'video_walls' : 'devices';
  const r = db.prepare(`SELECT t.id, t.name, t.workspace_id${kind === 'device' ? ', t.wall_id' : ''} FROM ${table} t
      JOIN workspaces w ON w.id = t.workspace_id WHERE t.id = ? AND w.organization_id = ?`).get(id, orgId);
  return r || null;
}

function listMandates(orgId) {
  return db.prepare(`SELECT cm.*, p.name AS playlist_name, l.name AS layout_name FROM corporate_mandates cm
      LEFT JOIN playlists p ON p.id = cm.playlist_id LEFT JOIN layouts l ON l.id = cm.layout_id
     WHERE cm.organization_id = ? ORDER BY cm.created_at`).all(orgId).map((m) => {
    const t = targetRow(orgId, m.target_kind, m.target_id);
    let screens = 0;
    try {
      screens = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT d.id, ${MANDATE_EXPR} AS mid FROM devices d
          WHERE d.workspace_id IN (SELECT id FROM workspaces WHERE organization_id = ?)) x WHERE x.mid = ?`).get(orgId, m.id).n;
    } catch (_) { screens = 0; }
    return {
      id: m.id, playlist_id: m.playlist_id, playlist_name: m.playlist_name || null, dark: !!m.dark,
      target_kind: m.target_kind, target_id: m.target_id, target_name: t ? t.name : null,
      target_label: guard.targetLabel(db, m), layout_id: m.layout_id || null, layout_name: m.layout_name || null,
      enabled: !!m.enabled, note: m.note || null, screens, created_by: m.created_by, created_at: m.created_at, updated_at: m.updated_at,
    };
  });
}

router.get('/mandates', (req, res) => {
  const org = loadOrg(req, res);
  if (!org) return;
  if (!guard.isOrgAdmin(req, org.id) && !guard.canAuthor(req, org.id)) return refuse(res, 'CORPORATE_ADMIN_REQUIRED');
  res.json({ mandates: listMandates(org.id) });
});

/**
 * Validate a mandate body against the org. Returns {error-response-sent} via res, or the normalised
 * row. `existing` is the row being updated (its own target does not count as "taken").
 */
function validateMandate(req, res, org, b, existing) {
  const kind = b.target_kind !== undefined ? b.target_kind : existing && existing.target_kind;
  const targetId = b.target_id !== undefined ? (b.target_id === null ? null : String(b.target_id))
    : existing ? existing.target_id : null;
  const tid = kind === 'org' ? org.id : targetId;
  if (!TARGET_KINDS.has(kind)) { res.status(400).json({ error: 'target_kind must be one of: org, workspace, group, wall, device' }); return null; }
  if (!tid) { res.status(400).json({ error: 'target_id required' }); return null; }
  const target = targetRow(org.id, kind, tid);
  if (!target) { res.status(404).json({ error: 'That target is not in this organization' }); return null; }
  if (kind === 'device' && target.wall_id) {
    const wall = db.prepare('SELECT name FROM video_walls WHERE id = ?').get(target.wall_id);
    refuse(res, 'CORPORATE_WALL_SPLIT', { wall: wall && wall.name }, { wall_id: target.wall_id });
    return null;
  }
  const taken = db.prepare(`SELECT cm.id, p.name FROM corporate_mandates cm LEFT JOIN playlists p ON p.id = cm.playlist_id
      WHERE cm.target_kind = ? AND cm.target_id = ?`).get(kind, tid);
  if (taken && (!existing || taken.id !== existing.id)) {
    const label = kind === 'org' ? 'The whole organization' : `${kind === 'wall' ? 'Video wall' : kind[0].toUpperCase() + kind.slice(1)} "${target.name}"`;
    refuse(res, 'CORPORATE_TARGET_TAKEN', { target: label, name: taken.name || 'turned off' }, { mandate_id: taken.id });
    return null;
  }

  const dark = b.dark !== undefined ? !!b.dark : !!(existing && existing.dark);
  let playlistId = b.playlist_id !== undefined ? (b.playlist_id || null) : existing ? existing.playlist_id : null;
  if (dark) playlistId = null;
  if (!dark) {
    if (!playlistId) { res.status(400).json({ error: 'playlist_id required (or dark: true to turn the screens off)' }); return null; }
    const p = db.prepare('SELECT id, workspace_id, corporate, published_snapshot FROM playlists WHERE id = ?').get(playlistId);
    if (!p || !p.corporate || p.workspace_id !== org.hq_workspace_id) {
      res.status(400).json({ error: 'playlist_id must be a corporate playlist in the head office workspace' }); return null;
    }
    if (p.published_snapshot === null || p.published_snapshot === undefined) { refuse(res, 'CORPORATE_NOT_PUBLISHED'); return null; }
  }
  const layoutId = b.layout_id !== undefined ? (b.layout_id || null) : existing ? existing.layout_id : null;
  if (layoutId) {
    const l = db.prepare('SELECT id FROM layouts WHERE id = ? AND (is_template = 1 OR workspace_id = ?)').get(layoutId, org.hq_workspace_id);
    if (!l) { res.status(400).json({ error: 'layout_id must be a layout in the head office workspace' }); return null; }
  }
  const wsIds = fanout.workspacesForTarget(db, org.id, kind, tid);
  for (const w of wsIds) {
    if (guard.isReplicatedWorkspace(db, w)) {
      const ws = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(w);
      refuse(res, 'CORPORATE_MESH_UNSUPPORTED', { workspace: `"${ws && ws.name}"` });
      return null;
    }
  }
  const enabled = b.enabled !== undefined ? (b.enabled ? 1 : 0) : existing ? existing.enabled : 1;
  const note = b.note !== undefined ? (b.note ? String(b.note).slice(0, 500) : null) : existing ? existing.note : null;
  return { kind, tid, dark: dark ? 1 : 0, playlistId, layoutId, enabled, note, wsIds, target };
}

/** The org's screens whose resolved source is head office's ('corporate'), read straight off the view. */
function corporateSourcedDevices(orgId) {
  try {
    return new Set(db.prepare(`SELECT r.device_id FROM device_resolved_playlist r JOIN devices d ON d.id = r.device_id
        JOIN workspaces w ON w.id = d.workspace_id WHERE w.organization_id = ? AND r.source = 'corporate'`).all(orgId).map((r) => r.device_id));
  } catch (_) { return new Set(); }
}

/**
 * Run `write` inside a transaction that is ALWAYS rolled back and report what it would do: which
 * screens' resolution changes (`changed`, over `wsIds`) and which screens it would NEWLY put under
 * head office (`newlyCovered`, across the whole org). The view itself answers, so a preview can
 * never disagree with what the save will do. `inspect(newlyCovered)` runs while the simulated state
 * is still in place (store-trigger assignments and policies are read there).
 */
function simulate(org, wsIds, write, inspect) {
  const ROLLBACK = new Error('preview-rollback');
  let out = null;
  try {
    db.transaction(() => {
      const before = fanout.snapshotResolution(db, wsIds);
      const coveredBefore = corporateSourcedDevices(org.id);
      write();
      const after = fanout.snapshotResolution(db, wsIds);
      const changed = [...after.keys()].filter((id) => before.get(id) !== after.get(id));
      const newlyCovered = [...corporateSourcedDevices(org.id)].filter((id) => !coveredBefore.has(id));
      out = { changed, newlyCovered, inspected: inspect ? inspect(newlyCovered) : undefined };
      throw ROLLBACK;
    })();
  } catch (e) { if (e !== ROLLBACK) throw e; }
  return out;
}

/*
 * The store triggers a change would hide or cap because it NEWLY brings their screens under head
 * office, under the org's current policy ('off' by default). Screens head office already drove
 * are not counted: nothing changes for their triggers. Empty under 'allow'.
 */
function storeTriggersNewlyAffected(org, newlyCovered, policy, cap) {
  const p = policy || org.store_triggers_under_mandate || 'off';
  if (p === 'allow' || !newlyCovered.length) return [];
  return require('../lib/corporate/emergency').storeTriggerImpact(db, org.id, p, cap || org.store_trigger_cap_sec || 300, newlyCovered);
}

function previewOf(org, v, mandateId) {
  const sim = simulate(org, v.wsIds, () => {
    if (mandateId) {
      db.prepare('UPDATE corporate_mandates SET playlist_id = ?, dark = ?, target_kind = ?, target_id = ?, layout_id = ?, enabled = ? WHERE id = ?')
        .run(v.playlistId, v.dark, v.kind, v.tid, v.layoutId, v.enabled, mandateId);
    } else {
      db.prepare('INSERT INTO corporate_mandates (id, organization_id, playlist_id, dark, target_kind, target_id, layout_id, enabled) VALUES (?,?,?,?,?,?,?,?)')
        .run('preview-' + uuidv4(), org.id, v.playlistId, v.dark, v.kind, v.tid, v.layoutId, v.enabled);
      db.prepare('UPDATE organizations SET corporate_enabled = 1 WHERE id = ?').run(org.id);
    }
  }, (newlyCovered) => storeTriggersNewlyAffected(org, newlyCovered));
  if (!sim) return null;
  return { ...summarise(sim.changed), store_triggers_affected: sim.inspected || [], store_trigger_policy: org.store_triggers_under_mandate || 'off' };
}

/**
 * Refuse a mandate save that would hide or cap store triggers without the admin having seen them
 * (409 CORPORATE_STORE_TRIGGERS_IMPACT, nothing written). Returns the acknowledged list, or null
 * when a refusal was sent.
 */
function requireMandateImpactAck(req, res, org, v, mandateId) {
  const pv = previewOf(org, v, mandateId);
  const impact = (pv && pv.store_triggers_affected) || [];
  if (impact.length && (req.body || {}).acknowledge_impact !== true) {
    refuse(res, 'CORPORATE_STORE_TRIGGERS_IMPACT', { n: impact.length }, { impact });
    return null;
  }
  return impact;
}

/** Each store whose triggers a change hides or caps hears about it in its own activity feed (lib/corporate/impact.js). */
function auditStoreTriggersLimited(req, org, impact, policy, cap, cause) {
  require('../lib/corporate/impact').auditLimited(req, org.id, impact, policy, cap, cause);
}

function summarise(deviceIds) {
  if (!deviceIds.length) return { screens: 0, workspaces: [], schedules: 0, screen_playlists: 0, store_layouts: 0 };
  const ph = deviceIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT d.id, d.workspace_id, d.playlist_source, d.layout_id, d.scheduled_playlist_id, d.scheduled_layout_id, w.name AS ws_name
      FROM devices d LEFT JOIN workspaces w ON w.id = d.workspace_id WHERE d.id IN (${ph})`).all(...deviceIds);
  const ws = new Map();
  for (const r of rows) ws.set(r.workspace_id, { id: r.workspace_id, name: r.ws_name, screens: (ws.get(r.workspace_id)?.screens || 0) + 1 });
  let schedules = 0;
  try {
    schedules = db.prepare(`SELECT COUNT(*) AS n FROM schedules WHERE enabled = 1 AND (device_id IN (${ph})
        OR group_id IN (SELECT group_id FROM device_group_members WHERE device_id IN (${ph})))`).get(...deviceIds, ...deviceIds).n;
  } catch (_) { schedules = 0; }
  return {
    screens: rows.length,
    workspaces: [...ws.values()],
    schedules,
    screen_playlists: rows.filter((r) => r.playlist_source === 'device').length,
    store_layouts: rows.filter((r) => r.layout_id || r.scheduled_layout_id).length,
  };
}

router.get('/mandates/preview', (req, res) => {
  const org = loadOrg(req, res);
  if (!org) return;
  if (!requireAdmin(req, res, org)) return;
  const q = req.query || {};
  const existing = q.mandate_id ? db.prepare('SELECT * FROM corporate_mandates WHERE id = ? AND organization_id = ?').get(String(q.mandate_id), org.id) : null;
  if (q.mandate_id && !existing) return res.status(404).json({ error: 'Mandate not found' });
  const body = {};
  for (const k of ['target_kind', 'target_id', 'playlist_id', 'layout_id']) if (q[k] !== undefined) body[k] = String(q[k]);
  if (q.dark !== undefined) body.dark = q.dark === '1' || q.dark === 'true';
  if (q.remove === '1') {
    // The reverse preview: what goes back to the store's own choice if this mandate is removed.
    if (!existing) return res.status(400).json({ error: 'mandate_id required' });
    const v = { kind: existing.target_kind, tid: existing.target_id, playlistId: existing.playlist_id, dark: existing.dark, layoutId: existing.layout_id, enabled: 0,
      wsIds: fanout.workspacesForTarget(db, org.id, existing.target_kind, existing.target_id) };
    return res.json({ preview: previewOf(org, v, existing.id) });
  }
  const v = validateMandate(req, res, org, body, existing);
  if (!v) return;
  res.json({ preview: previewOf(org, v, existing && existing.id) });
});

router.post('/mandates', (req, res) => {
  const org = loadOrg(req, res);
  if (!org) return;
  if (!requireAvailable(res) || !requireAdmin(req, res, org)) return;
  if (!org.corporate_enabled) return refuse(res, 'CORPORATE_DISABLED');
  const v = validateMandate(req, res, org, req.body || {}, null);
  if (!v) return;
  const impact = requireMandateImpactAck(req, res, org, v, null);
  if (!impact) return;
  const id = uuidv4();
  const { changed } = fanout.withResolutionDiff(req, v.wsIds, () => {
    db.prepare(`INSERT INTO corporate_mandates (id, organization_id, playlist_id, dark, target_kind, target_id, layout_id, enabled, note, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, org.id, v.playlistId, v.dark, v.kind, v.tid, v.layoutId, v.enabled, v.note, req.user.id);
  });
  const row = listMandates(org.id).find((m) => m.id === id);
  auditCorp(req, 'corporate.mandate.create', {
    organization_id: org.id, mandate_id: id, after: row, screens_changed: changed.length,
    store_triggers_acknowledged: impact.map((i) => ({ id: i.trigger_id, name: i.name, workspace_id: i.workspace_id, screens: i.screens })),
  });
  auditStoreTriggersLimited(req, org, impact, org.store_triggers_under_mandate || 'off', org.store_trigger_cap_sec || 300, 'mandate');
  for (const w of v.wsIds) {
    if (w === org.hq_workspace_id) continue;
    // The store's own activity feed says head office took over, so nobody wonders why a schedule stopped.
    audit('corporate.mandate.store_notice', { userId: req.user.id, workspaceId: w, details: { mandate_id: id, playlist_name: row && row.playlist_name, dark: !!v.dark } });
  }
  res.status(201).json({ ...row, screens_changed: changed.length, store_triggers_affected: impact.length });
});

router.put('/mandates/:id', (req, res) => {
  const org = loadOrg(req, res);
  if (!org) return;
  if (!requireAvailable(res) || !requireAdmin(req, res, org)) return;
  const existing = db.prepare('SELECT * FROM corporate_mandates WHERE id = ? AND organization_id = ?').get(req.params.id, org.id);
  if (!existing) return res.status(404).json({ error: 'Mandate not found' });
  if (!org.corporate_enabled) return refuse(res, 'CORPORATE_DISABLED');
  const v = validateMandate(req, res, org, req.body || {}, existing);
  if (!v) return;
  const impact = requireMandateImpactAck(req, res, org, v, existing.id);
  if (!impact) return;
  const before = listMandates(org.id).find((m) => m.id === existing.id);
  const wsIds = [...new Set([...v.wsIds, ...fanout.workspacesForTarget(db, org.id, existing.target_kind, existing.target_id)])];
  const { changed } = fanout.withResolutionDiff(req, wsIds, () => {
    db.prepare(`UPDATE corporate_mandates SET playlist_id = ?, dark = ?, target_kind = ?, target_id = ?, layout_id = ?, enabled = ?, note = ?,
                updated_at = strftime('%s','now') WHERE id = ?`)
      .run(v.playlistId, v.dark, v.kind, v.tid, v.layoutId, v.enabled, v.note, existing.id);
  });
  const after = listMandates(org.id).find((m) => m.id === existing.id);
  const action = before && after && before.enabled !== after.enabled ? (after.enabled ? 'corporate.mandate.enable' : 'corporate.mandate.disable') : 'corporate.mandate.update';
  auditCorp(req, action, {
    organization_id: org.id, mandate_id: existing.id, before, after, screens_changed: changed.length,
    store_triggers_acknowledged: impact.map((i) => ({ id: i.trigger_id, name: i.name, workspace_id: i.workspace_id, screens: i.screens })),
  });
  auditStoreTriggersLimited(req, org, impact, org.store_triggers_under_mandate || 'off', org.store_trigger_cap_sec || 300, 'mandate');
  res.json({ ...after, screens_changed: changed.length, store_triggers_affected: impact.length });
});

router.delete('/mandates/:id', (req, res) => {
  const org = loadOrg(req, res);
  if (!org) return;
  if (!requireAvailable(res) || !requireAdmin(req, res, org)) return;
  const existing = db.prepare('SELECT * FROM corporate_mandates WHERE id = ? AND organization_id = ?').get(req.params.id, org.id);
  if (!existing) return res.status(404).json({ error: 'Mandate not found' });
  const before = listMandates(org.id).find((m) => m.id === existing.id);
  const wsIds = fanout.workspacesForTarget(db, org.id, existing.target_kind, existing.target_id);
  const { changed } = fanout.withResolutionDiff(req, wsIds, () => {
    db.prepare('DELETE FROM corporate_mandates WHERE id = ?').run(existing.id);
  });
  auditCorp(req, 'corporate.mandate.delete', { organization_id: org.id, mandate_id: existing.id, before, screens_changed: changed.length });
  res.json({ success: true, screens_changed: changed.length });
});

/* ─────────────────────────────────────────────── what the dashboard needs to say why (§7.10) */

/*
 * What head office decides in the ACTIVE workspace, for the badges and pickers that must explain a
 * refusal BEFORE it happens: which screens play head office's playlist, which groups it covers
 * (and how many of a covered group's synced members drop out because they have their own slot
 * content), which video walls it locks, and which of the workspace's schedules it shadows.
 *
 * Read by anyone who can read the workspace — it names only things they can already see, plus the
 * name of head office's playlist, which the device page shows them anyway. Empty maps when nothing
 * is mandated (and in degraded mode), so a caller never has to special-case "no corporate".
 */
router.get('/workspace', (req, res) => {
  const wsId = req.workspaceId;
  const out = { workspace_id: wsId || null, active: false, is_admin: false, devices: {}, groups: {}, walls: {}, shadowed_schedules: [] };
  if (!wsId) return res.json(out);
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(wsId);
  if (!ws || !resourceAccess(req, ws)) return res.status(403).json({ error: 'Access denied' });
  out.is_admin = !req.viaToken && guard.isOrgAdmin(req, ws.organization_id);
  if (!runtime.active(db)) return res.json(out);
  const describe = (m) => ({
    mandate_id: m.id, playlist_id: m.playlist_id || null, playlist_name: m.playlist_name || null, dark: !!m.dark,
    target_kind: m.target_kind, target_label: guard.targetLabel(db, m),
  });
  let mandated = [];
  try {
    mandated = db.prepare(`SELECT r.device_id FROM devices d JOIN device_resolved_playlist r ON r.device_id = d.id
        WHERE d.workspace_id = ? AND r.source = 'corporate'`).all(wsId).map((r) => r.device_id);
  } catch (_) { mandated = []; }
  for (const id of mandated) {
    const m = resolve.mandateFor(db, id);
    if (m) out.devices[id] = describe(m);
  }
  out.active = mandated.length > 0;
  for (const g of db.prepare('SELECT id, name, workspace_id, playlist_id, sync_enabled FROM device_groups WHERE workspace_id = ?').all(wsId)) {
    const members = db.prepare('SELECT device_id FROM device_group_members WHERE group_id = ?').all(g.id).map((r) => r.device_id);
    const inMandate = members.filter((id) => out.devices[id]);
    const cov = resolve.groupCoverage(db, g);
    if (!cov && !inMandate.length) continue;
    let syncExcluded = 0;
    if (cov && g.sync_enabled) {
      // A member that plays a different loop from the group (its own slot content) drops out of sync.
      const key = resolve.syncKeyForGroup(db, g);
      if (key) syncExcluded = inMandate.filter((id) => resolve.syncKeyForDevice(db, id) !== key).length;
    }
    out.groups[g.id] = { covered: !!cov, ...(cov ? describe(cov) : {}), mandated_members: inMandate.length, members: members.length, sync_excluded: syncExcluded };
  }
  for (const w of db.prepare('SELECT id, name FROM video_walls WHERE workspace_id = ?').all(wsId)) {
    const member = db.prepare('SELECT id FROM devices WHERE wall_id = ?').all(w.id).map((r) => r.id).find((id) => out.devices[id]);
    if (!member) continue;
    // Locked = the same rule the wall routes enforce (A11): mandated, and the viewer is not an org admin.
    out.walls[w.id] = { ...out.devices[member], locked: guard.isControlledFor(req, member) };
  }
  const coveredGroups = Object.keys(out.groups).filter((id) => out.groups[id].covered);
  for (const s of db.prepare('SELECT id, device_id, group_id FROM schedules WHERE workspace_id = ? AND enabled = 1').all(wsId)) {
    if ((s.device_id && out.devices[s.device_id]) || (s.group_id && coveredGroups.includes(s.group_id))) out.shadowed_schedules.push(s.id);
  }
  res.json(out);
});

/*
 * Everything an org admin can point "Where it plays" or an emergency alert's scope at: the org's
 * workspaces with their groups, video walls and screens. Screens in a wall carry the wall, because
 * a wall member is never a target of its own (D8) — the dialog says "Part of video wall {name}".
 * Corporate authors read it too: "Preview a screen" picks from the same list.
 */
router.get('/targets', (req, res) => {
  const org = loadOrg(req, res);
  if (!org) return;
  if (req.viaToken) return refuse(res, 'CORPORATE_TOKEN');
  if (!guard.isOrgAdmin(req, org.id) && !guard.canAuthor(req, org.id)) return refuse(res, 'CORPORATE_ADMIN_REQUIRED');
  const workspaces = orgWorkspaces(org.id).map((w) => ({
    ...w,
    hq: w.id === org.hq_workspace_id,
    replicated: guard.isReplicatedWorkspace(db, w.id),
    groups: db.prepare('SELECT id, name FROM device_groups WHERE workspace_id = ? ORDER BY name').all(w.id),
    walls: db.prepare('SELECT id, name FROM video_walls WHERE workspace_id = ? ORDER BY name').all(w.id),
    devices: db.prepare(`SELECT d.id, d.name, d.status, d.wall_id, vw.name AS wall_name FROM devices d
        LEFT JOIN video_walls vw ON vw.id = d.wall_id WHERE d.workspace_id = ? ORDER BY d.name`).all(w.id),
  }));
  res.json({ organization_id: org.id, organization_name: org.name, hq_workspace_id: org.hq_workspace_id || null, workspaces });
});

/* ──────────────────────────────────────────────────────────────────── preview */

/*
 * "Preview a screen": the loop this screen plays, every item tagged corporate / slot (with the level
 * it came from) / fallback, plus what each slot did (filled, fallback, skipped). draft=1 (corporate
 * authors only) previews the corporate DRAFT: what the screen would play after the next publish.
 * Read by anyone who can see the device, or an org admin.
 */
router.get('/preview', (req, res) => {
  const org = loadOrg(req, res);
  if (!org) return;
  const deviceId = String((req.query && req.query.device_id) || '');
  if (!deviceId) return res.status(400).json({ error: 'device_id required' });
  const device = db.prepare(`SELECT d.id, d.name, d.workspace_id, w.organization_id FROM devices d
      JOIN workspaces w ON w.id = d.workspace_id WHERE d.id = ?`).get(deviceId);
  if (!device || device.organization_id !== org.id) return res.status(404).json({ error: 'Device not found' });
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(device.workspace_id);
  // Role matrix §4.10 "Preview any screen's composed loop": org admins and corporate authors for any
  // screen of the org; everyone else for the screens of a workspace they can read.
  const hqReader = !req.viaToken && (guard.isOrgAdmin(req, org.id) || guard.canAuthor(req, org.id));
  if (!hqReader && !(ws && resourceAccess(req, ws))) return res.status(403).json({ error: 'Access denied' });
  const { buildPlaylistPayloadUnchecked } = require('../ws/deviceSocket');
  const payload = buildPlaylistPayloadUnchecked(deviceId);
  const r = db.prepare('SELECT playlist_id, source FROM device_resolved_playlist WHERE device_id = ?').get(deviceId) || {};
  const m = resolve.mandateFor(db, deviceId);
  const corporate = r.source === 'corporate';
  if (corporate && r.playlist_id) {
    const draft = req.query && (req.query.draft === '1' || req.query.draft === 'true');
    if (draft && !guard.canAuthor(req, org.id)) return refuse(res, 'CORPORATE_AUTHOR_REQUIRED');
    const composable = draft ? require('./playlists').buildSnapshotItems(r.playlist_id, 0, null, { keepSlots: true, noWeave: true }) : null;
    const ex = helpers.explainForDevice(deviceId, r.playlist_id, { composable });
    return res.json({
      device_id: deviceId, device_name: device.name, playlist_id: r.playlist_id, source: r.source, draft: !!draft,
      mandate: m ? { id: m.id, target_kind: m.target_kind, target_label: guard.targetLabel(db, m), dark: !!m.dark, playlist_name: m.playlist_name || null } : null,
      layout: payload.layout ? { id: payload.layout.id, name: payload.layout.name } : null,
      items: ex.items, slots: ex.slots, total_sec: ex.total_sec, playback_order: ex.playback_order,
    });
  }
  const items = (payload.assignments || []).map((a) => ({
    content_id: a.content_id || null, widget_id: a.widget_id || null, filename: a.filename || a.widget_name || null,
    mime_type: a.mime_type || null, thumbnail_path: a.thumbnail_path || null, duration_sec: a.duration_sec || null,
    tag: corporate ? 'corporate' : 'store',
  }));
  res.json({
    device_id: deviceId, device_name: device.name, playlist_id: r.playlist_id || null, source: r.source || null,
    mandate: m ? { id: m.id, target_kind: m.target_kind, target_label: guard.targetLabel(db, m), dark: !!m.dark, playlist_name: m.playlist_name || null } : null,
    layout: payload.layout ? { id: payload.layout.id, name: payload.layout.name } : null,
    items, total_sec: items.reduce((s, i) => s + (Number(i.duration_sec) || 0), 0),
  });
});

module.exports = router;
