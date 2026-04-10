import { api } from '../api.js';
import { on, off, requestScreenshot } from '../socket.js';
import { showToast } from '../components/toast.js';

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

const DESTRUCTIVE_COMMANDS = ['reboot', 'shutdown'];
const GROUP_COMMANDS = [
  { type: 'screen_on', label: 'Screen On' },
  { type: 'screen_off', label: 'Screen Off' },
  { type: 'launch', label: 'Restart App' },
  { type: 'update', label: 'Check Update' },
  { type: 'reboot', label: 'Reboot', destructive: true },
  { type: 'shutdown', label: 'Shutdown', destructive: true },
];

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
        <div class="device-card-name">${esc(device.name)}</div>
        ${device.owner_name || device.owner_email ? `<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
          </svg>
          ${esc(device.owner_name || device.owner_email)}
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

function renderGroupSection(group, devices) {
  const onlineCount = devices.filter(d => d.status === 'online').length;
  return `
    <div class="group-section" data-group-id="${group.id}" style="margin-bottom:24px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;padding:8px 12px;background:var(--bg-secondary);border-radius:8px;border-left:4px solid ${esc(group.color || '#3B82F6')}">
        <div style="display:flex;align-items:center;gap:10px">
          <strong style="font-size:15px">${esc(group.name)}</strong>
          <span style="color:var(--text-muted);font-size:12px">${devices.length} device${devices.length !== 1 ? 's' : ''} &middot; ${onlineCount} online</span>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          ${devices.length > 0 ? `
          <select class="input group-cmd-select" data-group-id="${group.id}" data-group-name="${esc(group.name)}" data-device-count="${devices.length}" style="width:150px;padding:4px 8px;font-size:12px;background:var(--bg-input)">
            <option value="">Send Command...</option>
            ${GROUP_COMMANDS.map(c => `<option value="${c.type}" ${c.destructive ? 'style="color:var(--danger)"' : ''}>${c.label}</option>`).join('')}
          </select>
          ` : ''}
          <button class="btn" data-group-manage="${group.id}" style="padding:4px 10px;font-size:12px" title="Add/remove devices">Manage</button>
          <button class="btn" data-group-delete="${group.id}" style="padding:4px 8px;font-size:12px;color:var(--danger)" title="Delete group">&#x2715;</button>
        </div>
      </div>
      <div class="device-grid">
        ${devices.length > 0 ? devices.map(renderDeviceCard).join('') : '<div style="color:var(--text-muted);font-size:13px;padding:8px 12px">No devices in this group. Click Manage to add some.</div>'}
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
      <div style="display:flex;gap:8px">
        <button class="btn" id="createGroupBtn">+ Group</button>
        <button class="btn btn-primary" id="addDeviceBtn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          Add Display
        </button>
      </div>
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
    <div id="groupedDevices"></div>
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
      loadDashboard();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // Create group
  container.querySelector('#createGroupBtn').addEventListener('click', async () => {
    const name = prompt('Group name:');
    if (!name) return;
    try {
      await api.createGroup(name);
      showToast('Group created', 'success');
      loadDashboard();
    } catch (e) { showToast(e.message, 'error'); }
  });

  // Load everything
  loadDashboard();

  // Real-time updates
  statusHandler = (data) => {
    const cards = document.querySelectorAll(`[data-device-id="${data.device_id}"]`);
    cards.forEach(card => {
      const statusEl = card.querySelector('.device-card-status');
      if (statusEl) statusEl.innerHTML = `<span class="status-dot ${data.status}"></span><span>${data.status}</span>`;
    });
  };

  screenshotHandler = (data) => {
    // Update all instances of this device's preview (may appear in multiple groups)
    document.querySelectorAll(`#preview-${data.device_id}`).forEach(preview => {
      const imgSrc = data.image_data || (data.url + '&token=' + localStorage.getItem('token'));
      const img = preview.querySelector('img');
      if (img) {
        img.src = imgSrc;
      } else {
        const statusHtml = preview.querySelector('.device-card-status')?.outerHTML || '';
        preview.innerHTML = `<img src="${imgSrc}" alt="Screenshot" loading="lazy">${statusHtml}`;
      }
    });
  };

  const deviceAddedHandler = () => loadDashboard();
  const deviceRemovedHandler = () => loadDashboard();

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

  refreshInterval = setInterval(() => {
    document.querySelectorAll('.device-card').forEach(card => {
      requestScreenshot(card.dataset.deviceId);
    });
  }, 30000);
}

async function loadDashboard() {
  const main = document.getElementById('groupedDevices');
  if (!main) return;

  try {
    const [devices, groups] = await Promise.all([api.getDevices(), api.getGroups()]);

    // Stats
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

    if (devices.length === 0 && groups.length === 0) {
      main.innerHTML = `
        <div class="empty-state">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
          <h3>No displays yet</h3>
          <p>Install the ScreenTinker app on your Apolosign TV and pair it using the button above.</p>
        </div>
      `;
      return;
    }

    // Fetch group memberships
    const groupsWithDevices = await Promise.all(groups.map(async g => {
      const members = await api.getGroupDevices(g.id);
      const memberIds = new Set(members.map(m => m.id));
      // Use full device data from the main devices list (has telemetry/screenshots)
      const fullDevices = devices.filter(d => memberIds.has(d.id));
      return { ...g, devices: fullDevices, memberIds };
    }));

    // Find ungrouped devices
    const allGroupedIds = new Set();
    groupsWithDevices.forEach(g => g.memberIds.forEach(id => allGroupedIds.add(id)));
    const ungrouped = devices.filter(d => !allGroupedIds.has(d.id));

    let html = '';

    // Render each group with its devices
    for (const g of groupsWithDevices) {
      html += renderGroupSection(g, g.devices);
    }

    // Render ungrouped devices
    if (ungrouped.length > 0) {
      html += `
        <div style="margin-bottom:24px">
          ${groups.length > 0 ? `
          <div style="display:flex;align-items:center;margin-bottom:10px;padding:8px 12px;background:var(--bg-secondary);border-radius:8px;border-left:4px solid var(--text-muted)">
            <strong style="font-size:15px;color:var(--text-muted)">Ungrouped</strong>
            <span style="color:var(--text-muted);font-size:12px;margin-left:10px">${ungrouped.length} device${ungrouped.length !== 1 ? 's' : ''}</span>
          </div>` : ''}
          <div class="device-grid">
            ${ungrouped.map(renderDeviceCard).join('')}
          </div>
        </div>
      `;
    }

    main.innerHTML = html;
    attachGroupHandlers(groupsWithDevices, devices);

  } catch (err) {
    main.innerHTML = `<div class="empty-state"><h3>Failed to load displays</h3><p>${err.message}</p></div>`;
  }
}

function attachGroupHandlers(groupsWithDevices, allDevices) {
  // Command select handlers
  document.querySelectorAll('.group-cmd-select').forEach(select => {
    select.addEventListener('change', async (e) => {
      const type = e.target.value;
      if (!type) return;
      const groupId = e.target.dataset.groupId;
      const groupName = e.target.dataset.groupName;
      const count = e.target.dataset.deviceCount;

      if (DESTRUCTIVE_COMMANDS.includes(type)) {
        if (!confirm(`${type.toUpperCase()} all ${count} device${count !== '1' ? 's' : ''} in "${groupName}"?\n\nThis cannot be undone.`)) {
          e.target.value = '';
          return;
        }
      }

      try {
        const result = await api.sendGroupCommand(groupId, type);
        showToast(`${type} sent to ${result.sent}/${result.total} devices${result.offline > 0 ? ` (${result.offline} offline)` : ''}`, result.offline > 0 ? 'warning' : 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
      e.target.value = '';
    });
  });

  // Delete group
  document.querySelectorAll('[data-group-delete]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.groupDelete;
      if (!confirm('Delete this group? Devices will not be affected.')) return;
      try {
        await api.deleteGroup(id);
        showToast('Group deleted', 'success');
        loadDashboard();
      } catch (e) { showToast(e.message, 'error'); }
    });
  });

  // Manage group (add/remove devices)
  document.querySelectorAll('[data-group-manage]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const groupId = btn.dataset.groupManage;
      const group = groupsWithDevices.find(g => g.id === groupId);
      const memberIds = new Set(group.devices.map(d => d.id));

      // Get all groups for multi-group warning
      const otherGroups = groupsWithDevices.filter(g => g.id !== groupId);

      const modal = document.createElement('div');
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1000';
      modal.innerHTML = `
        <div style="background:var(--bg-card);border-radius:12px;padding:24px;max-width:400px;width:90%;max-height:70vh;overflow-y:auto">
          <h3 style="margin:0 0 4px">${esc(group.name)}</h3>
          <p style="margin:0 0 16px;font-size:12px;color:var(--text-muted)">Check devices to add them to this group</p>
          <div style="display:flex;flex-direction:column;gap:6px">
            ${allDevices.filter(d => d.status !== 'provisioning').map(d => {
              const inOther = otherGroups.filter(g => g.memberIds.has(d.id)).map(g => g.name);
              return `
                <label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;background:var(--bg-secondary)">
                  <input type="checkbox" data-device-id="${d.id}" data-in-groups="${inOther.join(',')}" ${memberIds.has(d.id) ? 'checked' : ''}>
                  <span class="status-dot ${d.status}" style="width:8px;height:8px"></span>
                  <span style="font-size:13px;flex:1">${esc(d.name)}</span>
                  ${inOther.length > 0 ? `<span style="font-size:10px;color:var(--text-muted);background:var(--bg-primary);padding:1px 6px;border-radius:8px">${esc(inOther.join(', '))}</span>` : ''}
                </label>
              `;
            }).join('')}
          </div>
          <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
            <button class="btn" id="manageGroupClose">Done</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      modal.querySelector('#manageGroupClose').onclick = () => { modal.remove(); loadDashboard(); };
      modal.addEventListener('click', (ev) => { if (ev.target === modal) { modal.remove(); loadDashboard(); } });

      modal.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', async () => {
          const deviceId = cb.dataset.deviceId;
          const existingGroups = cb.dataset.inGroups;
          try {
            if (cb.checked && existingGroups) {
              if (!confirm(`This device is already in: ${existingGroups}\n\nAdd it to "${group.name}" too?`)) {
                cb.checked = false;
                return;
              }
            }
            if (cb.checked) {
              await api.addDeviceToGroup(groupId, deviceId);
            } else {
              await api.removeDeviceFromGroup(groupId, deviceId);
            }
          } catch (err) {
            showToast(err.message, 'error');
            cb.checked = !cb.checked;
          }
        });
      });
    });
  });
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
