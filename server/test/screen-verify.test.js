'use strict';

/*
 * Screen verification end to end (lib/screen-verify, routes/screen-verification.js), against a
 * real database and real decoded frames:
 *
 *   - a blank screen is CONFIRMED only after it persists, then alerts once per channel and resolves
 *   - a channel in another workspace, an unsubscribed channel and a check the workspace does not
 *     alert on never hear about it
 *   - "unexpected content" from a real sign against another sign's thumbnail, via play_start
 *   - panel off from the player's own display events; a reconnect forgets it; a scheduled sleep
 *     is never an incident
 *   - the verification screenshot cadence, the capability gate and the per-tick fairness
 *   - tenancy on every read; viewers read-only; settings admin-only; a moved screen takes nothing
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-sverify-' + crypto.randomBytes(4).toString('hex'));
process.env.JWT_SECRET = 'test-secret-sverify';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Jimp } = require('jimp');
const { db } = require('../db/database');
const config = require('../config');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const core = require('../lib/image-ops-core');
const ch = require('../lib/alert-channels');
const nowPlaying = require('../lib/now-playing');
const sv = require('../lib/screen-verify');

const FX = path.join(__dirname, 'fixtures', 'screen-verify');
const O = 'o-sv', WA = 'ws-sv-a', WB = 'ws-sv-b';
const ADMIN = 'u-sv-admin', EDITOR = 'u-sv-ed', VIEWER = 'u-sv-view', OTHER = 'u-sv-other';
const PD_KEY = 'R0abcdefghijklmnopqrstuvwxyz1234';
const T0 = 1_900_000_000;   // seconds

let sent = [];
let server, base;

async function jpegOf(img) { return img.getBuffer('image/jpeg', { quality: 40 }); }
const solid = (color) => new Jimp({ width: 960, height: 540, color });
async function signFrame(file) {
  const src = await Jimp.read(path.join(FX, file));
  src.contain({ w: 960, h: 540 });
  const bg = solid(0x000000ff);
  bg.composite(src, 0, 0);
  return jpegOf(bg);
}
let BLACK, SALE, HOURS;

function mkDevice(id, ws, { status = 'online', capabilities = null, name = id } = {}) {
  db.prepare('INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, status, last_heartbeat, capabilities) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, ADMIN, ws, name, crypto.randomUUID().slice(0, 6), status, T0, capabilities);
  return db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
}
function mkChannel(id, ws, events, kind = 'pagerduty') {
  db.prepare('INSERT INTO alert_channels (id, workspace_id, kind, name, config, events) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, ws, kind, id, JSON.stringify(kind === 'pagerduty' ? { routing_key: PD_KEY } : { url: 'https://hooks.example.org/x' }), JSON.stringify(events));
  ch.setScopes(db, id, [{ scope_kind: 'workspace', scope_id: ws }]);
}
const settingsA = () => sv.settingsFor(WA);
const at = (sec) => (T0 + sec) * 1000;
const stateOf = (id) => db.prepare('SELECT * FROM screen_verification_state WHERE device_id = ?').get(id);
const incidentsOf = (id) => db.prepare('SELECT * FROM screen_verification_incidents WHERE device_id = ? ORDER BY id').all(id);

const tokenOf = (u, ws = WA) => generateToken(db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(u), ws);
async function call(method, p, who, body, ws = WA) {
  const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${tokenOf(who, ws)}`, 'Content-Type': 'application/json', 'X-Workspace-Id': ws }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch { /* */ }
  return { status: r.status, body: json };
}

before(async () => {
  db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, 'sva@t.local', 'x', 'user'), (?, 'sve@t.local', 'x', 'user'), (?, 'svv@t.local', 'x', 'user'), (?, 'svo@t.local', 'x', 'user')")
    .run(ADMIN, EDITOR, VIEWER, OTHER);
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(O, 'Org', ADMIN);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?), (?, ?, ?)').run(WA, O, 'Store A', WB, O, 'Store B');
  db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin'), (?, ?, 'workspace_editor'),
    (?, ?, 'workspace_viewer'), (?, ?, 'workspace_admin')`).run(WA, ADMIN, WA, EDITOR, WA, VIEWER, WB, OTHER);
  BLACK = await jpegOf(solid(0x000000ff));
  SALE = await signFrame('sale.jpg');
  HOURS = await signFrame('hours.jpg');
  // The real decoder, inline: the worker itself is covered in screen-verify-classify.test.js.
  sv._setImageOps({ frameMetrics: (src) => core.frameMetrics(src), pending: () => 0 });
  ch._setSender(async (msg) => { sent.push(msg); return { ok: true }; });
  const app = express();
  app.use(express.json());
  app.use('/api/screen-verification', requireAuth, resolveTenancy, require('../routes/screen-verification'));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { ch._setSender(null); sv._setImageOps(null); sv.setRequester(null); try { server.close(); } catch { /* */ } });

/* ------------------------------------------------------------------ blank: debounce, alert, resolve */

test('a blank screen is confirmed only after it persists, alerts once, and resolves on recovery', async () => {
  const d = mkDevice('d-blank', WA, { name: 'Lobby' });
  mkDevice('d-b-other', WB);
  mkChannel('c-pd', WA, ['screen_problem', 'screen_ok']);
  mkChannel('c-offline-only', WA, ['device_offline', 'device_online'], 'webhook');
  mkChannel('c-other-ws', WB, ['screen_problem', 'screen_ok'], 'webhook');
  sent = [];

  await sv.analyse(d, BLACK, settingsA(), at(0));
  let s = stateOf(d.id);
  assert.notEqual(s.state, 'blank', 'one bad frame is not an incident');
  assert.equal(incidentsOf(d.id).length, 1);
  assert.equal(incidentsOf(d.id)[0].confirmed_at, null);
  await sv.tick({ db, now: T0 + 30, localRowsSql: () => '1=1' });
  assert.equal(sent.length, 0, 'nothing is sent for a suspicion');

  await sv.analyse(d, BLACK, settingsA(), at(330));
  assert.notEqual(stateOf(d.id).state, 'blank', 'still inside the 10-minute window');
  await sv.analyse(d, BLACK, settingsA(), at(660));
  s = stateOf(d.id);
  assert.equal(s.state, 'blank');
  assert.equal(s.state_since, T0, 'since the first bad frame');
  assert.equal(JSON.parse(s.detail).kind, 'black');

  await sv.tick({ db, now: T0 + 700, localRowsSql: () => '1=1' });
  assert.equal(sent.length, 1, 'exactly one channel hears: the subscribed one in this workspace');
  assert.equal(sent[0].body.event_action, 'trigger');
  assert.match(sent[0].body.payload.summary, /Blank screen: Lobby/);
  assert.equal(sent[0].body.payload.severity, 'warning');
  const key = sent[0].body.dedup_key;
  await sv.tick({ db, now: T0 + 760, localRowsSql: () => '1=1' });
  assert.equal(sent.length, 1, 'once per incident');

  await sv.analyse(d, SALE, settingsA(), at(800));
  assert.equal(stateOf(d.id).state, 'blank', 'one good frame is a flap, not a fix');
  await sv.analyse(d, SALE, settingsA(), at(860));
  assert.equal(stateOf(d.id).state, 'verified');
  assert.equal(incidentsOf(d.id)[0].resolved_reason, 'recovered');

  await sv.tick({ db, now: T0 + 900, localRowsSql: () => '1=1' });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].body, { routing_key: PD_KEY, event_action: 'resolve', dedup_key: key }, 'the same key resolves it');
  await sv.tick({ db, now: T0 + 960, localRowsSql: () => '1=1' });
  assert.equal(sent.length, 2, 'the resolve goes once');
});

test('message shapes: Slack warns, a webhook names the check, "offline" explains the pause', () => {
  const base = { device: { id: 'd1', name: 'Lobby' }, minutes: 12, workspace: { name: 'Store A' }, dashboardUrl: 'https://st.example', dedupKey: 'k', nowIso: '2026-10-14T12:00:00.000Z' };
  const slack = ch.buildMessage({ kind: 'slack', config: JSON.stringify({ url: 'https://hooks.slack.com/services/x' }) }, { ...base, event: 'screen_problem', check: 'frozen' });
  assert.match(slack.body.text, /^:large_yellow_circle: Frozen screen: Lobby/);
  const wh = ch.buildMessage({ kind: 'webhook', config: JSON.stringify({ url: 'https://hooks.example.org/a' }) }, { ...base, event: 'screen_problem', check: 'blank' });
  assert.equal(wh.body.event, 'screen_problem');
  assert.equal(wh.body.check, 'blank');
  const paused = ch.buildMessage({ kind: 'email', config: JSON.stringify({ emails: ['a@b.co'] }) }, { ...base, event: 'screen_ok', check: 'blank', reason: 'offline' });
  assert.match(paused.subject, /Verification paused: Lobby/);
  // Existing events are untouched by the new ones.
  const off = ch.buildMessage({ kind: 'pagerduty', config: JSON.stringify({ routing_key: PD_KEY }) }, { ...base, event: 'device_offline' });
  assert.equal(off.body.payload.severity, 'error');
  assert.deepEqual(ch.normaliseInput({ kind: 'email', name: 'x', emails: 'a@b.co', events: ['screen_problem', 'bogus'] }).fields.events, '["screen_problem"]');
});

test('a check the workspace does not alert on is shown but never sent', async () => {
  db.prepare("INSERT INTO screen_verification_settings (workspace_id, alert_checks) VALUES (?, '[\"frozen\"]')").run(WA);
  sv.invalidateSettings(WA);
  try {
    const d = mkDevice('d-quiet', WA);
    sent = [];
    for (const t of [0, 330, 660]) await sv.analyse(d, BLACK, settingsA(), at(t));
    assert.equal(stateOf(d.id).state, 'blank');
    await sv.tick({ db, now: T0 + 700, localRowsSql: () => '1=1' });
    assert.equal(sent.length, 0);
  } finally {
    db.prepare('DELETE FROM screen_verification_settings WHERE workspace_id = ?').run(WA);
    sv.invalidateSettings(WA);
  }
});

test('going offline closes the incident (offline alerts take over) and tells the channel', async () => {
  const d = mkDevice('d-gone', WA);
  sent = [];
  for (const t of [0, 330, 660]) await sv.analyse(d, BLACK, settingsA(), at(t));
  await sv.tick({ db, now: T0 + 700, localRowsSql: () => '1=1' });
  const before = sent.length;
  assert.ok(before >= 1);
  db.prepare("UPDATE devices SET status = 'offline' WHERE id = ?").run(d.id);
  sv.noteOffline(d.id);
  assert.equal(incidentsOf(d.id)[0].resolved_reason, 'offline');
  assert.equal(stateOf(d.id).state, 'unknown');
  await sv.tick({ db, now: T0 + 800, localRowsSql: () => '1=1' });
  assert.equal(sent.length, before + 1, 'PagerDuty is resolved rather than left hanging');
});

test('a screen marked offline by the heartbeat sweep (not the socket) also has its incident closed', async () => {
  const d = mkDevice('d-swept', WA);
  for (const t of [0, 330, 660]) await sv.analyse(d, BLACK, settingsA(), at(t));
  assert.equal(stateOf(d.id).state, 'blank');
  db.prepare("UPDATE devices SET status = 'offline' WHERE id = ?").run(d.id);
  await sv.tick({ db, now: T0 + 700, localRowsSql: () => '1=1' });
  assert.equal(incidentsOf(d.id)[0].resolved_reason, 'offline');
  assert.equal(stateOf(d.id).open_incident_id, null);
});

/* ------------------------------------------------------------------ unexpected */

test('unexpected content: the screen shows a different sign from the one it says it is playing', async () => {
  const d = mkDevice('d-unexp', WA);
  // A content row whose thumbnail is the SALE sign, on local disk where uploads live.
  fs.mkdirSync(config.contentDir, { recursive: true });
  const thumbName = `sv-thumb-${crypto.randomBytes(3).toString('hex')}.jpg`;
  const t = await Jimp.read(path.join(FX, 'sale.jpg'));
  t.resize({ w: 320 });
  fs.writeFileSync(path.join(config.contentDir, thumbName), await t.getBuffer('image/jpeg', { quality: 70 }));
  db.prepare("INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, thumbnail_path) VALUES ('ct-sale', ?, ?, 'sale.jpg', 'missing.jpg', 'image/jpeg', 1, ?)")
    .run(ADMIN, WA, thumbName);

  nowPlaying.noteStart(d.id, { content_id: 'ct-sale' }, at(0) - 5000);
  sv.notePlayStart(d.id, { content_id: 'ct-sale' }, at(0) - 5000);
  const r = await sv.analyse(d, HOURS, settingsA(), at(0));
  assert.equal(r.verdict, 'unexpected');
  assert.equal(incidentsOf(d.id)[0].kind, 'unexpected');

  // The right sign: fine, and the suspicion is dropped.
  nowPlaying.noteStart(d.id, { content_id: 'ct-sale' }, at(60) - 5000);
  const ok = await sv.analyse(d, SALE, settingsA(), at(60));
  assert.equal(ok.verdict, 'ok');
  assert.equal(incidentsOf(d.id).length, 0, 'an unconfirmed suspicion leaves no history');

  // Another workspace's content id reported by the player is never used as a reference.
  db.prepare("INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, thumbnail_path) VALUES ('ct-foreign', ?, ?, 'f.jpg', 'f.jpg', 'image/jpeg', 1, ?)")
    .run(OTHER, WB, thumbName);
  const d2 = mkDevice('d-unexp2', WA);
  nowPlaying.noteStart(d2.id, { content_id: 'ct-foreign' }, at(0) - 5000);
  assert.equal((await sv.analyse(d2, HOURS, settingsA(), at(0))).verdict, 'ok');
});

/* ------------------------------------------------------------------ panel */

test('panel off from the player\'s own display event: confirmed after it persists; a reconnect forgets it', async () => {
  const d = mkDevice('d-panel', WA);
  sv.noteDisplayEvent(d.id, 'display_off', null, T0);
  await sv.tick({ db, now: T0 + 60, localRowsSql: () => '1=1' });
  assert.notEqual(stateOf(d.id).state, 'panel_off');
  await sv.tick({ db, now: T0 + 660, localRowsSql: () => '1=1' });
  assert.equal(stateOf(d.id).state, 'panel_off');
  // A black frame while the panel is off does not replace the panel_off incident.
  await sv.analyse(d, BLACK, settingsA(), at(700));
  assert.equal(stateOf(d.id).state, 'panel_off');

  sv.noteDisplayEvent(d.id, 'display_on', null, T0 + 720);
  await sv.tick({ db, now: T0 + 780, localRowsSql: () => '1=1' });
  await sv.tick({ db, now: T0 + 840, localRowsSql: () => '1=1' });
  assert.notEqual(stateOf(d.id).state, 'panel_off');

  // A display_off from before a reconnect is not believed afterwards.
  const d2 = mkDevice('d-panel2', WA);
  sv.noteDisplayEvent(d2.id, 'display_off', null, T0);
  sv.noteReconnect(d2.id);
  await sv.tick({ db, now: T0 + 60, localRowsSql: () => '1=1' });
  await sv.tick({ db, now: T0 + 700, localRowsSql: () => '1=1' });
  assert.ok(!stateOf(d2.id) || stateOf(d2.id).state !== 'panel_off');
});

test('panel reports are whitelisted: an unknown power value or markup in the input name is dropped', () => {
  const d = mkDevice('d-report', WA);
  sv.notePanelReport(d.id, { power: 'exploded', input: '<img src=x onerror=alert(1)>HDMI1', source: 'telnet' });
  const s = stateOf(d.id);
  assert.equal(s.panel_power, null);
  assert.equal(s.panel_source, null);
  assert.doesNotMatch(s.panel_input, /[<>=()]/);
  sv.notePanelReport(d.id, { power: 'standby', input: 'HDMI 2', source: 'cec' });
  assert.equal(stateOf(d.id).panel_power, 'standby');
  const shown = sv.presentState(d, stateOf(d.id), settingsA());
  assert.equal(shown.panel.reporting, true);
  assert.equal(shown.panel.source, 'cec');
});

test('a scheduled power-off is shown as panel off (scheduled) and never raises an incident', async () => {
  const d = mkDevice('d-sleep', WA);
  const windows = JSON.stringify([{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' }]);
  db.prepare("INSERT INTO display_power_schedules (id, workspace_id, name, device_id, enabled, timezone, windows) VALUES ('ps-sv', ?, 'Night', ?, 1, 'UTC', ?)").run(WA, d.id, windows);
  for (const t of [0, 330, 660, 990]) await sv.analyse(d, BLACK, settingsA(), at(t));
  sv.noteDisplayEvent(d.id, 'display_off', 'schedule', T0);
  await sv.tick({ db, now: T0 + 1000, localRowsSql: () => '1=1' });
  const s = stateOf(d.id);
  assert.equal(s.state, 'panel_off');
  assert.equal(JSON.parse(s.detail).scheduled, true);
  assert.equal(incidentsOf(d.id).length, 0);
});

/* ------------------------------------------------------------------ frozen, end to end */

test('frozen: a two-item loop whose picture never changes, watched by a dashboard every 30s', async () => {
  const d = mkDevice('d-frozen', WA);
  db.prepare("INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size) VALUES ('ct-f1', ?, ?, 'a.jpg', 'a.jpg', 'image/jpeg', 1), ('ct-f2', ?, ?, 'b.jpg', 'b.jpg', 'image/jpeg', 1)")
    .run(ADMIN, WA, ADMIN, WA);
  db.prepare("INSERT INTO playlists (id, user_id, name, workspace_id) VALUES ('pl-frozen', ?, 'Loop', ?)").run(ADMIN, WA);
  db.prepare("INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES ('pl-frozen', 'ct-f1', 0, 10), ('pl-frozen', 'ct-f2', 1, 10)").run();
  db.prepare("UPDATE devices SET playlist_id = 'pl-frozen' WHERE id = ?").run(d.id);
  // The player started item 1 once and never reported anything again.
  nowPlaying.noteStart(d.id, { content_id: 'ct-f1' }, at(0) - 2000);
  sv.notePlayStart(d.id, { content_id: 'ct-f1' }, at(0) - 2000);
  // 16 minutes of identical frames, every 30 seconds — what an open dashboard produces.
  for (let t = 0; t <= 16 * 60; t += 30) await sv.analyse(d, SALE, settingsA(), at(t));
  const s = stateOf(d.id);
  assert.equal(s.state, 'frozen');
  assert.equal(JSON.parse(s.detail).reason, 'not_advancing');
  assert.ok(sv._mem(d.id).history.length <= 12, 'history stays bounded');

  // The same loop on a screen whose picture DOES change is fine.
  const d2 = mkDevice('d-moving', WA);
  db.prepare("UPDATE devices SET playlist_id = 'pl-frozen' WHERE id = ?").run(d2.id);
  nowPlaying.noteStart(d2.id, { content_id: 'ct-f1' }, at(0) - 2000);
  for (let t = 0, i = 0; t <= 16 * 60; t += 30, i++) await sv.analyse(d2, i % 2 ? SALE : HOURS, settingsA(), at(t));
  assert.equal(stateOf(d2.id).state, 'verified');
});

/* ------------------------------------------------------------------ verification screenshots */

test('verification screenshots: on cadence, never to a screen that cannot capture, never when switched off', async () => {
  const asked = [];
  sv.setRequester((id) => { asked.push(id); return true; });
  try {
    const due = mkDevice('d-due', WA);
    const noCap = mkDevice('d-nocap', WA, { capabilities: '[]' });
    mkDevice('d-ws-b', WB);
    const now = Math.floor(Date.now() / 1000) + 7200;
    await sv.tick({ db, now, localRowsSql: () => '1=1' });
    assert.ok(asked.includes(due.id), 'a screen never checked is due');
    assert.ok(!asked.includes(noCap.id), 'no remote.screenshot, no request');
    assert.ok(asked.includes('d-ws-b'), 'defaults apply to a workspace with no settings row');
    asked.length = 0;
    await sv.tick({ db, now: now + 10, localRowsSql: () => '1=1' });
    assert.ok(!asked.includes(due.id), 'not asked twice in a row');

    db.prepare('INSERT INTO screen_verification_settings (workspace_id, enabled) VALUES (?, 0)').run(WB);
    sv.invalidateSettings(WB);
    asked.length = 0;
    await sv.tick({ db, now: now + 4000, localRowsSql: () => '1=1' });
    assert.ok(!asked.includes('d-ws-b'), 'verification switched off: nothing is asked');
    assert.equal(sv.noteFrame('d-ws-b', BLACK.toString('base64')), false, 'and frames are not judged');
  } finally {
    sv.setRequester(null);
    db.prepare('DELETE FROM screen_verification_settings WHERE workspace_id = ?').run(WB);
    sv.invalidateSettings(WB);
  }
});

test('noteFrame is throttled per screen, so the 1fps remote stream does not become 1 analysis a second', () => {
  const d = mkDevice('d-stream', WA);
  const b64 = BLACK.toString('base64');
  const t = Date.now();
  assert.equal(sv.noteFrame(d.id, b64, t), true);
  sv._mem(d.id).inflight = false;
  assert.equal(sv.noteFrame(d.id, b64, t + 1000), false);
  assert.equal(sv.noteFrame(d.id, b64, t + 30 * 1000), false);
  assert.equal(sv.noteFrame(d.id, b64, t + 46 * 1000), true);
});

/* ------------------------------------------------------------------ routes: tenancy and roles */

test('states and incidents are scoped to the workspace; another workspace\'s screen is a 404', async () => {
  const r = await call('GET', '/api/screen-verification/states', VIEWER);
  assert.equal(r.status, 200);
  const ids = r.body.states.map((s) => s.device_id);
  assert.ok(ids.includes('d-blank'));
  assert.ok(!ids.includes('d-b-other'), 'workspace B\'s screen is not listed');
  assert.equal(r.body.states.find((s) => s.device_id === 'd-blank').state, 'verified');

  assert.equal((await call('GET', '/api/screen-verification/devices/d-b-other', VIEWER)).status, 404);
  const one = await call('GET', '/api/screen-verification/devices/d-blank', VIEWER);
  assert.equal(one.status, 200);
  assert.equal(one.body.incidents[0].kind, 'blank');

  const inc = await call('GET', '/api/screen-verification/incidents', VIEWER);
  assert.ok(inc.body.length >= 1);
  assert.ok(inc.body.every((i) => i.device_id !== 'd-b-other'));

  // A member of B only, naming A in the header, is resolved to their own workspace (tenancy falls
  // back to one they can reach) — so they get B's screens and never A's.
  const named = await call('GET', '/api/screen-verification/states', OTHER, null, WA);
  assert.ok(named.body.states.every((s) => s.device_id !== 'd-blank'));
  const theirs = await call('GET', '/api/screen-verification/states', OTHER, null, WB);
  assert.ok(theirs.body.states.every((s) => s.device_id !== 'd-blank'));
});

test('settings: anyone reads; a viewer and an editor cannot change them; an admin can, validated and audited', async () => {
  const read = await call('GET', '/api/screen-verification/settings', VIEWER);
  assert.equal(read.status, 200);
  assert.equal(read.body.enabled, true);
  assert.equal(read.body.channels.subscribed, 1);

  assert.equal((await call('PUT', '/api/screen-verification/settings', VIEWER, { enabled: false })).status, 403);
  assert.equal((await call('PUT', '/api/screen-verification/settings', EDITOR, { enabled: false })).status, 403);
  assert.equal((await call('PUT', '/api/screen-verification/settings', ADMIN, { cadence_minutes: 1 })).status, 400);
  assert.equal((await call('PUT', '/api/screen-verification/settings', ADMIN, { alert_checks: ['nope'] })).status, 400);

  const ok = await call('PUT', '/api/screen-verification/settings', ADMIN, { cadence_minutes: 60, sensitivity: 'low', alert_checks: ['blank', 'unexpected'] });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.cadence_minutes, 60);
  assert.equal(sv.settingsFor(WA).sensitivity, 'low', 'the cache is refreshed at once');
  assert.ok(db.prepare("SELECT 1 FROM activity_log WHERE action = 'screen_verification.settings' AND workspace_id = ?").get(WA));
  // B's admin naming A changes B (their own), never A.
  await call('PUT', '/api/screen-verification/settings', OTHER, { enabled: false }, WA);
  assert.equal(sv.settingsFor(WA).enabled, true);
  db.prepare('DELETE FROM screen_verification_settings WHERE workspace_id = ?').run(WB);
  sv.invalidateSettings(WB);
  await call('PUT', '/api/screen-verification/settings', ADMIN, { cadence_minutes: 30, sensitivity: 'normal', alert_checks: ['blank', 'frozen', 'panel_off'] });
});

test('check now: a viewer cannot; an editor can; a screen elsewhere is a 404', async () => {
  sv.setRequester(() => true);
  try {
    assert.equal((await call('POST', '/api/screen-verification/devices/d-blank/check', VIEWER)).status, 403);
    assert.equal((await call('POST', '/api/screen-verification/devices/d-b-other/check', EDITOR)).status, 404);
    assert.equal((await call('POST', '/api/screen-verification/devices/d-blank/check', EDITOR)).status, 200);
    assert.equal((await call('POST', '/api/screen-verification/devices/d-blank/check', EDITOR)).status, 429, 'not hammered');
    assert.equal((await call('POST', '/api/screen-verification/devices/d-nocap/check', EDITOR)).status, 409);
  } finally { sv.setRequester(null); }
});

test('a screen moved to another workspace takes none of its verification history along', async () => {
  db.prepare('UPDATE devices SET workspace_id = ? WHERE id = ?').run(WB, 'd-blank');
  try {
    const theirs = await call('GET', '/api/screen-verification/incidents', OTHER, null, WB);
    assert.ok(theirs.body.every((i) => i.device_id !== 'd-blank'), 'the new workspace does not see the old incidents');
    const mine = await call('GET', '/api/screen-verification/incidents', ADMIN);
    assert.ok(mine.body.every((i) => i.device_id !== 'd-blank'), 'nor does the old one, now it is not theirs');
    const st = await call('GET', '/api/screen-verification/devices/d-blank', OTHER, null, WB);
    assert.equal(st.body.state, 'unknown', 'the old state row is not shown to the new workspace');
  } finally {
    db.prepare('UPDATE devices SET workspace_id = ? WHERE id = ?').run(WA, 'd-blank');
  }
});

test('a channel that answers 429 gets no more screen problems this pass; they go out on the next tick', async () => {
  db.prepare('INSERT INTO alert_channels (id, workspace_id, kind, name, config, events) VALUES (?, ?, ?, ?, ?, ?)')
    .run('c-sv-tg', WB, 'telegram', 'tg', JSON.stringify({ bot_token: `123456789:${['FAKE', 'test', 'token', 'not', 'a', 'real', 'bot', 'x0'].join('_')}`, chat_id: '-4242' }), '["screen_problem","screen_ok"]');
  ch.setScopes(db, 'c-sv-tg', [{ scope_kind: 'workspace', scope_id: WB }]);
  const devs = ['d-rl-1', 'd-rl-2', 'd-rl-3'].map((id) => mkDevice(id, WB));
  for (const d of devs) for (const t of [0, 330, 660]) await sv.analyse(d, BLACK, sv.settingsFor(WB), at(t));
  const calls = [];
  ch._setSender(async (msg) => {
    if (msg.service !== 'telegram') return { ok: true };
    calls.push(msg);
    return calls.length === 1 ? { ok: false, rateLimited: true, error: 'Telegram is limiting this bot (HTTP 429).' } : { ok: true };
  });
  try {
    await sv.tick({ db, now: T0 + 700, localRowsSql: () => '1=1' });
    assert.equal(calls.length, 1, 'the rest were not spent against the limit');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM screen_verification_deliveries WHERE channel_id = 'c-sv-tg'").get().n, 1);
    await sv.tick({ db, now: T0 + 760, localRowsSql: () => '1=1' });
    assert.equal(calls.length, 4);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM screen_verification_deliveries WHERE channel_id = 'c-sv-tg' AND problem_sent_at IS NOT NULL").get().n, 3);
  } finally {
    ch._setSender(async (msg) => { sent.push(msg); return { ok: true }; });
    db.prepare("DELETE FROM alert_channels WHERE id = 'c-sv-tg'").run();
  }
});
