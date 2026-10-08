/*
 * The 'bi-dashboard' widget editor (server/lib/bi/widget.js validates what this sends).
 *
 * Two ways in: one of the organization's BI connections (Settings → BI dashboards), or a public link
 * that needs no credentials. For Grafana and Power BI the connection can list what it sees, so the
 * editor offers a picker; Tableau takes a pasted view address.
 */
import { esc } from '../utils.js';
import { t } from '../i18n.js';

const PROVIDERS = {
  grafana: () => t('bi.kind_grafana'),
  powerbi: () => t('bi.kind_powerbi'),
  tableau: () => t('bi.kind_tableau'),
};

let state = null;

export async function mountBiEditor(host, config, { apiGet }) {
  if (!host) return;
  const c = config || {};
  let connections = [];
  try { connections = ((await apiGet('/bi-connections')) || {}).connections || []; } catch { connections = []; }
  state = { host, apiGet, connections };
  const provider = c.provider || (connections[0] && connections[0].kind) || 'grafana';
  host.innerHTML = `
    <div class="form-group"><label>${esc(t('bi.w_provider'))}</label>
      <select id="biProvider" class="input">${Object.keys(PROVIDERS).map((k) => `<option value="${k}" ${k === provider ? 'selected' : ''}>${esc(PROVIDERS[k]())}</option>`).join('')}</select></div>
    <div class="form-group"><label>${esc(t('bi.w_source'))}</label>
      <select id="biMode" class="input">
        <option value="connection" ${c.mode !== 'public' ? 'selected' : ''}>${esc(t('bi.w_source_connection'))}</option>
        <option value="public" ${c.mode === 'public' ? 'selected' : ''}>${esc(t('bi.w_source_public'))}</option>
      </select></div>
    <div id="biFields"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="form-group"><label>${esc(t('bi.w_refresh'))}</label><input type="number" min="0" id="biRefresh" class="input" value="${esc(c.refresh_sec ?? '')}" placeholder="300"></div>
      <div class="form-group"><label>${esc(t('bi.w_rotate'))}</label><input type="number" min="0" id="biRotate" class="input" value="${esc(c.rotate_sec ?? '')}" placeholder="0"></div>
      <div class="form-group"><label>${esc(t('bi.w_fit'))}</label><select id="biFit" class="input">
        ${['contain', 'cover', 'fill'].map((f) => `<option value="${f}" ${(c.fit || 'contain') === f ? 'selected' : ''}>${esc({ contain: t('bi.fit_contain'), cover: t('bi.fit_cover'), fill: t('bi.fit_fill') }[f])}</option>`).join('')}</select></div>
      <div class="form-group"><label>${esc(t('bi.w_background'))}</label><input type="color" id="biBg" class="input" value="${esc(/^#[0-9a-f]{6}$/i.test(c.background || '') ? c.background : '#000000')}"></div>
    </div>
    <div style="font-size:11px;color:var(--text-muted)">${esc(t('bi.w_refresh_hint'))}</div>`;
  const redraw = () => drawFields(c);
  host.querySelector('#biProvider').addEventListener('change', () => { c.connection_id = ''; redraw(); });
  host.querySelector('#biMode').addEventListener('change', redraw);
  redraw();
}

function drawFields(c) {
  const { host, connections } = state;
  const provider = host.querySelector('#biProvider').value;
  const mode = host.querySelector('#biMode').value;
  const box = host.querySelector('#biFields');
  if (mode === 'public') {
    const ph = { grafana: 'https://grafana.example.com/public-dashboards/…', powerbi: 'https://app.powerbi.com/view?r=…', tableau: 'https://public.tableau.com/views/Workbook/Sheet' }[provider];
    box.innerHTML = `<div class="form-group"><label>${esc(t('bi.w_public_url'))}</label>
      <input id="biPublicUrl" class="input" value="${esc(c.provider === provider ? (c.public_url || '') : '')}" placeholder="${esc(ph)}">
      <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${esc(t('bi.w_public_hint'))}</div></div>`;
    return;
  }
  const mine = connections.filter((x) => x.kind === provider);
  if (!mine.length) {
    box.innerHTML = `<p style="font-size:13px;color:var(--text-muted)">${esc(t('bi.w_no_connection'))}</p>`;
    return;
  }
  const same = c.provider === provider;
  let specific = '';
  if (provider === 'grafana') {
    specific = `
      <div class="form-group"><label>${esc(t('bi.w_dashboard'))}</label>
        <div style="display:flex;gap:6px"><input id="biUid" class="input" value="${esc(same ? c.dashboard_uid || '' : '')}" placeholder="${esc(t('bi.w_uid_ph'))}">
        <button type="button" class="btn btn-secondary btn-sm" id="biBrowse">${esc(t('bi.w_browse'))}</button></div>
        <select id="biPick" class="input" style="display:none;margin-top:6px"></select></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="form-group"><label>${esc(t('bi.w_panel'))}</label><input id="biPanel" type="number" min="1" class="input" value="${esc(same ? c.panel_id || '' : '')}"></div>
        <div class="form-group"><label>${esc(t('bi.w_theme'))}</label><select id="biTheme" class="input">
          <option value="dark" ${same && c.theme === 'light' ? '' : 'selected'}>${esc(t('bi.theme_dark'))}</option>
          <option value="light" ${same && c.theme === 'light' ? 'selected' : ''}>${esc(t('bi.theme_light'))}</option></select></div>
        <div class="form-group"><label>${esc(t('bi.w_from'))}</label><input id="biFrom" class="input" value="${esc(same ? c.time_from || '' : '')}" placeholder="now-6h"></div>
        <div class="form-group"><label>${esc(t('bi.w_to'))}</label><input id="biTo" class="input" value="${esc(same ? c.time_to || '' : '')}" placeholder="now"></div>
      </div>
      <div class="form-group"><label>${esc(t('bi.w_vars'))}</label><input id="biVars" class="input" value="${esc(same ? c.vars || '' : '')}" placeholder="var-host=web1&var-env=prod"></div>`;
  } else if (provider === 'powerbi') {
    specific = `
      <div class="form-group"><label>${esc(t('bi.w_report'))}</label>
        <button type="button" class="btn btn-secondary btn-sm" id="biBrowse">${esc(t('bi.w_browse'))}</button>
        <select id="biPick" class="input" style="display:none;margin-top:6px"></select></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="form-group"><label>${esc(t('bi.w_group_id'))}</label><input id="biGroup" class="input" value="${esc(same ? c.group_id || '' : '')}"></div>
        <div class="form-group"><label>${esc(t('bi.w_report_id'))}</label><input id="biReport" class="input" value="${esc(same ? c.report_id || '' : '')}"></div>
      </div>
      <div class="form-group"><label>${esc(t('bi.w_pages'))}</label><input id="biPages" class="input" value="${esc(same ? (c.pages || []).join(', ') : '')}" placeholder="ReportSection1, ReportSection2"></div>
      <label style="display:flex;gap:6px;align-items:center;font-size:12px"><input type="checkbox" id="biRotateAll" ${same && c.rotate_pages ? 'checked' : ''}> ${esc(t('bi.w_rotate_pages'))}</label>`;
  } else {
    specific = `
      <div class="form-group"><label>${esc(t('bi.w_view'))}</label><input id="biView" class="input" value="${esc(same ? c.view || '' : '')}" placeholder="Superstore/Overview"></div>
      <label style="display:flex;gap:6px;align-items:center;font-size:12px"><input type="checkbox" id="biRotateSheets" ${same && c.rotate_sheets ? 'checked' : ''}> ${esc(t('bi.w_rotate_sheets'))}</label>`;
  }
  box.innerHTML = `<div class="form-group"><label>${esc(t('bi.w_connection'))}</label>
      <select id="biConn" class="input">${mine.map((x) => `<option value="${esc(x.id)}" ${x.id === c.connection_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>${specific}`;
  const browse = box.querySelector('#biBrowse');
  if (browse) browse.addEventListener('click', () => browseInto(provider));
}

async function browseInto(provider) {
  const { host, apiGet } = state;
  const pick = host.querySelector('#biPick');
  const conn = host.querySelector('#biConn').value;
  pick.style.display = '';
  pick.innerHTML = `<option>${esc(t('bi.w_loading'))}</option>`;
  let items = [];
  try { items = ((await apiGet(`/bi-connections/${encodeURIComponent(conn)}/dashboards`)) || {}).items || []; }
  catch (err) { pick.innerHTML = `<option>${esc(err.message)}</option>`; return; }
  if (!items.length) { pick.innerHTML = `<option>${esc(t('bi.w_nothing_found'))}</option>`; return; }
  pick.innerHTML = `<option value="">${esc(t('bi.w_choose'))}</option>` + items.map((it, i) => `<option value="${i}">${esc(it.folder ? `${it.folder} / ${it.title}` : it.title)}</option>`).join('');
  pick.onchange = () => {
    const it = items[Number(pick.value)];
    if (!it) return;
    if (provider === 'grafana') host.querySelector('#biUid').value = it.id;
    else { host.querySelector('#biGroup').value = it.group_id; host.querySelector('#biReport').value = it.id; }
  };
}

/** The config to save. */
export function readBiConfig() {
  if (!state) return {};
  const { host } = state;
  const v = (id) => { const el = host.querySelector(`#${id}`); return el ? el.value.trim() : undefined; };
  const chk = (id) => !!(host.querySelector(`#${id}`) || {}).checked;
  const out = {
    provider: v('biProvider'),
    mode: v('biMode'),
    refresh_sec: v('biRefresh') === '' ? undefined : Number(v('biRefresh')),
    rotate_sec: v('biRotate') === '' ? undefined : Number(v('biRotate')),
    fit: v('biFit'),
    background: v('biBg'),
  };
  if (out.mode === 'public') { out.public_url = v('biPublicUrl'); return out; }
  out.connection_id = v('biConn');
  if (out.provider === 'grafana') Object.assign(out, { dashboard_uid: v('biUid'), panel_id: v('biPanel') || undefined, theme: v('biTheme'), time_from: v('biFrom') || undefined, time_to: v('biTo') || undefined, vars: v('biVars') || '' });
  else if (out.provider === 'powerbi') Object.assign(out, { group_id: v('biGroup'), report_id: v('biReport'), pages: v('biPages') || '', rotate_pages: chk('biRotateAll') });
  else Object.assign(out, { view: v('biView'), rotate_sheets: chk('biRotateSheets') });
  return out;
}
