'use strict';

/*
 * The Transition form's "Applies to" text (frontend/js/views/widgets.js, widget.trans.*).
 *
 * Since #647 a transition is resolved PER ZONE (lib/transition-config.js): a scope "all" transition
 * covers every item in its own zone — the whole playlist when it plays full screen, one zone of a
 * layout otherwise. The form still said "One transition covers the whole playlist — drop this widget
 * in anywhere and every image will transition", which is now wrong for every layout playlist. Half
 * the locales had no transition strings at all and showed that English text.
 *
 * Source assertions: there is no DOM harness, and the strings are the whole fix.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const I18N = path.join(__dirname, '..', '..', 'frontend', 'js', 'i18n');
const LOCALES = ['en', 'de', 'es', 'fr', 'hi', 'it', 'ja', 'nl', 'pt', 'zh'];

/** The string value of `key` in a locale file, or null. Handles a value on the line after the key. */
function valueOf(src, key) {
  const m = src.match(new RegExp(`'${key.replace(/\./g, '\\.')}'\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`));
  return m ? m[1].slice(1, -1) : null;
}

// The pre-#647 wording, per locale that had it: none of it may survive.
const OLD = {
  en: ['covers the whole playlist', 'Every item in the playlist'],
  fr: ['couvre toute la liste de lecture', 'Chaque élément de la playlist'],
  ja: ['プレイリスト全体に適用されます', 'プレイリスト内のすべてのアイテム'],
  nl: ['geldt voor de volledige afspeellijst', 'Elk item in de afspeellijst'],
  zh: ['一个转场可覆盖整个播放列表', '播放列表中的每一项'],
};

test('the Transition form still asks for the strings it renders', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'widgets.js'), 'utf8');
  for (const k of ['widget.trans.scope', 'widget.trans.scope_all', 'widget.trans.scope_next', 'widget.trans.scope_hint']) {
    assert.ok(src.includes(`t('${k}')`), `widgets.js no longer renders ${k}`);
  }
});

test('every locale explains that a transition covers its own zone, chosen on the playlist row', () => {
  for (const lang of LOCALES) {
    const src = fs.readFileSync(path.join(I18N, `${lang}.js`), 'utf8');
    for (const k of ['widget.trans.scope', 'widget.trans.scope_all', 'widget.trans.scope_next', 'widget.trans.scope_hint']) {
      assert.ok(valueOf(src, k), `${lang}.js has no ${k}, so it shows the English text`);
    }
    const said = valueOf(src, 'widget.trans.scope_all') + ' ' + valueOf(src, 'widget.trans.scope_hint');
    for (const old of OLD[lang] || []) {
      assert.ok(!said.includes(old), `${lang}.js still says "${old}" — a transition covers its zone since #647`);
    }
  }
  const en = fs.readFileSync(path.join(I18N, 'en.js'), 'utf8');
  assert.match(valueOf(en, 'widget.trans.scope_all'), /zone/);
  assert.match(valueOf(en, 'widget.trans.scope_hint'), /zone/);
  assert.match(valueOf(en, 'widget.trans.scope_hint'), /playlist row/, 'say where the zone is chosen');
});
