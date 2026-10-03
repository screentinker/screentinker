'use strict';
/*
 * #320: operator-uploaded GLSL transitions.
 *
 * shared/Transitions/ is deliberately a first-party set: every shipped shader was written from
 * scratch and stamped MIT so docs/licensing.md can make a flat claim with no per-effect conditions.
 * A customer's own shader is their content and their licence, exactly as an uploaded font is, so it
 * is stored per workspace here and never enters the shipped library, the manifest, or a release.
 *
 * ⚠️ VALIDATION IS STRUCTURAL, NOT A COMPILE. The only honest way to know GLSL is valid is to link
 * it against a real GL context, which is what shared/Transitions/compile-test.js does with headless
 * Chrome. Putting that on the upload path would make a browser a server dependency, which is the
 * exact thing #322 spent three rounds making optional. We check shape and size instead and let a
 * bad shader fail the way an unknown one already does: the player hard-cuts. A transition that does
 * not play is a much smaller cost than a browser in every install.
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const { db } = require('../db/database');
const { denyReadOnly } = require('../lib/tenancy');
const { parseParams } = require(path.join(__dirname, '../../shared/Transitions/params.js'));
const { MANIFEST } = require('../lib/transition-config');

const MAX_SOURCE_BYTES = 64 * 1024;   // a shader is a couple of KB; this is generous
const MAX_PARAMS = 8;                 // more than this is an unusable picker, not a shader
/*
 * ⚠️ THE CAP IS PER ORGANISATION, NOT PER WORKSPACE.
 *
 * Workspaces are cheap to create, so a per-workspace cap is not a cap: anyone hitting it can make
 * another workspace and carry on. The organisation is the billing and ownership boundary, so it is
 * the boundary the limit belongs on. Isolation stays per workspace — one workspace still cannot see
 * or delete another's shader, even inside the same org.
 */
const MAX_PER_ORG = 50;

const BUILTIN_IDS = new Set(MANIFEST.map((m) => m.id));

// A shader id has to survive being a filename on Android and a JSON key everywhere else.
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;

function slugFor(name) {
  const base = String(name || '').trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  return 'custom-' + (base || crypto.randomBytes(4).toString('hex'));
}

/*
 * The shipped shaders carry their name in the first comment line and a `// blurb:` line, and
 * generate-manifest.js reads exactly that. An uploaded shader is read the same way so the picker
 * shows it identically, rather than inventing a second convention for the same file format.
 */
function headerOf(src) {
  const lines = src.split('\n');
  const titleLine = lines.find((l) => /^\/\/\s*\S/.test(l) && !/^\/\/\s*(blurb|author|license|licence|gl transitions)\b/i.test(l));
  const blurbLine = lines.find((l) => /^\/\/\s*blurb\s*:/i.test(l));
  return {
    name: titleLine ? titleLine.replace(/^\/\/\s*/, '').trim().slice(0, 60) : '',
    blurb: blurbLine ? blurbLine.replace(/^\/\/\s*blurb\s*:\s*/i, '').trim().slice(0, 200) : '',
  };
}

function validate(source) {
  if (typeof source !== 'string' || !source.trim()) return 'The shader is empty.';
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) return `The shader is larger than ${MAX_SOURCE_BYTES / 1024} KB.`;
  // The one structural thing every shader in this engine must have: the entry point the renderer calls.
  if (!/vec4\s+transition\s*\(\s*vec2\s+\w+\s*\)/.test(source)) {
    return 'No `vec4 transition(vec2 uv)` found. That is the function the renderer calls.';
  }
  // Refuse the preprocessor rather than reason about what it might pull in.
  if (/^\s*#\s*include/m.test(source)) return '#include is not supported; a shader must be self-contained.';
  let params;
  try { params = parseParams(source); } catch (e) { return 'The uniform declarations could not be read.'; }
  if (params.length > MAX_PARAMS) return `A shader may declare at most ${MAX_PARAMS} parameters.`;
  return null;
}

router.get('/', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  // `source` is included: the dashboard's transition picker renders a LIVE preview, and it cannot
  // do that without the GLSL. It is the operator's own shader in their own workspace, so there is
  // nothing withheld by omitting it — only a second round trip.
  const rows = db.prepare(
    'SELECT id, shader_id, name, blurb, params, source, licence_note, created_at FROM custom_shaders WHERE workspace_id = ? ORDER BY created_at DESC'
  ).all(req.workspaceId);
  res.json(rows.map((r) => ({ ...r, params: JSON.parse(r.params || '[]') })));
});

router.post('/', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context.' });
  if (denyReadOnly(req, res)) return;
  const { source, name, licence_note } = req.body || {};

  const problem = validate(source);
  if (problem) return res.status(400).json({ error: problem });

  // Count across every workspace in this workspace's organisation. A workspace with no organisation
  // (single-tenant self-host) counts only itself, which is the same number by definition.
  const org = db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(req.workspaceId);
  const count = org && org.organization_id
    ? db.prepare(`SELECT COUNT(*) n FROM custom_shaders cs
                    JOIN workspaces w ON w.id = cs.workspace_id
                   WHERE w.organization_id = ?`).get(org.organization_id).n
    : db.prepare('SELECT COUNT(*) n FROM custom_shaders WHERE workspace_id = ?').get(req.workspaceId).n;
  if (count >= MAX_PER_ORG) {
    return res.status(400).json({ error: `This organisation already has ${MAX_PER_ORG} custom transitions.` });
  }

  const header = headerOf(source);
  const displayName = String(name || header.name || 'Custom transition').trim().slice(0, 60);
  let shaderId = slugFor(displayName);
  if (!SLUG_RE.test(shaderId)) shaderId = 'custom-' + crypto.randomBytes(4).toString('hex');
  // A custom id can never shadow a shipped one: the prefix guarantees it, and this is the belt.
  if (BUILTIN_IDS.has(shaderId)) return res.status(400).json({ error: 'That name collides with a built-in transition.' });

  const params = JSON.stringify(parseParams(source).map((p) => ({ name: p.name, default: p.default, min: p.min, max: p.max })));
  const id = crypto.randomUUID();
  try {
    db.prepare(`INSERT INTO custom_shaders (id, workspace_id, uploaded_by, shader_id, name, blurb, source, params, licence_note, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))`)
      .run(id, req.workspaceId, req.user?.id || null, shaderId, displayName, header.blurb, source, params,
           (licence_note || '').slice(0, 200) || null);
  } catch (e) {
    return res.status(409).json({ error: 'A custom transition with that name already exists in this workspace.' });
  }
  // Same shape as GET: params parsed, not a raw JSON string. A create response that differs from
  // the list response is a trap for whoever writes the UI against it.
  const row = db.prepare('SELECT id, shader_id, name, blurb, params, licence_note, created_at FROM custom_shaders WHERE id = ?').get(id);
  res.status(201).json({ ...row, params: JSON.parse(row.params || '[]') });
});

router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT id, workspace_id FROM custom_shaders WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.workspace_id !== req.workspaceId) return res.status(403).json({ error: 'Not your transition' });
  if (denyReadOnly(req, res)) return;   // scoped by workspace but not by role — a read-only member cannot delete
  db.prepare('DELETE FROM custom_shaders WHERE id = ?').run(row.id);
  // Widgets still naming it resolve to nothing, and the player hard-cuts. That is the same
  // behaviour a removed built-in already has, so no cleanup sweep is needed.
  res.json({ ok: true });
});

module.exports = router;
