'use strict';

/*
 * 3.0: portrait and 4:3 versions of a layout (lib/layout-variants.js, docs/layouts-and-campaigns.md).
 *
 *   - the version is picked from the screen's real shape (orientation setting + reported size);
 *   - a missing version falls back to the default geometry BYTE-IDENTICALLY;
 *   - zone ids never change between versions, so zone-bound items land in the same logical zone;
 *   - the generated starting arrangement stays on the canvas and adds no overlap;
 *   - a mixed group (landscape + portrait screens) on one playlist gets the right geometry each;
 *   - "What will this screen show?" picks the same version as the live payload.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-layoutvar-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { db } = require('../db/database');
const fixture = require('./helpers/simulate-fixture');
const setupDeviceSocket = require('../ws/deviceSocket');
const playlists = require('../routes/playlists');
const lv = require('../lib/layout-variants');
const sim = require('../lib/device-simulate');

let f, io, srv;
const uid = (p) => `${p}-${crypto.randomUUID()}`;

function layout(name, zones) {
  const id = uid('L');
  db.prepare('INSERT INTO layouts (id, user_id, workspace_id, name, width, height) VALUES (?, ?, ?, ?, 1920, 1080)').run(id, f.userId, f.wsId, name);
  const out = { id, zones: {}, list: [] };
  zones.forEach(([zname, x, y, w, h], i) => {
    const zid = uid('z');
    db.prepare('INSERT INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(zid, id, zname, x, y, w, h, i);
    out.zones[zname] = zid;
    out.list.push({ id: zid, x_percent: x, y_percent: y, width_percent: w, height_percent: h });
  });
  return out;
}
function addVariant(L, variant, geo) {
  lv.writeZoneVariants(db, L.id, Object.entries(geo).map(([name, [x, y, w, h]]) => ({
    id: L.zones[name], variants: { [variant]: { x_percent: x, y_percent: y, width_percent: w, height_percent: h } },
  })));
}
function device(name, cols = {}) {
  const id = uid('d');
  db.prepare(`INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, status, playlist_id, playlist_source, layout_id, orientation, screen_width, screen_height)
              VALUES (?, ?, ?, ?, ?, 'online', ?, ?, ?, ?, ?, ?)`)
    .run(id, f.userId, f.wsId, name, crypto.randomBytes(3).toString('hex'), cols.playlist || null, cols.playlist ? 'device' : null,
      cols.layout || null, cols.orientation || 'landscape', cols.w ?? null, cols.h ?? null);
  for (const g of cols.groups || []) db.prepare('INSERT INTO device_group_members (device_id, group_id) VALUES (?, ?)').run(id, g);
  return id;
}
function playlist(name, items, layoutId = null) {
  const id = uid('pl');
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name, status, layout_id) VALUES (?, ?, ?, ?, 'draft', ?)").run(id, f.userId, f.wsId, name, layoutId);
  items.forEach((it, i) => db.prepare('INSERT INTO playlist_items (playlist_id, content_id, zone_id, sort_order, duration_sec) VALUES (?, ?, ?, ?, 10)').run(id, f.content['a.jpg'], it || null, i));
  playlists.publishPlaylist(id, null);
  return id;
}
const payload = (id) => setupDeviceSocket.buildPlaylistPayloadUnchecked(id);
const geoOf = (z) => [z.x_percent, z.y_percent, z.width_percent, z.height_percent];

before(() => {
  f = fixture.build(db);
  srv = http.createServer(); io = new Server(srv); setupDeviceSocket(io);
});
after(() => { try { io.close(); } catch { /* */ } });

test('the canvas shape: orientation setting and reported size', () => {
  assert.equal(lv.canvasVariant({ orientation: 'landscape' }), null);
  assert.equal(lv.canvasVariant({ orientation: 'portrait' }), 'portrait');
  assert.equal(lv.canvasVariant({ orientation: 'portrait-flipped', screen_width: 1920, screen_height: 1080 }), 'portrait');
  assert.equal(lv.canvasVariant({ orientation: 'portrait', screen_width: 1080, screen_height: 1920 }), 'portrait', 'a size already reported rotated is not turned twice');
  assert.equal(lv.canvasVariant({ orientation: 'landscape', screen_width: 1080, screen_height: 1920 }), 'portrait', 'a natively portrait panel');
  assert.equal(lv.canvasVariant({ orientation: 'landscape', screen_width: 1024, screen_height: 768 }), 'square');
  assert.equal(lv.canvasVariant({ orientation: 'landscape', screen_width: 1280, screen_height: 1024 }), 'square');
  assert.equal(lv.canvasVariant({ orientation: 'landscape', screen_width: 1920, screen_height: 1200 }), null, '16:10 is landscape');
  assert.equal(lv.canvasVariant({ orientation: 'portrait', screen_width: 1024, screen_height: 768 }), 'portrait', 'a 4:3 panel turned is 3:4');
});

test('a portrait screen gets the portrait version; a landscape one the default, byte-identical to no version at all', () => {
  const L = layout('Menu', [['Menu', 0, 0, 70, 90], ['Promo', 70, 0, 30, 90], ['Ticker', 0, 90, 100, 10]]);
  const P = playlist('menu', [null, null]);   // items bound below via the device layout
  db.prepare('UPDATE playlist_items SET zone_id = ? WHERE playlist_id = ? AND sort_order = 0').run(L.zones.Promo, P);
  playlists.publishPlaylist(P, null);
  const land = device('land', { playlist: P, layout: L.id });
  const port = device('port', { playlist: P, layout: L.id, orientation: 'portrait', w: 1920, h: 1080 });
  const before = { land: JSON.stringify(payload(land)), port: JSON.stringify(payload(port)) };
  // No versions yet: the portrait screen gets the default, exactly like the landscape one.
  assert.deepEqual(JSON.parse(before.port).layout, JSON.parse(before.land).layout);
  assert.equal(JSON.parse(before.land).layout.zones.some((z) => 'is_main' in z || 'variants' in z), false, 'no new fields in a payload');

  addVariant(L, 'portrait', { Menu: [0, 5, 100, 60], Promo: [0, 65, 100, 30], Ticker: [0, 95, 100, 5] });
  assert.equal(JSON.stringify(payload(land)), before.land, 'landscape payload unchanged by adding a portrait version');
  const p = payload(port);
  assert.equal(p.layout.variant, 'portrait');
  assert.deepEqual(p.layout.zones.map((z) => z.id), JSON.parse(before.port).layout.zones.map((z) => z.id), 'same zones, same ids, same order');
  assert.deepEqual(geoOf(p.layout.zones.find((z) => z.id === L.zones.Promo)), [0, 65, 100, 30]);
  assert.deepEqual([p.layout.width, p.layout.height], [1080, 1920]);
  assert.equal(p.assignments[0].zone_id, L.zones.Promo, 'a zone-bound item keeps its zone');

  // A 4:3 screen: no square version -> the default, byte-identical.
  const sq = device('sq', { playlist: P, layout: L.id, w: 1024, h: 768 });
  const sqNow = payload(sq);
  assert.equal(sqNow.layout.variant, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(sqNow.layout)), JSON.parse(before.land).layout);
  addVariant(L, 'square', { Menu: [0, 0, 65, 88], Promo: [65, 0, 35, 88], Ticker: [0, 88, 100, 12] });
  assert.equal(payload(sq).layout.variant, 'square');
  assert.deepEqual(geoOf(payload(sq).layout.zones.find((z) => z.id === L.zones.Ticker)), [0, 88, 100, 12]);

  // Removing the version restores the default exactly.
  lv.writeZoneVariants(db, L.id, Object.values(L.zones).map((id) => ({ id, variants: { portrait: null, square: null } })));
  assert.equal(JSON.stringify(payload(port)), before.port);
});

test('a mixed group on one zoned playlist: each screen gets the geometry for its shape', () => {
  const L = layout('Group L', [['Left', 0, 0, 50, 100], ['Right', 50, 0, 50, 100]]);
  addVariant(L, 'portrait', { Left: [0, 0, 100, 50], Right: [0, 50, 100, 50] });
  const P = playlist('group zoned', [null, null], L.id);
  db.prepare('UPDATE playlist_items SET zone_id = ? WHERE playlist_id = ? AND sort_order = 1').run(L.zones.Right, P);
  playlists.publishPlaylist(P, null);
  const gid = uid('g');
  db.prepare('INSERT INTO device_groups (id, user_id, workspace_id, name, playlist_id, priority) VALUES (?, ?, ?, ?, ?, 0)').run(gid, f.userId, f.wsId, 'Mixed', P);
  const land = device('g-land', { groups: [gid] });
  const port = device('g-port', { groups: [gid], orientation: 'portrait' });
  const native = device('g-native', { groups: [gid], w: 1080, h: 1920 });
  const right = (d) => geoOf(payload(d).layout.zones.find((z) => z.id === L.zones.Right));
  assert.deepEqual(right(land), [50, 0, 50, 100]);
  assert.deepEqual(right(port), [0, 50, 100, 50]);
  assert.deepEqual(right(native), [0, 50, 100, 50]);
  for (const d of [land, port, native]) {
    // The zone-less first item goes to the main (largest/first) zone; the bound one keeps Right.
    assert.deepEqual(payload(d).assignments.map((a) => a.zone_id), [L.zones.Left, L.zones.Right]);
  }
});

test('a schedule layout gets the version too, and "What will this screen show?" agrees with the live payload', () => {
  const L = layout('Sched L', [['A', 0, 0, 50, 100], ['B', 50, 0, 50, 100]]);
  addVariant(L, 'portrait', { A: [0, 0, 100, 50], B: [0, 50, 100, 50] });
  const P = playlist('sched', [null]);
  const d = device('sched-port', { playlist: P, orientation: 'portrait' });
  db.prepare('UPDATE devices SET scheduled_playlist_id = ?, scheduled_layout_id = ? WHERE id = ?').run(P, L.id, d);
  try {
    const live = payload(d);
    assert.equal(live.layout.id, L.id);
    assert.equal(live.layout.variant, 'portrait');
  } finally {
    db.prepare('UPDATE devices SET scheduled_playlist_id = NULL, scheduled_layout_id = NULL WHERE id = ?').run(d);
  }
  // The simulator builds with the same builder for the same screen, so it picks the same version.
  db.prepare('UPDATE devices SET layout_id = ? WHERE id = ?').run(L.id, d);
  const st = sim.stateAt(sim.loadContext(d), Date.now());
  assert.equal(st.entry.payload.layout.variant, 'portrait');
  assert.deepEqual(JSON.parse(JSON.stringify(st.entry.payload)), JSON.parse(JSON.stringify(payload(d))));
  assert.equal(sim.previewPayload(d, Date.now()).layout.variant, 'portrait');
});

/* ─── the generated starting arrangement ──────────────────────────────────────────────────── */

const SHAPES = {
  'split': [[0, 0, 50, 100], [50, 0, 50, 100]],
  'thirds': [[0, 0, 33.33, 100], [33.33, 0, 33.33, 100], [66.66, 0, 33.34, 100]],
  'l-bar': [[0, 0, 75, 85], [75, 0, 25, 85], [0, 85, 100, 15]],
  'header+quad': [[0, 0, 100, 12], [0, 12, 50, 44], [50, 12, 50, 44], [0, 56, 50, 44], [50, 56, 50, 44]],
  'two tickers': [[0, 0, 100, 8], [0, 8, 60, 84], [60, 8, 40, 84], [0, 92, 100, 8]],
  'single': [[0, 0, 100, 100]],
};
const rect = (z) => ({ x: z.x_percent, y: z.y_percent, w: z.width_percent, h: z.height_percent });
function overlaps(a, b) {
  const eps = 0.02;
  return a.x + eps < b.x + b.w && b.x + eps < a.x + a.w && a.y + eps < b.y + b.h && b.y + eps < a.y + a.h;
}

for (const [name, zs] of Object.entries(SHAPES)) {
  for (const variant of ['portrait', 'square']) {
    test(`auto arrangement (${variant}, ${name}): on the canvas, no new overlap, banners stay full width`, () => {
      const zones = zs.map(([x, y, w, h], i) => ({ id: `z${i}`, x_percent: x, y_percent: y, width_percent: w, height_percent: h }));
      const out = lv.autoArrange(zones, variant);
      assert.equal(Object.keys(out).length, zones.length, 'every zone placed');
      for (const z of zones) {
        const r = rect(out[z.id]);
        assert.ok(r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0, `${z.id} positive and inside`);
        assert.ok(r.x + r.w <= 100.01 && r.y + r.h <= 100.01, `${z.id} ends inside: ${JSON.stringify(r)}`);
        if (z.width_percent >= 95) assert.equal(r.w, 100, `${z.id} banner keeps full width`);
      }
      for (let i = 0; i < zones.length; i++) {
        for (let j = i + 1; j < zones.length; j++) {
          if (overlaps(rect(zones[i]), rect(zones[j]))) continue;   // only overlaps the default already had
          assert.equal(overlaps(rect(out[zones[i].id]), rect(out[zones[j].id])), false, `${zones[i].id} / ${zones[j].id}`);
        }
      }
    });
  }
}

test('auto arrangement: side by side becomes stacked in portrait, in the same order', () => {
  const out = lv.autoArrange([
    { id: 'a', x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 100 },
    { id: 'b', x_percent: 50, y_percent: 0, width_percent: 50, height_percent: 100 },
  ], 'portrait');
  assert.deepEqual(rect(out.a), { x: 0, y: 0, w: 100, h: 50 });
  assert.deepEqual(rect(out.b), { x: 0, y: 50, w: 100, h: 50 });
});

test('versions are written only for the layout\'s own zones', () => {
  const A = layout('A', [['One', 0, 0, 50, 100], ['Two', 50, 0, 50, 100]]);
  const B = layout('B', [['Other', 0, 0, 100, 100]]);
  lv.writeZoneVariants(db, A.id, [{ id: B.zones.Other, variants: { portrait: { x_percent: 0, y_percent: 0, width_percent: 10, height_percent: 10 } } }]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM layout_zone_variants WHERE zone_id = ?').get(B.zones.Other).n, 0);
});
