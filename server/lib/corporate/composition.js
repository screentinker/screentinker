'use strict';

/*
 * What a mandated screen actually plays: head office's published playlist with the store's slot
 * content spliced in — one COMPOSITION per (corporate playlist, fill signature), cached in
 * corporate_compositions (spec §3.3).
 *
 * ⚠️ THE CACHE IS SELF-HEALING, AND THAT IS ITS WHOLE CORRECTNESS ARGUMENT. Each row records the
 * published_rev of every input it was built from (inputs_rev). Every read compares that against the
 * inputs as they are NOW and recomposes on any difference. So a publish path that forgets the
 * fan-out (lib/corporate/fanout.js) can at worst delay a push — the next payload build for that
 * screen is still right. The table is derived: safe to DELETE FROM at any time, never replicated,
 * never exported.
 *
 * published_rev is bumped by every writer of published_snapshot / published_composable:
 * publishPlaylist, the mute-sync patch, and the content-delete scrub.
 */

const { compose, composeDetailed } = require('./compose');
const resolve = require('./resolve');
const { snapshotDigest } = require('./digest');

function dbOf() { return require('../../db/database').db; }

function parse(text, fallback) {
  if (text === null || text === undefined) return fallback;
  try { const v = JSON.parse(text); return v === null ? fallback : v; } catch (_) { return fallback; }
}

/** The probed length of every timed-media content row these fill items name (read at compose time). */
function contentDurationLookup(db, fillSnapshots) {
  const ids = new Set();
  for (const items of fillSnapshots) for (const it of items || []) if (it && it.content_id) ids.add(it.content_id);
  const map = new Map();
  if (!ids.size) return () => undefined;
  const list = [...ids];
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    for (const r of db.prepare(`SELECT id, duration_sec FROM content WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk)) {
      map.set(r.id, r.duration_sec);
    }
  }
  return (id) => (map.has(id) ? map.get(id) : undefined);
}

/**
 * Inputs for a composition, read once: the corporate row and each fill's published snapshot.
 * `fills` is resolve.fillsForDevice's Map<slotId, {playlistId, workspace_id, ...}>.
 */
function loadInputs(db, playlistId, fills) {
  const p = db.prepare(`SELECT id, workspace_id, published_composable, published_snapshot, published_playback_order, published_rev
                          FROM playlists WHERE id = ?`).get(playlistId);
  if (!p) return null;
  const fillIds = [...new Set([...fills.values()].map((f) => f.playlistId))].sort();
  const rows = new Map();
  if (fillIds.length) {
    for (const r of db.prepare(`SELECT id, workspace_id, published_snapshot, published_rev FROM playlists
                                 WHERE id IN (${fillIds.map(() => '?').join(',')})`).all(...fillIds)) rows.set(r.id, r);
  }
  /*
   * ⚠️ rev AND snapshot digest per input. published_rev alone is moved only by this version's
   * writers; an older version booted on the same database (a rollback) republishes a store's content
   * without touching it, and the cache would keep the loop from before. The digest notices.
   */
  const dg = (text) => snapshotDigest(text) || '-';
  const inputsRev = [`P:${p.published_rev || 0}:${dg(p.published_composable)}:${dg(p.published_snapshot)}`,
    ...fillIds.map((id) => (rows.has(id) ? `${id}:${rows.get(id).published_rev || 0}:${dg(rows.get(id).published_snapshot)}` : `${id}:gone`))].join(';');
  return { p, rows, inputsRev };
}

function composeInputs(db, inputs, fills, extra = {}) {
  const { p, rows } = inputs;
  // A corporate playlist published before slots existed has no composable: its flat snapshot IS one.
  const composable = parse(p.published_composable, null) || parse(p.published_snapshot, []);
  const fillMap = new Map();
  const snapshots = [];
  for (const [slotId, f] of fills) {
    const r = rows.get(f.playlistId);
    const items = r ? parse(r.published_snapshot, []) : [];
    snapshots.push(items);
    fillMap.set(slotId, { items, workspace_id: (r && r.workspace_id) || f.workspace_id || null, fill_id: f.fillId || null });
  }
  const opts = {
    playbackOrder: p.published_playback_order || 'sequential',
    hqWorkspaceId: p.workspace_id || null,
    tagOrigin: true,
    contentDuration: contentDurationLookup(db, snapshots),
    ...extra,
  };
  return extra.annotate ? composeDetailed(composable, fillMap, opts) : { items: compose(composable, fillMap, opts) };
}

/**
 * The composition for corporate playlist P with these fills (cached by signature).
 * @returns {{items: object[], playback_order: string, signature: string}}
 */
function compositionForFills(db, playlistId, fills) {
  db = db || dbOf();
  const signature = resolve.signatureFor(fills);
  const inputs = loadInputs(db, playlistId, fills);
  if (!inputs) return { items: [], playback_order: 'sequential', signature };
  const order = inputs.p.published_playback_order || 'sequential';
  let row = null;
  try {
    row = db.prepare('SELECT inputs_rev, snapshot, playback_order FROM corporate_compositions WHERE playlist_id = ? AND signature = ?')
      .get(playlistId, signature);
  } catch (_) { row = null; }
  if (row && row.inputs_rev === inputs.inputsRev) {
    return { items: parse(row.snapshot, []), playback_order: row.playback_order || order, signature };
  }
  const { items } = composeInputs(db, inputs, fills);
  try {
    db.prepare(`INSERT INTO corporate_compositions (playlist_id, signature, inputs_rev, snapshot, playback_order, composed_at)
                VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
                ON CONFLICT(playlist_id, signature) DO UPDATE SET inputs_rev = excluded.inputs_rev, snapshot = excluded.snapshot,
                  playback_order = excluded.playback_order, composed_at = excluded.composed_at`)
      .run(playlistId, signature, inputs.inputsRev, JSON.stringify(items), order);
  } catch (e) { console.warn(`[corporate] composition cache write failed: ${e && e.message}`); }
  return { items, playback_order: order, signature };
}

/** What device D plays under corporate playlist P. */
function compositionFor(db, deviceId, playlistId) {
  db = db || dbOf();
  return compositionForFills(db, playlistId, resolve.fillsForDevice(db, deviceId, playlistId));
}

/**
 * Uncached, annotated: every item tagged {kind: corporate|slot|fallback, slot_id}, plus a per-slot
 * report. For the previews. `overrides` replaces a slot's fill items (the fill draft preview), and
 * `composable` replaces P's published composable (the corporate draft preview).
 */
function explain(db, playlistId, fills, { overrides = null, composable = null } = {}) {
  db = db || dbOf();
  const inputs = loadInputs(db, playlistId, fills);
  if (!inputs) return { items: [], slots: [], playback_order: 'sequential' };
  if (composable) inputs.p = { ...inputs.p, published_composable: JSON.stringify(composable) };
  if (overrides) {
    for (const [slotId, o] of overrides) {
      const key = `__override:${slotId}`;
      inputs.rows.set(key, { id: key, workspace_id: o.workspace_id, published_snapshot: JSON.stringify(o.items || []) });
      fills = new Map(fills);
      fills.set(slotId, { playlistId: key, workspace_id: o.workspace_id, fillId: o.fill_id || null });
    }
  }
  const r = composeInputs(db, inputs, fills, { annotate: true });
  return { items: r.items, slots: r.slots, playback_order: inputs.p.published_playback_order || 'sequential' };
}

module.exports = { compositionFor, compositionForFills, explain, contentDurationLookup };
