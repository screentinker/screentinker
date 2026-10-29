/*
 * #720 The Wi-Fi networks of a screen, on the device page (Controls tab).
 *
 * ⚠️ THE PASSWORD IS WRITE-ONLY. The server never sends it back (rows carry has_password), so this
 * form never shows one: an edit leaves the field empty, and an empty field means "keep the stored
 * password" (server/lib/device-wifi.js normaliseInput). Do not pre-fill it with a mask either — a
 * mask at the real length tells anyone looking over a shoulder how long the password is.
 *
 * The words follow what the player can actually do (`mode`, from device_info.wifi_mode): in
 * suggestions mode Android may decline a network, so the section says "suggested, not enforced"
 * rather than promising a connection. A refusal to deliver (no HTTPS) is said with what to change.
 */
import { api } from '../api.js';
import { t } from '../i18n.js';
import { showToast } from './toast.js';
import { on, off } from '../socket.js';
import { canWrite } from '../utils.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const STATUS_TONE = {
  applied: 'var(--success)', suggested: 'var(--success)', sent: 'var(--text-muted)', pending: 'var(--text-muted)',
  deferred: 'var(--warning)', unsupported: 'var(--warning)', failed: 'var(--danger)', not_delivered: 'var(--danger)',
};
const STATUSES = Object.keys(STATUS_TONE);
// Reason codes the server and the player send (lib/device-wifi.js, WifiManagerPolicy on the player).
const REASONS = ['insecure_connection', 'password_unreadable', 'connected_network_in_use', 'wpa3_needs_android_10',
  'hidden_needs_android_11', 'rejected_by_android', 'permission_denied', 'not_device_owner', 'wifi_off'];

function statusChip(n) {
  const status = STATUSES.includes(n.status) ? n.status : 'pending';
  const reason = n.status_reason
    ? (REASONS.includes(n.status_reason) ? t(`wifi.reason.${n.status_reason}`) : n.status_reason)
    : '';
  return `<span style="font-size:11px;color:${STATUS_TONE[status]}">${esc(t(`wifi.status.${status}`))}</span>`
    + (reason ? `<div style="font-size:11px;color:var(--text-muted)">${esc(reason)}</div>` : '');
}

function modeNote(mode) {
  if (!mode) return '';
  return `<div style="font-size:12px;color:${mode === 'suggestions' || mode === 'unsupported' ? 'var(--warning)' : 'var(--text-muted)'};margin-bottom:8px">${esc(t(`wifi.mode.${mode}`))}</div>`;
}

function connectionNote(c) {
  if (!c) return '';
  if (c.allow_insecure) {
    return `<div style="font-size:12px;color:var(--warning);margin-bottom:8px">${esc(t('wifi.insecure_allowed'))}</div>`;
  }
  if (c.online && c.tls === false) {
    return `<div style="font-size:12px;color:var(--danger);margin-bottom:8px;line-height:1.45">${esc(t('wifi.not_https'))}</div>`;
  }
  return '';
}

function formHtml(n) {
  const sec = n ? n.security : 'wpa2';
  return `
    <div class="wifi-form" style="display:grid;grid-template-columns:130px 1fr;gap:10px 14px;align-items:center;font-size:13px;max-width:480px;margin-top:10px">
      <label for="wifiSsid">${esc(t('wifi.ssid'))}</label>
      <input id="wifiSsid" class="input" maxlength="32" autocomplete="off" value="${esc(n ? n.ssid : '')}">
      <label for="wifiSecurity">${esc(t('wifi.security'))}</label>
      <select id="wifiSecurity" class="input" style="background:var(--bg-input);max-width:200px">
        ${['wpa2', 'wpa3', 'open'].map((s) => `<option value="${s}" ${s === sec ? 'selected' : ''}>${esc(t(`wifi.security_${s}`))}</option>`).join('')}
      </select>
      <label for="wifiPassword">${esc(t('wifi.password'))}</label>
      <input id="wifiPassword" class="input" type="password" autocomplete="new-password" maxlength="64"
        placeholder="${esc(n && n.has_password ? t('wifi.password_keep') : '')}" ${sec === 'open' ? 'disabled' : ''}>
      <label for="wifiPriority">${esc(t('wifi.priority'))}</label>
      <input id="wifiPriority" class="input" type="number" min="0" max="100" step="1" style="max-width:100px" value="${n && n.priority != null ? n.priority : ''}">
      <span></span>
      <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="wifiHidden" ${n && n.hidden ? 'checked' : ''}> ${esc(t('wifi.hidden'))}</label>
      <span></span>
      <div style="display:flex;gap:6px">
        <button class="btn btn-primary btn-sm" id="wifiSave">${esc(t('wifi.save'))}</button>
        <button class="btn btn-secondary btn-sm" id="wifiCancel">${esc(t('wifi.cancel'))}</button>
      </div>
    </div>`;
}

function listHtml(state, editing, canEdit) {
  const rows = state.networks.map((n) => `
    <tr>
      <td style="padding:4px 8px 4px 0">${esc(n.ssid)}${n.hidden ? ` <span style="font-size:11px;color:var(--text-muted)">(${esc(t('wifi.hidden_short'))})</span>` : ''}</td>
      <td style="padding:4px 8px;font-size:12px;color:var(--text-muted)">${esc(t(`wifi.security_${n.security}`))}${n.priority != null ? ` · ${esc(t('wifi.priority_short', { n: n.priority }))}` : ''}</td>
      <td style="padding:4px 8px">${statusChip(n)}</td>
      <td style="padding:4px 0;white-space:nowrap;text-align:right">${canEdit ? `
        <button class="btn btn-secondary btn-sm wifi-edit" data-id="${esc(n.id)}">${esc(t('wifi.edit'))}</button>
        <button class="btn btn-secondary btn-sm wifi-remove" data-id="${esc(n.id)}" style="color:var(--danger)">${esc(t('wifi.remove'))}</button>` : ''}</td>
    </tr>`).join('');
  return `
    ${modeNote(state.mode)}
    ${connectionNote(state.connection)}
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;line-height:1.45">${esc(t('wifi.intro'))}</div>
    ${state.networks.length
    ? `<table style="border-collapse:collapse;font-size:13px;width:100%;max-width:640px"><tbody>${rows}</tbody></table>`
    : `<div style="font-size:13px;color:var(--text-muted)">${esc(t('wifi.empty'))}</div>`}
    ${canEdit && editing === null ? `<button class="btn btn-secondary btn-sm" id="wifiAdd" style="margin-top:10px">${esc(t('wifi.add'))}</button>` : ''}
    ${editing !== null ? formHtml(editing === 'new' ? null : state.networks.find((n) => n.id === editing)) : ''}`;
}

function deliveryToast(delivery) {
  if (delivery === 'delivered') return showToast(t('wifi.saved_delivered'), 'success');
  if (delivery === 'offline') return showToast(t('wifi.saved_offline'), 'success');
  if (delivery === 'insecure') return showToast(t('wifi.saved_insecure'), 'error');
  if (delivery === 'password_unreadable') return showToast(t('wifi.reason.password_unreadable'), 'error');
  return showToast(t('wifi.saved'), 'success');
}

/**
 * Fill `host` with the section for `device`. A workspace viewer sees the list without the buttons
 * (the server refuses their writes anyway). Returns a dispose function for the page's cleanup().
 */
export function mountWifiNetworks(host, device) {
  const canEdit = canWrite();
  let state = null;
  let editing = null; // null | 'new' | network id

  async function load() {
    try {
      state = await api.deviceWifi(device.id);
      draw();
    } catch (err) {
      host.textContent = err.message;
    }
  }

  function draw() {
    host.innerHTML = listHtml(state, editing, canEdit);
    bind();
  }

  function bind() {
    host.querySelector('#wifiAdd')?.addEventListener('click', () => { editing = 'new'; draw(); });
    host.querySelectorAll('.wifi-edit').forEach((b) => b.addEventListener('click', () => { editing = b.getAttribute('data-id'); draw(); }));
    host.querySelectorAll('.wifi-remove').forEach((b) => b.addEventListener('click', async () => {
      const n = state.networks.find((x) => x.id === b.getAttribute('data-id'));
      if (!n || !confirm(t('wifi.confirm_remove', { ssid: n.ssid }))) return;
      try {
        const r = await api.deleteDeviceWifiNetwork(device.id, n.id);
        deliveryToast(r.delivery);
        await load();
      } catch (err) { showToast(err.message, 'error'); }
    }));
    const sec = host.querySelector('#wifiSecurity');
    sec?.addEventListener('change', () => {
      const pw = host.querySelector('#wifiPassword');
      pw.disabled = sec.value === 'open';
      if (pw.disabled) pw.value = '';
    });
    host.querySelector('#wifiCancel')?.addEventListener('click', () => { editing = null; draw(); });
    host.querySelector('#wifiSave')?.addEventListener('click', async () => {
      const prio = host.querySelector('#wifiPriority').value.trim();
      const body = {
        ssid: host.querySelector('#wifiSsid').value,
        security: sec.value,
        hidden: host.querySelector('#wifiHidden').checked,
        priority: prio === '' ? null : Number(prio),
      };
      const pw = host.querySelector('#wifiPassword').value;
      if (pw) body.password = pw; // empty = keep the stored one
      try {
        const r = editing === 'new'
          ? await api.addDeviceWifiNetwork(device.id, body)
          : await api.updateDeviceWifiNetwork(device.id, editing, body);
        editing = null;
        deliveryToast(r.delivery);
        await load();
      } catch (err) { showToast(err.message, 'error'); }
    });
  }

  // The player's report arrives a moment after a save; redraw unless a form is open.
  const onResult = (data) => { if (data && data.device_id === device.id && editing === null) load(); };
  on('wifi-result', onResult);
  load();
  return () => off('wifi-result', onResult);
}
