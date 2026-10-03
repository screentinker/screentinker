'use strict';

/*
 * 2.0.1 — hold PLAYERS off until first-boot maintenance is idle.
 *
 * ⚠️ THE REPORT. A 73-device install on a Synology DS225+ (spinning SATA) upgraded 1.9.39 -> 2.0.0.
 * Migrations and the playlist-source backfill were fine. Then the box came up and all 73 players
 * reconnected at once: HTTP was unreachable for about twenty minutes even though the WebSocket
 * layer was accepting, because the content-ready storm plus the #307 stranded-play sweep kept the
 * event loop pinned. The stranded backlog was **494,000 rows** — not the 36,096 from the #307
 * investigation, which was one database's open set and was never the universe.
 *
 * #142's per-device shed was working exactly as designed and could not help: nothing was
 * misbehaving, there were simply 73 well-behaved players arriving at once. The workaround that
 * worked was stop nginx -> let maintenance finish -> start nginx. lib/boot-defer.js is that
 * workaround as a feature, and this file pins its three load-bearing promises:
 *
 *   1. while deferred, a PLAYER is refused — and refused, not accepted and stalled;
 *   2. while deferred, /api/status still answers 200 (compose's healthcheck polls it, and failing
 *      it during maintenance turns a slow boot into a restart loop — the #146 lesson);
 *   3. the defer LIFTS once the sweep reports idle, and lifts on a valve even if it does not.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-defer-'));
process.env.DATA_DIR = tmp;
process.env.JWT_SECRET = 'test-secret-player-defer';
// Explicitly neutral: these tests drive the state machine directly, and an operator's forced
// setting leaking in from the environment would quietly invert half of them.
delete process.env.SCREENTINKER_DEFER_PLAYERS;

const express = require('express');
const { Server } = require('socket.io');
const ioClient = require('socket.io-client');
const { db } = require('../db/database');
const bootDefer = require('../lib/boot-defer');

// ---------------------------------------------------------------------------- the state machine

test('armed: default OFF on an ordinary restart, ON after a migration that touched plays', () => {
  bootDefer.__reset();
  assert.equal(bootDefer.armed({ migrationTouchedPlays: false }), false,
    'a healthy restart must pay for none of this');
  assert.equal(bootDefer.armed({ migrationTouchedPlays: true }), true,
    'the boot after a plays migration is the one with a cold index and a backlog behind it');
});

test('SCREENTINKER_DEFER_PLAYERS forces the decision in both directions', () => {
  bootDefer.__reset();
  process.env.SCREENTINKER_DEFER_PLAYERS = '1';
  assert.equal(bootDefer.armed({ migrationTouchedPlays: false }), true, '=1 must force it on');
  process.env.SCREENTINKER_DEFER_PLAYERS = '0';
  assert.equal(bootDefer.armed({ migrationTouchedPlays: true }), false, '=0 must force it off');
  delete process.env.SCREENTINKER_DEFER_PLAYERS;
});

test('no backlog, no defer — a fresh install never holds off its own players', () => {
  bootDefer.__reset();
  assert.equal(bootDefer.begin({ openPlays: 0 }), false);
  assert.equal(bootDefer.isDeferred(), false);
});

test('the safety valve lifts a defer that never reports idle', () => {
  bootDefer.__reset();
  assert.equal(bootDefer.begin({ openPlays: 494000 }), true);
  assert.equal(bootDefer.isDeferred(), true);

  // Reach back past the ceiling. A fleet held off forever is worse than the stampede this defers,
  // so every exit from the deferred state has to be bounded — including the ones nobody plans for.
  const secretlyOld = Date.now() - bootDefer.MAX_DEFER_MS - 1000;
  bootDefer.__reset();
  bootDefer.begin({ openPlays: 494000 });
  bootDefer.__setSinceForTest(secretlyOld);
  assert.equal(bootDefer.isDeferred(), false, 'the valve must let players back in on its own');
});

// ------------------------------------------------------------------- the gates, over real wires

const app = express();
app.use(express.json());
app.use('/api/status', require('../routes/status'));
const server = http.createServer(app);
const io = new Server(server);
require('../ws/deviceSocket')(io);
server.listen(0);

const BASE = () => `http://127.0.0.1:${server.address().port}`;

function connectPlayer() {
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE()}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    const done = (r) => { try { sock.close(); } catch { /* */ } resolve(r); };
    sock.on('connect', () => done({ connected: true }));
    sock.on('connect_error', (err) => done({ connected: false, message: err.message, data: err.data }));
    setTimeout(() => done({ connected: false, timedOut: true }), 4000);
  });
}

const status = async () => {
  const res = await fetch(`${BASE()}/api/status`);
  return { code: res.status, body: await res.json() };
};

test('DEFERRED: the player is told to go away, and told when to come back', async () => {
  /*
   * ⚠️ THIS ASSERTION WAS REWRITTEN, AND THE OLD ONE DESCRIBED THE BUG.
   *
   * It required the connection to be REFUSED outright, carrying a 503 in `connect_error.data` — i.e.
   * a namespace-middleware rejection. That is exactly what stranded the fleet: a Socket.IO v4 client
   * treats a middleware CONNECT_ERROR as a denial, sets skipReconnect, fires no `disconnect`, and
   * never returns. The web and Tizen players sat on "Connection failed: maintenance" until each panel
   * was reloaded by hand — worse than the stampede the feature prevents, on the very install it was
   * written for.
   *
   * The intent survives unchanged and is still asserted below: the player must be TOLD to go away
   * rather than accepted and left hanging. What changed is the mechanism — it is now told in the
   * language the other three refusal gates already use, with the wait attached, from a socket that
   * was accepted first so its own disconnect handling runs.
   */
  bootDefer.__reset();
  bootDefer.begin({ openPlays: 494000 });

  const seen = await connectLikeAPlayer();

  assert.ok(seen.throttled, 'the player must be TOLD to go away, not accepted and left in silence');
  assert.equal(seen.throttled.reason, 'maintenance', 'and told what kind of refusal this is');
  assert.ok(seen.throttled.detail, 'and why');
  assert.ok(Number(seen.throttled.retry_after_ms) >= 1000, 'and when to come back');
  assert.ok(seen.disconnects > 0, 'and then actually let go of the socket');
});

test('DEFERRED: /api/status still answers 200 so the healthcheck does not restart the boot', async () => {
  bootDefer.__reset();
  bootDefer.begin({ openPlays: 494000 });

  const { code, body } = await status();
  assert.equal(code, 200, 'a non-2xx here restarts the container mid-maintenance');
  assert.equal(body.status, 'ok', "compose reads r.ok; the container IS healthy, it just isn't taking players");
  assert.equal(body.maintenance?.deferring_players, true, 'and it must say that plainly');
  assert.ok(body.maintenance.reason, '…and say why');
});

test('LIFTED: players are accepted again and the maintenance block disappears', async () => {
  bootDefer.__reset();
  bootDefer.begin({ openPlays: 494000 });
  bootDefer.lift({ closed: 494000, remaining: 0 });

  const r = await connectPlayer();
  assert.equal(r.connected, true, 'once the sweep is idle the fleet must be able to come back');

  const { code, body } = await status();
  assert.equal(code, 200);
  assert.equal(body.maintenance, undefined,
    "a healthy install's status payload must be byte-identical to 2.0.0's");
});

// --------------------------------------------------------------------- the drain that lifts it

test('the boot drain defers, closes the backlog, and lifts when the sweep is idle', async () => {
  bootDefer.__reset();
  const heartbeat = require('../services/heartbeat');

  // A screen with a backlog of plays nothing will ever close: opened long ago, never ended. This is
  // the shape of the 494k rows, in miniature — no content row, so each expires at the unknown-length
  // ceiling (INFER_UNKNOWN_MAX_SEC) rather than its own duration.
  db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash, role) VALUES ('u-dr','dr@test.local','x','user')").run();
  db.prepare("INSERT OR IGNORE INTO organizations (id, name, owner_user_id) VALUES ('o-dr','org','u-dr')").run();
  db.prepare("INSERT OR IGNORE INTO workspaces (id, organization_id, name) VALUES ('ws-dr','o-dr','ws')").run();
  db.prepare(`INSERT OR IGNORE INTO devices (id, name, workspace_id, user_id, created_at, updated_at)
              VALUES ('d-dr','Screen','ws-dr','u-dr',strftime('%s','now'),strftime('%s','now'))`).run();

  const longAgo = Math.floor(Date.now() / 1000) - (30 * 86400);
  const ins = db.prepare("INSERT INTO play_logs (device_id, started_at, ended_at, content_name) VALUES ('d-dr', ?, NULL, 'x')");
  const many = db.transaction(() => { for (let i = 0; i < 1200; i++) ins.run(longAgo + i); });
  many();

  const openBefore = heartbeat.countOpenPlays();
  assert.ok(openBefore >= 1200, `precondition: a backlog exists (saw ${openBefore})`);

  // Capture the two lines an operator greps for. They are the whole point of the feature being
  // legible: "holding players off" and "players accepted again", with counts on both.
  const lines = [];
  const warn = console.warn, log = console.log;
  console.warn = (...a) => lines.push(a.join(' '));
  console.log = (...a) => lines.push(a.join(' '));
  let closed;
  try {
    closed = await heartbeat.drainStrandedAtBoot();
  } finally {
    console.warn = warn; console.log = log;
  }

  assert.ok(closed >= 1200, `the drain must actually close the backlog (closed ${closed})`);
  assert.equal(heartbeat.countOpenPlays(), 0, 'and drain it to idle');
  assert.equal(bootDefer.isDeferred(), false, 'players must be accepted again once the sweep is idle');

  const started = lines.findIndex((l) => l.includes('[boot-defer] holding players off'));
  const lifted = lines.findIndex((l) => l.includes('[boot-defer] players accepted again'));
  assert.ok(started >= 0, 'one line when the defer starts, with counts');
  assert.ok(lifted > started, 'one line when it lifts, after it');
  assert.match(lines[lifted], /stranded play\(s\) closed/, 'the lift line must report what it closed');
  assert.ok(lines.some((l) => /\[boot\] stranded sweep batch \d+\/\d+ closed=\d+ remaining=\d+ duration=\d+ms/.test(l)),
    'every batch must log batch/closed/remaining/duration — the difference between "building" and "dead"');
});

after(() => { try { io.close(); } catch { /* */ } try { server.close(); } catch { /* */ } });


/*
 * ⚠️ THE ASSERTION THIS FILE WAS MISSING, AND WHY IT MISSED IT.
 *
 * Every test above connects with `reconnection: false`, which is exactly the property under test.
 * The original implementation refused in namespace middleware, and a Socket.IO v4 client treats a
 * middleware CONNECT_ERROR as a DENIAL rather than a fault: the manager runs _destroy -> _close and
 * sets skipReconnect = true, no `disconnect` event fires, and `reconnectionAttempts: Infinity` is
 * ignored. So the refusal looked correct here — the client was told no, which is all these tests
 * checked — while in the field the web and Tizen players never tried again and had to be reloaded
 * by hand. A refusal is only safe if the client comes back.
 *
 * These tests therefore leave reconnection ON and assert the two things that actually matter:
 * the client is still willing to retry, and the refusal says how long to wait in the language the
 * other refusal gates already use.
 */

const CLIENT_OPTS = {
  transports: ['websocket'],
  forceNew: true,
  reconnection: true,
  reconnectionDelay: 50,
  reconnectionDelayMax: 100,
};

/** Connect the way a real player does, and report what the refusal left behind. */
function connectLikeAPlayer(waitMs = 1200) {
  return new Promise((resolve) => {
    const sock = ioClient(`${BASE()}/device`, CLIENT_OPTS);
    const seen = { throttled: null, disconnects: 0, connects: 0, connectErrors: 0 };
    sock.on('connect', () => { seen.connects += 1; });
    sock.on('disconnect', () => { seen.disconnects += 1; });
    sock.on('connect_error', () => { seen.connectErrors += 1; });
    sock.on('device:throttled', (d) => { seen.throttled = d; });
    setTimeout(() => {
      // `active` is the client's own answer to "will I try again?" — false means skipReconnect.
      seen.stillTrying = sock.active;
      seen.connectedAtEnd = sock.connected;
      try { sock.close(); } catch { /* */ }
      resolve(seen);
    }, waitMs);
  });
}

test('⚠️ a deferred player is refused in a way its own handlers can see', () => {
  /*
   * ⚠️ THE DISCRIMINATOR IS WHICH CLIENT EVENTS FIRE, not `socket.active`.
   *
   * A server-initiated disconnect always clears `active` — that is normal and is not the bug. The
   * bug was the SHAPE of the refusal. A middleware CONNECT_ERROR fires neither `connect` nor
   * `disconnect`: the manager quietly sets skipReconnect and the player's supervisor, which is armed
   * from its disconnect handler, never runs at all. Nothing in the client is left to act on, which is
   * why panels had to be reloaded by hand.
   *
   * Accepting and then refusing fires `connect`, delivers an actionable `device:throttled`, and then
   * fires `disconnect` — three events the players already handle. That is what this asserts.
   */
  return (async () => {
    bootDefer.__reset();
    bootDefer.begin({ openPlays: 5, reason: 'stranded-sweep' });

    const seen = await connectLikeAPlayer();

    assert.ok(seen.connects > 0,
      'the socket must be ACCEPTED and then refused — a middleware rejection fires no client event at all');
    assert.equal(seen.connectErrors, 0,
      'a CONNECT_ERROR is the failure mode: it sets skipReconnect and strands the panel');
    assert.ok(seen.disconnects > 0,
      'the player supervisor is armed from its disconnect handler, so that event has to fire');
  })();
});

test('the refusal tells the player how long to wait, in the language the other gates use', async () => {
  bootDefer.__reset();
  bootDefer.begin({ openPlays: 5, reason: 'stranded-sweep' });

  const seen = await connectLikeAPlayer();

  assert.ok(seen.throttled, 'the player was refused with no explanation and no retry hint');
  assert.equal(seen.throttled.reason, 'maintenance');
  assert.ok(Number(seen.throttled.retry_after_ms) >= 1000,
    `retry_after_ms must be a usable wait, got ${seen.throttled && seen.throttled.retry_after_ms}`);
});

test('once the defer lifts, the same client connects and stays', async () => {
  bootDefer.__reset();
  bootDefer.begin({ openPlays: 5, reason: 'stranded-sweep' });
  bootDefer.lift({ closed: 5, remaining: 0 });

  const seen = await connectLikeAPlayer(600);
  assert.ok(seen.connects > 0, 'a lifted defer must let players in');
  assert.equal(seen.throttled, null, 'and must not still be telling them to wait');
});

/*
 * ...and the end of the story: a client that does what it was told gets back in. This is the
 * behaviour the whole fix exists to produce, so it is asserted rather than assumed.
 */
test('a player that honours the wait is playing again once the drain finishes', async () => {
  bootDefer.__reset();
  bootDefer.begin({ openPlays: 5, reason: 'stranded-sweep' });

  const refused = await connectLikeAPlayer();
  assert.ok(refused.throttled, 'precondition: it was told to wait');

  // The drain completes while the player is holding off, which is the normal case.
  bootDefer.lift({ closed: 5, remaining: 0 });

  const retry = await connectLikeAPlayer(600);
  assert.ok(retry.connects > 0, 'the player must be accepted once the defer lifts');
  assert.equal(retry.throttled, null, 'and must not still be told to wait');
  assert.equal(retry.connectedAtEnd, true, 'and must be allowed to STAY connected, not refused again');
});
