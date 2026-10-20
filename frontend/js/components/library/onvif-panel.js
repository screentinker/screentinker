/*
 * The Edit dialog's section for an ONVIF camera (routes/onvif.js): a new snapshot as the thumbnail,
 * asking the camera again for its stream address (after a new IP, firmware or password), and, on a
 * camera that has it, pan / tilt / zoom with presets.
 *
 * Everything here acts on the camera at once; nothing is saved with the dialog's Save. The password
 * is write-only: the server says whether one is stored, never what it is.
 *
 * PTZ is press-and-hold: a held arrow repeats ContinuousMove every MOVE_EVERY_MS with a camera-side
 * timeout of MOVE_TIMEOUT_S, and releasing it sends Stop. The timeout is the safety net: a Stop lost
 * on the way (a closed laptop, a dropped Wi-Fi) still has the camera stop by itself within a second.
 */
import { api } from '../../api.js';
import { esc } from '../../utils.js';
import { t } from '../../i18n.js';
import { showToast } from '../toast.js';

const MOVE_EVERY_MS = 700;
const MOVE_TIMEOUT_S = 1;
const SPEED = 0.5;

function settings(item) {
  if (!item || !item.onvif) return null;
  try { return typeof item.onvif === 'string' ? JSON.parse(item.onvif) : item.onvif; } catch { return null; }
}

export function appliesTo(item) {
  return !!settings(item);
}

/** The section's HTML, or '' for anything that isn't an ONVIF camera. */
export function onvifSection(item) {
  const o = settings(item);
  if (!o) return '';
  const pad = (dir, label, glyph) => `<button type="button" class="btn btn-secondary btn-sm" data-ptz-dir="${dir}" aria-label="${esc(label)}" title="${esc(label)}" style="min-width:40px">${glyph}</button>`;
  return `
  <div class="form-group" id="onvifSection">
    <label>${esc(t('onvif.panel_title'))}</label>
    <p style="font-size:11px;color:var(--text-muted);margin-top:4px">${esc(t('onvif.panel_hint', { name: [o.manufacturer, o.model].filter(Boolean).join(' ') || o.xaddr }))}</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
      <button type="button" class="btn btn-secondary btn-sm" id="onvifSnapshot">${esc(t('onvif.new_snapshot'))}</button>
      <button type="button" class="btn btn-secondary btn-sm" id="onvifRefresh">${esc(t('onvif.refresh_stream'))}</button>
    </div>
    <details style="margin-top:8px">
      <summary style="cursor:pointer;font-size:12px">${esc(t('onvif.change_password'))}</summary>
      <div style="display:flex;gap:8px;margin-top:6px">
        <input type="password" id="onvifNewPass" class="input" autocomplete="new-password" aria-label="${esc(t('onvif.password_label'))}" placeholder="${esc(t('onvif.password_label'))}" style="flex:1">
        <button type="button" class="btn btn-secondary btn-sm" id="onvifSavePass">${esc(t('onvif.save_password'))}</button>
      </div>
    </details>
    ${o.ptz ? `
    <div id="onvifPtz" style="margin-top:10px;padding:10px;border:1px solid var(--border);border-radius:8px">
      <div style="font-size:12px;margin-bottom:6px">${esc(t('onvif.ptz_title'))}</div>
      <div style="display:grid;grid-template-columns:repeat(3,44px);gap:4px;justify-content:start">
        <span></span>${pad('up', t('onvif.ptz_up'), '▲')}<span></span>
        ${pad('left', t('onvif.ptz_left'), '◀')}<button type="button" class="btn btn-secondary btn-sm" id="onvifHome" aria-label="${esc(t('onvif.ptz_home'))}" title="${esc(t('onvif.ptz_home'))}">⌂</button>${pad('right', t('onvif.ptz_right'), '▶')}
        <span></span>${pad('down', t('onvif.ptz_down'), '▼')}<span></span>
      </div>
      <div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap">
        ${pad('zoom-in', t('onvif.ptz_zoom_in'), '＋')}${pad('zoom-out', t('onvif.ptz_zoom_out'), '－')}
        <select id="onvifPreset" class="input" style="flex:1;min-width:140px" aria-label="${esc(t('onvif.ptz_presets'))}"><option value="">${esc(t('onvif.ptz_presets_loading'))}</option></select>
        <button type="button" class="btn btn-secondary btn-sm" id="onvifGoPreset">${esc(t('onvif.ptz_go'))}</button>
      </div>
    </div>` : ''}
    <p role="status" style="font-size:11px;color:var(--text-muted);margin-top:6px" id="onvifStatus"></p>
  </div>`;
}

/** Wire the section inside `root`. `onChanged(item)` is called after the item itself changed. */
export function wireOnvifPanel(root, item, onChanged) {
  const o = settings(item);
  const section = root.querySelector('#onvifSection');
  if (!o || !section) return;
  const status = section.querySelector('#onvifStatus');
  const say = (msg) => { status.textContent = msg || ''; };
  const base = `/onvif/cameras/${encodeURIComponent(item.id)}`;

  const busy = async (btn, fn) => {
    btn.disabled = true; btn.setAttribute('aria-busy', 'true');
    try { await fn(); } catch (e) { say(e.message); } finally { btn.disabled = false; btn.removeAttribute('aria-busy'); }
  };

  const snapBtn = section.querySelector('#onvifSnapshot');
  snapBtn.addEventListener('click', () => busy(snapBtn, async () => {
    await api.post(`${base}/snapshot`, {});
    say(t('onvif.snapshot_done'));
    if (onChanged) onChanged();
  }));
  const refBtn = section.querySelector('#onvifRefresh');
  refBtn.addEventListener('click', () => busy(refBtn, async () => {
    const updated = await api.post(`${base}/refresh`, {});
    say(t('onvif.refresh_done'));
    if (onChanged) onChanged(updated);
  }));
  const passBtn = section.querySelector('#onvifSavePass');
  const passIn = section.querySelector('#onvifNewPass');
  passBtn.addEventListener('click', () => busy(passBtn, async () => {
    // Checked against the camera before it is stored: a wrong password is refused, not saved.
    const updated = await api.post(`${base}/refresh`, { password: passIn.value });
    passIn.value = '';
    showToast(t('onvif.password_saved'), 'success');
    say('');
    if (onChanged) onChanged(updated);
  }));

  if (!o.ptz) return;
  const presetSel = section.querySelector('#onvifPreset');
  api.get(`${base}/presets`).then((r) => {
    presetSel.innerHTML = r.presets.length
      ? r.presets.map((p) => `<option value="${esc(p.token)}">${esc(p.name)}</option>`).join('')
      : `<option value="">${esc(t('onvif.ptz_no_presets'))}</option>`;
  }).catch((e) => { presetSel.innerHTML = `<option value="">${esc(t('onvif.ptz_no_presets'))}</option>`; say(e.message); });

  const ptz = (body) => api.post(`${base}/ptz`, body).catch((e) => say(e.message));
  const VEL = {
    up: { tilt: SPEED }, down: { tilt: -SPEED }, left: { pan: -SPEED }, right: { pan: SPEED },
    'zoom-in': { zoom: SPEED }, 'zoom-out': { zoom: -SPEED },
  };
  let held = null;
  const start = (dir) => {
    stop();
    const v = VEL[dir];
    const send = () => ptz({ action: 'move', pan: v.pan || 0, tilt: v.tilt || 0, zoom: v.zoom || 0, timeout: MOVE_TIMEOUT_S });
    send();
    held = setInterval(send, MOVE_EVERY_MS);
  };
  const stop = () => {
    if (!held) return;
    clearInterval(held);
    held = null;
    ptz({ action: 'stop' });
  };
  section.querySelectorAll('[data-ptz-dir]').forEach((btn) => {
    const dir = btn.dataset.ptzDir;
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); btn.setPointerCapture?.(e.pointerId); start(dir); });
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('lostpointercapture', stop);
    // Keyboard: Space/Enter held moves, released stops — the same as a held mouse button.
    btn.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); start(dir); } });
    btn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); stop(); } });
    btn.addEventListener('blur', stop);
  });
  section.querySelector('#onvifHome').addEventListener('click', () => ptz({ action: 'home' }));
  section.querySelector('#onvifGoPreset').addEventListener('click', () => {
    if (presetSel.value) ptz({ action: 'preset', preset: presetSel.value });
  });
  // Closing the dialog mid-move: stop rather than leave the camera turning until its timeout.
  const observer = new MutationObserver(() => { if (!document.contains(section)) { stop(); observer.disconnect(); } });
  observer.observe(document.body, { childList: true, subtree: true });
}
