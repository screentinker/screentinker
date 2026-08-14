'use strict';

/*
 * Opt-in install statistics — the COLLECTOR side, plus the public aggregate the marketing
 * page reads.
 *
 * Mounted only when TELEMETRY_COLLECTOR=1, so a normal self-hosted install exposes neither
 * route. That gate is doing real work on both: the report endpoint is unauthenticated, and
 * the aggregate would otherwise let any anonymous visitor read a private instance's screen
 * count off its own landing page.
 *
 * A factory rather than a bare router so the database can be injected — which is what lets
 * this be tested at all. It was previously inline in server.js and had no tests.
 */

const express = require('express');

module.exports = function createTelemetryCollectorRouter(db) {
  const router = express.Router();

  /*
   * Deliberately unauthenticated: a self-hosted instance has no credential with us, and
   * issuing one would mean an enrolment handshake for what is a three-integer postcard.
   *
   * Upsert keyed on instance_id, so an install that reports daily occupies one row forever
   * rather than 365 a year. Nothing here reads or stores the request IP — receiving one is
   * unavoidable, logging it would quietly make a pseudonymous report an identifiable one.
   */
  router.post('/telemetry/report', express.json({ limit: '2kb' }), (req, res) => {
    const { instance_id: id, version, screen_count: screens } = req.body || {};
    // Validate rather than trust: this endpoint is open, so a malformed or hostile body must
    // land as a 400, never as a row that poisons the count it exists to produce.
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'bad instance_id' });
    if (version != null && (typeof version !== 'string' || version.length > 40)) return res.status(400).json({ error: 'bad version' });
    if (!Number.isInteger(screens) || screens < 0 || screens > 100000) return res.status(400).json({ error: 'bad screen_count' });
    db.prepare(`INSERT INTO telemetry_reports (instance_id, version, screen_count, first_seen, last_seen)
                VALUES (?, ?, ?, strftime('%s','now'), strftime('%s','now'))
                ON CONFLICT(instance_id) DO UPDATE SET
                  version = excluded.version, screen_count = excluded.screen_count, last_seen = excluded.last_seen`)
      .run(id, version || null, screens);
    res.json({ ok: true });
  });

  /*
   * The aggregate, for the marketing page. An aggregate across every install that reports,
   * so it discloses nothing about any one of them.
   *
   * Cached, because this sits on a public landing page and the number moves in hours, not
   * milliseconds. A scraper hitting it in a loop costs one query per interval, not per request.
   */
  const STATS_TTL_MS = 5 * 60 * 1000;
  let statsCache = { at: 0, body: null };

  router.get('/public/stats', (req, res) => {
    const now = Date.now();
    if (!statsCache.body || now - statsCache.at > STATS_TTL_MS) {
      const row = db.prepare(
        'SELECT COUNT(*) AS installs, COALESCE(SUM(screen_count), 0) AS screens FROM telemetry_reports'
      ).get();
      statsCache = { at: now, body: { screens: row.screens, installs: row.installs } };
    }
    // Public and cacheable, but never for long by a shared cache: the number is meant to climb.
    res.set('Cache-Control', 'public, max-age=300');
    res.json(statsCache.body);
  });

  return router;
};
