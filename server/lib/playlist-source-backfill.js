'use strict';

/*
 * Backfill devices.playlist_source.
 *
 * Pure logic, no boot concerns, so it can be unit-tested against an in-memory DB — the same split
 * as lib/tenant-cascade-migration.js.
 *
 * ⚠️ THE CONTRACT: after this runs, every device must resolve to EXACTLY the playlist_id it had
 * before. Not "almost every" and not "the right one" — the same one. The player restarts playback
 * at item 1 whenever its structural fingerprint changes, so a migration that re-resolves even a
 * handful of devices is an estate-wide restart during an upgrade (the #234 shape). That property,
 * not correctness of the new model, is what this function is for.
 *
 * playlist_id alone cannot say whether it was CHOSEN or COPIED, so the value is classified by
 * comparing it against what the new resolver would inherit:
 *
 *   playlist_id IS NULL, and nothing would be inherited  -> NULL   (inherits; still plays nothing)
 *   playlist_id IS NULL, but something WOULD be inherited-> 'none' (explicitly plays nothing)
 *   playlist_id == the inherited value                   -> NULL   (it was a copy; keeps inheriting)
 *   playlist_id != the inherited value                   -> 'device' (someone chose it; an override)
 *
 * The 'none' case is the one that is easy to get wrong. Those devices are in a group that has a
 * playlist but hold no playlist of their own — usually because routes/devices.js "clear" wrote
 * playlist_id = NULL, which is exactly the bug the new model fixes. Letting them simply inherit
 * would light up screens that are dark today. Correct, arguably desirable, and still a change to
 * what is on a wall during an upgrade — so it is recorded as a deliberate "plays nothing" that an
 * operator can revert, rather than applied to them silently.
 */
function backfillPlaylistSource(db) {
  const rows = db.prepare(`
    SELECT d.id, d.playlist_id, COALESCE(i.wall_playlist_id, i.group_playlist_id) AS inherited
      FROM devices d JOIN device_inherited_playlist i ON i.device_id = d.id
  `).all();

  const set = db.prepare('UPDATE devices SET playlist_source = ? WHERE id = ?');
  const stats = { device: 0, none: 0, inherit: 0 };

  db.transaction(() => {
    for (const r of rows) {
      let source;
      if (r.playlist_id === null) source = r.inherited === null ? null : 'none';
      else source = r.playlist_id === r.inherited ? null : 'device';

      if (source === 'device') stats.device++;
      else if (source === 'none') stats.none++;
      else stats.inherit++;
      set.run(source, r.id);
    }
  })();

  return stats;
}

/*
 * The proof, runnable against any database: for every device, what the resolver now returns must
 * equal what devices.playlist_id said before. Returns the offending rows, empty when clean.
 *
 * Called by the boot migration (which aborts on a non-empty result) and by the tests. A backfill
 * whose only verification lives in a test file is a backfill nobody checks against real data.
 *
 * ⚠️ Deliberately STRICT (raw column vs view, no exceptions) and run ONCE, guarded by
 * schema_migrations, before any head office mandate can exist — so it never meets a 'corporate'
 * row. It is NOT the check for a change to the view itself: that is applyResolverViews({verify}),
 * which diffs the previous definition against the new one on every boot the SQL changes.
 */
function verifyNoDeviceChanged(db) {
  return db.prepare(`
    SELECT d.id AS device_id, d.playlist_id AS was, r.playlist_id AS now, r.source
      FROM devices d JOIN device_resolved_playlist r ON r.device_id = d.id
     WHERE IFNULL(d.playlist_id, '') != IFNULL(r.playlist_id, '')
  `).all();
}

module.exports = { backfillPlaylistSource, verifyNoDeviceChanged };
