import { api } from '../api.js';
import { on, off, requestScreenshot, startRemote, stopRemote, sendTouch, sendKey, sendCommand } from '../socket.js';
import { showToast } from '../components/toast.js';
import { esc } from '../utils.js';
import { t, tn } from '../i18n.js';

let currentDevice = null;
let statusHandler = null;
let screenshotHandler = null;
let playbackHandler = null;
let logHandler = null;
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

// #74/#75: device clock + skew indicator. Compares the device's reported UTC to the
// server's receipt time; a gap > 2 min means the device clock is wrong, so per-item
// schedules will fire at the wrong local time — surface it instead of a support mystery.
function renderDeviceClock(device) {
  const tz = device.reported_timezone || device.timezone || '--';
  if (!device.reported_utc || !device.reported_at) return tz;
  const skewSec = Math.abs(Math.round(device.reported_utc / 1000) - device.reported_at);
  let local = '';
  try {
    local = new Date(device.reported_utc).toLocaleString(undefined,
      { timeZone: device.reported_timezone || undefined, hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
  } catch (e) { /* bad tz id -> skip local render */ }
  const warn = skewSec > 120
    ? `<div style="color:#f59e0b;font-size:11px;margin-top:2px">${t('device.clock.skew', { amount: skewSec >= 3600 ? Math.round(skewSec / 3600) + 'h' : Math.round(skewSec / 60) + 'm' })}</div>`
    : '';
  return `${tz}${local ? `<div style="font-size:11px;color:var(--text-muted)">${t('device.clock.reported', { time: local })}</div>` : ''}${warn}`;
}

export function render(container, deviceId) {
  container.innerHTML = `
    <div class="device-detail">
      <a href="#/" class="back-link">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
        </svg>
        ${t('device.back')}
      </a>
      <div id="deviceContent">
        <div class="empty-state"><h3>${t('common.loading')}</h3></div>
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
      el.textContent = t('device.now_playing_id', { id: data.current_content_id });
    }
  };

  // Live debug log lines streamed from the device (when the Debug logging
  // checkbox is on). Appended via textContent — no HTML injection.
  logHandler = (data) => {
    if (data.device_id !== deviceId) return;
    const panel = document.getElementById('debugLogPanel');
    if (!panel) return;
    const line = document.createElement('div');
    const time = new Date(data.ts || Date.now()).toLocaleTimeString();
    line.textContent = `${time} [${data.tag || ''}] ${data.message || ''}`;
    panel.appendChild(line);
    while (panel.childElementCount > 500) panel.removeChild(panel.firstChild);
    panel.scrollTop = panel.scrollHeight;
  };

  on('device-status', statusHandler);
  on('screenshot-ready', screenshotHandler);
  on('playback-state', playbackHandler);
  on('device-log', logHandler);
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
          ${device.owner_name || device.owner_email ? `<span style="font-size:12px;color:var(--text-muted)">${t('device.owner_label', { owner: device.owner_name || device.owner_email })}</span>` : ''}
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary btn-sm" id="devicePreviewBtn">${t('device.preview_btn')}</button>
          <button class="btn btn-secondary btn-sm" id="renameBtn">${t('device.rename')}</button>
          <button class="btn btn-secondary btn-sm" id="screenshotBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
              <polyline points="21 15 16 10 5 21"/>
            </svg>
            ${t('device.screenshot_btn')}
          </button>
          <button class="btn btn-danger btn-sm" id="deleteDeviceBtn">${t('device.remove')}</button>
        </div>
      </div>

      <div class="tabs">
        <div class="tab active" data-tab="nowplaying">${t('device.tab.now_playing')} <span class="help-tip" data-tip="${t('device.tab.now_playing_tip')}">?</span></div>
        <div class="tab" data-tab="playlist">${t('device.tab.playlist')} <span class="help-tip" data-tip="${t('device.tab.playlist_tip')}">?</span></div>
        <div class="tab" data-tab="info">${t('device.tab.info')} <span class="help-tip" data-tip="${t('device.tab.info_tip')}">?</span></div>
        <div class="tab" data-tab="remote">${t('device.tab.remote')} <span class="help-tip" data-tip="${t('device.tab.remote_tip')}">?</span></div>
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
                <span>${t('device.no_screenshot')}</span>
              </div>`
          }
        </div>
        <p id="nowPlayingInfo" style="color:var(--text-secondary);font-size:13px;">
          ${device.assignments?.length ? tn('device.playlist_count', device.assignments.length) : t('device.no_content_assigned')}
        </p>
      </div>

      <!-- Playlist Tab -->
      <div class="tab-content" id="tab-playlist">
        ${device.playlist_status === 'draft' ? `
        <div id="deviceDraftBanner" style="background:#78350f;border:1px solid #92400e;border-radius:var(--radius);padding:14px 20px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:16px">
          <div style="display:flex;align-items:center;gap:10px;color:#fbbf24">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <div>
              <div style="font-weight:600;font-size:14px">${t('device.draft.banner_title')}</div>
              <div style="font-size:12px;color:#fcd34d;opacity:0.85">${device.playlist_has_published ? t('device.draft.devices_showing_published') : t('device.draft.never_published')}</div>
            </div>
          </div>
          <div style="display:flex;gap:8px;flex-shrink:0">
            ${device.playlist_has_published ? `<button class="btn btn-secondary btn-sm" id="deviceDiscardDraftBtn" style="color:#fbbf24;border-color:#92400e">${t('device.draft.discard')}</button>` : ''}
            <button class="btn btn-sm" id="devicePublishBtn" style="background:#f59e0b;color:#000;font-weight:600;border:none">${t('device.draft.publish')}</button>
          </div>
        </div>
        ` : ''}
        <!-- Layout selector -->
        <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px;margin-bottom:16px;display:flex;align-items:center;gap:12px">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>
          </svg>
          <div style="flex:1">
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">${t('device.layout.label')}</div>
            <select id="deviceLayoutSelect" class="input" style="background:var(--bg-input);padding:4px 8px;font-size:13px">
              <option value="">${t('device.layout.fullscreen_default')}</option>
            </select>
          </div>
          <button class="btn btn-secondary btn-sm" id="applyLayoutBtn">${t('device.layout.apply')}</button>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <div style="display:flex;align-items:center;gap:12px">
            <h3 style="font-size:16px">${t('device.playlist.label')}</h3>
            <select class="input" id="playlistPicker" style="font-size:12px;padding:4px 8px;width:200px">
              <option value="">${t('device.playlist.no_playlist')}</option>
            </select>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-secondary btn-sm" id="copyPlaylistBtn">${t('device.playlist.copy_to_btn')}</button>
            <button class="btn btn-primary btn-sm" id="addContentBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            ${t('device.playlist.add_content_btn')}
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
            <div class="info-card-label">${t('device.info.status')}</div>
            <div class="info-card-value" style="color:var(--${device.status === 'online' ? 'success' : 'danger'})">${device.status}</div>
          </div>
          <div class="info-card">
            <div class="info-card-label">${t('device.info.ip_address')}</div>
            <div class="info-card-value small">${device.ip_address || '--'}</div>
          </div>
          ${device.android_version && !device.android_version.startsWith('Web/') ? `
          <div class="info-card">
            <div class="info-card-label">${t('device.info.battery')}</div>
            <div class="info-card-value" id="telBattery">${latestTelemetry.battery_level != null ? latestTelemetry.battery_level + '%' : '--'}</div>
            ${latestTelemetry.battery_level != null ? `
            <div class="progress-bar">
              <div class="progress-bar-fill ${latestTelemetry.battery_level > 50 ? 'success' : latestTelemetry.battery_level > 20 ? 'warning' : 'danger'}"
                   style="width:${latestTelemetry.battery_level}%"></div>
            </div>` : ''}
          </div>
          <div class="info-card">
            <div class="info-card-label">${t('device.info.storage')}</div>
            <div class="info-card-value small" id="telStorage">${latestTelemetry.storage_free_mb ? t('device.info.size_free', { size: formatBytes(latestTelemetry.storage_free_mb) }) : '--'}</div>
            ${latestTelemetry.storage_total_mb ? `
            <div class="progress-bar">
              <div class="progress-bar-fill ${((latestTelemetry.storage_total_mb - latestTelemetry.storage_free_mb) / latestTelemetry.storage_total_mb) < 0.8 ? 'success' : 'warning'}"
                   style="width:${((latestTelemetry.storage_total_mb - latestTelemetry.storage_free_mb) / latestTelemetry.storage_total_mb * 100)}%"></div>
            </div>` : ''}
          </div>
          ` : `
          <div class="info-card">
            <div class="info-card-label">${t('device.info.player_type')}</div>
            <div class="info-card-value small">${t('device.info.web_player')}</div>
          </div>
          `}
          ${device.android_version && !device.android_version.startsWith('Web/') ? `
          <div class="info-card">
            <div class="info-card-label">${t('device.info.wifi')}</div>
            <div class="info-card-value small" id="telWifi">${latestTelemetry.wifi_ssid || '--'}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px" id="telRssi">${latestTelemetry.wifi_rssi ? latestTelemetry.wifi_rssi + ' dBm' : ''}</div>
          </div>
          ` : ''}
          <div class="info-card">
            <div class="info-card-label">${t('device.info.uptime')}</div>
            <div class="info-card-value small" id="telUptime">${formatUptime(latestTelemetry.uptime_seconds)}</div>
          </div>
          ${device.android_version && !device.android_version.startsWith('Web/') ? `
          <div class="info-card">
            <div class="info-card-label">${t('device.info.android_version')}</div>
            <div class="info-card-value small">${device.android_version}</div>
          </div>
          <div class="info-card">
            <div class="info-card-label">${t('device.info.app_version')}</div>
            <div class="info-card-value small">${device.app_version || '--'}</div>
          </div>
          ` : ''}
          <div class="info-card">
            <div class="info-card-label">${t('device.info.screen_resolution')}</div>
            <div class="info-card-value small">${device.screen_width && device.screen_height ? device.screen_width + 'x' + device.screen_height : '--'}</div>
          </div>
          <div class="info-card">
            <div class="info-card-label">${t('device.clock.label')}</div>
            <div class="info-card-value small">${renderDeviceClock(device)}</div>
          </div>
          ${device.android_version && !device.android_version.startsWith('Web/') ? `
          <div class="info-card">
            <div class="info-card-label">${t('device.info.ram')}</div>
            <div class="info-card-value small" id="telRam">${latestTelemetry.ram_free_mb ? t('device.info.size_free', { size: formatBytes(latestTelemetry.ram_free_mb) }) : '--'}</div>
          </div>
          <div class="info-card">
            <div class="info-card-label">${t('device.info.cpu_usage')}</div>
            <div class="info-card-value small" id="telCpu">${latestTelemetry.cpu_usage != null ? latestTelemetry.cpu_usage.toFixed(1) + '%' : '--'}</div>
          </div>
          ` : ''}
        </div>

        <!-- Uptime Timeline (24h) -->
        <div style="margin-top:20px">
          <h4 style="font-size:13px;margin-bottom:8px">${t('device.timeline.title')}</h4>
          <div id="uptimeTimeline" style="display:flex;height:32px;border-radius:4px;overflow:hidden;border:1px solid var(--border);background:var(--bg-primary)"></div>
          <div style="display:flex;justify-content:space-between;margin-top:4px">
            <span style="font-size:10px;color:var(--text-muted)">${t('device.timeline.h24_ago')}</span>
            <span style="font-size:10px;color:var(--text-muted)">${t('device.timeline.now')}</span>
          </div>
          <div style="display:flex;gap:12px;margin-top:8px;font-size:11px;color:var(--text-muted)">
            <span><span style="display:inline-block;width:10px;height:10px;background:var(--success);border-radius:2px;vertical-align:-1px"></span> ${t('device.timeline.online')}</span>
            <span><span style="display:inline-block;width:10px;height:10px;background:var(--danger);border-radius:2px;vertical-align:-1px"></span> ${t('device.timeline.offline')}</span>
            <span><span style="display:inline-block;width:10px;height:10px;background:var(--bg-primary);border:1px solid var(--border);border-radius:2px;vertical-align:-1px"></span> ${t('device.timeline.no_data')}</span>
            <span id="uptimePercent" style="margin-left:auto;font-weight:600"></span>
          </div>
        </div>

        <div style="margin-top:20px">
          <div style="display:flex;gap:12px;margin-bottom:12px">
            <div class="form-group" style="flex:1;margin:0">
              <label>${t('device.form.orientation_label')}</label>
              <select id="deviceOrientation" class="input" style="background:var(--bg-input)">
                <option value="landscape" ${'landscape' === (device.orientation || 'landscape') ? 'selected' : ''}>${t('device.form.orientation.landscape')}</option>
                <option value="portrait" ${'portrait' === device.orientation ? 'selected' : ''}>${t('device.form.orientation.portrait')}</option>
                <option value="landscape-flipped" ${'landscape-flipped' === device.orientation ? 'selected' : ''}>${t('device.form.orientation.landscape_flipped')}</option>
                <option value="portrait-flipped" ${'portrait-flipped' === device.orientation ? 'selected' : ''}>${t('device.form.orientation.portrait_flipped')}</option>
              </select>
            </div>
            <div class="form-group" style="flex:1;margin:0">
              <label>${t('device.form.default_content_label')}</label>
              <select id="deviceDefaultContent" class="input" style="background:var(--bg-input)">
                <option value="">${t('device.form.default_content_none')}</option>
              </select>
            </div>
          </div>
          <div class="form-group">
            <label>${t('device.form.notes_label')}</label>
            <textarea id="deviceNotes" class="input" rows="3" placeholder="${t('device.form.notes_placeholder')}" style="resize:vertical">${esc(device.notes || '')}</textarea>
          </div>
          <button class="btn btn-secondary btn-sm" id="saveNotesBtn">${t('device.form.save_settings')}</button>
        </div>

        <div style="margin-top:20px">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
            <input type="checkbox" id="debugLogToggle"> ${t('device.debug.toggle')}
          </label>
          <div style="font-size:11px;color:var(--text-muted);margin:4px 0 0 24px">${t('device.debug.hint')}</div>
          <div id="debugLogPanel" style="display:none;margin-top:8px;background:#0b0f1a;border:1px solid var(--border);border-radius:6px;padding:8px;height:220px;overflow-y:auto;font-family:monospace;font-size:11px;line-height:1.45;color:#cbd5e1"></div>
        </div>

        <div style="margin-top:20px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-secondary btn-sm" id="rebootBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
            ${t('device.ctl.reboot_device')}
          </button>
          <button class="btn btn-secondary btn-sm" id="screenOffBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
            </svg>
            ${t('device.ctl.screen_off')}
          </button>
          <button class="btn btn-secondary btn-sm" id="screenOnBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
            </svg>
            ${t('device.ctl.screen_on')}
          </button>
          <button class="btn btn-secondary btn-sm" id="launchAppBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            ${t('device.ctl.launch_player')}
          </button>
          <button class="btn btn-secondary btn-sm" id="forceUpdateBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            ${t('device.ctl.force_update')}
          </button>
          <button class="btn btn-danger btn-sm" id="shutdownBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>
            </svg>
            ${t('device.ctl.shutdown')}
          </button>
        </div>

        <!-- #109: PiP overlay tester. Pushes device:pip-show/clear via POST /api/pip
             (real triggers are external via the API token; this is for testing). -->
        <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border)">
          <div style="font-weight:600;margin-bottom:8px">Overlay (PiP) — test</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <select id="pipType" class="btn btn-secondary btn-sm" style="min-width:90px">
              <option value="image">image</option>
              <option value="web">web</option>
            </select>
            <input id="pipUri" type="url" placeholder="https://… (image or page URL)" style="flex:1;min-width:240px;padding:6px 8px;background:#0b0f1a;border:1px solid var(--border);border-radius:6px;color:var(--text)">
            <select id="pipPosition" class="btn btn-secondary btn-sm" style="min-width:120px">
              <option value="top-right">top-right</option>
              <option value="top-left">top-left</option>
              <option value="bottom-right">bottom-right</option>
              <option value="bottom-left">bottom-left</option>
              <option value="center">center</option>
            </select>
            <input id="pipDuration" type="number" min="0" value="30" title="seconds (0 = until cleared)" style="width:90px;padding:6px 8px;background:#0b0f1a;border:1px solid var(--border);border-radius:6px;color:var(--text)">
            <button class="btn btn-primary btn-sm" id="sendPipBtn">Send overlay</button>
            <button class="btn btn-secondary btn-sm" id="clearPipBtn">Clear overlay</button>
          </div>
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
                <p style="color:var(--text-secondary)">${t('device.remote.start_prompt')}</p>
              </div>
            </div>
          </div>
          <div class="remote-controls">
            <button class="btn btn-primary" id="startRemoteBtn">${t('device.remote.start')}</button>
            <button class="btn btn-secondary" id="stopRemoteBtn" style="display:none">${t('device.remote.stop')}</button>
            <hr style="border-color:var(--border);margin:8px 0">
            <!-- Always available -->
            <button class="btn btn-secondary btn-sm" onclick="window._sendKey('KEYCODE_VOLUME_UP')">${t('device.remote.vol_up')}</button>
            <button class="btn btn-secondary btn-sm" onclick="window._sendKey('KEYCODE_VOLUME_DOWN')">${t('device.remote.vol_down')}</button>
            <hr style="border-color:var(--border);margin:8px 0">
            <!-- System View controls (disabled until enabled) -->
            <div id="systemViewControls" style="opacity:0.4;pointer-events:none">
              <button class="btn btn-secondary btn-sm" onclick="window._sendKey('KEYCODE_HOME')">${t('device.remote.home')}</button>
              <button class="btn btn-secondary btn-sm" onclick="window._sendKey('KEYCODE_BACK')">${t('device.remote.back')}</button>
              <button class="btn btn-secondary btn-sm" onclick="window._sendKey('KEYCODE_APP_SWITCH')">${t('device.remote.recents')}</button>
              <button class="btn btn-danger btn-sm" onclick="window._sendKey('KEYCODE_POWER')">${t('device.remote.power')}</button>
              <hr style="border-color:var(--border);margin:8px 0">
              <button class="btn btn-secondary btn-sm" onclick="window._sendKey('KEYCODE_DPAD_UP')">&#9650;</button>
              <div style="display:flex;gap:4px">
                <button class="btn btn-secondary btn-sm" style="flex:1" onclick="window._sendKey('KEYCODE_DPAD_LEFT')">&#9664;</button>
                <button class="btn btn-secondary btn-sm" style="flex:1" onclick="window._sendKey('KEYCODE_DPAD_RIGHT')">&#9654;</button>
              </div>
              <button class="btn btn-secondary btn-sm" onclick="window._sendKey('KEYCODE_DPAD_DOWN')">&#9660;</button>
              <button class="btn btn-primary btn-sm" onclick="window._sendKey('KEYCODE_DPAD_CENTER')">${t('device.remote.ok')}</button>
              <hr style="border-color:var(--border);margin:8px 0">
              <button class="btn btn-secondary btn-sm" onclick="window._sendCmd('settings')">${t('device.remote.settings')}</button>
              <hr style="border-color:var(--border);margin:8px 0">
              <div style="display:flex;gap:4px">
                <button class="btn btn-secondary btn-sm" style="flex:1" onclick="window._sendCmd('screen_off')">${t('device.remote.scrn_off')}</button>
                <button class="btn btn-secondary btn-sm" style="flex:1" onclick="window._sendCmd('screen_on')">${t('device.remote.scrn_on')}</button>
              </div>
            </div>
            <button class="btn btn-primary btn-sm" id="enableSystemCaptureBtn" onclick="window._enableSystemView()" title="${t('device.remote.system_view_tooltip')}" style="margin-top:8px">
              ${t('device.remote.enable_system_view')}
            </button>
            <span id="systemViewHint" style="font-size:10px;color:var(--text-muted);line-height:1.2;display:block;margin-top:4px">${t('device.remote.system_view_hint')}</span>
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
      if (btn) { btn.textContent = t('device.remote.waiting_for_approval'); btn.disabled = true; }
      // Check periodically if the device granted it (we'll know because screenshots keep coming even after Home)
      setTimeout(() => {
        const controls = document.getElementById('systemViewControls');
        if (controls) { controls.style.opacity = '1'; controls.style.pointerEvents = 'auto'; }
        if (btn) { btn.textContent = t('device.remote.system_view_enabled'); btn.style.background = 'var(--success)'; }
        if (hint) hint.textContent = t('device.remote.unlocked_hint');
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
    contentEl.innerHTML = `<div class="empty-state"><h3>${t('device.failed_load')}</h3><p>${esc(err.message)}</p></div>`;
  }
}

function renderPlaylist(assignments) {
  if (!assignments.length) {
    return `<div class="empty-state"><h3>${t('device.playlist.empty_title')}</h3><p>${t('device.playlist.empty_desc')}</p></div>`;
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
        <div class="playlist-item-name">${esc(a.filename || a.widget_name || t('common.unknown'))}</div>
        <div class="playlist-item-meta">
          ${a.widget_id && !a.content_id ? t('device.pl_item.widget_with_type', { type: a.widget_type || 'custom' }) : a.mime_type === 'video/youtube' ? t('device.pl_item.youtube') : a.mime_type?.startsWith('video/') ? t('device.pl_item.video') : t('device.pl_item.image')}
          ${a.zone_id ? ` &middot; <span style="color:var(--accent)">${t('device.pl_item.zone_label', { id: a.zone_id.slice(0,8) })}</span>` : ''}
          ${a.content_duration ? ` &middot; ${Math.floor(a.content_duration / 60)}:${String(Math.floor(a.content_duration % 60)).padStart(2, '0')}` : ''}
          ${!a.content_duration && !a.mime_type?.startsWith('video/') && a.duration_sec ? ` &middot; ${a.duration_sec}s` : ''}
          ${a.schedule_start ? ` &middot; ${a.schedule_start}-${a.schedule_end}` : ''}
        </div>
      </div>
      <div class="playlist-item-actions" style="display:flex;align-items:center;gap:4px">
        <select class="input zone-select" data-assignment-id="${a.id}" data-current-zone-id="${a.zone_id || ''}" style="width:100px;font-size:11px;padding:2px 4px;background:var(--bg-input);display:none">
          <option value="">${t('device.pl_item.no_zone')}</option>
        </select>
        <button class="btn-icon mute-toggle" data-mute-assignment="${a.id}" data-muted="${a.muted ? '1' : '0'}" title="${a.muted ? t('device.pl_item.unmute') : t('device.pl_item.mute')}" style="color:${a.muted ? 'var(--danger)' : 'var(--text-muted)'}">
          ${a.muted
            ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>'
            : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>'
          }
        </button>
        <button class="btn-icon" title="${t('device.pl_item.remove')}" data-remove-assignment="${a.id}">
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

// #104: device preview — reuse the player in device-free preview mode, iframed
// same-origin (dashboard CSP frame-src 'self' allows it). Shows the device's CURRENT
// playlist in the device's OWN layout/orientation (server payload). wall members
// preview full-frame (server forces wall_config:null in v1).
function showDevicePreview(device) {
  const portrait = (device.orientation || '').includes('portrait');
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:10000;padding:16px';
  overlay.innerHTML = `
    <div style="background:var(--bg-card);border-radius:8px;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--border);max-width:95vw;max-height:92vh">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid var(--border);gap:12px">
        <strong style="color:var(--text-primary)">${t('device.preview_btn')} — ${esc(device.name)}</strong>
        <button class="btn btn-secondary btn-sm" id="dpvClose">${t('widget.close')}</button>
      </div>
      <div style="padding:16px;display:flex;align-items:center;justify-content:center;background:#000">
        <iframe style="height:78vh;max-width:92vw;aspect-ratio:${portrait ? '9 / 16' : '16 / 9'};border:0;background:#000" src="/player?preview=1&device=${encodeURIComponent(device.id)}&t=${Date.now()}"></iframe>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#dpvClose').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', function esc2(ev) {
    if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', esc2); }
  });
}

async function setupActions(device) {
  // #104 Preview button
  document.getElementById('devicePreviewBtn')?.addEventListener('click', () => showDevicePreview(device));

  // Screenshot button
  document.getElementById('screenshotBtn')?.addEventListener('click', () => {
    requestScreenshot(device.id);
    showToast(t('device.toast.screenshot_requested'), 'info');
  });

  // Rename
  document.getElementById('renameBtn')?.addEventListener('click', async () => {
    const name = prompt(t('device.prompt_new_name'), device.name);
    if (name && name !== device.name) {
      try {
        await api.updateDevice(device.id, { name });
        document.getElementById('deviceName').textContent = name;
        currentDevice.name = name;
        showToast(t('device.toast.renamed'), 'success');
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
  // Debug logging toggle: sends a transient set_debug command to the device and
  // reveals the live log panel. State is per-session (resets on device reconnect).
  document.getElementById('debugLogToggle')?.addEventListener('change', (e) => {
    const enabled = e.target.checked;
    const panel = document.getElementById('debugLogPanel');
    if (panel) panel.style.display = enabled ? 'block' : 'none';
    sendCommand(device.id, 'set_debug', { enabled });
  });

  document.getElementById('saveNotesBtn')?.addEventListener('click', async () => {
    try {
      await api.updateDevice(device.id, {
        notes: document.getElementById('deviceNotes').value,
        orientation: document.getElementById('deviceOrientation').value,
        default_content_id: document.getElementById('deviceDefaultContent').value || null,
      });
      showToast(t('device.toast.settings_saved'), 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Publish / Discard from device detail
  const devicePublishBtn = document.getElementById('devicePublishBtn');
  if (devicePublishBtn && device.playlist_id) {
    devicePublishBtn.addEventListener('click', async () => {
      try {
        devicePublishBtn.disabled = true;
        devicePublishBtn.textContent = t('device.draft.publishing');
        await api.publishPlaylist(device.playlist_id);
        showToast(t('device.toast.published'));
        loadDevice(device.id, 'playlist');
      } catch (err) {
        devicePublishBtn.disabled = false;
        devicePublishBtn.textContent = t('device.draft.publish');
        showToast(err.message, 'error');
      }
    });
  }
  const deviceDiscardBtn = document.getElementById('deviceDiscardDraftBtn');
  if (deviceDiscardBtn && device.playlist_id) {
    deviceDiscardBtn.addEventListener('click', async () => {
      if (!confirm(t('device.confirm_discard_draft'))) return;
      try {
        await api.discardPlaylistDraft(device.playlist_id);
        showToast(t('device.toast.draft_discarded'));
        loadDevice(device.id, 'playlist');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // Populate playlist picker
  const playlistPicker = document.getElementById('playlistPicker');
  if (playlistPicker) {
    api.getPlaylists().then(playlists => {
      playlists.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.is_auto_generated
          ? t('device.playlist_picker.with_auto', { name: p.name, n: p.item_count })
          : t('device.playlist_picker.with_count', { name: p.name, n: p.item_count });
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
        showToast(t('device.toast.playlist_changed'));
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
      if (!others.length) { showToast(t('device.copy.no_other_devices'), 'info'); return; }

      const targetId = prompt(t('device.copy.prompt', { list: others.map((d, i) => `${i + 1}. ${d.name}`).join('\n') }));
      if (!targetId) return;
      const target = others[parseInt(targetId) - 1];
      if (!target) { showToast(t('device.copy.invalid_selection'), 'error'); return; }

      const token = localStorage.getItem('token');
      const res = await fetch(`/api/assignments/device/${device.id}/copy-to/${target.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ replace: false })
      });
      const data = await res.json();
      if (res.ok) showToast(t('device.copy.toast', { n: data.copied, device: target.name }), 'success');
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
        deleteBtn.textContent = t('device.toast.removing');
        deleteBtn.disabled = true;
        await api.deleteDevice(device.id);
        showToast(t('device.toast.removed'), 'success');
        window.location.hash = '/';
      } catch (err) {
        showToast(err.message, 'error');
        deleteBtn.textContent = t('device.remove');
        deleteBtn.disabled = false;
        deleteConfirming = false;
      }
      return;
    }
    deleteConfirming = true;
    deleteBtn.textContent = t('device.click_to_confirm');
    deleteBtn.style.background = 'var(--danger)';
    deleteBtn.style.color = 'white';
    clearTimeout(deleteTimeout);
    deleteTimeout = setTimeout(() => {
      deleteConfirming = false;
      deleteBtn.textContent = t('device.remove');
      deleteBtn.style.background = '';
      deleteBtn.style.color = '';
    }, 3000);
  });

  // Send a command and surface the three-state ack as a toast.
  // - delivered: device received it (green/success)
  // - queued: device is offline, will deliver on reconnect (amber/warning)
  // - no_ack / fallback: server didn't respond or queue unavailable (red/error)
  function sendWithFeedback(type, cmdLabel, successKey) {
    sendCommand(device.id, type, {}, (ack) => {
      if (ack?.delivered) showToast(t(successKey), 'success');
      else if (ack?.queued) showToast(t('device.toast.command_queued', { cmd: cmdLabel }), 'warning');
      else if (ack?.reason === 'no_ack') showToast(t('device.toast.command_no_ack', { cmd: cmdLabel }), 'error');
      else showToast(t('device.toast.command_undeliverable', { cmd: cmdLabel }), 'error');
    });
  }

  // Reboot (double-click to confirm)
  const rebootBtn = document.getElementById('rebootBtn');
  let rebootConfirming = false;
  let rebootTimeout = null;
  rebootBtn?.addEventListener('click', () => {
    if (rebootConfirming) {
      sendWithFeedback('reboot', 'Reboot', 'device.toast.reboot_sent');
      rebootConfirming = false;
      rebootBtn.textContent = t('device.ctl.reboot_device');
      return;
    }
    rebootConfirming = true;
    rebootBtn.textContent = t('device.click_to_confirm');
    clearTimeout(rebootTimeout);
    rebootTimeout = setTimeout(() => {
      rebootConfirming = false;
      rebootBtn.textContent = t('device.ctl.reboot_device');
    }, 3000);
  });

  // Shutdown (double-click to confirm)
  const shutdownBtn = document.getElementById('shutdownBtn');
  let shutdownConfirming = false;
  let shutdownTimeout = null;
  shutdownBtn?.addEventListener('click', () => {
    if (shutdownConfirming) {
      sendWithFeedback('shutdown', 'Shutdown', 'device.toast.shutdown_sent');
      shutdownConfirming = false;
      shutdownBtn.textContent = t('device.ctl.shutdown');
      return;
    }
    shutdownConfirming = true;
    shutdownBtn.textContent = t('device.click_to_confirm');
    shutdownBtn.style.background = 'var(--danger)';
    shutdownBtn.style.color = 'white';
    clearTimeout(shutdownTimeout);
    shutdownTimeout = setTimeout(() => {
      shutdownConfirming = false;
      shutdownBtn.textContent = t('device.ctl.shutdown');
      shutdownBtn.style.background = '';
      shutdownBtn.style.color = '';
    }, 3000);
  });

  // Screen Off
  document.getElementById('screenOffBtn')?.addEventListener('click', () => {
    sendWithFeedback('screen_off', 'Screen off', 'device.toast.screen_off_sent');
  });

  // Screen On
  document.getElementById('screenOnBtn')?.addEventListener('click', () => {
    sendWithFeedback('screen_on', 'Screen on', 'device.toast.screen_on_sent');
  });

  // Launch Player
  document.getElementById('launchAppBtn')?.addEventListener('click', () => {
    sendWithFeedback('launch', 'Launch', 'device.toast.launch_sent');
  });

  // Force Update
  document.getElementById('forceUpdateBtn')?.addEventListener('click', () => {
    sendWithFeedback('update', 'Update', 'device.toast.update_triggered');
  });

  // #109: PiP overlay tester — pushes/clears an overlay via the public API (POST /api/pip).
  document.getElementById('sendPipBtn')?.addEventListener('click', async () => {
    const uri = (document.getElementById('pipUri')?.value || '').trim();
    if (!uri) { showToast('Enter an overlay URL', 'error'); return; }
    try {
      const res = await api.sendPip(device.id, {
        type: document.getElementById('pipType').value,
        uri,
        position: document.getElementById('pipPosition').value,
        duration: Number(document.getElementById('pipDuration').value) || 0,
      });
      showToast(`Overlay sent (${res.sent} sent, ${res.offline} offline)`, res.sent ? 'success' : 'warning');
    } catch (err) { showToast(err.message, 'error'); }
  });
  document.getElementById('clearPipBtn')?.addEventListener('click', async () => {
    try { await api.clearPip(device.id); showToast('Overlay cleared', 'success'); }
    catch (err) { showToast(err.message, 'error'); }
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
    showToast(t('device.toast.remote_started'), 'info');
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
        opt.textContent = t('device.layout.zones_count', { name: l.name, n: l.zones?.length || 0 });
        if (device.layout_id === l.id) opt.selected = true;
        select.appendChild(opt);
      });
      // Add templates too
      layouts.filter(l => l.is_template).forEach(l => {
        const opt = document.createElement('option');
        opt.value = l.id;
        opt.textContent = t('device.layout.template_zones_count', { name: l.name, n: l.zones?.length || 0 });
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
      showToast(layoutId ? t('device.toast.layout_applied') : t('device.toast.switched_to_fullscreen'), 'success');
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

      // Get layout zones if device has a layout assigned. We track
      // zonesFetchFailed separately so the modal can distinguish "fetch
      // broke" from "fetch succeeded, layout genuinely has no zones" -
      // both end with zones=[] but the user message differs.
      // The !res.ok throw is required because fetch only rejects on network
      // errors; an HTTP 403/404 would otherwise json-parse into {error: ...}
      // and zones would silently be [].
      let zones = [];
      let zonesFetchFailed = false;
      if (device.layout_id) {
        try {
          const res = await fetch(`/api/layouts/${device.layout_id}`, { headers });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const layout = await res.json();
          zones = layout.zones || [];
        } catch (e) {
          console.warn('Failed to load layout for zone picker:', e.message);
          zonesFetchFailed = true;
        }
      }

      if (!content.length && !widgets.length && !kioskPages.length) {
        showToast(t('device.assign.empty_all'), 'error');
        return;
      }

      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.innerHTML = `
        <div class="modal" style="max-width:650px;width:95vw">
          <div class="modal-header">
            <h3>${t('device.assign.modal_title')}</h3>
            <button class="btn-icon" id="closeAssignModal">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label>${t('device.assign.zone_label')}</label>
              ${zones.length > 0 ? `
                <select id="assignZone" class="input" style="background:var(--bg-input)">
                  <option value="">${t('device.assign.zone_default')}</option>
                  ${zones.map(z => `<option value="${z.id}">${z.name} (${Math.round(z.width_percent)}% x ${Math.round(z.height_percent)}%)</option>`).join('')}
                </select>
              ` : !device.layout_id ? `
                <div style="font-size:12px;color:var(--text-muted);padding:6px 0;line-height:1.5">${t('device.assign.zone_no_layout')}</div>
              ` : zonesFetchFailed ? `
                <div style="font-size:12px;color:var(--danger);padding:6px 0;line-height:1.5">${t('device.assign.zone_load_failed')}</div>
              ` : `
                <div style="font-size:12px;color:var(--text-muted);padding:6px 0;line-height:1.5">${t('device.assign.zone_empty_layout')}</div>
              `}
            </div>
            <div class="form-group">
              <label>${t('device.assign.duration_label')}</label>
              <input type="number" id="assignDuration" class="input" value="10" min="1" max="3600">
            </div>
            <!-- Tabs -->
            <div style="display:flex;gap:0;border-bottom:1px solid var(--border);margin-bottom:12px">
              <div class="assign-tab active" data-tab="media" style="padding:8px 16px;font-size:13px;cursor:pointer;border-bottom:2px solid var(--accent);color:var(--accent)">${t('device.assign.tab.media', { n: content.length })}</div>
              <div class="assign-tab" data-tab="widgets" style="padding:8px 16px;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;color:var(--text-secondary)">${t('device.assign.tab.widgets', { n: widgets.length })}</div>
              <div class="assign-tab" data-tab="kiosk" style="padding:8px 16px;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;color:var(--text-secondary)">${t('device.assign.tab.kiosk', { n: kioskPages.length })}</div>
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
                  <div class="assign-content-item-name">${esc(c.filename)}</div>
                </div>
              `).join('') || `<p style="color:var(--text-muted);padding:16px;text-align:center">${t('device.assign.no_media')}</p>`}
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
              }).join('') || `<p style="color:var(--text-muted);padding:16px;text-align:center">${t('device.assign.no_widgets')} <a href="#/widgets" style="color:var(--accent)">${t('device.assign.create_one')}</a></p>`}
            </div>
            <!-- Kiosk grid -->
            <div class="assign-content-grid" id="assignKiosk" style="display:none">
              ${kioskPages.map(k => `
                <div class="assign-content-item" data-content-id="${k.id}" data-type="kiosk">
                  <div style="aspect-ratio:16/9;display:flex;align-items:center;justify-content:center;background:var(--bg-primary);font-size:32px">&#128433;</div>
                  <div class="assign-content-item-name">${k.name}</div>
                </div>
              `).join('') || `<p style="color:var(--text-muted);padding:16px;text-align:center">${t('device.assign.no_kiosk')} <a href="#/kiosk" style="color:var(--accent)">${t('device.assign.create_one')}</a></p>`}
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" id="cancelAssign">${t('common.cancel')}</button>
            <button class="btn btn-primary" id="confirmAssign">${t('device.assign.add_selected')}</button>
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
          showToast(t('device.assign.select_first'), 'error');
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
              body: JSON.stringify({ widget_type: 'webpage', name: t('device.assign.kiosk_widget_name', { name: kioskPages.find(k => k.id === selectedId)?.name || 'Page' }), config: { url: `${serverUrl}/api/kiosk/${selectedId}/render` } })
            });
            const widget = await wRes.json();
            await api.addAssignment(device.id, { widget_id: widget.id, duration_sec: 0 });
          }
          modal.remove();
          showToast(t('device.toast.added_to_playlist'), 'success');
          loadDevice(device.id, 'playlist');
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
  // Populate zone selectors if device has a layout. The current zone_id for
  // each assignment is read from data-current-zone-id on the .zone-select
  // element (stashed at render time from a.zone_id); no DOM-scraping.
  // Fetch errors are logged - the dropdowns simply stay hidden (display:none
  // is the default from the render), same end-state as before but no longer
  // silent.
  if (device.layout_id) {
    const token = localStorage.getItem('token');
    fetch(`/api/layouts/${device.layout_id}`, { headers: { Authorization: `Bearer ${token}` }})
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(layout => {
        const zones = layout.zones || [];
        document.querySelectorAll('.zone-select').forEach(select => {
          select.style.display = '';
          const assignmentId = select.dataset.assignmentId;
          const currentZoneId = select.dataset.currentZoneId || '';
          zones.forEach(z => {
            const opt = document.createElement('option');
            opt.value = z.id;
            opt.textContent = z.name;
            select.appendChild(opt);
          });
          if (currentZoneId) select.value = currentZoneId;
          select.onchange = async () => {
            try {
              await api.updateAssignment(assignmentId, { zone_id: select.value || null });
              showToast(t('device.toast.zone_updated'), 'success');
              loadDevice(device.id, 'playlist');
            } catch (err) { showToast(err.message, 'error'); }
          };
        });
      })
      .catch(e => {
        // No toast - fires once per device-detail load, would be annoying for
        // a layout misconfig that's already surfaced via the modal info row.
        console.warn('Failed to load layout for edit-zone dropdowns:', e.message);
      });
  }

  // Mute toggle buttons
  document.querySelectorAll('.mute-toggle').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.muteAssignment;
      const currentlyMuted = btn.dataset.muted === '1';
      try {
        await api.updateAssignment(id, { muted: !currentlyMuted });
        showToast(currentlyMuted ? t('device.toast.unmuted') : t('device.toast.muted'), 'success');
        loadDevice(device.id, 'playlist');
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
        showToast(t('device.toast.removed_from_playlist'), 'success');
        loadDevice(device.id, 'playlist');
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
        showToast(t('device.toast.playlist_reordered'), 'success');
        loadDevice(device.id, 'playlist');
      } catch (err) {
        showToast(err.message, 'error');
        loadDevice(device.id, 'playlist');
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
  if (percentEl) {
    percentEl.textContent = knownSlots > 0
      ? t('device.timeline.uptime_pct_tracked', { pct: uptimePct, n: knownSlots * 15 })
      : t('device.timeline.uptime_pct_no_data', { pct: uptimePct });
  }

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
    const statusLabel = status === 'unknown' ? t('device.timeline.no_data') : status === 'online' ? t('device.timeline.online') : t('device.timeline.offline');
    return `<div style="flex:1;background:${colors[status]};opacity:${opacities[status]}" title="${label} - ${statusLabel}"></div>`;
  }).join('');
}

function updateTelemetryDisplay(telemetry) {
  const update = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  if (telemetry.battery_level != null) update('telBattery', telemetry.battery_level + '%');
  if (telemetry.storage_free_mb) update('telStorage', t('device.info.size_free', { size: formatBytes(telemetry.storage_free_mb) }));
  if (telemetry.wifi_ssid) update('telWifi', telemetry.wifi_ssid);
  if (telemetry.wifi_rssi) update('telRssi', telemetry.wifi_rssi + ' dBm');
  if (telemetry.uptime_seconds) update('telUptime', formatUptime(telemetry.uptime_seconds));
  if (telemetry.ram_free_mb) update('telRam', t('device.info.size_free', { size: formatBytes(telemetry.ram_free_mb) }));
  if (telemetry.cpu_usage != null) update('telCpu', telemetry.cpu_usage.toFixed(1) + '%');
}

export function cleanup() {
  if (statusHandler) off('device-status', statusHandler);
  if (screenshotHandler) off('screenshot-ready', screenshotHandler);
  if (playbackHandler) off('playback-state', playbackHandler);
  if (logHandler) off('device-log', logHandler);
  if (screenshotInterval) clearInterval(screenshotInterval);
  if (remoteActive && currentDevice) stopRemote(currentDevice.id);
  remoteActive = false;
  currentDevice = null;
  window._sendKey = null;
}
