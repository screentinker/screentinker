'use strict';

/*
 * BI dashboards (lib/bi/*, routes/bi-connections.js, the bi-dashboard widget in routes/widgets.js).
 *
 *   - a connection's secret never comes back from the API, and only an org admin may manage one
 *   - private addresses only when an operator allows them; a connection that may not reach a
 *     private address does not, even when the widget page asks
 *   - Grafana: the server renders with the token, caches per refresh interval, serves the last good
 *     image when Grafana is down — and the page itself carries no token
 *   - Power BI: Entra client credentials → GenerateToken (View), both cached; the screen gets the
 *     embed token only
 *   - Tableau: a connected-app JWT with the claims Tableau requires, fresh each time
 *   - a widget can only use its own organization's connection
 *
 * Grafana and Tableau Server are real local HTTP servers; Microsoft's hosts are mocked in fetch.
 */

const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-bi-' + crypto.randomBytes(4).toString('hex'));
process.env.JWT_SECRET = 'test-secret-bi';
process.env.SELF_HOSTED = 'true';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { db } = require('../db/database');
const config = require('../config');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const tableau = require('../lib/bi/tableau');
const grafana = require('../lib/bi/grafana');
const powerbi = require('../lib/bi/powerbi');
const biWidget = require('../lib/bi/widget');

const GRAFANA_TOKEN = 'glsa_SECRETgrafanaTOKEN_0123456789';
const PBI_SECRET = 'pbi~client~SECRET~value~0123456789';
const TAB_SECRET = 'tableau-connected-app-SECRET-0123456789abcdef';
const GUID = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

/* ── unit ─────────────────────────────────────────────────────────────────────────── */

test('Tableau JWT: the claims a connected app requires, a fresh jti each time, signed with the secret', () => {
  const conn = { config: { client_id: GUID(1), secret_id: GUID(2), username: 'screens@acme.test' }, secret_enc: require('../lib/secretbox').encrypt(TAB_SECRET) };
  const a = tableau.mintJwt(conn, { now: 1_800_000_000_000 });
  const b = tableau.mintJwt(conn, { now: 1_800_000_000_000 });
  const dec = jwt.decode(a, { complete: true });
  assert.deepEqual({ alg: dec.header.alg, kid: dec.header.kid, iss: dec.header.iss }, { alg: 'HS256', kid: GUID(2), iss: GUID(1) });
  assert.equal(dec.payload.aud, 'tableau');
  assert.equal(dec.payload.iss, GUID(1));
  assert.equal(dec.payload.sub, 'screens@acme.test');
  assert.deepEqual(dec.payload.scp, ['tableau:views:embed']);
  assert.ok(dec.payload.exp - dec.payload.iat <= 600, 'Tableau refuses a JWT living longer than 10 minutes');
  assert.match(dec.payload.jti, /^[0-9a-f-]{36}$/);
  assert.notEqual(jwt.decode(b).jti, dec.payload.jti, 'a JWT is never reused');
  jwt.verify(a, TAB_SECRET, { algorithms: ['HS256'], audience: 'tableau', clockTimestamp: 1_800_000_010 });
});

test('Tableau view addresses, public links and Grafana variables are parsed strictly', () => {
  assert.equal(tableau.viewPathOf('Superstore/Overview'), 'Superstore/Overview');
  assert.equal(tableau.viewPathOf('https://10ax.online.tableau.com/#/site/acme/views/Superstore/Overview?:iid=1'), 'Superstore/Overview');
  assert.equal(tableau.viewPathOf('https://tab.acme.test/t/acme/views/Sales/Map'), 'Sales/Map');
  assert.equal(tableau.viewPathOf('../../etc/passwd'), null);
  assert.equal(biWidget.publicUrlFor('tableau', 'https://public.tableau.com/app/profile/x/viz/Book/Sheet1'), 'https://public.tableau.com/views/Book/Sheet1');
  assert.throws(() => biWidget.publicUrlFor('powerbi', 'https://evil.example/view?r=1'), /Publish to web/);
  assert.throws(() => biWidget.publicUrlFor('tableau', 'https://tab.acme.test/views/A/B'), /public\.tableau\.com/);
  assert.throws(() => biWidget.publicUrlFor('grafana', 'javascript:alert(1)'), /https/);
  const g = grafana.normaliseWidgetConfig({ dashboard_uid: 'abc_1', vars: 'var-host=web1&width=99999&kiosk=0&var-env=prod' });
  assert.equal(g.vars, 'var-host=web1&var-env=prod', 'only var-* keys survive, so render options cannot be injected');
  assert.throws(() => grafana.normaliseWidgetConfig({ dashboard_uid: '../x' }), /UID/);
  const url = grafana.renderUrl({ config: { base_url: 'https://g.example/grafana' } }, { ...g, org_id: 1, theme: 'dark' }, { width: 1920, height: 1088 });
  assert.match(url, /^https:\/\/g\.example\/grafana\/render\/d\/abc_1\?orgId=1&width=1920&height=1088&theme=dark&kiosk=&timeout=60&var-host=web1&var-env=prod$/);
  assert.equal(grafana.sizeBucket(1913, 320, 3840, 1920), 1920);
  assert.equal(grafana.sizeBucket(99999, 320, 3840, 1920), 3840);
});

test('connection input: GUIDs, single-tenant Entra, a secret is required, private needs an operator', () => {
  const c = require('../lib/bi/connections');
  assert.throws(() => c.normaliseInput({ kind: 'powerbi', name: 'x', tenant_id: 'common', client_id: GUID(1), secret: 's' }), /tenant/);
  assert.throws(() => c.normaliseInput({ kind: 'powerbi', name: 'x', tenant_id: 'acme.onmicrosoft.com', client_id: 'nope', secret: 's' }), /GUID/);
  assert.throws(() => c.normaliseInput({ kind: 'grafana', name: 'x', base_url: 'https://g.example' }), /token is required/);
  assert.throws(() => c.normaliseInput({ kind: 'grafana', name: 'x', base_url: 'https://u:p@g.example', secret: 't' }), /user name/);
  assert.throws(() => c.normaliseInput({ kind: 'grafana', name: 'x', base_url: 'https://g.example', secret: 't', allow_private: true }), (e) => e.status === 403);
  const ok = c.normaliseInput({ kind: 'grafana', name: 'G', base_url: 'https://g.example/', secret: 't', allow_private: true }, null, { canAllowPrivate: true });
  assert.equal(ok.config.base_url, 'https://g.example');
  assert.equal(ok.allowPrivate, true);
  assert.ok(!JSON.stringify(c.present({ id: '1', kind: 'grafana', name: 'G', config: JSON.stringify(ok.config), secret_enc: ok.secretEnc })).includes(ok.secretEnc));
});

/* ── HTTP, against a real local Grafana / Tableau and mocked Microsoft ─────────────── */

const ORG = 'o-bi', WS = 'ws-bi', ADMIN = 'u-bi-admin', EDITOR = 'u-bi-ed';
const ORG2 = 'o-bi2', WS2 = 'ws-bi2', ADMIN2 = 'u-bi-admin2';
let server, base, mock, mockBase;
const hits = { render: [], search: 0, signin: [], aad: 0, gen: 0 };
let grafanaDown = false;
const realFetch = global.fetch;

before(async () => {
  db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, 'bia@t.local', 'x', 'user'), (?, 'bie@t.local', 'x', 'user'), (?, 'bia2@t.local', 'x', 'user')").run(ADMIN, EDITOR, ADMIN2);
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?), (?, ?, ?)').run(ORG, 'Org', ADMIN, ORG2, 'Other', ADMIN2);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?), (?, ?, ?)').run(WS, ORG, 'HQ', WS2, ORG2, 'Elsewhere');
  db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner'), (?, ?, 'org_member'), (?, ?, 'org_owner')").run(ORG, ADMIN, ORG, EDITOR, ORG2, ADMIN2);
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin'), (?, ?, 'workspace_editor'), (?, ?, 'workspace_admin')").run(WS, ADMIN, WS, EDITOR, WS2, ADMIN2);

  // The "Grafana" and "Tableau Server" — on loopback, so only an allow_private connection reaches them.
  mock = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/render/')) {
      hits.render.push({ path: u.pathname, q: Object.fromEntries(u.searchParams), auth: req.headers.authorization });
      if (grafanaDown) { res.writeHead(503); return res.end('down'); }
      res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG);
    }
    if (u.pathname === '/api/search') {
      hits.search++;
      if (req.headers.authorization !== `Bearer ${GRAFANA_TOKEN}`) { res.writeHead(401); return res.end('{}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify([{ uid: 'ops-1', title: 'Operations', folderTitle: 'NOC' }]));
    }
    if (u.pathname === '/api/plugins/grafana-image-renderer/settings') { res.writeHead(200); return res.end('{}'); }
    if (u.pathname === '/api/3.17/auth/signin') {
      let body = ''; req.on('data', (c) => { body += c; });
      req.on('end', () => { hits.signin.push(JSON.parse(body)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"credentials":{"token":"x"}}'); });
      return;
    }
    res.writeHead(404); res.end();
  });
  mock.listen(0, '127.0.0.1');
  await new Promise((r) => mock.once('listening', r));
  mockBase = `http://127.0.0.1:${mock.address().port}`;

  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://login.microsoftonline.com/')) {
      hits.aad++;
      const body = new URLSearchParams(opts.body);
      if (body.get('client_secret') !== PBI_SECRET) return new Response(JSON.stringify({ error: 'invalid_client', error_codes: [7000215] }), { status: 401 });
      return new Response(JSON.stringify({ access_token: 'AAD-ACCESS', expires_in: 3599 }), { status: 200 });
    }
    if (u.startsWith('https://api.powerbi.com/')) {
      if ((opts.headers || {}).Authorization !== 'Bearer AAD-ACCESS') return new Response('{}', { status: 403 });
      if (u.endsWith('/GenerateToken')) {
        hits.gen++;
        assert.deepEqual(JSON.parse(opts.body), { accessLevel: 'View' }, 'view-only embed tokens');
        return new Response(JSON.stringify({ token: `EMBED-${hits.gen}`, tokenId: 't', expiration: new Date(Date.now() + 3600e3).toISOString() }), { status: 200 });
      }
      if (/\/groups\/[^/]+\/reports\/[^/]+$/.test(u)) return new Response(JSON.stringify({ id: GUID(20), embedUrl: 'https://app.powerbi.com/reportEmbed?reportId=r', datasetId: 'd' }), { status: 200 });
      if (/\/groups\?/.test(u)) return new Response(JSON.stringify({ value: [{ id: GUID(10), name: 'Sales' }] }), { status: 200 });
      if (/\/groups\/[^/]+\/reports$/.test(u)) return new Response(JSON.stringify({ value: [{ id: GUID(20), name: 'Weekly' }] }), { status: 200 });
    }
    return realFetch(url, opts);
  };

  const app = express();
  app.use(express.json());
  app.get('/api/widgets/:id/bi-image.png', (req, res, next) => { req._skipAuth = true; next(); });
  app.get('/api/widgets/:id/bi-token', (req, res, next) => { req._skipAuth = true; next(); });
  app.get('/api/widgets/:id/render', (req, res, next) => { req._skipAuth = true; next(); });
  const authed = (req, res, next) => (req._skipAuth ? next() : requireAuth(req, res, () => resolveTenancy(req, res, next)));
  app.use('/api/widgets', authed, require('../routes/widgets'));
  app.use('/api/bi-connections', requireAuth, resolveTenancy, require('../routes/bi-connections'));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  global.fetch = realFetch;
  try { server.close(); } catch { /* */ }
  try { mock.close(); } catch { /* */ }
  try { require('node:fs').rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

const tokenOf = (u) => generateToken(db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(u), u === ADMIN2 ? WS2 : WS);
async function api(method, p, body, who = ADMIN) {
  const headers = who ? { Authorization: `Bearer ${tokenOf(who)}`, 'Content-Type': 'application/json' } : {};
  const r = await realFetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await r.arrayBuffer());
  let json; try { json = JSON.parse(buf.toString()); } catch { json = null; }
  return { status: r.status, body: json, text: buf.toString(), buf, headers: r.headers };
}
const C = {};

test('connections: only an org admin manages them, and no secret ever comes back', async () => {
  const body = { kind: 'grafana', name: 'NOC Grafana', base_url: mockBase, secret: GRAFANA_TOKEN, allow_private: true };
  assert.equal((await api('POST', '/api/bi-connections', body, EDITOR)).status, 403);
  let r = await api('POST', '/api/bi-connections', body);
  assert.equal(r.status, 201, r.text);
  C.grafana = r.body.id;
  assert.equal(r.body.has_secret, true);
  assert.ok(!r.text.includes(GRAFANA_TOKEN));

  r = await api('POST', '/api/bi-connections', { kind: 'grafana', name: 'Public-only Grafana', base_url: mockBase, secret: GRAFANA_TOKEN });
  C.grafanaNoPrivate = r.body.id;
  r = await api('POST', '/api/bi-connections', { kind: 'powerbi', name: 'PBI', tenant_id: GUID(9), client_id: GUID(8), secret: PBI_SECRET });
  assert.equal(r.status, 201, r.text);
  C.pbi = r.body.id;
  r = await api('POST', '/api/bi-connections', { kind: 'tableau', name: 'Tab', server_url: mockBase, site: 'acme', client_id: GUID(1), secret_id: GUID(2), username: 'screens@acme.test', secret: TAB_SECRET, allow_private: true });
  assert.equal(r.status, 201, r.text);
  C.tab = r.body.id;

  const list = await api('GET', '/api/bi-connections', null, EDITOR);
  assert.equal(list.status, 200);
  assert.equal(list.body.can_manage, false);
  assert.equal(list.body.connections.length, 4);
  for (const s of [GRAFANA_TOKEN, PBI_SECRET, TAB_SECRET]) assert.ok(!list.text.includes(s), 'no secret in the list');
  assert.equal((await api('GET', '/api/bi-connections', null, ADMIN2)).body.connections.length, 0, 'another org sees none of them');

  // An update without a secret keeps it (the test below still signs in).
  r = await api('PUT', `/api/bi-connections/${C.grafana}`, { name: 'NOC' });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'NOC');

  // On a hosted instance a tenant cannot switch private addresses on.
  config.selfHosted = false;
  try {
    r = await api('PUT', `/api/bi-connections/${C.grafanaNoPrivate}`, { allow_private: true });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'BI_PRIVATE_FORBIDDEN');
  } finally { config.selfHosted = true; }
});

test('Test: Grafana token and renderer, Power BI sign-in and workspaces, Tableau sign-in by JWT', async () => {
  let r = await api('POST', `/api/bi-connections/${C.grafana}/test`, {});
  assert.equal(r.body.ok, true, r.text);
  r = await api('POST', `/api/bi-connections/${C.pbi}/test`, {});
  assert.equal(r.body.ok, true, r.text);
  assert.match(r.body.checks[1].detail, /1 workspace/);
  r = await api('POST', `/api/bi-connections/${C.tab}/test`, {});
  assert.equal(r.body.ok, true, r.text);
  const sent = hits.signin.at(-1);
  assert.equal(sent.credentials.site.contentUrl, 'acme');
  assert.deepEqual(jwt.verify(sent.credentials.jwt, TAB_SECRET, { audience: 'tableau' }).scp, ['tableau:content:read']);
  r = await api('POST', `/api/bi-connections/${C.grafanaNoPrivate}/test`, {});
  assert.equal(r.body.ok, false);
  assert.match(r.body.checks[0].detail, /private or reserved network/, 'loopback is refused without the operator flag');
  r = await api('GET', `/api/bi-connections/${C.grafana}/dashboards?q=op`, null, EDITOR);
  assert.deepEqual(r.body.items, [{ id: 'ops-1', title: 'Operations', folder: 'NOC' }]);
  r = await api('GET', `/api/bi-connections/${C.pbi}/dashboards`, null, EDITOR);
  assert.deepEqual(r.body.items, [{ id: GUID(20), group_id: GUID(10), title: 'Weekly', folder: 'Sales' }]);
});

const W = {};
test('a dashboard widget can only use its own organization\'s connection, of the right kind', async () => {
  const mk = (cfg, who = ADMIN) => api('POST', '/api/widgets', { widget_type: 'bi-dashboard', name: 'D', config: cfg }, who);
  let r = await mk({ provider: 'grafana', connection_id: C.grafana, dashboard_uid: 'ops-1' }, ADMIN2);
  assert.equal(r.status, 400, 'another organization cannot borrow it');
  r = await mk({ provider: 'powerbi', connection_id: C.grafana, group_id: GUID(10), report_id: GUID(20) });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /for grafana/);
  r = await mk({ provider: 'grafana', connection_id: C.grafana, dashboard_uid: 'ops-1', vars: 'var-site=a', refresh_sec: 5 });
  assert.equal(r.status, 201, r.text);
  W.grafana = r.body.id;
  assert.equal(JSON.parse(r.body.config).refresh_sec, 30, 'never more often than every 30 seconds');
  W.grafanaNoPrivate = (await mk({ provider: 'grafana', connection_id: C.grafanaNoPrivate, dashboard_uid: 'ops-1' })).body.id;
  W.pbi = (await mk({ provider: 'powerbi', connection_id: C.pbi, group_id: GUID(10), report_id: GUID(20), rotate_pages: true, rotate_sec: 30 })).body.id;
  W.tab = (await mk({ provider: 'tableau', connection_id: C.tab, view: 'https://x/#/site/acme/views/Sales/Map' })).body.id;
  W.pub = (await mk({ provider: 'powerbi', mode: 'public', public_url: 'https://app.powerbi.com/view?r=abc' })).body.id;
  assert.ok(W.pbi && W.tab && W.pub);
});

test('Grafana: rendered with the token, cached, last good image when down, and the page holds no token', async () => {
  let r = await api('GET', `/api/widgets/${W.grafana}/render?rev=1`, null, null);
  assert.equal(r.status, 200);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /sandbox allow-scripts/);
  assert.match(csp, /default-src 'none'/);
  assert.ok(r.text.includes(`/api/widgets/${W.grafana}/bi-image.png`));
  assert.ok(!r.text.includes(GRAFANA_TOKEN) && !r.text.includes(mockBase), 'neither the token nor Grafana\'s address is in the page');

  hits.render = [];
  r = await api('GET', `/api/widgets/${W.grafana}/bi-image.png?w=1913&h=1080`, null, null);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.ok(r.buf.equals(PNG));
  assert.equal(hits.render.length, 1);
  assert.equal(hits.render[0].auth, `Bearer ${GRAFANA_TOKEN}`);
  assert.equal(hits.render[0].path, '/render/d/ops-1');
  assert.equal(hits.render[0].q.width, '1920');
  assert.equal(hits.render[0].q['var-site'], 'a');
  await api('GET', `/api/widgets/${W.grafana}/bi-image.png?w=1920&h=1080`, null, null);
  assert.equal(hits.render.length, 1, 'a second screen of the same size is served from the cache');

  grafana._resetCache();
  await api('GET', `/api/widgets/${W.grafana}/bi-image.png?w=1920&h=1080`, null, null);
  // Age the entry past its refresh interval, then take Grafana down.
  grafanaDown = true;
  const realNow = Date.now;
  Date.now = () => realNow() + 31_000;
  try {
    r = await api('GET', `/api/widgets/${W.grafana}/bi-image.png?w=1920&h=1080`, null, null);
  } finally { Date.now = realNow; grafanaDown = false; }
  assert.equal(r.status, 200, 'the last good image, not a blank screen');
  assert.equal(r.headers.get('x-dashboard-stale'), '1');

  hits.render = [];
  r = await api('GET', `/api/widgets/${W.grafanaNoPrivate}/bi-image.png`, null, null);
  assert.equal(r.status, 502);
  assert.equal(hits.render.length, 0, 'a connection without the private flag never reached loopback');
});

test('Power BI: embed token through cached Entra + GenerateToken; the page loads the vendored client only', async () => {
  powerbi._resetCache();
  hits.aad = 0; hits.gen = 0;
  let r = await api('GET', `/api/widgets/${W.pbi}/bi-token`, null, null);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal(r.body.token, 'EMBED-1');
  assert.equal(r.body.embedUrl, 'https://app.powerbi.com/reportEmbed?reportId=r');
  assert.ok(!r.text.includes(PBI_SECRET) && !r.text.includes('AAD-ACCESS'), 'neither the client secret nor the Entra token');
  r = await api('GET', `/api/widgets/${W.pbi}/bi-token`, null, null);
  assert.equal(r.body.token, 'EMBED-1');
  assert.deepEqual([hits.aad, hits.gen], [1, 1], 'one sign-in and one embed token, however often a screen asks');

  r = await api('GET', `/api/widgets/${W.pbi}/render`, null, null);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /frame-src https:\/\/app\.powerbi\.com/);
  assert.match(csp, /script-src 'unsafe-inline' http:\/\/127\.0\.0\.1:\d+;/);
  assert.match(r.text, /\/vendor\/powerbi\/powerbi\.min\.js/);
  assert.ok(!r.text.includes('EMBED-'), 'the page itself never carries a token');

  r = await api('GET', `/api/widgets/${W.pub}/render`, null, null);
  assert.match(r.text, /<iframe id="f" src="https:\/\/app\.powerbi\.com\/view\?r=abc" sandbox="allow-scripts"/);
  assert.equal((await api('GET', `/api/widgets/${W.pub}/bi-token`, null, null)).status, 404);
});

test('Tableau: a fresh connected-app JWT for the view, and the page loads the Embedding API from the Tableau host', async () => {
  const r1 = await api('GET', `/api/widgets/${W.tab}/bi-token`, null, null);
  assert.equal(r1.status, 200, r1.text);
  assert.equal(r1.body.src, `${mockBase}/t/acme/views/Sales/Map`);
  const claims = jwt.verify(r1.body.token, TAB_SECRET, { audience: 'tableau' });
  assert.equal(claims.sub, 'screens@acme.test');
  assert.deepEqual(claims.scp, ['tableau:views:embed']);
  assert.ok(!r1.text.includes(TAB_SECRET));
  const r2 = await api('GET', `/api/widgets/${W.tab}/bi-token`, null, null);
  assert.notEqual(jwt.decode(r2.body.token).jti, claims.jti);
  const page = await api('GET', `/api/widgets/${W.tab}/render`, null, null);
  assert.ok(page.text.includes(`${mockBase}/javascripts/api/tableau.embedding.3.latest.min.js`));
  assert.match(page.headers.get('content-security-policy'), new RegExp(`frame-src ${mockBase.replace(/[.]/g, '\\.')}`));
  // Bounded: a leaked address cannot be used to mint tokens without limit.
  let last;
  for (let i = 0; i < 30; i++) last = await api('GET', `/api/widgets/${W.tab}/bi-token`, null, null);
  assert.equal(last.status, 429);
});

test('a widget that points at another organization\'s connection shows nothing and gets no token', async () => {
  // Written straight to the database, past the save-time check, as an old or hand-edited row would be.
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO widgets (id, user_id, workspace_id, widget_type, name, config) VALUES (?, ?, ?, 'bi-dashboard', 'x', ?)")
    .run(id, ADMIN2, WS2, JSON.stringify({ provider: 'powerbi', mode: 'connection', connection_id: C.pbi, group_id: GUID(10), report_id: GUID(20) }));
  const page = await api('GET', `/api/widgets/${id}/render`, null, null);
  assert.match(page.text, /connection has been removed/);
  assert.equal((await api('GET', `/api/widgets/${id}/bi-token`, null, null)).status, 404);
  assert.equal((await api('GET', `/api/widgets/${id}/bi-image.png`, null, null)).status, 404);
});

test('coexists with the cloud-doc widget (#521): both reserved, each render keeps its own CSP', async () => {
  const { RESERVED_WIDGET_TYPES, BUILTIN_WIDGET_TYPES } = require('../lib/plugins/reserved');
  for (const t of ['cloud-doc', 'bi-dashboard']) {
    assert.ok(RESERVED_WIDGET_TYPES.has(t) && BUILTIN_WIDGET_TYPES.includes(t), `${t} is reserved and built in`);
  }
  const cd = await api('POST', '/api/widgets', { widget_type: 'cloud-doc', name: 'Deck',
    config: { url: 'https://docs.google.com/presentation/d/1EAYk18WDjIG-zp_0vLm3CsfQh_i8eXc67Jo2O9C6Vuc/edit' } });
  assert.equal(cd.status, 201, cd.text);
  const page = await api('GET', `/api/widgets/${cd.body.id}/render`, null, null);
  assert.equal(page.headers.get('content-security-policy'), require('../lib/cloud-docs').RENDER_CSP, 'the cloud-doc page keeps its no-script CSP');
  assert.equal(page.headers.get('cross-origin-resource-policy'), null, 'the BI CORP change does not reach the cloud-doc page');
  assert.ok(!page.text.includes('/bi-token') && !page.text.includes('powerbi'));
  const bi = await api('GET', `/api/widgets/${W.grafana}/render`, null, null);
  assert.match(bi.headers.get('content-security-policy'), /sandbox allow-scripts/);
  assert.equal((await api('GET', `/api/widgets/${cd.body.id}/bi-token`, null, null)).status, 404, 'a cloud-doc is not a dashboard');
  assert.equal((await api('GET', `/api/widgets/${cd.body.id}/bi-image.png`, null, null)).status, 404);
});

test('removing a connection that dashboards use asks first', async () => {
  let r = await api('DELETE', `/api/bi-connections/${C.tab}`);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'BI_CONNECTION_IN_USE');
  assert.equal((await api('DELETE', `/api/bi-connections/${C.tab}?force=1`, null, EDITOR)).status, 403);
  r = await api('DELETE', `/api/bi-connections/${C.tab}?force=1`);
  assert.equal(r.status, 200);
  const page = await api('GET', `/api/widgets/${W.tab}/render`, null, null);
  assert.match(page.text, /connection has been removed/);
});
