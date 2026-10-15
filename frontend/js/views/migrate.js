/*
 * 3.0 switch to ScreenTinker: import media, playlists, layouts, schedules and screens from another
 * signage CMS (server: lib/migrate, routes/migrate.js, docs/migrate.md).
 *
 *   #/migrate             the wizard: pick a source -> connect -> scan -> choose -> run -> report
 *   #/migrate?job=<id>    reopen an import (its progress or its report)
 *
 * One question per step, like the Simple view's guides. The server does the work in the background
 * and this page polls the job, so closing the tab does not stop an import, and coming back to
 * #/migrate shows where it got to.
 *
 * ⚠️ THE KEY TYPED HERE IS SENT ONCE, TO START THE SCAN (or to resume), and dropped from the page
 * straight after: it is never kept in state, localStorage or the URL. The server holds it only while
 * the import needs it (lib/migrate).
 *
 * Every value from the server or the source system (names, reasons, vendor labels) reaches the
 * page through esc().
 */
import { api } from '../api.js';
import { t, tn } from '../i18n.js';
import { esc } from '../utils.js';
import { showToast } from '../components/toast.js';
import { openModal } from '../components/corporate-ui.js';

// Literal keys (the i18n test can only check literals): how to connect, per source.
const HOW = {
  xibo: () => t('migrate.how.xibo'),
  yodeck: () => t('migrate.how.yodeck'),
  optisigns: () => t('migrate.how.optisigns'),
  screencloud: () => t('migrate.how.screencloud'),
  anthias: () => t('migrate.how.anthias'),
  screenly: () => t('migrate.how.screenly'),
  'generic-zip': () => t('migrate.how.generic_zip'),
};
const FIELD = {
  url: () => t('migrate.field.url'),
  client_id: () => t('migrate.field.client_id'),
  client_secret: () => t('migrate.field.client_secret'),
  api_key: () => t('migrate.field.api_key'),
  token: () => t('migrate.field.token'),
  username: () => t('migrate.field.username'),
  password: () => t('migrate.field.password'),
  timezone: () => t('migrate.field.timezone'),
  region: () => t('migrate.field.region'),
};
const KIND = {
  media: () => t('migrate.kind.media'),
  playlists: () => t('migrate.kind.playlists'),
  layouts: () => t('migrate.kind.layouts'),
  schedules: () => t('migrate.kind.schedules'),
  screens: () => t('migrate.kind.screens'),
  groups: () => t('migrate.kind.groups'),
};
const STATUS = {
  scanning: () => t('migrate.status.scanning'),
  scanned: () => t('migrate.status.scanned'),
  queued: () => t('migrate.status.queued'),
  running: () => t('migrate.status.running'),
  done: () => t('migrate.status.done'),
  stopped: () => t('migrate.status.stopped'),
  failed: () => t('migrate.status.failed'),
  cancelled: () => t('migrate.status.cancelled'),
  interrupted: () => t('migrate.status.interrupted'),
};
const PHASE = {
  connecting: () => t('migrate.phase.connecting'),
  media: () => t('migrate.phase.media'),
  groups: () => t('migrate.phase.groups'),
  layouts: () => t('migrate.phase.layouts'),
  playlists: () => t('migrate.phase.playlists'),
  screens: () => t('migrate.phase.screens'),
  schedules: () => t('migrate.phase.schedules'),
  publishing: () => t('migrate.phase.publishing'),
  done: () => t('migrate.phase.done'),
};
const label = (table, k) => (table[k] ? table[k]() : String(k || ''));

let state = null;
let pollTimer = null;

export function cleanup() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }

export async function render(app) {
  app.innerHTML = `
    <div class="page-header"><div><h1>${esc(t('migrate.title'))}</h1><div class="subtitle">${esc(t('migrate.subtitle'))}</div></div></div>
    <div class="mig" id="migBody"></div>
    <div class="mig" id="migScreens"></div>`;
  return mountMigrate(app.querySelector('#migBody'));
}

/*
 * The wizard, mounted into `root`. The Advanced page (#/migrate) mounts it with no options; the
 * first-run guide (views/onboarding.js) and the Simple view (#/simple/import) mount it in GUIDE mode:
 *   guide: true        big choices, "No, start fresh" first, a Skip on every step, no recent list
 *   onSkip()           the person chose not to import (or to stop looking): the host moves on
 *   onFinish(job)      the import is done (or running on): the host moves on
 * An import already running in this workspace is shown straight away in every mode, so someone who
 * left (or whose phone put the Manager app in the background) comes back to its progress.
 */
export async function mountMigrate(root, opts = {}) {
  cleanup();
  state = { root, opts, vendors: [], vendor: null, job: null, jobs: [], folders: [], step: 'pick' };
  root.innerHTML = `<p style="color:var(--text-muted)">${esc(t('common.loading'))}</p>`;
  try {
    const v = await api.migrateVendors();
    state.vendors = v.vendors || [];
    if (!v.can_import) {
      body().innerHTML = `<div class="corp-notice">${esc(t('migrate.read_only'))}</div>`;
      if (opts.guide && opts.onSkip) opts.onSkip();
      return;
    }
    const [jobs, folders] = await Promise.all([api.migrateJobs().catch(() => ({ jobs: [] })), api.getFolders().catch(() => [])]);
    state.jobs = jobs.jobs || [];
    state.folders = Array.isArray(folders) ? folders : [];
  } catch (e) {
    body().innerHTML = `<div class="corp-notice corp-notice-danger">${esc(e.message)}</div>`;
    return;
  }
  const want = opts.guide ? null : new URLSearchParams(window.location.hash.split('?')[1] || '').get('job');
  const open = (want && state.jobs.find((j) => j.id === want)) || state.jobs.find((j) => ['scanning', 'queued', 'running'].includes(j.status));
  if (open) showJob(open);
  else draw();
  if (!opts.guide) loadPlaceholders();
}

function body() { return state && state.root; }
function guide() { return !!(state && state.opts.guide); }
function vendorById(id) { return state.vendors.find((v) => v.id === id) || null; }
function live() { return state && document.contains(state.root); }
// In guide mode every step can be left: the rest of the guide must never depend on this one.
function skipBtn() { return guide() ? `<button type="button" class="btn btn-secondary" data-act="skip" style="color:var(--text-muted)">${esc(t('migrate.guide.skip'))}</button>` : ''; }
function wireSkip() {
  body().querySelectorAll('[data-act="skip"]').forEach((b) => b.addEventListener('click', () => { cleanup(); if (state.opts.onSkip) state.opts.onSkip(); }));
}

/* ------------------------------------------------------------------ steps */

function draw() {
  if (!live()) return;
  const step = state.step;
  if (step === 'pick') return drawPick();
  if (step === 'connect') return drawConnect();
  if (step === 'job') return drawJob();
}

function drawPick() {
  const tiles = state.vendors.map((v) => `
    <li><button type="button" class="mig-tile" data-vendor="${esc(v.id)}">
      <span class="mig-tile-title">${esc(v.name)}</span>
      <span class="mig-tile-desc">${esc(v.mode === 'api' ? t('migrate.mode.api') : v.mode === 'file' ? t('migrate.mode.file') : t('migrate.mode.none'))}</span>
    </button></li>`).join('');
  const recent = state.jobs.length ? `
    <h3 class="mig-h3">${esc(t('migrate.recent'))}</h3>
    <ul class="mig-list">${state.jobs.slice(0, 8).map((j) => `
      <li><button type="button" class="mig-link" data-job="${esc(j.id)}">${esc(j.vendor_name)}${j.source_label ? ` · ${esc(j.source_label)}` : ''}</button>
        <span class="mig-pill mig-pill-${esc(j.status)}">${esc(label(STATUS, j.status))}</span>
        <span class="mig-muted">${esc(new Date(j.created_at * 1000).toLocaleString())}</span></li>`).join('')}</ul>` : '';
  if (guide()) {
    // One question, big answers; "No, start fresh" first, because it is what most people pick.
    body().innerHTML = `
      <section class="mig-guide">
        <p class="mig-muted">${esc(t('migrate.guide.intro'))}</p>
        <ul class="mig-tiles mig-tiles-guide">
          <li><button type="button" class="mig-tile mig-tile-fresh" data-act="fresh"><span class="mig-tile-title">${esc(t('migrate.guide.fresh'))}</span>
            <span class="mig-tile-desc">${esc(t('migrate.guide.fresh_desc'))}</span></button></li>${tiles}
        </ul>
      </section>`;
    body().querySelector('[data-act="fresh"]').addEventListener('click', () => { cleanup(); if (state.opts.onSkip) state.opts.onSkip(); });
  } else {
    body().innerHTML = `
    <section class="mig-card">
      <h2 class="mig-q">${esc(t('migrate.q_pick'))}</h2>
      <p class="mig-muted">${esc(t('migrate.pick_help'))}</p>
      <ul class="mig-tiles">${tiles}</ul>
    </section>${recent}`;
  }
  body().querySelectorAll('[data-vendor]').forEach((b) => b.addEventListener('click', () => { state.vendor = vendorById(b.dataset.vendor); state.step = 'connect'; draw(); }));
  body().querySelectorAll('[data-job]').forEach((b) => b.addEventListener('click', () => { const j = state.jobs.find((x) => x.id === b.dataset.job); if (j) showJob(j); }));
}

function docsHtml(v) {
  if (!v.docs || !v.docs.length) return '';
  return `<p class="mig-muted">${esc(t('migrate.docs'))} ${v.docs.map((d) => `<a href="${esc(d)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(d))}</a>`).join(' · ')}</p>`;
}
function hostOf(u) { try { return new URL(u).hostname + new URL(u).pathname.replace(/\/$/, ''); } catch { return u; } }

function fieldsHtml(v, prefix = 'migF') {
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { tz = ''; }
  return (v.fields || []).map((f) => {
    const id = `${prefix}_${esc(f.key)}`;
    const control = f.type === 'region'
      ? `<select class="input" id="${id}" data-field="${esc(f.key)}">${(f.options || []).map((o) => `<option value="${esc(o)}">${esc(String(o).toUpperCase())}</option>`).join('')}</select>`
      : `<input class="input" id="${id}" data-field="${esc(f.key)}" type="${f.type === 'secret' ? 'password' : f.type === 'url' ? 'url' : 'text'}"
        autocomplete="off" spellcheck="false" ${f.type === 'url' ? 'placeholder="https://"' : ''} ${f.type === 'timezone' ? `value="${esc(tz)}"` : ''}>`;
    return `
    <div class="form-group">
      <label for="${id}">${esc(label(FIELD, f.key))}${f.required ? '' : ` <span class="mig-muted">${esc(t('migrate.optional'))}</span>`}</label>
      ${control}
      ${f.type === 'timezone' ? `<div class="mig-muted">${esc(t('migrate.timezone_help'))}</div>` : ''}
    </div>`;
  }).join('');
}

function readFields(root) {
  const out = {};
  root.querySelectorAll('[data-field]').forEach((el) => { out[el.dataset.field] = el.value.trim(); el.value = ''; });
  return out;
}

function drawConnect() {
  const v = state.vendor;
  const back = `<button type="button" class="btn btn-secondary" data-act="back">${esc(t('migrate.back'))}</button>`;
  if (v.mode === 'none') {
    body().innerHTML = `
      <section class="mig-card">
        <h2 class="mig-q">${esc(v.name)}</h2>
        <p>${esc(label(HOW, v.id))}</p>
        ${docsHtml(v)}
        <div class="mig-actions">${skipBtn()}${back}<button type="button" class="btn btn-primary" data-act="zip">${esc(t('migrate.use_zip'))}</button></div>
      </section>`;
  } else {
    body().innerHTML = `
      <section class="mig-card">
        <h2 class="mig-q">${esc(t('migrate.q_connect', { vendor: v.name }))}</h2>
        <p class="mig-how">${esc(label(HOW, v.id))}</p>
        ${docsHtml(v)}
        <form id="migConnect" autocomplete="off">
          ${v.mode === 'file' ? `<div class="form-group"><label for="migFile">${esc(t('migrate.file'))}</label><input class="input" type="file" id="migFile" accept=".zip,application/zip"></div>` : fieldsHtml(v)}
          ${v.self_hosted ? `<p class="mig-muted">${esc(t('migrate.self_hosted_note'))}</p>` : ''}
          ${v.mode === 'api' ? `<p class="mig-muted">${esc(t('migrate.key_note'))}</p>` : ''}
          <p class="mig-error" role="alert" id="migErr"></p>
          <div class="mig-actions">${skipBtn()}${back}<button type="submit" class="btn btn-primary" id="migScanBtn">${esc(t('migrate.scan'))}</button></div>
        </form>
      </section>`;
    body().querySelector('#migConnect').addEventListener('submit', (e) => { e.preventDefault(); connect(); });
  }
  body().querySelector('[data-act="back"]').addEventListener('click', () => { state.step = 'pick'; draw(); });
  body().querySelector('[data-act="zip"]')?.addEventListener('click', () => { state.vendor = vendorById('generic-zip'); draw(); });
  wireSkip();
}

async function connect() {
  const v = state.vendor;
  const btn = document.getElementById('migScanBtn');
  const err = document.getElementById('migErr');
  err.textContent = '';
  btn.disabled = true;
  try {
    let job;
    if (v.mode === 'file') {
      const f = document.getElementById('migFile').files[0];
      if (!f) throw new Error(t('migrate.choose_file'));
      const fd = new FormData();
      fd.append('vendor', v.id);
      fd.append('file', f);
      btn.textContent = t('migrate.uploading');
      job = await api.migrateUpload(fd);
    } else {
      const cred = readFields(body());
      job = await api.migrateConnect(v.id, cred);
    }
    showJob(job);
  } catch (e) {
    err.textContent = e.message;
    btn.disabled = false;
    btn.textContent = t('migrate.scan');
  }
}

/* ------------------------------------------------------------------ a job */

function showJob(job) {
  state.job = job;
  state.step = 'job';
  if (!guide()) history.replaceState(null, '', `${window.location.pathname}#/migrate?job=${encodeURIComponent(job.id)}`);
  draw();
  poll();
}

function poll() {
  cleanup();
  const j = state.job;
  if (!j || !['scanning', 'queued', 'running'].includes(j.status)) return;
  pollTimer = setTimeout(async () => {
    if (!live()) return;
    try {
      state.job = await api.migrateJob(j.id);
      draw();
      if (state.job.status === 'done' && !guide()) loadPlaceholders();
    } catch { /* next tick */ }
    poll();
  }, 1200);
}

function drawJob() {
  const j = state.job;
  const v = vendorById(j.vendor) || { name: j.vendor_name, fields: [] };
  const head = `<h2 class="mig-q">${esc(j.vendor_name)}${j.source_label ? ` · <span class="mig-muted">${esc(j.source_label)}</span>` : ''}</h2>`;
  const startOver = `<button type="button" class="btn btn-secondary" data-act="new">${esc(t('migrate.start_over'))}</button>`
    + (guide() ? `<button type="button" class="btn btn-primary" data-act="continue">${esc(t('migrate.guide.continue'))}</button>` : '');
  let inner = '';
  if (j.status === 'scanning') {
    inner = `<p>${esc(t('migrate.scanning'))}</p><div class="progress-bar"><div class="progress-bar-fill mig-indeterminate"></div></div>
      <div class="mig-actions">${skipBtn()}<button type="button" class="btn btn-secondary" data-act="cancel">${esc(t('migrate.cancel'))}</button></div>`;
  } else if (j.status === 'scanned') {
    inner = reviewHtml(j);
  } else if (j.status === 'queued' || j.status === 'running') {
    // In the guide, "carry on" leaves the import running on the server: the rest of the guide goes on.
    inner = progressHtml(j) + `<div class="mig-actions"><button type="button" class="btn btn-secondary" data-act="cancel">${esc(t('migrate.cancel'))}</button>${guide() ? `<button type="button" class="btn btn-primary" data-act="continue">${esc(t('migrate.guide.carry_on'))}</button>` : ''}</div>`;
  } else {
    inner = (j.error ? `<div class="corp-notice ${j.status === 'failed' ? 'corp-notice-danger' : ''}">${esc(j.error)}</div>` : '')
      + (j.report ? reportHtml(j) : '')
      + (j.can_resume || j.needs_credentials ? resumeHtml(j, v) : '')
      + (guide() && j.status === 'done' && j.report && j.report.created && j.report.created.screens ? `<p class="mig-muted">${esc(t('migrate.guide.screens_later'))}</p>` : '')
      + `<div class="mig-actions">${startOver}</div>`;
  }
  body().innerHTML = `<section class="${guide() ? 'mig-guide' : 'mig-card'}">${head}${inner}</section>`;
  wireJob(j, v);
}

function countRow(key, n, checked = true) {
  return `<label class="mig-check"><input type="checkbox" data-opt="${esc(key)}" ${checked && n ? 'checked' : ''} ${n ? '' : 'disabled'}>
    <span><strong>${esc(String(n))}</strong> ${esc(label(KIND, key))}</span></label>`;
}

function reviewHtml(j) {
  const s = j.summary || {};
  const mb = s.bytes ? ` (${(s.bytes / 1048576).toFixed(s.bytes > 1048576 * 10 ? 0 : 1)} MB)` : '';
  const folderOpts = [`<option value="">${esc(t('migrate.folder_new', { vendor: j.vendor_name }))}</option>`, `<option value="root">${esc(t('migrate.folder_root'))}</option>`]
    .concat(state.folders.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`)).join('');
  const unmapped = (j.unmapped || []);
  return `
    <p>${esc(t('migrate.found'))}${esc(mb)}</p>
    <div class="mig-checks">
      ${countRow('media', s.media)}${countRow('playlists', s.playlists)}${countRow('layouts', s.layouts)}
      ${countRow('schedules', s.schedules)}${countRow('screens', s.screens)}
    </div>
    ${s.screens ? `<p class="mig-muted">${esc(t('migrate.screens_note'))}</p>` : ''}
    ${unmapped.length ? `<details class="mig-details"><summary>${esc(tn('migrate.unmapped', unmapped.length))}</summary>
      <ul class="mig-list">${unmapped.slice(0, 200).map((u) => `<li><strong>${esc(u.name)}</strong> <span class="mig-muted">(${esc(u.kind)})</span> — ${esc(u.reason)}</li>`).join('')}</ul></details>` : ''}
    <div class="form-group"><label for="migFolder">${esc(t('migrate.folder'))}</label><select class="input" id="migFolder">${folderOpts}</select></div>
    <label class="mig-check"><input type="checkbox" id="migPublish" checked><span>${esc(t('migrate.publish'))}</span></label>
    <p class="mig-muted">${esc(t('migrate.idempotent_note'))}</p>
    <div class="mig-actions">${skipBtn()}<button type="button" class="btn btn-secondary" data-act="cancel">${esc(t('migrate.cancel'))}</button>
      <button type="button" class="btn btn-primary" data-act="run">${esc(t('migrate.run'))}</button></div>`;
}

function progressHtml(j) {
  const p = j.progress || {};
  const pct = p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
  return `<p>${esc(j.status === 'queued' ? t('migrate.queued') : label(PHASE, p.phase))}</p>
    <div class="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
    <p class="mig-muted">${esc(t('migrate.progress', { done: p.done || 0, total: p.total || 0, failed: p.failed || 0 }))}</p>
    <p class="mig-muted">${esc(t('migrate.leave_ok'))}</p>`;
}

function reportHtml(j) {
  const r = j.report;
  const c = r.created || {}, u = r.reused || {};
  const rows = ['media', 'playlists', 'layouts', 'schedules', 'groups', 'screens'].map((k) => `
    <tr><td>${esc(label(KIND, k))}</td><td>${esc(String(c[k] || 0))}</td><td>${esc(String(u[k] || 0))}</td></tr>`).join('');
  const list = (items, title) => (items && items.length ? `<details class="mig-details" ${items.length < 6 ? 'open' : ''}><summary>${esc(title)}</summary>
    <ul class="mig-list">${items.map((x) => `<li><strong>${esc(x.name)}</strong> <span class="mig-muted">(${esc(x.kind)})</span> — ${esc(x.reason || x.note)}</li>`).join('')}</ul></details>` : '');
  return `
    <table class="mig-table"><thead><tr><th></th><th>${esc(t('migrate.created'))}</th><th>${esc(t('migrate.reused'))}</th></tr></thead><tbody>${rows}</tbody></table>
    ${r.unpublished ? `<p class="mig-muted">${esc(tn('migrate.unpublished', r.unpublished))}</p>` : ''}
    ${list(r.failed, tn('migrate.failed_items', (r.failed || []).length))}
    ${list(r.lossy, tn('migrate.lossy_items', (r.lossy || []).length))}
    ${j.status === 'done' ? `<p class="mig-next">${esc(t('migrate.next'))} <a href="#/content">${esc(t('migrate.go_content'))}</a> · <a href="#/playlists">${esc(t('migrate.go_playlists'))}</a> · <a href="#/schedule">${esc(t('migrate.go_schedule'))}</a></p>` : ''}`;
}

function resumeHtml(j, v) {
  const needs = j.needs_credentials && v.mode === 'api';
  if (j.needs_credentials && v.mode !== 'api') return `<p class="mig-muted">${esc(t('migrate.reupload'))}</p>`;
  return `<div class="mig-resume">
    ${needs ? `<p>${esc(t('migrate.resume_key'))}</p>${fieldsHtml(v, 'migR')}` : ''}
    <p class="mig-error" role="alert" id="migErr"></p>
    <button type="button" class="btn btn-primary" data-act="resume">${esc(t('migrate.resume'))}</button></div>`;
}

function wireJob(j) {
  const b = body();
  b.querySelector('[data-act="new"]')?.addEventListener('click', () => {
    if (!guide()) history.replaceState(null, '', `${window.location.pathname}#/migrate`);
    mountMigrate(state.root, state.opts);
  });
  b.querySelector('[data-act="continue"]')?.addEventListener('click', () => { cleanup(); if (state.opts.onFinish) state.opts.onFinish(state.job); });
  wireSkip();
  b.querySelector('[data-act="cancel"]')?.addEventListener('click', async () => {
    try { state.job = await api.migrateCancel(j.id); draw(); poll(); } catch (e) { showToast(e.message, 'error'); }
  });
  b.querySelector('[data-act="run"]')?.addEventListener('click', async (e) => {
    const runBtn = e.currentTarget;
    runBtn.disabled = true;
    const options = { publish: b.querySelector('#migPublish').checked };
    b.querySelectorAll('[data-opt]').forEach((el) => { options[el.dataset.opt] = el.checked; });
    const folder = b.querySelector('#migFolder').value;
    if (folder) options.folder_id = folder;
    try { state.job = await api.migrateRun(j.id, options); draw(); poll(); }
    catch (err) { showToast(err.message, 'error'); runBtn.disabled = false; }
  });
  b.querySelector('[data-act="resume"]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const cred = b.querySelector('[data-field]') ? readFields(b) : null;
    try { state.job = await api.migrateRun(j.id, null, cred); draw(); poll(); }
    catch (err) { const el = b.querySelector('#migErr'); if (el) el.textContent = err.message; btn.disabled = false; }
  });
}

/* ------------------------------------------------------------------ placeholders */

async function loadPlaceholders() {
  const el = document.getElementById('migScreens');
  if (!el) return;
  let list = [];
  try { list = (await api.migratePlaceholders()).placeholders || []; } catch { list = []; }
  if (!list.length) { el.innerHTML = ''; return; }
  const waiting = list.filter((p) => !p.device);
  el.innerHTML = `
    <section class="mig-card">
      <h2 class="mig-q">${esc(t('migrate.ph_title'))}</h2>
      <p class="mig-muted">${esc(t('migrate.ph_help'))}</p>
      <ul class="mig-list mig-ph">${list.map((p) => `
        <li>
          <span class="mig-ph-name"><strong>${esc(p.name)}</strong> <span class="mig-muted">${esc(p.vendor_name)}</span></span>
          <span class="mig-muted">${p.groups.length ? esc(p.groups.map((g) => g.name).join(', ')) : ''}${p.playlist ? ` · ${esc(p.playlist.name)}` : ''}</span>
          ${p.device ? `<span class="mig-pill mig-pill-done">${esc(t('migrate.ph_paired', { name: p.device.name }))}</span>`
    : `<span class="mig-ph-actions"><button type="button" class="btn btn-primary btn-sm" data-pair="${esc(p.id)}">${esc(t('migrate.ph_pair'))}</button>
            <button type="button" class="btn btn-secondary btn-sm" data-drop="${esc(p.id)}">${esc(t('migrate.ph_remove'))}</button></span>`}
        </li>`).join('')}</ul>
      ${waiting.length ? '' : `<p class="mig-muted">${esc(t('migrate.ph_all_done'))}</p>`}
    </section>`;
  el.querySelectorAll('[data-pair]').forEach((b) => b.addEventListener('click', () => pairPlaceholder(list.find((p) => p.id === b.dataset.pair), b)));
  el.querySelectorAll('[data-drop]').forEach((b) => b.addEventListener('click', async () => {
    try { await api.migrateDeletePlaceholder(b.dataset.drop); loadPlaceholders(); } catch (e) { showToast(e.message, 'error'); }
  }));
}

/*
 * Pairing a placeholder is the ordinary pairing (POST /provision/pair, with the placeholder's name),
 * then the ordinary group joins and playlist assignment — each through its own guarded endpoint —
 * and only then the link is recorded. Nothing here claims a screen the person did not type the
 * code of.
 *
 * The code is asked for in the app's own dialog (the same skeleton the rest of the dashboard uses),
 * not window.prompt: a wrong code is answered in place with the server's reason and the dialog stays
 * open for another try, and a plan limit closes it for the upgrade prompt instead of a red toast.
 */
function pairPlaceholder(p, btn) {
  if (!p) return;
  const m = openModal({
    title: t('migrate.ph_pair_title', { name: p.name }),
    body: `<p class="modal-description" style="margin-bottom:16px">${esc(t('migrate.ph_code', { name: p.name }))}</p>
      <div class="form-group">
        <label for="migPairCode">${esc(t('add_display.pairing_code'))}</label>
        <input type="text" id="migPairCode" maxlength="6" placeholder="000000" class="pairing-input" inputmode="numeric" autocomplete="off" aria-describedby="migPairErr">
      </div>
      <p id="migPairErr" role="alert" style="color:var(--danger);font-size:13px;margin:8px 0 0"></p>`,
    footer: `<button type="button" class="btn btn-secondary" data-corp-close>${esc(t('common.cancel'))}</button>
      <button type="button" class="btn btn-primary" data-mig-pair-go disabled>${esc(t('migrate.ph_pair'))}</button>`,
  });
  const input = m.q('#migPairCode');
  const go = m.q('[data-mig-pair-go]');
  const errEl = m.q('#migPairErr');
  // Six characters, the same check the Add screen dialog makes; the server says whether it is real.
  const valid = () => input.value.trim().length === 6;
  let busy = false;
  input.addEventListener('input', () => { go.disabled = busy || !valid(); errEl.textContent = ''; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  go.addEventListener('click', submit);
  input.focus();

  async function submit() {
    if (busy) return;
    if (!valid()) { errEl.textContent = t('dashboard.error_pairing_code'); return; }
    busy = true;
    go.disabled = true;
    input.disabled = true;
    btn.disabled = true;
    errEl.textContent = t('onboarding.toast.pairing');
    let dev;
    try {
      dev = await api.pairDevice(input.value.trim(), p.name);
    } catch (e) {
      busy = false;
      btn.disabled = false;
      // A plan limit is answered by the upgrade prompt (plan-nudges.js); the dialog gets out of its way.
      if (e.planPromptShown) { m.close(); return; }
      input.disabled = false;
      go.disabled = !valid();
      errEl.textContent = e.message || t('onboarding.toast.pair_failed');
      input.focus();
      return;
    }
    m.close();
    try {
      const problems = [];
      for (const g of p.groups) { try { await api.addDeviceToGroup(g.id, dev.id); } catch (e) { problems.push(e.message); } }
      if (p.playlist) { try { await api.assignPlaylistToDevice(p.playlist.id, dev.id); } catch (e) { problems.push(e.message); } }
      await api.migrateLinkPlaceholder(p.id, dev.id);
      showToast(problems.length ? t('migrate.ph_paired_partly', { problem: problems[0] }) : t('migrate.ph_paired', { name: p.name }), problems.length ? 'warning' : 'success');
      loadPlaceholders();
    } catch (e) {
      showToast(e.message, 'error');
      btn.disabled = false;
    }
  }
}
