'use strict';

/*
 * Boot-time reconcile for corporate state that an OLDER server version may have changed under us.
 *
 * Rolling back to a version without the corporate feature and then upgrading again is a supported
 * path (docs/corporate-playlists.md, "Rolling back"). The older version keeps publishing playlists
 * — head office's and the stores' slot content alike — but it knows nothing of published_rev,
 * published_composable or the composition cache. Without this, every mandated screen keeps the loop
 * from before the rollback until someone happens to publish again.
 *
 *   1. The composition cache is dropped (derived; lib/corporate/composition.js recomposes on read).
 *   2. A corporate playlist whose published_snapshot no longer matches the one its composable was
 *      built with (published_composable_of, lib/corporate/digest.js) is republished as system from
 *      its items, which rebuilds both. A row from before the digest existed is backfilled as is.
 *   3. An emergency alert whose playlist is gone, unpublished or empty is reported: it would fire
 *      and show nothing. (The trigger save path refuses that; a delete on another version doesn't.)
 *
 * Runs as system. Never throws: a failure is logged and boot continues.
 */

const { snapshotDigest } = require('./digest');
const probe = require('./schema-probe');

/** Why emergency alert `t` would show nothing, or null when it has something to show. */
function emergencyTargetProblem(db, t) {
  if (!t || (t.target_kind && t.target_kind !== 'playlist')) return null;
  let pl = null;
  try { pl = db.prepare('SELECT id, published_snapshot FROM playlists WHERE id = ?').get(String(t.target_ref || '')); } catch (_) { return null; }
  if (!pl) return 'missing';
  if (!pl.published_snapshot) return 'unpublished';
  let items = null;
  try { items = JSON.parse(pl.published_snapshot); } catch (_) { items = null; }
  if (!Array.isArray(items) || !items.length) return 'empty';
  return null;
}

function reconcileComposables(db, io) {
  if (!probe.hasColumn(db, 'playlists', 'published_composable_of')) return { republished: 0, backfilled: 0 };
  const out = { republished: 0, backfilled: 0 };
  const rows = db.prepare(`SELECT id, name, published_snapshot, published_composable_of FROM playlists
                            WHERE corporate = 1 AND published_composable IS NOT NULL`).all();
  for (const p of rows) {
    const now = snapshotDigest(p.published_snapshot);
    if (p.published_composable_of === null || p.published_composable_of === undefined) {
      db.prepare('UPDATE playlists SET published_composable_of = ? WHERE id = ?').run(now, p.id);
      out.backfilled++;
      continue;
    }
    if (p.published_composable_of === now) continue;
    try {
      require('../../routes/playlists').publishPlaylist(p.id, io || null);
      out.republished++;
      console.warn(`[corporate] "${p.name}" (${p.id}) was published by another server version; republished so its screens play the current loop`);
    } catch (e) {
      console.error(`[corporate] could not republish "${p.name}" (${p.id}) after another version published it: ${e && e.message}`);
    }
  }
  return out;
}

function reportEmptyEmergencyAlerts(db) {
  const bad = [];
  let rows = [];
  try { rows = db.prepare("SELECT id, name, target_kind, target_ref FROM triggers WHERE kind = 'emergency'").all(); } catch (_) { return bad; }
  for (const t of rows) {
    const why = emergencyTargetProblem(db, t);
    if (!why) continue;
    bad.push({ id: t.id, name: t.name, problem: why });
    console.warn(`[corporate] emergency alert "${t.name}" (${t.id}) has nothing to show: its playlist is ${why === 'missing' ? 'gone' : why}. Edit the alert and choose a published playlist.`);
  }
  return bad;
}

function reconcileAtBoot(db, io) {
  const result = { compositions: 0, republished: 0, backfilled: 0, emptyAlerts: [] };
  try { result.compositions = db.prepare('DELETE FROM corporate_compositions').run().changes; } catch (_) { /* no table */ }
  require('./actor').runAsSystem(() => {
    try { Object.assign(result, reconcileComposables(db, io)); } catch (e) { console.error(`[corporate] boot reconcile failed: ${e && e.message}`); }
  });
  try { result.emptyAlerts = reportEmptyEmergencyAlerts(db); } catch (_) { /* best effort */ }
  return result;
}

module.exports = { reconcileAtBoot, reconcileComposables, reportEmptyEmergencyAlerts, emergencyTargetProblem };
