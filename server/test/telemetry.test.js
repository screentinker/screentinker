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
    assert.equal(r.sent, false); assert.equal(r.reason, 'not_enabled');
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
    const d = await telemetry.report(db); assert.equal(d.sent, false); assert.equal(d.reason, 'not_enabled');
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
    const r = await telemetry.report(db, { urls: [{ url: 'https://example.test/report', kind: 'screentinker' }] });
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

test('a blocked outbound connection is recorded, with the address that was blocked', async () => {
  // Egress filtering is the normal failure on a self-hosted box and is otherwise invisible: the
  // operator sees nothing arriving and cannot tell a firewall from a broken feature. The UI can
  // only name the host to allowlist if the failure is recorded here.
  reset();
  telemetry.setEnabled(true);
  const spy = mock.method(globalThis, 'fetch', async () => { throw new Error('ECONNREFUSED'); });
  try {
    await telemetry.report(db, { urls: [{ url: 'https://stats.example.test/report', kind: 'screentinker' }] });
    const err = telemetry.getLastError();
    assert.ok(err, 'a failed attempt must be recorded, or the operator has nothing to act on');
    assert.equal(err.reason, 'network');
    assert.equal(err.url, 'https://stats.example.test/report', 'must record the address actually tried');
    assert.equal(typeof err.at, 'number');
  } finally { spy.mock.restore(); }
});

test('a later success clears the stale failure', async () => {
  reset();
  telemetry.setEnabled(true);
  const bad = mock.method(globalThis, 'fetch', async () => { throw new Error('ECONNREFUSED'); });
  try { await telemetry.report(db, { urls: [{ url: 'https://example.test/report', kind: 'screentinker' }] }); } finally { bad.mock.restore(); }
  assert.ok(telemetry.getLastError(), 'precondition: a failure was recorded');

  const good = mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200 }));
  try {
    await telemetry.report(db, { urls: [{ url: 'https://example.test/report', kind: 'screentinker' }] });
    assert.equal(telemetry.getLastError(), null,
      'a stale firewall warning must not outlive the problem it describes');
  } finally { good.mock.restore(); }
});

test('an operator collector is ADDITIONAL — it never replaces the shared report', async () => {
  // The whole point of naming it EXTRA rather than ENDPOINT: configuring your own collector must
  // not silently redirect the report the operator agreed to share. If this ever becomes a
  // redirect, the opt-in stops meaning what the UI says it means.
  reset();
  telemetry.setEnabled(true);
  const original = process.env.TELEMETRY_EXTRA_ENDPOINT;
  process.env.TELEMETRY_EXTRA_ENDPOINT = 'https://mine.example.test/collect';
  try {
    const dests = telemetry.destinations();
    assert.equal(dests.length, 2, 'sharing on + own collector = both, never one');
    assert.deepEqual(dests.map(d => d.kind).sort(), ['extra', 'screentinker']);

    const hits = [];
    const spy = mock.method(globalThis, 'fetch', async (url) => { hits.push(url); return { ok: true, status: 200 }; });
    try {
      await telemetry.report(db);
      assert.equal(hits.length, 2, 'both destinations must receive the report');
      assert.ok(hits.includes('https://mine.example.test/collect'));
      assert.ok(hits.some(u => u.includes('screentinker.com')), 'the shared report must still be sent');
    } finally { spy.mock.restore(); }
  } finally {
    if (original === undefined) delete process.env.TELEMETRY_EXTRA_ENDPOINT;
    else process.env.TELEMETRY_EXTRA_ENDPOINT = original;
  }
});

test('an operator can keep their own statistics while sharing nothing with us', async () => {
  // Someone who wants internal fleet numbers but nothing leaving for us sets their own collector
  // and leaves sharing off. Supported on purpose: it is their server posting to their host.
  reset();
  telemetry.setEnabled(false);
  const original = process.env.TELEMETRY_EXTRA_ENDPOINT;
  process.env.TELEMETRY_EXTRA_ENDPOINT = 'https://mine.example.test/collect';
  try {
    const hits = [];
    const spy = mock.method(globalThis, 'fetch', async (url) => { hits.push(url); return { ok: true, status: 200 }; });
    try {
      await telemetry.report(db);
      assert.deepEqual(hits, ['https://mine.example.test/collect']);
      assert.ok(!hits.some(u => u.includes('screentinker.com')),
        'sharing is off — nothing may reach us, whatever else is configured');
    } finally { spy.mock.restore(); }
  } finally {
    if (original === undefined) delete process.env.TELEMETRY_EXTRA_ENDPOINT;
    else process.env.TELEMETRY_EXTRA_ENDPOINT = original;
  }
});

test('one unreachable destination does not stop the other', async () => {
  reset();
  telemetry.setEnabled(true);
  const spy = mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('broken')) throw new Error('ECONNREFUSED');
    return { ok: true, status: 200 };
  });
  try {
    const r = await telemetry.report(db, { urls: [
      { url: 'https://broken.example.test/a', kind: 'extra' },
      { url: 'https://working.example.test/b', kind: 'screentinker' },
    ] });
    assert.equal(r.results.filter(x => x.sent).length, 1, 'the reachable one still receives it');
    assert.equal(r.results.filter(x => !x.sent).length, 1);
    assert.equal(telemetry.getLastError().url, 'https://broken.example.test/a',
      'the failure names the destination that actually failed');
  } finally { spy.mock.restore(); }
});

test('a failed send is quiet and local — never throws, never records a phantom report', async () => {
  reset();
  telemetry.setEnabled(true);
  const spy = mock.method(globalThis, 'fetch', async () => { throw new Error('ECONNREFUSED'); });
  try {
    const r = await telemetry.report(db, { urls: [{ url: 'https://example.test/report', kind: 'screentinker' }] });
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'network');
    assert.equal(telemetry.getLastReport(), null, 'a failed send must not look like a successful one');
  } finally { spy.mock.restore(); }

  // An HTTP error is likewise not a success.
  const spy2 = mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));
  try {
    const r = await telemetry.report(db, { urls: [{ url: 'https://example.test/report', kind: 'screentinker' }] });
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'http_503');
    assert.equal(telemetry.getLastReport(), null);
  } finally { spy2.mock.restore(); }
});
