'use strict';

/*
 * #870 and #871, pinned in the Android player's source (the classes need a device to run).
 *
 * #870: a stopped or hidden video's TextureView keeps its last frame. The screenshot code pasted it
 * over every capture because it checked only the view's own visibility, not its container's.
 * #871: when a cleared playlist did not bring up the standby image, nothing said why.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'android/app/src/main/java/com/remotedisplay/player', p), 'utf8');

test('#870: screenshots only paste a video frame that is actually on screen', () => {
  const capture = src('remote/ScreenshotCapture.kt');
  assert.match(capture, /if \(!tv\.isShown\) \{/, 'an ancestor hidden means the frame is not on screen');
  assert.doesNotMatch(capture, /tv\.isAvailable && tv\.visibility == View\.VISIBLE/, 'the view\'s own flag is not enough');
});

test('#870: stopping the player hides the surface holding its last frame', () => {
  const mpm = src('player/MediaPlayerManager.kt');
  const stop = mpm.slice(mpm.indexOf('    fun stop() {'), mpm.indexOf('    fun release() {'));
  assert.match(stop, /playerView\.visibility = android\.view\.View\.GONE/);
});

test('#871: every way the standby image is declined is logged', () => {
  const pc = src('player/PlaylistController.kt');
  const fn = pc.slice(pc.indexOf('private fun renderDefaultContent()'), pc.indexOf('private var lastDefaultDecline'));
  for (const why of ['no default_content in the payload', 'not an image', 'neither a remote_url nor a content_id', 'is not in the content cache', 'already marked as showing']) {
    assert.ok(fn.includes(why), `logs: ${why}`);
  }
  assert.doesNotMatch(fn, /\?: return false/, 'no silent early return');
  assert.match(pc, /Default\/standby content not rendered: \$reason/);
});
