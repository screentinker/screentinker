/*
 * "Your organizations" (Settings): leave one, or, for its owner, hand it over and leave.
 *
 * The server decides everything (routes/org-ownership.js GET /organizations/mine and
 * POST /organizations/:id/leave); this lists what it said and asks before acting. An owner cannot
 * leave without choosing who takes over, so their row has the list of people instead of a bare
 * button, and an owner with nobody else in the organization is told why there is no button.
 */
import { t } from '../i18n.js';
import { esc } from '../utils.js';

const call = async (method, path, body) => {
  const res = await fetch('/api' + path, { method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
    body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch { /* */ }
  return { status: res.status, data: data || {} };
};

export async function mountLeaveOrganizations(el) {
  if (!el) return;
  el.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${esc(t('common.loading'))}</p>`;
  let r;
  try { r = await call('GET', '/organizations/mine'); } catch (err) { r = { status: 0, data: { error: err.message } }; }
  if (!document.contains(el)) return;
  const orgs = (r.status === 200 && r.data.organizations) || [];
  if (!orgs.length) {
    el.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${esc(r.status === 200 ? t('org_leave.none') : (r.data.error || t('org_leave.failed')))}</p>`;
    return;
  }
  el.innerHTML = `
    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">${esc(t('org_leave.intro'))}</p>
    ${orgs.map((o) => `
      <div class="org-leave-row" data-org="${esc(o.id)}" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 0;border-top:1px solid var(--border);font-size:13px">
        <span style="min-width:160px;font-weight:500">${esc(o.name)}</span>
        <span style="color:var(--text-muted);min-width:70px">${esc(o.is_owner ? t('org_leave.you_own') : t('org_leave.member'))}</span>
        ${o.is_owner
    ? (o.candidates.length
      ? `<select class="input" data-new-owner style="max-width:240px;padding:4px 8px;font-size:13px" aria-label="${esc(t('org_leave.new_owner'))}">
             ${o.candidates.map((p) => `<option value="${esc(p.id)}">${esc(p.name ? `${p.name} (${p.email})` : p.email)}</option>`).join('')}
           </select>
           <button type="button" class="btn btn-secondary btn-sm" data-leave>${esc(t('org_leave.hand_over_and_leave'))}</button>`
      : `<span style="color:var(--text-muted)">${esc(t('org_leave.sole_owner'))}</span>`)
    : (o.can_leave
      ? `<button type="button" class="btn btn-secondary btn-sm" data-leave>${esc(t('org_leave.leave'))}</button>`
      : `<span style="color:var(--text-muted)">${esc(t('org_leave.last_admin', { names: (o.last_admin_of || []).map((w) => w.name).join(', ') }))}</span>`)}
        <span data-msg role="status" style="color:var(--danger, #e05252);flex-basis:100%"></span>
      </div>`).join('')}`;

  el.querySelectorAll('.org-leave-row').forEach((row) => {
    const org = orgs.find((o) => o.id === row.dataset.org);
    const btn = row.querySelector('[data-leave]');
    if (!btn) return;
    const msg = row.querySelector('[data-msg]');
    btn.addEventListener('click', async () => {
      const sel = row.querySelector('[data-new-owner]');
      const who = sel ? sel.options[sel.selectedIndex].textContent : '';
      const ask = org.is_owner ? t('org_leave.confirm_owner', { org: org.name, who }) : t('org_leave.confirm', { org: org.name });
      if (!confirm(ask)) return;
      btn.disabled = true; msg.textContent = '';
      try {
        const body = sel ? { new_owner_id: sel.value } : {};
        let res = await call('POST', `/organizations/${encodeURIComponent(org.id)}/leave`, body);
        // While the person pays, the plan is the owner's: the server says what would change first.
        if (res.status === 409 && res.data.code === 'PLAN_FOLLOWS_OWNER') {
          if (!confirm(res.data.error + '\n\n' + t('org_leave.confirm_plan'))) { btn.disabled = false; return; }
          res = await call('POST', `/organizations/${encodeURIComponent(org.id)}/leave`, { ...body, acknowledge_plan_change: true });
        }
        if (res.status !== 200) { msg.textContent = res.data.error || t('org_leave.failed'); btn.disabled = false; return; }
        // The workspace this tab was in may be gone with the membership: start again from the top.
        window.location.hash = '#/';
        window.location.reload();
      } catch (err) { msg.textContent = err.message; btn.disabled = false; }
    });
  });
}
