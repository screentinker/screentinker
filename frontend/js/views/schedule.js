import { api, assertLocalCallAllowed } from '../api.js';
import { showToast } from '../components/toast.js';
import { t } from '../i18n.js';
import {
  HOUR_PX, pxToMinutes, minutesToPx, rangeFromDrag, moveRange, resizeRange,
  toLocalStamp, formatRange, canMoveAcrossDays, editsWholeSeries, isDrag,
  splitAcrossMidnight, dragArmMode, LONG_PRESS_MS, DEFAULT_NEW_MIN, DAY_MIN,
} from '../lib/schedule-grid.js';
import {
  VIEWS, DEFAULT_VIEW, VIEW_STORAGE_KEY, RAIL_STORAGE_KEY, WORK_DAYS, WORK_START_MIN, WORK_END_MIN,
  periodRange, stepAnchor, monthGrid, isAllDay, packColumns, presetFor, describeRecurrence,
  WEEKDAYS_RULE, WEEKENDS_RULE, RRULE_DAYS, startOfDay, addDays, sameDay, ymd, planOccurrenceEdit,
} from '../lib/schedule-calendar.js';

/*
 * The Schedule view, built to behave like Outlook's calendar for the thing signage actually
 * schedules: a playlist, layout or item on a screen or a group, for a window of time, optionally
 * repeating. Four views over ONE fetch per period, a rail of calendars (screens and groups) with
 * colour checkboxes as the primary filter, a peek on click, a compose popover on an empty slot,
 * and the full dialog behind "More details". Direct manipulation (drag to create / move / resize,
 * long-press on touch) is the same pointer loop the week grid already had.
 *
 * The geometry lives in lib/schedule-grid.js and the view model in lib/schedule-calendar.js, both
 * pure and pinned in Node. This file is the DOM.
 */

/*
 * #327: compose and parse the recurrence rule.
 *
 * The engine (services/scheduler.js) honours BYDAY, the date window and recurrence_end, and
 * ignores FREQ. So every rule written here carries what the engine needs: a plain weekly repeat
 * gets its weekday spelled out (a bare FREQ=WEEKLY has no BYDAY filter and plays every day), and
 * Monthly is the one form the engine evaluates on the day-of-month. Nothing here writes a rule the
 * panel would play differently from how the calendar draws it.
 */
const DAY_KEY_LABELS = () => ({
  MO: t('schedule.day_mo'), TU: t('schedule.day_tu'), WE: t('schedule.day_we'), TH: t('schedule.day_th'),
  FR: t('schedule.day_fr'), SA: t('schedule.day_sa'), SU: t('schedule.day_su'),
});
const DOW_TO_RRULE = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// The date the repeat control is describing, so "weekly" can default to that weekday and the
// summary can say "from 9:00 AM". Set by whichever path opens the dialog.
let recurrenceStartDate = null;

function checkedDays() {
  return RRULE_DAYS.filter((d) => {
    const el = document.querySelector(`.sched-day[value="${d}"]`);
    return el && el.checked;
  });
}

// What the form currently means, as an RRULE string (or null for "does not repeat").
function readRecurrence() {
  const sel = document.getElementById('schedRepeat');
  if (!sel) return null;
  const v = sel.value;
  if (!v) return null;
  // Daily, weekdays, weekends and monthly are stored as written; the engine evaluates each one.
  if (v !== 'CUSTOM' && v !== 'WEEKLY') return v;
  // WEEKLY and CUSTOM both read the day picker. WEEKLY pre-ticks the start's weekday (syncRepeatUI),
  // so the fallback below is only ever reached by CUSTOM with nothing ticked. That case is kept as
  // a plain weekly repeat rather than writing FREQ=WEEKLY;BYDAY= and leaving the engine to
  // interpret an empty list.
  const days = checkedDays();
  return days.length ? `FREQ=WEEKLY;BYDAY=${days.join(',')}` : 'FREQ=WEEKLY';
}

// Put an existing rule back into the form so editing a schedule shows what it actually does. A
// set of days that is not one of the presets selects CUSTOM and ticks them; a single day that is
// the start's own weekday is the plain WEEKLY case.
function applyRecurrence(rec) {
  const sel = document.getElementById('schedRepeat');
  if (!sel) return;
  const value = rec || '';
  const byday = /BYDAY=([A-Z,]+)/.exec(value);
  const { preset, byDay } = presetFor(value, recurrenceStartDate);
  const tick = (days) => {
    const set = new Set(days);
    for (const d of RRULE_DAYS) {
      const el = document.querySelector(`.sched-day[value="${d}"]`);
      if (el) el.checked = set.has(d);
    }
  };
  if (preset === 'none') { sel.value = ''; tick([]); }
  else if (preset === 'daily') { sel.value = 'FREQ=DAILY'; tick([]); }
  else if (preset === 'monthly') { sel.value = 'FREQ=MONTHLY'; tick([]); }
  else if (preset === 'weekdays') { sel.value = WEEKDAYS_RULE; tick(byDay); }
  else if (preset === 'weekends') { sel.value = WEEKENDS_RULE; tick(byDay); }
  else {
    const startDow = recurrenceStartDate ? DOW_TO_RRULE[recurrenceStartDate.getDay()] : null;
    const plainWeekly = byDay.length === 1 && byDay[0] === startDow;
    if (plainWeekly) { sel.value = 'WEEKLY'; tick(byDay); }
    else { sel.value = 'CUSTOM'; tick(byday ? byday[1].split(',').filter((d) => RRULE_DAYS.includes(d)) : byDay); }
  }
  syncRepeatUI();
}

// Day pickers only make sense for a weekly rule; an end date only for something that repeats.
function wireRepeatOnce() {
  const sel = document.getElementById('schedRepeat');
  if (!sel || sel.dataset.wired) return;
  sel.dataset.wired = '1';
  sel.addEventListener('change', () => {
    // Choosing WEEKLY means "every week on this day": reset the picker to the start's weekday, so a
    // set left over from the weekdays preset or a previous CUSTOM does not silently carry over.
    // Multiple arbitrary days remain CUSTOM's job.
    if (sel.value === 'WEEKLY' && recurrenceStartDate) {
      const want = DOW_TO_RRULE[recurrenceStartDate.getDay()];
      for (const d of RRULE_DAYS) { const el = document.querySelector(`.sched-day[value="${d}"]`); if (el) el.checked = (d === want); }
    }
    syncRepeatUI();
  });
  for (const id of ['schedDays', 'schedRepeatEnd', 'schedStart', 'schedEnd']) {
    document.getElementById(id)?.addEventListener('change', syncRepeatUI);
  }
}

const p2 = (n) => String(n).padStart(2, '0');
function fmt12(min) {
  const h24 = Math.floor(min / 60) % 24, mm = min % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${p2(mm)} ${h24 < 12 ? 'AM' : 'PM'}`;
}
const hhmmToMin = (s) => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const fmtDate = (d, opts) => d.toLocaleDateString(undefined, opts || { month: 'short', day: 'numeric', year: 'numeric' });

// The human sentence under the repeat control and in the peek: "Every Mon, Wed, Fri from 9:00 AM
// to 5:00 PM until Oct 31". Assembled from describeRecurrence's data through t(), so every locale
// phrases it its own way.
function recurrenceSentence(rule, { startMin, endMin, until, startDate }) {
  const d = describeRecurrence(rule, { startDate });
  if (d.kind === 'none') return t('schedule.repeat_summary_none');
  const labels = DAY_KEY_LABELS();
  let head;
  if (d.kind === 'daily') head = t('schedule.repeat_summary_daily');
  else if (d.kind === 'monthly') head = t('schedule.repeat_summary_monthly', { d: d.dayOfMonth ?? (startDate ? startDate.getDate() : '') });
  else head = t('schedule.repeat_summary_weekly', { days: (d.days.length ? d.days : RRULE_DAYS).map((k) => labels[k]).join(', ') });
  const parts = [head, t('schedule.repeat_summary_time', { start: fmt12(startMin), end: fmt12(endMin) })];
  if (until) parts.push(t('schedule.repeat_summary_until', { date: fmtDate(until, { month: 'short', day: 'numeric' }) }));
  return parts.join(' ');
}

function syncRepeatUI() {
  wireRepeatOnce();
  const sel = document.getElementById('schedRepeat');
  const daysRow = document.getElementById('schedDaysRow');
  const endRow = document.getElementById('schedRepeatEndRow');
  const summary = document.getElementById('schedRepeatSummary');
  if (!sel) return;
  const pick = sel.value === 'CUSTOM' || sel.value === 'WEEKLY';
  if (daysRow) daysRow.style.display = pick ? '' : 'none';
  if (endRow) endRow.style.display = sel.value ? '' : 'none';
  if (summary) {
    const untilRaw = document.getElementById('schedRepeatEnd')?.value;
    const until = untilRaw ? new Date(untilRaw + 'T00:00:00') : null;
    summary.textContent = recurrenceSentence(readRecurrence(), {
      startMin: hhmmToMin(document.getElementById('schedStart')?.value),
      endMin: hhmmToMin(document.getElementById('schedEnd')?.value),
      until, startDate: recurrenceStartDate || new Date(),
    });
  }
}

// A refused request must reject, not resolve. Same contract as the shared client in api.js,
// including the 401 session-expiry reload; this local copy exists because the view calls routes
// api.js has no wrapper for.
const API = (url, opts = {}) => {
  assertLocalCallAllowed(url, opts.method);
  return fetch('/api' + url, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}`, ...opts.headers }, ...opts }).then(async (r) => {
    if (r.status === 401) { localStorage.removeItem('token'); window.location.reload(); throw new Error('Session expired'); }
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `Request failed (${r.status})`); }
    return r.json();
  });
};

// Teardown registered during render. Declared here so it exists before any render pushes to it.
const cleanupFns = [];
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const DEFAULT_SCROLL_HOUR = 8;
// Below this a seven-column week is unusable (~50px a column), so the time grid shows ONE day and
// the month view compresses its pills to bars. The width, not the device, decides.
const NARROW_PX = 700;
const isNarrow = () => window.innerWidth < NARROW_PX;
const MONTH_PILLS = 3;

function esc(str) { const d = document.createElement('div'); d.textContent = str == null ? '' : String(str); return d.innerHTML; }

const readStored = (k, fallback) => { try { return localStorage.getItem(k) ?? fallback; } catch (_) { return fallback; } };
const writeStored = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } };

export async function render(container) {
  const [devices, content, groups, playlists, layoutsRaw] = await Promise.all([
    api.getDevices(), api.getContent(), api.getGroups(), api.getPlaylists(), API('/layouts'),
  ]);
  const layouts = (Array.isArray(layoutsRaw) ? layoutsRaw : []).filter((l) => !l.is_template);

  const DAYS = [
    t('schedule.day.sun'), t('schedule.day.mon'), t('schedule.day.tue'),
    t('schedule.day.wed'), t('schedule.day.thu'), t('schedule.day.fri'), t('schedule.day.sat'),
  ];

  container.innerHTML = `
    <div class="page-header">
      <div><h1>${t('schedule.title')} <span class="help-tip" data-tip="${t('schedule.help_tip')}">?</span></h1><div class="subtitle">${t('schedule.subtitle')}</div></div>
    </div>
    <div class="sched-toolbar">
      <button class="btn btn-secondary btn-sm" id="schedRailBtn" aria-label="${t('schedule.rail_toggle')}" title="${t('schedule.rail_toggle')}">&#9776;</button>
      <button class="btn btn-secondary btn-sm" id="schedToday">${t('schedule.today')}</button>
      <button class="btn btn-secondary btn-sm" id="schedPrev" aria-label="${t('schedule.prev')}" title="${t('schedule.prev')}">&lsaquo;</button>
      <button class="btn btn-secondary btn-sm" id="schedNext" aria-label="${t('schedule.next')}" title="${t('schedule.next')}">&rsaquo;</button>
      <button class="sched-datelabel" id="schedDateLabel" aria-haspopup="dialog" title="${t('schedule.jump_to_date')}"></button>
      <span class="spacer"></span>
      <span class="sched-kbd">${t('schedule.keyboard_hint')}</span>
      <div class="sched-views" role="group" aria-label="${t('schedule.view_week')}">
        ${VIEWS.map((v) => `<button type="button" data-view="${v}">${t(v === 'day' ? 'schedule.view_day' : v === 'workweek' ? 'schedule.view_workweek' : v === 'week' ? 'schedule.view_week' : 'schedule.view_month')}</button>`).join('')}
      </div>
      <button class="btn btn-primary btn-sm" id="addScheduleBtn">${t('schedule.new')}</button>
    </div>
    <div class="sched-shell">
      <aside class="sched-rail" id="schedRail">
        <div>
          <div class="sched-mini-head">
            <button class="btn-icon" id="miniPrev" aria-label="${t('schedule.prev')}">&lsaquo;</button>
            <span id="miniLabel"></span>
            <button class="btn-icon" id="miniNext" aria-label="${t('schedule.next')}">&rsaquo;</button>
          </div>
          <div class="sched-mini" id="schedMini" role="grid"></div>
        </div>
        <div>
          <h4>${t('schedule.calendars')}</h4>
          <input type="search" id="schedCalSearch" class="input" placeholder="${t('schedule.search_calendars')}" style="margin-bottom:6px;background:var(--bg-input)">
          <div class="sched-cal-list" id="schedCalList"></div>
        </div>
      </aside>
      <div class="sched-main">
        <div id="dayStrip" class="sched-daystrip"></div>
        <div id="schedEmpty"></div>
        <div class="sched-frame">
          <div id="schedAllDay" class="sched-allday"></div>
          <div id="calendarScroll" class="sched-scroll"><div id="calendar" class="sched-grid"></div></div>
          <div id="schedMonth" class="sched-month" style="display:none"></div>
        </div>
      </div>
    </div>

    <div class="modal-overlay" id="scheduleModal" style="display:none">
      <div class="modal" style="width:480px">
        <div class="modal-header"><h3 id="schedModalTitle">${t('schedule.add_schedule')}</h3>
          <button class="btn-icon" onclick="document.getElementById('scheduleModal').style.display='none'" aria-label="${t('common.close')}">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="modal-body">
          <div class="form-group"><label>${t('schedule.apply_to')}</label>
            <div style="display:flex;gap:16px;margin-bottom:8px">
              <label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:13px">
                <input type="radio" name="schedTarget" value="device" checked id="schedTargetDevice"> ${t('schedule.target_device')}
              </label>
              <label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:13px">
                <input type="radio" name="schedTarget" value="group" id="schedTargetGroup"> ${t('schedule.target_group')}
              </label>
            </div>
            <select id="schedDeviceSelect" class="input" style="background:var(--bg-input)">
              ${devices.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}
            </select>
            <select id="schedGroupSelect" class="input" style="background:var(--bg-input);display:none">
              ${groups.map((g) => `<option value="${esc(g.id)}">${esc(g.name)} (${t('schedule.group_devices_count', { n: g.device_count })})</option>`).join('')}
            </select>
            ${groups.length === 0 ? `<div id="schedNoGroups" style="display:none;color:var(--text-muted);font-size:12px;margin-top:4px">${t('schedule.no_groups_msg')}</div>` : ''}
            <div id="schedZoneNote" style="display:none;color:var(--text-muted);font-size:11px;margin-top:4px">${t('schedule.zone_note')}</div>
          </div>
          <div class="form-group"><label>${t('schedule.playlist_override')}</label>
            <select id="schedPlaylist" class="input" style="background:var(--bg-input)">
              <option value="">${t('schedule.no_playlist_override')}</option>
              ${playlists.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.status === 'draft' ? ' ' + t('schedule.draft_suffix') : ''}</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label>${t('schedule.layout_override')}</label>
            <select id="schedLayout" class="input" style="background:var(--bg-input)">
              <option value="">${t('schedule.no_layout_override')}</option>
              ${layouts.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label>${t('schedule.content_label')} <span style="color:var(--text-muted);font-weight:normal;font-size:11px">${t('schedule.content_hint')}</span></label>
            <select id="schedContent" class="input" style="background:var(--bg-input)">
              <option value="">${t('schedule.content_none')}</option>
              ${content.map((c) => `<option value="${esc(c.id)}">${esc(c.filename)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label>${t('schedule.title_label')}</label><input type="text" id="schedTitle" class="input" placeholder="${t('schedule.title_placeholder')}"></div>
          <div style="display:flex;gap:12px">
            <div class="form-group" style="flex:1"><label>${t('schedule.start_time')}</label><input type="time" id="schedStart" class="input" value="09:00"></div>
            <div class="form-group" style="flex:1"><label>${t('schedule.end_time')}</label><input type="time" id="schedEnd" class="input" value="17:00"></div>
          </div>
          <!-- Which clock these hours are on. The server stores the schedule in the TARGET's zone and
               the player evaluates in it; without this line "9 to 5" silently meant a zone the user
               could not see. -->
          <div id="schedTzNote" style="font-size:12px;color:var(--text-muted);margin:-4px 0 12px"></div>
          <div class="form-group"><label>${t('schedule.repeat')}</label>
            <select id="schedRepeat" class="input" style="background:var(--bg-input)">
              <option value="">${t('schedule.repeat_none')}</option>
              <option value="FREQ=DAILY">${t('schedule.repeat_daily')}</option>
              <option value="WEEKLY">${t('schedule.repeat_weekly')}</option>
              <option value="${WEEKDAYS_RULE}">${t('schedule.repeat_weekdays')}</option>
              <option value="${WEEKENDS_RULE}">${t('schedule.repeat_weekends')}</option>
              <option value="FREQ=MONTHLY">${t('schedule.repeat_monthly')}</option>
              <option value="CUSTOM">${t('schedule.repeat_custom')}</option>
            </select>
          </div>
          <!-- #327: the engine has always understood BYDAY. These checkboxes compose the same BYDAY
               string the presets hardcode, for the weekly and custom repeats. -->
          <div class="form-group" id="schedDaysRow" style="display:none">
            <label>${t('schedule.repeat_days')}</label>
            <div id="schedDays" style="display:flex;gap:6px;flex-wrap:wrap">
              <!-- Every key spelled out: the i18n checker only sees literal t() calls. -->
              ${[['MO', t('schedule.day_mo')], ['TU', t('schedule.day_tu')], ['WE', t('schedule.day_we')],
                 ['TH', t('schedule.day_th')], ['FR', t('schedule.day_fr')], ['SA', t('schedule.day_sa')],
                 ['SU', t('schedule.day_su')]].map(([d, label]) => `
                <label style="display:flex;align-items:center;gap:4px;font-size:13px;cursor:pointer;padding:4px 8px;border:1px solid var(--border);border-radius:var(--radius)">
                  <input type="checkbox" class="sched-day" value="${d}"> ${label}
                </label>`).join('')}
            </div>
          </div>
          <!-- #327: recurrence_end is stored, honoured by the engine and the calendar, and inclusive. -->
          <div class="form-group" id="schedRepeatEndRow" style="display:none">
            <label>${t('schedule.repeat_until')}</label>
            <input type="date" id="schedRepeatEnd" class="input">
            <div style="font-size:12px;color:var(--text-muted);margin-top:4px">${t('schedule.repeat_until_hint')}</div>
          </div>
          <div id="schedRepeatSummary" style="font-size:12px;color:var(--text-secondary);margin:-6px 0 12px"></div>
          <div class="form-group"><label>${t('schedule.priority')}</label><input type="number" id="schedPriority" class="input" value="0" min="0" max="100"></div>
          <div class="form-group"><label>${t('schedule.color')}</label><input type="color" id="schedColor" value="#3B82F6" style="width:60px;height:32px;border:none;cursor:pointer"></div>
        </div>
        <div class="modal-footer" style="display:flex;justify-content:space-between;gap:8px">
          <button class="btn btn-danger" id="deleteScheduleBtn" style="display:none">${t('common.delete')}</button>
          <div style="display:flex;gap:8px;margin-left:auto">
            <button class="btn btn-secondary" onclick="document.getElementById('scheduleModal').style.display='none'">${t('common.cancel')}</button>
            <button class="btn btn-primary" id="saveScheduleBtn">${t('common.save')}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Outlook's "this occurrence or the whole series?" question, asked after a drag or resize of
         a repeating block. A real dialog rather than confirm(): the answer has three outcomes. -->
    <div class="modal-overlay" id="schedSeriesModal" style="display:none">
      <div class="modal" style="width:420px" role="dialog" aria-labelledby="schedSeriesTitle">
        <div class="modal-header"><h3 id="schedSeriesTitle">${t('schedule.series_prompt_title')}</h3></div>
        <div class="modal-body"><p style="margin:0;color:var(--text-secondary);font-size:13px">${t('schedule.series_prompt_body')}</p></div>
        <div class="modal-footer" style="display:flex;justify-content:flex-end;gap:8px">
          <button class="btn btn-secondary" data-scope="cancel">${t('common.cancel')}</button>
          <button class="btn btn-secondary" data-scope="this">${t('schedule.series_this')}</button>
          <button class="btn btn-primary" data-scope="all">${t('schedule.series_all')}</button>
        </div>
      </div>
    </div>
  `;

  // ---------------------------------------------------------------- state
  let view = VIEWS.includes(readStored(VIEW_STORAGE_KEY, DEFAULT_VIEW)) ? readStored(VIEW_STORAGE_KEY, DEFAULT_VIEW) : DEFAULT_VIEW;
  let anchor = startOfDay(new Date());        // the date the view is centred on
  let miniMonth = startOfDay(new Date());     // the month the mini calendar shows
  let period = null;                          // periodRange() for the current view + anchor
  let allEvents = [];                         // last fetch, unfiltered
  let editingId = null;
  let railOpen = readStored(RAIL_STORAGE_KEY, isNarrow() ? '0' : '1') === '1';
  let calSearch = '';
  const visibleKeys = new Set();              // target keys currently ticked in the rail

  // The date the modal is currently working on: a dragged day, the date of the schedule being
  // edited, or null meaning "today". Set by every path that OPENS the modal.
  let pendingCreateDate = null;

  const deviceRadio = document.getElementById('schedTargetDevice');
  const groupRadio = document.getElementById('schedTargetGroup');
  const deviceSelect = document.getElementById('schedDeviceSelect');
  const groupSelect = document.getElementById('schedGroupSelect');
  const noGroupsMsg = document.getElementById('schedNoGroups');
  const zoneNote = document.getElementById('schedZoneNote');

  function updateTargetVisibility() {
    const isGroup = groupRadio.checked;
    deviceSelect.style.display = isGroup ? 'none' : '';
    groupSelect.style.display = isGroup ? '' : 'none';
    if (noGroupsMsg) noGroupsMsg.style.display = (isGroup && groups.length === 0) ? '' : 'none';
    zoneNote.style.display = isGroup ? '' : 'none';
  }
  deviceRadio.addEventListener('change', updateTargetVisibility);
  groupRadio.addEventListener('change', updateTargetVisibility);

  const tzNote = document.getElementById('schedTzNote');
  function updateTzNote() {
    if (!tzNote) return;
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    let zone = null;
    if (!groupRadio.checked) {
      const d = devices.find((x) => x.id === deviceSelect.value);
      zone = (d && d.timezone && d.timezone !== 'UTC' ? d.timezone : null) || (d && d.reported_timezone) || null;
    }
    if (!zone) { tzNote.textContent = t('schedule.tz_unknown'); return; }
    tzNote.textContent = (zone === local)
      ? t('schedule.tz_same').replace('{zone}', zone)
      : t('schedule.tz_device').replace('{zone}', zone).replace('{local}', local || '');
  }
  deviceRadio.addEventListener('change', updateTzNote);
  groupRadio.addEventListener('change', updateTzNote);
  deviceSelect.addEventListener('change', updateTzNote);
  updateTzNote();

  // ---------------------------------------------------------------- targets and colours
  // Stable colour per target: a group's own colour where it has one, else a hash of the id so the
  // same screen is the same colour every week and across reloads.
  const TARGET_COLORS = ['#3B82F6', '#8B5CF6', '#EC4899', '#F59E0B', '#10B981', '#06B6D4', '#EF4444', '#84CC16', '#A855F7', '#14B8A6'];
  function hashColor(key) {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return TARGET_COLORS[h % TARGET_COLORS.length];
  }
  const calendars = [
    ...devices.map((d) => ({ key: 'd:' + d.id, id: d.id, name: d.name, isGroup: false, color: hashColor('d:' + d.id) })),
    ...groups.map((g) => ({ key: 'g:' + g.id, id: g.id, name: g.name, isGroup: true, color: g.color || hashColor('g:' + g.id) })),
  ];
  for (const c of calendars) visibleKeys.add(c.key);
  const calendarByKey = new Map(calendars.map((c) => [c.key, c]));
  function targetOf(ev) {
    if (ev.group_id) return { key: 'g:' + ev.group_id, name: ev.group_name || t('schedule.target_group'), isGroup: true };
    return { key: 'd:' + (ev.device_id || '?'), name: ev.device_name || t('schedule.target_device'), isGroup: false };
  }
  const colorOf = (ev) => { const tg = targetOf(ev); return (calendarByKey.get(tg.key) || {}).color || ev.group_color || hashColor(tg.key); };
  const labelOf = (ev) => ev.title || ev.playlist_name || ev.content_name || ev.widget_name || t('schedule.scheduled_label');
  const evStart = (ev) => new Date(ev.instance_start || ev.start_time);
  const evEnd = (ev) => new Date(ev.instance_end || ev.end_time);
  const minsOf = (d) => d.getHours() * 60 + d.getMinutes();

  // ---------------------------------------------------------------- view + navigation
  // On a phone the seven-column views become one day; the choice is remembered as made so a
  // rotation or a larger window brings the real view back.
  const effectiveView = () => (isNarrow() && (view === 'week' || view === 'workweek')) ? 'day' : view;

  function setView(v, date) {
    if (VIEWS.includes(v)) { view = v; writeStored(VIEW_STORAGE_KEY, v); }
    if (date) anchor = startOfDay(date);
    miniMonth = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    closePopovers();
    loadCalendar();
  }
  const goToday = () => setView(null, new Date());
  const step = (dir) => setView(null, stepAnchor(effectiveView(), anchor, dir));

  function dateLabel() {
    const ev = effectiveView();
    if (ev === 'day') return fmtDate(anchor, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    if (ev === 'month') return fmtDate(anchor, { month: 'long', year: 'numeric' });
    const days = period ? period.days : periodRange(ev, anchor).days;
    const a = days[0], b = days[days.length - 1];
    // formatRange collapses the shared parts locale-correctly: "Sep 6 – 12, 2026", "Sep 28 – Oct 4,
    // 2026". Do NOT hand toLocaleDateString a month-less {day, year} skeleton for the same-month
    // case: ICU cannot form a date from it and emits a fallback like "2026 (day: 12)".
    try {
      return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).formatRange(a, b);
    } catch (_) {
      return `${fmtDate(a, { month: 'short', day: 'numeric' })} – ${fmtDate(b, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    }
  }

  function renderToolbar() {
    document.getElementById('schedDateLabel').textContent = dateLabel();
    document.querySelectorAll('.sched-views button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    const rail = document.getElementById('schedRail');
    rail.classList.toggle('collapsed', !railOpen);
  }

  // ---------------------------------------------------------------- mini month
  // One renderer for the rail's mini calendar and the date-label popover's jump-to-date picker.
  function renderMini(host, monthDate, { onPick, busyDays = new Set() }) {
    const g = monthGrid(monthDate);
    const today = startOfDay(new Date());
    host.innerHTML = DAYS.map((d) => `<div class="sched-mini-dow">${d.slice(0, 1)}</div>`).join('')
      + g.weeks.flat().map(({ date, inMonth }) => {
        const cls = ['sched-mini-day', inMonth ? '' : 'out', sameDay(date, today) ? 'today' : '', sameDay(date, anchor) ? 'selected' : '', busyDays.has(ymd(date)) ? 'busy' : ''].filter(Boolean).join(' ');
        return `<button type="button" class="${cls}" data-date="${ymd(date)}" aria-label="${fmtDate(date)}">${date.getDate()}</button>`;
      }).join('');
    host.onclick = (e) => {
      const b = e.target.closest('[data-date]');
      if (!b) return;
      const [y, m, d] = b.dataset.date.split('-').map(Number);
      onPick(new Date(y, m - 1, d));
    };
  }
  function renderRailMini() {
    document.getElementById('miniLabel').textContent = fmtDate(miniMonth, { month: 'long', year: 'numeric' });
    const busy = new Set(allEvents.map((ev) => ymd(evStart(ev))));
    renderMini(document.getElementById('schedMini'), miniMonth, { onPick: (d) => setView(null, d), busyDays: busy });
  }
  document.getElementById('miniPrev').onclick = () => { miniMonth = stepAnchor('month', miniMonth, -1); renderRailMini(); };
  document.getElementById('miniNext').onclick = () => { miniMonth = stepAnchor('month', miniMonth, 1); renderRailMini(); };

  // ---------------------------------------------------------------- rail: calendars
  function renderCalList() {
    const host = document.getElementById('schedCalList');
    const q = calSearch.trim().toLowerCase();
    const match = (c) => !q || c.name.toLowerCase().includes(q);
    const section = (title, items) => items.length ? `<h4 style="margin-top:8px">${title}</h4>` + items.map((c) => `
      <label class="sched-cal-item">
        <input type="checkbox" data-key="${esc(c.key)}" ${visibleKeys.has(c.key) ? 'checked' : ''}>
        <span class="sched-cal-swatch${c.isGroup ? ' group' : ''}" style="background:${c.color}"></span>
        <span class="name">${esc(c.name)}</span>
      </label>`).join('') : '';
    const html = section(t('schedule.calendars_screens'), calendars.filter((c) => !c.isGroup && match(c)))
      + section(t('schedule.calendars_groups'), calendars.filter((c) => c.isGroup && match(c)));
    host.innerHTML = html || `<div style="color:var(--text-muted);font-size:12px;padding:4px 6px">${t('schedule.no_calendars')}</div>`;
    host.onchange = (e) => {
      const cb = e.target.closest('input[data-key]');
      if (!cb) return;
      if (cb.checked) visibleKeys.add(cb.dataset.key); else visibleKeys.delete(cb.dataset.key);
      draw();
    };
  }
  document.getElementById('schedCalSearch').addEventListener('input', (e) => { calSearch = e.target.value; renderCalList(); });
  document.getElementById('schedRailBtn').onclick = () => { railOpen = !railOpen; writeStored(RAIL_STORAGE_KEY, railOpen ? '1' : '0'); renderToolbar(); };

  // ---------------------------------------------------------------- data
  const visibleEvents = () => allEvents.filter((ev) => visibleKeys.has(targetOf(ev).key));

  async function loadCalendar() {
    period = periodRange(effectiveView(), anchor);
    renderToolbar();
    // One request per period: all=1 (the server scopes to the caller's workspace) over exactly the
    // window this view draws. The rail filters client-side, so switching calendars never refetches.
    allEvents = await API(`/schedules/week?date=${ymd(period.fetchStart)}&all=1&days=${period.fetchDays}`);
    renderRailMini();
    renderCalList();
    draw();
  }

  function draw() {
    const ev = effectiveView();
    const timeGrid = document.getElementById('calendarScroll');
    const allDay = document.getElementById('schedAllDay');
    const month = document.getElementById('schedMonth');
    const strip = document.getElementById('dayStrip');
    const events = visibleEvents();
    month.style.display = ev === 'month' ? '' : 'none';
    timeGrid.style.display = ev === 'month' ? 'none' : '';
    allDay.style.display = ev === 'month' ? 'none' : '';
    strip.style.display = (ev === 'day' && isNarrow()) ? 'flex' : 'none';
    if (ev === 'month') drawMonth(events); else drawTimeGrid(events);
    if (strip.style.display === 'flex') drawDayStrip();

    const empty = document.getElementById('schedEmpty');
    if (!allEvents.length) empty.innerHTML = `<div class="sched-empty">${t('schedule.drag_hint')}</div>`;
    else if (!events.length && visibleKeys.size < calendars.length) empty.innerHTML = `<div class="sched-empty">${t('schedule.hidden_calendars_hint')}</div>`;
    else empty.innerHTML = '';
  }

  // Narrow screens: a strip of the week's days above the single-day grid.
  function drawDayStrip() {
    const strip = document.getElementById('dayStrip');
    const ws = periodRange('week', anchor).days;
    strip.innerHTML = ws.map((d) => `<button type="button" class="btn btn-sm${sameDay(d, anchor) ? ' on' : ''}" data-date="${ymd(d)}">${DAYS[d.getDay()]}<br>${d.getDate()}</button>`).join('');
    strip.onclick = (e) => { const b = e.target.closest('[data-date]'); if (!b) return; const [y, m, dd] = b.dataset.date.split('-').map(Number); setView(null, new Date(y, m - 1, dd)); };
  }

  // ---------------------------------------------------------------- time grid (day / work week / week)
  let nowTimer = null;
  function drawTimeGrid(events) {
    const days = period.days;
    const cal = document.getElementById('calendar');
    const today = startOfDay(new Date());
    cal.style.gridTemplateColumns = `52px repeat(${days.length},1fr)`;

    let html = '<div class="sched-corner"></div>';
    days.forEach((d, i) => {
      const cls = ['sched-daycol-head', sameDay(d, today) ? 'today' : '', (effectiveView() !== 'day' && sameDay(d, anchor)) ? 'selected' : ''].filter(Boolean).join(' ');
      html += `<div class="${cls}" data-head-day="${i}" role="button" tabindex="0">${DAYS[d.getDay()]}<br><span class="num">${d.getDate()}</span></div>`;
    });
    for (const h of HOURS) {
      html += `<div class="sched-hour-label">${h === 0 ? t('schedule.hour_12am') : h < 12 ? h + t('schedule.hour_am') : h === 12 ? t('schedule.hour_12pm') : (h - 12) + t('schedule.hour_pm')}</div>`;
      days.forEach((d, i) => {
        const work = WORK_DAYS.includes(d.getDay()) && h * 60 >= WORK_START_MIN && h * 60 < WORK_END_MIN;
        const off = !WORK_DAYS.includes(d.getDay());
        html += `<div class="sched-hour${work ? ' work' : ''}${off ? ' offday' : ''}" style="height:${HOUR_PX}px" data-hour="${h}" data-day="${i}"></div>`;
      });
    }
    cal.innerHTML = html;

    // All-day row: one cell per column, chips for whole-day windows.
    const allDayHost = document.getElementById('schedAllDay');
    allDayHost.style.gridTemplateColumns = `52px repeat(${days.length},1fr)`;
    const allDayCells = days.map(() => []);

    // Flatten to segments per column. An overnight window is two pieces on consecutive columns.
    const perCol = days.map(() => []);
    for (const ev of events) {
      const s = evStart(ev), e = evEnd(ev);
      const col = days.findIndex((d) => sameDay(d, s));
      if (col === -1) continue;
      const sMin = minsOf(s), eMin = minsOf(e);
      if (isAllDay(sMin, eMin)) { allDayCells[col].push(ev); continue; }
      for (const seg of splitAcrossMidnight(col, sMin, eMin)) {
        if (seg.dayIdx < days.length) perCol[seg.dayIdx].push({ ev, ...seg });
      }
    }
    allDayHost.innerHTML = `<div class="sched-allday-label">${t('schedule.all_day')}</div>` + allDayCells.map((list, i) => `<div class="sched-allday-cell" data-allday="${i}">${list.map((ev) => `<button type="button" class="sched-chip${ev.group_id ? ' group' : ''}" data-sched-id="${esc(ev.id)}" style="background:${colorOf(ev)}" title="${esc(labelOf(ev))}">${esc(targetOf(ev).name)} · ${esc(labelOf(ev))}</button>`).join('')}</div>`).join('');
    allDayHost.querySelectorAll('.sched-chip').forEach((chip) => {
      const ev = events.find((x) => String(x.id) === chip.dataset.schedId);
      chip.onclick = () => openPeek(ev, chip);
      chip.ondblclick = () => { closePopovers(); editSchedule(ev); };
    });

    // Pack each column so overlapping blocks sit side by side, then draw.
    perCol.forEach((segs, col) => {
      packColumns(segs);
      for (const seg of segs) {
        const { ev, startMin, endMin, continues, continued } = seg;
        const cell = cal.querySelector(`[data-hour="${Math.floor(startMin / 60)}"][data-day="${col}"]`);
        if (!cell) continue;
        const durationPx = minutesToPx(endMin - startMin);
        const block = document.createElement('div');
        block.className = `sched-block${ev.group_id ? ' group' : ''}${continues ? ' continues' : ''}${continued ? ' continued' : ''}`;
        const gap = 2, width = 100 / seg.cols;
        block.style.top = `${minutesToPx(startMin % 60)}px`;
        block.style.height = `${Math.max(18, durationPx)}px`;
        block.style.left = `calc(${width * seg.col}% + ${gap}px)`;
        block.style.width = `calc(${width}% - ${gap * 2}px)`;
        block.style.background = colorOf(ev);
        block.style.borderLeftColor = ev.color || 'rgba(0,0,0,.25)';
        const target = targetOf(ev);
        if (durationPx >= 34) {
          block.innerHTML = `<div class="who">${esc(target.name)}</div><div class="what">${esc(labelOf(ev))}</div>`;
        } else {
          block.textContent = `${target.name} · ${labelOf(ev)}`;
        }
        block.title = `${target.isGroup ? t('schedule.target_group') : t('schedule.target_device')}: ${target.name}\n${labelOf(ev)}\n${formatRange(minsOf(evStart(ev)), minsOf(evEnd(ev)))}`
          + ((continues || continued) ? `\n${t('schedule.overnight_note')}` : '')
          + `\n${t('schedule.tooltip_priority', { n: ev.priority })}`;
        block.dataset.schedId = ev.id;
        block.dataset.overnight = (continues || continued) ? '1' : '';
        block._ev = ev;
        if (durationPx >= 22) {
          const grip = document.createElement('div');
          grip.className = 'sched-resize-grip';
          block.appendChild(grip);
        }
        cell.appendChild(block);
      }
    });

    // Clicking a day header opens that day.
    cal.querySelectorAll('[data-head-day]').forEach((h) => {
      const go = () => setView('day', days[Number(h.dataset.headDay)]);
      h.onclick = go;
      h.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    });

    attachGridInteractions(cal);
    drawNowLine();
    clearInterval(nowTimer);
    nowTimer = setInterval(drawNowLine, 60 * 1000);

    // Open on the working day, not on midnight, and only on the first render of a layout so it
    // never yanks the view back while someone is scrolling.
    const scroller = document.getElementById('calendarScroll');
    const layout = `${effectiveView()}:${days.length}`;
    if (scroller && scroller.dataset.layout !== layout) {
      scroller.dataset.layout = layout;
      const earliest = events.reduce((min, ev) => Math.min(min, evStart(ev).getHours()), 24);
      scroller.scrollTop = Math.max(0, (earliest === 24 ? DEFAULT_SCROLL_HOUR : earliest) - 1) * HOUR_PX;
    }
  }

  // The red "now" line, in today's column, at the current minute. Redrawn each minute.
  function drawNowLine() {
    document.querySelectorAll('.sched-now').forEach((n) => n.remove());
    if (!period || effectiveView() === 'month') return;
    const now = new Date();
    const col = period.days.findIndex((d) => sameDay(d, now));
    if (col === -1) return;
    const cell = document.querySelector(`#calendar [data-hour="${now.getHours()}"][data-day="${col}"]`);
    if (!cell) return;
    const line = document.createElement('div');
    line.className = 'sched-now';
    line.style.top = `${minutesToPx(now.getMinutes())}px`;
    cell.appendChild(line);
  }

  // ---------------------------------------------------------------- month view
  function drawMonth(events) {
    const host = document.getElementById('schedMonth');
    const g = monthGrid(anchor);
    const today = startOfDay(new Date());
    const byDay = new Map();
    for (const ev of events) {
      const k = ymd(evStart(ev));
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(ev);
    }
    for (const list of byDay.values()) list.sort((a, b) => evStart(a) - evStart(b));
    const narrow = isNarrow();
    const pill = (ev) => `<button type="button" class="sched-pill${ev.group_id ? ' group' : ''}" data-sched-id="${esc(ev.id)}" style="background:${colorOf(ev)}" title="${esc(targetOf(ev).name)} · ${esc(labelOf(ev))}">`
      + `<span class="tm">${fmt12(minsOf(evStart(ev))).replace(':00', '')}</span><span class="lbl">${esc(labelOf(ev))}</span></button>`;
    host.innerHTML = DAYS.map((d) => `<div class="sched-month-dow">${d}</div>`).join('')
      + g.weeks.flat().map(({ date, inMonth }) => {
        const list = byDay.get(ymd(date)) || [];
        const max = narrow ? 4 : MONTH_PILLS;
        const shown = list.slice(0, max), extra = list.length - shown.length;
        const cls = ['sched-month-cell', inMonth ? '' : 'out', sameDay(date, today) ? 'today' : '', sameDay(date, anchor) ? 'selected' : ''].filter(Boolean).join(' ');
        return `<div class="${cls}" data-date="${ymd(date)}">
          <button type="button" class="sched-month-daynum" data-open-day="${ymd(date)}" aria-label="${fmtDate(date)}">${date.getDate()}</button>
          ${shown.map(pill).join('')}
          ${extra > 0 ? `<button type="button" class="sched-more" data-more="${ymd(date)}">${t('schedule.more_count', { n: extra })}</button>` : ''}
        </div>`;
      }).join('');

    const toDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
    host.onclick = (e) => {
      const more = e.target.closest('[data-more]');
      if (more) { openDayFlyout(toDate(more.dataset.more), byDay.get(more.dataset.more) || [], more); return; }
      const num = e.target.closest('[data-open-day]');
      if (num) { setView('day', toDate(num.dataset.openDay)); return; }
    };
    host.ondblclick = (e) => {
      if (e.target.closest('.sched-pill')) return;   // pills are handled by the pointer loop below
      const cell = e.target.closest('[data-date]');
      if (cell) openCompose(toDate(cell.dataset.date), 9 * 60, 10 * 60, cell.getBoundingClientRect());
    };
    attachMonthDrag(host, events);
  }

  // Drag a pill to another day, keeping its duration. A repeating pill follows its rule, so it is
  // refused with the same explanation the week grid gives.
  let monthDrag = null;
  function attachMonthDrag(host, events) {
    if (host.dataset.dragBound) return;
    host.dataset.dragBound = '1';
    host.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const pillEl = e.target.closest('.sched-pill');
      if (!pillEl) return;
      const ev = (visibleEvents()).find((x) => String(x.id) === pillEl.dataset.schedId);
      if (!ev) return;
      monthDrag = { ev, pillEl, origin: { x: e.clientX, y: e.clientY }, moved: false, armed: dragArmMode(e.pointerType) === 'immediate', over: null };
      if (!monthDrag.armed) {
        monthDrag.timer = setTimeout(() => { if (monthDrag) { monthDrag.armed = true; host.style.touchAction = 'none'; pillEl.classList.add('dragging'); } }, LONG_PRESS_MS);
      }
      host.setPointerCapture?.(e.pointerId);
    });
    host.addEventListener('pointermove', (e) => {
      if (!monthDrag) return;
      const travelled = isDrag(e.clientX - monthDrag.origin.x, e.clientY - monthDrag.origin.y);
      if (!monthDrag.armed) { if (travelled) { clearTimeout(monthDrag.timer); monthDrag = null; } return; }
      if (!monthDrag.moved) { if (!travelled) return; monthDrag.moved = true; monthDrag.pillEl.classList.add('dragging'); host.style.touchAction = 'none'; }
      const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-date]');
      host.querySelectorAll('.sched-month-cell.drop').forEach((c) => c.classList.remove('drop'));
      if (cell) { cell.classList.add('drop'); monthDrag.over = cell.dataset.date; }
    });
    const end = async (e) => {
      const st = monthDrag; monthDrag = null;
      if (!st) return;
      clearTimeout(st.timer);
      host.style.touchAction = '';
      st.pillEl.classList.remove('dragging');
      host.querySelectorAll('.sched-month-cell.drop').forEach((c) => c.classList.remove('drop'));
      try { host.releasePointerCapture?.(e.pointerId); } catch (_) { /* */ }
      if (!st.moved) {
        const now = Date.now();
        const twice = lastPress && lastPress.id === st.ev.id && now - lastPress.at < 400;
        lastPress = twice ? null : { id: st.ev.id, at: now };
        if (twice) { closePopovers(); editSchedule(st.ev); } else openPeek(st.ev, st.pillEl);
        return;
      }
      if (!st.over) return;
      const from = ymd(evStart(st.ev));
      if (st.over === from) return;
      if (!canMoveAcrossDays(st.ev)) { showToast(t('schedule.recurring_no_day_move'), 'info'); return; }
      const [y, m, d] = st.over.split('-').map(Number);
      const target = new Date(y, m - 1, d);
      const s = evStart(st.ev), en = evEnd(st.ev);
      const dayDelta = Math.round((startOfDay(target) - startOfDay(s)) / 86400000);
      const ns = new Date(s.getTime()); ns.setDate(ns.getDate() + dayDelta);
      const ne = new Date(en.getTime()); ne.setDate(ne.getDate() + dayDelta);
      try {
        await API(`/schedules/${st.ev.id}`, { method: 'PUT', body: JSON.stringify({ start_time: toLocalStamp(ns, minsOf(ns)), end_time: toLocalStamp(ne, minsOf(ne)) }) });
        showToast(t('schedule.toast.saved'), 'success');
      } catch (err) { showToast(err.message, 'error'); }
      loadCalendar();
    };
    host.addEventListener('pointerup', end);
    host.addEventListener('pointercancel', () => { const st = monthDrag; monthDrag = null; if (st) { clearTimeout(st.timer); st.pillEl.classList.remove('dragging'); } host.style.touchAction = ''; });
  }

  // ---------------------------------------------------------------- popovers
  let popover = null;
  let popoverDismiss = null;
  function closePopovers() {
    if (popover) { popover.remove(); popover = null; }
    if (popoverDismiss) { document.removeEventListener('pointerdown', popoverDismiss, true); popoverDismiss = null; }
  }
  function openPopover(html, anchorRect) {
    closePopovers();
    const pop = document.createElement('div');
    pop.className = 'sched-pop';
    pop.setAttribute('role', 'dialog');
    pop.innerHTML = html;
    document.body.appendChild(pop);
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let left, top;
    if (anchorRect) {
      left = anchorRect.right + 8; top = anchorRect.top;
      if (left + w > window.innerWidth - 8) left = anchorRect.left - w - 8;
      if (left < 8) left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - w - 8));
    } else {
      left = (window.innerWidth - w) / 2; top = 96;
    }
    if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
    pop.style.left = `${left}px`; pop.style.top = `${top}px`;
    popover = pop;
    popoverDismiss = (evt) => { if (popover && !popover.contains(evt.target)) closePopovers(); };
    setTimeout(() => { if (popover === pop) document.addEventListener('pointerdown', popoverDismiss, true); }, 0);
    (pop.querySelector('input, select') || pop.querySelector('[data-act="edit"], [data-act="open"], [data-act="save"]') || pop.querySelector('button:not(.btn-danger)') || pop).focus?.();
    return pop;
  }

  // Single click: what this is, when, for whom, whether it repeats. Edit or delete from here.
  function openPeek(ev, anchorEl) {
    const target = targetOf(ev);
    const s = evStart(ev), e = evEnd(ev);
    const what = [ev.playlist_name && `${t('schedule.playlist_override')}: ${ev.playlist_name}`, ev.layout_id && `${t('schedule.layout_override')}: ${(layouts.find((l) => l.id === ev.layout_id) || {}).name || ''}`, ev.content_name && `${t('schedule.content_label')}: ${ev.content_name}`].filter(Boolean);
    const until = ev.recurrence_end ? new Date(String(ev.recurrence_end).slice(0, 10) + 'T00:00:00') : null;
    const pop = openPopover(`
      <h3><span class="sw" style="background:${colorOf(ev)}"></span>${esc(labelOf(ev))}</h3>
      <div class="meta">
        ${esc(fmtDate(s, { weekday: 'short', month: 'short', day: 'numeric' }))} · ${esc(formatRange(minsOf(s), minsOf(e)))}<br>
        ${esc(target.isGroup ? t('schedule.target_group') : t('schedule.target_device'))}: ${esc(target.name)}<br>
        ${what.map((w) => esc(w) + '<br>').join('')}
        ${esc(recurrenceSentence(ev.recurrence, { startMin: minsOf(new Date(ev.start_time)), endMin: minsOf(new Date(ev.end_time)), until, startDate: new Date(ev.start_time) }))}
      </div>
      <div class="sched-pop-actions">
        <button type="button" class="btn btn-danger btn-sm left" data-act="delete">${t('schedule.peek_delete')}</button>
        <button type="button" class="btn btn-secondary btn-sm" data-act="close">${t('schedule.peek_close')}</button>
        <button type="button" class="btn btn-primary btn-sm" data-act="edit">${t('schedule.peek_edit')}</button>
      </div>`, anchorEl.getBoundingClientRect());
    pop.onclick = (evt) => {
      const b = evt.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'close') closePopovers();
      else if (b.dataset.act === 'edit') { closePopovers(); editSchedule(ev); }
      else if (b.dataset.act === 'delete') { closePopovers(); deleteSchedule(ev); }
    };
  }

  // The lightweight create: what, when, for whom, which playlist. "More details" hands the same
  // values to the full dialog.
  function openCompose(dayDate, startMin, endMin, anchorRect) {
    const hhmm = (m) => `${p2(Math.floor(m / 60) % 24)}:${p2(m % 60)}`;
    const opts = `<optgroup label="${t('schedule.calendars_screens')}">${devices.map((d) => `<option value="d:${esc(d.id)}">${esc(d.name)}</option>`).join('')}</optgroup>`
      + (groups.length ? `<optgroup label="${t('schedule.calendars_groups')}">${groups.map((g) => `<option value="g:${esc(g.id)}">${esc(g.name)}</option>`).join('')}</optgroup>` : '');
    const pop = openPopover(`
      <h3>${t('schedule.compose_title')}</h3>
      <div class="meta">${esc(t('schedule.compose_date', { date: fmtDate(dayDate, { weekday: 'short', month: 'short', day: 'numeric' }) }))}</div>
      <div class="row"><div><label>${t('schedule.title_label')}</label><input type="text" class="input" id="cmpTitle" placeholder="${t('schedule.title_placeholder')}"></div></div>
      <div class="row">
        <div><label>${t('schedule.start_time')}</label><input type="time" class="input" id="cmpStart" value="${hhmm(startMin)}"></div>
        <div><label>${t('schedule.end_time')}</label><input type="time" class="input" id="cmpEnd" value="${hhmm(endMin)}"></div>
      </div>
      <div class="row"><div><label>${t('schedule.compose_target')}</label><select class="input" id="cmpTarget">${opts}</select></div></div>
      <div class="row"><div><label>${t('schedule.compose_playlist')}</label><select class="input" id="cmpPlaylist"><option value="">${t('schedule.no_playlist_override')}</option>${playlists.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></div></div>
      <div class="sched-pop-actions">
        <button type="button" class="btn btn-secondary btn-sm left" data-act="more">${t('schedule.compose_more')}</button>
        <button type="button" class="btn btn-secondary btn-sm" data-act="close">${t('common.cancel')}</button>
        <button type="button" class="btn btn-primary btn-sm" data-act="save">${t('schedule.compose_save')}</button>
      </div>`, anchorRect);
    const readForm = () => {
      const tv = pop.querySelector('#cmpTarget').value;
      return {
        title: pop.querySelector('#cmpTitle').value, startMin: hhmmToMin(pop.querySelector('#cmpStart').value), endMin: hhmmToMin(pop.querySelector('#cmpEnd').value),
        isGroup: tv.startsWith('g:'), targetId: tv.slice(2), playlistId: pop.querySelector('#cmpPlaylist').value,
      };
    };
    const save = async () => {
      const f = readForm();
      if (!f.targetId) { showToast(t('schedule.toast.target_required'), 'error'); return; }
      const data = {
        title: f.title, playlist_id: f.playlistId || null,
        start_time: toLocalStamp(dayDate, f.startMin), end_time: toLocalStamp(dayDate, f.endMin),
        recurrence: null, recurrence_end: null, priority: 0, color: '#3B82F6',
      };
      if (f.isGroup) data.group_id = f.targetId; else data.device_id = f.targetId;
      try {
        await API('/schedules', { method: 'POST', body: JSON.stringify(data) });
        closePopovers();
        showToast(t('schedule.toast.saved'), 'success');
        loadCalendar();
      } catch (err) { showToast(err.message, 'error'); }
    };
    pop.onclick = (evt) => {
      const b = evt.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'close') closePopovers();
      else if (b.dataset.act === 'save') save();
      else if (b.dataset.act === 'more') {
        const f = readForm();
        closePopovers();
        openCreateAt(dayDate, f.startMin, f.endMin);
        document.getElementById('schedTitle').value = f.title;
        document.getElementById('schedPlaylist').value = f.playlistId;
        if (f.isGroup) { groupRadio.checked = true; groupSelect.value = f.targetId; } else { deviceRadio.checked = true; deviceSelect.value = f.targetId; }
        updateTargetVisibility(); updateTzNote();
      }
    };
    pop.addEventListener('keydown', (evt) => { if (evt.key === 'Enter' && evt.target.tagName === 'INPUT') { evt.preventDefault(); save(); } });
    pop.querySelector('#cmpTitle').focus();
  }

  // Month "+N more": the whole day, each entry opening its peek.
  function openDayFlyout(date, list, anchorEl) {
    const pop = openPopover(`
      <h3>${esc(t('schedule.day_flyout_title', { date: fmtDate(date, { weekday: 'short', month: 'short', day: 'numeric' }) }))}</h3>
      <div style="display:flex;flex-direction:column;gap:3px;max-height:50vh;overflow:auto">
        ${list.length ? list.map((ev) => `<button type="button" class="sched-pill${ev.group_id ? ' group' : ''}" data-sched-id="${esc(ev.id)}" style="background:${colorOf(ev)}"><span class="tm">${fmt12(minsOf(evStart(ev)))}</span><span class="lbl">${esc(targetOf(ev).name)} · ${esc(labelOf(ev))}</span></button>`).join('') : `<div class="meta">${t('schedule.day_flyout_empty')}</div>`}
      </div>
      <div class="sched-pop-actions">
        <button type="button" class="btn btn-secondary btn-sm" data-act="close">${t('schedule.peek_close')}</button>
        <button type="button" class="btn btn-primary btn-sm" data-act="open">${t('schedule.peek_open_day')}</button>
      </div>`, anchorEl.getBoundingClientRect());
    pop.onclick = (evt) => {
      const pillEl = evt.target.closest('.sched-pill');
      if (pillEl) { const ev = list.find((x) => String(x.id) === pillEl.dataset.schedId); if (ev) openPeek(ev, pillEl); return; }
      const b = evt.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'close') closePopovers();
      else if (b.dataset.act === 'open') setView('day', date);
    };
  }

  // Date label: a jump-to-date picker.
  document.getElementById('schedDateLabel').onclick = (e) => {
    if (popover && popover.dataset.kind === 'jump') { closePopovers(); return; }
    const pop = openPopover(`<div class="sched-mini-head"><button class="btn-icon" data-nav="-1" aria-label="${t('schedule.prev')}">&lsaquo;</button><span id="jumpLabel"></span><button class="btn-icon" data-nav="1" aria-label="${t('schedule.next')}">&rsaquo;</button></div><div class="sched-mini" id="jumpMini"></div>`, e.currentTarget.getBoundingClientRect());
    pop.dataset.kind = 'jump';
    let m = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const paint = () => { pop.querySelector('#jumpLabel').textContent = fmtDate(m, { month: 'long', year: 'numeric' }); renderMini(pop.querySelector('#jumpMini'), m, { onPick: (d) => { closePopovers(); setView(null, d); } }); };
    pop.addEventListener('click', (evt) => { const b = evt.target.closest('[data-nav]'); if (b) { m = stepAnchor('month', m, Number(b.dataset.nav)); paint(); } });
    paint();
  };

  // "This occurrence or the entire series?" Resolves 'this' | 'all' | null.
  function askSeriesScope() {
    const modal = document.getElementById('schedSeriesModal');
    return new Promise((resolve) => {
      const done = (v) => { modal.style.display = 'none'; modal.onclick = null; document.removeEventListener('keydown', onKey, true); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
      modal.onclick = (e) => { const b = e.target.closest('[data-scope]'); if (!b) return; done(b.dataset.scope === 'cancel' ? null : b.dataset.scope); };
      document.addEventListener('keydown', onKey, true);
      modal.style.display = 'flex';
      modal.querySelector('[data-scope="all"]').focus();
    });
  }

  // Apply a moved/resized window to a schedule, asking about the series where it repeats.
  async function commitDrag(ev, dayDate, range) {
    let scope = 'all';
    if (editsWholeSeries(ev)) {
      scope = await askSeriesScope();
      if (!scope) { loadCalendar(); return; }
    }
    try {
      if (scope === 'this') {
        // Split the series around this day using only fields the backend already has.
        const plan = planOccurrenceEdit(ev, evStart(ev), { date: dayDate, startMin: range.startMin, endMin: range.endMin });
        if (plan.update) await API(`/schedules/${ev.id}`, { method: 'PUT', body: JSON.stringify(plan.update) });
        for (const row of plan.create) await API('/schedules', { method: 'POST', body: JSON.stringify(row) });
        if (plan.delete) await API(`/schedules/${ev.id}`, { method: 'DELETE' });
        showToast(t('schedule.toast.occurrence_saved'), 'success');
      } else {
        // A series keeps its own start DATE and changes only its hours; re-anchoring it to the
        // dragged instance's day would silently drop every earlier occurrence. A one-off's day is
        // its date, so the dragged day is the new date.
        const base = editsWholeSeries(ev) ? new Date(ev.start_time) : dayDate;
        await API(`/schedules/${ev.id}`, { method: 'PUT', body: JSON.stringify({ start_time: toLocalStamp(base, range.startMin), end_time: toLocalStamp(base, range.endMin) }) });
        showToast(t('schedule.toast.saved'), 'success');
      }
    } catch (err) { showToast(err.message, 'error'); }
    loadCalendar();
  }

  // ---------------------------------------------------------------- direct manipulation (time grid)
  // drag empty space -> create (compose popover prefilled); drag a block -> move; drag its grip ->
  // resize. Committed on pointerup only. Touch arms by holding still first, or the page scroll
  // wins the gesture.
  let dragState = null;
  let ghostEl = null;
  let lastPress = null;   // {id, at} of the last block release, for double-click detection
  const dayColumnOf = (el) => { const c = el && el.closest('[data-day]'); return c ? Number(c.dataset.day) : null; };

  function gridMinutesFromEvent(e) {
    const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-hour]');
    const ref = cell || (dragState && dragState.refCell);
    if (!ref) return null;
    const r = ref.getBoundingClientRect();
    return Number(ref.dataset.hour) * 60 + pxToMinutes(e.clientY - r.top);
  }
  function showGhost(cal, dayIdx, startMin, endMin, label) {
    const host = cal.querySelector(`[data-hour="${Math.floor(startMin / 60)}"][data-day="${dayIdx}"]`);
    if (!host) return;
    if (!ghostEl) { ghostEl = document.createElement('div'); ghostEl.className = 'sched-ghost'; }
    ghostEl.style.top = `${minutesToPx(startMin % 60)}px`;
    ghostEl.style.height = `${Math.max(14, minutesToPx(endMin - startMin))}px`;
    ghostEl.textContent = label;
    host.appendChild(ghostEl);
  }
  const clearGhost = () => { if (ghostEl && ghostEl.parentNode) ghostEl.parentNode.removeChild(ghostEl); };

  function attachGridInteractions(cal) {
    // #calendar is the SAME element on every render; bind once or handlers stack.
    if (cal.dataset.interactionsBound) return;
    cal.dataset.interactionsBound = '1';
    cal.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const block = e.target.closest('[data-sched-id]');
      const cell = e.target.closest('[data-hour][data-day]');
      if (!cell) return;
      const startMin = gridMinutesFromEvent(e);
      if (startMin == null) return;
      const origin = { x: e.clientX, y: e.clientY };
      if (block && block._ev) {
        const ev = block._ev;
        if (block.dataset.overnight) { dragState = null; showToast(t('schedule.overnight_no_drag'), 'info'); return; }
        const evS = minsOf(evStart(ev)), evE = minsOf(evEnd(ev));
        dragState = { kind: e.target.classList.contains('sched-resize-grip') ? 'resize' : 'move', ev, block, refCell: cell, moved: false, origin, grabOffset: startMin - evS, evStart: evS, evEnd: evE, dayIdx: dayColumnOf(cell) };
      } else {
        dragState = { kind: 'create', anchorMin: startMin, refCell: cell, moved: false, origin, dayIdx: dayColumnOf(cell) };
      }
      dragState.armMode = dragArmMode(e.pointerType);
      if (dragState.armMode === 'longpress') {
        dragState.armed = false;
        dragState.longPressTimer = setTimeout(() => {
          if (!dragState) return;
          dragState.armed = true;
          cal.style.touchAction = 'none';
          if (dragState.block) dragState.block.style.opacity = '0.35';
          if (navigator.vibrate) { try { navigator.vibrate(10); } catch (_) { /* optional */ } }
        }, LONG_PRESS_MS);
      } else {
        dragState.armed = true;
      }
      cal.setPointerCapture?.(e.pointerId);
    });

    cal.addEventListener('pointermove', (e) => {
      if (!dragState) return;
      const travelled = isDrag(e.clientX - dragState.origin.x, e.clientY - dragState.origin.y);
      if (dragState.armMode === 'longpress' && !dragState.armed) {
        if (travelled) { clearTimeout(dragState.longPressTimer); dragState = null; clearGhost(); }
        return;
      }
      if (!dragState.moved) {
        if (!travelled) return;
        dragState.moved = true;
        closePopovers();
        cal.style.touchAction = 'none';
        cal.style.cursor = dragState.kind === 'resize' ? 'ns-resize' : 'grabbing';
        if (dragState.block) dragState.block.style.opacity = '0.35';
      }
      const now = gridMinutesFromEvent(e);
      if (now == null) return;
      let range, day = dragState.dayIdx;
      if (dragState.kind === 'create') range = rangeFromDrag(dragState.anchorMin, now);
      else if (dragState.kind === 'resize') range = resizeRange(dragState.evStart, now);
      else {
        range = moveRange(now - dragState.grabOffset, dragState.evEnd - dragState.evStart);
        const overDay = dayColumnOf(document.elementFromPoint(e.clientX, e.clientY) || dragState.refCell);
        if (overDay != null && canMoveAcrossDays(dragState.ev)) day = overDay;
      }
      dragState.pending = { range, day };
      clearGhost();
      showGhost(cal, day, range.startMin, range.endMin, formatRange(range.startMin, range.endMin));
    });

    const resetDragChrome = (st) => { cal.style.touchAction = ''; cal.style.cursor = ''; if (st && st.block) st.block.style.opacity = ''; };
    const finish = async (e) => {
      const st = dragState;
      dragState = null;
      clearGhost();
      if (st) clearTimeout(st.longPressTimer);
      resetDragChrome(st);
      try { cal.releasePointerCapture?.(e.pointerId); } catch (_) { /* */ }
      if (!st) return;
      const dayDate = period.days[st.dayIdx || 0];
      // A tap on empty space still means "put something here": on a phone it is the only create gesture.
      if (!st.moved && st.kind === 'create' && st.anchorMin != null) {
        const start = Math.floor(st.anchorMin / 15) * 15;
        openCompose(dayDate, start, Math.min(start + DEFAULT_NEW_MIN, DAY_MIN), st.refCell.getBoundingClientRect());
        return;
      }
      // A press on a block that never moved is a click. Handled HERE rather than with onclick,
      // because the pointer is captured to the grid and whether a click still reaches the block
      // afterwards depends on the browser. Two releases on the same block within 400ms are a
      // double-click and open the full dialog, like Outlook.
      if (!st.moved && st.block) {
        const now = Date.now();
        const twice = lastPress && lastPress.id === st.ev.id && now - lastPress.at < 400;
        lastPress = twice ? null : { id: st.ev.id, at: now };
        if (twice) { closePopovers(); editSchedule(st.ev); } else openPeek(st.ev, st.block);
        return;
      }
      if (!st.pending || !st.moved) return;
      const { range, day } = st.pending;
      const targetDate = period.days[day];
      if (st.kind === 'create') { openCompose(targetDate, range.startMin, range.endMin, st.refCell.getBoundingClientRect()); return; }
      await commitDrag(st.ev, targetDate, range);
    };
    cal.addEventListener('pointerup', finish);
    cal.addEventListener('pointercancel', () => { const st = dragState; dragState = null; clearGhost(); resetDragChrome(st); });

    cal.addEventListener('contextmenu', (e) => {
      const cell = e.target.closest('[data-hour][data-day]');
      if (!cell) return;
      e.preventDefault();
      const block = e.target.closest('[data-sched-id]');
      const minutes = gridMinutesFromEvent(e) ?? Number(cell.dataset.hour) * 60;
      showContextMenu(e.clientX, e.clientY, block && block._ev, period.days[dayColumnOf(cell) || 0], minutes);
    });
  }

  function showContextMenu(x, y, ev, dayDate, minutes) {
    closePopovers();
    document.querySelectorAll('.sched-ctx').forEach((n) => n.remove());
    const menu = document.createElement('div');
    menu.className = 'sched-ctx';
    menu.setAttribute('role', 'menu');
    menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:2000;min-width:170px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:4px;box-shadow:var(--shadow);font-size:13px`;
    const start = Math.floor(minutes / 15) * 15;
    const items = ev
      ? [[t('schedule.ctx_edit'), () => editSchedule(ev)], [t('schedule.ctx_duplicate'), () => duplicateSchedule(ev)], [t('schedule.ctx_delete'), () => deleteSchedule(ev)]]
      : [[t('schedule.ctx_new'), () => openCompose(dayDate, start, Math.min(start + 60, DAY_MIN), { left: x, right: x, top: y, bottom: y })]];
    items.forEach(([label, fn]) => {
      const b = document.createElement('button');
      b.type = 'button'; b.setAttribute('role', 'menuitem'); b.textContent = label;
      b.style.cssText = 'display:block;width:100%;text-align:left;padding:7px 10px;border-radius:var(--radius);cursor:pointer;color:var(--text-primary);background:transparent;border:0;font:inherit';
      b.onmouseenter = () => { b.style.background = 'var(--bg-card-hover)'; };
      b.onmouseleave = () => { b.style.background = ''; };
      b.onclick = () => { menu.remove(); fn(); };
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    menu.querySelector('button')?.focus();
    const close = (evt) => { if (!menu.contains(evt.target)) { menu.remove(); document.removeEventListener('pointerdown', close, true); } };
    setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
  }

  async function duplicateSchedule(ev) {
    try {
      await API('/schedules', { method: 'POST', body: JSON.stringify({
        device_id: ev.device_id || null, group_id: ev.group_id || null,
        content_id: ev.content_id || null, playlist_id: ev.playlist_id || null, layout_id: ev.layout_id || null,
        title: ev.title ? `${ev.title} (copy)` : null, start_time: ev.start_time, end_time: ev.end_time,
        recurrence: ev.recurrence || null, recurrence_end: ev.recurrence_end || null, priority: ev.priority || 0, color: ev.color || '#3B82F6',
      }) });
      showToast(t('schedule.toast.saved'), 'success');
    } catch (err) { showToast(err.message, 'error'); }
    loadCalendar();
  }

  async function deleteSchedule(ev) {
    if (!confirm(t('schedule.confirm_delete'))) return;
    try {
      await API(`/schedules/${ev.id}`, { method: 'DELETE' });
      showToast(t('schedule.toast.deleted'), 'success');
    } catch (err) { showToast(err.message, 'error'); }
    loadCalendar();
  }

  // ---------------------------------------------------------------- the full dialog
  // Open it already filled in with the slot that was drawn, so the gesture supplies the times and
  // the dialog only has to supply what it alone knows.
  function openCreateAt(dayDate, startMin, endMin) {
    const addBtn = document.getElementById('addScheduleBtn');
    if (!addBtn || typeof addBtn.onclick !== 'function') return;
    addBtn.onclick();
    const hhmm = (m) => `${p2(Math.floor(m / 60) % 24)}:${p2(m % 60)}`;
    document.getElementById('schedStart').value = hhmm(startMin);
    document.getElementById('schedEnd').value = hhmm(endMin);
    pendingCreateDate = dayDate;
    recurrenceStartDate = dayDate;
    syncRepeatUI();
  }

  function editSchedule(ev) {
    editingId = ev.id;
    // ⚠️ THE DATE OF THE SCHEDULE BEING EDITED. Save rebuilds start_time from this date plus the
    // HH:MM in the form; without it every edit moved the schedule to today. ev.start_time is the
    // SCHEDULE's own anchor, not the clicked occurrence, so editing a rule keeps its start date.
    pendingCreateDate = new Date(ev.start_time);
    recurrenceStartDate = new Date(ev.start_time);
    document.getElementById('schedModalTitle').textContent = t('schedule.edit_schedule');
    document.getElementById('schedPlaylist').value = ev.playlist_id || '';
    document.getElementById('schedLayout').value = ev.layout_id || '';
    document.getElementById('schedContent').value = ev.content_id || '';
    document.getElementById('schedTitle').value = ev.title || '';
    const start = new Date(ev.start_time), end = new Date(ev.end_time);
    document.getElementById('schedStart').value = `${p2(start.getHours())}:${p2(start.getMinutes())}`;
    document.getElementById('schedEnd').value = `${p2(end.getHours())}:${p2(end.getMinutes())}`;
    const endEl = document.getElementById('schedRepeatEnd');
    if (endEl) endEl.value = (ev.recurrence_end || '').slice(0, 10);
    applyRecurrence(ev.recurrence);
    document.getElementById('schedPriority').value = ev.priority || 0;
    document.getElementById('schedColor').value = ev.color || '#3B82F6';
    if (ev.group_id) { groupRadio.checked = true; groupSelect.value = ev.group_id; }
    else { deviceRadio.checked = true; deviceSelect.value = ev.device_id || (devices[0] && devices[0].id) || ''; }
    updateTargetVisibility();
    updateTzNote();
    document.getElementById('deleteScheduleBtn').style.display = '';
    document.getElementById('scheduleModal').style.display = 'flex';
  }

  document.getElementById('addScheduleBtn').onclick = () => {
    editingId = null;
    // Reset the date on OPEN, not on close: the inline dismissers cannot reach this scope, so a
    // date left over from a cancelled drag would otherwise stamp the next schedule.
    pendingCreateDate = null;
    recurrenceStartDate = anchor;
    document.getElementById('schedModalTitle').textContent = t('schedule.add_schedule');
    document.getElementById('schedTitle').value = '';
    document.getElementById('schedPlaylist').value = '';
    document.getElementById('schedLayout').value = '';
    document.getElementById('schedContent').value = '';
    document.getElementById('schedStart').value = '09:00';
    document.getElementById('schedEnd').value = '17:00';
    applyRecurrence('');
    document.querySelectorAll('.sched-day').forEach((el) => { el.checked = false; });
    const newEnd = document.getElementById('schedRepeatEnd');
    if (newEnd) newEnd.value = '';
    deviceRadio.checked = true;
    deviceSelect.value = (devices[0] && devices[0].id) || '';
    updateTargetVisibility();
    updateTzNote();
    document.getElementById('deleteScheduleBtn').style.display = 'none';
    syncRepeatUI();
    closePopovers();
    document.getElementById('scheduleModal').style.display = 'flex';
  };

  document.getElementById('deleteScheduleBtn').onclick = async () => {
    if (!editingId) return;
    if (!confirm(t('schedule.confirm_delete'))) return;
    try {
      await API(`/schedules/${editingId}`, { method: 'DELETE' });
      document.getElementById('scheduleModal').style.display = 'none';
      showToast(t('schedule.toast.deleted'), 'success');
      loadCalendar();
    } catch (err) { showToast(err.message, 'error'); }
  };

  document.getElementById('saveScheduleBtn').onclick = async () => {
    const isGroup = groupRadio.checked;
    const contentId = document.getElementById('schedContent').value;
    const startTime = document.getElementById('schedStart').value;
    const endTime = document.getElementById('schedEnd').value;
    if (isGroup && groups.length === 0) { showToast(t('schedule.toast.no_groups'), 'error'); return; }
    const targetId = isGroup ? groupSelect.value : deviceSelect.value;
    if (!targetId) { showToast(t('schedule.toast.target_required'), 'error'); return; }
    const playlistId = document.getElementById('schedPlaylist').value;
    const layoutId = document.getElementById('schedLayout').value;
    // The date a new schedule is stamped with: the day it was drawn on, or the one being edited,
    // else today. Local parts, never toISOString(), which is UTC and puts anyone west of Greenwich
    // on the previous day for part of their evening.
    const dref = pendingCreateDate || anchor || new Date();
    const today = `${dref.getFullYear()}-${String(dref.getMonth() + 1).padStart(2, '0')}-${String(dref.getDate()).padStart(2, '0')}`;
    pendingCreateDate = null;
    const data = {
      content_id: contentId || null, playlist_id: playlistId || null, layout_id: layoutId || null,
      title: document.getElementById('schedTitle').value,
      start_time: `${today}T${startTime}:00`, end_time: `${today}T${endTime}:00`,
      recurrence: readRecurrence(),
      recurrence_end: (document.getElementById('schedRepeatEnd')?.value || null),
      priority: parseInt(document.getElementById('schedPriority').value) || 0,
      color: document.getElementById('schedColor').value,
    };
    if (isGroup) data.group_id = targetId; else data.device_id = targetId;
    try {
      if (editingId) await API(`/schedules/${editingId}`, { method: 'PUT', body: JSON.stringify(data) });
      else await API('/schedules', { method: 'POST', body: JSON.stringify(data) });
      document.getElementById('scheduleModal').style.display = 'none';
      showToast(t('schedule.toast.saved'), 'success');
      loadCalendar();
    } catch (err) { showToast(err.message, 'error'); }
  };

  // ---------------------------------------------------------------- toolbar wiring + keyboard
  document.getElementById('schedToday').onclick = goToday;
  document.getElementById('schedPrev').onclick = () => step(-1);
  document.getElementById('schedNext').onclick = () => step(1);
  document.querySelectorAll('.sched-views button').forEach((b) => { b.onclick = () => setView(b.dataset.view); });

  const modalOpen = () => ['scheduleModal', 'schedSeriesModal'].some((id) => document.getElementById(id)?.style.display === 'flex');
  const onKey = (e) => {
    if (e.key === 'Escape') { if (popover) { closePopovers(); e.preventDefault(); } return; }
    if (modalOpen() || popover) return;
    const tag = (e.target && e.target.tagName) || '';
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || e.target?.isContentEditable || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 't') { e.preventDefault(); goToday(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (k === 'n' || k === 'c') { e.preventDefault(); openCompose(anchor, 9 * 60, 10 * 60, null); }
  };
  document.addEventListener('keydown', onKey);
  cleanupFns.push(() => document.removeEventListener('keydown', onKey));

  // Re-render across the narrow/wide boundary only, after the burst of resize events a rotation
  // fires has settled.
  let wasNarrow = isNarrow();
  let settleTimer = null;
  const onViewportChange = () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { const now = isNarrow(); if (now !== wasNarrow) { wasNarrow = now; loadCalendar(); } }, 150);
  };
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('orientationchange', onViewportChange);
  cleanupFns.push(() => {
    clearTimeout(settleTimer); clearInterval(nowTimer);
    window.removeEventListener('resize', onViewportChange);
    window.removeEventListener('orientationchange', onViewportChange);
    closePopovers();
    document.querySelectorAll('.sched-ctx').forEach((n) => n.remove());
    dragState = null; monthDrag = null;
  });

  loadCalendar();
}

export function cleanup() { while (cleanupFns.length) { try { cleanupFns.pop()(); } catch (_) { /* */ } } }
