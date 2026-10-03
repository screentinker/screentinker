'use strict';

/*
 * #317: uploading a lot of files at once.
 *
 * Someone tried to put ~160 party photos into a folder, got an error message with no number in it,
 * and worked out by trial that sixteen at a time went through. Two separate faults produced that:
 * the per-request cap was 20, and nothing translated multer's refusal, so going over it surfaced as
 * a bare unhandled error rather than a sentence saying what the limit is.
 *
 * The cap still exists — one request has to fit in a proxy's body limit and finish inside its
 * timeout — but it is higher, it is stated when it is hit, and the dashboard chunks a large
 * selection so a person never reaches it (see uploadContent in frontend/js/api.js).
 *
 * These cover the SERVER half. The batching itself is guarded by a source check below, since it
 * lives in browser code with no DOM here to drive it.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { freePort } = require('./helpers/free-port');
let PORT, BASE, jwt;
const DATA_DIR = path.join(os.tmpdir(), 'st-upl-' + crypto.randomBytes(4).toString('hex'));
let proc;

// A tiny valid PNG, so the upload is refused (or not) on COUNT rather than on content sniffing.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

function form(n) {
  const fd = new FormData();
  for (let i = 0; i < n; i++) {
    fd.append('files', new Blob([PNG], { type: 'image/png' }), `shot-${i}.png`);
  }
  return fd;
}
const send = (fd) => fetch(BASE + '/api/content', { method: 'POST', headers: { Authorization: 'Bearer ' + jwt }, body: fd });

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(path.join(os.tmpdir(), 'st-upl.log'), 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await new Promise(r => setTimeout(r, 250)); }
  if (!up) throw new Error('server did not boot');
  const email = 'u' + crypto.randomBytes(4).toString('hex') + '@x.local';
  jwt = (await (await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Passw0rd123' }) })).json()).token;
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

test('REGRESSION #317: more than 20 files in one request is accepted (the old cap)', async () => {
  const r = await send(form(25));
  assert.equal(r.status, 201, 'a 25-file upload must not be refused');
  const body = await r.json();
  assert.ok(Array.isArray(body), 'a batch returns an array');
  assert.equal(body.length, 25);
});

test('REGRESSION #317: going over the cap says so, instead of a bare 500', async () => {
  const r = await send(form(80));               // over MAX_FILES_PER_UPLOAD
  assert.equal(r.status, 400, 'refused with a client error, not a 500');
  const body = await r.json();
  assert.match(body.error, /too many files/i, 'the message names the problem');
  assert.match(body.error, /\d+/, 'and states the actual limit');
  assert.match(body.error, /batch/i, 'and says what to do instead');
});

test('a single-file upload is unchanged', async () => {
  const fd = new FormData();
  fd.append('files', new Blob([PNG], { type: 'image/png' }), 'one.png');
  const r = await send(fd);
  assert.equal(r.status, 201);
});

test('the dashboard chunks a large selection so it never meets the cap', () => {
  const api = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'api.js'), 'utf8');
  const at = api.indexOf('uploadContent:');
  assert.ok(at > 0, 'uploadContent found');
  const end = api.indexOf('addRemoteContent:', at);      // the next helper — slice the whole function
  assert.ok(end > at, 'end of uploadContent found');
  const fn = api.slice(at, end);
  const chunk = fn.match(/const CHUNK = (\d+);/);
  assert.ok(chunk, 'uploadContent defines a chunk size');
  assert.ok(Number(chunk[1]) > 0 && Number(chunk[1]) <= 60,
    'the client chunk must stay at or under the server cap (MAX_FILES_PER_UPLOAD in routes/content.js)');
  assert.match(fn, /for \(let i = 0; i < files\.length; i \+= CHUNK\)/, 'it actually splits the list');
  assert.match(fn, /were uploaded before this failed/, 'a partial failure reports what already landed');
});

test('the server cap and the client chunk cannot silently cross over', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'content.js'), 'utf8');
  const cap = route.match(/const MAX_FILES_PER_UPLOAD = (\d+);/);
  assert.ok(cap, 'the cap is a named constant');
  const api = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'api.js'), 'utf8');
  const chunk = api.match(/const CHUNK = (\d+);/);
  assert.ok(chunk, 'the chunk is a named constant');
  assert.ok(Number(chunk[1]) <= Number(cap[1]),
    `client chunk ${chunk[1]} must not exceed server cap ${cap[1]}`);
});
