'use strict';

// Opt-in install statistics. The promises this feature makes are all negative ones — it does not
// send until asked, it does not send more than three fields, it does not ask twice — and a
// negative promise is exactly the kind that rots silently. These bites pin each one.

const { test, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-'));
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = 'test';

const { db } = require('../db/database');
const appSettings = require('../lib/app-settings');
const telemetry = require('../lib/telemetry');

after(() => { telemetry.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

function reset() {
  db.prepare('DELETE FROM app_settings').run();
  appSettings.__reload();
}

test('an install that has not been asked reports nothing', async () => {
  reset();
  assert.equal(telemetry.state(), 'unasked');

  const spy = mock.method(globalThis, 'fetch', async () => { throw new Error('must not be called'); });
  try {
    const r = await telemetry.report(db);
    assert.deepEqual(r, { sent: false, reason: 'not_enabled' });
    assert.equal(spy.mock.callCount(), 0, 'no outbound request may be made before consent');
  } finally { spy.mock.restore(); }
});

test('declining is remembered, so the prompt does not return after an update', () => {
  reset();
  telemetry.setEnabled(false);
  assert.equal(telemetry.state(), 'off', 'a decline must persist as off, never fall back to unasked');
  appSettings.__reload();                       // survives a restart
  assert.equal(telemetry.state(), 'off');
});

test('a declined install still reports nothing', async () => {
  reset();
  telemetry.setEnabled(false);
  const spy = mock.method(globalThis, 'fetch', async () => { throw new Error('must not be called'); });
  try {
    assert.deepEqual(await telemetry.report(db), { sent: false, reason: 'not_enabled' });
    assert.equal(spy.mock.callCount(), 0);
  } finally { spy.mock.restore(); }
});

test('the payload is exactly three fields, and no more', async () => {
  reset();
  const body = telemetry.payload(db);
  assert.deepEqual(Object.keys(body).sort(), ['instance_id', 'screen_count', 'version'],
    'adding a field here is a privacy decision, not a refactor — it must fail this test first');
  assert.match(body.instance_id, /^[0-9a-f-]{36}$/i);
  assert.equal(typeof body.version, 'string');
  assert.equal(typeof body.screen_count, 'number');
});

test('the instance id is stable across reads and restarts', () => {
  reset();
  const first = telemetry.instanceId();
  assert.equal(telemetry.instanceId(), first, 'must not mint a new id per call');
  appSettings.__reload();
  assert.equal(telemetry.instanceId(), first, 'must survive a restart, or every install counts twice');
});

test('screen_count counts paired displays, not provisioning rows', () => {
  reset();
  db.prepare('DELETE FROM devices').run();
  const ins = db.prepare("INSERT INTO devices (id, name, pairing_code, device_token, status) VALUES (?, ?, ?, ?, 'offline')");
  ins.run('d1', 'One', '111111', 'tok1');
  ins.run('d2', 'Two', '222222', 'tok2');
  // Never paired: a provisioning row nobody connected is not a deployed screen.
  db.prepare("INSERT INTO devices (id, name, pairing_code, device_token, status) VALUES ('d3','Three','333333',NULL,'offline')").run();

  assert.equal(telemetry.payload(db).screen_count, 2);
  db.prepare('DELETE FROM devices').run();
});

test('when enabled it sends exactly the payload, and records what it sent', async () => {
  reset();
  telemetry.setEnabled(true);

  let seen = null;
  const spy = mock.method(globalThis, 'fetch', async (url, opts) => {
    seen = { url, body: JSON.parse(opts.body), method: opts.method };
    return { ok: true, status: 200 };
  });
  try {
    const r = await telemetry.report(db, { endpoint: 'https://example.test/report' });
    assert.equal(r.sent, true);
    assert.equal(seen.method, 'POST');
    assert.equal(seen.url, 'https://example.test/report');
    assert.deepEqual(Object.keys(seen.body).sort(), ['instance_id', 'screen_count', 'version'],
      'the bytes on the wire must match the audited payload, not a superset');

    // An operator can check rather than trust: what was sent is retrievable verbatim.
    const last = telemetry.getLastReport();
    assert.deepEqual(last.body, seen.body);
    assert.equal(typeof last.at, 'number');
  } finally { spy.mock.restore(); }
});

test('a failed send is quiet and local — never throws, never records a phantom report', async () => {
  reset();
  telemetry.setEnabled(true);
  const spy = mock.method(globalThis, 'fetch', async () => { throw new Error('ECONNREFUSED'); });
  try {
    const r = await telemetry.report(db, { endpoint: 'https://example.test/report' });
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'network');
    assert.equal(telemetry.getLastReport(), null, 'a failed send must not look like a successful one');
  } finally { spy.mock.restore(); }

  // An HTTP error is likewise not a success.
  const spy2 = mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));
  try {
    const r = await telemetry.report(db, { endpoint: 'https://example.test/report' });
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'http_503');
    assert.equal(telemetry.getLastReport(), null);
  } finally { spy2.mock.restore(); }
});
