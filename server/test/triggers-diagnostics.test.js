'use strict';

/*
 * The diagnostics surface, and the secret it must not leak. docs/triggers-design.md §13, §11.
 *
 * ⚠️ The whole value of this surface is ONE distinction: an installer standing in a lobby asking
 * "why did nothing happen" needs to know whether packets are arriving. If they are, it is the token
 * or the secret and they can fix it from a laptop. If they are not, it is the network and they need
 * the person who owns the switch. Those are different afternoons, and they look identical unless
 * rejected traffic is counted.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const TR = require('../lib/trigger-resolve.js');
const { stripDeviceSecretsForList, stripTriggerSecretForTokens } = require('../lib/device-sanitize');

const PLAYER = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
const SECRET = 'd'.repeat(16);

function boot() {
  const start = PLAYER.indexOf('    let triggerActive = null;');
  const end = PLAYER.indexOf('    // ==================== PiP overlay');
  const src = PLAYER.slice(start, end);
  const env = {
    window: { TriggerResolve: TR, __debugLog_push() {} },
    document: {
      getElementById: () => ({ innerHTML: '', appendChild() {}, style: {} }),
      createElement: () => ({ style: { cssText: '' }, className: '', appendChild() {} }),
    },
    console: { log() {}, warn() {} },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    Date, JSON, Number, Array, String, Math, require, Buffer,
    socket: null,
    config: { deviceId: 'd1' },
    triggers: [{ id: 't1', name: 'Evac', match_token: 'EVAC', clear_token: 'EVAC_C',
                 source_http: true, source_udp: true, mode: 'until_cleared', priority: 10,
                 items: [{ content_id: 'c1', duration_sec: 5 }] }],
    triggerConfig: { accept_http: false, accept_udp: false, secret: SECRET },
    showZoneItem: () => {},
  };
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, `${src}\n; return { handleTrigger, status: () => triggerStatusPayload(),
      stats: triggerStats, active: () => triggerActive };`);
  const api = fn(...names.map((n) => env[n]));
  return {
    api,
    fire: (tok) => api.handleTrigger({ text: `ST1 ${SECRET} ${tok}`, source: 'http', sourceIp: '10.0.0.7' }),
    raw: (text) => api.handleTrigger({ text, source: 'udp', sourceIp: '10.0.0.8' }),
  };
}

test('the status payload carries what an installer actually needs', () => {
  const b = boot();
  const s = b.api.status();
  for (const k of ['listeners', 'multicast', 'received', 'accepted', 'rejected',
                   'last_datagram_at', 'definitions', 'held', 'active']) {
    assert.ok(k in s, `status is missing ${k}`);
  }
  assert.equal(s.definitions, 1, 'how many definitions reached the device is the first question');
});

test('⚠️ THE DISTINCTION: arriving-but-refused looks different from nothing arriving', () => {
  const b = boot();

  // Nothing has been sent: no timestamp. "The integrator never fired anything."
  assert.equal(b.api.status().last_datagram_at, null);

  // Something arrives and is refused. The timestamp moves even though nothing was accepted.
  b.raw('ST1 wrongsecretwrong EVAC');
  const s = b.api.status();
  assert.ok(s.last_datagram_at, 'a refused packet must still prove that something arrived');
  assert.equal(s.accepted, 0);
  assert.equal(s.rejected.bad_secret, 1,
    'and the reason must name which half failed, or "rejected: 1" answers nothing');
});

test('the reject breakdown separates network noise from a misconfigured sender', () => {
  const b = boot();
  b.raw('SSDP NOTIFY * HTTP/1.1');        // broadcast noise
  b.raw(`ST1 ${SECRET} NOPE`);            // right format, wrong token
  b.raw(`ST1 ${'x'.repeat(16)} EVAC`);    // right token, wrong secret
  const r = b.api.status().rejected;
  assert.equal(r.bad_magic, 1, 'noise on the LAN');
  assert.equal(r.unknown_token, 1, 'a sender using the wrong token');
  assert.equal(r.bad_secret, 1, 'a sender with the wrong secret');
});

test('the active overlay names its trigger and where it came from', () => {
  const b = boot();
  b.fire('EVAC');
  const a = b.api.status().active;
  assert.equal(a.name, 'Evac');
  assert.equal(a.source, 'http', 'which door it came through is the first thing to check');
  assert.equal(a.mode, 'until_cleared');
  assert.ok(a.since);
});

/*
 * The loopback self-test.
 */
test('⚠️ the probe is answered BEFORE the handler, so it never moves the counters', () => {
  // Producing a diagnostic by polluting the numbers the diagnostic exists to explain would be
  // self-defeating: an installer would see accepts and rejects that no one on site caused.
  const udp = PLAYER.slice(PLAYER.indexOf("sock.on('message'"), PLAYER.indexOf("sock.on('error'"));
  const probeIdx = udp.indexOf('TRIGGER_PROBE');
  const handlerIdx = udp.indexOf('handleTrigger(');
  assert.ok(probeIdx > 0 && handlerIdx > probeIdx,
    'the probe check must come before the shared handler');
  // ⚠️ Strip comments before the adjacency check. The property that matters is that the probe
  // branch RETURNS before the shared handler is reached; requiring the two to be textually
  // adjacent made an explanatory comment between them a test failure, which is a brittle test
  // punishing a correct change rather than a guard catching a wrong one.
  const code = udp.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.match(code, /return;\s*\}\s*handleTrigger/,
    'the probe branch must return rather than falling through');
});

test('the self-test requires a matching nonce, so it cannot be spoofed into a false OK', () => {
  const src = PLAYER.slice(PLAYER.indexOf('function triggerSelfTest'), PLAYER.indexOf('function triggerStatusPayload'));
  assert.match(src, /Math\.random\(\)/, 'the nonce must be unguessable enough to mean something');
  const udp = PLAYER.slice(PLAYER.indexOf("sock.on('message'"), PLAYER.indexOf("sock.on('error'"));
  assert.match(udp, /triggerProbeNonce &&/, 'any probe datagram would otherwise report success');
});

test('a failed self-test says what it rules OUT, not just that it failed', () => {
  const src = PLAYER.slice(PLAYER.indexOf('function triggerSelfTest'), PLAYER.indexOf('function triggerStatusPayload'));
  assert.match(src, /socket bound, membership held/,
    'the useful part is that the local config is fine and the network is not');
  assert.match(src, /IGMP snooping|switch/, 'and where to go looking');
});

/*
 * The secret.
 */
test('⚠️ the trigger secret is stripped from device LIST responses', () => {
  const row = stripDeviceSecretsForList({ id: 'd1', trigger_secret: 'shhh', settings_pin: '1234' });
  assert.equal(row.trigger_secret, undefined);
});

test('⚠️ ...and is NEVER given to an API token, even on the detail route', () => {
  /*
   * This is the escalation the strip exists to stop. GET /api/devices/:id is reachable with a
   * READ-scoped token, and SELECT d.* now carries trigger_secret — so without this, "may list your
   * screens" silently becomes "may put content on any of them from the LAN", which is not a power
   * any scope on that token ever granted.
   */
  const viaToken = stripTriggerSecretForTokens({ id: 'd1', trigger_secret: 'shhh' }, true);
  assert.equal(viaToken.trigger_secret, undefined, 'a read token can now fire triggers');

  // A dashboard session keeps it: a human configuring a Crestron panel has to read it somewhere,
  // and the device page is the only place it exists.
  const session = stripTriggerSecretForTokens({ id: 'd1', trigger_secret: 'shhh' }, false);
  assert.equal(session.trigger_secret, 'shhh');
});

test('the detail route actually calls the strip', () => {
  /*
   * The helper was renamed to stripSecretsForTokens when the enrolment key joined the trigger
   * secret behind the same gate — one credential is not a special case, it is a category. Matched
   * on either name so the assertion tracks the CALL rather than the spelling, and the reason it
   * exists (the helper existing is not the same as it being used) is unchanged.
   */
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'devices.js'), 'utf8');
  assert.match(src, /strip(SecretsForTokens|TriggerSecretForTokens)\(device, req\.viaToken\)/,
    'the helper existing is not the same as it being used');
});

test('the status handler ignores a report for someone else\'s device', () => {
  // A socket may only speak for the device it registered as; otherwise one compromised player could
  // rewrite the diagnostics of every screen in the workspace.
  const src = fs.readFileSync(path.join(__dirname, '..', 'ws', 'deviceSocket.js'), 'utf8');
  // Scale-out C2: the body lives in EVENT_APPLIERS['trigger-status'] and checks the claimed id
  // against the authenticated one; the socket dispatcher checks it again before calling any applier.
  const h = src.slice(src.indexOf("'trigger-status'(deviceId, data, ctx)"));
  assert.match(h.slice(0, 400), /device_id !== deviceId/);
  const d = src.slice(src.indexOf('function dispatch(kind, data)'));
  assert.match(d.slice(0, 400), /claimed !== currentDeviceId\) return;/);
});
