// Usage: node make-demo-alert.js [seconds] [outfile]
// Writes a NWS-shaped FeatureCollection with one Extreme alert expiring `seconds` from now
// (default 90). Point the monitor's config.test_feed_file at the output to watch show->expire.
const fs = require('fs');
const secs = parseInt(process.argv[2] || '90', 10);
const out = process.argv[3] || 'demo-noaa.json';
const now = new Date();
const expires = new Date(now.getTime() + secs * 1000);
const fc = {
  type: 'FeatureCollection',
  features: [{
    id: 'https://api.weather.gov/alerts/DEMO-EXPIRY-1', type: 'Feature', geometry: null,
    properties: {
      id: 'DEMO-EXPIRY-1', areaDesc: 'Demo County',
      sent: now.toISOString(), effective: now.toISOString(), onset: now.toISOString(),
      expires: expires.toISOString(), ends: expires.toISOString(),
      status: 'Actual', messageType: 'Alert', category: 'Met',
      severity: 'Extreme', certainty: 'Observed', urgency: 'Immediate',
      event: 'Tornado Warning', senderName: 'NWS Demo Office',
      headline: `DEMO alert — auto-clears at ${expires.toLocaleTimeString()}`, response: 'Shelter',
    },
  }],
};
fs.writeFileSync(out, JSON.stringify(fc, null, 2));
console.log(`wrote ${out}: DEMO Tornado Warning expiring in ${secs}s (at ${expires.toISOString()})`);
