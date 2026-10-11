/*
 * Search, filters and selection for the Templates library — the pure half of views/templates.js.
 *
 * Everything here works on the entries the server already sent (GET /templates/library or
 * /templates/installed); nothing is fetched and nothing is decided about permissions. The server
 * still checks every install on its own, so a filter or a selection can never let an admin
 * install something the server would refuse — at worst a selected entry fails and is reported.
 */

import { localName, localDescription } from './template-i18n.js';

/** Lower-case, accents folded ("Café" finds "cafe"), whitespace collapsed. */
export function fold(s) {
  return String(s == null ? '' : s)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Orientation as a list, whether the index gave a string or an array (or nothing). */
export function orientationsOf(e) {
  const o = e && e.orientation;
  if (Array.isArray(o)) return o.filter((x) => typeof x === 'string');
  return typeof o === 'string' && o ? [o] : [];
}

/** The text a search looks through: English and translated name/description, id, tags, author. */
function haystack(e, lang) {
  const tags = Array.isArray(e.tags) ? e.tags.join(' ') : '';
  return fold([e.name, localName(e, lang), e.description, localDescription(e, lang), e.id, tags, e.author].join(' '));
}

/** Every word of the query must appear somewhere (so "menu portrait" narrows, not widens). */
export function matchesQuery(e, q, lang) {
  const words = fold(q).split(' ').filter(Boolean);
  if (!words.length) return true;
  const h = haystack(e, lang);
  return words.every((w) => h.includes(w));
}

/** A library entry an admin could install or update right now (the card shows a button for it). */
export function isActionable(e) {
  return !!e && e.compatible !== false && (!e.installed || !!e.update_available);
}

export const STATUS_FILTERS = ['all', 'not_installed', 'updates', 'installed', 'new'];
export const KIND_FILTERS = ['all', 'slide', 'html'];
export const ORIENTATION_FILTERS = ['all', 'landscape', 'portrait'];

function matchesStatus(e, status) {
  switch (status) {
    case 'not_installed': return !e.installed;
    case 'updates': return !!e.update_available;
    case 'installed': return !!e.installed;
    case 'new': return !!(e.is_new || e.is_updated);
    default: return true;
  }
}

/**
 * Whether one entry passes the filters. `state` = { q, status, kind, orientation, tag }; any
 * missing or unknown value means "no filter". Works for installed templates too (they have no
 * `installed`/`update_available`, so only q, kind, orientation and tag are meaningful there).
 */
export function matchesFilters(e, state = {}, lang = 'en') {
  if (!e) return false;
  if (!matchesQuery(e, state.q, lang)) return false;
  if (state.status && state.status !== 'all' && !matchesStatus(e, state.status)) return false;
  if (state.kind && state.kind !== 'all' && e.kind !== state.kind) return false;
  if (state.orientation && state.orientation !== 'all') {
    const o = orientationsOf(e);
    // A template that declares no orientation is drawn for any shape, so it passes either filter.
    if (o.length && !o.includes(state.orientation)) return false;
  }
  if (state.tag && !(Array.isArray(e.tags) && e.tags.includes(state.tag))) return false;
  return true;
}

/** Every tag in use, sorted, for the tag filter. */
export function allTags(entries) {
  const set = new Set();
  for (const e of entries || []) for (const t of (Array.isArray(e.tags) ? e.tags : [])) if (typeof t === 'string' && t) set.add(t);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * The entries a bulk install would act on: selected keys that are still actionable, in the order
 * they appear in `entries`. A key whose entry has since been installed, or vanished from the
 * catalog, simply drops out.
 */
export function selectionToInstall(entries, selectedKeys) {
  const sel = selectedKeys instanceof Set ? selectedKeys : new Set(selectedKeys || []);
  return (entries || []).filter((e) => sel.has(e.key) && isActionable(e));
}

/** Entries with an update waiting (for "Update all"). */
export function updatesOf(entries) {
  return (entries || []).filter((e) => e && e.update_available && e.compatible !== false);
}

/**
 * Run `installOne(entry)` for each entry, ONE AT A TIME (each install downloads and verifies a
 * package; doing them in parallel would only race the same catalog host and the same store).
 * A failure does not stop the rest. `onProgress({ done, total, entry })` is called before each.
 * Resolves to { ok: [entry], failed: [{ entry, error }] }.
 */
export async function installSequentially(entries, installOne, onProgress = () => {}, { shouldStop = () => false } = {}) {
  const ok = [];
  const failed = [];
  const list = entries || [];
  for (let i = 0; i < list.length; i++) {
    if (shouldStop()) break;
    const entry = list[i];
    onProgress({ done: i, total: list.length, entry });
    try {
      await installOne(entry);
      ok.push(entry);
    } catch (err) {
      failed.push({ entry, error: (err && err.message) || String(err) });
    }
  }
  onProgress({ done: ok.length + failed.length, total: list.length, entry: null });
  return { ok, failed };
}
