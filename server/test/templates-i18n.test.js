'use strict';

// Template translations: locales/<lang>.json inside a package.
//
// ⚠️ THE FILE IS AN EXTRA, NEVER A REQUIREMENT. The manifest refuses unknown keys, so translations
// cannot live there without breaking every older server; a package file is something every server
// already accepts and ignores. These tests hold both halves: what this server accepts and shows,
// and that everything it refuses is refused with a message an author can act on.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-templates-i18n-'));
process.env.DATA_DIR = TMP;
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-templates-i18n-' + crypto.randomBytes(4).toString('hex');
const official = crypto.generateKeyPairSync('ed25519');
process.env.TEMPLATE_CATALOG_PUBLIC_KEY = official.publicKey.export({ type: 'spki', format: 'pem' });

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const pkg = require('../lib/templates/package');
const signing = require('../lib/templates/signing');
const store = require('../lib/templates/store');
const catalog = require('../lib/templates/catalog');
const render = require('../lib/templates/render');

const MANIFEST = {
  id: 'room-sign', name: 'Room sign', version: '1.0.0', kind: 'slide', license: 'MIT',
  description: 'Shows who is in the room.',
  params: [
    { name: 'headline', type: 'text', label: 'Headline', help: 'One line.', default: 'Welcome', max: 30 },
    { name: 'notes', type: 'textarea', label: 'Notes', default: 'Line one\nLine two', max: 100 },
    { name: 'layout', type: 'select', label: 'Layout', options: [{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }], default: 'left' },
    { name: 'accent', type: 'color', label: 'Accent', default: '#E8A33D' },
    { name: 'locale', type: 'locale', label: 'Language', default: '' },
  ],
};
const DOC = { template: { elements: [{ slot: 'headline', kind: 'head', box: { x: 5, y: 10, w: 90 } }] }, fields: { headline: '{{param:headline}}' } };
const DE = {
  name: 'Raumschild',
  description: 'Zeigt, wer im Raum ist.',
  params: {
    headline: { label: 'Überschrift', help: 'Eine Zeile.', default: 'Willkommen' },
    notes: { default: 'Zeile eins\nZeile zwei' },
    layout: { label: 'Anordnung', options: { left: 'Links', right: 'Rechts' } },
    locale: { label: 'Sprache' },
  },
};
const JA = { name: '会議室サイン', params: { headline: { label: '見出し', default: 'ようこそ' } } };

function build({ manifest = {}, files = {} } = {}) {
  return pkg.buildPackageBytes({ ...MANIFEST, ...manifest }, { 'template.json': Buffer.from(JSON.stringify(DOC)), ...files });
}
const loc = (obj) => Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
const withLocales = (map, over = {}) => build({ ...over, files: { ...Object.fromEntries(Object.entries(map).map(([k, v]) => [k, loc(v)])), ...(over.files || {}) } });

/* =================================================================== accepted */

test('valid locales are accepted and surfaced on the parsed result, the manifest untouched', () => {
  const bytes = withLocales({ 'locales/de.json': DE, 'locales/ja.json': JA });
  const parsed = pkg.parsePackageBytes(bytes);
  assert.deepEqual(parsed.i18n.de, DE);
  assert.deepEqual(parsed.i18n.ja, JA);
  assert.deepEqual(Object.keys(parsed.i18n).sort(), ['de', 'ja']);
  // The normalised manifest has exactly the shape it had before translations existed.
  const plain = pkg.parsePackageBytes(build());
  assert.deepEqual(parsed.manifest, plain.manifest);
  assert.deepEqual(plain.i18n, {});
  assert.ok(!('i18n' in parsed.manifest));
  // And the envelope path (what install and import use) carries it too.
  const env = pkg.parseEnvelope(pkg.buildEnvelope(bytes));
  assert.deepEqual(env.i18n.de.params.layout.options, { left: 'Links', right: 'Rechts' });
});

test('empty strings and empty objects are dropped, a BOM is tolerated, every key is optional', () => {
  const parsed = pkg.parsePackageBytes(withLocales({
    'locales/fr.json': { name: '', params: { headline: {}, layout: { options: {} } } },
    'locales/es.json': '﻿{"name":"Letrero de sala"}',
    'locales/nl.json': {},
  }));
  assert.deepEqual(parsed.i18n, { es: { name: 'Letrero de sala' } });
});

test('a package with locales still renders and validates its English defaults as before', () => {
  const env = pkg.parseEnvelope(pkg.buildEnvelope(withLocales({ 'locales/de.json': DE })));
  const values = render.lenientValues(env.manifest, {}, { files: env.files });
  assert.equal(values.headline, 'Welcome', 'the screen never reads the translation file');
  const cfg = render.buildSlideConfig(env, values);
  assert.equal(cfg.fields.headline, 'Welcome');
});

/* =================================================================== refused */

test('each malformed locales file is refused with a message that names the file', () => {
  const cases = [
    [{ 'locales/sv.json': {} }, /only locales\/<lang>\.json is allowed/],
    [{ 'locales/en.json': {} }, /only locales\/<lang>\.json is allowed/],
    [{ 'locales/de/extra.json': {} }, /only locales\/<lang>\.json is allowed/],
    [{ 'locales/DE.json': {} }, /only locales\/<lang>\.json is allowed/],
    [{ 'locales/de.json': 'not json' }, /locales\/de\.json: is not valid JSON/],
    [{ 'locales/de.json': '[]' }, /must be a JSON object/],
    [{ 'locales/de.json': { title: 'x' } }, /unknown key "title"/],
    [{ 'locales/de.json': { name: 42 } }, /locales\/de\.json: name must be a string/],
    [{ 'locales/de.json': { name: 'x'.repeat(81) } }, /name is too long \(max 80\)/],
    [{ 'locales/de.json': { description: 'x'.repeat(501) } }, /description is too long \(max 500\)/],
    [{ 'locales/de.json': { name: 'evil‮exe' } }, /contains control characters/],
    [{ 'locales/de.json': { name: '<b>x</b>\n' } }, /contains control characters/],
    [{ 'locales/de.json': { params: [] } }, /params must be an object/],
    [{ 'locales/de.json': { params: { nope: { label: 'x' } } } }, /params\."nope" is not a param of this template/],
    [{ 'locales/de.json': { params: { headline: 'x' } } }, /params\.headline must be an object/],
    [{ 'locales/de.json': { params: { headline: { placeholder: 'x' } } } }, /unknown key "placeholder"/],
    [{ 'locales/de.json': { params: { headline: { label: 'x'.repeat(81) } } } }, /label is too long \(max 80\)/],
    [{ 'locales/de.json': { params: { headline: { help: 'x'.repeat(201) } } } }, /help is too long \(max 200\)/],
    [{ 'locales/de.json': { params: { headline: { options: { a: 'b' } } } } }, /only a select param has options/],
    [{ 'locales/de.json': { params: { layout: { options: { middle: 'Mitte' } } } } }, /"middle" is not an option value/],
    [{ 'locales/de.json': { params: { layout: { options: ['Links'] } } } }, /options must be an object keyed by option value/],
    [{ 'locales/de.json': { params: { layout: { options: { left: 'x'.repeat(81) } } } } }, /too long \(max 80\)/],
    [{ 'locales/de.json': { params: { layout: { default: 'right' } } } }, /only a text or textarea param may have a translated default/],
    [{ 'locales/de.json': { params: { accent: { default: '#000' } } } }, /only a text or textarea param/],
    [{ 'locales/de.json': { params: { headline: { default: 7 } } } }, /default must be a string/],
    [{ 'locales/de.json': { params: { headline: { default: 'x'.repeat(31) } } } }, /default is too long \(max 30\)/],
    [{ 'locales/de.json': { params: { headline: { default: 'two\nlines' } } } }, /default contains characters that are not allowed/],
    [{ 'locales/de.json': { params: { notes: { default: 'bad\u0007bell' } } } }, /default contains characters/],
  ];
  for (const [files, re] of cases) {
    assert.throws(() => withLocales(files), (e) => e instanceof pkg.PackageError && re.test(e.message), `${JSON.stringify(files).slice(0, 120)} -> ${re}`);
  }
  // A textarea default may have line breaks, like the English one.
  assert.doesNotThrow(() => withLocales({ 'locales/de.json': { params: { notes: { default: 'a\nb\tc' } } } }));
  // Oversized file (still under the per-file package cap).
  const big = { description: 'x', params: { headline: { help: 'h' } }, pad: 'x'.repeat(pkg.MAX_LOCALE_FILE_BYTES) };
  assert.throws(() => withLocales({ 'locales/de.json': big }), /larger than/);
});

test('⚠️ the manifest itself still refuses a translations key (older servers would refuse it too)', () => {
  assert.throws(() => build({ manifest: { i18n: { de: { name: 'x' } } } }), /unknown key "i18n"/);
  assert.throws(() => build({ manifest: { locales: {} } }), /unknown key "locales"/);
});

test('the catalog build runs the same validation and refuses a bad locales file', () => {
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(TMP, 'cat-'));
  const t = path.join(dir, 'templates', 'room-sign');
  fs.mkdirSync(path.join(t, 'locales'), { recursive: true });
  fs.writeFileSync(path.join(t, 'manifest.json'), JSON.stringify(MANIFEST));
  fs.writeFileSync(path.join(t, 'template.json'), JSON.stringify(DOC));
  fs.writeFileSync(path.join(t, 'locales', 'de.json'), JSON.stringify(DE));
  const cli = path.join(__dirname, '../../scripts/template-catalog.js');
  const ok = spawnSync(process.execPath, [cli, 'build', path.join(dir, 'templates'), '-o', path.join(dir, 'dist')], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  fs.writeFileSync(path.join(t, 'locales', 'de.json'), JSON.stringify({ params: { typo: { label: 'x' } } }));
  const bad = spawnSync(process.execPath, [cli, 'build', path.join(dir, 'templates'), '-o', path.join(dir, 'dist2')], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr + bad.stdout, /"typo" is not a param of this template/);
});

/* =================================================================== surfaced to the dashboard */

function fresh() {
  db.prepare('DELETE FROM templates_installed').run();
  db.prepare('DELETE FROM template_catalogs').run();
  store._clearCache();
  catalog.ensureOfficial();
}

test('an install records the translations; the API gives ONE language, only when asked', () => {
  fresh();
  db.prepare("INSERT OR IGNORE INTO users (id, email, role, password_hash) VALUES ('u1','u1@test.local','platform_admin','x')").run();
  const bytes = withLocales({ 'locales/de.json': DE, 'locales/ja.json': JA });
  const row = catalog.importPackage(pkg.buildEnvelope(bytes, signing.signPackage(bytes, official.privateKey)), 'u1');
  assert.deepEqual(JSON.parse(store.getInstalled(row.id).i18n_json).de, DE);
  const { publicInstalled } = require('../routes/templates');
  const de = publicInstalled(store.getInstalled(row.id), 'de');
  assert.deepEqual(de.i18n, { de: DE }, 'only the language asked for');
  assert.equal(de.name, 'Room sign', 'the English stays where it was');
  assert.ok(!('i18n' in publicInstalled(store.getInstalled(row.id))), 'no lang: the payload older dashboards got');
  assert.ok(!('i18n' in publicInstalled(store.getInstalled(row.id), 'fr')), 'an untranslated language: no i18n key');
});

test('a row from before the i18n column is filled once from its package', () => {
  fresh();
  const bytes = withLocales({ 'locales/de.json': DE });
  const row = catalog.importPackage(pkg.buildEnvelope(bytes, signing.signPackage(bytes, official.privateKey)), 'u1');
  db.prepare('UPDATE templates_installed SET i18n_json = NULL WHERE id = ?').run(row.id);
  const r = store.getInstalled(row.id);
  assert.equal(r.i18n_json, null);
  assert.deepEqual(store.pickLang(store.i18nOf(r), 'de-AT'), DE);
  assert.deepEqual(JSON.parse(store.getInstalled(row.id).i18n_json), { de: DE });
  assert.equal(store.pickLang({ de: DE }, 'en'), null);
  assert.equal(store.pickLang({ de: DE }, '__proto__'), null);
});

/* =================================================================== the dashboard's half */

test('dashboard: translated labels and options, English fallback, defaults only for NEW widgets', async () => {
  const L = await import('../../frontend/js/lib/template-i18n.js');
  const tpl = { name: 'Room sign', description: 'Shows who is in the room.', params: MANIFEST.params.map((p) => ({ ...p })), i18n: { de: DE } };
  assert.equal(L.localName(tpl, 'de'), 'Raumschild');
  assert.equal(L.localName(tpl, 'fr'), 'Room sign');
  assert.equal(L.localDescription({ ...tpl, i18n: { de: { name: 'x' } } }, 'de'), 'Shows who is in the room.');
  const ps = L.localParams(tpl, 'de');
  const by = Object.fromEntries(ps.map((p) => [p.name, p]));
  assert.equal(by.headline.label, 'Überschrift');
  assert.equal(by.headline.help, 'Eine Zeile.');
  assert.equal(by.notes.label, 'Notes', 'an untranslated label stays English');
  assert.deepEqual(by.layout.options.map((o) => [o.value, o.label]), [['left', 'Links'], ['right', 'Rechts']], 'values never change');
  assert.equal(by.accent, tpl.params[3], 'an untranslated param is passed through as is');
  // New widget: translated text defaults; the screen language stays on auto.
  const fresh = L.initialFormValues(ps, null, { isNew: true });
  assert.equal(fresh.headline, 'Willkommen');
  assert.equal(fresh.notes, 'Zeile eins\nZeile zwei');
  assert.equal(fresh.layout, 'left');
  assert.equal(fresh.locale, '', 'the dashboard language is never forced onto the screen');
  // Editing: saved values win, and a missing one falls back to the ENGLISH default.
  const edit = L.initialFormValues(ps, { headline: 'Hello' }, { isNew: false });
  assert.equal(edit.headline, 'Hello');
  assert.equal(edit.notes, 'Line one\nLine two');
  assert.equal(L.langQuery('de'), '?lang=de');
  assert.equal(L.langQuery('en'), '');
  assert.equal(L.langQuery('../x'), '');
  assert.equal(L.translationFor({ i18n: { de: [] } }, 'de'), null);
});
