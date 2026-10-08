import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc } from '../utils.js';
import { t, tn } from '../i18n.js';

/*
 * Automation — inbound hooks and Zapier (server: lib/automation, routes/automation.js, routes/zapier.js).
 *
 * A hook is a secret URL another system calls: a fire panel, Alertus, InformaCast, Zapier, Make, n8n.
 * The URL is shown ONCE (at creation, or after Rotate) because the server keeps only its hash, so
 * the page shows it in a box with a Copy button and says so plainly.
 *
 * Every key below is a literal t('…') so test/i18n-keys-exist.js can see it.
 */

const KIND_LABEL = () => ({
  emergency: t('auto.kind.emergency'),
  mass_notification: t('auto.kind.mass_notification'),
  trigger: t('auto.kind.trigger'),
  data: t('auto.kind.data'),
  playlist: t('auto.kind.playlist'),
});
const KIND_HINT = () => ({
  emergency: t('auto.hint.emergency'),
  mass_notification: t('auto.hint.mass_notification'),
  trigger: t('auto.hint.trigger'),
  data: t('auto.hint.data'),
  playlist: t('auto.hint.playlist'),
});
const EVENT_LABEL = () => ({
  device_offline: t('auto.ev.device_offline'),
  device_online: t('auto.ev.device_online'),
  emergency_raised: t('auto.ev.emergency_raised'),
  emergency_cleared: t('auto.ev.emergency_cleared'),
  content_approved: t('auto.ev.content_approved'),
  playlist_published: t('auto.ev.playlist_published'),
});
const SEV = () => ({ Extreme: t('capf.sev.Extreme'), Severe: t('capf.sev.Severe'), Moderate: t('capf.sev.Moderate'), Minor: t('capf.sev.Minor') });

let cache = { hooks: [], playlists: [], devices: [], groups: [], triggers: [], tables: [], subs: [], api_base: '' };

function ago(sec) {
  if (!sec) return t('capf.never');
  const d = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  if (d < 90) return t('capf.ago_s', { n: d });
  if (d < 5400) return t('capf.ago_m', { n: Math.round(d / 60) });
  return t('capf.ago_h', { n: Math.round(d / 3600) });
}
const nameOf = (list, id) => (list.find((x) => x.id === id) || {}).name || '?';

function scopeSummary(scopes) {
  const s = scopes || [];
  if (s.some((x) => x.scope_kind === 'workspace')) return t('capf.scope_all');
  return s.map((x) => x.scope_kind === 'group' ? nameOf(cache.groups, x.scope_id)
    : x.scope_kind === 'tag' ? `#${x.scope_id}` : nameOf(cache.devices, x.scope_id)).join(', ') || t('capf.scope_none');
}

function summary(h) {
  const c = h.config || {};
  if (h.kind === 'emergency' || h.kind === 'mass_notification') {
    const show = c.playlist_id ? t('capf.shows_playlist', { name: nameOf(cache.playlists, c.playlist_id) }) : t('capf.shows_card');
    return `${scopeSummary(c.scopes)} · ${show} · ${tn('auto.expires_after', c.expires_min || 60)}`;
  }
  if (h.kind === 'trigger') return `${c.op === 'clear' ? t('auto.op.clear') : t('auto.op.fire')}: ${nameOf(cache.triggers, c.trigger_id)}`;
  if (h.kind === 'data') return `${nameOf(cache.tables, c.data_source_id)} · ${c.mode === 'upsert' ? t('auto.mode.upsert') : c.mode === 'append' ? t('auto.mode.append') : t('auto.mode.replace')}`;
  if (h.kind === 'playlist') {
    return c.op === 'stop' ? t('auto.op.stop')
      : `${nameOf(cache.playlists, c.playlist_id)} · ${scopeSummary(c.scopes)} · ${tn('auto.for_minutes', c.minutes || 30)}`;
  }
  return '';
}

function hookCard(h) {
  const live = h.live_alerts > 0 || h.screens_overridden > 0;
  return `
  <div class="card" data-id="${esc(h.id)}" style="margin-bottom:12px;padding:16px;border-left:4px solid ${live ? '#dc2626' : 'var(--border)'}">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start">
      <div style="min-width:0">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <strong style="font-size:15px">${esc(h.name)}</strong>
          <span class="muted" style="font-size:12px">${esc(KIND_LABEL()[h.kind] || h.kind)}</span>
          ${h.enabled ? '' : `<span class="muted" style="font-size:12px">${esc(t('capf.disabled'))}</span>`}
          ${h.live_alerts ? `<span style="font-size:12px;font-weight:700;color:#dc2626">${esc(tn('capf.live_count', h.live_alerts))}</span>` : ''}
          ${h.screens_overridden ? `<span style="font-size:12px;font-weight:700;color:#dc2626">${esc(tn('auto.overridden', h.screens_overridden))}</span>` : ''}
          ${h.has_signing_secret ? `<span class="muted" style="font-size:12px">🔏 ${esc(t('auto.signed'))}</span>` : ''}
        </div>
        <div style="font-size:12px;color:var(--text-secondary);margin-top:6px">${esc(summary(h))}</div>
        <div class="muted" style="font-size:12px;margin-top:4px;word-break:break-all">${esc(h.url_hint)}</div>
        <div class="muted" style="font-size:12px;margin-top:4px">${esc(tn('auto.last_called', h.call_count, { when: ago(h.last_called_at) }))}</div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn btn-secondary btn-sm" data-act="test">${esc(t('auto.test'))}</button>
        <button class="btn btn-secondary btn-sm" data-act="calls">${esc(t('auto.calls'))}</button>
        <button class="btn btn-secondary btn-sm" data-act="rotate">${esc(t('auto.rotate'))}</button>
        <button class="btn btn-secondary btn-sm" data-act="edit">${esc(t('common.edit'))}</button>
        <button class="btn btn-secondary btn-sm" data-act="del" style="color:var(--danger)">${esc(t('common.delete'))}</button>
      </div>
    </div>
    <div class="auto-calls" hidden style="margin-top:12px"></div>
  </div>`;
}

/** The one time a hook's URL can be seen. */
function showUrl(url, name) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1001;padding:16px';
  overlay.innerHTML = `
  <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;width:640px;max-width:100%">
    <h3 style="margin-bottom:8px">${esc(t('auto.url_title', { name }))}</h3>
    <p class="muted" style="font-size:13px;margin-bottom:12px">${esc(t('auto.url_once'))}</p>
    <code id="auUrl" style="display:block;word-break:break-all;padding:10px;background:var(--bg-input);border-radius:var(--radius);font-size:12px">${esc(url)}</code>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;flex-wrap:wrap">
      <button class="btn btn-secondary" id="auCopy">${esc(t('auto.copy'))}</button>
      <button class="btn btn-primary" id="auDone">${esc(t('auto.done'))}</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#auCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(url); showToast(t('auto.copied'), 'success'); }
    catch { const r = document.createRange(); r.selectNodeContents(overlay.querySelector('#auUrl')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  });
  overlay.querySelector('#auDone').addEventListener('click', () => overlay.remove());
}

export async function render(app) {
  app.innerHTML = `<div class="view"><h1>${esc(t('nav.automation'))}</h1>
    <p class="muted">${esc(t('auto.intro'))}</p><div id="autoBody"></div></div>`;
  const body = document.getElementById('autoBody');
  try {
    const [hk, pls, devs, grps, trg, ds, subs] = await Promise.all([
      api.get('/automation'), api.get('/playlists'), api.get('/devices'), api.get('/groups'),
      api.get('/triggers').catch(() => []), api.get('/data-sources').catch(() => []), api.get('/automation/subscriptions').catch(() => []),
    ]);
    const arr = (v, k) => (Array.isArray(v) ? v : (v && v[k]) || []);
    cache = {
      hooks: hk.hooks || [], api_base: hk.api_base || '',
      playlists: arr(pls, 'playlists'), devices: arr(devs, 'devices'), groups: arr(grps, 'groups'),
      triggers: arr(trg, 'triggers').filter((x) => x.kind !== 'emergency'),
      tables: arr(ds, 'data_sources').filter((x) => x.type === 'table'),
      subs: Array.isArray(subs) ? subs : [],
    };
  } catch (e) {
    body.innerHTML = `<p class="error">${esc((e && e.message) || t('common.error'))}</p>`;
    return;
  }
  body.innerHTML = `
    <div class="toolbar"><button class="btn btn-primary" id="autoNew">${esc(t('auto.new'))}</button></div>
    ${cache.hooks.length ? cache.hooks.map(hookCard).join('') : `<p class="muted">${esc(t('auto.empty'))}</p>`}
    <h2 style="margin-top:28px;font-size:18px">${esc(t('auto.zapier_title'))}</h2>
    <p class="muted" style="font-size:13px">${esc(t('auto.zapier_intro'))}</p>
    <div class="card" style="padding:16px;margin-bottom:12px;font-size:13px">
      <div>${esc(t('auto.zapier_base'))}</div>
      <code style="display:block;word-break:break-all;padding:8px;background:var(--bg-input);border-radius:var(--radius);margin:6px 0">${esc(cache.api_base)}</code>
      <div class="muted">${esc(t('auto.zapier_token'))}</div>
    </div>
    <h3 style="font-size:15px;margin:12px 0 8px">${esc(t('auto.subs_title'))}</h3>
    ${cache.subs.length ? `<table class="table"><thead><tr><th>${esc(t('auto.col.event'))}</th><th>${esc(t('auto.col.receiver'))}</th><th>${esc(t('auto.col.delivered'))}</th><th></th></tr></thead><tbody>
      ${cache.subs.map((s) => `<tr data-sub="${esc(s.id)}"><td>${esc(EVENT_LABEL()[s.event] || s.event)}</td><td>${esc(s.target_host)}${s.token_name ? ` <span class="muted">(${esc(s.token_name)})</span>` : ''}</td>
        <td>${esc(t('auto.delivered', { ok: (s.deliveries || {}).ok || 0, failed: (s.deliveries || {}).failed || 0, pending: (s.deliveries || {}).pending || 0 }))}${s.last_error ? `<div style="color:#ca8a04;font-size:12px">${esc(s.last_error)}</div>` : ''}</td>
        <td><button class="btn btn-secondary btn-sm" data-unsub="${esc(s.id)}" style="color:var(--danger)">${esc(t('auto.unsubscribe'))}</button></td></tr>`).join('')}
      </tbody></table>` : `<p class="muted" style="font-size:13px">${esc(t('auto.subs_empty'))}</p>`}`;

  document.getElementById('autoNew').addEventListener('click', () => openForm(app, null));
  body.querySelectorAll('[data-unsub]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(t('auto.confirm_unsub'))) return;
    try { await api.delete(`/automation/subscriptions/${b.dataset.unsub}`); render(app); }
    catch (e) { showToast((e && e.message) || t('common.error'), 'error'); }
  }));
  body.querySelectorAll('.card[data-id]').forEach((card) => {
    const h = cache.hooks.find((x) => x.id === card.dataset.id);
    card.querySelector('[data-act="edit"]').addEventListener('click', () => openForm(app, h));
    card.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (!confirm(t('auto.confirm_delete', { name: h.name }))) return;
      try { await api.delete(`/automation/${h.id}`); showToast(t('auto.deleted'), 'success'); render(app); }
      catch (e) { showToast((e && e.message) || t('common.error'), 'error'); }
    });
    card.querySelector('[data-act="rotate"]').addEventListener('click', async () => {
      if (!confirm(t('auto.confirm_rotate'))) return;
      try { const r = await api.post(`/automation/${h.id}/rotate`, {}); showUrl(r.url, h.name); }
      catch (e) { showToast((e && e.message) || t('common.error'), 'error'); }
    });
    card.querySelector('[data-act="test"]').addEventListener('click', async (ev) => {
      const takesOver = ['emergency', 'mass_notification', 'playlist', 'trigger'].includes(h.kind);
      if (takesOver && !confirm(t('auto.confirm_test'))) return;
      ev.target.disabled = true;
      try {
        const r = await api.post(`/automation/${h.id}/test`, {});
        showToast(r.outcome || t('auto.tested'), r.ok ? 'success' : 'error');
        render(app);
      } catch (e) { showToast((e && e.message) || t('common.error'), 'error'); ev.target.disabled = false; }
    });
    card.querySelector('[data-act="calls"]').addEventListener('click', async () => {
      const box = card.querySelector('.auto-calls');
      if (!box.hidden) { box.hidden = true; return; }
      box.hidden = false;
      box.innerHTML = '<span class="muted">…</span>';
      try {
        const rows = await api.get(`/automation/${h.id}/calls`);
        box.innerHTML = rows.length ? `<table class="table"><thead><tr><th>${esc(t('auto.col.when'))}</th><th>${esc(t('auto.col.status'))}</th><th>${esc(t('auto.col.result'))}</th></tr></thead><tbody>
          ${rows.map((c) => `<tr><td>${esc(new Date(c.at * 1000).toLocaleString())}${c.test ? ` <span class="muted">(${esc(t('auto.test_mark'))})</span>` : ''}</td>
            <td style="color:${c.status < 300 ? 'inherit' : '#dc2626'}">${esc(String(c.status))}</td><td>${esc(c.outcome || '')}</td></tr>`).join('')}
          </tbody></table>` : `<span class="muted">${esc(t('auto.no_calls'))}</span>`;
      } catch (e) { box.innerHTML = `<span class="error">${esc((e && e.message) || t('common.error'))}</span>`; }
    });
  });
}

/* ============================== the form ============================== */

function scopePicker(prefix, scopes) {
  const s = scopes || [{ scope_kind: 'workspace' }];
  const kind = s.some((x) => x.scope_kind === 'workspace') ? 'workspace' : s[0] ? s[0].scope_kind : 'workspace';
  const chosen = new Set(s.map((x) => x.scope_id));
  const tag = kind === 'tag' ? (s[0] || {}).scope_id || '' : '';
  return `
    <div class="form-group"><label>${esc(t('capf.f.scope'))}</label>
      <select id="${prefix}Scope" class="input" style="width:auto">
        <option value="workspace" ${kind === 'workspace' ? 'selected' : ''}>${esc(t('capf.scope.workspace'))}</option>
        <option value="group" ${kind === 'group' ? 'selected' : ''}>${esc(t('capf.scope.group'))}</option>
        <option value="device" ${kind === 'device' ? 'selected' : ''}>${esc(t('capf.scope.device'))}</option>
        <option value="tag" ${kind === 'tag' ? 'selected' : ''}>${esc(t('auto.scope.tag'))}</option>
      </select>
      <input id="${prefix}Tag" class="input" style="margin-top:8px" placeholder="lobby" value="${esc(tag)}" ${kind === 'tag' ? '' : 'hidden'}>
      <div id="${prefix}ScopeList" style="margin-top:8px;max-height:160px;overflow:auto;display:flex;flex-direction:column;gap:4px" data-chosen="${esc([...chosen].join(','))}"></div>
    </div>`;
}
function wireScope(root, prefix) {
  const sel = root.querySelector(`#${prefix}Scope`);
  const list = root.querySelector(`#${prefix}ScopeList`);
  const tag = root.querySelector(`#${prefix}Tag`);
  const chosen = new Set((list.dataset.chosen || '').split(',').filter(Boolean));
  const paint = () => {
    const k = sel.value;
    tag.hidden = k !== 'tag';
    const items = k === 'group' ? cache.groups : k === 'device' ? cache.devices : [];
    list.innerHTML = items.map((x) => `<label style="display:flex;gap:8px;align-items:center;font-size:13px">
      <input type="checkbox" value="${esc(x.id)}" ${chosen.has(x.id) ? 'checked' : ''}> ${esc(x.name)}</label>`).join('');
  };
  sel.addEventListener('change', paint);
  paint();
  return () => {
    const k = sel.value;
    if (k === 'workspace') return [{ scope_kind: 'workspace' }];
    if (k === 'tag') return [{ scope_kind: 'tag', scope_id: tag.value.trim() }];
    return [...list.querySelectorAll('input:checked')].map((i) => ({ scope_kind: k, scope_id: i.value }));
  };
}
const field = (id, label, value, { ph = '', hint = '' } = {}) => `<div class="form-group"><label>${esc(label)}</label>
  <input id="${id}" class="input" value="${esc(value == null ? '' : value)}" placeholder="${esc(ph)}">${hint ? `<div class="muted" style="font-size:12px;margin-top:4px">${esc(hint)}</div>` : ''}</div>`;
const select = (id, label, options, value) => `<div class="form-group"><label>${esc(label)}</label>
  <select id="${id}" class="input">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(value) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;

function kindFields(kind, c) {
  const showOpts = [['', t('capf.f.show_card')], ...cache.playlists.map((p) => [p.id, t('capf.f.show_pl', { name: p.name })])];
  if (kind === 'emergency') {
    return `
      ${select('afOp', t('auto.f.op'), [['raise', t('auto.op.raise')], ['clear', t('auto.op.clear_alert')], ['auto', t('auto.op.auto')]], c.op || 'raise')}
      ${field('afHeadline', t('auto.f.headline'), c.headline ?? '{{body.headline}}', { hint: t('auto.f.template_hint') })}
      ${field('afMessage', t('auto.f.message'), c.description ?? '{{body.message}}')}
      ${field('afInstruction', t('auto.f.instruction'), c.instruction || '')}
      ${field('afAlertId', t('auto.f.alert_id'), c.alert_id ?? '{{body.id}}', { hint: t('auto.f.alert_id_hint') })}
      ${field('afClearField', t('auto.f.clear_field'), c.clear_field ?? '{{body.status}}', { hint: t('auto.f.clear_field_hint') })}
      ${select('afSeverity', t('auto.f.severity'), Object.entries(SEV()), c.severity || 'Extreme')}
      ${field('afExpires', t('auto.f.expires'), c.expires_min || 60)}
      ${scopePicker('af', c.scopes)}
      ${select('afShow', t('capf.f.show'), showOpts, c.playlist_id || '')}`;
  }
  if (kind === 'mass_notification') {
    const m = c.mapping || {};
    return `
      <p class="muted" style="font-size:12px">${esc(t('auto.mn_explain'))}</p>
      ${select('afSeverity', t('auto.f.default_severity'), Object.entries(SEV()), c.severity || 'Extreme')}
      ${field('afExpires', t('auto.f.expires'), c.expires_min || 120)}
      ${scopePicker('af', c.scopes)}
      ${select('afShow', t('capf.f.show'), showOpts, c.playlist_id || '')}
      <details style="margin:8px 0"><summary style="cursor:pointer;font-size:13px">${esc(t('auto.mapping'))}</summary>
        <p class="muted" style="font-size:12px">${esc(t('auto.mapping_hint'))}</p>
        ${field('afMapId', t('auto.f.map_id'), m.id || '', { ph: '{{body.alertId}}' })}
        ${field('afMapHeadline', t('auto.f.map_headline'), m.headline || '', { ph: '{{body.title}}' })}
        ${field('afMapMessage', t('auto.f.map_message'), m.message || '', { ph: '{{body.message}}' })}
        ${field('afMapClear', t('auto.f.map_clear'), m.clear || '', { ph: '{{body.status}}' })}
      </details>`;
  }
  if (kind === 'trigger') {
    return `
      ${select('afTrigger', t('auto.f.trigger'), cache.triggers.map((x) => [x.id, x.name]), c.trigger_id || '')}
      ${select('afOp', t('auto.f.op'), [['fire', t('auto.op.fire')], ['clear', t('auto.op.clear')]], c.op || 'fire')}
      <p class="muted" style="font-size:12px">${esc(t('auto.trigger_note'))}</p>`;
  }
  if (kind === 'data') {
    return `
      ${select('afTable', t('auto.f.table'), cache.tables.map((x) => [x.id, x.name]), c.data_source_id || '')}
      ${select('afMode', t('auto.f.mode'), [['replace', t('auto.mode.replace')], ['upsert', t('auto.mode.upsert')], ['append', t('auto.mode.append')]], c.mode || 'replace')}
      ${field('afKey', t('auto.f.key_column'), c.key_column || '', { hint: t('auto.f.key_hint') })}
      ${field('afRows', t('auto.f.rows'), c.rows || '{{body}}', { hint: t('auto.f.rows_hint') })}`;
  }
  return `
    ${select('afOp', t('auto.f.op'), [['start', t('auto.op.start')], ['stop', t('auto.op.stop')]], c.op || 'start')}
    ${select('afPlaylist', t('auto.f.playlist'), cache.playlists.map((p) => [p.id, p.name]), c.playlist_id || '')}
    ${field('afMinutes', t('auto.f.minutes'), c.minutes || 30)}
    ${field('afMinutesField', t('auto.f.minutes_field'), c.minutes_field || '', { ph: '{{body.minutes}}' })}
    ${scopePicker('af', c.scopes)}`;
}

function collectConfig(root, kind, getScopes) {
  const v = (id) => { const el = root.querySelector('#' + id); return el ? el.value.trim() : ''; };
  if (kind === 'emergency') {
    return { op: v('afOp'), headline: v('afHeadline'), description: v('afMessage'), instruction: v('afInstruction'), alert_id: v('afAlertId'),
      clear_field: v('afClearField'), severity: v('afSeverity'), expires_min: v('afExpires'), scopes: getScopes(), playlist_id: v('afShow') || null };
  }
  if (kind === 'mass_notification') {
    const mapping = {};
    for (const [k, id] of [['id', 'afMapId'], ['headline', 'afMapHeadline'], ['message', 'afMapMessage'], ['clear', 'afMapClear']]) if (v(id)) mapping[k] = v(id);
    return { severity: v('afSeverity'), expires_min: v('afExpires'), scopes: getScopes(), playlist_id: v('afShow') || null, mapping };
  }
  if (kind === 'trigger') return { trigger_id: v('afTrigger'), op: v('afOp') };
  if (kind === 'data') return { data_source_id: v('afTable'), mode: v('afMode'), key_column: v('afKey') || null, rows: v('afRows') };
  return { op: v('afOp'), playlist_id: v('afPlaylist'), minutes: v('afMinutes'), minutes_field: v('afMinutesField') || null, scopes: getScopes() };
}

function openForm(app, hook) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px';
  const kinds = Object.entries(KIND_LABEL());
  overlay.innerHTML = `
  <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;width:720px;max-width:100%;max-height:92vh;overflow:auto">
    <h3 style="margin-bottom:12px">${esc(hook ? t('auto.edit_title', { name: hook.name }) : t('auto.new'))}</h3>
    ${field('afName', t('capf.f.name'), hook ? hook.name : '', { ph: t('auto.f.name_ph') })}
    ${hook ? '' : select('afKind', t('auto.f.kind'), kinds, 'emergency')}
    <p class="muted" id="afKindHint" style="font-size:12px;margin:-4px 0 8px"></p>
    <div id="afKindFields"></div>
    <details style="margin:8px 0"><summary style="cursor:pointer;font-size:13px">${esc(t('auto.signing'))}</summary>
      <p class="muted" style="font-size:12px">${esc(t('auto.signing_hint'))}</p>
      <input id="afSigning" class="input" type="password" autocomplete="new-password" placeholder="${esc(hook && hook.has_signing_secret ? t('auto.signing_set') : t('auto.signing_none'))}">
      ${hook && hook.has_signing_secret ? `<label style="display:flex;gap:6px;align-items:center;font-size:12px;margin-top:6px"><input type="checkbox" id="afSigningClear"> ${esc(t('auto.signing_remove'))}</label>` : ''}
    </details>
    <label style="display:flex;gap:8px;align-items:center;font-size:13px;margin:8px 0"><input type="checkbox" id="afEnabled" ${!hook || hook.enabled ? 'checked' : ''}> ${esc(t('auto.f.enabled'))}</label>
    ${hook && hook.config && hook.config.via ? '' : `<label style="display:flex;gap:8px;align-items:center;font-size:13px;margin:8px 0 0"><input type="checkbox" id="afAllowGet" ${hook && hook.config && hook.config.allow_get ? 'checked' : ''}> ${esc(t('auto.f.allow_get'))}</label>
    <p class="muted" style="font-size:12px;margin:2px 0 8px 24px">${esc(t('auto.f.allow_get_hint'))}</p>`}
    <div id="afError" style="color:var(--danger);font-size:13px;min-height:18px"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:8px">
      <button class="btn btn-secondary" id="afCancel">${esc(t('common.cancel'))}</button>
      <button class="btn btn-primary" id="afSave">${esc(t('common.save'))}</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const $ = (id) => overlay.querySelector('#' + id);
  let kind = hook ? hook.kind : 'emergency';
  let getScopes = () => [{ scope_kind: 'workspace' }];
  const paint = () => {
    $('afKindHint').textContent = KIND_HINT()[kind] || '';
    $('afKindFields').innerHTML = kindFields(kind, hook && hook.kind === kind ? hook.config || {} : {});
    if (overlay.querySelector('#afScope')) getScopes = wireScope(overlay, 'af');
  };
  if ($('afKind')) $('afKind').addEventListener('change', () => { kind = $('afKind').value; paint(); });
  paint();
  $('afCancel').addEventListener('click', () => overlay.remove());
  $('afSave').addEventListener('click', async () => {
    const body = { name: $('afName').value.trim(), enabled: $('afEnabled').checked, config: collectConfig(overlay, kind, getScopes) };
    if (!hook) body.kind = kind;
    if ($('afAllowGet')) body.allow_get = $('afAllowGet').checked;
    const s = $('afSigning').value;
    if (s) body.signing_secret = s;
    else if ($('afSigningClear') && $('afSigningClear').checked) body.signing_secret = '';
    $('afSave').disabled = true;
    try {
      if (hook) { await api.put(`/automation/${hook.id}`, body); overlay.remove(); showToast(t('auto.saved'), 'success'); render(app); }
      else { const r = await api.post('/automation', body); overlay.remove(); render(app); showUrl(r.url, r.name); }
    } catch (e) {
      $('afError').textContent = (e && e.message) || t('common.error');
      $('afSave').disabled = false;
    }
  });
}
