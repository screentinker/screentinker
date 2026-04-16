import { api } from '../api.js';
import { showToast } from '../components/toast.js';

const API = (url, opts = {}) => fetch('/api' + url, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}`, ...opts.headers }, ...opts }).then(r => r.json());

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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
  const selectedDevice = devices[0]?.id || '';

  const today = new Date();
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay());
  weekStart.setHours(0, 0, 0, 0);

  container.innerHTML = `
    <div class="page-header">
      <div><h1>Schedule <span class="help-tip" data-tip="Visual weekly calendar for content scheduling. Click Add Schedule to create time slots. Set recurrence for repeating content. Higher priority overrides lower. Device-level schedules override group-level.">?</span></h1><div class="subtitle">Content scheduling calendar</div></div>
    </div>
    <div style="display:flex;gap:12px;margin-bottom:16px;align-items:center">
      <select id="schedDevice" class="input" style="width:200px;background:var(--bg-input)">
        ${devices.map(d => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}
      </select>
      <button class="btn btn-secondary btn-sm" id="prevWeek">&lt; Prev</button>
      <span id="weekLabel" style="color:var(--text-secondary);font-size:13px"></span>
      <button class="btn btn-secondary btn-sm" id="nextWeek">Next &gt;</button>
      <button class="btn btn-primary btn-sm" id="addScheduleBtn">Add Schedule</button>
    </div>
    <div style="overflow-x:auto">
      <div id="calendar" style="display:grid;grid-template-columns:60px repeat(7,1fr);min-width:800px;border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden"></div>
    </div>

    <!-- Add/Edit Schedule Modal -->
    <div class="modal-overlay" id="scheduleModal" style="display:none">
      <div class="modal" style="width:480px">
        <div class="modal-header"><h3 id="schedModalTitle">Add Schedule</h3>
          <button class="btn-icon" onclick="document.getElementById('scheduleModal').style.display='none'">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="modal-body">
          <div class="form-group"><label>Apply to</label>
            <div style="display:flex;gap:16px;margin-bottom:8px">
              <label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:13px">
                <input type="radio" name="schedTarget" value="device" checked id="schedTargetDevice"> Device
              </label>
              <label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:13px">
                <input type="radio" name="schedTarget" value="group" id="schedTargetGroup"> Group
              </label>
            </div>
            <select id="schedDeviceSelect" class="input" style="background:var(--bg-input)">
              ${devices.map(d => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}
            </select>
            <select id="schedGroupSelect" class="input" style="background:var(--bg-input);display:none">
              ${groups.map(g => `<option value="${esc(g.id)}">${esc(g.name)} (${g.device_count} devices)</option>`).join('')}
            </select>
            ${groups.length === 0 ? '<div id="schedNoGroups" style="display:none;color:var(--text-muted);font-size:12px;margin-top:4px">No groups created yet. Create groups in the Displays page.</div>' : ''}
            <div id="schedZoneNote" style="display:none;color:var(--text-muted);font-size:11px;margin-top:4px">Note: Zone-based schedules are layout-specific. Ensure all devices in the group use the same layout.</div>
          </div>
          <div class="form-group"><label>Playlist override</label>
            <select id="schedPlaylist" class="input" style="background:var(--bg-input)">
              <option value="">— No playlist override —</option>
              ${playlists.map(p => `<option value="${esc(p.id)}">${esc(p.name)}${p.status === 'draft' ? ' (draft)' : ''}</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label>Layout override</label>
            <select id="schedLayout" class="input" style="background:var(--bg-input)">
              <option value="">— No layout override —</option>
              ${layouts.map(l => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label>Content <span style="color:var(--text-muted);font-weight:normal;font-size:11px">(single item, optional)</span></label>
            <select id="schedContent" class="input" style="background:var(--bg-input)">
              <option value="">— None —</option>
              ${content.map(c => `<option value="${esc(c.id)}">${esc(c.filename)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label>Title (optional)</label><input type="text" id="schedTitle" class="input" placeholder="e.g., Morning Playlist"></div>
          <div style="display:flex;gap:12px">
            <div class="form-group" style="flex:1"><label>Start Time</label><input type="time" id="schedStart" class="input" value="09:00"></div>
            <div class="form-group" style="flex:1"><label>End Time</label><input type="time" id="schedEnd" class="input" value="17:00"></div>
          </div>
          <div class="form-group"><label>Repeat</label>
            <select id="schedRepeat" class="input" style="background:var(--bg-input)">
              <option value="">No repeat</option>
              <option value="FREQ=DAILY">Daily</option>
              <option value="FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR">Weekdays</option>
              <option value="FREQ=WEEKLY;BYDAY=SA,SU">Weekends</option>
              <option value="FREQ=WEEKLY">Weekly</option>
            </select>
          </div>
          <div class="form-group"><label>Priority</label><input type="number" id="schedPriority" class="input" value="0" min="0" max="100"></div>
          <div class="form-group"><label>Color</label><input type="color" id="schedColor" value="#3B82F6" style="width:60px;height:32px;border:none;cursor:pointer"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="document.getElementById('scheduleModal').style.display='none'">Cancel</button>
          <button class="btn btn-primary" id="saveScheduleBtn">Save</button>
        </div>
      </div>
    </div>
  `;

  let currentWeekStart = new Date(weekStart);
  let editingId = null;

  // Wire up target radio buttons
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
      `${currentWeekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }

  async function loadCalendar() {
    const deviceId = document.getElementById('schedDevice').value;
    if (!deviceId) return;
    updateWeekLabel();

    const events = await API(`/schedules/week?date=${currentWeekStart.toISOString()}&device_id=${deviceId}`);

    const cal = document.getElementById('calendar');
    let html = '<div style="background:var(--bg-secondary);border-bottom:1px solid var(--border)"></div>';

    // Day headers
    for (let d = 0; d < 7; d++) {
      const date = new Date(currentWeekStart);
      date.setDate(date.getDate() + d);
      const isToday = date.toDateString() === new Date().toDateString();
      html += `<div style="padding:8px;text-align:center;background:var(--bg-secondary);border-bottom:1px solid var(--border);border-left:1px solid var(--border);
        ${isToday ? 'color:var(--accent);font-weight:600' : 'color:var(--text-secondary)'};font-size:12px">
        ${DAYS[d]}<br>${date.getDate()}
      </div>`;
    }

    // Hour rows
    for (const h of HOURS) {
      html += `<div style="padding:4px 8px;font-size:10px;color:var(--text-muted);border-bottom:1px solid var(--border);text-align:right">${h === 0 ? '12am' : h < 12 ? h + 'am' : h === 12 ? '12pm' : (h - 12) + 'pm'}</div>`;
      for (let d = 0; d < 7; d++) {
        html += `<div style="position:relative;min-height:28px;border-bottom:1px solid var(--border);border-left:1px solid var(--border);background:var(--bg-primary)" data-hour="${h}" data-day="${d}"></div>`;
      }
    }

    cal.innerHTML = html;

    // Render events
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
        background:${ev.color || '#3B82F6'};border-radius:3px;padding:2px 4px;font-size:10px;color:white;overflow:hidden;cursor:pointer;z-index:1;opacity:0.85;
        ${isGroupSchedule ? 'border:1.5px dashed rgba(255,255,255,0.6);' : ''}`;

      const label = ev.title || ev.playlist_name || ev.content_name || ev.widget_name || 'Scheduled';
      const prefix = isGroupSchedule ? `[${esc(ev.group_name || 'Group')}] ` : '';
      block.textContent = prefix + label;
      block.title = `${isGroupSchedule ? 'Group: ' + (ev.group_name || '') + '\n' : ''}${start.toLocaleTimeString()} - ${end.toLocaleTimeString()}\nPriority: ${ev.priority}`;
      block.onclick = () => editSchedule(ev);
      cell.appendChild(block);
    });
  }

  function editSchedule(ev) {
    editingId = ev.id;
    document.getElementById('schedModalTitle').textContent = 'Edit Schedule';
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

    // Set target type
    if (ev.group_id) {
      groupRadio.checked = true;
      groupSelect.value = ev.group_id;
    } else {
      deviceRadio.checked = true;
      deviceSelect.value = ev.device_id || document.getElementById('schedDevice').value;
    }
    updateTargetVisibility();

    document.getElementById('scheduleModal').style.display = 'flex';
  }

  document.getElementById('addScheduleBtn').onclick = () => {
    editingId = null;
    document.getElementById('schedModalTitle').textContent = 'Add Schedule';
    document.getElementById('schedTitle').value = '';
    document.getElementById('schedPlaylist').value = '';
    document.getElementById('schedLayout').value = '';
    document.getElementById('schedContent').value = '';
    // Default to current device in the calendar selector
    deviceRadio.checked = true;
    deviceSelect.value = document.getElementById('schedDevice').value;
    updateTargetVisibility();
    document.getElementById('scheduleModal').style.display = 'flex';
  };

  document.getElementById('saveScheduleBtn').onclick = async () => {
    const isGroup = groupRadio.checked;
    const contentId = document.getElementById('schedContent').value;
    const startTime = document.getElementById('schedStart').value;
    const endTime = document.getElementById('schedEnd').value;

    if (isGroup && groups.length === 0) {
      showToast('No groups available. Create a group first.', 'error');
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
      showToast('Schedule saved', 'success');
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

export function cleanup() {}
