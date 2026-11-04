/*
 * #796: the Content Library's way of browsing, for the Widgets, Playlists and Schedules pages.
 *
 *   nav        All · Recently added · Unused (or the page's own status views), then the folder tree
 *              with a count per folder, and New folder
 *   toolbar    search by name, the page's filters, sort
 *   chips      the active filters, each removable; the breadcrumb with the folder's actions menu
 *   bulk bar   select items, Move to a folder (or drag a card onto a folder in the tree)
 *   results    drawn by the PAGE (its own cards and actions), into a container this component owns
 *
 * Same markup and CSS classes as views/content-library.js (css/library.css), the same dialog and
 * menu components, and the same folder rules: a folder shows the items filed DIRECTLY in it, All
 * shows everything, a search spans the whole library (not only the open folder), and deleting a
 * folder never deletes what is in it (it moves up a level).
 *
 * Folders come from /api/library-folders/:kind (server routes/library-folders.js). They are
 * organisational only: a move never touches the widget, playlist or schedule itself, so it changes
 * nothing on any screen. The page loads its own items as it always did and hands them over with
 * setItems(); filtering and sorting happen here, on the list in hand.
 *
 * View state is kept per library at module scope, so leaving the page and coming back keeps the place.
 */

import { api } from '../../api.js';
import { esc } from '../../utils.js';
import { t } from '../../i18n.js';
import { showToast } from '../toast.js';
import { openDialog, confirmDialog } from './dialog.js';
import { openMenu, closeMenu } from './menu.js';
import { treeOrder } from './add-content.js';

const PAGE = 60;
const STATES = new Map();

const ICONS = {
  all: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
  folder: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  recent: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>',
  unused: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/></svg>',
  active: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><polygon points="6 4 20 12 6 20 6 4"/></svg>',
  upcoming: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  expired: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 3 3 9 9 9"/></svg>',
};

// The server enforces every write; this only hides controls a read-only member could not use.
function canWrite() {
  try {
    const u = JSON.parse(localStorage.getItem('user') || 'null');
    if (!u) return true;
    return !(u.current_workspace_role === 'workspace_viewer' && !u.acting_as);
  } catch (_) { return true; }
}

function stateFor(cfg) {
  if (!STATES.has(cfg.kind)) {
    STATES.set(cfg.kind, {
      location: { kind: 'all', folderId: null },
      q: '',
      filters: Object.fromEntries((cfg.filters || []).map((f) => [f.id, 'all'])),
      sort: cfg.defaultSort || (cfg.sorts && cfg.sorts[0] && cfg.sorts[0][0]),
      expanded: new Set(),
      selected: new Set(),
      navOpen: false,
      shown: PAGE,
    });
  }
  return STATES.get(cfg.kind);
}

/**
 * Mount the library frame into `host`. Returns the controller the page talks to.
 *
 * cfg = {
 *   kind,                       'widget' | 'playlist' | 'schedule'
 *   idPrefix,                   unique DOM id prefix for this page
 *   searchLabel, searchPlaceholder, allLabel   already translated
 *   views: [{ id, label, icon?, test(item, ctx) }]   quick views after All (ctx: usage, now, recentDays)
 *   viewNote(ctx)               optional line under the quick views
 *   filters: [{ id, label, options: [[value, text]], test(item, value, ctx) }]   value 'all' = off
 *   sorts: [[id, text, compare(a, b, ctx)]], defaultSort
 *   nameOf(item), canFile(item)       canFile false = never selectable (a platform template)
 *   renderItems(container, items, helpers)   the page draws its cards; helpers below
 *   emptyHtml()                 the page's own "nothing here yet" state, when it has no items at all
 * }
 */
export function mountResourceLibrary(host, cfg) {
  const st = stateFor(cfg);
  const P = cfg.idPrefix || `rl-${cfg.kind}`;
  const id = (s) => `${P}-${s}`;
  let items = [];
  let folders = [];
  let placements = {};
  let usage = {};
  let recentDays = 7;
  let loadedItems = false;
  let searchTimer = null;
  const nameOf = cfg.nameOf || ((x) => x.name || '');
  const canFile = (x) => canWrite() && (!cfg.canFile || cfg.canFile(x));
  const dragType = `text/x-st-${cfg.kind}-id`;

  host.innerHTML = `
    <div class="lib rl" data-kind="${esc(cfg.kind)}">
      <div class="lib-layout">
        <nav class="lib-nav" id="${id('nav')}" aria-label="${esc(t('library.nav.label'))}"></nav>
        <div class="lib-main">
          <div class="lib-toolbar" role="search" aria-label="${esc(t('rlib.toolbar_label'))}">
            <div class="lib-search">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <label for="${id('q')}" class="lib-visually-hidden">${esc(cfg.searchLabel || t('rlib.search_label'))}</label>
              <input type="search" id="${id('q')}" class="input" placeholder="${esc(cfg.searchPlaceholder || t('rlib.search_placeholder'))}" value="${esc(st.q)}" autocomplete="off">
            </div>
            <div class="lib-filters" role="group" aria-label="${esc(t('library.filters_label'))}">
              ${(cfg.filters || []).map((f) => selectHtml(id('f-' + f.id), f.label, [['all', f.allText || t('rlib.filter_any', { label: f.label })], ...f.options], st.filters[f.id])).join('')}
            </div>
            ${(cfg.sorts || []).length ? selectHtml(id('sort'), t('library.sort.label'), cfg.sorts.map(([v, text]) => [v, text]), st.sort) : ''}
          </div>
          <div class="lib-chiprow" id="${id('chips')}"></div>
          <div class="lib-crumbrow" id="${id('crumb')}"></div>
          <div class="lib-bulkbar" id="${id('bulk')}" hidden></div>
          <div class="lib-count rl-count" id="${id('count')}" aria-live="polite"></div>
          <div class="lib-results rl-results" id="${id('results')}"></div>
          <div class="rl-more" id="${id('more')}"></div>
        </div>
      </div>
      <div class="lib-visually-hidden" id="${id('live')}" role="status" aria-live="polite"></div>
    </div>`;

  const $ = (s) => host.querySelector('#' + CSS.escape(id(s)));
  const ctx = () => ({ usage, placements, now: Date.now(), recentDays });
  const folderById = () => new Map(folders.map((f) => [f.id, f]));
  const folderPath = (fid) => {
    const byId = folderById();
    const parts = [];
    for (let f = byId.get(fid), guard = 0; f && guard < 50; f = f.parent_id ? byId.get(f.parent_id) : null, guard++) parts.unshift(f.name);
    return parts.join(' / ');
  };
  const rootLabel = () => t('rlib.root');
  const announce = (msg) => { const el = $('live'); if (el) { el.textContent = ''; setTimeout(() => { el.textContent = msg; }, 30); } };
  const views = cfg.views || [];
  const viewById = (v) => views.find((x) => x.id === v);

  function locationLabel() {
    const l = st.location;
    if (l.kind === 'folder') { const f = folderById().get(l.folderId); return f ? f.name : cfg.allLabel; }
    const v = viewById(l.kind);
    return v ? v.label : cfg.allLabel;
  }

  /* ------------------------------------------------------------ the visible set */
  function visible() {
    const c = ctx();
    let list = items;
    const l = st.location;
    const q = st.q.trim().toLowerCase();
    // A search spans the whole library, like the Content Library's (#214); a quick view still applies.
    if (l.kind === 'folder' && !q) list = list.filter((x) => placements[x.id] === l.folderId);
    else if (viewById(l.kind)) list = list.filter((x) => viewById(l.kind).test(x, c));
    if (q) list = list.filter((x) => `${nameOf(x)} ${cfg.searchText ? cfg.searchText(x) : ''}`.toLowerCase().includes(q));
    for (const f of cfg.filters || []) {
      const v = st.filters[f.id];
      if (v && v !== 'all') list = list.filter((x) => f.test(x, v, c));
    }
    const sort = (cfg.sorts || []).find((s) => s[0] === st.sort) || (cfg.sorts || [])[0];
    if (sort) list = [...list].sort((a, b) => sort[2](a, b, c) || nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base' }));
    return list;
  }
  const filtersActive = () => Object.values(st.filters).some((v) => v && v !== 'all');

  /* ------------------------------------------------------------ nav */
  function renderNav() {
    const nav = $('nav');
    if (!nav) return;
    const l = st.location;
    const c = ctx();
    const counts = new Map();
    for (const x of items) { const f = placements[x.id]; if (f) counts.set(f, (counts.get(f) || 0) + 1); }
    const item = (kind, icon, label, count) => `
      <li><button type="button" class="lib-nav-item${l.kind === kind ? ' is-current' : ''}" data-nav="${esc(kind)}" ${l.kind === kind ? 'aria-current="page"' : ''}>
        ${icon}<span class="lib-nav-label">${esc(label)}</span>${loadedItems ? `<span class="lib-nav-count">${esc(count)}</span>` : ''}
      </button></li>`;
    const tree = treeOrder(folders);
    const byId = folderById();
    const hasKids = new Set(folders.map((f) => f.parent_id).filter(Boolean));
    const shown = tree.filter((f) => {
      for (let p = f.parent_id && byId.get(f.parent_id); p; p = p.parent_id && byId.get(p.parent_id)) if (!st.expanded.has(p.id)) return false;
      return true;
    });
    const note = cfg.viewNote ? cfg.viewNote(c) : '';
    nav.innerHTML = `
      <ul class="lib-nav-list">
        ${item('all', ICONS.all, cfg.allLabel, items.length)}
        ${views.map((v) => item(v.id, ICONS[v.icon || v.id] || ICONS.recent, v.label, items.filter((x) => v.test(x, c)).length)).join('')}
      </ul>
      ${note ? `<p class="lib-nav-note">${esc(note)}</p>` : ''}
      <h2 class="lib-nav-heading" id="${id('fh')}">${esc(t('library.nav.folders'))}</h2>
      <button type="button" class="lib-nav-folders-btn" data-folders-toggle aria-expanded="${st.navOpen}" aria-controls="${id('tree')}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><polyline points="${st.navOpen ? '6 9 12 15 18 9' : '9 6 15 12 9 18'}"/></svg>
        ${esc(t('library.nav.folders'))}${l.kind === 'folder' ? `<span class="lib-muted"> · ${esc(locationLabel())}</span>` : ''}
      </button>
      <div class="lib-nav-folders${st.navOpen ? ' is-open' : ''}" id="${id('tree')}">
        ${folders.length ? '' : `<p class="lib-nav-note">${esc(t('rlib.no_folders'))}</p>`}
        <ul class="lib-tree" aria-labelledby="${id('fh')}">
          ${shown.map((f) => {
            const current = l.kind === 'folder' && l.folderId === f.id;
            const open = st.expanded.has(f.id);
            return `<li class="lib-tree-row" style="--depth:${Number(f.depth) || 0}">
              ${hasKids.has(f.id) ? `<button type="button" class="lib-tree-toggle" data-toggle="${esc(f.id)}" aria-expanded="${open}" aria-label="${esc(t(open ? 'library.nav.collapse' : 'library.nav.expand', { name: f.name }))}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><polyline points="${open ? '6 9 12 15 18 9' : '9 6 15 12 9 18'}"/></svg></button>` : '<span class="lib-tree-spacer"></span>'}
              <button type="button" class="lib-nav-item lib-folder${current ? ' is-current' : ''}" data-folder="${esc(f.id)}" ${current ? 'aria-current="page"' : ''} title="${esc(folderPath(f.id))}">
                ${ICONS.folder}<span class="lib-nav-label">${esc(f.name)}</span><span class="lib-nav-count">${esc(counts.get(f.id) || 0)}</span>
              </button>
            </li>`;
          }).join('')}
        </ul>
        ${canWrite() ? `<button type="button" class="lib-nav-new" data-new-folder>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          ${esc(t('library.nav.new_folder'))}</button>` : ''}
      </div>`;
    nav.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => go({ kind: b.dataset.nav, folderId: null })));
    nav.querySelectorAll('[data-folder]').forEach((b) => {
      b.addEventListener('click', () => go({ kind: 'folder', folderId: b.dataset.folder }));
      dropTarget(b, b.dataset.folder);
    });
    nav.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
      const fid = b.dataset.toggle;
      if (st.expanded.has(fid)) st.expanded.delete(fid); else st.expanded.add(fid);
      renderNav();
      nav.querySelector(`[data-toggle="${CSS.escape(fid)}"]`)?.focus();
    }));
    nav.querySelector('[data-new-folder]')?.addEventListener('click', () => newFolder());
    nav.querySelector('[data-folders-toggle]').addEventListener('click', () => { st.navOpen = !st.navOpen; renderNav(); nav.querySelector('[data-folders-toggle]')?.focus(); });
    // All takes a drop too: it files the item at the root.
    const allBtn = nav.querySelector('[data-nav="all"]');
    if (allBtn) dropTarget(allBtn, null);
  }

  function dropTarget(el, folderId) {
    if (!canWrite()) return;
    el.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes(dragType)) return;
      e.preventDefault();
      el.classList.add('is-droptarget');
    });
    el.addEventListener('dragleave', () => el.classList.remove('is-droptarget'));
    el.addEventListener('drop', (e) => {
      el.classList.remove('is-droptarget');
      const dragged = e.dataTransfer.getData(dragType);
      if (!dragged) return;
      e.preventDefault();
      const ids = st.selected.has(dragged) ? [...st.selected] : [dragged];
      moveItems(ids, folderId);
    });
  }

  function go(loc) {
    st.location = loc;
    if (loc.kind === 'folder') {
      const byId = folderById();
      for (let f = byId.get(loc.folderId); f && f.parent_id; f = byId.get(f.parent_id)) st.expanded.add(f.parent_id);
    }
    scopeChanged();
  }

  // The scope changed: back to the first page, and the selection is cleared (out loud).
  function scopeChanged() {
    st.shown = PAGE;
    if (st.selected.size) { st.selected.clear(); announce(t('library.selection_cleared')); }
    render();
  }

  /* ------------------------------------------------------------ chrome */
  function renderChrome(list) {
    const count = $('count');
    if (count) count.textContent = loadedItems ? t(list.length === 1 ? 'library.count_one' : 'library.count_other', { count: list.length }) : t('common.loading');

    const chips = $('chips');
    if (chips) {
      const active = [];
      if (st.q) active.push(['q', t('library.chip.search', { q: st.q })]);
      for (const f of cfg.filters || []) {
        const v = st.filters[f.id];
        if (v && v !== 'all') active.push(['f:' + f.id, t('rlib.chip', { label: f.label, v: (f.options.find((o) => o[0] === v) || [, v])[1] })]);
      }
      chips.hidden = !active.length;
      chips.innerHTML = active.length ? `<ul class="lib-chips" aria-label="${esc(t('library.chip.label'))}">${active.map(([k, text]) => `<li class="lib-chip">${esc(text)}<button type="button" class="lib-chip-x" data-clear="${esc(k)}" aria-label="${esc(t('library.chip.remove', { what: text }))}">×</button></li>`).join('')}</ul>
        <button type="button" class="lib-link-btn" data-clear="all">${esc(t('library.clear_filters'))}</button>` : '';
      chips.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', () => clear(b.dataset.clear)));
    }

    const crumb = $('crumb');
    if (crumb) {
      const l = st.location;
      const parts = [{ label: cfg.allLabel, nav: { kind: 'all' } }];
      if (viewById(l.kind)) parts.push({ label: locationLabel() });
      if (l.kind === 'folder') {
        const byId = folderById();
        const path = [];
        for (let f = byId.get(l.folderId); f; f = f.parent_id ? byId.get(f.parent_id) : null) path.unshift(f);
        for (const f of path) parts.push({ label: f.name, nav: { kind: 'folder', folderId: f.id } });
      }
      const last = parts.length - 1;
      crumb.innerHTML = `
        <nav aria-label="${esc(t('library.breadcrumb'))}"><ol class="lib-crumbs">${parts.map((p, i) => `<li>${i === last
          ? `<span aria-current="location">${esc(p.label)}</span>`
          : `<button type="button" class="lib-crumb" data-crumb="${i}">${esc(p.label)}</button>`}</li>`).join('')}</ol></nav>
        ${st.q && l.kind === 'folder' ? `<span class="lib-muted">${esc(t('rlib.search_all_note'))}</span>` : ''}
        ${l.kind === 'folder' && canWrite() ? `<button type="button" class="lib-icon-btn" data-folder-menu aria-haspopup="menu" aria-expanded="false" aria-label="${esc(t('library.folder.actions', { name: locationLabel() }))}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></button>` : ''}`;
      crumb.querySelectorAll('[data-crumb]').forEach((b) => {
        const p = parts[Number(b.dataset.crumb)];
        b.addEventListener('click', () => go({ kind: p.nav.kind, folderId: p.nav.folderId || null }));
        if (p.nav.kind === 'all' || p.nav.kind === 'folder') dropTarget(b, p.nav.folderId || null);
      });
      crumb.querySelector('[data-folder-menu]')?.addEventListener('click', (e) => openMenu(e.currentTarget, [
        { label: t('library.folder.new_sub'), onSelect: () => newFolder(l.folderId) },
        { label: t('library.folder.rename'), onSelect: () => renameFolder(l.folderId) },
        { label: t('rlib.folder.move'), onSelect: () => moveFolder(l.folderId) },
        { label: t('library.folder.delete'), danger: true, separatorBefore: true, onSelect: () => deleteFolder(l.folderId) },
      ], { label: t('library.folder.actions', { name: locationLabel() }) }));
    }
    renderBulk(list);
  }

  function clear(k) {
    if (k === 'q' || k === 'all') { st.q = ''; const box = $('q'); if (box) box.value = ''; }
    for (const f of cfg.filters || []) {
      if (k === 'all' || k === 'f:' + f.id) { st.filters[f.id] = 'all'; const sel = $('f-' + f.id); if (sel) sel.value = 'all'; }
    }
    scopeChanged();
    $('q')?.focus();
  }

  function renderBulk(list) {
    const bar = $('bulk');
    if (!bar) return;
    // Selected items that are gone (deleted, or hidden by the page) leave the selection.
    const present = new Set(items.map((x) => x.id));
    for (const sid of [...st.selected]) if (!present.has(sid)) st.selected.delete(sid);
    const n = st.selected.size;
    if (!n || !canWrite()) { bar.hidden = true; bar.innerHTML = ''; return; }
    const selectable = list.filter(canFile);
    const allShown = selectable.length > 0 && selectable.every((x) => st.selected.has(x.id));
    bar.hidden = false;
    bar.innerHTML = `
      <strong class="lib-bulk-count">${esc(t(n === 1 ? 'library.bulk.selected_one' : 'library.bulk.selected_other', { count: n }))}</strong>
      ${!allShown ? `<button type="button" class="lib-link-btn" data-bulk="all">${esc(t('rlib.select_shown', { count: selectable.length }))}</button>` : ''}
      <div class="lib-bulk-actions">
        <button type="button" class="btn btn-secondary btn-sm" data-bulk="move">${esc(t('rlib.move_to_folder'))}</button>
        <button type="button" class="btn btn-secondary btn-sm" data-bulk="clear">${esc(t('library.bulk.clear'))}</button>
      </div>`;
    bar.querySelector('[data-bulk="all"]')?.addEventListener('click', () => { for (const x of selectable) st.selected.add(x.id); render(); });
    bar.querySelector('[data-bulk="clear"]').addEventListener('click', () => { st.selected.clear(); announce(t('library.selection_cleared')); render(); });
    bar.querySelector('[data-bulk="move"]').addEventListener('click', () => moveDialog([...st.selected]));
  }

  /* ------------------------------------------------------------ results */
  const helpers = {
    // A selection box for one item, or '' when it cannot be filed (read-only, platform template).
    selectBox(x) {
      if (!canFile(x)) return '';
      return `<label class="rl-check" title="${esc(t('rlib.select_item', { name: nameOf(x) }))}"><input type="checkbox" class="lib-check" data-rl-select="${esc(x.id)}" ${st.selected.has(x.id) ? 'checked' : ''} aria-label="${esc(t('rlib.select_item', { name: nameOf(x) }))}"></label>`;
    },
    // Attributes that make a card draggable onto a folder.
    dragAttrs(x) { return canFile(x) ? `draggable="true" data-rl-drag="${esc(x.id)}"` : ''; },
    // Where the item is filed, as a small line, when the page is not already showing that folder.
    folderLine(x) {
      const fid = placements[x.id];
      if (!fid || (st.location.kind === 'folder' && st.location.folderId === fid && !st.q)) return '';
      return `<span class="rl-folder-line" title="${esc(t('rlib.in_folder', { path: folderPath(fid) }))}">${ICONS.folder}<span>${esc(folderPath(fid))}</span></span>`;
    },
    folderIdOf: (x) => placements[x.id] || null,
    usageOf: (x) => usage[x.id] || 0,
    isSelected: (x) => st.selected.has(x.id),
    moveOne: (x) => moveDialog([x.id]),
  };

  function renderResults(list) {
    const box = $('results');
    if (!box) return;
    const more = $('more');
    if (!loadedItems) { box.innerHTML = `<div class="lib-state"><p>${esc(t('common.loading'))}</p></div>`; if (more) more.innerHTML = ''; return; }
    if (!items.length) { box.innerHTML = cfg.emptyHtml ? cfg.emptyHtml() : `<div class="lib-state"><p>${esc(t('rlib.empty'))}</p></div>`; if (more) more.innerHTML = ''; return; }
    if (!list.length) {
      const filtering = !!st.q || filtersActive();
      const inFolder = st.location.kind === 'folder';
      box.innerHTML = `<div class="lib-state"><h2>${esc(t(filtering ? 'rlib.empty_filtered' : inFolder ? 'rlib.empty_folder' : 'rlib.empty_view'))}</h2>
        ${inFolder && !filtering ? `<p>${esc(t('rlib.empty_folder_hint'))}</p>` : ''}
        ${filtering ? `<button type="button" class="btn btn-secondary" data-clear-all>${esc(t('library.clear_filters'))}</button>` : ''}</div>`;
      box.querySelector('[data-clear-all]')?.addEventListener('click', () => clear('all'));
      if (more) more.innerHTML = '';
      return;
    }
    const page = list.slice(0, st.shown);
    cfg.renderItems(box, page, helpers);
    if (more) {
      const left = list.length - page.length;
      more.innerHTML = left > 0 ? `<button type="button" class="btn btn-secondary" data-more>${esc(t('rlib.show_more', { count: Math.min(left, PAGE), left }))}</button>` : '';
      more.querySelector('[data-more]')?.addEventListener('click', () => { st.shown += PAGE; render(); });
    }
  }

  function render() {
    const list = visible();
    renderNav();
    renderChrome(list);
    renderResults(list);
  }

  /* ------------------------------------------------------------ wiring */
  const results = $('results');
  results.addEventListener('change', (e) => {
    const cb = e.target.closest && e.target.closest('[data-rl-select]');
    if (!cb) return;
    if (cb.checked) st.selected.add(cb.dataset.rlSelect); else st.selected.delete(cb.dataset.rlSelect);
    renderBulk(visible());
    cb.closest('.rl-item')?.classList.toggle('is-selected', cb.checked);
  });
  results.addEventListener('dragstart', (e) => {
    const el = e.target.closest && e.target.closest('[data-rl-drag]');
    if (!el) return;
    e.dataTransfer.setData(dragType, el.dataset.rlDrag);
    e.dataTransfer.effectAllowed = 'move';
  });

  const box = $('q');
  box.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const v = box.value;
    searchTimer = setTimeout(() => { if (v.trim() !== st.q) { st.q = v.trim(); scopeChanged(); } }, 200);
  });
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape' && box.value) { e.preventDefault(); box.value = ''; st.q = ''; scopeChanged(); } });
  for (const f of cfg.filters || []) {
    $('f-' + f.id)?.addEventListener('change', (e) => { st.filters[f.id] = e.target.value; scopeChanged(); });
  }
  $('sort')?.addEventListener('change', (e) => { st.sort = e.target.value; st.shown = PAGE; render(); });

  /* ------------------------------------------------------------ folders and moves */
  async function loadFolders() {
    try {
      const r = await api.getLibraryFolders(cfg.kind);
      folders = (r && r.folders) || [];
      placements = (r && r.placements) || {};
      usage = (r && r.usage) || {};
      recentDays = (r && r.recent_days) || 7;
    } catch (_) { /* the nav keeps what it had; the items still show */ }
    if (st.location.kind === 'folder' && !folderById().has(st.location.folderId)) st.location = { kind: 'all', folderId: null };
    render();
  }

  function folderOptions(selectedId, exclude = new Set()) {
    const opts = [{ id: '', name: rootLabel(), depth: 0 }, ...treeOrder(folders).filter((f) => !exclude.has(f.id)).map((f) => ({ ...f, depth: f.depth + 1 }))];
    return `<fieldset class="lib-dest-list"><legend class="lib-visually-hidden">${esc(t('library.move.legend'))}</legend>
      ${opts.map((o) => `<label class="lib-dest-opt" style="padding-left:${12 + o.depth * 18}px"><input type="radio" name="${id('dest')}" value="${esc(o.id)}" ${(selectedId || '') === o.id ? 'checked' : ''}><span>${esc(o.name)}</span></label>`).join('')}
    </fieldset>`;
  }

  function pickFolder({ title, current, exclude, ok }) {
    return new Promise((resolve) => {
      let answer;
      const d = openDialog({
        title,
        html: `${folderOptions(current, exclude)}
          <div class="lib-dialog-actions"><span class="lib-form-error" role="alert" data-err></span>
            <button type="button" class="btn btn-secondary" data-cancel>${esc(t('common.cancel'))}</button>
            <button type="button" class="btn btn-primary" data-ok>${esc(ok)}</button></div>`,
        onRequestClose: () => { resolve(answer); return true; },
      });
      d.root.querySelector('[data-cancel]').addEventListener('click', () => d.requestClose('cancel'));
      d.root.querySelector('[data-ok]').addEventListener('click', () => {
        const v = d.root.querySelector(`input[name="${CSS.escape(id('dest'))}"]:checked`);
        if (!v) { d.root.querySelector('[data-err]').textContent = t('library.move.choose'); return; }
        answer = { folderId: v.value || null };
        d.requestClose('ok');
      });
    });
  }

  async function moveItems(ids, folderId) {
    try {
      const r = await api.moveLibraryItems(cfg.kind, ids, folderId);
      const n = (r && r.moved) || ids.length;
      showToast(folderId ? t('library.bulk.moved', { count: n, folder: folderPath(folderId) }) : t('rlib.moved_root', { count: n }), 'success');
      if (ids.length > 1) st.selected.clear();
      await loadFolders();
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function moveDialog(ids) {
    const one = ids.length === 1 ? items.find((x) => x.id === ids[0]) : null;
    const r = await pickFolder({
      title: one ? t('library.move.title_one', { name: nameOf(one) }) : t('library.move.title_other', { count: ids.length }),
      current: one ? placements[one.id] || '' : null,
      ok: t('library.move.ok'),
    });
    if (r) await moveItems(ids, r.folderId);
  }

  function textPrompt({ title, label, value = '', ok, extraHtml = '' }) {
    return new Promise((resolve) => {
      let result = null;
      const inputId = id('prompt');
      const d = openDialog({
        title, size: 'sm',
        html: `<form novalidate data-form><div class="lib-field"><label for="${inputId}">${esc(label)}</label>
          <input id="${inputId}" class="input" value="${esc(value)}" maxlength="100" autocomplete="off" aria-describedby="${inputId}-err">
          <div class="lib-field-err" id="${inputId}-err" role="alert"></div></div>${extraHtml}
          <div class="lib-dialog-actions"><button type="button" class="btn btn-secondary" data-cancel>${esc(t('common.cancel'))}</button>
          <button type="submit" class="btn btn-primary">${esc(ok)}</button></div></form>`,
        initialFocus: '#' + CSS.escape(inputId),
        onRequestClose: () => { resolve(result); return true; },
      });
      d.root.querySelector('[data-cancel]').addEventListener('click', () => d.requestClose('cancel'));
      d.root.querySelector('[data-form]').addEventListener('submit', (e) => {
        e.preventDefault();
        const v = d.root.querySelector('#' + CSS.escape(inputId)).value.trim();
        if (!v) { d.root.querySelector('#' + CSS.escape(inputId + '-err')).textContent = t('library.folder.err_name'); return; }
        const parent = d.root.querySelector('[data-parent]');
        result = { value: v, parent: parent ? parent.value : null };
        d.requestClose('ok');
      });
    });
  }

  async function newFolder(parentId = st.location.kind === 'folder' ? st.location.folderId : null) {
    const parentSel = `<div class="lib-field"><label for="${id('parent')}">${esc(t('library.folder.inside'))}</label>
      <select id="${id('parent')}" data-parent class="input"><option value="">${esc(rootLabel())}</option>
      ${treeOrder(folders).map((f) => `<option value="${esc(f.id)}" ${f.id === parentId ? 'selected' : ''}>${esc(folderPath(f.id))}</option>`).join('')}</select></div>`;
    const r = await textPrompt({ title: t('library.folder.new_title'), label: t('library.folder.name'), ok: t('library.folder.create'), extraHtml: parentSel });
    if (!r) return;
    try {
      const f = await api.createLibraryFolder(cfg.kind, r.value, r.parent || null);
      showToast(t('content.toast.folder_created_named', { name: r.value }), 'success');
      if (r.parent) st.expanded.add(r.parent);
      await loadFolders();
      if (f && f.id) go({ kind: 'folder', folderId: f.id });
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function renameFolder(fid) {
    const f = folderById().get(fid);
    if (!f) return;
    const r = await textPrompt({ title: t('library.folder.rename_title'), label: t('library.folder.name'), value: f.name, ok: t('library.folder.rename_ok') });
    if (!r || r.value === f.name) return;
    try {
      await api.updateLibraryFolder(cfg.kind, fid, { name: r.value });
      showToast(t('content.toast.folder_renamed'), 'success');
      await loadFolders();
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function moveFolder(fid) {
    const f = folderById().get(fid);
    if (!f) return;
    // Not into itself or anything inside it.
    const exclude = new Set([fid]);
    let grew = true;
    while (grew) { grew = false; for (const x of folders) if (x.parent_id && exclude.has(x.parent_id) && !exclude.has(x.id)) { exclude.add(x.id); grew = true; } }
    const r = await pickFolder({ title: t('rlib.folder.move_title', { name: f.name }), current: f.parent_id || '', exclude, ok: t('library.move.ok') });
    if (!r || (r.folderId || null) === (f.parent_id || null)) return;
    try {
      await api.updateLibraryFolder(cfg.kind, fid, { parent_id: r.folderId });
      if (r.folderId) st.expanded.add(r.folderId);
      showToast(t('rlib.folder.moved'), 'success');
      await loadFolders();
      go({ kind: 'folder', folderId: fid });
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function deleteFolder(fid) {
    const f = folderById().get(fid);
    if (!f) return;
    const ok = await confirmDialog({
      title: t('library.folder.delete_title', { name: f.name }),
      bodyHtml: esc(t('rlib.folder.delete_body', { parent: f.parent_id ? folderPath(f.parent_id) : rootLabel() })),
      confirmLabel: t('library.folder.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteLibraryFolder(cfg.kind, fid);
      showToast(t('content.toast.folder_deleted'), 'success');
      st.location = f.parent_id ? { kind: 'folder', folderId: f.parent_id } : { kind: 'all', folderId: null };
      await loadFolders();
      scopeChanged();
    } catch (err) { showToast(err.message, 'error'); }
  }

  render();
  loadFolders();

  return {
    /** The page's items, freshly loaded. Everything shown is derived from these. */
    setItems(list) { items = Array.isArray(list) ? list : []; loadedItems = true; render(); },
    /** Re-read folders, placements and usage (after the page changed something that affects usage). */
    reloadFolders: loadFolders,
    /** The folder a new item made on this page should be filed in, or null. */
    currentFolderId() { return st.location.kind === 'folder' ? st.location.folderId : null; },
    /** File a just-created item into the open folder, so it appears where it was made. */
    async fileNew(itemId) {
      const fid = st.location.kind === 'folder' ? st.location.folderId : null;
      if (!fid || !itemId) return;
      try { await api.moveLibraryItems(cfg.kind, [itemId], fid); placements[itemId] = fid; } catch (_) { /* it stays at the root */ }
    },
    destroy() { clearTimeout(searchTimer); closeMenu(); },
  };
}

function selectHtml(selId, label, options, value) {
  return `<div class="lib-select">
    <label for="${esc(selId)}" class="lib-visually-hidden">${esc(label)}</label>
    <select id="${esc(selId)}" class="input" title="${esc(label)}">${options.map(([v, text]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select>
  </div>`;
}
