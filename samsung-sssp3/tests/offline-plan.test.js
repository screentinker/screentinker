'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const code = fs.readFileSync(path.join(__dirname, '../app/offline-plan.js'), 'utf8');
function api() { const window = {}; vm.runInNewContext(code, { window }); return window.STOfflinePlan; }

test('offline plan selects the future pre-cached schedule at an exact half-open boundary', () => {
  const p = api();
  const plan = {
    protocol_version: 1, generated_at_utc_ms: 1000, valid_until_utc_ms: 5000,
    intervals: [
      { start_utc_ms: 1000, end_utc_ms: 3000, schedule_id: 'a' },
      { start_utc_ms: 3000, end_utc_ms: 5000, schedule_id: 'b' },
    ],
    states: [
      { schedule_id: 'a', payload: { assignments: [{ content_id: 'a' }] } },
      { schedule_id: 'b', payload: { assignments: [{ content_id: 'b' }] } },
    ],
  };
  assert.equal(p.select(plan, 2999).state.schedule_id, 'a');
  assert.equal(p.select(plan, 3000).state.schedule_id, 'b');
  assert.equal(p.select(plan, 5000).valid, false);
});

test('offline plan reports idle rather than replaying an expired or uncovered schedule', () => {
  const p = api();
  const plan = { protocol_version: 1, generated_at_utc_ms: 1000, valid_until_utc_ms: 5000,
    intervals: [{ start_utc_ms: 1000, end_utc_ms: 3000, schedule_id: 'a' }], states: [] };
  assert.equal(p.select(plan, 3000).state, null);
  assert.equal(p.select(plan, 3000).valid, true);
});

test('offline plan dependency discovery includes each future state only once', () => {
  const p = api();
  const items = p.dependencies({ protocol_version: 1, generated_at_utc_ms: 1, valid_until_utc_ms: 2, intervals: [], states: [
    { payload: { assignments: [{ content_id: 'one', content_rev: 1, filepath: 'one.mp4' }], default_content: { content_id: 'standby', content_rev: 1, filepath: 'standby.jpg' } } },
    { payload: { assignments: [{ content_id: 'one', content_rev: 1, filepath: 'one.mp4' }, { content_id: 'two', content_rev: 1, filepath: 'two.jpg' }], default_content: { content_id: 'standby', content_rev: 1, filepath: 'standby.jpg' } } },
  ] });
  assert.deepEqual(Array.from(items, (x) => x.content_id), ['one', 'standby', 'two']);
});
