'use strict';

// i18n drift-guard for the public-API token UI: the apitoken.* keys must have full parity
// across all five locales. A key added to en (or any locale) without the others fails CI,
// so the Settings "API Tokens" UI can't ship a missing translation. No server needed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LOCALES = ['en', 'es', 'fr', 'de', 'pt'];
const I18N_DIR = path.join(__dirname, '..', '..', 'frontend', 'js', 'i18n');

function apitokenKeys(locale) {
  const text = fs.readFileSync(path.join(I18N_DIR, locale + '.js'), 'utf8');
  return new Set((text.match(/['"]apitoken\.[a-z_]+['"]/g) || []).map(s => s.replace(/['"]/g, '')));
}

test('i18n: apitoken.* keys have full parity across all 5 locales (drift fails CI)', () => {
  const base = apitokenKeys('en');
  assert.ok(base.size >= 20, `en should define the apitoken keys (found ${base.size})`);
  for (const loc of LOCALES) {
    const keys = apitokenKeys(loc);
    const missing = [...base].filter(k => !keys.has(k));
    const extra = [...keys].filter(k => !base.has(k));
    assert.deepEqual(missing, [], `${loc}.js is missing apitoken keys present in en: ${missing.join(', ')}`);
    assert.deepEqual(extra, [], `${loc}.js has apitoken keys not in en: ${extra.join(', ')}`);
  }
});
