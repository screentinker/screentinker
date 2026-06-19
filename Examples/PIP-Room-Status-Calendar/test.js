'use strict';

// Offline test for the ICS parser + room status logic. No network, fixed clock.
const fs = require('fs');
const { parseIcs, status } = require('./room');

const events = parseIcs(fs.readFileSync('./fixture-room.ics', 'utf8'));

console.log(`Parsed ${events.length} event(s):\n`);
for (const e of events) {
  console.log(`• ${e.summary}  ${new Date(e.start).toISOString()} -> ${new Date(e.end).toISOString()}`);
}
console.log('');

// 14:30Z is inside Sprint Planning (14:00-15:00); next is the 1:1 at 16:00.
const nowBusy = Date.UTC(2026, 5, 18, 14, 30, 0);
const sBusy = status(events, nowBusy);

// 15:30Z is between meetings; room free, next is the 1:1 at 16:00.
const nowFree = Date.UTC(2026, 5, 18, 15, 30, 0);
const sFree = status(events, nowFree);

const fold = events.find(e => e.summary === '1:1 with Dana');   // proves line-unfolding
const esc = events.find(e => e.summary === 'Quarterly Retro, room A'); // proves TEXT unescaping

const ok =
  events.length === 4 &&
  sBusy.state === 'busy' &&
  sBusy.current && sBusy.current.summary === 'Sprint Planning' &&
  sBusy.busyUntil === Date.UTC(2026, 5, 18, 15, 0, 0) &&
  sBusy.next && sBusy.next.summary === '1:1 with Dana' &&
  sFree.state === 'available' &&
  sFree.current === null &&
  sFree.next && sFree.next.summary === '1:1 with Dana' &&
  sFree.freeUntil === Date.UTC(2026, 5, 18, 16, 0, 0) &&
  !!fold && !!esc;

console.log('--- assertions ---');
console.log('at 14:30Z  =>', sBusy.state, '|', sBusy.current && sBusy.current.summary, '| next:', sBusy.next && sBusy.next.summary);
console.log('at 15:30Z  =>', sFree.state, '| next:', sFree.next && sFree.next.summary);
console.log('folded summary parsed:', !!fold, '("1:1 with Dana")');
console.log('escaped summary parsed:', !!esc, '("Quarterly Retro, room A")');

console.log('\nRESULT:', ok ? 'PASS ✅' : 'FAIL ❌');
process.exit(ok ? 0 : 1);
