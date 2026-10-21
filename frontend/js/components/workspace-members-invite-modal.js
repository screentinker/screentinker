// Invite-member modal. Mirrors workspace-rename-modal.js's structure
// (overlay + listeners + close + esc/click-outside/enter) with two key
// differences:
//
//   1. On success calls an onSuccess(result) callback instead of
//      window.location.reload(). The parent view (workspace-members.js)
//      re-fetches and re-renders just the pending-invites section - no
//      full-page flash for a single row addition.
//
//   2. Server errors map to translated strings via a mapError callback
//      passed by the parent (mapMutationError lives in workspace-members.js).
//      That keeps a single error mapper for ALL slice 2B mutations rather
//      than scattering modal-specific copies. Inline display below the form
//      (not toast) so user can correct + resubmit without closing.

import { api } from '../api.js';
import { t } from '../i18n.js';
import { showToast } from './toast.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// open the modal.
//   workspace: { id, name } - id used for the API call, name shown in title
//   opts.onSuccess: (result) => void - fires on 200; result is the server
//     response body { id, email, role, expires_at }
//   opts.mapError: (err) => string - translates server error to display text
export function openInviteMemberModal(workspace, opts = {}) {
  const { onSuccess, mapError } = opts;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>${t('members.modal.invite_title', { workspace: esc(workspace.name) })}</h3>
        <button class="btn-icon" type="button" data-invite-close aria-label="${t('common.close')}">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label for="inviteEmail">${t('members.modal.email_label')}</label>
          <input id="inviteEmail" type="email" class="input" placeholder="${t('members.modal.email_placeholder')}" style="width:100%" autocomplete="off" autocapitalize="off" spellcheck="false">
        </div>
        <div class="form-group">
          <label for="inviteRole">${t('members.modal.role_label')}</label>
          <select id="inviteRole" class="input" style="width:100%">
            <option value="workspace_viewer">${t('members.role.workspace_viewer')}</option>
            <option value="workspace_editor">${t('members.role.workspace_editor')}</option>
            <option value="workspace_admin">${t('members.role.workspace_admin')}</option>
          </select>
        </div>
        <div id="inviteModalError" style="display:none;color:var(--danger);font-size:13px;margin-top:8px"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" data-invite-close>${t('members.modal.cancel')}</button>
        <button class="btn btn-primary" type="button" id="inviteSendBtn">${t('members.modal.send')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const emailInput = overlay.querySelector('#inviteEmail');
  const roleSelect = overlay.querySelector('#inviteRole');
  const errorEl = overlay.querySelector('#inviteModalError');
  const sendBtn = overlay.querySelector('#inviteSendBtn');
  emailInput.focus();

  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) {
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter' && (e.target === emailInput || e.target === roleSelect)) send();
  }
  document.addEventListener('keydown', onKey);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('[data-invite-close]').forEach(b => b.addEventListener('click', close));

  async function send() {
    errorEl.style.display = 'none';
    const email = emailInput.value.trim().toLowerCase();
    const role = roleSelect.value;
    // Client-side email validation - server validates too, but this avoids a
    // round-trip and gives immediate feedback on obvious typos.
    if (!email || !EMAIL_RE.test(email)) {
      showError(t('members.error.invalid_email'));
      emailInput.focus();
      return;
    }
    sendBtn.disabled = true;
    sendBtn.textContent = t('members.modal.sending');
    try {
      const result = await api.inviteWorkspaceMember(workspace.id, { email, role });
      close();
      // Defensive: undefined onSuccess is a no-op; a thrown onSuccess (parent
      // bug) is logged but not propagated so the modal-close still succeeded
      // from the user's perspective.
      if (typeof onSuccess === 'function') {
        try { onSuccess(result); }
        catch (e) { console.error('invite modal onSuccess threw:', e); }
      }
    } catch (err) {
      sendBtn.disabled = false;
      sendBtn.textContent = t('members.modal.send');
      // Map via parent-supplied helper. Fallback to raw message if no mapper
      // was provided (shouldn't happen in normal use, defensive only).
      const msg = (typeof mapError === 'function')
        ? mapError(err)
        : (err?.message || t('members.error.mutation_generic', { error: '' }));
      showError(msg);
    }
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.style.display = 'block';
  }

  sendBtn.addEventListener('click', send);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// The invite was created but no email went out (no mail transport on this server): say so, and
// give the inviter the link to pass on themselves - what Simple view's Team page does
// (views/simple-home.js). The link only works for the invited address (accept-invite checks it).
export function openInviteLinkModal(workspace, result) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>${t('members.modal.invite_title', { workspace: esc(workspace.name) })}</h3>
        <button class="btn-icon" type="button" data-link-close aria-label="${t('common.close')}">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <p style="margin:0 0 8px">${esc(t('simple.team.not_emailed', { email: result.email }))}</p>
        <input id="inviteLinkUrl" class="input" type="text" readonly style="width:100%" value="${esc(result.accept_url)}">
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" data-link-close>${t('common.close')}</button>
        <button class="btn btn-primary" type="button" id="inviteLinkCopyBtn">${esc(t('simple.team.copy_link'))}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#inviteLinkUrl');
  input.addEventListener('focus', () => input.select());
  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('[data-link-close]').forEach(b => b.addEventListener('click', close));
  overlay.querySelector('#inviteLinkCopyBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(result.accept_url);
      showToast(t('simple.team.copied'), 'success');
    } catch {
      // No clipboard (plain http, an older browser): leave the link selected for Ctrl+C.
      input.focus(); input.select();
    }
  });
}
