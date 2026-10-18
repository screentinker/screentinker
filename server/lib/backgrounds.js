'use strict';

/*
 * #660: two background settings a playlist owns.
 *
 * - playlists.background_color: painted behind everything the playlist shows, in place of the
 *   device's background_color. Hex, or NULL for the screen's own colour. It reaches a screen as the
 *   payload's top-level background_color (deviceSocket), which every player already paints or now
 *   paints, so it never enters an item signature.
 *
 * - playlist_items.transparent_bg: this item's web content is drawn see-through, whatever colour
 *   the widget itself sets, so the playlist, screen or zone colour behind it shows. The player adds
 *   `transparent=1` to the item's render URL and the server forces html/body transparent there
 *   (forceTransparent). A third-party page inside a URL widget, YouTube, and an image or video have
 *   no page of ours to change, so only widgets and HTML bundles carry the flag.
 *
 * Both stay out of a snapshot when unset, so a playlist that never uses them publishes exactly the
 * bytes it did before (the same rule as play_to_end).
 */

const { hexColor } = require('./safe-color');
const { BUNDLE_MIME } = require('./html-bundle');

/** The stored playlist colour: a hex value, or null for '', null, 'none' and anything invalid. */
function normalizePlaylistBg(v) {
  if (v == null || v === '' || v === 'none') return null;
  return hexColor(v, null, [3, 6, 8]);
}

/** The stored item flag: 1 or NULL. */
function normalizeTransparentBg(v) {
  if (v === true || v === 1 || v === '1' || v === 'true' || v === 'on') return 1;
  return null;
}

/** Whether an item has a page of ours to draw see-through: a widget, or an HTML bundle. */
function transparentApplies(item) {
  return !!(item && (item.widget_id || item.mime_type === BUNDLE_MIME));
}

// Last in the cascade and !important, so it wins over a widget's own body colour. A slide paints
// its colour on .stage and its letterbox on html/body, so both go. An author's own `!important`
// later in a template or bundle can still win: that is their page.
const TRANSPARENT_CSS = '<style id="st-transparent">html,body,.stage{background:transparent!important;background-color:transparent!important}</style>';

/** The page with its background forced see-through. Placed before </head>, else at the very start. */
function forceTransparent(html) {
  const s = String(html);
  const at = s.search(/<\/head>/i);
  return at >= 0 ? s.slice(0, at) + TRANSPARENT_CSS + s.slice(at) : TRANSPARENT_CSS + s;
}

/** True when a render or bundle request asks for the see-through page. */
function wantsTransparent(query) {
  return !!query && query.transparent === '1';
}

/**
 * After a copy of playlist items (a fork, a corporate fill), carry each item's flag across.
 * `idMap` is Map(sourceItemId -> copyItemId). A schema without the column (hand-built test
 * fixtures) copies nothing.
 */
function copyTransparentBg(db, idMap) {
  if (!idMap || !idMap.size || !require('./corporate/schema-probe').hasColumn(db, 'playlist_items', 'transparent_bg')) return;
  const up = db.prepare('UPDATE playlist_items SET transparent_bg = (SELECT transparent_bg FROM playlist_items WHERE id = ?) WHERE id = ?');
  for (const [from, to] of idMap) up.run(from, to);
}

module.exports = { copyTransparentBg, normalizePlaylistBg, normalizeTransparentBg, transparentApplies, forceTransparent, wantsTransparent, TRANSPARENT_CSS };
