'use strict';

/*
 * Retention for version history and the media bytes it keeps.
 *
 * POLICY (documented in docs/approvals-and-history.md): per resource, the newest KEEP revisions
 * are always kept, and so is any revision that is (a) the current live release, (b) referenced
 * by any submission, open or closed (review history is kept), or (c) the baseline. Older revisions beyond that are deleted. A retained
 * media file under <contentDir>/.history/ is removed only when no remaining revision names it,
 * no content row serves it live or holds it as a draft, and it is not a file in the content dir
 * proper. Nothing here touches a file that anything can still show.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const revisions = require('./revisions');

const KEEP = Math.max(3, parseInt(process.env.REVISION_KEEP || '20', 10) || 20);

function prune(db, { keep = KEEP } = {}) {
  const out = { revisions_deleted: 0, files_deleted: 0, files_kept: 0 };
  const resources = db.prepare('SELECT DISTINCT resource_type, resource_id FROM revisions').all();
  // Any revision a submission ever pointed at stays: review history is preserved, and the
  // submissions table references revisions by foreign key.
  const openRevIds = new Set(db.prepare('SELECT revision_id FROM submissions').all().map((r) => r.revision_id));
  const del = db.prepare('DELETE FROM revisions WHERE id = ?');
  const txn = db.transaction(() => {
    for (const { resource_type: type, resource_id: id } of resources) {
      const rows = db.prepare('SELECT id, rev_no, published_at, is_baseline FROM revisions WHERE resource_type = ? AND resource_id = ? ORDER BY rev_no DESC').all(type, id);
      const live = revisions.lastPublished(db, type, id);
      rows.forEach((r, i) => {
        if (i < keep) return;
        if (live && r.id === live.id) return;
        if (openRevIds.has(r.id)) return;
        if (r.is_baseline) return;
        del.run(r.id); out.revisions_deleted++;
      });
    }
  });
  txn();

  // Files: anything under .history that nothing names any more.
  const hist = revisions.historyDir();
  if (!fs.existsSync(hist)) return out;
  const named = new Set();
  for (const r of db.prepare('SELECT file_ref, thumb_ref FROM revisions WHERE file_ref IS NOT NULL OR thumb_ref IS NOT NULL').all()) {
    if (r.file_ref) named.add(norm(r.file_ref)); if (r.thumb_ref) named.add(norm(r.thumb_ref));
  }
  for (const c of db.prepare('SELECT filepath, thumbnail_path, draft_json FROM content').all()) {
    if (c.filepath) named.add(norm(c.filepath)); if (c.thumbnail_path) named.add(norm(c.thumbnail_path));
    const d = revisions.parseJson(c.draft_json, null);
    if (d && d.filepath) named.add(norm(d.filepath));
  }
  for (const contentId of fs.readdirSync(hist)) {
    const dir = path.join(hist, contentId);
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch (_) { continue; }
    for (const f of entries) {
      const rel = norm(path.join(revisions.HISTORY_DIR, contentId, f));
      if (named.has(rel)) { out.files_kept++; continue; }
      try { fs.unlinkSync(path.join(dir, f)); out.files_deleted++; } catch (_) {}
    }
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch (_) {}
  }
  return out;
}

function norm(p) { return String(p).replace(/\\/g, '/'); }

let timer = null;
function start(db, intervalMs = 24 * 60 * 60 * 1000) {
  if (timer) return;
  const run = () => { try { const r = prune(db); if (r.revisions_deleted || r.files_deleted) console.log('[history] pruned', r); } catch (e) { console.warn('[history] prune failed:', e.message); } };
  setTimeout(run, 60 * 1000).unref?.();
  timer = setInterval(run, intervalMs);
  timer.unref?.();
}

module.exports = { prune, start, KEEP };
