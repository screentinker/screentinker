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

  // #83: the "About" version was hardcoded (showed v1.4.1 regardless of the build).
  // Read it from the server (/api/version) the same way the admin view does.
  let appVersion = '';
  try { appVersion = ((await fetch('/api/version').then(r => r.json())).version) || ''; } catch { /* leave blank on failure */ }

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>${t('settings.title')}</h1>
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
    </div>

    <div class="settings-section">
      <h3>${t('apitoken.title')}</h3>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:16px">${t('apitoken.desc')}</p>
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
          </select>
        </div>
        <button class="btn btn-primary btn-sm" id="createTokenBtn">${t('apitoken.create')}</button>
      </div>
      <div id="tokenSecretBox" style="display:none"></div>
      <div id="tokenList"><p style="color:var(--text-muted);font-size:13px">${t('settings.loading_users')}</p></div>
    </div>

    ${isAdmin ? `
    <div class="settings-section">
      <h3>${t('settings.license')}</h3>
      <div id="licenseSection"><p style="color:var(--text-muted);font-size:13px">${t('settings.license_mit')}</p></div>
    </div>

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
                result.device_pairings.map(d => `<tr><td style="padding:4px 12px 4px 0">${d.name}</td><td style="font-family:monospace;font-weight:700;font-size:14px;letter-spacing:2px">${d.pairing_code}</td></tr>`).join('') +
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
              <td style="padding:10px 12px">${esc(scopeLabel(tok.scope))}</td>
              <td style="padding:10px 12px">${esc(fmtTokenDate(tok.created_at))}</td>
              <td style="padding:10px 12px">${tok.last_used_at ? esc(fmtTokenDate(tok.last_used_at)) : t('apitoken.never')}</td>
              <td style="padding:10px 12px;white-space:nowrap;text-align:right">
                ${tok.revoked_at
                  ? `<span style="color:var(--text-muted);font-size:12px">${t('apitoken.revoked')}</span>`
                  : `<button class="btn btn-secondary btn-sm revoke-token-btn" data-id="${esc(String(tok.id))}">${t('apitoken.revoke')}</button>`}
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
  }

  loadTokens();

  document.getElementById('createTokenBtn')?.addEventListener('click', async () => {
    const name = document.getElementById('tokName').value.trim();
    const scope = document.getElementById('tokScope').value;
    const btn = document.getElementById('createTokenBtn');
    btn.disabled = true;
    try {
      const r = await api.createToken({ name, scope });
      const box = document.getElementById('tokenSecretBox');
      box.style.display = 'block';
      box.innerHTML = `
        <div style="background:var(--bg-secondary);border:1px solid var(--accent);border-radius:var(--radius);padding:16px;margin-bottom:16px">
          <h4 style="font-size:14px;margin-bottom:8px">${t('apitoken.secret_title')}</h4>
          <p style="color:var(--danger);font-size:12px;margin-bottom:12px"><strong>${t('apitoken.secret_warning')}</strong></p>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="text" class="input" readonly value="${esc(r.token)}" style="font-family:monospace;flex:1" onclick="this.select()">
            <button class="btn btn-secondary btn-sm" id="copyTokenBtn">${t('apitoken.copy')}</button>
          </div>
        </div>
      `;
      document.getElementById('copyTokenBtn')?.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(r.token);
          showToast(t('apitoken.copied'), 'success');
        } catch { /* clipboard may be unavailable; the field is selectable */ }
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
            <tr style="border-bottom:1px solid var(--border)" data-user-id="${u.id}">
              <td style="padding:10px 12px">
                <div style="font-weight:500">${u.name || u.email}</div>
                <div style="font-size:11px;color:var(--text-muted)">${u.email}</div>
              </td>
              <td style="padding:10px 12px">
                <span style="background:var(--bg-primary);padding:2px 8px;border-radius:10px;font-size:11px">${u.auth_provider}</span>
              </td>
              <td style="padding:10px 12px">
                <span style="color:${isPlatformAdmin(u) ? 'var(--accent)' : 'var(--text-secondary)'}">${u.role}</span>
              </td>
              <td style="padding:10px 12px">
                <select class="input plan-select" data-user-id="${u.id}" style="padding:4px 8px;font-size:12px;width:auto">
                  ${plans.map(p => `<option value="${p.id}" ${u.plan_id === p.id ? 'selected' : ''}>${p.display_name}</option>`).join('')}
                </select>
              </td>
              <td style="padding:10px 12px;white-space:nowrap">
                ${u.auth_provider === 'local' && u.id !== currentUser.id ? `<button class="btn btn-secondary btn-sm reset-user-pw-btn" data-user-id="${u.id}" data-user-email="${u.email}" style="margin-right:4px">${t('settings.user.reset_password')}</button>` : ''}
                ${u.id !== currentUser.id ? `<button class="btn btn-danger btn-sm delete-user-btn" data-user-id="${u.id}">${t('settings.user.remove')}</button>` : `<span style="color:var(--text-muted);font-size:11px">${t('settings.user.you')}</span>`}
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
