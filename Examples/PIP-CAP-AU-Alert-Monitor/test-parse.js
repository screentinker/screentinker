const fs = require('fs');
const cap = require('./cap-parse');

const xml = fs.readFileSync('./fixture-feed.xml', 'utf8');
const alerts = cap.parseFeed(xml);

// A screen physically located inside the Emergency Warning area.
const SCREEN = { lat: -33.85, lon: 151.20 };
const now = Date.parse('2026-06-18T10:00:00+10:00');

console.log(`Parsed ${alerts.length} alert(s) from the EDXL envelope:\n`);
for (const a of alerts) {
  const g = cap.shouldShow(a, SCREEN, { now });
  console.log(`• ${a.headline}`);
  console.log(`    alertLevel=${a.alertLevel}  severity(CAP)=${a.severity}  msgType=${a.msgType}`);
  console.log(`    geometry: polygon=${a.polygon ? a.polygon.length + 'pts' : 'none'} circle=${a.circle ? a.circle.km + 'km' : 'none'}`);
  console.log(`    => ${g.show ? 'SHOW PiP' : 'skip'}  (${g.reason})\n`);
}

// Assertions
const byLevel = Object.fromEntries(alerts.map(a => [a.alertLevel, a]));
const results = alerts.map(a => ({ h: a.headline, show: cap.shouldShow(a, SCREEN, { now }).show }));
const shown = results.filter(r => r.show).map(r => r.h);

const expectShown = ['Test Ridge Road Fire'];
const ok =
  shown.length === 1 &&
  shown[0] === 'Test Ridge Road Fire' &&
  cap.shouldShow(byLevel['Planned Burn'], SCREEN, { now }).reason.includes('below threshold') &&
  cap.shouldShow(byLevel['Watch and Act'], SCREEN, { now }).reason === 'outside area';

console.log('--- assertions ---');
console.log('only the in-area Emergency Warning shows:', shown.join(', ') || '(none)');
console.log('planned burn filtered by threshold:', cap.shouldShow(byLevel['Planned Burn'], SCREEN, { now }).reason);
console.log('distant watch-and-act filtered by geofence:', cap.shouldShow(byLevel['Watch and Act'], SCREEN, { now }).reason);

// lat/lon flip sanity: the screen point must NOT be found if we naively swap to lon,lat
const swapped = { lat: SCREEN.lon, lon: SCREEN.lat };
const ew = byLevel['Emergency Warning'];
console.log('flip guard (swapped coords should be OUTSIDE):', cap.pointInAlertArea(swapped, ew) ? 'FAIL (matched)' : 'ok (no match)');

console.log('\nRESULT:', ok ? 'PASS ✅' : 'FAIL ❌');
process.exit(ok ? 0 : 1);
