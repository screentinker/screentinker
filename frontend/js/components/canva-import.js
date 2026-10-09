// Canva in the content library (server: routes/canva.js, lib/canva.js).
//
// mountCanvaCard() fills the toolbar card: "not set up" (with who can set it up), Connect, or the
// connected account with "Add from Canva" and Disconnect. openCanvaPicker() is the design picker:
// search, choose a design, choose pages and a format, optionally make a playlist, import. Imports run
// as server jobs (an export can take a while), so the picker polls until the job settles.
import { api } from '../api.js';
import { t } from '../i18n.js';
import { showToast } from './toast.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ERRORS = {
  refused: 'canva.err_refused',
  expired: 'canva.err_expired',
  bad_state: 'canva.err_expired',
  no_code: 'canva.err_failed',
  not_configured: 'canva.err_not_configured',
  failed: 'canva.err_failed',
};

/** Toast the outcome of a Connect round trip (?canva=connected / ?canva_error=…), then tidy the URL. */
export function reportConnectResult() {
  const qs = (location.hash.split('?')[1] || '');
  if (!qs) return;
  const p = new URLSearchParams(qs);
  if (p.get('canva') === 'connected') showToast(t('canva.connected_toast'), 'success');
  else if (p.get('canva_error')) showToast(t(ERRORS[p.get('canva_error')] || 'canva.err_failed'), 'error');
  else return;
  history.replaceState(null, '', '#/content');
}

export async function waitForJob(id, { timeoutMs = 10 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let wait = 800;
  while (Date.now() < deadline) {
    const j = await api.get(`/canva/jobs/${id}`);
    if (j.status !== 'running') return j;
    await sleep(wait);
    wait = Math.min(wait * 1.3, 3000);
  }
  throw new Error(t('canva.err_timeout'));
}

export async function mountCanvaCard(el, { onImported } = {}) {
  if (!el) return;
  let s;
  try { s = await api.get('/canva/status'); } catch { el.style.display = 'none'; return; }
  el.style.display = '';
  const head = `
    <div style="display:flex;align-items:center;gap:8px;color:var(--text-primary);font-weight:500">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M15.5 9.5a4 4 0 1 0 0 5"/></svg>
      ${esc(t('canva.title'))}
    </div>`;
  if (!s.configured && !s.can_manage && !s.config_error) { el.style.display = 'none'; return; }
  if (!s.configured) {
    el.innerHTML = `${head}
      <p style="font-size:12px;color:var(--text-muted)">${esc(s.config_error || (s.can_manage ? t('canva.not_set_up_admin') : t('canva.not_set_up')))}</p>
      ${s.can_manage ? `<a class="btn btn-secondary" href="#/settings">${esc(t('canva.open_settings'))}</a>` : ''}`;
    return;
  }
  if (!s.connected) {
    el.innerHTML = `${head}
      <p style="font-size:12px;color:var(--text-muted)">${esc(t('canva.connect_desc'))}</p>
      <button class="btn btn-primary" data-canva-connect>${esc(t('canva.connect'))}</button>`;
    el.querySelector('[data-canva-connect]').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const r = await api.post('/canva/connect', {});
        window.location.href = r.url;
      } catch (err) { showToast(err.message, 'error'); e.target.disabled = false; }
    });
    return;
  }
  el.innerHTML = `${head}
    <p style="font-size:12px;color:var(--text-muted)">${esc(t('canva.connected_as', { name: s.display_name || t('canva.your_account') }))}</p>
    <button class="btn btn-primary" data-canva-add>${esc(t('canva.add'))}</button>
    <button class="btn btn-secondary btn-sm" data-canva-disconnect>${esc(t('canva.disconnect'))}</button>`;
  el.querySelector('[data-canva-add]').addEventListener('click', () => openCanvaPicker({ onImported }));
  el.querySelector('[data-canva-disconnect]').addEventListener('click', async () => {
    if (!confirm(t('canva.disconnect_confirm'))) return;
    try { await api.post('/canva/disconnect', {}); showToast(t('canva.disconnected'), 'success'); } catch (err) { showToast(err.message, 'error'); }
    mountCanvaCard(el, { onImported });
  });
}

// folderId: the library's destination; imported pages are filed there (server checks the workspace).
export function openCanvaPicker({ onImported, folderId = null } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="width:860px;max-width:96vw">
      <div class="modal-header"><h3>${esc(t('canva.picker_title'))}</h3><button class="btn-icon" data-close aria-label="${esc(t('common.close'))}">✕</button></div>
      <div class="modal-body" style="max-height:72vh;overflow:auto">
        <div id="canvaStep"></div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('[data-close]').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  const step = overlay.querySelector('#canvaStep');

  let query = '';
  async function showDesigns(continuation = null, append = false) {
    if (!append) {
      step.innerHTML = `
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <input type="search" class="input" id="canvaQuery" placeholder="${esc(t('canva.search_placeholder'))}" value="${esc(query)}" style="flex:1">
          <button class="btn btn-secondary" id="canvaSearchBtn">${esc(t('canva.search'))}</button>
        </div>
        <div id="canvaDesigns" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px"><p>${esc(t('common.loading'))}</p></div>
        <div id="canvaMore" style="margin-top:12px;text-align:center"></div>`;
      const go = () => { query = step.querySelector('#canvaQuery').value.trim(); showDesigns(); };
      step.querySelector('#canvaSearchBtn').addEventListener('click', go);
      step.querySelector('#canvaQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    }
    const grid = step.querySelector('#canvaDesigns');
    const more = step.querySelector('#canvaMore');
    let data;
    try {
      const qs = new URLSearchParams();
      if (query) qs.set('query', query);
      if (continuation) qs.set('continuation', continuation);
      data = await api.get(`/canva/designs?${qs}`);
    } catch (err) { grid.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`; return; }
    const cards = (data.items || []).map((d) => `
      <button type="button" class="content-item" data-design="${esc(d.id)}" style="text-align:left;cursor:pointer;padding:0;border:1px solid var(--border);background:var(--bg-card);border-radius:var(--radius)">
        <div style="aspect-ratio:16/9;background:var(--bg-secondary);display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:var(--radius) var(--radius) 0 0">
          ${d.thumbnail ? `<img src="${esc(d.thumbnail)}" alt="" style="width:100%;height:100%;object-fit:contain" referrerpolicy="no-referrer">` : ''}
        </div>
        <div style="padding:8px;font-size:13px">
          <div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.title)}</div>
          <div style="font-size:11px;color:var(--text-muted)">${d.page_count ? esc(t('canva.pages_count', { n: d.page_count })) : ''}</div>
        </div>
      </button>`).join('');
    if (!append) grid.innerHTML = cards || `<p style="color:var(--text-muted)">${esc(t('canva.no_designs'))}</p>`;
    else grid.insertAdjacentHTML('beforeend', cards);
    more.innerHTML = data.continuation ? `<button class="btn btn-secondary btn-sm" id="canvaLoadMore">${esc(t('canva.load_more'))}</button>` : '';
    more.querySelector('#canvaLoadMore')?.addEventListener('click', () => showDesigns(data.continuation, true));
    grid.querySelectorAll('[data-design]').forEach((b) => b.addEventListener('click', () => showDesign(b.dataset.design)));
  }

  async function showDesign(id) {
    step.innerHTML = `<p>${esc(t('common.loading'))}</p>`;
    let info;
    try { info = await api.get(`/canva/designs/${encodeURIComponent(id)}/pages`); } catch (err) { step.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`; return; }
    const pages = info.pages.length ? info.pages : Array.from({ length: info.design.page_count || 1 }, (_, i) => ({ index: i + 1, thumbnail: null }));
    step.innerHTML = `
      <button class="btn btn-secondary btn-sm" id="canvaBack" style="margin-bottom:12px">← ${esc(t('canva.back'))}</button>
      <h4 style="margin:0 0 8px">${esc(info.design.title)}</h4>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px;font-size:13px">
        <label style="display:flex;gap:6px;align-items:center"><input type="radio" name="canvaFmt" value="png" checked> ${esc(t('canva.format_png'))}</label>
        <label style="display:flex;gap:6px;align-items:center"><input type="radio" name="canvaFmt" value="mp4"> ${esc(t('canva.format_mp4'))}</label>
        <button class="btn btn-secondary btn-sm" id="canvaAll" type="button">${esc(t('canva.select_all'))}</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px">
        ${pages.map((p) => `
          <label style="border:1px solid var(--border);border-radius:var(--radius);padding:6px;cursor:pointer;display:block">
            <div style="aspect-ratio:16/9;background:var(--bg-secondary);display:flex;align-items:center;justify-content:center;overflow:hidden">
              ${p.thumbnail ? `<img src="${esc(p.thumbnail)}" alt="" style="width:100%;height:100%;object-fit:contain" referrerpolicy="no-referrer">` : `<span style="color:var(--text-muted)">${p.index}</span>`}
            </div>
            <div style="display:flex;gap:6px;align-items:center;margin-top:6px;font-size:12px"><input type="checkbox" data-page="${p.index}" checked> ${esc(t('canva.page_n', { n: p.index }))}</div>
          </label>`).join('')}
      </div>
      <label style="display:flex;gap:6px;align-items:center;margin-top:14px;font-size:13px"><input type="checkbox" id="canvaMakePl"> ${esc(t('canva.make_playlist'))}</label>
      <input type="text" class="input" id="canvaPlName" value="${esc(info.design.title)}" style="margin-top:6px;display:none;max-width:360px">
      <p style="font-size:12px;color:var(--text-muted);margin-top:10px">${esc(t('canva.sync_note'))}</p>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
        <span id="canvaBusy" style="font-size:13px;color:var(--text-muted);align-self:center"></span>
        <button class="btn btn-primary" id="canvaImport">${esc(t('canva.import'))}</button>
      </div>`;
    step.querySelector('#canvaBack').addEventListener('click', () => showDesigns());
    step.querySelector('#canvaAll').addEventListener('click', () => {
      const boxes = [...step.querySelectorAll('[data-page]')];
      const on = !boxes.every((b) => b.checked);
      boxes.forEach((b) => { b.checked = on; });
    });
    const mk = step.querySelector('#canvaMakePl');
    mk.addEventListener('change', () => { step.querySelector('#canvaPlName').style.display = mk.checked ? '' : 'none'; });
    step.querySelector('#canvaImport').addEventListener('click', async (e) => {
      const chosen = [...step.querySelectorAll('[data-page]')].filter((b) => b.checked).map((b) => Number(b.dataset.page));
      if (!chosen.length) { showToast(t('canva.choose_pages'), 'error'); return; }
      const body = { design_id: id, pages: chosen, format: step.querySelector('[name=canvaFmt]:checked').value };
      if (mk.checked) body.playlist_name = step.querySelector('#canvaPlName').value.trim() || info.design.title;
      if (folderId) body.folder_id = folderId;
      e.target.disabled = true;
      const busy = step.querySelector('#canvaBusy');
      busy.textContent = t('canva.importing');
      try {
        const { job_id: jobId } = await api.post('/canva/import', body);
        const job = await waitForJob(jobId);
        if (job.status !== 'done') throw new Error(job.error || t('canva.err_failed'));
        showToast(t('canva.imported', { n: job.result.content_ids.length }), 'success');
        close();
        if (onImported) onImported(job.result);
      } catch (err) {
        busy.textContent = '';
        e.target.disabled = false;
        showToast(err.message, 'error');
      }
    });
  }

  showDesigns();
}

/** Linked items in this workspace, by content id. Empty when Canva is not in use. */
export async function loadCanvaLinks() {
  try { return new Map(((await api.get('/canva/links')).links || []).map((l) => [l.content_id, l])); } catch { return new Map(); }
}

export async function syncCanvaLink(contentId) {
  const { job_id: jobId } = await api.post(`/canva/links/${encodeURIComponent(contentId)}/sync`, {});
  const job = await waitForJob(jobId);
  if (job.status !== 'done') throw new Error(job.error || t('canva.err_failed'));
  return job.result;
}
