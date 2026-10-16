'use strict';

/*
 * Energy & carbon (lib/energy, docs/energy.md): estimated electricity use and CO2e of the screens,
 * what the power schedules saved, what more they could save, and the exports for an ESG appendix.
 *
 * Mounted JWT-only with resolveTenancy (config/api-surface.js): every handler acts on the caller's
 * ACTIVE workspace, and the org rollup on that workspace's organization. No handler takes a
 * workspace id from the request.
 *
 *   GET  /report?start&end              the period report (any member; read-only)
 *   GET  /export?start&end&by=device|day the same as CSV
 *   GET  /appendix?start&end            plain-text ESG appendix with the methodology
 *   GET  /suggestions?start=22&end=6&days=1,2,3,4,5   what-if: switch-off windows worth setting
 *   GET  /glance                        month to date, for the Simple view's one line
 *   GET  /devices                       every screen's resolved watts and where they came from
 *   PUT  /devices/:id                   { on_watts, standby_watts, country } — editors and admins
 *   PUT  /groups/:id                    the same, for every screen in a group
 *   GET  /settings                      workspace grid / default-watts settings + the country table
 *   PUT  /settings                      admin only
 *   GET  /org?start&end                 org admins: one line per workspace of the organization
 *   GET  /org/export?start&end          the same as CSV
 */

const express = require('express');
const router = express.Router();
// Abuse backstop (lib/backstop-limiter.js): already counted app-wide; here so this router is never unguarded.
router.use(require('../lib/backstop-limiter'));
const { db } = require('../db/database');
const energy = require('../lib/energy');
const carbon = require('../lib/energy/carbon');
const wattage = require('../lib/energy/wattage');
const iv = require('../lib/energy/intervals');
const { canRead, canWrite, canAdmin, isOrgAdmin } = require('../lib/permissions');
const { denyReadOnly } = require('../lib/tenancy');
const { auditFromReq } = require('../lib/audit');
const { csvCell } = require('./reports');

const MAX_SPAN_DAYS = 400;

function requireWs(req, res) {
  if (!req.workspaceId) { res.status(403).json({ error: 'No workspace context' }); return false; }
  if (!canRead(req)) { res.status(403).json({ error: 'Workspace access required' }); return false; }
  return true;
}

/*
 * The period, as LOCAL dates (each screen's own). Default: this month so far (UTC calendar). A bad
 * date is a 400, never an empty 200 — the lesson routes/reports.js parseRangeParam records.
 */
function period(req, res) {
  const today = new Date().toISOString().slice(0, 10);
  const start = req.query.start === undefined || req.query.start === '' ? today.slice(0, 8) + '01' : String(req.query.start);
  const end = req.query.end === undefined || req.query.end === '' ? today : String(req.query.end);
  if (!iv.isDay(start) || !iv.isDay(end)) { res.status(400).json({ error: 'Use dates in the form YYYY-MM-DD' }); return null; }
  if (end < start) { res.status(400).json({ error: 'The end date is before the start date' }); return null; }
  if (iv.daysInclusive(start, end) > MAX_SPAN_DAYS) { res.status(400).json({ error: `At most ${MAX_SPAN_DAYS} days at a time` }); return null; }
  return { start, end };
}

router.get('/report', (req, res) => {
  if (!requireWs(req, res)) return;
  const p = period(req, res);
  if (!p) return;
  res.json({ ...energy.report(db, req.workspaceId, p), can_write: canWrite(req), can_admin: canAdmin(req), org_admin: !!(req.organizationId && isOrgAdmin(req)) });
});

router.get('/export', (req, res) => {
  if (!requireWs(req, res)) return;
  const p = period(req, res);
  if (!p) return;
  const r = energy.report(db, req.workspaceId, p);
  let csv;
  if (req.query.by === 'day') {
    csv = 'Date,kWh,kg CO2e,kWh saved by schedules\n'
      + r.by_day.map((d) => [csvCell(d.day), d.kwh, d.kg_co2e, d.saved_kwh].join(',')).join('\n');
  } else {
    csv = 'Screen,Groups,Hours on,Hours off (schedule),Hours off (other),Hours offline,Share inferred,On watts,Standby watts,Watts source,gCO2e/kWh,Intensity source,Country,kWh,kg CO2e,kWh saved,kg CO2e saved\n'
      + r.by_device.map((d) => [
        csvCell(d.removed ? `(removed screen ${d.device_id})` : d.name), csvCell(d.groups.join('; ')),
        d.on_hours, d.sched_off_hours, d.panel_off_hours, d.offline_hours, d.inferred_share,
        d.on_watts, d.standby_watts, csvCell(d.watts_source), d.g_per_kwh, csvCell(d.intensity_source), csvCell(d.country || ''),
        d.kwh, d.kg_co2e, d.saved_kwh, d.saved_kg_co2e,
      ].join(',')).join('\n')
      + `\n${csvCell('Total')},,${r.totals.on_hours},${r.totals.sched_off_hours},${r.totals.panel_off_hours},${r.totals.offline_hours},${r.totals.inferred_share},,,,,,,${r.totals.kwh},${r.totals.kg_co2e},${r.totals.saved_kwh},${r.totals.saved_kg_co2e}`;
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=energy-${p.start}-to-${p.end}${req.query.by === 'day' ? '-daily' : ''}.csv`);
  res.send(csv + '\n');
});

/*
 * The ESG appendix: the period's figures and the methodology in plain prose, ready to paste into a
 * sustainability report. Text, not HTML, so nothing in it is ever rendered as markup.
 */
function appendixText(r, wsName) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  const src = r.watts_sources || {};
  const n = (k) => src[k] || 0;
  const g = carbon.SOURCE;
  return [
    `Digital signage energy use — ${wsName}`,
    `Period: ${r.period.start} to ${r.period.end} (${r.period.days} days, each screen's local dates)`,
    '',
    `Screens reporting: ${r.totals.screens}`,
    `Estimated electricity use: ${r.totals.kwh} kWh (${r.totals.kwh_on} kWh lit, ${r.totals.kwh_standby} kWh standby)`,
    `Estimated emissions (location-based, Scope 2): ${r.totals.kg_co2e} kg CO2e`,
    `Avoided by display power schedules: ${r.totals.saved_kwh} kWh, ${r.totals.saved_kg_co2e} kg CO2e`,
    `Panel hours: ${r.totals.on_hours} lit, ${r.totals.sched_off_hours} off by schedule, ${r.totals.panel_off_hours} off otherwise, ${r.totals.offline_hours} unknown (player offline, not counted)`,
    '',
    'Methodology',
    '- These are ESTIMATES, not metered values. Panel on-time is observed by the signage server once a minute; power draw and grid carbon intensity are looked up.',
    `- On-time: a screen is counted lit while its player is connected and neither its power schedule, a panel power report nor the player's own display-off signal says otherwise. ${pct(r.totals.inferred_share)} of observed time was inferred from connection and schedule alone, without a direct panel signal. Time a player was offline is excluded.`,
    `- Power draw per screen, in order of preference: a value entered by the operator (${n('override')} screens); the manufacturer's published typical power for the panel model (${n('datasheet')}); an estimate from the panel's size using the EU energy label formula, Regulation (EU) 2019/2013 Annex II, at an assumed energy efficiency index of ${wattage.ASSUMED_EEI}, the median implied by ${wattage.CALIBRATION_SAMPLES} published signage-panel figures, without the label's luminance correction (${n('size')}); a workspace default (${n('workspace_default')}); or a ${wattage.DEFAULT_DIAGONAL_IN}-inch panel by the same formula when nothing is known (${n('default')}). Screens since removed use their last figures (${n('snapshot')}). Standby uses the datasheet figure or ${wattage.DEFAULT_STANDBY_W} W (the standby figure the curated panels publish). Media players, PCs and network equipment are not included unless the operator's figure includes them.`,
    `- Carbon intensity: annual average grid intensity for the screen's country (${g.name}, ${g.year}; ${g.url}), or a figure entered by the operator. Location-based method per the GHG Protocol Scope 2 Guidance; no market-based instruments are applied.`,
    '- Savings: hours the panel was off because of its power schedule × (on-power − standby power).',
    '',
    `Generated by ScreenTinker on ${new Date().toISOString().slice(0, 10)}.`,
  ].join('\n');
}

router.get('/appendix', (req, res) => {
  if (!requireWs(req, res)) return;
  const p = period(req, res);
  if (!p) return;
  const r = energy.report(db, req.workspaceId, p);
  const ws = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(req.workspaceId) || {};
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename=energy-appendix-${p.start}-to-${p.end}.txt`);
  res.send(appendixText(r, ws.name || 'Workspace'));
});

function hourParam(v, dflt) {
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
}

router.get('/suggestions', (req, res) => {
  if (!requireWs(req, res)) return;
  const start = hourParam(req.query.start, 22);
  const end = hourParam(req.query.end, 6);
  if (start === null || end === null || start === end) return res.status(400).json({ error: 'start and end must be different hours 0-23' });
  let days = null;
  if (req.query.days) {
    days = String(req.query.days).split(',').map(Number);
    if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return res.status(400).json({ error: 'days must be 0-6 (0 = Sunday)' });
  }
  res.json(energy.suggestions(db, req.workspaceId, { start, end, days }));
});

router.get('/glance', (req, res) => {
  if (!requireWs(req, res)) return;
  res.json(energy.glance(db, req.workspaceId));
});

router.get('/devices', (req, res) => {
  if (!requireWs(req, res)) return;
  res.json({ devices: energy.deviceList(db, req.workspaceId), can_write: canWrite(req) });
});

function writeGate(req, res) {
  if (!requireWs(req, res)) return false;
  if (denyReadOnly(req, res)) return false;
  if (!canWrite(req)) { res.status(403).json({ error: 'Workspace editor or admin required' }); return false; }
  return true;
}

/*
 * ⚠️ THE SCREEN MUST BE IN THE ACTIVE WORKSPACE. Unknown and foreign ids answer the same 404, so the
 * endpoint cannot be used to learn which screen ids exist elsewhere.
 */
router.put('/devices/:id', (req, res) => {
  if (!writeGate(req, res)) return;
  const d = db.prepare('SELECT id, name FROM devices WHERE id = ? AND workspace_id = ?').get(String(req.params.id), req.workspaceId);
  if (!d) return res.status(404).json({ error: 'Not found' });
  const v = energy.validateOverride(req.body || {});
  if (!v.ok) return res.status(400).json({ error: v.error });
  energy.saveOverride(db, req.workspaceId, [d.id], v.override, req.user && req.user.id);
  auditFromReq(req, 'energy_screen_watts_set', { workspace_id: req.workspaceId, device_id: d.id, ...v.override });
  res.json({ ok: true, device: energy.deviceList(db, req.workspaceId).find((x) => x.id === d.id) || null });
});

router.put('/groups/:id', (req, res) => {
  if (!writeGate(req, res)) return;
  const g = db.prepare('SELECT id, name FROM device_groups WHERE id = ? AND workspace_id = ?').get(String(req.params.id), req.workspaceId);
  if (!g) return res.status(404).json({ error: 'Not found' });
  const v = energy.validateOverride(req.body || {});
  if (!v.ok) return res.status(400).json({ error: v.error });
  // Members are re-checked against the workspace: membership rows alone are not proof of tenancy.
  const ids = db.prepare(`SELECT d.id FROM device_group_members m JOIN devices d ON d.id = m.device_id
    WHERE m.group_id = ? AND d.workspace_id = ?`).all(g.id, req.workspaceId).map((r) => r.id);
  energy.saveOverride(db, req.workspaceId, ids, v.override, req.user && req.user.id);
  auditFromReq(req, 'energy_group_watts_set', { workspace_id: req.workspaceId, group_id: g.id, screens: ids.length, ...v.override });
  res.json({ ok: true, screens: ids.length });
});

router.get('/settings', (req, res) => {
  if (!requireWs(req, res)) return;
  res.json({
    settings: energy.publicSettings(energy.workspaceSettings(db, req.workspaceId)),
    countries: carbon.countryList(), world: carbon.WORLD, source: carbon.SOURCE,
    assumptions: { eei: wattage.ASSUMED_EEI, default_diagonal_in: wattage.DEFAULT_DIAGONAL_IN, default_standby_w: wattage.DEFAULT_STANDBY_W },
    can_admin: canAdmin(req),
  });
});

router.put('/settings', (req, res) => {
  if (!requireWs(req, res)) return;
  if (denyReadOnly(req, res)) return;
  if (!canAdmin(req)) return res.status(403).json({ error: 'Workspace admin required' });
  const before = energy.publicSettings(energy.workspaceSettings(db, req.workspaceId));
  const v = energy.validateSettings(req.body || {});
  if (!v.ok) return res.status(400).json({ error: v.error });
  energy.saveSettings(db, req.workspaceId, v.settings, req.user && req.user.id);
  auditFromReq(req, 'energy_settings_updated', { workspace_id: req.workspaceId, before, after: v.settings });
  res.json({ settings: v.settings });
});

/*
 * Org rollup. ⚠️ The organization is the ACTIVE workspace's, resolved by resolveTenancy, and the
 * caller must be its owner/admin (or platform admin): a workspace admin of one shop must not see
 * the other shops' figures.
 */
function orgGate(req, res) {
  if (!requireWs(req, res)) return false;
  if (!req.organizationId || !isOrgAdmin(req)) { res.status(403).json({ error: 'Organization admin required' }); return false; }
  return true;
}

router.get('/org', (req, res) => {
  if (!orgGate(req, res)) return;
  const p = period(req, res);
  if (!p) return;
  res.json(energy.orgRollup(db, req.organizationId, p));
});

router.get('/org/export', (req, res) => {
  if (!orgGate(req, res)) return;
  const p = period(req, res);
  if (!p) return;
  const r = energy.orgRollup(db, req.organizationId, p);
  const csv = 'Workspace,Screens,kWh,kg CO2e,kWh saved,kg CO2e saved\n'
    + r.workspaces.map((w) => [csvCell(w.name), w.screens, w.kwh, w.kg_co2e, w.saved_kwh, w.saved_kg_co2e].join(',')).join('\n')
    + `\n${csvCell('Total')},${r.totals.screens},${r.totals.kwh},${r.totals.kg_co2e},${r.totals.saved_kwh},${r.totals.saved_kg_co2e}\n`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=energy-organization-${p.start}-to-${p.end}.csv`);
  res.send(csv);
});

module.exports = router;
module.exports.appendixText = appendixText;
