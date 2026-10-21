'use strict';

/*
 * The web player reports the size it draws at (render_width/render_height).
 *
 * ⚠️ THE BUG THIS PINS. The wall editor sizes a fresh tile from the device's render size and falls
 * back to a 320x180 placeholder when there is none. Android, the native player and Roku send it;
 * the web player never did, so every browser / Tizen / webOS / BrightSign / Vega panel on a new
 * wall came out 320x180, whatever the panel was.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

function fnSource(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} is in the player`);
  let depth = 0, i = html.indexOf('{', start);
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) break;
  }
  return html.slice(start, i + 1);
}

function renderSizeAt(win, quarterTurn) {
  const ctx = { window: win, cssQuarterTurn: quarterTurn };
  vm.runInNewContext(`${fnSource('renderSize')}; out = renderSize();`, ctx);
  return ctx.out && { w: ctx.out.w, h: ctx.out.h };
}

test('a landscape browser reports its viewport in device pixels', () => {
  assert.deepEqual(renderSizeAt({ innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1 }, 0), { w: 1920, h: 1080 });
  assert.deepEqual(renderSizeAt({ innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 2 }, 0), { w: 3840, h: 2160 });
});

test('a CSS portrait turn reports the sideways stage, as Android does', () => {
  assert.deepEqual(renderSizeAt({ innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1 }, 90), { w: 1080, h: 1920 });
  assert.deepEqual(renderSizeAt({ innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1 }, 270), { w: 1080, h: 1920 });
  assert.deepEqual(renderSizeAt({ innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1 }, 180), { w: 1920, h: 1080 });
});

test('no viewport yet means no render size (the server keeps NULL, the editor its default)', () => {
  assert.equal(renderSizeAt({ innerWidth: 0, innerHeight: 0 }, 0), null);
});

test('the device_info blob carries render_width and render_height', () => {
  const src = fnSource('buildDeviceInfo');
  assert.match(src, /info\.render_width = r\.w/);
  assert.match(src, /info\.render_height = r\.h/);
});

test('an orientation change re-reports the size', () => {
  const at = html.indexOf('el.style.left = st.left;');
  assert.ok(at > 0 && html.indexOf('maybeReportRenderSize();', at) - at < 200, 'maybeReportRenderSize runs right after the orientation is applied');
});
