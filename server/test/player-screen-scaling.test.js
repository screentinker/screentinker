'use strict';

/*
 * The pairing code has to be readable on the panel it is displayed on.
 *
 * A CSS pixel covers a quarter of the screen area on a 4K panel that it does on 1080p, and a
 * sixteenth on 8K. Every size on the player's pre-playback screens was a hard-coded pixel value,
 * so the 72px pairing code that fills a 1080p screen became a smudge on a 4K wall — reported from
 * the field, on exactly the screens signage gets installed on.
 *
 * The fix is a viewport-proportional root font size with everything on those screens expressed in
 * rem, so the code holds the same ANGULAR size at any panel resolution. These tests pin the two
 * properties that actually matter: nothing on those screens is left in px, and the scaling cannot
 * leak into playback content.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const SURFACES = [
  { name: 'web player', file: 'server/player/index.html' },
  { name: 'tizen player', file: 'tizen/css/style.css' },
];

for (const { name, file } of SURFACES) {
  test(`${name}: the root font size is viewport-proportional and clamped at both ends`, () => {
    const src = read(file);
    if (file === 'server/player/index.html') {
      assert.match(src, /html \{ font-size: 7px; \}/, 'the legacy fallback has a readable floor');
      assert.match(src, /@media \(min-width: 756px\) and \(min-height: 756px\) \{ html \{ font-size: 0\.926vmin; \} \}/,
        'medium and large panels use the viewport-proportional size');
      assert.match(src, /@media \(min-width: 6048px\) and \(min-height: 6048px\) \{ html \{ font-size: 56px; \} \}/,
        'very large panels retain the former ceiling without CSS clamp');
      return;
    }
    const start = src.indexOf('html {');
    const rule = src.slice(start, src.indexOf('}', start));
    const m = rule.match(/font-size:\s*clamp\(\s*([\d.]+)px\s*,\s*([\d.]+)vmin\s*,\s*([\d.]+)px\s*\)/);
    assert.ok(m, `${file} must set a clamped, vmin-based root font size`);
    const [, min, vmin, max] = m.map(Number);

    // vmin, not vw: a portrait-mounted panel is as common as a landscape one, and vw would render
    // a 1080x1920 screen at half size.
    assert.ok(vmin > 0, 'the middle term must actually scale with the viewport');
    // 1rem should land on 10px at a 1080-tall viewport, so the rem values read as "px at 1080p"
    // and a reviewer can check them against the design at a glance.
    assert.ok(Math.abs(vmin * 1080 / 100 - 10) < 0.1, `1rem must be ~10px at 1080p, got ${vmin * 1080 / 100}px`);
    // The floor keeps a dashboard preview iframe and a laptop window legible rather than
    // microscopic; the ceiling stops an ultrawide from getting silly.
    assert.ok(min >= 6 && min <= 10, `floor should keep small viewports readable, got ${min}px`);
    assert.ok(max >= 32, `ceiling should not cap a genuine 8K panel too early, got ${max}px`);
  });
}

test('web player: the pairing code scales, and is still the biggest thing on the screen', () => {
  const src = read('server/player/index.html');
  const rule = src.slice(src.indexOf('.pairing-code {'), src.indexOf('.pairing-hint'));
  const size = rule.match(/font-size:\s*([\d.]+)rem/);
  assert.ok(size, 'the pairing code must be sized in rem, not px');
  assert.ok(Number(size[1]) >= 7, 'the code is what someone squints at from across a room');
  assert.match(rule, /letter-spacing:\s*[\d.]+rem/, 'letter-spacing must scale with it or the digits collide');

  const h1 = src.match(/#setupScreen h1 \{ font-size: ([\d.]+)rem/);
  assert.ok(h1 && Number(size[1]) > Number(h1[1]), 'the code must outrank the product name');
});

test('tizen player: the pairing code scales too', () => {
  const src = read('tizen/css/style.css');
  const rule = src.slice(src.indexOf('.code {'), src.indexOf('.hint {'));
  assert.match(rule, /font-size:\s*[\d.]+rem/, 'the Tizen pairing code must be sized in rem');
  assert.match(rule, /letter-spacing:\s*[\d.]+rem/);
});

test('no pre-playback screen is left in hard-coded px', () => {
  const src = read('server/player/index.html');
  // Everything from the setup screen through the status overlay. A px value surviving in here is
  // one element that stays put while the rest of the screen grows around it.
  for (const selector of ['#setupScreen h1', '#setupScreen .subtitle', '.pairing-hint', '.status-msg', '#statusOverlay h2', '#statusOverlay p']) {
    const at = src.indexOf(selector + ' {');
    assert.ok(at > 0, `${selector} not found`);
    const rule = src.slice(at, src.indexOf('}', at));
    const px = rule.match(/font-size:\s*[\d.]+px/);
    assert.equal(px, null, `${selector} still has a hard-coded font-size — it will not scale`);
  }
});

test('the scaling cannot reach playback content', () => {
  const src = read('server/player/index.html');
  // The whole safety argument for moving the root font size is that only the pre-playback chrome
  // uses rem. If a stage/zone/PiP rule starts using rem, resizing a panel would start resizing
  // CONTENT, which is a different and much worse bug than the one being fixed here.
  for (const selector of ['#stage', '.zone', '#pip']) {
    const at = src.indexOf(selector + ' {');
    if (at < 0) continue;
    const rule = src.slice(at, src.indexOf('}', at));
    assert.ok(!/[\d.]rem/.test(rule), `${selector} must not use rem — content sizing must stay independent`);
  }
});
