'use strict';

// Content approval: settings, reviewer assignment, submissions and the review queue.
// Enforced here and in lib/release-policy.js; the dashboard only reflects what these say.

const express = require('express');
const router = express.Router();
// Abuse backstop (lib/backstop-limiter.js): already counted app-wide; here so this router is never unguarded.
router.use(require('../lib/backstop-limiter'));
const { db } = require('../db/database');
const { canWrite, canAdmin, requireWorkspaceWrite, requireWorkspaceAdmin, requireWorkspaceRead } = require('../lib/permissions');
const approvals = require('../lib/approvals');
const revisions = require('../lib/revisions');
const releases = require('../lib/releases');
const { ReleaseError } = require('../lib/release-policy');

function fail(res, e) {
  // A head office refusal (the guard, or the backstop's RAISE) keeps its code and corporate block.
  if (require('../lib/corporate/guard').send(res, e)) return undefined;
  if (e && (e.name === 'ApprovalError' || e.name === 'ReleaseError' || e.status)) {
    return res.status(e.status || 409).json({ error: e.message, code: e.code || null });
  }
  console.error('[approvals]', e && e.message);
  return res.status(500).json({ error: 'Something went wrong' });
}

function actor(req) { return releases.actorOf(req); }

// ─── settings ────────────────────────────────────────────────────────────────────────────────

router.get('/settings', requireWorkspaceRead, (req, res) => {
  const s = approvals.settings(db, req.workspaceId);
  if (!s) return res.status(404).json({ error: 'Workspace not found' });
  // Reviewers' emails are visible to members (they need to know who reviews); nothing else leaves.
  res.json({ ...s, is_reviewer: approvals.isReviewer(db, req.workspaceId, req.user.id), can_admin: canAdmin(req) });
});

router.put('/settings', requireWorkspaceAdmin, (req, res) => {
  const { require_approval, reviewers } = req.body || {};
  try {
    const s = approvals.updateSettings(db, {
      workspaceId: req.workspaceId,
      requireApproval: require_approval === undefined ? undefined : !!require_approval,
      reviewerIds: Array.isArray(reviewers) ? reviewers.map(String) : undefined,
      actor: actor(req), ip: req.ip,
    });
    res.json({ ...s, is_reviewer: approvals.isReviewer(db, req.workspaceId, req.user.id), can_admin: true });
  } catch (e) { fail(res, e); }
});

// ─── queue ───────────────────────────────────────────────────────────────────────────────────

router.get('/queue', requireWorkspaceRead, (req, res) => {
  const status = ['open', 'all', 'submitted', 'changes_requested', 'approved', 'published', 'withdrawn', 'superseded', 'cancelled'].includes(req.query.status) ? req.query.status : 'open';
  res.json(approvals.queue(db, req.workspaceId, { status }));
});

router.get('/mine', requireWorkspaceRead, (req, res) => {
  res.json(approvals.queue(db, req.workspaceId, { status: req.query.status === 'all' ? 'all' : 'open', userId: req.user.id }));
});

// ─── submissions ─────────────────────────────────────────────────────────────────────────────

router.post('/submit', requireWorkspaceWrite, (req, res) => {
  const { resource_type: type, resource_id: id, note } = req.body || {};
  if (!revisions.RESOURCE_TYPES.includes(type) || !id) return res.status(400).json({ error: 'resource_type and resource_id are required' });
  try {
    res.status(201).json(approvals.submit(db, { type, id: String(id), workspaceId: req.workspaceId, actor: actor(req), note, ip: req.ip }));
  } catch (e) { fail(res, e); }
});

function loadSubmission(req, res) {
  const s = approvals.getSubmission(db, req.params.id);
  if (!s || s.workspace_id !== req.workspaceId) { res.status(404).json({ error: 'Submission not found' }); return null; }
  return s;
}

/*
 * Readable names for the ids a playlist state mentions, so the Reviews page can say "menu.png"
 * instead of "content cc1a6429". This workspace's rows only; anything else stays unnamed.
 */
function namesFor(workspaceId, states) {
  const ids = { content: new Set(), widget: new Set(), playlist: new Set(), zone: new Set() };
  for (const st of states) {
    for (const it of (st && Array.isArray(st.items) ? st.items : [])) {
      if (it.content_id) ids.content.add(it.content_id);
      if (it.widget_id) ids.widget.add(it.widget_id);
      if (it.child_playlist_id) ids.playlist.add(it.child_playlist_id);
      if (it.zone_id) ids.zone.add(it.zone_id);
    }
  }
  const sql = {
    content: 'SELECT id, filename AS name FROM content WHERE workspace_id = ? AND id IN',
    widget: 'SELECT id, name FROM widgets WHERE workspace_id = ? AND id IN',
    playlist: 'SELECT id, name FROM playlists WHERE workspace_id = ? AND id IN',
    zone: 'SELECT z.id, z.name FROM layout_zones z JOIN layouts l ON l.id = z.layout_id WHERE l.workspace_id = ? AND z.id IN',
  };
  const out = {};
  for (const [kind, set] of Object.entries(ids)) {
    out[kind] = {};
    const list = [...set].slice(0, 500);
    if (!list.length) continue;
    try {
      for (const r of db.prepare(`${sql[kind]} (${list.map(() => '?').join(',')})`).all(workspaceId, ...list)) out[kind][r.id] = r.name;
    } catch (_) { /* a hand-built schema without the table: names are a nicety */ }
  }
  return out;
}

router.get('/:id', requireWorkspaceRead, (req, res) => {
  const s = loadSubmission(req, res);
  if (!s) return;
  const rev = revisions.get(db, s.revision_id);
  const live = revisions.captureLiveState(db, s.resource_type, s.resource_id);
  const state = rev ? revisions.parseJson(rev.state, null) : null;
  res.json({
    ...s, deps: undefined,
    resource_name: (() => { try { const r = db.prepare(`SELECT * FROM ${revisions.TABLE[s.resource_type]} WHERE id = ?`).get(s.resource_id); return r ? (r.name || r.filename) : null; } catch (_) { return null; } })(),
    affected_devices: approvals.affectedDevices(db, s.resource_type, s.resource_id).length,
    revision: rev ? { ...rev, state: revisions.redactState(state) } : null,
    live_state: live ? revisions.redactState(live) : null,
    diff_from_live: state ? revisions.diffFromLive(s.resource_type, live, state) : null,
    names: namesFor(req.workspaceId, [state, live]),
    authors: [...approvals.authorsOf(db, s)],
    is_reviewer: approvals.isReviewer(db, req.workspaceId, req.user.id),
    ...publishRight(req, s),
    // A content request: who sent it, where and when it should show, and whether this member may
    // decide it (with approval off, any editor may; see approvals.mayDecide).
    request: (() => { const r = requestOf(s); return r ? require('../lib/content-requests').requestDetail(r, req) : null; })(),
  });
});

/*
 * Head office (spec §6.2, R11): a reviewer in the HQ workspace may APPROVE a corporate playlist, but
 * only a corporate author may PUBLISH it — publishPlaylist refuses anyone else. The queue says so
 * ("Waiting for an admin to publish") instead of offering a Publish button that is refused.
 */
function publishRight(req, s) {
  const write = canWrite(req);
  if (s.resource_type !== 'playlist') return { can_publish: write };
  const corpGuard = require('../lib/corporate/guard');
  const g = corpGuard.governanceOf(db, s.resource_id);
  if (g.kind !== 'corporate' && g.kind !== 'corporate_child') return { can_publish: write };
  const author = !req.viaToken && corpGuard.canAuthor(req, g.orgId);
  return { can_publish: write && author, waiting_for_author: !author, corporate: true };
}

/*
 * 3.0 content requests (lib/content-requests.js). A submission that reviews a request is decided in
 * the queue like any other, but the request is what the reviewer is deciding: approving puts it on its
 * screens for its dates (through the release gate), asking for changes rejects it and mails the
 * requester the reason, and withdrawing cancels it. So those three hand over to the request's own
 * handlers, which call approvals.decide themselves — nothing here decides twice.
 */
function requestOf(sub) {
  const r = sub && sub.request_id ? require('../lib/content-requests').getRequest(sub.request_id, sub.workspace_id) : null;
  return r && r.submission_id === sub.id ? r : null;
}

router.post('/:id/withdraw', requireWorkspaceWrite, (req, res) => {
  const sub = loadSubmission(req, res);
  if (!sub) return;
  const r = requestOf(sub);
  if (r && r.status === 'pending') {
    // Staff withdrawing a request from the queue cancels it; the requester's status link says so.
    require('../lib/content-requests').cancelRequest(r, { by: req.user.id, ip: req.ip });
    return res.json(approvals.getSubmission(db, sub.id));
  }
  try { res.json(approvals.withdraw(db, { submissionId: req.params.id, actor: actor(req), isAdmin: canAdmin(req), ip: req.ip })); }
  catch (e) { fail(res, e); }
});

router.post('/:id/approve', requireWorkspaceWrite, async (req, res) => {
  const sub = loadSubmission(req, res);
  if (!sub) return;
  const r = requestOf(sub);
  if (r) {
    try {
      const out = await require('../lib/content-requests').approveRequest(req, r.id, { comment: req.body && req.body.comment, version: req.body && req.body.version });
      automationEvent(sub, 'content_approved');
      return res.json({ ...approvals.getSubmission(db, sub.id), request: out.request, all_published: out.all_published });
    } catch (e) { return fail(res, e); }
  }
  try {
    const out = approvals.decide(db, { submissionId: req.params.id, decision: 'approve', reviewer: actor(req), comment: req.body && req.body.comment, expectedVersion: req.body && req.body.version, ip: req.ip });
    automationEvent(sub, 'content_approved');
    res.json(out);
  }
  catch (e) { fail(res, e); }
});

/** Zapier-style subscribers (lib/automation/events.js): what was approved / released, by name. */
function automationEvent(sub, type) {
  const table = { content: 'content', playlist: 'playlists', widget: 'widgets', layout: 'layouts' }[sub.resource_type];
  let name = null;
  try { if (table) { const r = db.prepare(`SELECT ${table === 'content' ? 'filename' : 'name'} AS n FROM ${table} WHERE id = ?`).get(sub.resource_id); name = r ? r.n : null; } } catch (_) { /* */ }
  const data = type === 'playlist_published'
    ? { playlist_id: sub.resource_id, playlist_name: name, submission_id: sub.id }
    : { resource_type: sub.resource_type, resource_id: sub.resource_id, name, submission_id: sub.id };
  require('../lib/automation/events').emit(db, sub.workspace_id, type, data);
}

router.post('/:id/request-changes', requireWorkspaceWrite, (req, res) => {
  const sub = loadSubmission(req, res);
  if (!sub) return;
  const r = requestOf(sub);
  if (r) {
    // A requester cannot edit and resubmit, so "changes requested" on a request is a decline with a reason.
    try {
      require('../lib/content-requests').rejectRequest(req, r.id, { reason: req.body && req.body.comment, version: req.body && req.body.version });
      return res.json(approvals.getSubmission(db, sub.id));
    } catch (e) { return fail(res, e); }
  }
  try { res.json(approvals.decide(db, { submissionId: req.params.id, decision: 'request_changes', reviewer: actor(req), comment: req.body && req.body.comment, expectedVersion: req.body && req.body.version, ip: req.ip })); }
  catch (e) { fail(res, e); }
});

/*
 * Approval and publishing are two acts. Approving records a decision; THIS releases the
 * approved revision to screens, and only a member who could publish anyway may do it. The gate
 * is re-run here, so an edit or an asset change between approval and this click is refused.
 */
router.post('/:id/publish', requireWorkspaceWrite, async (req, res) => {
  const s = loadSubmission(req, res);
  if (!s) return;
  if (s.status !== 'approved') return res.status(409).json({ error: `This submission is ${s.status.replace('_', ' ')}; only an approved submission can be published`, code: 'not_approved' });
  const r = requestOf(s);
  if (r) {
    try {
      const out = await require('../lib/content-requests').publishRequest(req, r.id);
      return res.json({ submission: approvals.getSubmission(db, s.id), released: out.all_published, request: out.request });
    } catch (e) { return fail(res, e); }
  }
  try {
    const out = releases.releaseDraft(db, s.resource_type, s.resource_id, req, { actor: actor(req) });
    if (s.resource_type === 'playlist') automationEvent(s, 'playlist_published');
    res.json({ submission: approvals.getSubmission(db, s.id), released: true, changed: out && out.changed !== false });
  } catch (e) { fail(res, e); }
});

module.exports = router;
