import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { getLanguage, setLanguage, getAvailableLanguages, t, tn } from '../i18n.js';
import { esc, isPlatformAdmin } from '../utils.js';
import { resetBranding } from '../branding.js';

export async function render(container) {
  const serverUrl = `${window.location.protocol}//${window.location.host}`;
  // Fetch fresh user from the server — plan_id and role may have been changed
  // by an admin since login. Fall back to localStorage if the request fails.
  let user;
  try { user = await api.getMe(); localStorage.setItem('user', JSON.stringify(user)); }
  catch { user = JSON.parse(localStorage.getItem('user') || '{}'); }
  const isSuperAdmin = isPlatformAdmin(user);
  // #14: the legacy 'admin' platform role was normalized away; platform-level
  // admin is now just isPlatformAdmin. (Elevated capability otherwise comes from
  // org/workspace membership, gated in the members views, not users.role.)
  const isAdmin = isSuperAdmin;
  const canManageOrgSecurity = isSuperAdmin || user.current_org_role === 'org_owner' || user.current_org_role === 'org_admin';
  const widgetIsolationDisabled = !!user.current_organization?.widget_sandbox_isolation_disabled;
  const WIDGET_ISOLATION_CONFIRM_PHRASE = 'I understand I am enabling a security hole';

  // #83: the "About" version was hardcoded (showed v1.4.1 regardless of the build).
  // Read it from the server (/api/version) the same way the admin view does.
  let appVersion = '';
  try { appVersion = ((await fetch('/api/version').then(r => r.json())).version) || ''; } catch { /* leave blank on failure */ }

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>${t('settings.title')} <span class="help-tip" data-tip="${t('settings.help_tip')}">?</span></h1>
        <div class="subtitle">${t('settings.subtitle')}</div>
      </div>
    </div>

    <div class="settings-section">
      <h3>${t('settings.account')}</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
        <div class="form-group"><label>${t('auth.email')}</label><input type="email" class="input" value="${esc(user.email || '')}" disabled></div>
        <div class="form-group"><label>${t('auth.name')}</label><input type="text" id="acctName" class="input" value="${esc(user.name || '')}"></div>
      </div>
      <div class="form-group" style="margin-top:12px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="acctEmailAlerts" ${user.email_alerts ? 'checked' : ''}>
          <span>${t('settings.email_alerts')}</span>
        </label>
      </div>
      <button class="btn btn-secondary btn-sm" id="saveAcctBtn">${t('settings.save_profile')}</button>

      ${user.auth_provider === 'local' ? `
      <div style="border-top:1px solid var(--border);margin-top:20px;padding-top:16px">
        <h4 style="font-size:14px;margin-bottom:8px">${t('settings.change_password')}</h4>
        <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px">${t('settings.password_min_8')}</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px">
          <div class="form-group"><label>${t('settings.current_password')}</label><input type="password" id="acctCurrentPw" class="input" autocomplete="current-password"></div>
          <div class="form-group"><label>${t('settings.new_password')}</label><input type="password" id="acctNewPw" class="input" autocomplete="new-password"></div>
          <div class="form-group"><label>${t('settings.confirm_new_password')}</label><input type="password" id="acctConfirmPw" class="input" autocomplete="new-password"></div>
        </div>
        <button class="btn btn-primary btn-sm" id="changePwBtn">${t('settings.change_password')}</button>
      </div>
      ` : `
      <p style="color:var(--text-muted);font-size:12px;margin-top:16px">${t('settings.sso_note', { provider: esc(user.auth_provider || 'SSO') })}</p>
      `}

      <!--
        Sign-in method (#258). An account has exactly ONE credential: a password, or one
        instance-wide provider. Linking deletes the password; unlinking requires a new one in the
        same step, so the account is never briefly left with no way in. Populated by loadSsoLink().
      -->
      <div id="ssoLinkBlock" style="border-top:1px solid var(--border);margin-top:20px;padding-top:16px">
        <h4 style="font-size:14px;margin-bottom:8px">${t('settings.signin_method')}</h4>
        <p style="color:var(--text-muted);font-size:12px">…</p>
      </div>

      <!-- Two-factor authentication (#100). Populated by load2FA() from /auth/totp/status. -->
      <div id="twoFactorBlock" style="border-top:1px solid var(--border);margin-top:20px;padding-top:16px">
        <h4 style="font-size:14px;margin-bottom:8px">${t('settings.2fa_title')}</h4>
        <p style="color:var(--text-muted);font-size:12px">…</p>
      </div>
    </div>

    <!-- Per-organization SSO. Hidden unless the signed-in user administers an organization: this
         is the most security-relevant setting a tenant has, so it is not shown to members who
         cannot change it. Instance-wide providers are the operator's business and are configured
         by environment, not here. -->
    <div class="settings-section" id="ssoCard" style="display:none">
      <h3>${t('sso.title')}</h3>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:8px">${t('sso.blurb')}</p>
      <div id="ssoList"></div>
      <details id="ssoAddDetails" style="margin-top:12px">
        <summary style="cursor:pointer;font-size:13px">${t('sso.add')}</summary>
        <div style="margin-top:12px;display:grid;gap:10px;max-width:560px">
          <div class="form-group"><label>${t('sso.f_name')}</label>
            <input type="text" id="ssoName" class="input" placeholder="Acme SSO"></div>
          <div class="form-group"><label>${t('sso.f_issuer')}</label>
            <input type="url" id="ssoIssuer" class="input" placeholder="https://login.example.com">
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('sso.f_issuer_hint')}</div></div>
          <div class="form-group"><label>${t('sso.f_client_id')}</label>
            <input type="text" id="ssoClientId" class="input"></div>
          <div class="form-group"><label>${t('sso.f_client_secret')}</label>
            <input type="password" id="ssoClientSecret" class="input" autocomplete="new-password">
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('sso.f_client_secret_hint')}</div></div>
          <div class="form-group"><label>${t('sso.f_domains')}</label>
            <input type="text" id="ssoDomains" class="input" placeholder="acme.com, acme.co.uk">
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('sso.f_domains_hint')}</div></div>
          <div><button class="btn btn-primary btn-sm" id="ssoCreateBtn">${t('sso.create')}</button></div>
        </div>
      </details>
    </div>

    <div class="settings-section">
      <h3>${t('apitoken.title')}</h3>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:8px">${t('apitoken.desc')}</p>
      <p style="font-size:13px;margin-bottom:16px"><a href="/docs" target="_blank" rel="noopener" style="color:var(--accent)">${t('apitoken.docs_link')}</a></p>
      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:16px">
        <div class="form-group" style="margin-bottom:0;flex:1;min-width:180px">
          <label>${t('apitoken.col_name')}</label>
          <input type="text" id="tokName" class="input" placeholder="${esc(t('apitoken.name_placeholder'))}">
        </div>
        <div class="form-group" style="margin-bottom:0;min-width:200px">
          <label>${t('apitoken.col_scope')}</label>
          <select id="tokScope" class="input" style="background:var(--bg-input)">
            <option value="read">${esc(t('apitoken.scope_read'))}</option>
            <option value="write">${esc(t('apitoken.scope_write'))}</option>
            <option value="full">${esc(t('apitoken.scope_full'))}</option>
            <option value="agency">${esc(t('apitoken.scope_agency'))}</option>
          </select>
        </div>
        <button class="btn btn-primary btn-sm" id="createTokenBtn">${t('apitoken.create')}</button>
      </div>
      <div id="agencyPlaylistPicker" style="display:none;margin-bottom:16px;padding:12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-secondary)">
        <label style="display:block;font-weight:500;margin-bottom:4px">${t('apitoken.agency_playlists_label')}</label>
        <p style="color:var(--text-muted);font-size:12px;margin-bottom:8px">${t('apitoken.agency_playlists_hint')}</p>
        <div id="agencyPlaylistList" style="display:flex;flex-direction:column;gap:6px;max-height:200px;overflow:auto"></div>
        <label style="display:flex;gap:8px;align-items:center;margin-top:12px;font-weight:500">
          <input type="checkbox" id="tokAutoPublish"> ${t('apitoken.auto_publish_label')}
        </label>
        <p style="color:var(--text-muted);font-size:12px;margin:4px 0 0">${t('apitoken.auto_publish_hint')}</p>
        <label style="display:block;font-weight:500;margin-top:12px;margin-bottom:4px">${t('apitoken.agency_folder_label')}</label>
        <p style="color:var(--text-muted);font-size:12px;margin-bottom:8px">${t('apitoken.agency_folder_hint')}</p>
        <select id="tokUploadFolder" class="input" style="width:100%"><option value="">${t('apitoken.agency_folder_auto')}</option></select>
      </div>
      <div id="tokenSecretBox" style="display:none"></div>
      <div id="tokenList"><p style="color:var(--text-muted);font-size:13px">${t('settings.loading_users')}</p></div>
      <div id="tokenEditPanel" style="display:none"></div>
    </div>

    ${canManageOrgSecurity ? `
    <div class="settings-section">
      <h3>Security</h3>
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap">
        <div style="min-width:260px;flex:1">
          <div style="font-weight:600">Widget sandbox isolation</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">
            Keep widget code in a null-origin sandbox. Turning this off allows widget code to run with same-origin access.
          </div>
        </div>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;white-space:nowrap">
          <input type="checkbox" id="widgetSandboxIsolationToggle" ${widgetIsolationDisabled ? '' : 'checked'}>
          <span>${widgetIsolationDisabled ? 'Isolation disabled' : 'Isolation enabled'}</span>
        </label>
      </div>
    </div>
    ` : ''}

    ${isAdmin ? `
    <div class="settings-section">
      <h3>${t('settings.license')}</h3>
      <div id="licenseSection"><p style="color:var(--text-muted);font-size:13px">${t('settings.license_mit')}</p></div>
    </div>

    ${isSuperAdmin ? `
    <div class="settings-section" id="telemetrySection">
      <h3>Install statistics</h3>
      <div id="telemetryBody"><p style="color:var(--text-muted);font-size:13px">Loading…</p></div>
    </div>
    ` : ''}

    ${isSuperAdmin ? `<p style="font-size:12px;color:var(--text-muted);margin-bottom:12px">${t('settings.platform_admin_link')} <a href="#/admin" style="color:var(--accent)">${t('nav.admin')}</a> ${t('settings.platform_admin_page_suffix')}</p>` : ''}

    <div class="settings-section">
      <h3>${t('settings.user_management')}</h3>
      <div id="userManagement"><p style="color:var(--text-muted)">${t('settings.loading_users')}</p></div>
    </div>

    <div class="settings-section" id="whiteLabelSection">
      <h3>${t('settings.white_label')}</h3>
      <div id="whiteLabelForm">
        <p style="color:var(--text-muted);font-size:12px;margin-bottom:16px">${t('settings.white_label_desc')}</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group"><label>${t('settings.brand_name')}</label><input type="text" id="wlBrandName" class="input" placeholder="ScreenTinker"></div>
          <div class="form-group"><label>${t('settings.logo_url')}</label><input type="text" id="wlLogoUrl" class="input" placeholder="https://..."></div>
          <div class="form-group"><label>${t('settings.primary_color')}</label><input type="color" id="wlPrimaryColor" value="#3B82F6" style="width:100%;height:36px;border:none;cursor:pointer;border-radius:var(--radius)"></div>
          <div class="form-group"><label>${t('settings.bg_color')}</label><input type="color" id="wlBgColor" value="#111827" style="width:100%;height:36px;border:none;cursor:pointer;border-radius:var(--radius)"></div>
          <div class="form-group"><label>${t('settings.custom_domain')}</label><input type="text" id="wlDomain" class="input" placeholder="signage.yourcompany.com"></div>
          <div class="form-group"><label>${t('settings.favicon_url')}</label><input type="text" id="wlFavicon" class="input" placeholder="https://..."></div>
        </div>
        <div class="form-group"><label>${t('settings.custom_css')}</label><textarea id="wlCustomCss" class="input" rows="3" style="font-family:monospace;font-size:12px" placeholder=":root { --accent: #ff6600; }"></textarea></div>
        <div class="form-group"><label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="wlHideBranding"> ${t('settings.hide_branding')}</label></div>
        <button class="btn btn-primary btn-sm" id="saveWhiteLabelBtn">${t('settings.save_branding')}</button>
        <button class="btn btn-secondary btn-sm" id="previewWhiteLabelBtn" style="margin-left:8px">${t('settings.preview')}</button>
      </div>
    </div>
    ` : ''}

    <div class="settings-section">
      <h3>${t('settings.server_info')}</h3>
      <div class="info-grid">
        <div class="info-card">
          <div class="info-card-label">${t('settings.server_url')}</div>
          <div class="info-card-value small">${serverUrl}</div>
          <p style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('settings.server_url_hint')}</p>
        </div>
        <div class="info-card">
          <div class="info-card-label">${t('settings.api_endpoint')}</div>
          <div class="info-card-value small">${serverUrl}/api</div>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3>${t('settings.setup_guide')}</h3>
      <div style="color:var(--text-secondary);font-size:13px;line-height:1.8">
        <ol style="padding-left:20px;list-style:decimal">
          <li>${t('settings.setup_step_1')}</li>
          <li>${t('settings.setup_step_2_prefix')} <code style="background:var(--bg-input);padding:2px 6px;border-radius:4px">${serverUrl}</code></li>
          <li>${t('settings.setup_step_3')}</li>
          <li>${t('settings.setup_step_4')}</li>
          <li>${t('settings.setup_step_5')}</li>
          <li>${t('settings.setup_step_6')}</li>
        </ol>
      </div>
    </div>

    <div class="settings-section">
      <h3>${t('settings.your_data')}</h3>
      <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">${t('settings.your_data_desc')}</p>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-secondary btn-sm" id="exportDataBtn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          ${t('settings.export_my_data')}
        </button>
        <label style="display:flex;align-items:center;gap:4px;font-size:12px;color:var(--text-secondary);cursor:pointer">
          <input type="checkbox" id="exportIncludeFiles"> ${t('settings.include_media_zip')}
        </label>
        <button class="btn btn-secondary btn-sm" id="importDataBtn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          ${t('settings.import_data')}
        </button>
        <input type="file" id="importFileInput" accept=".json,.zip" style="display:none">
      </div>
      <div id="importStatus" style="display:none;margin-top:12px;padding:12px;border-radius:var(--radius);font-size:13px"></div>
    </div>

    <div class="settings-section">
      <h3>${t('settings.language')}</h3>
      <select id="langSelect" class="input" style="width:200px;background:var(--bg-input)">
        ${getAvailableLanguages().map(l => `<option value="${l.code}" ${l.code === getLanguage() ? 'selected' : ''}>${l.name}</option>`).join('')}
      </select>
    </div>

    <div class="settings-section">
      <h3>${t('settings.about')}</h3>
      <div style="color:var(--text-secondary);font-size:13px">
        <p><strong>ScreenTinker</strong>${appVersion ? ` v${esc(appVersion)}` : ''}</p>
        <p style="margin-top:4px">${t('settings.about_tagline')}</p>
        <p style="margin-top:12px">
          <a href="/legal/terms.html" target="_blank" style="color:var(--accent);font-size:12px">${t('auth.terms')}</a>
          &nbsp;&middot;&nbsp;
          <a href="/legal/privacy.html" target="_blank" style="color:var(--accent);font-size:12px">${t('auth.privacy')}</a>
          &nbsp;&middot;&nbsp;
          <a href="/legal/third-party.html" target="_blank" style="color:var(--accent);font-size:12px">${t('settings.third_party_licenses')}</a>
        </p>
      </div>
    </div>
  `;

  if (isAdmin) {
    loadUsers();
    loadWhiteLabel();
    loadTelemetry();

    // Support token generator
    document.getElementById('generateSupportBtn')?.addEventListener('click', async () => {
      const org = document.getElementById('supportOrg').value.trim() || 'Customer';
      const hours = parseInt(document.getElementById('supportHours').value) || 4;
      try {
        const token = localStorage.getItem('token');
        const res = await fetch('/api/auth/support/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ org, hours, reason: 'Support session' })
        });
        const data = await res.json();
        if (res.ok) {
          document.getElementById('supportTokenOutput').value = data.token;
          document.getElementById('supportTokenResult').style.display = 'block';
          showToast(t('settings.toast.support_token_generated', { hours }), 'success');
        } else showToast(data.error, 'error');
      } catch (err) { showToast(err.message, 'error'); }
    });
  }

  // Export data handler
  document.getElementById('exportDataBtn')?.addEventListener('click', () => {
    const includeFiles = document.getElementById('exportIncludeFiles')?.checked;
    const token = localStorage.getItem('token');
    const url = `/api/status/export?token=${token}${includeFiles ? '&include_files=true' : ''}`;
    window.location.href = url;
  });

  // Import data handler
  document.getElementById('importDataBtn')?.addEventListener('click', () => {
    document.getElementById('importFileInput').click();
  });
  document.getElementById('importFileInput')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const isZip = file.name.endsWith('.zip') || file.type === 'application/zip';
    const statusEl = document.getElementById('importStatus');
    statusEl.style.display = 'block';
    statusEl.style.background = 'var(--bg-secondary)';
    statusEl.style.border = '1px solid var(--border)';
    statusEl.style.color = 'var(--text-secondary)';
    statusEl.textContent = t('settings.import.reading_file');
    try {
      let data;
      if (isZip) {
        // For ZIP, show basic info and skip preview parsing
        data = { format: 'screentinker-export-v1', _isZip: true };
        statusEl.innerHTML = `${t('settings.import.zip_detected', { name: esc(file.name), size: (file.size / 1048576).toFixed(1) })}<br><br><button class="btn btn-primary btn-sm" id="confirmImportBtn">${t('settings.import.confirm')}</button> <button class="btn btn-secondary btn-sm" id="cancelImportBtn">${t('common.cancel')}</button>`;
      } else {
        const text = await file.text();
        data = JSON.parse(text);
        if (!data.format || !data.format.startsWith('screentinker-export')) {
          statusEl.style.color = 'var(--danger)';
          statusEl.textContent = t('settings.import.invalid_file');
          return;
        }
        const summary = [
          data.devices?.length ? t('settings.import.summary_devices', { n: data.devices.length }) : null,
          data.content?.length ? t('settings.import.summary_content', { n: data.content.length }) : null,
          data.widgets?.length ? t('settings.import.summary_widgets', { n: data.widgets.length }) : null,
          data.layouts?.length ? t('settings.import.summary_layouts', { n: data.layouts.length }) : null,
          data.schedules?.length ? t('settings.import.summary_schedules', { n: data.schedules.length }) : null,
          data.video_walls?.length ? t('settings.import.summary_walls', { n: data.video_walls.length }) : null,
          data.kiosk_pages?.length ? t('settings.import.summary_kiosk', { n: data.kiosk_pages.length }) : null,
        ].filter(Boolean).join(', ');
        statusEl.innerHTML = `${t('settings.import.found_summary', { summary: esc(summary) || t('settings.import.empty_export'), email: esc(data.user?.email) || t('common.unknown'), date: esc(data.exported_at?.split('T')[0]) || t('common.unknown') })}<br><br><button class="btn btn-primary btn-sm" id="confirmImportBtn">${t('settings.import.confirm')}</button> <button class="btn btn-secondary btn-sm" id="cancelImportBtn">${t('common.cancel')}</button>`;
      }
      document.getElementById('cancelImportBtn').onclick = () => { statusEl.style.display = 'none'; e.target.value = ''; };
      document.getElementById('confirmImportBtn').onclick = async () => {
        statusEl.innerHTML = isZip ? t('settings.import.uploading_zip') : t('settings.import.importing');
        try {
          const token = localStorage.getItem('token');
          let res;
          if (isZip) {
            const formData = new FormData();
            formData.append('file', file);
            res = await fetch('/api/status/import', {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}` },
              body: formData,
            });
          } else {
            res = await fetch('/api/status/import', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify(data),
            });
          }
          const result = await res.json();
          if (res.ok) {
            const imported = Object.entries(result.stats).filter(([k,v]) => v > 0 && k !== 'files_restored').map(([k,v]) => `${v} ${k}`).join(', ');
            statusEl.style.color = 'var(--success)';
            let html = t('settings.import.complete', { imported });
            if (result.device_pairings?.length) {
              html += `<br><br><strong>${t('settings.import.pairing_codes_title')}</strong><br><table style="margin-top:8px;font-size:12px;border-collapse:collapse">` +
                result.device_pairings.map(d => `<tr><td style="padding:4px 12px 4px 0">${esc(d.name)}</td><td style="font-family:monospace;font-weight:700;font-size:14px;letter-spacing:2px">${d.pairing_code}</td></tr>`).join('') +
                `</table><br>${t('settings.import.pairing_codes_hint')}`;
            }
            html += `<br><br>${(result.notes || []).map(n => '&bull; ' + n).join('<br>')}`;
            statusEl.innerHTML = html;
            showToast(t('settings.toast.import_success'), 'success');
          } else {
            statusEl.style.color = 'var(--danger)';
            statusEl.textContent = result.error || t('settings.import.failed');
          }
        } catch (err) {
          statusEl.style.color = 'var(--danger)';
          statusEl.textContent = t('settings.import.failed_with_error', { error: err.message });
        }
        e.target.value = '';
      };
    } catch (err) {
      statusEl.style.color = 'var(--danger)';
      statusEl.textContent = t('settings.import.read_failed', { error: err.message });
    }
  });

  document.getElementById('langSelect')?.addEventListener('change', (e) => {
    // setLanguage dispatches hashchange so the router re-renders the current
    // view (including this settings page) with new strings — no refresh needed.
    setLanguage(e.target.value);
  });

  // API Tokens — available to every user (manages their own, workspace-scoped).
  const fmtTokenDate = (ts) => {
    if (!ts) return '';
    try { return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
    catch { return String(ts); }
  };
  const scopeLabel = (s) => ({
    read: t('apitoken.scope_read'),
    write: t('apitoken.scope_write'),
    full: t('apitoken.scope_full'),
    agency: t('apitoken.scope_agency'),
  }[s] || s);

  async function loadTokens() {
    const el = document.getElementById('tokenList');
    if (!el) return;
    const tokens = await api.getTokens().catch(() => []);
    if (!tokens.length) {
      el.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${t('apitoken.none')}</p>`;
      return;
    }
    el.innerHTML = `
      <div class="table-wrap">
      <table style="width:100%;border-collapse:collapse;font-size:13px;min-width:560px">
        <thead>
          <tr style="border-bottom:1px solid var(--border);text-align:left">
            <th style="padding:8px 12px;color:var(--text-muted);font-weight:500">${t('apitoken.col_token')}</th>
            <th style="padding:8px 12px;color:var(--text-muted);font-weight:500">${t('apitoken.col_name')}</th>
            <th style="padding:8px 12px;color:var(--text-muted);font-weight:500">${t('apitoken.col_scope')}</th>
            <th style="padding:8px 12px;color:var(--text-muted);font-weight:500">${t('apitoken.col_created')}</th>
            <th style="padding:8px 12px;color:var(--text-muted);font-weight:500">${t('apitoken.col_last_used')}</th>
            <th style="padding:8px 12px;color:var(--text-muted);font-weight:500"></th>
          </tr>
        </thead>
        <tbody>
          ${tokens.map(tok => `
            <tr style="border-bottom:1px solid var(--border)${tok.revoked_at ? ';opacity:0.55' : ''}">
              <td style="padding:10px 12px;font-family:monospace">${esc(tok.prefix)}&hellip;</td>
              <td style="padding:10px 12px">${esc(tok.name || '')}</td>
              <td style="padding:10px 12px">${esc(scopeLabel(tok.scope))}${
                tok.scope === 'agency' && Array.isArray(tok.targets)
                  ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px">${t('apitoken.targets_label')} ${tok.targets.length ? tok.targets.map(p => esc(p.name)).join(', ') : '—'}${tok.auto_publish ? ' · ' + esc(t('apitoken.auto_publish_on')) : ''}</div><div style="font-size:11px;color:var(--text-muted);margin-top:2px">${t('apitoken.folder_label')} ${tok.upload_folder ? esc(tok.upload_folder) : esc(t('apitoken.folder_root'))}</div>`
                  : ''}</td>
              <td style="padding:10px 12px">${esc(fmtTokenDate(tok.created_at))}</td>
              <td style="padding:10px 12px">${tok.last_used_at ? esc(fmtTokenDate(tok.last_used_at)) : t('apitoken.never')}</td>
              <td style="padding:10px 12px;white-space:nowrap;text-align:right">
                ${tok.revoked_at
                  ? `<span style="color:var(--text-muted);font-size:12px">${t('apitoken.revoked')}</span>`
                  : `${tok.scope === 'agency' ? `<button class="btn btn-secondary btn-sm edit-targets-btn" data-id="${esc(String(tok.id))}" data-targets="${esc((tok.targets || []).map(p => p.id).join(','))}">${t('apitoken.edit_targets')}</button> <button class="btn btn-secondary btn-sm edit-folder-btn" data-id="${esc(String(tok.id))}" data-folder="${esc(String(tok.upload_folder_id || ''))}">${t('apitoken.edit_folder')}</button> ` : ''}<button class="btn btn-secondary btn-sm revoke-token-btn" data-id="${esc(String(tok.id))}">${t('apitoken.revoke')}</button>`}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      </div>
    `;

    el.querySelectorAll('.revoke-token-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(t('apitoken.revoke_confirm'))) return;
        try {
          await api.revokeToken(btn.dataset.id);
          showToast(t('apitoken.revoked_toast'), 'success');
          loadTokens();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    // #73: edit an agency token's playlist designations -> PUT /:id/targets (atomic re-designate).
    el.querySelectorAll('.edit-targets-btn').forEach(btn => btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const current = new Set((btn.dataset.targets || '').split(',').filter(Boolean));
      const panel = document.getElementById('tokenEditPanel');
      const pls = await api.getPlaylists().catch(() => []);
      panel.style.display = 'block';
      panel.innerHTML = `
        <div style="border:1px solid var(--accent);border-radius:var(--radius);padding:16px;margin-top:12px">
          <h4 style="font-size:14px;margin-bottom:8px">${t('apitoken.edit_targets')}</h4>
          <div style="display:flex;flex-direction:column;gap:6px;max-height:200px;overflow:auto;margin-bottom:12px">
            ${pls.length
              ? pls.map(p => p.zoned
                  ? `<label style="display:flex;gap:8px;align-items:center;font-size:13px;opacity:.5"><input type="checkbox" disabled> ${esc(p.name)} <span style="font-size:11px;color:var(--text-muted)">— ${esc(t('apitoken.zoned_playlist_reason'))}</span></label>`
                  : `<label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" class="edit-pl" value="${esc(String(p.id))}"${current.has(String(p.id)) ? ' checked' : ''}> ${esc(p.name)}</label>`).join('')
              : `<p style="color:var(--text-muted);font-size:12px">${t('apitoken.agency_no_playlists')}</p>`}
          </div>
          <button class="btn btn-primary btn-sm" id="saveTargetsBtn">${t('common.save')}</button>
          <button class="btn btn-secondary btn-sm" id="cancelTargetsBtn">${t('common.cancel')}</button>
        </div>`;
      document.getElementById('saveTargetsBtn').onclick = async () => {
        const ids = [...panel.querySelectorAll('.edit-pl:checked')].map(c => c.value);
        if (!ids.length) return showToast(t('apitoken.agency_needs_playlists'), 'error');
        try {
          await api.setTokenTargets(id, ids);
          showToast(t('apitoken.targets_updated'), 'success');
          panel.style.display = 'none';
          loadTokens();
        } catch (err) { showToast(err.message, 'error'); }
      };
      document.getElementById('cancelTargetsBtn').onclick = () => { panel.style.display = 'none'; };
    }));

    // #158: rebind an agency token's upload folder -> PUT /:id/upload-folder (null = root).
    el.querySelectorAll('.edit-folder-btn').forEach(btn => btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const current = btn.dataset.folder || '';
      const panel = document.getElementById('tokenEditPanel');
      const folders = await api.getFolders().catch(() => []);
      panel.style.display = 'block';
      panel.innerHTML = `
        <div style="border:1px solid var(--accent);border-radius:var(--radius);padding:16px;margin-top:12px">
          <h4 style="font-size:14px;margin-bottom:8px">${t('apitoken.edit_folder')}</h4>
          <p style="color:var(--text-muted);font-size:12px;margin-bottom:8px">${t('apitoken.agency_folder_hint')}</p>
          <select id="rebindFolder" class="input" style="width:100%;margin-bottom:12px">
            <option value="">${t('apitoken.folder_root')}</option>
            ${folders.map(f => `<option value="${esc(String(f.id))}"${String(f.id) === current ? ' selected' : ''}>${esc(f.name)}</option>`).join('')}
          </select>
          <button class="btn btn-primary btn-sm" id="saveFolderBtn">${t('common.save')}</button>
          <button class="btn btn-secondary btn-sm" id="cancelFolderBtn">${t('common.cancel')}</button>
        </div>`;
      document.getElementById('saveFolderBtn').onclick = async () => {
        try {
          await api.setTokenUploadFolder(id, document.getElementById('rebindFolder').value || null);
          showToast(t('apitoken.folder_updated'), 'success');
          panel.style.display = 'none';
          loadTokens();
        } catch (err) { showToast(err.message, 'error'); }
      };
      document.getElementById('cancelFolderBtn').onclick = () => { panel.style.display = 'none'; };
    }));
  }

  // ==================== Two-factor authentication (#100) ====================
  // Drives the merged TOTP backend (/api/auth/totp/*). Re-renders #twoFactorBlock
  // for each state: SSO note / disabled+enroll / recovery-codes / enabled+manage.
  /*
   * Sign-in method: password OR one instance-wide provider, never both.
   *
   * The warning on the link button is the whole UX: the local password is DELETED, not kept as a
   * fallback, and someone who does not read that will think they gained a second way in. Unlink
   * asks for the new password up front for the same reason — the account must never sit between
   * credentials.
   *
   * Only instance-wide providers appear. An organization's provider is chosen by a customer and
   * must not be attachable to a platform account; the server refuses it too.
   */
  /*
   * Install statistics. Shows the ACTUAL payload rather than a description of it — the whole
   * proposition is "you can check instead of trusting us", and the code is public, so a sentence
   * that didn't match the bytes would be found. Also shows what was last really sent.
   */
  async function loadTelemetry() {
    const box = document.getElementById('telemetryBody');
    if (!box) return;
    let info;
    try { info = await api.adminGetTelemetry(); }
    catch { box.innerHTML = `<p style="color:var(--text-muted);font-size:13px">Unavailable.</p>`; return; }

    const on = info.state === 'on';
    const sent = info.last_report
      ? `Last sent ${new Date(info.last_report.at * 1000).toLocaleString()}.`
      : 'Nothing has been sent yet.';

    // A blocked outbound connection is the normal failure on a self-hosted box, and it is
    // otherwise invisible — the operator just sees nothing arriving. Name the failure and the
    // host, so the fix is "allow this in the firewall" rather than "guess".
    const failed = on && info.last_error;
    const why = failed
      ? ({ network: 'the connection was refused or the address did not resolve',
           timeout: 'the connection timed out' }[info.last_error.reason]
         || `the server replied ${esc(info.last_error.reason)}`)
      : '';

    box.innerHTML = `
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">
        ScreenTinker can't see how widely it's deployed, because most installs are private by
        design. Sharing lets us say how many screens are running — nothing more.
      </p>
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
        <input type="checkbox" id="telemetryToggle" ${on ? 'checked' : ''}>
        Share install statistics
      </label>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:6px">
        Everything that would be sent, in full:
      </p>
      <pre style="background:var(--bg-input,rgba(0,0,0,.2));padding:10px;border-radius:var(--radius);font-size:12px;overflow-x:auto;margin-bottom:8px">${esc(JSON.stringify(info.payload, null, 2))}</pre>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:${info.extra_endpoint ? '4' : '8'}px">
        ${on ? 'Sent once a day to' : 'When enabled, sent once a day to'}
        <code style="font-size:11px">${esc(info.endpoint || '')}</code>. If this server's outbound
        traffic is filtered, that address has to be allowed or the reports never arrive.
      </p>
      ${info.extra_endpoint ? `
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:8px">
        A second copy also goes to your own collector at
        <code style="font-size:11px">${esc(info.extra_endpoint)}</code>, configured on this server
        with <code style="font-size:11px">TELEMETRY_EXTRA_ENDPOINT</code>. That is in addition to
        the above, not instead of it — turn the switch off if you want your own statistics without
        sharing.
      </p>` : ''}
      ${failed ? `
      <p style="font-size:12px;color:var(--danger);margin-bottom:8px">
        The last attempt (${esc(new Date(info.last_error.at * 1000).toLocaleString())}) did not get
        through — ${why}. Check that outbound HTTPS to that address is permitted.
      </p>` : ''}
      <p style="color:var(--text-muted);font-size:12px">
        No names, addresses, content, or user details. The ID is random and identifies the install
        only so repeat reports aren't counted twice. ${esc(sent)}
      </p>
    `;

    document.getElementById('telemetryToggle')?.addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      try {
        // Turning it on sends immediately, so a blocked firewall is reported here and now rather
        // than failing quietly tonight — say so plainly instead of a cheerful success toast.
        const r = await api.adminSetTelemetry(enabled);
        if (!enabled) showToast('Install statistics off', 'success');
        else if (r.first_report && r.first_report.sent) showToast('Shared — thank you', 'success');
        else showToast('Saved, but the first report did not get through — see below', 'error');
        loadTelemetry();
      } catch {
        e.target.checked = !enabled;
        showToast('Could not save that setting', 'error');
      }
    });
  }

  async function loadSsoLink() {
    const block = document.getElementById('ssoLinkBlock');
    if (!block) return;
    const head = `<h4 style="font-size:14px;margin-bottom:8px">${t('settings.signin_method')}</h4>`;
    const muted = 'color:var(--text-muted);font-size:12px';
    const paint = (inner) => { block.innerHTML = head + inner; };

    let me;
    try { me = await api.getMe(); }
    catch (e) { paint(`<p style="${muted}">${esc(e.message)}</p>`); return; }

    let providers = [];
    try {
      const res = await fetch('/api/auth/providers');
      if (res.ok) providers = (await res.json()).providers || [];
    } catch { /* offline: fall through to the no-providers copy */ }

    if (me.auth_provider && me.auth_provider !== 'local') {
      const name = providers.find((p) => p.slug === me.auth_provider)?.name || me.auth_provider;
      paint(`
        <p style="${muted};margin-bottom:12px">${t('settings.signin_linked', { provider: esc(name) })}</p>
        <div id="unlinkForm" style="display:none;margin-bottom:12px">
          <p style="${muted};margin-bottom:8px">${t('settings.signin_unlink_desc')}</p>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px">
            <div class="form-group"><label>${t('settings.new_password')}</label><input type="password" id="unlinkPw" class="input" autocomplete="new-password"></div>
            <div class="form-group"><label>${t('settings.confirm_new_password')}</label><input type="password" id="unlinkPw2" class="input" autocomplete="new-password"></div>
          </div>
          <button class="btn btn-primary btn-sm" id="unlinkConfirmBtn">${t('settings.signin_unlink_confirm')}</button>
        </div>
        <button class="btn btn-secondary btn-sm" id="unlinkBtn">${t('settings.signin_unlink', { provider: esc(name) })}</button>
      `);
      document.getElementById('unlinkBtn').onclick = () => {
        document.getElementById('unlinkForm').style.display = '';
        document.getElementById('unlinkBtn').style.display = 'none';
        document.getElementById('unlinkPw').focus();
      };
      document.getElementById('unlinkConfirmBtn').onclick = async () => {
        const pw = document.getElementById('unlinkPw').value;
        const pw2 = document.getElementById('unlinkPw2').value;
        if (pw !== pw2) return showToast(t('settings.passwords_dont_match'), 'error');
        try {
          await api.ssoUnlink(pw);
          showToast(t('settings.signin_unlinked_toast'), 'success');
          loadSsoLink();
        } catch (e) { showToast(e.message, 'error'); }
      };
      return;
    }

    if (!providers.length) {
      paint(`<p style="${muted}">${t('settings.signin_password_only')}</p>`);
      return;
    }
    paint(`
      <p style="${muted};margin-bottom:12px">${t('settings.signin_password_now')}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${providers.map((p) => `<button class="btn btn-secondary btn-sm" data-link-slug="${esc(p.slug)}">${t('settings.signin_link', { provider: esc(p.name) })}</button>`).join('')}
      </div>
    `);
    block.querySelectorAll('[data-link-slug]').forEach((btn) => {
      btn.onclick = async () => {
        const slug = btn.dataset.linkSlug;
        const name = providers.find((p) => p.slug === slug)?.name || slug;
        // Deliberately blunt: the password is destroyed, and that is the part people miss.
        if (!window.confirm(t('settings.signin_link_warning', { provider: name }))) return;
        /*
         * Fetch the authorize URL, then navigate to it. NOT location.href straight at the start
         * route: the session is a bearer token in localStorage, so a top-level navigation arrives
         * with no Authorization header and is refused as anonymous.
         */
        try {
          const { url } = await api.ssoLinkStart(slug);
          window.location.href = url;
        } catch (e) { showToast(e.message, 'error'); }
      };
    });
  }

  async function load2FA() {
    const block = document.getElementById('twoFactorBlock');
    if (!block) return;
    const head = `<h4 style="font-size:14px;margin-bottom:8px">${t('settings.2fa_title')}</h4>`;
    const muted = 'color:var(--text-muted);font-size:12px';
    const paint = (inner) => { block.innerHTML = head + inner; };

    let status;
    try { status = await api.totpStatus(); }
    catch (e) { paint(`<p style="${muted}">${esc(e.message)}</p>`); return; }

    if (!status.eligible) {
      const provider = (JSON.parse(localStorage.getItem('user') || '{}').auth_provider) || 'SSO';
      paint(`<p style="${muted}">${t('settings.2fa_sso_note', { provider: esc(provider) })}</p>`);
      return;
    }
    if (status.enabled) return showEnabled(status.recovery_codes_remaining);
    return showDisabled();

    function showDisabled() {
      paint(`
        <p style="${muted};margin-bottom:12px">${t('settings.2fa_desc')}
          <span style="color:var(--text-secondary);margin-left:6px">${t('settings.2fa_status_off')}</span></p>
        <button class="btn btn-primary btn-sm" id="enable2faBtn">${t('settings.2fa_enable')}</button>`);
      document.getElementById('enable2faBtn').addEventListener('click', startEnroll);
    }

    async function startEnroll() {
      let data;
      try { data = await api.totpSetup(); } catch (e) { showToast(e.message, 'error'); return; }
      const qr = data.qr_data_url
        ? `<img src="${data.qr_data_url}" alt="TOTP QR" width="200" height="200" style="border-radius:8px;background:#fff;padding:6px">`
        : `<p style="${muted}">${t('settings.2fa_setup_manual')}</p>`;
      paint(`
        <p style="${muted};margin-bottom:10px">${t('settings.2fa_setup_scan')}</p>
        <div style="display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start">
          <div>${qr}</div>
          <div style="flex:1;min-width:220px">
            <p style="${muted}">${t('settings.2fa_setup_manual')}</p>
            <code style="display:block;word-break:break-all;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;padding:8px;margin:6px 0 14px;font-family:monospace;font-size:13px">${esc(data.secret)}</code>
            <label style="${muted}">${t('settings.2fa_setup_confirm')}</label>
            <input type="text" id="enroll2faCode" class="input" inputmode="numeric" autocomplete="one-time-code" placeholder="${t('settings.2fa_code_placeholder')}" maxlength="6" style="letter-spacing:4px;text-align:center;font-family:monospace;margin:6px 0">
            <div style="display:flex;gap:8px;margin-top:6px">
              <button class="btn btn-primary btn-sm" id="enroll2faVerify">${t('settings.2fa_verify_enable')}</button>
              <button class="btn btn-secondary btn-sm" id="enroll2faCancel">${t('settings.2fa_cancel')}</button>
            </div>
          </div>
        </div>`);
      const codeEl = document.getElementById('enroll2faCode');
      codeEl.focus();
      const doEnable = async () => {
        const code = codeEl.value.trim();
        if (!code) { showToast(t('settings.2fa_code_required'), 'error'); return; }
        try {
          const r = await api.totpEnable(code);
          showToast(t('settings.2fa_enabled_toast'), 'success');
          showRecoveryCodes(r.recovery_codes);
        } catch (e) { showToast(e.message, 'error'); codeEl.select(); }
      };
      document.getElementById('enroll2faVerify').addEventListener('click', doEnable);
      codeEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doEnable(); });
      document.getElementById('enroll2faCancel').addEventListener('click', load2FA);
    }

    function showRecoveryCodes(codes) {
      const list = codes.map((c) => `<div>${esc(c)}</div>`).join('');
      const text = codes.join('\n');
      paint(`
        <p style="font-weight:600;margin-bottom:4px">${t('settings.2fa_recovery_title')}</p>
        <p style="${muted};margin-bottom:12px">${t('settings.2fa_recovery_warning')}</p>
        <div style="font-family:monospace;font-size:14px;letter-spacing:1px;background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:14px;display:grid;grid-template-columns:repeat(2,1fr);gap:6px 24px">${list}</div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          <button class="btn btn-secondary btn-sm" id="copyRecovery">${t('settings.2fa_recovery_copy')}</button>
          <button class="btn btn-secondary btn-sm" id="dlRecovery">${t('settings.2fa_recovery_download')}</button>
          <button class="btn btn-primary btn-sm" id="doneRecovery">${t('settings.2fa_recovery_done')}</button>
        </div>`);
      document.getElementById('copyRecovery').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(text); showToast(t('settings.2fa_recovery_copy'), 'success'); } catch { /* field is selectable */ }
      });
      document.getElementById('dlRecovery').addEventListener('click', () => {
        const blob = new Blob([text + '\n'], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'screentinker-recovery-codes.txt';
        a.click();
        URL.revokeObjectURL(a.href);
      });
      document.getElementById('doneRecovery').addEventListener('click', load2FA);
    }

    function showEnabled(remaining) {
      paint(`
        <p style="margin-bottom:12px">
          <span style="color:var(--success);font-weight:600">✓ ${t('settings.2fa_status_on')}</span>
          <span style="${muted};margin-left:10px">${t('settings.2fa_recovery_remaining', { n: remaining })}</span></p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-secondary btn-sm" id="regen2faBtn">${t('settings.2fa_recovery_regenerate')}</button>
          <button class="btn btn-danger btn-sm" id="disable2faBtn">${t('settings.2fa_disable')}</button>
        </div>
        <div id="twoFactorAction" style="margin-top:12px"></div>`);
      document.getElementById('disable2faBtn').addEventListener('click', () => promptCode({
        prompt: t('settings.2fa_disable_prompt'), confirm: t('settings.2fa_disable_confirm'), danger: true,
        run: async (code) => { await api.totpDisable(code); showToast(t('settings.2fa_disabled_toast'), 'success'); load2FA(); },
      }));
      document.getElementById('regen2faBtn').addEventListener('click', () => promptCode({
        prompt: t('settings.2fa_regen_prompt'), confirm: t('settings.2fa_regen_confirm'),
        run: async (code) => { const r = await api.totpRegenRecovery(code); showRecoveryCodes(r.recovery_codes); },
      }));
    }

    function promptCode({ prompt, confirm, danger, run }) {
      const box = document.getElementById('twoFactorAction');
      box.innerHTML = `
        <p style="${muted};margin-bottom:6px">${prompt}</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input type="text" id="twoFactorActionCode" class="input" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="${t('settings.2fa_code_placeholder')}" maxlength="12" style="max-width:170px;letter-spacing:3px;text-align:center;font-family:monospace">
          <button class="btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}" id="twoFactorActionConfirm">${confirm}</button>
          <button class="btn btn-secondary btn-sm" id="twoFactorActionCancel">${t('settings.2fa_cancel')}</button>
        </div>`;
      const codeEl = document.getElementById('twoFactorActionCode');
      codeEl.focus();
      const go = async () => {
        const code = codeEl.value.trim();
        if (!code) { showToast(t('settings.2fa_code_required'), 'error'); return; }
        try { await run(code); } catch (e) { showToast(e.message, 'error'); codeEl.select(); }
      };
      document.getElementById('twoFactorActionConfirm').addEventListener('click', go);
      codeEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      document.getElementById('twoFactorActionCancel').addEventListener('click', () => { box.innerHTML = ''; });
    }
  }

  loadTokens();
  load2FA();
  loadSsoLink();

  /*
   * Report the outcome of a link round trip.
   *
   * The callback returns to #/settings rather than the login page — an authenticated user bounced
   * to a login screen to be told "that did not work" reads as having been signed out. Params are
   * stripped afterwards so a refresh or a copied URL does not replay the message.
   */
  (function reportLinkOutcome() {
    const q = new URLSearchParams((location.hash.split('?')[1] || ''));
    const linked = q.get('sso_linked');
    const err = q.get('sso_error');
    if (!linked && !err) return;
    if (linked) {
      showToast(t('settings.signin_linked_toast', { provider: linked }), 'success');
    } else {
      const known = ['link_email_mismatch', 'link_already_used', 'not_linkable', 'no_email',
        'email_unverified', 'verification_failed', 'provider_unavailable', 'provider_refused',
        'unknown_provider', 'expired', 'bad_state', 'no_code', 'server_error'];
      const key = known.includes(err) ? `settings.signin_err_${err}` : 'auth.sso_failed';
      showToast(t(key), 'error');
    }
    history.replaceState(null, '', location.pathname + location.search + '#/settings');
    loadSsoLink();
  }());

  // #73: agency scope reveals a playlist picker (the token's allowlist). Loaded lazily once.
  const tokScopeSel = document.getElementById('tokScope');
  let agencyPlaylistsLoaded = false;
  tokScopeSel?.addEventListener('change', async () => {
    const picker = document.getElementById('agencyPlaylistPicker');
    const isAgency = tokScopeSel.value === 'agency';
    picker.style.display = isAgency ? 'block' : 'none';
    if (isAgency && !agencyPlaylistsLoaded) {
      agencyPlaylistsLoaded = true;
      const list = document.getElementById('agencyPlaylistList');
      const pls = await api.getPlaylists().catch(() => []);
      list.innerHTML = pls.length
        ? pls.map(p => p.zoned
            ? `<label style="display:flex;gap:8px;align-items:center;font-size:13px;opacity:.5"><input type="checkbox" disabled> ${esc(p.name)} <span style="font-size:11px;color:var(--text-muted)">— ${esc(t('apitoken.zoned_playlist_reason'))}</span></label>`
            : `<label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" class="agency-pl" value="${esc(String(p.id))}"> ${esc(p.name)}</label>`).join('')
        : `<p style="color:var(--text-muted);font-size:12px">${t('apitoken.agency_no_playlists')}</p>`;
      // #158: offer existing folders to bind, or leave on the auto-create default.
      const folders = await api.getFolders().catch(() => []);
      const fsel = document.getElementById('tokUploadFolder');
      if (fsel && folders.length) fsel.insertAdjacentHTML('beforeend', folders.map(f => `<option value="${esc(String(f.id))}">${esc(f.name)}</option>`).join(''));
    }
  });

  /* ── Per-organization SSO ──────────────────────────────────────────────────────────────────
   *
   * Only an org owner/admin sees this. The server enforces the same rule (and answers 404, not
   * 403, so an outsider learns nothing) — this just avoids showing a card the user cannot use.
   */
  const orgId = user.current_organization?.id;
  const canManageSso = orgId && ['org_owner', 'org_admin'].includes(user.current_org_role);

  async function loadSso() {
    const card = document.getElementById('ssoCard');
    if (!card || !canManageSso) return;
    card.style.display = '';
    const listEl = document.getElementById('ssoList');
    let providers = [];
    try {
      const res = await fetch(`/api/organizations/${orgId}/sso`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      });
      if (!res.ok) throw new Error('load failed');
      providers = (await res.json()).providers || [];
    } catch {
      listEl.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${esc(t('sso.load_failed'))}</p>`;
      return;
    }

    if (!providers.length) {
      listEl.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${esc(t('sso.none'))}</p>`;
      return;
    }

    // Requiring SSO is a separate decision from having it, so it gets its own block rather than
    // hiding inside a provider — an organization may have several providers and one answer.
    let onlyState = null;
    try {
      const r = await fetch(`/api/organizations/${orgId}/sso-only`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      });
      if (r.ok) onlyState = await r.json();
    } catch { /* the providers still render; the toggle simply does not appear */ }

    const origin = `${window.location.protocol}//${window.location.host}`;
    listEl.innerHTML = providers.map((p) => `
      <div style="border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <div>
            <strong>${esc(p.name)}</strong>
            ${p.enabled ? '' : `<span style="font-size:11px;color:var(--text-muted)"> — ${esc(t('sso.disabled'))}</span>`}
            <div style="font-size:12px;color:var(--text-muted);margin-top:2px">${esc(p.issuer)}</div>
            <div style="font-size:12px;color:var(--text-muted)">${esc(t('sso.domains_label'))}: ${esc(p.email_domains || '—')}</div>
            ${((p.domains || []).some((d) => !d.verified) || (p.domains || []).length === 0)
              ? `<div style="font-size:12px;color:var(--warning,#b45309);margin-top:2px">⚠️ ${esc(t('sso.unverified_warning'))}</div>`
              : ''}
          </div>
          <!-- wrap, do not shrink-to-clip: at 375px this row ran to x=417 on a 375px viewport and
               the page does not scroll horizontally, so "Remove" was simply unreachable. -->
          <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
            <button class="btn btn-secondary btn-sm" data-sso-test="${esc(p.id)}">${esc(t('sso.test'))}</button>
            <button class="btn btn-secondary btn-sm" data-sso-edit="${esc(p.id)}">${esc(t('sso.edit'))}</button>
            <button class="btn btn-secondary btn-sm" data-sso-toggle="${esc(p.id)}" data-enabled="${p.enabled ? '1' : '0'}">
              ${esc(p.enabled ? t('sso.disable') : t('sso.enable'))}
            </button>
            <button class="btn btn-danger btn-sm" data-sso-delete="${esc(p.id)}">${esc(t('sso.delete'))}</button>
          </div>
        </div>
        <!-- The admin has to paste this into their identity provider, and it must match character
             for character, so it is shown rather than described. -->
        <div style="margin-top:8px;font-size:12px">
          <div style="color:var(--text-muted)">${esc(t('sso.callback_label'))}</div>
          <code style="display:block;word-break:break-all;padding:6px;background:var(--bg-secondary);border-radius:4px">${esc(origin + p.callback_url)}</code>
        </div>

        <!-- Editing is per provider, because an organization may have several (one per domain, or
             one per identity provider after a merger) and they are configured independently. -->
        <!-- Domain proof. A claimed domain routes NOBODY until DNS confirms the organization
             controls it, so the state of each one is shown plainly rather than left to be inferred
             from a login that silently does not work. -->
        ${(p.domains || []).length ? `
        <div style="margin-top:10px;font-size:12px">
          <div style="color:var(--text-muted);margin-bottom:4px">${esc(t('sso.domains_heading'))}</div>
          ${p.domains.map((d, di) => `
            <div style="border:1px solid var(--border);border-radius:4px;padding:8px;margin-bottom:6px">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
                <div><strong>${esc(d.domain)}</strong>
                  ${d.verified
                    ? `<span style="color:var(--success,#15803d)"> — ${esc(t('sso.domain_verified'))}</span>`
                    : `<span style="color:var(--warning,#b45309)"> — ${esc(t('sso.domain_pending'))}</span>`}
                </div>
                ${d.verified ? '' : `<button class="btn btn-secondary btn-sm" data-sso-verify="${esc(p.id)}" data-domain="${esc(d.domain)}" data-di="${di}">${esc(t('sso.verify_now'))}</button>`}
              </div>
              ${d.verified ? '' : `
                <div style="margin-top:6px;color:var(--text-muted)">${esc(t('sso.dns_instructions'))}</div>
                <code style="display:block;word-break:break-all;padding:6px;background:var(--bg-secondary);border-radius:4px;margin-top:4px">${esc(d.record_name)}  TXT  ${esc(d.txt_value)}</code>
`}
              <!-- ONE place for the outcome. The last failure is persisted server-side and was
                   rendered here, while the click handler wrote the live result into a second
                   element below it — so retrying showed the identical sentence twice, in two
                   different colours. The handler replaces this element's text instead. -->
              <div id="ssoVerify-${esc(p.id)}-${di}" style="margin-top:4px;color:var(--danger,#b91c1c)">${d.verified ? '' : esc(d.last_error || '')}</div>
            </div>`).join('')}
        </div>` : ''}

        <div id="ssoTest-${esc(p.id)}" style="display:none;margin-top:8px;font-size:12px"></div>
        <div id="ssoEdit-${esc(p.id)}" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--border);display:none">
          <div style="display:grid;gap:10px;max-width:560px">
            <div class="form-group"><label>${esc(t('sso.f_name'))}</label>
              <input type="text" class="input" data-f="name" value="${esc(p.name)}"></div>
            <div class="form-group"><label>${esc(t('sso.f_issuer'))}</label>
              <input type="url" class="input" data-f="issuer" value="${esc(p.issuer)}"></div>
            <div class="form-group"><label>${esc(t('sso.f_client_id'))}</label>
              <input type="text" class="input" data-f="client_id" value="${esc(p.client_id)}"></div>
            <div class="form-group"><label>${esc(t('sso.f_client_secret'))}</label>
              <input type="password" class="input" data-f="client_secret" autocomplete="new-password"
                     placeholder="${esc(p.has_client_secret ? t('sso.secret_set') : t('sso.secret_none'))}">
              <!-- A secret can never be shown back: the API does not return it. Blank therefore means
                   "leave it alone" rather than "clear it", which is what stops a save from silently
                   wiping a working configuration. Clearing is a separate, explicit choice. -->
              <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${esc(t('sso.secret_edit_hint'))}</div>
              ${p.has_client_secret ? `
              <label style="display:flex;align-items:center;gap:6px;font-size:12px;margin-top:6px">
                <input type="checkbox" data-f="clear_secret"> ${esc(t('sso.secret_clear'))}
              </label>` : ''}
            </div>
            <div class="form-group"><label>${esc(t('sso.f_domains'))}</label>
              <input type="text" class="input" data-f="email_domains" value="${esc(p.email_domains)}"></div>
            <div style="display:flex;gap:6px">
              <button class="btn btn-primary btn-sm" data-sso-save="${esc(p.id)}">${esc(t('sso.save'))}</button>
              <button class="btn btn-secondary btn-sm" data-sso-cancel="${esc(p.id)}">${esc(t('sso.cancel'))}</button>
            </div>
          </div>
        </div>
      </div>`).join('');

    listEl.querySelectorAll('[data-sso-toggle]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await ssoRequest('PUT', `/${btn.dataset.ssoToggle}`, { enabled: btn.dataset.enabled !== '1' });
      });
    });
    /*
     * Ask the server to look for the DNS record now. Pull-based on purpose: the admin has just
     * edited DNS and wants an answer, and a failure has to say WHICH failure — not published yet,
     * published wrong, or the claim expired and the record has changed underneath them.
     */
    if (onlyState) {
      const pend = onlyState.pending_removal_request;
      const box = document.createElement('div');
      box.style.cssText = 'border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin-top:4px';
      box.innerHTML = `
        <div style="font-weight:600;margin-bottom:4px">${esc(t('sso.only_heading'))}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">${esc(t('sso.only_help'))}</div>
        ${onlyState.sso_only ? `
          <div style="font-size:13px;margin-bottom:8px">✅ ${esc(t('sso.only_on'))}</div>
          ${pend
            ? `<div style="font-size:12px;color:var(--warning,#b45309)">⏳ ${esc(t('sso.only_pending'))}</div>
               <button class="btn btn-secondary btn-sm" id="ssoOnlyCancel" data-req="${esc(pend.id)}" style="margin-top:6px">${esc(t('sso.only_cancel'))}</button>`
            : `<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">${esc(t('sso.only_remove_help'))}</div>
               <button class="btn btn-secondary btn-sm" id="ssoOnlyRequest">${esc(t('sso.only_request'))}</button>`}
        ` : `
          <div style="font-size:13px;margin-bottom:8px">${esc(t('sso.only_off'))}</div>
          ${onlyState.verified_domains
            ? `<button class="btn btn-secondary btn-sm" id="ssoOnlyEnable">${esc(t('sso.only_enable'))}</button>`
            : `<div style="font-size:12px;color:var(--warning,#b45309)">⚠️ ${esc(t('sso.only_needs_domain'))}</div>`}
        `}`;
      listEl.appendChild(box);

      const post = async (url, body, method = 'POST') => {
        const r = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
          body: body ? JSON.stringify(body) : undefined,
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { showToast(j.error || t('sso.only_failed'), 'error'); return null; }
        return j;
      };

      const enableBtn = box.querySelector('#ssoOnlyEnable');
      if (enableBtn) enableBtn.addEventListener('click', async () => {
        // Confirmed, because it removes the only way in for everyone at these domains, and the way
        // back needs the operator rather than this button.
        if (!window.confirm(t('sso.only_confirm'))) return;
        const r = await post(`/api/organizations/${orgId}/sso-only`);
        if (r) {
          showToast(t('sso.only_on'), 'success');
          /*
           * Name the people who just lost their only way in. The server reports them precisely so
           * the admin finds out HERE rather than from a support ticket — and it was being thrown
           * away, which made the whole warning pointless.
           */
          const stranded = r.stranded_members || [];
          if (stranded.length) {
            window.alert(t('sso.only_stranded', { list: stranded.join('\n') }));
          }
          await loadSso();
        }
      });

      const reqBtn = box.querySelector('#ssoOnlyRequest');
      if (reqBtn) reqBtn.addEventListener('click', async () => {
        const reason = window.prompt(t('sso.only_reason_prompt')) || '';
        const r = await post(`/api/organizations/${orgId}/sso-only/removal-request`, { reason });
        if (r) { showToast(t('sso.only_requested'), 'success'); await loadSso(); }
      });

      const cancelBtn = box.querySelector('#ssoOnlyCancel');
      if (cancelBtn) cancelBtn.addEventListener('click', async () => {
        const r = await post(`/api/organizations/${orgId}/sso-only/removal-request/${cancelBtn.dataset.req}`, null, 'DELETE');
        if (r) { showToast(t('sso.only_cancelled'), 'success'); await loadSso(); }
      });
    }

    listEl.querySelectorAll('[data-sso-verify]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.ssoVerify;
        const domain = btn.dataset.domain;
        // Indexed, not derived from the domain: `a.b.test` and `a-b.test` both slugify to
        // `a-b-test`, and getElementById would put one domain's answer in the other's box.
        const out = document.getElementById(`ssoVerify-${id}-${btn.dataset.di}`);
        btn.disabled = true;
        if (out) { out.style.color = 'var(--text-muted)'; out.textContent = t('sso.verifying'); }
        try {
          const res = await fetch(`/api/organizations/${orgId}/sso/${id}/domains/${encodeURIComponent(domain)}/verify`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
          });
          const body = await res.json().catch(() => ({}));
          if (body.ok) {
            showToast(t('sso.domain_verified_toast', { domain }), 'success');
            await loadSso();       // re-render: the domain now routes, and the card must say so
            return;
          }
          // An expired claim has already been reissued server-side, so the records on screen are
          // stale — reload rather than leaving the admin publishing a value that no longer matches.
          if (body.expired) {
            showToast(body.error || t('sso.verify_failed'), 'error');
            await loadSso();
            return;
          }
          if (out) { out.style.color = 'var(--danger,#b91c1c)'; out.textContent = body.error || t('sso.verify_failed'); }
        } catch {
          if (out) { out.style.color = 'var(--danger,#b91c1c)'; out.textContent = t('sso.verify_failed'); }
        } finally {
          btn.disabled = false;
        }
      });
    });
    listEl.querySelectorAll('[data-sso-test]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.ssoTest;
        const out = document.getElementById(`ssoTest-${id}`);
        if (!out) return;
        out.style.display = '';
        out.textContent = t('sso.testing');
        try {
          const res = await fetch(`/api/organizations/${orgId}/sso/${id}/test`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
          });
          const data = await res.json();
          if (!res.ok) { out.textContent = data.error || t('sso.test_failed'); return; }
          /*
           * Literal keys, never a key built by concatenating a check name. Doing that defeats the
           * check in server/test/i18n-keys-exist.js that every key an operator can see is
           * translated — and a check name the UI does not know would render as raw key text. The
           * fallback keeps an unknown one readable instead.
           */
          const CHECK_LABELS = {
            discovery: t('sso.check_discovery'),
            endpoints: t('sso.check_endpoints'),
            signing_keys: t('sso.check_signing_keys'),
          };
          const rows = (data.checks || []).map((c) => `
            <div>${c.ok ? '✅' : '❌'} ${esc(CHECK_LABELS[c.name] || c.name)} — <span style="color:var(--text-muted)">${esc(c.detail || '')}</span></div>`).join('');
          /*
           * The caveat is shown on SUCCESS, not tucked away. Discovery and keys prove the provider
           * exists and that we could verify a token it signs — they say nothing about whether the
           * client id, the secret, or the redirect URI registration are right. A green tick that
           * implied "SSO works" would send an admin away from the one thing still to check.
           */
          out.innerHTML = rows + (data.ok
            ? `<div style="margin-top:6px;color:var(--text-muted)">${esc(t('sso.test_caveat'))}</div>`
            : '');
        } catch {
          out.textContent = t('sso.test_failed');
        }
      });
    });
    listEl.querySelectorAll('[data-sso-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const panel = document.getElementById(`ssoEdit-${btn.dataset.ssoEdit}`);
        if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      });
    });
    listEl.querySelectorAll('[data-sso-cancel]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const panel = document.getElementById(`ssoEdit-${btn.dataset.ssoCancel}`);
        if (panel) panel.style.display = 'none';
      });
    });
    listEl.querySelectorAll('[data-sso-save]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const panel = document.getElementById(`ssoEdit-${btn.dataset.ssoSave}`);
        if (!panel) return;
        const val = (f) => panel.querySelector(`[data-f="${f}"]`)?.value?.trim() ?? '';
        const body = {
          name: val('name'),
          issuer: val('issuer'),
          client_id: val('client_id'),
          email_domains: val('email_domains'),
        };
        /*
         * Three states, and only these three:
         *   typed a value        -> replace the secret
         *   ticked "remove"      -> send '' so the server clears it
         *   left blank, unticked -> send NOTHING, so the stored secret survives
         * Sending '' on every save is the bug this shape exists to avoid.
         */
        const typed = panel.querySelector('[data-f="client_secret"]')?.value || '';
        const clearing = panel.querySelector('[data-f="clear_secret"]')?.checked;
        if (typed) body.client_secret = typed;
        else if (clearing) body.client_secret = '';

        if (!body.name || !body.issuer || !body.client_id) {
          showToast(t('sso.missing_fields'), 'error');
          return;
        }
        await ssoRequest('PUT', `/${btn.dataset.ssoSave}`, body);
      });
    });
    listEl.querySelectorAll('[data-sso-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm(t('sso.confirm_delete'))) return;
        await ssoRequest('DELETE', `/${btn.dataset.ssoDelete}`);
      });
    });
  }

  async function ssoRequest(method, path = '', body) {
    try {
      const res = await fetch(`/api/organizations/${orgId}/sso${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('token')}`,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      // The server's message is the useful one here — a bad issuer or a domain already claimed by
      // another organization both say exactly what went wrong, and a generic failure would not.
      if (!res.ok) { showToast(data.error || t('sso.save_failed'), 'error'); return false; }
      // "Saved" for a DELETE read as though nothing had been destroyed.
      showToast(t(method === 'DELETE' ? 'sso.removed' : 'sso.saved'), 'success');
      await loadSso();
      return true;
    } catch {
      showToast(t('sso.save_failed'), 'error');
      return false;
    }
  }

  document.getElementById('ssoCreateBtn')?.addEventListener('click', async () => {
    const payload = {
      name: document.getElementById('ssoName').value.trim(),
      issuer: document.getElementById('ssoIssuer').value.trim(),
      client_id: document.getElementById('ssoClientId').value.trim(),
      client_secret: document.getElementById('ssoClientSecret').value,
      email_domains: document.getElementById('ssoDomains').value.trim(),
    };
    if (!payload.name || !payload.issuer || !payload.client_id) {
      showToast(t('sso.missing_fields'), 'error');
      return;
    }
    if (await ssoRequest('POST', '', payload)) {
      ['ssoName', 'ssoIssuer', 'ssoClientId', 'ssoClientSecret', 'ssoDomains']
        .forEach((id) => { document.getElementById(id).value = ''; });
      document.getElementById('ssoAddDetails').open = false;
    }
  });

  loadSso();


  document.getElementById('createTokenBtn')?.addEventListener('click', async () => {
    const name = document.getElementById('tokName').value.trim();
    const scope = document.getElementById('tokScope').value;
    const payload = { name, scope };
    if (scope === 'agency') {
      const ids = [...document.querySelectorAll('#agencyPlaylistList .agency-pl:checked')].map(c => c.value);
      if (!ids.length) return showToast(t('apitoken.agency_needs_playlists'), 'error');
      payload.target_playlist_ids = ids;
      payload.auto_publish = !!document.getElementById('tokAutoPublish')?.checked;
      // #158: blank = auto-create "Agency — <name>"; a value binds that existing folder.
      const fv = document.getElementById('tokUploadFolder')?.value;
      if (fv) payload.upload_folder_id = fv;
    }
    const btn = document.getElementById('createTokenBtn');
    btn.disabled = true;
    try {
      const r = await api.createToken(payload);
      const box = document.getElementById('tokenSecretBox');
      box.style.display = 'block';
      // #73: for agency tokens, surface the handoff (portal URL + a copyable invite). The key
      // is in the invite TEXT, never in a URL (Cloudflare logs query strings + chat apps unfurl
      // links). window.location.origin is the real public host the admin is on (correct behind CF).
      const portalUrl = window.location.origin + '/agency';
      const inviteText = t('apitoken.invite_text', { url: portalUrl, key: r.token });
      box.innerHTML = `
        <div style="background:var(--bg-secondary);border:1px solid var(--accent);border-radius:var(--radius);padding:16px;margin-bottom:16px">
          <h4 style="font-size:14px;margin-bottom:8px">${t('apitoken.secret_title')}</h4>
          <p style="color:var(--danger);font-size:12px;margin-bottom:12px"><strong>${t('apitoken.secret_warning')}</strong></p>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="text" class="input" readonly value="${esc(r.token)}" style="font-family:monospace;flex:1" onclick="this.select()">
            <button class="btn btn-secondary btn-sm" id="copyTokenBtn">${t('apitoken.copy')}</button>
          </div>
          ${scope === 'agency' ? `
          <div style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px">
            <label style="font-size:12px;color:var(--text-muted)">${t('apitoken.portal_url_label')}</label>
            <input type="text" class="input" readonly value="${esc(portalUrl)}" style="width:100%;margin-top:4px" onclick="this.select()">
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-top:10px">${t('apitoken.invite_label')}</label>
            <textarea class="input" readonly rows="2" style="width:100%;margin-top:4px;font-size:13px;font-family:inherit" onclick="this.select()">${esc(inviteText)}</textarea>
            <button class="btn btn-secondary btn-sm" id="copyInviteBtn" style="margin-top:8px">${t('apitoken.copy_invite')}</button>
          </div>` : ''}
        </div>
      `;
      document.getElementById('copyTokenBtn')?.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(r.token);
          showToast(t('apitoken.copied'), 'success');
        } catch { /* clipboard may be unavailable; the field is selectable */ }
      });
      document.getElementById('copyInviteBtn')?.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(inviteText); // full "go here + paste key" text
          showToast(t('apitoken.copied'), 'success');
        } catch { /* field is selectable as a fallback */ }
      });
      document.getElementById('tokName').value = '';
      showToast(t('apitoken.created_toast'), 'success');
      loadTokens();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('saveAcctBtn')?.addEventListener('click', async () => {
    const name = document.getElementById('acctName').value.trim();
    if (!name) return showToast(t('settings.toast.name_required'), 'error');
    const email_alerts = !!document.getElementById('acctEmailAlerts')?.checked;
    const btn = document.getElementById('saveAcctBtn');
    btn.disabled = true;
    try {
      const updated = await api.updateMe({ name, email_alerts });
      const stored = JSON.parse(localStorage.getItem('user') || '{}');
      localStorage.setItem('user', JSON.stringify({ ...stored, ...updated }));
      showToast(t('settings.toast.profile_saved'), 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('changePwBtn')?.addEventListener('click', async () => {
    const current = document.getElementById('acctCurrentPw').value;
    const next = document.getElementById('acctNewPw').value;
    const confirm = document.getElementById('acctConfirmPw').value;
    if (!current) return showToast(t('settings.toast.current_password_required'), 'error');
    if (next.length < 8) return showToast(t('settings.toast.new_password_min_8'), 'error');
    if (next !== confirm) return showToast(t('settings.toast.passwords_dont_match'), 'error');
    const btn = document.getElementById('changePwBtn');
    btn.disabled = true;
    try {
      await api.updateMe({ current_password: current, password: next });
      document.getElementById('acctCurrentPw').value = '';
      document.getElementById('acctNewPw').value = '';
      document.getElementById('acctConfirmPw').value = '';
      showToast(t('settings.toast.password_changed'), 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('widgetSandboxIsolationToggle')?.addEventListener('change', async (e) => {
    const checkbox = e.currentTarget;
    const shouldEnableIsolation = !!checkbox.checked;
    const workspaceId = user.current_workspace_id;
    if (!workspaceId) {
      checkbox.checked = !shouldEnableIsolation;
      showToast('No active workspace', 'error');
      return;
    }

    if (!shouldEnableIsolation) {
      const confirmed = await openWidgetSandboxDisableConfirmModal(WIDGET_ISOLATION_CONFIRM_PHRASE);
      if (!confirmed) {
        checkbox.checked = true;
        return;
      }
      try {
        await api.updateWorkspaceSecuritySettings(workspaceId, {
          widgetSandboxIsolationDisabled: true,
          confirmationPhrase: WIDGET_ISOLATION_CONFIRM_PHRASE,
        });
        const nextUser = { ...user, current_organization: { ...(user.current_organization || {}), widget_sandbox_isolation_disabled: 1 } };
        localStorage.setItem('user', JSON.stringify(nextUser));
        showToast('Widget sandbox isolation disabled', 'success');
      } catch (err) {
        checkbox.checked = true;
        showToast(err.message, 'error');
      }
      return;
    }

    try {
      await api.updateWorkspaceSecuritySettings(workspaceId, { widgetSandboxIsolationDisabled: false });
      const nextUser = { ...user, current_organization: { ...(user.current_organization || {}), widget_sandbox_isolation_disabled: 0 } };
      localStorage.setItem('user', JSON.stringify(nextUser));
      showToast('Widget sandbox isolation enabled', 'success');
    } catch (err) {
      checkbox.checked = false;
      showToast(err.message, 'error');
    }
  });
}

function openWidgetSandboxDisableConfirmModal(confirmationPhrase) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    overlay.innerHTML = `
      <div class="modal" style="width:min(760px,96vw)">
        <div class="modal-header"><h3>Disable widget sandbox isolation for this organization</h3></div>
        <div class="modal-body" style="white-space:pre-wrap;line-height:1.45">
Widget HTML currently runs in a null-origin sandbox. That means widget code
cannot read your session, your cookies, or anything else stored by
ScreenTinker in this browser.

Turning this off re-enables allow-same-origin. Widget HTML will then run with
the same privileges as ScreenTinker itself. Any script in any widget in this
organization will be able to:

  - Read the device token of every display that shows the widget, and act as
    that display against the ScreenTinker API
  - Read the session token of any logged-in user who opens a display in their
    own browser
  - Call the ScreenTinker API as that user, including admin actions
  - Read and modify content on every other display in this organization
  - Silently exfiltrate all of the above to any server it likes

The widget editor's Preview is NOT affected: it renders inside the dashboard,
where your session lives, so it stays isolated whatever this setting says. A
widget may therefore behave differently in Preview than on a display.

Because allow-scripts is also required for widgets to function, a widget can
remove its own sandbox entirely once same-origin is granted. There is no
partial protection left after this point.

Only enable this if every widget source in this organization is code you
wrote, or code from a party you would trust with your admin password. A single
compromised third-party embed, CDN, or ad tag is enough.

This setting applies to ALL widgets in this organization and cannot be scoped
per display.
          <div class="form-group" style="margin-top:16px">
            <label for="widgetSandboxConfirmInput">Type the phrase below to confirm:</label>
            <div style="margin:6px 0 8px;font-weight:600">${esc(confirmationPhrase)}</div>
            <input id="widgetSandboxConfirmInput" type="text" class="input" autocomplete="off">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="widgetSandboxConfirmCancel">Cancel</button>
          <button class="btn btn-danger" id="widgetSandboxConfirmSubmit" disabled>Disable isolation</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('#widgetSandboxConfirmInput');
    const submit = overlay.querySelector('#widgetSandboxConfirmSubmit');
    const close = (ok) => {
      overlay.remove();
      resolve(ok);
    };
    const updateEnabled = () => {
      submit.disabled = input.value.trim() !== confirmationPhrase;
    };
    input.addEventListener('input', updateEnabled);
    overlay.querySelector('#widgetSandboxConfirmCancel').addEventListener('click', () => close(false));
    submit.addEventListener('click', () => close(true));
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(false); });
  });
}

async function loadWhiteLabel() {
  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };

  // Only show white-label for enterprise plans or platform admins.
  // Use the fresh user cached by render() above, which called api.getMe().
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  const section = document.getElementById('whiteLabelSection');
  if (section && user.plan_id !== 'enterprise' && !isPlatformAdmin(user)) {
    section.innerHTML = `
      <h3>${t('settings.white_label')}</h3>
      <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:16px;text-align:center">
        <p style="color:var(--text-secondary);font-size:14px;margin-bottom:8px">${t('settings.white_label_enterprise_only')}</p>
        <a href="#/billing" class="btn btn-secondary btn-sm" style="text-decoration:none">${t('settings.view_plans')}</a>
      </div>
    `;
    return;
  }

  try {
    const res = await fetch('/api/white-label', { headers });
    const wl = await res.json();

    if (wl.brand_name) document.getElementById('wlBrandName').value = wl.brand_name;
    if (wl.logo_url) document.getElementById('wlLogoUrl').value = wl.logo_url;
    if (wl.primary_color) document.getElementById('wlPrimaryColor').value = wl.primary_color;
    if (wl.bg_color) document.getElementById('wlBgColor').value = wl.bg_color;
    if (wl.custom_domain) document.getElementById('wlDomain').value = wl.custom_domain;
    if (wl.favicon_url) document.getElementById('wlFavicon').value = wl.favicon_url;
    if (wl.custom_css) document.getElementById('wlCustomCss').value = wl.custom_css;
    if (wl.hide_branding) document.getElementById('wlHideBranding').checked = true;
  } catch {}

  document.getElementById('saveWhiteLabelBtn')?.addEventListener('click', async () => {
    try {
      await fetch('/api/white-label', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brand_name: document.getElementById('wlBrandName').value,
          logo_url: document.getElementById('wlLogoUrl').value,
          primary_color: document.getElementById('wlPrimaryColor').value,
          bg_color: document.getElementById('wlBgColor').value,
          custom_domain: document.getElementById('wlDomain').value,
          favicon_url: document.getElementById('wlFavicon').value,
          custom_css: document.getElementById('wlCustomCss').value,
          hide_branding: document.getElementById('wlHideBranding').checked ? 1 : 0,
        })
      });
      await resetBranding();
      showToast(t('settings.toast.branding_saved'), 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('previewWhiteLabelBtn')?.addEventListener('click', () => {
    const primary = document.getElementById('wlPrimaryColor').value;
    const bg = document.getElementById('wlBgColor').value;
    document.documentElement.style.setProperty('--accent', primary);
    document.documentElement.style.setProperty('--bg-primary', bg);
    showToast(t('settings.toast.preview_applied'), 'info');
  });
}

async function loadUsers() {
  const el = document.getElementById('userManagement');
  if (!el) return;

  try {
    const [users, plans] = await Promise.all([
      api.getUsers(),
      fetch('/api/subscription/plans').then(r => r.json())
    ]);

    const currentUser = JSON.parse(localStorage.getItem('user') || '{}');

    el.innerHTML = `
      <div class="table-wrap">
      <table style="width:100%;border-collapse:collapse;font-size:13px;min-width:520px">
        <thead>
          <tr style="border-bottom:1px solid var(--border);text-align:left">
            <th style="padding:8px 12px;color:var(--text-muted);font-weight:500">${t('settings.user.col_user')}</th>
            <th style="padding:8px 12px;color:var(--text-muted);font-weight:500">${t('settings.user.col_auth')}</th>
            <th style="padding:8px 12px;color:var(--text-muted);font-weight:500">${t('settings.user.col_role')}</th>
            <th style="padding:8px 12px;color:var(--text-muted);font-weight:500">${t('settings.user.col_plan')}</th>
            <th style="padding:8px 12px;color:var(--text-muted);font-weight:500">${t('settings.user.col_actions')}</th>
          </tr>
        </thead>
        <tbody>
          ${users.map(u => `
            <!-- ESCAPED. A SECOND copy of the platform users table lives here, rendered from the
                 same endpoint as the one in views/admin.js. Escaping only that one left this whole
                 table wide open, including a raw text node for the email - and an org or workspace
                 admin can choose an email, so this executed in the platform admin's session. When
                 you touch one of these tables, touch both. -->
            <tr style="border-bottom:1px solid var(--border)" data-user-id="${esc(u.id)}">
              <td style="padding:10px 12px">
                <div style="font-weight:500">${esc(u.name || u.email)}</div>
                <div style="font-size:11px;color:var(--text-muted)">${esc(u.email)}</div>
              </td>
              <td style="padding:10px 12px">
                <span style="background:var(--bg-primary);padding:2px 8px;border-radius:10px;font-size:11px">${esc(u.auth_provider)}</span>
              </td>
              <td style="padding:10px 12px">
                <span style="color:${isPlatformAdmin(u) ? 'var(--accent)' : 'var(--text-secondary)'}">${esc(u.role)}</span>
              </td>
              <td style="padding:10px 12px">
                <select class="input plan-select" data-user-id="${esc(u.id)}" style="padding:4px 8px;font-size:12px;width:auto">
                  ${plans.map(p => `<option value="${esc(p.id)}" ${u.plan_id === p.id ? 'selected' : ''}>${esc(p.display_name)}</option>`).join('')}
                </select>
              </td>
              <td style="padding:10px 12px;white-space:nowrap">
                ${u.auth_provider === 'local' && u.id !== currentUser.id ? `<button class="btn btn-secondary btn-sm reset-user-pw-btn" data-user-id="${esc(u.id)}" data-user-email="${esc(u.email)}" style="margin-right:4px">${t('settings.user.reset_password')}</button>` : ''}
                ${u.id !== currentUser.id ? `<button class="btn btn-danger btn-sm delete-user-btn" data-user-id="${esc(u.id)}">${t('settings.user.remove')}</button>` : `<span style="color:var(--text-muted);font-size:11px">${t('settings.user.you')}</span>`}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      </div>
      <p style="color:var(--text-muted);font-size:11px;margin-top:12px">${tn('settings.user.count', users.length)}</p>
    `;

    // Plan change handlers
    el.querySelectorAll('.plan-select').forEach(select => {
      select.addEventListener('change', async () => {
        const userId = select.dataset.userId;
        const planId = select.value;
        try {
          await api.assignPlan(userId, planId);
          showToast(t('settings.toast.plan_updated'), 'success');
        } catch (err) {
          showToast(err.message, 'error');
          loadUsers(); // Revert
        }
      });
    });

    // Reset password handlers
    el.querySelectorAll('.reset-user-pw-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const email = btn.dataset.userEmail;
        const pw = prompt(t('settings.user.prompt_reset_password', { email }));
        if (pw === null) return;
        if (pw.length < 8) { showToast(t('settings.toast.new_password_min_8'), 'error'); return; }
        try {
          await api.resetUserPassword(btn.dataset.userId, pw);
          showToast(t('settings.toast.password_reset_for_user'), 'success');
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    // Delete user handlers
    el.querySelectorAll('.delete-user-btn').forEach(btn => {
      let confirming = false;
      btn.addEventListener('click', async () => {
        if (confirming) {
          try {
            await api.deleteUser(btn.dataset.userId);
            showToast(t('settings.toast.user_removed'), 'success');
            loadUsers();
          } catch (err) {
            showToast(err.message, 'error');
          }
          return;
        }
        confirming = true;
        btn.textContent = t('settings.user.confirm');
        btn.style.background = 'var(--danger)';
        btn.style.color = 'white';
        setTimeout(() => {
          confirming = false;
          btn.textContent = t('settings.user.remove');
          btn.style.background = '';
          btn.style.color = '';
        }, 3000);
      });
    });

  } catch (err) {
    el.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`;
  }
}

export function cleanup() {}
