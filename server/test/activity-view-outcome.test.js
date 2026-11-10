'use strict';

/*
 * THE ACTIVITY PAGE SAYS WHAT HAPPENED, NOT WHAT WAS ASKED.
 *
 * The activity log records every mutating request with the status it finished with
 * (activity_log.status_code). The page rendered each row from the request alone: "POST
 * /api/widgets" became "created widget" whether the server answered 201 or 400, and a pairing
 * attempt with a wrong code read "device paired". An administrator reading the trail saw things
 * created that do not exist.
 *
 * The invariant: a row whose request was refused or failed (status 400 and up) is worded as an
 * attempt, carries its status, and does not show the request's own summary as if it were a
 * result. Rows that succeeded, and rows from before the status was recorded, read as before.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'frontend', 'js');
const view = fs.readFileSync(path.join(ROOT, 'views', 'activity.js'), 'utf8');
const en = fs.readFileSync(path.join(ROOT, 'i18n', 'en.js'), 'utf8');

// The pure part of the view, lifted out and run: status -> did it complete, and the verb table.
function load() {
  const m = /\/\/ <outcome>([\s\S]*?)\/\/ <\/outcome>/.exec(view);
  assert.ok(m, 'the view marks its outcome helpers');
  const keys = [];
  const t = (k, vars) => { keys.push(k); return k + (vars ? JSON.stringify(vars) : ''); };
  const api = new Function('t', m[1] + '\nreturn { notCompleted, formatAction };')(t);
  return { ...api, keys };
}

test('a status of 400 and up means the action did not complete; anything else reads as before', () => {
  const { notCompleted } = load();
  for (const code of [400, 401, 403, 404, 409, 413, 429, 500, 503]) assert.equal(notCompleted({ status_code: code }), true, String(code));
  for (const code of [200, 201, 204, 302, 304, null, undefined, 0, '']) assert.equal(notCompleted({ status_code: code }), false, String(code));
});

test('a refused create, update or delete is worded as an attempt', () => {
  const { formatAction } = load();
  assert.match(formatAction('POST /api/widgets/', false), /^activity\.verb_created /);
  assert.match(formatAction('POST /api/widgets/', true), /^activity\.verb_create_failed /);
  assert.match(formatAction('PUT /api/schedules/:id', true), /^activity\.verb_update_failed /);
  assert.match(formatAction('DELETE /api/content/:id', true), /^activity\.verb_delete_failed /);
});

test('a refused pairing does not read "paired"', () => {
  const { formatAction } = load();
  const refused = formatAction('POST /api/provision/pair', true);
  assert.doesNotMatch(refused, /paired/, 'no "paired" wording on a refused attempt');
  assert.match(refused, /^activity\.verb_create_failed /, 'it is an attempt');
  // (The row's own summary, "device paired", is the details line, which a failed row does not show.)
});

test('the row uses the outcome: wording, a visible status, and no request summary posing as a result', () => {
  assert.match(view, /const failed = notCompleted\(item\)/);
  assert.match(view, /formatAction\(item\.action, failed\)/);
  assert.match(view, /failed \? [\s\S]{0,200}activity\.not_completed/, 'a failed row shows its status');
  assert.match(view, /item\.details && !failed/, 'and not the request summary');
});

test('every new string has English text', () => {
  for (const k of ['activity.verb_create_failed', 'activity.verb_update_failed', 'activity.verb_delete_failed', 'activity.not_completed']) {
    assert.ok(en.includes(`'${k}':`), k);
  }
});
