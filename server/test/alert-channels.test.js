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

/* ── Telegram ───────────────────────────────────────────────────────────────────────── */

// ⚠️ Telegram puts the bot token in the URL PATH, so every test below also checks it never leaks.
const TG_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawZ';
const TG_SECRET_PART = 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawZ';
const TG_URL = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
const tgChannel = (extra = {}) => ({ id: 'c-tg', kind: 'telegram', workspace_id: WS, config: JSON.stringify({ bot_token: TG_TOKEN, chat_id: '-1001234567890', ...extra }) });

/** Run fn with console.* captured; returns everything printed. */
async function captureOutput(fn) {
  const out = [];
  const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  const grab = (...a) => { out.push(a.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
  console.log = console.error = console.warn = console.info = console.debug = grab;
  try { await fn(); } finally {
    Object.assign(console, saved);
  }
  return out.join('\n');
}

/** Deliver through a stubbed transport (never the network); `answer(url, opts)` plays Telegram. */
async function viaTransport(answer, fn) {
  const calls = [];
  ch._setSender(null);
  ch._setTransport(async (url, opts) => { calls.push({ url, opts }); return answer(url, opts); });
  try { await fn(calls); } finally {
    ch._setTransport(null);
    ch._setSender(async (msg) => { if (failNext > 0) { failNext--; return { ok: false, error: 'The service answered HTTP 500.' }; } sent.push(msg); return { ok: true }; });
  }
}

test('telegram input: token and chat id shapes, the token never echoed, kept on edit', () => {
  assert.ok(ch.KINDS.includes('telegram'));
  assert.match(ch.normaliseInput({ kind: 'telegram', name: 'x', chat_id: '42' }).error, /bot token/);
  for (const bad of ['nope', '12345:short', 'abc:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawZ', `${TG_TOKEN} x`, '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALD$awZ']) {
    const r = ch.normaliseInput({ kind: 'telegram', name: 'x', bot_token: bad, chat_id: '42' });
    assert.match(r.error, /bot token looks like/, bad);
    assert.ok(!r.error.includes(bad), 'a rejected token is not repeated back');
  }
  assert.match(ch.normaliseInput({ kind: 'telegram', name: 'x', bot_token: TG_TOKEN }).error, /chat ID/);
  for (const bad of ['abc', '12a', '@', '@x', '--100', '1 2', '@bad-name', 'https://t.me/x']) {
    assert.match(ch.normaliseInput({ kind: 'telegram', name: 'x', bot_token: TG_TOKEN, chat_id: bad }).error, /chat ID is a number/, bad);
  }
  for (const good of ['42', '-4242', '-1001234567890', '@my_channel']) {
    const r = ch.normaliseInput({ kind: 'telegram', name: 'x', bot_token: ` ${TG_TOKEN} `, chat_id: good });
    assert.equal(r.error, undefined, good);
    assert.deepEqual(JSON.parse(r.fields.config), { bot_token: TG_TOKEN, chat_id: good });
  }
  const existing = { kind: 'telegram', config: JSON.stringify({ bot_token: TG_TOKEN, chat_id: '-4242' }) };
  const kept = ch.normaliseInput({ name: 'Renamed', bot_token: '', chat_id: '' }, existing);
  assert.equal(kept.error, undefined);
  assert.deepEqual(JSON.parse(kept.fields.config), { bot_token: TG_TOKEN, chat_id: '-4242' }, 'empty fields keep the stored token and chat');
  const moved = ch.normaliseInput({ chat_id: '@ops_room' }, existing);
  assert.deepEqual(JSON.parse(moved.fields.config), { bot_token: TG_TOKEN, chat_id: '@ops_room' }, 'a new chat keeps the token');
});

test('telegram present(): a hint and the chat id, never the token', () => {
  const p = ch.present(db, { ...tgChannel(), name: 'TG', enabled: 1, events: '[]', offline_minutes: 5 });
  assert.equal(p.bot_token_hint, '…sawZ');
  assert.equal(p.chat_id, '-1001234567890');
  const text = JSON.stringify(p);
  assert.ok(!text.includes(TG_SECRET_PART) && !text.includes('123456789:'), 'no part of the token beyond the hint');
});

test('telegram message: sendMessage with HTML, dynamic parts escaped, link and workspace', () => {
  const device = { id: 'd1', name: 'Lobby <b>&</b> "Bar"' };
  const base = { device, minutes: 7, workspace: { name: 'Store <1> & co' }, dashboardUrl: 'https://st.example', dedupKey: 'k1', nowIso: '2026-10-08T12:00:00.000Z' };
  const m = ch.buildMessage(tgChannel(), { ...base, event: 'device_offline' });
  assert.equal(m.url, TG_URL);
  assert.equal(m.service, 'telegram');
  assert.equal(m.body.chat_id, '-1001234567890');
  assert.equal(m.body.parse_mode, 'HTML');
  assert.equal(m.body.disable_web_page_preview, true);
  const t = m.body.text;
  assert.match(t, /<b>Offline: Lobby &lt;b&gt;&amp;&lt;\/b&gt; &quot;Bar&quot;<\/b>/, 'the title is bold and its HTML escaped');
  assert.match(t, /has been offline for 7 minutes/);
  assert.match(t, /<i>Store &lt;1&gt; &amp; co<\/i>/);
  assert.match(t, /<a href="https:\/\/st\.example\/app#\/device\/d1">Open in ScreenTinker<\/a>/);
  assert.ok(!/<(?!\/?(b|i|a)[ >])/.test(t), 'no tag but the ones we wrote');

  const problem = ch.buildMessage(tgChannel(), { ...base, device: { id: 'd1', name: 'Lobby' }, event: 'screen_problem', check: 'frozen' });
  assert.match(problem.body.text, /^\u{1F7E1} <b>Frozen screen: Lobby<\/b>\nThe screen &quot;Lobby&quot; appears frozen/u, 'the check is named, as a warning');
  const back = ch.buildMessage(tgChannel(), { ...base, event: 'device_online' });
  assert.match(back.body.text, /Back online/);
  const test = ch.buildMessage(tgChannel(), { event: 'test', device: null, workspace: { name: 'Store 1' }, dashboardUrl: null, nowIso: base.nowIso });
  assert.match(test.body.text, /<b>ScreenTinker test alert<\/b>/);
  assert.ok(!test.body.text.includes('<a '), 'no device, no link');
});

test('telegram send: the right URL and body through the guarded transport, never the network', async () => {
  await viaTransport(() => ({ statusCode: 200, text: JSON.stringify({ ok: true, result: { message_id: 1 } }) }), async (calls) => {
    const r = await ch.sendTest(db, { ...tgChannel(), name: 'TG' });
    assert.deepEqual(r, { ok: true });
    assert.equal(calls.length, 1, 'one request, and no PagerDuty-style follow-up');
    assert.equal(calls[0].url, TG_URL);
    const o = calls[0].opts;
    assert.equal(o.method, 'POST');
    assert.equal(o.maxRedirects, 0);
    assert.equal(o.acceptAnyStatus, true, 'a 4xx body is read, so Telegram can say why');
    assert.equal(o.headers['Content-Type'], 'application/json');
    const body = JSON.parse(o.body);
    assert.equal(body.chat_id, '-1001234567890');
    assert.equal(body.parse_mode, 'HTML');
    assert.match(body.text, /test alert/i);
  });
});

test('telegram failures: 429 retry_after and ok:false descriptions are reported, without the token', async () => {
  const answers = [
    [{ statusCode: 429, text: JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 17', parameters: { retry_after: 17 } }) },
      (r) => { assert.equal(r.rateLimited, true); assert.match(r.error, /429.*wait 17 s/); }],
    [{ statusCode: 400, text: JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }) },
      (r) => { assert.equal(r.error, 'Telegram refused the message: Bad Request: chat not found'); assert.equal(r.rateLimited, undefined); }],
    [{ statusCode: 401, text: JSON.stringify({ ok: false, error_code: 401, description: `Unauthorized: bot${TG_TOKEN} is not valid` }) },
      (r) => { assert.match(r.error, /^Telegram refused the message: Unauthorized: bot… is not valid$/); }],
    [{ statusCode: 400, text: JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: group chat was upgraded to a supergroup chat', parameters: { migrate_to_chat_id: -1009876543210 } }) },
      (r) => { assert.match(r.error, /supergroup\. Change the chat ID to -1009876543210\./); }],
    [{ statusCode: 200, text: JSON.stringify({ ok: false }) }, (r) => { assert.equal(r.error, 'Telegram did not accept the message.'); }],
    [{ statusCode: 502, text: '<html>Bad gateway</html>' }, (r) => { assert.equal(r.error, 'The service answered HTTP 502.'); }],
  ];
  for (const [res, check] of answers) {
    await viaTransport(() => res, async () => {
      const r = await ch.deliver(ch.buildMessage(tgChannel(), { event: 'test', device: null, workspace: { name: 'W' }, nowIso: '2026-10-08T12:00:00.000Z' }));
      assert.equal(r.ok, false);
      check(r);
      assert.ok(!JSON.stringify(r).includes(TG_SECRET_PART));
    });
  }
});

test('the token never appears in logs, errors, last_error, API responses or the activity log', async () => {
  // A transport that fails the way Node does, with the whole URL in the message and the stack.
  const boom = (url) => { const e = new Error(`connect ECONNREFUSED while requesting ${url}`); e.url = url; throw e; };
  let createdId;
  const printed = await captureOutput(async () => {
    await viaTransport(boom, async () => {
      const r = await ch.deliver(ch.buildMessage(tgChannel(), { event: 'test', device: null, workspace: { name: 'W' }, nowIso: '2026-10-08T12:00:00.000Z' }));
      assert.deepEqual(r, { ok: false, error: 'The service could not be reached.' });
      // Through the routes: create, list, a failing test send (502), an edit.
      let res = await api('POST', '/api/alert-channels', { kind: 'telegram', name: 'TG', bot_token: TG_TOKEN, chat_id: '-4242' });
      assert.equal(res.status, 201, res.text);
      createdId = res.body.id;
      assert.equal(res.body.bot_token_hint, '…sawZ'); assert.equal(res.body.chat_id, '-4242');
      for (const t of [res.text, (await api('GET', '/api/alert-channels', null, EDITOR)).text]) assert.ok(!t.includes(TG_SECRET_PART));
      res = await api('POST', `/api/alert-channels/${createdId}/test`);
      assert.equal(res.status, 502);
      assert.equal(res.body.error, 'The service could not be reached.');
      assert.ok(!res.text.includes(TG_SECRET_PART));
      res = await api('PUT', `/api/alert-channels/${createdId}`, { name: 'TG ops', bot_token: '' });
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(db.prepare('SELECT config FROM alert_channels WHERE id = ?').get(createdId).config).bot_token, TG_TOKEN, 'kept on edit');
      res = await api('PUT', `/api/alert-channels/${createdId}`, { bot_token: 'not-a-token-' + TG_SECRET_PART });
      assert.equal(res.status, 400);
      assert.ok(!res.text.includes(TG_SECRET_PART), 'a rejected token is not echoed');
    });
    // A Telegram answer that quotes the token back.
    await viaTransport(() => ({ statusCode: 401, text: JSON.stringify({ ok: false, error_code: 401, description: `Unauthorized (${TG_URL})` }) }), async () => {
      const res = await api('POST', `/api/alert-channels/${createdId}/test`);
      assert.equal(res.status, 502);
      assert.ok(!res.text.includes(TG_SECRET_PART), res.text);
    });
  });
  assert.ok(!printed.includes(TG_SECRET_PART), 'nothing printed contains the token');
  const row = db.prepare('SELECT last_error FROM alert_channels WHERE id = ?').get(createdId);
  assert.ok(row.last_error && !row.last_error.includes(TG_SECRET_PART), row.last_error);
  const logs = db.prepare("SELECT details FROM activity_log WHERE action LIKE 'alert_channel.%'").all().map((r) => r.details || '').join('\n');
  assert.ok(logs.length > 0 && !logs.includes(TG_SECRET_PART), 'the activity log never holds it');
  assert.equal(ch.redactTelegram(`x ${TG_URL} y ${TG_TOKEN}`), 'x https://api.telegram.org/bot…/sendMessage y …');
  assert.equal((await api('DELETE', `/api/alert-channels/${createdId}`)).status, 200);
});

test('a channel that answers 429 gets nothing more this pass; the rest go out on the next tick', async () => {
  for (const id of ['d-r1', 'd-r2', 'd-r3']) mkDevice(id, 'offline', NOW - 600);
  mkChannel('c-rl', 'telegram', { bot_token: TG_TOKEN, chat_id: '-4242' }, { scopes: [{ scope_kind: 'device', scope_id: 'd-r1' }, { scope_kind: 'device', scope_id: 'd-r2' }, { scope_kind: 'device', scope_id: 'd-r3' }] });
  const calls = [];
  // Only this channel's messages count (other channels in the workspace see these screens too).
  ch._setSender(async (msg) => {
    if (msg.service !== 'telegram') return { ok: true };
    calls.push(msg);
    return calls.length === 1 ? { ok: false, rateLimited: true, error: 'Telegram is limiting this bot (HTTP 429).' } : { ok: true };
  });
  try {
    await tick();
    assert.equal(calls.length, 1, 'one request hit the limit; the others were not spent against it');
    const att = db.prepare("SELECT device_id, attempts FROM alert_deliveries WHERE channel_id = 'c-rl'").all();
    assert.equal(att.length, 1, 'only the rate-limited one counts an attempt');
    await tick(NOW + 60);
    assert.equal(calls.length, 4, 'all three go out on the next tick');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM alert_deliveries WHERE channel_id = 'c-rl' AND offline_sent_at IS NOT NULL").get().n, 3);
  } finally {
    ch._setSender(async (msg) => { sent.push(msg); return { ok: true }; });
    db.prepare("DELETE FROM alert_channels WHERE id = 'c-rl'").run();
    for (const id of ['d-r1', 'd-r2', 'd-r3']) db.prepare('DELETE FROM devices WHERE id = ?').run(id);
  }
});

test('guardedRequest acceptAnyStatus hands back a 4xx body instead of throwing it away', async () => {
  const http = require('node:http');
  const guard = require('../lib/ssrf-guard');
  const srv = http.createServer((req, res) => { res.statusCode = 429; res.setHeader('content-type', 'application/json'); res.end('{"ok":false,"error_code":429,"parameters":{"retry_after":3}}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const saved = process.env.OUTBOUND_ALLOW_HOSTS;
  process.env.OUTBOUND_ALLOW_HOSTS = '127.0.0.1';
  try {
    const url = `http://127.0.0.1:${srv.address().port}/bot1:x/sendMessage`;
    await assert.rejects(guard.guardedRequest(url, { method: 'POST', body: '{}', responseType: 'text', accept2xx: true, timeoutMs: 3000 }), (e) => e.statusCode === 429);
    const r = await guard.guardedRequest(url, { method: 'POST', body: '{}', responseType: 'text', accept2xx: true, acceptAnyStatus: true, timeoutMs: 3000 });
    assert.equal(r.statusCode, 429);
    assert.equal(JSON.parse(r.text).parameters.retry_after, 3);
  } finally {
    if (saved === undefined) delete process.env.OUTBOUND_ALLOW_HOSTS; else process.env.OUTBOUND_ALLOW_HOSTS = saved;
    srv.close();
  }
});

test('telegram silent_info (#648): good news arrives without a sound, problems and tests always ring', () => {
  // Stored, kept on an edit that leaves it out, and shown to the form.
  const made = ch.normaliseInput({ kind: 'telegram', name: 'x', bot_token: TG_TOKEN, chat_id: '42', silent_info: true });
  assert.equal(JSON.parse(made.fields.config).silent_info, true);
  const kept = ch.normaliseInput({ name: 'Renamed' }, { kind: 'telegram', config: made.fields.config });
  assert.equal(JSON.parse(kept.fields.config).silent_info, true, 'an edit without the field keeps it');
  const off = ch.normaliseInput({ silent_info: false }, { kind: 'telegram', config: made.fields.config });
  assert.equal(JSON.parse(off.fields.config).silent_info, false);
  assert.equal(ch.present(db, { id: 'c-silent', kind: 'telegram', name: 'x', config: made.fields.config, events: '[]', enabled: 1 }).silent_info, true);

  const dev = { id: 'd1', name: 'Lobby' };
  const send = (silent, event, extra = {}) => ch.buildMessage(tgChannel(silent ? { silent_info: true } : {}), { event, device: dev, minutes: 12, nowIso: new Date().toISOString(), ...extra }).body;
  for (const ev of ['device_online', 'screen_ok']) {
    assert.equal(send(true, ev).disable_notification, true, `${ev} is silent when asked`);
    assert.equal(send(false, ev).disable_notification, undefined, `${ev} rings by default`);
  }
  assert.equal(send(true, 'device_offline').disable_notification, undefined, 'an outage always rings');
  assert.equal(send(true, 'screen_problem', { check: 'blank' }).disable_notification, undefined, 'a screen problem always rings');
  assert.equal(send(true, 'test').disable_notification, undefined, 'a test rings, so you can hear the channel work');
});
