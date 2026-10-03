import { api, assertLocalCallAllowed } from '../api.js';
import { on, off, requestScreenshot } from '../socket.js';
import { showToast } from '../components/toast.js';
import { esc, livenessBadge } from '../utils.js';
import { t } from '../i18n.js';

const API = (url, opts = {}) => {
  // ⚠️ This helper bypasses api.js's routing, so it must ask the same question itself.
  assertLocalCallAllowed(url, opts.method);
  return fetch('/api' + url, {
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}`, ...opts.headers },
  ...opts,
}).then(r => r.json());
};

// Default dimensions for the canvas coordinate space (pixels). Screens added
// fresh start at 320x180 (16:9). The editor canvas itself renders at this
// natural scale so canvas-pixels == display-pixels.
const DEFAULT_SCREEN_W = 320;
const DEFAULT_SCREEN_H = 180;
const CANVAS_MIN_W = 1200;
const CANVAS_MIN_H = 700;
const CANVAS_PADDING = 200; // extra room beyond bounding box, in canvas units

// #236: how far a panel's own image has to be turned to come out upright on the wall — i.e. how
// far the panel itself is hung the other way. Degrees CLOCKWISE, matching the per-device
// orientation setting; the render rule lives in server/lib/wall-geometry.js.
//
// Before this existed the canvas was secretly FRAMEBUFFER space, so a customer with two portrait
// panels side by side had to stack them vertically here and pre-rotate every video. The canvas is
// now what it always looked like: the wall as the audience sees it.
const WALL_ROTATIONS = [0, 90, 180, 270];
const ROTATION_LABELS = { 0: 'Normal (0°)', 90: 'Turned left (90°)', 180: 'Upside down (180°)', 270: 'Turned right (270°)' };
// A panel already configured portrait is already hung sideways; carry that across so the operator
// doesn't have to say the same thing twice (and so the tile lands the right shape first time).
const ORIENTATION_TO_ROTATION = { 'landscape': 0, 'portrait': 90, 'landscape-flipped': 180, 'portrait-flipped': 270 };

// Mirrors rotatedFootprint() in server/lib/wall-geometry.js — kept tiny and local because the
// dashboard has no import path to the server lib.
function footprintFor(renderW, renderH, rotation) {
  return (rotation === 90 || rotation === 270) ? { w: renderH, h: renderW } : { w: renderW, h: renderH };
}

export async function render(container) {
  const hash = window.location.hash;
  if (hash.startsWith('#/wall/')) {
    const id = hash.split('#/wall/')[1];
    return renderWallEditor(container, id);
  }
  return renderList(container);
}

async function renderList(container) {
  container.innerHTML = `
    <div class="page-header">
      <div><h1>${t('wall.title')} <span class="help-tip" data-tip="${t('wall.help_tip')}">?</span></h1><div class="subtitle">${t('wall.subtitle')}</div></div>
      <button class="btn btn-primary" id="newWallBtn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        ${t('wall.new_wall')}
      </button>
    </div>
    <div class="content-grid" id="wallGrid"></div>
  `;

  document.getElementById('newWallBtn').onclick = async () => {
    const name = prompt(t('wall.prompt_name'));
    if (!name) return;
    const wall = await API('/walls', { method: 'POST', body: JSON.stringify({ name }) });
    window.location.hash = `#/wall/${wall.id}`;
  };

  try {
    const walls = await API('/walls');
    const grid = document.getElementById('wallGrid');

    if (!walls.length) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>${t('wall.empty_title')}</h3><p>${t('wall.empty_desc')}</p></div>`;
      return;
    }

    grid.innerHTML = walls.map(w => `
      <div class="content-item" style="cursor:pointer" onclick="window.location.hash='#/wall/${w.id}'">
        <div class="content-item-preview" style="display:flex;align-items:center;justify-content:center;background:var(--bg-primary)">
          <div style="display:grid;grid-template-columns:repeat(${w.grid_cols},1fr);gap:3px;width:60%;aspect-ratio:${w.grid_cols}/${w.grid_rows}">
            ${Array.from({ length: w.grid_cols * w.grid_rows }, (_, i) => {
              const row = Math.floor(i / w.grid_cols);
              const col = i % w.grid_cols;
              const dev = w.devices?.find(d => d.grid_col === col && d.grid_row === row);
              return `<div style="background:${dev ? 'rgba(59,130,246,0.3)' : 'var(--bg-card)'};border:1px solid ${dev ? 'var(--accent)' : 'var(--border)'};border-radius:2px;display:flex;align-items:center;justify-content:center;font-size:8px;color:var(--text-muted);aspect-ratio:16/9">${dev?.device_name?.slice(0, 6) || ''}</div>`;
            }).join('')}
          </div>
        </div>
        <div class="content-item-body">
          <div class="content-item-name">${esc(w.name)}</div>
          <div class="content-item-size">${t('wall.grid_summary', { cols: w.grid_cols, rows: w.grid_rows, n: w.devices?.length || 0 })}</div>
        </div>
      </div>
    `).join('');
  } catch (err) { showToast(err.message, 'error'); }
}

// ============================================================
// Free-form canvas wall editor
// ============================================================
async function renderWallEditor(container, wallId) {
  let wall, devices, playlists;
  try {
    [wall, devices, playlists] = await Promise.all([
      API(`/walls/${wallId}`),
      api.getDevices(),
      api.getPlaylists(),
    ]);
  } catch { container.innerHTML = `<div class="empty-state"><h3>${t('wall.not_found')}</h3></div>`; return; }

  // Local state — server-roundtripped on Save. Backfill from grid math when
  // canvas_* columns aren't populated (fresh walls or pre-canvas walls).
  const baseW = DEFAULT_SCREEN_W;
  const baseH = DEFAULT_SCREEN_H;
  const bezelH = wall.bezel_h_mm || 0;
  const bezelV = wall.bezel_v_mm || 0;

  const deviceById = (id) => devices.find(d => d.id === id);
  // #14: a freshly-added screen's canvas size defaults to the device's RENDER resolution
  // (what it actually draws) instead of a fixed 320x180 — so a wall of 1080p panels looks
  // 1080p and a rotated panel that renders 1332x800 lands at 1332x800. Falls back to the
  // 320x180 default when the device hasn't reported a render size yet.
  const renderSizeFor = (id) => {
    const d = deviceById(id);
    if (d && d.render_width > 0 && d.render_height > 0) return { w: d.render_width, h: d.render_height };
    return { w: DEFAULT_SCREEN_W, h: DEFAULT_SCREEN_H };
  };
  // #236: the tile is the panel's footprint ON THE WALL, so a sideways-hung panel is a tall tile.
  const footprintOnWall = (id, rotation) => {
    const r = renderSizeFor(id);
    return footprintFor(r.w, r.h, rotation);
  };
  // A device already set to portrait is already hung sideways — start it there rather than making
  // the operator discover the rotation control after the wall comes out wrong.
  const defaultRotationFor = (id) => ORIENTATION_TO_ROTATION[deviceById(id)?.orientation] || 0;
  // When the panel's physical resolution differs from what it renders (rotated mount:
  // the box reports 800x1332 but draws 1332x800), the tile size can look "wrong". Return a
  // short note making explicit that the tile is sized to the RENDER surface, not the panel.
  const renderNoteFor = (id) => {
    const d = deviceById(id);
    if (!d || !d.render_width || !d.render_height) return '';
    const sw = d.screen_width, sh = d.screen_height;
    if (sw && sh && (sw !== d.render_width || sh !== d.render_height)) {
      return t('wall.render_note', { render: `${d.render_width}×${d.render_height}`, panel: `${sw}×${sh}` });
    }
    return '';
  };

  let screens = (wall.devices || []).map(d => ({
    device_id: d.device_id,
    device_name: d.device_name,
    device_status: d.device_status,
    grid_col: d.grid_col,
    grid_row: d.grid_row,
    rotation: d.rotation || 0,
    x: d.canvas_x ?? (d.grid_col * (baseW + bezelH)),
    y: d.canvas_y ?? (d.grid_row * (baseH + bezelV)),
    // Backfill sizes as the panel's footprint at its saved rotation. Every wall in the field is
    // rotation 0, where this is exactly the old expression — so nothing existing moves.
    w: d.canvas_width ?? footprintOnWall(d.device_id, d.rotation || 0).w,
    h: d.canvas_height ?? footprintOnWall(d.device_id, d.rotation || 0).h,
  }));

  // Default player covers the bounding box of all screens; if there are no
  // screens yet, player stays at 0,0 with default screen size.
  let player;
  if (wall.player_x !== null && wall.player_x !== undefined) {
    player = { x: wall.player_x, y: wall.player_y, w: wall.player_width, h: wall.player_height };
  } else if (screens.length > 0) {
    const b = boundsOf(screens);
    player = { x: b.x, y: b.y, w: b.w, h: b.h };
  } else {
    player = { x: 0, y: 0, w: baseW, h: baseH };
  }

  let dirty = false;
  function markDirty() {
    dirty = true;
    const btn = document.getElementById('saveLayoutBtn');
    if (btn) { btn.disabled = false; btn.classList.add('btn-primary'); }
  }

  // Selection state for the fine-position panel + arrow-key nudge. One rect
  // at a time: either a screen (by device_id) or the player.
  // null when nothing is selected.
  let selected = null;
  function getSelectedRect() {
    if (!selected) return null;
    if (selected.type === 'player') return player;
    return screens.find(s => s.device_id === selected.device_id) || null;
  }
  function selectScreen(deviceId) {
    selected = { type: 'screen', device_id: deviceId };
    applySelectionClasses();
    renderSelectionPanel();
  }
  function selectPlayer() {
    selected = { type: 'player' };
    applySelectionClasses();
    renderSelectionPanel();
  }
  function applySelectionClasses() {
    canvas.querySelectorAll('.selected').forEach(e => e.classList.remove('selected'));
    if (!selected) return;
    if (selected.type === 'player') canvas.querySelector('.wall-player')?.classList.add('selected');
    else {
      const el = canvas.querySelector(`.wall-screen[data-device-id="${CSS.escape(selected.device_id)}"]`);
      if (el) el.classList.add('selected');
    }
  }

  function getUnassigned() {
    const inThisWall = new Set(screens.map(s => s.device_id));
    return devices.filter(d => !d.wall_id && !inThisWall.has(d.id));
  }

  container.innerHTML = `
    <a href="#/walls" class="back-link" style="display:inline-flex;align-items:center;gap:6px;color:var(--text-secondary);margin-bottom:12px;font-size:13px">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
      ${t('wall.back')}
    </a>
    <div class="page-header" style="margin-bottom:12px">
      <h1 style="display:flex;align-items:center;gap:10px">
        <span id="wallTitleText">${esc(wall.name)}</span>
        <button class="btn btn-sm" id="renameWallBtn" title="${t('wall.rename')}" style="padding:2px 8px;font-size:12px">✎</button>
      </h1>
      <div style="display:flex;gap:8px">
        <button class="btn btn-sm" id="centerViewBtn" title="Re-center and fit content to the viewport">Center</button>
        <button class="btn btn-sm" id="autoArrangeBtn" title="Lay out screens in a grid using the columns/rows/bezel below">Auto-arrange</button>
        <button class="btn btn-sm" id="fitPlayerBtn" title="Snap the player rect to the bounding box of all screens">Fit player to screens</button>
        <button class="btn btn-sm" id="saveLayoutBtn" disabled>Save layout</button>
        <button class="btn btn-danger btn-sm" id="deleteWallBtn">${t('wall.delete_wall')}</button>
      </div>
    </div>

    <div style="display:flex;gap:16px;align-items:flex-start">
      <div style="flex:1;min-width:0">
        <div id="canvasViewport" class="wall-viewport" style="border:1px solid var(--border);border-radius:var(--radius-lg);height:75vh;min-height:560px">
          <div id="wallCanvas" class="wall-canvas"></div>
          <div class="wall-zoom-readout" id="zoomReadout">100%</div>
        </div>
        <div style="display:flex;gap:12px;margin-top:12px;align-items:center;flex-wrap:wrap">
          <div class="form-group" style="margin:0"><label style="font-size:11px;color:var(--text-muted)">${t('wall.columns')}</label><input type="number" id="gridCols" class="input" value="${wall.grid_cols}" min="1" max="20" style="width:70px"></div>
          <div class="form-group" style="margin:0"><label style="font-size:11px;color:var(--text-muted)">${t('wall.rows')}</label><input type="number" id="gridRows" class="input" value="${wall.grid_rows}" min="1" max="20" style="width:70px"></div>
          <div class="form-group" style="margin:0"><label style="font-size:11px;color:var(--text-muted)">${t('wall.h_bezel')}</label><input type="number" id="bezelH" class="input" value="${Math.round(wall.bezel_h_mm)}" min="0" step="1" style="width:80px"></div>
          <div class="form-group" style="margin:0"><label style="font-size:11px;color:var(--text-muted)">${t('wall.v_bezel')}</label><input type="number" id="bezelV" class="input" value="${Math.round(wall.bezel_v_mm)}" min="0" step="1" style="width:80px"></div>
          <span style="font-size:11px;color:var(--text-muted);max-width:340px">Cols/rows/bezel are used by Auto-arrange. Drag freely on the canvas to override.</span>
        </div>
        <div style="margin-top:16px">
          <h3 style="font-size:14px;margin:0 0 8px">${t('wall.playlist')}</h3>
          <select id="wallPlaylist" class="input" style="width:300px;background:var(--bg-input)">
            <option value="">${t('wall.no_playlist')}</option>
            ${(playlists || []).map(p => `<option value="${esc(p.id)}" ${p.id === wall.playlist_id ? 'selected' : ''}>${esc(p.name)}${p.status === 'draft' ? ' (draft)' : ''}</option>`).join('')}
          </select>
          <button class="btn btn-primary btn-sm" id="setPlaylistBtn" style="margin-left:8px">${t('wall.set_playlist')}</button>
        </div>

        <!-- #235: a wall used to swallow its members whole — joining one removed the device's card
             from Displays, so an operator could not see that one panel of a four-panel wall had
             dropped off, and the only way to check a single screen was to pull it out of the wall
             (which re-syncs the live wall) and put it back. Panel state and a way through to the
             device live here now. -->
        <div style="margin-top:20px">
          <h3 style="font-size:14px;margin:0 0 8px;display:flex;align-items:center;gap:10px">
            Panels
            <span id="wallPanelSummary" style="font-size:12px;font-weight:400;color:var(--text-muted)"></span>
          </h3>
          <div id="wallPanelStatus"></div>
        </div>
      </div>

      <div style="width:260px;flex-shrink:0">
        <div id="selectionPanel" class="wall-selection-panel" style="margin-bottom:14px"></div>
        <h3 style="font-size:14px;margin-bottom:6px">${t('wall.available_displays')}</h3>
        <p style="color:var(--text-muted);font-size:11px;margin:0 0 8px">Drag onto the canvas to add. Use the ✕ on a tile to remove.</p>
        <div id="availableDevices" style="min-height:60px;padding:6px;border:1px dashed var(--border);border-radius:8px"></div>
        <div class="info-card" style="margin-top:14px;padding:10px;font-size:12px;line-height:1.55">
          <strong style="font-size:12px">How it works</strong>
          <ul style="margin:6px 0 0 14px;padding:0;color:var(--text-secondary)">
            <li>This canvas is the wall <strong>as the audience sees it</strong>. Arrange the
                rectangles to match the physical layout.</li>
            <li>Each rectangle is a physical screen.</li>
            <li>The blue dashed rectangle is the player window — content plays inside this rect.</li>
            <li>Each screen shows only the part of the player that overlaps it.</li>
            <li>Panel hung sideways? Select it and set <em>How this panel is mounted</em> — the
                tile turns to match and the content is rotated for you.</li>
            <li>Drag corners to resize, drag the body to move.</li>
          </ul>
        </div>
      </div>
    </div>
  `;

  const canvas = document.getElementById('wallCanvas');

  function renderAll() {
    canvas.innerHTML = '';
    canvas.appendChild(renderPlayerEl());
    for (const s of screens) canvas.appendChild(renderScreenEl(s));
    updateOverlapsAll();
    renderSidebar();
    renderPanelStatus();
    applySelectionClasses();
    renderSelectionPanel();
    applyTransform();
  }

  // Render the fine-position panel: numeric x/y/w/h inputs for the selected
  // rect plus the arrow-key hint. Two-way bound — typing into inputs moves
  // the rect; dragging the rect updates the inputs in place (without
  // rebuilding the DOM, so focus survives a drag).
  function renderSelectionPanel() {
    const panel = document.getElementById('selectionPanel');
    if (!panel) return;
    const rect = getSelectedRect();
    if (!rect) {
      panel.innerHTML = `
        <div class="info-card" style="padding:10px;font-size:12px">
          <strong style="font-size:12px">Fine position</strong>
          <p style="margin:4px 0 0;color:var(--text-muted);font-size:11px">Click a tile or the player to dial in exact pixel positions.</p>
        </div>`;
      return;
    }
    const isPlayer = selected.type === 'player';
    const label = isPlayer ? 'Player rect' : (rect.device_name || 'Screen');
    panel.innerHTML = `
      <div class="info-card" style="padding:10px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <strong style="font-size:12px">${esc(label)}</strong>
          <button class="btn btn-sm" id="deselectBtn" style="padding:2px 8px;font-size:11px">Deselect</button>
        </div>
        <div class="wall-pos-grid">
          <label>X</label><input type="number" data-field="x" value="${Math.round(rect.x)}" step="1">
          <label>Y</label><input type="number" data-field="y" value="${Math.round(rect.y)}" step="1">
          <label>W</label><input type="number" data-field="w" value="${Math.round(rect.w)}" step="1" min="40">
          <label>H</label><input type="number" data-field="h" value="${Math.round(rect.h)}" step="1" min="24">
        </div>
        ${isPlayer ? '' : `
        <div style="margin-top:10px">
          <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:3px">How this panel is mounted</label>
          <select id="screenRotation" class="input" style="width:100%;font-size:12px;background:var(--bg-input)">
            ${WALL_ROTATIONS.map(r => `<option value="${r}" ${(rect.rotation || 0) === r ? 'selected' : ''}>${ROTATION_LABELS[r]}</option>`).join('')}
          </select>
          <p style="margin:5px 0 0;font-size:10px;color:var(--text-muted);line-height:1.4">
            Lay the canvas out to match the <strong>physical</strong> wall and set this per panel —
            content is rotated for you, so portrait walls don't need pre-rotated video.
            While a panel is in a wall this replaces its own Orientation setting.
          </p>
        </div>`}
        <p style="margin:8px 0 0;font-size:10px;color:var(--text-muted);line-height:1.4">
          Arrow keys nudge by 1px. Hold <kbd>Shift</kbd> for 10px.
          Click outside any rect to deselect.
        </p>
      </div>
    `;
    panel.querySelector('#screenRotation')?.addEventListener('change', (ev) => {
      const r = getSelectedRect();
      if (!r) return;
      const next = parseInt(ev.target.value, 10) || 0;
      const prev = r.rotation || 0;
      r.rotation = next;
      // Turning a panel by a quarter turn changes its footprint on the wall. Swap the tile about
      // its own CENTRE so it turns in place — resizing from the corner would shove every
      // neighbouring tile out of alignment and undo the operator's careful placement.
      const wasQuarter = (prev === 90 || prev === 270);
      const isQuarter = (next === 90 || next === 270);
      if (wasQuarter !== isQuarter) {
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        const w = r.h, h = r.w;
        r.w = w; r.h = h; r.x = cx - w / 2; r.y = cy - h / 2;
      }
      markDirty();
      renderAll();
    });
    panel.querySelector('#deselectBtn').addEventListener('click', () => {
      selected = null;
      applySelectionClasses();
      renderSelectionPanel();
    });
    panel.querySelectorAll('input[data-field]').forEach(input => {
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        if (!isFinite(v)) return;
        const f = input.dataset.field;
        const r = getSelectedRect();
        if (!r) return;
        if (f === 'w') r.w = Math.max(40, v);
        else if (f === 'h') r.h = Math.max(24, v);
        else r[f] = v; // x/y can be negative
        const el = selectedDomEl();
        if (el) setRectStyle(el, r);
        updateOverlapsAll();

        markDirty();
        // Don't rebuild this panel — keeps the input focused.
      });
    });
  }

  function selectedDomEl() {
    if (!selected) return null;
    if (selected.type === 'player') return canvas.querySelector('.wall-player');
    return canvas.querySelector(`.wall-screen[data-device-id="${CSS.escape(selected.device_id)}"]`);
  }

  // Sync the panel inputs to the rect's current values without rebuilding
  // the DOM (so focus survives a drag-resize). Called from drag onChange.
  function updateSelectionInputsFromRect() {
    if (!selected) return;
    const rect = getSelectedRect();
    if (!rect) return;
    const panel = document.getElementById('selectionPanel');
    if (!panel) return;
    for (const f of ['x','y','w','h']) {
      const input = panel.querySelector(`input[data-field="${f}"]`);
      if (input && document.activeElement !== input) input.value = Math.round(rect[f]);
    }
  }

  // Pan/zoom state. pan is in viewport screen pixels; zoom is unitless.
  // The canvas div is a 0×0 anchor; its CSS transform supplies the mapping
  // from data coords to viewport pixels. All rect children inherit it.
  let pan = { x: 0, y: 0 };
  let zoom = 1;

  function applyTransform() {
    canvas.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
    const r = document.getElementById('zoomReadout');
    if (r) r.textContent = Math.round(zoom * 100) + '%';
  }

  // Re-center bounds in the viewport with a small zoom-out so there's slack
  // around the content for dragging into. Capped at 1× so we never zoom *in*
  // beyond natural scale on a small layout.
  function centerView() {
    const viewport = document.getElementById('canvasViewport');
    if (!viewport) return;
    const all = screens.length > 0 ? [...screens, player] : [player];
    const b = boundsOf(all);
    const vw = viewport.clientWidth, vh = viewport.clientHeight;
    if (!b.w || !b.h) {
      pan = { x: vw / 2, y: vh / 2 };
      zoom = 1;
    } else {
      const fitX = (vw * 0.75) / b.w;
      const fitY = (vh * 0.75) / b.h;
      zoom = Math.max(0.1, Math.min(1, fitX, fitY));
      pan.x = vw / 2 - (b.x + b.w / 2) * zoom;
      pan.y = vh / 2 - (b.y + b.h / 2) * zoom;
    }
    applyTransform();
  }

  function renderScreenEl(s) {
    const el = document.createElement('div');
    el.className = 'wall-screen';
    el.dataset.deviceId = s.device_id;
    setRectStyle(el, s);
    el.innerHTML = `
      <div class="wall-screen-overlap"></div>
      <div class="wall-screen-label">
        <div class="wall-screen-name" title="${esc(s.device_name)}">${esc(s.device_name)}</div>
        <div class="wall-screen-meta">
          <span class="status-dot ${s.device_status}" style="display:inline-block"></span>
          <span style="font-size:10px;color:var(--text-muted)">${Math.round(s.w)}×${Math.round(s.h)}</span>
          ${(s.rotation || 0) !== 0 ? `<span class="wall-screen-rot" title="${esc(ROTATION_LABELS[s.rotation])}" style="font-size:10px;color:var(--accent);margin-left:4px">⟳${s.rotation}°</span>` : ''}
        </div>
        ${renderNoteFor(s.device_id) ? `<div class="wall-screen-rendernote" style="font-size:9px;color:var(--warning,#e0a800);margin-top:2px;line-height:1.2">${esc(renderNoteFor(s.device_id))}</div>` : ''}
      </div>
      <button class="wall-screen-remove" title="${t('wall.remove_from_wall')}">×</button>
      ${resizeHandlesHtml()}
    `;
    el.querySelector('.wall-screen-remove').addEventListener('click', (ev) => {
      ev.stopPropagation();
      screens = screens.filter(x => x.device_id !== s.device_id);
      if (selected?.type === 'screen' && selected.device_id === s.device_id) selected = null;
      markDirty();
      renderAll();
    });
    el.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest('.wall-screen-remove')) return;
      selectScreen(s.device_id);
    });
    attachDragResize(el, s, () => {
      setRectStyle(el, s);
      const meta = el.querySelector('.wall-screen-meta span:last-child');
      if (meta) meta.textContent = `${Math.round(s.w)}×${Math.round(s.h)}`;
      updateOverlapsAll();

      updateSelectionInputsFromRect();
      markDirty();
    });
    return el;
  }

  function renderPlayerEl() {
    const el = document.createElement('div');
    el.className = 'wall-player';
    setRectStyle(el, player);
    el.innerHTML = `
      <div class="wall-player-label">
        <span style="font-weight:600">PLAYER</span>
        <span style="font-size:10px;color:rgba(255,255,255,0.7);margin-left:8px">${Math.round(player.w)}×${Math.round(player.h)}</span>
      </div>
      ${resizeHandlesHtml()}
    `;
    el.addEventListener('pointerdown', () => selectPlayer());
    attachDragResize(el, player, () => {
      setRectStyle(el, player);
      const meta = el.querySelector('.wall-player-label span:last-child');
      if (meta) meta.textContent = `${Math.round(player.w)}×${Math.round(player.h)}`;
      updateOverlapsAll();

      updateSelectionInputsFromRect();
      markDirty();
    });
    return el;
  }

  function updateOverlapsAll() {
    canvas.querySelectorAll('.wall-screen').forEach(el => {
      const id = el.dataset.deviceId;
      const s = screens.find(x => x.device_id === id);
      if (!s) return;
      const ov = el.querySelector('.wall-screen-overlap');
      const inter = intersect(s, player);
      if (!inter) { ov.style.display = 'none'; return; }
      ov.style.display = 'block';
      ov.style.left = (inter.x - s.x) + 'px';
      ov.style.top = (inter.y - s.y) + 'px';
      ov.style.width = inter.w + 'px';
      ov.style.height = inter.h + 'px';
    });
  }

  // #235: per-panel state for the wall, with a way through to the device itself.
  // Live socket updates are merged over the fetched rows so a panel that drops off mid-session
  // turns red here without a reload — "is the wall actually up?" has to be answerable from the
  // dashboard, because today it means sending someone to look at it.
  const liveStatus = {};
  function panelLiveness(deviceId) {
    const d = deviceById(deviceId) || {};
    const live = liveStatus[deviceId];
    return livenessBadge({ ...d, ...(live || {}) }, { short: true });
  }

  function renderPanelStatus() {
    const host = document.getElementById('wallPanelStatus');
    if (!host) return;
    const summary = document.getElementById('wallPanelSummary');

    if (screens.length === 0) {
      host.innerHTML = `<p style="color:var(--text-muted);font-size:12px;margin:0">No panels on this wall yet — drag displays onto the canvas.</p>`;
      if (summary) summary.textContent = '';
      return;
    }

    const badges = screens.map(s => ({ s, b: panelLiveness(s.device_id) }));
    const down = badges.filter(x => x.b.state !== 'online').length;
    if (summary) {
      summary.textContent = down === 0
        ? `${screens.length} panel${screens.length === 1 ? '' : 's'}, all online`
        : `${down} of ${screens.length} not online`;
      summary.style.color = down === 0 ? 'var(--success)' : 'var(--danger, #e5484d)';
    }

    host.innerHTML = `
      <div class="wall-panel-list" style="display:flex;flex-direction:column;gap:6px">
        ${badges.map(({ s, b }) => {
          const d = deviceById(s.device_id) || {};
          const meta = [
            d.app_version ? `v${esc(d.app_version)}` : '',
            (s.rotation || 0) !== 0 ? esc(ROTATION_LABELS[s.rotation]) : '',
          ].filter(Boolean).join(' · ');
          return `
            <div class="playlist-item" data-device-id="${esc(s.device_id)}" style="display:flex;align-items:center;gap:10px">
              <span class="status-dot ${esc(b.state)}" style="display:inline-block;flex-shrink:0"></span>
              <div style="flex:1;min-width:0">
                <div class="playlist-item-name" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.device_name || d.name || 'Display')}</div>
                <div class="playlist-item-meta" style="font-size:11px">
                  <span class="wall-panel-liveness"${b.title ? ` title="${esc(b.title)}"` : ''}>${esc(b.label)}</span>${meta ? ` · ${meta}` : ''}
                </div>
              </div>
              ${(!Array.isArray(d.capabilities) || d.capabilities.includes('remote.screenshot')) ? `
              <button class="btn btn-sm wall-panel-shot" data-device-id="${esc(s.device_id)}" style="padding:2px 8px;font-size:11px"
                      title="Ask this panel for a screenshot — safe on a live wall, it doesn't change what's playing">Screenshot</button>` : ''}
              <a class="btn btn-sm" href="#/device/${esc(s.device_id)}" style="padding:2px 8px;font-size:11px"
                 title="Device info, incident log and remote controls">Open</a>
            </div>`;
        }).join('')}
      </div>
      <p style="margin:8px 0 0;font-size:10px;color:var(--text-muted);line-height:1.4">
        Opening a panel doesn't remove it from the wall. Pushing different content to one panel
        will desync the wall — use the wall playlist above instead.
      </p>`;

    // The button is only rendered for a panel that declares (or baselines to) remote.screenshot —
    // a BrightSign has no screenshot capability at all, so the old unconditional button popped a
    // toast promising an image that was never coming.
    host.querySelectorAll('.wall-panel-shot').forEach(btn => {
      btn.addEventListener('click', () => {
        requestScreenshot(btn.dataset.deviceId);
        showToast('Screenshot requested — it appears on the panel\'s device page', 'info');
      });
    });
  }

  const panelStatusHandler = (data) => {
    if (!data?.device_id) return;
    liveStatus[data.device_id] = data;
    // Keep the canvas tile dots in step with the list, or the two halves of this screen disagree
    // about whether a panel is up.
    const scr = screens.find(s => s.device_id === data.device_id);
    if (scr && data.status) scr.device_status = data.status;
    const dot = canvas.querySelector(`.wall-screen[data-device-id="${CSS.escape(data.device_id)}"] .status-dot`);
    if (dot && data.status) dot.className = `status-dot ${data.status}`;
    renderPanelStatus();
  };
  on('device-status', panelStatusHandler);
  cleanupHooks.push(() => off('device-status', panelStatusHandler));

  function renderSidebar() {
    const sidebar = document.getElementById('availableDevices');
    const unassigned = getUnassigned();
    sidebar.innerHTML = unassigned.length
      ? unassigned.map(d => `
          <div class="playlist-item" style="cursor:grab;margin-bottom:4px" draggable="true"
               data-device-id="${esc(d.id)}" data-device-name="${esc(d.name)}" data-device-status="${esc(d.status)}">
            <div class="playlist-item-info">
              <div class="playlist-item-name">${esc(d.name)}</div>
              <div class="playlist-item-meta"><span class="status-dot ${d.status}" style="display:inline-block"></span> ${d.status}</div>
            </div>
          </div>
        `).join('')
      : `<p style="color:var(--text-muted);font-size:12px;text-align:center;padding:12px">${t('wall.all_assigned')}</p>`;

    sidebar.querySelectorAll('[draggable]').forEach(el => {
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/plain', JSON.stringify({
          type: 'sidebar-device',
          device_id: el.dataset.deviceId,
          device_name: el.dataset.deviceName,
          device_status: el.dataset.deviceStatus,
        }));
      });
    });

  }

  // Click on canvas background (not on a rect) clears selection
  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.target === canvas) {
      selected = null;
      applySelectionClasses();
      renderSelectionPanel();
    }
  });

  // Arrow keys nudge the selected rect by 1px (or 10px with shift). Only
  // when focus isn't in a text input — typing into the panel's number fields
  // should still let the browser handle native arrow-key behavior.
  function onArrowNudge(e) {
    if (!selected) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    let dx = 0, dy = 0;
    if (e.key === 'ArrowLeft') dx = -1;
    else if (e.key === 'ArrowRight') dx = 1;
    else if (e.key === 'ArrowUp') dy = -1;
    else if (e.key === 'ArrowDown') dy = 1;
    else return;
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const rect = getSelectedRect();
    if (!rect) return;
    rect.x = rect.x + dx * step;
    rect.y = rect.y + dy * step;
    const el = selectedDomEl();
    if (el) setRectStyle(el, rect);
    updateOverlapsAll();
    updateSelectionInputsFromRect();
    markDirty();
  }
  document.addEventListener('keydown', onArrowNudge);
  cleanupHooks.push(() => document.removeEventListener('keydown', onArrowNudge));

  // Canvas accepts sidebar drops to spawn a new screen rect
  const viewport = document.getElementById('canvasViewport');

  // Pan: pointer-drag on empty viewport space (i.e., not on a rect or its
  // children). The wall-canvas div itself counts as empty.
  let panState = null;
  viewport.addEventListener('pointerdown', (ev) => {
    // Skip if the pointer landed on a rect — that starts drag/resize instead.
    if (ev.target.closest('.wall-screen, .wall-player')) return;
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    // Empty-space click also clears selection
    if (selected) {
      selected = null;
      applySelectionClasses();
      renderSelectionPanel();
    }
    panState = { px: ev.clientX, py: ev.clientY, ox: pan.x, oy: pan.y, pid: ev.pointerId };
    viewport.classList.add('panning');
    viewport.setPointerCapture(ev.pointerId);
  });
  viewport.addEventListener('pointermove', (ev) => {
    if (!panState || ev.pointerId !== panState.pid) return;
    pan.x = panState.ox + (ev.clientX - panState.px);
    pan.y = panState.oy + (ev.clientY - panState.py);
    applyTransform();
  });
  function endPan(ev) {
    if (!panState || ev.pointerId !== panState.pid) return;
    try { viewport.releasePointerCapture(panState.pid); } catch {}
    panState = null;
    viewport.classList.remove('panning');
  }
  viewport.addEventListener('pointerup', endPan);
  viewport.addEventListener('pointercancel', endPan);

  // Wheel zoom — pivot at cursor so the world point under the cursor stays
  // pinned. Clamped to a sane range.
  viewport.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const vpRect = viewport.getBoundingClientRect();
    const cx = ev.clientX - vpRect.left;
    const cy = ev.clientY - vpRect.top;
    const worldX = (cx - pan.x) / zoom;
    const worldY = (cy - pan.y) / zoom;
    const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newZoom = Math.max(0.1, Math.min(5, zoom * factor));
    pan.x = cx - worldX * newZoom;
    pan.y = cy - worldY * newZoom;
    zoom = newZoom;
    applyTransform();
  }, { passive: false });

  viewport.addEventListener('dragover', (e) => { e.preventDefault(); });
  viewport.addEventListener('drop', (e) => {
    e.preventDefault();
    let data;
    try { data = JSON.parse(e.dataTransfer.getData('text/plain') || '{}'); } catch { return; }
    if (data.type !== 'sidebar-device' || !data.device_id) return;
    const vpRect = viewport.getBoundingClientRect();
    // #14: size the new tile to the device's render resolution (centered on the drop point).
    // #236: ...as its FOOTPRINT, so a panel already set to portrait drops in as a tall tile that
    // matches how it is actually hung, instead of a landscape tile the operator has to reason
    // backwards from.
    const rotation = defaultRotationFor(data.device_id);
    const sz = footprintOnWall(data.device_id, rotation);
    // Drop pixel → canvas-data coord: undo viewport offset, pan, and zoom.
    const x = (e.clientX - vpRect.left - pan.x) / zoom - sz.w / 2;
    const y = (e.clientY - vpRect.top - pan.y) / zoom - sz.h / 2;
    screens.push({
      device_id: data.device_id,
      device_name: data.device_name || 'Display',
      device_status: data.device_status || 'offline',
      grid_col: 0, grid_row: 0, rotation,
      x, y, w: sz.w, h: sz.h,
    });
    markDirty();
    renderAll();
  });

  // ---------- Toolbar ----------
  document.getElementById('centerViewBtn').addEventListener('click', () => centerView());

  document.getElementById('autoArrangeBtn').addEventListener('click', () => {
    const cols = Math.max(1, parseInt(document.getElementById('gridCols').value) || 1);
    const rows = Math.max(1, parseInt(document.getElementById('gridRows').value) || 1);
    const bH = Math.max(0, parseInt(document.getElementById('bezelH').value) || 0);
    const bV = Math.max(0, parseInt(document.getElementById('bezelV').value) || 0);
    // #14: grid pitch = the largest tile dimension across the wall (tiles keep their own
    // render size). For a homogeneous wall this is just the panel size; for a mixed wall it
    // guarantees no overlap. Empty wall falls back to the 320x180 default.
    const w = Math.max(DEFAULT_SCREEN_W, ...screens.map(s => s.w || 0));
    const h = Math.max(DEFAULT_SCREEN_H, ...screens.map(s => s.h || 0));
    let i = 0;
    for (const s of screens) {
      if (i >= cols * rows) break;
      const c = i % cols;
      const r = Math.floor(i / cols);
      s.x = c * (w + bH);
      s.y = r * (h + bV);
      s.grid_col = c;
      s.grid_row = r;
      i++;
    }
    // Fit player to whole grid bounding box
    const b = boundsOf(screens);
    player.x = b.x; player.y = b.y; player.w = b.w; player.h = b.h;
    markDirty();
    renderAll();
  });

  document.getElementById('fitPlayerBtn').addEventListener('click', () => {
    if (screens.length === 0) return;
    const b = boundsOf(screens);
    player.x = b.x; player.y = b.y; player.w = b.w; player.h = b.h;
    markDirty();
    renderAll();
  });

  document.getElementById('saveLayoutBtn').addEventListener('click', async () => {
    try {
      // Persist player rect + grid/bezel inputs to the wall, devices to its
      // member list. Two PUTs because the existing routes are split that way.
      const cols = Math.max(1, parseInt(document.getElementById('gridCols').value) || 1);
      const rows = Math.max(1, parseInt(document.getElementById('gridRows').value) || 1);
      const bH = Math.max(0, parseInt(document.getElementById('bezelH').value) || 0);
      const bV = Math.max(0, parseInt(document.getElementById('bezelV').value) || 0);
      // Quantize all coords to integers before persisting. Drag/resize
      // produce floats (screen-pixel deltas divided by zoom), and even tiny
      // FP drift between two screens with the same nominal Y/H produces
      // visibly different `top`/`height` percentages downstream — a known
      // source of vertical-misalignment bugs across the wall.
      await API(`/walls/${wallId}`, { method: 'PUT', body: JSON.stringify({
        grid_cols: cols, grid_rows: rows, bezel_h_mm: bH, bezel_v_mm: bV,
        player_x: Math.round(player.x), player_y: Math.round(player.y),
        player_width: Math.round(player.w), player_height: Math.round(player.h),
      })});
      // grid_col/grid_row are kept only to satisfy the legacy
      // UNIQUE(wall_id, grid_col, grid_row) constraint — render math now uses
      // canvas_* fields. Synthetic (i, 0) guarantees uniqueness.
      const payload = screens.map((s, i) => ({
        device_id: s.device_id,
        grid_col: i,
        grid_row: 0,
        rotation: s.rotation || 0,
        canvas_x: Math.round(s.x), canvas_y: Math.round(s.y),
        canvas_width: Math.round(s.w), canvas_height: Math.round(s.h),
      }));
      await API(`/walls/${wallId}/devices`, { method: 'PUT', body: JSON.stringify({ devices: payload }) });
      // Re-fetch master device list so wall_id changes propagate to the sidebar
      devices = await api.getDevices();
      dirty = false;
      const btn = document.getElementById('saveLayoutBtn');
      btn.disabled = true;
      btn.classList.remove('btn-primary');
      showToast('Layout saved', 'success');
    } catch (err) { showToast(err.message, 'error'); }
  });

  document.getElementById('renameWallBtn').addEventListener('click', async () => {
    const newName = prompt('Wall name:', wall.name);
    if (!newName || newName === wall.name) return;
    try {
      await API(`/walls/${wallId}`, { method: 'PUT', body: JSON.stringify({ name: newName }) });
      wall.name = newName;
      document.getElementById('wallTitleText').textContent = newName;
    } catch (err) { showToast(err.message, 'error'); }
  });

  document.getElementById('setPlaylistBtn').addEventListener('click', async () => {
    const playlistId = document.getElementById('wallPlaylist').value || null;
    try {
      await API(`/walls/${wallId}`, { method: 'PUT', body: JSON.stringify({ playlist_id: playlistId }) });
      wall.playlist_id = playlistId;
      showToast(t('wall.toast.playlist_updated'), 'success');
    } catch (err) { showToast(err.message, 'error'); }
  });

  document.getElementById('deleteWallBtn').addEventListener('click', async () => {
    if (!confirm(`Delete wall "${wall.name}"? This returns all displays to ungrouped.`)) return;
    try {
      await API(`/walls/${wallId}`, { method: 'DELETE' });
      showToast(t('wall.toast.deleted'), 'success');
      window.location.hash = '#/walls';
    } catch (err) { showToast(err.message, 'error'); }
  });

  // Warn before navigating away with unsaved layout changes
  function beforeUnloadWarn(e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } }
  window.addEventListener('beforeunload', beforeUnloadWarn);
  cleanupHooks.push(() => window.removeEventListener('beforeunload', beforeUnloadWarn));

  renderAll();
  // Center on initial mount once the viewport has measurable dimensions.
  // requestAnimationFrame defers until layout settles; fits content + padding.
  requestAnimationFrame(() => centerView());

  // ---------- Internal helpers ----------
  function setRectStyle(el, r) {
    el.style.left = r.x + 'px';
    el.style.top = r.y + 'px';
    el.style.width = r.w + 'px';
    el.style.height = r.h + 'px';
  }

  function attachDragResize(el, rect, onChange) {
    // Drag the body to move; drag a corner/edge handle to resize.
    el.addEventListener('pointerdown', (ev) => {
      // Ignore if clicking the remove button or other inner controls
      if (ev.target.closest('.wall-screen-remove')) return;
      const handle = ev.target.closest('.wall-handle');
      const dir = handle?.dataset.dir;
      const mode = dir ? `resize:${dir}` : 'move';
      ev.preventDefault();
      ev.stopPropagation();
      el.setPointerCapture(ev.pointerId);

      const startX = ev.clientX;
      const startY = ev.clientY;
      const start = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };

      function move(e) {
        // Convert screen-pixel deltas to data-pixel deltas via current zoom
        // so the rect stays under the cursor regardless of zoom level.
        const dx = (e.clientX - startX) / zoom;
        const dy = (e.clientY - startY) / zoom;
        if (mode === 'move') {
          // Allow negative coords — physical screen layouts can offset above
          // or to the left of the canvas's notional origin.
          rect.x = start.x + dx;
          rect.y = start.y + dy;
        } else {
          applyResize(mode.slice(7), dx, dy, start, rect);
        }
        onChange();
      }
      function up(e) {
        el.releasePointerCapture(ev.pointerId);
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        onChange();
      }
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });

  }
}

function applyResize(dir, dx, dy, start, rect) {
  const minW = 40, minH = 24;
  let { x, y, w, h } = start;
  if (dir.includes('e')) w = Math.max(minW, start.w + dx);
  if (dir.includes('s')) h = Math.max(minH, start.h + dy);
  if (dir.includes('w')) {
    const newW = Math.max(minW, start.w - dx);
    x = start.x + (start.w - newW);
    w = newW;
  }
  if (dir.includes('n')) {
    const newH = Math.max(minH, start.h - dy);
    y = start.y + (start.h - newH);
    h = newH;
  }
  // x/y unconstrained — negative coords are allowed
  rect.x = x;
  rect.y = y;
  rect.w = w;
  rect.h = h;
}

function resizeHandlesHtml() {
  return ['nw','n','ne','e','se','s','sw','w']
    .map(d => `<div class="wall-handle wall-handle-${d}" data-dir="${d}"></div>`)
    .join('');
}

function boundsOf(rects) {
  let x = Infinity, y = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of rects) {
    if (r.x < x) x = r.x;
    if (r.y < y) y = r.y;
    if (r.x + r.w > x2) x2 = r.x + r.w;
    if (r.y + r.h > y2) y2 = r.y + r.h;
  }
  if (!isFinite(x)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x, y, w: x2 - x, h: y2 - y };
}

function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x || y2 <= y) return null;
  return { x, y, w: x2 - x, h: y2 - y };
}

// Cleanup hooks set during render so we can detach them on view unload.
const cleanupHooks = [];

export function cleanup() {
  while (cleanupHooks.length) {
    try { cleanupHooks.pop()(); } catch {}
  }
}
