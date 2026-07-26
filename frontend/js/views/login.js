import { showToast } from '../components/toast.js';
import { t } from '../i18n.js';

let authConfig = null;

async function loadAuthConfig() {
  if (authConfig) return authConfig;
  const res = await fetch('/api/auth/config');
  authConfig = await res.json();
  return authConfig;
}

// #15: resolve instance/default branding for the (pre-login) login page.
// Public endpoint: custom-domain match -> platform default -> SwiftDisplay.
async function loadLoginBranding() {
  try {
    const res = await fetch('/api/branding?domain=' + encodeURIComponent(location.hostname));
    if (!res.ok) return {};
    return await res.json();
  } catch { return {}; }
}

function brandEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Apply document-level branding (colors, favicon, title, custom CSS) for login.
function applyLoginBrandingDoc(b) {
  const root = document.documentElement;
  if (b.primary_color) root.style.setProperty('--accent', b.primary_color);
  if (b.bg_color) root.style.setProperty('--bg-primary', b.bg_color);
  if (b.brand_name) document.title = b.brand_name;
  if (b.favicon_url) {
    document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]').forEach(l => l.setAttribute('href', b.favicon_url));
  }
  if (b.custom_css) {
    let style = document.getElementById('wl-custom-css');
    if (!style) { style = document.createElement('style'); style.id = 'wl-custom-css'; document.head.appendChild(style); }
    style.textContent = b.custom_css;
  }
}

export async function render(container) {
  const [config, branding] = await Promise.all([loadAuthConfig(), loadLoginBranding()]);
  const isSetup = config.needsSetup;
  // registration_enabled may be absent on older servers — treat as enabled for back-compat
  const canRegister = false;

  applyLoginBrandingDoc(branding);
  const brandName = branding.brand_name || 'SwiftDisplay';
  // Branded logo if set, else the default SwiftDisplay glyph.
  const logoHtml = branding.logo_url
    ? `<img src="${brandEsc(branding.logo_url)}" alt="${brandEsc(brandName)}" style="max-height:48px;max-width:200px;margin:0 auto 12px;display:block">`
    : `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" style="margin:0 auto 12px">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
          </svg>`;

  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px">
      <div style="width:400px;max-width:100%">
        <div style="text-align:center;margin-bottom:32px">
          ${logoHtml}
          <p style="color:#ffffff;font-size:13px;margin-top:4px">
            ${isSetup ? t('auth.subtitle_setup') : t('auth.subtitle_signin')}
          </p>
          ${!isSetup && canRegister ? `<p style="color:var(--warning);font-size:12px;margin-top:8px">${t('auth.trial_notice')}</p>` : ''}
        </div>

        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px">
          <!-- Local Auth Form -->
          <div id="localAuthForm">
            <div class="form-group">
              <label>${t('auth.email')}</label>
              <input type="email" id="loginEmail" class="input" placeholder="${t('auth.placeholder_email')}" autocomplete="email">
            </div>
            <div class="form-group">
              <label>${t('auth.password')}</label>
              <input type="password" id="loginPassword" class="input" placeholder="${t('auth.placeholder_password')}" autocomplete="current-password">
            </div>
            ${isSetup ? `
            <div class="form-group">
              <label>${t('auth.name')}</label>
              <input type="text" id="loginName" class="input" placeholder="${t('auth.placeholder_name')}">
            </div>
            ` : ''}
            <button class="btn btn-primary" id="loginBtn" style="width:100%;justify-content:center;padding:10px">
              ${isSetup ? t('auth.create_admin_account') : t('auth.sign_in')}
            </button>
            ${!isSetup && canRegister ? `
            <button class="btn btn-secondary" id="showRegisterBtn" style="width:100%;justify-content:center;padding:10px;margin-top:8px">
              ${t('auth.create_account')}
            </button>
            ` : ''}
          </div>

          <!-- Register form (hidden by default) -->
          <div id="registerForm" style="display:none">
            <div class="form-group">
              <label>${t('auth.name')}</label>
              <input type="text" id="regName" class="input" placeholder="${t('auth.placeholder_name')}">
            </div>
            <div class="form-group">
              <label>${t('auth.email')}</label>
              <input type="email" id="regEmail" class="input" placeholder="${t('auth.placeholder_email')}">
            </div>
            <div class="form-group">
              <label>${t('auth.password')}</label>
              <input type="password" id="regPassword" class="input" placeholder="${t('auth.placeholder_register_password')}">
            </div>
            <button class="btn btn-primary" id="registerBtn" style="width:100%;justify-content:center;padding:10px">
              ${t('auth.create_account')}
            </button>
            <button class="btn btn-secondary" id="showLoginBtn" style="width:100%;justify-content:center;padding:10px;margin-top:8px">
              ${t('auth.back_to_signin')}
            </button>
          </div>

          ${config.googleEnabled || config.microsoftEnabled ? `
          <div style="display:flex;align-items:center;gap:12px;margin:20px 0">
            <hr style="flex:1;border-color:var(--border)">
            <span style="color:var(--text-muted);font-size:12px">${t('auth.divider_or')}</span>
            <hr style="flex:1;border-color:var(--border)">
          </div>
          ` : ''}

          ${config.googleEnabled ? `
          <div id="googleSignInContainer">
            <button class="btn btn-secondary" id="googleSignInBtn" style="width:100%;justify-content:center;padding:10px;gap:8px">
              <svg width="18" height="18" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              ${t('auth.signin_google')}
            </button>
          </div>
          ` : ''}

          ${config.microsoftEnabled ? `
          <button class="btn btn-secondary" id="microsoftSignInBtn" style="width:100%;justify-content:center;padding:10px;gap:8px;margin-top:8px">
            <svg width="18" height="18" viewBox="0 0 21 21">
              <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
              <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
              <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
              <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
            </svg>
            ${t('auth.signin_microsoft')}
          </button>
          ` : ''}
        </div>

        <!-- Support Access (collapsible) -->
        <details style="margin-top:16px">
          <summary style="font-size:11px;color:var(--text-muted);cursor:pointer;text-align:center">${t('auth.support_access')}</summary>
          <div style="margin-top:8px">
            <input type="text" id="supportToken" class="input" placeholder="${t('auth.support_token_placeholder')}" style="font-family:monospace">
            <button class="btn btn-secondary" id="supportLoginBtn" style="width:100%;justify-content:center;padding:8px;margin-top:6px;font-size:12px">${t('auth.support_authenticate')}</button>
          </div>
        </details>

        <p id="loginError" style="color:var(--danger);font-size:12px;text-align:center;margin-top:12px;display:none"></p>
        <p style="text-align:center;margin-top:16px;font-size:11px;color:var(--text-muted)">
          <a href="/legal/terms.html" target="_blank" style="color:var(--text-muted);text-decoration:underline">${t('auth.terms')}</a>
          &nbsp;&middot;&nbsp;
          <a href="/legal/privacy.html" target="_blank" style="color:var(--text-muted);text-decoration:underline">${t('auth.privacy')}</a>
        </p>
      </div>
    </div>
  `;

  setupHandlers(config, isSetup);
}

function setupHandlers(config, isSetup) {
  const showError = (msg) => {
    const el = document.getElementById('loginError');
    el.textContent = msg;
    el.style.display = 'block';
  };

  // Support token login
  document.getElementById('supportLoginBtn')?.addEventListener('click', async () => {
    const token = document.getElementById('supportToken')?.value.trim();
    if (!token) { showError(t('auth.error_paste_support_token')); return; }
    try {
      const res = await fetch('/api/auth/support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const data = await res.json();
      if (!res.ok) { showError(data.error); return; }
      onAuthSuccess(data);
    } catch (err) { showError(t('auth.error_support_failed')); }
  });

  // Local login/register
  if (isSetup) {
    document.getElementById('loginBtn')?.addEventListener('click', () => doRegister(true));
  } else {
    document.getElementById('loginBtn')?.addEventListener('click', doLogin);
    document.getElementById('showRegisterBtn')?.addEventListener('click', () => {
      document.getElementById('localAuthForm').style.display = 'none';
      document.getElementById('registerForm').style.display = 'block';
    });
    document.getElementById('showLoginBtn')?.addEventListener('click', () => {
      document.getElementById('localAuthForm').style.display = 'block';
      document.getElementById('registerForm').style.display = 'none';
    });
    document.getElementById('registerBtn')?.addEventListener('click', () => doRegister(false));
  }

  // Enter key on password field
  document.getElementById('loginPassword')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') isSetup ? doRegister(true) : doLogin();
  });

  async function doLogin() {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    if (!email || !password) { showError(t('auth.error_email_password_required')); return; }

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok) { showError(data.error); return; }
      onAuthSuccess(data);
    } catch (err) {
      showError(t('auth.error_login_failed'));
    }
  }

  async function doRegister(isFirstUser) {
    const email = document.getElementById(isFirstUser ? 'loginEmail' : 'regEmail').value.trim();
    const password = document.getElementById(isFirstUser ? 'loginPassword' : 'regPassword').value;
    const name = document.getElementById(isFirstUser ? 'loginName' : 'regName')?.value.trim() || '';
    if (!email || !password) { showError(t('auth.error_email_password_required')); return; }
    if (password.length < 6) { showError(t('auth.error_password_min_6')); return; }

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name })
      });
      const data = await res.json();
      if (!res.ok) { showError(data.error); return; }
      onAuthSuccess(data);
    } catch (err) {
      showError(t('auth.error_registration_failed'));
    }
  }

  // Google Sign-In
  if (config.googleEnabled) {
    document.getElementById('googleSignInBtn')?.addEventListener('click', async () => {
      try {
        // Use Google's popup-based sign in
        const client = google.accounts.oauth2.initTokenClient({
          client_id: config.googleClientId,
          scope: 'email profile',
          callback: async (response) => {
            if (response.access_token) {
              // Get ID token via Google's tokeninfo
              const tokenRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${response.access_token}`);
              const tokenData = await tokenRes.json();
              // Send to our server
              const res = await fetch('/api/auth/google', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ credential: response.access_token, email: tokenData.email })
              });
              const data = await res.json();
              if (res.ok) onAuthSuccess(data);
              else showError(data.error);
            }
          }
        });
        client.requestAccessToken();
      } catch (err) {
        showError(t('auth.error_google_failed'));
      }
    });
  }

  // Microsoft Sign-In
  if (config.microsoftEnabled) {
    document.getElementById('microsoftSignInBtn')?.addEventListener('click', async () => {
      try {
        const msalConfig = {
          auth: {
            clientId: config.microsoftClientId,
            authority: `https://login.microsoftonline.com/${config.microsoftTenantId}`,
            redirectUri: window.location.origin
          }
        };
        const msalInstance = new msal.PublicClientApplication(msalConfig);
        await msalInstance.initialize();
        const loginResponse = await msalInstance.loginPopup({ scopes: ['User.Read'] });
        if (loginResponse.accessToken) {
          const res = await fetch('/api/auth/microsoft', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ access_token: loginResponse.accessToken })
          });
          const data = await res.json();
          if (res.ok) onAuthSuccess(data);
          else showError(data.error);
        }
      } catch (err) {
        showError(t('auth.error_microsoft_failed'));
      }
    });
  }
}

function onAuthSuccess(data) {
  localStorage.setItem('token', data.token);
  localStorage.setItem('user', JSON.stringify(data.user));
  window.location.hash = '#/';
  window.location.reload();
}

export function cleanup() {}
