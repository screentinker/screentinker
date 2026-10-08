import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc } from '../utils.js';
import { t, tn } from '../i18n.js';

/*
 * Alerts — where a workspace hears that a screen went offline and came back (server:
 * lib/alert-channels.js). Credentials are write-only here: the API returns a masked hint, and an
 * edit that leaves the field empty keeps what is stored.
 */

const KINDS = ['slack', 'teams', 'email', 'pagerduty', 'webhook'];
let cache = { channels: [], devices: [], groups: [] };

function ago(sec) {
  if (!sec) return t('alerts.never');
  const d = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  if (d < 5400) return t('alerts.ago_m', { n: Math.max(1, Math.round(d / 60)) });
  if (d < 172800) return t('alerts.ago_h', { n: Math.round(d / 3600) });
  return t('alerts.ago_d', { n: Math.round(d / 86400) });
}
function scopeSummary(c) {
  const s = c.scopes || [];
  if (s.some((x) => x.scope_kind === 'workspace')) return t('alerts.scope_all');
  return s.map((x) => (x.scope_kind === 'group' ? cache.groups : cache.devices).find((g) => g.id === x.scope_id)).filter(Boolean).map((g) => g.name).join(', ') || '—';
}
function target(c) {
  if (c.kind === 'email') return (c.emails || []).join(', ');
  if (c.kind === 'pagerduty') return t('alerts.pd_key', { hint: c.routing_key_hint || '' });
  return c.url_hint || '';
}

function card(c) {
  return `<div class="corp-card" data-id="${esc(c.id)}" style="margin-bottom:12px;padding:16px;border-left:4px solid ${c.last_error ? '#ca8a04' : 'var(--border)'}">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div style="min-width:0">
        <div style="display:flex;gap:8px;align-items:center"><strong>${esc(c.name)}</strong>
          <span class="corp-help" style="font-size:12px">${esc(t(`alerts.kind.${c.kind}`))}</span>
          ${c.enabled ? '' : `<span class="corp-help" style="font-size:12px">${esc(t('alerts.off'))}</span>`}</div>
        <div class="corp-help" style="font-size:12px;margin-top:4px;word-break:break-all">${esc(target(c))}</div>
        <div style="font-size:12px;color:var(--text-secondary);margin-top:6px">${esc(t('alerts.summary', {
          events: c.events.map((e) => t(`alerts.ev.${e}`)).join(', '), n: c.offline_minutes, scope: scopeSummary(c) }))}</div>
        <div class="corp-help" style="font-size:12px;margin-top:4px">${esc(t('alerts.last_sent', { when: ago(c.last_sent_at) }))}${c.last_error ? ` · <span style="color:#ca8a04">${esc(c.last_error)}</span>` : ''}</div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:flex-start">
        <button class="btn btn-secondary btn-sm" data-act="test">${esc(t('alerts.send_test'))}</button>
        <button class="btn btn-secondary btn-sm" data-act="edit">${esc(t('common.edit'))}</button>
        <button class="btn btn-secondary btn-sm" data-act="del" style="color:var(--danger)">${esc(t('common.delete'))}</button>
      </div>
    </div></div>`;
}

export async function render(app) {
  app.innerHTML = `<div class="page-header"><div><h1>${esc(t('nav.alerts'))}</h1><div class="subtitle">${esc(t('alerts.intro'))}</div></div></div><div id="alBody"></div>`;
  const body = document.getElementById('alBody');
  try {
    const [chs, devs, grps] = await Promise.all([api.get('/alert-channels'), api.get('/devices'), api.get('/groups')]);
    cache = { channels: Array.isArray(chs) ? chs : [], devices: Array.isArray(devs) ? devs : (devs.devices || []), groups: Array.isArray(grps) ? grps : (grps.groups || []) };
  } catch (e) { body.innerHTML = `<p class="corp-notice corp-notice-danger">${esc((e && e.message) || t('common.error'))}</p>`; return; }
  body.innerHTML = `<div class="corp-toolbar"><button class="btn btn-primary" id="alNew">${esc(t('alerts.new'))}</button></div>
    ${cache.channels.length ? cache.channels.map(card).join('') : `<div class="corp-empty">${esc(t('alerts.empty'))}</div>`}
    <p class="corp-help" style="font-size:12px;margin-top:16px">${esc(t('alerts.owner_note'))}</p>`;
  document.getElementById('alNew').addEventListener('click', () => openForm(app, null));
  body.querySelectorAll('.corp-card[data-id]').forEach((el) => {
    const c = cache.channels.find((x) => x.id === el.dataset.id);
    el.querySelector('[data-act="edit"]').addEventListener('click', () => openForm(app, c));
    el.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (!confirm(t('alerts.confirm_delete', { name: c.name }))) return;
      try { await api.delete(`/alert-channels/${c.id}`); showToast(t('alerts.deleted'), 'success'); render(app); }
      catch (e) { showToast((e && e.message) || t('common.error'), 'error'); }
    });
    el.querySelector('[data-act="test"]').addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      try { await api.post(`/alert-channels/${c.id}/test`, {}); showToast(t('alerts.test_sent'), 'success'); }
      catch (e) { showToast((e && e.message) || t('common.error'), 'error'); }
      render(app);
    });
  });
}

function openForm(app, ch) {
  const editing = !!ch;
  const kind0 = ch ? ch.kind : 'slack';
  const scopeKind = !ch || (ch.scopes || []).some((s) => s.scope_kind === 'workspace') ? 'workspace' : (ch.scopes || []).some((s) => s.scope_kind === 'group') ? 'group' : 'device';
  const chosen = new Set((ch && ch.scopes || []).map((s) => s.scope_id));
  const ev = new Set(ch ? ch.events : ['device_offline', 'device_online']);
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px';
  overlay.innerHTML = `<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;width:640px;max-width:100%;max-height:92vh;overflow:auto">
    <h3 style="margin-bottom:12px">${esc(editing ? t('alerts.edit_title', { name: ch.name }) : t('alerts.new'))}</h3>
    <div class="form-group"><label>${esc(t('alerts.f.kind'))}</label>
      <select id="alKind" class="input" ${editing ? 'disabled' : ''}>${KINDS.map((k) => `<option value="${k}" ${kind0 === k ? 'selected' : ''}>${esc(t(`alerts.kind.${k}`))}</option>`).join('')}</select></div>
    <div class="form-group"><label>${esc(t('alerts.f.name'))}</label><input id="alName" class="input" value="${esc(ch ? ch.name : '')}" placeholder="${esc(t('alerts.f.name_ph'))}"></div>
    <div id="alKindFields"></div>
    <div class="form-group"><label>${esc(t('alerts.f.events'))}</label>
      <label style="display:flex;gap:8px;font-size:13px"><input type="checkbox" id="alEvOff" ${ev.has('device_offline') ? 'checked' : ''}> ${esc(t('alerts.f.ev_off'))}
        <input type="number" id="alMin" class="input" min="2" max="1440" value="${esc(ch ? ch.offline_minutes : 5)}" style="width:80px;display:inline-block"> ${esc(t('alerts.f.minutes'))}</label>
      <label style="display:flex;gap:8px;font-size:13px;margin-top:6px"><input type="checkbox" id="alEvOn" ${ev.has('device_online') ? 'checked' : ''}> ${esc(t('alerts.f.ev_on'))}</label></div>
    <div class="form-group"><label>${esc(t('alerts.f.scope'))}</label>
      <select id="alScope" class="input" style="width:auto">${['workspace', 'group', 'device'].map((k) => `<option value="${k}" ${scopeKind === k ? 'selected' : ''}>${esc(t(`alerts.scope.${k}`))}</option>`).join('')}</select>
      <div id="alScopeList" style="margin-top:8px;max-height:150px;overflow:auto;display:flex;flex-direction:column;gap:4px"></div></div>
    <label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" id="alEnabled" ${!ch || ch.enabled ? 'checked' : ''}> ${esc(t('alerts.f.enabled'))}</label>
    <div id="alError" style="color:var(--danger);font-size:13px;min-height:18px;margin-top:8px"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
      <button class="btn btn-secondary" id="alCancel">${esc(t('common.cancel'))}</button>
      <button class="btn btn-primary" id="alSave">${esc(t('common.save'))}</button></div></div>`;
  document.body.appendChild(overlay);
  const $ = (id) => overlay.querySelector('#' + id);
  const close = () => overlay.remove();

  function paintKind() {
    const k = $('alKind').value;
    const keep = editing ? t('alerts.f.keep_hint') : '';
    const host = $('alKindFields');
    if (k === 'email') host.innerHTML = `<div class="form-group"><label>${esc(t('alerts.f.emails'))}</label><input id="alEmails" class="input" value="${esc(ch && ch.emails ? ch.emails.join(', ') : '')}" placeholder="ops@example.com, manager@example.com"></div>`;
    else if (k === 'pagerduty') host.innerHTML = `<div class="form-group"><label>${esc(t('alerts.f.pd_key'))}</label><input id="alSecret1" class="input" autocomplete="off" placeholder="${esc(ch && ch.routing_key_hint ? ch.routing_key_hint : '')}">
      <div class="corp-help" style="font-size:12px;margin-top:4px">${esc(t('alerts.f.pd_hint'))} ${esc(keep)}</div></div>`;
    else host.innerHTML = `<div class="form-group"><label>${esc(t(`alerts.f.url_${k}`))}</label><input id="alUrl" class="input" autocomplete="off" placeholder="${esc(ch && ch.url_hint ? ch.url_hint : 'https://…')}">
      <div class="corp-help" style="font-size:12px;margin-top:4px">${esc(t(`alerts.f.url_${k}_hint`))} ${esc(keep)}</div></div>
      ${k === 'webhook' ? `<div class="form-group"><label>${esc(t('alerts.f.secret'))}</label><input id="alSecret2" class="input" autocomplete="off" placeholder="${esc(ch && ch.has_secret ? '••••••' : '')}">
      <div class="corp-help" style="font-size:12px;margin-top:4px">${esc(t('alerts.f.secret_hint'))}</div></div>` : ''}`;
  }
  function paintScope() {
    const k = $('alScope').value;
    const list = k === 'group' ? cache.groups : k === 'device' ? cache.devices : [];
    $('alScopeList').innerHTML = k === 'workspace' ? `<span class="corp-help" style="font-size:12px">${esc(tn('alerts.scope_all_hint', cache.devices.length))}</span>`
      : list.map((x) => `<label style="display:flex;gap:8px;font-size:13px"><input type="checkbox" value="${esc(x.id)}" ${chosen.has(x.id) ? 'checked' : ''}> ${esc(x.name)}</label>`).join('');
  }
  $('alKind').addEventListener('change', paintKind);
  $('alScope').addEventListener('change', paintScope);
  paintKind(); paintScope();
  $('alCancel').addEventListener('click', close);
  let downOnBackdrop = false;
  overlay.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === overlay; });
  overlay.addEventListener('click', (e) => { if (e.target === overlay && downOnBackdrop) close(); });
  $('alSave').addEventListener('click', async () => {
    const k = $('alKind').value;
    const scope = $('alScope').value;
    const ids = [...overlay.querySelectorAll('#alScopeList input:checked')].map((i) => i.value);
    const events = [$('alEvOff').checked && 'device_offline', $('alEvOn').checked && 'device_online'].filter(Boolean);
    const body = { kind: k, name: $('alName').value.trim(), events, offline_minutes: Number($('alMin').value), enabled: $('alEnabled').checked,
      scopes: scope === 'workspace' ? [{ scope_kind: 'workspace' }] : ids.map((id) => ({ scope_kind: scope, scope_id: id })) };
    if (k === 'email') body.emails = $('alEmails').value;
    else if (k === 'pagerduty') body.routing_key = $('alSecret1').value.trim();
    else { body.url = $('alUrl').value.trim(); if (k === 'webhook' && $('alSecret2').value) body.secret = $('alSecret2').value; }
    if (!body.scopes.length) { $('alError').textContent = t('alerts.scope_required'); return; }
    $('alSave').disabled = true;
    try {
      if (editing) { delete body.kind; await api.put(`/alert-channels/${ch.id}`, body); } else await api.post('/alert-channels', body);
      showToast(t('alerts.saved'), 'success'); close(); render(app);
    } catch (e) { $('alError').textContent = (e && e.message) || t('common.error'); $('alSave').disabled = false; }
  });
}
