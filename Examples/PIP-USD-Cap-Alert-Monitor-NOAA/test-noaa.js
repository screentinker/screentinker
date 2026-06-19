const fs = require('fs');
const noaa = require('./noaa-parse');

const alerts = noaa.normaliseFeatureCollection(fs.readFileSync('./fixture-noaa.json', 'utf8'));
const byId = Object.fromEntries(alerts.map(a => [a.identifier, a]));

// "now" = 30s before the tornado's 1-minute expiry, so it's still active.
const now = Date.parse('2026-06-18T10:00:30-05:00');

console.log(`Parsed ${alerts.length} NWS alert(s):\n`);
for (const a of alerts) {
  const g = noaa.shouldShow(a, { minSeverity: 'Severe', now });
  console.log(`• ${a.event}  severity=${a.severity} urgency=${a.urgency} msgType=${a.msgType}`);
  console.log(`    expires=${a.expires}  => ${g.show ? 'SHOW' : 'skip'} (${g.reason})\n`);
}

// duration the player would receive for the tornado (seconds until expiry, capped)
function durFor(a, t) {
  if (!a.expires) return 0;
  const e = Date.parse(a.expires); if (!Number.isFinite(e)) return 0;
  return Math.max(0, Math.min(Math.floor((e - t) / 1000), 86400));
}
const tornado = byId['NWS-TEST-TORNADO-1'];
const dur = durFor(tornado, now);

// after the tornado expires, it must stop qualifying (self-removal path)
const later = Date.parse('2026-06-18T10:02:00-05:00');
const tornadoAfter = noaa.shouldShow(tornado, { minSeverity: 'Severe', now: later });

const shown = alerts.filter(a => noaa.shouldShow(a, { minSeverity: 'Severe', now }).show).map(a => a.event);
const ok =
  shown.length === 2 &&
  shown.includes('Tornado Warning') &&
  shown.includes('Winter Storm Warning') &&
  noaa.shouldShow(byId['NWS-TEST-FLOOD-2'], { minSeverity: 'Severe', now }).reason.includes('below') &&
  noaa.shouldShow(byId['NWS-TEST-CANCEL-4'], { minSeverity: 'Severe', now }).reason === 'cancelled' &&
  dur === 30 &&
  tornadoAfter.show === false && tornadoAfter.reason === 'expired';

console.log('--- assertions ---');
console.log('shows (Severe+):', shown.join(', '));
console.log('Flood Advisory (Minor) filtered:', noaa.shouldShow(byId['NWS-TEST-FLOOD-2'], { minSeverity: 'Severe', now }).reason);
console.log('Cancel filtered:', noaa.shouldShow(byId['NWS-TEST-CANCEL-4'], { minSeverity: 'Severe', now }).reason);
console.log(`tornado overlay duration the player gets: ${dur}s (auto-clears at expiry)`);
console.log('after expiry, tornado stops qualifying:', tornadoAfter.show === false, `(${tornadoAfter.reason})`);
console.log('\nRESULT:', ok ? 'PASS ✅' : 'FAIL ❌');
process.exit(ok ? 0 : 1);
