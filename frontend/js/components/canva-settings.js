// Settings → Canva: the organization's own Canva integration (server: routes/canva.js /integration).
// Org admins only. The client secret is write-only: it is never shown back, blank keeps it.
import { api } from '../api.js';
import { t } from '../i18n.js';
import { showToast } from './toast.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function mountCanvaSettings(el) {
  if (!el) return;
  let cfg;
  try { cfg = await api.get('/canva/integration'); } catch { el.style.display = 'none'; return; }
  el.style.display = '';
  el.innerHTML = `
    <h3>${esc(t('canva.settings_title'))}</h3>
    <p style="color:var(--text-muted);font-size:12px;margin-bottom:8px">${esc(cfg.instance_configured ? t('canva.settings_blurb_instance') : t('canva.settings_blurb'))}</p>
    <div style="display:grid;gap:10px;max-width:560px">
      <div class="form-group"><label>${esc(t('canva.f_client_id'))}</label>
        <input type="text" class="input" id="canvaClientId" value="${esc(cfg.client_id)}" autocomplete="off"></div>
      <div class="form-group"><label>${esc(t('canva.f_client_secret'))}</label>
        <input type="password" class="input" id="canvaClientSecret" autocomplete="new-password" placeholder="${esc(cfg.has_client_secret ? t('canva.secret_set') : '')}">
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${esc(t('canva.secret_hint'))}</div></div>
      <div style="font-size:12px">
        <div style="color:var(--text-muted)">${esc(t('canva.redirect_label'))}</div>
        <code style="display:block;word-break:break-all;padding:6px;background:var(--bg-secondary);border-radius:4px">${esc(cfg.redirect_uri)}</code>
        <div style="color:var(--text-muted);margin-top:6px">${esc(t('canva.scopes_label'))}</div>
        <code style="display:block;word-break:break-all;padding:6px;background:var(--bg-secondary);border-radius:4px">${esc(cfg.scopes)}</code>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" id="canvaSave">${esc(t('canva.save'))}</button>
        ${cfg.client_id ? `<button class="btn btn-secondary btn-sm" id="canvaTest">${esc(t('canva.test'))}</button>
        <button class="btn btn-danger btn-sm" id="canvaRemove">${esc(t('canva.remove'))}</button>` : ''}
      </div>
      <div id="canvaTestOut" style="font-size:12px"></div>
    </div>`;
  el.querySelector('#canvaSave').addEventListener('click', async () => {
    const body = { client_id: el.querySelector('#canvaClientId').value.trim() };
    const secret = el.querySelector('#canvaClientSecret').value;
    if (secret) body.client_secret = secret;
    try { await api.put('/canva/integration', body); showToast(t('canva.saved'), 'success'); mountCanvaSettings(el); }
    catch (err) { showToast(err.message, 'error'); }
  });
  el.querySelector('#canvaTest')?.addEventListener('click', async () => {
    const out = el.querySelector('#canvaTestOut');
    out.textContent = t('canva.testing');
    try {
      const r = await api.post('/canva/integration/test', {});
      out.innerHTML = `${r.ok ? '✅' : '❌'} ${esc(r.detail || '')}${r.ok ? `<div style="color:var(--text-muted);margin-top:4px">${esc(t('canva.test_caveat'))}</div>` : ''}`;
    } catch (err) { out.textContent = err.message; }
  });
  el.querySelector('#canvaRemove')?.addEventListener('click', async () => {
    if (!confirm(t('canva.remove_confirm'))) return;
    try { await api.delete('/canva/integration'); showToast(t('canva.removed'), 'success'); mountCanvaSettings(el); }
    catch (err) { showToast(err.message, 'error'); }
  });
}
