/*
 * 3.0 Content requests (server: routes/content-requests.js, lib/content-requests.js).
 *
 *   Inbox  what people without an account have sent through a request form: who, what, where, when.
 *          Approve puts it on the chosen screens for its dates (through the release gate); Decline
 *          mails the requester the reason. A request never goes live without one of the two.
 *   Forms  the shareable forms themselves: where a request may go (friendly names over screens,
 *          groups or playlists), the file rules, the lead time, and who may use the link.
 *
 * Every value from the server reaches the page through esc() or textContent.
 */
import { api } from '../api.js';
import { t } from '../i18n.js';
import { esc, hydrateAuthImages } from '../utils.js';
import { showToast } from '../components/toast.js';
import { openModal } from '../components/corporate-ui.js';

const when = (sec) => (sec ? new Date(sec * 1000).toLocaleString() : '');
// A request's dates are calendar days (YYYY-MM-DD), shown in the viewer's own date format. Built
// from the parts, not new Date('YYYY-MM-DD'), which is UTC midnight and a day early west of UTC.
const day = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString() : (s || '');
};
const STATUS = ['pending', 'approved', 'published', 'rejected', 'cancelled', 'all'];
const canWrite = () => {
  try { const u = JSON.parse(localStorage.getItem('user') || 'null'); return !(u && u.current_workspace_role === 'workspace_viewer' && !u.acting_as); } catch { return true; }
};
const linkOf = (f) => `${location.origin}${f.path}`;
// Literal keys (not built by concatenation) so the i18n guard can see every one of them.
const SET_KEY = { open: 'creq.form.set_open', paused: 'creq.form.set_paused', closed: 'creq.form.set_closed' };
const STATUS_KEY = { open: 'creq.form.status_open', paused: 'creq.form.status_paused', closed: 'creq.form.status_closed' };
const ACCESS_KEY = { link: 'creq.form.access_link', email: 'creq.form.access_email', sso: 'creq.form.access_sso' };
const FIELD_KEY = { off: 'creq.form.field_off', optional: 'creq.form.field_optional', required: 'creq.form.field_required' };

export async function render(app) {
  const tab = (location.hash.split('?')[1] || '').includes('tab=forms') ? 'forms' : 'inbox';
  app.innerHTML = `
    <div class="page-header"><div><h1>${esc(t('creq.title'))}</h1><div class="subtitle">${esc(t('creq.subtitle'))}</div></div></div>
    <div class="corp-toolbar" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
      <button class="btn ${tab === 'inbox' ? 'btn-primary' : 'btn-secondary'}" data-tab="inbox">${esc(t('creq.tab.inbox'))}</button>
      <button class="btn ${tab === 'forms' ? 'btn-primary' : 'btn-secondary'}" data-tab="forms">${esc(t('creq.tab.forms'))}</button>
    </div>
    <div id="creqBody"></div>`;
  app.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    location.hash = b.dataset.tab === 'forms' ? '#/requests?tab=forms' : '#/requests';
  }));
  const body = app.querySelector('#creqBody');
  if (tab === 'forms') return renderForms(body);
  return renderInbox(body);
}

// ─── inbox ───────────────────────────────────────────────────────────────────────────────────

async function renderInbox(body) {
  body.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
      <select class="input" id="creqStatus" style="width:auto">${STATUS.map((s) => `<option value="${s}">${esc(t('creq.status.' + s))}</option>`).join('')}</select>
    </div>
    <div class="review-split">
      <div id="creqList" class="settings-section" style="padding:0;max-height:75vh;overflow:auto">${esc(t('common.loading'))}</div>
      <div id="creqDetail" class="settings-section" style="padding:16px;min-height:300px;color:var(--text-muted)">${esc(t('creq.pick_hint'))}</div>
    </div>`;
  const list = body.querySelector('#creqList'), detail = body.querySelector('#creqDetail'), sel = body.querySelector('#creqStatus');
  let selected = null;

  async function load() {
    let rows;
    try { rows = await api.get(`/content-requests/requests?status=${encodeURIComponent(sel.value)}`); }
    catch (e) { list.innerHTML = `<div class="corp-notice corp-notice-danger" style="margin:12px">${esc(e.message)}</div>`; return; }
    list.innerHTML = rows.map((r) => `
      <div data-id="${esc(r.id)}" style="display:flex;gap:10px;padding:10px 12px;border-bottom:1px solid var(--border);cursor:pointer;${selected === r.id ? 'background:var(--bg-secondary)' : ''}">
        <img data-auth-src="/api/content/${esc(r.content_id)}/thumbnail" alt="" style="width:64px;height:40px;object-fit:cover;border-radius:4px;background:var(--bg-secondary);flex:none">
        <div style="min-width:0;flex:1">
          <div style="display:flex;justify-content:space-between;gap:8px"><strong style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.title)}</strong><span class="pill" style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--bg-secondary)">${esc(t('creq.status.' + r.status))}</span></div>
          <div style="font-size:12px;color:var(--text-muted)">${esc(t('creq.from', { name: r.requester_name, email: r.requester_email }))}</div>
          <div style="font-size:12px;color:var(--text-muted)">${esc(day(r.start_date))} → ${esc(day(r.end_date))} · ${esc(r.targets.map((x) => x.label).join(', '))}</div>
        </div>
      </div>`).join('') || `<div style="padding:12px;color:var(--text-muted)">${esc(t('creq.empty'))}</div>`;
    hydrateAuthImages(list);
  }

  async function show(id) {
    selected = id;
    load();
    detail.innerHTML = esc(t('common.loading'));
    let r;
    try { r = await api.get(`/content-requests/requests/${encodeURIComponent(id)}`); }
    catch (e) { detail.innerHTML = `<div class="corp-notice corp-notice-danger">${esc(e.message)}</div>`; return; }
    const c = r.content || {};
    detail.style.color = 'var(--text-primary, inherit)';
    const verified = { none: 'creq.verified.none', email: 'creq.verified.email', sso: 'creq.verified.sso' }[r.verified_via] || 'creq.verified.none';
    detail.innerHTML = `
      <h3 style="margin:0">${esc(r.title)} <span style="font-size:12px;color:var(--text-muted)">${esc(r.ref)}</span></h3>
      <div style="font-size:13px;margin:6px 0">${esc(t('creq.from', { name: r.requester_name, email: r.requester_email }))} · <span style="color:var(--text-muted)">${esc(t(verified))}</span></div>
      <div style="font-size:13px;color:var(--text-muted)">${esc(t('creq.sent', { when: when(r.created_at), form: r.form_title || '' }))}</div>
      <div style="margin:12px 0"><img data-auth-src="/api/content/${esc(c.id || '')}/thumbnail" alt="" style="max-width:100%;max-height:240px;border-radius:8px;background:#000"></div>
      <div style="font-size:12px;color:var(--text-muted)">${esc(c.mime_type || '')}${c.width ? ` · ${esc(String(c.width))}×${esc(String(c.height))}` : ''}${c.duration_sec ? ` · ${esc(String(Math.round(c.duration_sec)))}s` : ''}</div>
      <dl style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:13px;margin:12px 0">
        <dt style="color:var(--text-muted)">${esc(t('creq.dates'))}</dt><dd style="margin:0">${esc(day(r.start_date))} → ${esc(day(r.end_date))}</dd>
        ${r.audience ? `<dt style="color:var(--text-muted)">${esc(t('creq.audience'))}</dt><dd style="margin:0">${esc(r.audience)}</dd>` : ''}
        ${r.notes ? `<dt style="color:var(--text-muted)">${esc(t('creq.notes'))}</dt><dd style="margin:0;white-space:pre-wrap">${esc(r.notes)}</dd>` : ''}
        ${r.reason ? `<dt style="color:var(--text-muted)">${esc(t('creq.reason'))}</dt><dd style="margin:0;white-space:pre-wrap">${esc(r.reason)}</dd>` : ''}
      </dl>
      <h4 style="margin:12px 0 4px">${esc(t('creq.where'))}</h4>
      <ul style="margin:0 0 0 18px;padding:0;font-size:13px">${r.targets.map((x) => `<li><strong>${esc(x.label)}</strong> → ${esc(x.playlist_name || '?')} · ${esc(t('creq.screens', { n: x.screens }))}
        ${x.result ? (x.result.ok ? ` · <span style="color:#34d399">${esc(t('creq.target_live'))}</span>` : ` · <span style="color:#f87171">${esc(x.result.error || '')}</span>`) : ''}
        ${!x.result && x.problem && r.status === 'pending' ? `<div style="color:#fbbf24;font-size:12px">${esc(x.problem.message)}</div>` : ''}</li>`).join('')}</ul>
      ${r.status === 'pending' && !r.approval_required ? `<p style="font-size:12px;color:var(--text-muted);margin-top:12px">${esc(t('creq.approval_off_note'))}</p>` : ''}
      <div id="creqActions" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;align-items:center"></div>`;
    hydrateAuthImages(detail, { eager: true });
    const actions = detail.querySelector('#creqActions');
    const btn = (attr, label, cls = 'btn-secondary') => `<button class="btn ${cls} btn-sm" ${attr}>${esc(label)}</button>`;
    let a = '';
    if (r.can_decide && canWrite()) a += btn('data-approve', t('creq.approve'), 'btn-primary') + btn('data-reject', t('creq.reject'));
    else if (r.status === 'pending') a += `<span style="font-size:12px;color:#fbbf24">${esc(t('creq.not_reviewer'))}</span>`;
    const failed = r.targets.some((x) => x.result && !x.result.ok);
    if ((r.status === 'approved' || (r.status === 'published' && failed)) && canWrite()) a += btn('data-retry', t('creq.retry'), 'btn-primary');
    actions.innerHTML = a;
    actions.onclick = async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.hasAttribute('data-reject')) { openDecline(r, () => show(r.id)); return; }
      b.disabled = true;
      try {
        if (b.hasAttribute('data-approve')) {
          const out = await api.post(`/content-requests/requests/${encodeURIComponent(r.id)}/approve`, { version: r.submission && r.submission.version });
          showToast(t(out.all_published ? 'creq.toast.approved' : 'creq.toast.partial'), out.all_published ? 'success' : 'error');
        }
        if (b.hasAttribute('data-retry')) {
          const out = await api.post(`/content-requests/requests/${encodeURIComponent(r.id)}/publish`, {});
          showToast(t(out.all_published ? 'creq.toast.approved' : 'creq.toast.partial'), out.all_published ? 'success' : 'error');
        }
      } catch (err) { showToast(err.message, 'error'); }
      await show(r.id);
    };
  }

  list.addEventListener('click', (e) => { const row = e.target.closest('[data-id]'); if (row) show(row.dataset.id); });
  sel.addEventListener('change', load);
  await load();
}

/*
 * Decline asks for the reason in the app's own dialog, not window.prompt. The reason is required —
 * the server refuses an empty one, and it is what the requester is mailed — so Decline stays
 * disabled until something is typed, and a refusal is shown in place with the text kept for another
 * try. Enter adds a line (the reason may be a paragraph); Ctrl/Cmd+Enter declines, Escape cancels.
 * It sends the version the reviewer was looking at, as Approve does, so two people deciding the same
 * request at once get a conflict instead of the second one silently winning.
 */
function openDecline(r, done) {
  const m = openModal({
    title: t('creq.reject_title'),
    body: `<div class="form-group">
        <label for="creqReason">${esc(t('creq.reject_prompt'))}</label>
        <textarea id="creqReason" class="input" rows="4" maxlength="1000" style="width:100%;resize:vertical" aria-describedby="creqReasonErr"></textarea>
      </div>
      <p id="creqReasonErr" role="alert" style="color:var(--danger);font-size:13px;margin:8px 0 0"></p>`,
    footer: `<button type="button" class="btn btn-secondary" data-corp-close>${esc(t('common.cancel'))}</button>
      <button type="button" class="btn btn-danger" data-creq-decline disabled>${esc(t('creq.reject'))}</button>`,
  });
  const input = m.q('#creqReason');
  const go = m.q('[data-creq-decline]');
  const errEl = m.q('#creqReasonErr');
  let busy = false;
  input.addEventListener('input', () => { go.disabled = busy || !input.value.trim(); errEl.textContent = ''; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } });
  go.addEventListener('click', submit);
  input.focus();

  async function submit() {
    const reason = input.value.trim();
    if (busy || !reason) return;
    busy = true;
    go.disabled = true;
    input.disabled = true;
    try {
      await api.post(`/content-requests/requests/${encodeURIComponent(r.id)}/reject`, { reason, version: r.submission && r.submission.version });
    } catch (err) {
      // A conflict (someone else decided it first, or it changed since it was opened) is the
      // server's own sentence, shown here rather than as a toast behind the dialog.
      busy = false;
      input.disabled = false;
      go.disabled = !input.value.trim();
      errEl.textContent = err.message;
      input.focus();
      return;
    }
    m.close();
    showToast(t('creq.toast.rejected'));
    done();
  }
}

// ─── forms ───────────────────────────────────────────────────────────────────────────────────

async function renderForms(body) {
  body.innerHTML = esc(t('common.loading'));
  let forms, opts;
  try { [forms, opts] = await Promise.all([api.get('/content-requests/forms'), api.get('/content-requests/options')]); }
  catch (e) { body.innerHTML = `<div class="corp-notice corp-notice-danger">${esc(e.message)}</div>`; return; }
  body.innerHTML = `
    ${canWrite() ? `<div class="corp-toolbar" style="margin-bottom:12px"><button class="btn btn-primary" id="creqNew">${esc(t('creq.form.new'))}</button></div>` : ''}
    ${forms.length ? forms.map(formCard).join('') : `<div class="corp-empty">${esc(t('creq.form.empty'))}</div>`}`;
  body.querySelector('#creqNew')?.addEventListener('click', () => editForm(body, null, opts));
  body.querySelectorAll('[data-form]').forEach((el) => {
    const f = forms.find((x) => x.id === el.dataset.form);
    el.querySelector('[data-link]').textContent = linkOf(f);
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const act = b.dataset.act;
      try {
        if (act === 'copy') { try { await navigator.clipboard.writeText(linkOf(f)); showToast(t('creq.form.copied'), 'success'); } catch { showToast(linkOf(f)); } return; }
        if (act === 'edit') return editForm(body, f, opts);
        if (act === 'status') { await api.put(`/content-requests/forms/${f.id}`, { status: b.dataset.to }); }
        if (act === 'rotate') { if (!confirm(t('creq.form.rotate_confirm'))) return; await api.post(`/content-requests/forms/${f.id}/rotate`, {}); showToast(t('creq.form.rotated'), 'success'); }
        if (act === 'delete') { if (!confirm(t('creq.form.delete_confirm', { title: f.title }))) return; await api.delete(`/content-requests/forms/${f.id}`); }
        renderForms(body);
      } catch (err) { showToast(err.message, 'error'); }
    });
  });
}

function formCard(f) {
  const w = canWrite();
  const statusBtns = ['open', 'paused', 'closed'].filter((s) => s !== f.status)
    .map((s) => `<button class="btn btn-secondary btn-sm" data-act="status" data-to="${s}">${esc(t(SET_KEY[s]))}</button>`).join('');
  return `<div class="corp-card" data-form="${esc(f.id)}" style="margin-bottom:12px;padding:16px">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div style="min-width:0;flex:1">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><strong>${esc(f.title)}</strong>
          <span class="pill" style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--bg-secondary)">${esc(t(STATUS_KEY[f.status]))}</span>
          <span style="font-size:12px;color:var(--text-muted)">${esc(t(ACCESS_KEY[f.access_mode]))}</span></div>
        <div style="font-size:13px;margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap"><code data-link style="word-break:break-all"></code>
          <button class="btn btn-secondary btn-sm" data-act="copy">${esc(t('creq.form.copy'))}</button></div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:6px">${esc(f.targets.map((x) => `${x.label} → ${x.playlist_name || '?'}`).join(' · '))}</div>
        <div style="font-size:12px;margin-top:4px">${esc(t('creq.form.counts', { pending: f.pending, total: f.total }))}</div>
      </div>
      ${w ? `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:flex-start">
        ${statusBtns}
        <button class="btn btn-secondary btn-sm" data-act="edit">${esc(t('common.edit'))}</button>
        <button class="btn btn-secondary btn-sm" data-act="rotate">${esc(t('creq.form.rotate'))}</button>
        <button class="btn btn-secondary btn-sm" data-act="delete" style="color:var(--danger)">${esc(t('common.delete'))}</button>
      </div>` : ''}
    </div>
  </div>`;
}

function targetRow(opts, tg = {}) {
  const val = tg.device_id ? `device:${tg.device_id}` : tg.group_id ? `group:${tg.group_id}` : tg.playlist_id ? `playlist:${tg.playlist_id}` : '';
  // A group with no playlist has nowhere to put a request (the server refuses it on Save), so it is
  // shown disabled with the reason instead of being offered. One already chosen stays selectable,
  // so an existing form still shows what it points at.
  const noPlaylist = (kind, r) => kind === 'group' && !r.playlist_id;
  const optList = (kind, rows, label) => rows.length ? `<optgroup label="${esc(label)}">${rows.map((r) => {
    const sel = val === `${kind}:${r.id}`, off = noPlaylist(kind, r);
    return `<option value="${kind}:${esc(r.id)}" data-name="${esc(r.name)}" ${sel ? 'selected' : ''} ${off && !sel ? 'disabled' : ''}>${esc(off ? t('creq.form.target_no_playlist', { name: r.name }) : r.name)}</option>`;
  }).join('')}</optgroup>` : '';
  return `<div class="creq-target" data-tid="${esc(tg.id || '')}" style="display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap">
    <input class="input" data-label placeholder="${esc(t('creq.form.target_label'))}" value="${esc(tg.label || '')}" maxlength="80" style="flex:1;min-width:140px">
    <select class="input" data-ref style="flex:1;min-width:160px"><option value="">${esc(t('creq.form.target_pick'))}</option>
      ${optList('device', opts.devices, t('creq.form.target_screens'))}${optList('group', opts.groups, t('creq.form.target_groups'))}${optList('playlist', opts.playlists, t('creq.form.target_playlists'))}
    </select>
    <button type="button" class="btn btn-secondary btn-sm" data-remove>&times;</button>
  </div>`;
}

function editForm(body, f, opts) {
  const v = f || { title: '', intro: '', access_mode: 'link', allowed_domains: '', targets: [], fields: { audience: 'optional', notes: 'optional' }, file_rules: { kinds: ['image', 'video'], max_mb: Math.min(200, opts.max_mb), min_width: 0, min_height: 0, aspect: null, max_video_sec: 0 }, lead_days: 0, max_window_days: 60, item_duration_sec: 10, daily_quota: 20, folder_id: null };
  const r = v.file_rules || {};
  const fieldSel = (name, cur) => `<select class="input" data-field="${name}" style="width:auto">${['off', 'optional', 'required'].map((m) => `<option value="${m}" ${cur === m ? 'selected' : ''}>${esc(t(FIELD_KEY[m]))}</option>`).join('')}</select>`;
  const mode = (m, ok, note) => `<label style="display:flex;gap:8px;align-items:flex-start;margin:6px 0;${ok ? '' : 'opacity:.55'}"><input type="radio" name="creqMode" value="${m}" ${v.access_mode === m ? 'checked' : ''} ${ok ? '' : 'disabled'}><span><strong>${esc(t(ACCESS_KEY[m]))}</strong><br><small style="color:var(--text-muted)">${esc(t(note))}</small></span></label>`;
  body.innerHTML = `<div class="settings-section" style="padding:16px;max-width:760px">
    <h3 style="margin-top:0">${esc(t(f ? 'creq.form.edit' : 'creq.form.new'))}</h3>
    <label class="form-label">${esc(t('creq.form.title_label'))}</label><input class="input" id="cfTitle" maxlength="120" value="${esc(v.title)}">
    <label class="form-label">${esc(t('creq.form.intro_label'))}</label><textarea class="input" id="cfIntro" rows="3" maxlength="2000">${esc(v.intro)}</textarea>
    <h4>${esc(t('creq.form.targets'))}</h4><p style="font-size:12px;color:var(--text-muted)">${esc(t('creq.form.targets_help'))}</p>
    <div id="cfTargets">${(v.targets.length ? v.targets : [{}]).map((x) => targetRow(opts, x)).join('')}</div>
    <button type="button" class="btn btn-secondary btn-sm" id="cfAddTarget">${esc(t('creq.form.add_target'))}</button>
    <h4>${esc(t('creq.form.access'))}</h4>
    ${mode('link', true, 'creq.form.access_link_help')}
    ${mode('email', opts.email_available, opts.email_available ? 'creq.form.access_email_help' : 'creq.form.access_email_off')}
    ${mode('sso', opts.sso_available, opts.sso_available ? 'creq.form.access_sso_help' : 'creq.form.access_sso_off')}
    <label class="form-label">${esc(t('creq.form.domains'))}</label><input class="input" id="cfDomains" placeholder="campus.edu, staff.campus.edu" value="${esc(v.allowed_domains || '')}">
    <h4>${esc(t('creq.form.fields'))}</h4>
    <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:13px"><span>${esc(t('creq.audience'))} ${fieldSel('audience', (v.fields || {}).audience)}</span><span>${esc(t('creq.notes'))} ${fieldSel('notes', (v.fields || {}).notes)}</span></div>
    <h4>${esc(t('creq.form.files'))}</h4>
    <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:13px">
      <label><input type="checkbox" data-kind="image" ${(r.kinds || []).includes('image') ? 'checked' : ''}> ${esc(t('creq.kind.image'))}</label>
      <label><input type="checkbox" data-kind="video" ${(r.kinds || []).includes('video') ? 'checked' : ''}> ${esc(t('creq.kind.video'))}</label>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;margin-top:8px;font-size:13px">
      <label>${esc(t('creq.form.max_mb'))}<input class="input" type="number" id="cfMaxMb" min="1" max="${opts.max_mb}" value="${esc(String(r.max_mb || 50))}"></label>
      <label>${esc(t('creq.form.min_width'))}<input class="input" type="number" id="cfMinW" min="0" value="${esc(String(r.min_width || 0))}"></label>
      <label>${esc(t('creq.form.min_height'))}<input class="input" type="number" id="cfMinH" min="0" value="${esc(String(r.min_height || 0))}"></label>
      <label>${esc(t('creq.form.aspect'))}<select class="input" id="cfAspect">${['', '16:9', '9:16', '4:3', '3:4', '1:1', '21:9'].map((a) => `<option value="${a}" ${(r.aspect || '') === a ? 'selected' : ''}>${esc(a || t('creq.form.aspect_any'))}</option>`).join('')}</select></label>
      <label>${esc(t('creq.form.max_video'))}<input class="input" type="number" id="cfMaxVid" min="0" value="${esc(String(r.max_video_sec || 0))}"></label>
    </div>
    <h4>${esc(t('creq.form.timing'))}</h4>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;font-size:13px">
      <label>${esc(t('creq.form.lead_days'))}<input class="input" type="number" id="cfLead" min="0" max="365" value="${esc(String(v.lead_days))}"></label>
      <label>${esc(t('creq.form.max_window'))}<input class="input" type="number" id="cfWindow" min="1" max="366" value="${esc(String(v.max_window_days))}"></label>
      <label>${esc(t('creq.form.duration'))}<input class="input" type="number" id="cfDuration" min="3" max="600" value="${esc(String(v.item_duration_sec))}"></label>
      <label>${esc(t('creq.form.quota'))}<input class="input" type="number" id="cfQuota" min="1" max="500" value="${esc(String(v.daily_quota))}"></label>
      <label>${esc(t('creq.form.folder'))}<select class="input" id="cfFolder"><option value="">${esc(t('creq.form.folder_root'))}</option>${opts.folders.map((x) => `<option value="${esc(x.id)}" ${v.folder_id === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
    </div>
    <div style="display:flex;gap:8px;margin-top:16px"><button class="btn btn-primary" id="cfSave">${esc(t('common.save'))}</button><button class="btn btn-secondary" id="cfCancel">${esc(t('common.cancel'))}</button></div>
  </div>`;
  const targets = body.querySelector('#cfTargets');
  body.querySelector('#cfAddTarget').addEventListener('click', () => targets.insertAdjacentHTML('beforeend', targetRow(opts)));
  targets.addEventListener('click', (e) => { if (e.target.closest('[data-remove]')) e.target.closest('.creq-target').remove(); });
  // Picking a screen or group suggests its name as the friendly label, which the admin can change.
  targets.addEventListener('change', (e) => {
    const s = e.target.closest('[data-ref]'); if (!s) return;
    const lab = s.closest('.creq-target').querySelector('[data-label]');
    if (!lab.value && s.selectedOptions[0]) lab.value = (s.selectedOptions[0].dataset.name || s.selectedOptions[0].textContent).trim();
  });
  body.querySelector('#cfCancel').addEventListener('click', () => renderForms(body));
  body.querySelector('#cfSave').addEventListener('click', async () => {
    const num = (id) => Number(body.querySelector(id).value);
    const payload = {
      title: body.querySelector('#cfTitle').value.trim(),
      intro: body.querySelector('#cfIntro').value,
      access_mode: (body.querySelector('input[name="creqMode"]:checked') || {}).value || 'link',
      allowed_domains: body.querySelector('#cfDomains').value,
      targets: [...targets.querySelectorAll('.creq-target')].map((row) => {
        const [kind, id] = (row.querySelector('[data-ref]').value || ':').split(':');
        const out = { label: row.querySelector('[data-label]').value.trim() };
        if (row.dataset.tid) out.id = row.dataset.tid;
        if (kind === 'device') out.device_id = id; else if (kind === 'group') out.group_id = id; else if (kind === 'playlist') out.playlist_id = id;
        return out;
      }).filter((x) => x.label || x.device_id || x.group_id || x.playlist_id),
      fields: { audience: body.querySelector('[data-field="audience"]').value, notes: body.querySelector('[data-field="notes"]').value },
      file_rules: {
        kinds: [...body.querySelectorAll('[data-kind]:checked')].map((x) => x.dataset.kind),
        max_mb: num('#cfMaxMb'), min_width: num('#cfMinW'), min_height: num('#cfMinH'), aspect: body.querySelector('#cfAspect').value || null, max_video_sec: num('#cfMaxVid'),
      },
      lead_days: num('#cfLead'), max_window_days: num('#cfWindow'), item_duration_sec: num('#cfDuration'), daily_quota: num('#cfQuota'),
      folder_id: body.querySelector('#cfFolder').value || null,
    };
    try {
      if (f) await api.put(`/content-requests/forms/${f.id}`, payload); else await api.post('/content-requests/forms', payload);
      showToast(t('creq.form.saved'), 'success');
      renderForms(body);
    } catch (err) { showToast(err.message, 'error'); }
  });
}
