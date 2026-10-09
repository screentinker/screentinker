'use strict';

// #239: the playlist preview had no way to skip, so reviewing item 8 of a playlist meant sitting
// through items 1–7 in real time. The fix drives the player the preview ALREADY embeds (an iframe
// of /player?preview=1) over postMessage, so there is no second copy of the playback logic.
//
// Two things can go wrong, and neither shows up in a screenshot:
//
//   1. The index maths. A negative modulo or an off-by-one lands on an index that isn't in the
//      playlist, and playlist[idx] === undefined mounts nothing — the operator sees a black frame
//      and assumes the content is broken. "Previous" is the dangerous direction: JS's % returns a
//      negative for a negative left operand.
//   2. The blast radius. A control that reached a REAL display would let an operator skip content
//      on a wall in front of customers — far worse than the bug being fixed. So the channel is
//      asserted here at the source level: only a player that booted in preview mode may be steered,
//      and the dashboard addresses exactly one iframe rather than broadcasting.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLAYER = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
const DASHBOARD = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'playlists.js'), 'utf8');

// Same lift as the other player tests: pull one pure function out of the single-file player and
// run it directly, so the maths is testable without a browser.
function lift(name) {
  const start = PLAYER.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name}() should exist in the player`);
  let depth = 0;
  for (let j = PLAYER.indexOf('{', start); j < PLAYER.length; j++) {
    if (PLAYER[j] === '{') depth++;
    else if (PLAYER[j] === '}' && --depth === 0) {
      return new Function(`${PLAYER.slice(start, j + 1)} return ${name};`)();
    }
  }
  throw new Error('unbalanced braces reading ' + name);
}
const previewStepIndex = lift('previewStepIndex');

const NEXT = 1;
const PREV = -1;

test('next walks the playlist in order', () => {
  assert.equal(previewStepIndex(0, NEXT, 7), 1);
  assert.equal(previewStepIndex(5, NEXT, 7), 6);
});

test('next wraps past the last item back to the first', () => {
  assert.equal(previewStepIndex(6, NEXT, 7), 0);
});

test('THE BUG previous must not reproduce: stepping back from item 1 wraps to the LAST item', () => {
  // (0 - 1) % 7 is -1 in JavaScript, and playlist[-1] is undefined — a black frame.
  assert.equal(previewStepIndex(0, PREV, 7), 6);
});

test('previous walks backwards', () => {
  assert.equal(previewStepIndex(6, PREV, 7), 5);
  assert.equal(previewStepIndex(1, PREV, 7), 0);
});

test('a one-item playlist lands on that item in either direction', () => {
  // Re-rendering the single item is the honest answer: there is nowhere else to go, and returning
  // -1 would idle a preview that has perfectly good content.
  assert.equal(previewStepIndex(0, NEXT, 1), 0);
  assert.equal(previewStepIndex(0, PREV, 1), 0);
});

test('an empty playlist has nowhere to go', () => {
  assert.equal(previewStepIndex(0, NEXT, 0), -1);
  assert.equal(previewStepIndex(-1, PREV, 0), -1);
});

test('a player that has not started yet still lands on a real item', () => {
  // currentIndex is -1 until the first item mounts; a press during that window must not produce
  // -2 or NaN.
  assert.equal(previewStepIndex(-1, NEXT, 4), 0);
  assert.equal(previewStepIndex(-1, PREV, 4), 2);
});

test('a corrupt or out-of-range index is normalised, never propagated', () => {
  assert.equal(previewStepIndex(NaN, NEXT, 4), 1);
  assert.equal(previewStepIndex(undefined, NEXT, 4), 1);
  assert.equal(previewStepIndex(9, NEXT, 4), 2);      // 9 % 4 === 1 -> next is 2
  assert.equal(previewStepIndex(-9, NEXT, 4), 0);     // -9 normalises to 3 -> wraps to 0
  assert.equal(previewStepIndex(1.7, NEXT, 4), 2);
});

test('a non-numeric length is treated as no playlist rather than looping forever', () => {
  assert.equal(previewStepIndex(0, NEXT, NaN), -1);
  assert.equal(previewStepIndex(0, NEXT, undefined), -1);
  assert.equal(previewStepIndex(0, NEXT, -3), -1);
});

test('dayparted items are skipped IN THE DIRECTION OF TRAVEL', () => {
  // Falling forward past a filtered item would make "previous" walk forwards, which reads to the
  // operator as the button being broken.
  const off = new Set([1, 2]);
  const allows = (i) => !off.has(i);
  assert.equal(previewStepIndex(0, NEXT, 5, allows), 3);
  assert.equal(previewStepIndex(3, PREV, 5, allows), 0);
  assert.equal(previewStepIndex(0, PREV, 5, allows), 4);
});

test('every item outside its schedule window means nowhere to go, not item 0', () => {
  // The caller idles on -1. Returning an index here would mount content the schedule says must not
  // be on screen — the preview would then be lying about what the display will show.
  assert.equal(previewStepIndex(2, NEXT, 5, () => false), -1);
  assert.equal(previewStepIndex(2, PREV, 5, () => false), -1);
});

test('a step lands on an allowed item even when it has to wrap the whole list', () => {
  const allows = (i) => i === 0;
  assert.equal(previewStepIndex(0, NEXT, 6, allows), 0);
  assert.equal(previewStepIndex(4, PREV, 6, allows), 0);
});

// ---- Blast radius: the control must never reach a live display ----

test('only a preview instance can be steered', () => {
  // previewNavigate is the single entry point for a skip, and PREVIEW_MODE is set exactly once,
  // in the ?preview=1 boot path (renderPreviewFromUrl) — a paired display never sets it.
  const nav = PLAYER.slice(PLAYER.indexOf('function previewNavigate('));
  assert.match(nav.slice(0, 200), /if \(!PREVIEW_MODE\) return;/,
    'previewNavigate must refuse to act outside preview mode');
  // Exactly two assignments: the ?preview=1 boot path, and the view-only viewer (bootViewer), which is
  // reachable only from the server-injected __playerConfig.viewer and never installs the control channel.
  const sites = [];
  const re = /PREVIEW_MODE = true;/g;
  let m;
  while ((m = re.exec(PLAYER))) sites.push(PLAYER.lastIndexOf('function ', m.index));
  assert.equal(sites.length, 2, 'preview mode is set only by the preview boot path and the viewer boot path');
  const owners = sites.map((i) => PLAYER.slice(i, i + 40).match(/function (\w+)/)[1]).sort();
  assert.deepEqual(owners, ['bootViewer', 'renderPreviewFromUrl']);
  const viewerBody = PLAYER.slice(PLAYER.indexOf('function bootViewer('), PLAYER.indexOf('function viewerPoll('));
  assert.doesNotMatch(viewerBody, /installPreviewControlChannel/, 'a viewer can never be steered');
});

test('the message listener exists only in preview mode and only for our own origin', () => {
  // A live player never installs the listener at all, so a page that iframes a real display cannot
  // even attempt a skip; the origin check stops a third-party framer of the preview itself.
  const calls = PLAYER.match(/installPreviewControlChannel\(\)/g) || [];
  assert.equal(calls.length, 2, 'expected one definition call site plus the preview boot call');
  const boot = PLAYER.slice(PLAYER.indexOf('PREVIEW_MODE = true;'),
    PLAYER.indexOf('PREVIEW_MODE = true;') + 200);
  assert.match(boot, /installPreviewControlChannel\(\)/,
    'the channel must be installed by the preview boot, not at load time');
  const channel = PLAYER.slice(PLAYER.indexOf('function installPreviewControlChannel('));
  assert.match(channel.slice(0, 800), /ev\.origin !== window\.location\.origin/,
    'cross-origin messages must be rejected');
  assert.match(channel.slice(0, 800), /d\.source !== 'screentinker-preview'/,
    'unrelated postMessage traffic (extensions, embeds) must be ignored');
});

test('preview state is posted to our origin only — never "*"', () => {
  // "*" would hand the workspace's playlist contents to any page that framed the player.
  const post = PLAYER.slice(PLAYER.indexOf('function postPreviewState('));
  assert.match(post.slice(0, 900), /window\.location\.origin\)/);
  assert.doesNotMatch(post.slice(0, 900), /postMessage\([^)]*'\*'/);
});

test('the dashboard addresses the preview iframe, not a broadcast', () => {
  // Broadcasting would still not reach a display (they hold a server socket, not a window handle),
  // but addressing one contentWindow keeps the intent unambiguous and pins the target origin.
  assert.match(DASHBOARD, /frame\.contentWindow\?\.postMessage\(\{ source: 'screentinker-preview', action \}, window\.location\.origin\)/);
  assert.match(DASHBOARD, /ev\.source !== frame\.contentWindow/);
  assert.match(DASHBOARD, /ev\.origin !== window\.location\.origin/);
});

test('the preview modal cleans up its window-level listeners on close', () => {
  // They outlive the overlay otherwise, and a leaked keydown handler keeps posting arrow-key skips
  // at a preview the operator already closed.
  const modal = DASHBOARD.slice(DASHBOARD.indexOf('function showPlaylistPreview('),
    DASHBOARD.indexOf('function layoutMockup('));
  assert.match(modal, /window\.removeEventListener\('message', onPlayerMessage\)/);
  assert.match(modal, /document\.removeEventListener\('keydown', onKey\)/);
});
