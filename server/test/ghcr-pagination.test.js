'use strict';

/*
 * The GHCR tag list is PAGINATED, and the update check has to follow it.
 *
 * GHCR returns 100 tags plus a `Link: <...>; rel="next"` header. The check read page one and
 * stopped. Page one is in push order, so it ends wherever the project was 100 tags ago: on this
 * repo it stopped at 2.0.0-beta5, and the highest semver tag visible was 1.9.40 — permanently,
 * drifting further behind with every release. So every self-hosted instance was told 1.9.40 was
 * current: nobody on 1.9.x was ever offered 2.x, and instances already on 2.x were told they were
 * ahead of the latest release. Nothing errored, which is why it went unnoticed.
 *
 * Fetch is stubbed here: a test that depends on what is really published would start failing on
 * its own one day, for reasons having nothing to do with this code.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const ghcr = require('../lib/ghcr-check');

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

// --- the Link-header parser -------------------------------------------------

test('nextPageUrl resolves the relative path registries actually send', () => {
  const cur = 'https://ghcr.io/v2/screentinker/screentinker/tags/list?n=100';
  const link = '</v2/screentinker/screentinker/tags/list?last=2.0.0-beta5&n=100>; rel="next"';
  assert.equal(ghcr.nextPageUrl(link, cur),
    'https://ghcr.io/v2/screentinker/screentinker/tags/list?last=2.0.0-beta5&n=100');
});

test('nextPageUrl returns null when there is no next link (this is how the walk ends)', () => {
  const cur = 'https://ghcr.io/v2/x/y/tags/list';
  assert.equal(ghcr.nextPageUrl(null, cur), null);
  assert.equal(ghcr.nextPageUrl('', cur), null);
  assert.equal(ghcr.nextPageUrl('</v2/x/y/tags/list?last=a>; rel="prev"', cur), null);
});

test('nextPageUrl picks next out of a multi-link header', () => {
  const cur = 'https://ghcr.io/v2/x/y/tags/list';
  const link = '</v2/x/y/tags/list?last=a>; rel="prev", </v2/x/y/tags/list?last=z>; rel="next"';
  assert.match(ghcr.nextPageUrl(link, cur), /last=z$/);
});

// --- the walk ---------------------------------------------------------------

function stubRegistry(pages) {
  let call = 0;
  global.fetch = async (url) => {
    if (String(url).includes('/token')) {
      return { ok: true, status: 200, json: async () => ({ token: 't' }), headers: new Headers() };
    }
    const page = pages[call++] || { tags: [] };
    const headers = new Headers();
    if (page.next) headers.set('link', `<${page.next}>; rel="next"`);
    return { ok: true, status: 200, json: async () => ({ tags: page.tags }), headers };
  };
  return () => call;
}

test('REGRESSION: a newer tag on page TWO is found', async () => {
  stubRegistry([
    { tags: ['1.9.38', '1.9.39', '1.9.40', '2.0.0-beta5'], next: '/v2/x/y/tags/list?last=2.0.0-beta5' },
    { tags: ['2.0.0', '2.0.4'] },
  ]);
  const r = await ghcr.checkNow('1.9.40');
  assert.equal(r.latest, '2.0.4', 'page one alone would have said 1.9.40');
  assert.equal(r.update_available, true, 'a 1.9.x instance must be offered 2.x');
});

test('a single unpaginated page still works', async () => {
  stubRegistry([{ tags: ['1.0.0', '1.2.0'] }]);
  const r = await ghcr.checkNow('1.0.0');
  assert.equal(r.latest, '1.2.0');
});

test('the walk is bounded, so a registry that always returns next cannot loop for ever', async () => {
  // Every page hands back another next link. Without a cap this never returns.
  let n = 0;
  global.fetch = async (url) => {
    if (String(url).includes('/token')) return { ok: true, status: 200, json: async () => ({ token: 't' }), headers: new Headers() };
    n++;
    const headers = new Headers();
    headers.set('link', `<https://ghcr.io/v2/x/y/tags/list?last=${n}>; rel="next"`);
    return { ok: true, status: 200, json: async () => ({ tags: [`1.0.${n}`] }), headers };
  };
  const r = await ghcr.checkNow('1.0.0');
  assert.ok(n <= 20, `walked ${n} pages; must stop at the cap`);
  assert.ok(r.latest, 'what it did gather is still used rather than thrown away');
});

test('a later page failing still uses the tags already gathered', async () => {
  let call = 0;
  global.fetch = async (url) => {
    if (String(url).includes('/token')) return { ok: true, status: 200, json: async () => ({ token: 't' }), headers: new Headers() };
    if (call++ === 0) {
      const headers = new Headers();
      headers.set('link', '<https://ghcr.io/v2/x/y/tags/list?last=a>; rel="next"');
      return { ok: true, status: 200, json: async () => ({ tags: ['1.0.0', '1.5.0'] }), headers };
    }
    return { ok: false, status: 500, json: async () => ({}), headers: new Headers() };
  };
  const r = await ghcr.checkNow('1.0.0');
  assert.equal(r.latest, '1.5.0', 'a partial answer beats no answer');
});

test('a first-page 404 still means "nothing published", not an error', async () => {
  global.fetch = async (url) => {
    if (String(url).includes('/token')) return { ok: true, status: 200, json: async () => ({ token: 't' }), headers: new Headers() };
    return { ok: false, status: 404, json: async () => ({}), headers: new Headers() };
  };
  const r = await ghcr.checkNow('1.0.0');
  assert.equal(r.latest, null);
  assert.equal(r.update_available, false);
});
