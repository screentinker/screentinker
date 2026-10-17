'use strict';

/*
 * The outbound connections ledger (lib/outbound-ledger.js): what it records, what it must never
 * record, who it blames, and — statically — that no new code makes an outbound request from a file
 * nobody has looked at.
 */
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'st-trust-ledger-' + process.pid + '-' + Date.now());
process.env.JWT_SECRET = 'test-secret-trust-ledger';
process.env.NODE_ENV = 'test';

const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { db } = require('../db/database');
const ledger = require('../lib/outbound-ledger');
const features = require('../lib/trust/features');

let server, port;
before(async () => {
  server = http.createServer((req, res) => {
    const body = 'hello world';
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  ledger.install({ db });
});
after(() => {
  ledger.uninstall();
  server.close();
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (_) { /* */ }
});

const rows = () => { ledger.flush(); return db.prepare('SELECT * FROM outbound_ledger ORDER BY host, feature').all(); };
const clear = () => { ledger.flush(); db.prepare('DELETE FROM outbound_ledger').run(); };
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject);
  });
}

test('aggregates per day, host and feature: counts and declared bytes add up', async () => {
  clear();
  await ledger.withContext({ feature: 'stripe' }, async () => {
    await httpGet(`http://127.0.0.1:${port}/v1/charges?key=sk_live_secret`);
    await httpGet(`http://127.0.0.1:${port}/v1/other`);
  });
  const r = rows();
  assert.equal(r.length, 1, JSON.stringify(r));
  assert.equal(r[0].host, `127.0.0.1:${port}`);
  assert.equal(r[0].feature, 'stripe');
  assert.equal(r[0].category, 'billing');
  assert.equal(r[0].scope, 'loopback');
  assert.equal(r[0].count, 2);
  assert.equal(r[0].bytes_in, 22, 'Content-Length of both answers');
  assert.equal(r[0].day, new Date().toISOString().slice(0, 10));
});

test('⚠️ never stores a path, a query string, userinfo or a header — only the host', async () => {
  clear();
  await httpGet(`http://127.0.0.1:${port}/private/customer-42/report?token=abc123&api_key=SECRETKEY`);
  await fetch(`http://127.0.0.1:${port}/x?access_token=FETCHSECRET`, { headers: { Authorization: 'Bearer HEADERSECRET' } }).then((r) => r.text());
  const dump = JSON.stringify(rows());
  for (const leak of ['customer-42', 'token', 'abc123', 'SECRETKEY', 'FETCHSECRET', 'HEADERSECRET', '/private', '?', 'Bearer']) {
    assert.ok(!dump.includes(leak), `ledger must not contain ${leak}: ${dump}`);
  }
  // Every column of the table is accounted for: nothing could carry a URL.
  const cols = db.prepare('PRAGMA table_info(outbound_ledger)').all().map((c) => c.name).sort();
  assert.deepEqual(cols, ['bytes_in', 'bytes_out', 'category', 'count', 'day', 'errors', 'feature', 'first_seen', 'host', 'last_seen', 'organization_id', 'scope', 'workspace_id']);
});

test('cleanHost keeps the host and nothing else; anything that is not a host is refused', () => {
  assert.equal(ledger.cleanHost('User:Pw@API.Example.COM:443', 'https:'), 'api.example.com');
  assert.equal(ledger.cleanHost('example.com:80', 'http:'), 'example.com');
  assert.equal(ledger.cleanHost('example.com:8443', 'https:'), 'example.com:8443');
  assert.equal(ledger.cleanHost('https://a.example/path?token=x'), 'a.example');
  assert.equal(ledger.cleanHost('[::1]:3001'), '[::1]:3001');
  assert.equal(ledger.cleanHost('exa mple.com'), null);
  assert.equal(ledger.cleanHost(''), null);
  assert.equal(ledger.cleanHost('x'.repeat(400)), null);
});

test('global fetch is counted, and attributed to the server file that called it', async () => {
  clear();
  await fetch(`http://127.0.0.1:${port}/a`).then((r) => r.text());
  const r = rows();
  assert.equal(r.length, 1);
  // A file the feature table does not know is reported under its own path — never "unattributed".
  assert.equal(r[0].feature, 'test/trust-ledger.test.js');
});

test('a request through the SSRF guard is attributed to its caller, not to the guard', async () => {
  clear();
  process.env.OUTBOUND_ALLOW_HOSTS = '127.0.0.1';
  try {
    const { guardedRequest } = require('../lib/ssrf-guard');
    await guardedRequest(`http://127.0.0.1:${port}/g?secret=1`, { responseType: 'text' });
  } finally { delete process.env.OUTBOUND_ALLOW_HOSTS; }
  const r = rows();
  assert.equal(r.length, 1, JSON.stringify(r));
  assert.equal(r[0].feature, 'test/trust-ledger.test.js');
});

test('stack attribution: a known file maps to its feature; chokepoints are skipped; SDKs map by package', () => {
  const root = path.join(__dirname, '..') + path.sep;
  const stack = [
    'Error',
    `    at follow (${root}lib/ssrf-guard.js:10:5)`,
    `    at fetchText (${root}lib/data-sources/http.js:44:3)`,
    `    at async resolve (${root}lib/data-sources/square-resolver.js:12:3)`,
    `    at async sync (${root}lib/data-sources/service.js:150:3)`,
  ].join('\n');
  assert.equal(ledger.featureFromStack(stack), 'pos_menus');
  const sdk = ['Error', `    at x (${root}node_modules/stripe/cjs/net/NodeHttpClient.js:1:1)`].join('\n');
  assert.equal(ledger.featureFromStack(sdk), 'stripe');
  assert.equal(features.featureForHost('api.stripe.com'), 'stripe');
  assert.equal(features.featureForHost('evil.example'), null);
});

test('workspace attribution: explicit context names the workspace and its organization', async () => {
  clear();
  db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES ('u-led','led@x.local','x','user')").run();
  db.prepare("INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES ('org-led','Led','u-led')").run();
  db.prepare("INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES ('ws-led','org-led','W')").run();
  await ledger.withContext({ workspaceId: 'ws-led', feature: 'data_sources' }, () => httpGet(`http://127.0.0.1:${port}/w`));
  const r = rows();
  assert.equal(r[0].workspace_id, 'ws-led');
  assert.equal(r[0].organization_id, 'org-led');
});

test('⚠️ a finished request\'s workspace is NOT inherited by a timer it started', async () => {
  clear();
  const req = { workspaceId: 'ws-led', organizationId: 'org-led' };
  const res = { writableFinished: false, destroyed: false };
  let fire;
  const fired = new Promise((r) => { fire = r; });
  // A "request" starts a timer, then finishes; the timer's fetch runs after.
  ledger.middleware(req, res, () => { setTimeout(() => httpGet(`http://127.0.0.1:${port}/bg`).then(fire), 30); });
  res.writableFinished = true;
  await fired;
  const r = rows();
  assert.equal(r.length, 1);
  assert.equal(r[0].workspace_id, '', 'background work is instance-level, never another org\'s');
  assert.equal(r[0].organization_id, '');
});

test('while the request is still being served, its workspace is used', async () => {
  clear();
  const req = { workspaceId: null, organizationId: null };
  const res = { writableFinished: false, destroyed: false };
  await new Promise((resolve) => ledger.middleware(req, res, async () => {
    req.workspaceId = 'ws-led'; req.organizationId = 'org-led';   // set later by resolveTenancy
    await httpGet(`http://127.0.0.1:${port}/live`);
    resolve();
  }));
  assert.equal(rows()[0].organization_id, 'org-led');
});

test('errors are counted against the host', async () => {
  clear();
  await ledger.withContext({ feature: 'telemetry' }, () => new Promise((resolve) => {
    http.get('http://127.0.0.1:1/', () => resolve()).on('error', () => resolve());
  }));
  const r = rows();
  assert.equal(r[0].host, '127.0.0.1:1');
  assert.equal(r[0].errors, 1);
});

test('SMTP (not HTTP) is noted explicitly by the email service, host and port only', () => {
  clear();
  ledger.note({ host: 'smtp.example.com:587', protocol: 'smtp:', feature: 'email' });
  const r = rows();
  assert.equal(r[0].host, 'smtp.example.com:587');
  assert.equal(r[0].feature, 'email');
  assert.equal(r[0].scope, 'internet');
});

test('prune drops rows past the retention horizon', () => {
  clear();
  db.prepare("INSERT INTO outbound_ledger (day, host, feature, first_seen, last_seen, count) VALUES ('2000-01-01', 'old.example', 'stripe', 1, 1, 1)").run();
  assert.equal(ledger.prune(), 1);
});

test('uninstalled, nothing is recorded and fetch is the original', async () => {
  clear();
  ledger.uninstall();
  assert.ok(!globalThis.fetch.__ledger);
  await httpGet(`http://127.0.0.1:${port}/off`);
  ledger.install({ db });
  assert.equal(rows().length, 0);
});

/* ───────────── chokepoint coverage (static) ───────────── */

/*
 * Every server file that can make an outbound request on its own — a fetch call or reference, an
 * http/https/net/tls client module, an SDK with its own HTTP client, a WebSocket client — must be
 * listed here with why. The ledger itself sees every request at Node's http and undici layers
 * whatever file made it; this list is what keeps the ATTRIBUTION honest (a new caller shows up on
 * the Outbound connections page under a feature, not a file path) and makes a new outbound path a
 * reviewed decision. Kinds:
 *   chokepoint   a guard every caller should go through (lib/ssrf-guard, lib/ai-fetch, lib/bi/http)
 *   feature      a direct caller; its feature must be in lib/trust/features.js
 *   browser      code inside a template string, run by a browser or player, not by this server
 *   inbound      a server, not a client
 */
const ALLOWED = {
  'lib/ssrf-guard.js': 'chokepoint',
  'lib/ai-fetch.js': 'chokepoint',
  'lib/bi/http.js': 'chokepoint',
  'lib/storage/endpoint-guard.js': 'chokepoint',
  'lib/outbound-ledger.js': 'chokepoint',
  'lib/ai-hosted.js': 'feature',
  'lib/bi/powerbi.js': 'feature',
  'lib/canva.js': 'feature',
  'lib/ghcr-check.js': 'feature',
  'lib/go2rtc.js': 'feature',
  'lib/live-publish-ws.js': 'feature',
  'lib/m365.js': 'feature',
  'lib/mesh/content-cache.js': 'feature',
  'lib/mesh/local-apply.js': 'feature',
  'lib/mesh/pull-download.js': 'feature',
  'lib/replica-proxy.js': 'feature',
  'lib/rooms/http.js': 'feature',
  'lib/storage/azure.js': 'feature',
  'lib/storage/s3.js': 'feature',
  'lib/stripe-client.js': 'feature',
  'lib/telemetry.js': 'feature',
  'lib/templates/catalog.js': 'feature',
  'lib/user-deletion.js': 'feature',
  'routes/bi-connections.js': 'feature',
  'routes/content.js': 'feature',
  'routes/mcp.js': 'feature',
  'routes/mesh-enroll.js': 'feature',
  'server.js': 'feature',
  'services/email.js': 'feature',
  'services/mesh-uplink.js': 'feature',
  'lib/live-publish.js': 'browser',
  'lib/rooms/render.js': 'browser',
  'lib/screen-share-player.js': 'browser',
  'lib/talk-web.js': 'browser',
  'routes/widgets.js': 'browser',
  'lib/screen-share.js': 'inbound',
  'lib/oidc.js': 'inbound',              // net.isIP only; its requests go through lib/ai-fetch guardedFetch
  'lib/forwarded-client-ip.js': 'inbound', // net.isIP only
  'lib/http-logging.js': 'inbound',        // net.isIP only
  'lib/view-access.js': 'inbound',         // net.isIP only
  'lib/private-ai.js': 'inbound',          // net.isIP only; its requests go through lib/ai-fetch
  'lib/site-cache/node.js': 'feature',     // the cache BOX (its own process): pulls from the origin it is enrolled with
};

const ROOT = path.join(__dirname, '..');
function serverFiles() {
  const out = ['server.js', 'config.js'];
  const walk = (d) => {
    for (const f of fs.readdirSync(path.join(ROOT, d))) {
      const p = path.posix.join(d, f);
      const st = fs.statSync(path.join(ROOT, p));
      if (st.isDirectory()) { if (f !== 'node_modules') walk(p); } else if (f.endsWith('.js')) out.push(p);
    }
  };
  for (const d of ['lib', 'routes', 'services', 'ws', 'middleware', 'db', 'config']) walk(d);
  return out;
}
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const OUTBOUND_RE = [
  /(^|[^.\w$])fetch\s*\(|(global|globalThis)\.fetch\b|[=(,:|?]\s*fetch\b(?![\w$]|\s*:)/,
  /require\(\s*['"](ws|socket\.io-client|nodemailer|stripe|undici|@aws-sdk\/[\w-]+|@azure\/[\w-]+)['"]\s*\)/,
  /require\(\s*['"](node:)?(https?|net|tls|http2)['"]\s*\)/,
  /new\s+WebSocket\s*\(/,
];

test('⚠️ chokepoint coverage: no file makes outbound requests unless it is on the reviewed list', () => {
  const found = serverFiles().filter((f) => {
    const s = strip(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    return OUTBOUND_RE.some((r) => r.test(s));
  });
  const unlisted = found.filter((f) => !ALLOWED[f]);
  assert.deepEqual(unlisted, [], `New outbound code. Route it through lib/ssrf-guard (guardedRequest), lib/ai-fetch (guardedFetch) or lib/data-sources/http (fetchText), or add it to ALLOWED here with a feature in lib/trust/features.js: ${unlisted.join(', ')}`);
  const stale = Object.keys(ALLOWED).filter((f) => !found.includes(f));
  assert.deepEqual(stale, [], `No longer makes outbound requests; remove from ALLOWED: ${stale.join(', ')}`);
});

test('every direct outbound caller has a named feature on the Outbound connections page', () => {
  for (const [f, kind] of Object.entries(ALLOWED)) {
    if (kind !== 'feature') continue;
    const feat = features.featureForFile(f);
    assert.ok(features.FEATURES[feat], `${f} -> "${feat}" is not a feature in lib/trust/features.js`);
  }
});
