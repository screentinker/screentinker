/*
 * "Move to another workspace" — for one screen (device page) or a selection (dashboard).
 *
 * The person picks a workspace of the same organization they can administer; the server's preview
 * (a rolled-back run of the real move) then says what happens: what stays behind with the old
 * workspace (groups, wall seat, its own playlist, schedules), whether head office drives the
 * screens there, and every store trigger that stops reaching them — the old store's, left behind,
 * and any head office hides in the new workspace. If that list is not empty, Move stays disabled
 * until "I've checked these" is ticked, and the request carries acknowledge_impact (the server
 * refuses without it). A store admin moving a screen head office drives is refused by the preview
 * itself, with head office's own sentence.
 */
import { api } from '../api.js';
import { t, tn } from '../i18n.js';
import { esc } from '../utils.js';
import { showToast } from './toast.js';
import * as cui from './corporate-ui.js';

const DROPPED_KEYS = ['groups', 'wall', 'playlist', 'layout', 'default_content', 'schedules', 'power_schedules', 'endpoints', 'trigger_assignments', 'slot_content'];

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
  const targets = all.filter((w) => w.id !== currentWorkspaceId && w.can_admin && (!here || w.organization_id === here.organization_id));
  if (!here || !here.can_admin) {
    cui.explainLocked({ title: t('move.title'), text: t('move.need_admin') });
    return;
  }
  if (!targets.length) {
    cui.explainLocked({ title: t('move.title'), text: t('move.no_targets') });
    return;
  }

  const m = cui.openModal({
    title: tn('move.title_n', ids.length),
    body: `
      <div class="form-group">
        <label for="moveWsSelect">${esc(t('move.to_label'))}</label>
        <select id="moveWsSelect" class="input" style="width:100%">
          <option value="">${esc(t('move.choose'))}</option>
          ${targets.map((w) => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join('')}
        </select>
      </div>
      <div id="movePreview" class="corp-help">${esc(t('move.pick_first'))}</div>`,
    footer: `<button type="button" class="btn btn-secondary" data-corp-close>${esc(t('common.cancel'))}</button>
             <button type="button" class="btn btn-primary" id="moveConfirmBtn" disabled>${esc(tn('move.confirm', ids.length))}</button>`,
  });
  const sel = m.q('#moveWsSelect');
  const box = m.q('#movePreview');
  const btn = m.q('#moveConfirmBtn');
  let impact = [];
  let seq = 0;

  const syncBtn = () => {
    const ack = m.q('#moveTrigAck');
    btn.disabled = !sel.value || (impact.length > 0 && !(ack && ack.checked));
  };

  sel.addEventListener('change', async () => {
    impact = [];
    btn.disabled = true;
    if (!sel.value) { box.innerHTML = esc(t('move.pick_first')); return; }
    const mine = ++seq;
    box.innerHTML = esc(t('common.loading'));
    try {
      const pv = await api.previewMoveDevices(ids, sel.value);
      if (mine !== seq) return;
      impact = pv.impact || [];
      const s = await cui.corporateSettings();
      box.innerHTML = `${headOfficeSummary(pv.screens)}${droppedSummary(pv.screens)}
        ${cui.storeTriggerImpactHtml(impact, s && s.store_triggers_under_mandate, { ackId: 'moveTrigAck' })}`;
      const ack = m.q('#moveTrigAck');
      if (ack) ack.addEventListener('change', syncBtn);
      syncBtn();
    } catch (e) {
      if (mine !== seq) return;
      impact = [];
      box.innerHTML = `<div class="corp-notice corp-notice-danger">${esc(e.message)}</div>`;
      btn.disabled = true;
    }
  });

  btn.addEventListener('click', async () => {
    const ack = m.q('#moveTrigAck');
    if (impact.length && !(ack && ack.checked)) { showToast(t('corp.settings.impact_need_ack'), 'error'); return; }
    btn.disabled = true;
    try {
      // Ticked here already for the previewed list; with nothing previewed, withImpactAck still asks
      // if the server finds something at save time (the screens changed in between).
      const r = await cui.withImpactAck((o) => api.moveDevices(ids, sel.value, impact.length ? { acknowledge_impact: true } : o));
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
