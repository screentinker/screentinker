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
import * as designer from './views/designer.js';
import * as playlists from './views/playlists.js';

const app = document.getElementById('app');
const sidebar = document.querySelector('.sidebar');
let currentView = null;

function isAuthenticated() {
  return !!localStorage.getItem('token');
}

function getCurrentUser() {
  try {
    return JSON.parse(localStorage.getItem('user'));
  } catch { return null; }
}

function route() {
  // Cleanup previous view
  if (currentView && currentView.cleanup) currentView.cleanup();

  const hash = window.location.hash || '#/';

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
    currentView = login;
    login.render(app);
    return;
  }

  // Show sidebar for authenticated views
  sidebar.style.display = '';
  app.style.marginLeft = '';

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
  } else if (hash === '#/help' || hash.startsWith('#/help')) {
    currentView = help;
    help.render(app);
  } else if (hash === '#/admin') {
    currentView = admin;
    admin.render(app);
  } else if (hash === '#/settings') {
    currentView = settings;
    settings.render(app);
  } else if (hash === '#/billing') {
    currentView = billing;
    billing.render(app);
  } else {
    currentView = dashboard;
    dashboard.render(app);
  }
}

function updateSidebarUser() {
  const user = getCurrentUser();
  if (!user) return;

  // Show admin nav only for superadmins
  const adminNav = document.getElementById('adminNavItem');
  if (adminNav) adminNav.style.display = user.role === 'superadmin' ? '' : 'none';

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
    <button id="logoutBtn" class="btn-icon" title="Sign out" style="flex-shrink:0">
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
if (isAuthenticated()) {
  connectSocket();
}

// Register PWA service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw-admin.js').catch(() => {});
}

// Close mobile menu on navigation
window.addEventListener('hashchange', () => {
  document.querySelector('.sidebar')?.classList.remove('open');
  document.getElementById('sidebarBackdrop')?.classList.remove('open');
});

// Auto-reload on frontend update (no more hard refresh needed)
let knownHash = null;
setInterval(async () => {
  try {
    const res = await fetch('/api/version');
    const { hash } = await res.json();
    if (knownHash === null) { knownHash = hash; return; }
    if (hash !== knownHash) {
      knownHash = hash;
      const toast = document.getElementById('toastContainer');
      if (toast) {
        const notice = document.createElement('div');
        notice.className = 'toast info';
        notice.innerHTML = '<span>Dashboard updated. <a href="javascript:location.reload()" style="color:var(--accent);text-decoration:underline;font-weight:600">Reload now</a></span>';
        toast.appendChild(notice);
      }
    }
  } catch {}
}, 15000);

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
