import { api, meshCapability } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';

// A refused request must reject, not resolve.
//
// This helper used to end in `.then(r => r.json())`, so a 403/404/500 body resolved as an ordinary
// value and the surrounding try/catch was unreachable — every handler took the failure for success.
// Concretely: deleting a built-in layout template showed "Layout deleted" while the server had
// returned 403 and the template was still there, and a rejected platform-role change showed "Role
// updated" while the dropdown kept displaying a value the server refused (its revert lives only in
// the dead catch). The shared client in api.js has always thrown on !res.ok; these local copies did
// not. Same contract now, including the 401 session-expiry reload.
const API = (url, opts = {}) => fetch('/api' + url, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, ...opts.headers }, ...opts }).then(async (r) => {
  if (r.status === 401) { localStorage.removeItem('token'); window.location.reload(); throw new Error('Session expired'); }
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `Request failed (${r.status})`); }
  return r.json();
});

export async function render(container) {
  const devices = await api.getDevices();
  // Scale-out (docs/scale-out.md): playback history is NOT copied to a replica. On a copied
  // workspace an empty report would read as "nothing ever played"; say where the history is.
  let copied = false;
  try { copied = !!(JSON.parse(localStorage.getItem('user') || 'null')?.current_workspace?.origin_node_id); } catch (_) { copied = false; }
  const today = new Date();
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  container.innerHTML = `
    <div class="page-header">
      <div><h1>${t('report.title')} <span class="help-tip" data-tip="${t('report.help_tip')}">?</span></h1><div class="subtitle">${t('report.subtitle')}</div></div>
      <a class="btn btn-secondary" id="exportBtn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        ${t('report.export_csv')}
      </a>
    </div>

    <!-- ⚠️ Uptime lives in REPORTS, not under Servers. It is a report — the artifact an MSP hands a
         customer — and filing it beside the mesh plumbing means you have to already know the
         feature is mesh-shaped in order to find it. It renders only when there are connected
         servers to report on, so an ordinary install sees nothing new. -->
    <div id="uptimeReportSection"></div>

    ${copied ? `<div class="empty-state" style="margin-bottom:16px;padding:12px 16px"><p style="margin:0">${t('report.history_on_primary')}</p></div>` : ''}

    <div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap;align-items:flex-end">
      <div class="form-group" style="margin:0"><label>${t('report.device')}</label>
        <select id="reportDevice" class="input" style="width:200px;background:var(--bg-input)">
          <option value="">${t('report.all_devices')}</option>
          ${devices.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group" style="margin:0"><label>${t('report.start_date')}</label>
        <input type="date" id="reportStart" class="input" value="${thirtyDaysAgo.toISOString().split('T')[0]}">
      </div>
      <div class="form-group" style="margin:0"><label>${t('report.end_date')}</label>
        <input type="date" id="reportEnd" class="input" value="${today.toISOString().split('T')[0]}">
      </div>
      <button class="btn btn-primary btn-sm" id="loadReportBtn">${t('report.load_report')}</button>
    </div>

    <div id="reportContent"><div class="empty-state"><h3>${t('report.select_range')}</h3></div></div>
  `;

  document.getElementById('loadReportBtn').onclick = loadReport;
  loadReport();
  // The mesh half renders itself, and renders nothing at all when there is no mesh.
  renderUptimeReport();
  document.getElementById('exportBtn').onclick = () => {
    const deviceId = document.getElementById('reportDevice').value;
    const start = document.getElementById('reportStart').value;
    const end = document.getElementById('reportEnd').value;
    const token = localStorage.getItem('token');
    window.open(`/api/reports/export?device_id=${deviceId}&start=${start}&end=${end}&token=${token}`, '_blank');
  };

  async function loadReport() {
    const deviceId = document.getElementById('reportDevice').value;
    const start = document.getElementById('reportStart').value;
    const end = document.getElementById('reportEnd').value;
    const content = document.getElementById('reportContent');

    content.innerHTML = `<div class="empty-state"><h3>${t('common.loading')}</h3></div>`;

    try {
      const summary = await API(`/reports/summary?device_id=${deviceId}&start=${start}&end=${end}`);

      content.innerHTML = `
        <div class="info-grid" style="margin-bottom:24px">
          <div class="info-card">
            <div class="info-card-label">${t('report.total_plays')}</div>
            <div class="info-card-value">${summary.overall.total_plays.toLocaleString()}</div>
          </div>
          <div class="info-card">
            <div class="info-card-label">${t('report.total_hours')}</div>
            <div class="info-card-value">${summary.overall.total_hours}</div>
          </div>
          <div class="info-card">
            <div class="info-card-label">${t('report.unique_content')}</div>
            <div class="info-card-value">${summary.overall.unique_content}</div>
          </div>
          <div class="info-card">
            <div class="info-card-label">${t('report.active_devices')}</div>
            <div class="info-card-value">${summary.overall.unique_devices}</div>
          </div>
          <div class="info-card">
            <div class="info-card-label">${t('report.avg_duration')}</div>
            <div class="info-card-value small">${formatDuration(summary.overall.avg_duration_sec)}</div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px">
          <div class="settings-section" style="margin:0">
            <h3 style="font-size:14px;margin-bottom:12px">${t('report.plays_per_day')}</h3>
            <div id="dailyChart" style="height:200px;display:flex;align-items:flex-end;gap:2px"></div>
          </div>

          <div class="settings-section" style="margin:0">
            <h3 style="font-size:14px;margin-bottom:12px">${t('report.plays_by_hour')}</h3>
            <div id="hourlyChart" style="height:200px;display:flex;align-items:flex-end;gap:1px"></div>
          </div>
        </div>

        <div class="settings-section" style="margin-bottom:20px">
          <h3 style="font-size:14px;margin-bottom:12px">${t('report.top_content')}</h3>
          <div class="table-wrap">
          <table style="width:100%;border-collapse:collapse;font-size:13px;min-width:460px">
            <thead><tr style="border-bottom:1px solid var(--border)">
              <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('report.col.content')}</th>
              <th style="padding:8px;text-align:right;color:var(--text-muted)">${t('report.col.plays')}</th>
              <th style="padding:8px;text-align:right;color:var(--text-muted)">${t('report.col.total_hours')}</th>
              <th style="padding:8px;text-align:right;color:var(--text-muted)">${t('report.col.completion')}</th>
            </tr></thead>
            <tbody>
              ${summary.by_content.map(c => `
                <tr style="border-bottom:1px solid var(--border)">
                  <td style="padding:8px">${c.content_name || t('common.unknown')}</td>
                  <td style="padding:8px;text-align:right">${c.plays}</td>
                  <td style="padding:8px;text-align:right">${(c.total_seconds / 3600).toFixed(1)}</td>
                  <td style="padding:8px;text-align:right">${c.plays > 0 ? Math.round((c.completed_plays / c.plays) * 100) : 0}%</td>
                </tr>
              `).join('') || `<tr><td colspan="4" style="padding:16px;text-align:center;color:var(--text-muted)">${t('report.no_data')}</td></tr>`}
            </tbody>
          </table>
          </div>
        </div>

        <div class="settings-section">
          <h3 style="font-size:14px;margin-bottom:12px">${t('report.by_device')}</h3>
          <div class="table-wrap">
          <table style="width:100%;border-collapse:collapse;font-size:13px;min-width:400px">
            <thead><tr style="border-bottom:1px solid var(--border)">
              <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('report.col.device')}</th>
              <th style="padding:8px;text-align:right;color:var(--text-muted)">${t('report.col.plays')}</th>
              <th style="padding:8px;text-align:right;color:var(--text-muted)">${t('report.col.total_hours')}</th>
            </tr></thead>
            <tbody>
              ${summary.by_device.map(d => `
                <tr style="border-bottom:1px solid var(--border)">
                  <td style="padding:8px">${d.device_name}</td>
                  <td style="padding:8px;text-align:right">${d.plays}</td>
                  <td style="padding:8px;text-align:right">${(d.total_seconds / 3600).toFixed(1)}</td>
                </tr>
              `).join('') || `<tr><td colspan="3" style="padding:16px;text-align:center;color:var(--text-muted)">${t('report.no_data')}</td></tr>`}
            </tbody>
          </table>
          </div>
        </div>
      `;

      renderBarChart('dailyChart', summary.by_day.map(d => ({
        label: new Date(d.day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        value: d.plays
      })));

      const hourData = Array.from({ length: 24 }, (_, i) => {
        const found = summary.by_hour.find(h => h.hour === i);
        return { label: i === 0 ? '12a' : i < 12 ? i + 'a' : i === 12 ? '12p' : (i - 12) + 'p', value: found?.plays || 0 };
      });
      renderBarChart('hourlyChart', hourData);

    } catch (err) {
      content.innerHTML = `<div class="empty-state"><h3>${t('report.error')}</h3><p>${esc(err.message)}</p></div>`;
    }
  }
}

function renderBarChart(containerId, data) {
  const container = document.getElementById(containerId);
  if (!container || !data.length) return;

  const maxVal = Math.max(...data.map(d => d.value), 1);

  container.innerHTML = data.map(d => `
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;min-width:0" title="${esc(d.label)}: ${esc(d.value)}">
      <div style="font-size:9px;color:var(--text-muted);margin-bottom:2px;display:${d.value > 0 ? 'block' : 'none'}">${d.value}</div>
      <div style="width:100%;max-width:20px;height:${Math.max(2, (d.value / maxVal) * 160)}px;background:var(--accent);border-radius:2px 2px 0 0;min-height:2px"></div>
      <div style="font-size:8px;color:var(--text-muted);margin-top:4px;transform:rotate(-45deg);white-space:nowrap">${esc(d.label)}</div>
    </div>
  `).join('');
}

function formatDuration(seconds) {
  if (!seconds) return '0s';
  if (seconds < 60) return Math.round(seconds) + 's';
  if (seconds < 3600) return Math.round(seconds / 60) + 'm';
  return (seconds / 3600).toFixed(1) + 'h';
}

export function cleanup() {}


/* ===================== per-client uptime (mesh) ===================== */

/*
 * ⚠️ THREE NUMBERS, AND COVERAGE IS NOT OPTIONAL. "99.9% uptime" computed over a week nobody was
 * watching is a confident lie in the reassuring direction; "99.9% uptime, 62% coverage" is an
 * honest and useful sentence. They render at the same size, side by side, because whichever one is
 * smaller is the one that gets cropped out of the screenshot somebody emails.
 */
let uptimeState = { clients: [], clientId: null, days: 30 };

export async function renderUptimeReport() {
  const host = document.getElementById('uptimeReportSection');
  if (!host) return;

  let list;
  // No mesh, or nothing visible: this section simply does not exist for that install.
  // #329: /uptime is a hub route. When the server has already said it is not a hub, skip straight
  // to the same empty outcome rather than spending a 404 to learn it.
  if (meshCapability('hub') === false) { host.innerHTML = ''; return; }
  try { list = await api.get('/mesh/uptime'); } catch (e) { host.innerHTML = ''; return; }
  uptimeState.clients = list.clients || [];
  if (!uptimeState.clients.length) { host.innerHTML = ''; return; }
  uptimeState.clientId = uptimeState.clientId || uptimeState.clients[0].id;

  host.innerHTML = `
    <div class="settings-section" style="margin-bottom:20px">
      <h3 style="font-size:14px;margin-bottom:12px">Screen uptime by client</h3>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
        <!-- ⚠️ No "all clients" option. A report headed with no client name, mixing customers into
             one percentage, is the document that gets forwarded to one of those customers. -->
        <select id="upClient" class="input" style="max-width:260px">
          ${uptimeState.clients.map((c) => `<option value="${esc(c.id)}" ${c.id === uptimeState.clientId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
        <select id="upDays" class="input" style="max-width:160px">
          ${[7, 30, 90].map((d) => `<option value="${d}" ${uptimeState.days === d ? 'selected' : ''}>Last ${d} days</option>`).join('')}
        </select>
        <button class="btn btn-secondary btn-sm" id="upCsv">Download CSV</button>
      </div>
      <div id="upBody"></div>
    </div>`;

  host.querySelector('#upClient').addEventListener('change', (e) => {
    uptimeState.clientId = e.target.value; loadUptime();
  });
  host.querySelector('#upDays').addEventListener('change', (e) => {
    uptimeState.days = Number(e.target.value); loadUptime();
  });
  host.querySelector('#upCsv').addEventListener('click', downloadUptimeCsv);
  await loadUptime();
}

function uptimeWindow() {
  const to = Math.floor(Date.now() / 1000);
  return { to, from: to - uptimeState.days * 86400 };
}

async function loadUptime() {
  const body = document.getElementById('upBody');
  if (!body) return;
  body.innerHTML = '<div style="color:var(--text-muted);font-size:13px">Building report…</div>';
  const { from, to } = uptimeWindow();
  let r;
  try {
    r = await api.get(`/mesh/uptime?clientId=${encodeURIComponent(uptimeState.clientId)}&from=${from}&to=${to}`);
  } catch (e) {
    body.innerHTML = `<div style="color:var(--text-muted)">Could not load: ${esc(e.message)}</div>`;
    return;
  }
  if (r.uptimePct == null) {
    body.innerHTML = `<div style="color:var(--text-muted);font-size:13px">${esc(r.note || 'Nothing to report.')}</div>`;
    return;
  }

  const TDs = 'padding:8px';
  const THs = 'padding:8px;text-align:left;color:var(--text-muted)';
  const mins = (s) => (s >= 3600 ? `${Math.round(s / 360) / 10}h` : `${Math.round(s / 60)}m`);

  body.innerHTML = `
    <div style="display:flex;gap:32px;flex-wrap:wrap;margin-bottom:12px">
      <div><div style="color:var(--text-muted);font-size:11px">Uptime</div>
           <div style="font-size:28px">${r.uptimePct}%</div></div>
      <div><div style="color:var(--text-muted);font-size:11px">Coverage</div>
           <div style="font-size:28px;${r.coveragePct != null && r.coveragePct < 95 ? 'color:var(--warning,#f59e0b)' : ''}">${r.coveragePct == null ? '—' : r.coveragePct + '%'}</div></div>
      <div><div style="color:var(--text-muted);font-size:11px">Screens</div>
           <div style="font-size:28px">${r.deviceCount}</div></div>
      <div><div style="color:var(--text-muted);font-size:11px">Incidents</div>
           <div style="font-size:28px">${r.incidentCount}</div></div>
    </div>
    <p style="color:var(--text-muted);font-size:12px">${esc(r.coverageNote || '')} ${esc(r.timezoneLabel || '')}</p>
    <div class="table-wrap">
      <table style="width:100%;border-collapse:collapse;font-size:13px;min-width:520px">
        <thead><tr style="border-bottom:1px solid var(--border)">
          <th style="${THs}">Screen</th><th style="${THs}">Server</th><th style="${THs}">What</th>
          <th style="${THs}">Started</th><th style="${THs}">For</th>
        </tr></thead>
        <tbody>
          ${r.incidents.slice(0, 50).map((i) => `
            <tr style="border-bottom:1px solid var(--border)">
              <td style="${TDs}">${esc(i.deviceName || i.deviceId)}</td>
              <td style="${TDs}"><span class="badge" title="${esc(i.originNodeId)}" style="font-family:monospace">${esc(String(i.originNodeId).slice(0, 8))}</span></td>
              <td style="${TDs}">${esc(String(i.alertType || '').replace(/[_-]/g, ' '))}</td>
              <td style="${TDs}">${esc(new Date(i.openedAt * 1000).toLocaleString())}</td>
              <td style="${TDs}">${i.ongoing ? '<strong>still down</strong>' : esc(mins(i.downSeconds))}</td>
            </tr>`).join('') ||
            '<tr><td colspan="5" style="padding:16px;text-align:center;color:var(--text-muted)">No incidents in this period.</td></tr>'}
        </tbody>
      </table>
    </div>
    ${r.incidents.length > 50
      // Never a silent truncation: showing 50 of 300 reads as "that was all of them".
      ? `<p style="color:var(--text-muted);font-size:12px">Showing the 50 longest of ${r.incidents.length}. The CSV contains every one.</p>` : ''}`;
}

/*
 * ⚠️ Fetched with the auth header rather than linked. The API is Bearer-authenticated from
 * localStorage, so an <a href> would 401 — and it would 401 by REDIRECTING to login, which reads to
 * the user as "my session expired" rather than "that link cannot carry a token".
 */
async function downloadUptimeCsv() {
  const { from, to } = uptimeWindow();
  try {
    const res = await fetch(
      `/api/mesh/uptime.csv?clientId=${encodeURIComponent(uptimeState.clientId)}&from=${from}&to=${to}`,
      { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'uptime.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked on a delay: some browsers abort a download whose object URL is released too early.
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } catch (e) {
    showToast(`Could not export: ${e.message}`, 'error');
  }
}
