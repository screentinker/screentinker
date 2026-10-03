'use strict';

/*
 * A slide's photo may only ever come from the slide's OWN workspace.
 *
 * ⚠️ WHY THIS NEEDS A TEST AT ALL: `content_id` is not chosen by the server. It sits in a config
 * blob authored by a workspace editor, so it is a value a person typed — and nothing stops that
 * person pasting an id belonging to another tenant. A resolver that simply looked the row up would
 * then embed another customer's media in their slide and serve it from this origin, under a URL
 * that looks entirely legitimate. The lookup carries the workspace in its WHERE clause for exactly
 * that reason, and this is what stops that clause being "simplified" later.
 *
 * A widget with no workspace is a PLATFORM TEMPLATE, so it is held to the matching rule — platform
 * content only — rather than being treated as unscoped, which would be the worse reading.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-slide-scope';

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE widgets (id TEXT PRIMARY KEY, widget_type TEXT, config TEXT, workspace_id TEXT);
  CREATE TABLE content (id TEXT PRIMARY KEY, filepath TEXT, remote_url TEXT, workspace_id TEXT);
`);
const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

const express = require('express');
const widgetsRouter = require('../routes/widgets');
const app = express();
app.use('/api/widgets', widgetsRouter);
const server = app.listen(0);
let base;
test.before(async () => {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  base = `http://127.0.0.1:${server.address().port}`;

  db.prepare('INSERT INTO content (id, filepath, remote_url, workspace_id) VALUES (?,?,?,?)')
    .run('c-ours', 'ours.jpg', null, 'ws-a');
  db.prepare('INSERT INTO content (id, filepath, remote_url, workspace_id) VALUES (?,?,?,?)')
    .run('c-theirs', 'theirs.jpg', null, 'ws-b');
  db.prepare('INSERT INTO content (id, filepath, remote_url, workspace_id) VALUES (?,?,?,?)')
    .run('c-platform', 'platform.jpg', null, null);
  db.prepare('INSERT INTO content (id, filepath, remote_url, workspace_id) VALUES (?,?,?,?)')
    .run('c-remote', null, 'https://cdn.example/x.jpg', 'ws-a');
  // A row that exists and points at nothing. Not hypothetical: an upload that failed partway, or a
  // row whose file was cleaned up underneath it, both look like this.
  db.prepare('INSERT INTO content (id, filepath, remote_url, workspace_id) VALUES (?,?,?,?)')
    .run('c-empty', null, null, 'ws-a');
});
test.after(() => { server.close(); db.close(); });

function seedSlide(id, workspaceId, contentId) {
  db.prepare('INSERT INTO widgets (id, widget_type, config, workspace_id) VALUES (?,?,?,?)').run(
    id, 'slide', JSON.stringify({
      template: { background: '#101820', elements: [
        { slot: 'photo', kind: 'image', box: { x: 0, y: 0, w: 50, h: 50 }, content_id: contentId },
        { slot: 'head', kind: 'head', box: { x: 5, y: 60, w: 60 }, style: { size_cqw: 6 },
          motion: { animation: 'slideU', delay: 0.2, duration: 0.5 } },
      ] },
      fields: { head: 'Kenosha North' },
    }), workspaceId);
}
const render = async (id) => (await fetch(`${base}/api/widgets/${id}/render`)).text();

test('a slide shows a photo from its own workspace', async () => {
  seedSlide('w-own', 'ws-a', 'c-ours');
  const html = await render('w-own');
  assert.match(html, /<img src="\/uploads\/content\/ours\.jpg"/);
  assert.match(html, /Kenosha North/);
});

test("⚠️ a slide CANNOT show another workspace's photo, even naming its id exactly", async () => {
  seedSlide('w-cross', 'ws-a', 'c-theirs');
  const html = await render('w-cross');
  assert.ok(!html.includes('theirs.jpg'), "another tenant's media was embedded");
  assert.match(html, /class="ph"/, 'it should degrade to the placeholder, not vanish');
  // ...and the rest of the slide still renders. A refused image must not take the slide down.
  assert.match(html, /Kenosha North/);
});

test('⚠️ a platform template may use platform content and NOT a tenant’s', async () => {
  seedSlide('w-plat-ok', null, 'c-platform');
  assert.match(await render('w-plat-ok'), /platform\.jpg/);

  seedSlide('w-plat-bad', null, 'c-ours');
  const html = await render('w-plat-bad');
  assert.ok(!html.includes('ours.jpg'), 'a platform template reached into a workspace');
  assert.match(html, /class="ph"/);
});

test('⚠️ a workspace slide cannot reach platform content by id either', async () => {
  // The scoping is an equality, not a "mine or global" fallback. If platform media should be
  // usable in tenant slides, that is a deliberate feature with its own rules — not a side effect
  // of a loose WHERE clause.
  seedSlide('w-reach', 'ws-a', 'c-platform');
  const html = await render('w-reach');
  assert.ok(!html.includes('platform.jpg'));
  assert.match(html, /class="ph"/);
});

test('remote_url content resolves to its URL rather than a local path', async () => {
  seedSlide('w-remote', 'ws-a', 'c-remote');
  const html = await render('w-remote');
  assert.match(html, /src="https:\/\/cdn\.example\/x\.jpg"/);
  assert.ok(!html.includes('/uploads/content/null'), 'a null filepath produced a bogus local URL');
});

test('⚠️ a content row pointing at nothing is a placeholder, not a URL ending in "null"', async () => {
  /*
   * The row EXISTS, so the lookup succeeds and the scoping check passes — this is past every guard
   * above. Without the filepath test the resolver happily builds `/uploads/content/null`, which the
   * player then requests, gets the SPA fallback for, and renders as a broken image. A mutation run
   * found this: the earlier version of this file only ever exercised rows that had one or the other.
   */
  seedSlide('w-empty', 'ws-a', 'c-empty');
  const html = await render('w-empty');
  assert.ok(!/uploads\/content\/(null|undefined)/.test(html),
    'a row with no file produced a local URL anyway');
  assert.ok(!html.includes('<img'), 'an image element was emitted with nothing behind it');
  assert.match(html, /class="ph"/);
});

test('an unknown content id is a placeholder, not an error page', async () => {
  seedSlide('w-missing', 'ws-a', 'c-nope');
  const html = await render('w-missing');
  assert.match(html, /class="ph"/);
  assert.match(html, /Kenosha North/);
});

test('⚠️ the slide type is actually reachable through the render endpoint', async () => {
  /*
   * Guards the wiring, not the renderer. A widget_type with no case in renderWidgetHtml falls
   * through to "Unknown widget" — which is how a feature ships looking complete and does nothing,
   * and this codebase has done exactly that more than once (the device command route, setNodeName).
   */
  seedSlide('w-wired', 'ws-a', 'c-ours');
  const html = await render('w-wired');
  assert.ok(!html.includes('Unknown widget'), 'slide is not wired into the render dispatch');
  assert.match(html, /container-type:\s*size/);
  assert.match(html, /@keyframes st-slide-u/);
});
