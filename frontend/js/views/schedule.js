import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { t } from '../i18n.js';
import {
  HOUR_PX, pxToMinutes, minutesToPx, rangeFromDrag, moveRange, resizeRange,
  toLocalStamp, formatRange, canMoveAcrossDays, editsWholeSeries, isDrag,
  splitAcrossMidnight, crossesMidnight, canDragEvent,
  dragArmMode, LONG_PRESS_MS, DEFAULT_NEW_MIN,
} from '../lib/schedule-grid.js';

// A refused request must reject, not resolve.
//
// This helper used to end in `.then(r => r.json())`, so a 403/404/500 body resolved as an ordinary
// value and the surrounding try/catch was unreachable — every handler took the failure for success.
// Concretely: deleting a built-in layout template showed "Layout deleted" while the server had
// returned 403 and the template was still there, and a rejected platform-role change showed "Role
// updated" while the dropdown kept displaying a value the server refused (its revert lives only in
// the dead catch). The shared client in api.js has always thrown on !res.ok; these local copies did
// not. Same contract now, including the 401 session-expiry reload.
const API = (url, opts = {}) => fetch('/api' + url, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}`, ...opts.headers }, ...opts }).then(async (r) => {
  if (r.status === 401) { localStorage.removeItem('token'); window.location.reload(); throw new Error('Session expired'); }
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `Request failed (${r.status})`); }
  return r.json();
});

// Teardown registered during render (resize listener, etc). Declared here rather than beside
// cleanup() so it is initialised before any render can push to it.
const cleanupFns = [];
const HOURS = Array.from({ length: 24 }, (_, i) => i);
// Where the week view opens when nothing is scheduled yet — the start of a working day.
const DEFAULT_SCROLL_HOUR = 8;
// Below this the week grid stops being usable: seven columns in a phone-width window leaves
// ~50px each, too narrow to read a name or aim a finger at, and the horizontal scroll it forces
// fights the vertical drag. Narrow screens get ONE day at a time instead.
const NARROW_PX = 700;
const isNarrow = () => window.innerWidth < NARROW_PX;
let focusedDay = new Date().getDay();   // which single day a narrow screen is showing

function esc(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }

export async function render(container) {
  const [devices, content, groups, playlists, layoutsRaw] = await Promise.all([
    api.getDevices(),
    api.getContent(),
    api.getGroups(),
    api.getPlaylists(),
    API('/layouts'),
  ]);
  const layouts = (Array.isArray(layoutsRaw) ? layoutsRaw : []).filter(l => !l.is_template);

  const today = new Date();
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay());
  weekStart.setHours(0, 0, 0, 0);

  const DAYS = [
    t('schedule.day.sun'), t('schedule.day.mon'), t('schedule.day.tue'),
    t('schedule.day.wed'), t('schedule.day.thu'), t('schedule.day.fri'),
    t('schedule.day.sat'),
  ];

  container.innerHTML = `
    <div class="page-header">
      <div><h1>${t('schedule.title')} <span class="help-tip" data-tip="${t('schedule.help_tip')}">?</span></h1><div class="subtitle">${t('schedule.subtitle')}</div></div>
    </div>
    <div class="schedule-controls" style="display:flex;gap:12px;margin-bottom:16px;align-items:center;flex-wrap:wrap">
      <select id="schedDevice" class="input" style="width:220px;max-width:100%;background:var(--bg-input)">
        <option value="*">${t('schedule.all_screens')}</option>
        ${devices.map(d => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}
      </select>
      <button class="btn btn-secondary btn-sm" id="prevWeek">${t('schedule.prev_week')}</button>
      <span id="weekLabel" style="color:var(--text-secondary);font-size:13px"></span>
      <button class="btn btn-secondary btn-sm" id="nextWeek">${t('schedule.next_week')}</button>
      <button class="btn btn-primary btn-sm" id="addScheduleBtn">${t('schedule.add_schedule')}</button>
    </div>
    <div id="dayStrip" style="display:none;gap:4px;margin-bottom:10px;flex-wrap:wrap"></div>
    <!-- Legend: only meaningful in all-screens mode, where blocks from different targets
         share one grid. Hidden for a single screen so that view stays uncluttered. -->
    <div id="schedLegend" style="display:none;flex-wrap:wrap;gap:10px;margin:-6px 0 14px;font-size:12px"></div>
    <div id="calendarScroll" style="position:relative;overflow:auto;max-height:calc(100vh - 260px);border:1px solid var(--border);border-radius:var(--radius-lg)">
      <div id="calendar" style="display:grid;grid-template-columns:60px repeat(7,1fr);min-width:800px"></div>
    </div>

    <div class="modal-overlay" id="scheduleModal" style="display:none">
      <div class="modal" style="width:480px">
        <div class="modal-header"><h3 id="schedModalTitle">${t('schedule.add_schedule')}</h3>
          <button class="btn-icon" onclick="document.getElementById('scheduleModal').style.display='none'">
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
              ${devices.map(d => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}
            </select>
            <select id="schedGroupSelect" class="input" style="background:var(--bg-input);display:none">
              ${groups.map(g => `<option value="${esc(g.id)}">${esc(g.name)} (${t('schedule.group_devices_count', { n: g.device_count })})</option>`).join('')}
            </select>
            ${groups.length === 0 ? `<div id="schedNoGroups" style="display:none;color:var(--text-muted);font-size:12px;margin-top:4px">${t('schedule.no_groups_msg')}</div>` : ''}
            <div id="schedZoneNote" style="display:none;color:var(--text-muted);font-size:11px;margin-top:4px">${t('schedule.zone_note')}</div>
          </div>
          <div class="form-group"><label>${t('schedule.playlist_override')}</label>
            <select id="schedPlaylist" class="input" style="background:var(--bg-input)">
              <option value="">${t('schedule.no_playlist_override')}</option>
              ${playlists.map(p => `<option value="${esc(p.id)}">${esc(p.name)}${p.status === 'draft' ? ' ' + t('schedule.draft_suffix') : ''}</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label>${t('schedule.layout_override')}</label>
            <select id="schedLayout" class="input" style="background:var(--bg-input)">
              <option value="">${t('schedule.no_layout_override')}</option>
              ${layouts.map(l => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label>${t('schedule.content_label')} <span style="color:var(--text-muted);font-weight:normal;font-size:11px">${t('schedule.content_hint')}</span></label>
            <select id="schedContent" class="input" style="background:var(--bg-input)">
              <option value="">${t('schedule.content_none')}</option>
              ${content.map(c => `<option value="${esc(c.id)}">${esc(c.filename)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label>${t('schedule.title_label')}</label><input type="text" id="schedTitle" class="input" placeholder="${t('schedule.title_placeholder')}"></div>
          <div style="display:flex;gap:12px">
            <div class="form-group" style="flex:1"><label>${t('schedule.start_time')}</label><input type="time" id="schedStart" class="input" value="09:00"></div>
            <div class="form-group" style="flex:1"><label>${t('schedule.end_time')}</label><input type="time" id="schedEnd" class="input" value="17:00"></div>
          </div>
          <!-- Which clock these hours are on. The server resolves the target's zone and the
               player evaluates in it, but the user had no way to SEE that: hours typed as
               "9 to 5" silently became UTC, so a schedule could sit closed while its owner
               watched the screen. Stating the zone is the whole fix from the UI side. -->
          <div id="schedTzNote" style="font-size:12px;color:var(--text-muted);margin:-4px 0 12px"></div>
          <div class="form-group"><label>${t('schedule.repeat')}</label>
            <select id="schedRepeat" class="input" style="background:var(--bg-input)">
              <option value="">${t('schedule.repeat_none')}</option>
              <option value="FREQ=DAILY">${t('schedule.repeat_daily')}</option>
              <option value="FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR">${t('schedule.repeat_weekdays')}</option>
              <option value="FREQ=WEEKLY;BYDAY=SA,SU">${t('schedule.repeat_weekends')}</option>
              <option value="FREQ=WEEKLY">${t('schedule.repeat_weekly')}</option>
            </select>
          </div>
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
  `;

  let currentWeekStart = new Date(weekStart);
  let editingId = null;

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

  // State which clock the hours above are on. The server stores a new schedule in the
  // TARGET's zone (lib/device-timezone) and the player evaluates in that same zone — but
  // the dialog never said so. A user typing "09:00" reasonably assumes their own clock;
  // when the target sits in another zone the schedule is correct and still appears to do
  // nothing, because it opens hours later. Naming the zone is the fix from the UI side.
  const tzNote = document.getElementById('schedTzNote');
  function updateTzNote() {
    if (!tzNote) return;
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    let zone = null;
    if (!groupRadio.checked) {
      const d = devices.find(x => x.id === deviceSelect.value);
      zone = (d && d.timezone && d.timezone !== 'UTC' ? d.timezone : null) || (d && d.reported_timezone) || null;
    }
    if (!zone) { tzNote.textContent = t('schedule.tz_unknown'); return; }
    tzNote.textContent = (zone === local)
      ? t('schedule.tz_same').replace('{zone}', zone)
      : t('schedule.tz_device').replace('{zone}', zone).replace('{local}', local || '—');
  }
  deviceRadio.addEventListener('change', updateTzNote);
  groupRadio.addEventListener('change', updateTzNote);
  deviceSelect.addEventListener('change', updateTzNote);
  updateTzNote();

  function updateWeekLabel() {
    const end = new Date(currentWeekStart);
    end.setDate(end.getDate() + 6);
    document.getElementById('weekLabel').textContent =
      `${currentWeekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} - ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }

  // The selected calendar week is a local calendar concept, not an instant. Sending midnight
  // through toISOString() turns Sunday in a timezone east of UTC into Saturday for a US server,
  // which makes that server return the prior week. Keep the local Y-M-D intact instead.
  function calendarDateParam(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  // Stable colour per target, so the same screen is the same colour every week and
  // across reloads. Hashing the id beats cycling a palette by index, which reshuffles
  // whenever a device is added or removed.
  const TARGET_COLORS = ['#3B82F6','#8B5CF6','#EC4899','#F59E0B','#10B981','#06B6D4','#EF4444','#84CC16','#A855F7','#14B8A6'];
  function colorForTarget(key) {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return TARGET_COLORS[h % TARGET_COLORS.length];
  }
  // What an event is aimed at. Group schedules name the group; device schedules name the
  // device. In all-screens mode this is the thing the operator is actually scanning for.
  function targetOf(ev) {
    if (ev.group_id) return { key: 'g:' + ev.group_id, name: ev.group_name || t('schedule.target_group'), isGroup: true };
    return { key: 'd:' + (ev.device_id || '?'), name: ev.device_name || t('schedule.target_device'), isGroup: false };
  }

  async function loadCalendar() {
    const deviceId = document.getElementById('schedDevice').value;
    if (!deviceId) return;
    const allScreens = deviceId === '*';
    updateWeekLabel();

    // all=1 rather than a workspace id — the server scopes to the caller's own workspace.
    const scope = allScreens ? 'all=1' : `device_id=${encodeURIComponent(deviceId)}`;
    const events = await API(`/schedules/week?date=${calendarDateParam(currentWeekStart)}&${scope}`);

    const cal = document.getElementById('calendar');
    // Narrow screens render ONE day. Seven columns in a phone-width window leaves ~50px each —
    // too narrow to read a name or aim a finger at — and the horizontal scroll it forces fights
    // the vertical drag gesture.
    const narrow = isNarrow();
    const visibleDays = narrow ? [focusedDay] : [0, 1, 2, 3, 4, 5, 6];
    // The template must match how many columns are actually emitted, or the cells wrap or stretch.
    cal.style.gridTemplateColumns = `52px repeat(${visibleDays.length},1fr)`;
    cal.style.minWidth = narrow ? '0' : '800px';
    let html = '<div style="background:var(--bg-secondary);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:6"></div>';

    for (const d of visibleDays) {
      const date = new Date(currentWeekStart);
      date.setDate(date.getDate() + d);
      const isToday = date.toDateString() === new Date().toDateString();
      html += `<div style="padding:8px;text-align:center;background:var(--bg-secondary);position:sticky;top:0;z-index:6;border-bottom:1px solid var(--border);border-left:1px solid var(--border);
        ${isToday ? 'color:var(--accent);font-weight:600' : 'color:var(--text-secondary)'};font-size:12px">
        ${DAYS[d]}<br>${date.getDate()}
      </div>`;
    }

    for (const h of HOURS) {
      html += `<div style="padding:4px 8px;font-size:10px;color:var(--text-muted);border-bottom:1px solid var(--border);text-align:right">${h === 0 ? t('schedule.hour_12am') : h < 12 ? h + t('schedule.hour_am') : h === 12 ? t('schedule.hour_12pm') : (h - 12) + t('schedule.hour_pm')}</div>`;
      for (const d of visibleDays) {
        html += `<div style="position:relative;min-height:${HOUR_PX}px;height:${HOUR_PX}px;border-bottom:1px solid var(--border);border-left:1px solid var(--border);background:var(--bg-primary)" data-hour="${h}" data-day="${d}"></div>`;
      }
    }

    cal.innerHTML = html;

    const seenTargets = new Map();
    // One schedule can need TWO blocks: an overnight window (22:00–04:00) is drawn as the part
    // before midnight on its day and the part after it on the next. Flattening to segments first
    // means the drawing code below has a single shape to handle.
    const segments = [];
    events.forEach((ev) => {
      const start = new Date(ev.instance_start || ev.start_time);
      const end = new Date(ev.instance_end || ev.end_time);
      const sMin = start.getHours() * 60 + start.getMinutes();
      const eMin = end.getHours() * 60 + end.getMinutes();
      for (const seg of splitAcrossMidnight(start.getDay(), sMin, eMin)) segments.push({ ev, ...seg });
    });

    segments.forEach(({ ev, dayIdx, startMin, endMin, continues, continued }) => {
      const startHour = startMin / 60;
      const duration = (endMin - startMin) / 60;

      const cell = cal.querySelector(`[data-hour="${Math.floor(startHour)}"][data-day="${dayIdx}"]`);
      if (!cell) return;

      const isGroupSchedule = !!ev.group_id;
      const target = targetOf(ev);
      seenTargets.set(target.key, target);
      const block = document.createElement('div');
      const topOffset = (startHour - Math.floor(startHour)) * HOUR_PX;
      // In all-screens mode colour identifies WHO the block is for, so several targets share
      // one grid and stay tellable apart. On a single screen the schedule's own colour is
      // kept — there is only one target, so colour is free to mean something else.
      const bg = allScreens ? colorForTarget(target.key) : (ev.color || '#3B82F6');
      const tall = duration * HOUR_PX >= 34;
      block.style.cssText = `position:absolute;top:${topOffset}px;left:2px;right:2px;height:${Math.max(18, duration * HOUR_PX)}px;
        background:${bg};border-radius:3px;padding:2px 4px;font-size:10px;color:white;overflow:hidden;cursor:grab;z-index:1;opacity:0.92;
        line-height:1.25;${isGroupSchedule ? 'border:1.5px dashed rgba(255,255,255,0.65);' : ''}`;

      const label = ev.title || ev.playlist_name || ev.content_name || ev.widget_name || t('schedule.scheduled_label');
      if (allScreens && tall) {
        // Two lines when there is room: who it is for, then what plays. The target reads
        // first because that is what the eye is scanning the grid for.
        block.innerHTML = `<div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(target.name)}</div>`
          + `<div style="opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(label)}</div>`;
      } else {
        block.textContent = (allScreens || isGroupSchedule) ? `${target.name} \u00b7 ${label}` : label;
      }

      const kind = isGroupSchedule ? t('schedule.target_group') : t('schedule.target_device');
      // The tooltip names the WHOLE window, not the piece being hovered — the point of a tooltip
      // on an overnight block is to say it runs 10pm to 4am, which neither half shows alone.
      const whole = new Date(ev.instance_start || ev.start_time);
      const wholeEnd = new Date(ev.instance_end || ev.end_time);
      block.title = `${kind}: ${target.name}\n${label}\n${whole.toLocaleTimeString()} - ${wholeEnd.toLocaleTimeString()}`
        + ((continues || continued) ? `\n${t('schedule.overnight_note')}` : '')
        + `\n${t('schedule.tooltip_priority', { n: ev.priority })}`
        + (ev.timezone ? `\n${t('schedule.tz_same').replace('{zone}', ev.timezone)}` : '');
      // Visually join the two halves of an overnight schedule: square off the edge each one
      // continues across, so it reads as one window split by midnight rather than two schedules.
      if (continues) block.style.borderBottomLeftRadius = block.style.borderBottomRightRadius = '0';
      if (continued) block.style.borderTopLeftRadius = block.style.borderTopRightRadius = '0';
      block.dataset.schedId = ev.id;
      block.dataset.overnight = (continues || continued) ? '1' : '';
      block._ev = ev;
      block.onclick = (e) => { if (dragState && dragState.moved) return; editSchedule(ev); };
      // Bottom grip: the affordance that makes a block resizable rather than only movable.
      // Hidden on very short blocks, where a grip would cover the whole thing.
      if (duration * HOUR_PX >= 22) {
        const grip = document.createElement('div');
        grip.className = 'sched-resize-grip';
        grip.style.cssText = 'position:absolute;left:0;right:0;bottom:0;height:10px;cursor:ns-resize;'
          + 'background:linear-gradient(to bottom,transparent,rgba(0,0,0,.28));';
        block.appendChild(grip);
      }
      cell.appendChild(block);
    });

    // Day strip: only meaningful when the grid is showing a single day.
    const strip = document.getElementById('dayStrip');
    if (strip) {
      strip.style.display = narrow ? 'flex' : 'none';
      if (narrow) {
        strip.innerHTML = DAYS.map((d, i) => {
          const dt = new Date(currentWeekStart); dt.setDate(dt.getDate() + i);
          const on = i === focusedDay;
          return `<button class="btn btn-sm" data-day-pick="${i}" style="flex:1;min-width:40px;padding:6px 4px;font-size:11px;
            ${on ? 'background:var(--accent,#3B82F6);color:#fff;border-color:transparent' : ''}">${d}<br>${dt.getDate()}</button>`;
        }).join('');
        strip.querySelectorAll('[data-day-pick]').forEach((b) => {
          b.addEventListener('click', () => { focusedDay = Number(b.dataset.dayPick); loadCalendar(); });
        });
      }
    }

    attachGridInteractions(cal);

    // Open on the working day, not on midnight. A 24-hour grid that starts at 12am shows a new
    // user four hours of empty night and hides the hours anything is actually scheduled in.
    // Only on the first render, so it never yanks the view back while someone is scrolling.
    const scroller = document.getElementById('calendarScroll');
    if (scroller && (!scroller.dataset.scrolled || scroller.dataset.layout !== (narrow ? 'day' : 'week'))) {
      scroller.dataset.layout = narrow ? 'day' : 'week';
      scroller.dataset.scrolled = '1';
      // Earliest scheduled hour if there is one, else the start of a normal working day.
      const earliest = events.reduce((min, ev) => {
        const d = new Date(ev.instance_start || ev.start_time);
        return Math.min(min, d.getHours());
      }, 24);
      const target = Math.max(0, (earliest === 24 ? DEFAULT_SCROLL_HOUR : earliest) - 1);
      // Straight grid arithmetic rather than offsetTop: the scroll container is not a positioned
      // ancestor, so offsetTop is measured from the page body and carries the whole header stack
      // with it — which scrolled the view hours past where it was aimed.
      scroller.scrollTop = target * HOUR_PX;
    }

    // An empty grid teaches nothing on its own — it looks like a broken page rather than an
    // invitation. Say what to do, without blocking the gesture it is describing.
    document.querySelectorAll('.sched-empty-hint').forEach(n => n.remove());
    if (!events.length && scroller) {
      const hint = document.createElement('div');
      hint.className = 'sched-empty-hint';
      hint.textContent = t('schedule.drag_hint');
      hint.style.cssText = 'margin:0 0 8px;padding:8px 12px;border-radius:8px;'
        + 'background:var(--bg-secondary);border:1px solid var(--border);color:var(--text-muted);font-size:12px';
      scroller.parentElement?.insertBefore(hint, scroller);
    }

    // Legend — only in all-screens mode, where the grid mixes targets. Sorted so the order
    // is stable between reloads rather than following whatever the query happened to return.
    const legend = document.getElementById('schedLegend');
    if (legend) {
      const targets = [...seenTargets.values()].sort((a, b) => a.name.localeCompare(b.name));
      legend.style.display = (allScreens && targets.length) ? 'flex' : 'none';
      legend.innerHTML = targets.map(tg => `
        <span style="display:inline-flex;align-items:center;gap:6px;color:var(--text-secondary)">
          <span style="width:11px;height:11px;border-radius:3px;background:${colorForTarget(tg.key)};
            ${tg.isGroup ? 'border:1.5px dashed rgba(255,255,255,0.65);' : ''}"></span>${esc(tg.name)}
        </span>`).join('');
    }
  }

  // ==================== Direct manipulation (Outlook-style) ====================
  // The calendar was read-only: the only way to create or move anything was the dialog. On a week
  // grid that is the wrong instrument — the grid already shows exactly where a thing goes, so the
  // grid should be where you put it. Three gestures, all sharing one pointer loop:
  //   drag empty space  -> create (opens the dialog PREFILLED with the time you drew)
  //   drag a block      -> move
  //   drag a block grip -> resize the end
  //
  // A drag is committed on pointerup, never mid-move, so an accidental nudge costs nothing. The
  // click-to-edit handler is suppressed when a drag actually moved, or every drag would also open
  // the dialog on release.
  let dragState = null;
  let ghostEl = null;

  const dayColumnOf = (el) => { const c = el.closest('[data-day]'); return c ? Number(c.dataset.day) : null; };

  function gridMinutesFromEvent(e, cal) {
    // Absolute minutes-since-midnight from the pointer, using the hour cell under it as the datum
    // rather than the grid top — the header row and any borders would otherwise skew every value.
    const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-hour]');
    const ref = cell || (dragState && dragState.refCell);
    if (!ref) return null;
    const r = ref.getBoundingClientRect();
    return Number(ref.dataset.hour) * 60 + pxToMinutes(e.clientY - r.top);
  }

  function showGhost(cal, dayIdx, startMin, endMin, label) {
    const host = cal.querySelector(`[data-hour="${Math.floor(startMin / 60)}"][data-day="${dayIdx}"]`);
    if (!host) return;
    if (!ghostEl) {
      ghostEl = document.createElement('div');
      ghostEl.className = 'sched-ghost';
      ghostEl.style.cssText = 'position:absolute;left:2px;right:2px;border-radius:3px;z-index:5;pointer-events:none;'
        + 'background:var(--accent,#3B82F6);opacity:.55;color:#fff;font-size:10px;padding:2px 4px;line-height:1.2;'
        + 'border:1px solid rgba(255,255,255,.8);overflow:hidden';
    }
    ghostEl.style.top = `${minutesToPx(startMin - Math.floor(startMin / 60) * 60)}px`;
    ghostEl.style.height = `${Math.max(14, minutesToPx(endMin - startMin))}px`;
    ghostEl.textContent = label;
    host.appendChild(ghostEl);
  }
  function clearGhost() { if (ghostEl && ghostEl.parentNode) ghostEl.parentNode.removeChild(ghostEl); }

  function attachGridInteractions(cal) {
    // #calendar is the SAME element on every render — only its children are replaced — so
    // binding here per render stacked a full set of pointer handlers each time. Five weeks of
    // navigation meant five ghosts on a drag and five PUTs on drop. Bind once.
    if (cal.dataset.interactionsBound) return;
    cal.dataset.interactionsBound = '1';
    cal.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;                       // left button only; right opens the menu
      const block = e.target.closest('[data-sched-id]');
      const cell = e.target.closest('[data-hour][data-day]');
      if (!cell) return;
      const startMin = gridMinutesFromEvent(e, cal);
      if (startMin == null) return;

      const origin = { x: e.clientX, y: e.clientY };
      if (block && block._ev) {
        const ev = block._ev;
        // A drag can only describe a window inside one day, so dragging an overnight schedule
        // would clamp it into that day and silently destroy the wrap. Refuse, and say why.
        if (block.dataset.overnight) {
          dragState = null;
          showToast(t('schedule.overnight_no_drag'), 'info');
          return;
        }
        const s = new Date(ev.instance_start || ev.start_time);
        const en = new Date(ev.instance_end || ev.end_time);
        const evStart = s.getHours() * 60 + s.getMinutes();
        const evEnd = en.getHours() * 60 + en.getMinutes();
        dragState = {
          kind: e.target.classList.contains('sched-resize-grip') ? 'resize' : 'move',
          ev, block, refCell: cell, moved: false, origin,
          grabOffset: startMin - evStart,
          evStart, evEnd, dayIdx: dayColumnOf(cell),
        };
      } else {
        dragState = { kind: 'create', anchorMin: startMin, refCell: cell, moved: false, origin, dayIdx: dayColumnOf(cell) };
      }
      // A touchscreen cannot arm the way a mouse does. The browser decides at touch-START
      // whether this gesture scrolls the page; by the time a finger has moved far enough to look
      // like a drag, scrolling has already begun and the pointer stream is cancelled. So on touch
      // we wait for a HOLD, and only then take the gesture over. Everything else still scrolls
      // normally, which is what a phone user expects a calendar to do.
      dragState.armMode = dragArmMode(e.pointerType);
      if (dragState.armMode === 'longpress') {
        dragState.armed = false;
        dragState.longPressTimer = setTimeout(() => {
          if (!dragState) return;
          dragState.armed = true;
          cal.style.touchAction = 'none';       // taken over — now the page must NOT scroll
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
      // Ignore the jitter of an ordinary click. Until the pointer has actually travelled, this
      // is still a click and must stay one, or click-to-edit never fires.
      const travelled = isDrag(e.clientX - dragState.origin.x, e.clientY - dragState.origin.y);
      // Touch that moves BEFORE the hold completes is the user scrolling. Let go of it entirely
      // rather than fighting the browser for the gesture.
      if (dragState.armMode === 'longpress' && !dragState.armed) {
        if (travelled) { clearTimeout(dragState.longPressTimer); dragState = null; clearGhost(); }
        return;
      }
      if (!dragState.moved) {
        if (!travelled) return;
        dragState.moved = true;
        cal.style.touchAction = 'none';                 // stop a touch drag scrolling the page
        cal.style.cursor = dragState.kind === 'resize' ? 'ns-resize' : 'grabbing';
        if (dragState.block) dragState.block.style.opacity = '0.35';   // show what is being moved
      }
      const now = gridMinutesFromEvent(e, cal);
      if (now == null) return;
      let range, day = dragState.dayIdx;
      if (dragState.kind === 'create') {
        range = rangeFromDrag(dragState.anchorMin, now);
      } else if (dragState.kind === 'resize') {
        range = resizeRange(dragState.evStart, now);
      } else {
        range = moveRange(now - dragState.grabOffset, dragState.evEnd - dragState.evStart);
        // Sideways only where the day is a real date. A recurring instance's day comes from its
        // rule, so dragging it across columns would silently rewrite the recurrence.
        const overDay = dayColumnOf(document.elementFromPoint(e.clientX, e.clientY) || dragState.refCell);
        if (overDay != null && canMoveAcrossDays(dragState.ev)) day = overDay;
      }
      dragState.pending = { range, day };
      clearGhost();
      showGhost(cal, day, range.startMin, range.endMin, formatRange(range.startMin, range.endMin));
    });

    const resetDragChrome = (st) => {
      cal.style.touchAction = '';
      cal.style.cursor = '';
      if (st && st.block) st.block.style.opacity = '';
    };
    const finish = async (e) => {
      const st = dragState;
      dragState = null;
      clearGhost();
      if (st) clearTimeout(st.longPressTimer);
      resetDragChrome(st);
      try { cal.releasePointerCapture?.(e.pointerId); } catch (_) { /* already released */ }
      if (!st) return;
      // A tap or click on empty space with no drag still means "put something here" — and on a
      // phone it is the ONLY create gesture, since dragging out a range with a finger is awkward.
      if (!st.moved && st.kind === 'create' && st.anchorMin != null) {
        const d0 = new Date(currentWeekStart);
        d0.setDate(d0.getDate() + (st.dayIdx || 0));
        const start = Math.floor(st.anchorMin / 15) * 15;
        openCreateAt(d0, start, Math.min(start + DEFAULT_NEW_MIN, 24 * 60));
        return;
      }
      if (!st.pending || !st.moved) return;   // a tap on a block: let the click handler edit it
      const { range, day } = st.pending;
      const dayDate = new Date(currentWeekStart);
      dayDate.setDate(dayDate.getDate() + day);

      if (st.kind === 'create') {
        openCreateAt(dayDate, range.startMin, range.endMin);
        return;
      }
      if (editsWholeSeries(st.ev)
        && !confirm(t('schedule.confirm_series'))) {
        loadCalendar();
        return;
      }
      try {
        await API(`/schedules/${st.ev.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            start_time: toLocalStamp(dayDate, range.startMin),
            end_time: toLocalStamp(dayDate, range.endMin),
          }),
        });
        showToast(t('schedule.toast.saved'), 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
      loadCalendar();
    };
    cal.addEventListener('pointerup', finish);
    cal.addEventListener('pointercancel', () => { const st = dragState; dragState = null; clearGhost(); resetDragChrome(st); });

    // Right-click: act on what is under the pointer, like every calendar people already use.
    cal.addEventListener('contextmenu', (e) => {
      const cell = e.target.closest('[data-hour][data-day]');
      if (!cell) return;
      e.preventDefault();
      const block = e.target.closest('[data-sched-id]');
      const minutes = gridMinutesFromEvent(e, cal) ?? Number(cell.dataset.hour) * 60;
      const dayDate = new Date(currentWeekStart);
      dayDate.setDate(dayDate.getDate() + (dayColumnOf(cell) || 0));
      showContextMenu(e.clientX, e.clientY, block && block._ev, dayDate, minutes);
    });
  }

  function showContextMenu(x, y, ev, dayDate, minutes) {
    document.querySelectorAll('.sched-ctx').forEach(n => n.remove());
    const menu = document.createElement('div');
    menu.className = 'sched-ctx';
    menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:2000;min-width:170px;background:var(--bg-secondary,#1f2530);`
      + 'border:1px solid var(--border,#333);border-radius:6px;padding:4px;box-shadow:0 6px 24px rgba(0,0,0,.4);font-size:13px';
    const items = ev
      ? [[t('schedule.ctx_edit'), () => editSchedule(ev)],
         [t('schedule.ctx_duplicate'), () => duplicateSchedule(ev)],
         [t('schedule.ctx_delete'), () => deleteSchedule(ev)]]
      : [[t('schedule.ctx_new'), () => openCreateAt(dayDate, Math.floor(minutes / 15) * 15, Math.floor(minutes / 15) * 15 + 60)]];
    items.forEach(([label, fn]) => {
      const b = document.createElement('div');
      b.textContent = label;
      b.style.cssText = 'padding:7px 10px;border-radius:4px;cursor:pointer;color:var(--text-primary,#e6edf7)';
      b.onmouseenter = () => { b.style.background = 'var(--bg-primary,#151b2b)'; };
      b.onmouseleave = () => { b.style.background = ''; };
      b.onclick = () => { menu.remove(); fn(); };
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    const close = (evt) => { if (!menu.contains(evt.target)) { menu.remove(); document.removeEventListener('pointerdown', close, true); } };
    setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
  }

  async function duplicateSchedule(ev) {
    try {
      await API('/schedules', { method: 'POST', body: JSON.stringify({
        device_id: ev.device_id || null, group_id: ev.group_id || null,
        content_id: ev.content_id || null, playlist_id: ev.playlist_id || null, layout_id: ev.layout_id || null,
        title: ev.title ? `${ev.title} (copy)` : null,
        start_time: ev.start_time, end_time: ev.end_time,
        recurrence: ev.recurrence || null, priority: ev.priority || 0, color: ev.color || '#3B82F6',
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

  // Open the dialog already filled in with the slot that was drawn, so the gesture supplies the
  // times and the dialog only has to supply what it alone knows (which playlist, which target).
  function openCreateAt(dayDate, startMin, endMin) {
    // Reuses the Add Schedule button's own handler so the dialog resets exactly as it does for a
    // normal create. Guarded because a drag is a user gesture that must never throw: if that
    // button or its handler is missing, the drop should quietly do nothing rather than raise an
    // uncaught error in the middle of an interaction.
    const addBtn = document.getElementById('addScheduleBtn');
    if (!addBtn || typeof addBtn.onclick !== 'function') return;
    addBtn.onclick();
    const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const startEl = document.getElementById('schedStart');
    const endEl = document.getElementById('schedEnd');
    if (startEl) startEl.value = hhmm(startMin);
    if (endEl) endEl.value = hhmm(endMin);
    pendingCreateDate = dayDate;
  }
  let pendingCreateDate = null;

  function editSchedule(ev) {
    editingId = ev.id;
    document.getElementById('schedModalTitle').textContent = t('schedule.edit_schedule');
    document.getElementById('schedPlaylist').value = ev.playlist_id || '';
    document.getElementById('schedLayout').value = ev.layout_id || '';
    document.getElementById('schedContent').value = ev.content_id || '';
    document.getElementById('schedTitle').value = ev.title || '';
    const start = new Date(ev.start_time);
    const end = new Date(ev.end_time);
    document.getElementById('schedStart').value = `${String(start.getHours()).padStart(2,'0')}:${String(start.getMinutes()).padStart(2,'0')}`;
    document.getElementById('schedEnd').value = `${String(end.getHours()).padStart(2,'0')}:${String(end.getMinutes()).padStart(2,'0')}`;
    document.getElementById('schedRepeat').value = ev.recurrence || '';
    document.getElementById('schedPriority').value = ev.priority || 0;
    document.getElementById('schedColor').value = ev.color || '#3B82F6';

    if (ev.group_id) {
      groupRadio.checked = true;
      groupSelect.value = ev.group_id;
    } else {
      deviceRadio.checked = true;
      deviceSelect.value = ev.device_id || document.getElementById('schedDevice').value;
    }
    updateTargetVisibility();

    document.getElementById('deleteScheduleBtn').style.display = '';
    document.getElementById('scheduleModal').style.display = 'flex';
  }

  document.getElementById('addScheduleBtn').onclick = () => {
    editingId = null;
    document.getElementById('schedModalTitle').textContent = t('schedule.add_schedule');
    document.getElementById('schedTitle').value = '';
    document.getElementById('schedPlaylist').value = '';
    document.getElementById('schedLayout').value = '';
    document.getElementById('schedContent').value = '';
    deviceRadio.checked = true;
    deviceSelect.value = document.getElementById('schedDevice').value;
    updateTargetVisibility();
    document.getElementById('deleteScheduleBtn').style.display = 'none';
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
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  document.getElementById('saveScheduleBtn').onclick = async () => {
    const isGroup = groupRadio.checked;
    const contentId = document.getElementById('schedContent').value;
    const startTime = document.getElementById('schedStart').value;
    const endTime = document.getElementById('schedEnd').value;

    if (isGroup && groups.length === 0) {
      showToast(t('schedule.toast.no_groups'), 'error');
      return;
    }

    const targetId = isGroup ? groupSelect.value : deviceSelect.value;
    if (!targetId) {
      showToast(t('schedule.toast.target_required'), 'error');
      return;
    }

    const playlistId = document.getElementById('schedPlaylist').value;
    const layoutId = document.getElementById('schedLayout').value;

    // The date a new schedule is stamped with. A drag supplies the day it was drawn on;
    // otherwise it is today. Built from LOCAL parts, not toISOString(), which is UTC and puts
    // anyone west of Greenwich on the previous day for part of their evening.
    const dref = pendingCreateDate || new Date();
    const today = `${dref.getFullYear()}-${String(dref.getMonth() + 1).padStart(2, '0')}-${String(dref.getDate()).padStart(2, '0')}`;
    pendingCreateDate = null;
    const data = {
      content_id: contentId || null,
      playlist_id: playlistId || null,
      layout_id: layoutId || null,
      title: document.getElementById('schedTitle').value,
      start_time: `${today}T${startTime}:00`,
      end_time: `${today}T${endTime}:00`,
      recurrence: document.getElementById('schedRepeat').value || null,
      priority: parseInt(document.getElementById('schedPriority').value) || 0,
      color: document.getElementById('schedColor').value,
    };

    if (isGroup) {
      data.group_id = targetId;
    } else {
      data.device_id = targetId;
    }

    try {
      if (editingId) {
        await API(`/schedules/${editingId}`, { method: 'PUT', body: JSON.stringify(data) });
      } else {
        await API('/schedules', { method: 'POST', body: JSON.stringify(data) });
      }
      document.getElementById('scheduleModal').style.display = 'none';
      showToast(t('schedule.toast.saved'), 'success');
      loadCalendar();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  document.getElementById('schedDevice').onchange = loadCalendar;
  document.getElementById('prevWeek').onclick = () => { currentWeekStart.setDate(currentWeekStart.getDate() - 7); loadCalendar(); };
  document.getElementById('nextWeek').onclick = () => { currentWeekStart.setDate(currentWeekStart.getDate() + 7); loadCalendar(); };

  // Re-render across the narrow/wide boundary only — resizing within one layout must not throw
  // away a scroll position or an open drag for nothing.
  // Rotating a phone crosses the breakpoint in both directions: ~390px portrait is one day,
  // ~844px landscape is the full week. Rotation also fires several resize events in a burst, and
  // on iOS the dimensions are briefly the OLD ones when orientationchange arrives — so settle
  // first and then decide, rather than re-rendering against a size that is about to change again.
  let wasNarrow = isNarrow();
  let settleTimer = null;
  const onViewportChange = () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      const now = isNarrow();
      if (now !== wasNarrow) { wasNarrow = now; loadCalendar(); }
    }, 150);
  };
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('orientationchange', onViewportChange);
  cleanupFns.push(() => {
    clearTimeout(settleTimer);
    window.removeEventListener('resize', onViewportChange);
    window.removeEventListener('orientationchange', onViewportChange);
  });

  loadCalendar();
}

export function cleanup() { while (cleanupFns.length) { try { cleanupFns.pop()(); } catch (_) { /* */ } } }
