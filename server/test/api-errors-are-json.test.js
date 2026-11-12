'use strict';

/*
 * AN API ERROR IS A JSON ERROR, AND A MALFORMED REQUEST IS THE CALLER'S ERROR.
 *
 * Every route answers `{ error }` when it refuses something, and every client (the dashboard, the
 * players, integrations) reads that. But a route that THROWS had no handler behind it, so the
 * reply was the framework's HTML error page: status 500, a stack trace in the body outside
 * production, and nothing a client can parse. Requests that reach that path are almost always
 * malformed ones: a number where a name belongs, a query parameter given twice, a page offset too
 * large for the database, an upload of a type that is not accepted.
 *
 * The invariants:
 *   - whatever goes wrong under /api, the reply is JSON with an `error` string and no stack;
 *   - the sign-in endpoints, reachable with no account, answer 400 to fields of the wrong type;
 *   - a value the database cannot take as a parameter (an array, an object, an out-of-range
 *     number) is the request's fault: 400, not 500;
 *   - an upload that is refused is refused with 400.
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
let proc, BASE, token;
const DATA_DIR = path.join(os.tmpdir(), 'st-apierr-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';

async function send(method, p, { body, headers = {}, raw, auth = true } = {}) {
  const h = { ...(auth && token ? { Authorization: 'Bearer ' + token } : {}), ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers: h, body: raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, type: res.headers.get('content-type') || '', text, json };
}

/** The shape every refusal must have. */
function assertJsonError(r, label) {
  assert.match(r.type, /application\/json/, `${label}: the reply is JSON, got ${r.type}: ${r.text.slice(0, 120)}`);
  assert.ok(r.json && typeof r.json.error === 'string' && r.json.error.length > 0, `${label}: it carries an error string`);
  assert.doesNotMatch(r.text, /\n?\s+at\s+\S+\s+\(|node_modules|\.js:\d+/, `${label}: and no stack trace or file path`);
}

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(port), NODE_ENV: 'test', RATE_LIMIT_BACKSTOP: '0' }, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  const reg = await send('POST', '/api/auth/register', { auth: false, body: { email: 'err' + crypto.randomBytes(4).toString('hex') + '@example.com', password: 'Passw0rd123', name: 'E' } });
  token = reg.json.token;
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

const SIGN_IN = [
  ['POST', '/api/auth/login', { email: 1, password: 'x' }],
  ['POST', '/api/auth/login', { email: 'a@example.com', password: { a: 1 } }],
  ['POST', '/api/auth/login', { email: ['a@example.com'], password: 'x' }],
  ['POST', '/api/auth/register', { email: { toString: 1 }, password: 'Passw0rd123', name: 'x' }],
  ['POST', '/api/auth/register', { email: 'b@example.com', password: 12345678, name: 'x' }],
  ['POST', '/api/auth/forgot-password', { email: { toString: 1 } }],
  ['POST', '/api/auth/resend-verification', { email: { toString: 1 } }],
  ['POST', '/api/auth/reset-password', { token: { toString: 1 }, password: 'Passw0rd123' }],
  ['POST', '/api/auth/reset-password', { token: 'abc', password: 12345678 }],
];
for (const [method, p, body] of SIGN_IN) {
  test(`no account needed: ${p} ${JSON.stringify(body)} is a 400`, async () => {
    const r = await send(method, p, { auth: false, body });
    assert.equal(r.status, 400, r.text.slice(0, 200));
    assertJsonError(r, p);
  });
}

test('a signed-in password change with non-text fields is a 400', async () => {
  const r = await send('PUT', '/api/auth/me', { body: { password: 1, current_password: 2 } });
  assert.equal(r.status, 400, r.text.slice(0, 200));
  assertJsonError(r, 'PUT /api/auth/me');
});

test('a device endpoint given its device id twice is refused, not crashed', async () => {
  const r = await send('GET', '/api/embedded/info?device_id=a&device_id=b', { auth: false, headers: { Authorization: 'Bearer nothing' } });
  assert.ok(r.status === 400 || r.status === 401, 'status ' + r.status + ' ' + r.text.slice(0, 200));
  assertJsonError(r, '/api/embedded/info');
});

const BAD_PARAMS = [
  ['GET', '/api/devices?limit=5&offset=99999999999999999999999'],
  ['GET', '/api/reports/plays?limit=99999999999999999999999'],
  ['GET', '/api/schedules?device_id=a&device_id=b'],
  ['GET', '/api/activity?device_id=a&device_id=b'],
];
for (const [method, p] of BAD_PARAMS) {
  test(`a parameter the database cannot take is the request's fault: ${p}`, async () => {
    const r = await send(method, p);
    assert.equal(r.status, 400, r.text.slice(0, 200));
    assertJsonError(r, p);
  });
}

test('a body field the database cannot take is a 400', async () => {
  const pl = await send('POST', '/api/playlists', { body: { name: 'P' } });
  assert.equal(pl.status, 201, pl.text);
  const r = await send('POST', `/api/playlists/${pl.json.id}/assign`, { body: { device_id: true } });
  assert.ok(r.status >= 400 && r.status < 500, 'status ' + r.status + ' ' + r.text.slice(0, 200));
  assertJsonError(r, 'assign');
});

test('whatever a route throws on, the reply is still JSON', async () => {
  for (const [method, p, body] of [
    ['POST', '/api/playlists', { name: 123 }],
    ['POST', '/api/folders', { name: 123 }],
    ['GET', '/api/content?q=a&q=b', undefined],
  ]) {
    const r = await send(method, p, { body });
    assert.ok(r.status >= 400, `${p}: refused (${r.status})`);
    assertJsonError(r, p);
  }
});

function multipart(field, filename, type, content) {
  const b = '----stqa' + crypto.randomBytes(6).toString('hex');
  const raw = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),
    Buffer.from(content), Buffer.from(`\r\n--${b}--\r\n`)]);
  return { raw, headers: { 'Content-Type': 'multipart/form-data; boundary=' + b } };
}

test('an upload of a type that is not accepted is refused with 400', async () => {
  const r = await send('POST', '/api/content', multipart('file', 'notes.txt', 'text/plain', 'hello'));
  assert.equal(r.status, 400, r.text.slice(0, 200));
  assertJsonError(r, 'upload .txt');
});

test('an upload under the wrong field name, or with no boundary, is refused with 400', async () => {
  const wrong = await send('POST', '/api/fonts', multipart('nope', 'a.ttf', 'font/ttf', 'xxxx'));
  assert.equal(wrong.status, 400, wrong.text.slice(0, 200));
  assertJsonError(wrong, 'wrong field');
  const nob = await send('POST', '/api/content', { raw: 'x', headers: { 'Content-Type': 'multipart/form-data' } });
  assert.equal(nob.status, 400, nob.text.slice(0, 200));
  assertJsonError(nob, 'no boundary');
});

test('a normal request is untouched', async () => {
  const ok = await send('GET', '/api/devices?limit=5&offset=0');
  assert.equal(ok.status, 200);
  const bad = await send('POST', '/api/auth/login', { auth: false, body: { email: 'nobody@example.com', password: 'wrong-password' } });
  assert.equal(bad.status, 401, 'a wrong password is still a 401');
});
