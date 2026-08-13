import { api } from '../api.js';
import { on, off, requestScreenshot } from '../socket.js';
import { showToast } from '../components/toast.js';
import { esc, livenessBadge, isPlatformAdmin } from '../utils.js';
import { t, tn } from '../i18n.js';
import * as gettingStarted from '../components/getting-started.js';
import { showDeviceOwnerQRModal } from '../components/device-owner-qr-modal.js';
import { frameDeviceOutput } from '../lib/device-frame.js';

const DESTRUCTIVE_COMMANDS = ['reboot', 'shutdown'];
// Command types only — labels resolved through t('dashboard.cmd.<type>')
const GROUP_COMMANDS = [
  { type: 'screen_on' },
  { type: 'screen_off' },
  { type: 'launch' },
  { type: 'update' },
  { type: 'reboot', destructive: true },
  { type: 'shutdown', destructive: true },
];
const CMD_LABEL_KEY = {
  screen_on: 'dashboard.cmd.screen_on',
  screen_off: 'dashboard.cmd.screen_off',
  launch: 'dashboard.cmd.restart_app',
  update: 'dashboard.cmd.check_update',
  reboot: 'dashboard.cmd.reboot',
  shutdown: 'dashboard.cmd.shutdown',
};

let statusHandler = null;
let screenshotHandler = null;
let refreshInterval = null;
let playbackHandler = null;
let progressTickInterval = null;
let wallChangedHandler = null;
// device_id -> { content_name, duration_sec, started_at }
const playbackByDevice = new Map();
// Multi-select state for the "Create Video Wall" gesture. Holds device_ids
// the user has ticked via checkboxes on the dashboard cards.
const selectedDeviceIds = new Set();

function formatTimeAgo(timestamp) {
  if (!timestamp) return t('common.never');
  const seconds = Math.floor(Date.now() / 1000 - timestamp);
  if (seconds < 60) return t('common.just_now');
  if (seconds < 3600) return t('common.minutes_ago', { n: Math.floor(seconds / 60) });
  if (seconds < 86400) return t('common.hours_ago', { n: Math.floor(seconds / 3600) });
  return t('common.days_ago', { n: Math.floor(seconds / 86400) });
}

function formatBytes(mb) {
  if (mb === null || mb === undefined) return '--';
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

function renderProgressFor(deviceId) {
  const state = playbackByDevice.get(deviceId);
  document.querySelectorAll(`#progress-${CSS.escape(deviceId)}`).forEach(el => {
    if (!state) { el.style.display = 'none'; return; }
    const elapsed = Math.max(0, (Date.now() - state.started_at) / 1000);
    const name = state.content_name || '';
    const fill = el.querySelector('.device-card-progress-fill');
    const nameEl = el.querySelector('.dcp-name');
    const timeEl = el.querySelector('.dcp-time');
    if (state.duration_sec && state.duration_sec > 0) {
      const remaining = Math.max(0, Math.ceil(state.duration_sec - elapsed));
      const pct = Math.min(100, (elapsed / state.duration_sec) * 100);
      fill.style.width = pct + '%';
      if (nameEl) nameEl.textContent = name;
      if (timeEl) timeEl.textContent = remaining + 's';
    } else {
      // Unknown duration (e.g. video plays to end) — show indeterminate state
      fill.style.width = '100%';
      fill.classList.add('indeterminate');
      if (nameEl) nameEl.textContent = name;
      if (timeEl) timeEl.textContent = '';
    }
    el.style.display = 'block';
  });
}

// #238: a screenshot is the panel's raw framebuffer, so a device set to 90/270 sends a landscape
// image with the content lying on its side — the wall mount is what turns it upright, and the card
// had no stand-in for the mount. Every portrait screen in the fleet therefore looked wrong at a
// glance on the one screen people scan to check the fleet is fine.
//
// Re-run after any render that replaces card markup; the orientation rides on the card so the
// socket handler can re-frame a single card without re-reading the device list.
function frameCard(stage) {
  const img = stage && stage.querySelector('img');
  if (img) frameDeviceOutput(stage, img, stage.dataset.orientation);
}

function frameCardScreenshots(root) {
  (root || document).querySelectorAll('.device-card-preview[data-orientation]').forEach(frameCard);
}

function renderDeviceCard(device) {
  const token = localStorage.getItem('token');
  const screenshotUrl = device.screenshot_path
    ? `/api/devices/${device.id}/screenshot?t=${device.screenshot_at || ''}&token=${token}`
    : null;

  const checked = selectedDeviceIds.has(device.id);
  // A panel that cannot capture its own screen is not asked to, every 30 seconds, forever. The
  // list now carries the RESOLVED capability set (routes/devices.js), so a device that declares
  // nothing still reads as its platform baseline and keeps being polled exactly as today.
  const canShot = !Array.isArray(device.capabilities) || device.capabilities.includes('remote.screenshot');
  return `
    <div class="device-card${checked ? ' selected' : ''}" draggable="true" data-device-id="${device.id}" data-device-name="${esc(device.name)}" data-can-screenshot="${canShot ? '1' : '0'}" onclick="window.location.hash='/device/${device.id}'">
      <label class="device-card-select" title="${t('dashboard.select_for_wall')}" onclick="event.stopPropagation()">
        <input type="checkbox" class="device-select-cb" data-device-id="${device.id}"${checked ? ' checked' : ''}>
      </label>
      <div class="device-card-preview" id="preview-${device.id}" data-orientation="${esc(device.orientation || 'landscape')}">
        ${screenshotUrl
          ? `<img src="${screenshotUrl}" alt="Screenshot" loading="lazy">`
          : `<div class="no-preview">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                <line x1="8" y1="21" x2="16" y2="21"/>
                <line x1="12" y1="17" x2="12" y2="21"/>
              </svg>
              <span>${t('dashboard.no_preview')}</span>
            </div>`
        }
        <div class="device-card-status is-liveness">
          ${(() => { const b = livenessBadge(device, { short: true }); return `<span class="device-status-badge ${b.state}" data-liveness="${b.state}" data-offline-reason="${esc(b.reason)}"${b.title ? ` title="${esc(b.title)}"` : ''}>${esc(b.label)}</span>`; })()}
        </div>
        ${device.status === 'provisioning' && device.pairing_code ? `
        <div style="position:absolute;bottom:8px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.85);color:#f59e0b;padding:4px 12px;border-radius:6px;font-size:13px;font-weight:600;letter-spacing:2px;font-family:monospace">
          ${device.pairing_code}
        </div>` : ''}
        <div class="device-card-progress" id="progress-${device.id}" style="display:none">
          <div class="device-card-progress-label"><span class="dcp-name"></span><span class="dcp-time"></span></div>
          <div class="device-card-progress-track"><div class="device-card-progress-fill"></div></div>
        </div>
      </div>
      <div class="device-card-body">
        <div class="device-card-name">${esc(device.name)}${device.orphan_count > 0 ? `
          <span class="device-orphan-badge" title="${tn('dashboard.device_orphan_tip', device.orphan_count)}" style="margin-left:6px;display:inline-flex;align-items:center;gap:3px;font-size:11px;color:var(--danger);vertical-align:middle">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>${device.orphan_count}
          </span>` : ''}${device.ota_status === 'manual_update_required' ? `
          <span class="device-ota-badge" title="${esc(t('dashboard.device_ota_stuck', { version: device.ota_target_version || '?', n: device.ota_attempts || 0 }))}" style="margin-left:6px;display:inline-flex;align-items:center;gap:3px;font-size:11px;color:var(--warning);vertical-align:middle">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>update
          </span>` : ''}</div>
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

function renderWallCard(wall) {
  // Compose a tiny grid preview using the wall's actual cols×rows. Each cell
  // is filled (assigned) or hollow (empty slot).
  const cells = [];
  for (let r = 0; r < wall.grid_rows; r++) {
    for (let c = 0; c < wall.grid_cols; c++) {
      const dev = (wall.devices || []).find(d => d.grid_col === c && d.grid_row === r);
      cells.push(`<div class="wall-card-cell${dev ? ' filled' : ''}" title="${dev ? esc(dev.device_name) : '[' + c + ',' + r + ']'}"></div>`);
    }
  }
  const members = wall.devices || [];
  const onlineCount = members.filter(d => d.device_status === 'online').length;
  const allUp = onlineCount === members.length && members.length > 0;
  return `
    <div class="device-card wall-card" data-wall-id="${wall.id}" onclick="window.location.hash='#/wall/${wall.id}'">
      <div class="device-card-preview wall-card-preview">
        <div class="wall-card-grid" style="grid-template-columns:repeat(${wall.grid_cols},1fr);grid-template-rows:repeat(${wall.grid_rows},1fr)">${cells.join('')}</div>
        <div class="device-card-status">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="12" y1="3" x2="12" y2="21"/></svg>
          <span>${wall.grid_cols}×${wall.grid_rows} wall</span>
        </div>
      </div>
      <div class="device-card-body">
        <div class="device-card-name">${esc(wall.name)}</div>
        <div class="device-card-meta">
          <div class="meta-item">${members.length} ${members.length === 1 ? 'tile' : 'tiles'}</div>
          <div class="meta-item" style="color:${allUp ? 'var(--success)' : 'var(--danger, #e5484d)'}">${allUp ? 'all online' : `${onlineCount}/${members.length} online`}</div>
        </div>
        <!-- #235: a wall replaces its members' cards, so without this strip one dead panel of a
             four-panel wall is invisible from the dashboard. Each chip links straight to the
             device page — being in a wall must not cost device-level visibility. -->
        <div class="wall-card-members" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:8px">
          ${members.map(d => `
            <a class="wall-card-member" href="#/device/${esc(d.device_id)}" data-member-device-id="${esc(d.device_id)}" onclick="event.stopPropagation()"
               title="${esc(d.device_name)} — ${esc(d.device_status || 'unknown')}. Open device info & controls"
               style="display:inline-flex;align-items:center;gap:4px;max-width:120px;padding:1px 6px;border:1px solid var(--border);border-radius:10px;font-size:10px;color:var(--text-secondary);text-decoration:none">
              <span class="status-dot ${esc(d.device_status || 'offline')}" style="display:inline-block;flex-shrink:0"></span>
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.device_name)}</span>
            </a>`).join('')}
        </div>
      </div>
    </div>
  `;
}

function getGroupPlaylistLabel(devices, playlists) {
  const playlistMap = new Map((playlists || []).map(p => [p.id, p]));
  const assigned = devices.filter(d => d.playlist_id).map(d => d.playlist_id);
  if (assigned.length === 0) return '';
  const unique = [...new Set(assigned)];
  if (unique.length === 1) {
    const pl = playlistMap.get(unique[0]);
    return pl ? esc(pl.name) : t('dashboard.unknown_playlist');
  }
  return t('dashboard.mixed_playlists');
}

function renderGroupSection(group, devices, playlists) {
  const onlineCount = devices.filter(d => d.status === 'online').length;
  const playlistLabel = getGroupPlaylistLabel(devices, playlists);
  return `
    <div class="group-section" data-group-id="${group.id}" style="margin-bottom:24px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;padding:8px 12px;background:var(--bg-secondary);border-radius:8px;border-left:4px solid ${esc(group.color || '#3B82F6')}">
        <div style="display:flex;align-items:center;gap:10px">
          <strong style="font-size:15px">${esc(group.name)}</strong>
          <span style="color:var(--text-muted);font-size:12px">${tn('dashboard.devices_count', devices.length)} &middot; ${t('dashboard.online_count', { n: onlineCount })}</span>
          ${playlistLabel ? `<span style="font-size:11px;color:var(--text-secondary);background:var(--bg-primary);padding:2px 8px;border-radius:10px">${t('dashboard.playlist_label', { name: playlistLabel })}</span>` : ''}
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          ${devices.length > 0 ? `
          <select class="input group-playlist-select" data-group-id="${group.id}" data-group-name="${esc(group.name)}" style="width:160px;padding:4px 8px;font-size:12px;background:var(--bg-input)">
            <option value="">${t('dashboard.set_playlist_placeholder')}</option>
            ${(playlists || []).map(p => `<option value="${esc(p.id)}">${esc(p.name)}${p.status === 'draft' ? ' ' + t('dashboard.draft_suffix') : ''}</option>`).join('')}
          </select>
          <select class="input group-cmd-select" data-group-id="${group.id}" data-group-name="${esc(group.name)}" data-device-count="${devices.length}" style="width:150px;padding:4px 8px;font-size:12px;background:var(--bg-input)">
            <option value="">${t('dashboard.send_command_placeholder')}</option>
            ${GROUP_COMMANDS.map(c => `<option value="${c.type}" ${c.destructive ? 'style="color:var(--danger)"' : ''}>${t(CMD_LABEL_KEY[c.type])}</option>`).join('')}
          </select>
          ` : ''}
          ${devices.length > 0 ? `
          <label class="group-sync-label" style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--text-secondary);cursor:pointer;white-space:nowrap" title="${esc(t('dashboard.group_sync.hint'))}">
            <input type="checkbox" class="group-sync-cb" data-group-id="${group.id}" ${group.sync_enabled ? 'checked' : ''}> ${t('dashboard.group_sync.label')}
          </label>
          ${group.sync_enabled ? `
          <select class="input group-backend-select" data-group-id="${group.id}" style="width:130px;padding:4px 8px;font-size:12px;background:var(--bg-input)" title="${esc(t('dashboard.group_sync.backend_hint'))}">
            <option value="auto" ${(group.sync_backend || 'auto') === 'auto' ? 'selected' : ''}>${t('dashboard.group_sync.backend_auto')}</option>
            <option value="screentinker" ${group.sync_backend === 'screentinker' ? 'selected' : ''}>${t('dashboard.group_sync.backend_screentinker')}</option>
            <option value="brightsign" ${group.sync_backend === 'brightsign' ? 'selected' : ''}>${t('dashboard.group_sync.backend_brightsign')}</option>
          </select>
          ${group.sync_effective ? `
          <span style="font-size:11px;color:${group.sync_downgraded ? 'var(--warning, #d97706)' : 'var(--text-muted)'};white-space:nowrap"
                title="${esc(group.sync_reason || '')}">${group.sync_downgraded ? '&#9888; ' : ''}${esc(group.sync_effective)}${group.sync_reason ? ' — ' + esc(group.sync_reason) : ''}</span>` : ''}
          <button class="btn group-resync-btn" data-group-id="${group.id}" style="padding:4px 10px;font-size:12px" title="${esc(t('dashboard.group_sync.resync_hint'))}">${t('dashboard.group_sync.resync')}</button>` : ''}
          ` : ''}
          <button class="btn" data-group-manage="${group.id}" style="padding:4px 10px;font-size:12px" title="${t('dashboard.manage_tooltip')}">${t('dashboard.manage')}</button>
          <button class="btn" data-group-delete="${group.id}" style="padding:4px 8px;font-size:12px;color:var(--danger)" title="${t('dashboard.delete_group_tooltip')}">&#x2715;</button>
        </div>
      </div>
      <div class="device-grid">
        ${devices.length > 0 ? devices.map(renderDeviceCard).join('') : `<div style="color:var(--text-muted);font-size:13px;padding:8px 12px">${t('dashboard.no_devices_in_group')}</div>`}
      </div>
    </div>
  `;
}

/*
 * Asks, once, whether this install will share its screen count. Only a platform admin sees it,
 * and only while the decision is genuinely unmade — BOTH answers persist, so it never returns
 * after an update. Re-prompting is how telemetry earns its reputation and gets patched out.
 */
async function renderStatsPrompt(container) {
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  if (!isPlatformAdmin(user)) return;

  let info;
  try { info = await api.adminGetTelemetry(); } catch { return; }
  if (info.state !== 'unasked') return;

  const el = document.createElement('div');
  el.className = 'settings-section';
  el.style.cssText = 'margin-bottom:16px;display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap';
  el.innerHTML = `
    <div style="flex:1;min-width:260px">
      <strong>Help show how widely ScreenTinker is deployed?</strong>
      <p style="color:var(--text-muted);font-size:13px;margin:6px 0 0">
        Because most installs are private, we can't tell how many screens are out there. Sharing
        sends a random ID, the version, and how many screens you run — nothing else, ever.
        You can change this any time in Settings.
      </p>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-primary btn-sm" id="statsYes">Share</button>
      <button class="btn btn-secondary btn-sm" id="statsNo">No thanks</button>
    </div>
  `;
  container.prepend(el);

  const answer = async (enabled) => {
    try { await api.adminSetTelemetry(enabled); } catch { /* leave it unasked; it can ask again later */ return; }
    el.remove();
    if (enabled) showToast('Thank you — sharing install statistics', 'success');
  };
  el.querySelector('#statsYes').addEventListener('click', () => answer(true));
  el.querySelector('#statsNo').addEventListener('click', () => answer(false));
}

export function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>${t('dashboard.title')} <span class="help-tip" data-tip="${t('dashboard.help_tip')}">?</span></h1>
        <div class="subtitle">${t('dashboard.subtitle')}</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn" id="createGroupBtn">${t('dashboard.create_group')}</button>
        <button class="btn btn-primary" id="addDeviceBtn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          ${t('dashboard.add')}
        </button>
      </div>
    </div>
    <div id="selectionBar" style="display:none;align-items:center;gap:10px;padding:8px 12px;margin-bottom:12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px">
      <span id="selectionCount" style="font-weight:500;font-size:13px"></span>
      <button class="btn btn-primary btn-sm" id="createWallBtn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px">
          <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="12" y1="3" x2="12" y2="21"/>
        </svg>
        Create Video Wall
      </button>
      <button class="btn btn-sm" id="clearSelectionBtn">Clear</button>
    </div>
    <div id="gettingStarted"></div>
      <div id="dashStats" class="dash-stats-row" style="display:flex;gap:12px;margin-bottom:16px"></div>
    <div style="display:flex;gap:12px;margin-bottom:16px;align-items:center">
      <input type="text" id="deviceSearch" class="input" placeholder="${t('dashboard.search')}" style="max-width:300px">
      <select id="deviceFilter" class="input" style="width:180px;background:var(--bg-input)">
        <option value="">${t('dashboard.all_status')}</option>
        <option value="healthy">${t('device.liveness.healthy')}</option>
        <option value="degraded">${t('device.liveness.degraded')}</option>
        <option value="offline">${t('device.liveness.offline')}</option>
        <optgroup label="${t('dashboard.filter.offline_by_reason')}">
          <option value="offline:silent">${t('dashboard.filter.offline_silent')}</option>
          <option value="offline:crashed">${t('dashboard.filter.offline_crashed')}</option>
          <option value="offline:clean_exit">${t('dashboard.filter.offline_clean')}</option>
        </optgroup>
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

    const serverUrl = `${window.location.protocol}//${window.location.host}`;
    const el = document.getElementById('addDeviceServerUrl');
    if (el) el.textContent = serverUrl;
    const tvEl = document.getElementById('addDeviceSmartTvUrl');
    if (tvEl) tvEl.textContent = `${serverUrl}/player`;
  });

  // #device-owner: provision a fresh/factory-reset Android panel straight from Add Display.
  document.getElementById('deviceOwnerQrBtn')?.addEventListener('click', () => showDeviceOwnerQRModal());

  // Search and filter
  document.getElementById('deviceSearch').oninput = () => filterDevices();
  document.getElementById('deviceFilter').onchange = () => filterDevices();

  function filterDevices() {
    const search = document.getElementById('deviceSearch').value.toLowerCase();
    // Compare against the liveness STATE ('healthy'|'degraded'|'offline'), NOT the display label:
    // the badge text is now "Healthy"/"Reconnecting"/"Offline", so the old text-vs-'online' compare
    // matched nothing and emptied the list. data-liveness carries the state for a robust match.
    const filter = document.getElementById('deviceFilter').value;    // '' | healthy | degraded | offline | offline:<reason>
    const reasonDrill = filter.startsWith('offline:') ? filter.slice(8) : null; // drill into a manner-of-death
    document.querySelectorAll('.device-card').forEach(card => {
      const name = card.querySelector('.device-card-name')?.textContent.toLowerCase() || '';
      const el = card.querySelector('.device-card-status [data-liveness]');
      const cardState = el?.dataset.liveness || '';
      const cardReason = el?.dataset.offlineReason || '';
      const matchSearch = !search || name.includes(search);
      const matchState = reasonDrill
        ? (cardState === 'offline' && cardReason === reasonDrill)     // Offline drill-in: liveness AND reason (e.g. silent = MDM-killed set)
        : (!filter || cardState === filter);                         // existing three-state filter — unchanged
      card.style.display = (matchSearch && matchState) ? '' : 'none';
    });
  }

  // Setup pairing
  const pairBtn = document.getElementById('pairDeviceBtn');
  pairBtn.onclick = async () => {
    const code = document.getElementById('pairingCodeInput').value.trim();
    const name = document.getElementById('deviceNameInput').value.trim();
    if (!code || code.length !== 6) {
      showToast(t('dashboard.error_pairing_code'), 'error');
      return;
    }
    try {
      await api.pairDevice(code, name || undefined);
      document.getElementById('addDeviceModal').style.display = 'none';
      showToast(t('dashboard.toast.display_paired'), 'success');
      loadDashboard();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // Create group
  container.querySelector('#createGroupBtn').addEventListener('click', async () => {
    const name = prompt(t('dashboard.prompt_group_name'));
    if (!name) return;
    try {
      await api.createGroup(name);
      showToast(t('dashboard.toast.group_created'), 'success');
      loadDashboard();
    } catch (e) { showToast(e.message, 'error'); }
  });

  // Multi-select: a checkbox on each device card adds to selectedDeviceIds.
  // The selection bar shows when 1+ are selected; "Create Video Wall" is the
  // primary action — it creates the wall, removes devices from any group,
  // assigns them, and navigates to the editor.
  container.addEventListener('change', (ev) => {
    const cb = ev.target.closest?.('.device-select-cb');
    if (!cb) return;
    const id = cb.dataset.deviceId;
    if (cb.checked) selectedDeviceIds.add(id); else selectedDeviceIds.delete(id);
    cb.closest('.device-card')?.classList.toggle('selected', cb.checked);
    refreshSelectionBar();
  });

  document.getElementById('clearSelectionBtn').addEventListener('click', () => {
    selectedDeviceIds.clear();
    document.querySelectorAll('.device-select-cb').forEach(cb => { cb.checked = false; });
    document.querySelectorAll('.device-card.selected').forEach(c => c.classList.remove('selected'));
    refreshSelectionBar();
  });

  document.getElementById('createWallBtn').addEventListener('click', () => createWallFromSelection());

  // Load everything
  loadDashboard();

  // Ask once about sharing install statistics. Fire-and-forget: it prepends itself if and only
  // if the decision is still unmade, and a failure here must never affect the dashboard.
  renderStatsPrompt(container).catch(() => {});

  // Real-time updates
  statusHandler = (data) => {
    const b = livenessBadge(data, { short: true }); // list = concise label; tooltip carries the full text
    const cards = document.querySelectorAll(`[data-device-id="${data.device_id}"]`);
    cards.forEach(card => {
      const statusEl = card.querySelector('.device-card-status');
      if (statusEl) statusEl.innerHTML = `<span class="device-status-badge ${b.state}" data-liveness="${b.state}" data-offline-reason="${esc(b.reason)}"${b.title ? ` title="${esc(b.title)}"` : ''}>${esc(b.label)}</span>`;
    });
    // #235: a wall member has no card of its own, only a chip on the wall card. Without this a
    // panel could go offline and the dashboard would keep showing it green until a full reload —
    // exactly the blind spot the issue is about.
    document.querySelectorAll(`.wall-card-member[data-member-device-id="${CSS.escape(data.device_id)}"]`).forEach(chip => {
      const dot = chip.querySelector('.status-dot');
      if (dot) dot.className = `status-dot ${b.state}`;
      chip.title = `${chip.title.split(' — ')[0]} — ${b.label}. Open device info & controls`;
    });
  };

  screenshotHandler = (data) => {
    document.querySelectorAll(`#preview-${data.device_id}`).forEach(preview => {
      const imgSrc = data.image_data || (data.url + '&token=' + localStorage.getItem('token'));
      const img = preview.querySelector('img');
      if (img) {
        img.src = imgSrc;
      } else {
        const statusHtml = preview.querySelector('.device-card-status')?.outerHTML || '';
        preview.innerHTML = `<img src="${imgSrc}" alt="Screenshot" loading="lazy">${statusHtml}`;
      }
      frameCard(preview);   // the branch above can swap the img element out from under us
    });
  };

  const deviceAddedHandler = () => loadDashboard();
  const deviceRemovedHandler = () => loadDashboard();

  playbackHandler = (data) => {
    if (!data?.device_id) return;
    playbackByDevice.set(data.device_id, {
      content_name: data.content_name || '',
      duration_sec: data.duration_sec || null,
      started_at: data.started_at || Date.now(),
    });
    renderProgressFor(data.device_id);
  };

  wallChangedHandler = () => loadDashboard();

  on('device-status', statusHandler);
  on('screenshot-ready', screenshotHandler);
  on('device-added', deviceAddedHandler);
  on('device-removed', deviceRemovedHandler);
  on('playback-progress', playbackHandler);
  on('wall-changed', wallChangedHandler);

  progressTickInterval = setInterval(() => {
    for (const id of playbackByDevice.keys()) renderProgressFor(id);
  }, 1000);

  // Request fresh screenshots on load — from the panels that can actually take one.
  const pollScreenshots = () => {
    document.querySelectorAll('.device-card[data-can-screenshot="1"]').forEach(card => {
      requestScreenshot(card.dataset.deviceId);
    });
  };
  setTimeout(pollScreenshots, 2000);
  refreshInterval = setInterval(pollScreenshots, 30000);
}

function refreshSelectionBar() {
  const bar = document.getElementById('selectionBar');
  const count = document.getElementById('selectionCount');
  if (!bar || !count) return;
  const n = selectedDeviceIds.size;
  if (n === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  // Need at least 2 to make a wall - surface the constraint inline so the
  // greyed-out button isn't just silently unresponsive.
  count.textContent = n < 2
    ? `${n} display selected - pick 1 more to create a wall`
    : `${n} displays selected`;
  const btn = document.getElementById('createWallBtn');
  btn.disabled = n < 2;
  btn.title = n < 2 ? 'Select at least 2 displays to create a video wall' : '';
}

// Pick a sensible default grid for n devices: prefer near-square layouts,
// breaking ties toward more columns (more common physical wall layout).
function defaultGridForCount(n) {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n === 3) return { cols: 3, rows: 1 };
  if (n === 4) return { cols: 2, rows: 2 };
  if (n === 6) return { cols: 3, rows: 2 };
  if (n === 8) return { cols: 4, rows: 2 };
  if (n === 9) return { cols: 3, rows: 3 };
  // Generic fallback — square-ish, columns >= rows
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return { cols, rows };
}

async function createWallFromSelection() {
  const ids = [...selectedDeviceIds];
  if (ids.length < 2) { showToast('Select at least 2 displays', 'error'); return; }
  const name = prompt('Name this video wall:', `Wall ${new Date().toLocaleString()}`);
  if (!name) return;
  const { cols, rows } = defaultGridForCount(ids.length);
  try {
    const wall = await api.createWall({ name, grid_cols: cols, grid_rows: rows });
    // Pack selected devices into row-major order. The user can reposition in
    // the editor; this just gives every selection a sensible starting tile.
    const placement = ids.slice(0, cols * rows).map((id, i) => ({
      device_id: id,
      grid_col: i % cols,
      grid_row: Math.floor(i / cols),
    }));
    await api.setWallDevices(wall.id, placement);
    selectedDeviceIds.clear();
    showToast('Video wall created', 'success');
    window.location.hash = `#/wall/${wall.id}`;
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function loadDashboard() {
  const main = document.getElementById('groupedDevices');
  if (!main) return;

  try {
    const [rawDevices, groups, playlists, walls] = await Promise.all([
      api.getDevices(), api.getGroups(), api.getPlaylists(), api.getWalls(),
    ]);

    // Deduplicate devices by id — a stale reconnect race can briefly cause the same
    // device to appear twice in the list. Last-write-wins keeps the freshest state.
    const seen = new Map();
    for (const d of rawDevices) seen.set(d.id, d);
    const devices = Array.from(seen.values());

    // Getting started. Skipped entirely once put away or finished, so the extra content
    // lookup only ever happens for an account that still has something left to do.
    const gsHost = document.getElementById('gettingStarted');
    if (gsHost && !gettingStarted.isDismissed()) {
      try {
        const content = await api.getContent();
        const state = gettingStarted.computeSteps({ devices, content: content || [], playlists: playlists || [] });
        if (state.complete) gettingStarted.dismiss();   // finished: never costs a fetch again
        gettingStarted.render(gsHost, state, {
          onAction: (a) => {
            if (a === 'add-device') { document.getElementById('addDeviceBtn')?.click(); return true; }
            return false;
          },
        });
      } catch (_) { /* guidance must never break the dashboard */ }
    }

    // Stats
    const online = devices.filter(d => d.status === 'online').length;
    const offline = devices.filter(d => d.status === 'offline').length;
    const provisioning = devices.filter(d => d.status === 'provisioning').length;
    const statsEl = document.getElementById('dashStats');
    if (statsEl) {
      statsEl.innerHTML = `
        <div class="info-card" style="flex:1;min-width:120px">
          <div class="info-card-label">${t('dashboard.total_displays')}</div>
          <div class="info-card-value">${devices.length}</div>
        </div>
        <div class="info-card" style="flex:1;min-width:120px">
          <div class="info-card-label">${t('dashboard.online')}</div>
          <div class="info-card-value" style="color:var(--success)">${online}</div>
        </div>
        <div class="info-card" style="flex:1;min-width:120px">
          <div class="info-card-label">${t('dashboard.offline')}</div>
          <div class="info-card-value" style="color:${offline > 0 ? 'var(--danger)' : 'var(--text-muted)'}">${offline}</div>
        </div>
        ${provisioning > 0 ? `
        <div class="info-card" style="flex:1;min-width:120px">
          <div class="info-card-label">${t('dashboard.awaiting_pairing')}</div>
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
          <h3>${t('dashboard.no_displays')}</h3>
          <p>${t('dashboard.no_displays_desc')}</p>
        </div>
      `;
      return;
    }

    // Devices that belong to a wall are owned by that wall — they don't appear
    // as their own cards anywhere on the dashboard. The wall's card stands in.
    const walledDeviceIds = new Set();
    for (const w of (walls || [])) for (const d of (w.devices || [])) walledDeviceIds.add(d.device_id);
    const dashboardDevices = devices.filter(d => !walledDeviceIds.has(d.id));

    // Fetch group memberships
    const groupsWithDevices = await Promise.all(groups.map(async g => {
      const members = await api.getGroupDevices(g.id);
      const memberIds = new Set(members.map(m => m.id));
      // Use full device data from the main devices list (has telemetry/screenshots)
      // and exclude any wall members.
      const fullDevices = dashboardDevices.filter(d => memberIds.has(d.id));
      return { ...g, devices: fullDevices, memberIds };
    }));

    // Render each device exactly once: the first group it belongs to wins.
    // memberIds is preserved for the Manage modal so multi-group membership info stays accurate.
    const renderedIds = new Set();
    for (const g of groupsWithDevices) {
      g.devices = g.devices.filter(d => {
        if (renderedIds.has(d.id)) return false;
        renderedIds.add(d.id);
        return true;
      });
    }
    const ungrouped = dashboardDevices.filter(d => !renderedIds.has(d.id));

    let html = '';

    // Walls render before groups: they're a higher-level construct (multiple
    // physical screens acting as one logical display).
    if ((walls || []).length > 0) {
      html += `
        <div class="wall-section" style="margin-bottom:24px">
          <div style="display:flex;align-items:center;margin-bottom:10px;padding:8px 12px;background:var(--bg-secondary);border-radius:8px;border-left:4px solid #8b5cf6">
            <strong style="font-size:15px">Video Walls</strong>
            <span style="color:var(--text-muted);font-size:12px;margin-left:10px">${walls.length} wall${walls.length === 1 ? '' : 's'}</span>
          </div>
          <div class="device-grid">${walls.map(renderWallCard).join('')}</div>
        </div>
      `;
    }

    // Render each group with its devices
    for (const g of groupsWithDevices) {
      html += renderGroupSection(g, g.devices, playlists);
    }

    // Render ungrouped devices. The wrapper is tagged data-ungrouped="1" so
    // attachGroupHandlers can wire it as a drop target — dropping a device here
    // removes it from every group it currently belongs to.
    if (ungrouped.length > 0) {
      html += `
        <div class="ungrouped-section" data-ungrouped="1" style="margin-bottom:24px">
          ${groups.length > 0 ? `
          <div style="display:flex;align-items:center;margin-bottom:10px;padding:8px 12px;background:var(--bg-secondary);border-radius:8px;border-left:4px solid var(--text-muted)">
            <strong style="font-size:15px;color:var(--text-muted)">${t('dashboard.ungrouped')}</strong>
            <span style="color:var(--text-muted);font-size:12px;margin-left:10px">${tn('dashboard.devices_count', ungrouped.length)}</span>
          </div>` : ''}
          <div class="device-grid">
            ${ungrouped.map(renderDeviceCard).join('')}
          </div>
        </div>
      `;
    }

    main.innerHTML = html;
    frameCardScreenshots();
    attachGroupHandlers(groupsWithDevices, dashboardDevices);

    // Drop any selections for devices that have since been absorbed into a
    // wall, and update the toolbar.
    for (const id of [...selectedDeviceIds]) {
      if (walledDeviceIds.has(id)) selectedDeviceIds.delete(id);
    }
    refreshSelectionBar();

  } catch (err) {
    main.innerHTML = `<div class="empty-state"><h3>${t('dashboard.failed_to_load')}</h3><p>${esc(err.message)}</p></div>`;
  }
}

function attachGroupHandlers(groupsWithDevices, allDevices) {
  // Drag-and-drop: device cards are draggable; group sections + the Ungrouped
  // wrapper are drop targets. Drop on a group adds membership (mirrors the
  // Manage modal). Drop on Ungrouped removes the device from every group it's
  // currently a member of.
  const groupsByDeviceId = new Map();
  for (const g of groupsWithDevices) {
    g.memberIds.forEach(id => {
      if (!groupsByDeviceId.has(id)) groupsByDeviceId.set(id, []);
      groupsByDeviceId.get(id).push({ id: g.id, name: g.name });
    });
  }

  // #106: within-section drag-to-reorder. Tracks the in-flight drag (which device,
  // and which section it started in) so a CARD-level drop can tell reorder (same
  // section) from group-assign (different section / section background).
  let dragDeviceId = null;
  let dragSectionKey = null;
  const sectionKeyOf = (el) => {
    const g = el.closest('.group-section');
    if (g && g.dataset.groupId) return 'g:' + g.dataset.groupId;
    if (el.closest('[data-ungrouped="1"]')) return 'ungrouped';
    return null;
  };
  const clearDropIndicators = () => document.querySelectorAll('.device-card').forEach(c => { c.style.boxShadow = ''; });

  document.querySelectorAll('.device-card').forEach(card => {
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/device-id', card.dataset.deviceId);
      e.dataTransfer.setData('text/device-name', card.dataset.deviceName || '');
      e.dataTransfer.effectAllowed = 'move';
      dragDeviceId = card.dataset.deviceId;   // #106
      dragSectionKey = sectionKeyOf(card);    // #106
    });
    card.addEventListener('dragend', () => { dragDeviceId = null; dragSectionKey = null; clearDropIndicators(); });

    // #106 within-section reorder. Engages ONLY when the target is another card in the
    // SAME section; otherwise it no-ops and the event bubbles to the section handler
    // (group-assign), leaving the existing behavior untouched.
    card.addEventListener('dragover', (e) => {
      if (!dragDeviceId || dragDeviceId === card.dataset.deviceId) return;
      if (sectionKeyOf(card) !== dragSectionKey) return; // cross-section -> section handles (assign)
      e.preventDefault();
      e.stopPropagation();                    // suppress the section's group-assign dragover/highlight
      e.dataTransfer.dropEffect = 'move';
      const r = card.getBoundingClientRect();
      const before = e.clientX < r.left + r.width / 2;
      card.style.boxShadow = before ? 'inset 3px 0 0 var(--primary)' : 'inset -3px 0 0 var(--primary)';
    });
    card.addEventListener('dragleave', () => { card.style.boxShadow = ''; });
    card.addEventListener('drop', async (e) => {
      if (!dragDeviceId || dragDeviceId === card.dataset.deviceId) return;
      if (sectionKeyOf(card) !== dragSectionKey) return; // cross-section -> bubble to section (assign)
      e.preventDefault();
      e.stopPropagation();                    // CRITICAL: stop the section's group-assign drop also firing
      const r = card.getBoundingClientRect();
      const before = e.clientX < r.left + r.width / 2;
      clearDropIndicators();
      const grid = card.closest('.device-grid');
      if (!grid) return;
      const ids = Array.from(grid.querySelectorAll('.device-card')).map(c => c.dataset.deviceId).filter(Boolean);
      const from = ids.indexOf(dragDeviceId);
      if (from === -1) return;
      ids.splice(from, 1);
      let to = ids.indexOf(card.dataset.deviceId);
      if (!before) to += 1;
      ids.splice(to, 0, dragDeviceId);
      try {
        await api.reorderDevices(ids);
        loadDashboard();
      } catch (err) { showToast(err.message, 'error'); }
    });
  });

  function highlightOn(el) { el.style.outline = '2px solid var(--primary)'; el.style.outlineOffset = '2px'; }
  function highlightOff(el) { el.style.outline = ''; el.style.outlineOffset = ''; }

  document.querySelectorAll('.group-section').forEach(section => {
    section.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('text/device-id')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      highlightOn(section);
    });
    section.addEventListener('dragleave', (e) => {
      // Avoid flicker when moving across child elements
      if (e.target === section) highlightOff(section);
    });
    section.addEventListener('drop', async (e) => {
      e.preventDefault();
      highlightOff(section);
      const deviceId = e.dataTransfer.getData('text/device-id');
      const deviceName = e.dataTransfer.getData('text/device-name') || 'this device';
      if (!deviceId) return;
      const groupId = section.dataset.groupId;
      const targetGroup = groupsWithDevices.find(g => g.id === groupId);
      if (!targetGroup) return;
      // Already in this group — no-op.
      if (targetGroup.memberIds.has(deviceId)) {
        showToast(t('dashboard.toast.already_in_group', { name: deviceName, group: targetGroup.name }), 'info');
        return;
      }
      // Dragging a screen onto a group MOVES it. This used to borrow the Manage modal's
      // "add it too?" confirm and then only add — so the screen ended up in both groups while the
      // toast claimed it had moved, the page still showed the old group, and a second attempt said
      // "already in group 2". Reported by a customer doing exactly that with two screens.
      // The Manage modal keeps add/remove checkboxes: multi-group membership is deliberate THERE.
      // It is not deliberate here, and it is not harmless — deviceSyncGroup() picks arbitrarily
      // when a device is in several sync-enabled groups, so a half-move leaves sync ambiguous.
      const others = groupsByDeviceId.get(deviceId) || [];
      if (others.length > 0) {
        if (!confirm(t('dashboard.confirm_move_to_group', {
          name: deviceName, groups: others.map(g => g.name).join(', '), target: targetGroup.name,
        }))) return;
      }
      try {
        // Add first, then drop the old memberships: if the add fails the screen keeps the group it
        // had rather than being left ungrouped by a half-finished move.
        await api.addDeviceToGroup(groupId, deviceId);
        for (const g of others) {
          if (g.id === groupId) continue;
          try { await api.removeDeviceFromGroup(g.id, deviceId); }
          catch (e) { showToast(t('dashboard.toast.move_partial', { group: g.name }), 'warning'); }
        }
        showToast(t('dashboard.toast.moved_device', { name: deviceName, group: targetGroup.name }), 'success');
        loadDashboard();
      } catch (err) { showToast(err.message, 'error'); }
    });
  });

  // Ungrouped wrapper: remove device from every group it's in.
  document.querySelectorAll('[data-ungrouped="1"]').forEach(section => {
    section.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('text/device-id')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      highlightOn(section);
    });
    section.addEventListener('dragleave', (e) => {
      if (e.target === section) highlightOff(section);
    });
    section.addEventListener('drop', async (e) => {
      e.preventDefault();
      highlightOff(section);
      const deviceId = e.dataTransfer.getData('text/device-id');
      const deviceName = e.dataTransfer.getData('text/device-name') || 'this device';
      if (!deviceId) return;
      const memberships = groupsByDeviceId.get(deviceId) || [];
      if (memberships.length === 0) return; // already ungrouped
      try {
        await Promise.all(memberships.map(m => api.removeDeviceFromGroup(m.id, deviceId)));
        showToast(tn('dashboard.toast.removed_device', memberships.length, { name: deviceName }), 'success');
        loadDashboard();
      } catch (err) { showToast(err.message, 'error'); }
    });
  });

  // Playlist assignment handlers
  document.querySelectorAll('.group-playlist-select').forEach(select => {
    select.addEventListener('change', async (e) => {
      const playlistId = e.target.value;
      if (!playlistId) return;
      const groupId = e.target.dataset.groupId;
      const groupName = e.target.dataset.groupName;
      const playlistName = e.target.options[e.target.selectedIndex].textContent;

      if (!confirm(t('dashboard.confirm_assign_playlist', { playlist: playlistName, group: groupName }))) {
        e.target.value = '';
        return;
      }

      try {
        const result = await api.groupAssignPlaylist(groupId, playlistId);
        showToast(tn('dashboard.toast.playlist_assigned', result.devices_updated), 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
      e.target.value = '';
    });
  });

  // #group-sync: toggle synchronized playback for a group.
  document.querySelectorAll('.group-sync-cb').forEach(cb => {
    cb.addEventListener('change', async (e) => {
      const groupId = e.target.dataset.groupId;
      const enabled = e.target.checked;
      try {
        await api.updateGroup(groupId, { sync_enabled: enabled });
        showToast(enabled ? t('dashboard.group_sync.toast_on') : t('dashboard.group_sync.toast_off'), 'success');
        loadDashboard(); // re-render so the Resync button shows/hides
      } catch (err) {
        showToast(err.message, 'error');
        e.target.checked = !enabled;
      }
    });
  });

  // Choose the sync protocol. The server may refuse the choice (native sync needs every member to
  // be a BrightSign on one L2 network), so re-render from its answer rather than assuming the
  // request took — showing a setting that isn't in force is exactly what makes a drifting wall
  // impossible to diagnose.
  document.querySelectorAll('.group-backend-select').forEach(sel => {
    sel.addEventListener('change', async (e) => {
      const groupId = e.target.dataset.groupId;
      const previous = sel.dataset.previous || 'auto';
      const chosen = e.target.value;
      try {
        const updated = await api.updateGroup(groupId, { sync_backend: chosen });
        if (updated?.sync_downgraded && updated?.sync_reason) {
          showToast(t('dashboard.group_sync.toast_downgraded') + ' ' + updated.sync_reason, 'warning');
        } else {
          showToast(t('dashboard.group_sync.toast_backend'), 'success');
        }
        loadDashboard();
      } catch (err) {
        showToast(err.message, 'error');
        e.target.value = previous;
      }
    });
    sel.dataset.previous = sel.value;
  });

  // #group-sync: manual "Resync now" — nudge all members to re-snap to the shared schedule.
  document.querySelectorAll('.group-resync-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const groupId = e.currentTarget.dataset.groupId;
      try {
        await api.resyncGroup(groupId);
        showToast(t('dashboard.group_sync.toast_resync'), 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  // Command select handlers
  document.querySelectorAll('.group-cmd-select').forEach(select => {
    select.addEventListener('change', async (e) => {
      const type = e.target.value;
      if (!type) return;
      const groupId = e.target.dataset.groupId;
      const groupName = e.target.dataset.groupName;
      const count = e.target.dataset.deviceCount;
      const cmdLabel = t(CMD_LABEL_KEY[type] || type);

      if (DESTRUCTIVE_COMMANDS.includes(type)) {
        if (!confirm(t('dashboard.confirm_destructive_command', { cmd: cmdLabel.toUpperCase(), n: count, group: groupName }))) {
          e.target.value = '';
          return;
        }
      }

      try {
        const result = await api.sendGroupCommand(groupId, type);
        // A group is routinely mixed-platform, so these buttons stay visible — "reboot" is
        // meaningful for the Android panels in the group even when the web players in it can
        // never honour it. What must not happen is the toast counting those as sent: the
        // operator would walk away believing the whole group rebooted.
        let msg = result.offline > 0
          ? t('dashboard.toast.command_sent_with_offline', { cmd: cmdLabel, sent: result.sent, total: result.total, offline: result.offline })
          : t('dashboard.toast.command_sent', { cmd: cmdLabel, sent: result.sent, total: result.total });
        if (result.unsupported > 0) {
          msg += ' ' + t('dashboard.toast.command_unsupported_n', { n: result.unsupported });
        }
        showToast(msg, (result.offline > 0 || result.unsupported > 0) ? 'warning' : 'success');
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
      if (!confirm(t('dashboard.confirm_delete_group'))) return;
      try {
        await api.deleteGroup(id);
        showToast(t('dashboard.toast.group_deleted'), 'success');
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
          <p style="margin:0 0 16px;font-size:12px;color:var(--text-muted)">${t('dashboard.manage_group_subtitle')}</p>
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
            <button class="btn" id="manageGroupClose">${t('common.done')}</button>
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
          const cbName = cb.closest('label')?.querySelector('span:not(.status-dot)')?.textContent || '';
          try {
            if (cb.checked && existingGroups) {
              if (!confirm(t('dashboard.confirm_add_to_group', { name: cbName, groups: existingGroups, target: group.name }))) {
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
  if (playbackHandler) off('playback-progress', playbackHandler);
  if (wallChangedHandler) off('wall-changed', wallChangedHandler);
  off('device-added', () => {});
  off('device-removed', () => {});
  if (refreshInterval) clearInterval(refreshInterval);
  if (progressTickInterval) clearInterval(progressTickInterval);
  statusHandler = null;
  screenshotHandler = null;
  playbackHandler = null;
  wallChangedHandler = null;
  refreshInterval = null;
  progressTickInterval = null;
  playbackByDevice.clear();
}
