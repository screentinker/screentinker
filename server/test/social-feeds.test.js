'use strict';

/*
 * Social walls, end to end: a real server, and one local mock standing in for every network's API
 * and CDN (lib/social/http.js honours SOCIAL_API_BASES / SOCIAL_TEST_TRUSTED_ORIGINS in tests only).
 *
 * What has to hold:
 *   - each connector maps its network's answer to the common post shape (reposts, replies,
 *     private/deleted videos and sensitive posts are left out; Mastodon HTML becomes text)
 *   - an Instagram Login token is refreshed once it is a day old, and the new token is used
 *   - a source asks for no more than its limit
 *   - moderation: approve mode queues; hidden stays hidden across refetches; the blocklist hides on
 *     arrival and keeps no text
 *   - a post deleted at the source is purged
 *   - a rev-pinned (cacheable) wall page carries no posts; a hide shows on the next poll; a big fleet
 *     on one wall is not throttled as one caller; saving the blocklist re-checks stored posts
 *   - post text never reaches the page as markup; images come only from this server, only those a
 *     wall's visible posts use, and only if the bytes are an image from an allowed address
 *   - a connection or feed from another organization/workspace cannot be used
 *   - no token appears in any API answer, page or log
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { freePort } = require('./helpers/free-port');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc, BASE, DATA_DIR, LOG, mock, M;
const U = {};
const CONN = {};
let FEED, WIDGET;

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const TOKENS = { ig: 'IGTOKEN-original-abc123', igNew: 'IGTOKEN-refreshed-xyz789', fb: 'FBPAGETOKEN-555', yt: 'YTKEY-777', x: 'XBEARER-999' };
const XSS = '</script><script>window.__pwned=1</script><img src=x onerror="window.__pwned=2">';

// ----------------------------------------------------------------------------------- the mock
const seen = [];          // every request the mock received: { path, query }
const state = {
  bskyFeed: null,         // set in before()
};
function now(offsetSec = 0) { return new Date(Date.now() + offsetSec * 1000).toISOString(); }

function bskyItem(n, extra = {}) {
  return {
    post: {
      uri: `at://did:plc:abc/app.bsky.feed.post/rk${n}`, cid: `c${n}`,
      author: { handle: 'acme.bsky.social', displayName: 'Acme', avatar: `${M}/img/avatar.png` },
      record: { text: `bluesky post ${n}`, createdAt: now(-n * 60) },
      embed: n === 1 ? { $type: 'app.bsky.embed.images#view', images: [{ fullsize: `${M}/img/b${n}.png` }] } : undefined,
      indexedAt: now(-n * 60),
    },
    ...extra,
  };
}

function route(req, res) {
  const u = new URL(req.url, M);
  const q = Object.fromEntries(u.searchParams);
  seen.push({ path: u.pathname, query: q, auth: req.headers.authorization || null });
  const json = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const p = u.pathname;
  // media
  if (p.startsWith('/img/')) {
    if (p === '/img/page.html') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end('<html>not an image</html>'); }
    res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG);
  }
  // Instagram (Instagram Login)
  if (p === '/ig/refresh_access_token') {
    if (q.access_token !== TOKENS.ig) return json({ error: { message: 'bad token' } }, 400);
    return json({ access_token: TOKENS.igNew, token_type: 'bearer', expires_in: 5184000 });
  }
  if (p === '/ig/me') {
    if (![TOKENS.ig, TOKENS.igNew].includes(q.access_token)) return json({ error: { message: 'Invalid OAuth access token' } }, 400);
    return json({ user_id: '1', username: 'acme', name: 'Acme Coffee', profile_picture_url: `${M}/img/igavatar.png` });
  }
  if (p === '/ig/me/media') {
    const lim = Number(q.limit);
    const all = [
      { id: 'ig1', caption: XSS, media_type: 'IMAGE', media_url: `${M}/img/ig1.png`, permalink: 'https://www.instagram.com/p/ig1/', timestamp: now(-100), username: 'acme' },
      { id: 'ig2', caption: 'a reel', media_type: 'VIDEO', media_url: `${M}/v.mp4`, thumbnail_url: `${M}/img/ig2thumb.png`, permalink: 'https://www.instagram.com/reel/ig2/', timestamp: now(-200), username: 'acme' },
      { id: 'ig3', caption: 'hostile image', media_type: 'IMAGE', media_url: 'http://169.254.169.254/latest/meta-data.png', permalink: 'https://www.instagram.com/p/ig3/', timestamp: now(-300), username: 'acme' },
      { id: 'ig4', caption: 'html posing as image', media_type: 'IMAGE', media_url: `${M}/img/page.html`, permalink: 'https://www.instagram.com/p/ig4/', timestamp: now(-400), username: 'acme' },
      { id: 'ig5', caption: 'private address', media_type: 'IMAGE', media_url: 'http://10.0.0.7/a.png', permalink: 'https://www.instagram.com/p/ig5/', timestamp: now(-500), username: 'acme' },
    ];
    return json({ data: all.slice(0, lim) });
  }
  // Facebook
  if (p === '/fb/1234567890') return json({ name: 'Acme Page', username: 'acmepage', picture: { data: { url: `${M}/img/fbavatar.png` } } });
  if (p === '/fb/1234567890/posts') {
    return json({ data: [{ id: '1234567890_1', message: 'Page news', created_time: now(-1000), permalink_url: 'https://www.facebook.com/acmepage/posts/1', full_picture: `${M}/img/fb1.png` }] });
  }
  // YouTube
  if (p === '/yt/channels') {
    if (q.key !== TOKENS.yt) return json({ error: { message: 'API key not valid' } }, 400);
    return json({ items: [{ snippet: { title: 'Acme TV', customUrl: '@acmetv', thumbnails: { default: { url: `${M}/img/ytavatar.png` } } }, contentDetails: { relatedPlaylists: { uploads: 'UUacme0000000000000000' } } }] });
  }
  if (p === '/yt/playlistItems') {
    return json({ items: [
      { snippet: { title: 'How we roast', resourceId: { videoId: 'vid1' }, thumbnails: { high: { url: `${M}/img/yt1.png` } }, publishedAt: now(-2000) }, contentDetails: { videoPublishedAt: now(-2000) } },
      { snippet: { title: 'Private video', resourceId: { videoId: 'vid2' }, thumbnails: {} } },
    ] });
  }
  // X
  if (p === '/x/users/by/username/acme') return json({ data: { id: '42', name: 'Acme', username: 'acme', profile_image_url: `${M}/img/xavatar.png` } });
  if (p === '/x/users/42/tweets') {
    return json({
      data: [{ id: '777', text: 'tweet with a photo', created_at: now(-3000), author_id: '42', attachments: { media_keys: ['m1'] } }],
      includes: { media: [{ media_key: 'm1', type: 'photo', url: `${M}/img/x1.png` }] },
    });
  }
  // Bluesky
  if (p === '/bsky/app.bsky.feed.getAuthorFeed') return json({ feed: state.bskyFeed.slice(0, Number(q.limit)) });
  // Mastodon
  if (p === '/masto/api/v1/accounts/lookup') return json({ id: '9', acct: 'acme' });
  if (p === '/masto/api/v1/accounts/9/statuses') {
    return json([
      { id: 'm1', visibility: 'public', content: '<p>Hello &amp; welcome<br>to the <a href="x">shop</a> &#x1F600;</p>', created_at: now(-4000), url: 'https://mastodon.example/@acme/m1',
        account: { display_name: 'Acme', acct: 'acme@mastodon.example', avatar_static: `${M}/img/mavatar.png` }, media_attachments: [] },
      { id: 'm2', visibility: 'public', sensitive: true, spoiler_text: 'cw', content: '<p>sensitive</p>', created_at: now(-4100), account: { acct: 'acme' }, media_attachments: [] },
      { id: 'm3', visibility: 'unlisted', content: '<p>unlisted</p>', created_at: now(-4200), account: { acct: 'acme' }, media_attachments: [] },
    ]);
  }
  json({ error: 'not mocked', path: p }, 404);
}

// ------------------------------------------------------------------------------------ helpers
const dbh = () => new (require('better-sqlite3'))(path.join(DATA_DIR, 'db', 'remote_display.db'));
const q = (sql, ...a) => { const r = dbh(); try { return r.prepare(sql).all(...a); } finally { r.close(); } };
const q1 = (sql, ...a) => q(sql, ...a)[0];
const run = (sql, ...a) => { const r = dbh(); try { return r.prepare(sql).run(...a); } finally { r.close(); } };

async function api(p, opts = {}) {
  const r = await fetch(BASE + p, opts);
  const buf = Buffer.from(await r.arrayBuffer());
  let body; try { body = JSON.parse(buf.toString()); } catch { body = buf; }
  return { status: r.status, body, headers: r.headers, raw: buf };
}
const J = (who, body, method = 'POST') => ({
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${U[who].token}` },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const G = (who) => ({ headers: { Authorization: `Bearer ${U[who].token}` } });
async function register(name) {
  const r = await api('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${name}@social.test`, password: 'Passw0rd123', name }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  U[name] = { token: r.body.token, id: r.body.user.id, ws: r.body.current_workspace_id };
}
async function refetch(who = 'admin', feedId = FEED) {
  run('UPDATE social_feeds SET last_fetch_at = 0 WHERE id = ?', feedId);
  const r = await api(`/api/social/feeds/${feedId}/refresh`, J(who, {}));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
const posts = (feedId = FEED, status = '') => api(`/api/social/feeds/${feedId}/posts${status ? `?status=${status}` : ''}`, G('admin')).then((r) => r.body.posts);

before(async () => {
  const MP = await freePort();
  M = `http://127.0.0.1:${MP}`;
  mock = http.createServer(route);
  await new Promise((r) => mock.listen(MP, '127.0.0.1', r));
  state.bskyFeed = [bskyItem(1), bskyItem(2), bskyItem(3, { reason: { $type: 'app.bsky.feed.defs#reasonRepost' } })];

  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'social-'));
  LOG = path.join(DATA_DIR, 'server.log');
  const logFd = fs.openSync(LOG, 'a');
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test',
      SOCIAL_API_BASES: JSON.stringify({ instagram: `${M}/ig`, facebook: `${M}/fb`, youtube: `${M}/yt`, x: `${M}/x`, bluesky: `${M}/bsky`, mastodon: `${M}/masto` }),
      SOCIAL_TEST_TRUSTED_ORIGINS: M,
    },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot: ' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  await register('admin');
  await register('other');
});

after(async () => {
  if (proc) proc.kill('SIGKILL');
  if (mock) mock.close();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

// --------------------------------------------------------------------------------------- tests

test('connections are created per network and never echo their token', async () => {
  const mk = async (body) => {
    const r = await api('/api/social/connections', J('admin', body));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.has_secret, true);
    return r.body.id;
  };
  CONN.ig = await mk({ kind: 'instagram', name: 'Acme IG', api: 'instagram_login', secret: TOKENS.ig });
  CONN.fb = await mk({ kind: 'facebook', name: 'Acme Page', page_id: '1234567890', secret: TOKENS.fb });
  CONN.yt = await mk({ kind: 'youtube', name: 'YT key', secret: TOKENS.yt });
  CONN.x = await mk({ kind: 'x', name: 'X', secret: TOKENS.x });
  assert.equal((await api('/api/social/connections', J('admin', { kind: 'facebook', name: 'bad', page_id: 'abc', secret: 'x' }))).status, 400);
  assert.equal((await api('/api/social/connections', J('admin', { kind: 'youtube', name: 'no key' }))).status, 400);
  const list = await api('/api/social/connections', G('admin'));
  const text = list.raw.toString();
  for (const tok of Object.values(TOKENS)) assert.ok(!text.includes(tok), `token ${tok.slice(0, 8)} leaked in the list`);
  // stored encrypted
  const row = q1('SELECT secret_enc FROM social_connections WHERE id = ?', CONN.ig);
  assert.ok(row.secret_enc && !row.secret_enc.includes(TOKENS.ig));
  // the test button reads through the connection
  const t = await api(`/api/social/connections/${CONN.yt}/test`, J('admin', {}));
  assert.equal(t.body.ok, true, JSON.stringify(t.body));
});

test('another organization cannot use these connections', async () => {
  const r = await api('/api/social/feeds', J('other', { name: 'steal', sources: [{ network: 'youtube', kind: 'channel', value: '@acmetv', connection_id: CONN.yt }] }));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /connections/);
  assert.equal((await api(`/api/social/connections/${CONN.yt}/test`, J('other', {}))).status, 404);
});

test('a feed with every network maps each answer to one post shape', async () => {
  // Make the Instagram token a day old, so the first fetch refreshes it.
  run('UPDATE social_connections SET token_refreshed_at = ? WHERE id = ?', Math.floor(Date.now() / 1000) - 2 * 86400, CONN.ig);
  const r = await api('/api/social/feeds', J('admin', { name: 'Lobby', sources: [
    { network: 'instagram', kind: 'own', connection_id: CONN.ig, limit: 5 },
    { network: 'facebook', kind: 'page', value: '', connection_id: CONN.fb },
    { network: 'youtube', kind: 'channel', value: '@acmetv', connection_id: CONN.yt },
    { network: 'x', kind: 'account', value: '@acme', connection_id: CONN.x },
    { network: 'bluesky', kind: 'account', value: 'acme.bsky.social', limit: 3 },
    { network: 'mastodon', kind: 'account', value: 'acme', instance: 'mastodon.example' },
  ] }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  FEED = r.body.id;
  for (let i = 0; i < 80 && !q1('SELECT last_fetch_at FROM social_feeds WHERE id = ?', FEED).last_fetch_at; i++) await sleep(100);
  const feed = await api(`/api/social/feeds/${FEED}`, G('admin'));
  assert.equal(feed.body.last_error, null, JSON.stringify(feed.body.last_error));

  const all = await posts();
  const by = (k) => all.find((p) => p.key === k);
  assert.ok(by('instagram:ig1') && by('instagram:ig2'), 'instagram posts');
  assert.equal(by('instagram:ig2').is_video, true);
  assert.equal(by('instagram:ig2').media.length, 1, 'a video contributes its thumbnail');
  assert.equal(by('instagram:ig1').author_handle, '@acme');
  assert.equal(by('facebook:1234567890_1').author_name, 'Acme Page');
  assert.ok(by('youtube:vid1') && !by('youtube:vid2'), 'private videos are left out');
  assert.equal(by('youtube:vid1').permalink, 'https://www.youtube.com/watch?v=vid1');
  assert.equal(by('x:777').media.length, 1);
  assert.equal(by('x:777').permalink, 'https://x.com/acme/status/777');
  assert.ok(by('bluesky:at://did:plc:abc/app.bsky.feed.post/rk1'), 'bluesky post');
  assert.ok(!by('bluesky:at://did:plc:abc/app.bsky.feed.post/rk3'), 'a repost is left out');
  assert.equal(by('bluesky:at://did:plc:abc/app.bsky.feed.post/rk1').permalink, 'https://bsky.app/profile/acme.bsky.social/post/rk1');
  const m1 = by('mastodon:m1');
  assert.equal(m1.text, 'Hello & welcome\nto the shop 😀', 'Mastodon HTML flattened to text');
  assert.ok(!by('mastodon:m2') && !by('mastodon:m3'), 'sensitive and non-public statuses are left out');
});

test('an Instagram Login token is refreshed once a day old, and the new one is used', async () => {
  assert.ok(seen.some((s) => s.path === '/ig/refresh_access_token'), 'refresh was called');
  const after = seen.slice(seen.findIndex((s) => s.path === '/ig/refresh_access_token') + 1).filter((s) => s.path.startsWith('/ig/me'));
  assert.ok(after.length && after.every((s) => s.query.access_token === TOKENS.igNew), 'later reads use the refreshed token');
  const row = q1('SELECT token_expires_at, token_refreshed_at, last_error FROM social_connections WHERE id = ?', CONN.ig);
  assert.ok(row.token_expires_at > Date.now() / 1000 + 50 * 86400);
  assert.equal(row.last_error, null);
  // Not again within a day.
  const n = seen.filter((s) => s.path === '/ig/refresh_access_token').length;
  await refetch();
  assert.equal(seen.filter((s) => s.path === '/ig/refresh_access_token').length, n);
});

test('a source asks for no more than its limit', async () => {
  const ig = seen.filter((s) => s.path === '/ig/me/media');
  assert.ok(ig.length && ig.every((s) => s.query.limit === '5'));
  const b = seen.filter((s) => s.path === '/bsky/app.bsky.feed.getAuthorFeed');
  assert.ok(b.length && b.every((s) => s.query.limit === '3'));
  assert.ok(seen.filter((s) => s.path === '/x/users/42/tweets').every((s) => Number(s.query.max_results) <= 100));
});

test('images: only real images from allowed addresses are kept', async () => {
  const all = await posts();
  const by = (k) => all.find((p) => p.key === k);
  assert.equal(by('instagram:ig1').media.length, 1, 'a real PNG from the mock CDN');
  assert.equal(by('instagram:ig3').media.length, 0, 'the metadata address is refused');
  assert.equal(by('instagram:ig5').media.length, 0, 'a private address is refused');
  assert.equal(by('instagram:ig4').media.length, 0, 'HTML labelled image/png is not an image');
  const files = fs.readdirSync(path.join(DATA_DIR, 'social-media'));
  for (const f of files) assert.ok(fs.readFileSync(path.join(DATA_DIR, 'social-media', f)).slice(0, 8).equals(PNG.slice(0, 8)));
});

test('a wall widget renders posts as data, never markup, with images from this server only', async () => {
  const bad = await api('/api/widgets', J('other', { widget_type: 'social', name: 'x', config: { feed_id: FEED } }));
  assert.equal(bad.status, 400, 'a feed from another workspace cannot be shown');
  const w = await api('/api/widgets', J('admin', { widget_type: 'social', name: 'Lobby wall', config: { feed_id: FEED, layout: 'grid' } }));
  assert.ok(w.status === 200 || w.status === 201, JSON.stringify(w.body));
  WIDGET = w.body.id;
  const page = await api(`/api/widgets/${WIDGET}/render`);
  assert.equal(page.status, 200);
  const html = page.raw.toString();
  assert.ok(!html.includes('<script>window.__pwned'), 'post text never becomes a script');
  assert.ok(!html.includes('<img src=x'), 'post text never becomes an element');
  assert.ok(html.includes('\\u003c/script\\u003e'), 'it travels escaped');
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, new RegExp(`img-src ${BASE.replace(/[.]/g, '\\.')} data:`));
  assert.match(csp, new RegExp(`connect-src ${BASE.replace(/[.]/g, '\\.')}`));
  for (const tok of Object.values(TOKENS)) assert.ok(!html.includes(tok));

  const data = await api(`/api/widgets/${WIDGET}/social.json`);
  assert.equal(data.status, 200);
  assert.ok(data.body.posts.length >= 6);
  const withImg = data.body.posts.find((p) => p.m.length);
  assert.match(withImg.m[0], new RegExp(`^/api/widgets/${WIDGET}/social-media/[0-9a-f]{64}$`));
  const img = await api(withImg.m[0]);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(img.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.equal((await api(`/api/widgets/${WIDGET}/social-media/${'0'.repeat(64)}`)).status, 404, 'not an arbitrary file server');
  assert.equal((await api(`/api/widgets/${WIDGET}/social-media/..%2f..%2fdb`)).status, 404);
});

test('a rev-pinned wall page carries no posts: a hide shows on the next load', async () => {
  const k = 'bluesky:at://did:plc:abc/app.bsky.feed.post/rk2';
  const pinned = await api(`/api/widgets/${WIDGET}/render?rev=1`);
  assert.equal(pinned.status, 200);
  assert.match(pinned.headers.get('cache-control'), /immutable/);
  assert.ok(!pinned.raw.toString().includes('bluesky post 2'), 'nothing cached for a year that a hide could not take back');
  assert.ok((await api(`/api/widgets/${WIDGET}/render`)).raw.toString().includes('bluesky post 2'), 'the no-store page is seeded');
  assert.ok((await api(`/api/widgets/${WIDGET}/social.json`)).body.posts.some((p) => p.k === k));
  assert.equal((await api(`/api/social/feeds/${FEED}/posts/moderate`, J('admin', { key: k, action: 'hide' }))).status, 200);
  assert.ok(!(await api(`/api/widgets/${WIDGET}/social.json`)).body.posts.some((p) => p.k === k), 'gone on the very next poll');
  await api(`/api/social/feeds/${FEED}/posts/moderate`, J('admin', { key: k, action: 'unhide' }));
});

test('a large fleet polling one wall gets 200s; one address is bounded on its own', async () => {
  const from = (ip) => ({ headers: { 'X-Forwarded-For': ip } });
  const codes = await Promise.all(Array.from({ length: 300 }, (_, i) => api(`/api/widgets/${WIDGET}/social.json`, from(`198.51.100.${i % 250}`)).then((r) => r.status)));
  assert.deepEqual([...new Set(codes)], [200], 'past the old fleet-wide 60/min');
  let last = 0;
  for (let i = 0; i < 601; i++) last = (await api(`/api/widgets/${WIDGET}/social.json`, from('203.0.113.9'))).status;
  assert.equal(last, 429, 'one address past its own budget');
  assert.equal((await api(`/api/widgets/${WIDGET}/social.json`, from('203.0.113.10'))).status, 200, 'without spending the wall\'s');
});

test('moderation: approve mode queues, hidden stays hidden, the blocklist hides on arrival', async () => {
  const f = await api('/api/social/feeds', J('admin', { name: 'Moderated', moderation: 'approve', blocklist: 'Roast, spam',
    sources: [{ network: 'youtube', kind: 'channel', value: '@acmetv', connection_id: CONN.yt }, { network: 'bluesky', kind: 'account', value: 'acme.bsky.social' }] }));
  assert.equal(f.status, 201);
  const fid = f.body.id;
  for (let i = 0; i < 80 && !q1('SELECT last_fetch_at FROM social_feeds WHERE id = ?', fid).last_fetch_at; i++) await sleep(100);
  const w = await api('/api/widgets', J('admin', { widget_type: 'social', name: 'Mod wall', config: { feed_id: fid } }));
  const wid = w.body.id;
  const shown = async () => (await api(`/api/widgets/${wid}/social.json`)).body.posts.map((p) => p.k);
  assert.deepEqual(await shown(), [], 'nothing is shown before approval');
  const pend = await posts(fid, 'pending');
  assert.ok(pend.length >= 2);
  const blocked = (await posts(fid, 'hidden')).find((p) => p.key === 'youtube:vid1');
  assert.ok(blocked, '"How we roast" is hidden by the blocklist');
  assert.equal(blocked.hidden_reason, 'blocklist');
  assert.equal(blocked.text, null, 'its text is not kept');

  const k1 = 'bluesky:at://did:plc:abc/app.bsky.feed.post/rk1';
  const k2 = 'bluesky:at://did:plc:abc/app.bsky.feed.post/rk2';
  assert.equal((await api(`/api/social/feeds/${fid}/posts/moderate`, J('admin', { key: k1, action: 'approve' }))).status, 200);
  assert.equal((await api(`/api/social/feeds/${fid}/posts/moderate`, J('admin', { key: k2, action: 'approve' }))).status, 200);
  assert.deepEqual((await shown()).sort(), [k1, k2].sort());
  assert.equal((await api(`/api/social/feeds/${fid}/posts/moderate`, J('admin', { key: k2, action: 'hide' }))).status, 200);
  assert.deepEqual(await shown(), [k1]);
  await refetch('admin', fid);
  assert.deepEqual(await shown(), [k1], 'a refetch does not bring a hidden post back');
  assert.equal((await posts(fid, 'hidden')).find((p) => p.key === k2).status, 'hidden');
  // Undo.
  await api(`/api/social/feeds/${fid}/posts/moderate`, J('admin', { key: k2, action: 'unhide' }));
  assert.deepEqual((await shown()).sort(), [k1, k2].sort());
  // A viewer-less editor check: another org's user cannot moderate this feed.
  assert.equal((await api(`/api/social/feeds/${fid}/posts/moderate`, J('other', { key: k1, action: 'hide' }))).status, 404);
});

test('saving the blocklist hides stored posts that match it', async () => {
  const k = 'mastodon:m1';
  assert.ok((await api(`/api/widgets/${WIDGET}/social.json`)).body.posts.some((p) => p.k === k));
  const r = await api(`/api/social/feeds/${FEED}`, J('admin', { blocklist: 'ｗｅｌｃｏｍｅ' }, 'PUT'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const hid = (await posts(FEED, 'hidden')).find((p) => p.key === k);
  assert.ok(hid, 'hidden without a refetch (and through a fullwidth entry)');
  assert.equal(hid.hidden_reason, 'blocklist');
  assert.equal(hid.text, null);
  assert.ok(!(await api(`/api/widgets/${WIDGET}/social.json`)).body.posts.some((p) => p.k === k));
  await api(`/api/social/feeds/${FEED}`, J('admin', { blocklist: '' }, 'PUT'));
});

test('a post deleted at the source is purged', async () => {
  const k = 'bluesky:at://did:plc:abc/app.bsky.feed.post/rk2';
  assert.ok((await posts()).some((p) => p.key === k));
  state.bskyFeed = [bskyItem(1)];   // rk2 deleted by its author; the answer is now complete
  await refetch();
  assert.ok(!(await posts()).some((p) => p.key === k), 'gone from the feed');
  assert.ok((await posts()).some((p) => p.key === 'bluesky:at://did:plc:abc/app.bsky.feed.post/rk1'), 'the rest stay');
});

test('filters apply at display time: only posts with a picture, max age', async () => {
  await api(`/api/social/feeds/${FEED}`, J('admin', { require_media: true }, 'PUT'));
  const d = await api(`/api/widgets/${WIDGET}/social.json`);
  assert.ok(d.body.posts.length > 0 && d.body.posts.every((p) => p.m.length > 0));
  run('UPDATE social_posts SET posted_at = ? WHERE feed_id = ? AND post_id = ?', Math.floor(Date.now() / 1000) - 40 * 86400, FEED, 'ig1');
  await api(`/api/social/feeds/${FEED}`, J('admin', { require_media: false, max_age_days: 30 }, 'PUT'));
  const d2 = await api(`/api/widgets/${WIDGET}/social.json`);
  assert.ok(!d2.body.posts.some((p) => p.k === 'instagram:ig1'));
});

test('no token reached the log', () => {
  const log = fs.readFileSync(LOG, 'utf8');
  for (const tok of [TOKENS.ig, TOKENS.igNew, TOKENS.fb, TOKENS.yt, TOKENS.x]) assert.ok(!log.includes(tok), `${tok.slice(0, 8)} in the log`);
});
