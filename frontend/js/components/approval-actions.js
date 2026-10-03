// The compact bar every editor shows: History, and, when the workspace requires approval,
// Submit for review / Withdraw / Publish approved; plus Publish draft / Discard draft for the
// three resources that hold a separate draft (widgets, layouts, content). The server enforces
// all of this; the bar only reflects what the settings and history endpoints say.
import { api } from '../api.js';
import { t } from '../i18n.js';
import { showToast } from './toast.js';
import { openHistoryModal } from './history-modal.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let settingsCache = null, settingsAt = 0;
export async function approvalSettings(force = false) {
  if (!force && settingsCache && Date.now() - settingsAt < 30000) return settingsCache;
  try { settingsCache = await api.getApprovalSettings(); } catch (_) { settingsCache = { require_approval: false, is_reviewer: false, can_admin: false }; }
  settingsAt = Date.now();
  return settingsCache;
}

/**
 * @param {HTMLElement} host   where to render
 * @param {{type:string,id:string,name?:string,publish?:()=>Promise<any>,onChanged?:()=>void,compact?:boolean}} o
 *   publish: for playlists/decks, the resource's own publish call (used once a submission is approved).
 */
export async function renderApprovalBar(host, o) {
  if (!host) return;
  const s = await approvalSettings();
  let hist = null;
  try { hist = await api.getHistory(o.type, o.id); } catch (_) {}
  let open = null;
  if (s.require_approval) {
    try { const q = await api.getReviewQueue('open'); open = q.find((x) => x.resource_type === o.type && x.resource_id === o.id) || null; } catch (_) {}
  }
  const separateDraft = ['widget', 'layout', 'content'].includes(o.type);
  const hasDraft = !!(hist && hist.has_draft);
  const btn = (attr, label, cls = 'btn-secondary') => `<button class="btn ${cls} btn-sm" ${attr}>${esc(label)}</button>`;
  let html = btn('data-history', t('history.button'));
  let status = '';
  if (s.require_approval) {
    if (open && open.status === 'submitted') { status = t('review.state.awaiting'); html += btn('data-withdraw', t('review.withdraw')); }
    else if (open && open.status === 'changes_requested') { status = t('review.state.changes_requested', { comment: open.comment || '' }); html += btn('data-submit', t('review.resubmit'), 'btn-primary') + btn('data-withdraw', t('review.withdraw')); }
    else if (open && open.status === 'approved') { status = t('review.state.approved'); html += btn('data-publish-approved', t('review.publish_approved'), 'btn-primary'); }
    else if (hasDraft || !separateDraft) { html += btn('data-submit', t('review.submit'), 'btn-primary'); }
    if (separateDraft && hasDraft && !open) html += btn('data-discard', t('review.discard_draft'));
  } else if (separateDraft && hasDraft) {
    status = t('review.state.draft_pending');
    html += btn('data-publish-draft', t('review.publish_draft'), 'btn-primary') + btn('data-discard', t('review.discard_draft'));
  }
  host.innerHTML = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${html}${status ? `<span style="font-size:12px;color:var(--text-muted)">${esc(status)}</span>` : ''}</div>`;

  const refresh = async () => { settingsCache = null; await renderApprovalBar(host, o); if (o.onChanged) o.onChanged(); };
  host.onclick = async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.hasAttribute('data-history')) return openHistoryModal(o.type, o.id, { name: o.name, onChanged: refresh });
      if (b.hasAttribute('data-submit')) { const note = prompt(t('review.submit_note_prompt')) ?? ''; await api.submitForReview(o.type, o.id, note); showToast(t('review.toast.submitted'), 'success'); }
      if (b.hasAttribute('data-withdraw')) { await api.withdrawSubmission(open.id); showToast(t('review.toast.withdrawn')); }
      if (b.hasAttribute('data-publish-approved')) { await api.publishSubmission(open.id); showToast(t('review.toast.published'), 'success'); }
      if (b.hasAttribute('data-publish-draft')) { await api.publishDraft(o.type, o.id); showToast(t('review.toast.published'), 'success'); }
      if (b.hasAttribute('data-discard')) { if (!confirm(t('review.discard_confirm'))) return; await api.discardDraft(o.type, o.id); showToast(t('review.toast.discarded')); }
      await refresh();
    } catch (err) { showToast(err.message, 'error'); }
  };
}
