'use strict';

/*
 * On the hosted instance an AI endpoint a tenant typed,
 * and the image URL that endpoint returns, must not reach the host's own network — by a literal, a
 * bracketed IPv6 form, or a NAME that resolves inward.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { guardedFetch } = require('../lib/ai-fetch');

function listen() {
  return new Promise((resolve) => {
    const hits = [];
    const srv = http.createServer((req, res) => { hits.push(req.url); res.end('{"models":["INTERNAL-SECRET"]}'); });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, hits, port: srv.address().port }));
  });
}

test('⚠️ hosted: loopback by literal, mapped IPv6, and by a NAME are all refused, and nothing connects', async () => {
  const { srv, hits, port } = await listen();
  try {
    for (const u of [
      `http://127.0.0.1:${port}/models`,
      `http://[::ffff:7f00:1]:${port}/models`,
      `http://[::ffff:127.0.0.1]:${port}/models`,
      `http://[::1]:${port}/models`,
      `http://localhost:${port}/models`,          // a name: only the connect-time lookup can catch it
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/',
    ]) {
      await assert.rejects(guardedFetch(u), /not allowed/, u);
    }
    assert.deepEqual(hits, [], 'the internal service must never see a request');
  } finally { srv.close(); }
});

test('non-http schemes and credentials in the URL are refused', async () => {
  await assert.rejects(guardedFetch('file:///etc/passwd'), /not allowed/);
  await assert.rejects(guardedFetch('http://user:pw@example.com/'), /not allowed/);
});

test('an aborted signal rejects as AbortError, as fetch does (the callers match on the name)', async () => {
  const c = new AbortController(); c.abort();
  await assert.rejects(guardedFetch('https://example.com/', { signal: c.signal }), (e) => e.name === 'AbortError');
});

test('every AI request goes through aiFetch: no bare fetch in the AI route or the image generator', () => {
  for (const f of ['routes/ai.js', 'lib/image-gen.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/(?<![.\w])fetch\(/.test(src), `${f} calls fetch directly — the returned image URL (data[0].url) was exactly that`);
  }
});

test('the guarded path does not follow redirects (a 3xx could point inward)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ai-fetch.js'), 'utf8');
  assert.ok(!/location/i.test(src.replace(/^\s*(\/\/|\*).*$/gm, '')), 'guardedFetch must not read Location');
  assert.match(src, /guardedLookup\(\{ allowPrivate: false \}\)/);
  assert.match(src, /vetRequestHost\(url\.hostname\)/, 'Node never calls lookup for an IP literal');
});

test('OIDC discovery, JWKS and token requests use the guarded transport, not bare fetch', () => {
  // assertFetchable() only sees the URL; a provider NAME resolving to a private address passed it.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'oidc.js'), 'utf8');
  assert.ok(!/(?<![.\w])fetch\(/.test(src), 'lib/oidc.js calls fetch directly');
  assert.match(src, /let transport = guardedFetch;/);
});
