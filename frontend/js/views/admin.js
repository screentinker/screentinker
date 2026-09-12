import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc, isPlatformAdmin } from '../utils.js';
import { t } from '../i18n.js';
import { openAddUserModal } from '../components/workspace-members-add-user-modal.js';
import { openManageWorkspacesModal } from '../components/admin-user-workspaces-modal.js';
import { openCreateOrgModal } from '../components/admin-create-org-modal.js';
import { openTypeToConfirmModal } from '../components/type-to-confirm-modal.js';
// Reuse the members view's server-error -> friendly-string mapper (handles the
// 409 duplicate-email / weak-password / invalid-email cases) so we don't fork a
// second mapper.
import { mapMutationError } from './workspace-members.js';

const headers = () => ({ Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' });
// A refused request must reject, not resolve.
//
// This helper used to end in `.then(r => r.json())`, so a 403/404/500 body resolved as an ordinary
// value and the surrounding try/catch was unreachable — every handler took the failure for success.
// Concretely: deleting a built-in layout template showed "Layout deleted" while the server had
// returned 403 and the template was still there, and a rejected platform-role change showed "Role
// updated" while the dropdown kept displaying a value the server refused (its revert lives only in
// the dead catch). The shared client in api.js has always thrown on !res.ok; these local copies did
// not. Same contract now, including the 401 session-expiry reload.
const API = (url, opts = {}) => fetch('/api' + url, { headers: headers(), ...opts }).then(async (r) => {
  if (r.status === 401) { localStorage.removeItem('token'); window.location.reload(); throw new Error('Session expired'); }
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `Request failed (${r.status})`); }
  return r.json();
});

// #14: the platform user-management dropdown manages users.role (the
// PLATFORM-level role) only - workspace/org roles are managed in the members
// views. Options are the current model; the legacy 'admin'/'superadmin' strings
// were normalized away. #13 adds 'platform_operator' (cross-org staff).
const PLATFORM_ROLE_OPTIONS = ['user', 'platform_operator', 'platform_admin'];

// Platform staff have cross-org access (no single workspace), so the Workspace
// column shows read-only "Platform (all)" for them. Note utils.isPlatformAdmin
// only covers admin/superadmin; operators are staff here too.
function isPlatformStaffRole(role) {
  return role === 'platform_admin' || role === 'superadmin' || role === 'platform_operator';
}

// Short summary of a user's workspace membership for the Users-table cell.
// Platform staff have cross-org access (not per-workspace membership) -> "Platform
// (all)". Otherwise: Unassigned (0), the workspace name (1), or "N workspaces".
function workspaceSummary(u) {
  if (isPlatformStaffRole(u.role)) return t('admin.workspace.platform_all');
  const count = u.workspace_count || 0;
  if (count === 0) return t('admin.workspace.unassigned');
  if (count === 1) return esc(u.workspace_name || '');
  return t('admin.workspace.multi', { n: count });
}

// Workspace cell: a summary + a "Manage" button that opens the full membership
// modal (add/remove workspaces, set per-workspace role). Manage is offered for
// everyone, including staff (you can grant them explicit memberships too).
function workspaceCell(u) {
  return `<td style="padding:8px">
    <div style="display:flex;align-items:center;gap:8px">
      <span style="color:var(--text-muted);font-size:12px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${workspaceSummary(u)}</span>
      <button class="btn btn-secondary btn-sm" type="button" data-ws-manage="${esc(u.id)}">${t('admin.workspace.manage')}</button>
    </div>
  </td>`;
}

export async function render(container) {
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  if (!isPlatformAdmin(user)) {
    container.innerHTML = `<div class="empty-state"><h3>${t('admin.access_denied')}</h3><p>${t('admin.access_denied_desc')}</p></div>`;
    return;
  }

  container.innerHTML = `
    <div class="page-header">
      <div><h1>${t('admin.title')}</h1><div class="subtitle">${t('admin.subtitle')}</div></div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary" id="adminCreateOrgBtn">${t('admin.create_org.button')}</button>
        <button class="btn btn-primary" id="adminAddUserBtn">${t('admin.add_user')}</button>
      </div>
    </div>

    <!-- Single sign-on removal approvals. First, because it is the only screen on this page an
         operator is DIRECTED to by an email, and because a tenant is locked out of their own
         product while it sits here. -->
    <div class="settings-section" id="ssoOnlySection" style="display:none">
      <h3>${t('admin.sso_only.title')}</h3>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px">${t('admin.sso_only.desc')}</p>
      <div id="ssoOnlyRequests"><p style="color:var(--text-muted)">${t('common.loading')}</p></div>
    </div>

    <div class="settings-section">
      <h3>${t('admin.all_users')}</h3>
      <div id="allUsersTable"><p style="color:var(--text-muted)">${t('common.loading')}</p></div>
    </div>

    <!-- Server diagnostics. Everything here was already being recorded and shown nowhere: the
         loop-lag history is written every second, and the instance shape used to mean asking a
         customer to run a shell script as root on their production box. -->
    <div class="settings-section">
      <h3>${t('admin.diag.title')}</h3>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px">${t('admin.diag.desc')}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
        <button class="btn btn-secondary" id="diagRefreshBtn">${t('admin.diag.refresh')}</button>
        <select id="diagProfileSecs" class="form-control" style="width:auto">
          <option value="30">30s</option><option value="60">60s</option><option value="15">15s</option>
        </select>
        <button class="btn btn-secondary" id="diagProfileBtn">${t('admin.diag.profile')}</button>
        <button class="btn btn-secondary" id="diagDownloadBtn" style="display:none">${t('admin.diag.download')}</button>
      </div>
      <div id="diagBody"><p style="color:var(--text-muted)">${t('common.loading')}</p></div>
    </div>

    <div class="settings-section">
      <h3>${t('admin.orgs.title')}</h3>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px">${t('admin.orgs.desc')}</p>
      <div id="orgsTable"><p style="color:var(--text-muted)">${t('common.loading')}</p></div>
    </div>

    <div class="settings-section">
      <h3>${t('admin.branding.title')}</h3>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px">${t('admin.branding.desc')}</p>
      <div id="brandingForm"><p style="color:var(--text-muted)">${t('common.loading')}</p></div>
    </div>

    <div class="settings-section">
      <h3>${t('admin.plans')}</h3>
      <div id="plansTable"><p style="color:var(--text-muted)">${t('common.loading')}</p></div>
    </div>

    <div class="settings-section">
      <h3>${t('admin.system')}</h3>
      <div id="systemInfo"><p style="color:var(--text-muted)">${t('common.loading')}</p></div>
    </div>

    <div class="settings-section">
      <h3>Status endpoint</h3>
      <div id="statusDebugForm"><p style="color:var(--text-muted)">${t('common.loading')}</p></div>
    </div>
  `;

  // Add User (#10): platform admin provisions a user into ANY workspace. The
  // page is platform_admin-gated; the modal opens in picker mode (no fixed
  // workspace) so the admin chooses the target org/workspace. The endpoint
  // additionally enforces canAdminWorkspace (platform_admin passes everywhere).
  document.getElementById('adminAddUserBtn')?.addEventListener('click', () => {
    openAddUserModal(null, {
      onSuccess: (result) => {
        showToast(t('members.success.user_created', { email: result.email }), 'success');
        loadUsers();
      },
      mapError: mapMutationError,
    });
  });

  // Create Organization (#35): platform admin provisions a new customer org +
  // its first workspace (owned by the admin). The modal reloads on success so
  // the new org shows up in the switcher.
  document.getElementById('adminCreateOrgBtn')?.addEventListener('click', () => {
    openCreateOrgModal({
      onSuccess: (result) => showToast(t('admin.create_org.success', { name: result.name }), 'success'),
    });
  });

  loadUsers();
  loadOrgs();
  loadDiagnostics();
  wireDiagnostics();
  loadSsoOnlyRequests();
  loadBranding();
  loadPlans();
  loadSystem();
  loadStatusDebug();

}

// #36: list organizations with owner + resource counts; platform admin can
// cascade-delete an org or an individual workspace (type-the-name confirm).
/*
 * Pending "stop requiring single sign-on" requests.
 *
 * The notification email tells the operator to review this under Admin, and for a while it did not
 * exist — the only way to approve was curl, while the customer sat locked out. The section hides
 * itself when there is nothing pending so it is never noise.
 */
async function loadSsoOnlyRequests() {
  const section = document.getElementById('ssoOnlySection');
  const host = document.getElementById('ssoOnlyRequests');
  if (!section || !host) return;
  // NB: `api` is a map of named methods, not a generic client — there is no api.get(), and calling
  // one silently hid this whole section behind the catch below.
  const authed = (path, init = {}) => fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}`, ...(init.headers || {}) },
  });

  let requests = [];
  try {
    const res = await authed('/organizations/sso-only/removal-requests');
    if (!res.ok) throw new Error(String(res.status));
    requests = (await res.json()).requests || [];
  } catch {
    section.style.display = 'none';
    return;
  }
  // Clear as well as hide: leaving the last decided request in the tree kept its live
  // Approve/Reject listeners attached to a request that no longer exists.
  if (!requests.length) { host.innerHTML = ''; section.style.display = 'none'; return; }
  section.style.display = '';

  host.innerHTML = requests.map((r) => `
    <div style="border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin-bottom:8px">
      <div><strong>${esc(r.organization_name || r.organization_id)}</strong></div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:2px">
        ${esc(t('admin.sso_only.requested_by', { who: r.requested_by_email || 'unknown' }))}
      </div>
      ${r.reason ? `<div style="font-size:12px;margin-top:6px">${esc(r.reason)}</div>` : ''}
      <div style="font-size:12px;color:var(--warning,#b45309);margin-top:8px">${esc(t('admin.sso_only.effect'))}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
        <button class="btn btn-danger btn-sm" data-sso-approve="${esc(r.id)}">${esc(t('admin.sso_only.approve'))}</button>
        <button class="btn btn-secondary btn-sm" data-sso-reject="${esc(r.id)}">${esc(t('admin.sso_only.reject'))}</button>
      </div>
    </div>`).join('');

  const decide = async (id, decision) => {
    try {
      const res = await authed(`/organizations/sso-only/removal-requests/${id}/${decision}`, { method: 'POST', body: '{}' });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))).error) || String(res.status));
      showToast(t(decision === 'approve' ? 'admin.sso_only.approved' : 'admin.sso_only.rejected'), 'success');
      await loadSsoOnlyRequests();
    } catch (e) {
      showToast((e && e.message) || t('admin.sso_only.failed'), 'error');
    }
  };
  // Approving RE-OPENS password sign-in for a whole organization, so it is confirmed; rejecting
  // only leaves the safe state in place and is not.
  host.querySelectorAll('[data-sso-approve]').forEach((b) => b.addEventListener('click', () => {
    if (window.confirm(t('admin.sso_only.confirm'))) decide(b.dataset.ssoApprove, 'approve');
  }));
  host.querySelectorAll('[data-sso-reject]').forEach((b) => b.addEventListener('click', () => decide(b.dataset.ssoReject, 'reject')));
}

async function loadOrgs() {
  const el = document.getElementById('orgsTable');
  if (!el) return;
  let orgs;
  try {
    orgs = await api.adminListOrgs();
  } catch (err) {
    el.innerHTML = `<p style="color:var(--danger)">${esc(err.message || 'Failed to load organizations')}</p>`;
    return;
  }
  // #talk: the per-org Talk controls are only meaningful when the TALK_ENABLED master switch is on.
  // (The per-org flag gates on top of it, so with the master off the toggle would be a no-op.)
  let talkMaster = false;
  try { const s = await api.getServerStatus(); talkMaster = !!(s && s.features && s.features.talk); } catch (_) {}
  if (!orgs.length) {
    el.innerHTML = `<p style="color:var(--text-muted)">${t('admin.orgs.empty')}</p>`;
    return;
  }
  el.innerHTML = orgs.map(o => {
    const wsRows = (o.workspaces || []).map(w => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-top:1px solid var(--border)">
        <div style="font-size:13px">${esc(w.name)}
          <span style="color:var(--text-muted);font-size:11px">· ${w.device_count} ${t('admin.orgs.devices')} · ${w.member_count} ${t('admin.orgs.members')}</span>
        </div>
        <button class="btn btn-danger btn-sm" data-del-ws="${esc(w.id)}" data-ws-name="${esc(w.name)}">${t('admin.orgs.delete_ws')}</button>
      </div>`).join('');
    return `
      <div style="border:1px solid var(--border);border-radius:var(--radius);margin-bottom:10px">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg-secondary)">
          <div>
            <div style="font-weight:600">${esc(o.name)}</div>
            <div style="color:var(--text-muted);font-size:11px">
              ${t('admin.orgs.owner')}: ${esc(o.owner_email || '—')} ·
              ${o.workspace_count} ${t('admin.orgs.workspaces')} · ${o.device_count} ${t('admin.orgs.devices')} · ${o.member_count} ${t('admin.orgs.members')}
            </div>
          </div>
          <button class="btn btn-danger btn-sm" data-del-org="${esc(o.id)}" data-org-name="${esc(o.name)}">${t('admin.orgs.delete_org')}</button>
        </div>
        ${talkMaster ? `
        <div style="padding:10px 12px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:8px">
          <label style="display:flex;align-items:center;gap:8px;font-size:13px">
            <input type="checkbox" data-org-talk="${esc(o.id)}"${o.talk_enabled ? ' checked' : ''}>
            ${t('admin.orgs.talk_enable')}
          </label>
          <label style="font-size:12px;color:var(--text-muted)">${t('admin.orgs.talk_ice_label')}</label>
          <textarea data-org-ice="${esc(o.id)}" rows="2" placeholder='[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]'
            style="font-family:monospace;font-size:12px;width:100%;box-sizing:border-box">${esc(o.ice_servers || '')}</textarea>
          <div><button class="btn btn-secondary btn-sm" data-org-talk-save="${esc(o.id)}">${t('admin.orgs.talk_save')}</button></div>
        </div>` : ''}
        ${wsRows}
      </div>`;
  }).join('');

  if (talkMaster) el.querySelectorAll('[data-org-talk-save]').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.dataset.orgTalkSave;
    const enabled = el.querySelector(`[data-org-talk="${id}"]`)?.checked ? 1 : 0;
    const ice = (el.querySelector(`[data-org-ice="${id}"]`)?.value || '').trim();
    try {
      await api.adminSetOrgTalk(id, { talk_enabled: enabled, ice_servers: ice || null });
      showToast(t('admin.orgs.talk_saved'), 'success');
    } catch (e) { showToast((e && e.message) || t('admin.orgs.talk_save_failed'), 'error'); }
  }));

  el.querySelectorAll('[data-del-org]').forEach(btn => btn.addEventListener('click', () => {
    const id = btn.dataset.delOrg, name = btn.dataset.orgName;
    openTypeToConfirmModal({
      title: t('admin.orgs.delete_org_title'),
      body: t('admin.orgs.delete_org_body', { name: esc(name) }),
      expected: name,
      confirmLabel: t('admin.orgs.delete_org'),
      onConfirm: async () => {
        await api.adminDeleteOrg(id);
        showToast(t('admin.orgs.org_deleted', { name }), 'success');
        loadOrgs(); loadUsers();
      },
    });
  }));
  el.querySelectorAll('[data-del-ws]').forEach(btn => btn.addEventListener('click', () => {
    const id = btn.dataset.delWs, name = btn.dataset.wsName;
    openTypeToConfirmModal({
      title: t('admin.orgs.delete_ws_title'),
      body: t('admin.orgs.delete_ws_body', { name: esc(name) }),
      expected: name,
      confirmLabel: t('admin.orgs.delete_ws'),
      onConfirm: async () => {
        await api.adminDeleteWorkspace(id);
        showToast(t('admin.orgs.ws_deleted', { name }), 'success');
        loadOrgs();
      },
    });
  }));
}

// #15: instance-level default branding form (platform default; every workspace
// without its own white-label inherits this, as does the login page).
async function loadBranding() {
  const el = document.getElementById('brandingForm');
  if (!el) return;
  let b = {};
  try { b = await api.adminGetBranding(); } catch (e) { el.innerHTML = `<p style="color:var(--danger)">${esc(e.message || 'Failed to load')}</p>`; return; }
  const v = (x) => esc(x == null ? '' : x);
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;max-width:640px">
      <div class="form-group" style="grid-column:1/-1"><label>${t('admin.branding.brand_name')}</label><input type="text" id="brBrandName" class="input" placeholder="ScreenTinker" value="${v(b.brand_name)}"></div>
      <div class="form-group"><label>${t('admin.branding.primary_color')}</label><input type="text" id="brPrimary" class="input" placeholder="#3B82F6" value="${v(b.primary_color)}"></div>
      <div class="form-group"><label>${t('admin.branding.bg_color')}</label><input type="text" id="brBg" class="input" placeholder="#111827" value="${v(b.bg_color)}"></div>
      <div class="form-group" style="grid-column:1/-1"><label>${t('admin.branding.logo_url')}</label><input type="text" id="brLogo" class="input" placeholder="https://…/logo.png" value="${v(b.logo_url)}"></div>
      <div class="form-group" style="grid-column:1/-1"><label>${t('admin.branding.favicon_url')}</label><input type="text" id="brFavicon" class="input" placeholder="https://…/favicon.ico" value="${v(b.favicon_url)}"></div>
      <div class="form-group" style="grid-column:1/-1"><label>${t('admin.branding.custom_css')}</label><textarea id="brCss" class="input" rows="3" placeholder="/* optional */">${v(b.custom_css)}</textarea></div>
      <label style="grid-column:1/-1;display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
        <input type="checkbox" id="brHide" ${b.hide_branding ? 'checked' : ''}> ${t('admin.branding.hide_branding')}
      </label>
    </div>
    <button class="btn btn-primary btn-sm" id="brSave" style="margin-top:12px">${t('admin.branding.save')}</button>
  `;
  document.getElementById('brSave').onclick = async () => {
    try {
      await api.adminSetBranding({
        brand_name: document.getElementById('brBrandName').value.trim() || 'ScreenTinker',
        primary_color: document.getElementById('brPrimary').value.trim() || null,
        bg_color: document.getElementById('brBg').value.trim() || null,
        logo_url: document.getElementById('brLogo').value.trim() || null,
        favicon_url: document.getElementById('brFavicon').value.trim() || null,
        custom_css: document.getElementById('brCss').value.trim() || null,
        hide_branding: document.getElementById('brHide').checked,
      });
      showToast(t('admin.branding.saved'), 'success');
    } catch (err) { showToast(err.message, 'error'); }
  };
}

async function loadUsers() {
  const el = document.getElementById('allUsersTable');
  try {
    const [users, plans] = await Promise.all([
      API('/auth/users'),
      fetch('/api/subscription/plans').then(r => r.json()),
    ]);
    const currentUser = JSON.parse(localStorage.getItem('user') || '{}');

    el.innerHTML = `
      <div class="table-wrap">
      <table style="width:100%;border-collapse:collapse;font-size:13px;min-width:720px">
        <thead><tr style="border-bottom:1px solid var(--border)">
          <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('admin.col.user')}</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('admin.col.auth')}</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('admin.col.last_login')}</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('admin.col.role')}</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('admin.col.plan')}</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('admin.col.workspace')}</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('admin.col.actions')}</th>
        </tr></thead>
        <tbody>
          ${users.map(u => `
            <tr style="border-bottom:1px solid var(--border)">
              <!-- ESCAPED: these come from self-registration and from an identity provider's
                   email claim, so they are attacker-chosen. A reviewer registered an address whose
                   local part was an img tag with an onerror handler, anonymously, and got script
                   execution in the PLATFORM ADMIN's session on this page - the very page operators
                   are now emailed to. Note backticks are illegal here: this sits inside a template
                   literal. -->
              <td style="padding:8px"><div style="font-weight:500">${esc(u.name || u.email)}</div><div style="font-size:11px;color:var(--text-muted)">${esc(u.email)}</div></td>
              <td style="padding:8px"><span style="background:var(--bg-primary);padding:2px 8px;border-radius:10px;font-size:11px">${esc(u.auth_provider)}</span></td>
              <td style="padding:8px;font-size:11px;color:var(--text-muted)">${u.last_login ? new Date(u.last_login * 1000).toLocaleString() : t('common.never')}</td>
              <td style="padding:8px">
                <select class="input" style="max-width:120px;width:100%;background:var(--bg-input);font-size:12px;padding:4px" data-role-user="${esc(u.id)}">
                  ${PLATFORM_ROLE_OPTIONS.map(r => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${t('admin.role.' + r)}</option>`).join('')}
                </select>
              </td>
              <td style="padding:8px">
                <select class="input" style="max-width:130px;width:100%;background:var(--bg-input);font-size:12px;padding:4px" data-plan-user="${u.id}">
                  ${plans.map(p => `<option value="${p.id}" ${u.plan_id === p.id ? 'selected' : ''}>${esc(p.display_name)}</option>`).join('')}
                </select>
              </td>
              ${workspaceCell(u)}
              <td style="padding:8px;white-space:nowrap">
                ${u.auth_provider === 'local' && u.id !== currentUser.id ? `<button class="btn btn-secondary btn-sm" data-reset-pw-user="${esc(u.id)}" data-user-email="${esc(u.email)}" style="margin-right:4px">${t('admin.reset_password')}</button>` : ''}
                ${!isPlatformAdmin(u) ? `<button class="btn btn-danger btn-sm" data-delete-user="${u.id}">${t('admin.remove')}</button>` : `<span style="color:var(--text-muted);font-size:11px">${t('admin.owner')}</span>`}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      </div>
      <p style="color:var(--text-muted);font-size:11px;margin-top:8px">${t('admin.total_users', { n: users.length })}</p>
    `;

    el.querySelectorAll('[data-role-user]').forEach(select => {
      select.onchange = async () => {
        try {
          await API(`/auth/users/${select.dataset.roleUser}/role`, { method: 'PUT', body: JSON.stringify({ role: select.value }) });
          showToast(t('admin.toast.role_updated'), 'success');
        } catch (err) { showToast(err.message, 'error'); loadUsers(); }
      };
    });

    el.querySelectorAll('[data-plan-user]').forEach(select => {
      select.onchange = async () => {
        try {
          await API('/subscription/assign', { method: 'POST', body: JSON.stringify({ user_id: select.dataset.planUser, plan_id: select.value }) });
          showToast(t('admin.toast.plan_updated'), 'success');
        } catch (err) { showToast(err.message, 'error'); loadUsers(); }
      };
    });

    // Manage workspaces: open the per-user membership modal (add/remove
    // workspaces, set per-workspace role). Refresh the table on close only if
    // something changed (the modal calls onClose then).
    el.querySelectorAll('[data-ws-manage]').forEach(btn => {
      btn.onclick = () => {
        const u = users.find(x => x.id === btn.dataset.wsManage);
        if (!u) return;
        openManageWorkspacesModal(u, { onClose: () => loadUsers() });
      };
    });

    // Reset password handlers
    el.querySelectorAll('[data-reset-pw-user]').forEach(btn => {
      btn.onclick = async () => {
        const email = btn.dataset.userEmail;
        const pw = prompt(t('admin.prompt_reset_password', { email }));
        if (pw === null) return;
        if (pw.length < 8) { showToast(t('admin.toast.password_min_8'), 'error'); return; }
        try {
          await api.resetUserPassword(btn.dataset.resetPwUser, pw);
          showToast(t('admin.toast.password_reset'), 'success');
        } catch (err) { showToast(err.message, 'error'); }
      };
    });

    el.querySelectorAll('[data-delete-user]').forEach(btn => {
      let confirming = false;
      btn.onclick = async () => {
        if (confirming) {
          try { await api.deleteUser(btn.dataset.deleteUser); showToast(t('admin.toast.user_removed'), 'success'); loadUsers(); }
          catch (err) { showToast(err.message, 'error'); }
          return;
        }
        confirming = true; btn.textContent = t('admin.confirm'); btn.style.background = 'var(--danger)'; btn.style.color = 'white';
        setTimeout(() => { confirming = false; btn.textContent = t('admin.remove'); btn.style.background = ''; btn.style.color = ''; }, 3000);
      };
    });
  } catch (err) { el.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`; }
}

// #146: toggle /api/status debug-metrics exposure. Mirrors loadBranding's
// load-then-save pattern; takes effect on the next status poll (no restart).
async function loadStatusDebug() {
  const el = document.getElementById('statusDebugForm');
  if (!el) return;
  let enabled = false;
  try { enabled = (await api.adminGetStatusDebug()).enabled; }
  catch (e) { el.innerHTML = `<p style="color:var(--danger)">${esc(e.message || 'Failed to load')}</p>`; return; }
  el.innerHTML = `
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
      <input type="checkbox" id="statusDebugChk" ${enabled ? 'checked' : ''}> Expose /api/status debug metrics
    </label>
    <p style="color:var(--text-muted);font-size:12px;margin:4px 0 0 24px">Adds internal limiter/prune/OTA counters to the public status endpoint. Off by default.</p>
  `;
  document.getElementById('statusDebugChk').onchange = async (e) => {
    const chk = e.target;
    chk.disabled = true;
    try { await api.adminSetStatusDebug(chk.checked); showToast('Status debug ' + (chk.checked ? 'enabled' : 'disabled'), 'success'); }
    catch (err) { showToast(err.message, 'error'); chk.checked = !chk.checked; }
    finally { chk.disabled = false; }
  };
}

async function loadPlans() {
  const el = document.getElementById('plansTable');
  try {
    // Admin endpoint, not /api/subscription/plans: that one filters `active = 1` because it feeds
    // the pricing page, so a deliberately hidden plan (a comped or beta tier) was invisible to the
    // operator too. Here we want every plan, plus who is actually on each one.
    const { plans, orphaned } = await api.adminListPlans();
    el.innerHTML = `
      <div class="table-wrap">
      <table style="width:100%;border-collapse:collapse;font-size:13px;min-width:500px">
        <thead><tr style="border-bottom:1px solid var(--border)">
          <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('admin.col.plan')}</th>
          <th style="padding:8px;text-align:right;color:var(--text-muted)">${t('admin.col.devices')}</th>
          <th style="padding:8px;text-align:right;color:var(--text-muted)">${t('admin.col.storage')}</th>
          <th style="padding:8px;text-align:right;color:var(--text-muted)">${t('admin.col.monthly')}</th>
          <th style="padding:8px;text-align:right;color:var(--text-muted)">${t('admin.col.yearly')}</th>
          <th style="padding:8px;text-align:right;color:var(--text-muted)">${t('admin.col.accounts')}</th>
          <th style="padding:8px;text-align:right;color:var(--text-muted)">${t('admin.col.screens')}</th>
        </tr></thead>
        <tbody>
          ${plans.map(p => `
            <tr style="border-bottom:1px solid var(--border)${p.active ? '' : ';opacity:.7'}">
              <td style="padding:8px;font-weight:500">${esc(p.display_name)}
                <span style="color:var(--text-muted);font-weight:400;font-size:11px">${esc(p.id)}</span>
                ${p.active ? '' : `<span style="margin-left:6px;font-size:10px;padding:1px 6px;border:1px solid var(--border);border-radius:8px;color:var(--text-muted)">${t('admin.plan_hidden')}</span>`}
              </td>
              <td style="padding:8px;text-align:right">${p.max_devices === -1 ? t('admin.unlimited') : p.max_devices}</td>
              <td style="padding:8px;text-align:right">${p.max_storage_mb === -1 ? t('admin.unlimited') : p.max_storage_mb >= 1024 ? (p.max_storage_mb/1024)+'GB' : p.max_storage_mb+'MB'}</td>
              <td style="padding:8px;text-align:right">${p.price_monthly > 0 ? '$'+p.price_monthly : t('admin.free')}</td>
              <td style="padding:8px;text-align:right">${p.price_yearly > 0 ? '$'+p.price_yearly : '-'}</td>
              <td style="padding:8px;text-align:right${p.user_count ? ';font-weight:500' : ';color:var(--text-muted)'}">${p.user_count}</td>
              <td style="padding:8px;text-align:right;color:var(--text-muted)">${p.device_count}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      </div>
      ${(orphaned && orphaned.length) ? `
        <p style="margin-top:10px;color:var(--danger);font-size:12px">
          ${t('admin.plan_orphaned')}: ${orphaned.map(o => `<strong>${esc(o.plan_id)}</strong> (${o.user_count})`).join(', ')}
        </p>` : ''}
    `;
  } catch (err) { el.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`; }
}

async function loadSystem() {
  const el = document.getElementById('systemInfo');
  try {
    const version = await fetch('/api/version').then(r => r.json());
    const token = localStorage.getItem('token');

    const versionComparison = version.latest_version
      ? `<div class="info-card">
           <div class="info-card-label">${t('admin.latest_version')}</div>
           <div class="info-card-value small">${esc(version.latest_version)}</div>
         </div>
         <div class="info-card">
           <div class="info-card-label">${t('admin.status')}</div>
           <div class="info-card-value small" style="color:${version.update_available ? 'var(--warning)' : 'var(--success)'}">${version.update_available ? (t('admin.update_available')) : (t('admin.up_to_date'))}</div>
         </div>`
      : `<div class="info-card">
           <div class="info-card-label">${t('admin.latest_version')}</div>
           <div class="info-card-value small" style="color:var(--text-muted)">${t('admin.checking')}</div>
         </div>`;

    el.innerHTML = `
      <div class="info-grid">
        <div class="info-card"><div class="info-card-label">${t('admin.version')}</div><div class="info-card-value small">${esc(version.version)}</div></div>
        ${versionComparison}
      </div>
      <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
        <button class="btn btn-secondary btn-sm" id="checkUpdateBtn">${t('admin.check_now')}</button>
        <button class="btn btn-primary btn-sm" id="triggerUpdateBtn"${!version.update_available ? ' style="display:none"' : ''}>${t('admin.update_now')}</button>
        <a href="/api/status/backup?token=${token}" class="btn btn-secondary btn-sm" style="text-decoration:none">${t('admin.download_db_backup')}</a>
        <a href="/api/status" target="_blank" class="btn btn-secondary btn-sm" style="text-decoration:none">${t('admin.server_status')}</a>
      </div>
      <div id="updateResult" style="margin-top:12px"></div>
    `;

    // Check Now button
    document.getElementById('checkUpdateBtn')?.addEventListener('click', async () => {
      const btn = document.getElementById('checkUpdateBtn');
      btn.disabled = true;
      btn.textContent = t('admin.checking');
      try {
        const res = await fetch('/api/admin/check-update', { method: 'POST', headers: headers() });
        const data = await res.json();
        const updBtn = document.getElementById('triggerUpdateBtn');
        if (data.update_available && updBtn) {
          updBtn.style.display = '';
        }
        loadSystem(); // refresh the whole card
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = t('admin.check_now');
      }
    });

    // Update Now button
    document.getElementById('triggerUpdateBtn')?.addEventListener('click', async () => {
      const btn = document.getElementById('triggerUpdateBtn');
      const resultEl = document.getElementById('updateResult');
      btn.disabled = true;
      btn.textContent = t('admin.updating');
      try {
        const res = await fetch('/api/admin/trigger-update', { method: 'POST', headers: headers() });
        const data = await res.json();
        if (data.docker_enabled) {
          // Docker executed — show output with Copy button
          resultEl.innerHTML = `
            <div style="margin-top:12px;border:1px solid var(--border);border-radius:var(--radius);padding:12px;background:var(--bg-card)">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <strong style="font-size:13px">${data.success ? (t('admin.update_success')) : (t('admin.update_failed'))}</strong>
                <button class="btn btn-secondary btn-sm" id="copyOutputBtn">${t('admin.copy')}</button>
              </div>
              <pre style="max-height:300px;overflow:auto;font-size:11px;margin:0;background:var(--bg-primary);padding:8px;border-radius:4px;white-space:pre-wrap;word-break:break-all">${esc(data.output || '')}</pre>
            </div>`;
          document.getElementById('copyOutputBtn')?.addEventListener('click', () => {
            const pre = resultEl.querySelector('pre');
            const text = pre ? pre.textContent : '';
            if (navigator.clipboard) {
              navigator.clipboard.writeText(text).then(() => showToast(t('admin.copied'), 'success'));
            } else {
              // Fallback for older browsers
              const ta = document.createElement('textarea');
              ta.value = text;
              ta.style.position = 'fixed';
              ta.style.opacity = '0';
              document.body.appendChild(ta);
              ta.select();
              document.execCommand('copy');
              document.body.removeChild(ta);
              showToast(t('admin.copied'), 'success');
            }
          });
        } else if (data.instructions) {
          // Docker disabled — show manual instructions with Copy button
          resultEl.innerHTML = `
            <div style="margin-top:12px;border:1px solid var(--border);border-radius:var(--radius);padding:12px;background:var(--bg-secondary)">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <strong style="font-size:13px">${t('admin.manual_update')}</strong>
                <button class="btn btn-secondary btn-sm" id="copyCmdBtn">${t('admin.copy_command')}</button>
              </div>
              <p style="font-size:12px;color:var(--text-muted);margin-bottom:8px">${t('admin.manual_update_desc')}</p>
              <pre style="font-size:11px;margin:0;background:var(--bg-primary);padding:8px;border-radius:4px;white-space:pre-wrap;word-break:break-all">${esc(data.instructions)}</pre>
            </div>`;
          document.getElementById('copyCmdBtn')?.addEventListener('click', () => {
            const pre = resultEl.querySelector('pre');
            const text = pre ? pre.textContent : '';
            if (navigator.clipboard) {
              navigator.clipboard.writeText(text).then(() => showToast(t('admin.copied'), 'success'));
            } else {
              const ta = document.createElement('textarea');
              ta.value = text;
              ta.style.position = 'fixed';
              ta.style.opacity = '0';
              document.body.appendChild(ta);
              ta.select();
              document.execCommand('copy');
              document.body.removeChild(ta);
              showToast(t('admin.copied'), 'success');
            }
          });
        }
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = t('admin.update_now');
      }
    });
  } catch (err) { el.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`; }
}

export function cleanup() {}


/* ------------------------------------------------------------------ server diagnostics */

const num = (n) => (n == null ? '—' : Number(n).toLocaleString());
const mb = (b) => (b == null ? '—' : `${(b / 1048576).toFixed(1)} MB`);

/*
 * ⚠️ THE POINT OF THIS SCREEN. Diagnosing a slow install used to mean sending someone a shell
 * script and talking them through running it as root on production. Every number here was already
 * being recorded — the loop-lag table gets a row a second and had never been read back — so this is
 * mostly a matter of showing what the server already knows.
 */
async function loadDiagnostics() {
  const el = document.getElementById('diagBody');
  if (!el) return;
  el.innerHTML = `<p style="color:var(--text-muted)">${t('common.loading')}</p>`;
  let shape; let lag;
  try {
    [shape, lag] = await Promise.all([api.adminDiagShape(), api.adminDiagLag(14)]);
  } catch (e) {
    el.innerHTML = `<p style="color:var(--danger)">${esc(e.message || 'Failed to load diagnostics')}</p>`;
    return;
  }

  const live = lag.live || {};
  const bandColour = live.band === 'critical' ? 'var(--danger)' : live.band === 'elevated' ? 'var(--warning, #f59e0b)' : 'var(--success, #10b981)';

  /*
   * The daily trend first, because it answers the question that actually starts an investigation:
   * did this step up on a date? That turns "why is the server slow" into "what changed on the 14th".
   */
  const daily = (lag.daily || []).map((d) => `
    <tr><td>${esc(d.day)}</td><td>${num(d.samples)}</td><td>${num(d.avg_p50)}</td>
        <td style="color:${d.avg_p99 >= 100 ? 'var(--danger)' : 'inherit'}">${num(d.avg_p99)}</td>
        <td>${num(d.worst)}</td><td>${d.samples ? Math.round((100 * d.not_normal) / d.samples) : 0}%</td></tr>`).join('');

  const tables = (shape.tables || []).filter((r) => r.rows > 0).slice(0, 12)
    .map((r) => `<tr><td>${esc(r.table)}</td><td>${num(r.rows)}</td></tr>`).join('');

  el.innerHTML = `
    <div style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:16px">
      <div><div style="font-size:11px;color:var(--text-muted)">${t('admin.diag.band')}</div>
           <div style="font-size:20px;font-weight:700;color:${bandColour}">${esc(live.band || '—')}</div></div>
      <div><div style="font-size:11px;color:var(--text-muted)">sustained p99</div>
           <div style="font-size:20px;font-weight:700">${num(Math.round(live.sustained_p99_ms || 0))} ms</div></div>
      <div><div style="font-size:11px;color:var(--text-muted)">database</div>
           <div style="font-size:20px;font-weight:700">${mb((shape.db || {}).path_bytes)}</div></div>
      <div><div style="font-size:11px;color:var(--text-muted)">displays</div>
           <div style="font-size:20px;font-weight:700">${num((shape.devices || {}).online)} / ${num((shape.devices || {}).total)}</div></div>
    </div>

    <h4 style="margin:12px 0 6px">${t('admin.diag.lag_daily')}</h4>
    <div style="overflow-x:auto"><table class="data-table"><thead><tr>
      <th>day</th><th>samples</th><th>avg p50</th><th>avg p99</th><th>worst</th><th>not normal</th>
    </tr></thead><tbody>${daily || `<tr><td colspan="6">${t('admin.diag.no_history')}</td></tr>`}</tbody></table></div>

    <h4 style="margin:16px 0 6px">${t('admin.diag.shape')}</h4>
    <div style="display:flex;gap:24px;flex-wrap:wrap;font-size:13px;margin-bottom:8px">
      <span>plays: <b>${num((shape.play_logs || {}).total)}</b> (${num((shape.play_logs || {}).still_open)} open)</span>
      <span>largest playlist payload: <b>${mb((shape.assigned_playlists || {}).max_snapshot_bytes)}</b></span>
      <span>largest widget config: <b>${mb((shape.widgets || {}).max_config_bytes)}</b></span>
      <span>workspaces: <b>${num(shape.workspaces)}</b></span>
    </div>
    <div style="overflow-x:auto"><table class="data-table"><thead><tr><th>table</th><th>rows</th></tr></thead>
      <tbody>${tables}</tbody></table></div>
    <div id="diagProfileOut"></div>`;
}

let lastProfile = null;

function wireDiagnostics() {
  const refresh = document.getElementById('diagRefreshBtn');
  if (refresh) refresh.addEventListener('click', loadDiagnostics);

  const dl = document.getElementById('diagDownloadBtn');
  if (dl) dl.addEventListener('click', () => {
    if (!lastProfile) return;
    /*
     * A .cpuprofile is what DevTools opens directly (Performance -> Load profile), which is the
     * whole reason to hand back the raw profile as well as the summary: the table says WHERE, the
     * file lets somebody see the call tree around it.
     */
    const blob = new Blob([JSON.stringify(lastProfile)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `screentinker-${new Date().toISOString().replace(/[:.]/g, '-')}.cpuprofile`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  const btn = document.getElementById('diagProfileBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const secs = Number(document.getElementById('diagProfileSecs').value) || 30;
    const out = document.getElementById('diagProfileOut');
    btn.disabled = true;
    const original = btn.textContent;
    // It is supposed to take this long; say so, or it reads as a hung button.
    btn.textContent = t('admin.diag.profiling', { seconds: secs });
    if (out) out.innerHTML = `<p style="color:var(--text-muted);margin-top:12px">${t('admin.diag.profiling_note')}</p>`;
    try {
      const r = await api.adminDiagProfile(secs);
      lastProfile = r.profile;
      const rows = (r.top || []).map((x) => `
        <tr><td style="text-align:right">${x.pct}%</td><td>${esc(x.fn)}</td><td style="color:var(--text-muted)">${esc(x.at)}</td></tr>`).join('');
      if (out) out.innerHTML = `
        <h4 style="margin:16px 0 6px">${t('admin.diag.top_self')}</h4>
        <div style="overflow-x:auto"><table class="data-table"><thead><tr>
          <th>self</th><th>function</th><th>where</th></tr></thead><tbody>${rows}</tbody></table></div>`;
      const d = document.getElementById('diagDownloadBtn');
      if (d) d.style.display = '';
      showToast(t('admin.diag.profile_done'), 'success');
    } catch (e) {
      if (out) out.innerHTML = `<p style="color:var(--danger);margin-top:12px">${esc(e.message || 'Profile failed')}</p>`;
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
}
