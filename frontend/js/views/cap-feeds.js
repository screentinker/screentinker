import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc } from '../utils.js';
import { t, tn } from '../i18n.js';

/*
 * Emergency feeds — public CAP alert feeds (server: lib/cap/feeds.js, routes/cap-feeds.js).
 *
 * While an alert in a feed matches its filters, every screen in the feed's scope shows it: the
 * generated alert card, or the playlist chosen here. The page's job is to make that predictable
 * before an emergency, so the form has a Test button that fetches the feed and says, alert by
 * alert, what would be on screen right now.
 */

// Feed addresses verified against the live services (October 2026).
const METEOALARM = ['austria', 'belgium', 'bosnia-herzegovina', 'bulgaria', 'croatia', 'cyprus', 'czechia', 'denmark',
  'estonia', 'finland', 'france', 'germany', 'greece', 'hungary', 'iceland', 'ireland', 'israel', 'italy', 'latvia',
  'lithuania', 'luxembourg', 'malta', 'moldova', 'montenegro', 'netherlands', 'republic-of-north-macedonia', 'norway',
  'poland', 'portugal', 'romania', 'serbia', 'slovakia', 'slovenia', 'spain', 'sweden', 'switzerland', 'ukraine', 'united-kingdom'];
const SEVERITIES = ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'];
const POLLS = [60, 120, 300, 600];

let cache = { feeds: [], playlists: [], devices: [], groups: [] };

function sourceFromUrl(url) {
  let m = /^https:\/\/api\.weather\.gov\/alerts\/active(?:\.atom)?\?area=([A-Z]{2})$/.exec(url || '');
  if (m) return { kind: 'nws_state', value: m[1] };
  m = /^https:\/\/api\.weather\.gov\/alerts\/active(?:\.atom)?\?zone=([A-Z0-9]+)$/.exec(url || '');
  if (m) return { kind: 'nws_zone', value: m[1] };
  m = /^https:\/\/feeds\.meteoalarm\.org\/feeds\/meteoalarm-legacy-atom-([a-z-]+)$/.exec(url || '');
  if (m) return { kind: 'meteoalarm', value: m[1] };
  return { kind: 'custom', value: url || '' };
}
function urlFromSource(kind, value) {
  const v = String(value || '').trim();
  if (kind === 'nws_state') return `https://api.weather.gov/alerts/active.atom?area=${v.toUpperCase()}`;
  if (kind === 'nws_zone') return `https://api.weather.gov/alerts/active.atom?zone=${v.toUpperCase()}`;
  if (kind === 'meteoalarm') return `https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-${v}`;
  return v;
}

function ago(sec) {
  if (!sec) return t('capf.never');
  const d = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  if (d < 90) return t('capf.ago_s', { n: d });
  if (d < 5400) return t('capf.ago_m', { n: Math.round(d / 60) });
  return t('capf.ago_h', { n: Math.round(d / 3600) });
}
function sevChip(sev) {
  const c = { Extreme: '#dc2626', Severe: '#ea580c', Moderate: '#ca8a04', Minor: '#2563eb' }[sev] || '#6b7280';
  return `<span style="font-size:11px;font-weight:700;color:#fff;background:${c};padding:2px 8px;border-radius:10px">${esc(t(`capf.sev.${sev || 'Unknown'}`))}</span>`;
}
function scopeSummary(f) {
  const s = f.scopes || [];
  if (s.some((x) => x.scope_kind === 'workspace')) return t('capf.scope_all');
  const names = s.map((x) => x.scope_kind === 'group'
    ? (cache.groups.find((g) => g.id === x.scope_id) || {}).name
    : (cache.devices.find((d) => d.id === x.scope_id) || {}).name).filter(Boolean);
  return names.join(', ') || t('capf.scope_none');
}

function feedCard(f) {
  const live = f.live_count > 0;
  return `
  <div class="card" data-id="${esc(f.id)}" style="margin-bottom:12px;padding:16px;border-left:4px solid ${live ? '#dc2626' : (f.last_error ? '#ca8a04' : 'var(--border)')}">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start">
      <div style="min-width:0">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <strong style="font-size:15px">${esc(f.name)}</strong>
          ${f.enabled ? '' : `<span class="muted" style="font-size:12px">${esc(t('capf.disabled'))}</span>`}
          ${live ? `<span style="font-size:12px;font-weight:700;color:#dc2626">${esc(tn('capf.live_count', f.live_count))}</span>` : ''}
        </div>
        <div class="muted" style="font-size:12px;margin-top:4px;word-break:break-all">${esc(f.url)}</div>
        <div style="font-size:12px;color:var(--text-secondary);margin-top:6px">
          ${esc(t('capf.summary', { sev: t(`capf.sev.${f.min_severity}`), scope: scopeSummary(f), n: f.screens_in_scope }))}
          · ${esc(f.playlist_id ? t('capf.shows_playlist', { name: (cache.playlists.find((p) => p.id === f.playlist_id) || {}).name || '?' }) : t('capf.shows_card'))}
        </div>
        <div class="muted" style="font-size:12px;margin-top:4px">${esc(t('capf.checked', { when: ago(f.last_polled_at) }))}${f.last_error ? ` · <span style="color:#ca8a04">${esc(f.last_error)}</span>` : ''}</div>
        ${live ? `<div style="margin-top:8px;display:flex;flex-direction:column;gap:4px">${f.live.map((a) => `
          <div style="font-size:13px;display:flex;gap:8px;align-items:center">${sevChip(a.severity)} <span>${esc(a.headline || a.event)}</span></div>`).join('')}</div>` : ''}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn btn-secondary btn-sm" data-act="poll">${esc(t('capf.check_now'))}</button>
        <button class="btn btn-secondary btn-sm" data-act="alerts">${esc(t('capf.recent'))}</button>
        <button class="btn btn-secondary btn-sm" data-act="edit">${esc(t('common.edit'))}</button>
        <button class="btn btn-secondary btn-sm" data-act="del" style="color:var(--danger)">${esc(t('common.delete'))}</button>
      </div>
    </div>
    <div class="cap-alerts" hidden style="margin-top:12px"></div>
  </div>`;
}

export async function render(app) {
  app.innerHTML = `<div class="view"><h1>${esc(t('nav.emergency_feeds'))}</h1>
    <p class="muted">${esc(t('capf.intro'))}</p><div id="capBody"></div></div>`;
  const body = document.getElementById('capBody');
  try {
    const [fs, pls, devs, grps] = await Promise.all([api.get('/cap-feeds'), api.get('/playlists'), api.get('/devices'), api.get('/groups')]);
    cache = {
      feeds: Array.isArray(fs) ? fs : [],
      playlists: Array.isArray(pls) ? pls : (pls.playlists || []),
      devices: Array.isArray(devs) ? devs : (devs.devices || []),
      groups: Array.isArray(grps) ? grps : (grps.groups || []),
    };
  } catch (e) {
    body.innerHTML = `<p class="error">${esc((e && e.message) || t('common.error'))}</p>`;
    return;
  }
  body.innerHTML = `
    <div class="toolbar"><button class="btn btn-primary" id="capNew">${esc(t('capf.new'))}</button></div>
    ${cache.feeds.length ? cache.feeds.map(feedCard).join('') : `<p class="muted">${esc(t('capf.empty'))}</p>`}`;
  document.getElementById('capNew').addEventListener('click', () => openForm(app, null));
  body.querySelectorAll('.card[data-id]').forEach((card) => {
    const f = cache.feeds.find((x) => x.id === card.dataset.id);
    card.querySelector('[data-act="edit"]').addEventListener('click', () => openForm(app, f));
    card.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (!confirm(t('capf.confirm_delete', { name: f.name }))) return;
      try { await api.delete(`/cap-feeds/${f.id}`); showToast(t('capf.deleted'), 'success'); render(app); }
      catch (e) { showToast((e && e.message) || t('common.error'), 'error'); }
    });
    card.querySelector('[data-act="poll"]').addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      try {
        const r = await api.post(`/cap-feeds/${f.id}/poll`, {});
        showToast(r.ok ? tn('capf.checked_ok', r.count) : (r.error || t('common.error')), r.ok ? 'success' : 'error');
        render(app);
      } catch (e) { showToast((e && e.message) || t('common.error'), 'error'); ev.target.disabled = false; }
    });
    card.querySelector('[data-act="alerts"]').addEventListener('click', async () => {
      const box = card.querySelector('.cap-alerts');
      if (!box.hidden) { box.hidden = true; return; }
      box.hidden = false;
      box.innerHTML = `<span class="muted">…</span>`;
      try {
        const rows = await api.get(`/cap-feeds/${f.id}/alerts`);
        box.innerHTML = rows.length ? `<table class="table"><thead><tr><th>${esc(t('capf.col.alert'))}</th><th>${esc(t('capf.col.area'))}</th><th>${esc(t('capf.col.until'))}</th><th>${esc(t('capf.col.state'))}</th></tr></thead><tbody>
          ${rows.map((a) => `<tr><td>${sevChip(a.severity)} ${esc(a.headline || a.event)}</td><td>${esc((a.area || '').slice(0, 120))}</td>
            <td>${a.expires ? esc(new Date(a.expires).toLocaleString()) : ''}</td>
            <td>${esc(a.on_screens ? t('capf.state.on_screens') : a.ended ? t('capf.state.ended') : !a.in_feed ? t('capf.state.gone') : t('capf.state.filtered'))}</td></tr>`).join('')}
          </tbody></table>` : `<span class="muted">${esc(t('capf.no_alerts_yet'))}</span>`;
      } catch (e) { box.innerHTML = `<span class="error">${esc((e && e.message) || t('common.error'))}</span>`; }
    });
  });
}

function openForm(app, feed) {
  const src = sourceFromUrl(feed ? feed.url : '');
  if (!feed) { src.kind = 'nws_state'; src.value = ''; }
  const scopeKind = !feed || (feed.scopes || []).some((s) => s.scope_kind === 'workspace') ? 'workspace'
    : (feed.scopes || []).some((s) => s.scope_kind === 'group') ? 'group' : 'device';
  const chosen = new Set((feed && feed.scopes || []).map((s) => s.scope_id));

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px';
  overlay.innerHTML = `
  <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;width:760px;max-width:100%;max-height:92vh;overflow:auto">
    <h3 style="margin-bottom:12px">${esc(feed ? t('capf.edit_title', { name: feed.name }) : t('capf.new'))}</h3>
    <div class="form-group"><label>${esc(t('capf.f.name'))}</label><input id="cfName" class="input" value="${esc(feed ? feed.name : '')}" placeholder="${esc(t('capf.f.name_ph'))}"></div>
    <div class="form-group"><label>${esc(t('capf.f.source'))}</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <select id="cfKind" class="input" style="width:auto">
          ${['nws_state', 'nws_zone', 'meteoalarm', 'custom'].map((k) => `<option value="${k}" ${src.kind === k ? 'selected' : ''}>${esc(t(`capf.src.${k}`))}</option>`).join('')}
        </select>
        <span id="cfValueHost" style="flex:1;min-width:200px"></span>
      </div>
      <div class="muted" id="cfUrl" style="font-size:12px;margin-top:4px;word-break:break-all"></div>
    </div>
    <div style="display:flex;gap:12px;flex-wrap:wrap">
      <div class="form-group" style="flex:1;min-width:160px"><label>${esc(t('capf.f.min_severity'))}</label>
        <select id="cfSev" class="input">${SEVERITIES.map((s) => `<option value="${s}" ${(feed ? feed.min_severity : 'Severe') === s ? 'selected' : ''}>${esc(t(`capf.sev_at_least.${s}`))}</option>`).join('')}</select></div>
      <div class="form-group" style="flex:1;min-width:160px"><label>${esc(t('capf.f.poll'))}</label>
        <select id="cfPoll" class="input">${POLLS.map((p) => `<option value="${p}" ${(feed ? feed.poll_sec : 120) === p ? 'selected' : ''}>${esc(tn('capf.every_min', p / 60))}</option>`).join('')}</select></div>
    </div>
    <div class="form-group"><label>${esc(t('capf.f.events'))}</label><input id="cfEvents" class="input" value="${esc(feed ? (feed.events || []).join(', ') : '')}" placeholder="${esc(t('capf.f.events_ph'))}">
      <div class="muted" style="font-size:12px;margin-top:4px">${esc(t('capf.f.events_hint'))}</div></div>
    <div class="form-group"><label>${esc(t('capf.f.area'))}</label><input id="cfArea" class="input" value="${esc(feed ? feed.area_match : '')}" placeholder="${esc(t('capf.f.area_ph'))}">
      <div class="muted" style="font-size:12px;margin-top:4px">${esc(t('capf.f.area_hint'))}</div></div>
    <div class="form-group"><label>${esc(t('capf.f.scope'))}</label>
      <select id="cfScope" class="input" style="width:auto">
        ${['workspace', 'group', 'device'].map((k) => `<option value="${k}" ${scopeKind === k ? 'selected' : ''}>${esc(t(`capf.scope.${k}`))}</option>`).join('')}
      </select>
      <div id="cfScopeList" style="margin-top:8px;max-height:160px;overflow:auto;display:flex;flex-direction:column;gap:4px"></div></div>
    <div class="form-group"><label>${esc(t('capf.f.show'))}</label>
      <select id="cfPlaylist" class="input">
        <option value="">${esc(t('capf.f.show_card'))}</option>
        ${cache.playlists.map((p) => `<option value="${esc(p.id)}" ${feed && feed.playlist_id === p.id ? 'selected' : ''}>${esc(t('capf.f.show_pl', { name: p.name }))}</option>`).join('')}
      </select></div>
    <label style="display:flex;gap:8px;align-items:center;font-size:13px;margin:8px 0"><input type="checkbox" id="cfEnabled" ${!feed || feed.enabled ? 'checked' : ''}> ${esc(t('capf.f.enabled'))}</label>
    <div id="cfTest" style="background:var(--bg-input);border-radius:var(--radius);padding:12px;margin:12px 0;font-size:13px" hidden></div>
    <div id="cfError" style="color:var(--danger);font-size:13px;min-height:18px"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:8px">
      <button class="btn btn-secondary" id="cfTestBtn">${esc(t('capf.test'))}</button>
      <button class="btn btn-secondary" id="cfCancel">${esc(t('common.cancel'))}</button>
      <button class="btn btn-primary" id="cfSave">${esc(t('common.save'))}</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const $ = (id) => overlay.querySelector('#' + id);
  const close = () => overlay.remove();

  function paintValue() {
    const kind = $('cfKind').value;
    const host = $('cfValueHost');
    const keep = host.querySelector('#cfValue') ? host.querySelector('#cfValue').value : src.value;
    if (kind === 'meteoalarm') {
      host.innerHTML = `<select id="cfValue" class="input">${METEOALARM.map((c) => `<option value="${c}" ${keep === c ? 'selected' : ''}>${esc(c.replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()))}</option>`).join('')}</select>`;
    } else {
      const ph = { nws_state: 'WI', nws_zone: 'WIZ066', custom: 'https://…' }[kind];
      host.innerHTML = `<input id="cfValue" class="input" value="${esc(kind === 'meteoalarm' ? '' : keep)}" placeholder="${esc(ph)}">`;
    }
    host.querySelector('#cfValue').addEventListener('input', paintUrl);
    host.querySelector('#cfValue').addEventListener('change', paintUrl);
    paintUrl();
  }
  function paintUrl() { $('cfUrl').textContent = urlFromSource($('cfKind').value, $('cfValue').value); }
  function paintScope() {
    const k = $('cfScope').value;
    const list = k === 'group' ? cache.groups : k === 'device' ? cache.devices : [];
    $('cfScopeList').innerHTML = k === 'workspace' ? `<span class="muted" style="font-size:12px">${esc(t('capf.scope_all_hint', { n: cache.devices.length }))}</span>`
      : list.map((x) => `<label style="display:flex;gap:8px;font-size:13px"><input type="checkbox" value="${esc(x.id)}" ${chosen.has(x.id) ? 'checked' : ''}> ${esc(x.name)}</label>`).join('')
        || `<span class="muted" style="font-size:12px">${esc(t('capf.scope_empty'))}</span>`;
  }
  $('cfKind').addEventListener('change', () => { src.value = ''; paintValue(); });
  $('cfScope').addEventListener('change', paintScope);
  paintValue();
  paintScope();

  function collect() {
    const scope = $('cfScope').value;
    const ids = [...overlay.querySelectorAll('#cfScopeList input:checked')].map((i) => i.value);
    return {
      name: $('cfName').value.trim(),
      url: urlFromSource($('cfKind').value, $('cfValue').value),
      min_severity: $('cfSev').value,
      poll_sec: Number($('cfPoll').value),
      events: $('cfEvents').value,
      area_match: $('cfArea').value,
      playlist_id: $('cfPlaylist').value || null,
      enabled: $('cfEnabled').checked,
      scopes: scope === 'workspace' ? [{ scope_kind: 'workspace' }] : ids.map((id) => ({ scope_kind: scope, scope_id: id })),
    };
  }

  $('cfTestBtn').addEventListener('click', async () => {
    const box = $('cfTest');
    box.hidden = false;
    box.textContent = t('capf.testing');
    $('cfError').textContent = '';
    try {
      const r = await api.post('/cap-feeds/test', collect());
      box.innerHTML = `<div style="font-weight:600;margin-bottom:6px">${esc(t('capf.test_result', { total: r.total, n: r.would_show }))}</div>
        ${r.alerts.slice(0, 15).map((a) => `<div style="display:flex;gap:8px;align-items:center;margin:3px 0;opacity:${a.live && a.matches ? 1 : 0.55}">
          ${sevChip(a.severity)} <span>${esc(a.headline || a.event)}</span>
          <span class="muted" style="font-size:11px">${esc(a.live && a.matches ? t('capf.would_show') : !a.live ? t('capf.not_live') : t('capf.filtered_out'))}</span></div>`).join('')}
        ${r.total > 15 ? `<div class="muted" style="font-size:12px">${esc(t('capf.and_more', { n: r.total - 15 }))}</div>` : ''}`;
    } catch (e) { box.hidden = true; $('cfError').textContent = (e && e.message) || t('common.error'); }
  });
  $('cfCancel').addEventListener('click', close);
  let downOnBackdrop = false;
  overlay.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === overlay; });
  overlay.addEventListener('click', (e) => { if (e.target === overlay && downOnBackdrop) close(); });
  $('cfSave').addEventListener('click', async () => {
    const body = collect();
    if (!body.name) { $('cfError').textContent = t('capf.name_required'); return; }
    if (!body.scopes.length) { $('cfError').textContent = t('capf.scope_required'); return; }
    $('cfSave').disabled = true;
    try {
      if (feed) await api.put(`/cap-feeds/${feed.id}`, body); else await api.post('/cap-feeds', body);
      showToast(t('capf.saved'), 'success');
      close();
      render(app);
    } catch (e) { $('cfError').textContent = (e && e.message) || t('common.error'); $('cfSave').disabled = false; }
  });
}
