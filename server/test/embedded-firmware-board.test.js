'use strict';

/*
 * Firmware offers are tied to the board the panel reports (#638 review). Real schema.
 *
 * screentinker_mcu v1.3.0 sends no board header on its polls; the one thing it says about its
 * hardware is the compile-time preset it registers with (POST /pair/register screen_profile). That
 * is recorded as devices.reported_board, and a later firmware may state it per poll (X-ST-Preset).
 *   - a panel that reports a board is only offered that board's firmware;
 *   - a panel that reports none is still offered its screen profile's firmware, and the operator is
 *     told so (firmware.board_verified false) instead of "update triggered";
 *   - a panel this server has no firmware for is refused when the update is queued, with a reason,
 *     instead of "queued" followed by a silent drop on its next poll.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const fwRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-fw-board-'));
const FW = Buffer.alloc(2048, 0x33);
const FW_SHA = crypto.createHash('sha256').update(FW).digest('hex');
fs.mkdirSync(path.join(fwRoot, 'seeed_reterminal_e1001'));
fs.writeFileSync(path.join(fwRoot, 'seeed_reterminal_e1001', 'firmware.bin'), FW);
fs.writeFileSync(path.join(fwRoot, 'seeed_reterminal_e1001', 'version.json'), JSON.stringify({ version: '9.9.9' }));

const deviceNs = { adapter: { rooms: new Map() }, to: () => ({ emit() {} }) };
const h = require('./helpers/embedded-real-db').boot({
  firmwareDir: fwRoot,
  configure(app) {
    app.set('io', { of: (n) => (n === '/device' ? deviceNs : { to: () => ({ emit() {} }) }) });
    const { requireAuth } = require('../middleware/auth');
    app.use('/api/devices', requireAuth, require('../routes/devices'));
  },
});
const queue = require('../lib/command-queue');
const otaBreaker = require('../lib/ota-breaker');

after(async () => { queue._resetForTests(); await h.close(); fs.rmSync(fwRoot, { recursive: true, force: true }); });

const row = (id) => h.db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
async function command(base, id, type) {
  const api = base.replace('/api/embedded', '/api/devices');
  const res = await fetch(`${api}/${id}/command`, {
    method: 'POST', headers: { Authorization: `Bearer ${h.sessionToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type }),
  });
  return { status: res.status, body: await res.json() };
}
const poll = (base, p, headers = {}) => fetch(`${base}/render?device_id=${p.id}`, { headers: { Authorization: `Bearer ${p.token}`, 'X-ST-Firmware-Version': '1.0.0', ...headers } });

test('pairing records the preset the firmware registered with as the panel\'s reported board', async () => {
  const base = await h.ready();
  const res = await fetch(`${base}/pair/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ screen_profile: 'seeed-reterminal-e1004', screen_width: 1200, screen_height: 1600 }),
  });
  assert.equal(res.status, 200);
  const { device_id } = await res.json();
  assert.equal(row(device_id).reported_board, 'seeed_reterminal_e1004');

  // No profile sent: the server's Sticky default is not something the hardware said.
  const res2 = await fetch(`${base}/pair/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(row((await res2.json()).device_id).reported_board, null);
});

test('a panel this server has no firmware for is refused when update is queued, with the reason', async () => {
  const base = await h.ready();
  const p = await h.mkPanel('waveshare-7.5in-v2', { extra: { power_source: 'usb' } });
  const r = await command(base, p.id, 'update');
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'EMBEDDED_NO_FIRMWARE');
  assert.match(r.body.error, /no firmware/i);
  assert.deepEqual(queue.peekPendingCommands(p.id), [], 'not queued to be dropped later');
});

test('a panel that reports no board: queued, offered its profile\'s firmware, and the operator is told it is unverified', async () => {
  const base = await h.ready();
  const p = await h.mkPanel('seeed-reterminal-e1001', { extra: { power_source: 'usb' } });
  otaBreaker.reset();
  const r = await command(base, p.id, 'update');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'queued');
  assert.deepEqual(r.body.firmware, { preset: 'seeed_reterminal_e1001', version: '9.9.9', board_verified: false });
  const res = await poll(base, p);
  assert.equal(res.headers.get('x-st-command'), `update /api/embedded/firmware/seeed_reterminal_e1001/latest.bin ${FW_SHA}`);
});

test('a panel that reports a different board than its profile is refused at the door and never offered', async () => {
  const base = await h.ready();
  const p = await h.mkPanel('seeed-reterminal-e1001', { extra: { power_source: 'usb', reported_board: 'seeed_reterminal_e1002' } });
  const r = await command(base, p.id, 'update');
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'EMBEDDED_BOARD_MISMATCH');

  // Even if one reaches the queue some other way, the poll does not offer it.
  otaBreaker.reset();
  queue.queueCommand(p.id, 'update', {});
  const res = await poll(base, p);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-st-command'), null);
  assert.deepEqual(queue.peekPendingCommands(p.id), []);
});

test('a board stated per poll (X-ST-Preset) is checked and remembered', async () => {
  const base = await h.ready();
  const p = await h.mkPanel('seeed-reterminal-e1001', { extra: { power_source: 'usb' } });
  otaBreaker.reset();
  queue.queueCommand(p.id, 'update', {});
  const wrong = await poll(base, p, { 'X-ST-Preset': 'seeed-reterminal-e1003' });
  assert.equal(wrong.headers.get('x-st-command'), null, 'a stated mismatch is not offered');

  const ok = await poll(base, p, { 'X-ST-Preset': 'seeed-reterminal-e1001' });
  assert.equal(row(p.id).reported_board, 'seeed_reterminal_e1001');
  assert.equal(ok.headers.get('x-st-command'), null, 'the mismatched one was dropped, nothing left');
  const r = await command(base, p.id, 'update');
  assert.equal(r.body.firmware.board_verified, true);
  const res = await poll(base, p, { 'X-ST-Preset': 'seeed-reterminal-e1001' });
  assert.equal(res.headers.get('x-st-command'), `update /api/embedded/firmware/seeed_reterminal_e1001/latest.bin ${FW_SHA}`);
});
