'use strict';

/*
 * Publishing a deck: one slide widget per page, plus a playlist that orders them.
 *
 * ⚠️ THE PROPERTIES THAT MATTER ARE ALL ABOUT THE SECOND PUBLISH. The first one is easy — make some
 * widgets, make a playlist. It is the republish that can quietly go wrong, in three ways that all
 * look fine from the dashboard:
 *
 *   - making a NEW widget for a slide that already had one, orphaning the old one in the library
 *     and leaving the screen playing a widget nobody edits any more
 *   - bumping widget_rev when nothing changed, handing every screen a new render URL for identical
 *     bytes
 *   - deleting a widget on the way past that another playlist is still playing, which blanks a
 *     screen belonging to somebody who never touched this deck
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const deckLib = require('../lib/slide-deck');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE playlists (id TEXT PRIMARY KEY, user_id TEXT, workspace_id TEXT, name TEXT,
      description TEXT, created_at INTEGER, updated_at INTEGER, status TEXT,
      published_snapshot TEXT, published_structure TEXT, is_auto_generated INTEGER);
    CREATE TABLE playlist_items (id INTEGER PRIMARY KEY AUTOINCREMENT, playlist_id TEXT,
      content_id TEXT, widget_id TEXT, sort_order INTEGER, duration_sec INTEGER,
      created_at INTEGER, updated_at INTEGER, zone_id TEXT, muted INTEGER, child_playlist_id TEXT,
      play_from TEXT, play_until TEXT);
    CREATE TABLE widgets (id TEXT PRIMARY KEY, user_id TEXT, team_id TEXT, widget_type TEXT NOT NULL,
      name TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, workspace_id TEXT);
  `);
  return db;
}

const deckRow = (over = {}) => ({ id: 'd1', workspace_id: 'ws-a', name: 'Morning board', playlist_id: null, ...over });

const slide = (id, headline, over = {}) => ({
  id, name: id, dwell_sec: 8,
  template: { background: '#101820', elements: [
    { slot: 'head', kind: 'head', box: { x: 5, y: 40, w: 60 }, style: { size_cqw: 6 },
      motion: { animation: 'slideU', delay: 0.2, duration: 0.5 } },
  ] },
  fields: { head: headline },
  ...over,
});

/*
 * ⚠️ Mirrors what routes/slide-decks.js does: it threads the SERVER-WRITTEN record of what was
 * published last time, not the widget_id fields inside the document. A helper that quietly passed
 * the document's ids instead would make these tests agree with the bug they exist to catch.
 */
const pub = (db, doc, deck = deckRow(), publishedWidgetIds = []) =>
  deckLib.publishDeck(db, { deck, doc, userId: 'u1', playlistId: deck.playlist_id, publishedWidgetIds });

// ===== first publish =====

test('a deck publishes one slide widget per page, in order, with its own dwell', () => {
  const db = freshDb();
  const out = pub(db, { slides: [slide('s1', 'One'), { ...slide('s2', 'Two'), dwell_sec: 12 }] });

  const items = db.prepare('SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order').all(out.playlistId);
  assert.equal(items.length, 2);
  assert.equal(items[0].duration_sec, 8);
  assert.equal(items[1].duration_sec, 12);

  const widgets = db.prepare("SELECT * FROM widgets WHERE widget_type = 'slide'").all();
  assert.equal(widgets.length, 2);
  assert.ok(widgets.every((w) => w.workspace_id === 'ws-a'), 'a widget escaped the deck workspace');
  assert.match(JSON.parse(widgets[0].config).fields.head, /One|Two/);

  // The document comes back carrying the ids, which is how the next publish finds them again.
  assert.ok(out.doc.slides.every((s) => s.widget_id), 'a slide came back with no widget id');
});

// ===== the second publish =====

test('⚠️ republishing UPDATES the same widgets rather than making a second set', () => {
  const db = freshDb();
  const first = pub(db, { slides: [slide('s1', 'One'), slide('s2', 'Two')] });
  const ids = first.doc.slides.map((s) => s.widget_id);

  const doc2 = { slides: [{ ...first.doc.slides[0], fields: { head: 'One, edited' } }, first.doc.slides[1]] };
  const second = pub(db, doc2, deckRow({ playlist_id: first.playlistId }), first.publishedWidgetIds);

  assert.equal(db.prepare("SELECT COUNT(*) n FROM widgets WHERE widget_type='slide'").get().n, 2,
    'a republish orphaned the original widgets');
  assert.deepEqual(second.doc.slides.map((s) => s.widget_id), ids, 'the widget ids moved');
  assert.equal(JSON.parse(db.prepare('SELECT config FROM widgets WHERE id = ?').get(ids[0]).config).fields.head,
    'One, edited');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM playlist_items WHERE playlist_id = ?').get(first.playlistId).n, 2);
});

test('⚠️ a republish that changes nothing does not bump widget_rev', () => {
  /*
   * updated_at IS widget_rev — the value the player keys its render URL on. Bumping it for
   * identical bytes hands every screen a new URL for content it already has, which on a large
   * estate is a stampede of re-renders caused by somebody pressing Publish twice.
   */
  const db = freshDb();
  const first = pub(db, { slides: [slide('s1', 'One')] });
  const id = first.doc.slides[0].widget_id;
  const revBefore = db.prepare('SELECT updated_at FROM widgets WHERE id = ?').get(id).updated_at;

  db.prepare('UPDATE widgets SET updated_at = 1 WHERE id = ?').run(id);   // make a bump detectable
  pub(db, first.doc, deckRow({ playlist_id: first.playlistId }), first.publishedWidgetIds);
  assert.equal(db.prepare('SELECT updated_at FROM widgets WHERE id = ?').get(id).updated_at, 1,
    'an unchanged slide was rewritten anyway');
  assert.ok(revBefore > 0);
});

test('⚠️ an edited slide DOES bump widget_rev, or the edit never reaches the screen', () => {
  // The other side of the same coin: the player deliberately reuses the WebView for a URL it has
  // seen, so a changed slide that keeps its rev is a change nobody sees until the app restarts.
  const db = freshDb();
  const first = pub(db, { slides: [slide('s1', 'One')] });
  const id = first.doc.slides[0].widget_id;
  db.prepare('UPDATE widgets SET updated_at = 1 WHERE id = ?').run(id);

  const doc2 = { slides: [{ ...first.doc.slides[0], fields: { head: 'Changed' } }] };
  pub(db, doc2, deckRow({ playlist_id: first.playlistId }), first.publishedWidgetIds);
  assert.notEqual(db.prepare('SELECT updated_at FROM widgets WHERE id = ?').get(id).updated_at, 1,
    'an edited slide kept its old rev');
});

// ===== removal =====

test('removing a slide takes its item and its widget away', () => {
  const db = freshDb();
  const first = pub(db, { slides: [slide('s1', 'One'), slide('s2', 'Two')] });
  const goneId = first.doc.slides[1].widget_id;

  const second = pub(db, { slides: [first.doc.slides[0]] }, deckRow({ playlist_id: first.playlistId }),
    first.publishedWidgetIds);
  assert.equal(second.removed, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM widgets WHERE id = ?').get(goneId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM playlist_items WHERE playlist_id = ?').get(first.playlistId).n, 1);
});

test('⚠️ a removed slide whose widget ANOTHER playlist plays is unlinked, never deleted', () => {
  /*
   * The destructive case. Somebody adds one of these slides to their own playlist by hand; later,
   * the deck's author removes it from the deck. Deleting the widget there would blank a screen
   * belonging to a person who never touched this deck and has no way to connect the two events.
   */
  const db = freshDb();
  const first = pub(db, { slides: [slide('s1', 'One'), slide('s2', 'Two')] });
  const sharedId = first.doc.slides[1].widget_id;

  db.prepare(`INSERT INTO playlist_items (playlist_id, widget_id, sort_order, duration_sec)
              VALUES ('other-playlist', ?, 0, 10)`).run(sharedId);

  pub(db, { slides: [first.doc.slides[0]] }, deckRow({ playlist_id: first.playlistId }),
    first.publishedWidgetIds);

  assert.equal(db.prepare('SELECT COUNT(*) n FROM widgets WHERE id = ?').get(sharedId).n, 1,
    "a widget another playlist was playing got deleted");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM playlist_items WHERE playlist_id='other-playlist'").get().n, 1,
    "the other playlist's item was removed too");
  assert.equal(db.prepare('SELECT COUNT(*) n FROM playlist_items WHERE playlist_id = ?').get(first.playlistId).n, 1);
});

test('⚠️ items an operator added to the deck playlist by hand survive a republish', () => {
  // A rebuild-from-scratch would be shorter to write and would silently delete this.
  const db = freshDb();
  const first = pub(db, { slides: [slide('s1', 'One')] });
  db.prepare(`INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec)
              VALUES (?, 'some-video', 5, 30)`).run(first.playlistId);

  pub(db, first.doc, deckRow({ playlist_id: first.playlistId }), first.publishedWidgetIds);
  assert.equal(db.prepare(
    "SELECT COUNT(*) n FROM playlist_items WHERE playlist_id = ? AND content_id = 'some-video'")
    .get(first.playlistId).n, 1, "a hand-added item was swept away by publish");
});

test('per-item state the deck does not model is preserved across a republish', () => {
  const db = freshDb();
  const first = pub(db, { slides: [slide('s1', 'One')] });
  const item = db.prepare('SELECT id FROM playlist_items WHERE playlist_id = ?').get(first.playlistId);
  db.prepare("UPDATE playlist_items SET muted = 1, zone_id = 'z2' WHERE id = ?").run(item.id);

  pub(db, first.doc, deckRow({ playlist_id: first.playlistId }), first.publishedWidgetIds);
  const after = db.prepare('SELECT * FROM playlist_items WHERE id = ?').get(item.id);
  assert.equal(after.muted, 1, 'mute was lost — the row was recreated rather than updated');
  assert.equal(after.zone_id, 'z2');
});

// ===== tenancy =====

test('⚠️ a widget id pointing at another workspace is not written through', () => {
  // widget_id arrives inside a document, so it is a value somebody could type. Publishing must not
  // be a way to overwrite another tenant's widget by naming its id.
  const db = freshDb();
  const ts = 1;
  db.prepare(`INSERT INTO widgets (id, widget_type, name, config, created_at, updated_at, workspace_id)
              VALUES ('w-theirs','slide','Theirs','{"theirs":true}',?,?,'ws-b')`).run(ts, ts);

  const out = pub(db, { slides: [{ ...slide('s1', 'Mine'), widget_id: 'w-theirs' }] });
  const theirs = db.prepare("SELECT * FROM widgets WHERE id = 'w-theirs'").get();
  assert.equal(theirs.config, '{"theirs":true}', "another workspace's widget was overwritten");
  assert.notEqual(out.doc.slides[0].widget_id, 'w-theirs', 'the deck adopted a foreign widget');
});

test('⚠️ a playlist_id pointing at another workspace is replaced, not written into', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO playlists (id, workspace_id, name, status) VALUES ('pl-theirs','ws-b','Theirs','published')`).run();
  const out = pub(db, { slides: [slide('s1', 'Mine')] }, deckRow({ playlist_id: 'pl-theirs' }));
  assert.notEqual(out.playlistId, 'pl-theirs');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM playlist_items WHERE playlist_id='pl-theirs'").get().n, 0);
});

// ===== the document =====

test('duplicate slide ids are separated, so two slides cannot fight over one widget', () => {
  const d = deckLib.normalizeDeck({ slides: [slide('same', 'A'), slide('same', 'B')] });
  assert.notEqual(d.slides[0].id, d.slides[1].id);
});

test('dwell is clamped and defaulted rather than trusted', () => {
  const d = deckLib.normalizeDeck({ slides: [
    { id: 'a', dwell_sec: 0 }, { id: 'b', dwell_sec: 99999 }, { id: 'c' }, { id: 'd', dwell_sec: 'soon' }] });
  assert.equal(d.slides[0].dwell_sec, deckLib.MIN_DWELL);
  assert.equal(d.slides[1].dwell_sec, deckLib.MAX_DWELL);
  assert.equal(d.slides[2].dwell_sec, 10);
  assert.equal(d.slides[3].dwell_sec, 10);
});

test('⚠️ a slide whose motion outlives its dwell is WARNED about, not refused', () => {
  /*
   * The coupling nothing else in the product knows about. Refusing the save would be worse than
   * flagging it — an operator mid-edit has every right to a deck that does not add up yet — but
   * saying nothing means the defect is only ever discovered on a wall.
   */
  const doc = deckLib.normalizeDeck({ slides: [{ id: 's1', name: 'Slow', dwell_sec: 2,
    template: { elements: [{ slot: 'h', kind: 'head', box: {},
      motion: { animation: 'fade', delay: 3, duration: 1 } }] }, fields: { h: 'x' } }] });
  const w = deckLib.deckWarnings(doc);
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'motion-outlives-dwell');
  assert.equal(w[0].settle_sec, 4);
  assert.equal(w[0].dwell_sec, 2);
  assert.match(w[0].message, /Slow/);

  // ...and a deck that fits warns about nothing.
  assert.deepEqual(deckLib.deckWarnings(deckLib.normalizeDeck({ slides: [slide('ok', 'fits')] })), []);
});
