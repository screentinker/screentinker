/*
 * A video wall as the audience sees it: every panel's latest screenshot laid out where the panel
 * hangs on the wall canvas, so a wall can be looked at the way a single screen is — on its page and
 * on its Displays card.
 *
 * Geometry is the wall editor's: canvas_x/y/width/height per panel (wall space), falling back to the
 * old grid maths for a wall never opened in the new editor. A screenshot is the panel's FRAMEBUFFER,
 * so a panel hung sideways sends its picture turned by its mounting rotation; it is turned back here
 * (by -rotation), exactly as the panel's own mount does in the room.
 */
import { esc, screenshotUrl } from '../utils.js';
import { t } from '../i18n.js';
import { on, off, requestScreenshot } from '../socket.js';

const BASE_W = 320, BASE_H = 180;

export function wallPanelRects(wall) {
  const bh = wall.bezel_h_mm || 0, bv = wall.bezel_v_mm || 0;
  return (wall.devices || []).map((d) => ({
    id: d.device_id,
    name: d.device_name || '',
    rotation: Number(d.rotation) || 0,
    x: d.canvas_x ?? (d.grid_col * (BASE_W + bh)),
    y: d.canvas_y ?? (d.grid_row * (BASE_H + bv)),
    w: d.canvas_width ?? BASE_W,
    h: d.canvas_height ?? BASE_H,
  }));
}

function bounds(rects) {
  if (!rects.length) return { x: 0, y: 0, w: 16, h: 9 };
  const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
}

/*
 * Mount the stitched view into `container`.
 *   wall     — a wall with .devices (as GET /walls/:id or the walls list returns it)
 *   devices  — the device list (screenshot_path/at, status, capabilities), by id
 *   live     — request fresh screenshots now and every `refreshMs` (0 = only show what is stored)
 *   compact  — card mode: no labels, no offline text
 * Returns { refresh(), destroy() }.
 */
export function mountWallLive(container, { wall, devices = [], live = false, refreshMs = 0, compact = false }) {
  const rects = wallPanelRects(wall);
  // No panels placed yet: say so, rather than drawing an empty black box that reads as "broken".
  if (!rects.length) {
    container.innerHTML = `<div class="wall-live-empty">${esc(t('wall.live_empty'))}</div>`;
    return { refresh() {}, destroy() {} };
  }
  const b = bounds(rects);
  const byId = new Map(devices.map((d) => [d.id, d]));
  container.innerHTML = `
    <div class="wall-live" style="position:relative;${compact && b.w / b.h < 16 / 9 ? 'height:100%;width:auto' : 'width:100%'};aspect-ratio:${b.w} / ${b.h};background:#000;overflow:hidden;border-radius:6px">
      ${rects.map((r) => {
        const d = byId.get(r.id) || {};
        const online = (d.status || '').toLowerCase() === 'online';
        const quarter = r.rotation === 90 || r.rotation === 270;
        // The image is the framebuffer: for a quarter turn its box is the cell with w/h swapped.
        const iw = quarter ? (r.h / r.w * 100) : 100, ih = quarter ? (r.w / r.h * 100) : 100;
        const src = d.screenshot_path ? screenshotUrl(r.id, d.screenshot_at || '') : '';
        return `
        <div class="wall-live-panel" data-device-id="${esc(r.id)}" title="${esc(r.name)}"
             style="position:absolute;overflow:hidden;background:#111;left:${(r.x - b.x) / b.w * 100}%;top:${(r.y - b.y) / b.h * 100}%;width:${r.w / b.w * 100}%;height:${r.h / b.h * 100}%;outline:1px solid rgba(255,255,255,0.08)">
          <img alt="" ${src ? `src="${src}"` : ''} style="position:absolute;left:50%;top:50%;width:${iw}%;height:${ih}%;object-fit:fill;transform:translate(-50%,-50%) rotate(${-r.rotation}deg);${src ? '' : 'display:none'}">
          ${online ? '' : `<div style="position:absolute;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;color:#f87171;font-size:${compact ? 9 : 12}px;text-align:center;padding:4px">${compact ? '' : esc(r.name) + '<br>'}offline</div>`}
          ${compact ? '' : `<span style="position:absolute;left:4px;bottom:3px;font-size:10px;color:rgba(255,255,255,0.75);text-shadow:0 1px 2px #000">${esc(r.name)}</span>`}
        </div>`;
      }).join('')}
    </div>`;

  const ids = new Set(rects.map((r) => r.id));
  const handler = (data) => {
    if (!data || !ids.has(data.device_id)) return;
    const img = container.querySelector(`.wall-live-panel[data-device-id="${CSS.escape(data.device_id)}"] img`);
    if (!img) return;
    img.src = data.image_data || (data.url + '&token=' + localStorage.getItem('token'));
    img.style.display = '';
  };
  on('screenshot-ready', handler);

  // Only panels that are up and can take one — a BrightSign has no screenshot at all.
  const refresh = () => {
    for (const r of rects) {
      const d = byId.get(r.id);
      const can = !d || !Array.isArray(d.capabilities) || d.capabilities.includes('remote.screenshot');
      if (can && (!d || (d.status || '').toLowerCase() === 'online')) requestScreenshot(r.id);
    }
  };
  let timer = null;
  if (live) { refresh(); if (refreshMs > 0) timer = setInterval(refresh, refreshMs); }

  return {
    refresh,
    destroy() { off('screenshot-ready', handler); if (timer) clearInterval(timer); },
  };
}
