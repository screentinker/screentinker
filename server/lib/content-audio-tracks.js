'use strict';

/*
 * Visitor audio sync: per-content multilingual narration tracks.
 *
 * A video can carry one audio track per language, each with an optional WebVTT caption. A visitor's
 * phone picks a language and plays that track in sync with the video on the display (the sync itself
 * comes from the existing viewer-poll clock, server/routes/view.js). This extends the single-subtitle
 * pattern (#216) from one column to a LIST, since subtitle_url/subtitle_lang are single-valued.
 *
 * Files live in config.contentDir with uuid names and are served at /uploads/content/<key>, exactly
 * like #216 subtitles. "who else points at these bytes is one question with one answer" (content-files.js),
 * so the unlink refcount for track files lives here, the only place that writes them.
 *
 * v1 is local-first: unlike content_locations kind='subtitle', these are not yet cloud-replicated,
 * because SQLite cannot ALTER the content_locations.kind CHECK to add an 'audio' kind. On a workspace
 * backed by object storage the tracks stay on local disk; a follow-up can add replication.
 */

const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const config = require('../config');

const PUBLIC_BASE = '/uploads/content/';

function urlFor(key) { return key ? PUBLIC_BASE + path.basename(String(key)) : null; }

// The table is created by the boot migrations, but a partial schema (a restore in progress, a test
// DB built from schema.sql alone) must still read as "no tracks" rather than throw. Mirrors
// storage/locations.js hasLocTable.
let tableKnown = null;
function hasTable() {
  if (tableKnown === true) return true;
  try { tableKnown = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'content_audio_tracks'").get(); }
  catch (_) { tableKnown = false; }
  return tableKnown;
}

// A uuid-named track file is unlinked only when no OTHER track row still names it (audio or caption).
function unlinkKeyIfUnreferenced(key, keepTrackId) {
  if (!key) return;
  const base = path.basename(String(key));
  const row = db.prepare(
    'SELECT COUNT(*) AS n FROM content_audio_tracks WHERE id != ? AND (audio_key = ? OR caption_key = ?)',
  ).get(keepTrackId || '', base, base);
  if (row && row.n > 0) return;
  const p = path.join(config.contentDir, base);
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) { /* best effort */ }
}

function listTracks(contentId) {
  if (!hasTable()) return [];
  return db.prepare(
    'SELECT * FROM content_audio_tracks WHERE content_id = ? ORDER BY is_default DESC, sort_order, lang',
  ).all(contentId);
}

// Viewer-facing shape: public URLs only, never internal keys. Used by the view-poll enrichment and
// the listen page, so a visitor can discover the languages offered for whatever is on the screen.
function tracksForViewer(contentId) {
  return listTracks(contentId).map((t) => ({
    lang: t.lang,
    label: t.label || null,
    audio_url: urlFor(t.audio_key),
    caption_url: urlFor(t.caption_key),
    is_default: t.is_default ? 1 : 0,
  }));
}

/*
 * Add or replace the track for one language. audioKey is required on create; on replace either file
 * may be omitted to keep the existing one. The first track for a content item becomes the default;
 * marking one default clears the others. captionKey === null clears a caption; undefined keeps it.
 */
function upsertTrack(contentId, { lang, label, audioKey, captionKey, isDefault, sortOrder }) {
  const existing = db.prepare('SELECT * FROM content_audio_tracks WHERE content_id = ? AND lang = ?').get(contentId, lang);
  const now = Math.floor(Date.now() / 1000);
  const run = db.transaction(() => {
    const count = db.prepare('SELECT COUNT(*) AS n FROM content_audio_tracks WHERE content_id = ?').get(contentId).n;
    const makeDefault = !!isDefault || (!existing && count === 0);
    if (makeDefault) db.prepare('UPDATE content_audio_tracks SET is_default = 0 WHERE content_id = ?').run(contentId);
    if (existing) {
      const newAudio = audioKey || existing.audio_key;
      const newCaption = captionKey !== undefined ? captionKey : existing.caption_key;
      db.prepare(`UPDATE content_audio_tracks
          SET label = ?, audio_key = ?, caption_key = ?, is_default = ?, sort_order = ?, updated_at = ?
          WHERE id = ?`).run(
        label !== undefined ? label : existing.label,
        newAudio, newCaption,
        makeDefault ? 1 : existing.is_default,
        sortOrder !== undefined ? sortOrder : existing.sort_order,
        now, existing.id);
      if (audioKey && audioKey !== existing.audio_key) unlinkKeyIfUnreferenced(existing.audio_key, existing.id);
      if (captionKey !== undefined && captionKey !== existing.caption_key) unlinkKeyIfUnreferenced(existing.caption_key, existing.id);
      return existing.id;
    }
    const id = uuidv4();
    db.prepare(`INSERT INTO content_audio_tracks
        (id, content_id, lang, label, audio_key, caption_key, is_default, sort_order, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      id, contentId, lang, label || null, audioKey, captionKey || null,
      makeDefault ? 1 : 0, sortOrder || 0, now, now);
    return id;
  });
  return run();
}

function removeTrack(contentId, lang) {
  if (!hasTable()) return false;
  const t = db.prepare('SELECT * FROM content_audio_tracks WHERE content_id = ? AND lang = ?').get(contentId, lang);
  if (!t) return false;
  db.prepare('DELETE FROM content_audio_tracks WHERE id = ?').run(t.id);
  unlinkKeyIfUnreferenced(t.audio_key, t.id);
  unlinkKeyIfUnreferenced(t.caption_key, t.id);
  return true;
}

// Called from purgeContentRow when a content item is deleted: drop its tracks and unlink their files.
function removeAllForContent(contentId) {
  if (!hasTable()) return 0;
  const rows = db.prepare('SELECT * FROM content_audio_tracks WHERE content_id = ?').all(contentId);
  if (!rows.length) return 0;
  db.prepare('DELETE FROM content_audio_tracks WHERE content_id = ?').run(contentId);
  for (const t of rows) {
    unlinkKeyIfUnreferenced(t.audio_key, t.id);
    unlinkKeyIfUnreferenced(t.caption_key, t.id);
  }
  return rows.length;
}

module.exports = { listTracks, tracksForViewer, upsertTrack, removeTrack, removeAllForContent, urlFor };
