import { meshCapability } from '../api.js';
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
const API = (url) => fetch('/api' + url, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }}).then(async (r) => {
  if (r.status === 401) { localStorage.removeItem('token'); window.location.reload(); throw new Error('Session expired'); }
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `Request failed (${r.status})`); }
  return r.json();
});

/*
 * ⚠️ ONE PLACE FOR "WHAT IS WRONG RIGHT NOW", INCLUDING OTHER SERVERS.
 *
 * Open alerts used to have a mesh-only inbox under Servers, which meant two screens answering the
 * same question — and with two, the one an operator does not have open is always the one holding
 * the answer. This section shows local incidents and incidents from connected servers together,
 * because to the person on call there is no such thing as "a remote outage": there is an outage.
 *
 * The rollup matters most when the answer is THIS server. When most connected sites go quiet at
 * once, the honest reading is "suspect our own connection", not "forty sites are down" — the latter
 * dispatches engineers to premises that are fine.
 */
async function renderAlerts() {
  const el = document.getElementById('alertsPanel');
  if (!el) return;

  let mesh = null;
  // A server with no mesh simply has no remote half; that is not an error worth showing.
  // #329: and on a server that says outright it is not a hub, do not even ask — /alerts is a hub
  // route, so this was a guaranteed 404 every time the Activity view opened.
  if (meshCapability('hub') !== false) {
    try { mesh = await API('/mesh/alerts'); } catch (e) { mesh = null; }
  }

  const local = (mesh && mesh.local) || [];
  const remote = (mesh && mesh.alerts) || [];
  const rollups = ((mesh && mesh.rollups) || []).filter((r) => r.suspectSelf);

  if (!local.length && !remote.length) {
    el.innerHTML = `<div style="padding:12px 0;color:var(--text-muted);font-size:13px">
      Nothing is open right now${mesh ? ', here or on any connected server' : ''}.</div>`;
    return;
  }

  const when = (sec) => (sec ? new Date(sec * 1000).toLocaleString() : '');
  const row = (label, where, since, remoteRow) => `
    <div style="display:flex;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);align-items:center">
      <div style="width:8px;height:8px;border-radius:50%;background:${remoteRow ? '#f59e0b' : '#ef4444'};flex-shrink:0"></div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px"><strong>${esc(label)}</strong></div>
        <div style="font-size:12px;color:var(--text-muted)">${esc(where)}</div>
      </div>
      <div style="font-size:11px;color:var(--text-muted);white-space:nowrap">${esc(when(since))}</div>
    </div>`;

  el.innerHTML = `
    ${rollups.map((r) => `
      <div style="border-left:3px solid var(--warning,#f59e0b);padding:10px 12px;margin-bottom:10px;background:var(--bg-card)">
        <strong>Check this server's connection first</strong>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px">${esc(r.summary)}</div>
      </div>`).join('')}
    ${local.map((i) => row(String(i.metric || '').replace(/[_-]/g, ' '),
                           i.device_id ? `this server · ${i.device_id}` : 'this server',
                           i.opened_at, false)).join('')}
    ${remote.map((a) => row(String(a.alert_type || '').replace(/[_-]/g, ' '),
                            // ⚠️ Says which server, and whether we can currently SEE that server.
                            // "Last known" on an alert is not pedantry: acting on a stale alert from
                            // an unreachable site is how somebody drives to a screen that is fine.
                            `${String(a.origin_node_id || '').slice(0, 8)}${a.stale ? ' · last known, that server is not reachable' : ''}`,
                            a.opened_at, true)).join('')}`;
}

export async function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div><h1>${t('activity.title')} <span class="help-tip" data-tip="${t('activity.help_tip')}">?</span></h1><div class="subtitle">${t('activity.subtitle')}</div></div>
    </div>
    <div class="settings-section" style="margin-bottom:20px">
      <h3 style="font-size:14px;margin-bottom:4px">Open alerts</h3>
      <div id="alertsPanel"><div style="color:var(--text-muted);font-size:13px">Loading…</div></div>
    </div>
    <h3 style="font-size:14px;margin-bottom:8px">Recent activity</h3>
    <div id="activityList"><div class="empty-state"><h3>${t('common.loading')}</h3></div></div>
    <div style="text-align:center;margin-top:16px">
      <button class="btn btn-secondary btn-sm" id="loadMoreBtn" style="display:none">${t('activity.load_more')}</button>
    </div>
  `;

  let offset = 0;
  const limit = 50;

  async function loadActivity(append = false) {
    try {
      const items = await API(`/activity?limit=${limit}&offset=${offset}`);
      const list = document.getElementById('activityList');

      if (!append) list.innerHTML = '';

      if (items.length === 0 && offset === 0) {
        list.innerHTML = `<div class="empty-state"><h3>${t('activity.empty_title')}</h3><p>${t('activity.empty_desc')}</p></div>`;
        return;
      }

      const html = items.map(item => {
        const time = new Date(item.created_at * 1000);
        const timeStr = time.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
                        time.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        const icon = getActionIcon(item.action);

        return `
          <div style="display:flex;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);align-items:flex-start">
            <div style="width:32px;height:32px;border-radius:50%;background:var(--bg-card);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:14px">${icon}</div>
            <div style="flex:1;min-width:0">
              <div style="font-size:13px">
                <strong>${esc(item.user_name || item.user_email || t('activity.system'))}</strong>
                <span style="color:var(--text-secondary)"> ${esc(formatAction(item.action))}</span>
              </div>
              ${item.details ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px">${esc(item.details)}</div>` : ''}
            </div>
            <div style="font-size:11px;color:var(--text-muted);white-space:nowrap;flex-shrink:0">${timeStr}</div>
          </div>
        `;
      }).join('');

      if (append) {
        list.insertAdjacentHTML('beforeend', html);
      } else {
        list.innerHTML = html;
      }

      document.getElementById('loadMoreBtn').style.display = items.length >= limit ? '' : 'none';
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  document.getElementById('loadMoreBtn').onclick = () => {
    offset += limit;
    loadActivity(true);
  };

  loadActivity();
  renderAlerts();
}

function getActionIcon(action) {
  if (action.includes('DELETE')) return '&#128465;';
  if (action.includes('POST') && action.includes('content')) return '&#128228;';
  if (action.includes('POST') && action.includes('provision')) return '&#128279;';
  if (action.includes('POST') && action.includes('assignment')) return '&#128203;';
  if (action.includes('alert')) return '&#128276;';
  if (action.includes('PUT')) return '&#9998;';
  if (action.includes('POST')) return '&#10133;';
  return '&#128196;';
}

// Action verbs are user-visible; translate them through t() so they switch
// languages with the rest of the UI. The mapping below preserves the original
// verb-then-noun structure of the English version.
function formatAction(action) {
  // Verbs
  let s = action
    .replace('POST /api/', t('activity.verb_created') + ' ')
    .replace('PUT /api/', t('activity.verb_updated') + ' ')
    .replace('DELETE /api/', t('activity.verb_deleted') + ' ');
  // Specific endpoints
  s = s
    .replace('/provision/pair', t('activity.action_paired_device'))
    .replace('/content/remote', t('activity.action_added_remote_content'))
    .replace('/content', t('activity.noun_content'))
    .replace('/devices/:id', t('activity.noun_device'))
    .replace('/assignments/device/:deviceId', t('activity.noun_playlist_assignment'))
    .replace('/assignments/:id', t('activity.noun_assignment'))
    .replace('/layouts', t('activity.noun_layout'))
    .replace('/widgets', t('activity.noun_widget'))
    .replace('/schedules', t('activity.noun_schedule'))
    .replace('/walls', t('activity.noun_video_wall'))
    .replace('alert:device_offline', t('activity.alert_device_offline'));
  return s;
}

export function cleanup() {}
