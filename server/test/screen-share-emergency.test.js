'use strict';

/*
 * #845: AN EMERGENCY ALERT OUTRANKS A SCREEN SHARE. The share overlay and its "share your screen"
 * QR draw above everything on every player, so the server decides it (lib/screen-share.js
 * alertLive / alertChanged):
 *   - a share running when an alert is raised on its screen is ended, reason 'emergency'
 *   - a screen under an alert refuses a new share (availability reason 'emergency')
 *   - it shows no code while the alert is live, and gets one back when the alert ends
 *   - a screen outside the alert keeps its share and its code
 * Raised and cleared through the REAL CAP feed path (applyPush + refresh -> pushTo -> alertChanged).
 */
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-share-emergency-'));
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = 'test';

const { db } = require('../db/database');
const config = require('../config');
const share = require('../lib/screen-share');
const feeds = require('../lib/cap/feeds');

db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u-em', 'em@test', 'Em', 'user')").run();
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-em', 'Org', 'u-em')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-em', 'org-em', 'WS')").run();
const CAPS = JSON.stringify(['remote.screen_share']);
db.prepare(`INSERT INTO devices (id, name, status, workspace_id, created_at, capabilities, device_token, screen_share_guest) VALUES
  ('d-hit', 'Lobby', 'online', 'ws-em', 0, ?, 'tok-hit', 1),
  ('d-calm', 'Boardroom', 'online', 'ws-em', 0, ?, 'tok-calm', 1)`).run(CAPS, CAPS);
db.prepare("INSERT INTO cap_feeds (id, workspace_id, user_id, name, url, min_severity, source) VALUES ('f-em', 'ws-em', 'u-em', 'NWS', 'hook', 'Severe', 'hook')").run();
db.prepare("INSERT INTO cap_feed_scopes (feed_id, scope_kind, scope_id) VALUES ('f-em', 'device', 'd-hit')").run();

const rooms = new Map();
const emits = [];
const fakeNs = { adapter: { rooms }, to(id) { return { emit(ev, data) { emits.push({ id, ev, data }); } }; } };
share.init({ of: () => fakeNs });
const online = (id) => rooms.set(id, new Set(['sock-' + id]));

let NOW = Date.parse('2026-11-12T12:00:00Z') / 1000;
feeds._setClock(() => NOW);
const feed = () => db.prepare("SELECT * FROM cap_feeds WHERE id = 'f-em'").get();
const alert = (msgType = 'Alert') => ({
  identifier: 'tornado-1', sender: 'nws', sent: '2026-11-12T11:55:00Z', status: 'Actual', msgType,
  references: msgType === 'Cancel' ? ['nws,tornado-1,2026-11-12T11:55:00Z'] : [],
  event: 'Tornado Warning', severity: 'Extreme', urgency: 'Immediate', effective: '2026-11-12T11:55:00Z',
  expires: '2026-11-12T13:00:00Z', headline: 'Tornado Warning', areaDesc: 'Here', geocodes: [],
});
const raise = () => { feeds.applyPush(db, feed(), [alert()]); feeds.refresh(db, 'f-em'); };
const clear = () => { feeds.endPushed(db, feed()); feeds.refresh(db, 'f-em'); };
const dev = (id) => db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
const ws = () => db.prepare("SELECT * FROM workspaces WHERE id = 'ws-em'").get();
const startShare = (id) => {
  const out = share.createSession({ device: dev(id), workspace: ws(), sharedBy: 'Pat', userId: 'u-em' });
  assert.ok(out.session, JSON.stringify(out.error));
  return out.session;
};
const lastCode = (id) => [...emits].reverse().find((e) => e.id === id && e.ev === 'device:screenshare-code');

const prevEnabled = config.screenShareEnabled;
config.screenShareEnabled = true;
after(() => { config.screenShareEnabled = prevEnabled; share._reset(); feeds._reset(); feeds._setClock(null); fs.rmSync(tmp, { recursive: true, force: true }); });
beforeEach(() => {
  share._reset(); emits.length = 0; rooms.clear(); online('d-hit'); online('d-calm');
  db.prepare("DELETE FROM cap_alerts WHERE feed_id = 'f-em'").run(); feeds.refresh(db, 'f-em');
  emits.length = 0;
});

test('a share running when an alert is raised on its screen is ended with reason "emergency"; another screen keeps its share', () => {
  const hit = startShare('d-hit');
  const calm = startShare('d-calm');
  raise();
  assert.equal(share.alertLive('d-hit'), true);
  assert.equal(hit.ended, true, 'the share on the alerted screen ended');
  const stop = emits.find((e) => e.id === 'd-hit' && e.ev === 'device:screenshare-stop');
  assert.ok(stop, 'the player is told to take the share down');
  assert.equal(stop.data.reason, 'emergency');
  assert.equal(calm.ended, false, 'a screen outside the alert is untouched');
});

test('a screen under an alert refuses a new share, and takes one again after the alert ends', () => {
  raise();
  assert.deepEqual(share.availability(dev('d-hit'), ws()), { ok: false, reason: 'emergency' });
  assert.deepEqual(share.availability(dev('d-calm'), ws()), { ok: true });
  clear();
  assert.equal(share.alertLive('d-hit'), false);
  assert.deepEqual(share.availability(dev('d-hit'), ws()), { ok: true });
});

test('no "share your screen" code while the alert is live; the code comes back when it ends', async () => {
  await share.pushCode('d-hit');
  assert.ok(lastCode('d-hit').data.code, 'a code before the alert');
  raise();
  await new Promise((r) => setImmediate(r));
  assert.equal(lastCode('d-hit').data.code, null, 'the QR is taken off the alert');
  assert.equal(share.currentCode('d-hit'), null);
  await share.pushCode('d-hit');
  assert.equal(lastCode('d-hit').data.code, null, 'and stays off while the alert is live');
  clear();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(lastCode('d-hit').data.code, 'the code is back after the alert');
});
