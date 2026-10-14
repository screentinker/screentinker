'use strict';

/*
 * Large videos skipped ~3 s in on Android WebView kiosks ("failed (no MediaError)").
 *
 * Android WebView fetches a built-in default poster for any <video> without one. With
 * crossOrigin='anonymous' that fetch fails CORS and raises `error` with no MediaError; a clip still
 * buffering (readyState < 3) is then treated as broken by mediaFailureSkip and skipped. Giving every
 * player-created <video> a poster stops the WebView from fetching its own.
 *
 * A guard rather than a repro (the failure needs a real WebView): every <video> the player makes must
 * come from newVideoElement(), and newVideoElement() must set a poster.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PLAYER_DIR = path.join(__dirname, '..', 'player');
const PLAYER = fs.readFileSync(path.join(PLAYER_DIR, 'index.html'), 'utf8');

function helperBody(src) {
  const start = src.indexOf('function newVideoElement()');
  assert.ok(start > 0, 'newVideoElement() not found');
  return src.slice(start, src.indexOf('\n    }', start));
}

test('newVideoElement() gives the element a poster', () => {
  const body = helperBody(PLAYER);
  assert.match(body, /document\.createElement\('video'\)/);
  assert.match(body, /\.poster\s*=\s*'data:image\//, 'poster must be an inline data: image (no request, no CORS)');
});

test('the player creates <video> elements only through newVideoElement()', () => {
  const outside = PLAYER.replace(helperBody(PLAYER), '');
  const bare = outside.match(/document\.createElement\(\s*['"]video['"]\s*\)/g) || [];
  assert.equal(bare.length, 0,
    `${bare.length} bare document.createElement('video') call(s) left; use newVideoElement() so ` +
    'Android WebView does not fetch its default poster and skip large clips');
});

test('the legacy player was rebuilt with the same rule', () => {
  const legacy = fs.readFileSync(path.join(PLAYER_DIR, 'legacy.html'), 'utf8');
  assert.ok(legacy.includes('function newVideoElement()'), 'legacy.html lacks newVideoElement(); run npm run build:legacy-player');
  const bare = legacy.match(/document\.createElement\(\s*['"]video['"]\s*\)/g) || [];
  assert.equal(bare.length, 1, 'legacy.html should create <video> only inside newVideoElement()');
});
