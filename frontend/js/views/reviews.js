// The review queue: what is waiting, who sent it, when, what screens it touches, what changed
// against the live version, a preview, and the decisions. Creators see their own submissions
// here too. Approving records a decision; publishing is a separate, explicit act.
import { api, fetchRevisionRender, fetchRevisionFileUrl } from '../api.js';
import { t } from '../i18n.js';
import { showToast } from '../components/toast.js';
import { approvalSettings } from '../components/approval-actions.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (sec) => sec ? new Date(sec * 1000).toLocaleString() : '';
const currentUserId = () => { try { return JSON.parse(localStorage.getItem('user'))?.id; } catch { return null; } };
const TYPE_LABEL = { content: 'review.type.content', playlist: 'review.type.playlist', layout: 'review.type.layout', slide_deck: 'review.type.slide_deck', widget: 'review.type.widget' };

export async function render(container) {
  container.innerHTML = `
    <div class="page-header"><div><h1>${esc(t('review.title'))}</h1><div class="subtitle" id="reviewSub"></div></div>
      <div style="display:flex;gap:8px"><select id="reviewFilter" class="input" style="width:auto">
        <option value="open">${esc(t('review.filter.open'))}</option><option value="all">${esc(t('review.filter.all'))}</option><option value="mine">${esc(t('review.filter.mine'))}</option>
      </select></div></div>
    <div style="display:grid;grid-template-columns:minmax(280px,1fr) 2fr;gap:16px">
      <div id="reviewList" class="settings-section" style="padding:0;max-height:75vh;overflow:auto">${esc(t('common.loading'))}</div>
      <div id="reviewDetail" class="settings-section" style="padding:16px;min-height:300px;color:var(--text-muted)">${esc(t('review.pick_hint'))}</div>
    </div>`;
  const list = container.querySelector('#reviewList'), detail = container.querySelector('#reviewDetail'), filter = container.querySelector('#reviewFilter');
  const s = await approvalSettings(true);
  container.querySelector('#reviewSub').textContent = s.require_approval ? (s.is_reviewer ? t('review.sub_reviewer') : t('review.sub_member')) : t('review.sub_off');
  let rows = [], selected = null;

  async function load() {
    try { rows = filter.value === 'mine' ? await api.getMySubmissions('all') : await api.getReviewQueue(filter.value); }
    catch (e) { list.innerHTML = `<div style="padding:12px" class="err">${esc(e.message)}</div>`; return; }
    list.innerHTML = rows.map((r) => `
      <div data-id="${esc(r.id)}" style="padding:10px 12px;border-bottom:1px solid var(--border);cursor:pointer;${selected === r.id ? 'background:var(--bg-secondary)' : ''}">
        <div style="display:flex;justify-content:space-between;gap:8px"><strong>${esc(r.resource_name || r.resource_id)}</strong><span class="pill" style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--bg-secondary)">${esc(t('review.status.' + r.status))}</span></div>
        <div style="font-size:12px;color:var(--text-muted)">${esc(t(TYPE_LABEL[r.resource_type] || r.resource_type))} · ${esc(r.submitter_name || r.submitter_email || '')} · ${esc(when(r.submitted_at))}${r.affected_devices ? ` · ${esc(t('review.affects', { n: r.affected_devices }))}` : ''}</div>
      </div>`).join('') || `<div style="padding:12px;color:var(--text-muted)">${esc(t('review.empty'))}</div>`;
  }

  function diffHtml(d) {
    if (!d) return '';
    const lines = [];
    for (const f of d.fields || []) lines.push(`<li><b>${esc(f.field)}</b>: ${esc(JSON.stringify(f.from))} → ${esc(JSON.stringify(f.to))}</li>`);
    const l = d.items || d.zones || d.slides;
    if (l) {
      for (const a of l.added) lines.push(`<li style="color:#34d399">+ ${esc(JSON.stringify(a))}</li>`);
      for (const r of l.removed) lines.push(`<li style="color:#f87171">− ${esc(JSON.stringify(r))}</li>`);
      for (const c of l.changed) lines.push(`<li>~ ${esc(JSON.stringify(c.item))}</li>`);
      if (l.reordered) lines.push(`<li>${esc(t('history.reordered'))}</li>`);
    }
    return `<ul style="margin:6px 0 0 16px;padding:0;font-size:12px">${lines.join('') || `<li>${esc(t('review.first_release'))}</li>`}</ul>`;
  }

  async function show(id) {
    selected = id; load();
    detail.innerHTML = esc(t('common.loading'));
    let sub;
    try { sub = await api.getSubmission(id); } catch (e) { detail.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
    const st = sub.revision && sub.revision.state || {};
    const canDecide = sub.is_reviewer && sub.status === 'submitted' && !(sub.authors || []).includes(currentUserId());
    detail.innerHTML = `
      <h3 style="margin:0">${esc(sub.resource_name || sub.resource_id)} <span style="font-size:12px;color:var(--text-muted)">${esc(t(TYPE_LABEL[sub.resource_type] || sub.resource_type))} · #${sub.rev_no}</span></h3>
      <div style="font-size:13px;margin:6px 0;color:var(--text-muted)">${esc(t('review.submitted_by', { who: sub.submitter_name || sub.submitter_email || '', when: when(sub.submitted_at) }))}${sub.note ? `<br>“${esc(sub.note)}”` : ''}</div>
      <div style="font-size:13px;margin:6px 0">${esc(t('review.status_line', { status: t('review.status.' + sub.status) }))}${sub.reviewer_email ? ` · ${esc(sub.reviewer_name || sub.reviewer_email)} · ${esc(when(sub.decided_at))}` : ''}${sub.comment ? `<br>${esc(t('review.comment_label'))}: “${esc(sub.comment)}”` : ''}</div>
      <div style="font-size:13px;margin:6px 0">${esc(t('review.affects', { n: sub.affected_devices || 0 }))}</div>
      <h4 style="margin:12px 0 4px">${esc(t('review.changes_since_live'))}</h4>${diffHtml(sub.diff_from_live)}
      <h4 style="margin:12px 0 4px">${esc(t('common.preview'))}</h4><div id="reviewPreview" style="font-size:12px"></div>
      <div id="reviewActions" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;align-items:center"></div>`;
    const pv = detail.querySelector('#reviewPreview');
    try {
      if (sub.resource_type === 'widget' && sub.revision) {
        const html = await fetchRevisionRender('widget', sub.resource_id, sub.revision.id);
        const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.style.cssText = 'width:100%;height:220px;border:1px solid var(--border);border-radius:8px;background:#000'; pv.appendChild(f); f.srcdoc = html;
      } else if (sub.resource_type === 'content' && sub.revision && /^image\//.test(st.mime_type || '')) {
        const url = await fetchRevisionFileUrl('content', sub.resource_id, sub.revision.id).catch(() => null);
        pv.innerHTML = url ? `<img src="${url}" style="max-width:100%;max-height:240px;border-radius:8px">` : esc(t('history.bytes_gone'));
      } else if (sub.resource_type === 'playlist') {
        pv.innerHTML = `<ol style="margin:0 0 0 18px;padding:0">${(st.items || []).map((it) => `<li>${esc(it.content_id ? 'content ' + it.content_id.slice(0, 8) : it.widget_id ? 'widget ' + it.widget_id.slice(0, 8) : 'playlist ' + String(it.child_playlist_id || '').slice(0, 8))} · ${esc(String(it.duration_sec ?? ''))}s</li>`).join('')}</ol>`;
      } else if (sub.resource_type === 'layout') {
        pv.innerHTML = `<div style="position:relative;width:100%;aspect-ratio:${st.width || 16}/${st.height || 9};background:#111;border-radius:8px;overflow:hidden">${(st.zones || []).map((z) => `<div style="position:absolute;left:${z.x_percent}%;top:${z.y_percent}%;width:${z.width_percent}%;height:${z.height_percent}%;border:1px solid #34d399;color:#fff;font-size:10px;padding:2px">${esc(z.name)}</div>`).join('')}</div>`;
      } else if (sub.resource_type === 'slide_deck') {
        pv.innerHTML = `<ol style="margin:0 0 0 18px;padding:0">${((st.doc && st.doc.slides) || []).map((sl) => `<li>${esc(sl.name || sl.id)}</li>`).join('')}</ol>`;
      }
    } catch (e) { pv.textContent = e.message; }

    const actions = detail.querySelector('#reviewActions');
    const btn = (attr, label, cls = 'btn-secondary') => `<button class="btn ${cls} btn-sm" ${attr}>${esc(label)}</button>`;
    let a = '';
    if (canDecide) a += btn('data-approve', t('review.approve'), 'btn-primary') + btn('data-changes', t('review.request_changes'));
    else if (sub.is_reviewer && sub.status === 'submitted') a += `<span style="font-size:12px;color:#fbbf24">${esc(t('review.self_approval_note'))}</span>`;
    if (sub.status === 'approved' && sub.can_publish) a += btn('data-publish', t('review.publish_approved'), 'btn-primary');
    if (['submitted', 'changes_requested', 'approved'].includes(sub.status) && (sub.submitted_by === currentUserId() || s.can_admin)) a += btn('data-withdraw', t('review.withdraw'));
    actions.innerHTML = a;
    actions.onclick = async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      try {
        if (b.hasAttribute('data-approve')) { const c = prompt(t('review.approve_comment_prompt')) ?? ''; await api.approveSubmission(sub.id, c, sub.version); showToast(t('review.toast.approved'), 'success'); }
        if (b.hasAttribute('data-changes')) { const c = prompt(t('review.changes_comment_prompt')); if (!c) return; await api.requestChanges(sub.id, c, sub.version); showToast(t('review.toast.changes_requested')); }
        if (b.hasAttribute('data-publish')) { await api.publishSubmission(sub.id); showToast(t('review.toast.published'), 'success'); }
        if (b.hasAttribute('data-withdraw')) { await api.withdrawSubmission(sub.id); showToast(t('review.toast.withdrawn')); }
        await show(sub.id);
      } catch (err) { showToast(err.message, 'error'); await show(sub.id); }
    };
  }
  list.addEventListener('click', (e) => { const r = e.target.closest('[data-id]'); if (r) show(r.dataset.id); });
  filter.addEventListener('change', load);
  await load();
}
