'use strict';

// Guards the boundary added on top of #254 (org-level widget sandbox toggle).
//
// #254 let an org opt out of widget iframe isolation so PLAYERS can embed
// origin-strict third-party sites. As merged it applied the same opt-out to the
// widget editor's Preview — which is framed by the DASHBOARD, from the dashboard's
// own origin, where the admin's session JWT lives in localStorage. That turned
// "my kiosks are less isolated" into "anyone who can author a widget can lift the
// session of whichever admin clicks Preview" (workspace_editor and up; viewers are
// refused at the create route).
//
// These tests fail if the preview path ever consults the org setting again.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WIDGETS_ROUTE = fs.readFileSync(path.join(__dirname, '..', 'routes', 'widgets.js'), 'utf8');
const WIDGETS_VIEW = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'widgets.js'),
  'utf8'
);

// Body of a router handler, from its `router.<verb>('<route>'` to the next `router.`
function handlerBody(source, verb, route) {
  const start = source.indexOf(`router.${verb}('${route}'`);
  assert.notEqual(start, -1, `could not find router.${verb}('${route}') — test needs updating`);
  const rest = source.slice(start + 1);
  const end = rest.indexOf('\nrouter.');
  return end === -1 ? rest : rest.slice(0, end);
}

test('preview sandbox constant is the isolating one', () => {
  assert.match(
    WIDGETS_ROUTE,
    /const PREVIEW_IFRAME_SANDBOX = 'allow-scripts';/,
    'PREVIEW_IFRAME_SANDBOX must be exactly allow-scripts (no allow-same-origin)'
  );
});

for (const [verb, route] of [['post', '/preview'], ['post', '/preview-session']]) {
  test(`${verb.toUpperCase()} ${route} pins the isolating sandbox and ignores the org setting`, () => {
    const body = handlerBody(WIDGETS_ROUTE, verb, route);
    assert.match(body, /PREVIEW_IFRAME_SANDBOX/, `${route} must render with PREVIEW_IFRAME_SANDBOX`);
    assert.doesNotMatch(
      body,
      /widgetIframeSandboxForWorkspace/,
      `${route} must NOT consult the org widget-sandbox setting — it renders in the dashboard origin`
    );
  });
}

test('player render path still honours the org setting (the feature itself)', () => {
  const body = handlerBody(WIDGETS_ROUTE, 'get', '/:id/render');
  assert.match(
    body,
    /widgetIframeSandboxForWorkspace\(widget\.workspace_id\)/,
    'the /render path is what #254 is for — it must keep consulting the org setting'
  );
});

test('dashboard preview iframe is hard-coded to allow-scripts', () => {
  const iframeTag = WIDGETS_VIEW.match(/<iframe id="pvIframe"[^>]*>/);
  assert.ok(iframeTag, 'could not find the #pvIframe preview iframe — test needs updating');
  assert.match(iframeTag[0], /sandbox="allow-scripts"/, 'preview iframe must be statically sandboxed');
  assert.doesNotMatch(
    iframeTag[0],
    /allow-same-origin|\$\{/,
    'preview iframe sandbox must be a literal, not computed from the org setting'
  );
});

// The preview-session GET is unauthenticated and served from the dashboard's origin. The dashboard
// frames it sandboxed, but the URL can also be opened top-level, so the response has to carry the
// same sandbox itself.
test('preview-session GET carries a sandbox CSP for every non-cloud-doc preview', () => {
  const body = handlerBody(WIDGETS_ROUTE, 'get', '/preview-session/:id');
  assert.match(body, /else res\.setHeader\('Content-Security-Policy', `sandbox \$\{PREVIEW_IFRAME_SANDBOX\}`\)/,
    'GET /preview-session/:id must send `sandbox allow-scripts` when it is not a cloud-doc');
});
