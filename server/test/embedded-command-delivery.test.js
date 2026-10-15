'use strict';

/*
 * No queued command may wedge an embedded panel (#638 review).
 *
 * A command is peeked when the response is built and popped only once the response carrying it is
 * written. A value Node refuses as a header threw inside res.set(), was never popped, and threw
 * again on every poll. And the single-item render's post-process 500 withheld a queued command the
 * layout path's 500 already delivered. Real schema (db/database.js); post-processing can be made to
 * fail on demand.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

let failPostprocess = false;
const h = require('./helpers/embedded-real-db').boot({
  beforeRouter() {
    // routes/embedded destructures postprocess at require time, so swap it in before the router loads.
    const pp = require('../lib/embedded-postprocess');
    const real = pp.postprocess;
    pp.postprocess = (...a) => (failPostprocess ? Promise.reject(new Error('injected post-process failure')) : real(...a));
  },
});
const queue = require('../lib/command-queue');

after(async () => { queue._resetForTests(); await h.close(); });

const poll = (base, p, qs = '') => fetch(`${base}/render?device_id=${p.id}${qs}`, { headers: { Authorization: `Bearer ${p.token}` } });

for (const [label, bad] of [
  ['CR/LF', 'reboot\r\nX-Injected: 1'],
  ['a control character', 'reb\u0001oot'],
  ['non-ASCII', 'redémarrer'],
  ['an oversized value', 'x'.repeat(4096)],
]) {
  test(`a queued command with ${label} is dropped, and the panel keeps rendering`, async () => {
    const base = await h.ready();
    const p = await h.mkPanel('waveshare-2.9in-v2');
    queue.queueCommand(p.id, bad, {});
    for (let i = 0; i < 2; i++) {
      const res = await poll(base, p);
      assert.equal(res.status, 200, `poll ${i + 1} must still render`);
      assert.equal(res.headers.get('x-st-command'), null, 'nothing unsendable goes out');
    }
    assert.deepEqual(queue.peekPendingCommands(p.id), [], 'the bad command is gone, not retried forever');
  });
}

test('a bad command does not hold back the valid one behind it', async () => {
  const base = await h.ready();
  const p = await h.mkPanel('waveshare-2.9in-v2');
  queue.queueCommand(p.id, 'refresh\r\n', {});
  queue.queueCommand(p.id, 'refresh', {});
  const res = await poll(base, p);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-st-command'), 'refresh');
  assert.deepEqual(queue.peekPendingCommands(p.id), []);
});

test('the single-item render 500 still delivers a queued command, once', async () => {
  const base = await h.ready();
  const p = await h.mkPanel('waveshare-2.9in-v2');
  queue.queueCommand(p.id, 'reboot', {});
  failPostprocess = true;
  try {
    const res = await poll(base, p, '&mode=single');
    assert.equal(res.status, 500);
    assert.equal(res.headers.get('x-st-command'), 'reboot', 'a panel whose frame failed can still be rebooted');
    assert.deepEqual(queue.peekPendingCommands(p.id), [], 'delivered, so popped');
    const again = await poll(base, p, '&mode=single');
    assert.equal(again.headers.get('x-st-command'), null, 'and not delivered twice');
  } finally { failPostprocess = false; }
});
