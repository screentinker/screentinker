import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc } from '../utils.js';
import { t, getAvailableLanguages } from '../i18n.js';
import { pluginFieldsHtml, readPluginFields } from '../lib/plugin-fields.js';

/*
 * Data Sources: connect a calendar, the weather, a Google Sheet, any REST API, a CSV file, a
 * news/status feed, or a table typed in right here — then bind the values into slides with
 * {{ds:slug.key}}.
 *
 * Two rules drive the layout:
 *   1. START FROM THE OUTCOME. Creating a source opens a gallery that says what each connector is
 *      FOR ("menus, price lists, KPIs"), not how it works; the form comes second.
 *   2. SHOW THE REAL DATA. A test (and every card's variables drawer) lists the actual keys with
 *      their current values, click to copy — nobody should have to guess what "row3_price" holds.
 *      The old drawer showed ten hardcoded iCal keys for every source.
 */

let dataSourcesList = [];
let pluginDsTypes = [];

// Type catalogue. `accent` tints the icon tile; `tag` is a small marketing badge on the gallery.
const TYPES = [
  { type: 'sheets', accent: '#16a34a', tag: 'popular', icon: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 9h16M4 15h16M10 3v18"/>' },
  { type: 'rest', accent: '#8b5cf6', icon: '<path d="M8 4c-2 0-3 1-3 3v2c0 1.5-1 2.5-2 3 1 .5 2 1.5 2 3v2c0 2 1 3 3 3M16 4c2 0 3 1 3 3v2c0 1.5 1 2.5 2 3-1 .5-2 1.5-2 3v2c0 2-1 3-3 3"/><circle cx="12" cy="12" r="1"/>' },
  { type: 'ical', accent: '#3b82f6', icon: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M8 14h3v3H8z"/>' },
  { type: 'weather', accent: '#f59e0b', tag: 'no_setup', icon: '<circle cx="8" cy="9" r="3"/><path d="M8 2v1.5M2.5 9H1M3.8 4.8l1 1M12.2 4.8l-1 1"/><path d="M9 19h9a3.5 3.5 0 0 0 0-7 5 5 0 0 0-9.6 1.4A3 3 0 0 0 9 19z"/>' },
  { type: 'table', accent: '#ec4899', tag: 'no_setup', icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18M9 9v11"/><path d="M15 16.5l1.5-1.5 2 2"/>' },
  { type: 'csv', accent: '#14b8a6', icon: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M8 13h8M8 17h5"/>' },
  { type: 'rss', accent: '#f97316', icon: '<path d="M5 11a8 8 0 0 1 8 8M5 5a14 14 0 0 1 14 14"/><circle cx="6" cy="18" r="1.5"/>' },
];
const PLUGIN_ICON = '<path d="M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0zM12 16v5"/>';
const typeMeta = (type) => TYPES.find((x) => x.type === type) || { type, accent: '#64748b', icon: PLUGIN_ICON };
const typeLabel = (type) => {
  if (TYPES.some((x) => x.type === type)) return t(`data_sources.kind.${type}`);
  const p = pluginDsTypes.find((x) => x.type === type);
  return (p && (p.label || p.type)) || type;
};
const iconSvg = (type, size = 22) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${typeMeta(type).icon}</svg>`;
const iconTile = (type, cls = '') => `<span class="ds-icon ${cls}" style="--ds-accent:${typeMeta(type).accent}">${iconSvg(type)}</span>`;

// Types whose data is rows and columns (lib/data-sources/tabular.js on the server).
const TABULAR = new Set(['sheets', 'csv', 'table', 'rest']);

export async function render(container) {
  container.innerHTML = `
    <div class="ds-page">
      <header class="ds-hero">
        <div>
          <h1>${esc(t('data_sources.title'))}</h1>
          <p>${esc(t('data_sources.subtitle2'))}</p>
        </div>
        <button id="newDataSourceBtn" class="btn btn-primary ds-cta">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
          <span>${esc(t('data_sources.connect'))}</span>
        </button>
      </header>
      <div id="dataSourcesContainer"><div class="ds-loading"><span class="spinner"></span></div></div>
    </div>
  `;
  document.getElementById('newDataSourceBtn').onclick = () => openEditModal(null);
  try {
    const r = await api.getDataSourcePluginTypes();
    pluginDsTypes = Array.isArray(r && r.types) ? r.types : [];
  } catch {
    pluginDsTypes = [];
  }
  await loadDataSources();
}

async function loadDataSources() {
  const container = document.getElementById('dataSourcesContainer');
  if (!container) return;
  try {
    dataSourcesList = await api.getDataSources();
    renderDataSourcesList(container);
  } catch (err) {
    container.innerHTML = `
      <div class="ds-alert ds-alert-error">
        <strong>${esc(t('data_sources.failed_load'))}</strong>
        <span>${esc(err.message)}</span>
      </div>`;
  }
}

// ─── gallery (empty state + step 1 of "Connect data") ──────────────────────────
function galleryHtml() {
  const tiles = TYPES.map((m) => `
    <button type="button" class="ds-tile" data-pick="${m.type}" style="--ds-accent:${m.accent}">
      ${iconTile(m.type)}
      <span class="ds-tile-text">
        <span class="ds-tile-title">${esc(t(`data_sources.kind.${m.type}`))}
          ${m.tag ? `<span class="ds-tag">${esc(t(`data_sources.tag.${m.tag}`))}</span>` : ''}</span>
        <span class="ds-tile-pitch">${esc(t(`data_sources.pitch.${m.type}`))}</span>
      </span>
    </button>`).join('');
  const plugins = pluginDsTypes.map((p) => `
    <button type="button" class="ds-tile" data-pick="${esc(p.type)}" style="--ds-accent:#64748b">
      ${iconTile(p.type)}
      <span class="ds-tile-text">
        <span class="ds-tile-title">${esc(p.label || p.type)} <span class="ds-tag ds-tag-muted">${esc(t('data_sources.tag.plugin'))}</span></span>
        <span class="ds-tile-pitch">${esc(p.description || t('data_sources.pitch.plugin'))}</span>
      </span>
    </button>`).join('');
  return `<div class="ds-gallery">${tiles}${plugins}</div>`;
}

function renderDataSourcesList(container) {
  if (!dataSourcesList.length) {
    container.innerHTML = `
      <section class="ds-empty">
        <h2>${esc(t('data_sources.empty_title2'))}</h2>
        <p>${esc(t('data_sources.empty_desc2'))}</p>
        ${galleryHtml()}
        <div class="ds-how">
          <div><b>1</b><span>${esc(t('data_sources.how1'))}</span></div>
          <div><b>2</b><span>${esc(t('data_sources.how2'))}</span></div>
          <div><b>3</b><span>${esc(t('data_sources.how3'))}</span></div>
        </div>
      </section>`;
    container.querySelectorAll('[data-pick]').forEach((b) => { b.onclick = () => openEditModal(null, b.dataset.pick); });
    return;
  }

  container.innerHTML = `<div class="ds-grid">${dataSourcesList.map(renderDataSourceCard).join('')}</div>`;

  container.querySelectorAll('[data-act="refresh"]').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      btn.classList.add('is-busy');
      try {
        const r = await api.refreshDataSource(btn.dataset.id);
        if (r && r.last_status === 'error') showToast(r.last_error || t('common.error'), 'error');
        else showToast(t('data_sources.synced_ok'), 'success');
        await loadDataSources();
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false;
        btn.classList.remove('is-busy');
      }
    };
  });
  container.querySelectorAll('[data-act="edit"]').forEach((btn) => {
    btn.onclick = () => {
      const ds = dataSourcesList.find((x) => x.id === btn.dataset.id);
      if (ds) openEditModal(ds);
    };
  });
  container.querySelectorAll('[data-act="del"]').forEach((btn) => {
    btn.onclick = async () => {
      const ds = dataSourcesList.find((x) => x.id === btn.dataset.id);
      if (!ds || !confirm(t('data_sources.confirm_delete', { name: ds.name }))) return;
      try {
        await api.deleteDataSource(ds.id);
        showToast(t('data_sources.deleted_ok'), 'success');
        await loadDataSources();
      } catch (err) {
        showToast(err.message, 'error');
      }
    };
  });
  container.querySelectorAll('[data-act="toggle-variables"]').forEach((btn) => {
    btn.onclick = () => {
      const ds = dataSourcesList.find((x) => x.id === btn.dataset.id);
      const drawer = document.getElementById(`vars-drawer-${btn.dataset.id}`);
      if (!ds || !drawer) return;
      const open = drawer.hidden;
      drawer.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open && !drawer.dataset.ready) {
        drawer.dataset.ready = '1';
        mountVariables(drawer, ds.slug, ds.data || {}, ds.type, !!(ds.config && ds.config.key_column));
      }
    };
  });
  bindCopy(container);
}

function relTime(sec) {
  if (!sec) return t('data_sources.never_synced');
  const d = Math.max(0, Math.round(Date.now() / 1000 - sec));
  if (d < 45) return t('data_sources.just_now');
  if (d < 3600) return t('data_sources.min_ago', { n: Math.round(d / 60) });
  if (d < 86400) return t('data_sources.hr_ago', { n: Math.round(d / 3600) });
  return new Date(sec * 1000).toLocaleString();
}

function sourceSummary(ds) {
  const c = ds.config || {};
  const host = (u) => { try { return new URL(u).host; } catch { return ''; } };
  switch (ds.type) {
    case 'weather': return `Open-Meteo · ${c.location || (c.latitude != null ? `${c.latitude}, ${c.longitude}` : '')}`;
    case 'sheets': return c.sheet ? `Google Sheets · ${c.sheet}` : 'Google Sheets';
    case 'table': return t('data_sources.summary_table', { r: (c.rows || []).length, c: (c.columns || []).length });
    case 'rest': return `${(c.method || 'GET').toUpperCase()} ${host(c.url)}${c.json_path ? ` · ${c.json_path}` : ''}`;
    default: return c.url ? String(c.url).replace(/^(https?|webcal):\/\//, '') : t('data_sources.inline_data');
  }
}

function renderDataSourceCard(ds) {
  const st = ds.last_status === 'ok' ? 'ok' : ds.last_status === 'pending' ? 'pending' : 'error';
  const stLabel = st === 'ok' ? t('data_sources.status_live') : st === 'pending' ? t('common.pending') : t('common.error');
  const data = ds.data && typeof ds.data === 'object' ? ds.data : {};
  const nVars = Object.keys(data).length;
  const headline = cardHeadline(ds.type, data);
  return `
    <article class="ds-card" style="--ds-accent:${typeMeta(ds.type).accent}">
      <div class="ds-card-head">
        ${iconTile(ds.type)}
        <div class="ds-card-id">
          <h3 title="${esc(ds.name)}">${esc(ds.name)}</h3>
          <div class="ds-card-sub">${esc(typeLabel(ds.type))} · <code>${esc(ds.slug)}</code></div>
        </div>
        <span class="ds-status ds-status-${st}"><i></i>${esc(stLabel)}</span>
      </div>
      ${headline ? `<div class="ds-headline">${headline}</div>` : ''}
      <dl class="ds-meta">
        <div><dt>${esc(t('data_sources.source_label2'))}</dt><dd title="${esc(sourceSummary(ds))}">${esc(sourceSummary(ds))}</dd></div>
        <div><dt>${esc(t('data_sources.last_sync_label2'))}</dt><dd>${esc(relTime(ds.last_fetched_at))}</dd></div>
      </dl>
      ${ds.last_error ? `<div class="ds-card-error" role="alert">${esc(ds.last_error)}</div>` : ''}
      <button class="ds-vars-toggle" data-act="toggle-variables" data-id="${esc(ds.id)}" aria-expanded="false" aria-controls="vars-drawer-${esc(ds.id)}">
        <span>${esc(t('data_sources.variables_n', { n: nVars }))}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div id="vars-drawer-${esc(ds.id)}" class="ds-vars-drawer" hidden></div>
      <div class="ds-card-actions">
        <button class="btn btn-sm btn-secondary" data-act="refresh" data-id="${esc(ds.id)}">${esc(t('data_sources.sync_now'))}</button>
        <span class="ds-spacer"></span>
        <button class="btn btn-sm btn-secondary" data-act="edit" data-id="${esc(ds.id)}">${esc(t('common.edit'))}</button>
        <button class="btn btn-sm btn-danger" data-act="del" data-id="${esc(ds.id)}">${esc(t('common.delete'))}</button>
      </div>
    </article>`;
}

/* A glanceable line of the live data on each card — what the screen is showing right now. */
function cardHeadline(type, d) {
  const kv = (label, value) => (value === undefined || value === null || value === '' ? '' : `<span class="ds-hl"><em>${esc(label)}</em>${esc(String(value))}</span>`);
  if (type === 'weather' && d.temperature != null) return kv(d.location || '', `${d.icon || ''} ${d.temperature}°${d.units || ''} · ${d.condition || ''}`);
  if (type === 'ical' && d.status) return kv(d.status, d.status_detail || d.next_title || '');
  if (type === 'rss' && d.item1_title) return kv(t('data_sources.hl_latest'), d.item1_title);
  if (TABULAR.has(type) && d.row_count != null) return kv(t('data_sources.hl_rows', { n: d.row_count }), d.columns || '');
  return '';
}

// ─── variables list: real keys, real values, click to copy ────────────────────
function tagFor(slug, key) { return `{{ds:${slug || 'slug'}.${key}}}`; }

function mountVariables(host, slug, data, type, hasKey) {
  const keys = Object.keys(data || {});
  if (!keys.length) {
    host.innerHTML = `<p class="ds-muted">${esc(t('data_sources.no_data_yet'))}</p>`;
    return;
  }
  host.innerHTML = `
    ${keys.length > 12 ? `<input type="search" class="input ds-var-search" placeholder="${esc(t('data_sources.search_vars', { n: keys.length }))}" aria-label="${esc(t('data_sources.search_vars', { n: keys.length }))}">` : ''}
    <p class="ds-hint">${esc(t('data_sources.copy_as', { tag: tagFor(slug, 'KEY') }))}</p>
    ${TABULAR.has(type) && !hasKey && 'row_count' in data ? `<p class="ds-hint">${esc(t('data_sources.tip_lookup'))}</p>` : ''}
    <div class="ds-var-list" role="list"></div>
    <p class="ds-muted ds-var-more" hidden></p>`;
  const list = host.querySelector('.ds-var-list');
  const more = host.querySelector('.ds-var-more');
  const paint = (q) => {
    const needle = String(q || '').trim().toLowerCase();
    const hits = needle ? keys.filter((k) => k.includes(needle) || String(data[k]).toLowerCase().includes(needle)) : keys;
    const shown = hits.slice(0, 150);
    list.innerHTML = shown.map((k) => {
      const v = data[k];
      const vs = v === null || v === undefined ? '' : String(v);
      return `<div class="ds-var" role="listitem">
        <button type="button" class="ds-var-tag" data-copy="${esc(tagFor(slug, k))}" title="${esc(t('data_sources.copy_tag'))}: ${esc(tagFor(slug, k))}">${esc(k)}</button>
        <span class="ds-var-val${vs ? '' : ' is-empty'}" title="${esc(vs.slice(0, 500))}">${esc(vs ? vs.slice(0, 160) : t('data_sources.empty_value'))}</span>
      </div>`;
    }).join('') || `<p class="ds-muted">${esc(t('data_sources.no_match'))}</p>`;
    more.hidden = hits.length <= shown.length;
    more.textContent = t('data_sources.more_vars', { n: hits.length - shown.length });
  };
  paint('');
  const search = host.querySelector('.ds-var-search');
  if (search) search.oninput = () => paint(search.value);
  bindCopy(host);
}

function copyText(text) {
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch { /* nothing more to try */ }
    ta.remove();
  };
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).catch(fallback);
  fallback();
  return Promise.resolve();
}

function bindCopy(root) {
  root.querySelectorAll('[data-copy]').forEach((b) => {
    if (b.dataset.bound) return;
    b.dataset.bound = '1';
    b.onclick = () => copyText(b.dataset.copy).then(() => {
      showToast(t('data_sources.tag_copied'), 'info');
      b.classList.add('is-copied');
      setTimeout(() => b.classList.remove('is-copied'), 900);
    });
  });
}

// ─── Create / Edit modal ───────────────────────────────────────────────────────
const field = (label, control, hint, cls = '') => `
  <label class="ds-field ${cls}">
    <span class="ds-label">${label}</span>
    ${control}
    ${hint ? `<span class="ds-field-hint">${hint}</span>` : ''}
  </label>`;
const opt = (value, label, cur) => `<option value="${esc(value)}" ${String(cur) === String(value) ? 'selected' : ''}>${esc(label)}</option>`;
const langOptions = (cur) => getAvailableLanguages().map((l) => opt(l.code, l.name, cur || 'en')).join('');
const intervalSelect = (id, cur, choices) => `<select id="${id}" class="input">${choices.map((m) => opt(m, t(`data_sources.every_${m}`), cur || 15)).join('')}</select>`;

function formHtml(type, cfg, isEdit) {
  const v = (k, d = '') => esc(cfg[k] == null ? d : cfg[k]);
  // Stored secrets come back blank (redacted); say one is saved only where it really is — the
  // auth type it was saved under — or an operator switching auth thinks a key is already there.
  const savedSecret = (forAuth) => (isEdit && cfg.auth_type === forAuth ? t('data_sources.secret_saved') : '');
  switch (type) {
    case 'sheets': return `
      <div class="ds-callout">
        <b>${esc(t('data_sources.sheets_steps_title'))}</b>
        <ol><li>${esc(t('data_sources.sheets_step1'))}</li><li>${esc(t('data_sources.sheets_step2'))}</li><li>${esc(t('data_sources.sheets_step3'))}</li></ol>
      </div>
      ${field(esc(t('data_sources.sheets_url')) + ' *', `<input id="f_url" class="input" type="url" autocomplete="off" spellcheck="false" placeholder="https://docs.google.com/spreadsheets/d/…/edit#gid=0" value="${v('url')}">`, `<span id="f_url_status">${esc(t('data_sources.sheets_url_hint'))}</span>`)}
      <div class="ds-row2">
        ${field(esc(t('data_sources.sheets_tab')), `<input id="f_sheet" class="input" maxlength="100" placeholder="${esc(t('data_sources.sheets_tab_ph'))}" value="${v('sheet')}">`)}
        ${field(esc(t('data_sources.sheets_range')), `<input id="f_range" class="input" maxlength="20" placeholder="A1:D50" value="${v('range')}">`)}
      </div>
      ${tableOptions(cfg, [5, 15, 60])}`;
    case 'rest': return `
      <div class="ds-row-url">
        ${field(esc(t('data_sources.method')), `<select id="f_method" class="input">${opt('GET', 'GET', cfg.method || 'GET')}${opt('POST', 'POST', cfg.method)}</select>`, '', 'ds-method')}
        ${field(esc(t('data_sources.api_url')) + ' *', `<input id="f_url" class="input" type="url" autocomplete="off" spellcheck="false" placeholder="https://api.example.com/v1/stats" value="${v('url')}">`)}
      </div>
      ${field(esc(t('data_sources.body')), `<textarea id="f_body" class="input ds-mono" rows="3" spellcheck="false" placeholder='{"query": "open tickets"}'>${v('body')}</textarea>`, esc(t('data_sources.body_hint')), 'ds-post-only')}
      <fieldset class="ds-fieldset">
        <legend>${esc(t('data_sources.auth'))}</legend>
        <div class="ds-seg" role="radiogroup" aria-label="${esc(t('data_sources.auth'))}">
          ${['none', 'bearer', 'header', 'basic'].map((a) => `<label><input type="radio" name="f_auth" value="${a}" ${(cfg.auth_type || 'none') === a ? 'checked' : ''}><span>${esc(t(`data_sources.auth_${a}`))}</span></label>`).join('')}
        </div>
        <div class="ds-auth" data-auth="bearer">${field(esc(t('data_sources.token')), `<input id="f_token_b" class="input" type="password" autocomplete="new-password" placeholder="${esc(savedSecret('bearer'))}">`)}</div>
        <div class="ds-auth ds-row2" data-auth="header">
          ${field(esc(t('data_sources.header_name')), `<input id="f_header" class="input" placeholder="X-API-Key" value="${v('auth_header')}">`)}
          ${field(esc(t('data_sources.header_value')), `<input id="f_token_h" class="input" type="password" autocomplete="new-password" placeholder="${esc(savedSecret('header'))}">`)}
        </div>
        <div class="ds-auth ds-row2" data-auth="basic">
          ${field(esc(t('data_sources.username')), `<input id="f_user" class="input" autocomplete="off" value="${v('auth_username')}">`)}
          ${field(esc(t('data_sources.password')), `<input id="f_pass" class="input" type="password" autocomplete="new-password" placeholder="${esc(savedSecret('basic'))}">`)}
        </div>
        <p class="ds-field-hint ds-lock">${esc(t('data_sources.secret_note'))}</p>
      </fieldset>
      <div class="ds-row2">
        ${field(esc(t('data_sources.json_path')), `<input id="f_path" class="input ds-mono" spellcheck="false" placeholder="data.items" value="${v('json_path')}">`, esc(t('data_sources.json_path_hint')))}
        ${field(esc(t('data_sources.format')), `<select id="f_format" class="input">${opt('auto', t('data_sources.format_auto'), cfg.response_format || 'auto')}${opt('json', 'JSON', cfg.response_format)}${opt('csv', 'CSV', cfg.response_format)}</select>`)}
      </div>
      ${tableOptions(cfg, [1, 5, 15, 60], true)}`;
    case 'csv': return `
      ${field(esc(t('data_sources.csv_url')) + ' *', `<input id="f_url" class="input" type="url" autocomplete="off" spellcheck="false" placeholder="https://example.com/export/menu.csv" value="${v('url')}">`, esc(t('data_sources.csv_url_hint')))}
      ${field(esc(t('data_sources.delimiter')), `<select id="f_delim" class="input">${[['auto', t('data_sources.delim_auto')], [',', t('data_sources.delim_comma')], [';', t('data_sources.delim_semicolon')], ['tab', t('data_sources.delim_tab')], ['|', t('data_sources.delim_pipe')]].map(([a, b]) => opt(a, b, cfg.delimiter || 'auto')).join('')}</select>`)}
      ${tableOptions(cfg, [1, 5, 15, 60])}`;
    case 'rss': return `
      ${field(esc(t('data_sources.feed_url')) + ' *', `<input id="f_url" class="input" type="url" autocomplete="off" spellcheck="false" placeholder="https://www.githubstatus.com/history.rss" value="${v('url')}">`, esc(t('data_sources.feed_url_hint')))}
      <div class="ds-row3">
        ${field(esc(t('data_sources.max_items')), `<input id="f_items" class="input" type="number" min="1" max="50" value="${v('max_items', 10)}">`)}
        ${field(esc(t('data_sources.summary_chars')), `<input id="f_chars" class="input" type="number" min="40" max="1000" step="20" value="${v('summary_chars', 200)}">`)}
        ${field(esc(t('data_sources.interval_label')), intervalSelect('f_interval', cfg.interval_min, [5, 15, 60]))}
      </div>
      <div class="ds-row2">
        ${field(esc(t('data_sources.language_label2')), `<select id="f_locale" class="input">${langOptions(cfg.locale)}</select>`)}
        ${field(esc(t('data_sources.timezone_label')), `<input id="f_tz" class="input" value="${v('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')}">`)}
      </div>`;
    case 'table': return `
      <p class="ds-field-hint">${esc(t('data_sources.table_hint'))}</p>
      <div class="ds-grid-editor" id="f_grid"></div>
      <div class="ds-grid-tools">
        <button type="button" class="btn btn-sm btn-secondary" id="f_addrow">${esc(t('data_sources.add_row'))}</button>
        <button type="button" class="btn btn-sm btn-secondary" id="f_addcol">${esc(t('data_sources.add_col'))}</button>
        <span class="ds-spacer"></span>
        <span class="ds-muted" id="f_gridsize"></span>
      </div>
      ${field(esc(t('data_sources.key_column')), `<select id="f_key" class="input"></select>`, esc(t('data_sources.key_column_hint')))}`;
    default: return '';
  }
}

/* Options every table-shaped source shares: header row, key column (lookup), refresh. */
function tableOptions(cfg, intervals, restShape = false) {
  return `
    <details class="ds-adv" ${cfg.key_column || cfg.header_row === false || cfg.max_rows ? 'open' : ''}>
      <summary>${esc(t('data_sources.table_options'))}</summary>
      <div class="ds-adv-body">
        ${field(esc(t('data_sources.key_column')), `<input id="f_key" class="input" list="f_key_list" autocomplete="off" placeholder="${esc(t('data_sources.key_column_ph'))}" value="${esc(cfg.key_column || '')}"><datalist id="f_key_list"></datalist>`, esc(t('data_sources.key_column_hint')))}
        <div class="ds-row3">
          ${restShape
            ? field(esc(t('data_sources.shape')), `<select id="f_shape" class="input">${opt('auto', t('data_sources.shape_auto'), cfg.shape || 'auto')}${opt('table', t('data_sources.shape_table'), cfg.shape)}${opt('object', t('data_sources.shape_object'), cfg.shape)}</select>`)
            : field(esc(t('data_sources.max_rows')), `<input id="f_maxrows" class="input" type="number" min="1" max="100" placeholder="100" value="${esc(cfg.max_rows || '')}">`)}
          ${field(esc(t('data_sources.interval_label')), intervalSelect('f_interval', cfg.interval_min, intervals))}
          <label class="ds-check"><input type="checkbox" id="f_header_row" ${cfg.header_row === false ? '' : 'checked'}><span>${esc(t('data_sources.header_row'))}</span></label>
        </div>
      </div>
    </details>`;
}

function icalFormHtml(cfg) {
  return `
    ${field(esc(t('data_sources.url_label')), `<input type="text" id="dsUrlInput" class="input" placeholder="${esc(t('data_sources.url_placeholder'))}" value="${esc(cfg.url || '')}">`, esc(t('data_sources.url_hint')))}
    <details class="ds-adv">
      <summary>${esc(t('data_sources.advanced_options'))}</summary>
      <div class="ds-adv-body">
        <div class="ds-row2">
          ${field(esc(t('data_sources.interval_label')), `<select id="dsIntervalInput" class="input">
              ${opt(1, t('data_sources.interval_1min'), cfg.interval_min || 15)}${opt(5, t('data_sources.interval_5min'), cfg.interval_min || 15)}
              ${opt(15, t('data_sources.interval_15min'), cfg.interval_min || 15)}${opt(60, t('data_sources.interval_1hr'), cfg.interval_min || 15)}</select>`)}
          ${field(esc(t('data_sources.lookahead_label')), `<input type="number" id="dsLookaheadInput" class="input" value="${esc(cfg.lookahead_days || 14)}" min="1" max="90">`)}
        </div>
        <div class="ds-row2">
          ${field(esc(t('data_sources.filter_include_label')), `<input type="text" id="dsFilterIncludeInput" class="input" placeholder="${esc(t('data_sources.filter_include_placeholder'))}" value="${esc(cfg.filter_include || cfg.filter_text || '')}">`)}
          ${field(esc(t('data_sources.filter_exclude_label')), `<input type="text" id="dsFilterExcludeInput" class="input" placeholder="${esc(t('data_sources.filter_exclude_placeholder'))}" value="${esc(cfg.filter_exclude || cfg.exclude_text || '')}">`)}
        </div>
        <div class="ds-row2">
          ${field(esc(t('data_sources.language_label')), `<select id="dsLocaleInput" class="input">${langOptions(cfg.locale)}</select>`)}
          ${field(esc(t('data_sources.timezone_label')), `<input type="text" id="dsTzInput" class="input" value="${esc(cfg.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')}">`)}
        </div>
        <label class="ds-check"><input type="checkbox" id="dsPrivacyInput" ${cfg.hide_private ? 'checked' : ''}><span>${esc(t('data_sources.privacy_label'))}</span></label>
      </div>
    </details>`;
}

function weatherFormHtml(cfg) {
  return `
    ${field(esc(t('data_sources.weather_location_label')), `<input type="text" id="dsWxLocationInput" class="input" maxlength="100" placeholder="${esc(t('data_sources.weather_location_placeholder'))}" value="${esc(cfg.location || '')}">`, esc(t('data_sources.weather_location_hint')))}
    <div class="ds-row2">
      ${field(esc(t('data_sources.weather_latitude_label')), `<input type="number" id="dsWxLatInput" class="input" step="any" min="-90" max="90" value="${esc(cfg.latitude != null ? cfg.latitude : '')}">`)}
      ${field(esc(t('data_sources.weather_longitude_label')), `<input type="number" id="dsWxLonInput" class="input" step="any" min="-180" max="180" value="${esc(cfg.longitude != null ? cfg.longitude : '')}">`)}
    </div>
    <div class="ds-row3">
      ${field(esc(t('data_sources.weather_units_label')), `<select id="dsWxUnitsInput" class="input">${opt('metric', t('data_sources.weather_units_metric'), cfg.units || 'metric')}${opt('imperial', t('data_sources.weather_units_imperial'), cfg.units)}</select>`)}
      ${field(esc(t('data_sources.weather_locale_label')), `<select id="dsWxLocaleInput" class="input">${langOptions(cfg.locale)}</select>`)}
      ${field(esc(t('data_sources.interval_label')), intervalSelect('dsWxIntervalInput', cfg.interval_min >= 60 ? 60 : cfg.interval_min == 30 ? 30 : 15, [15, 30, 60]))}
    </div>
    <p class="ds-field-hint">${esc(t('data_sources.weather_attribution'))}</p>`;
}

function openEditModal(ds, presetType) {
  const isEdit = !!ds;
  const cfg = (ds && ds.config) || {};
  let type = ds ? ds.type : presetType || null;
  let lastColumns = [];

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay ds-overlay';
  overlay.innerHTML = `
    <div class="modal ds-modal" role="dialog" aria-modal="true" aria-labelledby="dsModalTitle">
      <div class="ds-modal-head">
        <button type="button" class="ds-back" id="dsBack" aria-label="${esc(t('data_sources.back'))}" hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <span id="dsHeadIcon"></span>
        <div class="ds-modal-titles">
          <h2 id="dsModalTitle"></h2>
          <p id="dsModalSub"></p>
        </div>
        <button type="button" id="closeDsModalBtn" class="ds-x" aria-label="${esc(t('common.cancel'))}">&times;</button>
      </div>
      <div class="ds-modal-body" id="dsBody"></div>
      <div class="ds-modal-foot" id="dsFoot" hidden>
        <button type="button" id="dsTestBtn" class="btn btn-secondary">${esc(t('data_sources.test_btn2'))}</button>
        <span class="ds-spacer"></span>
        <button type="button" id="cancelDsModalBtn" class="btn btn-secondary">${esc(t('common.cancel'))}</button>
        <button type="button" id="saveDsModalBtn" class="btn btn-primary">${isEdit ? esc(t('common.save')) : esc(t('data_sources.save_connect'))}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#closeDsModalBtn').onclick = close;
  overlay.querySelector('#cancelDsModalBtn').onclick = close;

  const $ = (sel) => overlay.querySelector(sel);
  const body = $('#dsBody');
  const plugin = () => pluginDsTypes.find((p) => p.type === type) || null;

  function showGallery() {
    type = null;
    $('#dsBack').hidden = true;
    $('#dsHeadIcon').innerHTML = '';
    $('#dsModalTitle').textContent = t('data_sources.gallery_title');
    $('#dsModalSub').textContent = t('data_sources.gallery_sub');
    $('#dsFoot').hidden = true;
    body.innerHTML = galleryHtml();
    body.querySelectorAll('[data-pick]').forEach((b) => { b.onclick = () => showForm(b.dataset.pick); });
    const first = body.querySelector('[data-pick]');
    if (first) first.focus();
  }

  function showForm(nextType) {
    type = nextType;
    lastColumns = [];
    $('#dsBack').hidden = isEdit;
    $('#dsHeadIcon').innerHTML = iconTile(type, 'ds-icon-sm');
    $('#dsModalTitle').textContent = isEdit ? t('data_sources.edit_named', { name: ds.name }) : typeLabel(type);
    $('#dsModalSub').textContent = TYPES.some((x) => x.type === type) ? t(`data_sources.pitch.${type}`) : (plugin() && plugin().description) || '';
    $('#dsFoot').hidden = false;
    const typeCfg = ds && ds.type === type ? cfg : {};
    let specific;
    if (type === 'ical') specific = icalFormHtml(typeCfg);
    else if (type === 'weather') specific = weatherFormHtml(typeCfg);
    else if (plugin()) specific = pluginFieldsHtml(plugin().fields || [], typeCfg, 'dsPlugin_');
    else specific = formHtml(type, typeCfg, isEdit);
    body.innerHTML = `
      <div class="ds-row2">
        ${field(esc(t('data_sources.name_label2')) + ' *', `<input type="text" id="dsNameInput" class="input" maxlength="80" placeholder="${esc(t(`data_sources.name_ph.${type}`) === `data_sources.name_ph.${type}` ? t('data_sources.name_placeholder') : t(`data_sources.name_ph.${type}`))}" value="${esc((ds && ds.name) || '')}">`)}
        ${field(esc(t('data_sources.slug_label')), `<input type="text" id="dsSlugInput" class="input ds-mono" maxlength="60" placeholder="${esc(t('data_sources.slug_placeholder'))}" value="${esc((ds && ds.slug) || '')}">`, `<span id="dsSlugHint"></span>`)}
      </div>
      <div class="ds-form">${specific}</div>
      <div id="dsTestResult" class="ds-result" aria-live="polite"></div>`;
    wireForm(typeCfg);
    const nameInput = $('#dsNameInput');
    if (nameInput) nameInput.focus();
  }

  function wireForm(typeCfg) {
    const nameInput = $('#dsNameInput');
    const slugInput = $('#dsSlugInput');
    const slugHint = $('#dsSlugHint');
    let slugTouched = isEdit;
    const paintSlug = () => {
      const tag = tagFor(slugInput.value.trim() || 'slug', 'key');
      slugHint.textContent = t('data_sources.slug_used_as', { tag });
    };
    slugInput.oninput = () => { slugTouched = true; paintSlug(); };
    nameInput.oninput = () => {
      if (!slugTouched) slugInput.value = nameInput.value.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/[\s_-]+/g, '_').replace(/^_|_$/g, '');
      paintSlug();
    };
    paintSlug();

    if (type === 'rest') {
      const method = $('#f_method');
      const postOnly = $('.ds-post-only');
      const paintMethod = () => { postOnly.hidden = method.value !== 'POST'; };
      method.onchange = paintMethod; paintMethod();
      const paintAuth = () => {
        const a = (overlay.querySelector('input[name="f_auth"]:checked') || {}).value || 'none';
        overlay.querySelectorAll('.ds-auth').forEach((el) => { el.hidden = el.dataset.auth !== a; });
        $('.ds-lock').hidden = a === 'none';
      };
      overlay.querySelectorAll('input[name="f_auth"]').forEach((r) => { r.onchange = paintAuth; });
      paintAuth();
    }
    if (type === 'sheets') {
      const url = $('#f_url');
      const status = $('#f_url_status');
      const paint = () => {
        const r = parseSheetLink(url.value);
        status.className = r ? 'ds-ok-text' : '';
        if (!url.value.trim()) status.textContent = t('data_sources.sheets_url_hint');
        else if (!r) { status.textContent = t('data_sources.sheets_url_bad'); status.className = 'ds-err-text'; }
        else status.textContent = r.kind === 'published' ? t('data_sources.sheets_url_published') : r.gid ? t('data_sources.sheets_url_ok_gid', { gid: r.gid }) : t('data_sources.sheets_url_ok');
      };
      url.oninput = paint; paint();
    }
    if (type === 'table') mountGridEditor(typeCfg);
  }

  // ─── manual table editor ─────────────────────────────────────────────────────
  let grid = null;
  function mountGridEditor(c) {
    grid = {
      columns: Array.isArray(c.columns) && c.columns.length ? [...c.columns] : [t('data_sources.table_col_item'), t('data_sources.table_col_price')],
      rows: Array.isArray(c.rows) && c.rows.length ? c.rows.map((r) => [...r]) : [['', ''], ['', '']],
      key: c.key_column || '',
    };
    paintGrid();
    $('#f_addrow').onclick = () => { if (grid.rows.length < 200) { grid.rows.push(grid.columns.map(() => '')); paintGrid(); focusCell(grid.rows.length - 1, 0); } };
    $('#f_addcol').onclick = () => { if (grid.columns.length < 20) { grid.columns.push(''); grid.rows.forEach((r) => r.push('')); paintGrid(); } };
  }
  function focusCell(r, c) {
    const el = overlay.querySelector(`[data-r="${r}"][data-c="${c}"]`);
    if (el) el.focus();
  }
  function paintGrid() {
    const host = $('#f_grid');
    host.innerHTML = `
      <table class="ds-edit-table">
        <thead><tr>${grid.columns.map((name, c) => `<th><div class="ds-th">
          <input class="ds-cell ds-cell-head" data-h="${c}" value="${esc(name)}" maxlength="80" placeholder="${esc(t('data_sources.column_n', { n: c + 1 }))}" aria-label="${esc(t('data_sources.column_n', { n: c + 1 }))}">
          ${grid.columns.length > 1 ? `<button type="button" class="ds-del" data-delcol="${c}" aria-label="${esc(t('data_sources.remove_col'))}" title="${esc(t('data_sources.remove_col'))}">×</button>` : ''}
        </div></th>`).join('')}<th class="ds-th-x"></th></tr></thead>
        <tbody>${grid.rows.map((row, r) => `<tr>${grid.columns.map((_, c) => `<td><input class="ds-cell" data-r="${r}" data-c="${c}" value="${esc(row[c] == null ? '' : row[c])}" maxlength="500" aria-label="${esc(t('data_sources.cell_label', { r: r + 1, c: grid.columns[c] || c + 1 }))}"></td>`).join('')}
          <td class="ds-th-x"><button type="button" class="ds-del" data-delrow="${r}" aria-label="${esc(t('data_sources.remove_row'))}" title="${esc(t('data_sources.remove_row'))}">×</button></td></tr>`).join('')}</tbody>
      </table>`;
    $('#f_gridsize').textContent = t('data_sources.grid_size', { r: grid.rows.length, c: grid.columns.length });
    const key = $('#f_key');
    key.innerHTML = opt('', t('data_sources.key_none'), grid.key) + grid.columns.filter((n) => n.trim()).map((n) => opt(n, n, grid.key)).join('');
    key.onchange = () => { grid.key = key.value; };
    host.querySelectorAll('[data-h]').forEach((inp) => {
      inp.oninput = () => { grid.columns[+inp.dataset.h] = inp.value; };
      inp.onchange = () => paintGrid();
    });
    host.querySelectorAll('[data-r]').forEach((inp) => {
      inp.oninput = () => { grid.rows[+inp.dataset.r][+inp.dataset.c] = inp.value; };
      inp.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const r = +inp.dataset.r;
          if (r === grid.rows.length - 1 && grid.rows.length < 200) { grid.rows.push(grid.columns.map(() => '')); paintGrid(); }
          focusCell(r + 1, +inp.dataset.c);
        }
      };
      // Paste a block copied from Excel / Sheets (tab-separated lines) and it fills the grid.
      inp.onpaste = (e) => {
        const text = (e.clipboardData || window.clipboardData).getData('text');
        if (!text || (!text.includes('\t') && !text.includes('\n'))) return;
        e.preventDefault();
        const lines = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map((l) => l.split('\t'));
        const r0 = +inp.dataset.r;
        const c0 = +inp.dataset.c;
        lines.forEach((cells, i) => {
          const r = r0 + i;
          if (r >= 200) return;
          while (grid.rows.length <= r) grid.rows.push(grid.columns.map(() => ''));
          cells.forEach((v, j) => {
            const c = c0 + j;
            if (c >= 20) return;
            while (grid.columns.length <= c) { grid.columns.push(''); grid.rows.forEach((row) => row.push('')); }
            grid.rows[r][c] = v.slice(0, 500);
          });
        });
        paintGrid();
      };
    });
    host.querySelectorAll('[data-delrow]').forEach((b) => { b.onclick = () => { grid.rows.splice(+b.dataset.delrow, 1); if (!grid.rows.length) grid.rows.push(grid.columns.map(() => '')); paintGrid(); }; });
    host.querySelectorAll('[data-delcol]').forEach((b) => { b.onclick = () => { const c = +b.dataset.delcol; grid.columns.splice(c, 1); grid.rows.forEach((row) => row.splice(c, 1)); paintGrid(); }; });
  }

  // ─── read the form ───────────────────────────────────────────────────────────
  const val = (sel) => { const el = $(sel); return el ? el.value.trim() : ''; };
  const num = (sel, d) => { const n = parseInt(val(sel), 10); return Number.isFinite(n) ? n : d; };
  function readConfig() {
    if (type === 'ical') {
      return {
        url: val('#dsUrlInput'),
        interval_min: num('#dsIntervalInput', 15),
        lookahead_days: num('#dsLookaheadInput', 14),
        filter_include: val('#dsFilterIncludeInput'),
        filter_exclude: val('#dsFilterExcludeInput'),
        locale: val('#dsLocaleInput'),
        timezone: val('#dsTzInput'),
        hide_private: $('#dsPrivacyInput').checked,
      };
    }
    if (type === 'weather') {
      const out = { units: val('#dsWxUnitsInput') === 'imperial' ? 'imperial' : 'metric', locale: val('#dsWxLocaleInput'), interval_min: num('#dsWxIntervalInput', 15) };
      const location = val('#dsWxLocationInput');
      const lat = val('#dsWxLatInput');
      const lon = val('#dsWxLonInput');
      if (location) out.location = location;
      if (lat !== '' || lon !== '') { out.latitude = lat === '' ? null : Number(lat); out.longitude = lon === '' ? null : Number(lon); }
      return out;
    }
    if (plugin()) return readPluginFields(plugin().fields || [], 'dsPlugin_');
    const tableOpts = () => {
      const o = { key_column: val('#f_key'), interval_min: num('#f_interval', 15), header_row: $('#f_header_row') ? $('#f_header_row').checked : true };
      if ($('#f_maxrows') && val('#f_maxrows')) o.max_rows = num('#f_maxrows', 100);
      return o;
    };
    if (type === 'sheets') return { url: val('#f_url'), sheet: val('#f_sheet'), range: val('#f_range'), ...tableOpts() };
    if (type === 'csv') return { url: val('#f_url'), delimiter: val('#f_delim') || 'auto', ...tableOpts() };
    if (type === 'rss') return { url: val('#f_url'), max_items: num('#f_items', 10), summary_chars: num('#f_chars', 200), locale: val('#f_locale'), timezone: val('#f_tz'), interval_min: num('#f_interval', 15) };
    if (type === 'table') {
      // Trailing empty rows are the editor's spare lines, not data.
      const rows = grid.rows.map((r) => r.map((v) => String(v == null ? '' : v)));
      while (rows.length && rows[rows.length - 1].every((v) => !v.trim())) rows.pop();
      return { columns: grid.columns.map((n) => n.trim()), rows, key_column: grid.key };
    }
    if (type === 'rest') {
      const auth = (overlay.querySelector('input[name="f_auth"]:checked') || {}).value || 'none';
      const c = { url: val('#f_url'), method: val('#f_method') || 'GET', json_path: val('#f_path'), response_format: val('#f_format') || 'auto', shape: val('#f_shape') || 'auto', auth_type: auth, ...tableOpts() };
      if (c.method === 'POST' && val('#f_body')) c.body = $('#f_body').value;
      if (auth === 'bearer') c.auth_token = $('#f_token_b').value;
      if (auth === 'header') { c.auth_header = val('#f_header'); c.auth_token = $('#f_token_h').value; }
      if (auth === 'basic') { c.auth_username = val('#f_user'); c.auth_password = $('#f_pass').value; }
      return c;
    }
    return {};
  }

  function missing(c) {
    if (type === 'weather') return !c.location && (c.latitude == null || c.longitude == null) ? t('data_sources.weather_location_required') : null;
    if (plugin()) return (plugin().fields || []).some((f) => f.required && (c[f.name] == null || c[f.name] === '')) ? t('data_sources.fill_required2') : null;
    if (type === 'table') return c.columns.some((n) => n) ? null : t('data_sources.table_need_col');
    if (type === 'sheets' && !parseSheetLink(c.url)) return t('data_sources.sheets_url_bad');
    return c.url ? null : t('data_sources.url_required');
  }

  // ─── test ────────────────────────────────────────────────────────────────────
  const testBtn = $('#dsTestBtn');
  testBtn.onclick = async () => {
    const result = $('#dsTestResult');
    const c = readConfig();
    const why = missing(c);
    if (why) { result.innerHTML = `<div class="ds-alert ds-alert-error">${esc(why)}</div>`; return; }
    testBtn.disabled = true;
    testBtn.classList.add('is-busy');
    result.innerHTML = `<div class="ds-testing"><span class="spinner"></span>${esc(t('data_sources.testing'))}</div>`;
    try {
      const res = await api.testDataSource(type, c, ds && ds.id);
      renderTestResult(result, res);
    } catch (err) {
      result.innerHTML = `<div class="ds-alert ds-alert-error"><strong>${esc(t('data_sources.test_failed2'))}</strong><span>${esc(err.message)}</span></div>`;
    } finally {
      testBtn.disabled = false;
      testBtn.classList.remove('is-busy');
    }
  };

  function renderTestResult(host, res) {
    const data = res.preview && typeof res.preview === 'object' ? res.preview : {};
    const n = Object.keys(data).length;
    let head = t('data_sources.test_ok_vars', { n });
    if (type === 'ical') head = t('data_sources.test_success', { n: data.event_count || 0 });
    else if (type === 'weather') head = t('data_sources.weather_test_success', { location: data.location || '' });
    else if (type === 'rss') head = t('data_sources.test_ok_feed', { title: data.feed_title || '', n: data.item_count || 0 });
    else if (data.row_count != null) head = t('data_sources.test_ok_rows', { rows: data.row_count, cols: data.column_count, n });
    const tbl = res.table && Array.isArray(res.table.columns) && res.table.columns.length ? res.table : null;
    lastColumns = tbl ? tbl.columns : [];
    const keyList = $('#f_key_list');
    if (keyList) keyList.innerHTML = lastColumns.map((col) => `<option value="${esc(col.name)}">`).join('');
    host.innerHTML = `
      <div class="ds-alert ds-alert-ok"><strong>${esc(head)}</strong></div>
      ${tbl ? `
        <div class="ds-sample">
          <div class="ds-sample-title">${esc(t('data_sources.sample_title'))}
            ${TABULAR.has(type) && type !== 'table' && !val('#f_key') ? `<span class="ds-muted"> · ${esc(t('data_sources.pick_key'))}</span>` : ''}</div>
          <div class="ds-sample-scroll"><table class="ds-sample-table">
            <thead><tr>${tbl.columns.map((col) => `<th>${TABULAR.has(type) && type !== 'table'
              ? `<button type="button" class="ds-colkey" data-key="${esc(col.name)}" title="${esc(t('data_sources.use_as_key'))}">${esc(col.name)}</button>`
              : esc(col.name)}<code>${esc(col.key)}</code></th>`).join('')}</tr></thead>
            <tbody>${(tbl.sample || []).map((r) => `<tr>${tbl.columns.map((col) => `<td>${esc(String(r[col.key] == null ? '' : r[col.key]).slice(0, 80))}</td>`).join('')}</tr>`).join('')}</tbody>
          </table></div>
        </div>` : ''}
      ${res.raw != null && !tbl ? `<details class="ds-adv"><summary>${esc(t('data_sources.raw_title'))}</summary><pre class="ds-raw">${esc(JSON.stringify(res.raw, null, 2).slice(0, 4000))}</pre></details>` : ''}
      <div class="ds-sample-title">${esc(t('data_sources.vars_title'))}</div>
      <div class="ds-vars-inline"></div>`;
    mountVariables(host.querySelector('.ds-vars-inline'), val('#dsSlugInput') || 'slug', data, type, !!(type === 'table' ? grid && grid.key : val('#f_key')));
    host.querySelectorAll('.ds-colkey').forEach((b) => {
      b.onclick = () => {
        const key = $('#f_key');
        if (!key) return;
        key.value = b.dataset.key;
        const adv = key.closest('details');
        if (adv) adv.open = true;
        showToast(t('data_sources.key_set', { col: b.dataset.key }), 'info');
        testBtn.click();
      };
    });
  }

  // ─── save ────────────────────────────────────────────────────────────────────
  const saveBtn = $('#saveDsModalBtn');
  saveBtn.onclick = async () => {
    const name = val('#dsNameInput');
    const slug = val('#dsSlugInput');
    const c = readConfig();
    const why = !name ? t('data_sources.name_required') : missing(c);
    const result = $('#dsTestResult');
    if (why) {
      result.innerHTML = `<div class="ds-alert ds-alert-error">${esc(why)}</div>`;
      result.scrollIntoView({ block: 'nearest' });
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = t('data_sources.saving');
    try {
      const payload = { name, slug: slug || undefined, type, config: c };
      if (isEdit) {
        await api.updateDataSource(ds.id, payload);
        showToast(t('data_sources.saved_ok'), 'success');
      } else {
        await api.createDataSource(payload);
        showToast(t('data_sources.created_ok'), 'success');
      }
      close();
      await loadDataSources();
      // The first sync runs in the background; show its result without a manual refresh.
      setTimeout(() => { if (document.getElementById('dataSourcesContainer')) loadDataSources(); }, 2500);
    } catch (err) {
      result.innerHTML = `<div class="ds-alert ds-alert-error">${esc(err.message || t('common.error'))}</div>`;
      saveBtn.disabled = false;
      saveBtn.textContent = isEdit ? t('common.save') : t('data_sources.save_connect');
    }
  };
  $('#dsBack').onclick = showGallery;

  if (type) showForm(type); else showGallery();
}

/* Mirrors server/lib/data-sources/sheets-resolver.js parseSheetUrl, for the as-you-type hint. */
function parseSheetLink(raw) {
  const s = String(raw || '').trim();
  if (/^[A-Za-z0-9_-]{20,128}$/.test(s)) return { kind: 'shared', gid: null };
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.hostname !== 'docs.google.com') return null;
  const g = u.searchParams.get('gid') || ((/(?:^|[#&])gid=(\d+)/.exec(u.hash) || [])[1]) || null;
  if (/^\/spreadsheets\/d\/e\/[A-Za-z0-9_-]{20,}/.test(u.pathname)) return { kind: 'published', gid: g };
  if (/^\/spreadsheets(?:\/u\/\d+)?\/d\/[A-Za-z0-9_-]{20,}/.test(u.pathname)) return { kind: 'shared', gid: g };
  return null;
}
