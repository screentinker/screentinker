'use strict';

/*
 * A BRAND NAME IS TEXT.
 *
 * The white-label brand name is typed by a workspace admin, stored as typed, and substituted into
 * every translated string that says {brandName}. Many of those strings are written to the page as
 * HTML and some sit inside attributes, so whatever the name contains becomes part of the page for
 * everyone who opens that workspace: other members, and a platform operator acting in it.
 *
 * The substitution cannot escape for HTML, because the same strings are also written as plain text
 * (textContent, document.title, placeholders), where "&lt;" would show up literally. So the name is
 * made safe for BOTH: the handful of characters that can open a tag or close an attribute are
 * replaced with look-alikes that are only ever text. A real name reads the same as before.
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

let t;
before(async () => {
  globalThis.localStorage = { getItem: () => 'en', setItem() {} };
  if (!globalThis.navigator) globalThis.navigator = { language: 'en' };
  globalThis.window = globalThis.window || {};
  ({ t } = await import('../../frontend/js/i18n.js'));
});

const KEY = 'onboarding.step.welcome.title';       // carries {brandName} (brand-name-i18n.test.js pins that)
const withBrand = (name) => { globalThis.window.__ST_BRAND_NAME = name; return t(KEY); };

test('the key under test really substitutes the brand', () => {
  assert.match(withBrand('Acme Signs'), /Acme Signs/);
});

test('a name cannot open a tag or close an attribute, wherever the string is written', () => {
  for (const name of [
    '<img src=x onerror=alert(1)>',
    'Acme" onmouseover="alert(1)',
    "Acme' onfocus='alert(1)",
    'Acme`onload=alert(1)',
    '</script><script>alert(1)</script>',
  ]) {
    const out = withBrand(name);
    for (const ch of ['<', '>', '"', "'", '`']) {
      assert.ok(!out.includes(ch), `brand ${JSON.stringify(name)} left ${JSON.stringify(ch)} in ${JSON.stringify(out)}`);
    }
  }
});

test('an ordinary name reads as it always did', () => {
  assert.match(withBrand('Acme Signs & Displays, Inc.'), /Acme Signs & Displays, Inc\./);
  assert.match(withBrand('Café Société 24/7'), /Café Société 24\/7/);
  // An apostrophe is common in a real name. It becomes the typographic one, which reads the same.
  assert.match(withBrand("Joe's Signs"), /Joe’s Signs/);
});

test('no brand, or a blank one, is still the product name', () => {
  for (const v of [undefined, '', '   ', 42, null]) assert.match(withBrand(v), /ScreenTinker/);
});
