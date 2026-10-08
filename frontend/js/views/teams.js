import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { t, tn } from '../i18n.js';
import { esc } from '../utils.js';

// A refused request must reject, not resolve.
//
// This helper used to end in `.then(r => r.json())`, so a 403/404/500 body resolved as an ordinary
// value and the surrounding try/catch was unreachable — every handler took the failure for success.
// Concretely: deleting a built-in layout template showed "Layout deleted" while the server had
// returned 403 and the template was still there, and a rejected platform-role change showed "Role
// updated" while the dropdown kept displaying a value the server refused (its revert lives only in
// the dead catch). The shared client in api.js has always thrown on !res.ok; these local copies did
// not. Same contract now, including the 401 session-expiry reload.
const API = (url, opts = {}) => fetch('/api' + url, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}`, ...opts.headers }, ...opts }).then(async (r) => {
  if (r.status === 401) { localStorage.removeItem('token'); window.location.reload(); throw new Error('Session expired'); }
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw Object.assign(new Error(e.error || `Request failed (${r.status})`), { status: r.status, body: e }); }
  return r.json();
});

export async function render(container) {
  const hash = window.location.hash;
  if (hash.startsWith('#/team/')) {
    const id = hash.split('#/team/')[1];
    return renderTeamDetail(container, id);
  }
  return renderList(container);
}

async function renderList(container) {
  container.innerHTML = `
    <div class="page-header">
      <div><h1>${t('team.title')} <span class="help-tip" data-tip="${t('team.help_tip')}">?</span></h1><div class="subtitle">${t('team.subtitle')}</div></div>
      <button class="btn btn-primary" id="newTeamBtn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        ${t('team.new_team')}
      </button>
    </div>
    <div id="teamsList"></div>
  `;

  document.getElementById('newTeamBtn').onclick = async () => {
    const name = prompt(t('team.prompt_name'));
    if (!name) return;
    const team = await API('/teams', { method: 'POST', body: JSON.stringify({ name }) });
    window.location.hash = `#/team/${team.id}`;
  };

  try {
    const list = document.getElementById('teamsList');
    // A 503 (Teams switched off server-side) is a state of the page, not a failed action: show it
    // once, in the page, instead of an error toast per request.
    const teams = await API('/teams').catch((e) => { if (e.status === 503) return e.body || {}; throw e; });

    // Teams is switched off server-side while it is redesigned: every endpoint answers 503 with
    // an explanation. API() resolves the BODY whatever the status, so an object arrives where an
    // array was expected — and `!teams.length` then rendered "No teams yet" over a feature that
    // is not there, next to a New Team button that could only ever fail. Say what is actually
    // happening, and take away the button that leads nowhere.
    if (!Array.isArray(teams)) {
      document.getElementById('newTeamBtn')?.remove();
      list.innerHTML = `<div class="empty-state"><h3>${esc(t('team.unavailable_title'))}</h3>`
        + `<p>${esc(teams && teams.message ? teams.message : t('team.unavailable_desc'))}</p></div>`;
      return;
    }

    if (!teams.length) {
      list.innerHTML = `<div class="empty-state"><h3>${t('team.empty_title')}</h3><p>${t('team.empty_desc')}</p></div>`;
      return;
    }

    list.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px">
      ${teams.map(team => `
        <div class="content-item" style="cursor:pointer" onclick="window.location.hash='#/team/${team.id}'">
          <div style="padding:20px">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
              <div style="width:40px;height:40px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;color:white">${esc(team.name[0].toUpperCase())}</div>
              <div>
                <div style="font-weight:600;font-size:16px">${esc(team.name)}</div>
                <div style="font-size:12px;color:var(--text-muted)">${t('team.your_role', { role: team.my_role })} &middot; ${tn('team.member_count', team.member_count)}</div>
              </div>
            </div>
          </div>
        </div>
      `).join('')}
    </div>`;
  } catch (err) { showToast(err.message, 'error'); }
}

async function renderTeamDetail(container, teamId) {
  let team, devices, allDevices;
  try {
    [team, devices, allDevices] = await Promise.all([
      API(`/teams/${teamId}`),
      API(`/teams/${teamId}/devices`),
      api.getDevices()
    ]);
  } catch { container.innerHTML = `<div class="empty-state"><h3>${t('team.not_found')}</h3></div>`; return; }

  const unassignedDevices = allDevices.filter(d => !d.team_id || d.team_id !== teamId);

  container.innerHTML = `
    <a href="#/teams" class="back-link" style="display:inline-flex;align-items:center;gap:6px;color:var(--text-secondary);margin-bottom:16px;font-size:13px">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
      ${t('team.back')}
    </a>
    <div class="page-header">
      <h1>${esc(team.name)}</h1>
      <div style="display:flex;gap:8px">
        <button class="btn btn-danger btn-sm" id="deleteTeamBtn">${t('team.delete_team')}</button>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px">
      <div class="settings-section" style="margin:0">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <h3 style="font-size:15px">${t('team.members_count', { n: team.members?.length || 0 })}</h3>
          <button class="btn btn-secondary btn-sm" id="inviteMemberBtn">${t('team.invite')}</button>
        </div>
        <div id="membersList">
          ${(team.members || []).map(m => `
            <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
              <div style="width:32px;height:32px;border-radius:50%;background:var(--bg-input);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;color:var(--text-secondary)">${esc((m.user_name || m.email)[0].toUpperCase())}</div>
              <div style="flex:1;min-width:0">
                <div style="font-size:13px;font-weight:500">${esc(m.user_name || m.email)}</div>
                <div style="font-size:11px;color:var(--text-muted)">${esc(m.email)}</div>
              </div>
              <select class="input" style="max-width:100px;width:100%;background:var(--bg-input);font-size:12px;padding:4px 8px" data-member-id="${m.user_id}" ${m.role === 'owner' ? 'disabled' : ''}>
                <option value="viewer" ${m.role === 'viewer' ? 'selected' : ''}>${t('team.role_viewer')}</option>
                <option value="editor" ${m.role === 'editor' ? 'selected' : ''}>${t('team.role_editor')}</option>
                <option value="owner" ${m.role === 'owner' ? 'selected' : ''}>${t('team.role_owner')}</option>
              </select>
              ${m.role !== 'owner' ? `<button class="btn-icon" data-remove-member="${m.user_id}" style="color:var(--danger)" title="${t('team.remove')}">&#10005;</button>` : ''}
            </div>
          `).join('') || `<p style="color:var(--text-muted);font-size:13px">${t('team.no_members')}</p>`}
        </div>
      </div>

      <div class="settings-section" style="margin:0">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <h3 style="font-size:15px">${t('team.shared_devices', { n: devices.length })}</h3>
          <select id="addDeviceToTeam" class="input" style="max-width:200px;width:100%;background:var(--bg-input);font-size:12px">
            <option value="">${t('team.add_device')}</option>
            ${unassignedDevices.map(d => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}
          </select>
        </div>
        <div id="teamDevicesList">
          ${devices.map(d => `
            <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
              <span class="status-dot ${d.status}"></span>
              <div style="flex:1">
                <div style="font-size:13px;font-weight:500">${esc(d.name)}</div>
                <div style="font-size:11px;color:var(--text-muted)">${esc(d.status)}</div>
              </div>
              <button class="btn-icon" data-remove-device="${d.id}" style="color:var(--danger)" title="${t('team.remove_from_team')}">&#10005;</button>
            </div>
          `).join('') || `<p style="color:var(--text-muted);font-size:13px">${t('team.no_devices')}</p>`}
        </div>
      </div>
    </div>
  `;

  document.getElementById('inviteMemberBtn').onclick = async () => {
    const email = prompt(t('team.prompt_email'));
    if (!email) return;
    const role = prompt(t('team.prompt_role'), 'editor');
    if (!['viewer', 'editor', 'owner'].includes(role)) { showToast(t('team.toast.invalid_role'), 'error'); return; }
    try {
      await API(`/teams/${teamId}/invite`, { method: 'POST', body: JSON.stringify({ email, role }) });
      showToast(t('team.toast.invitation_sent'), 'success');
      renderTeamDetail(container, teamId);
    } catch (err) { showToast(err.message, 'error'); }
  };

  container.querySelectorAll('[data-member-id]').forEach(select => {
    select.onchange = async () => {
      try {
        await API(`/teams/${teamId}/members/${select.dataset.memberId}`, { method: 'PUT', body: JSON.stringify({ role: select.value }) });
        showToast(t('team.toast.role_updated'), 'success');
      } catch (err) { showToast(err.message, 'error'); }
    };
  });

  container.querySelectorAll('[data-remove-member]').forEach(btn => {
    btn.onclick = async () => {
      try {
        await API(`/teams/${teamId}/members/${btn.dataset.removeMember}`, { method: 'DELETE' });
        showToast(t('team.toast.member_removed'), 'success');
        renderTeamDetail(container, teamId);
      } catch (err) { showToast(err.message, 'error'); }
    };
  });

  document.getElementById('addDeviceToTeam').onchange = async (e) => {
    const deviceId = e.target.value;
    if (!deviceId) return;
    try {
      await API(`/teams/${teamId}/devices`, { method: 'POST', body: JSON.stringify({ device_id: deviceId }) });
      showToast(t('team.toast.device_added'), 'success');
      renderTeamDetail(container, teamId);
    } catch (err) { showToast(err.message, 'error'); }
  };

  container.querySelectorAll('[data-remove-device]').forEach(btn => {
    btn.onclick = async () => {
      try {
        await API(`/teams/${teamId}/devices/${btn.dataset.removeDevice}`, { method: 'DELETE' });
        showToast(t('team.toast.device_removed'), 'success');
        renderTeamDetail(container, teamId);
      } catch (err) { showToast(err.message, 'error'); }
    };
  });

  document.getElementById('deleteTeamBtn').onclick = async () => {
    try {
      await API(`/teams/${teamId}`, { method: 'DELETE' });
      showToast(t('team.toast.deleted'), 'success');
      window.location.hash = '#/teams';
    } catch (err) { showToast(err.message, 'error'); }
  };
}

export function cleanup() {}
