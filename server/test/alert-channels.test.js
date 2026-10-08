'use strict';

/*
 * Alert channels (lib/alert-channels.js, routes/alert-channels.js).
 *
 *   - credentials (webhook URLs, PagerDuty keys, webhook secrets) are never returned whole
 *   - each service gets the message shape it accepts; PagerDuty resolves with the same dedup key
 *   - ONE offline alert per outage per channel; a recovery only after an offline alert went out
 *   - failures retry, then stop; a screen outside the channel's scope is never mentioned
 *   - a webhook to a private address is refused by the SSRF guard
 */

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-alertch-' + crypto.randomBytes(4).toString('hex'));
process.env.JWT_SECRET = 'test-secret-alertch';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const ch = require('../lib/alert-channels');

const SLACK = 'https://hooks.slack.com/services/T000/B000/abcdefSECRETxyz9';
const PD_KEY = 'R0abcdefghijklmnopqrstuvwxyz1234';

test('input: kinds, https only, Slack host, PagerDuty key shape, email list', () => {
  assert.match(ch.normaliseInput({ kind: 'fax', name: 'x' }).error, /kind/);
  assert.match(ch.normaliseInput({ kind: 'slack', name: 'x', url: 'http://hooks.slack.com/x' }).error, /https/);
  assert.match(ch.normaliseInput({ kind: 'slack', name: 'x', url: 'https://evil.example/x' }).error, /hooks\.slack\.com/);
  assert.match(ch.normaliseInput({ kind: 'pagerduty', name: 'x', routing_key: 'short' }).error, /32 letters/);
  assert.match(ch.normaliseInput({ kind: 'email', name: 'x', emails: 'a@b.co, nope' }).error, /nope/);
  const ok = ch.normaliseInput({ kind: 'email', name: 'Ops', emails: 'Ops@Example.com; ops@example.com b@c.io' });
  assert.deepEqual(JSON.parse(ok.fields.config).emails, ['ops@example.com', 'b@c.io']);
  assert.match(ch.normaliseInput({ kind: 'teams', name: 'x', url: 'https://u:p@x.example/y' }).error, /username/);
});

test('an update with the secret left empty keeps the stored one', () => {
  const existing = { kind: 'webhook', config: JSON.stringify({ url: 'https://hooks.example.org/a', secret: 's3cret' }) };
  const r = ch.normaliseInput({ name: 'Renamed', url: '' }, existing);
  assert.equal(r.error, undefined);
  assert.deepEqual(JSON.parse(r.fields.config), { url: 'https://hooks.example.org/a', secret: 's3cret' });
});

test('message shapes: Slack, Teams, PagerDuty trigger/resolve, signed webhook', () => {
  const device = { id: 'd1', name: 'Lobby' };
  const base = { device, minutes: 7, workspace: { name: 'Store 1' }, dashboardUrl: 'https://st.example', dedupKey: 'k1', nowIso: '2026-10-08T12:00:00.000Z' };
  const slack = ch.buildMessage({ kind: 'slack', config: JSON.stringify({ url: SLACK }) }, { ...base, event: 'device_offline' });
  assert.equal(slack.url, SLACK);
  assert.match(slack.body.text, /Offline: Lobby/);
  assert.match(slack.body.blocks[0].text.text, /offline for 7 minutes[\s\S]*Store 1[\s\S]*https:\/\/st\.example\/app#\/device\/d1/);

  const teams = ch.buildMessage({ kind: 'teams', config: JSON.stringify({ url: 'https://x.webhook.office.com/a' }) }, { ...base, event: 'device_online' });
  const card = teams.body.attachments[0];
  assert.equal(card.contentType, 'application/vnd.microsoft.card.adaptive');
  assert.match(card.content.body[0].text, /Back online: Lobby/);
  assert.equal(card.content.body[0].color, 'Good');

  const pdOn = ch.buildMessage({ kind: 'pagerduty', config: JSON.stringify({ routing_key: PD_KEY }) }, { ...base, event: 'device_offline' });
  assert.equal(pdOn.url, 'https://events.pagerduty.com/v2/enqueue');
  assert.equal(pdOn.body.event_action, 'trigger'); assert.equal(pdOn.body.dedup_key, 'k1');
  assert.equal(pdOn.body.payload.severity, 'error');
  const pdOff = ch.buildMessage({ kind: 'pagerduty', config: JSON.stringify({ routing_key: PD_KEY }) }, { ...base, event: 'device_online' });
  assert.deepEqual(pdOff.body, { routing_key: PD_KEY, event_action: 'resolve', dedup_key: 'k1' }, 'the same key resolves the incident');

  const wh = ch.buildMessage({ kind: 'webhook', config: JSON.stringify({ url: 'https://hooks.example.org/a', secret: 'shh' }) }, { ...base, event: 'device_offline' });
  const ts = wh.headers['X-ScreenTinker-Timestamp'];
  const expect = 'sha256=' + crypto.createHmac('sha256', 'shh').update(`${ts}.${wh.raw}`).digest('hex');
  assert.equal(wh.headers['X-ScreenTinker-Signature'], expect, 'a receiver can verify the signature');
  assert.equal(JSON.parse(wh.raw).device.name, 'Lobby');
});

/* ── the tick, against a fake sender ───────────────────────────────────────────────── */

const O = 'o-ac', WS = 'ws-ac', ADMIN = 'u-ac-admin', EDITOR = 'u-ac-ed', G = 'g-ac';
let sent = [];
let failNext = 0;
const NOW = 2_000_000_000;

function mkDevice(id, status, lastHb) {
  db.prepare(`INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, status, last_heartbeat) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, ADMIN, WS, id, crypto.randomUUID().slice(0, 6), status, lastHb);
}
function mkChannel(id, kind, config, { events = ['device_offline', 'device_online'], minutes = 5, scopes = [{ scope_kind: 'workspace', scope_id: WS }] } = {}) {
  db.prepare('INSERT INTO alert_channels (id, workspace_id, kind, name, config, events, offline_minutes) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, WS, kind, id, JSON.stringify(config), JSON.stringify(events), minutes);
  ch.setScopes(db, id, scopes);
}
const tick = (now = NOW) => ch.tick({ db, now });

let server, base;
before(async () => {
  db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, 'acadmin@t.local', 'x', 'user'), (?, 'aced@t.local', 'x', 'user')").run(ADMIN, EDITOR);
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(O, 'Org', ADMIN);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(WS, O, 'Store 1');
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin'), (?, ?, 'workspace_editor')").run(WS, ADMIN, WS, EDITOR);
  db.prepare('INSERT INTO device_groups (id, name, user_id, workspace_id) VALUES (?, ?, ?, ?)').run(G, 'Tills', ADMIN, WS);
  ch._setSender(async (msg) => { if (failNext > 0) { failNext--; return { ok: false, error: 'The service answered HTTP 500.' }; } sent.push(msg); return { ok: true }; });
  const app = express();
  app.use(express.json());
  app.use('/api/alert-channels', requireAuth, resolveTenancy, require('../routes/alert-channels'));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { ch._setSender(null); try { server.close(); } catch { /* */ } });

test('one offline alert per outage, none before the threshold, a recovery after it', async () => {
  mkChannel('c-pd', 'pagerduty', { routing_key: PD_KEY });
  mkDevice('d-a', 'offline', NOW - 4 * 60);           // 4 min: under the 5 min threshold
  sent = [];
  await tick();
  assert.equal(sent.length, 0);
  await tick(NOW + 2 * 60);                            // now 6 min dark
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.event_action, 'trigger');
  const key = sent[0].body.dedup_key;
  await tick(NOW + 5 * 60);
  assert.equal(sent.length, 1, 'never twice for one outage');

  db.prepare("UPDATE devices SET status = 'online', last_heartbeat = ? WHERE id = 'd-a'").run(NOW + 9 * 60);
  await tick(NOW + 10 * 60);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].body, { routing_key: PD_KEY, event_action: 'resolve', dedup_key: key }, 'the incident resolves itself');
  await tick(NOW + 11 * 60);
  assert.equal(sent.length, 2, 'and the recovery is sent once');

  // A new outage is a new alert.
  db.prepare("UPDATE devices SET status = 'offline' WHERE id = 'd-a'").run();
  await tick(NOW + 20 * 60);
  assert.equal(sent.length, 3);
  assert.notEqual(sent[2].body.dedup_key, key);
  db.prepare("DELETE FROM alert_channels WHERE id = 'c-pd'").run();
  db.prepare("DELETE FROM devices WHERE id = 'd-a'").run();
});

test('a recovery is never sent for an outage that was never alerted', async () => {
  mkChannel('c-on', 'slack', { url: SLACK }, { events: ['device_online'] });
  mkDevice('d-b', 'online', NOW);
  sent = [];
  await tick();
  assert.equal(sent.length, 0);
  db.prepare("DELETE FROM alert_channels WHERE id = 'c-on'").run();
  db.prepare("DELETE FROM devices WHERE id = 'd-b'").run();
});

test('scope: a group-scoped channel ignores screens outside the group', async () => {
  mkDevice('d-in', 'offline', NOW - 600);
  mkDevice('d-out', 'offline', NOW - 600);
  db.prepare('INSERT INTO device_group_members (group_id, device_id) VALUES (?, ?)').run(G, 'd-in');
  mkChannel('c-grp', 'slack', { url: SLACK }, { scopes: [{ scope_kind: 'group', scope_id: G }] });
  sent = [];
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0].body.text, /d-in/);
  db.prepare("DELETE FROM alert_channels WHERE id = 'c-grp'").run();
});

test('a failed delivery is retried, recorded, then given up after three attempts', async () => {
  mkChannel('c-fail', 'slack', { url: SLACK });
  sent = []; failNext = 99;
  for (let i = 0; i < 5; i++) await tick(NOW + i * 60);
  failNext = 0;
  const row = db.prepare("SELECT * FROM alert_deliveries WHERE channel_id = 'c-fail' AND device_id = 'd-in'").get();
  assert.equal(row.attempts, 3);
  assert.equal(row.offline_sent_at, null);
  assert.equal(db.prepare("SELECT last_error FROM alert_channels WHERE id = 'c-fail'").get().last_error, 'The service answered HTTP 500.');
  await tick(NOW + 10 * 60);
  assert.equal(sent.filter((m) => /d-in/.test(m.body.text)).length, 0, 'no fourth attempt');
  db.prepare("DELETE FROM alert_channels WHERE id = 'c-fail'").run();
});

/* ── routes ─────────────────────────────────────────────────────────────────────────── */

const tokenOf = (u) => generateToken(db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(u), WS);
async function api(method, p, body, who = ADMIN) {
  const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${tokenOf(who)}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, text };
}

test('routes: admin only for changes; credentials never come back whole', async () => {
  let r = await api('POST', '/api/alert-channels', { kind: 'slack', name: 'Ops', url: SLACK }, EDITOR);
  assert.equal(r.status, 403); assert.equal(r.body.code, 'ALERTS_ADMIN_REQUIRED');
  r = await api('POST', '/api/alert-channels', { kind: 'slack', name: 'Ops', url: SLACK });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.id;
  assert.deepEqual(r.body.scopes, [{ scope_kind: 'workspace', scope_id: WS }]);
  assert.ok(!r.text.includes('SECRETxyz9') && !r.text.includes('B000'), 'the webhook URL is masked');
  assert.match(r.body.url_hint, /^https:\/\/hooks\.slack\.com\/…xyz9$/);
  const list = await api('GET', '/api/alert-channels', null, EDITOR);
  assert.equal(list.status, 200);
  assert.ok(!list.text.includes('SECRETxyz9'));

  r = await api('POST', '/api/alert-channels', { kind: 'pagerduty', name: 'On call', routing_key: PD_KEY });
  assert.ok(!r.text.includes(PD_KEY)); assert.equal(r.body.routing_key_hint, '…1234');

  r = await api('PUT', `/api/alert-channels/${id}`, { name: 'Ops team', url: '' });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(db.prepare('SELECT config FROM alert_channels WHERE id = ?').get(id).config).url, SLACK, 'an empty URL keeps the stored one');

  sent = [];
  r = await api('POST', `/api/alert-channels/${id}/test`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(sent[0].body.text, /test alert/i);
  assert.equal((await api('DELETE', `/api/alert-channels/${id}`)).status, 200);
});

test('a webhook pointing at a private address is refused by the SSRF guard, and the URL is not in the error', async () => {
  ch._setSender(null);
  try {
    const r = await ch.deliver({ kind: 'http', url: 'https://127.0.0.1:9/hook-secret-path', body: { a: 1 } });
    assert.equal(r.ok, false);
    assert.ok(!String(r.error).includes('hook-secret-path'));
  } finally {
    ch._setSender(async (msg) => { sent.push(msg); return { ok: true }; });
  }
});
