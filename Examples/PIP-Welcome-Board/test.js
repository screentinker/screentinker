'use strict';

// Offline test for the welcome board. No network, no PiP push — exercises the
// pure functions against a FIXED 'now' so date filtering is deterministic.

const assert = require('assert');
const w = require('./welcome');

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`✓ ${msg}`); checks++; };

// FIXED now: March 14 2026, 09:00 local. Built from local components and read
// back via local getters, so it's timezone-independent.
const NOW = new Date(2026, 2, 14, 9, 0, 0);

// --- CSV parsing (incl. a quoted field containing a comma) ----------------
const csv =
  'type,name,date,note\n' +
  'welcome,Visitors,,"Thanks, room 204"\n' +
  'birthday,Priya Nair,03-14,\n' +
  'birthday,Marcus Webb,07-04,Cake!\n' +
  'anniversary,Dana Olsen,2019-03-14,"Lead, infra"\n';
const rows = w.parseCsv(csv);

ok(rows.length === 4, 'parseCsv reads 4 data rows (header skipped)');
ok(rows[0].note === 'Thanks, room 204', 'quoted field with a comma is preserved');
ok(rows[1].type === 'birthday' && rows[1].date === '03-14', 'columns map to header keys');

// --- date helpers ---------------------------------------------------------
ok(w.mmddOf(NOW) === '03-14', 'mmddOf(NOW) === 03-14');
ok(w.mmdd('2019-03-14') === '03-14', 'mmdd strips the year from YYYY-MM-DD');
ok(w.mmdd('3-14') === '03-14', 'mmdd zero-pads MM-DD');
ok(w.yearOf('2019-03-14') === 2019, 'yearOf reads the year');
ok(w.yearOf('03-14') === null, 'yearOf is null when no year present');

// --- todaysEntries filtering ----------------------------------------------
const today = w.todaysEntries(rows, NOW, { showAllWhenEmpty: true });
const names = today.map((r) => r.name);
ok(names.includes('Priya Nair'), "today includes the 03-14 birthday");
ok(names.includes('Dana Olsen'), "today includes the 03-14 anniversary");
ok(names.includes('Visitors'), 'today always includes welcome rows');
ok(!names.includes('Marcus Webb'), 'the 07-04 birthday is excluded today');

// fall back to all rows when nothing qualifies (no welcomes, no date match)
const datedOnly = [
  { type: 'birthday', name: 'Nobody', date: '01-01', note: '' },
];
const fb = w.todaysEntries(datedOnly, NOW, { showAllWhenEmpty: true });
ok(fb.length === 1 && fb[0].name === 'Nobody', 'show_all_when_empty falls back to all rows');
const noFb = w.todaysEntries(datedOnly, NOW, { showAllWhenEmpty: false });
ok(noFb.length === 0, 'with show_all_when_empty=false, nothing shows when nothing qualifies');

// --- message building -----------------------------------------------------
const bday = w.buildMessage({ type: 'birthday', name: 'Priya Nair' }, NOW);
ok(bday.emoji === '🎂' && bday.greeting === 'Happy Birthday' && bday.name === 'Priya Nair', 'birthday message');

const anniv = w.buildMessage({ type: 'anniversary', name: 'Dana Olsen', date: '2019-03-14' }, NOW);
ok(anniv.greeting === '7 Years!', 'anniversary with a year computes "7 Years!" (2026-2019)');

const anniv1 = w.buildMessage({ type: 'anniversary', name: 'One Yr', date: '2025-03-14' }, NOW);
ok(anniv1.greeting === '1 Year!', 'anniversary singular: "1 Year!"');

const annivNoYr = w.buildMessage({ type: 'anniversary', name: 'X', date: '03-14' }, NOW);
ok(annivNoYr.greeting === 'Happy Work Anniversary', 'anniversary without a year falls back to generic greeting');

const welc = w.buildMessage({ type: 'welcome', name: 'Visitors' }, NOW);
ok(welc.emoji === '👋' && welc.greeting === 'Welcome', 'welcome message');

// --- overlay URI ----------------------------------------------------------
const uri = w.buildOverlayUri('https://x/welcome-overlay.html', bday);
const parsed = new URLSearchParams(uri.split('?')[1]);
ok(parsed.get('name') === 'Priya Nair', 'overlay uri carries the name through URLSearchParams');
ok(parsed.get('emoji') === '🎂', 'overlay uri carries the emoji');
ok(/^[0-9A-Fa-f]{6}$/.test(parsed.get('color')), 'overlay uri color is exactly 6 hex digits');

console.log(`\n${checks} checks passed`);
console.log('\nRESULT: PASS ✅');
