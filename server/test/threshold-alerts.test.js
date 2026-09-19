'use strict';

/*
 * Threshold alerts (A2), and the alert history the uptime report is built on.
 *
 * ⚠️ THE FAILURE THESE GUARD AGAINST IS NOT "MISSED AN ALERT". It is the opposite: an alerting system
 * that fires so readily nobody trusts it. A screen sitting at exactly the threshold, or a CPU spike
 * while a video decodes, must not produce mail — because the response to unreliable alerts is to mute
 * them, and a muted alert is worse than an absent one.
 *
 * And the other half: an alert with no CLOSE event is not an incident, it is a notification. Only a
 * duration can answer "were my screens up last month".
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Database } = require('../db/sqlite-driver');
const th = require('../lib/alerts/thresholds');
const svc = require('../services/threshold-alerts');

const NOW = 1_700_000_000;

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-'));
  const db = new Database(path.join(dir, 'a.db'));
  db.exec(`
    CREATE TABLE alert_rules (
      id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT NOT NULL, metric TEXT NOT NULL,
      threshold REAL NOT NULL, clear_threshold REAL, sustain_seconds INTEGER NOT NULL DEFAULT 300,
      severity TEXT NOT NULL DEFAULT 'warn', enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER);
    CREATE TABLE alert_events (
      id TEXT PRIMARY KEY, rule_id TEXT, device_id TEXT, workspace_id TEXT, metric TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'warn', opened_at INTEGER NOT NULL, closed_at INTEGER,
      opened_value REAL, peak_value REAL, closed_value REAL, notified_at INTEGER);
    CREATE TABLE alert_rule_state (
      rule_id TEXT NOT NULL, device_id TEXT NOT NULL, breaching_since INTEGER,
      open_event_id TEXT, last_value REAL, updated_at INTEGER, PRIMARY KEY (rule_id, device_id));
    -- The sweep scopes to local rows (scale-out: a copied workspace is the primary's to sweep).
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, origin_node_id TEXT);
  `);
  db._dir = dir;
  return db;
}
const cleanup = (db) => { try { db.close(); } catch {} fs.rmSync(db._dir, { recursive: true, force: true }); };

const rule = (over = {}) => ({
  id: 'r1', name: 'Low storage', metric: 'storage_free_pct', threshold: 10,
  sustain_seconds: 300, severity: 'warn', ...over,
});
const device = { id: 'dev-1', workspace_id: 'ws-1' };
const sample = (over = {}) => ({ storage_total_mb: 1000, storage_free_mb: 50, ...over });

// ===== the anti-noise properties =====

test('⚠️ SUSTAIN: a transient breach does not open an alert', () => {
  /*
   * A CPU spike while a video decodes is not a fault. Alerting on it teaches an operator that alerts
   * are wrong, which is the failure mode that matters.
   */
  const r = rule({ metric: 'cpu_usage', threshold: 80, sustain_seconds: 300 });
  const s = { breaching_since: NOW };
  assert.equal(th.evaluate(r, { cpu_usage: 95 }, s, { now: NOW }).action, 'pending');
  assert.equal(th.evaluate(r, { cpu_usage: 95 }, s, { now: NOW + 299 }).action, 'pending');
  assert.equal(th.evaluate(r, { cpu_usage: 95 }, s, { now: NOW + 300 }).action, 'open',
    'only once it has genuinely held');
});

test('⚠️ HYSTERESIS: a device parked ON the threshold does not flap', () => {
  /*
   * THE ONE SUSTAIN CANNOT FIX. A screen at exactly 10.0% free storage satisfies "held for 5 minutes"
   * over and over. Without a separate clear point it opens, closes, opens, closes — every tick,
   * for days.
   */
  const r = rule({ threshold: 10 });          // clears at 11 by the default 10% margin
  const open = { open_event_id: 'e1' };

  // Nudging just above the line must NOT close it.
  assert.equal(th.evaluate(r, sample({ storage_free_mb: 101 }), open, { now: NOW }).action, 'none',
    '10.1% is not recovery');
  // It has to come back properly.
  assert.equal(th.evaluate(r, sample({ storage_free_mb: 120 }), open, { now: NOW }).action, 'close');
});

test('a clear threshold on the wrong side is refused at save time', () => {
  /*
   * ⚠️ An alert that can never close looks exactly like a broken sweep. Refusing it when the rule is
   * written is far kinder than discovering it during an incident.
   */
  const bad = th.validateRule({ metric: 'storage_free_pct', threshold: 10, clear_threshold: 5 });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /must clear ABOVE/i);
  assert.match(bad.reason, /never close/i);

  const badHigh = th.validateRule({ metric: 'cpu_usage', threshold: 80, clear_threshold: 90 });
  assert.equal(badHigh.ok, false);
  assert.match(badHigh.reason, /must clear BELOW/i);

  assert.equal(th.validateRule({ metric: 'storage_free_pct', threshold: 10, clear_threshold: 15 }).ok, true);
});

test('⚠️ NO READING is neither a breach nor a recovery', () => {
  /*
   * A web player reports null battery because it genuinely cannot know. Treating null as 0 would open
   * a critical battery alert on every browser-based screen in the fleet; treating it as fine would
   * silently CLOSE a real alert the moment a device stopped reporting — resolving a problem by losing
   * contact with it.
   */
  const r = rule({ metric: 'battery_level', threshold: 20 });
  assert.equal(th.evaluate(r, { battery_level: null }, {}, { now: NOW }).action, 'none');
  assert.equal(th.evaluate(r, { battery_level: null }, { open_event_id: 'e1' }, { now: NOW }).action,
    'none', 'an open alert must not be closed by silence');
});

test('an unknown metric is inert rather than throwing', () => {
  // A rule referencing a metric a newer build removed must not stop the other rules evaluating.
  const out = th.evaluate({ metric: 'invented', threshold: 1 }, {}, {}, { now: NOW });
  assert.equal(out.action, 'none');
  assert.match(out.reason, /unknown metric/);
});

// ===== lifecycle over the database =====

test('THE LIFECYCLE: open, stay open, close — producing a duration', () => {
  const db = freshDb();
  try {
    db.prepare(`INSERT INTO alert_rules (id,name,metric,threshold,sustain_seconds,severity,enabled,created_at)
                VALUES ('r1','Low storage','storage_free_pct',10,300,'warn',1,?)`).run(NOW);

    // Breaching, but not yet sustained.
    assert.equal(svc.applyOutcome(db, rule(), device, sample(), NOW), 'pending');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM alert_events').get().c, 0);

    // Sustained → opens.
    assert.equal(svc.applyOutcome(db, rule(), device, sample(), NOW + 300), 'open');
    const ev = db.prepare('SELECT * FROM alert_events').get();
    assert.equal(ev.closed_at, null, 'still open');
    assert.equal(ev.workspace_id, 'ws-1');

    // Recovers past the clear point → closes.
    assert.equal(svc.applyOutcome(db, rule(), device, sample({ storage_free_mb: 200 }), NOW + 900), 'close');
    const closed = db.prepare('SELECT * FROM alert_events').get();
    assert.equal(closed.closed_at, NOW + 900);
    assert.equal(closed.closed_at - closed.opened_at, 600, 'and it is now a DURATION');
  } finally { cleanup(db); }
});

test('⚠️ the sustain clock survives a restart', () => {
  /*
   * breaching_since is persisted rather than held in memory. A service restarting hourly could
   * otherwise never open a 5-minute sustained rule — and the failure is completely silent: no alerts,
   * no errors, everything apparently fine.
   */
  const db = freshDb();
  try {
    svc.applyOutcome(db, rule(), device, sample(), NOW);
    const st = db.prepare('SELECT breaching_since FROM alert_rule_state').get();
    assert.equal(st.breaching_since, NOW, 'the clock is on disk');

    // A "restart" is simply another call with no in-memory state — it must still open on time.
    assert.equal(svc.applyOutcome(db, rule(), device, sample(), NOW + 300), 'open');
  } finally { cleanup(db); }
});

test('⚠️ closing DELETES the state, so the next breach starts its sustain afresh', () => {
  /*
   * A stale breaching_since left behind would make the next breach look sustained since the previous
   * one — opening instantly instead of waiting, quietly defeating the sustain window.
   */
  const db = freshDb();
  try {
    svc.applyOutcome(db, rule(), device, sample(), NOW);
    svc.applyOutcome(db, rule(), device, sample(), NOW + 300);
    svc.applyOutcome(db, rule(), device, sample({ storage_free_mb: 300 }), NOW + 400);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM alert_rule_state').get().c, 0);

    // A fresh breach must be PENDING again, not instantly open.
    assert.equal(svc.applyOutcome(db, rule(), device, sample(), NOW + 500), 'pending');
  } finally { cleanup(db); }
});

test('the peak is tracked, so the incident says how bad it got', () => {
  const db = freshDb();
  try {
    svc.applyOutcome(db, rule(), device, sample({ storage_free_mb: 90 }), NOW);
    svc.applyOutcome(db, rule(), device, sample({ storage_free_mb: 90 }), NOW + 300);
    svc.applyOutcome(db, rule(), device, sample({ storage_free_mb: 20 }), NOW + 360);  // worse
    const ev = db.prepare('SELECT opened_value, peak_value FROM alert_events').get();
    assert.equal(Math.round(ev.opened_value), 9);
    assert.equal(Math.round(ev.peak_value), 2, 'the worst point, not the first');
  } finally { cleanup(db); }
});

// ===== the uptime report =====

test('THE ARTIFACT: uptime with the incidents that explain it', () => {
  /*
   * ⚠️ "99.2%" alone invites an argument and cannot be checked. "99.2%, and here are the three
   * outages that made up the 0.8%" is a claim someone can verify — which is the entire reason the
   * history exists.
   */
  const db = freshDb();
  const from = NOW, to = NOW + 86400;
  try {
    db.prepare(`INSERT INTO alert_events (id,rule_id,device_id,workspace_id,metric,severity,opened_at,closed_at)
                VALUES ('e1','r1','dev-1','ws-1','offline_seconds','warn',?,?)`).run(from + 3600, from + 3600 + 600);
    const rep = svc.uptimeReport(db, { from, to, workspaceId: 'ws-1' });
    assert.equal(rep.downSeconds, 600);
    assert.equal(rep.incidentCount, 1);
    assert.equal(rep.uptimePct, 99.3);
    assert.ok(rep.incidents[0].downSeconds === 600, 'and each incident carries its own duration');
  } finally { cleanup(db); }
});

test('⚠️ OVERLAPPING incidents are merged, not summed', () => {
  /*
   * Two rules firing during one outage — offline AND low battery — are ONE period of downtime. Adding
   * the durations double-counts it and can produce more than 100% downtime, the sort of number that
   * destroys trust in the whole report.
   */
  const db = freshDb();
  const from = NOW, to = NOW + 3600;
  try {
    db.prepare(`INSERT INTO alert_events (id,rule_id,device_id,workspace_id,metric,severity,opened_at,closed_at)
                VALUES ('e1','r1','dev-1','ws-1','offline_seconds','warn',?,?)`).run(from + 100, from + 700);
    db.prepare(`INSERT INTO alert_events (id,rule_id,device_id,workspace_id,metric,severity,opened_at,closed_at)
                VALUES ('e2','r2','dev-1','ws-1','battery_level','warn',?,?)`).run(from + 200, from + 800);

    const rep = svc.uptimeReport(db, { from, to, workspaceId: 'ws-1' });
    assert.equal(rep.incidentCount, 2, 'both incidents are listed');
    assert.equal(rep.downSeconds, 700, 'but the downtime is the union, not the sum (600+600)');
  } finally { cleanup(db); }
});

test('an incident spanning the window edge is clamped to the window', () => {
  // Otherwise one long outage can make a month look worse than 0% uptime.
  const db = freshDb();
  const from = NOW, to = NOW + 3600;
  try {
    db.prepare(`INSERT INTO alert_events (id,rule_id,device_id,workspace_id,metric,severity,opened_at,closed_at)
                VALUES ('e1','r1','dev-1','ws-1','offline_seconds','warn',?,?)`)
      .run(from - 100000, to + 100000);
    const rep = svc.uptimeReport(db, { from, to });
    assert.equal(rep.downSeconds, 3600);
    assert.equal(rep.uptimePct, 0, 'exactly zero, never negative');
  } finally { cleanup(db); }
});

test('an ongoing incident counts up to now, and is flagged as ongoing', () => {
  const db = freshDb();
  const from = NOW, to = NOW + 3600;
  try {
    db.prepare(`INSERT INTO alert_events (id,rule_id,device_id,workspace_id,metric,severity,opened_at,closed_at)
                VALUES ('e1','r1','dev-1','ws-1','offline_seconds','warn',?,NULL)`).run(from + 600);
    const rep = svc.uptimeReport(db, { from, to });
    assert.equal(rep.downSeconds, 3000);
    assert.equal(rep.incidents[0].ongoing, true, 'so a report can say "still down"');
  } finally { cleanup(db); }
});

test('open incidents are read from closed_at IS NULL, not a status column', () => {
  // A status column can disagree with the events table; a NULL cannot.
  const db = freshDb();
  try {
    db.prepare(`INSERT INTO alert_events (id,rule_id,device_id,workspace_id,metric,severity,opened_at,closed_at)
                VALUES ('open1','r1','d1','ws-1','cpu_usage','warn',?,NULL)`).run(NOW);
    db.prepare(`INSERT INTO alert_events (id,rule_id,device_id,workspace_id,metric,severity,opened_at,closed_at)
                VALUES ('shut1','r1','d2','ws-1','cpu_usage','warn',?,?)`).run(NOW, NOW + 10);
    const open = svc.openIncidents(db, { workspaceId: 'ws-1' });
    assert.equal(open.length, 1);
    assert.equal(open[0].id, 'open1');
  } finally { cleanup(db); }
});

// ===== containment =====

test('one bad rule does not stop the others being evaluated (I6, one tier down)', () => {
  const db = freshDb();
  try {
    db.prepare(`INSERT INTO alert_rules (id,name,metric,threshold,sustain_seconds,severity,enabled,created_at)
                VALUES ('bad','Broken','no_such_metric',1,0,'warn',1,?)`).run(NOW);
    db.prepare(`INSERT INTO alert_rules (id,name,metric,threshold,sustain_seconds,severity,enabled,created_at)
                VALUES ('good','CPU','cpu_usage',80,0,'warn',1,?)`).run(NOW);
    db.exec(`CREATE TABLE devices (id TEXT PRIMARY KEY, workspace_id TEXT, last_heartbeat INTEGER,
                                   status TEXT, blocked INTEGER);
             CREATE TABLE device_telemetry (device_id TEXT, reported_at INTEGER, battery_level REAL,
               storage_free_mb REAL, storage_total_mb REAL, ram_free_mb REAL, ram_total_mb REAL,
               cpu_usage REAL, wifi_rssi REAL);`);
    db.prepare(`INSERT INTO devices VALUES ('d1','ws-1',?, 'online', 0)`).run(NOW);
    db.prepare(`INSERT INTO device_telemetry (device_id,reported_at,cpu_usage) VALUES ('d1',?,95)`).run(NOW);

    const s = svc.sweep(db, { now: NOW });
    assert.equal(s.rules, 2);
    assert.equal(s.opened, 1, 'the good rule still fired');
    assert.equal(s.errors, 0, 'and the broken one was inert, not an exception');
  } finally { cleanup(db); }
});

test('a rule in a COPIED workspace is the primary\'s to evaluate, not this replica\'s', () => {
  const db = freshDb();
  try {
    db.prepare("INSERT INTO workspaces (id, origin_node_id) VALUES ('ws-copy', 'some-primary')").run();
    db.prepare(`INSERT INTO alert_rules (id,workspace_id,name,metric,threshold,sustain_seconds,severity,enabled,created_at)
                VALUES ('copied','ws-copy','CPU','cpu_usage',80,0,'warn',1,?)`).run(NOW);
    db.prepare(`INSERT INTO alert_rules (id,workspace_id,name,metric,threshold,sustain_seconds,severity,enabled,created_at)
                VALUES ('mine','ws-1','CPU','cpu_usage',80,0,'warn',1,?)`).run(NOW);
    db.exec(`CREATE TABLE devices (id TEXT PRIMARY KEY, workspace_id TEXT, last_heartbeat INTEGER, status TEXT, blocked INTEGER);
             CREATE TABLE device_telemetry (device_id TEXT, reported_at INTEGER, battery_level REAL,
               storage_free_mb REAL, storage_total_mb REAL, ram_free_mb REAL, ram_total_mb REAL,
               cpu_usage REAL, wifi_rssi REAL);`);
    db.prepare(`INSERT INTO devices VALUES ('d1','ws-1',?, 'online', 0)`).run(NOW);
    db.prepare(`INSERT INTO devices VALUES ('d2','ws-copy',?, 'online', 0)`).run(NOW);
    db.prepare(`INSERT INTO device_telemetry (device_id,reported_at,cpu_usage) VALUES ('d1',?,95),('d2',?,95)`).run(NOW, NOW);
    const s = svc.sweep(db, { now: NOW });
    assert.equal(s.rules, 1, 'the copied rule was not even selected');
    assert.equal(s.opened, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM alert_events WHERE rule_id = 'copied'").get().n, 0);
  } finally { cleanup(db); }
});

test('the sweep is a no-op when the tables do not exist', () => {
  // A2 must be invisible on an install that has never migrated — and must not make noise every tick.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-empty-'));
  const db = new Database(path.join(dir, 'e.db'));
  try {
    const s = svc.sweep(db, { now: NOW });
    assert.deepEqual(s, { rules: 0, evaluated: 0, opened: 0, closed: 0, errors: 0 });
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⚠️ the fixture schema matches the REAL one', () => {
  /*
   * The DDL above is hand-written. A fixture that drifts from the real schema proves nothing about
   * production — this project has already been bitten by exactly that with admin-users and
   * email_verified, where a bug in the column had no coverage in either direction.
   */
  const { execFileSync } = require('node:child_process');
  const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-schema-'));
  try {
    const probe = `
      require('./db/database.js');
      const { Database } = require('./db/sqlite-driver');
      const db = new Database(require('path').join(process.env.DATA_DIR, 'db', 'remote_display.db'));
      const out = {};
      for (const t of ['alert_rules','alert_events','alert_rule_state']) {
        out[t] = db.prepare("select name from pragma_table_info('" + t + "')").all().map(r => r.name).sort();
      }
      db.close();
      console.log('SCHEMA=' + JSON.stringify(out));
    `;
    const out = execFileSync(process.execPath, ['-e', probe], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 120000,
      env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', NODE_ENV: 'test' },
    });
    const line = out.split('\n').find((l) => l.startsWith('SCHEMA='));
    assert.ok(line, `probe produced no result:\n${out.slice(-400)}`);
    const real = JSON.parse(line.slice('SCHEMA='.length));

    const fixture = freshDb();
    try {
      for (const [table, realCols] of Object.entries(real)) {
        assert.ok(realCols.length > 0, `${table} is missing from the real schema`);
        const cols = fixture.prepare(`select name from pragma_table_info('${table}')`)
          .all().map((r) => r.name).sort();
        assert.deepEqual(cols, realCols, `${table}: fixture and real schema have drifted`);
      }
    } finally { cleanup(fixture); }
  } finally { fs.rmSync(DATA_DIR, { recursive: true, force: true }); }
});
