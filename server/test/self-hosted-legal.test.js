'use strict';

/*
 * A self-hosted instance never serves the hosted service's terms or privacy policy as its own:
 * those name Bytetinker LLC, its billing, its support address and its DMCA agent (raised by
 * Omniflux, 2026-11-24). Hosted keeps them; self-hosted gets a neutral page, or redirects to the
 * operator's TERMS_URL / PRIVACY_URL.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startServer } = require('./helpers/web-player-e2e');
const legal = require('../lib/self-hosted-legal');

let hosted, selfHosted, configured;
before(async () => {
  [hosted, selfHosted, configured] = await Promise.all([
    startServer('legal-hosted', { SELF_HOSTED: 'false' }),
    startServer('legal-self'),
    startServer('legal-urls', { TERMS_URL: 'https://example.org/terms', PRIVACY_URL: 'https://example.org/privacy?x=1', }),
  ]);
});
after(() => { for (const s of [hosted, selfHosted, configured]) if (s) s.stop(); });

function get(srv, path) {
  return new Promise((resolve, reject) => {
    http.get(srv.base + path, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, type: res.headers['content-type'] || '', robots: res.headers['x-robots-tag'], body }));
    }).on('error', reject);
  });
}

test('hosted: the real terms (with the DMCA agent) and privacy policy', async () => {
  const t = await get(hosted, '/legal/terms.html');
  assert.equal(t.status, 200);
  assert.match(t.body, /Copyright and DMCA Notices/);
  assert.match(t.body, /DMCA-1087340/);
  const p = await get(hosted, '/legal/privacy.html');
  assert.equal(p.status, 200);
  assert.match(p.body, /support@screentinker\.com/);
  assert.match((await get(hosted, '/legal/terms.md')).body, /DMCA-1087340/);
});

test('self-hosted: a neutral page, never Bytetinker\'s terms, agent or contact', async () => {
  for (const path of ['/legal/terms.html', '/legal/terms', '/legal/terms.md', '/legal/privacy.html', '/legal/privacy', '/legal/privacy.md']) {
    const r = await get(selfHosted, path);
    assert.equal(r.status, 200, path);
    assert.doesNotMatch(r.body, /DMCA-1087340|Copyright Agent|support@screentinker\.com|Kenosha|Wisconsin|Stripe/, path);
    assert.match(r.body, /run independently by its operator/, path);
    assert.equal(r.robots, 'noindex', path);
    assert.match(r.type, path.endsWith('.md') ? /text\/markdown/ : /text\/html/, path);
  }
  assert.match((await get(selfHosted, '/legal/terms.html')).body, /notices[^<]*must go to its operator/);
  // Open-source notices are the same everywhere.
  const tp = await get(selfHosted, '/legal/third-party.html');
  assert.equal(tp.status, 200);
  assert.match(tp.body, /MIT|Copyright/);
});

test('self-hosted with TERMS_URL / PRIVACY_URL: redirect to the operator\'s own pages', async () => {
  for (const [path, to] of [['/legal/terms.html', 'https://example.org/terms'], ['/legal/terms.md', 'https://example.org/terms'], ['/legal/privacy', 'https://example.org/privacy?x=1']]) {
    const r = await get(configured, path);
    assert.equal(r.status, 302, path);
    assert.equal(r.location, to, path);
  }
});

test('only an absolute http(s) URL is taken from TERMS_URL / PRIVACY_URL', () => {
  assert.equal(legal.cleanUrl('https://example.org/terms'), 'https://example.org/terms');
  assert.equal(legal.cleanUrl(' http://intranet.local/privacy '), 'http://intranet.local/privacy');
  for (const bad of ['', '   ', 'javascript:alert(1)', '/legal/terms', 'ftp://x/y', 'https://user:pw@example.org/', 'not a url', undefined]) {
    assert.equal(legal.cleanUrl(bad), null, String(bad));
  }
});
