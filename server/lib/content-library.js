'use strict';

/*
 * What the Content Library page asks of the content table beyond a plain list: where an item is
 * used, which items are unused, and the scope/status filters behind the library's navigation.
 *
 * ⚠️ "UNUSED" MEANS NOTHING REFERENCES IT, NOT "IN NO PLAYLIST". A file can play on a screen without
 * being a playlist item: as a wall's content, a schedule entry, a legacy assignment, a screen's
 * default, a corporate slot's fallback, a smart playlist's published copy, an image inside a widget's
 * config, or a slide deck's background. Calling such a file "Unused" invites deleting something that
 * is on air, so every one of those is checked here, and the page says "Unused" only when all of them
 * are empty. The playlist COUNT is the narrower, linkable number ("Used in 3 playlists").
 *
 * The reference list mirrors what purgeContentRow (routes/content.js) cleans up on delete and what
 * lib/content-reference.js checks for player access; a new place that stores a content id should be
 * added to all three.
 */

const RECENT_DAYS = 7;

// One EXISTS per place a content id can be referenced. `c` is the content row's alias.
const REFERENCED_SQL = `(
  EXISTS (SELECT 1 FROM playlist_items pi WHERE pi.content_id = c.id)
  OR EXISTS (SELECT 1 FROM playlists sp WHERE sp.workspace_id = c.workspace_id AND sp.published_snapshot LIKE '%' || c.id || '%')
  OR EXISTS (SELECT 1 FROM video_walls vw WHERE vw.content_id = c.id)
  OR EXISTS (SELECT 1 FROM schedules sc WHERE sc.content_id = c.id)
  OR EXISTS (SELECT 1 FROM assignments asg WHERE asg.content_id = c.id)
  OR EXISTS (SELECT 1 FROM devices dv WHERE dv.default_content_id = c.id)
  OR EXISTS (SELECT 1 FROM corporate_slots cs WHERE cs.fallback_content_id = c.id)
  OR EXISTS (SELECT 1 FROM widgets wg WHERE (wg.workspace_id = c.workspace_id OR wg.workspace_id IS NULL) AND (wg.config LIKE '%' || c.id || '%' OR wg.draft_config LIKE '%' || c.id || '%'))
  OR EXISTS (SELECT 1 FROM slide_decks sd WHERE sd.workspace_id = c.workspace_id AND sd.doc LIKE '%' || c.id || '%')
)`;

// Playlists that use the item: as an item, or (smart playlists, which have no item rows) in their
// published copy. Distinct, so an item twice in one playlist counts once.
const PLAYLISTS_SQL = `
  SELECT p.id, p.name, p.is_auto_generated, (p.smart_rules IS NOT NULL) AS smart
  FROM playlists p
  WHERE p.id IN (SELECT pi.playlist_id FROM playlist_items pi WHERE pi.content_id = @id)
     OR (p.workspace_id = @ws AND p.smart_rules IS NOT NULL AND p.published_snapshot LIKE '%' || @id || '%')
  ORDER BY p.name COLLATE NOCASE, p.id`;

const LIVE_SQL = "c.is_active = 1 AND (c.expires_at IS NULL OR c.expires_at > strftime('%s','now'))";
const CANVA_ERROR_SQL = 'EXISTS (SELECT 1 FROM canva_links cl WHERE cl.content_id = c.id AND cl.last_error IS NOT NULL)';

/*
 * The library's status filter. Every value is a real state of the row:
 *   ready    live (not expired or deactivated), no unpublished draft, no failing Canva sync
 *   review   has an unpublished draft (a replace or playback change in an approval workspace)
 *   attention  a linked Canva design whose last sync failed
 *   expired  past its expiry, or deactivated by the expiry sweep
 * There is no "processing" or "failed" status: an upload becomes a row only once it is ready
 * (lib/content-ingest.js runs synchronously), so those states exist only in the page's upload queue.
 */
const STATUS_SQL = {
  ready: `${LIVE_SQL} AND c.draft_json IS NULL AND NOT ${CANVA_ERROR_SQL}`,
  review: `${LIVE_SQL} AND c.draft_json IS NOT NULL`,
  attention: `${LIVE_SQL} AND ${CANVA_ERROR_SQL}`,
  expired: `NOT (${LIVE_SQL})`,
};

/** Usage for a page of rows: { [id]: { playlists, in_use } }. */
function usageFor(db, rows) {
  const out = {};
  if (!rows.length) return out;
  const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM (${PLAYLISTS_SQL})`);
  const refStmt = db.prepare(`SELECT ${REFERENCED_SQL} AS used FROM content c WHERE c.id = ?`);
  for (const r of rows) {
    const playlists = countStmt.get({ id: r.id, ws: r.workspace_id }).n;
    out[r.id] = { playlists, in_use: playlists > 0 || !!refStmt.get(r.id).used };
  }
  return out;
}

/**
 * Where one item is used: the playlists by name (the page links each one), and a count for each
 * other kind of reference, so "Not in a playlist, but used by 1 wall" can be said.
 */
function usageDetail(db, row) {
  const playlists = db.prepare(PLAYLISTS_SQL).all({ id: row.id, ws: row.workspace_id })
    .map((p) => ({ id: p.id, name: p.name, auto: !!p.is_auto_generated, smart: !!p.smart }));
  const n = (sql, ...a) => db.prepare(sql).get(...a).n;
  const like = `%${row.id}%`;
  const elsewhere = {
    walls: n('SELECT COUNT(*) AS n FROM video_walls WHERE content_id = ?', row.id),
    schedules: n('SELECT COUNT(*) AS n FROM schedules WHERE content_id = ?', row.id)
      + n('SELECT COUNT(*) AS n FROM assignments WHERE content_id = ?', row.id),
    screens: n('SELECT COUNT(*) AS n FROM devices WHERE default_content_id = ?', row.id),
    corporate: n('SELECT COUNT(*) AS n FROM corporate_slots WHERE fallback_content_id = ?', row.id),
    widgets: n('SELECT COUNT(*) AS n FROM widgets WHERE (workspace_id = ? OR workspace_id IS NULL) AND (config LIKE ? OR draft_config LIKE ?)', row.workspace_id, like, like),
    slides: n('SELECT COUNT(*) AS n FROM slide_decks WHERE workspace_id = ? AND doc LIKE ?', row.workspace_id, like),
  };
  const inUse = playlists.length > 0 || Object.values(elsewhere).some((v) => v > 0);
  return { playlists, elsewhere, in_use: inUse };
}

/** Counts behind the library's navigation, over the live set the default list shows. */
function summary(db, workspaceId) {
  const base = `FROM content c WHERE (c.workspace_id = ? OR c.workspace_id IS NULL) AND ${LIVE_SQL}`;
  const one = (extra) => db.prepare(`SELECT COUNT(*) AS n ${base}${extra}`).get(workspaceId).n;
  return {
    all: one(''),
    recent: one(` AND c.created_at >= strftime('%s','now') - ${RECENT_DAYS * 86400}`),
    unused: one(` AND NOT ${REFERENCED_SQL}`),
    recent_days: RECENT_DAYS,
  };
}

module.exports = { REFERENCED_SQL, STATUS_SQL, LIVE_SQL, CANVA_ERROR_SQL, RECENT_DAYS, usageFor, usageDetail, summary };
