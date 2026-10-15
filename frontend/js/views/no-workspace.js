// #12: empty state for a signed-in user who belongs to zero workspaces. Happens
// on deployments with AUTO_CREATE_ORG_ON_SIGNUP=false, where a self-service
// signup is created org-less and an admin/operator assigns them to a workspace
// afterward. Without this, such a user would be bounced into onboarding (whose
// device-pairing step needs a workspace) - a broken flow. Here they get a clear
// "ask your admin" message instead.
import { t } from '../i18n.js';

export function render(container) {
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px">
      <div style="width:440px;max-width:100%;text-align:center">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.6" style="margin:0 auto 16px">
          <rect x="3" y="4" width="18" height="14" rx="2"/>
          <path d="M3 9h18"/>
        </svg>
        <h1 style="font-size:20px;font-weight:700;margin-bottom:8px">${t('noworkspace.title')}</h1>
        <p style="color:var(--text-secondary);font-size:14px;line-height:1.6;margin-bottom:24px">${t('noworkspace.body')}</p>
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
}

export function cleanup() {}
