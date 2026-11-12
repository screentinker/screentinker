'use strict';

/*
 * A PLAYER DOWNLOAD NEVER SENDS ANYONE OFF THE INSTANCE.
 *
 * Every player this product ships is downloaded from the instance that will manage it: the
 * /download hub lists what this instance holds, each with its checksum, and the build it serves
 * is the build this server version expects. A source-hosting release page is none of those
 * things: it lists every platform's raw artifacts for every version, with no link back to the
 * instance the screen has to pair with.
 *
 * /download/apk on an instance that holds no APK is the one place a visitor can end up with
 * nothing to download. The invariant: the page it shows keeps them on the instance (the download
 * hub and the web player), and no served download page links a release listing.
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
const DATA_DIR = path.join(os.tmpdir(), 'st-noapk-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
});

after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

const RELEASE_LISTING = /github\.com\/[^"'\s]+\/releases/i;

test('with no APK held, /download/apk says so and keeps the visitor on this instance', async (t) => {
  const r = await fetch(BASE + '/download/apk');
  if (r.status !== 404) return t.skip('this checkout holds a built APK, so there is no empty page to check');
  const html = await r.text();
  assert.doesNotMatch(html, RELEASE_LISTING, 'no link to a release listing');
  assert.match(html, /href="\/download"/, 'it offers the download hub of this instance');
  assert.match(html, /href="\/player"/, 'and the web player, which needs no download');
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    assert.ok(m[1].startsWith('/'), `every link stays on the instance, found ${m[1]}`);
  }
});

test('the download hub itself links no release listing', async () => {
  const html = await (await fetch(BASE + '/download')).text();
  assert.doesNotMatch(html, RELEASE_LISTING);
});

test('no page the server writes inline links a release listing as a download', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const hits = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /href="https:\/\/github\.com\/[^"]+\/releases/i.test(l));
  assert.deepEqual(hits.map(([n]) => n), [], 'server.js lines linking a release listing');
});
