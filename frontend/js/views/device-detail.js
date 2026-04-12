import { api } from '../api.js';
import { on, off, requestScreenshot, startRemote, stopRemote, sendTouch, sendKey, sendCommand } from '../socket.js';
import { showToast } from '../components/toast.js';
import { esc } from '../utils.js';

let currentDevice = null;
let statusHandler = null;
let screenshotHandler = null;
let playbackHandler = null;
let screenshotInterval = null;
let remoteActive = false;

function formatBytes(mb) {
  if (mb === null || mb === undefined) return '--';
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

function formatUptime(seconds) {
  if (!seconds) return '--';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function render(container, deviceId) {
  container.innerHTML = `
    <div class="device-detail">
      <a href="#/" class="back-link">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
        </svg>
        Back to Displays
      </a>
      <div id="deviceContent">
        <div class="empty-state"><h3>Loading...</h3></div>
      </div>
    </div>
  `;

  loadDevice(deviceId);

  // Real-time updates
  statusHandler = (data) => {
    if (data.device_id !== deviceId) return;
    const badge = document.querySelector('.device-status-badge');
    if (badge) {
      badge.className = `device-status-badge ${data.status}`;
      badge.textContent = data.status;
    }
    if (data.telemetry) updateTelemetryDisplay(data.telemetry);
  };

  screenshotHandler = (data) => {
    if (data.device_id !== deviceId) return;
    // Use inline base64 data if available, otherwise fall back to URL
    const imgSrc = data.image_data || (() => {
      const token = localStorage.getItem('token');
      return data.url + (data.url.includes('?') ? '&' : '?') + 'token=' + token;
    })();
    // Update screenshot in Now Playing tab
    const screenshotEl = document.getElementById('currentScreenshot');
    if (screenshotEl) {
      if (screenshotEl.tagName === 'IMG') {
        screenshotEl.src = imgSrc;
      } else {
        // Replace placeholder div with actual image
        const img = document.createElement('img');
        img.id = 'currentScreenshot';
        img.src = imgSrc;
        img.alt = 'Current screen';
        img.style.cssText = 'width:100%;height:100%;object-fit:contain';
        screenshotEl.replaceWith(img);
      }
    }
    // Update remote canvas
    const canvas = document.getElementById('remoteCanvas');
    if (canvas && remoteActive) {
      const ctx = canvas.getContext('2d');
      const img = new Image();
      img.onload = () => {
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);
      };
      img.src = imgSrc;
    }
  };

  playbackHandler = (data) => {
    if (data.device_id !== deviceId) return;
    const el = document.getElementById('nowPlayingInfo');
    if (el && data.current_content_id) {
      el.textContent = `Playing: ${data.current_content_id}`;
    }
  };

  on('device-status', statusHandler);
  on('screenshot-ready', screenshotHandler);
  on('playback-state', playbackHandler);
}

async function loadDevice(deviceId, activeTab = null) {
  const contentEl = document.getElementById('deviceContent');
  try {
    const device = await api.getDevice(deviceId);
    currentDevice = device;
    const latestTelemetry = device.telemetry?.[0] || {};

    contentEl.innerHTML = `
      <div class="device-header">
        <div class="device-header-left">
          <h1 id="deviceName">${device.name}</h1>
          <span class="device-status-badge ${device.status}">${device.status}</span>
          ${device.owner_name || device.owner_email ? `<span style="font-size:12px;color:var(--text-muted)">Owner: ${device.owner_name || device.owner_email}</span>` : ''}
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary btn-sm" id="renameBtn">Rename</button>
          <button class="btn btn-secondary btn-sm" id="screenshotBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
              <polyline points="21 15 16 10 5 21"/>
            </svg>
            Screenshot
          </button>
          <button class="btn btn-danger btn-sm" id="deleteDeviceBtn">Remove</button>
        </div>
      </div>

      <div class="tabs">
        <div class="tab active" data-tab="nowplaying">Now Playing <span class="help-tip" data-tip="Live screenshot of what's currently displaying on this device.">?</span></div>
        <div class="tab" data-tab="playlist">Playlist <span class="help-tip" data-tip="Content assigned to this device. Drag items to reorder. Add media, widgets, or kiosk pages.">?</span></div>
        <div class="tab" data-tab="info">Device Info <span class="help-tip" data-tip="Hardware telemetry, orientation settings, notes, and device controls.">?</span></div>
        <div class="tab" data-tab="remote">Remote Control <span class="help-tip" data-tip="View the device screen in real-time and send key presses. Works on Android APK and web player.">?</span></div>
      </div>

      <!-- Now Playing Tab -->
      <div class="tab-content active" id="tab-nowplaying">
        <div class="screenshot-container">
          ${device.screenshot
            ? `<img id="currentScreenshot" src="/api/devices/${device.id}/screenshot?t=${Date.now()}&token=${localStorage.getItem('token')}" alt="Current screen">`
            : `<div class="no-screenshot" id="currentScreenshot">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                  <line x1="8" y1="21" x2="16" y2="21"/>
                  <line x1="12" y1="17" x2="12" y2="21"/>
                </svg>
                <span>No screenshot available. Click "Screenshot" to capture one.</span>
              </div>`
          }
        </div>
        <p id="nowPlayingInfo" style="color:var(--text-secondary);font-size:13px;">
          ${device.assignments?.length ? `${device.assignments.length} item(s) in playlist` : 'No content assigned'}
        </p>
      </div>

      <!-- Playlist Tab -->
      <div class="tab-content" id="tab-playlist">
        <!-- Layout selector -->
        <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px;margin-bottom:16px;display:flex;align-items:center;gap:12px">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>
          </svg>
          <div style="flex:1">
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">Screen Layout</div>
            <select id="deviceLayoutSelect" class="input" style="background:var(--bg-input);padding:4px 8px;font-size:13px">
              <option value="">Fullscreen (default)</option>
            </select>
          </div>
          <button class="btn btn-secondary btn-sm" id="applyLayoutBtn">Apply</button>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <div style="display:flex;align-items:center;gap:12px">
            <h3 style="font-size:16px">Playlist</h3>
            <select class="input" id="playlistPicker" style="font-size:12px;padding:4px 8px;width:200px">
              <option value="">No playlist</option>
            </select>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-secondary btn-sm" id="copyPlaylistBtn">Copy To...</button>
            <button class="btn btn-primary btn-sm" id="addContentBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Add Content
          </button>
          </div>
        </div>
        <div class="playlist-container" id="playlistContainer">
          ${renderPlaylist(device.assignments || [])}
        </div>
      </div>

      <!-- Info Tab -->
      <div class="tab-content" id="tab-info">
        <div class="info-grid">
          <div class="info-card">
            <div class="info-card-label">Status</div>
            <div class="info-card-value" style="color:var(--${device.status === 'online' ? 'success' : 'danger'})">${device.status}</div>
          </div>
          <div class="info-card">
            <div class="info-card-label">IP Address</div>
            <div class="info-card-value small">${device.ip_address || '--'}</div>
          </div>
          ${device.android_version && !device.android_version.startsWith('Web/') ? `
          <div class="info-card">
            <div class="info-card-label">Battery</div>
            <div class="info-card-value" id="telBattery">${latestTelemetry.battery_level != null ? latestTelemetry.battery_level + '%' : '--'}</div>
            ${latestTelemetry.battery_level != null ? `
            <div class="progress-bar">
              <div class="progress-bar-fill ${latestTelemetry.battery_level > 50 ? 'success' : latestTelemetry.battery_level > 20 ? 'warning' : 'danger'}"
                   style="width:${latestTelemetry.battery_level}%"></div>
            </div>` : ''}
          </div>
          <div class="info-card">
            <div class="info-card-label">Storage</div>
            <div class="info-card-value small" id="telStorage">${latestTelemetry.storage_free_mb ? formatBytes(latestTelemetry.storage_free_mb) + ' free' : '--'}</div>
            ${latestTelemetry.storage_total_mb ? `
            <div class="progress-bar">
              <div class="progress-bar-fill ${((latestTelemetry.storage_total_mb - latestTelemetry.storage_free_mb) / latestTelemetry.storage_total_mb) < 0.8 ? 'success' : 'warning'}"
                   style="width:${((latestTelemetry.storage_total_mb - latestTelemetry.storage_free_mb) / latestTelemetry.storage_total_mb * 100)}%"></div>
            </div>` : ''}
          </div>
          ` : `
          <div class="info-card">
            <div class="info-card-label">Player Type</div>
            <div class="info-card-value small">Web Player</div>
          </div>
          `}
          ${device.android_version && !device.android_version.startsWith('Web/') ? `
          <div class="info-card">
            <div class="info-card-label">WiFi</div>
            <div class="info-card-value small" id="telWifi">${latestTelemetry.wifi_ssid || '--'}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px" id="telRssi">${latestTelemetry.wifi_rssi ? latestTelemetry.wifi_rssi + ' dBm' : ''}</div>
          </div>
          ` : ''}
          <div class="info-card">
            <div class="info-card-label">Uptime</div>
            <div class="info-card-value small" id="telUptime">${formatUptime(latestTelemetry.uptime_seconds)}</div>
          </div>
          ${device.android_version && !device.android_version.startsWith('Web/') ? `
          <div class="info-card">
            <div class="info-card-label">Android Version</div>
            <div class="info-card-value small">${device.android_version}</div>
          </div>
          <div class="info-card">
            <div class="info-card-label">App Version</div>
            <div class="info-card-value small">${device.app_version || '--'}</div>
          </div>
          ` : ''}
          <div class="info-card">
            <div class="info-card-label">Screen Resolution</div>
            <div class="info-card-value small">${device.screen_width && device.screen_height ? device.screen_width + 'x' + device.screen_height : '--'}</div>
          </div>
          ${device.android_version && !device.android_version.startsWith('Web/') ? `
          <div class="info-card">
            <div class="info-card-label">RAM</div>
            <div class="info-card-value small" id="telRam">${latestTelemetry.ram_free_mb ? formatBytes(latestTelemetry.ram_free_mb) + ' free' : '--'}</div>
          </div>
          <div class="info-card">
            <div class="info-card-label">CPU Usage</div>
            <div class="info-card-value small" id="telCpu">${latestTelemetry.cpu_usage != null ? latestTelemetry.cpu_usage.toFixed(1) + '%' : '--'}</div>
          </div>
          ` : ''}
        </div>

        <!-- Uptime Timeline (24h) -->
        <div style="margin-top:20px">
          <h4 style="font-size:13px;margin-bottom:8px">Uptime Timeline (Last 24 Hours)</h4>
          <div id="uptimeTimeline" style="display:flex;height:32px;border-radius:4px;overflow:hidden;border:1px solid var(--border);background:var(--bg-primary)"></div>
          <div style="display:flex;justify-content:space-between;margin-top:4px">
            <span style="font-size:10px;color:var(--text-muted)">24h ago</span>
            <span style="font-size:10px;color:var(--text-muted)">Now</span>
          </div>
          <div style="display:flex;gap:12px;margin-top:8px;font-size:11px;color:var(--text-muted)">
            <span><span style="display:inline-block;width:10px;height:10px;background:var(--success);border-radius:2px;vertical-align:-1px"></span> Online</span>
            <span><span style="display:inline-block;width:10px;height:10px;background:var(--danger);border-radius:2px;vertical-align:-1px"></span> Offline</span>
            <span><span style="display:inline-block;width:10px;height:10px;background:var(--bg-primary);border:1px solid var(--border);border-radius:2px;vertical-align:-1px"></span> No data</span>
            <span id="uptimePercent" style="margin-left:auto;font-weight:600"></span>
          </div>
        </div>

        <div style="margin-top:20px">
          <div style="display:flex;gap:12px;margin-bottom:12px">
            <div class="form-group" style="flex:1;margin:0">
              <label>Orientation / Rotation</label>
              <select id="deviceOrientation" class="input" style="background:var(--bg-input)">
                <option value="landscape" ${'landscape' === (device.orientation || 'landscape') ? 'selected' : ''}>Landscape (0°)</option>
                <option value="portrait" ${'portrait' === device.orientation ? 'selected' : ''}>Portrait (90° CW)</option>
                <option value="landscape-flipped" ${'landscape-flipped' === device.orientation ? 'selected' : ''}>Landscape Flipped (180°)</option>
                <option value="portrait-flipped" ${'portrait-flipped' === device.orientation ? 'selected' : ''}>Portrait Flipped (270° CW)</option>
              </select>
            </div>
            <div class="form-group" style="flex:1;margin:0">
              <label>Default Content</label>
              <select id="deviceDefaultContent" class="input" style="background:var(--bg-input)">
                <option value="">None (show "Waiting...")</option>
              </select>
            </div>
          </div>
          <div class="form-group">
            <label>Notes</label>
            <textarea id="deviceNotes" class="input" rows="3" placeholder="Location, setup details, etc." style="resize:vertical">${device.notes || ''}</textarea>
          </div>
          <button class="btn btn-secondary btn-sm" id="saveNotesBtn">Save Settings</button>
        </div>
        <div style="margin-top:20px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-secondary btn-sm" id="rebootBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
            Reboot Device
          </button>
          <button class="btn btn-secondary btn-sm" id="screenOffBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
            </svg>
            Screen Off
          </button>
          <button class="btn btn-secondary btn-sm" id="screenOnBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
            </svg>
            Screen On
          </button>
          <button class="btn btn-secondary btn-sm" id="launchAppBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            Launch Player
          </button>
          <button class="btn btn-secondary btn-sm" id="forceUpdateBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Force Update
          </button>
          <button class="btn btn-danger btn-sm" id="shutdownBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>
            </svg>
            Shutdown
          </button>
        </div>
      </div>

      <!-- Remote Control Tab -->
      <div class="tab-content" id="tab-remote">
        <div class="remote-container">
          <div class="remote-screen" id="remoteScreen">
            <canvas id="remoteCanvas" width="960" height="540" style="background:#000;width:100%"></canvas>
            <div class="no-screenshot" id="remoteOverlay" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
              <div style="text-align:center">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin:0 auto 12px">
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                  <line x1="8" y1="21" x2="16" y2="21"/>
                  <line x1="12" y1="17" x2="12" y2="21"/>
                </svg>
                <p style="color:var(--text-secondary)">Click "Start Remote" to begin</p>
              </div>
            </div>
          </div>
          <div class="remote-controls">
            <button class="btn btn-primary" id="startRemoteBtn">Start Remote</button>
            <button class="btn btn-secondary" id="stopRemoteBtn" style="display:none">Stop Remote</button>
            <hr style="border-color:var(--border);margin:8px 0">
            <!-- Always available -->
            <button class="btn btn-secondary btn-sm" onclick="window._sendKey('KEYCODE_VOLUME_UP')">Vol +</button>
            <button class="btn btn-secondary btn-sm" onclick="window._sendKey('KEYCODE_VOLUME_DOWN')">Vol -</button>
            <hr style="border-color:var(--border);margin:8px 0">
            <!-- System View controls (disabled until enabled) -->
            <div id="systemViewControls" style="opacity:0.4;pointer-events:none">
              <button class="btn btn-secondary btn-sm" onclick="window._sendKey('KEYCODE_HOME')">Home</button>
              <button class="btn btn-secondary btn-sm" onclick="window._sendKey('KEYCODE_BACK')">Back</button>
              <button class="btn btn-secondary btn-sm" onclick="window._sendKey('KEYCODE_APP_SWITCH')">Recents</button>
              <button class="btn btn-danger btn-sm" onclick="window._sendKey('KEYCODE_POWER')">Power</button>
              <hr style="border-color:var(--border);margin:8px 0">
              <button class="btn btn-secondary btn-sm" onclick="window._sendKey('KEYCODE_DPAD_UP')">&#9650;</button>
              <div style="display:flex;gap:4px">
                <button class="btn btn-secondary btn-sm" style="flex:1" onclick="window._sendKey('KEYCODE_DPAD_LEFT')">&#9664;</button>
                <button class="btn btn-secondary btn-sm" style="flex:1" onclick="window._sendKey('KEYCODE_DPAD_RIGHT')">&#9654;</button>
              </div>
              <button class="btn btn-secondary btn-sm" onclick="window._sendKey('KEYCODE_DPAD_DOWN')">&#9660;</button>
              <button class="btn btn-primary btn-sm" onclick="window._sendKey('KEYCODE_DPAD_CENTER')">OK</button>
              <hr style="border-color:var(--border);margin:8px 0">
              <button class="btn btn-secondary btn-sm" onclick="window._sendCmd('settings')">Settings</button>
              <hr style="border-color:var(--border);margin:8px 0">
              <div style="display:flex;gap:4px">
                <button class="btn btn-secondary btn-sm" style="flex:1" onclick="window._sendCmd('screen_off')">Scrn Off</button>
                <button class="btn btn-secondary btn-sm" style="flex:1" onclick="window._sendCmd('screen_on')">Scrn On</button>
              </div>
            </div>
            <button class="btn btn-primary btn-sm" id="enableSystemCaptureBtn" onclick="window._enableSystemView()" title="Prompts the device user to allow full screen capture - enables remote view of home screen, settings, and other apps" style="margin-top:8px">
              Enable System View
            </button>
            <span id="systemViewHint" style="font-size:10px;color:var(--text-muted);line-height:1.2;display:block;margin-top:4px">Requires one-time approval on device</span>
          </div>
        </div>
      </div>
    `;

    // Global key/command handlers for remote
    window._sendKey = (keycode) => {
      if (currentDevice) sendKey(currentDevice.id, keycode);
    };
    window._sendCmd = (type) => {
      if (currentDevice) sendCommand(currentDevice.id, type, {});
    };
    window._enableSystemView = () => {
      if (!currentDevice) return;
      sendCommand(currentDevice.id, 'enable_system_capture', {});
      // Unlock the system controls after a short delay (user needs to tap "Start now" on device)
      const btn = document.getElementById('enableSystemCaptureBtn');
      const hint = document.getElementById('systemViewHint');
      if (btn) { btn.textContent = 'Waiting for device approval...'; btn.disabled = true; }
      // Check periodically if the device granted it (we'll know because screenshots keep coming even after Home)
      setTimeout(() => {
        const controls = document.getElementById('systemViewControls');
        if (controls) { controls.style.opacity = '1'; controls.style.pointerEvents = 'auto'; }
        if (btn) { btn.textContent = 'System View Enabled'; btn.style.background = 'var(--success)'; }
        if (hint) hint.textContent = 'Navigation and system controls unlocked';
      }, 5000);
    };

    // Render uptime timeline
    renderUptimeTimeline(device.uptimeData || [], device.statusLog || []);

    setupTabs();
    setupActions(device);
    setupRemote(device);
    setupPlaylistActions(device);

    // Restore active tab if specified (e.g. after layout change)
    if (activeTab) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      const tab = document.querySelector(`.tab[data-tab="${activeTab}"]`);
      if (tab) tab.classList.add('active');
      const content = document.getElementById(`tab-${activeTab}`);
      if (content) content.classList.add('active');
    }

    // Request a fresh screenshot on page load
    if (device.status === 'online') {
      requestScreenshot(deviceId);
    }

  } catch (err) {
    contentEl.innerHTML = `<div class="empty-state"><h3>Failed to load device</h3><p>${esc(err.message)}</p></div>`;
  }
}

function renderPlaylist(assignments) {
  if (!assignments.length) {
    return `<div class="empty-state"><h3>No content assigned</h3><p>Add content from your library to this display's playlist.</p></div>`;
  }
  return assignments.map((a, i) => `
    <div class="playlist-item" data-assignment-id="${a.id}" draggable="true" data-sort="${i}">
      <div style="cursor:grab;padding:4px;color:var(--text-muted);display:flex;align-items:center" class="drag-handle">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="18" x2="16" y2="18"/>
        </svg>
      </div>
      ${a.widget_id && !a.content_id
        ? `<div class="playlist-item-thumb" style="display:flex;align-items:center;justify-content:center;font-size:20px">
            ${{clock:'&#128339;',weather:'&#9925;',rss:'&#128240;',text:'&#128221;',webpage:'&#127760;',social:'&#128172;'}[a.widget_type] || '&#9881;'}
          </div>`
        : a.thumbnail_path
          ? `<img class="playlist-item-thumb" src="/api/content/${a.content_id}/thumbnail" alt="">`
          : `<div class="playlist-item-thumb" style="display:flex;align-items:center;justify-content:center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
            </div>`
      }
      <div class="playlist-item-info">
        <div class="playlist-item-name">${a.filename || a.widget_name || 'Unknown'}</div>
        <div class="playlist-item-meta">
          ${a.widget_id && !a.content_id ? `Widget (${a.widget_type || 'custom'})` : a.mime_type === 'video/youtube' ? 'YouTube' : a.mime_type?.startsWith('video/') ? 'Video' : 'Image'}
          ${a.zone_id ? ` &middot; <span style="color:var(--accent)">Zone: ${a.zone_id.slice(0,8)}</span>` : ''}
          ${a.content_duration ? ` &middot; ${Math.floor(a.content_duration / 60)}:${String(Math.floor(a.content_duration % 60)).padStart(2, '0')}` : ''}
          ${!a.content_duration && !a.mime_type?.startsWith('video/') && a.duration_sec ? ` &middot; ${a.duration_sec}s` : ''}
          ${a.schedule_start ? ` &middot; ${a.schedule_start}-${a.schedule_end}` : ''}
        </div>
      </div>
      <div class="playlist-item-actions" style="display:flex;align-items:center;gap:4px">
        <select class="input zone-select" data-assignment-id="${a.id}" style="width:100px;font-size:11px;padding:2px 4px;background:var(--bg-input);display:none">
          <option value="">No zone</option>
        </select>
        <button class="btn-icon mute-toggle" data-mute-assignment="${a.id}" data-muted="${a.muted ? '1' : '0'}" title="${a.muted ? 'Unmute' : 'Mute'}" style="color:${a.muted ? 'var(--danger)' : 'var(--text-muted)'}">
          ${a.muted
            ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>'
            : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>'
          }
        </button>
        <button class="btn-icon" title="Remove" data-remove-assignment="${a.id}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
    </div>
  `).join('');
}

function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  });
}

async function setupActions(device) {
  // Screenshot button
  document.getElementById('screenshotBtn')?.addEventListener('click', () => {
    requestScreenshot(device.id);
    showToast('Screenshot requested', 'info');
  });

  // Rename
  document.getElementById('renameBtn')?.addEventListener('click', async () => {
    const name = prompt('Enter new name:', device.name);
    if (name && name !== device.name) {
      try {
        await api.updateDevice(device.id, { name });
        document.getElementById('deviceName').textContent = name;
        currentDevice.name = name;
        showToast('Display renamed', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    }
  });

  // Populate default content dropdown
  try {
    const content = await api.getContent();
    const defaultSelect = document.getElementById('deviceDefaultContent');
    if (defaultSelect) {
      content.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id; opt.textContent = c.filename;
        if (device.default_content_id === c.id) opt.selected = true;
        defaultSelect.appendChild(opt);
      });
    }
  } catch {}

  // Save settings (notes + orientation + default content)
  document.getElementById('saveNotesBtn')?.addEventListener('click', async () => {
    try {
      await api.updateDevice(device.id, {
        notes: document.getElementById('deviceNotes').value,
        orientation: document.getElementById('deviceOrientation').value,
        default_content_id: document.getElementById('deviceDefaultContent').value || null,
      });
      showToast('Settings saved', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Populate playlist picker
  const playlistPicker = document.getElementById('playlistPicker');
  if (playlistPicker) {
    api.getPlaylists().then(playlists => {
      playlists.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${p.name}${p.is_auto_generated ? ' (auto)' : ''} — ${p.item_count} items`;
        if (p.id === device.playlist_id) opt.selected = true;
        playlistPicker.appendChild(opt);
      });
      // If device has no playlist, keep "No playlist" selected
      if (!device.playlist_id) playlistPicker.value = '';
    }).catch(() => {});

    playlistPicker.addEventListener('change', async () => {
      const newPlaylistId = playlistPicker.value;
      if (!newPlaylistId) return; // Don't allow deselecting for now
      try {
        await api.assignPlaylistToDevice(newPlaylistId, device.id);
        device.playlist_id = newPlaylistId;
        const assignments = await api.getAssignments(device.id);
        document.getElementById('playlistContainer').innerHTML = renderPlaylist(assignments);
        attachRemoveHandlers(device);
        showToast('Playlist changed');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // Copy playlist to another device
  document.getElementById('copyPlaylistBtn')?.addEventListener('click', async () => {
    try {
      const devices = await api.getDevices();
      const others = devices.filter(d => d.id !== device.id);
      if (!others.length) { showToast('No other devices to copy to', 'info'); return; }

      const targetId = prompt('Copy playlist to which device?\n\n' + others.map((d, i) => `${i + 1}. ${d.name}`).join('\n') + '\n\nEnter number:');
      if (!targetId) return;
      const target = others[parseInt(targetId) - 1];
      if (!target) { showToast('Invalid selection', 'error'); return; }

      const token = localStorage.getItem('token');
      const res = await fetch(`/api/assignments/device/${device.id}/copy-to/${target.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ replace: false })
      });
      const data = await res.json();
      if (res.ok) showToast(`Copied ${data.copied} items to ${target.name}`, 'success');
      else showToast(data.error, 'error');
    } catch (err) { showToast(err.message, 'error'); }
  });

  // Delete (double-click to confirm)
  const deleteBtn = document.getElementById('deleteDeviceBtn');
  let deleteConfirming = false;
  let deleteTimeout = null;
  deleteBtn?.addEventListener('click', async () => {
    if (deleteConfirming) {
      try {
        deleteBtn.textContent = 'Removing...';
        deleteBtn.disabled = true;
        await api.deleteDevice(device.id);
        showToast('Display removed', 'success');
        window.location.hash = '/';
      } catch (err) {
        showToast(err.message, 'error');
        deleteBtn.textContent = 'Remove';
        deleteBtn.disabled = false;
        deleteConfirming = false;
      }
      return;
    }
    deleteConfirming = true;
    deleteBtn.textContent = 'Click again to confirm';
    deleteBtn.style.background = 'var(--danger)';
    deleteBtn.style.color = 'white';
    clearTimeout(deleteTimeout);
    deleteTimeout = setTimeout(() => {
      deleteConfirming = false;
      deleteBtn.textContent = 'Remove';
      deleteBtn.style.background = '';
      deleteBtn.style.color = '';
    }, 3000);
  });

  // Reboot (double-click to confirm)
  const rebootBtn = document.getElementById('rebootBtn');
  let rebootConfirming = false;
  let rebootTimeout = null;
  rebootBtn?.addEventListener('click', () => {
    if (rebootConfirming) {
      sendCommand(device.id, 'reboot', {});
      showToast('Reboot command sent', 'info');
      rebootConfirming = false;
      rebootBtn.textContent = 'Reboot Device';
      return;
    }
    rebootConfirming = true;
    rebootBtn.textContent = 'Click again to confirm';
    clearTimeout(rebootTimeout);
    rebootTimeout = setTimeout(() => {
      rebootConfirming = false;
      rebootBtn.textContent = 'Reboot Device';
    }, 3000);
  });

  // Shutdown (double-click to confirm)
  const shutdownBtn = document.getElementById('shutdownBtn');
  let shutdownConfirming = false;
  let shutdownTimeout = null;
  shutdownBtn?.addEventListener('click', () => {
    if (shutdownConfirming) {
      sendCommand(device.id, 'shutdown', {});
      showToast('Shutdown command sent', 'info');
      shutdownConfirming = false;
      shutdownBtn.textContent = 'Shutdown';
      return;
    }
    shutdownConfirming = true;
    shutdownBtn.textContent = 'Click again to confirm';
    shutdownBtn.style.background = 'var(--danger)';
    shutdownBtn.style.color = 'white';
    clearTimeout(shutdownTimeout);
    shutdownTimeout = setTimeout(() => {
      shutdownConfirming = false;
      shutdownBtn.textContent = 'Shutdown';
      shutdownBtn.style.background = '';
      shutdownBtn.style.color = '';
    }, 3000);
  });

  // Screen Off
  document.getElementById('screenOffBtn')?.addEventListener('click', () => {
    sendCommand(device.id, 'screen_off', {});
    showToast('Screen off command sent', 'info');
  });

  // Screen On
  document.getElementById('screenOnBtn')?.addEventListener('click', () => {
    sendCommand(device.id, 'screen_on', {});
    showToast('Screen on command sent', 'info');
  });

  // Launch Player
  document.getElementById('launchAppBtn')?.addEventListener('click', () => {
    sendCommand(device.id, 'launch', {});
    showToast('Launch command sent', 'info');
  });

  // Force Update
  document.getElementById('forceUpdateBtn')?.addEventListener('click', () => {
    sendCommand(device.id, 'update', {});
    showToast('Update check triggered', 'info');
  });
}

function setupRemote(device) {
  const startBtn = document.getElementById('startRemoteBtn');
  const stopBtn = document.getElementById('stopRemoteBtn');
  const overlay = document.getElementById('remoteOverlay');
  const canvas = document.getElementById('remoteCanvas');

  startBtn?.addEventListener('click', () => {
    console.log('Start Remote clicked for device:', device.id);
    remoteActive = true;
    startRemote(device.id);
    requestScreenshot(device.id);
    startBtn.style.display = 'none';
    stopBtn.style.display = '';
    overlay.style.display = 'none';
    showToast('Remote session started', 'info');
  });

  stopBtn?.addEventListener('click', () => {
    remoteActive = false;
    stopRemote(device.id);
    stopBtn.style.display = 'none';
    startBtn.style.display = '';
    overlay.style.display = 'flex';
  });

  // Touch forwarding on canvas
  canvas?.addEventListener('click', (e) => {
    if (!remoteActive) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    sendTouch(device.id, x, y, 'tap');

    // Visual feedback
    const ctx = canvas.getContext('2d');
    ctx.beginPath();
    ctx.arc(e.clientX - rect.left, e.clientY - rect.top, 10, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(59, 130, 246, 0.5)';
    ctx.fill();
    setTimeout(() => {
      // Redraw will happen on next screenshot
    }, 200);
  });
}

async function setupPlaylistActions(device) {
  // Load layouts into selector
  try {
    const layoutsRes = await fetch('/api/layouts', { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }});
    const layouts = await layoutsRes.json();
    const select = document.getElementById('deviceLayoutSelect');
    if (select) {
      layouts.filter(l => !l.is_template).forEach(l => {
        const opt = document.createElement('option');
        opt.value = l.id;
        opt.textContent = `${l.name} (${l.zones?.length || 0} zones)`;
        if (device.layout_id === l.id) opt.selected = true;
        select.appendChild(opt);
      });
      // Add templates too
      layouts.filter(l => l.is_template).forEach(l => {
        const opt = document.createElement('option');
        opt.value = l.id;
        opt.textContent = `[Template] ${l.name} (${l.zones?.length || 0} zones)`;
        if (device.layout_id === l.id) opt.selected = true;
        select.appendChild(opt);
      });
    }
  } catch (err) {
    console.warn('Failed to load layouts:', err);
  }

  // Apply layout button
  document.getElementById('applyLayoutBtn')?.addEventListener('click', async () => {
    const layoutId = document.getElementById('deviceLayoutSelect').value;
    try {
      await fetch(`/api/layouts/device/${device.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
        body: JSON.stringify({ layout_id: layoutId || null })
      });
      showToast(layoutId ? 'Layout applied' : 'Switched to fullscreen', 'success');
      // Reload the device page to show updated zone selectors, stay on playlist tab
      loadDevice(device.id, 'playlist');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Add content button
  document.getElementById('addContentBtn')?.addEventListener('click', async () => {
    const token = localStorage.getItem('token');
    const headers = { Authorization: `Bearer ${token}` };

    try {
      const [content, widgets, kioskPages] = await Promise.all([
        api.getContent(),
        fetch('/api/widgets', { headers }).then(r => r.json()),
        fetch('/api/kiosk', { headers }).then(r => r.json()),
      ]);

      // Get layout zones if device has a layout assigned
      let zones = [];
      if (device.layout_id) {
        try {
          const layout = await fetch(`/api/layouts/${device.layout_id}`, { headers }).then(r => r.json());
          zones = layout.zones || [];
        } catch {}
      }

      if (!content.length && !widgets.length && !kioskPages.length) {
        showToast('No content, widgets, or kiosk pages yet. Create something first!', 'error');
        return;
      }

      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.innerHTML = `
        <div class="modal" style="width:650px">
          <div class="modal-header">
            <h3>Add to Playlist</h3>
            <button class="btn-icon" id="closeAssignModal">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          <div class="modal-body">
            ${zones.length > 0 ? `
            <div class="form-group">
              <label>Zone</label>
              <select id="assignZone" class="input" style="background:var(--bg-input)">
                <option value="">Default (fullscreen)</option>
                ${zones.map(z => `<option value="${z.id}">${z.name} (${Math.round(z.width_percent)}% x ${Math.round(z.height_percent)}%)</option>`).join('')}
              </select>
            </div>
            ` : ''}
            <div class="form-group">
              <label>Display Duration (seconds, for images/widgets)</label>
              <input type="number" id="assignDuration" class="input" value="10" min="1" max="3600">
            </div>
            <!-- Tabs -->
            <div style="display:flex;gap:0;border-bottom:1px solid var(--border);margin-bottom:12px">
              <div class="assign-tab active" data-tab="media" style="padding:8px 16px;font-size:13px;cursor:pointer;border-bottom:2px solid var(--accent);color:var(--accent)">Media (${content.length})</div>
              <div class="assign-tab" data-tab="widgets" style="padding:8px 16px;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;color:var(--text-secondary)">Widgets (${widgets.length})</div>
              <div class="assign-tab" data-tab="kiosk" style="padding:8px 16px;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;color:var(--text-secondary)">Kiosk (${kioskPages.length})</div>
            </div>
            <!-- Media grid -->
            <div class="assign-content-grid" id="assignMedia">
              ${content.map(c => `
                <div class="assign-content-item" data-content-id="${c.id}" data-type="content">
                  ${c.thumbnail_path
                    ? `<img src="/api/content/${c.id}/thumbnail" alt="">`
                    : c.remote_url
                      ? `<div style="aspect-ratio:16/9;display:flex;align-items:center;justify-content:center;background:var(--bg-primary)">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                        </div>`
                      : `<div style="aspect-ratio:16/9;display:flex;align-items:center;justify-content:center;background:var(--bg-primary)">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                        </div>`
                  }
                  <div class="assign-content-item-name">${c.filename}</div>
                </div>
              `).join('') || '<p style="color:var(--text-muted);padding:16px;text-align:center">No media uploaded yet</p>'}
            </div>
            <!-- Widgets grid -->
            <div class="assign-content-grid" id="assignWidgets" style="display:none">
              ${widgets.map(w => {
                const icons = {clock:'&#128339;',weather:'&#9925;',rss:'&#128240;',text:'&#128221;',webpage:'&#127760;',social:'&#128172;'};
                return `
                <div class="assign-content-item" data-content-id="${w.id}" data-type="widget">
                  <div style="aspect-ratio:16/9;display:flex;align-items:center;justify-content:center;background:var(--bg-primary);font-size:32px">
                    ${icons[w.widget_type] || '&#9881;'}
                  </div>
                  <div class="assign-content-item-name">${w.name}</div>
                </div>`;
              }).join('') || '<p style="color:var(--text-muted);padding:16px;text-align:center">No widgets created yet. <a href="#/widgets" style="color:var(--accent)">Create one</a></p>'}
            </div>
            <!-- Kiosk grid -->
            <div class="assign-content-grid" id="assignKiosk" style="display:none">
              ${kioskPages.map(k => `
                <div class="assign-content-item" data-content-id="${k.id}" data-type="kiosk">
                  <div style="aspect-ratio:16/9;display:flex;align-items:center;justify-content:center;background:var(--bg-primary);font-size:32px">&#128433;</div>
                  <div class="assign-content-item-name">${k.name}</div>
                </div>
              `).join('') || '<p style="color:var(--text-muted);padding:16px;text-align:center">No kiosk pages yet. <a href="#/kiosk" style="color:var(--accent)">Create one</a></p>'}
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" id="cancelAssign">Cancel</button>
            <button class="btn btn-primary" id="confirmAssign">Add Selected</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      // Tab switching
      modal.querySelectorAll('.assign-tab').forEach(tab => {
        tab.onclick = () => {
          modal.querySelectorAll('.assign-tab').forEach(t => { t.style.borderBottomColor = 'transparent'; t.style.color = 'var(--text-secondary)'; });
          tab.style.borderBottomColor = 'var(--accent)'; tab.style.color = 'var(--accent)';
          document.getElementById('assignMedia').style.display = tab.dataset.tab === 'media' ? '' : 'none';
          document.getElementById('assignWidgets').style.display = tab.dataset.tab === 'widgets' ? '' : 'none';
          document.getElementById('assignKiosk').style.display = tab.dataset.tab === 'kiosk' ? '' : 'none';
        };
      });

      let selectedId = null;
      let selectedType = null;
      modal.querySelectorAll('.assign-content-item').forEach(item => {
        item.addEventListener('click', () => {
          modal.querySelectorAll('.assign-content-item').forEach(i => i.classList.remove('selected'));
          item.classList.add('selected');
          selectedId = item.dataset.contentId;
          selectedType = item.dataset.type;
        });
      });

      modal.querySelector('#closeAssignModal').onclick = () => modal.remove();
      modal.querySelector('#cancelAssign').onclick = () => modal.remove();
      modal.querySelector('#confirmAssign').onclick = async () => {
        if (!selectedId) {
          showToast('Select something first', 'error');
          return;
        }
        const duration = parseInt(modal.querySelector('#assignDuration').value) || 10;
        const zoneId = modal.querySelector('#assignZone')?.value || null;
        try {
          if (selectedType === 'content') {
            await api.addAssignment(device.id, { content_id: selectedId, duration_sec: duration, zone_id: zoneId });
          } else if (selectedType === 'widget') {
            await api.addAssignment(device.id, { widget_id: selectedId, duration_sec: duration, zone_id: zoneId });
          } else if (selectedType === 'kiosk') {
            // For kiosk pages, create a webpage widget pointing to the kiosk render URL
            const serverUrl = window.location.origin;
            const wRes = await fetch('/api/widgets', {
              method: 'POST',
              headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify({ widget_type: 'webpage', name: `Kiosk: ${kioskPages.find(k => k.id === selectedId)?.name || 'Page'}`, config: { url: `${serverUrl}/api/kiosk/${selectedId}/render` } })
            });
            const widget = await wRes.json();
            await api.addAssignment(device.id, { widget_id: widget.id, duration_sec: 0 });
          }
          modal.remove();
          showToast('Added to playlist', 'success');
          const assignments = await api.getAssignments(device.id);
          document.getElementById('playlistContainer').innerHTML = renderPlaylist(assignments);
          attachRemoveHandlers(device);
        } catch (err) {
          showToast(err.message, 'error');
        }
      };
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  attachRemoveHandlers(device);
}

function attachRemoveHandlers(device) {
  // Populate zone selectors if device has a layout
  if (device.layout_id) {
    const token = localStorage.getItem('token');
    fetch(`/api/layouts/${device.layout_id}`, { headers: { Authorization: `Bearer ${token}` }})
      .then(r => r.json())
      .then(layout => {
        const zones = layout.zones || [];
        document.querySelectorAll('.zone-select').forEach(select => {
          select.style.display = '';
          const assignmentId = select.dataset.assignmentId;
          // Find current zone_id from the playlist item's data
          const zoneText = select.closest('.playlist-item')?.querySelector('[style*="color:var(--accent)"]')?.textContent || '';
          zones.forEach(z => {
            const opt = document.createElement('option');
            opt.value = z.id;
            opt.textContent = z.name;
            select.appendChild(opt);
          });
          // Set current value by matching zone_id from the meta text
          const currentAssignment = document.querySelector(`.playlist-item[data-assignment-id="${assignmentId}"]`);
          if (currentAssignment) {
            const meta = currentAssignment.querySelector('.playlist-item-meta')?.innerHTML || '';
            const zoneMatch = zones.find(z => meta.includes(z.id.slice(0, 8)));
            if (zoneMatch) select.value = zoneMatch.id;
          }
          select.onchange = async () => {
            try {
              await api.updateAssignment(assignmentId, { zone_id: select.value || null });
              showToast(`Zone updated`, 'success');
            } catch (err) { showToast(err.message, 'error'); }
          };
        });
      }).catch(() => {});
  }

  // Mute toggle buttons
  document.querySelectorAll('.mute-toggle').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.muteAssignment;
      const currentlyMuted = btn.dataset.muted === '1';
      try {
        await api.updateAssignment(id, { muted: !currentlyMuted });
        showToast(currentlyMuted ? 'Unmuted' : 'Muted', 'success');
        const assignments = await api.getAssignments(device.id);
        document.getElementById('playlistContainer').innerHTML = renderPlaylist(assignments);
        attachRemoveHandlers(device);
      } catch (err) { showToast(err.message, 'error'); }
    });
  });

  // Remove buttons
  document.querySelectorAll('[data-remove-assignment]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.removeAssignment;
      try {
        await api.deleteAssignment(id);
        showToast('Content removed from playlist', 'success');
        const assignments = await api.getAssignments(device.id);
        document.getElementById('playlistContainer').innerHTML = renderPlaylist(assignments);
        attachRemoveHandlers(device);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  // Drag-and-drop reorder
  const container = document.getElementById('playlistContainer');
  if (!container) return;
  let dragItem = null;

  container.querySelectorAll('.playlist-item[draggable]').forEach(item => {
    item.addEventListener('dragstart', (e) => {
      dragItem = item;
      item.style.opacity = '0.4';
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      item.style.opacity = '1';
      dragItem = null;
      container.querySelectorAll('.playlist-item').forEach(i => i.style.borderTop = '');
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      container.querySelectorAll('.playlist-item').forEach(i => i.style.borderTop = '');
      if (item !== dragItem) item.style.borderTop = '2px solid var(--accent)';
    });
    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      item.style.borderTop = '';
      if (!dragItem || dragItem === item) return;

      // Get new order
      const items = [...container.querySelectorAll('.playlist-item[data-assignment-id]')];
      const fromIdx = items.indexOf(dragItem);
      const toIdx = items.indexOf(item);
      if (fromIdx < 0 || toIdx < 0) return;

      // Reorder in DOM
      if (fromIdx < toIdx) item.after(dragItem);
      else item.before(dragItem);

      // Get new order of assignment IDs
      const newOrder = [...container.querySelectorAll('.playlist-item[data-assignment-id]')]
        .map(el => parseInt(el.dataset.assignmentId));

      try {
        await api.reorderAssignments(device.id, newOrder);
        showToast('Playlist reordered', 'success');
      } catch (err) {
        showToast(err.message, 'error');
        // Reload to revert
        const assignments = await api.getAssignments(device.id);
        container.innerHTML = renderPlaylist(assignments);
        attachRemoveHandlers(device);
      }
    });
  });
}

function renderUptimeTimeline(uptimeData, statusLog = []) {
  const timeline = document.getElementById('uptimeTimeline');
  const percentEl = document.getElementById('uptimePercent');
  if (!timeline) return;

  const now = Math.floor(Date.now() / 1000);
  const dayAgo = now - 86400;
  const slots = 96; // 15-minute slots over 24 hours
  const slotDuration = 86400 / slots; // 900 seconds = 15 min

  // Build slot status: 'online', 'offline', or 'unknown'
  const slotStatus = new Array(slots).fill('unknown');

  // First pass: mark slots that have heartbeat telemetry as online
  for (const ts of uptimeData) {
    const slotIdx = Math.floor((ts - dayAgo) / slotDuration);
    if (slotIdx >= 0 && slotIdx < slots) slotStatus[slotIdx] = 'online';
  }

  // Second pass: use status log events to paint ranges
  // Walk through events and fill slots between online/offline transitions
  for (let i = 0; i < statusLog.length; i++) {
    const event = statusLog[i];
    const nextEvent = statusLog[i + 1];
    const startSlot = Math.max(0, Math.floor((event.timestamp - dayAgo) / slotDuration));
    const endSlot = nextEvent
      ? Math.min(slots - 1, Math.floor((nextEvent.timestamp - dayAgo) / slotDuration))
      : (event.status === 'online' ? slots - 1 : startSlot);

    const isOnline = event.status === 'online';
    for (let s = startSlot; s <= endSlot && s < slots; s++) {
      if (s >= 0) slotStatus[s] = isOnline ? 'online' : 'offline';
    }
  }

  // Mark future slots as unknown
  const nowSlot = Math.floor((now - dayAgo) / slotDuration);
  for (let i = nowSlot + 1; i < slots; i++) slotStatus[i] = 'unknown';

  // Calculate uptime percentage (only over known slots)
  const knownSlots = slotStatus.filter(s => s !== 'unknown').length;
  const onlineSlots = slotStatus.filter(s => s === 'online').length;
  const uptimePct = knownSlots > 0 ? Math.round((onlineSlots / knownSlots) * 100) : 0;
  if (percentEl) percentEl.textContent = `${uptimePct}% uptime (${knownSlots > 0 ? knownSlots * 15 + 'min tracked' : 'no data'})`;

  // Color map
  const colors = {
    online: 'var(--success)',
    offline: 'var(--danger)',
    unknown: 'var(--bg-secondary)'
  };
  const opacities = { online: 0.8, offline: 0.6, unknown: 0.3 };

  // Render bars
  timeline.innerHTML = slotStatus.map((status, i) => {
    const time = new Date((dayAgo + i * slotDuration) * 1000);
    const label = time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const statusLabel = status === 'unknown' ? 'No data' : status.charAt(0).toUpperCase() + status.slice(1);
    return `<div style="flex:1;background:${colors[status]};opacity:${opacities[status]}" title="${label} - ${statusLabel}"></div>`;
  }).join('');
}

function updateTelemetryDisplay(telemetry) {
  const update = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  if (telemetry.battery_level != null) update('telBattery', telemetry.battery_level + '%');
  if (telemetry.storage_free_mb) update('telStorage', formatBytes(telemetry.storage_free_mb) + ' free');
  if (telemetry.wifi_ssid) update('telWifi', telemetry.wifi_ssid);
  if (telemetry.wifi_rssi) update('telRssi', telemetry.wifi_rssi + ' dBm');
  if (telemetry.uptime_seconds) update('telUptime', formatUptime(telemetry.uptime_seconds));
  if (telemetry.ram_free_mb) update('telRam', formatBytes(telemetry.ram_free_mb) + ' free');
  if (telemetry.cpu_usage != null) update('telCpu', telemetry.cpu_usage.toFixed(1) + '%');
}

export function cleanup() {
  if (statusHandler) off('device-status', statusHandler);
  if (screenshotHandler) off('screenshot-ready', screenshotHandler);
  if (playbackHandler) off('playback-state', playbackHandler);
  if (screenshotInterval) clearInterval(screenshotInterval);
  if (remoteActive && currentDevice) stopRemote(currentDevice.id);
  remoteActive = false;
  currentDevice = null;
  window._sendKey = null;
}
