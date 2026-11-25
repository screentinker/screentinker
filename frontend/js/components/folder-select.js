/*
 * Folder select — a pick-ONE <select> that can be browsed by folder (or by group) and searched.
 *
 * ⚠️ WHY. The schedule dialog chose its screen, playlist and content from three plain <select>s that
 * list EVERYTHING in one column. On a workspace with hundreds of screens or files that is a scroll
 * through an unordered wall, while the same library is neatly foldered everywhere else (Content
 * Library folders, playlist folders #796, device groups). The playlist's Add Content picker solved the
 * same problem for adding items; this brings its navigation — a breadcrumb of chips, the folders
 * inside the current one, search that finds folders as well as items, subtree counts — to a field
 * that picks ONE value.
 *
 * ⚠️ THE <select> STAYS THE SOURCE OF TRUTH. It is hidden, not replaced: every existing read
 * (`select.value` in save/readForm), write (`select.value = id` when a schedule is opened for editing)
 * and `change` listener (time zone note, head office note) keeps working untouched. A programmatic
 * `select.value = x` does not fire `change`, so the instance's `value` setter is wrapped to repaint
 * the button — without that, editing a schedule would show the PREVIOUS schedule's screen.
 *
 *   const fs = enhanceFolderSelect(select, {
 *     folders: [{ id, parent_id, name }],              // a tree (folder-tree.js); flat groups are fine
 *     items:   [{ id, label, sub?, folderIds?: [], thumb? }],
 *     allLabel, unfiledLabel, searchPlaceholder, noneLabel?,  // noneLabel: offer the '' option
 *   });
 *   fs.root                // the element shown in the form (toggle its display to hide the field)
 *   fs.refresh()           // repaint the button from select.value
 *   fs.setData({ folders, items })   // replace the data (e.g. after a reload)
 */
import { esc, hydrateAuthImages } from '../utils.js';
import { t, tn } from '../i18n.js';
import {
  ALL, UNFILED, buildModel, countIn, unfiledCount, itemsIn, foldersAt, emptyFoldersAt,
  matchingFolders, breadcrumb, placeLabel,
} from '../lib/folder-select-model.js';

const MAX_ROWS = 200;
// Past this many chips at one level the bar wraps into a short scrolling panel instead of one
// sideways line — the same threshold and reason as the Add Content picker.
const WRAP_AT = 12;

let seq = 0;

export function enhanceFolderSelect(select, opts = {}) {
  const id = `fsel${++seq}`;
  let model = buildModel(opts.folders, opts.items);
  let where = ALL;
  let query = '';
  let open = false;

  const root = document.createElement('div');
  root.className = 'fsel';
  root.innerHTML = `
    <button type="button" class="fsel-trigger input" aria-haspopup="listbox" aria-expanded="false" aria-controls="${id}-panel">
      <span class="fsel-value"></span><span class="fsel-place"></span><span class="fsel-caret" aria-hidden="true">▾</span>
    </button>
    <div class="fsel-panel" id="${id}-panel" hidden>
      <input type="search" class="input fsel-search" placeholder="${esc(opts.searchPlaceholder || t('folder_select.search'))}" aria-label="${esc(opts.searchPlaceholder || t('folder_select.search'))}">
      <div class="fsel-bar"></div>
      <div class="fsel-list" role="listbox" aria-labelledby="${id}-panel"></div>
    </div>`;
  select.insertAdjacentElement('afterend', root);
  select.hidden = true;
  select.style.display = 'none';
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');

  const $ = (sel) => root.querySelector(sel);
  const trigger = $('.fsel-trigger');
  const panel = $('.fsel-panel');
  const search = $('.fsel-search');
  const bar = $('.fsel-bar');
  const list = $('.fsel-list');

  // ---------------------------------------------------------------- the value
  const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(select, 'value', {
    configurable: true,
    get() { return proto.get.call(this); },
    set(v) { proto.set.call(this, v); refresh(); },
  });

  function labelFor(value) {
    if (value === '' || value == null) return opts.noneLabel || '';
    const it = model.items.find((x) => String(x.id) === String(value));
    if (it) return it.label;
    // Not in the item list (e.g. a value the caller has but did not describe): fall back to the
    // <option> text, so the field never goes blank on something it can still save.
    const o = Array.from(select.options).find((x) => x.value === value);
    return o ? o.textContent : String(value);
  }

  function refresh() {
    const v = select.value;
    $('.fsel-value').textContent = labelFor(v) || '—';
    const place = v ? placeLabel(model, v) : '';
    $('.fsel-place').textContent = place ? ` · ${place}` : '';
    trigger.title = place ? `${labelFor(v)} — ${place}` : labelFor(v);
    if (open) renderList();
  }

  function choose(value) {
    if (select.value !== value) {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    refresh();
    close();
    trigger.focus();
  }

  // ---------------------------------------------------------------- the browser
  function chip(value, label, count, current) {
    return `<button type="button" class="fsel-chip${current ? ' current' : ''}" data-where="${esc(value)}"
      >${esc(label)}${count == null ? '' : ` <span class="fsel-count">${count}</span>`}</button>`;
  }

  function renderBar() {
    const hasFolders = model.tree.byId.size > 0;
    bar.hidden = !hasFolders;
    if (!hasFolders) return;
    const parts = [chip(ALL, opts.allLabel || t('folder_select.all'), model.items.length, where === ALL)];
    for (const f of breadcrumb(model, where)) {
      parts.push('<span class="fsel-sep" aria-hidden="true">›</span>');
      parts.push(chip(f.id, f.name, countIn(model, f.id), f.id === where));
    }
    if (where === UNFILED) {
      parts.push('<span class="fsel-sep" aria-hidden="true">›</span>');
      parts.push(chip(UNFILED, opts.unfiledLabel || t('folder_select.unfiled'), unfiledCount(model), true));
    }
    // Search finds FOLDERS too, from anywhere in the tree, so one of two hundred is a few keystrokes away.
    const hits = matchingFolders(model, query).filter((h) => h.folder.id !== where);
    let kids = [];
    if (hits.length) {
      parts.push(`<span class="fsel-note">${esc(t('folder_select.folders_matching'))}</span>`);
      for (const h of hits) parts.push(chip(h.folder.id, h.path || h.folder.name, h.count, false));
    } else if (where !== UNFILED) {
      kids = foldersAt(model, where);
      if (kids.length) parts.push('<span class="fsel-sep" aria-hidden="true">│</span>');
      for (const k of kids) parts.push(chip(k.folder.id, k.folder.name, k.count, false));
      const empty = emptyFoldersAt(model, where);
      if (empty) parts.push(`<span class="fsel-note">${esc(tn('folder_select.empty_hidden', empty))}</span>`);
      if (where === ALL && unfiledCount(model) > 0) parts.push(chip(UNFILED, opts.unfiledLabel || t('folder_select.unfiled'), unfiledCount(model), false));
    }
    bar.classList.toggle('wrap', kids.length > WRAP_AT || hits.length > WRAP_AT / 2);
    bar.innerHTML = parts.join('');
  }

  function row(value, label, sub, thumb) {
    const selected = String(select.value) === String(value);
    const pic = thumb === undefined ? ''
      : `<span class="fsel-thumb">${thumb ? `<img data-auth-src="${esc(thumb)}" alt="">` : ''}</span>`;
    return `<button type="button" class="fsel-row${selected ? ' selected' : ''}" role="option" aria-selected="${selected}" data-value="${esc(value)}">
      ${pic}<span class="fsel-text"><span class="fsel-label">${esc(label)}</span>${sub ? `<span class="fsel-sub">${esc(sub)}</span>` : ''}</span>
      ${selected ? '<span class="fsel-check" aria-hidden="true">✓</span>' : ''}</button>`;
  }

  function renderList() {
    renderBar();
    const { shown, hidden } = itemsIn(model, where, query, MAX_ROWS);
    const withThumbs = model.items.some((i) => i.thumb !== undefined);
    const rows = [];
    if (opts.noneLabel != null && where === ALL && !query) rows.push(row('', opts.noneLabel, '', withThumbs ? null : undefined));
    for (const it of shown) rows.push(row(it.id, it.label, it.sub, withThumbs ? (it.thumb || null) : undefined));
    if (!shown.length) rows.push(`<div class="fsel-empty">${esc(t('folder_select.no_match'))}</div>`);
    if (hidden) rows.push(`<div class="fsel-empty">${esc(t('folder_select.more_matches', { n: hidden }))}</div>`);
    // Every row is row() (value, label, sub and thumbnail URL all esc()'d) or a fixed notice (a t() string, esc()'d).
    // security-ok(dom-html-sink): built only from row() and esc()'d t() notices, see the line above
    list.innerHTML = rows.join('');
    if (withThumbs) hydrateAuthImages(list, { eager: true });
  }

  function openPanel() {
    open = true;
    // Always from the top. Opening inside the current value's folder looked helpful, but a new
    // schedule pre-selects the first screen, so the browser opened inside a group the operator never
    // chose, with "All" and "No group" out of sight. The current pick is shown on the button and
    // highlighted in the list instead.
    where = ALL;
    query = '';
    search.value = '';
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    renderList();
    search.focus();
    const sel = list.querySelector('.fsel-row.selected');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function close() {
    if (!open) return;
    open = false;
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }

  trigger.addEventListener('click', () => (open ? close() : openPanel()));
  search.addEventListener('input', () => { query = search.value; renderList(); });
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-where]');
    if (!b) return;
    where = b.dataset.where;
    // Picking a folder from search results means "go there": the query was for the folder, not its files.
    if (query && where !== ALL) { query = ''; search.value = ''; }
    renderList();
    search.focus();
  });
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-value]');
    if (b) choose(b.dataset.value);
  });
  // Keyboard: arrows move through the rows, Enter picks, Escape closes the browser (not the dialog).
  root.addEventListener('keydown', (e) => {
    if (!open) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); trigger.focus(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
    const rows = Array.from(list.querySelectorAll('.fsel-row'));
    if (!rows.length) return;
    const at = rows.indexOf(document.activeElement);
    if (e.key === 'Enter') {
      if (at >= 0) return;                 // a focused row is a button: its own click picks it
      if (e.target === search) { e.preventDefault(); rows[0].click(); }
      return;
    }
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? Math.min(rows.length - 1, at + 1) : (at <= 0 ? -1 : at - 1);
    if (next < 0) search.focus(); else rows[next].focus();
  });
  // A click anywhere else closes the browser.
  document.addEventListener('mousedown', (e) => { if (open && !root.contains(e.target)) close(); });

  refresh();

  return {
    root,
    refresh,
    close,
    setData(data = {}) {
      model = buildModel(data.folders ?? opts.folders, data.items ?? opts.items);
      refresh();
    },
  };
}
