'use strict';
/*
 * Unknown content-page URLs must 404, not answer 200 with the dashboard.
 *
 * sitemap.xml advertises six /guides/ URLs. Before this, any other path under that prefix fell
 * through to the SPA catch-all and returned 200 with ~60KB of dashboard HTML. That is a soft-404,
 * and it is worse than a plain miss: a crawler that finds a typo'd or retired guide answering 200
 * with unrelated markup learns to distrust the directory that the real guides live in. Flagged in
 * docs/seo-directory-listings.md, and Bing's report on this site is the reason it got fixed.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');

test('the catch-all refuses content prefixes instead of serving the SPA', () => {
  const m = SRC.match(/const CONTENT_PREFIXES = \[([^\]]*)\]/);
  assert.ok(m, 'CONTENT_PREFIXES must exist');
  assert.match(m[1], /'\/guides\/'/, 'guides is the prefix the sitemap advertises');

  // The guard has to run BEFORE the sendFile, or it never fires.
  const guard = SRC.indexOf('CONTENT_PREFIXES.some');
  const fallback = SRC.indexOf("res.sendFile(path.join(config.frontendDir, 'index.html'))");
  assert.ok(guard > 0 && fallback > guard, 'the 404 guard must precede the SPA fallback');
});

test('every guide the sitemap advertises actually exists, or we 404 our own listed URLs', () => {
  const sitemap = fs.readFileSync(path.join(ROOT, 'frontend', 'sitemap.xml'), 'utf8');
  const listed = [...sitemap.matchAll(/<loc>[^<]*?(\/guides\/[^<]+)<\/loc>/g)].map((x) => x[1]);
  assert.ok(listed.length > 0, 'the sitemap lists guides');
  for (const url of listed) {
    const file = path.join(ROOT, 'frontend', url.replace(/^\//, ''));
    assert.ok(fs.existsSync(file), `sitemap lists ${url} but ${file} is not there`);
  }
});

test('the 404 body is noindex, so a crawler cannot bank it as a page', () => {
  const m = SRC.match(/const NOT_FOUND_PAGE = ([\s\S]*?);\n\n/);
  assert.ok(m, 'NOT_FOUND_PAGE must exist');
  assert.match(m[1], /noindex/, 'a 404 body that omits noindex can still be indexed on a soft serve');
  assert.match(m[1], /Page not found/);
});
