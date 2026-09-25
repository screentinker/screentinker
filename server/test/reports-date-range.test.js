'use strict';

/*
 * Date ranges on the report endpoints.
 *
 * ⚠️ THE BUG: all three handlers built the end of the range as `new Date(end + 'T23:59:59')`. That
 * assumes `end` is a bare `YYYY-MM-DD` and glues a time onto it to mean "the whole of that day". Hand
 * it a full ISO timestamp — which is what a client library, a script, or an AI agent calling the
 * documented API naturally sends — and the concatenation produces `2026-09-25T15:53:06.947ZT23:59:59`,
 * an Invalid Date, `NaN`, and a WHERE clause matching no rows.
 *
 * The endpoint then answered **200 with `[]`**. Not an error — "nothing played". That is a plausible
 * enough answer that nobody questions it, which is what makes it worse than a crash. It was found
 * when an agent asked for a week of uptime and was told, convincingly, that every screen had been
 * dark for a week.
 *
 * These tests are on the parsing rule directly, because that is where the bug lived and a route test
 * would need a populated database to notice an empty array is wrong.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseRangeParam } = require('../routes/reports');

test('a bare date as `end` still means the whole of that day', () => {
  // The original intent, and the dashboard depends on it: end=2026-09-25 must include the 25th.
  const { ok, epoch } = parseRangeParam('2026-09-25', { endOfDay: true });
  assert.equal(ok, true);
  assert.equal(new Date(epoch * 1000).toISOString().slice(0, 19), '2026-09-25T23:59:59');
  // ⚠️ And in UTC regardless of the server's zone. `new Date('...T23:59:59')` without an offset is
  // LOCAL, while a bare date is UTC — so the two ends of a range resolved into different zones and
  // the window was skewed by the server's offset. Invisible on prod and alpha, which run UTC;
  // five hours wrong on a self-hosted instance in Chicago.
  assert.equal(new Date(epoch * 1000).toISOString(), '2026-09-25T23:59:59.000Z');
});

test('a bare date as `start` is the beginning of that day', () => {
  const { epoch } = parseRangeParam('2026-09-25');
  assert.equal(new Date(epoch * 1000).toISOString().slice(0, 19), '2026-09-25T00:00:00');
});

test('⚠️ a full ISO timestamp is accepted, where it used to produce NaN', () => {
  const iso = '2026-09-25T15:53:06.947Z';
  // Demonstrate the old behaviour rather than describing it, so this cannot rot into a comment.
  assert.ok(Number.isNaN(new Date(iso + 'T23:59:59').getTime()), 'the old expression really was NaN');

  const { ok, epoch } = parseRangeParam(iso, { endOfDay: true });
  assert.equal(ok, true);
  assert.equal(epoch, Math.floor(Date.parse(iso) / 1000), 'a datetime is taken as given, not extended');
});

test('an absent value defers to the caller default rather than inventing one', () => {
  for (const v of ['', null, undefined]) {
    assert.deepEqual(parseRangeParam(v), { ok: true, epoch: null });
  }
});

test('⚠️ an unparseable date is a refusal, never an empty result', () => {
  // The whole point. Silently returning nothing is the failure this replaces.
  for (const bad of ['not-a-date', '2026-13-45', 'yesterday', '25/09/2026', '{}']) {
    assert.equal(parseRangeParam(bad).ok, false, `${bad} should be refused`);
  }
});

test('all three report handlers use the shared parser, and none rebuilds the old expression', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'reports.js'), 'utf8');
  // ⚠️ Comments stripped: the helper's own comment quotes the removed expression to explain why it
  // went, and an absence assertion against raw source fails on the note documenting the fix.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

  assert.ok(!/new Date\(\s*end\s*\+/.test(code), 'the concatenation must not come back');
  // Call sites only — the helper's own signature also matches, so it is excluded by name.
  const callSites = (code.match(/=\s*resolveRange\(req, res/g) || []).length;
  assert.equal(callSites, 3, 'summary, plays and uptime should all resolve their range the same way');
  // And each one returns early on a refusal rather than carrying on with a null range.
  assert.equal((code.match(/if \(!range\) return;/g) || []).length, 3);
});

test('the MCP report tools send something this parser accepts', () => {
  // The two sides of the same bug: the tool sends the value, the endpoint parses it. Checking them
  // together is the only way to know the pair works, which is what running it against real data
  // proved and neither unit test would have.
  const tools = require('../lib/mcp/tools');
  const summary = tools.toRequest(tools.byName('play_report'), { from: '2026-09-01', to: '2026-09-25' });
  const uptime = tools.toRequest(tools.byName('uptime_report'), { days: 7 });
  for (const [label, q] of [['play_report', summary.query], ['uptime_report', uptime.query]]) {
    assert.equal(parseRangeParam(q.start).ok, true, `${label} start is unparseable: ${q.start}`);
    assert.equal(parseRangeParam(q.end, { endOfDay: true }).ok, true, `${label} end is unparseable: ${q.end}`);
    assert.ok(parseRangeParam(q.start).epoch < parseRangeParam(q.end, { endOfDay: true }).epoch,
      `${label} produced a backwards range`);
  }
});
