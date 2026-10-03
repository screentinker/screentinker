'use strict';

/*
 * Plugin submissions. A zip lands here, is inspected, and waits. Approve copies
 * the inspected tree into DATA_DIR/plugins and pins the tree hash. Reject
 * deletes the archive. Neither path require()s plugin code (P9).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { inspectZip, extractZip, hashTree, InboxError } = require('./inbox');
const allowlist = require('./allowlist');
const hooks = require('./hooks');

class SubmissionError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'SubmissionError';
    this.status = status || 400;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function fire(name, payload) {
  try { hooks.emit(name, payload); }
  catch { /* a hook must not fail submit / approve / reject */ }
}

function publicRow(row) {
  if (!row) return null;
  let files = [];
  let manifest = null;
  try { files = JSON.parse(row.files_json || '[]'); } catch { files = []; }
  try { manifest = JSON.parse(row.manifest_json || 'null'); } catch { manifest = null; }
  return {
    id: row.id,
    plugin_id: row.plugin_id,
    name: row.name,
    version: row.version,
    description: row.description,
    sha256: row.sha256,
    tree_sha256: row.tree_sha256,
    files,
    manifest,
    size_bytes: row.size_bytes,
    submitted_by: row.submitted_by,
    workspace_id: row.workspace_id,
    submitted_at: row.submitted_at,
    status: row.status,
    decided_by: row.decided_by,
    decided_at: row.decided_at,
    decision_note: row.decision_note,
  };
}

async function create(db, { buffer, inboxDir, submittedBy, workspaceId }) {
  if (!buffer || !Buffer.isBuffer(buffer) || !buffer.length) {
    throw new SubmissionError('A .zip file is required');
  }
  if (buffer.length > require('./inbox').MAX_ARCHIVE_BYTES) {
    throw new SubmissionError('Plugin archive is too large');
  }
  ensureDir(inboxDir);
  const id = crypto.randomBytes(16).toString('hex');
  const archivePath = path.join(inboxDir, id + '.zip');
  fs.writeFileSync(archivePath, buffer);

  let inspected;
  try {
    inspected = await inspectZip(archivePath);
  } catch (e) {
    try { fs.unlinkSync(archivePath); } catch { /* */ }
    throw e instanceof InboxError ? new SubmissionError(e.message) : e;
  }

  const pending = db.prepare(`
    SELECT id FROM plugin_submissions WHERE plugin_id = ? AND status = 'pending'
  `).get(inspected.pluginId);
  if (pending) {
    try { fs.unlinkSync(archivePath); } catch { /* */ }
    throw new SubmissionError(
      `A pending submission for "${inspected.pluginId}" already exists. Reject it first, or wait.`
    );
  }

  const info = db.prepare(`
    INSERT INTO plugin_submissions (
      plugin_id, name, version, description, sha256, archive_name, manifest_json, files_json,
      size_bytes, submitted_by, workspace_id, submitted_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'), 'pending')
  `).run(
    inspected.pluginId,
    inspected.name,
    inspected.version,
    inspected.description || '',
    inspected.sha256,
    id + '.zip',
    JSON.stringify(inspected.manifest),
    JSON.stringify(inspected.files),
    inspected.archiveBytes,
    submittedBy,
    workspaceId || null
  );

  const row = publicRow(db.prepare('SELECT * FROM plugin_submissions WHERE id = ?').get(Number(info.lastInsertRowid)));
  fire('plugin.submitted', {
    submission_id: row.id,
    plugin_id: row.plugin_id,
    name: row.name,
    version: row.version,
    sha256: row.sha256,
    submitted_by: row.submitted_by,
    workspace_id: row.workspace_id,
  });
  return row;
}

function get(db, id) {
  const row = db.prepare('SELECT * FROM plugin_submissions WHERE id = ?').get(id);
  return publicRow(row);
}

function list(db, { status, submittedBy } = {}) {
  let sql = 'SELECT * FROM plugin_submissions';
  const params = [];
  const where = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (submittedBy) { where.push('submitted_by = ?'); params.push(submittedBy); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY submitted_at DESC';
  return db.prepare(sql).all(...params).map(publicRow);
}

async function approve(db, { id, approvedBy, inboxDir, dataPluginsDir, replace }) {
  const row = db.prepare('SELECT * FROM plugin_submissions WHERE id = ?').get(id);
  if (!row) throw new SubmissionError('Submission not found', 404);
  if (row.status !== 'pending') throw new SubmissionError('This submission is no longer pending', 409);

  const archivePath = path.join(inboxDir, row.archive_name);
  if (!fs.existsSync(archivePath)) throw new SubmissionError('The uploaded archive is gone from disk', 409);

  let inspected;
  try {
    inspected = await inspectZip(archivePath);
  } catch (e) {
    throw new SubmissionError(e.message || 'Archive failed re-inspection');
  }
  if (inspected.sha256 !== row.sha256) {
    throw new SubmissionError('Archive changed on disk since it was submitted');
  }

  const dest = path.join(dataPluginsDir, inspected.pluginId);
  if (fs.existsSync(dest) && !replace) {
    throw new SubmissionError(
      `A plugin named "${inspected.pluginId}" is already installed. Resubmit with replace, or remove it first.`,
      409
    );
  }

  const tmp = path.join(inboxDir, 'extract-' + crypto.randomBytes(8).toString('hex'));
  try {
    await extractZip(archivePath, tmp, inspected);
    const tree = hashTree(tmp);
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    ensureDir(dataPluginsDir);
    try {
      fs.renameSync(tmp, dest);
    } catch {
      fs.cpSync(tmp, dest, { recursive: true });
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    allowlist.pin(db, {
      pluginId: inspected.pluginId,
      sha256: tree,
      source: 'upload',
      submissionId: row.id,
      approvedBy,
    });
    db.prepare(`
      UPDATE plugin_submissions
      SET status = 'approved', tree_sha256 = ?, decided_by = ?, decided_at = strftime('%s','now')
      WHERE id = ?
    `).run(tree, approvedBy, row.id);
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
    throw e;
  }

  const out = publicRow(db.prepare('SELECT * FROM plugin_submissions WHERE id = ?').get(id));
  fire('plugin.approved', {
    submission_id: out.id,
    plugin_id: out.plugin_id,
    name: out.name,
    version: out.version,
    sha256: out.tree_sha256,
    approved_by: out.decided_by,
  });
  return out;
}

function reject(db, { id, decidedBy, note, inboxDir }) {
  const row = db.prepare('SELECT * FROM plugin_submissions WHERE id = ?').get(id);
  if (!row) throw new SubmissionError('Submission not found', 404);
  if (row.status !== 'pending') throw new SubmissionError('This submission is no longer pending', 409);
  const archivePath = path.join(inboxDir, row.archive_name);
  try { fs.unlinkSync(archivePath); } catch { /* gone is the goal */ }
  db.prepare(`
    UPDATE plugin_submissions
    SET status = 'rejected', decided_by = ?, decided_at = strftime('%s','now'), decision_note = ?
    WHERE id = ?
  `).run(decidedBy, (note && String(note).slice(0, 500)) || null, row.id);
  const out = publicRow(db.prepare('SELECT * FROM plugin_submissions WHERE id = ?').get(id));
  fire('plugin.rejected', {
    submission_id: out.id,
    plugin_id: out.plugin_id,
    decided_by: out.decided_by,
  });
  return out;
}

async function readFile(db, { id, rel, inboxDir }) {
  const row = db.prepare('SELECT * FROM plugin_submissions WHERE id = ?').get(id);
  if (!row) throw new SubmissionError('Submission not found', 404);
  const files = JSON.parse(row.files_json || '[]');
  if (!files.some((f) => f.name === rel)) throw new SubmissionError('File is not in this submission', 404);
  const archivePath = path.join(inboxDir, row.archive_name);
  const inspected = await inspectZip(archivePath);
  const unzipper = require('unzipper');
  const directory = await unzipper.Open.file(archivePath);
  const wrapper = inspected.wrapper;
  for (const e of (directory.files || [])) {
    if (e.type === 'Directory') continue;
    const { normalizeEntryPath } = require('./inbox');
    const raw = normalizeEntryPath(e.path);
    if (!raw) continue;
    const name = wrapper ? (raw.startsWith(wrapper + '/') ? raw.slice(wrapper.length + 1) : raw) : raw;
    if (name !== rel) continue;
    const buf = await e.buffer();
    return buf.slice(0, 64 * 1024);
  }
  throw new SubmissionError('File is not in this submission', 404);
}

module.exports = { SubmissionError, create, get, list, approve, reject, readFile, publicRow };
