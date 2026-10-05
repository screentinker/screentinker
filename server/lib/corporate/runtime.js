'use strict';

/*
 * Is the corporate (head office) machinery in force on this server, right now?
 *
 * ⚠️ EVERY guard and helper the rest of the product calls starts with `if (!active(db)) return
 * <today's behaviour>`. Two reasons:
 *
 *   1. An install that never uses the feature must behave byte-identically to before it shipped —
 *      no extra refusals, no extra queries on hot paths beyond this probe.
 *   2. Degraded mode. If the per-boot verifier (lib/playlist-resolver-sql.js) found that the new
 *      resolver would change what some screen plays, the PREVIOUS views are kept and the feature
 *      is switched off here; corporate write routes answer 503 CORPORATE_UNAVAILABLE and nothing
 *      else changes. None of the short-circuited helpers may name a view or table degraded mode
 *      lacks.
 *
 * `active` is a LIVE probe rather than the cached boolean the spec sketched: a cache needs every
 * writer of corporate_mandates / organizations.corporate_enabled to remember to refresh it (the
 * fan-out-that-forgets-a-case bug this codebase keeps meeting), and the probe is one LIMIT-1 read of
 * a tiny table. Any failure (a hand-built fixture without the tables) reads as inactive.
 *
 * CORPORATE_TEST_FORCE_DEGRADED=1 is a TEST-ONLY seam: it re-runs the existing group, wall,
 * schedule, assignment and trigger suites with every corporate helper short-circuited.
 */

let viewsDegraded = process.env.CORPORATE_TEST_FORCE_DEGRADED === '1';

function setViewsDegraded(v) { viewsDegraded = !!v; }
function isViewsDegraded() { return viewsDegraded; }

const ACTIVE_SQL = `SELECT 1 FROM corporate_mandates cm
  JOIN organizations o ON o.id = cm.organization_id
 WHERE cm.enabled = 1 AND o.corporate_enabled = 1 LIMIT 1`;

/** Any enabled mandate in an org that has corporate playlists switched on, and views not degraded. */
function active(db) {
  if (viewsDegraded) return false;
  try { return !!db.prepare(ACTIVE_SQL).get(); } catch (_) { return false; }
}

/**
 * Emergency alerts (Stage C) are gated separately: an org may use them without corporate
 * playlists, and they do not depend on the resolver views, so degraded mode leaves them working.
 */
function emergencyActive(db) {
  try {
    return !!db.prepare(`SELECT 1 FROM triggers t
        JOIN workspaces w ON w.id = t.workspace_id
        JOIN organizations o ON o.id = w.organization_id
       WHERE t.kind = 'emergency' AND t.enabled = 1 AND o.emergency_triggers_enabled = 1 LIMIT 1`).get();
  } catch (_) { return false; }
}

module.exports = { active, emergencyActive, setViewsDegraded, isViewsDegraded };
