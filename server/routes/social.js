'use strict';

/*
 * Social walls (lib/social/*) — the dashboard's API. JWT only (config/api-surface.js).
 *
 *   /connections — an organization's Instagram / Facebook / YouTube / X credentials.
 *                  Any member may list them (names, never a secret), because choosing one is how an
 *                  editor builds a feed; only an org owner/admin (or a platform admin) may change one.
 *   /feeds       — a workspace's feeds and their moderation queue. Editors; viewers read only.
 */

const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const conns = require('../lib/social/connections');
const feeds = require('../lib/social/feeds');
const networks = require('../lib/social/networks');

function ctx(req, res) {
  if (!req.workspaceId || !req.organizationId) { res.status(403).json({ error: 'No workspace context' }); return false; }
  return true;
}
const isOrgAdmin = (req) => !!(req.isPlatformAdmin || req.actingAs || req.orgRole === 'org_owner' || req.orgRole === 'org_admin');
const isEditor = (req) => isOrgAdmin(req) || (req.workspaceRole && req.workspaceRole !== 'workspace_viewer');
function requireOrgAdmin(req, res) {
  if (!ctx(req, res)) return false;
  if (!isOrgAdmin(req)) { res.status(403).json({ error: 'Only an organization admin can manage social connections.', code: 'SOCIAL_ADMIN_REQUIRED' }); return false; }
  return true;
}
function requireEditor(req, res) {
  if (!ctx(req, res)) return false;
  if (!isEditor(req)) { res.status(403).json({ error: 'Read-only members cannot change social feeds.' }); return false; }
  return true;
}
function audit(req, action, details) {
  try { require('../lib/audit').audit(action, { userId: req.user.id, workspaceId: req.workspaceId, ip: req.ip || null, details }); } catch (_) { /* */ }
}

/* ---------------------------------- connections ---------------------------------- */

router.get('/connections', (req, res) => {
  if (!ctx(req, res)) return;
  const rows = db.prepare('SELECT * FROM social_connections WHERE organization_id = ? ORDER BY name').all(req.organizationId);
  res.json({ connections: rows.map(conns.present), can_manage: isOrgAdmin(req) });
});

router.post('/connections', (req, res) => {
  if (!requireOrgAdmin(req, res)) return;
  let input;
  try { input = conns.normaliseInput(req.body); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const row = conns.create(db, req.organizationId, req.user.id, input);
  audit(req, 'social_connection.create', { connection_id: row.id, kind: row.kind, name: row.name });
  res.status(201).json(conns.present(row));
});

function loadConn(req, res) {
  const row = conns.forOrg(db, req.organizationId, req.params.id);
  if (!row) { res.status(404).json({ error: 'Connection not found' }); return null; }
  return row;
}

router.put('/connections/:id', (req, res) => {
  if (!requireOrgAdmin(req, res)) return;
  const row = loadConn(req, res); if (!row) return;
  let input;
  try { input = conns.normaliseInput(req.body, row); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const next = conns.update(db, row, input);
  audit(req, 'social_connection.update', { connection_id: row.id, name: next.name, secret_changed: input.secretChanged });
  res.json(conns.present(next));
});

function feedsUsing(orgId, connId) {
  return db.prepare(`SELECT f.id, f.name FROM social_feeds f JOIN workspaces w ON w.id = f.workspace_id
    WHERE w.organization_id = ? AND EXISTS (SELECT 1 FROM json_each(f.sources) s WHERE json_extract(s.value, '$.connection_id') = ?)`).all(orgId, connId);
}

router.delete('/connections/:id', (req, res) => {
  if (!requireOrgAdmin(req, res)) return;
  const row = loadConn(req, res); if (!row) return;
  const using = feedsUsing(req.organizationId, row.id);
  if (using.length && req.query.force !== '1') {
    return res.status(409).json({ error: `${using.length} social feed${using.length === 1 ? ' uses' : 's use'} this connection; those sources will stop updating.`, code: 'SOCIAL_CONNECTION_IN_USE', feeds: using.length });
  }
  db.prepare('DELETE FROM social_connections WHERE id = ?').run(row.id);
  audit(req, 'social_connection.delete', { connection_id: row.id, kind: row.kind, name: row.name, feeds: using.length });
  res.json({ success: true });
});

// Read one post through the connection — proves the token works without saving anything.
router.post('/connections/:id/test', async (req, res) => {
  if (!requireOrgAdmin(req, res)) return;
  const row = loadConn(req, res); if (!row) return;
  const probe = {
    instagram: { network: 'instagram', kind: 'own', value: '' },
    facebook: { network: 'facebook', kind: 'page', value: '' },
    youtube: { network: 'youtube', kind: 'channel', value: String((req.body && req.body.channel) || '@YouTube') },
    x: { network: 'x', kind: 'account', value: String((req.body && req.body.account) || 'X') },
  }[row.kind];
  try {
    const r = await networks.fetchSource(probe, row, 1);
    db.prepare('UPDATE social_connections SET last_error = NULL WHERE id = ?').run(row.id);
    const p = r.posts[0];
    res.json({ ok: true, detail: p ? `Read a post by ${p.author.handle || p.author.name}` : 'Connected — no posts yet' });
  } catch (e) {
    res.json({ ok: false, detail: String(e.message || e).slice(0, 240) });
  }
});

/* -------------------------------------- feeds -------------------------------------- */

function loadFeed(req, res) {
  const row = feeds.forWorkspace(db, req.workspaceId, req.params.id);
  if (!row) { res.status(404).json({ error: 'Feed not found' }); return null; }
  return row;
}

router.get('/feeds', (req, res) => {
  if (!ctx(req, res)) return;
  const rows = db.prepare('SELECT * FROM social_feeds WHERE workspace_id = ? ORDER BY name').all(req.workspaceId);
  res.json({ feeds: rows.map((r) => feeds.present(r, db)), can_edit: !!isEditor(req), networks: networks.SOURCE_KINDS });
});

router.get('/feeds/:id', (req, res) => {
  if (!ctx(req, res)) return;
  const row = loadFeed(req, res); if (!row) return;
  res.json(feeds.present(row, db));
});

router.post('/feeds', (req, res) => {
  if (!requireEditor(req, res)) return;
  let input;
  try { input = feeds.normaliseInput(db, req.organizationId, req.body); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const n = db.prepare('SELECT COUNT(*) AS n FROM social_feeds WHERE workspace_id = ?').get(req.workspaceId).n;
  if (n >= 50) return res.status(400).json({ error: 'A workspace can have at most 50 social feeds.' });
  const row = feeds.create(db, req.workspaceId, req.user.id, input);
  audit(req, 'social_feed.create', { feed_id: row.id, name: row.name });
  // First fetch straight away, so the editor sees posts without waiting for the next tick.
  feeds.fetchFeed(db, row.id, { force: true }).catch(() => {});
  res.status(201).json(feeds.present(row, db));
});

router.put('/feeds/:id', (req, res) => {
  if (!requireEditor(req, res)) return;
  const row = loadFeed(req, res); if (!row) return;
  let input;
  try { input = feeds.normaliseInput(db, req.organizationId, req.body, row); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const next = feeds.update(db, row, input);
  audit(req, 'social_feed.update', { feed_id: row.id, name: next.name });
  res.json(feeds.present(next, db));
});

router.delete('/feeds/:id', (req, res) => {
  if (!requireEditor(req, res)) return;
  const row = loadFeed(req, res); if (!row) return;
  const n = db.prepare("SELECT COUNT(*) AS n FROM widgets WHERE widget_type = 'social' AND workspace_id = ? AND json_extract(config, '$.feed_id') = ?").get(req.workspaceId, row.id).n;
  if (n > 0 && req.query.force !== '1') {
    return res.status(409).json({ error: `${n} social wall${n === 1 ? ' shows' : 's show'} this feed. They will go empty.`, code: 'SOCIAL_FEED_IN_USE', widgets: n });
  }
  db.transaction(() => {
    db.prepare('DELETE FROM social_posts WHERE feed_id = ?').run(row.id);
    db.prepare('DELETE FROM social_feeds WHERE id = ?').run(row.id);
  })();
  audit(req, 'social_feed.delete', { feed_id: row.id, name: row.name });
  res.json({ success: true });
});

router.post('/feeds/:id/refresh', async (req, res) => {
  if (!requireEditor(req, res)) return;
  const row = loadFeed(req, res); if (!row) return;
  const last = row.last_fetch_at || 0;
  if (Math.floor(Date.now() / 1000) - last < 30) return res.status(429).json({ error: 'This feed was fetched less than 30 seconds ago.' });
  try {
    const r = await feeds.fetchFeed(db, row.id, { force: true });
    res.json({ ...(r || {}), feed: feeds.present(feeds.forWorkspace(db, req.workspaceId, row.id), db) });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e).slice(0, 240) });
  }
});

const STATUSES = ['approved', 'pending', 'hidden'];
router.get('/feeds/:id/posts', (req, res) => {
  if (!ctx(req, res)) return;
  const row = loadFeed(req, res); if (!row) return;
  const status = STATUSES.includes(req.query.status) ? req.query.status : null;
  const rows = db.prepare(`SELECT * FROM social_posts WHERE feed_id = ? ${status ? 'AND status = ?' : ''} ORDER BY posted_at DESC LIMIT 200`)
    .all(...[row.id, ...(status ? [status] : [])]);
  res.json({ posts: rows.map(feeds.presentPost) });
});

// Moderation: approve, hide or unhide one post. The key is "<network>:<post id>".
router.post('/feeds/:id/posts/moderate', (req, res) => {
  if (!requireEditor(req, res)) return;
  const row = loadFeed(req, res); if (!row) return;
  const { key, action } = req.body || {};
  const m = /^([a-z]+):(.{1,200})$/.exec(String(key || ''));
  if (!m || !['approve', 'hide', 'unhide'].includes(action)) return res.status(400).json({ error: 'key and action (approve, hide, unhide) are required' });
  const out = feeds.moderate(db, row, m[1], m[2], action);
  if (!out) return res.status(404).json({ error: 'Post not found' });
  audit(req, `social_post.${action}`, { feed_id: row.id, post: String(key).slice(0, 120) });
  res.json(out.status === 'refetch' ? { refetch: true } : { post: feeds.presentPost(out) });
});

// Sources for the media endpoint below: a cached image, for the dashboard's moderation queue.
router.get('/media/:hash', (req, res) => {
  if (!ctx(req, res)) return;
  const hash = String(req.params.hash || '');
  const used = db.prepare(`SELECT 1 FROM social_posts p JOIN social_feeds f ON f.id = p.feed_id
    WHERE f.workspace_id = ? AND (p.author_avatar = ? OR p.media LIKE ?) LIMIT 1`).get(req.workspaceId, hash, `%"${hash.replace(/[^0-9a-f]/g, '')}"%`);
  const m = used ? require('../lib/social/media').lookup(db, hash) : null;
  if (!m) return res.status(404).end();
  res.setHeader('Content-Type', m.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(m.file);
});

module.exports = router;
