'use strict';

/*
 * #725: a published slide-deck edit did not reach a running WEB player in a multi-zone layout until
 * a manual Reload Player.
 *
 * The server side is correct (the edit bumps widget_rev, the published snapshot differs, the parent
 * playlist republishes and pushes, and the payload carries the new rev — covered by
 * slide-deck-publish.test.js and playlist-nesting.test.js), and the player's fingerprint is correct
 * (widget_rev is in it, so the edit is detected and handlePlaylistUpdate enters its "Playlist
 * changed" branch — covered by player-playlist-inplace-sync.test.js). The break was the APPLY step:
 * in a multi-zone layout each zone rotates its own captured item list on its own timer, but the
 * changed-branch only re-rendered the single ANCHOR item's zone (the fullscreen continuity it was
 * written for). A change confined to another zone fell through to a plain `return`, so the zone kept
 * rotating stale items. The fix rebuilds the zone stage from the new playlist whenever a multi-zone
 * layout reaches the changed branch — the same result the Reload Player button produces.
 *
 * handlePlaylistUpdate has too many live dependencies to slice and execute, so this asserts on
 * STRUCTURE (the approach triggers-sync-pinning.test.js and player-media-error-multiadvance.test.js
 * take for this same function). Position is the property that matters here: the guard has to run
 * BEFORE the single-anchor continuity, or the anchor "surviving" swallows the update again.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PLAYER = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

// The "playlist changed" branch of the handler: from its log line to the single-anchor continuity.
const fn = PLAYER.slice(PLAYER.indexOf('function handlePlaylistUpdate'));
const changed = fn.slice(fn.indexOf("console.log('Playlist changed, updating')"));

const assignAt = changed.indexOf('playlist = newItems');
const guardIfAt = changed.indexOf('if (layout && layout.zones && layout.zones.length > 1 && !wallConfig)');
const anchorBlockAt = changed.indexOf("if (oldAnchorId && oldAnchorId !== '|||')");

test('#725 the changed branch has a multi-zone guard that rebuilds the zones', () => {
  assert.ok(guardIfAt > 0, 'handlePlaylistUpdate must guard the multi-zone case in its changed branch');
  // The guard body, up to the single-anchor continuity it must pre-empt.
  const guard = changed.slice(guardIfAt, anchorBlockAt);
  assert.match(guard, /layout\.zones\.length\s*>\s*1/, 'the guard keys off a multi-zone layout');
  assert.match(guard, /!wallConfig/, 'walls own their own sync (wall:sync / renderWallZones) and are excluded');
  assert.match(guard, /renderContent\(/, 'it must re-render the zone stage, not just retarget an index');
  assert.match(guard, /\breturn;/, 'and return, so it does not also run the fullscreen continuity');
});

test('#725 the guard runs BEFORE the single-anchor continuity, on the NEW playlist', () => {
  assert.ok(assignAt > 0 && anchorBlockAt > 0, 'the anchoring landmarks must still exist');
  // After `playlist = newItems`: the re-render has to draw the new list, not the stale one.
  assert.ok(guardIfAt > assignAt,
    'the multi-zone re-render must sit after `playlist = newItems`, or it redraws the old playlist');
  // Before the single-anchor block: otherwise an unchanged anchor "survives", control reaches the
  // plain `return`, and a change in any OTHER zone is swallowed — the #725 bug.
  assert.ok(guardIfAt < anchorBlockAt,
    'the multi-zone guard must pre-empt the single-anchor continuity, not sit after its return');
});

test('#725 the fix is mirrored into the generated legacy player', () => {
  // legacy.html is built from index.html by scripts/build-legacy-player.js; a stale copy ships the
  // old player to the oldest panels and fails the build-parity check in CI.
  const legacy = fs.readFileSync(path.join(__dirname, '..', 'player', 'legacy.html'), 'utf8');
  assert.match(legacy, /re-rendering all zones \(#725\)/,
    'legacy.html is stale — run `node server/scripts/build-legacy-player.js`');
});
