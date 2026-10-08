'use strict';

/*
 * BI connections (lib/bi/connections.js) — Settings → BI dashboards.
 *
 * JWT only (config/api-surface.js): a connection holds credentials into a customer's Grafana, Power
 * BI tenant or Tableau site. They belong to the ORGANIZATION:
 *   - any member of a workspace in it may list them (names and settings, never a secret), because
 *     choosing one is how an editor builds a dashboard widget
 *   - editors may browse what a Grafana or Power BI connection can see, to pick a dashboard
 *   - only an org owner/admin (or a platform admin) may create, change, test or remove one
 */

const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const config = require('../config');
const conns = require('../lib/bi/connections');

function orgContext(req, res) {
  if (!req.workspaceId || !req.organizationId) { res.status(403).json({ error: 'No workspace context' }); return false; }
  return true;
}
// lib/permissions: a platform admin, or the org's owner/admin. NOT req.actingAs: that is also true
// for a platform_operator, who may look at any org but holds no owner power (lib/tenancy #13), and
// a connection is credentials into the customer's BI tenant.
const { isOrgAdmin } = require('../lib/permissions');
function requireOrgAdmin(req, res) {
  if (!orgContext(req, res)) return false;
  if (!isOrgAdmin(req)) { res.status(403).json({ error: 'Only an organization admin can manage BI connections.', code: 'BI_ADMIN_REQUIRED' }); return false; }
  return true;
}
function requireEditor(req, res) {
  if (!orgContext(req, res)) return false;
  if (!isOrgAdmin(req) && req.workspaceRole === 'workspace_viewer') { res.status(403).json({ error: 'Read-only members cannot browse dashboards.' }); return false; }
  return true;
}
function load(req, res) {
  const row = conns.forOrg(db, req.organizationId, req.params.id);
  if (!row) { res.status(404).json({ error: 'Connection not found' }); return null; }
  return row;
}
function audit(req, action, details) {
  try { require('../lib/audit').audit(action, { userId: req.user.id, workspaceId: req.workspaceId, ip: req.ip || null, details }); } catch (_) { /* */ }
}
function usedBy(orgId, id) {
  return db.prepare(`SELECT COUNT(*) AS n FROM widgets w JOIN workspaces ws ON ws.id = w.workspace_id
    WHERE ws.organization_id = ? AND w.widget_type = 'bi-dashboard' AND json_extract(w.config, '$.connection_id') = ?`).get(orgId, id).n;
}
const canAllowPrivate = (req) => !!(req.isPlatformAdmin || config.selfHosted);
// Any Tableau host (not only Tableau Cloud): the same people, for the same reason — it is an
// operator's decision what a hosted server's pages load scripts from.
const inputOpts = (req) => ({ canAllowPrivate: canAllowPrivate(req), anyTableauHost: canAllowPrivate(req) });

router.get('/', (req, res) => {
  if (!orgContext(req, res)) return;
  const rows = db.prepare('SELECT * FROM bi_connections WHERE organization_id = ? ORDER BY name').all(req.organizationId);
  res.json({ connections: rows.map(conns.present), can_manage: isOrgAdmin(req), can_allow_private: canAllowPrivate(req) });
});

router.post('/', (req, res) => {
  if (!requireOrgAdmin(req, res)) return;
  let input;
  try { input = conns.normaliseInput(req.body, null, inputOpts(req)); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message, code: e.code }); }
  const row = conns.create(db, req.organizationId, req.user.id, input);
  audit(req, 'bi_connection.create', { connection_id: row.id, kind: row.kind, name: row.name, organization_id: req.organizationId });
  res.status(201).json(conns.present(row));
});

router.put('/:id', (req, res) => {
  if (!requireOrgAdmin(req, res)) return;
  const row = load(req, res); if (!row) return;
  let input;
  try { input = conns.normaliseInput(req.body, row, inputOpts(req)); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message, code: e.code }); }
  const next = conns.update(db, row, input);
  audit(req, 'bi_connection.update', { connection_id: row.id, name: next.name, secret_changed: next.secret_enc !== row.secret_enc });
  res.json(conns.present(next));
});

router.delete('/:id', (req, res) => {
  if (!requireOrgAdmin(req, res)) return;
  const row = load(req, res); if (!row) return;
  const n = usedBy(req.organizationId, row.id);
  // Removing a connection blanks every screen showing one of its dashboards, so it is said first.
  if (n > 0 && req.query.force !== '1') {
    return res.status(409).json({ error: `${n} dashboard widget${n === 1 ? ' uses' : 's use'} this connection. They will stop showing until another is chosen.`, code: 'BI_CONNECTION_IN_USE', widgets: n });
  }
  db.prepare('DELETE FROM bi_connections WHERE id = ?').run(row.id);
  audit(req, 'bi_connection.delete', { connection_id: row.id, kind: row.kind, name: row.name, widgets: n });
  res.json({ success: true });
});

router.post('/:id/test', async (req, res) => {
  if (!requireOrgAdmin(req, res)) return;
  const row = load(req, res); if (!row) return;
  const mod = require(`../lib/bi/${row.kind}`);
  try {
    res.json(await mod.test(row));
  } catch (e) {
    res.json({ ok: false, checks: [{ name: 'connection', ok: false, detail: e.message }] });
  }
});

/*
 * Pickers for the widget editor. Titles and ids only — the same things the dashboard itself shows.
 */
router.get('/:id/dashboards', async (req, res) => {
  if (!requireEditor(req, res)) return;
  const row = load(req, res); if (!row) return;
  const q = String(req.query.q || '').slice(0, 100);
  try {
    if (row.kind === 'grafana') {
      const biHttp = require('../lib/bi/http');
      const base = String(conns.parseConfig(row.config).base_url).replace(/\/+$/, '');
      const r = await biHttp.request(`${base}/api/search?type=dash-db&limit=50&query=${encodeURIComponent(q)}`, {
        headers: { Authorization: `Bearer ${conns.secretOf(row)}`, Accept: 'application/json' },
        allowPrivate: !!row.allow_private, maxBytes: 2 * 1024 * 1024,
      });
      if (r.status !== 200) return res.status(502).json({ error: `Grafana answered ${r.status}` });
      const list = JSON.parse(r.body.toString());
      return res.json({ items: (Array.isArray(list) ? list : []).map((d) => ({ id: d.uid, title: d.title, folder: d.folderTitle || '' })) });
    }
    if (row.kind === 'powerbi') {
      const pbi = require('../lib/bi/powerbi');
      const c = { ...row, config: conns.parseConfig(row.config) };
      const bearer = await pbi.aadToken(c);
      const h = { Authorization: `Bearer ${bearer}` };
      const get = async (u) => {
        const r = await fetch(u, { headers: h, signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'Power BI refused the app — allow service principals to use Power BI APIs' : `Power BI answered ${r.status}`);
        return r.json();
      };
      const groups = await get('https://api.powerbi.com/v1.0/myorg/groups?$top=50');
      const items = [];
      for (const g of (groups.value || []).slice(0, 20)) {
        const reps = await get(`https://api.powerbi.com/v1.0/myorg/groups/${g.id}/reports`);
        for (const r of reps.value || []) {
          if (!q || `${g.name} ${r.name}`.toLowerCase().includes(q.toLowerCase())) items.push({ id: r.id, group_id: g.id, title: r.name, folder: g.name });
        }
      }
      return res.json({ items: items.slice(0, 200) });
    }
    return res.status(400).json({ error: 'Paste the Tableau view address in the widget instead.' });
  } catch (e) {
    res.status(502).json({ error: require('../lib/bi/http').describe(e) });
  }
});

module.exports = router;
