'use strict';

/*
 * Screen detail, Uptime Timeline vs Recent incidents. Found filming the troubleshooting guide: after
 * the screen came back, the timeline read "100% uptime (15min tracked)" with an all-green bar while
 * Recent incidents right below said "Connection lost, down 4m".
 *
 * The timeline coloured each 15-minute slot by its LAST status event, so a drop and recovery inside
 * one slot was drawn green, and the percentage was a count of green slots. Both panels now use one
 * offlinePeriods() helper, a slot with any downtime is drawn offline, and the percentage is by time.
 *
 * Also the Device clock card: it fell back to the `timezone` column's default 'UTC' for a screen
 * that had not reported its zone yet.
 *
 * The real functions run here from device-detail.js against a fake DOM.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'device-detail.js'), 'utf8');

function extract(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} not found`);
  let end = SRC.indexOf('{', at), depth = 0;
  for (; end < SRC.length; end++) {
    if (SRC[end] === '{') depth++;
    else if (SRC[end] === '}' && --depth === 0) { end++; break; }
  }
  return SRC.slice(at, end);
}

function load(nowSec) {
  const els = { uptimeTimeline: { innerHTML: '' }, uptimePercent: { textContent: '' }, incidentsPanel: { innerHTML: '' } };
  const box = {
    document: { getElementById: (id) => els[id] || null },
    Date: class extends Date { static now() { return nowSec * 1000; } },
    t: (k, v) => (v ? `${k}:${JSON.stringify(v)}` : k),
    esc: String,
    relTime: () => 'just now',
    module: {},
  };
  const names = ['offlinePeriods', 'renderUptimeTimeline', 'renderIncidents', 'eventLabel', 'incidentColor', 'formatDur', 'renderDeviceClock'];
  vm.runInNewContext(`${names.map(extract).join('\n')}\nmodule.exports = { ${names.join(', ')} };`, box);
  return { fns: box.module.exports, els };
}

const slotsOf = (html) => [...html.matchAll(/background:var\(--(\w+(?:-\w+)?)\)/g)].map((m) => m[1]);

test('a 4-minute drop inside one slot is drawn offline and counted, matching the incident', () => {
  // A screen paired 15 minutes ago (one slot of heartbeats), down for 4 of them.
  const now = 1_800_000_000;   // slots run back from now, so the last one is [now-900, now)
  const { fns, els } = load(now);
  const start = now - 15 * 60 + 60;
  const heartbeats = []; for (let ts = start; ts < now; ts += 15) heartbeats.push(ts);
  const log = [
    { status: 'online', timestamp: start },
    { status: 'offline', reason: 'transport_close', detail: null, timestamp: now - 8 * 60 },
    { status: 'online', timestamp: now - 4 * 60 },
  ];
  fns.renderUptimeTimeline(heartbeats, log);
  fns.renderIncidents([], log);

  const pct = JSON.parse(els.uptimePercent.textContent.split(':').slice(1).join(':'));
  assert.ok(pct.pct < 100, `uptime must not claim 100% (got ${pct.pct}%)`);
  assert.equal(pct.pct, Math.round(100 * (900 - 240) / 900));
  assert.ok(slotsOf(els.uptimeTimeline.innerHTML).includes('danger'), 'the slot with the drop is drawn offline');
  assert.match(els.uptimeTimeline.innerHTML, /transport_close/, 'with the cause in its hover title');
  assert.match(els.incidentsPanel.innerHTML, /"dur":"4m"/, 'Recent incidents says down 4m, as before');
});

test('no downtime stays 100% and green; an ongoing outage counts up to now', () => {
  const now = 1_800_000_000 - 1;
  {
    const { fns, els } = load(now);
    fns.renderUptimeTimeline([now - 600, now - 300], [{ status: 'online', timestamp: now - 700 }]);
    assert.match(els.uptimePercent.textContent, /"pct":100/);
    assert.ok(!slotsOf(els.uptimeTimeline.innerHTML).includes('danger'));
  }
  {
    // Online for 2 slots, offline for the last 10 minutes and not back yet.
    const { fns, els } = load(now);
    fns.renderUptimeTimeline([now - 1700, now - 1200], [
      { status: 'online', timestamp: now - 1790 },
      { status: 'offline', reason: null, timestamp: now - 600 },
    ]);
    assert.match(els.uptimePercent.textContent, new RegExp(`"pct":${Math.round(100 * (1800 - 600) / 1800)}`));
  }
});

test('Device clock: an unreported zone is "--", not the column default UTC', () => {
  const { fns } = load(1_800_000_000);
  assert.equal(fns.renderDeviceClock({ timezone: 'UTC', reported_timezone: null }), '--');
  assert.equal(fns.renderDeviceClock({ timezone: 'Europe/Paris', reported_timezone: null }), 'Europe/Paris', 'an operator override still shows');
  assert.equal(fns.renderDeviceClock({ timezone: 'UTC', reported_timezone: 'America/Noronha' }), 'America/Noronha');
});
