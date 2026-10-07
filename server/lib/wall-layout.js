'use strict';

/*
 * Wall layouts: a video wall that takes a layout the way a single screen does.
 *
 * The layout's zones are percentages of the WALL'S PLAYER RECT (the "PLAYER" box in the wall
 * editor), exactly as a screen's zones are percentages of that screen. So a zone can sit inside one
 * panel, straddle a bezel, or cover the whole wall, and every player already knows how to place a
 * percent zone — the wall crop then shows each panel its slice of the result.
 *
 * Zones on a wall are paced by the shared clock (each zone runs its own schedule off syncedNow), not
 * by the leader relay: every panel that can see a zone computes the same item and position for it on
 * its own, and keeps doing so offline. A zone that crosses a seam therefore shows the same frame on
 * both panels without any panel being in charge.
 */

// Every screen whose payload depends on a layout: screens that use it themselves, and members of a
// wall that uses it. Two placeholders, both the layout id.
const SCREENS_ON_LAYOUT_SQL = `SELECT id FROM devices WHERE layout_id = ?
  UNION SELECT device_id AS id FROM video_wall_devices
    WHERE wall_id IN (SELECT id FROM video_walls WHERE layout_id = ?)`;

// A layout only counts as a wall layout when it can place more than the whole stage: one zone is
// the same as no layout (the payload already strips zone ids below two zones).
function isZonedLayout(layout) {
  return !!(layout && Array.isArray(layout.zones) && layout.zones.length > 1);
}

// The zone's rect in canvas units, from the player rect it is a percentage of.
function zoneCanvasRect(zone, playerRect) {
  const p = playerRect;
  return {
    x: p.x + (Number(zone.x_percent) || 0) / 100 * p.w,
    y: p.y + (Number(zone.y_percent) || 0) / 100 * p.h,
    w: (Number(zone.width_percent) || 0) / 100 * p.w,
    h: (Number(zone.height_percent) || 0) / 100 * p.h,
  };
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/*
 * Which panels a zone touches, and which ONE plays its sound: the panel under the zone's centre (or,
 * if the centre falls in a gap between panels, the panel with the largest share of the zone).
 * Mirrored in the web player; kept here so the dashboard and tests use the same rule.
 */
function zonePanels(zone, playerRect, screens) {
  const z = zoneCanvasRect(zone, playerRect);
  const cx = z.x + z.w / 2, cy = z.y + z.h / 2;
  const touching = [];
  let audio = null, best = -1;
  for (const s of screens) {
    const r = s.rect;
    if (!rectsOverlap(z, r)) continue;
    touching.push(s.id);
    if (cx >= r.x && cx < r.x + r.w && cy >= r.y && cy < r.y + r.h) { audio = s.id; best = Infinity; continue; }
    const share = (Math.min(z.x + z.w, r.x + r.w) - Math.max(z.x, r.x)) * (Math.min(z.y + z.h, r.y + r.h) - Math.max(z.y, r.y));
    if (share > best) { best = share; audio = s.id; }
  }
  return { touching, audio };
}

module.exports = { SCREENS_ON_LAYOUT_SQL, isZonedLayout, zoneCanvasRect, rectsOverlap, zonePanels };
