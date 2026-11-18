'use strict';

/*
 * No user-facing entry point disappears (or appears) without the PR saying so.
 *
 * The committed snapshot (fixtures/feature-inventory.json) lists every button/link id, button action
 * attribute and #/route in the dashboard, and every server route. This test rebuilds the list from the
 * source and fails on any difference, naming each entry.
 *
 * If the change is intended, run `node scripts/feature-inventory.js --write` and commit the snapshot:
 * its diff is then part of the PR, so a removed feature is something a reviewer sees and agrees to,
 * not a side effect found months later (the "+ Group" button, lost in 2.0 with #296).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { build, difference, SNAPSHOT } = require('../../scripts/feature-inventory');

const HOW = 'If this is intended, run `node scripts/feature-inventory.js --write` and commit server/test/fixtures/feature-inventory.json, so the change shows in the PR.';

const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
const current = build();

test('no feature entry point was removed', () => {
  const removed = difference(snapshot, current);
  assert.deepEqual(removed, [], `These entry points are gone:\n  ${removed.join('\n  ')}\n${HOW}`);
});

test('every new feature entry point is in the inventory', () => {
  const added = difference(current, snapshot);
  assert.deepEqual(added, [], `These entry points are not in the inventory yet:\n  ${added.join('\n  ')}\n${HOW}`);
});

test('the inventory keeps the entry points that were lost before', () => {
  const has = (area, file, entry) => (snapshot[area][file] || []).includes(entry);
  assert.ok(has('frontend', 'frontend/js/views/dashboard.js', '#createGroupBtn'), 'the standalone New group button');
  assert.ok(has('frontend', 'frontend/js/views/dashboard.js', '[data-selection-create-group]'), 'create-and-add from a selection');
  assert.ok(has('server', 'server/routes/device-groups.js', 'POST /'), 'the create-group API');
});

test('the inventory reads real entry points, not nothing', () => {
  const count = (area) => Object.values(current[area]).reduce((n, list) => n + list.length, 0);
  assert.ok(count('frontend') > 500, `${count('frontend')} frontend entry points`);
  assert.ok(count('server') > 300, `${count('server')} server routes`);
});
