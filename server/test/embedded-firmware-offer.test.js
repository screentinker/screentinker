'use strict';

/*
 * A firmware offer (`X-ST-Command: update <url> <sha256>`) only ever names THIS server's binary for
 * the panel's preset, with that file's digest. A caller-supplied URL + hash in the queued payload
 * was honoured before (#638 review): "flash what this URL serves, here is its hash" is code
 * execution on the panel with an integrity check the caller wrote. Real schema (db/database.js).
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const fwRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-fw-offer-'));
const h = require('./helpers/embedded-real-db').boot({ firmwareDir: fwRoot });
const queue = require('../lib/command-queue');
const otaBreaker = require('../lib/ota-breaker');

after(async () => { queue._resetForTests(); await h.close(); fs.rmSync(fwRoot, { recursive: true, force: true }); });

const FW = Buffer.alloc(4096, 0x5a);
const FW_SHA = crypto.createHash('sha256').update(FW).digest('hex');
function stageFirmware(preset, versionJson) {
  const dir = path.join(fwRoot, preset);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'firmware.bin'), FW);
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify(versionJson));
}

async function poll(base, panel, headers = {}) {
  return fetch(`${base}/render?device_id=${panel.id}`, { headers: { Authorization: `Bearer ${panel.token}`, 'X-ST-Firmware-Version': '1.0.0', ...headers } });
}

test('a caller-supplied firmware URL and hash are never emitted: the offer is the server\'s own binary', async () => {
  const base = await h.ready();
  stageFirmware('seeed_reterminal_e1001', { version: '9.9.9' });
  const panel = await h.mkPanel('seeed-reterminal-e1001');
  otaBreaker.reset();

  const evilSha = 'f'.repeat(64);
  queue.queueCommand(panel.id, 'update', { url: 'http://evil.example/fw.bin', sha256: evilSha, version: '9.9.9' });
  let res = await poll(base, panel);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-st-command'), `update /api/embedded/firmware/seeed_reterminal_e1001/latest.bin ${FW_SHA}`);

  queue.queueCommand(panel.id, 'update', { binary_url: 'https://evil.example/other.bin', sha256: evilSha });
  res = await poll(base, panel);
  const cmd = res.headers.get('x-st-command') || '';
  assert.ok(!cmd.includes('evil.example'), `custom URL leaked into the offer: ${cmd}`);
  assert.ok(!cmd.includes(evilSha), 'the caller\'s digest leaked into the offer');
});

test('no firmware on disk for the preset: a custom URL does not stand in for it', async () => {
  const base = await h.ready();
  const panel = await h.mkPanel('seeed-reterminal-e1002');   // nothing staged for e1002
  otaBreaker.reset();
  queue.queueCommand(panel.id, 'update', { url: 'http://evil.example/fw.bin', sha256: 'a'.repeat(64), version: '9.9.9' });
  const res = await poll(base, panel);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-st-command'), null);
  assert.deepEqual(queue.peekPendingCommands(panel.id), [], 'the unofferable update was dropped, not left to re-run');
});

test('a binary that does not match its version.json sha256 is not offered', async () => {
  const base = await h.ready();
  stageFirmware('seeed_reterminal_e1003', { version: '9.9.9', sha256: 'b'.repeat(64) });
  const panel = await h.mkPanel('seeed-reterminal-e1003');
  otaBreaker.reset();
  queue.queueCommand(panel.id, 'update', {});
  const res = await poll(base, panel);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-st-command'), null);

  // The matching digest is offered.
  stageFirmware('seeed_reterminal_e1003', { version: '9.9.9', sha256: FW_SHA });
  queue.queueCommand(panel.id, 'update', {});
  const ok = await poll(base, panel);
  assert.equal(ok.headers.get('x-st-command'), `update /api/embedded/firmware/seeed_reterminal_e1003/latest.bin ${FW_SHA}`);
});
