'use strict';

/*
 * The widget sandbox opt-out is self-hosted only.
 *
 * On a hosted instance the server's origin is shared by every tenant, and the dashboard keeps its
 * session in that origin's localStorage. With isolation off, a text widget's srcdoc frame ran as that
 * origin, so one org switching it off could lift another org's (or a platform admin's) session just by
 * getting them to open the widget's /render link.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-widget-iso-'));
process.env.DATA_DIR = tmp;
delete process.env.SELF_HOSTED;

const appConfig = require('../config');
const { db } = require('../db/database');
const workspaces = require('../routes/workspaces');
const widgets = require('../routes/widgets');

db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u-o', 'owner@test', 'O', 'user')").run();
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-a', 'A', 'u-o')").run();
db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES ('org-a', 'u-o', 'org_owner')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-a', 'org-a', 'A')").run();
db.prepare("INSERT INTO widgets (id, workspace_id, user_id, name, widget_type, config) VALUES ('w-text', 'ws-a', 'u-o', 't', 'text', ?)")
  .run(JSON.stringify({ html: '<script>steal(localStorage.token)</script>' }));

let server;
async function call(method, url, body) {
  if (!server) {
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 'u-o', role: 'user' }; next(); });
    app.use('/api/workspaces', workspaces);
    app.use('/api/widgets', widgets);
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
  }
  const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, text, json, headers: res.headers };
}
after(() => { if (server) server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const PHRASE = 'I understand I am enabling a security hole';
const flag = () => db.prepare('SELECT widget_sandbox_isolation_disabled AS v FROM organizations WHERE id = ?').get('org-a').v;

test('hosted: an org owner cannot turn widget isolation off', async () => {
  appConfig.selfHosted = false;
  const r = await call('PUT', '/api/workspaces/ws-a/security-settings', { widgetSandboxIsolationDisabled: true, confirmationPhrase: PHRASE });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'WIDGET_ISOLATION_SELF_HOSTED_ONLY');
  assert.equal(flag(), 0);
});

test('hosted: an org that turned it off earlier can still turn it back on', async () => {
  appConfig.selfHosted = false;
  db.prepare('UPDATE organizations SET widget_sandbox_isolation_disabled = 1 WHERE id = ?').run('org-a');
  const r = await call('PUT', '/api/workspaces/ws-a/security-settings', { widgetSandboxIsolationDisabled: false });
  assert.equal(r.status, 200);
  assert.equal(flag(), 0);
});

test('hosted: a flag already set is ignored, the sandbox stays isolating', async () => {
  appConfig.selfHosted = false;
  db.prepare('UPDATE organizations SET widget_sandbox_isolation_disabled = 1 WHERE id = ?').run('org-a');
  assert.equal(widgets.widgetIframeSandboxForWorkspace('ws-a'), 'allow-scripts');
  db.prepare('UPDATE organizations SET widget_sandbox_isolation_disabled = 0 WHERE id = ?').run('org-a');
});

test('self-hosted: the operator can still turn it off, and webpage widgets get same-origin', async () => {
  appConfig.selfHosted = true;
  const r = await call('PUT', '/api/workspaces/ws-a/security-settings', { widgetSandboxIsolationDisabled: true, confirmationPhrase: PHRASE });
  assert.equal(r.status, 200);
  assert.equal(widgets.widgetIframeSandboxForWorkspace('ws-a'), 'allow-scripts allow-same-origin');
  const page = widgets.renderWidgetHtml('webpage', { url: 'https://example.com/' }, { iframeSandbox: 'allow-scripts allow-same-origin' });
  assert.match(page, /sandbox="allow-scripts allow-same-origin"/);
  db.prepare('UPDATE organizations SET widget_sandbox_isolation_disabled = 0 WHERE id = ?').run('org-a');
  appConfig.selfHosted = false;
});

test('a text widget never frames author HTML same-origin, whatever the setting', () => {
  const page = widgets.renderWidgetHtml('text', { html: '<b>x</b>' }, { iframeSandbox: 'allow-scripts allow-same-origin' });
  assert.match(page, /<iframe sandbox="allow-scripts" srcdoc=/);
  assert.doesNotMatch(page, /allow-same-origin/);
});

test('a text widget render is a null origin even when opened top-level', async () => {
  for (const selfHosted of [false, true]) {
    appConfig.selfHosted = selfHosted;
    db.prepare('UPDATE organizations SET widget_sandbox_isolation_disabled = 1 WHERE id = ?').run('org-a');
    const r = await call('GET', '/api/widgets/w-text/render');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-security-policy'), 'sandbox allow-scripts');
    assert.doesNotMatch(r.text, /allow-same-origin/);
  }
  db.prepare('UPDATE organizations SET widget_sandbox_isolation_disabled = 0 WHERE id = ?').run('org-a');
  appConfig.selfHosted = false;
});
