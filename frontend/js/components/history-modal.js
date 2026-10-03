// Version history: one modal for every authored resource. Lists revisions (who, when, what,
// published or not), compares two, previews one, and restores one INTO THE DRAFT. Restore never
// touches the live version; the bar below the list then offers the next step the workspace's
// release policy wants (publish, publish draft, or submit for review).
import { api, fetchRevisionRender, fetchRevisionFileUrl } from '../api.js';
import { t } from '../i18n.js';
import { showToast } from '../components/toast.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (sec) => sec ? new Date(sec * 1000).toLocaleString() : '';
const ACTOR = { baseline: 'history.actor_baseline', import: 'history.actor_import', mesh: 'history.actor_mesh', api_token: 'history.actor_api', system: 'history.actor_system', restore: null, user: null };

function actorLabel(r) {
  const who = r.actor_name || r.actor_email || r.actor_label;
  const kindKey = ACTOR[r.actor_kind];
  if (who) return kindKey ? `${who} (${t(kindKey)})` : who;
  return kindKey ? t(kindKey) : t('history.actor_unknown');
}

export async function openHistoryModal(type, id, { name = '', onChanged } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="width:860px;max-width:96vw">
      <div class="modal-header"><h3>${esc(t('history.title', { name: name || id }))}</h3><button class="btn-icon" data-close aria-label="${esc(t('common.close'))}">✕</button></div>
      <div class="modal-body" style="display:grid;grid-template-columns:1fr 1fr;gap:16px;min-height:320px">
        <div id="histList" style="overflow:auto;max-height:60vh">${esc(t('common.loading'))}</div>
        <div id="histDetail" style="overflow:auto;max-height:60vh;color:var(--text-muted);font-size:13px">${esc(t('history.pick_hint'))}</div>
      </div>
      <div class="modal-footer" style="display:flex;justify-content:space-between;gap:8px;align-items:center">
        <span id="histNote" style="font-size:12px;color:var(--text-muted)"></span>
        <div style="display:flex;gap:8px"><button class="btn btn-secondary" data-close>${esc(t('common.close'))}</button></div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.closest('[data-close]')) close(); });

  const list = overlay.querySelector('#histList');
  const detail = overlay.querySelector('#histDetail');
  const note = overlay.querySelector('#histNote');
  let data, selected = null, compareWith = null;

  async function load() {
    try { data = await api.getHistory(type, id); } catch (e) { list.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
    note.textContent = data.require_approval ? t('history.note_approval_on') : t('history.note_approval_off');
    list.innerHTML = data.revisions.map((r) => `
      <div class="history-row" data-rev="${esc(r.id)}" style="padding:8px 10px;border-bottom:1px solid var(--border);cursor:pointer;${selected === r.id ? 'background:var(--bg-secondary)' : ''}">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
          <strong>#${r.rev_no} ${esc(r.summary || '')}</strong>
          <span style="font-size:11px">${r.is_live ? `<span class="pill" style="background:#065f46;color:#d1fae5;padding:2px 8px;border-radius:10px">${esc(t('history.live'))}</span>` : ''}
          ${r.published_at && !r.is_live ? `<span style="color:var(--text-muted)">${esc(t('history.published_at', { when: when(r.published_at) }))}</span>` : ''}
          ${r.submission ? `<span style="color:var(--text-muted)"> · ${esc(t('review.status.' + r.submission.status))}</span>` : ''}</span>
        </div>
        <div style="font-size:12px;color:var(--text-muted)">${esc(actorLabel(r))} · ${esc(when(r.created_at))}${r.is_baseline ? ' · ' + esc(t('history.baseline_hint')) : ''}</div>
        <div style="margin-top:4px;display:flex;gap:6px">
          <button class="btn btn-secondary btn-sm" data-preview="${esc(r.id)}">${esc(t('common.preview'))}</button>
          <button class="btn btn-secondary btn-sm" data-compare="${esc(r.id)}">${esc(compareWith === r.id ? t('history.compare_selected') : t('history.compare'))}</button>
          <button class="btn btn-secondary btn-sm" data-restore="${esc(r.id)}" data-revno="${r.rev_no}">${esc(t('history.restore'))}</button>
        </div>
      </div>`).join('') || `<div style="padding:12px">${esc(t('history.empty'))}</div>`;
  }

  async function preview(revId) {
    selected = revId;
    detail.innerHTML = esc(t('common.loading'));
    try {
      const rev = await api.getRevision(type, id, revId);
      const st = rev.state || {};
      let body = '';
      if (type === 'widget') {
        const html = await fetchRevisionRender(type, id, revId);
        const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.style.cssText = 'width:100%;height:240px;border:1px solid var(--border);border-radius:8px;background:#000';
        detail.innerHTML = `<div><strong>${esc(st.name || '')}</strong> <span style="color:var(--text-muted)">${esc(st.widget_type || '')}</span></div>`;
        detail.appendChild(f); f.srcdoc = html;
        detail.insertAdjacentHTML('beforeend', `<pre style="white-space:pre-wrap;font-size:11px;margin-top:8px">${esc(JSON.stringify(st.config || {}, null, 2))}</pre>`);
        return;
      }
      if (type === 'content') {
        body = `<div><strong>${esc(st.filename || '')}</strong> <span style="color:var(--text-muted)">${esc(st.mime_type || '')} · ${st.file_size ? Math.round(st.file_size / 1024) + ' KB' : ''}</span></div>`;
        if (rev.has_file && /^image\//.test(st.mime_type || '')) {
          try { const url = await fetchRevisionFileUrl(type, id, revId); body += `<img src="${url}" style="max-width:100%;max-height:260px;border-radius:8px;margin-top:8px">`; } catch (e) { body += `<div class="err">${esc(e.message)}</div>`; }
        } else if (rev.has_file && /^video\//.test(st.mime_type || '')) {
          try { const url = await fetchRevisionFileUrl(type, id, revId); body += `<video src="${url}" controls style="max-width:100%;max-height:260px;margin-top:8px"></video>`; } catch (e) { body += `<div class="err">${esc(e.message)}</div>`; }
        } else if (!rev.has_file && !st.remote_url) {
          body += `<div style="margin-top:8px;color:#fbbf24">${esc(t('history.bytes_gone'))}</div>`;
        }
        if (st.remote_url) body += `<div style="margin-top:8px">${esc(t('history.remote_url_note'))}<br><code>${esc(st.remote_url)}</code></div>`;
      } else if (type === 'playlist') {
        body = `<div><strong>${esc(st.name || '')}</strong></div><ol style="margin:8px 0 0 18px;padding:0">${(st.items || []).map((it) => `<li>${esc(it.content_id ? 'content ' + it.content_id.slice(0, 8) : it.widget_id ? 'widget ' + it.widget_id.slice(0, 8) : it.child_playlist_id ? 'playlist ' + it.child_playlist_id.slice(0, 8) : '?')} · ${esc(String(it.duration_sec ?? ''))}s${it.zone_id ? ' · zone ' + esc(it.zone_id.slice(0, 8)) : ''}${(it.schedules || []).length ? ' · ' + esc(t('history.has_schedule')) : ''}</li>`).join('')}</ol>`;
      } else if (type === 'layout') {
        const zones = st.zones || [];
        body = `<div><strong>${esc(st.name || '')}</strong> ${st.width}×${st.height}</div>
          <div style="position:relative;width:100%;aspect-ratio:${st.width || 16}/${st.height || 9};background:#111;border-radius:8px;margin-top:8px;overflow:hidden">
          ${zones.map((z) => `<div title="${esc(z.name)}" style="position:absolute;left:${z.x_percent}%;top:${z.y_percent}%;width:${z.width_percent}%;height:${z.height_percent}%;border:1px solid #34d399;background:${esc(z.background_color || '#000')}88;font-size:10px;color:#fff;padding:2px">${esc(z.name)}</div>`).join('')}</div>`;
      } else if (type === 'slide_deck') {
        const slides = (st.doc && st.doc.slides) || [];
        body = `<div><strong>${esc(st.name || '')}</strong> · ${slides.length} ${esc(t('history.slides'))}</div><ol style="margin:8px 0 0 18px;padding:0">${slides.map((sl) => `<li>${esc(sl.name || sl.id)}</li>`).join('')}</ol>`;
      }
      detail.innerHTML = body;
    } catch (e) { detail.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
    load();
  }

  function renderDiff(d, label) {
    const lines = [];
    for (const f of d.fields || []) lines.push(`<li><b>${esc(f.field)}</b>: ${esc(JSON.stringify(f.from))} → ${esc(JSON.stringify(f.to))}</li>`);
    const listy = d.items || d.zones || d.slides;
    if (listy) {
      for (const a of listy.added) lines.push(`<li style="color:#34d399">+ ${esc(JSON.stringify(a))}</li>`);
      for (const r of listy.removed) lines.push(`<li style="color:#f87171">− ${esc(JSON.stringify(r))}</li>`);
      for (const c of listy.changed) lines.push(`<li>~ ${esc(JSON.stringify(c.item))}: ${c.changes.map((x) => esc(x.field) + ' ' + esc(JSON.stringify(x.from)) + '→' + esc(JSON.stringify(x.to))).join(', ')}</li>`);
      if (listy.reordered) lines.push(`<li>${esc(t('history.reordered'))}</li>`);
    }
    detail.innerHTML = `<div><strong>${esc(t('history.changes_vs', { label }))}</strong></div><ul style="margin:8px 0 0 16px;padding:0;font-size:12px">${lines.join('') || `<li>${esc(t('history.no_changes'))}</li>`}</ul>`;
  }

  list.addEventListener('click', async (e) => {
    const p = e.target.closest('[data-preview]'); if (p) return preview(p.dataset.preview);
    const c = e.target.closest('[data-compare]');
    if (c) {
      if (!compareWith) { compareWith = c.dataset.compare; note.textContent = t('history.compare_pick_second'); load(); return; }
      try { const d = await api.diffRevision(type, id, c.dataset.compare, compareWith); renderDiff(d.diff, d.against); } catch (err) { showToast(err.message, 'error'); }
      compareWith = null; load(); return;
    }
    const r = e.target.closest('[data-restore]');
    if (r) {
      if (!confirm(t('history.restore_confirm', { n: r.dataset.revno }))) return;
      try {
        const out = await api.restoreRevision(type, id, r.dataset.restore);
        showToast(t('history.restored_toast', { n: r.dataset.revno }), 'success');
        note.textContent = out.next === 'submit_for_review' ? t('history.next_submit') : out.next === 'publish_draft' ? t('history.next_publish_draft') : t('history.next_publish');
        await load();
        if (onChanged) onChanged(out);
      } catch (err) { showToast(err.message, 'error'); }
    }
  });
  await load();
  return { close };
}
