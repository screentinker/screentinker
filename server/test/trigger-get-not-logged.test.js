'use strict';

/*
 * GHSA-rvxj 8.2: GET /api/trigger?secret=…&token=… is kept on purpose — Extron and AMX can build a
 * URL but cannot set a header — so the credential is in the query string by design. What must hold
 * is that this server never writes that query to a log. The access logger records only the route
 * template; the API error handler logs the path without its query. Pinned here so a future "log the
 * URL for debugging" change trips a test instead of quietly logging every controller's secret.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { accessLogger } = require('../lib/http-logging');

test('the access log records /api/trigger without its secret or token', () => {
  const lines = [];
  const req = {
    method: 'GET', originalUrl: '/api/trigger?secret=SEKRIT123&token=TOK456', url: '/api/trigger?secret=SEKRIT123&token=TOK456',
    baseUrl: '', route: { path: '/api/trigger' }, query: { secret: 'SEKRIT123', token: 'TOK456' }, socket: { remoteAddress: '203.0.113.5' },
  };
  const res = new EventEmitter();
  res.statusCode = 403; res.writableFinished = true;
  accessLogger({ write: (l) => lines.push(l) })(req, res, () => {});
  res.emit('finish');
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /SEKRIT123|TOK456|secret=|token=/);
  assert.equal(JSON.parse(lines[0].split(' [access] ')[1]).route, '/api/trigger');
});

test('the API error handler logs the path without the query', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api-errors.js'), 'utf8');
  for (const m of src.matchAll(/console\.(?:warn|error|log)\([^;]*\burl\b[^;]*;/g)) {
    assert.match(m[0], /url\.split\('\?'\)\[0\]/, `logs a raw URL: ${m[0].slice(0, 120)}`);
  }
});

test('the trigger ingress handler writes nothing about the request to the console', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = src.indexOf('const handleIngress = (req, res, source) => {');
  assert.ok(start > 0, 'could not find the ingress handler');
  const body = src.slice(start, src.indexOf('\n  };', start));
  assert.doesNotMatch(body, /console\./, 'the handler must not log the request (its query is the credential)');
  // ...and GET stays: removing it would strand every Extron / AMX integration.
  assert.match(src, /app\.get\('\/api\/trigger'/);
});

test('creating or editing a trigger never logs its fire or clear token', () => {
  /*
   * The create route used to log `token=<match_token>`. Anyone who can read the server log (an
   * operator, a log shipper, a support bundle) could then fire that trigger from the controller
   * network. Only names, ids and modes go to the log.
   */
  for (const file of ['routes/triggers.js', 'lib/trigger-resolve.js', 'lib/corporate/emergency.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const m of src.matchAll(/console\.(?:log|info|warn|error)\([^;]*;/g)) {
      assert.doesNotMatch(m[0], /match_token|clear_token|clear_all_token|parsed\.token/, `${file} logs a trigger token: ${m[0].slice(0, 120)}`);
    }
  }
});
