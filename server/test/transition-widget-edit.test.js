'use strict';

/*
 * Editing a TRANSITION widget reaches the screens playing it, without a re-publish.
 *
 * A transition is a widget placed in a playlist. Its settings used to be frozen into the published
 * snapshot, so an edit (effects, duration, scope) never reached a screen: the save pushed a payload,
 * and the payload carried the settings from the last publish. Ordinary widgets read their content
 * live; the device payload now does the same for a transition's config (ws/deviceSocket.js
 * refreshWidgetRevs), and normalizeTransitions resolves the current settings.
 *
 *   - PUT /api/widgets/:id with a new duration -> the device payload carries the new duration
 *   - a scope change (all -> next) takes effect too
 *   - ⚠️ with approval on, the edit is a draft and the screen keeps the reviewed settings
 */

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-transedit-' + crypto.randomBytes(4).toString('hex'));
process.env.JWT_SECRET = 'test-secret-transedit';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const setupDeviceSocket = require('../ws/deviceSocket');
const { buildSnapshotItems } = require('../routes/playlists');

const O = 'o-te', WS = 'ws-te', U = 'u-te', PL = 'pl-te', W = 'w-te', D = 'd-te';
let server, base, build;
const tokenOf = () => generateToken(db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(U), WS);
async function put(body) {
  const r = await fetch(`${base}/api/widgets/${W}`, { method: 'PUT',
    headers: { Authorization: `Bearer ${tokenOf()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const transitions = () => build(D).assignments.map((a) => a.transition || null);

before(async () => {
  setupDeviceSocket(new Server(http.createServer()));
  build = setupDeviceSocket.buildPlaylistPayloadUnchecked;
  db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, 'te@t.local', 'x', 'user')").run(U);
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(O, 'Org', U);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(WS, O, 'WS');
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')").run(WS, U);
  for (const c of ['c-te-a', 'c-te-b']) {
    db.prepare("INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type) VALUES (?, ?, ?, ?, ?, 'image/png')").run(c, U, WS, c + '.png', c + '.png');
  }
  db.prepare("INSERT INTO widgets (id, user_id, workspace_id, widget_type, name, config, updated_at) VALUES (?, ?, ?, 'transition', 'Fade', ?, 1000)")
    .run(W, U, WS, JSON.stringify({ shaders: ['Crossfade'], durationMs: 800, scope: 'all' }));
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name, status) VALUES (?, ?, ?, 'P', 'draft')").run(PL, U, WS);
  const ins = db.prepare('INSERT INTO playlist_items (playlist_id, content_id, widget_id, sort_order, duration_sec) VALUES (?, ?, ?, ?, 10)');
  ins.run(PL, 'c-te-a', null, 0);
  ins.run(PL, null, W, 1);
  ins.run(PL, 'c-te-b', null, 2);
  // Published once, at 800 ms: this is the frozen snapshot every edit used to be stuck behind.
  db.prepare("UPDATE playlists SET status = 'published', published_snapshot = ? WHERE id = ?").run(JSON.stringify(buildSnapshotItems(PL)), PL);
  db.prepare("INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, playlist_id, playlist_source) VALUES (?, ?, ?, 'S', 'TE0001', ?, 'device')").run(D, U, WS, PL);

  const app = express();
  app.use(express.json());
  app.set('io', null);
  app.use('/api/widgets', requireAuth, resolveTenancy, require('../routes/widgets'));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { try { server.close(); } catch { /* */ } });

test('the published transition plays on every item of the zone', () => {
  const t = transitions();
  assert.equal(t.length, 2, 'the transition widget itself is never a visible item');
  assert.ok(t.every((x) => x && x.durationMs === 800), JSON.stringify(t));
  // Only the duration matters here.
});

test('an edited duration reaches the device payload without a re-publish', async () => {
  const r = await put({ config: { shaders: ['Crossfade'], durationMs: 2000, scope: 'all' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const t = transitions();
  assert.ok(t.every((x) => x && x.durationMs === 2000), `the screen still has the old duration: ${JSON.stringify(t)}`);
  assert.ok(String(db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(PL).published_snapshot).includes('800'),
    'the snapshot itself is untouched; the payload resolves the live config');
});

test('an edited scope takes effect too (all -> next covers only the following item)', async () => {
  const r = await put({ config: { shaders: ['Crossfade'], durationMs: 1200, scope: 'next' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const t = transitions();
  assert.equal(t[0], null, 'the item before the widget no longer transitions');
  assert.equal(t[1] && t[1].durationMs, 1200);
});

test('⚠️ with approval on, an edit is a draft: the screen keeps the reviewed settings', async () => {
  db.prepare('UPDATE workspaces SET require_approval = 1 WHERE id = ?').run(WS);
  try {
    const r = await put({ config: { shaders: ['Crossfade'], durationMs: 3000, scope: 'all' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.draft, true);
    const t = transitions();
    assert.equal(t[0], null);
    assert.equal(t[1] && t[1].durationMs, 1200, 'the unreviewed draft did not reach the screen');
  } finally {
    db.prepare('UPDATE workspaces SET require_approval = 0 WHERE id = ?').run(WS);
  }
});
