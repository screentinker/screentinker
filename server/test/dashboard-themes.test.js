'use strict';

/*
 * THE DASHBOARD'S THEMES.
 *
 * The look is a set of switchable themes: one block of tokens each in css/variables.css, chosen by
 * `data-theme` on <html>. What has to stay true for that to work and to keep working:
 *
 *   - every theme the picker offers has its tokens, and every token block has a picker entry;
 *   - a theme defines the whole palette, so no colour leaks through from another one;
 *   - Classic is the 3.x look exactly: the same values the single palette had, and the Control
 *     room design layer (css/theme.css) never applies to it;
 *   - the theme is on <html> before the first paint, and an unknown stored value is the default;
 *   - an account that never chose a brand colour does not pin the old defaults over the theme;
 *   - the typeface is bundled, with its licence, never fetched from somewhere else.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FE = path.join(__dirname, '..', '..', 'frontend');
const read = (p) => fs.readFileSync(path.join(FE, p), 'utf8');
const vars = read('css/variables.css');
const theme = read('css/theme.css');
const themesJs = read('js/lib/themes.js');
const prime = read('js/theme-prime.js');
const index = read('index.html');

const block = (sel) => {
  const at = vars.indexOf(sel + ' {');
  assert.ok(at >= 0, 'token block ' + sel);
  const body = vars.slice(at, vars.indexOf('\n}', at));
  return Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
};
const ids = [...themesJs.matchAll(/\{ id: '([a-z-]+)', attr: (null|'[a-z-]+')/g)].map((m) => ({ id: m[1], attr: m[2] === 'null' ? null : m[2].slice(1, -1) }));
const PALETTE = ['--bg-primary', '--bg-secondary', '--bg-card', '--bg-card-hover', '--bg-input', '--accent', '--accent-hover', '--accent-dim',
  '--text-primary', '--text-secondary', '--text-muted', '--success', '--success-dim', '--danger', '--danger-dim', '--warning', '--warning-dim',
  '--border', '--border-light', '--shadow', '--shadow-sm', '--bezel', '--screen-glow'];

test('the picker and the stylesheet offer the same themes', () => {
  assert.deepEqual(ids.map((t) => t.id), ['control-room', 'light', 'classic']);
  assert.equal(ids[0].attr, null, 'the default theme has no attribute');
  const inCss = [...vars.matchAll(/^:root\[data-theme="([a-z-]+)"\] \{/gm)].map((m) => m[1]).sort();
  assert.deepEqual(inCss, ids.filter((t) => t.attr).map((t) => t.attr).sort());
});

test('every theme defines the whole palette', () => {
  for (const sel of [':root', ':root[data-theme="light"]', ':root[data-theme="classic"]']) {
    const b = block(sel);
    for (const tok of PALETTE) assert.ok(b[tok], `${sel} sets ${tok}`);
  }
});

test('Classic is the 3.x palette, value for value', () => {
  const c = block(':root[data-theme="classic"]');
  const was = { '--bg-primary': '#111827', '--bg-secondary': '#1f2937', '--bg-card': '#1e293b', '--bg-card-hover': '#283548', '--bg-input': '#0f172a',
    '--accent': '#3b82f6', '--accent-hover': '#2563eb', '--accent-dim': '#1d4ed8', '--accent-2': '#8b5cf6', '--accent-3': '#22c55e',
    '--grad-accent': 'linear-gradient(135deg, var(--accent), var(--accent-2))', '--grad-bar': 'linear-gradient(90deg, var(--accent-2), var(--accent-3))',
    '--text-primary': '#f1f5f9', '--text-secondary': '#94a3b8', '--text-muted': '#64748b', '--success': '#22c55e', '--success-dim': '#15803d',
    '--danger': '#ef4444', '--danger-dim': '#991b1b', '--warning': '#f59e0b', '--warning-dim': '#92400e', '--border': '#334155', '--border-light': '#475569',
    '--radius': '8px', '--radius-lg': '12px', '--shadow': '0 4px 24px rgba(0, 0, 0, 0.4)', '--shadow-sm': '0 2px 8px rgba(0, 0, 0, 0.3)' };
  for (const [k, v] of Object.entries(was)) assert.equal(c[k], v, k);
  assert.doesNotMatch(c['--font-ui'], /Barlow/, 'and the system font it always had');
});

test('the Control room design layer never applies to Classic', () => {
  const rules = theme.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((r) => r.split('{')[0].trim()).filter(Boolean);
  const offenders = rules.filter((sel) => !sel.startsWith('@') && !/^(from|to|\d+%)/.test(sel) && sel !== ''
    && sel.split(',').some((s) => {
      const one = s.trim();
      return one && !one.startsWith(':root:not([data-theme="classic"])') && !one.startsWith(':root[data-theme="light"]') && !/^\.theme-/.test(one) && !/^(\d+%|from|to)$/.test(one);
    }));
  assert.deepEqual(offenders, [], 'selectors that would restyle Classic');
});

test('the theme is applied before the first paint, and a stale value is the default', () => {
  const head = index.slice(0, index.indexOf('</head>'));
  assert.ok(head.indexOf('/js/theme-prime.js') > 0 && head.indexOf('/js/theme-prime.js') < head.indexOf('/css/variables.css'), 'the primer runs before the stylesheets');
  assert.doesNotMatch(head.slice(head.indexOf('/js/theme-prime.js') - 40, head.indexOf('/js/theme-prime.js')), /defer|async|type="module"/, 'as a blocking classic script');
  assert.ok(head.indexOf('/css/theme.css') > head.indexOf('/css/library.css'), 'and the design layer loads last');
  const run = (stored) => {
    const attrs = {};
    const ctx = { localStorage: { getItem: () => stored }, document: { documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; } }, querySelector: () => null } };
    vm.runInNewContext(prime, ctx);
    return attrs['data-theme'] || null;
  };
  assert.equal(run('light'), 'light'); assert.equal(run('classic'), 'classic');
  for (const v of [null, 'control-room', 'neon', '', '<script>']) assert.equal(run(v), null, String(v));
  const throwing = { localStorage: { getItem: () => { throw new Error('blocked'); } }, document: { documentElement: { setAttribute() {}, removeAttribute() {} }, querySelector: () => null } };
  assert.doesNotThrow(() => vm.runInNewContext(prime, throwing), 'blocked storage is the default theme, not an error');
});

test('an account with no brand colour leaves the colours to the theme', () => {
  const branding = read('js/branding.js'), brandPrime = read('js/brand-prime.js');
  for (const [name, src] of [['branding.js', branding], ['brand-prime.js', brandPrime]]) {
    assert.match(src, /\['--accent', '--accent-2', '--accent-3'\]/, `${name}: all three accents follow one rule`);
    assert.match(src, /removeProperty\(v\)/, `${name}: the default colour clears the override`);
    assert.match(src, /#111827/, `${name}: the default background is recognised`);
    assert.match(src, /removeProperty\('--bg-primary'\)/, `${name}: and cleared, not pinned`);
  }
});

test('the typeface is bundled with its licence and fetched from nowhere else', () => {
  const dir = path.join(FE, 'vendor', 'fonts', 'barlow');
  const files = fs.readdirSync(dir);
  for (const w of [400, 500, 600, 700]) for (const s of ['latin', 'latin-ext']) assert.ok(files.includes(`barlow-${s}-${w}-normal.woff2`), `${s} ${w}`);
  assert.match(fs.readFileSync(path.join(dir, 'OFL.txt'), 'utf8'), /SIL Open Font License/);
  const urls = [...vars.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]);
  assert.equal(urls.length, 8);
  for (const u of urls) { assert.ok(u.startsWith('/vendor/fonts/barlow/'), u); assert.ok(fs.existsSync(path.join(FE, u)), u + ' exists'); }
  assert.doesNotMatch(vars + theme + index, /fonts\.googleapis|fonts\.gstatic|use\.typekit/);
});

test('every theme has its name and description in English', () => {
  const en = read('js/i18n/en.js');
  for (const t of ids) for (const k of ['name', 'desc']) assert.ok(en.includes(`'appearance.theme.${t.id}.${k}':`), `${t.id}.${k}`);
});
