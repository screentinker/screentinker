import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { getLanguage, setLanguage, getAvailableLanguages } from '../i18n.js';
import { esc } from '../utils.js';

export async function render(container) {
  const serverUrl = `${window.location.protocol}//${window.location.host}`;
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  const isSuperAdmin = user.role === 'superadmin';
  const isAdmin = user.role === 'admin' || isSuperAdmin;

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Settings</h1>
        <div class="subtitle">Server configuration and setup information</div>
      </div>
    </div>

    ${isAdmin ? `
    <div class="settings-section">
      <h3>License</h3>
      <div id="licenseSection"><p style="color:var(--text-muted);font-size:13px">MIT License - all features included.</p></div>
    </div>

    ${isSuperAdmin ? '<p style="font-size:12px;color:var(--text-muted);margin-bottom:12px">Platform admin tools are in the <a href="#/admin" style="color:var(--accent)">Admin</a> page.</p>' : ''}

    <div class="settings-section">
      <h3>User Management</h3>
      <div id="userManagement"><p style="color:var(--text-muted)">Loading users...</p></div>
    </div>

    <div class="settings-section" id="whiteLabelSection">
      <h3>White Label / Branding</h3>
      <div id="whiteLabelForm">
        <p style="color:var(--text-muted);font-size:12px;margin-bottom:16px">Customize the look of your dashboard and player for your clients.</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group"><label>Brand Name</label><input type="text" id="wlBrandName" class="input" placeholder="ScreenTinker"></div>
          <div class="form-group"><label>Logo URL</label><input type="text" id="wlLogoUrl" class="input" placeholder="https://..."></div>
          <div class="form-group"><label>Primary Color</label><input type="color" id="wlPrimaryColor" value="#3B82F6" style="width:100%;height:36px;border:none;cursor:pointer;border-radius:var(--radius)"></div>
          <div class="form-group"><label>Background Color</label><input type="color" id="wlBgColor" value="#111827" style="width:100%;height:36px;border:none;cursor:pointer;border-radius:var(--radius)"></div>
          <div class="form-group"><label>Custom Domain</label><input type="text" id="wlDomain" class="input" placeholder="signage.yourcompany.com"></div>
          <div class="form-group"><label>Favicon URL</label><input type="text" id="wlFavicon" class="input" placeholder="https://..."></div>
        </div>
        <div class="form-group"><label>Custom CSS (optional)</label><textarea id="wlCustomCss" class="input" rows="3" style="font-family:monospace;font-size:12px" placeholder=":root { --accent: #ff6600; }"></textarea></div>
        <div class="form-group"><label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="wlHideBranding"> Hide "ScreenTinker" branding</label></div>
        <button class="btn btn-primary btn-sm" id="saveWhiteLabelBtn">Save Branding</button>
        <button class="btn btn-secondary btn-sm" id="previewWhiteLabelBtn" style="margin-left:8px">Preview</button>
      </div>
    </div>
    ` : ''}

    <div class="settings-section">
      <h3>Server Information</h3>
      <div class="info-grid">
        <div class="info-card">
          <div class="info-card-label">Server URL</div>
          <div class="info-card-value small">${serverUrl}</div>
          <p style="font-size:11px;color:var(--text-muted);margin-top:4px">Use this URL when setting up the Android app</p>
        </div>
        <div class="info-card">
          <div class="info-card-label">API Endpoint</div>
          <div class="info-card-value small">${serverUrl}/api</div>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3>Setup Guide</h3>
      <div style="color:var(--text-secondary);font-size:13px;line-height:1.8">
        <ol style="padding-left:20px;list-style:decimal">
          <li>Install the <strong>ScreenTinker</strong> APK on your Apolosign portable TV via sideloading</li>
          <li>Open the app and enter this server URL: <code style="background:var(--bg-input);padding:2px 6px;border-radius:4px">${serverUrl}</code></li>
          <li>The app will display a <strong>6-digit pairing code</strong></li>
          <li>Click <strong>"Add Display"</strong> on the dashboard and enter the pairing code</li>
          <li>Upload content in the <strong>Content Library</strong></li>
          <li>Assign content to the display's <strong>Playlist</strong></li>
        </ol>
      </div>
    </div>

    ${isAdmin ? `
    ` : ''}

    <div class="settings-section">
      <h3>Your Data</h3>
      <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">Export or import your devices, content, layouts, schedules, and all settings. Use this to migrate between cloud and self-hosted instances.</p>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-secondary btn-sm" id="exportDataBtn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          Export My Data
        </button>
        <label style="display:flex;align-items:center;gap:4px;font-size:12px;color:var(--text-secondary);cursor:pointer">
          <input type="checkbox" id="exportIncludeFiles"> Include media files (ZIP)
        </label>
        <button class="btn btn-secondary btn-sm" id="importDataBtn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          Import Data
        </button>
        <input type="file" id="importFileInput" accept=".json,.zip" style="display:none">
      </div>
      <div id="importStatus" style="display:none;margin-top:12px;padding:12px;border-radius:var(--radius);font-size:13px"></div>
    </div>

    <div class="settings-section">
      <h3>Language</h3>
      <select id="langSelect" class="input" style="width:200px;background:var(--bg-input)">
        ${getAvailableLanguages().map(l => `<option value="${l.code}" ${l.code === getLanguage() ? 'selected' : ''}>${l.name}</option>`).join('')}
      </select>
    </div>

    <div class="settings-section">
      <h3>About</h3>
      <div style="color:var(--text-secondary);font-size:13px">
        <p><strong>ScreenTinker</strong> v1.4.1</p>
        <p style="margin-top:4px">Digital signage management system.</p>
        <p style="margin-top:12px">
          <a href="/legal/terms.html" target="_blank" style="color:var(--accent);font-size:12px">Terms of Service</a>
          &nbsp;&middot;&nbsp;
          <a href="/legal/privacy.html" target="_blank" style="color:var(--accent);font-size:12px">Privacy Policy</a>
          &nbsp;&middot;&nbsp;
          <a href="/legal/third-party.html" target="_blank" style="color:var(--accent);font-size:12px">Third-Party Licenses</a>
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
          showToast(`Support token generated (valid ${hours}h)`, 'success');
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
    statusEl.textContent = 'Reading file...';
    try {
      let data;
      if (isZip) {
        // For ZIP, show basic info and skip preview parsing
        data = { format: 'screentinker-export-v1', _isZip: true };
        statusEl.innerHTML = `ZIP export detected: <strong>${esc(file.name)}</strong> (${(file.size / 1048576).toFixed(1)} MB)<br>Contains data + media files.<br><br><button class="btn btn-primary btn-sm" id="confirmImportBtn">Confirm Import</button> <button class="btn btn-secondary btn-sm" id="cancelImportBtn">Cancel</button>`;
      } else {
        const text = await file.text();
        data = JSON.parse(text);
        if (!data.format || !data.format.startsWith('screentinker-export')) {
          statusEl.style.color = 'var(--danger)';
          statusEl.textContent = 'Invalid file. Must be a ScreenTinker export JSON or ZIP.';
          return;
        }
        const summary = [
          data.devices?.length ? `${data.devices.length} devices` : null,
          data.content?.length ? `${data.content.length} content items` : null,
          data.widgets?.length ? `${data.widgets.length} widgets` : null,
          data.layouts?.length ? `${data.layouts.length} layouts` : null,
          data.schedules?.length ? `${data.schedules.length} schedules` : null,
          data.video_walls?.length ? `${data.video_walls.length} video walls` : null,
          data.kiosk_pages?.length ? `${data.kiosk_pages.length} kiosk pages` : null,
        ].filter(Boolean).join(', ');
        statusEl.innerHTML = `Found: ${esc(summary) || 'empty export'}.<br>From: ${esc(data.user?.email) || 'unknown'} (exported ${esc(data.exported_at?.split('T')[0]) || 'unknown'})<br><br><button class="btn btn-primary btn-sm" id="confirmImportBtn">Confirm Import</button> <button class="btn btn-secondary btn-sm" id="cancelImportBtn">Cancel</button>`;
      }
      document.getElementById('cancelImportBtn').onclick = () => { statusEl.style.display = 'none'; e.target.value = ''; };
      document.getElementById('confirmImportBtn').onclick = async () => {
        statusEl.innerHTML = isZip ? 'Uploading and importing... This may take a moment for large files.' : 'Importing...';
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
            let html = `Import complete: ${imported}.`;
            if (result.device_pairings?.length) {
              html += `<br><br><strong>Device Pairing Codes:</strong><br><table style="margin-top:8px;font-size:12px;border-collapse:collapse">` +
                result.device_pairings.map(d => `<tr><td style="padding:4px 12px 4px 0">${d.name}</td><td style="font-family:monospace;font-weight:700;font-size:14px;letter-spacing:2px">${d.pairing_code}</td></tr>`).join('') +
                `</table><br>Enter these codes on each device to re-link them. All assignments and schedules will be preserved.`;
            }
            html += `<br><br>${(result.notes || []).map(n => '&bull; ' + n).join('<br>')}`;
            statusEl.innerHTML = html;
            showToast('Data imported successfully', 'success');
          } else {
            statusEl.style.color = 'var(--danger)';
            statusEl.textContent = result.error || 'Import failed';
          }
        } catch (err) {
          statusEl.style.color = 'var(--danger)';
          statusEl.textContent = 'Import failed: ' + err.message;
        }
        e.target.value = '';
      };
    } catch (err) {
      statusEl.style.color = 'var(--danger)';
      statusEl.textContent = 'Failed to read file: ' + err.message;
    }
  });

  document.getElementById('langSelect')?.addEventListener('change', (e) => {
    setLanguage(e.target.value);
    showToast('Language changed. Refresh for full effect.', 'info');
  });
}

async function loadWhiteLabel() {
  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };

  // Only show white-label for enterprise/superadmin
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  const section = document.getElementById('whiteLabelSection');
  if (section && user.plan_id !== 'enterprise' && user.role !== 'superadmin') {
    section.innerHTML = `
      <h3>White Label / Branding</h3>
      <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:16px;text-align:center">
        <p style="color:var(--text-secondary);font-size:14px;margin-bottom:8px">Custom branding is available on the Enterprise plan</p>
        <a href="#/billing" class="btn btn-secondary btn-sm" style="text-decoration:none">View Plans</a>
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
      showToast('Branding saved', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('previewWhiteLabelBtn')?.addEventListener('click', () => {
    const primary = document.getElementById('wlPrimaryColor').value;
    const bg = document.getElementById('wlBgColor').value;
    document.documentElement.style.setProperty('--accent', primary);
    document.documentElement.style.setProperty('--bg-primary', bg);
    showToast('Preview applied (refresh to reset)', 'info');
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
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="border-bottom:1px solid var(--border);text-align:left">
            <th style="padding:8px 12px;color:var(--text-muted);font-weight:500">User</th>
            <th style="padding:8px 12px;color:var(--text-muted);font-weight:500">Auth</th>
            <th style="padding:8px 12px;color:var(--text-muted);font-weight:500">Role</th>
            <th style="padding:8px 12px;color:var(--text-muted);font-weight:500">Plan</th>
            <th style="padding:8px 12px;color:var(--text-muted);font-weight:500">Actions</th>
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
                <span style="color:${u.role === 'admin' ? 'var(--accent)' : 'var(--text-secondary)'}">${u.role}</span>
              </td>
              <td style="padding:10px 12px">
                <select class="input plan-select" data-user-id="${u.id}" style="padding:4px 8px;font-size:12px;width:auto">
                  ${plans.map(p => `<option value="${p.id}" ${u.plan_id === p.id ? 'selected' : ''}>${p.display_name}</option>`).join('')}
                </select>
              </td>
              <td style="padding:10px 12px">
                ${u.id !== currentUser.id ? `<button class="btn btn-danger btn-sm delete-user-btn" data-user-id="${u.id}">Remove</button>` : '<span style="color:var(--text-muted);font-size:11px">You</span>'}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <p style="color:var(--text-muted);font-size:11px;margin-top:12px">${users.length} user(s) registered</p>
    `;

    // Plan change handlers
    el.querySelectorAll('.plan-select').forEach(select => {
      select.addEventListener('change', async () => {
        const userId = select.dataset.userId;
        const planId = select.value;
        try {
          await api.assignPlan(userId, planId);
          showToast('Plan updated', 'success');
        } catch (err) {
          showToast(err.message, 'error');
          loadUsers(); // Revert
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
            showToast('User removed', 'success');
            loadUsers();
          } catch (err) {
            showToast(err.message, 'error');
          }
          return;
        }
        confirming = true;
        btn.textContent = 'Confirm?';
        btn.style.background = 'var(--danger)';
        btn.style.color = 'white';
        setTimeout(() => {
          confirming = false;
          btn.textContent = 'Remove';
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
