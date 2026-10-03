'use strict';

// Version history: list, inspect, compare, preview, restore. Restore writes into the DRAFT and
// records a new revision; publishing that draft goes through the release policy like any other
// publish (POST .../publish-draft here, or the resource's own publish for playlists and decks).

const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { db } = require('../db/database');
const { canWrite, requireWorkspaceRead, requireWorkspaceWrite } = require('../lib/permissions');
const revisions = require('../lib/revisions');
const releases = require('../lib/releases');
const policy = require('../lib/release-policy');
const { audit } = require('../lib/audit');

const TYPES = revisions.RESOURCE_TYPES;

function loadResource(req, res) {
  const { type, id } = req.params;
  if (!TYPES.includes(type)) { res.status(400).json({ error: 'Unknown resource type' }); return null; }
  const row = db.prepare(`SELECT * FROM ${revisions.TABLE[type]} WHERE id = ?`).get(id);
  if (!row || (row.workspace_id || null) !== req.workspaceId) { res.status(404).json({ error: 'Not found' }); return null; }
  return row;
}

function present(rev, { withState = false } = {}) {
  const out = { ...rev };
  delete out.state;
  if (withState) out.state = revisions.redactState(revisions.parseJson(rev.state, null));
  out.has_file = !!rev.file_ref && !!revisions.resolveFileRef(rev.file_ref);
  return out;
}

router.get('/:type/:id', requireWorkspaceRead, (req, res) => {
  if (!loadResource(req, res)) return;
  const rows = revisions.list(db, req.params.type, req.params.id);
  const subs = db.prepare('SELECT id, revision_id, status FROM submissions WHERE resource_type = ? AND resource_id = ?').all(req.params.type, req.params.id);
  const byRev = new Map(subs.map((s) => [s.revision_id, s]));
  const live = revisions.lastPublished(db, req.params.type, req.params.id);
  res.json({
    resource_type: req.params.type, resource_id: req.params.id,
    has_draft: revisions.hasDraft(db, req.params.type, req.params.id),
    live_revision_id: live ? live.id : null,
    require_approval: policy.approvalRequired(db, req.workspaceId),
    revisions: rows.map((r) => ({ ...present(r), submission: byRev.get(r.id) || null, is_live: !!(live && live.id === r.id) })),
  });
});

router.get('/:type/:id/:rev', requireWorkspaceRead, (req, res) => {
  if (!loadResource(req, res)) return;
  const rev = revisions.get(db, req.params.rev);
  if (!rev || rev.resource_type !== req.params.type || rev.resource_id !== req.params.id) return res.status(404).json({ error: 'Revision not found' });
  res.json(present(rev, { withState: true }));
});

router.get('/:type/:id/:rev/diff', requireWorkspaceRead, (req, res) => {
  if (!loadResource(req, res)) return;
  const b = revisions.get(db, req.params.rev);
  if (!b || b.resource_type !== req.params.type || b.resource_id !== req.params.id) return res.status(404).json({ error: 'Revision not found' });
  let aState = null, aLabel = 'live';
  if (req.query.against === 'current') { const cap = revisions.captureState(db, req.params.type, req.params.id); aState = cap && cap.state; aLabel = 'current'; }
  else if (req.query.against) {
    const a = revisions.get(db, String(req.query.against));
    if (!a || a.resource_id !== req.params.id) return res.status(404).json({ error: 'Comparison revision not found' });
    aState = revisions.parseJson(a.state, null); aLabel = `#${a.rev_no}`;
  } else { aState = revisions.captureLiveState(db, req.params.type, req.params.id); }
  res.json({ against: aLabel, diff: revisions.diffStates(req.params.type, aState, revisions.parseJson(b.state, null)) });
});

// The bytes a content revision retained, for preview. Same permission as reading the item.
router.get('/:type/:id/:rev/file', requireWorkspaceRead, (req, res) => {
  if (req.params.type !== 'content') return res.status(400).json({ error: 'Only content revisions have a file' });
  if (!loadResource(req, res)) return;
  const rev = revisions.get(db, req.params.rev);
  if (!rev || rev.resource_id !== req.params.id) return res.status(404).json({ error: 'Revision not found' });
  const which = req.query.thumb === '1' ? rev.thumb_ref : rev.file_ref;
  const abs = which ? revisions.resolveFileRef(which) : null;
  if (!abs) return res.status(404).json({ error: 'The media for this revision is no longer retained' });
  const state = revisions.parseJson(rev.state, {});
  res.setHeader('Cache-Control', 'private, max-age=300');
  if (req.query.thumb !== '1' && state.mime_type) res.setHeader('Content-Type', state.mime_type);
  res.sendFile(abs);
});

// A widget revision rendered as the player would render it, for an srcdoc preview.
router.get('/:type/:id/:rev/render', requireWorkspaceRead, (req, res) => {
  if (req.params.type !== 'widget') return res.status(400).json({ error: 'Only widget revisions render' });
  const row = loadResource(req, res);
  if (!row) return;
  const rev = revisions.get(db, req.params.rev);
  if (!rev || rev.resource_id !== req.params.id) return res.status(404).json({ error: 'Revision not found' });
  const state = revisions.parseJson(rev.state, {});
  const { renderWidgetHtml, imageResolverFor } = require('./widgets');
  const html = renderWidgetHtml(state.widget_type || row.widget_type, state.config || {}, { resolveImage: imageResolverFor ? imageResolverFor(row) : undefined });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(html);
});

router.post('/:type/:id/:rev/restore', requireWorkspaceWrite, (req, res) => {
  if (!loadResource(req, res)) return;
  try {
    const out = revisions.restoreToDraft(db, { type: req.params.type, id: req.params.id, revisionId: req.params.rev, actor: { ...releases.actorOf(req), kind: 'restore' } });
    audit('history:restored', { userId: req.user.id, workspaceId: req.workspaceId, ip: req.ip, details: { resource_type: req.params.type, resource_id: req.params.id, from_revision: out.restoredFrom.id, to_revision: out.revision.id } });
    res.json({
      revision: present(out.revision), restored_from: present(out.restoredFrom),
      draft: true, require_approval: policy.approvalRequired(db, req.workspaceId),
      next: policy.approvalRequired(db, req.workspaceId) ? 'submit_for_review' : (req.params.type === 'playlist' || req.params.type === 'slide_deck' ? 'publish' : 'publish_draft'),
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Widgets, layouts and content: publish (or discard) the separate draft. Gated like any release.
router.post('/:type/:id/publish-draft', requireWorkspaceWrite, (req, res) => {
  if (!loadResource(req, res)) return;
  if (!['widget', 'layout', 'content'].includes(req.params.type)) return res.status(400).json({ error: 'Playlists and decks publish through their own publish action' });
  try {
    const out = releases.releaseDraft(db, req.params.type, req.params.id, req, { actor: releases.actorOf(req) });
    res.json({ released: true, mode: out.gate.mode });
  } catch (e) { res.status(e.status || 500).json({ error: e.message, code: e.code || null }); }
});

router.post('/:type/:id/discard-draft', requireWorkspaceWrite, (req, res) => {
  if (!loadResource(req, res)) return;
  try {
    releases.discardDraft(db, req.params.type, req.params.id);
    revisions.recordCurrent(db, req.params.type, req.params.id, { actor: releases.actorOf(req), summary: 'Draft discarded' });
    res.json({ discarded: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
