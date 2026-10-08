'use strict';

/*
 * CAP emergency feeds (lib/cap/feeds.js) — the dashboard's "Emergency feeds" page and the API.
 *
 * WHO: reading needs workspace membership; changing a feed needs a workspace ADMIN (or an org
 * admin acting as one) and, for API tokens, the 'full' scope — a feed can take over every screen
 * in the workspace, which is more than an editor can do with a playlist.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { db } = require('../db/database');
const { requireScope } = require('../middleware/apiToken');
const { resourceAccess } = require('../lib/tenancy');
const feeds = require('../lib/cap/feeds');

function access(req, res, { write = false } = {}) {
  if (!req.workspaceId) { res.status(403).json({ error: 'No workspace context' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  const ctx = ws && resourceAccess(req, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (write && !ctx.actingAs && ctx.workspaceRole !== 'workspace_admin') {
    res.status(403).json({ error: 'Only a workspace admin can change emergency feeds.', code: 'CAP_ADMIN_REQUIRED' }); return null;
  }
  return ctx;
}

function loadFeed(req, res) {
  const f = db.prepare("SELECT * FROM cap_feeds WHERE id = ? AND workspace_id = ? AND COALESCE(source, 'poll') = 'poll'").get(req.params.id, req.workspaceId);
  if (!f) { res.status(404).json({ error: 'Feed not found' }); return null; }
  return f;
}

function present(f) {
  let events = [];
  try { events = JSON.parse(f.events || '[]'); } catch { events = []; }
  const live = f.enabled ? feeds.liveAlerts(db, f) : [];
  return {
    id: f.id, name: f.name, url: f.url, enabled: !!f.enabled, poll_sec: f.poll_sec,
    min_severity: f.min_severity, events, area_match: f.area_match || '', language: f.language,
    playlist_id: f.playlist_id || null,
    scopes: feeds.scopesOf(db, f.id),
    screens_in_scope: feeds.devicesInScope(db, f).length,
    live_count: live.length,
    live: require('../lib/cap/card').groupForDisplay(live).slice(0, 5).map((a) => ({ event: a.event, severity: a.severity, headline: a.headline, area: a.areaDesc, expires: a.expires, ends: a.ends || null })),
    last_polled_at: f.last_polled_at, last_ok_at: f.last_ok_at, last_error: f.last_error || null,
    created_at: f.created_at, updated_at: f.updated_at,
  };
}

function playlistError(req, id) {
  if (!id) return null;
  return db.prepare('SELECT 1 FROM playlists WHERE id = ? AND workspace_id = ?').get(id, req.workspaceId)
    ? null : 'playlist_id must be a playlist in this workspace';
}

function meshRefusal(req) {
  try {
    if (require('../lib/corporate/guard').isReplicatedWorkspace(db, req.workspaceId)) {
      return 'Emergency feeds are not available in a workspace replicated over the mesh: its screens would never see the alert.';
    }
  } catch (_) { /* no mesh */ }
  return null;
}

router.get('/', (req, res) => {
  if (!access(req, res)) return;
  // Hook-owned push feeds (lib/automation) are managed on the Automation page, not here.
  const rows = db.prepare("SELECT * FROM cap_feeds WHERE workspace_id = ? AND COALESCE(source, 'poll') = 'poll' ORDER BY name").all(req.workspaceId);
  res.json(rows.map(present));
});

router.get('/:id', (req, res) => {
  if (!access(req, res)) return;
  const f = loadFeed(req, res); if (!f) return;
  res.json(present(f));
});

/** Recent alerts the feed has carried (a week), with whether each is on screens now. */
router.get('/:id/alerts', (req, res) => {
  if (!access(req, res)) return;
  const f = loadFeed(req, res); if (!f) return;
  const liveKeys = new Set(feeds.liveAlerts(db, f).map((a) => `${a.sender}|${a.identifier}`));
  const rows = db.prepare('SELECT akey, data, in_feed, ended, first_seen, last_seen FROM cap_alerts WHERE feed_id = ? ORDER BY last_seen DESC LIMIT 100').all(f.id);
  res.json(rows.map((r) => {
    let a = {}; try { a = JSON.parse(r.data); } catch { /* */ }
    return {
      event: a.event, severity: a.severity, urgency: a.urgency, headline: a.headline, area: a.areaDesc,
      msg_type: a.msgType, status: a.status, sent: a.sent, expires: a.expires,
      in_feed: !!r.in_feed, ended: !!r.ended, on_screens: liveKeys.has(r.akey),
      first_seen: r.first_seen, last_seen: r.last_seen,
    };
  }));
});

/**
 * Fetch a feed WITHOUT saving it, and say what it would show with these filters. The URL is
 * fetched through the same SSRF guard as data sources (public addresses only).
 */
router.post('/test', requireScope('full'), async (req, res) => {
  if (!access(req, res, { write: true })) return;
  const { fields, error } = feeds.normaliseInput({ name: 'test', ...req.body });
  if (error) return res.status(400).json({ error });
  const probe = { id: 'test', name: 'test', min_severity: 'Severe', language: 'en', ...fields };
  try {
    const r = await feeds.fetchFeed(probe);
    const now = feeds.now();
    // Counted over EVERY alert; only the list is cut to 50, with what would show listed first.
    const all = r.alerts.map((a) => ({
      event: a.event, severity: a.severity, headline: a.headline, area: a.areaDesc, msg_type: a.msgType,
      status: a.status, sent: a.sent, expires: a.expires,
      live: feeds.isLive(a, now), matches: feeds.matchesFilters(probe, a),
    }));
    const shown = (a) => (a.live && a.matches ? 0 : 1);
    const alerts = all.slice().sort((x, y) => shown(x) - shown(y)).slice(0, 50);
    res.json({ kind: r.kind, total: all.length, linked_documents: r.linked, skipped_links: r.skipped_links, alerts,
      would_show: all.filter((a) => a.live && a.matches).length });
  } catch (e) {
    res.status(400).json({ error: feeds.describeError(e) });
  }
});

router.post('/', requireScope('full'), (req, res) => {
  if (!access(req, res, { write: true })) return;
  const refusal = meshRefusal(req);
  if (refusal) return res.status(409).json({ error: refusal, code: 'CAP_MESH_UNSUPPORTED' });
  const { fields, error } = feeds.normaliseInput(req.body);
  if (error) return res.status(400).json({ error });
  const pe = playlistError(req, fields.playlist_id); if (pe) return res.status(400).json({ error: pe });
  const sc = feeds.validateScopes(db, req.workspaceId, req.body.scopes === undefined ? [{ scope_kind: 'workspace' }] : req.body.scopes);
  if (sc.error) return res.status(400).json({ error: sc.error });
  const id = crypto.randomUUID();
  db.transaction(() => {
    db.prepare(`INSERT INTO cap_feeds (id, workspace_id, user_id, name, url, enabled, poll_sec, min_severity, events, area_match, language, playlist_id)
      VALUES (@id, @workspace_id, @user_id, @name, @url, @enabled, @poll_sec, @min_severity, @events, @area_match, @language, @playlist_id)`).run({
      id, workspace_id: req.workspaceId, user_id: req.user.id, name: fields.name, url: fields.url,
      enabled: fields.enabled ?? 1, poll_sec: fields.poll_sec ?? feeds.DEFAULT_POLL, min_severity: fields.min_severity ?? 'Severe',
      events: fields.events ?? null, area_match: fields.area_match ?? null, language: fields.language ?? 'en', playlist_id: fields.playlist_id ?? null,
    });
    feeds.setScopes(db, id, sc.rows);
    feeds.ensureWidget(db, db.prepare('SELECT * FROM cap_feeds WHERE id = ?').get(id));
  })();
  try { require('../lib/audit').audit('cap_feed.create', { userId: req.user.id, workspaceId: req.workspaceId, ip: req.ip || null, details: { feed_id: id, name: fields.name, url: fields.url } }); } catch (_) { /* */ }
  const f = db.prepare('SELECT * FROM cap_feeds WHERE id = ?').get(id);
  // First poll now, so the operator sees the feed's state without waiting for the ticker.
  feeds.pollFeed(db, f).catch(() => {});
  res.status(201).json(present(f));
});

router.put('/:id', requireScope('full'), (req, res) => {
  if (!access(req, res, { write: true })) return;
  const f = loadFeed(req, res); if (!f) return;
  const { fields, error } = feeds.normaliseInput(req.body, f);
  if (error) return res.status(400).json({ error });
  const pe = playlistError(req, fields.playlist_id); if (pe) return res.status(400).json({ error: pe });
  const sc = feeds.validateScopes(db, req.workspaceId, req.body.scopes);
  if (sc.error) return res.status(400).json({ error: sc.error });
  const before = feeds.devicesInScope(db, f);
  db.transaction(() => {
    const cols = Object.keys(fields);
    if (cols.length) {
      db.prepare(`UPDATE cap_feeds SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = strftime('%s','now') WHERE id = @id`).run({ ...fields, id: f.id });
    }
    if (sc.rows) feeds.setScopes(db, f.id, sc.rows);
    // The card's title is the feed's name; a renamed feed shows its new name.
    if (fields.name) db.prepare('UPDATE widgets SET name = ? WHERE id = ?').run(`Emergency alert: ${fields.name}`.slice(0, 200), f.widget_id);
  })();
  try { require('../lib/audit').audit('cap_feed.update', { userId: req.user.id, workspaceId: req.workspaceId, ip: req.ip || null, details: { feed_id: f.id, fields: Object.keys(fields), scopes_changed: !!sc.rows } }); } catch (_) { /* */ }
  // Filters, scope, playlist or the on/off switch can all change what screens show: re-derive and
  // push, including screens that just left the scope.
  feeds.refresh(db, f.id, { extraDevices: before, force: true });
  const updated = db.prepare('SELECT * FROM cap_feeds WHERE id = ?').get(f.id);
  if (fields.url) feeds.pollFeed(db, updated).catch(() => {});
  res.json(present(updated));
});

router.delete('/:id', requireScope('full'), (req, res) => {
  if (!access(req, res, { write: true })) return;
  const f = loadFeed(req, res); if (!f) return;
  const before = feeds.devicesInScope(db, f);
  db.transaction(() => {
    db.prepare('DELETE FROM cap_feeds WHERE id = ?').run(f.id);
    if (f.widget_id) db.prepare("DELETE FROM widgets WHERE id = ? AND widget_type = 'cap_alert'").run(f.widget_id);
  })();
  try { require('../lib/audit').audit('cap_feed.delete', { userId: req.user.id, workspaceId: req.workspaceId, ip: req.ip || null, details: { feed_id: f.id, name: f.name } }); } catch (_) { /* */ }
  feeds.refresh(db, f.id, { extraDevices: before, force: true });
  res.json({ success: true });
});

/** Poll now (the "Check now" button). */
router.post('/:id/poll', requireScope('full'), async (req, res) => {
  if (!access(req, res, { write: true })) return;
  const f = loadFeed(req, res); if (!f) return;
  const r = await feeds.pollFeed(db, f);
  res.json({ ...r, feed: present(db.prepare('SELECT * FROM cap_feeds WHERE id = ?').get(f.id)) });
});

module.exports = router;
