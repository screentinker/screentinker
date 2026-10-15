'use strict';

/*
 * An upgrade owns node_modules while it runs (prod, 2026-10-15).
 *
 * Installing Node 22 let apt's needrestart restart ScreenTinker in the middle of scripts/upgrade.sh.
 * The half-installed server's dependency preflight then ran npm itself, alongside the upgrade's
 * `npm ci`, and the two left stripe and apache-arrow files out of node_modules: the server came up,
 * and billing failed. Two guards, tested here: upgrade.sh keeps needrestart from restarting anything
 * during its apt runs, and the preflight waits while an upgrade's marker is live.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { upgradeInProgress, waitForUpgrade } = require('../lib/preflight-deps');

const UPGRADE = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'upgrade.sh'), 'utf8');

function marker(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-upg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, '.upgrade-in-progress');
  if (body !== undefined) fs.writeFileSync(f, body);
  return f;
}
const now = () => Math.floor(Date.now() / 1000);

test('upgradeInProgress: only a live, recent marker counts', (t) => {
  assert.equal(upgradeInProgress(marker(t)), null, 'no marker');
  assert.deepEqual(upgradeInProgress(marker(t, `${process.pid} ${now()} v3.0.1\n`)),
    { pid: process.pid, since: now(), tag: 'v3.0.1' });
  // A pid that cannot exist: the upgrade that wrote it was killed, so the marker is stale.
  assert.equal(upgradeInProgress(marker(t, `2147483646 ${now()} v3.0.1\n`)), null, 'dead pid');
  assert.equal(upgradeInProgress(marker(t, `${process.pid} ${now() - 3 * 3600} v3.0.1\n`)), null, 'older than 2 h');
  assert.equal(upgradeInProgress(marker(t, 'garbage\n')), null, 'unreadable');
  assert.equal(upgradeInProgress(marker(t, '')), null, 'empty');
});

test('waitForUpgrade returns at once without a marker', (t) => {
  const t0 = Date.now();
  waitForUpgrade(marker(t), 60000);
  assert.ok(Date.now() - t0 < 500);
});

test('waitForUpgrade holds the start until the upgrade removes its marker', (t) => {
  const f = marker(t, `${process.pid} ${now()} v3.0.1\n`);
  // Another process plays upgrade.sh: it finishes and removes the marker after a second.
  const child = spawn('sh', ['-c', `sleep 1; rm -f '${f}'`], { stdio: 'ignore', detached: true });
  child.unref();
  const t0 = Date.now();
  waitForUpgrade(f, 20000);
  const waited = Date.now() - t0;
  assert.ok(waited >= 900, `waited ${waited} ms, so it did wait`);
  assert.ok(waited < 6000, `waited ${waited} ms, so it noticed the marker go`);
  assert.equal(fs.existsSync(f), false);
});

test('waitForUpgrade gives up after its limit, so a server is never held for ever', (t) => {
  const t0 = Date.now();
  waitForUpgrade(marker(t, `${process.pid} ${now()} v3.0.1\n`), 300);
  assert.ok(Date.now() - t0 < 3000);
});

test('upgrade.sh keeps needrestart from restarting services during its apt runs', () => {
  const line = UPGRADE.split('\n').find((l) => l.startsWith('apt_get() {'));
  assert.ok(line, 'one apt_get helper');
  assert.match(line, /NEEDRESTART_MODE=l\b/);
  assert.match(line, /NEEDRESTART_SUSPEND=1\b/);
  // Every apt-get the script runs goes through the helper.
  // (Only lines that RUN it: `command -v apt-get`, messages and the history string just mention it.)
  const direct = UPGRADE.split('\n').filter((l) => /\bapt-get\s+(-\S+\s+)*(install|update|upgrade|dist-upgrade|full-upgrade)\b/.test(l)
    && !l.startsWith('apt_get() {') && !/^\s*#/.test(l) && !/\becho\b|HOST_CHANGES=/.test(l));
  assert.deepEqual(direct, [], 'apt-get called without the helper');
});

test('upgrade.sh marks the install before Node and npm, and clears it before its own restart', () => {
  const write = UPGRADE.indexOf('> "$UPGRADE_MARKER"');
  const nodeStep = UPGRADE.indexOf('STEP="checking the Node version');
  const npm = UPGRADE.indexOf('( cd server && npm ci --omit=dev )');
  const clear = UPGRADE.lastIndexOf('rm -f "$UPGRADE_MARKER"');
  const restart = UPGRADE.indexOf('STEP="restarting the server"');
  assert.ok(write > 0 && write < nodeStep && nodeStep < npm && npm < clear && clear < restart,
    'marker, then Node, then npm ci, then cleared, then the restart');
  assert.match(UPGRADE, /server\/\.upgrade-in-progress/, 'the path the preflight reads');
  assert.match(UPGRADE, /trap '[^']*rm -f "\$UPGRADE_MARKER"' EXIT/, 'removed on every exit, refusals and rollbacks too');
});
