'use strict';

/*
 * The embedded diagnostics / firmware routes are rate-limited (CodeQL js/missing-rate-limiting on
 * #6). This checks the limiters are really on the routes, and that a 429 is the JSON shape panels and
 * the dashboard already parse, rather than trusting that CodeQL went quiet.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const limits = require('../lib/embedded-rate-limits');

function routeHas(router, method, path, mw) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} exists`);
  return layer.route.stack.some((s) => s.handle === mw);
}

test('every flagged embedded / device route carries its limiter', () => {
  const embedded = require('../routes/embedded');
  assert.ok(routeHas(embedded, 'post', '/logs', limits.deviceLogsLimiter));
  assert.ok(routeHas(embedded, 'get', '/logs', limits.deviceLogsLimiter));
  assert.ok(routeHas(embedded, 'get', '/firmware/:preset/version', limits.firmwareLimiter));
  assert.ok(routeHas(embedded, 'get', '/firmware/:preset/latest.bin', limits.firmwareLimiter));

  const devices = require('../routes/devices');
  // ⚠️ NOT on GET /:id: that is the core device read (the device page, the public API, the fleet
  // walk), and a per-IP ceiling there throttled an office of dashboards behind one NAT.
  assert.equal(routeHas(devices, 'get', '/:id', limits.dashboardDeviceReadLimiter), false);
  assert.ok(routeHas(devices, 'get', '/:id/diagnostic-logs', limits.dashboardDeviceReadLimiter));
});

test('past the ceiling a client gets a JSON 429 with standard headers', async () => {
  const { rateLimit } = require('express-rate-limit');
  // Same options as the module, small ceiling so the test is fast.
  const app = express();
  app.get('/x', rateLimit({ windowMs: 60000, limit: 2, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Too many firmware requests, slow down and retry later.' } }), (req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  try {
    const url = `http://127.0.0.1:${server.address().port}/x`;
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await fetch(url)).status, 200);
    const r = await fetch(url);
    assert.equal(r.status, 429);
    assert.ok(r.headers.get('ratelimit-policy'), 'standard RateLimit-Policy header');
    assert.match((await r.json()).error, /Too many/);
  } finally { server.close(); }
});

test('the firmware ceiling lets a site of ~60 panels behind one NAT finish an OTA wave', async () => {
  // One /version + one download per panel = 2 requests; 60 panels = 120 in one window.
  const app = express();
  app.get('/fw', limits.firmwareLimiter, (req, res) => res.end('ok'));
  const server = app.listen(0);
  try {
    const url = `http://127.0.0.1:${server.address().port}/fw`;
    for (let i = 0; i < 120; i++) assert.equal((await fetch(url)).status, 200, `request ${i + 1}`);
    assert.equal((await fetch(url)).status, 429, 'the 121st in the window is refused');
  } finally { server.close(); }
});
