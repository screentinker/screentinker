'use strict';

// Dashboard language and theme saved on the account (lib/account-prefs.js, users.language/theme).
// The server's lists must match what the dashboard can actually show: a language the server accepts
// but the dashboard lacks would be applied as a no-op forever, and one the dashboard has but the
// server refuses could never be saved.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const prefs = require('../lib/account-prefs');

const FRONT = path.join(__dirname, '..', '..', 'frontend', 'js');

test('server language list matches the dashboard i18n registry', () => {
  const src = fs.readFileSync(path.join(FRONT, 'i18n.js'), 'utf8');
  const m = src.match(/const registry = \{([^}]+)\}/);
  assert.ok(m, 'registry literal found');
  const codes = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual([...codes].sort(), [...prefs.LANGUAGES].sort());
});

test('server theme list matches the dashboard themes', () => {
  const src = fs.readFileSync(path.join(FRONT, 'lib', 'themes.js'), 'utf8');
  const ids = [...src.matchAll(/\{ id: '([a-z-]+)'/g)].map((x) => x[1]);
  assert.deepEqual([...ids].sort(), [...prefs.THEMES].sort());
});

test('pick: absent leaves alone, empty/null clears, unknown or non-string is ignored', () => {
  assert.deepEqual(prefs.pickLanguage(undefined), { set: false });
  assert.deepEqual(prefs.pickLanguage(null), { set: true, value: null });
  assert.deepEqual(prefs.pickLanguage(''), { set: true, value: null });
  assert.deepEqual(prefs.pickLanguage('DA'), { set: true, value: 'da' });
  assert.deepEqual(prefs.pickLanguage('klingon'), { set: false });
  assert.deepEqual(prefs.pickLanguage(['da']), { set: false });
  assert.deepEqual(prefs.pickTheme('light'), { set: true, value: 'light' });
  assert.deepEqual(prefs.pickTheme('<script>'), { set: false });
});

test('readPrefs: an unknown stored value reads as not chosen', () => {
  assert.deepEqual(prefs.readPrefs({ language: 'da', theme: 'light' }), { language: 'da', theme: 'light' });
  assert.deepEqual(prefs.readPrefs({ language: 'xx', theme: 'neon' }), { language: null, theme: null });
  assert.deepEqual(prefs.readPrefs(null), { language: null, theme: null });
});

test('dashboard wiring: applied from /me, saved from the language select and theme picker', () => {
  const app = fs.readFileSync(path.join(FRONT, 'app.js'), 'utf8');
  assert.match(app, /localStorage\.setItem\('user', JSON\.stringify\(fresh\)\);\s*\/\/[^\n]*\n\s*applyAccountPrefs\(fresh\);/);
  assert.match(fs.readFileSync(path.join(FRONT, 'views', 'settings.js'), 'utf8'), /setLanguage\(e\.target\.value\);\s*saveAccountPref\('language', getLanguage\(\)\);/);
  assert.match(fs.readFileSync(path.join(FRONT, 'components', 'theme-picker.js'), 'utf8'), /saveAccountPref\('theme', setTheme\(b\.dataset\.themeId\)\)/);
  const lib = fs.readFileSync(path.join(FRONT, 'lib', 'account-prefs.js'), 'utf8');
  assert.match(lib, /if \(!token\) return;/, 'signed out, nothing is sent');
});
