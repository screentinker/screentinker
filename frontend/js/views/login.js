import { showToast } from '../components/toast.js';
import { loginFormState } from '../lib/login-form-state.js';
import { t } from '../i18n.js';
import { esc } from '../utils.js';


/*
 * A recognisable mark for the providers people expect to see, and an honest generic one for
 * everything else. Inline SVG rather than a remote image: an <img> to a provider CDN would put a
 * third-party origin back into the CSP, which is precisely what moving the flow server-side removed.
 */
const PROVIDER_ICONS = {
  google: `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
  </svg>`,
  microsoft: `<svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
    <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
    <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
    <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
    <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
  </svg>`,
};

const GENERIC_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
  <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
</svg>`;

const providerIcon = (slug) => PROVIDER_ICONS[slug] || GENERIC_ICON;

let authConfig = null;

async function loadAuthConfig() {
  if (authConfig) return authConfig;
  const res = await fetch('/api/auth/config');
  authConfig = await res.json();
  return authConfig;
}

// #15: resolve instance/default branding for the (pre-login) login page.
// Public endpoint: custom-domain match -> platform default -> ScreenTinker.
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
  const canRegister = config.registration_enabled !== false;

  applyLoginBrandingDoc(branding);
  const brandName = branding.brand_name || 'ScreenTinker';
  // Branded logo if set, else the default ScreenTinker glyph.
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
          <h1 style="font-size:24px;font-weight:700;color:var(--accent)">${brandEsc(brandName)}</h1>
          <p style="color:var(--text-secondary);font-size:13px;margin-top:4px">
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
              <label id="loginPasswordLabel" for="loginPassword">${t('auth.password')}</label>
              <input type="password" id="loginPassword" class="input" placeholder="${t('auth.placeholder_password')}" autocomplete="current-password">
            <!-- Filled in only when the typed email belongs to an organization that has configured
                 its own identity provider. A customer's IdP is never listed to everyone: the button
                 appears for the people it belongs to and nobody else, which also keeps the customer
                 list off the login page.

                 ⚠️ BELOW the input, inside the same group. Above it, the button sat between the
                 "Password" label and its field — so the label described the SSO button and the
                 password box had none at all. It has to stay INSIDE the group, because hiding the
                 group is how the password is hidden and the button must survive that... which is
                 exactly why setPasswordVisible() hides the FIELD, never the container. -->
            <div id="orgSsoSlot" style="display:none;margin-top:12px"></div>
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
            ${!isSetup ? `
            <p style="text-align:center;margin-top:10px">
              <a href="#" id="forgotLink" style="color:var(--text-secondary);font-size:12px;text-decoration:none">${t('auth.forgot_password')}</a>
            </p>
            ` : ''}
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

          <!-- TOTP 2FA challenge (hidden until /login returns mfa_required) -->
          <div id="mfaForm" style="display:none">
            <h2 style="font-size:16px;font-weight:600;margin-bottom:6px">${t('auth.mfa_title')}</h2>
            <p style="color:var(--text-secondary);font-size:13px;margin-bottom:14px">${t('auth.mfa_prompt')}</p>
            <div class="form-group">
              <label>${t('auth.mfa_code_label')}</label>
              <input type="text" id="mfaCode" class="input" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false"
                     placeholder="123456" maxlength="12" style="letter-spacing:6px;text-align:center;font-family:monospace;font-size:18px">
            </div>
            <button class="btn btn-primary" id="mfaVerifyBtn" style="width:100%;justify-content:center;padding:10px">${t('auth.mfa_verify')}</button>
            <button class="btn btn-secondary" id="mfaBackBtn" style="width:100%;justify-content:center;padding:10px;margin-top:8px">${t('auth.back_to_signin')}</button>
            <p style="color:var(--text-muted);font-size:11px;text-align:center;margin-top:12px">${t('auth.mfa_recovery_hint')}</p>
          </div>

          <!-- Email-verification notice (hidden until a verification_required response) -->
          <div id="verifyNotice" style="display:none;text-align:center">
            <div style="font-size:42px;line-height:1;margin-bottom:10px">✉️</div>
            <h2 style="font-size:18px;font-weight:600;margin-bottom:8px">${t('auth.verify_title')}</h2>
            <p style="color:var(--text-secondary);font-size:13px;margin-bottom:6px">${t('auth.verify_body')}</p>
            <p style="font-weight:600;font-size:14px;margin-bottom:16px"><span id="verifyEmail"></span></p>
            <button class="btn btn-secondary" id="verifyResendBtn" style="width:100%;justify-content:center;padding:10px">${t('auth.verify_resend')}</button>
            <button class="btn btn-secondary" id="verifyBackBtn" style="width:100%;justify-content:center;padding:10px;margin-top:8px">${t('auth.back_to_signin')}</button>
          </div>

          <div id="ssoBlock">
          ${(config.providers || []).length ? `
          <div id="ssoDivider" style="display:flex;align-items:center;gap:12px;margin:20px 0">
            <hr style="flex:1;border-color:var(--border)">
            <span style="color:var(--text-muted);font-size:12px">${t('auth.divider_or')}</span>
            <hr style="flex:1;border-color:var(--border)">
          </div>
          ` : ''}

          <!-- One button per configured provider, and each is a plain LINK to a server endpoint.
               There is no provider SDK on this page: the browser never speaks to the identity
               provider directly, so nothing here needs a client id and the CSP needs no
               third-party script origin. Google and Microsoft are ordinary entries in this list.
               The icon is chosen by slug where we have one and falls back to a generic mark, so a
               self-hoster's Keycloak or Authentik still gets a real-looking button. -->
          <!-- Wrapped so the whole set can be hidden at once: an organization that REQUIRES its own
               identity provider must not be shown the operator's, which are not domain-confined. -->
          <div id="instanceProviders">
          ${(config.providers || []).map((p) => `
          <a class="btn btn-secondary" href="/api/auth/oidc/${encodeURIComponent(p.slug)}/start"
             id="sso-${esc(p.slug)}"
             style="width:100%;justify-content:center;padding:10px;gap:8px;margin-top:8px;text-decoration:none">
            ${providerIcon(p.slug)}
            ${esc(t('auth.signin_with', { provider: p.name }))}
          </a>
          `).join('')}
          </div>
          </div>
        </div>

        <!-- Support Access (collapsible) -->
        <details id="supportDetails" style="margin-top:16px">
          <summary style="font-size:11px;color:var(--text-muted);cursor:pointer;text-align:center">${t('auth.support_access')}</summary>
          <div style="margin-top:8px">
            <input type="text" id="supportToken" class="input" placeholder="${t('auth.support_token_placeholder')}" style="font-family:monospace">
            <button class="btn btn-secondary" id="supportLoginBtn" style="width:100%;justify-content:center;padding:8px;margin-top:6px;font-size:12px">${t('auth.support_authenticate')}</button>
          </div>
        </details>

        <div id="forgotForm" style="display:none">
          <div class="form-group">
            <label>${t('auth.email')}</label>
            <input type="email" id="forgotEmail" class="input" placeholder="${t('auth.placeholder_email')}" autocomplete="email">
          </div>
          <button class="btn btn-primary" id="forgotSendBtn" style="width:100%;justify-content:center;padding:10px">${t('auth.forgot_send')}</button>
          <button class="btn btn-secondary" id="forgotBackBtn" style="width:100%;justify-content:center;padding:10px;margin-top:8px">${t('auth.back_to_signin')}</button>
          <p id="forgotNotice" style="color:var(--text-secondary);font-size:12px;text-align:center;margin-top:12px;display:none">${t('auth.forgot_sent')}</p>
        </div>
        <div id="resetForm" style="display:none">
          <div class="form-group">
            <label>${t('auth.new_password')}</label>
            <input type="password" id="resetPassword" class="input" placeholder="${t('auth.placeholder_register_password')}" autocomplete="new-password">
          </div>
          <button class="btn btn-primary" id="resetSubmitBtn" style="width:100%;justify-content:center;padding:10px">${t('auth.reset_submit')}</button>
          <button class="btn btn-secondary" id="resetBackBtn" style="width:100%;justify-content:center;padding:10px;margin-top:8px">${t('auth.back_to_signin')}</button>
        </div>
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

  // Outcome of clicking the email-verification link (server GET /verify-email redirects here).
  const hashQuery = new URLSearchParams((location.hash.split('?')[1]) || '');
  if (hashQuery.get('verified') === '1') showToast(t('auth.verify_ok'), 'success');
  else if (hashQuery.get('verify_error') === '1') showToast(t('auth.verify_failed'), 'error');

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
    /*
     * Identifier-first. The button is "Next" until an address has been submitted: we ask the server
     * what that address uses BEFORE offering a credential, so an SSO-only user is never shown a
     * password box that is going to be refused, and the org lookup has somewhere to happen.
     */
    document.getElementById('loginBtn')?.addEventListener('click', () => {
      if (identified && !ssoOnlyDomain) return doLogin();
      identify();
    });
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

  /*
   * Enter in the EMAIL field advances rather than submitting. During first-run setup both fields
   * are needed at once, so identifier-first is skipped entirely there.
   */
  document.getElementById('loginEmail')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (isSetup) return doRegister(true);
    if (identified && !ssoOnlyDomain) return doLogin();
    identify();
  });

  /*
   * Editing the address after identifying returns to the identifier step. Someone who mistypes
   * their domain must get a fresh answer rather than keep the previous domain's one.
   */
  document.getElementById('loginEmail')?.addEventListener('input', () => {
    // Nothing to step back to during first-run setup - there is no identifier step. This used to
    // fire on the first keystroke and hide the password field the operator was about to fill in.
    if (isSetup) return;
    if (!identified) return;
    identified = false;
    applyFormState();
  });

  /*
   * Ask what this address uses, then show the right thing. The lookup itself sets ssoOnlyDomain via
   * setPasswordVisible(), so this only has to decide that we now know who is signing in.
   */
  async function identify() {
    const email = document.getElementById('loginEmail').value.trim();
    if (!email || !email.includes('@')) { showError(t('auth.error_email_required')); return; }
    try { await lookupOrgSso(email); } catch { /* lookup failures fall through to the password box */ }
    identified = true;
    applyFormState();
    if (!ssoOnlyDomain) document.getElementById('loginPassword')?.focus();
  }

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
      /*
       * The organization requires its identity provider, so this is not a credential failure and
       * must not read like one — "invalid password" sends the user to reset a password that will
       * never work again. Point them at the control that does work.
       */
      if (!res.ok && data.code === 'sso_required') { showError(t('auth.sso_required')); return; }
      if (!res.ok) { showError(data.error); return; }
      // Unverified account (hosted hard-gate): no session — prompt to check email.
      if (data.verification_required) { showVerifyNotice(data.email || email); return; }
      // #100: TOTP-enabled accounts get no session yet — a second step verifies a code.
      if (data.mfa_required) { showMfaChallenge(data.mfa_token); return; }
      onAuthSuccess(data);
    } catch (err) {
      showError(t('auth.error_login_failed'));
    }
  }

  // "Check your email" panel shown when signup/login returns verification_required (hosted).
  // ---- Self-service password reset -------------------------------------------------
  // Two cards swapped into the same login shell. The request step ALWAYS shows the same
  // confirmation regardless of the server's answer, matching the server's deliberate
  // refusal to reveal whether an address exists.
  function showCard(id) {
    ['localAuthForm', 'registerForm', 'mfaForm', 'ssoBlock', 'forgotForm', 'resetForm'].forEach((x) => {
      const el = document.getElementById(x); if (el) el.style.display = (x === id ? 'block' : 'none');
    });
    const errEl = document.getElementById('loginError'); if (errEl) errEl.style.display = 'none';
  }

  const forgotLink = document.getElementById('forgotLink');
  if (forgotLink) forgotLink.addEventListener('click', (e) => {
    e.preventDefault();
    showCard('forgotForm');
    const src = document.getElementById('loginEmail');
    const dst = document.getElementById('forgotEmail');
    if (src && dst) dst.value = src.value; // carry over whatever they already typed
  });

  const forgotBackBtn = document.getElementById('forgotBackBtn');
  if (forgotBackBtn) forgotBackBtn.addEventListener('click', () => showCard('localAuthForm'));

  const forgotSendBtn = document.getElementById('forgotSendBtn');
  if (forgotSendBtn) forgotSendBtn.addEventListener('click', async () => {
    const email = (document.getElementById('forgotEmail').value || '').trim();
    forgotSendBtn.disabled = true;
    try {
      await fetch('/api/auth/forgot-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
      });
    } catch (e) { /* deliberately ignored — see below */ }
    // Same confirmation either way. Surfacing a network/server error here would leak
    // whether the address matched, undoing the server-side enumeration resistance.
    document.getElementById('forgotNotice').style.display = 'block';
    forgotSendBtn.disabled = false;
  });

  // A link from the reset email: #/reset-password?token=...
  function resetTokenFromHash() {
    const h = window.location.hash || '';
    const q = h.indexOf('?');
    if (!h.startsWith('#/reset-password') || q < 0) return null;
    return new URLSearchParams(h.slice(q + 1)).get('token');
  }

  const pendingResetToken = resetTokenFromHash();
  if (pendingResetToken) showCard('resetForm');

  const resetBackBtn = document.getElementById('resetBackBtn');
  if (resetBackBtn) resetBackBtn.addEventListener('click', () => { window.location.hash = '#/login'; window.location.reload(); });

  const resetSubmitBtn = document.getElementById('resetSubmitBtn');
  if (resetSubmitBtn) resetSubmitBtn.addEventListener('click', async () => {
    const password = document.getElementById('resetPassword').value || '';
    resetSubmitBtn.disabled = true;
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: pendingResetToken, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showError(data.error || t('auth.reset_failed')); resetSubmitBtn.disabled = false; return; }
      // No session is issued by design, so send them through a normal sign-in — which is
      // what keeps TOTP in the loop for accounts that have it.
      showToast(t('auth.reset_done'), 'success');
      window.location.hash = '#/login';
      window.location.reload();
    } catch (e) {
      showError(t('auth.reset_failed'));
      resetSubmitBtn.disabled = false;
    }
  });

  function showVerifyNotice(email) {
    // The server refused a session — make sure no stale token from a prior login lingers,
    // else the router would treat this browser as authenticated and bounce it into the app.
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    ['localAuthForm', 'registerForm', 'mfaForm', 'ssoBlock', 'supportDetails'].forEach((id) => {
      const el = document.getElementById(id); if (el) el.style.display = 'none';
    });
    document.getElementById('verifyNotice').style.display = 'block';
    document.getElementById('verifyEmail').textContent = email || '';
    const errEl = document.getElementById('loginError'); if (errEl) errEl.style.display = 'none';
    document.getElementById('verifyBackBtn').addEventListener('click', () => window.location.reload());
    document.getElementById('verifyResendBtn').addEventListener('click', async () => {
      try {
        await fetch('/api/auth/resend-verification', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        showToast(t('auth.verify_resent'), 'success'); // always generic (server never leaks existence)
      } catch (e) {
        showToast(t('auth.verify_resend_failed'), 'error');
      }
    });
  }

  // Swap the card to the 6-digit challenge and exchange mfa_token + code for a session.
  function showMfaChallenge(mfaToken) {
    ['localAuthForm', 'registerForm', 'ssoBlock', 'supportDetails'].forEach((id) => {
      const el = document.getElementById(id); if (el) el.style.display = 'none';
    });
    const form = document.getElementById('mfaForm');
    form.style.display = 'block';
    const errEl = document.getElementById('loginError'); if (errEl) errEl.style.display = 'none';
    const codeEl = document.getElementById('mfaCode');
    codeEl.value = '';
    codeEl.focus();

    const verify = async () => {
      const code = codeEl.value.trim();
      if (!code) { showError(t('auth.mfa_code_required')); return; }
      try {
        const res = await fetch('/api/auth/totp/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mfa_token: mfaToken, code })
        });
        const data = await res.json();
        if (!res.ok) { showError(data.error || t('auth.mfa_invalid')); codeEl.select(); return; }
        onAuthSuccess(data);
      } catch (err) {
        showError(t('auth.error_login_failed'));
      }
    };
    document.getElementById('mfaVerifyBtn').addEventListener('click', verify);
    codeEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') verify(); });
    document.getElementById('mfaBackBtn').addEventListener('click', () => { window.location.reload(); });
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
      // Hosted signup requires confirming the email before a session is issued.
      if (data.verification_required) { showVerifyNotice(data.email || email); return; }
      onAuthSuccess(data);
    } catch (err) {
      showError(t('auth.error_registration_failed'));
    }
  }

  /*
   * SSO is a link, not a script.
   *
   * The buttons above are anchors to /api/auth/oidc/<slug>/start, so there is nothing to bind here
   * and no SDK to wait for. What DOES need handling is the trip back: the callback redirects to
   * #/login carrying either a session token or an error code.
   *
   * The token rides in the URL FRAGMENT, which browsers never send to servers and proxies never
   * log — and it is stripped from the address bar before anything else happens, so a shared screen
   * or a copied URL does not carry a live session.
   */
  /*
   * Email-first SSO for organizations.
   *
   * Instance-wide providers are always on the page. An ORG provider is different — it belongs to
   * one customer — so it is fetched by domain once the address looks complete, and only then.
   *
   * Debounced because this fires while someone types, and the endpoint is rate limited; asking on
   * every keystroke would spend a user's whole budget before they finished their own address.
   */
  let lastDomainAsked = '';
  const orgSlot = () => document.getElementById('orgSsoSlot');

  /*
   * Show or hide the password half of the sign-in form.
   *
   * Presentation only — the server refuses a password for these accounts regardless. Restoring it
   * on every negative answer matters as much as hiding it: someone who types an SSO-only address,
   * then corrects it to their own, must get the password box back.
   */
  /*
   * Password visibility has TWO independent drivers, and conflating them is how this got confusing:
   *
   *   identified   — identifier-first. The password box does not exist until an address has been
   *                  submitted, because until then we do not know whether this account uses a
   *                  password at all. This is what lets the org lookup happen before we offer the
   *                  wrong thing.
   *   ssoOnlyDomain — the address belongs to an organization that REQUIRES its own provider. Then a
   *                  password box is not merely going to fail, it is the wrong thing to show.
   *
   * The field appears only when identified AND not SSO-only. Kept as one function so the two can
   * never disagree about what is on screen.
   */
  let identified = false;
  let ssoOnlyDomain = false;

  function applyFormState() {
    // One decision, in one place, from ../lib/login-form-state.js. It used to be computed inline
    // from two mutable flags, which is how first-run setup ended up being undone by a keystroke.
    const state = loginFormState({ isSetup, identified, ssoOnlyDomain });
    const show = state.showPassword ? '' : 'none';
    /*
     * ⚠️ Hide the password FIELD, never its .form-group — the organization SSO slot lives inside
     * that same group, so hiding the container took the single sign-on button down with it.
     */
    for (const id of ['loginPassword', 'loginPasswordLabel']) {
      const el = document.getElementById(id);
      if (el) el.style.display = show;
    }

    /*
     * The primary button is "Next" until an address has been submitted, then "Sign in". One button
     * rather than two, so there is never a choice about which to press.
     */
    const btn = document.getElementById('loginBtn');
    if (btn) btn.textContent = t(state.buttonKey);
    if (btn) btn.style.display = state.showButton ? '' : 'none';

    /*
     * The instance's own providers stay visible at ALL times, by explicit decision: they are the
     * operator's, they are offered to everyone, and the server refuses them for an SSO-only
     * organization anyway. (Previously they were hidden for such domains so the page would not
     * invite the bypass; the cost was a login page that changed shape while you typed.)
     */

    /*
     * "Create Account" and "Forgot your password?" DO go for an SSO-only domain: registration there
     * is refused by the server, and a password reset produces one that can never be used.
     */
    const reg = document.getElementById('showRegisterBtn');
    if (reg) reg.style.display = ssoOnlyDomain ? 'none' : '';
    const forgot = document.getElementById('forgotLink');
    if (forgot) {
      const wrap = forgot.parentElement && forgot.parentElement.tagName === 'P' ? forgot.parentElement : forgot;
      wrap.style.display = ssoOnlyDomain ? 'none' : '';
    }
  }

  // Kept for the org lookup below, which reasons about SSO-only rather than about identification.
  function setPasswordVisible(visible) {
    ssoOnlyDomain = !visible;
    applyFormState();
  }

  async function lookupOrgSso(email) {
    const at = String(email || '').lastIndexOf('@');
    const domain = at === -1 ? '' : email.slice(at + 1).trim().toLowerCase();
    const slot = orgSlot();
    if (!slot) return;
    // Nothing to ask about until there is a domain with a dot in it.
    if (!domain || !domain.includes('.')) {
      slot.style.display = 'none'; slot.innerHTML = ''; lastDomainAsked = ''; setPasswordVisible(true); return;
    }
    if (domain === lastDomainAsked) return;
    try {
      const res = await fetch(`/api/auth/sso/discover?email=${encodeURIComponent(email)}`);
      /*
       * ⚠️ Check the STATUS, not just that a body parsed.
       *
       * The comment below has always said a tripped rate limit must not poison the domain — and it
       * did anyway, because a 429 body is perfectly valid JSON: res.json() resolved, `data.sso`
       * came back undefined, so the single sign-on button was hidden, the password box restored,
       * and `lastDomainAsked` recorded — permanently, for the life of the page. On an SSO-only
       * domain that is the worst possible outcome: the password box the user is then offered gets
       * 403, and the button they are told to use is not on the screen. Discover is 10/min per IP,
       * so a handful of colleagues behind one office address is enough to trigger it.
       */
      if (!res.ok) throw new Error(`discover ${res.status}`);
      const data = await res.json();
      // Remembered only after a SUCCESSFUL answer.
      lastDomainAsked = domain;
      if (!data.sso) { slot.style.display = 'none'; slot.innerHTML = ''; setPasswordVisible(true); return; }
      /*
       * When the organization REQUIRES its identity provider, the password box is not merely going
       * to fail — it is the wrong thing to offer. Showing it invites someone to type a password,
       * be refused, and go and reset a password that will never work again. Hidden, not disabled,
       * so there is one obvious way forward.
       */
      setPasswordVisible(!data.required);
      /*
       * A FORM, not a link, and a deliberately generic label.
       *
       * The lookup tells us only that this domain uses SSO — never which provider or whose it is,
       * because that would identify a customer to anyone who guessed a domain. The server does the
       * mapping again on submit, so the slug is never published to the page. POST keeps the address
       * out of the URL, browser history and any Referer the provider's page would send.
       */
      /*
       * A BUTTON that fetches and then navigates — not a form that submits.
       *
       * The dashboard's CSP is `form-action 'self'`, and Chrome applies it across the whole
       * redirect chain, so a form POST that 302s on to the customer's identity provider was
       * ABORTED with nothing shown to the user at all. The provider origins cannot be allowlisted
       * because customers supply them. A script-initiated navigation is not covered by
       * form-action, so the page asks the server where to go and goes there.
       *
       * Styled secondary: "Sign In" is the primary action while a password still works, and two
       * identical blue buttons stacked one above the other sent people to their IdP by muscle
       * memory after typing a password.
       */
      slot.innerHTML = `
        <button type="button" id="orgSsoBtn" class="btn ${data.required ? 'btn-primary' : 'btn-secondary'}"
                style="width:100%;justify-content:center;padding:10px">
          ${t('auth.signin_sso')}
        </button>
        <div style="font-size:11px;color:var(--text-muted);margin-top:6px;text-align:center">
          ${t('auth.sso_org_hint')}
        </div>`;
      slot.style.display = '';

      const btn = slot.querySelector('#orgSsoBtn');
      if (btn) btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const r = await fetch('/api/auth/sso/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ email }),
          });
          const body = await r.json().catch(() => ({}));
          if (!r.ok || !body.start_url) throw new Error(body.error || `start ${r.status}`);
          window.location.assign(body.start_url);
        } catch {
          btn.disabled = false;
          showError(t('auth.sso_err_provider_unavailable'));
        }
      });
    } catch {
      // A failed lookup must never block a password login — the form still works, and the password
      // box comes back rather than leaving someone staring at a form with no way to submit it.
      slot.style.display = 'none';
      slot.innerHTML = '';
      setPasswordVisible(true);
    }
  }

  /*
   * The lookup now runs on SUBMIT (identify()), not on every keystroke.
   *
   * Identifier-first made the debounced version both redundant and wrong: redundant because nothing
   * is shown until an address is submitted anyway, and wrong because it would answer for a
   * half-typed domain and change the form under someone mid-address. It also spent a rate-limit
   * budget of 10/min per IP on people who had not finished typing — an office behind one address
   * could exhaust it without a single sign-in attempt.
   *
   * ⚠️ Applied HERE, after the `let identified` / `let ssoOnlyDomain` declarations above. Called any
   * earlier it would throw on the temporal dead zone, which on this page means a login form that
   * never renders.
   */
  if (isSetup) identified = true;   // first-run setup needs both fields at once
  applyFormState();

  /*
   * Completing an SSO login.
   *
   * The callback no longer hands the session token back in the URL — that was a login-CSRF hole,
   * because a crafted link could install an ATTACKER'S token and quietly sign the victim into their
   * account. The server now leaves it in a one-shot httpOnly cookie and we exchange it here, which
   * a link cannot forge.
   *
   * Wrapped in an async IIFE because setupHandlers() is not async; `await` at this level is a
   * SyntaxError that takes the whole module graph down with it, since app.js imports this file
   * statically and there is no bundler to catch it first.
   */
  const ssoParams = new URLSearchParams((window.location.hash.split('?')[1] || ''));
  const ssoReturning = ssoParams.get('sso') === '1';
  const ssoError = ssoParams.get('sso_error');

  if (ssoReturning || ssoError) {
    // Keep any real query string; only the hash carried the SSO markers.
    history.replaceState(null, '', window.location.pathname + window.location.search + '#/login');
  }

  if (ssoReturning) {
    (async () => {
      try {
        const res = await fetch('/api/auth/sso/claim', { method: 'POST' });
        if (!res.ok) throw new Error('claim rejected');
        const data = await res.json();
        onAuthSuccess(data);
      } catch {
        showToast(t('auth.sso_failed'), 'error');
      }
    })();
  } else if (ssoError) {
    // Every code the callback can emit has a message; an unknown one still says something true
    // rather than failing silently, which is how the previous implementation behaved on every click.
    const known = ['expired', 'bad_state', 'no_code', 'no_email', 'email_unverified',
      'verification_failed', 'provider_refused', 'provider_unavailable', 'unknown_provider',
      'registration_disabled', 'account_exists_local', 'subject_mismatch', 'server_error',
      'domain_not_allowed', 'account_exists_other_provider', 'sso_required'];
    const key = known.includes(ssoError) ? `auth.sso_err_${ssoError}` : 'auth.sso_failed';
    showToast(t(key), 'error');
  }
}

function onAuthSuccess(data) {
  // Defensive: only a response that actually carries a session token logs the user in. A
  // tokenless response (e.g. verification_required / mfa_required) must never be stored as a
  // session — otherwise isAuthenticated() would pass on the string "undefined" and the router
  // would bounce an un-authenticated browser into the app / setup wizard.
  if (!data || !data.token) return;
  localStorage.setItem('token', data.token);
  localStorage.setItem('user', JSON.stringify(data.user));
  window.location.hash = '#/';
  window.location.reload();
}

export function cleanup() {}
