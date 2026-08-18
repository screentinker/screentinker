'use strict';

// t() returns the KEY ITSELF when a string is missing — `registry[lang]?.[key] ?? fallback[key] ?? key`.
// It never returns undefined. Two consequences, both of which have already bitten:
//
//   1. A missing key ships to the user as raw text. A browser run found a context menu whose only
//      item read "schedule.ctx_new".
//   2. `t('x') || 'Some default'` looks like a safety net but is dead code, because the key string
//      is truthy. The default can never render, so it hides the missing key instead of covering it.
//
// Neither shows up in a unit test of the logic, or in a syntax check, or in review — only in front
// of a user. So this walks the views for the keys they actually ask for and checks English has them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend', 'js');
const EN = fs.readFileSync(path.join(FRONTEND, 'i18n', 'en.js'), 'utf8');

// Keys defined in en.js, as written: 'some.key': '...'
const defined = new Set([...EN.matchAll(/^\s*'([^']+)'\s*:/gm)].map(m => m[1]));

function sourceFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'i18n') out.push(...sourceFiles(p)); }
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Only literal t('...') calls — a computed key cannot be checked statically, and pretending
// otherwise would produce false failures.
function referencedKeys(src) {
  return [...src.matchAll(/\bt\(\s*'([a-z0-9_]+(?:\.[a-z0-9_]+)+)'/gi)].map(m => m[1]);
}

test('every literal t() key used by the app exists in English', () => {
  const missing = [];
  for (const file of sourceFiles(FRONTEND)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const key of referencedKeys(src)) {
      if (!defined.has(key)) missing.push(`${path.relative(FRONTEND, file)}: ${key}`);
    }
  }
  assert.deepEqual(missing, [],
    `these render as raw key text to the user:\n  ${missing.join('\n  ')}`);
});

test('no t() call carries a || default, which can never fire', () => {
  // The pattern reads as a safety net and is the opposite: it guarantees the missing key is
  // silently shipped instead of the readable default.
  const offenders = [];
  for (const file of sourceFiles(FRONTEND)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'[^']+'\s*(?:,[^)]*)?\)\s*\|\|\s*'/g)) {
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${path.relative(FRONTEND, file)}:${line}`);
    }
  }
  assert.deepEqual(offenders, [],
    `t() never returns falsy, so these defaults are dead:\n  ${offenders.join('\n  ')}`);
});

test('the getting-started checklist has all of its strings', () => {
  // Called out separately because it is brand-new copy and entirely user-facing.
  for (const k of ['gs.title', 'gs.progress', 'gs.dismiss',
    'gs.device.title', 'gs.device.desc', 'gs.device.cta',
    'gs.content.title', 'gs.content.desc', 'gs.content.cta',
    'gs.playlist.title', 'gs.playlist.desc', 'gs.playlist.cta',
    'gs.assign.title', 'gs.assign.desc', 'gs.assign.cta']) {
    assert.ok(defined.has(k), `${k} is missing and would render literally`);
  }
});

// Help tips are the main in-product explanation, so a missing translation is not a cosmetic
// gap — it is a non-English user being handed an English paragraph at the exact moment they
// are confused. English is the deliberate fallback, but it should be a CHOICE, not a surprise.
//
// hi.js is intentionally empty (see the note at the top of that file: a real user in India,
// and a decision not to ship machine-quality Hindi), so it is excluded by name rather than by
// accident — if another locale is ever stubbed the same way it has to be added here on purpose.
const INTENTIONALLY_EMPTY = new Set(['hi']);

test('every help tip is translated in every active locale', () => {
  const dir = path.join(FRONTEND, 'i18n');
  const locales = fs.readdirSync(dir).filter(f => f.endsWith('.js') && f !== 'en.js')
    .map(f => f.replace('.js', '')).filter(l => !INTENTIONALLY_EMPTY.has(l));
  const tipKeys = [...defined].filter(k => k.endsWith('.help_tip'));
  assert.ok(tipKeys.length >= 10, `found ${tipKeys.length} tips in English`);

  const missing = [];
  for (const loc of locales) {
    const src = fs.readFileSync(path.join(dir, `${loc}.js`), 'utf8');
    const has = new Set([...src.matchAll(/^\s*'([^']+)'\s*:/gm)].map(m => m[1]));
    for (const k of tipKeys) if (!has.has(k)) missing.push(`${loc}: ${k}`);
  }
  assert.deepEqual(missing, [],
    `these tips fall back to English:\n  ${missing.join('\n  ')}`);
});

// Every locale shipped in frontend/js/i18n. Keep in step with the registry in i18n.js.
const ACTIVE_LOCALES = ['es', 'fr', 'de', 'pt', 'hi', 'it', 'ja'];

test('a locale never defines a key that English does not', () => {
  // The half of parity that is ALWAYS actionable: a key in a locale file that no longer exists in
  // en.js is dead weight or a typo left behind by a rename, and whoever touched that file can fix
  // it without speaking the language. Missing keys are the other direction - see below.
  for (const locale of ACTIVE_LOCALES) {
    const src = fs.readFileSync(path.join(FRONTEND, 'i18n', `${locale}.js`), 'utf8');
    const keys = new Set([...src.matchAll(/^\s*'([^']+)'\s*:/gm)].map(m => m[1]));
    assert.deepEqual([...keys].filter(k => !defined.has(k)), [],
      `${locale}.js defines keys that do not exist in en.js`);
  }
});

test('translation coverage is reported, but an untranslated string is not a build failure', () => {
  // ⚠️ WHY A MISSING TRANSLATION DOES NOT FAIL THE BUILD.
  //
  // i18n.js lookup() is `registry[lang]?.[key] ?? fallback[key] ?? key`, so an untranslated string
  // already renders in English. Nothing is broken by a gap.
  //
  // Making the gap fatal - as the first version of the Japanese check did - means every new English
  // string blocks CI until someone who reads that language is available. That is a guarantee we
  // cannot keep, and it puts the cost on whoever is shipping the feature rather than on whoever can
  // actually translate. It also singled out one locale: es, fr, de, pt, hi and it were never held
  // to it.
  //
  // So: report the number, do not gate on it. The strings that genuinely must exist everywhere are
  // the help tips, and they have their own test above, which does fail.
  for (const locale of ACTIVE_LOCALES) {
    const src = fs.readFileSync(path.join(FRONTEND, 'i18n', `${locale}.js`), 'utf8');
    const keys = new Set([...src.matchAll(/^\s*'([^']+)'\s*:/gm)].map(m => m[1]));
    const missing = [...defined].filter(k => !keys.has(k));
    const pct = ((defined.size - missing.length) / defined.size * 100).toFixed(1);
    console.log(`      ${locale}: ${defined.size - missing.length}/${defined.size} (${pct}%)` +
                (missing.length ? ` - ${missing.length} fall back to English` : ''));
  }
});

test('a tip marker in a view always names a real string', () => {
  // <span class="help-tip" data-tip="${t('x')}"> renders the KEY when x is undefined, putting
  // a bare identifier in the tooltip of the thing meant to explain the page.
  const missing = [];
  for (const file of sourceFiles(FRONTEND)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/class="help-tip"\s+data-tip="\$\{t\('([^']+)'\)\}"/g)) {
      if (!defined.has(m[1])) missing.push(`${path.relative(FRONTEND, file)}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], missing.join('\n  '));
});

test('user-facing labels are translated, not hardcoded English', () => {
  // A title= is a tooltip the user reads and an aria-label is what a screen reader says. Both
  // were hardcoded English in a dozen places, so a French user hovering the only route to
  // workspace members heard "Manage members". They are invisible to the key checks above
  // precisely because they never call t().
  const offenders = [];
  for (const file of sourceFiles(FRONTEND)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(aria-label|title)="([A-Z][a-zA-Z ]{3,40})"/g)) {
      offenders.push(`${path.relative(FRONTEND, file)}: ${m[1]}="${m[2]}"`);
    }
  }
  assert.deepEqual(offenders, [],
    `these ship English regardless of language:\n  ${offenders.join('\n  ')}`);
});
