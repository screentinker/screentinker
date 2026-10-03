'use strict';

/*
 * Version history: one revision model for every authored resource.
 *
 * A revision is an immutable JSON snapshot of a resource's authored state at a meaningful save
 * (a Save button, a publish, a replacement upload, an import, a restore), with who did it and
 * how. Five resource types share the table and the API; what differs per type is only how its
 * state is captured, how two states are compared, and how a state is written back into the
 * resource's DRAFT.
 *
 * ⚠️ RESTORE NEVER TOUCHES THE LIVE VERSION. Restoring writes the old state into the draft
 * working copy (playlist_items, a deck's doc, or the draft_* column on widgets, layouts and
 * content) and records a NEW revision attributed to the restoring user. Publishing that draft
 * follows whatever the workspace's release policy is (lib/release-policy.js). History is
 * append-only: nothing here updates or deletes a revision's state.
 *
 * ⚠️ MEDIA BYTES ARE RETAINED, NOT REFERENCED. A content revision's file_ref points at a copy of
 * the bytes as they were, under <contentDir>/.history/. Restoring the metadata of a file whose
 * bytes were overwritten would not be a restore, so the replace path moves the old file there
 * before the new one takes its place, and lib/revision-retention.js prunes only what no
 * retained revision, live row, or pending submission still names.
 *
 * ⚠️ SECRETS. Widget configs can carry keys and tokens. redactState() masks any field whose
 * name looks like one before a state leaves the server, in listings, diffs and previews alike;
 * the stored state is complete so a restore is exact.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const RESOURCE_TYPES = ['content', 'playlist', 'layout', 'slide_deck', 'widget'];
const TABLE = { content: 'content', playlist: 'playlists', layout: 'layouts', slide_deck: 'slide_decks', widget: 'widgets' };
const HISTORY_DIR = '.history';
const SECRET_KEY_RE = /(api[_-]?key|secret|token|password|passwd|credential|auth)/i;

function nowSec() { return Math.floor(Date.now() / 1000); }
function uuid() { return crypto.randomUUID(); }

// Deterministic serialisation so identical states hash identically regardless of key order.
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}
function hashState(state) { return crypto.createHash('sha256').update(stable(state)).digest('hex'); }

function parseJson(text, fallback) {
  if (text == null) return fallback;
  if (typeof text !== 'string') return text;
  try { return JSON.parse(text); } catch (_) { return fallback; }
}

// ─── capture: the authored state of a resource as it is right now ────────────────────────────
// Only authored fields: never timestamps, never live external data (a weather widget's config,
// not its forecast), never player-facing derived rows like published_snapshot.

function scheduleBlocksFor(db, itemId) {
  try {
    return db.prepare('SELECT * FROM playlist_item_schedules WHERE playlist_item_id = ? ORDER BY id').all(itemId)
      .map((r) => { const o = { ...r }; delete o.id; delete o.playlist_item_id; return o; });
  } catch (_) { return []; }
}

function capturePlaylist(db, row) {
  const items = db.prepare(`SELECT id, content_id, widget_id, child_playlist_id, zone_id, sort_order, duration_sec, muted, play_from, play_until, enabled, log_play, fit_mode, play_when, weight
                              FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order ASC, id ASC`).all(row.id)
    .map((it) => ({
      content_id: it.content_id || null, widget_id: it.widget_id || null, child_playlist_id: it.child_playlist_id || null,
      zone_id: it.zone_id || null, sort_order: it.sort_order, duration_sec: it.duration_sec, muted: it.muted ? 1 : 0,
      play_from: it.play_from || null, play_until: it.play_until || null,
      enabled: it.enabled === 0 ? 0 : 1, log_play: it.log_play === 0 ? 0 : 1,
      fit_mode: it.fit_mode || null, play_when: it.play_when || null, weight: it.weight || 1,
      schedules: scheduleBlocksFor(db, it.id),
    }));
  return { name: row.name, description: row.description || '', playback_order: row.playback_order || 'sequential', items };
}

function captureLayout(db, row) {
  const draft = parseJson(row.draft_zones, null);
  if (draft && Array.isArray(draft.zones)) {
    return { name: draft.name ?? row.name, width: draft.width ?? row.width, height: draft.height ?? row.height, zones: draft.zones.map(zoneState) };
  }
  const zones = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order, id').all(row.id).map(zoneState);
  return { name: row.name, width: row.width, height: row.height, zones };
}
function zoneState(z) {
  return {
    id: z.id, name: z.name, x_percent: z.x_percent, y_percent: z.y_percent, width_percent: z.width_percent,
    height_percent: z.height_percent, z_index: z.z_index || 0, zone_type: z.zone_type || 'content',
    fit_mode: z.fit_mode || 'contain', background_color: z.background_color || '#000000', sort_order: z.sort_order || 0,
  };
}

function captureWidget(db, row) {
  const draft = parseJson(row.draft_config, null);
  if (draft && typeof draft === 'object' && draft.config) return { name: draft.name ?? row.name, widget_type: row.widget_type, config: draft.config };
  return { name: row.name, widget_type: row.widget_type, config: parseJson(row.config, {}) };
}

function captureDeck(db, row) {
  return { name: row.name, doc: parseJson(row.doc, { slides: [] }) };
}

const CONTENT_FIELDS = ['filename', 'mime_type', 'file_size', 'duration_sec', 'width', 'height', 'remote_url', 'subtitle_url',
  'subtitle_lang', 'expires_at', 'folder_id', 'bundle_entry', 'byte_digest', 'captions_enabled', 'captions_lang', 'unstable_connection', 'tags', 'meta'];
/*
 * The fields a content DRAFT can carry and a release applies, in one place so that what a restore
 * writes into the draft and what publishing the draft copies to the live row cannot drift apart
 * (they did: remote_url was captured, restored into the draft, and then ignored on release, so a
 * "successful" restore left the new URL playing). Everything captured except folder_id, which
 * organises the library rather than describing the item.
 */
const CONTENT_DRAFT_FIELDS = CONTENT_FIELDS.filter((k) => k !== 'folder_id');
/* Of those, the ones that change what a screen shows. Under approval, edits to these are drafts. */
const CONTENT_PLAYBACK_FIELDS = ['remote_url', 'mime_type', 'subtitle_url', 'subtitle_lang', 'captions_enabled', 'captions_lang', 'unstable_connection'];
function captureContent(db, row) {
  const draft = parseJson(row.draft_json, null);
  const src = draft ? { ...row, ...draft } : row;
  const state = {};
  for (const k of CONTENT_FIELDS) if (k in src) state[k] = src[k] === undefined ? null : src[k];
  // The bytes are identified by filepath (for the retention copy) and digest (for "did they change").
  state.filepath = src.filepath || null;
  state.thumbnail_path = src.thumbnail_path || null;
  return state;
}

function captureState(db, type, id) {
  const table = TABLE[type];
  if (!table) throw new Error(`unknown resource type: ${type}`);
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) return null;
  const state = { content: captureContent, playlist: capturePlaylist, layout: captureLayout, slide_deck: captureDeck, widget: captureWidget }[type](db, row);
  return { row, state };
}

/** Live (released) state, ignoring any draft. What players are showing. */
function captureLiveState(db, type, id) {
  const table = TABLE[type];
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) return null;
  const live = { ...row, draft_zones: null, draft_config: null, draft_json: null };
  if (type === 'playlist') {
    const snap = parseJson(row.published_structure, null) || parseJson(row.published_snapshot, null);
    if (!snap) return null;
    return { name: row.name, description: row.description || '', items: snap.map((it, i) => ({
      content_id: it.content_id || null, widget_id: it.widget_id || null, child_playlist_id: it.child_playlist_id || null,
      zone_id: it.zone_id || null, sort_order: it.sort_order ?? i, duration_sec: it.duration_sec, muted: it.muted ? 1 : 0, schedules: it.schedules || [],
    })) };
  }
  if (type === 'slide_deck') return null;   // a deck's release is its playlist's snapshot
  return { content: captureContent, layout: captureLayout, widget: captureWidget }[type](db, live);
}

// ─── record ──────────────────────────────────────────────────────────────────────────────────

function latest(db, type, id) {
  return db.prepare('SELECT * FROM revisions WHERE resource_type = ? AND resource_id = ? ORDER BY rev_no DESC LIMIT 1').get(type, id) || null;
}

/**
 * Append a revision. Identical state to the latest revision (same hash, same file) records
 * nothing and returns the existing row: a Save that changed nothing is not a version.
 */
function record(db, { type, id, workspaceId, actor = {}, summary = '', state, fileRef = null, thumbRef = null, submissionId = null, publishedAt = null, publishedBy = null, isBaseline = 0, createdAt = null, force = false }) {
  if (!RESOURCE_TYPES.includes(type)) throw new Error(`unknown resource type: ${type}`);
  if (!state) throw new Error('state required');
  const hash = hashState(state);
  const prev = latest(db, type, id);
  if (!force && prev && prev.state_hash === hash && (prev.file_ref || null) === (fileRef || null) && !publishedAt) return prev;
  const rev = {
    id: uuid(), workspace_id: workspaceId || null, resource_type: type, resource_id: id,
    rev_no: prev ? prev.rev_no + 1 : 1, created_at: createdAt || nowSec(),
    actor_user_id: actor.userId || null, actor_kind: actor.kind || 'user', actor_label: actor.label || null,
    summary: String(summary || '').slice(0, 300), state: JSON.stringify(state), state_hash: hash,
    file_ref: fileRef || null, thumb_ref: thumbRef || null, parent_id: prev ? prev.id : null,
    submission_id: submissionId || null, published_at: publishedAt || null, published_by: publishedBy || null, is_baseline: isBaseline ? 1 : 0,
  };
  db.prepare(`INSERT INTO revisions (id, workspace_id, resource_type, resource_id, rev_no, created_at, actor_user_id, actor_kind, actor_label,
                summary, state, state_hash, file_ref, thumb_ref, parent_id, submission_id, published_at, published_by, is_baseline)
              VALUES (@id, @workspace_id, @resource_type, @resource_id, @rev_no, @created_at, @actor_user_id, @actor_kind, @actor_label,
                @summary, @state, @state_hash, @file_ref, @thumb_ref, @parent_id, @submission_id, @published_at, @published_by, @is_baseline)`).run(rev);
  return rev;
}

/**
 * Capture the current state and record it. The common call from a route after a save.
 *
 * A database without the revisions table (a hand-built fixture, or a server whose migration has
 * not run) must not turn every save into a 500: history is bookkeeping beside the save, not a
 * precondition of it. That one error is warned once and skipped; anything else still throws.
 */
let warnedNoTable = false;
function recordCurrent(db, type, id, { actor, summary, submissionId, publishedAt, publishedBy, force } = {}) {
  const cap = captureState(db, type, id);
  if (!cap) return null;
  const fileRef = type === 'content' ? (cap.state.filepath || null) : null;
  const thumbRef = type === 'content' ? (cap.state.thumbnail_path || null) : null;
  try {
    return record(db, { type, id, workspaceId: cap.row.workspace_id || null, actor, summary, state: cap.state, fileRef, thumbRef, submissionId, publishedAt, publishedBy, force });
  } catch (e) {
    if (!/no such table: revisions/.test(String(e && e.message))) throw e;
    if (!warnedNoTable) { warnedNoTable = true; console.warn('[revisions] revisions table missing; history not recorded (migration pending?)'); }
    return null;
  }
}

/** Mark the revision that matches the live state as published (or record one if none does). */
function markPublished(db, type, id, { actor, summary = 'Published', submissionId = null } = {}) {
  const cap = captureState(db, type, id);
  if (!cap) return null;
  const hash = hashState(cap.state);
  const now = nowSec();
  const match = db.prepare('SELECT * FROM revisions WHERE resource_type = ? AND resource_id = ? AND state_hash = ? ORDER BY rev_no DESC LIMIT 1').get(type, id, hash);
  if (match) {
    db.prepare('UPDATE revisions SET published_at = ?, published_by = ?, submission_id = COALESCE(submission_id, ?) WHERE id = ?')
      .run(now, actor && actor.userId || null, submissionId, match.id);
    return { ...match, published_at: now };
  }
  return recordCurrent(db, type, id, { actor, summary, submissionId, publishedAt: now, publishedBy: actor && actor.userId || null, force: true });
}

// ─── baseline ────────────────────────────────────────────────────────────────────────────────

function baselineAll(db) {
  let n = 0;
  for (const type of RESOURCE_TYPES) {
    const table = TABLE[type];
    let rows;
    try { rows = db.prepare(`SELECT * FROM ${table}`).all(); } catch (_) { continue; }
    for (const row of rows) {
      if (latest(db, type, row.id)) continue;
      let state;
      try { state = captureState(db, type, row.id).state; } catch (_) { continue; }
      const publishedAt = type === 'playlist' && row.status === 'published' && row.published_snapshot ? (row.updated_at || row.created_at || null) : null;
      record(db, {
        type, id: row.id, workspaceId: row.workspace_id || null,
        actor: { userId: null, kind: 'baseline', label: null },
        summary: 'Baseline: state at upgrade',
        state, fileRef: type === 'content' ? (row.filepath || null) : null, thumbRef: type === 'content' ? (row.thumbnail_path || null) : null,
        publishedAt, isBaseline: 1, createdAt: row.updated_at || row.created_at || nowSec(),
      });
      n++;
    }
  }
  return n;
}

/** First revision for every resource in a workspace that has none yet (imports). */
function recordMissingIn(db, workspaceId, actor, summary) {
  let n = 0;
  for (const type of RESOURCE_TYPES) {
    const rows = db.prepare(`SELECT id FROM ${TABLE[type]} WHERE workspace_id = ? AND id NOT IN (SELECT resource_id FROM revisions WHERE resource_type = ?)`).all(workspaceId, type);
    for (const r of rows) { if (recordCurrent(db, type, r.id, { actor, summary })) n++; }
  }
  return n;
}

// ─── media retention ─────────────────────────────────────────────────────────────────────────

function historyDir() { return path.join(config.contentDir, HISTORY_DIR); }

/**
 * Keep the bytes a content row is about to stop pointing at. Returns the retained path
 * (relative to the content dir) or null when there was nothing to keep. Moves when this row
 * is the only reference; copies when another row still serves the same file.
 */
function retainContentFile(db, contentId, relPath, tag) {
  if (!relPath) return null;
  const src = path.join(config.contentDir, path.basename(String(relPath)));
  if (!fs.existsSync(src)) return null;
  const dir = path.join(historyDir(), contentId);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${tag}__${path.basename(src)}`);
  const rel = path.join(HISTORY_DIR, contentId, path.basename(dest));
  if (fs.existsSync(dest)) return rel;
  const others = db.prepare('SELECT COUNT(*) AS n FROM content WHERE (filepath = ? OR thumbnail_path = ?) AND id != ?').get(relPath, relPath, contentId).n;
  if (others > 0) fs.copyFileSync(src, dest); else fs.renameSync(src, dest);
  return rel;
}

/**
 * Drop a superseded content draft's files WITHOUT breaking history. A pending file that some
 * revision still points at (the "Restored from #n" revision of a restore, the "Replaced file
 * (draft)" revision of a replace) moves into .history and the revisions follow it; a file nothing
 * describes is deleted; the live row's own files are never touched. Discarding a draft used to
 * unlink blindly, and the next restore of that revision answered 409 "no longer retained".
 */
function disposeDraftFiles(db, contentId, draft, live) {
  if (!draft) return;
  for (const [key, refCol] of [['filepath', 'file_ref'], ['thumbnail_path', 'thumb_ref']]) {
    const p = draft[key];
    if (!p) continue;
    if (live && (p === live.filepath || p === live.thumbnail_path)) continue;
    if (String(p).replace(/\\/g, '/').startsWith(HISTORY_DIR + '/')) continue;
    const referenced = db.prepare(`SELECT COUNT(*) AS n FROM revisions WHERE ${refCol} = ?`).get(p).n
      + db.prepare('SELECT COUNT(*) AS n FROM content WHERE (filepath = ? OR thumbnail_path = ?) AND id != ?').get(p, p, contentId).n;
    if (referenced) {
      const rel = retainContentFile(db, contentId, p, 'draft');
      if (rel) db.prepare(`UPDATE revisions SET ${refCol} = ? WHERE ${refCol} = ?`).run(rel, p);
    } else {
      try { fs.unlinkSync(path.join(config.contentDir, path.basename(String(p)))); } catch (_) { /* already gone */ }
    }
  }
}

/** Absolute path for a revision's retained file, or the live file when the ref IS the live one. */
function resolveFileRef(ref) {
  if (!ref) return null;
  const clean = String(ref).replace(/\\/g, '/');
  const abs = clean.startsWith(HISTORY_DIR + '/')
    ? path.join(historyDir(), clean.slice(HISTORY_DIR.length + 1).split('/').map((s) => path.basename(s)).join(path.sep))
    : path.join(config.contentDir, path.basename(clean));
  const base = path.resolve(config.contentDir);
  if (!path.resolve(abs).startsWith(base + path.sep)) return null;
  return fs.existsSync(abs) ? abs : null;
}

// ─── redaction ───────────────────────────────────────────────────────────────────────────────

function redact(value, key) {
  if (key && SECRET_KEY_RE.test(key) && typeof value === 'string' && value) return '***';
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k);
    return out;
  }
  return value;
}
function redactState(state) { return redact(state); }

// ─── diff ────────────────────────────────────────────────────────────────────────────────────

function fieldDiff(a, b, skip = new Set()) {
  const changed = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    if (skip.has(k)) continue;
    if (stable(a ? a[k] : undefined) !== stable(b ? b[k] : undefined)) changed.push({ field: k, from: redact(a ? a[k] : null, k), to: redact(b ? b[k] : null, k) });
  }
  return changed;
}

function listDiff(as, bs, keyOf, label) {
  const ka = as.map(keyOf), kb = bs.map(keyOf);
  const setA = new Set(ka), setB = new Set(kb);
  const added = bs.filter((x, i) => !setA.has(kb[i])).map(label);
  const removed = as.filter((x, i) => !setB.has(ka[i])).map(label);
  const common = ka.filter((k) => setB.has(k));
  const orderA = common, orderB = kb.filter((k) => setA.has(k));
  const reordered = orderA.join('|') !== orderB.join('|');
  const changed = [];
  for (const k of common) {
    const x = as[ka.indexOf(k)], y = bs[kb.indexOf(k)];
    const d = fieldDiff(x, y);
    if (d.length) changed.push({ item: label(y), changes: d });
  }
  return { added, removed, reordered, changed };
}

function diffStates(type, a, b) {
  a = a || {}; b = b || {};
  if (type === 'playlist') {
    const key = (it) => `${it.content_id || ''}|${it.widget_id || ''}|${it.child_playlist_id || ''}|${it.zone_id || ''}`;
    const label = (it) => ({ content_id: it.content_id, widget_id: it.widget_id, child_playlist_id: it.child_playlist_id, zone_id: it.zone_id, duration_sec: it.duration_sec });
    return { fields: fieldDiff(a, b, new Set(['items'])), items: listDiff(a.items || [], b.items || [], key, label) };
  }
  if (type === 'layout') {
    return { fields: fieldDiff(a, b, new Set(['zones'])), zones: listDiff(a.zones || [], b.zones || [], (z) => z.id, (z) => ({ id: z.id, name: z.name })) };
  }
  if (type === 'slide_deck') {
    const sa = (a.doc && a.doc.slides) || [], sb = (b.doc && b.doc.slides) || [];
    const docA = { ...(a.doc || {}) }, docB = { ...(b.doc || {}) }; delete docA.slides; delete docB.slides;
    return { fields: [...fieldDiff({ name: a.name }, { name: b.name }), ...fieldDiff(docA, docB)], slides: listDiff(sa, sb, (s) => s.id, (s) => ({ id: s.id, name: s.name })) };
  }
  if (type === 'widget') return { fields: [...fieldDiff({ name: a.name }, { name: b.name }), ...fieldDiff(a.config || {}, b.config || {}).map((d) => ({ ...d, field: 'config.' + d.field }))] };
  return { fields: fieldDiff(a, b) };
}

// ─── restore: write an old state into the DRAFT and record it ────────────────────────────────

function restoreToDraft(db, { type, id, revisionId, actor }) {
  const rev = db.prepare('SELECT * FROM revisions WHERE id = ? AND resource_type = ? AND resource_id = ?').get(revisionId, type, id);
  if (!rev) { const e = new Error('Revision not found'); e.status = 404; throw e; }
  const state = parseJson(rev.state, null);
  if (!state) { const e = new Error('Revision state is unreadable'); e.status = 500; throw e; }
  const table = TABLE[type];
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) { const e = new Error('Resource not found'); e.status = 404; throw e; }
  const now = nowSec();

  if (type === 'content') {
    // The bytes must still exist, or this is a rename pretending to be a restore.
    const abs = rev.file_ref ? resolveFileRef(rev.file_ref) : null;
    if (rev.file_ref && !abs) { const e = new Error('The media for this revision is no longer retained, so it cannot be restored'); e.status = 409; throw e; }
    let pendingPath = null;
    if (abs) {
      const ext = path.extname(abs);
      pendingPath = `restore-${rev.rev_no}-${crypto.randomBytes(6).toString('hex')}${ext}`;
      fs.copyFileSync(abs, path.join(config.contentDir, pendingPath));
    }
    let thumbPath = null;
    const thumbAbs = rev.thumb_ref ? resolveFileRef(rev.thumb_ref) : null;
    if (thumbAbs) {
      thumbPath = `thumb_restore-${rev.rev_no}-${crypto.randomBytes(6).toString('hex')}${path.extname(thumbAbs)}`;
      fs.copyFileSync(thumbAbs, path.join(config.contentDir, thumbPath));
    }
    // A draft that was already pending (an earlier restore, a replaced file) is superseded: its
    // bytes are retained if any revision still describes them, otherwise removed.
    disposeDraftFiles(db, id, parseJson(row.draft_json, null), row);
    const { folder_id: _folder, ...fields } = state;
    const draft = {
      ...fields,
      filepath: pendingPath || state.filepath || row.filepath,
      // No retained thumbnail: keep the live one when the bytes are unchanged (a URL restore), drop it when they are not.
      thumbnail_path: thumbPath || (pendingPath ? null : row.thumbnail_path),
      restored_from: rev.id,
    };
    db.prepare('UPDATE content SET draft_json = ? WHERE id = ?').run(JSON.stringify(draft), id);
  } else if (type === 'playlist') {
    const txn = db.transaction(() => {
      db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(id);
      const ins = db.prepare('INSERT INTO playlist_items (playlist_id, content_id, widget_id, child_playlist_id, zone_id, sort_order, duration_sec, muted, play_from, play_until, enabled, log_play, fit_mode, play_when, weight) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const it of state.items || []) {
        try {
          const r = ins.run(id, it.content_id || null, it.widget_id || null, it.child_playlist_id || null, it.zone_id || null, it.sort_order, it.duration_sec, it.muted ? 1 : 0, it.play_from || null, it.play_until || null, it.enabled === 0 ? 0 : 1, it.log_play === 0 ? 0 : 1, it.fit_mode || null, it.play_when || null, it.weight || 1);
          for (const b of it.schedules || []) {
            const cols = Object.keys(b);
            if (!cols.length) continue;
            try {
              db.prepare(`INSERT INTO playlist_item_schedules (playlist_item_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`)
                .run(r.lastInsertRowid, ...cols.map((c) => b[c]));
            } catch (_) { /* a block whose shape no longer matches is dropped, the item is kept */ }
          }
        } catch (e) {
          if (!/FOREIGN KEY/i.test(e.message)) throw e;   // a referenced asset was deleted: skip the item
        }
      }
      db.prepare("UPDATE playlists SET name = ?, description = ?, playback_order = ?, status = 'draft', updated_at = ? WHERE id = ?")
        .run(state.name || row.name, state.description || '', state.playback_order || row.playback_order || 'sequential', now, id);
    });
    txn();
  } else if (type === 'layout') {
    db.prepare('UPDATE layouts SET draft_zones = ? WHERE id = ?').run(JSON.stringify({ name: state.name, width: state.width, height: state.height, zones: state.zones || [] }), id);
  } else if (type === 'slide_deck') {
    db.prepare('UPDATE slide_decks SET name = ?, doc = ?, updated_at = ? WHERE id = ?').run(state.name || row.name, JSON.stringify(state.doc || { slides: [] }), now, id);
  } else if (type === 'widget') {
    db.prepare('UPDATE widgets SET draft_config = ? WHERE id = ?').run(JSON.stringify({ name: state.name, config: state.config || {} }), id);
  }

  const created = recordCurrent(db, type, id, { actor: { ...actor, kind: actor && actor.kind || 'restore' }, summary: `Restored from revision #${rev.rev_no}`, force: true });
  return { revision: created, restoredFrom: rev };
}

/** Does this resource have a draft that is not what players see? */
function hasDraft(db, type, id) {
  const table = TABLE[type];
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) return false;
  if (type === 'playlist') return row.status === 'draft';
  if (type === 'slide_deck') return true;   // the doc is always the draft; its release is the playlist
  if (type === 'widget') return !!row.draft_config;
  if (type === 'layout') return !!row.draft_zones;
  if (type === 'content') return !!row.draft_json;
  return false;
}

function list(db, type, id) {
  return db.prepare(`SELECT r.*, u.email AS actor_email, u.name AS actor_name
                       FROM revisions r LEFT JOIN users u ON u.id = r.actor_user_id
                      WHERE r.resource_type = ? AND r.resource_id = ? ORDER BY r.rev_no DESC`).all(type, id);
}

function get(db, revisionId) {
  return db.prepare('SELECT * FROM revisions WHERE id = ?').get(revisionId) || null;
}

function lastPublished(db, type, id) {
  return db.prepare('SELECT * FROM revisions WHERE resource_type = ? AND resource_id = ? AND published_at IS NOT NULL ORDER BY published_at DESC, rev_no DESC LIMIT 1').get(type, id) || null;
}

module.exports = { CONTENT_DRAFT_FIELDS, CONTENT_PLAYBACK_FIELDS, disposeDraftFiles,
  RESOURCE_TYPES, TABLE, HISTORY_DIR,
  captureState, captureLiveState, hashState, stable, record, recordCurrent, recordMissingIn, markPublished, baselineAll,
  retainContentFile, resolveFileRef, historyDir, redactState, diffStates, restoreToDraft, hasDraft, list, get, latest, lastPublished, parseJson,
};
