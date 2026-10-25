'use strict';

/*
 * Read-only (Viewer) UI: a workspace_viewer was offered create/edit/delete buttons on most dashboard
 * pages, and every one of them answered "Read-only access" (403). The server rules are unchanged;
 * the pages now ask ONE shared helper, utils.js canWrite(), which mirrors them:
 *   - level 'editor' (default) = tenancy.denyReadOnly: refuses only a workspace_viewer not acting-as;
 *   - level 'admin' = alert-channels / automation / cap-feeds / site-caches access({ write: true }):
 *     needs workspace_admin unless acting-as.
 *
 * Part 1 runs the real helper against stubbed localStorage. Part 2 is a source check that each page
 * gates its write buttons through it, so a later edit cannot quietly put a 403 button back.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
// Node 22's navigator is a getter-only global: define, don't assign (see getting-started-checklist.test.js).
Object.defineProperty(globalThis, 'navigator', { value: { language: 'en' }, configurable: true, writable: true });

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
let U;
const asUser = (u) => { if (u === null) store.delete('user'); else store.set('user', JSON.stringify(u)); };

test('load utils.js', async () => {
  U = await import(pathToFileURL(path.join(FRONTEND, 'js', 'utils.js')).href);
  assert.equal(typeof U.canWrite, 'function');
  assert.equal(typeof U.readOnlyNote, 'function');
});

test('canWrite(): only a non-acting workspace_viewer is read-only (denyReadOnly)', () => {
  asUser({ current_workspace_role: 'workspace_viewer', acting_as: false });
  assert.equal(U.canWrite(), false);
  asUser({ current_workspace_role: 'workspace_viewer', acting_as: true });
  assert.equal(U.canWrite(), true, 'platform staff / org admin acting-as may write');
  asUser({ current_workspace_role: 'workspace_editor', acting_as: false });
  assert.equal(U.canWrite(), true);
  asUser({ current_workspace_role: 'workspace_admin', acting_as: false });
  assert.equal(U.canWrite(), true);
  asUser({ current_workspace_role: null, acting_as: true });
  assert.equal(U.canWrite(), true);
});

test("canWrite('admin'): needs workspace_admin unless acting-as (alert channels, automation, emergency feeds)", () => {
  asUser({ current_workspace_role: 'workspace_viewer', acting_as: false });
  assert.equal(U.canWrite('admin'), false);
  asUser({ current_workspace_role: 'workspace_editor', acting_as: false });
  assert.equal(U.canWrite('admin'), false);
  asUser({ current_workspace_role: 'workspace_admin', acting_as: false });
  assert.equal(U.canWrite('admin'), true);
  asUser({ current_workspace_role: null, acting_as: true });
  assert.equal(U.canWrite('admin'), true);
});

test('canWrite(): fails open when it cannot tell (the server still enforces)', () => {
  asUser(null);
  assert.equal(U.canWrite(), true);
  store.set('user', '{not json');
  assert.equal(U.canWrite(), true);
  asUser({ id: 'u1' });   // a cached user from before the role was stored
  assert.equal(U.canWrite('admin'), true);
});

test('readOnlyNote(): empty for a writer; the viewer / admin-only sentence otherwise', () => {
  asUser({ current_workspace_role: 'workspace_editor', acting_as: false });
  assert.equal(U.readOnlyNote(), '');
  assert.match(U.readOnlyNote('admin'), /corp-notice/);
  asUser({ current_workspace_role: 'workspace_viewer', acting_as: false });
  assert.match(U.readOnlyNote(), /view-only access/);
  assert.match(U.readOnlyNote('admin'), /view-only access/, 'a viewer gets the viewer sentence, not "ask an admin"');
  asUser({ current_workspace_role: 'workspace_admin', acting_as: false });
  assert.equal(U.readOnlyNote('admin'), '');
});

test('the new strings exist in every translated locale', () => {
  for (const lang of ['en', 'de', 'es', 'fr', 'it', 'ja', 'nl', 'pt', 'zh']) {
    const src = fs.readFileSync(path.join(FRONTEND, 'js', 'i18n', `${lang}.js`), 'utf8');
    for (const key of ['common.read_only_note', 'common.admin_only_note']) {
      assert.ok(src.includes(`'${key}'`), `${lang}.js is missing ${key}`);
    }
  }
});

test('a hidden .btn stays hidden (.btn display would beat the UA [hidden] rule)', () => {
  const css = fs.readFileSync(path.join(FRONTEND, 'css', 'main.css'), 'utf8');
  assert.match(css, /\.btn\[hidden\]\s*\{\s*display:\s*none/);
});

// Each page: the write controls a viewer saw, and that the page now gates them on canWrite().
const PAGES = {
  'templates.js': [/canWrite\(\) \? `<button class="btn btn-primary btn-sm" data-use=/],
  'qr-codes.js': [/canWrite\(\) \? `<div class="corp-toolbar"><button class="btn btn-primary" id="qrNew"/, /data-act="edit" \$\{canWrite\(\)/, /data-act="del" \$\{canWrite\(\)/],
  'data-sources.js': [/id="newDataSourceBtn"[^>]*\$\{canWrite\(\)/, /data-act="refresh"[^>]*\$\{canWrite\(\)/, /data-act="edit"[^>]*\$\{canWrite\(\)/, /data-act="del"[^>]*\$\{canWrite\(\)/, /canWrite\(\) \? galleryHtml\(\)/],
  'kiosk.js': [/id="newKioskBtn" \$\{canWrite\(\)/, /\$\{canWrite\(\) \? '' : 'hidden'\} data-delete-kiosk=/, /id="saveKioskBtn" \$\{canWrite\(\)/],
  'widgets.js': [/id="newWidgetBtn" \$\{canWrite\(\)/, /id="saveWidgetBtn" \$\{canWrite\(\)/, /\$\{canWrite\(\) \? '' : 'hidden'\} data-duplicate-widget=/, /\$\{canWrite\(\) \? '' : 'hidden'\} data-delete-widget=/],
  'slides.js': [/id="newDeck" \$\{canWrite\(\)/, /\$\{canWrite\(\) \? '' : 'hidden'\} data-del=/, /id="saveBtn" \$\{canWrite\(\)/, /id="pubBtn" \$\{canWrite\(\)/],
  'playlists.js': [/id="createPlaylistBtn" \$\{canWrite\(\)/, /if \(!canWrite\(\)[^)]*\) \['publishBtn'/],
  'layout-editor.js': [/id="newLayoutBtn" \$\{canWrite\(\)/, /id="saveLayoutBtn" \$\{canWrite\(\)/, /data-delete-layout=/],
  'schedule.js': [/id="addScheduleBtn" \$\{canWrite\(\)/, /id="saveScheduleBtn" \$\{canWrite\(\)/, /openCompose\([^)]*\) \{\n\s*if \(!canWrite\(\)\) return;/],
  'triggers.js': [/id="tgNew" \$\{canWrite\(\)/, /data-act="del" \$\{canWrite\(\)/],
  'video-wall.js': [/id="newWallBtn" \$\{canWrite\(\)/, /id="deleteWallBtn" \$\{canWrite\(\)/, /id="saveLayoutBtn" \$\{canWrite\(\)/],
  'designer.js': [/id="publishBtn" \$\{canWrite\(\)/],
  'dashboard.js': [/id="addDeviceBtn" \$\{canWrite\(\)/],
  'alerts.js': [/canWrite\('admin'\) \? `<div class="corp-toolbar"><button class="btn btn-primary" id="alNew"/, /data-act="del" \$\{canWrite\('admin'\)/],
  'automation.js': [/canWrite\('admin'\) \? `<div class="corp-toolbar"><button class="btn btn-primary" id="autoNew"/, /data-unsub="\$\{esc\(s\.id\)\}" \$\{canWrite\('admin'\)/],
  'cap-feeds.js': [/canWrite\('admin'\) \? `<div class="corp-toolbar"><button class="btn btn-primary" id="capNew"/, /data-act="poll" \$\{canWrite\('admin'\)/],
  'site-caches.js': [/canWrite\('admin'\) \? `<div class="corp-toolbar"><button class="btn btn-primary" id="scNew"/, /data-act="rotate" \$\{canWrite\('admin'\)/],
};

for (const [file, patterns] of Object.entries(PAGES)) {
  test(`views/${file} gates its write controls on canWrite() from utils.js`, () => {
    const src = fs.readFileSync(path.join(FRONTEND, 'js', 'views', file), 'utf8');
    assert.match(src, /import \{[^}]*\bcanWrite\b[^}]*\} from '\.\.\/utils\.js';/, `${file} must import canWrite from utils.js`);
    for (const re of patterns) assert.match(src, re, `${file}: ${re}`);
  });
}
