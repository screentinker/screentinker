'use strict';

/*
 * White-label substitution in user-facing strings (#292).
 *
 * A partner reselling this platform found their customers still being shown "ScreenTinker" in a
 * dozen places the White Label settings never reached — setup instructions, the empty-dashboard
 * hint, onboarding, sign-in errors. Their only workaround was CSS that could hide a section but
 * could not change a sentence.
 *
 * Those are translated strings, so the substitution belongs in the translation layer: they say
 * {brandName} and i18n.js fills it in at call time. Two things are worth pinning:
 *
 *   1. the strings really do carry the placeholder, in EVERY locale — a translator copying an
 *      English sentence back in is exactly how this regresses, silently, for one language;
 *   2. the placeholder actually resolves, and defaults to the product's own name so that an
 *      un-branded install reads exactly as it did before.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const I18N_DIR = path.join(__dirname, '..', '..', 'frontend', 'js', 'i18n');

/* The keys the issue enumerated that name the dashboard or the server: these follow the brand. */
const BRANDED_KEYS = [
  'auth.sso_err_domain_not_allowed',
  'settings.signin_err_link_already_used',
  'settings.import.invalid_file',
  'onboarding.step.welcome.title',
];

/*
 * ⚠️ Keys that name an INSTALLED app, and so must NOT follow the brand.
 *
 * Policy: the installed players (Android/Fire TV, Tizen, webOS, Roku, iOS, native Pi/Windows) keep
 * the ScreenTinker name and icon; only the web player and what the server serves is white-labelled
 * (branded app builds are a custom agreement). #292 had swept these in too, so a branded workspace
 * was told to "Install the Acme APK" — an app that does not exist. They say "ScreenTinker", as the
 * /download page does (the APK is ScreenTinker.apk, even though its Android label is RemoteDisplay).
 */
const APP_KEYS = [
  'settings.setup_step_1',
  'device.owner_provision.constraints',
  'device.terminal.welcome',
  'device.terminal.welcome_linux',
  'device.terminal.welcome_windows',
];

/* One sentence names both: the installed app (ScreenTinker) and the web player (the brand). */
const MIXED_KEY = 'dashboard.no_displays_desc';

const localeFiles = () => fs.readdirSync(I18N_DIR).filter((f) => f.endsWith('.js'));

/*
 * ⚠️ DELIBERATELY NOT IN THE LIST ABOVE.
 *
 * settings.hide_branding used to read 'Hide "ScreenTinker" branding', and substituting the brand
 * turned it into 'Hide "Acme" branding' on Acme's own instance — which is backwards: the toggle
 * hides the PLATFORM's attribution, not the operator's own name. The reporter of #292 asked for
 * generic wording instead, so this string names nobody at all.
 */
const GENERIC_KEY = 'settings.hide_branding';

test('no locale hardcodes the product name in a white-labelled string', () => {
  const offences = [];
  for (const file of localeFiles()) {
    const src = fs.readFileSync(path.join(I18N_DIR, file), 'utf8');
    for (const line of src.split('\n')) {
      if (!line.includes('ScreenTinker')) continue;
      if (BRANDED_KEYS.some((k) => line.includes(`'${k}'`) || line.includes(`"${k}"`))) {
        offences.push(`${file}: ${line.trim().slice(0, 90)}`);
      }
    }
  }
  assert.deepEqual(offences, [],
    'these strings must say {brandName}, or a reseller\'s customers see the upstream product name');
});

test('the English strings carry the placeholder rather than having simply lost the name', () => {
  // Guards the lazy fix: deleting "ScreenTinker" would satisfy the test above and leave a sentence
  // reading "Install the app on your TV", with nothing identifying what to install.
  const src = fs.readFileSync(path.join(I18N_DIR, 'en.js'), 'utf8');
  for (const key of BRANDED_KEYS) {
    const line = src.split('\n').find((l) => l.includes(`'${key}'`));
    assert.ok(line, `${key} is missing from en.js entirely`);
    assert.ok(line.includes('{brandName}'), `${key} should interpolate {brandName}: ${line.trim()}`);
  }
});

test('every translation of those keys keeps the placeholder', () => {
  // A translated string that drops {brandName} does not fail loudly — it just renders a sentence
  // with a hole in it, in one language, for the customers of one reseller.
  const missing = [];
  for (const file of localeFiles()) {
    if (file === 'en.js') continue;
    const src = fs.readFileSync(path.join(I18N_DIR, file), 'utf8');
    for (const key of BRANDED_KEYS) {
      const line = src.split('\n').find((l) => l.includes(`'${key}'`));
      if (!line) continue;                       // locale has not translated this key yet
      if (!line.includes('{brandName}')) missing.push(`${file}: ${key}`);
    }
  }
  assert.deepEqual(missing, [], 'translated strings dropped the {brandName} placeholder');
});

test('the interpolation resolves, and falls back to the product name', async () => {
  // i18n.js reads window.__ST_BRAND_NAME at CALL time, so branding.js can refresh it after first
  // paint and a workspace switch shows the new brand rather than the one cached at module load.
  const mod = path.join(I18N_DIR, '..', 'i18n.js');
  /*
   * i18n.js reads the saved language from localStorage AND sniffs navigator.language as it loads,
   * so both browser globals have to exist before the import — not because this test cares about
   * either, but because the module throws on the way in without them.
   *
   * ⚠️ navigator is the one that bites: Node has had it as a global only since 21, so this passed
   * locally on Node 24 and failed in CI on Node 20 with "navigator is not defined". Stubbing it
   * explicitly makes the test independent of which Node happens to be running it.
   */
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const priorNavigator = globalThis.navigator;
  if (!priorNavigator) globalThis.navigator = { language: 'en-US', languages: ['en-US'] };
  globalThis.window = { __ST_BRAND_NAME: undefined, localStorage: globalThis.localStorage,
                        navigator: globalThis.navigator };
  const { t } = await import(`file://${mod}`);

  const unbranded = t('onboarding.step.welcome.title');
  assert.ok(unbranded.includes('ScreenTinker'),
    `an un-branded install must read as before, got: ${unbranded}`);
  assert.ok(!unbranded.includes('{brandName}'), 'the placeholder must not leak to the screen');

  globalThis.window.__ST_BRAND_NAME = 'BoldSignage';
  const branded = t('onboarding.step.welcome.title');
  assert.ok(branded.includes('BoldSignage'), `expected the brand, got: ${branded}`);
  assert.ok(!branded.includes('ScreenTinker'), 'the upstream name must be gone once branded');

  // Under a brand, text about an installed app still names the app that is actually installed...
  for (const key of APP_KEYS) {
    const s = t(key);
    assert.ok(s.includes('ScreenTinker') && !s.includes('BoldSignage'), `${key} under a brand: ${s}`);
  }
  // ...while the empty-dashboard hint names the app AND the (branded) web player.
  const hint = t(MIXED_KEY);
  assert.match(hint, /ScreenTinker app/, hint);
  assert.match(hint, /BoldSignage web player/, hint);

  // Whitespace-only is not a brand.
  globalThis.window.__ST_BRAND_NAME = '   ';
  assert.ok(t('onboarding.step.welcome.title').includes('ScreenTinker'));
  delete globalThis.window;
  delete globalThis.localStorage;
  if (!priorNavigator) delete globalThis.navigator;
});

test('the hide-branding toggle names nobody', () => {
  // Neither the upstream product (the original bug) nor the operator's own brand (which would read
  // as "Hide Acme branding" on Acme's instance).
  for (const file of localeFiles()) {
    const src = fs.readFileSync(path.join(I18N_DIR, file), 'utf8');
    const line = src.split('\n').find((l) => l.includes(`'${GENERIC_KEY}'`));
    if (!line) continue;
    assert.ok(!line.includes('ScreenTinker'), `${file}: ${GENERIC_KEY} still names the product`);
    assert.ok(!line.includes('{brandName}'), `${file}: ${GENERIC_KEY} should be generic wording`);
  }
});

test('no locale brands a string about an installed app', () => {
  const offences = [];
  for (const file of localeFiles()) {
    const src = fs.readFileSync(path.join(I18N_DIR, file), 'utf8');
    for (const key of APP_KEYS) {
      // Exact key match: 'device.terminal.welcome' must not also pick up 'device.terminal.welcome_linux'.
      const line = src.split('\n').find((l) => l.includes(`'${key}':`));
      if (!line) continue;
      if (line.includes('{brandName}') || !line.includes('ScreenTinker')) offences.push(`${file}: ${key}`);
    }
  }
  assert.deepEqual(offences, [], 'installed apps keep the ScreenTinker name; say ScreenTinker, not {brandName}');
});

test('the empty-dashboard hint names the app as ScreenTinker and the web player by the brand', () => {
  const bad = [];
  for (const file of localeFiles()) {
    const src = fs.readFileSync(path.join(I18N_DIR, file), 'utf8');
    const line = src.split('\n').find((l) => l.includes(`'${MIXED_KEY}'`));
    if (!line) continue;
    if (!line.includes('ScreenTinker') || !line.includes('{brandName}')) bad.push(file);
  }
  assert.deepEqual(bad, []);
});

test('saving branding refreshes the brand already rendered on the Settings page', () => {
  // Settings renders once; without this the About block kept the old brand until a reload.
  const src = fs.readFileSync(path.join(I18N_DIR, '..', 'views', 'settings.js'), 'utf8');
  assert.match(src, /id="aboutBrandName"/);
  const save = src.slice(src.indexOf('await resetBranding();'));
  assert.match(save.slice(0, 400), /getElementById\('aboutBrandName'\)/);
});
