import { api, assertLocalCallAllowed } from '../api.js';
import * as gettingStarted from '../components/getting-started.js';
import { showToast } from '../components/toast.js';
import { esc, hydrateAuthImages } from '../utils.js';
import { t } from '../i18n.js';
import { openHistoryModal } from '../components/history-modal.js';
import { isPdf, renderPdfToPages, baseName } from '../components/pdf-pages.js';
import { reportConnectResult, loadCanvaLinks, syncCanvaLink, openCanvaPicker } from '../components/canva-import.js';
import { openDialog, confirmDialog } from '../components/library/dialog.js';
import { openMenu, closeMenu } from '../components/library/menu.js';
import { openAddContent, treeOrder } from '../components/library/add-content.js';
import { createInspector } from '../components/library/inspector.js';
import * as uploads from '../components/library/upload-queue.js';
import {
  typeOf, statusOf, durationOf, dimensionsOf, detailLine, usageText, thumbOf, typeIcon, isStoredFile,
} from '../components/library/content-meta.js';

/*
 * The Content Library.
 *
 *   nav        All content · Recently added · Unused, then the folder tree (one location at a time)
 *   header     the title, the result count, one "Add content" button (components/library/add-content.js)
 *   toolbar    search, grouped filters (type, status, usage), sort, grid/list
 *   results    one result set and one selection, shown as a grid or a table; paged by the server
 *   inspector  "Content details" for the item opened (components/library/inspector.js)
 *
 * Folder semantics are the server's, unchanged: a folder shows the items filed DIRECTLY in it, and a
 * search spans the whole workspace (routes/content.js #214). "All content" is the whole workspace —
 * what its count says — and new items made there go to the root.
 *
 * State lives at module scope, so leaving the page and coming back keeps the place, as before.
 */

/* The mime lib/html-bundle.js stamps on an uploaded HTML bundle. Kept as a constant rather than
 * spelled out at each site: it is compared in three places here, and a typo in one of them is a
 * card that renders an <img> pointed at a zip. */
const BUNDLE_MIME = 'application/vnd.screentinker.bundle+zip';

// #216: languages offered in the caption/subtitle pickers. Codes are BCP-47 primary tags —
// enough for signage; extend as needed.
const SUBTITLE_LANGS = [
  ['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'],
  ['pt', 'Português'], ['it', 'Italiano'], ['nl', 'Nederlands'], ['ja', '日本語'],
  ['ko', '한국어'], ['zh', '中文'],
];

const PAGE_SIZE = 48;
const VIEW_KEY = 'st.library.view';

// Epoch seconds -> a <input type="datetime-local"> value in the viewer's LOCAL wall-clock
// (YYYY-MM-DDTHH:MM). Empty string for no expiry.
function toLocalDatetimeInput(epochSec) {
  if (epochSec == null || epochSec === '') return '';
  const d = new Date(Number(epochSec) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function metaToLines(meta) {
  if (!meta || typeof meta !== 'object') return '';
  return Object.entries(meta).map(([k, v]) => `${k}=${v}`).join('\n');
}

function readView() { try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid'; } catch (_) { return 'grid'; } }
function writeView(v) { try { localStorage.setItem(VIEW_KEY, v); } catch (_) { /* private mode */ } }

// The server enforces every write; this only hides controls a read-only member could not use.
function canWrite() {
  try {
    const u = JSON.parse(localStorage.getItem('user') || 'null');
    if (!u) return true;
    return !(u.current_workspace_role === 'workspace_viewer' && !u.acting_as);
  } catch (_) { return true; }
}

// View state. Module scope so the router's re-render (and a return visit) keeps the place.
const state = {
  location: { kind: 'all', folderId: null },   // all | recent | unused | folder
  q: '',
  type: 'all',
  status: 'all',
  usage: 'all',
  sort: 'date_desc',
  view: readView(),
  offset: 0,
  items: [],
  total: 0,
  loading: false,
  error: null,
  legacy: false,          // the server answered with a bare array (an older remote node)
  summary: null,
  folders: [],
  expanded: new Set(),
  selected: new Map(),    // id -> row, across pages, cleared when the scope changes
  lastClickedId: null,
  canvaLinks: new Map(),
  openId: null,
  pendingDraft: null,     // unsaved inspector edits kept across leaving the page
};
let reqSeq = 0;
let inflight = null;
let searchTimer = null;
let inspector = null;
let unsubscribeUploads = null;
let reloadTimer = null;
let navFoldersOpen = false;   // narrow screens only: is the folder tree unfolded

const TYPE_FILTERS = [
  ['all', 'content.filter_type_all'], ['image', 'content.filter_type_image'], ['video', 'content.filter_type_video'],
  ['audio', 'library.filter.audio'], ['youtube', 'content.filter_type_youtube'], ['live', 'content.filter_type_live'],
  ['hdmi', 'library.filter.hdmi'], ['web', 'content.filter_type_web'], ['bundle', 'content.filter_type_bundle'], ['hold', 'library.filter.hold'],
];
const STATUS_FILTERS = [['all', 'library.filter.status_all'], ['ready', 'library.status.ready'], ['review', 'library.status.review'], ['attention', 'library.status.attention'], ['expired', 'library.status.expired']];
const USAGE_FILTERS = [['all', 'library.filter.usage_all'], ['used', 'library.filter.used'], ['unused', 'library.usage.unused']];
const SORTS = [
  ['date_desc', 'content.sort_newest'], ['date_asc', 'content.sort_oldest'], ['name', 'content.sort_name'], ['name_desc', 'library.sort.name_desc'],
  ['size', 'content.sort_size'], ['size_asc', 'library.sort.size_asc'], ['duration_desc', 'library.sort.duration_desc'], ['duration', 'library.sort.duration_asc'],
  ['type', 'library.sort.type'], ['dims_desc', 'library.sort.dims_desc'],
];
// Table headers and the sort each one toggles between (first click = the first of the pair).
const COLUMN_SORTS = { name: ['name', 'name_desc'], type: ['type', 'type_desc'], duration: ['duration', 'duration_desc'], dimensions: ['dims', 'dims_desc'] };

const folderById = () => new Map(state.folders.map((f) => [f.id, f]));
const rootLabel = () => t('library.root');

// Build a "Parent / Child / Leaf" path for a folder. Exported for the components.
function folderPathOf(f) { return folderPath(f, state.folders); }

function destination() {
  if (state.location.kind === 'folder') {
    const f = folderById().get(state.location.folderId);
    if (f) return { folderId: f.id, label: folderPathOf(f) };
  }
  return { folderId: null, label: rootLabel() };
}

function locationLabel() {
  const l = state.location;
  if (l.kind === 'recent') return t('library.nav.recent');
  if (l.kind === 'unused') return t('library.nav.unused');
  if (l.kind === 'folder') { const f = folderById().get(l.folderId); return f ? f.name : t('library.nav.all'); }
  return t('library.nav.all');
}

const filtersActive = () => state.type !== 'all' || state.status !== 'all' || state.usage !== 'all';

const $ = (sel) => document.querySelector(sel);
function announce(msg) { const el = $('#libLive'); if (el) { el.textContent = ''; setTimeout(() => { el.textContent = msg; }, 30); } }

export function render(container) {
  container.innerHTML = `
    <div class="lib" id="libRoot">
      <!-- The checklist follows the user here, above everything: arriving from its "Add content"
           step and finding nothing that mentions it is how someone loses the thread. It hides
           itself once the account has nothing left to do. -->
      <div class="lib-gs" id="gettingStarted"></div>
      <div class="lib-layout">
        <nav class="lib-nav" id="libNav" aria-label="${esc(t('library.nav.label'))}"></nav>
        <div class="lib-main" id="libMain">
          <header class="lib-header">
            <div>
              <h1 class="lib-h1">${esc(t('content.title'))}</h1>
              <div class="lib-count" id="libCount" aria-live="polite"></div>
            </div>
            <button type="button" class="btn btn-primary lib-add-btn" id="libAddBtn" ${canWrite() ? '' : 'hidden'}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              ${esc(t('library.add_content'))}
            </button>
          </header>
          <div class="lib-toolbar" role="search" aria-label="${esc(t('library.toolbar_label'))}">
            <div class="lib-search">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <label for="contentSearch" class="lib-visually-hidden">${esc(t('library.search_label'))}</label>
              <input type="search" id="contentSearch" class="input" placeholder="${esc(t('library.search_placeholder'))}" value="${esc(state.q)}" autocomplete="off">
            </div>
            <div class="lib-filters" role="group" aria-label="${esc(t('library.filters_label'))}">
              ${selectHtml('libType', 'library.filter.type_label', TYPE_FILTERS, state.type)}
              ${selectHtml('libStatus', 'library.filter.status_label', STATUS_FILTERS, state.status)}
              ${selectHtml('libUsage', 'library.filter.usage_label', USAGE_FILTERS, state.usage)}
            </div>
            ${selectHtml('libSort', 'library.sort.label', SORTS.concat(SORTS.some((s) => s[0] === state.sort) ? [] : [[state.sort, sortLabelKey(state.sort)]]), state.sort)}
            <div class="lib-viewtoggle" role="group" aria-label="${esc(t('library.view_label'))}">
              <button type="button" class="lib-icon-btn" data-view="grid" aria-pressed="${state.view === 'grid'}" aria-label="${esc(t('library.view_grid'))}">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
              </button>
              <button type="button" class="lib-icon-btn" data-view="list" aria-pressed="${state.view === 'list'}" aria-label="${esc(t('library.view_list'))}">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg>
              </button>
            </div>
          </div>
          <div class="lib-chiprow" id="libChips"></div>
          <div class="lib-crumbrow" id="folderBreadcrumb"></div>
          <div class="lib-bulkbar" id="batchToolbar" hidden></div>
          <div class="lib-results" id="contentGrid" aria-busy="true"></div>
          <div class="lib-pager" id="libPager"></div>
          <div class="lib-drop-overlay" id="libDropOverlay" hidden><div class="lib-drop-card">${typeIcon('image', 40)}<div id="libDropText"></div></div></div>
        </div>
        <aside class="lib-inspector" id="libInspector" hidden></aside>
      </div>
      <input type="file" id="fileInput" hidden multiple accept="video/*,image/*,audio/*,.zip,.wgt,.pdf,application/pdf">
      <div class="lib-visually-hidden" id="libLive" role="status" aria-live="polite"></div>
    </div>`;

  /*
   * The checklist, if this account still has one. Fire-and-forget: it fetches devices and
   * playlists (never content — the caller has none to give here and getContent is this page's own
   * expensive call), and hides itself when there is nothing left to do.
   */
  gettingStarted.mount(document.getElementById('gettingStarted'), {
    // Step 2 points at this page, so its button must DO something here rather than re-navigate to
    // the page it is already on: it opens Add content, inside the user's click.
    onAction: (a) => {
      if (a === 'add-content') { openAdd(); return true; }
      return false;
    },
  }).catch(() => {});

  reportConnectResult();

  inspector = createInspector(document.getElementById('libInspector'), {
    folders: () => state.folders,
    folderPath: folderPathOf,
    rootLabel: rootLabel(),
    canWrite,
    menuItems: (c, anchor, o) => itemMenu(c, anchor, o),
    onSaved: () => { scheduleReload(); },
    onReplaced: () => { scheduleReload(); },
    onClose: () => { state.openId = null; markOpen(); },
    onPreviewBundle: (c) => showPreview(c),
  });

  // PDFs: the queue hands them back here (pages → folder → playlist, below).
  uploads.setPdfImporter(importPdf);
  if (unsubscribeUploads) unsubscribeUploads();
  unsubscribeUploads = uploads.onUploaded(() => scheduleReload());

  wireToolbar();
  wireDrop();
  const fileInput = document.getElementById('fileInput');
  fileInput.addEventListener('change', () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    handleFiles(files, destination());
  });
  document.getElementById('libAddBtn').addEventListener('click', () => openAdd());

  renderNav();
  renderChrome();
  loadContent();
  loadNav();
}

function selectHtml(id, labelKey, options, value) {
  return `<div class="lib-select">
    <label for="${id}" class="lib-visually-hidden">${esc(t(labelKey))}</label>
    <select id="${id}" class="input">${options.map(([v, k]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${esc(t(k))}</option>`).join('')}</select>
  </div>`;
}
function sortLabelKey(s) {
  return ({ type_desc: 'library.sort.type_desc', dims: 'library.sort.dims_asc' })[s] || 'content.sort_newest';
}

/* ================================ loading ================================ */

async function loadNav() {
  try {
    const [folders, summary] = await Promise.all([api.getFolders(), api.getLibrarySummary().catch(() => null)]);
    state.folders = folders || [];
    state.summary = summary;
  } catch (_) { /* the nav keeps what it had */ }
  // A folder that no longer exists (deleted elsewhere) returns the page to All content.
  if (state.location.kind === 'folder' && !folderById().has(state.location.folderId)) {
    state.location = { kind: 'all', folderId: null };
    loadContent();
  }
  renderNav();
  renderChrome();
}

/**
 * One page of results for the current scope. Newer requests win: an older answer that arrives late
 * (a slow search overtaken by the next keystroke) is aborted, and ignored if it lands anyway.
 */
async function loadContent() {
  const grid = document.getElementById('contentGrid');
  if (!grid) return;
  const my = ++reqSeq;
  if (inflight) inflight.abort();
  inflight = new AbortController();
  state.loading = true;
  state.error = null;
  grid.setAttribute('aria-busy', 'true');
  if (!state.items.length) renderResults();
  const l = state.location;
  const query = {
    q: state.q,
    folderId: l.kind === 'folder' ? l.folderId : undefined,
    scope: l.kind === 'recent' || l.kind === 'unused' ? l.kind : undefined,
    type: state.type, status: state.status, usage: state.usage, sort: state.sort,
    limit: PAGE_SIZE, offset: state.offset,
  };
  try {
    const [page, links] = await Promise.all([api.getLibraryPage(query, inflight.signal), loadCanvaLinks().catch(() => new Map())]);
    if (my !== reqSeq) return;
    if (Array.isArray(page)) { state.items = page; state.total = page.length; state.legacy = true; }
    else { state.items = page.items || []; state.total = page.total || 0; state.legacy = false; }
    state.canvaLinks = links;
    // Asked past the end (the last item on the last page was deleted): go back a page.
    if (!state.items.length && state.offset > 0 && state.total > 0) {
      state.offset = Math.max(0, Math.floor((state.total - 1) / PAGE_SIZE) * PAGE_SIZE);
      state.loading = false;
      return loadContent();
    }
  } catch (err) {
    if (my !== reqSeq || (err && err.name === 'AbortError')) return;
    state.error = err.message || t('content.failed_to_load');
  } finally {
    if (my === reqSeq) { state.loading = false; inflight = null; }
  }
  if (my !== reqSeq) return;
  grid.setAttribute('aria-busy', 'false');
  // Keep the selected rows current (a rename or a move shows in the bulk bar too).
  for (const c of state.items) if (state.selected.has(c.id)) state.selected.set(c.id, c);
  renderChrome();
  renderResults();
  if (inspector && state.openId) {
    const open = state.items.find((c) => c.id === state.openId);
    if (inspector.openId === state.openId) inspector.refresh(open);
    else reopenInspector(open);
  }

  // #313/checklist: adding content ticks a step, and this is the one path every add
  // (file, remote URL, YouTube) already goes through.
  gettingStarted.refresh().catch(() => {});
}

// Back on the page with an item open: open it again (from this page, or fetched), with any
// unsaved edits it had when the page was left.
async function reopenInspector(onPage) {
  let c = onPage;
  if (!c) { try { c = await api.getContentItem(state.openId); } catch (_) { c = null; } }
  if (!c || !inspector) { state.openId = null; state.pendingDraft = null; markOpen(); return; }
  const restoreDraft = state.pendingDraft;
  state.pendingDraft = null;
  await inspector.open(c, { focus: false, restoreDraft });
  markOpen();
}

// Several things finishing at once (a batch of uploads) reload once.
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => { loadContent(); loadNav(); }, 250);
}

/**
 * The scope changed (location, query or a filter): back to page one, and the selection is cleared —
 * out loud, because checked items silently vanishing from a bulk action is worse than either.
 */
function scopeChanged() {
  state.offset = 0;
  if (state.selected.size) {
    state.selected.clear();
    state.lastClickedId = null;
    announce(t('library.selection_cleared'));
  }
  renderNav();
  renderChrome();
  loadContent();
}

async function goLocation(loc) {
  state.location = loc;
  if (loc.kind === 'folder') {
    // Open the path to it in the tree.
    const byId = folderById();
    for (let f = byId.get(loc.folderId); f && f.parent_id; f = byId.get(f.parent_id)) state.expanded.add(f.parent_id);
  }
  scopeChanged();
}

/* ================================ navigation ================================ */

function renderNav() {
  const nav = document.getElementById('libNav');
  if (!nav) return;
  const s = state.summary;
  const l = state.location;
  const item = (kind, icon, label, count) => `
    <li><button type="button" class="lib-nav-item${l.kind === kind ? ' is-current' : ''}" data-nav="${kind}" ${l.kind === kind ? 'aria-current="page"' : ''}>
      ${icon}<span class="lib-nav-label">${esc(label)}</span>${count != null ? `<span class="lib-nav-count">${count}</span>` : ''}
    </button></li>`;
  const icons = {
    all: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    recent: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>',
    unused: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/></svg>',
  };
  const tree = treeOrder(state.folders);
  const hasKids = new Set(state.folders.map((f) => f.parent_id).filter(Boolean));
  const visible = tree.filter((f) => {
    const byId = folderById();
    for (let p = f.parent_id && byId.get(f.parent_id); p; p = p.parent_id && byId.get(p.parent_id)) if (!state.expanded.has(p.id)) return false;
    return true;
  });
  nav.innerHTML = `
    <ul class="lib-nav-list">
      ${item('all', icons.all, t('library.nav.all'), s ? s.all : null)}
      ${item('recent', icons.recent, t('library.nav.recent'), s ? s.recent : null)}
      ${item('unused', icons.unused, t('library.nav.unused'), s ? s.unused : null)}
    </ul>
    ${s ? `<p class="lib-nav-note">${esc(t('library.nav.recent_note', { days: s.recent_days || 7 }))}</p>` : ''}
    <h2 class="lib-nav-heading" id="libFoldersHeading">${esc(t('library.nav.folders'))}</h2>
    <!-- Narrow screens: the tree folds away behind this, so the content comes first. -->
    <button type="button" class="lib-nav-folders-btn" id="libFoldersToggle" aria-expanded="${navFoldersOpen}" aria-controls="libTree">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><polyline points="${navFoldersOpen ? '6 9 12 15 18 9' : '9 6 15 12 9 18'}"/></svg>
      ${esc(t('library.nav.folders'))}${l.kind === 'folder' ? `<span class="lib-muted"> · ${esc(locationLabel())}</span>` : ''}
    </button>
    <div class="lib-nav-folders${navFoldersOpen ? ' is-open' : ''}" id="libTree">
    <ul class="lib-tree" aria-labelledby="libFoldersHeading">
      ${visible.map((f) => {
        const current = l.kind === 'folder' && l.folderId === f.id;
        const open = state.expanded.has(f.id);
        return `<li class="lib-tree-row" style="--depth:${f.depth}">
          ${hasKids.has(f.id) ? `<button type="button" class="lib-tree-toggle" data-toggle="${esc(f.id)}" aria-expanded="${open}" aria-label="${esc(t(open ? 'library.nav.collapse' : 'library.nav.expand', { name: f.name }))}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><polyline points="${open ? '6 9 12 15 18 9' : '9 6 15 12 9 18'}"/></svg></button>` : '<span class="lib-tree-spacer"></span>'}
          <button type="button" class="lib-nav-item lib-folder${current ? ' is-current' : ''}" data-folder="${esc(f.id)}" ${current ? 'aria-current="page"' : ''} title="${esc(folderPathOf(f))}">
            ${icons.all}<span class="lib-nav-label">${esc(f.name)}</span>
          </button>
        </li>`;
      }).join('')}
    </ul>
    ${canWrite() ? `<button type="button" class="lib-nav-new" id="newFolderBtn">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      ${esc(t('library.nav.new_folder'))}</button>` : ''}
    </div>`;

  nav.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => goLocation({ kind: b.dataset.nav, folderId: null })));
  nav.querySelectorAll('[data-folder]').forEach((b) => {
    b.addEventListener('click', () => goLocation({ kind: 'folder', folderId: b.dataset.folder }));
    folderDropTarget(b, b.dataset.folder);
  });
  nav.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.toggle;
    if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
    renderNav();
    nav.querySelector(`[data-toggle="${CSS.escape(id)}"]`)?.focus();
  }));
  nav.querySelector('#newFolderBtn')?.addEventListener('click', (e) => newFolder(e.currentTarget));
  nav.querySelector('#libFoldersToggle').addEventListener('click', () => { navFoldersOpen = !navFoldersOpen; renderNav(); document.getElementById('libFoldersToggle')?.focus(); });
  // "All content" also takes a drop: it files the item at the root.
  const allBtn = nav.querySelector('[data-nav="all"]');
  if (allBtn) folderDropTarget(allBtn, null);
}

// Dragging a card or row onto a folder moves it (and every other selected item, if it is selected).
function folderDropTarget(el, folderId) {
  el.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('text/content-id')) return;
    e.preventDefault();
    el.classList.add('is-droptarget');
  });
  el.addEventListener('dragleave', () => el.classList.remove('is-droptarget'));
  el.addEventListener('drop', async (e) => {
    el.classList.remove('is-droptarget');
    const id = e.dataTransfer.getData('text/content-id');
    if (!id) return;
    e.preventDefault();
    const ids = state.selected.has(id) ? [...state.selected.keys()] : [id];
    try {
      await api.batchMoveContent(ids, folderId);
      showToast(folderId ? t('library.bulk.moved', { count: ids.length, folder: folderPathOf(folderById().get(folderId)) }) : t('library.bulk.moved_root', { count: ids.length }), 'success');
      if (ids.length > 1) state.selected.clear();
      scheduleReload();
    } catch (err) { showToast(err.message, 'error'); }
  });
}

/* ================================ toolbar ================================ */

function wireToolbar() {
  // #214: search queries the server so results span the whole workspace. Debounced; the newest
  // request wins (loadContent aborts the one before).
  const box = document.getElementById('contentSearch');
  box.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const v = box.value;
    searchTimer = setTimeout(() => { if (v.trim() !== state.q) { state.q = v.trim(); scopeChanged(); } }, 300);
  });
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape' && box.value) { e.preventDefault(); box.value = ''; state.q = ''; scopeChanged(); } });
  const bind = (id, key) => document.getElementById(id).addEventListener('change', (e) => { state[key] = e.target.value; scopeChanged(); });
  bind('libType', 'type');
  bind('libStatus', 'status');
  bind('libUsage', 'usage');
  // Sorting reorders the same set: page one again, the selection stays.
  document.getElementById('libSort').addEventListener('change', (e) => { state.sort = e.target.value; state.offset = 0; loadContent(); });
  document.querySelectorAll('.lib-viewtoggle [data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
}

function setView(v) {
  if (state.view === v) return;
  state.view = v;
  writeView(v);
  document.querySelectorAll('.lib-viewtoggle [data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
  renderResults();
}

/* ================================ chrome: count, chips, breadcrumb, bulk bar, pager ================================ */

function renderChrome() {
  // The signed-in user may arrive after the first render (app.js refreshCurrentUser).
  const addBtn = document.getElementById('libAddBtn');
  if (addBtn) addBtn.hidden = !canWrite();
  const count = document.getElementById('libCount');
  if (count) {
    count.textContent = state.loading && !state.items.length ? t('common.loading')
      : t(state.total === 1 ? 'library.count_one' : 'library.count_other', { count: state.total });
  }
  // The sort select shows a header-chosen sort too.
  const sortSel = document.getElementById('libSort');
  if (sortSel && sortSel.value !== state.sort) {
    if (![...sortSel.options].some((o) => o.value === state.sort)) sortSel.insertAdjacentHTML('beforeend', `<option value="${state.sort}">${esc(t(sortLabelKey(state.sort)))}</option>`);
    sortSel.value = state.sort;
  }
  for (const [id, key] of [['libType', 'type'], ['libStatus', 'status'], ['libUsage', 'usage']]) { const el = document.getElementById(id); if (el) el.value = state[key]; }

  // Active filters as removable chips.
  const chips = document.getElementById('libChips');
  if (chips) {
    const label = (list, v) => t((list.find((x) => x[0] === v) || [, ''])[1]);
    const active = [
      state.q ? ['q', t('library.chip.search', { q: state.q })] : null,
      state.type !== 'all' ? ['type', t('library.chip.type', { v: label(TYPE_FILTERS, state.type) })] : null,
      state.status !== 'all' ? ['status', t('library.chip.status', { v: label(STATUS_FILTERS, state.status) })] : null,
      state.usage !== 'all' ? ['usage', t('library.chip.usage', { v: label(USAGE_FILTERS, state.usage) })] : null,
    ].filter(Boolean);
    chips.hidden = !active.length;
    chips.innerHTML = active.length ? `<ul class="lib-chips" aria-label="${esc(t('library.chip.label'))}">${active.map(([k, text]) => `<li class="lib-chip">${esc(text)}<button type="button" class="lib-chip-x" data-clear="${k}" aria-label="${esc(t('library.chip.remove', { what: text }))}">×</button></li>`).join('')}</ul>
      <button type="button" class="lib-link-btn" data-clear="all">${esc(t('library.clear_filters'))}</button>` : '';
    chips.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.clear;
      if (k === 'q' || k === 'all') { state.q = ''; const box = document.getElementById('contentSearch'); if (box) box.value = ''; }
      if (k === 'type' || k === 'all') state.type = 'all';
      if (k === 'status' || k === 'all') state.status = 'all';
      if (k === 'usage' || k === 'all') state.usage = 'all';
      scopeChanged();
      document.getElementById('contentSearch')?.focus();
    }));
  }

  // Breadcrumb: the real current location, and what a search does to it.
  const crumb = document.getElementById('folderBreadcrumb');
  if (crumb) {
    const l = state.location;
    const parts = [{ label: t('library.nav.all'), nav: { kind: 'all' } }];
    if (l.kind === 'recent' || l.kind === 'unused') parts.push({ label: locationLabel() });
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
      ${state.q && l.kind === 'folder' ? `<span class="lib-muted">${esc(t('library.search_all_note'))}</span>` : ''}
      ${l.kind === 'folder' && canWrite() ? `<button type="button" class="lib-icon-btn" id="libFolderMenu" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(t('library.folder.actions', { name: locationLabel() }))}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></button>` : ''}`;
    crumb.querySelectorAll('[data-crumb]').forEach((b) => {
      const p = parts[Number(b.dataset.crumb)];
      b.addEventListener('click', () => goLocation({ kind: p.nav.kind, folderId: p.nav.folderId || null }));
      if (p.nav.kind === 'all' || p.nav.kind === 'folder') folderDropTarget(b, p.nav.folderId || null);
    });
    crumb.querySelector('#libFolderMenu')?.addEventListener('click', (e) => openMenu(e.currentTarget, [
      { label: t('library.folder.new_sub'), onSelect: () => newFolder(e.currentTarget, l.folderId) },
      { label: t('library.folder.rename'), onSelect: () => renameFolder(l.folderId) },
      { label: t('library.folder.delete'), danger: true, separatorBefore: true, onSelect: () => deleteFolder(l.folderId) },
    ], { label: t('library.folder.actions', { name: locationLabel() }) }));
  }

  renderBulkBar();
  renderPager();
}

function renderPager() {
  const el = document.getElementById('libPager');
  if (!el) return;
  if (!state.items.length) { el.innerHTML = ''; return; }
  const from = state.offset + 1, to = state.offset + state.items.length;
  const pages = state.legacy ? 1 : Math.max(1, Math.ceil(state.total / PAGE_SIZE));
  const page = Math.floor(state.offset / PAGE_SIZE) + 1;
  const nums = [];
  for (let p = 1; p <= pages; p++) if (p === 1 || p === pages || Math.abs(p - page) <= 1) nums.push(p); else if (nums[nums.length - 1] !== '…') nums.push('…');
  el.innerHTML = `
    <span class="lib-pager-text">${esc(state.total === 1 ? t('library.showing_one') : t('library.showing', { from, to, total: state.total }))}</span>
    ${pages > 1 ? `<nav class="lib-pages" aria-label="${esc(t('library.pages'))}">
      <button type="button" class="lib-page-btn" data-page="${page - 1}" ${page === 1 ? 'disabled' : ''} aria-label="${esc(t('library.prev_page'))}">‹</button>
      ${nums.map((n) => n === '…' ? '<span class="lib-page-gap" aria-hidden="true">…</span>'
        : `<button type="button" class="lib-page-btn${n === page ? ' is-current' : ''}" data-page="${n}" ${n === page ? 'aria-current="page"' : ''} aria-label="${esc(t('library.page_n', { n }))}">${n}</button>`).join('')}
      <button type="button" class="lib-page-btn" data-page="${page + 1}" ${page === pages ? 'disabled' : ''} aria-label="${esc(t('library.next_page'))}">›</button>
    </nav>` : ''}`;
  el.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => {
    state.offset = (Number(b.dataset.page) - 1) * PAGE_SIZE;
    loadContent().then(() => { document.getElementById('libMain')?.scrollIntoView({ block: 'start' }); document.getElementById('contentGrid')?.focus(); });
  }));
}

function renderBulkBar() {
  const bar = document.getElementById('batchToolbar');
  if (!bar) return;
  const n = state.selected.size;
  if (!n) { bar.hidden = true; bar.innerHTML = ''; return; }
  const pageIds = state.items.map((c) => c.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => state.selected.has(id));
  const w = canWrite();
  bar.hidden = false;
  bar.innerHTML = `
    <strong class="lib-bulk-count" aria-live="polite">${esc(t(n === 1 ? 'library.bulk.selected_one' : 'library.bulk.selected_other', { count: n }))}</strong>
    ${!allOnPage ? `<button type="button" class="lib-link-btn" data-bulk="page">${esc(t('library.bulk.select_page', { count: pageIds.length }))}</button>` : ''}
    <div class="lib-bulk-actions">
      ${w ? `<button type="button" class="btn btn-secondary btn-sm" data-bulk="move">${esc(t('library.bulk.move'))}</button>
      <button type="button" class="btn btn-secondary btn-sm" data-bulk="tag">${esc(t('library.bulk.tag'))}</button>
      <button type="button" class="btn btn-secondary btn-sm" data-bulk="playlist">${esc(t('library.bulk.add_playlist'))}</button>
      <button type="button" class="btn btn-secondary btn-sm lib-danger-text" data-bulk="delete">${esc(t('library.bulk.delete'))}</button>` : ''}
      <button type="button" class="btn btn-secondary btn-sm" data-bulk="clear">${esc(t('library.bulk.clear'))}</button>
    </div>`;
  const act = {
    page: () => { for (const c of state.items) state.selected.set(c.id, c); syncSelection(); },
    clear: () => { state.selected.clear(); state.lastClickedId = null; syncSelection(); announce(t('library.selection_cleared')); document.getElementById('contentSearch')?.focus(); },
    move: () => moveDialog([...state.selected.values()]),
    tag: () => tagDialog([...state.selected.values()]),
    playlist: () => playlistDialog([...state.selected.values()]),
    delete: () => deleteDialog([...state.selected.values()]),
  };
  bar.querySelectorAll('[data-bulk]').forEach((b) => b.addEventListener('click', () => act[b.dataset.bulk]()));
}

/* ================================ results ================================ */

function renderResults() {
  const grid = document.getElementById('contentGrid');
  if (!grid) return;
  grid.tabIndex = -1;
  const filtering = !!state.q || filtersActive();
  if (state.error && !state.items.length) {
    grid.innerHTML = `<div class="lib-state" role="alert"><h2>${esc(t('content.failed_to_load'))}</h2><p>${esc(state.error)}</p>
      <button type="button" class="btn btn-secondary" data-retry>${esc(t('library.retry'))}</button></div>`;
    grid.querySelector('[data-retry]').addEventListener('click', () => loadContent());
    return;
  }
  if (state.loading && !state.items.length) { grid.innerHTML = `<div class="lib-state"><p>${esc(t('common.loading'))}</p></div>`; return; }
  if (!state.items.length) {
    const l = state.location;
    const libraryEmpty = state.summary && state.summary.all === 0 && l.kind === 'all' && !filtering;
    if (libraryEmpty) {
      // An empty library keeps a large upload invitation (a populated one has none: see wireDrop).
      grid.innerHTML = `<div class="lib-empty-invite">
        ${typeIcon('image', 48)}
        <h2>${esc(t('content.no_content'))}</h2>
        <p>${esc(t('library.empty.lede'))}</p>
        ${canWrite() ? `<div class="lib-empty-actions"><button type="button" class="btn btn-primary" data-act="upload">${esc(t('library.empty.upload'))}</button>
        <button type="button" class="btn btn-secondary" data-act="add">${esc(t('library.add_content'))}</button></div>
        <p class="lib-muted">${esc(t('library.empty.drop'))}</p>` : ''}
      </div>`;
      grid.querySelector('[data-act="upload"]')?.addEventListener('click', () => document.getElementById('fileInput').click());
      grid.querySelector('[data-act="add"]')?.addEventListener('click', () => openAdd());
      return;
    }
    const [title, text] = filtering ? [t('library.empty.no_match'), t('library.empty.no_match_desc')]
      : l.kind === 'folder' ? [t('content.empty_folder_title'), t('library.empty.folder_desc')]
        : l.kind === 'unused' ? [t('library.empty.unused'), t('library.empty.unused_desc')]
          : l.kind === 'recent' ? [t('library.empty.recent'), t('library.empty.recent_desc', { days: (state.summary && state.summary.recent_days) || 7 })]
            : [t('content.no_content'), t('library.empty.lede')];
    grid.innerHTML = `<div class="lib-state"><h2>${esc(title)}</h2><p>${esc(text)}</p>
      ${filtering ? `<button type="button" class="btn btn-secondary" data-clear-all>${esc(t('library.clear_filters'))}</button>` : ''}</div>`;
    grid.querySelector('[data-clear-all]')?.addEventListener('click', () => document.querySelector('#libChips [data-clear="all"]')?.click());
    return;
  }
  grid.innerHTML = state.view === 'list' ? tableHtml() : gridHtml();
  hydrateAuthImages(grid);
  wireResults(grid);
  markOpen();
}

const checkbox = (c) => `<input type="checkbox" class="lib-check content-select" data-select="${esc(c.id)}" ${state.selected.has(c.id) ? 'checked' : ''} aria-label="${esc(t('library.select_item', { name: c.filename }))}">`;
const moreBtn = (c) => `<button type="button" class="lib-icon-btn lib-more" data-more="${esc(c.id)}" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(t('library.actions_for', { name: c.filename }))}">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></button>`;
const statusHtml = (c) => { const s = statusOf(c); return `<span class="lib-status"><span class="lib-dot is-${s.tone}" aria-hidden="true"></span>${esc(s.label)}</span>`; };
function thumbHtml(c, size) {
  const th = thumbOf(c);
  const ty = typeOf(c).key;
  if (!th) return `<span class="lib-thumb-icon is-${ty}">${typeIcon(ty, size)}</span>`;
  return th.auth ? `<img data-auth-src="${esc(th.src)}" alt="" loading="lazy">` : `<img src="${esc(th.src)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
}

function gridHtml() {
  return `<ul class="lib-grid" aria-label="${esc(t('library.results_label', { where: locationLabel() }))}">${state.items.map((c) => {
    const ty = typeOf(c);
    const dur = durationOf(c);
    const sel = state.selected.has(c.id);
    return `<li class="lib-card${sel ? ' is-selected' : ''}" data-id="${esc(c.id)}" draggable="${canWrite()}">
      <div class="lib-card-thumb">
        <button type="button" class="lib-card-open" data-open="${esc(c.id)}" tabindex="-1" aria-hidden="true">${thumbHtml(c, 36)}</button>
        <span class="lib-badge">${esc(ty.label)}</span>
        ${dur ? `<span class="lib-duration">${esc(dur)}</span>` : ''}
        <label class="lib-card-check">${checkbox(c)}</label>
      </div>
      <div class="lib-card-body">
        <button type="button" class="lib-card-name" data-open="${esc(c.id)}" title="${esc(c.filename)}">${esc(c.filename)}</button>
        <div class="lib-card-meta">${esc(detailLine(c) || ty.label)}${state.canvaLinks.has(c.id) ? ` · ${esc(t('canva.linked_badge'))}` : ''}</div>
        <div class="lib-card-foot">${statusHtml(c)}<span class="lib-card-usage">${esc(usageText(c))}</span>${moreBtn(c)}</div>
      </div>
    </li>`;
  }).join('')}</ul>`;
}

function tableHtml() {
  const head = (key, label) => {
    const pair = COLUMN_SORTS[key];
    if (!pair || state.legacy) return `<th scope="col">${esc(label)}</th>`;
    const dir = state.sort === pair[0] ? 'ascending' : state.sort === pair[1] ? 'descending' : null;
    // A column sorts ascending first, except the two whose natural first look is "biggest".
    return `<th scope="col" aria-sort="${dir || 'none'}"><button type="button" class="lib-sort" data-sort="${key}">${esc(label)}<span class="lib-sort-ind" aria-hidden="true">${dir === 'ascending' ? '↑' : dir === 'descending' ? '↓' : ''}</span></button></th>`;
  };
  const pageIds = state.items.map((c) => c.id);
  const selCount = pageIds.filter((id) => state.selected.has(id)).length;
  return `<div class="lib-table-wrap"><table class="lib-table">
    <caption class="lib-visually-hidden">${esc(t('library.results_label', { where: locationLabel() }))}</caption>
    <thead><tr>
      <th scope="col" class="lib-col-check"><input type="checkbox" class="lib-check" data-select-page ${selCount && selCount === pageIds.length ? 'checked' : ''} aria-label="${esc(t('library.bulk.select_page', { count: pageIds.length }))}"></th>
      ${head('name', t('library.col.name'))}${head('type', t('library.col.type')).replace('<th scope="col"', '<th scope="col" class="lib-col-type"')}
      <th scope="col" class="lib-col-opt" aria-sort="${state.sort === 'duration' ? 'ascending' : state.sort === 'duration_desc' ? 'descending' : 'none'}">${state.legacy ? esc(t('library.col.duration')) : `<button type="button" class="lib-sort" data-sort="duration">${esc(t('library.col.duration'))}<span class="lib-sort-ind" aria-hidden="true">${state.sort === 'duration' ? '↑' : state.sort === 'duration_desc' ? '↓' : ''}</span></button>`}</th>
      <th scope="col" class="lib-col-opt" aria-sort="${state.sort === 'dims' ? 'ascending' : state.sort === 'dims_desc' ? 'descending' : 'none'}">${state.legacy ? esc(t('library.col.dimensions')) : `<button type="button" class="lib-sort" data-sort="dimensions">${esc(t('library.col.dimensions'))}<span class="lib-sort-ind" aria-hidden="true">${state.sort === 'dims' ? '↑' : state.sort === 'dims_desc' ? '↓' : ''}</span></button>`}</th>
      <th scope="col">${esc(t('library.col.status'))}</th>
      <th scope="col">${esc(t('library.col.used_in'))}</th>
      <th scope="col" class="lib-col-actions"><span class="lib-visually-hidden">${esc(t('library.col.actions'))}</span></th>
    </tr></thead>
    <tbody>${state.items.map((c) => {
      const ty = typeOf(c);
      return `<tr class="lib-row${state.selected.has(c.id) ? ' is-selected' : ''}" data-id="${esc(c.id)}" draggable="${canWrite()}">
        <td class="lib-col-check">${checkbox(c)}</td>
        <td class="lib-col-name"><button type="button" class="lib-row-open" data-open="${esc(c.id)}" title="${esc(c.filename)}"><span class="lib-row-thumb">${thumbHtml(c, 20)}</span><span class="lib-row-name">${esc(c.filename)}</span></button></td>
        <td class="lib-col-type">${esc(ty.label)}</td>
        <td class="lib-col-opt">${esc(durationOf(c) || '—')}</td>
        <td class="lib-col-opt">${esc(dimensionsOf(c) || '—')}</td>
        <td>${statusHtml(c)}</td>
        <td>${c.usage && c.usage.playlists > 0 ? `<button type="button" class="lib-link-btn" data-open="${esc(c.id)}" data-focus-usage>${esc(usageText(c))}</button>` : esc(usageText(c) || '—')}</td>
        <td class="lib-col-actions">${moreBtn(c)}</td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
}

function wireResults(grid) {
  grid.onclick = (e) => {
    const more = e.target.closest('[data-more]');
    if (more) { const c = state.items.find((x) => x.id === more.dataset.more); if (c) openMenu(more, itemMenu(c, more), { label: t('library.actions_for', { name: c.filename }) }); return; }
    const sortBtn = e.target.closest('[data-sort]');
    if (sortBtn) {
      const pair = COLUMN_SORTS[sortBtn.dataset.sort];
      state.sort = state.sort === pair[0] ? pair[1] : pair[0];
      state.offset = 0;
      loadContent().then(() => document.querySelector(`[data-sort="${sortBtn.dataset.sort}"]`)?.focus());
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) {
      const c = state.items.find((x) => x.id === open.dataset.open);
      // The thumbnail is a mouse target only; the visible name button is the one the keyboard reaches.
      const trigger = open.classList.contains('lib-card-open') ? open.closest('.lib-card').querySelector('.lib-card-name') : open;
      if (c) openItem(c, trigger);
    }
  };
  grid.onchange = (e) => {
    const cb = e.target.closest('[data-select]');
    if (cb) { toggleSelect(cb.dataset.select, cb.checked, e.shiftKey); return; }
    if (e.target.matches('[data-select-page]')) {
      const on = e.target.checked;
      for (const c of state.items) { if (on) state.selected.set(c.id, c); else state.selected.delete(c.id); }
      syncSelection();
    }
  };
  // Shift-click range (#213): the click carries shiftKey, the change event does not.
  grid.addEventListener('click', (e) => { const cb = e.target.closest('[data-select]'); if (cb) cb.dataset.shift = e.shiftKey ? '1' : ''; }, true);
  grid.querySelectorAll('[draggable="true"]').forEach((el) => el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/content-id', el.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
  }));
}

function toggleSelect(id, on) {
  const cb = document.querySelector(`[data-select="${CSS.escape(id)}"]`);
  const shift = cb && cb.dataset.shift === '1';
  const order = state.items.map((c) => c.id);
  if (shift && state.lastClickedId && order.includes(state.lastClickedId)) {
    const a = order.indexOf(state.lastClickedId), b = order.indexOf(id);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    for (let i = lo; i <= hi; i++) { if (on) state.selected.set(order[i], state.items[i]); else state.selected.delete(order[i]); }
  } else if (on) state.selected.set(id, state.items.find((c) => c.id === id));
  else state.selected.delete(id);
  state.lastClickedId = id;
  syncSelection();
}

// Selection changes restyle in place: re-rendering would move focus off the checkbox just used.
function syncSelection() {
  document.querySelectorAll('#contentGrid [data-id]').forEach((el) => {
    const on = state.selected.has(el.dataset.id);
    el.classList.toggle('is-selected', on);
    const cb = el.querySelector('[data-select]');
    if (cb) cb.checked = on;
  });
  const pageBox = document.querySelector('[data-select-page]');
  if (pageBox) {
    const n = state.items.filter((c) => state.selected.has(c.id)).length;
    pageBox.checked = n > 0 && n === state.items.length;
    pageBox.indeterminate = n > 0 && n < state.items.length;
  }
  renderBulkBar();
}

function markOpen() {
  document.querySelectorAll('#contentGrid [data-id]').forEach((el) => el.classList.toggle('is-open', el.dataset.id === state.openId));
  document.getElementById('libRoot')?.classList.toggle('has-inspector', !!state.openId);
}

async function openItem(c, trigger) {
  const ok = await inspector.open(c, { trigger, focus: true });
  if (!ok) return;
  state.openId = c.id;
  markOpen();
}

/* ================================ per-item actions ================================ */

function itemMenu(c, anchor, { fromInspector = false } = {}) {
  const w = canWrite();
  const ty = typeOf(c).key;
  const link = state.canvaLinks.get(c.id);
  return [
    !fromInspector ? { label: t('library.menu.details'), onSelect: () => openItem(c, anchor) } : null,
    ['image', 'video', 'youtube', 'bundle'].includes(ty) ? { label: t('library.menu.preview'), onSelect: () => showPreview(c) } : null,
    w ? { label: t('library.menu.edit'), onSelect: () => showEditModal(c, () => scheduleReload()) } : null,
    w ? { label: t('library.menu.expiry'), onSelect: () => showEditModal(c, () => scheduleReload(), { focus: '#editExpiresAt' }) } : null,
    w ? { label: t('library.menu.add_playlist'), onSelect: () => playlistDialog([c]) } : null,
    w ? { label: t('library.menu.move'), onSelect: () => moveDialog([c]) } : null,
    link && w ? { label: t('canva.sync_now'), hint: link.last_error ? t('canva.sync_problem') : '', onSelect: () => canvaSync(c) } : null,
    { label: t('history.button'), onSelect: () => openHistoryModal('content', c.id, { name: c.filename, onChanged: () => scheduleReload() }) },
    w ? { label: t('library.menu.delete'), danger: true, separatorBefore: true, onSelect: () => deleteDialog([c]) } : null,
  ].filter(Boolean);
}
// data-history-content: history is per item, from its menu (components/history-modal.js).

async function canvaSync(c) {
  try {
    const r = await syncCanvaLink(c.id);
    if (r.errors) showToast(t('canva.sync_failed'), 'error');
    else showToast(r.replaced ? t('canva.synced') : t('canva.up_to_date'), 'success');
  } catch (err) { showToast(err.message, 'error'); }
  scheduleReload();
}

const nameList = (items, max = 6) => {
  const shown = items.slice(0, max).map((c) => `<li>${esc(c.filename)}</li>`).join('');
  return `<ul class="lib-confirm-list">${shown}${items.length > max ? `<li class="lib-muted">${esc(t('library.and_more', { count: items.length - max }))}</li>` : ''}</ul>`;
};

function afterBulk(clear = true) {
  if (clear) { state.selected.clear(); state.lastClickedId = null; }
  scheduleReload();
}

async function deleteDialog(items) {
  // Impact first: what each item is used in, from the same usage the list shows.
  const used = items.filter((c) => c.usage && (c.usage.playlists > 0 || c.usage.in_use));
  const impact = used.length ? `<p>${esc(t('library.delete.impact', { count: used.length }))}</p>
    <ul class="lib-confirm-list">${used.slice(0, 8).map((c) => `<li><strong>${esc(c.filename)}</strong> — ${esc(usageText(c))}</li>`).join('')}${used.length > 8 ? `<li class="lib-muted">${esc(t('library.and_more', { count: used.length - 8 }))}</li>` : ''}</ul>`
    : `<p>${esc(t('library.delete.no_impact'))}</p>`;
  const ok = await confirmDialog({
    title: t(items.length === 1 ? 'library.delete.title_one' : 'library.delete.title_other', { count: items.length, name: items[0].filename }),
    bodyHtml: `${items.length > 1 ? nameList(items) : ''}${impact}<p class="lib-muted">${esc(t('library.delete.permanent'))}</p>`,
    confirmLabel: t(items.length === 1 ? 'library.delete.confirm_one' : 'library.delete.confirm_other', { count: items.length }),
    danger: true,
  });
  if (!ok) return;
  try {
    const ids = items.map((c) => c.id);
    const r = ids.length === 1 ? await api.deleteContent(ids[0]) : await api.batchDeleteContent(ids);
    const devices = (r && r.affectedDevices) ? r.affectedDevices.length : 0;
    showToast(t(ids.length === 1 ? 'library.delete.done_one' : 'library.delete.done_other', { count: ids.length }) + (devices ? ' ' + t('library.delete.devices', { count: devices }) : ''), 'success');
    if (inspector.openId && ids.includes(inspector.openId)) inspector.close({ force: true });
    for (const id of ids) state.selected.delete(id);
    afterBulk(false);
  } catch (err) {
    // The batch is all-or-nothing (routes/content.js): name the item it stopped on.
    showToast(t('library.bulk.failed_none', { error: nameForError(err.message, items) }), 'error');
  }
}

// "Access denied for content: <uuid>" reads better with the item's name.
function nameForError(msg, items) {
  let out = String(msg || '');
  for (const c of items) if (out.includes(c.id)) out = out.replace(c.id, `“${c.filename}”`);
  return out;
}

function folderRadios(name, selectedId) {
  const opts = [{ id: '', name: rootLabel(), depth: 0 }, ...treeOrder(state.folders).map((f) => ({ ...f, depth: f.depth + 1 }))];
  return `<fieldset class="lib-dest-list"><legend class="lib-visually-hidden">${esc(t('library.move.legend'))}</legend>
    ${opts.map((o) => `<label class="lib-dest-opt" style="padding-left:${12 + o.depth * 18}px"><input type="radio" name="${name}" value="${esc(o.id)}" ${(selectedId || '') === o.id ? 'checked' : ''}><span>${esc(o.name)}</span></label>`).join('')}
  </fieldset>`;
}

function moveDialog(items) {
  const current = items.length === 1 ? items[0].folder_id || '' : null;
  const d = openDialog({
    title: t(items.length === 1 ? 'library.move.title_one' : 'library.move.title_other', { count: items.length, name: items[0].filename }),
    html: `${folderRadios('libMoveTo', current)}
      <div class="lib-dialog-actions"><span class="lib-form-error" role="alert" data-err></span>
        <button type="button" class="btn btn-secondary" data-cancel>${esc(t('common.cancel'))}</button>
        <button type="button" class="btn btn-primary" data-ok>${esc(t('library.move.ok'))}</button></div>`,
  });
  d.root.querySelector('[data-cancel]').addEventListener('click', () => d.close());
  d.root.querySelector('[data-ok]').addEventListener('click', async (e) => {
    const v = d.root.querySelector('input[name="libMoveTo"]:checked');
    if (!v) { d.root.querySelector('[data-err]').textContent = t('library.move.choose'); return; }
    e.target.disabled = true;
    try {
      await api.batchMoveContent(items.map((c) => c.id), v.value || null);
      const f = folderById().get(v.value);
      showToast(f ? t('library.bulk.moved', { count: items.length, folder: folderPathOf(f) }) : t('library.bulk.moved_root', { count: items.length }), 'success');
      d.close();
      afterBulk(items.length > 1);
    } catch (err) { d.root.querySelector('[data-err]').textContent = t('library.bulk.failed_none', { error: nameForError(err.message, items) }); e.target.disabled = false; }
  });
}

function tagDialog(items) {
  const existing = [...new Set(items.flatMap((c) => Array.isArray(c.tags) ? c.tags : []))].sort();
  const d = openDialog({
    title: t('library.tag.title', { count: items.length }),
    html: `<div class="lib-field"><label for="libTagAdd">${esc(t('library.tag.add_label'))}</label>
        <input id="libTagAdd" class="input" placeholder="${esc(t('content.tags_placeholder'))}" autocomplete="off" aria-describedby="libTagAdd-help">
        <div class="lib-field-help" id="libTagAdd-help">${esc(t('content.tags_hint'))}</div></div>
      ${existing.length ? `<fieldset class="lib-field"><legend>${esc(t('library.tag.remove_label'))}</legend>
        <div class="lib-tag-remove">${existing.map((tg) => `<label class="lib-check-label"><input type="checkbox" value="${esc(tg)}" data-remove> #${esc(tg)}</label>`).join('')}</div></fieldset>` : ''}
      <div class="lib-dialog-actions"><span class="lib-form-error" role="alert" data-err></span>
        <button type="button" class="btn btn-secondary" data-cancel>${esc(t('common.cancel'))}</button>
        <button type="button" class="btn btn-primary" data-ok>${esc(t('library.tag.ok'))}</button></div>`,
  });
  d.root.querySelector('[data-cancel]').addEventListener('click', () => d.close());
  d.root.querySelector('[data-ok]').addEventListener('click', async (e) => {
    const add = d.root.querySelector('#libTagAdd').value.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
    const remove = [...d.root.querySelectorAll('[data-remove]:checked')].map((x) => x.value);
    if (!add.length && !remove.length) { d.root.querySelector('[data-err]').textContent = t('library.tag.nothing'); d.root.querySelector('#libTagAdd').focus(); return; }
    e.target.disabled = true;
    try {
      await api.batchTagContent(items.map((c) => c.id), add, remove);
      showToast(t('library.tag.done', { count: items.length }), 'success');
      d.close();
      afterBulk(false);
    } catch (err) { d.root.querySelector('[data-err]').textContent = t('library.bulk.failed_none', { error: nameForError(err.message, items) }); e.target.disabled = false; }
  });
}

async function playlistDialog(items) {
  const d = openDialog({ title: t('library.playlist.title', { count: items.length }), html: `<p>${esc(t('common.loading'))}</p>` });
  let playlists;
  try { playlists = await api.getPlaylists(); } catch (err) { d.body.innerHTML = `<p role="alert">${esc(err.message)}</p>`; return; }
  if (d.closed) return;
  // Smart playlists choose their own content (the bulk route refuses them); auto-generated ones are
  // a screen's own and are not offered either.
  const choices = (playlists || []).filter((p) => !p.smart_rules && !p.is_auto_generated)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  if (!choices.length) { d.body.innerHTML = `<p>${esc(t('library.playlist.none'))}</p><div class="lib-dialog-actions"><a class="btn btn-primary" href="#/playlists">${esc(t('library.playlist.go'))}</a></div>`; d.body.querySelector('a').addEventListener('click', () => d.close()); return; }
  d.body.innerHTML = `
    <div class="lib-field"><label for="libPlFilter">${esc(t('library.playlist.filter'))}</label><input id="libPlFilter" class="input" type="search" autocomplete="off"></div>
    <fieldset class="lib-dest-list" style="max-height:320px;overflow:auto"><legend class="lib-visually-hidden">${esc(t('library.playlist.legend'))}</legend>
      ${choices.map((p) => `<label class="lib-dest-opt" data-name="${esc(p.name.toLowerCase())}"><input type="radio" name="libPl" value="${esc(p.id)}"><span>${esc(p.name)}</span></label>`).join('')}
    </fieldset>
    <p class="lib-field-help">${esc(t('library.playlist.note'))}</p>
    <div class="lib-dialog-actions"><span class="lib-form-error" role="alert" data-err></span>
      <button type="button" class="btn btn-secondary" data-cancel>${esc(t('common.cancel'))}</button>
      <button type="button" class="btn btn-primary" data-ok>${esc(t('library.playlist.ok'))}</button></div>`;
  d.body.querySelector('#libPlFilter').focus();
  d.body.querySelector('#libPlFilter').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    d.body.querySelectorAll('[data-name]').forEach((el) => { el.hidden = !!q && !el.dataset.name.includes(q); });
  });
  d.body.querySelector('[data-cancel]').addEventListener('click', () => d.close());
  d.body.querySelector('[data-ok]').addEventListener('click', async (e) => {
    const v = d.body.querySelector('input[name="libPl"]:checked');
    if (!v) { d.body.querySelector('[data-err]').textContent = t('library.playlist.choose'); return; }
    const pl = choices.find((p) => p.id === v.value);
    e.target.disabled = true;
    try {
      let r;
      try { r = await api.addPlaylistItemsBulk(pl.id, items.map((c) => c.id)); }
      catch (err) {
        // Nothing could be added: the route answers 400 with the same per-item reasons
        // (routes/playlists.js items/bulk), which are worth more than "Request failed".
        if (err.body && Array.isArray(err.body.skipped) && err.body.skipped.length) r = err.body; else throw err;
      }
      const skipped = (r && r.skipped) || [];
      const added = (r && r.added ? r.added.length : 0);
      d.close();
      if (skipped.length) {
        // Partial: say which items were left out and why, one line each.
        const byId = new Map(items.map((c) => [c.id, c]));
        const rd = openDialog({
          title: t('library.playlist.partial_title', { added, playlist: pl.name }),
          html: `<p>${esc(t('library.playlist.partial_text', { count: skipped.length }))}</p>
            <ul class="lib-confirm-list">${skipped.map((s) => `<li><strong>${esc((byId.get(s.content_id) || {}).filename || s.content_id)}</strong> — ${esc(s.reason)}</li>`).join('')}</ul>
            <div class="lib-dialog-actions"><button type="button" class="btn btn-primary" data-ok>${esc(t('common.close'))}</button></div>`,
        });
        rd.root.querySelector('[data-ok]').addEventListener('click', () => rd.close());
      } else {
        showToast(t('library.playlist.done', { count: added, playlist: pl.name }), 'success');
      }
      afterBulk(items.length > 1);
    } catch (err) {
      d.body.querySelector('[data-err]').textContent = t('library.playlist.failed', { error: nameForError(err.message, items) });
      e.target.disabled = false;
    }
  });
}

/* ================================ folders ================================ */

function textPrompt({ title, label, value = '', ok, extraHtml = '' }) {
  return new Promise((resolve) => {
    let result = null;
    const d = openDialog({
      title, size: 'sm',
      html: `<form novalidate data-form><div class="lib-field"><label for="libPromptInput">${esc(label)}</label>
        <input id="libPromptInput" class="input" value="${esc(value)}" maxlength="100" autocomplete="off" aria-describedby="libPromptInput-err">
        <div class="lib-field-err" id="libPromptInput-err" role="alert"></div></div>${extraHtml}
        <div class="lib-dialog-actions"><button type="button" class="btn btn-secondary" data-cancel>${esc(t('common.cancel'))}</button>
        <button type="submit" class="btn btn-primary">${esc(ok)}</button></div></form>`,
      initialFocus: '#libPromptInput',
      onRequestClose: () => { resolve(result); return true; },
    });
    d.root.querySelector('[data-cancel]').addEventListener('click', () => d.requestClose('cancel'));
    d.root.querySelector('[data-form]').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = d.root.querySelector('#libPromptInput').value.trim();
      if (!v) { d.root.querySelector('#libPromptInput-err').textContent = t('library.folder.err_name'); return; }
      const parent = d.root.querySelector('[name="libParent"]');
      result = { value: v, parent: parent ? parent.value : null };
      d.requestClose('ok');
    });
  });
}

async function newFolder(trigger, parentId = state.location.kind === 'folder' ? state.location.folderId : null) {
  const parentSel = `<div class="lib-field"><label for="libParent">${esc(t('library.folder.inside'))}</label>
    <select id="libParent" name="libParent" class="input"><option value="">${esc(rootLabel())}</option>
    ${treeOrder(state.folders).map((f) => `<option value="${esc(f.id)}" ${f.id === parentId ? 'selected' : ''}>${esc(folderPathOf(f))}</option>`).join('')}</select></div>`;
  const r = await textPrompt({ title: t('library.folder.new_title'), label: t('library.folder.name'), ok: t('library.folder.create'), extraHtml: parentSel });
  if (!r) return;
  try {
    const f = await api.createFolder(r.value, r.parent || null);
    showToast(t('content.toast.folder_created_named', { name: r.value }), 'success');
    if (r.parent) state.expanded.add(r.parent);
    await loadNav();
    if (f && f.id) goLocation({ kind: 'folder', folderId: f.id });
  } catch (err) { showToast(err.message, 'error'); }
}

async function renameFolder(id) {
  const f = folderById().get(id);
  if (!f) return;
  const r = await textPrompt({ title: t('library.folder.rename_title'), label: t('library.folder.name'), value: f.name, ok: t('library.folder.rename_ok') });
  if (!r || r.value === f.name) return;
  try {
    await api.renameFolder(id, r.value);
    showToast(t('content.toast.folder_renamed'), 'success');
    await loadNav();
  } catch (err) { showToast(err.message, 'error'); }
}

async function deleteFolder(id) {
  const f = folderById().get(id);
  if (!f) return;
  const ok = await confirmDialog({
    title: t('library.folder.delete_title', { name: f.name }),
    bodyHtml: esc(t('content.confirm_delete_folder')),
    confirmLabel: t('library.folder.delete'),
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteFolder(id);
    showToast(t('content.toast.folder_deleted'), 'success');
    state.location = f.parent_id ? { kind: 'folder', folderId: f.parent_id } : { kind: 'all', folderId: null };
    await loadNav();
    scopeChanged();
  } catch (err) { showToast(err.message, 'error'); }
}

/* ================================ adding content ================================ */

function openAdd() {
  if (!canWrite()) return;
  openAddContent({
    destination: destination(),
    folders: state.folders,
    folderPath: folderPathOf,
    rootLabel: rootLabel(),
    onFiles: (files, dest) => handleFiles(files, dest),
    onCreated: (item) => {
      scheduleReload();
      // A no-bytes item lands where its destination is; open it so the operator sees it there.
      if (item && item.id) setTimeout(() => { const c = state.items.find((x) => x.id === item.id); if (c) openItem(c, document.getElementById('libAddBtn')); }, 600);
    },
    onOpenCloudFolders: async () => {
      const { openCloudFolders } = await import('../components/m365-settings.js');
      openCloudFolders({ onChange: () => scheduleReload() });
    },
    onOpenCanva: (dest) => openCanvaPicker({ onImported: () => scheduleReload(), folderId: dest.folderId }),
  });
}

/*
 * Drop files anywhere on the results to upload them into the current destination. A populated
 * library has no permanent drop zone; the overlay appears only while files are dragged over it.
 * A card being dragged to a folder (text/content-id) and a dragged text selection are not uploads.
 */
function wireDrop() {
  const main = document.getElementById('libMain');
  const overlay = document.getElementById('libDropOverlay');
  let depth = 0;
  const isFiles = (e) => { const ty = [...(e.dataTransfer?.types || [])]; return ty.includes('Files') && !ty.includes('text/content-id'); };
  main.addEventListener('dragenter', (e) => {
    if (!isFiles(e) || !canWrite()) return;
    e.preventDefault();
    depth++;
    document.getElementById('libDropText').textContent = t('library.drop_to', { folder: destination().label });
    overlay.hidden = false;
  });
  main.addEventListener('dragover', (e) => { if (isFiles(e) && canWrite()) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  main.addEventListener('dragleave', (e) => { if (!isFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) overlay.hidden = true; });
  main.addEventListener('drop', (e) => {
    if (!isFiles(e) || !canWrite()) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    handleFiles([...e.dataTransfer.files], destination());
  });
}

/**
 * Start uploads into `dest`. A PDF is not uploaded as a PDF: it is rendered to one image per page in
 * this browser, and those go into a folder and a playlist named after it (components/pdf-pages.js),
 * so that is said — with the names — before anything starts. Resolves false if the user stops.
 */
async function handleFiles(files, dest) {
  const all = Array.from(files || []);
  if (all.length === 0) return false;
  const pdfs = all.filter(isPdf);
  const list = all.filter((f) => !isPdf(f));
  if (pdfs.length) {
    const ok = await confirmDialog({
      title: t(pdfs.length === 1 ? 'library.pdf.title_one' : 'library.pdf.title_other', { count: pdfs.length }),
      bodyHtml: `<p>${esc(t('library.pdf.explain'))}</p><ul class="lib-confirm-list">${pdfs.map((f) => {
        const base = baseName(f.name).slice(0, 100);
        return `<li><strong>${esc(f.name)}</strong> → ${esc(t('library.pdf.result', { folder: base, playlist: base, where: dest.label }))}</li>`;
      }).join('')}</ul>${list.length ? `<p class="lib-muted">${esc(t('library.pdf.others', { count: list.length }))}</p>` : ''}`,
      confirmLabel: t('library.pdf.ok'),
    });
    if (!ok) return false;
  }
  uploads.enqueue([...pdfs, ...list], { folderId: dest.folderId, folderLabel: dest.label });
  announce(t('library.upload.started', { count: all.length, folder: dest.label }));
  return true;
}

/**
 * One PDF → a folder of page images + a playlist that plays them in order.
 *
 * Rendering is the first half of the progress, uploading the second. The folder is a nicety and the
 * playlist is the feature, so a folder that cannot be created (no workspace, or the per-workspace
 * folder cap) falls back to the destination rather than failing the import, and a playlist that
 * cannot be created after the pages are up reports THAT rather than pretending the upload failed —
 * the images exist and the user should know it.
 */
async function importPdf(file, parentFolderId, report) {
  const base = baseName(file.name).slice(0, 100);
  report(0, t('content.pdf.rendering', { name: base, done: 0, total: '…' }));
  const pages = await renderPdfToPages(file, (done, total) => {
    report(Math.round((done / total) * 50), t('content.pdf.rendering', { name: base, done, total }));
  });

  let folderId = parentFolderId;
  try {
    folderId = (await api.createFolder(base, parentFolderId)).id;
  } catch (_) { /* fall through: pages land in the destination instead */ }

  const uploaded = await api.uploadContent(pages, (pct) => {
    report(50 + Math.round(pct / 2), t('content.pdf.uploading', { name: base, pct }));
  }, folderId);
  const items = Array.isArray(uploaded) ? uploaded : [uploaded];

  try {
    const playlist = await api.createPlaylist(base,
      t('content.pdf.playlist_description', { name: file.name, count: items.length }));
    await api.addPlaylistItemsBulk(playlist.id, items.map((c) => c.id));
    showToast(t('content.toast.pdf_imported', { name: base, count: items.length }), 'success');
  } catch (err) {
    showToast(t('content.toast.pdf_playlist_failed', { name: base, count: items.length, error: err.message }), 'error');
  }
  return items;
}

function showEditModal(contentItem, onSave, { focus = null } = {}) {
  const opener = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';

  const isRemote = !!contentItem.remote_url;
  const isYoutube = contentItem.mime_type === 'video/youtube';
  const isUploadedVideo = !isRemote && contentItem.mime_type?.startsWith('video/');
  // #216: language <option>s shared by the caption + subtitle pickers.
  const langOptions = (sel) => SUBTITLE_LANGS
    .map(([code, label]) => `<option value="${code}" ${sel === code ? 'selected' : ''}>${label}</option>`)
    .join('');

  overlay.innerHTML = `
    <div class="modal" style="max-width:500px;width:95vw">
      <div class="modal-header">
        <h3>${t('content.edit_modal_title')}</h3>
        <button class="btn-icon" id="closeEditModal">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>${t('content.label_filename')}</label>
          <input type="text" id="editFilename" class="input" value="${esc(contentItem.filename)}">
        </div>
        <div class="form-group">
          <label>${t('content.label_tags')}</label>
          <input type="text" id="editTags" class="input" value="${esc((Array.isArray(contentItem.tags) ? contentItem.tags : []).join(', '))}" placeholder="${esc(t('content.tags_placeholder'))}">
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">${t('content.tags_hint')}</div>
        </div>
        <div class="form-group">
          <label>${t('content.label_meta')}</label>
          <textarea id="editMeta" class="input" rows="3" placeholder="${esc(t('content.meta_placeholder'))}" style="width:100%;font-family:monospace;font-size:12px">${esc(metaToLines(contentItem.meta))}</textarea>
        </div>
        ${isRemote ? `
        <div class="form-group">
          <label>${t('content.label_remote_url_field')}</label>
          <input type="text" id="editRemoteUrl" class="input" value="${esc(contentItem.remote_url)}">
        </div>
        ` : ''}
        <div class="form-group">
          <label>${t('content.label_mime_type')}</label>
          <select id="editMimeType" class="input" style="background:var(--bg-input)">
            <option value="video/mp4" ${contentItem.mime_type === 'video/mp4' ? 'selected' : ''}>${t('content.mime.video_mp4')}</option>
            <option value="video/webm" ${contentItem.mime_type === 'video/webm' ? 'selected' : ''}>${t('content.mime.video_webm')}</option>
            <option value="image/jpeg" ${contentItem.mime_type === 'image/jpeg' ? 'selected' : ''}>${t('content.mime.image_jpeg')}</option>
            <option value="image/png" ${contentItem.mime_type === 'image/png' ? 'selected' : ''}>${t('content.mime.image_png')}</option>
            <option value="image/gif" ${contentItem.mime_type === 'image/gif' ? 'selected' : ''}>${t('content.mime.image_gif')}</option>
            <option value="image/webp" ${contentItem.mime_type === 'image/webp' ? 'selected' : ''}>${t('content.mime.image_webp')}</option>
              ${['video/mp4','video/webm','image/jpeg','image/png','image/gif','image/webp'].includes(contentItem.mime_type) ? '' : `
              <!-- The item's ACTUAL type, for the cases the six choices above cannot express:
                   video/youtube, and uploads the sniffer accepts but this list omits (.mov, .svg,
                   .heic, .avif, .bmp). Without it no option matched, the browser selected the first
                   one - video/mp4 - and pressing Save with nothing else changed rewrote the item's
                   type. mime_type is the renderer selector in every player, so a YouTube item became
                   an "MP4" whose source is an embed page: a dead slide on every screen, and
                   unrecoverable here because there was no option to set it back. -->
              <option value="${esc(contentItem.mime_type || '')}" selected>${esc(contentItem.mime_type || '')}</option>`}
          </select>
        </div>
        <div class="form-group">
          <label>${t('content.label_folder')}</label>
          <select id="editFolderId" class="input" style="background:var(--bg-input)">
            <option value="">${t('content.folder_root_option')}</option>
            ${state.folders.map(f => `<option value="${f.id}" ${contentItem.folder_id === f.id ? 'selected' : ''}>${esc(folderPath(f, state.folders))}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>${t('content.label_expires_at')}</label>
          <input type="datetime-local" id="editExpiresAt" class="input" style="background:var(--bg-input)" value="${toLocalDatetimeInput(contentItem.expires_at)}">
          <p style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('content.expires_hint')}</p>
        </div>
        ${isYoutube ? `
        <div class="form-group">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="editUnstableConnection" ${contentItem.unstable_connection ? 'checked' : ''} style="width:auto;margin:0">
            <span>${t('content.label_unstable_connection')}</span>
          </label>
          <p style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('content.unstable_connection_hint')}</p>
        </div>
        ` : ''}
        ${isYoutube ? `
        <div class="form-group">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="editCaptionsEnabled" ${contentItem.captions_enabled ? 'checked' : ''} style="width:auto;margin:0">
            <span>${t('content.label_captions_enabled')}</span>
          </label>
          <div style="margin-top:8px">
            <label style="font-size:12px;color:var(--text-secondary)">${t('content.label_captions_lang')}</label>
            <select id="editCaptionsLang" class="input" style="background:var(--bg-input)">${langOptions(contentItem.captions_lang || 'en')}</select>
          </div>
          <p style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('content.captions_hint')}</p>
        </div>
        ` : ''}
        ${isUploadedVideo ? `
        <div class="form-group">
          <label>${t('content.label_subtitle_file')}</label>
          ${contentItem.subtitle_url ? `<p style="font-size:11px;color:var(--text-secondary);margin:2px 0 6px">${t('content.subtitle_current')}</p>` : ''}
          <input type="file" id="editSubtitleFile" accept=".vtt,text/vtt" style="font-size:13px;color:var(--text-secondary)">
          <div style="margin-top:8px">
            <label style="font-size:12px;color:var(--text-secondary)">${t('content.label_subtitle_lang')}</label>
            <select id="editSubtitleLang" class="input" style="background:var(--bg-input)">${langOptions(contentItem.subtitle_lang || 'en')}</select>
          </div>
          ${contentItem.subtitle_url ? `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:8px"><input type="checkbox" id="editSubtitleRemove" style="width:auto;margin:0"><span>${t('content.subtitle_remove')}</span></label>` : ''}
          <p style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('content.subtitle_hint')}</p>
        </div>
        ` : ''}
        ${!isRemote ? `
        <div class="form-group">
          <label>${t('content.label_replace_file')}</label>
          <input type="file" id="editFileReplace" accept="video/*,image/*,audio/*,.zip,.wgt" style="font-size:13px;color:var(--text-secondary)">
          <p style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('content.replace_file_hint')}</p>
        </div>
        ` : ''}
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="cancelEditBtn">${t('common.cancel')}</button>
        <button class="btn btn-primary" id="saveEditBtn">${t('content.save_changes')}</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  // Escape closes, focus starts inside (on the field asked for) and goes back to the opener.
  const modalEl = overlay.querySelector('.modal');
  modalEl.setAttribute('role', 'dialog');
  modalEl.setAttribute('aria-modal', 'true');
  modalEl.querySelector('h3').id = 'editModalTitle';
  modalEl.setAttribute('aria-labelledby', 'editModalTitle');
  overlay.querySelector('#closeEditModal').setAttribute('aria-label', t('common.close'));
  const closeEdit = () => { overlay.remove(); document.removeEventListener('keydown', onEditKey, true); if (opener && document.contains(opener)) opener.focus(); };
  const onEditKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); closeEdit(); } };
  document.addEventListener('keydown', onEditKey, true);
  (overlay.querySelector(focus || '#editFilename') || overlay.querySelector('#editFilename')).focus();
  overlay.querySelector('#closeEditModal').onclick = () => closeEdit();
  overlay.querySelector('#cancelEditBtn').onclick = () => closeEdit();
  overlay.onclick = (e) => { if (e.target === overlay) closeEdit(); };

  overlay.querySelector('#saveEditBtn').onclick = async () => {
    const filename = overlay.querySelector('#editFilename').value.trim();
    const mimeType = overlay.querySelector('#editMimeType').value;
    const remoteUrl = overlay.querySelector('#editRemoteUrl')?.value.trim();
    const replaceFile = overlay.querySelector('#editFileReplace')?.files[0];

    try {
      const token = localStorage.getItem('token');
      const headers = { Authorization: 'Bearer ' + token };

      // Update metadata
      const folderId = overlay.querySelector('#editFolderId')?.value || '';
      const updateData = {};
      if (filename !== contentItem.filename) updateData.filename = filename;
      const tagsRaw = overlay.querySelector('#editTags')?.value || '';
      const newTags = tagsRaw.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
      const curTags = Array.isArray(contentItem.tags) ? contentItem.tags : [];
      if (newTags.join('\0') !== curTags.join('\0')) updateData.tags = newTags;
      const metaRaw = overlay.querySelector('#editMeta')?.value || '';
      // Only send meta when it actually changed. metaToLines() renders the
      // current meta the same way the textarea is seeded, so an untouched
      // modal produces an identical string and no-op Saves don't fire a PUT
      // (which would bump a revision and re-flag approval-gated assets).
      if (metaRaw !== metaToLines(contentItem.meta)) updateData.meta = metaRaw;
      if (mimeType !== contentItem.mime_type) updateData.mime_type = mimeType;
      if (remoteUrl !== undefined && remoteUrl !== contentItem.remote_url) updateData.remote_url = remoteUrl;
      if ((contentItem.folder_id || '') !== folderId) updateData.folder_id = folderId || null;
      // #157: expiry (datetime-local local wall-clock -> epoch seconds; empty = never).
      const expiryRaw = overlay.querySelector('#editExpiresAt')?.value || '';
      const newExpiry = expiryRaw ? Math.floor(new Date(expiryRaw).getTime() / 1000) : null;
      const curExpiry = contentItem.expires_at != null ? Number(contentItem.expires_at) : null;
      if (newExpiry !== curExpiry) updateData.expires_at = newExpiry;
      // #217: YouTube-only "unstable connection" quality cap.
      const unstableEl = overlay.querySelector('#editUnstableConnection');
      if (unstableEl) {
        const newUnstable = unstableEl.checked ? 1 : 0;
        if (newUnstable !== (contentItem.unstable_connection ? 1 : 0)) updateData.unstable_connection = newUnstable;
      }
      // #216: YouTube captions (checkbox + language).
      const captionsEl = overlay.querySelector('#editCaptionsEnabled');
      if (captionsEl) {
        const newCaptions = captionsEl.checked ? 1 : 0;
        if (newCaptions !== (contentItem.captions_enabled ? 1 : 0)) updateData.captions_enabled = newCaptions;
        const capLang = overlay.querySelector('#editCaptionsLang')?.value || null;
        if (capLang !== (contentItem.captions_lang || 'en')) updateData.captions_lang = capLang;
      }
      // #216: uploaded-video subtitle language change / removal (the FILE is sent separately below).
      const subtitleFile = overlay.querySelector('#editSubtitleFile')?.files[0];
      const subLangEl = overlay.querySelector('#editSubtitleLang');
      const subRemove = overlay.querySelector('#editSubtitleRemove')?.checked;
      if (subRemove) {
        updateData.subtitle_url = null;
        updateData.subtitle_lang = null;
      } else if (subLangEl && !subtitleFile) {
        // Lang-only change (no new file) — the upload endpoint handles lang when a file IS sent.
        const subLang = subLangEl.value || null;
        if (contentItem.subtitle_url && subLang !== (contentItem.subtitle_lang || 'en')) updateData.subtitle_lang = subLang;
      }

      let pendingReview = false;
      if (Object.keys(updateData).length > 0) {
        assertLocalCallAllowed('/content', 'PUT');
        const r = await fetch('/api/content/' + contentItem.id, {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(updateData)
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || 'Update failed');
        pendingReview = !!body.pending_review;
      }

      // Replace file if provided
      if (replaceFile) {
        const formData = new FormData();
        formData.append('file', replaceFile);
        assertLocalCallAllowed('/content', 'POST');
        /*
         * ⚠️ THE RESPONSE IS READ, OR A REFUSAL SHOWS AS "Content updated". This used to be a bare
         * await, so a 400 (wrong file type, a bundle swapped for an image) ended in the success
         * toast while the item was unchanged — the operator walked away believing the screens now
         * showed the new file. Same idiom as the details PUT above; the catch shows the server's own
         * reason. An approval workspace answers with a draft, so the toast must say so.
         */
        const rr = await fetch('/api/content/' + contentItem.id + '/replace', {
          method: 'PUT',
          headers,
          body: formData
        });
        const rb = await rr.json().catch(() => ({}));
        if (!rr.ok) throw new Error(rb.error || t('content.error_update_failed'));
        if (rb.pending_review) pendingReview = true;
      }

      // #216: upload a new subtitle .vtt if one was chosen (skipped when "remove" is ticked).
      if (subtitleFile && !subRemove) {
        const subForm = new FormData();
        subForm.append('subtitle', subtitleFile);
        if (subLangEl?.value) subForm.append('subtitle_lang', subLangEl.value);
        assertLocalCallAllowed('/content', 'POST');
        // ⚠️ Checked for the same reason as the replace above: a refused .vtt is not a success.
        const sr = await fetch('/api/content/' + contentItem.id + '/subtitle', {
          method: 'POST',
          headers,
          body: subForm
        });
        const sb = await sr.json().catch(() => ({}));
        if (!sr.ok) throw new Error(sb.error || t('content.error_update_failed'));
      }

      closeEdit();
      showToast(pendingReview ? t('review.toast.saved_as_draft') : t('content.toast.updated'), 'success');
      if (onSave) onSave();
    } catch (err) {
      showToast(err.message || t('content.error_update_failed'), 'error');
    }
  };
}

async function showPreview(content) {
  /*
   * ⚠️ A BUNDLE IS PREVIEWED THROUGH AN EPHEMERAL SESSION, NOT ITS PUBLIC URL. /api/content/:id/
   * bundle is gated on the content being referenced by a playlist — which a just-uploaded bundle is
   * not — so pointing an iframe at it here would 403 and show an empty box. That is the same
   * "preview shows nothing" trap the directory-board backgrounds had.
   *
   * The frame is sandboxed to allow-scripts with NO allow-same-origin, exactly as a player mounts
   * it. This is the dashboard origin, where the session JWT lives in localStorage, so that is not
   * a detail: an operator-uploaded bundle must never run with access to it.
   *
   * ⚠️ AND IT MUST BE src=, NOT srcdoc, even though the player uses srcdoc for the same bytes. A
   * srcdoc frame inherits ITS PARENT'S CSP; this page has one (`script-src 'self'`) and a flattened
   * bundle is entirely data: URIs, so every script in it would be blocked and the preview would
   * render a styled, dead page with nothing in any log. The player gets away with srcdoc only
   * because /player is CSP-exempt. Measured both ways — do not "simplify" this to srcdoc.
   */
  if (content.mime_type === BUNDLE_MIME) {
    let session;
    try {
      session = await api.post(`/content/${content.id}/bundle-preview`);
    } catch (err) {
      showToast(err.message || t('content.bundle_preview_failed'), 'error');
      return;
    }
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    overlay.innerHTML = `
      <div style="background:var(--bg-secondary);border-radius:var(--radius-lg);max-width:90vw;max-height:90vh;overflow:hidden;position:relative">
        <button style="position:absolute;top:8px;right:8px;z-index:1;background:rgba(0,0,0,0.7);border:none;color:white;width:32px;height:32px;border-radius:50%;font-size:18px;cursor:pointer" id="closePreview">&times;</button>
        <iframe sandbox="allow-scripts" src="${esc(session.url)}" style="width:80vw;height:45vw;max-height:80vh;display:block;border:none;background:#000"></iframe>
        <div style="padding:12px 16px;border-top:1px solid var(--border)">
          <div style="font-weight:500">${esc(content.filename)}</div>
          <div style="font-size:12px;color:var(--text-muted)">${t('content.type_bundle')} — ${t('content.bundle_entry', { entry: esc(content.bundle_entry || 'index.html') })}</div>
          ${(session.skipped && session.skipped.length)
            ? `<div style="font-size:12px;color:#f59e0b;margin-top:6px">${t('content.bundle_skipped', { n: session.skipped.length })}</div>`
            : ''}
        </div>
      </div>`;
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.querySelector('#closePreview').onclick = () => overlay.remove();
    document.body.appendChild(overlay);
    return;
  }

  const isYoutube = content.mime_type === 'video/youtube';
  // The screen's HDMI input exists only on the screen: nothing here can open hdmi://.
  const isHdmiIn = content.mime_type === 'video/hdmi-in';
  const isVideo = !isYoutube && !isHdmiIn && content.mime_type?.startsWith('video/');
  const src = content.remote_url || `/uploads/content/${content.filepath}`;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div style="background:var(--bg-secondary);border-radius:var(--radius-lg);max-width:90vw;max-height:90vh;overflow:hidden;position:relative">
      <button style="position:absolute;top:8px;right:8px;z-index:1;background:rgba(0,0,0,0.7);border:none;color:white;width:32px;height:32px;border-radius:50%;font-size:18px;cursor:pointer" id="closePreview">&times;</button>
      <div style="max-width:80vw;max-height:80vh">
        ${isYoutube
          ? `<iframe referrerpolicy="strict-origin-when-cross-origin" src="${(() => { /* #YT153 ROOT CAUSE: the dashboard sends Referrer-Policy: no-referrer (helmet default), so a raw YouTube iframe reaches youtube.com with NO Referer -> YouTube can't identify the embedding site -> "Video player configuration error" (153). referrerpolicy on THIS iframe overrides the page policy to send just our origin, which YouTube uses to validate the embed. (The device player dodges no-referrer differently: YT.Player's iframe_api origin postMessage handshake, which doesn't rely on Referer.) The enablejsapi/origin URL params are inert in a raw iframe (no API loaded), so they're dropped. */ try { const u = new URL(src); u.searchParams.set('mute', '1'); u.searchParams.delete('enablejsapi'); u.searchParams.delete('origin'); return u.toString(); } catch { return src; } })()}" style="width:80vw;height:45vw;max-height:80vh;display:block;border:none" allow="autoplay;encrypted-media" allowfullscreen></iframe>`
          : isHdmiIn
            ? `<div style="padding:48px 56px;max-width:520px;color:var(--text-primary)"><div style="font-weight:600;font-size:18px;margin-bottom:8px">${esc(content.filename)}</div><div style="color:var(--text-muted);font-size:14px">${t('content.hdmi_in_desc')}</div></div>`
          : isVideo
            ? `<video src="${esc(src)}" controls autoplay style="max-width:80vw;max-height:80vh;display:block"></video>`
            : `<img src="${esc(src)}" style="max-width:80vw;max-height:80vh;display:block">`
        }
      </div>
      <div style="padding:12px 16px;border-top:1px solid var(--border)">
        <div style="font-weight:500">${esc(content.filename)}</div>
        <div style="font-size:12px;color:var(--text-muted)">${esc(content.mime_type)} ${content.remote_url ? `(${t('content.type_remote')})` : ''}</div>
      </div>
    </div>
  `;
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('#closePreview').onclick = () => overlay.remove();
  document.body.appendChild(overlay);
}

// Build a "Parent / Child / Leaf" path for a folder so the move-to dropdown is unambiguous
// when two folders share a name in different branches.
function folderPath(folder, all) {
  const byId = new Map(all.map(f => [f.id, f]));
  const parts = [folder.name];
  let cursor = folder;
  while (cursor.parent_id && byId.has(cursor.parent_id)) {
    cursor = byId.get(cursor.parent_id);
    parts.unshift(cursor.name);
  }
  return parts.join(' / ');
}

export function cleanup() {
  closeMenu();
  clearTimeout(searchTimer);
  clearTimeout(reloadTimer);
  if (inflight) inflight.abort();
  if (unsubscribeUploads) { unsubscribeUploads(); unsubscribeUploads = null; }
  // Unsaved inspector edits are kept, not dropped: they come back, still marked unsaved, next visit.
  if (inspector) { state.pendingDraft = inspector.takeDraft(); inspector.close({ force: true, silent: true }); inspector = null; }
  // The upload queue and its tray live on <body> and keep going.
}
