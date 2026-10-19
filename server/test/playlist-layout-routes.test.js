'use strict';

/*
 * 3.0 playlist layouts over HTTP (docs/layouts-and-campaigns.md): choosing a layout, the zone-move
 * suggestion, the confirmed move, publish/discard, the per-zone versions, and the tenancy edges —
 * another workspace's layout, a zone map pointing outside the new layout, a read-only member.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { freePort } = require('./helpers/free-port');

let BASE, proc;
const DATA_DIR = path.join(os.tmpdir(), 'st-pllayout-http-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
const S = {};

async function jfetch(p, opts = {}) {
  const res = await fetch(BASE + p, opts);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}
const H = (jwt) => ({ Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' });
const get = (p, jwt = S.jwt) => jfetch(p, { headers: H(jwt) });
const post = (p, obj, jwt = S.jwt) => jfetch(p, { method: 'POST', headers: H(jwt), body: JSON.stringify(obj) });
const put = (p, obj, jwt = S.jwt) => jfetch(p, { method: 'PUT', headers: H(jwt), body: JSON.stringify(obj) });
const dbq = () => new Database(path.join(DATA_DIR, 'db', 'remote_display.db'), { readonly: true });

async function register(email) {
  const r = await jfetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test12345', name: email }) });
  assert.ok(r.body && r.body.token, 'register: ' + JSON.stringify(r.body));
  return r.body.token;
}

before(async () => {
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  S.jwt = await register('pll-a@test.local');
  S.jwt2 = await register('pll-b@test.local');
  const mk = async (name, zones, jwt = S.jwt) => (await post('/api/layouts', { name, zones }, jwt)).body;
  S.old = await mk('Old', [{ name: 'Left', x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 100 }, { name: 'Ticker', x_percent: 50, y_percent: 0, width_percent: 50, height_percent: 100 }]);
  S.next = await mk('Next', [{ name: 'Main', x_percent: 0, y_percent: 0, width_percent: 75, height_percent: 85 }, { name: 'ticker', x_percent: 0, y_percent: 85, width_percent: 100, height_percent: 15 }]);
  S.foreign = await mk('Foreign', [{ name: 'X', x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 100 }, { name: 'Y', x_percent: 50, y_percent: 0, width_percent: 50, height_percent: 100 }], S.jwt2);
  S.widget = (await post('/api/widgets', { name: 'Clock', widget_type: 'clock', config: {} })).body.id;
  S.pl = (await post('/api/playlists', { name: 'Zoned' })).body.id;
  const zid = (l, n) => l.zones.find((z) => z.name === n).id;
  S.oldLeft = zid(S.old, 'Left'); S.oldTicker = zid(S.old, 'Ticker');
  S.nextMain = zid(S.next, 'Main'); S.nextTicker = zid(S.next, 'ticker');
  for (const zone_id of [S.oldLeft, S.oldTicker, null]) {
    const r = await post(`/api/playlists/${S.pl}/items`, { widget_id: S.widget, ...(zone_id ? { zone_id } : {}) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  assert.equal((await post(`/api/playlists/${S.pl}/publish`, {})).status, 200);
});
after(() => { try { proc.kill(); } catch { /* */ } });

test('another workspace\'s layout is refused; an unknown one is a 400', async () => {
  const r = await put(`/api/playlists/${S.pl}`, { layout_id: S.foreign.id });
  assert.equal(r.status, 403);
  assert.equal((await put(`/api/playlists/${S.pl}`, { layout_id: 'nope' })).status, 400);
  assert.equal((await get(`/api/playlists/${S.pl}/layout-zone-map?layout_id=${S.foreign.id}`)).status, 403);
  // And the other tenant cannot touch this playlist at all.
  assert.equal((await put(`/api/playlists/${S.pl}`, { layout_id: S.foreign.id }, S.jwt2)).status, 403);
});

test('the zone-move suggestion names the zones in use and proposes a home for each', async () => {
  const r = await get(`/api/playlists/${S.pl}/layout-zone-map?layout_id=${S.next.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.layout.id, S.next.id);
  assert.equal(r.body.main_zone_id, S.nextMain);
  assert.equal(r.body.unzoned_items, 1);
  const by = Object.fromEntries(r.body.zones.map((z) => [z.name, z]));
  assert.equal(by.Ticker.suggested, S.nextTicker, 'by name, case-insensitively');
  assert.equal(by.Left.suggested, S.nextMain, 'by position');
});

test('a zone map may only point into the new layout', async () => {
  const r = await put(`/api/playlists/${S.pl}`, { layout_id: S.next.id, zone_map: { [S.oldLeft]: S.oldTicker } });
  assert.equal(r.status, 400);
  const row = dbq().prepare('SELECT layout_id FROM playlists WHERE id = ?').get(S.pl);
  assert.equal(row.layout_id, null, 'nothing changed');
});

test('changing the layout with a confirmed map moves the items, as a draft; publish takes both live; discard puts both back', async () => {
  const r = await put(`/api/playlists/${S.pl}`, { layout_id: S.next.id, zone_map: { [S.oldLeft]: S.nextMain, [S.oldTicker]: S.nextTicker } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let db = dbq();
  assert.deepEqual({ ...db.prepare('SELECT layout_id, published_layout_id, status FROM playlists WHERE id = ?').get(S.pl) },
    { layout_id: S.next.id, published_layout_id: null, status: 'draft' });
  assert.deepEqual(db.prepare('SELECT zone_id FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order').all(S.pl).map((x) => x.zone_id), [S.nextMain, S.nextTicker, null]);
  db.close();

  const g = await get(`/api/playlists/${S.pl}`);
  assert.equal(g.body.layout.id, S.next.id);
  assert.equal(g.body.layout.explicit, true);
  assert.equal(g.body.layout.main_zone_id, S.nextMain);
  // The preview draws the explicit layout, and the zone-less item is in the main zone.
  const pv = await get(`/api/playlists/${S.pl}/preview-payload`);
  assert.equal(pv.body.layout.id, S.next.id);
  assert.deepEqual(pv.body.assignments.map((a) => a.zone_id), [S.nextMain, S.nextTicker, S.nextMain]);

  // Discard: the layout goes back to what screens have (none), with the items.
  assert.equal((await post(`/api/playlists/${S.pl}/discard`, {})).status, 200);
  db = dbq();
  assert.equal(db.prepare('SELECT layout_id FROM playlists WHERE id = ?').get(S.pl).layout_id, null);
  assert.deepEqual(db.prepare('SELECT zone_id FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order').all(S.pl).map((x) => x.zone_id), [S.oldLeft, S.oldTicker, null]);
  db.close();

  // Again, and publish.
  assert.equal((await put(`/api/playlists/${S.pl}`, { layout_id: S.next.id, zone_map: { [S.oldLeft]: S.nextMain, [S.oldTicker]: S.nextTicker } })).status, 200);
  assert.equal((await post(`/api/playlists/${S.pl}/publish`, {})).status, 200);
  db = dbq();
  assert.equal(db.prepare('SELECT published_layout_id FROM playlists WHERE id = ?').get(S.pl).published_layout_id, S.next.id);
  const snap = JSON.parse(db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(S.pl).published_snapshot);
  assert.deepEqual(snap.map((a) => a.zone_id), [S.nextMain, S.nextTicker, S.nextMain]);
  const act = db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'playlist.layout_changed'").get().n;
  assert.ok(act >= 2, 'audited');
  db.close();
});

test('a layout save keeps its portrait version; the auto arrangement endpoint stays on the canvas', async () => {
  const auto = await post('/api/layouts/auto-variant', { variant: 'portrait', zones: S.next.zones.map((z, i) => ({ key: String(i), ...z })) });
  assert.equal(auto.status, 200, JSON.stringify(auto.body));
  assert.equal(Object.keys(auto.body.zones).length, 2);
  assert.equal((await post('/api/layouts/auto-variant', { variant: 'diagonal', zones: [] })).status, 400);
  const zones = S.next.zones.map((z, i) => ({ ...z, is_main: i === 1 ? 1 : 0, variants: { portrait: auto.body.zones[String(i)] } }));
  const r = await put(`/api/layouts/${S.next.id}`, { zones });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const g = await get(`/api/layouts/${S.next.id}`);
  for (const z of g.body.zones) assert.ok(z.variants && z.variants.portrait, 'every zone has its portrait geometry');
  assert.equal(g.body.zones.find((z) => z.id === S.nextTicker).is_main, 1);
  const list = await get('/api/layouts');
  assert.deepEqual(list.body.find((l) => l.id === S.next.id).variants, ['portrait']);
  // Another tenant cannot write a version onto these zones through their own layout.
  const f = await put(`/api/layouts/${S.foreign.id}`, { zones: [...S.foreign.zones, { ...S.next.zones[0], variants: { portrait: { x_percent: 0, y_percent: 0, width_percent: 1, height_percent: 1 } } }] }, S.jwt2);
  assert.equal(f.status, 200);
  const db = dbq();
  assert.notEqual(db.prepare("SELECT width_percent FROM layout_zone_variants WHERE zone_id = ? AND variant = 'portrait'").get(S.nextMain).width_percent, 1);
  db.close();
  // Removing it with an explicit null.
  await put(`/api/layouts/${S.next.id}`, { zones: S.next.zones.map((z) => ({ ...z, variants: { portrait: null } })) });
  assert.deepEqual((await get('/api/layouts')).body.find((l) => l.id === S.next.id).variants, []);
});

test('a playlist default zone: zone-less items play there instead of the layout\'s main zone, published like the layout, and it follows layout changes', async () => {
  // Its own layout, with the SMALLER zone marked main, so "main" and "largest" are different zones.
  const L = (await post('/api/layouts', { name: 'Marked', zones: [
    { name: 'Big', x_percent: 0, y_percent: 0, width_percent: 70, height_percent: 100 },
    { name: 'Side', x_percent: 70, y_percent: 0, width_percent: 30, height_percent: 100 },
  ] })).body;
  const big = L.zones.find((z) => z.name === 'Big').id;
  const side = L.zones.find((z) => z.name === 'Side').id;
  assert.equal((await put(`/api/layouts/${L.id}`, { zones: L.zones.map((z) => ({ ...z, is_main: z.id === side ? 1 : 0 })) })).status, 200);
  assert.equal((await get(`/api/layouts/${L.id}`)).body.zones.find((z) => z.id === side).is_main, 1, 'the layout marks Side as main');
  const pl = (await post('/api/playlists', { name: 'Default zone' })).body.id;
  const snapOf = () => {
    const db = dbq();
    try { return JSON.parse(db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(pl).published_snapshot).map((a) => a.zone_id); } finally { db.close(); }
  };
  const rowOf = () => {
    const db = dbq();
    try { return { ...db.prepare('SELECT default_zone_id, published_default_zone_id, status FROM playlists WHERE id = ?').get(pl) }; } finally { db.close(); }
  };
  // Not without a layout to pick a zone from.
  let r = await put(`/api/playlists/${pl}`, { default_zone_id: big });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'DEFAULT_ZONE_NO_LAYOUT');
  assert.equal((await put(`/api/playlists/${pl}`, { layout_id: L.id })).status, 200);
  // Added the way the Manager app and the API add: no zone. And one placed in a zone on purpose.
  assert.equal((await post(`/api/playlists/${pl}/items`, { widget_id: S.widget })).status, 201);
  assert.equal((await post(`/api/playlists/${pl}/items`, { widget_id: S.widget, zone_id: side })).status, 201);
  assert.equal((await post(`/api/playlists/${pl}/publish`, {})).status, 200);
  // With no default, the layout's main zone.
  assert.deepEqual(snapOf(), [side, side]);

  // Only a zone of this playlist's layout.
  assert.equal((await put(`/api/playlists/${pl}`, { default_zone_id: S.oldLeft })).status, 400);
  assert.equal((await put(`/api/playlists/${pl}`, { default_zone_id: S.foreign.zones[0].id })).status, 400);
  assert.equal((await put(`/api/playlists/${pl}`, { default_zone_id: 42 })).status, 400);
  assert.equal(rowOf().default_zone_id, null);

  // Choosing one is a draft: the editor shows it at once, screens get it on Publish.
  r = await put(`/api/playlists/${pl}`, { default_zone_id: big });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(rowOf(), { default_zone_id: big, published_default_zone_id: null, status: 'draft' });
  const g = await get(`/api/playlists/${pl}`);
  assert.equal(g.body.layout.main_zone_id, big, 'the editor places zone-less items in the default zone');
  assert.equal(g.body.layout.default_zone_id, big);
  assert.equal(g.body.layout.layout_main_zone_id, side);
  assert.deepEqual(snapOf(), [side, side], 'screens unchanged before Publish');

  // Discard puts back what screens have.
  assert.equal((await post(`/api/playlists/${pl}/discard`, {})).status, 200);
  assert.equal(rowOf().default_zone_id, null);

  // Again, and publish: the zone-less item moves, the one placed on purpose stays.
  assert.equal((await put(`/api/playlists/${pl}`, { default_zone_id: big })).status, 200);
  assert.equal((await post(`/api/playlists/${pl}/publish`, {})).status, 200);
  assert.deepEqual(snapOf(), [big, side]);
  assert.deepEqual(rowOf(), { default_zone_id: big, published_default_zone_id: big, status: 'published' });
  // Anything added later without a zone lands there too.
  assert.equal((await post(`/api/playlists/${pl}/items`, { widget_id: S.widget })).status, 201);
  assert.equal((await post(`/api/playlists/${pl}/publish`, {})).status, 200);
  assert.deepEqual(snapOf(), [big, side, big]);

  // A layout change carries it through the confirmed zone map...
  r = await put(`/api/playlists/${pl}`, { layout_id: S.old.id, zone_map: { [big]: S.oldTicker, [side]: S.oldLeft } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(rowOf().default_zone_id, S.oldTicker);
  // ...a layout without that zone drops it (back to the layout's main zone)...
  assert.equal((await put(`/api/playlists/${pl}`, { layout_id: L.id })).status, 200);
  assert.equal(rowOf().default_zone_id, null);
  // ...and so does going back to each screen's own layout.
  assert.equal((await put(`/api/playlists/${pl}`, { default_zone_id: big })).status, 200);
  assert.equal((await put(`/api/playlists/${pl}`, { layout_id: null })).status, 200);
  assert.equal(rowOf().default_zone_id, null);
});
