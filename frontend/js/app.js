import { connectSocket } from './socket.js';
import * as dashboard from './views/dashboard.js';
import * as deviceDetail from './views/device-detail.js';
import * as contentLibrary from './views/content-library.js';
import * as settings from './views/settings.js';
import * as login from './views/login.js';
import * as billing from './views/billing.js';
import * as layoutEditor from './views/layout-editor.js';
import * as schedule from './views/schedule.js';
import * as widgets from './views/widgets.js';
import * as videoWall from './views/video-wall.js';
import * as reports from './views/reports.js';
import * as activity from './views/activity.js';
import * as kiosk from './views/kiosk.js';
import * as onboarding from './views/onboarding.js';
import * as help from './views/help.js';
import * as teams from './views/teams.js';
import * as admin from './views/admin.js';
import * as adminPlayerDebug from './views/admin-player-debug.js';
import * as designer from './views/designer.js';
import * as playlists from './views/playlists.js';
import * as workspaceMembers from './views/workspace-members.js';
import * as forcePasswordChange from './views/force-password-change.js';
import * as noWorkspace from './views/no-workspace.js';
import { applyBranding } from './branding.js';
import { t } from './i18n.js';
import { isPlatformAdmin } from './utils.js';
import { renderWorkspaceSwitcher } from './components/workspace-switcher.js';
import { showToast } from './components/toast.js';
import { api } from './api.js';

const app = document.getElementById('app');
const sidebar = document.querySelector('.sidebar');
let currentView = null;

// ==================== Slice 2C: accept-invite plumbing ====================
//
// Flow shape (covers all six auth entry points - login, register, support,
// Google, Microsoft, first-user-setup - because they all funnel through
// onAuthSuccess() in login.js which calls window.location.reload()):
//
//   1. Hash route #/accept-invite/{id}:
//      - unauthed: stash inviteId in localStorage, redirect to login
//      - authed:   call consumeAcceptInvite() directly (no stash)
//   2. App boot (every route() call once auth checks pass): if a valid
//      non-stale stash is present, fire consumeAcceptInvite. After login
//      reload lands here and picks it up automatically.
//   3. consumeAcceptInvite on success: stash toast text, switch workspace,
//      reload. Reload re-fires route() which picks up the toast stash and
//      shows it on dashboard. Reload is needed for the new JWT/socket/
//      sidebar /me to pick up the new workspace context.
//   4. consumeAcceptInvite on error: showToast directly + clear stash.
//      No reload (no state change to propagate).

const PENDING_INVITE_KEY = 'pending_invite';
const PENDING_INVITE_TOAST_KEY = 'pending_invite_toast';
// Mirrors the backend INVITE_EXPIRY_DAYS default (7). If an operator changes
// the backend default, this should be updated to match - tracked in handoff.
const INVITE_EXPIRY_DAYS_FRONTEND = 7;

// Non-reentrant guard: route() can fire multiple times (hashchange events).
// Once consume is in flight, additional calls no-op until reload completes.
let _acceptInFlight = false;

function stashPendingInvite(inviteId) {
  localStorage.setItem(PENDING_INVITE_KEY, JSON.stringify({
    inviteId,
    stashedAt: Math.floor(Date.now() / 1000),
  }));
}

function readPendingInvite() {
  const raw = localStorage.getItem(PENDING_INVITE_KEY);
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { localStorage.removeItem(PENDING_INVITE_KEY); return null; }
  if (!parsed?.inviteId || !parsed?.stashedAt) {
    localStorage.removeItem(PENDING_INVITE_KEY);
    return null;
  }
  const ageSecs = Math.floor(Date.now() / 1000) - parsed.stashedAt;
  if (ageSecs > INVITE_EXPIRY_DAYS_FRONTEND * 86400) {
    localStorage.removeItem(PENDING_INVITE_KEY);
    return null;
  }
  return parsed.inviteId;
}

function clearPendingInvite() {
  localStorage.removeItem(PENDING_INVITE_KEY);
}

// Map backend error message text to a translated toast string. We match
// English text because api.js doesn't surface HTTP status codes today;
// refactor to err.status when that lands - tracked in handoff doc.
function mapAcceptError(err) {
  const msg = err?.message || '';
  if (/Invite not found/i.test(msg)) return t('accept.error.not_found');
  if (/Invite has expired|Workspace no longer exists/i.test(msg)) return t('accept.error.expired');
  if (/different email address/i.test(msg)) return t('accept.error.wrong_account');
  return t('accept.error.generic');
}

async function consumeAcceptInvite(inviteId) {
  if (_acceptInFlight) return;
  _acceptInFlight = true;
  try {
    const result = await api.acceptInvite(inviteId);

    // Switch to the joined workspace. New JWT carries the workspace context;
    // reload picks it up for sidebar /me + socket rooms + data fetches. If
    // the switch fails, log and reload anyway - the membership was created
    // so the user can switch manually via the dropdown.
    try {
      const sw = await api.switchWorkspace(result.workspace_id);
      if (sw?.token) localStorage.setItem('token', sw.token);
    } catch (e) {
      console.warn('switchWorkspace after accept failed (non-fatal):', e.message);
    }

    // Stash the toast text in a scoped key (not a generic pending-toast
    // channel) so app boot below fires it after reload.
    const toastKey = result.already_member ? 'accept.already_member' : 'accept.success';
    localStorage.setItem(PENDING_INVITE_TOAST_KEY, JSON.stringify({
      message: t(toastKey, { name: result.workspace_name }),
      kind: 'success',
    }));

    clearPendingInvite();
    // history.replaceState mutates the hash WITHOUT firing hashchange.
    // Important: a plain `location.hash = '#/'` would fire hashchange
    // synchronously, causing route() to fire a second time before the
    // reload runs - that second route() call would consume the toast key
    // and attach the toast to a DOM that's about to be destroyed by the
    // reload. Using replaceState bypasses that race so the post-reload
    // route() is the only one that picks up the toast.
    history.replaceState(null, '', window.location.pathname + '#/');
    window.location.reload();
  } catch (err) {
    showToast(mapAcceptError(err), 'error');
    clearPendingInvite();
    _acceptInFlight = false;
  }
}

// Fires once per page load (single-shot key in localStorage). If the
// previous routeApp cycle stashed a toast across reload, show it now.
function consumePendingInviteToast() {
  const raw = localStorage.getItem(PENDING_INVITE_TOAST_KEY);
  if (!raw) return;
  localStorage.removeItem(PENDING_INVITE_TOAST_KEY);
  try {
    const { message, kind } = JSON.parse(raw);
    if (message) showToast(message, kind || 'info');
  } catch {}
}

// Map nav-link data-view to its translation key.
const NAV_LABEL_KEYS = {
  dashboard: 'nav.displays',
  content: 'nav.content',
  playlists: 'nav.playlists',
  layouts: 'nav.layouts',
  widgets: 'nav.widgets',
  schedule: 'nav.schedule',
  walls: 'nav.walls',
  reports: 'nav.reports',
  kiosk: 'nav.kiosk',
  designer: 'nav.designer',
  activity: 'nav.activity',
  teams: 'nav.teams',
  help: 'nav.help',
  settings: 'nav.settings',
  billing: 'nav.subscription',
  admin: 'nav.admin',
};

function renderNavLabels() {
  document.querySelectorAll('.nav-link').forEach((link) => {
    const key = NAV_LABEL_KEYS[link.dataset.view];
    if (!key) return;
    const span = link.querySelector('span');
    if (span) span.textContent = t(key);
  });
}

// Translate any element marked with data-i18n / data-i18n-placeholder /
// data-i18n-html. Runs on init and on every language change. Used for static
// HTML in index.html (e.g. the Add-Display modal) where t() can't be inlined
// at template time.
function translateStaticDom(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.getAttribute('data-i18n-html'));
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  });
}

function isAuthenticated() {
  return !!localStorage.getItem('token');
}

function getCurrentUser() {
  try {
    return JSON.parse(localStorage.getItem('user'));
  } catch { return null; }
}

// #12: true when a signed-in user provably has zero accessible workspaces and
// no platform-level reach. Requires accessible_workspaces to be present (only
// /me populates it) - undefined means "not loaded yet", so we DON'T trigger and
// fall through to the normal (workspace-empty-safe) views until /me resolves.
function hasNoAccessibleWorkspace(u) {
  return !!u
    && Array.isArray(u.accessible_workspaces)
    && u.accessible_workspaces.length === 0
    && !u.current_workspace_id
    && !isPlatformAdmin(u);
}

// Refresh the cached user from the server. The server reads plan_id fresh
// from the DB on every request, but the frontend only wrote `user` into
// localStorage at login — so plan/role changes made by an admin weren't
// visible until the user logged out and back in.
async function refreshCurrentUser() {
  const token = localStorage.getItem('token');
  if (!token) return;
  try {
    const res = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const fresh = await res.json();
    localStorage.setItem('user', JSON.stringify(fresh));
    // Re-render the workspace switcher on every /me refresh - cheap, and keeps
    // the dropdown in sync if a workspace was added/removed in another tab.
    renderWorkspaceSwitcher(fresh);
    window.dispatchEvent(new CustomEvent('user-refreshed', { detail: fresh }));
    // #12: /me is the first place accessible_workspaces is known. If it resolves
    // to zero (org-less user), send them to the empty state now - on a fresh
    // load route() may have already rendered the dashboard before /me returned.
    // Guard against the login / change-password / already-there screens to avoid
    // a redirect loop.
    const hash = window.location.hash || '#/';
    if (hasNoAccessibleWorkspace(fresh)
        && hash !== '#/no-workspace' && hash !== '#/login' && hash !== '#/change-password') {
      window.location.hash = '#/no-workspace';
    }
  } catch {}
}

function route() {
  // Cleanup previous view
  if (currentView && currentView.cleanup) currentView.cleanup();

  const hash = window.location.hash || '#/';

  // Slice 2C - direct hits on #/accept-invite/{id}. Handle BEFORE the
  // auth-redirect-to-login because an unauthed visit needs to stash the
  // inviteId so it survives the redirect.
  if (hash.startsWith('#/accept-invite/')) {
    const inviteId = hash.split('#/accept-invite/')[1].split('/')[0];
    if (inviteId) {
      if (!isAuthenticated()) {
        stashPendingInvite(inviteId);
        window.location.hash = '#/login';
        return;
      }
      consumeAcceptInvite(inviteId); // helper handles routing (reload to '#/')
      return;
    }
  }

  // Auth check - redirect to login if not authenticated
  if (!isAuthenticated() && hash !== '#/login') {
    window.location.hash = '#/login';
    return;
  }

  // If authenticated and on login page, redirect to dashboard or onboarding
  if (isAuthenticated() && hash === '#/login') {
    window.location.hash = localStorage.getItem('rd_onboarded') ? '#/' : '#/onboarding';
    return;
  }

  // Slice 2C - past the auth gates. (a) Show any toast stashed across the
  // accept-invite reload boundary. (b) If a stash exists (from an unauthed
  // accept-invite visit + subsequent login/register), consume it now. The
  // helper's in-flight guard prevents double-fire on subsequent hashchanges.
  if (isAuthenticated()) {
    consumePendingInviteToast();
    const stashedInviteId = readPendingInvite();
    if (stashedInviteId) {
      consumeAcceptInvite(stashedInviteId);
      return;
    }
  }

  // #10: forced first-login password change. An admin-provisioned user carries
  // must_change_password until they set their own password. Block every other
  // authenticated view and force them to the change-password screen; the server
  // clears the flag on a successful PUT /api/auth/me. The screen itself is the
  // one exception (so they can actually change it).
  if (isAuthenticated()) {
    const u = getCurrentUser();
    if (u && u.must_change_password && hash !== '#/change-password') {
      window.location.hash = '#/change-password';
      return;
    }
    if (hash === '#/change-password') {
      if (!u || !u.must_change_password) {
        // Not (or no longer) required - don't strand the user on a dead screen.
        window.location.hash = '#/';
        return;
      }
      sidebar.style.display = 'none';
      app.style.marginLeft = '0';
      const mb = document.getElementById('mobileMenuBtn');
      if (mb) mb.style.display = 'none';
      currentView = forcePasswordChange;
      forcePasswordChange.render(app);
      return;
    }
  }

  // #12: a signed-in user with zero accessible workspaces (org-less self-signup
  // on an AUTO_CREATE_ORG_ON_SIGNUP=false deployment) lands on a "no workspaces
  // yet" empty state instead of being bounced into onboarding (whose pairing
  // step needs a workspace). Only fires once /me has populated
  // accessible_workspaces; until then the workspace-empty-safe dashboard shows.
  if (isAuthenticated()) {
    const u = getCurrentUser();
    if (hasNoAccessibleWorkspace(u) && hash !== '#/no-workspace') {
      window.location.hash = '#/no-workspace';
      return;
    }
    if (hash === '#/no-workspace') {
      if (!hasNoAccessibleWorkspace(u)) { window.location.hash = '#/'; return; }
      sidebar.style.display = 'none';
      app.style.marginLeft = '0';
      const mb = document.getElementById('mobileMenuBtn');
      if (mb) mb.style.display = 'none';
      currentView = noWorkspace;
      noWorkspace.render(app);
      return;
    }
  }

  // Onboarding for new users
  if (hash === '#/onboarding' && isAuthenticated()) {
    sidebar.style.display = 'none';
    app.style.marginLeft = '0';
    currentView = onboarding;
    onboarding.render(app);
    return;
  }

  // Login page - hide sidebar
  if (hash === '#/login') {
    sidebar.style.display = 'none';
    app.style.marginLeft = '0';
    const mb = document.getElementById('mobileMenuBtn');
    if (mb) mb.style.display = 'none';
    currentView = login;
    login.render(app);
    return;
  }

  // Show sidebar for authenticated views
  sidebar.style.display = '';
  app.style.marginLeft = '';
  const mb = document.getElementById('mobileMenuBtn');
  if (mb) mb.style.display = '';

  // Update user info in sidebar
  updateSidebarUser();

  const navLinks = document.querySelectorAll('.nav-link');
  navLinks.forEach(link => {
    link.classList.remove('active');
    if (hash === '#/' && link.dataset.view === 'dashboard') link.classList.add('active');
    else if (hash.startsWith('#/content') && link.dataset.view === 'content') link.classList.add('active');
    else if (hash.startsWith('#/settings') && link.dataset.view === 'settings') link.classList.add('active');
    else if (hash.startsWith('#/billing') && link.dataset.view === 'billing') link.classList.add('active');
    else if ((hash.startsWith('#/layout') || hash === '#/layouts') && link.dataset.view === 'layouts') link.classList.add('active');
    else if ((hash === '#/playlists' || hash.startsWith('#/playlists/')) && link.dataset.view === 'playlists') link.classList.add('active');
    else if (hash === '#/schedule' && link.dataset.view === 'schedule') link.classList.add('active');
    else if (hash === '#/widgets' && link.dataset.view === 'widgets') link.classList.add('active');
    else if ((hash.startsWith('#/wall') || hash === '#/walls') && link.dataset.view === 'walls') link.classList.add('active');
    else if (hash === '#/reports' && link.dataset.view === 'reports') link.classList.add('active');
    else if (hash === '#/activity' && link.dataset.view === 'activity') link.classList.add('active');
    else if (hash === '#/designer' && link.dataset.view === 'designer') link.classList.add('active');
    else if ((hash === '#/kiosk' || hash.startsWith('#/kiosk/')) && link.dataset.view === 'kiosk') link.classList.add('active');
    else if (hash === '#/help' && link.dataset.view === 'help') link.classList.add('active');
    else if (hash.startsWith('#/device/') && link.dataset.view === 'dashboard') link.classList.add('active');
  });

  // Route to view
  if (hash === '#/' || hash === '#' || hash === '') {
    currentView = dashboard;
    dashboard.render(app);
  } else if (hash.startsWith('#/device/')) {
    const deviceId = hash.split('#/device/')[1].split('/')[0];
    currentView = deviceDetail;
    deviceDetail.render(app, deviceId);
  } else if (hash === '#/content') {
    currentView = contentLibrary;
    contentLibrary.render(app);
  } else if (hash === '#/playlists' || hash.startsWith('#/playlists/')) {
    currentView = playlists;
    playlists.render(app);
  } else if (hash === '#/layouts' || hash.startsWith('#/layout/')) {
    currentView = layoutEditor;
    layoutEditor.render(app);
  } else if (hash === '#/schedule') {
    currentView = schedule;
    schedule.render(app);
  } else if (hash === '#/widgets') {
    currentView = widgets;
    widgets.render(app);
  } else if (hash === '#/walls' || hash.startsWith('#/wall/')) {
    currentView = videoWall;
    videoWall.render(app);
  } else if (hash === '#/reports') {
    currentView = reports;
    reports.render(app);
  } else if (hash === '#/kiosk' || hash.startsWith('#/kiosk/')) {
    currentView = kiosk;
    kiosk.render(app);
  } else if (hash === '#/designer') {
    currentView = designer;
    designer.render(app);
  } else if (hash === '#/activity') {
    currentView = activity;
    activity.render(app);
  } else if (hash === '#/teams' || hash.startsWith('#/team/')) {
    currentView = teams;
    teams.render(app);
  } else if (hash.startsWith('#/workspace/') && hash.includes('/members')) {
    const wsId = hash.split('#/workspace/')[1].split('/')[0];
    currentView = workspaceMembers;
    workspaceMembers.render(app, wsId);
  } else if (hash === '#/help' || hash.startsWith('#/help')) {
    currentView = help;
    help.render(app);
  } else if (hash.startsWith('#/admin/player-debug')) {
    // Match prefix so query params (?page=2&ua=Tizen) route correctly.
    currentView = adminPlayerDebug;
    adminPlayerDebug.render(app);
  } else if (hash === '#/admin') {
    currentView = admin;
    admin.render(app);
  } else if (hash === '#/settings') {
    currentView = settings;
    settings.render(app);
  } else if (hash === '#/billing') {
    // #116: when HIDE_BILLING is set, a direct #/billing navigation is bounced to the
    // dashboard. replaceState (not a hash assignment) so it doesn't add a history entry
    // — the back button skips over it instead of looping back into the guard.
    if (getCurrentUser()?.hide_billing) {
      history.replaceState(null, '', window.location.pathname + '#/');
      currentView = dashboard;
      dashboard.render(app);
    } else {
      currentView = billing;
      billing.render(app);
    }
  } else {
    currentView = dashboard;
    dashboard.render(app);
  }
}

function updateSidebarUser() {
  const user = getCurrentUser();
  if (!user) return;

  // Show admin nav only for platform admins (legacy 'superadmin' or Phase 1 renamed 'platform_admin')
  const adminNav = document.getElementById('adminNavItem');
  if (adminNav) adminNav.style.display = isPlatformAdmin(user) ? '' : 'none';

  // #116: hide the Subscription nav item when HIDE_BILLING is set (surfaced on /me).
  // Runs at boot from the cached user (no flash on warm loads) and again after /me.
  const billingNav = document.getElementById('billingNavItem');
  if (billingNav) billingNav.style.display = user.hide_billing ? 'none' : '';

  let userEl = document.getElementById('sidebarUser');
  if (!userEl) {
    const footer = document.querySelector('.sidebar-footer');
    userEl = document.createElement('div');
    userEl.id = 'sidebarUser';
    userEl.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--border)';
    footer.insertBefore(userEl, footer.firstChild);
  }

  userEl.innerHTML = `
    ${user.avatar_url ? `<img src="${user.avatar_url}" style="width:28px;height:28px;border-radius:50%">` :
      `<div style="width:28px;height:28px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:white">${(user.name || user.email)[0].toUpperCase()}</div>`}
    <div style="flex:1;min-width:0">
      <div style="font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${user.name || user.email}</div>
      <div style="font-size:10px;color:var(--text-muted)">${user.role}</div>
    </div>
    <button id="logoutBtn" class="btn-icon" title="${t('auth.sign_out')}" style="flex-shrink:0">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
        <polyline points="16 17 21 12 16 7"/>
        <line x1="21" y1="12" x2="9" y2="12"/>
      </svg>
    </button>
  `;

  document.getElementById('logoutBtn')?.addEventListener('click', () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.hash = '#/login';
    window.location.reload();
  });
}

// Initialize
renderNavLabels();
translateStaticDom();
window.addEventListener('language-changed', () => {
  renderNavLabels();
  translateStaticDom();
});

if (isAuthenticated()) {
  connectSocket();
  applyBranding();
  refreshCurrentUser().then(() => updateSidebarUser());
}

// Refresh the cached user on every route transition so plan/role changes
// made by an admin propagate without requiring a re-login.
window.addEventListener('hashchange', () => { if (isAuthenticated()) refreshCurrentUser(); });

// Register PWA service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw-admin.js').catch(() => {});
}

// Mobile sidebar: open/close via hamburger, backdrop, nav tap, Escape
const sidebarEl = document.querySelector('.sidebar');
const backdropEl = document.getElementById('sidebarBackdrop');
const menuBtn = document.getElementById('mobileMenuBtn');

function setMobileNav(open) {
  if (!sidebarEl || !backdropEl) return;
  sidebarEl.classList.toggle('open', open);
  backdropEl.classList.toggle('open', open);
  menuBtn?.setAttribute('aria-expanded', open ? 'true' : 'false');
}

menuBtn?.addEventListener('click', () => {
  setMobileNav(!sidebarEl.classList.contains('open'));
});
backdropEl?.addEventListener('click', () => setMobileNav(false));
window.addEventListener('hashchange', () => setMobileNav(false));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sidebarEl?.classList.contains('open')) setMobileNav(false);
});

// Auto-reload on frontend update (no more hard refresh needed)
let knownHash = null;
export function updateVersionIndicator({ version, latest_version, update_available }) {
  const label = document.getElementById('versionLabel');
  const badge = document.getElementById('versionBadge');
  if (label) label.textContent = version ? 'v' + version : '-';
  if (badge) badge.hidden = !update_available;
}

// Show loading state while first poll resolves
const verLabel = document.getElementById('versionLabel');
if (verLabel) verLabel.textContent = t('common.checking');

async function checkVersion() {
  try {
    const res = await fetch('/api/version');
    const data = await res.json();
    if (knownHash === null) { knownHash = data.hash; }
    else if (data.hash !== knownHash) {
      knownHash = data.hash;
      const toast = document.getElementById('toastContainer');
      if (toast) {
        const notice = document.createElement('div');
        notice.className = 'toast info';
        notice.innerHTML = '<span>Dashboard updated. <a href="javascript:location.reload()" style="color:var(--accent);text-decoration:underline;font-weight:600">Reload now</a></span>';
        toast.appendChild(notice);
      }
    }
    updateVersionIndicator(data);
  } catch {}
}
checkVersion(); // Fire first poll immediately
setInterval(checkVersion, 15000);

// Session timeout warning - check JWT expiry every minute
if (isAuthenticated()) {
  setInterval(() => {
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      const expiresIn = (payload.exp * 1000) - Date.now();
      const minutesLeft = Math.floor(expiresIn / 60000);
      if (minutesLeft <= 0) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        window.location.hash = '#/login';
        window.location.reload();
      } else if (minutesLeft <= 30 && minutesLeft % 10 === 0) {
        // Warn at 30, 20, 10 minutes
        const toast = document.getElementById('toastContainer');
        if (toast && !toast.querySelector('.session-warn')) {
          const warn = document.createElement('div');
          warn.className = 'toast info session-warn';
          warn.innerHTML = `<span>Session expires in ${minutesLeft} minutes. <a href="#/login" style="color:var(--accent);text-decoration:underline" onclick="localStorage.removeItem('token');localStorage.removeItem('user')">Re-login</a></span>`;
          toast.appendChild(warn);
          setTimeout(() => warn.remove(), 10000);
        }
      }
    } catch {}
  }, 60000);
}
window.addEventListener('hashchange', route);
route();

// Close-modal buttons (replaces inline onclick handlers — required for CSP).
document.addEventListener('click', (e) => {
  const closer = e.target.closest('[data-close-modal]');
  if (!closer) return;
  const id = closer.dataset.closeModal;
  const modal = document.getElementById(id);
  if (modal) modal.style.display = 'none';
});
