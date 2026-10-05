'use strict';

/*
 * Collisions, the held set and the lease. docs/triggers-design.md §6, §7, §8.
 *
 * ⚠️ The failure this feature can produce that costs a site visit is a screen stuck showing the
 * wrong thing with the base playlist invisible behind it. Everything here is about that: what wins,
 * what comes back, and what stops holding when nobody is asserting it any more.
 *
 * Executed against the real engine with a controllable clock, because a state machine this small is
 * exactly the kind that reads correctly and behaves otherwise.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const TR = require('../lib/trigger-resolve.js');
const { makeDocument } = require('./helpers/fake-overlay-dom');

const PLAYER = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
const SECRET = 'p'.repeat(16);

const T = (over) => ({
  source_http: true, source_udp: false, mode: 'until_cleared', priority: 0,
  items: [{ content_id: 'c1', duration_sec: 5 }], ...over,
});

/** The engine with a fake clock and a fake renderer; no sockets are opened. */
function boot(triggers) {
  const start = PLAYER.indexOf('    let triggerActive = null;');
  const end = PLAYER.indexOf('    // ==================== PiP overlay');
  const src = PLAYER.slice(start, end);

  let now = 1_000_000;
  const timers = [];
  const rendered = [];
  const env = {
    window: { TriggerResolve: TR, __debugLog_push() {} },
    // A #pipContainer fake that models children, classNames and remove() — the previous inline
    // fake had no querySelectorAll, so scoped teardown threw, the throw escaped into the HTTP
    // handler, and the test hung instead of failing. See helpers/fake-overlay-dom.js.
    document: makeDocument(),
    console: { log() {}, warn() {} },
    // Controllable clock: intervals are collected and fired by hand, so a lease can expire in a
    // test without the test taking a minute.
    setTimeout: (fn, ms) => { timers.push({ fn, at: now + ms, kind: 'timeout' }); return timers.length; },
    clearTimeout: (id) => { if (id) timers[id - 1] = null; },
    setInterval: (fn) => { timers.push({ fn, kind: 'interval' }); return timers.length; },
    clearInterval: (id) => { if (id) timers[id - 1] = null; },
    Date: { now: () => now },
    JSON, Number, Array, String, Math, require,
    socket: null,
    config: { deviceId: 'd1' },
    triggers,
    triggerConfig: { accept_http: false, accept_udp: false, secret: SECRET, clear_all_token: 'ALLSTOP' },
    showZoneItem: (zone, div, items, i) => rendered.push({ items: items.length, i }),
  };
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, `${src}\n; return {
    handleTrigger, stats: triggerStats,
    active: () => triggerActive, held: () => triggerHeld,
    sweep: () => triggerLeaseSweep() };`);
  const api = fn(...names.map((n) => env[n]));

  return {
    api, rendered,
    fire: (token) => api.handleTrigger({ text: `ST1 ${SECRET} ${token}`, source: 'http', sourceIp: '10.0.0.1' }),
    advance: (ms) => {
      now += ms;
      for (const t of timers) if (t && t.kind === 'timeout' && t.at <= now) { t.fn(); }
      api.sweep();
    },
    tick: () => api.sweep(),
  };
}

// ───────────────────────── priority ─────────────────────────

test('a higher priority takes the screen', () => {
  const b = boot([T({ id: 'lo', name: 'Room busy', match_token: 'LO', priority: 10 }),
                  T({ id: 'hi', name: 'Evacuate', match_token: 'HI', priority: 100 })]);
  b.fire('LO');
  assert.equal(b.api.active().trigger.id, 'lo');
  b.fire('HI');
  assert.equal(b.api.active().trigger.id, 'hi');
});

test('⚠️ a LOWER priority is dropped while something more important shows', () => {
  const b = boot([T({ id: 'lo', name: 'Room busy', match_token: 'LO', priority: 10 }),
                  T({ id: 'hi', name: 'Evacuate', match_token: 'HI', priority: 100 })]);
  b.fire('HI');
  b.fire('LO');
  assert.equal(b.api.active().trigger.id, 'hi', 'the alarm was displaced by a lesser message');
  assert.equal(b.api.held().length, 0, 'a dropped trigger is not held — it never showed');
});

test('an equal priority wins, matching the last-show-wins rule the manual overlay uses', () => {
  const b = boot([T({ id: 'a', name: 'A', match_token: 'A', priority: 50 }),
                  T({ id: 'b', name: 'B', match_token: 'B', priority: 50 })]);
  b.fire('A'); b.fire('B');
  assert.equal(b.api.active().trigger.id, 'b');
});

// ───────────────────────── the held set ─────────────────────────

test('⚠️ a preempted until_cleared is HELD and comes back when the higher one clears', () => {
  // "Room occupied" is still true while "evacuate" covers it. Nothing ever said it stopped.
  const b = boot([T({ id: 'lo', name: 'Room busy', match_token: 'LO', clear_token: 'LO_C', priority: 10 }),
                  T({ id: 'hi', name: 'Evacuate', match_token: 'HI', clear_token: 'HI_C', priority: 100 })]);
  b.fire('LO');
  b.fire('HI');
  assert.equal(b.api.held().length, 1);
  b.fire('HI_C');
  assert.equal(b.api.active().trigger.id, 'lo', 'the still-true condition did not come back');
  assert.equal(b.api.held().length, 0);
});

test('⚠️ a preempted ONCE is NOT held — its moment has passed', () => {
  // Restoring a one-shot promo after an alarm clears puts stale content on screen at a time nobody
  // chose. This is the distinction that stops the held set being an interrupt stack.
  const b = boot([T({ id: 'promo', name: 'Promo', match_token: 'P', priority: 10, mode: 'once' }),
                  T({ id: 'hi', name: 'Evacuate', match_token: 'HI', clear_token: 'HI_C', priority: 100 })]);
  b.fire('P');
  b.fire('HI');
  assert.equal(b.api.held().length, 0);
  b.fire('HI_C');
  assert.equal(b.api.active(), null, 'a spent one-shot came back');
});

test('a restored trigger restarts at item 1, not where it was', () => {
  const b = boot([T({ id: 'lo', name: 'Lo', match_token: 'LO', priority: 10,
                      items: [{ content_id: 'a', duration_sec: 5 }, { content_id: 'b', duration_sec: 5 }] }),
                  T({ id: 'hi', name: 'Hi', match_token: 'HI', clear_token: 'HI_C', priority: 100 })]);
  b.fire('LO'); b.fire('HI'); b.fire('HI_C');
  const last = b.rendered[b.rendered.length - 1];
  assert.equal(last.i, 0, 'resuming mid-playlist makes the earlier items unreachable');
});

test('the highest-priority held one is restored first', () => {
  const b = boot([T({ id: 'a', name: 'A', match_token: 'A', priority: 10 }),
                  T({ id: 'b', name: 'B', match_token: 'B', priority: 50 }),
                  T({ id: 'c', name: 'C', match_token: 'C', clear_token: 'C_C', priority: 100 })]);
  b.fire('A'); b.fire('B'); b.fire('C');
  assert.equal(b.api.held().length, 2);
  b.fire('C_C');
  assert.equal(b.api.active().trigger.id, 'b', 'restored in the wrong order');
});

test('clearing a HELD trigger removes it, so it does not reappear later', () => {
  const b = boot([T({ id: 'lo', name: 'Lo', match_token: 'LO', clear_token: 'LO_C', priority: 10 }),
                  T({ id: 'hi', name: 'Hi', match_token: 'HI', clear_token: 'HI_C', priority: 100 })]);
  b.fire('LO'); b.fire('HI');
  b.fire('LO_C');                    // cleared while covered
  assert.equal(b.api.held().length, 0);
  b.fire('HI_C');
  assert.equal(b.api.active(), null, 'a trigger came back after being told to stop');
});

test('⚠️ clear-all empties the held set too', () => {
  // "Stop everything" that leaves something queued to reappear a second later is not stop
  // everything, and on an alarm panel that is the difference between calm and a second scare.
  const b = boot([T({ id: 'lo', name: 'Lo', match_token: 'LO', priority: 10 }),
                  T({ id: 'hi', name: 'Hi', match_token: 'HI', priority: 100 })]);
  b.fire('LO'); b.fire('HI');
  b.fire('ALLSTOP');
  assert.equal(b.api.active(), null);
  assert.equal(b.api.held().length, 0);
});

// ───────────────────────── the lease ─────────────────────────

test('a lease expires and auto-clears when nobody re-asserts', () => {
  const b = boot([T({ id: 'x', name: 'Alarm', match_token: 'X', priority: 10, lease_sec: 60 })]);
  b.fire('X');
  assert.ok(b.api.active());
  b.advance(30000); b.tick();
  assert.ok(b.api.active(), 'cleared early — the lease was not honoured');
  b.advance(40000); b.tick();
  assert.equal(b.api.active(), null, 'a lost clear would strand this screen forever');
});

test('a re-fire renews the lease without restarting the overlay', () => {
  const b = boot([T({ id: 'x', name: 'Alarm', match_token: 'X', priority: 10, lease_sec: 60 })]);
  b.fire('X');
  const renders = b.rendered.length;
  b.advance(50000);
  b.fire('X');                                   // the sender re-asserts, as PLC gear does
  assert.equal(b.rendered.length, renders, 'the overlay restarted on a repeat');
  b.advance(40000); b.tick();
  assert.ok(b.api.active(), 'the renewal did not take — 90s elapsed on a 60s lease');
});

test('no lease means hold indefinitely, which is the pre-lease behaviour', () => {
  const b = boot([T({ id: 'x', name: 'Alarm', match_token: 'X', priority: 10 })]);
  b.fire('X');
  b.advance(86400000); b.tick();
  assert.ok(b.api.active(), 'an unset lease must not auto-clear');
});

test('⚠️ a HELD trigger\'s lease keeps ticking, and a lapsed one does not pop back', () => {
  /*
   * The lease answers "is this still true", which is a question about the world and not about the
   * display. A held trigger whose sender went quiet has stopped being true; letting it survive on
   * the held list would reassert a condition that lapsed minutes ago the instant the overlay above
   * it cleared.
   */
  const b = boot([T({ id: 'lo', name: 'Lo', match_token: 'LO', priority: 10, lease_sec: 60 }),
                  T({ id: 'hi', name: 'Hi', match_token: 'HI', clear_token: 'HI_C', priority: 100 })]);
  b.fire('LO');
  b.fire('HI');
  assert.equal(b.api.held().length, 1);
  b.advance(90000); b.tick();
  assert.equal(b.api.held().length, 0, 'a lapsed assertion stayed on the held list');
  b.fire('HI_C');
  assert.equal(b.api.active(), null, 'it came back after it had stopped being true');
});

test('⚠️ re-asserting a HELD trigger renews it without disturbing the screen', () => {
  // An alarm that stays true while something bigger covers it must not lapse. Without this it would
  // silently fail to return when the higher-priority overlay cleared.
  const b = boot([T({ id: 'lo', name: 'Lo', match_token: 'LO', priority: 10, lease_sec: 60 }),
                  T({ id: 'hi', name: 'Hi', match_token: 'HI', clear_token: 'HI_C', priority: 100 })]);
  b.fire('LO'); b.fire('HI');
  b.advance(50000);
  b.fire('LO');                                  // still asserted, but covered
  assert.equal(b.api.active().trigger.id, 'hi', 'the re-assertion stole the screen');
  b.advance(40000); b.tick();
  assert.equal(b.api.held().length, 1, 'the held lease was not renewed');
  b.fire('HI_C');
  assert.equal(b.api.active().trigger.id, 'lo');
});

test('a restored trigger keeps its remaining lease rather than getting a fresh one', () => {
  // Being covered is not a renewal. Resetting the clock on restore would let a preemption silently
  // extend an assertion nobody has repeated.
  const b = boot([T({ id: 'lo', name: 'Lo', match_token: 'LO', priority: 10, lease_sec: 60 }),
                  T({ id: 'hi', name: 'Hi', match_token: 'HI', clear_token: 'HI_C', priority: 100 })]);
  b.fire('LO');
  b.fire('HI');
  b.advance(30000);
  b.fire('HI_C');
  assert.equal(b.api.active().trigger.id, 'lo');
  b.advance(31000); b.tick();
  assert.equal(b.api.active(), null, 'the restore reset the lease clock');
});

// ───────────────────────── once ─────────────────────────

test('⚠️ once stops after one pass instead of looping forever', () => {
  // showZoneItem rotates indefinitely, which is right for a zone and wrong here — without an
  // explicit stop, "play once" behaves exactly like the other mode.
  const b = boot([T({ id: 'p', name: 'Promo', match_token: 'P', mode: 'once',
                      items: [{ content_id: 'a', duration_sec: 5 }, { content_id: 'b', duration_sec: 5 }] })]);
  b.fire('P');
  assert.ok(b.api.active());
  b.advance(11000);
  assert.equal(b.api.active(), null, 'a play-once trigger was still showing after its playlist ended');
});

test('the cap wins over a longer playlist', () => {
  const b = boot([T({ id: 'p', name: 'Promo', match_token: 'P', mode: 'once', max_duration_sec: 3,
                      items: [{ content_id: 'a', duration_sec: 30 }] })]);
  b.fire('P');
  b.advance(4000);
  assert.equal(b.api.active(), null, 'the safety cap deferred to the thing it is guarding');
});

test('a once trigger ending restores anything still held', () => {
  const b = boot([T({ id: 'lo', name: 'Lo', match_token: 'LO', priority: 10 }),
                  T({ id: 'p', name: 'Promo', match_token: 'P', mode: 'once', priority: 50,
                      items: [{ content_id: 'a', duration_sec: 5 }] })]);
  b.fire('LO');
  b.fire('P');
  assert.equal(b.api.active().trigger.id, 'p');
  b.advance(6000);
  assert.equal(b.api.active().trigger.id, 'lo', 'the held condition did not resume');
});

/*
 * ⚠️ ACROSS A PLAYER RESTART, NOTHING IS RESTORED — and that is deliberate.
 *
 * A trigger is an external system's assertion about the present. After a reboot the player cannot
 * know whether it still holds, and the failure modes are asymmetric: a missing overlay self-corrects
 * on the next re-assert, while a restored one whose clear arrived while the player was down is a
 * screen stuck on an alarm with no way back except someone driving to the site.
 *
 * The implementation satisfies this by never persisting the state at all, which is easy to undo by
 * accident the next time someone adds a cache. Hence the assertion.
 */
test('⚠️ active and held state are NEVER written to localStorage', () => {
  const engine = PLAYER.slice(PLAYER.indexOf('    let triggerActive = null;'),
                              PLAYER.indexOf('    // ==================== PiP overlay'));
  for (const m of engine.matchAll(/localStorage\.setItem\(([^,]+)/g)) {
    assert.fail(`the trigger engine persists ${m[1]} — a stale alarm would be restored on boot`);
  }
  assert.doesNotMatch(engine, /triggerHeld\s*=\s*JSON\.parse/,
    'held triggers must not survive a restart');
});

// ───────────────────────── head office emergency alerts (spec §5.3) ─────────────────────────
//
// The server PROJECTS an emergency alert at 100000 + p (lib/device-triggers.js projectTrigger) and
// clamps every normal trigger to -1000..1000. Fed through the REAL player engine here, so the claim
// "no player change needed" is checked against the code that decides, not against a number.

const { projectTrigger } = require('../lib/device-triggers');
const proj = (row) => projectTrigger({ source_http: 1, source_udp: 0, mode: 'until_cleared', ...row },
  [{ content_id: 'c1', duration_sec: 5 }]);

test('⚠️ emergency vs 1000: a store trigger at the top normal priority is DROPPED while an emergency shows', () => {
  const b = boot([proj({ id: 'em', name: 'Evacuate', kind: 'emergency', match_token: 'EM', clear_token: 'EM_C', priority: 0 }),
                  proj({ id: 'st', name: 'Store', match_token: 'ST', priority: 1000 })]);
  b.fire('EM');
  b.fire('ST');
  assert.equal(b.api.active().trigger.id, 'em', 'a store trigger displaced head office\'s emergency');
  assert.equal(b.api.held().length, 0);
});

test('emergency vs 1000: an emergency takes the screen from a store trigger, which is held and comes back after', () => {
  const b = boot([proj({ id: 'em', name: 'Evacuate', kind: 'emergency', match_token: 'EM', clear_token: 'EM_C', priority: 0 }),
                  // A row that skipped the validator (import, mesh) at an absurd priority is clamped too.
                  proj({ id: 'st', name: 'Store', match_token: 'ST', clear_token: 'ST_C', priority: 500000 })]);
  b.fire('ST');
  b.fire('EM');
  assert.equal(b.api.active().trigger.id, 'em');
  assert.equal(b.api.held().length, 1, 'the store\'s still-true condition is held, not lost');
  b.fire('EM_C');
  assert.equal(b.api.active().trigger.id, 'st');
});
