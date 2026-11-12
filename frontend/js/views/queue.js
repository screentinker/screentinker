import { api, getAuthHeaders, browserTimezone } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc, canWrite, readOnlyNote } from '../utils.js';
import { t } from '../i18n.js';
import { isPrivateHost } from '../components/private-host.js';
import { renderLog } from '../lib/queue-log.js';

/*
 * "Now serving" queues (server: routes/queues.js, lib/queue/service.js, docs/now-serving-queue.md).
 *
 * One card per queue (v1 expects one per workspace; the server allows more): the number being
 * served, Next / call a number / start of day, the staff sound switch, the customer QR code with a
 * printable view, the staff link (writers only: the server never sends it to a read-only member),
 * the last 20 events and the queue's settings. Polls every 4 s while the page is open.
 */

const POLL_MS = 4000;
let timer = null;
let queues = [];

const abs = (p) => `${location.origin}${p}`;

function card(q) {
  const w = q.can_write;
  return `<div class="corp-card" data-id="${esc(q.id)}" style="margin-bottom:16px;padding:16px">
    <div style="display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap">
      <div style="min-width:220px;flex:1">
        <h3 style="margin:0 0 4px">${esc(q.name)}</h3>
        <div style="font-size:13px;color:var(--text-muted)" data-f="sub"></div>
        <div style="display:flex;align-items:baseline;gap:12px;margin:12px 0">
          <span style="font-size:13px;color:var(--text-secondary)">${esc(t('queue.dash.now_serving'))}</span>
          <span data-f="num" style="font-size:56px;font-weight:800;line-height:1;font-variant-numeric:tabular-nums">&#8211;</span>
        </div>
        ${w ? `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <button class="btn btn-primary" data-act="next" style="font-size:16px;padding:10px 22px">${esc(t('queue.dash.next'))}</button>
          <input class="input" data-f="callNum" type="number" min="1" style="width:110px" placeholder="${esc(t('queue.staff.call_ph'))}">
          <button class="btn btn-secondary" data-act="call">${esc(t('queue.staff.call'))}</button>
          <button class="btn btn-secondary" data-act="reset">${esc(t('queue.staff.start_day'))}</button>
        </div>
        <label style="display:flex;gap:8px;align-items:center;margin-top:12px;font-size:14px"><input type="checkbox" data-act="sound"> ${esc(t('queue.dash.sound'))}</label>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px">${esc(t('queue.dash.sound_hint'))}</div>` : ''}
      </div>
      <div style="text-align:center;min-width:180px">
        <div data-f="qr" style="width:160px;height:160px;margin:0 auto;background:#fff;border-radius:8px;padding:6px"></div>
        <div style="margin-top:8px;display:flex;gap:6px;justify-content:center;flex-wrap:wrap">
          <button class="btn btn-secondary btn-sm" data-act="print">${esc(t('queue.dash.print'))}</button>
          <button class="btn btn-secondary btn-sm" data-act="copy-customer">${esc(t('queue.dash.copy_customer'))}</button>
        </div>
      </div>
    </div>
    ${w ? `<div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border)">
      <strong style="font-size:14px">${esc(t('queue.dash.staff_link'))}</strong>
      <div style="font-size:12px;color:var(--text-muted);margin:4px 0 8px">${esc(t('queue.dash.staff_link_hint'))}</div>
      <div data-f="staff" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"></div>
    </div>` : ''}
    <details style="margin-top:14px"><summary style="cursor:pointer;font-size:14px">${esc(t('queue.staff.log'))}</summary>
      <ol data-f="log" style="list-style:none;padding:0;margin:8px 0 0;font-size:13px"></ol></details>
    ${w ? `<details style="margin-top:10px"><summary style="cursor:pointer;font-size:14px">${esc(t('queue.dash.settings'))}</summary>
      <div style="display:grid;gap:8px;max-width:420px;margin-top:8px">
        <label style="font-size:13px">${esc(t('queue.dash.f_name'))}<input class="input" data-f="name" value="${esc(q.name)}"></label>
        <label style="font-size:13px">${esc(t('queue.dash.f_tz'))}<input class="input" data-f="tz" value="${esc(q.timezone)}"></label>
        <div style="font-size:12px;color:var(--text-muted)">${esc(t('queue.dash.f_tz_hint'))}</div>
        <label style="font-size:13px">${esc(t('queue.dash.f_max'))}<input class="input" data-f="max" type="number" min="1" max="9999" value="${esc(q.max_per_day)}"></label>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary btn-sm" data-act="save">${esc(t('common.save'))}</button>
          <button class="btn btn-secondary btn-sm" data-act="rotate-customer">${esc(t('queue.dash.rotate_customer'))}</button>
          <button class="btn btn-danger btn-sm" data-act="delete">${esc(t('queue.dash.delete'))}</button>
        </div>
      </div></details>` : ''}
    <div data-f="err" style="color:var(--danger);font-size:13px;min-height:16px;margin-top:8px"></div>
  </div>`;
}

function fill(el, q) {
  const f = (k) => el.querySelector(`[data-f="${k}"]`);
  f('num').textContent = q.now_serving > 0 ? String(q.now_serving) : '–';
  f('sub').textContent = t('queue.dash.sub', { waiting: q.waiting, issued: q.last_issued, max: q.max_per_day, tz: q.timezone });
  const sound = el.querySelector('[data-act="sound"]');
  if (sound && document.activeElement !== sound) sound.checked = !!q.sound_on;
  const next = el.querySelector('[data-act="next"]');
  if (next) next.disabled = q.waiting < 1;
  renderLog(f('log'), q.events);
  const staff = f('staff');
  if (staff) {
    const key = q.staff_path ? 'on' : 'off';
    if (staff.dataset.key !== key + (q.staff_path || '')) {
      staff.dataset.key = key + (q.staff_path || '');
      staff.innerHTML = q.staff_path
        ? `<code style="font-size:12px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;max-width:320px">${esc(abs('/queue-staff'))}#&hellip;</code>
           <button class="btn btn-secondary btn-sm" data-act="copy-staff">${esc(t('queue.dash.copy'))}</button>
           <button class="btn btn-secondary btn-sm" data-act="open-staff">${esc(t('queue.dash.open'))}</button>
           <button class="btn btn-secondary btn-sm" data-act="rotate-staff">${esc(t('queue.dash.rotate'))}</button>
           <button class="btn btn-danger btn-sm" data-act="revoke-staff">${esc(t('queue.dash.revoke'))}</button>`
        : `<span style="font-size:13px;color:var(--text-muted)">${esc(t('queue.dash.staff_off'))}</span>
           <button class="btn btn-secondary btn-sm" data-act="rotate-staff">${esc(t('queue.dash.make_staff'))}</button>`;
    }
  }
}

async function qrSvg(q) {
  const r = await fetch(`/api/queues/${encodeURIComponent(q.id)}/qr.svg?origin=${encodeURIComponent(location.origin)}`, { headers: getAuthHeaders(), cache: 'no-store' });
  if (!r.ok) throw new Error(t('queue.dash.qr_failed'));
  return r.text();
}

async function loadQr(el, q) {
  const box = el.querySelector('[data-f="qr"]');
  try {
    const svg = await qrSvg(q);
    // The SVG is drawn by this server's QR library (lib/slide-render.js qrSvg) from a URL it built.
    box.innerHTML = svg;
    const s = box.querySelector('svg');
    if (s) { s.setAttribute('width', '100%'); s.setAttribute('height', '100%'); }
  } catch (e) { box.textContent = e.message; }
}

async function printQr(q) {
  let svg;
  try { svg = await qrSvg(q); } catch (e) { showToast(e.message, 'error'); return; }
  const w = window.open('', '_blank');
  if (!w) { showToast(t('queue.dash.popup_blocked'), 'error'); return; }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(q.name)}</title>
    <style>body{font-family:system-ui,sans-serif;text-align:center;margin:0;padding:12mm}h1{font-size:34pt;margin:0 0 6mm}
    p{font-size:18pt;margin:0 0 8mm}.qr{width:120mm;height:120mm;margin:0 auto}.qr svg{width:100%;height:100%}
    .url{font-size:10pt;color:#555;margin-top:6mm;word-break:break-all}@page{margin:10mm}</style></head>
    <body><h1>${esc(q.name)}</h1><p>${esc(t('queue.print.scan'))}</p><div class="qr">${svg}</div>
    <div class="url">${esc(abs(q.customer_path))}</div></body></html>`);
  w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch { /* the person can print from the tab */ } }, 300);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); showToast(t('queue.dash.copied'), 'success'); }
  catch { window.prompt(t('queue.dash.copy'), text); }
}

function wire(app, el, q0) {
  const id = q0.id;
  const get = () => queues.find((x) => x.id === id) || q0;
  const err = (m) => { el.querySelector('[data-f="err"]').textContent = m || ''; };
  const run = async (fn) => {
    err('');
    try { const q = await fn(); if (q && q.id) { queues = queues.map((x) => (x.id === q.id ? q : x)); fill(el, q); } }
    catch (e) { err(e.message); }
  };
  el.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b || b.type === 'checkbox') return;
    const q = get();
    switch (b.dataset.act) {
      case 'next': return run(() => api.post(`/queues/${id}/next`));
      case 'call': {
        const n = parseInt(el.querySelector('[data-f="callNum"]').value, 10);
        if (!Number.isInteger(n) || n < 1) return err(t('queue.staff.call_invalid'));
        return run(async () => { const r = await api.post(`/queues/${id}/call`, { number: n }); el.querySelector('[data-f="callNum"]').value = ''; return r; });
      }
      case 'reset': if (confirm(t('queue.staff.start_day_confirm'))) return run(() => api.post(`/queues/${id}/reset`)); return;
      case 'print': return printQr(q);
      case 'copy-customer': return copy(abs(q.customer_path));
      case 'copy-staff': return q.staff_path && copy(abs(q.staff_path));
      case 'open-staff': if (q.staff_path) window.open(abs(q.staff_path), '_blank', 'noopener,noreferrer'); return;
      case 'rotate-staff':
        if (q.staff_path && !confirm(t('queue.dash.rotate_confirm'))) return;
        return run(() => api.post(`/queues/${id}/staff-link`));
      case 'revoke-staff': if (confirm(t('queue.dash.revoke_confirm'))) return run(() => api.delete(`/queues/${id}/staff-link`)); return;
      case 'rotate-customer':
        if (!confirm(t('queue.dash.rotate_customer_confirm'))) return;
        await run(() => api.post(`/queues/${id}/customer-link`));
        return loadQr(el, get());
      case 'save': {
        const f = (k) => el.querySelector(`[data-f="${k}"]`).value;
        await run(() => api.put(`/queues/${id}`, { name: f('name').trim(), timezone: f('tz').trim(), max_per_day: parseInt(f('max'), 10) }));
        return;
      }
      case 'delete':
        if (!confirm(t('queue.dash.delete_confirm', { name: q.name }))) return;
        try { await api.delete(`/queues/${id}`); render(app); } catch (e) { err(e.message); }
        return;
      default:
    }
  });
  const sound = el.querySelector('[data-act="sound"]');
  if (sound) sound.addEventListener('change', () => run(() => api.post(`/queues/${id}/sound`, { on: sound.checked })));
}

async function refresh() {
  try {
    const fresh = await api.get('/queues');
    if (fresh.length !== queues.length || fresh.some((q, i) => q.id !== queues[i].id)) return;   // structure changed: next render
    queues = fresh;
    for (const q of queues) {
      const el = document.querySelector(`.corp-card[data-id="${CSS.escape(q.id)}"]`);
      if (el) fill(el, q);
    }
  } catch { /* keep what is shown; the next poll tries again */ }
}

export async function render(app) {
  cleanup();
  app.innerHTML = `<div class="page-header"><div><h1>${esc(t('nav.queue'))}</h1><div class="subtitle">${esc(t('queue.dash.intro'))}</div></div></div><div id="queueBody"></div>`;
  const body = document.getElementById('queueBody');
  try { queues = await api.get('/queues'); } catch (e) { body.innerHTML = `<p class="corp-notice corp-notice-danger">${esc(e.message)}</p>`; return; }
  body.innerHTML = `${canWrite() ? `<div class="corp-toolbar"><button class="btn ${queues.length ? 'btn-secondary' : 'btn-primary'}" id="queueNew">${esc(t('queue.dash.new'))}</button></div>` : readOnlyNote()}
    ${queues.length ? queues.map(card).join('') : `<div class="corp-empty">${esc(t('queue.dash.empty'))}</div>`}
    ${isPrivateHost(location.hostname) ? `<p style="font-size:12px;color:#ca8a04;margin-top:12px">${esc(t('qr.private_origin', { origin: location.origin }))}</p>` : ''}
    <p style="font-size:13px;color:var(--text-muted);margin-top:12px">${esc(t('queue.dash.widget_hint'))}</p>`;
  document.getElementById('queueNew')?.addEventListener('click', async () => {
    const name = prompt(t('queue.dash.new_name'), t('queue.dash.new_default'));
    if (name === null) return;
    try { await api.post('/queues', { name: name.trim() || t('queue.dash.new_default'), timezone: browserTimezone() }); render(app); }
    catch (e) { showToast(e.message, 'error'); }
  });
  for (const q of queues) {
    const el = body.querySelector(`.corp-card[data-id="${CSS.escape(q.id)}"]`);
    fill(el, q);
    wire(app, el, q);
    loadQr(el, q);
  }
  if (queues.length) timer = setInterval(refresh, POLL_MS);
}

export function cleanup() {
  if (timer) { clearInterval(timer); timer = null; }
}
