// Workspace administration: "Require approval before publishing". Rendered on the members page
// for workspace admins. Explains what turning it on or off does, requires at least one eligible
// reviewer before it can be enabled, and says so plainly in a single-user workspace.
import { api } from '../api.js';
import { t } from '../i18n.js';
import { showToast } from './toast.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function renderApprovalSettings(host) {
  let s;
  try { s = await api.getApprovalSettings(); } catch (_) { return; }
  if (!s || !s.can_admin) return;
  const reviewerIds = new Set(s.reviewers.map((r) => r.user_id));
  const single = s.eligible.length < 2;
  host.innerHTML = `
    <div class="settings-section" style="margin-top:24px;padding:16px 20px">
      <h3 style="margin:0 0 6px">${esc(t('approval.title'))}</h3>
      <p style="color:var(--text-muted);font-size:13px;margin:0 0 12px">${esc(t('approval.explain'))}</p>
      <label style="display:flex;align-items:center;gap:10px;font-weight:600">
        <input type="checkbox" id="approvalToggle" ${s.require_approval ? 'checked' : ''} ${!s.require_approval && !s.can_enable ? 'disabled' : ''}>
        ${esc(t('approval.toggle'))}
      </label>
      ${!s.require_approval && !s.can_enable ? `<p style="color:#fbbf24;font-size:13px;margin:8px 0 0">${esc(single ? t('approval.blocked_single_user') : t('approval.blocked_no_reviewer'))}</p>` : ''}
      ${s.require_approval ? `<p style="font-size:13px;margin:8px 0 0;color:var(--text-muted)">${esc(t('approval.on_effects'))}</p>` : ''}
      <h4 style="margin:16px 0 6px">${esc(t('approval.reviewers'))}</h4>
      <p style="color:var(--text-muted);font-size:13px;margin:0 0 8px">${esc(t('approval.reviewers_explain'))}</p>
      <div id="reviewerList" style="display:flex;flex-direction:column;gap:6px">
        ${s.eligible.map((u) => `<label style="display:flex;align-items:center;gap:8px"><input type="checkbox" data-reviewer="${esc(u.id)}" ${reviewerIds.has(u.id) ? 'checked' : ''}> ${esc(u.name || u.email)} <span style="color:var(--text-muted);font-size:12px">${esc(u.email)} · ${esc(u.role.replace('workspace_', ''))}</span></label>`).join('') || `<span style="color:var(--text-muted)">${esc(t('approval.no_eligible'))}</span>`}
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:12px">
        <button class="btn btn-primary btn-sm" id="approvalSave">${esc(t('common.save'))}</button>
        <span id="approvalMsg" style="font-size:12px;color:var(--text-muted)">${s.pending_submissions ? esc(t('approval.pending_count', { n: s.pending_submissions })) : ''}</span>
      </div>
    </div>`;
  host.querySelector('#approvalSave').onclick = async () => {
    const want = host.querySelector('#approvalToggle').checked;
    const reviewers = [...host.querySelectorAll('[data-reviewer]:checked')].map((el) => el.dataset.reviewer);
    if (s.require_approval && !want) {
      if (!confirm(t('approval.disable_confirm', { n: s.pending_submissions || 0 }))) return;
    }
    if (!s.require_approval && want && !confirm(t('approval.enable_confirm'))) return;
    try {
      await api.updateApprovalSettings({ require_approval: want, reviewers });
      showToast(t('approval.toast.saved'), 'success');
      await renderApprovalSettings(host);
    } catch (e) { showToast(e.message, 'error'); }
  };
}
