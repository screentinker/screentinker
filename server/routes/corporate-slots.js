'use strict';

/*
 * /api/corporate — LOCAL SLOTS and the store content that fills them (spec Stage B, §3, §4.3, §7.5,
 * §7.7, §7.8). Registered on the corporate router (routes/corporate.js), so it inherits its mount:
 * JWT-only (D12), tenancy resolved, every write 503 in degraded mode.
 *
 *   Head office (corporate authors):
 *     POST   /playlists/:id/slots      add a slot to a corporate playlist (draft; live on publish)
 *     PUT    /slots/:id                slot settings (name, help, limits, fallback) — draft
 *     DELETE /slots/:id                remove the slot from the draft (retired, kept with its content)
 *     GET    /slots/:id/impact         which stores a proposed limit would put over it
 *     GET    /reports/slots            compliance: per slot x workspace, filled / fallback / skipped / over
 *     GET    /reports/plays            corporate airtime from play_logs
 *   Stores (editors of the store workspace; org admins act-as):
 *     GET    /store                    what head office plays here, and "Your slots"
 *     POST   /slots/:id/fills          content for a slot at a level (workspace, group, wall, screen)
 *     PUT    /fills/:id                point a level at another of the store's playlists
 *     DELETE /fills/:id                "Use {level}'s again" — remove this level's own content
 *     GET    /fills/:id/preview        head office's loop with this slot's DRAFT spliced in
 *
 * Slot settings are AUTHOR actions (the role matrix row "create/edit/publish/delete corporate
 * playlist, its children, slots"); assigning where a playlist plays stays org-admin-only.
 */

const { db } = require('../db/database');
const { accessContext } = require('../lib/tenancy');
const guard = require('../lib/corporate/guard');
const runtime = require('../lib/corporate/runtime');
const fanout = require('../lib/corporate/fanout');
const resolve = require('../lib/corporate/resolve');
const fills = require('../lib/corporate/fills');
const composition = require('../lib/corporate/composition');
const { isUnboundedItem, effectiveSeconds, fillViolation, fillTotals } = require('../lib/corporate/compose');
const { v4: uuidv4 } = require('uuid');

const int = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

function register(router, h) {
  const { loadOrg, refuse, requireAvailable, requireAuthor, auditCorp, loadHqPlaylist, canReadHq } = h;

  /* ── helpers ──────────────────────────────────────────────────────────────────────────────── */

  function markDraft(playlistId, req, summary) {
    db.prepare("UPDATE playlists SET status = 'draft', updated_at = strftime('%s','now') WHERE id = ?").run(playlistId);
    try {
      require('../lib/revisions').recordCurrent(db, 'playlist', playlistId, { actor: require('../lib/releases').actorOf(req), summary });
    } catch (_) { /* history is best-effort here, as in markDraft elsewhere */ }
  }

  /** A slot and its corporate playlist, in this org's HQ. */
  function loadSlot(req, res, org) {
    const slot = fills.slotRow(db, req.params.id);
    if (!slot || slot.organization_id !== org.id) { res.status(404).json({ error: 'Slot not found' }); return null; }
    const p = db.prepare('SELECT * FROM playlists WHERE id = ?').get(slot.playlist_id);
    if (!p) { res.status(404).json({ error: 'Slot not found' }); return null; }
    return { slot, playlist: p };
  }

  /** Workspace write access for a store action (editor+, or org/platform acting-as). */
  function wsWrite(req, wsId) {
    const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(wsId);
    const ctx = ws && accessContext(req.user.id, req.user.role, ws);
    if (!ctx) return { ok: false, status: 403, error: 'Access denied' };
    if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') return { ok: false, status: 403, error: 'Read-only access' };
    return { ok: true, ws };
  }
  function wsRead(req, wsId) {
    const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(wsId);
    return !!(ws && accessContext(req.user.id, req.user.role, ws));
  }

  /** Validate a slot body. @returns {error} | normalized fields (only those present, unless `full`). */
  function slotFields(b, org, { full = false } = {}) {
    const out = {};
    if (full || b.name !== undefined) {
      const name = String(b.name || '').trim();
      if (!name || name.length > 80) return { error: 'name is required (up to 80 characters)' };
      out.name = name;
    }
    if (b.help_text !== undefined) out.help_text = b.help_text ? String(b.help_text).slice(0, 500) : null;
    if (b.max_items !== undefined) {
      const n = int(b.max_items);
      if (n !== null && (!Number.isInteger(n) || n < 1 || n > 100)) return { error: 'max_items must be 1-100, or empty for no limit' };
      out.max_items = n;
    }
    if (b.max_total_sec !== undefined) {
      const n = int(b.max_total_sec);
      if (n !== null && (!Number.isInteger(n) || n < 5 || n > 3600)) return { error: 'max_total_sec must be 5-3600 seconds, or empty for no limit' };
      out.max_total_sec = n;
    }
    if (b.allow_video !== undefined) out.allow_video = b.allow_video ? 1 : 0;
    if (b.allow_widgets !== undefined) out.allow_widgets = b.allow_widgets ? 1 : 0;
    if (b.fallback_duration_sec !== undefined) {
      const n = int(b.fallback_duration_sec);
      if (n !== null && (!Number.isInteger(n) || n < 1 || n > 3600)) return { error: 'fallback_duration_sec must be 1-3600, or empty' };
      out.fallback_duration_sec = n;
    }
    if (b.fallback_content_id !== undefined || b.fallback_widget_id !== undefined) {
      const cid = b.fallback_content_id || null;
      const wid = b.fallback_widget_id || null;
      if (cid && wid) return { error: 'A fallback is one picture, video or widget — not both' };
      if (cid) {
        const c = db.prepare('SELECT id, workspace_id, mime_type, duration_sec, filename FROM content WHERE id = ?').get(cid);
        if (!c || (c.workspace_id && c.workspace_id !== org.hq_workspace_id)) return { error: 'The fallback must be content in the head office workspace' };
        // A fallback plays when a store leaves the slot empty: it must end, like anything in a slot.
        if (isUnboundedItem({ mime_type: c.mime_type, content_duration: c.duration_sec })) {
          return { error: `"${c.filename}" has no fixed length (a live stream, a YouTube video or a web video we can't measure), so it can't be a slot's fallback.`, code: 'FILL_LIVE' };
        }
      }
      if (wid) {
        const w = db.prepare('SELECT id, workspace_id FROM widgets WHERE id = ?').get(wid);
        if (!w || (w.workspace_id && w.workspace_id !== org.hq_workspace_id)) return { error: 'The fallback must be a widget in the head office workspace' };
      }
      out.fallback_content_id = cid;
      out.fallback_widget_id = wid;
    }
    return out;
  }

  function zoneOk(org, zoneId) {
    if (!zoneId) return true;
    return !!db.prepare('SELECT lz.id FROM layout_zones lz JOIN layouts l ON l.id = lz.layout_id WHERE lz.id = ? AND (l.is_template = 1 OR l.workspace_id = ?)')
      .get(zoneId, org.hq_workspace_id);
  }

  function slotView(slot) {
    const markers = resolve.publishedMarkers(db, slot.playlist_id);
    const live = markers.get(slot.id);
    const fb = slot.fallback_content_id
      ? db.prepare('SELECT id, filename AS name, mime_type FROM content WHERE id = ?').get(slot.fallback_content_id)
      : slot.fallback_widget_id ? db.prepare('SELECT id, name, widget_type FROM widgets WHERE id = ?').get(slot.fallback_widget_id) : null;
    const placed = db.prepare('SELECT id, zone_id, sort_order, play_from, play_until, weight, enabled FROM playlist_items WHERE slot_id = ?').get(slot.id) || null;
    return {
      id: slot.id, playlist_id: slot.playlist_id, name: slot.name, help_text: slot.help_text || null,
      limits: fills.limitsOfRow(slot),
      live_limits: live ? live.limits : null,
      live: !!live,
      fallback: fb ? { kind: slot.fallback_content_id ? 'content' : 'widget', ...fb, duration_sec: slot.fallback_duration_sec || null } : null,
      placement: placed,
      retired: !!slot.retired_at,
      fills: db.prepare('SELECT COUNT(*) AS n FROM corporate_slot_fills WHERE slot_id = ?').get(slot.id).n,
      updated_at: slot.updated_at,
    };
  }
  h.slotView = slotView;

  /* ── slots (head office) ──────────────────────────────────────────────────────────────────── */

  router.post('/playlists/:id/slots', (req, res) => {
    const org = loadOrg(req, res);
    if (!org) return;
    if (!requireAvailable(res) || !requireAuthor(req, res, org)) return;
    const p = loadHqPlaylist(req, res, org);
    if (!p) return;
    if (!p.corporate) return res.status(400).json({ error: 'Only a corporate playlist can have local slots. Make it corporate first.' });
    if (p.smart_rules) return refuse(res, 'CORPORATE_SMART');
    const b = req.body || {};
    const f = slotFields(b, org, { full: true });
    if (f.error) return res.status(400).json({ error: f.error, ...(f.code ? { code: f.code } : {}) });
    if (!zoneOk(org, b.zone_id)) return res.status(400).json({ error: 'zone_id not found in the head office workspace' });
    const id = uuidv4();
    db.transaction(() => {
      db.prepare(`INSERT INTO corporate_slots (id, organization_id, playlist_id, name, help_text, max_items, max_total_sec, allow_video, allow_widgets,
                                               fallback_content_id, fallback_widget_id, fallback_duration_sec, created_by)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, org.id, p.id, f.name, f.help_text || null, f.max_items ?? null, f.max_total_sec ?? null,
          f.allow_video ?? 1, f.allow_widgets ?? 1, f.fallback_content_id || null, f.fallback_widget_id || null, f.fallback_duration_sec ?? null, req.user.id);
      let order = b.sort_order;
      if (order === undefined || order === null) {
        order = ((db.prepare('SELECT MAX(sort_order) AS m FROM playlist_items WHERE playlist_id = ?').get(p.id) || {}).m || 0) + 1;
      }
      db.prepare('INSERT INTO playlist_items (playlist_id, slot_id, zone_id, sort_order, duration_sec) VALUES (?, ?, ?, ?, 10)')
        .run(p.id, id, b.zone_id || null, Number(order) || 0);
    })();
    markDraft(p.id, req, `Added local slot "${f.name}"`);
    const slot = fills.slotRow(db, id);
    auditCorp(req, 'corporate.slot.create', { organization_id: org.id, slot_id: id, playlist_id: p.id, workspace_id: p.workspace_id, after: slotView(slot) });
    res.status(201).json(slotView(slot));
  });

  router.get('/slots/:id', (req, res) => {
    const org = loadOrg(req, res);
    if (!org) return;
    if (!canReadHq(req, org)) return refuse(res, 'CORPORATE_AUTHOR_REQUIRED');
    const s = loadSlot(req, res, org);
    if (!s) return;
    res.json(slotView(s.slot));
  });

  router.put('/slots/:id', (req, res) => {
    const org = loadOrg(req, res);
    if (!org) return;
    if (!requireAvailable(res) || !requireAuthor(req, res, org)) return;
    const s = loadSlot(req, res, org);
    if (!s) return;
    const f = slotFields(req.body || {}, org);
    if (f.error) return res.status(400).json({ error: f.error, ...(f.code ? { code: f.code } : {}) });
    const before = slotView(s.slot);
    const cols = Object.keys(f);
    if (cols.length) {
      db.prepare(`UPDATE corporate_slots SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = strftime('%s','now') WHERE id = ?`)
        .run(...cols.map((c) => f[c]), s.slot.id);
      // Slot settings take effect on the next corporate publish (the published markers carry the
      // limits stores are held to), so the corporate playlist now has unpublished changes (R19).
      markDraft(s.playlist.id, req, `Changed local slot "${f.name || s.slot.name}"`);
    }
    const after = slotView(fills.slotRow(db, s.slot.id));
    auditCorp(req, 'corporate.slot.update', { organization_id: org.id, slot_id: s.slot.id, playlist_id: s.playlist.id, workspace_id: s.playlist.workspace_id, before, after });
    res.json(after);
  });

  router.delete('/slots/:id', (req, res) => {
    const org = loadOrg(req, res);
    if (!org) return;
    if (!requireAvailable(res) || !requireAuthor(req, res, org)) return;
    const s = loadSlot(req, res, org);
    if (!s) return;
    /*
     * Retire, never delete: the slot row and its stores' content stay, so a discard of this draft or a
     * revision restore can bring the slot back exactly as it was. Retired slots nothing refers to any
     * more are hard-deleted by the hourly sweep (services/corporate-sweep.js).
     */
    db.transaction(() => {
      db.prepare('DELETE FROM playlist_items WHERE slot_id = ?').run(s.slot.id);
      db.prepare("UPDATE corporate_slots SET retired_at = strftime('%s','now'), updated_at = strftime('%s','now') WHERE id = ?").run(s.slot.id);
    })();
    markDraft(s.playlist.id, req, `Removed local slot "${s.slot.name}"`);
    auditCorp(req, 'corporate.slot.delete', { organization_id: org.id, slot_id: s.slot.id, playlist_id: s.playlist.id, workspace_id: s.playlist.workspace_id, before: slotView(s.slot) });
    res.json({ success: true, retired: true, takes_effect: 'on_publish' });
  });

  /*
   * "Live: up to 5 items · After you publish: up to 3 · {k} stores have more than that" — which fills a
   * proposed limit would put over it (spec §7.3, critique HQ 9). Judged on each fill's PUBLISHED
   * content, i.e. what would stop playing.
   */
  router.get('/slots/:id/impact', (req, res) => {
    const org = loadOrg(req, res);
    if (!org) return;
    if (!requireAuthor(req, res, org)) return;
    const s = loadSlot(req, res, org);
    if (!s) return;
    const q = req.query || {};
    const current = fills.limitsOfRow(s.slot);
    const next = { ...current };
    for (const k of ['max_items', 'max_total_sec']) if (q[k] !== undefined) next[k] = int(q[k]);
    for (const k of ['allow_video', 'allow_widgets']) if (q[k] !== undefined) next[k] = q[k] === '1' || q[k] === 'true' ? 1 : 0;
    const live = resolve.publishedMarkers(db, s.slot.playlist_id).get(s.slot.id);
    const over = [];
    for (const f of db.prepare(`SELECT f.*, w.name AS workspace_name FROM corporate_slot_fills f JOIN workspaces w ON w.id = f.workspace_id
                                 WHERE f.slot_id = ?`).all(s.slot.id)) {
      const t = fills.publishedTotals(db, f.fill_playlist_id);
      if (!t.published) continue;
      const v = fillViolation(t.items_list, next, { slotName: s.slot.name, contentDuration: composition.contentDurationLookup(db, [t.items_list]) });
      if (v) {
        over.push({ fill_id: f.id, workspace_id: f.workspace_id, workspace_name: f.workspace_name, scope_kind: f.scope_kind,
          scope_label: fills.scopeLabel(db, f.scope_kind, f.scope_id), items: t.items, seconds: t.seconds, code: v.code });
      }
    }
    res.json({ live: live ? live.limits : null, next, over, stores: new Set(over.map((o) => o.workspace_id)).size });
  });

  /* ── fills (stores) ───────────────────────────────────────────────────────────────────────── */

  /** Does corporate playlist P play anywhere in workspace W (an enabled mandate reaching it)? */
  function coversWorkspace(playlistId, wsId) {
    return !!db.prepare(`SELECT 1 FROM corporate_mandates cm WHERE cm.playlist_id = ? AND cm.enabled = 1 AND (
          (cm.target_kind = 'org' AND cm.target_id = (SELECT organization_id FROM workspaces WHERE id = ?))
       OR (cm.target_kind = 'workspace' AND cm.target_id = ?)
       OR (cm.target_kind = 'group' AND cm.target_id IN (SELECT id FROM device_groups WHERE workspace_id = ?))
       OR (cm.target_kind = 'wall' AND cm.target_id IN (SELECT id FROM video_walls WHERE workspace_id = ?))
       OR (cm.target_kind = 'device' AND cm.target_id IN (SELECT id FROM devices WHERE workspace_id = ?))) LIMIT 1`)
      .get(playlistId, wsId, wsId, wsId, wsId, wsId);
  }

  /** The workspace a fill scope lives in (and refusals for scopes that cannot hold one). */
  function scopeWorkspace(kind, id) {
    if (kind === 'workspace') return db.prepare('SELECT id FROM workspaces WHERE id = ?').get(id) ? { ws: id } : null;
    if (kind === 'group') { const g = db.prepare('SELECT workspace_id FROM device_groups WHERE id = ?').get(id); return g ? { ws: g.workspace_id } : null; }
    if (kind === 'wall') { const w = db.prepare('SELECT workspace_id FROM video_walls WHERE id = ?').get(id); return w ? { ws: w.workspace_id } : null; }
    if (kind === 'device') {
      const d = db.prepare('SELECT workspace_id, wall_id FROM devices WHERE id = ?').get(id);
      if (!d) return null;
      if (d.wall_id) return { ws: d.workspace_id, wall: d.wall_id };
      return { ws: d.workspace_id };
    }
    return null;
  }

  /** May this (existing) playlist hold a slot's content? Store-owned, flat, not smart, not already a fill. */
  function adoptable(playlistId, wsId) {
    const p = db.prepare('SELECT id, workspace_id, corporate, smart_rules FROM playlists WHERE id = ?').get(playlistId);
    if (!p || p.workspace_id !== wsId) return 'fill_playlist_id must be a playlist in the same workspace';
    if (p.corporate) return 'A corporate playlist cannot be store content';
    if (p.smart_rules) return guard.MESSAGES.FILL_FLAT();
    if (db.prepare('SELECT 1 FROM playlist_items WHERE playlist_id = ? AND (child_playlist_id IS NOT NULL OR slot_id IS NOT NULL) LIMIT 1').get(playlistId)) return guard.MESSAGES.FILL_FLAT();
    if (db.prepare('SELECT 1 FROM playlist_items WHERE child_playlist_id = ? LIMIT 1').get(playlistId)) return 'This playlist is used inside another playlist, so it cannot be slot content';
    if (db.prepare('SELECT 1 FROM corporate_slot_fills WHERE fill_playlist_id = ? LIMIT 1').get(playlistId)) return 'This playlist already fills a slot';
    return null;
  }

  function fillView(f) {
    const t = fills.publishedTotals(db, f.fill_playlist_id);
    const p = db.prepare('SELECT name, status, updated_at FROM playlists WHERE id = ?').get(f.fill_playlist_id) || {};
    return {
      id: f.id, slot_id: f.slot_id, workspace_id: f.workspace_id, scope_kind: f.scope_kind, scope_id: f.scope_id,
      scope_label: fills.scopeLabel(db, f.scope_kind, f.scope_id), fill_playlist_id: f.fill_playlist_id,
      fill_playlist_name: p.name || null, status: p.status || null, fill_state: f.fill_state,
      published: t.published, items: t.items, seconds: t.seconds,
      screens: fills.screensForFill(db, f).length, updated_at: p.updated_at || f.updated_at, created_by: f.created_by,
    };
  }

  router.post('/slots/:id/fills', (req, res) => {
    const org = loadOrg(req, res);
    if (!org) return;
    if (!requireAvailable(res)) return;
    const s = loadSlot(req, res, org);
    if (!s) return;
    const b = req.body || {};
    const kind = b.scope_kind;
    if (!['workspace', 'group', 'wall', 'device'].includes(kind)) return res.status(400).json({ error: 'scope_kind must be workspace, group, wall or device' });
    const scopeId = String(b.scope_id || '');
    const sc = scopeId && scopeWorkspace(kind, scopeId);
    if (!sc) return refuse(res, 'CORPORATE_FILL_SCOPE');
    if (sc.wall) {
      const wall = db.prepare('SELECT name FROM video_walls WHERE id = ?').get(sc.wall);
      return refuse(res, 'CORPORATE_WALL_SPLIT', { wall: wall && wall.name }, { wall_id: sc.wall });
    }
    const access = wsWrite(req, sc.ws);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (access.ws.organization_id !== org.id) return refuse(res, 'CORPORATE_FILL_SCOPE');
    if (!resolve.publishedMarkers(db, s.slot.playlist_id).has(s.slot.id)) {
      return res.status(409).json({ error: 'This slot is not live yet: head office has to publish it first.', code: 'CORPORATE_SLOT_NOT_LIVE' });
    }
    if (!coversWorkspace(s.slot.playlist_id, sc.ws)) return refuse(res, 'CORPORATE_FILL_SCOPE');
    if (guard.isReplicatedWorkspace(db, sc.ws)) return refuse(res, 'CORPORATE_MESH_UNSUPPORTED', { workspace: `"${access.ws.name}"` });
    const existing = fills.fillAt(db, s.slot.id, kind, scopeId);
    if (existing) {
      return refuse(res, 'CORPORATE_FILL_EXISTS', { label: fills.scopeLabel(db, kind, scopeId), slot: s.slot.name }, { fill: fillView(existing) });
    }
    if (b.fill_playlist_id) {
      const why = adoptable(String(b.fill_playlist_id), sc.ws);
      if (why) return res.status(400).json({ error: why });
    }
    const { result, changed } = fanout.withCompositionDiff(req, s.slot.playlist_id, () => {
      if (b.fill_playlist_id) {
        const id = uuidv4();
        db.prepare(`INSERT INTO corporate_slot_fills (id, slot_id, workspace_id, scope_kind, scope_id, fill_playlist_id, created_by)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, s.slot.id, sc.ws, kind, scopeId, String(b.fill_playlist_id), req.user.id);
        const f = db.prepare('SELECT * FROM corporate_slot_fills WHERE id = ?').get(id);
        const t = fills.publishedTotals(db, f.fill_playlist_id);
        if (t.published && fillViolation(t.items_list, fills.limitsFor(db, s.slot), { slotName: s.slot.name })) fills.setFillStates(db, [[f, 'over_limit']], 'adopted');
        return db.prepare('SELECT * FROM corporate_slot_fills WHERE id = ?').get(id);
      }
      /*
       * A narrower level starts as a COPY of what it plays now (critique U1): a screen's own content
       * copies its nearest fill, a group's copies the workspace's. Nothing changes on screen until
       * the store edits and publishes it. `copy: false` starts empty (unpublished: still nothing
       * changes until it is published).
       */
      const copy = b.copy !== false;
      if (copy && kind === 'device') return fills.ensureFillForDevice(db, scopeId, s.slot, { scope: 'device', userId: req.user.id }).fill;
      if (copy && kind === 'wall') {
        const member = db.prepare('SELECT id FROM devices WHERE wall_id = ? LIMIT 1').get(scopeId);
        if (member) return fills.ensureFillForDevice(db, member.id, s.slot, { scope: 'device', userId: req.user.id }).fill;
      }
      if (copy && kind === 'group') {
        return fills.ensureGroupFill(db, { id: scopeId, workspace_id: sc.ws }, s.slot, { userId: req.user.id }).fill;
      }
      return fills.createFill(db, { slot: s.slot, workspaceId: sc.ws, scopeKind: kind, scopeId, userId: req.user.id }).fill;
    });
    auditCorp(req, 'corporate.fill.create', { organization_id: org.id, slot_id: s.slot.id, fill_id: result.id, workspace_id: sc.ws, scope_kind: kind, scope_id: scopeId, screens_changed: changed.length });
    res.status(201).json({ ...fillView(result), screens_changed: changed.length });
  });

  function loadFill(req, res, org) {
    const f = db.prepare(`SELECT f.*, s.organization_id, s.playlist_id AS corporate_playlist_id, s.name AS slot_name
                            FROM corporate_slot_fills f JOIN corporate_slots s ON s.id = f.slot_id WHERE f.id = ?`).get(req.params.id);
    if (!f || f.organization_id !== org.id) { res.status(404).json({ error: 'Not found' }); return null; }
    return f;
  }

  router.get('/slots/:id/fills', (req, res) => {
    const org = loadOrg(req, res);
    if (!org) return;
    const s = loadSlot(req, res, org);
    if (!s) return;
    const hq = canReadHq(req, org);
    const rows = db.prepare('SELECT * FROM corporate_slot_fills WHERE slot_id = ? ORDER BY workspace_id, scope_kind').all(s.slot.id)
      .filter((f) => hq || wsRead(req, f.workspace_id));
    res.json({ slot: slotView(s.slot), fills: rows.map(fillView) });
  });

  router.put('/fills/:id', (req, res) => {
    const org = loadOrg(req, res);
    if (!org) return;
    if (!requireAvailable(res)) return;
    const f = loadFill(req, res, org);
    if (!f) return;
    const access = wsWrite(req, f.workspace_id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const target = String((req.body && req.body.fill_playlist_id) || '');
    if (!target) return res.status(400).json({ error: 'fill_playlist_id required' });
    if (target !== f.fill_playlist_id) {
      const why = adoptable(target, f.workspace_id);
      if (why) return res.status(400).json({ error: why });
    }
    const { changed } = fanout.withCompositionDiff(req, f.corporate_playlist_id, () => {
      db.prepare("UPDATE corporate_slot_fills SET fill_playlist_id = ?, fill_state = 'ok', updated_at = strftime('%s','now') WHERE id = ?").run(target, f.id);
      const slot = fills.slotRow(db, f.slot_id);
      const t = fills.publishedTotals(db, target);
      if (slot && t.published && fillViolation(t.items_list, fills.limitsFor(db, slot), { slotName: slot.name })) {
        fills.setFillStates(db, [[{ ...f, fill_state: 'ok' }, 'over_limit']], 'repointed');
      }
    });
    const row = db.prepare('SELECT * FROM corporate_slot_fills WHERE id = ?').get(f.id);
    auditCorp(req, 'corporate.fill.repoint', { organization_id: org.id, fill_id: f.id, workspace_id: f.workspace_id, before: f.fill_playlist_id, after: target, screens_changed: changed.length });
    res.json({ ...fillView(row), screens_changed: changed.length });
  });

  router.delete('/fills/:id', (req, res) => {
    const org = loadOrg(req, res);
    if (!org) return;
    if (!requireAvailable(res)) return;
    const f = loadFill(req, res, org);
    if (!f) return;
    const access = wsWrite(req, f.workspace_id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const label = fills.scopeLabel(db, f.scope_kind, f.scope_id);
    const { result, changed } = fanout.withCompositionDiff(req, f.corporate_playlist_id, () => fills.deleteFill(db, f, { userId: req.user.id }));
    auditCorp(req, 'corporate.fill.delete', { organization_id: org.id, fill_id: f.id, slot_id: f.slot_id, workspace_id: f.workspace_id, scope_kind: f.scope_kind, scope_id: f.scope_id, screens_changed: changed.length });
    res.json({ success: true, scope_label: label, playlist_deleted: result.playlistDeleted, screens_changed: changed.length });
  });

  /* ── previews ─────────────────────────────────────────────────────────────────────────────── */

  /** One preview row: what plays, how long, and why it is there. */
  function previewRows(items, slotNames, fillLabels) {
    return items.map((a) => {
      const tag = a.__tag || { kind: 'corporate' };
      return {
        content_id: a.content_id || null, widget_id: a.widget_id || null, filename: a.filename || a.widget_name || null,
        mime_type: a.mime_type || null, thumbnail_path: a.thumbnail_path || null, duration_sec: a.duration_sec || null,
        seconds: Math.round(effectiveSeconds(a)), zone_id: a.zone_id || null,
        tag: tag.kind, slot_id: tag.slot_id || null, slot_name: tag.slot_id ? slotNames.get(tag.slot_id) || null : null,
        level_label: tag.kind === 'slot' && tag.slot_id ? fillLabels.get(tag.slot_id) || null : null,
      };
    });
  }

  /**
   * The annotated composition for a device (used by /preview and the fill draft preview).
   * @returns {{items, slots, total_sec}}
   */
  function explainForDevice(deviceId, playlistId, { overrides = null, composable = null } = {}) {
    const deviceFills = resolve.fillsForDevice(db, deviceId, playlistId);
    const r = composition.explain(db, playlistId, deviceFills, { overrides, composable });
    const slotIds = [...new Set(r.slots.map((x) => x.slot_id))];
    const slotNames = new Map(slotIds.length ? db.prepare(`SELECT id, name FROM corporate_slots WHERE id IN (${slotIds.map(() => '?').join(',')})`).all(...slotIds).map((x) => [x.id, x.name]) : []);
    const fillLabels = new Map();
    for (const [slotId, f] of deviceFills) fillLabels.set(slotId, fills.scopeLabel(db, f.scope_kind, f.scope_id));
    if (overrides) for (const [slotId, o] of overrides) fillLabels.set(slotId, o.label || fillLabels.get(slotId) || null);
    const rows = previewRows(r.items, slotNames, fillLabels);
    return {
      items: rows,
      slots: r.slots.map((x) => ({ ...x, name: slotNames.get(x.slot_id) || null, level_label: x.outcome === 'fill' ? fillLabels.get(x.slot_id) || null : null })),
      total_sec: rows.reduce((t, i) => t + (i.seconds || 0), 0),
      playback_order: r.playback_order,
    };
  }
  h.explainForDevice = explainForDevice;

  router.get('/fills/:id/preview', (req, res) => {
    const org = loadOrg(req, res);
    if (!org) return;
    const f = loadFill(req, res, org);
    if (!f) return;
    if (!wsRead(req, f.workspace_id) && !canReadHq(req, org)) return res.status(403).json({ error: 'Access denied' });
    let deviceId = req.query && req.query.device_id ? String(req.query.device_id) : null;
    const inScope = fills.devicesInFillScope(db, f);
    if (deviceId && !inScope.includes(deviceId)) return res.status(400).json({ error: 'That screen does not play head office\'s playlist within this slot content\'s level' });
    if (!deviceId) deviceId = fills.screensForFill(db, f)[0] || inScope[0] || null;
    const { buildSnapshotItems } = require('./playlists');
    const draft = buildSnapshotItems(f.fill_playlist_id);
    const overrides = new Map([[f.slot_id, { items: draft, workspace_id: f.workspace_id, fill_id: f.id, label: fills.scopeLabel(db, f.scope_kind, f.scope_id) }]]);
    const slot = fills.slotRow(db, f.slot_id);
    const v = slot ? fillViolation(draft, fills.limitsFor(db, slot), { slotName: slot.name }) : null;
    const totals = fillTotals(draft);
    if (!deviceId) {
      // No screen plays it yet: compose head office's loop with only this slot filled.
      const r = composition.explain(db, f.corporate_playlist_id, new Map(), { overrides: new Map([[f.slot_id, { items: draft, workspace_id: f.workspace_id }]]) });
      return res.json({ device_id: null, items: previewRows(r.items, new Map([[f.slot_id, f.slot_name]]), new Map([[f.slot_id, fills.scopeLabel(db, f.scope_kind, f.scope_id)]])), slots: r.slots, draft_totals: totals, violation: v ? { code: v.code, error: guard.err(v.code, v.vars).message } : null });
    }
    res.json({ device_id: deviceId, ...explainForDevice(deviceId, f.corporate_playlist_id, { overrides }), draft_totals: totals, violation: v ? { code: v.code, error: guard.err(v.code, v.vars).message } : null });
  });

  /* ── the store face (§7.7) ────────────────────────────────────────────────────────────────── */

  router.get('/store', (req, res) => {
    const org = loadOrg(req, res);
    if (!org) return;
    const ws = req.workspaceId;
    if (!ws || !wsRead(req, ws)) return res.status(403).json({ error: 'Access denied' });
    const playing = new Map();
    if (runtime.active(db)) {
      for (const r of db.prepare(`SELECT r.playlist_id, COUNT(*) AS n, MAX(p.name) AS name FROM devices d
          JOIN device_resolved_playlist r ON r.device_id = d.id LEFT JOIN playlists p ON p.id = r.playlist_id
         WHERE d.workspace_id = ? AND r.source = 'corporate' GROUP BY r.playlist_id`).all(ws)) {
        playing.set(r.playlist_id || '__dark__', { playlist_id: r.playlist_id || null, playlist_name: r.playlist_id ? r.name : null, dark: !r.playlist_id, screens: r.n });
      }
    }
    const slots = [];
    for (const p of playing.values()) {
      if (!p.playlist_id) continue;
      // Head office's items, read-only, for the strip on the store page.
      const pl = db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(p.playlist_id);
      let strip = [];
      try { strip = JSON.parse((pl && pl.published_snapshot) || '[]'); } catch (_) { strip = []; }
      p.items = strip.slice(0, 50).map((a) => ({ content_id: a.content_id || null, widget_id: a.widget_id || null, filename: a.filename || a.widget_name || null, mime_type: a.mime_type || null, locked: true }));
      for (const slot of fills.liveSlots(db, p.playlist_id)) {
        const v = slotView(slot);
        v.playlist_name = p.playlist_name;
        v.limits = v.live_limits || v.limits;
        v.fills = db.prepare('SELECT * FROM corporate_slot_fills WHERE slot_id = ? AND workspace_id = ? ORDER BY scope_kind').all(slot.id, ws).map(fillView);
        slots.push(v);
      }
    }
    res.json({ workspace_id: ws, mandates: [...playing.values()], slots });
  });

  /* ── compliance and airtime (§7.5) ────────────────────────────────────────────────────────── */

  function requireReporter(req, res, org) {
    if (req.viaToken) { refuse(res, 'CORPORATE_TOKEN'); return false; }
    if (!guard.isOrgAdmin(req, org.id) && !guard.canAuthor(req, org.id)) { refuse(res, 'CORPORATE_ADMIN_REQUIRED'); return false; }
    return true;
  }

  router.get('/reports/slots', (req, res) => {
    const org = loadOrg(req, res);
    if (!org) return;
    if (!requireReporter(req, res, org)) return;
    const rows = [];
    const corporate = db.prepare(`SELECT p.id, p.name FROM playlists p JOIN workspaces w ON w.id = p.workspace_id
                                   WHERE p.corporate = 1 AND w.organization_id = ? ORDER BY p.name`).all(org.id);
    for (const p of corporate) {
      const slots = fills.liveSlots(db, p.id);
      if (!slots.length) continue;
      const markers = resolve.publishedMarkers(db, p.id);
      const sigs = resolve.signaturesForPlaylist(db, p.id);
      const byWs = new Map();
      for (const [, d] of sigs) {
        if (!byWs.has(d.workspace_id)) byWs.set(d.workspace_id, []);
        byWs.get(d.workspace_id).push(d);
      }
      for (const slot of slots) {
        const hasFallback = !!(markers.get(slot.id) && markers.get(slot.id).fallback);
        for (const [wsId, devs] of byWs) {
          const wsRow = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(wsId) || {};
          const wsFills = db.prepare('SELECT * FROM corporate_slot_fills WHERE slot_id = ? AND workspace_id = ?').all(slot.id, wsId);
          const filled = devs.filter((d) => d.fills.has(slot.id)).length;
          const over = wsFills.filter((f) => f.fill_state === 'over_limit');
          const state = over.length ? 'over_limit' : filled === devs.length ? 'filled' : filled ? 'partly_filled' : hasFallback ? 'fallback' : 'skipped';
          rows.push({
            playlist_id: p.id, playlist_name: p.name, slot_id: slot.id, slot_name: slot.name,
            workspace_id: wsId, workspace_name: wsRow.name || null, screens: devs.length, screens_filled: filled,
            state, fills: wsFills.map(fillView),
          });
        }
      }
    }
    const problems = req.query && (req.query.problems === '1' || req.query.problems === 'true');
    const out = problems ? rows.filter((r) => r.state !== 'filled') : rows;
    if (req.query && req.query.format === 'csv') {
      const esc = (v) => { const t = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
      const lines = [['playlist', 'slot', 'workspace', 'screens', 'screens_filled', 'state', 'levels'].join(',')];
      for (const r of out) lines.push([r.playlist_name, r.slot_name, r.workspace_name, r.screens, r.screens_filled, r.state, r.fills.map((f) => `${f.scope_label}: ${f.items} items/${f.seconds}s (${f.fill_state})`).join('; ')].map(esc).join(','));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="store-slots.csv"');
      return res.send(lines.join('\n') + '\n');
    }
    res.json({ rows: out });
  });

  /*
   * Corporate airtime: plays and seconds of HEAD OFFICE's content on the org's screens. play_logs are
   * attributed to the store workspace (deviceSocket logs the device's workspace), so no store-side
   * report can show this; joining on the content's workspace = HQ does, with no schema change.
   */
  router.get('/reports/plays', (req, res) => {
    const org = loadOrg(req, res);
    if (!org) return;
    if (!requireReporter(req, res, org)) return;
    if (!org.hq_workspace_id) return res.json({ from: null, to: null, workspaces: [], playlists: [] });
    const now = Math.floor(Date.now() / 1000);
    const to = int(req.query && req.query.to) || now;
    const from = int(req.query && req.query.from) || (to - 7 * 86400);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return res.status(400).json({ error: 'from must be before to (unix seconds)' });
    const workspaces = db.prepare(`
      SELECT d.workspace_id, w.name AS workspace_name, COUNT(*) AS plays, COALESCE(SUM(pl.duration_sec), 0) AS seconds
        FROM play_logs pl JOIN devices d ON d.id = pl.device_id JOIN workspaces w ON w.id = d.workspace_id
        JOIN content c ON c.id = pl.content_id
       WHERE w.organization_id = ? AND c.workspace_id = ? AND pl.started_at >= ? AND pl.started_at <= ?
       GROUP BY d.workspace_id ORDER BY w.name`).all(org.id, org.hq_workspace_id, from, to);
    const playlists = [];
    for (const p of db.prepare(`SELECT id, name, published_composable, published_snapshot FROM playlists WHERE workspace_id = ? AND corporate = 1`).all(org.hq_workspace_id)) {
      let list = [];
      try { list = JSON.parse(p.published_composable || p.published_snapshot || '[]'); } catch (_) { list = []; }
      const ids = [...new Set(list.flatMap((el) => [el && el.content_id, el && el.__slot && el.fallback && el.fallback.content_id]).filter(Boolean))];
      if (!ids.length) { playlists.push({ playlist_id: p.id, playlist_name: p.name, plays: 0, seconds: 0 }); continue; }
      const r = db.prepare(`SELECT COUNT(*) AS plays, COALESCE(SUM(pl.duration_sec), 0) AS seconds FROM play_logs pl
          JOIN devices d ON d.id = pl.device_id JOIN workspaces w ON w.id = d.workspace_id
         WHERE w.organization_id = ? AND pl.content_id IN (${ids.map(() => '?').join(',')}) AND pl.started_at >= ? AND pl.started_at <= ?`)
        .get(org.id, ...ids, from, to);
      playlists.push({ playlist_id: p.id, playlist_name: p.name, plays: r.plays, seconds: r.seconds });
    }
    res.json({ from, to, workspaces, playlists, note: 'A content item used by more than one corporate playlist counts towards each.' });
  });
}

module.exports = { register };
