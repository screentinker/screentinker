/*
 * The "add content" picker — ONE implementation, used by a playlist (Playlists → + Add Content) and
 * by a display (Display → Playlist → + Add Content).
 *
 * ⚠️ WHY IT IS SHARED. The two screens had grown two different pickers: the playlist one got
 * folders, search, sort, multi-select and nested playlists; the display one stayed a flat grid of
 * everything with one pick at a time. A customer with a foldered library then saw folders in one
 * place and "all available options in a single list" in the other, and reasonably asked for the
 * folders. Two pickers will always drift; one cannot.
 *
 * What differs between the two callers is only WHERE an item goes, and the display's extra fields
 * (zone, duration). Those come in as options; everything the operator sees and does is the same.
 *
 *   openContentPicker({
 *     title,                      // modal heading
 *     targetPlaylistId,           // the playlist being added to (null if it does not exist yet)
 *     replaceItemId,              // #105: replace one item in place instead of adding
 *     extraFieldsHtml,            // e.g. the display's zone + duration fields
 *     add(item, extras),          // item = { type: 'content'|'widget'|'playlist', id }; returns a promise
 *     addBulk(contentIds, extras) // -> { added: [...], skipped: [...] }
 *     replace(item),              // replace mode only
 *     readExtras(modal),          // reads extraFieldsHtml's values
 *     onPick(item, modal),        // optional: a row was clicked (the display uses it for clip length)
 *     onChanged(), onClose(changed)
 *     slotMode: { allowVideo, allowWidgets }  // head office local slot: see below
 *   })
 *
 * slotMode — the store's content for a head office LOCAL SLOT (docs/corporate-playlists.md). A slot
 * holds only items whose play length the server knows (spec D15), so the picker leaves out nested
 * playlists, kiosk pages, live streams, YouTube and any video with no measured length, plus videos
 * or widgets when head office does not allow them — and says why in one line, so nothing looks
 * missing by accident. The server refuses all of them anyway (FILL_FLAT / FILL_LIVE / FILL_TYPE).
 */
import { api } from '../api.js';
import { showToast } from './toast.js';
import { esc, hydrateAuthImages } from '../utils.js';
import {
  buildFolderTree, childrenOf, subtreeIds as subtreeIdsTree,
  countIn as countInTree, pathTo as pathToTree, unfiledCount as unfiledCountOf,
} from '../lib/folder-tree.js';
import { t, tn } from '../i18n.js';

/** Can this library item go in a head office slot? Mirrors server lib/corporate/compose.js isUnboundedItem. */
function slotPlayableItem(item, allowVideo) {
  const mime = String(item.mime_type || '').toLowerCase();
  if (mime === 'video/hls' || mime === 'video/rtsp' || mime === 'video/hdmi-in' || mime === 'video/youtube') return false;
  const timed = mime.startsWith('video/') || mime.startsWith('audio/');
  if (timed && !allowVideo) return false;
  if (timed && !(Number(item.duration_sec) > 0)) return false;
  return true;
}

export async function openContentPicker(opts = {}) {
  const replaceItemId = opts.replaceItemId || null;
  const targetPlaylistId = opts.targetPlaylistId || null;
  const readExtras = typeof opts.readExtras === 'function' ? opts.readExtras : () => ({});
  const slotMode = opts.slotMode || null;
  const slotAllowVideo = !slotMode || slotMode.allowVideo !== false;
  const slotAllowWidgets = !slotMode || slotMode.allowWidgets !== false;
  const slotPlayable = (item) => slotPlayableItem(item, slotAllowVideo);
  let changed = false;

  const modal = document.createElement('div');
  modal.className = 'content-picker-overlay';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000';
  modal.innerHTML = `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;max-width:620px;width:95vw;max-height:88vh;display:flex;flex-direction:column">
      <h3 style="margin-bottom:16px;color:var(--text-primary)">${esc(opts.title || (replaceItemId ? t('playlist.replace_modal_title') : t('playlist.add_modal_title')))}</h3>
      ${opts.extraFieldsHtml || ''}
      <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm tab-btn active" data-tab="content">${t('playlist.tab_content')}</button>
        ${slotAllowWidgets ? `<button class="btn btn-secondary btn-sm tab-btn" data-tab="widgets">${t('playlist.tab_widgets')}</button>` : ''}
        ${replaceItemId || slotMode ? '' : `<button class="btn btn-secondary btn-sm tab-btn" data-tab="playlists">${t('playlist.tab_playlists')}</button>`}
        ${replaceItemId || slotMode ? '' : `<button class="btn btn-secondary btn-sm tab-btn" data-tab="kiosk">${t('playlist.tab_kiosk')}</button>`}
      </div>
      ${slotMode ? `<div style="font-size:12px;color:var(--text-muted);margin:-4px 0 10px">${esc(t('corp.slot.no_live'))}${slotAllowVideo ? '' : ' ' + esc(t('corp.slot.no_video'))}${slotAllowWidgets ? '' : ' ' + esc(t('corp.slot.no_widgets'))}</div>` : ''}
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <input type="text" id="addItemSearch" class="input" placeholder="${t('playlist.search_placeholder')}" style="flex:1">
        <!-- Folder filter. Hidden on the tabs that have no folders. -->
        <select id="addItemFolder" class="input" style="width:auto;max-width:180px;background:var(--bg-input)" title="${t('playlist.folder_label')}">
          <option value="">${t('playlist.folder_all')}</option>
        </select>
        <select id="addItemSort" class="input" style="width:auto;background:var(--bg-input)" title="${t('playlist.sort_label')}">
          <option value="name_asc">${t('playlist.sort.name_asc')}</option>
          <option value="name_desc">${t('playlist.sort.name_desc')}</option>
          <option value="date_desc">${t('playlist.sort.date_desc')}</option>
          <option value="date_asc">${t('playlist.sort.date_asc')}</option>
          <option value="duration_asc">${t('playlist.sort.duration_asc')}</option>
          <option value="duration_desc">${t('playlist.sort.duration_desc')}</option>
        </select>
      </div>
      <!--
        The folder slide bar: the SAME filter as the dropdown, not a second one. Both write
        folderFilter and both are redrawn from it, so they can never show different things.
      -->
      <!-- ⚠️ flex:none on the folder bar, flex:1 1 auto + a small min-height on the list: on a
           1366x768 laptop the modal is height-bound, and it squeezed the FOLDER panel to 22px (less
           than one row of chips) while the item list kept 319px. The list is the one that scrolls
           comfortably at any height; it is the one that gives. -->
      <div id="addItemFolderBar" style="display:flex;flex:none;gap:6px;overflow-x:auto;overflow-y:hidden;padding:2px 0 8px;margin-bottom:4px;scrollbar-width:thin"></div>
      <div id="addItemList" style="flex:1 1 auto;overflow-y:auto;min-height:140px;max-height:400px"></div>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:16px">
        <div id="addBulkBar" style="display:none;align-items:center;gap:10px;flex:1">
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-secondary);cursor:pointer">
            <input type="checkbox" id="addSelectAll"> ${t('playlist.select_all_shown')}
          </label>
          <button class="btn btn-primary btn-sm" id="addSelectedBtn"></button>
        </div>
        <button class="btn btn-secondary" id="closeAddModal">${t('playlist.close')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const $ = (sel) => modal.querySelector(sel);

  let activeTab = 'content';
  // #318: ids ticked in the content tab. A Set rather than reading the DOM, so a tick survives
  // re-rendering the list when the search or the sort changes.
  const selected = new Set();
  let allContent = [];
  let allWidgets = [];
  let allPlaylists = [];
  let allKiosk = [];
  let allFolders = [];
  // ⚠️ THE single source of truth for the folder filter.
  // '' = all folders, '__root__' = filed nowhere, otherwise a folder id.
  let folderFilter = '';
  let contentTruncated = false;
  // Whether the target playlist may take a child at all (the server refuses if it is already used
  // as one). Explained in the tab rather than letting the operator collect a 400.
  let nestingBlockedBy = null;
  let loadError = null;

  /*
   * FOLDERS ARE A TREE. The bar is a BREADCRUMB — where you are, then what is inside it — so it
   * stays one line deep however many folders exist. The tree lives in lib/folder-tree.js.
   *
   * ⚠️ childrenOf IS A FUNCTION OF (tree, parent). The picker this was lifted from called
   * `childrenOf.get(parent)` — as if it were the Map it replaced — which threw on every render.
   * The load path swallowed the TypeError and then painted the list anyway, so folders simply
   * never appeared: no error, no console line, and a customer asking for a feature they already
   * had. Always go through kidsOf.
   */
  let folderTree = buildFolderTree([]);
  const buildTree = () => { folderTree = buildFolderTree(allFolders); };
  const kidsOf = (parent) => childrenOf(folderTree, parent) || [];
  const countIn = (id) => countInTree(folderTree, id, allContent);
  const pathTo = (id) => pathToTree(folderTree, id);
  const subtreeIds = (id) => subtreeIdsTree(folderTree, id);
  const unfiledCount = () => unfiledCountOf(allContent);

  try {
    /*
     * ⚠️ getAllContent, NOT getContent: the endpoint defaults to LIMIT 100, and this picker once
     * showed only the newest hundred — so the files an operator had already filed into folders
     * were exactly the ones missing.
     */
    const [content, widgets, playlists, folders, kiosk] = await Promise.all([
      api.getAllContent(),
      api.getWidgets().catch(() => []),
      api.getPlaylists().catch(() => []),
      api.getFolders ? api.getFolders().catch(() => []) : Promise.resolve([]),
      api.getKioskPages().catch(() => []),
    ]);
    allContent = slotMode ? content.items.filter(slotPlayable) : content.items;
    contentTruncated = content.truncated;
    allWidgets = Array.isArray(widgets) ? widgets : [];
    allPlaylists = Array.isArray(playlists) ? playlists : [];
    allFolders = Array.isArray(folders) ? folders : [];
    allKiosk = Array.isArray(kiosk) ? kiosk : [];
    const self = targetPlaylistId && allPlaylists.find((p) => p.id === targetPlaylistId);
    if (self && self.used_by_count > 0) nestingBlockedBy = self.used_by_count;
  } catch (err) {
    loadError = err;
  }
  // Drawing the folders is separate from loading them, so a drawing bug can never again be
  // reported as (or hidden behind) a load failure.
  buildTree();
  populateFolderFilter();
  renderFolderBar();

  function markChanged() {
    changed = true;
    if (typeof opts.onChanged === 'function') { try { opts.onChanged(); } catch (e) { /* caller's */ } }
  }

  /*
   * #318/#319: name order by default — filenames carrying a timestamp are the common case.
   */
  function sortItems(list, mode) {
    const name = (i) => (i.filename || i.name || '').toLowerCase();
    const when = (i) => Number(i.created_at) || 0;
    const dur = (i) => Number(i.duration_sec) || 0;
    const by = {
      name_asc: (a, b) => name(a).localeCompare(name(b), undefined, { numeric: true }),
      name_desc: (a, b) => name(b).localeCompare(name(a), undefined, { numeric: true }),
      date_asc: (a, b) => when(a) - when(b),
      date_desc: (a, b) => when(b) - when(a),
      duration_asc: (a, b) => dur(a) - dur(b),
      duration_desc: (a, b) => dur(b) - dur(a),
    };
    return list.slice().sort(by[mode] || by.name_asc);
  }

  function updateBulkBar() {
    const bar = $('#addBulkBar');
    const btn = $('#addSelectedBtn');
    const all = $('#addSelectAll');
    if (!bar || !btn) return;
    const n = selected.size;
    bar.style.display = n ? 'flex' : 'none';
    btn.textContent = tn('playlist.add_n_selected', n);
    if (all) {
      const shown = Array.from(modal.querySelectorAll('.add-item-check'));
      all.checked = shown.length > 0 && shown.every((cb) => cb.checked);
    }
  }

  function chip(value, label, count, { current = false } = {}) {
    const style = current
      ? 'background:var(--primary,#3B82F6);color:#fff;border-color:transparent'
      : 'background:var(--bg-input);color:var(--text-secondary)';
    return `<button type="button" class="picker-folder-chip" data-folder="${esc(value)}"
      style="flex:0 0 auto;border:1px solid var(--border);border-radius:999px;padding:4px 12px;font-size:12px;cursor:pointer;white-space:nowrap;${style}"
      >${esc(label)}${count === null ? '' : ` (${count})`}</button>`;
  }

  /** The slide bar: breadcrumb to where you are, then the folders inside it. */
  function renderFolderBar() {
    const bar = $('#addItemFolderBar');
    if (!bar) return;
    if (activeTab !== 'content' || !allFolders.length) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';

    const parts = [];
    const atAll = folderFilter === '' || folderFilter === '__root__';
    parts.push(chip('', t('playlist.folder_all'), allContent.length, { current: folderFilter === '' }));

    let childParent = '';
    if (!atAll) {
      for (const f of pathTo(folderFilter)) {
        parts.push('<span style="flex:0 0 auto;align-self:center;color:var(--text-muted);font-size:12px">›</span>');
        parts.push(chip(f.id, f.name, countIn(f.id), { current: f.id === folderFilter }));
      }
      childParent = folderFilter;
    }

    // Search finds FOLDERS as well as files: while there is a query, the bar shows the folders
    // whose names match — from anywhere in the tree, with their path — INSTEAD of this level's
    // children, so one of two hundred is a few keystrokes away rather than a scroll.
    const q = ($('#addItemSearch')?.value || '').trim().toLowerCase();
    const hits = q ? allFolders.filter((f) => (f.name || '').toLowerCase().includes(q) && countIn(f.id) > 0 && f.id !== folderFilter).slice(0, 40) : [];
    if (hits.length) {
      parts.push(`<span style="flex:0 0 auto;align-self:center;color:var(--text-muted);font-size:11px;padding:0 2px">${esc(t('playlist.folders_matching'))}</span>`);
      for (const f of hits) parts.push(chip(f.id, pathTo(f.id).map((x) => x.name).join(' › ') || f.name, countIn(f.id)));
    }

    const kids = hits.length ? [] : kidsOf(childParent).map((f) => ({ f, n: countIn(f.id) }));
    const shown = kids.filter((k) => k.n > 0);
    if (shown.length) {
      parts.push('<span style="flex:0 0 auto;align-self:center;color:var(--text-muted);font-size:12px">│</span>');
      for (const { f, n } of shown) parts.push(chip(f.id, f.name, n));
    }

    /*
     * ⚠️ A LIBRARY WITH HUNDREDS OF FOLDERS. One sideways-scrolling line is fine for a dozen and
     * hopeless for two hundred (a mouse wheel scrolls vertically, so folder #150 is reachable only
     * by dragging a scrollbar). Past a dozen at this level the chips WRAP into a short panel that
     * scrolls vertically instead.
     */
    const many = shown.length > 12 || hits.length > 8;
    bar.style.flexWrap = many ? 'wrap' : 'nowrap';
    bar.style.overflowX = many ? 'hidden' : 'auto';
    bar.style.overflowY = many ? 'auto' : 'hidden';
    bar.style.maxHeight = many ? '108px' : '';

    const hidden = kids.length - shown.length;
    if (hidden > 0) {
      parts.push(`<span style="flex:0 0 auto;align-self:center;color:var(--text-muted);font-size:11px;padding-left:4px"
        >${esc(t('playlist.folders_empty_hidden', { n: hidden }))}</span>`);
    }
    bar.innerHTML = parts.join('');
    bar.querySelectorAll('.picker-folder-chip').forEach((b) => b.addEventListener('click', () => {
      setFolderFilter(b.getAttribute('data-folder'));
    }));
  }

  /** The dropdown, indented to show the same tree — for jumping straight to a known folder. */
  function populateFolderFilter() {
    const sel = $('#addItemFolder');
    if (!sel) return;
    const opts2 = [`<option value="">${esc(t('playlist.folder_all'))} (${allContent.length})</option>`];
    if (unfiledCount() > 0 && allFolders.length) {
      opts2.push(`<option value="__root__">${esc(t('playlist.folder_root'))} (${unfiledCount()})</option>`);
    }
    const walk = (parent, depth) => {
      for (const f of kidsOf(parent)) {
        const n = countIn(f.id);
        if (n > 0) {
          const indent = depth ? '  '.repeat(depth) + '↳ ' : '';
          opts2.push(`<option value="${esc(f.id)}">${indent}${esc(f.name)} (${n})</option>`);
        }
        walk(f.id, depth + 1);
      }
    };
    walk('', 0);
    sel.innerHTML = opts2.join('');
    sel.value = folderFilter;
  }

  function setFolderFilter(value) {
    folderFilter = value || '';
    const sel = $('#addItemFolder');
    if (sel) sel.value = folderFilter;
    renderFolderBar();
    renderTab();
  }

  function emptyRow(text) {
    return `<div style="color:var(--text-muted);padding:24px;text-align:center;line-height:1.6">${esc(text)}</div>`;
  }

  async function doAdd(btn, item, labels) {
    try {
      btn.disabled = true;
      btn.textContent = t('playlist.adding');
      await opts.add(item, readExtras(modal));
      btn.textContent = t('playlist.added');
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-secondary');
      markChanged();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = labels.idle;
      showToast(err.message, 'error');   // the server's message already names the item
    }
  }

  /*
   * Playlists that may be nested. Each exclusion mirrors a server rule (lib/playlist-nesting.js)
   * so the operator never picks something that will be refused.
   */
  function renderPlaylistsTab(list, search) {
    if (nestingBlockedBy) { list.innerHTML = emptyRow(tn('playlist.nest_blocked', nestingBlockedBy)); return; }
    const candidates = sortItems(allPlaylists.filter((p) =>
      p.id !== targetPlaylistId && !p.has_children
      && (p.name || '').toLowerCase().includes(search)), $('#addItemSort')?.value || 'name_asc');
    if (!candidates.length) { list.innerHTML = emptyRow(t('playlist.no_playlists_nestable')); return; }
    list.innerHTML = candidates.map((p) => `
      <div class="add-item-row" style="display:flex;align-items:center;gap:12px;padding:10px;border-radius:var(--radius)">
        <div style="width:48px;height:36px;border-radius:4px;background:var(--bg-input);display:flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--text-muted)">☰</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.name)}</div>
          <div style="font-size:12px;color:var(--text-muted)">
            ${esc(tn('playlist.n_items', p.item_count || 0))}${p.status !== 'published' ? ' · ' + esc(t('playlist.nest_draft_note')) : ''}
          </div>
        </div>
        <button class="btn btn-primary btn-sm add-child-btn" data-id="${esc(p.id)}">${t('playlist.add_btn')}</button>
      </div>`).join('');
    list.querySelectorAll('.add-child-btn').forEach((btn) => btn.addEventListener('click', () =>
      doAdd(btn, { type: 'playlist', id: btn.dataset.id }, { idle: t('playlist.add_btn') })));
  }

  /*
   * Kiosk pages play as a webpage widget pointing at the page's render URL. Same-origin on
   * purpose: a dashboard opened through localhost is reachable only from the dashboard machine,
   * not from the display that will render the widget.
   */
  function renderKioskTab(list, search) {
    const pages = sortItems(allKiosk.filter((k) => (k.name || '').toLowerCase().includes(search)), $('#addItemSort')?.value || 'name_asc');
    if (!pages.length) {
      list.innerHTML = `<div style="color:var(--text-muted);padding:24px;text-align:center">${esc(t('playlist.no_kiosk_found'))}
        <a href="#/kiosk" style="color:var(--accent)">${esc(t('device.assign.create_one'))}</a></div>`;
      return;
    }
    list.innerHTML = pages.map((k) => `
      <div class="add-item-row" style="display:flex;align-items:center;gap:12px;padding:10px;border-radius:var(--radius)">
        <div style="width:48px;height:36px;border-radius:4px;background:var(--bg-input);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px">&#128433;</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(k.name)}</div>
          <div style="font-size:12px;color:var(--text-muted)">${esc(t('playlist.item_kiosk'))}</div>
        </div>
        <button class="btn btn-primary btn-sm add-kiosk-btn" data-id="${esc(k.id)}">${t('playlist.add_btn')}</button>
      </div>`).join('');
    list.querySelectorAll('.add-kiosk-btn').forEach((btn) => btn.addEventListener('click', async () => {
      const page = allKiosk.find((k) => k.id === btn.dataset.id);
      const pageName = page && page.name ? page.name : 'Page';
      try {
        btn.disabled = true;
        const w = await api.createWidget({
          widget_type: 'webpage',
          name: t('device.assign.kiosk_widget_name', { name: pageName }),
          config: { url: `/api/kiosk/${btn.dataset.id}/render` },
        });
        allWidgets.push(w);
        await doAdd(btn, { type: 'widget', id: w.id, kiosk: true }, { idle: t('playlist.add_btn') });
      } catch (err) {
        btn.disabled = false;
        showToast(err.message, 'error');
      }
    }));
  }

  const WIDGET_ICONS = { clock: '&#128339;', weather: '&#9925;', rss: '&#128240;', text: '&#128221;', webpage: '&#127760;', social: '&#128172;', slide: '&#128444;', template: '&#10024;' };

  /*
   * ⚠️ The RENDER is capped, the FETCH is not: a list shows a bounded number of rows and SAYS
   * how many more matched.
   */
  const MAX_ROWS = 200;

  function renderTab() {
    const list = $('#addItemList');
    const search = ($('#addItemSearch')?.value || '').toLowerCase();
    const folderSel = $('#addItemFolder');
    if (folderSel) folderSel.style.display = activeTab === 'content' && allFolders.length ? '' : 'none';
    const bar = $('#addItemFolderBar');
    if (bar) bar.style.display = activeTab === 'content' && allFolders.length ? 'flex' : 'none';
    const sortSel = $('#addItemSort');
    if (sortSel) sortSel.style.display = activeTab === 'content' || activeTab === 'widgets' ? '' : 'none';

    if (loadError) { list.innerHTML = emptyRow(t('playlist.load_failed', { error: loadError.message })); return; }
    if (activeTab === 'playlists') return renderPlaylistsTab(list, search);
    if (activeTab === 'kiosk') return renderKioskTab(list, search);

    const items = activeTab === 'content' ? allContent : allWidgets;
    const sortMode = $('#addItemSort')?.value || 'name_asc';
    const active = activeTab === 'content' ? folderFilter : '';
    // ⚠️ SUBTREE, not the folder alone: picking a parent means "everything under here".
    const wanted = active && active !== '__root__' ? subtreeIds(active) : null;
    const matched = sortItems(items.filter((item) => {
      const name = (item.filename || item.name || '').toLowerCase();
      if (!name.includes(search)) return false;
      if (!active) return true;
      if (active === '__root__') return !item.folder_id;
      return !!item.folder_id && wanted.has(item.folder_id);
    }), sortMode);
    const filtered = matched.slice(0, MAX_ROWS);
    const hidden = matched.length - filtered.length;
    // #318: bulk add is content-only, and meaningless when replacing one item.
    const selectable = activeTab === 'content' && !replaceItemId && typeof opts.addBulk === 'function';

    if (!filtered.length) {
      list.innerHTML = emptyRow(activeTab === 'content' ? t('playlist.no_content_found') : t('playlist.no_widgets_found'));
      return;
    }
    const notices = [];
    if (hidden > 0) notices.push(`<div style="padding:8px 10px;font-size:12px;color:var(--text-muted);text-align:center">${esc(t('playlist.more_matches', { n: hidden }))}</div>`);
    if (contentTruncated && activeTab === 'content') notices.push(`<div style="padding:8px 10px;font-size:12px;color:var(--warning,#d97706);text-align:center">${esc(t('playlist.library_truncated'))}</div>`);

    const idleLabel = replaceItemId ? t('playlist.replace_btn') : t('playlist.add_btn');
    list.innerHTML = notices.join('') + filtered.map((item) => {
      const isWidget = activeTab === 'widgets';
      const name = item.filename || item.name || t('common.unknown');
      // #237: show a video's own length, which is the duration it lands with.
      const clipSec = !isWidget && Number(item.duration_sec) > 0 ? Math.ceil(item.duration_sec) : 0;
      const clip = clipSec ? ` · ${Math.floor(clipSec / 60)}:${String(clipSec % 60).padStart(2, '0')}` : '';
      const sub = isWidget ? (item.widget_type || t('playlist.item_widget')) : ((item.mime_type || '') + clip);
      const thumb = !isWidget && item.thumbnail_path ? `/api/content/${esc(item.id)}/thumbnail` : null;
      const icon = isWidget
        ? `<div style="font-size:18px">${WIDGET_ICONS[item.widget_type] || '&#9881;'}</div>`
        : '<div style="color:var(--text-muted);opacity:0.4"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg></div>';
      return `
        <div class="add-item-row" data-id="${esc(item.id)}" data-type="${isWidget ? 'widget' : 'content'}" data-duration="${clipSec || ''}" style="display:flex;align-items:center;gap:12px;padding:10px;border-radius:var(--radius);cursor:pointer;transition:background 0.1s">
          ${selectable ? `<input type="checkbox" class="add-item-check" data-id="${esc(item.id)}" ${selected.has(item.id) ? 'checked' : ''} style="flex-shrink:0;cursor:pointer">` : ''}
          <div style="width:40px;height:30px;border-radius:4px;overflow:hidden;background:var(--bg-input);flex-shrink:0;display:flex;align-items:center;justify-content:center">
            ${thumb ? `<img data-auth-src="${thumb}" style="width:100%;height:100%;object-fit:cover">` : icon}
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(name)}</div>
            <div style="font-size:11px;color:var(--text-muted)">${esc(sub)}</div>
          </div>
          <button class="btn btn-primary btn-sm add-item-btn" data-id="${esc(item.id)}" data-type="${isWidget ? 'widget' : 'content'}">${idleLabel}</button>
        </div>`;
    }).join('');
    hydrateAuthImages(list, { eager: true });

    list.querySelectorAll('.add-item-row').forEach((row) => row.addEventListener('click', () => {
      if (typeof opts.onPick === 'function') opts.onPick({ type: row.dataset.type, id: row.dataset.id, duration: parseInt(row.dataset.duration || '', 10) || 0 }, modal);
    }));
    list.querySelectorAll('.add-item-check').forEach((cb) => {
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(cb.dataset.id); else selected.delete(cb.dataset.id);
        updateBulkBar();
      });
    });
    updateBulkBar();

    list.querySelectorAll('.add-item-btn').forEach((btn) => btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const item = { type: btn.dataset.type, id: btn.dataset.id };
      if (replaceItemId) {
        try {
          btn.disabled = true;
          btn.textContent = t('playlist.replacing');
          await opts.replace(item);
          changed = true;
          close();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = idleLabel;
          showToast(err.message, 'error');
        }
        return;
      }
      await doAdd(btn, item, { idle: idleLabel });
    }));
  }

  modal.querySelectorAll('.tab-btn').forEach((btn) => btn.addEventListener('click', () => {
    activeTab = btn.dataset.tab;
    modal.querySelectorAll('.tab-btn').forEach((b) => {
      b.classList.toggle('btn-primary', b.dataset.tab === activeTab);
      b.classList.toggle('btn-secondary', b.dataset.tab !== activeTab);
      b.classList.toggle('active', b.dataset.tab === activeTab);
    });
    renderFolderBar();
    renderTab();
  }));

  $('#addItemSearch').addEventListener('input', () => { renderFolderBar(); renderTab(); });
  $('#addItemSort')?.addEventListener('change', renderTab);
  $('#addItemFolder')?.addEventListener('change', (e) => setFolderFilter(e.target.value));

  $('#addSelectAll')?.addEventListener('change', (e) => {
    // "Select all" means all rows CURRENTLY SHOWN, never the whole library.
    modal.querySelectorAll('.add-item-check').forEach((cb) => {
      cb.checked = e.target.checked;
      if (cb.checked) selected.add(cb.dataset.id); else selected.delete(cb.dataset.id);
    });
    updateBulkBar();
  });

  $('#addSelectedBtn')?.addEventListener('click', async () => {
    const btn = $('#addSelectedBtn');
    // #318: in the ORDER THE LIST IS SHOWING, not the order the boxes were ticked.
    const shown = Array.from(modal.querySelectorAll('.add-item-check')).map((cb) => cb.dataset.id);
    const ids = shown.filter((id) => selected.has(id));
    for (const id of selected) if (!ids.includes(id)) ids.push(id);
    if (!ids.length) return;
    try {
      btn.disabled = true;
      btn.textContent = t('playlist.adding');
      const res = await opts.addBulk(ids, readExtras(modal));
      const added = (res && res.added ? res.added.length : 0);
      const skipped = (res && res.skipped) || [];
      selected.clear();
      renderTab();
      markChanged();
      if (skipped.length) showToast(t('playlist.toast.bulk_added_partial', { added, skipped: skipped.length }), 'warning');
      else showToast(tn('playlist.toast.bulk_added', added), 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      updateBulkBar();
    }
  });

  function close() {
    modal.remove();
    if (typeof opts.onClose === 'function') opts.onClose(changed);
  }
  $('#closeAddModal').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  renderTab();
  return { modal, close };
}
