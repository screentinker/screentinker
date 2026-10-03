'use strict';

/*
 * How each resource type goes live, behind the release policy. Every caller that wants to
 * change what players show for a resource comes through here; the gate runs first, the type's
 * own publish runs second, and the revision and submission are closed third, in that order.
 *
 * Widgets, layouts and content used to change in place. They still do when approval is off
 * (see the routes), but a DRAFT column exists on each so that an approval-gated edit, or a
 * restore from history, can wait without touching what a screen is showing. Publishing the
 * draft is what this file does for those three.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const revisions = require('./revisions');
const policy = require('./release-policy');
const { audit } = require('./audit');

function ioOf(reqOrIo) { return reqOrIo && reqOrIo.app ? reqOrIo.app.get('io') : reqOrIo; }

function pushDevices(reqOrIo, deviceIds) {
  try {
    const io = ioOf(reqOrIo);
    if (!io) return;
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    const commandQueue = require('./command-queue');
    for (const id of new Set(deviceIds)) commandQueue.queueOrEmitPlaylistUpdate(io.of('/device'), id, buildPlaylistPayload);
  } catch (_) { /* best effort; the heartbeat refresh picks it up */ }
}

function actorOf(req, kind) {
  if (!req || !req.user) return { userId: null, kind: kind || 'system', label: null };
  return { userId: req.user.id, kind: kind || (req.tokenScope ? 'api_token' : 'user'), label: req.user.email || null };
}

// ─── playlists ───────────────────────────────────────────────────────────────────────────────

function releasePlaylist(db, playlistId, reqOrIo, { actor, source = 'dashboard' } = {}) {
  const pl = db.prepare('SELECT id, workspace_id FROM playlists WHERE id = ?').get(playlistId);
  if (!pl) { const e = new Error('Playlist not found'); e.status = 404; throw e; }
  const gate = policy.assertReleasable(db, { workspaceId: pl.workspace_id, type: 'playlist', id: playlistId });
  const { publishPlaylist } = require('../routes/playlists');
  const result = publishPlaylist(playlistId, reqOrIo);
  const rev = policy.afterRelease(db, { type: 'playlist', id: playlistId, gate, actor: actor || actorOf(reqOrIo), summary: 'Published' });
  audit('release:playlist', { userId: actor && actor.userId, workspaceId: pl.workspace_id, details: { playlist_id: playlistId, source, submission_id: gate.submission ? gate.submission.id : null, changed: result && result.changed } });
  return { ...result, revision: rev, gate };
}

// ─── slide decks ─────────────────────────────────────────────────────────────────────────────

function releaseSlideDeck(db, deckId, req, { actor } = {}) {
  const deck = db.prepare('SELECT * FROM slide_decks WHERE id = ?').get(deckId);
  if (!deck) { const e = new Error('Deck not found'); e.status = 404; throw e; }
  const gate = policy.assertReleasable(db, { workspaceId: deck.workspace_id, type: 'slide_deck', id: deckId });
  const { publishDeckNow } = require('../routes/slide-decks');
  const out = publishDeckNow(deck, req, { gateForPlaylist: gate });
  const rev = policy.afterRelease(db, { type: 'slide_deck', id: deckId, gate, actor: actor || actorOf(req), summary: 'Published' });
  audit('release:slide_deck', { userId: actor && actor.userId, workspaceId: deck.workspace_id, details: { deck_id: deckId, playlist_id: out.playlistId, submission_id: gate.submission ? gate.submission.id : null } });
  return { ...out, revision: rev, gate };
}

// ─── widgets ─────────────────────────────────────────────────────────────────────────────────

function releaseWidgetDraft(db, widgetId, req, { actor } = {}) {
  const w = db.prepare('SELECT * FROM widgets WHERE id = ?').get(widgetId);
  if (!w) { const e = new Error('Widget not found'); e.status = 404; throw e; }
  const draft = revisions.parseJson(w.draft_config, null);
  if (!draft) { const e = new Error('This widget has no unpublished draft'); e.status = 400; throw e; }
  const gate = policy.assertReleasable(db, { workspaceId: w.workspace_id, type: 'widget', id: widgetId });
  db.transaction(() => {
    db.prepare("UPDATE widgets SET name = ?, config = ?, draft_config = NULL, updated_at = MAX(CAST(strftime('%s','now') AS INTEGER), updated_at + 1) WHERE id = ?")
      .run(draft.name || w.name, JSON.stringify(draft.config || {}), widgetId);
    policy.afterRelease(db, { type: 'widget', id: widgetId, gate, actor: actor || actorOf(req), summary: 'Published' });
  })();
  pushDevices(req, require('./devices-playing').devicesPlayingWidget(widgetId));
  audit('release:widget', { userId: actor && actor.userId, workspaceId: w.workspace_id, details: { widget_id: widgetId, submission_id: gate.submission ? gate.submission.id : null } });
  return { gate };
}

// ─── layouts ─────────────────────────────────────────────────────────────────────────────────

const ZONE_COLS = ['name', 'x_percent', 'y_percent', 'width_percent', 'height_percent', 'z_index', 'zone_type', 'fit_mode', 'background_color', 'sort_order'];

function applyZones(db, layoutId, zones) {
  const existing = new Set(db.prepare('SELECT id FROM layout_zones WHERE layout_id = ?').all(layoutId).map((r) => r.id));
  const kept = new Set();
  const ins = db.prepare(`INSERT INTO layout_zones (id, layout_id, ${ZONE_COLS.join(', ')}) VALUES (?, ?, ${ZONE_COLS.map(() => '?').join(', ')})`);
  const upd = db.prepare(`UPDATE layout_zones SET ${ZONE_COLS.map((c) => c + ' = ?').join(', ')} WHERE id = ? AND layout_id = ?`);
  zones.forEach((z, i) => {
    const zid = z.id || require('crypto').randomUUID();
    const vals = [z.name || `Zone ${i + 1}`, z.x_percent || 0, z.y_percent || 0, z.width_percent || 100, z.height_percent || 100,
      z.z_index || 0, z.zone_type || 'content', z.fit_mode || 'contain', z.background_color || '#000000', i];
    if (existing.has(zid)) upd.run(...vals, zid, layoutId); else ins.run(zid, layoutId, ...vals);
    kept.add(zid);
  });
  for (const zid of existing) if (!kept.has(zid)) db.prepare('DELETE FROM layout_zones WHERE id = ? AND layout_id = ?').run(zid, layoutId);
}

function releaseLayoutDraft(db, layoutId, req, { actor } = {}) {
  const l = db.prepare('SELECT * FROM layouts WHERE id = ?').get(layoutId);
  if (!l) { const e = new Error('Layout not found'); e.status = 404; throw e; }
  const draft = revisions.parseJson(l.draft_zones, null);
  if (!draft) { const e = new Error('This layout has no unpublished draft'); e.status = 400; throw e; }
  const gate = policy.assertReleasable(db, { workspaceId: l.workspace_id, type: 'layout', id: layoutId });
  db.transaction(() => {
    db.prepare("UPDATE layouts SET name = ?, width = ?, height = ?, draft_zones = NULL, updated_at = strftime('%s','now') WHERE id = ?")
      .run(draft.name || l.name, draft.width || l.width, draft.height || l.height, layoutId);
    applyZones(db, layoutId, Array.isArray(draft.zones) ? draft.zones : []);
    policy.afterRelease(db, { type: 'layout', id: layoutId, gate, actor: actor || actorOf(req), summary: 'Published' });
  })();
  pushDevices(req, db.prepare('SELECT id FROM devices WHERE layout_id = ?').all(layoutId).map((r) => r.id));
  audit('release:layout', { userId: actor && actor.userId, workspaceId: l.workspace_id, details: { layout_id: layoutId, submission_id: gate.submission ? gate.submission.id : null } });
  return { gate };
}

// ─── content ─────────────────────────────────────────────────────────────────────────────────

const CONTENT_DRAFT_COLS = revisions.CONTENT_DRAFT_FIELDS;

/**
 * Swap the draft bytes in for the live ones. The live file is RETAINED under .history first and
 * the revision that described it keeps pointing there, so the previous version stays restorable.
 * Snapshots and players are refreshed the way PUT /:id/replace does.
 */
function releaseContentDraft(db, contentId, req, { actor } = {}) {
  const c = db.prepare('SELECT * FROM content WHERE id = ?').get(contentId);
  if (!c) { const e = new Error('Content not found'); e.status = 404; throw e; }
  const draft = revisions.parseJson(c.draft_json, null);
  if (!draft) { const e = new Error('This item has no unpublished draft'); e.status = 400; throw e; }
  const gate = policy.assertReleasable(db, { workspaceId: c.workspace_id, type: 'content', id: contentId });
  if (draft.filepath && !fs.existsSync(path.join(config.contentDir, path.basename(draft.filepath)))) {
    const e = new Error('The draft file is missing on disk; upload it again'); e.status = 409; throw e;
  }
  const prevRev = revisions.latest(db, 'content', contentId);
  const tag = prevRev ? `r${prevRev.rev_no}` : 'r0';
  // Retain the live bytes BEFORE the row changes, so a crash between the two leaves a copy, never a hole.
  let retainedFile = null, retainedThumb = null;
  if (draft.filepath && draft.filepath !== c.filepath) {
    retainedFile = revisions.retainContentFile(db, contentId, c.filepath, tag);
    retainedThumb = c.thumbnail_path && draft.thumbnail_path !== c.thumbnail_path ? revisions.retainContentFile(db, contentId, c.thumbnail_path, tag) : null;
  }
  db.transaction(() => {
    if (retainedFile) {
      // Every revision that described the old bytes now points at the retained copy.
      db.prepare('UPDATE revisions SET file_ref = ? WHERE resource_type = ? AND resource_id = ? AND file_ref = ?').run(retainedFile, 'content', contentId, c.filepath);
      if (retainedThumb) db.prepare('UPDATE revisions SET thumb_ref = ? WHERE resource_type = ? AND resource_id = ? AND thumb_ref = ?').run(retainedThumb, 'content', contentId, c.thumbnail_path);
    }
    const sets = [], vals = [];
    for (const k of CONTENT_DRAFT_COLS) if (k in draft && draft[k] !== undefined) { sets.push(`${k} = ?`); vals.push(draft[k]); }
    if ('expires_at' in draft && draft.expires_at !== undefined) sets.push('is_active = 1');   // same reset the details route does
    if (draft.filepath) { sets.push('filepath = ?'); vals.push(draft.filepath); }
    if ('thumbnail_path' in draft) { sets.push('thumbnail_path = ?'); vals.push(draft.thumbnail_path || null); }
    sets.push('draft_json = NULL');
    sets.push("updated_at = MAX(CAST(strftime('%s','now') AS INTEGER), COALESCE(NULLIF(updated_at, 0), created_at) + 1)");
    vals.push(contentId);
    db.prepare(`UPDATE content SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    policy.afterRelease(db, { type: 'content', id: contentId, gate, actor: actor || actorOf(req), summary: 'Published' });
  })();
  pushDevices(req, require('./devices-playing').devicesPlayingContent(contentId));
  audit('release:content', { userId: actor && actor.userId, workspaceId: c.workspace_id, details: { content_id: contentId, submission_id: gate.submission ? gate.submission.id : null } });
  return { gate };
}

function releaseDraft(db, type, id, req, opts) {
  if (type === 'widget') return releaseWidgetDraft(db, id, req, opts);
  if (type === 'layout') return releaseLayoutDraft(db, id, req, opts);
  if (type === 'content') return releaseContentDraft(db, id, req, opts);
  if (type === 'playlist') return releasePlaylist(db, id, req, opts);
  if (type === 'slide_deck') return releaseSlideDeck(db, id, req, opts);
  const e = new Error('Unknown resource type'); e.status = 400; throw e;
}

function discardDraft(db, type, id) {
  if (type === 'widget') db.prepare('UPDATE widgets SET draft_config = NULL WHERE id = ?').run(id);
  else if (type === 'layout') db.prepare('UPDATE layouts SET draft_zones = NULL WHERE id = ?').run(id);
  else if (type === 'content') {
    const c = db.prepare('SELECT * FROM content WHERE id = ?').get(id);
    revisions.disposeDraftFiles(db, id, revisions.parseJson(c && c.draft_json, null), c);
    db.prepare('UPDATE content SET draft_json = NULL WHERE id = ?').run(id);
  } else { const e = new Error('Only widgets, layouts and content hold a separate draft'); e.status = 400; throw e; }
}

module.exports = { actorOf, pushDevices, applyZones, releasePlaylist, releaseSlideDeck, releaseWidgetDraft, releaseLayoutDraft, releaseContentDraft, releaseDraft, discardDraft };
