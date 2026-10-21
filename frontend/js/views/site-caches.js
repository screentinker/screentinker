import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc, canWrite, readOnlyNote } from '../utils.js';
import { t, tn } from '../i18n.js';

/*
 * 3.0 Site caches (server: lib/site-cache, docs/site-cache.md). A box on a site's LAN downloads the
 * media once and that site's screens fetch it from there. Advanced only: it is infrastructure, and
 * the people who set up a Raspberry Pi in a comms cupboard are the people who open Advanced.
 *
 * The box's token is shown ONCE, in the create / rotate response, and never listed again.
 */

let cache = { caches: [], devices: [], groups: [] };

function bytes(n) {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n) || 0;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
function ago(sec) {
  if (!sec) return t('sitecache.never');
  const d = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  if (d < 90) return t('sitecache.ago_s', { n: d });
  if (d < 5400) return t('sitecache.ago_m', { n: Math.round(d / 60) });
  if (d < 172800) return t('sitecache.ago_h', { n: Math.round(d / 3600) });
  return t('sitecache.ago_d', { n: Math.round(d / 86400) });
}
function status(c) {
  if (!c.enabled) return { text: t('sitecache.status_off'), color: 'var(--text-muted)' };
  if (!c.last_seen_at) return { text: t('sitecache.status_waiting'), color: '#ca8a04' };
  if (c.online) return { text: t('sitecache.status_online'), color: 'var(--success, #16a34a)' };
  return { text: t('sitecache.status_offline'), color: 'var(--danger)' };
}
function assignedSummary(c) {
  const g = c.assignments.group_ids.map((id) => cache.groups.find((x) => x.id === id)).filter(Boolean).map((x) => x.name);
  const d = c.assignments.device_ids.map((id) => cache.devices.find((x) => x.id === id)).filter(Boolean).map((x) => x.name);
  const parts = [];
  if (g.length) parts.push(t('sitecache.groups_list', { names: g.join(', ') }));
  if (d.length) parts.push(t('sitecache.screens_list', { names: d.join(', ') }));
  return parts.length ? parts.join(' · ') : t('sitecache.unassigned');
}
/* A web player on an https server cannot fetch http:// (mixed content). Android players can. */
function mixedContent(c) {
  return location.protocol === 'https:' && /^http:/.test(c.lan_url || '');
}

function stat(label, value) {
  return `<div style="min-width:110px"><div class="corp-help" style="font-size:11px">${esc(label)}</div><div style="font-weight:600">${esc(value)}</div></div>`;
}

function card(c) {
  const s = status(c);
  const hitRate = c.hit_rate == null ? '—' : `${Math.round(c.hit_rate * 100)}%`;
  return `<div class="corp-card" data-id="${esc(c.id)}" style="padding:16px;border-left:4px solid ${s.color}">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div style="min-width:0">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><strong>${esc(c.name)}</strong>
          <span style="font-size:12px;color:${s.color}">● ${esc(s.text)}</span></div>
        <div class="corp-help" style="font-size:12px;margin-top:4px;word-break:break-all">${esc(c.lan_url)}${c.node_version ? ` · v${esc(c.node_version)}` : ''}</div>
        <div style="font-size:12px;color:var(--text-secondary);margin-top:6px">${esc(tn('sitecache.screens_n', c.screens))} — ${esc(assignedSummary(c))}</div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:flex-start">
        <button class="btn btn-secondary btn-sm" data-act="assign" ${canWrite('admin') ? '' : 'hidden'}>${esc(t('sitecache.assign'))}</button>
        <button class="btn btn-secondary btn-sm" data-act="edit" ${canWrite('admin') ? '' : 'hidden'}>${esc(t('common.edit'))}</button>
        <button class="btn btn-secondary btn-sm" data-act="rotate" ${canWrite('admin') ? '' : 'hidden'}>${esc(t('sitecache.rotate'))}</button>
        <button class="btn btn-secondary btn-sm" data-act="del" ${canWrite('admin') ? '' : 'hidden'} style="color:var(--danger)">${esc(t('common.delete'))}</button>
      </div>
    </div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:12px">
      ${stat(t('sitecache.disk'), c.disk_used == null ? '—' : t('sitecache.disk_value', { used: bytes(c.disk_used), free: bytes(c.disk_free) }))}
      ${stat(t('sitecache.files'), c.files_wanted == null ? '—' : t('sitecache.files_value', { held: c.files_held || 0, wanted: c.files_wanted }))}
      ${stat(t('sitecache.hit_rate'), hitRate)}
      ${stat(t('sitecache.saved'), bytes(c.bytes_saved))}
      ${stat(t('sitecache.served'), bytes(c.bytes_served))}
      ${stat(t('sitecache.last_sync'), ago(c.last_sync_at))}
    </div>
    ${c.last_error ? `<div style="font-size:12px;color:#ca8a04;margin-top:8px">${esc(c.last_error)}</div>` : ''}
    ${mixedContent(c) ? `<div class="corp-help" style="font-size:12px;margin-top:8px">${esc(t('sitecache.mixed_content'))}</div>` : ''}
  </div>`;
}

export async function render(app) {
  app.innerHTML = `<div class="page-header"><div><h1>${esc(t('nav.site_caches'))}</h1><div class="subtitle">${esc(t('sitecache.intro'))}</div></div></div><div id="scBody"></div>`;
  const body = document.getElementById('scBody');
  try {
    const [list, devs, grps] = await Promise.all([api.get('/site-caches'), api.get('/devices'), api.get('/groups')]);
    cache = {
      caches: Array.isArray(list) ? list : [],
      devices: Array.isArray(devs) ? devs : (devs.devices || []),
      groups: Array.isArray(grps) ? grps : (grps.groups || []),
    };
  } catch (e) { body.innerHTML = `<p class="corp-notice corp-notice-danger">${esc((e && e.message) || t('common.error'))}</p>`; return; }
  body.innerHTML = `${canWrite('admin') ? `<div class="corp-toolbar"><button class="btn btn-primary" id="scNew">${esc(t('sitecache.new'))}</button></div>` : readOnlyNote('admin')}
    ${cache.caches.length ? cache.caches.map(card).join('') : `<div class="corp-empty">${esc(t('sitecache.empty'))}</div>`}
    <p class="corp-help" style="font-size:12px;margin-top:16px">${esc(t('sitecache.how'))}</p>`;
  document.getElementById('scNew')?.addEventListener('click', () => openForm(app, null));
  body.querySelectorAll('.corp-card[data-id]').forEach((el) => {
    const c = cache.caches.find((x) => x.id === el.dataset.id);
    el.querySelector('[data-act="edit"]').addEventListener('click', () => openForm(app, c));
    el.querySelector('[data-act="assign"]').addEventListener('click', () => openAssign(app, c));
    el.querySelector('[data-act="rotate"]').addEventListener('click', async () => {
      if (!confirm(t('sitecache.confirm_rotate', { name: c.name }))) return;
      try { const r = await api.post(`/site-caches/${c.id}/rotate-token`, {}); showSetup(app, r); }
      catch (e) { showToast((e && e.message) || t('common.error'), 'error'); }
    });
    el.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (!confirm(t('sitecache.confirm_delete', { name: c.name }))) return;
      try { await api.delete(`/site-caches/${c.id}`); showToast(t('sitecache.deleted'), 'success'); render(app); }
      catch (e) { showToast((e && e.message) || t('common.error'), 'error'); }
    });
  });
}

function modal(inner) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px';
  overlay.innerHTML = `<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;width:600px;max-width:100%;max-height:92vh;overflow:auto">${inner}</div>`;
  document.body.appendChild(overlay);
  let downOnBackdrop = false;
  overlay.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === overlay; });
  overlay.addEventListener('click', (e) => { if (e.target === overlay && downOnBackdrop) overlay.remove(); });
  return overlay;
}

function openForm(app, c) {
  const editing = !!c;
  const overlay = modal(`<h3 style="margin-bottom:12px">${esc(editing ? t('sitecache.edit_title', { name: c.name }) : t('sitecache.new'))}</h3>
    <div class="form-group"><label>${esc(t('sitecache.f.name'))}</label><input id="scName" class="input" value="${esc(c ? c.name : '')}" placeholder="${esc(t('sitecache.f.name_ph'))}"></div>
    <div class="form-group"><label>${esc(t('sitecache.f.url'))}</label><input id="scUrl" class="input" value="${esc(c ? c.lan_url : '')}" placeholder="http://10.0.0.5:8088" autocomplete="off">
      <div class="corp-help" style="font-size:12px;margin-top:4px">${esc(t('sitecache.f.url_hint'))}</div></div>
    ${editing ? `<label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" id="scEnabled" ${c.enabled ? 'checked' : ''}> ${esc(t('sitecache.f.enabled'))}</label>` : ''}
    <div id="scError" style="color:var(--danger);font-size:13px;min-height:18px;margin-top:8px"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
      <button class="btn btn-secondary" id="scCancel">${esc(t('common.cancel'))}</button>
      <button class="btn btn-primary" id="scSave">${esc(t('common.save'))}</button></div>`);
  const $ = (id) => overlay.querySelector('#' + id);
  $('scCancel').addEventListener('click', () => overlay.remove());
  $('scSave').addEventListener('click', async () => {
    const payload = { name: $('scName').value.trim(), lan_url: $('scUrl').value.trim() };
    if (editing) payload.enabled = $('scEnabled').checked;
    $('scSave').disabled = true;
    try {
      if (editing) {
        await api.put(`/site-caches/${c.id}`, payload);
        overlay.remove(); showToast(t('sitecache.saved_ok'), 'success'); render(app);
      } else {
        const r = await api.post('/site-caches', payload);
        overlay.remove(); showSetup(app, r);
      }
    } catch (e) { $('scError').textContent = (e && e.message) || t('common.error'); $('scSave').disabled = false; }
  });
}

/* The one time the token is visible. Copy buttons, and the three ways to run the box. */
function showSetup(app, r) {
  const s = r.setup || {};
  const port = (() => { try { return new URL(r.lan_url).port || (r.lan_url.startsWith('https') ? '443' : '80'); } catch (_) { return '8088'; } })();
  const node = `SITE_CACHE_FOR=${s.origin} SITE_CACHE_TOKEN=${s.token} SITE_CACHE_PORT=${port} node server.js`;
  const docker = `docker run -d --restart unless-stopped -p ${port}:${port} -v st-site-cache:/data \\\n  -e SITE_CACHE_FOR=${s.origin} -e SITE_CACHE_TOKEN=${s.token} \\\n  -e SITE_CACHE_PORT=${port} ghcr.io/screentinker/screentinker`;
  const block = (id, text) => `<div style="position:relative;margin-top:6px"><pre id="${id}" style="white-space:pre-wrap;word-break:break-all;background:var(--bg-secondary, rgba(0,0,0,0.2));padding:10px;border-radius:6px;font-size:12px;margin:0">${esc(text)}</pre>
    <button class="btn btn-secondary btn-sm" data-copy="${id}" style="margin-top:4px">${esc(t('sitecache.copy'))}</button></div>`;
  const overlay = modal(`<h3 style="margin-bottom:8px">${esc(t('sitecache.setup_title', { name: r.name }))}</h3>
    <p class="corp-notice" style="font-size:13px">${esc(t('sitecache.setup_once'))}</p>
    <div class="form-group"><label>${esc(t('sitecache.setup_token'))}</label>${block('scTok', s.token || '')}</div>
    <div class="form-group"><label>${esc(t('sitecache.setup_node'))}</label>${block('scNode', node)}</div>
    <div class="form-group"><label>${esc(t('sitecache.setup_docker'))}</label>${block('scDocker', docker)}</div>
    <p class="corp-help" style="font-size:12px">${esc(t('sitecache.setup_next'))}</p>
    <div style="display:flex;justify-content:flex-end;margin-top:8px"><button class="btn btn-primary" id="scDone">${esc(t('common.close'))}</button></div>`);
  overlay.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    const text = overlay.querySelector('#' + b.dataset.copy).textContent;
    try { await navigator.clipboard.writeText(text); showToast(t('sitecache.copied'), 'success'); }
    catch (_) { showToast(t('sitecache.copy_failed'), 'error'); }
  }));
  overlay.querySelector('#scDone').addEventListener('click', () => { overlay.remove(); render(app); });
}

function openAssign(app, c) {
  const groups = new Set(c.assignments.group_ids);
  const devices = new Set(c.assignments.device_ids);
  const row = (kind, x, on) => `<label style="display:flex;gap:8px;font-size:13px"><input type="checkbox" data-kind="${kind}" value="${esc(x.id)}" ${on ? 'checked' : ''}> ${esc(x.name)}</label>`;
  const overlay = modal(`<h3 style="margin-bottom:8px">${esc(t('sitecache.assign_title', { name: c.name }))}</h3>
    <p class="corp-help" style="font-size:12px;margin-bottom:12px">${esc(t('sitecache.assign_hint'))}</p>
    <div class="form-group"><label>${esc(t('sitecache.assign_groups'))}</label>
      <div style="max-height:180px;overflow:auto;display:flex;flex-direction:column;gap:4px">${cache.groups.length ? cache.groups.map((g) => row('group', g, groups.has(g.id))).join('') : `<span class="corp-help" style="font-size:12px">${esc(t('sitecache.no_groups'))}</span>`}</div></div>
    <div class="form-group"><label>${esc(t('sitecache.assign_screens'))}</label>
      <div style="max-height:220px;overflow:auto;display:flex;flex-direction:column;gap:4px">${cache.devices.map((d) => row('device', d, devices.has(d.id))).join('')}</div></div>
    <div id="scaError" style="color:var(--danger);font-size:13px;min-height:18px;margin-top:8px"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
      <button class="btn btn-secondary" id="scaCancel">${esc(t('common.cancel'))}</button>
      <button class="btn btn-primary" id="scaSave">${esc(t('common.save'))}</button></div>`);
  overlay.querySelector('#scaCancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#scaSave').addEventListener('click', async () => {
    const picked = (kind) => [...overlay.querySelectorAll(`input[data-kind="${kind}"]:checked`)].map((i) => i.value);
    try {
      await api.put(`/site-caches/${c.id}/assignments`, { group_ids: picked('group'), device_ids: picked('device') });
      overlay.remove(); showToast(t('sitecache.saved_ok'), 'success'); render(app);
    } catch (e) { overlay.querySelector('#scaError').textContent = (e && e.message) || t('common.error'); }
  });
}
