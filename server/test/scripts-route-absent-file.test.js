'use strict';

/*
 * A DEPLOYMENT FILE THAT IS NOT THERE IS A PLAIN 404.
 *
 * /scripts/ serves a fixed list of names without sign-in. Some are in the repository; the
 * BrightSign archives are supplied by the deployment and are absent on most instances. Asking for
 * an absent one answered 404, but through the framework's error path, which printed the whole
 * ENOENT error object to the server log: eight lines per request, from anyone, forever (a
 * provisioning player retries).
 *
 * The invariant: an allowed name with no file behind it is a 404 with a short text body and
 * nothing written to the log; a file that is there is served as before.
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
const DATA_DIR = path.join(os.tmpdir(), 'st-scripts404-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
const SCRIPTS = path.join(__dirname, '..', '..', 'scripts');
const ABSENT = ['autorun.zip', 'autorun-server.zip', 'server-payload.zip', 'server-payload.json'].filter((n) => !fs.existsSync(path.join(SCRIPTS, n)));

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const logFd = fs.openSync(LOG, 'w');
  // Not NODE_ENV=test: that silences the framework's error logging, which is the thing under test.
  const env = { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(port) };
  delete env.NODE_ENV;
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

test('an allowed name with no file is a short 404 and leaves the log alone', async (t) => {
  if (!ABSENT.length) return t.skip('this checkout holds every deployment archive');
  for (const name of ABSENT) {
    const r = await fetch(`${BASE}/scripts/${name}`);
    assert.equal(r.status, 404, name);
    const body = await r.text();
    assert.ok(body.length < 100 && !/ENOENT|\/scripts\//.test(body), `${name}: a short body with no path in it, got ${body.slice(0, 80)}`);
    assert.match(r.headers.get('content-type') || '', /text\/plain/, 'typed as text, not as the archive it is not');
  }
  await sleep(300);
  assert.doesNotMatch(fs.readFileSync(LOG, 'utf8'), /ENOENT/, 'nothing about it in the server log');
});

test('a script that is there is still served, and an unknown name is still refused', async () => {
  const ok = await fetch(BASE + '/scripts/raspberry-pi-setup.sh');
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type') || '', /text\/plain/);
  assert.match(await ok.text(), /^#!/);
  assert.equal((await fetch(BASE + '/scripts/upgrade.sh')).status, 404);
});
