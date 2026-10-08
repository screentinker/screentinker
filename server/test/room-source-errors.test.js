'use strict';

// The rooms API's error mapping: an ICS address refused by the SSRF guard (or failing upstream) is
// a 400/502 with a message an admin can act on, never the generic 500.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-room-errs-'));
process.env.DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { sendErr } = require('../routes/rooms');
const { SsrfError, GuardedRequestError } = require('../lib/ssrf-guard');

function answer(e) {
  const out = {};
  const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
  const orig = console.error; console.error = () => {};
  try { sendErr(res, e); } finally { console.error = orig; }
  return out;
}

test('an SSRF refusal is a 400 that says why', () => {
  const a = answer(new SsrfError('blocked-ip:10.0.0.5'));
  assert.equal(a.status, 400);
  assert.match(a.body.error, /private or internal network address/);
  assert.equal(a.body.code, 'ssrf');
  assert.match(answer(new SsrfError('dns-fail')).body.error, /host could not be found/);
  assert.match(answer(new SsrfError('bad-scheme')).body.error, /http:\/\/ or https:\/\//);
});

test('an upstream fetch failure is a 502 with the fetcher\'s message', () => {
  const a = answer(new GuardedRequestError('Calendar feed responded 404', 'upstream-status', 404));
  assert.equal(a.status, 502);
  assert.match(a.body.error, /Calendar feed responded 404/);
  const p = answer(new Error('Remote calendar data could not be parsed: bad'));
  assert.equal(p.status, 502);
  assert.match(p.body.error, /did not return a calendar/);
});

test('anything else is still the generic 500', () => {
  const a = answer(new Error('boom'));
  assert.equal(a.status, 500);
  assert.doesNotMatch(a.body.error, /boom/);
});
