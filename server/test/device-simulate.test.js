'use strict';

/*
 * "What will this screen show at…?" — the answers, at the edges where forecasts go wrong.
 *
 * The server's own clock is deliberately set to a zone none of the screens use (Auckland, which is
 * also on the opposite DST calendar), so any place the simulator leaks the SERVER's zone into a
 * screen's rules shows up as a wrong answer rather than a coincidence.
 */

process.env.TZ = 'Pacific/Auckland';
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-sim-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { db } = require('../db/database');
const fixture = require('../test/helpers/simulate-fixture');
const setupDeviceSocket = require('../ws/deviceSocket');
const scheduler = require('../services/scheduler');
const ScheduleEval = require('../lib/schedule-eval');
const PowerWindow = require('../lib/power-window');
const sim = require('../lib/device-simulate');

let f, io, srv;
before(() => {
  f = fixture.build(db);
  srv = http.createServer(); io = new Server(srv); setupDeviceSocket(io);
});
after(() => { try { io.close(); } catch { /* */ } });

const T = (iso) => Date.parse(iso);
const at = (name, iso, opts) => sim.simulate(f.devices[name], T(iso), opts);
const itemsOf = (r) => Object.fromEntries(r.items.map((i) => [i.label, i.reason || 'plays']));

/* ------------------------------ the clock ------------------------------ */

test('the fast clock agrees with schedule-eval to the minute, across DST in both directions', () => {
  const zones = [null, 'America/New_York', 'Europe/Berlin', 'Australia/Sydney', 'Australia/Lord_Howe', 'Asia/Kathmandu', 'Pacific/Chatham'];
  // US spring-forward, EU spring-forward, AU fall-back (Sydney + Lord Howe's half hour), US fall-back.
  const days = ['2026-03-08T00:00:00Z', '2026-03-29T00:00:00Z', '2026-04-04T12:00:00Z', '2026-11-01T00:00:00Z'];
  let n = 0;
  for (const z of zones) {
    const clock = sim.makeClock(z);
    for (const d of days) {
      for (let ms = T(d); ms < T(d) + 30 * 3600 * 1000; ms += 60 * 1000) {
        assert.deepEqual(clock(ms), ScheduleEval._localParts(new Date(ms), z), `${z} at ${new Date(ms).toISOString()}`);
        n++;
      }
    }
  }
  assert.ok(n > 40000);
});

/* ------------------------- verdicts equal the player's ------------------------- */

test('itemVerdict plays exactly when the players\' itemShouldPlay does', () => {
  const items = [
    {},
    { enabled: 0 },
    { schedules: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }] },
    { schedules: [{ days: [5], start: '22:00', end: '02:00' }] },
    { schedules: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00', start_date: '2026-03-09', end_date: '2026-03-10' }] },
    { play_from: '2026-03-08T02:30', play_until: '2026-03-09T09:15' },
    { play_until: 'garbage' },
    { play_when: { type: 'tag', op: 'has', value: 'menu' }, tags: ['Menu'] },
    { play_when: { type: 'tag', op: 'lacks', value: 'menu' }, tags: ['menu'] },
    { play_when: { slug: 'x', path: 'n', op: 'gt', value: 3 }, _ds: { n: 2 } },
    { schedules: [null] },
  ];
  const zones = ['America/New_York', 'Europe/Berlin', null];
  let n = 0;
  for (const z of zones) {
    const clock = sim.makeClock(z);
    for (let ms = T('2026-03-06T00:00:00Z'); ms < T('2026-03-11T00:00:00Z'); ms += 23 * 60 * 1000) {
      for (const it of items) {
        assert.equal(sim.itemVerdict(it, clock(ms)) === null, ScheduleEval.itemShouldPlay(it, new Date(ms), z),
          `${JSON.stringify(it)} in ${z} at ${new Date(ms).toISOString()}`);
        n++;
      }
    }
  }
  assert.ok(n > 3000);
});

test('powerOffAt is the players\' PowerWindow.isOff', () => {
  const schedules = [
    { timezone: 'America/New_York', windows: [{ days: [1, 2, 3, 4, 5], start: '22:00', end: '06:00' }] },
    { timezone: 'Europe/Berlin', windows: [{ days: [0, 6], start: '00:00', end: '24:00' }] },
    { timezone: 'Europe/Berlin', enabled: false, windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' }] },
    { timezone: 'Asia/Tokyo', windows: [{ days: [1], start: '25:00', end: '06:00' }, { days: [1], start: '12:00', end: '13:00' }] },
  ];
  for (const s of schedules) {
    const clock = sim.makeClock(s.timezone);
    for (let ms = T('2026-03-06T00:00:00Z'); ms < T('2026-03-11T00:00:00Z'); ms += 17 * 60 * 1000) {
      assert.equal(sim.powerOffAt(s, clock(ms)), PowerWindow.isOff(s, new Date(ms)), `${JSON.stringify(s)} at ${new Date(ms).toISOString()}`);
    }
  }
});

/* ------------------------------ the answers ------------------------------ */

test('DST: a 07:00 New York breakfast schedule starts at 12:00Z before the change and 11:00Z after', () => {
  // Friday 6 March (EST, UTC-5).
  assert.equal(at('own', '2026-03-06T11:59:00Z').resolved.source, 'device');
  assert.equal(at('own', '2026-03-06T12:00:00Z').active_schedule.title, 'breakfast');
  // Monday 9 March (EDT, UTC-4) — the change was Sunday 8 March.
  assert.equal(at('own', '2026-03-09T10:59:00Z').resolved.source, 'device');
  const r = at('own', '2026-03-09T11:00:00Z');
  assert.equal(r.active_schedule.title, 'breakfast');
  assert.equal(r.local.schedule, '2026-03-09T07:00', 'reported in the screen\'s own wall clock');
  // The schedule's end minute is inclusive (the scheduler's <=); the item daypart's is exclusive.
  const last = at('own', '2026-03-09T14:30:00Z');
  assert.equal(last.active_schedule.title, 'breakfast');
  assert.equal(itemsOf(last)['a.jpg'], 'daypart', 'the 07:00-10:30 item daypart has ended at 10:30');
  assert.equal(at('own', '2026-03-09T14:31:00Z').resolved.source, 'device');
});

test('device timezone, not the server\'s, decides — and a screen with no zone is flagged', () => {
  const own = at('own', '2026-03-09T11:00:00Z');
  assert.equal(own.timezone, 'America/New_York');
  assert.equal(own.timezone_assumed, false);
  const noTz = at('no_tz', '2026-03-09T11:00:00Z');
  assert.equal(noTz.timezone, null);
  assert.equal(noTz.timezone_assumed, true, 'the forecast says it is guessing the zone');
  assert.equal(noTz.local.items, '2026-03-10T00:00', 'a zone-less screen uses the server clock (Auckland here), as the live rules do');
});

test('a wall panel follows its wall\'s schedule on the leader\'s clock, not its own zone', () => {
  // Saturday 7 March, 17:30 Chicago (CST, UTC-6) = 23:30Z; panel b reports Tokyo (Sunday 08:30 there).
  const a = at('wall_a', '2026-03-07T23:30:00Z'), b = at('wall_b', '2026-03-07T23:30:00Z');
  assert.equal(a.active_schedule.title, 'wall_eve');
  assert.equal(b.active_schedule.title, 'wall_eve', 'both panels switch together');
  assert.equal(b.schedule_timezone, 'America/Chicago');
  assert.equal(at('wall_b', '2026-03-08T01:01:00Z').resolved.source, 'wall', 'and back to the wall playlist after 19:00');
});

test('overlapping schedules: a device schedule beats any group one; between groups, priority wins', () => {
  // grouped reports Berlin (UTC+1). 13:35 local: Low 12-14 (p1), High 13-15 (p9) and the device's
  // own 13:30-13:45 are all live.
  const r = at('grouped', '2026-03-09T12:35:00Z');
  assert.equal(r.active_schedule.title, 'grouped_dev');
  const st = Object.fromEntries(r.schedules.map((s) => [s.title, s.state]));
  assert.deepEqual(st, { grouped_dev: 'won', group_hi: 'outranked', group_lo: 'outranked' });
  assert.equal(at('grouped', '2026-03-09T12:50:00Z').active_schedule.title, 'group_hi', 'priority 9 beats priority 1');
  assert.equal(at('grouped', '2026-03-09T11:30:00Z').active_schedule.title, 'group_lo');
  const later = at('grouped', '2026-03-09T15:00:00Z');
  assert.equal(later.active_schedule, null);
  assert.equal(later.resolved.source, 'group');
  assert.equal(later.resolved.playlist_name, 'GroupHigh', 'with no schedule, the higher-priority group playlist');
  const trail = later.fallback.map((s) => s.code);
  assert.deepEqual(trail, ['group', 'group_lower']);
});

test('equal-priority groups: the older group wins, and the trail says the other was outranked', () => {
  const r = at('tie', '2026-03-12T00:00:00Z');
  assert.equal(r.resolved.playlist_name, 'Promo');
  assert.deepEqual(r.fallback.map((s) => [s.code, s.group]), [['group', 'TieOld'], ['group_lower', 'TieNew']]);
  assert.equal(r.schedules.find((s) => s.title === 'campaign').state, 'ended');
  assert.ok(!r.schedules.some((s) => s.title === 'disabled'), 'a disabled schedule is not a candidate at all');
});

test('a one-off campaign: not started, running, ended (in the screen\'s Sydney clock)', () => {
  assert.equal(at('tie', '2026-03-06T21:59:00Z').schedules.find((s) => s.title === 'campaign').state, 'not_started');
  assert.equal(at('tie', '2026-03-06T22:00:00Z').active_schedule.title, 'campaign');   // 09:00 AEDT
  assert.equal(at('tie', '2026-03-09T06:00:00Z').active_schedule.title, 'campaign');   // 17:00, inclusive
  assert.equal(at('tie', '2026-03-09T06:01:00Z').active_schedule, null);
});

test('expiry boundary: content stops at its expiry second, not a minute later', () => {
  const before = at('raw', '2026-03-10T11:59:59Z');
  assert.equal(itemsOf(before)['expiring.jpg'], 'plays');
  const after = at('raw', '2026-03-10T12:00:00Z');
  assert.equal(itemsOf(after)['expiring.jpg'], 'expired');
  assert.equal(after.items.find((i) => i.label === 'expiring.jpg').expired_at, '2026-03-10T12:00:00.000Z');
  assert.equal(after.playing, 1);
});

test('play window: not started, playing, ended — inclusive at the minute', () => {
  // GroupHigh's a.jpg runs 2026-03-05T09:00 .. 2026-03-12T18:00 Berlin; grouped has no schedule at 06:00Z.
  assert.equal(itemsOf(at('grouped', '2026-03-05T07:59:00Z'))['a.jpg'], 'not_started');
  assert.equal(itemsOf(at('grouped', '2026-03-05T08:00:00Z'))['a.jpg'], 'plays');
  assert.equal(itemsOf(at('grouped', '2026-03-12T17:00:00Z'))['a.jpg'], 'plays');
  assert.equal(itemsOf(at('grouped', '2026-03-12T17:01:00Z'))['a.jpg'], 'ended');
});

test('power schedule: off weeknights 22:00-06:00 New York, including the Friday night into Saturday', () => {
  assert.equal(at('own', '2026-03-10T03:30:00Z').power.off, true, 'Monday 23:30');
  assert.equal(at('own', '2026-03-10T11:00:00Z').power.off, false, 'Tuesday 07:00');
  assert.equal(at('own', '2026-03-07T10:00:00Z').power.off, true, 'Saturday 05:00 belongs to Friday night');
  assert.equal(at('own', '2026-03-08T10:00:00Z').power.off, false, 'Sunday morning: Saturday is not listed');
  // A screen whose player cannot switch its backlight is never reported as off.
  db.prepare(`INSERT INTO display_power_schedules (id, workspace_id, name, device_id, timezone, enabled, windows)
              VALUES (?, ?, 'x', ?, 'America/New_York', 1, ?)`)
    .run(crypto.randomUUID(), f.wsId, f.devices.raw, JSON.stringify([{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' }]));
  const r = at('raw', '2026-03-10T03:30:00Z');
  assert.equal(r.power.off, false);
  assert.equal(r.power.ignored, true, 'and the forecast says the schedule is ignored there');
});

test('a head office mandate outranks a live schedule; a dark mandate shows nothing', () => {
  const r = at('mandated', '2026-03-09T12:00:00Z');
  assert.equal(r.resolved.source, 'corporate');
  assert.equal(r.resolved.playlist_name, 'HQ');
  assert.equal(r.active_schedule, null);
  assert.equal(r.schedules.find((s) => s.title === 'under_mandate').state, 'mandate_overrides');
  const d = at('dark', '2026-03-09T12:00:00Z');
  assert.equal(d.resolved.source, 'corporate');
  assert.equal(d.resolved.playlist_id, null);
  assert.equal(d.fallback[0].code, 'mandate_dark');
});

test('"plays nothing" is respected — except while a schedule lights it', () => {
  const r = at('none_sched', '2026-03-09T21:00:00Z');   // 17:00 New York
  assert.equal(r.resolved.playlist_id, null);
  assert.equal(r.fallback[0].code, 'none_chosen');
  const lit = at('none_sched', '2026-03-09T22:30:00Z'); // 18:30
  assert.equal(lit.resolved.source, 'schedule');
  assert.equal(lit.resolved.playlist_name, 'Promo');
});

test('items this player cannot play are named, and weather can be asked "what if"', () => {
  db.prepare('UPDATE devices SET latitude = 52.5, longitude = 13.4 WHERE id = ?').run(f.devices.grouped);
  try {
    const now = at('grouped', '2026-03-09T08:00:00Z');
    assert.deepEqual(now.skipped.map((s) => [s.label, s.reason, s.capability || null]), [['stream.m3u8', 'unsupported', 'playback.hls']]);
    assert.equal(itemsOf(now)['umbrella.jpg'], 'plays', 'no reading: weather fails open, as live');
    const clear = at('grouped', '2026-03-09T08:00:00Z', { weather: { group: 'clear' } });
    assert.ok(clear.skipped.some((s) => s.label === 'umbrella.jpg' && s.reason === 'weather'));
    assert.equal(clear.weather.assumed, true);
    const rain = at('grouped', '2026-03-09T08:00:00Z', { weather: { group: 'rain' } });
    assert.equal(itemsOf(rain)['umbrella.jpg'], 'plays');
  } finally {
    db.prepare('UPDATE devices SET latitude = NULL, longitude = NULL WHERE id = ?').run(f.devices.grouped);
  }
});

test('the preview payload holds only what plays then, with the time gates off and nothing that acts on a LAN', () => {
  const p = sim.previewPayload(f.devices.own, T('2026-03-09T14:30:00Z'));   // 10:30: daypart item has ended
  assert.deepEqual(p.assignments.map((a) => a.filename), ['b.mp4']);
  for (const a of p.assignments) for (const k of ['schedules', 'play_from', 'play_until', 'play_when', '_ds']) assert.ok(!(k in a), k);
  assert.deepEqual(p.triggers, []);
  assert.equal(p.trigger_config, null);
  assert.equal(p.local_api, null);
  assert.deepEqual(p.endpoints, []);
  assert.equal(p.power_schedule, null);
  assert.equal(p.preview_at, '2026-03-09T14:30:00.000Z');
  assert.equal(sim.previewPayload(f.devices.own, T('2026-03-10T03:30:00Z')).preview_power_off, true);
});

/* ------------------------------ the timeline ------------------------------ */

// The same answer the slow way: every minute, with the canonical functions only.
function bruteForce(name, fromIso, toIso) {
  const ctx = sim.loadContext(f.devices[name]);
  const out = [];
  let prev = null;
  for (let ms = T(fromIso); ms < T(toIso); ms += 60 * 1000) {
    const active = scheduler.pickActiveSchedule(ctx.schedules, new Date(ms), ctx.scheduleTz);
    const sched = active ? { playlist_id: active.playlist_id || null, layout_id: active.layout_id || null } : { playlist_id: null, layout_id: null };
    const resolved = sim.resolveFromInputs(ctx.inputs, sched);
    const entry = [...ctx.payloads.values()].find((e) => e.key === `${sched.playlist_id || ''}|${sched.layout_id || ''}`)
      || sim.stateAt(ctx, ms).entry;
    const plays = entry.items.map((it) => {
      const exp = it.content_id ? entry.expiry.get(it.content_id) : undefined;
      if (exp !== undefined && exp <= ms) return false;
      return ScheduleEval.itemShouldPlay(it, new Date(ms), ctx.itemTz);
    });
    const off = !!(ctx.powerSupported && ctx.power && PowerWindow.isOff(ctx.power, new Date(ms)));
    const sig = `${resolved.playlist_id}|${off}|${plays.join(',')}|${active ? active.id : ''}`;
    if (sig !== prev) { out.push({ from: new Date(ms).toISOString(), playlist_id: resolved.playlist_id, power: off ? 'off' : 'on', playing: plays.filter(Boolean).length }); prev = sig; }
  }
  return out;
}

for (const name of ['own', 'grouped', 'tie', 'wall_b', 'raw']) {
  test(`timeline for "${name}" equals a minute-by-minute walk of the live rules (DST week)`, () => {
    const from = '2026-03-06T00:00:00Z', to = '2026-03-11T00:00:00Z';
    const tl = sim.timeline(f.devices[name], T(from), T(to));
    const got = tl.segments.map((s) => ({ from: s.from, playlist_id: s.playlist_id, power: s.power, playing: s.playing }));
    assert.deepEqual(got, bruteForce(name, from, to));
    // Contiguous and covering exactly the range.
    assert.equal(tl.segments[0].from, new Date(T(from)).toISOString());
    assert.equal(tl.segments[tl.segments.length - 1].to, new Date(T(to)).toISOString());
    for (let i = 1; i < tl.segments.length; i++) assert.equal(tl.segments[i].from, tl.segments[i - 1].to);
  });
}

test('a 14-day timeline is bounded and quick', () => {
  const t0 = Date.now();
  const tl = sim.timeline(f.devices.own, T('2026-03-01T00:00:00Z'), T('2026-03-30T00:00:00Z'));
  const took = Date.now() - t0;
  assert.equal(tl.truncated, true, 'a longer range is cut to 14 days, and says so');
  assert.equal(Date.parse(tl.to) - Date.parse(tl.from), sim.MAX_RANGE_MS);
  assert.ok(took < 3000, `took ${took} ms`);
});

/* ------------------------------ group + inputs ------------------------------ */

test('group variant: every member at one instant, and only members in the group\'s own workspace', () => {
  // A stray membership row pointing at another tenant's screen must not be followed.
  const otherWs = crypto.randomUUID();
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(otherWs, f.orgId, 'Other');
  const foreign = crypto.randomUUID();
  db.prepare("INSERT INTO devices (id, user_id, workspace_id, name, status) VALUES (?, ?, ?, 'Foreign', 'online')").run(foreign, f.userId, otherWs);
  db.prepare('INSERT INTO device_group_members (device_id, group_id) VALUES (?, ?)').run(foreign, f.groups.Low);
  const r = sim.simulateGroup(db, f.groups.Low, T('2026-03-09T11:30:00Z'));
  const names = r.devices.map((d) => d.name).sort();
  assert.deepEqual(names, ['grouped', 'none', 'stale_copy']);
  const g = r.devices.find((d) => d.name === 'grouped');
  assert.equal(g.schedule_title, 'group_lo');
});

test('inputs are validated', () => {
  assert.equal(sim.parseInstant('not a date'), null);
  assert.equal(sim.parseInstant('2099-01-01T00:00:00Z'), null, 'more than five years ahead');
  assert.equal(sim.parseInstant('', 42), 42, 'empty means "now" (the fallback)');
  assert.equal(sim.parseInstant('x'.repeat(100)), null);
  assert.equal(sim.parseWeather({ weather: 'hail' }), false);
  assert.equal(sim.parseWeather({ temp_c: 'warm' }), false);
  assert.deepEqual(sim.parseWeather({ weather: 'RAIN', temp_c: '12' }), { group: 'rain', temperature_c: 12 });
  assert.equal(sim.parseWeather({}), null);
});
