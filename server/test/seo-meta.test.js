'use strict';
/*
 * Every URL we advertise in sitemap.xml must be a real page with the metadata a crawler needs.
 *
 * This exists because nothing checked it. Bing found a "title too long" on a guide, three /legal/
 * pages were being crawled with no description at all, and the homepage description was long
 * enough to be truncated in results. All of that is measurable here in a second, and none of it
 * was. The alternative on offer was installing a third-party SEO skill, which encodes a
 * methodology but cannot fail a build.
 *
 * ⚠️ MEASURE THE RENDERED TEXT, NOT THE MARKUP. "&amp;" is five characters that display as one, and
 * counting raw HTML made the homepage title look like it was exactly on Bing's 70-character limit
 * when it renders at 66. Decode first or this test reports phantom failures.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FRONTEND = path.join(ROOT, 'frontend');
const SITEMAP = path.join(FRONTEND, 'sitemap.xml');

// Bing: "less than 70". Google truncates descriptions around 160.
const TITLE_MAX = 70;
const DESC_MAX = 160;

const decode = (s) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');

/* Which file on disk serves a sitemap URL. `/` is the marketing landing page, NOT index.html,
 * which is the dashboard SPA (hence robots.txt disallowing /app). */
function fileFor(urlPath) {
  if (urlPath === '/') return path.join(FRONTEND, 'landing.html');
  if (urlPath.endsWith('/')) return path.join(FRONTEND, urlPath, 'index.html');
  // An extension-less URL is served by an explicit route in server.js off the same name + .html
  // (/certified-hardware, and /docs and /agency in the same style). That indirection exists so a
  // URL named in a contract does not encode the file layout, so resolve it the same way here.
  const direct = path.join(FRONTEND, urlPath);
  if (!path.extname(urlPath) && fs.existsSync(`${direct}.html`)) return `${direct}.html`;
  return direct;
}

const urls = [...fs.readFileSync(SITEMAP, 'utf8').matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)]
  .map((m) => m[1].replace(/^https?:\/\/[^/]+/, ''));

test('⚠️ every published page names its Markdown twin IN THE DOCUMENT', () => {
  /*
   * The server already negotiates `Accept: text/markdown` and advertises the rendition in a `Link`
   * header. Neither survives a CDN: Cloudflare ignores `Vary` for caching (everything except
   * Accept-Encoding), so one cached variant is served to every client — a request asking for
   * Markdown gets the cached HTML body, and the cached body carries whatever `Link` header it was
   * stored with, which may predate the feature.
   *
   * A <link rel="alternate"> inside the <head> is part of that body, so it survives the cache and
   * is what an HTML-parsing agent looks for anyway. It is the only part of this we control.
   */
  for (const u of urls) {
    const html = fs.readFileSync(fileFor(u), 'utf8');
    const m = html.match(/<link rel="alternate" type="text\/markdown" href="([^"]+)">/);
    assert.ok(m, `${u} does not name its Markdown twin`);
    // And it must point at the URL the server actually serves: /foo.html -> /foo.md, / -> /index.md.
    const expected = u === '/' ? '/index.md'
      : (u.endsWith('/') ? `${u}index.md` : `${u.replace(/\.html$/, '')}.md`);
    assert.equal(m[1], `https://screentinker.com${expected}`, `${u} points at the wrong rendition`);
  }
});

test('the sitemap is not empty and every URL it advertises exists on disk', () => {
  assert.ok(urls.length > 0, 'sitemap.xml lists no URLs');
  for (const u of urls) {
    assert.ok(fs.existsSync(fileFor(u)), `sitemap advertises ${u} but ${fileFor(u)} is missing`);
  }
});

test('every advertised page has a title under the limit', () => {
  for (const u of urls) {
    const html = fs.readFileSync(fileFor(u), 'utf8');
    const m = html.match(/<title>([\s\S]*?)<\/title>/i);
    assert.ok(m, `${u} has no <title>`);
    const len = decode(m[1].trim()).length;
    assert.ok(len > 0 && len < TITLE_MAX, `${u} title is ${len} chars, must be under ${TITLE_MAX}`);
  }
});

test('every advertised page has a description that will not be truncated', () => {
  for (const u of urls) {
    const html = fs.readFileSync(fileFor(u), 'utf8');
    const m = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([\s\S]*?)["']/i);
    assert.ok(m, `${u} has no meta description, so the engine invents one`);
    const len = decode(m[1].trim()).length;
    assert.ok(len > 0 && len <= DESC_MAX, `${u} description is ${len} chars, must be <= ${DESC_MAX}`);
  }
});

test('every advertised page declares a canonical', () => {
  for (const u of urls) {
    const html = fs.readFileSync(fileFor(u), 'utf8');
    assert.match(html, /rel=["']canonical["']/i, `${u} has no canonical`);
  }
});
