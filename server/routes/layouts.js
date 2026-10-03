const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { PLATFORM_ROLES, ELEVATED_ROLES } = require('../middleware/auth');
// Phase 2.2h: workspace-aware access. Templates (is_template=1) are the
// platform-shared pair (NULL user_id, NULL workspace_id) and are visible
// everywhere, writable only by platform_admin.
const { accessContext, denyReadOnly } = require('../lib/tenancy');

// List layouts in the caller's current workspace plus all templates.
// Phase 2.2h: workspace-scoped. Templates (is_template=1) remain visible to
// everyone; cross-workspace owned-layout visibility comes from switch-workspace.
router.get('/', (req, res) => {
  const showTemplates = req.query.templates === 'true';

  let layouts;
  if (showTemplates) {
    layouts = db.prepare('SELECT * FROM layouts WHERE is_template = 1 ORDER BY template_category, name').all();
  } else if (!req.workspaceId) {
    // No workspace context -> only templates are visible.
    layouts = db.prepare('SELECT * FROM layouts WHERE is_template = 1 ORDER BY template_category, name').all();
  } else {
    layouts = db.prepare(
      'SELECT * FROM layouts WHERE (workspace_id = ? OR is_template = 1) ORDER BY is_template DESC, created_at DESC'
    ).all(req.workspaceId);
  }

  // Attach zones to each layout
  const zonesStmt = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order');
  layouts.forEach(l => { l.zones = zonesStmt.all(l.id); });

  res.json(layouts);
});

// Phase 2.2h: workspace-aware access. Mirrors content/widget/kiosk helpers.
// Templates (is_template=1) are readable by anyone authenticated; writable
// only by platform_admin (kept layered with the existing L78/L94 guards).
function checkLayoutRead(req, res) {
  const layout = db.prepare('SELECT * FROM layouts WHERE id = ?').get(req.params.id);
  if (!layout) { res.status(404).json({ error: 'Layout not found' }); return null; }
  if (layout.is_template) return layout;
  if (!layout.workspace_id) {
    // Owned row with no workspace - treat as inaccessible (shouldn't exist post-migration).
    res.status(403).json({ error: 'Layout not assigned to a workspace' }); return null;
  }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(layout.workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  return layout;
}

function checkLayoutWrite(req, res) {
  const layout = db.prepare('SELECT * FROM layouts WHERE id = ?').get(req.params.id);
  if (!layout) { res.status(404).json({ error: 'Layout not found' }); return null; }
  if (layout.is_template) {
    // Templates: only platform_admin may write. Existing L78/L94 also check
    // is_template explicitly with the same intent; this is the layered gate.
    if (!PLATFORM_ROLES.includes(req.user.role)) {
      res.status(403).json({ error: 'Platform admin required to modify templates' }); return null;
    }
    return layout;
  }
  if (!layout.workspace_id) {
    res.status(403).json({ error: 'Layout not assigned to a workspace' }); return null;
  }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(layout.workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return null;
  }
  return layout;
}

// Get layout with zones
router.get('/:id', (req, res) => {
  const layout = checkLayoutRead(req, res);
  if (!layout) return;

  layout.zones = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(layout.id);
  // `zones` stays the LIVE set - renderers and assignments read this route too. A pending draft is
  // offered alongside it so the editor can open on the author's unpublished work instead of
  // showing them the live layout and quietly discarding the draft on their next save.
  const pending = require('../lib/revisions').parseJson(layout.draft_zones, null);
  if (pending) layout.draft = pending;
  res.json(layout);
});

const VALID_FIT_MODES = new Set(['cover', 'contain', 'fill']);
function safeFitMode(m) {
  return (typeof m === 'string' && VALID_FIT_MODES.has(m.toLowerCase())) ? m.toLowerCase() : 'contain';
}
function safeHexColor(c, fallback = '#000000') {
  if (!c || typeof c !== 'string') return fallback;
  const s = c.trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(s) ? s : fallback;
}

// Create layout
router.post('/', (req, res) => {
  const { name, width, height, zones, is_template, template_category } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  // Templates are platform-wide; only platform_admin can create them.
  if (is_template && !PLATFORM_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Only platform admins can create templates' });
  }
  // Owned layouts require an active workspace.
  if (!is_template && !req.workspaceId) {
    return res.status(400).json({ error: 'Workspace ID is required' });
  }
  // A read-only member cannot create an owned layout (a template already needs platform_admin above).
  if (!is_template && denyReadOnly(req, res)) return;

  const id = uuidv4();
  const w = width || 1920;
  const h = height || 1080;
  const tpl = is_template ? 1 : 0;
  const cat = is_template ? (template_category || 'general') : null;
  const wsId = is_template ? null : req.workspaceId;
  const userId = is_template ? null : req.user.id;

  db.prepare(`
    INSERT INTO layouts (id, name, width, height, is_template, template_category, user_id, workspace_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, w, h, tpl, cat, userId, wsId);

  if (Array.isArray(zones) && zones.length > 0) {
    const stmt = db.prepare(`
      INSERT INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, z_index, zone_type, fit_mode, background_color, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    zones.forEach((z, i) => {
      stmt.run(uuidv4(), id, z.name || `Zone ${i + 1}`, z.x_percent || 0, z.y_percent || 0,
        z.width_percent || 100, z.height_percent || 100, z.z_index || 0,
        z.zone_type || 'content', safeFitMode(z.fit_mode), safeHexColor(z.background_color, '#000000'), i);
    });
  }

  const layout = db.prepare('SELECT * FROM layouts WHERE id = ?').get(id);
  layout.zones = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(id);
  require('../lib/revisions').recordCurrent(db, 'layout', layout.id, { actor: require('../lib/releases').actorOf(req), summary: 'Created' });
  res.status(201).json(layout);
});

// Update layout
router.put('/:id', (req, res) => {
  const layout = checkLayoutWrite(req, res);
  if (!layout) return;
  if (layout.is_template && !PLATFORM_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Cannot edit templates' });

  const { name, width, height, zones } = req.body;

  // Approval on: the whole layout is saved as a DRAFT (draft_zones) and screens keep the zones
  // they have until a reviewed submission publishes it (lib/releases.js releaseLayoutDraft).
  const policy = require('../lib/release-policy');
  const revisions = require('../lib/revisions');
  const actor = require('../lib/releases').actorOf(req);
  if (layout.workspace_id && policy.approvalRequired(db, layout.workspace_id)) {
    const base = revisions.parseJson(layout.draft_zones, null)
      || { name: layout.name, width: layout.width, height: layout.height, zones: db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(layout.id) };
    const draft = {
      name: name || base.name, width: width || base.width, height: height || base.height,
      zones: Array.isArray(zones) ? zones.map((z, i) => ({ ...z, id: z.id || uuidv4(), sort_order: i })) : base.zones,
    };
    db.prepare('UPDATE layouts SET draft_zones = ? WHERE id = ?').run(JSON.stringify(draft), req.params.id);
    revisions.recordCurrent(db, 'layout', req.params.id, { actor, summary: 'Saved draft' });
    /*
     * ⚠️ ECHO THE DRAFT BACK, NOT THE LIVE ZONES.
     *
     * The editor assigns the response straight onto its canvas. Returning the live rows made the
     * zones visibly snap back to their pre-edit positions the instant the "saved as draft" toast
     * appeared, and a second Save then serialised those reverted positions over the draft.
     */
    const current = db.prepare('SELECT * FROM layouts WHERE id = ?').get(req.params.id);
    current.zones = draft.zones;
    return res.json({ ...current, name: draft.name, width: draft.width, height: draft.height, draft: true, pending_review: true });
  }

  const txn = db.transaction(() => {
    if (name) db.prepare('UPDATE layouts SET name = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?').run(name, req.params.id);
    if (width) db.prepare('UPDATE layouts SET width = ? WHERE id = ?').run(width, req.params.id);
    if (height) db.prepare('UPDATE layouts SET height = ? WHERE id = ?').run(height, req.params.id);

    // Atomic zone replace: the editor sends the FULL desired set, so the layout
    // ends up with EXACTLY those zones - no accumulation from a per-zone
    // delete/add loop. Reuse each zone's id when supplied so device->zone
    // assignments survive an edit (a fresh uuid per save would orphan them).
    if (Array.isArray(zones)) {
      // DIFF, never delete-and-replace.
      //
      // The previous version deleted every zone and re-inserted the same ids, on the stated
      // assumption that reusing an id preserved whatever pointed at it. It does not: SQLite runs
      // the referential actions on the DELETE, and re-inserting the same primary key afterwards
      // does not resurrect what they destroyed. Two things point at these rows:
      //
      //   playlist_items.zone_id  ON DELETE SET NULL  -> every multi-zone playlist in the
      //                                                  workspace silently fell back to fullscreen
      //   schedules.zone_id       ON DELETE CASCADE   -> every zone-bound schedule was DELETED,
      //                                                  permanently, no warning and no undo
      //
      // So nudging one zone by a pixel and pressing Save destroyed unrelated tenant data and
      // returned 200 OK. Updating in place touches no foreign key at all; only genuinely removed
      // zones are deleted, which is the one case where those cascades are the intended behaviour.
      const existingIds = db.prepare('SELECT id FROM layout_zones WHERE layout_id = ?')
        .all(req.params.id).map(r => r.id);
      const existingSet = new Set(existingIds);
      const keptIds = new Set();

      const insertZone = db.prepare(`
        INSERT INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, z_index, zone_type, fit_mode, background_color, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const updateZone = db.prepare(`
        UPDATE layout_zones SET name = ?, x_percent = ?, y_percent = ?, width_percent = ?,
          height_percent = ?, z_index = ?, zone_type = ?, fit_mode = ?, background_color = ?, sort_order = ?
        WHERE id = ? AND layout_id = ?
      `);

      zones.forEach((z, i) => {
        const zid = z.id || uuidv4();
        const vals = [
          z.name || `Zone ${i + 1}`,
          z.x_percent || 0, z.y_percent || 0, z.width_percent || 100, z.height_percent || 100,
          z.z_index || 0, z.zone_type || 'content', safeFitMode(z.fit_mode),
          safeHexColor(z.background_color, '#000000'), i,
        ];
        if (existingSet.has(zid)) updateZone.run(...vals, zid, req.params.id);
        else insertZone.run(zid, req.params.id, ...vals);
        keptIds.add(zid);
      });

      // Only the zones the editor actually removed.
      for (const zid of existingIds) {
        if (!keptIds.has(zid)) {
          db.prepare('DELETE FROM layout_zones WHERE id = ? AND layout_id = ?').run(zid, req.params.id);
        }
      }
      db.prepare('UPDATE layouts SET updated_at = strftime(\'%s\',\'now\') WHERE id = ?').run(req.params.id);
    }
  });
  txn();
  revisions.recordCurrent(db, 'layout', req.params.id, { actor, summary: 'Saved' });

  const updated = db.prepare('SELECT * FROM layouts WHERE id = ?').get(req.params.id);
  updated.zones = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(req.params.id);
  // Push to the displays using this layout. Editing a layout used to notify nothing at all, so a
  // zone change waited for the next heartbeat refresh at best — and on Android it did not apply
  // even then, because the rebuild was keyed on the layout ID, which does not change when you edit
  // a layout in place. Reported on #234 as "I added 4 zones and they dont appear on the screen".
  // The player-side fix makes the rebuild happen; this makes it happen promptly.
  try {
    const io = req.app.get('io');
    if (io) {
      const { buildPlaylistPayload } = require('../ws/deviceSocket');
      const commandQueue = require('../lib/command-queue');
      for (const d of db.prepare('SELECT id FROM devices WHERE layout_id = ?').all(req.params.id)) {
        commandQueue.queueOrEmitPlaylistUpdate(io.of('/device'), d.id, buildPlaylistPayload);
      }
    }
  } catch (e) { /* best-effort; the heartbeat refresh still picks it up */ }

  res.json(updated);
});

// Delete layout
router.delete('/:id', (req, res) => {
  const layout = checkLayoutWrite(req, res);
  if (!layout) return;
  if (layout.is_template && !PLATFORM_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Cannot delete templates' });

  db.prepare('DELETE FROM layouts WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Add zone to layout. Phase 2.2h: tightened to write-access; workspace_viewer
// can read the layout via GET but cannot add zones.
// Zone-level writes change what screens show in place. With approval on they are refused with
// the way forward: save the whole layout (PUT /:id), which becomes a draft for review.
function refuseZoneWriteUnderApproval(req, res, layout) {
  if (layout.workspace_id && require('../lib/release-policy').approvalRequired(db, layout.workspace_id)) {
    res.status(409).json({ error: 'This workspace requires review before layout changes go live. Save the layout as a whole to create a draft, then submit it for review.', code: 'approval_required' });
    return true;
  }
  return false;
}

router.post('/:id/zones', (req, res) => {
  const layout = checkLayoutWrite(req, res);
  if (!layout) return;
  if (refuseZoneWriteUnderApproval(req, res, layout)) return;

  const { name, x_percent, y_percent, width_percent, height_percent, z_index, zone_type, fit_mode, background_color } = req.body;
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM layout_zones WHERE layout_id = ?').get(req.params.id).m || 0;

  const id = uuidv4();
  db.prepare(`
    INSERT INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, z_index, zone_type, fit_mode, background_color, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.params.id, name || 'New Zone', x_percent || 0, y_percent || 0,
    width_percent || 50, height_percent || 50, z_index || 0,
    zone_type || 'content', safeFitMode(fit_mode), safeHexColor(background_color, '#000000'), maxOrder + 1);

  db.prepare("UPDATE layouts SET updated_at = strftime('%s','now') WHERE id = ?").run(req.params.id);

  const zone = db.prepare('SELECT * FROM layout_zones WHERE id = ?').get(id);
  res.status(201).json(zone);
});

// Update zone
router.put('/:id/zones/:zoneId', (req, res) => {
  const layout = checkLayoutWrite(req, res);
  if (!layout) return;
  if (refuseZoneWriteUnderApproval(req, res, layout)) return;
  const zone = db.prepare('SELECT * FROM layout_zones WHERE id = ? AND layout_id = ?').get(req.params.zoneId, req.params.id);
  if (!zone) return res.status(404).json({ error: 'Zone not found' });

  const fields = ['name', 'x_percent', 'y_percent', 'width_percent', 'height_percent', 'z_index', 'zone_type', 'fit_mode', 'background_color', 'sort_order'];
  const updates = [];
  const values = [];
  fields.forEach(f => {
    if (req.body[f] !== undefined) {
      let val = req.body[f];
      if (f === 'fit_mode') val = safeFitMode(val);
      if (f === 'background_color') val = safeHexColor(val, '#000000');
      updates.push(`${f} = ?`);
      values.push(val);
    }
  });

  if (updates.length > 0) {
    values.push(req.params.zoneId);
    db.prepare(`UPDATE layout_zones SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    db.prepare("UPDATE layouts SET updated_at = strftime('%s','now') WHERE id = ?").run(req.params.id);
  }

  const updated = db.prepare('SELECT * FROM layout_zones WHERE id = ?').get(req.params.zoneId);
  res.json(updated);
});

// Delete zone
router.delete('/:id/zones/:zoneId', (req, res) => {
  const layout = checkLayoutWrite(req, res);
  if (!layout) return;
  if (refuseZoneWriteUnderApproval(req, res, layout)) return;
  db.prepare('DELETE FROM layout_zones WHERE id = ? AND layout_id = ?').run(req.params.zoneId, req.params.id);
  db.prepare("UPDATE layouts SET updated_at = strftime('%s','now') WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// Duplicate layout (for using templates). Source needs read-access only;
// destination lands in the caller's current workspace.
router.post('/:id/duplicate', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before duplicating a layout.' });
  if (denyReadOnly(req, res)) return;
  const source = checkLayoutRead(req, res);
  if (!source) return;

  const newId = uuidv4();
  const name = req.body.name || `${source.name} (Copy)`;

  db.prepare('INSERT INTO layouts (id, user_id, workspace_id, name, width, height) VALUES (?, ?, ?, ?, ?, ?)')
    .run(newId, req.user.id, req.workspaceId, name, source.width, source.height);

  // Copy zones, keeping an old->new zone-id map. The copy gets fresh zone ids, so any
  // playlist_items still pointing at the SOURCE zones would be orphaned if a device is
  // moved onto this copy. We return the map (zone_id_map) so a follow-up remap can run.
  // NOTE for review: we intentionally do NOT auto-rewrite playlist_items.zone_id here —
  // the source layout's own assignments must keep pointing at the source. A safe remap is
  // a scoped op ("migrate playlist P from layout A to its copy B"), best done explicitly;
  // see find-orphan-zone-items.js + the player fallback, which already de-risk the runtime.
  const zones = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ?').all(req.params.id);
  const stmt = db.prepare(`
    INSERT INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, z_index, zone_type, fit_mode, background_color, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const zone_id_map = {};
  zones.forEach(z => {
    const nz = uuidv4();
    zone_id_map[z.id] = nz;
    stmt.run(nz, newId, z.name, z.x_percent, z.y_percent, z.width_percent, z.height_percent,
      z.z_index, z.zone_type, z.fit_mode, z.background_color, z.sort_order);
  });

  const layout = db.prepare('SELECT * FROM layouts WHERE id = ?').get(newId);
  layout.zones = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(newId);
  res.status(201).json({ ...layout, zone_id_map });
});

// Assign layout to device.
// Phase 2.2h: closes a pre-existing cross-tenant leak. Today the route only
// gated by device-ownership and didn't verify the layout_id at all, so any
// caller with write access to a device could assign another workspace's
// layout to it - the player would then render foreign zones/dimensions.
//
// New rules:
//   1. Caller must have write access to the DEVICE's workspace.
//   2. The layout must be either a template (is_template=1) or live in the
//      same workspace as the device.
router.put('/device/:deviceId', (req, res) => {
  const device = db.prepare('SELECT user_id, workspace_id FROM devices WHERE id = ?').get(req.params.deviceId);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (!device.workspace_id) return res.status(403).json({ error: 'Device not assigned to a workspace' });

  const deviceWs = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(device.workspace_id);
  const ctx = deviceWs && accessContext(req.user.id, req.user.role, deviceWs);
  if (!ctx) return res.status(403).json({ error: 'Access denied' });
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    return res.status(403).json({ error: 'Read-only access' });
  }

  const { layout_id } = req.body;
  if (layout_id) {
    const layout = db.prepare('SELECT is_template, workspace_id FROM layouts WHERE id = ?').get(layout_id);
    if (!layout) return res.status(400).json({ error: 'Invalid layout_id' });
    // Layout must be a template, or live in the device's workspace.
    if (!layout.is_template && layout.workspace_id !== device.workspace_id) {
      return res.status(403).json({ error: 'Layout is not in this device\'s workspace and is not a template' });
    }
  }

  db.prepare("UPDATE devices SET layout_id = ?, updated_at = strftime('%s','now') WHERE id = ?")
    .run(layout_id || null, req.params.deviceId);
  res.json({ success: true });
});

module.exports = router;
