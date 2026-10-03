'use strict';

/*
 * The image picker used by the widget editor — the dialog behind "Add Background Image" and
 * "Choose Logo" on a directory board.
 *
 * ⚠️ WHY THIS FILE EXISTS. A report came in that someone "couldn't upload a background picture".
 * They were right, and the dialog said so itself: it was READ-ONLY, and its empty state read
 * "Upload images first from Content Library". Choosing a background meant abandoning a half-filled
 * widget form, crossing to another view to upload, and coming back to start again. Nothing was
 * broken in the sense a test could see — the feature simply was not there, and from the outside
 * that is indistinguishable from broken.
 *
 * ⚠️ AND THE LIST WAS ASKING THE SERVER FOR THE WRONG THING. `GET /content` with no query returns
 * the 100 newest rows OF EVERY TYPE (routes/content.js: `LIMIT ?` defaulting to 100, capped at
 * 500), which the client then filtered down to images. A workspace whose last hundred uploads were
 * videos therefore saw an EMPTY image picker over a library full of pictures — and the search box
 * could not reach them either, because it only ever filters what has already been fetched.
 *
 * ⚠️ SOURCE ASSERTIONS, DELIBERATELY — same reasoning as slides-view-guards.test.js. There is no
 * DOM harness in this project, and adding jsdom for one dialog is a bigger commitment than these
 * rules are worth. They are cheap and they encode what must not silently regress.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend', 'js');
const WIDGETS = fs.readFileSync(path.join(FRONTEND, 'views', 'widgets.js'), 'utf8');
const SLIDES = fs.readFileSync(path.join(FRONTEND, 'views', 'slides.js'), 'utf8');
const API = fs.readFileSync(path.join(FRONTEND, 'api.js'), 'utf8');
const EN = fs.readFileSync(path.join(FRONTEND, 'i18n', 'en.js'), 'utf8');

/*
 * Strip comments: a rule must not be satisfied — or broken — by prose about it.
 *
 * ⚠️ ONLY COMMENTS THAT OPEN A LINE. The obvious /\*[\s\S]*?\*\// also matches the `accept="image/*"`
 * attribute inside the picker's template string and then eats everything up to the next real close
 * — which deleted the exact handler this file guards and turned one of these tests into a pass with
 * nothing behind it. That is the same class of bug as the vacuous tests these files keep catching.
 */
function code(src) {
  return src.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '').replace(/(^|[^:"'])\/\/.*$/gm, '$1');
}
const W = code(WIDGETS);
const S = code(SLIDES);

/** The body of a named function, from its declaration to the first column-0 `}`. */
function fnBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name}() is gone`);
  const end = src.indexOf('\n}', start);
  return src.slice(start, end === -1 ? undefined : end);
}

test('⚠️ the image picker can upload, so nobody has to leave the form to add a picture', () => {
  const picker = fnBody(W, 'openContentPicker');
  assert.match(picker, /type="file"/,
    'the picker has no file input — an operator whose picture is not already in the library is stuck');
  assert.match(picker, /api\.uploadContent\s*\(/,
    'the picker does not upload through api.uploadContent()');
  assert.match(picker, /drop['"]?\s*,/,
    'the picker accepts no drop — the file input alone is the smaller half of the feature');
});

test('⚠️ the upload goes through api.uploadContent, never a bare fetch/XHR', () => {
  /*
   * That helper is the one that asks remoteRoute whether the operator is looking at a LINKED
   * server. An upload that skips the question lands silently in your OWN workspace under a heading
   * that says someone else's — which has already happened once with content.
   */
  const picker = fnBody(W, 'openContentPicker');
  assert.ok(!/\bnew XMLHttpRequest\b/.test(picker), 'the picker built its own XHR');
  assert.ok(!/\bfetch\s*\(/.test(picker), 'the picker calls fetch() directly, bypassing routing');
});

test('⚠️ every picker fetch is type-filtered, not the 100 newest rows of every type', () => {
  /*
   * ⚠️ TYPE-FILTERED, not "image". It was image-only when the only picker was a background photo.
   * A slide now also picks a background VIDEO and two audio tracks, so slides.js asks three times,
   * once per type — and the rule that actually matters is unchanged: never an untyped /content on
   * the default limit, where the newest 100 rows of every kind crowd out the ones being offered.
   * That is the bug this test was written for, and it is what an empty picker looks like.
   */
  for (const [name, src] of [['widgets.js', W], ['slides.js', S]]) {
    const asks = [...src.matchAll(/['"]\/content(\?[^'"]*)?['"]/g)].map((m) => m[1] || '');
    assert.ok(asks.length, `${name} no longer fetches /content at all`);
    for (const qs of asks) {
      assert.match(qs, /type=(image|video|audio)\b/,
        `${name} fetches /content untyped, so other kinds crowd out the ones the picker offers`);
      assert.match(qs, /limit=(\d+)/,
        `${name} fetches /content without raising the limit off the 100 default`);
      assert.ok(Number(qs.match(/limit=(\d+)/)[1]) > 100,
        `${name} asks for ${qs} — the default 100 is the bug`);
    }
  }

  /*
   * And slides asks for all three. Each of these was empty on the screen at some point: the audio
   * pickers because the index was images-only when the tracks were added, and the background-video
   * picker for the whole time it had shipped — nobody had noticed, because the index it read was
   * built for backgrounds and quietly never contained a video.
   */
  const slideAsks = [...S.matchAll(/['"]\/content(\?[^'"]*)?['"]/g)].map((m) => m[1] || '').join(' ');
  for (const t of ['image', 'video', 'audio']) {
    assert.match(slideAsks, new RegExp(`type=${t}\\b`),
      `slides.js never asks for ${t} — that picker is empty on screen`);
  }
});

test('⚠️ picking an image does not rebuild the grid under the pointer', () => {
  /*
   * The multi-select branch used to call renderList() on every click. That re-hydrates every
   * authenticated thumbnail and resets the scroll position, so choosing a fourth background image
   * threw the operator back to the first row each time. One tile changes; paint one tile.
   */
  const picker = fnBody(W, 'openContentPicker');
  const from = picker.indexOf("querySelectorAll('[data-pick-id]')");
  assert.notEqual(from, -1, 'the tile click handler is gone — re-check this guard');
  const to = picker.indexOf('} else {', from);
  assert.notEqual(to, -1, 'the multi/single split in the tile click handler is gone');
  const toggle = picker.slice(from, to);          // the multiple-select branch only
  assert.match(toggle, /paintTile\s*\(/, 'the toggle no longer repaints the single tile');
  assert.ok(!/renderList\s*\(/.test(toggle),
    'toggling a selection re-renders the whole list, losing scroll position and re-fetching thumbnails');
});

test('⚠️ a refused upload reports the SERVER\'S reason, not a flat "Upload failed"', () => {
  /*
   * The server is specific — "Unsupported file type — only image, video and audio files are accepted", a
   * storage-limit refusal, "Switch to a workspace before uploading". uploadContent() replaced all
   * of it with a shrug, which is how a refused upload becomes "it just doesn't work".
   */
  const start = API.indexOf('xhr.onload', API.indexOf('uploadContent:'));
  assert.notEqual(start, -1, 'uploadContent no longer has an onload handler — re-check this guard');
  const onload = API.slice(start, API.indexOf('xhr.onerror', start));
  assert.ok(!/reject\(new Error\('Upload failed'\)\)/.test(onload),
    'a non-2xx still rejects with a flat "Upload failed", throwing away the server\'s reason');
  assert.match(onload, /JSON\.parse\(xhr\.responseText\)[\s\S]{0,160}\.error/,
    'uploadContent does not read the error out of the response body');
  // The transport-level failure keeps its generic message: there is no server reason to report.
  assert.match(API.slice(start), /xhr\.onerror\s*=/, 'the network-error path is gone');
});

test('the empty state stops sending people somewhere else', () => {
  const line = EN.match(/'widget\.picker\.no_images':\s*(['"])(.*?)\1/);
  assert.ok(line, 'the empty-state string is gone');
  assert.ok(!/Content Library/i.test(line[2]),
    'the picker still tells the operator to go and upload somewhere else: ' + line[2]);
  for (const key of ['upload', 'drop_hint', 'uploading', 'uploading_pct', 'upload_failed', 'not_an_image']) {
    assert.match(EN, new RegExp(`'widget\\.picker\\.${key}':`), `en.js is missing widget.picker.${key}`);
  }
});
