'use strict';

/*
 * ⚠️ A TEMPLATE REACHED THROUGH THE SSSP3 "LINKED WIDGET" PATH MUST KEEP ITS SANDBOX CSP.
 *
 * A webpage widget whose URL points at another widget's /render is flattened for SSSP3
 * (?compat=sssp1228) by rendering the linked widget in place. For a template that used to keep
 * renderTemplateWidget(...).html and drop .csp. /render is CSP-exempt in server.js, so the
 * response had no CSP at all and template author JS ran top-level on the dashboard origin, from a
 * public URL. Every template render must be an opaque origin (`sandbox allow-scripts`).
 *
 * The linked template here is not installed, so renderTemplateWidget answers with its blank page
 * and the strictest CSP: that is enough to prove the route applies whatever CSP the render returns.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-sssp3-linked-template';

const db = new Database(':memory:');
db.exec(`CREATE TABLE widgets (id TEXT PRIMARY KEY, widget_type TEXT, config TEXT, workspace_id TEXT);`);
const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

const express = require('express');
const widgetsRouter = require('../routes/widgets');
const app = express();
app.use('/api/widgets', widgetsRouter);
const server = app.listen(0);
let base;
test.before(async () => { await new Promise((r) => (server.listening ? r() : server.once('listening', r))); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); db.close(); });

const seed = (id, type, config, workspaceId = 'ws1') => db.prepare('INSERT INTO widgets (id, widget_type, config, workspace_id) VALUES (?,?,?,?)').run(id, type, JSON.stringify(config), workspaceId);

const TPL = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const WRAP = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

test('SSSP3 linked template render carries the template sandbox CSP', async () => {
  seed(TPL, 'template', { template: 'official/not-installed', values: {} });
  // The wrapper links to the template by its own /render URL on this origin.
  seed(WRAP, 'webpage', { url: `${base}/api/widgets/${TPL}/render` });

  const direct = await fetch(`${base}/api/widgets/${TPL}/render`);
  await direct.text();
  const directCsp = direct.headers.get('content-security-policy') || '';
  assert.match(directCsp, /^sandbox allow-scripts/, 'direct template render is sandboxed (baseline)');

  const linked = await fetch(`${base}/api/widgets/${WRAP}/render?compat=sssp1228`);
  await linked.text();
  assert.equal(linked.status, 200);
  const csp = linked.headers.get('content-security-policy') || '';
  assert.match(csp, /^sandbox allow-scripts/, 'linked template must be an opaque origin, not the dashboard origin');
  assert.equal(csp, directCsp, 'linked path applies the same CSP the direct template render does');
  assert.equal(linked.headers.get('x-content-type-options'), 'nosniff');
});
