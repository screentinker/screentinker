'use strict';

/*
 * GET /api/devices/:id and embedded diagnostic logs (#638 review). Real schema.
 *
 *   - no per-IP limiter on the core device read (it throttled an office of dashboards behind one
 *     NAT, and the public API walking a fleet);
 *   - only the NEWEST upload's metadata is inlined, not ten full bodies of up to 256 kB each;
 *     GET /:id/diagnostic-logs serves the bodies;
 *   - the upload's socket event carries metadata, not the body, to every dashboard in the workspace.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const sent = [];
const io = { of: () => ({ to: (room) => ({ emit: (event, payload) => sent.push({ room, event, payload }) }) }) };
const h = require('./helpers/embedded-real-db').boot({
  configure(app) {
    app.set('io', io);
    const { requireAuth } = require('../middleware/auth');
    app.use('/api/devices', requireAuth, require('../routes/devices'));
  },
});
after(() => h.close());

async function upload(base, p, n) {
  const logs = Array.from({ length: n }, (_, i) => ({ level: 'INFO', msg: `line ${i} ` + 'x'.repeat(200) }));
  const res = await fetch(`${base}/logs?device_id=${p.id}`, {
    method: 'POST', headers: { Authorization: `Bearer ${p.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ logs }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).id;
}

test('GET /api/devices/:id inlines only the newest upload\'s metadata; /diagnostic-logs has the bodies', async () => {
  const base = await h.ready();
  const api = base.replace('/api/embedded', '/api/devices');
  const auth = { Authorization: `Bearer ${h.sessionToken()}` };
  const p = await h.mkPanel('seeed-reterminal-e1001');

  let res = await fetch(`${api}/${p.id}`, { headers: auth });
  assert.equal(res.status, 200);
  let dev = await res.json();
  assert.equal(dev.diagnostic_logs_latest, null, 'nothing uploaded yet');

  await upload(base, p, 3);
  const newest = await upload(base, p, 5);
  res = await fetch(`${api}/${p.id}`, { headers: auth });
  dev = await res.json();
  assert.equal(dev.diagnostic_logs, undefined, 'no inlined bodies');
  assert.deepEqual(Object.keys(dev.diagnostic_logs_latest).sort(), ['count', 'created_at', 'id', 'size']);
  assert.equal(dev.diagnostic_logs_latest.id, newest);
  assert.equal(dev.diagnostic_logs_latest.count, 5);
  assert.ok(dev.diagnostic_logs_latest.size > 1000);
  assert.ok(!JSON.stringify(dev).includes('line 0 '), 'no log text in the device read');

  const logs = await (await fetch(`${api}/${p.id}/diagnostic-logs`, { headers: auth })).json();
  assert.equal(logs.logs[0].id, newest);
  assert.equal(JSON.parse(logs.logs[0].log_json).logs.length, 5);
});

test('GET /api/devices/:id has no per-IP rate limit of its own', async () => {
  const base = await h.ready();
  const api = base.replace('/api/embedded', '/api/devices');
  const auth = { Authorization: `Bearer ${h.sessionToken()}` };
  const p = await h.mkPanel('waveshare-7.5in-v2');
  let last;
  for (let i = 0; i < 310; i++) last = await fetch(`${api}/${p.id}`, { headers: auth });
  assert.equal(last.status, 200, 'the 310th read in a minute is still served');
  // Only the app-wide abuse backstop (lib/backstop-limiter.js) applies, not a 300/min route ceiling.
  assert.ok(!/^300;/.test(last.headers.get('ratelimit-policy') || ''), `policy ${last.headers.get('ratelimit-policy')}`);
});

test('the upload socket event carries metadata only', async () => {
  const base = await h.ready();
  const p = await h.mkPanel('seeed-reterminal-e1001');
  sent.length = 0;
  const id = await upload(base, p, 4);
  const ev = sent.find((e) => e.event === 'dashboard:embedded-logs');
  assert.ok(ev, 'dashboard:embedded-logs emitted');
  assert.equal(ev.payload.id, id);
  assert.equal(ev.payload.log_count, 4);
  assert.equal(ev.payload.logs, undefined, 'no log body on the socket');
  assert.ok(!JSON.stringify(ev.payload).includes('line 0 '));
});
