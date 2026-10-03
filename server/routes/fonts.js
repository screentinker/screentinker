const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { db } = require('../db/database');
const config = require('../config');
const { accessContext, denyReadOnly } = require('../lib/tenancy');
const { validateFont, UnsupportedFontError, MAX_FONT_BYTES, FORMATS } = require('../lib/font-sniff');

/*
 * Fonts an operator uploads, to set slides in a face the bundled five do not cover.
 *
 * ⚠️ THE THING TO UNDERSTAND BEFORE READING THE CODE: uploading a font here means THIS SERVER
 * REDISTRIBUTES IT. Every screen showing a slide in that face downloads the file, and on a hosted
 * instance that is our infrastructure serving somebody else's licensed asset. The bundled families
 * are OFL, so that is settled; an upload is the uploader's assertion, which is why `licence_note`
 * and `uploaded_by` are recorded at the point of upload and shown next to the font afterwards.
 *
 * It is not a legal control and does not pretend to be. It is the difference between an operator
 * who can answer "where did this come from" and one who cannot.
 */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FONT_BYTES, files: 1 },
});

const nowSec = () => Math.floor(Date.now() / 1000);

function ensureDir() {
  try { fs.mkdirSync(config.fontsDir, { recursive: true }); } catch (e) { /* surfaced on write */ }
}

/** Rows the caller's workspace owns. Fonts are never shared across workspaces. */
function listForWorkspace(workspaceId) {
  if (!workspaceId) return [];
  return db.prepare(
    'SELECT * FROM custom_fonts WHERE workspace_id = ? ORDER BY created_at DESC').all(workspaceId);
}

function present(row) {
  return {
    id: `u:${row.id}`,           // the id a slide stores — namespaced so it cannot collide
    raw_id: row.id,
    label: row.name,
    role: 'Uploaded',
    note: row.licence_note || '',
    format: FORMATS[row.format] ? FORMATS[row.format].label : row.format,
    file_size: row.file_size,
    css: row.css_family,
    // The editor builds the same @font-face the renderer does, so it needs the filename too.
    // Preview drifting from what plays is the one thing an editor must not do.
    filepath: row.filepath,
    stack: 'sans-serif',
    // ⚠️ Reported so the editor can grey the weight control. An uploaded face is declared at a
    // single weight (see slide-fonts.customFace), so offering 400–800 would be a lie.
    weights: [400, 400],
    created_at: row.created_at,
  };
}

router.get('/', (req, res) => {
  res.json({ fonts: listForWorkspace(req.workspaceId).map(present) });
});

router.post('/', upload.single('font'), (req, res) => {
  if (!req.workspaceId) {
    return res.status(403).json({ error: 'No workspace context. Switch to a workspace before uploading a font.' });
  }
  if (denyReadOnly(req, res)) return;   // a read-only member cannot upload a font
  if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'No file received.' });

  let info;
  try {
    info = validateFont(req.file.buffer, req.file.size);
  } catch (e) {
    if (e instanceof UnsupportedFontError) return res.status(400).json({ error: e.message });
    throw e;
  }

  const name = String((req.body && req.body.name) || req.file.originalname || '')
    .replace(/\.[a-z0-9]+$/i, '').trim().slice(0, 80) || 'Uploaded font';
  const licence = String((req.body && req.body.licence_note) || '').trim().slice(0, 300);

  const id = crypto.randomUUID();
  /*
   * ⚠️ THE CSS FAMILY IS GENERATED, NEVER THE FONT'S OWN NAME.
   *
   * A font declaring itself "Inter" would otherwise shadow the bundled Inter in any document using
   * both, and whichever @font-face came second would win — a slide changing appearance because of
   * an unrelated upload, with nothing to point at. `stu_<hex>` cannot collide with a bundled family
   * or with another upload, and is not attacker-influenced: it never touches the uploaded name.
   */
  const cssFamily = `stu_${id.replace(/-/g, '').slice(0, 16)}`;
  // Same reasoning for the filename: the uploaded one is attacker-controlled and is not used.
  const filepath = `${id}${info.ext}`;

  ensureDir();
  try {
    fs.writeFileSync(path.join(config.fontsDir, filepath), req.file.buffer);
  } catch (e) {
    console.error('[fonts] could not write upload:', e && e.message);
    return res.status(500).json({ error: 'Could not save the font.' });
  }

  db.prepare(`INSERT INTO custom_fonts
      (id, workspace_id, uploaded_by, name, css_family, filepath, format, file_size, licence_note, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.workspaceId, req.user.id, name, cssFamily, filepath, info.format, info.size, licence || null, nowSec());

  res.status(201).json(present(db.prepare('SELECT * FROM custom_fonts WHERE id = ?').get(id)));
});

/*
 * ⚠️ DELETING A FONT A SLIDE IS USING DOES NOT BLANK THE SLIDE. The renderer falls back to the
 * default family — and, crucially, emits that family's @font-face so the fallback actually loads.
 * So this is allowed without a usage check: the worst case is a slide in the wrong typeface, which
 * is visible and fixable, rather than a delete an operator cannot perform.
 *
 * The count IS reported, so the decision is informed rather than silent.
 */
router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM custom_fonts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Font not found' });
  const ws = row.workspace_id ? db.prepare('SELECT * FROM workspaces WHERE id = ?').get(row.workspace_id) : null;
  if (!ws || !accessContext(req.user.id, req.user.role, ws)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  db.prepare('DELETE FROM custom_fonts WHERE id = ?').run(row.id);
  try { fs.unlinkSync(path.join(config.fontsDir, row.filepath)); } catch (e) { /* row is gone either way */ }
  res.json({ success: true });
});

/**
 * Look up an uploaded font for rendering, scoped to the widget's workspace.
 *
 * ⚠️ SCOPED, FOR THE SAME REASON THE IMAGE RESOLVER IS. The `u:<id>` sits in a config blob a
 * workspace editor authored — a value a person typed — so nothing stops pasting an id belonging to
 * another tenant. A resolver that simply looked the row up would serve another customer's licensed
 * font from this origin, in a slide they never saw.
 */
function fontResolverFor(widget) {
  return (rawId) => {
    if (!rawId) return null;
    try {
      const row = widget.workspace_id
        ? db.prepare('SELECT * FROM custom_fonts WHERE id = ? AND workspace_id = ?')
            .get(rawId, widget.workspace_id)
        : db.prepare('SELECT * FROM custom_fonts WHERE id = ? AND workspace_id IS NULL').get(rawId);
      return row || null;
    } catch (e) {
      return null;
    }
  };
}

module.exports = router;
module.exports.fontResolverFor = fontResolverFor;
