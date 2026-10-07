'use strict';

/*
 * "Play this item every N minutes": an item flagged with repeat_every_sec is woven into the rest of
 * the loop at evenly spaced points, so in a 5-minute loop of 30 ten-second items, a promo set to
 * every 60s plays roughly once a minute instead of once per loop.
 *
 * ⚠️ RESOLVED AT PUBLISH, LIKE NESTING. The output is an ordinary flat list in which the item simply
 * appears several times, so every player already plays it correctly, offline included, with no
 * client release. The spacing is computed from item durations, so it is approximate wherever the
 * player's real timing differs (a video that ends early, an item skipped by its daypart).
 *
 * The weave works per zone: items in different zones of a layout play independently, so an item is
 * only spaced against the items it actually alternates with.
 *
 * When the interval is longer than one loop, the rest of the loop is repeated K times so that the
 * item can appear once every K loops. Output is capped at MAX_OUTPUT items.
 */

const MAX_OUTPUT = 1000;
const MAX_FLAGGED = 50;     // per zone; beyond this the weave is skipped rather than run at O(n^3)
const MAX_LOOPS = 24;
const DEFAULT_SEC = 10;

function itemSeconds(it) {
  const d = Number(it && it.duration_sec);
  if (Number.isFinite(d) && d >= 1) return d;
  const c = Number(it && it.content_duration);
  if (Number.isFinite(c) && c >= 1) return Math.ceil(c);
  return DEFAULT_SEC;
}

function isOpenEnded(it) {
  return Number(it && it.duration_sec) === 0 && /^video\/(hls|rtsp|hdmi-in)$/.test(String((it && it.mime_type) || ''));
}

function everyOf(it) {
  // A stream that stays until skipped cannot be woven in: every copy would park the screen on it.
  if (isOpenEnded(it)) return 0;
  const n = Number(it && it.repeat_every_sec);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 0;
}

// A live stream with dwell 0 stays until skipped, so it has no duration to space against.
function hasOpenEndedItem(items) {
  return items.some(isOpenEnded);
}

function weaveZone(items) {
  const base = items.filter((it) => !everyOf(it));
  const reps = items.filter((it) => everyOf(it));
  // Nothing to weave into (every item is flagged), or no way to measure time: play the list as is.
  if (!reps.length || !base.length || reps.length > MAX_FLAGGED || hasOpenEndedItem(base)) return items;

  const loopSec = base.reduce((s, it) => s + itemSeconds(it), 0);

  // How many copies of the base loop are needed for the sparsest item to fit once.
  let loops = 1;
  for (const r of reps) {
    const gap = everyOf(r) - itemSeconds(r);
    if (gap > loopSec) loops = Math.max(loops, Math.round(gap / loopSec));
  }
  loops = Math.max(1, Math.min(loops, MAX_LOOPS, Math.floor(MAX_OUTPUT / (base.length * 2)) || 1));

  const seq = [];
  for (let k = 0; k < loops; k++) for (const it of base) seq.push(it);
  const totalSec = loopSec * loops;
  const starts = [];
  let acc = 0;
  for (const it of seq) { starts.push(acc); acc += itemSeconds(it); }

  // inserts[b] = items to play just before seq[b].
  const inserts = seq.map(() => []);
  reps.forEach((r, ri) => {
    const gap = Math.max(1, everyOf(r) - itemSeconds(r));
    const n = Math.max(1, Math.min(seq.length, Math.round(totalSec / gap)));
    const step = totalSec / n;
    // Stagger different flagged items so they do not all land on the same boundary.
    const offset = (step * ri) / reps.length;
    let lastB = -1;
    for (let k = 0; k < n; k++) {
      const t = offset + k * step;
      // starts[] is ascending: binary-search the nearest boundary.
      let lo = 0, hi = starts.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid] < t) lo = mid + 1; else hi = mid; }
      let b = lo;
      if (b > 0 && Math.abs(starts[b - 1] - t) <= Math.abs(starts[b] - t)) b = b - 1;
      if (b <= lastB) b = lastB + 1;              // never two copies at one boundary
      if (b >= seq.length) break;
      inserts[b].push(r);
      lastB = b;
    }
  });

  const out = [];
  for (let b = 0; b < seq.length; b++) {
    for (const r of inserts[b]) out.push(r);
    out.push(seq[b]);
  }
  return out.length > MAX_OUTPUT ? items : out;
}

/**
 * Expand flagged items in a flat snapshot list. Items without a flag come back in their original
 * order; the field itself is stripped so it is never sent to a player and a parent playlist does not
 * weave a nested child's items a second time.
 */
function applyRepeatEvery(items) {
  if (!Array.isArray(items) || !items.some((it) => it && everyOf(it))) {
    for (const it of items || []) if (it) delete it.repeat_every_sec;
    return items;
  }
  const zones = new Map();
  for (const it of items) {
    const key = it.zone_id || '';
    if (!zones.has(key)) zones.set(key, []);
    zones.get(key).push(it);
  }
  const out = [];
  for (const list of zones.values()) {
    for (const it of weaveZone(list)) out.push({ ...it });
  }
  /*
   * ⚠️ RENUMBER sort_order. Every copy of an item carries the source row's sort_order, and the
   * players re-sort by it (Tizen always; the web player, Android and native per zone), which would
   * pull every copy back next to the original and undo the weave. The flat array order is the truth.
   */
  out.forEach((it, i) => { delete it.repeat_every_sec; it.sort_order = i; });
  return out;
}

/** Validate an operator value in seconds: null clears; false is invalid. 10s .. 24h. */
function normalizeRepeatEvery(v) {
  if (v === null || v === '' || v === 0 || v === '0') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 10 || n > 86400) return false;
  return Math.floor(n);
}

module.exports = { applyRepeatEvery, normalizeRepeatEvery, weaveZone, MAX_OUTPUT };
