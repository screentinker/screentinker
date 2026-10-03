'use strict';

/*
 * #329: the dashboard should not have to ASK whether this server has a mesh.
 *
 * The mesh routers mount conditionally. To find out, the client called them and read the 404:
 * GET /mesh/capabilities then /mesh/nodes on every sidebar render, plus /mesh/orgs on every /me
 * refresh, plus /mesh/alerts and /mesh/uptime whenever those views opened. On an install with no
 * mesh — very nearly all of them — that is a steady trickle of 404s in every operator's console,
 * for a fact the server settled at boot.
 *
 * /me now states it. These tests pin the shape the client reads, and that it tells the truth in
 * the default (no mesh) configuration.
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
const DATA_DIR = path.join(os.tmpdir(), 'st-meshcap-' + crypto.randomBytes(4).toString('hex'));
let proc;

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(path.join(os.tmpdir(), 'st-meshcap.log'), 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot');
  const email = 'm' + crypto.randomBytes(4).toString('hex') + '@x.local';
  jwt = (await (await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Passw0rd123' }),
  })).json()).token;
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

const me = async () => (await fetch(BASE + '/api/auth/me', { headers: { Authorization: 'Bearer ' + jwt } })).json();

test('/me carries the mesh capability as two booleans', async () => {
  const body = await me();
  assert.ok(body.mesh, '/me must carry a mesh object');
  assert.equal(typeof body.mesh.enroll, 'boolean', 'enroll is a boolean, never undefined');
  assert.equal(typeof body.mesh.hub, 'boolean', 'hub is a boolean, never undefined');
});

test('with no mesh configured it reports false for both', async () => {
  const body = await me();
  assert.equal(body.mesh.enroll, false);
  assert.equal(body.mesh.hub, false);
});

test('and it tells the TRUTH: the routes it denies really are unmounted', async () => {
  // The whole point is that the client can trust this instead of probing. If the flag ever
  // disagreed with what is mounted, the client would hide a working section — or keep 404ing.
  const body = await me();
  assert.equal(body.mesh.hub, false, 'precondition: default config is not a hub');
  for (const url of ['/api/mesh/orgs', '/api/mesh/nodes', '/api/mesh/alerts', '/api/mesh/uptime']) {
    const r = await fetch(BASE + url, { headers: { Authorization: 'Bearer ' + jwt } });
    assert.equal(r.status, 404, `${url} must be absent when mesh.hub is false`);
  }
  assert.equal(body.mesh.enroll, false, 'precondition: enrollment is off too');
  const cap = await fetch(BASE + '/api/mesh/capabilities', { headers: { Authorization: 'Bearer ' + jwt } });
  assert.equal(cap.status, 404, '/capabilities must be absent when mesh.enroll is false');
});

test('the client treats a missing flag as "unknown", not "off"', () => {
  // An older server, or a user cached before this shipped, says nothing either way — and a silent
  // false there would hide the Servers nav on a real mesh node. api.js must return null, and every
  // caller must compare against an explicit boolean rather than testing truthiness.
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'api.js'), 'utf8');
  assert.match(src, /typeof u\.mesh\[which\] !== 'boolean'\) return null/, 'unknown -> null');

  for (const f of ['js/app.js', 'js/views/activity.js', 'js/views/reports.js']) {
    const view = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', f), 'utf8');
    assert.match(view, /meshCapability\(/, `${f} should consult the capability`);
    // The failure mode this guards is treating null as off. Forbid the two shapes that do it —
    // the result may be read via a variable, so this checks the truthy TEST, not the call site.
    assert.doesNotMatch(view, /if\s*\(\s*!?\s*meshCapability\([^)]*\)\s*\)/,
      `${f}: meshCapability() used as a bare truthy test — null would read as "no mesh"`);
  }
});
