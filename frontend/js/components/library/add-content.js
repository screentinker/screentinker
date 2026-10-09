// The Content Library's "Add content" modal.
//
// One upload zone and one tile per source the server already supports. Choosing a tile opens that
// source's form IN the modal, with Back; values survive Back, and closing with typed input asks
// first. Every form files into the same destination, shown in the footer and changeable there.
//
// Sources, and why each is (or is not) here:
//   Media URL      POST /content/remote  (plan-gated server-side: the refusal is shown inline)
//   YouTube        POST /content/youtube (the server fetches the title, so the name is optional)
//   Documents      a Cloud document WIDGET (POST /widgets) — it is a widget, not library media, so
//                  it has no folder; and SharePoint/OneDrive folder sync, which has its own setup
//   Live stream    POST /content/hls (HLS or RTSP; the screen opens the URL, ScreenTinker never does)
//   HDMI input     POST /content/hls with hdmi://<port>; plays only on players that have an input
//   Canva          shown only when the server says Canva is configured (or the user could set it up);
//                  Connect is offered only when that real OAuth flow exists
// Hold is a playlist step, not library media: it is added from the playlist editor.

import { api } from '../../api.js';
import { esc } from '../../utils.js';
import { t } from '../../i18n.js';
import { showToast } from '../toast.js';
import { openDialog, confirmDialog } from './dialog.js';

const ICONS = {
  upload: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M16 16l-4-4-4 4"/><path d="M12 12v9"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>',
  url: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  youtube: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="3"/><polygon points="10 9 15 12 10 15 10 9"/></svg>',
  doc: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  stream: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/></svg>',
  hdmi: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  canva: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="8" cy="10" r="1.2"/><circle cx="12" cy="7.5" r="1.2"/><circle cx="16" cy="10" r="1.2"/><path d="M12 22a3 3 0 0 1 0-6h2"/></svg>',
  folder: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  chevron: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>',
  back: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>',
};

// What the uploader takes (server lib/upload-sniff.js; PDFs are rendered to images in the browser).
export const UPLOAD_ACCEPT = 'video/*,image/*,audio/*,.zip,.wgt,.pdf,application/pdf';

// Media URL: the type the screen should treat the link as, detected from the extension when it says.
const MEDIA_TYPES = [
  ['video/mp4', 'content.mime.video_mp4'], ['video/webm', 'content.mime.video_webm'],
  ['image/jpeg', 'content.mime.image_jpeg'], ['image/png', 'content.mime.image_png'],
  ['image/gif', 'content.mime.image_gif'], ['image/webp', 'content.mime.image_webp'],
  ['audio/mpeg', 'content.mime.audio_mpeg'], ['audio/wav', 'content.mime.audio_wav'],
];
const EXT_TYPE = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', mp3: 'audio/mpeg', wav: 'audio/wav' };

function parseUrl(raw) { try { return new URL(String(raw || '').trim()); } catch { return null; } }
function lastSegment(u) {
  try { return decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || ''); } catch { return ''; }
}
export function detectMediaType(raw) {
  const u = parseUrl(raw);
  if (!u) return null;
  const m = /\.([a-z0-9]{2,5})$/i.exec(u.pathname);
  return m ? EXT_TYPE[m[1].toLowerCase()] || null : null;
}
// Exactly the patterns routes/content.js extractYoutubeId accepts, so the form never passes a link
// the server will refuse (or refuses one it would take).
export function youtubeId(raw) {
  const s = String(raw || '').trim();
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) { const m = s.match(p); if (m) return m[1]; }
  return null;
}
// lib/remote-url.js classifyLiveUrl, mirrored for inline feedback; the server still decides.
export function liveKind(raw) {
  const s = String(raw || '').trim();
  if (/^rtsp:\/\//i.test(s)) { const u = parseUrl(s); return u && u.protocol === 'rtsp:' ? 'rtsp' : null; }
  const u = parseUrl(s);
  if (!u || !/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  const path = (u.pathname || '').toLowerCase(), q = (u.search || '').toLowerCase();
  return path.includes('.m3u8') || q.includes('m3u8') || /(^|[^a-z])hls([^a-z]|$)/.test(path) ? 'hls' : null;
}

function autoTypeLabel(detected) {
  const m = detected && MEDIA_TYPES.find((x) => x[0] === detected);
  return m ? t('library.add.type_detected', { type: t(m[1]) }) : t('library.add.type_choose');
}
// A preview only where one is real: an https link (the dashboard's CSP allows https media) of a
// type the browser can show. Nothing autoplays; video is muted.
function urlPreviewHtml(f) {
  const u = parseUrl(f.url);
  if (!u) return '';
  if (u.protocol === 'http:') return `<p class="lib-field-help">${esc(t('library.add.preview_https_only'))}</p>`;
  const mime = f.mime || detectMediaType(f.url);
  if (u.protocol !== 'https:' || !mime) return '';
  const src = esc(u.toString());
  const media = mime.startsWith('image/') ? `<img src="${src}" alt="${esc(t('library.add.preview_alt'))}" referrerpolicy="no-referrer">`
    : mime.startsWith('video/') ? `<video src="${src}" controls muted preload="metadata"></video>`
      : `<audio src="${src}" controls preload="none"></audio>`;
  return `<figure class="lib-form-preview"><figcaption class="lib-visually-hidden">${esc(t('library.add.preview'))}</figcaption>${media}</figure>`;
}
function youtubePreviewHtml(id) {
  return id ? `<figure class="lib-form-preview"><img src="https://img.youtube.com/vi/${esc(id)}/hqdefault.jpg" alt="${esc(t('library.add.youtube_thumb_alt'))}" referrerpolicy="no-referrer"></figure>` : '';
}

/**
 * opts:
 *   destination  { folderId, label }   where new items go (null = the library root)
 *   folders      the workspace's folder list (for Change)
 *   folderPath   (folder) => "Campaigns / Autumn 2026"
 *   rootLabel    the root's name
 *   onFiles(files, destination)  start an upload (the page's queue)
 *   onCreated(item)              a no-bytes item was added
 *   onOpenCloudFolders(), onOpenCanva(destination)   hand over to the existing flows
 */
export function openAddContent(opts) {
  const state = {
    view: 'home',
    dest: { ...opts.destination },
    forms: { url: {}, youtube: {}, doc: { mode: 'doc' }, stream: {}, hdmi: { port: '' } },
    submitting: false,
    canva: null,
  };

  const isDirty = () => Object.entries(state.forms).some(([k, f]) => Object.entries(f).some(([fk, v]) => {
    if (k === 'doc' && fk === 'mode') return false;
    if (k === 'hdmi' && fk === 'port') return false;
    if (fk.startsWith('_')) return false;
    return typeof v === 'string' && v.trim() !== '';
  }));

  const dlg = openDialog({
    title: t('library.add.title'),
    size: 'lg',
    className: 'lib-add',
    onRequestClose: async () => {
      if (state.submitting) return false;
      if (!isDirty()) return true;
      return confirmDialog({
        title: t('library.add.discard_title'),
        bodyHtml: esc(t('library.add.discard_text')),
        confirmLabel: t('library.add.discard_yes'),
        cancelLabel: t('library.add.discard_no'),
        danger: true,
      });
    },
  });

  // Canva's tile depends on what the server says; ask once, in the background.
  // The tiles re-render when it answers; keep focus on the same control (or the first one).
  api.get('/canva/status').then((s) => {
    state.canva = s;
    if (state.view !== 'home' || dlg.closed) return;
    const a = document.activeElement;
    const key = a && dlg.root.contains(a) ? (a.dataset.source ? `[data-source="${a.dataset.source}"]` : a.dataset.act ? `[data-act="${a.dataset.act}"]` : null) : null;
    render();
    const again = key && dlg.body.querySelector(key);
    if (again) again.focus(); else if (!a || !dlg.root.contains(a) || !document.contains(a)) dlg.focusFirst();
  }).catch(() => { state.canva = { unavailable: true }; });

  function sources() {
    const list = [
      { key: 'url', icon: ICONS.url, title: t('library.add.src_url'), desc: t('library.add.src_url_desc') },
      { key: 'youtube', icon: ICONS.youtube, title: t('library.add.src_youtube'), desc: t('library.add.src_youtube_desc') },
      { key: 'doc', icon: ICONS.doc, title: t('library.add.src_doc'), desc: t('library.add.src_doc_desc') },
      { key: 'stream', icon: ICONS.stream, title: t('library.add.src_stream'), desc: t('library.add.src_stream_desc') },
      { key: 'hdmi', icon: ICONS.hdmi, title: t('library.add.src_hdmi'), desc: t('library.add.src_hdmi_desc') },
    ];
    const c = state.canva;
    // Same rule as components/canva-import.js mountCanvaCard: hidden when it is neither set up nor
    // something this user could set up.
    if (c && !c.unavailable && (c.configured || c.can_manage || c.config_error)) {
      list.push({ key: 'canva', icon: ICONS.canva, title: t('library.add.src_canva'),
        desc: c.connected ? t('library.add.src_canva_desc') : c.configured ? t('library.add.src_canva_connect') : t('library.add.src_canva_setup') });
    }
    return list;
  }

  function destFooter() {
    return `
      <div class="lib-add-dest">
        <span class="lib-add-dest-icon">${ICONS.folder}</span>
        <span>${esc(t('library.add.destination'))} <strong>${esc(state.dest.label)}</strong></span>
        <button type="button" class="lib-link-btn" data-act="change-dest">${esc(t('library.add.change'))}</button>
      </div>`;
  }

  function formHead(title) {
    return `<button type="button" class="lib-back-btn" data-act="back">${ICONS.back}<span>${esc(t('library.add.back'))}</span></button>
      <h3 class="lib-form-title" id="libFormTitle">${esc(title)}</h3>`;
  }
  function field(id, label, value, { type = 'text', placeholder = '', help = '', required = false, autocomplete = 'off', inputmode = '' } = {}) {
    return `<div class="lib-field">
      <label for="${id}">${esc(label)}${required ? ` <span class="lib-req">${esc(t('library.add.required'))}</span>` : ''}</label>
      <input id="${id}" class="input" type="${type}" value="${esc(value || '')}" placeholder="${esc(placeholder)}" autocomplete="${autocomplete}" ${inputmode ? `inputmode="${inputmode}"` : ''} ${required ? 'aria-required="true"' : ''} aria-describedby="${id}-help ${id}-err">
      <div class="lib-field-help" id="${id}-help">${help}</div>
      <div class="lib-field-err" id="${id}-err" role="alert"></div>
    </div>`;
  }
  function submitRow(label, id = '') {
    return `<div class="lib-dialog-actions">
      <span class="lib-form-error" role="alert" data-form-error></span>
      <button type="button" class="btn btn-secondary" data-act="back">${esc(t('library.add.back'))}</button>
      <button type="submit" class="btn btn-primary" data-submit${id ? ` id="${id}"` : ''}>${esc(label)}</button>
    </div>`;
  }

  function render() {
    const b = dlg.body;
    if (state.view === 'home') {
      dlg.setTitle(t('library.add.title'));
      b.innerHTML = `
        <p class="lib-add-lede">${esc(t('library.add.lede'))}</p>
        <div class="lib-dropzone" data-dropzone>
          ${ICONS.upload}
          <div class="lib-dropzone-title">${esc(t('library.add.upload_title'))}</div>
          <div>${esc(t('library.add.upload_drop'))} <button type="button" class="lib-link-btn" data-act="browse">${esc(t('library.add.browse'))}</button></div>
          <div class="lib-dropzone-hint">${esc(t('library.add.upload_types'))}</div>
          <div class="lib-dropzone-hint">${esc(t('library.add.upload_pdf_note'))}</div>
          <input type="file" id="libAddFileInput" multiple accept="${UPLOAD_ACCEPT}" hidden>
        </div>
        <h3 class="lib-section-label">${esc(t('library.add.connect_source'))}</h3>
        <ul class="lib-tiles">${sources().map((s) => `
          <li><button type="button" class="lib-tile" data-source="${s.key}">
            <span class="lib-tile-icon">${s.icon}</span>
            <span class="lib-tile-text"><span class="lib-tile-title">${esc(s.title)}</span><span class="lib-tile-desc">${esc(s.desc)}</span></span>
            <span class="lib-tile-chev">${ICONS.chevron}</span>
          </button></li>`).join('')}
        </ul>
        <p class="lib-add-note">${esc(t('library.add.hold_note'))}</p>
        ${destFooter()}`;
      wireHome();
      return;
    }
    if (state.view === 'dest') { renderDest(); return; }
    const renderers = { url: renderUrl, youtube: renderYoutube, doc: renderDoc, stream: renderStream, hdmi: renderHdmi, canva: renderCanva };
    renderers[state.view]();
  }

  function go(view) {
    state.view = view;
    render();
    // A form opens on its first field; the home view and destination list on their first control.
    const first = dlg.body.querySelector('form input:not([hidden]), form select, .lib-choice input:checked, .lib-dest-list input:checked');
    if (first) first.focus(); else dlg.focusFirst();
  }

  function wireHome() {
    const b = dlg.body;
    const input = b.querySelector('#libAddFileInput');
    b.querySelector('[data-act="browse"]').addEventListener('click', () => input.click());
    input.addEventListener('change', () => { const files = [...input.files]; input.value = ''; startFiles(files); });
    const zone = b.querySelector('[data-dropzone]');
    zone.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); zone.classList.add('is-over'); } });
    zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
    zone.addEventListener('drop', (e) => {
      zone.classList.remove('is-over');
      if (![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      startFiles([...e.dataTransfer.files]);
    });
    b.querySelectorAll('[data-source]').forEach((el) => el.addEventListener('click', () => go(el.dataset.source)));
    b.querySelector('[data-act="change-dest"]').addEventListener('click', () => { state.returnTo = 'home'; go('dest'); });
  }

  async function startFiles(files) {
    if (!files.length) return;
    // onFiles may ask about PDFs first (and may be refused); the modal closes only once it starts.
    const started = await opts.onFiles(files, { ...state.dest });
    if (started !== false) dlg.close();
  }

  function wireForm(onSubmit) {
    const b = dlg.body;
    b.querySelectorAll('[data-act="back"]').forEach((el) => el.addEventListener('click', () => go(state.returnTo === 'dest' ? 'home' : 'home')));
    b.querySelectorAll('[data-act="change-dest"]').forEach((el) => el.addEventListener('click', () => { state.returnTo = state.view; go('dest'); }));
    const form = b.querySelector('form');
    if (form) form.addEventListener('submit', async (e) => { e.preventDefault(); await onSubmit(form); });
  }
  function setErr(id, msg) {
    const el = dlg.body.querySelector(`#${id}-err`);
    const input = dlg.body.querySelector(`#${id}`);
    if (el) el.textContent = msg || '';
    if (input) input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    if (msg && input) input.focus();
    return !msg;
  }
  async function submitting(form, fn) {
    const btn = form.querySelector('[data-submit]');
    const errEl = form.querySelector('[data-form-error]');
    errEl.textContent = '';
    state.submitting = true;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    try { await fn(); }
    catch (err) { errEl.textContent = err.message || t('library.add.failed'); }
    finally { state.submitting = false; if (document.contains(btn)) { btn.disabled = false; btn.removeAttribute('aria-busy'); } }
  }
  function done(item, key, message) {
    state.forms[key] = key === 'doc' ? { mode: 'doc' } : key === 'hdmi' ? { port: '' } : {};
    showToast(message, 'success');
    dlg.close();
    if (opts.onCreated) opts.onCreated(item);
  }

  /* ---------------- Media URL ---------------- */
  function renderUrl() {
    const f = state.forms.url;
    const detected = detectMediaType(f.url);
    dlg.body.innerHTML = `
      ${formHead(t('library.add.src_url'))}
      <form novalidate aria-labelledby="libFormTitle">
        ${field('libUrl', t('library.add.url_label'), f.url, { type: 'url', placeholder: 'https://example.com/video.mp4', required: true, inputmode: 'url', help: esc(t('library.add.url_help')) })}
        ${field('libUrlName', t('library.add.name_label'), f.name, { help: esc(t('library.add.name_from_link')) })}
        <details class="lib-advanced" ${f._advanced || (f.url && !detected) ? 'open' : ''}>
          <summary>${esc(t('library.add.advanced'))}</summary>
          <div class="lib-field">
            <label for="libUrlType">${esc(t('library.add.media_type'))}</label>
            <select id="libUrlType" class="input" aria-describedby="libUrlType-help libUrlType-err">
              <option value="" data-auto>${esc(autoTypeLabel(detected))}</option>
              ${MEDIA_TYPES.map(([v, k]) => `<option value="${v}" ${f.mime === v ? 'selected' : ''}>${esc(t(k))}</option>`).join('')}
            </select>
            <div class="lib-field-help" id="libUrlType-help">${esc(t('library.add.type_help'))}</div>
            <div class="lib-field-err" id="libUrlType-err" role="alert"></div>
          </div>
        </details>
        <div class="lib-suggest" data-suggest></div>
        <div data-preview>${urlPreviewHtml(f)}</div>
        ${destFooter()}
        ${submitRow(t('library.add.url_submit'))}
      </form>`;
    const b = dlg.body;
    const urlIn = b.querySelector('#libUrl'), nameIn = b.querySelector('#libUrlName'), typeIn = b.querySelector('#libUrlType');
    const suggest = () => {
      const box = b.querySelector('[data-suggest]');
      const other = youtubeId(urlIn.value) ? 'youtube' : liveKind(urlIn.value) ? 'stream' : null;
      box.innerHTML = other ? `${esc(t(other === 'youtube' ? 'library.add.looks_youtube' : 'library.add.looks_stream'))} <button type="button" class="lib-link-btn" data-switch="${other}">${esc(t(other === 'youtube' ? 'library.add.use_youtube' : 'library.add.use_stream'))}</button>` : '';
      const sw = box.querySelector('[data-switch]');
      if (sw) sw.addEventListener('click', () => { state.forms[sw.dataset.switch].url = urlIn.value; f.url = ''; go(sw.dataset.switch); });
    };
    urlIn.addEventListener('input', () => { f.url = urlIn.value; setErr('libUrl', ''); suggest(); });
    // On leaving the field the name, detected type and preview follow the link. Updated in place:
    // re-rendering here would replace the field Tab is moving focus to.
    const refresh = () => {
      const uu = parseUrl(urlIn.value);
      if (uu && !f.name) { f.name = lastSegment(uu); nameIn.value = f.name; }
      const det = detectMediaType(urlIn.value);
      typeIn.querySelector('[data-auto]').textContent = autoTypeLabel(det);
      if (urlIn.value && !det && !f.mime) b.querySelector('details').open = true;
      b.querySelector('[data-preview]').innerHTML = urlPreviewHtml(f);
    };
    urlIn.addEventListener('change', refresh);
    nameIn.addEventListener('input', () => { f.name = nameIn.value; });
    typeIn.addEventListener('change', () => { f.mime = typeIn.value; b.querySelector('[data-preview]').innerHTML = urlPreviewHtml(f); });
    b.querySelector('details').addEventListener('toggle', (e) => { f._advanced = e.target.open; });
    suggest();
    wireForm((form) => {
      const uu = parseUrl(f.url);
      if (!uu || !/^https?:$/.test(uu.protocol)) return setErr('libUrl', t('library.add.err_http_url'));
      const type = f.mime || detectMediaType(f.url);
      if (!type) { b.querySelector('details').open = true; return setErr('libUrlType', t('library.add.err_choose_type')); }
      return submitting(form, async () => {
        const item = await api.addRemoteContent(f.url.trim(), (f.name || '').trim() || lastSegment(uu), type, state.dest.folderId);
        done(item, 'url', t('content.toast.remote_added'));
      });
    });
  }

  /* ---------------- YouTube ---------------- */
  function renderYoutube() {
    const f = state.forms.youtube;
    const id = youtubeId(f.url);
    dlg.body.innerHTML = `
      ${formHead(t('library.add.src_youtube'))}
      <form novalidate aria-labelledby="libFormTitle">
        ${field('libYt', t('library.add.youtube_label'), f.url, { type: 'url', placeholder: 'https://www.youtube.com/watch?v=…', required: true, inputmode: 'url', help: esc(t('library.add.youtube_help')) })}
        ${field('libYtName', t('library.add.name_label'), f.name, { help: esc(t('library.add.youtube_name_help')) })}
        <div data-preview>${youtubePreviewHtml(id)}</div>
        ${destFooter()}
        ${submitRow(t('library.add.youtube_submit'))}
      </form>`;
    const b = dlg.body;
    const urlIn = b.querySelector('#libYt'), nameIn = b.querySelector('#libYtName');
    urlIn.addEventListener('input', () => { f.url = urlIn.value; setErr('libYt', ''); });
    urlIn.addEventListener('change', () => { b.querySelector('[data-preview]').innerHTML = youtubePreviewHtml(youtubeId(urlIn.value)); });
    nameIn.addEventListener('input', () => { f.name = nameIn.value; });
    wireForm((form) => {
      if (!youtubeId(f.url)) return setErr('libYt', t('library.add.err_youtube'));
      return submitting(form, async () => {
        const item = await api.addYoutubeContent(f.url.trim(), (f.name || '').trim(), state.dest.folderId);
        done(item, 'youtube', t('content.toast.youtube_added'));
      });
    });
  }

  /* ---------------- Google / Microsoft ---------------- */
  function renderDoc() {
    const f = state.forms.doc;
    const KIND = { slides: 'library.add.doc_kind_slides', doc: 'library.add.doc_kind_doc', sheet: 'library.add.doc_kind_sheet' };
    dlg.body.innerHTML = `
      ${formHead(t('library.add.src_doc'))}
      <fieldset class="lib-choice">
        <legend class="lib-visually-hidden">${esc(t('library.add.doc_choice'))}</legend>
        <label class="lib-choice-opt"><input type="radio" name="libDocMode" value="doc" ${f.mode === 'doc' ? 'checked' : ''}>
          <span><strong>${esc(t('library.add.doc_one'))}</strong><span class="lib-field-help">${esc(t('library.add.doc_one_desc'))}</span></span></label>
        <label class="lib-choice-opt"><input type="radio" name="libDocMode" value="folder" ${f.mode === 'folder' ? 'checked' : ''}>
          <span><strong>${esc(t('library.add.doc_folder'))}</strong><span class="lib-field-help">${esc(t('library.add.doc_folder_desc'))}</span></span></label>
      </fieldset>
      ${f.mode === 'folder' ? `
        <p class="lib-field-help">${esc(t('library.add.doc_folder_more'))}</p>
        <div class="lib-dialog-actions">
          <button type="button" class="btn btn-secondary" data-act="back">${esc(t('library.add.back'))}</button>
          <button type="button" class="btn btn-primary" data-act="open-folders">${esc(t('library.add.doc_folder_open'))}</button>
        </div>` : `
      <form novalidate aria-labelledby="libFormTitle">
        ${field('libDoc', t('library.add.doc_label'), f.url, { type: 'url', placeholder: 'https://docs.google.com/presentation/d/…', required: true, inputmode: 'url', help: esc(t('library.add.doc_help')) })}
        <div class="lib-field-help" data-recognised>${f._kind ? esc(t('library.add.doc_recognised', { what: `${f._provider === 'google' ? 'Google' : 'Microsoft'} · ${t(KIND[f._kind] || 'library.add.doc_kind_doc')}` })) : ''}</div>
        ${field('libDocName', t('library.add.name_label'), f.name, { required: true, help: esc(t('library.add.doc_name_help')) })}
        <p class="lib-add-note">${esc(t('library.add.doc_widget_note'))}</p>
        ${submitRow(t('library.add.doc_submit'))}
      </form>`}`;
    const b = dlg.body;
    b.querySelectorAll('input[name="libDocMode"]').forEach((r) => r.addEventListener('change', () => { f.mode = r.value; render(); b.querySelector(`input[name="libDocMode"][value="${f.mode}"]`)?.focus(); }));
    if (f.mode === 'folder') {
      b.querySelector('[data-act="back"]').addEventListener('click', () => go('home'));
      b.querySelector('[data-act="open-folders"]').addEventListener('click', () => { dlg.close(); opts.onOpenCloudFolders(); });
      return;
    }
    const urlIn = b.querySelector('#libDoc'), nameIn = b.querySelector('#libDocName');
    // The server rebuilds and checks the link (lib/cloud-docs.js); ask it as soon as one is pasted,
    // so a link it will refuse is refused here, next to the field.
    const check = async () => {
      f._kind = null;
      if (!urlIn.value.trim()) return null;
      try {
        const cfg = await api.post('/widgets/cloud-doc/check', { url: urlIn.value.trim() });
        f._kind = cfg.kind; f._provider = cfg.provider;
        b.querySelector('[data-recognised]').textContent = t('library.add.doc_recognised', { what: `${cfg.provider === 'google' ? 'Google' : 'Microsoft'} · ${t(KIND[cfg.kind] || 'library.add.doc_kind_doc')}` });
        setErr('libDoc', '');
        return cfg;
      } catch (err) {
        b.querySelector('[data-recognised]').textContent = '';
        setErr('libDoc', err.message);
        return null;
      }
    };
    urlIn.addEventListener('input', () => { f.url = urlIn.value; });
    urlIn.addEventListener('change', check);
    nameIn.addEventListener('input', () => { f.name = nameIn.value; });
    wireForm(async (form) => {
      if (!f.url || !f.url.trim()) return setErr('libDoc', t('content.cloud_docs_need_url'));
      if (!(await check())) return;
      if (!f.name || !f.name.trim()) return setErr('libDocName', t('library.add.err_name'));
      return submitting(form, async () => {
        const w = await api.post('/widgets', { widget_type: 'cloud-doc', name: f.name.trim(), config: { url: f.url.trim() } });
        state.forms.doc = { mode: 'doc' };
        showToast(t('content.cloud_docs_added'), 'success');
        dlg.close();
        if (opts.onCreated) opts.onCreated(null, w);
      });
    });
  }

  /* ---------------- Live stream ---------------- */
  function renderStream() {
    const f = state.forms.stream;
    dlg.body.innerHTML = `
      ${formHead(t('library.add.src_stream'))}
      <form novalidate aria-labelledby="libFormTitle">
        ${field('libStream', t('library.add.stream_label'), f.url, { placeholder: 'https://…/live.m3u8  ·  rtsp://camera.local/stream', required: true, inputmode: 'url', help: esc(t('content.hls_desc')) })}
        ${field('libStreamName', t('library.add.name_label'), f.name, { help: esc(t('library.add.name_from_link')) })}
        <p class="lib-field-help">${esc(t('library.add.stream_no_preview'))}</p>
        ${destFooter()}
        ${submitRow(t('library.add.stream_submit'))}
      </form>`;
    const b = dlg.body;
    const urlIn = b.querySelector('#libStream'), nameIn = b.querySelector('#libStreamName');
    urlIn.addEventListener('input', () => { f.url = urlIn.value; setErr('libStream', ''); });
    urlIn.addEventListener('change', () => { const u = parseUrl(urlIn.value); if (u && !f.name) { f.name = lastSegment(u) || ''; nameIn.value = f.name; } });
    nameIn.addEventListener('input', () => { f.name = nameIn.value; });
    wireForm((form) => {
      if (!liveKind(f.url)) return setErr('libStream', t('library.add.err_stream'));
      return submitting(form, async () => {
        const item = await api.addHlsContent(f.url.trim(), (f.name || '').trim(), state.dest.folderId);
        done(item, 'stream', t('content.toast.hls_added'));
      });
    });
  }

  /* ---------------- HDMI input ---------------- */
  function renderHdmi() {
    const f = state.forms.hdmi;
    dlg.body.innerHTML = `
      ${formHead(t('library.add.src_hdmi'))}
      <form novalidate aria-labelledby="libFormTitle">
        <p class="lib-requirement"><strong>${esc(t('library.add.hdmi_requires'))}</strong> ${esc(t('content.hdmi_in_desc'))}</p>
        <div class="lib-field">
          <label for="hdmiInPort">${esc(t('library.add.hdmi_port'))}</label>
          <select id="hdmiInPort" class="input">
            <option value="" ${!f.port ? 'selected' : ''}>${esc(t('content.hdmi_in_first'))}</option>
            ${[1, 2, 3, 4].map((n) => `<option value="${n}" ${String(f.port) === String(n) ? 'selected' : ''}>HDMI ${n}</option>`).join('')}
          </select>
        </div>
        ${field('hdmiInName', t('library.add.name_label'), f.name, { placeholder: f.port ? 'HDMI ' + f.port : t('library.add.hdmi_default_name') })}
        ${destFooter()}
        ${submitRow(t('content.hdmi_in_add_btn'), 'addHdmiInBtn')}
      </form>`;
    const b = dlg.body;
    const portIn = b.querySelector('#hdmiInPort'), nameIn = b.querySelector('#hdmiInName');
    portIn.addEventListener('change', () => { f.port = portIn.value; nameIn.placeholder = f.port ? 'HDMI ' + f.port : t('library.add.hdmi_default_name'); });
    nameIn.addEventListener('input', () => { f.name = nameIn.value; });
    wireForm((form) => submitting(form, async () => {
      const port = f.port;
      // Same route as a live stream: the server classifies hdmi://<port> (lib/remote-url.js).
      const item = await api.addHlsContent('hdmi://' + port, (f.name || '').trim() || (port ? 'HDMI ' + port : t('library.add.hdmi_default_name')), state.dest.folderId);
      done(item, 'hdmi', t('content.toast.hdmi_in_added'));
    }));
  }

  /* ---------------- Canva ---------------- */
  function renderCanva() {
    const c = state.canva || {};
    let action = '';
    if (c.connected) action = `<button type="button" class="btn btn-secondary lib-danger-text" data-act="canva-disconnect">${esc(t('canva.disconnect'))}</button><button type="button" class="btn btn-primary" data-act="canva-pick">${esc(t('canva.add'))}</button>`;
    else if (c.configured) action = `<button type="button" class="btn btn-primary" data-act="canva-connect">${esc(t('canva.connect'))}</button>`;
    else if (c.can_manage) action = `<a class="btn btn-primary" href="#/settings" data-act="canva-settings">${esc(t('canva.open_settings'))}</a>`;
    const text = c.connected ? t('canva.connected_as', { name: c.display_name || t('canva.your_account') })
      : c.configured ? t('canva.connect_desc')
        : (c.config_error || (c.can_manage ? t('canva.not_set_up_admin') : t('canva.not_set_up')));
    dlg.body.innerHTML = `
      ${formHead(t('library.add.src_canva'))}
      <p>${esc(text)}</p>
      ${c.connected ? `<p class="lib-field-help">${esc(t('library.add.canva_dest_note', { folder: state.dest.label }))}</p>` : ''}
      ${c.connected ? destFooter() : ''}
      <div class="lib-dialog-actions">
        <span class="lib-form-error" role="alert" data-form-error></span>
        <button type="button" class="btn btn-secondary" data-act="back">${esc(t('library.add.back'))}</button>
        ${action}
      </div>`;
    const b = dlg.body;
    b.querySelector('[data-act="back"]').addEventListener('click', () => go('home'));
    b.querySelector('[data-act="change-dest"]')?.addEventListener('click', () => { state.returnTo = 'canva'; go('dest'); });
    b.querySelector('[data-act="canva-pick"]')?.addEventListener('click', () => { dlg.close(); opts.onOpenCanva({ ...state.dest }); });
    b.querySelector('[data-act="canva-settings"]')?.addEventListener('click', () => dlg.close());
    // Disconnect revokes this person's access at Canva; imported items stay but stop updating.
    b.querySelector('[data-act="canva-disconnect"]')?.addEventListener('click', async (e) => {
      const ok = await confirmDialog({ title: t('canva.disconnect'), bodyHtml: esc(t('canva.disconnect_confirm')), confirmLabel: t('canva.disconnect'), danger: true });
      if (!ok) return;
      e.target.disabled = true;
      try {
        await api.post('/canva/disconnect', {});
        showToast(t('canva.disconnected'), 'success');
        state.canva = await api.get('/canva/status').catch(() => ({ ...c, connected: false }));
        render();
      } catch (err) { b.querySelector('[data-form-error]').textContent = err.message; e.target.disabled = false; }
    });
    b.querySelector('[data-act="canva-connect"]')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const r = await api.post('/canva/connect', {});
        window.location.href = r.url;
      } catch (err) { b.querySelector('[data-form-error]').textContent = err.message; e.target.disabled = false; }
    });
  }

  /* ---------------- Destination ---------------- */
  function renderDest() {
    const back = state.returnTo || 'home';
    dlg.setTitle(t('library.add.dest_title'));
    const opts2 = [{ id: '', label: opts.rootLabel, depth: 0 }, ...treeOrder(opts.folders).map((f) => ({ id: f.id, label: f.name, path: opts.folderPath(f), depth: f.depth + 1 }))];
    dlg.body.innerHTML = `
      <button type="button" class="lib-back-btn" data-act="dest-back">${ICONS.back}<span>${esc(t('library.add.back'))}</span></button>
      <fieldset class="lib-dest-list">
        <legend class="lib-visually-hidden">${esc(t('library.add.dest_title'))}</legend>
        ${opts2.map((o) => `<label class="lib-dest-opt" style="padding-left:${12 + o.depth * 18}px">
          <input type="radio" name="libDest" value="${esc(o.id)}" ${(state.dest.folderId || '') === o.id ? 'checked' : ''}>
          ${ICONS.folder}<span>${esc(o.label)}</span></label>`).join('')}
      </fieldset>
      <div class="lib-dialog-actions">
        <button type="button" class="btn btn-secondary" data-act="dest-back">${esc(t('library.add.back'))}</button>
        <button type="button" class="btn btn-primary" data-act="dest-ok">${esc(t('library.add.dest_use'))}</button>
      </div>`;
    const b = dlg.body;
    b.querySelectorAll('[data-act="dest-back"]').forEach((el) => el.addEventListener('click', () => { dlg.setTitle(t('library.add.title')); go(back); }));
    b.querySelector('[data-act="dest-ok"]').addEventListener('click', () => {
      const v = b.querySelector('input[name="libDest"]:checked')?.value || '';
      const f = opts.folders.find((x) => x.id === v);
      state.dest = { folderId: v || null, label: f ? opts.folderPath(f) : opts.rootLabel };
      dlg.setTitle(t('library.add.title'));
      go(back);
    });
  }

  render();
  dlg.focusFirst();
  return dlg;
}

/** Folders in tree order with a depth, for an indented list. */
export function treeOrder(folders) {
  const kids = new Map();
  for (const f of folders) {
    const p = f.parent_id || '';
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(f);
  }
  for (const list of kids.values()) list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const out = [];
  const ids = new Set(folders.map((f) => f.id));
  const walk = (pid, depth) => { for (const f of kids.get(pid) || []) { out.push({ ...f, depth }); walk(f.id, depth + 1); } };
  walk('', 0);
  // A folder whose parent is not in the list (a template folder's child) is still listed, at the top level.
  for (const f of folders) if (f.parent_id && !ids.has(f.parent_id) && !out.some((o) => o.id === f.id)) { out.push({ ...f, depth: 0 }); walk(f.id, 1); }
  return out;
}
