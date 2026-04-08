import { api } from '../api.js';
import { on, off, requestScreenshot } from '../socket.js';
import { showToast } from '../components/toast.js';

let statusHandler = null;
let screenshotHandler = null;
let refreshInterval = null;

function formatTimeAgo(timestamp) {
  if (!timestamp) return 'Never';
  const seconds = Math.floor(Date.now() / 1000 - timestamp);
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatBytes(mb) {
  if (mb === null || mb === undefined) return '--';
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

function renderDeviceCard(device) {
  const token = localStorage.getItem('token');
  const screenshotUrl = device.screenshot_path
    ? `/api/devices/${device.id}/screenshot?t=${device.screenshot_at || ''}&token=${token}`
    : null;

  return `
    <div class="device-card" data-device-id="${device.id}" onclick="window.location.hash='/device/${device.id}'">
      <div class="device-card-preview" id="preview-${device.id}">
        ${screenshotUrl
          ? `<img src="${screenshotUrl}" alt="Screenshot" loading="lazy">`
          : `<div class="no-preview">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                <line x1="8" y1="21" x2="16" y2="21"/>
                <line x1="12" y1="17" x2="12" y2="21"/>
              </svg>
              <span>No preview available</span>
            </div>`
        }
        <div class="device-card-status">
          <span class="status-dot ${device.status}"></span>
          <span>${device.status === 'provisioning' ? 'Awaiting Pairing' : device.status}</span>
        </div>
        ${device.status === 'provisioning' && device.pairing_code ? `
        <div style="position:absolute;bottom:8px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.85);color:#f59e0b;padding:4px 12px;border-radius:6px;font-size:13px;font-weight:600;letter-spacing:2px;font-family:monospace">
          ${device.pairing_code}
        </div>` : ''}
      </div>
      <div class="device-card-body">
        <div class="device-card-name">${device.name}</div>
        ${device.owner_name || device.owner_email ? `<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
          </svg>
          ${device.owner_name || device.owner_email}
        </div>` : ''}
        <div class="device-card-meta">
          <div class="meta-item">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            ${formatTimeAgo(device.last_heartbeat)}
          </div>
          ${device.battery_level !== null && device.battery_level !== undefined ? `
          <div class="meta-item">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="1" y="6" width="18" height="12" rx="2" ry="2"/><line x1="23" y1="13" x2="23" y2="11"/>
            </svg>
            ${device.battery_level}%
          </div>` : ''}
          ${device.wifi_rssi ? `
          <div class="meta-item">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/>
              <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>
            </svg>
            ${device.wifi_rssi} dBm
          </div>` : ''}
          ${device.storage_free_mb ? `
          <div class="meta-item">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
            </svg>
            ${formatBytes(device.storage_free_mb)} free
          </div>` : ''}
        </div>
      </div>
    </div>
  `;
}

export function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Displays <span class="help-tip" data-tip="Your paired display devices. Green = online, red = offline. Click a device to manage its playlist, view telemetry, or use remote control.">?</span></h1>
        <div class="subtitle">Manage your remote displays</div>
      </div>
      <button class="btn btn-primary" id="addDeviceBtn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        Add Display
      </button>
    </div>
    <div id="dashStats" style="display:flex;gap:12px;margin-bottom:16px"></div>
    <div style="display:flex;gap:12px;margin-bottom:16px;align-items:center">
      <input type="text" id="deviceSearch" class="input" placeholder="Search displays..." style="max-width:300px">
      <select id="deviceFilter" class="input" style="width:140px;background:var(--bg-input)">
        <option value="">All Status</option>
        <option value="online">Online</option>
        <option value="offline">Offline</option>
      </select>
    </div>
    <div class="device-grid" id="deviceGrid">
      <div class="empty-state">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
          <line x1="8" y1="21" x2="16" y2="21"/>
          <line x1="12" y1="17" x2="12" y2="21"/>
        </svg>
        <h3>Loading displays...</h3>
      </div>
    </div>
  `;

  const addBtn = container.querySelector('#addDeviceBtn');
  addBtn.addEventListener('click', () => {
    document.getElementById('addDeviceModal').style.display = 'flex';
    document.getElementById('pairingCodeInput').value = '';
    document.getElementById('deviceNameInput').value = '';
    document.getElementById('pairingCodeInput').focus();
  });

  // Search and filter
  document.getElementById('deviceSearch').oninput = () => filterDevices();
  document.getElementById('deviceFilter').onchange = () => filterDevices();

  function filterDevices() {
    const search = document.getElementById('deviceSearch').value.toLowerCase();
    const status = document.getElementById('deviceFilter').value;
    document.querySelectorAll('.device-card').forEach(card => {
      const name = card.querySelector('.device-card-name')?.textContent.toLowerCase() || '';
      const deviceStatus = card.querySelector('.device-card-status span:last-child')?.textContent || '';
      const matchSearch = !search || name.includes(search);
      const matchStatus = !status || deviceStatus === status;
      card.style.display = (matchSearch && matchStatus) ? '' : 'none';
    });
  }

  // Setup pairing
  const pairBtn = document.getElementById('pairDeviceBtn');
  pairBtn.onclick = async () => {
    const code = document.getElementById('pairingCodeInput').value.trim();
    const name = document.getElementById('deviceNameInput').value.trim();
    if (!code || code.length !== 6) {
      showToast('Enter a valid 6-digit pairing code', 'error');
      return;
    }
    try {
      await api.pairDevice(code, name || undefined);
      document.getElementById('addDeviceModal').style.display = 'none';
      showToast('Display paired successfully!', 'success');
      loadDevices();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // Load devices
  loadDevices();

  // Real-time updates
  statusHandler = (data) => {
    const card = document.querySelector(`[data-device-id="${data.device_id}"]`);
    if (card) {
      const statusEl = card.querySelector('.device-card-status');
      statusEl.innerHTML = `<span class="status-dot ${data.status}"></span><span>${data.status}</span>`;
    }
  };

  screenshotHandler = (data) => {
    const preview = document.getElementById(`preview-${data.device_id}`);
    if (preview) {
      const imgSrc = data.image_data || (data.url + '&token=' + localStorage.getItem('token'));
      const img = preview.querySelector('img');
      if (img) {
        img.src = imgSrc;
      } else {
        preview.innerHTML = `<img src="${imgSrc}" alt="Screenshot" loading="lazy">` +
          preview.querySelector('.device-card-status').outerHTML;
      }
    }
  };

  // Device added/removed - refresh the whole list
  const deviceAddedHandler = () => loadDevices();
  const deviceRemovedHandler = () => loadDevices();

  on('device-status', statusHandler);
  on('screenshot-ready', screenshotHandler);
  on('device-added', deviceAddedHandler);
  on('device-removed', deviceRemovedHandler);

  // Request fresh screenshots on load
  setTimeout(() => {
    document.querySelectorAll('.device-card').forEach(card => {
      requestScreenshot(card.dataset.deviceId);
    });
  }, 2000);

  // Refresh screenshots periodically
  refreshInterval = setInterval(() => {
    document.querySelectorAll('.device-card').forEach(card => {
      requestScreenshot(card.dataset.deviceId);
    });
  }, 30000);
}

async function loadDevices() {
  const grid = document.getElementById('deviceGrid');
  if (!grid) return;

  try {
    const devices = await api.getDevices();

    // Stats cards
    const online = devices.filter(d => d.status === 'online').length;
    const offline = devices.filter(d => d.status === 'offline').length;
    const provisioning = devices.filter(d => d.status === 'provisioning').length;
    const statsEl = document.getElementById('dashStats');
    if (statsEl) {
      statsEl.innerHTML = `
        <div class="info-card" style="flex:1;min-width:120px">
          <div class="info-card-label">Total Displays</div>
          <div class="info-card-value">${devices.length}</div>
        </div>
        <div class="info-card" style="flex:1;min-width:120px">
          <div class="info-card-label">Online</div>
          <div class="info-card-value" style="color:var(--success)">${online}</div>
        </div>
        <div class="info-card" style="flex:1;min-width:120px">
          <div class="info-card-label">Offline</div>
          <div class="info-card-value" style="color:${offline > 0 ? 'var(--danger)' : 'var(--text-muted)'}">${offline}</div>
        </div>
        ${provisioning > 0 ? `
        <div class="info-card" style="flex:1;min-width:120px">
          <div class="info-card-label">Awaiting Pairing</div>
          <div class="info-card-value" style="color:var(--warning,#f59e0b)">${provisioning}</div>
        </div>` : ''}
      `;
    }

    if (devices.length === 0) {
      grid.innerHTML = `
        <div class="empty-state" style="grid-column: 1/-1">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
          <h3>No displays yet</h3>
          <p>Install the ScreenTinker app on your Apolosign TV and pair it using the button above.</p>
        </div>
      `;
    } else {
      grid.innerHTML = devices.map(renderDeviceCard).join('');
    }
  } catch (err) {
    grid.innerHTML = `<div class="empty-state" style="grid-column: 1/-1"><h3>Failed to load displays</h3><p>${err.message}</p></div>`;
  }
}

export function cleanup() {
  if (statusHandler) off('device-status', statusHandler);
  if (screenshotHandler) off('screenshot-ready', screenshotHandler);
  off('device-added', () => {});
  off('device-removed', () => {});
  if (refreshInterval) clearInterval(refreshInterval);
  statusHandler = null;
  screenshotHandler = null;
  refreshInterval = null;
}
