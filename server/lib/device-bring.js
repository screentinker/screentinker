'use strict';

/*
 * "Bring its playlist" on a screen move (POST /api/devices/move-workspace, bring_playlist: true).
 *
 * A screen moved to another workspace normally arrives bare: what the old store chose for it stays
 * with the old store (lib/device-move.js). With bring_playlist the things the screen ITSELF uses come
 * along as COPIES in the new workspace, so it keeps playing exactly what it played:
 *   - its own playlist (playlist_source 'device', or an unclassified own id) and the playlists that
 *     playlist nests;
 *   - its own layout (not a template) with the zones, and its default content;
 *   - every content item, widget and kiosk page those reference, found by id;
 *   - the data sources, custom shaders and custom fonts they reference by key (slug, shader id, CSS
 *     family) — REUSED when the new workspace already has one with the same key, copied otherwise.
 *
 * ⚠️ ALWAYS A COPY, NEVER A RE-HOME. Moving the source rows would change the old workspace under
 * whoever else uses them (another screen, a group, a schedule, a trigger, a revision history), and
 * deciding "nobody else uses it" correctly means asking every one of those readers. A copy cannot
 * change the source at all; the original simply stays where it was. The preview says how many others
 * still use it.
 *
 * ⚠️ BYTES ARE SHARED, NOT DUPLICATED — and that is safe because every content deletion goes through
 * lib/content-files.js unlinkIfUnreferenced, which counts the OTHER rows pointing at a file before
 * removing it (the mesh already relies on exactly this: one file backing a row per workspace). A
 * replace writes a new file and refcounts the old one too. Fonts are the exception: their delete
 * unlinks without counting, so a font's file IS copied (after commit, see fileOps).
 *
 * ⚠️ IDS ARE REWRITTEN BY VALUE. Every copied row's JSON (published snapshot, published structure,
 * widget config, play_when, layout draft) has each old uuid replaced by its copy's uuid, so the
 * published snapshot keeps describing the same loop — the screen never blanks and never needs a
 * republish. Columns are copied with PRAGMA table_info, so a column added later travels without
 * anyone remembering this file (the nesting audit lesson: a new column is a duty at every writer).
 *
 * ⚠️ A SMART playlist arrives as an ORDINARY one holding the items it was showing: its rules would
 * run against the NEW workspace's library (folders do not travel) and the next refresh could empty
 * the screen. Said in the preview.
 *
 * Head office playlists and slot content never travel (lib/corporate); neither do group / wall
 * playlists, schedules or triggers — they are not the screen's own.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const OMIT = Symbol('omit');

function uuid() { return crypto.randomUUID(); }

function columns(db, table) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name); } catch (_) { return []; }
}
function tableExists(db, table) { return columns(db, table).length > 0; }

/** INSERT a copy of `row` with `overrides` (OMIT drops a column, e.g. an AUTOINCREMENT id). Positional binds only. */
function copyRow(db, table, row, overrides) {
  const has = (c) => Object.prototype.hasOwnProperty.call(overrides, c);
  // Columns the source row does not carry (and no override names) are left to their DEFAULT.
  const cols = columns(db, table).filter((c) => overrides[c] !== OMIT && (has(c) || row[c] !== undefined));
  const vals = cols.map((c) => (has(c) ? overrides[c] : row[c]));
  return db.prepare(`INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);
}

function uuidsIn(text, out) {
  if (!text) return out;
  const m = String(text).match(UUID_G);
  if (m) for (const u of m) out.add(u.toLowerCase());
  return out;
}

function remap(text, map) {
  if (text == null) return text;
  return String(text).replace(UUID_G, (u) => map.get(u.toLowerCase()) || u);
}

/** The playlist the screen chose for ITSELF in its current workspace, or null. */
function ownPlaylistOf(db, device) {
  if (!device.playlist_id) return null;
  if (device.playlist_source && device.playlist_source !== 'device') return null;
  const p = db.prepare('SELECT * FROM playlists WHERE id = ?').get(device.playlist_id);
  if (!p || p.workspace_id !== device.workspace_id || p.corporate) return null;
  try {
    const g = require('./corporate/guard').governanceOf(db, p.id);
    if (g && g.kind) return null;                    // head office's, or a store's slot content
  } catch (_) { /* no corporate machinery */ }
  return p;
}

function ownLayoutOf(db, device) {
  if (!device.layout_id) return null;
  const l = db.prepare('SELECT * FROM layouts WHERE id = ?').get(device.layout_id);
  if (!l || l.is_template || l.workspace_id !== device.workspace_id) return null;
  return l;
}

/** How many OTHER things in the source workspace still use this playlist (preview wording only). */
function otherUsers(db, playlistId, deviceId) {
  const n = (sql, ...a) => { try { return db.prepare(sql).get(...a).n || 0; } catch (_) { return 0; } };
  return n('SELECT COUNT(*) AS n FROM devices WHERE playlist_id = ? AND id != ?', playlistId, deviceId)
    + n('SELECT COUNT(*) AS n FROM device_groups WHERE playlist_id = ?', playlistId)
    + n('SELECT COUNT(*) AS n FROM video_walls WHERE playlist_id = ?', playlistId)
    + n('SELECT COUNT(*) AS n FROM schedules WHERE playlist_id = ?', playlistId)
    + n("SELECT COUNT(*) AS n FROM triggers WHERE target_ref = ? AND target_kind = 'playlist'", playlistId)
    + n('SELECT COUNT(*) AS n FROM playlist_items WHERE child_playlist_id = ?', playlistId);
}

/*
 * Work out everything that travels with one screen. Pure reads; returns null when the screen has
 * nothing of its own to bring.
 */
function plan(db, device, toWs, { crossOrg = false } = {}) {
  const src = device.workspace_id;
  const own = ownPlaylistOf(db, device);
  const layout = ownLayoutOf(db, device);
  let defaultContent = null;
  if (device.default_content_id) {
    const c = db.prepare('SELECT * FROM content WHERE id = ?').get(device.default_content_id);
    if (c && c.workspace_id === src) defaultContent = c;
  }
  if (!own && !layout && !defaultContent) return null;

  const playlists = new Map();       // id -> row (the screen's own first, then its children)
  const items = new Map();           // playlist id -> item rows
  const content = new Map();
  const widgets = new Map();
  const kiosk = new Map();
  const texts = [];                  // every JSON blob that travels, for the by-key references

  const addPlaylist = (p) => {
    if (!p || playlists.has(p.id) || p.workspace_id !== src || p.corporate) return;
    playlists.set(p.id, p);
    const rows = db.prepare('SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order ASC, id ASC').all(p.id);
    items.set(p.id, rows);
    texts.push(p.published_snapshot, p.published_structure, p.smart_rules, p.published_smart_rules);
    for (const it of rows) texts.push(it.play_when);
  };
  if (own) addPlaylist(own);
  // Children: the draft's references and the published structure's (a child removed from the draft
  // but still published is still on screen — its items are in the flat snapshot either way).
  const childIds = new Set();
  for (const [, rows] of items) for (const it of rows) if (it.child_playlist_id) childIds.add(it.child_playlist_id);
  if (own) uuidsIn(own.published_structure, childIds);
  for (const cid of childIds) {
    const c = db.prepare('SELECT * FROM playlists WHERE id = ?').get(cid);
    if (c && c.workspace_id === src && !c.corporate) addPlaylist(c);
  }
  if (layout) texts.push(layout.draft_zones);
  if (defaultContent) content.set(defaultContent.id, defaultContent);

  // Ids referenced anywhere in what travels, to a fixed point (a widget can name content or a kiosk
  // page; a kiosk page can name content).
  const seen = new Set();
  const scan = (text) => {
    for (const u of uuidsIn(text, new Set())) {
      if (seen.has(u)) continue;
      seen.add(u);
      const c = db.prepare('SELECT * FROM content WHERE id = ?').get(u);
      if (c) { if (c.workspace_id === src) content.set(c.id, c); continue; }   // NULL workspace = template: referenced
      const w = db.prepare('SELECT * FROM widgets WHERE id = ?').get(u);
      if (w) { if (w.workspace_id === src && !widgets.has(w.id)) { widgets.set(w.id, w); texts.push(w.config, w.draft_config); scan(w.config); scan(w.draft_config); } continue; }
      if (tableExists(db, 'kiosk_pages')) {
        const k = db.prepare('SELECT * FROM kiosk_pages WHERE id = ?').get(u);
        if (k && k.workspace_id === src && !kiosk.has(k.id)) { kiosk.set(k.id, k); texts.push(k.config); scan(k.config); }
      }
    }
  };
  for (const [, rows] of items) for (const it of rows) {
    if (it.content_id) scan(it.content_id);
    if (it.widget_id) scan(it.widget_id);
    scan(it.play_when);
  }
  for (const [, p] of playlists) { scan(p.published_snapshot); scan(p.published_structure); }
  if (layout) scan(layout.draft_zones);

  // By-key references: a data source by slug, a shader by shader_id, a font by CSS family or id.
  const blob = texts.filter(Boolean).join('\n');
  const byKey = { data_sources: [], custom_shaders: [], custom_fonts: [] };
  const reused = [];
  const keyed = (table, keyCol, label, extraKeys = []) => {
    if (!tableExists(db, table)) return;
    for (const r of db.prepare(`SELECT * FROM ${table} WHERE workspace_id = ?`).all(src)) {
      const keys = [r[keyCol], ...extraKeys.map((k) => r[k])].filter(Boolean).map(String);
      if (!keys.some((k) => blob.includes(k))) continue;
      const there = db.prepare(`SELECT id FROM ${table} WHERE workspace_id = ? AND ${keyCol} = ?`).get(toWs, r[keyCol]);
      if (there) reused.push({ kind: label, key: r[keyCol], name: r.name || r[keyCol] });
      else byKey[table].push(r);
    }
  };
  keyed('data_sources', 'slug', 'data_source');
  keyed('custom_shaders', 'shader_id', 'shader');
  keyed('custom_fonts', 'css_family', 'font', ['id']);

  const bytes = [...content.values()].reduce((s, c) => s + (Number(c.file_size) || 0), 0);
  return {
    device_id: device.id,
    own, layout, defaultContent, playlists, items, content, widgets, kiosk, byKey, reused,
    crossOrg,
    summary: {
      playlist_name: own ? own.name : null,
      playlist_others: own ? otherUsers(db, own.id, device.id) : 0,
      smart: !!(own && own.smart_rules) || [...playlists.values()].some((p) => p.smart_rules),
      playlists: playlists.size,
      content: content.size,
      bytes,
      widgets: widgets.size,
      kiosk_pages: kiosk.size,
      data_sources: byKey.data_sources.length,
      shaders: byKey.custom_shaders.length,
      fonts: byKey.custom_fonts.length,
      reused,
      layout: !!layout,
      default_content: !!defaultContent,
    },
  };
}

/** A JSON config with every secret field (by the type's field list, plus credential-looking names) blanked. */
function blankSecrets(text, fields) {
  if (text == null) return text;
  let cfg;
  try { cfg = JSON.parse(text); } catch (_) { return text; }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return text;
  let names = new Set(['authorization']);
  let re = null;
  try { const sec = require('./plugins/secrets'); names = sec.secretNames(fields); re = sec.SECRETY_NAME_RE; } catch (_) { /* default set */ }
  // Plus any key NAMED like a credential (api_key, token...), whatever the type declares: a built-in
  // widget has no field list, and failing closed is the right direction here.
  for (const k of Object.keys(cfg)) if (names.has(k) || (re && re.test(k))) { if (cfg[k] !== undefined && cfg[k] !== '' && typeof cfg[k] !== 'object') cfg[k] = ''; }
  return JSON.stringify(cfg);
}

/** Items for a smart playlist arriving as an ordinary one: what its published snapshot was showing. */
function itemsFromSnapshot(snapshotText) {
  let snap = [];
  try { snap = JSON.parse(snapshotText || '[]'); } catch (_) { snap = []; }
  if (!Array.isArray(snap)) return [];
  return snap.filter((s) => s && (s.content_id || s.widget_id)).map((s, i) => ({
    content_id: s.content_id || null, widget_id: s.widget_id || null, zone_id: s.zone_id || null,
    sort_order: i, duration_sec: Number(s.duration_sec) || 10, muted: s.muted ? 1 : 0,
    enabled: 1, log_play: s.log_play === 0 ? 0 : 1, fit_mode: s.fit_mode || null, weight: Number(s.weight) || 1,
  }));
}

/*
 * Write the copies (inside the move's transaction). Returns the new ids for the device row plus
 * `fileOps`: filesystem copies to do AFTER the transaction commits (a rolled-back preview must
 * leave no files behind).
 */
function apply(db, p, toWs, { userId, actorId }) {
  const map = new Map();
  const fileOps = [];
  const now = () => Math.floor(Date.now() / 1000);
  const idFor = (old) => { const k = String(old).toLowerCase(); if (!map.has(k)) map.set(k, uuid()); return map.get(k); };

  // Mint every id first so any blob can be rewritten in one pass, whatever order rows are written in.
  for (const id of p.content.keys()) idFor(id);
  for (const id of p.widgets.keys()) idFor(id);
  for (const id of p.kiosk.keys()) idFor(id);
  for (const id of p.playlists.keys()) idFor(id);
  for (const r of p.byKey.data_sources) idFor(r.id);
  for (const r of p.byKey.custom_shaders) idFor(r.id);
  // A font's id may appear in configs; its CSS family stays the same (it is what documents name).
  for (const r of p.byKey.custom_fonts) idFor(r.id);
  let zones = [];
  if (p.layout) {
    idFor(p.layout.id);
    zones = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ?').all(p.layout.id);
    for (const z of zones) idFor(z.id);
  }

  for (const c of p.content.values()) {
    copyRow(db, 'content', c, {
      id: map.get(c.id.toLowerCase()), workspace_id: toWs, user_id: p.crossOrg ? userId : c.user_id,
      folder_id: null, team_id: null, draft_json: null, tags: c.tags, meta: c.meta,
    });
  }
  for (const k of p.kiosk.values()) {
    copyRow(db, 'kiosk_pages', k, { id: map.get(k.id.toLowerCase()), workspace_id: toWs, user_id: p.crossOrg ? userId : k.user_id, config: remap(k.config, map) });
  }
  if (p.byKey.data_sources.length) {
    let secrets = null;
    try { secrets = require('./plugins/secrets'); } catch (_) { secrets = null; }
    for (const r of p.byKey.data_sources) {
      let config = r.config;
      // ⚠️ Another organization never receives this one's credentials: secret fields are blanked and
      // read as "needs re-entry" there.
      if (p.crossOrg) config = blankSecrets(r.config, secrets ? secrets.fieldsForDataSource(r.type) : []);
      copyRow(db, 'data_sources', r, { id: map.get(r.id.toLowerCase()), workspace_id: toWs, config });
    }
  }
  for (const r of p.byKey.custom_shaders) {
    copyRow(db, 'custom_shaders', r, { id: map.get(r.id.toLowerCase()), workspace_id: toWs, uploaded_by: actorId || r.uploaded_by });
  }
  for (const r of p.byKey.custom_fonts) {
    const newId = map.get(r.id.toLowerCase());
    const ext = path.extname(String(r.filepath || '')) || '';
    const filepath = `${newId}${ext}`;
    copyRow(db, 'custom_fonts', r, { id: newId, workspace_id: toWs, uploaded_by: actorId || r.uploaded_by, filepath });
    fileOps.push({ kind: 'font', from: r.filepath, to: filepath });
  }
  for (const w of p.widgets.values()) {
    let config = remap(w.config, map);
    let draft = remap(w.draft_config, map);
    if (p.crossOrg) {
      // Same rule for a widget's own credentials (an API key in a plugin widget's settings).
      let fields = [];
      try { fields = require('./plugins/secrets').fieldsForWidget(w.widget_type) || []; } catch (_) { fields = []; }
      config = blankSecrets(config, fields);
      if (draft != null) draft = blankSecrets(draft, fields);
    }
    copyRow(db, 'widgets', w, {
      id: map.get(w.id.toLowerCase()), workspace_id: toWs, user_id: p.crossOrg ? userId : w.user_id, team_id: null,
      config, draft_config: draft,
    });
  }
  let layoutId = null;
  if (p.layout) {
    layoutId = map.get(p.layout.id.toLowerCase());
    copyRow(db, 'layouts', p.layout, {
      id: layoutId, workspace_id: toWs, user_id: p.crossOrg ? userId : p.layout.user_id, team_id: null,
      draft_zones: remap(p.layout.draft_zones, map),
    });
    for (const z of zones) copyRow(db, 'layout_zones', z, { id: map.get(z.id.toLowerCase()), layout_id: layoutId });
  }

  // Children before parents so a parent's child_playlist_id points at a row that exists.
  const order = [...p.playlists.values()].sort((a, b) => (a.id === (p.own && p.own.id) ? 1 : 0) - (b.id === (p.own && p.own.id) ? 1 : 0));
  const mapId = (v) => (v ? (map.get(String(v).toLowerCase()) || v) : v);
  for (const pl of order) {
    const newId = map.get(pl.id.toLowerCase());
    const smart = !!pl.smart_rules;
    copyRow(db, 'playlists', pl, {
      id: newId, workspace_id: toWs, user_id: p.crossOrg ? userId : pl.user_id,
      corporate: 0, published_composable: null, published_composable_of: null,
      smart_rules: smart ? null : pl.smart_rules, published_smart_rules: smart ? null : pl.published_smart_rules,
      published_snapshot: remap(pl.published_snapshot, map), published_structure: smart ? null : remap(pl.published_structure, map),
      updated_at: now(),
    });
    const insSched = db.prepare(`INSERT INTO playlist_item_schedules
      (id, playlist_item_id, active_days, start_time, end_time, start_date, end_date, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    if (smart) {
      for (const it of itemsFromSnapshot(remap(pl.published_snapshot, map))) {
        copyRow(db, 'playlist_items', it, { id: OMIT, playlist_id: newId, child_playlist_id: null, slot_id: null, play_when: null,
          play_from: null, play_until: null, repeat_every_sec: null, created_at: now(), updated_at: now() });
      }
      continue;
    }
    for (const it of p.items.get(pl.id) || []) {
      const res = copyRow(db, 'playlist_items', it, {
        id: OMIT, playlist_id: newId,
        content_id: mapId(it.content_id), widget_id: mapId(it.widget_id), child_playlist_id: mapId(it.child_playlist_id),
        zone_id: mapId(it.zone_id), slot_id: null, play_when: remap(it.play_when, map),
      });
      for (const s of db.prepare('SELECT * FROM playlist_item_schedules WHERE playlist_item_id = ?').all(it.id)) {
        insSched.run(uuid(), res.lastInsertRowid, s.active_days, s.start_time, s.end_time, s.start_date, s.end_date, s.sort_order);
      }
    }
  }

  return {
    playlist_id: p.own ? map.get(p.own.id.toLowerCase()) : null,
    layout_id: layoutId,
    default_content_id: p.defaultContent ? map.get(p.defaultContent.id.toLowerCase()) : null,
    copied: { playlists: p.playlists.size, content: p.content.size, widgets: p.widgets.size, kiosk_pages: p.kiosk.size,
      data_sources: p.byKey.data_sources.length, shaders: p.byKey.custom_shaders.length, fonts: p.byKey.custom_fonts.length,
      layout: !!p.layout },
    fileOps,
  };
}

/** Run the post-commit file copies. Never throws; a failed copy is logged (the font row stays, without bytes). */
function runFileOps(ops) {
  const config = require('../config');
  for (const op of ops || []) {
    try {
      if (op.kind === 'font') {
        fs.mkdirSync(config.fontsDir, { recursive: true });
        fs.copyFileSync(path.join(config.fontsDir, path.basename(String(op.from))), path.join(config.fontsDir, path.basename(String(op.to))));
      }
    } catch (e) {
      console.warn(`[move-workspace] could not copy ${op.kind} ${op.from} -> ${op.to}: ${e && e.message}`);
    }
  }
}

module.exports = { plan, apply, runFileOps, ownPlaylistOf, itemsFromSnapshot, blankSecrets, UUID_G };
