/*
 * The Curbside widget's settings in the widget editor (server: lib/curbside/widget.js). Which location
 * it shows, its colours, how many cars fit, and its chime: off by default, played when a car is
 * acknowledged, arrives, or both, at a volume from 0 to 100, and only by a player that supports it.
 * The words on the widget are the location's (edit them on the Curbside page), not the widget's.
 *
 * Built with DOM nodes: location names are set as option text, never as HTML.
 */
import { t } from '../i18n.js';
import { h } from '../lib/curbside-dom.js';

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const hex = (v, d) => (typeof v === 'string' && HEX.test(v) ? v : d);

export async function mountCurbsideEditor(box, config = {}, { get }) {
  if (!box) return;
  const c = config || {};
  const vol = Number.isFinite(Number(c.chime_volume)) ? Math.max(0, Math.min(100, Number(c.chime_volume))) : 60;
  const rows = Number.isInteger(Number(c.max_rows)) && Number(c.max_rows) > 0 ? Math.min(20, Number(c.max_rows)) : 8;
  const colour = (id, label, v) => h('label', { style: 'font-size:13px;margin-right:12px' }, label, h('br'), h('input', { attrs: { type: 'color', id, value: v } }));
  const sel = h('select', { className: 'input', attrs: { id: 'wCurbLoc' } }, h('option', { attrs: { value: '' }, text: t('curbside.widget.loading') }));
  const volIn = h('input', { attrs: { type: 'range', id: 'wCurbVol', min: 0, max: 100, step: 5, value: vol }, style: 'flex:1' });
  const volOut = h('span', { style: 'font-size:13px;width:44px;text-align:right', text: `${vol}%` });
  volIn.addEventListener('input', () => { volOut.textContent = `${volIn.value}%`; });
  const when = h('select', { className: 'input', attrs: { id: 'wCurbWhen' }, style: 'max-width:260px' },
    h('option', { attrs: { value: 'ack' }, text: t('curbside.widget.when_ack') }),
    h('option', { attrs: { value: 'arrive' }, text: t('curbside.widget.when_arrive') }),
    h('option', { attrs: { value: 'both' }, text: t('curbside.widget.when_both') }));
  when.value = ['ack', 'arrive', 'both'].includes(c.chime_when) ? c.chime_when : 'ack';
  box.textContent = '';
  box.append(
    h('div', { className: 'form-group' }, h('label', { text: t('curbside.widget.location') }), sel,
      h('div', { style: 'font-size:12px;color:var(--text-muted);margin-top:4px', text: t('curbside.widget.location_hint') })),
    h('div', { className: 'form-group' }, h('label', { text: t('curbside.widget.rows') }),
      h('input', { className: 'input', attrs: { type: 'number', id: 'wCurbRows', min: 1, max: 20, value: rows }, style: 'width:100px' })),
    h('div', { className: 'form-group', style: 'display:flex;flex-wrap:wrap' },
      colour('wCurbBg', t('curbside.widget.background'), hex(c.background, '#0f172a')),
      colour('wCurbColor', t('curbside.widget.color'), hex(c.color, '#ffffff')),
      colour('wCurbAccent', t('curbside.widget.accent'), hex(c.accent, '#4ade80'))),
    h('div', { className: 'form-group' },
      h('label', { style: 'display:flex;align-items:center' }, h('input', { attrs: { type: 'checkbox', id: 'wCurbChime', checked: c.chime === true }, style: 'margin-right:8px' }), t('curbside.widget.chime')),
      h('div', { style: 'margin-top:6px' }, when),
      h('div', { style: 'display:flex;align-items:center;margin-top:6px' }, h('span', { style: 'font-size:13px;margin-right:8px', text: t('curbside.widget.volume') }), volIn, volOut),
      h('div', { style: 'font-size:12px;color:var(--text-muted);margin-top:4px', text: t('curbside.widget.chime_hint') })));
  try {
    const locs = await get('/curbside');
    sel.textContent = '';
    if (!locs.length) { sel.appendChild(h('option', { attrs: { value: '' }, text: t('curbside.widget.none') })); return; }
    sel.appendChild(h('option', { attrs: { value: '' }, text: t('curbside.widget.pick') }));
    for (const l of locs) sel.appendChild(h('option', { attrs: { value: l.id }, text: l.name }));
    sel.value = c.location_id && locs.some((l) => l.id === c.location_id) ? c.location_id : (locs.length === 1 ? locs[0].id : '');
  } catch (e) {
    sel.textContent = '';
    sel.appendChild(h('option', { attrs: { value: c.location_id || '' }, text: e.message }));
  }
}

export function readCurbsideConfig() {
  const v = (id) => document.getElementById(id);
  const rows = parseInt(v('wCurbRows')?.value, 10);
  return {
    location_id: v('wCurbLoc')?.value || '',
    max_rows: Number.isInteger(rows) ? Math.max(1, Math.min(20, rows)) : 8,
    background: v('wCurbBg')?.value || '#0f172a',
    color: v('wCurbColor')?.value || '#ffffff',
    accent: v('wCurbAccent')?.value || '#4ade80',
    chime: !!v('wCurbChime')?.checked,
    chime_when: v('wCurbWhen')?.value || 'ack',
    chime_volume: Math.max(0, Math.min(100, parseInt(v('wCurbVol')?.value, 10) || 0)),
  };
}
