'use strict';

// #825: the Samsung Tizen .wgt follows the server's opt-in offline schedule plan
// (offline.schedule_plan) while disconnected, the way Android (#819) and the SSSP3 player do,
// instead of replaying the last payload through a schedule gap.
//
// Two layers, both on the SHIPPED files:
//   - the real tizen/js/app.js booted in a vm with recording fakes for the renderers, a fake
//     socket.io, a Map-backed localStorage and a controllable clock. The media cache is the real
//     tizen/js/media-cache.js over an in-memory backend, so the cache gate is the real one.
//   - plans built by the real server builder (server/lib/offline-schedule-plan.js) for the DST and
//     overlap cases, so the device is checked against the authority that makes the UTC edges.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SCRIPTS = ['tizen/js/video-plan.js', 'tizen/js/media-cache.js', 'tizen/js/offline-plan.js',
  'tizen/js/offline-plan-tizen.js', 'tizen/js/capabilities.js', 'tizen/js/app.js'];

const H = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 11, 9, 0); // 09:00Z

const item = (id, extra) => Object.assign({ content_id: id, content_rev: 1, mime_type: 'video/mp4', filepath: id + '.mp4', duration_sec: 10 }, extra || {});
const standby = { content_id: 'standby', content_rev: 1, mime_type: 'image/jpeg', filepath: 'standby.jpg' };

// A 09-10 | gap 10-11 | B 11-12 | gap 12-13. The gap state is the server's unscheduled state:
// nothing assigned, the standby image as default content.
function abPlan(over) {
  return Object.assign({
    protocol_version: 1, generated_at_utc_ms: T0, valid_until_utc_ms: T0 + 4 * H, timezone: 'UTC',
    intervals: [
      { start_utc_ms: T0, end_utc_ms: T0 + H, schedule_id: 'sa', playlist_id: 'pa', layout_id: null },
      { start_utc_ms: T0 + H, end_utc_ms: T0 + 2 * H, schedule_id: null, playlist_id: null, layout_id: null },
      { start_utc_ms: T0 + 2 * H, end_utc_ms: T0 + 3 * H, schedule_id: 'sb', playlist_id: 'pb', layout_id: null },
      { start_utc_ms: T0 + 3 * H, end_utc_ms: T0 + 4 * H, schedule_id: null, playlist_id: null, layout_id: null },
    ],
    states: [
      { schedule_id: 'sa', playlist_id: 'pa', layout_id: null, payload: { assignments: [item('a')], orientation: 'landscape', default_content: standby } },
      { schedule_id: 'sb', playlist_id: 'pb', layout_id: null, payload: { assignments: [item('b')], orientation: 'landscape', default_content: standby } },
      { schedule_id: null, playlist_id: null, layout_id: null, payload: { assignments: [], orientation: 'landscape', default_content: standby } },
    ],
  }, over || {});
}

/* ------------------------------------------------------------------ harness ------------------ */

function rec(name, log, over) {
  const props = {};
  return new Proxy({}, {
    get(_, k) {
      if (over && k in over) return over[k];
      if (k in props) return props[k];
      if (typeof k === 'symbol' || k === 'then') return undefined;
      return (...a) => { log.push([name, k, a]); };
    },
    set(_, k, v) { props[k] = v; return true; },
  });
}

function makeEl(id) {
  const cls = new Set(['hidden']);
  return {
    id, style: {}, value: '', textContent: '', className: '', innerHTML: '', children: [],
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
    addEventListener() {}, removeEventListener() {}, focus() {}, appendChild(c) { return c; },
    setAttribute() {}, getAttribute() { return null; }, querySelectorAll() { return []; },
  };
}

function boot(opts) {
  opts = opts || {};
  const clock = { t: opts.now == null ? T0 : opts.now };
  const store = new Map(Object.entries(opts.storage || {}));
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { if (opts.quota && String(v).length > opts.quota) throw new Error('QuotaExceededError'); store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const log = [];
  const shown = [];   // every render the player or zone renderer was asked for
  const timeouts = [];
  const intervals = [];
  const sockets = [];
  const net = { online: true, missing: new Set(opts.missing || []) };
  const files = {};

  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(clock.t); }
    static now() { return clock.t; }
  }

  const els = {};
  const document = {
    getElementById: (id) => (id === 'screenOffOverlay' || id === 'infoOverlay' ? null : (els[id] = els[id] || makeEl(id))),
    createElement: (t) => makeEl(t), addEventListener() {}, querySelectorAll: () => [],
    body: makeEl('body'), visibilityState: 'visible', hidden: false,
  };

  function PlaylistPlayer() {
    return rec('player', log, {
      park: () => false,
      load(items) { shown.push({ via: 'player', ids: (items || []).map((x) => x.content_id), dc: this.defaultContent ? this.defaultContent.content_id : null }); },
    });
  }
  function ZoneRenderer() {
    return rec('zones', log, {
      render(layout, items) { shown.push({ via: 'zones', ids: (items || []).map((x) => x.content_id), dc: null }); },
    });
  }
  function WallZoneRenderer() { return rec('wallzones', log); }
  WallZoneRenderer.wanted = () => false;
  function WallController() { return rec('wall', log, { active: () => false }); }
  function GroupSyncController() { return rec('group', log); }
  function PipOverlay() { return rec('pip', log); }
  function OfflinePlayQueue() { return rec('plays', log, { size: () => 0, restore() {} }); }

  function io() {
    const handlers = {};
    const s = {
      connected: false, handlers, emitted: [],
      on(e, f) { handlers[e] = f; }, onAny() {}, io: { on() {} },
      emit(e, d) { s.emitted.push([e, d]); }, disconnect() { s.connected = false; },
    };
    sockets.push(s);
    return s;
  }

  const sandbox = {
    console: { log() {}, warn() {}, error() {} }, Date: FakeDate, JSON, Math, Promise, Object, Array, String, Number, Error, Uint8Array,
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; },
    clearTimeout: (h) => { if (timeouts[h - 1]) timeouts[h - 1].fn = null; },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: (h) => { if (intervals[h - 1]) intervals[h - 1].fn = null; },
    localStorage, document, navigator: { onLine: true, language: 'en' },
    location: { reload() {} },
    PlaylistPlayer, ZoneRenderer, WallZoneRenderer, WallController, GroupSyncController, PipOverlay, OfflinePlayQueue, io,
    XMLHttpRequest: function () {},
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  vm.createContext(sandbox);
  for (const f of SCRIPTS) {
    const src = read(f);
    if (f === 'tizen/js/app.js') {
      // The in-memory media backend replaces only the tizen.filesystem adapter; every decision
      // in MediaCache (and so the plan's cache gate) is the shipped code.
      sandbox.MediaCache.create = () => (opts.noStorage ? null : new sandbox.MediaCache({
        available: () => true,
        loadIndex: () => { try { return JSON.parse(localStorage.getItem('st_media_index') || '{}'); } catch (e) { return {}; } },
        saveIndex: (i) => localStorage.setItem('st_media_index', JSON.stringify(i)),
        httpRange: (url) => {
          const id = /\/api\/content\/([^/]+)\//.exec(url)[1];
          if (!net.online) return null;
          if (net.missing.has(id)) return { status: 404 };
          return { status: 200, total: 3, body: [1, 2, 3], validator: '"e"' };
        },
        appendPart: (id, body) => { files[id] = body.length; return body.length; },
        promotePart: (id) => ({ path: id, uri: 'file://' + id }),
        remove: (id) => { delete files[id]; },
      }));
    }
    vm.runInContext(src, sandbox, { filename: f });
  }

  const h = {
    sandbox, clock, store, shown, log, net, files,
    get socket() { return sockets[sockets.length - 1]; },
    last() { return shown[shown.length - 1]; },
    connect(payload) {
      const s = h.socket;
      s.connected = true;
      s.handlers.connect();
      s.handlers['device:registered']({ device_id: 'dev1', device_token: 'tok1', status: 'online' });
      if (payload) s.handlers['device:playlist-update'](payload);
    },
    disconnect() { h.socket.connected = false; h.socket.handlers.disconnect(); },
    live(payload) { h.socket.handlers['device:playlist-update'](payload); },
    // The deferred media sweep (setTimeout 2000 in onPlaylist), then the promise chain behind it.
    async sweep() {
      for (let round = 0; round < 3; round++) {
        const due = timeouts.filter((t) => t.fn && t.ms === 2000);
        for (const t of due) { const fn = t.fn; t.fn = null; fn(); }
        for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      }
    },
    // Advance the trusted clock, running the 1s offline driver as it would run.
    advance(ms, step) {
      step = step || 60 * 1000;
      const end = clock.t + ms;
      while (clock.t < end) {
        clock.t = Math.min(end, clock.t + step);
        for (const iv of intervals) if (iv.fn && iv.ms === 1000) iv.fn();
      }
    },
    declared() {
      const reg = h.socket.emitted.filter((e) => e[0] === 'device:register').pop();
      return reg && reg[1].capabilities;
    },
  };
  return h;
}

const PAIRED = { st_server_url: 'https://cms.example', st_device_id: 'dev1', st_device_token: 'tok1' };
const livePayload = (plan, extra) => Object.assign({ assignments: [item('a')], orientation: 'landscape', default_content: standby, timezone: 'UTC' },
  plan === undefined ? {} : { offline_plan: plan }, extra || {});

// Pair, receive a live payload carrying a plan, and let the cache gate commit it.
async function withCommittedPlan(plan, opts) {
  const h = boot(Object.assign({ storage: PAIRED }, opts || {}));
  h.connect(livePayload(plan));
  await h.sweep();
  return h;
}

/* ------------------------------------------------------------------ tests --------------------- */

test('the shared plan selector ships byte-identical to the SSSP3 STOfflinePlan', () => {
  assert.equal(read('tizen/js/offline-plan.js'), read('samsung-sssp3/app/offline-plan.js'),
    'tizen/js/offline-plan.js drifted from samsung-sssp3/app/offline-plan.js; re-copy it (build-wgt.sh does)');
  assert.match(read('tizen/build-wgt.sh'), /cp \.\.\/samsung-sssp3\/app\/offline-plan\.js js\/offline-plan\.js/);
  const html = read('tizen/index.html');
  assert.ok(html.indexOf('js/offline-plan.js') > 0 && html.indexOf('js/offline-plan.js') < html.indexOf('js/offline-plan-tizen.js')
    && html.indexOf('js/offline-plan-tizen.js') < html.indexOf('js/app.js'), 'both plan modules load before app.js');
});

test('a panel with persistent storage declares offline.schedule_plan; one without declares neither offline capability', () => {
  const h = boot({ storage: PAIRED });
  h.connect();
  assert.ok(h.declared().includes('offline.cache'));
  assert.ok(h.declared().includes('offline.schedule_plan'));
  const n = boot({ storage: PAIRED, noStorage: true });
  n.connect();
  assert.equal(n.declared().includes('offline.cache'), false);
  assert.equal(n.declared().includes('offline.schedule_plan'), false, 'no media cache, no plan claim');
});

test('a plan is committed only after every media item it references is cached, and never stored in the payload cache', async () => {
  const h = boot({ storage: PAIRED });
  h.connect(livePayload(abPlan()));
  assert.equal(h.store.get('st_offline_plan'), undefined, 'not committed before the media is on disk');
  assert.equal(JSON.parse(h.store.get('st_payload_cache')).offline_plan, undefined, 'the plan never rides in st_payload_cache');
  await h.sweep();
  const saved = JSON.parse(h.store.get('st_offline_plan'));
  assert.equal(saved.intervals.length, 4);
  for (const id of ['a', 'b', 'standby']) assert.ok(h.files[id], `${id} pre-cached before commit`);
});

test('cold boot inside a gap shows the gap state, not the last cached playlist', async () => {
  const first = await withCommittedPlan(abPlan());
  // Power off at 09:30 showing A; power back on at 10:30, in the gap, with no server.
  const h = boot({ storage: Object.fromEntries(first.store), now: T0 + 1.5 * H });
  assert.deepEqual(h.shown.map((s) => s.ids), [[]], 'exactly one render, with nothing assigned');
  assert.equal(h.last().dc, 'standby', 'the gap shows the default content');
});

test('cold boot inside B shows B even though the last cached payload was A', async () => {
  const first = await withCommittedPlan(abPlan());
  const h = boot({ storage: Object.fromEntries(first.store), now: T0 + 2.5 * H });
  assert.deepEqual(h.shown.map((s) => s.ids), [['b']]);
});

test('disconnected, the panel walks A, gap, B, gap at the plan boundaries', async () => {
  const h = await withCommittedPlan(abPlan());
  h.clock.t = T0 + 30 * 60 * 1000;
  h.live(livePayload(abPlan()));
  const before = h.shown.length;
  h.disconnect();
  h.advance(30 * 60 * 1000 - 1000, 1000);
  assert.equal(h.shown.length, before, 'no reload inside the interval the live server put on screen');
  h.advance(1000, 1000);   // exactly 10:00
  assert.deepEqual(h.last().ids, [], 'gap at 10:00');
  assert.equal(h.last().dc, 'standby');
  h.advance(H);
  assert.deepEqual(h.last().ids, ['b'], 'B at 11:00');
  h.advance(H);
  assert.deepEqual(h.last().ids, [], 'gap at 12:00');
  assert.deepEqual(h.shown.slice(before).map((s) => s.ids), [[], ['b'], []], 'one render per boundary, nothing between');
});

test('a gap plays the unscheduled base playlist when the server resolved one', async () => {
  const plan = abPlan();
  plan.states[2].payload = { assignments: [item('base')], orientation: 'landscape', default_content: standby };
  const h = await withCommittedPlan(plan);
  assert.ok(h.files.base, 'the base playlist is a plan dependency too');
  h.disconnect();
  h.advance(H);
  assert.deepEqual(h.last().ids, ['base']);
});

test('an incomplete replacement plan keeps the last complete plan', async () => {
  const h = await withCommittedPlan(abPlan());
  const committed = h.store.get('st_offline_plan');
  // The new plan swaps B for C, and C cannot be fetched.
  const next = abPlan();
  next.states[1] = { schedule_id: 'sc', playlist_id: 'pc', layout_id: null, payload: { assignments: [item('c')], orientation: 'landscape', default_content: standby } };
  next.intervals[2].schedule_id = 'sc';
  h.net.missing.add('c');
  h.live(livePayload(next));
  await h.sweep();
  assert.equal(h.store.get('st_offline_plan'), committed, 'the stored plan is still the verified one');
  assert.ok(h.files.b, 'and its media was not evicted for the plan that could not be cached');
  h.disconnect();
  h.advance(2 * H);
  assert.deepEqual(h.last().ids, ['b'], 'offline, the panel follows the complete plan');
  // Once C arrives, the next plan commits.
  h.net.missing.delete('c');
  h.connect(livePayload(next));
  await h.sweep();
  assert.equal(JSON.parse(h.store.get('st_offline_plan')).states[1].schedule_id, 'sc');
});

test('a plan the store refuses to hold leaves the previous plan in place', async () => {
  const h = await withCommittedPlan(abPlan());
  const committed = h.store.get('st_offline_plan');
  const big = abPlan();
  big.states[0].payload.assignments[0].meta = { pad: 'x'.repeat(5000) };
  big.intervals[0].playlist_id = 'pa2';
  const quota = boot({ storage: Object.fromEntries(h.store), quota: 4000 });
  quota.connect(livePayload(big));
  await quota.sweep();
  assert.equal(quota.store.get('st_offline_plan'), committed);
});

test('reconnecting, the live server payload wins over the plan', async () => {
  const h = await withCommittedPlan(abPlan());
  h.disconnect();
  h.advance(H);
  assert.deepEqual(h.last().ids, []);
  // The operator assigned something new while the panel was offline.
  h.connect(livePayload(abPlan(), { assignments: [item('fresh')] }));
  assert.deepEqual(h.last().ids, ['fresh']);
  h.advance(10 * 60 * 1000, 1000);
  assert.deepEqual(h.last().ids, ['fresh'], 'the plan does not override a connected screen');
});

test('an explicit null plan (override, emergency, mandate) clears the stored plan', async () => {
  const h = await withCommittedPlan(abPlan());
  h.live(livePayload(null, { assignments: [item('emergency')] }));
  assert.equal(h.store.get('st_offline_plan'), undefined);
  h.disconnect();
  h.advance(3 * H);
  assert.deepEqual(h.last().ids, ['emergency'], 'offline, the override stays: no plan resurrects the schedule');
});

test('a suspended screen is not handed back by the plan while offline', async () => {
  const h = await withCommittedPlan(abPlan());
  h.live({ assignments: [], suspended: true, message: 'Suspended' });
  assert.equal(h.store.get('st_offline_plan'), undefined);
  const before = h.shown.length;
  h.disconnect();
  h.advance(3 * H);
  assert.equal(h.shown.length, before);
});

test('unpairing clears the plan', async () => {
  const h = await withCommittedPlan(abPlan());
  h.socket.handlers['device:unpaired']({ reason: 'deleted' });
  assert.equal(h.store.get('st_offline_plan'), undefined);
  const again = boot({ storage: Object.fromEntries(h.store), now: T0 + 2.5 * H });
  assert.equal(again.shown.length, 0, 'nothing from the old pairing plays at boot');
});

test('an auth revocation clears the plan', async () => {
  const h = await withCommittedPlan(abPlan());
  h.socket.handlers['device:auth-error']({ error: 'revoked' });
  assert.equal(h.store.get('st_offline_plan'), undefined);
});

test('an expired plan falls back to replaying the last payload, exactly as before', async () => {
  const first = await withCommittedPlan(abPlan());
  const h = boot({ storage: Object.fromEntries(first.store), now: T0 + 5 * H });
  assert.deepEqual(h.shown.map((s) => s.ids), [['a']], 'the A2 replay');
});

test('a malformed stored plan is ignored and the legacy replay runs', () => {
  const h = boot({ storage: Object.assign({}, PAIRED, { st_offline_plan: '{not json', st_payload_cache: JSON.stringify(livePayload()) }) });
  assert.deepEqual(h.shown.map((s) => s.ids), [['a']]);
});

test('a screen that never receives a plan behaves exactly as before', async () => {
  // The server strips offline_plan for a panel that did not declare the capability.
  const cached = livePayload(undefined, { assignments: [item('a')] });
  const h = boot({ storage: Object.assign({}, PAIRED, { st_payload_cache: JSON.stringify(cached) }) });
  assert.deepEqual(h.shown.map((s) => s.ids), [['a']], 'cold boot replays the cached payload');
  h.connect(livePayload(undefined));
  assert.equal(h.store.get('st_payload_cache'), JSON.stringify(livePayload(undefined)), 'the payload cache holds the payload verbatim');
  await h.sweep();
  assert.deepEqual(Object.keys(h.files).sort(), ['a'], 'the media sweep fetches only the payload\'s own items');
  assert.equal(h.store.get('st_offline_plan'), undefined);
  const before = h.shown.length;
  h.disconnect();
  h.advance(6 * H);
  assert.equal(h.shown.length, before, 'offline, the last payload stays on screen: nothing switches');
});

test('a panel without storage carries no plan code path at all', () => {
  const h = boot({ storage: Object.assign({}, PAIRED, { st_offline_plan: JSON.stringify(abPlan()), st_payload_cache: JSON.stringify(livePayload()) }), noStorage: true, now: T0 + 1.5 * H });
  assert.deepEqual(h.shown.map((s) => s.ids), [['a']], 'a stale plan cannot steer a panel that does not declare it');
  assert.equal(h.store.get('st_offline_plan'), undefined, 'and is removed');
  assert.equal(h.sandbox.__stOfflinePlan, null);
});

/* ---------------- plans from the real server builder ---------------- */

const { build } = require('../lib/offline-schedule-plan');
const { makeClock } = require('../lib/local-clock');
const { isScheduleActiveAt } = require('../services/scheduler');

function serverPlan(schedules, timezone, now, horizonMs) {
  const plan = build({ schedules, timezone, now, horizonMs, clock: makeClock(timezone),
    pickAt: (rows, local) => rows.find((row) => isScheduleActiveAt(row, local)) || null });
  const states = [{ schedule_id: null, playlist_id: null, layout_id: null, payload: { assignments: [], default_content: standby } }];
  for (const s of schedules) states.push({ schedule_id: s.id, playlist_id: s.playlist_id, layout_id: null, payload: { assignments: [item(s.playlist_id)] } });
  return Object.assign({}, plan, { states });
}

test('across a DST change the panel switches at the server-resolved UTC edges', async () => {
  // Daily 07:00-08:00 New York. DST starts 2026-03-08, so 07:00 local is 12:00Z before and 11:00Z after.
  const sched = { id: 'breakfast', playlist_id: 'bk', recurrence: 'FREQ=DAILY', start_time: '2026-03-01T07:00:00', end_time: '2026-03-01T08:00:00' };
  const start = Date.parse('2026-03-07T00:00:00Z');
  const plan = serverPlan([sched], 'America/New_York', start, 3 * 24 * H);
  const h = await withCommittedPlan(plan, { now: start });
  h.disconnect();
  const at = (iso) => { h.advance(Date.parse(iso) - h.clock.t, 60 * 1000); return h.last().ids.join(','); };
  assert.equal(at('2026-03-07T12:30:00Z'), 'bk', 'EST: 07:30 local');
  assert.equal(at('2026-03-07T13:30:00Z'), '', 'EST: 08:30 local is the gap');
  assert.equal(at('2026-03-08T11:30:00Z'), 'bk', 'EDT: 07:30 local, one UTC hour earlier');
  assert.equal(at('2026-03-08T12:30:00Z'), '', 'EDT: 08:30 local');
});

test('overlapping schedules follow the server verdict, not whichever ended last', async () => {
  // All-day "base" 09-17 under a higher-priority lunch 12-13: the resolver lists the
  // higher priority first, and the plan is built from that order.
  const lunch = { id: 'lunch', playlist_id: 'menu', start_time: '2026-11-11T12:00:00', end_time: '2026-11-11T12:59:00' };
  const day = { id: 'day', playlist_id: 'brand', start_time: '2026-11-11T09:00:00', end_time: '2026-11-11T16:59:00' };
  const start = Date.UTC(2026, 10, 11, 8, 0);
  const plan = serverPlan([lunch, day], 'UTC', start, 10 * H);
  const h = await withCommittedPlan(plan, { now: start });
  h.disconnect();
  const at = (hh, mm) => { h.advance(Date.UTC(2026, 10, 11, hh, mm) - h.clock.t, 60 * 1000); return h.last().ids.join(','); };
  assert.equal(at(9, 30), 'brand');
  assert.equal(at(12, 30), 'menu', 'the overlap shows the winning schedule');
  assert.equal(at(13, 30), 'brand', 'and the covered schedule resumes after it, not a gap');
  assert.equal(at(17, 30), '', 'gap after both');
});

test('the boundary uses the trusted server-clock offset, not the raw device clock', async () => {
  // The TV clock runs 5 minutes slow; the heartbeat-ack taught the player the offset.
  const h = await withCommittedPlan(abPlan(), { storage: Object.assign({}, PAIRED, { st_clock_offset: String(5 * 60 * 1000) }) });
  h.disconnect();
  h.clock.t = T0 + H - 5 * 60 * 1000 - 1000;   // device 09:54:59 = server 09:59:59
  h.advance(0);
  h.advance(1000, 1000);                        // server 10:00:00
  assert.deepEqual(h.last().ids, [], 'switched to the gap at the server\'s 10:00');
});
