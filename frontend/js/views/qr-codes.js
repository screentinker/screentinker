import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc } from '../utils.js';
import { t, tn } from '../i18n.js';

/*
 * QR codes — tracked short links (server: lib/qr-links.js). The short address is this dashboard's
 * own origin + /q/<code>: the address operators reach the server by is the one phones can reach.
 * A scan stores only a time and a coarse platform.
 */

const shortUrl = (l) => `${location.origin}${l.path}`;
let links = [];

function bars(days) {
  const max = Math.max(1, ...days.map((d) => d.scans));
  return `<div style="display:flex;align-items:flex-end;gap:2px;height:60px;margin:8px 0">${days.map((d) =>
    `<div title="${esc(d.date)}: ${d.scans}" style="flex:1;background:var(--accent, #3b82f6);opacity:${d.scans ? 1 : 0.15};height:${Math.max(2, Math.round((d.scans / max) * 60))}px;border-radius:2px 2px 0 0"></div>`).join('')}</div>`;
}

function card(l) {
  return `<div class="card" data-id="${esc(l.id)}" style="margin-bottom:12px;padding:16px">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div style="min-width:0">
        <div style="display:flex;gap:8px;align-items:center"><strong>${esc(l.name)}</strong>${l.enabled ? '' : `<span class="muted" style="font-size:12px">${esc(t('qr.off'))}</span>`}</div>
        <div style="font-size:13px;margin-top:4px"><code>${esc(shortUrl(l))}</code>
          <button class="btn btn-secondary btn-sm" data-act="copy" style="margin-left:6px">${esc(t('qr.copy'))}</button></div>
        <div class="muted" style="font-size:12px;margin-top:4px;word-break:break-all">→ ${esc(l.target_url)}</div>
        <div style="font-size:13px;margin-top:6px">${esc(tn('qr.scans', l.scans))} · ${esc(t('qr.last7', { n: l.last_7_days }))}</div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:flex-start">
        <button class="btn btn-secondary btn-sm" data-act="stats">${esc(t('qr.stats'))}</button>
        <button class="btn btn-secondary btn-sm" data-act="svg">${esc(t('qr.download'))}</button>
        <button class="btn btn-secondary btn-sm" data-act="edit">${esc(t('common.edit'))}</button>
        <button class="btn btn-secondary btn-sm" data-act="del" style="color:var(--danger)">${esc(t('common.delete'))}</button>
      </div>
    </div>
    <div class="qr-stats" hidden></div>
  </div>`;
}

export async function render(app) {
  app.innerHTML = `<div class="view"><h1>${esc(t('nav.qr_codes'))}</h1><p class="muted">${esc(t('qr.intro'))}</p><div id="qrBody"></div></div>`;
  const body = document.getElementById('qrBody');
  try { links = await api.get('/qr-links'); } catch (e) { body.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  body.innerHTML = `<div class="toolbar"><button class="btn btn-primary" id="qrNew">${esc(t('qr.new'))}</button></div>
    ${links.length ? links.map(card).join('') : `<p class="muted">${esc(t('qr.empty'))}</p>`}
    ${/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname) ? `<p style="font-size:12px;color:#ca8a04;margin-top:12px">${esc(t('qr.private_origin', { origin: location.origin }))}</p>` : ''}`;
  document.getElementById('qrNew').addEventListener('click', () => openForm(app, null));
  body.querySelectorAll('.card[data-id]').forEach((el) => {
    const l = links.find((x) => x.id === el.dataset.id);
    el.querySelector('[data-act="copy"]').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(shortUrl(l)); showToast(t('qr.copied'), 'success'); } catch { showToast(shortUrl(l), 'info'); }
    });
    el.querySelector('[data-act="edit"]').addEventListener('click', () => openForm(app, l));
    el.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (!confirm(t('qr.confirm_delete', { name: l.name }))) return;
      try { await api.delete(`/qr-links/${l.id}`); render(app); } catch (e) { showToast(e.message, 'error'); }
    });
    el.querySelector('[data-act="svg"]').addEventListener('click', async () => {
      try {
        const r = await fetch(`/api/qr-links/${l.id}/qr.svg?origin=${encodeURIComponent(location.origin)}`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
        if (!r.ok) throw new Error(t('common.error'));
        const url = URL.createObjectURL(await r.blob());
        const a = document.createElement('a'); a.href = url; a.download = `qr-${l.code}.svg`; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } catch (e) { showToast(e.message, 'error'); }
    });
    el.querySelector('[data-act="stats"]').addEventListener('click', async () => {
      const box = el.querySelector('.qr-stats');
      if (!box.hidden) { box.hidden = true; return; }
      box.hidden = false; box.textContent = '…';
      try {
        const d = (await api.get(`/qr-links/${l.id}`)).stats;
        box.innerHTML = `<div style="font-size:12px;color:var(--text-muted);margin-top:10px">${esc(t('qr.last30'))}</div>${bars(d.days)}
          <div style="font-size:12px;color:var(--text-secondary)">${esc(t('qr.platforms', d.platforms))}${d.last_scan_at ? ` · ${esc(t('qr.last_scan', { when: new Date(d.last_scan_at * 1000).toLocaleString() }))}` : ''}</div>`;
      } catch (e) { box.textContent = e.message; }
    });
  });
}

function openForm(app, l) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px';
  overlay.innerHTML = `<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;width:520px;max-width:100%">
    <h3 style="margin-bottom:12px">${esc(l ? t('qr.edit_title', { name: l.name }) : t('qr.new'))}</h3>
    <div class="form-group"><label>${esc(t('qr.f.name'))}</label><input id="qrName" class="input" value="${esc(l ? l.name : '')}" placeholder="${esc(t('qr.f.name_ph'))}"></div>
    <div class="form-group"><label>${esc(t('qr.f.target'))}</label><input id="qrTarget" class="input" value="${esc(l ? l.target_url : 'https://')}">
      ${l ? `<div class="muted" style="font-size:12px;margin-top:4px">${esc(t('qr.f.target_hint'))}</div>` : ''}</div>
    ${l ? `<label style="display:flex;gap:8px;font-size:13px"><input type="checkbox" id="qrEnabled" ${l.enabled ? 'checked' : ''}> ${esc(t('qr.f.enabled'))}</label>` : ''}
    <div id="qrError" style="color:var(--danger);font-size:13px;min-height:18px;margin-top:8px"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
      <button class="btn btn-secondary" id="qrCancel">${esc(t('common.cancel'))}</button>
      <button class="btn btn-primary" id="qrSave">${esc(t('common.save'))}</button></div></div>`;
  document.body.appendChild(overlay);
  const $ = (id) => overlay.querySelector('#' + id);
  $('qrCancel').addEventListener('click', () => overlay.remove());
  $('qrSave').addEventListener('click', async () => {
    const body = { name: $('qrName').value.trim(), target_url: $('qrTarget').value.trim() };
    if (l && $('qrEnabled')) body.enabled = $('qrEnabled').checked;
    try {
      if (l) await api.put(`/qr-links/${l.id}`, body); else await api.post('/qr-links', body);
      overlay.remove(); render(app);
    } catch (e) { $('qrError').textContent = e.message; }
  });
}
