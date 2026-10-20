'use strict';

/*
 * A layout on a playlist (docs/layouts-and-campaigns.md).
 *
 * A layout used to be a property of a SCREEN only, so a group of screens playing a zoned playlist
 * needed every screen's layout set by hand, and a new screen joining the group played the zoned
 * items squashed into whatever layout it happened to have. A playlist may now carry its own layout.
 * Which one a screen draws is decided in ONE place, the resolver view (lib/playlist-resolver-sql.js):
 *
 *   head office mandate  >  active schedule's layout  >  the playlist's layout  >  the device's layout
 *
 * This module holds the small rules around it that more than one writer needs:
 *   - which zone is the MAIN zone (where items without a zone play);
 *   - filling that zone into a snapshot's zone-less items, so every way of adding an item (the
 *     editor, the Simple view, Make a sign, content requests, experiments, the API) lands in the
 *     same place without each of them learning about layouts;
 *   - the playlist's DEFAULT zone, given to new items added without one (zoneForNewItem);
 *   - suggesting how items move when a playlist changes layout.
 *
 * ⚠️ NULL LAYOUT = NOTHING HAPPENS HERE. Every function returns its input untouched when the
 * playlist has no layout, which is what keeps every existing snapshot byte-identical
 * (test/playlist-layout.test.js proves it against the pre-feature code).
 */

/** The layout with its zones (sort_order), or null. */
function loadLayout(db, layoutId) {
  if (!layoutId) return null;
  const layout = db.prepare('SELECT * FROM layouts WHERE id = ?').get(layoutId);
  if (!layout) return null;
  layout.zones = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(layoutId);
  return layout;
}

const area = (z) => (Number(z && z.width_percent) || 0) * (Number(z && z.height_percent) || 0);

/**
 * The zone items without a zone play in: the one marked main, else the largest (the first of equal
 * ones). "Largest" is deliberately the SAME rule every player already applies to an orphaned item
 * (player/index.html renderZones, the Android ZoneManager), so a screen that has not been updated
 * and one that has put a stray item in the same place.
 */
function mainZone(zones) {
  if (!Array.isArray(zones) || !zones.length) return null;
  const marked = zones.find((z) => Number(z.is_main) === 1);
  if (marked) return marked;
  return zones.reduce((a, b) => (area(b) > area(a) ? b : a), zones[0]);
}

/**
 * Give every zone-less item the layout's main zone. Only for a layout that really has zones (two or
 * more): below that the payload strips zone ids anyway (ws/deviceSocket.js assemblePayload), and
 * leaving the items alone keeps the snapshot what it was.
 */
function fillMainZone(items, layout) {
  if (!Array.isArray(items) || !layout || !Array.isArray(layout.zones) || layout.zones.length < 2) return items;
  const main = mainZone(layout.zones);
  if (!main) return items;
  for (const it of items) {
    if (it && typeof it === 'object' && !it.zone_id && !it.__slot) it.zone_id = main.id;
  }
  return items;
}

/**
 * The zone a NEW item gets when whoever adds it gave none: the playlist's default zone
 * (playlists.default_zone_id) while that zone is still in the playlist's layout, else null, and the
 * item plays in the main zone as before. Stored on the item when it is added, never applied at
 * publish: items already in the playlist keep playing where they do, and changing the default later
 * moves nothing that was added before. Only the writers that add NEW content call this; copying,
 * duplicating, restoring and importing keep each item's own zone.
 */
function zoneForNewItem(db, playlistId, zoneId = null) {
  if (zoneId) return zoneId;
  try {
    const row = db.prepare(`SELECT p.default_zone_id AS zone_id FROM playlists p
                              JOIN layout_zones lz ON lz.id = p.default_zone_id AND lz.layout_id = p.layout_id
                             WHERE p.id = ?`).get(playlistId);
    return row ? row.zone_id : null;
  } catch (_) {
    return null;   // a schema from before the column (a hand-built test database)
  }
}

/**
 * Is `layoutId` one this workspace may put on a playlist? A template (shared by every tenant), or a
 * layout of the same workspace. Anything else would render another tenant's zones and dimensions.
 * @returns {string|null} an error message, or null when allowed
 */
function layoutRefusal(db, layoutId, workspaceId) {
  const l = db.prepare('SELECT is_template, workspace_id FROM layouts WHERE id = ?').get(layoutId);
  if (!l) return 'Layout not found';
  if (!l.is_template && l.workspace_id !== workspaceId) return 'Layout is not in this playlist\'s workspace';
  return null;
}

/* ─── zone remapping when a playlist changes layout ─────────────────────────────────────────── */

const norm = (s) => String(s || '').trim().toLowerCase();

function overlap(a, b) {
  const ax2 = (Number(a.x_percent) || 0) + (Number(a.width_percent) || 0);
  const ay2 = (Number(a.y_percent) || 0) + (Number(a.height_percent) || 0);
  const bx2 = (Number(b.x_percent) || 0) + (Number(b.width_percent) || 0);
  const by2 = (Number(b.y_percent) || 0) + (Number(b.height_percent) || 0);
  const w = Math.max(0, Math.min(ax2, bx2) - Math.max(Number(a.x_percent) || 0, Number(b.x_percent) || 0));
  const h = Math.max(0, Math.min(ay2, by2) - Math.max(Number(a.y_percent) || 0, Number(b.y_percent) || 0));
  const inter = w * h;
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * A SUGGESTION for where each old zone's items go in the new layout — the person confirms or changes
 * it before anything moves. Same name first (case-insensitive), then the new zone covering the same
 * part of the screen best (intersection over union), then the main zone. Each new zone is offered
 * to at most one old zone by name or position, so two old zones do not silently pile into one when
 * a better home exists; whatever is left goes to the main zone.
 *
 * @returns {Object<string,string>} old zone id -> new zone id
 */
function suggestZoneMap(fromZones, toZones) {
  const out = {};
  const from = Array.isArray(fromZones) ? fromZones : [];
  const to = Array.isArray(toZones) ? toZones : [];
  if (!to.length) return out;
  const main = mainZone(to);
  const taken = new Set();
  for (const z of from) {
    const hit = to.find((n) => !taken.has(n.id) && norm(n.name) && norm(n.name) === norm(z.name));
    if (hit) { out[z.id] = hit.id; taken.add(hit.id); }
  }
  // Best remaining position matches, strongest first.
  const pairs = [];
  for (const z of from) {
    if (out[z.id]) continue;
    for (const n of to) if (!taken.has(n.id)) pairs.push({ from: z.id, to: n.id, score: overlap(z, n) });
  }
  pairs.sort((a, b) => b.score - a.score);
  for (const p of pairs) {
    if (p.score <= 0.05 || out[p.from] || taken.has(p.to)) continue;
    out[p.from] = p.to;
    taken.add(p.to);
  }
  for (const z of from) if (!out[z.id] && main) out[z.id] = main.id;
  return out;
}

/*
 * A layout as a SCREEN receives it: the row and its zones exactly as before (SELECT *), minus the
 * 3.0 bookkeeping column is_main (players have no use for it, and leaving it in would add a field to
 * every zoned screen's payload), with the screen's orientation version applied when the layout has
 * one (lib/layout-variants.js). No version, or variant null: byte-identical to the old load.
 */
function layoutForPayload(db, layoutId, variant = null) {
  const layout = loadLayout(db, layoutId);
  if (!layout) return null;
  for (const z of layout.zones) delete z.is_main;
  if (variant) require('./layout-variants').applyVariant(db, layout, variant);
  return layout;
}

module.exports = { loadLayout, layoutForPayload, mainZone, fillMainZone, zoneForNewItem, layoutRefusal, suggestZoneMap, overlap };
