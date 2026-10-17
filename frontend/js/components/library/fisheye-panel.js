// A fisheye (360°) camera shown as a normal view: the Edit dialog's settings for it, and live
// steering of one screen while the sliders move. The maths and every field's range are in
// server/lib/fisheye.js; the screen does the drawing.
//
// Two things the sliders do, deliberately separate:
//   - while a screen is picked, every move is sent to it at once (the camera_view command), so the
//     operator points the camera by watching the real screen;
//   - Save Changes stores the settings on the item: every screen starts from that view again.

import { api } from '../../api.js';
import { esc } from '../../utils.js';
import { t } from '../../i18n.js';

const LIVE = ['video/rtsp', 'video/hls'];
const MOUNTS = ['ceiling', 'floor', 'wall'];
// Literal keys, so the i18n check can see every one.
const MOUNT_LABEL = {
  ceiling: () => t('content.fisheye_mount_ceiling'),
  floor: () => t('content.fisheye_mount_floor'),
  wall: () => t('content.fisheye_mount_wall'),
};
const SEND_EVERY_MS = 120;   // a slider drag sends at most ~8 moves a second

export function appliesTo(item) {
  return !!item && LIVE.includes(item.mime_type);
}

function current(item) {
  if (!item || !item.fisheye) return null;
  if (typeof item.fisheye === 'object') return item.fisheye;
  try { return JSON.parse(item.fisheye); } catch { return null; }
}

function tiltRange(mount, lens) {
  const half = lens / 2;
  return mount === 'wall' ? [-Math.min(85, half), Math.min(85, half)] : [0, Math.min(half, 120)];
}

function slider(id, label, min, max, value, step = 1) {
  return `<div class="form-group" style="margin-bottom:8px">
    <label for="${id}" style="display:flex;justify-content:space-between"><span>${esc(label)}</span><span id="${id}Val">${esc(String(value))}</span></label>
    <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${esc(String(value))}" style="width:100%">
  </div>`;
}

/** The section's HTML for the Edit dialog, or '' when the item is not a live stream. */
export function fisheyeSection(item) {
  if (!appliesTo(item)) return '';
  const f = current(item);
  const v = f || { mount: 'ceiling', lens_fov: 180, rotation: 0, pan: 0, tilt: 55, zoom: 80, touch: false };
  const [tlo, thi] = tiltRange(v.mount, v.lens_fov);
  return `
  <div class="form-group" id="fisheyeSection">
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
      <input type="checkbox" id="fisheyeOn" ${f ? 'checked' : ''} style="width:auto;margin:0">
      <span>${t('content.fisheye_title')}</span>
    </label>
    <p style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('content.fisheye_hint')}</p>
    <div id="fisheyeBody" ${f ? '' : 'hidden'} style="margin-top:8px;padding:10px;border:1px solid var(--border);border-radius:8px">
      <div class="form-group" style="margin-bottom:8px">
        <label for="fisheyeMount">${t('content.fisheye_mount')}</label>
        <select id="fisheyeMount" class="input">
          ${MOUNTS.map((m) => `<option value="${m}" ${v.mount === m ? 'selected' : ''}>${MOUNT_LABEL[m]()}</option>`).join('')}
        </select>
      </div>
      ${slider('fisheyePan', t('content.fisheye_pan'), v.mount === 'wall' ? -Math.round(v.lens_fov / 2) : -180, v.mount === 'wall' ? Math.round(v.lens_fov / 2) : 180, v.pan)}
      ${slider('fisheyeTilt', t('content.fisheye_tilt'), Math.round(tlo), Math.round(thi), v.tilt)}
      ${slider('fisheyeZoom', t('content.fisheye_zoom'), 20, 120, v.zoom)}
      <details style="margin:4px 0 8px">
        <summary style="cursor:pointer;font-size:12px">${t('content.fisheye_lens_settings')}</summary>
        ${slider('fisheyeLens', t('content.fisheye_lens'), 90, 240, v.lens_fov)}
        ${slider('fisheyeRotation', t('content.fisheye_rotation'), -180, 180, v.rotation)}
      </details>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:8px">
        <input type="checkbox" id="fisheyeTouch" ${v.touch ? 'checked' : ''} style="width:auto;margin:0">
        <span>${t('content.fisheye_touch')}</span>
      </label>
      <div class="form-group" style="margin-bottom:0">
        <label for="fisheyeScreen">${t('content.fisheye_live')}</label>
        <div style="display:flex;gap:8px">
          <select id="fisheyeScreen" class="input" style="flex:1"><option value="">${t('content.fisheye_live_none')}</option></select>
          <button type="button" class="btn btn-secondary btn-sm" id="fisheyeReset">${t('content.fisheye_reset')}</button>
        </div>
        <p style="font-size:11px;color:var(--text-muted);margin-top:4px" id="fisheyeLiveHint">${t('content.fisheye_live_hint')}</p>
      </div>
    </div>
  </div>`;
}

/**
 * Wires the section inside `root`. Returns { value() }: the settings to save (an object, or null to
 * turn it off), or undefined when the section is absent or unchanged.
 */
export function wireFisheyePanel(root, item) {
  const on = root.querySelector('#fisheyeOn');
  if (!on) return { value: () => undefined };
  const $ = (id) => root.querySelector('#' + id);
  const body = $('fisheyeBody');
  let screen = '';
  let pending = null;
  let timer = null;

  const read = () => ({
    mount: $('fisheyeMount').value,
    lens_fov: Number($('fisheyeLens').value),
    rotation: Number($('fisheyeRotation').value),
    pan: Number($('fisheyePan').value),
    tilt: Number($('fisheyeTilt').value),
    zoom: Number($('fisheyeZoom').value),
    touch: $('fisheyeTouch').checked,
  });

  const send = (payload) => {
    if (!screen) return;
    pending = payload;
    if (timer) return;
    timer = setTimeout(async () => {
      timer = null;
      const p = pending; pending = null;
      try {
        const r = await api.post(`/devices/${encodeURIComponent(screen)}/command`, { type: 'camera_view', payload: { content_id: item.id, ...p } });
        const hint = $('fisheyeLiveHint');
        if (hint && r && r.status && r.status !== 'sent' && r.status !== 'relayed') {
          hint.textContent = r.status === 'unsupported' ? t('content.fisheye_live_unsupported') : t('content.fisheye_live_offline');
        }
      } catch (e) { /* the screen simply does not move; Save still works */ }
    }, SEND_EVERY_MS);
  };

  // A mount or lens change moves the tilt range: keep the slider's limits honest.
  const fitTilt = () => {
    const v = read();
    const [lo, hi] = tiltRange(v.mount, v.lens_fov);
    const tilt = $('fisheyeTilt');
    tilt.min = String(Math.round(lo)); tilt.max = String(Math.round(hi));
    if (Number(tilt.value) < lo || Number(tilt.value) > hi) tilt.value = String(v.mount === 'wall' ? 0 : Math.min(55, hi));
    const pan = $('fisheyePan');
    pan.min = String(v.mount === 'wall' ? -Math.round(v.lens_fov / 2) : -180);
    pan.max = String(v.mount === 'wall' ? Math.round(v.lens_fov / 2) : 180);
  };

  for (const id of ['fisheyePan', 'fisheyeTilt', 'fisheyeZoom', 'fisheyeLens', 'fisheyeRotation']) {
    $(id).addEventListener('input', () => {
      $(id + 'Val').textContent = $(id).value;
      if (id === 'fisheyeLens') fitTilt();
      const v = read();
      // Only the view travels live; lens and rotation are saved with the item.
      send({ pan: v.pan, tilt: v.tilt, zoom: v.zoom });
    });
  }
  $('fisheyeMount').addEventListener('change', fitTilt);
  on.addEventListener('change', () => { body.hidden = !on.checked; });
  $('fisheyeReset').addEventListener('click', () => send({ reset: true }));
  $('fisheyeScreen').addEventListener('change', (e) => {
    screen = e.target.value;
    $('fisheyeLiveHint').textContent = t('content.fisheye_live_hint');
    if (screen) { const v = read(); send({ pan: v.pan, tilt: v.tilt, zoom: v.zoom }); }
  });

  // Screens to steer: the online ones this item is on screen at is not known here, so every online
  // screen is offered and the server says when one cannot (unsupported / offline).
  api.getDevices().then((list) => {
    const sel = $('fisheyeScreen');
    if (!sel) return;
    const devices = (Array.isArray(list) ? list : (list && list.devices) || []).filter((d) => d.status === 'online');
    for (const d of devices) {
      const o = document.createElement('option');
      o.value = d.id; o.textContent = d.name || d.id;
      sel.appendChild(o);
    }
  }).catch(() => {});

  return {
    value() {
      const stored = current(item);
      if (!on.checked) return stored ? null : undefined;
      const v = read();
      // The lens circle (cx, cy, r) is not edited here: kept as stored, so a save never resets it.
      if (stored && Object.keys(v).every((k) => stored[k] === v[k])) return undefined;
      return { ...(stored || {}), ...v };
    },
  };
}
