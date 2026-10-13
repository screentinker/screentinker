'use strict';

// The regex rewrites that bound polynomial backtracking. Each one is checked two ways: it agrees
// with the regex it replaced on representative and fuzzed inputs, and a pathological input that
// took the old form seconds finishes in milliseconds.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// org-sso pulls in db/database.js; give it a private, throwaway database.
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-regex-linear-')), 'test.db');

const { trimTrailing } = require('../lib/trim-trailing');
const saml = require('../lib/saml');
const { isEmail } = require('../routes/contact');
const { normaliseDomains } = require('../routes/org-sso');
const { parseParams } = require('../../shared/Transitions/params');
const { decodeText } = require('../../Examples/PIP-News-Ticker/news');

const FAST_MS = 250;
function fast(fn) {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

// Small deterministic PRNG so a failure reproduces.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
function randStr(r, alphabet, max) {
  let out = '';
  const n = Math.floor(r() * max);
  for (let i = 0; i < n; i++) out += alphabet[Math.floor(r() * alphabet.length)];
  return out;
}

test('trimTrailing matches .replace(/X+$/, "")', () => {
  const r = rng(1);
  for (const ch of ['/', '.']) {
    const re = ch === '/' ? /\/+$/ : /\.+$/;
    for (const s of ['', '/', '//', 'a', 'a/', 'a//', '/a', 'https://x.test/', 'https://x.test///', '..', 'acme.test.', 'a.b..']) {
      assert.strictEqual(trimTrailing(s, ch), s.replace(re, ''), JSON.stringify(s));
    }
    for (let i = 0; i < 3000; i++) {
      const s = randStr(r, `ab${ch}${ch}x `, 12);
      assert.strictEqual(trimTrailing(s, ch), s.replace(re, ''), JSON.stringify(s));
    }
  }
  assert.strictEqual(trimTrailing(undefined, '/'), 'undefined'); // String() like the old call sites
  assert.ok(fast(() => trimTrailing('/'.repeat(50000) + 'x', '/')) < FAST_MS);
  assert.ok(fast(() => trimTrailing('a' + '/'.repeat(50000), '/')) < FAST_MS);
});

test('isEmail matches /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/', () => {
  const old = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  for (const s of ['a@b.c', 'a@b.co.uk', 'a.b@c.d', 'a@.b', 'a@b.', 'a@b', '@b.c', 'a@@b.c', 'a@b@c.d',
    'a @b.c', 'a@b .c', 'a@b.c\n', '', 'a@b..c', 'a@..c', 'x@y.z.', 'jane.doe+tag@example.com', null, 5]) {
    assert.strictEqual(isEmail(s), old(s), JSON.stringify(s));
  }
  const r = rng(2);
  for (let i = 0; i < 5000; i++) {
    const s = randStr(r, 'a.@ \t', 9);
    assert.strictEqual(isEmail(s), old(s), JSON.stringify(s));
  }
  assert.ok(fast(() => isEmail('!@!.' + '!.'.repeat(25000))) < FAST_MS);
});

test('org-sso normaliseDomains drops a path the same way as .replace(/\\/.*$/, "")', () => {
  assert.strictEqual(normaliseDomains('@Acme.test/x/y, https://b.acme.test//p c.acme.test'), 'acme.test,b.acme.test,c.acme.test');
  assert.strictEqual(normaliseDomains('/acme.test'), ''); // nothing before the slash: skipped, as before
  assert.ok(fast(() => { try { normaliseDomains('a' + '/'.repeat(50000) + 'x'); } catch { /* shape only */ } }) < FAST_MS);
});

test('saml pemBlocks matches the BEGIN…END regex', () => {
  const B = '-----BEGIN CERTIFICATE-----';
  const E = '-----END CERTIFICATE-----';
  const old = (s) => s.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
  const r = rng(3);
  const parts = [B, E, 'AB', '\n', ' ', '-----'];
  for (let i = 0; i < 3000; i++) {
    let s = '';
    const n = Math.floor(r() * 8);
    for (let k = 0; k < n; k++) s += parts[Math.floor(r() * parts.length)];
    assert.deepStrictEqual(saml.pemBlocks(s), old(s), JSON.stringify(s));
  }
  assert.deepStrictEqual(saml.pemBlocks(`${B}\nQQ\n${E}\n\n${B}\nRR\n${E}`), [`${B}\nQQ\n${E}`, `${B}\nRR\n${E}`]);
  assert.ok(fast(() => saml.pemBlocks((B + 'a').repeat(5000))) < FAST_MS);
});

test('saml bareBlocks gives the same certificates as the old split', () => {
  // The caller strips all whitespace from each block, so compare after that; the count and order
  // must match exactly (it takes the first four).
  const strip = (a) => a.map((b) => b.replace(/\s+/g, ''));
  const old = (raw) => raw.split(/\s*\n\s*\n\s*|\s*,\s*/).filter(Boolean);
  const r = rng(4);
  for (let i = 0; i < 20000; i++) {
    const raw = randStr(r, 'AB,\n \t\r', 12).trim();
    if (!raw) continue;
    assert.deepStrictEqual(strip(saml.bareBlocks(raw)), strip(old(raw)), JSON.stringify(raw));
  }
  assert.ok(fast(() => saml.bareBlocks('A' + ' '.repeat(50000) + 'B')) < FAST_MS);
  assert.ok(fast(() => saml.bareBlocks('A' + ' \n'.repeat(25000) + 'B')) < FAST_MS);
});

test('transition PARAM_RE parses real shader params the same as before', () => {
  const OLD = /uniform\s+float\s+(\w+)\s*;\s*\/\/\s*=\s*(-?[\d.]+)\s*(?:\[\s*(-?[\d.]+)\s*\.\.\s*(-?[\d.]+)\s*\])?/g;
  function oldParse(src) {
    const out = [];
    let m;
    OLD.lastIndex = 0;
    while ((m = OLD.exec(src))) {
      const def = parseFloat(m[2]);
      const min = m[3] !== undefined ? parseFloat(m[3]) : Math.min(0, def);
      const max = m[4] !== undefined ? parseFloat(m[4]) : (def === 0 ? 1 : def * 2);
      out.push({ name: m[1], default: def, min, max, step: (max - min) / 200 });
    }
    return out;
  }
  const dir = path.join(__dirname, '..', '..', 'shared', 'Transitions');
  const glsl = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.glsl')) glsl.push(p);
    }
  })(dir);
  assert.ok(glsl.length > 0, 'found shader sources');
  let withParams = 0;
  for (const p of glsl) {
    const src = fs.readFileSync(p, 'utf8');
    const got = parseParams(src);
    if (got.length) withParams++;
    assert.deepStrictEqual(got, oldParse(src), p);
  }
  assert.ok(withParams > 0, 'some shaders declare params');
  for (const src of [
    'uniform float a; // = 0.5 [0.0..1.5]',
    'uniform float a;//=1',
    'uniform float a; // = -.25 [ -1. .. 1 ]',
    'uniform float a; // = 2 [0...1]',
    'uniform float a; // = 1.2.3',
    'uniform float a; // = 3 [0..]',
    'uniform float a; // = 0\nuniform float b; // = 4 [1..8]',
  ]) {
    assert.deepStrictEqual(parseParams(src), oldParse(src), src);
  }
  assert.ok(fast(() => parseParams('uniform float 0;//=.[' + '.'.repeat(50000))) < FAST_MS);
  assert.ok(fast(() => parseParams('uniform float a;//=1[0' + '.'.repeat(50000))) < FAST_MS);
});

test('tizen transitions bundle is in sync with shared/Transitions', () => {
  const built = require('../lib/transition-bundle').bundle();
  const committed = fs.readFileSync(path.join(__dirname, '..', '..', 'tizen', 'js', 'transitions.js'), 'utf8');
  assert.strictEqual(committed, built);
});

test('news ticker CDATA unwrap + tag strip match the old regexes', () => {
  const oldDecodeCdata = (t) => t.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  const r = rng(5);
  const parts = ['<![CDATA[', ']]>', 'x', '$1', ']]', '<![', '<', '>', '<>', '<b>'];
  for (let i = 0; i < 3000; i++) {
    let s = '';
    const n = Math.floor(r() * 8);
    for (let k = 0; k < n; k++) s += parts[Math.floor(r() * parts.length)];
    const viaOld = decodeTextWith(oldDecodeCdata, s);
    assert.strictEqual(decodeText(s), viaOld, JSON.stringify(s));
  }
  assert.ok(fast(() => decodeText('<![CDATA[' + '<![CDATA[a'.repeat(5000))) < FAST_MS);
  assert.ok(fast(() => decodeText('<'.repeat(50000))) < FAST_MS);
  assert.ok(fast(() => decodeText('<>'.repeat(25000) + '<')) < FAST_MS);
});

// decodeText with the old CDATA step swapped in, everything else identical.
function decodeTextWith(cdata, s) {
  let t = cdata(String(s));
  t = t.replace(/<[^>]+>/g, '');
  t = t
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
  return t.replace(/\s+/g, ' ').trim();
}
