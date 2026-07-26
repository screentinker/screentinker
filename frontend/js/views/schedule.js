import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { t } from '../i18n.js';

const API = (url, opts = {}) => fetch('/api' + url, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}`, ...opts.headers }, ...opts }).then(r => r.json());

const HOURS = Array.from({ length: 24 }, (_, i) => i);

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
      <select id="schedDevice" class="input" style="width:200px;max-width:100%;background:var(--bg-input)">
        ${devices.map(d => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}
      </select>
      <button class="btn btn-secondary btn-sm" id="prevWeek">${t('schedule.prev_week')}</button>
      <span id="weekLabel" style="color:var(--text-secondary);font-size:13px"></span>
      <button class="btn btn-secondary btn-sm" id="nextWeek">${t('schedule.next_week')}</button>
      <button class="btn btn-primary btn-sm" id="addScheduleBtn">${t('schedule.add_schedule')}</button>
    </div>
    <div style="overflow-x:auto">
      <div id="calendar" style="display:grid;grid-template-columns:60px repeat(7,1fr);min-width:800px;border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden"></div>
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
          <div class="form-group"><label>${t('schedule.color')}</label><input type="color" id="schedColor" value="#e65c00" style="width:60px;height:32px;border:none;cursor:pointer"></div>
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

  function updateWeekLabel() {
    const end = new Date(currentWeekStart);
    end.setDate(end.getDate() + 6);
    document.getElementById('weekLabel').textContent =
      `${currentWeekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} - ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }

  async function loadCalendar() {
    const deviceId = document.getElementById('schedDevice').value;
    if (!deviceId) return;
    updateWeekLabel();

    const events = await API(`/schedules/week?date=${currentWeekStart.toISOString()}&device_id=${deviceId}`);

    const cal = document.getElementById('calendar');
    let html = '<div style="background:var(--bg-secondary);border-bottom:1px solid var(--border)"></div>';

    for (let d = 0; d < 7; d++) {
      const date = new Date(currentWeekStart);
      date.setDate(date.getDate() + d);
      const isToday = date.toDateString() === new Date().toDateString();
      html += `<div style="padding:8px;text-align:center;background:var(--bg-secondary);border-bottom:1px solid var(--border);border-left:1px solid var(--border);
        ${isToday ? 'color:var(--accent);font-weight:600' : 'color:var(--text-secondary)'};font-size:12px">
        ${DAYS[d]}<br>${date.getDate()}
      </div>`;
    }

    for (const h of HOURS) {
      html += `<div style="padding:4px 8px;font-size:10px;color:var(--text-muted);border-bottom:1px solid var(--border);text-align:right">${h === 0 ? t('schedule.hour_12am') : h < 12 ? h + t('schedule.hour_am') : h === 12 ? t('schedule.hour_12pm') : (h - 12) + t('schedule.hour_pm')}</div>`;
      for (let d = 0; d < 7; d++) {
        html += `<div style="position:relative;min-height:28px;border-bottom:1px solid var(--border);border-left:1px solid var(--border);background:var(--bg-primary)" data-hour="${h}" data-day="${d}"></div>`;
      }
    }

    cal.innerHTML = html;

    events.forEach(ev => {
      const start = new Date(ev.instance_start || ev.start_time);
      const end = new Date(ev.instance_end || ev.end_time);
      const dayIdx = start.getDay();
      const startHour = start.getHours() + start.getMinutes() / 60;
      const endHour = end.getHours() + end.getMinutes() / 60;
      const duration = endHour - startHour;

      const cell = cal.querySelector(`[data-hour="${Math.floor(startHour)}"][data-day="${dayIdx}"]`);
      if (!cell) return;

      const isGroupSchedule = !!ev.group_id;
      const block = document.createElement('div');
      const topOffset = (startHour - Math.floor(startHour)) * 28;
      block.style.cssText = `position:absolute;top:${topOffset}px;left:2px;right:2px;height:${Math.max(20, duration * 28)}px;
        background:${ev.color || '#e65c00'};border-radius:3px;padding:2px 4px;font-size:10px;color:white;overflow:hidden;cursor:pointer;z-index:1;opacity:0.85;
        ${isGroupSchedule ? 'border:1.5px dashed rgba(255,255,255,0.6);' : ''}`;

      const label = ev.title || ev.playlist_name || ev.content_name || ev.widget_name || t('schedule.scheduled_label');
      const prefix = isGroupSchedule ? `[${esc(ev.group_name || t('schedule.target_group'))}] ` : '';
      block.textContent = prefix + label;
      block.title = `${isGroupSchedule ? t('schedule.tooltip_group_prefix') + (ev.group_name || '') + '\n' : ''}${start.toLocaleTimeString()} - ${end.toLocaleTimeString()}\n${t('schedule.tooltip_priority', { n: ev.priority })}`;
      block.onclick = () => editSchedule(ev);
      cell.appendChild(block);
    });
  }

  function editSchedule(ev) {
    editingId = ev.id;
    document.getElementById('schedModalTitle').textContent = t('schedule.edit_schedule');
    document.getElementById('schedPlaylist').value = ev.playlist_id || '';
    document.getElementById('schedLayout').value = ev.layout_id || '';
    document.getElementById('schedContent').value = ev.content_id || '';
    document.getElementById('schedTitle').value = ev.title || '';
    const start = new Date(ev.start_time);
    const end = new Date(ev.end_time);
    document.getElementById('schedStart').value = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
    document.getElementById('schedEnd').value = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;
    document.getElementById('schedRepeat').value = ev.recurrence || '';
    document.getElementById('schedPriority').value = ev.priority || 0;
    document.getElementById('schedColor').value = ev.color || '#e65c00';

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
    if (!confirm(t('schedule.confirm_delete') || 'Delete this schedule?')) return;
    try {
      await API(`/schedules/${editingId}`, { method: 'DELETE' });
      document.getElementById('scheduleModal').style.display = 'none';
      showToast(t('schedule.toast.deleted') || 'Schedule deleted', 'success');
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

    const playlistId = document.getElementById('schedPlaylist').value;
    const layoutId = document.getElementById('schedLayout').value;

    const today = new Date().toISOString().split('T')[0];
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
      data.group_id = groupSelect.value;
    } else {
      data.device_id = deviceSelect.value;
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

  loadCalendar();
}

export function cleanup() { }
