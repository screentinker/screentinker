'use strict';

// Offline unit test for the pure normalise()/colorFor()/overlayUri() logic. No network.
const { normalise, colorFor, overlayUri } = require('./server');

let ok = true;
const check = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) ok = false; };

// --- generic shape: firing -----------------------------------------------------------------
const gFire = normalise({ status: 'firing', key: 'db-down', title: 'Primary DB unreachable', detail: 'conn refused on 5432', severity: 'critical' });
check(gFire.length === 1, 'generic firing -> 1 incident');
check(gFire[0].key === 'db-down', 'generic key preserved');
check(gFire[0].state === 'firing', 'generic state=firing');
check(gFire[0].title === 'Primary DB unreachable', 'generic title');
check(gFire[0].severity === 'critical', 'generic severity');

// --- generic shape: resolved ---------------------------------------------------------------
const gRes = normalise({ status: 'RESOLVED', key: 'db-down' });
check(gRes[0].state === 'resolved', 'generic resolved (case-insensitive) -> state=resolved');
check(gRes[0].key === 'db-down', 'generic resolved key matches the firing key');

// --- Alertmanager shape: mixed firing + resolved -------------------------------------------
const am = normalise({
  status: 'firing',
  alerts: [
    { status: 'firing', fingerprint: 'abc123',
      labels: { alertname: 'HighCPU', severity: 'warning', instance: 'web-1' },
      annotations: { summary: 'CPU > 90%', description: 'web-1 hot for 5m' } },
    { status: 'resolved', fingerprint: 'def456',
      labels: { alertname: 'DiskFull', severity: 'critical' },
      annotations: { summary: 'Disk 99%', description: '/var almost full' } },
  ],
});
check(am.length === 2, 'alertmanager -> 2 incidents');
check(am[0].key === 'abc123' && am[0].state === 'firing', 'AM[0] fingerprint key + firing');
check(am[0].title === 'CPU > 90%' && am[0].detail === 'web-1 hot for 5m', 'AM[0] summary/description mapped');
check(am[0].severity === 'warning', 'AM[0] severity from labels');
check(am[1].key === 'def456' && am[1].state === 'resolved', 'AM[1] resolved per-alert status overrides group');
check(am[1].severity === 'critical', 'AM[1] severity critical');

// --- severity -> colour --------------------------------------------------------------------
check(colorFor('critical') === '7B0000', 'colour critical');
check(colorFor('warning') === 'E8730C', 'colour warning');
check(colorFor('info') === 'F2C200', 'colour info');
check(colorFor('weird') === 'CC0000', 'colour default fallback');
check(colorFor() === 'CC0000', 'colour missing -> default');

// --- overlay uri ---------------------------------------------------------------------------
const uri = overlayUri('https://x/incident-overlay.html', am[0], 'Alertmanager', '2026-06-18T10:00:00Z');
check(uri.startsWith('https://x/incident-overlay.html?'), 'uri keeps base + adds query');
check(/color=E8730C/.test(uri), 'uri carries severity colour');
check(/title=CPU/.test(uri), 'uri carries title');

console.log('\nRESULT:', ok ? 'PASS ✅' : 'FAIL ❌');
process.exit(ok ? 0 : 1);
