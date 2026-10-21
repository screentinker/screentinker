const { db } = require('../db/database');

// Single source of truth for the "orphaned zone" definition used across the server:
// assignment validation (routes/assignments.js validZoneForLayout), the device payload
// orphan flags/counts (routes/devices.js), and — by the SAME rule, mirrored in their own
// languages — the player fallback (server/player/index.html, ZoneManager.kt) and the
// find-orphan-zone-items.js sweep.
//
// Rule: an item's zone_id is VALID only if it is a zone in the device's ACTIVE layout.
// A null/empty zone_id is "unassigned" (not an orphan). A zone_id on a device with no
// active layout can never be valid -> orphan.

/** True if zoneId belongs to layoutId (or zoneId is empty = unassigned). */
function zoneInLayout(zoneId, layoutId) {
  if (!zoneId) return true;
  if (!layoutId) return false;
  return !!db.prepare('SELECT 1 FROM layout_zones WHERE id = ? AND layout_id = ?').get(zoneId, layoutId);
}

/** True when zoneId is set but NOT a zone in the device's active layout. */
function isOrphanZone(zoneId, layoutId) {
  return !!zoneId && !zoneInLayout(zoneId, layoutId);
}

/**
 * Zones of a layout, for populating reassign dropdowns. [] if none. is_main + size let the
 * dashboard name the main zone (where zone-less items play) the way the playlist editor does.
 */
function layoutZones(layoutId) {
  if (!layoutId) return [];
  return db.prepare('SELECT id, name, is_main, width_percent, height_percent FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(layoutId);
}

/**
 * Bulk: map of device_id -> count of its playlist_items whose zone_id is NOT in the
 * device's active layout. Same rule as isOrphanZone, computed in one query for the
 * dashboard device list. Devices with zero orphans are omitted from the map.
 */
function orphanCountsByDevice(deviceIds) {
  const rows = db.prepare(`
    -- Resolved playlist AND resolved layout: an inheriting screen has neither on its own row, so
    -- this counted zero orphans for exactly the displays a group or wall drives.
    SELECT d.id AS device_id, COUNT(*) AS n
    FROM devices d
    JOIN device_resolved_playlist r ON r.device_id = d.id
    JOIN playlist_items pi ON pi.playlist_id = r.playlist_id
    LEFT JOIN layout_zones lz ON lz.id = pi.zone_id AND lz.layout_id = r.layout_id
    WHERE pi.zone_id IS NOT NULL AND lz.id IS NULL
    GROUP BY d.id
  `).all();
  const map = {};
  const want = deviceIds && deviceIds.length ? new Set(deviceIds) : null;
  for (const r of rows) { if (!want || want.has(r.device_id)) map[r.device_id] = r.n; }
  return map;
}

module.exports = { zoneInLayout, isOrphanZone, layoutZones, orphanCountsByDevice };
