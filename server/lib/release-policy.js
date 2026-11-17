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
 *
 * Deletes are a release too: deleting content or a widget scrubs it out of every published copy
 * that plays it. Those routes ask liveReferences() and mayChangeLiveUnreviewed() below (GHSA-rvxj 9.1).
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
    /*
     * ⚠️ A smart playlist's content is whatever its rules match, not playlist_items. Without this an
     * approval would cover the RULES only: content tagged or uploaded after the approval would ride
     * the approved release onto screens unreviewed. With it, a change in the matches makes the
     * approval stale, exactly as editing a hand-built playlist's items does.
     */
    try {
      const row = db.prepare('SELECT * FROM playlists WHERE id = ?').get(id);
      if (row && row.smart_rules) {
        for (const c of require('./smart-playlist').matchContent(db, row)) out.content[c.id] = String(c.updated_at || 0);
      }
    } catch (_) { /* a playlist without the column (embedded schema) has no rules */ }
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

/*
 * GHSA-rvxj 9.1: may this user change what screens show WITHOUT a review, in a workspace that
 * requires one? Yes when approval is off; otherwise only the people who could have signed the change
 * off anyway: an assigned reviewer (approvals.isReviewer, which also rechecks they still hold write
 * access) or an admin of the workspace (canAdminWorkspace: they can switch approval off, so refusing
 * them protects nothing). The same set ai-private's translation approve admits. Operators are not
 * admins here, as everywhere else canAdminWorkspace is used.
 */
function mayChangeLiveUnreviewed(db, workspaceId, user) {
  if (!approvalRequired(db, workspaceId)) return true;
  if (!user) return false;
  const ws = db.prepare('SELECT id, organization_id FROM workspaces WHERE id = ?').get(workspaceId);
  if (require('./permissions').canAdminWorkspace(db, user, ws)) return true;
  return require('./approvals').isReviewer(db, workspaceId, user.id);
}

/*
 * GHSA-rvxj 9.1: the published playlists in a workspace whose LIVE copy plays this content or widget
 * (names, for the refusal message). The published snapshot (and a corporate playlist's composable)
 * is what screens play, and it is exactly what the content delete scrubs, so that is what's read:
 * nested and smart playlists are flattened into it, and a draft edit that already removed the item
 * doesn't count until it's published. For content, a widget whose live config names the file
 * (a published slide, a template background) counts when that widget is itself in a published copy.
 * ⚠️ LIKE on the id, the way purgeContentRow scrubs; `%`, `_` and `\` are escaped so an odd id can
 * only ever match itself.
 */
function liveReferences(db, workspaceId, kind, id) {
  if (!workspaceId || !id) return [];
  const like = (v) => `%${String(v).replace(/[\\%_]/g, (c) => '\\' + c)}%`;
  let hasComposable = false;
  try { hasComposable = require('./corporate/schema-probe').hasColumn(db, 'playlists', 'published_composable'); } catch (_) { /* old schema */ }
  const playlistsNaming = (v) => db.prepare(`SELECT name FROM playlists WHERE workspace_id = ?
      AND (published_snapshot LIKE ? ESCAPE '\\'${hasComposable ? " OR published_composable LIKE ? ESCAPE '\\'" : ''})`)
    .all(workspaceId, like(v), ...(hasComposable ? [like(v)] : [])).map((r) => r.name);
  const names = new Set(playlistsNaming(id));
  if (kind === 'content') {
    for (const w of db.prepare("SELECT id FROM widgets WHERE workspace_id = ? AND config LIKE ? ESCAPE '\\'").all(workspaceId, like(id))) {
      for (const n of playlistsNaming(w.id)) names.add(n);
    }
  }
  return [...names];
}

/*
 * GHSA-rvxj 9.1: the refusal for deleting something live without review, or null when the delete
 * may go ahead (approval off, a reviewer/admin, or nothing published plays it). Callers send it as
 * 403 code 'review_required' BEFORE any side effect.
 */
function liveDeleteRefusal(db, { workspaceId, kind, id, label, user }) {
  if (!workspaceId || mayChangeLiveUnreviewed(db, workspaceId, user)) return null;
  const live = liveReferences(db, workspaceId, kind, id);
  if (!live.length) return null;
  const names = live.slice(0, 3).map((n) => `"${n}"`).join(', ') + (live.length > 3 ? ` and ${live.length - 3} more` : '');
  return `"${label || id}" is live in published ${live.length === 1 ? 'playlist' : 'playlists'} ${names}, and this workspace requires review before what screens show changes. `
    + 'Remove it from the playlist and publish that for review, or ask a reviewer or admin to delete it.';
}

module.exports = { ReleaseError, approvalRequired, mayChangeLiveUnreviewed, liveReferences, liveDeleteRefusal, depsOf, depsChanged, assertReleasable, afterRelease };
