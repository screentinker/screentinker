import { t } from '../i18n.js';

/*
 * #312 follow-up: "Move to a new server" for a whole workspace. This is a fleet-wide, blast-radius
 * action — it tells EVERY device in the workspace to switch server address — so it is deliberately
 * heavier than a normal command: a warning, a URL to enter, and a type-the-workspace-name commit
 * before the danger button unlocks. Each panel still verifies-then-commits and rolls back an
 * unreachable address, but a reachable-yet-wrong address (a different server) would misdirect the
 * fleet, which is why the human has to slow down here.
 *
 * opts: { workspaceName, deviceCount, suggestedUrl, onConfirm: async (url) => any }
 * onConfirm may throw to show an inline error and keep the modal open.
 */
export function openMoveServerModal(opts = {}) {
  const { workspaceName = '', deviceCount = 0, suggestedUrl = '', onConfirm } = opts;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>${esc(t('moveserver.title'))}</h3>
        <button class="btn-icon" type="button" data-ms-close aria-label="${esc(t('common.close'))}">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <div style="font-size:13px;line-height:1.5;margin-bottom:14px;padding:12px;border-radius:8px;background:var(--danger-bg,rgba(220,38,38,.08));border:1px solid var(--danger,#dc2626)">
          ${t('moveserver.warning', { n: esc(String(deviceCount)), workspace: esc(workspaceName) })}
        </div>
        <div class="form-group">
          <label for="msUrl">${esc(t('moveserver.url_label'))}</label>
          <input id="msUrl" type="url" inputmode="url" class="input" autocomplete="off" placeholder="https://" style="width:100%" value="${esc(suggestedUrl)}">
        </div>
        <div class="form-group">
          <label for="msConfirm">${t('moveserver.type_label', { name: esc(workspaceName) })}</label>
          <input id="msConfirm" type="text" class="input" autocomplete="off" style="width:100%">
        </div>
        <div id="msError" style="display:none;color:var(--danger);font-size:13px;margin-top:8px"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" data-ms-close>${esc(t('common.cancel'))}</button>
        <button class="btn btn-danger" type="button" id="msConfirmBtn" disabled>${esc(t('moveserver.confirm_btn'))}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const urlInput = overlay.querySelector('#msUrl');
  const nameInput = overlay.querySelector('#msConfirm');
  const confirmBtn = overlay.querySelector('#msConfirmBtn');
  const errorEl = overlay.querySelector('#msError');

  const cleanUrl = () => urlInput.value.trim().replace(/\/+$/, '');
  const urlOk = () => /^https?:\/\/.+/i.test(cleanUrl());
  const nameOk = () => nameInput.value.trim() === String(workspaceName);
  const refresh = () => { confirmBtn.disabled = !(urlOk() && nameOk()); };
  urlInput.addEventListener('input', refresh);
  nameInput.addEventListener('input', refresh);

  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) {
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter' && urlOk() && nameOk()) commit();
  }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('[data-ms-close]').forEach(b => b.addEventListener('click', close));

  async function commit() {
    if (!(urlOk() && nameOk())) return;
    if (!urlOk()) { errorEl.textContent = t('moveserver.url_bad'); errorEl.style.display = 'block'; return; }
    errorEl.style.display = 'none';
    confirmBtn.disabled = true;
    const label = confirmBtn.textContent;
    confirmBtn.textContent = t('moveserver.sending');
    try {
      await onConfirm?.(cleanUrl());
      close();
    } catch (err) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = label;
      errorEl.textContent = err?.message || t('moveserver.failed');
      errorEl.style.display = 'block';
    }
  }
  confirmBtn.addEventListener('click', commit);
  urlInput.focus();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
