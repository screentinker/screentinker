/*
 * Self-service account deletion: the "Delete my account" card (Settings, and #/delete-account for
 * the Simple view and the Manager app) and its confirmation dialog.
 *
 * The server decides everything (routes/auth.js GET /auth/me/deletion and DELETE /auth/me); this
 * explains what it said. GET first, so the person reads what goes, what stays and what stands in the
 * way BEFORE typing a password. The dialog asks for the email typed out, then the account's own
 * proof of presence: the password (+ two-factor code), or, for a single sign-on account, a sign-in
 * made in the last few minutes (lib/account-deletion.js).
 *
 * Signing in again for that proof leaves this page, so the route to come back to is stashed
 * (stashReturnRoute) and app.js returns here once the new session is in place.
 */
import { api } from '../api.js';
import { t } from '../i18n.js';
import { esc, inManagerApp } from '../utils.js';
import { openModal } from './corporate-ui.js';

const RETURN_KEY = 'st_return_route';
const RETURN_TTL_MS = 15 * 60 * 1000;
// Only these routes can be "returned to": the stash is a convenience, not a redirect anyone can set.
export const DELETE_ACCOUNT_ROUTES = ['#/settings?section=delete-account', '#/delete-account'];

export function stashReturnRoute(hash) {
  if (!DELETE_ACCOUNT_ROUTES.includes(hash)) return;
  try { localStorage.setItem(RETURN_KEY, JSON.stringify({ hash, at: Date.now() })); } catch { /* private mode */ }
}

/** The stashed route if it is still fresh and allowed; consumed either way. */
export function takeReturnRoute() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem(RETURN_KEY) || 'null'); localStorage.removeItem(RETURN_KEY); } catch { return null; }
  if (!v || !DELETE_ACCOUNT_ROUTES.includes(v.hash) || !(Date.now() - v.at < RETURN_TTL_MS)) return null;
  return v.hash;
}

function blockedText(info) {
  if (info.blocked === 'last_platform_admin') return t('account_delete.blocked_last_admin');
  if (info.blocked === 'session_not_eligible') return t('account_delete.blocked_session');
  if (info.blocked === 'org_has_other_members') {
    const names = info.owned_organizations.filter((o) => o.shared).map((o) => o.name).join(', ');
    return t('account_delete.blocked_shared_org', { names });
  }
  return '';
}

/** What goes, what stays, what is in the way. Plain HTML, every value escaped. */
export function describeDeletion(info) {
  const solo = (info.owned_organizations || []).filter((o) => !o.shared);
  const blocked = blockedText(info);
  return `
    ${blocked ? `<p class="delete-account-blocked" role="alert" style="color:var(--danger, #e05252);font-size:13px;margin-bottom:12px">${esc(blocked)}</p>` : ''}
    ${info.subscription && info.subscription.active ? `<p role="note" style="font-size:13px;margin-bottom:12px;padding:8px 12px;border-radius:var(--radius);background:var(--bg-input)"><strong>${esc(t('account_delete.sub_title'))}</strong> ${esc(t('account_delete.sub_warning'))}</p>` : ''}
    <h4 style="font-size:13px;margin:0 0 6px">${esc(t('account_delete.will_delete'))}</h4>
    <ul style="font-size:13px;color:var(--text-secondary);margin:0 0 12px 18px;list-style:disc">
      <li>${esc(t('account_delete.item_account'))}</li>
      ${solo.map((o) => `<li>${esc(t('account_delete.item_org', { name: o.name, workspaces: o.workspaces, screens: o.screens, content: o.content, playlists: o.playlists }))}</li>`).join('')}
    </ul>
    <h4 style="font-size:13px;margin:0 0 6px">${esc(t('account_delete.not_deleted'))}</h4>
    <ul style="font-size:13px;color:var(--text-secondary);margin:0 0 12px 18px;list-style:disc">
      ${info.other_organizations ? `<li>${esc(t('account_delete.item_other_orgs', { n: info.other_organizations }))}</li>` : ''}
      <li>${esc(t('account_delete.item_audit'))}</li>
      <li>${esc(t('account_delete.backups'))} <a href="/delete-account" target="_blank" rel="noopener" style="color:var(--accent, #3b82f6);text-decoration:underline">${esc(t('account_delete.more_link'))}</a></li>
    </ul>`;
}

/** Fill `el` with the explanation and the button that opens the dialog. */
export async function mountDeleteAccountCard(el) {
  if (!el) return;
  el.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${esc(t('common.loading'))}</p>`;
  let info;
  try { info = await api.accountDeletionInfo(); } catch (err) {
    if (!document.contains(el)) return;
    el.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${esc(err.message)}</p>`;
    return;
  }
  if (!document.contains(el)) return;
  el.innerHTML = `
    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">${esc(t('account_delete.intro'))}</p>
    ${describeDeletion(info)}
    <button type="button" class="btn btn-danger btn-sm" data-delete-account ${info.blocked ? 'disabled' : ''}>${esc(t('account_delete.button'))}</button>`;
  el.querySelector('[data-delete-account]').addEventListener('click', () => openDeleteAccountDialog(info));
  mountHandOver(el, info);
}

/*
 * "Transfer ownership to another member" is what the blocked message tells the owner of a shared
 * organization to do; this is where they do it (POST /api/organizations/:id/ownership). One row
 * per shared organization they own: pick someone already in it, hand it over. Afterwards they are
 * an organization admin there, and the card reloads to say what is still in the way, if anything.
 */
async function mountHandOver(el, info) {
  const shared = (info.owned_organizations || []).filter((o) => o.shared);
  if (!shared.length) return;
  const token = () => localStorage.getItem('token');
  const call = async (method, path, body) => {
    const res = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` }, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch { /* */ }
    return { status: res.status, data: data || {} };
  };
  const host = document.createElement('div');
  host.className = 'org-handover';
  host.style.cssText = 'margin-top:16px;padding-top:12px;border-top:1px solid var(--border)';
  host.innerHTML = `<h4 style="font-size:13px;margin:0 0 8px">${esc(t('account_delete.handover.title'))}</h4>`;
  el.appendChild(host);
  for (const org of shared) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;font-size:13px';
    row.innerHTML = `<span style="min-width:140px">${esc(org.name)}</span><span style="color:var(--text-muted)">${esc(t('common.loading'))}</span>`;
    host.appendChild(row);
    let own;
    try { own = await call('GET', `/organizations/${encodeURIComponent(org.id)}/ownership`); } catch { own = { status: 0, data: {} }; }
    if (!document.contains(row)) return;
    const people = (own.data && own.data.candidates) || [];
    if (own.status !== 200 || !people.length) {
      row.lastElementChild.textContent = t('account_delete.handover.nobody');
      continue;
    }
    row.innerHTML = `<span style="min-width:140px">${esc(org.name)}</span>
      <select class="input" data-handover-to style="max-width:260px;padding:4px 8px;font-size:13px">
        ${people.map((p) => `<option value="${esc(p.id)}">${esc(p.name ? `${p.name} (${p.email})` : p.email)}</option>`).join('')}
      </select>
      <button type="button" class="btn btn-secondary btn-sm" data-handover>${esc(t('account_delete.handover.button'))}</button>
      <span data-handover-msg role="status" style="color:var(--text-muted)"></span>`;
    const btn = row.querySelector('[data-handover]');
    const msg = row.querySelector('[data-handover-msg]');
    btn.addEventListener('click', async () => {
      const sel = row.querySelector('[data-handover-to]');
      const who = sel.options[sel.selectedIndex].textContent;
      if (!confirm(t('account_delete.handover.confirm', { org: org.name, who }))) return;
      btn.disabled = true; msg.textContent = '';
      try {
        let r = await call('POST', `/organizations/${encodeURIComponent(org.id)}/ownership`, { user_id: sel.value });
        // While the person pays, the plan is the owner's: the server says what would change first.
        if (r.status === 409 && r.data.code === 'PLAN_FOLLOWS_OWNER') {
          if (!confirm(r.data.error + '\n\n' + t('account_delete.handover.confirm_plan'))) { btn.disabled = false; return; }
          r = await call('POST', `/organizations/${encodeURIComponent(org.id)}/ownership`, { user_id: sel.value, acknowledge_plan_change: true });
        }
        if (r.status !== 200) { msg.textContent = r.data.error || t('account_delete.handover.failed'); btn.disabled = false; return; }
        await mountDeleteAccountCard(el);   // reload: this organization is no longer in the way
      } catch (err) { msg.textContent = err.message; btn.disabled = false; }
    });
  }
}

/** Leave to sign in again (single sign-on, or the login page), coming back to this route. */
function signInAgain(info) {
  const here = DELETE_ACCOUNT_ROUTES.includes(window.location.hash) ? window.location.hash : '#/delete-account';
  stashReturnRoute(here);
  // Signed out locally first: the login page only finishes a sign-in for a browser with no session.
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  const start = info.reauth && info.reauth.sso_start;
  const bridge = window.STManager;
  if (start && inManagerApp() && bridge && typeof bridge.startSso === 'function') { bridge.startSso(start); return; }
  if (start) { window.location.assign(start); return; }
  window.location.hash = '#/login';
  window.location.reload();
}

export function openDeleteAccountDialog(info) {
  const minutes = Math.round(((info.reauth && info.reauth.window_seconds) || 600) / 60);
  const password = info.reauth && info.reauth.method === 'password';
  const needsSignIn = !password && !(info.reauth && info.reauth.recent_sign_in);
  const m = openModal({
    title: t('account_delete.dialog_title'),
    body: `
      <p style="font-size:13px;margin-bottom:12px"><strong>${esc(t('account_delete.dialog_warning'))}</strong></p>
      ${describeDeletion(info)}
      <div class="form-group">
        <label for="delAcctConfirm">${esc(t('account_delete.confirm_label', { email: info.email }))}</label>
        <input id="delAcctConfirm" class="input" type="email" autocomplete="off" autocapitalize="none" spellcheck="false">
      </div>
      ${password ? `
      <div class="form-group">
        <label for="delAcctPassword">${esc(t('account_delete.password_label'))}</label>
        <input id="delAcctPassword" class="input" type="password" autocomplete="current-password">
      </div>
      ${info.reauth.totp_required ? `
      <div class="form-group">
        <label for="delAcctCode">${esc(t('account_delete.code_label'))}</label>
        <input id="delAcctCode" class="input" inputmode="numeric" autocomplete="one-time-code" maxlength="20">
      </div>` : ''}` : `
      <p style="font-size:13px;color:var(--text-secondary)" data-reauth-note>${esc(needsSignIn ? t('account_delete.reauth_needed', { minutes }) : t('account_delete.reauth_recent', { minutes }))}</p>
      ${needsSignIn ? `<button type="button" class="btn btn-secondary btn-sm" data-reauth>${esc(t('account_delete.reauth_button'))}</button>` : ''}`}
      <div data-status role="status" style="font-size:13px;color:var(--danger, #e05252);margin-top:8px;min-height:1em"></div>`,
    footer: `<button type="button" class="btn btn-secondary" data-corp-close>${esc(t('common.cancel'))}</button>
             <button type="button" class="btn btn-danger" data-submit ${info.blocked || needsSignIn ? 'disabled' : ''}>${esc(t('account_delete.submit'))}</button>`,
  });
  const status = m.q('[data-status]');
  const submit = m.q('[data-submit]');
  m.q('[data-reauth]')?.addEventListener('click', () => signInAgain(info));
  m.q('#delAcctConfirm').focus();
  submit.addEventListener('click', async () => {
    status.textContent = '';
    const confirm = m.q('#delAcctConfirm').value.trim();
    if (confirm.toLowerCase() !== String(info.email).toLowerCase()) { status.textContent = t('account_delete.err_confirm'); return; }
    const body = { confirm };
    if (password) {
      body.password = m.q('#delAcctPassword').value;
      if (!body.password) { status.textContent = t('account_delete.err_password'); return; }
      const code = m.q('#delAcctCode');
      if (code) body.code = code.value.trim();
    }
    submit.disabled = true;
    submit.textContent = t('account_delete.deleting');
    try {
      await api.deleteMyAccount(body);
    } catch (err) {
      submit.disabled = false;
      submit.textContent = t('account_delete.submit');
      status.textContent = err.message;
      if (err.code === 'reauth_recent_sign_in_required') {
        submit.disabled = true;
        const note = m.q('[data-reauth-note]');
        if (note) note.textContent = t('account_delete.reauth_needed', { minutes });
        if (!m.q('[data-reauth]') && note) {
          note.insertAdjacentHTML('afterend', `<button type="button" class="btn btn-secondary btn-sm" data-reauth>${esc(t('account_delete.reauth_button'))}</button>`);
          m.q('[data-reauth]').addEventListener('click', () => signInAgain({ ...info, reauth: { ...info.reauth, sso_start: err.body?.sso_start || info.reauth.sso_start } }));
        }
      }
      return;
    }
    // Gone: nothing of this session is any use now. Leave the app for the public "deleted" page.
    for (const k of ['token', 'user', 'rd_onboarded']) localStorage.removeItem(k);
    window.location.href = '/account-deleted';
  });
}
