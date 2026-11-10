'use strict';

/*
 * /favicon.ico ANSWERS WITH THE PRODUCT ICON.
 *
 * Pages that declare an icon link get it from /assets. Pages that do not (the web player, the
 * download hub, the firmware installer, any error page) make the browser ask for /favicon.ico,
 * which was a 404: a console error on every load of a player, and a blank tab icon.
 *
 * The invariant: /favicon.ico is the same image the dashboard declares, served as an image.
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
let proc, BASE;
const DATA_DIR = path.join(os.tmpdir(), 'st-favicon-' + crypto.randomBytes(4).toString('hex'));

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const logFd = fs.openSync(DATA_DIR + '.log', 'w');
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(port), NODE_ENV: 'test' }, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot');
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

test('/favicon.ico is the product icon', async () => {
  const r = await fetch(BASE + '/favicon.ico');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /^image\/png/);
  const got = Buffer.from(await r.arrayBuffer());
  const want = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'assets', 'icon-192.png'));
  assert.deepEqual(got, want);
  assert.match(r.headers.get('cache-control') || '', /max-age=\d+/, 'and cacheable, it is asked for on every page');
});
