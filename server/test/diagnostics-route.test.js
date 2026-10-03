'use strict';

/*
 * Server diagnostics — the operator surface that replaced "email the customer a shell script".
 *
 * ⚠️ THE GATE IS THE FEATURE'S RISK. This returns table row counts across every tenant on the box
 * and a CPU profile naming this deployment's code paths. A workspace owner is a customer, not an
 * operator of the host, so platform_admin is the line — and it is asserted per route, because the
 * way this goes wrong is somebody adding a fourth endpoint without one.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'diagnostics.js'), 'utf8');
const diagnostics = require('../routes/diagnostics');

test('every route is gated on platform admin, with none left open', () => {
  const routes = [...SRC.matchAll(/router\.(get|post|put|delete)\('([^']+)'\s*,\s*([A-Za-z]+)/g)];
  assert.ok(routes.length >= 3, `expected the three endpoints, found ${routes.length}`);
  for (const [, verb, p, firstArg] of routes) {
    assert.equal(firstArg, 'requirePlatformAdmin',
      `${verb.toUpperCase()} ${p} does not start with requirePlatformAdmin — a workspace owner would reach it`);
  }
});

/*
 * ⚠️ IN-PROCESS PROFILING, NEVER A DEBUG PORT. The alternative — SIGUSR1, which opens the V8
 * inspector on 9229 — leaves a listener on a production box until the next restart and depends on
 * somebody remembering to close it. inspector.Session reaches the same profiler from inside this
 * process: same data, nothing listening, nothing left behind if the request dies halfway.
 */
test('the profiler never opens a port', () => {
  /*
   * Comments stripped first: the note above the profiler NAMES the mechanism it replaces, and
   * matching that would be the test failing on its own documentation.
   */
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /new inspector\.Session\(\)/, 'must profile in-process');
  assert.ok(!/inspector\.open\(/.test(code), 'inspector.open() would expose a debug port on a live server');
  assert.ok(!/SIGUSR1/.test(code), 'signalling the process to open the inspector is the thing this replaces');
});

test('a profile is bounded, single-flight, and audited', () => {
  assert.match(SRC, /if \(profiling\) return res\.status\(409\)/,
    'two concurrent profiles on a struggling server make the incident worse while measuring it');
  assert.match(SRC, /MAX_SECONDS/, 'an unbounded duration is a way to sample a server to death');
  assert.match(SRC, /logActivity\([^)]*admin_cpu_profile/, 'profiling the host must leave an audit trail');
});

/*
 * ⚠️ COUNTS AND TIMINGS ONLY. The whole point is that the output can be pasted into a support
 * ticket. Anything that reads back operator text, media, or a credential does not belong here.
 */
test('the shape report cannot return content or secrets', () => {
  const shape = SRC.slice(SRC.indexOf("router.get('/shape'"), SRC.indexOf("router.get('/lag'"));
  for (const forbidden of ['device_token', 'enrol_key', 'settings_pin', 'trigger_secret', 'password']) {
    assert.ok(!shape.includes(forbidden), `the shape report must not read ${forbidden}`);
  }
  // It measures sizes rather than reading values.
  assert.match(shape, /LENGTH\(published_snapshot\)/, 'payload size is the cost driver, not its content');
  assert.ok(!/SELECT published_snapshot FROM/.test(shape), 'never return the snapshot itself');
});

/*
 * ⚠️ DISCOVERED FROM sqlite_master, NOT LISTED. A hardcoded table list is wrong the moment it meets
 * an install on a different schema version — which is the only kind of install this is for. Writing
 * one by hand already cost a round trip with a customer: `item_schedules` and `zone_assignments` do
 * not exist under those names.
 */
test('table counts are discovered, so a schema difference cannot break the report', () => {
  assert.match(SRC, /FROM sqlite_master WHERE type='table'/, 'the table list must be discovered');
  assert.match(SRC, /catch \(_\) \{ \/\* a view or a table mid-migration/,
    'one unreadable table must not empty the whole report');
});

test('top self-time ranks by SELF time and survives an empty profile', () => {
  const top = diagnostics._topSelfTime;
  assert.deepEqual(top({ nodes: [], samples: [] }), [], 'an empty profile must not throw');

  const profile = {
    nodes: [
      { id: 1, callFrame: { functionName: 'idle', url: '', lineNumber: 0 } },
      { id: 2, callFrame: { functionName: 'buildPlaylistPayload', url: 'file:///app/server/ws/deviceSocket.js', lineNumber: 620 } },
    ],
    samples: [1, 2, 2, 2],
  };
  const out = top(profile);
  assert.equal(out[0].fn, 'buildPlaylistPayload', 'the busiest frame must rank first');
  assert.equal(out[0].pct, 75);
  assert.equal(out[0].at, 'ws/deviceSocket.js:621', 'the location must be readable, and 1-indexed');
});
