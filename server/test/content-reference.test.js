'use strict';

/*
 * The public /api/content/:id/{file,thumbnail,bundle} gate (lib/content-reference.js).
 *
 * ⚠️ The case this was extended for: a device's standby image (default_content_id) that is in no
 * playlist. The Android player downloads it through /file so it can show offline; the gate refused
 * it with 403, so the standby never reached an Android screen.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { isReferencedForPlayers } = require('../lib/content-reference');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE playlist_items (id INTEGER PRIMARY KEY, content_id TEXT);
    CREATE TABLE widgets (id TEXT PRIMARY KEY, workspace_id TEXT, config TEXT);
    CREATE TABLE devices (id TEXT PRIMARY KEY, workspace_id TEXT, default_content_id TEXT);
  `);
  return db;
}
const content = { id: 'c1', workspace_id: 'ws-a' };

test('unreferenced content is not served to players', () => {
  assert.equal(isReferencedForPlayers(fixture(), content), false);
});

test('content in a playlist is', () => {
  const db = fixture();
  db.prepare('INSERT INTO playlist_items (content_id) VALUES (?)').run('c1');
  assert.equal(isReferencedForPlayers(db, content), true);
});

test("content named by a widget in the content's own workspace is; another workspace's widget is not", () => {
  const db = fixture();
  db.prepare('INSERT INTO widgets VALUES (?,?,?)').run('w-other', 'ws-b', '{"bg":"/api/content/c1/file"}');
  assert.equal(isReferencedForPlayers(db, content), false, 'naming the UUID from elsewhere unlocks nothing');
  db.prepare('INSERT INTO widgets VALUES (?,?,?)').run('w-own', 'ws-a', '{"bg":"/api/content/c1/file"}');
  assert.equal(isReferencedForPlayers(db, content), true);
});

test("a device's standby image is served, even in no playlist — scoped to the content's workspace", () => {
  const db = fixture();
  db.prepare('INSERT INTO devices VALUES (?,?,?)').run('d-other', 'ws-b', 'c1');
  assert.equal(isReferencedForPlayers(db, content), false, "another workspace's device cannot unlock it");
  db.prepare('INSERT INTO devices VALUES (?,?,?)').run('d-own', 'ws-a', 'c1');
  assert.equal(isReferencedForPlayers(db, content), true);
});
