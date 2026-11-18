'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const vm = require('vm');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-kiosk-xss-'));
process.env.DATA_DIR = tmp;

const { db } = require('../db/database');
const kiosk = require('../routes/kiosk');
const devicesPlaying = require('../lib/devices-playing');
const commandQueue = require('../lib/command-queue');

db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u-k', 'kiosk@test', 'K', 'platform_admin')").run();
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-k', 'K', 'u-k')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-k', 'org-k', 'K')").run();

// The fan-out itself is lib/devices-playing.js (tested on its own); here only that the save asks it,
// for the right widgets, and pushes to what it answers.
const pushed = [];
const asked = [];
devicesPlaying.devicesPlayingWidget = (id) => { asked.push(id); return [`dev-of-${id}`]; };
commandQueue.queueOrEmitPlaylistUpdate = (_ns, deviceId) => { pushed.push(deviceId); };

let server;
async function call(method, url, body) {
  if (!server) {
    const express = require('express');
    const app = express();
    app.set('io', { of: () => ({}) });
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 'u-k', role: 'platform_admin' }; req.workspaceId = 'ws-k'; next(); });
    app.use('/api/kiosk', kiosk);
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
  }
  const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, text, json };
}
after(() => { if (server) server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

async function newPage(name, config) {
  const r = await call('POST', '/api/kiosk', { name, config });
  assert.equal(r.status, 201);
  return r.json;
}

/*
 * GHSA-g46x-g9mc-g2hp (bigcrushes) and GHSA-c3qc-939f-j4f4 (orshih6): a kiosk button with the "page"
 * action did `window.location.href = page` with no scheme check, on a public render served from the
 * dashboard's own origin, so a `javascript:` page ran with the visitor's dashboard session. Three
 * layers now: the click goes through siteUrl (http(s) or a path), the save refuses another scheme,
 * and the render is a null origin (CSP sandbox allow-scripts) wherever it is opened.
 */

// A page saved before the save-time rule existed: written straight to the table.
function legacyPage(id, buttons) {
  db.prepare("INSERT INTO kiosk_pages (id, user_id, workspace_id, name, config) VALUES (?, 'u-k', 'ws-k', 'old', ?)")
    .run(id, JSON.stringify({ buttons }));
}

// Run the render's own <script> against a tiny DOM and click its first button.
function clickFirstButton(html, href) {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const btn = /<div class="kiosk-btn" data-action="([^"]*)" data-url="([^"]*)" data-page="([^"]*)">/.exec(html);
  const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const listeners = [];
  const el = () => ({ style: {}, textContent: '', addEventListener() {}, set src(v) { this._src = v; } });
  const button = { dataset: { action: unesc(btn[1]), url: unesc(btn[2]), page: unesc(btn[3]) }, style: {},
    addEventListener: (ev, fn) => listeners.push(fn), querySelector: () => null };
  const location = { href };
  const window = { location, history: { back() {} }, addEventListener() {} };
  window.parent = window;
  const ctx = { window, URL, String, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    document: { querySelectorAll: () => [button], getElementById: el, addEventListener() {} } };
  vm.runInNewContext(script, ctx);
  listeners.forEach((fn) => fn());
  return location.href;
}

test('a javascript: page button does nothing when tapped (a page saved before the save rule)', async () => {
  const base = 'http://screen.test/api/kiosk/k-old/render';
  for (const [i, bad] of ['javascript:alert(document.domain)', ' JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)'].entries()) {
    legacyPage(`k-old-${i}`, [{ action: 'page', label: 'Touch to begin', page: bad }]);
    const html = (await call('GET', `/api/kiosk/k-old-${i}/render`)).text;
    assert.equal(clickFirstButton(html, base), base, `${JSON.stringify(bad)} must not navigate`);
  }
});

test('a real page button still navigates: a path on this server, or an http(s) address', async () => {
  const base = 'http://screen.test/api/kiosk/k-good/render';
  legacyPage('k-good-1', [{ action: 'page', label: 'Next', page: '/api/kiosk/other/render' }]);
  assert.equal(clickFirstButton((await call('GET', '/api/kiosk/k-good-1/render')).text, base), 'http://screen.test/api/kiosk/other/render');
  legacyPage('k-good-2', [{ action: 'page', label: 'Menu', page: 'https://example.com/menu' }]);
  assert.equal(clickFirstButton((await call('GET', '/api/kiosk/k-good-2/render')).text, base), 'https://example.com/menu');
});

test('saving refuses a button address with any scheme but http(s), on create and on edit', async () => {
  for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd']) {
    for (const field of ['page', 'url']) {
      const r = await call('POST', '/api/kiosk', { name: 'x', config: { buttons: [{ action: field, label: 'b', [field]: bad }] } });
      assert.equal(r.status, 400, `create ${field}=${JSON.stringify(bad)}`);
      assert.equal(r.json.code, 'KIOSK_BAD_ADDRESS');
    }
  }
  const ok = await call('POST', '/api/kiosk', { name: 'fine', config: { buttons: [
    { action: 'page', label: 'a', page: '/api/kiosk/x/render' }, { action: 'url', label: 'b', url: 'www.example.com' },
    { action: 'url', label: 'c', url: 'https://example.com' }, { action: 'page', label: 'd', page: '' }, { action: 'back', label: 'e' },
  ] } });
  assert.equal(ok.status, 201, 'paths, bare hosts, http(s) and empty values still save');
  const put = await call('PUT', `/api/kiosk/${ok.json.id}`, { config: { buttons: [{ action: 'page', label: 'x', page: 'javascript:alert(1)' }] } });
  assert.equal(put.status, 400);
  const still = JSON.parse(db.prepare('SELECT config FROM kiosk_pages WHERE id = ?').get(ok.json.id).config);
  assert.equal(still.buttons[0].page, '/api/kiosk/x/render', 'a refused edit changes nothing');
});

test('the render is a null origin wherever it is opened: CSP sandbox allow-scripts, no same-origin', async () => {
  legacyPage('k-csp', [{ action: 'back', label: 'Back' }]);
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/kiosk/k-csp/render`);
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /(^|;)\s*sandbox allow-scripts\s*($|;)/);
  assert.doesNotMatch(csp, /allow-same-origin/);
});

test("the editor's live preview frames the render sandboxed", () => {
  const view = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'kiosk.js'), 'utf8');
  assert.match(view, /<iframe id="kioskPreview"[^>]*\ssandbox="allow-scripts"/);
});
