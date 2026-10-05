'use strict';

/*
 * /api/corporate — head office (corporate) playlists: settings, the corporate playlists
 * themselves, and "Where it plays" (mandates). JWT-only (config/api-surface.js, decision D12).
 *
 * Stage A of docs (spec 10, §9): no slots yet, so a mandated screen plays the corporate playlist's
 * own published snapshot. Slots, fills and per-store composition arrive in Stage B; emergency
 * alerts in Stage C — this router refuses their settings rather than storing a switch that does
 * nothing yet.
 *
 * Every write is audited (activity_log, action `corporate.*`), with before/after for mandates.
 * Every write answers 503 CORPORATE_UNAVAILABLE in degraded mode (the per-boot resolver check
 * failed; lib/corporate/runtime.js) — reads keep working so an admin can see what is configured.
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { accessContext } = require('../lib/tenancy');
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
    store_triggers_under_mandate: org.store_triggers_under_mandate || 'allow',
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

router.put('/settings', (req, res) => {
  const org = loadOrg(req, res);
  if (!org) return;
  if (!requireAvailable(res) || !requireAdmin(req, res, org)) return;
  const b = req.body || {};

  // Stage C owns these; refusing is better than storing a switch that does nothing yet.
  for (const k of ['emergency_triggers_enabled', 'store_triggers_under_mandate', 'store_trigger_cap_sec']) {
    if (b[k] !== undefined) return res.status(400).json({ error: `${k} is not available on this server yet.`, code: 'CORPORATE_NOT_AVAILABLE' });
  }

  const next = {
    corporate_enabled: b.corporate_enabled !== undefined ? (b.corporate_enabled ? 1 : 0) : (org.corporate_enabled ? 1 : 0),
    hq_workspace_id: b.hq_workspace_id !== undefined ? (b.hq_workspace_id || null) : (org.hq_workspace_id || null),
    corporate_authors: b.corporate_authors !== undefined ? b.corporate_authors : (org.corporate_authors || 'org_admins'),
  };
  if (!AUTHOR_MODES.has(next.corporate_authors)) {
    return res.status(400).json({ error: `corporate_authors must be one of: ${[...AUTHOR_MODES].join(', ')}` });
  }
  if (next.hq_workspace_id !== (org.hq_workspace_id || null)) {
    if (next.hq_workspace_id) {
      const ws = db.prepare('SELECT id, name, organization_id FROM workspaces WHERE id = ?').get(next.hq_workspace_id);
      if (!ws || ws.organization_id !== org.id) return res.status(400).json({ error: 'The head office workspace must be one of this organization\'s workspaces.' });
      if (guard.isReplicatedWorkspace(db, ws.id)) return refuse(res, 'CORPORATE_MESH_UNSUPPORTED', { workspace: `"${ws.name}"` });
    }
    // Locked once corporate playlists exist: they live in the HQ workspace, and moving the label
    // would leave them corporate in a workspace that is no longer head office.
    if (org.hq_workspace_id) {
      const n = db.prepare('SELECT COUNT(*) AS n FROM playlists WHERE workspace_id = ? AND corporate = 1').get(org.hq_workspace_id).n;
      if (n) {
        return res.status(409).json({
          code: 'CORPORATE_HQ_LOCKED',
          error: `The head office workspace can't be changed while it holds ${n} corporate playlist${n === 1 ? '' : 's'}. Make them ordinary playlists first.`,
        });
      }
    }
  }
  if (next.corporate_enabled && !next.hq_workspace_id) {
    return res.status(400).json({ error: 'Choose a head office workspace before turning corporate playlists on.' });
  }

  const before = { corporate_enabled: !!org.corporate_enabled, hq_workspace_id: org.hq_workspace_id || null, corporate_authors: org.corporate_authors };
  const wsIds = orgWorkspaces(org.id).map((w) => w.id);
  const { changed } = fanout.withResolutionDiff(req, wsIds, () => {
    db.prepare('UPDATE organizations SET corporate_enabled = ?, hq_workspace_id = ?, corporate_authors = ? WHERE id = ?')
      .run(next.corporate_enabled, next.hq_workspace_id, next.corporate_authors, org.id);
  });
  auditCorp(req, 'corporate.settings', { organization_id: org.id, before, after: { ...next, corporate_enabled: !!next.corporate_enabled }, screens_changed: changed.length });
  res.json({ success: true, screens_changed: changed.length, ...next, corporate_enabled: !!next.corporate_enabled });
});

/* ──────────────────────────────────────────────────────────── corporate playlists */

function corporatePlaylistRow(p) {
  const mandates = db.prepare('SELECT COUNT(*) AS n FROM corporate_mandates WHERE playlist_id = ?').get(p.id).n;
  const items = db.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?').get(p.id).n;
  return {
    id: p.id, name: p.name, description: p.description, status: p.status, workspace_id: p.workspace_id,
    corporate: true, item_count: items, places: mandates, screens: playlistScreens(p.id),
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
  db.prepare('UPDATE playlists SET corporate = 0 WHERE id = ?').run(p.id);
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
  res.json({ ...corporatePlaylistRow(p), mandates: listMandates(org.id).filter((m) => m.playlist_id === p.id), slots: [] });
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

function previewOf(org, v, mandateId) {
  // Simulate inside a transaction that is always rolled back: the view itself answers the question,
  // so the preview can never disagree with what the save will do.
  const ROLLBACK = new Error('preview-rollback');
  let stats = null;
  try {
    db.transaction(() => {
      const before = fanout.snapshotResolution(db, v.wsIds);
      if (mandateId) {
        db.prepare('UPDATE corporate_mandates SET playlist_id = ?, dark = ?, target_kind = ?, target_id = ?, layout_id = ?, enabled = ? WHERE id = ?')
          .run(v.playlistId, v.dark, v.kind, v.tid, v.layoutId, v.enabled, mandateId);
      } else {
        db.prepare('INSERT INTO corporate_mandates (id, organization_id, playlist_id, dark, target_kind, target_id, layout_id, enabled) VALUES (?,?,?,?,?,?,?,?)')
          .run('preview-' + uuidv4(), org.id, v.playlistId, v.dark, v.kind, v.tid, v.layoutId, v.enabled);
        db.prepare('UPDATE organizations SET corporate_enabled = 1 WHERE id = ?').run(org.id);
      }
      const after = fanout.snapshotResolution(db, v.wsIds);
      const changed = [...after.keys()].filter((id) => before.get(id) !== after.get(id));
      stats = summarise(changed);
      throw ROLLBACK;
    })();
  } catch (e) { if (e !== ROLLBACK) throw e; }
  return stats;
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
  const id = uuidv4();
  const { changed } = fanout.withResolutionDiff(req, v.wsIds, () => {
    db.prepare(`INSERT INTO corporate_mandates (id, organization_id, playlist_id, dark, target_kind, target_id, layout_id, enabled, note, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, org.id, v.playlistId, v.dark, v.kind, v.tid, v.layoutId, v.enabled, v.note, req.user.id);
  });
  const row = listMandates(org.id).find((m) => m.id === id);
  auditCorp(req, 'corporate.mandate.create', { organization_id: org.id, mandate_id: id, after: row, screens_changed: changed.length });
  for (const w of v.wsIds) {
    if (w === org.hq_workspace_id) continue;
    // The store's own activity feed says head office took over, so nobody wonders why a schedule stopped.
    audit('corporate.mandate.store_notice', { userId: req.user.id, workspaceId: w, details: { mandate_id: id, playlist_name: row && row.playlist_name, dark: !!v.dark } });
  }
  res.status(201).json({ ...row, screens_changed: changed.length });
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
  const before = listMandates(org.id).find((m) => m.id === existing.id);
  const wsIds = [...new Set([...v.wsIds, ...fanout.workspacesForTarget(db, org.id, existing.target_kind, existing.target_id)])];
  const { changed } = fanout.withResolutionDiff(req, wsIds, () => {
    db.prepare(`UPDATE corporate_mandates SET playlist_id = ?, dark = ?, target_kind = ?, target_id = ?, layout_id = ?, enabled = ?, note = ?,
                updated_at = strftime('%s','now') WHERE id = ?`)
      .run(v.playlistId, v.dark, v.kind, v.tid, v.layoutId, v.enabled, v.note, existing.id);
  });
  const after = listMandates(org.id).find((m) => m.id === existing.id);
  const action = before && after && before.enabled !== after.enabled ? (after.enabled ? 'corporate.mandate.enable' : 'corporate.mandate.disable') : 'corporate.mandate.update';
  auditCorp(req, action, { organization_id: org.id, mandate_id: existing.id, before, after, screens_changed: changed.length });
  res.json({ ...after, screens_changed: changed.length });
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

/* ──────────────────────────────────────────────────────────────────── preview */

/*
 * "Preview a screen": the loop this screen plays, tagged by origin. Stage A has no slots, so every
 * item of a mandated screen is head office's. Read by anyone who can see the device, or an org admin.
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
  if (!guard.isOrgAdmin(req, org.id) && !(ws && accessContext(req.user.id, req.user.role, ws))) return res.status(403).json({ error: 'Access denied' });
  const { buildPlaylistPayloadUnchecked } = require('../ws/deviceSocket');
  const payload = buildPlaylistPayloadUnchecked(deviceId);
  const r = db.prepare('SELECT playlist_id, source FROM device_resolved_playlist WHERE device_id = ?').get(deviceId) || {};
  const m = resolve.mandateFor(db, deviceId);
  const corporate = r.source === 'corporate';
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
