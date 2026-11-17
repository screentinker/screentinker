'use strict';

/*
 * ⚠️ GHSA-rvxj (D): NO SESSION JWT IN A SCREENSHOT (OR BACKUP) URL.
 *
 * screenshotUrl() appended `&token=<session JWT>` so a plain <img src> could load the picture. The
 * token is a full 7-day session, so it ended up in reverse-proxy access logs, browser history and
 * every copied image link (helmet's no-referrer only stops the Referer leak). The admin page did the
 * same with the database backup link.
 *
 * The fix is on both ends: the routes take the Authorization header only (pinned live in
 * session-token-resolution.test.js and mesh-hub-api.test.js), and every caller loads the image via
 * data-auth-src + hydrateAuthImages() (Bearer fetch into a blob URL). This pins the frontend half,
 * because a caller left on <img src="${screenshotUrl(...)}"> would not leak — it would just render a
 * broken picture, which is the kind of regression nobody reports.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FE = path.join(__dirname, '..', '..', 'frontend', 'js');
const read = (rel) => fs.readFileSync(path.join(FE, rel), 'utf8');

function sourceFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'i18n') out.push(...sourceFiles(p)); }
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('screenshotUrl() builds a URL with no credential in it', () => {
  const src = read('utils.js');
  const fn = src.slice(src.indexOf('export function screenshotUrl'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.doesNotMatch(body, /token/i, 'screenshotUrl must not read or append the session token');
});

test('every screenshotUrl() caller loads it through data-auth-src, never a bare <img src>', () => {
  const offenders = [];
  for (const file of sourceFiles(FE)) {
    const src = fs.readFileSync(file, 'utf8');
    if (!/screenshotUrl\(/.test(src) || file.endsWith('utils.js')) continue;
    // A bare src would 401 now the routes refuse ?token= — a broken image, silently.
    if (/(?<![-\w])src="\$\{\s*(?:esc\()?(?:screenshotUrl|shotSrc|src)\b/.test(src)) offenders.push(path.relative(FE, file));
    if (!/data-auth-src/.test(src) || !/hydrateAuthImages\(/.test(src)) offenders.push(path.relative(FE, file) + ' (no hydrate)');
  }
  assert.deepEqual(offenders, [], 'these render a screenshot without the Bearer fetch');
});

test('no live screenshot handler glues the session token onto a URL', () => {
  const offenders = [];
  for (const file of sourceFiles(FE)) {
    const src = fs.readFileSync(file, 'utf8');
    if (/['"`]&?token=['"`]\s*\+/.test(src) || /\+\s*['"]&token='/.test(src)) offenders.push(path.relative(FE, file));
  }
  assert.deepEqual(offenders, [], 'the dead `data.url + "&token="` fallbacks must stay removed');
});

test('the database backup is downloaded with a Bearer header, not a ?token= link', () => {
  const src = read('views/admin.js');
  assert.doesNotMatch(src, /\/api\/status\/backup\?token=/, 'a platform-admin session must not ride in an href');
  assert.match(src, /fetch\('\/api\/status\/backup', \{ headers: \{ Authorization: `Bearer /);
});
