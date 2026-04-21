import { showToast } from '../components/toast.js';

let authConfig = null;

async function loadAuthConfig() {
  if (authConfig) return authConfig;
  const res = await fetch('/api/auth/config');
  authConfig = await res.json();
  return authConfig;
}

export async function render(container) {
  const config = await loadAuthConfig();
  const isSetup = config.needsSetup;

  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px">
      <div style="width:400px;max-width:100%">
        <div style="text-align:center;margin-bottom:32px">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" style="margin:0 auto 12px">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
          <h1 style="font-size:24px;font-weight:700;color:var(--accent)">ScreenTinker</h1>
          <p style="color:var(--text-secondary);font-size:13px;margin-top:4px">
            ${isSetup ? 'Create your admin account to get started' : 'Sign in to manage your displays'}
          </p>
          ${isSetup ? '' : '<p style="color:var(--warning);font-size:12px;margin-top:8px">New accounts get a 14-day free Pro trial</p>'}
        </div>

        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px">
          <!-- Local Auth Form -->
          <div id="localAuthForm">
            <div class="form-group">
              <label>Email</label>
              <input type="email" id="loginEmail" class="input" placeholder="you@example.com" autocomplete="email">
            </div>
            <div class="form-group">
              <label>Password</label>
              <input type="password" id="loginPassword" class="input" placeholder="••••••••" autocomplete="current-password">
            </div>
            ${isSetup ? `
            <div class="form-group">
              <label>Name</label>
              <input type="text" id="loginName" class="input" placeholder="Your name">
            </div>
            ` : ''}
            <button class="btn btn-primary" id="loginBtn" style="width:100%;justify-content:center;padding:10px">
              ${isSetup ? 'Create Admin Account' : 'Sign In'}
            </button>
            ${!isSetup ? `
            <button class="btn btn-secondary" id="showRegisterBtn" style="width:100%;justify-content:center;padding:10px;margin-top:8px">
              Create Account
            </button>
            ` : ''}
          </div>

          <!-- Register form (hidden by default) -->
          <div id="registerForm" style="display:none">
            <div class="form-group">
              <label>Name</label>
              <input type="text" id="regName" class="input" placeholder="Your name">
            </div>
            <div class="form-group">
              <label>Email</label>
              <input type="email" id="regEmail" class="input" placeholder="you@example.com">
            </div>
            <div class="form-group">
              <label>Password</label>
              <input type="password" id="regPassword" class="input" placeholder="At least 6 characters">
            </div>
            <button class="btn btn-primary" id="registerBtn" style="width:100%;justify-content:center;padding:10px">
              Create Account
            </button>
            <button class="btn btn-secondary" id="showLoginBtn" style="width:100%;justify-content:center;padding:10px;margin-top:8px">
              Back to Sign In
            </button>
          </div>

          ${config.googleEnabled || config.microsoftEnabled ? `
          <div style="display:flex;align-items:center;gap:12px;margin:20px 0">
            <hr style="flex:1;border-color:var(--border)">
            <span style="color:var(--text-muted);font-size:12px">OR</span>
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
              Sign in with Google
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
            Sign in with Microsoft
          </button>
          ` : ''}
        </div>

        <!-- Support Access (collapsible) -->
        <details style="margin-top:16px">
          <summary style="font-size:11px;color:var(--text-muted);cursor:pointer;text-align:center">Support Access</summary>
          <div style="margin-top:8px">
            <input type="text" id="supportToken" class="input" placeholder="Paste support token" style="font-family:monospace">
            <button class="btn btn-secondary" id="supportLoginBtn" style="width:100%;justify-content:center;padding:8px;margin-top:6px;font-size:12px">Authenticate with Support Token</button>
          </div>
        </details>

        <p id="loginError" style="color:var(--danger);font-size:12px;text-align:center;margin-top:12px;display:none"></p>
        <p style="text-align:center;margin-top:16px;font-size:11px;color:var(--text-muted)">
          <a href="/legal/terms.html" target="_blank" style="color:var(--text-muted);text-decoration:underline">Terms of Service</a>
          &nbsp;&middot;&nbsp;
          <a href="/legal/privacy.html" target="_blank" style="color:var(--text-muted);text-decoration:underline">Privacy Policy</a>
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
    if (!token) { showError('Paste a support token'); return; }
    try {
      const res = await fetch('/api/auth/support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const data = await res.json();
      if (!res.ok) { showError(data.error); return; }
      onAuthSuccess(data);
    } catch (err) { showError('Support login failed'); }
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
    if (!email || !password) { showError('Email and password required'); return; }

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
      showError('Login failed');
    }
  }

  async function doRegister(isFirstUser) {
    const email = document.getElementById(isFirstUser ? 'loginEmail' : 'regEmail').value.trim();
    const password = document.getElementById(isFirstUser ? 'loginPassword' : 'regPassword').value;
    const name = document.getElementById(isFirstUser ? 'loginName' : 'regName')?.value.trim() || '';
    if (!email || !password) { showError('Email and password required'); return; }
    if (password.length < 6) { showError('Password must be at least 6 characters'); return; }

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
      showError('Registration failed');
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
        showError('Google sign-in failed');
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
        showError('Microsoft sign-in failed');
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
