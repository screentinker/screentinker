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
  // Deliveries to one subscription go one at a time, so the 410 has already failed the second one
  // ("unsubscribed") by the time its turn comes, and it is skipped rather than attempted.
  assert.equal(r.gone, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM automation_deliveries WHERE subscription_id = ? AND status = 'failed' AND last_error LIKE '%410%'").get(s).n, 2);
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

test('delivery is concurrent and fair: one workspace with dead receivers cannot hold back another', async () => {
  const org2 = crypto.randomUUID();
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(org2, 'Org2', USER);
  const WS2 = crypto.randomUUID();
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(WS2, org2, 'WS2');
  db.prepare("UPDATE automation_deliveries SET status = 'failed' WHERE status = 'pending'").run();
  // Workspace 1: 40 subscribers on a receiver that never answers (until released).
  const dead = [];
  for (let i = 0; i < 40; i++) {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO automation_subscriptions (id, workspace_id, event, target_url) VALUES (?, ?, ?, ?)')
      .run(id, WS, 'emergency_cleared', `https://dead${i % 2}.example.test/${id}`);
    dead.push(id);
  }
  // Workspace 2: one subscriber that answers at once, queued AFTER all of workspace 1's.
  const live = crypto.randomUUID();
  db.prepare('INSERT INTO automation_subscriptions (id, workspace_id, event, target_url) VALUES (?, ?, ?, ?)')
    .run(live, WS2, 'emergency_cleared', `https://alive.example.test/${live}`);
  ev.emit(db, WS, 'emergency_cleared', { headline: 'one' });
  ev.emit(db, WS2, 'emergency_cleared', { headline: 'two' });

  let release;
  const gate = new Promise((r) => { release = r; });
  const running = { all: 0, max: 0, ws1: 0, maxWs1: 0, hosts: new Map(), maxHost: 0 };
  let liveSentWhileStuck = false;
  ev._setSender(async (m) => {
    const host = new URL(m.url).host;
    if (host === 'alive.example.test') { liveSentWhileStuck = running.ws1 > 0; return { status: 200 }; }
    running.all++; running.ws1++;
    running.hosts.set(host, (running.hosts.get(host) || 0) + 1);
    running.max = Math.max(running.max, running.all);
    running.maxWs1 = Math.max(running.maxWs1, running.ws1);
    running.maxHost = Math.max(running.maxHost, running.hosts.get(host));
    await gate;
    running.all--; running.ws1--; running.hosts.set(host, running.hosts.get(host) - 1);
    return { status: 200 };
  });
  const done = ev.deliverDue(db);
  // Let the scheduler start what fits; workspace 2 must not wait for workspace 1's receivers.
  for (let i = 0; i < 20 && !liveSentWhileStuck; i++) await new Promise((r) => setImmediate(r));
  assert.ok(liveSentWhileStuck, 'workspace 2 was delivered while workspace 1 was stuck');
  assert.ok(running.maxWs1 <= ev.PER_WORKSPACE, `at most ${ev.PER_WORKSPACE} at once for one workspace (saw ${running.maxWs1})`);
  // A second tick runs beside the first, and never sends what the first has in flight.
  const second = await ev.deliverDue(db);
  assert.equal(second.ok, 0);
  release();
  const r = await done;
  assert.equal(r.ok, 41, 'everything is delivered in the end');
  assert.ok(running.maxWs1 <= ev.PER_WORKSPACE);
  assert.ok(running.maxHost <= ev.PER_HOST);
  assert.ok(running.max <= ev.MAX_CONCURRENT);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM automation_deliveries WHERE status = 'ok' AND subscription_id IN (SELECT id FROM automation_subscriptions WHERE event = 'emergency_cleared')").get().n, 41, 'each sent exactly once');
  ev._setSender(async (m) => { sent.push(m); return answer(m); });
});

test('fairOrder takes turns between workspaces', () => {
  const rows = [...Array(5)].map((_, i) => ({ id: i, ws: 'a' })).concat([{ id: 9, ws: 'b' }, { id: 10, ws: 'c' }]);
  assert.deepEqual(ev.fairOrder(rows).map((r) => r.id), [0, 9, 10, 1, 2, 3, 4]);
});
