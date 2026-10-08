'use strict';

/*
 * Tableau Cloud / Tableau Server through a CONNECTED APP (direct trust).
 *
 * The server signs a short JWT with the connected app's secret, for the one Tableau user the screens
 * view as, scoped to embedding views only (tableau:views:embed). The screen gets that JWT — good for
 * five minutes and for nothing but loading a view — and the Tableau Embedding API v3 trades it for a
 * session. The secret value never leaves here.
 *
 * ⚠️ Every JWT is fresh (a new jti): Tableau refuses a JWT it has already seen.
 *
 * Use a dedicated Tableau user that can see only the dashboards meant for screens: anyone who can
 * open a widget's page can obtain a JWT that embeds views as that user.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const SEG_RE = /^[A-Za-z0-9_.%~-]{1,200}$/;
const JWT_LIFETIME_S = 5 * 60;

/**
 * A view as "Workbook/Sheet", from that or from any address of it: /views/W/S, /t/site/views/W/S,
 * or Tableau Cloud's #/site/x/views/W/S. Returns the path or null.
 */
function viewPathOf(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  try { const u = new URL(s); s = `${u.pathname}${u.hash.replace(/^#/, '')}`; } catch { /* a bare path */ }
  s = s.split('?')[0];
  const m = /(?:^|\/)views\/([^/]+)\/([^/]+)/.exec(s) || /^\/?([^/]+)\/([^/]+)\/?$/.exec(s);
  if (!m) return null;
  if (!SEG_RE.test(m[1]) || !SEG_RE.test(m[2])) return null;
  return `${m[1]}/${m[2]}`;
}

function normaliseWidgetConfig(c) {
  const view = viewPathOf(c.view);
  if (!view) throw new Error('Enter the view as Workbook/Sheet, or paste its address.');
  return { view, rotate_sheets: !!c.rotate_sheets, hide_tabs: c.hide_tabs !== false };
}

/** The view's embed address on this connection's site. */
function viewUrl(conn, cfg) {
  const base = String(conn.config.server_url).replace(/\/+$/, '');
  const site = conn.config.site ? `/t/${encodeURIComponent(conn.config.site)}` : '';
  return `${base}${site}/views/${cfg.view}`;
}

/** The Embedding API module, served by the Tableau host itself (that is how Tableau ships it). */
function embeddingApiUrl(conn) {
  return `${String(conn.config.server_url).replace(/\/+$/, '')}/javascripts/api/tableau.embedding.3.latest.min.js`;
}

function mintJwt(conn, { scopes = ['tableau:views:embed'], now = Date.now() } = {}) {
  const secret = require('./connections').secretOf(conn);
  const iat = Math.floor(now / 1000);
  return jwt.sign({
    iss: conn.config.client_id,
    sub: conn.config.username,
    aud: 'tableau',
    jti: crypto.randomUUID(),
    scp: scopes,
    iat,
    exp: iat + JWT_LIFETIME_S,
  }, secret, { algorithm: 'HS256', header: { alg: 'HS256', typ: 'JWT', kid: conn.config.secret_id, iss: conn.config.client_id } });
}

/** Connection test: sign in to the REST API with a JWT, which proves the app, secret and user. */
async function test(conn) {
  const biHttp = require('./http');
  const base = String(conn.config.server_url).replace(/\/+$/, '');
  const checks = [];
  let token;
  try {
    // Sign-in needs a REST scope, not the embed one; this JWT is used once, here, and discarded.
    token = mintJwt(conn, { scopes: ['tableau:content:read'] });
  } catch (e) {
    checks.push({ name: 'secret', ok: false, detail: e.message });
    return { ok: false, checks };
  }
  try {
    const r = await biHttp.request(`${base}/api/3.17/auth/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ credentials: { jwt: token, site: { contentUrl: conn.config.site || '' } } }),
      allowPrivate: !!conn.allow_private,
      maxBytes: 256 * 1024,
    });
    let detail = `Tableau answered ${r.status}`;
    if (r.status === 200) detail = `signed in as ${conn.config.username}`;
    else {
      try { const b = JSON.parse(r.body.toString()); if (b.error) detail = `${b.error.summary || 'refused'}: ${b.error.detail || b.error.code || ''}`.slice(0, 200); } catch { /* */ }
    }
    checks.push({ name: 'sign_in', ok: r.status === 200, detail });
  } catch (e) {
    checks.push({ name: 'sign_in', ok: false, detail: biHttp.describe(e) });
  }
  return { ok: checks.every((c) => c.ok), checks };
}

module.exports = { viewPathOf, normaliseWidgetConfig, viewUrl, embeddingApiUrl, mintJwt, test, JWT_LIFETIME_S };
