'use strict';

/*
 * The connectors. Each turns one SOURCE (a network + what to read from it) into posts of one shape:
 *
 *   { post_id, author: { name, handle, avatar_url }, text, media: [url…], is_video, permalink, posted_at }
 *
 * `media` holds IMAGE urls only (a video contributes its thumbnail; screens never play a social
 * video). `posted_at` is unix seconds. Text is plain — Mastodon's HTML is flattened here, never
 * passed on. Every connector reads ONE page of at most `limit` posts: a wall shows the latest few,
 * and paging through an account's history would only spend the organization's API quota.
 *
 * fetchSource() returns { posts, complete } — `complete` is true when the source returned fewer
 * than it was asked for, i.e. this is everything it has (lib/social/feeds.js uses that to notice
 * posts deleted at the source).
 */

const { baseFor, getJson, ApiError } = require('./http');
const { secretOf } = require('./connections');

const NETWORKS = ['instagram', 'facebook', 'youtube', 'x', 'bluesky', 'mastodon'];
const NEEDS_CONNECTION = { instagram: true, facebook: true, youtube: true, x: true, bluesky: false, mastodon: false };
// What each network can read, in the order the editor offers them.
const SOURCE_KINDS = {
  instagram: ['own', 'hashtag'],
  facebook: ['page'],
  youtube: ['channel', 'playlist'],
  x: ['account', 'search'],
  bluesky: ['account', 'search'],
  mastodon: ['account', 'hashtag'],
};

const toSec = (v) => {
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.floor(t / 1000) : Math.floor(Date.now() / 1000);
};
const enc = encodeURIComponent;

/* ------------------------------------ Instagram ------------------------------------ */

const IG_FIELDS = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,username,children{media_type,media_url,thumbnail_url}';

function igPost(m, author) {
  const kids = (m.children && Array.isArray(m.children.data)) ? m.children.data : [];
  const items = kids.length ? kids : [m];
  const media = items.map((c) => (c.media_type === 'VIDEO' ? c.thumbnail_url : c.media_url)).filter(Boolean).slice(0, 4);
  return {
    post_id: String(m.id),
    author: { name: m.username || author.name, handle: m.username ? `@${m.username}` : author.handle, avatar_url: m.username ? author.avatar_url : null },
    text: m.caption || '',
    media,
    is_video: m.media_type === 'VIDEO' || m.media_type === 'REELS',
    permalink: m.permalink || null,
    posted_at: toSec(m.timestamp),
  };
}

async function instagram(source, conn, limit) {
  const token = secretOf(conn);
  const cfg = conn.config || {};
  if (cfg.api === 'facebook_login') {
    const base = baseFor('facebook');
    const ig = cfg.ig_user_id;
    if (source.kind === 'hashtag') {
      const tag = source.value.replace(/^#/, '');
      const found = await getJson(`${base}/ig_hashtag_search?user_id=${enc(ig)}&q=${enc(tag)}&access_token=${enc(token)}`);
      const hid = found && found.data && found.data[0] && found.data[0].id;
      if (!hid) return { posts: [], complete: true };
      const r = await getJson(`${base}/${enc(hid)}/recent_media?user_id=${enc(ig)}&fields=${enc(IG_FIELDS.replace('username,', ''))}&limit=${limit}&access_token=${enc(token)}`);
      const data = Array.isArray(r.data) ? r.data : [];
      // Hashtag media carries no author: the wall attributes it to the hashtag.
      return { posts: data.map((m) => igPost(m, { name: `#${tag}`, handle: `#${tag}`, avatar_url: null })), complete: data.length < limit };
    }
    const prof = await getJson(`${base}/${enc(ig)}?fields=username,name,profile_picture_url&access_token=${enc(token)}`);
    const r = await getJson(`${base}/${enc(ig)}/media?fields=${enc(IG_FIELDS)}&limit=${limit}&access_token=${enc(token)}`);
    const data = Array.isArray(r.data) ? r.data : [];
    const author = { name: prof.name || prof.username, handle: `@${prof.username}`, avatar_url: prof.profile_picture_url || null };
    return { posts: data.map((m) => igPost(m, author)), complete: data.length < limit };
  }
  if (source.kind === 'hashtag') throw new ApiError('Hashtags need an Instagram connection that uses Facebook Login.', 0);
  const base = baseFor('instagram');
  const prof = await getJson(`${base}/me?fields=user_id,username,name,profile_picture_url&access_token=${enc(token)}`);
  const r = await getJson(`${base}/me/media?fields=${enc(IG_FIELDS)}&limit=${limit}&access_token=${enc(token)}`);
  const data = Array.isArray(r.data) ? r.data : [];
  const author = { name: prof.name || prof.username, handle: `@${prof.username}`, avatar_url: prof.profile_picture_url || null };
  return { posts: data.map((m) => igPost(m, author)), complete: data.length < limit };
}

/**
 * Refresh an "Instagram Login" long-lived token (60 days) once it is a day old. Facebook Login
 * tokens are Page/system-user tokens that do not expire this way, so they are left alone.
 * Returns { token, expiresAt } when refreshed, or null.
 */
async function refreshInstagramToken(conn, nowSec = Math.floor(Date.now() / 1000)) {
  if (conn.kind !== 'instagram' || (conn.config || {}).api === 'facebook_login') return null;
  const refreshedAt = conn.token_refreshed_at || conn.updated_at || 0;
  if (nowSec - refreshedAt < 24 * 3600) return null;
  const r = await getJson(`${baseFor('instagram')}/refresh_access_token?grant_type=ig_refresh_token&access_token=${enc(secretOf(conn))}`);
  if (!r || typeof r.access_token !== 'string' || !r.access_token) throw new ApiError('the refresh answer had no token', 0);
  return { token: r.access_token, expiresAt: nowSec + (Number(r.expires_in) || 60 * 86400) };
}

/* ------------------------------------ Facebook ------------------------------------- */

async function facebook(source, conn, limit) {
  const token = secretOf(conn);
  const base = baseFor('facebook');
  const page = source.value || (conn.config || {}).page_id;
  if (!/^[0-9]{1,32}$/.test(String(page || ''))) throw new ApiError('Enter the Page id.', 0);
  const prof = await getJson(`${base}/${enc(page)}?fields=name,username,picture{url}&access_token=${enc(token)}`);
  const r = await getJson(`${base}/${enc(page)}/posts?fields=id,message,created_time,permalink_url,full_picture,status_type&limit=${limit}&access_token=${enc(token)}`);
  const data = Array.isArray(r.data) ? r.data : [];
  const author = { name: prof.name, handle: prof.username ? `@${prof.username}` : prof.name, avatar_url: prof.picture && prof.picture.data ? prof.picture.data.url : null };
  return {
    posts: data.map((p) => ({
      post_id: String(p.id), author, text: p.message || '', media: p.full_picture ? [p.full_picture] : [],
      is_video: /video/.test(p.status_type || ''), permalink: p.permalink_url || null, posted_at: toSec(p.created_time),
    })),
    complete: data.length < limit,
  };
}

/* ------------------------------------- YouTube ------------------------------------- */

async function youtube(source, conn, limit) {
  const key = secretOf(conn);
  const base = baseFor('youtube');
  let playlistId = source.value;
  let author = { name: 'YouTube', handle: '', avatar_url: null };
  if (source.kind === 'channel') {
    const v = source.value;
    const q = v.startsWith('@') ? `forHandle=${enc(v)}` : `id=${enc(v)}`;
    const ch = await getJson(`${base}/channels?part=snippet,contentDetails&${q}&key=${enc(key)}`);
    const c = ch.items && ch.items[0];
    if (!c) throw new ApiError('No YouTube channel by that id or handle.', 404);
    playlistId = c.contentDetails && c.contentDetails.relatedPlaylists && c.contentDetails.relatedPlaylists.uploads;
    const th = (c.snippet && c.snippet.thumbnails) || {};
    author = { name: c.snippet.title, handle: c.snippet.customUrl || '', avatar_url: (th.default || th.medium || {}).url || null };
  }
  const r = await getJson(`${base}/playlistItems?part=snippet,contentDetails&maxResults=${limit}&playlistId=${enc(playlistId)}&key=${enc(key)}`);
  const items = Array.isArray(r.items) ? r.items : [];
  const posts = [];
  for (const it of items) {
    const s = it.snippet || {};
    // Private and deleted videos stay in a playlist as placeholders.
    if (!s.resourceId || !s.resourceId.videoId || /^(Private|Deleted) video$/.test(s.title || '')) continue;
    const th = s.thumbnails || {};
    const img = (th.maxres || th.standard || th.high || th.medium || th.default || {}).url;
    posts.push({
      post_id: s.resourceId.videoId,
      author: source.kind === 'channel' ? author : { name: s.videoOwnerChannelTitle || s.channelTitle || 'YouTube', handle: '', avatar_url: null },
      text: s.title || '',
      media: img ? [img] : [],
      is_video: true,
      permalink: `https://www.youtube.com/watch?v=${s.resourceId.videoId}`,
      posted_at: toSec((it.contentDetails && it.contentDetails.videoPublishedAt) || s.publishedAt),
    });
  }
  return { posts, complete: items.length < limit };
}

/* --------------------------------------- X ----------------------------------------- */

function xPosts(r, usersById) {
  const media = new Map(((r.includes && r.includes.media) || []).map((m) => [m.media_key, m]));
  const users = new Map([...(usersById || []), ...((r.includes && r.includes.users) || []).map((u) => [u.id, u])]);
  return (Array.isArray(r.data) ? r.data : []).map((t) => {
    const u = users.get(t.author_id) || {};
    const keys = (t.attachments && t.attachments.media_keys) || [];
    const ms = keys.map((k) => media.get(k)).filter(Boolean);
    return {
      post_id: String(t.id),
      author: { name: u.name || u.username || 'X', handle: u.username ? `@${u.username}` : '', avatar_url: u.profile_image_url || null },
      text: t.text || '',
      media: ms.map((m) => m.url || m.preview_image_url).filter(Boolean).slice(0, 4),
      is_video: ms.some((m) => m.type === 'video' || m.type === 'animated_gif'),
      permalink: u.username ? `https://x.com/${u.username}/status/${t.id}` : null,
      posted_at: toSec(t.created_at),
    };
  });
}

async function x(source, conn, limit) {
  const h = { Authorization: `Bearer ${secretOf(conn)}` };
  const base = baseFor('x');
  const fields = 'tweet.fields=created_at,attachments,author_id&expansions=attachments.media_keys,author_id&media.fields=url,preview_image_url,type&user.fields=name,username,profile_image_url';
  if (source.kind === 'search') {
    const n = Math.max(10, limit);
    const r = await getJson(`${base}/tweets/search/recent?query=${enc(`${source.value} -is:retweet -is:reply`)}&max_results=${n}&${fields}`, { headers: h });
    const posts = xPosts(r).slice(0, limit);
    return { posts, complete: (r.data || []).length < n };
  }
  const user = await getJson(`${base}/users/by/username/${enc(source.value.replace(/^@/, ''))}?user.fields=name,username,profile_image_url`, { headers: h });
  if (!user.data || !user.data.id) throw new ApiError('No X account by that name.', 404);
  const n = Math.max(5, limit);
  const r = await getJson(`${base}/users/${enc(user.data.id)}/tweets?max_results=${n}&exclude=replies,retweets&${fields}`, { headers: h });
  const posts = xPosts(r, [[user.data.id, user.data]]).slice(0, limit);
  return { posts, complete: (r.data || []).length < n };
}

/* ------------------------------------- Bluesky ------------------------------------- */

function bskyPost(p) {
  const rec = p.record || {};
  const e = p.embed || {};
  const view = e.media || e;
  let media = [];
  let isVideo = false;
  if (/app\.bsky\.embed\.images#view/.test(view.$type || '')) media = (view.images || []).map((i) => i.fullsize || i.thumb);
  else if (/app\.bsky\.embed\.video#view/.test(view.$type || '')) { media = view.thumbnail ? [view.thumbnail] : []; isVideo = true; }
  else if (/app\.bsky\.embed\.external#view/.test(view.$type || '') && view.external && view.external.thumb) media = [view.external.thumb];
  const rkey = String(p.uri || '').split('/').pop();
  const a = p.author || {};
  return {
    post_id: String(p.uri || p.cid),
    author: { name: a.displayName || a.handle, handle: a.handle ? `@${a.handle}` : '', avatar_url: a.avatar || null },
    text: rec.text || '',
    media: media.filter(Boolean).slice(0, 4),
    is_video: isVideo,
    permalink: a.handle && rkey ? `https://bsky.app/profile/${a.handle}/post/${rkey}` : null,
    posted_at: toSec(rec.createdAt || p.indexedAt),
  };
}

async function bluesky(source, _conn, limit) {
  const base = baseFor('bluesky');
  if (source.kind === 'search') {
    const r = await getJson(`${base}/app.bsky.feed.searchPosts?q=${enc(source.value)}&limit=${limit}&sort=latest`);
    const posts = (Array.isArray(r.posts) ? r.posts : []).map(bskyPost);
    return { posts, complete: posts.length < limit };
  }
  const r = await getJson(`${base}/app.bsky.feed.getAuthorFeed?actor=${enc(source.value.replace(/^@/, ''))}&limit=${limit}&filter=posts_no_replies`);
  const feed = Array.isArray(r.feed) ? r.feed : [];
  // A repost is someone else's post: the wall shows the account's own.
  const posts = feed.filter((f) => !f.reason && f.post).map((f) => bskyPost(f.post));
  return { posts, complete: feed.length < limit };
}

/* ------------------------------------- Mastodon ------------------------------------ */

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function instanceBase(instance) {
  const test = baseFor('mastodon');
  if (test) return test; // tests only (lib/social/http.js)
  const host = String(instance || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!HOST_RE.test(host)) throw new ApiError('Enter the Mastodon server, for example mastodon.social.', 0);
  return `https://${host}`;
}

/** Mastodon sends HTML. Flatten it to text; the wall never renders a network's markup. */
function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[e.toLowerCase()];
      if (named) return named;
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    })
    .trim();
}

function mastoPost(s) {
  const a = s.account || {};
  const att = Array.isArray(s.media_attachments) ? s.media_attachments : [];
  return {
    post_id: String(s.id),
    author: { name: a.display_name || a.username, handle: a.acct ? `@${a.acct}` : '', avatar_url: a.avatar_static || a.avatar || null },
    text: htmlToText(s.content),
    media: att.map((m) => (m.type === 'image' ? (m.url || m.preview_url) : m.preview_url)).filter(Boolean).slice(0, 4),
    is_video: att.some((m) => m.type === 'video' || m.type === 'gifv'),
    permalink: s.url || null,
    posted_at: toSec(s.created_at),
    // A content warning or a sensitive flag is the author asking not to show it at a glance.
    sensitive: !!(s.sensitive || s.spoiler_text),
    public: s.visibility === undefined || s.visibility === 'public',
  };
}

async function mastodon(source, _conn, limit) {
  const base = instanceBase(source.instance);
  let list;
  if (source.kind === 'hashtag') {
    list = await getJson(`${base}/api/v1/timelines/tag/${enc(source.value.replace(/^#/, ''))}?limit=${limit}`);
  } else {
    const acct = await getJson(`${base}/api/v1/accounts/lookup?acct=${enc(source.value.replace(/^@/, ''))}`);
    if (!acct || !acct.id) throw new ApiError('No Mastodon account by that name.', 404);
    list = await getJson(`${base}/api/v1/accounts/${enc(acct.id)}/statuses?limit=${limit}&exclude_replies=true&exclude_reblogs=true`);
  }
  const arr = Array.isArray(list) ? list : [];
  return { posts: arr.map(mastoPost).filter((p) => p.public && !p.sensitive), complete: arr.length < limit };
}

const FETCHERS = { instagram, facebook, youtube, x, bluesky, mastodon };

async function fetchSource(source, conn, limit) {
  const fn = FETCHERS[source.network];
  if (!fn) throw new ApiError(`Unknown network ${source.network}`, 0);
  if (NEEDS_CONNECTION[source.network] && !conn) throw new ApiError('The connection for this source has been removed.', 0);
  return fn(source, conn, Math.max(1, Math.min(50, limit)));
}

module.exports = { NETWORKS, NEEDS_CONNECTION, SOURCE_KINDS, fetchSource, refreshInstagramToken, htmlToText, instanceBase };
