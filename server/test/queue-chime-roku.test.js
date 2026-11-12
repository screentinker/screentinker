'use strict';

/*
 * The "Now serving" chime on a Roku (roku/source/lib/queuechime.brs, docs/now-serving-queue.md Sound).
 *
 * A Roku shows a server-rendered still of the queue widget, so the page's own chime never runs
 * there. The Roku polls the widget's queue.json itself and plays a bundled sound. Server side that
 * needs exactly two things, both checked here:
 *   - the device payload carries the widget's LIVE config (chime, chime_volume): switching the
 *     chime on after publishing must reach the screen without a re-publish (ws/deviceSocket.js
 *     refreshWidgetRevs);
 *   - queue.json answers the request the Roku makes (no credentials, ?device=&rev=&t=), with a
 *     call_seq that moves on every call and an {unchanged:true} for a matching rev.
 * Plus the Roku side that the brs-node vectors do not cover: the bundled WAV is the sound the
 * generator writes, and the player is wired the way the rules need (poll only while the item is on
 * screen, stop on pause, one SoundEffect, never looped).
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-qchime-roku-' + crypto.randomBytes(4).toString('hex'));
process.env.JWT_SECRET = 'test-secret-qchime-roku';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const setupDeviceSocket = require('../ws/deviceSocket');
const { buildSnapshotItems } = require('../routes/playlists');
const svc = require('../lib/queue/service');

const ROKU = path.join(__dirname, '..', '..', 'roku');
const O = 'o-qcr', WS = 'ws-qcr', U = 'u-qcr', PL = 'pl-qcr', W = 'w-qcr', D = 'd-qcr';
let server, base, build, queue;
const tokenOf = () => generateToken(db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(U), WS);
const queueItem = () => build(D).assignments.find((a) => a.widget_id === W);

before(async () => {
  setupDeviceSocket(new Server(http.createServer()));
  build = setupDeviceSocket.buildPlaylistPayloadUnchecked;
  db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, 'qcr@t.local', 'x', 'user')").run(U);
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(O, 'Org', U);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(WS, O, 'WS');
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')").run(WS, U);
  queue = svc.create(db, { workspaceId: WS, name: 'Pharmacy', timezone: 'UTC', userId: U });
  // Published with the chime OFF: the snapshot every later edit would be stuck behind.
  db.prepare("INSERT INTO widgets (id, user_id, workspace_id, widget_type, name, config, updated_at) VALUES (?, ?, ?, 'queue', 'Now serving', ?, 1000)")
    .run(W, U, WS, JSON.stringify({ queue_id: queue.id, chime: false }));
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name, status) VALUES (?, ?, ?, 'P', 'draft')").run(PL, U, WS);
  db.prepare('INSERT INTO playlist_items (playlist_id, content_id, widget_id, sort_order, duration_sec) VALUES (?, NULL, ?, 0, 30)').run(PL, W);
  db.prepare("UPDATE playlists SET status = 'published', published_snapshot = ? WHERE id = ?").run(JSON.stringify(buildSnapshotItems(PL)), PL);
  db.prepare("INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, playlist_id, playlist_source, client_type) VALUES (?, ?, ?, 'Roku', 'QCR001', ?, 'device', 'roku')").run(D, U, WS, PL);

  const app = express();
  app.use(express.json());
  app.set('io', null);
  // As server.js: queue.json skips auth, everything else needs it.
  app.get('/api/widgets/:id/queue.json', (req, res, next) => { req._skipAuth = true; next(); });
  app.use('/api/widgets', (req, res, next) => (req._skipAuth ? next() : requireAuth(req, res, () => resolveTenancy(req, res, next))), require('../routes/widgets'));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { try { server.close(); } catch { /* */ } });

test('the payload item tells a Roku it is a queue widget, with its config', () => {
  const it = queueItem();
  assert.ok(it, 'the queue widget is in the payload');
  assert.equal(it.widget_type, 'queue');
  const cfg = JSON.parse(it.widget_config);
  assert.equal(cfg.queue_id, queue.id);
  assert.equal(cfg.chime, false);
});

test('switching the chime on after publishing reaches the payload without a re-publish', async () => {
  const r = await fetch(`${base}/api/widgets/${W}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${tokenOf()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: { queue_id: queue.id, chime: true, chime_volume: 35 } }),
  });
  assert.equal(r.status, 200, await r.text());
  const cfg = JSON.parse(queueItem().widget_config);
  assert.equal(cfg.chime, true);
  assert.equal(cfg.chime_volume, 35);
  assert.ok(String(db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(PL).published_snapshot).includes('"chime\\":false'),
    'the snapshot itself is untouched; the payload reads the live config');
});

test('only a queue widget gets the live config (other widgets keep the published one)', () => {
  const a = { widget_id: 'w-other', widget_type: 'clock', widget_config: '{"published":true}' };
  db.prepare("INSERT INTO widgets (id, user_id, workspace_id, widget_type, name, config) VALUES ('w-other', ?, ?, 'clock', 'C', '{\"live\":true}')").run(U, WS);
  setupDeviceSocket.__refreshWidgetRevs([a], D);
  assert.equal(a.widget_config, '{"published":true}');
});

test('queue.json answers the request a Roku makes: no credentials, ?device=&rev=&t=', async () => {
  const q = (rev) => fetch(`${base}/api/widgets/${W}/queue.json?device=${D}${rev ? '&rev=' + encodeURIComponent(rev) : ''}&t=${Date.now()}`,
    { headers: { Accept: 'application/json', 'X-ST-Client': 'roku' } }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const a = await q();
  assert.equal(a.status, 200);
  assert.equal(typeof a.body.call_seq, 'number');
  assert.equal(a.body.sound, true);
  const same = await q(a.body.rev);
  assert.deepEqual(same.body, { rev: a.body.rev, unchanged: true });
  db.prepare('UPDATE queues SET last_issued = 9 WHERE id = ?').run(queue.id);   // nine customers took a number
  svc.call(db, queue, 4, { source: 'test' });
  const b = await q(a.body.rev);
  assert.equal(b.body.call_seq, a.body.call_seq + 1, 'a call moves call_seq by one');
  assert.equal(b.body.now_serving, 4);
  svc.call(db, queue, 4, { source: 'test' });
  const c = await q(b.body.rev);
  assert.equal(c.body.call_seq, b.body.call_seq + 1, 'calling the same number again still moves it');
});

// ------------------------------------------------------------------ the Roku package

test('the bundled WAV is the generator\'s two-tone chime: 0.9 s, mono 16-bit PCM, never louder than 0.5', () => {
  const gen = require(path.join(ROKU, 'tools/make-queue-chime.js'));
  const file = fs.readFileSync(path.join(ROKU, 'sounds/queue-chime.wav'));
  assert.equal(file.toString('ascii', 0, 4), 'RIFF');
  assert.equal(file.toString('ascii', 8, 12), 'WAVE');
  assert.equal(file.readUInt16LE(20), 1, 'PCM');
  assert.equal(file.readUInt16LE(22), 1, 'mono');
  const rate = file.readUInt32LE(24);
  assert.equal(file.readUInt16LE(34), 16);
  const n = file.readUInt32LE(40) / 2;
  assert.ok(Math.abs(n / rate - 0.9) < 0.001, `duration ${n / rate}`);
  // Same samples as the script writes (within one step, in case a JS engine rounds sin() differently).
  const want = gen.build();
  assert.equal(want.length, file.length);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = file.readInt16LE(44 + i * 2);
    assert.ok(Math.abs(v - want.readInt16LE(44 + i * 2)) <= 1, `sample ${i} differs from the generator`);
    peak = Math.max(peak, Math.abs(v) / 32767);
  }
  assert.ok(peak > 0.49 && peak <= 0.5001, `peak ${peak}`);
  // Silent between the tones (0.35 .. 0.38 s) and at the end.
  for (const t of [0.36, 0.37, 0.895]) assert.ok(Math.abs(file.readInt16LE(44 + Math.floor(t * rate) * 2)) <= 4, `not silent at ${t}s`);
  // The first tone's 880 Hz and the second's 660 Hz: zero crossings per second.
  const freq = (from, to) => {
    let z = 0;
    for (let i = Math.floor(from * rate); i < Math.floor(to * rate); i++) {
      if ((file.readInt16LE(44 + i * 2) >= 0) !== (file.readInt16LE(44 + (i + 1) * 2) >= 0)) z++;
    }
    return z / 2 / (to - from);
  };
  assert.ok(Math.abs(freq(0.05, 0.3) - 880) < 10, `first tone ${freq(0.05, 0.3)} Hz`);
  assert.ok(Math.abs(freq(0.43, 0.8) - 660) < 10, `second tone ${freq(0.43, 0.8)} Hz`);
});

test('the WAV is packaged, played by one SoundEffect, and nothing loops it', () => {
  const bs = JSON.parse(fs.readFileSync(path.join(ROKU, 'bsconfig.json'), 'utf8'));
  assert.ok(bs.files.includes('sounds/**/*'), 'bsconfig packages roku/sounds');
  const xml = fs.readFileSync(path.join(ROKU, 'components/MainScene.xml'), 'utf8');
  assert.match(xml, /<SoundEffect id="queueChimeSound" uri="pkg:\/sounds\/queue-chime\.wav" \/>/);
  assert.match(xml, /uri="pkg:\/source\/lib\/queuechime\.brs"/);
  const all = ['components/MainScene.brs', 'components/player/ZonePlayer.brs', 'source/lib/queuechime.brs']
    .map((f) => fs.readFileSync(path.join(ROKU, f), 'utf8')).join('\n');
  assert.doesNotMatch(all, /queueChimeSound\.loop|roAudioPlayer/, 'the chime is never looped or streamed');
});

test('ZonePlayer polls only while the queue widget is on screen, and stops on every way off it', () => {
  const src = fs.readFileSync(path.join(ROKU, 'components/player/ZonePlayer.brs'), 'utf8');
  const body = (name) => {
    const m = src.match(new RegExp(`\\nsub ${name}\\([^)]*\\)[\\s\\S]*?\\nend sub`));
    assert.ok(m, `${name} exists`);
    return m[0];
  };
  // Every path that takes an item off the screen stops the watch.
  for (const s of ['stopAll', 'playIndex', 'showIdle']) assert.match(body(s), /stopQueueWatch\(\)/, `${s} stops polling`);
  assert.match(src, /c = "pause" then[\s\S]*?stopQueueWatch\(\)[\s\S]*?else if c = "resume"/, 'pause (blackout) stops polling');
  // Started only for a server-rendered frame (a queue widget is one), never for the native clock.
  assert.match(body('playIndex'), /requestRaster\(item\)\s*\n\s*startQueueWatch\(item\)/);
  assert.equal((src.match(/startQueueWatch\(item\)/g) || []).length, 1);
  // The poll never fetches a frame.
  assert.doesNotMatch(body('pollQueue') + body('onQueueResult'), /requestRaster/);
  // 4 s, from the page's POLL_MS.
  const { POLL_MS } = require('../lib/queue/widget');
  const lib = fs.readFileSync(path.join(ROKU, 'source/lib/queuechime.brs'), 'utf8');
  assert.match(lib, new RegExp(`ST_QueueChimePollSec\\(\\) as integer\\s*\\n\\s*return ${POLL_MS / 1000}\\b`));
  const zxml = fs.readFileSync(path.join(ROKU, 'components/player/ZonePlayer.xml'), 'utf8');
  assert.match(zxml, /<Timer id="queuePoll" repeat="true" duration="4" \/>/);
  // The poll runs in its own Task, not behind a 40 s raster render.
  const txml = fs.readFileSync(path.join(ROKU, 'components/tasks/QueueTask.xml'), 'utf8');
  assert.match(txml, /<component name="QueueTask" extends="Task">/);
});
