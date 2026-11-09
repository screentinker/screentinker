'use strict';

/*
 * A ZONE'S GEOMETRY IS FOUR NUMBERS.
 *
 * x, y, width and height of a layout zone are percentages. The dashboard writes them straight into
 * style attributes in six places (the layout editor, the playlist editor's mock-up, the review
 * queue, the history modal, the agency portal), and the columns are REAL, which in SQLite keeps a
 * non-numeric string exactly as it was sent. So a zone whose "x" was a string became part of the
 * page of whoever opened that layout next: a reviewer, an admin, another member.
 *
 * The invariant, at both ends:
 *   - the server stores a finite number or its default for each of the four, on every write path;
 *   - the dashboard never interpolates the stored value as it is: every one of those sinks coerces.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { freePort } = require('./helpers/free-port');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GEOM = ['x_percent', 'y_percent', 'width_percent', 'height_percent'];
const EVIL = '5%;background:url(//x)"><img src=x onerror=alert(1)><i x="';

let proc, BASE, jwt;
const DATA_DIR = path.join(os.tmpdir(), 'st-zonegeom-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';

const call = async (method, p, body) => {
  const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt },
    body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, body: json };
};
const zonesOf = async (id) => (await call('GET', '/api/layouts/' + id)).body.zones;
const allNumeric = (zones) => zones.every((z) => GEOM.every((k) => typeof z[k] === 'number' && Number.isFinite(z[k])));

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(port), NODE_ENV: 'test' }, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/status')).ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  const reg = await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `z${crypto.randomBytes(4).toString('hex')}@example.com`, password: 'Passw0rd123', name: 'Z' }) });
  jwt = (await reg.json()).token;
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

test('ordinary geometry is stored exactly as sent', async () => {
  const c = await call('POST', '/api/layouts', { name: 'ok', zones: [{ name: 'Main', x_percent: 0, y_percent: 12.5, width_percent: 72, height_percent: 87.5 }] });
  assert.ok(c.status < 300, JSON.stringify(c.body));
  const [z] = await zonesOf(c.body.id);
  assert.deepEqual(GEOM.map((k) => z[k]), [0, 12.5, 72, 87.5]);
});

test('creating a layout stores numbers, whatever was sent', async () => {
  const c = await call('POST', '/api/layouts', { name: 'a', zones: [{ name: 'Z', x_percent: EVIL, y_percent: EVIL, width_percent: EVIL, height_percent: EVIL }] });
  assert.ok(c.status < 300, JSON.stringify(c.body));
  const zones = await zonesOf(c.body.id);
  assert.ok(allNumeric(zones), 'stored: ' + JSON.stringify(zones.map((z) => GEOM.map((k) => z[k]))));
});

test('saving a layout stores numbers, whatever was sent', async () => {
  const c = await call('POST', '/api/layouts', { name: 'b', zones: [{ name: 'Z', x_percent: 1, y_percent: 2, width_percent: 30, height_percent: 40 }] });
  const [z0] = await zonesOf(c.body.id);
  const u = await call('PUT', '/api/layouts/' + c.body.id, { name: 'b', zones: [{ id: z0.id, name: 'Z', x_percent: EVIL, y_percent: 2, width_percent: EVIL, height_percent: 40 }] });
  assert.ok(u.status < 300, JSON.stringify(u.body));
  assert.ok(allNumeric(await zonesOf(c.body.id)));
});

test('adding or editing one zone stores numbers, or is refused', async () => {
  const c = await call('POST', '/api/layouts', { name: 'c', zones: [{ name: 'Z', x_percent: 1, y_percent: 2, width_percent: 30, height_percent: 40 }] });
  const add = await call('POST', `/api/layouts/${c.body.id}/zones`, { name: 'N', x_percent: EVIL, y_percent: EVIL, width_percent: EVIL, height_percent: EVIL });
  assert.ok(add.status < 500, 'a bad value is handled, not a server error: ' + JSON.stringify(add.body));
  const [z0] = await zonesOf(c.body.id);
  const put = await call('PUT', `/api/layouts/${c.body.id}/zones/${z0.id}`, { x_percent: EVIL });
  assert.ok(put.status < 500, JSON.stringify(put.body));
  assert.ok(allNumeric(await zonesOf(c.body.id)), 'no path leaves a string in a geometry column');
  // ...and a normal single-zone edit still works.
  const ok = await call('PUT', `/api/layouts/${c.body.id}/zones/${z0.id}`, { x_percent: 33.3 });
  assert.ok(ok.status < 300, JSON.stringify(ok.body));
  assert.equal((await zonesOf(c.body.id)).find((z) => z.id === z0.id).x_percent, 33.3);
});

test('the dashboard never writes a stored geometry value into HTML as it is', () => {
  const root = path.join(__dirname, '..', '..', 'frontend', 'js');
  const files = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) { if (e.name !== 'i18n' && e.name !== 'vendor') walk(path.join(d, e.name)); }
    else if (e.name.endsWith('.js')) files.push(path.join(d, e.name));
  } }(root));
  const raw = /\$\{\s*[\w.]*\.(?:x_percent|y_percent|width_percent|height_percent)\s*\}/;
  const hits = [];
  for (const f of files) fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => { if (raw.test(line)) hits.push(`${path.relative(root, f)}:${i + 1}`); });
  assert.deepEqual(hits, [], 'these interpolate a zone percentage without coercing it to a number');
});
