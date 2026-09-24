'use strict';

/*
 * Saved device endpoints — REST calls a panel makes on its own network, on its own clock.
 *
 * The assertions worth having are the ones that are invisible until they cost someone a credential
 * or a screen:
 *
 *   - a header value must NEVER come back from the API. An endpoint header is where an API key
 *     lives, and a workspace member who can read the row should not thereby read the credential.
 *   - editing the URL must not ERASE that key. GET returns blank values, so a form round-trip
 *     sends blanks back — saving them verbatim is the classic "the form saved what it could see".
 *   - the resolution is a UNION, not an override: a screen runs its group's endpoints AND its own.
 *     Picking a winner would silently drop work an operator configured.
 *   - a poll floor, because this runs on a panel that is playing video against a small controller.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { freePort } = require('./helpers/free-port');
const DATA_DIR = path.join(os.tmpdir(), 'st-ep-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
let PORT, BASE, proc, jwt, workspaceId, deviceId, groupId, dbFile;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const J = (tok, body, method = 'POST') => ({
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const api = (p) => BASE + '/api/device-endpoints' + p;
const H = () => ({ headers: { Authorization: `Bearer ${jwt}` } });

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
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));

  const reg = await (await fetch(BASE + '/api/auth/register', J(null, {
    email: `ep${Date.now()}@example.com`, password: 'Passw0rd123', name: 'EP',
  }))).json();
  jwt = reg.token;
  workspaceId = reg.current_workspace_id;

  const g = await (await fetch(BASE + '/api/groups', J(jwt, { name: 'Lobby' }))).json();
  groupId = g.id;

  const Database = require('better-sqlite3');
  dbFile = path.join(DATA_DIR, 'db', 'remote_display.db');
  const raw = new Database(dbFile);
  deviceId = crypto.randomUUID();
  raw.prepare('INSERT INTO devices (id, name, workspace_id, status) VALUES (?, ?, ?, ?)')
    .run(deviceId, 'Lobby 1', workspaceId, 'offline');
  raw.prepare('INSERT INTO device_group_members (group_id, device_id) VALUES (?, ?)').run(groupId, deviceId);
  raw.close();
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

const SECRET = 'Bearer sk-live-do-not-leak-me';

async function create(body) {
  const r = await fetch(api('/'), J(jwt, body));
  return { status: r.status, body: await r.json() };
}

/* ------------------------------------------------------------------ secrecy */

test('⚠️ a header value NEVER comes back from the API', async () => {
  const c = await create({
    device_id: deviceId, name: 'PLC state', url: 'http://192.168.1.50/api/state',
    headers: { Authorization: SECRET, Accept: 'application/json' },
  });
  assert.equal(c.status, 201, JSON.stringify(c.body));

  // Not on create...
  assert.equal(c.body.endpoint.headers.Authorization, '');
  // ...not on read...
  const one = await (await fetch(api('/' + c.body.endpoint.id), H())).json();
  assert.equal(one.endpoint.headers.Authorization, '');
  // ...not in a list...
  const list = await (await fetch(api('/'), H())).json();
  assert.equal(list.endpoints[0].headers.Authorization, '');
  // ...and not on the effective view either, which is the one most likely to be forgotten.
  const eff = await (await fetch(api('/effective/' + deviceId), H())).json();
  assert.equal(eff.endpoints[0].headers.Authorization, '');

  // The NAMES are visible — an operator has to see what is configured.
  assert.deepEqual(Object.keys(one.endpoint.headers).sort(), ['Accept', 'Authorization']);

  // And nowhere in any response body, by brute force.
  for (const blob of [JSON.stringify(c.body), JSON.stringify(one), JSON.stringify(list), JSON.stringify(eff)]) {
    assert.ok(!blob.includes('sk-live-do-not-leak-me'), 'the secret escaped into a response');
  }
});

test('⚠️ the value is encrypted AT REST, not merely hidden by the API', async () => {
  const Database = require('better-sqlite3');
  const raw = new Database(dbFile, { readonly: true });
  const rows = raw.prepare('SELECT headers FROM device_endpoints').all();
  raw.close();
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.ok(!r.headers.includes('sk-live-do-not-leak-me'),
      'a plaintext credential in the database is readable by anything with the file');
  }
});

test('⚠️ editing the URL does not ERASE the key', async () => {
  const c = await create({
    device_id: deviceId, name: 'Sensor', url: 'http://192.168.1.60/t',
    headers: { Authorization: SECRET },
  });
  const id = c.body.endpoint.id;

  // Exactly what a form round-trip sends: the redacted object straight back, with a new URL.
  const put = await fetch(api('/' + id), J(jwt, {
    url: 'http://192.168.1.61/t', headers: { Authorization: '' },
  }, 'PUT'));
  assert.equal(put.status, 200);

  const eff = await (await fetch(api('/effective/' + deviceId), H())).json();
  const sensor = eff.endpoints.find((e) => e.name === 'Sensor');
  assert.ok(sensor, 'still there');
  assert.equal(sensor.url, 'http://192.168.1.61/t', 'the URL changed');

  /*
   * ⚠️ Asserted WITHOUT decrypting, deliberately. secretbox derives its key from the instance's
   * JWT secret, which lives in DATA_DIR — so this test process cannot decrypt what the SERVER
   * process wrote, and an attempt to would report an empty string and look exactly like the bug.
   * (It did, on the first run of this test.)
   *
   * The property that matters is "not erased", and the stored ciphertext answers it directly.
   */
  const stored = new (require('better-sqlite3'))(dbFile, { readonly: true });
  const row = stored.prepare('SELECT headers FROM device_endpoints WHERE id = ?').get(id);
  stored.close();
  const saved = JSON.parse(row.headers);
  assert.ok(saved.Authorization, 'the credential must survive an edit that could not see it');
  assert.ok(saved.Authorization.length > 20, 'and still be a real stored value, not a blank');
  assert.ok(!saved.Authorization.includes('sk-live-do-not-leak-me'), 'still encrypted');
});

/* ------------------------------------------------------------- the union rule */

test('⚠️ a screen runs its GROUP\'s endpoints AND its own — a union, not an override', async () => {
  await create({ group_id: groupId, name: 'Group ping', url: 'http://10.0.0.1/ping' });
  await create({ device_id: deviceId, name: 'Own ping', url: 'http://10.0.0.2/ping' });

  const eff = await (await fetch(api('/effective/' + deviceId), H())).json();
  const names = eff.endpoints.map((e) => e.name);
  assert.ok(names.includes('Group ping'), 'the group\'s must run');
  assert.ok(names.includes('Own ping'), 'and so must the screen\'s own');
});

test('a device endpoint of the SAME NAME replaces the group\'s', async () => {
  // How one panel is pointed at a different address without leaving the group.
  await create({ group_id: groupId, name: 'Shared', url: 'http://10.0.0.9/group' });
  await create({ device_id: deviceId, name: 'Shared', url: 'http://10.0.0.9/device' });

  const eff = await (await fetch(api('/effective/' + deviceId), H())).json();
  const shared = eff.endpoints.filter((e) => e.name === 'Shared');
  assert.equal(shared.length, 1, 'one winner, not two entries with the same name');
  assert.equal(shared[0].url, 'http://10.0.0.9/device');
});

test('a disabled endpoint is not sent to the panel at all', async () => {
  const c = await create({ device_id: deviceId, name: 'Off one', url: 'http://10.0.0.3/x', enabled: false });
  assert.equal(c.status, 201);
  const eff = await (await fetch(api('/effective/' + deviceId), H())).json();
  assert.ok(!eff.endpoints.some((e) => e.name === 'Off one'));
});

/* ------------------------------------------------------------------ validation */

test('the same target guard the panel enforces applies at save time', async () => {
  for (const url of ['file:///etc/passwd', 'content://x/y', 'http://169.254.169.254/', 'nonsense']) {
    const r = await create({ device_id: deviceId, name: 'bad ' + url, url });
    assert.equal(r.status, 400, `${url} must be refused at the door`);
    assert.match(r.body.error, /url:/);
  }
  // ...and RFC1918 is allowed, because that is the entire feature.
  const ok = await create({ device_id: deviceId, name: 'lan ok', url: 'http://192.168.9.9/x' });
  assert.equal(ok.status, 201);
});

test('⚠️ a poll floor of 30s — this runs on a panel that is playing video', async () => {
  const fast = await create({ device_id: deviceId, name: 'too fast', url: 'http://10.0.0.4/x', interval_sec: 1 });
  assert.equal(fast.status, 400);
  assert.match(fast.body.error, /interval_sec/);

  const ok = await create({ device_id: deviceId, name: 'sane', url: 'http://10.0.0.5/x', interval_sec: 60 });
  assert.equal(ok.status, 201);
});

test('interval OR event, never both', async () => {
  const both = await create({
    device_id: deviceId, name: 'confused', url: 'http://10.0.0.6/x',
    interval_sec: 60, run_on: 'screen_on',
  });
  assert.equal(both.status, 400);
  assert.match(both.body.error, /interval.*OR.*event/i);

  const ev = await create({ device_id: deviceId, name: 'on wake', url: 'http://10.0.0.7/x', run_on: 'screen_on' });
  assert.equal(ev.status, 201);
  const bad = await create({ device_id: deviceId, name: 'bogus event', url: 'http://10.0.0.8/x', run_on: 'whenever' });
  assert.equal(bad.status, 400);
});

test('a header value with a newline is refused — it can inject a second header', async () => {
  const r = await create({
    device_id: deviceId, name: 'injector', url: 'http://10.0.0.11/x',
    headers: { 'X-Thing': 'a\r\nX-Evil: yes' },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /newline/i);
});

/* ------------------------------------------------------------------- tenancy */

test('another workspace cannot see, read, edit, run or delete this endpoint', async () => {
  const c = await create({ device_id: deviceId, name: 'Mine', url: 'http://10.0.0.12/x' });
  const id = c.body.endpoint.id;

  const other = await (await fetch(BASE + '/api/auth/register', J(null, {
    email: `ep-other${Date.now()}@example.com`, password: 'Passw0rd123', name: 'Other',
  }))).json();
  const OH = { headers: { Authorization: `Bearer ${other.token}` } };

  assert.equal((await (await fetch(api('/'), OH)).json()).endpoints.length, 0);
  assert.equal((await fetch(api('/' + id), OH)).status, 404);
  assert.equal((await fetch(api('/effective/' + deviceId), OH)).status, 404);
  assert.equal((await fetch(api('/' + id), J(other.token, { name: 'theirs' }, 'PUT'))).status, 404);
  assert.equal((await fetch(api(`/${id}/run`), J(other.token, {}))).status, 404);
  assert.equal((await fetch(api('/' + id), J(other.token, undefined, 'DELETE'))).status, 404);
});

test('a target in another workspace cannot be addressed', async () => {
  const other = await (await fetch(BASE + '/api/auth/register', J(null, {
    email: `ep-t${Date.now()}@example.com`, password: 'Passw0rd123', name: 'T',
  }))).json();
  const r = await fetch(api('/'), J(other.token, {
    device_id: deviceId, name: 'theirs', url: 'http://10.0.0.13/x',
  }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /device not found/i);
});

test('running an endpoint goes through the capability gate like any http_request', async () => {
  // The fixture device declares nothing, so it falls back to a baseline without net.http_request.
  const c = await create({ device_id: deviceId, name: 'Runnable', url: 'http://10.0.0.14/x' });
  const r = await fetch(api(`/${c.body.endpoint.id}/run`), J(jwt, {}));
  assert.equal(r.status, 400);
  const b = await r.json();
  assert.equal(b.capability, 'net.http_request',
    'a test must exercise the same gate the scheduled run will hit, or it proves nothing');
});

test('mergeHeaders keeps a blank, drops one that was never set, and takes a new value', () => {
  /*
   * The merge itself, as a unit — no encryption, no server, so a failure here is unambiguous.
   * This is the logic that stops a form round-trip erasing an API key it was never shown.
   */
  const { mergeHeaders } = require('../lib/device-endpoints');
  const stored = { Authorization: 'Bearer real', Accept: 'application/json' };

  // A blank keeps the stored value...
  assert.deepEqual(mergeHeaders({ Authorization: '', Accept: 'application/json' }, stored),
    { Authorization: 'Bearer real', Accept: 'application/json' });
  // ...as does the '***' placeholder some forms send.
  assert.equal(mergeHeaders({ Authorization: '***' }, stored).Authorization, 'Bearer real');
  // A NEW value replaces it.
  assert.equal(mergeHeaders({ Authorization: 'Bearer new' }, stored).Authorization, 'Bearer new');
  // A blank for something never stored is dropped rather than saved as an empty header.
  assert.deepEqual(mergeHeaders({ 'X-New': '' }, stored), {});
  // Removing a key from the incoming object removes the header — that is how you delete one.
  assert.deepEqual(mergeHeaders({ Accept: 'text/plain' }, stored), { Accept: 'text/plain' });
});
