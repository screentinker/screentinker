'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

/*
 * A host where worker_threads cannot produce a thread must get a SLOWER server, not a dead one.
 *
 * This is not hypothetical. Running the server inside a BrightSign roHtmlWidget - a Node context
 * inside an Electron renderer - the first spawn threw
 *
 *     Failed to construct 'Worker': The V8 platform used by this instance of Node does not
 *     support creating Workers
 *
 * and killed the whole boot. The module already had the right behaviour for a worker that dies or
 * cannot be respawned (engageFallback re-arms a conservative inline autocheckpoint); the initial
 * spawn was simply the one path that was not wrapped. So the test asserts the OUTCOME - the server
 * keeps going and the WAL is still bounded - rather than that some flag got set.
 */

function loadWithBrokenWorkers() {
  // wal-checkpointer destructures Worker at module load, so the stub has to be in place before
  // the require, and the module cache has to be clear of any earlier copy.
  delete require.cache[require.resolve('../db/wal-checkpointer')];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'worker_threads') {
      return {
        Worker: class {
          constructor() {
            throw new Error('Failed to construct \'Worker\': The V8 platform used by this ' +
                            'instance of Node does not support creating Workers');
          }
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require('../db/wal-checkpointer');
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../db/wal-checkpointer')];
  }
}

/* Just enough of a better-sqlite3 handle to record the pragmas the module issues. */
function fakeDb() {
  const pragmas = [];
  return { pragmas, pragma(sql) { pragmas.push(String(sql)); return []; } };
}

test('a host without worker threads degrades instead of taking the server down', () => {
  const mod = loadWithBrokenWorkers();
  const db = fakeDb();

  // The whole point: this must not throw.
  assert.doesNotThrow(() => mod.startWalCheckpointer(db, '/tmp/does-not-matter.db'));

  // And it must leave the WAL bounded rather than unbounded: inline autocheckpoint is re-armed to
  // a page count, NOT left at the 0 that the off-thread design sets on the way in.
  const autocheckpoints = db.pragmas.filter((p) => p.startsWith('wal_autocheckpoint'));
  assert.ok(autocheckpoints.length >= 2, 'expected autocheckpoint to be disabled then re-armed');
  const last = autocheckpoints[autocheckpoints.length - 1];
  assert.notStrictEqual(last, 'wal_autocheckpoint = 0',
    'fallback must re-arm inline autocheckpoint, otherwise the WAL grows without bound');
  const pages = Number(last.split('=')[1].trim());
  assert.ok(Number.isFinite(pages) && pages > 0, `expected a positive page count, got: ${last}`);

  mod.stopWalCheckpointer();
});

test('the fallback still reclaims the existing WAL backlog', () => {
  const mod = loadWithBrokenWorkers();
  const db = fakeDb();
  mod.startWalCheckpointer(db, '/tmp/does-not-matter.db');
  // PASSIVE or TRUNCATE both acceptable - which one depends on the WAL size. What matters is that
  // a checkpoint was actually requested, so a WAL left by a previous run does not sit there.
  assert.ok(db.pragmas.some((p) => p.startsWith('wal_checkpoint(')),
    'fallback should reclaim the backlog');
  mod.stopWalCheckpointer();
});
