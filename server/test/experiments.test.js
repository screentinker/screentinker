'use strict';

/*
 * Experiments (lib/experiments, routes/experiments.js, docs/experiments.md).
 *
 *   - assignment: balanced (arm sizes differ by ≤ 1), stratified, stable for the same test
 *   - time mode: every local hour of the week belongs to exactly one variant, and each variant gets
 *     equal hours on every weekday; the item's own dayparting is respected
 *   - resolution: starting rewrites the slot into ordinary rows and publishes; every screen's payload
 *     carries exactly one variant and NO new field a player would have to know; stopping restores the
 *     published snapshot byte for byte; rolling out leaves the winner
 *   - Square and Shopify orders → hourly aggregates, from official response shapes through a fake
 *     transport; no customer field is stored; the token goes only to the provider's fixed host
 *   - attribution windows: an hour counts only when one variant was on screen for it and the window
 *   - statistics on synthetic data: a known lift is found with an interval around it; no lift is not
 *     called a winner
 *   - CSV upload validation; tenancy (another workspace sees nothing); a viewer reads but cannot write
 */

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-exp-' + crypto.randomBytes(4).toString('hex'));
process.env.JWT_SECRET = 'test-secret-experiments';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { Server } = require('socket.io');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const setupDeviceSocket = require('../ws/deviceSocket');
const ScheduleEval = require('../lib/schedule-eval');
const assign = require('../lib/experiments/assign');
const stats = require('../lib/experiments/stats');
const sales = require('../lib/experiments/sales');
const data = require('../lib/experiments/data');
const analyze = require('../lib/experiments/analyze');
const core = require('../lib/experiments/core');
const pos = require('../lib/data-sources/pos-common');
const { UserFacingError, STATUS_HINTS } = require('../lib/data-sources/http');
const { encryptSecrets, fieldsForDataSource } = require('../lib/plugins/secrets');

const O = 'o-exp', WS = 'ws-exp', WS2 = 'ws-exp-2', U = 'u-exp', V = 'u-exp-v', U2 = 'u-exp-2';
const SQ_TOKEN = 'EAAAlSQUARE-EXP-' + crypto.randomBytes(8).toString('hex');
const SHP_TOKEN = 'shpat_EXPSECRET' + crypto.randomBytes(8).toString('hex');
const H = 3600, DAY = 86400;

let server, base;
const tokenOf = (u, ws = WS) => generateToken(db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(u), ws);
async function api(method, p, body, who = U, ws = WS) {
  const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${tokenOf(who, ws)}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}

/* ── fake POS transport (same contract as test/pos-menus.test.js) ─────────────────────────── */
let calls = [];
let routes = null;
pos._setTransportForTests(async (url, opts) => {
  calls.push({ url, method: opts.method || 'GET', headers: { ...(opts.headers || {}) }, body: opts.body == null ? null : String(opts.body) });
  if (!routes) throw new Error('no fake route');
  return routes(url, opts);
});
const json = (o) => ({ text: JSON.stringify(o), contentType: 'application/json', status: 200 });
const httpError = (status) => new UserFacingError(STATUS_HINTS[status] || `The server answered HTTP ${status}.`, 'upstream-status');

before(async () => {
  db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, 'e@t.local', 'x', 'user'), (?, 'ev@t.local', 'x', 'user'), (?, 'e2@t.local', 'x', 'user')").run(U, V, U2);
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(O, 'Org', U);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?), (?, ?, ?)').run(WS, O, 'WS', WS2, O, 'WS2');
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor'), (?, ?, 'workspace_viewer'), (?, ?, 'workspace_editor')").run(WS, U, WS, V, WS2, U2);
  for (const [id, ws] of [['c-a', WS], ['c-b', WS], ['c-c', WS], ['c-x', WS2]]) {
    db.prepare("INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type) VALUES (?, ?, ?, ?, ?, 'image/png')").run(id, U, ws, `${id}.png`, `${id}.png`);
  }
  setupDeviceSocket(new Server(http.createServer()));
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/experiments', requireAuth, resolveTenancy, require('../routes/experiments'));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { try { server.close(); } catch { /* */ } });

/** A published playlist with one image item, played by `screens` ([{ id, location }]). */
function setupPlaylist(id, screens, { schedules = null } = {}) {
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name, status) VALUES (?, ?, ?, ?, 'draft')").run(id, U, WS, id);
  db.prepare("INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES (?, 'c-c', 0, 8)").run(id);
  const item = db.prepare("INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES (?, 'c-a', 1, 10)").run(id);
  const itemId = Number(item.lastInsertRowid);
  if (schedules) {
    schedules.forEach((b, i) => db.prepare('INSERT INTO playlist_item_schedules (id, playlist_item_id, active_days, start_time, end_time, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), itemId, b.days.join(','), b.start, b.end, i));
  }
  require('../routes/playlists').publishPlaylist(id, null);
  for (const s of screens) {
    db.prepare("INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, playlist_id, playlist_source, location_label, timezone) VALUES (?, ?, ?, ?, ?, ?, 'device', ?, ?)")
      .run(s.id, U, WS, s.id, 'p-' + s.id, id, s.location || null, s.tz || 'UTC');
  }
  return itemId;
}

const payloadNames = (deviceId) => setupDeviceSocket.buildPlaylistPayloadUnchecked(deviceId).assignments.map((a) => a.content_id);

/* ── assignment ──────────────────────────────────────────────────────────────────────────── */

test('location assignment is balanced, stratified on the baseline, and stable for the same test', () => {
  for (const n of [2, 3, 4]) {
    for (const count of [n, n + 1, 7, 10, 23]) {
      const units = Array.from({ length: count }, (_, i) => ({ key: `u${i}` }));
      const a = assign.assignLocations(units, n, 'seed-1');
      const sizes = new Array(n).fill(0);
      for (const k of Object.values(a)) sizes[k]++;
      assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `n=${n} count=${count}: ${sizes}`);
      assert.deepEqual(assign.assignLocations(units, n, 'seed-1'), a, 'same test, same answer');
    }
  }
  // Stratified: with a baseline, the two biggest stores are never on the same side (pairs of 2).
  const units = Array.from({ length: 8 }, (_, i) => ({ key: `s${i}` }));
  const baseline = Object.fromEntries(units.map((u, i) => [u.key, (i + 1) * 100]));
  for (const seed of ['a', 'b', 'c', 'd', 'e']) {
    const a = assign.assignLocations(units, 2, seed, baseline);
    assert.notEqual(a.s7, a.s6, 'the two biggest stores land in different arms');
    assert.notEqual(a.s0, a.s1, 'and so do the two smallest');
  }
  // Grouping: screens with the same location label are ONE location; unlabelled screens are their own.
  const g = assign.unitsFromDevices([{ id: 'd1', location_label: 'Main St' }, { id: 'd2', location_label: ' main  st ' }, { id: 'd3' }]);
  assert.equal(g.length, 2);
  assert.deepEqual(g.find((u) => u.key === 'loc:main st').device_ids, ['d1', 'd2']);
});

test('time mode: each local hour of the week has exactly one variant, balanced per weekday', () => {
  for (const n of [2, 3, 4]) {
    for (const bh of assign.BLOCK_HOURS) {
      const blocks = Array.from({ length: n }, (_, k) => assign.timeBlocks(k, n, bh));
      const perWeekday = Array.from({ length: 7 }, () => new Array(n).fill(0));
      for (let wd = 0; wd < 7; wd++) {
        for (let h = 0; h < 24; h++) {
          const on = blocks.map((bl) => bl.some((b) => b.days.includes(wd) && ScheduleEval._blockMatches(b, { y: 2026, mo: 10, day: 14, dow: wd, min: h * 60 + 30 })));
          assert.equal(on.filter(Boolean).length, 1, `n=${n} bh=${bh} wd=${wd} h=${h}`);
          perWeekday[wd][on.indexOf(true)]++;
          assert.equal(on.indexOf(true), assign.timeVariantAt(wd, h, n, bh));
        }
      }
      if (24 % (n * bh) === 0) for (const row of perWeekday) assert.ok(row.every((x) => x === 24 / n), `n=${n} bh=${bh}: ${row}`);
      // Rotation: variant A does not own the same hour every day.
      const at9 = new Set([0, 1, 2, 3, 4, 5, 6].map((wd) => assign.timeVariantAt(wd, 9, n, bh)));
      assert.equal(at9.size, n);
    }
  }
});

test('time mode respects the item\'s own dayparting (intersection)', () => {
  const own = [{ days: [1, 2, 3, 4, 5], start: '07:00', end: '11:00' }];
  const turn = assign.timeBlocks(0, 2, 1);
  const both = assign.intersectBlocks(own, turn);
  for (let wd = 0; wd < 7; wd++) {
    for (let h = 0; h < 24; h++) {
      const want = wd >= 1 && wd <= 5 && h >= 7 && h < 11 && assign.timeVariantAt(wd, h, 2, 1) === 0;
      const got = both.some((b) => b.days.includes(wd) && ScheduleEval._blockMatches(b, { y: 2026, mo: 10, day: 14, dow: wd, min: h * 60 + 5 }));
      assert.equal(got, want, `wd=${wd} h=${h}`);
    }
  }
});

/* ── resolution to playlists ─────────────────────────────────────────────────────────────── */

let LOC;   // the location-mode experiment
test('location mode: start rewrites the slot, each screen gets exactly one variant, players see nothing new', async () => {
  const screens = ['north', 'south', 'east', 'west'].flatMap((loc) => [{ id: `d-${loc}-1`, location: loc }, { id: `d-${loc}-2`, location: loc }]);
  const itemId = setupPlaylist('pl-loc', screens);
  const before = db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get('pl-loc').published_snapshot;
  const beforeItemKeys = Object.keys(JSON.parse(before)[1]).sort();

  let r = await api('POST', '/api/experiments', {
    name: 'Latte sign', mode: 'location', playlist_id: 'pl-loc', slot_item_id: itemId,
    variants: [{ kind: 'content', id: 'c-a' }, { kind: 'content', id: 'c-b' }],
    config: { outcome: { source: 'csv', metric: 'value' } },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  LOC = r.body;
  assert.equal(LOC.status, 'draft');
  r = await api('GET', `/api/experiments/${LOC.id}`);
  assert.equal(r.body.units.length, 4, 'four locations of two screens each');

  r = await api('POST', `/api/experiments/${LOC.id}/start`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'running');

  const units = core.unitsOf(LOC.id);
  const sizes = [0, 0];
  for (const u of units) sizes[u.variant]++;
  assert.deepEqual(sizes, [2, 2], 'balanced: two locations each');
  for (const u of units) {
    const want = u.variant === 0 ? 'c-a' : 'c-b';
    for (const d of u.device_ids) {
      const ids = payloadNames(d);
      assert.deepEqual(ids, ['c-c', want], `${d} (${u.label}) shows only its variant, in the slot's place`);
    }
  }
  // Players learn nothing: the items they receive have the same keys as before the test, and no
  // 'screens' condition survives into a payload.
  for (const d of units[0].device_ids) {
    for (const a of setupDeviceSocket.buildPlaylistPayloadUnchecked(d).assignments) {
      assert.ok(!a.play_when || a.play_when.type !== 'screens', 'stripped before sending');
      assert.ok(!('experiment_id' in a), 'no experiment field reaches a player');
    }
  }
  const snap = JSON.parse(db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get('pl-loc').published_snapshot);
  assert.equal(snap.length, 3);
  assert.deepEqual(Object.keys(snap[1]).filter((k) => k !== 'play_when').sort(), beforeItemKeys.filter((k) => k !== 'play_when'));

  // A screen added mid-test (no assignment) gets the control, not a gap.
  db.prepare("INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, playlist_id, playlist_source) VALUES ('d-new', ?, ?, 'new', 'p-new', 'pl-loc', 'device')").run(U, WS);
  assert.deepEqual(payloadNames('d-new'), ['c-c', 'c-a']);

  // Stable: a second start is refused, and nothing reassigns.
  r = await api('POST', `/api/experiments/${LOC.id}/start`);
  assert.equal(r.status, 409);
  assert.deepEqual(core.unitsOf(LOC.id).map((u) => u.variant), units.map((u) => u.variant));

  // Stop: the slot is restored and the published snapshot is byte-identical to before the test.
  r = await api('POST', `/api/experiments/${LOC.id}/stop`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'stopped');
  assert.equal(db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get('pl-loc').published_snapshot, before);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM playlist_items WHERE experiment_id IS NOT NULL').get().n, 0);

  // Roll out the winner after the fact: B replaces the slot for good, everywhere.
  r = await api('POST', `/api/experiments/${LOC.id}/rollout`, { variant: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'rolled_out');
  assert.equal(r.body.winner, 1);
  for (const d of ['d-north-1', 'd-south-2', 'd-new']) assert.deepEqual(payloadNames(d), ['c-c', 'c-b']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM playlist_items WHERE playlist_id = ?').get('pl-loc').n, 2, 'no variant rows left behind');
});

test('a playlist "discard" during the test (rows rebuilt without markers, new ids) still stops cleanly', async () => {
  const itemId = setupPlaylist('pl-disc', [{ id: 'd-x1', location: 'x' }, { id: 'd-x2', location: 'y' }]);
  const before = db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get('pl-disc').published_snapshot;
  let r = await api('POST', '/api/experiments', { name: 'Disc', mode: 'location', playlist_id: 'pl-disc', slot_item_id: itemId,
    variants: [{ kind: 'content', id: 'c-a' }, { kind: 'content', id: 'c-b' }], config: { outcome: { source: 'csv', metric: 'value' } } });
  const id = r.body.id;
  assert.equal((await api('POST', `/api/experiments/${id}/start`)).status, 200);
  // What routes/playlists.js discard does: every row re-created from published_structure.
  db.transaction(() => {
    const rows = db.prepare('SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY id').all('pl-disc');
    db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run('pl-disc');
    for (const row of rows) {
      db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec, play_when) VALUES (?, ?, ?, ?, ?)').run('pl-disc', row.content_id, row.sort_order, row.duration_sec, row.play_when);
    }
  })();
  r = await api('POST', `/api/experiments/${id}/stop`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get('pl-disc').published_snapshot, before);
});

test('time mode: variants take turns on the same screen; schedules are ordinary item blocks', async () => {
  const itemId = setupPlaylist('pl-time', [{ id: 'd-t1', location: 'cafe' }], { schedules: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '06:00', end: '22:00' }] });
  const before = db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get('pl-time').published_snapshot;
  let r = await api('POST', '/api/experiments', {
    name: 'Cafe hours', mode: 'time', playlist_id: 'pl-time', slot_item_id: itemId,
    variants: [{ kind: 'content', id: 'c-a' }, { kind: 'content', id: 'c-b' }],
    config: { outcome: { source: 'csv', metric: 'value' }, block_hours: 2 },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.id;
  r = await api('POST', `/api/experiments/${id}/start`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const snap = JSON.parse(db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get('pl-time').published_snapshot);
  const variants = snap.filter((it) => it.content_id === 'c-a' || it.content_id === 'c-b');
  assert.equal(variants.length, 2);
  // Every minute of the week: exactly one variant inside 06-22, none outside (the item's own daypart).
  for (let day = 0; day < 7; day++) {
    for (let h = 0; h < 24; h++) {
      const at = Date.UTC(2026, 9, 11 + day, h, 30);   // 2026-10-11 is a Sunday
      const on = variants.filter((it) => ScheduleEval.itemShouldPlay(it, at, 'UTC')).map((it) => it.content_id);
      if (h < 6 || h >= 22) assert.deepEqual(on, [], `day ${day} ${h}:30`);
      else assert.deepEqual(on, [assign.timeVariantAt(day, h, 2, 2) === 0 ? 'c-a' : 'c-b'], `day ${day} ${h}:30`);
    }
  }
  r = await api('POST', `/api/experiments/${id}/stop`);
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get('pl-time').published_snapshot, before, 'restored byte for byte, schedules included');
});

test('refusals: unpublished edits, approvals, a smart playlist, too few locations, a variant from another workspace', async () => {
  const itemId = setupPlaylist('pl-ref', [{ id: 'd-r1', location: 'only' }]);
  const body = (o = {}) => ({ name: 'T', mode: 'location', playlist_id: 'pl-ref', slot_item_id: itemId,
    variants: [{ kind: 'content', id: 'c-a' }, { kind: 'content', id: 'c-b' }], config: { outcome: { source: 'csv', metric: 'value' } }, ...o });
  let r = await api('POST', '/api/experiments', body({ variants: [{ kind: 'content', id: 'c-a' }, { kind: 'content', id: 'c-x' }] }));
  assert.equal(r.status, 404, 'content of another workspace');
  r = await api('POST', '/api/experiments', body({ variants: [{ kind: 'content', id: 'c-a' }, { kind: 'content', id: 'c-a' }] }));
  assert.equal(r.status, 400, 'two identical variants');
  r = await api('POST', '/api/experiments', body());
  assert.equal(r.status, 201);
  const id = r.body.id;
  r = await api('POST', `/api/experiments/${id}/start`);
  assert.equal(r.status, 409, 'one location cannot be split two ways');
  assert.equal(r.body.code, 'EXPERIMENT_FEW_LOCATIONS');
  db.prepare("INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, playlist_id, playlist_source, location_label) VALUES ('d-r2', ?, ?, 'r2', 'p-r2', 'pl-ref', 'device', 'other')").run(U, WS);

  db.prepare("UPDATE playlists SET status = 'draft' WHERE id = 'pl-ref'").run();
  r = await api('POST', `/api/experiments/${id}/start`);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'EXPERIMENT_PLAYLIST_DRAFT', 'never publishes somebody else\'s draft');
  db.prepare("UPDATE playlists SET status = 'published' WHERE id = 'pl-ref'").run();

  db.prepare('UPDATE workspaces SET require_approval = 1 WHERE id = ?').run(WS);
  r = await api('POST', `/api/experiments/${id}/start`);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'EXPERIMENT_APPROVALS');
  db.prepare('UPDATE workspaces SET require_approval = 0 WHERE id = ?').run(WS);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM playlist_items WHERE experiment_id = ?').get(id).n, 0, 'a refused start changes nothing');

  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name, smart_rules) VALUES ('pl-smart', ?, ?, 's', '{}')").run(U, WS);
  r = await api('POST', '/api/experiments', body({ playlist_id: 'pl-smart' }));
  assert.equal(r.status, 400);
  r = await api('DELETE', `/api/experiments/${id}`);
  assert.equal(r.status, 200);
});

/* ── tenancy and viewers ─────────────────────────────────────────────────────────────────── */

test('another workspace sees nothing; a viewer reads results but cannot change anything', async () => {
  let r = await api('GET', '/api/experiments', null, U2, WS2);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, []);
  for (const [m, p] of [['GET', ''], ['GET', '/results'], ['POST', '/start'], ['POST', '/stop'], ['DELETE', '']]) {
    r = await api(m, `/api/experiments/${LOC.id}${p}`, null, U2, WS2);
    assert.equal(r.status, 404, `${m} ${p} from another workspace`);
  }
  r = await api('GET', `/api/experiments/${LOC.id}/results`, null, V);
  assert.equal(r.status, 200, 'a viewer can read results');
  for (const [m, p, b] of [['POST', '', {}], ['PUT', `/${LOC.id}`, { name: 'x' }], ['POST', `/${LOC.id}/start`], ['POST', `/${LOC.id}/stop`],
    ['POST', `/${LOC.id}/rollout`, { variant: 0 }], ['POST', `/${LOC.id}/import-sales`], ['POST', `/${LOC.id}/outcomes/csv`, { csv: 'a' }],
    ['PUT', `/${LOC.id}/units`, { units: [] }], ['DELETE', `/${LOC.id}`]]) {
    r = await api(m, `/api/experiments${p}`, b, V);
    assert.equal(r.status, 403, `viewer ${m} ${p}`);
  }
  // A playlist of another workspace cannot be the slot.
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name, status) VALUES ('pl-other', ?, ?, 'o', 'published')").run(U2, WS2);
  const it = db.prepare("INSERT INTO playlist_items (playlist_id, content_id) VALUES ('pl-other', 'c-x')").run();
  r = await api('POST', '/api/experiments', { name: 'x', playlist_id: 'pl-other', slot_item_id: Number(it.lastInsertRowid), variants: [{ kind: 'content', id: 'c-a' }, { kind: 'content', id: 'c-b' }], config: { outcome: { source: 'csv' } } });
  assert.equal(r.status, 404);
});

/* ── Square / Shopify order mapping ──────────────────────────────────────────────────────── */

// Shapes from the Square SearchOrders and Shopify GraphQL Admin `orders` references.
const SQ_ORDERS = {
  orders: [
    { id: 'ORD1', location_id: 'L1', state: 'COMPLETED', created_at: '2026-10-01T15:01:00Z', closed_at: '2026-10-01T15:05:12.345Z',
      customer_id: 'CUST-SECRET-1', tenders: [{ id: 't', type: 'CARD', card_details: { card: { last_4: 'CARD-L4-SENTINEL' } } }],
      line_items: [
        { uid: 'a', name: 'Iced Latte', variation_name: 'Large', quantity: '2', catalog_object_id: 'VAR-ICED-L', base_price_money: { amount: 500, currency: 'USD' }, total_money: { amount: 1000, currency: 'USD' } },
        { uid: 'b', name: 'Croissant', quantity: '1', catalog_object_id: 'VAR-CROI', total_money: { amount: 350, currency: 'USD' } },
      ],
      total_money: { amount: 1350, currency: 'USD' } },
    { id: 'ORD2', location_id: 'L1', state: 'COMPLETED', closed_at: '2026-10-01T15:59:59Z',
      line_items: [{ uid: 'c', name: 'Croissant', quantity: '3', catalog_object_id: 'VAR-CROI', total_money: { amount: 1050, currency: 'USD' } }], total_money: { amount: 1050, currency: 'USD' } },
    { id: 'ORD3', location_id: 'L2', state: 'OPEN', closed_at: null, line_items: [{ name: 'Iced Latte', quantity: '9' }] },
    { id: 'ORD4', location_id: 'L2', state: 'COMPLETED', closed_at: '2026-10-01T16:10:00Z',
      line_items: [{ uid: 'd', name: 'Iced Latte', variation_name: 'Large', quantity: '1', catalog_object_id: 'VAR-ICED-L', total_money: { amount: 500, currency: 'USD' } }], total_money: { amount: 500, currency: 'USD' } },
  ],
};
const shopifyOrders = (nodes, { scopes = ['read_orders', 'read_products'], next = null } = {}) => ({
  data: {
    shop: { currencyCode: 'EUR' },
    currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) },
    orders: { pageInfo: { hasNextPage: !!next, endCursor: next }, nodes },
  },
  extensions: { cost: { requestedQueryCost: 642, actualQueryCost: 40, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1958, restoreRate: 100 } } },
});
const SHP_NODES = [
  { processedAt: '2026-10-01T09:15:00Z', cancelledAt: null, test: false, retailLocation: { id: 'gid://shopify/Location/7001' },
    lineItems: { nodes: [{ name: 'Iced Latte', sku: 'ICED-L', quantity: 2, variant: { id: 'gid://shopify/ProductVariant/41' }, product: { id: 'gid://shopify/Product/9' }, originalTotalSet: { shopMoney: { amount: '9.00', currencyCode: 'EUR' } } }] } },
  { processedAt: '2026-10-01T09:45:00Z', cancelledAt: '2026-10-01T10:00:00Z', test: false, retailLocation: { id: 'gid://shopify/Location/7001' },
    lineItems: { nodes: [{ name: 'Iced Latte', sku: 'ICED-L', quantity: 5, originalTotalSet: { shopMoney: { amount: '22.50' } } }] } },
  { processedAt: '2026-10-01T09:50:00Z', cancelledAt: null, test: true, retailLocation: null, lineItems: { nodes: [{ name: 'Iced Latte', quantity: 7 }] } },
  { processedAt: '2026-10-01T11:05:00Z', cancelledAt: null, test: false, retailLocation: null,
    lineItems: { nodes: [{ name: 'Mug', sku: 'MUG', quantity: 1, product: { id: 'gid://shopify/Product/12' }, originalTotalSet: { shopMoney: { amount: '12.00' } } }] } },
];

test('Square orders → hourly totals per location; only COMPLETED; item filter by name, "name (size)" or catalog id', () => {
  const all = sales.mapSquareOrders(SQ_ORDERS.orders);
  const h15 = Date.UTC(2026, 9, 1, 15) / 1000, h16 = Date.UTC(2026, 9, 1, 16) / 1000;
  assert.deepEqual(all.get(`L1|${h15}`), { location: 'L1', hour_utc: h15, orders: 2, units: 6, revenue: 24 });
  assert.deepEqual(all.get(`L2|${h16}`), { location: 'L2', hour_utc: h16, orders: 1, units: 1, revenue: 5 });
  assert.equal(all.size, 2, 'the OPEN order is not a sale');
  for (const filter of [['iced latte'], ['Iced Latte (Large)'], ['VAR-ICED-L']]) {
    const m = sales.mapSquareOrders(SQ_ORDERS.orders, { items: filter });
    assert.deepEqual(m.get(`L1|${h15}`), { location: 'L1', hour_utc: h15, orders: 1, units: 2, revenue: 10 }, String(filter));
  }
});

test('Shopify orders → hourly totals; cancelled and test orders skipped; web orders are "online"', () => {
  const all = sales.mapShopifyOrders(SHP_NODES);
  const h9 = Date.UTC(2026, 9, 1, 9) / 1000, h11 = Date.UTC(2026, 9, 1, 11) / 1000;
  assert.deepEqual(all.get(`7001|${h9}`), { location: '7001', hour_utc: h9, orders: 1, units: 2, revenue: 9 });
  assert.deepEqual(all.get(`online|${h11}`), { location: 'online', hour_utc: h11, orders: 1, units: 1, revenue: 12 });
  assert.equal(all.size, 2);
  for (const filter of [['ICED-L'], ['41'], ['gid://shopify/ProductVariant/41'], ['9']]) {
    const m = sales.mapShopifyOrders(SHP_NODES, { items: filter });
    assert.equal(m.get(`7001|${h9}`).units, 2, String(filter));
    assert.equal(m.get(`online|${h11}`).units, 0);
  }
  assert.throws(() => sales.checkOrderScopes({ currentAppInstallation: { accessScopes: [{ handle: 'read_products' }] } }), /read_orders/);
  assert.throws(() => sales.checkOrderScopes({ currentAppInstallation: { accessScopes: [{ handle: 'read_orders' }, { handle: 'write_orders' }] } }), /change the store/);
});

test('sales import through a saved data source: token only to the fixed host, aggregates only, no customer data', async () => {
  // Two data sources, credentials encrypted at rest exactly as routes/data-sources.js stores them.
  const sqCfg = encryptSecrets({ environment: 'production', access_token: SQ_TOKEN }, fieldsForDataSource('square'));
  const shCfg = encryptSecrets({ store_domain: 'exp-cafe.myshopify.com', connect_with: 'token', access_token: SHP_TOKEN }, fieldsForDataSource('shopify'));
  db.prepare("INSERT INTO data_sources (id, workspace_id, slug, name, type, config) VALUES ('ds-sq', ?, 'sq', 'Square', 'square', ?), ('ds-sh', ?, 'sh', 'Shopify', 'shopify', ?)").run(WS, JSON.stringify(sqCfg), WS, JSON.stringify(shCfg));
  db.prepare("INSERT INTO data_sources (id, workspace_id, slug, name, type, config) VALUES ('ds-other', ?, 'sq', 'Theirs', 'square', '{}')").run(WS2);

  const itemId = setupPlaylist('pl-sales', [{ id: 'd-s1', location: 'Main' }, { id: 'd-s2', location: 'Dock' }]);
  let r = await api('POST', '/api/experiments', {
    name: 'Sales', mode: 'location', playlist_id: 'pl-sales', slot_item_id: itemId,
    variants: [{ kind: 'content', id: 'c-a' }, { kind: 'content', id: 'c-b' }],
    config: { outcome: { source: 'sales', metric: 'units' }, sales: { data_source_ids: ['ds-other'] } },
  });
  assert.equal(r.status, 404, 'another workspace\'s POS credential cannot be borrowed');
  r = await api('POST', '/api/experiments', {
    name: 'Sales', mode: 'location', playlist_id: 'pl-sales', slot_item_id: itemId,
    variants: [{ kind: 'content', id: 'c-a' }, { kind: 'content', id: 'c-b' }],
    config: { outcome: { source: 'sales', metric: 'units' }, secondary: [{ source: 'sales', metric: 'revenue' }], sales: { data_source_ids: ['ds-sq', 'ds-sh'], items: ['Iced Latte (Large)', 'ICED-L'] }, baseline_days: 14 },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.id;
  assert.ok(!JSON.stringify(r.body).includes(SQ_TOKEN) && !JSON.stringify(r.body).includes(SHP_TOKEN));
  const units = (await api('GET', `/api/experiments/${id}`)).body.units;
  r = await api('PUT', `/api/experiments/${id}/units`, { units: [
    { unit_key: units.find((u) => u.label === 'Main').unit_key, square_location_id: 'L1', shopify_location_id: 'gid://shopify/Location/7001' },
    { unit_key: units.find((u) => u.label === 'Dock').unit_key, square_location_id: 'L2', shopify_location_id: 'online' },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.find((u) => u.label === 'Main').shopify_location_id, '7001', 'a pasted gid is stored as its number');

  calls = [];
  routes = (url, opts) => {
    if (url === 'https://connect.squareup.com/v2/orders/search') {
      const b = JSON.parse(opts.body);
      assert.deepEqual(b.query.filter.state_filter.states, ['COMPLETED']);
      assert.equal(b.query.sort.sort_field, 'CLOSED_AT');
      // Like Square: only orders closed inside the window, paged by cursor.
      const { start_at: a, end_at: z } = b.query.filter.date_time_filter.closed_at;
      const inRange = SQ_ORDERS.orders.filter((o) => b.location_ids.includes(o.location_id) && (!o.closed_at || (o.closed_at >= a && o.closed_at < z)));
      return json(b.cursor ? { orders: inRange.slice(2) } : { orders: inRange.slice(0, 2), ...(inRange.length > 2 ? { cursor: 'c2' } : {}) });
    }
    if (url === 'https://exp-cafe.myshopify.com/admin/api/2026-07/graphql.json') {
      const q = JSON.parse(opts.body).variables.query;
      const [, a, z] = /processed_at:>='([^']+)' AND processed_at:<'([^']+)'/.exec(q);
      return json(shopifyOrders(SHP_NODES.filter((n) => n.processedAt >= a && n.processedAt < z)));
    }
    throw new Error('unexpected ' + url);
  };
  const exp = core.load(id, WS);
  const res = await data.importSales(exp, { now: Date.UTC(2026, 9, 2) / 1000, ctx: { sleep: async () => {} } });
  assert.ok(res.ok, JSON.stringify(res));
  // Where the tokens went: only to the provider's own host, only in its auth header.
  for (const c of calls) {
    const host = new URL(c.url).host;
    assert.ok(['connect.squareup.com', 'exp-cafe.myshopify.com'].includes(host), c.url);
    assert.ok(!c.url.includes(SQ_TOKEN) && !c.url.includes(SHP_TOKEN));
    if (host === 'connect.squareup.com') { assert.equal(c.headers.Authorization, `Bearer ${SQ_TOKEN}`); assert.ok(!(c.body || '').includes(SHP_TOKEN)); }
    else assert.equal(c.headers['X-Shopify-Access-Token'], SHP_TOKEN);
  }
  const h15 = Date.UTC(2026, 9, 1, 15) / 1000, h9 = Date.UTC(2026, 9, 1, 9) / 1000;
  const val = (src, metric, unit, h) => (db.prepare('SELECT value FROM experiment_outcomes WHERE experiment_id = ? AND source = ? AND metric = ? AND unit_key = ? AND hour_utc = ?').get(id, src, metric, unit, h) || {}).value;
  const main = units.find((u) => u.label === 'Main').unit_key;
  assert.equal(val('square', 'units', main, h15), 2, 'only the Iced Latte (Large) line counts');
  assert.equal(val('square', 'revenue', main, h15), 10);
  assert.equal(val('shopify', 'units', main, h9), 2);
  // Privacy: no customer id, card digit, order id or item name anywhere in what was stored.
  const dump = JSON.stringify([db.prepare('SELECT * FROM experiment_outcomes').all(), db.prepare('SELECT * FROM experiments').all(), db.prepare('SELECT * FROM experiment_units').all()]);
  // A non-numeric card sentinel: '1111' also turned up by chance inside random UUIDs and timestamps (#763).
  for (const s of ['CUST-SECRET', 'CARD-L4-SENTINEL', 'ORD1', 'Croissant', SQ_TOKEN, SHP_TOKEN]) assert.ok(!dump.includes(s), `${s} must not be stored`);
  assert.deepEqual(db.prepare('PRAGMA table_info(experiment_outcomes)').all().map((c) => c.name).sort(), ['experiment_id', 'hour_utc', 'metric', 'source', 'unit_key', 'value']);

  // A refused token: the error is ours, names the permission, carries no token.
  routes = (url) => { if (url.includes('squareup')) throw httpError(403); return json(shopifyOrders([])); };
  const bad = await data.importSales(core.load(id, WS), { now: Date.UTC(2026, 9, 2, 5) / 1000 });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /ORDERS_READ/);
  assert.ok(!bad.error.includes(SQ_TOKEN));
  routes = null;
});

/* ── attribution and statistics ──────────────────────────────────────────────────────────── */

test('attribution windows: an hour counts only when one variant was on screen for it and the window before', () => {
  const t0 = 1_000_000 * H;
  const byUnitHour = analyze.exposureByUnitHour([
    { device_id: 'a', hour_utc: t0, variant: 0, plays: 3 },
    { device_id: 'a', hour_utc: t0 + H, variant: 0, plays: 3 },
    { device_id: 'a', hour_utc: t0 + 2 * H, variant: 1, plays: 3 },
    { device_id: 'a', hour_utc: t0 + 3 * H, variant: 1, plays: 2 },
    { device_id: 'a', hour_utc: t0 + 3 * H, variant: 0, plays: 1 },   // both in one hour: ambiguous
    { device_id: 'b', hour_utc: t0 + 5 * H, variant: 1, plays: 0 },   // no plays: not exposure
  ], new Map([['a', 'u1'], ['b', 'u2']]));
  const w0 = analyze.cleanCells(byUnitHour, 0).map((c) => [c.h - t0, c.k]).sort((x, y) => x[0] - y[0]);
  assert.deepEqual(w0, [[0, 0], [H, 0], [2 * H, 1]]);
  const w1 = analyze.cleanCells(byUnitHour, 1).map((c) => [c.h - t0, c.k]).sort((x, y) => x[0] - y[0]);
  assert.deepEqual(w1, [[0, 0], [H, 0]], 'with a one-hour window, the hour after a switch is ambiguous too');
});

/** Seeded noise so the synthetic data is the same every run. */
function noise(seed) { const r = assign.rng(seed); return () => (r() + r() + r() - 1.5) * 2; }

test('statistics: a known 20% lift is found with an interval around it; no lift is not called a winner', () => {
  const make = (lift, seed) => {
    const nz = noise(seed);
    const cells = [];
    for (let day = 0; day < 21; day++) {
      const busy = 1 + 0.3 * Math.sin(day);   // days differ a lot; pairing must cancel it
      for (let h = 8; h < 20; h++) {
        const k = assign.timeVariantAt(day % 7, h, 2, 1);
        const mean = 10 * busy * (k === 1 ? 1 + lift : 1);
        cells.push({ cluster: `d${day}`, variant: k, value: Math.max(0, mean + nz() * 2), weight: 1 });
      }
    }
    return cells;
  };
  const yes = stats.bootstrapLift(make(0.2, 's1'), 1, 0, { seed: 'x' });
  assert.ok(yes.lift > 0.15 && yes.lift < 0.25, `lift ${yes.lift}`);
  assert.ok(yes.low > 0.05 && yes.low < 0.2 && yes.high > 0.2 && yes.high < 0.35, `${yes.low}..${yes.high}`);
  assert.ok(yes.paired);
  assert.equal(stats.verdict(yes, { mode: 'time', days: 21, minLift: 0.1 }).state, 'better');
  assert.deepEqual(stats.bootstrapLift(make(0.2, 's1'), 1, 0, { seed: 'x' }), yes, 'deterministic');

  let falseWins = 0;
  for (const seed of ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8']) {
    const no = stats.bootstrapLift(make(0, seed), 1, 0, { seed });
    assert.ok(Math.abs(no.lift) < 0.08, `null lift ${no.lift}`);
    const v = stats.verdict(no, { mode: 'time', days: 21, minLift: 0.1 }).state;
    if (v === 'better' || v === 'worse') falseWins++;
  }
  assert.ok(falseWins <= 1, `no lift called a winner ${falseWins} times in 8`);

  // Too little data: a verdict waits, and says roughly how long.
  const short = make(0.2, 's2').filter((c) => ['d0', 'd1', 'd2'].includes(c.cluster));
  const v = stats.verdict(stats.bootstrapLift(short, 1, 0), { mode: 'time', days: 3, minLift: 0.1 });
  assert.equal(v.state, 'not_enough');
  assert.ok(v.more_days >= 4, `more days ${v.more_days}`);
  assert.equal(stats.moreDaysNeeded({ low: -0.1, high: 0.3, days: 10, target: 0.1 }), 30, '±20% → ±10% needs 4× the days');
  assert.equal(stats.verdict(null, { mode: 'time', days: 0 }).state, 'not_enough');
});

test('location mode statistics: stores of different sizes, indexed against their own before-period', async () => {
  // Eight stores, sizes 5..40 orders/hour. B's stores sell 20% over their own normal.
  const screens = Array.from({ length: 8 }, (_, i) => ({ id: `d-st${i}`, location: `Store ${i}` }));
  const itemId = setupPlaylist('pl-stores', screens);
  let r = await api('POST', '/api/experiments', {
    name: 'Stores', mode: 'location', playlist_id: 'pl-stores', slot_item_id: itemId,
    variants: [{ kind: 'content', id: 'c-a' }, { kind: 'content', id: 'c-b' }],
    config: { outcome: { source: 'csv', metric: 'value' }, baseline_days: 14 },
  });
  assert.equal(r.status, 201);
  const id = r.body.id;
  r = await api('POST', `/api/experiments/${id}/start`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const start = Math.floor(Date.UTC(2026, 8, 1) / 1000);
  db.prepare('UPDATE experiments SET start_at = ? WHERE id = ?').run(start, id);
  const units = core.unitsOf(id);
  const nz = noise('stores');
  const exposure = db.prepare('INSERT INTO experiment_exposure (experiment_id, device_id, hour_utc, variant, plays, seconds) VALUES (?, ?, ?, ?, 6, 60)');
  const outcome = db.prepare("INSERT INTO experiment_outcomes (experiment_id, source, metric, unit_key, hour_utc, value) VALUES (?, 'csv', 'value', ?, ?, ?)");
  db.transaction(() => {
    units.forEach((u, i) => {
      const size = 5 + i * 5;
      for (let h = start - 14 * DAY; h < start + 21 * DAY; h += H) {
        const hr = new Date(h * 1000).getUTCHours();
        if (hr < 8 || hr >= 20) continue;
        const during = h >= start;
        const lift = during && u.variant === 1 ? 1.2 : 1;
        outcome.run(id, u.unit_key, h, Math.max(0, size * lift + nz() * size * 0.15));
        if (during) exposure.run(id, u.device_ids[0], h, u.variant);
      }
    });
  })();
  const res = analyze.results(core.load(id, WS), { now: start + 21 * DAY, refresh: false });
  const c = res.primary.comparisons[0];
  assert.equal(res.primary.adjusted, true, 'indexed against the before-period');
  assert.ok(c.lift_pct > 14 && c.lift_pct < 26, `lift ${c.lift_pct}%`);
  assert.ok(c.low_pct > 0, `interval ${c.low_pct}..${c.high_pct}`);
  assert.equal(c.verdict, 'better');
  assert.equal(c.clusters.control, 4);
  const g = res.guardrails.find((x) => x.code.startsWith('baseline_'));
  assert.ok(g, 'the before-period per arm is reported');
  assert.equal(res.units.filter((u) => u.baseline_per_day > 0).length, 8);
  r = await api('POST', `/api/experiments/${id}/stop`);
  assert.equal(r.status, 200);
});

test('time mode end to end: exposure from proof-of-play, sales from the same hours, a verdict in words-ready form', async () => {
  const itemId = setupPlaylist('pl-e2e', [{ id: 'd-e2e', location: 'Solo' }]);
  let r = await api('POST', '/api/experiments', {
    name: 'Solo', mode: 'time', playlist_id: 'pl-e2e', slot_item_id: itemId,
    variants: [{ kind: 'content', id: 'c-a' }, { kind: 'content', id: 'c-b' }],
    config: { outcome: { source: 'csv', metric: 'value' }, block_hours: 2, attribution_hours: 1 },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.id;
  r = await api('POST', `/api/experiments/${id}/start`);
  assert.equal(r.status, 200);
  const start = Math.floor(Date.UTC(2026, 6, 5) / 1000);   // a Sunday
  db.prepare('UPDATE experiments SET start_at = ? WHERE id = ?').run(start, id);
  const unit = core.unitsOf(id)[0];
  const nz = noise('solo');
  const play = db.prepare("INSERT INTO play_logs (device_id, content_id, content_name, started_at, duration_sec, workspace_id) VALUES ('d-e2e', ?, 'x', ?, 10, ?)");
  const rows = [];
  db.transaction(() => {
    for (let h = start; h < start + 28 * DAY; h += H) {
      const d = new Date(h * 1000);
      const hr = d.getUTCHours();
      if (hr < 7 || hr >= 21) continue;
      const k = assign.timeVariantAt(d.getUTCDay(), hr, 2, 2);
      for (let i = 0; i < 6; i++) play.run(k === 0 ? 'c-a' : 'c-b', h + i * 600, WS);
      // A playlist of another workspace on the same device id must not count (tenancy on the play).
      play.run('c-b', h + 30, WS2);
      rows.push(`Solo,${d.toISOString().slice(0, 10)},${hr},${Math.max(0, (k === 1 ? 13 : 10) + nz() * 2).toFixed(2)}`);
    }
  })();
  // The CSV goes through the real validator.
  r = await api('POST', `/api/experiments/${id}/outcomes/csv`, { csv: `location,date,hour,value\n${rows.join('\n')}\n` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const res = analyze.results(core.load(id, WS), { now: start + 28 * DAY });
  const plays = res.plays;
  assert.equal(plays[0] + plays[1], rows.length * 6, 'exposure is exactly the plays of this workspace');
  const c = res.primary.comparisons[0];
  assert.ok(c.lift_pct > 20 && c.lift_pct < 40, `lift ${c.lift_pct}`);
  assert.equal(c.verdict, 'better');
  assert.ok(c.welch && c.welch.t > 2, 'Welch reported alongside');
  const wd = res.guardrails.find((g) => g.code.startsWith('weekday_'));
  assert.equal(wd.code, 'weekday_balanced');
  // With a one-hour window and two-hour turns, the first hour of every turn is left out.
  assert.equal(res.primary.variants[0].exposure_hours + res.primary.variants[1].exposure_hours, rows.length / 2);
  assert.equal(unit.label, 'Solo');
  await api('POST', `/api/experiments/${id}/stop`);
});

test('CSV upload: validated row by row, all or nothing', () => {
  const exp = core.load(LOC.id, WS);
  const units = core.unitsOf(LOC.id);
  const ok = data.validateCsv(exp, `﻿Location,Date,Hour,Value\n${units[0].label},2026-10-01,9,12.5\n"${units[1].label}",2026-10-01,10,3\n`);
  assert.ok(ok.rows, JSON.stringify(ok));
  assert.equal(ok.rows.length, 2);
  assert.equal(ok.rows[0].hour_utc, Date.UTC(2026, 9, 1, 9) / 1000);
  const bad = data.validateCsv(exp, `location,date,hour,value\nNowhere,2026-10-01,9,1\n${units[0].label},10/01/2026,9,1\n${units[0].label},2026-10-01,24,1\n${units[0].label},2026-10-01,9,-4\n${units[0].label},2026-10-01,9,=1+1\n${units[0].label},2026-10-01,8,1\n${units[0].label},2026-10-01,8,2\n`);
  assert.deepEqual(bad.errors.map((e) => e.row), [2, 3, 4, 5, 6, 8]);
  assert.match(data.validateCsv(exp, 'date,value\n2026-10-01,1').errors[0].message, /hour/);
  assert.match(data.validateCsv(exp, '').errors[0].message, /empty/);
  assert.match(data.validateCsv(exp, 'x'.repeat(2 * 1024 * 1024 + 1)).errors[0].message, /2 MB/);
  // A local hour in a zone with DST maps to the right UTC hour.
  assert.equal(data.zonedToUtc('2026-07-01', 9, 'America/Chicago'), Date.UTC(2026, 6, 1, 14) / 1000);
  assert.equal(data.zonedToUtc('2026-12-01', 9, 'America/Chicago'), Date.UTC(2026, 11, 1, 15) / 1000);
});

test('the sweep ends a test whose end date has passed and restores the control', async () => {
  const itemId = setupPlaylist('pl-sweep', [{ id: 'd-w1', location: 'a' }, { id: 'd-w2', location: 'b' }]);
  const before = db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get('pl-sweep').published_snapshot;
  let r = await api('POST', '/api/experiments', {
    name: 'Sweep', mode: 'location', playlist_id: 'pl-sweep', slot_item_id: itemId,
    variants: [{ kind: 'content', id: 'c-a' }, { kind: 'content', id: 'c-b' }],
    config: { outcome: { source: 'csv', metric: 'value' } }, planned_end_at: Math.floor(Date.now() / 1000) + 3600,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await api('POST', `/api/experiments/${r.body.id}/start`);
  assert.equal(r.status, 200);
  const out = await require('../lib/experiments/sweep').sweep(null, Math.floor(Date.now() / 1000) + 7200);
  assert.ok(out.ended >= 1);
  assert.equal(core.load(r.body.id, WS).status, 'ended');
  assert.equal(db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get('pl-sweep').published_snapshot, before);
});
