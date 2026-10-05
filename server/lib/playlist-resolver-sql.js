'use strict';

/*
 * The playlist-inheritance resolver, as SQL, in ONE place.
 *
 * Both the boot migration (db/database.js) and any test fixture that hand-builds a schema apply it
 * from here. The alternative — pasting CREATE VIEW into a fixture — is how a fixture drifts from
 * the real schema and starts proving things about a database that does not exist.
 *
 * ⚠️ Apply this AFTER every table-rebuilding migration. SQLite refuses to drop a table a view still
 * references, so defining these early broke the tenant delete-cascade migration on every install
 * ("no such table: main.devices"). A view is a dependency on every table it names.
 *
 * DROP-then-CREATE rather than IF NOT EXISTS, so the definition can never drift from the code that
 * ships with it: a view pinned at first-create is a migration you cannot amend.
 */

// Where a device would inherit from, ignoring anything chosen for the device itself. Kept separate
// so the backfill can ask "what WOULD this device inherit?" without consulting playlist_source —
// the column it is in the middle of computing.
const INHERITED_VIEW = `CREATE VIEW device_inherited_playlist AS
  SELECT d.id AS device_id,
         (SELECT vw.playlist_id FROM video_walls vw
           WHERE vw.id = d.wall_id AND vw.playlist_id IS NOT NULL) AS wall_playlist_id,
         (SELECT g.playlist_id FROM device_groups g
            JOIN device_group_members m ON m.group_id = g.id
           WHERE m.device_id = d.id AND g.playlist_id IS NOT NULL
           ORDER BY g.priority DESC, g.created_at ASC, g.id ASC LIMIT 1) AS group_playlist_id
    FROM devices d`;

/*
 * ─── Corporate (head office) mandates — the tier above everything ─────────────────────────────
 *
 * A mandate says "these screens play head office's playlist, whatever the store chose". It is the
 * TOP of the ladder: above an active schedule, a device override, the wall, the group, the raw id
 * and the deliberate 'none'. Only a dark mandate blanks a mandated screen. See
 * lib/corporate/guard.js for who may write one and docs/corporate spec §2.
 *
 * ⚠️ PERFORMANCE IS THE DESIGN CONSTRAINT HERE. The first draft used a separate view joined as a
 * derived table; SQLite could not flatten it and materialized it on every lookup — 1.1 ms per
 * single-device read with ZERO mandates, ~400x today's 0.003 ms, on a query run per payload build.
 * This is a correlated scalar subquery computed as a column of a FROM-subquery on `devices`, which
 * SQLite flattens, so a `device_id = ?` lookup stays an index SEARCH: 0.0031 ms with no mandates,
 * 0.0057 ms with 15 (6,000-device bench). test/corporate-resolver-view.test.js guards both the
 * plan and the timing.
 *
 * The leading NOT EXISTS makes an install that never uses the feature pay one empty-table probe.
 *
 * Level order: device = wall (mutually exclusive: a wall member is never targeted alone, or the
 * wall would tear across the seam) > group (priority DESC, oldest first — the group rule) >
 * workspace > org. A mandate counts only while it is enabled, its org has corporate_enabled = 1,
 * and (unless dark) its playlist is a corporate playlist of the SAME org: a row written by any
 * other path cannot point a store's screens at a foreign tenant's content.
 */
const MANDATE_EXPR = `CASE WHEN NOT EXISTS (SELECT 1 FROM corporate_mandates WHERE enabled = 1) THEN NULL ELSE (
      SELECT cm.id FROM corporate_mandates cm
       WHERE cm.enabled = 1
         AND cm.organization_id = (SELECT dw.organization_id FROM workspaces dw WHERE dw.id = d.workspace_id)
         AND (SELECT o.corporate_enabled FROM organizations o WHERE o.id = cm.organization_id) = 1
         AND (cm.dark = 1 OR EXISTS (SELECT 1 FROM playlists p JOIN workspaces pw ON pw.id = p.workspace_id
                                      WHERE p.id = cm.playlist_id AND p.corporate = 1
                                        AND pw.organization_id = cm.organization_id))
         AND (   (cm.target_kind = 'device' AND d.wall_id IS NULL AND cm.target_id = d.id)
              OR (cm.target_kind = 'wall'   AND cm.target_id = d.wall_id)
              OR (cm.target_kind = 'group'  AND d.wall_id IS NULL AND cm.target_id IN (
                     SELECT m.group_id FROM device_group_members m
                       JOIN device_groups g ON g.id = m.group_id AND g.workspace_id = d.workspace_id
                      WHERE m.device_id = d.id))
              OR (cm.target_kind = 'workspace' AND cm.target_id = d.workspace_id)
              OR (cm.target_kind = 'org'       AND cm.target_id = cm.organization_id))
       ORDER BY CASE cm.target_kind WHEN 'device' THEN 4 WHEN 'wall' THEN 4 WHEN 'group' THEN 3
                                    WHEN 'workspace' THEN 2 ELSE 1 END DESC,
                (SELECT g.priority   FROM device_groups g WHERE g.id = cm.target_id) DESC,
                (SELECT g.created_at FROM device_groups g WHERE g.id = cm.target_id) ASC,
                cm.created_at ASC, cm.id ASC
       LIMIT 1) END`;

/*
 * The rule itself. Order mirrors routes/schedules.js (device beats group, then priority, then
 * oldest) deliberately: two inheritance systems in one product that disagree is how an operator
 * stops trusting both. Walls sit above groups because a wall member playing the group's playlist
 * tears the picture across the seam — visibly broken — while a grouped screen playing the wall's is
 * merely not what you asked for. Where precedence must guess, guess toward the legible failure.
 *
 * ⚠️ The COLUMN LIST (device_id, playlist_id, source, layout_id) is a contract: every reader names
 * these four, and the per-boot verifier below can fall back to the previous definition precisely
 * because the shape never changes. A new tier adds a value of `source`, never a column.
 */
const RESOLVED_VIEW = `CREATE VIEW device_resolved_playlist AS
  SELECT d.id AS device_id,
         CASE
           -- A head office mandate outranks everything below. A dark mandate resolves to NULL.
           WHEN cm.id IS NOT NULL THEN cm.playlist_id
           -- 'none' short-circuits everything else: "deliberately plays nothing" is not the same
           -- as "nothing was chosen". Without this branch the backfill's carefully-preserved dark
           -- screens inherit their group's playlist and light up during an upgrade.
           WHEN d.playlist_source = 'none' AND d.scheduled_playlist_id IS NULL THEN NULL
           ELSE COALESCE(
           -- An ACTIVE SCHEDULE outranks everything else, including a device override and 'none':
           -- it is the operator saying "at this time of day, this instead". It outranks 'none' too,
           -- or a deliberately dark screen could never be scheduled to show anything.
           d.scheduled_playlist_id,
           CASE WHEN d.playlist_source = 'device' THEN d.playlist_id END,
           i.wall_playlist_id,
           i.group_playlist_id,
           -- LAST RESORT: an id nobody has classified. playlist_source is NULL both for "inherits"
           -- and for "a writer set playlist_id and never learned about the column", and resolving
           -- the second case to NOTHING turned 12 tests red. Honouring the raw id BELOW the
           -- inherited sources means an unconverted writer keeps working while the migration is
           -- staged, and a stale copy still loses to the group.
           d.playlist_id
         ) END AS playlist_id,
         CASE
           WHEN cm.id IS NOT NULL THEN 'corporate'
           WHEN d.scheduled_playlist_id IS NOT NULL THEN 'schedule'
           WHEN d.playlist_source = 'none' THEN NULL
           WHEN d.playlist_source = 'device' AND d.playlist_id IS NOT NULL THEN 'device'
           WHEN i.wall_playlist_id  IS NOT NULL THEN 'wall'
           WHEN i.group_playlist_id IS NOT NULL THEN 'group'
           WHEN d.playlist_id IS NOT NULL THEN 'device'
           ELSE NULL
         END AS source,
         -- Layout follows the same rule, for the same reason: the scheduler used to overwrite
         -- devices.layout_id and revert it from memory. There is no group or wall tier here —
         -- a layout has only ever been per-device.
         -- ⚠️ A MANDATE ALWAYS DECIDES THE LAYOUT: head office's own, or NULL = full screen. A
         -- store layout could otherwise shrink every corporate item into a 1% zone.
         CASE WHEN cm.id IS NOT NULL THEN cm.layout_id
              ELSE COALESCE(d.scheduled_layout_id, d.layout_id) END AS layout_id
    FROM (SELECT d.*, ${MANDATE_EXPR} AS mandate_id FROM devices d) d
    JOIN device_inherited_playlist i ON i.device_id = d.id
    LEFT JOIN corporate_mandates cm ON cm.id = d.mandate_id`;

const VIEW_NAMES = ['device_resolved_playlist', 'device_inherited_playlist'];

/**
 * Drop both views, returning the SQL they were defined with (for the verifier).
 *
 * ⚠️ db/database.js calls this as the FIRST migration step and applyResolverViews as the LAST, so
 * no migration — today's tenant-cascade rebuild of playlists or a future rebuild of any table these
 * views name — ever runs with a view present. SQLite refuses to drop or rename a table a view still
 * references, and these views now name eight tables.
 *
 * @returns {{inherited: string|null, resolved: string|null}}
 */
function dropResolverViews(db) {
  const prev = { inherited: null, resolved: null };
  try {
    for (const r of db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'view' AND name IN (?, ?)")
      .all('device_inherited_playlist', 'device_resolved_playlist')) {
      if (r.name === 'device_inherited_playlist') prev.inherited = r.sql;
      else prev.resolved = r.sql;
    }
  } catch (_) { /* no sqlite_master access on an exotic driver: nothing to verify against */ }
  for (const v of VIEW_NAMES) db.exec(`DROP VIEW IF EXISTS ${v}`);
  return prev;
}

const UPGRADE_ID = 'corporate_resolver_v1';

function renameForTemp(sql) {
  return sql
    .replace(/^\s*CREATE\s+VIEW\s+/i, 'CREATE TEMP VIEW ')
    .replace(/\bdevice_inherited_playlist\b/g, '_prev_device_inherited_playlist')
    .replace(/\bdevice_resolved_playlist\b/g, '_prev_device_resolved_playlist');
}

/**
 * (Re)create both views. Idempotent, and safe to call on a fixture whose tables were hand-built.
 *
 * With `{verify: true, previousSql}` (db/database.js only; fixtures keep the default) it PROVES the
 * new definition changes no screen before keeping it:
 *
 *   1. previous SQL identical to the new SQL      -> create, done (every boot after the first).
 *   2. no previous SQL (a fresh database)         -> create, record the upgrade id.
 *   3. otherwise create the previous definitions as TEMP views, the new ones under their real
 *      names, and diff (playlist_id, source, layout_id) for every device whose NEW source is not
 *      'corporate'. Empty -> keep the new views, record the upgrade id. Non-empty -> put the
 *      PREVIOUS views back, log the first ten devices that would have changed, and mark
 *      lib/corporate/runtime.js degraded: corporate write routes answer 503, playback is untouched.
 *
 * ⚠️ Not process.exit on a failed check: that would crash-loop the server. The column list is the
 * same, so the previous views keep every reader working.
 *
 * `opts.resolvedViewSql` is a TEST SEAM only (inject a deliberately wrong definition).
 *
 * ⚠️ A fixture must provide every column named below or SQLite rejects the view at CREATE time —
 * which is the point: the failure is loud rather than a test quietly proving things about a
 * database that does not exist. Currently:
 *
 *   devices           id, workspace_id, playlist_id, playlist_source, wall_id, layout_id,
 *                     scheduled_playlist_id, scheduled_layout_id
 *   video_walls       id, playlist_id
 *   device_groups     id, workspace_id, playlist_id, priority, created_at
 *   device_group_members  device_id, group_id
 *   workspaces        id, organization_id
 *   organizations     id, corporate_enabled
 *   playlists         id, workspace_id, corporate
 *   corporate_mandates (all columns — lib/corporate/schema-sql.js)
 *
 * Adding a column here means updating that list, lib/schema-check.js's REQUIRED_COLUMNS AND any
 * hand-built fixture (see test/operator-permissions.test.js) — the same duty a new column creates
 * everywhere else.
 *
 * @returns {{status: 'created'|'same'|'fresh'|'verified'|'degraded', changed?: Array}}
 */
function applyResolverViews(db, opts = {}) {
  const resolvedSql = opts.resolvedViewSql || RESOLVED_VIEW;
  if (!opts.verify) {
    for (const v of VIEW_NAMES) db.exec(`DROP VIEW IF EXISTS ${v}`);
    db.exec(INHERITED_VIEW);
    db.exec(resolvedSql);
    return { status: 'created' };
  }
  const prev = opts.previousSql || { inherited: null, resolved: null };
  for (const v of VIEW_NAMES) db.exec(`DROP VIEW IF EXISTS ${v}`);
  const record = () => {
    try { db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(UPGRADE_ID); } catch (_) { /* no table */ }
  };

  if (prev.inherited === INHERITED_VIEW && prev.resolved === resolvedSql) {
    db.exec(INHERITED_VIEW);
    db.exec(resolvedSql);
    record();
    return { status: 'same' };
  }
  if (!prev.inherited || !prev.resolved) {
    db.exec(INHERITED_VIEW);
    db.exec(resolvedSql);
    record();
    return { status: 'fresh' };
  }

  const dropTemps = () => {
    db.exec('DROP VIEW IF EXISTS temp._prev_device_resolved_playlist');
    db.exec('DROP VIEW IF EXISTS temp._prev_device_inherited_playlist');
  };
  let changed = [];
  try {
    dropTemps();
    db.exec(renameForTemp(prev.inherited));
    db.exec(renameForTemp(prev.resolved));
    db.exec(INHERITED_VIEW);
    db.exec(resolvedSql);
    changed = db.prepare(`
      SELECT n.device_id, o.playlist_id AS was, n.playlist_id AS now, o.source AS was_source,
             n.source AS now_source, o.layout_id AS was_layout, n.layout_id AS now_layout
        FROM device_resolved_playlist n
        JOIN _prev_device_resolved_playlist o ON o.device_id = n.device_id
       WHERE IFNULL(n.source, '') != 'corporate'
         AND (n.playlist_id IS NOT o.playlist_id OR n.source IS NOT o.source OR n.layout_id IS NOT o.layout_id)
    `).all();
  } catch (e) {
    changed = [{ device_id: '*', error: e.message }];
  }
  dropTemps();

  if (!changed.length) {
    record();
    return { status: 'verified' };
  }

  for (const v of VIEW_NAMES) db.exec(`DROP VIEW IF EXISTS ${v}`);
  db.exec(prev.inherited);
  db.exec(prev.resolved);
  console.error(`[corporate] ABORT view upgrade: ${changed.length} device(s) would change what they play. `
    + 'The previous resolver is kept; corporate playlists are unavailable until this is fixed.');
  for (const c of changed.slice(0, 10)) {
    console.error(`  device ${c.device_id}: ${c.error || `${c.was} (${c.was_source}) -> ${c.now} (${c.now_source}), layout ${c.was_layout} -> ${c.now_layout}`}`);
  }
  require('./corporate/runtime').setViewsDegraded(true);
  return { status: 'degraded', changed };
}

module.exports = { applyResolverViews, dropResolverViews, INHERITED_VIEW, RESOLVED_VIEW, MANDATE_EXPR, UPGRADE_ID };
