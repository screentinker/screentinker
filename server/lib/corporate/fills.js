'use strict';

/*
 * Local slots and the store content that fills them (spec §1.2, §4.3).
 *
 * A FILL is an ordinary flat playlist in the STORE's workspace, linked to one slot of head office's
 * playlist at one level: the whole workspace, a group, a video wall or one screen. Stores edit it in
 * the normal playlist editor — draft/publish, approvals, dayparts and revisions all apply unchanged
 * — and the composition (lib/corporate/composition.js) splices its PUBLISHED snapshot into head
 * office's loop. Nearest fill wins per slot (lib/corporate/resolve.js).
 *
 * ⚠️ Making a narrower fill COPIES the wider one (items, item schedules, published snapshot, status),
 * exactly like forkInheritedPlaylist copies an inherited playlist: the screen's composed loop is
 * byte-identical the moment the fill is made, so nothing restarts and nothing disappears until the
 * store actually changes it (critique U1: "Only this screen" must never blank the slot).
 *
 * A fill is CONSTRAINED, not governed: flat (no nested playlists — the backstop's FILL_FLAT trigger
 * holds that for every writer), only bounded-length media, and within head office's limits.
 * assertFillItems is the early check at every add path; publishPlaylist runs the authoritative one.
 */

const { v4: uuidv4 } = require('uuid');
const resolve = require('./resolve');
const { fillViolation, fillTotals } = require('./compose');

function dbOf() { return require('../../db/database').db; }
function guard() { return require('./guard'); }

const q = (s) => `"${s || ''}"`;

/* ── Slots ───────────────────────────────────────────────────────────────────────────────────── */

function slotRow(db, slotId) {
  if (!slotId) return null;
  try { return db.prepare('SELECT * FROM corporate_slots WHERE id = ?').get(slotId) || null; } catch (_) { return null; }
}

function limitsOfRow(s) {
  return {
    max_items: s.max_items == null ? null : s.max_items,
    max_total_sec: s.max_total_sec == null ? null : s.max_total_sec,
    allow_video: s.allow_video === 0 ? 0 : 1,
    allow_widgets: s.allow_widgets === 0 ? 0 : 1,
  };
}

/**
 * The limits stores are held to: the PUBLISHED ones (the slot marker in head office's published
 * composable), because slot edits take effect on the next corporate publish (R19). A slot that is
 * not published yet falls back to its row.
 */
function limitsFor(db, slot) {
  const m = resolve.publishedMarkers(db, slot.playlist_id).get(slot.id);
  return m && m.limits ? m.limits : limitsOfRow(slot);
}

/**
 * Slots a screen can fill today: placed in the corporate playlist's PUBLISHED version, in loop order.
 * A slot removed in head office's draft is still live until that draft is published (R19).
 */
function liveSlots(db, playlistId) {
  const markers = resolve.publishedMarkers(db, playlistId);
  if (!markers.size) return [];
  const rows = db.prepare(`SELECT * FROM corporate_slots WHERE playlist_id = ?
                            AND id IN (${[...markers.keys()].map(() => '?').join(',')})`).all(playlistId, ...markers.keys());
  const byId = new Map(rows.map((r) => [r.id, r]));
  return [...markers.keys()].map((id) => byId.get(id)).filter(Boolean);
}

/* ── Labels (D14: name the level literally, never "this store") ─────────────────────────────── */

function scopeLabel(db, kind, id) {
  try {
    if (kind === 'workspace') return `Everyone in ${q(db.prepare('SELECT name FROM workspaces WHERE id = ?').get(id)?.name)}`;
    if (kind === 'group') return `Group ${q(db.prepare('SELECT name FROM device_groups WHERE id = ?').get(id)?.name)}`;
    if (kind === 'wall') return `Video wall ${q(db.prepare('SELECT name FROM video_walls WHERE id = ?').get(id)?.name)}`;
    if (kind === 'device') return `Screen ${q(db.prepare('SELECT name FROM devices WHERE id = ?').get(id)?.name)}`;
  } catch (_) { /* fall through */ }
  return kind;
}

/** The bare name of a level (workspace, group, wall or screen), for a UI that words the label itself. */
function scopeName(db, kind, id) {
  const table = { workspace: 'workspaces', group: 'device_groups', wall: 'video_walls', device: 'devices' }[kind];
  if (!table) return null;
  try { return (db || dbOf()).prepare(`SELECT name FROM ${table} WHERE id = ?`).get(id)?.name || null; } catch (_) { return null; }
}

/* ── Who plays a fill ────────────────────────────────────────────────────────────────────────── */

/** Mandated screens on the fill's corporate playlist inside the fill's scope (whatever they pick). */
function devicesInFillScope(db, fill) {
  db = db || dbOf();
  const slot = slotRow(db, fill.slot_id);
  if (!slot) return [];
  const sigs = resolve.signaturesForPlaylist(db, slot.playlist_id);
  if (!sigs.size) return [];
  let groupMembers = null;
  if (fill.scope_kind === 'group') {
    groupMembers = new Set(db.prepare('SELECT device_id FROM device_group_members WHERE group_id = ?').all(fill.scope_id).map((r) => r.device_id));
  }
  const out = [];
  for (const [id, d] of sigs) {
    if (d.workspace_id !== fill.workspace_id) continue;
    const ok = fill.scope_kind === 'workspace' ? fill.scope_id === d.workspace_id
      : fill.scope_kind === 'wall' ? d.wall_id === fill.scope_id
      : fill.scope_kind === 'device' ? !d.wall_id && id === fill.scope_id
      : fill.scope_kind === 'group' ? !d.wall_id && groupMembers.has(id) : false;
    if (ok) out.push(id);
  }
  return out;
}

/** Screens whose nearest fill for the slot IS this one (published or not): what an edit to it reaches. */
function screensForFill(db, fill) {
  db = db || dbOf();
  const slot = slotRow(db, fill.slot_id);
  if (!slot) return [];
  return devicesInFillScope(db, fill).filter((id) => {
    const f = resolve.fillsForDevice(db, id, slot.playlist_id, { anyState: true }).get(slot.id);
    return f && f.fillId === fill.id;
  });
}

/** Screens playing a fill RIGHT NOW (their signature names it). */
function devicesPlayingFill(db, fillPlaylistId) {
  db = db || dbOf();
  const out = new Set();
  let rows = [];
  try {
    rows = db.prepare(`SELECT DISTINCT s.playlist_id FROM corporate_slot_fills f JOIN corporate_slots s ON s.id = f.slot_id
                        WHERE f.fill_playlist_id = ?`).all(fillPlaylistId);
  } catch (_) { return []; }
  for (const r of rows) {
    for (const [id, d] of resolve.signaturesForPlaylist(db, r.playlist_id)) {
      for (const f of d.fills.values()) if (f.playlistId === fillPlaylistId) { out.add(id); break; }
    }
  }
  return [...out];
}

/* ── Making, copying and removing fills ──────────────────────────────────────────────────────── */

/** Copy every item (and its dayparts) of one playlist into another. @returns Map<srcItemId, newItemId> */
function copyItems(db, srcId, dstId) {
  const map = new Map();
  if (!srcId) return map;
  const items = db.prepare(`SELECT id, content_id, widget_id, zone_id, sort_order, duration_sec, muted, play_from, play_until,
                                   enabled, log_play, fit_mode, play_when, weight, repeat_every_sec
                              FROM playlist_items WHERE playlist_id = ? AND child_playlist_id IS NULL AND slot_id IS NULL
                             ORDER BY sort_order ASC, id ASC`).all(srcId);
  const ins = db.prepare(`INSERT INTO playlist_items
      (playlist_id, content_id, widget_id, zone_id, sort_order, duration_sec, muted, play_from, play_until, enabled, log_play, fit_mode, play_when, weight, repeat_every_sec)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const scheds = db.prepare('SELECT active_days, start_time, end_time, start_date, end_date, sort_order FROM playlist_item_schedules WHERE playlist_item_id = ?');
  const insSched = db.prepare(`INSERT INTO playlist_item_schedules (id, playlist_item_id, active_days, start_time, end_time, start_date, end_date, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const it of items) {
    const r = ins.run(dstId, it.content_id, it.widget_id, it.zone_id, it.sort_order, it.duration_sec, it.muted ? 1 : 0,
      it.play_from || null, it.play_until || null, it.enabled === 0 ? 0 : 1, it.log_play === 0 ? 0 : 1, it.fit_mode || null,
      it.play_when || null, it.weight || 1, it.repeat_every_sec || null);
    map.set(it.id, r.lastInsertRowid);
    for (const s of scheds.all(it.id)) insSched.run(uuidv4(), r.lastInsertRowid, s.active_days, s.start_time, s.end_time, s.start_date, s.end_date, s.sort_order);
  }
  return map;
}

/**
 * Create a fill row and its playlist. `copyFromPlaylistId` (a wider fill) is copied wholesale —
 * items, schedules, published snapshot/structure, status, published_rev — so the screens it reaches
 * compose byte-identically and nothing restarts.
 * @returns {{fill, itemIdMap}}
 */
function createFill(db, { slot, workspaceId, scopeKind, scopeId, userId, copyFromPlaylistId = null }) {
  db = db || dbOf();
  const id = uuidv4();
  const playlistId = uuidv4();
  const label = scopeLabel(db, scopeKind, scopeId);
  const src = copyFromPlaylistId
    ? db.prepare('SELECT status, published_snapshot, published_structure, published_rev FROM playlists WHERE id = ?').get(copyFromPlaylistId)
    : null;
  let itemIdMap = new Map();
  db.transaction(() => {
    db.prepare(`INSERT INTO playlists (id, user_id, workspace_id, name, description, status, published_snapshot, published_structure, published_rev)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(playlistId, userId || null, workspaceId, `${slot.name} — ${label.replace(/"/g, '')}`.slice(0, 200),
        'Your content for head office\'s local slot. Stores can change this; head office sets its limits.',
        src ? src.status || 'draft' : 'draft', src ? src.published_snapshot : null, src ? src.published_structure : null, src ? src.published_rev || 0 : 0);
    if (src) itemIdMap = copyItems(db, copyFromPlaylistId, playlistId);
    db.prepare(`INSERT INTO corporate_slot_fills (id, slot_id, workspace_id, scope_kind, scope_id, fill_playlist_id, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, slot.id, workspaceId, scopeKind, scopeId, playlistId, userId || null);
  })();
  const fill = db.prepare('SELECT * FROM corporate_slot_fills WHERE id = ?').get(id);
  try {
    require('../audit').audit('corporate.fill.create', { userId: userId || null, workspaceId, details: { fill_id: id, slot_id: slot.id, scope_kind: scopeKind, scope_id: scopeId, fill_playlist_id: playlistId, copied_from: copyFromPlaylistId } });
  } catch (_) { /* never */ }
  return { fill, itemIdMap };
}

function fillAt(db, slotId, scopeKind, scopeId) {
  return db.prepare('SELECT * FROM corporate_slot_fills WHERE slot_id = ? AND scope_kind = ? AND scope_id = ?').get(slotId, scopeKind, scopeId) || null;
}

/** The fill a device would edit for this slot: the nearest one in any state (unpublished included). */
function nearestFill(db, deviceId, slot) {
  const f = resolve.fillsForDevice(db, deviceId, slot.playlist_id, { anyState: true }).get(slot.id);
  return f ? db.prepare('SELECT * FROM corporate_slot_fills WHERE id = ?').get(f.fillId) : null;
}

/**
 * The fill an add/edit "on this screen" lands in (§4.3).
 *   'nearest' (default) — the fill this screen already plays for the slot, at whatever level; none
 *                         yet -> the workspace-level fill (created).
 *   'device'            — this screen only (its video wall, for a wall member): made by copying the
 *                         nearest fill if it does not exist yet.
 * @returns {{fill, created: boolean, itemIdMap: Map}}
 */
function ensureFillForDevice(db, deviceId, slot, { scope = 'nearest', userId = null } = {}) {
  db = db || dbOf();
  const d = db.prepare('SELECT id, workspace_id, wall_id FROM devices WHERE id = ?').get(deviceId);
  if (!d) return null;
  const near = nearestFill(db, deviceId, slot);
  if (scope === 'device') {
    const kind = d.wall_id ? 'wall' : 'device';
    const sid = d.wall_id || d.id;
    const existing = fillAt(db, slot.id, kind, sid);
    if (existing) return { fill: existing, created: false, itemIdMap: new Map() };
    const r = createFill(db, { slot, workspaceId: d.workspace_id, scopeKind: kind, scopeId: sid, userId, copyFromPlaylistId: near ? near.fill_playlist_id : null });
    return { ...r, created: true };
  }
  if (near) return { fill: near, created: false, itemIdMap: new Map() };
  const ws = fillAt(db, slot.id, 'workspace', d.workspace_id);
  if (ws) return { fill: ws, created: false, itemIdMap: new Map() };
  const r = createFill(db, { slot, workspaceId: d.workspace_id, scopeKind: 'workspace', scopeId: d.workspace_id, userId });
  return { ...r, created: true };
}

/** The group-level fill (made by copying the workspace fill, so nothing disappears). */
function ensureGroupFill(db, group, slot, { userId = null } = {}) {
  db = db || dbOf();
  const existing = fillAt(db, slot.id, 'group', group.id);
  if (existing) return { fill: existing, created: false };
  const ws = fillAt(db, slot.id, 'workspace', group.workspace_id);
  const r = createFill(db, { slot, workspaceId: group.workspace_id, scopeKind: 'group', scopeId: group.id, userId, copyFromPlaylistId: ws ? ws.fill_playlist_id : null });
  return { fill: r.fill, created: true };
}

/** Is a playlist used for anything other than this fill? (Then removing the fill keeps it.) */
function playlistReferencedElsewhere(db, playlistId, fillId) {
  const checks = [
    ['SELECT 1 FROM devices WHERE playlist_id = ? OR scheduled_playlist_id = ? LIMIT 1', 2],
    ['SELECT 1 FROM device_groups WHERE playlist_id = ? LIMIT 1', 1],
    ['SELECT 1 FROM video_walls WHERE playlist_id = ? LIMIT 1', 1],
    ['SELECT 1 FROM schedules WHERE playlist_id = ? LIMIT 1', 1],
    ['SELECT 1 FROM playlist_items WHERE child_playlist_id = ? LIMIT 1', 1],
    ["SELECT 1 FROM triggers WHERE target_kind = 'playlist' AND target_ref = ? LIMIT 1", 1],
    ['SELECT 1 FROM slide_decks WHERE playlist_id = ? LIMIT 1', 1],
  ];
  for (const [sql, n] of checks) {
    try { if (db.prepare(sql).get(...Array(n).fill(playlistId))) return true; } catch (_) { /* table absent */ }
  }
  try {
    if (db.prepare('SELECT 1 FROM corporate_slot_fills WHERE fill_playlist_id = ? AND id != ? LIMIT 1').get(playlistId, fillId)) return true;
  } catch (_) { /* table absent */ }
  return false;
}

/** Remove a fill; its playlist too unless something else uses it. @returns {{playlistDeleted}} */
function deleteFill(db, fill, { userId = null } = {}) {
  db = db || dbOf();
  const keep = playlistReferencedElsewhere(db, fill.fill_playlist_id, fill.id);
  db.transaction(() => {
    db.prepare('DELETE FROM corporate_slot_fills WHERE id = ?').run(fill.id);
    if (!keep) db.prepare('DELETE FROM playlists WHERE id = ?').run(fill.fill_playlist_id);
  })();
  try {
    require('../audit').audit('corporate.fill.delete', { userId, workspaceId: fill.workspace_id, details: { fill_id: fill.id, slot_id: fill.slot_id, scope_kind: fill.scope_kind, scope_id: fill.scope_id, playlist_deleted: !keep } });
  } catch (_) { /* never */ }
  return { playlistDeleted: !keep };
}

/* ── Limits ──────────────────────────────────────────────────────────────────────────────────── */

/** Snapshot-shaped view of a fill's DRAFT rows (enough for fillViolation / fillTotals). */
function draftItems(db, playlistId) {
  return db.prepare(`SELECT pi.id, pi.content_id, pi.widget_id, pi.child_playlist_id, pi.slot_id, pi.duration_sec,
                            c.mime_type, c.duration_sec AS content_duration, COALESCE(c.filename, w.name) AS filename
                       FROM playlist_items pi LEFT JOIN content c ON c.id = pi.content_id LEFT JOIN widgets w ON w.id = pi.widget_id
                      WHERE pi.playlist_id = ? AND COALESCE(pi.enabled, 1) = 1 ORDER BY pi.sort_order ASC`).all(playlistId);
}

/** The same shape for an item that is about to be added. */
function itemShape(db, { content_id = null, widget_id = null, child_playlist_id = null, duration_sec = null }) {
  const out = { content_id, widget_id, child_playlist_id, duration_sec };
  if (content_id) {
    const c = db.prepare('SELECT mime_type, duration_sec, filename FROM content WHERE id = ?').get(content_id);
    if (c) { out.mime_type = c.mime_type; out.content_duration = c.duration_sec; out.filename = c.filename; }
  }
  if (widget_id) {
    const w = db.prepare('SELECT name FROM widgets WHERE id = ?').get(widget_id);
    if (w) out.filename = w.name;
  }
  return out;
}

/** Every fill row whose playlist this is (normally one). */
function fillsOfPlaylist(db, playlistId) {
  try {
    return db.prepare(`SELECT f.*, s.name AS slot_name, s.playlist_id AS corporate_playlist_id FROM corporate_slot_fills f
                         JOIN corporate_slots s ON s.id = f.slot_id WHERE f.fill_playlist_id = ?`).all(playlistId);
  } catch (_) { return []; }
}

/** First rule this list would break as a fill of `playlistId`, or null (also null when not a fill). */
function violationFor(db, playlistId, items) {
  for (const f of fillsOfPlaylist(db, playlistId)) {
    const slot = slotRow(db, f.slot_id);
    if (!slot) continue;
    const v = fillViolation(items, limitsFor(db, slot), { slotName: slot.name });
    if (v) return { ...v, fill: f, slot };
  }
  return null;
}

/**
 * Throw the FILL_* refusal if `proposed` (snapshot-shaped rows after the change) breaks the rules
 * of the slot this playlist fills. A no-op for any playlist that is not a fill.
 */
function assertFillItems(db, playlistId, proposed) {
  db = db || dbOf();
  const v = violationFor(db, playlistId, proposed);
  if (!v) return;
  throw guard().err(v.code, v.vars, { slot_id: v.slot.id, fill_id: v.fill.id, limits: limitsFor(db, v.slot) });
}

/** Early check for an add path: the fill's current draft plus the new items. */
function assertCanAdd(db, playlistId, newItems) {
  db = db || dbOf();
  if (!fillsOfPlaylist(db, playlistId).length) return;
  assertFillItems(db, playlistId, [...draftItems(db, playlistId), ...newItems.map((it) => itemShape(db, it))]);
}

/**
 * Fill publish: judge the snapshot about to go live. An actor (a person, a token) is refused with
 * the rule's message; system work (content expiry, an ancestor republish) is not refused but the
 * fill is marked over_limit so it stops playing rather than breaking the limit. Passing -> 'ok'.
 */
function judgePublish(db, playlistId, snapshotItems, { actorPresent }) {
  db = db || dbOf();
  const fills = fillsOfPlaylist(db, playlistId);
  if (!fills.length) return;
  const v = violationFor(db, playlistId, snapshotItems);
  if (v && actorPresent) throw guard().err(v.code, v.vars, { slot_id: v.slot.id, fill_id: v.fill.id, limits: limitsFor(db, v.slot) });
  setFillStates(db, fills.map((f) => {
    const slot = slotRow(db, f.slot_id);
    const bad = slot && fillViolation(snapshotItems, limitsFor(db, slot), { slotName: slot.name });
    return [f, bad ? 'over_limit' : 'ok'];
  }), 'publish');
}

/** Write fill states; audit each one that starts or stops being over the limit. */
function setFillStates(db, pairs, reason) {
  const changed = [];
  for (const [f, state] of pairs) {
    if (f.fill_state === state) continue;
    db.prepare("UPDATE corporate_slot_fills SET fill_state = ?, updated_at = strftime('%s','now') WHERE id = ?").run(state, f.id);
    changed.push({ ...f, fill_state: state });
    try {
      require('../audit').audit(state === 'over_limit' ? 'corporate.fill.over_limit' : 'corporate.fill.ok', {
        userId: null, workspaceId: f.workspace_id, details: { fill_id: f.id, slot_id: f.slot_id, reason },
      });
    } catch (_) { /* never */ }
  }
  return changed;
}

/** Totals of a fill's published snapshot (for meters, the compliance report and the impact list). */
function publishedTotals(db, fillPlaylistId) {
  const r = db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(fillPlaylistId);
  let items = [];
  try { items = r && r.published_snapshot ? JSON.parse(r.published_snapshot) : []; } catch (_) { items = []; }
  return { ...fillTotals(items), published: !!(r && r.published_snapshot), items_list: items };
}

/* ── The add redirect (§4.3) ─────────────────────────────────────────────────────────────────── */

/**
 * "Add content to this screen" on a mandated screen goes into the screen's slot content.
 * @returns {{slot, fill, created, itemIdMap}} or throws CORPORATE_NO_SLOT / CORPORATE_SLOT_REQUIRED.
 */
function redirectTarget(db, mandate, deviceId, { slotId = null, scope = 'nearest', userId = null } = {}) {
  db = db || dbOf();
  const g = guard();
  const vars = { name: mandate.dark ? 'Turned off by head office' : mandate.playlist_name };
  const details = g.mandateDetails(db, mandate, { device_id: deviceId });
  const slots = mandate.dark || !mandate.playlist_id ? [] : liveSlots(db, mandate.playlist_id);
  if (!slots.length) throw g.err('CORPORATE_NO_SLOT', vars, details);
  let slot = null;
  if (slotId) slot = slots.find((s) => s.id === slotId) || null;
  else if (slots.length === 1) slot = slots[0];
  if (!slot) throw g.err('CORPORATE_SLOT_REQUIRED', vars, { ...details, slots: slots.map((s) => ({ id: s.id, name: s.name })) });
  const r = ensureFillForDevice(db, deviceId, slot, { scope: scope === 'device' ? 'device' : 'nearest', userId });
  return { slot, ...r };
}

/** Describe a fill for a response body (redirected_to / edited_fill). */
function describeFill(db, fill, slot) {
  // Whether the store's content has unpublished changes: an add from a screen lands in the DRAFT,
  // and the device page offers Publish right there rather than sending the store to look for it.
  const pl = (db || dbOf()).prepare('SELECT status, published_snapshot IS NOT NULL AS has_published FROM playlists WHERE id = ?').get(fill.fill_playlist_id) || {};
  return {
    status: pl.status || null,
    has_published: !!pl.has_published,
    slot_id: slot ? slot.id : fill.slot_id,
    slot_name: slot ? slot.name : (slotRow(db, fill.slot_id) || {}).name || null,
    fill_id: fill.id,
    fill_playlist_id: fill.fill_playlist_id,
    scope_kind: fill.scope_kind,
    scope_id: fill.scope_id,
    scope_label: scopeLabel(db, fill.scope_kind, fill.scope_id),
    scope_name: scopeName(db, fill.scope_kind, fill.scope_id),
    screens: screensForFill(db, fill).length,
  };
}

module.exports = {
  slotRow, limitsOfRow, limitsFor, liveSlots, scopeLabel, scopeName,
  devicesInFillScope, devicesPlayingFill, screensForFill,
  copyItems, createFill, fillAt, nearestFill, ensureFillForDevice, ensureGroupFill, deleteFill, playlistReferencedElsewhere,
  draftItems, itemShape, fillsOfPlaylist, violationFor, assertFillItems, assertCanAdd, judgePublish, setFillStates, publishedTotals,
  redirectTarget, describeFill,
};
