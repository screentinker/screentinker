// The Content Library's "Content details" inspector.
//
// Beside the results on a wide screen (non-modal: the list stays usable), a drawer over them on a
// narrow one (then it holds focus like a dialog, and Escape closes it). Opening an item never moves
// the list: folder, query, scroll and selection stay where they were.
//
// Name, folder and tags save with an explicit Save, as the library's edit dialog always has; leaving
// with unsaved changes asks first, so a field that looks edited is never silently dropped.
// Replace file keeps the item's identity: PUT /content/:id/replace swaps the bytes under the same id,
// so every playlist that uses it keeps it (lib/content-replace.js). It is offered only for stored
// files — a link, stream, input or hold has no file to replace.

import { api, assertLocalCallAllowed } from '../../api.js';
import { esc, hydrateAuthImages } from '../../utils.js';
import { t } from '../../i18n.js';
import { showToast } from '../toast.js';
import { confirmDialog, focusables } from './dialog.js';
import { openMenu } from './menu.js';
import { typeOf, statusOf, durationOf, dimensionsOf, formatSize, sourceOf, isStoredFile, BUNDLE_MIME, typeIcon } from './content-meta.js';

const NARROW = '(max-width: 1100px)';

export function createInspector(host, opts) {
  // opts: { folders(), folderPath(f), rootLabel, canWrite(), menuItems(item, anchor), onSaved(item),
  //         onReplaced(item), onClose(), onPreviewBundle(item) }
  let item = null;
  let draft = null;
  let usageReq = 0;
  let opener = null;
  const mq = window.matchMedia(NARROW);

  const isDirty = () => !!(item && draft && (
    draft.filename.trim() !== (item.filename || '')
    || (draft.folder_id || '') !== (item.folder_id || '')
    || draft.tags.join('\0') !== (Array.isArray(item.tags) ? item.tags : []).join('\0')));

  async function confirmLeave() {
    if (!isDirty()) return true;
    return confirmDialog({
      title: t('library.inspector.discard_title'),
      bodyHtml: esc(t('library.inspector.discard_text', { name: item.filename })),
      confirmLabel: t('library.inspector.discard_yes'),
      cancelLabel: t('library.inspector.discard_no'),
      danger: true,
    });
  }

  function stopMedia() {
    host.querySelectorAll('video, audio').forEach((m) => { try { m.pause(); m.removeAttribute('src'); m.load(); } catch (_) { /* gone */ } });
    host.querySelectorAll('iframe').forEach((f) => f.remove());
  }

  function previewHtml(c) {
    const ty = typeOf(c).key;
    const explain = (key) => `<div class="lib-insp-noprev">${typeIcon(ty, 40)}<p>${esc(t(key))}</p></div>`;
    if (ty === 'hold') return explain('library.inspector.noprev_hold');
    if (ty === 'hdmi') return explain('library.inspector.noprev_hdmi');
    if (ty === 'live') return explain('library.inspector.noprev_live');
    if (ty === 'bundle') return `<div class="lib-insp-noprev">${typeIcon('bundle', 40)}<p>${esc(t('library.inspector.bundle_prev'))}</p><button type="button" class="btn btn-secondary btn-sm" data-act="bundle-preview">${esc(t('library.inspector.bundle_open'))}</button></div>`;
    if (ty === 'youtube') {
      return `<div class="lib-insp-yt">${c.thumbnail_path ? `<img src="${esc(c.thumbnail_path)}" alt="" referrerpolicy="no-referrer">` : ''}
        <button type="button" class="btn btn-secondary btn-sm" data-act="yt-play">${esc(t('library.inspector.yt_play'))}</button></div>`;
    }
    const src = c.remote_url || (c.filepath ? `/uploads/content/${c.filepath}` : '');
    if (c.remote_url && !/^https:/i.test(c.remote_url)) return explain('library.inspector.noprev_http');
    if (ty === 'video') return `<video src="${esc(src)}" controls muted preload="metadata" playsinline></video>`;
    if (ty === 'audio') return `<div class="lib-insp-audio">${typeIcon('audio', 40)}<audio src="${esc(src)}" controls preload="none"></audio></div>`;
    if (c.remote_url) return `<img src="${esc(c.remote_url)}" alt="${esc(c.filename)}" referrerpolicy="no-referrer">`;
    return `<img data-auth-src="/api/content/${esc(c.id)}/file" alt="${esc(c.filename)}">`;
  }

  function folderOptions(sel) {
    const all = opts.folders();
    return `<option value="">${esc(opts.rootLabel)}</option>${all.map((f) => ({ f, p: opts.folderPath(f) }))
      .sort((a, b) => a.p.localeCompare(b.p, undefined, { sensitivity: 'base' }))
      .map(({ f, p }) => `<option value="${esc(f.id)}" ${sel === f.id ? 'selected' : ''}>${esc(p)}</option>`).join('')}`;
  }

  function render() {
    stopMedia();
    if (!item) { host.hidden = true; host.innerHTML = ''; return; }
    const c = item;
    const ty = typeOf(c);
    const st = statusOf(c);
    const writable = opts.canWrite();
    const rows = [
      [t('library.col.type'), ty.label + (ty.remote ? ` · ${t('library.inspector.linked')}` : '')],
      [t('library.col.duration'), durationOf(c)],
      [t('library.col.dimensions'), dimensionsOf(c)],
      [t('library.inspector.size'), isStoredFile(c) ? formatSize(c.file_size) : ''],
      [t('library.inspector.source'), sourceOf(c)],
      [t('library.inspector.added'), c.created_at ? new Date(Number(c.created_at) * 1000).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : ''],
      [t('content.label_expires_at'), c.expires_at ? new Date(Number(c.expires_at) * 1000).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''],
    ].filter(([, v]) => v);
    host.hidden = false;
    host.innerHTML = `
      <div class="lib-insp-head">
        <h2 class="lib-insp-title" id="libInspTitle">${esc(t('library.inspector.title'))}</h2>
        <button type="button" class="lib-icon-btn" data-act="close" aria-label="${esc(t('library.inspector.close'))}">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="lib-insp-scroll">
        <div class="lib-insp-preview">${previewHtml(c)}</div>
        <div class="lib-insp-name" title="${esc(c.filename)}">${esc(c.filename)}</div>
        <div class="lib-status"><span class="lib-dot is-${st.tone}" aria-hidden="true"></span>${esc(st.label)}</div>
        ${c.has_draft ? `<p class="lib-field-help">${esc(t('library.inspector.review_note'))}</p>` : ''}
        ${c.sync_problem ? `<p class="lib-field-help">${esc(t('library.inspector.attention_note'))}</p>` : ''}
        <form class="lib-insp-form" data-form novalidate>
          <div class="lib-field">
            <label for="libInspName">${esc(t('library.inspector.name'))}</label>
            <input id="libInspName" class="input" value="${esc(draft.filename)}" ${writable ? '' : 'readonly'} maxlength="255">
          </div>
          <div class="lib-field">
            <label for="libInspFolder">${esc(t('library.inspector.folder'))}</label>
            <select id="libInspFolder" class="input" ${writable ? '' : 'disabled'}>${folderOptions(draft.folder_id || '')}</select>
          </div>
          <div class="lib-field">
            <span class="lib-label" id="libInspTagsLabel">${esc(t('library.inspector.tags'))}</span>
            <ul class="lib-chips" aria-labelledby="libInspTagsLabel">${draft.tags.map((tg) => `<li class="lib-chip">#${esc(tg)}${writable ? `<button type="button" class="lib-chip-x" data-remove-tag="${esc(tg)}" aria-label="${esc(t('library.inspector.remove_tag', { tag: tg }))}">×</button>` : ''}</li>`).join('') || `<li class="lib-chip-empty">${esc(t('library.inspector.no_tags'))}</li>`}</ul>
            ${writable ? `<div class="lib-tag-add">
              <label for="libInspTagNew" class="lib-visually-hidden">${esc(t('library.inspector.add_tag'))}</label>
              <input id="libInspTagNew" class="input" placeholder="${esc(t('library.inspector.add_tag_ph'))}" autocomplete="off">
              <button type="button" class="btn btn-secondary btn-sm" data-act="add-tag">${esc(t('library.inspector.add_tag'))}</button>
            </div>` : ''}
          </div>
          ${writable ? `<div class="lib-insp-save" data-save-row>
            <span class="lib-field-help" data-dirty-note aria-live="polite">${isDirty() ? esc(t('library.inspector.unsaved')) : ''}</span>
            <button type="button" class="btn btn-secondary btn-sm" data-act="revert" ${isDirty() ? '' : 'disabled'}>${esc(t('common.cancel'))}</button>
            <button type="submit" class="btn btn-primary btn-sm" data-act="save" ${isDirty() ? '' : 'disabled'}>${esc(t('common.save'))}</button>
          </div>` : `<p class="lib-field-help">${esc(t('library.inspector.read_only'))}</p>`}
        </form>
        <dl class="lib-insp-facts">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
        <section class="lib-insp-usage" aria-labelledby="libInspUsageTitle">
          <h3 id="libInspUsageTitle" class="lib-insp-sub">${esc(t('library.inspector.used_in'))}</h3>
          <div data-usage aria-live="polite">${esc(t('common.loading'))}</div>
        </section>
      </div>
      <div class="lib-insp-foot">
        ${writable && isStoredFile(c) ? `<button type="button" class="btn btn-secondary" data-act="replace">${esc(t('library.inspector.replace'))}</button>
          <input type="file" id="libInspReplaceInput" hidden accept="${c.mime_type === BUNDLE_MIME ? '.zip,.wgt' : 'video/*,image/*,audio/*'}">` : ''}
        <button type="button" class="lib-icon-btn lib-insp-more" data-act="more" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(t('library.actions_for', { name: c.filename }))}">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
        </button>
      </div>`;
    hydrateAuthImages(host);
    wire();
    loadUsage(c);
  }

  function syncSaveRow() {
    const row = host.querySelector('[data-save-row]');
    if (!row) return;
    const d = isDirty();
    row.querySelector('[data-act="save"]').disabled = !d;
    row.querySelector('[data-act="revert"]').disabled = !d;
    row.querySelector('[data-dirty-note]').textContent = d ? t('library.inspector.unsaved') : '';
  }

  function wire() {
    host.querySelector('[data-act="close"]').addEventListener('click', () => close());
    const name = host.querySelector('#libInspName');
    name.addEventListener('input', () => { draft.filename = name.value; syncSaveRow(); });
    const folder = host.querySelector('#libInspFolder');
    folder.addEventListener('change', () => { draft.folder_id = folder.value || null; syncSaveRow(); });
    host.querySelectorAll('[data-remove-tag]').forEach((b) => b.addEventListener('click', () => {
      draft.tags = draft.tags.filter((x) => x !== b.dataset.removeTag);
      rerenderKeepFocus('#libInspTagNew');
    }));
    const tagIn = host.querySelector('#libInspTagNew');
    const addTag = () => {
      const v = (tagIn.value || '').split(/[,;\n]/).map((s) => s.trim().replace(/^#+/, '').toLowerCase()).filter(Boolean);
      if (!v.length) return;
      for (const tg of v) if (!draft.tags.includes(tg)) draft.tags.push(tg);
      draft._pendingTag = '';
      rerenderKeepFocus('#libInspTagNew');
    };
    host.querySelector('[data-act="add-tag"]')?.addEventListener('click', addTag);
    tagIn?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } });
    host.querySelector('[data-act="revert"]')?.addEventListener('click', () => { draft = fresh(item); render(); host.querySelector('#libInspName')?.focus(); });
    host.querySelector('[data-form]').addEventListener('submit', (e) => { e.preventDefault(); save(); });
    host.querySelector('[data-act="more"]').addEventListener('click', (e) => openMenu(e.currentTarget, opts.menuItems(item, e.currentTarget, { fromInspector: true }), { label: t('library.actions_for', { name: item.filename }) }));
    host.querySelector('[data-act="bundle-preview"]')?.addEventListener('click', () => opts.onPreviewBundle(item));
    host.querySelector('[data-act="yt-play"]')?.addEventListener('click', (e) => {
      // Loaded only on request, muted: nothing in the library plays sound by itself.
      const box = e.currentTarget.closest('.lib-insp-yt');
      let src = item.remote_url;
      try { const u = new URL(item.remote_url); u.searchParams.set('mute', '1'); u.searchParams.set('autoplay', '1'); u.searchParams.delete('enablejsapi'); u.searchParams.delete('origin'); src = u.toString(); } catch (_) { /* keep */ }
      box.innerHTML = `<iframe referrerpolicy="strict-origin-when-cross-origin" src="${esc(src)}" title="${esc(item.filename)}" allow="autoplay;encrypted-media" allowfullscreen></iframe>`;
    });
    const rep = host.querySelector('[data-act="replace"]');
    if (rep) {
      const input = host.querySelector('#libInspReplaceInput');
      rep.addEventListener('click', () => input.click());
      input.addEventListener('change', () => { const f = input.files[0]; input.value = ''; if (f) replace(f); });
    }
  }

  function rerenderKeepFocus(sel) {
    const scroll = host.querySelector('.lib-insp-scroll')?.scrollTop || 0;
    render();
    const s = host.querySelector('.lib-insp-scroll');
    if (s) s.scrollTop = scroll;
    host.querySelector(sel)?.focus();
  }

  async function loadUsage(c) {
    const my = ++usageReq;
    const box = () => host.querySelector('[data-usage]');
    let u;
    try { u = await api.getContentUsage(c.id); } catch (err) {
      if (my === usageReq && box()) box().textContent = t('library.inspector.usage_failed');
      return;
    }
    if (my !== usageReq || !box() || !item || item.id !== c.id) return;
    host.querySelector('#libInspUsageTitle').textContent = u.playlists.length
      ? t(u.playlists.length === 1 ? 'library.inspector.used_in_one' : 'library.inspector.used_in_other', { count: u.playlists.length })
      : t('library.inspector.used_in');
    const other = Object.entries(u.elsewhere || {}).filter(([, n]) => n > 0)
      .map(([k, n]) => t(`library.inspector.elsewhere_${k}`, { count: n }));
    box().innerHTML = `
      ${u.playlists.length ? `<ul class="lib-insp-links">${u.playlists.map((p) => `<li><a href="#/playlists/${encodeURIComponent(p.id)}">${esc(p.name)}</a>${p.smart ? ` <span class="lib-muted">(${esc(t('library.inspector.smart'))})</span>` : ''}</li>`).join('')}</ul>` : ''}
      ${other.length ? `<p class="lib-field-help">${esc(t('library.inspector.also_used', { list: other.join(', ') }))}</p>` : ''}
      ${!u.in_use ? `<p class="lib-field-help">${esc(t('library.inspector.not_used'))}</p>` : ''}`;
  }

  async function save() {
    if (!isDirty()) return;
    const data = {};
    if (draft.filename.trim() !== item.filename) {
      if (!draft.filename.trim()) { showToast(t('library.inspector.err_name'), 'error'); host.querySelector('#libInspName').focus(); return; }
      data.filename = draft.filename.trim();
    }
    if ((draft.folder_id || '') !== (item.folder_id || '')) data.folder_id = draft.folder_id || null;
    if (draft.tags.join('\0') !== (item.tags || []).join('\0')) data.tags = draft.tags;
    const btn = host.querySelector('[data-act="save"]');
    btn.disabled = true;
    try {
      const updated = await api.updateContent(item.id, data);
      const merged = { ...item, ...updated, tags: Array.isArray(updated.tags) ? updated.tags : parseTagsLoose(updated.tags), usage: item.usage, has_draft: item.has_draft, sync_problem: item.sync_problem };
      delete merged.draft_json;
      item = merged;
      draft = fresh(item);
      render();
      host.querySelector('[data-act="close"]')?.focus({ preventScroll: true });
      showToast(t('content.toast.updated'), 'success');
      opts.onSaved(item);
    } catch (err) {
      showToast(err.message || t('content.error_update_failed'), 'error');
      syncSaveRow();
    }
  }

  async function replace(file) {
    const ok = await confirmDialog({
      title: t('library.inspector.replace_title'),
      bodyHtml: esc(t('library.inspector.replace_text', { name: item.filename, file: file.name })),
      confirmLabel: t('library.inspector.replace_yes'),
    });
    if (!ok) return;
    const btn = host.querySelector('[data-act="replace"]');
    if (btn) { btn.disabled = true; btn.textContent = t('library.inspector.replacing'); }
    try {
      const formData = new FormData();
      formData.append('file', file);
      assertLocalCallAllowed('/content', 'PUT');
      const r = await fetch('/api/content/' + item.id + '/replace', {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        body: formData,
      });
      const body = await r.json().catch(() => ({}));
      // ⚠️ Read the response: a refused type is not a success (see the edit dialog's replace).
      if (!r.ok) throw new Error(body.error || t('content.error_update_failed'));
      showToast(body.pending_review ? t('review.toast.saved_as_draft') : t('library.inspector.replaced'), 'success');
      opts.onReplaced(item);
    } catch (err) {
      showToast(err.message, 'error');
      if (btn && document.contains(btn)) { btn.disabled = false; btn.textContent = t('library.inspector.replace'); }
    }
  }

  function fresh(c) { return { filename: c.filename || '', folder_id: c.folder_id || null, tags: Array.isArray(c.tags) ? [...c.tags] : [] }; }
  function parseTagsLoose(v) { try { const a = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(a) ? a : []; } catch { return []; } }

  // Narrow screens: a drawer that holds focus while open.
  function applyMode() {
    const drawer = mq.matches && !!item;
    host.classList.toggle('is-drawer', drawer);
    document.body.classList.toggle('lib-drawer-open', drawer);
    if (drawer) { host.setAttribute('role', 'dialog'); host.setAttribute('aria-modal', 'true'); }
    else { host.setAttribute('role', 'complementary'); host.removeAttribute('aria-modal'); }
    host.setAttribute('aria-labelledby', 'libInspTitle');
  }
  mq.addEventListener('change', applyMode);
  host.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.lib-dialog-backdrop, .lib-menu')) { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab' || !host.classList.contains('is-drawer')) return;
    const list = focusables(host);
    if (!list.length) return;
    const first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  async function open(c, { focus = true, trigger = null, restoreDraft = null } = {}) {
    if (item && item.id === c.id) { if (focus) host.querySelector('[data-act="close"]')?.focus({ preventScroll: true }); return true; }
    if (!(await confirmLeave())) return false;
    item = c;
    draft = restoreDraft && restoreDraft.id === c.id ? { filename: restoreDraft.filename, folder_id: restoreDraft.folder_id, tags: [...restoreDraft.tags] } : fresh(c);
    if (trigger) opener = trigger;
    render();
    applyMode();
    if (focus || host.classList.contains('is-drawer')) host.querySelector('[data-act="close"]')?.focus({ preventScroll: true });
    return true;
  }

  // silent: the page itself is going away (the router left it) — no callbacks, no focus moves.
  async function close({ force = false, silent = false } = {}) {
    if (!item) return true;
    if (!force && !(await confirmLeave())) return false;
    stopMedia();
    item = null; draft = null;
    render();
    applyMode();
    if (silent) { document.body.classList.remove('lib-drawer-open'); return true; }
    opts.onClose();
    if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    opener = null;
    return true;
  }

  /** The unsaved edits, if any, so leaving the page does not lose them. */
  function takeDraft() {
    if (!isDirty()) return null;
    return { id: item.id, filename: draft.filename, folder_id: draft.folder_id, tags: [...draft.tags] };
  }

  /** The list reloaded: take the fresh copy of the open item, unless the user is editing it. */
  function refresh(c) {
    if (!item || !c || c.id !== item.id) return;
    const dirty = isDirty();
    item = { ...c };
    if (!dirty) { draft = fresh(item); render(); }
  }

  return {
    open, close, refresh, takeDraft,
    get openId() { return item ? item.id : null; },
    get item() { return item; },
    isDirty, confirmLeave,
    setOpener(el) { opener = el; },
  };
}
