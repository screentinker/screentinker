'use strict';

/*
 * Automation hooks + Zapier, end to end against a real server.
 *
 * What has to hold:
 *   - a hook URL's secret is shown once and stored only hashed; an unknown hook, a wrong secret and
 *     a disabled hook are the same 404
 *   - with a signing secret, an unsigned or wrongly signed call is refused; a signed one runs
 *   - each hook is rate-limited on its own
 *   - an emergency hook raises an alert once however often it is sent, and clears it once
 *   - a mass-notification hook does the same for CAP 1.2 XML (Alert, then Cancel by reference) and
 *     for Alertus / InformaCast-style JSON, keyed on the sender's alert id
 *   - a data hook writes a Table data source; a playlist hook switches screens and stops; a trigger
 *     hook counts what it could and could not reach
 *   - Zapier endpoints follow token scopes: read can subscribe and poll, but not take over screens
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { freePort } = require('./helpers/free-port');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc, BASE, DATA_DIR, LOG;
let ADMIN;

const dbh = () => new (require('better-sqlite3'))(path.join(DATA_DIR, 'db', 'remote_display.db'));
const q = (sql, ...a) => { const r = dbh(); try { return r.prepare(sql).all(...a); } finally { r.close(); } };
const q1 = (sql, ...a) => q(sql, ...a)[0];
const run = (sql, ...a) => { const r = dbh(); try { return r.prepare(sql).run(...a); } finally { r.close(); } };

async function api(p, opts = {}) {
  const r = await fetch(BASE + p, opts);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}
const J = (body, method = 'POST', token = ADMIN.token) => ({
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const post = (url, body, headers = {}) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': typeof body === 'string' && body.trimStart().startsWith('<') ? 'application/xml' : 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

async function mkHook(body) {
  const r = await api('/api/automation', J(body));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
const events = (type) => q('SELECT * FROM automation_events WHERE type = ? ORDER BY id', type);
const liveAlerts = (hookId) => {
  const h = q1('SELECT feed_id FROM automation_hooks WHERE id = ?', hookId);
  return h && h.feed_id ? q('SELECT * FROM cap_alerts WHERE feed_id = ? AND ended = 0', h.feed_id) : [];
};

before(async () => {
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-'));
  LOG = path.join(DATA_DIR, 'server.log');
  const logFd = fs.openSync(LOG, 'a');
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test', APP_URL: BASE },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot: ' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  const reg = await api('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.test', password: 'Passw0rd123', name: 'Owner' }) });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  ADMIN = { token: reg.body.token, id: reg.body.user.id, ws: reg.body.current_workspace_id };
});

after(() => { if (proc) proc.kill('SIGKILL'); if (process.env.KEEP) return; try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ } });

test('a hook URL is shown once, stored hashed, and every kind of "no" is the same 404', async () => {
  const h = await mkHook({ name: 'Fire panel', kind: 'emergency', config: { scopes: [{ scope_kind: 'workspace' }] } });
  assert.match(h.url, new RegExp(`^${BASE}/api/hooks/in/${h.id}/[A-Za-z0-9_-]{43}$`));
  const secret = h.url.split('/').pop();
  const row = q1('SELECT secret_hash FROM automation_hooks WHERE id = ?', h.id);
  assert.equal(row.secret_hash, crypto.createHash('sha256').update(secret).digest('hex'));
  assert.ok(!fs.readFileSync(path.join(DATA_DIR, 'db', 'remote_display.db')).includes(Buffer.from(secret)), 'the secret is not in the database');

  const listed = await api('/api/automation', J(undefined, 'GET'));
  assert.ok(!JSON.stringify(listed.body).includes(secret), 'never listed again');

  const wrong = await post(`${BASE}/api/hooks/in/${h.id}/${'x'.repeat(43)}`, { headline: 'x' });
  const unknown = await post(`${BASE}/api/hooks/in/${crypto.randomUUID()}/${secret}`, { headline: 'x' });
  assert.equal(wrong.status, 404);
  assert.equal(unknown.status, 404);
  assert.deepEqual(wrong.body, unknown.body);
  await api(`/api/automation/${h.id}`, J({ enabled: false }, 'PUT'));
  const disabled = await post(h.url, { headline: 'x' });
  assert.equal(disabled.status, 404);
  assert.deepEqual(disabled.body, unknown.body);
  await api(`/api/automation/${h.id}`, J({ enabled: true }, 'PUT'));

  // Rotation replaces the URL; the old one stops working.
  const rot = await api(`/api/automation/${h.id}/rotate`, J({}));
  assert.notEqual(rot.body.url, h.url);
  assert.equal((await post(h.url, { headline: 'x' })).status, 404);
  await api(`/api/automation/${h.id}`, J(undefined, 'DELETE'));
});

test('an emergency hook raises once and clears once, however often it is sent', async () => {
  const h = await mkHook({ name: 'Building alerts', kind: 'emergency', config: {
    op: 'auto', scopes: [{ scope_kind: 'workspace' }], headline: '{{body.alert.title}}', description: '{{body.alert.text}}',
    alert_id: '{{body.alert.id}}', clear_field: '{{body.state}}', severity: '{{body.alert.level}}', expires_min: 30,
  } });
  const raise = { state: 'active', alert: { id: 'A-1', title: 'Fire alarm <b>east wing</b>', text: 'Leave by the nearest exit.', level: 'critical' } };
  const r1 = await post(h.url, raise);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.match(r1.body.result, /raised 1/);
  const r2 = await post(h.url, raise);
  assert.match(r2.body.result, /no change/);
  const live = liveAlerts(h.id);
  assert.equal(live.length, 1);
  const a = JSON.parse(live[0].data);
  assert.equal(a.headline, 'Fire alarm <b>east wing</b>', 'stored as text; the card escapes it');
  assert.equal(a.severity, 'Extreme');
  assert.ok(Date.parse(a.expires) - Date.now() <= 30 * 60000 + 5000);
  assert.equal(events('emergency_raised').length, 1, 'one event for one alert');

  const shown = await api(`/api/automation/${h.id}`, J(undefined, 'GET'));
  assert.equal(shown.body.live_alerts, 1);
  // The hidden feed does not appear among the workspace's CAP feeds.
  const feeds = await api('/api/cap-feeds', J(undefined, 'GET'));
  assert.equal(feeds.body.length, 0);

  const c1 = await post(h.url, { state: 'cleared', alert: { id: 'A-1' } });
  assert.match(c1.body.result, /cleared 1/);
  const c2 = await post(h.url, { state: 'cleared', alert: { id: 'A-1' } });
  assert.match(c2.body.result, /no change/);
  assert.equal(liveAlerts(h.id).length, 0);
  assert.equal(events('emergency_cleared').length, 1);

  const calls = await api(`/api/automation/${h.id}/calls`, J(undefined, 'GET'));
  assert.equal(calls.body.length, 4);
  assert.ok(q1("SELECT 1 AS x FROM activity_log WHERE action = 'automation:hook_called'"), 'calls are in the activity log');
});

test('signing: unsigned and wrongly signed calls are refused, a signed one runs', async () => {
  const key = 'k'.repeat(32);
  const h = await mkHook({ name: 'Signed', kind: 'emergency', signing_secret: key, config: { scopes: [{ scope_kind: 'workspace' }] } });
  const body = JSON.stringify({ id: 'S-1', headline: 'Signed alert' });
  assert.equal((await post(h.url, body)).status, 401);
  assert.equal((await post(h.url, body, { 'X-Signature': 'sha256=' + '0'.repeat(64) })).status, 401);
  const sig = crypto.createHmac('sha256', key).update(body).digest('hex');
  const ok = await post(h.url, body, { 'X-Hub-Signature-256': `sha256=${sig}` });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  // Tampered body, same signature.
  assert.equal((await post(h.url, body.replace('Signed', 'Forged'), { 'X-Hub-Signature-256': `sha256=${sig}` })).status, 401);
  assert.equal((await api(`/api/automation/${h.id}`, J(undefined, 'GET'))).body.has_signing_secret, true);
  await api(`/api/automation/${h.id}`, J(undefined, 'DELETE'));
});

test('each hook has its own rate limit', async () => {
  const h = await mkHook({ name: 'Busy', kind: 'emergency', config: { op: 'clear', scopes: [{ scope_kind: 'workspace' }] } });
  const other = await mkHook({ name: 'Quiet', kind: 'emergency', config: { op: 'clear', scopes: [{ scope_kind: 'workspace' }] } });
  const codes = [];
  for (let i = 0; i < 31; i++) codes.push((await post(h.url, {})).status);
  assert.deepEqual(codes.slice(0, 30), Array(30).fill(200));
  assert.equal(codes[30], 429);
  assert.equal((await post(other.url, {})).status, 200, 'another hook is unaffected');
});

test('mass notification: CAP 1.2 raises once and a Cancel clears it', async () => {
  const h = await mkHook({ name: 'InformaCast', kind: 'mass_notification', config: { scopes: [{ scope_kind: 'workspace' }] } });
  const sent = new Date().toISOString();
  const cap = (msgType, id, refs = '') => `<?xml version="1.0"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>${id}</identifier><sender>informacast@acme.test</sender><sent>${sent}</sent>
<status>Actual</status><msgType>${msgType}</msgType><scope>Public</scope>${refs ? `<references>${refs}</references>` : ''}
<info><event>Lockdown</event><urgency>Immediate</urgency><severity>Extreme</severity><certainty>Observed</certainty>
<headline>Lockdown in effect</headline><description>Stay in your room.</description></info></alert>`;
  const r1 = await post(h.url, cap('Alert', 'IC-77'));
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.match(r1.body.result, /raised 1/);
  assert.match((await post(h.url, cap('Alert', 'IC-77'))).body.result, /no change/);
  assert.equal(liveAlerts(h.id).length, 1);
  const c = await post(h.url, cap('Cancel', 'IC-78', `informacast@acme.test,IC-77,${sent}`));
  assert.match(c.body.result, /cleared 1/);
  assert.equal(liveAlerts(h.id).length, 0);
  // An exercise never takes a screen.
  const ex = await post(h.url, cap('Alert', 'IC-79').replace('<status>Actual</status>', '<status>Exercise</status>'));
  assert.match(ex.body.result, /not Actual/);
  assert.equal(q('SELECT data FROM cap_alerts WHERE feed_id = (SELECT feed_id FROM automation_hooks WHERE id = ?)', h.id)
    .map((r) => JSON.parse(r.data)).filter((a) => a.status === 'Actual' && !a.ended && a.identifier === 'IC-79').length, 0);
});

test('mass notification: Alertus and InformaCast JSON, keyed on the sender id', async () => {
  const h = await mkHook({ name: 'Alertus', kind: 'mass_notification', config: { scopes: [{ scope_kind: 'workspace' }] } });
  const r1 = await post(h.url, { alertId: 'AL-5', title: 'Severe weather', message: 'Move to shelter areas.', priority: 'High', status: 'Active' });
  assert.match(r1.body.result, /raised 1/, JSON.stringify(r1.body));
  const a = JSON.parse(liveAlerts(h.id)[0].data);
  assert.equal(a.headline, 'Severe weather');
  assert.equal(a.severity, 'Severe');
  assert.match((await post(h.url, { alertId: 'AL-5', title: 'Severe weather', status: 'Active' })).body.result, /no change/);
  assert.match((await post(h.url, { alertId: 'AL-5', status: 'Cleared' })).body.result, /cleared 1/);
  assert.match((await post(h.url, { alertId: 'AL-5', status: 'Cleared' })).body.result, /no change/);

  // InformaCast-style nesting, and "active: false" as the clear.
  const r2 = await post(h.url, { data: { id: 'IC-1', subject: 'Shelter in place', body: 'Close doors and windows.' } });
  assert.match(r2.body.result, /raised 1/);
  assert.match((await post(h.url, { data: { id: 'IC-1' }, active: false })).body.result, /cleared 1/);

  // A body with nothing to show is refused with a reason, not shown blank.
  const blank = await post(h.url, { foo: 'bar' });
  assert.equal(blank.status, 422);
  assert.match(blank.body.result, /mapping/);

  // A configured mapping wins over guessing.
  const mapped = await mkHook({ name: 'Custom', kind: 'mass_notification', config: { scopes: [{ scope_kind: 'workspace' }], mapping: { id: '{{body.ref}}', headline: '{{body.what}}', clear: '{{body.phase}}' } } });
  assert.match((await post(mapped.url, { ref: 'X1', what: 'Gas leak' })).body.result, /raised 1/);
  assert.match((await post(mapped.url, { ref: 'X1', phase: 'ended' })).body.result, /cleared 1/);
});

test('a data hook writes a Table data source', async () => {
  const ds = await api('/api/data-sources', J({ name: 'Specials', type: 'table', config: { columns: ['Item', 'Price'], rows: [['Tea', '2.00']] } }));
  assert.equal(ds.status, 201, JSON.stringify(ds.body));
  const bad = await api('/api/automation', J({ name: 'x', kind: 'data', config: { data_source_id: 'nope' } }));
  assert.equal(bad.status, 400);
  const h = await mkHook({ name: 'POS prices', kind: 'data', config: { data_source_id: ds.body.id, mode: 'upsert', key_column: 'Item', rows: '{{body.items}}' } });
  const r = await post(h.url, { items: [{ item: 'Latte', price: '3.50' }, { Item: 'Tea', Price: '2.25' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = q1('SELECT config, cached_data FROM data_sources WHERE id = ?', ds.body.id);
  assert.deepEqual(JSON.parse(row.config).rows, [['Tea', '2.25'], ['Latte', '3.50']]);
  assert.match(row.cached_data, /3\.50/);
});

test('a playlist hook switches screens for a while, and stop releases them', async () => {
  const pl = await api('/api/playlists', J({ name: 'Promo' }));
  assert.ok(pl.body.id, JSON.stringify(pl.body));
  run("UPDATE playlists SET published_snapshot = '[]' WHERE id = ?", pl.body.id);
  const dev = crypto.randomUUID();
  run('INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, platform, tags) VALUES (?, ?, ?, ?, ?, ?, ?)',
    dev, ADMIN.id, ADMIN.ws, 'Lobby', crypto.randomUUID().slice(0, 6), 'android', JSON.stringify(['lobby']));
  const h = await mkHook({ name: 'Promo now', kind: 'playlist', config: { playlist_id: pl.body.id, minutes: 15, minutes_field: '{{body.minutes}}', scopes: [{ scope_kind: 'tag', scope_id: '#Lobby' }] } });
  const r = await post(h.url, { minutes: 5 });
  assert.match(r.body.result, /switched 1 screen\(s\) for 5 minute/);
  const o = q1('SELECT * FROM automation_overrides WHERE scope_id = ?', dev);
  assert.equal(o.ends_at - o.starts_at, 300);
  assert.match((await post(h.url, { minutes: 5 })).body.result, /switched 1/);
  assert.equal(q('SELECT * FROM automation_overrides WHERE scope_id = ?', dev).length, 1, 'a repeat restarts the window, it does not stack');
  const stop = await mkHook({ name: 'Promo stop', kind: 'playlist', config: { op: 'stop', scopes: [{ scope_kind: 'workspace' }] } });
  // A stop hook releases only its own overrides; deleting the start hook releases its screens.
  assert.match((await post(stop.url, {})).body.result, /released 0/);
  await api(`/api/automation/${h.id}`, J(undefined, 'DELETE'));
  assert.equal(q('SELECT * FROM automation_overrides WHERE scope_id = ?', dev).length, 0);
});

test('a trigger hook says what it could and could not reach', async () => {
  const pl = q1('SELECT id FROM playlists WHERE workspace_id = ? LIMIT 1', ADMIN.ws);
  const tid = crypto.randomUUID();
  run('INSERT INTO triggers (id, workspace_id, name, match_token, clear_token, target_kind, target_ref) VALUES (?, ?, ?, ?, ?, ?, ?)',
    tid, ADMIN.ws, 'Doorbell', 'ring', 'quiet', 'playlist', pl.id);
  const pi = crypto.randomUUID();
  const tv = crypto.randomUUID();
  run('INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, platform, client_type, trigger_secret) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    pi, ADMIN.id, ADMIN.ws, 'Pi', crypto.randomUUID().slice(0, 6), 'linux/arm64', 'pi', 's3cretpi');
  run('INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, platform, client_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
    tv, ADMIN.id, ADMIN.ws, 'TV', crypto.randomUUID().slice(0, 6), 'android', 'apk');
  for (const d of [pi, tv]) run("INSERT INTO trigger_assignments (trigger_id, target_type, target_id) VALUES (?, 'device', ?)", tid, d);
  const h = await mkHook({ name: 'Ring', kind: 'trigger', config: { trigger_id: tid } });
  const r = await post(h.url, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.result, /fired "Doorbell" on 0 screen\(s\); 1 offline; 1 can't be fired over the internet/);
});

test('zapier: token scopes, subscriptions and polling', async () => {
  const mint = async (scope) => (await api('/api/tokens', J({ name: `zap-${scope}`, scope }))).body.token;
  const read = await mint('read');
  const write = await mint('write');
  const full = await mint('full');
  assert.ok(read && write && full);

  const me = await api('/api/zapier/me', J(undefined, 'GET', read));
  assert.equal(me.status, 200);
  assert.equal(me.body.workspace_id, ADMIN.ws);

  // read cannot take over screens; full can.
  const denied = await api('/api/zapier/actions/emergency', J({ headline: 'From Zapier', alert_id: 'Z1' }, 'POST', read));
  assert.equal(denied.status, 403);
  const ok = await api('/api/zapier/actions/emergency', J({ headline: 'From Zapier', message: 'Hello', alert_id: 'Z1' }, 'POST', full));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.match(ok.body.result, /raised 1/);
  const zh = q1("SELECT * FROM automation_hooks WHERE json_extract(config, '$.via') = 'zapier'");
  assert.ok(zh, 'the action is a visible hook on the Automation page');
  assert.match((await api('/api/zapier/actions/emergency', J({ op: 'clear', alert_id: 'Z1' }, 'POST', full))).body.result, /cleared 1/);

  // Subscribing is a write (the token door's own rule); read can only poll.
  assert.equal((await api('/api/zapier/subscriptions', J({ event: 'emergency_raised', target_url: 'https://hooks.zapier.com/x' }, 'POST', read))).status, 403);
  // https only, never a credential in the URL; listed by host only.
  assert.equal((await api('/api/zapier/subscriptions', J({ event: 'emergency_raised', target_url: 'http://hooks.zapier.com/x' }, 'POST', write))).status, 400);
  assert.equal((await api('/api/zapier/subscriptions', J({ event: 'nope', target_url: 'https://hooks.zapier.com/x' }, 'POST', write))).status, 400);
  const sub = await api('/api/zapier/subscriptions', J({ event: 'emergency_raised', target_url: 'https://hooks.zapier.com/hooks/catch/1/abc/' }, 'POST', write));
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  assert.ok(sub.body.signing_secret);
  const subs = await api('/api/automation/subscriptions', J(undefined, 'GET'));
  assert.equal(subs.body[0].target_host, 'hooks.zapier.com');
  assert.ok(!JSON.stringify(subs.body).includes('catch/1/abc'));

  // A new raise queues one delivery for the subscriber.
  await api('/api/zapier/actions/emergency', J({ headline: 'Second', alert_id: 'Z2' }, 'POST', full));
  const due = q('SELECT * FROM automation_deliveries WHERE subscription_id = ?', sub.body.id);
  assert.equal(due.length, 1);

  // Polling: newest first, with ids Zapier can dedupe on; a sample when nothing has happened.
  const polled = await api('/api/zapier/events?event=emergency_raised', J(undefined, 'GET', read));
  assert.equal(polled.body[0].headline, 'Second');
  assert.ok(Number(polled.body[0].id) > Number(polled.body[1].id));
  const quiet = await api('/api/zapier/events?event=content_approved', J(undefined, 'GET', read));
  assert.equal(quiet.body[0].sample, true);

  const opts = await api('/api/zapier/options/playlists', J(undefined, 'GET', read));
  assert.ok(Array.isArray(opts.body) && opts.body.length >= 1);

  assert.equal((await api(`/api/zapier/subscriptions/${sub.body.id}`, J(undefined, 'DELETE', write))).body.removed, true);
  assert.equal((await api(`/api/zapier/subscriptions/${sub.body.id}`, J(undefined, 'DELETE', write))).body.removed, false, 'idempotent');

  // Hook URLs are minted on the JWT-only surface: an API token cannot reach it.
  assert.equal((await api('/api/automation', J(undefined, 'GET', full))).status, 401);
});

test('test-fire runs the hook for real and is marked as a test', async () => {
  const h = await mkHook({ name: 'Drill', kind: 'emergency', config: { scopes: [{ scope_kind: 'workspace' }] } });
  const t = await api(`/api/automation/${h.id}/test`, J({}));
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.match(t.body.outcome, /raised 1/);
  const calls = (await api(`/api/automation/${h.id}/calls`, J(undefined, 'GET'))).body;
  assert.equal(calls[0].test, true);
  await api(`/api/automation/${h.id}`, J(undefined, 'DELETE'));
  assert.equal(q1('SELECT COUNT(*) AS n FROM cap_feeds WHERE url = ? OR url LIKE ?', `hook:${h.id}`, `hook:${h.id}|%`).n, 0, 'deleting a hook removes its feeds and what they raised');
});

/* ============================== review fixes ============================== */

const hookOf = (via) => q1("SELECT * FROM automation_hooks WHERE json_extract(config, '$.via') = ?", via);
/** Every alert row on any of a hook's feeds, with the scopes of the feed it is on. */
const alertsOf = (hookId) => q(`SELECT a.akey, a.ended, a.feed_id FROM cap_alerts a JOIN cap_feeds f ON f.id = a.feed_id
    WHERE f.source = 'hook' AND (f.url = ? OR f.url LIKE ?)`, `hook:${hookId}`, `hook:${hookId}|%`)
  .map((a) => ({ ...a, scopes: q('SELECT scope_kind, scope_id FROM cap_feed_scopes WHERE feed_id = ?', a.feed_id).map((s) => `${s.scope_kind}:${s.scope_id}`) }));
const fullToken = async () => (await api('/api/tokens', J({ name: `zap-full-${crypto.randomUUID().slice(0, 4)}`, scope: 'full' }))).body.token;

test('a non-string id in a Zapier action is a 400, and the server keeps running', async () => {
  const full = await fullToken();
  const bad = [
    ['/api/zapier/actions/emergency', { headline: 'x', alert_id: 'BAD-1', playlist_id: {} }],
    ['/api/zapier/actions/emergency', { headline: 'x', alert_id: 'BAD-2', playlist_id: ['a', 'b'] }],
    ['/api/zapier/actions/playlist', { playlist_id: {}, minutes: 5 }],
    ['/api/zapier/actions/trigger', { trigger_id: { id: 1 } }],
    ['/api/zapier/actions/data', { data_source_id: [], rows: [] }],
    ['/api/zapier/actions/emergency', { headline: 'x', alert_id: 'BAD-3', group_id: [{}] }],
  ];
  for (const [p, body] of bad) {
    const r = await api(p, J(body, 'POST', full));
    assert.equal(r.status, 400, `${p} ${JSON.stringify(body)} -> ${JSON.stringify(r.body)}`);
  }
  // The same through the Automation page's own validation.
  assert.equal((await api('/api/automation', J({ name: 'x', kind: 'emergency', config: { scopes: [{ scope_kind: 'workspace' }], playlist_id: {} } }))).status, 400);
  assert.equal(proc.exitCode, null, 'the server process is still alive');
  assert.equal((await fetch(BASE + '/api/status')).status, 200);
});

test('an alert raised again after it was cleared shows again; a duplicate while live does not', async () => {
  // No alert id: the body is the key, so the second "Evacuate" is the same key as the first.
  const h = await mkHook({ name: 'Panel', kind: 'emergency', config: { op: 'auto', alert_id: '', scopes: [{ scope_kind: 'workspace' }] } });
  const evac = { headline: 'Evacuate', status: 'active' };
  assert.match((await post(h.url, evac)).body.result, /raised 1/);
  assert.match((await post(h.url, evac)).body.result, /no change/, 'a duplicate while live is still one alert');
  assert.match((await post(h.url, { status: 'all clear' })).body.result, /cleared 1/);
  assert.equal(liveAlerts(h.id).length, 0);
  const again = await post(h.url, evac);
  assert.match(again.body.result, /raised 1/, JSON.stringify(again.body));
  assert.equal(liveAlerts(h.id).length, 1, 'on screens again');
  assert.match((await post(h.url, evac)).body.result, /no change/);
  await api(`/api/automation/${h.id}`, J(undefined, 'DELETE'));

  // A sender's CAP Cancel is final: the same identifier again is a retry of something already over.
  const m = await mkHook({ name: 'CAP sender', kind: 'mass_notification', config: { scopes: [{ scope_kind: 'workspace' }] } });
  const sent = new Date(Date.now() - 2000).toISOString();
  const cap = (msgType, id, refs = '') => `<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>${id}</identifier><sender>s@x.test</sender><sent>${sent}</sent>
<status>Actual</status><msgType>${msgType}</msgType><scope>Public</scope>${refs ? `<references>${refs}</references>` : ''}
<info><event>Lockdown</event><severity>Extreme</severity><headline>Lockdown</headline></info></alert>`;
  assert.match((await post(m.url, cap('Alert', 'F-1'))).body.result, /raised 1/);
  assert.match((await post(m.url, cap('Cancel', 'F-2', `s@x.test,F-1,${sent}`))).body.result, /cleared 1/);
  assert.match((await post(m.url, cap('Alert', 'F-1'))).body.result, /no change/);
  assert.equal(liveAlerts(m.id).length, 0);
  await api(`/api/automation/${m.id}`, J(undefined, 'DELETE'));
});

test('Zapier: each alert keeps its own screens; another raise or a clear by id never moves it', async () => {
  const full = await fullToken();
  const gx = crypto.randomUUID();
  const gy = crypto.randomUUID();
  run('INSERT INTO device_groups (id, user_id, workspace_id, name) VALUES (?, ?, ?, ?)', gx, ADMIN.id, ADMIN.ws, 'Group X');
  run('INSERT INTO device_groups (id, user_id, workspace_id, name) VALUES (?, ?, ?, ?)', gy, ADMIN.id, ADMIN.ws, 'Group Y');
  const a = await api('/api/zapier/actions/emergency', J({ headline: 'Alert A', alert_id: 'SC-A', group_id: gx }, 'POST', full));
  assert.match(a.body.result, /raised 1/, JSON.stringify(a.body));
  const b = await api('/api/zapier/actions/emergency', J({ headline: 'Alert B', alert_id: 'SC-B', group_id: gy }, 'POST', full));
  assert.match(b.body.result, /raised 1/, JSON.stringify(b.body));
  const zh = hookOf('zapier');
  const find = (id) => alertsOf(zh.id).find((r) => r.akey === `hook:${zh.id}|${id}`);
  assert.deepEqual(find('SC-A').scopes, [`group:${gx}`], 'B raising on group Y did not move A');
  assert.deepEqual(find('SC-B').scopes, [`group:${gy}`]);
  assert.equal(find('SC-A').ended, 0);

  // A clear by id with no screens named (which defaults to the whole workspace) ends B and moves nothing.
  const c = await api('/api/zapier/actions/emergency', J({ op: 'clear', alert_id: 'SC-B' }, 'POST', full));
  assert.match(c.body.result, /cleared 1/, JSON.stringify(c.body));
  assert.deepEqual(find('SC-A').scopes, [`group:${gx}`], 'the clear did not re-scope A');
  assert.equal(find('SC-A').ended, 0, 'A is still live');
  assert.notEqual(find('SC-B').ended, 0);
  assert.ok(!alertsOf(zh.id).some((r) => r.akey.includes('|SC-') && r.scopes.includes(`workspace:${ADMIN.ws}`) && r.ended === 0), 'neither alert went workspace-wide');
  await api('/api/zapier/actions/emergency', J({ op: 'clear', alert_id: 'SC-A' }, 'POST', full));
});

test('a disabled Zapier hook stays disabled after an edit, and the action is refused with 409', async () => {
  const full = await fullToken();
  assert.equal((await api('/api/zapier/actions/emergency', J({ headline: 'warm-up', alert_id: 'DIS-0' }, 'POST', full))).status, 200);
  const zh = hookOf('zapier');
  const shown = (await api(`/api/automation/${zh.id}`, J(undefined, 'GET'))).body;
  // What the edit form sends: the whole config back, rebuilt from the form's fields, plus enabled.
  const { via: _via, ...formConfig } = shown.config;
  const put = await api(`/api/automation/${zh.id}`, J({ name: shown.name, enabled: false, config: formConfig }, 'PUT'));
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(hookOf('zapier').id, zh.id, 'via survives the edit');
  const before = q1('SELECT COUNT(*) AS n FROM automation_hooks').n;
  const r = await api('/api/zapier/actions/emergency', J({ headline: 'After disable', alert_id: 'DIS-1' }, 'POST', full));
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'ZAPIER_HOOK_DISABLED');
  assert.equal(q1('SELECT COUNT(*) AS n FROM automation_hooks').n, before, 'no fresh hook was created');
  assert.equal(q1('SELECT enabled FROM automation_hooks WHERE id = ?', zh.id).enabled, 0);
  await api(`/api/automation/${zh.id}`, J({ enabled: true }, 'PUT'));
});

test('a workspace viewer signed in with a session cannot add or remove Zapier subscriptions', async () => {
  const reg = await api('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `viewer-${crypto.randomUUID().slice(0, 6)}@example.test`, password: 'Passw0rd123', name: 'Viewer' }) });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_viewer')", ADMIN.ws, reg.body.user.id);
  const asViewer = (body, method) => ({ ...J(body, method, reg.body.token), headers: { ...J(body, method, reg.body.token).headers, 'X-Workspace-Id': ADMIN.ws } });
  assert.equal((await api('/api/zapier/me', asViewer(undefined, 'GET'))).status, 200, 'the viewer can read');
  const add = await api('/api/zapier/subscriptions', asViewer({ event: 'emergency_raised', target_url: 'https://hooks.zapier.com/hooks/catch/9/viewer/' }, 'POST'));
  assert.equal(add.status, 403, JSON.stringify(add.body));
  const sub = await api('/api/zapier/subscriptions', J({ event: 'emergency_raised', target_url: 'https://hooks.zapier.com/hooks/catch/9/admin/' }));
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  assert.equal((await api(`/api/zapier/subscriptions/${sub.body.id}`, asViewer(undefined, 'DELETE'))).status, 403);
  assert.ok(q1('SELECT 1 AS x FROM automation_subscriptions WHERE id = ?', sub.body.id), 'still there');
  assert.equal((await api(`/api/zapier/subscriptions/${sub.body.id}`, J(undefined, 'DELETE'))).status, 200);
});

test('a hook answers GET only when it allows GET', async () => {
  const h = await mkHook({ name: 'Getter', kind: 'emergency', config: { op: 'clear', scopes: [{ scope_kind: 'workspace' }] } });
  const get = (url) => fetch(url).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const off = await get(h.url);
  assert.equal(off.status, 404, 'a link preview does not fire it');
  assert.deepEqual(off.body, (await post(`${BASE}/api/hooks/in/${crypto.randomUUID()}/x`, {})).body, 'the same 404 as a wrong address');
  assert.equal((await post(h.url, {})).status, 200, 'POST works');
  const put = await api(`/api/automation/${h.id}`, J({ allow_get: true }, 'PUT'));
  assert.equal(put.body.config.allow_get, true);
  assert.equal((await get(h.url)).status, 200);
  // An edit that resends the config keeps the choice unless it says otherwise.
  await api(`/api/automation/${h.id}`, J({ config: { op: 'clear', scopes: [{ scope_kind: 'workspace' }] } }, 'PUT'));
  assert.equal((await get(h.url)).status, 200);
  await api(`/api/automation/${h.id}`, J({ allow_get: false }, 'PUT'));
  assert.equal((await get(h.url)).status, 404);
  await api(`/api/automation/${h.id}`, J(undefined, 'DELETE'));
});

test('the rate-limit key for a hook URL never contains its secret', () => {
  const { canonicalLimitPath } = require('../lib/limit-paths');
  const secret = crypto.randomBytes(32).toString('base64url');
  const id = crypto.randomUUID();
  const a = canonicalLimitPath(`/api/hooks/in/${id}/${secret}`);
  const b = canonicalLimitPath(`/api/hooks/in/${id}/${crypto.randomBytes(32).toString('base64url')}/`);
  assert.equal(a, `/api/hooks/in/${id}/:secret`);
  assert.equal(a, b, 'one bucket per hook, not one per secret guessed');
  assert.ok(!a.toLowerCase().includes(secret.toLowerCase()));
  // Another hook (another tenant behind the same cloud IP) has its own bucket.
  assert.notEqual(canonicalLimitPath(`/api/hooks/in/${crypto.randomUUID()}/${secret}`), a);
  // Anything that is not a hook ID shares one bucket.
  assert.equal(canonicalLimitPath(`/api/hooks/in/not-an-id/${secret}`), '/api/hooks/in/:unmatched');
  assert.equal(canonicalLimitPath('/api/hooks/in'), '/api/hooks/in/:unmatched');
});
