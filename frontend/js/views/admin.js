import { api } from '../api.js';
import { mountPromotionsAdmin } from '../components/promotions-admin.js';
import { showToast } from '../components/toast.js';
import { esc, isPlatformAdmin } from '../utils.js';
import { t, tn } from '../i18n.js';
import { pluginFieldsHtml, readPluginFields } from '../lib/plugin-fields.js';
import { openAddUserModal } from '../components/workspace-members-add-user-modal.js';
import { openManageWorkspacesModal } from '../components/admin-user-workspaces-modal.js';
import { openCreateOrgModal } from '../components/admin-create-org-modal.js';
import { openTypeToConfirmModal } from '../components/type-to-confirm-modal.js';
// Reuse the members view's server-error -> friendly-string mapper (handles the
// 409 duplicate-email / weak-password / invalid-email cases) so we don't fork a
// second mapper.
import { mapMutationError } from './workspace-members.js';
import { mountInstanceStorage } from '../components/storage-settings.js';

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

export async function render(container, section = 'overview') {
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  if (!isPlatformAdmin(user)) {
    container.innerHTML = `<div class="empty-state"><h3>${t('admin.access_denied')}</h3><p>${t('admin.access_denied_desc')}</p></div>`;
    return;
  }

  // #/admin (bookmarks, old emails) lands on the overview. app.js routes #/platform/<section> here.
  const def = SECTIONS[section] ? SECTIONS[section] : SECTIONS.overview;
  const current = SECTIONS[section] ? section : 'overview';

  container.innerHTML = `
    <div class="page-header">
      <div><h1>${esc(t(def.title))}</h1><div class="subtitle">${esc(t(def.subtitle))}</div></div>
      <div style="display:flex;gap:8px">${def.actions ? def.actions() : ''}</div>
    </div>
    <nav class="platform-tabs" aria-label="${esc(t('platform.nav_label'))}">
      ${Object.entries(SECTIONS).map(([id, d]) => `<a href="#/platform/${id}" class="platform-tab${id === current ? ' active' : ''}"${id === current ? ' aria-current="page"' : ''}>${esc(t(d.tab))}</a>`).join('')}
    </nav>
    ${def.html()}
  `;
  def.load();
}

/*
 * The Platform area: one page per job instead of ten unrelated sections on one scroll.
 * Each entry renders ONLY its own markup and runs ONLY its own loaders, so opening Branding no
 * longer fires the diagnostics, plugin and user-table requests as well.
 * ⚠️ The section markup and loaders are the ones the single page used, moved, not rewritten:
 * every loader still finds its container by id, and returns quietly when that container is absent.
 */
const section = (title, desc, body) => `
    <div class="settings-section">
      <h3>${title}</h3>
      ${desc ? `<p style="color:var(--text-muted);font-size:12px;margin-bottom:12px">${desc}</p>` : ''}
      ${body}
    </div>`;
const loading = () => `<p style="color:var(--text-muted)">${t('common.loading')}</p>`;

const SECTIONS = {
  overview: {
    tab: 'platform.tab.overview', title: 'platform.overview.title', subtitle: 'platform.overview.subtitle',
    html: () => `<div id="platformOverview">${loading()}</div>`,
    load: () => loadOverview(),
  },
  users: {
    tab: 'platform.tab.users', title: 'platform.users.title', subtitle: 'platform.users.subtitle',
    actions: () => `<button class="btn btn-primary" id="adminAddUserBtn">${t('admin.add_user')}</button>`,
    html: () => section(t('admin.all_users'), '', `
      <div class="platform-filters">
        <input type="search" class="input" id="userSearch" placeholder="${esc(t('platform.users.search'))}" aria-label="${esc(t('platform.users.search'))}">
        <select class="input" id="userRoleFilter" aria-label="${esc(t('platform.users.role_filter'))}">
          <option value="">${esc(t('platform.users.role_all'))}</option>
          <option value="platform">${esc(t('platform.users.role_platform'))}</option>
          <option value="user">${esc(t('platform.users.role_user'))}</option>
        </select>
        <span class="platform-count" id="userCount"></span>
      </div>
      <div id="allUsersTable">${loading()}</div>`),
    load: () => { wireAddUser(); loadUsers(); },
  },
  orgs: {
    tab: 'platform.tab.orgs', title: 'platform.orgs.title', subtitle: 'platform.orgs.subtitle',
    actions: () => `<button class="btn btn-primary" id="adminCreateOrgBtn">${t('admin.create_org.button')}</button>`,
    html: () => `
    <div class="settings-section" id="ssoOnlySection" style="display:none">
      <h3>${t('admin.sso_only.title')}</h3>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px">${t('admin.sso_only.desc')}</p>
      <div id="ssoOnlyRequests"><p style="color:var(--text-muted)">${t('common.loading')}</p></div>
    </div>
${section(t('admin.orgs.title'), t('admin.orgs.desc'), `
      <div class="platform-filters">
        <input type="search" class="input" id="orgSearch" placeholder="${esc(t('platform.orgs.search'))}" aria-label="${esc(t('platform.orgs.search'))}">
        <span class="platform-count" id="orgCount"></span>
      </div>
      <div id="orgsTable">${loading()}</div>`)}`,
    load: () => { wireCreateOrg(); loadSsoOnlyRequests(); loadOrgs(); },
  },
  billing: {
    tab: 'platform.tab.billing', title: 'platform.billing.title', subtitle: 'platform.billing.subtitle',
    html: () => section(t('admin.plans'), '', `<div id="plansTable">${loading()}</div>`)
      + section(t('admin.promo.title'), t('admin.promo.desc'), `<div id="promotionsAdmin">${loading()}</div>`),
    load: () => { loadPlans(); mountPromotionsAdmin(document.getElementById('promotionsAdmin')); },
  },
  branding: {
    tab: 'platform.tab.branding', title: 'platform.branding.title', subtitle: 'platform.branding.subtitle',
    html: () => section(t('admin.branding.title'), t('admin.branding.desc'), `<div id="brandingForm">${loading()}</div>`),
    load: () => loadBranding(),
  },
  rollouts: {
    tab: 'platform.tab.rollouts', title: 'platform.rollouts.title', subtitle: 'platform.rollouts.subtitle',
    html: () => section(t('platform.rollouts.title'), t('platform.rollouts.desc'), `<div id="rolloutsBody">${loading()}</div>`),
    load: () => loadRollouts(),
  },
  system: {
    tab: 'platform.tab.system', title: 'platform.system.title', subtitle: 'platform.system.subtitle',
    html: () => `
      ${section(t('admin.system'), '', `<div id="systemInfo">${loading()}</div>`)}
      ${section('Instance storage', '', `<div id="instanceStorage">${loading()}</div>`)}
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
      ${section(esc(t('platform.system.status_endpoint')), '', `<div id="statusDebugForm">${loading()}</div>`)}
      ${section(esc(t('platform.system.player_debug')), esc(t('platform.system.player_debug_desc')), `<a class="btn btn-secondary" href="#/admin/player-debug">${esc(t('platform.system.player_debug_open'))} &rarr;</a>`)}`,
    load: () => { loadSystem(); mountInstanceStorage(document.getElementById('instanceStorage')); loadDiagnostics(); wireDiagnostics(); loadStatusDebug(); },
  },
  cleanup: {
    tab: 'platform.tab.cleanup', title: 'platform.cleanup.title', subtitle: 'platform.cleanup.subtitle',
    html: () => `<div id="cleanupPane">${loading()}</div>`,
    load: () => mountCleanup(document.getElementById('cleanupPane')),
  },
  plugins: {
    tab: 'platform.tab.plugins', title: 'platform.plugins.title', subtitle: 'platform.plugins.subtitle',
    html: () => `
    <div class="settings-section" id="pluginsSection" style="display:none">
      <h3>${t('admin.plugins.title')}</h3>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px">${t('admin.plugins.desc')}</p>
      <form id="pluginUploadForm" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:16px">
        <input type="file" id="pluginZipInput" accept=".zip,application/zip" />
        <button type="submit" class="btn btn-primary btn-sm">${t('admin.plugins.upload_cta')}</button>
        <span style="color:var(--text-muted);font-size:12px">${t('admin.plugins.upload_hint')}</span>
      </form>
      <h4 style="margin:16px 0 8px;font-size:13px">${t('admin.plugins.pending')}</h4>
      <div id="pluginSubmissions"><p style="color:var(--text-muted)">${t('common.loading')}</p></div>
      <h4 style="margin:16px 0 8px;font-size:13px">${t('admin.plugins.title')}</h4>
      <div id="pluginsTable"><p style="color:var(--text-muted)">${t('common.loading')}</p></div>
      <h4 style="margin:16px 0 8px;font-size:13px">${t('admin.plugins.allowlist_title')}</h4>
      <div id="pluginAllowlist"><p style="color:var(--text-muted)">${t('common.loading')}</p></div>
    </div>
      <p class="platform-empty" id="pluginsOff" hidden>${esc(t('platform.plugins.off'))}</p>`,
    load: () => loadPlugins(),
  },
};

// Add User (#10): platform admin provisions a user into ANY workspace. The modal opens in picker
// mode (no fixed workspace) so the admin chooses the target org/workspace. The endpoint
// additionally enforces canAdminWorkspace (platform_admin passes everywhere).
function wireAddUser() {
  document.getElementById('adminAddUserBtn')?.addEventListener('click', () => {
    openAddUserModal(null, {
      onSuccess: (result) => {
        showToast(t('members.success.user_created', { email: result.email }), 'success');
        loadUsers();
      },
      mapError: mapMutationError,
    });
  });
}

// Create Organization (#35): platform admin provisions a new customer org + its first workspace
// (owned by the admin). The modal reloads on success so the new org shows up in the switcher.
function wireCreateOrg() {
  document.getElementById('adminCreateOrgBtn')?.addEventListener('click', () => {
    openCreateOrgModal({
      onSuccess: (result) => showToast(t('admin.create_org.success', { name: result.name }), 'success'),
    });
  });
}

/*
 * Overview: the numbers an operator checks first, and a list of what needs them — the SSO-only
 * removal requests (a tenant is locked out while one waits), plugin submissions, an available
 * update. Each item links to the page that deals with it. Server: GET /api/admin/overview.
 */
function formatBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

/*
 * One expanded "Needs your attention" item: what exactly is wrong, and a link to where it is fixed.
 * Every value is escaped: organization names, emails and screen names are customer-chosen.
 */
async function loadAttentionDetail(d) {
  const body = d.querySelector('.att-body');
  const item = d.dataset.item;
  const go = (label) => `<a class="att-go" href="${body.dataset.href}">${esc(label)} &rarr;</a>`;
  const ago = (sec) => (sec ? relAgo(sec) : t('platform.att.never'));
  const table = (heads, rows) => rows.length ? `<div class="table-wrap"><table class="att-table"><thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : `<p class="platform-empty">${esc(t('platform.att.nothing_now'))}</p>`;
  let r;
  try { r = await api.adminAttention(item); } catch (err) { body.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`; return; }
  switch (item) {
    case 'sso':
      body.innerHTML = `<p class="att-why">${esc(t('platform.att.sso_why'))}</p>` +
        table([t('platform.att.col_org'), t('platform.att.col_requested_by'), t('platform.att.col_reason'), t('platform.att.col_waiting')],
          r.rows.map((x) => [esc(x.organization || '—'), esc(x.requested_by || '—'), esc(x.reason || '—'), esc(ago(x.created_at))])) + go(t('platform.att.go_orgs'));
      break;
    case 'plugins':
      body.innerHTML = `<p class="att-why">${esc(t('platform.att.plugins_why'))}</p>` +
        table([t('platform.att.col_plugin'), t('platform.att.col_version'), t('platform.att.col_submitted_by'), t('platform.att.col_waiting')],
          r.rows.map((x) => [esc(x.name || x.plugin_id), esc(x.version || '—'), esc(x.submitted_by || '—'), esc(ago(x.submitted_at))])) + go(t('platform.att.go_plugins'));
      break;
    case 'update':
      body.innerHTML = `<p class="att-why">${esc(t('platform.att.update_why', { current: r.current, latest: r.latest || '?' }))}</p>` + go(t('platform.att.go_system'));
      break;
    case 'orphans':
      body.innerHTML = `<p class="att-why">${esc(t('platform.att.orphans_why'))}</p>` +
        table([t('platform.att.col_missing_plan'), t('platform.att.col_accounts'), t('platform.att.col_examples')],
          r.rows.map((x) => [`<code>${esc(x.plan_id)}</code>`, esc(String(x.accounts)), esc(x.emails)])) + go(t('platform.att.go_billing'));
      break;
    case 'offline':
      body.innerHTML = `<p class="att-why">${esc(t('platform.att.offline_why'))}</p>` +
        table([t('platform.att.col_screen'), t('platform.att.col_org'), t('platform.att.col_workspace'), t('platform.att.col_last_seen'), t('platform.att.col_app')],
          r.rows.map((x) => [esc(x.screen), esc(x.organization), esc(x.workspace), esc(ago(x.last_heartbeat)), esc(x.app_version || '—')])) + go(t('platform.att.go_orgs'));
      break;
    case 'stale': {
      const c = r.counts || {};
      body.innerHTML = `<p class="att-why">${esc(t('platform.att.stale_why', { a: c.not_warned || 0, b: c.notice || 0, c: c.ready || 0 }))}</p>` +
        table([t('platform.att.col_account'), t('platform.att.col_last_activity'), t('platform.att.col_notice'), t('platform.att.col_uploads')],
          r.rows.map((x) => [esc(x.email), esc(ago(x.last_activity)), esc(t(NOTICE_KEYS[x.notice] || NOTICE_KEYS.not_warned)), esc(x.content_bytes ? formatBytes(x.content_bytes) : '—')])) + go(t('platform.att.go_cleanup'));
      break;
    }
    default:
      body.innerHTML = go(t('platform.att.open'));
  }
}

const NOTICE_KEYS = {
  not_warned: 'platform.att.notice_not_warned',
  notice: 'platform.att.notice_notice',
  ready: 'platform.att.notice_ready',
};

function relAgo(sec) {
  const d = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  if (d < 3600) return t('platform.att.ago_min', { n: Math.max(1, Math.round(d / 60)) });
  if (d < 86400) return t('platform.att.ago_h', { n: Math.round(d / 3600) });
  return t('platform.att.ago_d', { n: Math.round(d / 86400) });
}

async function loadOverview() {
  const el = document.getElementById('platformOverview');
  if (!el) return;
  try {
    const o = await api.adminOverview();
    const card = (href, value, label, sub) => `
      <a class="platform-stat" href="${href}">
        <span class="platform-stat-n">${esc(String(value))}</span>
        <span class="platform-stat-l">${esc(label)}</span>
        ${sub ? `<span class="platform-stat-s">${esc(sub)}</span>` : ''}
      </a>`;
    const attention = [];
    if (o.sso_only_requests > 0) attention.push(['sso', '#/platform/orgs', tn('platform.overview.att_sso', o.sso_only_requests), 'warn']);
    if (o.plugin_submissions > 0) attention.push(['plugins', '#/platform/plugins', tn('platform.overview.att_plugins', o.plugin_submissions), 'info']);
    if (o.update_available) attention.push(['update', '#/platform/system', t('platform.overview.att_update', { v: o.latest_version }), 'info']);
    if (o.orphaned_plan_users > 0) attention.push(['orphans', '#/platform/billing', tn('platform.overview.att_orphans', o.orphaned_plan_users), 'warn']);
    if (o.stale_accounts_180d > 0) attention.push(['stale', '#/platform/cleanup', tn('platform.overview.att_stale', o.stale_accounts_180d), 'info']);
    if (o.screens_offline_24h > 0) attention.push(['offline', '#/platform/orgs', tn('platform.overview.att_offline', o.screens_offline_24h), 'info']);
    const mini = (href, value, label, sub) => `
      <a class="platform-mini" href="${href}">
        <span class="platform-mini-n">${esc(String(value))}</span>
        <span class="platform-mini-l">${esc(label)}</span>
        ${sub ? `<span class="platform-mini-s">${esc(sub)}</span>` : ''}
      </a>`;
    el.innerHTML = `
      <div class="platform-stats">
        ${card('#/platform/users', o.users, t('platform.overview.users'), tn('platform.overview.users_sub', o.platform_staff))}
        ${card('#/platform/orgs', o.organizations, t('platform.overview.orgs'), tn('platform.overview.workspaces', o.workspaces))}
        ${card('#/platform/orgs', o.devices, t('platform.overview.devices'), t('platform.overview.online', { n: o.devices_online }))}
        ${card('#/platform/billing', o.paying_accounts, t('platform.overview.paying'), tn('platform.overview.trialing', o.trialing))}
      </div>
      <h3 class="platform-subhead">${esc(t('platform.overview.health'))}</h3>
      <div class="platform-minis">
        ${mini('#/platform/users', o.new_users_7d, t('platform.overview.new_7d'))}
        ${mini('#/platform/cleanup', o.inactive_30d, t('platform.overview.inactive_30d'), tn('platform.overview.never_signed_in', o.never_signed_in))}
        ${mini('#/platform/cleanup', o.accounts_no_screens, t('platform.overview.no_screens'), tn('platform.overview.orgs_no_screens', o.orgs_no_screens))}
        ${mini('#/platform/orgs', o.screens_offline_24h, t('platform.overview.offline_24h'))}
        ${mini('#/platform/billing', o.trials_ending_7d, t('platform.overview.trials_ending'))}
        ${mini('#/platform/users', o.unverified_emails, t('platform.overview.unverified'))}
        ${mini('#/platform/system', formatBytes(o.storage_bytes), t('platform.overview.storage'))}
        ${mini('#/platform/cleanup', o.stale_accounts_180d, t('platform.overview.stale'), t('platform.overview.stale_sub'))}
      </div>
      <div class="settings-section">
        <h3>${esc(t('platform.overview.attention'))}</h3>
        ${attention.length ? `<div class="platform-attention">${attention.map(([item, href, text, kind]) => `
          <details class="att att-${kind}" data-item="${item}">
            <summary><span>${esc(text)}</span><span class="att-chev" aria-hidden="true"></span></summary>
            <div class="att-body" data-href="${href}"><p class="platform-empty">${esc(t('common.loading'))}</p></div>
          </details>`).join('')}</div>`
          : `<p class="platform-empty">${esc(t('platform.overview.all_clear'))}</p>`}
      </div>
      <p class="platform-version">${esc(t('platform.overview.version', { v: o.version }))}</p>`;
    // Details load the first time an item is opened (GET /admin/overview/attention/:item).
    el.querySelectorAll('details.att').forEach((d) => {
      d.addEventListener('toggle', () => { if (d.open && !d.dataset.loaded) { d.dataset.loaded = '1'; loadAttentionDetail(d); } });
    });
  } catch (err) {
    el.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`;
  }
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

// Search the organization cards by org name, owner name/email or workspace name.
function wireOrgFilter(el) {
  const search = document.getElementById('orgSearch');
  const count = document.getElementById('orgCount');
  if (!search) return;
  const cards = [...el.querySelectorAll('.org-card[data-filter-text]')];
  const apply = () => {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    for (const c of cards) { const ok = !q || c.dataset.filterText.includes(q); c.hidden = !ok; if (ok) shown++; }
    if (count) count.textContent = t('platform.orgs.showing', { n: shown, total: cards.length });
  };
  search.oninput = apply;
  apply();
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
      <div class="org-card" style="border:1px solid var(--border);border-radius:var(--radius);margin-bottom:10px" data-filter-text="${esc([o.name, o.owner_email, o.owner_name, ...(o.workspaces || []).map((w) => w.name)].filter(Boolean).join(' ').toLowerCase())}">
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
  wireOrgFilter(el);

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

/*
 * Search + role filter over the rendered users table (Platform → Users). Client-side: the list is
 * already fully loaded, and filtering must not re-fire the plan and role selects' requests.
 */
function wireUserFilters(el) {
  const search = document.getElementById('userSearch');
  const role = document.getElementById('userRoleFilter');
  const count = document.getElementById('userCount');
  if (!search || !role) return;
  const rows = [...el.querySelectorAll('tr[data-filter-text]')];
  const apply = () => {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    for (const r of rows) {
      const ok = (!q || r.dataset.filterText.includes(q)) && (!role.value || r.dataset.filterKind === role.value);
      r.hidden = !ok;
      if (ok) shown++;
    }
    if (count) count.textContent = t('platform.users.showing', { n: shown, total: rows.length });
  };
  search.oninput = apply;
  role.onchange = apply;
  apply();
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
            <tr style="border-bottom:1px solid var(--border)" data-filter-text="${esc([u.name, u.email, workspaceSummary(u)].filter(Boolean).join(' ').toLowerCase())}" data-filter-kind="${isPlatformStaffRole(u.role) ? 'platform' : 'user'}">
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
    wireUserFilters(el);

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
    // Platform admins only (the route enforces it); anyone else just gets the version cards.
    // ⚠️ isPlatformAdmin needs the user. Called bare it was always false, so this page never asked:
    // no "Updater ready" card, no confirm before Update Now, and no progress after a reload.
    const updateStatus = isPlatformAdmin(JSON.parse(localStorage.getItem('user') || '{}'))
      ? await fetch('/api/admin/update-status', { headers: headers() }).then(r => (r.ok ? r.json() : null)).catch(() => null)
      : null;
    const updaterInfo = updateStatus?.updater || null;

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
        ${updaterInfo ? `<div class="info-card">
           <div class="info-card-label">${t('admin.updater')}</div>
           <div class="info-card-value small" style="color:${updaterInfo.available ? 'var(--success)' : 'var(--text-muted)'}">${
             updaterInfo.available ? esc(t('admin.updater_ready', { kind: updaterInfo.kind }))
             : updaterInfo.reason === 'not_running' ? t('admin.updater_not_running') : t('admin.updater_not_installed')}</div>
         </div>` : ''}
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

    // Update Now button. Queues an upgrade for the host-side updater (docs/instance-updater.md);
    // without one installed, the server answers with the command to run by hand instead.
    document.getElementById('triggerUpdateBtn')?.addEventListener('click', async () => {
      const btn = document.getElementById('triggerUpdateBtn');
      const resultEl = document.getElementById('updateResult');
      const target = version.latest_version;
      if (updaterInfo?.available
          && !confirm(t('admin.update_confirm', { from: version.version, to: target }))) return;
      btn.disabled = true;
      btn.textContent = t('admin.updating');
      try {
        const res = await fetch('/api/admin/trigger-update', {
          method: 'POST',
          headers: { ...headers(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ target }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        if (data.queued) {
          watchUpdate(resultEl, data.id);
          return;  // the button stays disabled until the job ends
        }
        resultEl.innerHTML = `
          <div style="margin-top:12px;border:1px solid var(--border);border-radius:var(--radius);padding:12px;background:var(--bg-secondary)">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
              <strong style="font-size:13px">${t('admin.manual_update')}</strong>
              <button class="btn btn-secondary btn-sm" id="copyCmdBtn">${t('admin.copy_command')}</button>
            </div>
            <p style="font-size:12px;color:var(--text-muted);margin-bottom:8px">${t('admin.manual_update_desc')}</p>
            <pre style="font-size:11px;margin:0;background:var(--bg-primary);padding:8px;border-radius:4px;white-space:pre-wrap;word-break:break-all">${esc(data.instructions || '')}</pre>
            <p style="font-size:12px;color:var(--text-muted);margin:8px 0 0">${t('admin.updater_hint')}</p>
          </div>`;
        document.getElementById('copyCmdBtn')?.addEventListener('click', () => copyText(resultEl.querySelector('pre')?.textContent || ''));
      } catch (err) {
        showToast(err.message, 'error');
      }
      btn.disabled = false;
      btn.textContent = t('admin.update_now');
    });

    // An upgrade already running (this page was reloaded, or opened mid-upgrade): pick it up.
    if (updateStatus?.running || updateStatus?.pending?.length) {
      const btn = document.getElementById('triggerUpdateBtn');
      if (btn) { btn.disabled = true; btn.textContent = t('admin.updating'); }
      watchUpdate(document.getElementById('updateResult'), updateStatus.pending?.[0] || updateStatus.job?.id);
    } else if (updateStatus?.job && ['failed', 'rolled_back'].includes(updateStatus.job.state)
               && Date.now() / 1000 - updateStatus.job.updated_at < 86400) {
      renderUpdateJob(document.getElementById('updateResult'), updateStatus);
    }
  } catch (err) { el.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`; }
}

let updatePollTimer = null;

function copyText(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => showToast(t('admin.copied'), 'success'));
    return;
  }
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

const UPDATE_STATE_KEYS = {
  starting: 'admin.update_state_starting', backup: 'admin.update_state_backup', fetch: 'admin.update_state_fetch',
  pull: 'admin.update_state_fetch', install: 'admin.update_state_install', restart: 'admin.update_state_restart',
  verify: 'admin.update_state_verify', rollback: 'admin.update_state_rollback', done: 'admin.update_success',
  failed: 'admin.update_failed', rolled_back: 'admin.update_rolled_back',
};

function renderUpdateJob(el, s, { unreachable = false } = {}) {
  if (!el) return;
  const job = s?.job;
  const state = job?.state || 'starting';
  const color = state === 'done' ? 'var(--success)' : ['failed', 'rolled_back'].includes(state) ? 'var(--danger)' : 'var(--text-primary)';
  const title = unreachable ? t('admin.update_state_restart') : t(UPDATE_STATE_KEYS[state] || 'admin.updating');
  el.innerHTML = `
    <div style="margin-top:12px;border:1px solid var(--border);border-radius:var(--radius);padding:12px;background:var(--bg-card)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:8px">
        <strong style="font-size:13px;color:${color}">${esc(title)}${job?.target ? ` · v${esc(job.from || '?')} → v${esc(job.target)}` : ''}</strong>
        <button class="btn btn-secondary btn-sm" id="copyUpdateLogBtn">${t('admin.copy')}</button>
      </div>
      ${job?.message ? `<p style="font-size:12px;margin:0 0 8px;color:var(--text-muted)">${esc(job.message)}</p>` : ''}
      <pre style="max-height:300px;overflow:auto;font-size:11px;margin:0;background:var(--bg-primary);padding:8px;border-radius:4px;white-space:pre-wrap;word-break:break-all">${esc(s?.log || '')}</pre>
    </div>`;
  document.getElementById('copyUpdateLogBtn')?.addEventListener('click', () => copyText(el.querySelector('pre')?.textContent || ''));
}

// Poll the updater's status until the job ends. The server going away mid-upgrade is the normal
// case (it is being restarted), so a failed poll means "restarting", not an error.
function watchUpdate(el, jobId) {
  clearTimeout(updatePollTimer);
  const tick = async () => {
    let s = null;
    try {
      const r = await fetch('/api/admin/update-status', { headers: headers() });
      if (r.ok) s = await r.json();
    } catch (_) { /* restarting */ }
    if (!s) {
      renderUpdateJob(el, null, { unreachable: true });
    } else {
      const mine = !jobId || s.job?.id === jobId;
      renderUpdateJob(el, mine ? s : { ...s, job: { state: 'starting' } });
      if (mine && s.job && ['done', 'failed', 'rolled_back'].includes(s.job.state)) {
        if (s.job.state === 'done') {
          showToast(t('admin.update_success'), 'success');
          setTimeout(() => location.reload(), 2500);  // load the new version's dashboard
        } else {
          const btn = document.getElementById('triggerUpdateBtn');
          if (btn) { btn.disabled = false; btn.textContent = t('admin.update_now'); }
        }
        return;
      }
    }
    if (document.getElementById('updateResult') === el) updatePollTimer = setTimeout(tick, 3000);
  };
  tick();
}

export function cleanup() { clearTimeout(updatePollTimer); }


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

async function loadPlugins() {
  const section = document.getElementById('pluginsSection');
  const host = document.getElementById('pluginsTable');
  const subHost = document.getElementById('pluginSubmissions');
  const pinHost = document.getElementById('pluginAllowlist');
  if (!section || !host) return;
  const headers = { Authorization: `Bearer ${localStorage.getItem('token')}` };
  let body;
  try {
    const res = await fetch('/api/admin/plugins', { headers });
    if (res.status === 404) {
      section.style.display = 'none';
      // PLUGINS_ENABLED is unset: say so, rather than leave the Plugins page blank.
      const off = document.getElementById('pluginsOff');
      if (off) off.hidden = false;
      return;
    }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || String(res.status));
    body = await res.json();
  } catch (e) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';
  const plugins = Array.isArray(body.plugins) ? body.plugins : [];

  let pending = [];
  try {
    const r = await fetch('/api/admin/plugins/submissions?status=pending', { headers });
    if (r.ok) pending = ((await r.json()).submissions) || [];
  } catch { pending = []; }

  let pins = [];
  try {
    const r = await fetch('/api/admin/plugins/allowlist', { headers });
    if (r.ok) pins = ((await r.json()).allowlist) || [];
  } catch { pins = []; }

  if (subHost) {
    if (!pending.length) {
      subHost.innerHTML = `<p style="color:var(--text-muted);font-size:12px">${t('admin.plugins.pending_empty')}</p>`;
    } else {
      subHost.innerHTML = pending.map((s) => `
        <details class="card" style="margin-bottom:8px;padding:12px">
          <summary style="cursor:pointer;font-weight:600">${esc(s.name || s.plugin_id)} <span style="font-weight:400;color:var(--text-muted);font-family:monospace;font-size:12px">${esc(s.plugin_id)} @ ${esc(s.version || '')}</span></summary>
          <p style="font-size:12px;color:var(--text-muted);margin:8px 0">${esc(s.description || '')}</p>
          <p style="font-size:11px;font-family:monospace;word-break:break-all">sha256 ${esc(s.sha256)}</p>
          <details style="margin:8px 0">
            <summary style="cursor:pointer;font-size:12px">${t('admin.plugins.manifest')}</summary>
            <pre style="font-size:11px;overflow:auto;max-height:240px;background:var(--bg-primary);padding:8px;border-radius:6px">${esc(JSON.stringify(s.manifest || {}, null, 2))}</pre>
          </details>
          <p style="font-size:12px;margin:8px 0 4px">${t('admin.plugins.files')}</p>
          <ul style="font-size:12px;font-family:monospace;margin:0 0 8px 16px">${(s.files || []).map((f) => `<li><button type="button" class="btn btn-secondary btn-sm" data-plugin-inspect="${s.id}" data-plugin-path="${esc(f.name)}">${t('admin.plugins.inspect')} ${esc(f.name)}</button> (${f.size})</li>`).join('')}</ul>
          <pre data-plugin-inspect-out="${s.id}" style="display:none;font-size:11px;overflow:auto;max-height:320px;background:var(--bg-primary);padding:8px;border-radius:6px;white-space:pre-wrap"></pre>
          <div style="display:flex;gap:8px">
            <button class="btn btn-primary btn-sm" data-plugin-approve="${s.id}">${t('admin.plugins.approve')}</button>
            <button class="btn btn-secondary btn-sm" data-plugin-reject="${s.id}">${t('admin.plugins.reject')}</button>
          </div>
        </details>`).join('');
    }
  }

  if (!plugins.length) {
    host.innerHTML = `<p style="color:var(--text-muted)">${t('admin.plugins.empty')}</p>`;
  } else {
    host.innerHTML = `<table class="data-table"><thead><tr>
      <th>${t('admin.plugins.col_name')}</th>
      <th>${t('admin.plugins.col_id')}</th>
      <th>${t('admin.plugins.col_origin')}</th>
      <th>${t('admin.plugins.col_status')}</th>
      <th>${t('admin.plugins.col_hash')}</th>
      <th></th>
    </tr></thead><tbody>${plugins.map((p) => {
      const status = p.error
        ? t('admin.plugins.error')
        : (p.enabled ? (p.loaded ? t('admin.plugins.loaded') : t('admin.plugins.enabled')) : t('admin.plugins.disabled'));
      const action = p.enabled
        ? `<button class="btn btn-secondary btn-sm" data-plugin-disable="${esc(p.id)}">${t('admin.plugins.disable')}</button>`
        : `<button class="btn btn-primary btn-sm" data-plugin-enable="${esc(p.id)}">${t('admin.plugins.enable')}</button>`;
      const pinBtn = p.allowlisted
        ? `<button class="btn btn-secondary btn-sm" data-plugin-unpin="${esc(p.id)}">${t('admin.plugins.unpin')}</button>`
        : `<button class="btn btn-secondary btn-sm" data-plugin-pin="${esc(p.id)}">${t('admin.plugins.pin')}</button>`;
      const err = p.error ? `<div style="color:var(--danger);font-size:12px;margin-top:4px">${esc(p.error)}</div>` : '';
      const hash = p.allowlist_sha256 ? `<span style="font-family:monospace;font-size:11px">${esc(p.allowlist_sha256.slice(0, 12))}…</span>` : '—';
      return `<tr>
        <td>${esc(p.name || p.id)}${err}</td>
        <td style="font-family:monospace;font-size:12px">${esc(p.id)}</td>
        <td>${esc(p.origin || '')}</td>
        <td>${esc(status)}</td>
        <td>${hash}</td>
        <td style="display:flex;gap:6px;flex-wrap:wrap">${action}${pinBtn}</td>
      </tr>`;
    }).join('')}</tbody></table>
    <p style="color:var(--text-muted);font-size:12px;margin-top:8px">${t('admin.plugins.restart')}</p>
    ${plugins.filter((p) => Array.isArray(p.settings_fields) && p.settings_fields.length).map((p) => `
      <details class="card" style="margin-top:12px;padding:12px" data-plugin-settings="${esc(p.id)}">
        <summary style="cursor:pointer;font-weight:600">${esc(p.name || p.id)} — ${t('admin.plugins.settings')}</summary>
        <form data-plugin-settings-form="${esc(p.id)}" style="margin-top:12px">
          ${pluginFieldsHtml(p.settings_fields, p.settings || {}, 'plugset_' + p.id + '_')}
          <button type="submit" class="btn btn-primary btn-sm" style="margin-top:8px">${t('admin.plugins.save_settings')}</button>
        </form>
      </details>`).join('')}`;
  }

  if (pinHost) {
    if (!pins.length) {
      pinHost.innerHTML = `<p style="color:var(--text-muted);font-size:12px">${t('admin.plugins.allowlist_empty')}</p>`;
    } else {
      pinHost.innerHTML = `<table class="data-table"><thead><tr>
        <th>${t('admin.plugins.col_id')}</th><th>sha256</th><th>source</th></tr></thead><tbody>
        ${pins.map((r) => `<tr>
          <td style="font-family:monospace;font-size:12px">${esc(r.plugin_id)}</td>
          <td style="font-family:monospace;font-size:11px;word-break:break-all">${esc(r.sha256)}</td>
          <td>${esc(r.source)}</td>
        </tr>`).join('')}</tbody></table>`;
    }
  }

  const post = async (url, extra, okMsg) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: extra ? JSON.stringify(extra) : '{}',
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || String(res.status));
      const r = await res.json().catch(() => ({}));
      showToast(okMsg || (r.restart_required ? t('admin.plugins.restart_now') : t('admin.plugins.saved')), 'success');
      await loadPlugins();
    } catch (e) {
      showToast(e.message || t('admin.plugins.failed'), 'error');
    }
  };

  const toggle = (id, enable) => post(`/api/admin/plugins/${encodeURIComponent(id)}/${enable ? 'enable' : 'disable'}`);
  host.querySelectorAll('[data-plugin-enable]').forEach((b) => b.addEventListener('click', () => toggle(b.dataset.pluginEnable, true)));
  host.querySelectorAll('[data-plugin-disable]').forEach((b) => b.addEventListener('click', () => toggle(b.dataset.pluginDisable, false)));
  host.querySelectorAll('[data-plugin-pin]').forEach((b) => b.addEventListener('click', () => post(`/api/admin/plugins/${encodeURIComponent(b.dataset.pluginPin)}/pin`, null, t('admin.plugins.pinned_ok'))));
  host.querySelectorAll('[data-plugin-unpin]').forEach((b) => b.addEventListener('click', () => {
    const plugin = plugins.find((p) => p.id === b.dataset.pluginUnpin);
    if (plugin && plugin.allowlist_source === 'upload' && !window.confirm(t('admin.plugins.unpin_upload_confirm'))) return;
    post(`/api/admin/plugins/${encodeURIComponent(b.dataset.pluginUnpin)}/unpin`);
  }));
  host.querySelectorAll('[data-plugin-settings-form]').forEach((form) => {
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const id = form.dataset.pluginSettingsForm;
      const plugin = plugins.find((p) => p.id === id);
      if (!plugin) return;
      const settings = readPluginFields(plugin.settings_fields || [], 'plugset_' + id + '_');
      try {
        const res = await fetch(`/api/admin/plugins/${encodeURIComponent(id)}/settings`, {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || String(res.status));
        showToast(t('admin.plugins.settings_saved'), 'success');
        await loadPlugins();
      } catch (e) {
        showToast(e.message || t('admin.plugins.failed'), 'error');
      }
    });
  });
  if (subHost) {
    const approveOne = async (id) => {
      if (!window.confirm(t('admin.plugins.approve_confirm'))) return;
      try {
        const res = await fetch(`/api/admin/plugins/submissions/${id}/approve`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (res.status === 409) {
          const e = await res.json().catch(() => ({}));
          if (!window.confirm((e.error ? e.error + '\n\n' : '') + t('admin.plugins.replace_confirm'))) return;
          const res2 = await fetch(`/api/admin/plugins/submissions/${id}/approve`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ replace: true }),
          });
          if (!res2.ok) throw new Error((await res2.json().catch(() => ({}))).error || String(res2.status));
          showToast(t('admin.plugins.approved_ok'), 'success');
          await loadPlugins();
          return;
        }
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || String(res.status));
        showToast(t('admin.plugins.approved_ok'), 'success');
        await loadPlugins();
      } catch (e) {
        showToast(e.message || t('admin.plugins.failed'), 'error');
      }
    };
    subHost.querySelectorAll('[data-plugin-approve]').forEach((b) => b.addEventListener('click', () => approveOne(b.dataset.pluginApprove)));
    subHost.querySelectorAll('[data-plugin-reject]').forEach((b) => b.addEventListener('click', () => post(`/api/admin/plugins/submissions/${b.dataset.pluginReject}/reject`, { note: '' }, t('admin.plugins.rejected_ok'))));
    subHost.querySelectorAll('[data-plugin-inspect]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.pluginInspect;
      const rel = b.dataset.pluginPath;
      const out = subHost.querySelector(`[data-plugin-inspect-out="${id}"]`);
      if (!out || !rel) return;
      try {
        const res = await fetch(`/api/admin/plugins/submissions/${id}/file?path=${encodeURIComponent(rel)}`, { headers });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || String(res.status));
        const body = await res.json();
        out.style.display = '';
        out.textContent = body.binary ? `${rel} (${body.size} bytes, binary)` : (body.text || '');
      } catch (e) {
        showToast(e.message || t('admin.plugins.failed'), 'error');
      }
    }));
  }

  const form = document.getElementById('pluginUploadForm');
  if (form && !form.dataset.bound) {
    form.dataset.bound = '1';
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const input = document.getElementById('pluginZipInput');
      const file = input && input.files && input.files[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('package', file, file.name);
      try {
        const res = await fetch('/api/admin/plugins/submissions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
          body: fd,
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || String(res.status));
        showToast(t('admin.plugins.queued'), 'success');
        input.value = '';
        await loadPlugins();
      } catch (e) {
        showToast(e.message || t('admin.plugins.failed'), 'error');
      }
    });
  }
}

/*
 * Platform → Cleanup: stale customer accounts (server: lib/account-cleanup.js).
 *
 * Notice first, then delete: select → "Send notice" (emails "deleted on <date> unless you sign in")
 * → after the notice period, the accounts still silent are "Ready" → select → type "DELETE N".
 * The server re-checks every account at each step. Deleting without notice is an explicit override
 * with its own phrase. Nothing here decides what "stale" or "ready" means; the server does.
 */
async function mountCleanup(el, days = 180, lastResult = null, noticeDays = 14) {
  if (!el) return;
  el.innerHTML = `<p style="color:var(--text-muted)">${esc(t('common.loading'))}</p>`;
  let data;
  try { data = await api.adminStaleAccounts(days); } catch (err) { el.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`; return; }
  const when = (sec) => (sec ? new Date(sec * 1000).toLocaleDateString() : t('platform.cleanup.never'));
  const noticeCell = (a) => {
    if (a.notice === 'ready') return `<span class="notice-pill notice-ready">${esc(t('platform.cleanup.st_ready'))}</span>`;
    if (a.notice === 'notice') return `<span class="notice-pill notice-running">${esc(t('platform.cleanup.st_notice', { date: when(a.cleanup_delete_after) }))}</span>`;
    return `<span class="notice-pill">${esc(t('platform.cleanup.st_not_warned'))}</span>`;
  };
  const rows = data.accounts.map((a) => `
    <tr data-notice="${esc(a.notice)}">
      <td><input type="checkbox" class="cleanup-pick" value="${esc(a.id)}" data-notice="${esc(a.notice)}" aria-label="${esc(t('platform.cleanup.select', { email: a.email }))}"></td>
      <td><div style="font-weight:500">${esc(a.name || a.email)}</div><div style="font-size:11px;color:var(--text-muted)">${esc(a.email)}</div></td>
      <td>${esc(when(a.created_at))}</td>
      <td>${a.never_signed_in ? `<span class="cleanup-never">${esc(t('platform.cleanup.never'))}</span>` : esc(when(a.last_login))}<div style="font-size:11px;color:var(--text-muted)">${esc(t('platform.cleanup.last_activity', { date: when(a.last_activity) }))}</div></td>
      <td>${esc(String(a.workspaces))} · ${esc(String(a.content_items))}${a.content_bytes ? ` <span style="color:var(--text-muted)">(${esc(formatBytes(a.content_bytes))})</span>` : ''}</td>
      <td>${noticeCell(a)}</td>
    </tr>`).join('');
  const summary = lastResult ? `
    <div class="cleanup-summary">
      <strong>${esc(lastResult.warned ? tn('platform.cleanup.warned_done', lastResult.warned.length) : tn('platform.cleanup.done', lastResult.deleted.length))}</strong>
      ${lastResult.files_removed ? ` · ${esc(t('platform.cleanup.freed', { n: lastResult.files_removed, size: formatBytes(lastResult.bytes_freed) }))}` : ''}
      ${lastResult.skipped.length ? `<div class="cleanup-skipped">${esc(tn('platform.cleanup.skipped', lastResult.skipped.length))}<ul>${lastResult.skipped.map((k) => `<li>${esc(k.email || k.id)}: ${esc(k.reason)}</li>`).join('')}</ul></div>` : ''}
    </div>` : '';
  el.innerHTML = `
    ${summary}
    <div class="settings-section">
      <h3>${esc(t('platform.cleanup.rules_title'))}</h3>
      <div class="cleanup-rules">
        <label>${esc(t('platform.cleanup.inactive_for'))}
          <select class="input" id="cleanupDays">${[30, 90, 180, 365].map((d) => `<option value="${d}" ${d === data.inactive_days ? 'selected' : ''}>${esc(tn('platform.cleanup.days', d))}</option>`).join('')}</select>
        </label>
        <label>${esc(t('platform.cleanup.notice_period'))}
          <select class="input" id="cleanupNotice">${[14, 30].map((d) => `<option value="${d}" ${d === noticeDays ? 'selected' : ''}>${esc(tn('platform.cleanup.days', d))}</option>`).join('')}</select>
        </label>
        <ul>
          <li>${esc(tn('platform.cleanup.rule_login', data.inactive_days))}</li>
          <li>${esc(t('platform.cleanup.rule_screens'))}</li>
          <li>${esc(t('platform.cleanup.rule_paying'))}</li>
          <li>${esc(t('platform.cleanup.rule_shared'))}</li>
          <li>${esc(t('platform.cleanup.rule_staff'))}</li>
        </ul>
      </div>
      <ol class="cleanup-steps">
        <li>${esc(t('platform.cleanup.step1'))}</li>
        <li>${esc(t('platform.cleanup.step2'))}</li>
        <li>${esc(t('platform.cleanup.step3'))}</li>
      </ol>
      ${data.email_configured ? '' : `<p class="cleanup-warn">${esc(t('platform.cleanup.no_email'))}</p>`}
    </div>
    <div class="settings-section">
      <div class="cleanup-head">
        <h3 style="margin:0">${esc(tn('platform.cleanup.found', data.total))}${data.reclaimable_bytes ? ` <span class="cleanup-bytes">${esc(t('platform.cleanup.reclaim', { size: formatBytes(data.reclaimable_bytes) }))}</span>` : ''}</h3>
        <span style="flex:1"></span>
        <button class="btn btn-secondary btn-sm" id="cleanupExport" ${data.total ? '' : 'disabled'}>${esc(t('platform.cleanup.export'))}</button>
      </div>
      ${data.total ? `
      <div class="cleanup-filters">
        <button class="chip-btn" data-pick="not_warned">${esc(tn('platform.cleanup.pick_not_warned', data.counts.not_warned))}</button>
        <button class="chip-btn" data-pick="notice">${esc(tn('platform.cleanup.pick_notice', data.counts.notice))}</button>
        <button class="chip-btn chip-ready" data-pick="ready">${esc(tn('platform.cleanup.pick_ready', data.counts.ready))}</button>
        <button class="chip-btn" data-pick="none">${esc(t('platform.cleanup.pick_none'))}</button>
      </div>
      <div class="table-wrap"><table class="org-members-table cleanup-table">
        <thead><tr><th><input type="checkbox" id="cleanupAll" aria-label="${esc(t('platform.cleanup.select_all'))}"></th>
          <th>${esc(t('platform.cleanup.col_account'))}</th><th>${esc(t('platform.cleanup.col_created'))}</th><th>${esc(t('platform.cleanup.col_last_login'))}</th>
          <th>${esc(t('platform.cleanup.col_holdings'))}</th><th>${esc(t('platform.cleanup.col_notice'))}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="cleanup-actions">
        <button class="btn btn-primary btn-sm" id="cleanupWarn" disabled>${esc(t('platform.cleanup.warn_selected'))}</button>
        <button class="btn btn-danger btn-sm" id="cleanupDelete" disabled>${esc(t('platform.cleanup.delete_selected'))}</button>
        <label class="cleanup-override"><input type="checkbox" id="cleanupSkipNotice"> ${esc(t('platform.cleanup.skip_notice'))}</label>
      </div>` : `<p class="platform-empty">${esc(t('platform.cleanup.none'))}</p>`}
      <p class="cleanup-note">${esc(t('platform.cleanup.note'))}</p>
    </div>`;

  const reload = (result) => mountCleanup(el, data.inactive_days, result, noticeDays);
  el.querySelector('#cleanupDays').onchange = (e) => mountCleanup(el, parseInt(e.target.value, 10), null, noticeDays);
  el.querySelector('#cleanupNotice').onchange = (e) => { noticeDays = parseInt(e.target.value, 10); };
  el.querySelector('#cleanupExport').onclick = () => {
    const csvCell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const lines = [['email', 'name', 'created', 'last_login', 'last_activity', 'workspaces', 'content_items', 'content_bytes', 'notice'].join(',')]
      .concat(data.accounts.map((a) => [a.email, a.name, when(a.created_at), a.never_signed_in ? 'never' : when(a.last_login), when(a.last_activity), a.workspaces, a.content_items, a.content_bytes, a.notice].map(csvCell).join(',')));
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    link.download = `stale-accounts-${data.inactive_days}d-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };
  if (!data.total) return;

  const boxes = [...el.querySelectorAll('.cleanup-pick')];
  const picked = () => boxes.filter((c) => c.checked);
  const warnBtn = el.querySelector('#cleanupWarn');
  const delBtn = el.querySelector('#cleanupDelete');
  const skip = el.querySelector('#cleanupSkipNotice');
  const sync = () => {
    const sel = picked();
    const toWarn = sel.filter((c) => c.dataset.notice === 'not_warned').length;
    const toDelete = skip.checked ? sel.length : sel.filter((c) => c.dataset.notice === 'ready').length;
    warnBtn.disabled = !toWarn || !data.email_configured;
    warnBtn.textContent = toWarn ? tn('platform.cleanup.warn_n', toWarn) : t('platform.cleanup.warn_selected');
    delBtn.disabled = !toDelete;
    delBtn.textContent = toDelete ? tn(skip.checked ? 'platform.cleanup.delete_n_now' : 'platform.cleanup.delete_n', toDelete) : t('platform.cleanup.delete_selected');
  };
  boxes.forEach((c) => { c.onchange = sync; });
  skip.onchange = sync;
  const all = el.querySelector('#cleanupAll');
  all.onchange = () => { boxes.forEach((c) => { c.checked = all.checked; }); sync(); };
  el.querySelectorAll('[data-pick]').forEach((b) => {
    b.onclick = () => { boxes.forEach((c) => { c.checked = b.dataset.pick !== 'none' && c.dataset.notice === b.dataset.pick; }); all.checked = false; sync(); };
  });

  warnBtn.onclick = () => {
    const ids = picked().filter((c) => c.dataset.notice === 'not_warned').map((c) => c.value);
    if (!ids.length) return;
    const phrase = `NOTIFY ${ids.length}`;
    openTypeToConfirmModal({
      title: tn('platform.cleanup.warn_title', ids.length),
      body: esc(tn('platform.cleanup.warn_body', noticeDays)),
      expected: phrase,
      confirmLabel: tn('platform.cleanup.warn_n', ids.length),
      onConfirm: async () => {
        const out = await api.adminWarnStale({ ids, days: data.inactive_days, notice_days: noticeDays });
        showToast(tn('platform.cleanup.warned_done', out.warned.length), 'success');
        reload(out);
      },
    });
  };

  delBtn.onclick = () => {
    const sel = picked();
    const ids = (skip.checked ? sel : sel.filter((c) => c.dataset.notice === 'ready')).map((c) => c.value);
    if (!ids.length) return;
    const phrase = skip.checked ? `DELETE ${ids.length} WITHOUT NOTICE` : `DELETE ${ids.length}`;
    openTypeToConfirmModal({
      title: tn('platform.cleanup.confirm_title', ids.length),
      body: esc(t(skip.checked ? 'platform.cleanup.confirm_body_now' : 'platform.cleanup.confirm_body')),
      expected: phrase,
      confirmLabel: tn(skip.checked ? 'platform.cleanup.delete_n_now' : 'platform.cleanup.delete_n', ids.length),
      onConfirm: async () => {
        const out = await api.adminPurgeStale({ ids, days: data.inactive_days, confirm: phrase, skip_notice: skip.checked });
        showToast(tn('platform.cleanup.done', out.deleted.length), 'success');
        reload(out);
      },
    });
  };
}


/* ── Player rollouts (server lib/ota-rollout.js) ─────────────────────────────────────────────── */
const ROLLOUT_ACTIONS = { rolling: ['pause', 'release', 'halt'], paused: ['resume', 'release', 'halt'], halted: ['clear'], complete: [], superseded: [] };
async function loadRollouts() {
  const host = document.getElementById('rolloutsBody');
  if (!host) return;
  let data;
  try { data = await api.get('/admin/ota-rollouts'); } catch (e) { host.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  const rows = data.rollouts || [];
  host.innerHTML = `
    ${data.enabled ? '' : `<p style="color:#ca8a04;font-size:13px">${esc(t('platform.rollouts.disabled'))}</p>`}
    ${rows.length ? `<table class="table"><thead><tr>
      <th>${esc(t('platform.rollouts.col.player'))}</th><th>${esc(t('platform.rollouts.col.status'))}</th>
      <th>${esc(t('platform.rollouts.col.health'))}</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr>
        <td><strong>${esc(t(`platform.rollouts.family.${r.family}`))} ${esc(r.version)}</strong>
          <div class="muted" style="font-size:12px">${esc(t('platform.rollouts.started', { when: new Date(r.started_at * 1000).toLocaleString() }))}</div></td>
        <td>${esc(t(`platform.rollouts.status.${r.status}`, { pct: r.wave_percent }))}
          ${r.status === 'halted' ? `<div style="font-size:12px;color:#dc2626;max-width:340px">${esc(r.halted_reason || '')}</div>
            <div class="muted" style="font-size:12px">${esc(r.family === 'android' ? t('platform.rollouts.android_note') : r.can_roll_back ? t('platform.rollouts.rolled_back', { v: r.prev_version }) : t('platform.rollouts.no_prev'))}</div>` : ''}</td>
        <td style="font-size:12px">${r.health ? esc(t('platform.rollouts.health', { updated: r.health.updated, bad: r.health.bad, size: r.health.family_size })) : ''}</td>
        <td style="white-space:nowrap">${(ROLLOUT_ACTIONS[r.status] || []).map((a) => `<button class="btn btn-secondary btn-sm" data-ro="${esc(r.family)}|${esc(r.version)}|${a}" style="margin:2px">${esc(t(`platform.rollouts.act.${a}`))}</button>`).join('')}</td>
      </tr>`).join('')}</tbody></table>` : `<p class="muted">${esc(t('platform.rollouts.empty'))}</p>`}`;
  host.querySelectorAll('[data-ro]').forEach((b) => b.addEventListener('click', async () => {
    const [family, version, action] = b.dataset.ro.split('|');
    if ((action === 'halt' || action === 'release') && !confirm(t(`platform.rollouts.confirm.${action}`, { v: version }))) return;
    try { await api.post(`/admin/ota-rollouts/${encodeURIComponent(family)}/${encodeURIComponent(version)}/${action}`, {}); showToast(t('platform.rollouts.done'), 'success'); loadRollouts(); }
    catch (e) { showToast(e.message, 'error'); }
  }));
}
