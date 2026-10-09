'use strict';

/*
 * Social walls: moderation and the "deleted at the source" purge, against an in-memory database
 * (no server, no network). The review findings these hold down:
 *   - on an 'approve' feed, an approved post edited at the source goes back to the queue
 *   - a blocklisted word arriving by EDIT (or in the author's name) hides the post, and saving the
 *     blocklist re-checks every stored post — including ones no API answer reaches any more
 *   - the purge never deletes a hidden row (it would come back approved), an empty answer is not
 *     trusted until it repeats, and a time-windowed search only vouches for its window
 *   - a token refresh in flight never overwrites a token an admin just pasted
 *   - Meta CDN images keep one cache key across re-signed URLs
 *   - a wall's cacheable page carries no posts, and its data reflects a hide at once
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'social-mod-'));
process.env.JWT_SECRET = process.env.JWT_SECRET || 'social-moderation-test-secret';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const feeds = require('../lib/social/feeds');
const networks = require('../lib/social/networks');
const media = require('../lib/social/media');
const widget = require('../lib/social/widget');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE social_connections (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, created_by TEXT, kind TEXT NOT NULL, name TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}', secret_enc TEXT, token_expires_at INTEGER, token_refreshed_at INTEGER, last_error TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')), updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')));
    CREATE TABLE social_feeds (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, created_by TEXT, name TEXT NOT NULL, sources TEXT NOT NULL DEFAULT '[]',
      moderation TEXT NOT NULL DEFAULT 'auto', blocklist TEXT NOT NULL DEFAULT '[]', require_media INTEGER NOT NULL DEFAULT 0,
      max_age_days INTEGER NOT NULL DEFAULT 0, max_posts INTEGER NOT NULL DEFAULT 20, refresh_min INTEGER NOT NULL DEFAULT 10,
      enabled INTEGER NOT NULL DEFAULT 1, next_fetch_at INTEGER NOT NULL DEFAULT 0, fail_count INTEGER NOT NULL DEFAULT 0,
      last_fetch_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')), updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')));
    CREATE TABLE social_posts (feed_id TEXT NOT NULL, network TEXT NOT NULL, post_id TEXT NOT NULL, source_key TEXT NOT NULL, status TEXT NOT NULL,
      hidden_reason TEXT, author_name TEXT, author_handle TEXT, author_avatar TEXT, text TEXT, media TEXT, is_video INTEGER NOT NULL DEFAULT 0,
      permalink TEXT, posted_at INTEGER NOT NULL, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, content_hash TEXT,
      PRIMARY KEY (feed_id, network, post_id));
  `);
  return db;
}

const SOURCE = { network: 'bluesky', kind: 'account', value: 'acme.bsky.social', limit: 20 };
const t0 = Math.floor(Date.now() / 1000);
let n = 0;
function mkFeed(db, extra = {}) {
  const input = { name: `f${++n}`, sources: [SOURCE], moderation: 'auto', blocklist: [], require_media: 0, max_age_days: 0, max_posts: 20, refresh_min: 10, enabled: 1, ...extra };
  return feeds.create(db, 'ws1', 'u1', input);
}
const post = (id, text, extra = {}) => ({ post_id: id, author: { name: 'Acme', handle: '@acme' }, text, media: [], posted_at: t0 - 60, ...extra });
const img = async (u) => media.hashOf(media.cacheKey(u));
const row = (db, feed, id) => db.prepare('SELECT * FROM social_posts WHERE feed_id = ? AND post_id = ?').get(feed.id, id);
const ingest = (db, feed, posts, more = {}) => feeds.ingest(db, db.prepare('SELECT * FROM social_feeds WHERE id = ?').get(feed.id), SOURCE, { posts, complete: false, ...more }, img);

test('approve mode: an approved post edited at the source goes back to the queue', async () => {
  const db = freshDb();
  const feed = mkFeed(db, { moderation: 'approve' });
  await ingest(db, feed, [post('a', 'hello'), post('b', 'world', { media: ['https://cdn.example/1.png'] })]);
  assert.equal(row(db, feed, 'a').status, 'pending');
  feeds.moderate(db, feed, 'bluesky', 'a', 'approve');
  feeds.moderate(db, feed, 'bluesky', 'b', 'approve');

  await ingest(db, feed, [post('a', 'hello'), post('b', 'world', { media: ['https://cdn.example/1.png'] })]);
  assert.equal(row(db, feed, 'a').status, 'approved', 'an unchanged post stays approved');
  assert.equal(row(db, feed, 'b').status, 'approved');

  await ingest(db, feed, [post('a', 'hello, now with something else'), post('b', 'world', { media: ['https://cdn.example/2.png'] })]);
  assert.equal(row(db, feed, 'a').status, 'pending', 'edited text needs approving again');
  assert.equal(row(db, feed, 'a').text, 'hello, now with something else');
  assert.equal(row(db, feed, 'b').status, 'pending', 'a swapped image needs approving again');

  // A row stored before content hashes existed only records its hash.
  feeds.moderate(db, feed, 'bluesky', 'a', 'approve');
  db.prepare('UPDATE social_posts SET content_hash = NULL WHERE post_id = ?').run('a');
  await ingest(db, feed, [post('a', 'changed again')]);
  assert.equal(row(db, feed, 'a').status, 'approved');
  assert.ok(row(db, feed, 'a').content_hash);

  // On an 'auto' feed an edit just shows.
  const auto = mkFeed(db);
  await ingest(db, auto, [post('c', 'one')]);
  await ingest(db, auto, [post('c', 'two')]);
  assert.equal(row(db, auto, 'c').status, 'approved');
  assert.equal(row(db, auto, 'c').text, 'two');
});

test('a re-signed Meta CDN URL is the same image, and not an edit', async () => {
  const a = 'https://scontent-lhr8-1.cdninstagram.com/v/t51.29350-15/123_n.jpg?stp=dst-jpg&_nc_ht=x&oh=00_AAA&oe=66F0';
  const b = 'https://scontent-lhr8-1.cdninstagram.com/v/t51.29350-15/123_n.jpg?stp=dst-jpg&_nc_ht=x&oh=00_BBB&oe=66F9';
  assert.equal(media.cacheKey(a), 'https://scontent-lhr8-1.cdninstagram.com/v/t51.29350-15/123_n.jpg');
  assert.equal(media.hashOf(media.cacheKey(a)), media.hashOf(media.cacheKey(b)));
  assert.equal(media.cacheKey('https://external.xx.fbcdn.net/p.jpg?x=1'), 'https://external.xx.fbcdn.net/p.jpg');
  // Elsewhere the query can be what names the image.
  assert.equal(media.cacheKey('https://img.example/get?id=1'), 'https://img.example/get?id=1');
  assert.equal(media.cacheKey('https://evilfbcdn.net/a.jpg?id=1'), 'https://evilfbcdn.net/a.jpg?id=1', 'only the real hosts');
  assert.equal(feeds.contentHash('x', [a]), feeds.contentHash('x', [b]));

  const db = freshDb();
  const feed = mkFeed(db, { moderation: 'approve' });
  await ingest(db, feed, [post('ig', 'pic', { media: [a] })]);
  feeds.moderate(db, feed, 'bluesky', 'ig', 'approve');
  const before = row(db, feed, 'ig').media;
  await ingest(db, feed, [post('ig', 'pic', { media: [b] })]);
  assert.equal(row(db, feed, 'ig').status, 'approved');
  assert.equal(row(db, feed, 'ig').media, before, 'the wall sees the same media hash');

  // cache() fetches once for both signed URLs.
  let fetched = 0;
  const fetcher = async () => { fetched++; return { status: 200, body: Buffer.from('ffd8ffe000104a464946000101', 'hex') }; };
  const mdb = new Database(':memory:');
  mdb.exec('CREATE TABLE social_media (hash TEXT PRIMARY KEY, url TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL)');
  const h1 = await media.cache(mdb, a, fetcher);
  const h2 = await media.cache(mdb, b, fetcher);
  assert.ok(h1);
  assert.equal(h1, h2);
  assert.equal(fetched, 1);
});

test('a blocklisted word arriving by edit, or in the author, hides the post', async () => {
  const db = freshDb();
  const feed = mkFeed(db, { blocklist: ['spam'] });
  await ingest(db, feed, [post('a', 'fine'), post('b', 'also fine')]);
  assert.equal(row(db, feed, 'a').status, 'approved');
  await ingest(db, feed, [post('a', 'buy spam now'), post('b', 'also fine', { author: { name: 'Spam King', handle: '@spam' } })]);
  for (const id of ['a', 'b']) {
    const r = row(db, feed, id);
    assert.equal(r.status, 'hidden', id);
    assert.equal(r.hidden_reason, 'blocklist');
    assert.equal(r.text, null, 'no empty card with only an author left');
  }
  assert.deepEqual(feeds.visiblePosts(db, feed), []);
});

test('saving the blocklist re-checks every stored post, even ones no answer returns any more', async () => {
  const db = freshDb();
  const feed = mkFeed(db);
  await ingest(db, feed, [post('old', 'an old post about widgets', { posted_at: t0 - 400 * 86400 }), post('new', 'nothing here'),
    post('auth', 'hi', { author: { name: 'Widgets Inc', handle: '@w' } })]);
  feeds.moderate(db, feed, 'bluesky', 'new', 'hide');
  feeds.update(db, feed, feeds.normaliseInput(db, 'org1', { blocklist: 'Widgets' }, feed));
  assert.equal(row(db, feed, 'old').status, 'hidden');
  assert.equal(row(db, feed, 'old').hidden_reason, 'blocklist');
  assert.equal(row(db, feed, 'old').text, null);
  assert.equal(row(db, feed, 'auth').status, 'hidden', 'the author name is checked too');
  assert.equal(row(db, feed, 'new').hidden_reason, 'moderator', 'a moderator-hidden post is left as it is');
});

test('the blocklist sees through invisible characters and look-alike letters', () => {
  const w = ['bad'];
  assert.equal(feeds.blocked('so b\u200bad', w), true, 'zero-width space');
  assert.equal(feeds.blocked('so b\u200cad', w), true, 'ZWNJ');
  assert.equal(feeds.blocked('so b\u200dad', w), true, 'ZWJ');
  assert.equal(feeds.blocked('so b\u2060ad', w), true, 'word joiner');
  assert.equal(feeds.blocked('so b\ufeffad', w), true, 'BOM');
  assert.equal(feeds.blocked('so b\u00adad', w), true, 'soft hyphen');
  assert.equal(feeds.blocked('so ｂａｄ', w), true, 'fullwidth');
  assert.equal(feeds.blocked('so 𝐛𝐚𝐝', w), true, 'mathematical bold');
  assert.equal(feeds.blocked('so BÁD', w), true, 'diacritics and case');
  assert.equal(feeds.blocked('so b\u0301ad', w), true, 'a combining mark');
  assert.equal(feeds.blocked('#ｂａｄ day', w), true);
  assert.equal(feeds.blocked('badly', w), false, 'still whole-word');
  assert.equal(feeds.blocked('café crème', ['crème']), true);
  assert.equal(feeds.blocked('cafe creme', ['crème']), true, 'the entry is folded too');
});

test('stored text loses zero-width characters but keeps emoji joiners', async () => {
  const db = freshDb();
  const feed = mkFeed(db);
  await ingest(db, feed, [post('z', 'a\u200bb\u2060c\ufeffd\u00ade 👨\u200d👩\u200d👧')]);
  assert.equal(row(db, feed, 'z').text, 'abcde 👨\u200d👩\u200d👧');
});

test('the purge never deletes a hidden post, so it cannot come back approved', async () => {
  const db = freshDb();
  const feed = mkFeed(db);
  await ingest(db, feed, [post('keep', 'k'), post('cw', 'later gets a content warning')]);
  feeds.moderate(db, feed, 'bluesky', 'cw', 'hide');
  // The status is now filtered out of the answer (a Mastodon CW), and the answer is complete.
  const r = await ingest(db, feed, [post('keep', 'k')], { complete: true });
  assert.equal(r.purged, 0);
  const marker = row(db, feed, 'cw');
  assert.ok(marker, 'the hidden marker is kept');
  assert.equal(marker.status, 'hidden');
  assert.equal(marker.text, null, 'as a marker without its content');
  // The warning is lifted and the post is back in the answer.
  await ingest(db, feed, [post('keep', 'k'), post('cw', 'later gets a content warning')], { complete: true });
  assert.equal(row(db, feed, 'cw').status, 'hidden', 'still hidden');
  assert.deepEqual(feeds.visiblePosts(db, feed).map((p) => p.post_id), ['keep']);
  // Only the 90-day prune removes it.
  db.prepare('UPDATE social_posts SET last_seen_at = ? WHERE post_id = ?').run(t0 - 91 * 86400, 'cw');
  feeds.prune(db, feed);
  assert.equal(row(db, feed, 'cw'), undefined);
});

test('an empty answer purges only once it has repeated', async () => {
  const db = freshDb();
  const feed = mkFeed(db);
  await ingest(db, feed, [post('a', 'a'), post('b', 'b')]);
  for (let i = 1; i < feeds.EMPTY_CONFIRMATIONS; i++) {
    const r = await ingest(db, feed, [], { complete: true });
    assert.equal(r.purged, 0, `empty answer ${i} is not trusted`);
  }
  // A non-empty answer in between starts the count again.
  await ingest(db, feed, [post('a', 'a'), post('b', 'b')]);
  for (let i = 1; i < feeds.EMPTY_CONFIRMATIONS; i++) await ingest(db, feed, [], { complete: true });
  assert.equal(feeds.visiblePosts(db, feed).length, 2);
  const r = await ingest(db, feed, [], { complete: true });
  assert.equal(r.purged, 2, 'the source really has nothing left');
  // A malformed answer is never "complete".
  await ingest(db, feed, [post('c', 'c')]);
  for (let i = 0; i < 5; i++) await ingest(db, feed, [], { complete: false });
  assert.equal(feeds.visiblePosts(db, feed).length, 1);
});

test('a time-windowed search only purges inside the window it covers', async () => {
  const db = freshDb();
  const feed = mkFeed(db);
  await ingest(db, feed, [post('old', 'two days old', { posted_at: t0 - 2 * 86400 }), post('recent', 'an hour old', { posted_at: t0 - 7200 }),
    post('now', 'just now', { posted_at: t0 - 60 })]);
  // recent_media covers 24 hours: 'old' is missing because it is old, 'recent' because it was deleted.
  const r = await ingest(db, feed, [post('now', 'just now', { posted_at: t0 - 60 })], { complete: true, windowSec: 86400 });
  assert.equal(r.purged, 1);
  assert.ok(row(db, feed, 'old'), 'outside the window: kept');
  assert.equal(row(db, feed, 'recent'), undefined, 'inside the window: deleted at the source');
  // A quiet tag (empty answers) never empties the wall of posts older than the window.
  for (let i = 0; i < feeds.EMPTY_CONFIRMATIONS + 1; i++) await ingest(db, feed, [], { complete: true, windowSec: 86400 });
  assert.ok(row(db, feed, 'old'));
});

test('connectors only call an answer complete when it has the expected shape', () => {
  // Exercised through ingest above; here, the windowed sources say so.
  const src = require('node:fs').readFileSync(require.resolve('../lib/social/networks'), 'utf8');
  assert.match(src, /windowSec: IG_HASHTAG_WINDOW/);
  assert.match(src, /windowSec: X_SEARCH_WINDOW/);
  assert.ok(!/complete: true/.test(src), 'no unconditional complete');
});

test('a token refresh in flight never overwrites a token an admin just pasted', async () => {
  const db = freshDb();
  const secretbox = require('../lib/secretbox');
  const original = secretbox.encrypt('OLD-TOKEN');
  db.prepare("INSERT INTO social_connections (id, organization_id, kind, name, config, secret_enc, token_refreshed_at) VALUES ('c1', 'o1', 'instagram', 'IG', '{\"api\":\"instagram_login\"}', ?, 0)").run(original);
  const conn = { ...db.prepare('SELECT * FROM social_connections WHERE id = ?').get('c1'), config: { api: 'instagram_login' } };
  const pasted = secretbox.encrypt('ADMIN-PASTED');
  const real = networks.refreshInstagramToken;
  try {
    networks.refreshInstagramToken = async () => {
      db.prepare('UPDATE social_connections SET secret_enc = ? WHERE id = ?').run(pasted, 'c1'); // the admin saves meanwhile
      return { token: 'REFRESHED-FROM-OLD', expiresAt: t0 + 86400 };
    };
    const used = await feeds.refreshConnectionToken(db, conn);
    assert.equal(db.prepare('SELECT secret_enc FROM social_connections WHERE id = ?').get('c1').secret_enc, pasted, "the admin's token is kept");
    assert.equal(secretbox.decrypt(used.secret_enc), 'ADMIN-PASTED', 'and the fetch uses it');

    // A failed refresh does not stamp an error on a connection whose token was just replaced.
    const again = secretbox.encrypt('ADMIN-SECOND');
    networks.refreshInstagramToken = async () => { db.prepare('UPDATE social_connections SET secret_enc = ? WHERE id = ?').run(again, 'c1'); throw new Error('expired'); };
    await feeds.refreshConnectionToken(db, { ...used });
    assert.equal(db.prepare('SELECT last_error FROM social_connections WHERE id = ?').get('c1').last_error, null);

    // Without a race the refreshed token is stored.
    networks.refreshInstagramToken = async () => ({ token: 'REFRESHED', expiresAt: t0 + 86400 });
    const cur = { ...db.prepare('SELECT * FROM social_connections WHERE id = ?').get('c1'), config: { api: 'instagram_login' } };
    await feeds.refreshConnectionToken(db, cur);
    assert.equal(secretbox.decrypt(db.prepare('SELECT secret_enc FROM social_connections WHERE id = ?').get('c1').secret_enc), 'REFRESHED');
  } finally { networks.refreshInstagramToken = real; }
});

test("a wall's cacheable page carries no posts, and its data shows a hide at once", async () => {
  const db = freshDb();
  const feed = mkFeed(db);
  await ingest(db, feed, [post('a', 'first post text'), post('b', 'second post text')]);
  const w = { id: 'w1', workspace_id: 'ws1', updated_at: 1, config: JSON.stringify({ feed_id: feed.id }) };
  const cfg = { feed_id: feed.id };

  const pinned = widget.render(db, w, cfg, { origin: 'https://st.example', seed: false }).html;
  assert.ok(!pinned.includes('first post text'), 'nothing a later hide could not take back');
  assert.match(pinned, /var loaded = false/);
  const live = widget.render(db, w, cfg, { origin: 'https://st.example' }).html;
  assert.ok(live.includes('first post text'), 'the uncacheable page is seeded');

  assert.deepEqual(widget.cachedPayload(db, w, cfg).posts.map((p) => p.k).sort(), ['bluesky:a', 'bluesky:b']);
  // Served from the cache: no feed query.
  const spy = { ...db, prepare: () => { throw new Error('queried'); } };
  assert.equal(widget.cachedPayload(spy, w, cfg).posts.length, 2);
  feeds.moderate(db, feed, 'bluesky', 'a', 'hide');
  assert.deepEqual(widget.cachedPayload(db, w, cfg).posts.map((p) => p.k), ['bluesky:b'], 'the hide is seen on the next poll');
  // And it expires on its own (a change made on another node).
  db.prepare("UPDATE social_posts SET status = 'hidden' WHERE post_id = 'b'").run();
  assert.equal(widget.cachedPayload(db, w, cfg).posts.length, 1);
  assert.equal(widget.cachedPayload(db, w, cfg, Date.now() + widget.PAYLOAD_TTL_MS + 1).posts.length, 0);
});

test('show_text off: pictures only — the text never reaches the screen and text-only posts are left out', async () => {
  const db = freshDb();
  const feed = mkFeed(db);
  await ingest(db, feed, [post('a', 'caption that would get in the way', { media: ['https://cdn.example/a.png'] }), post('b', 'text only, no picture')]);
  const w = { id: 'w2', workspace_id: 'ws1', updated_at: 1, config: '{}' };
  assert.equal(widget.displayOptions({}).show_text, true, 'on by default: existing walls are unchanged');
  assert.equal(widget.displayOptions({ show_text: false }).show_text, false);

  const on = widget.payload(db, w, { feed_id: feed.id });
  assert.deepEqual(on.posts.map((p) => p.k).sort(), ['bluesky:a', 'bluesky:b']);
  assert.ok(on.posts.some((p) => p.t === 'caption that would get in the way'));

  const off = widget.payload(db, w, { feed_id: feed.id, show_text: false });
  assert.deepEqual(off.posts.map((p) => p.k), ['bluesky:a'], 'the text-only post would be an empty card');
  assert.equal(off.posts[0].t, '', 'the caption is not sent at all');
  assert.equal(off.posts[0].m.length, 1, 'the picture is');

  const html = widget.render(db, w, { feed_id: feed.id, show_text: false }, { origin: 'https://st.example' }).html;
  assert.ok(!html.includes('caption that would get in the way'), 'not in the seeded page either');
  assert.match(html, /"showText":false/);
});
