import { api } from '../api.js';
import { showToast } from '../components/toast.js';

const API = (url, opts = {}) => fetch('/api' + url, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}`, ...opts.headers }, ...opts }).then(r => r.json());

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
      <div><h1>Teams <span class="help-tip" data-tip="Create teams to share devices with other users. Owners manage the team, editors can change content/playlists, viewers can only monitor.">?</span></h1><div class="subtitle">Manage teams and shared access</div></div>
      <button class="btn btn-primary" id="newTeamBtn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        New Team
      </button>
    </div>
    <div id="teamsList"></div>
  `;

  document.getElementById('newTeamBtn').onclick = async () => {
    const name = prompt('Team name:');
    if (!name) return;
    const team = await API('/teams', { method: 'POST', body: JSON.stringify({ name }) });
    window.location.hash = `#/team/${team.id}`;
  };

  try {
    const teams = await API('/teams');
    const list = document.getElementById('teamsList');

    if (!teams.length) {
      list.innerHTML = '<div class="empty-state"><h3>No teams yet</h3><p>Create a team to share devices with other users.</p></div>';
      return;
    }

    list.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px">
      ${teams.map(t => `
        <div class="content-item" style="cursor:pointer" onclick="window.location.hash='#/team/${t.id}'">
          <div style="padding:20px">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
              <div style="width:40px;height:40px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;color:white">${t.name[0].toUpperCase()}</div>
              <div>
                <div style="font-weight:600;font-size:16px">${t.name}</div>
                <div style="font-size:12px;color:var(--text-muted)">Your role: ${t.my_role} &middot; ${t.member_count} member(s)</div>
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
  } catch { container.innerHTML = '<div class="empty-state"><h3>Team not found</h3></div>'; return; }

  const unassignedDevices = allDevices.filter(d => !d.team_id || d.team_id !== teamId);

  container.innerHTML = `
    <a href="#/teams" class="back-link" style="display:inline-flex;align-items:center;gap:6px;color:var(--text-secondary);margin-bottom:16px;font-size:13px">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
      Back to Teams
    </a>
    <div class="page-header">
      <h1>${team.name}</h1>
      <div style="display:flex;gap:8px">
        <button class="btn btn-danger btn-sm" id="deleteTeamBtn">Delete Team</button>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px">
      <!-- Members -->
      <div class="settings-section" style="margin:0">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <h3 style="font-size:15px">Members (${team.members?.length || 0})</h3>
          <button class="btn btn-secondary btn-sm" id="inviteMemberBtn">+ Invite</button>
        </div>
        <div id="membersList">
          ${(team.members || []).map(m => `
            <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
              <div style="width:32px;height:32px;border-radius:50%;background:var(--bg-input);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;color:var(--text-secondary)">${(m.user_name || m.email)[0].toUpperCase()}</div>
              <div style="flex:1;min-width:0">
                <div style="font-size:13px;font-weight:500">${m.user_name || m.email}</div>
                <div style="font-size:11px;color:var(--text-muted)">${m.email}</div>
              </div>
              <select class="input" style="width:100px;background:var(--bg-input);font-size:12px;padding:4px 8px" data-member-id="${m.user_id}" ${m.role === 'owner' ? 'disabled' : ''}>
                <option value="viewer" ${m.role === 'viewer' ? 'selected' : ''}>Viewer</option>
                <option value="editor" ${m.role === 'editor' ? 'selected' : ''}>Editor</option>
                <option value="owner" ${m.role === 'owner' ? 'selected' : ''}>Owner</option>
              </select>
              ${m.role !== 'owner' ? `<button class="btn-icon" data-remove-member="${m.user_id}" style="color:var(--danger)" title="Remove">&#10005;</button>` : ''}
            </div>
          `).join('') || '<p style="color:var(--text-muted);font-size:13px">No members yet</p>'}
        </div>
      </div>

      <!-- Devices -->
      <div class="settings-section" style="margin:0">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <h3 style="font-size:15px">Shared Devices (${devices.length})</h3>
          <select id="addDeviceToTeam" class="input" style="width:200px;background:var(--bg-input);font-size:12px">
            <option value="">+ Add device...</option>
            ${unassignedDevices.map(d => `<option value="${d.id}">${d.name}</option>`).join('')}
          </select>
        </div>
        <div id="teamDevicesList">
          ${devices.map(d => `
            <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
              <span class="status-dot ${d.status}"></span>
              <div style="flex:1">
                <div style="font-size:13px;font-weight:500">${d.name}</div>
                <div style="font-size:11px;color:var(--text-muted)">${d.status}</div>
              </div>
              <button class="btn-icon" data-remove-device="${d.id}" style="color:var(--danger)" title="Remove from team">&#10005;</button>
            </div>
          `).join('') || '<p style="color:var(--text-muted);font-size:13px">No devices shared with this team</p>'}
        </div>
      </div>
    </div>
  `;

  // Invite member
  document.getElementById('inviteMemberBtn').onclick = async () => {
    const email = prompt('Email address to invite:');
    if (!email) return;
    const role = prompt('Role (viewer, editor, or owner):', 'editor');
    if (!['viewer', 'editor', 'owner'].includes(role)) { showToast('Invalid role', 'error'); return; }
    try {
      await API(`/teams/${teamId}/invite`, { method: 'POST', body: JSON.stringify({ email, role }) });
      showToast('Invitation sent', 'success');
      renderTeamDetail(container, teamId);
    } catch (err) { showToast(err.message, 'error'); }
  };

  // Change member role
  container.querySelectorAll('[data-member-id]').forEach(select => {
    select.onchange = async () => {
      try {
        await API(`/teams/${teamId}/members/${select.dataset.memberId}`, { method: 'PUT', body: JSON.stringify({ role: select.value }) });
        showToast('Role updated', 'success');
      } catch (err) { showToast(err.message, 'error'); }
    };
  });

  // Remove member
  container.querySelectorAll('[data-remove-member]').forEach(btn => {
    btn.onclick = async () => {
      try {
        await API(`/teams/${teamId}/members/${btn.dataset.removeMember}`, { method: 'DELETE' });
        showToast('Member removed', 'success');
        renderTeamDetail(container, teamId);
      } catch (err) { showToast(err.message, 'error'); }
    };
  });

  // Add device to team
  document.getElementById('addDeviceToTeam').onchange = async (e) => {
    const deviceId = e.target.value;
    if (!deviceId) return;
    try {
      await API(`/teams/${teamId}/devices`, { method: 'POST', body: JSON.stringify({ device_id: deviceId }) });
      showToast('Device added to team', 'success');
      renderTeamDetail(container, teamId);
    } catch (err) { showToast(err.message, 'error'); }
  };

  // Remove device from team
  container.querySelectorAll('[data-remove-device]').forEach(btn => {
    btn.onclick = async () => {
      try {
        await API(`/teams/${teamId}/devices/${btn.dataset.removeDevice}`, { method: 'DELETE' });
        showToast('Device removed from team', 'success');
        renderTeamDetail(container, teamId);
      } catch (err) { showToast(err.message, 'error'); }
    };
  });

  // Delete team
  document.getElementById('deleteTeamBtn').onclick = async () => {
    try {
      await API(`/teams/${teamId}`, { method: 'DELETE' });
      showToast('Team deleted', 'success');
      window.location.hash = '#/teams';
    } catch (err) { showToast(err.message, 'error'); }
  };
}

export function cleanup() {}
