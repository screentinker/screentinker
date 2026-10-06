'use strict';

/*
 * The public template gallery (/templates) and its "Interactive web preview" (/api/templates/demo/:sha).
 *
 * Two halves: the pure card/page builders in lib/templates/gallery.js, then a REAL server with a
 * throwaway catalog key, signed packages and a seeded catalog index — because the things that
 * matter here (what a logged-out visitor can reach, which CSP a public render carries, that a
 * workspace's data never lands in a public page) are only true or false of the running server.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const gallery = require('../lib/templates/gallery');
const pkg = require('../lib/templates/package');
const signing = require('../lib/templates/signing');
const { freePort } = require('./helpers/free-port');

const SHA = (c) => c.repeat(64);

/* ================================================================== pure */

const INDEX = {
  catalog: 'official', serial: 7,
  revoked: [{ id: 'gone' }],
  templates: [
    { id: 'menu-board', name: 'Menu board', kind: 'html', tags: ['menu', 'data-source'], orientation: ['landscape', 'portrait'],
      thumbnail: 'thumbs/menu.png', homepage: 'https://github.com/x', versions: [{ version: '1.1.0', sha256: SHA('a'), network: [] }] },
    { id: 'brand-new', name: 'Brand new', kind: 'slide', tags: ['reception'], thumbnail: 'thumbs/new.png',
      versions: [{ version: '1.0.0', sha256: SHA('b'), network: ['api.example.com'] }] },
    { id: 'mystery', name: 'Mystery', kind: 'html', tags: ['whatever'], versions: [{ version: '1.0.0', sha256: SHA('c'), network: [] }] },
    { id: 'gone', name: 'Gone', kind: 'html', tags: [], versions: [{ version: '1.0.0', sha256: SHA('d') }] },
    { id: 'evil', name: '<img src=x onerror=alert(1)>', description: '"><script>alert(1)</script>', kind: 'html', tags: [],
      homepage: 'javascript:alert(1)', versions: [{ version: '1.0.0', sha256: SHA('e'), network: [] }] },
  ],
};

test('cards: one per non-revoked template, placed in filters by id or by tags, unknown -> utilities', () => {
  const list = gallery.cards(INDEX, { catalogUrl: 'https://cat.example/templates/' });
  const by = Object.fromEntries(list.map((c) => [c.id, c]));
  assert.deepEqual(Object.keys(by).sort(), ['brand-new', 'evil', 'menu-board', 'mystery']);
  assert.deepEqual(by['menu-board'].categories, ['retail']);        // hand-placed
  assert.deepEqual(by['brand-new'].categories, ['corporate']);      // by tag
  assert.deepEqual(by.mystery.categories, ['utilities']);           // nothing matched
  assert.equal(by['menu-board'].liveData, true);
  assert.equal(by['menu-board'].offline, true);
  assert.equal(by['brand-new'].offline, false, 'a template that declares hosts is not "no internet needed"');
});

test('cards: a preview and a local thumbnail only for the package installed and active HERE', () => {
  const installed = (k) => ({
    'official/menu-board': { status: 'active', sha256: SHA('a') },
    'official/brand-new': { status: 'active', sha256: SHA('f') },    // an older version than the catalog's
    'official/mystery': { status: 'revoked', sha256: SHA('c') },
  }[k] || null);
  const by = Object.fromEntries(gallery.cards(INDEX, { installed, catalogUrl: 'https://cat.example/templates/' }).map((c) => [c.id, c]));
  assert.equal(by['menu-board'].preview, `/api/templates/demo/${SHA('a')}`);
  assert.equal(by['menu-board'].thumbnail, `/api/templates/thumb/${SHA('a')}`);
  assert.equal(by['brand-new'].preview, null, 'the card describes the catalog version; never preview a different one');
  assert.equal(by['brand-new'].thumbnail, 'https://cat.example/templates/thumbs/new.png');
  assert.equal(by.mystery.preview, null);
});

test('cards: catalog thumbnails only over https, homepages only https', () => {
  const list = gallery.cards(INDEX, { catalogUrl: 'http://cat.example/' });
  assert.ok(list.every((c) => c.thumbnail === null));
  assert.equal(list.find((c) => c.id === 'evil').homepage, null);
});

const SHELL = `<html><body>
<div><!-- templates:filters -->
<!-- /templates:filters --></div>
<section><!-- templates:cards -->
<div class="tg-fallback">FALLBACK</div>
<!-- /templates:cards --></section></body></html>`;

test('renderPage: live cards replace the fallback; every catalog string is escaped', () => {
  const html = gallery.renderPage(SHELL, gallery.cards(INDEX, {}));
  assert.ok(!html.includes('FALLBACK'));
  assert.ok(html.includes('data-filter="retail"') && html.includes('data-filter="all"'));
  assert.ok(!html.includes('<img src=x'), 'a name is text, never markup');
  assert.ok(!html.includes('<script>alert'), 'a description is text, never markup');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('renderPage: no cards (no catalog yet, or library off) -> the committed shell, untouched', () => {
  assert.equal(gallery.renderPage(SHELL, []), SHELL);
  assert.equal(gallery.renderPage('<html>no markers</html>', gallery.cards(INDEX, {})), '<html>no markers</html>');
});

test('the committed page has both marker pairs and a fallback that is not an empty grid', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'templates.html'), 'utf8');
  for (const m of ['<!-- templates:cards -->', '<!-- /templates:cards -->', '<!-- templates:filters -->', '<!-- /templates:filters -->']) {
    assert.ok(page.includes(m), `templates.html lost ${m}`);
  }
  assert.match(page, /class="tg-fallback"/);
  assert.doesNotMatch(page, /<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)/, 'the page CSP is script-src self: no inline script');
});

test('demoValues binds only weather data-source params to the demo slug', () => {
  const v = gallery.demoValues({ params: [
    { name: 'weather', type: 'data_source', label: 'Weather source' },
    { name: 'calendar', type: 'data_source', label: 'Room calendar' },
    { name: 'title', type: 'text' },
  ] });
  assert.deepEqual(v, { weather: gallery.DEMO_WEATHER_SLUG });
  assert.equal(gallery.demoData('anything-else'), null);
  assert.equal(gallery.demoData(gallery.DEMO_WEATHER_SLUG).location, 'Manchester');
});

/* ================================================================== real server */

const TMP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'st-tpl-gallery-'));
const DATA_DIR = path.join(TMP, 'data');
const official = crypto.generateKeyPairSync('ed25519');
const local = crypto.generateKeyPairSync('ed25519');
let BASE, proc, sqlite;
const shas = {};

async function http(method, p, { token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload = body;
  if (body && !Buffer.isBuffer(body)) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  else if (body) h['Content-Type'] = 'application/octet-stream';
  const r = await fetch(BASE + p, { method, headers: h, body: payload, redirect: 'manual' });
  return { status: r.status, text: await r.text(), headers: r.headers };
}

function weatherHtml(id) {
  const manifest = {
    id, name: `Weather ${id}`, version: '1.0.0', kind: 'html', license: 'MIT', thumbnail: 'thumbnail.png',
    params: [
      { name: 'title', type: 'text', label: 'Title', default: 'DEFAULT-TITLE' },
      { name: 'weather', type: 'data_source', label: 'Weather data source' },
    ],
  };
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6300010000050001' + '0d0a2db40000000049454e44ae426082', 'hex');
  return pkg.buildPackageBytes(manifest, {
    'index.html': Buffer.from('<!doctype html><html><body><h1>GALLERY-DEMO-MARKER</h1><script>void 0</script></body></html>'),
    'thumbnail.png': png,
  });
}

before(async () => {
  BASE = `http://127.0.0.1:${await freePort()}`;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const logFd = fs.openSync(path.join(TMP, 'server.log'), 'w');
  const env = { ...process.env };
  delete env.DISABLE_HOMEPAGE;
  Object.assign(env, {
    DATA_DIR, SELF_HOSTED: 'true', PORT: new URL(BASE).port, HOST: '127.0.0.1', NODE_ENV: 'test',
    JWT_SECRET: 'tpl-gallery-' + crypto.randomBytes(8).toString('hex'),
    TEMPLATE_CATALOG_PUBLIC_KEY: official.publicKey.export({ type: 'spki', format: 'pem' }),
    TEMPLATE_CATALOG_URL: 'https://catalog.invalid/templates/',
  });
  proc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { up = (await fetch(BASE + '/api/status')).ok; } catch { /* booting */ }
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot; see ' + path.join(TMP, 'server.log'));

  const reg = await http('POST', '/api/auth/register', { body: { email: 'admin@gallery.local', password: 'Passw0rd123!', createOrg: true } });
  assert.equal(reg.status, 201, reg.text);
  const { token } = JSON.parse(reg.text);
  const ws = JSON.parse(reg.text).current_workspace_id;

  for (const [key, bytes, priv] of [['official/wx', weatherHtml('wx'), official.privateKey], ['local/wx-local', weatherHtml('wx-local'), local.privateKey]]) {
    if (key.startsWith('local/')) {
      const s = await http('PUT', '/api/templates/settings', { token, body: { unsigned_code_allowed: true, confirm: 'I understand unsigned templates run unreviewed code on my screens' } });
      assert.equal(s.status, 200, s.text);
    }
    const env2 = key.startsWith('official/') ? pkg.buildEnvelope(bytes, signing.signPackage(bytes, priv)) : pkg.buildEnvelope(bytes, null);
    const r = await http('POST', '/api/templates/import', { token, body: env2 });
    assert.equal(r.status, 201, `import ${key}: ${r.text}`);
    shas[key] = JSON.parse(r.text).sha256;
  }

  const Database = require('better-sqlite3');
  sqlite = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  sqlite.pragma('busy_timeout = 5000');
  // A workspace data source under the demo slug, holding a secret: a public render must never read it.
  sqlite.prepare("INSERT INTO data_sources (id, workspace_id, slug, name, type, config, cached_data) VALUES (?, ?, ?, 'x', 'json_api', '{}', ?)")
    .run(crypto.randomUUID(), ws, gallery.DEMO_WEATHER_SLUG, JSON.stringify({ location: 'TENANT-SECRET-LOCATION' }));
}, { timeout: 120000 });

after(() => {
  try { if (proc) proc.kill('SIGKILL'); } catch { /* */ }
  try { if (sqlite) sqlite.close(); } catch { /* */ }
  if (!process.env.KEEP_TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } }
});

function seedIndex(templates) {
  const index = { schema: 1, catalog: 'official', serial: Date.now(), generated: new Date().toISOString(), expires: new Date(Date.now() + 864e5).toISOString(), revoked: [], templates };
  sqlite.prepare("UPDATE template_catalogs SET index_json = ?, last_serial = ? WHERE id = 'official'").run(JSON.stringify(index), index.serial);
}

test('/templates with no accepted catalog: 200 and the committed fallback, never an error', async () => {
  sqlite.prepare("UPDATE template_catalogs SET index_json = NULL WHERE id = 'official'").run();
  const r = await http('GET', '/templates');
  assert.equal(r.status, 200);
  assert.match(r.text, /class="tg-fallback"/);
  assert.match(r.headers.get('content-security-policy') || '', /script-src 'self'/, 'the marketing CSP still applies');
});

test('/templates lists the live catalog, with a preview only for what is installed here', async () => {
  seedIndex([
    { id: 'wx', name: 'Weather wx', kind: 'html', tags: ['weather', 'data-source'], description: 'installed one', thumbnail: 'thumbnail.png',
      versions: [{ version: '1.0.0', sha256: shas['official/wx'], network: [], min_server: '2.2.0', size: 1, url: 'p/wx.sttemplate', params: 2, published: '2026-10-01' }] },
    { id: 'later', name: 'Published Later', kind: 'slide', tags: ['menu'], description: 'not installed',
      versions: [{ version: '1.0.0', sha256: SHA('9'), network: [], min_server: '2.2.0', size: 1, url: 'p/later.sttemplate', params: 1, published: '2026-10-05' }] },
  ]);
  const r = await http('GET', '/templates');
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes('class="tg-fallback"'));
  assert.ok(r.text.includes('Weather wx') && r.text.includes('Published Later'), 'a template added to the catalog appears with no redeploy');
  assert.ok(r.text.includes(`data-preview="/api/templates/demo/${shas['official/wx']}"`));
  assert.equal((r.text.match(/data-preview=/g) || []).length, 1);
  assert.ok(r.text.includes(`/api/templates/thumb/${shas['official/wx']}`));

  const md = await http('GET', '/templates.md');
  assert.equal(md.status, 200);
  assert.match(md.headers.get('content-type'), /text\/markdown/);
  assert.ok(md.text.includes('Published Later'), 'the Markdown twin is the live page, not the shell');

  const old = await http('GET', '/templates.html');
  assert.equal(old.status, 301);
  assert.equal(old.headers.get('location'), '/templates');
});

test('demo: an installed official template renders with demo weather, sandboxed, frameable by the page', async () => {
  const r = await http('GET', `/api/templates/demo/${shas['official/wx']}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /^sandbox allow-scripts;/);
  assert.doesNotMatch(r.headers.get('content-security-policy'), /script-src 'self'/, 'exactly one CSP: the render one');
  assert.equal(r.headers.get('x-frame-options'), null);
  assert.ok(r.text.includes('GALLERY-DEMO-MARKER'));
  assert.ok(r.text.includes('DEFAULT-TITLE'), 'the template\'s own defaults');
  assert.ok(r.text.includes('Manchester'), 'the demo weather is bound');
  assert.ok(!r.text.includes('TENANT-SECRET-LOCATION'), 'a public render never reads a workspace\'s data source');
});

test('demo: refused for unknown hashes, non-official packages and junk, and is a sandboxed 404', async () => {
  for (const p of [`/api/templates/demo/${SHA('0')}`, `/api/templates/demo/${shas['local/wx-local']}`, `/api/templates/demo/${SHA('0')}0`, '/api/templates/demo/xyz']) {
    const r = await http('GET', p);
    assert.equal(r.status, 404, p);
    if (r.headers.get('content-security-policy')) assert.match(r.headers.get('content-security-policy'), /sandbox/, p);
    assert.ok(!r.text.includes('GALLERY-DEMO-MARKER'), p);
  }
});

test('demo: withdrawn the moment the package stops being usable', async () => {
  sqlite.prepare("UPDATE templates_installed SET status = 'revoked' WHERE id = 'official/wx'").run();
  try {
    const r = await http('GET', `/api/templates/demo/${shas['official/wx']}`);
    assert.equal(r.status, 404, 'a cached render must not outlive the package');
  } finally {
    sqlite.prepare("UPDATE templates_installed SET status = 'active' WHERE id = 'official/wx'").run();
  }
});
