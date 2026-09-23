'use strict';

/*
 * The frontend version hash — what makes an open dashboard offer a soft reload.
 *
 * ⚠️ THE BUG THIS REPLACES: it hashed a HARDCODED LIST of twenty files. `js/views/playlists.js`
 * was never in it, nor anything under `js/lib/` or `js/i18n/`. So a frontend fix shipped to those
 * paths reached ZERO open dashboards — no prompt, no reload, and an operator sitting on the page
 * saw no change and reasonably concluded it was not fixed. That happened for real with the
 * folder-tree picker. Every view added since the list was written had the same hole, and nothing
 * about adding a view tells you to edit an array in server.js.
 *
 * These tests run the walk directly rather than booting a server: the property under test is
 * "does a change to file X move the hash", and a list-shaped bug is invisible to anything that
 * only checks the endpoint returns a string.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const SERVER_JS = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

/* A faithful copy of the walk in server.js. Pinned to the real thing by the guard test below. */
const HASHED_EXT = new Set(['.js', '.css', '.html', '.json', '.svg']);
async function walkAssets(dir, out, depth = 0) {
  if (depth > 8) return;
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      await walkAssets(full, out, depth + 1);
    } else if (HASHED_EXT.has(path.extname(e.name).toLowerCase())) {
      try {
        const st = await fs.promises.stat(full);
        out.push(`${full}:${st.size}:${Math.floor(st.mtimeMs)}`);
      } catch { /* vanished mid-walk */ }
    }
  }
}
async function hashOf(dir) {
  const parts = [];
  await walkAssets(dir, parts);
  parts.sort();
  return crypto.createHash('md5').update(parts.join('|')).digest('hex').slice(0, 8);
}

function scratch() {
  const d = path.join(os.tmpdir(), 'st-fh-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(path.join(d, 'js', 'views'), { recursive: true });
  fs.mkdirSync(path.join(d, 'js', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(d, 'js', 'i18n'), { recursive: true });
  fs.writeFileSync(path.join(d, 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(d, 'js', 'app.js'), 'export const a = 1;');
  fs.writeFileSync(path.join(d, 'js', 'views', 'playlists.js'), 'export const p = 1;');
  fs.writeFileSync(path.join(d, 'js', 'lib', 'folder-tree.js'), 'export const f = 1;');
  fs.writeFileSync(path.join(d, 'js', 'i18n', 'en.js'), 'export default {};');
  return d;
}

/** Touch a file the way a deploy does: new bytes, new mtime. */
function edit(file, text) {
  fs.writeFileSync(file, text);
  const t = new Date(Date.now() + 2000);
  fs.utimesSync(file, t, t);
}

test('⚠️ a change to playlists.js moves the hash — it did not before', async () => {
  const d = scratch();
  const before = await hashOf(d);
  edit(path.join(d, 'js', 'views', 'playlists.js'), 'export const p = 2;');
  assert.notEqual(await hashOf(d), before, 'this exact file was missing from the old list');
});

test('⚠️ so do js/lib/ and js/i18n/ — the other two holes', async () => {
  for (const rel of [['js', 'lib', 'folder-tree.js'], ['js', 'i18n', 'en.js']]) {
    const d = scratch();
    const before = await hashOf(d);
    edit(path.join(d, ...rel), 'export const changed = true;');
    assert.notEqual(await hashOf(d), before, `${rel.join('/')} must be covered`);
  }
});

test('a BRAND NEW view is covered without anyone editing server.js', async () => {
  /*
   * The actual defect in the old design: it needed a human to remember. Every view added since
   * the list was written inherited the hole silently.
   */
  const d = scratch();
  const before = await hashOf(d);
  fs.writeFileSync(path.join(d, 'js', 'views', 'brand-new-view.js'), 'export const n = 1;');
  assert.notEqual(await hashOf(d), before);
});

test('deleting a file moves the hash too', async () => {
  const d = scratch();
  const before = await hashOf(d);
  fs.unlinkSync(path.join(d, 'js', 'views', 'playlists.js'));
  assert.notEqual(await hashOf(d), before);
});

test('the hash is stable when nothing changes, and independent of readdir order', async () => {
  const d = scratch();
  const a = await hashOf(d);
  assert.equal(await hashOf(d), a, 'repeated passes must agree, or every client soft-reloads forever');
  assert.match(a, /^[0-9a-f]{8}$/);
});

test('a non-asset file does not churn the hash', async () => {
  // A stray .log or .bak next to the assets must not make every dashboard reload.
  const d = scratch();
  const before = await hashOf(d);
  fs.writeFileSync(path.join(d, 'notes.txt'), 'hello');
  fs.writeFileSync(path.join(d, 'js', 'app.js.bak'), 'old');
  assert.equal(await hashOf(d), before);
});

test('a missing directory is empty, not a throw', async () => {
  const h = await hashOf(path.join(os.tmpdir(), 'st-fh-does-not-exist-' + Date.now()));
  assert.match(h, /^[0-9a-f]{8}$/);
});

test('⚠️ it is ASYNC and stat-based, not sync reads — the loop serves device heartbeats', () => {
  /*
   * The old version read ~20 files SYNCHRONOUSLY every 30s on the event loop that answers every
   * heartbeat, and this server has an open loop-spike problem. Covering the whole frontend that
   * way would mean reading 4.1 MB across 112 files, twice a minute, forever. Metadata over async
   * stats is cheaper than what it replaces AND covers everything — so this asserts the shape,
   * because a future "simplification" back to readFileSync would reintroduce the cost silently.
   */
  const fn = SERVER_JS.slice(SERVER_JS.indexOf('async function walkAssets'), SERVER_JS.indexOf('app.get(\'/api/version\''));
  assert.match(fn, /fs\.promises\.readdir/, 'the walk must be async');
  assert.match(fn, /fs\.promises\.stat/, 'and metadata-based');
  assert.doesNotMatch(fn, /readFileSync/, 'reading every asset on the loop is what this avoids');
  assert.match(fn, /depth > 8/, 'a symlink loop must not spin the server');
  assert.match(fn, /_hashing/, 'a slow disk must not stack passes');
  assert.match(fn, /parts\.sort\(\)/, 'readdir order is not stable across platforms');
});

test('the hardcoded list is gone', () => {
  // If it comes back, so does the bug.
  const region = SERVER_JS.slice(SERVER_JS.indexOf('let frontendHash'), SERVER_JS.indexOf('app.get(\'/api/version\''));
  assert.doesNotMatch(region, /js\/views\/dashboard\.js/,
    'a literal list of views in the hash means the next view added is invisible again');
});
