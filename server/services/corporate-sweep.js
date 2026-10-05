'use strict';

/*
 * Hourly housekeeping for corporate local slots (spec §1.3, §3.3). Everything here is tidying, never
 * correctness: the composition cache re-checks its inputs on every read, and the resolver ignores
 * retired slots and dangling targets.
 *
 *   1. Composition rows no screen uses any more (a store removed its own content, a mandate moved) —
 *      the cache is derived, so a row nobody's signature names is just dead weight.
 *   2. RETIRED slots that nothing can bring back: no placement in any draft, none in a published
 *      structure, none in any revision. Their stores' content rows cascade with them (the fill
 *      PLAYLISTS stay — they are the stores' playlists).
 *
 * Runs as system (actor.runAsSystem): a timer must never be judged as whoever happened to be the
 * request that loaded this module.
 */

const { db } = require('../db/database');

const HOUR = 3600 * 1000;

function sweepCompositions() {
  const resolve = require('../lib/corporate/resolve');
  let removed = 0;
  for (const p of db.prepare('SELECT DISTINCT playlist_id FROM corporate_compositions').all()) {
    const live = new Set([...resolve.signaturesForPlaylist(db, p.playlist_id).values()].map((d) => d.signature));
    for (const row of db.prepare('SELECT id, signature FROM corporate_compositions WHERE playlist_id = ?').all(p.playlist_id)) {
      if (!live.has(row.signature)) removed += db.prepare('DELETE FROM corporate_compositions WHERE id = ?').run(row.id).changes;
    }
  }
  return removed;
}

function sweepRetiredSlots() {
  let removed = 0;
  for (const s of db.prepare('SELECT id FROM corporate_slots WHERE retired_at IS NOT NULL').all()) {
    if (db.prepare('SELECT 1 FROM playlist_items WHERE slot_id = ? LIMIT 1').get(s.id)) continue;
    const needle = `%"slot_id":"${String(s.id).replace(/[%_"]/g, '')}"%`;
    if (db.prepare('SELECT 1 FROM playlists WHERE published_structure LIKE ? OR published_composable LIKE ? LIMIT 1').get(needle, `%"__slot":"${String(s.id).replace(/[%_"]/g, '')}"%`)) continue;
    try { if (db.prepare("SELECT 1 FROM revisions WHERE resource_type = 'playlist' AND state LIKE ? LIMIT 1").get(needle)) continue; } catch (_) { /* no revisions table */ }
    removed += db.prepare('DELETE FROM corporate_slots WHERE id = ?').run(s.id).changes;
  }
  return removed;
}

function sweepCorporate() {
  const out = { compositions: 0, slots: 0 };
  try { out.compositions = sweepCompositions(); } catch (e) { console.warn(`[corporate-sweep] compositions: ${e && e.message}`); }
  try { out.slots = sweepRetiredSlots(); } catch (e) { console.warn(`[corporate-sweep] retired slots: ${e && e.message}`); }
  if (out.compositions || out.slots) console.log(`[corporate-sweep] removed ${out.compositions} unused composition(s), ${out.slots} retired slot(s)`);
  return out;
}

function startCorporateSweep() {
  const { bindSystem } = require('../lib/corporate/actor');
  const t = setInterval(bindSystem(sweepCorporate), HOUR);
  if (t.unref) t.unref();
}

module.exports = { startCorporateSweep, sweepCorporate, sweepCompositions, sweepRetiredSlots };
