'use strict';

/*
 * #769: "Stretch" on a playlist item letterboxed anyway on a full-screen (no layout) screen.
 *
 * The web player honoured an item's fit_mode inside a layout zone (itemFit) but the full-screen
 * paths hardcoded object-fit:contain, and the bulk Fit menu on the dashboard snapped back to a
 * placeholder that also read "Fit", so the change looked like it never took.
 *
 * These run the player's own helpers in a sandbox where they are self-contained, and guard the
 * full-screen paths against going back to a hardcoded contain.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PLAYER_DIR = path.join(__dirname, '..', 'player');
const PLAYER = fs.readFileSync(path.join(PLAYER_DIR, 'index.html'), 'utf8');
const LEGACY = fs.readFileSync(path.join(PLAYER_DIR, 'legacy.html'), 'utf8');
const PLAYLISTS_VIEW = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'playlists.js'), 'utf8');

function fnSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name}() not found`);
  // the player indents function bodies by 4; its closing brace is the first "\n    }" after the start
  const end = src.indexOf('\n    }', start);
  return src.slice(start, end + 6);
}

function fitHelpers(wallConfig) {
  const ctx = { wallConfig };
  vm.runInNewContext(`${fnSource(PLAYER, 'itemFit')}\n${fnSource(PLAYER, 'soloFit')}\nthis.soloFit = soloFit;`, ctx);
  return ctx.soloFit;
}

test('soloFit: a full-screen item uses its own fit_mode, contain when unset', () => {
  const soloFit = fitHelpers(null);
  assert.equal(soloFit({ fit_mode: 'fill' }), 'fill');
  assert.equal(soloFit({ fit_mode: 'cover' }), 'cover');
  assert.equal(soloFit({ fit_mode: 'contain' }), 'contain');
  assert.equal(soloFit({ fit_mode: null }), 'contain');
  assert.equal(soloFit({}), 'contain');
  assert.equal(soloFit({ fit_mode: 'bogus' }), 'contain');
});

test('soloFit: a video wall always fills, whatever the item says', () => {
  const soloFit = fitHelpers({ is_leader: true });
  assert.equal(soloFit({ fit_mode: 'cover' }), 'fill');
  assert.equal(soloFit({ fit_mode: 'contain' }), 'fill');
  assert.equal(soloFit({}), 'fill');
});

test('fitToCanvas frames a transition the way the element is framed', () => {
  const draws = [];
  const ctx = {
    vegaWipeSize: (w, h) => ({ w, h }),
    document: {
      createElement: () => ({ getContext: () => ({ drawImage: (...a) => draws.push(a) }) }),
    },
  };
  vm.runInNewContext(`${fnSource(PLAYER, 'fitToCanvas')}\nthis.fitToCanvas = fitToCanvas;`, ctx);
  const src = (fit) => ({ naturalWidth: 1000, naturalHeight: 500, style: fit ? { objectFit: fit } : {} });

  ctx.fitToCanvas(src('fill'), 1920, 1080);
  assert.deepEqual(draws.pop().slice(1), [0, 0, 1920, 1080], 'fill stretches to the whole stage');

  ctx.fitToCanvas(src('contain'), 1920, 1080);
  assert.deepEqual(draws.pop().slice(1), [0, 60, 1920, 960], 'contain letterboxes top and bottom');

  ctx.fitToCanvas(src('cover'), 1920, 1080);
  assert.deepEqual(draws.pop().slice(1), [-120, 0, 2160, 1080], 'cover overflows the sides');

  ctx.fitToCanvas({ width: 1920, height: 1080 }, 1920, 1080);
  assert.deepEqual(draws.pop().slice(1), [0, 0, 1920, 1080], 'an unstyled canvas keeps contain');
});

test('no full-screen media path hardcodes object-fit:contain any more', () => {
  const hard = PLAYER.split('\n').filter((l) => /cssText\s*=.*object-fit:contain/.test(l));
  // The two that stay: the device's default image (not a playlist item) and a pre-rotated video,
  // which is counter-turned inside the stage and must not be stretched across the turn.
  assert.equal(hard.length, 2, `unexpected hardcoded contain:\n${hard.join('\n')}`);
  assert.ok(hard.some((l) => l.includes('letterbox on the device background')), 'default image');
  assert.ok(hard.some((l) => l.includes('position:absolute;left:50%;top:50%')), 'pre-rotated video');
});

test('each full-screen mount takes soloFit(item)', () => {
  for (const name of ['mountImage', 'runImageTransition']) {
    assert.match(fnSource(PLAYER, name), /object-fit:\$\{soloFit\(item\)\}/, `${name}() must use soloFit(item)`);
  }
  const uses = (PLAYER.match(/object-fit:\$\{soloFit\(item\)\}/g) || []).length;
  assert.ok(uses >= 7, `expected the image, transition, stream and both video paths to use soloFit, found ${uses}`);
});

test('the legacy player was rebuilt with the same fix', () => {
  assert.ok(LEGACY.includes('function soloFit('), 'legacy.html lacks soloFit(); run npm run build:legacy-player');
});

test('dashboard: the bulk Fit menu placeholder no longer reads like the Fit option, and items show their fit', () => {
  assert.match(PLAYLISTS_VIEW, /<option value="">\$\{t\('playlist\.bulk\.fit_placeholder'\)\}<\/option>/);
  assert.match(PLAYLISTS_VIEW, /t\(FIT_BADGE_KEYS\[item\.fit_mode\]\)/, 'item row shows a fit badge');
  const en = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'i18n', 'en.js'), 'utf8');
  const label = (k) => (en.match(new RegExp(`'${k.replace(/\./g, '\\.')}': '([^']*)'`)) || [])[1];
  assert.ok(label('playlist.bulk.fit_placeholder'), 'placeholder string exists');
  assert.notEqual(label('playlist.bulk.fit_placeholder'), label('playlist.bulk.fit_contain'),
    'the placeholder must not read the same as the Fit option');
});
