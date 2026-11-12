'use strict';

/*
 * THE VISION MIXER.
 *
 * The mixer puts a playlist on air on several screens at once (POST /api/mixer/take) and keys
 * animated graphics over them (the pages at /gfx/:kind, shown through the overlay the players
 * already have). What has to hold:
 *
 *   - TAKE is the same "this screen plays this playlist" as everywhere else, with the same
 *     limits: only screens and playlists of the caller's own workspace, not by a read-only
 *     member, and each screen it could not take is reported, not silently dropped;
 *   - a take is pushed with `cut_now`, and the web player treats that as "switch now", not "at the
 *     end of the current item";
 *   - a graphics page shows only the text it was handed, as text, with no script allowed at all,
 *     and may be framed by any player;
 *   - "broadcast" is a view a person can choose and keep.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc, db, BASE;
const DATA_DIR = path.join(os.tmpdir(), 'st-mixer-' + crypto.randomBytes(4).toString('hex'));
const A = {}, B = {}, V = {};

const call = async (method, p, tok, body) => {
  const res = await fetch(BASE + p, { method, headers: { ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, body: json, text, headers: res.headers };
};
async function account(o, name) {
  const r = await call('POST', '/api/auth/register', null, { email: name + crypto.randomBytes(4).toString('hex') + '@example.com', password: 'Passw0rd123', name });
  assert.ok(r.body && r.body.token, r.text);
  Object.assign(o, { jwt: r.body.token, userId: r.body.user.id, wsId: r.body.current_workspace_id });
}
function screen(o, name) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO devices (id, name, status, workspace_id, user_id, device_token, client_type, created_at) VALUES (?, ?, 'online', ?, ?, ?, 'web', strftime('%s','now'))`)
    .run(id, name, o.wsId, o.userId, crypto.randomBytes(16).toString('hex'));
  return id;
}
async function playlist(o, name) {
  const pl = await call('POST', '/api/playlists', o.jwt, { name });
  assert.equal(pl.status, 201, pl.text);
  const cid = crypto.randomUUID();
  db.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, duration_sec) VALUES (?, ?, ?, 'a.png', 'a.png', 'image/png', 10, 10)`).run(cid, o.userId, o.wsId);
  assert.equal((await call('POST', `/api/playlists/${pl.body.id}/items`, o.jwt, { content_id: cid })).status, 201);
  return pl.body.id;
}

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const logFd = fs.openSync(DATA_DIR + '.log', 'w');
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(port), NODE_ENV: 'test' }, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/status')).ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot');
  await account(A, 'alpha');
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  await account(B, 'beta');
  await account(V, 'viewer');
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_viewer')").run(A.wsId, V.userId);
  const sw = await call('POST', '/api/auth/switch-workspace', V.jwt, { workspace_id: A.wsId });
  V.jwt = (sw.body && sw.body.token) || V.jwt;
});
after(() => { try { db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

test('the desk lists this workspace\'s screens and its playlists that have something to play', async () => {
  const s1 = screen(A, 'Lobby'); screen(B, 'Theirs');
  const full = await playlist(A, 'Morning');
  const empty = (await call('POST', '/api/playlists', A.jwt, { name: 'Empty' })).body.id;
  const r = await call('GET', '/api/mixer', A.jwt);
  assert.equal(r.status, 200, r.text);
  assert.ok(r.body.screens.some((s) => s.id === s1));
  assert.ok(!r.body.screens.some((s) => s.name === 'Theirs'), 'not another workspace\'s screens');
  assert.ok(r.body.sources.some((p) => p.id === full));
  assert.ok(!r.body.sources.some((p) => p.id === empty), 'an empty playlist is not a source');
  assert.deepEqual(r.body.graphics.map((g) => g.kind), ['lower-third', 'crawl', 'bug', 'title', 'countdown', 'comment']);
});

test('a take puts the playlist on every chosen screen and says what each was showing', async () => {
  const s1 = screen(A, 'One'), s2 = screen(A, 'Two');
  const first = await playlist(A, 'First'), second = await playlist(A, 'Second');
  const a = await call('POST', '/api/mixer/take', A.jwt, { device_ids: [s1, s2], playlist_id: first });
  assert.equal(a.status, 200, a.text);
  assert.equal(a.body.taken.length, 2);
  for (const id of [s1, s2]) {
    const row = db.prepare('SELECT playlist_id, playlist_source FROM devices WHERE id = ?').get(id);
    assert.deepEqual({ ...row }, { playlist_id: first, playlist_source: 'device' });
  }
  const b = await call('POST', '/api/mixer/take', A.jwt, { device_ids: [s1], playlist_id: second });
  assert.equal(b.body.taken[0].previous_playlist_id, first, 'so the desk can cut back');
  assert.equal(db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(s2).playlist_id, first, 'a screen that was not chosen is untouched');
});

test('a take reaches only the caller\'s own screens and playlists', async () => {
  const mine = screen(A, 'Mine'), theirs = screen(B, 'Theirs');
  const myList = await playlist(A, 'Mine'), theirList = await playlist(B, 'Theirs');
  const mixed = await call('POST', '/api/mixer/take', A.jwt, { device_ids: [mine, theirs, 'no-such-screen'], playlist_id: myList });
  assert.equal(mixed.status, 200);
  assert.deepEqual(mixed.body.taken.map((x) => x.device_id), [mine]);
  assert.deepEqual(mixed.body.skipped.map((x) => x.reason), ['not_found', 'not_found'], 'the others are reported, and not as existing');
  assert.equal(db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(theirs).playlist_id, null);
  assert.equal((await call('POST', '/api/mixer/take', A.jwt, { device_ids: [mine], playlist_id: theirList })).status, 404, 'another workspace\'s playlist is not a source');
});

test('a read-only member can look at the desk but cannot take', async () => {
  const s = screen(A, 'ReadOnly'), p = await playlist(A, 'ForViewer');
  assert.equal((await call('GET', '/api/mixer', V.jwt)).status, 200);
  assert.equal((await call('POST', '/api/mixer/take', V.jwt, { device_ids: [s], playlist_id: p })).status, 403);
  assert.equal(db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(s).playlist_id, null);
});

test('malformed takes are refused', async () => {
  const p = await playlist(A, 'Shape');
  for (const body of [{}, { device_ids: [], playlist_id: p }, { device_ids: 'x', playlist_id: p }, { device_ids: [screen(A, 'S')] }, { device_ids: [1, 2], playlist_id: p }]) {
    assert.equal((await call('POST', '/api/mixer/take', A.jwt, body)).status, 400, JSON.stringify(body));
  }
});

test('a take is pushed as a cut, and the web player switches at once on it', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'mixer.js'), 'utf8');
  assert.match(route, /cut_now: true/, 'the pushed payload carries the flag');
  assert.match(route, /p && !p\.suspended \? \{ \.\.\.p, cut_now: true/, 'and never dresses up a suspended screen\'s payload');
  for (const f of ['index.html', 'legacy.html']) {
    const player = fs.readFileSync(path.join(__dirname, '..', 'player', f), 'utf8');
    assert.match(player, /cutNow = data\.cut_now === true/, `${f}: the flag is read`);
    assert.match(player, /!interruptNow && !stageChanged && !cutNow\) \{\s*deferredRotation = true;/, `${f}: and a cut skips the wait for the current item`);
  }
});

test('a graphics page shows the text it is given as text, runs nothing, and can be framed by any player', async () => {
  const evil = '<img src=x onerror=alert(1)>"\'</style><script>alert(2)</script>';
  for (const kind of ['lower-third', 'crawl', 'bug', 'title', 'countdown', 'comment']) {
    const r = await call('GET', `/gfx/${kind}?a=${encodeURIComponent(evil)}&b=${encodeURIComponent(evil)}&accent=${encodeURIComponent('red;}</style>')}`);
    assert.equal(r.status, 200, kind);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    assert.doesNotMatch(r.text, /<script|<img/i, `${kind}: no tag from the text survives`);
    assert.match(r.text, /&lt;img src=x onerror=alert\(1\)&gt;/, `${kind}: and is shown`);
    assert.doesNotMatch(r.text, /red;\}/, `${kind}: a colour that is not a colour is not used`);
    const csp = r.headers.get('content-security-policy') || '';
    assert.match(csp, /default-src 'none'/); assert.doesNotMatch(csp, /script-src/, 'no script source is allowed at all');
    assert.doesNotMatch(csp, /frame-ancestors/, 'no framing restriction: `frame-ancestors *` would still refuse a file:// player');
    assert.equal(r.headers.get('x-frame-options'), null, 'a player on another origin may frame it');
  }
  assert.equal((await call('GET', '/gfx/nope?a=x')).status, 404);
  const long = await call('GET', '/gfx/title?a=' + 'A'.repeat(5000));
  assert.ok(long.text.length < 4000, 'text is capped');
});

test('a countdown reads its time, shows the right digits from the first second, and stops at zero', () => {
  const gfx = require('../lib/mixer-gfx');
  assert.deepEqual(['5', '5:00', '90s', '1:30:00', '0', '100:00', '5:75', 'soon', '', null].map(gfx.seconds), [300, 300, 90, 5400, null, null, null, null, null, null]);
  // What a digit column shows at second t: the cell its stepped animation has reached. The cells run n-1 down to 0.
  const shown = (html) => (t) => [...html.matchAll(/animation:roll(\d+) (\d+)s steps\(\d+\) -(\d+)s ([\d.]+) both/g)].map(([, n, cycle, offset, count]) => {
    const at = Math.min(t, Number(count) * Number(cycle) - Number(offset) - 1e-6) + Number(offset);      // held where it ends
    return Number(n) - 1 - Math.floor((at % Number(cycle)) / (Number(cycle) / Number(n)));
  }).join('');
  const at = shown(gfx.page('countdown', { a: '1:05' }));
  assert.deepEqual([0.2, 4.5, 5.5, 64.5, 65.5, 500].map(at), ['105', '101', '100', '001', '000', '000']);
  const long = shown(gfx.page('countdown', { a: '12:00' }));
  assert.deepEqual([0.5, 1.5, 719.5, 9999].map(long), ['1200', '1159', '0001', '0000']);
  assert.doesNotMatch(gfx.page('countdown', { a: 'x' }), /<script/i);
});

test('Broadcast is a view a person can choose and keep', async () => {
  const set = await call('PUT', '/api/auth/me', A.jwt, { ui_mode: 'broadcast' });
  assert.equal(set.status, 200, set.text);
  assert.equal((await call('GET', '/api/auth/me', A.jwt)).body.ui_mode, 'broadcast');
  await call('PUT', '/api/auth/me', A.jwt, { ui_mode: 'nonsense' });
  assert.equal((await call('GET', '/api/auth/me', A.jwt)).body.ui_mode, 'broadcast', 'an unknown value changes nothing');
  await call('PUT', '/api/auth/me', A.jwt, { ui_mode: 'advanced' });
  assert.equal((await call('GET', '/api/auth/me', A.jwt)).body.ui_mode, 'advanced');
});

/*
 * SCENES AND CAMERAS. A scene is a saved look (a source, a graphic, camera positions) recalled
 * with one key. Everything a scene names has to be the caller's own; the desk lists the cameras
 * that can be steered and no others.
 */
function camera(o, name, ptz) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, onvif) VALUES (?, ?, ?, ?, '', 'video/onvif', 0, ?)`)
    .run(id, o.userId, o.wsId, name, JSON.stringify({ xaddr: 'http://192.0.2.1/onvif/device_service', profile_token: 'p1', ptz }));
  return id;
}

test('the desk lists the cameras of this workspace that can be steered', async () => {
  const mine = camera(A, 'Stage cam', true); camera(A, 'Fixed cam', false); camera(B, 'Their cam', true);
  const r = await call('GET', '/api/mixer', A.jwt);
  assert.deepEqual(r.body.cameras.map((c) => c.name), ['Stage cam']);
  assert.equal(r.body.cameras[0].id, mine);
  assert.doesNotMatch(r.text, /192\.0\.2\.1/, 'a camera\'s address is not part of the desk');
});

test('a scene keeps its source, graphic and camera positions, and is recalled as saved', async () => {
  const src = await playlist(A, 'Interview'), cam = camera(A, 'Cam 1', true);
  const made = await call('POST', '/api/mixer/scenes', A.jwt, { name: 'Interview wide', playlist_id: src,
    graphic: { kind: 'lower-third', a: 'A name', b: 'A title', accent: '#00aaff' }, cameras: [{ camera_id: cam, preset: '3', preset_name: 'Wide' }] });
  assert.equal(made.status, 201, made.text);
  const got = (await call('GET', '/api/mixer', A.jwt)).body.scenes.find((s) => s.id === made.body.id);
  assert.deepEqual(got, { id: made.body.id, name: 'Interview wide', playlist_id: src,
    graphic: { kind: 'lower-third', a: 'A name', b: 'A title', accent: '#00aaff' }, cameras: [{ camera_id: cam, preset: '3', preset_name: 'Wide' }] });
  assert.ok(!(await call('GET', '/api/mixer', B.jwt)).body.scenes.some((s) => s.id === made.body.id), 'another workspace does not see it');
  assert.equal((await call('DELETE', `/api/mixer/scenes/${made.body.id}`, B.jwt)).status, 404, 'or delete it');
  assert.equal((await call('DELETE', `/api/mixer/scenes/${made.body.id}`, A.jwt)).status, 200);
});

test('a scene cannot name another workspace\'s source or camera, be empty, or be saved by a read-only member', async () => {
  const mine = await playlist(A, 'Mine2'), theirs = await playlist(B, 'Theirs2'), theirCam = camera(B, 'Their cam 2', true);
  for (const body of [{ name: 'x', playlist_id: theirs }, { name: 'x', playlist_id: mine, cameras: [{ camera_id: theirCam, preset: '1' }] },
    { name: 'x', playlist_id: mine, cameras: [{ camera_id: 'nope', preset: '1' }] }, { name: 'x' }, { name: '', playlist_id: mine },
    { name: 'x', playlist_id: mine, graphic: { kind: 'nope', a: 'x' } }, { name: 'x', playlist_id: mine, graphic: { kind: 'bug', a: '' } }]) {
    assert.equal((await call('POST', '/api/mixer/scenes', A.jwt, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call('POST', '/api/mixer/scenes', V.jwt, { name: 'x', playlist_id: mine })).status, 403);
});

/*
 * TAKE TRANSITIONS. A take may ask for a fade, a flash or a wipe. The switch is the job and the
 * transition is polish: an unknown one is refused at the door, and in the player any failure, or a
 * newer update arriving mid-transition, applies the update plainly.
 */
test('a take accepts the known transitions within a sane rate and refuses the rest', async () => {
  const s = screen(A, 'Tx'), p = await playlist(A, 'TxSource');
  for (const transition of [{ type: 'cut' }, { type: 'fade', ms: 600 }, { type: 'flash', ms: 200 }, { type: 'wipe', ms: 3000, color: '#00aaff' }, undefined]) {
    assert.equal((await call('POST', '/api/mixer/take', A.jwt, { device_ids: [s], playlist_id: p, transition })).status, 200, JSON.stringify(transition));
  }
  for (const transition of [{ type: 'spin' }, { type: 'fade', ms: 50 }, { type: 'fade', ms: 60000 }, { type: 'fade', ms: 'fast' }, 'fade', {}]) {
    assert.equal((await call('POST', '/api/mixer/take', A.jwt, { device_ids: [s], playlist_id: p, transition })).status, 400, JSON.stringify(transition));
  }
  assert.deepEqual((await call('GET', '/api/mixer', A.jwt)).body.transitions, ['cut', 'fade', 'flash', 'wipe']);
});

test('the web player runs a transition as a cover under the graphics layer, once, and fails open', () => {
  for (const f of ['index.html', 'legacy.html']) {
    const player = fs.readFileSync(path.join(__dirname, '..', 'player', f), 'utf8');
    const at = player.indexOf('function takeFxRun');
    const run = player.slice(at, player.indexOf('function handlePlaylistUpdate', at));
    assert.ok(at > 0 && run.length > 400, f);
    assert.match(run, /delete data\.take_fx/, `${f}: used once, so a cached playlist never replays it`);
    assert.match(run, /z-index:\s*8900/, `${f}: under the overlay layer (9000), so a keyed graphic stays up through it`);
    assert.match(run, /pointer-events:\s*none/, `${f}: the cover never takes a touch`);
    assert.match(run, /catch \(e\) \{\s*takeFxClear\(\);\s*return false;/, `${f}: an error means a plain switch`);
    assert.match(run, /removeChild\(el\)[\s\S]*ms \+ 2600\)/, `${f}: the cover removes itself on its own timer`);
    assert.match(run, /Date\.now\(\) - applied < 1500/, `${f}: it waits for the new picture, but not for ever`);
    assert.match(player, /takeFx && takeFx\.data !== data\) takeFxClear\(\);/, `${f}: a newer update supersedes a transition in progress`);
    assert.match(player, /data\.take_fx && !data\.suspended && typeof takeFxRun === ['"]function['"] && takeFxRun\(data\)/, `${f}: a suspension is never dressed up`);
  }
});

/*
 * SELF-HOSTED ONLY. On the hosted service the mixer is not offered: its API answers as if it were
 * not there, Broadcast cannot be chosen as a view, and the dashboard shows neither.
 */
test('on a hosted instance the mixer is not there and Broadcast cannot be chosen', async () => {
  const port = await freePort();
  const dir = path.join(os.tmpdir(), 'st-mixer-hosted-' + crypto.randomBytes(4).toString('hex'));
  const env = { ...process.env, DATA_DIR: dir, PORT: String(port), NODE_ENV: 'test' };
  delete env.SELF_HOSTED;
  const hosted = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
  try {
    const base = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/status')).ok) { up = true; break; } } catch { /* */ } await sleep(250); }
    assert.ok(up, 'hosted server boots');
    const j = async (m, p, tok, body) => { const r = await fetch(base + p, { method: m, headers: { ...(tok ? { Authorization: 'Bearer ' + tok } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const reg = await j('POST', '/api/auth/register', null, { email: 'h' + crypto.randomBytes(4).toString('hex') + '@example.com', password: 'Passw0rd123', name: 'H' });
    const tok = reg.body && reg.body.token;
    assert.ok(tok, JSON.stringify(reg.body));
    for (const [m, p, body] of [['GET', '/api/mixer'], ['POST', '/api/mixer/take', { device_ids: ['x'], playlist_id: 'y' }], ['POST', '/api/mixer/scenes', { name: 'x' }]]) {
      const r = await j(m, p, tok, body);
      assert.equal(r.status, 404, `${m} ${p}`); assert.equal(r.body.code, 'on_prem_only');
    }
    assert.equal((await j('GET', '/api/stream-out', tok)).body.available, false);
    await j('PUT', '/api/auth/me', tok, { ui_mode: 'broadcast' });
    const me = (await j('GET', '/api/auth/me', tok)).body;
    assert.notEqual(me.ui_mode, 'broadcast', 'Broadcast is not a view here');
    assert.equal(me.self_hosted, false, 'and the dashboard is told so, which is what hides the switch and the menu link');
    // Nor do the addresses the mixer's graphics, its renderer and its guests use.
    const secret = 'x'.repeat(48);
    for (const [m, p] of [['GET', '/gfx/lower-third?title=a'], ['GET', '/stream-render/live'], ['GET', '/guest/' + secret], ['GET', '/api/stream-feed'],
      ['POST', '/api/stream-guest/' + secret + '/join'], ['GET', '/stream-recording/' + secret]]) {
      assert.equal((await fetch(base + p, { method: m })).status, 404, `${m} ${p}`);
    }
    assert.equal((await fetch(base + '/api/status')).status, 200, 'and everything else still answers');
  } finally { try { hosted.kill('SIGKILL'); } catch { /* */ } }
});

test('the dashboard shows Broadcast and the Mixer link only when the account says the instance is self-hosted', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
  assert.match(read('index.html'), /data-ui-mode="broadcast" data-broadcast-only/);
  assert.match(read('index.html'), /<li data-advanced data-broadcast-only><a href="#\/mixer"/);
  assert.match(read('css/main.css'), /html:not\(\.has-broadcast\) \[data-broadcast-only\] \{ display: none !important; \}/);
  assert.match(read('js/nav-prime.js'), /user\.self_hosted === true\) document\.documentElement\.classList\.add\('has-broadcast'\)/);
  assert.match(read('js/components/ui-mode.js'), /classList\.toggle\('has-broadcast', user\.self_hosted === true\)/);
  assert.match(read('js/app.js'), /startsWith\('#\/mixer\/'\)\) && !document\.documentElement\.classList\.contains\('has-broadcast'\)/);
});
