'use strict';

/*
 * REPLICA_JOIN_CODE is retried until the primary ANSWERS (services/mesh-dialer.js startAutoJoin).
 * A cache node whose service starts before the network, or while the main server is down, must still
 * join without anyone restarting it; a refused invite must stop retrying and say why.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startAutoJoin } = require('../services/mesh-dialer');

function harness(answers) {
  const timers = [];
  const calls = [];
  const quiet = { log() {}, warn() {} };
  const schedule = (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; };
  const join = async () => { calls.push(1); return answers.shift(); };
  const run = async () => { const t = timers.shift(); await t.fn(); return t.ms; };
  return { timers, calls, quiet, schedule, join, run };
}

test('unreachable, then 5xx, then joined: it keeps trying, backing off, and stops once joined', async () => {
  const h = harness([
    { ok: false, retryable: true, reason: 'Could not reach x: ECONNREFUSED' },
    { ok: false, retryable: true, reason: 'The primary refused (503).' },
    { ok: true, capabilities: [] },
  ]);
  const aj = startAutoJoin(null, {}, { logger: h.quiet, schedule: h.schedule, join: h.join, rand: () => 0.5 });
  assert.equal(await h.run(), 1000, 'first try a second after boot');
  assert.deepEqual({ ...aj.status(), next_at: null }, { pending: true, attempt: 1, last_error: 'Could not reach x: ECONNREFUSED', next_at: null });
  const d1 = await h.run();
  const d2 = await h.run();
  assert.ok(d2 > d1, `backs off (${d1} then ${d2})`);
  assert.equal(h.calls.length, 3);
  assert.equal(h.timers.length, 0, 'nothing more scheduled after the join');
  assert.deepEqual(aj.status(), { pending: false, attempt: 2, last_error: null, next_at: null });
});

test('a refused invite is final and stays visible', async () => {
  const h = harness([{ ok: false, reason: 'That invite has already been used.' }]);
  const aj = startAutoJoin(null, {}, { logger: h.quiet, schedule: h.schedule, join: h.join });
  await h.run();
  assert.equal(h.timers.length, 0, 'no retry of a refusal');
  assert.equal(aj.status().pending, false);
  assert.equal(aj.status().last_error, 'That invite has already been used.');
});

test('already joined (an edge exists) is not an error', async () => {
  const h = harness([{ skipped: true, already: true }]);
  const aj = startAutoJoin(null, {}, { logger: h.quiet, schedule: h.schedule, join: h.join });
  await h.run();
  assert.deepEqual(aj.status(), { pending: false, attempt: 0, last_error: null, next_at: null });
});

test('stop() ends the retries', async () => {
  const h = harness([{ ok: false, retryable: true, reason: 'down' }, { ok: true, capabilities: [] }]);
  const aj = startAutoJoin(null, {}, { logger: h.quiet, schedule: h.schedule, join: h.join });
  await h.run();
  aj.stop();
  await h.run();
  assert.equal(h.calls.length, 1, 'the scheduled retry did nothing after stop()');
});
