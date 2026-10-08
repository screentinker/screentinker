import { showToast } from '../components/toast.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';

/*
 * Audience (lib/audience.js, docs/audience-counting.md): opt-in, on-device people counting.
 *
 * One page for the whole feature, on purpose: the privacy model, the organization's switch, which
 * screens count, and the report. Someone deciding whether to turn cameras on should not have to
 * find the explanation in a different place from the switch.
 */

const API = (url, opts = {}) => fetch('/api' + url, {
  ...opts,
  headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
}).then(async (r) => {
  if (r.status === 401) { localStorage.removeItem('token'); window.location.reload(); throw new Error('Session expired'); }
  if (!r.ok) { const e = await r.json().catch(() => ({})); const err = new Error(e.error || `Request failed (${r.status})`); err.code = e.code; throw err; }
  return r.json();
});

const fmtNum = (n) => Number(n || 0).toLocaleString();
const fmtSec = (s) => {
  const v = Number(s) || 0;
  return v < 60 ? `${v.toFixed(v < 10 ? 1 : 0)}s` : `${Math.floor(v / 60)}m ${Math.round(v % 60)}s`;
};

export async function render(container) {
  const today = new Date();
  const monthAgo = new Date(today); monthAgo.setDate(monthAgo.getDate() - 30);
  container.innerHTML = `
    <div class="page-header">
      <div><h1>${t('audience.title')}</h1><div class="subtitle">${t('audience.subtitle')}</div></div>
    </div>

    <div class="settings-section" id="audPrivacy">
      <h3 style="font-size:14px;margin-bottom:6px">${t('audience.privacy_heading')}</h3>
      <ul style="margin:0 0 0 18px;padding:0;font-size:13px;line-height:1.6;color:var(--text-secondary)">
        <li>${t('audience.privacy_1')}</li>
        <li>${t('audience.privacy_2')}</li>
        <li>${t('audience.privacy_3')}</li>
        <li>${t('audience.privacy_4')}</li>
      </ul>
      <div style="font-size:12px;color:var(--text-muted);margin-top:8px">${t('audience.privacy_notice_hint')}</div>
    </div>

    <div class="settings-section" id="audSettings" style="margin-top:16px"></div>
    <div class="settings-section" id="audScreens" style="margin-top:16px"></div>

    <div class="settings-section" style="margin-top:16px">
      <h3 style="font-size:14px;margin-bottom:10px">${t('audience.report_heading')}</h3>
      <div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;align-items:flex-end">
        <div class="form-group" style="margin:0"><label>${t('report.start_date')}</label>
          <input type="date" id="audStart" class="input" value="${monthAgo.toISOString().split('T')[0]}"></div>
        <div class="form-group" style="margin:0"><label>${t('report.end_date')}</label>
          <input type="date" id="audEnd" class="input" value="${today.toISOString().split('T')[0]}"></div>
        <button class="btn btn-primary btn-sm" id="audLoad">${t('report.load_report')}</button>
        <button class="btn btn-secondary btn-sm" id="audCsv">${t('report.export_csv')}</button>
      </div>
      <div id="audReport"></div>
    </div>`;

  document.getElementById('audLoad').onclick = loadReport;
  document.getElementById('audCsv').onclick = downloadCsv;
  await loadSettings();
  loadReport();
}

let settings = null;

async function loadSettings() {
  const box = document.getElementById('audSettings');
  try { settings = await API('/audience/settings'); } catch (e) { box.innerHTML = `<p style="color:var(--text-muted)">${esc(e.message)}</p>`; return; }
  const s = settings;
  const dis = s.can_manage ? '' : 'disabled';
  box.innerHTML = `
    <h3 style="font-size:14px;margin-bottom:6px">${t('audience.org_heading')}</h3>
    ${s.can_manage ? '' : `<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">${t('audience.org_admin_only')}</div>`}
    <label style="display:flex;gap:8px;align-items:center;font-size:13px;margin-bottom:10px">
      <input type="checkbox" id="audAllowed" ${s.allowed ? 'checked' : ''} ${dis}> <strong>${t('audience.allow')}</strong>
    </label>
    <div style="display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));max-width:760px">
      <label style="display:flex;gap:8px;align-items:center;font-size:13px">
        <input type="checkbox" id="audIndicator" ${s.show_indicator ? 'checked' : ''} ${dis}> ${t('audience.indicator')}
      </label>
      <div class="form-group" style="margin:0"><label>${t('audience.fps')}</label>
        <input type="number" class="input" id="audFps" min="${s.limits.fps[0]}" max="${s.limits.fps[1]}" value="${s.fps}" ${dis}></div>
      <div class="form-group" style="margin:0"><label>${t('audience.min_dwell')}</label>
        <input type="number" class="input" id="audDwell" min="${s.limits.min_dwell_ms[0] / 1000}" max="${s.limits.min_dwell_ms[1] / 1000}" step="0.5" value="${s.min_dwell_ms / 1000}" ${dis}></div>
      <div class="form-group" style="margin:0"><label>${t('audience.retention')}</label>
        <input type="number" class="input" id="audRetention" min="${s.limits.retention_days[0]}" max="${s.limits.retention_days[1]}" value="${s.retention_days}" ${dis}></div>
    </div>
    ${s.can_manage ? `<div style="margin-top:10px"><button class="btn btn-primary btn-sm" id="audSave">${t('audience.save')}</button></div>` : ''}`;
  document.getElementById('audSave')?.addEventListener('click', saveSettings);
  loadScreens();
}

async function saveSettings() {
  const allowed = document.getElementById('audAllowed').checked;
  if (allowed && !settings.allowed && !confirm(t('audience.confirm_allow'))) return;
  const body = {
    allowed,
    show_indicator: document.getElementById('audIndicator').checked,
    fps: Number(document.getElementById('audFps').value),
    min_dwell_ms: Math.round(Number(document.getElementById('audDwell').value) * 1000),
    retention_days: Number(document.getElementById('audRetention').value),
  };
  try {
    settings = await API('/audience/settings', { method: 'PUT', body: JSON.stringify(body) });
    showToast(t('audience.saved'), 'success');
    loadSettings();
  } catch (e) { showToast(e.message, 'error'); }
}

async function loadScreens() {
  const box = document.getElementById('audScreens');
  let data;
  try { data = await API('/audience/screens'); } catch (e) { box.innerHTML = `<p style="color:var(--text-muted)">${esc(e.message)}</p>`; return; }
  const manage = settings && settings.can_manage;
  const off = !(settings && settings.allowed);
  const row = (kind, x, extra) => `
    <tr style="border-bottom:1px solid var(--border)">
      <td style="padding:8px">${esc(x.name || x.id)}</td>
      <td style="padding:8px;color:var(--text-muted);font-size:12px">${extra}</td>
      <td style="padding:8px;text-align:right">
        <label style="display:inline-flex;gap:6px;align-items:center;font-size:13px">
          <input type="checkbox" data-aud-kind="${kind}" data-aud-id="${esc(x.id)}" ${x.enabled ? 'checked' : ''} ${manage && !off ? '' : 'disabled'}>
          ${t('audience.count_here')}
        </label>
      </td>
    </tr>`;
  const devStatus = (d) => {
    if (d.counting) return `<span style="color:var(--success,#15803d)">● ${t('audience.state_counting')}</span>`;
    if (!d.camera_capable) return t('audience.state_no_camera');
    return t('audience.state_off');
  };
  box.innerHTML = `
    <h3 style="font-size:14px;margin-bottom:6px">${t('audience.screens_heading')}</h3>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">${off ? t('audience.screens_hint_off') : t('audience.screens_hint')}</div>
    <div class="table-wrap"><table style="width:100%;border-collapse:collapse;font-size:13px;min-width:420px">
      <tbody>
        ${data.groups.map((g) => row('group', g, t('audience.kind_group'))).join('')}
        ${data.devices.map((d) => row('device', d, devStatus(d))).join('')}
        ${!data.groups.length && !data.devices.length ? `<tr><td style="padding:8px;color:var(--text-muted)">${t('audience.no_screens')}</td></tr>` : ''}
      </tbody>
    </table></div>`;
  box.querySelectorAll('[data-aud-id]').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const path = cb.dataset.audKind === 'group' ? 'groups' : 'devices';
      try {
        await API(`/audience/${path}/${encodeURIComponent(cb.dataset.audId)}`, { method: 'PUT', body: JSON.stringify({ enabled: cb.checked }) });
        showToast(cb.checked ? t('audience.enabled_toast') : t('audience.disabled_toast'), 'success');
        loadScreens();
      } catch (e) { cb.checked = !cb.checked; showToast(e.message, 'error'); }
    });
  });
}

function rangeQs() {
  const s = document.getElementById('audStart').value;
  const e = document.getElementById('audEnd').value;
  return `start=${encodeURIComponent(s)}&end=${encodeURIComponent(e)}&tz=${new Date().getTimezoneOffset()}`;
}

async function loadReport() {
  const box = document.getElementById('audReport');
  let r;
  try { r = await API(`/audience/report?${rangeQs()}`); } catch (e) { box.innerHTML = `<p style="color:var(--text-muted)">${esc(e.message)}</p>`; return; }
  if (!r.overall.observed_minutes) { box.innerHTML = `<div class="empty-state"><p>${t('audience.no_data')}</p></div>`; return; }
  const o = r.overall;
  const th = (txt, right) => `<th style="padding:8px;text-align:${right ? 'right' : 'left'};color:var(--text-muted)">${txt}</th>`;
  const td = (txt, right) => `<td style="padding:8px${right ? ';text-align:right' : ''}">${txt}</td>`;
  box.innerHTML = `
    <div class="info-grid" style="margin-bottom:16px">
      <div class="info-card"><div class="info-card-label">${t('audience.impressions')}</div><div class="info-card-value">${fmtNum(o.impressions)}</div></div>
      <div class="info-card"><div class="info-card-label">${t('audience.arrivals')}</div><div class="info-card-value">${fmtNum(o.arrivals)}</div></div>
      <div class="info-card"><div class="info-card-label">${t('audience.avg_dwell')}</div><div class="info-card-value small">${fmtSec(o.avg_dwell_sec)}</div></div>
      <div class="info-card"><div class="info-card-label">${t('audience.peak')}</div><div class="info-card-value small">${fmtNum(o.peak_present)}</div></div>
    </div>
    <div style="display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));margin-bottom:16px">
      <div><h4 style="font-size:13px;margin-bottom:8px">${t('audience.by_hour')}</h4><div id="audHourChart" class="aud-chart"></div></div>
      <div><h4 style="font-size:13px;margin-bottom:8px">${t('audience.dwell_heading')}</h4><div id="audDwellChart" class="aud-chart"></div></div>
    </div>
    <h4 style="font-size:13px;margin-bottom:8px">${t('audience.by_day')}</h4>
    <div id="audDayChart" class="aud-chart" style="margin-bottom:20px"></div>
    <h4 style="font-size:13px;margin-bottom:8px">${t('audience.by_item')}</h4>
    <div class="table-wrap" style="margin-bottom:16px"><table style="width:100%;border-collapse:collapse;font-size:13px;min-width:560px">
      <thead><tr style="border-bottom:1px solid var(--border)">${th(t('audience.col_item'))}${th(t('audience.impressions'), 1)}${th(t('audience.plays'), 1)}${th(t('audience.per_play'), 1)}${th(t('audience.avg_dwell'), 1)}</tr></thead>
      <tbody>${r.by_item.map((i) => `<tr style="border-bottom:1px solid var(--border)">
        ${td(esc(i.item_name || (i.item_kind === 'none' ? t('audience.unattributed') : t('audience.deleted_item'))))}${td(fmtNum(i.impressions), 1)}${td(i.item_kind === 'content' ? fmtNum(i.plays) : '—', 1)}${td(i.impressions_per_play == null ? '—' : esc(String(i.impressions_per_play)), 1)}${td(fmtSec(i.avg_dwell_sec), 1)}
      </tr>`).join('')}</tbody>
    </table></div>
    <div style="display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))">
      <div><h4 style="font-size:13px;margin-bottom:8px">${t('audience.by_screen')}</h4>
        <div class="table-wrap"><table style="width:100%;border-collapse:collapse;font-size:13px">
          <tbody>${r.by_device.map((d) => `<tr style="border-bottom:1px solid var(--border)">${td(esc(d.device_name || d.device_id))}${td(fmtNum(d.impressions), 1)}</tr>`).join('')}</tbody>
        </table></div></div>
      <div><h4 style="font-size:13px;margin-bottom:8px">${t('audience.by_playlist')}</h4>
        <div class="table-wrap"><table style="width:100%;border-collapse:collapse;font-size:13px">
          <tbody>${r.by_playlist.length ? r.by_playlist.map((p) => `<tr style="border-bottom:1px solid var(--border)">${td(esc(p.playlist_name || p.playlist_id))}${td(fmtNum(p.impressions), 1)}</tr>`).join('')
            : `<tr>${td(`<span style="color:var(--text-muted)">—</span>`)}</tr>`}</tbody>
        </table></div></div>
    </div>`;
  bars('audHourChart', r.by_hour.map((h) => ({ label: `${String(h.hour).padStart(2, '0')}:00`, value: h.impressions })));
  bars('audDwellChart', o.dwell.map((d) => ({ label: d.label, value: d.count })));
  bars('audDayChart', r.by_day.map((d) => ({
    label: new Date(d.day + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }),
    value: d.impressions,
  })));
}

// Same bar style as the Reports page, so the two read as one product.
function bars(id, data) {
  const el = document.getElementById(id);
  if (!el || !data.length) return;
  el.style.cssText += ';height:200px;display:flex;align-items:flex-end;gap:2px';
  const max = Math.max(...data.map((d) => d.value), 1);
  el.innerHTML = data.map((d) => `
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;min-width:0" title="${esc(d.label)}: ${esc(d.value)}">
      <div style="font-size:9px;color:var(--text-muted);margin-bottom:2px;display:${d.value > 0 ? 'block' : 'none'}">${esc(d.value)}</div>
      <div style="width:100%;max-width:20px;height:${Math.max(2, (d.value / max) * 150)}px;background:var(--accent);border-radius:2px 2px 0 0"></div>
      <div style="font-size:8px;color:var(--text-muted);margin-top:4px;transform:rotate(-45deg);white-space:nowrap">${esc(d.label)}</div>
    </div>`).join('');
}

async function downloadCsv() {
  try {
    const r = await fetch(`/api/audience/export.csv?${rangeQs()}`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Request failed (${r.status})`);
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = url; a.download = 'audience.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { showToast(e.message, 'error'); }
}

export function cleanup() {}
