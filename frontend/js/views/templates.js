import { api, assertLocalCallAllowed, getAuthHeaders } from '../api.js';
import { showToast } from '../components/toast.js';
import { t } from '../i18n.js';
import { esc, isPlatformAdmin, hydrateAuthImages } from '../utils.js';
import { openContentPicker } from './widgets.js';

/*
 * The Templates library (#/templates): templates installed on this server, and the community
 * catalogs they come from.
 *
 * ⚠️ EVERY STRING FROM A MANIFEST OR A CATALOG INDEX IS THIRD-PARTY TEXT. A template's name,
 * description, author, tags, param labels, option labels, host names — all of it was written by
 * somebody who is not the operator and not us, and some of it arrives over the network from an
 * index. Every one of them goes through esc() on its way into markup, attributes included. The
 * preview is an iframe with sandbox="allow-scripts" and NEVER allow-same-origin: the preview URL is
 * on the dashboard's own origin, and the dashboard keeps its session token in localStorage (the
 * server also sends a `sandbox` CSP, but the attribute is the half this file owns).
 *
 * The server is the authority on who may install, import, uninstall or change the switches
 * (platform admins); the buttons here are hidden for everyone else only so nobody is offered a
 * control that will be refused.
 */

// Own fetch helper, because request() in api.js drops the error body — and a 409 from uninstall
// carries the list of widgets still using the template, which is the whole point of the answer.
async function TAPI(url, opts = {}) {
  assertLocalCallAllowed(url, opts.method);
  const r = await fetch('/api' + url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders(), ...(opts.headers || {}) },
  });
  if (r.status === 401) { localStorage.removeItem('token'); window.location.reload(); throw new Error('Session expired'); }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(body.error || `Request failed (${r.status})`);
    e.status = r.status;
    e.body = body;
    throw e;
  }
  return body;
}

const UNSIGNED_PHRASE = 'I understand unsigned templates run unreviewed code on my screens';

function currentUser() {
  try { return JSON.parse(localStorage.getItem('user') || '{}') || {}; } catch { return {}; }
}

function fmtTime(v) {
  if (!v) return t('templates.never');
  const n = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(String(v).includes('T') || String(v).endsWith('Z') ? v : String(v).replace(' ', 'T') + 'Z');
  if (!Number.isFinite(n)) return esc(String(v));
  return esc(new Date(n).toLocaleString());
}

function kindLabel(kind) {
  return kind === 'html' ? t('templates.kind_code') : t('templates.kind_slide');
}
function kindBadge(kind) {
  return `<span class="tpl-badge ${kind === 'html' ? 'tpl-badge-code' : 'tpl-badge-slide'}">${esc(kindLabel(kind))}</span>`;
}
function kindIcon(kind) {
  return kind === 'html'
    ? '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>'
    : '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="20" height="14" rx="1.5"/><line x1="6" y1="9" x2="14" y2="9"/><line x1="6" y1="13" x2="11" y2="13"/></svg>';
}
function trustBadge(tpl) {
  if (tpl.trust === 'verified') {
    return `<span class="tpl-badge tpl-badge-ok" title="${esc(t('templates.trust_verified_tip'))}">${esc(t('templates.trust_verified', { signer: tpl.signer || '?' }))}</span>`;
  }
  return `<span class="tpl-badge tpl-badge-warn" title="${esc(t('templates.trust_unverified_tip'))}">${esc(t('templates.trust_unverified'))}</span>`;
}
function hostsLine(hosts) {
  const list = Array.isArray(hosts) ? hosts : [];
  if (!list.length) return `<div class="tpl-meta">${esc(t('templates.network_none'))}</div>`;
  return `<div class="tpl-meta">${esc(t('templates.network_hosts'))} ${list.map((h) => `<code>${esc(h)}</code>`).join(' ')}</div>`;
}

/*
 * A card image: this server's content-addressed thumbnail route, or (library entries not cached
 * locally) an https URL on the catalog's host. Anything else — a javascript:/data: URL, a relative
 * path somewhere else on this origin — is not a thumbnail, and the kind icon is shown instead.
 * The <img> never carries credentials: the dashboard token is only ever sent by fetch().
 */
function thumbHtml(url, kind) {
  const u = typeof url === 'string' ? url : '';
  const ok = /^\/api\/templates\/thumb\/[0-9a-f]{64}$/.test(u) || /^https:\/\/[^\s"'<>]+$/i.test(u);
  if (!ok) return kindIcon(kind);
  return `<img data-thumb data-kind="${esc(kind)}" src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
}
function wireThumbFallbacks(root) {
  root.querySelectorAll('img[data-thumb]').forEach((img) => img.addEventListener('error', () => {
    const wrap = img.parentElement;
    if (wrap) wrap.innerHTML = kindIcon(img.dataset.kind);
  }));
}

/* ------------------------------------------------------------------ small modal helper */

function openModal({ title, body, footer, width = 520 }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="width:${Number(width) || 520}px">
      <div class="modal-header"><h3>${esc(title)}</h3>
        <button class="btn-icon" data-close aria-label="${esc(t('common.cancel'))}">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-footer">${footer}</div>` : ''}
    </div>`;
  document.body.appendChild(overlay);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const closers = [];
  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    for (const fn of closers) { try { fn(); } catch { /* ignore */ } }
  }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  return { overlay, close, onClose: (fn) => closers.push(fn), $: (sel) => overlay.querySelector(sel) };
}

function confirmModal({ title, body, confirmLabel, danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const m = openModal({
      title,
      body,
      footer: `<button class="btn btn-secondary" data-close>${esc(t('common.cancel'))}</button>
               <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(confirmLabel)}</button>`,
    });
    m.onClose(() => { if (!answered) resolve(false); });
    m.$('[data-ok]').addEventListener('click', () => { answered = true; m.close(); resolve(true); });
  });
}

/* ------------------------------------------------------------------ the view */

let activeTab = 'installed';

export async function render(container) {
  const admin = isPlatformAdmin(currentUser());
  container.innerHTML = `
    <div class="page-header">
      <div><h1>${esc(t('templates.title'))}</h1><div class="subtitle">${esc(t('templates.subtitle'))}</div></div>
      ${admin ? `<div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-secondary" id="tplImportBtn">${esc(t('templates.import'))}</button>
        <button class="btn btn-secondary" id="tplSettingsBtn">${esc(t('templates.settings'))}</button>
      </div>` : ''}
    </div>
    <div class="tabs" role="tablist">
      <div class="tab" data-tab="installed" role="tab">${esc(t('templates.tab_installed'))}</div>
      <div class="tab" data-tab="library" role="tab">${esc(t('templates.tab_library'))} <span id="tplNewCount"></span></div>
    </div>
    <div id="tplBody"></div>`;

  const body = container.querySelector('#tplBody');
  const setTab = (tab) => {
    activeTab = tab;
    container.querySelectorAll('[data-tab]').forEach((el) => el.classList.toggle('active', el.dataset.tab === tab));
    if (tab === 'library') renderLibrary(body, admin, refresh);
    else renderInstalled(body, admin, refresh);
  };
  const refresh = () => setTab(activeTab);
  container.querySelectorAll('[data-tab]').forEach((el) => el.addEventListener('click', () => setTab(el.dataset.tab)));
  if (admin) {
    container.querySelector('#tplImportBtn').addEventListener('click', () => openImportModal(refresh));
    container.querySelector('#tplSettingsBtn').addEventListener('click', () => openSettingsModal(refresh));
  }
  setTab(activeTab);
}

export function cleanup() {}

/* ------------------------------------------------------------------ installed */

async function renderInstalled(body, admin, refresh) {
  body.innerHTML = `<div class="tpl-meta">${esc(t('templates.loading'))}</div>`;
  let list;
  try { list = (await TAPI('/templates/installed')).templates || []; } catch (e) {
    body.innerHTML = `<div class="tpl-callout tpl-callout-error">${esc(e.message)}</div>`;
    return;
  }
  if (activeTab !== 'installed') return;
  if (!list.length) {
    body.innerHTML = `<div class="empty-state"><h3>${esc(t('templates.installed_empty_title'))}</h3>
      <p>${esc(admin ? t('templates.installed_empty_admin') : t('templates.installed_empty_user'))}</p></div>`;
    return;
  }
  // How many of this workspace's widgets each template is behind, so it is obvious that "Use…" makes
  // ANOTHER independent widget rather than being a one-time step. Best-effort: no count on failure.
  const inUse = new Map();
  try {
    for (const w of (await TAPI('/widgets')) || []) {
      if (w.widget_type !== 'template') continue;
      let key = null;
      try { key = JSON.parse(w.config || '{}').template; } catch { /* unreadable config */ }
      if (key) inUse.set(key, (inUse.get(key) || 0) + 1);
    }
  } catch { /* counts are a hint, never a blocker */ }
  if (activeTab !== 'installed') return;
  body.innerHTML = `<div class="content-grid tpl-grid">${list.map((tpl) => installedCard(tpl, admin, inUse.get(tpl.key) || 0)).join('')}</div>`;
  body.querySelectorAll('[data-use]').forEach((b) => b.addEventListener('click', () => {
    const tpl = list.find((x) => x.key === b.dataset.use);
    if (tpl) openUseModal({ tpl });
  }));
  body.querySelectorAll('[data-uninstall]').forEach((b) => b.addEventListener('click', () => {
    const tpl = list.find((x) => x.key === b.dataset.uninstall);
    if (tpl) uninstall(tpl, refresh);
  }));
  wireThumbFallbacks(body);
}

function installedCard(tpl, admin, used = 0) {
  const revoked = tpl.status && tpl.status !== 'active';
  const preview = thumbHtml(tpl.thumbnail, tpl.kind);
  return `
    <div class="content-item tpl-card${revoked ? ' tpl-card-revoked' : ''}">
      <div class="content-item-preview tpl-preview">${preview}</div>
      ${revoked ? `<div class="tpl-banner-danger">${esc(t('templates.revoked'))}${tpl.status_reason ? `: ${esc(tpl.status_reason)}` : ''}</div>` : ''}
      <div class="content-item-body">
        <div class="content-item-name" title="${esc(tpl.name)}">${esc(tpl.name)}</div>
        <div class="tpl-meta">v${esc(tpl.version)}${tpl.author ? ` · ${esc(tpl.author)}` : ''}${tpl.license ? ` · ${esc(tpl.license)}` : ''}</div>
        <div class="tpl-badges">${kindBadge(tpl.kind)} ${trustBadge(tpl)}</div>
        ${tpl.description ? `<div class="tpl-desc">${esc(tpl.description)}</div>` : ''}
        ${tpl.kind === 'html' ? hostsLine(tpl.network) : ''}
        ${!tpl.usable && !revoked && tpl.unusable_reason ? `<div class="tpl-meta tpl-warn-text">${esc(tpl.unusable_reason)}</div>` : ''}
        ${used ? `<div class="tpl-meta tpl-inuse"><a href="#/widgets">${esc(used === 1 ? t('templates.in_use_one') : t('templates.in_use_many', { count: used }))}</a>${tpl.usable ? ` · ${esc(t('templates.use_again_hint'))}` : ''}</div>` : ''}
      </div>
      <div class="content-item-actions">
        ${admin ? `<button class="btn btn-danger btn-sm" data-uninstall="${esc(tpl.key)}">${esc(t('templates.uninstall'))}</button>` : ''}
        <button class="btn btn-primary btn-sm" data-use="${esc(tpl.key)}" ${tpl.usable ? '' : `disabled title="${esc(tpl.unusable_reason || '')}"`}>${esc(t('templates.use'))}</button>
      </div>
    </div>`;
}

async function uninstall(tpl, refresh) {
  const ok = await confirmModal({
    title: t('templates.uninstall_title'),
    body: `<p>${esc(t('templates.uninstall_confirm', { name: tpl.name, version: tpl.version }))}</p>`,
    confirmLabel: t('templates.uninstall'),
    danger: true,
  });
  if (!ok) return;
  const [cat, id] = String(tpl.key).split('/');
  try {
    await TAPI(`/templates/installed/${encodeURIComponent(cat)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    showToast(t('templates.toast_uninstalled', { name: tpl.name }), 'success');
    refresh();
  } catch (e) {
    if (e.status === 409 && e.body && Array.isArray(e.body.widgets)) {
      openModal({
        title: t('templates.still_used_title'),
        body: `<p>${esc(t('templates.still_used_desc', { name: tpl.name, n: e.body.widgets.length }))}</p>
          <ul class="tpl-list">${e.body.widgets.map((w) => `<li>${esc(w.name || w.id)} <span class="tpl-meta">(${esc(w.workspace_id || '')})</span></li>`).join('')}</ul>`,
        footer: `<a class="btn btn-secondary" href="#/widgets" data-close>${esc(t('templates.go_widgets'))}</a><button class="btn btn-primary" data-close>${esc(t('common.done'))}</button>`,
      });
      return;
    }
    showToast(e.message, 'error');
  }
}

/* ------------------------------------------------------------------ library */

async function renderLibrary(body, admin, refresh) {
  body.innerHTML = `<div class="tpl-meta">${esc(t('templates.loading'))}</div>`;
  let lib;
  try { lib = await TAPI('/templates/library'); } catch (e) {
    body.innerHTML = `<div class="tpl-callout tpl-callout-error">${esc(e.message)}</div>`;
    return;
  }
  if (activeTab !== 'library') return;
  const catalogs = Array.isArray(lib.catalogs) ? lib.catalogs : [];
  let html = '';
  if (!lib.network_enabled) {
    html += `<div class="tpl-callout">
      <strong>${esc(t('templates.network_off_title'))}</strong>
      <p>${esc(t('templates.network_off_desc'))}</p>
      ${admin ? `<button class="btn btn-primary btn-sm" id="tplEnableNet">${esc(t('templates.enable_network'))}</button>`
    : `<p class="tpl-meta">${esc(t('templates.network_off_ask_admin'))}</p>`}
    </div>`;
  }
  for (const c of catalogs) {
    html += `<section class="tpl-catalog">
      <div class="tpl-catalog-head">
        <div>
          <h3>${esc(c.label || c.id)} ${c.enabled ? '' : `<span class="tpl-badge">${esc(t('templates.catalog_disabled'))}</span>`}</h3>
          <div class="tpl-meta">${esc(t('templates.catalog_key'))} <code>${esc(c.key_id || '?')}</code> · ${esc(t('templates.last_checked'))} ${fmtTime(c.last_checked)}${c.serial ? ` · ${esc(t('templates.serial'))} ${esc(c.serial)}` : ''}</div>
        </div>
        ${admin ? `<button class="btn btn-secondary btn-sm" data-refresh="${esc(c.id)}" ${lib.network_enabled && c.enabled && c.url ? '' : `disabled title="${esc(t('templates.check_now_disabled'))}"`}>${esc(t('templates.check_now'))}</button>` : ''}
      </div>
      ${c.stale ? `<div class="tpl-callout tpl-callout-warn">${esc(t('templates.stale', { date: c.expires || '' }))}</div>` : ''}
      ${c.last_error ? `<div class="tpl-callout tpl-callout-error">${esc(t('templates.last_error'))} ${esc(c.last_error)}</div>` : ''}
      ${c.templates && c.templates.length
    ? `<div class="content-grid tpl-grid">${c.templates.map((e) => libraryCard(e, admin)).join('')}</div>`
    : `<div class="tpl-meta" style="padding:8px 0 16px">${esc(c.enabled ? t('templates.catalog_empty') : t('templates.catalog_off'))}</div>`}
    </section>`;
  }
  if (!catalogs.length) html += `<div class="empty-state"><h3>${esc(t('templates.no_catalogs'))}</h3></div>`;
  body.innerHTML = html;

  const newCount = catalogs.reduce((n, c) => n + (c.templates || []).filter((e) => e.is_new || e.is_updated).length, 0);
  const counter = document.getElementById('tplNewCount');
  if (counter) counter.innerHTML = newCount ? `<span class="tpl-badge tpl-badge-new">${esc(String(newCount))}</span>` : '';

  wireThumbFallbacks(body);
  const en = body.querySelector('#tplEnableNet');
  if (en) en.addEventListener('click', async () => {
    en.disabled = true;
    try {
      await TAPI('/templates/settings', { method: 'PUT', body: JSON.stringify({ network_enabled: true }) });
      showToast(t('templates.toast_network_on'), 'success');
      refresh();
    } catch (e) { en.disabled = false; showToast(e.message, 'error'); }
  });
  body.querySelectorAll('[data-refresh]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    b.textContent = t('templates.checking');
    try {
      const r = await TAPI(`/templates/catalogs/${encodeURIComponent(b.dataset.refresh)}/refresh`, { method: 'POST', body: '{}' });
      showToast(t('templates.toast_checked', { n: r.templates }), 'success');
    } catch (e) { showToast(e.message, 'error'); }
    refresh();
  }));
  body.querySelectorAll('[data-install]').forEach((b) => b.addEventListener('click', () => {
    const [cid, id] = b.dataset.install.split('/');
    const c = catalogs.find((x) => x.id === cid);
    const e = c && c.templates.find((x) => x.id === id);
    if (e) installFromLibrary(e, refresh);
  }));

  // Opening the tab is what "seen" means; the badges on screen stay until the next load.
  if (newCount) TAPI('/templates/library/seen', { method: 'POST', body: '{}' }).catch(() => {});
}

function libraryCard(e, admin) {
  const badges = [];
  if (e.is_new) badges.push(`<span class="tpl-badge tpl-badge-new">${esc(t('templates.badge_new'))}</span>`);
  if (e.is_updated) badges.push(`<span class="tpl-badge tpl-badge-new">${esc(t('templates.badge_updated'))}</span>`);
  let status = '';
  if (e.update_available) status = `<span class="tpl-badge tpl-badge-warn">${esc(t('templates.update_available', { from: e.installed, to: e.latest }))}</span>`;
  else if (e.installed) status = `<span class="tpl-badge tpl-badge-ok">${esc(t('templates.installed_version', { version: e.installed }))}</span>`;
  let action = '';
  if (admin && e.compatible !== false && (!e.installed || e.update_available)) {
    action = `<button class="btn btn-primary btn-sm" data-install="${esc(e.key)}">${esc(e.installed ? t('templates.update') : t('templates.install'))}</button>`;
  }
  return `
    <div class="content-item tpl-card">
      <div class="content-item-preview tpl-preview">${thumbHtml(e.thumbnail, e.kind)}</div>
      <div class="content-item-body">
        <div class="content-item-name" title="${esc(e.name)}">${esc(e.name)}</div>
        <div class="tpl-meta">v${esc(e.latest)}${e.author ? ` · ${esc(e.author)}` : ''}${e.license ? ` · ${esc(e.license)}` : ''}</div>
        <div class="tpl-badges">${kindBadge(e.kind)} ${badges.join(' ')} ${status}</div>
        ${e.description ? `<div class="tpl-desc">${esc(e.description)}</div>` : ''}
        ${Array.isArray(e.tags) && e.tags.length ? `<div class="tpl-tags">${e.tags.map((x) => `<span class="tpl-tag">${esc(x)}</span>`).join('')}</div>` : ''}
        ${e.kind === 'html' ? hostsLine(e.network) : ''}
        ${e.compatible === false ? `<div class="tpl-meta tpl-warn-text">${esc(t('templates.needs_server', { version: e.min_server || '?' }))}</div>` : ''}
      </div>
      <div class="content-item-actions">${action}</div>
    </div>`;
}

async function installFromLibrary(e, refresh) {
  const code = e.kind === 'html';
  const ok = await confirmModal({
    title: e.installed ? t('templates.update_title', { name: e.name }) : t('templates.install_title', { name: e.name }),
    body: `
      <p>${esc(t('templates.install_confirm', { name: e.name, version: e.latest, catalog: e.catalog }))}</p>
      <p>${esc(t('templates.kind'))} ${kindBadge(e.kind)}</p>
      ${code ? `<div class="tpl-callout tpl-callout-warn">
          <p><strong>${esc(t('templates.code_warning'))}</strong></p>
          ${hostsLine(e.network)}
        </div>` : `<p class="tpl-meta">${esc(t('templates.slide_note'))}</p>`}
      <p class="tpl-meta">${esc(t('templates.install_instance_wide'))}</p>`,
    confirmLabel: e.installed ? t('templates.update') : t('templates.install'),
  });
  if (!ok) return;
  try {
    await TAPI('/templates/install', { method: 'POST', body: JSON.stringify({ catalog: e.catalog, id: e.id, version: e.latest }) });
    showToast(t('templates.toast_installed', { name: e.name, version: e.latest }), 'success');
  } catch (err) { showToast(err.message, 'error'); }
  refresh();
}

/* ------------------------------------------------------------------ import */

function openImportModal(refresh) {
  const m = openModal({
    title: t('templates.import_title'),
    body: `
      <p class="modal-description">${esc(t('templates.import_desc'))}</p>
      <div class="form-group"><input type="file" id="tplImportFile" class="input" accept=".sttemplate,.zip,application/zip,application/json"></div>
      <div class="form-group"><label style="display:flex;gap:8px;align-items:center;cursor:pointer">
        <input type="checkbox" id="tplImportBundle"> ${esc(t('templates.import_bundle'))}</label>
        <div class="tpl-meta">${esc(t('templates.import_bundle_hint'))}</div></div>
      <div id="tplImportStatus" class="tpl-meta"></div>`,
    footer: `<button class="btn btn-secondary" data-close>${esc(t('common.cancel'))}</button>
             <button class="btn btn-primary" id="tplImportGo">${esc(t('templates.import'))}</button>`,
  });
  const status = m.$('#tplImportStatus');
  m.$('#tplImportGo').addEventListener('click', async () => {
    const file = m.$('#tplImportFile').files[0];
    if (!file) { status.textContent = t('templates.import_pick_file'); return; }
    const bundle = m.$('#tplImportBundle').checked;
    const url = '/templates/import' + (bundle ? '?kind=bundle' : '');
    const go = m.$('#tplImportGo');
    go.disabled = true;
    status.textContent = t('templates.importing');
    try {
      assertLocalCallAllowed(url, 'POST');
      const r = await fetch('/api' + url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', ...getAuthHeaders() },
        body: file,
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || `Request failed (${r.status})`);
      if (out.bundle) {
        showToast(t('templates.toast_bundle', { catalog: out.bundle.catalog, n: out.bundle.templates, packages: out.bundle.packages }), 'success');
        activeTab = 'library';
      } else {
        showToast(t('templates.toast_imported', { name: out.name, version: out.version }), 'success');
        activeTab = 'installed';
      }
      m.close();
      refresh();
    } catch (e) {
      go.disabled = false;
      status.innerHTML = `<span class="tpl-warn-text">${esc(e.message)}</span>`;
    }
  });
}

/* ------------------------------------------------------------------ settings */

async function openSettingsModal(refresh) {
  const m = openModal({ title: t('templates.settings_title'), body: `<div class="tpl-meta">${esc(t('templates.loading'))}</div>`, width: 720 });
  m.onClose(refresh);
  const bodyEl = m.$('.modal-body');

  async function draw() {
    let s, cats;
    try {
      [s, cats] = await Promise.all([TAPI('/templates/settings'), TAPI('/templates/catalogs')]);
    } catch (e) { bodyEl.innerHTML = `<div class="tpl-callout tpl-callout-error">${esc(e.message)}</div>`; return; }
    const list = cats.catalogs || [];
    bodyEl.innerHTML = `
      <div class="form-group">
        <label style="display:flex;gap:8px;align-items:center;cursor:pointer;font-size:14px;color:var(--text-primary)">
          <input type="checkbox" id="tplSetNet" ${s.network_enabled ? 'checked' : ''}> ${esc(t('templates.setting_network'))}</label>
        <div class="tpl-meta">${esc(t('templates.setting_network_hint'))}</div>
      </div>
      <div class="form-group">
        <label style="display:flex;gap:8px;align-items:center;cursor:pointer;font-size:14px;color:var(--text-primary)">
          <input type="checkbox" id="tplSetUnsigned" ${s.unsigned_code_allowed ? 'checked' : ''}> ${esc(t('templates.setting_unsigned'))}</label>
        <div class="tpl-meta">${esc(t('templates.setting_unsigned_hint'))}</div>
        <div id="tplUnsignedConfirm" class="tpl-callout tpl-callout-warn" style="display:none;margin-top:8px">
          <p>${esc(t('templates.unsigned_type_phrase'))}</p>
          <p><code>${esc(UNSIGNED_PHRASE)}</code></p>
          <input type="text" class="input" id="tplUnsignedPhrase" autocomplete="off" spellcheck="false">
          <div style="display:flex;gap:8px;margin-top:8px">
            <button class="btn btn-secondary btn-sm" id="tplUnsignedCancel">${esc(t('common.cancel'))}</button>
            <button class="btn btn-danger btn-sm" id="tplUnsignedGo" disabled>${esc(t('templates.unsigned_enable'))}</button>
          </div>
        </div>
      </div>
      <h4 style="margin:20px 0 8px">${esc(t('templates.catalogs'))}</h4>
      <div class="table-wrap"><table class="tpl-table">
        <thead><tr><th>${esc(t('templates.col_catalog'))}</th><th>${esc(t('templates.col_key'))}</th><th>${esc(t('templates.col_status'))}</th><th></th></tr></thead>
        <tbody>${list.map((c) => `<tr>
          <td><strong>${esc(c.label)}</strong> <span class="tpl-meta">(${esc(c.id)})</span>${c.builtin ? ` <span class="tpl-badge">${esc(t('templates.builtin'))}</span>` : ''}<div class="tpl-meta tpl-break">${esc(c.url || t('templates.no_url'))}</div></td>
          <td><code>${esc(c.key_id || '?')}</code></td>
          <td class="tpl-meta">${esc(t('templates.last_checked'))} ${fmtTime(c.last_checked)}${c.last_error ? `<div class="tpl-warn-text">${esc(c.last_error)}</div>` : ''}</td>
          <td style="white-space:nowrap">
            <label style="display:inline-flex;gap:4px;align-items:center;cursor:pointer"><input type="checkbox" data-cat-toggle="${esc(c.id)}" ${c.enabled ? 'checked' : ''}> ${esc(t('templates.enabled'))}</label>
            ${c.builtin ? '' : `<button class="btn btn-danger btn-sm" data-cat-remove="${esc(c.id)}">${esc(t('templates.remove'))}</button>`}
          </td></tr>`).join('')}</tbody>
      </table></div>
      <details style="margin-top:12px"><summary style="cursor:pointer">${esc(t('templates.add_catalog'))}</summary>
        <div style="margin-top:10px">
          <p class="tpl-meta">${esc(t('templates.add_catalog_hint'))}</p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <div class="form-group"><label>${esc(t('templates.catalog_id'))}</label><input class="input" id="tplCatId" placeholder="acme" maxlength="32"></div>
            <div class="form-group"><label>${esc(t('templates.catalog_label'))}</label><input class="input" id="tplCatLabel" maxlength="60"></div>
          </div>
          <div class="form-group"><label>${esc(t('templates.catalog_url'))}</label><input class="input" id="tplCatUrl" placeholder="https://example.com/templates/index.json"></div>
          <div class="form-group"><label>${esc(t('templates.catalog_pubkey'))}</label><textarea class="input" id="tplCatKey" rows="4" placeholder="-----BEGIN PUBLIC KEY-----" spellcheck="false"></textarea></div>
          <button class="btn btn-primary btn-sm" id="tplCatAdd">${esc(t('templates.add_catalog_btn'))}</button>
        </div>
      </details>`;

    const put = (payload) => TAPI('/templates/settings', { method: 'PUT', body: JSON.stringify(payload) });
    const net = bodyEl.querySelector('#tplSetNet');
    net.addEventListener('change', async () => {
      try { await put({ network_enabled: net.checked }); showToast(net.checked ? t('templates.toast_network_on') : t('templates.toast_network_off'), 'success'); }
      catch (e) { net.checked = !net.checked; showToast(e.message, 'error'); }
    });
    const uns = bodyEl.querySelector('#tplSetUnsigned');
    const box = bodyEl.querySelector('#tplUnsignedConfirm');
    const phrase = bodyEl.querySelector('#tplUnsignedPhrase');
    const goBtn = bodyEl.querySelector('#tplUnsignedGo');
    uns.addEventListener('change', async () => {
      if (uns.checked) {
        // Said, not clicked past: the server refuses without the exact phrase.
        uns.checked = false;
        box.style.display = '';
        phrase.value = '';
        goBtn.disabled = true;
        phrase.focus();
        return;
      }
      try { await put({ unsigned_code_allowed: false }); showToast(t('templates.toast_unsigned_off'), 'success'); }
      catch (e) { uns.checked = true; showToast(e.message, 'error'); }
    });
    phrase.addEventListener('input', () => { goBtn.disabled = phrase.value.trim() !== UNSIGNED_PHRASE; });
    bodyEl.querySelector('#tplUnsignedCancel').addEventListener('click', () => { box.style.display = 'none'; });
    goBtn.addEventListener('click', async () => {
      try {
        await put({ unsigned_code_allowed: true, confirm: phrase.value.trim() });
        showToast(t('templates.toast_unsigned_on'), 'success');
        box.style.display = 'none';
        uns.checked = true;
      } catch (e) { showToast(e.message, 'error'); }
    });
    bodyEl.querySelectorAll('[data-cat-toggle]').forEach((cb) => cb.addEventListener('change', async () => {
      try {
        await TAPI(`/templates/catalogs/${encodeURIComponent(cb.dataset.catToggle)}`, { method: 'PATCH', body: JSON.stringify({ enabled: cb.checked }) });
      } catch (e) { cb.checked = !cb.checked; showToast(e.message, 'error'); }
    }));
    bodyEl.querySelectorAll('[data-cat-remove]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.catRemove;
      if (!window.confirm(t('templates.remove_catalog_confirm', { id }))) return;
      try { await TAPI(`/templates/catalogs/${encodeURIComponent(id)}`, { method: 'DELETE' }); showToast(t('templates.toast_catalog_removed'), 'success'); draw(); }
      catch (e) { showToast(e.message, 'error'); }
    }));
    bodyEl.querySelector('#tplCatAdd').addEventListener('click', async () => {
      const payload = {
        id: bodyEl.querySelector('#tplCatId').value.trim(),
        label: bodyEl.querySelector('#tplCatLabel').value.trim(),
        url: bodyEl.querySelector('#tplCatUrl').value.trim(),
        public_key: bodyEl.querySelector('#tplCatKey').value.trim(),
      };
      try { await TAPI('/templates/catalogs', { method: 'POST', body: JSON.stringify(payload) }); showToast(t('templates.toast_catalog_added'), 'success'); draw(); }
      catch (e) { showToast(e.message, 'error'); }
    });
  }
  draw();
}

/* ------------------------------------------------------------------ use / edit form */

function supportedTimezones() {
  try { return Intl.supportedValuesOf('timeZone') || []; } catch { return []; }
}
const COMMON_LOCALES = ['en', 'en-GB', 'en-US', 'de', 'de-CH', 'es', 'fr', 'it', 'ja', 'nl', 'pt', 'pt-BR', 'zh', 'hi'];

function toHexColor(v) {
  const s = String(v || '');
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) return '#' + s.slice(1).split('').map((c) => c + c).join('');
  return '#000000';
}

function paramFieldHtml(p, value, dataSources) {
  const id = 'tplp_' + p.name;
  const label = `${esc(p.label || p.name)}${p.required ? ' *' : ''}`;
  const help = p.help ? `<div class="tpl-meta">${esc(p.help)}</div>` : '';
  const v = value === undefined || value === null ? '' : value;
  switch (p.type) {
    case 'textarea':
      return `<div class="form-group"><label for="${esc(id)}">${label}</label><textarea class="input" id="${esc(id)}" data-param="${esc(p.name)}" rows="3" maxlength="${Number(p.max) || 2000}">${esc(v)}</textarea>${help}</div>`;
    case 'color':
      return `<div class="form-group"><label for="${esc(id)}">${label}</label><input type="color" id="${esc(id)}" data-param="${esc(p.name)}" value="${esc(toHexColor(v))}" style="width:60px;height:32px;border:none;background:none">${help}</div>`;
    case 'number':
      return `<div class="form-group"><label for="${esc(id)}">${label}</label><input type="number" class="input" id="${esc(id)}" data-param="${esc(p.name)}" value="${esc(v)}"${p.min !== undefined ? ` min="${esc(p.min)}"` : ''}${p.max !== undefined ? ` max="${esc(p.max)}"` : ''}${p.step !== undefined ? ` step="${esc(p.step)}"` : ''}>${help}</div>`;
    case 'select':
      return `<div class="form-group"><label for="${esc(id)}">${label}</label><select class="input" id="${esc(id)}" data-param="${esc(p.name)}">${(p.options || []).map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(v) ? 'selected' : ''}>${esc(o.label || o.value)}</option>`).join('')}</select>${help}</div>`;
    case 'checkbox':
      return `<div class="form-group"><label style="display:flex;gap:8px;align-items:center;cursor:pointer"><input type="checkbox" id="${esc(id)}" data-param="${esc(p.name)}" ${v === true || v === 'true' ? 'checked' : ''}> ${label}</label>${help}</div>`;
    case 'timezone': {
      const zones = supportedTimezones();
      if (!zones.length) return `<div class="form-group"><label for="${esc(id)}">${label}</label><input class="input" id="${esc(id)}" data-param="${esc(p.name)}" value="${esc(v)}" placeholder="Europe/London">${help}</div>`;
      const all = [...new Set([v, 'UTC', ...zones].filter(Boolean))].sort();
      return `<div class="form-group"><label for="${esc(id)}">${label}</label><select class="input" id="${esc(id)}" data-param="${esc(p.name)}">
        <option value="" ${v === '' ? 'selected' : ''}>${esc(t('templates.tz_screen'))}</option>
        ${all.map((z) => `<option value="${esc(z)}" ${z === v ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select>${help}</div>`;
    }
    case 'locale':
      return `<div class="form-group"><label for="${esc(id)}">${label}</label><input class="input" id="${esc(id)}" data-param="${esc(p.name)}" value="${esc(v)}" list="${esc(id)}_list" placeholder="${esc(t('templates.locale_placeholder'))}" maxlength="32">
        <datalist id="${esc(id)}_list">${COMMON_LOCALES.map((l) => `<option value="${esc(l)}">`).join('')}</datalist>${help}</div>`;
    case 'data_source': {
      const known = dataSources.some((d) => d.slug === v);
      return `<div class="form-group"><label for="${esc(id)}">${label}</label><select class="input" id="${esc(id)}" data-param="${esc(p.name)}">
        <option value="">${esc(t('templates.ds_none'))}</option>
        ${dataSources.map((d) => `<option value="${esc(d.slug)}" ${d.slug === v ? 'selected' : ''}>${esc(d.name)} (${esc(d.type)})</option>`).join('')}
        ${v && !known ? `<option value="${esc(v)}" selected>${esc(v)} — ${esc(t('templates.ds_missing'))}</option>` : ''}
      </select>${dataSources.length ? '' : `<div class="tpl-meta">${esc(t('templates.ds_empty'))} <a href="#/data-sources">${esc(t('nav.data_sources'))}</a></div>`}${help}</div>`;
    }
    case 'image':
      return `<div class="form-group"><label>${label}</label>
        <div class="tpl-image-field" data-image-param="${esc(p.name)}">
          <div class="tpl-image-thumb" data-image-thumb></div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button type="button" class="btn btn-secondary btn-sm" data-image-pick>${esc(t('templates.image_choose'))}</button>
            ${p.default ? `<button type="button" class="btn btn-secondary btn-sm" data-image-default>${esc(t('templates.image_default'))}</button>` : ''}
            <button type="button" class="btn btn-secondary btn-sm" data-image-clear>${esc(t('templates.image_clear'))}</button>
          </div>
        </div>${help}</div>`;
    case 'text':
    default:
      return `<div class="form-group"><label for="${esc(id)}">${label}</label><input type="text" class="input" id="${esc(id)}" data-param="${esc(p.name)}" value="${esc(v)}" maxlength="${Number(p.max) || 200}">${help}</div>`;
  }
}

/**
 * The Use form. `tpl` is an installed template (public shape) — or pass `widget` (a template
 * widget row) to edit one in place, with `values`/`name` from its config or pending draft.
 */
export async function openUseModal({ tpl, widget = null, values: initialValues = null, name: initialName = null, onSaved = null } = {}) {
  if (!tpl && widget) {
    let cfg = {};
    try { cfg = JSON.parse(widget.config || '{}'); } catch { cfg = {}; }
    const key = String(cfg.template || '');
    const [cat, id] = key.split('/');
    try {
      tpl = await TAPI(`/templates/installed/${encodeURIComponent(cat || '')}/${encodeURIComponent(id || '')}`);
    } catch (e) {
      showToast(t('templates.widget_template_missing', { key, error: e.message }), 'error');
      return;
    }
  }
  if (!tpl) return;
  const params = Array.isArray(tpl.params) ? tpl.params : [];
  const values = {};
  for (const p of params) {
    if (initialValues && Object.prototype.hasOwnProperty.call(initialValues, p.name)) values[p.name] = initialValues[p.name];
    else if (p.default !== undefined) values[p.name] = p.default;
    else values[p.name] = p.type === 'checkbox' ? false : '';
  }
  let dataSources = [];
  if (params.some((p) => p.type === 'data_source')) {
    try { const r = await api.getDataSources(); dataSources = Array.isArray(r) ? r : []; } catch { dataSources = []; }
  }
  const editing = !!widget;
  const [cat, id] = String(tpl.key).split('/');
  const base = `/templates/installed/${encodeURIComponent(cat)}/${encodeURIComponent(id)}`;

  const m = openModal({
    title: editing ? t('templates.edit_title', { name: widget.name }) : t('templates.use_title', { name: tpl.name }),
    width: 1040,
    body: `
      <div class="tpl-use">
        <div class="tpl-use-form">
          <div class="tpl-badges" style="margin-bottom:12px">${kindBadge(tpl.kind)} ${trustBadge(tpl)} <span class="tpl-meta">v${esc(tpl.version)}</span></div>
          ${tpl.kind === 'html' ? `<div class="tpl-callout tpl-callout-warn tpl-small">${esc(t('templates.code_values_visible'))}</div>` : ''}
          <div class="form-group"><label for="tplUseName">${esc(t('templates.widget_name'))}</label>
            <input type="text" class="input" id="tplUseName" maxlength="120" value="${esc(initialName != null ? initialName : (widget ? widget.name : tpl.name))}"></div>
          ${params.map((p) => paramFieldHtml(p, values[p.name], dataSources)).join('')}
          <div id="tplUseError" class="tpl-warn-text" style="min-height:1em"></div>
        </div>
        <div class="tpl-use-preview">
          <div class="tpl-meta" style="display:flex;justify-content:space-between"><span>${esc(t('templates.preview'))}</span><span id="tplPreviewState"></span></div>
          <div class="tpl-frame-wrap"><iframe id="tplPreviewFrame" sandbox="allow-scripts" referrerpolicy="no-referrer" title="${esc(t('templates.preview'))}"></iframe></div>
          <div id="tplDone" style="display:none"></div>
        </div>
      </div>`,
    footer: `<button class="btn btn-secondary" data-close>${esc(t('common.cancel'))}</button>
             <button class="btn btn-primary" id="tplUseGo">${esc(editing ? t('common.save') : t('templates.create'))}</button>`,
  });

  // Image params: the value is a content id from this workspace's library, or tpl:<file> for the
  // template's own bundled image. Neither is shown as a URL anyone typed.
  function paintImage(name) {
    const host = m.overlay.querySelector(`[data-image-param="${CSS.escape(name)}"] [data-image-thumb]`);
    if (!host) return;
    const v = values[name];
    if (!v) host.innerHTML = `<span class="tpl-meta">${esc(t('templates.image_none'))}</span>`;
    else if (String(v).startsWith('tpl:')) host.innerHTML = `<span class="tpl-meta">${esc(t('templates.image_bundled', { file: String(v).slice(4) }))}</span>`;
    else {
      host.innerHTML = `<img data-auth-src="/api/content/${encodeURIComponent(v)}/thumbnail" alt="">`;
      hydrateAuthImages(host, { eager: true });
    }
  }
  for (const p of params.filter((x) => x.type === 'image')) {
    const wrap = m.overlay.querySelector(`[data-image-param="${CSS.escape(p.name)}"]`);
    paintImage(p.name);
    wrap.querySelector('[data-image-pick]').addEventListener('click', async () => {
      const item = await openContentPicker({ title: p.label || p.name, returnItem: true });
      if (item && item.id) { values[p.name] = String(item.id); paintImage(p.name); schedulePreview(); }
    });
    const def = wrap.querySelector('[data-image-default]');
    if (def) def.addEventListener('click', () => { values[p.name] = p.default; paintImage(p.name); schedulePreview(); });
    wrap.querySelector('[data-image-clear]').addEventListener('click', () => { values[p.name] = ''; paintImage(p.name); schedulePreview(); });
  }

  function readValues() {
    const out = { ...values };
    m.overlay.querySelectorAll('[data-param]').forEach((el) => {
      const name = el.dataset.param;
      const p = params.find((x) => x.name === name);
      if (!p) return;
      if (p.type === 'checkbox') out[name] = !!el.checked;
      else if (p.type === 'number') out[name] = el.value === '' ? '' : Number(el.value);
      else out[name] = el.value;
    });
    // An empty number would be refused; leave it out so the template's default applies.
    for (const p of params) if (p.type === 'number' && out[p.name] === '') delete out[p.name];
    return out;
  }

  const frame = m.$('#tplPreviewFrame');
  const stateEl = m.$('#tplPreviewState');
  const errEl = m.$('#tplUseError');
  let timer = null;
  let seq = 0;
  let closed = false;
  m.onClose(() => { closed = true; clearTimeout(timer); });
  async function updatePreview() {
    const mine = ++seq;
    stateEl.textContent = t('templates.preview_updating');
    try {
      const r = await TAPI(`${base}/preview`, { method: 'POST', body: JSON.stringify({ values: readValues() }) });
      if (closed || mine !== seq) return;
      // Only a same-server preview path is ever put in the frame.
      if (typeof r.url === 'string' && r.url.startsWith('/api/templates/preview/')) frame.src = r.url;
      stateEl.textContent = '';
      errEl.textContent = '';
    } catch (e) {
      if (closed || mine !== seq) return;
      stateEl.textContent = '';
      errEl.textContent = e.message;
    }
  }
  function schedulePreview() { clearTimeout(timer); timer = setTimeout(updatePreview, 400); }
  m.overlay.querySelectorAll('[data-param]').forEach((el) => {
    el.addEventListener('input', schedulePreview);
    el.addEventListener('change', schedulePreview);
  });
  updatePreview();

  const go = m.$('#tplUseGo');
  go.addEventListener('click', async () => {
    go.disabled = true;
    errEl.textContent = '';
    const name = m.$('#tplUseName').value.trim();
    try {
      if (editing) {
        assertLocalCallAllowed(`/widgets/${widget.id}`, 'PUT');
        await TAPI(`/widgets/${encodeURIComponent(widget.id)}`, { method: 'PUT', body: JSON.stringify({ name: name || widget.name, config: { values: readValues() } }) });
        showToast(t('templates.toast_widget_saved'), 'success');
        m.close();
        if (onSaved) onSaved();
        return;
      }
      const w = await TAPI(`${base}/use`, { method: 'POST', body: JSON.stringify({ name, values: readValues() }) });
      showToast(t('templates.toast_widget_created', { name: w.name }), 'success');
      showCreated(m, w);
    } catch (e) {
      go.disabled = false;
      errEl.textContent = e.message;
      if (e.body && e.body.param) {
        const el = m.overlay.querySelector(`[data-param="${CSS.escape(e.body.param)}"], [data-image-param="${CSS.escape(e.body.param)}"]`);
        if (el) el.scrollIntoView({ block: 'center' });
      }
    }
  });
}

async function showCreated(m, w) {
  const done = m.$('#tplDone');
  const footer = m.overlay.querySelector('.modal-footer');
  if (footer) footer.innerHTML = `<a class="btn btn-secondary" href="#/widgets" data-close>${esc(t('templates.go_widgets'))}</a>
    <button class="btn btn-primary" data-close>${esc(t('common.done'))}</button>`;
  footer.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', m.close));
  done.style.display = '';
  done.innerHTML = `<div class="tpl-callout tpl-callout-ok">
      <strong>${esc(t('templates.created_title', { name: w.name }))}</strong>
      <p class="tpl-meta">${esc(t('templates.created_desc'))}</p>
      <p class="tpl-meta">${esc(t('templates.created_again'))}</p>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select class="input" id="tplAddPl" style="flex:1;min-width:180px"><option value="">${esc(t('templates.loading'))}</option></select>
        <button class="btn btn-primary btn-sm" id="tplAddPlGo" disabled>${esc(t('templates.add_to_playlist'))}</button>
      </div>
      <div id="tplAddPlMsg" class="tpl-meta" style="margin-top:6px"></div>
    </div>`;
  m.overlay.querySelectorAll('.tpl-use-form input, .tpl-use-form select, .tpl-use-form textarea, .tpl-use-form button').forEach((el) => { el.disabled = true; });
  const sel = done.querySelector('#tplAddPl');
  const btn = done.querySelector('#tplAddPlGo');
  const msg = done.querySelector('#tplAddPlMsg');
  let pls = [];
  try { pls = await api.getPlaylists(); } catch { pls = []; }
  pls = Array.isArray(pls) ? pls : [];
  sel.innerHTML = pls.length
    ? `<option value="">${esc(t('templates.choose_playlist'))}</option>${pls.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}`
    : `<option value="">${esc(t('templates.no_playlists'))}</option>`;
  sel.addEventListener('change', () => { btn.disabled = !sel.value; });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await api.addPlaylistItem(sel.value, { widget_id: w.id });
      const pl = pls.find((p) => String(p.id) === sel.value);
      msg.innerHTML = `${esc(t('templates.added_to_playlist', { name: pl ? pl.name : '' }))} <a href="#/playlists/${encodeURIComponent(sel.value)}">${esc(t('templates.open_playlist'))}</a>`;
    } catch (e) { btn.disabled = false; msg.innerHTML = `<span class="tpl-warn-text">${esc(e.message)}</span>`; }
  });
}
