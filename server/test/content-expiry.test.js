'use strict';

// #157 auto-deactivate expired content. Exercises the two hard parts against a real DB:
//   1. buildSnapshotItems (via publishPlaylist) drops expired/inactive content but keeps
//      live content, future-expiry content, and non-content (widget/content_id-NULL) items.
//   2. sweepExpiredContent flips is_active=0 for newly-expired items and republishes ONLY
//      the published playlists that carried them — once, idempotently, blast-radius-limited.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-expiry-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { publishPlaylist } = require('../routes/playlists');
const { sweepExpiredContent } = require('../services/content-expiry');

const now = () => Math.floor(Date.now() / 1000);
const uid = (p) => p + '-' + crypto.randomBytes(4).toString('hex');

function mkContent(id, { expires_at = null, is_active = 1 } = {}) {
  db.prepare("INSERT INTO content (id, filename, mime_type, expires_at, is_active) VALUES (?, ?, 'video/mp4', ?, ?)")
    .run(id, id + '.mp4', expires_at, is_active);
}
function snapshotIds(playlistId) {
  const row = db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(playlistId);
  return JSON.parse(row.published_snapshot || '[]').map(i => i.content_id || '(widget)');
}

let USER;
before(() => {
  USER = uid('u');
  db.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, 'x')").run(USER, USER + '@t.local');
});

test('publish snapshot: keeps live/future/widget items, drops expired + inactive', () => {
  const live = uid('live'), future = uid('future'), pastC = uid('past'), inactive = uid('inact');
  mkContent(live);
  mkContent(future, { expires_at: now() + 3600 });
  mkContent(pastC, { expires_at: now() - 3600 });          // expired but is_active still 1
  mkContent(inactive, { is_active: 0 });                    // already deactivated

  const pl = uid('pl');
  db.prepare("INSERT INTO playlists (id, user_id, name, status) VALUES (?, ?, 'P', 'draft')").run(pl, USER);
  let so = 0;
  for (const cid of [live, future, pastC, inactive]) {
    db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order) VALUES (?, ?, ?)').run(pl, cid, so++);
  }
  // A content_id-NULL item (widget-style) must always survive the filter.
  db.prepare("INSERT INTO playlist_items (playlist_id, content_id, widget_id, sort_order) VALUES (?, NULL, NULL, ?)")
    .run(pl, so++);

  publishPlaylist(pl, null);
  const ids = snapshotIds(pl);
  assert.deepEqual(ids.sort(), [live, future, '(widget)'].sort(),
    'snapshot should contain only live + future-expiry content + the widget row');
  assert.ok(!ids.includes(pastC) && !ids.includes(inactive), 'expired + inactive dropped');
});

test('sweep: deactivates newly-expired, republishes only affected PUBLISHED playlists, idempotent', () => {
  const expC = uid('sweepexp'), liveC = uid('sweeplive');
  mkContent(expC, { expires_at: now() + 3600 });  // published while VALID (future expiry)...
  mkContent(liveC);

  // Published playlist that carries the item -> should be republished once it expires.
  const plPub = uid('plpub');
  db.prepare("INSERT INTO playlists (id, user_id, name, status) VALUES (?, ?, 'pub', 'draft')").run(plPub, USER);
  db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order) VALUES (?, ?, 0)').run(plPub, expC);
  db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order) VALUES (?, ?, 1)').run(plPub, liveC);
  publishPlaylist(plPub, null);                  // status -> published, snapshot has BOTH
  assert.ok(snapshotIds(plPub).includes(expC), 'precondition: item is in the published snapshot while valid');

  // ...now it expires (models real life: valid at publish, expires later).
  db.prepare('UPDATE content SET expires_at = ? WHERE id = ?').run(now() - 10, expC);

  // Draft playlist with the same item -> must NOT be republished (drafts don't serve).
  const plDraft = uid('pldraft');
  db.prepare("INSERT INTO playlists (id, user_id, name, status) VALUES (?, ?, 'draft', 'draft')").run(plDraft, USER);
  db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order) VALUES (?, ?, 0)').run(plDraft, expC);

  const res = sweepExpiredContent(null);
  assert.ok(res.expired.includes(expC), 'sweep reports the expired content id');
  assert.equal(db.prepare('SELECT is_active FROM content WHERE id = ?').get(expC).is_active, 0, 'is_active flipped to 0');
  assert.ok(res.republished.includes(plPub), 'published playlist republished');
  assert.ok(!res.republished.includes(plDraft), 'draft playlist NOT republished');
  assert.ok(!snapshotIds(plPub).includes(expC), 'republished snapshot no longer carries the expired item');
  assert.ok(snapshotIds(plPub).includes(liveC), 'the live sibling item survives');

  // Second sweep: nothing new (already-processed marker prevents a re-republish).
  const res2 = sweepExpiredContent(null);
  assert.ok(!res2.expired.includes(expC), 'idempotent: expired item not reprocessed');
});
