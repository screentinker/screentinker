'use strict';

/*
 * better-sqlite3 13 needs Node-API 10 (Node 22.14+) and SEGFAULTS below it (measured: Node 20.20,
 * 22.12, 22.13 — exit 139), which no try/catch survives. So neither loader may even require it on
 * such a Node: the driver falls back or names the fix, and preflight never tries a rebuild.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const floor = require('../db/native-floor');

test('the floor: Node-API 10 and up may load the native driver, below may not', () => {
  assert.equal(floor.nativeUnsupported('10', '22.14.0'), null);
  assert.equal(floor.nativeUnsupported('10', '24.1.0'), null);
  for (const [napi, node] of [['9', '22.13.1'], ['9', '22.12.0'], ['9', '20.20.1'], ['', '18.0.0']]) {
    const why = floor.nativeUnsupported(napi, node);
    assert.match(why, /Node-API 10 \(Node 22\.14\.0 or newer\)/);
    assert.ok(why.includes(node), 'names the Node it is running on');
  }
});

test('this Node passes the floor (CI and every supported deploy run 22.14+)', () => {
  assert.equal(floor.nativeUnsupported(), null, `running ${process.version}, Node-API ${process.versions.napi}`);
});

/**
 * Load `mod` fresh with native-floor reporting a too-old Node and better-sqlite3 rigged to fail the
 * test if anything so much as requires it (on a real old Node, that require is the crash).
 */
function withTooOldNode(fn) {
  const floorPath = require.resolve('../db/native-floor');
  const nativePath = require.resolve('better-sqlite3');
  const saved = new Map([floorPath, nativePath].map((p) => [p, require.cache[p]]));
  const touched = [];
  require.cache[floorPath] = { id: floorPath, filename: floorPath, loaded: true,
    exports: { ...floor, nativeUnsupported: () => 'better-sqlite3 needs Node-API 10 (Node 22.14.0 or newer); Node 22.13.1 has Node-API 9' } };
  require.cache[nativePath] = { id: nativePath, filename: nativePath, loaded: true,
    get exports() { touched.push(new Error('better-sqlite3 was required').stack); return function NativeDatabase() { throw new Error('native driver opened'); }; } };
  try { return fn(touched); } finally {
    for (const [p, m] of saved) { if (m) require.cache[p] = m; else delete require.cache[p]; }
  }
}

test('sqlite-driver never requires better-sqlite3 on a too-old Node', () => {
  withTooOldNode((touched) => {
    const driverPath = require.resolve('../db/sqlite-driver');
    const saved = require.cache[driverPath];
    delete require.cache[driverPath];
    const prev = process.env.ST_SQLITE_DRIVER;
    delete process.env.ST_SQLITE_DRIVER;
    try {
      let loaded, err;
      try { loaded = require('../db/sqlite-driver'); } catch (e) { err = e; }
      assert.deepEqual(touched, [], 'the native module must not be loaded at all');
      let builtin = false;
      try { require('node:sqlite'); builtin = true; } catch { /* 22.x without the flag */ }
      if (builtin) {
        assert.equal(loaded.driverName, 'node:sqlite');
        assert.match(loaded.fallbackReason, /Node-API 10/);
      } else {
        assert.ok(err, 'no driver at all must be a clear error, not a crash');
        assert.match(err.message, /Node-API 10/);
        assert.match(err.message, /Upgrade Node to 22\.14/);
      }
    } finally {
      if (prev !== undefined) process.env.ST_SQLITE_DRIVER = prev;
      if (saved) require.cache[driverPath] = saved; else delete require.cache[driverPath];
    }
  });
});

test('preflight reports a too-old Node without loading or rebuilding the module', () => {
  withTooOldNode((touched) => {
    const prePath = require.resolve('../lib/preflight-deps');
    const saved = require.cache[prePath];
    delete require.cache[prePath];
    try {
      const pre = require('../lib/preflight-deps');
      assert.match(pre.nativeModuleBroken(), /Node-API 10/);
      assert.deepEqual(touched, []);
    } finally {
      if (saved) require.cache[prePath] = saved; else delete require.cache[prePath];
    }
  });
});

test('the declared engines floor matches the native floor', () => {
  const pkg = require(path.join(__dirname, '..', 'package.json'));
  assert.equal(pkg.engines.node, `>=${floor.MIN_NODE}`);
});
