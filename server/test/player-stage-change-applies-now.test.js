'use strict';

/*
 * WHEN THE STAGE CHANGES SHAPE, THE SCREEN CHANGES NOW.
 *
 * An ordinary playlist edit that removes the item on screen is deferred: the item finishes and the
 * rotation moves on at its natural advance (#157), so a live clip is not cut off. That deferral is
 * a bet that an advance is coming. A screen showing a multi-zone layout has no such advance: each
 * zone runs its own timer and nothing calls the fullscreen nextItem. So a screen moved from a
 * multi-zone playlist to a fullscreen one with no item in common kept its old zones until the
 * 60 second safety net fired, and every further push re-armed the 60 seconds, while the dashboard
 * showed the new playlist assigned. Measured in a real browser: 60.1 s before, 0.2 s after.
 *
 * The invariant: a push that changes the layout or the wall geometry is never deferred. The
 * surviving-item branch has always redrawn at once for that change; the removed-item branch now
 * agrees. An ordinary edit with the stage unchanged still defers.
 *
 * handlePlaylistUpdate has too many live dependencies to slice and execute, so, like
 * player-multizone-live-update.test.js, this asserts on structure, and on the generated legacy
 * player carrying the same rule.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'player', f), 'utf8');
const squash = (s) => s.replace(/\s+/g, ' ');

for (const file of ['index.html', 'legacy.html']) {
  const src = read(file);
  const fn = src.slice(src.indexOf('function handlePlaylistUpdate'));
  const changed = fn.slice(fn.indexOf('Playlist changed, updating'));
  const deferAt = changed.indexOf('deferredRotation = true');
  const before = squash(changed.slice(0, deferAt));
  // The `if (...) {` that guards the deferral: the last one before it is armed.
  const guard = before.slice(before.lastIndexOf('if (isPlaying'));

  test(`${file}: a layout or wall change is never parked behind the deferral`, () => {
    assert.ok(deferAt > 0, 'the deferral still exists');
    assert.match(guard, /!stageChanged/, 'the deferral is skipped when the stage changed');
    assert.match(before, /stageChanged = layoutChanged \|\| wallChanged/, 'and "stage changed" means the layout or the wall geometry');
  });

  test(`${file}: an ordinary edit still defers, and the other exemptions are intact`, () => {
    for (const cond of ['isPlaying', '!scheduleDriven', '!outgoingNeverAdvances', '!interruptNow']) {
      assert.ok(guard.includes(cond), `the deferral still requires ${cond}`);
    }
    assert.match(squash(changed.slice(deferAt, deferAt + 1200)), /60000|6e4/, 'and keeps its 60 s safety net');
  });

  test(`${file}: what is not deferred is applied at once`, () => {
    const after = squash(changed.slice(deferAt));
    assert.match(after, /return; } startPlaybackAt\(nextIdx\);/, 'falling out of the deferral starts the new playlist');
  });
}
