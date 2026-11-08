// #12: empty state for a signed-in user who belongs to zero workspaces. Happens
// on deployments with AUTO_CREATE_ORG_ON_SIGNUP=false, where a self-service
// signup is created org-less and an admin/operator assigns them to a workspace
// afterward. Without this, such a user would be bounced into onboarding (whose
// device-pairing step needs a workspace) - a broken flow. Here they get a clear
// "ask your admin" message instead.
//
// Also where an INVITED signup lands when the invite was not accepted on the way in (opened in
// another browser, or never asked for): an invited signup gets no workspace of its own
// (server routes/auth.js ensureDefaultOrgForUser). Their invites are listed to accept here, and,
// wherever signups get a workspace at all, "Create my own workspace" is always offered, so an
// unwanted invite can never keep anyone out.
import { t } from '../i18n.js';
import { api } from '../api.js';
import { esc } from '../utils.js';
import { markWorkspaceJoined } from '../workspace-joined.js';

export function render(container) {
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px">
      <div style="width:440px;max-width:100%;text-align:center">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.6" style="margin:0 auto 16px">
          <rect x="3" y="4" width="18" height="14" rx="2"/>
          <path d="M3 9h18"/>
        </svg>
        <h1 style="font-size:20px;font-weight:700;margin-bottom:8px">${t('noworkspace.title')}</h1>
        <p id="noWsBody" style="color:var(--text-secondary);font-size:14px;line-height:1.6;margin-bottom:24px">${t('noworkspace.body')}</p>
        <div id="noWsInvites" style="text-align:left"></div>
        <div id="noWsOwn" style="display:none;margin-bottom:16px">
          <button class="btn btn-secondary" id="noWsCreateOwn" style="padding:8px 16px">${t('noworkspace.create_own')}</button>
        </div>
        <button class="btn btn-secondary" id="noWsSignOut" style="padding:8px 16px">${t('noworkspace.sign_out')}</button>
        <p style="margin-top:16px;font-size:12px"><a href="#/delete-account" style="color:var(--text-muted)">${t('account_delete.menu')}</a></p>
      </div>
    </div>
  `;
  container.querySelector('#noWsSignOut').addEventListener('click', () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.hash = '#/login';
    window.location.reload();
  });
  loadInvites(container);
}

async function loadInvites(container) {
  let data;
  try { data = await api.getMyInvites(); } catch { return; }   // older server: the plain message stays
  if (!container.isConnected) return;
  const list = (data && data.invites) || [];
  const box = container.querySelector('#noWsInvites');
  if (list.length) {
    container.querySelector('#noWsBody').textContent = t('noworkspace.invited_body');
    box.innerHTML = list.map((i) => `
      <div style="display:flex;align-items:center;gap:12px;border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;overflow-wrap:anywhere">${esc(i.workspace_name || '')}${i.organization_name ? ` <span style="color:var(--text-muted);font-weight:400">· ${esc(i.organization_name)}</span>` : ''}</div>
          ${i.invited_by_email ? `<div style="color:var(--text-secondary);font-size:12px;overflow-wrap:anywhere">${esc(t('noworkspace.invited_by', { email: i.invited_by_email }))}</div>` : ''}
        </div>
        <button class="btn btn-primary" data-invite="${esc(i.id)}" style="padding:6px 14px;flex-shrink:0">${t('noworkspace.accept')}</button>
      </div>`).join('');
    box.querySelectorAll('[data-invite]').forEach((b) => b.addEventListener('click', () => {
      // The authed #/accept-invite route accepts, switches into the workspace and reloads (app.js).
      window.location.hash = '#/accept-invite/' + encodeURIComponent(b.dataset.invite);
    }));
  }
  if (data && data.can_create_own) {
    container.querySelector('#noWsOwn').style.display = '';
    if (!list.length) container.querySelector('#noWsBody').textContent = t('noworkspace.own_body');
    const btn = container.querySelector('#noWsCreateOwn');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const r = await api.createOwnWorkspace();
        if (r && r.token) localStorage.setItem('token', r.token);
        markWorkspaceJoined(r && r.current_workspace_id);
        history.replaceState(null, '', window.location.pathname + '#/');
        window.location.reload();
      } catch (e) {
        btn.disabled = false;
        const { showToast } = await import('../components/toast.js');
        showToast(e.message || t('noworkspace.create_failed'), 'error');
      }
    });
  }
}

export function cleanup() {}
