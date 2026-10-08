'use strict';

/*
 * Social feeds: what a wall shows, and the moderation in front of it.
 *
 * A FEED belongs to a workspace and has up to 10 SOURCES (a network and what to read from it: an
 * account, a hashtag, a Page, a channel…). The poller fetches each feed on its own schedule and
 * stores the posts; a wall widget (lib/social/widget.js) shows the visible ones.
 *
 * MODERATION
 *   - mode 'auto': a new post is shown at once; 'approve': it waits in the dashboard's queue.
 *   - a post matching the blocklist is hidden on arrival.
 *   - ⚠️ A HIDDEN POST STAYS HIDDEN. Refetching never changes a post's status — only a person does.
 *     Its row is kept precisely so the next fetch recognises it: with its content for 30 days (so a
 *     moderator can review and undo), then as a bare marker for up to 90 days after it was last seen.
 *   - "only posts with images" and "max age" are filters at display time, so changing them takes
 *     effect at once without refetching.
 *
 * DELETED AT THE SOURCE: when a source answers, a stored post from it that falls inside the window
 * the answer covers but is missing from it was deleted (or made private) by its author, and is
 * purged — the wall must not keep showing something its author took down.
 *
 * ⚠️ ONE FETCH PER FEED, CLUSTER-WIDE: a fetch begins by moving next_fetch_at forward in a
 * conditional UPDATE, so of several server nodes only the one whose UPDATE changed the row fetches.
 */

const crypto = require('crypto');
const networks = require('./networks');
const connections = require('./connections');
const media = require('./media');

const MODES = ['auto', 'approve'];
const MAX_SOURCES = 10;
const MAX_TEXT = 1000;
const TICK_MS = 60 * 1000;
const MAX_BACKOFF_SEC = 2 * 3600;

class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const now = () => Math.floor(Date.now() / 1000);
const parse = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };
const intIn = (v, lo, hi, def) => {
  if (v === undefined || v === null || v === '') return def;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
};

/* ------------------------------------- input ------------------------------------- */

function normaliseSource(raw, db, orgId) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const network = String(s.network || '');
  if (!networks.NETWORKS.includes(network)) throw new InputError('Choose a network for each source.');
  const kinds = networks.SOURCE_KINDS[network];
  const kind = kinds.includes(s.kind) ? s.kind : kinds[0];
  const value = String(s.value || '').trim().slice(0, 200);
  const out = { network, kind, value };
  if (networks.NEEDS_CONNECTION[network]) {
    const conn = connections.forOrg(db, orgId, s.connection_id);
    if (!conn || conn.kind !== network) throw new InputError(`Choose one of your organization's ${network} connections (Settings → Social connections).`);
    out.connection_id = conn.id;
    if (network === 'instagram' && kind === 'hashtag' && conn.config.api !== 'facebook_login') {
      throw new InputError('Instagram hashtags need a connection that uses Facebook Login.');
    }
  }
  const needsValue = !(network === 'instagram' && kind === 'own') && !(network === 'facebook');
  if (needsValue && !value) throw new InputError('Each source needs an account, hashtag or channel.');
  if (/[\u0000-\u001f<>]/.test(value)) throw new InputError('That account or hashtag contains characters it cannot have.');
  if (network === 'facebook' && value && !/^[0-9]{1,32}$/.test(value)) throw new InputError('A Facebook source is a Page id (a number), or empty for the connection’s Page.');
  if (network === 'youtube' && kind === 'channel' && !/^(UC[A-Za-z0-9_-]{22}|@[A-Za-z0-9._-]{3,100})$/.test(value)) {
    throw new InputError('A YouTube channel is its id (UC…) or its @handle.');
  }
  if (network === 'youtube' && kind === 'playlist' && !/^[A-Za-z0-9_-]{10,64}$/.test(value)) throw new InputError('That is not a YouTube playlist id.');
  if (network === 'mastodon') {
    try { networks.instanceBase(s.instance); } catch (e) { throw new InputError(e.message); }
    out.instance = String(s.instance || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
  out.limit = intIn(s.limit, 1, 50, 20);
  return out;
}

const sourceKey = (s) => crypto.createHash('sha1').update(JSON.stringify([s.network, s.kind, s.value.toLowerCase(), s.instance || '', s.connection_id || ''])).digest('hex').slice(0, 16);

function normaliseBlocklist(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[\n,]/);
  return [...new Set(arr.map((w) => String(w).trim().toLowerCase()).filter(Boolean))].slice(0, 200).map((w) => w.slice(0, 60));
}

/** Validate a create/update body. `existing` keeps omitted fields. */
function normaliseInput(db, orgId, body, existing = null) {
  const b = body || {};
  const prev = existing || {};
  const name = String(b.name !== undefined ? b.name : (prev.name || '')).trim().slice(0, 80);
  if (!name) throw new InputError('A name is required.');
  const rawSources = b.sources !== undefined ? b.sources : parse(prev.sources, []);
  if (!Array.isArray(rawSources) || rawSources.length === 0) throw new InputError('Add at least one source.');
  if (rawSources.length > MAX_SOURCES) throw new InputError(`A feed can have at most ${MAX_SOURCES} sources.`);
  const sources = rawSources.map((s) => normaliseSource(s, db, orgId));
  return {
    name,
    sources,
    moderation: MODES.includes(b.moderation) ? b.moderation : (prev.moderation || 'auto'),
    blocklist: b.blocklist !== undefined ? normaliseBlocklist(b.blocklist) : parse(prev.blocklist, []),
    require_media: b.require_media !== undefined ? (b.require_media ? 1 : 0) : (prev.require_media || 0),
    max_age_days: b.max_age_days !== undefined ? intIn(b.max_age_days, 0, 3650, 0) : (prev.max_age_days || 0),
    max_posts: b.max_posts !== undefined ? intIn(b.max_posts, 1, 50, 20) : (prev.max_posts || 20),
    refresh_min: b.refresh_min !== undefined ? intIn(b.refresh_min, 5, 1440, 10) : (prev.refresh_min || 10),
    enabled: b.enabled !== undefined ? (b.enabled ? 1 : 0) : (existing ? prev.enabled : 1),
  };
}

function create(db, workspaceId, userId, input) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO social_feeds (id, workspace_id, created_by, name, sources, moderation, blocklist, require_media, max_age_days, max_posts, refresh_min, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, workspaceId, userId || null, input.name, JSON.stringify(input.sources), input.moderation,
    JSON.stringify(input.blocklist), input.require_media, input.max_age_days, input.max_posts, input.refresh_min, input.enabled);
  return db.prepare('SELECT * FROM social_feeds WHERE id = ?').get(id);
}

function update(db, row, input) {
  db.prepare(`UPDATE social_feeds SET name = ?, sources = ?, moderation = ?, blocklist = ?, require_media = ?, max_age_days = ?,
      max_posts = ?, refresh_min = ?, enabled = ?, next_fetch_at = CASE WHEN sources != ? THEN 0 ELSE next_fetch_at END,
      updated_at = MAX(updated_at + 1, strftime('%s','now')) WHERE id = ?`)
    .run(input.name, JSON.stringify(input.sources), input.moderation, JSON.stringify(input.blocklist), input.require_media,
      input.max_age_days, input.max_posts, input.refresh_min, input.enabled, JSON.stringify(input.sources), row.id);
  return db.prepare('SELECT * FROM social_feeds WHERE id = ?').get(row.id);
}

function present(row, db) {
  const counts = db ? db.prepare('SELECT status, COUNT(*) AS n FROM social_posts WHERE feed_id = ? GROUP BY status').all(row.id) : [];
  const c = Object.fromEntries(counts.map((r) => [r.status, r.n]));
  return {
    id: row.id, name: row.name, sources: parse(row.sources, []), moderation: row.moderation, blocklist: parse(row.blocklist, []),
    require_media: !!row.require_media, max_age_days: row.max_age_days, max_posts: row.max_posts, refresh_min: row.refresh_min,
    enabled: !!row.enabled, last_fetch_at: row.last_fetch_at, last_error: parse(row.last_error, null),
    counts: { approved: c.approved || 0, pending: c.pending || 0, hidden: c.hidden || 0 },
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

function forWorkspace(db, workspaceId, id) {
  if (!workspaceId || !id) return null;
  return db.prepare('SELECT * FROM social_feeds WHERE id = ? AND workspace_id = ?').get(String(id), workspaceId) || null;
}

/* -------------------------------------- ingest -------------------------------------- */

/** Whole-word, case-insensitive match against the blocklist (also matches #word and @word). */
function blocked(text, words) {
  if (!words || !words.length) return false;
  const hay = ` ${String(text || '').toLowerCase()} `;
  return words.some((w) => {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}_])[#@]?${esc}($|[^\\p{L}\\p{N}_])`, 'u').test(hay);
  });
}

// Controls and stray markup are not ours to keep: the wall renders text with textContent, and this
// keeps the stored copy plain too.
const cleanText = (s) => String(s || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, '').slice(0, MAX_TEXT);
const cleanShort = (s, n = 120) => cleanText(s).replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Store one source's answer. Returns { added, updated, purged }.
 * `cacheImage(url)` resolves to a media hash or null (lib/social/media.js cache).
 */
async function ingest(db, feed, source, result, cacheImage) {
  const key = sourceKey(source);
  const words = parse(feed.blocklist, []);
  const t = now();
  let added = 0; let updated = 0;
  const seen = new Set();
  const getRow = db.prepare('SELECT status FROM social_posts WHERE feed_id = ? AND network = ? AND post_id = ?');
  for (const p of (result.posts || []).slice(0, 50)) {
    if (!p || !p.post_id) continue;
    const postId = String(p.post_id).slice(0, 200);
    seen.add(postId);
    const existing = getRow.get(feed.id, source.network, postId);
    if (existing && existing.status === 'hidden') {
      db.prepare('UPDATE social_posts SET last_seen_at = ? WHERE feed_id = ? AND network = ? AND post_id = ?').run(t, feed.id, source.network, postId);
      continue;
    }
    const text = cleanText(p.text);
    const author = p.author || {};
    const isBlocked = blocked(`${text} ${author.name || ''} ${author.handle || ''}`, words);
    // Images are only fetched for something that will be kept visible or queued.
    const mediaHashes = [];
    if (!isBlocked) {
      for (const u of (p.media || []).slice(0, 4)) { const h = await cacheImage(u); if (h) mediaHashes.push(h); }
    }
    const avatar = !isBlocked && author.avatar_url ? await cacheImage(author.avatar_url) : null;
    const fields = [cleanShort(author.name) || null, cleanShort(author.handle, 80) || null, avatar, isBlocked ? null : text,
      JSON.stringify(mediaHashes), p.is_video ? 1 : 0, typeof p.permalink === 'string' && /^https:\/\//.test(p.permalink) ? p.permalink.slice(0, 500) : null,
      Number.isFinite(p.posted_at) ? Math.floor(p.posted_at) : t];
    if (existing) {
      db.prepare(`UPDATE social_posts SET author_name = ?, author_handle = ?, author_avatar = ?, text = ?, media = ?, is_video = ?, permalink = ?,
          posted_at = ?, last_seen_at = ? WHERE feed_id = ? AND network = ? AND post_id = ?`).run(...fields, t, feed.id, source.network, postId);
      updated++;
    } else {
      const status = isBlocked ? 'hidden' : (feed.moderation === 'approve' ? 'pending' : 'approved');
      db.prepare(`INSERT INTO social_posts (feed_id, network, post_id, source_key, status, hidden_reason, author_name, author_handle, author_avatar,
          text, media, is_video, permalink, posted_at, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(feed.id, source.network, postId, key, status, isBlocked ? 'blocklist' : null, ...fields, t, t);
      added++;
    }
  }
  // Deleted at the source: missing from an answer that covers its time.
  let purged = 0;
  const returned = (result.posts || []).filter((p) => p && p.post_id);
  if (returned.length || result.complete) {
    const oldest = result.complete ? -Infinity : Math.min(...returned.map((p) => (Number.isFinite(p.posted_at) ? p.posted_at : t)));
    const stored = db.prepare('SELECT post_id, posted_at FROM social_posts WHERE feed_id = ? AND network = ? AND source_key = ?').all(feed.id, source.network, key);
    for (const r of stored) {
      if (seen.has(r.post_id) || r.posted_at < oldest) continue;
      db.prepare('DELETE FROM social_posts WHERE feed_id = ? AND network = ? AND post_id = ?').run(feed.id, source.network, r.post_id);
      purged++;
    }
  }
  return { added, updated, purged };
}

/** Keep a feed's storage bounded: the newest posts it can show, plus every hidden marker. */
function prune(db, feed) {
  const keep = Math.max(60, (feed.max_posts || 20) * 3);
  db.prepare(`DELETE FROM social_posts WHERE feed_id = ? AND status != 'hidden' AND rowid NOT IN (
      SELECT rowid FROM social_posts WHERE feed_id = ? AND status != 'hidden' ORDER BY posted_at DESC LIMIT ?)`).run(feed.id, feed.id, keep);
  if (feed.max_age_days > 0) {
    db.prepare("DELETE FROM social_posts WHERE feed_id = ? AND status != 'hidden' AND posted_at < ?").run(feed.id, now() - feed.max_age_days * 86400 - 86400);
  }
  // A hidden post's content is kept 30 days (so it can be reviewed and undone), then only its identity.
  db.prepare(`UPDATE social_posts SET text = NULL, media = '[]', author_avatar = NULL
      WHERE feed_id = ? AND status = 'hidden' AND text IS NOT NULL AND first_seen_at < ?`).run(feed.id, now() - 30 * 86400);
  // A hidden marker only needs to outlive the post's chance of being refetched.
  db.prepare("DELETE FROM social_posts WHERE feed_id = ? AND status = 'hidden' AND last_seen_at < ?").run(feed.id, now() - 90 * 86400);
}

/* --------------------------------------- read --------------------------------------- */

/** The posts a wall shows, newest first. */
function visiblePosts(db, feed, limit = null) {
  const n = Math.max(1, Math.min(50, limit || feed.max_posts || 20));
  const minAt = feed.max_age_days > 0 ? now() - feed.max_age_days * 86400 : 0;
  const rows = db.prepare(`SELECT * FROM social_posts WHERE feed_id = ? AND status = 'approved' AND posted_at >= ?
      ${feed.require_media ? "AND media IS NOT NULL AND media != '[]'" : ''} ORDER BY posted_at DESC LIMIT ?`).all(feed.id, minAt, n);
  return rows;
}

function presentPost(r) {
  return {
    key: `${r.network}:${r.post_id}`, network: r.network, post_id: r.post_id, status: r.status, hidden_reason: r.hidden_reason,
    author_name: r.author_name, author_handle: r.author_handle, author_avatar: r.author_avatar, text: r.text,
    media: parse(r.media, []), is_video: !!r.is_video, permalink: r.permalink, posted_at: r.posted_at,
  };
}

/** approve | hide | unhide one post. Hiding drops what was stored about it except its identity. */
function moderate(db, feed, network, postId, action) {
  const row = db.prepare('SELECT * FROM social_posts WHERE feed_id = ? AND network = ? AND post_id = ?').get(feed.id, network, postId);
  if (!row) return null;
  if (action === 'approve' || action === 'unhide') {
    if (row.status === 'hidden' && row.text === null) {
      // Its content was dropped (blocklisted, or hidden over 30 days ago): forget the marker and let
      // the next fetch bring it back as a new post.
      db.prepare('DELETE FROM social_posts WHERE feed_id = ? AND network = ? AND post_id = ?').run(feed.id, network, postId);
      db.prepare('UPDATE social_feeds SET next_fetch_at = 0 WHERE id = ?').run(feed.id);
      return { ...row, status: 'refetch' };
    }
    db.prepare("UPDATE social_posts SET status = 'approved', hidden_reason = NULL WHERE feed_id = ? AND network = ? AND post_id = ?").run(feed.id, network, postId);
  } else if (action === 'hide') {
    // Kept for a while so a moderator can see what was hidden and undo it (prune drops it later).
    db.prepare(`UPDATE social_posts SET status = 'hidden', hidden_reason = 'moderator', first_seen_at = ?
        WHERE feed_id = ? AND network = ? AND post_id = ?`).run(now(), feed.id, network, postId);
  } else return null;
  return db.prepare('SELECT * FROM social_posts WHERE feed_id = ? AND network = ? AND post_id = ?').get(feed.id, network, postId);
}

/* ------------------------------------- fetching ------------------------------------- */

let io = null;
let timer = null;
const inFlight = new Set();

/** Claim a feed for fetching (cluster-wide, see the header). True if this node should fetch it. */
function claim(db, feed, force) {
  const t = now();
  const next = t + Math.max(5, feed.refresh_min || 10) * 60;
  const r = force
    ? db.prepare('UPDATE social_feeds SET next_fetch_at = ? WHERE id = ?').run(next, feed.id)
    : db.prepare('UPDATE social_feeds SET next_fetch_at = ? WHERE id = ? AND next_fetch_at <= ? AND enabled = 1').run(next, feed.id, t);
  return r.changes === 1;
}

async function refreshConnectionToken(db, conn) {
  try {
    const out = await networks.refreshInstagramToken(conn);
    if (!out) return conn;
    const encd = require('../secretbox').encrypt(out.token);
    db.prepare('UPDATE social_connections SET secret_enc = ?, token_expires_at = ?, token_refreshed_at = ?, last_error = NULL WHERE id = ?')
      .run(encd, out.expiresAt, now(), conn.id);
    return { ...conn, secret_enc: encd, token_expires_at: out.expiresAt, token_refreshed_at: now() };
  } catch (e) {
    db.prepare('UPDATE social_connections SET last_error = ? WHERE id = ?').run(`token refresh failed: ${String(e.message).slice(0, 200)}`, conn.id);
    return conn; // the current token may still be good for weeks
  }
}

/**
 * Fetch every source of a feed now and store what came back. Returns a summary.
 * Never throws for a source's failure: that is recorded on the feed and the others still run.
 */
async function fetchFeed(db, feedId, { force = false, cacheImage = null } = {}) {
  const feed = db.prepare('SELECT * FROM social_feeds WHERE id = ?').get(feedId);
  if (!feed) return null;
  if (inFlight.has(feed.id)) return { skipped: 'in_flight' };
  if (!claim(db, feed, force)) return { skipped: 'not_due' };
  inFlight.add(feed.id);
  const img = cacheImage || ((u) => media.cache(db, u));
  const orgId = connections.orgOfWorkspace(db, feed.workspace_id);
  const errors = [];
  const totals = { added: 0, updated: 0, purged: 0 };
  let okCount = 0;
  try {
    const sources = parse(feed.sources, []);
    for (const s of sources) {
      try {
        let conn = null;
        if (networks.NEEDS_CONNECTION[s.network]) {
          conn = connections.forOrg(db, orgId, s.connection_id);
          if (conn) conn = await refreshConnectionToken(db, conn);
        }
        const result = await networks.fetchSource(s, conn, s.limit || 20);
        const r = await ingest(db, feed, s, result, img);
        totals.added += r.added; totals.updated += r.updated; totals.purged += r.purged;
        okCount++;
      } catch (e) {
        errors.push({ network: s.network, value: s.value, error: String(e.message || e).slice(0, 240) });
      }
    }
    prune(db, feed);
    const allFailed = sources.length > 0 && okCount === 0;
    const fails = allFailed ? (feed.fail_count || 0) + 1 : 0;
    // Back off only when nothing worked: one broken source must not slow the others.
    const next = allFailed ? now() + Math.min(MAX_BACKOFF_SEC, (feed.refresh_min || 10) * 60 * 2 ** Math.min(fails, 6)) : null;
    db.prepare(`UPDATE social_feeds SET last_fetch_at = ?, last_error = ?, fail_count = ?${next ? ', next_fetch_at = ?' : ''} WHERE id = ?`)
      .run(...[now(), errors.length ? JSON.stringify(errors) : null, fails, ...(next ? [next] : []), feed.id]);
    if (totals.added || totals.purged || totals.updated) notifyScreens(db, feed.id);
    return { ...totals, errors, sources: sources.length };
  } finally {
    inFlight.delete(feed.id);
  }
}

/** Screens poll /social.json, so a change needs no push; this is a hook for future use. */
function notifyScreens() { /* walls poll their data every two minutes */ }

/** Feeds shown by at least one widget, or touched recently in the dashboard. */
function dueFeeds(db) {
  return db.prepare(`SELECT f.id FROM social_feeds f WHERE f.enabled = 1 AND f.next_fetch_at <= ? AND (
      EXISTS (SELECT 1 FROM widgets w WHERE w.widget_type = 'social' AND w.workspace_id = f.workspace_id AND json_extract(w.config, '$.feed_id') = f.id)
      OR f.updated_at > ?) ORDER BY f.next_fetch_at LIMIT 5`).all(now(), now() - 86400);
}

async function tick(db) {
  for (const f of dueFeeds(db)) {
    try { await fetchFeed(db, f.id); } catch (e) { console.warn(`[social] feed ${f.id}: ${e.message}`); }
  }
  if (Math.random() < 1 / 60) { try { media.gc(db); } catch (_) { /* */ } }
}

function start(ioRef) {
  io = ioRef || null;
  if (timer) return;
  const db = require('../../db/database').db;
  timer = setInterval(() => { tick(db).catch((e) => console.warn(`[social] tick: ${e.message}`)); }, TICK_MS);
  if (timer.unref) timer.unref();
}

module.exports = {
  MODES, MAX_SOURCES, InputError, normaliseInput, normaliseSource, sourceKey, normaliseBlocklist, create, update, present, forWorkspace,
  blocked, ingest, prune, visiblePosts, presentPost, moderate, fetchFeed, claim, tick, start, dueFeeds,
  _io: () => io,
};
