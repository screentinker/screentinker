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
import * as slides from './views/slides.js';
import * as dataSources from './views/data-sources.js';
import * as videoWall from './views/video-wall.js';
import * as reports from './views/reports.js';
import * as servers from './views/servers.js';
import * as triggers from './views/triggers.js';
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
import { renderWorkspaceSwitcher, selectedRemoteOrg, clearRemoteOrg } from './components/workspace-switcher.js';

/*
 * ⚠️ A PERSISTENT BANNER WHILE VIEWING SOMEBODY ELSE'S SERVER, and it is not decoration.
 *
 * Every screen in the app now potentially shows another company's estate, and the single most
 * expensive mistake available here is acting on the wrong customer's screens because the page
 * looked like home. The banner names the org, says the data is read-only for now, and offers one
 * click back — so "which server am I on" is never a question the UI leaves to memory.
 */
function renderRemoteOrgBanner() {
  /*
   * ⚠️ MOUNTED IN #banners, INSIDE the content column — not prepended to <body>.
   *
   * The first version used document.body.prepend with position:sticky, which put a full-width block
   * above the app shell: it sat beside the sidebar rather than above the page, painted a slab of
   * amber down the left column and shoved the layout apart. The app already has a slot for exactly
   * this, above the view and inside the content area, and using it means the notice moves with the
   * page instead of fighting the chrome.
   *
   * ⚠️ Restrained on purpose. The workspace switcher already reads "Acme Retail · remote" a few
   * pixels away, so this is a reminder, not an alarm — a solid warning-coloured bar for a normal,
   * chosen state is the kind of thing people stop seeing within a day.
   */
  const host = document.getElementById('banners');
  if (!host) return;
  const existing = document.getElementById('remoteOrgBanner');
  const org = selectedRemoteOrg();
  if (!org) { if (existing) existing.remove(); return; }

  const el = existing || document.createElement('div');
  el.id = 'remoteOrgBanner';
  el.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;' +
    'border-left:3px solid var(--warning,#f59e0b);background:var(--bg-card);' +
    'padding:8px 12px;margin:0 0 12px;font-size:12px;border-radius:0 4px 4px 0';
  const name = String(org.name || '').replace(/[&<>"]/g, '');
  el.innerHTML = `
    <span>Viewing <strong>${name}</strong> on another server${
      org.stale ? ' — not currently reachable, showing last known state' : ''}.</span>
    <!-- ⚠️ Says what this operator may actually do, rather than a fixed "read-only for now" that
         stayed on the screen after write shipped. The flag is what the CHILD announced, so a
         customer who has granted nothing still reads as read-only — which is both true and the
         safe way for this to be wrong. Playlists only, and it says so: an operator who reads
         "you can make changes" and then cannot upload has been misled by a half-truth. -->
    <span style="color:var(--text-muted)">${org.writable
      ? 'You may change playlists here. Content and settings stay read-only.'
      : 'Read-only — this customer has not granted changes from here.'}</span>
    <button id="leaveRemoteOrg" class="btn btn-secondary btn-sm" style="margin-left:auto">
      Back to this server</button>`;
  if (!existing) host.appendChild(el);
  el.querySelector('#leaveRemoteOrg').onclick = () => { clearRemoteOrg(); window.location.reload(); };
}
import { showToast } from './components/toast.js';
import { api, meshCapability } from './api.js';
import { esc } from './utils.js';

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
  slides: 'nav.slides',
  'data-sources': 'nav.data_sources',
  schedule: 'nav.schedule',
  walls: 'nav.walls',
  reports: 'nav.reports',
  servers: 'nav.servers',
  triggers: 'nav.triggers',
  kiosk: 'nav.kiosk',
  designer: 'nav.designer',
  activity: 'nav.activity',
  teams: 'nav.teams',
  members: 'nav.members',
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
    //
    // ⚠️ Remote orgs are fetched separately and FAIL SILENTLY. A server with no mesh has no such
    // endpoint, and an install that has never heard of the feature must not see an error about it.
    // #329: /orgs is a HUB route. On a server that is not a hub it 404s, and this runs on every
    // /me refresh, so the console filled up with them. `null` means the server did not say, and
    // the old ask-and-shrug path stands.
    let remoteOrgs = [];
    if (meshCapability('hub') !== false) {
      try {
        const r = await fetch('/api/mesh/orgs', { headers: { Authorization: `Bearer ${token}` } });
        if (r.ok) remoteOrgs = (await r.json()).orgs || [];
      } catch (e) { remoteOrgs = []; }
    }
    renderWorkspaceSwitcher(fresh, remoteOrgs);
    renderRemoteOrgBanner();
    window.dispatchEvent(new CustomEvent('user-refreshed', { detail: fresh }));
    // #12: /me is the first place accessible_workspaces is known. If it resolves
    // to zero (org-less user), send them to the empty state now - on a fresh
    // load route() may have already rendered the dashboard before /me returned.
    // Guard against the login / change-password / already-there screens to avoid
    // a redirect loop.
    const hash = window.location.hash || '#/';
    if (hasNoAccessibleWorkspace(fresh)
        && hash !== '#/no-workspace' && !hash.startsWith('#/login') && hash !== '#/change-password') {
      window.location.hash = '#/no-workspace';
    }
  } catch {}
}

// Help tips are the main in-product explanation, and they were reachable by HOVER only —
// invisible on a tablet or phone, and unreachable from a keyboard. Bound once at the document
// level so every view's tips work without each having to opt in: tapping toggles one, Escape or
// a tap elsewhere closes it, and the marker is made focusable so Tab can reach it.
let tipsBound = false;
function enableHelpTips() {
  document.querySelectorAll('.help-tip:not([tabindex])').forEach((el) => {
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', el.dataset.tip || 'Help');
  });
  if (tipsBound) return;
  tipsBound = true;
  // A native title= is hover-only too, so icon-only buttons (rename a wall, remove a device
  // from one, manage members) explain themselves on a desktop and say nothing at all on a
  // touchscreen. Long-press one and show its label as a toast — the text already exists and is
  // translated, it simply had no way to reach a finger.
  let pressTimer = null;
  const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
  document.addEventListener('touchstart', (e) => {
    const el = e.target.closest('[title]');
    if (!el) return;
    const label = el.getAttribute('title');
    if (!label) return;
    pressTimer = setTimeout(() => showToast(label, 'info'), 500);
  }, { passive: true });
  ['touchend', 'touchmove', 'touchcancel'].forEach(ev =>
    document.addEventListener(ev, cancelPress, { passive: true }));
  // Views render from ~20 call sites and modals appear later still, so watch the DOM rather
  // than trying to call this after each one — a tip added by a route nobody remembered to hook
  // would otherwise be keyboard-unreachable again.
  const host = document.getElementById('app') || document.body;
  let pending = null;
  new MutationObserver(() => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      document.querySelectorAll('.help-tip:not([tabindex])').forEach((el) => {
        el.setAttribute('tabindex', '0');
        el.setAttribute('role', 'button');
        el.setAttribute('aria-label', el.dataset.tip || 'Help');
      });
    }, 50);
  }).observe(host, { childList: true, subtree: true });
  document.addEventListener('click', (e) => {
    const tip = e.target.closest('.help-tip');
    document.querySelectorAll('.help-tip.is-open').forEach((o) => { if (o !== tip) o.classList.remove('is-open'); });
    if (tip) { e.preventDefault(); tip.classList.toggle('is-open'); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.help-tip.is-open').forEach((o) => o.classList.remove('is-open'));
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('help-tip')) {
      e.preventDefault(); e.target.classList.toggle('is-open');
    }
  });
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

  // Password-reset links arrive from email on a browser that is by definition NOT logged
  // in, and carry a one-time token in the hash. This must be handled BEFORE the redirect
  // below: rewriting the hash would discard the token and the emailed link would silently
  // do nothing. The login view reads the token off the hash and shows the new-password form.
  const isResetRoute = hash.startsWith('#/reset-password');

  /*
   * ⚠️ The SAME rule the comment above states, for the login route.
   *
   * The server finishes every single sign-on by redirecting to `#/login?sso=1` (claim the session)
   * or `#/login?sso_error=<code>` (say what went wrong). Matching the hash EXACTLY meant neither
   * survived: an unauthenticated browser — the only kind that arrives here — had the hash rewritten
   * to a bare `#/login` and the query was gone before the login view ever ran. So a user who
   * authenticated perfectly at their identity provider landed back on a clean login page, still
   * signed out, with no message; and all sixteen error codes rendered SILENCE, which is worse than
   * a wrong message because there is nothing to report or search for.
   *
   * It took the pre-existing `?verified=1` email-verification toast with it.
   */
  const isLoginRoute = hash === '#/login' || hash.startsWith('#/login?');

  // Auth check - redirect to login if not authenticated
  if (!isAuthenticated() && !isLoginRoute && !isResetRoute) {
    window.location.hash = '#/login';
    return;
  }

  // If authenticated and on login page, redirect to dashboard or onboarding
  if (isAuthenticated() && (isLoginRoute || isResetRoute)) {
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

  // Login page (and password-reset links from email) - hide sidebar.
  // Matches `#/login?...` too: the single sign-on return carries `?sso=1` / `?sso_error=<code>`,
  // and an exact comparison meant the login view was never rendered for either.
  if (isLoginRoute || isResetRoute) {
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
    else if (hash === '#/slides' && link.dataset.view === 'slides') link.classList.add('active');
    else if ((hash === '#/data-sources' || hash.startsWith('#/data-sources/')) && link.dataset.view === 'data-sources') link.classList.add('active');
    else if ((hash.startsWith('#/wall') || hash === '#/walls') && link.dataset.view === 'walls') link.classList.add('active');
    else if (hash === '#/reports' && link.dataset.view === 'reports') link.classList.add('active');
    else if (hash === '#/activity' && link.dataset.view === 'activity') link.classList.add('active');
    else if ((hash === '#/designer' || hash.startsWith('#/designer/')) && link.dataset.view === 'designer') link.classList.add('active');
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
  } else if (hash === '#/slides') {
    currentView = slides;
    slides.render(app);
  } else if (hash === '#/data-sources' || hash.startsWith('#/data-sources/')) {
    currentView = dataSources;
    dataSources.render(app);
  } else if (hash === '#/widgets') {
    currentView = widgets;
    widgets.render(app);
  } else if (hash === '#/walls' || hash.startsWith('#/wall/')) {
    currentView = videoWall;
    videoWall.render(app);
  } else if (hash === '#/triggers') {
    currentView = triggers;
    triggers.render(app);
  } else if (hash === '#/servers') {
    /*
     * ⚠️ Its own route, deliberately NOT behind the workspace switcher. The switcher
     * mints a JWT with current_workspace_id and reloads — it assumes a LOCAL, WRITABLE
     * workspace. Putting remote ones behind it would give every write surface (bulk
     * assign, drag-to-group, playlist assign, the schedule editor) a disabled state,
     * and a UI full of dead controls teaches people the product is broken.
     */
    currentView = servers;
    servers.render(app);
  } else if (hash === '#/reports') {
    currentView = reports;
    reports.render(app);
  } else if (hash === '#/kiosk' || hash.startsWith('#/kiosk/')) {
    currentView = kiosk;
    kiosk.render(app);
  } else if (hash === '#/designer' || hash.startsWith('#/designer/')) {
    currentView = designer;
    // #/designer/<widgetId> reopens a designer-made widget for editing; #/designer starts fresh.
    const wid = hash.startsWith('#/designer/') ? hash.split('#/designer/')[1].split('/')[0] : null;
    designer.render(app, wid || undefined);
  } else if (hash === '#/activity') {
    currentView = activity;
    activity.render(app);
  } else if (hash === '#/teams' || hash.startsWith('#/team/')) {
    currentView = teams;
    teams.render(app);
  } else if (hash === '#/members') {
    // The static nav link cannot know the workspace id, so resolve it here from the signed-in
    // user. Falls back to the first accessible workspace, and to the dashboard when there is
    // none at all — better than rendering a members page for nothing.
    // /me is cached in localStorage by refreshCurrentUser(); there is no in-memory copy.
    let me = null;
    try { me = JSON.parse(localStorage.getItem('user') || 'null'); } catch (_) { me = null; }
    const activeWs = me?.current_workspace_id
      || (Array.isArray(me?.accessible_workspaces) && me.accessible_workspaces[0]?.id);
    if (!activeWs) { window.location.hash = '#/'; return; }
    currentView = workspaceMembers;
    workspaceMembers.render(app, activeWs);
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
  updateVerifyBanner(user);
  updateWidgetSandboxWarningBanner(user);

  // Show admin nav only for platform admins (legacy 'superadmin' or Phase 1 renamed 'platform_admin')
  const adminNav = document.getElementById('adminNavItem');
  if (adminNav) adminNav.style.display = isPlatformAdmin(user) ? '' : 'none';

  // #116: hide the Subscription nav item when HIDE_BILLING is set (surfaced on /me).
  // Runs at boot from the cached user (no flash on warm loads) and again after /me.
  const billingNav = document.getElementById('billingNavItem');
  if (billingNav) billingNav.style.display = user.hide_billing ? 'none' : '';

  /*
   * Servers appears only when this node is actually a hub.
   *
   * ⚠️ ASKED, NOT ASSUMED. There is no client-side flag for MESH_ACCEPT_ENROLLMENT and there should
   * not be: the server mounts /api/mesh only when it is set, so the honest test is whether the API
   * answers. A hardcoded flag in the bundle would drift the moment someone changed the env var.
   *
   * It starts hidden and is revealed on success, so an ordinary install never flashes a section it
   * does not have — the same no-flash reasoning as the billing item above.
   */
  const serversNav = document.getElementById('serversNavItem');
  if (serversNav) {
    /*
     * ⚠️ EITHER ROLE REVEALS IT, and gating on the hub role alone was a real bug.
     *
     * /mesh/nodes exists only when MESH_ACCEPT_ENROLLMENT is set — the HUB half. A node configured
     * only to report UPWARD has no such route, so the section stayed hidden — and the Connect tab,
     * which is how that node enrols and how its operator later severs the link, lives inside the
     * section. A child could be configured to join a mesh and then had no way to do it, or to see
     * that it had.
     *
     * That directly contradicts consent-from-below, which the API already honours: GET /mesh/uplink
     * answers whatever the flags say, precisely so a link can never be made and then hidden. The nav
     * gate defeated it one layer up.
     *
     * /mesh/capabilities is mounted when EITHER flag is on, or when an uplink already exists, so it
     * is the honest question to ask: "is this node part of a mesh in any way?"
     */
    /*
     * #329: /me answers this now, so the common case costs no requests at all. The probe below is
     * kept for when it does NOT answer — a server older than this field, or a cached user from
     * before it — because a silent `false` there would hide the section on a real mesh node.
     */
    const meshEnroll = meshCapability('enroll');
    if (meshEnroll !== null) {
      serversNav.style.display = meshEnroll ? '' : 'none';
    } else {
      api.get('/mesh/capabilities')
        .then(() => { serversNav.style.display = ''; })
        .catch(() => api.get('/mesh/nodes')
          .then(() => { serversNav.style.display = ''; })
          .catch(() => { serversNav.style.display = 'none'; }));
    }
  }

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
      `<div style="width:28px;height:28px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:white">${esc((user.name || user.email)[0].toUpperCase())}</div>`}
    <div style="flex:1;min-width:0">
      <div style="font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(user.name || user.email)}</div>
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

// Soft-nudge banner for a logged-in but unverified local user (self-host path — hosted never
// issues a session while unverified, so this only appears there). Sits above #app so it persists
// across view swaps. Only shown when email_verified is explicitly 0 (undefined on stale caches
// stays hidden). Cleared automatically once the account verifies.
function updateVerifyBanner(user) {
  const existing = document.getElementById('verifyBanner');
  const unverified = user && user.email_verified === 0 && user.auth_provider === 'local';
  if (!unverified) { if (existing) existing.remove(); return; }
  if (existing) return;
  const bannersEl = document.getElementById('banners');
  if (!bannersEl) return;
  const b = document.createElement('div');
  b.id = 'verifyBanner';
  b.style.cssText = 'background:var(--warning,#f59e0b);color:#1a1200;padding:9px 16px;font-size:13px;display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap';
  b.innerHTML = `<span>✉️ ${t('auth.verify_banner')}</span>`;
  const btn = document.createElement('button');
  btn.className = 'btn btn-sm';
  btn.style.cssText = 'background:#1a1200;color:#fff;padding:4px 12px';
  btn.textContent = t('auth.verify_banner_resend');
  btn.addEventListener('click', async () => {
    try { await api.resendVerification(user.email); showToast(t('auth.verify_resent'), 'success'); }
    catch { showToast(t('auth.verify_resend_failed'), 'error'); }
  });
  b.appendChild(btn);
  bannersEl.appendChild(b);
}

function updateWidgetSandboxWarningBanner(user) {
  const existing = document.getElementById('widgetSandboxWarningBanner');
  const disabled = !!user?.current_organization?.widget_sandbox_isolation_disabled;
  if (!disabled) { if (existing) existing.remove(); return; }
  if (existing) return;
  const bannersEl = document.getElementById('banners');
  if (!bannersEl) return;
  const b = document.createElement('div');
  b.id = 'widgetSandboxWarningBanner';
  b.style.cssText = 'background:var(--danger,#dc2626);color:#fff;padding:10px 16px;font-size:13px;display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;font-weight:600';
  const text = document.createElement('span');
  text.style.whiteSpace = 'pre-line';
  text.textContent = 'Widget sandbox isolation is DISABLED. Widget code in this organization runs\nwith full access to user sessions. Re-enable in Settings > Security.';
  const link = document.createElement('a');
  link.href = '#/settings';
  link.textContent = 'Open Settings';
  link.style.cssText = 'color:#fff;text-decoration:underline;font-weight:700';
  b.appendChild(text);
  b.appendChild(link);
  bannersEl.appendChild(b);
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
  // Published like window.__ST_BRAND_NAME, and for the same reason: things that need the running
  // version should not each fetch it. components/whats-new.js reads this to decide whether it has
  // anything to fetch at all, so a dashboard load on an unchanged build costs no extra request.
  try { if (version) window.__ST_VERSION = version; } catch (_) { /* non-fatal */ }
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
        const span = document.createElement('span');
        span.textContent = 'Dashboard updated. ';
        const link = document.createElement('a');
        link.textContent = 'Reload now';
        link.href = '#';
        link.style.cssText = 'color:var(--accent);text-decoration:underline;font-weight:600';
        // The dashboard CSP is `script-src 'self'` (no 'unsafe-inline'), which blocks
        // `javascript:` URIs — so the old `href="javascript:location.reload()"` link was dead
        // (click did nothing, only a CSP console warning). Use a real click listener, which
        // runs as first-party script and is CSP-clean.
        link.addEventListener('click', (e) => { e.preventDefault(); location.reload(); });
        span.appendChild(link);
        notice.appendChild(span);
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
enableHelpTips();
route();

// Close-modal buttons (replaces inline onclick handlers — required for CSP).
document.addEventListener('click', (e) => {
  const closer = e.target.closest('[data-close-modal]');
  if (!closer) return;
  const id = closer.dataset.closeModal;
  const modal = document.getElementById(id);
  if (modal) modal.style.display = 'none';
});
