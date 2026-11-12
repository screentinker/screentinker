'use strict';

/*
 * THE FIRMWARE INSTALLER LOADS FROM EVERY URL IT IS LINKED BY.
 *
 * frontend/flash/index.html refers to its own files relatively: the vendored installer module
 * (vendor/esp-web-tools/install-button.js) and one manifest per board (./manifest_*.json). A
 * relative reference resolves against the page's URL, so the page only works when its URL ends in
 * a slash. Served as-is at /flash, the browser asks for /vendor/... and /manifest_*.json, gets
 * 404, the install button never becomes an element, and the page looks perfectly normal while
 * doing nothing.
 *
 * The invariant: whatever URL a visitor arrives by, the page they end up on resolves its own
 * module and manifests to files that exist.
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
const DATA_DIR = path.join(os.tmpdir(), 'st-flashurl-' + crypto.randomBytes(4).toString('hex'));
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

/** Follow redirects the way a browser does and report the URL the page finally lives at. */
async function land(startPath) {
  const res = await fetch(BASE + startPath, { redirect: 'follow' });
  return { status: res.status, url: res.url, html: await res.text() };
}

for (const entry of ['/flash', '/flash/', '/flash?board=sticky']) {
  test(`arriving at ${entry}, the page's own module and manifests resolve to real files`, async () => {
    const page = await land(entry);
    assert.equal(page.status, 200, 'the installer page is served');
    const refs = new Set();
    const mod = /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(page.html);
    assert.ok(mod, 'the page loads the installer module');
    refs.add(mod[1]);
    for (const m of page.html.matchAll(/<option value="(manifest_[a-z0-9_]+\.json)"/g)) refs.add('./' + m[1]);
    assert.ok(refs.size > 3, 'found the module and the board manifests');
    for (const ref of refs) {
      const abs = new URL(ref, page.url);
      const r = await fetch(abs);
      assert.equal(r.status, 200, `${ref} resolves to ${abs.pathname}, which must exist`);
    }
  });
}

test('the query string survives the trip, so a deep link keeps its board', async () => {
  const page = await land('/flash?board=sticky');
  assert.equal(new URL(page.url).search, '?board=sticky');
});
