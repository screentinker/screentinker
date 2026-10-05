'use strict';

/*
 * compose() — head office's playlist with one store's slot content spliced in. PURE: no database,
 * no clock, so every rule here is unit-tested directly (test/corporate-compose.test.js).
 *
 * Input:
 *   composable — a corporate playlist's `published_composable`: the flat published list in which
 *                each LOCAL SLOT is still a marker { __slot, zone_id, play_from?, play_until?,
 *                weight?, sort_order, limits, fallback } (routes/playlists.js buildSnapshotItems
 *                with keepSlots), NOT yet woven for "play every N".
 *   fills      — Map<slotId, items[] | { items, workspace_id }>: the published snapshot of the fill
 *                each slot resolves to on this screen (lib/corporate/resolve.js fillsForDevice).
 *
 * Output: a flat array of ordinary items, exactly the shape every player already plays. No marker
 * ever leaves this function (asserted by the tests on every output).
 *
 * ⚠️ WHY THE WEAVE HAPPENS HERE AND NOT AT PUBLISH. "Play every 10 minutes" spaces an item over the
 * loop it actually plays in, and each store's loop is a different length once its slot content is
 * in. Weaving at corporate publish would space head office's item over the fallback-only loop and
 * bunch it up on every store with a long slot. So the composable is stored unwoven and the weave
 * runs after the splice, per store (spec §3.2, risk R13).
 *
 * ⚠️ WHY LENGTHS ARE COUNTED THE HARD WAY (decision D15). A slot limit is airtime, not an item
 * count: videos advance on `ended`, not on duration_sec, so a video counts at the longer of its
 * item duration and its real (probed) length; anything whose length the server does not know — a
 * live stream (whatever duration_sec it carries), YouTube, a remote video nobody could probe —
 * could hold the screen indefinitely and is never allowed in a slot. The authoritative check is at
 * fill publish (fillViolation, called from publishPlaylist); the filtering here is the belt for a
 * row some other path wrote.
 */

const { LIVE_MIMES } = require('../item-duration');
const { applyRepeatEvery } = require('../repeat-every');
const { laterStamp, earlierStamp } = require('../play-stamps');

const isMarker = (it) => !!(it && typeof it === 'object' && it.__slot);

function mimeOf(it) { return String((it && it.mime_type) || '').toLowerCase(); }

/** Audio and video advance when the media ends, not on duration_sec. */
function isTimedMedia(it) {
  const m = mimeOf(it);
  return m.startsWith('video/') || m.startsWith('audio/');
}

/** The media's real length in seconds, 0 when unknown. `contentDuration(id)` beats the snapshot's copy. */
function mediaLength(it, opts = {}) {
  let n;
  if (opts.contentDuration && it.content_id) {
    const v = opts.contentDuration(it.content_id);
    if (v !== undefined && v !== null) n = Number(v);
  }
  if (n === undefined) n = Number(it.content_duration);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Could this item hold the screen for a length nobody can bound? */
function isUnboundedItem(it, opts = {}) {
  if (!it) return false;
  const m = mimeOf(it);
  if (LIVE_MIMES.includes(m)) return true;                    // whatever duration_sec it carries
  if (m === 'video/youtube' || it.youtube_id) return true;
  if (isTimedMedia(it) && !mediaLength(it, opts)) return true; // a video with no known length
  return false;
}

/** Seconds this item really plays for per loop (spec D15). */
function effectiveSeconds(it, opts = {}) {
  const d = Number(it && it.duration_sec);
  const dwell = Number.isFinite(d) && d > 0 ? d : 0;
  return isTimedMedia(it) ? Math.max(dwell, mediaLength(it, opts)) : dwell;
}

function kindOf(it) {
  if (it.widget_id) return 'widget';
  if (isTimedMedia(it)) return 'video';
  return 'other';
}

function itemLabel(it) {
  return (it && (it.filename || it.widget_name || it.name)) || 'This item';
}

function typesLabel(limits) {
  const video = limits.allow_video === undefined ? true : !!limits.allow_video;
  const widgets = limits.allow_widgets === undefined ? true : !!limits.allow_widgets;
  if (video && !widgets) return 'pictures and videos';
  if (!video && widgets) return 'pictures and widgets';
  return 'pictures';
}

/**
 * Does this list break the slot's rules? The authoritative check, run at fill publish and early
 * at every add path. `items` are snapshot-shaped (mime_type, duration_sec, content_duration).
 * @returns {null | {code, vars}} vars feed guard.err's message for that code.
 */
function fillViolation(items, limits = {}, opts = {}) {
  const list = (items || []).filter(Boolean);
  for (const it of list) {
    if (it.child_playlist_id || it.__slot || it.slot_id) return { code: 'FILL_FLAT', vars: {} };
  }
  for (const it of list) {
    if (isUnboundedItem(it, opts)) return { code: 'FILL_LIVE', vars: { item: itemLabel(it) } };
  }
  const allowVideo = limits.allow_video === undefined ? true : !!limits.allow_video;
  const allowWidgets = limits.allow_widgets === undefined ? true : !!limits.allow_widgets;
  for (const it of list) {
    const k = kindOf(it);
    if ((k === 'video' && !allowVideo) || (k === 'widget' && !allowWidgets)) {
      return { code: 'FILL_TYPE', vars: { types: typesLabel(limits), slot: opts.slotName || '' } };
    }
  }
  const n = list.length;
  const sec = Math.round(list.reduce((s, it) => s + effectiveSeconds(it, opts), 0));
  const overItems = limits.max_items != null && n > Number(limits.max_items);
  const overSec = limits.max_total_sec != null && sec > Number(limits.max_total_sec);
  if (overItems || overSec) {
    return {
      code: 'FILL_LIMIT',
      vars: {
        slot: opts.slotName || '', n, sec,
        max_items: limits.max_items != null ? Number(limits.max_items) : null,
        max_sec: limits.max_total_sec != null ? Number(limits.max_total_sec) : null,
      },
    };
  }
  return null;
}

/** Totals a meter shows: items and seconds per loop. */
function fillTotals(items, opts = {}) {
  const list = (items || []).filter(Boolean);
  return { items: list.length, seconds: Math.round(list.reduce((s, it) => s + effectiveSeconds(it, opts), 0)) };
}

/**
 * The belt: what may actually play from a fill, whatever wrote it. Never nested, never unbounded,
 * only allowed types; truncated to max_items, then to the longest prefix within max_total_sec.
 */
function filterFillItems(items, limits = {}, opts = {}) {
  const allowVideo = limits.allow_video === undefined ? true : !!limits.allow_video;
  const allowWidgets = limits.allow_widgets === undefined ? true : !!limits.allow_widgets;
  let kept = [];
  for (const it of items || []) {
    if (!it || typeof it !== 'object') continue;
    if (it.child_playlist_id || it.__slot || it.slot_id) continue;
    if (isUnboundedItem(it, opts)) continue;
    const k = kindOf(it);
    if (k === 'video' && !allowVideo) continue;
    if (k === 'widget' && !allowWidgets) continue;
    kept.push(it);
  }
  if (limits.max_items != null) kept = kept.slice(0, Math.max(0, Number(limits.max_items)));
  if (limits.max_total_sec != null) {
    const cap = Number(limits.max_total_sec);
    let sum = 0;
    const out = [];
    for (const it of kept) {
      sum += effectiveSeconds(it, opts);
      if (sum > cap) break;
      out.push(it);
    }
    kept = out;
  }
  return kept;
}

/** Head office decides WHERE and WHEN a slot plays: zone, window and weight come from the marker. */
function applyMarker(item, marker) {
  item.zone_id = marker.zone_id === undefined ? null : marker.zone_id;
  const from = laterStamp(marker.play_from, item.play_from);
  const until = earlierStamp(marker.play_until, item.play_until);
  if (from) item.play_from = from; else delete item.play_from;
  if (until) item.play_until = until; else delete item.play_until;
  if (marker.weight && Number(marker.weight) !== 1) item.weight = Number(marker.weight);
  delete item.repeat_every_sec;   // a store item never gets head office's interval weave
  return item;
}

function fillEntry(fills, slotId) {
  const e = fills && typeof fills.get === 'function' ? fills.get(slotId) : null;
  if (!e) return { items: [], workspace_id: null };
  if (Array.isArray(e)) return { items: e, workspace_id: null };
  return { items: Array.isArray(e.items) ? e.items : [], workspace_id: e.workspace_id || null, fill_id: e.fill_id || null };
}

/**
 * @param {object} opts
 *   playbackOrder  'sequential' | 'shuffle' | 'weighted' — the CORPORATE playlist's order, for the
 *                  whole composition (the fill's own order is ignored)
 *   hqWorkspaceId  origin tag for head office's items and fallbacks
 *   tagOrigin      stamp every output item with __origin_ws (deviceSocket resolves data sources and
 *                  shaders per origin, then deletes it before the payload leaves the server)
 *   contentDuration(contentId) -> seconds|null, the probed length read at compose time
 * @returns {{items: object[], slots: object[]}} slots: per marker, what played and why
 */
function composeDetailed(composable, fills, opts = {}) {
  const list = Array.isArray(composable) ? composable : [];
  const hasMarker = list.some(isMarker);
  const tag = (it, ws, kind, slotId) => {
    if (opts.tagOrigin) it.__origin_ws = ws || null;
    if (opts.annotate) it.__tag = { kind, slot_id: slotId || null };
    return it;
  };
  let out = [];
  const slots = [];
  for (const el of list) {
    if (!el || typeof el !== 'object') continue;
    if (!isMarker(el)) { out.push(tag({ ...el }, opts.hqWorkspaceId, 'corporate')); continue; }
    const limits = el.limits || {};
    const entry = fillEntry(fills, el.__slot);
    const kept = filterFillItems(entry.items, limits, opts);
    if (kept.length) {
      for (const it of kept) out.push(tag(applyMarker({ ...it }, el), entry.workspace_id, 'slot', el.__slot));
      slots.push({ slot_id: el.__slot, outcome: 'fill', fill_id: entry.fill_id || null, ...fillTotals(kept, opts) });
    } else if (el.fallback && typeof el.fallback === 'object') {
      out.push(tag(applyMarker({ ...el.fallback }, el), opts.hqWorkspaceId, 'fallback', el.__slot));
      slots.push({ slot_id: el.__slot, outcome: 'fallback', fill_id: null, ...fillTotals([el.fallback], opts) });
    } else {
      slots.push({ slot_id: el.__slot, outcome: 'skipped', fill_id: null, items: 0, seconds: 0 });
    }
  }
  if ((opts.playbackOrder || 'sequential') === 'sequential') {
    out = applyRepeatEvery(out);
  } else {
    for (const it of out) delete it.repeat_every_sec;   // same rule as a non-corporate publish
  }
  // Renumber (Tizen re-sorts by sort_order) — only when something was spliced, so a marker-free
  // list comes back byte-identical to what went in.
  if (hasMarker) out.forEach((it, i) => { it.sort_order = i; });
  // Belt: nothing that looks like a marker may reach a player.
  out = out.filter((it) => !isMarker(it));
  return { items: out, slots };
}

function compose(composable, fills, opts = {}) {
  return composeDetailed(composable, fills, { ...opts, annotate: false }).items;
}

module.exports = {
  compose, composeDetailed, fillViolation, fillTotals, filterFillItems, applyMarker,
  isMarker, isUnboundedItem, effectiveSeconds, isTimedMedia, typesLabel,
};
