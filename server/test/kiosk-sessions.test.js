'use strict';

// #473 v2: interactive web pages report visitor sessions (usage counts) and load failures
// (dashboard incidents). The player queues sessions and drops one only when the server acks its id,
// so the properties pinned here are: every well-formed id is acked (or the queue wedges), a resent
// batch is not counted twice, a session can't be attributed to another workspace's widget, and the
// report reads only the caller's workspace.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-kiosk-sessions-'));
process.env.DATA_DIR = tmp;

const { db } = require('../db/database');
const deviceSocket = require('../ws/deviceSocket');
const incident = require('../lib/incident-classify');

const now = Math.floor(Date.now() / 1000);
db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u-k', 'kiosk@test', 'K', 'platform_admin')").run();
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-k', 'K', 'u-k')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('ws-a', 'org-k', 'A'), ('ws-b', 'org-k', 'B')").run();
db.prepare("INSERT INTO devices (id,name,status,workspace_id,created_at) VALUES ('dev-a','A1','online','ws-a',strftime('%s','now'))").run();
db.prepare("INSERT INTO devices (id,name,status,workspace_id,created_at) VALUES ('dev-b','B1','online','ws-b',strftime('%s','now'))").run();
db.prepare("INSERT INTO widgets (id, widget_type, name, config, workspace_id) VALUES ('w-a','webpage','Shop A','{}','ws-a')").run();
db.prepare("INSERT INTO widgets (id, widget_type, name, config, workspace_id) VALUES ('w-b','webpage','Shop B','{}','ws-b')").run();

function send(deviceId, sessions) {
  const replies = [];
  const r = deviceSocket.applyPlayerEvent('kiosk-sessions', deviceId, { device_id: deviceId, sessions },
    { reply: (event, payload) => replies.push({ event, payload }), session: {} });
  assert.equal(r.ok, true);
  return replies;
}
const rec = (id, extra = {}) => ({ id, widget_id: 'w-a', started_at: now - 3600, duration_sec: 95, end_reason: 'idle', pages: 4, ...extra });
const rows = (dev) => db.prepare('SELECT * FROM kiosk_sessions WHERE device_id = ? ORDER BY client_id').all(dev);

test('sessions are stored once and every well-formed id is acked', () => {
  let replies = send('dev-a', [rec('s1'), rec('s2', { end_reason: 'error' })]);
  assert.deepEqual(replies, [{ event: 'device:kiosk-sessions-ack', payload: { ids: ['s1', 's2'], written: 2 } }]);
  // The ack was lost and the player resends: acked again, counted once.
  replies = send('dev-a', [rec('s1'), rec('s2')]);
  assert.deepEqual(replies[0].payload, { ids: ['s1', 's2'], written: 0 });
  const r = rows('dev-a');
  assert.equal(r.length, 2);
  assert.equal(r[0].workspace_id, 'ws-a');
  assert.equal(r[0].widget_id, 'w-a');
  assert.equal(r[0].duration_sec, 95);
  assert.equal(r[1].end_reason, 'error');
});

test('THE_BUG_ a malformed record is acked and dropped, never left to wedge the queue', () => {
  const replies = send('dev-a', [rec('bad-time', { started_at: 'yesterday' }), rec('far-future', { started_at: now + 10 * 86400 }), { nope: 1 }, rec('ok-3')]);
  assert.deepEqual(replies[0].payload.ids, ['bad-time', 'far-future', 'ok-3']);
  assert.equal(replies[0].payload.written, 1);
  assert.ok(!rows('dev-a').some((x) => x.client_id === 'bad-time' || x.client_id === 'far-future'));
});

test('values are clamped and an unknown end reason reads as interrupted', () => {
  send('dev-a', [rec('clamp', { duration_sec: 999999, pages: -3, end_reason: 'rm -rf' })]);
  const r = rows('dev-a').find((x) => x.client_id === 'clamp');
  assert.equal(r.duration_sec, 86400);
  assert.equal(r.pages, 1);
  assert.equal(r.end_reason, 'interrupted');
});

test("THE_BUG_ a session cannot be attributed to another workspace's widget", () => {
  send('dev-b', [rec('cross', { widget_id: 'w-a' }), rec('own', { widget_id: 'w-b' })]);
  const r = rows('dev-b');
  assert.equal(r.find((x) => x.client_id === 'cross').widget_id, null);
  assert.equal(r.find((x) => x.client_id === 'own').widget_id, 'w-b');
  assert.ok(r.every((x) => x.workspace_id === 'ws-b'));
});

test('the new kind is relayable from a replica like every other report', () => {
  assert.ok(deviceSocket.PLAYER_EVENT_KINDS.includes('kiosk-sessions'));
});

test('web_error is an accepted incident type and lands in device_events', () => {
  assert.equal(incident.isAllowedEventType('web_error'), true);
  deviceSocket.applyPlayerEvent('event', 'dev-a', { device_id: 'dev-a', type: 'web_error', reason: 'load_error', detail: 'shop.example: load error -2' }, { reply() {}, session: {} });
  const ev = db.prepare("SELECT * FROM device_events WHERE device_id = 'dev-a' AND type = 'web_error'").get();
  assert.equal(ev.reason, 'load_error');
  assert.match(ev.detail, /shop\.example/);
});

let server;
after(() => { if (server) server.close(); });

async function report(workspaceId, qs = '') {
  if (!server) {
    const express = require('express');
    const app = express();
    app.use((req, _res, next) => { req.workspaceId = req.headers['x-ws'] || null; next(); });
    app.use('/api/reports', require('../routes/reports'));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
  }
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/reports/kiosk-sessions${qs}`, { headers: workspaceId ? { 'x-ws': workspaceId } : {} });
  return { status: res.status, body: await res.json() };
}

test('the report counts per widget and per day, for the caller workspace only', async () => {
  const { status, body } = await report('ws-a');
  assert.equal(status, 200);
  const stored = rows('dev-a').length;
  assert.equal(body.overall.sessions, stored);
  const shop = body.by_widget.find((w) => w.widget_id === 'w-a');
  assert.equal(shop.widget_name, 'Shop A');
  assert.equal(shop.ended_by_error, 1);
  assert.ok(shop.sessions_per_day > 0);
  assert.equal(body.by_day.reduce((n, d) => n + d.sessions, 0), stored);
  assert.ok(!body.by_widget.some((w) => w.widget_id === 'w-b'), 'workspace B never appears in A');

  const b = await report('ws-b');
  assert.equal(b.body.overall.sessions, 2);
  const none = await report(null);
  assert.equal(none.body.overall.sessions, 0);
});

test('the report honours the range and refuses a bad date', async () => {
  const old = await report('ws-a', '?start=2001-01-01&end=2001-01-31');
  assert.equal(old.body.overall.sessions, 0);
  const bad = await report('ws-a', '?start=not-a-date');
  assert.equal(bad.status, 400);
});
