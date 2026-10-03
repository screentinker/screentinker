'use strict';

// Content approval: settings, reviewer assignment, submissions and the review queue.
// Enforced here and in lib/release-policy.js; the dashboard only reflects what these say.

const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { canWrite, canAdmin, requireWorkspaceWrite, requireWorkspaceAdmin, requireWorkspaceRead } = require('../lib/permissions');
const approvals = require('../lib/approvals');
const revisions = require('../lib/revisions');
const releases = require('../lib/releases');
const { ReleaseError } = require('../lib/release-policy');

function fail(res, e) {
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
    diff_from_live: state ? revisions.diffStates(s.resource_type, live, state) : null,
    authors: [...approvals.authorsOf(db, s)],
    is_reviewer: approvals.isReviewer(db, req.workspaceId, req.user.id),
    can_publish: canWrite(req),
  });
});

router.post('/:id/withdraw', requireWorkspaceWrite, (req, res) => {
  if (!loadSubmission(req, res)) return;
  try { res.json(approvals.withdraw(db, { submissionId: req.params.id, actor: actor(req), isAdmin: canAdmin(req), ip: req.ip })); }
  catch (e) { fail(res, e); }
});

router.post('/:id/approve', requireWorkspaceWrite, (req, res) => {
  if (!loadSubmission(req, res)) return;
  try { res.json(approvals.decide(db, { submissionId: req.params.id, decision: 'approve', reviewer: actor(req), comment: req.body && req.body.comment, expectedVersion: req.body && req.body.version, ip: req.ip })); }
  catch (e) { fail(res, e); }
});

router.post('/:id/request-changes', requireWorkspaceWrite, (req, res) => {
  if (!loadSubmission(req, res)) return;
  try { res.json(approvals.decide(db, { submissionId: req.params.id, decision: 'request_changes', reviewer: actor(req), comment: req.body && req.body.comment, expectedVersion: req.body && req.body.version, ip: req.ip })); }
  catch (e) { fail(res, e); }
});

/*
 * Approval and publishing are two acts. Approving records a decision; THIS releases the
 * approved revision to screens, and only a member who could publish anyway may do it. The gate
 * is re-run here, so an edit or an asset change between approval and this click is refused.
 */
router.post('/:id/publish', requireWorkspaceWrite, (req, res) => {
  const s = loadSubmission(req, res);
  if (!s) return;
  if (s.status !== 'approved') return res.status(409).json({ error: `This submission is ${s.status.replace('_', ' ')}; only an approved submission can be published`, code: 'not_approved' });
  try {
    const out = releases.releaseDraft(db, s.resource_type, s.resource_id, req, { actor: actor(req) });
    res.json({ submission: approvals.getSubmission(db, s.id), released: true, changed: out && out.changed !== false });
  } catch (e) { fail(res, e); }
});

module.exports = router;
