'use strict';

/*
 * The energy, freshness, activity, ota-rollouts, plugin-submissions, provisioning and teams routers
 * start with router.use(backstop), like every other router mounted through the
 * config/api-surface.js loop (CodeQL js/missing-rate-limiting #814-#819). server.js
 * already counts every request app-wide; the in-router mount is what static analysis can see, and it
 * keeps the router bounded if it is ever mounted somewhere the app-wide limiter does not reach. It
 * must be the SAME instance, whose skip() refuses an already-counted request, so nothing is counted
 * twice (proved against the real server in backstop-limit.test.js).
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A private data dir: requiring a router opens the database.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-router-backstop-'));
process.env.DATA_DIR = dataDir;
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const backstop = require('../lib/backstop-limiter');

for (const mod of ['energy', 'freshness', 'activity', 'ota-rollouts', 'plugin-submissions', 'provisioning', 'teams']) {
  test(`routes/${mod} mounts the shared backstop ahead of every route`, () => {
    const router = require(`../routes/${mod}`);
    const first = router.stack.findIndex((l) => l.route);
    const at = router.stack.findIndex((l) => !l.route && l.handle === backstop);
    assert.ok(at !== -1, 'router.use(backstop) is present');
    assert.ok(first === -1 || at < first, 'and comes before the first route');
  });
}
