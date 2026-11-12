'use strict';

/*
 * "Now serving" queues (lib/queue/service.js, routes/queues.js, routes/queue-public.js, the widget's
 * poll in routes/widgets.js). In-process against a real database; the browser end to end is in
 * now-serving-queue-e2e.test.js.
 */

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-queue-' + crypto.randomBytes(4).toString('hex'));
process.env.JWT_SECRET = 'test-secret-queue';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const svc = require('../lib/queue/service');

const O = 'o-q', WS = 'ws-q', WS2 = 'ws-q-2', U = 'u-q', V = 'u-q-v', U2 = 'u-q-2';
let server, base;
const tokenOf = (u, ws = WS) => generateToken(db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(u), ws);
async function api(method, p, body, who = U, ws = WS) {
  const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${tokenOf(who, ws)}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, headers: r.headers };
}
async function pub(method, p, body, headers = {}, ip = '198.51.100.1') {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, headers: r.headers };
}
const tokenFromCustomer = (q) => q.customer_path.split('/').pop();
const keyFromStaff = (q) => q.staff_path.split('#')[1];
const staff = (q, method, action, body, ip) => pub(method, `/api/public/queue/s/${action}`, body, { 'X-Queue-Staff-Key': keyFromStaff(q) }, ip);
const take = (q, clientId, ip) => pub('POST', `/api/public/queue/c/${tokenFromCustomer(q)}/ticket`, clientId ? { client_id: clientId } : {}, {}, ip);
const cid = () => crypto.randomBytes(18).toString('base64url');

async function newQueue(body = {}) {
  const r = await api('POST', '/api/queues', { name: 'Desk', timezone: 'Europe/Lisbon', ...body });
  assert.equal(r.status, 201);
  return r.body;
}
async function widgetFor(queueId, extra = {}) {
  const r = await api('POST', '/api/widgets', { widget_type: 'queue', name: 'NS', config: { queue_id: queueId, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

before(async () => {
  db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, 'q@t.local', 'x', 'user'), (?, 'qv@t.local', 'x', 'user'), (?, 'q2@t.local', 'x', 'user')").run(U, V, U2);
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(O, 'Org', U);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?), (?, ?, ?)').run(WS, O, 'WS', WS2, O, 'WS2');
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor'), (?, ?, 'workspace_viewer'), (?, ?, 'workspace_editor')").run(WS, U, WS, V, WS2, U2);
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.get('/api/widgets/:id/render', (req, res, next) => { req._skipAuth = true; next(); });
  app.get('/api/widgets/:id/queue.json', (req, res, next) => { req._skipAuth = true; next(); });
  const authed = (req, res, next) => (req._skipAuth ? next() : requireAuth(req, res, () => resolveTenancy(req, res, next)));
  app.use('/api/widgets', authed, require('../routes/widgets'));
  app.use('/api/queues', requireAuth, resolveTenancy, require('../routes/queues'));
  app.use('/api/public/queue', require('../routes/queue-public'));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { try { server.close(); } catch { /* */ } });

test('numbers start at 1 and staff Next serves them in order; Next with nobody waiting is refused', async () => {
  const q = await newQueue();
  assert.equal((await take(q, cid())).body.number, 1);
  assert.equal((await take(q, cid())).body.number, 2);
  let r = await staff(q, 'POST', 'next');
  assert.equal(r.status, 200);
  assert.equal(r.body.now_serving, 1);
  r = await staff(q, 'POST', 'next');
  assert.equal(r.body.now_serving, 2);
  r = await staff(q, 'POST', 'next');
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'empty');
});

test("a customer's number survives a second scan the same day", async () => {
  const q = await newQueue();
  const id = cid();
  const first = await take(q, id);
  assert.equal(first.status, 201);
  const again = await take(q, id);
  assert.equal(again.status, 200);
  assert.equal(again.body.number, first.body.number);
  assert.equal(again.body.existing, true);
  // Nobody else's scan was consumed by the repeat.
  assert.equal((await take(q, cid())).body.number, first.body.number + 1);
});

test('the customer page answers no tokens and an unchanged queue costs only a revision', async () => {
  const q = await newQueue();
  const tok = tokenFromCustomer(q);
  const s = await pub('GET', `/api/public/queue/c/${tok}/state`);
  assert.equal(s.status, 200);
  assert.equal(s.headers.get('cache-control'), 'no-store');
  assert.equal(s.headers.get('referrer-policy'), 'no-referrer');
  const text = JSON.stringify(s.body);
  assert.ok(!text.includes(tok), 'no customer token in the answer');
  assert.ok(!text.includes(keyFromStaff(q).split('.')[1]), 'no staff token in the answer');
  const same = await pub('GET', `/api/public/queue/c/${tok}/state?rev=${encodeURIComponent(s.body.rev)}`);
  assert.deepEqual(same.body, { rev: s.body.rev, unchanged: true });
  await take(q, cid());
  const moved = await pub('GET', `/api/public/queue/c/${tok}/state?rev=${encodeURIComponent(s.body.rev)}`);
  assert.equal(moved.body.unchanged, undefined);
  assert.equal(moved.body.last_issued, 1);
  assert.equal((await pub('GET', '/api/public/queue/c/' + 'x'.repeat(43) + '/state')).status, 404);
});

test('the staff link cannot be used after it is rotated, nor after it is revoked', async () => {
  const q = await newQueue();
  await take(q, cid());
  assert.equal((await staff(q, 'GET', 'state')).status, 200);
  const rotated = (await api('POST', `/api/queues/${q.id}/staff-link`)).body;
  assert.notEqual(rotated.staff_path, q.staff_path);
  assert.equal((await staff(q, 'POST', 'next')).status, 401, 'the old link is dead');
  assert.equal((await staff(rotated, 'POST', 'next')).status, 200, 'the new one works');
  const off = (await api('DELETE', `/api/queues/${q.id}/staff-link`)).body;
  assert.equal(off.staff_path, undefined);
  assert.equal(off.staff_link_active, false);
  assert.equal((await staff(rotated, 'GET', 'state')).status, 401);
  // The customer token never opens the staff side.
  assert.equal((await pub('GET', '/api/public/queue/s/state', null, { 'X-Queue-Staff-Key': `${q.id}.${tokenFromCustomer(q)}` })).status, 401);
});

test('a staff key is compared in constant time and is never a lookup key', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'lib', 'queue', 'service.js'), 'utf8');
  assert.match(src, /timingSafeEqual\(sha\(stored\), sha\(token\)\)/);
  assert.doesNotMatch(src, /WHERE staff_token = \?/);
  const q = svc.create(db, { workspaceId: WS, name: 'K', timezone: 'UTC' });
  assert.equal(svc.byStaffKey(db, `${q.id}.${q.staff_token}`).id, q.id);
  assert.equal(svc.byStaffKey(db, `${q.id}.${svc.newToken()}`), null);
  assert.equal(svc.byStaffKey(db, q.staff_token), null);
});

test('a read-only member never sees the staff link and cannot change the queue', async () => {
  const q = await newQueue();
  const list = await api('GET', '/api/queues', null, V);
  assert.equal(list.status, 200);
  const mine = list.body.find((x) => x.id === q.id);
  assert.ok(mine, 'the viewer can read the queue');
  assert.equal(mine.staff_path, undefined);
  assert.equal(mine.can_write, false);
  const one = await api('GET', `/api/queues/${q.id}`, null, V);
  assert.ok(!JSON.stringify(one.body).includes(keyFromStaff(q).split('.')[1]));
  for (const [m, p] of [['POST', '/next'], ['POST', '/call'], ['POST', '/reset'], ['POST', '/sound'], ['POST', '/staff-link'], ['DELETE', '/staff-link'], ['PUT', ''], ['DELETE', '']]) {
    assert.equal((await api(m, `/api/queues/${q.id}${p}`, { number: 1, on: true, name: 'x' }, V)).status, 403, `${m} ${p}`);
  }
  assert.equal((await api('POST', '/api/queues', { name: 'nope' }, V)).status, 403);
  // Another workspace cannot see it at all.
  assert.equal((await api('GET', `/api/queues/${q.id}`, null, U2, WS2)).status, 404);
});

test('calling a specific number moves now-serving to it and the widget shows it', async () => {
  const q = await newQueue();
  for (let i = 0; i < 5; i++) await take(q, cid());
  const w = await widgetFor(q.id);
  let r = await staff(q, 'POST', 'call', { number: 4 });
  assert.equal(r.status, 200);
  assert.equal(r.body.now_serving, 4);
  let ws = await pub('GET', `/api/widgets/${w.id}/queue.json`);
  assert.equal(ws.body.now_serving, 4);
  // Call back an earlier one, from the dashboard this time.
  r = await api('POST', `/api/queues/${q.id}/call`, { number: 2 });
  assert.equal(r.body.now_serving, 2);
  ws = await pub('GET', `/api/widgets/${w.id}/queue.json`);
  assert.equal(ws.body.now_serving, 2);
  // Only numbers handed out today.
  assert.equal((await staff(q, 'POST', 'call', { number: 6 })).body.code, 'not_issued');
  assert.equal((await staff(q, 'POST', 'call', { number: 0 })).status, 400);
});

test('the widget poll carries no token, and an unchanged queue answers only {rev, unchanged}', async () => {
  const q = await newQueue();
  const w = await widgetFor(q.id);
  const r = await pub('GET', `/api/widgets/${w.id}/queue.json`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(Object.keys(r.body).sort(), ['call_seq', 'name', 'now_serving', 'rev', 'sound', 'waiting']);
  const same = await pub('GET', `/api/widgets/${w.id}/queue.json?rev=${encodeURIComponent(r.body.rev)}`);
  assert.deepEqual(same.body, { rev: r.body.rev, unchanged: true });
});

test("a widget can only name its own workspace's queue", async () => {
  const other = (await api('POST', '/api/queues', { name: 'Theirs' }, U2, WS2)).body;
  const r = await api('POST', '/api/widgets', { widget_type: 'queue', name: 'X', config: { queue_id: other.id } });
  assert.equal(r.status, 400);
});

test('the widget page is sandboxed, keeps no state in the cached render, and carries no token', async () => {
  const q = await newQueue();
  await take(q, cid());
  await staff(q, 'POST', 'next');
  const w = await widgetFor(q.id);
  const r = await fetch(`${base}/api/widgets/${w.id}/render?rev=1`);
  const html = await r.text();
  assert.match(r.headers.get('content-security-policy'), /sandbox allow-scripts/);
  assert.match(r.headers.get('cache-control'), /private/);
  assert.ok(!html.includes(tokenFromCustomer(q)) && !html.includes(keyFromStaff(q).split('.')[1]));
  assert.match(html, /queue\.json/);
  assert.doesNotMatch(html, /\b(const|let)\b|=>/, 'ES5 only: old TV browsers run this');
  assert.match(html, /"initial":null/, 'a rev-pinned (year-cached) render carries no number');
  const live = await (await fetch(`${base}/api/widgets/${w.id}/render`)).text();
  assert.match(live, /"initial":\{"number":1,/, 'an uncached render starts with the current number');
  // The editor's Preview: a sample number, no polling.
  const pv = await api('POST', '/api/widgets/preview', { widget_type: 'queue', config: { label: 'Desk 1' } });
  assert.equal(pv.status, 200);
  assert.match(pv.body, /"preview":true/);
  assert.match(pv.body, /Desk 1/);
});

test('the queue restarts at local midnight, in the queue\'s own timezone', () => {
  // 23:30 in Lisbon on 2026-01-10 is 23:30 UTC (WET); in Tokyo it is already the 11th.
  const t0 = Date.UTC(2026, 0, 10, 23, 30);
  assert.equal(svc.localDay('Europe/Lisbon', t0), '2026-01-10');
  assert.equal(svc.localDay('Asia/Tokyo', t0), '2026-01-11');
  let q = svc.create(db, { workspaceId: WS, name: 'Mid', timezone: 'America/Chicago', nowMs: Date.UTC(2026, 0, 10, 15, 0) });
  svc.takeTicket(db, q, { nowMs: Date.UTC(2026, 0, 10, 15, 1) });
  svc.takeTicket(db, q, { nowMs: Date.UTC(2026, 0, 10, 15, 2) });
  q = svc.next(db, q, { nowMs: Date.UTC(2026, 0, 10, 15, 3) });
  assert.equal(q.now_serving, 1);
  // 05:59 UTC on the 11th is 23:59 on the 10th in Chicago (CST, January): still the same day.
  q = svc.current(db, svc.load(db, q.id), Date.UTC(2026, 0, 11, 5, 59));
  assert.equal(q.last_issued, 2);
  // 06:01 UTC is 00:01 on the 11th in Chicago: a new day, numbers start again at 1.
  const before = q.round;
  q = svc.current(db, svc.load(db, q.id), Date.UTC(2026, 0, 11, 6, 1));
  assert.equal(q.day, '2026-01-11');
  assert.equal(q.round, before + 1);
  assert.equal(q.last_issued, 0);
  assert.equal(q.now_serving, 0);
  assert.equal(svc.takeTicket(db, q, { nowMs: Date.UTC(2026, 0, 11, 6, 2) }).number, 1);
  assert.equal(svc.events(db, q.id)[0].kind === 'new_day' || svc.events(db, q.id).some((e) => e.kind === 'new_day'), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM queue_tickets WHERE queue_id = ? AND round < ?').get(q.id, q.round).n, 0, 'yesterday\'s tickets are gone');
});

test('start of day restarts the numbers at once, and an old ticket is not today\'s', async () => {
  const q = await newQueue();
  const id = cid();
  assert.equal((await take(q, id)).body.number, 1);
  await take(q, cid());
  await staff(q, 'POST', 'next');
  const r = await staff(q, 'POST', 'reset');
  assert.equal(r.status, 200);
  assert.equal(r.body.now_serving, 0);
  assert.equal(r.body.last_issued, 0);
  assert.equal(r.body.events[0].kind, 'reset');
  // The same browser scanning again gets a fresh number 1 in the new round.
  const again = await take(q, id);
  assert.equal(again.body.number, 1);
  assert.equal(again.body.existing, false);
});

test('the staff log keeps only the last 20 events, with no customer identifiers', async () => {
  const q = await newQueue();
  const ids = [];
  for (let i = 0; i < 30; i++) { const c = cid(); ids.push(c); await take(q, c, `198.51.100.${10 + (i % 3)}`); }
  for (let i = 0; i < 25; i++) await staff(q, 'POST', 'next');
  await staff(q, 'POST', 'sound', { on: false });
  const s = await staff(q, 'GET', 'state');
  assert.equal(s.body.events.length, 20);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM queue_events WHERE queue_id = ?').get(q.id).n, 20, 'pruned in the table, not only in the answer');
  assert.equal(s.body.events[0].kind, 'sound_off');
  assert.equal(s.body.events[1].kind, 'next');
  assert.equal(s.body.events[1].number, 25);
  assert.equal(s.body.events[1].source, 'staff_link');
  const all = JSON.stringify(db.prepare('SELECT * FROM queue_events WHERE queue_id = ?').all(q.id));
  for (const c of ids) assert.ok(!all.includes(c));
  assert.ok(!/198\.51\.100/.test(all));
  assert.ok(!all.includes('ticket'), 'taking a number is not logged');
});

test('the staff sound switch reaches the widget poll and is logged', async () => {
  const q = await newQueue();
  const w = await widgetFor(q.id, { chime: true });
  assert.equal((await pub('GET', `/api/widgets/${w.id}/queue.json`)).body.sound, true, 'on by default at the queue');
  await api('POST', `/api/queues/${q.id}/sound`, { on: false });
  assert.equal((await pub('GET', `/api/widgets/${w.id}/queue.json`)).body.sound, false);
  const ev = (await api('GET', `/api/queues/${q.id}`)).body.events;
  assert.equal(ev[0].kind, 'sound_off');
  assert.equal(ev[0].source, 'dashboard');
});

test('the customer is told how many are ahead and never a negative number', () => {
  // 3 is being served, so 4, 5 and 6 are called before 7.
  assert.deepEqual(svc.aheadOf(7, 3), { status: 'waiting', ahead: 3 });
  // Nobody called yet: 1 to 6 go first.
  assert.deepEqual(svc.aheadOf(7, 0), { status: 'waiting', ahead: 6 });
  assert.deepEqual(svc.aheadOf(7, 6), { status: 'next', ahead: 0 });
  assert.deepEqual(svc.aheadOf(1, 0), { status: 'next', ahead: 0 });
  assert.deepEqual(svc.aheadOf(7, 7), { status: 'called', ahead: 0 });
  assert.deepEqual(svc.aheadOf(7, 9), { status: 'passed', ahead: 0 });
  for (let s = 0; s < 20; s++) assert.ok(svc.aheadOf(5, s).ahead >= 0);
  // The page uses the same rule (frontend/js/queue-page.js mirrors it).
  const page = require('node:fs').readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'queue-page.js'), 'utf8');
  assert.match(page, /if \(s > tk\) return \{ status: 'passed', ahead: 0 \};/);
  assert.match(page, /const ahead = Math\.max\(0, tk - s - 1\);/);
});

test('tickets are capped per day with a clear message', async () => {
  const q = await newQueue({ max_per_day: 2 });
  await take(q, cid(), '198.51.100.50');
  await take(q, cid(), '198.51.100.50');
  const r = await take(q, cid(), '198.51.100.50');
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'full');
  assert.match(r.body.error, /at most 2 a day/);
});

test('one address cannot drain the queue: new tickets are limited per IP', async () => {
  const q = await newQueue();
  const ip = '198.51.100.77';
  let limited = 0;
  for (let i = 0; i < 25; i++) if ((await take(q, cid(), ip)).status === 429) limited++;
  assert.ok(limited >= 5, `got ${limited} refusals`);
  // A browser re-asking for the number it already holds is never refused.
  const held = db.prepare('SELECT client_id FROM queue_tickets WHERE queue_id = ? AND client_id IS NOT NULL LIMIT 1').get(q.id).client_id;
  assert.equal((await take(q, held, ip)).status, 200);
  // Another address is unaffected.
  assert.equal((await take(q, cid(), '198.51.100.78')).status, 201);
});

test('a deleted workspace takes its queues, tickets and log with it', async () => {
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run('ws-q-gone', O, 'Gone');
  const q = svc.create(db, { workspaceId: 'ws-q-gone', name: 'G', timezone: 'UTC' });
  svc.takeTicket(db, q, { clientId: cid() });
  svc.next(db, q, { source: 'dashboard' });
  require('../lib/user-deletion').deleteWorkspaceCascade(db, { workspaceId: 'ws-q-gone', unlink: () => {} });
  for (const t of ['queues', 'queue_tickets', 'queue_events']) {
    const col = t === 'queues' ? 'id' : 'queue_id';
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ?`).get(q.id).n, 0, t);
  }
});

test('the customer token in a path never names its own rate-limit bucket', () => {
  const { canonicalLimitPath } = require('../lib/limit-paths');
  const tok = svc.newToken();
  assert.equal(canonicalLimitPath(`/queue/${tok}`), '/queue/:token');
  assert.equal(canonicalLimitPath(`/api/public/queue/c/${tok}/ticket`), '/api/public/queue/c/:token/ticket');
  assert.equal(canonicalLimitPath(`/api/public/queue/c/${tok}/state`), '/api/public/queue/c/:token/state');
});

test('scale-out: on a node holding a COPY of the workspace, every customer and staff call goes to the primary', async () => {
  const q = await newQueue({ name: 'Copy desk' });
  assert.equal((await take(q, cid())).body.number, 1);
  const before = db.prepare('SELECT * FROM queues WHERE id = ?').get(q.id);
  db.prepare('UPDATE workspaces SET origin_node_id = ? WHERE id = ?').run('primary-node-uuid', WS);
  try {
    // No PRIMARY_URL in this test, so the proxy answers 409 instead of forwarding: proof it was taken.
    const calls = [
      await pub('GET', `/api/public/queue/c/${tokenFromCustomer(q)}/state`),   // reads too: a poll can start the day
      await take(q, cid()),
      await staff(q, 'GET', 'state'),
      await staff(q, 'POST', 'next'),
      await staff(q, 'POST', 'call', { number: 1 }),
      await staff(q, 'POST', 'reset'),
      await staff(q, 'POST', 'sound', { on: false }),
    ];
    for (const r of calls) {
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.code, 'read_only_replica');
    }
    assert.deepEqual(db.prepare('SELECT * FROM queues WHERE id = ?').get(q.id), before, 'the copy was not written');
    // A wrong staff key is still just a wrong key (nothing to forward).
    const bad = await pub('POST', '/api/public/queue/s/next', {}, { 'X-Queue-Staff-Key': q.id + '.' + 'A'.repeat(43) });
    assert.equal(bad.status, 401);
  } finally {
    db.prepare('UPDATE workspaces SET origin_node_id = NULL WHERE id = ?').run(WS);
  }
  assert.equal((await staff(q, 'POST', 'next')).status, 200, 'back to normal once the workspace is the primary again');
});
