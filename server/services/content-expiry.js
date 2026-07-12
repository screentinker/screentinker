// #157 auto-deactivate expired content. A 60s sweep that finds content whose expiry has
// passed, deactivates it (is_active=0), and republishes ONLY the published playlists that
// actually carried it — so already-published fleets stop serving expired items.
//
// Why is_active is the marker (not just expires_at<=now): the sweep must republish each
// expiry EXACTLY ONCE. `is_active=1 AND expired` selects only the not-yet-processed items;
// flipping to 0 removes them from the next sweep's selection. Without the flag every tick
// would re-republish forever. Publish-time filtering (buildSnapshotItems) uses the LIVE
// condition, so a manual publish between expiry and the next tick already drops the item.
//
// Blast radius: republish regenerates a snapshot and pushes to devices, so we touch only
// DISTINCT published playlists that referenced an expired item — never a fleet-wide reload.

const { db } = require('../db/database');

let io = null;

function startContentExpiry(socketIo) {
  io = socketIo;
  setInterval(() => { try { sweepExpiredContent(io); } catch (e) { console.error('[content-expiry] sweep error', e); } }, 60000);
  console.log('Content-expiry sweep started');
}

// Returns { expired: [ids], republished: [playlistIds] }. Pure-ish (DB side effects only) so
// tests can drive it directly. `socketIo` is optional — without it the DB flips still happen
// and playlists are republished (snapshot updated); only the device push is skipped.
function sweepExpiredContent(socketIo = io) {
  const expired = db.prepare(
    "SELECT id FROM content WHERE is_active = 1 AND expires_at IS NOT NULL AND expires_at <= strftime('%s','now')"
  ).all().map(r => r.id);

  if (expired.length === 0) return { expired: [], republished: [] };

  // Which PUBLISHED playlists carry any of the just-expired items? (draft playlists don't
  // serve, so they need no republish — their next publish will filter naturally.)
  const ph = expired.map(() => '?').join(',');
  const affected = db.prepare(`
    SELECT DISTINCT p.id
    FROM playlists p
    JOIN playlist_items pi ON pi.playlist_id = p.id
    WHERE p.status = 'published' AND pi.content_id IN (${ph})
  `).all(...expired).map(r => r.id);

  // Deactivate in one statement (the once-only marker flip).
  db.prepare(`UPDATE content SET is_active = 0 WHERE id IN (${ph})`).run(...expired);

  // Republish each affected playlist once — buildSnapshotItems now drops the dead items.
  const { publishPlaylist } = require('../routes/playlists');
  for (const playlistId of affected) {
    try { publishPlaylist(playlistId, socketIo); }
    catch (e) { console.error(`[content-expiry] republish failed for playlist ${playlistId}`, e); }
  }

  console.log(`[content-expiry] deactivated ${expired.length} item(s), republished ${affected.length} playlist(s)`);
  return { expired, republished: affected };
}

module.exports = { startContentExpiry, sweepExpiredContent };
