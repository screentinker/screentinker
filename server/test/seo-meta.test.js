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

/* ─────────────── internal linking, structured data and uniqueness ─────────────── */

// Paths served by a route rather than a file under frontend/ (all of them exist in server.js).
const ROUTED = [/^\/app(\/|$|#)/, /^\/download(\/|$)/, /^\/player(\/|$)/, /^\/docs$/, /^\/templates$/,
  /^\/certified-hardware(\/submit)?$/, /^\/openapi\.yaml$/, /^\/\.well-known\//, /^\/mcp$/];

const pages = urls.map((u) => ({ u, html: fs.readFileSync(fileFor(u), 'utf8') }));
const linksOf = (html) => [...html.matchAll(/<a\b[^>]*href="(\/[^"]*)"/g)].map((m) => m[1].split('#')[0].split('?')[0] || '/');

test('every internal link on an advertised page resolves to a page we serve', () => {
  // A new page is only as good as the links into and out of it. A typo'd href answers 404 now
  // (CONTENT_PREFIXES), which a crawler records against the page that linked it.
  for (const { u, html } of pages) {
    for (const href of linksOf(html)) {
      if (ROUTED.some((re) => re.test(href))) continue;
      assert.ok(fs.existsSync(fileFor(href)), `${u} links ${href}, which does not exist`);
    }
  }
});

test('no orphan pages: every advertised page is linked from another advertised page', () => {
  const inbound = new Set();
  // /docs is the route that serves api-docs.html (server.js), and pages link the route.
  const ALIAS = { '/docs': '/api-docs.html' };
  for (const { u, html } of pages) for (const href of linksOf(html)) if (href !== u) inbound.add(ALIAS[href] || href);
  for (const { u } of pages) {
    if (u === '/') continue;
    assert.ok(inbound.has(u), `${u} is in the sitemap but no other page links to it`);
  }
});

test('titles and descriptions are unique across the sitemap', () => {
  const seen = { title: new Map(), desc: new Map() };
  for (const { u, html } of pages) {
    const t = decode((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
    const d = decode((html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([\s\S]*?)["']/i) || [])[1] || '').trim();
    assert.ok(!seen.title.has(t), `${u} shares its title with ${seen.title.get(t)}`);
    assert.ok(!seen.desc.has(d), `${u} shares its description with ${seen.desc.get(d)}`);
    seen.title.set(t, u); seen.desc.set(d, u);
  }
});

test('solutions and integrations pages: one H1, valid JSON-LD, breadcrumbs, and an FAQ that matches the page', () => {
  const subs = pages.filter(({ u }) => /^\/(solutions|integrations)\//.test(u));
  assert.ok(subs.filter(({ u }) => u.startsWith('/solutions/')).length >= 7, 'the solutions pages are in the sitemap');
  for (const { u, html } of subs) {
    assert.equal((html.match(/<h1\b/g) || []).length, 1, `${u} must have exactly one H1`);
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    assert.ok(blocks.some((b) => b['@type'] === 'BreadcrumbList'), `${u} has no BreadcrumbList`);
    const faq = blocks.find((b) => b['@type'] === 'FAQPage');
    if (u.endsWith('/')) continue; // a hub may or may not carry an FAQ
    assert.ok(faq, `${u} has no FAQPage`);
    // Every question in the structured data is a visible question on the page.
    const visible = [...html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)].map((m) => decode(m[1].replace(/<[^>]+>/g, '')).replace(/&rsquo;/g, '’').trim());
    for (const q of faq.mainEntity) {
      assert.ok(visible.some((v) => v.replace(/[’']/g, "'") === q.name.replace(/[’']/g, "'")), `${u}: FAQ "${q.name}" is not a visible question`);
    }
    // The primary call to action is the hosted trial.
    assert.match(html, /href="\/app#\/login" class="btn btn-primary"[^>]*>Start your free trial</, `${u} must end in the trial CTA`);
  }
});

test('every page that names our trial length names the one the server grants', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'middleware', 'subscription.js'), 'utf8');
  const days = Number(src.match(/const TRIAL_DAYS = (\d+);/)[1]);
  for (const { u, html } of pages) {
    for (const m of html.matchAll(/(\d+)-day (?:free )?Pro trial/g)) {
      assert.equal(Number(m[1]), days, `${u} offers a ${m[1]}-day Pro trial; the server grants ${days}`);
    }
  }
});
