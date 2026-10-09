// A modal dialog that behaves like one: labelled by its title, focus kept inside (Tab and Shift+Tab
// wrap), Escape and the backdrop ask to close, everything behind it is `inert` (not clickable, not
// focusable, not read out), and focus goes back to whatever opened it.
//
// The app's older modals (.modal-overlay) do none of this, so a keyboard user tabbed straight out of
// them into the page underneath. This is used by the Content Library; it can be adopted elsewhere.
//
// `onRequestClose(reason)` may return false (or a Promise of false) to refuse — the Add content
// modal uses it to warn before throwing away typed input. A nested dialog (a confirm on top of a
// modal) inerts the first one too, and gives it back when it closes.

import { esc } from '../../utils.js';
import { t } from '../../i18n.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), audio[controls], video[controls], summary';
// Left alone by `inert`: toasts must still be announced, and the upload queue keeps reporting.
const KEEP_LIVE = new Set(['toastContainer']);

let seq = 0;

export function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

export function openDialog({ title, html = '', className = '', size = 'md', onRequestClose = null, initialFocus = null, returnFocus = null } = {}) {
  const id = `libdlg${++seq}`;
  const opener = returnFocus || document.activeElement;
  const backdrop = document.createElement('div');
  backdrop.className = 'lib-dialog-backdrop';
  backdrop.innerHTML = `
    <div class="lib-dialog lib-dialog-${size} ${className}" role="dialog" aria-modal="true" aria-labelledby="${id}-title">
      <div class="lib-dialog-head">
        <h2 class="lib-dialog-title" id="${id}-title">${esc(title || '')}</h2>
        <button type="button" class="lib-icon-btn" data-dialog-close aria-label="${esc(t('common.close'))}">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="lib-dialog-body">${html}</div>
    </div>`;
  const dialog = backdrop.firstElementChild;

  // Inert every sibling of the backdrop that is not already inert, and remember which ones.
  const inerted = [];
  for (const el of document.body.children) {
    if (el === backdrop || KEEP_LIVE.has(el.id) || el.inert || el.tagName === 'SCRIPT') continue;
    el.inert = true;
    inerted.push(el);
  }
  document.body.appendChild(backdrop);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    for (const el of inerted) el.inert = false;
    if (opener && document.contains(opener) && typeof opener.focus === 'function') opener.focus();
  }
  async function requestClose(reason) {
    if (closed) return;
    if (onRequestClose) {
      const ok = await onRequestClose(reason);
      if (ok === false) return;
    }
    close();
  }
  function onKey(e) {
    // Only the topmost dialog answers.
    const top = [...document.querySelectorAll('.lib-dialog-backdrop')].pop();
    if (top !== backdrop) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); requestClose('escape'); return; }
    if (e.key !== 'Tab') return;
    const list = focusables(dialog);
    if (!list.length) { e.preventDefault(); dialog.focus(); return; }
    const first = list[0], last = list[list.length - 1];
    if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  }
  document.addEventListener('keydown', onKey, true);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) requestClose('backdrop'); });
  dialog.querySelector('[data-dialog-close]').addEventListener('click', () => requestClose('button'));
  dialog.tabIndex = -1;

  const focusFirst = () => {
    const want = initialFocus ? dialog.querySelector(initialFocus) : null;
    (want || focusables(dialog.querySelector('.lib-dialog-body'))[0] || dialog).focus();
  };
  setTimeout(focusFirst, 0);

  return {
    root: dialog,
    body: dialog.querySelector('.lib-dialog-body'),
    titleEl: dialog.querySelector('.lib-dialog-title'),
    setTitle(text) { dialog.querySelector('.lib-dialog-title').textContent = text; },
    focusFirst,
    close,
    requestClose,
    get closed() { return closed; },
  };
}

/**
 * A confirm that is a real dialog. Resolves true on confirm, false on cancel, Escape or backdrop.
 * `bodyHtml` is trusted markup built by the caller with esc() around every value.
 */
export function confirmDialog({ title, bodyHtml = '', confirmLabel, cancelLabel, danger = false } = {}) {
  return new Promise((resolve) => {
    let answer = false;
    const d = openDialog({
      title,
      size: 'sm',
      html: `<div class="lib-confirm-text">${bodyHtml}</div>
        <div class="lib-dialog-actions">
          <button type="button" class="btn btn-secondary" data-no>${esc(cancelLabel || t('common.cancel'))}</button>
          <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${esc(confirmLabel || t('library.confirm'))}</button>
        </div>`,
      initialFocus: '[data-no]',
      onRequestClose: () => { resolve(answer); return true; },
    });
    d.root.querySelector('[data-no]').addEventListener('click', () => d.requestClose('cancel'));
    d.root.querySelector('[data-yes]').addEventListener('click', () => { answer = true; d.requestClose('confirm'); });
  });
}
