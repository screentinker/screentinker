'use strict';

// Regression tests for the SERVER-SIDE data contracts added by the mute + zone-orphan
// branch. These guard the exact bugs we fixed so they can't silently come back:
//   1. GET /api/devices/:id must carry each item's `muted` — and BOTH true and false
//      (the bug was a SELECT that dropped the column; the false case is the one that broke).
//   2. GET /api/devices/:id must return `active_layout_zones` for a multi-zone device
//      (the contract the dashboard zone-selector now depends on).
//   3. The single-source orphan rule (lib/zone-validate): a zone in the active layout is
//      NOT orphaned; a zone from a DIFFERENT layout IS — surfaced as the per-item `orphan`
//      flag and the device-list `orphan_count`.
//   4. Reassigning an orphan to a valid zone drops `orphan_count` to 0.
//   5. Assign-time hardening: a zone_id not in the device's active layout is cleared to
//      null on POST; a valid one is kept.
//
// Mirrors mute.test.js: boots the real server.js against an isolated DB and seeds rows on
// one connection (FK off) to avoid WAL visibility races. No player/DOM/Playwright tests.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { freePort } = require('./helpers/free-port');
let PORT, BASE;
const DATA_DIR = path.join(os.tmpdir(), 'st-zone-test-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-zone-' + crypto.randomBytes(4).toString('hex') + '.log');
const PW = 'Passw0rd123';
let proc, db;
const S = {};

async function jfetch(p, opts = {}) {
  const res = await fetch(BASE + p, opts);
  let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}
const auth = (tok) => ({ headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' } });
const post = (tok, obj) => ({ method: 'POST', ...auth(tok), body: JSON.stringify(obj || {}) });
const put = (tok, obj) => ({ method: 'PUT', ...auth(tok), body: JSON.stringify(obj || {}) });

// Find one item in the device payload by playlist_item id (ids are integers; coerce both).
async function getAssignment(itemId) {
  const r = await jfetch(`/api/devices/${S.deviceId}`, auth(S.jwt));
  return (r.body.assignments || []).find((a) => Number(a.id) === Number(itemId));
}
// Read the device's orphan_count off the workspace device list.
async function getOrphanCount() {
  const r = await jfetch('/api/devices', auth(S.jwt));
  const d = (r.body || []).find((x) => x.id === S.deviceId);
  return d ? d.orphan_count : undefined;
}

before(async () => {
    PORT = await freePort();
    BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));

  // First user -> platform_admin; register returns the JWT, the user, and the workspace.
  const reg = await jfetch('/api/auth/register', post(null, { email: 'z' + crypto.randomBytes(4).toString('hex') + '@x.local', password: PW }));
  S.jwt = reg.body.token;
  S.userId = reg.body.user.id;
  S.wsA = reg.body.current_workspace_id;

  // Active multi-zone layout L1 (Main, Side) + a DIFFERENT layout L2 (Other) — via the API
  // so zone ids are real and workspace-scoped. L2's zone is the "different layout" orphan.
  const l1 = await jfetch('/api/layouts', post(S.jwt, { name: 'L1', zones: [{ name: 'Main', width_percent: 60, height_percent: 100 }, { name: 'Side', width_percent: 40, height_percent: 100 }] }));
  S.L1 = l1.body.id; S.Z1 = l1.body.zones[0].id; S.Z2 = l1.body.zones[1].id;
  const l2 = await jfetch('/api/layouts', post(S.jwt, { name: 'L2', zones: [{ name: 'Other', width_percent: 100, height_percent: 100 }] }));
  S.ZX = l2.body.zones[0].id;

  const pl = await jfetch('/api/playlists', post(S.jwt, { name: 'zone-pl' }));
  S.playlistId = pl.body.id;

  // Seed content, a device, and playlist_items on one connection (FK off). The orphan item
  // is seeded DIRECTLY so it bypasses assign-time validation — that's how real orphans
  // arise (assigned under a different layout / layout switched after the fact).
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'), { timeout: 5000 });
  db.pragma('foreign_keys = OFF');
  const mkContent = (name) => {
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO content (id, filename, filepath, mime_type, file_size, remote_url) VALUES (?,?,?,?,0,?)")
      .run(id, name, '', 'image/png', 'https://example.com/' + name + '.png');
    return id;
  };
  S.cMute = mkContent('mute'); S.cValid = mkContent('valid'); S.cOrphan = mkContent('orphan');
  S.cPostStale = mkContent('post-stale'); S.cPostOk = mkContent('post-ok');

  S.deviceId = crypto.randomUUID();
  db.prepare("INSERT INTO devices (id, name, status, workspace_id, user_id, layout_id, playlist_id) VALUES (?,?,?,?,?,?,?)")
    .run(S.deviceId, 'ZoneDev', 'online', S.wsA, S.userId, S.L1, S.playlistId);

  const addItem = (contentId, zoneId, sort) =>
    db.prepare("INSERT INTO playlist_items (playlist_id, content_id, zone_id, sort_order, duration_sec, muted) VALUES (?,?,?,?,10,0)")
      .run(S.playlistId, contentId, zoneId, sort).lastInsertRowid;
  S.itemMute = addItem(S.cMute, null, 0);     // no zone — for the mute round-trip
  S.itemValid = addItem(S.cValid, S.Z1, 1);   // zone in the active layout -> NOT orphan
  S.itemOrphan = addItem(S.cOrphan, S.ZX, 2); // zone from L2 -> orphan
});

after(async () => {
  try { db?.close(); } catch { /* */ }
  if (proc) proc.kill('SIGKILL');
  for (const f of [DATA_DIR, LOG]) { try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* */ } }
});

// 1. muted must round-trip through the device payload SELECT — both states.
test('GET /api/devices/:id carries per-item muted (true AND false)', async () => {
  await jfetch(`/api/assignments/${S.itemMute}`, put(S.jwt, { muted: true }));
  let a = await getAssignment(S.itemMute);
  assert.ok(a, 'item appears in the device payload');
  assert.equal(a.muted, 1, 'muted=true survives the GET /api/devices/:id SELECT');

  await jfetch(`/api/assignments/${S.itemMute}`, put(S.jwt, { muted: false }));
  a = await getAssignment(S.itemMute);
  assert.equal(a.muted, 0, 'muted=false survives too (the case that originally broke)');
});

// 2. active_layout_zones contract for a multi-zone device.
test('GET /api/devices/:id returns active_layout_zones for a multi-zone device', async () => {
  const r = await jfetch(`/api/devices/${S.deviceId}`, auth(S.jwt));
  const zones = r.body.active_layout_zones;
  assert.ok(Array.isArray(zones), 'active_layout_zones is present');
  assert.equal(zones.length, 2, 'both zones of the active layout are returned');
  assert.deepEqual(zones.map((z) => z.id).sort(), [S.Z1, S.Z2].sort(), 'exactly the active-layout zone ids');
  // The Playlist tab names the main zone ("Main zone (Main)") like the playlist editor, so it
  // needs is_main and the size (no zone marked = the largest is main).
  const main = zones.find((z) => z.id === S.Z1);
  assert.equal(main.name, 'Main');
  assert.equal(Number(main.is_main), 0);
  assert.equal(Number(main.width_percent), 60);
  assert.equal(Number(main.height_percent), 100);
});

// 3. orphan definition: in-layout zone -> not orphan; different-layout zone -> orphan.
test('orphan flag + orphan_count reflect the single-source rule', async () => {
  const valid = await getAssignment(S.itemValid);
  const orphan = await getAssignment(S.itemOrphan);
  assert.equal(valid.orphan, false, 'a zone in the active layout is NOT orphaned');
  assert.equal(orphan.orphan, true, 'a zone from a different layout IS orphaned');
  assert.equal(await getOrphanCount(), 1, 'device list orphan_count counts exactly the one orphan');
});

// 4. reassigning the orphan to a valid zone clears the count.
test('reassigning an orphan to a valid zone clears orphan_count', async () => {
  assert.equal(await getOrphanCount(), 1, 'precondition: one orphan');
  const r = await jfetch(`/api/assignments/${S.itemOrphan}`, put(S.jwt, { zone_id: S.Z1 }));
  assert.equal(r.body.zone_id, S.Z1, 'reassignment to a valid zone persists');
  assert.equal(await getOrphanCount(), 0, 'orphan_count drops to 0 after reassign');
});

// 5. assign-time hardening: stale zone_id cleared, valid kept.
test('POST assignment clears a stale zone_id and keeps a valid one', async () => {
  const stale = await jfetch(`/api/assignments/device/${S.deviceId}`, post(S.jwt, { content_id: S.cPostStale, zone_id: S.ZX, duration_sec: 10 }));
  assert.equal(stale.status, 201);
  assert.equal(stale.body.zone_id, S.Z1, 'a zone_id from a different layout is dropped on add, and the item goes to the main zone');

  const ok = await jfetch(`/api/assignments/device/${S.deviceId}`, post(S.jwt, { content_id: S.cPostOk, zone_id: S.Z2, duration_sec: 10 }));
  assert.equal(ok.status, 201);
  assert.equal(ok.body.zone_id, S.Z2, 'a zone_id in the active layout is kept');
});

// An item added with no zone is stored in the main zone of the layout the screen draws, even when the
// layout is on the device and the playlist has none of its own: the editor then shows "Main", not
// "Main zone (Main)". #767 did this for the Manager app only; every client gets it now.
test('POST assignment without a zone names the device layout\'s main zone, from the Manager app and the dashboard alike', async () => {
  const mk = (name) => {
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO content (id, filename, filepath, mime_type, file_size, remote_url) VALUES (?,?,?,?,0,?)")
      .run(id, name, '', 'image/png', 'https://example.com/' + name + '.png');
    return id;
  };
  const ua = 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36 ScreenTinkerManager/1.4.0';
  const opts = post(S.jwt, { content_id: mk('manager-upload'), duration_sec: 10 });
  opts.headers = { ...opts.headers, 'User-Agent': ua };
  const m = await jfetch(`/api/assignments/device/${S.deviceId}`, opts);
  assert.equal(m.status, 201);
  assert.equal(m.body.zone_id, S.Z1, 'the main (largest) zone of L1');

  const d = await jfetch(`/api/assignments/device/${S.deviceId}`, post(S.jwt, { content_id: mk('dashboard-upload'), duration_sec: 10 }));
  assert.equal(d.status, 201);
  assert.equal(d.body.zone_id, S.Z1, 'the dashboard and the API too');
  assert.equal(d.body.enabled, 1, 'the item says it is enabled, for the screen\'s Playlist tab');
});

const mkC = (name) => {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO content (id, filename, filepath, mime_type, file_size, remote_url) VALUES (?,?,?,?,0,?)")
    .run(id, name, '', 'image/png', 'https://example.com/' + name + '.png');
  return id;
};
const publishedContentIds = (playlistId) =>
  JSON.parse(db.prepare('SELECT published_snapshot AS s FROM playlists WHERE id = ?').get(playlistId).s || '[]').map((i) => i.content_id);

// A disabled item stays in the playlist but is left out of what is published, so it never reaches the
// screen. The screen's Playlist tab drew it like any other item, so a screen showing one photo of nine
// looked broken with nothing to explain it. The tab now gets `enabled` and can turn it back on.
test('a disabled item: the screen\'s Playlist tab is told, Enable turns it back on, and only enabled items publish', async () => {
  const c = mkC('disable-me');
  const add = await jfetch(`/api/assignments/device/${S.deviceId}`, post(S.jwt, { content_id: c, duration_sec: 10 }));
  assert.equal(add.status, 201);
  const id = add.body.id;

  const off = await jfetch(`/api/assignments/${id}`, put(S.jwt, { enabled: false, device_id: S.deviceId }));
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.enabled, 0);
  const list = await jfetch(`/api/assignments/device/${S.deviceId}`, auth(S.jwt));
  assert.equal(list.body.find((a) => Number(a.id) === Number(id)).enabled, 0, 'GET says it is disabled');
  // The screen's page itself loads its items from GET /api/devices/:id, a separate query.
  assert.equal((await getAssignment(id)).enabled, 0, 'the screen page\'s own payload says it is disabled');
  assert.equal((await jfetch(`/api/playlists/${S.playlistId}/publish`, post(S.jwt, {}))).status, 200);
  assert.ok(!publishedContentIds(S.playlistId).includes(c), 'a disabled item is not published');

  const on = await jfetch(`/api/assignments/${id}`, put(S.jwt, { enabled: true, device_id: S.deviceId }));
  assert.equal(on.status, 200);
  assert.equal(on.body.enabled, 1);
  assert.equal((await getAssignment(id)).enabled, 1);
  assert.equal((await jfetch(`/api/playlists/${S.playlistId}/publish`, post(S.jwt, {}))).status, 200);
  assert.ok(publishedContentIds(S.playlistId).includes(c), 'enabled again, it is published');

  // An edit that does not mention enabled leaves it alone.
  assert.equal((await jfetch(`/api/assignments/${id}`, put(S.jwt, { muted: true, device_id: S.deviceId }))).body.enabled, 1);
});

// The Playlists page adds through /api/playlists/:id/items, not the screen's route. A screen's own
// playlist has no layout of its own (the layout is on the screen), so the fallback finds the layout
// its screens draw, and only when that is ONE layout.
test('Playlists page: an item added without a zone gets the screen layout\'s main zone, unless screens with different layouts share it', async () => {
  const addTo = (pl, name) => jfetch(`/api/playlists/${pl}/items`, post(S.jwt, { content_id: mkC(name), duration_sec: 10 }));

  let r = await addTo(S.playlistId, 'pl-page-1');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.zone_id, S.Z1, 'the one screen draws L1: its main zone');

  // A second playlist shared by two screens with different two-zone layouts: no single main zone.
  const l3 = await jfetch('/api/layouts', post(S.jwt, { name: 'L3', zones: [{ name: 'Top', width_percent: 100, height_percent: 70 }, { name: 'Bottom', width_percent: 100, height_percent: 30 }] }));
  const shared = (await jfetch('/api/playlists', post(S.jwt, { name: 'shared-pl' }))).body.id;
  const devA = crypto.randomUUID(); const devB = crypto.randomUUID();
  const insDev = db.prepare("INSERT INTO devices (id, name, status, workspace_id, user_id, layout_id, playlist_id, wall_id) VALUES (?,?,?,?,?,?,?,?)");
  insDev.run(devA, 'SharedA', 'online', S.wsA, S.userId, S.L1, shared, null);
  r = await addTo(shared, 'shared-one-screen');
  assert.equal(r.body.zone_id, S.Z1, 'one screen so far: its main zone');
  insDev.run(devB, 'SharedB', 'online', S.wsA, S.userId, l3.body.id, shared, null);
  r = await addTo(shared, 'shared-two-layouts');
  assert.equal(r.body.zone_id, null, 'two layouts: stays zone-less and plays in each screen\'s main zone');

  // A video wall member is placed by the wall's layout, not its own: left out of the lookup.
  const wallPl = (await jfetch('/api/playlists', post(S.jwt, { name: 'wall-pl' }))).body.id;
  const devW = crypto.randomUUID();
  insDev.run(devW, 'WallMember', 'online', S.wsA, S.userId, S.L1, wallPl, 'some-wall');
  r = await addTo(wallPl, 'wall-item');
  assert.equal(r.body.zone_id, null, 'a wall member\'s own layout is not used');

  // A single-zone layout: nothing to name (the payload strips zone ids there anyway).
  const solo = (await jfetch('/api/playlists', post(S.jwt, { name: 'solo-pl' }))).body.id;
  const devS = crypto.randomUUID();
  insDev.run(devS, 'Solo', 'online', S.wsA, S.userId, (await jfetch('/api/layouts', post(S.jwt, { name: 'One', zones: [{ name: 'All', width_percent: 100, height_percent: 100 }] }))).body.id, solo, null);
  r = await addTo(solo, 'solo-item');
  assert.equal(r.body.zone_id, null);

  db.prepare('DELETE FROM devices WHERE id IN (?, ?, ?, ?)').run(devA, devB, devW, devS);
});
