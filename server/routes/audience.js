'use strict';

/*
 * Audience counting — settings, per-screen switches and the report (lib/audience.js).
 *
 * JWT only (config/api-surface.js): turning a camera on is a privacy decision an API token must not
 * be able to make. Every switch is an ORG owner/admin action, and every change is in activity_log.
 */

const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const audience = require('../lib/audience');
const { canRead, isOrgAdmin } = require('../lib/permissions');
const { logActivity, getClientIp } = require('../services/activity');

function requireOrgAdmin(req, res) {
  if (!req.organizationId || !isOrgAdmin(req)) {
    res.status(403).json({ error: 'Only an organization owner or admin can change audience counting.' });
    return false;
  }
  return true;
}

/** Re-send the payload to these screens, so the camera starts or stops now rather than on the next sync. */
function push(req, deviceIds) {
  try {
    const io = req.app.get('io');
    if (!io || !deviceIds.length) return;
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    const commandQueue = require('../lib/command-queue');
    const ns = io.of('/device');
    for (const id of new Set(deviceIds)) commandQueue.queueOrEmitPlaylistUpdate(ns, id, buildPlaylistPayload);
  } catch (e) { console.warn(`[audience] push failed: ${e.message}`); }
}

const hasCamera = (caps) => {
  try { return Array.isArray(JSON.parse(caps || 'null')) && JSON.parse(caps).includes('audience.camera'); } catch { return false; }
};

router.get('/settings', (req, res) => {
  if (!canRead(req)) return res.status(403).json({ error: 'Workspace access required' });
  res.json({ ...audience.orgSettings(req.organizationId), limits: audience.LIMITS, can_manage: isOrgAdmin(req) });
});

router.put('/settings', (req, res) => {
  if (!requireOrgAdmin(req, res)) return;
  const { next, error } = audience.mergeOrgSettings(req.organizationId, req.body);
  if (error) return res.status(400).json({ error });
  const before = audience.orgSettings(req.organizationId);
  audience.saveOrgSettings(req.organizationId, next);
  logActivity(req.user.id, 'audience_settings_updated',
    `org=${req.organizationId} allowed=${next.allowed} indicator=${next.show_indicator} fps=${next.fps} min_dwell_ms=${next.min_dwell_ms} retention_days=${next.retention_days}`,
    null, getClientIp(req), req.workspaceId || null);
  // Anything a player is told changed: tell every screen in the org now.
  if (before.allowed !== next.allowed || before.fps !== next.fps || before.min_dwell_ms !== next.min_dwell_ms || before.show_indicator !== next.show_indicator) {
    push(req, audience.devicesForOrg(req.organizationId));
  }
  res.json({ ...next, limits: audience.LIMITS, can_manage: true });
});

/** Screens and groups in the current workspace, with their switch and whether they can count at all. */
router.get('/screens', (req, res) => {
  if (!canRead(req)) return res.status(403).json({ error: 'Workspace access required' });
  if (!req.workspaceId) return res.json({ devices: [], groups: [] });
  const devices = db.prepare('SELECT id, name, platform, capabilities, audience_enabled FROM devices WHERE workspace_id = ? ORDER BY name').all(req.workspaceId);
  const groups = db.prepare('SELECT id, name, audience_enabled FROM device_groups WHERE workspace_id = ? ORDER BY name').all(req.workspaceId);
  res.json({
    devices: devices.map((d) => ({
      id: d.id, name: d.name, platform: d.platform,
      enabled: !!d.audience_enabled,
      counting: !!audience.payloadConfig(d.id),
      camera_capable: hasCamera(d.capabilities),
    })),
    groups: groups.map((g) => ({ id: g.id, name: g.name, enabled: !!g.audience_enabled })),
  });
});

function setSwitch(kind) {
  return (req, res) => {
    if (!requireOrgAdmin(req, res)) return;
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
    const table = kind === 'device' ? 'devices' : 'device_groups';
    // In THIS org: a device or group whose workspace belongs to the caller's organization.
    const row = db.prepare(`SELECT t.id, t.name FROM ${table} t JOIN workspaces w ON w.id = t.workspace_id
      WHERE t.id = ? AND w.organization_id = ?`).get(req.params.id, req.organizationId);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (enabled && !audience.orgSettings(req.organizationId).allowed) {
      return res.status(409).json({ error: 'Allow audience counting for the organization first.', code: 'not_allowed' });
    }
    db.prepare(`UPDATE ${table} SET audience_enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, row.id);
    logActivity(req.user.id, enabled ? 'audience_enabled' : 'audience_disabled', `${kind}=${row.id} (${row.name})`,
      kind === 'device' ? row.id : null, getClientIp(req), req.workspaceId || null);
    push(req, kind === 'device' ? [row.id] : audience.devicesForGroup(row.id));
    res.json({ id: row.id, enabled });
  };
}
router.put('/devices/:id', setSwitch('device'));
router.put('/groups/:id', setSwitch('group'));

/*
 * The report's period. The dashboard sends EPOCH SECONDS for the start of its first day and the end
 * of its last, computed in the browser's own zone (so a range across a DST change is still exact).
 * A bare YYYY-MM-DD is also taken, and is a day in the viewer's zone from `tz` (minutes BEHIND UTC,
 * as Date.getTimezoneOffset() reports it) — the same offset by_hour / by_day are shifted by — so
 * "2026-03-10" for a UTC-5 viewer starts at 05:00 UTC, not at UTC midnight. `from` / `to` are
 * accepted as aliases of `start` / `end`; anything that does not parse is a 400, never the default.
 */
function range(req, res) {
  const now = Math.floor(Date.now() / 1000);
  const bad = (error) => { res.status(400).json({ error }); return null; };
  // `tz` given but not an offset in minutes was silently 0 (UTC days); say so instead.
  const tzRaw = req.query.tz === undefined || req.query.tz === '' ? 0 : Number(req.query.tz);
  if (!Number.isFinite(tzRaw) || Math.abs(tzRaw) > 14 * 60) return bad('tz must be the viewer\'s UTC offset in minutes (as Date.getTimezoneOffset() reports it).');
  const tzOffsetMin = Math.trunc(tzRaw);
  // `from` / `to` are aliases of `start` / `end` (a YYYY-MM-DD in `tz` reads naturally as from/to).
  // They used to be ignored without a word, so the report silently showed the default 30 days.
  const pick = (a, b) => {
    const x = req.query[a], y = req.query[b];
    if (Array.isArray(x) || Array.isArray(y) || (x !== undefined && typeof x !== 'string') || (y !== undefined && typeof y !== 'string')) return { error: `${a} must be given once` };
    if (x !== undefined && x !== '' && y !== undefined && y !== '' && x !== y) return { error: `Give ${a} or ${b}, not both` };
    return { v: x !== undefined && x !== '' ? x : y };
  };
  const ps = pick('start', 'from'), pe = pick('end', 'to');
  if (ps.error || pe.error) return bad(ps.error || pe.error);
  const parse = (v, dflt) => {
    if (v === undefined || v === '') return dflt;
    const str = String(v);
    if (/^\d+$/.test(str)) return Number(str);
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      const t = Date.parse(`${str}T00:00:00Z`);
      return Number.isFinite(t) ? t / 1000 + tzOffsetMin * 60 : null;
    }
    const t = Math.floor(Date.parse(str) / 1000);
    return Number.isFinite(t) ? t : null;
  };
  const start = parse(ps.v, now - 30 * 86400);
  let end = parse(pe.v, now);
  if (start === null || end === null) return bad('start/from and end/to must be YYYY-MM-DD dates (in tz) or epoch seconds');
  // A bare date for `end` means "through the end of that day".
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(pe.v || ''))) end += 86399;
  if (end < start) return bad('The range ends before it starts.');
  if (end - start > 400 * 86400) return bad('The range must be at most 400 days.');
  return { start, end, tzOffsetMin,
    deviceId: typeof req.query.device_id === 'string' && req.query.device_id ? req.query.device_id : null };
}

router.get('/report', (req, res) => {
  if (!canRead(req)) return res.status(403).json({ error: 'Workspace access required' });
  const r = range(req, res);
  if (!r) return;
  res.json({ period: { start: r.start, end: r.end }, ...audience.report(req.workspaceId, r) });
});

router.get('/export.csv', (req, res) => {
  if (!canRead(req)) return res.status(403).json({ error: 'Workspace access required' });
  const r = range(req, res);
  if (!r) return;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="audience.csv"');
  res.send(audience.toCsv(audience.exportRows(req.workspaceId, r)));
});

module.exports = router;
