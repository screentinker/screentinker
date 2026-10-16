'use strict';

/*
 * The playlist's bulk Transition action (frontend/js/views/playlists.js, act === 'transition').
 *
 * It asked which transition to apply with the browser's prompt(): a numbered list of names in a
 * text box, where the user typed a number (or a name). Untranslatable chrome, no keyboard choice,
 * and a typo silently did nothing. It now uses the app's dialog (corporate-ui openModal, as #640
 * did for placeholder pairing and request decline): the workspace's transition widgets as radio
 * choices, Enter or Apply applies, Escape or Cancel changes nothing. Same server call as before.
 *
 * ⚠️ SOURCE ASSERTIONS, deliberately — there is no DOM harness (see guide-dialogs-plan-limit.test.js).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend', 'js');
const read = (p) => fs.readFileSync(path.join(FRONTEND, p), 'utf8');
// Strip line-leading block comments and // comments, so prose about prompt() does not count.
const code = (src) => src.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '').replace(/(^|[^:"'])\/\/.*$/gm, '$1');
function fnBody(src, name) {
  const start = src.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.notEqual(start, -1, `${name}() is gone`);
  const end = src.indexOf('\n}', start);
  return src.slice(start, end === -1 ? undefined : end);
}

const PLAYLISTS = code(read('views/playlists.js'));

/** The `if (act === 'transition') { ... }` branch. */
function transitionBranch() {
  const start = PLAYLISTS.indexOf("if (act === 'transition')");
  assert.notEqual(start, -1, 'the bulk transition action is gone');
  const end = PLAYLISTS.indexOf("if (act === 'condition')", start);
  return PLAYLISTS.slice(start, end === -1 ? undefined : end);
}

test('the bulk Transition action no longer uses the browser prompt()', () => {
  const branch = transitionBranch();
  assert.ok(!/(^|[^.\w])prompt\s*\(/m.test(branch) && !/window\.prompt\s*\(/.test(branch),
    'the transition picker still calls prompt(), which cannot be translated or used from a list');
  assert.match(branch, /await pickTransitionWidget\(trans\)/);
  assert.match(branch, /runSelection\(\{ action: 'transition', ids, widget_id: w\.id \}\)/, 'same server call as before');
  assert.match(branch, /w\.widget_type === 'transition'/, 'only the workspace\'s transition widgets are offered');
});

test('the picker is the app dialog: a list of choices, keyboard first, Escape cancels', () => {
  const fn = fnBody(PLAYLISTS, 'pickTransitionWidget');
  assert.match(PLAYLISTS, /import \* as cui from '\.\.\/components\/corporate-ui\.js';/);
  assert.match(fn, /cui\.openModal\(\{/, 'the shared dialog skeleton (its Escape and overlay click close it)');
  assert.match(fn, /onClose: \(\) => resolve\(picked\)/, 'closing without applying resolves null');
  assert.match(fn, /type="radio"/, 'a list of choices, not a typed number');
  assert.match(fn, /role="radiogroup"/);
  assert.match(fn, /e\.key === 'Enter'/, 'Enter applies the choice');
  assert.match(fn, /\.focus\(\)/, 'the first choice has focus, so the arrow keys work at once');
  assert.match(fn, /data-corp-close/, 'a Cancel button that closes the dialog');
  assert.match(fn, /esc\(w\.name\)/, 'widget names are escaped');
  for (const k of ['playlist.bulk.transition_title', 'playlist.bulk.transition_pick', 'playlist.bulk.apply', 'common.cancel']) {
    assert.ok(fn.includes(`t('${k}')`), `the dialog renders ${k}`);
  }
  // openModal's own contract: Escape closes, and close() calls onClose.
  const modal = fnBody(code(read('components/corporate-ui.js')), 'openModal');
  assert.match(modal, /e\.key === 'Escape'/);
  assert.match(modal, /onClose\(\)/);
});

test('the dialog strings exist in all ten locales', () => {
  for (const lang of ['en', 'de', 'es', 'fr', 'hi', 'it', 'ja', 'nl', 'pt', 'zh']) {
    const src = read(`i18n/${lang}.js`);
    for (const k of ['playlist.bulk.transition_title', 'playlist.bulk.transition_pick', 'playlist.bulk.apply', 'playlist.bulk.no_transition']) {
      assert.match(src, new RegExp(`'${k.replace(/\./g, '\\.')}'\\s*:`), `${lang}.js has no ${k}`);
    }
  }
});
