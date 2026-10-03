import { t } from '../i18n.js';
import { api } from '../api.js';

/*
 * Create a workspace inside the organization the signed-in user administers.
 *
 * ⚠️ THE FEATURE EXISTED EVERYWHERE EXCEPT HERE. Workspace scoping, invites, member roles, the
 * switcher and the JWT context were all built and working — and a workspace row was only ever
 * written at signup and by a platform admin, both hardcoded to the name "Default". Production had
 * 313 organizations with exactly one workspace each, which read like nobody wanted a second one
 * and actually meant nobody could have one. This is the missing front door.
 *
 * Deliberately mirrors workspace-rename-modal.js — same overlay classes, same Escape/Enter
 * handling, same error surface. Two modals for two verbs on one object should look identical, and
 * the rename one is the shape this codebase already settled on.
 */
export function openWorkspaceCreateModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>${t('switcher.create_title')}</h3>
        <button class="btn-icon" type="button" data-create-close aria-label="${t('common.close')}">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <div style="color:var(--text-muted);font-size:13px;margin-bottom:12px">${t('switcher.create_hint')}</div>
        <div class="form-group">
          <label for="createWsName">${t('switcher.create_name_label')}</label>
          <input id="createWsName" type="text" class="input" maxlength="80" placeholder="${t('switcher.create_name_placeholder')}" style="width:100%">
        </div>
        <div class="form-group">
          <label for="createWsSlug">${t('switcher.create_slug_label')}</label>
          <input id="createWsSlug" type="text" class="input" maxlength="60" placeholder="e.g. retail-floor" style="width:100%">
          <div style="color:var(--text-muted);font-size:11px;margin-top:4px">${t('switcher.create_slug_hint')}</div>
        </div>
        <div id="createWsError" style="display:none;color:var(--danger);font-size:13px;margin-top:8px"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" data-create-close>${t('common.cancel')}</button>
        <button class="btn btn-primary" type="button" id="createWsSave">${t('switcher.create_submit')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const nameInput = overlay.querySelector('#createWsName');
  const slugInput = overlay.querySelector('#createWsSlug');
  const errorEl = overlay.querySelector('#createWsError');
  const saveBtn = overlay.querySelector('#createWsSave');
  nameInput.focus();

  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) {
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter' && (e.target === nameInput || e.target === slugInput)) save();
  }
  document.addEventListener('keydown', onKey);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('[data-create-close]').forEach(b => b.addEventListener('click', close));

  let busy = false;
  async function save() {
    /*
     * ⚠️ NOT GUARDED BY saveBtn.disabled. A disabled button ignores clicks, but the document-level
     * Enter binding calls save() directly and key auto-repeat fires it continuously — so holding
     * Enter in the name field posted one create per repeat. Create is NOT idempotent (the rename
     * modal this was modelled on is, which is how the shape got copied), there is no rate limit on
     * the route, and there is no self-service delete: one held key could consume the organization's
     * entire workspace cap, permanently, needing a platform admin to clean up.
     */
    if (busy) return;
    busy = true;
    errorEl.style.display = 'none';
    const name = nameInput.value.trim();
    const slug = slugInput.value.trim();
    if (!name) { showError(t('switcher.create_name_required')); busy = false; return; }
    saveBtn.disabled = true;
    saveBtn.textContent = t('switcher.create_working');
    try {
      const ws = await api.createWorkspace({ name, slug: slug || undefined });
      /*
       * ⚠️ SWITCH INTO IT BEFORE RELOADING. A new workspace is empty, and landing back in the OLD
       * one with a success toast is indistinguishable from nothing having happened — the operator's
       * next act is to create it again. Switching mints a JWT carrying the new workspace context,
       * which is what every scoped route reads; the reload then paints the dashboard for it.
       *
       * A switch failure is NOT a create failure: the workspace exists either way, so say so
       * rather than presenting it as an error, and let the reload land wherever it lands.
       */
      try {
        const sw = await api.switchWorkspace(ws.id);
        /*
         * ⚠️ STORING THE TOKEN IS THE WHOLE SWITCH. The active workspace lives in the JWT, not in a
         * server-side session — so a switch that is awaited but whose token is dropped changes
         * nothing at all, and the reload below lands right back in the previous workspace with a
         * new one sitting unused in the list. Caught by the browser smoke, which asserted where the
         * operator ends up rather than that the call resolved. Both other callers (app.js after an
         * invite, and the switcher itself) do exactly this.
         */
        if (sw && sw.token) localStorage.setItem('token', sw.token);
      } catch (e) { /* created; the switcher can still reach it */ }
      /*
       * ⚠️ DROP ANY SELECTED REMOTE SERVER BEFORE RELOADING — the switcher's own switch path states
       * the rule: "clear before the reload, or the local workspace renders under the remote banner
       * and an operator is looking at their own data labelled as somebody else's." A workspace is
       * always created LOCALLY (/workspaces is ALWAYS_LOCAL), so landing in it while a customer's
       * server is still selected is exactly that failure.
       */
      try {
        const { clearRemoteOrg } = await import('./workspace-switcher.js');
        clearRemoteOrg();
      } catch (e) { /* nothing selected, or the module moved — the reload is still correct */ }
      window.location.reload();
    } catch (err) {
      busy = false;
      saveBtn.disabled = false;
      saveBtn.textContent = t('switcher.create_submit');
      // The server's own words — it distinguishes a duplicate slug from a bad one from the per-org
      // cap, and each needs a different action from the person reading it.
      showError(err.message || t('switcher.create_failed'));
    }
  }
  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.style.display = 'block';
  }

  saveBtn.addEventListener('click', save);
}
