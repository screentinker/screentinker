'use strict';

/*
 * The one gate every path that changes live playback consults.
 *
 * With approval OFF (the default for every workspace) this returns immediately and nothing
 * about publishing changes. With approval ON, a resource may be released only when a submission
 * exists that was APPROVED FOR EXACTLY THE STATE ABOUT TO GO LIVE: the submission carries the
 * revision's state hash and the revs of the assets it depends on, and both are recomputed here.
 * Editing after approval, or replacing an image the approved playlist shows, invalidates the
 * approval by construction rather than by remembering to.
 *
 * Callers: routes/playlists publish, routes/slide-decks publish, agency auto-publish, the
 * content-only schedule's generated playlist, and the draft publish for widgets, layouts and
 * content (routes/revisions.js). Ancestor republish inside publishPlaylist() is not a separate
 * release: it re-flattens an already-published parent with a child that just passed this gate.
 */

const revisions = require('./revisions');

class ReleaseError extends Error {
  constructor(message, code, status = 409) { super(message); this.name = 'ReleaseError'; this.code = code; this.status = status; }
}

function approvalRequired(db, workspaceId) {
  if (!workspaceId) return false;
  try {
    const row = db.prepare('SELECT require_approval FROM workspaces WHERE id = ?').get(workspaceId);
    return !!(row && row.require_approval);
  } catch (_) { return false; }
}

/**
 * The assets a resource's release depends on, with their current revision markers. Only
 * AUTHORED dependencies: a playlist's content and widgets, a deck's media. Live external data a
 * widget pulls at render time (weather, a feed) is not authored and is not tracked here.
 */
function depsOf(db, type, id) {
  const out = { content: {}, widget: {}, playlist: {} };
  const stamp = (table, rid) => {
    try {
      const r = db.prepare(`SELECT updated_at${table === 'playlists' ? ', published_snapshot' : ''} FROM ${table} WHERE id = ?`).get(rid);
      if (!r) return 'missing';
      return table === 'playlists' ? revisions.hashState(r.published_snapshot || '') : String(r.updated_at || 0);
    } catch (_) { return 'missing'; }
  };
  if (type === 'playlist') {
    for (const it of db.prepare('SELECT content_id, widget_id, child_playlist_id FROM playlist_items WHERE playlist_id = ?').all(id)) {
      if (it.content_id) out.content[it.content_id] = stamp('content', it.content_id);
      if (it.widget_id) out.widget[it.widget_id] = stamp('widgets', it.widget_id);
      if (it.child_playlist_id) out.playlist[it.child_playlist_id] = stamp('playlists', it.child_playlist_id);
    }
  } else if (type === 'slide_deck') {
    const cap = revisions.captureState(db, 'slide_deck', id);
    const doc = cap && cap.state.doc || {};
    const ids = new Set();
    for (const s of doc.slides || []) {
      const t = s.template || {};
      for (const k of ['background_content_id', 'background_video_content_id']) if (t[k]) ids.add(t[k]);
      const a = t.audio || {};
      for (const k of ['vo', 'music']) if (a[k]) ids.add(a[k]);
      for (const e of t.elements || []) if (e && e.content_id) ids.add(e.content_id);
    }
    if (doc.music) ids.add(doc.music);
    for (const cid of ids) out.content[cid] = stamp('content', cid);
  }
  return out;
}

function depsChanged(before, now) {
  const changed = [];
  for (const kind of ['content', 'widget', 'playlist']) {
    const a = (before && before[kind]) || {}, b = (now && now[kind]) || {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) changed.push(`${kind}:${k}`);
  }
  return changed;
}

/**
 * May this resource go live right now? Returns { mode: 'direct' } when the workspace does not
 * require approval, { mode: 'approved', submission } when an approval covers exactly the
 * current state, and throws ReleaseError otherwise.
 */
function assertReleasable(db, { workspaceId, type, id }) {
  if (!approvalRequired(db, workspaceId)) return { mode: 'direct' };
  const cap = revisions.captureState(db, type, id);
  if (!cap) throw new ReleaseError('Not found', 'not_found', 404);
  const hash = revisions.hashState(cap.state);
  const sub = db.prepare(`SELECT * FROM submissions WHERE resource_type = ? AND resource_id = ? AND status = 'approved'
                          ORDER BY decided_at DESC, submitted_at DESC LIMIT 1`).get(type, id);
  if (!sub) {
    const open = db.prepare(`SELECT status FROM submissions WHERE resource_type = ? AND resource_id = ? AND status IN ('submitted','changes_requested') ORDER BY submitted_at DESC LIMIT 1`).get(type, id);
    if (open && open.status === 'submitted') throw new ReleaseError('This is waiting for review. It can be published once a reviewer approves it.', 'awaiting_review');
    if (open && open.status === 'changes_requested') throw new ReleaseError('A reviewer requested changes. Address them and submit again.', 'changes_requested');
    throw new ReleaseError('This workspace requires review before publishing. Submit it for review first.', 'approval_required');
  }
  if (sub.state_hash !== hash) {
    throw new ReleaseError('This was edited after it was approved. The approval covers the reviewed version only; submit the new version for review.', 'approval_stale');
  }
  const changed = depsChanged(revisions.parseJson(sub.deps, {}), depsOf(db, type, id));
  if (changed.length) {
    throw new ReleaseError(`Something this depends on changed after approval (${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ', ...' : ''}). Submit it again for review.`, 'deps_changed');
  }
  // The approver's standing is rechecked NOW, not just when they decided: a reviewer removed from
  // the list, or downgraded to viewer, takes their approval with them. The submission goes back
  // to the queue so the state is visible rather than a dead end.
  if (!require('./approvals').isReviewer(db, workspaceId, sub.reviewer_id)) {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`UPDATE submissions SET status = 'submitted', reviewer_id = NULL, decided_at = NULL,
                  comment = COALESCE(comment, '') || ' [The approving reviewer no longer has reviewer access; another review is required]',
                  updated_at = ?, version = version + 1 WHERE id = ? AND status = 'approved'`).run(now, sub.id);
    throw new ReleaseError('The reviewer who approved this no longer has reviewer access. It has been returned to the review queue.', 'approver_ineligible');
  }
  return { mode: 'approved', submission: sub };
}

/** Record the release: the revision is marked published and the submission, if any, closed. */
function afterRelease(db, { type, id, gate, actor, summary = 'Published' }) {
  const submissionId = gate && gate.submission ? gate.submission.id : null;
  const rev = revisions.markPublished(db, type, id, { actor, summary, submissionId });
  if (submissionId) {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`UPDATE submissions SET status = 'published', published_at = ?, published_by = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status = 'approved'`)
      .run(now, actor && actor.userId || null, now, submissionId);
  }
  return rev;
}

module.exports = { ReleaseError, approvalRequired, depsOf, depsChanged, assertReleasable, afterRelease };
