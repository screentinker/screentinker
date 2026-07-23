'use strict';

// #217 unstable-connection quality cap. The player only receives a content field if
// buildSnapshotItems (via publishPlaylist) denormalizes it into published_snapshot —
// that query enumerates columns explicitly, so this guards against the flag silently
// not reaching the player.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-unstable-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { publishPlaylist } = require('../routes/playlists');

const uid = (p) => p + '-' + crypto.randomBytes(4).toString('hex');

let USER;
before(() => {
  USER = uid('u');
  db.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, 'x')").run(USER, USER + '@t.local');
});

test('published snapshot carries unstable_connection so the player can cap quality', () => {
  const capped = uid('capped'), normal = uid('normal');
  db.prepare("INSERT INTO content (id, filename, mime_type, remote_url, unstable_connection) VALUES (?, ?, 'video/youtube', 'https://youtu.be/aaaaaaaaaaa', 1)")
    .run(capped, capped);
  db.prepare("INSERT INTO content (id, filename, mime_type, remote_url, unstable_connection) VALUES (?, ?, 'video/youtube', 'https://youtu.be/bbbbbbbbbbb', 0)")
    .run(normal, normal);

  const pl = uid('pl');
  db.prepare("INSERT INTO playlists (id, user_id, name, status) VALUES (?, ?, 'P', 'draft')").run(pl, USER);
  db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order) VALUES (?, ?, 0)').run(pl, capped);
  db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order) VALUES (?, ?, 1)').run(pl, normal);

  publishPlaylist(pl);

  const snapshot = JSON.parse(db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(pl).published_snapshot);
  const byId = Object.fromEntries(snapshot.map(i => [i.content_id, i]));
  assert.equal(byId[capped].unstable_connection, 1, 'flagged item keeps the cap in the snapshot');
  assert.equal(byId[normal].unstable_connection, 0, 'unflagged item stays uncapped');
});

test('unstable_connection defaults to 0 for content that never set it', () => {
  const c = uid('default');
  db.prepare("INSERT INTO content (id, filename, mime_type) VALUES (?, ?, 'video/youtube')").run(c, c);
  const row = db.prepare('SELECT unstable_connection FROM content WHERE id = ?').get(c);
  assert.equal(row.unstable_connection, 0);
});
