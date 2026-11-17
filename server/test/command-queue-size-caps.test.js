'use strict';

/*
 * THE OFFLINE COMMAND QUEUE IS BOUNDED BY BYTES, NOT ONLY BY COUNT (advisory 7.1).
 *
 * "Last-of-type wins" capped the number of queued commands per screen, but payloads were held
 * verbatim, and a dashboard socket message may be 10 MB: ~30 types x 10 MB per offline screen,
 * held for up to 7 days on an embedded panel. Pinned here: an oversized payload is refused, a
 * screen's queue has a total byte budget, and replacing a type does not double-count it.
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

process.env.DATA_DIR = path.join(os.tmpdir(), 'st-cqcap-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const queue = require('../lib/command-queue');

afterEach(() => queue._resetForTests());

const blob = (n) => ({ body: 'x'.repeat(n) });

test('the caps exist and sit far above any real command', () => {
  assert.ok(Number.isFinite(queue.MAX_COMMAND_PAYLOAD_BYTES) && queue.MAX_COMMAND_PAYLOAD_BYTES >= 16 * 1024);
  assert.ok(queue.MAX_DEVICE_QUEUE_BYTES >= queue.MAX_COMMAND_PAYLOAD_BYTES);
});

test('ordinary commands still queue', () => {
  assert.equal(queue.queueCommand('d1', 'reboot', {}), true);
  assert.equal(queue.queueCommand('d1', 'set_server_url', { url: 'https://new.example.com' }), true);
  assert.equal(queue.getQueueDepth('d1'), 2);
});

test('a payload over the per-command cap is refused and nothing is held', () => {
  assert.equal(queue.queueCommand('d2', 'http_request', blob(queue.MAX_COMMAND_PAYLOAD_BYTES + 1)), false);
  assert.equal(queue.getQueueDepth('d2'), 0);
  assert.deepEqual(queue.peekPendingCommands('d2'), []);
});

test('a screen\'s queue has a total byte budget across types', () => {
  const each = Math.floor(queue.MAX_COMMAND_PAYLOAD_BYTES * 0.9);
  const fit = Math.floor(queue.MAX_DEVICE_QUEUE_BYTES / (each + 64));
  let accepted = 0;
  for (let i = 0; i < fit + 5; i++) if (queue.queueCommand('d3', 'type' + i, blob(each))) accepted++;
  assert.ok(accepted >= 1 && accepted <= fit, `accepted ${accepted}, budget allows ${fit}`);
  const held = queue.peekPendingCommands('d3').reduce((n, c) => n + JSON.stringify(c.payload).length, 0);
  assert.ok(held <= queue.MAX_DEVICE_QUEUE_BYTES, 'never more than the budget held for one screen');
  // Another screen has its own budget.
  assert.equal(queue.queueCommand('d4', 'type0', blob(each)), true);
});

test('replacing a type does not count the entry it replaces', () => {
  const each = Math.floor(queue.MAX_COMMAND_PAYLOAD_BYTES * 0.9);
  for (let i = 0; i < 20; i++) assert.equal(queue.queueCommand('d5', 'http_request', blob(each)), true, `send ${i}`);
  assert.equal(queue.getQueueDepth('d5'), 1);
});
