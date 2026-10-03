'use strict';

/*
 * Templates library — adversarial API / multi-tenancy / SSRF tests against a REAL server process.
 *
 * Spawns `node server.js` on port 3103 (TEMPLATES_SEC_PORT overrides) with a throwaway DATA_DIR,
 * TEST catalog keys only (TEMPLATE_CATALOG_PUBLIC_KEY), and drives it over HTTP with:
 *   platform_admin, org owner (org A), org admin (org A), workspace editor + viewer (ws A),
 *   platform_operator (support-session role), a user in ANOTHER org (org B / ws B),
 *   a user with no workspace, and an API bearer token `st_...` (org A).
 *
 * Every assertion states the SAFE behaviour. A failure labelled "BUG:" is a finding; see
 * research/security/api-authz.md for the write-up. Seeding that the API cannot do (roles,
 * memberships, content rows, data-source caches) goes straight into the server's sqlite file.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const pkg = require('../lib/templates/package');
const signing = require('../lib/templates/signing');
const { freePort } = require('./helpers/free-port');

const PORT = Number(process.env.TEMPLATES_SEC_PORT || 3103);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'st-tpl-sec-'));
const DATA_DIR = path.join(TMP, 'data');
const CONTENT_DIR = path.join(DATA_DIR, 'uploads', 'content');
const PHRASE = 'I understand unsigned templates run unreviewed code on my screens';

// TEST keys only. Nothing here reads ~/.config/screentinker.
const official = crypto.generateKeyPairSync('ed25519');
const OFFICIAL_PEM = official.publicKey.export({ type: 'spki', format: 'pem' });

let proc = null;
let sqlite = null;           // better-sqlite3 handle on the server's db (seeding + audit reads)
const U = {};                // role -> { token, id, ws }
let apiToken = null;         // st_... for org A
let wsA, wsB, wsAdmin;
const shas = {};             // template key -> sha256
const W = {};                // widget ids

/* ------------------------------------------------------------------ helpers */

const PNG_HEAD = Buffer.from('89504e470d0a1a0a', 'hex');
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6300010000050001' + '0d0a2db40000000049454e44ae426082', 'hex');

async function api(who, method, p, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  const token = typeof who === 'string' ? who : (who && who.token);
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (Buffer.isBuffer(body)) { payload = body; headers['Content-Type'] = headers['Content-Type'] || 'application/octet-stream'; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  const r = await fetch(BASE + p, { method, headers, body: payload });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, text, json, headers: r.headers };
}

function rssKb() {
  try {
    const s = fs.readFileSync(`/proc/${proc.pid}/status`, 'utf8');
    return Number((/VmRSS:\s+(\d+)/.exec(s) || [])[1] || 0);
  } catch { return 0; }
}

function slidePackage(id, extraManifest = {}) {
  const manifest = {
    id, name: `Slide ${id}`, version: '1.0.0', kind: 'slide', license: 'MIT', thumbnail: 'thumbnail.png',
    params: [
      { name: 'headline', type: 'text', label: 'Headline', default: 'Welcome' },
      { name: 'logo', type: 'image', label: 'Logo', default: 'tpl:logo.png' },
      { name: 'feed', type: 'data_source', label: 'Feed' },
    ],
    ...extraManifest,
  };
  const doc = {
    template: {
      background: '#101418',
      elements: [
        { slot: 'headline', kind: 'head', box: { x: 5, y: 10, w: 90 } },
        { slot: 'dsline', kind: 'head', box: { x: 5, y: 40, w: 90 } },
        { slot: 'logo', kind: 'image', box: { x: 80, y: 70, w: 15, h: 20 }, content_id: '{{param:logo}}' },
      ],
    },
    fields: { headline: '{{param:headline}}', dsline: '{{ds:{{param:feed}}.secret}}' },
  };
  return pkg.buildPackageBytes(manifest, { 'template.json': Buffer.from(JSON.stringify(doc)), 'thumbnail.png': PNG, 'logo.png': PNG });
}

function htmlPackage(id, files = {}, extraManifest = {}) {
  const manifest = {
    id, name: `Html ${id}`, version: '1.0.0', kind: 'html', license: 'MIT',
    params: [
      { name: 'title', type: 'text', label: 'Title', default: 'Hi' },
      { name: 'photo', type: 'image', label: 'Photo' },
      { name: 'feed', type: 'data_source', label: 'Feed' },
    ],
    ...extraManifest,
  };
  return pkg.buildPackageBytes(manifest, {
    'index.html': Buffer.from('<!doctype html><html><body><h1>AUTHOR-CODE-MARKER</h1><script>void 0</script></body></html>'),
    ...files,
  });
}

const signedEnv = (bytes) => pkg.buildEnvelope(bytes, signing.signPackage(bytes, official.privateKey));
const unsignedEnv = (bytes) => pkg.buildEnvelope(bytes, null);

async function zip(entries) {
  const archiver = require('archiver');
  const a = archiver('zip');
  const chunks = [];
  a.on('data', (c) => chunks.push(c));
  const done = new Promise((r) => a.on('end', r));
  for (const [n, b] of Object.entries(entries)) a.append(b, { name: n });
  a.finalize();
  await done;
  return Buffer.concat(chunks);
}

/** Pull the st-values JSON payload out of an html-template document. */
function stValues(html) {
  const m = /<script id="st-values" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  return m ? JSON.parse(m[1]) : null;
}

/* ------------------------------------------------------------------ boot + seed */

before(async () => {
  // Refuse to reuse a port somebody else holds.
  await new Promise((resolve, reject) => {
    const s = http.createServer(); s.once('error', () => reject(new Error(`port ${PORT} is busy`)));
    s.listen(PORT, '127.0.0.1', () => s.close(resolve));
  });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const logFd = fs.openSync(path.join(TMP, 'server.log'), 'w');
  const env = { ...process.env };
  delete env.TEMPLATE_CATALOG_ALLOW_PRIVATE;      // the SSRF guard must be ON
  delete env.DISABLE_REGISTRATION;
  delete env.SUPPORT_SIGNING_KEY_FILE;
  Object.assign(env, {
    DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'test',
    JWT_SECRET: 'tpl-sec-' + crypto.randomBytes(8).toString('hex'),
    TEMPLATE_CATALOG_PUBLIC_KEY: OFFICIAL_PEM,
    TEMPLATE_CATALOG_URL: 'https://catalog.invalid/templates/',
  });
  proc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot; see ' + path.join(TMP, 'server.log'));

  let regN = 0;
  const reg = async (email, createOrg) => {
    // /api/auth/register is limited to 5/min per IP; loopback is a trusted proxy, so spread the seeding.
    const r = await api(null, 'POST', '/api/auth/register', { email, password: 'Passw0rd123!', createOrg }, { 'X-Forwarded-For': `192.0.2.${++regN}` });
    assert.equal(r.status, 201, `register ${email}: ${r.text}`);
    return { token: r.json.token, id: r.json.user.id, ws: r.json.current_workspace_id || null };
  };
  U.admin = await reg('admin@sec.local', true);            // first user -> platform_admin
  U.ownerA = await reg('owner-a@sec.local', true);          // org A owner, ws A
  U.otherB = await reg('other-b@sec.local', true);          // org B owner, ws B
  U.orgAdminA = await reg('orgadmin-a@sec.local', false);
  U.editor = await reg('editor@sec.local', false);
  U.viewer = await reg('viewer@sec.local', false);
  U.operator = await reg('operator@sec.local', false);
  U.nows = await reg('nows@sec.local', false);
  wsA = U.ownerA.ws; wsB = U.otherB.ws; wsAdmin = U.admin.ws;
  assert.ok(wsA && wsB && wsAdmin && wsA !== wsB);

  const Database = require('better-sqlite3');
  sqlite = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  sqlite.pragma('busy_timeout = 5000');
  const orgA = sqlite.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(wsA).organization_id;
  sqlite.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_admin')").run(orgA, U.orgAdminA.id);
  sqlite.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')").run(wsA, U.editor.id);
  sqlite.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_viewer')").run(wsA, U.viewer.id);
  sqlite.prepare("UPDATE users SET role = 'platform_operator' WHERE id = ?").run(U.operator.id);
  const role = sqlite.prepare('SELECT role FROM users WHERE id = ?').get(U.admin.id).role;
  assert.equal(role, 'platform_admin');

  // Content: one image in ws A (the secret), one in ws B, each with unique bytes.
  fs.mkdirSync(CONTENT_DIR, { recursive: true });
  const insContent = sqlite.prepare("INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size) VALUES (?, ?, ?, ?, ?, 'image/png', ?)");
  const mkImg = (id, owner, ws, marker, size = 0) => {
    const bytes = Buffer.concat([PNG_HEAD, Buffer.from(marker), crypto.randomBytes(size)]);
    const file = `${id}.png`;
    fs.writeFileSync(path.join(CONTENT_DIR, file), bytes);
    insContent.run(id, owner, ws, file, file, bytes.length);
    return { id, file, b64: bytes.toString('base64') };
  };
  U.imgA = mkImg('aaaaaaaa-secret-image-tenant-a', U.ownerA.id, wsA, 'TENANT-A-IMAGE');
  U.imgB = mkImg('bbbbbbbb-image-tenant-b', U.otherB.id, wsB, 'TENANT-B-IMAGE');
  U.bigImgB = mkImg('bbbbbbbb-big-image-tenant-b', U.otherB.id, wsB, 'BIG', 1900 * 1024);
  // Data sources: ws A holds a secret; ws B has its own harmless one.
  const insDs = sqlite.prepare("INSERT INTO data_sources (id, workspace_id, slug, name, type, config, cached_data) VALUES (?, ?, ?, ?, 'json_api', '{}', ?)");
  insDs.run(crypto.randomUUID(), wsA, 'secrets', 'A secrets', JSON.stringify({ secret: 'TENANT-A-DATA-SECRET' }));
  insDs.run(crypto.randomUUID(), wsB, 'mine', 'B data', JSON.stringify({ secret: 'b-public' }));

  // An API token for org A (st_...).
  const t = await api(U.ownerA, 'POST', '/api/tokens', { name: 'sec-test', scope: 'full' });
  assert.ok(t.status === 200 || t.status === 201, 'mint st_ token: ' + t.text);
  apiToken = t.json.token || t.json.plaintext || t.json.key;
  assert.ok(typeof apiToken === 'string' && apiToken.startsWith('st_'), 'st_ token minted: ' + t.text);

  // Install the fixtures (as platform admin): a signed slide, two unsigned html (needs the switch).
  let r = await api(U.admin, 'PUT', '/api/templates/settings', { unsigned_code_allowed: true, confirm: PHRASE });
  assert.equal(r.status, 200, r.text);
  const install = async (envBytes, expectKey) => {
    const res = await api(U.admin, 'POST', '/api/templates/import', envBytes);
    assert.equal(res.status, 201, `import ${expectKey}: ${res.text}`);
    assert.equal(res.json.key, expectKey);
    shas[expectKey] = res.json.sha256;
    return res.json;
  };
  await install(signedEnv(slidePackage('slide-probe')), 'official/slide-probe');
  await install(signedEnv(slidePackage('slide-other')), 'official/slide-other');
  await install(unsignedEnv(htmlPackage('html-probe')), 'local/html-probe');
  const big = crypto.randomBytes(700 * 1024).toString('base64').slice(0, 900 * 1024);   // ~900 KB of JS text
  await install(unsignedEnv(htmlPackage('html-big', {
    'index.html': Buffer.from('<!doctype html><html><body><script src="a.js"></script><script src="b.js"></script></body></html>'),
    'a.js': Buffer.from(`var a="${big}";`), 'b.js': Buffer.from(`var b="${big}";`),
  })), 'local/html-big');
}, { timeout: 120000 });

after(() => {
  try { if (proc) proc.kill('SIGKILL'); } catch { /* */ }
  try { if (sqlite) sqlite.close(); } catch { /* */ }
  if (!process.env.KEEP_TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } }
});

/* ================================================================== 1. admin surface */

const ADMIN_ENDPOINTS = [
  ['GET', '/api/templates/settings'],
  ['PUT', '/api/templates/settings', { network_enabled: true }],
  ['PUT', '/api/templates/settings', { unsigned_code_allowed: true, confirm: PHRASE }],
  ['GET', '/api/templates/catalogs'],
  ['POST', '/api/templates/catalogs', { id: 'evil', label: 'Evil', url: 'https://evil.example/', public_key: 'x' }],
  ['PATCH', '/api/templates/catalogs/official', { enabled: false }],
  ['DELETE', '/api/templates/catalogs/official'],
  ['POST', '/api/templates/catalogs/official/refresh'],
  ['POST', '/api/templates/install', { catalog: 'official', id: 'slide-probe' }],
  ['POST', '/api/templates/import', 'RAW'],
  ['POST', '/api/templates/import?kind=bundle', 'RAW'],
  ['DELETE', '/api/templates/installed/official/slide-probe'],
];

test('every admin endpoint is 403 for everyone except platform_admin (incl. platform_operator, org owner/admin)', async () => {
  const raw = signedEnv(slidePackage('should-not-install'));
  for (const who of ['ownerA', 'orgAdminA', 'editor', 'viewer', 'operator', 'otherB', 'nows']) {
    for (const [m, p, b] of ADMIN_ENDPOINTS) {
      const r = await api(U[who], m, p, b === 'RAW' ? raw : b, who === 'operator' || who === 'orgAdminA' ? { 'X-Workspace-Id': wsA } : {});
      assert.equal(r.status, 403, `BUG: ${who} ${m} ${p} -> ${r.status} ${r.text.slice(0, 120)}`);
    }
  }
  // Nothing changed underneath.
  const s = await api(U.admin, 'GET', '/api/templates/settings');
  assert.equal(s.status, 200);
  assert.equal(s.json.network_enabled, false, 'a refused PUT must not have switched the network on');
  const inst = await api(U.admin, 'GET', '/api/templates/installed');
  assert.ok(!inst.json.templates.some((t) => t.id === 'should-not-install'));
  assert.ok(sqlite.prepare("SELECT 1 FROM template_catalogs WHERE id = 'official' AND enabled = 1").get(), 'official still enabled');
});

test('unauthenticated and API bearer tokens (st_) cannot reach the JWT-only /api/templates', async () => {
  for (const [m, p, b] of [['GET', '/api/templates/library'], ['GET', '/api/templates/installed'],
    ['POST', '/api/templates/installed/official/slide-probe/use', { values: {} }],
    ['POST', '/api/templates/installed/official/slide-probe/preview', { values: {} }],
    ['GET', '/api/templates/settings'], ['POST', '/api/templates/import', 'RAW']]) {
    const body = b === 'RAW' ? signedEnv(slidePackage('x-token')) : b;
    assert.equal((await api(null, m, p, body)).status, 401, `no token ${m} ${p}`);
    assert.equal((await api(apiToken, m, p, body)).status, 401, `BUG: st_ token reached ${m} ${p}`);
  }
});

test('cookies and query-string tokens are ignored (no ambient credential -> no CSRF surface)', async () => {
  const r1 = await fetch(BASE + '/api/templates/settings', { headers: { Cookie: `token=${U.admin.token}; jwt=${U.admin.token}` } });
  assert.equal(r1.status, 401, 'cookie must not authenticate');
  const r2 = await fetch(BASE + `/api/templates/settings?token=${U.admin.token}&access_token=${U.admin.token}`);
  assert.equal(r2.status, 401, 'query token must not authenticate');
  // A cross-site form post (text/plain, no Authorization) cannot reach the import or settings.
  const r3 = await fetch(BASE + '/api/templates/settings', { method: 'PUT', headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example' }, body: 'x' });
  assert.equal(r3.status, 401);
});

/* ================================================================== 2. use / tenancy */

test('use: viewer 403, no-workspace user 403, editor 201 in own workspace only', async () => {
  const v = await api(U.viewer, 'POST', '/api/templates/installed/official/slide-probe/use', { values: {} });
  assert.equal(v.status, 403, 'BUG: viewer created a template widget');
  const n = await api(U.nows, 'POST', '/api/templates/installed/official/slide-probe/use', { values: {} });
  assert.equal(n.status, 403, 'user without a workspace');
  const e = await api(U.editor, 'POST', '/api/templates/installed/official/slide-probe/use', { name: 'A slide', values: { logo: U.imgA.id, feed: 'secrets' } });
  assert.equal(e.status, 201, e.text);
  assert.equal(e.json.workspace_id, wsA);
  W.slideA = e.json.id;
  const h = await api(U.editor, 'POST', '/api/templates/installed/local/html-probe/use', { name: 'A html', values: { photo: U.imgA.id, feed: 'secrets' } });
  assert.equal(h.status, 201, h.text);
  W.htmlA = h.json.id;
  // Org B user asks for ws A via header: tenancy must drop it and fall back to ws B.
  const x = await api(U.otherB, 'POST', '/api/templates/installed/official/slide-probe/use', { values: {} }, { 'X-Workspace-Id': wsA });
  assert.equal(x.status, 201);
  assert.equal(x.json.workspace_id, wsB, 'BUG: cross-org X-Workspace-Id created a widget in ws A');
  W.slideB = x.json.id;
});

test("use / preview refuse another workspace's image id and data-source slug", async () => {
  for (const values of [{ logo: U.imgA.id }, { feed: 'secrets' }]) {
    const r = await api(U.otherB, 'POST', '/api/templates/installed/official/slide-probe/use', { values });
    assert.equal(r.status, 400, `BUG: ws B used ${JSON.stringify(values)} from ws A -> ${r.status}`);
    const p = await api(U.otherB, 'POST', '/api/templates/installed/official/slide-probe/preview', { values });
    assert.equal(p.status, 400, `BUG: ws B previewed with ${JSON.stringify(values)} -> ${p.status}`);
  }
  for (const values of [{ photo: U.imgA.id }, { feed: 'secrets' }]) {
    const r = await api(U.otherB, 'POST', '/api/templates/installed/local/html-probe/use', { values });
    assert.equal(r.status, 400, `BUG: html use accepted ${JSON.stringify(values)}`);
    const p = await api(U.otherB, 'POST', '/api/templates/installed/local/html-probe/preview', { values });
    assert.equal(p.status, 400, `BUG: html preview accepted ${JSON.stringify(values)}`);
  }
  // An id shaped to escape the regex / the dir.
  const t = await api(U.otherB, 'POST', '/api/templates/installed/local/html-probe/use', { values: { photo: '../../db/remote_display.db' } });
  assert.equal(t.status, 400);
  const tpl = await api(U.otherB, 'POST', '/api/templates/installed/local/html-probe/use', { values: { photo: 'tpl:index.html' } });
  assert.equal(tpl.status, 400, 'tpl: reference to a non-image package file');
});

test('positive control: ws A widgets DO render ws A image + data (so the leak checks below can see a leak)', async () => {
  const s = await api(null, 'GET', `/api/widgets/${W.slideA}/render`);
  assert.equal(s.status, 200);
  assert.ok(s.text.includes(`/uploads/content/${U.imgA.file}`), 'slide shows its own image');
  assert.ok(s.text.includes('TENANT-A-DATA-SECRET'), 'slide shows its own data');
  const h = await api(null, 'GET', `/api/widgets/${W.htmlA}/render`);
  const v = stValues(h.text);
  assert.ok(v && v.values.photo && v.values.photo.includes(U.imgA.b64), 'html inlines its own image');
  assert.equal(v.data.feed.secret, 'TENANT-A-DATA-SECRET');
  assert.match(h.headers.get('content-security-policy') || '', /^sandbox allow-scripts/);
  assert.equal(h.headers.get('x-frame-options'), null);
  assert.equal(h.headers.get('x-content-type-options'), 'nosniff');
});

/* ================================================================== 3. widget tampering */

test('PUT /api/widgets/:id cannot repoint the template, inject keys, or store bad types', async () => {
  const r = await api(U.editor, 'PUT', `/api/widgets/${W.slideA}`, {
    config: { template: 'local/html-probe', values: { headline: 'ok' }, ds_refs: [{ slug: 'x' }], evil: '<script>', __proto__: { polluted: 1 } },
  });
  assert.equal(r.status, 200, r.text);
  const cfg = JSON.parse(r.json.config);
  assert.equal(cfg.template, 'official/slide-probe', 'BUG: PUT repointed config.template');
  assert.equal(cfg.evil, undefined, 'BUG: extra config key stored');
  assert.deepEqual(Object.keys(cfg).sort(), ['ds_refs', 'template', 'values']);
  for (const bad of [{ headline: { a: 1 } }, { headline: ['x'] }, { headline: 'x'.repeat(5000) }, { logo: 'http://169.254.169.254/' }, { logo: U.imgB.id }, { feed: 'mine' }]) {
    const b = await api(U.editor, 'PUT', `/api/widgets/${W.slideA}`, { config: { values: bad } });
    assert.equal(b.status, 400, `BUG: PUT accepted ${JSON.stringify(bad).slice(0, 60)}`);
  }
  // Cross-org / viewer writes.
  assert.equal((await api(U.otherB, 'PUT', `/api/widgets/${W.slideA}`, { config: { values: {} } })).status, 403);
  assert.equal((await api(U.viewer, 'PUT', `/api/widgets/${W.slideA}`, { config: { values: {} } })).status, 403);
  // Restore A's widget values for later tests.
  const back = await api(U.editor, 'PUT', `/api/widgets/${W.slideA}`, { config: { values: { logo: U.imgA.id, feed: 'secrets' } } });
  assert.equal(back.status, 200, back.text);
});

test('POST /api/widgets refuses widget_type "template" (JWT and st_ token)', async () => {
  const body = { widget_type: 'template', name: 'x', config: { template: 'local/html-probe', values: { photo: U.imgA.id } } };
  assert.equal((await api(U.editor, 'POST', '/api/widgets', body)).status, 400);
  const t = await api(apiToken, 'POST', '/api/widgets', body);
  assert.ok(t.status === 400 || t.status === 403, `st_ token: ${t.status}`);
});

test('workspace import (/api/status/import) is refused for a workspace_viewer', async () => {
  const exp = {
    format: 'screentinker-export-v2',
    widgets: [{ id: 'old1', widget_type: 'template', name: 'viewer-import', config: { template: 'official/slide-probe', values: {} } }],
    // Also probes the branding write the import performs (white-label.js restricts these two
    // fields to platform admins: custom_css is injected into the login page's <style>).
    white_label: { brand_name: 'pwned', custom_css: 'body{display:none}', custom_domain: 'login.victim.example' },
  };
  const r = await api(U.viewer, 'POST', '/api/status/import', exp);
  const made = sqlite.prepare("SELECT COUNT(*) AS n FROM widgets WHERE name = 'viewer-import'").get().n;
  assert.ok(r.status === 403 && made === 0, `BUG: a read-only viewer imported ${made} widget(s) into ws A (status ${r.status})`);
});

test('workspace import cannot set platform-admin-only branding (custom_css / custom_domain)', async () => {
  const wl = sqlite.prepare('SELECT custom_css, custom_domain FROM white_labels WHERE workspace_id = ?').get(wsA);
  assert.ok(!wl || (!wl.custom_css && !wl.custom_domain),
    `BUG (high, pre-existing): a workspace_viewer set custom_css=${JSON.stringify(wl && wl.custom_css)} custom_domain=${JSON.stringify(wl && wl.custom_domain)} via /api/status/import (POST /api/white-label refuses both for non-platform-admins)`);
});

test('unvalidated roads (workspace import) cannot make a ws B widget render ws A image/data', async () => {
  const exp = {
    format: 'screentinker-export-v2',
    widgets: [
      { id: 'o1', widget_type: 'template', name: 'evil-slide', config: { template: 'official/slide-probe', values: { logo: U.imgA.id, feed: 'secrets', headline: { toString: 1 } }, extra: 'x' } },
      { id: 'o2', widget_type: 'template', name: 'evil-html', config: { template: 'local/html-probe', values: { photo: U.imgA.id, feed: 'secrets', title: '</script><script>alert(1)</script>' } } },
      { id: 'o3', widget_type: 'template', name: 'evil-missing', config: { template: '../../etc/passwd', values: {} } },
    ],
  };
  const r = await api(U.otherB, 'POST', '/api/status/import', exp);
  assert.ok(r.status === 200 || r.status === 201, 'import (a road that skips template validation): ' + r.text);
  const row = (n) => sqlite.prepare('SELECT id, workspace_id FROM widgets WHERE name = ?').get(n);
  const s = row('evil-slide'); const h = row('evil-html'); const m = row('evil-missing');
  assert.equal(s.workspace_id, wsB);

  const sr = await api(null, 'GET', `/api/widgets/${s.id}/render`);
  assert.equal(sr.status, 200);
  assert.ok(!sr.text.includes(U.imgA.file) && !sr.text.includes(U.imgA.b64), 'BUG: ws B slide rendered ws A image');
  assert.ok(!sr.text.includes('TENANT-A-DATA-SECRET'), 'BUG: ws B slide rendered ws A data');

  const hr = await api(null, 'GET', `/api/widgets/${h.id}/render`);
  assert.ok(!hr.text.includes(U.imgA.b64), 'BUG: ws B html template inlined ws A image');
  assert.ok(!hr.text.includes('TENANT-A-DATA-SECRET'), 'BUG: ws B html template got ws A data');
  const v = stValues(hr.text);
  assert.equal(v.values.photo, null);
  // The import now rebuilds template configs: a slug this workspace does not own is dropped
  // entirely, so there is no feed at all (stricter than an empty one).
  assert.ok(v.data.feed === undefined || Object.keys(v.data.feed).length === 0);
  assert.ok(!/<\/script><script>alert/.test(hr.text.split('<script id="st-values"')[1].split('</script>')[0]), 'values JSON is script-safe');

  const mr = await api(null, 'GET', `/api/widgets/${m.id}/render`);
  assert.equal(mr.status, 200);
  assert.ok(!mr.text.includes('AUTHOR-CODE-MARKER') && mr.text.includes('background:#000'), 'unknown template -> black page');
  W.evilHtmlB = h.id;
});

/* ================================================================== 4. installed / uninstall info */

test('used_by and the 409 widget list are platform-admin only', async () => {
  const e = await api(U.editor, 'GET', '/api/templates/installed/official/slide-probe');
  assert.equal(e.status, 200);
  assert.equal(e.json.used_by, undefined, 'BUG: non-admin sees used_by (cross-tenant widget names)');
  const o = await api(U.otherB, 'GET', '/api/templates/installed/official/slide-probe');
  assert.equal(o.json.used_by, undefined);
  const a = await api(U.admin, 'GET', '/api/templates/installed/official/slide-probe');
  assert.ok(Array.isArray(a.json.used_by) && a.json.used_by.length >= 2);
  const d = await api(U.admin, 'DELETE', '/api/templates/installed/official/slide-probe');
  assert.equal(d.status, 409);
  assert.ok(Array.isArray(d.json.widgets) && d.json.widgets.some((w) => w.workspace_id === wsB));
  // Every workspace member can list what is installed — instance-wide by design; check nothing
  // admin-only rides along.
  const list = await api(U.viewer, 'GET', '/api/templates/installed');
  for (const t of list.json.templates) {
    assert.equal(t.installed_by, undefined);
    assert.equal(t.used_by, undefined);
  }
});

test('library (any member) does not expose catalog internals beyond url/last_error — recorded', async () => {
  const r = await api(U.viewer, 'GET', '/api/templates/library');
  assert.equal(r.status, 200);
  for (const c of r.json.catalogs) {
    assert.equal(c.public_key, undefined, 'no raw key');
    assert.equal(c.index_json, undefined, 'no raw index');
  }
});

/* ================================================================== 5. thumbnails */

test('thumb: only the manifest thumbnail, image types, integrity-checked packages', async () => {
  const ok = await api(null, 'GET', `/api/templates/thumb/${shas['official/slide-probe']}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(ok.headers.get('content-security-policy'), 'sandbox');
  // html template without a thumbnail, bad shapes, traversal.
  for (const p of [`/api/templates/thumb/${shas['local/html-probe']}`, '/api/templates/thumb/..%2f..%2fdb%2fremote_display.db',
    `/api/templates/thumb/${shas['official/slide-probe'].toUpperCase()}`, `/api/templates/thumb/${shas['official/slide-probe']}.sttemplate`,
    '/api/templates/thumb/' + '0'.repeat(64)]) {
    const r = await api(null, 'GET', p);
    assert.equal(r.status, 404, `thumb ${p} -> ${r.status}`);
  }
  // Tamper with a package on disk BEFORE anything loads it: thumb + use must refuse it.
  const imp = await api(U.admin, 'POST', '/api/templates/import', signedEnv(slidePackage('tamper-probe')));
  assert.equal(imp.status, 201);
  const file = path.join(DATA_DIR, 'templates', 'packages', `${imp.json.sha256}.sttemplate`);
  fs.writeFileSync(file, signedEnv(slidePackage('tamper-probe', { description: 'swapped' })));
  const t = await api(null, 'GET', `/api/templates/thumb/${imp.json.sha256}`);
  assert.equal(t.status, 404, 'BUG: thumb served from a package that fails its integrity check');
  const u = await api(U.editor, 'POST', '/api/templates/installed/official/tamper-probe/use', { values: {} });
  assert.equal(u.status, 409, 'use of a tampered package');
  const d = await api(U.admin, 'DELETE', '/api/templates/installed/official/tamper-probe');
  assert.equal(d.status, 200);
});

/* ================================================================== 6. previews */

test('preview tokens: 192-bit, public but sandboxed, unknown -> 410', async () => {
  const p = await api(U.editor, 'POST', '/api/templates/installed/local/html-probe/preview', { values: { title: 'x', photo: U.imgA.id } });
  assert.equal(p.status, 200, p.text);
  const token = p.json.url.split('/').pop();
  assert.ok(/^[A-Za-z0-9_-]{32}$/.test(token), 'token = 24 random bytes base64url');
  const g = await api(null, 'GET', p.json.url);       // no auth, any user: by design
  assert.equal(g.status, 200);
  assert.match(g.headers.get('content-security-policy'), /^sandbox allow-scripts/);
  assert.equal(g.headers.get('cache-control'), 'no-store');
  assert.equal(g.headers.get('x-frame-options'), null);
  const bad = await api(null, 'GET', '/api/templates/preview/' + 'A'.repeat(32));
  assert.equal(bad.status, 410);
  assert.equal(bad.headers.get('content-security-policy'), 'sandbox');
  // Viewer may preview (read-only op) — in their own workspace.
  const v = await api(U.viewer, 'POST', '/api/templates/installed/official/slide-probe/preview', { values: {} });
  assert.equal(v.status, 200);
});

test('public preview/thumb mount is rate limited per IP (not per token)', async () => {
  let limited = 0;
  const reqs = [];
  for (let i = 0; i < 130; i++) reqs.push(fetch(`${BASE}/api/templates/preview/${crypto.randomBytes(24).toString('base64url')}`, { headers: { 'X-Forwarded-For': '203.0.113.77' } }).then((r) => { if (r.status === 429) limited++; }));
  await Promise.all(reqs);
  assert.ok(limited > 0, `BUG (low): 130 requests to distinct preview tokens from one IP -> ${limited} x 429; the limiter keys on the full path, so each token is its own bucket`);
});

/* ================================================================== 7. SSRF */

test('SSRF: bad schemes and credentials are refused when the catalog is added', async () => {
  const add = (id, url) => api(U.admin, 'POST', '/api/templates/catalogs', {
    id, label: id, url, public_key: crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }),
  });
  for (const [id, url] of [['s-file', 'file:///etc/passwd'], ['s-gopher', 'gopher://127.0.0.1:6379/_FLUSHALL'],
    ['s-cred', 'https://user:pass@example.com/'], ['s-data', 'data:text/plain,x'], ['s-ftp', 'ftp://example.com/']]) {
    const r = await add(id, url);
    assert.equal(r.status, 400, `${url} -> ${r.status}`);
  }
});

test('SSRF: refresh never connects to loopback / link-local / private targets, and errors do not leak them', async () => {
  // A listener on loopback that records every hit: the guard must stop the request before it.
  const hits = [];
  const lport = await freePort();
  const sink = http.createServer((req, res) => { hits.push(req.url); res.writeHead(302, { Location: `http://127.0.0.1:${lport}/x` }); res.end(); });
  await new Promise((r) => sink.listen(lport, '127.0.0.1', r));
  try {
    const on = await api(U.admin, 'PUT', '/api/templates/settings', { network_enabled: true });
    assert.equal(on.status, 200);
    const targets = [
      `http://127.0.0.1:${lport}/`, `http://localhost:${lport}/`, `http://[::1]:${lport}/`,
      `http://[::ffff:127.0.0.1]:${lport}/`, `http://2130706433:${lport}/`, `http://0x7f.1:${lport}/`, `http://0.0.0.0:${lport}/`,
      'http://169.254.169.254/latest/meta-data/', 'http://[fd00::1]/', 'http://10.0.0.1/', 'http://192.168.1.1/',
      `http://127.0.0.1.nip.io:${lport}/`,
    ];
    let n = 0;
    for (const url of targets) {
      const id = `ssrf-${n++}`;
      const a = await api(U.admin, 'POST', '/api/templates/catalogs', { id, label: id, url, public_key: crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) });
      if (a.status !== 201) { assert.equal(a.status, 400, `${url} add -> ${a.status}`); continue; }
      const t0 = Date.now();
      const r = await api(U.admin, 'POST', `/api/templates/catalogs/${id}/refresh`);
      assert.ok(r.status >= 400 && r.status < 600 && r.status !== 200, `${url} refresh -> ${r.status}`);
      assert.ok(Date.now() - t0 < 25000);
      const leak = [String(lport), '127.0.0.1', '169.254', '::1', 'localhost', '10.0.0.1', '192.168', 'fd00', 'ECONNREFUSED', 'blocked'];
      for (const s of leak) assert.ok(!r.text.includes(s), `BUG: refresh error for ${url} leaks "${s}": ${r.text}`);
      const row = sqlite.prepare('SELECT last_error FROM template_catalogs WHERE id = ?').get(id);
      for (const s of leak) assert.ok(!String(row.last_error || '').includes(s), `BUG: last_error for ${url} leaks "${s}"`);
      assert.equal((await api(U.admin, 'DELETE', `/api/templates/catalogs/${id}`)).status, 200);
    }
    assert.deepEqual(hits, [], `BUG: SSRF guard let ${hits.length} request(s) reach loopback: ${hits.join(', ')}`);
  } finally {
    sink.close();
    await api(U.admin, 'PUT', '/api/templates/settings', { network_enabled: false });
  }
});

/* ================================================================== 8. import edge cases */

test('import: kind confusion is a clean 4xx, never an install', async () => {
  const before = sqlite.prepare('SELECT COUNT(*) AS n FROM templates_installed').get().n;
  // Author template zip sent as a bundle.
  const tz = await zip({ 'manifest.json': Buffer.from(JSON.stringify({ id: 'zip-probe', name: 'Z', version: '1.0.0', kind: 'slide', license: 'MIT', params: [] })), 'template.json': Buffer.from('{"template":{},"fields":{}}') });
  const a = await api(U.admin, 'POST', '/api/templates/import?kind=bundle', tz);
  assert.ok(a.status >= 400 && a.status < 500, `template zip as bundle -> ${a.status} ${a.text}`);
  // A bundle (index + sig) sent as a template.
  const idx = Buffer.from(JSON.stringify({ schema: 1, catalog: 'official', serial: 5, expires: new Date(Date.now() + 864e5).toISOString(), templates: [] }));
  const bz = await zip({ 'index.json': idx, 'index.json.sig': signing.formatIndexSignature(signing.signIndex(idx, official.privateKey)) });
  const b = await api(U.admin, 'POST', '/api/templates/import', bz);
  assert.ok(b.status >= 400 && b.status < 500, `bundle as template -> ${b.status} ${b.text}`);
  // Garbage.
  const g = await api(U.admin, 'POST', '/api/templates/import', Buffer.from('not a template'));
  assert.ok(g.status >= 400 && g.status < 500, `garbage -> ${g.status}`);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM templates_installed').get().n, before);
});

test('import: a .sttemplate sent as application/json still imports (global express.json must not eat it)', async () => {
  const env = signedEnv(slidePackage('json-ct-probe'));
  const r = await api(U.admin, 'POST', '/api/templates/import', env, { 'Content-Type': 'application/json' });
  assert.equal(r.status, 201, `BUG (low, functional): Content-Type application/json -> ${r.status} ${r.text}`);
});

test('import: an oversize non-bundle upload is refused before it is buffered', async () => {
  const before = rssKb();
  const big = Buffer.alloc(120 * 1024 * 1024, 0x41);
  const r = await api(U.admin, 'POST', '/api/templates/import', big);
  const after = rssKb();
  console.log(`[import-120MB] status=${r.status} rss ${Math.round(before / 1024)}MB -> ${Math.round(after / 1024)}MB`);
  assert.equal(r.status, 413);
  assert.ok(after - before < 60 * 1024, `BUG (low, admin-only): a 120 MB non-bundle body was buffered in full before the 8 MB check (+${Math.round((after - before) / 1024)} MB RSS); express.raw limit is 300mb for every kind`);
});

/* ================================================================== 9. the unsigned-code switch */

test('unsigned_code_allowed: phrase required to enable; disabling blanks + re-revs affected widgets', async () => {
  for (const b of [{ unsigned_code_allowed: true }, { unsigned_code_allowed: true, confirm: 'yes' }, { unsigned_code_allowed: true, confirm: PHRASE.toUpperCase() }]) {
    const r = await api(U.admin, 'PUT', '/api/templates/settings', b);
    assert.equal(r.status, 400, JSON.stringify(b));
  }
  const rev0 = sqlite.prepare('SELECT updated_at FROM widgets WHERE id = ?').get(W.htmlA).updated_at;
  const before = await api(null, 'GET', `/api/widgets/${W.htmlA}/render`);
  assert.ok(before.text.includes('AUTHOR-CODE-MARKER'));
  const off = await api(U.admin, 'PUT', '/api/templates/settings', { unsigned_code_allowed: false });
  assert.equal(off.status, 200);
  assert.equal(off.json.unsigned_code_allowed, false);
  const rev1 = sqlite.prepare('SELECT updated_at FROM widgets WHERE id = ?').get(W.htmlA).updated_at;
  assert.ok(rev1 > rev0, 'widget rev bumped so players re-fetch');
  for (const id of [W.htmlA, W.evilHtmlB]) {
    const r = await api(null, 'GET', `/api/widgets/${id}/render`);
    assert.ok(!r.text.includes('AUTHOR-CODE-MARKER'), `BUG: unsigned html template ${id} still renders author code with the switch off`);
    // Even a pinned (?rev=old) URL must not serve the cached code from this server.
    const pinned = await api(null, 'GET', `/api/widgets/${id}/render?rev=${rev0}`);
    assert.ok(!pinned.text.includes('AUTHOR-CODE-MARKER'));
  }
  const u = await api(U.editor, 'POST', '/api/templates/installed/local/html-probe/use', { values: {} });
  assert.equal(u.status, 409);
  const p = await api(U.editor, 'POST', '/api/templates/installed/local/html-probe/preview', { values: {} });
  assert.equal(p.status, 409);
  const imp = await api(U.admin, 'POST', '/api/templates/import', unsignedEnv(htmlPackage('html-late')));
  assert.equal(imp.status, 403, 'unsigned html import refused while off');
});

/* ================================================================== 10. audit */

test('admin actions are audited, without package bytes, and not into a tenant workspace', async () => {
  // Act as platform admin *inside ws A* (acting-as) and change a setting.
  const r = await api(U.admin, 'PUT', '/api/templates/settings', { network_enabled: false }, { 'X-Workspace-Id': wsA });
  assert.equal(r.status, 200);
  const rows = sqlite.prepare("SELECT action, details, workspace_id FROM activity_log WHERE action LIKE 'templates.%' ORDER BY id").all();
  const actions = new Set(rows.map((x) => x.action));
  for (const a of ['templates.settings', 'templates.imported', 'templates.uninstalled', 'templates.catalog_removed']) {
    assert.ok(actions.has(a), `audit missing ${a}`);
  }
  for (const x of rows) assert.ok(String(x.details || '').length < 2000, `audit row ${x.action} is ${String(x.details).length} bytes`);
  const leaked = rows.filter((x) => x.workspace_id === wsA);
  assert.equal(leaked.length, 0, `BUG (low): ${leaked.length} instance-level template audit row(s) attributed to tenant ws A (${[...new Set(leaked.map((x) => x.action))].join(', ')})`);
});

test('catalog refresh (an admin-triggered outbound fetch) is audited', async () => {
  const rows = sqlite.prepare("SELECT action FROM activity_log WHERE action LIKE 'templates.%'").all();
  assert.ok(rows.some((x) => /refresh/.test(x.action)), 'BUG (low): POST /catalogs/:cid/refresh ran 12 times in this suite and left no audit row');
});

/* ================================================================== 11. preview flood (last: it leaves ~1 GB in the server heap) */

test('preview store: bounded memory, and one tenant cannot evict another tenant\'s previews', async () => {
  // The flood uses an unsigned html template; the switch test above turned unsigned code off.
  const sw = await api(U.admin, 'PUT', '/api/templates/settings', { unsigned_code_allowed: true, confirm: PHRASE });
  assert.equal(sw.status, 200);
  const mine = await api(U.editor, 'POST', '/api/templates/installed/official/slide-probe/preview', { values: {} });
  assert.equal(mine.status, 200);
  const before = rssKb();
  let made = 0; let bytes = 0;
  // Org B floods previews of the largest document it can build: ~1.8 MB of package JS + a 1.9 MB image of its own.
  // ONE client IP. The 120/min limiter keys on the raw path, but Express decodes %-escapes in
  // :params, so every percent-encoding of "html-big" is the same template and a fresh bucket.
  const word = 'html-big';
  const variant = (i) => [...word].map((ch, k) => ((i >> k) & 1 ? '%' + ch.charCodeAt(0).toString(16) : ch)).join('');
  for (let i = 0; i < 210; i++) {
    const r = await api(U.otherB, 'POST', `/api/templates/installed/local/${variant(i)}/preview`, { values: { photo: U.bigImgB.id } }, { 'X-Forwarded-For': '198.18.0.9' });
    if (r.status === 200) {
      made++;
      if (i === 0) bytes = (await api(null, 'GET', r.json.url)).text.length;
    }
  }
  const after = rssKb();
  const grewMb = Math.round((after - before) / 1024);
  const projectedMb = Math.round((bytes * 200) / 1048576);
  console.log(`[preview-flood] made=${made} doc=${(bytes / 1048576).toFixed(2)}MB rss ${Math.round(before / 1024)}MB -> ${Math.round(after / 1024)}MB (+${grewMb}MB), worst-case retained = 200 x doc = ~${projectedMb}MB`);
  // After the fix: the %-encoded spellings share one bucket (120/min), and each user keeps at most
  // PREVIEW_PER_USER tokens holding values only (rendered on GET), so retention is KBs, not MBs.
  assert.ok(made <= 120, `BUG: %-encoded path variants stepped around the limiter (${made} previews)`);
  assert.ok(grewMb < 200, `BUG (medium): the preview flood grew RSS by ${grewMb}MB`);
  void projectedMb;
  const still = await api(null, 'GET', mine.json.url);
  assert.equal(still.status, 200, `BUG (medium): org B's ${made} previews evicted org A's live preview (global FIFO cap of 200)`);
});

/* ================================================================== 12. duplicate */

test('duplicate: an independent copy of a template widget, in the original\'s workspace, with the same values', async () => {
  const src = sqlite.prepare('SELECT * FROM widgets WHERE id = ?').get(W.slideA);
  const d = await api(U.editor, 'POST', `/api/widgets/${W.slideA}/duplicate`, {});
  assert.equal(d.status, 201, d.text);
  assert.notEqual(d.json.id, W.slideA);
  assert.equal(d.json.workspace_id, src.workspace_id);
  assert.equal(d.json.widget_type, 'template');
  assert.equal(d.json.name, `${src.name} (copy)`);
  const copy = sqlite.prepare('SELECT * FROM widgets WHERE id = ?').get(d.json.id);
  assert.deepEqual(JSON.parse(copy.config).values, JSON.parse(src.config).values);
  // Independent: editing the copy leaves the original alone.
  const cfg = JSON.parse(copy.config);
  const e = await api(U.editor, 'PUT', `/api/widgets/${d.json.id}`, { config: { values: { ...cfg.values, headline: 'Only the copy' } } });
  assert.equal(e.status, 200, e.text);
  assert.notEqual(JSON.parse(sqlite.prepare('SELECT config FROM widgets WHERE id = ?').get(W.slideA).config).values.headline, 'Only the copy');
  // A chosen name is used.
  const n = await api(U.editor, 'POST', `/api/widgets/${W.slideA}/duplicate`, { name: 'Menu — screen 3' });
  assert.equal(n.status, 201);
  assert.equal(n.json.name, 'Menu — screen 3');
});

test('duplicate: viewer and another org are refused; the copy never lands in the caller\'s other workspace', async () => {
  const v = await api(U.viewer, 'POST', `/api/widgets/${W.slideA}/duplicate`, {});
  assert.equal(v.status, 403, 'BUG: a viewer duplicated a widget');
  const b = await api(U.otherB, 'POST', `/api/widgets/${W.slideA}/duplicate`, {}, { 'X-Workspace-Id': wsA });
  assert.ok(b.status === 403 || b.status === 404, `BUG: org B duplicated org A's widget (${b.status})`);
  const count = sqlite.prepare('SELECT COUNT(*) n FROM widgets WHERE workspace_id = ?').get(wsB).n;
  const again = await api(U.otherB, 'POST', `/api/widgets/${W.slideA}/duplicate`, {});
  assert.notEqual(again.status, 201);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM widgets WHERE workspace_id = ?').get(wsB).n, count);
});

test('duplicate: copies the LIVE config, never a pending draft (no way around approval)', async () => {
  const live = sqlite.prepare('SELECT config FROM widgets WHERE id = ?').get(W.slideA).config;
  const liveValues = JSON.parse(live).values;
  const draft = { name: 'draft name', config: { ...JSON.parse(live), values: { ...liveValues, headline: 'UNREVIEWED-DRAFT' } } };
  sqlite.prepare('UPDATE widgets SET draft_config = ? WHERE id = ?').run(JSON.stringify(draft), W.slideA);
  try {
    const d = await api(U.editor, 'POST', `/api/widgets/${W.slideA}/duplicate`, {});
    assert.equal(d.status, 201, d.text);
    const copy = sqlite.prepare('SELECT * FROM widgets WHERE id = ?').get(d.json.id);
    assert.ok(!copy.config.includes('UNREVIEWED-DRAFT'), 'BUG: the unreviewed draft went live in the copy');
    assert.equal(copy.draft_config, null);
    assert.deepEqual(JSON.parse(copy.config).values, liveValues);
  } finally {
    sqlite.prepare('UPDATE widgets SET draft_config = NULL WHERE id = ?').run(W.slideA);
  }
});

test('duplicate: a template widget is rebuilt — refused while its template cannot be used', async () => {
  // With unsigned code off, the unsigned html template is unusable: a copy must not resurrect it as a
  // blob. (Switched off here and restored: an earlier test turns it back on for the preview flood.)
  const was = (await api(U.admin, 'GET', '/api/templates/settings')).json.unsigned_code_allowed;
  const off = await api(U.admin, 'PUT', '/api/templates/settings', { unsigned_code_allowed: false });
  assert.equal(off.status, 200);
  try {
    const d = await api(U.editor, 'POST', `/api/widgets/${W.htmlA}/duplicate`, {});
    assert.equal(d.status, 409, `BUG: duplicated a widget of an unusable template (${d.status} ${d.text})`);
  } finally {
    if (was) await api(U.admin, 'PUT', '/api/templates/settings', { unsigned_code_allowed: true, confirm: PHRASE });
  }
});

test('duplicate: a built-in widget copies its settings verbatim', async () => {
  const c = await api(U.editor, 'POST', '/api/widgets', { widget_type: 'clock', name: 'Lobby clock', config: { timezone: 'Europe/London', format: '24h' } });
  assert.equal(c.status, 201, c.text);
  const d = await api(U.editor, 'POST', `/api/widgets/${c.json.id}/duplicate`, {});
  assert.equal(d.status, 201, d.text);
  assert.equal(d.json.widget_type, 'clock');
  assert.deepEqual(JSON.parse(d.json.config), { timezone: 'Europe/London', format: '24h' });
  const missing = await api(U.editor, 'POST', '/api/widgets/00000000-0000-4000-8000-000000000000/duplicate', {});
  assert.equal(missing.status, 404);
});
