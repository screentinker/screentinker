// The Content Library's upload queue and its tray.
//
// Files go up one at a time through the resumable uploader (lib/chunked-upload.js), each with its
// own state, so the tray can say what is true of every file:
//   queued      waiting its turn
//   uploading   bytes on their way (a percentage)
//   processing  every byte sent; the server is checking the type, measuring and thumbnailing it
//               (POST /uploads/:id/finalize — lib/content-ingest.js runs inside that request)
//   ready       a library item exists
//   failed      with the server's reason, and Retry
//   cancelled   stopped by the user before it finished
//
// ⚠️ One failed file is that file's problem. uploadFilesResumable() rejects on the first failure and
// never attempts the rest, which is why this calls uploadFileResumable() per file instead.
//
// The tray lives on <body>, not in the page, so closing the Add content modal, browsing to another
// folder or another view does not stop anything; it disappears once nothing is left to report.

import { uploadFileResumable } from '../../lib/chunked-upload.js';
import { isPdf } from '../pdf-pages.js';
import { esc } from '../../utils.js';
import { t } from '../../i18n.js';
import { confirmDialog } from './dialog.js';

const items = [];
const listeners = new Set();
let running = false;
let seq = 0;
let pdfImporter = null;
let hideTimer = null;
let collapsed = false;

/** The page registers how a PDF is imported (pages → folder → playlist; views/content-library.js). */
export function setPdfImporter(fn) { pdfImporter = fn; }

/** Called with { item } when an item becomes ready (the page reloads its list and counts). */
export function onUploaded(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function activeCount() { return items.filter((i) => ['queued', 'uploading', 'processing'].includes(i.state)).length; }

/**
 * Queue files for one destination. `folderId` null = the library root; `folderLabel` is shown so the
 * tray says where each file is going.
 */
export function enqueue(files, { folderId = null, folderLabel = '' } = {}) {
  for (const file of files) {
    items.push({ id: ++seq, file, pdf: isPdf(file), folderId, folderLabel, state: 'queued', sent: 0, total: file.size || 0, note: '', error: '', controller: null });
  }
  collapsed = false;
  renderTray();
  pump();
}

async function pump() {
  if (running) return;
  running = true;
  try {
    for (let next = items.find((i) => i.state === 'queued'); next; next = items.find((i) => i.state === 'queued')) {
      await runOne(next);
    }
  } finally {
    running = false;
    renderTray();
  }
}

async function runOne(it) {
  it.state = 'uploading';
  it.error = '';
  it.controller = it.pdf ? null : new AbortController();
  renderTray();
  try {
    let created;
    if (it.pdf) {
      if (!pdfImporter) throw new Error(t('library.upload.pdf_unavailable'));
      created = await pdfImporter(it.file, it.folderId, (pct, note) => { it.sent = pct; it.total = 100; it.note = note || ''; renderTray(); });
    } else {
      created = await uploadFileResumable(it.file, {
        folderId: it.folderId,
        signal: it.controller.signal,
        onProgress: (sent, total) => {
          it.sent = sent; it.total = total;
          if (total && sent >= total) it.state = 'processing';
          renderTray();
        },
        // Offered only when a previous visit left bytes on the server for this exact file.
        onResumeOffer: ({ offset, total }) => confirmDialog({
          title: t('library.upload.resume_title'),
          bodyHtml: esc(t('content.upload_resume_prompt', { name: it.file.name, done: Math.round((offset / total) * 100) })),
          confirmLabel: t('library.upload.resume_yes'),
          cancelLabel: t('library.upload.resume_no'),
        }),
      });
    }
    it.state = 'ready';
    it.controller = null;
    renderTray();
    for (const fn of listeners) { try { fn({ item: it, created }); } catch (_) { /* a listener must not stop the queue */ } }
  } catch (err) {
    // Cancelled between chunks ({cancelled}) or in the middle of one (the fetch's AbortError).
    const aborted = (err && err.cancelled) || (it.controller && it.controller.signal.aborted) || (err && err.name === 'AbortError');
    it.controller = null;
    if (aborted) { it.state = 'cancelled'; }
    else { it.state = 'failed'; it.error = (err && err.message) || t('library.upload.failed_generic'); }
    renderTray();
  }
}

function cancel(it) {
  if (it.state === 'queued') { it.state = 'cancelled'; renderTray(); return; }
  if (it.controller) it.controller.abort();
}
function retry(it) {
  it.state = 'queued'; it.sent = 0; it.error = '';
  renderTray();
  pump();
}
function dismiss(it) {
  const i = items.indexOf(it);
  if (i >= 0) items.splice(i, 1);
  renderTray();
}
function clearFinished() {
  for (let i = items.length - 1; i >= 0; i--) if (['ready', 'cancelled', 'failed'].includes(items[i].state)) items.splice(i, 1);
  renderTray();
}

function stateText(it) {
  const pct = it.total ? Math.min(100, Math.round((it.sent / it.total) * 100)) : 0;
  switch (it.state) {
    case 'queued': return t('library.upload.queued');
    case 'uploading': return it.pdf && it.note ? it.note : t('library.upload.uploading', { pct });
    case 'processing': return t('library.upload.processing');
    case 'ready': return t('library.upload.ready');
    case 'cancelled': return t('library.upload.cancelled');
    default: return t('library.upload.failed', { error: it.error });
  }
}

function renderTray() {
  let tray = document.getElementById('libUploadTray');
  const visible = items.length > 0;
  if (!visible) { if (tray) tray.remove(); return; }
  if (!tray) {
    tray = document.createElement('section');
    tray.id = 'libUploadTray';
    tray.className = 'lib-tray';
    tray.setAttribute('aria-labelledby', 'libTrayTitle');
    document.body.appendChild(tray);
    tray.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const it = items.find((x) => x.id === Number(b.dataset.item));
      if (b.dataset.act === 'collapse') { collapsed = !collapsed; renderTray(); return; }
      if (b.dataset.act === 'clear') { clearFinished(); return; }
      if (!it) return;
      if (b.dataset.act === 'cancel') cancel(it);
      else if (b.dataset.act === 'retry') retry(it);
      else if (b.dataset.act === 'dismiss') dismiss(it);
    });
  }
  const active = activeCount();
  const failed = items.filter((i) => i.state === 'failed').length;
  const ready = items.filter((i) => i.state === 'ready').length;
  const summary = active
    ? t('library.upload.summary_active', { active, total: items.length })
    : failed ? t('library.upload.summary_failed', { failed, ready })
      : t('library.upload.summary_done', { ready });
  const focusedAct = document.activeElement && tray.contains(document.activeElement) ? document.activeElement.dataset : null;
  tray.innerHTML = `
    <div class="lib-tray-head">
      <h2 id="libTrayTitle" class="lib-tray-title">${esc(t('library.upload.title'))}</h2>
      <span class="lib-tray-summary" role="status" aria-live="polite">${esc(summary)}</span>
      ${!active ? `<button type="button" class="btn btn-secondary btn-sm" data-act="clear">${esc(t('library.upload.clear'))}</button>` : ''}
      <button type="button" class="lib-icon-btn" data-act="collapse" aria-expanded="${!collapsed}" aria-label="${esc(collapsed ? t('library.upload.expand') : t('library.upload.collapse'))}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="${collapsed ? '6 15 12 9 18 15' : '6 9 12 15 18 9'}"/></svg>
      </button>
    </div>
    ${collapsed ? '' : `<ul class="lib-tray-list">${items.map((it) => {
      const pct = it.total ? Math.min(100, Math.round((it.sent / it.total) * 100)) : 0;
      const live = ['uploading', 'processing', 'queued'].includes(it.state);
      return `<li class="lib-tray-item is-${it.state}">
        <div class="lib-tray-row">
          <span class="lib-tray-name" title="${esc(it.file.name)}">${esc(it.file.name)}</span>
          ${live && !it.pdf ? `<button type="button" class="btn btn-secondary btn-sm" data-act="cancel" data-item="${it.id}" aria-label="${esc(t('library.upload.cancel_named', { name: it.file.name }))}">${esc(t('common.cancel'))}</button>` : ''}
          ${it.state === 'failed' ? `<button type="button" class="btn btn-secondary btn-sm" data-act="retry" data-item="${it.id}" aria-label="${esc(t('library.upload.retry_named', { name: it.file.name }))}">${esc(t('library.upload.retry'))}</button>` : ''}
          ${!live ? `<button type="button" class="lib-icon-btn" data-act="dismiss" data-item="${it.id}" aria-label="${esc(t('library.upload.dismiss_named', { name: it.file.name }))}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>` : ''}
        </div>
        ${it.state === 'uploading' || it.state === 'processing' ? `<div class="lib-progress" role="progressbar" aria-label="${esc(it.file.name)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"${it.state === 'processing' ? ' aria-valuetext="' + esc(t('library.upload.processing')) + '"' : ''}><div class="lib-progress-fill${it.state === 'processing' ? ' is-indeterminate' : ''}" style="width:${it.state === 'processing' ? 100 : pct}%"></div></div>` : ''}
        <div class="lib-tray-meta"><span class="lib-dot is-${it.state === 'ready' ? 'ok' : it.state === 'failed' ? 'bad' : it.state === 'cancelled' ? 'muted' : 'busy'}" aria-hidden="true"></span>${esc(stateText(it))}${it.folderLabel ? ` · ${esc(t('library.upload.to_folder', { folder: it.folderLabel }))}` : ''}</div>
      </li>`;
    }).join('')}</ul>`}`;
  // Re-rendering replaces the buttons; keep keyboard focus on the same control where it still exists.
  if (focusedAct && focusedAct.act) {
    const sel = focusedAct.item ? `[data-act="${focusedAct.act}"][data-item="${focusedAct.item}"]` : `[data-act="${focusedAct.act}"]`;
    const again = tray.querySelector(sel) || tray.querySelector('[data-act="collapse"]');
    if (again) again.focus();
  }
  // Everything finished and nothing failed: the tray has done its job.
  clearTimeout(hideTimer);
  if (!active && !failed) hideTimer = setTimeout(() => { if (!activeCount() && !items.some((i) => i.state === 'failed')) { items.length = 0; renderTray(); } }, 6000);
}
