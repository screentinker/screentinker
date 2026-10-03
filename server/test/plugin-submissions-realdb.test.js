'use strict';

/*
 * Submission flow against a REAL sqlite DB (better-sqlite3, in-memory) with the SHIPPED schema.
 *
 * WHY THIS EXISTS ALONGSIDE plugin-submissions.test.js: that file drives submissions.js against a
 * hand-rolled regex-matching stub so it runs where better-sqlite3 is not compiled. The cost is that
 * the stub can stay green while the real SQL / schema drifts. This file closes that gap by applying
 * the actual plugin table DDL from db/schema.sql and exercising create -> get -> list -> approve/
 * reject end to end, so a column rename or a bad statement fails here. Skipped (not failed) if
 * better-sqlite3 is unavailable on the host.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const archiver = require('archiver');

let Database;
try { Database = require('better-sqlite3'); } catch { Database = null; }

const submissions = require('../lib/plugins/submissions');

// Pull the three plugin CREATE TABLE statements out of the real schema so this cannot drift from it.
function pluginSchemaDDL() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const blocks = [];
  const re = /CREATE TABLE IF NOT EXISTS plugin_[\s\S]*?\);/g;
  let m;
  while ((m = re.exec(sql)) !== null) blocks.push(m[0]);
  return blocks.join('\n');
}

// A minimal valid plugin zip (plugin.json + index.js) as a Buffer.
function makePluginZip(id = 'realdb-sample') {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const a = archiver('zip', { zlib: { level: 0 } });
    a.on('data', (c) => chunks.push(c));
    a.on('error', reject);
    a.on('end', () => resolve(Buffer.concat(chunks)));
    a.append(JSON.stringify({
      id, name: 'RealDB Sample', version: '1.0.0', main: 'index.js',
      capabilities: ['widget'],
      widget: { type: id, label: 'RealDB', fields: [] },
    }), { name: `${id}/plugin.json` });
    a.append("module.exports = { activate(api){ api.registerWidget({ render: () => '<!doctype html>' }); } };\n", { name: `${id}/index.js` });
    a.append('# RealDB Sample\n', { name: `${id}/README.md` });
    a.finalize();
  });
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-plugsub-realdb-'));
const INBOX = path.join(TMP, 'inbox');
const PLUGINS = path.join(TMP, 'plugins');
let db;

before(() => {
  if (!Database) return;
  fs.mkdirSync(INBOX, { recursive: true });
  fs.mkdirSync(PLUGINS, { recursive: true });
  db = new Database(':memory:');
  db.exec(pluginSchemaDDL());
});
after(() => { try { db && db.close(); } catch { /* */ } try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

test('the shipped plugin schema applies to a real sqlite db', (t) => {
  if (!Database) return t.skip('better-sqlite3 not available');
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'plugin_%'").all().map((r) => r.name);
  assert.ok(names.includes('plugin_submissions'), 'plugin_submissions created');
  assert.ok(names.includes('plugin_state'), 'plugin_state created');
  assert.ok(names.includes('plugin_allowlist'), 'plugin_allowlist created');
});

test('create -> get -> list -> approve writes real rows, pins a hash, does not enable', async (t) => {
  if (!Database) return t.skip('better-sqlite3 not available');
  const buffer = await makePluginZip('realdb-sample');
  const created = await submissions.create(db, { buffer, inboxDir: INBOX, submittedBy: 'u-writer', workspaceId: 'ws-1' });
  assert.equal(created.status, 'pending');
  assert.equal(created.plugin_id, 'realdb-sample');

  // Real SELECT round-trips the row.
  const got = submissions.get(db, created.id);
  assert.equal(got.id, created.id);
  assert.equal(got.status, 'pending');

  const pending = submissions.list(db, { status: 'pending' });
  assert.equal(pending.length, 1);

  // Approve copies the tree onto the plugin root and pins the sha256, but must NOT enable.
  const approved = await submissions.approve(db, { id: created.id, approvedBy: 'u-admin', inboxDir: INBOX, dataPluginsDir: PLUGINS });
  assert.equal(approved.status, 'approved');
  assert.ok(fs.existsSync(path.join(PLUGINS, 'realdb-sample', 'plugin.json')), 'approve copied the tree');
  const pin = db.prepare('SELECT * FROM plugin_allowlist WHERE plugin_id = ?').get('realdb-sample');
  assert.ok(pin && pin.sha256, 'approve pinned a sha256');
  const state = db.prepare('SELECT enabled FROM plugin_state WHERE id = ?').get('realdb-sample');
  assert.ok(!state || Number(state.enabled) !== 1, 'approve does not enable (P9)');
});

test('reject removes the pending submission without copying onto a plugin root', async (t) => {
  if (!Database) return t.skip('better-sqlite3 not available');
  const buffer = await makePluginZip('realdb-reject');
  const created = await submissions.create(db, { buffer, inboxDir: INBOX, submittedBy: 'u-writer', workspaceId: 'ws-1' });
  const out = submissions.reject(db, { id: created.id, decidedBy: 'u-admin', note: 'no', inboxDir: INBOX });
  assert.equal(out.status, 'rejected');
  assert.ok(!fs.existsSync(path.join(PLUGINS, 'realdb-reject')), 'reject never copies onto a plugin root');
});
