'use strict';

/*
 * Head office EMERGENCY ALERTS (spec §5, Stage C), in-process against the real schema:
 *
 *   - projection: an emergency outranks every normal trigger on every player (100000 + p), normal
 *     priorities are clamped to -1000..1000, emergency leases are bounded;
 *   - triggersForDevice: byte-identical to before when no emergency alert reaches the screen
 *     (golden against the pre-feature query), emergency rows first, the scope rules;
 *   - the store-trigger policy matrix (allow / leased / off × mandated or not × once / until_cleared);
 *   - the fan-out helpers reach screens in an alert's scope;
 *   - "Activate now": the covered screen's payload is the alert, an uncovered one is byte-identical,
 *     expiry needs no request, a restart restores it from the table;
 *   - coverage reasons; the clear-all collision belt.
 *
 * MUTATION CHECKS (each verified once by reverting the line and watching the named test go red):
 *   - lib/device-triggers.js: drop EMERGENCY_PRIORITY_BASE from the emergency priority
 *       -> "an emergency always outranks the highest normal priority"
 *   - lib/device-triggers.js: drop `AND t.kind = 'normal'` from the normal query
 *       -> "⚠️ an emergency alert is never projected through trigger_assignments"
 *   - lib/device-triggers.js: drop the 'off' filter -> "policy matrix"
 *   - ws/deviceSocket.js: drop `{ emergencyOnly: true }` during an activation
 *       -> "⚠️ Activate now: the covered screen plays the alert ..."
 *   - lib/corporate/emergency-live.js: drop the `a.expires_at <= now` skip in activationFor
 *       -> "an expired activation never shows, and the sweep ends it without a request"
 *   - ws/deviceSocket.js: drop the activation base (`if (emergencyNow)`) -> "⚠️ Activate now: ..."
 *   - lib/device-triggers.js: drop the emergency scope union in devicesForTrigger -> "fan-out: ..."
 * (and in test/triggers-priority-lease.test.js: drop the normal -1000..1000 clamp
 *       -> "emergency vs 1000: an emergency takes the screen ...")
 * Script: scratchpad corp/mutate-c.py.
 */

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-corp-emergency-' + crypto.randomBytes(4).toString('hex'));
process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { db } = require('../db/database');
const setupDeviceSocket = require('../ws/deviceSocket');
const DT = require('../lib/device-triggers');
const em = require('../lib/corporate/emergency');
const live = require('../lib/corporate/emergency-live');

let build;
const ORG = 'org-e'; const OTHER_ORG = 'org-x';
const HQ = 'ws-e-hq'; const STORE = 'ws-e-store'; const STORE2 = 'ws-e-store2'; const FOREIGN = 'ws-x';
const C = 'c-e-1'; const CE = 'c-e-alarm';
const OWN = 'pl-e-own'; const ALARM = 'pl-e-alarm'; const STORE_TRIG_PL = 'pl-e-strig'; const CORP = 'pl-e-corp';
const DEV = 'dev-e-1'; const DEV2 = 'dev-e-2'; const DEV_OFF = 'dev-e-off'; const DEV_TIZEN = 'dev-e-tizen'; const DEV_S2 = 'dev-e-s2'; const DEV_X = 'dev-e-x';
const GROUP = 'grp-e-1';

const item = (id, name) => ({ content_id: id, filename: name, mime_type: 'image/png', filepath: name, duration_sec: 10, sort_order: 0 });

function addTrigger(over) {
  const t = {
    id: crypto.randomUUID(), workspace_id: STORE, name: 'T', match_token: 'TOK' + crypto.randomBytes(3).toString('hex'),
    clear_token: null, source_http: 1, source_udp: 0, target_kind: 'playlist', target_ref: STORE_TRIG_PL,
    mode: 'until_cleared', max_duration_sec: 0, lease_sec: null, priority: 0, enabled: 1, kind: 'normal', ...over,
  };
  db.prepare(`INSERT INTO triggers (id, workspace_id, name, match_token, clear_token, source_http, source_udp, target_kind, target_ref,
      mode, max_duration_sec, lease_sec, priority, enabled, kind)
      VALUES (@id, @workspace_id, @name, @match_token, @clear_token, @source_http, @source_udp, @target_kind, @target_ref,
      @mode, @max_duration_sec, @lease_sec, @priority, @enabled, @kind)`).run(t);
  return t;
}
const assign = (tid, type, id) => db.prepare('INSERT INTO trigger_assignments (trigger_id, target_type, target_id) VALUES (?, ?, ?)').run(tid, type, id);
const scope = (tid, kind, id) => db.prepare('INSERT INTO emergency_trigger_scopes (trigger_id, scope_kind, scope_id) VALUES (?, ?, ?)').run(tid, kind, id);
const setSwitch = (on) => db.prepare('UPDATE organizations SET emergency_triggers_enabled = ? WHERE id = ?').run(on ? 1 : 0, ORG);
const clean = () => { db.prepare('DELETE FROM emergency_activations').run(); db.prepare('DELETE FROM triggers').run(); live._reset(); setSwitch(0); };

/* The pre-feature query, verbatim (lib/device-triggers.js at d82f572) — the golden reference. */
const OLD_SQL = `
    SELECT DISTINCT t.*
      FROM triggers t
      JOIN trigger_assignments ta ON ta.trigger_id = t.id
      JOIN devices d ON d.id = ?
     WHERE t.enabled = 1
       AND t.workspace_id = d.workspace_id
       AND (
         (ta.target_type = 'device' AND ta.target_id = d.id)
         OR (ta.target_type = 'group' AND ta.target_id IN (
               SELECT group_id FROM device_group_members WHERE device_id = d.id))
       )
     ORDER BY t.priority DESC, t.name
  `;

before(() => {
  setupDeviceSocket(new Server(http.createServer()));
  build = setupDeviceSocket.buildPlaylistPayloadUnchecked;
  db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u-e', 'u-e@x.test', 'u', 'user')").run();
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (?, 'Acme', 'u-e'), (?, 'Other', 'u-e')").run(ORG, OTHER_ORG);
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, 'HQ'), (?, ?, 'Store'), (?, ?, 'Store 2'), (?, ?, 'Foreign')")
    .run(HQ, ORG, STORE, ORG, STORE2, ORG, FOREIGN, OTHER_ORG);
  db.prepare('UPDATE organizations SET hq_workspace_id = ? WHERE id = ?').run(HQ, ORG);
  db.prepare("INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size) VALUES (?, 'u-e', ?, 'a.png', 'a.png', 'image/png', 1), (?, 'u-e', ?, 'alarm.png', 'alarm.png', 'image/png', 1)")
    .run(C, STORE, CE, HQ);
  const pl = db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name, status, published_snapshot, corporate) VALUES (?, 'u-e', ?, ?, 'published', ?, ?)");
  pl.run(OWN, STORE, 'Own', JSON.stringify([item(C, 'a.png')]), 0);
  pl.run(STORE_TRIG_PL, STORE, 'Store alert', JSON.stringify([item(C, 'a.png')]), 0);
  pl.run(ALARM, HQ, 'Evacuate', JSON.stringify([item(CE, 'alarm.png')]), 0);
  pl.run(CORP, HQ, 'Brand', JSON.stringify([item(CE, 'alarm.png')]), 1);
  const dev = db.prepare(`INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, playlist_id, playlist_source, default_content_id,
      triggers_accept_http, triggers_accept_udp, trigger_secret, platform, status, last_heartbeat)
      VALUES (?, 'u-e', ?, ?, ?, ?, 'device', ?, ?, 0, ?, ?, 'online', strftime('%s','now') + 1000)`);
  dev.run(DEV, STORE, 'Till', 'pe1', OWN, C, 1, 's'.repeat(16), 'web');
  dev.run(DEV2, STORE, 'Window', 'pe2', OWN, C, 1, 't'.repeat(16), 'web');
  dev.run(DEV_OFF, STORE, 'Back office', 'pe3', OWN, C, 0, null, 'web');
  dev.run(DEV_TIZEN, STORE, 'TV', 'pe4', OWN, C, 1, 'u'.repeat(16), 'tizen');
  dev.run(DEV_S2, STORE2, 'Other store', 'pe5', OWN, null, 1, 'v'.repeat(16), 'web');
  dev.run(DEV_X, FOREIGN, 'Foreign', 'pe6', null, null, 1, 'w'.repeat(16), 'web');
  db.prepare("INSERT INTO device_groups (id, user_id, workspace_id, name) VALUES (?, 'u-e', ?, 'Tills')").run(GROUP, STORE);
  db.prepare('INSERT INTO device_group_members (device_id, group_id) VALUES (?, ?)').run(DEV, GROUP);
});

/* ── projection ────────────────────────────────────────────────────────────────────────────── */

test('an emergency always outranks the highest normal priority, on the integer every player compares', () => {
  const e = DT.projectTrigger({ id: 'e', name: 'E', kind: 'emergency', priority: 0, mode: 'until_cleared', lease_sec: null }, []);
  const n = DT.projectTrigger({ id: 'n', name: 'N', kind: 'normal', priority: 1000, mode: 'until_cleared' }, []);
  assert.equal(e.priority, 100000);
  assert.ok(e.priority > n.priority, 'web/Android/native all drop `incoming < active`: the emergency must be strictly greater');
  assert.equal(DT.projectTrigger({ id: 'e2', name: 'E', kind: 'emergency', priority: 5000, mode: 'once' }, []).priority, 101000, 'clamped to 0..1000 before the base');
  assert.equal(DT.projectTrigger({ id: 'e3', name: 'E', kind: 'emergency', priority: -50, mode: 'once' }, []).priority, 100000);
  assert.ok(Number.isSafeInteger(101000) && 101000 < 2 ** 31, 'fits Android\'s Int');
  assert.equal(e.kind, 'emergency');
});

test('a normal trigger outside -1000..1000 (an import, a mesh row) is clamped — and logged once', () => {
  const warn = console.warn; const lines = [];
  console.warn = (m) => lines.push(String(m));
  try {
    const t = { id: 'n-big', name: 'Big', kind: 'normal', priority: 200000, mode: 'once' };
    assert.equal(DT.projectTrigger(t, []).priority, 1000);
    assert.equal(DT.projectTrigger(t, []).priority, 1000);
    assert.equal(DT.projectTrigger({ id: 'n-low', name: 'Low', priority: -9999, mode: 'once' }, []).priority, -1000);
  } finally { console.warn = warn; }
  assert.equal(lines.filter((l) => l.includes('"Big" from 200000')).length, 1, 'once per trigger per boot');
});

test('a normal trigger\'s projection is exactly what it was (no kind key, same values)', () => {
  const p = DT.projectTrigger({ id: 'n', name: 'N', match_token: 'A', clear_token: null, source_http: 1, source_udp: 0,
    target_kind: 'playlist', target_ref: 'pl', mode: 'until_cleared', max_duration_sec: null, lease_sec: 30, priority: 7 }, [1]);
  assert.deepEqual(p, { id: 'n', name: 'N', match_token: 'A', clear_token: null, source_http: true, source_udp: false,
    target_kind: 'playlist', target_ref: 'pl', mode: 'until_cleared', max_duration_sec: 0, lease_sec: 30, priority: 7, items: [1] });
});

test('emergency leases are bounded even for a row that skipped the validator', () => {
  const p = (o) => DT.projectTrigger({ id: 'x', name: 'x', kind: 'emergency', priority: 0, ...o }, []);
  assert.equal(p({ mode: 'until_cleared', lease_sec: null }).lease_sec, 120, 'never unbounded');
  assert.equal(p({ mode: 'until_cleared', lease_sec: 9000 }).lease_sec, 300, 'never over 5 minutes');
  assert.equal(p({ mode: 'once', max_duration_sec: 0 }).max_duration_sec, 600);
  assert.equal(p({ mode: 'once', max_duration_sec: 99999 }).max_duration_sec, 3600);
});

/* ── triggersForDevice ─────────────────────────────────────────────────────────────────────── */

test('golden: with no emergency alert reaching the screen, triggersForDevice is byte-identical to the pre-feature query', () => {
  clean();
  const a = addTrigger({ name: 'Fire', priority: 50 });
  const b = addTrigger({ name: 'Lunch', priority: 50, mode: 'once' });
  const c = addTrigger({ name: 'Door', priority: -3 });
  assign(a.id, 'device', DEV); assign(b.id, 'group', GROUP); assign(c.id, 'device', DEV); assign(c.id, 'group', GROUP);
  const old = JSON.stringify(db.prepare(OLD_SQL).all(DEV));
  assert.equal(JSON.stringify(DT.triggersForDevice(db, DEV)), old);
  // An emergency alert that exists but cannot reach the screen (org switch off) changes nothing.
  const e = addTrigger({ workspace_id: HQ, kind: 'emergency', name: 'Evac', target_ref: ALARM, priority: 10 });
  scope(e.id, 'org', ORG);
  assert.equal(JSON.stringify(DT.triggersForDevice(db, DEV)), JSON.stringify(db.prepare(OLD_SQL.replace('WHERE t.enabled = 1', "WHERE t.enabled = 1 AND t.kind = 'normal'")).all(DEV)));
  assert.equal(JSON.stringify(DT.triggersForDevice(db, DEV)), old);
});

test('⚠️ an emergency alert is never projected through trigger_assignments', () => {
  clean();
  const e = addTrigger({ workspace_id: STORE, kind: 'emergency', name: 'Smuggled', priority: 1000 });
  assign(e.id, 'device', DEV);   // a row no route writes (imports, a hand fix-up)
  assert.deepEqual(DT.triggersForDevice(db, DEV), [], 'kind = emergency reaches screens ONLY through its scope');
});

test('emergency rows come first, then the store\'s, whatever their priorities', () => {
  clean();
  setSwitch(1);
  const n = addTrigger({ name: 'Store top', priority: 1000 }); assign(n.id, 'device', DEV);
  const e = addTrigger({ workspace_id: HQ, kind: 'emergency', name: 'Evac', target_ref: ALARM, priority: 0 }); scope(e.id, 'workspace', STORE);
  const rows = DT.triggersForDevice(db, DEV);
  assert.deepEqual(rows.map((r) => r.name), ['Evac', 'Store top'], 'evaluate() takes the FIRST match');
});

test('scope rules: org, workspace, group, device — and never across organizations or workspaces', () => {
  clean();
  setSwitch(1);
  const reach = (kind, id) => {
    db.prepare("DELETE FROM triggers WHERE kind = 'emergency'").run();
    const e = addTrigger({ workspace_id: HQ, kind: 'emergency', name: 'E', target_ref: ALARM });
    scope(e.id, kind, id);
    return [DEV, DEV2, DEV_S2, DEV_X].filter((d) => DT.triggersForDevice(db, d).some((r) => r.id === e.id));
  };
  assert.deepEqual(reach('org', ORG), [DEV, DEV2, DEV_S2]);
  assert.deepEqual(reach('workspace', STORE), [DEV, DEV2]);
  assert.deepEqual(reach('group', GROUP), [DEV]);
  assert.deepEqual(reach('device', DEV2), [DEV2]);
  assert.deepEqual(reach('workspace', FOREIGN), [], 'another org\'s workspace is never reached');
  assert.deepEqual(reach('org', OTHER_ORG), []);
  db.prepare('UPDATE triggers SET enabled = 0').run();
  assert.equal(DT.triggersForDevice(db, DEV).length, 0, 'a disabled alert reaches nobody');
  db.prepare('UPDATE triggers SET enabled = 1').run();
  setSwitch(0);
  assert.equal(DT.triggersForDevice(db, DEV).length, 0, 'the org switch off: reaches nobody');
});

test('fan-out: devicesForTrigger and devicesForTriggerTarget reach the screens in an alert\'s scope', () => {
  clean();
  const e = addTrigger({ workspace_id: HQ, kind: 'emergency', name: 'E', target_ref: ALARM });
  scope(e.id, 'workspace', STORE);
  assert.deepEqual(DT.devicesForTrigger(db, e.id).sort(), [DEV, DEV2, DEV_OFF, DEV_TIZEN].sort());
  assert.deepEqual(DT.devicesForTriggerTarget(db, ALARM).sort(), [DEV, DEV2, DEV_OFF, DEV_TIZEN].sort());
  const n = addTrigger({ name: 'N' }); assign(n.id, 'device', DEV2);
  assert.deepEqual(DT.devicesForTrigger(db, n.id), [DEV2], 'a normal trigger: exactly as before');
});

/* ── store-trigger policy ─────────────────────────────────────────────────────────────────── */

test('policy matrix: allow / leased / off × mandated or not × once / until_cleared', {
  skip: process.env.CORPORATE_TEST_FORCE_DEGRADED === '1' && 'needs the corporate views (degraded mode has no mandates in force)',
}, () => {
  clean();
  db.prepare("UPDATE organizations SET corporate_enabled = 1, store_trigger_cap_sec = 120 WHERE id = ?").run(ORG);
  db.prepare("INSERT INTO corporate_mandates (id, organization_id, playlist_id, target_kind, target_id) VALUES ('m-e', ?, ?, 'device', ?)").run(ORG, CORP, DEV);
  try {
    const uc = addTrigger({ name: 'UC', mode: 'until_cleared', lease_sec: null });
    const uc2 = addTrigger({ name: 'UC short', mode: 'until_cleared', lease_sec: 30 });
    const once = addTrigger({ name: 'Once', mode: 'once', max_duration_sec: 0 });
    for (const t of [uc, uc2, once]) { assign(t.id, 'device', DEV); assign(t.id, 'device', DEV2); }
    const view = (d) => Object.fromEntries(DT.triggersForDevice(db, d).map((t) => [t.name, { lease: t.lease_sec, max: t.max_duration_sec }]));
    const setPolicy = (p) => db.prepare('UPDATE organizations SET store_triggers_under_mandate = ? WHERE id = ?').run(p, ORG);

    setPolicy('allow');
    const unmandatedBefore = JSON.stringify(DT.triggersForDevice(db, DEV2));
    assert.deepEqual(view(DEV), { UC: { lease: null, max: 0 }, 'UC short': { lease: 30, max: 0 }, Once: { lease: null, max: 0 } }, 'allow = unchanged');

    setPolicy('leased');
    assert.deepEqual(view(DEV), { UC: { lease: 120, max: 0 }, 'UC short': { lease: 30, max: 0 }, Once: { lease: null, max: 120 } },
      'leased caps a stuck sender: lease min(lease||cap, cap), once min(max||cap, cap)');
    assert.equal(JSON.stringify(DT.triggersForDevice(db, DEV2)), unmandatedBefore, 'a screen head office does not drive is never affected');
    assert.equal(db.prepare('SELECT lease_sec FROM triggers WHERE id = ?').get(uc.id).lease_sec, null, 'the stored row is never touched');

    setPolicy('off');
    assert.deepEqual(view(DEV), {}, 'off = store triggers are not projected to a mandated screen');
    assert.equal(JSON.stringify(DT.triggersForDevice(db, DEV2)), unmandatedBefore);

    // An emergency alert is head office's own: no store policy touches it.
    setSwitch(1);
    const e = addTrigger({ workspace_id: HQ, kind: 'emergency', name: 'Evac', target_ref: ALARM }); scope(e.id, 'device', DEV);
    assert.deepEqual(Object.keys(view(DEV)), ['Evac']);
    setPolicy('allow');
  } finally {
    db.prepare('DELETE FROM corporate_mandates').run();
    db.prepare("UPDATE organizations SET corporate_enabled = 0, store_triggers_under_mandate = 'allow' WHERE id = ?").run(ORG);
  }
});

/* ── Activate now ─────────────────────────────────────────────────────────────────────────── */

function alarm() {
  clean();
  setSwitch(1);
  const n = addTrigger({ name: 'Store alert', priority: 1000 }); assign(n.id, 'device', DEV);
  const e = addTrigger({ workspace_id: HQ, kind: 'emergency', name: 'Evac', target_ref: ALARM, match_token: 'EVAC', clear_token: 'EVAC_CLR' });
  scope(e.id, 'workspace', STORE);
  return { n, e: db.prepare('SELECT * FROM triggers WHERE id = ?').get(e.id) };
}

test('⚠️ Activate now: the covered screen plays the alert, with no store trigger, layout, default content or group sync', () => {
  const { e } = alarm();
  const before = JSON.stringify(build(DEV));
  assert.ok(build(DEV).assignments.every((a) => !('interrupt' in a)), 'no flag before the activation');
  const plainBefore = JSON.stringify(build(DEV_S2));
  const offBefore = JSON.stringify(build(DEV_OFF));
  live.activate(db, e, { userId: 'u-e', durationSec: 600 });
  try {
    const p = build(DEV);
    assert.deepEqual(p.assignments.map((a) => a.content_id), [CE], 'the base IS the alert');
    // An emergency cuts in on every player at once (player-parity.md, "Emergency alerts cut in").
    assert.ok(p.assignments.every((a) => a.interrupt === true), 'activated: every alert item carries interrupt:true');
    assert.ok(p.triggers.every((t) => (t.items || []).every((a) => !('interrupt' in a))), 'trigger items never carry it');
    assert.equal(p.default_content, null);
    assert.equal(p.layout, null);
    assert.equal(p.group_sync, null);
    assert.deepEqual(p.triggers.map((t) => t.name), ['Evac'], 'store triggers cannot overlay an activated alert');
    assert.ok(!JSON.stringify(p).includes('__origin_ws'));
    assert.equal(JSON.stringify(build(DEV_S2)), plainBefore, 'a screen outside the scope is byte-identical');
    assert.equal(JSON.stringify(build(DEV_OFF)), offBefore, '"only if triggers were enabled": a screen with its listener off is not taken over');
    assert.notEqual(build(DEV_TIZEN).assignments[0]?.content_id, CE, 'Tizen has no trigger listener: not covered');
  } finally { live.end(db, e.id, { reason: 'test' }); }
  assert.equal(JSON.stringify(build(DEV)), before, 'ended: back to exactly its own payload');
  assert.ok(build(DEV).assignments.every((a) => !('interrupt' in a)), 'ended: the flag is gone');
});

test('an expired activation never shows, and the sweep ends it without a request', () => {
  const { e } = alarm();
  let now = Math.floor(Date.now() / 1000);
  live._setClock(() => now);
  try {
    live.activate(db, e, { userId: 'u-e', durationSec: 60 });
    assert.equal(build(DEV).assignments[0].content_id, CE);
    now += 61;
    assert.notEqual(build(DEV).assignments[0].content_id, CE, 'past expires_at it is gone even before the sweep runs');
    assert.equal(live.sweep(), 1);
    const row = db.prepare('SELECT ended_at, ended_by FROM emergency_activations WHERE trigger_id = ?').get(e.id);
    assert.equal(row.ended_by, 'expired');
    assert.ok(row.ended_at <= now);
    assert.equal(live.liveFor(e.id), null);
  } finally { live._setClock(null); }
});

test('a restart mid-activation restores it from the table; one that expired while down is ended at load', () => {
  const { e } = alarm();
  live.activate(db, e, { userId: 'u-e', durationSec: 600 });
  live._reset();                       // the process went away; the row did not
  assert.equal(build(DEV).assignments[0].content_id, CE, 'restored lazily on the first payload build');
  assert.ok(live.liveFor(e.id).remaining_sec > 500);
  db.prepare("UPDATE emergency_activations SET expires_at = strftime('%s','now') - 5 WHERE trigger_id = ?").run(e.id);
  live._reset();
  assert.notEqual(build(DEV).assignments[0].content_id, CE);
  assert.equal(db.prepare('SELECT ended_by FROM emergency_activations WHERE trigger_id = ?').get(e.id).ended_by, 'expired');
});

test('the activation duration is server-capped: 60..3600 s', () => {
  const { e } = alarm();
  assert.throws(() => live.activate(db, e, { userId: 'u', durationSec: 59 }), RangeError);
  assert.throws(() => live.activate(db, e, { userId: 'u', durationSec: 3601 }), RangeError);
  assert.equal(live.liveFor(e.id), null);
});

/* ── coverage and the clear-all belt ──────────────────────────────────────────────────────── */

test('coverage reasons: listener off, platform, no secret, clear-all collision, not synced, offline, switch off', () => {
  const { e } = alarm();
  db.prepare("UPDATE devices SET trigger_clear_all_token = 'EVAC_CLR' WHERE id = ?").run(DEV2);
  db.prepare("UPDATE devices SET triggers_accept_http = 1, trigger_secret = NULL, status = 'offline' WHERE id = ?").run(DEV_OFF);
  db.prepare('UPDATE devices SET last_heartbeat = 1 WHERE id = ?').run(DEV_TIZEN);
  try {
    const c = em.coverage(db, e.id);
    const by = Object.fromEntries(c.unreachable.map((u) => [u.device_id, u]));
    assert.equal(c.total, 4);
    assert.deepEqual(by[DEV2].reasons, ['clear_all_collision']);
    assert.deepEqual(by[DEV_OFF].reasons, ['no_secret']);
    assert.deepEqual(by[DEV_OFF].activate_reasons, ['offline'], 'offline is only an Activate-now reason: a LAN trigger fires with the WAN down');
    assert.ok(by[DEV_TIZEN].reasons.includes('platform_no_triggers'));
    assert.ok(by[DEV_TIZEN].reasons.includes('not_synced'));
    assert.ok(!by[DEV], 'the till is ready both ways');
    assert.equal(c.trigger_ready, 1);
    assert.equal(c.activate_ready, 3, 'listener on, not Tizen (offline ones get it on reconnect)');
    assert.equal(c.online, 2);
    db.prepare("UPDATE devices SET triggers_accept_http = 0 WHERE id = ?").run(DEV2);
    assert.ok(em.coverage(db, e.id).unreachable.find((u) => u.device_id === DEV2).reasons.includes('listener_off'));
    setSwitch(0);
    assert.ok(em.coverage(db, e.id).unreachable.every((u) => u.reasons.includes('org_switch_off')));
  } finally {
    db.prepare("UPDATE devices SET trigger_clear_all_token = NULL, triggers_accept_http = 1 WHERE id = ?").run(DEV2);
    db.prepare("UPDATE devices SET triggers_accept_http = 0, status = 'online' WHERE id = ?").run(DEV_OFF);
    db.prepare("UPDATE devices SET last_heartbeat = strftime('%s','now') + 1000 WHERE id = ?").run(DEV_TIZEN);
  }
});

test('belt: a store clear-all token equal to an alert code is not sent while it would shadow the alert', () => {
  const { e } = alarm();
  db.prepare("UPDATE devices SET trigger_clear_all_token = 'EVAC' WHERE id = ?").run(DEV2);
  try {
    const p = build(DEV2);
    assert.ok(p.triggers.some((t) => t.id === e.id));
    assert.equal(p.trigger_config.clear_all_token, null);
    setSwitch(0);
    assert.equal(build(DEV2).trigger_config.clear_all_token, 'EVAC', 'no alert projected: the store\'s clear-all is untouched');
  } finally { db.prepare('UPDATE devices SET trigger_clear_all_token = NULL WHERE id = ?').run(DEV2); }
});

test('token namespace: an alert code may not equal a store trigger\'s or an in-scope clear-all; a clear-all may not equal an alert code', () => {
  const { n, e } = alarm();
  assert.equal(em.tokenClash(db, ORG, [n.match_token], { scopeRows: [] }).status, 409, 'a store trigger in another workspace of the org');
  assert.equal(em.tokenClash(db, ORG, ['EVAC'], { id: e.id, scopeRows: [] }), null, 'its own codes are not a clash');
  db.prepare("UPDATE devices SET trigger_clear_all_token = 'STOPALL' WHERE id = ?").run(DEV2);
  try {
    assert.equal(em.tokenClash(db, ORG, ['STOPALL'], { scopeRows: [{ scope_kind: 'workspace', scope_id: STORE }] }).status, 409);
    assert.equal(em.tokenClash(db, ORG, ['STOPALL'], { scopeRows: [{ scope_kind: 'workspace', scope_id: STORE2 }] }), null, 'only screens in scope');
  } finally { db.prepare('UPDATE devices SET trigger_clear_all_token = NULL WHERE id = ?').run(DEV2); }
  assert.match(em.clearAllClash(db, DEV_S2, 'EVAC_CLR'), /reserved by your head office/);
  assert.equal(em.clearAllClash(db, DEV_X, 'EVAC_CLR'), null, 'another organization\'s screen');
});

test('degraded mode (resolver check failed): emergency alerts and Activate now keep working; the store-trigger policy is off', () => {
  const runtime = require('../lib/corporate/runtime');
  const { e } = alarm();
  runtime.setViewsDegraded(true);
  try {
    assert.ok(DT.triggersForDevice(db, DEV).some((t) => t.id === e.id), 'projected without the corporate views');
    live.activate(db, e, { userId: 'u-e', durationSec: 120 });
    assert.equal(build(DEV).assignments[0].content_id, CE);
    assert.equal(DT.storeTriggerPolicyFor(db, DEV), null, 'no mandates can be in force, so no store policy applies');
  } finally { live.end(db, e.id, { reason: 'test' }); runtime.setViewsDegraded(false); }
});

test('a scope in a workspace shared over the mesh is refused (the scope table is not replicated)', () => {
  db.prepare("UPDATE workspaces SET origin_node_id = 'node-b' WHERE id = ?").run(STORE2);
  try {
    const r = em.validateScopes(db, ORG, [{ scope_kind: 'workspace', scope_id: STORE2 }]);
    assert.equal(r.ok, false); assert.equal(r.code, 'CORPORATE_MESH_UNSUPPORTED'); assert.equal(r.status, 409);
    assert.equal(em.validateScopes(db, ORG, [{ scope_kind: 'device', scope_id: DEV_S2 }]).code, 'CORPORATE_MESH_UNSUPPORTED');
    assert.equal(em.validateScopes(db, ORG, [{ scope_kind: 'workspace', scope_id: STORE }]).ok, true);
  } finally { db.prepare('UPDATE workspaces SET origin_node_id = NULL WHERE id = ?').run(STORE2); }
});
