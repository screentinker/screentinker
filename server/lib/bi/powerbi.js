'use strict';

/*
 * Power BI, "App owns data": the organization's own Entra app (a service principal) signs in with
 * client credentials, and the server asks Power BI for an EMBED token for one report. The screen
 * gets that embed token only — view access to one report, expiring within the hour — and fetches a
 * fresh one before it expires (GET /api/widgets/:id/bi-token). The client secret never leaves here.
 *
 * Embed tokens are cached per report until ten minutes before they expire, so however many screens
 * show a report, or however often its page is loaded, Power BI is asked about once an hour.
 *
 * Commercial cloud only (login.microsoftonline.com / api.powerbi.com).
 */

const AUTHORITY = 'https://login.microsoftonline.com';
const API = 'https://api.powerbi.com/v1.0/myorg';
const SCOPE = 'https://analysis.windows.net/powerbi/api/.default';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_RE = /^[A-Za-z0-9_-]{1,80}$/;

const aadCache = new Map();     // conn key -> { token, exp }
const embedCache = new Map();   // conn key|group|report -> { embedUrl, reportId, token, expiration, exp }
const inflight = new Map();

function normaliseWidgetConfig(c) {
  const group = String(c.group_id || '').trim();
  const report = String(c.report_id || '').trim();
  if (!GUID_RE.test(group)) throw new Error('Enter the Power BI workspace ID (the GUID after /groups/ in the report address).');
  if (!GUID_RE.test(report)) throw new Error('Enter the report ID (the GUID after /reports/ in the report address).');
  const pages = (Array.isArray(c.pages) ? c.pages : String(c.pages || '').split(','))
    .map((p) => String(p).trim()).filter(Boolean);
  if (pages.some((p) => !PAGE_RE.test(p))) throw new Error('Page names are the IDs in the report address (ReportSection…), separated by commas.');
  return { group_id: group, report_id: report, pages: pages.slice(0, 30), rotate_pages: !!c.rotate_pages };
}

async function call(url, opts, what) {
  let r;
  try {
    r = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw new Error(`could not reach ${what}`);
  }
  let body = null;
  try { body = await r.json(); } catch { /* */ }
  if (!r.ok) {
    // Entra and Power BI put a readable reason in the body; pass the CODE, never the request.
    const code = (body && (body.error_codes ? `AADSTS${body.error_codes[0]}` : (body.error && (body.error.code || body.error)))) || r.status;
    const err = new Error(`${what} answered ${r.status} (${String(code).slice(0, 80)})`);
    err.status = r.status;
    throw err;
  }
  return body || {};
}

function connKey(conn) { return `${conn.id}|${conn.updated_at}`; }

async function aadToken(conn, now = Date.now()) {
  const k = connKey(conn);
  const hit = aadCache.get(k);
  if (hit && hit.exp - 5 * 60 * 1000 > now) return hit.token;
  const secret = require('./connections').secretOf(conn);
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: conn.config.client_id, client_secret: secret, scope: SCOPE });
  const out = await call(`${AUTHORITY}/${encodeURIComponent(conn.config.tenant_id)}/oauth2/v2.0/token`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() }, 'Microsoft sign-in');
  if (!out.access_token) throw new Error('Microsoft sign-in returned no token');
  aadCache.set(k, { token: out.access_token, exp: now + (Number(out.expires_in) || 3600) * 1000 });
  return out.access_token;
}

/** { embedUrl, reportId, token, expiration } for a report — cached until 10 minutes before expiry. */
async function embedFor(conn, cfg, now = Date.now()) {
  const k = `${connKey(conn)}|${cfg.group_id}|${cfg.report_id}`;
  const hit = embedCache.get(k);
  if (hit && hit.exp - 10 * 60 * 1000 > now) return strip(hit);
  if (!inflight.has(k)) {
    const p = (async () => {
      const bearer = await aadToken(conn, now);
      const h = { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' };
      const base = `${API}/groups/${cfg.group_id}/reports/${cfg.report_id}`;
      let report;
      try {
        report = await call(base, { headers: h }, 'Power BI');
      } catch (e) {
        if (e.status === 401 || e.status === 403 || e.status === 404) {
          throw new Error('Power BI would not open this report for the app. Add the app (or a group it is in) to the Power BI workspace, and allow service principals to use Power BI APIs in the tenant settings.');
        }
        throw e;
      }
      const gen = await call(`${base}/GenerateToken`, { method: 'POST', headers: h, body: JSON.stringify({ accessLevel: 'View' }) }, 'Power BI');
      if (!gen.token || !report.embedUrl) throw new Error('Power BI returned no embed token');
      const exp = Date.parse(gen.expiration) || (now + 60 * 60 * 1000);
      const entry = { embedUrl: report.embedUrl, reportId: report.id || cfg.report_id, token: gen.token, expiration: new Date(exp).toISOString(), exp };
      embedCache.set(k, entry);
      while (embedCache.size > 500) embedCache.delete(embedCache.keys().next().value);
      return entry;
    })().finally(() => inflight.delete(k));
    inflight.set(k, p);
  }
  return strip(await inflight.get(k));
}

function strip(e) { return { embedUrl: e.embedUrl, reportId: e.reportId, token: e.token, expiration: e.expiration }; }

async function test(conn) {
  const checks = [];
  let bearer;
  try {
    bearer = await aadToken(conn);
    checks.push({ name: 'sign_in', ok: true, detail: 'the app signed in to Entra ID' });
  } catch (e) {
    checks.push({ name: 'sign_in', ok: false, detail: e.message });
    return { ok: false, checks };
  }
  try {
    const out = await call(`${API}/groups?$top=100`, { headers: { Authorization: `Bearer ${bearer}` } }, 'Power BI');
    const n = Array.isArray(out.value) ? out.value.length : 0;
    checks.push({ name: 'workspaces', ok: n > 0, detail: n > 0 ? `the app can see ${n} workspace${n === 1 ? '' : 's'}` : 'the app can see no workspaces — add it to the workspace that holds your reports' });
  } catch (e) {
    checks.push({ name: 'workspaces', ok: false, detail: e.status === 401 || e.status === 403 ? 'Power BI refused the app — allow service principals to use Power BI APIs in the tenant settings' : e.message });
  }
  return { ok: checks.every((c) => c.ok), checks };
}

function _resetCache() { aadCache.clear(); embedCache.clear(); inflight.clear(); }

module.exports = { normaliseWidgetConfig, aadToken, embedFor, test, _resetCache };
