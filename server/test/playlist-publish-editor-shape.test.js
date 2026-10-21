'use strict';

/*
 * The playlist editor redraws from the publish (and discard) response. Those used to answer with
 * the bare row + items, so after Publish the editor lost the layout ("Each screen's own layout"),
 * the Default zone row, every zone picker and each item's schedule chip until a reload — screens
 * and the database were fine, but it looked like work was lost. They must answer with exactly
 * GET /:id's shape (routes/playlists.js editorPlaylistPayload).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { freePort } = require('./helpers/free-port');

let BASE, proc;
const DATA_DIR = path.join(os.tmpdir(), 'st-pl-publish-shape-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
const S = {};

async function jfetch(p, opts = {}) {
  const res = await fetch(BASE + p, opts);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}
const H = () => ({ Authorization: 'Bearer ' + S.jwt, 'Content-Type': 'application/json' });
const get = (p) => jfetch(p, { headers: H() });
const post = (p, obj) => jfetch(p, { method: 'POST', headers: H(), body: JSON.stringify(obj) });
const put = (p, obj) => jfetch(p, { method: 'PUT', headers: H(), body: JSON.stringify(obj) });

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
  const reg = await jfetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'plshape@test.local', password: 'test12345', name: 'plshape' }) });
  assert.ok(reg.body && reg.body.token, 'register: ' + JSON.stringify(reg.body));
  S.jwt = reg.body.token;

  // A playlist with a layout, a default zone, items in two zones and a Sat-Sun schedule.
  const layout = (await post('/api/layouts', { name: 'Split', zones: [
    { name: 'Left', x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 100 },
    { name: 'Right', x_percent: 50, y_percent: 0, width_percent: 50, height_percent: 100 },
  ] })).body;
  const left = layout.zones.find((z) => z.name === 'Left').id;
  const right = layout.zones.find((z) => z.name === 'Right').id;
  const widget = (await post('/api/widgets', { name: 'Clock', widget_type: 'clock', config: {} })).body.id;
  S.pl = (await post('/api/playlists', { name: 'Shape' })).body.id;
  assert.equal((await put(`/api/playlists/${S.pl}`, { layout_id: layout.id })).status, 200);
  assert.equal((await put(`/api/playlists/${S.pl}`, { default_zone_id: right })).status, 200);
  const items = [];
  for (const zone_id of [left, right]) {
    const r = await post(`/api/playlists/${S.pl}/items`, { widget_id: widget, zone_id });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    items.push(r.body.id);
  }
  const sch = await put(`/api/playlists/${S.pl}/items/${items[0]}/schedules`, { blocks: [{ days: [0, 6], start: '09:00', end: '17:00' }] });
  assert.equal(sch.status, 200, JSON.stringify(sch.body));
  S.right = right;
  S.layoutId = layout.id;
});
after(() => { try { proc.kill(); } catch { /* */ } });

// What the editor reads from the payload; the rest must match too (deepEqual below).
function assertEditorFields(body, label) {
  assert.ok(body.layout && body.layout.explicit, `${label}: layout missing — the Layout row would say "Each screen's own layout"`);
  assert.equal(body.layout.id, S.layoutId, `${label}: layout id`);
  assert.equal(body.layout.default_zone_id, S.right, `${label}: default zone`);
  assert.ok(body.items.every((it) => it.zone_id), `${label}: every item keeps its zone`);
  const scheduled = body.items.find((it) => Array.isArray(it.schedules) && it.schedules.length);
  assert.ok(scheduled, `${label}: item schedules missing — the Sat-Sun chip would vanish`);
}

test('publish answers with exactly what GET /:id returns', async () => {
  const pub = await post(`/api/playlists/${S.pl}/publish`, {});
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  const fresh = await get(`/api/playlists/${S.pl}`);
  assert.equal(fresh.status, 200);
  assertEditorFields(fresh.body, 'GET');
  assertEditorFields(pub.body, 'publish');
  assert.deepEqual(pub.body, fresh.body);
});

test('discard answers with exactly what GET /:id returns', async () => {
  // Make a draft (a duration change), then throw it away.
  const before = (await get(`/api/playlists/${S.pl}`)).body;
  const r = await put(`/api/playlists/${S.pl}/items/${before.items[1].id}`, { duration_sec: 42 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await get(`/api/playlists/${S.pl}`)).body.status, 'draft');
  const dis = await post(`/api/playlists/${S.pl}/discard`, {});
  assert.equal(dis.status, 200, JSON.stringify(dis.body));
  const fresh = await get(`/api/playlists/${S.pl}`);
  assertEditorFields(dis.body, 'discard');
  assert.deepEqual(dis.body, fresh.body);
});
