'use strict';

/*
 * #660, the playlist half: a playlist's own background colour, and "Transparent background" on one
 * item. Both are stored on the draft, go live on publish, come back on discard, ride every copy, and
 * stay out of a snapshot when unset, so a playlist that never uses them publishes the same bytes.
 * The tick reaches a screen as `transparent=1` on the item's render URL, which the server answers
 * with the page drawn see-through.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const bg = require('../lib/backgrounds');

const { freePort } = require('./helpers/free-port');
let PORT, BASE;
const DATA_DIR = path.join(os.tmpdir(), 'st-plbg-test-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-plbg-' + crypto.randomBytes(4).toString('hex') + '.log');
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
const item = (id) => db.prepare('SELECT * FROM playlist_items WHERE id = ?').get(id);
const pl = (id) => db.prepare('SELECT * FROM playlists WHERE id = ?').get(id);
const snapshot = (id) => JSON.parse(pl(id).published_snapshot);

// ---------------------------------------------------------------- unit: the shared rules

test('#660: the stored playlist colour is a hex value or null', () => {
  assert.equal(bg.normalizePlaylistBg('#AABBCC'), '#aabbcc');
  assert.equal(bg.normalizePlaylistBg('#abc'), '#abc');
  for (const v of [null, undefined, '', 'none', 'red', '#12', 'transparent', '#aabbcc;}', 7]) assert.equal(bg.normalizePlaylistBg(v), null, String(v));
});

test('#660: the item flag is 1 or NULL, and only widgets and HTML bundles carry it', () => {
  for (const on of [true, 1, '1', 'true', 'on']) assert.equal(bg.normalizeTransparentBg(on), 1);
  for (const off of [false, 0, '0', '', null, undefined, 'no']) assert.equal(bg.normalizeTransparentBg(off), null);
  assert.equal(bg.transparentApplies({ widget_id: 'w' }), true);
  assert.equal(bg.transparentApplies({ mime_type: 'application/vnd.screentinker.bundle+zip' }), true);
  for (const m of ['image/png', 'video/mp4', 'video/youtube', null]) assert.equal(bg.transparentApplies({ mime_type: m }), false, String(m));
});

test('#660: the see-through page wins over the page\'s own colour, before </head> or at the start', () => {
  assert.equal(bg.forceTransparent('<html><head><title>t</title></head><body>x</body></html>'),
    `<html><head><title>t</title>${bg.TRANSPARENT_CSS}</head><body>x</body></html>`);
  assert.equal(bg.forceTransparent('<p>x</p>'), bg.TRANSPARENT_CSS + '<p>x</p>');
  assert.match(bg.TRANSPARENT_CSS, /html,body,\.stage\{background:transparent!important/);
  assert.equal(bg.wantsTransparent({ transparent: '1' }), true);
  for (const q of [{}, { transparent: '0' }, { transparent: 'yes' }, null]) assert.equal(bg.wantsTransparent(q), false);
});

test('#660: every player adds the same style to a cached bundle as the server does', () => {
  const root = path.join(__dirname, '..', '..');
  const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
  const css = bg.TRANSPARENT_CSS;
  const kotlin = read('android', 'app', 'src', 'main', 'java', 'com', 'remotedisplay', 'player', 'util', 'WidgetUrls.kt');
  assert.ok(kotlin.includes(css.replace(/"/g, '\\"')), 'Android WidgetUrls.TRANSPARENT_CSS');
  const py = read('native', 'screentinker_native', 'logic', 'transparent_bg.py').replace(/'\n\s+'/g, '');
  assert.ok(py.includes(css), 'native logic/transparent_bg.py');
  assert.ok(read('tizen', 'js', 'player.js').includes(css), 'Tizen player.js');
});

// -------------------------------------------------------------- end to end on the routes

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

  const reg = await jfetch('/api/auth/register', post(null, { email: 'b' + crypto.randomBytes(4).toString('hex') + '@x.local', password: PW }));
  S.jwt = reg.body.token;
  S.userId = reg.body.user.id;
  S.ws = reg.body.current_workspace_id;

  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'), { timeout: 5000 });
  db.pragma('foreign_keys = OFF');
  S.cImage = crypto.randomUUID();
  db.prepare("INSERT INTO content (id, filename, filepath, mime_type, file_size, workspace_id) VALUES (?, 'poster.png', '', 'image/png', 0, ?)").run(S.cImage, S.ws);
  S.widget = crypto.randomUUID();
  db.prepare("INSERT INTO widgets (id, widget_type, name, config, workspace_id, user_id) VALUES (?, 'clock', 'Clock', ?, ?, ?)")
    .run(S.widget, JSON.stringify({ background: '#123456' }), S.ws, S.userId);
});

after(() => {
  try { db?.close(); } catch { /* */ }
  try { proc?.kill('SIGKILL'); } catch { /* */ }
  for (const f of [DATA_DIR, LOG]) { try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* */ } }
});

test('#660: a playlist colour is saved as hex, cleared with "", and refused when it is not a colour', async () => {
  const p = await jfetch('/api/playlists', post(S.jwt, { name: 'bg' }));
  S.pl = p.body.id;
  const img = await jfetch(`/api/playlists/${S.pl}/items`, post(S.jwt, { content_id: S.cImage }));
  S.itemImg = img.body.id;
  const w = await jfetch(`/api/playlists/${S.pl}/items`, post(S.jwt, { widget_id: S.widget }));
  assert.equal(w.status, 201);
  S.itemW = w.body.id;
  await jfetch(`/api/playlists/${S.pl}/publish`, post(S.jwt, {}));

  const set = await jfetch(`/api/playlists/${S.pl}`, put(S.jwt, { background_color: '#FFFFFF' }));
  assert.equal(set.status, 200);
  assert.equal(set.body.background_color, '#ffffff');
  assert.equal(pl(S.pl).status, 'draft', 'a colour change is a draft change, like the playback order');
  assert.equal(pl(S.pl).published_background_color, null, 'screens keep the old colour until publish');

  const bad = await jfetch(`/api/playlists/${S.pl}`, put(S.jwt, { background_color: 'red;}' }));
  assert.equal(bad.status, 400);
  assert.equal(pl(S.pl).background_color, '#ffffff');
});

test('#660: publishing a colour-only change is not skipped as "unchanged", and discard brings the old one back', async () => {
  const pub = await jfetch(`/api/playlists/${S.pl}/publish`, post(S.jwt, {}));
  assert.equal(pub.status, 200);
  assert.equal(pl(S.pl).published_background_color, '#ffffff', 'the items did not change, the colour did');

  await jfetch(`/api/playlists/${S.pl}`, put(S.jwt, { background_color: '#000080' }));
  const d = await jfetch(`/api/playlists/${S.pl}/discard`, post(S.jwt, {}));
  assert.equal(d.status, 200);
  assert.equal(pl(S.pl).background_color, '#ffffff');
  // A discard rebuilds the items, under new ids.
  S.itemW = db.prepare('SELECT id FROM playlist_items WHERE playlist_id = ? AND widget_id = ?').get(S.pl, S.widget).id;
  S.itemImg = db.prepare('SELECT id FROM playlist_items WHERE playlist_id = ? AND content_id = ?').get(S.pl, S.cImage).id;

  const clear = await jfetch(`/api/playlists/${S.pl}`, put(S.jwt, { background_color: '' }));
  assert.equal(clear.status, 200);
  assert.equal(pl(S.pl).background_color, null, '"" means the screen\'s own colour');
});

test('#660: the preview shows the draft\'s colour', async () => {
  await jfetch(`/api/playlists/${S.pl}`, put(S.jwt, { background_color: '#00ff00' }));
  const prev = await jfetch(`/api/playlists/${S.pl}/preview-payload`, auth(S.jwt));
  assert.equal(prev.status, 200);
  assert.equal(prev.body.background_color, '#00ff00');
});

test('#660: Transparent background is per item, on widgets and bundles only', async () => {
  const on = await jfetch(`/api/playlists/${S.pl}/items/${S.itemW}`, put(S.jwt, { transparent_bg: true }));
  assert.equal(on.status, 200);
  assert.equal(item(S.itemW).transparent_bg, 1);
  const bad = await jfetch(`/api/playlists/${S.pl}/items/${S.itemImg}`, put(S.jwt, { transparent_bg: true }));
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /widgets and HTML bundles/);
  const off = await jfetch(`/api/playlists/${S.pl}/items/${S.itemImg}`, put(S.jwt, { transparent_bg: false }));
  assert.equal(off.status, 200, 'turning it off is always allowed');
});

test('#660: the snapshot carries the flag only where it is set', async () => {
  await jfetch(`/api/playlists/${S.pl}/publish`, post(S.jwt, {}));
  const snap = snapshot(S.pl);
  assert.equal(snap.find((i) => i.widget_id === S.widget).transparent_bg, 1);
  assert.ok(!('transparent_bg' in snap.find((i) => i.content_id === S.cImage)));
  assert.equal(pl(S.pl).published_background_color, '#00ff00');
});

test('#660: a playlist that uses neither publishes exactly as before', async () => {
  const p = await jfetch('/api/playlists', post(S.jwt, { name: 'plain' }));
  await jfetch(`/api/playlists/${p.body.id}/items`, post(S.jwt, { widget_id: S.widget }));
  await jfetch(`/api/playlists/${p.body.id}/publish`, post(S.jwt, {}));
  const row = pl(p.body.id);
  assert.ok(!row.published_snapshot.includes('transparent_bg'));
  assert.ok(!row.published_structure.includes('transparent_bg'));
  assert.equal(row.published_background_color, null);
});

test('#660: discard, duplicate and the bulk action keep or set the flag', async () => {
  await jfetch(`/api/playlists/${S.pl}/items/${S.itemW}`, put(S.jwt, { transparent_bg: false }));
  await jfetch(`/api/playlists/${S.pl}/discard`, post(S.jwt, {}));
  const restored = db.prepare('SELECT * FROM playlist_items WHERE playlist_id = ? AND widget_id = ?').get(S.pl, S.widget);
  assert.equal(restored.transparent_bg, 1, 'discard restored the item with its flag');

  const dup = await jfetch(`/api/playlists/${S.pl}/items/${restored.id}/duplicate`, post(S.jwt, {}));
  assert.ok(dup.status === 200 || dup.status === 201, `duplicate returned ${dup.status}`);
  const copies = db.prepare('SELECT * FROM playlist_items WHERE playlist_id = ? AND widget_id = ?').all(S.pl, S.widget);
  assert.equal(copies.length, 2);
  assert.ok(copies.every((c) => c.transparent_bg === 1));

  const ids = db.prepare('SELECT id FROM playlist_items WHERE playlist_id = ?').all(S.pl).map((r) => r.id);
  const r = await jfetch(`/api/playlists/${S.pl}/items/selection`, post(S.jwt, { action: 'transparent_bg', ids, transparent_bg: false }));
  assert.equal(r.status, 200);
  assert.equal(r.body.skipped, 1, 'the image is skipped, not refused');
  assert.ok(copies.every((c) => item(c.id).transparent_bg === null));
});

test('#660: the render route draws the widget see-through for transparent=1, and only then', async () => {
  const plain = await (await fetch(`${BASE}/api/widgets/${S.widget}/render?rev=1`)).text();
  assert.match(plain, /background:#123456/, 'the widget\'s own colour');
  assert.ok(!plain.includes('st-transparent'));
  const clear = await (await fetch(`${BASE}/api/widgets/${S.widget}/render?rev=1&transparent=1`)).text();
  assert.ok(clear.includes(bg.TRANSPARENT_CSS), 'the see-through style is in the page');
  assert.ok(clear.indexOf(bg.TRANSPARENT_CSS) < clear.toLowerCase().indexOf('</head>'));
});
