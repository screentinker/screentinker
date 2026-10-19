'use strict';

/*
 * 3.0: a layout on a playlist (docs/layouts-and-campaigns.md).
 *
 *   1. NULL = UNCHANGED. With no playlist layout anywhere, every screen of the preview-at-time fleet
 *      (test/helpers/simulate-fixture.js) is sent BYTE-IDENTICAL payloads by the pre-feature code
 *      (resolver view + payload builder + snapshot builder at BASE) and by today's, and every
 *      snapshot is byte-identical too.
 *   2. The precedence matrix: mandate > schedule's layout > the playlist's (published) layout >
 *      the device's; walls keep their wall layout; a draft layout is not on screens until Publish.
 *   3. The main win: a group playing a zoned playlist renders it on members with a different
 *      device layout, or none.
 *   4. Only the TOP-LEVEL playlist's layout counts; a nested child's is ignored.
 *   5. Items without a zone go to the main zone (marked, else largest) — whoever added them.
 *   6. Zone remapping suggestions.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-pllayout-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { db } = require('../db/database');
const fixture = require('./helpers/simulate-fixture');
const { loadBaseline } = require('./helpers/baseline-loader');
const setupDeviceSocket = require('../ws/deviceSocket');
const resolverSql = require('../lib/playlist-resolver-sql');
const playlists = require('../routes/playlists');
const pl = require('../lib/playlist-layout');
const sim = require('../lib/device-simulate');

// The commit this feature was built on (v3.0 at the time): its resolver view, payload builder and
// snapshot builder are "before".
const BASE = '5aaaa2cfa078cf947fbf930eaedf8a7787d11335';
const CHANGED = ['ws/deviceSocket.js', 'routes/playlists.js', 'lib/playlist-resolver-sql.js'];

let f, io1, io2, srvA, srvB, base = null, baseWhy = '';
const uid = (p) => `${p}-${crypto.randomUUID()}`;

function layout(name, zones, ws = f.wsId) {
  const id = uid('L');
  db.prepare('INSERT INTO layouts (id, user_id, workspace_id, name, width, height) VALUES (?, ?, ?, ?, 1920, 1080)').run(id, f.userId, ws, name);
  const out = { id, zones: {} };
  zones.forEach(([zname, x, y, w, h, main], i) => {
    const zid = uid('z');
    db.prepare(`INSERT INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, sort_order, is_main)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(zid, id, zname, x, y, w, h, i, main ? 1 : 0);
    out.zones[zname] = zid;
  });
  return out;
}

function realPlaylist(name, items, extra = {}) {
  const id = uid('pl');
  db.prepare('INSERT INTO playlists (id, user_id, workspace_id, name, status) VALUES (?, ?, ?, ?, \'draft\')').run(id, f.userId, f.wsId, name);
  items.forEach((it, i) => {
    db.prepare(`INSERT INTO playlist_items (playlist_id, content_id, widget_id, child_playlist_id, zone_id, sort_order, duration_sec)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, it.content_id || null, it.widget_id || null, it.child || null, it.zone_id || null, i, it.duration_sec || 10);
  });
  if (extra.layout_id) db.prepare('UPDATE playlists SET layout_id = ? WHERE id = ?').run(extra.layout_id, id);
  return id;
}

function device(name, cols = {}) {
  const id = uid('d');
  db.prepare(`INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, status, playlist_id, playlist_source, layout_id)
              VALUES (?, ?, ?, ?, ?, 'online', ?, ?, ?)`)
    .run(id, f.userId, f.wsId, name, crypto.randomBytes(3).toString('hex'), cols.playlist || null, cols.source || null, cols.layout || null);
  for (const g of cols.groups || []) db.prepare('INSERT INTO device_group_members (device_id, group_id) VALUES (?, ?)').run(id, g);
  return id;
}

const view = (id) => db.prepare('SELECT playlist_id, source, layout_id FROM device_resolved_playlist WHERE device_id = ?').get(id);
const payload = (id) => setupDeviceSocket.buildPlaylistPayloadUnchecked(id);

before(() => {
  f = fixture.build(db);
  srvA = http.createServer(); io1 = new Server(srvA); setupDeviceSocket(io1);
  const b = loadBaseline(BASE, CHANGED);
  if (b.mods) {
    base = b.mods;
    srvB = http.createServer(); io2 = new Server(srvB); base['ws/deviceSocket.js'](io2);
  } else baseWhy = b.why;
});
after(() => { try { io1.close(); } catch { /* */ } try { io2 && io2.close(); } catch { /* */ } });

/* ─── 1. NULL = unchanged ─────────────────────────────────────────────────────────────────── */

test('NULL layout: every fixture screen gets a byte-identical payload from the pre-feature code', (t) => {
  if (!base) return t.skip(`baseline skipped: ${baseWhy}`);
  const ids = Object.values(f.devices);
  // A schedule column written, so the schedule tier of the view is exercised too.
  db.prepare('UPDATE devices SET scheduled_playlist_id = ? WHERE id = ?').run(f.playlists.Promo, f.devices.tie);
  try {
    const now = Object.fromEntries(ids.map((id) => [id, JSON.stringify(payload(id))]));
    const nowView = Object.fromEntries(ids.map((id) => [id, JSON.stringify(view(id))]));
    // Swap in the BASE views, build with the BASE builder, then put today's back.
    const old = base['lib/playlist-resolver-sql.js'];
    db.exec('DROP VIEW IF EXISTS device_resolved_playlist; DROP VIEW IF EXISTS device_inherited_playlist');
    db.exec(old.INHERITED_VIEW); db.exec(old.RESOLVED_VIEW);
    let then, thenView;
    try {
      then = Object.fromEntries(ids.map((id) => [id, JSON.stringify(base['ws/deviceSocket.js'].buildPlaylistPayloadUnchecked(id))]));
      thenView = Object.fromEntries(ids.map((id) => [id, JSON.stringify(view(id))]));
    } finally { resolverSql.applyResolverViews(db); }
    for (const id of ids) {
      assert.equal(now[id], then[id], `payload of ${id}`);
      assert.equal(nowView[id], thenView[id], `resolver row of ${id}`);
    }
  } finally { db.prepare('UPDATE devices SET scheduled_playlist_id = NULL WHERE id = ?').run(f.devices.tie); }
});

test('NULL layout: the per-boot verifier upgrades from the pre-feature view without a single change', (t) => {
  if (!base) return t.skip(`baseline skipped: ${baseWhy}`);
  const old = base['lib/playlist-resolver-sql.js'];
  const r = resolverSql.applyResolverViews(db, { verify: true, previousSql: { inherited: old.INHERITED_VIEW, resolved: old.RESOLVED_VIEW } });
  assert.equal(r.status, 'verified', JSON.stringify(r.changed || []));
});

test('NULL layout: snapshots (flat, zoned, nested) are byte-identical to the pre-feature builder', (t) => {
  if (!base) return t.skip(`baseline skipped: ${baseWhy}`);
  const L = layout('Split', [['Left', 0, 0, 50, 100], ['Right', 50, 0, 50, 100]]);
  const child = realPlaylist('child', [{ content_id: f.content['a.jpg'] }, { content_id: f.content['b.mp4'], zone_id: L.zones.Right }]);
  const ids = [
    realPlaylist('flat', [{ content_id: f.content['a.jpg'] }, { content_id: f.content['b.mp4'] }]),
    realPlaylist('zoned', [{ content_id: f.content['a.jpg'], zone_id: L.zones.Left }, { content_id: f.content['b.mp4'] }]),
    realPlaylist('nested', [{ content_id: f.content['a.jpg'] }, { child, zone_id: L.zones.Left }]),
  ];
  for (const id of ids) {
    assert.equal(JSON.stringify(playlists.buildSnapshotItems(id)), JSON.stringify(base['routes/playlists.js'].buildSnapshotItems(id)), id);
  }
});

test('NULL layout: a screen with its OWN multi-zone layout gets the pre-feature payload (no new zone fields)', (t) => {
  if (!base) return t.skip(`baseline skipped: ${baseWhy}`);
  const L = layout('Own split', [['Left', 0, 0, 50, 100], ['Right', 50, 0, 50, 100]]);
  db.prepare('UPDATE devices SET layout_id = ? WHERE id = ?').run(L.id, f.devices.own);
  try {
    const now = payload(f.devices.own);
    const then = JSON.parse(JSON.stringify(base['ws/deviceSocket.js'].buildPlaylistPayloadUnchecked(f.devices.own)));
    // The OLD builder runs on TODAY's database, where layout_zones has the 3.0 is_main column; a
    // pre-feature database had no such column, so that is the only field to take away.
    for (const z of then.layout.zones) delete z.is_main;
    assert.equal(JSON.stringify(now), JSON.stringify(then));
  } finally { db.prepare('UPDATE devices SET layout_id = NULL WHERE id = ?').run(f.devices.own); }
});

/* ─── 2. precedence ───────────────────────────────────────────────────────────────────────── */

test('precedence matrix: mandate > schedule layout > playlist layout > device layout', () => {
  const LP = layout('Playlist L', [['Main', 0, 0, 70, 100], ['Side', 70, 0, 30, 100]]);
  const LD = layout('Device L', [['A', 0, 0, 50, 100], ['B', 50, 0, 50, 100]]);
  const LS = layout('Schedule L', [['A', 0, 0, 100, 50], ['B', 0, 50, 100, 50]]);
  const LQ = layout('Scheduled playlist L', [['A', 0, 0, 30, 100], ['B', 30, 0, 70, 100]]);
  const P = realPlaylist('P', [{ content_id: f.content['a.jpg'] }], { layout_id: LP.id });
  const Q = realPlaylist('Q', [{ content_id: f.content['a.jpg'] }], { layout_id: LQ.id });
  const plain = realPlaylist('plain', [{ content_id: f.content['a.jpg'] }]);
  const d = device('prec', { playlist: P, source: 'device', layout: LD.id });

  // Draft only: screens keep the device's layout until Publish.
  assert.equal(view(d).layout_id, LD.id, 'an unpublished playlist layout is not on screen');
  playlists.publishPlaylist(P, null);
  assert.equal(view(d).layout_id, LP.id, 'playlist layout beats the device layout');
  assert.equal(db.prepare('SELECT published_layout_id FROM playlists WHERE id = ?').get(P).published_layout_id, LP.id);

  // An active schedule's own layout beats the playlist's.
  db.prepare('UPDATE devices SET scheduled_playlist_id = ?, scheduled_layout_id = ? WHERE id = ?').run(P, LS.id, d);
  assert.equal(view(d).layout_id, LS.id, 'schedule layout beats the playlist layout');
  // A schedule with NO layout: the scheduled playlist's own layout applies.
  playlists.publishPlaylist(Q, null);
  db.prepare('UPDATE devices SET scheduled_playlist_id = ?, scheduled_layout_id = NULL WHERE id = ?').run(Q, d);
  assert.equal(view(d).layout_id, LQ.id, "a schedule without a layout plays its playlist's layout");
  // A schedule playlist with no layout: the device's.
  playlists.publishPlaylist(plain, null);
  db.prepare('UPDATE devices SET scheduled_playlist_id = ? WHERE id = ?').run(plain, d);
  assert.equal(view(d).layout_id, LD.id, 'no playlist layout falls back to the device layout');
  db.prepare('UPDATE devices SET scheduled_playlist_id = NULL WHERE id = ?').run(d);

  // The mirror in lib/device-simulate.js agrees in every state above.
  for (const [sp, sl] of [[null, null], [P, LS.id], [Q, null], [plain, null]]) {
    db.prepare('UPDATE devices SET scheduled_playlist_id = ?, scheduled_layout_id = ? WHERE id = ?').run(sp, sl, d);
    const r = view(d);
    assert.deepEqual(sim.resolveFromInputs(sim.resolverInputs(db, d), { playlist_id: sp, layout_id: sl }),
      { playlist_id: r.playlist_id ?? null, source: r.source ?? null, layout_id: r.layout_id ?? null });
  }
  db.prepare('UPDATE devices SET scheduled_playlist_id = NULL, scheduled_layout_id = NULL WHERE id = ?').run(d);

  // The payload carries the playlist's layout and the simulator names the tier.
  assert.equal(payload(d).layout.id, LP.id);
  assert.deepEqual(sim.simulate(d, Date.now()).layout, { id: LP.id, name: 'Playlist L', source: 'playlist' });
  assert.equal(sim.simulate(d, Date.now()).resolver_check, 'ok');
  assert.equal(require('../lib/resolve-device-playlist').resolvedLayoutInfo(d).source, 'playlist');
});

test('a head office mandate still decides the layout (its own, or full screen)', () => {
  const LP = layout('Store zoned', [['Main', 0, 0, 70, 100], ['Side', 70, 0, 30, 100]]);
  const P = realPlaylist('store P', [{ content_id: f.content['a.jpg'] }], { layout_id: LP.id });
  playlists.publishPlaylist(P, null);
  // The fixture's Corp group carries a mandate (HQ playlist, no layout).
  const d = device('mandated2', { playlist: P, source: 'device', groups: [f.groups.Corp] });
  assert.equal(view(d).source, 'corporate');
  assert.equal(view(d).layout_id, null, 'a mandate without a layout is full screen, not the store playlist layout');
  const LM = layout('HQ layout', [['A', 0, 0, 50, 100], ['B', 50, 0, 50, 100]]);
  db.prepare("UPDATE corporate_mandates SET layout_id = ? WHERE target_kind = 'group' AND target_id = ?").run(LM.id, f.groups.Corp);
  try {
    assert.equal(view(d).layout_id, LM.id);
  } finally {
    db.prepare("UPDATE corporate_mandates SET layout_id = NULL WHERE target_kind = 'group' AND target_id = ?").run(f.groups.Corp);
  }
});

test('walls keep their wall layout: a wall member never takes the playlist layout tier', () => {
  const LP = layout('Wall playlist L', [['Main', 0, 0, 70, 100], ['Side', 70, 0, 30, 100]]);
  db.prepare('UPDATE playlists SET layout_id = ?, published_layout_id = ? WHERE id = ?').run(LP.id, LP.id, f.playlists.Wall);
  try {
    assert.equal(view(f.devices.wall_a).playlist_id, f.playlists.Wall);
    assert.equal(view(f.devices.wall_a).layout_id, null);
    assert.equal(payload(f.devices.wall_a).layout, null);
  } finally {
    db.prepare('UPDATE playlists SET layout_id = NULL, published_layout_id = NULL WHERE id = ?').run(f.playlists.Wall);
  }
});

/* ─── 3. the group case ───────────────────────────────────────────────────────────────────── */

test('a group playing a zoned playlist renders it on members with a different device layout, or none', () => {
  const LP = layout('Menu board', [['Menu', 0, 0, 75, 100], ['Ticker', 75, 0, 25, 100]]);
  const other = layout('Other', [['X', 0, 0, 50, 100], ['Y', 50, 0, 50, 100]]);
  const P = realPlaylist('menu', [
    { content_id: f.content['a.jpg'], zone_id: LP.zones.Ticker },
    { content_id: f.content['b.mp4'] },                       // no zone: the main (largest) zone
  ], { layout_id: LP.id });
  playlists.publishPlaylist(P, null);
  const gid = uid('g');
  db.prepare('INSERT INTO device_groups (id, user_id, workspace_id, name, playlist_id, priority) VALUES (?, ?, ?, ?, ?, 0)').run(gid, f.userId, f.wsId, 'Cafes', P);
  const withOwn = device('cafe1', { groups: [gid], layout: other.id });
  const bare = device('cafe2', { groups: [gid] });
  for (const d of [withOwn, bare]) {
    const p = payload(d);
    assert.equal(view(d).source, 'group');
    assert.equal(p.layout && p.layout.id, LP.id, `member ${d} draws the playlist's layout`);
    assert.deepEqual(p.assignments.map((a) => a.zone_id), [LP.zones.Ticker, LP.zones.Menu]);
  }
});

/* ─── 4. nesting ──────────────────────────────────────────────────────────────────────────── */

test("a nested child's own layout is ignored; the top-level playlist's decides", () => {
  const LC = layout('Child L', [['C1', 0, 0, 50, 100], ['C2', 50, 0, 50, 100]]);
  const LP = layout('Parent L', [['Big', 0, 0, 80, 100], ['Small', 80, 0, 20, 100]]);
  const child = realPlaylist('nested child', [{ content_id: f.content['a.jpg'] }], { layout_id: LC.id });
  playlists.publishPlaylist(child, null);
  const parent = realPlaylist('nested parent', [{ content_id: f.content['b.mp4'] }, { child }]);
  playlists.publishPlaylist(parent, null);
  const d = device('nest', { playlist: parent, source: 'device' });
  assert.equal(view(d).layout_id, null, "the child's layout does not reach the screen");
  assert.deepEqual(JSON.parse(db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(parent).published_snapshot).map((a) => a.zone_id ?? null), [null, null],
    "the child's items are not filled into the child's main zone either");
  db.prepare('UPDATE playlists SET layout_id = ? WHERE id = ?').run(LP.id, parent);
  playlists.publishPlaylist(parent, null);
  assert.equal(view(d).layout_id, LP.id);
  assert.deepEqual(payload(d).assignments.map((a) => a.zone_id), [LP.zones.Big, LP.zones.Big], "the parent's main zone takes the child's items");
});

/* ─── 5. the main zone ────────────────────────────────────────────────────────────────────── */

test('main zone: a marked zone wins, else the largest; one-zone layouts and no layout leave items alone', () => {
  assert.equal(pl.mainZone([{ id: 'a', width_percent: 30, height_percent: 100 }, { id: 'b', width_percent: 70, height_percent: 100 }]).id, 'b');
  assert.equal(pl.mainZone([{ id: 'a', width_percent: 30, height_percent: 100, is_main: 1 }, { id: 'b', width_percent: 70, height_percent: 100 }]).id, 'a');
  assert.equal(pl.mainZone([{ id: 'a', width_percent: 50, height_percent: 100 }, { id: 'b', width_percent: 50, height_percent: 100 }]).id, 'a', 'a tie goes to the first, as on the players');
  const items = [{ zone_id: null }, { zone_id: 'x' }];
  assert.equal(pl.fillMainZone(items, null), items);
  assert.deepEqual(pl.fillMainZone([{ zone_id: null }], { zones: [{ id: 'only' }] }), [{ zone_id: null }]);
  assert.deepEqual(pl.fillMainZone([{ zone_id: null }, { zone_id: 'x' }], { zones: [{ id: 'm', width_percent: 60, height_percent: 100 }, { id: 'x', width_percent: 40, height_percent: 100 }] }),
    [{ zone_id: 'm' }, { zone_id: 'x' }]);
});

test('default zone: the playlist\'s own pick wins over the main zone while it is still in the layout', () => {
  const L = { zones: [{ id: 'm', width_percent: 60, height_percent: 100 }, { id: 'side', width_percent: 40, height_percent: 100 }] };
  assert.equal(pl.defaultZone(L, 'side').id, 'side');
  assert.equal(pl.defaultZone(L, null).id, 'm', 'no pick = the main zone');
  assert.equal(pl.defaultZone(L, 'gone').id, 'm', 'a zone no longer in the layout falls back to the main zone');
  assert.equal(pl.defaultZone(null, 'side'), null);
  assert.deepEqual(pl.fillMainZone([{ zone_id: null }, { zone_id: 'm' }], L, 'side'), [{ zone_id: 'side' }, { zone_id: 'm' }]);
  assert.deepEqual(pl.fillMainZone([{ zone_id: null }], { zones: [{ id: 'only' }] }, 'only'), [{ zone_id: null }], 'one zone: still untouched');
});

test('items added without a zone (Simple view, Make a sign, content requests, experiments) play in the main zone', () => {
  const LP = layout('Marked', [['Wide', 0, 0, 70, 100], ['Promo', 70, 0, 30, 100, true]]);
  const P = realPlaylist('simple adds', [], { layout_id: LP.id });
  // Exactly what those writers do: an INSERT with no zone_id.
  db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES (?, ?, 0, 10)').run(P, f.content['a.jpg']);
  db.prepare('INSERT INTO playlist_items (playlist_id, widget_id, sort_order, duration_sec) VALUES (?, NULL, 1, 10)').run(P);
  const snap = playlists.buildSnapshotItems(P);
  assert.ok(snap.length >= 1);
  for (const it of snap) assert.equal(it.zone_id, LP.zones.Promo, 'the marked main zone, not the larger one');
});

/* ─── 6. remapping ────────────────────────────────────────────────────────────────────────── */

test('zone remap suggestion: same name first, then the same place, then the main zone', () => {
  const from = [
    { id: 'f-ticker', name: 'Ticker', x_percent: 0, y_percent: 90, width_percent: 100, height_percent: 10 },
    { id: 'f-left', name: 'Left', x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 90 },
    { id: 'f-odd', name: 'Odd', x_percent: 40, y_percent: 40, width_percent: 1, height_percent: 1 },
  ];
  const to = [
    { id: 't-main', name: 'Main', x_percent: 0, y_percent: 0, width_percent: 60, height_percent: 85 },
    { id: 't-side', name: 'Side', x_percent: 60, y_percent: 0, width_percent: 40, height_percent: 85 },
    { id: 't-ticker', name: 'ticker', x_percent: 0, y_percent: 85, width_percent: 100, height_percent: 15 },
  ];
  const m = pl.suggestZoneMap(from, to);
  assert.equal(m['f-ticker'], 't-ticker', 'by name, case-insensitively');
  assert.equal(m['f-left'], 't-main', 'by position');
  assert.equal(m['f-odd'], 't-main', 'nothing close: the main zone');
});

test('deleting a layout clears it from playlists (both draft and published)', () => {
  const L = layout('Doomed', [['A', 0, 0, 50, 100], ['B', 50, 0, 50, 100]]);
  const P = realPlaylist('loses layout', [{ content_id: f.content['a.jpg'] }], { layout_id: L.id });
  playlists.publishPlaylist(P, null);
  const d = device('doomed', { playlist: P, source: 'device' });
  assert.equal(view(d).layout_id, L.id);
  // The FK action (foreign_keys is ON in this process) and the route's own clean-up agree.
  db.prepare('DELETE FROM layouts WHERE id = ?').run(L.id);
  assert.deepEqual({ ...db.prepare('SELECT layout_id, published_layout_id FROM playlists WHERE id = ?').get(P) }, { layout_id: null, published_layout_id: null });
  assert.equal(view(d).layout_id, null);
});
