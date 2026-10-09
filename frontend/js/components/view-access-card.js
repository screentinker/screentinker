import { api } from '../api.js';
import { showToast } from './toast.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';

/*
 * View-only access for one display (server lib/view-access.js). Off by default. Workspace admins get
 * the switch, the share link and the network list; everyone else sees whether it is on. Hidden
 * entirely when the server has the feature turned off (VIEW_ONLY_ENABLED=false).
 */
export async function setupViewAccess(device) {
  const host = document.getElementById('viewAccessCard');
  if (!host) return;
  let state;
  try { state = await api.getViewAccess(device.id); } catch { return; }
  if (!state || !state.available) { host.innerHTML = ''; return; }

  const copy = (sel) => {
    const el = host.querySelector(sel);
    el.select();
    // execCommand, as for the web player URL: plain-HTTP self-hosted dashboards have no async clipboard.
    try { document.execCommand('copy'); showToast(t('device.view.copied')); }
    catch { showToast(t('device.view.copy_failed'), 'error'); }
  };

  const draw = () => {
    const head = `<h4 style="font-size:13px;margin-bottom:4px">${t('device.view.title')}</h4>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;max-width:70ch">${t('device.view.hint')}</div>`;
    if (!state.can_admin) {
      host.innerHTML = `<div style="margin-top:20px">${head}
        <div style="font-size:12px">${state.enabled ? t('device.view.status_on') : t('device.view.status_off')}
        <span style="color:var(--text-muted)">${t('device.view.admin_only')}</span></div></div>`;
      return;
    }
    host.innerHTML = `<div style="margin-top:20px">${head}
      <label style="display:flex;gap:8px;align-items:center;font-size:13px;cursor:pointer">
        <input type="checkbox" id="viewEnabled" ${state.enabled ? 'checked' : ''}> ${t('device.view.enable')}
      </label>
      ${state.enabled ? `
      <div style="margin-top:12px">
        <div style="font-size:12px;font-weight:600;margin-bottom:4px">${t('device.view.link')}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <input class="input" id="viewShareUrl" readonly value="${esc(state.share_url || '')}" style="flex:1;min-width:260px;font-family:monospace;font-size:11px">
          <button class="btn btn-secondary btn-sm" id="viewCopyBtn">${t('device.view.copy')}</button>
          <button class="btn btn-secondary btn-sm" id="viewRegenBtn">${t('device.view.regenerate')}</button>
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('device.view.link_hint')}</div>
      </div>
      <div style="margin-top:12px">
        <div style="font-size:12px;font-weight:600;margin-bottom:4px">${t('device.view.networks')}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">${t('device.view.networks_hint')}</div>
        <textarea class="input" id="viewCidrs" rows="3" spellcheck="false" style="width:100%;max-width:420px;font-family:monospace;font-size:12px">${esc((state.cidrs || []).join('\n'))}</textarea>
        <div id="viewCidrError" style="font-size:12px;color:var(--danger);margin-top:4px"></div>
        <button class="btn btn-secondary btn-sm" id="viewCidrSave" style="margin-top:6px">${t('device.view.networks_save')}</button>
        ${state.network_url ? `
        <div style="font-size:12px;font-weight:600;margin:10px 0 4px">${t('device.view.network_url')}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <input class="input" id="viewNetUrl" readonly value="${esc(state.network_url)}" style="flex:1;min-width:260px;font-family:monospace;font-size:11px">
          <button class="btn btn-secondary btn-sm" id="viewNetCopyBtn">${t('device.view.copy')}</button>
        </div>
        ${state.trusted_proxies_configured ? '' : `<div style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('device.view.proxy_note')}</div>`}` : ''}
      </div>` : ''}
    </div>`;

    host.querySelector('#viewEnabled').addEventListener('change', async (e) => {
      const on = e.target.checked;
      try {
        state = await api.updateViewAccess(device.id, { enabled: on });
        showToast(on ? t('device.view.turned_on') : t('device.view.turned_off'));
      } catch (err) { showToast(err.message, 'error'); }
      draw();
    });
    if (!state.enabled) return;
    host.querySelector('#viewCopyBtn').addEventListener('click', () => copy('#viewShareUrl'));
    host.querySelector('#viewRegenBtn').addEventListener('click', async () => {
      if (!confirm(t('device.view.confirm_regenerate'))) return;
      try { state = await api.regenerateViewLink(device.id); showToast(t('device.view.regenerated')); draw(); }
      catch (err) { showToast(err.message, 'error'); }
    });
    host.querySelector('#viewCidrSave').addEventListener('click', async () => {
      const errEl = host.querySelector('#viewCidrError');
      errEl.textContent = '';
      try {
        state = await api.updateViewAccess(device.id, { cidrs: host.querySelector('#viewCidrs').value });
        showToast(t('device.view.networks_saved'));
        draw();
      } catch (err) { errEl.textContent = err.message; }
    });
    const net = host.querySelector('#viewNetCopyBtn');
    if (net) net.addEventListener('click', () => copy('#viewNetUrl'));
  };
  draw();
}
