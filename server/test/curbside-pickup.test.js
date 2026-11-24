'use strict';

/*
 * Curbside pickup (lib/curbside/service.js, routes/curbside.js, routes/curbside-public.js, the
 * widget's poll in routes/widgets.js). In-process against a real database; the browser end to end is
 * in curbside-pickup-e2e.test.js.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-curbside-' + crypto.randomBytes(4).toString('hex'));
process.env.JWT_SECRET = 'test-secret-curbside';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const svc = require('../lib/curbside/service');
const texts = require('../lib/curbside/texts');
const { renderCurbsideWidget } = require('../lib/curbside/widget');

const O = 'o-cs', WS = 'ws-cs', WS2 = 'ws-cs-2', U = 'u-cs', V = 'u-cs-v', U2 = 'u-cs-2';
let server, base;
const tokenOf = (u, ws = WS) => generateToken(db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(u), ws);
async function api(method, p, body, who = U, ws = WS) {
  const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${tokenOf(who, ws)}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, headers: r.headers };
}
let ipSeq = 1;
const freshIp = () => `198.51.100.${(ipSeq++ % 250) + 1}`;
async function pub(method, p, body, headers = {}, ip = '203.0.113.1') {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, headers: r.headers };
}
const tok = (l) => l.customer_path.split('/').pop();
const keyOf = (l) => l.staff_path.split('#')[1];
const cid = () => crypto.randomBytes(18).toString('base64url');
const staff = (l, method, action, body, ip) => pub(method, `/api/public/curbside/s/${action}`, body, { 'X-Curbside-Staff-Key': keyOf(l) }, ip);
const checkin = (l, client, body, ip = freshIp()) => pub('POST', `/api/public/curbside/c/${tok(l)}/checkin`, body, client ? { 'X-Curbside-Client': client } : {}, ip);
const state = (l, client, spot) => pub('GET', `/api/public/curbside/c/${tok(l)}/state${spot ? `?spot=${encodeURIComponent(spot)}` : ''}`, null, client ? { 'X-Curbside-Client': client } : {});
const cancel = (l, client) => pub('POST', `/api/public/curbside/c/${tok(l)}/cancel`, {}, client ? { 'X-Curbside-Client': client } : {}, freshIp());

async function newLocation(body = {}) {
  const r = await api('POST', '/api/curbside', { name: 'Main St', timezone: 'America/Chicago', spots_count: 6, ...body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
async function widgetFor(locationId, extra = {}) {
  const r = await api('POST', '/api/widgets', { widget_type: 'curbside', name: 'CS', config: { location_id: locationId, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

before(async () => {
  db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, 'cs@t.local', 'x', 'user'), (?, 'csv@t.local', 'x', 'user'), (?, 'cs2@t.local', 'x', 'user')").run(U, V, U2);
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(O, 'Org', U);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?), (?, ?, ?)').run(WS, O, 'WS', WS2, O, 'WS2');
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor'), (?, ?, 'workspace_viewer'), (?, ?, 'workspace_editor')").run(WS, U, WS, V, WS2, U2);
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.get('/api/widgets/:id/render', (req, res, next) => { req._skipAuth = true; next(); });
  app.get('/api/widgets/:id/curbside.json', (req, res, next) => { req._skipAuth = true; next(); });
  const authed = (req, res, next) => (req._skipAuth ? next() : requireAuth(req, res, () => resolveTenancy(req, res, next)));
  app.use('/api/widgets', authed, require('../routes/widgets'));
  app.use('/api/curbside', requireAuth, resolveTenancy, require('../routes/curbside'));
  app.use('/api/public/curbside', require('../routes/curbside-public'));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { try { server.close(); } catch { /* */ } });

test('a location gets spots 1..N, or custom labels (trimmed, capped, unique), and refuses an empty list', async () => {
  const a = await newLocation({ spots_count: 4 });
  assert.deepEqual(a.spots, ['1', '2', '3', '4']);
  const b = await newLocation({ spots_count: undefined, spots: 'A1, A2,\nB1, a1 ,  , ' + 'X'.repeat(30) });
  assert.deepEqual(b.spots, ['A1', 'A2', 'B1', 'X'.repeat(12)]);
  assert.equal((await api('POST', '/api/curbside', { name: 'x', spots: ' , ' })).status, 400);
  assert.equal((await api('POST', '/api/curbside', { name: 'x', spots_count: 0 })).status, 400);
  assert.equal((await api('POST', '/api/curbside', { name: 'x', spots_count: 201 })).status, 400);
  const c = await api('PUT', `/api/curbside/${a.id}`, { spots_count: 2 });
  assert.deepEqual(c.body.spots, ['1', '2']);
  assert.equal((await api('PUT', `/api/curbside/${a.id}`, { timezone: 'Mars/Olympus' })).status, 400);
});

test('check in, staff acknowledge ("We got you"), the customer sees it, then Done', async () => {
  const l = await newLocation();
  const me = cid();
  let s = await state(l, me, '3');
  assert.equal(s.status, 200);
  assert.equal(s.body.spot, '3');
  assert.equal(s.body.arrival, null);
  assert.equal(s.body.spot_taken, false);
  const r = await checkin(l, me, { spot: '3', order_ref: ' 1234 ', note: 'red Corolla' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.state.arrival.status, 'waiting');
  assert.equal(r.body.state.arrival.order_ref, '1234');
  // Staff see it, oldest first, with the note.
  let st = await staff(l, 'GET', 'state');
  assert.equal(st.status, 200);
  assert.equal(st.body.arrivals.length, 1);
  const a = st.body.arrivals[0];
  assert.deepEqual([a.spot, a.order_ref, a.note, a.status], ['3', '1234', 'red Corolla', 'waiting']);
  assert.equal(typeof st.body.now, 'number');
  st = await staff(l, 'POST', 'ack', { id: a.id });
  assert.equal(st.body.arrivals[0].status, 'seen');
  s = await state(l, me, '3');
  assert.equal(s.body.arrival.status, 'seen', 'the customer page now says we got you');
  // Acknowledging twice is harmless.
  assert.equal((await staff(l, 'POST', 'ack', { id: a.id })).status, 200);
  st = await staff(l, 'POST', 'done', { id: a.id });
  assert.equal(st.body.arrivals.length, 0);
  assert.equal(st.body.done_today, 1);
  s = await state(l, me, '3');
  assert.equal(s.body.arrival.status, 'done');
  assert.equal(s.body.spot_taken, false, 'a done car frees the spot');
  // A closed one cannot be acknowledged again.
  assert.equal((await staff(l, 'POST', 'ack', { id: a.id })).body.code, 'closed');
  assert.equal((await staff(l, 'POST', 'done', { id: 999999 })).status, 404);
});

test('only one open arrival per spot; the same phone gets its own check-in back', async () => {
  const l = await newLocation();
  const me = cid();
  const first = await checkin(l, me, { spot: '2', order_ref: '77' });
  assert.equal(first.status, 201);
  // Same phone, a second tap (even naming another spot): the same check-in, not a second one.
  const again = await checkin(l, me, { spot: '5', order_ref: '78' });
  assert.equal(again.status, 200);
  assert.equal(again.body.existing, true);
  assert.equal(again.body.state.arrival.spot, '2');
  assert.equal(again.body.state.arrival.order_ref, '77');
  // Re-opening the page on that phone shows it.
  assert.equal((await state(l, me)).body.arrival.order_ref, '77');
  // Another phone at the same spot is told it is taken.
  const other = cid();
  assert.equal((await state(l, other, '2')).body.spot_taken, true);
  assert.equal((await state(l, me, '2')).body.spot_taken, false, 'not "taken" for the phone holding it');
  const taken = await checkin(l, other, { spot: '2', order_ref: '90' });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.code, 'spot_taken');
  // The database itself refuses a second open row on a spot.
  assert.throws(() => db.prepare(`INSERT INTO curbside_arrivals (location_id, day, spot, order_ref, status, created_at) VALUES (?, ?, '2', 'x', 'waiting', 1)`).run(l.id, l.day), /UNIQUE/);
  // Another spot is fine.
  assert.equal((await checkin(l, other, { spot: '4', order_ref: '90' })).status, 201);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM curbside_arrivals WHERE location_id = ? AND status IN ('waiting','seen')").get(l.id).n, 2);
});

test('the customer can cancel their own check-in, nobody else can, and the spot frees up', async () => {
  const l = await newLocation();
  const me = cid();
  await checkin(l, me, { spot: '1', order_ref: 'A-1' });
  assert.equal((await cancel(l, cid())).status, 404, 'another phone has nothing to cancel');
  assert.equal((await cancel(l, null)).status, 404);
  const c = await cancel(l, me);
  assert.equal(c.status, 200);
  assert.equal(c.body.state.arrival.status, 'cancelled');
  const row = db.prepare('SELECT status, cancelled, done_at FROM curbside_arrivals WHERE location_id = ?').get(l.id);
  assert.equal(row.cancelled, 1);
  assert.ok(row.done_at > 0);
  assert.equal((await staff(l, 'GET', 'state')).body.arrivals.length, 0);
  assert.equal((await state(l, cid(), '1')).body.spot_taken, false);
  // The same phone can check in again after cancelling.
  assert.equal((await checkin(l, me, { spot: '1', order_ref: 'A-2' })).status, 201);
});

test('order numbers and notes are validated and capped; spots must exist; a client id is required', async () => {
  const l = await newLocation();
  const bad = async (body, code, client = cid()) => {
    const r = await checkin(l, client, { spot: '1', order_ref: '1', ...body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.code, code);
  };
  await bad({ order_ref: '' }, 'order');
  await bad({ order_ref: '   ' }, 'order');
  await bad({ order_ref: '1'.repeat(21) }, 'order');
  await bad({ order_ref: '<script>' }, 'order');
  await bad({ order_ref: '12"34' }, 'order');
  await bad({ order_ref: { x: 1 } }, 'order');
  await bad({ note: 'n'.repeat(81) }, 'note');
  await bad({ spot: '99' }, 'spot');
  await bad({ spot: undefined }, 'spot');
  await bad({}, 'client', null);
  await bad({}, 'client', 'short');
  // Allowed shapes, and control characters in a note become spaces.
  const ok = await checkin(l, cid(), { spot: '6', order_ref: '#A-12/3', note: 'blue\nvan\u0000 ' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.state.arrival.note, 'blue van');
  assert.equal(ok.body.state.arrival.order_ref, '#A-12/3');
  // A spot label is matched ignoring case.
  const b = await newLocation({ spots_count: undefined, spots: ['A1', 'B2'] });
  const r = await checkin(b, cid(), { spot: 'b2', order_ref: '5' });
  assert.equal(r.body.state.arrival.spot, 'B2');
});

test('every customer and widget text can be changed per location; empty means the default; plain text, capped', async () => {
  const l = await newLocation();
  assert.deepEqual(l.texts, {});
  assert.equal(l.text_defaults.button, "I'm here");
  const r = await api('PUT', `/api/curbside/${l.id}`, { texts: {
    heading: '  Recogida  ', button: 'Ya llegué', seen: '<b>¡Ya vamos!</b> spot {spot}', done: '', waiting: '   ',
    widget_seen: 'En camino', widget_empty: 'Nadie', intro: 'x'.repeat(500), nonsense: 'dropped', spot_taken: "Line1\nLine2",
  } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.texts.heading, 'Recogida');
  assert.equal(r.body.texts.seen, '<b>¡Ya vamos!</b> spot {spot}', 'kept as text, never interpreted');
  assert.equal(r.body.texts.done, undefined, 'empty = default');
  assert.equal(r.body.texts.waiting, undefined);
  assert.equal(r.body.texts.nonsense, undefined);
  assert.equal(r.body.texts.intro.length, texts.MAX.intro);
  assert.equal(r.body.texts.spot_taken, 'Line1 Line2');
  const s = await state(l, cid(), '1');
  assert.equal(s.body.texts.heading, 'Recogida');
  assert.equal(s.body.texts.button, 'Ya llegué');
  assert.equal(s.body.texts.done, texts.DEFAULTS.done);
  assert.equal(s.body.texts.widget_seen, undefined, 'widget labels are not sent to the customer page');
  const w = await widgetFor(l.id);
  const wj = await pub('GET', `/api/widgets/${w.id}/curbside.json`);
  assert.equal(wj.body.labels.widget_seen, 'En camino');
  assert.equal(wj.body.labels.widget_empty, 'Nadie');
  assert.equal(wj.body.labels.widget_order, texts.DEFAULTS.widget_order);
  assert.equal((await api('PUT', `/api/curbside/${l.id}`, { texts: 'nope' })).status, 400);
  // Reset to defaults.
  const reset = await api('PUT', `/api/curbside/${l.id}`, { texts: {} });
  assert.deepEqual(reset.body.texts, {});
});

test('the widget poll shows order + spot + status, never the note, and no token or client id', async () => {
  const l = await newLocation();
  const w = await widgetFor(l.id);
  const me = cid();
  await checkin(l, me, { spot: '4', order_ref: '1234', note: 'secret note' });
  const st = await staff(l, 'GET', 'state');
  await staff(l, 'POST', 'ack', { id: st.body.arrivals[0].id });
  const r = await pub('GET', `/api/widgets/${w.id}/curbside.json`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(r.body.arrivals, [{ order_ref: '1234', spot: '4', status: 'seen' }]);
  assert.deepEqual(Object.keys(r.body).sort(), ['ack_seq', 'arrivals', 'arrive_seq', 'labels', 'name', 'rev']);
  const text = JSON.stringify(r.body);
  for (const secret of ['secret note', me, tok(l), keyOf(l).split('.')[1]]) assert.ok(!text.includes(secret), secret);
  const same = await pub('GET', `/api/widgets/${w.id}/curbside.json?rev=${encodeURIComponent(r.body.rev)}`);
  assert.deepEqual(same.body, { rev: r.body.rev, unchanged: true });
  // The rendered page carries no token, is sandboxed, ES5.
  const page = await fetch(`${base}/api/widgets/${w.id}/render?rev=1`);
  const html = await page.text();
  assert.match(page.headers.get('content-security-policy'), /sandbox allow-scripts/);
  assert.match(html, /curbside\.json/);
  assert.match(html, /"initial":null/, 'a year-cached render carries no list');
  assert.ok(!html.includes(tok(l)) && !html.includes(keyOf(l).split('.')[1]) && !html.includes('secret note'));
  assert.doesNotMatch(html.replace(/"labels":\{[^}]*\}/g, ''), /\b(const|let)\b|=>/, 'ES5 only');
  const live = await (await fetch(`${base}/api/widgets/${w.id}/render`)).text();
  assert.match(live, /"order_ref":"1234"/, 'an uncached render starts with the list');
  // Preview: sample rows.
  const pv = await api('POST', '/api/widgets/preview', { widget_type: 'curbside', config: {} });
  assert.equal(pv.status, 200);
  assert.match(pv.body, /"preview":true/);
});

test('admin text, order numbers and notes are escaped in the widget HTML', async () => {
  const evil = '</script><img src=x onerror=alert(1)><script>alert(2)</script>&';
  const html = renderCurbsideWidget({ widgetId: 'w1', origin: 'https://x.test', config: { background: 'red;}</style><script>alert(3)</script>', color: '"><x>' }, initial: {
    rev: '1', name: evil, ack_seq: 0, arrive_seq: 0,
    labels: { ...texts.widgetTexts({}), widget_heading: evil, widget_order: evil, widget_empty: evil },
    arrivals: [{ order_ref: evil, spot: evil, status: 'seen' }],
  } });
  assert.ok(!html.includes('<img src=x'), 'no raw tag from data');
  assert.ok(!html.includes('</script><img'), 'no script breakout');
  assert.ok(!html.includes('alert(2)</script>'));
  assert.ok(!html.includes('alert(3)'), 'a colour that is not hex never reaches the CSS');
  assert.ok(!html.includes('"><x>'));
  assert.match(html, /<title>&lt;\/script&gt;&lt;img/);
  assert.match(html, /\\u003c\/script\\u003e\\u003cimg/, 'JSON in the script is escaped');
  // The page only ever puts data on screen with textContent.
  assert.doesNotMatch(html, /innerHTML|insertAdjacentHTML|document\.write/);
  // Escaped the same way through the real render route.
  const l = await newLocation();
  await api('PUT', `/api/curbside/${l.id}`, { texts: { widget_heading: evil } });
  const w = await widgetFor(l.id);
  const live = await (await fetch(`${base}/api/widgets/${w.id}/render`)).text();
  assert.ok(!live.includes('<img src=x') && !live.includes('</script><img'));
});

test('the frontend pages build the DOM with text, never innerHTML', () => {
  const root = path.join(__dirname, '..', '..', 'frontend', 'js');
  for (const f of ['curbside-page.js', 'curbside-staff-page.js', 'lib/curbside-dom.js', 'views/curbside.js', 'components/curbside-widget-editor.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.doesNotMatch(src, /\.innerHTML\s*=|outerHTML|insertAdjacentHTML|document\.write/, f);
  }
});

test('the staff link stops working when replaced or turned off; the customer token never opens it', async () => {
  const l = await newLocation();
  assert.equal((await staff(l, 'GET', 'state')).status, 200);
  const rotated = (await api('POST', `/api/curbside/${l.id}/staff-link`)).body;
  assert.notEqual(rotated.staff_path, l.staff_path);
  assert.equal((await staff(l, 'GET', 'state')).status, 401);
  assert.equal((await staff(rotated, 'GET', 'state')).status, 200);
  const off = (await api('DELETE', `/api/curbside/${l.id}/staff-link`)).body;
  assert.equal(off.staff_path, undefined);
  assert.equal(off.staff_link_active, false);
  assert.equal((await staff(rotated, 'GET', 'state')).status, 401);
  assert.equal((await pub('GET', '/api/public/curbside/s/state', null, { 'X-Curbside-Staff-Key': `${l.id}.${tok(l)}` })).status, 401);
  // A new customer link: the old QR codes stop working.
  const nc = (await api('POST', `/api/curbside/${l.id}/customer-link`)).body;
  assert.equal((await state(l, cid())).status, 404);
  assert.equal((await state(nc, cid())).status, 200);
});

test('a staff key is compared in constant time and is never a lookup key', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'curbside', 'service.js'), 'utf8');
  assert.match(src, /timingSafeEqual\(sha\(stored\), sha\(token\)\)/);
  assert.doesNotMatch(src, /WHERE staff_token = \?/);
  const l = svc.create(db, { workspaceId: WS, name: 'K', timezone: 'UTC', spotsCount: 2 });
  assert.equal(svc.byStaffKey(db, `${l.id}.${l.staff_token}`).id, l.id);
  assert.equal(svc.byStaffKey(db, `${l.id}.${svc.newToken()}`), null);
  assert.equal(svc.byStaffKey(db, l.staff_token), null);
  assert.equal(svc.byStaffKey(db, `${l.id}.${l.public_token}`), null);
});

test('a read-only member sees locations without the staff link and cannot change anything; other workspaces see nothing', async () => {
  const l = await newLocation();
  await checkin(l, cid(), { spot: '1', order_ref: '1' });
  const id = (await staff(l, 'GET', 'state')).body.arrivals[0].id;
  const list = await api('GET', '/api/curbside', null, V);
  assert.equal(list.status, 200);
  const mine = list.body.find((x) => x.id === l.id);
  assert.ok(mine);
  assert.equal(mine.staff_path, undefined);
  assert.equal(mine.can_write, false);
  assert.ok(!JSON.stringify(list.body).includes(keyOf(l).split('.')[1]));
  assert.equal((await api('GET', `/api/curbside/${l.id}/qr-sheet`, null, V)).status, 200, 'a viewer can print the QR codes');
  for (const [m, p] of [['POST', '/ack'], ['POST', '/done'], ['POST', '/staff-link'], ['DELETE', '/staff-link'], ['POST', '/customer-link'], ['PUT', ''], ['DELETE', '']]) {
    assert.equal((await api(m, `/api/curbside/${l.id}${p}`, { id, name: 'x' }, V)).status, 403, `${m} ${p}`);
  }
  assert.equal((await api('POST', '/api/curbside', { name: 'nope' }, V)).status, 403);
  assert.equal((await api('GET', `/api/curbside/${l.id}`, null, U2, WS2)).status, 404);
  assert.equal((await api('POST', `/api/curbside/${l.id}/ack`, { id }, U2, WS2)).status, 404);
  assert.ok(!(await api('GET', '/api/curbside', null, U2, WS2)).body.some((x) => x.id === l.id));
  // A widget cannot name another workspace's location.
  const theirs = (await api('POST', '/api/curbside', { name: 'Theirs' }, U2, WS2)).body;
  assert.equal((await api('POST', '/api/widgets', { widget_type: 'curbside', name: 'X', config: { location_id: theirs.id } })).status, 400);
  // The dashboard can act for a writer.
  const acked = await api('POST', `/api/curbside/${l.id}/ack`, { id });
  assert.equal(acked.body.arrivals[0].status, 'seen');
});

test('the QR sheet has one code per spot, each for that spot', async () => {
  const l = await newLocation({ spots_count: undefined, spots: ['A1', 'B 2'] });
  const r = await api('GET', `/api/curbside/${l.id}/qr-sheet?origin=${encodeURIComponent('https://shop.example')}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.codes.length, 2);
  assert.equal(r.body.codes[1].spot, 'B 2');
  assert.equal(r.body.codes[1].url, `https://shop.example/curbside/${tok(l)}?spot=B%202`);
  assert.match(r.body.codes[0].svg, /^<svg|^<\?xml/);
  // A javascript: origin is ignored.
  const j = await api('GET', `/api/curbside/${l.id}/qr-sheet?origin=${encodeURIComponent('javascript:alert(1)')}`);
  assert.ok(j.body.codes[0].url.startsWith('http'));
});

test('open arrivals expire at local midnight in the location timezone; old rows are purged after 7 days', () => {
  const day0 = Date.UTC(2026, 0, 10, 15, 0);     // 09:00 in Chicago
  let l = svc.create(db, { workspaceId: WS, name: 'Mid', timezone: 'America/Chicago', spotsCount: 3, nowMs: day0 });
  const c1 = cid();
  svc.checkIn(db, l, { spot: '1', orderRef: '11', clientId: c1, nowMs: day0 });
  const r2 = svc.checkIn(db, l, { spot: '2', orderRef: '22', clientId: cid(), nowMs: day0 + 1000 });
  svc.done(db, l, r2.arrival.id, { nowMs: day0 + 2000 });
  // 05:59 UTC on the 11th is 23:59 on the 10th in Chicago: still open.
  l = svc.current(db, svc.load(db, l.id), Date.UTC(2026, 0, 11, 5, 59));
  assert.equal(svc.openArrivals(db, l).length, 1);
  // 06:01 UTC is just after midnight in Chicago: the open one expires and the spot is free.
  const before = l.rev;
  l = svc.current(db, svc.load(db, l.id), Date.UTC(2026, 0, 11, 6, 1));
  assert.equal(l.day, '2026-01-11');
  assert.ok(l.rev > before);
  assert.equal(svc.openArrivals(db, l).length, 0);
  assert.equal(db.prepare("SELECT status FROM curbside_arrivals WHERE location_id = ? AND order_ref = '11'").get(l.id).status, 'expired');
  assert.equal(svc.clientArrival(db, l, c1), null, 'yesterday\'s check-in is not shown to the phone');
  assert.equal(svc.checkIn(db, l, { spot: '1', orderRef: '33', clientId: c1, nowMs: Date.UTC(2026, 0, 11, 6, 2) }).existing, false);
  // 8 days later the day roll purges rows older than 7 days.
  l = svc.current(db, svc.load(db, l.id), Date.UTC(2026, 0, 19, 18, 0));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM curbside_arrivals WHERE location_id = ?').get(l.id).n, 0);
  // The daily sweep purges locations nobody touched.
  const quiet = svc.create(db, { workspaceId: WS, name: 'Quiet', timezone: 'UTC', spotsCount: 1, nowMs: day0 });
  svc.checkIn(db, quiet, { spot: '1', orderRef: '1', clientId: cid(), nowMs: day0 });
  assert.ok(svc.purgeOld(db, day0 + 8 * 86400000) >= 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM curbside_arrivals WHERE location_id = ?').get(quiet.id).n, 0);
});

test('check-ins are limited per address; asking again for your own never is', async () => {
  const l = await newLocation({ spots_count: 40 });
  const ip = '203.0.113.77';
  let limited = 0;
  let held = null;
  for (let i = 1; i <= 25; i++) {
    const c = cid();
    const r = await checkin(l, c, { spot: String(i), order_ref: String(i) }, ip);
    if (r.status === 429) { assert.equal(r.body.code, 'rate_limited'); limited++; continue; }
    assert.equal(r.status, 201, JSON.stringify(r.body));
    // Keep the first one open; close the rest so the open-per-address cap is not what refuses them.
    if (!held) held = c;
    else svc.done(db, svc.load(db, l.id), svc.clientArrival(db, svc.load(db, l.id), c).id);
  }
  assert.ok(limited >= 5, `got ${limited} refusals`);
  assert.equal((await checkin(l, held, { spot: '1', order_ref: '1' }, ip)).status, 200);
  assert.equal((await checkin(l, cid(), { spot: '30', order_ref: '30' }, '203.0.113.78')).status, 201);
});

test('one address cannot fill every spot by rotating client ids: at most 2 OPEN check-ins per address', async () => {
  const l = await newLocation({ spots_count: 10 });
  const ip = '203.0.113.150';
  const a = cid(), b = cid(), c = cid();
  assert.equal((await checkin(l, a, { spot: '1', order_ref: '1' }, ip)).status, 201);
  assert.equal((await checkin(l, b, { spot: '2', order_ref: '2' }, ip)).status, 201);
  const third = await checkin(l, c, { spot: '3', order_ref: '3' }, ip);
  assert.equal(third.status, 429);
  assert.equal(third.body.code, 'open_limit');
  assert.match(third.body.error, /already has 2 cars checked in here/);
  // The phones already checked in still get their own check-in back.
  assert.equal((await checkin(l, a, { spot: '1', order_ref: '1' }, ip)).status, 200);
  // Another address is unaffected.
  assert.equal((await checkin(l, cid(), { spot: '4', order_ref: '4' }, '203.0.113.151')).status, 201);
  // When one closes, the address may check in again.
  const id = svc.clientArrival(db, svc.load(db, l.id), a).id;
  await staff(l, 'POST', 'done', { id });
  assert.equal((await checkin(l, c, { spot: '3', order_ref: '3' }, ip)).status, 201);
  // Only a keyed hash is stored, only while open, never the address.
  const rows = db.prepare('SELECT status, ip_key FROM curbside_arrivals WHERE location_id = ?').all(l.id);
  assert.ok(rows.every((r) => !String(r.ip_key || '').includes('203.0.113')));
  assert.ok(rows.filter((r) => r.status === 'done').every((r) => r.ip_key === null), 'cleared when closed');
  assert.ok(rows.filter((r) => r.status === 'waiting').every((r) => typeof r.ip_key === 'string' && r.ip_key.length >= 16));
});

test('IPv6: the 2-open cap counts the /64, not each address in it', async () => {
  const l = await newLocation({ spots_count: 10 });
  assert.equal((await checkin(l, cid(), { spot: '1', order_ref: '1' }, '2001:db8:aa:1::10')).status, 201);
  assert.equal((await checkin(l, cid(), { spot: '2', order_ref: '2' }, '2001:db8:aa:1::11')).status, 201);
  const third = await checkin(l, cid(), { spot: '3', order_ref: '3' }, '2001:db8:aa:1:ffff:1:2:3');
  assert.equal(third.status, 429, 'a fresh address in the same /64 is the same network');
  assert.equal(third.body.code, 'open_limit');
  assert.equal((await checkin(l, cid(), { spot: '4', order_ref: '4' }, '2001:db8:aa:2::10')).status, 201, 'another /64 is another network');
});

test('re-casing a spot label moves the car waiting there, so the spot cannot take a second car', async () => {
  const l = await newLocation({ spots_count: undefined, spots: 'a, b' });
  assert.equal((await checkin(l, cid(), { spot: 'a', order_ref: '1' }, freshIp())).status, 201);
  assert.equal((await api('PUT', `/api/curbside/${l.id}`, { spots: 'A, b' })).status, 200);
  const second = await checkin(l, cid(), { spot: 'A', order_ref: '2' }, freshIp());
  assert.equal(second.status, 409, JSON.stringify(second.body));
  assert.equal(second.body.code, 'spot_taken');
  assert.deepEqual(svc.openArrivals(db, svc.load(db, l.id)).map((a) => a.spot), ['A']);
});

test('changing the timezone to one on another date never expires the cars waiting', async () => {
  // 14:00 on Jan 10 in Chicago is already 05:00 on Jan 11 in Tokyo.
  const t0 = Date.UTC(2026, 0, 10, 20, 0);
  let l = svc.create(db, { workspaceId: WS, name: 'TZ', timezone: 'America/Chicago', spotsCount: 3, nowMs: t0 });
  const me = cid();
  svc.checkIn(db, l, { spot: '1', orderRef: '11', clientId: me, nowMs: t0 });
  l = svc.update(db, svc.load(db, l.id), { timezone: 'Asia/Tokyo' }, t0 + 1000);
  assert.equal(l.day, '2026-01-11');
  assert.equal(svc.openArrivals(db, l).length, 1, 'still waiting after the timezone change');
  assert.equal(svc.clientArrival(db, l, me).status, 'waiting', 'the phone still sees its check-in');
  l = svc.current(db, svc.load(db, l.id), t0 + 2000);
  assert.equal(svc.openArrivals(db, l).length, 1, 'and on the next poll');
  // And back again (the date moves backwards).
  l = svc.update(db, svc.load(db, l.id), { timezone: 'America/Chicago' }, t0 + 3000);
  assert.equal(l.day, '2026-01-10');
  assert.equal(svc.openArrivals(db, l).length, 1);
  // A real midnight still closes it.
  l = svc.current(db, svc.load(db, l.id), Date.UTC(2026, 0, 11, 6, 1));
  assert.equal(svc.openArrivals(db, l).length, 0);
  // Through the dashboard route too.
  const r = await newLocation({ timezone: 'Pacific/Kiritimati' });   // UTC+14: usually a different date
  await checkin(r, cid(), { spot: '1', order_ref: '5' });
  const moved = await api('PUT', `/api/curbside/${r.id}`, { timezone: 'Pacific/Pago_Pago' });   // UTC-11
  assert.equal(moved.status, 200);
  assert.notEqual(moved.body.day, r.day, 'the two zones are a day apart');
  assert.equal(moved.body.arrivals.length, 1, 'the car is still on the list');
});

test('a blank spots value means the default 10 spots', async () => {
  assert.equal(svc.create(db, { workspaceId: WS, name: 'B', timezone: 'UTC', spots: '' }).spots, JSON.stringify(Array.from({ length: 10 }, (_, i) => String(i + 1))));
  assert.equal(JSON.parse(svc.create(db, { workspaceId: WS, name: 'B2', timezone: 'UTC', spots: '   ', spotsCount: '' }).spots).length, 10);
  const r = await api('POST', '/api/curbside', { name: 'Blank', spots: '' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.spots.length, 10);
  // A list with no usable label is still refused.
  assert.equal((await api('POST', '/api/curbside', { name: 'x', spots: ' , ' })).status, 400);
});

test('a deleted workspace or location takes its arrivals with it; the export classifies both tables', async () => {
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run('ws-cs-gone', O, 'Gone');
  const l = svc.create(db, { workspaceId: 'ws-cs-gone', name: 'G', timezone: 'UTC', spotsCount: 2 });
  svc.checkIn(db, l, { spot: '1', orderRef: '1', clientId: cid() });
  require('../lib/user-deletion').deleteWorkspaceCascade(db, { workspaceId: 'ws-cs-gone', unlink: () => {} });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM curbside_locations WHERE id = ?').get(l.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM curbside_arrivals WHERE location_id = ?').get(l.id).n, 0);
  const d = await newLocation();
  await checkin(d, cid(), { spot: '1', order_ref: '1' });
  assert.equal((await api('DELETE', `/api/curbside/${d.id}`)).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM curbside_arrivals WHERE location_id = ?').get(d.id).n, 0);
  const exp = require('../lib/trust/export-tables');
  const imp = require('../lib/trust/import-tables');
  assert.ok(exp.EXPORTED.curbside_locations);
  assert.ok(exp.EXCLUDED.curbside_arrivals);
  assert.ok(imp.NOT_RESTORED.curbside_locations);
});

test('the customer token in a path never names its own rate-limit bucket', () => {
  const { canonicalLimitPath } = require('../lib/limit-paths');
  const t = svc.newToken();
  assert.equal(canonicalLimitPath(`/curbside/${t}`), '/curbside/:token');
  for (const a of ['state', 'checkin', 'cancel']) assert.equal(canonicalLimitPath(`/api/public/curbside/c/${t}/${a}`), `/api/public/curbside/c/:token/${a}`);
});

test('scale-out: on a node holding a COPY of the workspace, every customer and staff call goes to the primary', async () => {
  const l = await newLocation({ name: 'Copy lot' });
  const me = cid();
  await checkin(l, me, { spot: '1', order_ref: '1' });
  const before = db.prepare('SELECT * FROM curbside_locations WHERE id = ?').get(l.id);
  db.prepare('UPDATE workspaces SET origin_node_id = ? WHERE id = ?').run('primary-node-uuid', WS);
  try {
    const calls = [
      await state(l, me, '1'),
      await checkin(l, cid(), { spot: '2', order_ref: '2' }),
      await cancel(l, me),
      await staff(l, 'GET', 'state'),
      await staff(l, 'POST', 'ack', { id: 1 }),
      await staff(l, 'POST', 'done', { id: 1 }),
    ];
    for (const r of calls) {
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.code, 'read_only_replica');
    }
    assert.deepEqual(db.prepare('SELECT * FROM curbside_locations WHERE id = ?').get(l.id), before, 'the copy was not written');
    const bad = await pub('POST', '/api/public/curbside/s/ack', { id: 1 }, { 'X-Curbside-Staff-Key': l.id + '.' + 'A'.repeat(43) });
    assert.equal(bad.status, 401);
  } finally {
    db.prepare('UPDATE workspaces SET origin_node_id = NULL WHERE id = ?').run(WS);
  }
  assert.equal((await staff(l, 'GET', 'state')).status, 200);
});
