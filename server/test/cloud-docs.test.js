'use strict';

/*
 * Cloud documents (widget_type 'cloud-doc', lib/cloud-docs.js): Google Slides/Docs/Sheets and
 * OneDrive/SharePoint embed links.
 *
 * What has to hold:
 *   - share, publish and embed links normalise to the provider's embed page, REBUILT from the id
 *   - only docs.google.com and Microsoft's Office hosts are accepted; look-alikes are refused
 *   - the render document runs no script, and says so in its CSP — which is what makes it safe for
 *     the web player to frame it with allow-same-origin (the only way Google's embed works)
 *   - a stored config is re-validated at render, and the API stores the normalised URL, never the
 *     pasted one
 */

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-clouddocs-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cd = require('../lib/cloud-docs');

const SLIDES_ID = '1EAYk18WDjIG-zp_0vLm3CsfQh_i8eXc67Jo2O9C6Vuc';

test('Google Slides: edit, view, present and embed links all become the looping embed', () => {
  for (const tail of ['edit#slide=id.p', 'view', 'present', 'embed?start=false', 'edit?usp=sharing']) {
    const n = cd.normaliseCloudDoc(`https://docs.google.com/presentation/d/${SLIDES_ID}/${tail}`, { delaySec: 7 });
    assert.equal(n.provider, 'google');
    assert.equal(n.kind, 'slides');
    assert.equal(n.url, `https://docs.google.com/presentation/d/${SLIDES_ID}/embed?start=true&loop=true&delayms=7000&rm=minimal`);
    assert.equal(n.refresh_min, 0, 'Slides advance themselves; no reload by default');
  }
  const pub = cd.normaliseCloudDoc('https://docs.google.com/presentation/d/e/2PACX-1vSomePublishedId_abcdEFGH/pub?start=false&loop=false');
  assert.equal(pub.url, 'https://docs.google.com/presentation/d/e/2PACX-1vSomePublishedId_abcdEFGH/embed?start=true&loop=true&delayms=10000&rm=minimal');
  assert.equal(cd.normaliseCloudDoc(`https://docs.google.com/presentation/d/${SLIDES_ID}/edit`, { delaySec: 99999 }).delay_sec, 3600);
});

test('Google Docs and Sheets: published and shared, keeping the sheet tab', () => {
  assert.equal(cd.normaliseCloudDoc(`https://docs.google.com/document/d/${SLIDES_ID}/edit`).url, `https://docs.google.com/document/d/${SLIDES_ID}/preview`);
  assert.equal(cd.normaliseCloudDoc('https://docs.google.com/document/d/e/2PACX-1vPublishedDocId1234/pub').url,
    'https://docs.google.com/document/d/e/2PACX-1vPublishedDocId1234/pub?embedded=true');
  assert.equal(cd.normaliseCloudDoc(`https://docs.google.com/spreadsheets/d/${SLIDES_ID}/edit?gid=42#gid=42`).url,
    `https://docs.google.com/spreadsheets/d/${SLIDES_ID}/preview?gid=42`);
  const pub = cd.normaliseCloudDoc('https://docs.google.com/spreadsheets/d/e/2PACX-1vPublishedSheet123/pubhtml?gid=7&single=true', { refreshMin: 2 });
  assert.equal(pub.url, 'https://docs.google.com/spreadsheets/d/e/2PACX-1vPublishedSheet123/pubhtml?widget=true&headers=false&gid=7');
  assert.equal(pub.refresh_min, 2);
  assert.equal(cd.normaliseCloudDoc(`https://docs.google.com/document/d/${SLIDES_ID}/edit`).refresh_min, 5, 'Docs reload every 5 minutes by default');
});

test('a pasted <iframe> embed code is read for its src', () => {
  const snippet = `<iframe src="https://docs.google.com/presentation/d/e/2PACX-1vPastedFromEmbedDlg/embed?start=false&amp;loop=false&amp;delayms=3000" frameborder="0" width="960" height="569" allowfullscreen="true"></iframe>`;
  assert.equal(cd.normaliseCloudDoc(snippet).url, 'https://docs.google.com/presentation/d/e/2PACX-1vPastedFromEmbedDlg/embed?start=true&loop=true&delayms=10000&rm=minimal');
});

test('only the providers: look-alike hosts, other sites, http and credentials are refused', () => {
  const refused = [
    'https://docs.google.com.evil.example/presentation/d/' + SLIDES_ID + '/edit',
    'https://evil.example/docs.google.com/presentation/d/' + SLIDES_ID,
    'https://drive.google.com/file/d/' + SLIDES_ID + '/view',
    'http://docs.google.com/presentation/d/' + SLIDES_ID + '/edit',
    'https://user:pw@docs.google.com/presentation/d/' + SLIDES_ID + '/edit',
    'https://docs.google.com/forms/d/' + SLIDES_ID + '/viewform',
    'https://docs.google.com/presentation/d/short/edit',
    'javascript:alert(1)',
    'https://evil.sharepoint.com.attacker.example/_layouts/15/Doc.aspx?sourcedoc=x',
    'https://contoso.sharepoint.com/:p:/s/team/EabcdefSharingLink',
    'https://onedrive.live.com/edit.aspx?resid=ABC',
    '',
  ];
  for (const u of refused) assert.throws(() => cd.normaliseCloudDoc(u), cd.CloudDocError, u);
});

test('Office: OneDrive and SharePoint embed links, and the Office viewer', () => {
  const od = cd.normaliseCloudDoc('https://onedrive.live.com/embed?resid=ABC%21123&authkey=%21XYZ&em=2&wdAr=1.7777');
  assert.equal(od.provider, 'microsoft');
  assert.equal(od.kind, 'slides');
  const sp = cd.normaliseCloudDoc('https://contoso.sharepoint.com/sites/Comms/_layouts/15/Doc.aspx?sourcedoc={1234}&action=default&file=Lobby.pptx');
  assert.equal(new URL(sp.url).searchParams.get('action'), 'embedview', 'a Doc.aspx link is shown as embedview');
  assert.equal(sp.kind, 'slides');
  const viewer = cd.normaliseCloudDoc('https://view.officeapps.live.com/op/view.aspx?src=https%3A%2F%2Fexample.org%2Fmenu.xlsx');
  assert.equal(new URL(viewer.url).pathname, '/op/embed.aspx');
  assert.equal(viewer.kind, 'sheet');
});

test('the render document runs no script, and frames only the providers', () => {
  const html = cd.renderCloudDoc({ url: `https://docs.google.com/presentation/d/${SLIDES_ID}/edit`, delay_sec: 5 });
  assert.ok(!/<script/i.test(html), 'no script element');
  assert.ok(!/\son\w+\s*=/i.test(html), 'no inline handlers');
  assert.match(html, /<iframe src="https:\/\/docs\.google\.com\/presentation\/d\/[^"]+\/embed\?start=true&amp;loop=true&amp;delayms=5000&amp;rm=minimal"/);
  assert.match(cd.RENDER_CSP, /script-src 'none'/);
  assert.match(cd.RENDER_CSP, /frame-src https:\/\/docs\.google\.com /);
  assert.ok(!/frame-src[^;]*\*(?!\.sharepoint)/.test(cd.RENDER_CSP), 'no wildcard frame-src beyond *.sharepoint.com');
  // Docs/Sheets reload by meta refresh, which needs no script.
  assert.match(cd.renderCloudDoc({ url: `https://docs.google.com/document/d/${SLIDES_ID}/edit`, refresh_min: 3 }), /http-equiv="refresh" content="180"/);
});

test('a stored config that is not valid (an import, a hand edit) renders a notice, not the URL', () => {
  const html = cd.renderCloudDoc({ url: 'https://evil.example/x', provider: 'google', kind: 'slides' });
  assert.ok(!html.includes('evil.example'));
  assert.match(html, /not valid/);
  assert.equal(cd.safeConfig({ url: 'https://docs.google.com/presentation/d/x"onload="alert(1)/edit' }), null);
});

/* ── through the API and the device payload ─────────────────────────────────────────────── */

const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const O = 'o-cd', WS = 'ws-cd', U = 'u-cd';
let server, base, token;

before(async () => {
  db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, 'cd@t.local', 'x', 'user')").run(U);
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(O, 'Org', U);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(WS, O, 'WS');
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')").run(WS, U);
  token = generateToken(db.prepare('SELECT * FROM users WHERE id = ?').get(U), WS);
  const app = express();
  app.use(express.json());
  app.use('/api/widgets', (req, res, next) => (/\/render$/.test(req.path) ? next() : requireAuth(req, res, () => resolveTenancy(req, res, next))), require('../routes/widgets'));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { try { server.close(); } catch { /* */ } });

const post = (body) => fetch(`${base}/api/widgets`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Workspace-Id': WS }, body: JSON.stringify(body) });

test('the API stores the normalised URL, refuses other hosts, and renders with the no-script CSP', async () => {
  const bad = await post({ widget_type: 'cloud-doc', name: 'x', config: { url: 'https://evil.example/deck' } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /docs\.google\.com/);

  const r = await post({ widget_type: 'cloud-doc', name: 'Lobby deck', config: { url: `https://docs.google.com/presentation/d/${SLIDES_ID}/edit?usp=sharing`, delay_sec: 8, injected: '<x>' } });
  assert.equal(r.status, 201);
  const w = await r.json();
  const stored = JSON.parse(db.prepare('SELECT config FROM widgets WHERE id = ?').get(w.id).config);
  assert.equal(stored.url, `https://docs.google.com/presentation/d/${SLIDES_ID}/embed?start=true&loop=true&delayms=8000&rm=minimal`);
  assert.equal(stored.injected, undefined, 'only known fields are stored');

  const page = await fetch(`${base}/api/widgets/${w.id}/render?rev=1`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'none'/);
  const html = await page.text();
  assert.ok(!/<script/i.test(html));
  assert.ok(html.includes('docs.google.com/presentation/d/'));

  // The payload tells the web player to frame THIS widget same-origin, and only this kind.
  const { __refreshWidgetRevs } = require('../ws/deviceSocket');
  const clock = await (await post({ widget_type: 'clock', name: 'Clock', config: {} })).json();
  const items = [{ widget_id: w.id }, { widget_id: clock.id }];
  __refreshWidgetRevs(items);
  assert.equal(items[0].widget_allow_same_origin, true);
  assert.equal(items[1].widget_allow_same_origin, false);
});
