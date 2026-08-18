'use strict';

// TWO DATE BUGS IN THE SCHEDULE MODAL, both timezone-independent, both silent.
//
//  1. Saving an EDIT moved the schedule to today. The save handler rebuilds start_time from
//     `pendingCreateDate || new Date()`, and editSchedule() restored only HH:MM - it never recorded
//     the date it was editing. Change a colour on a block dated 5 Aug and it jumped to this week.
//
//  2. A cancelled drag-create leaked its date into the NEXT schedule. pendingCreateDate was cleared
//     only on a successful save, and the modal's two dismissers are inline
//     onclick="...display='none'" attributes that cannot reach this scope.
//
// Both are fixed by assigning the date on every path that OPENS the modal, which is the invariant
// pinned here. There is no DOM in this runner, so this is a source-level check - the same technique
// i18n-keys-exist.test.js uses to police the views. It is deliberately loose about HOW the value is
// assigned and strict about WHETHER each opener assigns it, so a refactor that keeps the invariant
// keeps passing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'schedule.js'), 'utf8');

/*
 * Comment lines are dropped before any of this is matched.
 *
 * The first version of this test failed against the FIXED code because the save handler carries a
 * comment explaining why it does not use toISOString() - and the test matched the explanation.
 * A source-level check has to look at code, not at prose about code.
 *
 * Whole-line comments only: stripping mid-line would mean parsing strings, and "https://" inside a
 * URL literal looks exactly like a line comment to anything simpler than a parser.
 */
function withoutComments(text) {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}

/* The text of a brace-balanced block starting at `from`. */
function blockAt(from) {
  const open = SRC.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') {
      depth--;
      if (depth === 0) return SRC.slice(open, i + 1);
    }
  }
  throw new Error('unbalanced block');
}

const ASSIGNS_DATE = /pendingCreateDate\s*=/;

test('editSchedule records the date of the schedule it is editing', () => {
  const at = SRC.indexOf('function editSchedule(');
  assert.notEqual(at, -1, 'editSchedule() not found - has it been renamed?');
  assert.match(withoutComments(blockAt(at)), ASSIGNS_DATE,
    'editSchedule() must set pendingCreateDate, or saving an edit moves the schedule to today');
});

test('opening the blank Add form clears any date left over from a cancelled drag', () => {
  const at = SRC.indexOf("getElementById('addScheduleBtn').onclick");
  assert.notEqual(at, -1, 'the addScheduleBtn handler was not found');
  assert.match(withoutComments(blockAt(at)), ASSIGNS_DATE,
    'the Add handler must reset pendingCreateDate, or a cancelled drag-create stamps the next schedule');
});

test('the date is declared before anything assigns it', () => {
  // It used to be declared BELOW the drag handler that assigns it. That happens to work only
  // because the handler runs later; moving either one would turn it into a ReferenceError at a
  // moment nobody is watching.
  const code = withoutComments(SRC);
  const decl = code.search(/\blet\s+pendingCreateDate\b/);
  assert.notEqual(decl, -1, 'pendingCreateDate declaration not found');
  const firstUse = code.search(/pendingCreateDate\s*=\s*(?!null\b)/);
  assert.ok(decl < firstUse || firstUse === -1,
    'pendingCreateDate is assigned before it is declared');
});

test('the saved date is built from local parts, never toISOString', () => {
  // toISOString() is UTC: for anyone west of Greenwich it stamps the previous day for part of the
  // evening, which is the same class of bug as the one on the server side.
  const at = SRC.indexOf("getElementById('saveScheduleBtn').onclick");
  assert.notEqual(at, -1, 'the save handler was not found');
  const body = withoutComments(blockAt(at));
  assert.ok(!/toISOString\(\)/.test(body),
    'the save handler must not derive a calendar date from toISOString()');
  assert.match(body, /getFullYear\(\)/, 'the date should be assembled from local parts');
});
