'use strict';

/*
 * The plugin allowlist. A row here is a platform admin saying "this exact tree
 * hash may be require()'d". Uploaded plugins always have a row (P9). A drop-folder
 * plugin can be pinned the same way, so an unexpected edit on disk becomes a load
 * error instead of a silent new payload.
 *
 * ⚠️ ABSENCE IS THE DROP-FOLDER PATH. A plugin with no row and allowlist_required=0
 * loads the way it always did: enable + restart. Adding a row is the operator
 * choosing to lock it. Revoking an upload-sourced row does not go back to that
 * path — allowlist_required stays set, so the next boot refuses rather than
 * treating a previously-uploaded tree as operator-dropped.
 */

const { hashTree } = require('./inbox');

function get(db, pluginId) {
  try {
    return db.prepare('SELECT * FROM plugin_allowlist WHERE plugin_id = ?').get(pluginId) || null;
  } catch (e) {
    if (/no such table/i.test(e.message)) return null;
    throw e;
  }
}

function list(db) {
  try {
    return db.prepare('SELECT * FROM plugin_allowlist ORDER BY approved_at DESC').all();
  } catch (e) {
    if (/no such table/i.test(e.message)) return [];
    throw e;
  }
}

function pin(db, { pluginId, sha256, source, submissionId, approvedBy, note }) {
  if (!pluginId || !sha256 || !approvedBy) throw new Error('pluginId, sha256 and approvedBy are required');
  const src = source === 'upload' ? 'upload' : 'pin';
  db.prepare(`
    INSERT INTO plugin_allowlist (plugin_id, sha256, source, submission_id, approved_by, approved_at, note)
    VALUES (?, ?, ?, ?, ?, strftime('%s','now'), ?)
    ON CONFLICT(plugin_id) DO UPDATE SET
      sha256 = excluded.sha256,
      source = excluded.source,
      submission_id = excluded.submission_id,
      approved_by = excluded.approved_by,
      approved_at = excluded.approved_at,
      note = excluded.note
  `).run(pluginId, sha256, src, submissionId || null, approvedBy, note || null);
  db.prepare(`
    INSERT INTO plugin_state (id, enabled, allowlist_required, updated_at)
    VALUES (?, 0, 1, strftime('%s','now'))
    ON CONFLICT(id) DO UPDATE SET allowlist_required = 1, updated_at = excluded.updated_at
  `).run(pluginId);
  return get(db, pluginId);
}

function unpin(db, pluginId) {
  const row = get(db, pluginId);
  if (!row) return null;
  db.prepare('DELETE FROM plugin_allowlist WHERE plugin_id = ?').run(pluginId);
  if (row.source === 'upload') {
    db.prepare(`
      UPDATE plugin_state SET enabled = 0, allowlist_required = 1, updated_at = strftime('%s','now')
      WHERE id = ?
    `).run(pluginId);
  } else {
    db.prepare(`
      UPDATE plugin_state SET allowlist_required = 0, updated_at = strftime('%s','now')
      WHERE id = ?
    `).run(pluginId);
  }
  return row;
}

function assertLoadable(db, pluginId, dir) {
  let required = 0;
  try {
    const state = db.prepare('SELECT allowlist_required FROM plugin_state WHERE id = ?').get(pluginId);
    required = state && Number(state.allowlist_required) === 1 ? 1 : 0;
  } catch (e) {
    if (!/no such table|no such column/i.test(e.message)) throw e;
  }
  const row = get(db, pluginId);
  if (!required && !row) return null;
  if (!row) return 'not on the allowlist';
  const actual = hashTree(dir);
  if (actual !== row.sha256) {
    return 'files changed since approval (sha256 mismatch)';
  }
  return null;
}

module.exports = { get, list, pin, unpin, assertLoadable, hashTree };
