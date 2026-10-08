'use strict';

/*
 * What a screen's payload becomes under automation, in process (ws/deviceSocket.js).
 *
 *   - an emergency hook's alert shows CAP's alert card on screens in the hook's scope only
 *   - a playlist override switches a screen (full screen, no layout) and ends on the clock
 *   - an emergency alert outranks a playlist override
 *   - ⚠️ a screen on a head office (corporate) playlist is never overridden by a store's automation
 */

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-autopay-' + crypto.randomBytes(4).toString('hex'));
process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { db } = require('../db/database');
const setupDeviceSocket = require('../ws/deviceSocket');
const hooks = require('../lib/automation/hooks');
const overrides = require('../lib/automation/overrides');

const O = 'o-ap', WS = 'ws-ap', HQ = 'ws-ap-hq', U = 'u-ap', PL = 'pl-ap-own', PROMO = 'pl-ap-promo', BRAND = 'pl-ap-brand';
const D_LOBBY = 'd-ap-lobby', D_BACK = 'd-ap-back', D_CORP = 'd-ap-corp';
let build;
let NOW = Math.floor(Date.now() / 1000);

before(() => {
  setupDeviceSocket(new Server(http.createServer()));
  build = setupDeviceSocket.buildPlaylistPayloadUnchecked;
  db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, 'ap@t.local', 'x', 'user')").run(U);
  db.prepare('INSERT INTO organizations (id, name, owner_user_id, corporate_enabled) VALUES (?, ?, ?, 1)').run(O, 'Org', U);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?), (?, ?, ?)').run(WS, O, 'WS', HQ, O, 'HQ');
  const item = { content_id: null, widget_id: null, filename: 'x.png', mime_type: 'image/png', filepath: 'x.png', duration_sec: 10, sort_order: 0 };
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name, status, published_snapshot) VALUES (?, ?, ?, 'Own', 'published', ?), (?, ?, ?, 'Promo', 'published', ?)")
    .run(PL, U, WS, JSON.stringify([{ ...item, filename: 'own.png' }]), PROMO, U, WS, JSON.stringify([{ ...item, filename: 'promo.png' }]));
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name, status, published_snapshot, corporate) VALUES (?, ?, ?, 'Brand', 'published', ?, 1)")
    .run(BRAND, U, HQ, JSON.stringify([{ ...item, filename: 'brand.png' }]));
  for (const [id, tags] of [[D_LOBBY, ['lobby']], [D_BACK, ['back']], [D_CORP, ['lobby']]]) {
    db.prepare("INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, playlist_id, playlist_source, tags) VALUES (?, ?, ?, ?, ?, ?, 'device', ?)")
      .run(id, U, WS, id, crypto.randomUUID().slice(0, 6), PL, JSON.stringify(tags));
  }
  // Head office mandates its playlist on one store screen.
  db.prepare("INSERT INTO corporate_mandates (id, organization_id, playlist_id, target_kind, target_id) VALUES ('m-ap', ?, ?, 'device', ?)").run(O, BRAND, D_CORP);
  overrides._setClock(() => NOW);
});

const shows = (d) => build(d).assignments.map((a) => a.widget_type === 'cap_alert' ? 'CARD' : a.filename);
function hook(kind, config) {
  const id = crypto.randomUUID();
  const v = hooks.validateConfig(db, WS, kind, config);
  assert.ok(!v.error, v.error);
  db.prepare('INSERT INTO automation_hooks (id, workspace_id, name, kind, config, secret_hash, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, WS, `${kind} hook`, kind, JSON.stringify(v.config), hooks.newSecret().hash, U);
  return db.prepare('SELECT * FROM automation_hooks WHERE id = ?').get(id);
}
const send = (h, body) => hooks.run(db, db.prepare('SELECT * FROM automation_hooks WHERE id = ?').get(h.id), { body, text: JSON.stringify(body), format: 'json' });

test('a playlist override switches tagged screens and ends on the clock; a head office screen is untouched', async () => {
  assert.deepEqual(shows(D_LOBBY), ['own.png']);
  assert.deepEqual(shows(D_CORP), ['brand.png'], 'the mandate is in force');
  const h = hook('playlist', { playlist_id: PROMO, minutes: 10, scopes: [{ scope_kind: 'tag', scope_id: 'lobby' }] });
  const r = await send(h, {});
  assert.equal(r.ok, true, r.outcome);
  assert.deepEqual(shows(D_LOBBY), ['promo.png']);
  assert.deepEqual(shows(D_BACK), ['own.png'], 'out of scope');
  assert.deepEqual(shows(D_CORP), ['brand.png'], 'a head office screen is never overridden');
  NOW += 10 * 60 + 1;
  overrides.tick(db);
  assert.deepEqual(shows(D_LOBBY), ['own.png'], 'back to its own playlist');
});

test('an emergency hook shows the card in scope, outranks an override, and clears', async () => {
  const p = hook('playlist', { playlist_id: PROMO, minutes: 30, scopes: [{ scope_kind: 'workspace' }] });
  await send(p, {});
  assert.deepEqual(shows(D_BACK), ['promo.png']);
  const e = hook('emergency', { op: 'auto', scopes: [{ scope_kind: 'tag', scope_id: 'back' }] });
  const r = await send(e, { id: 'E1', headline: 'Evacuate', message: 'Now.' });
  assert.equal(r.raised, 1, r.outcome);
  assert.deepEqual(shows(D_BACK), ['CARD'], 'the alert outranks the override');
  assert.deepEqual(shows(D_LOBBY), ['promo.png'], 'out of the alert scope: still overridden');
  await send(e, { id: 'E1', status: 'all clear' });
  assert.deepEqual(shows(D_BACK), ['promo.png']);
  overrides.stop(db, { workspaceId: WS, hookId: p.id });
  assert.deepEqual(shows(D_BACK), ['own.png']);
});
