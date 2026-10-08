'use strict';

/*
 * Automation event delivery (lib/automation/events.js), in process against a migrated database.
 *
 * The real sender goes through the SSRF guard, which (rightly) refuses loopback, so the receiver
 * here is the module's own test seam (_setSender) answering as a receiver would.
 *
 * What has to hold:
 *   - one queued delivery per subscriber per event, signed so a receiver can verify it
 *   - a failure retries with backoff, then stops and is kept for the log
 *   - 410 Gone unsubscribes (Zapier's REST-hook contract) and nothing more is sent to it
 *   - screen online/offline is announced on a CHANGE, never for the state a screen was first seen in
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = path.join(os.tmpdir(), 'st-automation-ev-' + crypto.randomBytes(4).toString('hex'));
const { db } = require('../db/database');
const ev = require('../lib/automation/events');
const secretbox = require('../lib/secretbox');

let WS, USER, T = 1_800_000_000;
const sent = [];
let answer = () => ({ status: 200 });

before(() => {
  ev._setClock(() => T);
  ev._setSender(async (m) => { sent.push(m); return answer(m); });
  USER = crypto.randomUUID();
  db.prepare("INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, 'U', 'x', 'user')").run(USER, `${USER}@example.test`);
  const org = crypto.randomUUID();
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(org, 'Org', USER);
  WS = crypto.randomUUID();
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(WS, org, 'WS');
});

function subscribe(event, secret = 'receiver-secret') {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO automation_subscriptions (id, workspace_id, event, target_url, secret_enc) VALUES (?, ?, ?, ?, ?)')
    .run(id, WS, event, `https://hooks.example.test/${id}`, secretbox.encrypt(secret));
  return id;
}

test('a delivery is queued once per subscriber and signed', async () => {
  const a = subscribe('emergency_raised');
  const b = subscribe('emergency_raised', 'other-secret');
  subscribe('device_online');
  const id = ev.emit(db, WS, 'emergency_raised', { headline: 'Fire' });
  assert.ok(id);
  assert.equal(ev.emit(db, WS, 'not_an_event', {}), null, 'unknown events are not recorded');
  sent.length = 0;
  const r = await ev.deliverDue(db);
  assert.equal(r.ok, 2);
  assert.equal(sent.length, 2);
  const m = sent.find((x) => x.url.endsWith(a));
  const body = JSON.parse(m.body);
  assert.equal(body.event, 'emergency_raised');
  assert.equal(body.headline, 'Fire');
  assert.equal(body.id, String(id));
  const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(m.headers['X-ScreenTinker-Signature']);
  assert.equal(v1, crypto.createHmac('sha256', 'receiver-secret').update(`${t}.${m.body}`).digest('hex'));
  assert.notEqual(sent.find((x) => x.url.endsWith(b)).headers['X-ScreenTinker-Signature'], m.headers['X-ScreenTinker-Signature']);
  sent.length = 0;
  assert.equal((await ev.deliverDue(db)).ok, 0, 'delivered once');
  for (const s of [a, b]) db.prepare('DELETE FROM automation_subscriptions WHERE id = ?').run(s);
});

test('a failing receiver is retried with backoff, then the delivery is kept as failed', async () => {
  const s = subscribe('content_approved');
  answer = () => ({ status: 500 });
  ev.emit(db, WS, 'content_approved', { name: 'Menu' });
  const tries = [];
  for (const wait of [0, 60, 300, 1800, 7200]) {
    T += wait;
    sent.length = 0;
    await ev.deliverDue(db);
    tries.push(sent.length);
    T += 1;
    sent.length = 0;
    await ev.deliverDue(db);
    assert.equal(sent.length, 0, 'nothing before the next backoff step');
  }
  assert.deepEqual(tries, [1, 1, 1, 1, 1]);
  const d = db.prepare('SELECT * FROM automation_deliveries WHERE subscription_id = ?').get(s);
  assert.equal(d.status, 'failed');
  assert.equal(d.attempts, 5);
  assert.match(d.last_error, /HTTP 500/);
  T += 10000;
  sent.length = 0;
  await ev.deliverDue(db);
  assert.equal(sent.length, 0, 'a failed delivery is not retried forever');
  answer = () => ({ status: 200 });
});

test('410 Gone unsubscribes, and nothing more is sent to that receiver', async () => {
  const s = subscribe('playlist_published');
  answer = () => ({ status: 410 });
  ev.emit(db, WS, 'playlist_published', { playlist_name: 'A' });
  ev.emit(db, WS, 'playlist_published', { playlist_name: 'B' });
  sent.length = 0;
  const r = await ev.deliverDue(db);
  assert.equal(sent.length, 1, 'the second delivery is cancelled, not sent');
  assert.equal(r.gone, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM automation_subscriptions WHERE id = ?').get(s).n, 0);
  answer = () => ({ status: 200 });
  ev.emit(db, WS, 'playlist_published', { playlist_name: 'C' });
  sent.length = 0;
  await ev.deliverDue(db);
  assert.equal(sent.length, 0);
});

test('screen online/offline is announced on a change only', async () => {
  subscribe('device_offline');
  const dev = crypto.randomUUID();
  db.prepare("INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, status) VALUES (?, ?, ?, 'Lobby', ?, 'offline')")
    .run(dev, USER, WS, crypto.randomUUID().slice(0, 6));
  const count = (t) => db.prepare('SELECT COUNT(*) AS n FROM automation_events WHERE workspace_id = ? AND type = ?').get(WS, t).n;
  const before = { off: count('device_offline'), on: count('device_online') };
  ev.deviceStateTick(db);
  assert.equal(count('device_offline'), before.off, 'first sighting is recorded, not announced');
  db.prepare("UPDATE devices SET status = 'online' WHERE id = ?").run(dev);
  ev.deviceStateTick(db);
  ev.deviceStateTick(db);
  assert.equal(count('device_online'), before.on + 1);
  db.prepare("UPDATE devices SET status = 'offline' WHERE id = ?").run(dev);
  ev.deviceStateTick(db);
  assert.equal(count('device_offline'), before.off + 1);
  const last = ev.recent(db, WS, 'device_offline', 1)[0];
  assert.equal(last.device_name, 'Lobby');
});
