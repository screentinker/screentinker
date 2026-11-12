/*
 * The "Now serving" widget's settings in the widget editor (server: lib/queue/widget.js). Which
 * queue it shows, its words and colours, and its chime: off by default, a volume from 0 to 100, and
 * only ever played by a player that supports it while the queue's staff sound switch is on.
 */
import { t } from '../i18n.js';
import { esc } from '../utils.js';

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const hex = (v, d) => (typeof v === 'string' && HEX.test(v) ? v : d);

export async function mountQueueEditor(box, config = {}, { get }) {
  if (!box) return;
  const c = config || {};
  const vol = Number.isFinite(Number(c.chime_volume)) ? Math.max(0, Math.min(100, Number(c.chime_volume))) : 60;
  box.innerHTML = `
    <div class="form-group"><label>${esc(t('queue.widget.queue'))}</label>
      <select id="wQueueId" class="input"><option value="">${esc(t('queue.widget.loading'))}</option></select>
      <div style="font-size:12px;color:var(--text-muted);margin-top:4px">${esc(t('queue.widget.queue_hint'))}</div></div>
    <div class="form-group"><label>${esc(t('queue.widget.label'))}</label>
      <input type="text" id="wQueueLabel" class="input" maxlength="60" value="${esc(c.label || '')}" placeholder="${esc(t('queue.widget.label_ph'))}"></div>
    <div class="form-group" style="display:flex;gap:12px;flex-wrap:wrap">
      <label style="font-size:13px">${esc(t('queue.widget.background'))}<br><input type="color" id="wQueueBg" value="${esc(hex(c.background, '#0f172a'))}"></label>
      <label style="font-size:13px">${esc(t('queue.widget.color'))}<br><input type="color" id="wQueueColor" value="${esc(hex(c.color, '#ffffff'))}"></label>
      <label style="font-size:13px">${esc(t('queue.widget.accent'))}<br><input type="color" id="wQueueAccent" value="${esc(hex(c.accent, '#facc15'))}"></label>
    </div>
    <div class="form-group">
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="wQueueChime" ${c.chime === true ? 'checked' : ''}> ${esc(t('queue.widget.chime'))}</label>
      <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
        <span style="font-size:13px">${esc(t('queue.widget.volume'))}</span>
        <input type="range" id="wQueueVol" min="0" max="100" step="5" value="${esc(vol)}" style="flex:1">
        <span id="wQueueVolOut" style="font-size:13px;width:44px;text-align:right">${esc(vol)}%</span>
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:4px">${esc(t('queue.widget.chime_hint'))}</div>
    </div>`;
  const vr = box.querySelector('#wQueueVol');
  vr.addEventListener('input', () => { box.querySelector('#wQueueVolOut').textContent = `${vr.value}%`; });
  const sel = box.querySelector('#wQueueId');
  try {
    const queues = await get('/queues');
    sel.innerHTML = `<option value="">${esc(t('queue.widget.pick'))}</option>`
      + queues.map((q) => `<option value="${esc(q.id)}"${q.id === c.queue_id ? ' selected' : ''}>${esc(q.name)}</option>`).join('');
    if (!c.queue_id && queues.length === 1) sel.value = queues[0].id;
    if (!queues.length) sel.innerHTML = `<option value="">${esc(t('queue.widget.none'))}</option>`;
  } catch (e) {
    sel.innerHTML = `<option value="${esc(c.queue_id || '')}">${esc(e.message)}</option>`;
  }
}

export function readQueueConfig() {
  const v = (id) => document.getElementById(id);
  const out = {
    queue_id: v('wQueueId')?.value || '',
    label: (v('wQueueLabel')?.value || '').trim().slice(0, 60),
    background: v('wQueueBg')?.value || '#0f172a',
    color: v('wQueueColor')?.value || '#ffffff',
    accent: v('wQueueAccent')?.value || '#facc15',
    chime: !!v('wQueueChime')?.checked,
    chime_volume: Math.max(0, Math.min(100, parseInt(v('wQueueVol')?.value, 10) || 0)),
  };
  if (!out.label) delete out.label;
  return out;
}
