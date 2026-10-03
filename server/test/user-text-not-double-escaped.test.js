'use strict';

/*
 * User-supplied names are stored as typed, and escaped where they are rendered.
 *
 * ⚠️ THE BUG THIS EXISTS FOR WAS DOUBLE ENCODING, AND IT COMPOUNDED. sanitizeBody HTML-escaped
 * `name`, `title` and `filename` on every request, and every view escaped again at the sink — so a
 * workspace called "R&D" was stored as `R&amp;D` and the operator read `R&amp;D` on their own
 * screen. Because the stored value went back through on the next save, a rename added another
 * layer each time:
 *
 *     R&D Lab -> R&amp;D Lab -> R&amp;amp;D Lab -> R&amp;amp;amp;D Lab
 *
 * There is one on production already: a playlist named `Diffusion d&quot;informations`.
 *
 * ⚠️ AND THE FIX IS ONLY SAFE BECAUSE THE SINKS ESCAPE, which was audited rather than assumed. That
 * audit is the fragile part, so the last test here pins the sinks that carry a name into markup. If
 * you add one that does not escape, storing raw text is no longer safe and this file should fail.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { cleanUserText, sanitizeBody } = require('../middleware/sanitize');

const run = (body) => {
  const req = { body };
  let called = false;
  sanitizeBody(req, {}, () => { called = true; });
  assert.ok(called, 'sanitizeBody must always call next()');
  return req.body;
};

test('⚠️ a name with markup characters is stored exactly as typed', () => {
  const out = run({ name: 'R&D Lab', title: 'Q&A "live"', filename: "O'Brien & Sons.jpg" });
  assert.equal(out.name, 'R&D Lab');
  assert.equal(out.title, 'Q&A "live"');
  assert.equal(out.filename, "O'Brien & Sons.jpg");
});

test('⚠️ saving the same value repeatedly does not change it', () => {
  /*
   * The compounding is the part that made this data corruption rather than a display bug: the value
   * read back from the database is what the next save sends.
   */
  let v = 'R&D Lab';
  for (let i = 0; i < 5; i++) v = run({ name: v }).name;
  assert.equal(v, 'R&D Lab', 'the value drifted across repeated saves');
});

test('control characters are stripped, because they hurt somewhere HTML escaping never protected', () => {
  // CR/LF in a name reaches a Content-Disposition header, a log line and a mail subject.
  const nasty = 'Lobby' + String.fromCharCode(13) + String.fromCharCode(10) + 'Set-Cookie: x=1';
  const out = run({ name: nasty });
  assert.ok(!/[\r\n]/.test(out.name), 'CR/LF survived into a stored name');
  assert.equal(out.name, 'LobbySet-Cookie: x=1');
});

test('surrounding whitespace goes, inner text is untouched', () => {
  assert.equal(cleanUserText('  Head Office  '), 'Head Office');
  assert.equal(cleanUserText('Head  Office'), 'Head  Office', 'inner spacing is the operator\'s business');
});

test('non-strings and missing fields pass through untouched', () => {
  assert.equal(cleanUserText(42), 42);
  assert.equal(cleanUserText(null), null);
  assert.equal(cleanUserText(undefined), undefined);
  const out = run({ name: 123, other: '<b>kept</b>' });
  assert.equal(out.name, 123);
  assert.equal(out.other, '<b>kept</b>', 'only the named fields are touched — a blob must not be rewritten');
});

test('a body-less request does not throw', () => {
  const req = {};
  let called = false;
  sanitizeBody(req, {}, () => { called = true; });
  assert.ok(called);
});

test('⚠️ every frontend sink that puts a name into markup still escapes it', () => {
  /*
   * The audit, pinned. Storing raw text is only safe while these hold. A `${...name...}` inside a
   * template literal with no esc()/escAttr() on the line is the shape that would make it unsafe —
   * `textContent`, `.title =`, `confirm()` and our own t() strings are not sinks.
   */
  const FRONTEND = path.join(__dirname, '..', '..', 'frontend', 'js');
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== 'i18n') walk(p); }
      else if (e.name.endsWith('.js')) files.push(p);
    }
  }(FRONTEND));

  const offenders = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const line of src.split('\n')) {
      // Only lines that build markup: a template literal containing a tag.
      if (!/[`"']\s*<\w|<\w[^>]*\$\{/.test(line)) continue;
      if (!/\$\{[^}]*\b(?:\w+\.)?(?:name|filename)\b[^}]*\}/.test(line)) continue;
      // escapeHtml() is the agency portal's own escaper — it is standalone and token-authed, so it
      // does not import the dashboard's utils. t() is one of our own translated strings.
      if (/\besc\(|\bescAttr\(|\bescapeHtml\(|\bt\(/.test(line)) continue;
      /*
       * ⚠️ ONE JUSTIFIED EXEMPTION, NOT A BLANKET ONE. The language picker interpolates `l.name`
       * from getAvailableLanguages() — our own static list in i18n.js, not anything a user can set.
       * Named explicitly so the exemption cannot quietly widen to cover a real sink.
       */
      if (/getAvailableLanguages\(\)/.test(line)) continue;
      if (/\.replace\(\/\[&<>"\]/.test(line)) continue;               // the remote banner strips instead
      offenders.push(`${path.relative(FRONTEND, file)}: ${line.trim().slice(0, 110)}`);
    }
  }
  assert.deepEqual(offenders, [],
    'a name reaches markup unescaped — with ingest no longer escaping, this is XSS:\n  ' + offenders.join('\n  '));
});
