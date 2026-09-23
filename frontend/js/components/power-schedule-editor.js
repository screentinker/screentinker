/*
 * The weekly display-power editor, shared by the device page and the group page.
 *
 * ⚠️ ONE editor for both, deliberately. The two surfaces differ only in what they target, and a
 * second copy is how "off 22:00-06:00" comes to mean one thing on a screen and another on a group
 * — the exact divergence lib/device-power-schedule.js exists to prevent on the server.
 *
 * The vocabulary is the operator's, not the schema's: rows read "Off 22:00 - 06:00, Mon-Fri". The
 * word POWER is avoided everywhere in the copy, because this does not power anything off — it
 * blanks the panel and leaves the player running. Someone who believes this reboots their screens
 * will use it wrong, and the one-line note under the heading is load-bearing for that reason.
 */
import { t } from '../i18n.js';

// 0=Sunday, matching shared/power-window-vectors.json and JS Date.getDay(). The UI renders Monday
// first because that is how a shop week reads; the VALUES are unchanged.
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_KEY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const PRESETS = [
  { key: 'weeknights', days: [1, 2, 3, 4, 5], start: '22:00', end: '06:00' },
  { key: 'everynight', days: [0, 1, 2, 3, 4, 5, 6], start: '22:00', end: '06:00' },
  { key: 'weekends', days: [6, 0], start: '00:00', end: '24:00' },
];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** "22:00" + "06:00" -> a human phrase, including the fact that it crosses midnight. */
export function describeWindow(w) {
  const days = DAY_ORDER.filter((d) => (w.days || []).includes(d))
    .map((d) => t(`power.day.${DAY_KEY[d]}`)).join(', ');
  const overnight = w.start > w.end;
  return `${esc(w.start)} – ${esc(w.end)}${overnight ? ` ${t('power.overnight')}` : ''} · ${days || t('power.no_days')}`;
}

function windowRow(w, i) {
  const dayBoxes = DAY_ORDER.map((d) => `
    <label class="power-day">
      <input type="checkbox" data-win="${i}" data-day="${d}" ${(w.days || []).includes(d) ? 'checked' : ''}>
      <span>${esc(t(`power.day.${DAY_KEY[d]}`))}</span>
    </label>`).join('');

  return `
    <div class="power-window" data-win="${i}">
      <div class="power-window-times">
        <label>${esc(t('power.off_from'))}
          <input type="time" class="power-start" data-win="${i}" value="${esc(w.start || '22:00')}">
        </label>
        <label>${esc(t('power.on_at'))}
          <input type="time" class="power-end" data-win="${i}" value="${esc(w.end || '06:00')}">
        </label>
        <button type="button" class="btn btn-secondary btn-sm power-remove" data-win="${i}"
                aria-label="${esc(t('power.remove_window'))}">✕</button>
      </div>
      <div class="power-days">${dayBoxes}</div>
      ${(w.start && w.end && w.start > w.end)
        ? `<div class="power-hint">${esc(t('power.crosses_midnight'))}</div>` : ''}
    </div>`;
}

/**
 * Render the editor.
 *
 * @param {{windows:Array, enabled:boolean, timezone:string|null}} schedule  current state (may be empty)
 * @param {{supported:boolean, inherited:object|null, state:string, nextEdge:object|null}} ctx
 */
export function renderPowerScheduleEditor(schedule, ctx = {}) {
  const windows = Array.isArray(schedule?.windows) ? schedule.windows : [];
  const enabled = schedule ? schedule.enabled !== false : true;

  /*
   * ⚠️ On a DEVICE page an unsupported panel disables the editor, and that is a deliberate reversal
   * of my first version. The original argument — "an operator may reasonably schedule a screen that
   * is offline, or a mixed-hardware group" — holds for a GROUP, where some members can honour it.
   * It does not hold here: this page is one panel, deliverCommand will refuse set_power_schedule
   * for it, and the payload field will be ignored. Letting someone save is letting them save a row
   * that nothing will ever act on, then walk away believing the shop lights go off at ten.
   */
  const unsupported = ctx.supported === false;
  const warn = unsupported
    ? `<div class="power-warning">${esc(t('power.unsupported'))}</div>` : '';

  const inherited = ctx.inherited
    ? `<div class="power-hint">${esc(t('power.inherited_from_group'))}</div>` : '';

  /*
   * ⚠️ Two or more group schedules on one screen. The resolver picks a stable winner (lowest group
   * id) and that stays — but an operator cannot discover WHICH from two group pages that each look
   * correct on their own. The only symptom otherwise is a screen going dark at the wrong time.
   */
  const conflicts = Array.isArray(ctx.groupSchedules) && ctx.groupSchedules.length > 1
    ? `<div class="power-warning">${esc(
        t('power.group_conflict').replace('{n}', String(ctx.groupSchedules.length))
      )}<ul>${ctx.groupSchedules.map((g, i) => `<li>${esc(g.group_name || g.group_id)}${
        i === 0 ? ` — ${esc(t('power.group_conflict_winner'))}` : ''}</li>`).join('')}</ul></div>`
    : '';

  const status = ctx.state
    ? `<span class="power-state power-state-${esc(ctx.state)}">${esc(
        ctx.state === 'scheduled_off' ? t('power.state.scheduled_off') : t('power.state.on'))}</span>`
    : '';

  const next = ctx.nextEdge
    ? `<div class="power-hint">${esc(
        ctx.nextEdge.to === 'scheduled_off'
          ? t('power.next_off').replace('{time}', ctx.nextEdge.at)
          : t('power.next_on').replace('{time}', ctx.nextEdge.at))}</div>`
    : '';

  return `
    <div class="power-schedule-editor" id="powerScheduleEditor">
      <div class="power-head">
        <label class="power-enable">
          <input type="checkbox" id="powerEnabled" ${enabled ? 'checked' : ''}${unsupported ? ' disabled' : ''}>
          <span>${esc(t('power.enable'))}</span>
        </label>
        ${status}
      </div>
      <!-- Load-bearing: someone who thinks this powers the device off will use it wrong. -->
      <p class="power-explainer">${esc(t('power.explainer'))}</p>
      ${warn}${conflicts}${inherited}${next}
      <div id="powerWindows">${windows.map(windowRow).join('') || `<div class="power-empty">${esc(t('power.no_windows'))}</div>`}</div>
      <div class="power-actions">
        <button type="button" class="btn btn-secondary btn-sm" id="powerAddWindow"${unsupported ? ' disabled' : ''}>+ ${esc(t('power.add_window'))}</button>
        ${PRESETS.map((p) => `<button type="button" class="btn btn-secondary btn-sm power-preset" data-preset="${p.key}"${unsupported ? ' disabled' : ''}>${esc(t(`power.preset.${p.key}`))}</button>`).join('')}
        <button type="button" class="btn btn-primary btn-sm" id="powerSave"${unsupported ? ' disabled title="' + esc(t('power.unsupported')) + '"' : ''}>${esc(t('power.save'))}</button>
        ${schedule?.id ? `<button type="button" class="btn btn-secondary btn-sm" id="powerDelete">${esc(t('power.remove_schedule'))}</button>` : ''}
      </div>
    </div>`;
}

/**
 * Read the editor back out of the DOM.
 *
 * ⚠️ Drops windows with no days selected rather than sending them. The server refuses them (a
 * window with no days can never be active), and silently discarding a half-built row the operator
 * abandoned is friendlier than a 400 that names an index they cannot see.
 */
export function readPowerScheduleEditor(root = document) {
  const host = root.getElementById ? root.getElementById('powerScheduleEditor') : root.querySelector('#powerScheduleEditor');
  if (!host) return null;
  const windows = [];
  host.querySelectorAll('.power-window').forEach((el) => {
    const i = el.getAttribute('data-win');
    const start = host.querySelector(`.power-start[data-win="${i}"]`)?.value || '';
    const end = host.querySelector(`.power-end[data-win="${i}"]`)?.value || '';
    const days = [];
    host.querySelectorAll(`input[data-win="${i}"][data-day]`).forEach((cb) => {
      if (cb.checked) days.push(Number(cb.getAttribute('data-day')));
    });
    if (!days.length || !start || !end) return;
    windows.push({ days: days.sort((a, b) => a - b), start, end });
  });
  return {
    enabled: !!host.querySelector('#powerEnabled')?.checked,
    windows,
  };
}

export function presetWindows(key) {
  const p = PRESETS.find((x) => x.key === key);
  return p ? [{ days: p.days.slice(), start: p.start, end: p.end }] : [];
}

export { PRESETS, DAY_ORDER, DAY_KEY };
