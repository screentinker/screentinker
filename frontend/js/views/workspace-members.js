// Workspace members view. Slice 2A established the read-only listing;
// slice 2B adds the mutation surface (invite modal + per-row role change /
// remove / cancel-invite) gated by can_admin from /me.
//
// Affordance rules (locked from 2A's CSS design, refined during 2B):
//   - direct-member rows: role select + remove button
//   - via_org rows: no actions (server would 403; access lives in org_members)
//   - invited rows: cancel-invite button only (server returns 200)
// Server enforces all three boundaries; UI must match.

import { api } from '../api.js';
import { t } from '../i18n.js';
import { showToast } from '../components/toast.js';
import { openInviteMemberModal } from '../components/workspace-members-invite-modal.js';
import { openAddUserModal } from '../components/workspace-members-add-user-modal.js';
import { renderApprovalSettings } from '../components/approval-settings.js';
import { renderLiveVideoSettings } from '../components/live-video-settings.js';

export async function render(container, workspaceId) {
  container.innerHTML = `
    <div class="page-header">
      <h1>${t('members.title')}</h1>
      <div id="membersHeaderActions"></div>
    </div>
    <div id="workspaceMembersContent" style="color:var(--text-muted)">${t('members.loading')}</div>
  `;
  const content = document.getElementById('workspaceMembersContent');
  const headerActions = document.getElementById('membersHeaderActions');

  // Fetch members, invites, and /me (for can_admin) in parallel. /me is the
  // source of truth for can_admin in THIS workspace - the same field the
  // switcher uses to gate the members icon.
  let members, meWorkspace;
  try {
    const [m, me] = await Promise.all([
      api.getWorkspaceMembers(workspaceId),
      api.getMe().catch(() => null),
    ]);
    members = m;
    meWorkspace = (me?.accessible_workspaces || []).find(w => w.id === workspaceId) || null;
  } catch (err) {
    const msg = err.message || '';
    if (/Workspace access required|Workspace not found/.test(msg)) {
      content.innerHTML = renderError(t('members.workspace_not_found'));
    } else {
      content.innerHTML = renderError(t('members.load_error', { error: esc(msg) }));
    }
    return;
  }

  const canAdmin = !!(meWorkspace && meWorkspace.can_admin);
  const workspaceName = meWorkspace?.name || '';

  // /invites is admin-only. Non-admins get 403; suppress silently. We could
  // skip the call entirely when !canAdmin to save a request, but defending
  // in depth: if /me drift ever leaves can_admin stale, the server still
  // returns the right answer.
  let invites = null;
  if (canAdmin) {
    try {
      invites = await api.getWorkspaceInvites(workspaceId);
    } catch (err) {
      console.warn('getWorkspaceInvites failed:', err.message);
      invites = null;
    }
  }

  // Invite + Add User buttons - admin only. Invite is self-service (emails a
  // link); Add User (#10) provisions an account directly with an admin-set
  // password (for instances with no outbound email). They coexist.
  if (canAdmin) {
    headerActions.innerHTML = `
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary" id="addUserBtn">${t('members.button.add_user')}</button>
        <button class="btn btn-primary" id="inviteMemberBtn">${t('members.button.invite')}</button>
      </div>
    `;
    document.getElementById('inviteMemberBtn').addEventListener('click', () => {
      openInviteMemberModal({ id: workspaceId, name: workspaceName }, {
        onSuccess: (result) => {
          showToast(t('members.success.invite_sent', { email: result.email }), 'success');
          render(container, workspaceId);
        },
        mapError: mapMutationError,
      });
    });
    document.getElementById('addUserBtn').addEventListener('click', () => {
      openAddUserModal({ id: workspaceId, name: workspaceName }, {
        onSuccess: (result) => {
          showToast(t('members.success.user_created', { email: result.email }), 'success');
          render(container, workspaceId);
        },
        mapError: mapMutationError,
      });
    });
  }

  const direct = members.filter(m => !m.via_org);
  const viaOrg = members.filter(m => m.via_org);

  content.innerHTML = `
    ${renderSection({
      titleKey: 'members.section.direct',
      count: direct.length,
      emptyKey: 'members.empty.members',
      rows: direct.map(m => renderMemberRow(m, { showJoined: true, canAdmin })).join(''),
    })}
    ${viaOrg.length > 0 ? renderSection({
      titleKey: 'members.section.via_org',
      count: viaOrg.length,
      emptyKey: null,
      rows: viaOrg.map(m => renderMemberRow(m, { showJoined: false, viaOrg: true, canAdmin })).join(''),
    }) : ''}
    ${invites !== null ? renderSection({
      titleKey: 'members.section.pending',
      count: invites.length,
      emptyKey: 'members.empty.invites',
      rows: invites.map(inv => renderInviteRow(inv, { canAdmin })).join(''),
    }) : ''}
    <div id="approvalSettingsCard"></div>
    <div id="liveVideoSettingsCard"></div>
  `;

  if (canAdmin) attachMutationHandlers(container, workspaceId);
  if (canAdmin) renderApprovalSettings(content.querySelector('#approvalSettingsCard'));
  if (canAdmin) renderLiveVideoSettings(content.querySelector('#liveVideoSettingsCard'), { workspaceId, workspace: meWorkspace });
}

function renderSection({ titleKey, count, emptyKey, rows }) {
  const countLabel = count > 0
    ? `<span style="color:var(--text-muted);font-weight:400;font-size:13px"> (${count})</span>`
    : '';
  const body = (count === 0 && emptyKey)
    ? `<p style="color:var(--text-muted);font-size:13px">${t(emptyKey)}</p>`
    : `<div class="members-list">${rows}</div>`;
  return `
    <div class="settings-section" style="margin-bottom:24px">
      <h3 style="font-size:15px;margin-bottom:12px">${t(titleKey)}${countLabel}</h3>
      ${body}
    </div>
  `;
}

function renderMemberRow(m, opts = {}) {
  const { showJoined = false, viaOrg = false, canAdmin = false } = opts;
  const initial = ((m.name || m.email || '?')[0] || '?').toUpperCase();
  const rightCell = viaOrg
    ? `<span class="member-via-org">${t('members.via_org_label')}</span>`
    : (showJoined ? esc(formatDate(m.joined_at)) : '');

  // Role cell: select for direct-member rows when canAdmin, plain text otherwise.
  const roleCell = (canAdmin && !viaOrg)
    ? `<select class="member-role-select" data-member-id="${esc(m.user_id)}" aria-label="${esc(t('members.col.role'))}">
         ${WORKSPACE_ROLES.map(r => `<option value="${r}"${r === m.role ? ' selected' : ''}>${esc(t('members.role.' + r))}</option>`).join('')}
       </select>`
    : `<div class="member-role">${esc(t('members.role.' + m.role))}</div>`;

  // Actions cell: remove on direct-member rows only when canAdmin.
  const actionsCell = (canAdmin && !viaOrg)
    ? `<div class="member-actions">
         <button class="member-action-btn member-action-btn--danger" type="button"
                 data-remove-member="${esc(m.user_id)}"
                 data-member-name="${esc(m.name || m.email)}"
                 aria-label="${esc(t('members.button.remove'))}"
                 title="${esc(t('members.button.remove'))}">${REMOVE_ICON}</button>
       </div>`
    : '';

  return `
    <div class="member-row${viaOrg ? ' member-row--via-org' : ''}">
      <div class="member-avatar">${esc(initial)}</div>
      <div class="member-meta">
        <div class="member-name">${esc(m.name || m.email)}</div>
        <div class="member-email">${esc(m.email)}</div>
      </div>
      ${roleCell}
      <div class="member-detail">${rightCell}</div>
      ${actionsCell}
    </div>
  `;
}

function renderInviteRow(inv, opts = {}) {
  const { canAdmin = false } = opts;
  const initial = ((inv.email || '?')[0] || '?').toUpperCase();
  const invitedBy = inv.invited_by_email
    ? t('members.invited_by', { email: inv.invited_by_email })
    : '';
  const expires = t('members.expires_in', { when: formatDate(inv.expires_at) });

  // Refined affordance rule: invited rows DO get one action - cancel.
  const actionsCell = canAdmin
    ? `<div class="member-actions">
         <button class="member-action-btn member-action-btn--danger" type="button"
                 data-cancel-invite="${esc(inv.id)}"
                 data-invite-email="${esc(inv.email)}"
                 aria-label="${esc(t('members.button.cancel_invite'))}"
                 title="${esc(t('members.button.cancel_invite'))}">${REMOVE_ICON}</button>
       </div>`
    : '';

  return `
    <div class="member-row member-row--invited">
      <div class="member-avatar member-avatar--muted">${esc(initial)}</div>
      <div class="member-meta">
        <div class="member-name">
          ${esc(inv.email)}
          <span class="member-badge">${t('members.invited_label')}</span>
        </div>
        <div class="member-email">${esc(invitedBy)}</div>
      </div>
      <div class="member-role">${esc(t('members.role.' + inv.role))}</div>
      <div class="member-detail">${esc(expires)}</div>
      ${actionsCell}
    </div>
  `;
}

// Wire all mutation handlers after innerHTML write. Each handler: confirm
// (if destructive), call API, on success toast + re-render, on error toast
// + re-render (to revert UI state in case the failed mutation was an
// optimistic display - belt and suspenders).
function attachMutationHandlers(container, workspaceId) {
  // Role change - fires on <select> change.
  container.querySelectorAll('select[data-member-id]').forEach(sel => {
    sel.addEventListener('change', async () => {
      const userId = sel.dataset.memberId;
      const newRole = sel.value;
      try {
        await api.updateWorkspaceMemberRole(workspaceId, userId, newRole);
        showToast(t('members.success.role_changed'), 'success');
        render(container, workspaceId);
      } catch (err) {
        showToast(mapMutationError(err), 'error');
        render(container, workspaceId);
      }
    });
  });

  // Remove member - confirm then DELETE.
  container.querySelectorAll('[data-remove-member]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const userId = btn.dataset.removeMember;
      const name = btn.dataset.memberName;
      if (!confirm(t('members.confirm.remove_member', { name }))) return;
      try {
        await api.removeWorkspaceMember(workspaceId, userId);
        showToast(t('members.success.member_removed', { name }), 'success');
        render(container, workspaceId);
      } catch (err) {
        showToast(mapMutationError(err), 'error');
      }
    });
  });

  // Cancel pending invite - confirm then DELETE.
  container.querySelectorAll('[data-cancel-invite]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const inviteId = btn.dataset.cancelInvite;
      const email = btn.dataset.inviteEmail;
      if (!confirm(t('members.confirm.cancel_invite', { email }))) return;
      try {
        await api.cancelWorkspaceInvite(workspaceId, inviteId);
        showToast(t('members.success.invite_cancelled'), 'success');
        render(container, workspaceId);
      } catch (err) {
        showToast(mapMutationError(err), 'error');
      }
    });
  });
}

// Map a backend mutation-error message to a translated user-facing string.
// Exported so the invite modal can reuse the same mapper (single source of
// truth - the "third regex mapper" per the slice 2A follow-up note;
// cumulative-debt cleanup tracked there).
//
// Order matters - most specific patterns first. Server message stability is
// the implicit contract; if the regex chain ever produces wrong matches,
// it's because server wording changed without updating this mapper.
export function mapMutationError(err) {
  const msg = err?.message || '';
  if (/rate limit/i.test(msg)) return t('members.error.rate_limit');
  if (/already pending/i.test(msg)) return t('members.error.invite_exists');
  if (/Cannot demote the last admin/i.test(msg)) return t('members.error.last_admin_demote');
  if (/Cannot remove the last admin/i.test(msg)) return t('members.error.last_admin_remove');
  if (/already a member/i.test(msg)) return t('members.error.already_member');
  // #10 Add User: duplicate email + weak password.
  if (/user with that email already exists/i.test(msg)) return t('members.error.user_exists');
  if (/at least 8 characters/i.test(msg)) return t('members.error.password_min_8');
  if (/Valid email required/i.test(msg)) return t('members.error.invalid_email');
  if (/Cannot remove the organization owner/i.test(msg)) return t('members.error.org_owner_remove');
  if (/Email send failed/i.test(msg)) return t('members.error.email_send_failed');
  return t('members.error.mutation_generic', { error: msg });
}

function renderError(message) {
  return `<div style="color:var(--danger);font-size:14px;padding:16px;background:var(--bg-input);border-radius:6px">${esc(message)}</div>`;
}

function formatDate(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

const WORKSPACE_ROLES = ['workspace_admin', 'workspace_editor', 'workspace_viewer'];
const REMOVE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
