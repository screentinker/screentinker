/*
 * Head office (corporate) playlists — the pieces every view shares (spec §7).
 *
 * ⚠️ ONE WORD PER IDEA, EVERYWHERE (§7, terminology table). Store-facing text says "Head office",
 * "Your slot" and names a level LITERALLY ("Everyone in {workspace}", "Group {name}", "This screen",
 * "Video wall {name}") — never "this store", because a store may be a workspace OR a group (D14).
 * Head office's own face says "Where it plays" and "Local slot". The word "fill" is code only.
 *
 * ⚠️ NEVER A SILENTLY DISABLED CONTROL. Anything head office locks shows a lock and, on click, the
 * one explanation popover (explainLocked) with the reason and — where one exists — a button to the
 * thing the person CAN change. The server refuses regardless; this only says so first.
 *
 * The two reads below are cached for the page's lifetime and NEVER throw: a server without the
 * feature, a user outside any organization, or a remote (mesh) org all answer "nothing corporate
 * here", and every caller can treat that like an install that never heard of head office.
 */
import { api } from '../api.js';
import { t, tn } from '../i18n.js';
import { esc, hydrateAuthImages } from '../utils.js';
import { showToast } from './toast.js';

/* ── words ──────────────────────────────────────────────────────────────────────────────────── */

/** "Everyone in Store 1" / "Group Tills" / "Video wall Lobby" / "This screen" (or "Screen X"). */
export function levelLabel(kind, name, { thisScreen = false } = {}) {
  const n = name || '';
  if (kind === 'workspace') return t('corp.level.workspace', { name: n });
  if (kind === 'group') return t('corp.level.group', { name: n });
  if (kind === 'wall') return t('corp.level.wall', { name: n });
  if (kind === 'device') return thisScreen || !n ? t('corp.level.screen') : t('corp.level.named_screen', { name: n });
  if (kind === 'org') return t('corp.where.org');
  return n;
}

/** A mandate's target as head office reads it: "Whole organization", "Workspace X", "Group Y"... */
export function targetLabel(kind, name) {
  if (kind === 'org') return t('corp.where.org');
  if (kind === 'workspace') return t('corp.target.workspace', { name: name || '' });
  if (kind === 'group') return t('corp.target.group', { name: name || '' });
  if (kind === 'wall') return t('corp.target.wall', { name: name || '' });
  if (kind === 'device') return t('corp.target.device', { name: name || '' });
  return name || '';
}

/** 75 → "1:15"; 40 → "40 s". Loop and slot lengths. */
export function formatSec(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return t('corp.sec', { n: s });
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The limits of a slot in a sentence: "up to 3 items / 60 seconds" (either half omitted when unset). */
export function limitsText(limits) {
  const l = limits || {};
  const parts = [];
  if (l.max_items != null) parts.push(tn('corp.limit.items', l.max_items));
  if (l.max_total_sec != null) parts.push(tn('corp.limit.seconds', l.max_total_sec));
  return parts.length ? t('corp.limit.up_to', { limits: parts.join(' / ') }) : t('corp.limit.none');
}

/* ── marks ──────────────────────────────────────────────────────────────────────────────────── */

export const LOCK_SVG = '<svg class="corp-lock-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

/**
 * A small badge. tone: 'hq' (head office, amber), 'slot' (the store's own, teal), 'dark',
 * 'emergency' (red), 'muted'. Text and title are escaped here.
 */
export function chip(text, tone = 'hq', title = '', { lock = false } = {}) {
  return `<span class="corp-chip corp-chip-${esc(tone)}"${title ? ` title="${esc(title)}"` : ''}>${lock ? LOCK_SVG : ''}${esc(text)}</span>`;
}

/* ── dialogs ────────────────────────────────────────────────────────────────────────────────── */

/**
 * The dialog skeleton every corporate dialog uses (.modal-overlay/.modal/... like the rest of the
 * app). `body` and `footer` are trusted HTML built by the caller with esc() on every value.
 * @returns {{overlay, q, close}}
 */
export function openModal({ title, body, footer = '', wide = false, onClose = null }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay corp-modal';
  overlay.innerHTML = `
    <div class="modal" style="${wide ? 'width:760px;max-width:95vw' : 'width:520px;max-width:95vw'}" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h3>${esc(title)}</h3>
        <button class="btn-icon" type="button" data-corp-close aria-label="${esc(t('common.close'))}">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-footer">${footer}</div>` : ''}
    </div>`;
  document.body.appendChild(overlay);
  let closed = false;
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    if (typeof onClose === 'function') onClose();
  }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('[data-corp-close]').forEach((b) => b.addEventListener('click', close));
  return { overlay, q: (sel) => overlay.querySelector(sel), close };
}

/**
 * THE explanation for anything head office locks (§7.9): "Set by head office" · the reason · and
 * the buttons to what the person can change instead. Never a dead end: there is always at least OK.
 * actions: [{ label, onClick, primary }]
 */
export function explainLocked({ title, text, actions = [] }) {
  const m = openModal({
    title: title || t('corp.locked.title'),
    body: `<p class="corp-explain">${esc(text)}</p>`,
    footer: `${actions.map((a, i) => `<button type="button" class="btn ${a.primary ? 'btn-primary' : 'btn-secondary'}" data-corp-action="${i}">${esc(a.label)}</button>`).join('')}
             <button type="button" class="btn btn-secondary" data-corp-close>${esc(t('common.ok'))}</button>`,
  });
  m.overlay.querySelectorAll('[data-corp-action]').forEach((b) => b.addEventListener('click', () => {
    const a = actions[Number(b.dataset.corpAction)];
    m.close();
    if (a && typeof a.onClick === 'function') a.onClick();
  }));
  return m;
}

/** A yes/no question with named buttons (never the browser's confirm(), which can't say "{n} screens"). */
export function ask({ title, text, confirmLabel, cancelLabel, danger = false, extraHtml = '' }) {
  return new Promise((resolve) => {
    let answered = false;
    const m = openModal({
      title,
      body: `<p class="corp-explain">${esc(text)}</p>${extraHtml}`,
      footer: `<button type="button" class="btn btn-secondary" data-corp-no>${esc(cancelLabel || t('common.cancel'))}</button>
               <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-corp-yes>${esc(confirmLabel || t('common.ok'))}</button>`,
      onClose: () => { if (!answered) resolve(null); },
    });
    m.q('[data-corp-no]').addEventListener('click', () => { answered = true; m.close(); resolve(null); });
    m.q('[data-corp-yes]').addEventListener('click', () => { answered = true; const v = m.overlay; resolve(v); m.close(); });
  });
}

/* ── cached reads ───────────────────────────────────────────────────────────────────────────── */

const EMPTY_COVERAGE = Object.freeze({ active: false, is_admin: false, devices: {}, groups: {}, walls: {}, shadowed_schedules: [] });
let settingsPromise = null;
let coveragePromise = null;

/** GET /api/corporate/settings, cached. null when the feature (or an organization) is not there. */
export function corporateSettings({ force = false } = {}) {
  if (force || !settingsPromise) {
    settingsPromise = api.getCorporateSettings().catch(() => null);
  }
  return settingsPromise;
}

/** GET /api/corporate/workspace, cached: what head office decides in the active workspace. */
export function workspaceCoverage({ force = false } = {}) {
  if (force || !coveragePromise) {
    coveragePromise = api.getCorporateWorkspace().then((r) => ({ ...EMPTY_COVERAGE, ...(r || {}) })).catch(() => ({ ...EMPTY_COVERAGE }));
  }
  return coveragePromise;
}

/** After any write that can change what head office decides here (a mandate, a membership...). */
export function forgetCorporateCache() { settingsPromise = null; coveragePromise = null; }

/** "Plays head office's playlist" / "Turned off by head office" for a screen in a picker. */
export function deviceNote(cov, deviceId) {
  const d = cov && cov.devices && cov.devices[deviceId];
  if (!d) return '';
  return d.dark ? t('corp.badge.dark') : t('corp.picker.plays_hq');
}

/* ── the head office context bar (§7.1) ─────────────────────────────────────────────────────── */

const RETURN_KEY = 'st_corp_return_ws';

/** Remember where the user came from before switching into the head office workspace. */
export function rememberReturnWorkspace(ws) {
  try { localStorage.setItem(RETURN_KEY, JSON.stringify({ id: ws.id, name: ws.name || '' })); } catch { /* private window */ }
}
export function returnWorkspace() {
  try { return JSON.parse(localStorage.getItem(RETURN_KEY) || 'null'); } catch { return null; }
}
export function forgetReturnWorkspace() {
  try { localStorage.removeItem(RETURN_KEY); } catch { /* */ }
}

/** Switch the active workspace (mints a new token) and land on `hash`. */
export async function switchWorkspaceTo(wsId, hash) {
  const resp = await api.switchWorkspace(wsId);
  if (!resp || !resp.token) throw new Error(t('corp.ctx.switch_failed'));
  localStorage.setItem('token', resp.token);
  if (hash) window.location.hash = hash;
  window.location.reload();
}

/**
 * While the active workspace IS the head office workspace, every editor, picker and upload works
 * there — so say so, persistently, with one click back to where the user came from (critique U7).
 * Mounted in #banners, the app's slot above the view (like the remote-org banner).
 */
export function renderHqContextBar(settings) {
  const host = document.getElementById('banners');
  if (!host) return;
  const existing = document.getElementById('corpHqBar');
  if (!settings || !settings.active_workspace_is_hq || !settings.corporate_enabled) { if (existing) existing.remove(); return; }
  const back = returnWorkspace();
  const el = existing || document.createElement('div');
  el.id = 'corpHqBar';
  el.className = 'corp-hq-bar';
  el.innerHTML = `
    <span>${LOCK_SVG} ${esc(t('corp.ctx.bar', { name: settings.hq_workspace_name || '' }))}</span>
    ${back && back.id !== settings.hq_workspace_id ? `<button type="button" class="btn btn-secondary btn-sm" id="corpHqBack">${esc(t('corp.ctx.back', { name: back.name || '' }))}</button>` : ''}`;
  if (!existing) host.appendChild(el);
  el.querySelector('#corpHqBack')?.addEventListener('click', async () => {
    forgetReturnWorkspace();
    try { await switchWorkspaceTo(back.id, '#/'); } catch (e) { /* the switcher shows the same error */ }
  });
}

/* ── Preview a screen (§7.4, critique U8) — shared by the head office page and both editors ── */

export const thumb = (it) => (it.content_id && it.thumbnail_path
  ? `<img class="corp-thumb" data-auth-src="/api/content/${esc(it.content_id)}/thumbnail" alt="">`
  : `<span class="corp-thumb corp-thumb-icon">${it.widget_id ? '&#9881;' : '&#9634;'}</span>`);


/**
 * The loop one screen plays (or would play after the corporate draft is published), every item
 * tagged Corporate / Slot "{slot}": {level} / Fallback, and each slot's outcome.
 * opts: { deviceId?, playlistId?, canDraft? }
 */
export async function openScreenPreview(opts = {}) {
  let targets = null;
  if (!opts.deviceId) {
    try { targets = await api.getCorporateTargets(); } catch (e) { showToast(e.message, 'error'); return; }
  }
  const screens = targets ? targets.workspaces.flatMap((w) => w.devices.map((d) => ({ ...d, workspace: w.name }))) : [];
  const m = openModal({
    title: t('corp.hq.preview'),
    wide: true,
    body: `
      ${targets ? `<div class="corp-row">
        <select id="corpPvScreen" class="input" style="flex:1">
          <option value="">${esc(t('corp.preview.pick'))}</option>
          ${targets.workspaces.map((w) => `<optgroup label="${esc(w.name)}">${w.devices.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}${d.wall_name ? ' — ' + esc(t('corp.where.wall_member', { name: d.wall_name })) : ''}</option>`).join('')}</optgroup>`).join('')}
        </select>
        ${opts.canDraft ? `<label class="corp-check"><input type="checkbox" id="corpPvDraft"> ${esc(t('corp.preview.draft'))}</label>` : ''}
      </div>` : ''}
      <div id="corpPvOut" class="corp-preview">${targets && !screens.length ? esc(t('corp.preview.no_screens')) : ''}</div>`,
  });
  const out = m.q('#corpPvOut');
  async function show(deviceId) {
    if (!deviceId) { out.innerHTML = ''; return; }
    out.innerHTML = esc(t('common.loading'));
    try {
      const r = await api.previewCorporateScreen(deviceId, !!m.q('#corpPvDraft')?.checked);
      out.innerHTML = previewHtml(r);
      hydrateAuthImages(out);
    } catch (e) { out.innerHTML = `<div class="corp-notice corp-notice-danger">${esc(e.message)}</div>`; }
  }
  m.q('#corpPvScreen')?.addEventListener('change', (e) => show(e.target.value));
  m.q('#corpPvDraft')?.addEventListener('change', () => show(m.q('#corpPvScreen').value));
  if (opts.deviceId) show(opts.deviceId);
}

export function previewHtml(r) {
  const tagOf = (it) => {
    if (it.tag === 'slot') return chip(t('corp.preview.tag_slot', { slot: it.slot_name || '', level: it.level_label || '' }), 'slot');
    if (it.tag === 'fallback') return chip(it.slot_name ? t('corp.preview.tag_fallback_for', { slot: it.slot_name }) : t('corp.preview.tag_fallback'), 'muted');
    if (it.tag === 'store') return chip(t('corp.preview.tag_store'), 'muted');
    return chip(t('corp.preview.tag_corporate'), 'hq', '', { lock: true });
  };
  const head = r.mandate
    ? (r.mandate.dark ? t('corp.preview.dark') : t('corp.preview.plays', { name: r.mandate.playlist_name || '', target: r.mandate.target_label || '' }))
    : t('corp.preview.not_mandated');
  const skipped = (r.slots || []).filter((x) => x.outcome === 'skipped');
  return `
    <div class="corp-help">${esc(head)}${r.layout ? ' · ' + esc(t('corp.preview.layout', { name: r.layout.name })) : ''}${r.draft ? ' · ' + esc(t('corp.preview.draft_note')) : ''}</div>
    ${(r.items || []).length ? `<ol class="corp-loop">${r.items.map((it) => `
      <li>${thumb(it)}<span class="corp-loop-name">${esc(it.filename || t('common.unknown'))}</span>${tagOf(it)}<span class="corp-loop-sec">${esc(formatSec(it.seconds != null ? it.seconds : it.duration_sec))}</span></li>`).join('')}</ol>`
      : `<div class="corp-empty">${esc(t('corp.preview.empty'))}</div>`}
    ${skipped.map((x) => `<div class="corp-help">${chip(t('corp.preview.tag_skipped'), 'muted')} ${esc(x.name || '')}</div>`).join('')}
    <div class="corp-help"><strong>${esc(t('corp.preview.total', { len: formatSec(r.total_sec) }))}</strong>
      ${(r.slots || []).filter((x) => x.outcome !== 'skipped').map((x) => ` · ${esc(t('corp.preview.slot_sec', { slot: x.name || '', len: formatSec(x.seconds) }))}`).join('')}</div>`;
}

