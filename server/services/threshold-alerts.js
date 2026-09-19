'use strict';

/*
 * The threshold-alert sweep (A2): evaluate every enabled rule against every device, and keep a
 * durable record of what was wrong and for how long.
 *
 * ⚠️ WHAT MAKES THIS DIFFERENT FROM services/alerts.js. That one sends an email and remembers
 * nothing, so "were my screens up last month, and what happened?" has never been answerable — there
 * is no record that an outage began or ended. Here an incident OPENS and later CLOSES, which makes
 * it a duration, and durations are what an uptime report is made of. The notification is a side
 * effect of the incident, not the other way round.
 *
 * ⚠️ IT MUST NEVER THROW INTO THE TICK. One device with odd telemetry, one rule referencing a metric
 * a newer build removed — neither may stop the other forty-nine rules from being evaluated. Every
 * per-device evaluation is wrapped for the same reason the mesh envelope handler is (I6, one tier
 * down).
 */

const crypto = require('crypto');
// Scale-out: a sweep on a replica must never act on a COPIED workspace (docs/scale-out-design.md §5.5).
const { LOCAL_ROWS_SQL } = require('../lib/replica-proxy');
const thresholds = require('../lib/alerts/thresholds');

const TICK_MS = 60_000;

/**
 * Evaluate one rule against one device and apply the outcome.
 *
 * Split out and dependency-injected so the decision path is testable without a running service —
 * the sweep below is scheduling and error containment, and those are not where the bugs live.
 */
function applyOutcome(db, rule, device, sample, now) {
  const state = db.prepare(
    'SELECT breaching_since, open_event_id FROM alert_rule_state WHERE rule_id = ? AND device_id = ?'
  ).get(rule.id, device.id) || {};

  const outcome = thresholds.evaluate(rule, sample, state, { now });

  switch (outcome.action) {
    case 'pending': {
      // ⚠️ Persisted, not held in memory: a service restarting hourly could otherwise never open a
      // rule with a 5-minute sustain, and the failure is completely silent.
      db.prepare(`
        INSERT INTO alert_rule_state (rule_id, device_id, breaching_since, last_value, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(rule_id, device_id) DO UPDATE SET
          breaching_since = COALESCE(alert_rule_state.breaching_since, excluded.breaching_since),
          last_value = excluded.last_value, updated_at = excluded.updated_at
      `).run(rule.id, device.id, now, outcome.value, now);
      return 'pending';
    }

    case 'open': {
      const id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO alert_events
          (id, rule_id, device_id, workspace_id, metric, severity, opened_at, opened_value, peak_value)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, rule.id, device.id, device.workspace_id || null, rule.metric,
             rule.severity || 'warn', now, outcome.value, outcome.value);
      db.prepare(`
        INSERT INTO alert_rule_state (rule_id, device_id, breaching_since, open_event_id, last_value, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(rule_id, device_id) DO UPDATE SET
          open_event_id = excluded.open_event_id, last_value = excluded.last_value,
          updated_at = excluded.updated_at
      `).run(rule.id, device.id, state.breaching_since || now, id, outcome.value, now);
      return 'open';
    }

    case 'close': {
      if (state.open_event_id) {
        db.prepare(`
          UPDATE alert_events SET closed_at = ?, closed_value = ? WHERE id = ? AND closed_at IS NULL
        `).run(now, outcome.value, state.open_event_id);
      }
      /*
       * ⚠️ The state row is DELETED, not blanked. A stale breaching_since left behind would make the
       * next breach appear to have been sustained since the last one — opening instantly instead of
       * waiting, which quietly defeats the whole point of a sustain window.
       */
      db.prepare('DELETE FROM alert_rule_state WHERE rule_id = ? AND device_id = ?')
        .run(rule.id, device.id);
      return 'close';
    }

    default: {
      // Not breaching, and not open: clear any half-started sustain so it starts fresh next time.
      if (!state.open_event_id && state.breaching_since && outcome.value !== null) {
        db.prepare('DELETE FROM alert_rule_state WHERE rule_id = ? AND device_id = ?')
          .run(rule.id, device.id);
      } else if (state.open_event_id && outcome.value !== null) {
        // Still open: track how bad it got, which is what the incident summary reports.
        db.prepare(`
          UPDATE alert_events
             SET peak_value = CASE
               WHEN peak_value IS NULL THEN ?
               WHEN ? > peak_value AND ? > opened_value THEN ?
               WHEN ? < peak_value AND ? < opened_value THEN ?
               ELSE peak_value END
           WHERE id = ?
        `).run(outcome.value, outcome.value, outcome.value, outcome.value,
               outcome.value, outcome.value, outcome.value, state.open_event_id);
      }
      return 'none';
    }
  }
}

/** One pass over every enabled rule. Returns a summary for logging and tests. */
function sweep(db, { now = Math.floor(Date.now() / 1000), logger = console } = {}) {
  const summary = { rules: 0, evaluated: 0, opened: 0, closed: 0, errors: 0 };

  let rules = [];
  try {
    rules = db.prepare(`SELECT * FROM alert_rules WHERE enabled = 1 AND ${LOCAL_ROWS_SQL('alert_rules')}`).all();
  } catch (e) {
    // No table yet — nothing to do, and certainly not a reason to make noise every minute.
    return summary;
  }
  if (!rules.length) return summary;
  summary.rules = rules.length;

  /*
   * The latest telemetry per device, joined to the device row. One query for the whole sweep rather
   * than one per device: at 500 devices and 6 rules the per-device shape is 3000 queries a minute,
   * which is how a background sweep becomes the reason the dashboard is slow.
   */
  let devices = [];
  try {
    devices = db.prepare(`
      SELECT d.id, d.workspace_id, d.last_heartbeat, d.status,
             t.battery_level, t.storage_free_mb, t.storage_total_mb,
             t.ram_free_mb, t.ram_total_mb, t.cpu_usage, t.wifi_rssi
        FROM devices d
        LEFT JOIN (
          SELECT device_id, MAX(reported_at) AS reported_at FROM device_telemetry GROUP BY device_id
        ) latest ON latest.device_id = d.id
        LEFT JOIN device_telemetry t
               ON t.device_id = d.id AND t.reported_at = latest.reported_at
       WHERE (d.blocked IS NULL OR d.blocked = 0) AND ${LOCAL_ROWS_SQL('d')}
    `).all();
  } catch (e) {
    logger.warn(`[alerts] could not read devices for threshold sweep: ${e && e.message}`);
    return summary;
  }

  for (const rule of rules) {
    for (const device of devices) {
      try {
        const action = applyOutcome(db, rule, device, device, now);
        summary.evaluated += 1;
        if (action === 'open') summary.opened += 1;
        if (action === 'close') summary.closed += 1;
      } catch (e) {
        // ⚠️ One bad device or one malformed rule must not stop the other evaluations.
        summary.errors += 1;
        logger.warn(`[alerts] rule ${rule.id} on device ${device.id}: ${e && e.message}`);
      }
    }
  }
  return summary;
}

function startThresholdAlerts(db, opts = {}) {
  const timer = setInterval(() => {
    try { sweep(db, opts); } catch (e) {
      (opts.logger || console).warn(`[alerts] threshold sweep failed: ${e && e.message}`);
    }
  }, opts.tickMs || TICK_MS);
  // An alert sweep is not a reason to hold the process open.
  if (timer.unref) timer.unref();
  return timer;
}

/**
 * Open incidents right now — "what is wrong", which is the alert inbox.
 *
 * Reads closed_at IS NULL rather than a status column, so it cannot disagree with the events table.
 */
function openIncidents(db, { workspaceId = null } = {}) {
  const sql = `SELECT * FROM alert_events WHERE closed_at IS NULL` +
              (workspaceId ? ' AND workspace_id = ?' : '') + ' ORDER BY opened_at DESC';
  return workspaceId ? db.prepare(sql).all(workspaceId) : db.prepare(sql).all();
}

/**
 * Uptime over a window, with the incidents behind it.
 *
 * ⚠️ THE INCIDENTS ARE RETURNED WITH THE NUMBER, DELIBERATELY. "99.2%" on its own invites an argument
 * and cannot be checked; "99.2%, and here are the three outages that made up the 0.8%" is a claim
 * somebody can verify. This is the artifact the whole alert-history design exists to produce.
 *
 * Incidents are CLAMPED to the window, so an outage spanning the boundary contributes only the part
 * inside it — otherwise a single long outage can make a month look worse than 0% uptime.
 */
function uptimeReport(db, { from, to, workspaceId = null, deviceId = null }) {
  const clauses = ['opened_at < ?', '(closed_at IS NULL OR closed_at > ?)'];
  const params = [to, from];
  if (workspaceId) { clauses.push('workspace_id = ?'); params.push(workspaceId); }
  if (deviceId) { clauses.push('device_id = ?'); params.push(deviceId); }

  const events = db.prepare(
    `SELECT * FROM alert_events WHERE ${clauses.join(' AND ')} ORDER BY opened_at`).all(...params);

  const windowSeconds = Math.max(1, to - from);
  const incidents = events.map((e) => {
    const start = Math.max(e.opened_at, from);
    const end = Math.min(e.closed_at || to, to);
    return { ...e, downSeconds: Math.max(0, end - start), ongoing: e.closed_at === null };
  });

  /*
   * ⚠️ OVERLAPPING INCIDENTS ARE MERGED BEFORE SUMMING. Two rules firing on one device during one
   * outage — offline AND low battery — are one period of downtime, not two. Adding the durations
   * would double-count it and can produce more than 100% downtime, which is the sort of number that
   * destroys trust in the whole report.
   */
  const merged = [];
  for (const i of [...incidents].sort((a, b) => (Math.max(a.opened_at, from) - Math.max(b.opened_at, from)))) {
    const start = Math.max(i.opened_at, from);
    const end = Math.min(i.closed_at || to, to);
    const last = merged[merged.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else merged.push({ start, end });
  }
  const downSeconds = merged.reduce((n, m) => n + Math.max(0, m.end - m.start), 0);

  return {
    from, to, windowSeconds,
    downSeconds,
    uptimePct: Math.round(((windowSeconds - downSeconds) / windowSeconds) * 1000) / 10,
    incidentCount: incidents.length,
    incidents,
  };
}

module.exports = {
  sweep, applyOutcome, startThresholdAlerts, openIncidents, uptimeReport, TICK_MS,
};
