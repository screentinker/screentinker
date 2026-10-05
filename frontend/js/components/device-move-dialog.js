/*
 * "Move to another workspace" — for one screen (device page) or a selection (dashboard).
 *
 * The person picks a workspace they can administer — of the same organization, or, for a platform
 * admin, ANY workspace, grouped by organization — and the server's preview (a rolled-back run of the
 * real move) then says what happens: what stays behind with the old workspace (groups, wall seat,
 * schedules), what "Bring its playlist" copies along, whether head office drives the screens there,
 * and every store trigger that stops reaching them. Move stays disabled until each list that needs
 * it is ticked:
 *   - "I've checked these" for the trigger list (acknowledge_impact);
 *   - "I understand these screens leave this organization" for a move to another organization
 *     (acknowledge_other_org).
 * The server refuses without either, so a stale dialog cannot skip them. A move whose copy the
 * target account has no storage for is refused by the preview itself, before anyone ticks anything.
 */
import { api } from '../api.js';
import { t, tn } from '../i18n.js';
import { esc, isPlatformAdmin } from '../utils.js';
import { showToast } from './toast.js';
import * as cui from './corporate-ui.js';

const DROPPED_KEYS = ['groups', 'wall', 'playlist', 'layout', 'default_content', 'schedules', 'power_schedules', 'endpoints', 'trigger_assignments', 'slot_content'];
const BROUGHT_KEYS = ['playlists', 'widgets', 'kiosk_pages', 'data_sources', 'shaders', 'fonts'];

function size(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function droppedSummary(screens) {
  const totals = {};
  for (const s of screens || []) for (const [k, v] of Object.entries(s.dropped || {})) totals[k] = (totals[k] || 0) + (Number(v) || 0);
  const items = DROPPED_KEYS.filter((k) => totals[k]).map((k) => `<li>${esc(tn(`move.dropped.${k}`, totals[k]))}</li>`);
  return items.length ? `<div class="corp-help">${esc(t('move.stays_behind'))}</div><ul class="corp-list">${items.join('')}</ul>` : '';
}

function headOfficeSummary(screens) {
  const after = [...new Set((screens || []).map((s) => s.head_office_after).filter(Boolean))];
  const before = [...new Set((screens || []).map((s) => s.head_office_before).filter(Boolean))];
  if (after.length) return `<div class="corp-notice">${esc(t('move.head_office_after', { name: after.join(', ') }))}</div>`;
  if (before.length) return `<div class="corp-notice">${esc(t('move.head_office_leaves', { name: before.join(', ') }))}</div>`;
  return '';
}

/** What "Bring its playlist" copies, summed over the screens. */
function broughtSummary(screens) {
  const b = (screens || []).map((s) => s.brought).filter(Boolean);
  if (!b.length) return '';
  const sum = (k) => b.reduce((n, x) => n + (Number(x[k]) || 0), 0);
  const lines = [];
  for (const x of b) {
    if (!x.playlist_name) continue;
    lines.push(`<li>${esc(t('move.bring.playlist', { name: x.playlist_name }))}${x.playlist_others ? ` — ${esc(tn('move.bring.others', x.playlist_others))}` : ''}</li>`);
  }
  const content = sum('content');
  if (content) lines.push(`<li>${esc(tn('move.bring.content', content, { size: size(sum('bytes')) }))}</li>`);
  for (const k of BROUGHT_KEYS) { const n = sum(k); if (n && k !== 'playlists') lines.push(`<li>${esc(tn(`move.bring.${k}`, n))}</li>`); }
  if (sum('playlists') > b.filter((x) => x.playlist_name).length) lines.push(`<li>${esc(tn('move.bring.playlists', sum('playlists')))}</li>`);
  if (b.some((x) => x.layout)) lines.push(`<li>${esc(t('move.bring.layout'))}</li>`);
  if (b.some((x) => x.default_content)) lines.push(`<li>${esc(t('move.bring.default_content'))}</li>`);
  const reused = b.reduce((n, x) => n + ((x.reused || []).length), 0);
  if (reused) lines.push(`<li>${esc(tn('move.bring.reused', reused))}</li>`);
  const smart = b.some((x) => x.smart) ? `<div class="corp-help">${esc(t('move.bring.smart'))}</div>` : '';
  const mandated = (screens || []).some((s) => s.brought && s.head_office_after) ? `<div class="corp-help">${esc(t('move.bring.mandated'))}</div>` : '';
  return `<div class="corp-help">${esc(t('move.bring_summary'))}</div><ul class="corp-list">${lines.join('')}</ul>${smart}${mandated}`;
}

function targetOptions(targets, grouped, filter) {
  const f = String(filter || '').trim().toLowerCase();
  const shown = f ? targets.filter((w) => `${w.name} ${w.organization_name || ''}`.toLowerCase().includes(f)) : targets;
  const opt = (w) => `<option value="${esc(w.id)}">${esc(w.name)}</option>`;
  if (!grouped) return shown.map(opt).join('');
  const byOrg = new Map();
  for (const w of shown) {
    const k = w.organization_id || '';
    if (!byOrg.has(k)) byOrg.set(k, { name: w.organization_name || '', list: [] });
    byOrg.get(k).list.push(w);
  }
  return [...byOrg.values()].map((g) => `<optgroup label="${esc(g.name)}">${g.list.map(opt).join('')}</optgroup>`).join('');
}

/**
 * @param {string[]} deviceIds
 * @param {{ currentWorkspaceId: string, onMoved?: (result) => void }} opts
 */
export async function openDeviceMoveDialog(deviceIds, { currentWorkspaceId, onMoved } = {}) {
  const ids = [...new Set(deviceIds || [])].filter(Boolean);
  if (!ids.length) return;
  let me = null;
  try { me = await api.getMe(); } catch (_) { me = null; }
  const all = (me && Array.isArray(me.accessible_workspaces)) ? me.accessible_workspaces : [];
  const here = all.find((w) => w.id === currentWorkspaceId);
  // A platform admin may move screens to ANY workspace, another organization's included; everyone
  // else to a workspace of the same organization they can administer.
  const platformAdmin = !!(me && (me.is_platform_admin || isPlatformAdmin(me)));
  const targets = all.filter((w) => w.id !== currentWorkspaceId && w.can_admin
    && (platformAdmin || !here || w.organization_id === here.organization_id));
  if (!here || !here.can_admin) {
    cui.explainLocked({ title: t('move.title'), text: t('move.need_admin') });
    return;
  }
  if (!targets.length) {
    cui.explainLocked({ title: t('move.title'), text: t('move.no_targets') });
    return;
  }
  const grouped = platformAdmin && new Set(targets.map((w) => w.organization_id)).size > 1;
  const searchable = targets.length > 12;

  const m = cui.openModal({
    title: tn('move.title_n', ids.length),
    body: `
      <div class="form-group">
        <label for="moveWsSelect">${esc(t('move.to_label'))}</label>
        ${searchable ? `<input type="search" id="moveWsSearch" class="input" style="width:100%;margin-bottom:6px" placeholder="${esc(t('move.search'))}" autocomplete="off">` : ''}
        <select id="moveWsSelect" class="input" style="width:100%">
          <option value="">${esc(t('move.choose'))}</option>
          ${targetOptions(targets, grouped, '')}
        </select>
      </div>
      <div class="form-group" id="moveBringRow" style="display:none">
        <label class="corp-check" style="display:flex;gap:8px;align-items:flex-start">
          <input type="checkbox" id="moveBring" checked> <span>${esc(t('move.bring'))}</span>
        </label>
        <div class="corp-help" style="margin-left:22px">${esc(t('move.bring_help'))}</div>
      </div>
      <div id="movePreview" class="corp-help">${esc(t('move.pick_first'))}</div>`,
    footer: `<button type="button" class="btn btn-secondary" data-corp-close>${esc(t('common.cancel'))}</button>
             <button type="button" class="btn btn-primary" id="moveConfirmBtn" disabled>${esc(tn('move.confirm', ids.length))}</button>`,
  });
  const sel = m.q('#moveWsSelect');
  const search = m.q('#moveWsSearch');
  const bringRow = m.q('#moveBringRow');
  const bring = m.q('#moveBring');
  const box = m.q('#movePreview');
  const btn = m.q('#moveConfirmBtn');
  let impact = [];
  let otherOrg = null;
  let refused = false;
  let hasOwn = false;
  let seq = 0;

  const syncBtn = () => {
    const ack = m.q('#moveTrigAck');
    const orgAck = m.q('#moveOrgAck');
    btn.disabled = !sel.value || refused
      || (impact.length > 0 && !(ack && ack.checked))
      || (!!otherOrg && !(orgAck && orgAck.checked));
  };

  if (search) {
    search.addEventListener('input', () => {
      const keep = sel.value;
      sel.innerHTML = `<option value="">${esc(t('move.choose'))}</option>${targetOptions(targets, grouped, search.value)}`;
      if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
    });
  }

  async function refresh() {
    impact = []; otherOrg = null; refused = false;
    btn.disabled = true;
    if (!sel.value) { box.innerHTML = esc(t('move.pick_first')); bringRow.style.display = 'none'; return; }
    const mine = ++seq;
    box.innerHTML = esc(t('common.loading'));
    try {
      // The first preview always asks with bring on, to learn whether any screen HAS its own
      // playlist; the checkbox appears only then, ticked by default.
      const wantBring = bringRow.style.display === 'none' ? true : !!bring.checked;
      const pv = await api.previewMoveDevices(ids, sel.value, { bring: wantBring });
      if (mine !== seq) return;
      hasOwn = (pv.screens || []).some((s) => s.has_own);
      bringRow.style.display = hasOwn ? '' : 'none';
      if (!hasOwn) bring.checked = false;
      impact = pv.impact || [];
      otherOrg = pv.other_organization || null;
      refused = !!(pv.storage_refusal && (bring.checked && hasOwn));
      const s = await cui.corporateSettings();
      if (mine !== seq) return;
      const orgNotice = otherOrg ? `<div class="corp-notice corp-notice-warn">${esc(t('move.other_org', { org: otherOrg.name }))}
          <label class="corp-check" style="display:flex;gap:8px;margin-top:8px"><input type="checkbox" id="moveOrgAck"> ${esc(t('move.other_org_ack'))}</label></div>` : '';
      const plan = pv.plan_warning ? `<div class="corp-notice corp-notice-warn">${esc(t('move.plan_warning', { plan: pv.plan_warning.plan, after: pv.plan_warning.devices_after, limit: pv.plan_warning.devices_limit }))}</div>` : '';
      const storage = refused ? `<div class="corp-notice corp-notice-danger">${esc(pv.storage_refusal.error)}</div>` : '';
      box.innerHTML = `${orgNotice}${plan}${storage}${headOfficeSummary(pv.screens)}
        ${bring.checked && hasOwn ? broughtSummary(pv.screens) : ''}${droppedSummary(pv.screens)}
        ${cui.storeTriggerImpactHtml(impact, s && s.store_triggers_under_mandate, { ackId: 'moveTrigAck' })}`;
      for (const id of ['#moveTrigAck', '#moveOrgAck']) { const el = m.q(id); if (el) el.addEventListener('change', syncBtn); }
      syncBtn();
    } catch (e) {
      if (mine !== seq) return;
      impact = [];
      box.innerHTML = `<div class="corp-notice corp-notice-danger">${esc(e.message)}</div>`;
      btn.disabled = true;
    }
  }
  sel.addEventListener('change', refresh);
  bring.addEventListener('change', refresh);

  btn.addEventListener('click', async () => {
    const ack = m.q('#moveTrigAck');
    const orgAck = m.q('#moveOrgAck');
    if (impact.length && !(ack && ack.checked)) { showToast(t('corp.settings.impact_need_ack'), 'error'); return; }
    if (otherOrg && !(orgAck && orgAck.checked)) { showToast(t('move.other_org_need_ack'), 'error'); return; }
    btn.disabled = true;
    const extra = {
      ...(hasOwn && bring.checked ? { bring_playlist: true } : {}),
      ...(otherOrg ? { acknowledge_other_org: true } : {}),
    };
    try {
      // Ticked here already for the previewed list; with nothing previewed, withImpactAck still asks
      // if the server finds something at save time (the screens changed in between).
      const r = await cui.withImpactAck((o) => api.moveDevices(ids, sel.value, { ...extra, ...(impact.length ? { acknowledge_impact: true } : o) }));
      m.close();
      const name = (targets.find((w) => w.id === sel.value) || {}).name || '';
      showToast(tn('move.done', (r.moved || []).length || ids.length, { workspace: name }), 'success');
      if (r.store_triggers_showing_again) showToast(tn('move.triggers_showing_again', r.store_triggers_showing_again), 'info');
      cui.forgetCorporateCache();
      if (typeof onMoved === 'function') onMoved(r);
    } catch (e) {
      showToast(e.message, e.cancelled ? 'info' : 'error');
      syncBtn();
    }
  });
}
