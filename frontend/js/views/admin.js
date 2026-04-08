import { api } from '../api.js';
import { showToast } from '../components/toast.js';

const headers = () => ({ Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' });
const API = (url, opts = {}) => fetch('/api' + url, { headers: headers(), ...opts }).then(r => r.json());

export async function render(container) {
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  if (user.role !== 'superadmin') {
    container.innerHTML = '<div class="empty-state"><h3>Access Denied</h3><p>Platform admin access required.</p></div>';
    return;
  }

  container.innerHTML = `
    <div class="page-header">
      <div><h1>Platform Admin</h1><div class="subtitle">Superadmin controls - only you can see this</div></div>
    </div>

    <!-- All Users -->
    <div class="settings-section">
      <h3>All Users</h3>
      <div id="allUsersTable"><p style="color:var(--text-muted)">Loading...</p></div>
    </div>

    <!-- Plan Management -->
    <div class="settings-section">
      <h3>Subscription Plans</h3>
      <div id="plansTable"><p style="color:var(--text-muted)">Loading...</p></div>
    </div>

    <!-- System Info -->
    <div class="settings-section">
      <h3>System</h3>
      <div id="systemInfo"><p style="color:var(--text-muted)">Loading...</p></div>
    </div>
  `;

  loadUsers();
  loadPlans();
  loadSystem();

}

async function loadUsers() {
  const el = document.getElementById('allUsersTable');
  try {
    const [users, plans] = await Promise.all([API('/auth/users'), fetch('/api/subscription/plans').then(r => r.json())]);

    el.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="border-bottom:1px solid var(--border)">
          <th style="padding:8px;text-align:left;color:var(--text-muted)">User</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">Auth</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">Last Login</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">Role</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">Plan</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">Actions</th>
        </tr></thead>
        <tbody>
          ${users.map(u => `
            <tr style="border-bottom:1px solid var(--border)">
              <td style="padding:8px"><div style="font-weight:500">${u.name || u.email}</div><div style="font-size:11px;color:var(--text-muted)">${u.email}</div></td>
              <td style="padding:8px"><span style="background:var(--bg-primary);padding:2px 8px;border-radius:10px;font-size:11px">${u.auth_provider}</span></td>
              <td style="padding:8px;font-size:11px;color:var(--text-muted)">${u.last_login ? new Date(u.last_login * 1000).toLocaleString() : 'Never'}</td>
              <td style="padding:8px">
                <select class="input" style="width:120px;background:var(--bg-input);font-size:12px;padding:4px" data-role-user="${u.id}">
                  <option value="user" ${u.role === 'user' ? 'selected' : ''}>User</option>
                  <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
                  <option value="superadmin" ${u.role === 'superadmin' ? 'selected' : ''}>Superadmin</option>
                </select>
              </td>
              <td style="padding:8px">
                <select class="input" style="width:130px;background:var(--bg-input);font-size:12px;padding:4px" data-plan-user="${u.id}">
                  ${plans.map(p => `<option value="${p.id}" ${u.plan_id === p.id ? 'selected' : ''}>${p.display_name}</option>`).join('')}
                </select>
              </td>
              <td style="padding:8px">
                ${u.role !== 'superadmin' ? `<button class="btn btn-danger btn-sm" data-delete-user="${u.id}">Remove</button>` : '<span style="color:var(--text-muted);font-size:11px">Owner</span>'}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <p style="color:var(--text-muted);font-size:11px;margin-top:8px">${users.length} total users</p>
    `;

    // Role change
    el.querySelectorAll('[data-role-user]').forEach(select => {
      select.onchange = async () => {
        try {
          await API(`/auth/users/${select.dataset.roleUser}/role`, { method: 'PUT', body: JSON.stringify({ role: select.value }) });
          showToast('Role updated', 'success');
        } catch (err) { showToast(err.message, 'error'); loadUsers(); }
      };
    });

    // Plan change
    el.querySelectorAll('[data-plan-user]').forEach(select => {
      select.onchange = async () => {
        try {
          await API('/subscription/assign', { method: 'POST', body: JSON.stringify({ user_id: select.dataset.planUser, plan_id: select.value }) });
          showToast('Plan updated', 'success');
        } catch (err) { showToast(err.message, 'error'); loadUsers(); }
      };
    });

    // Delete user
    el.querySelectorAll('[data-delete-user]').forEach(btn => {
      let confirming = false;
      btn.onclick = async () => {
        if (confirming) {
          try { await api.deleteUser(btn.dataset.deleteUser); showToast('User removed', 'success'); loadUsers(); }
          catch (err) { showToast(err.message, 'error'); }
          return;
        }
        confirming = true; btn.textContent = 'Confirm?'; btn.style.background = 'var(--danger)'; btn.style.color = 'white';
        setTimeout(() => { confirming = false; btn.textContent = 'Remove'; btn.style.background = ''; btn.style.color = ''; }, 3000);
      };
    });
  } catch (err) { el.innerHTML = `<p style="color:var(--danger)">${err.message}</p>`; }
}

async function loadPlans() {
  const el = document.getElementById('plansTable');
  try {
    const plans = await fetch('/api/subscription/plans').then(r => r.json());
    el.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="border-bottom:1px solid var(--border)">
          <th style="padding:8px;text-align:left;color:var(--text-muted)">Plan</th>
          <th style="padding:8px;text-align:right;color:var(--text-muted)">Devices</th>
          <th style="padding:8px;text-align:right;color:var(--text-muted)">Storage</th>
          <th style="padding:8px;text-align:right;color:var(--text-muted)">Monthly</th>
          <th style="padding:8px;text-align:right;color:var(--text-muted)">Yearly</th>
        </tr></thead>
        <tbody>
          ${plans.map(p => `
            <tr style="border-bottom:1px solid var(--border)">
              <td style="padding:8px;font-weight:500">${p.display_name}</td>
              <td style="padding:8px;text-align:right">${p.max_devices === -1 ? 'Unlimited' : p.max_devices}</td>
              <td style="padding:8px;text-align:right">${p.max_storage_mb === -1 ? 'Unlimited' : p.max_storage_mb >= 1024 ? (p.max_storage_mb/1024)+'GB' : p.max_storage_mb+'MB'}</td>
              <td style="padding:8px;text-align:right">${p.price_monthly > 0 ? '$'+p.price_monthly : 'Free'}</td>
              <td style="padding:8px;text-align:right">${p.price_yearly > 0 ? '$'+p.price_yearly : '-'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (err) { el.innerHTML = `<p style="color:var(--danger)">${err.message}</p>`; }
}

async function loadSystem() {
  const el = document.getElementById('systemInfo');
  try {
    const version = await fetch('/api/version').then(r => r.json());
    const token = localStorage.getItem('token');
    el.innerHTML = `
      <div class="info-grid">
        <div class="info-card"><div class="info-card-label">Version</div><div class="info-card-value small">${version.version}</div></div>
        <div class="info-card"><div class="info-card-label">Frontend Hash</div><div class="info-card-value small">${version.hash}</div></div>
      </div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <a href="/api/status/backup?token=${token}" class="btn btn-secondary btn-sm" style="text-decoration:none">Download DB Backup</a>
        <a href="/api/status" target="_blank" class="btn btn-secondary btn-sm" style="text-decoration:none">Server Status</a>
      </div>
    `;
  } catch (err) { el.innerHTML = `<p style="color:var(--danger)">${err.message}</p>`; }
}

export function cleanup() {}
