'use strict';

/*
 * The machine-readable front door: what an automated client is told about this instance.
 *
 * Everything here describes capabilities this deployment ACTUALLY HAS. That is the whole design
 * rule. A discovery document is a promise an agent will act on — it will fetch the URL, attempt the
 * auth flow, call the endpoint — so advertising something we do not serve does not make us look
 * capable, it makes every agent that believes us fail in a way it cannot diagnose. Where we do not
 * have the thing, there is no file.
 */

const fs = require('fs');
const path = require('path');

function origin(req) {
  const configured = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  return `${req.protocol}://${req.get('host')}`;
}

/*
 * RFC 9727: /.well-known/api-catalog, a linkset naming the APIs this host offers.
 *
 * One API, described by the OpenAPI document we already publish and already lint in CI — so the
 * catalogue cannot describe an API that has drifted from its description without the build failing
 * first. `service-doc` is the human page, `service-desc` the machine contract; agents use the second
 * and people click the first.
 */
function apiCatalog(base) {
  return {
    linkset: [{
      anchor: `${base}/api`,
      'service-desc': [{ href: `${base}/openapi.yaml`, type: 'application/yaml',
        title: 'ScreenTinker Public API — OpenAPI 3 description' }],
      'service-doc': [{ href: `${base}/docs`, type: 'text/html',
        title: 'ScreenTinker Public API reference' }],
      'service-meta': [{ href: `${base}/.well-known/auth.md`, type: 'text/markdown',
        title: 'How to authenticate against the ScreenTinker API' }],
      // The MCP endpoint is part of this API's surface, so it belongs in the catalogue an agent reads
      // first rather than only in prose.
      related: [{ href: `${base}/mcp`, type: 'application/json',
        title: 'ScreenTinker MCP server — manage signage from an AI client' }],
      author: [{ href: 'https://github.com/screentinker/screentinker' }],
    }],
  };
}

/*
 * How an agent authenticates. Served as Markdown at /.well-known/auth.md because that is the format
 * the convention asks for and the format a model reads without a parser.
 *
 * ⚠️ EVERY CLAIM BELOW IS CHECKED AGAINST middleware/apiToken.js AND config/api-surface.js. The
 * limits are the interesting part and the part worth being precise about: a token that is told it can
 * do more than it can produces an agent that retries a 401 forever.
 */
function authMarkdown(base) {
  return `# Authenticating with the ScreenTinker API

ScreenTinker uses **scoped personal access tokens**. There is no OAuth flow, no client registration,
and no way for an agent to obtain a token on its own — a human creates one in the dashboard and gives
it to you. If you do not have one, stop here and ask for one.

## Presenting a token

    Authorization: Bearer st_...

Tokens begin with \`st_\`. The API description is at ${base}/openapi.yaml and the
rendered reference at ${base}/docs.

## What a token can do

A token is bound to **one workspace** and carries **one scope**:

| scope | meaning |
| --- | --- |
| \`read\` | GET only |
| \`write\` | GET plus create and update |
| \`full\` | the above plus delete |

## What a token can never do

A token authenticates as its owner but is forced to the lowest platform role, so it is **not** a way
to reach an administrative surface. These are unreachable with any token, by construction rather than
by a permission check: platform administration, authentication and account management, billing,
workspace and organisation management, and provisioning.

It also cannot cross a workspace boundary: the workspace is fixed when the token is created.

## Rate limits and failure

- \`401\` — missing, malformed, revoked, or a token presented to a surface tokens cannot reach.
- \`403\` — a valid token whose scope does not permit the method.

A \`401\` from an endpoint you believe you should reach is far more likely to mean "tokens cannot
reach this endpoint at all" than "your token is wrong". Retrying will not fix it.

## Getting a token

Sign in to the dashboard, open **Settings → API tokens**, create one, and copy it — the value is shown
once and stored only as a hash.

## Managing signage from an AI client

This instance runs a **Model Context Protocol server** at \`${base}/mcp\`. Point an MCP-capable client
at that URL with the same \`Authorization: Bearer st_...\` header and it gets a curated set of tools
rather than 133 raw endpoints. ⚠️ The tool list is filtered by the token's scope: a \`read\` token is
never shown a tool that writes.

## Self-hosted instances

ScreenTinker is open source and commonly self-hosted, so this document describes **this** instance at
${base}. Another deployment may be a different version with a different set of endpoints; read its own
\`${base}/openapi.yaml\` rather than assuming ours.
`;
}

/*
 * The Link header set for a public HTML page.
 *
 * Link headers are how a client that has fetched one URL learns about the rest without guessing at
 * well-known paths. The markdown alternate is the load-bearing one for an agent: it says "there is a
 * plain-text form of this exact page, here", which is cheaper for it to read and cheaper for us to
 * serve than the full document.
 */
function linkHeader(base, { markdownOf = null } = {}) {
  const links = [
    `<${base}/.well-known/api-catalog>; rel="api-catalog"`,
    `<${base}/openapi.yaml>; rel="service-desc"; type="application/yaml"`,
    `<${base}/docs>; rel="service-doc"; type="text/html"`,
    `<${base}/llms.txt>; rel="describedby"; type="text/plain"`,
  ];
  if (markdownOf) {
    links.unshift(`<${base}${markdownOf}>; rel="alternate"; type="text/markdown"`);
  }
  return links.join(', ');
}

/*
 * Does this request want Markdown?
 *
 * ⚠️ A BROWSER SENDS `Accept: text/html,...,*​/*;q=0.8`, and that trailing wildcard matches
 * text/markdown. Treating any match as a yes would serve Markdown to every human visitor. So the
 * test is comparative: markdown must be asked for EXPLICITLY and must outrank text/html.
 */
function prefersMarkdown(accept) {
  // Parsed, not pattern-matched: an Accept header is a list with parameters, and the q values are the
  // whole question here. A regex over the raw string got the escaping wrong and quietly answered
  // "no" to every request, which looks exactly like the feature not being deployed.
  const entries = String(accept || '').toLowerCase().split(',').map((part) => {
    const [type, ...params] = part.trim().split(';').map((x) => x.trim());
    const qParam = params.find((p) => p.startsWith('q='));
    const q = qParam ? parseFloat(qParam.slice(2)) : 1;
    return { type, q: Number.isFinite(q) ? q : 1 };
  }).filter((e) => e.type);

  const qOf = (t) => {
    const hit = entries.find((e) => e.type === t);
    return hit ? hit.q : -1;
  };
  const md = Math.max(qOf('text/markdown'), qOf('text/x-markdown'));
  // ⚠️ Must be asked for EXPLICITLY. A browser sends `*/*;q=0.8`, which matches text/markdown by the
  // wildcard — honouring that would serve Markdown to every human visitor.
  if (md <= 0) return false;
  return md >= qOf('text/html');
}

/* The pages that have a Markdown rendition: our own published HTML, nothing else. */
function markdownSource(frontendDir, urlPath) {
  // Strip the extension we added, then resolve inside frontendDir only.
  const rel = urlPath.replace(/\.md$/, '');
  /*
   * ⚠️ `/` AND `/index` BOTH MEAN THE LANDING PAGE, NOT index.html. On this site index.html is the
   * dashboard SPA shell — a few hundred bytes of module loader with no prose in it — and `/` is
   * served from landing.html. Resolving `/index.md` by filename would hand an agent the app shell and
   * call it our homepage.
   */
  if (rel === '/' || rel === '' || rel === '/index') {
    const landing = path.join(frontendDir, 'landing.html');
    try { return fs.statSync(landing).isFile() ? landing : null; } catch (e) { return null; }
  }
  if (/^\/index(\.html)?$/.test(rel)) return null;
  const bare = rel.replace(/^\/+/, '');
  // A trailing slash is a directory index (/integrations/ -> integrations/index.html). Without this
  // the section landing pages are the only published pages with no Markdown rendition, which is both
  // arbitrary and invisible.
  const candidates = rel.endsWith('/')
    ? [bare + 'index.html']
    : [bare + '.html', bare, bare + '/index.html'];
  for (const c of candidates) {
    if (c.includes('..') || c.includes('\0')) return null;
    const full = path.join(frontendDir, c);
    // Containment check: path.join collapses traversal, so compare the resolved prefix.
    if (!full.startsWith(path.resolve(frontendDir) + path.sep)) return null;
    try {
      if (fs.statSync(full).isFile() && full.endsWith('.html')) return full;
    } catch (e) { /* next candidate */ }
  }
  return null;
}

module.exports = { origin, apiCatalog, authMarkdown, linkHeader, prefersMarkdown, markdownSource };
