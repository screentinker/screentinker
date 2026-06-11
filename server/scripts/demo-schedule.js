#!/usr/bin/env node
// Local, headless demonstration of per-item scheduling (#74 dayparting + #75 expiry).
//   node scripts/demo-schedule.js
//
// Builds a 3-item playlist and shows, using the REAL shared evaluator
// (server/lib/schedule-eval.js) and the same "next active item" rule the three
// players use, exactly which items rotate at four moments. No server or browser
// needed - this is the deterministic proof. Live web-player repro steps are printed
// at the end (and in the feature report).
const { isItemActiveNow } = require('../lib/schedule-eval');

const TZ = 'Australia/Sydney'; // Bold Media's zone; set as the device timezone override

// 'Yesterday' relative to the demo's reference day (Fri 2026-06-12 in TZ) is 06-11;
// the expired item ends 06-10 so it is dead on the 12th and 13th.
const playlist = [
  { id: 'A', label: 'Dayparted promo  (Mon-Fri 09:00-17:00)', schedules: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', start_date: null, end_date: null }] },
  { id: 'B', label: 'Expired sale     (ended 2026-06-10)',     schedules: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00', start_date: null, end_date: '2026-06-10' }] },
  { id: 'C', label: 'Filler           (no schedule, always)',  schedules: [] },
];

function rotationAt(utcIso) {
  const active = playlist.filter(it => isItemActiveNow(it.schedules, utcIso, TZ));
  return active.length ? active.map(it => it.id).join(' -> ') : '(idle: "Nothing scheduled right now")';
}

const scenarios = [
  ['INSIDE the daypart window   (Fri 10:00 local)', '2026-06-12T00:00:00Z'],
  ['Window JUST opened          (Fri 09:00 local)', '2026-06-11T23:00:00Z'],
  ['OUTSIDE the window          (Fri 20:00 local)', '2026-06-12T10:00:00Z'],
  ['Weekend, window closed      (Sat 10:00 local)', '2026-06-13T00:00:00Z'],
];

console.log('\n  Per-item scheduling demo — device timezone = ' + TZ + '\n');
for (const it of playlist) console.log('    ' + it.id + '  ' + it.label);
console.log('\n  ' + 'Moment'.padEnd(48) + 'Items that rotate');
console.log('  ' + '-'.repeat(48) + '-----------------');
for (const [label, utc] of scenarios) {
  console.log('  ' + label.padEnd(48) + rotationAt(utc));
}
console.log('\n  Notes:');
console.log('   - B (expired) never appears on any day after 2026-06-10. (#75)');
console.log('   - Inside the window: filler C + dayparted A rotate. Outside: C only. (#74)');
console.log('   - The players re-evaluate at each item boundary, and re-check every 30s');
console.log('     while idle, so A appears within 30s of 09:00 local — controllable on a');
console.log('     test screen via the device timezone override.\n');

console.log('  Live web-player repro:');
console.log('   1. cd server && DATA_DIR=/tmp/st-demo SELF_HOSTED=true node server.js');
console.log('   2. Dashboard -> create a playlist with 3 items (any content); on item A open the');
console.log('      clock icon and add a block for the next few minutes in your screen\'s local time,');
console.log('      on item B set an end date of yesterday, leave C unscheduled. Publish.');
console.log('   3. Device detail -> set Timezone to ' + TZ + ' (or your zone) to control "local now".');
console.log('   4. Open /player on the paired screen: B never shows; outside A\'s window only C');
console.log('      plays; within 30s of A\'s window opening, A joins the rotation.\n');
