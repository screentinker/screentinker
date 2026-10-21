'use strict';

/*
 * Simple view → "Change what a screen shows" → Replace, on a screen whose GROUP has a playlist.
 *
 * Replace clears the screen's own list when it follows a shared one, so the screen falls back to its
 * group's; the next add then FORKED the group's list (server/lib/fork-device-playlist.js) and
 * appended to it. The screen ended up playing the group's items plus the new photo — "replace"
 * behaved as "add", while the UI promised "Only the new photos and videos will play on this screen".
 *
 * The real showOnScreen() from frontend/js/views/simple-home.js is run (imports stripped) against a
 * spawned server, with an `api` that makes the same requests as frontend/js/api.js. What is asserted
 * is what the screen RESOLVES to, plus that the group's list and the other screens are untouched.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { freePort } = require('./helpers/free-port');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc, BASE, DATA_DIR, jwt, workspaceId, contentA, contentB, contentC;

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'simple-home.js'), 'utf8');

const J = (t, b, m = 'POST') => ({
  method: m,
  headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
  ...(b === undefined ? {} : { body: JSON.stringify(b) }),
});
const raw = async (p, ...a) => { const r = await fetch(BASE + p, ...a); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const dbh = () => new (require('better-sqlite3'))(path.join(DATA_DIR, 'db', 'remote_display.db'));
const q = (sql, ...args) => { const d = dbh(); const v = d.prepare(sql).all(...args); d.close(); return v; };

// frontend/js/api.js request(): JSON in, JSON out, throws on an error status.
async function request(p, opts = {}) {
  const r = await fetch(`${BASE}/api${p}`, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error || String(r.status)), { status: r.status });
  return body;
}
const api = {
  getAssignments: (deviceId) => request(`/assignments/device/${deviceId}`),
  addAssignment: (deviceId, data) => request(`/assignments/device/${deviceId}`, { method: 'POST', body: JSON.stringify(data) }),
  deleteAssignment: (id, deviceId) => request(`/assignments/${id}${deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : ''}`, { method: 'DELETE' }),
  assignPlaylistToDevice: (playlistId, device_id) => request(`/playlists/${playlistId}/assign`, { method: 'POST', body: JSON.stringify({ device_id }) }),
  clearDevicePlaylist: (device_id) => request(`/devices/${device_id}/playlist`, { method: 'DELETE' }),
};
const publishOrSubmit = async (id) => { await request(`/playlists/${id}/publish`, { method: 'POST' }); return 'live'; };

function loadShowOnScreen() {
  const src = SRC
    .replace(/^import [\s\S]*?from '[^']+';\n/gm, '')
    .replace(/^export (const|function|async function|let) /gm, '$1 ')
    .replace(/^export \{[^}]*\};?$/gm, '');
  const box = { module: {}, URL, console, api, publishOrSubmit, window: {}, document: {} };
  vm.runInNewContext(`${src}\nmodule.exports = { showOnScreen };`, box);
  return box.module.exports.showOnScreen;
}

// What the Simple view does: fetch devices + playlists, then showOnScreen on the chosen screen.
async function simpleReplace(deviceId, ids) {
  const [devices, playlists] = await Promise.all([request('/devices'), request('/playlists')]);
  const device = devices.find((d) => d.id === deviceId);
  return loadShowOnScreen()(device, ids, 'replace', { devices, playlists });
}

const resolved = (id) => q('SELECT playlist_id, source FROM device_resolved_playlist WHERE device_id = ?', id)[0];
const draftOf = (pl) => q('SELECT content_id FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order, id', pl).map((r) => r.content_id);
const playedBy = (pl) => JSON.parse(q('SELECT published_snapshot FROM playlists WHERE id = ?', pl)[0].published_snapshot || '[]').map((i) => i.content_id);

const mkContent = (name) => {
  const d = dbh(); const id = crypto.randomUUID();
  const u = d.prepare('SELECT id FROM users LIMIT 1').get();
  d.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, duration_sec)
             VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, u.id, workspaceId, name, `uploads/${name}`, 'image/jpeg', 10);
  d.close(); return id;
};
const mkDevice = (name) => {
  const d = dbh(); const id = crypto.randomUUID();
  const u = d.prepare('SELECT id FROM users LIMIT 1').get();
  d.prepare('INSERT INTO devices (id, user_id, workspace_id, name, pairing_code) VALUES (?, ?, ?, ?, ?)')
    .run(id, u.id, workspaceId, name, crypto.randomUUID().slice(0, 6));
  d.close(); return id;
};

before(async () => {
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-replace-'));
  const logFd = fs.openSync(path.join(DATA_DIR, 'server.log'), 'a');
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot');
  const reg = await (await fetch(BASE + '/api/auth/register', J(null, {
    email: `simple${Date.now()}@example.com`, password: 'Passw0rd123', name: 'Simple',
  }))).json();
  jwt = reg.token; workspaceId = reg.current_workspace_id;
  contentA = mkContent('group.jpg'); contentB = mkContent('new.jpg'); contentC = mkContent('later.jpg');
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

async function groupWithTwoScreens(label) {
  const group = (await raw('/api/groups', J(jwt, { name: label }))).body;
  const shared = (await raw('/api/playlists', J(jwt, { name: `${label} playlist` }))).body;
  await raw(`/api/playlists/${shared.id}/items`, J(jwt, { content_id: contentA, duration_sec: 10 }));
  await raw(`/api/playlists/${shared.id}/publish`, J(jwt, {}));
  const mine = mkDevice(`${label} Counter TV`); const other = mkDevice(`${label} other`);
  await raw(`/api/groups/${group.id}/assign-playlist`, J(jwt, { playlist_id: shared.id }));
  await raw(`/api/groups/${group.id}/devices`, J(jwt, { device_id: mine }));
  await raw(`/api/groups/${group.id}/devices`, J(jwt, { device_id: other }));
  return { group, shared, mine, other };
}

function assertOnlyNew(mine, shared, other, want) {
  const r = resolved(mine);
  assert.equal(r.source, 'device', 'the screen must play its own list after Replace');
  assert.notEqual(r.playlist_id, shared.id);
  assert.deepEqual(playedBy(r.playlist_id), want, 'Replace must leave ONLY the chosen items playing, not the group\'s plus them');
  assert.deepEqual(draftOf(r.playlist_id), want);
  assert.deepEqual(draftOf(shared.id), [contentA], "the group's playlist must not change");
  assert.deepEqual(playedBy(shared.id), [contentA]);
  assert.equal(resolved(other).playlist_id, shared.id, 'the other screen in the group must be untouched');
}

test('⚠️ Replace on a screen that inherits its group\'s playlist shows ONLY the new items', async () => {
  const { shared, mine, other } = await groupWithTwoScreens('lobby');
  assert.equal(resolved(mine).source, 'group', 'precondition: the screen inherits');
  await simpleReplace(mine, [contentB]);
  assertOnlyNew(mine, shared, other, [contentB]);
});

test('Replace on a grouped screen that followed ANOTHER list ("same as") does not fall back to the group\'s items', async () => {
  const { shared, mine, other } = await groupWithTwoScreens('atrium');
  const handMade = (await raw('/api/playlists', J(jwt, { name: 'Hand made' }))).body;
  await raw(`/api/playlists/${handMade.id}/items`, J(jwt, { content_id: contentC, duration_sec: 10 }));
  await raw(`/api/playlists/${handMade.id}/publish`, J(jwt, {}));
  await raw(`/api/playlists/${handMade.id}/assign`, J(jwt, { device_id: mine }));
  assert.equal(resolved(mine).playlist_id, handMade.id, 'precondition');

  await simpleReplace(mine, [contentB]);
  assertOnlyNew(mine, shared, other, [contentB]);
  assert.deepEqual(draftOf(handMade.id), [contentC], 'the hand-made list must never be edited by Replace');
});

test('a second Replace reuses the screen\'s list and again shows only what was chosen', async () => {
  const { shared, mine, other } = await groupWithTwoScreens('foyer');
  await simpleReplace(mine, [contentB]);
  const first = resolved(mine).playlist_id;
  await simpleReplace(mine, [contentC, contentB]);
  assert.equal(resolved(mine).playlist_id, first, 'Replace must not mint a new playlist each time');
  assertOnlyNew(mine, shared, other, [contentC, contentB]);
});

test('Replace on a screen with no group still shows only the chosen items', async () => {
  const solo = mkDevice('Solo TV');
  await simpleReplace(solo, [contentB]);
  const r = resolved(solo);
  assert.equal(r.source, 'device');
  assert.deepEqual(playedBy(r.playlist_id), [contentB]);
});

test('source: the clean-up is Replace-only and skipped when head office\'s playlist redirected the adds', () => {
  const fn = SRC.slice(SRC.indexOf('export async function showOnScreen'), SRC.indexOf('async function useSameAs'));
  const cleanup = fn.indexOf("if (how === 'replace' && !redirected && added.size)");
  assert.ok(cleanup > fn.indexOf('api.addAssignment'), 'the inherited items can only be dropped AFTER the add that forked them');
  assert.ok(cleanup < fn.indexOf('publishOrSubmit'), 'and before publishing, or the group\'s items go live on this screen');
  assert.match(fn, /r\.redirected_to\) redirected = true/);
});
