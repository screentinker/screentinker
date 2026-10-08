'use strict';

/*
 * Health-checked player rollouts (lib/ota-rollout.js), and the update routes that consult them.
 *
 *   - a new stable version opens to a stable ~10% wave first; a screen's wave never changes
 *   - beta and forced checks skip the waves
 *   - a healthy wave opens the next after its soak; a bad one HALTS (nobody else is offered it)
 *   - a site-wide outage (the rest of the fleet dark too) is not read as a bad release
 *   - on Pi/Windows a halt ROLLS BACK: the screens on the bad version are offered the archived
 *     previous package, past the breaker, and the install helper's anonymous lookup announces it
 *   - on Android a halt only stops the spread (no downgrade exists)
 *   - pause / resume / release / halt / clear
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const DATA = path.join(os.tmpdir(), 'st-otaroll-' + crypto.randomBytes(4).toString('hex'));
process.env.DATA_DIR = DATA;
process.env.OTA_ROLLOUT_SOAK_MIN = '60';
delete process.env.OTA_STAGED_ROLLOUT;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { db } = require('../db/database');
const R = require('../lib/ota-rollout');

let NOW = 2_000_000_000_000;
R._setClock(() => NOW);
const sec = () => Math.floor(NOW / 1000);

function pkgFile(version) {
  const dir = path.join(DATA, 'dist');
  fs.mkdirSync(dir, { recursive: true });
  const name = `screentinker-pi_${version}_all.deb`;
  const p = path.join(dir, name);
  fs.writeFileSync(p, `deb-${version}`);
  return { exists: true, path: p, filename: name, version, size: fs.statSync(p).size, sha256: crypto.createHash('sha256').update(`deb-${version}`).digest('hex') };
}
const pi = (id, ver, status = 'online') => db.prepare(`INSERT INTO devices (id, name, pairing_code, client_type, platform, app_version, status, last_heartbeat)
  VALUES (?, ?, ?, 'pi', 'Linux/Pi OS', ?, ?, ?)`).run(id, id, id.slice(-6), ver, status, sec());
const upgrade = (id, from, to) => {
  db.prepare("INSERT INTO device_events (device_id, type, reason, detail, timestamp) VALUES (?, 'upgrade', 'upgrade', ?, ?)").run(id, `${from} → ${to}`, sec());
  db.prepare('UPDATE devices SET app_version = ? WHERE id = ?').run(to, id);
};

const FLEET = Array.from({ length: 20 }, (_, i) => `pi-${String(i).padStart(2, '0')}`);
before(() => { for (const id of FLEET) pi(id, '1.0.0'); });

let current = null;
const fakeCache = { get: () => current };

test('waves: about 10% first, stable per screen; beta and forced skip it', () => {
  pkgFile('1.0.0');                               // 1.0.0 is the release everyone runs
  R.gate('pi', pkgFile('1.0.0'), {});             // seen first, so 1.0.1 has something to go back to
  db.prepare("UPDATE ota_rollouts SET status = 'complete' WHERE version = '1.0.0'").run();
  current = pkgFile('1.0.1');
  const offered = FLEET.filter((id) => R.gate('pi', current, { deviceId: id, currentVersion: '1.0.0' }).action === 'offer');
  assert.equal(offered.length, 2, '10% of 20');
  assert.deepEqual(FLEET.filter((id) => R.gate('pi', current, { deviceId: id }).action === 'offer'), offered, 'the same screens every time');
  const waiting = FLEET.find((id) => !offered.includes(id));
  assert.equal(R.gate('pi', current, { deviceId: waiting, forced: true }).action, 'offer');
  assert.equal(R.gate('pi', current, { deviceId: waiting, beta: true }).action, 'offer');
  const row = db.prepare("SELECT * FROM ota_rollouts WHERE version = '1.0.1'").get();
  assert.equal(row.prev_version, '1.0.0');
});

test('a healthy wave opens the next after its soak; then everyone', async () => {
  const row = () => db.prepare("SELECT * FROM ota_rollouts WHERE version = '1.0.1'").get();
  const wave0 = FLEET.filter((id) => R.gate('pi', current, { deviceId: id }).action === 'offer');
  for (const id of wave0) upgrade(id, '1.0.0', '1.0.1');
  await R.tick(db);
  assert.equal(row().wave, 0, 'not before the soak');
  NOW += 61 * 60 * 1000;
  for (const id of FLEET) db.prepare('UPDATE devices SET last_heartbeat = ? WHERE id = ?').run(sec(), id);
  await R.tick(db);
  assert.equal(row().wave, 1);
  assert.equal(FLEET.filter((id) => R.gate('pi', current, { deviceId: id }).action === 'offer').length, 10, '50%');
});

test('a bad wave HALTS; nobody else is offered it, and Pi screens that took it are sent back', async () => {
  const wave1 = FLEET.filter((id) => R.gate('pi', current, { deviceId: id }).action === 'offer');
  const fresh = wave1.filter((id) => db.prepare('SELECT app_version v FROM devices WHERE id = ?').get(id).v === '1.0.0');
  for (const id of fresh) {
    upgrade(id, '1.0.0', '1.0.1');
    db.prepare("INSERT INTO device_events (device_id, type, reason, timestamp) VALUES (?, 'offline', 'crashed', ?), (?, 'offline', 'crashed', ?)").run(id, sec() + 5, id, sec() + 30);
  }
  NOW += 5 * 60 * 1000;
  const out = await R.tick(db);
  assert.equal(out[0] && out[0].action, 'halted', JSON.stringify(out));
  const g = R.gate('pi', current, { deviceId: FLEET[19] });
  assert.equal(g.action, 'rollback');
  assert.equal(g.release.version, '1.0.0');
  assert.ok(fs.existsSync(g.release.path), 'the previous package was archived when its rollout began');
  assert.equal(R.list(db).find((r) => r.version === '1.0.1').can_roll_back, true);
});

test('the Pi update route: rollback offer past the breaker, the archived download, and the helper lookup', async () => {
  const { createNativeUpdateRoutes } = require('../routes/native-update');
  const app = express();
  createNativeUpdateRoutes({ kind: 'pi', cache: fakeCache, label: 'pkg', contentType: 'application/octet-stream', missingReason: 'deb-missing', hashingReason: 'deb-hashing', anonymousLookup: true })(app, { db, getBand: () => 'ok' });
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const onBad = db.prepare("SELECT id FROM devices WHERE app_version = '1.0.1'").get().id;
    const r = await (await fetch(`${base}/api/pi/update/check?version=1.0.1&device_id=${onBad}`)).json();
    assert.equal(r.update_available, true, JSON.stringify(r));
    assert.equal(r.reason, 'rollback');
    assert.equal(r.latest_version, '1.0.0');
    const prev = pkgFile('1.0.0');
    assert.equal(r.sha256, prev.sha256);
    const dl = await fetch(base + r.download_url);
    assert.equal(dl.status, 200);
    assert.equal(await dl.text(), 'deb-1.0.0', 'the archived previous package is what is served');
    // The install helper verifies against an anonymous lookup: it must announce the rollback package.
    const helper = await (await fetch(`${base}/api/pi/update/check?version=0.0.0&forced=1`)).json();
    assert.equal(helper.sha256, prev.sha256);
    const stillOld = db.prepare("SELECT id FROM devices WHERE app_version = '1.0.0'").get().id;
    const o = await (await fetch(`${base}/api/pi/update/check?version=1.0.0&device_id=${stillOld}`)).json();
    assert.equal(o.update_available, false, 'a screen on the previous version is left alone');
    assert.equal((await fetch(`${base}/download/pi?version=0.9.0`)).status, 404, 'no other old version is served');
  } finally { srv.close(); }
});

test('a site-wide outage is not a bad release', async () => {
  NOW += 3600 * 1000;
  const v = '1.0.2';
  current = pkgFile(v);
  R.gate('pi', current, {});
  const row = db.prepare('SELECT * FROM ota_rollouts WHERE version = ?').get(v);
  const wave0 = FLEET.filter((id) => R.gate('pi', current, { deviceId: id }).action === 'offer');
  for (const id of wave0) upgrade(id, db.prepare('SELECT app_version v FROM devices WHERE id = ?').get(id).v, v);
  NOW += 20 * 60 * 1000;
  // Everyone goes dark together (the site lost power): updated or not.
  db.prepare("UPDATE devices SET status = 'offline', last_heartbeat = ?").run(sec() - 16 * 60);
  const h = R.health(db, row);
  assert.equal(h.bad, h.updated);
  assert.equal(R.verdict(h), null, 'the rest of the fleet is just as dark');
});

test('Android: a halt stops the spread and never offers a rollback', () => {
  db.prepare("INSERT INTO devices (id, name, pairing_code, client_type, app_version, status) VALUES ('and-1', 'a', 'a1', 'apk', '2.4.3', 'online')").run();
  const apk = { exists: true, version: '2.4.4', path: '/x.apk', filename: 'x.apk', sha256: 'aa', size: 1 };
  R.gate('android', apk, {});
  R.act(db, 'android', '2.4.4', 'halt', { by: 't' });
  assert.equal(R.gate('android', apk, { deviceId: 'and-1' }).action, 'halted');
});

test('admin actions: pause, resume, release, halt, clear — with state checks', () => {
  const v = '1.0.2';
  assert.equal(R.act(db, 'pi', v, 'pause').ok, true);
  assert.equal(R.gate('pi', current, { deviceId: FLEET[0], currentVersion: '1.0.0' }).action, 'wait');
  assert.equal(R.act(db, 'pi', v, 'pause').status, 409);
  assert.equal(R.act(db, 'pi', v, 'resume').ok, true);
  assert.equal(R.act(db, 'pi', v, 'release').ok, true);
  assert.ok(FLEET.every((id) => R.gate('pi', current, { deviceId: id }).action === 'offer'), 'released to everyone');
  assert.equal(R.act(db, 'pi', v, 'halt').ok, true);
  assert.equal(R.act(db, 'pi', v, 'clear').ok, true);
  assert.equal(R.act(db, 'pi', 'nope', 'pause').status, 404);
  const listed = R.list(db).find((r) => r.version === v);
  assert.equal(listed.status, 'rolling');
});

test('OTA_STAGED_ROLLOUT=off restores the old behaviour', () => {
  process.env.OTA_STAGED_ROLLOUT = 'off';
  try { assert.equal(R.gate('pi', pkgFile('9.9.9'), { deviceId: FLEET[5] }).action, 'offer'); }
  finally { delete process.env.OTA_STAGED_ROLLOUT; }
});
