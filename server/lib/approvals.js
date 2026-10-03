'use strict';

/*
 * Content approval: Draft -> Submitted -> Approved -> Published, with "changes requested" and
 * withdrawal. Optional per workspace, off by default; lib/release-policy.js is what makes it
 * binding. This file owns the settings, the reviewer list, and the submission state machine.
 *
 * Reviewers are EXISTING members with write access, named explicitly by a workspace admin. No
 * role is invented and nobody gains access they did not have: a reviewer who loses their
 * membership (or is downgraded to viewer) stops being able to review the moment it happens,
 * because eligibility is re-read on every decision, not cached on the assignment.
 *
 * Self-approval is refused twice over: the submitter cannot approve, and neither can anyone who
 * authored a revision inside the submission (between the last published revision and the one
 * under review). A single-user workspace therefore cannot enable approval at all, and the
 * settings endpoint says so before the switch is offered.
 */

const crypto = require('crypto');
const revisions = require('./revisions');
const policy = require('./release-policy');
const { audit } = require('./audit');

const WRITE_ROLES = new Set(['workspace_admin', 'workspace_editor']);
const OPEN = ['submitted', 'changes_requested', 'approved'];

class ApprovalError extends Error {
  constructor(message, status = 409, code = null) { super(message); this.name = 'ApprovalError'; this.status = status; this.code = code; }
}
const nowSec = () => Math.floor(Date.now() / 1000);

// ─── settings and reviewers ──────────────────────────────────────────────────────────────────

function eligibleMembers(db, workspaceId) {
  return db.prepare(`SELECT u.id, u.email, u.name, m.role FROM workspace_members m JOIN users u ON u.id = m.user_id
                      WHERE m.workspace_id = ? AND m.role IN ('workspace_admin','workspace_editor') ORDER BY u.email`).all(workspaceId);
}

function reviewers(db, workspaceId) {
  const elig = new Map(eligibleMembers(db, workspaceId).map((u) => [u.id, u]));
  return db.prepare(`SELECT r.user_id, r.added_by, r.created_at, u.email, u.name FROM workspace_reviewers r LEFT JOIN users u ON u.id = r.user_id
                      WHERE r.workspace_id = ? ORDER BY u.email`).all(workspaceId)
    .map((r) => ({ ...r, eligible: elig.has(r.user_id), role: elig.get(r.user_id)?.role || null }));
}

/** Is this user, right now, an assigned reviewer who still holds write access here? */
function isReviewer(db, workspaceId, userId) {
  if (!userId) return false;
  const row = db.prepare('SELECT 1 FROM workspace_reviewers WHERE workspace_id = ? AND user_id = ?').get(workspaceId, userId);
  if (!row) return false;
  const m = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(workspaceId, userId);
  return !!(m && WRITE_ROLES.has(m.role));
}

function settings(db, workspaceId) {
  const ws = db.prepare('SELECT id, require_approval FROM workspaces WHERE id = ?').get(workspaceId);
  if (!ws) return null;
  const list = reviewers(db, workspaceId);
  const eligible = eligibleMembers(db, workspaceId);
  const activeReviewers = list.filter((r) => r.eligible);
  const reasons = [];
  if (eligible.length < 2) reasons.push('single_user');
  if (activeReviewers.length === 0) reasons.push('no_reviewer');
  const pending = db.prepare(`SELECT COUNT(*) AS n FROM submissions WHERE workspace_id = ? AND status IN ('submitted','changes_requested','approved')`).get(workspaceId).n;
  /*
   * ⚠️ BOTH blockers gate enabling, not just the reviewer one.
   *
   * A lone admin can tick themselves as the reviewer, which satisfies "at least one reviewer" and
   * used to be enough. Approval then turns on and the workspace can never publish again: every
   * submission is authored by the only person who could review it, decide() refuses it as
   * self_approval, and assertReleasable refuses every release. The only way out is an admin
   * turning the setting back off, which is not discoverable from the error.
   */
  return { require_approval: !!ws.require_approval, reviewers: list, eligible, can_enable: reasons.length === 0, enable_blockers: reasons, pending_submissions: pending };
}

function updateSettings(db, { workspaceId, requireApproval, reviewerIds, actor, ip }) {
  const ws = db.prepare('SELECT id, require_approval FROM workspaces WHERE id = ?').get(workspaceId);
  if (!ws) throw new ApprovalError('Workspace not found', 404);
  const eligible = new Set(eligibleMembers(db, workspaceId).map((u) => u.id));
  const txn = db.transaction(() => {
    if (Array.isArray(reviewerIds)) {
      const bad = reviewerIds.filter((u) => !eligible.has(u));
      if (bad.length) throw new ApprovalError('Reviewers must be members of this workspace with edit or admin access', 400, 'reviewer_not_eligible');
      const before = new Set(db.prepare('SELECT user_id FROM workspace_reviewers WHERE workspace_id = ?').all(workspaceId).map((r) => r.user_id));
      db.prepare('DELETE FROM workspace_reviewers WHERE workspace_id = ?').run(workspaceId);
      const ins = db.prepare('INSERT OR IGNORE INTO workspace_reviewers (workspace_id, user_id, added_by, created_at) VALUES (?, ?, ?, ?)');
      for (const u of new Set(reviewerIds)) ins.run(workspaceId, u, actor && actor.userId || null, nowSec());
      const after = new Set(reviewerIds);
      const added = [...after].filter((u) => !before.has(u)), removed = [...before].filter((u) => !after.has(u));
      if (removed.length) {
        // An approval is only as good as the reviewer's current standing. Reopen theirs, visibly.
        const now = nowSec();
        const reopen = db.prepare(`UPDATE submissions SET status = 'submitted', reviewer_id = NULL, decided_at = NULL,
                                     comment = COALESCE(comment, '') || ' [Approved by a reviewer who was since removed; another review is required]',
                                     updated_at = ?, version = version + 1 WHERE workspace_id = ? AND status = 'approved' AND reviewer_id = ?`);
        for (const u of removed) reopen.run(now, workspaceId, u);
      }
      if (added.length || removed.length) audit('approval:reviewers_changed', { userId: actor && actor.userId, workspaceId, ip, details: { added, removed } });
    }
    if (requireApproval !== undefined) {
      const want = requireApproval ? 1 : 0;
      if (want && !ws.require_approval) {
        // Server-side twin of settings().can_enable. The dashboard disables the checkbox, but the
        // API is the thing that has to hold: enabling on a single-member workspace is a lockout.
        const active = reviewers(db, workspaceId).filter((r) => r.eligible);
        if (active.length === 0) throw new ApprovalError('Assign at least one reviewer with edit or admin access before requiring approval', 400, 'no_reviewer');
        if (eligible.size < 2) {
          throw new ApprovalError('This workspace has only one member with edit or admin access, so nobody could review anyone else\'s work. Add a second editor or admin before requiring approval.', 400, 'single_user');
        }
      }
      if (want !== ws.require_approval) {
        db.prepare('UPDATE workspaces SET require_approval = ? WHERE id = ?').run(want, workspaceId);
        let cancelled = 0;
        if (!want) {
          // Turning approval off never publishes what was waiting: every open submission is closed
          // as cancelled, its history kept, and the creator publishes through the normal path.
          const now = nowSec();
          cancelled = db.prepare(`UPDATE submissions SET status = 'cancelled', comment = COALESCE(comment, '') || ?, decided_at = ?, updated_at = ?, version = version + 1
                                   WHERE workspace_id = ? AND status IN ('submitted','changes_requested','approved')`)
            .run(' [Approval was turned off for this workspace; the submission was closed without publishing]', now, now, workspaceId).changes;
        }
        audit(want ? 'approval:enabled' : 'approval:disabled', { userId: actor && actor.userId, workspaceId, ip, details: { cancelled_submissions: cancelled } });
      }
    }
  });
  txn();
  return settings(db, workspaceId);
}

// ─── submissions ─────────────────────────────────────────────────────────────────────────────

function resourceOf(db, type, id) {
  const table = revisions.TABLE[type];
  if (!table) throw new ApprovalError('Unknown resource type', 400);
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) throw new ApprovalError('Not found', 404);
  return row;
}

function submit(db, { type, id, workspaceId, actor, note, ip }) {
  const row = resourceOf(db, type, id);
  if (row.workspace_id !== workspaceId) throw new ApprovalError('Not found', 404);
  const cap = revisions.captureState(db, type, id);
  const hash = revisions.hashState(cap.state);
  const live = revisions.captureLiveState(db, type, id);
  if (live && revisions.hashState(live) === hash && type !== 'slide_deck') {
    throw new ApprovalError('There are no unpublished changes to submit', 400, 'nothing_to_submit');
  }
  const now = nowSec();
  let sub;
  const txn = db.transaction(() => {
    const rev = revisions.recordCurrent(db, type, id, { actor, summary: 'Submitted for review' });
    db.prepare(`UPDATE submissions SET status = 'superseded', updated_at = ?, version = version + 1 WHERE resource_type = ? AND resource_id = ? AND status IN ('submitted','changes_requested','approved')`)
      .run(now, type, id);
    sub = {
      id: crypto.randomUUID(), workspace_id: workspaceId, resource_type: type, resource_id: id, revision_id: rev.id, state_hash: hash,
      deps: JSON.stringify(policy.depsOf(db, type, id)), note: note ? String(note).slice(0, 2000) : null,
      submitted_by: actor && actor.userId || null, submitted_at: now, status: 'submitted', updated_at: now,
    };
    db.prepare(`INSERT INTO submissions (id, workspace_id, resource_type, resource_id, revision_id, state_hash, deps, note, submitted_by, submitted_at, status, updated_at)
                VALUES (@id, @workspace_id, @resource_type, @resource_id, @revision_id, @state_hash, @deps, @note, @submitted_by, @submitted_at, @status, @updated_at)`).run(sub);
    db.prepare('UPDATE revisions SET submission_id = ? WHERE id = ?').run(sub.id, rev.id);
  });
  txn();
  audit('approval:submitted', { userId: actor && actor.userId, workspaceId, ip, details: { submission_id: sub.id, resource_type: type, resource_id: id } });
  return getSubmission(db, sub.id);
}

function getSubmission(db, submissionId) {
  return db.prepare(`SELECT s.*, su.email AS submitter_email, su.name AS submitter_name, ru.email AS reviewer_email, ru.name AS reviewer_name, r.rev_no
                       FROM submissions s LEFT JOIN users su ON su.id = s.submitted_by LEFT JOIN users ru ON ru.id = s.reviewer_id
                       LEFT JOIN revisions r ON r.id = s.revision_id WHERE s.id = ?`).get(submissionId) || null;
}

function withdraw(db, { submissionId, actor, isAdmin, ip }) {
  const sub = getSubmission(db, submissionId);
  if (!sub) throw new ApprovalError('Submission not found', 404);
  if (!OPEN.includes(sub.status)) throw new ApprovalError(`This submission is ${sub.status} and cannot be withdrawn`, 409, 'not_open');
  if (sub.submitted_by !== (actor && actor.userId) && !isAdmin) throw new ApprovalError('Only the submitter or a workspace admin can withdraw this', 403);
  const now = nowSec();
  db.prepare(`UPDATE submissions SET status = 'withdrawn', updated_at = ?, version = version + 1 WHERE id = ? AND status IN ('submitted','changes_requested','approved')`).run(now, submissionId);
  audit('approval:withdrawn', { userId: actor && actor.userId, workspaceId: sub.workspace_id, ip, details: { submission_id: submissionId } });
  return getSubmission(db, submissionId);
}

/** Every user who authored a revision inside this submission's span. */
function authorsOf(db, sub) {
  const rev = revisions.get(db, sub.revision_id);
  if (!rev) return new Set([sub.submitted_by]);
  const lastPub = db.prepare('SELECT rev_no FROM revisions WHERE resource_type = ? AND resource_id = ? AND published_at IS NOT NULL AND rev_no < ? ORDER BY rev_no DESC LIMIT 1')
    .get(sub.resource_type, sub.resource_id, rev.rev_no);
  const floor = lastPub ? lastPub.rev_no : 0;
  const rows = db.prepare('SELECT actor_user_id FROM revisions WHERE resource_type = ? AND resource_id = ? AND rev_no > ? AND rev_no <= ? AND actor_user_id IS NOT NULL')
    .all(sub.resource_type, sub.resource_id, floor, rev.rev_no);
  const s = new Set(rows.map((r) => r.actor_user_id));
  if (sub.submitted_by) s.add(sub.submitted_by);
  return s;
}

function decide(db, { submissionId, decision, reviewer, comment, expectedVersion, ip }) {
  const sub = getSubmission(db, submissionId);
  if (!sub) throw new ApprovalError('Submission not found', 404);
  if (!isReviewer(db, sub.workspace_id, reviewer && reviewer.userId)) throw new ApprovalError('You are not an assigned reviewer for this workspace, or no longer have edit access', 403, 'not_reviewer');
  if (authorsOf(db, sub).has(reviewer.userId)) throw new ApprovalError('You cannot approve your own changes. Another reviewer has to look at this one.', 403, 'self_approval');
  if (sub.status !== 'submitted') throw new ApprovalError(`This submission is ${sub.status.replace('_', ' ')}; it is no longer waiting for review`, 409, 'not_pending');
  if (expectedVersion != null && Number(expectedVersion) !== sub.version) throw new ApprovalError('This submission changed while you were reviewing it. Reload and look again.', 409, 'version_conflict');
  // The reviewed revision must still be what the resource holds: an edit after submission
  // supersedes the submission (see submit), but a direct write that bypassed it is caught here.
  const cap = revisions.captureState(db, sub.resource_type, sub.resource_id);
  if (!cap) throw new ApprovalError('The item under review no longer exists', 409, 'gone');
  if (revisions.hashState(cap.state) !== sub.state_hash) {
    throw new ApprovalError('The item was edited after it was submitted. Ask the creator to submit the current version.', 409, 'stale_submission');
  }
  const now = nowSec();
  const status = decision === 'approve' ? 'approved' : 'changes_requested';
  if (status === 'changes_requested' && !(comment && String(comment).trim())) throw new ApprovalError('Say what needs to change', 400, 'comment_required');
  const r = db.prepare(`UPDATE submissions SET status = ?, reviewer_id = ?, decided_at = ?, comment = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status = 'submitted' AND version = ?`)
    .run(status, reviewer.userId, now, comment ? String(comment).slice(0, 2000) : null, now, submissionId, sub.version);
  if (r.changes === 0) throw new ApprovalError('This submission changed while you were reviewing it. Reload and look again.', 409, 'version_conflict');
  audit(status === 'approved' ? 'approval:approved' : 'approval:changes_requested', { userId: reviewer.userId, workspaceId: sub.workspace_id, ip, details: { submission_id: submissionId, resource_type: sub.resource_type, resource_id: sub.resource_id, comment: comment || null } });
  return getSubmission(db, submissionId);
}

function affectedDevices(db, type, id) {
  try {
    const dp = require('./devices-playing');
    if (type === 'playlist') return dp.devicesOnPlaylist(id);
    if (type === 'widget') return dp.devicesPlayingWidget(id);
    if (type === 'content') return dp.devicesPlayingContent(id);
    if (type === 'layout') return db.prepare('SELECT id FROM devices WHERE layout_id = ?').all(id).map((r) => r.id);
    if (type === 'slide_deck') {
      const d = db.prepare('SELECT playlist_id FROM slide_decks WHERE id = ?').get(id);
      return d && d.playlist_id ? dp.devicesOnPlaylist(d.playlist_id) : [];
    }
  } catch (_) {}
  return [];
}

function resourceName(db, type, id) {
  try {
    const row = db.prepare(`SELECT * FROM ${revisions.TABLE[type]} WHERE id = ?`).get(id);
    if (!row) return null;
    return row.name || row.filename || id;
  } catch (_) { return null; }
}

function queue(db, workspaceId, { status = 'open', userId = null } = {}) {
  // Positional parameters, built alongside the clauses: node:sqlite refuses a named parameter the
  // statement does not mention, and better-sqlite3 silently allows it, so the fallback driver in
  // CI was the only place this query broke.
  const clauses = ['s.workspace_id = ?'], params = [workspaceId];
  if (status === 'open') clauses.push("s.status IN ('submitted','changes_requested','approved')");
  else if (status !== 'all') { clauses.push('s.status = ?'); params.push(status); }
  if (userId) { clauses.push('s.submitted_by = ?'); params.push(userId); }
  const rows = db.prepare(`SELECT s.*, su.email AS submitter_email, su.name AS submitter_name, ru.email AS reviewer_email, ru.name AS reviewer_name, r.rev_no
                             FROM submissions s LEFT JOIN users su ON su.id = s.submitted_by LEFT JOIN users ru ON ru.id = s.reviewer_id
                             LEFT JOIN revisions r ON r.id = s.revision_id
                            WHERE ${clauses.join(' AND ')}
                            ORDER BY s.submitted_at DESC LIMIT 200`).all(...params);
  return rows.map((s) => {
    const devices = affectedDevices(db, s.resource_type, s.resource_id);
    const lastPub = revisions.lastPublished(db, s.resource_type, s.resource_id);
    return { ...s, deps: undefined, resource_name: resourceName(db, s.resource_type, s.resource_id), affected_devices: devices.length, affected_device_ids: devices.slice(0, 50), live_revision_id: lastPub ? lastPub.id : null };
  });
}

module.exports = { ApprovalError, OPEN, eligibleMembers, reviewers, isReviewer, settings, updateSettings, submit, withdraw, decide, getSubmission, queue, affectedDevices, authorsOf };
