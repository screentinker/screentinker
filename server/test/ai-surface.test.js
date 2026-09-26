'use strict';

/*
 * The machine-readable front door: discovery documents, content negotiation, and the Markdown
 * rendition of our own pages.
 *
 * ⚠️ THE RULE THIS FILE ENFORCES IS "ADVERTISE ONLY WHAT WE SERVE". A discovery document is a promise
 * an agent acts on — it fetches the URL, attempts the flow, calls the endpoint. Advertising a
 * capability this deployment does not have produces agents that fail in a way they cannot diagnose,
 * which is worse for us than not appearing capable at all.
 *
 * The second rule is that a BROWSER MUST NEVER GET MARKDOWN. Browsers send `*​/*;q=0.8`, which matches
 * text/markdown; honouring a wildcard would serve plain text to every human visitor on the site.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ai = require('../lib/ai-surface');
const md = require('../lib/markdown-rendition');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const BASE = 'https://screentinker.com';

// ───────────────────────────── protected resource metadata ─────────────────────────────

test('⚠️ the resource metadata advertises only scopes a token can actually be minted with', () => {
  /*
   * RFC 9728. A document that offers a scope the minting code rejects is worse than one that says
   * nothing: a client asks for it and is refused with no way to tell that the ADVERTISEMENT was
   * wrong rather than its request. Both sides read lib/api-scopes.js, and this asserts the route
   * that mints tokens still does.
   */
  const { SCOPES } = require('../lib/api-scopes');
  const doc = ai.protectedResourceMetadata(BASE);
  assert.deepEqual(doc.scopes_supported, [...SCOPES]);
  const tokensSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tokens.js'), 'utf8');
  assert.match(tokensSrc, /require\('\.\.\/lib\/api-scopes'\)/,
    'tokens.js must mint against the same list the metadata publishes');
  assert.ok(!/const SCOPES = \[/.test(tokensSrc), 'tokens.js must not keep a second copy');
});

test('⚠️ the resource metadata claims no authorization server, because there is none', () => {
  /*
   * `authorization_servers` is OPTIONAL in RFC 9728 and this resource delegates to nothing: no
   * /authorize, no /token, and sessions are signed with a symmetric secret so there is no key a
   * jwks_uri could serve. Naming an issuer would send a client into a redirect dance ending at a
   * 404 — the wasted-retries failure the auth guide exists to prevent. Everything true is published.
   */
  const doc = ai.protectedResourceMetadata(BASE);
  assert.ok(!('authorization_servers' in doc), 'do not name an authorization server we do not have');
  assert.ok(!('jwks_uri' in doc), 'there is no public key to publish; sessions are HMAC-signed');
  assert.equal(doc.resource, BASE);
  assert.deepEqual(doc.bearer_methods_supported, ['header']);
  assert.equal(doc.resource_documentation, `${BASE}/auth.md`,
    'a reader that finds no authorization server must be sent to the prose');
});

test('⚠️ a 401 says where to read about the resource', () => {
  // RFC 9728 §5.1. Without it, an agent that arrives with no credential can only probe blindly,
  // which is exactly what the auth guide is written to stop. One builder, so the API and the MCP
  // endpoint cannot disagree about the pointer.
  const authSrc = fs.readFileSync(path.join(__dirname, '..', 'middleware', 'auth.js'), 'utf8');
  assert.match(authSrc, /function wwwAuthenticate\(req\)/);
  assert.match(authSrc, /resource_metadata="\$\{base\}\/\.well-known\/oauth-protected-resource"/);
  assert.match(authSrc, /module\.exports = \{ wwwAuthenticate,/);
  const mcpSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'mcp.js'), 'utf8');
  assert.match(mcpSrc, /wwwAuthenticate\(req\)/, 'the MCP 401 must use the shared builder');
  assert.ok(!/realm="ScreenTinker", error="invalid_token"'/.test(mcpSrc),
    'the MCP route must not hand-roll its own header');
});

// ───────────────────────────── auth.md discovery ─────────────────────────────

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('⚠️ auth.md is served from the service ROOT, not only from /.well-known', () => {
  /*
   * The convention puts this document at /auth.md. We published only the well-known copy, so a
   * scanner asking for /auth.md got the SPA shell — 200, text/html, 21 KB — and recorded the
   * instance as not supporting the standard at all. A soft-404 is indistinguishable from a wrong
   * answer to anything that is not a browser.
   */
  assert.match(SERVER_SRC, /app\.get\('\/auth\.md', serveAuthMarkdown\)/);
  assert.match(SERVER_SRC, /app\.get\('\/\.well-known\/auth\.md', serveAuthMarkdown\)/);
  // One handler, so the two copies cannot drift into disagreeing about how to authenticate.
  assert.equal((SERVER_SRC.match(/const serveAuthMarkdown =/g) || []).length, 1);
});

test('⚠️ the auth.md H1 names the document, because that is what identifies it', () => {
  // Scanners key on the heading as well as the path. "Authenticating with the ScreenTinker API"
  // reads as a page that happens to be about auth, not as the document the convention defines.
  const h1 = ai.authMarkdown(BASE).split('\n')[0];
  assert.match(h1, /^# /);
  assert.match(h1, /auth\.md/i, 'the H1 must contain "auth.md"');
});

test('⚠️ with no OAuth, auth.md has to be self-contained', () => {
  /*
   * This instance has no authorization server, so there is no protected-resource metadata to point
   * at and inventing some would be worse than silence. Everything an agent needs is therefore in
   * this one document: who it is for, how to get a credential, the one supported method, and what
   * to do when it has none.
   */
  const doc = ai.authMarkdown(BASE);
  assert.match(doc, /\*\*Audience:\*\*/, 'it must say who it is for');
  assert.match(doc, /## Registration/);
  assert.match(doc, /no programmatic registration endpoint/i);
  assert.match(doc, /bearer/i, 'it must name the supported method');
  assert.match(doc, new RegExp(`${BASE}/app#/settings`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'it must name the human provisioning surface');
  assert.match(doc, /Authorization: Bearer st_/, 'it must show how the credential is used');
  // ⚠️ And it must NOT claim an OAuth capability this deployment does not have.
  assert.ok(!/oauth-protected-resource|authorization_servers/.test(doc),
    'do not advertise OAuth metadata that is not published');
});

test('⚠️ an unknown /.well-known path 404s instead of returning the app shell', () => {
  /*
   * Everything under /.well-known is machine-read and the SPA catch-all answers any unmatched path
   * with index.html and a 200 — so /.well-known/oauth-protected-resource replied with 21 KB of HTML
   * and a success code. "We do not do OAuth" is a useful answer that only a 404 conveys.
   */
  assert.match(SERVER_SRC, /app\.all\('\/\.well-known\/\*'/);
  const guard = SERVER_SRC.indexOf("app.all('/.well-known/*'");
  // After the real routes, or it would swallow them.
  assert.ok(SERVER_SRC.indexOf("app.get('/.well-known/api-catalog'") < guard);
  assert.ok(SERVER_SRC.indexOf("app.get('/.well-known/auth.md', serveAuthMarkdown)") < guard);
  // Before the SPA catch-all, or the shell answers first and the guard never runs.
  assert.ok(guard < SERVER_SRC.lastIndexOf("app.get('*'"));
  /*
   * ⚠️ AND AFTER express.static. Above it, this would have swallowed
   * /.well-known/acme-challenge/... — certbot's webroot proof of domain control — so a self-hoster's
   * TLS renewal would fail silently and the certificate would expire sixty days later, nowhere near
   * this code. Anything real has already answered by the time the guard runs.
   */
  assert.ok(SERVER_SRC.indexOf('express.static(config.frontendDir') < guard,
    'the /.well-known guard must sit below express.static or it breaks ACME renewal');
});

test('the discovery documents point at the root copy we actually serve', () => {
  const cat = ai.apiCatalog(BASE).linkset[0];
  assert.equal(cat['service-meta'][0].href, `${BASE}/auth.md`);
  assert.match(ai.linkHeader(BASE), /<https:\/\/screentinker\.com\/auth\.md>; rel="service-meta"/);
});

// ───────────────────────────── content negotiation ─────────────────────────────

test('a browser never gets Markdown', () => {
  // The real header Chrome, Firefox and Safari send. The trailing wildcard matches text/markdown.
  const browser = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
  assert.equal(ai.prefersMarkdown(browser), false);
  assert.equal(ai.prefersMarkdown('*/*'), false);
  assert.equal(ai.prefersMarkdown(''), false);
  assert.equal(ai.prefersMarkdown(undefined), false);
});

test('markdown is served only when asked for explicitly and preferred', () => {
  assert.equal(ai.prefersMarkdown('text/markdown'), true);
  assert.equal(ai.prefersMarkdown('text/x-markdown'), true, 'the older spelling');
  assert.equal(ai.prefersMarkdown('text/markdown;q=0.9,text/html;q=0.8'), true);
  assert.equal(ai.prefersMarkdown('text/markdown,text/html'), true, 'equal q, both named');
  // Asked for, but ranked BELOW html: the client would rather have the page.
  assert.equal(ai.prefersMarkdown('text/html,text/markdown;q=0.5'), false);
  // q=0 is a refusal, not a request.
  assert.equal(ai.prefersMarkdown('text/markdown;q=0'), false);
});

// ───────────────────────────── which pages have a rendition ─────────────────────────────

test('published pages resolve, including directory indexes', () => {
  assert.ok(ai.markdownSource(FRONTEND, '/guides/brightsign-digital-signage.md'));
  assert.ok(ai.markdownSource(FRONTEND, '/certified-hardware.md'));
  assert.ok(ai.markdownSource(FRONTEND, '/integrations/'), 'a section index is a published page too');
  assert.ok(ai.markdownSource(FRONTEND, '/legal/terms.md'));
});

test('⚠️ / and /index mean the LANDING page, not the dashboard shell', () => {
  // index.html is the SPA shell: a module loader with no prose in it. Resolving /index.md by filename
  // would hand an agent that file and call it our homepage.
  const home = ai.markdownSource(FRONTEND, '/');
  assert.ok(home.endsWith('landing.html'));
  assert.equal(ai.markdownSource(FRONTEND, '/index.md'), home);
  assert.equal(ai.markdownSource(FRONTEND, '/index.html'), null, 'the app shell is not a document');
});

test('nothing outside frontendDir is reachable', () => {
  for (const p of ['/../../etc/passwd.md', '/../server/config.js.md', '/..%2f..%2fetc%2fpasswd.md',
                   '/guides/../../../server/server.js.md', '/\0.md']) {
    assert.equal(ai.markdownSource(FRONTEND, p), null, `must refuse ${p}`);
  }
});

test('a page that does not exist resolves to nothing rather than an empty document', () => {
  assert.equal(ai.markdownSource(FRONTEND, '/no-such-page.md'), null);
});

// ───────────────────────────── the rendition itself ─────────────────────────────

const GUIDE = fs.readFileSync(path.join(FRONTEND, 'guides', 'brightsign-digital-signage.html'), 'utf8');
const RENDERED = md.toMarkdown(GUIDE, { url: `${BASE}/guides/brightsign-digital-signage.html`, origin: BASE });

test('⚠️ links survive, as absolute URLs', () => {
  /*
   * The first version stripped tags before converting inline markup, so every link inside a paragraph
   * became bare text with a stray space where the anchor had been. The document read perfectly well
   * and had no links in it — the failure nobody notices in review.
   *
   * Absolute, because a rendition is read away from the page it came from, often by something that
   * will never issue a second request to resolve a relative path.
   */
  const links = [...RENDERED.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)];
  assert.ok(links.length >= 5, `expected the guide's links, found ${links.length}`);
  for (const [, label, href] of links) {
    assert.ok(label.trim(), 'a link with no text is a link nobody can follow');
    assert.ok(/^(https?:\/\/|#)/.test(href), `relative link survived: ${href}`);
  }
  assert.ok(links.some(([, , h]) => h === `${BASE}/download/`), 'the downloads link is absolute');
});

test('structure survives: headings, lists, code and the table', () => {
  assert.match(RENDERED, /^# BrightSign Digital Signage CMS Setup/m, 'the title, without the suffix');
  assert.match(RENDERED, /^> Use a BrightSign player/m, 'the description as a blockquote');
  assert.match(RENDERED, new RegExp(`^Source: ${BASE.replace(/\//g, '\\/')}`, 'm'));
  assert.match(RENDERED, /^## /m);
  assert.match(RENDERED, /^- /m, 'list items');
  assert.match(RENDERED, /`roHtmlWidget`/, 'inline code');
  assert.match(RENDERED, /^\| .* \| .* \|$/m, 'the command-parity table');
  assert.match(RENDERED, /```/, 'the provisioning JSON block');
});

test('nav, footer, scripts and inline SVG are gone', () => {
  // The chrome is identical on every page; repeating it in every rendition is most of the bytes and
  // none of the content.
  assert.ok(!/Sign In/.test(RENDERED), 'nav links');
  assert.ok(!/All rights reserved/.test(RENDERED), 'footer');
  assert.ok(!/<svg|viewBox|<script|application\/ld\+json/.test(RENDERED), 'markup that is not prose');
  assert.ok(!/<[a-z][^>]*>/i.test(RENDERED), `raw HTML survived: ${(RENDERED.match(/<[a-z][^>]*>/i) || [])[0]}`);
});

test('entities are decoded, including the ones this site actually uses', () => {
  assert.equal(md.decodeEntities('a &middot; b'), 'a · b');
  assert.equal(md.decodeEntities('&mdash;&rarr;&copy;&deg;&bull;'), '—→©°•');
  assert.equal(md.decodeEntities('5 &lt; 6 &amp;&amp; 7 &gt; 6'), '5 < 6 && 7 > 6');
  // ⚠️ Ampersand last: decoding it first turns "&amp;lt;" into "<" and invents a tag.
  assert.equal(md.decodeEntities('&amp;lt;script&amp;gt;'), '&lt;script&gt;');
  assert.ok(!/&[a-z]+;/.test(RENDERED), `an undecoded entity reached the output: ${(RENDERED.match(/&[a-z]+;/) || [])[0]}`);
});

test('the homepage renders as prose, not as a script dump', () => {
  const home = md.toMarkdown(fs.readFileSync(path.join(FRONTEND, 'landing.html'), 'utf8'),
    { url: BASE + '/', origin: BASE });
  assert.match(home, /Flat price, any screen/);
  assert.match(home, /digital signage CMS/);
  // The landing page carries JSON-LD and a pricing fetch; neither is prose.
  assert.ok(!/@context|fetch\(|function /.test(home), 'script content leaked into the rendition');
  assert.ok(home.length > 2000 && home.length < 60000, `implausible size: ${home.length}`);
});

// ───────────────────────────── the discovery documents ─────────────────────────────

test('the API catalogue points only at things we serve', () => {
  const cat = ai.apiCatalog(BASE);
  const entry = cat.linkset[0];
  assert.equal(entry['service-desc'][0].href, `${BASE}/openapi.yaml`);
  assert.equal(entry['service-doc'][0].href, `${BASE}/docs`);
  // Each local href must correspond to a route that exists in server.js.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const hrefs = JSON.stringify(cat).match(new RegExp(`${BASE}/[^"]*`, 'g')) || [];
  for (const href of hrefs) {
    const p = href.slice(BASE.length);
    // A path is served either by a handler (app.get) or by a mounted router (app.use) — /mcp is the
    // second. Accept both, or the test refuses a URL that is demonstrably live.
    const esc = p.replace(/\//g, '\\/');
    assert.ok(
      new RegExp(`app\\.(get|use)\\(\\s*\\[?'${esc}'`).test(server),
      `the catalogue advertises ${p}, which no route serves`
    );
  }
  // And the OpenAPI file it names is really there — CI lints it, so it cannot silently rot.
  assert.ok(fs.existsSync(path.join(__dirname, '..', '..', 'docs', 'openapi.yaml')));
});

test('auth.md describes the auth we actually implement, and says what is impossible', () => {
  const doc = ai.authMarkdown(BASE);
  const tokenSrc = fs.readFileSync(path.join(__dirname, '..', 'middleware', 'apiToken.js'), 'utf8');

  // The prefix and header shape must match the middleware, or every agent that reads this fails 401.
  assert.match(doc, /Authorization: Bearer st_/);
  assert.match(tokenSrc, /TOKEN_PREFIX = 'st_'/);
  for (const scope of ['read', 'write', 'full']) assert.ok(doc.includes('`' + scope + '`'));

  // ⚠️ The most useful sentence in the document is the one saying an agent CANNOT get a token. Without
  // it, a capable agent burns its retries hunting for a registration endpoint that does not exist.
  assert.match(doc, /no OAuth flow/i);
  assert.match(doc, /no way for an agent to obtain a token on its own/i);
  assert.match(doc, /A `401` from an endpoint you believe you should reach/);
  // And it must not promise a flow we do not run.
  assert.ok(!/client_credentials|\/oauth\/token|dynamic client registration/i.test(doc));
});

test('the Link header advertises the catalogue, the spec and the rendition', () => {
  const plain = ai.linkHeader(BASE);
  assert.match(plain, /rel="api-catalog"/);
  assert.match(plain, /rel="service-desc"/);
  assert.match(plain, /rel="service-doc"/);
  assert.match(plain, /rel="describedby"/);
  assert.ok(!/rel="alternate"/.test(plain), 'no markdown alternate for a page that has none');

  const withMd = ai.linkHeader(BASE, { markdownOf: '/guides/x.md' });
  assert.match(withMd, /<https:\/\/screentinker\.com\/guides\/x\.md>; rel="alternate"; type="text\/markdown"/);
  // Every URI reference in a Link header is angle-bracketed; an unbracketed one is silently dropped.
  for (const part of withMd.split(', ')) assert.match(part, /^<[^>]+>;/, `not bracketed: ${part}`);
});

// ───────────────────────────── robots.txt ─────────────────────────────

test('robots.txt declares Content Signals without losing a single existing directive', () => {
  const robots = fs.readFileSync(path.join(FRONTEND, 'robots.txt'), 'utf8');
  assert.match(robots, /^Content-Signal: search=yes, ai-input=yes, ai-train=yes$/m);
  // ⚠️ The signal must appear INSIDE the User-agent group as well as at the top: a parser that only
  // reads groups would otherwise never see it.
  const group = robots.slice(robots.indexOf('User-agent: *'));
  assert.match(group, /^Content-Signal:/m);

  // The directives that were already there are what keeps crawlers out of the app surfaces.
  for (const d of ['User-agent: *', 'Allow: /', 'Disallow: /api/', 'Disallow: /app',
                   'Disallow: /player', 'Disallow: /uploads/', 'Sitemap: https://screentinker.com/sitemap.xml']) {
    assert.ok(robots.includes(d), `robots.txt lost: ${d}`);
  }
});

test('llms.txt names the guides that exist and no others', () => {
  const llms = fs.readFileSync(path.join(FRONTEND, 'llms.txt'), 'utf8');
  const guides = (llms.match(/https:\/\/screentinker\.com\/guides\/[a-z0-9-]+\.html/g) || [])
    .map((u) => u.split('/').pop());
  assert.ok(guides.length >= 9, `expected every guide to be listed, found ${guides.length}`);
  for (const g of new Set(guides)) {
    assert.ok(fs.existsSync(path.join(FRONTEND, 'guides', g)), `llms.txt links a guide that does not exist: ${g}`);
  }
  // And the reverse: a guide nobody links from here is a guide an agent will not find.
  for (const f of fs.readdirSync(path.join(FRONTEND, 'guides')).filter((f) => f.endsWith('.html'))) {
    assert.ok(guides.includes(f), `llms.txt does not mention guides/${f}`);
  }
  assert.match(llms, /Accept: text\/markdown/, 'it should say how to get the plain-text form');
});
