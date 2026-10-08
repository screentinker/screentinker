// Menu board editor (widget_type 'menu-board'; server lib/menu-board.js). Mounted inside the widget
// modal by views/widgets.js: mountMenuEditor() renders into #wMenuEditor, readMenuConfig() returns
// the config to save. Item ids are kept stable because the sold-out API addresses items by id.

import { esc } from '../utils.js';
import { t } from '../i18n.js';
import { openContentPicker } from './content-picker.js';

const uid = (p) => p + Math.random().toString(36).slice(2, 9);
const item = (name, price, extra = {}) => ({ id: uid('i'), name, description: '', prices: [String(price)], tags: [], sold_out: false, ...extra });
const STARTERS = {
  cafe: () => ({
    title: 'Café', theme: 'light', price_labels: [],
    sections: [
      { id: uid('s'), name: 'Coffee', note: '', items: [item('Espresso', '2.80'), item('Flat white', '3.60'), item('Latte', '3.80', { tags: ['popular'] }), item('Oat milk', '0.50', { description: 'Add to any drink' })] },
      { id: uid('s'), name: 'Breakfast', note: 'Until 11:30', show_from: '07:00', show_until: '11:30', items: [item('Avocado toast', '8.50', { tags: ['vg'] }), item('Bacon roll', '6.00')] },
      { id: uid('s'), name: 'Cakes', note: '', items: [item('Banana bread', '3.20', { tags: ['v'] }), item('Lemon drizzle', '3.40', { tags: ['v', 'gf'] })] },
    ],
  }),
  burger: () => ({
    title: 'Burgers', theme: 'bold', price_labels: ['Single', 'Double'],
    sections: [
      { id: uid('s'), name: 'Burgers', note: 'Served with fries', items: [
        { ...item('Classic', '9.50'), prices: ['9.50', '12.50'] }, { ...item('Smokehouse', '11.00'), prices: ['11.00', '14.00'], tags: ['spicy'] },
        { ...item('Garden', '10.00'), prices: ['10.00', '13.00'], tags: ['vg'] }] },
      { id: uid('s'), name: 'Sides', note: '', items: [item('Fries', '3.50', { tags: ['vg'] }), item('Onion rings', '4.00', { tags: ['v'] })] },
      { id: uid('s'), name: 'Drinks', note: '', items: [item('Shake', '5.00'), item('Soft drink', '2.50')] },
    ],
  }),
  bar: () => ({
    title: 'Drinks', theme: 'dark', price_labels: ['Glass', 'Bottle'],
    sections: [
      { id: uid('s'), name: 'Wine', note: '', items: [{ ...item('House red', '6.50'), prices: ['6.50', '24.00'] }, { ...item('House white', '6.50'), prices: ['6.50', '24.00'] }] },
      { id: uid('s'), name: 'Beer', note: '', items: [{ ...item('Lager', '5.50'), prices: ['5.50'] }, item('IPA', '6.00', { tags: ['new'] })] },
      { id: uid('s'), name: 'Happy hour', note: '5–7 pm', show_from: '17:00', show_until: '19:00', items: [item('Two-for-one cocktails', '9.00')] },
    ],
  }),
};

let state = null;
let dataSources = [];

function defaults(c) {
  return {
    title: '', subtitle: '', footer: '', theme: 'dark', accent: '', currency: '$', currency_after: false, decimals: 2,
    price_labels: [], columns: 0, font_scale: 1, show_images: true, show_descriptions: true, sold_out: 'mark',
    page_seconds: 12, logo_url: '', background_url: '', source: null, sections: [],
    ...JSON.parse(JSON.stringify(c || {})),
  };
}

export async function mountMenuEditor(host, config, { apiGet }) {
  state = defaults(config);
  for (const s of state.sections) { s.id = s.id || uid('s'); for (const it of s.items || []) it.id = it.id || uid('i'); }
  try { dataSources = (await apiGet('/data-sources')) || []; if (!Array.isArray(dataSources)) dataSources = dataSources.data_sources || []; } catch { dataSources = []; }
  paint(host);
}

export function readMenuConfig() {
  const c = JSON.parse(JSON.stringify(state || defaults()));
  for (const s of c.sections || []) { delete s._open; for (const it of s.items || []) delete it._open; }
  if (c.accent === '') delete c.accent;
  return c;
}

function field(label, inner, hint = '') {
  return `<div class="form-group" style="flex:1;min-width:150px;margin-bottom:10px"><label>${esc(label)}</label>${inner}${hint ? `<div style="font-size:11px;color:var(--text-muted);margin-top:3px">${esc(hint)}</div>` : ''}</div>`;
}
const row = (...cells) => `<div style="display:flex;gap:12px;flex-wrap:wrap">${cells.join('')}</div>`;

function paint(host) {
  const s = state;
  const fromData = !!(s.source && s.source.slug);
  const empty = !fromData && !s.sections.length;
  host.innerHTML = `
    ${empty ? `<div class="form-group" style="padding:10px;border:1px dashed var(--border);border-radius:6px;background:var(--bg-input)">
      <div style="font-size:12px;margin-bottom:8px">${esc(t('menu.start_from'))}</div>
      ${Object.keys(STARTERS).map((k) => `<button type="button" class="btn btn-secondary btn-sm" data-starter="${k}" style="margin:0 6px 6px 0">${esc(t(`menu.starter.${k}`))}</button>`).join('')}
    </div>` : ''}
    ${row(field(t('menu.title'), `<input class="input" data-k="title" value="${esc(s.title)}">`),
          field(t('menu.subtitle'), `<input class="input" data-k="subtitle" value="${esc(s.subtitle)}">`))}
    ${row(field(t('menu.theme'), `<select class="input" data-k="theme">${['dark', 'light', 'chalkboard', 'bold'].map((th) => `<option value="${th}" ${s.theme === th ? 'selected' : ''}>${esc(t(`menu.theme.${th}`))}</option>`).join('')}</select>`),
          field(t('menu.accent'), `<input type="color" class="input" data-k="accent" value="${esc(s.accent || '#f59e0b')}" style="height:36px;padding:2px">`),
          field(t('menu.columns'), `<select class="input" data-k="columns">${[0, 1, 2, 3, 4].map((n) => `<option value="${n}" ${Number(s.columns) === n ? 'selected' : ''}>${n ? n : esc(t('menu.columns_auto'))}</option>`).join('')}</select>`),
          field(t('menu.text_size'), `<select class="input" data-k="font_scale">${[0.8, 0.9, 1, 1.15, 1.3, 1.5].map((n) => `<option value="${n}" ${Number(s.font_scale) === n ? 'selected' : ''}>${Math.round(n * 100)}%</option>`).join('')}</select>`))}
    ${row(field(t('menu.currency'), `<input class="input" data-k="currency" value="${esc(s.currency)}" style="max-width:90px">`),
          field(t('menu.decimals'), `<select class="input" data-k="decimals">${[0, 1, 2, 3].map((n) => `<option value="${n}" ${Number(s.decimals) === n ? 'selected' : ''}>${n}</option>`).join('')}</select>`),
          field(t('menu.price_labels'), `<input class="input" data-k="price_labels" value="${esc((s.price_labels || []).join(', '))}" placeholder="Small, Large">`, t('menu.price_labels_hint')))}
    <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:13px;margin:4px 0 12px">
      <label><input type="checkbox" data-k="currency_after" ${s.currency_after ? 'checked' : ''}> ${esc(t('menu.currency_after'))}</label>
      <label><input type="checkbox" data-k="show_images" ${s.show_images ? 'checked' : ''}> ${esc(t('menu.show_images'))}</label>
      <label><input type="checkbox" data-k="show_descriptions" ${s.show_descriptions ? 'checked' : ''}> ${esc(t('menu.show_descriptions'))}</label>
      <label>${esc(t('menu.sold_out_items'))} <select data-k="sold_out" class="input" style="width:auto;display:inline-block">
        <option value="mark" ${s.sold_out !== 'hide' ? 'selected' : ''}>${esc(t('menu.sold_out_mark'))}</option>
        <option value="hide" ${s.sold_out === 'hide' ? 'selected' : ''}>${esc(t('menu.sold_out_hide'))}</option></select></label>
      <label>${esc(t('menu.page_seconds'))} <input type="number" min="5" max="120" data-k="page_seconds" value="${esc(s.page_seconds)}" class="input" style="width:70px;display:inline-block"></label>
    </div>
    ${row(field(t('menu.logo'), imgPicker('logo_url', s.logo_url)), field(t('menu.background'), imgPicker('background_url', s.background_url)))}
    ${field(t('menu.footer'), `<input class="input" data-k="footer" value="${esc(s.footer)}" placeholder="${esc(t('menu.footer_ph'))}">`)}
    <div class="form-group" style="margin-top:6px">
      <label>${esc(t('menu.items_from'))}</label>
      <select class="input" id="mbSource">
        <option value="">${esc(t('menu.items_from_editor'))}</option>
        ${dataSources.map((d) => `<option value="${esc(d.slug)}" ${fromData && s.source.slug === d.slug ? 'selected' : ''}>${esc(t('menu.items_from_ds', { name: d.name || d.slug }))}</option>`).join('')}
      </select>
      ${fromData ? `<div style="font-size:12px;color:var(--text-muted);margin-top:6px">${esc(t('menu.ds_hint'))}</div>` : ''}
    </div>
    ${fromData ? '' : `<div id="mbSections">${s.sections.map(sectionHtml).join('')}</div>
      <button type="button" class="btn btn-secondary btn-sm" data-act="add-section">${esc(t('menu.add_section'))}</button>`}`;
  wire(host);
}

function imgPicker(key, url) {
  return url
    ? `<div style="display:flex;gap:8px;align-items:center"><span style="font-size:11px;color:var(--text-muted);word-break:break-all;flex:1">${esc(url)}</span>
        <button type="button" class="btn btn-secondary btn-sm" data-pick="${key}">${esc(t('menu.change'))}</button>
        <button type="button" class="btn-icon" data-clear="${key}" style="color:#ff6b6b">&#215;</button></div>`
    : `<button type="button" class="btn btn-secondary btn-sm" data-pick="${key}">${esc(t('menu.choose_image'))}</button>`;
}

function sectionHtml(sec, si) {
  return `<div class="mb-sec" data-si="${si}" style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:10px">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <input class="input" data-s="name" value="${esc(sec.name)}" placeholder="${esc(t('menu.section_name'))}" style="flex:2;min-width:140px;font-weight:600">
      <input class="input" data-s="note" value="${esc(sec.note || '')}" placeholder="${esc(t('menu.section_note'))}" style="flex:2;min-width:120px">
      <label style="font-size:12px;white-space:nowrap">${esc(t('menu.show'))} <input type="time" class="input" data-s="show_from" value="${esc(sec.show_from || '')}" style="width:auto;display:inline-block"> –
        <input type="time" class="input" data-s="show_until" value="${esc(sec.show_until || '')}" style="width:auto;display:inline-block"></label>
      <button type="button" class="btn btn-secondary btn-sm" data-act="sec-up" title="${esc(t('menu.move_up'))}">&#8593;</button>
      <button type="button" class="btn btn-secondary btn-sm" data-act="sec-down" title="${esc(t('menu.move_down'))}">&#8595;</button>
      <button type="button" class="btn btn-secondary btn-sm" data-act="sec-del" style="color:var(--danger)" title="${esc(t('menu.delete_section'))}">&#215;</button>
    </div>
    <div style="margin-top:8px;display:flex;flex-direction:column;gap:6px">${(sec.items || []).map((it, ii) => itemHtml(it, ii)).join('')}</div>
    <button type="button" class="btn btn-secondary btn-sm" data-act="add-item" style="margin-top:8px">${esc(t('menu.add_item'))}</button>
  </div>`;
}

function itemHtml(it, ii) {
  return `<div class="mb-it" data-ii="${ii}" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:6px;background:var(--bg-input);border-radius:6px">
    <input class="input" data-i="name" value="${esc(it.name)}" placeholder="${esc(t('menu.item_name'))}" style="flex:2;min-width:120px">
    <input class="input" data-i="prices" value="${esc((it.prices || []).join(', '))}" placeholder="${esc(t('menu.item_price'))}" style="width:110px">
    <input class="input" data-i="tags" value="${esc((it.tags || []).join(', '))}" placeholder="${esc(t('menu.item_tags'))}" style="width:110px" title="${esc(t('menu.item_tags_hint'))}">
    <label style="font-size:12px;white-space:nowrap"><input type="checkbox" data-i="sold_out" ${it.sold_out ? 'checked' : ''}> ${esc(t('menu.sold_out'))}</label>
    <button type="button" class="btn btn-secondary btn-sm" data-act="it-img" title="${esc(t('menu.item_photo'))}">${it.image_url ? '&#128247;&#10003;' : '&#128247;'}</button>
    <button type="button" class="btn btn-secondary btn-sm" data-act="it-up">&#8593;</button>
    <button type="button" class="btn btn-secondary btn-sm" data-act="it-down">&#8595;</button>
    <button type="button" class="btn btn-secondary btn-sm" data-act="it-del" style="color:var(--danger)">&#215;</button>
    <input class="input" data-i="description" value="${esc(it.description || '')}" placeholder="${esc(t('menu.item_description'))}" style="flex-basis:100%">
  </div>`;
}

function move(arr, i, d) { const j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; }
const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

function wire(host) {
  host.querySelectorAll('[data-starter]').forEach((b) => b.addEventListener('click', () => {
    Object.assign(state, STARTERS[b.dataset.starter]());
    paint(host);
  }));
  host.querySelectorAll('[data-k]').forEach((el) => {
    const k = el.dataset.k;
    el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
      if (el.type === 'checkbox') state[k] = el.checked;
      else if (k === 'price_labels') state[k] = list(el.value);
      else if (['columns', 'decimals', 'page_seconds'].includes(k)) state[k] = parseInt(el.value, 10) || 0;
      else if (k === 'font_scale') state[k] = Number(el.value) || 1;
      else state[k] = el.value;
    });
  });
  host.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', async () => {
    const url = await openContentPicker({ multiple: false, title: t('menu.choose_image') });
    if (url) { state[b.dataset.pick] = url; paint(host); }
  }));
  host.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', () => { state[b.dataset.clear] = ''; paint(host); }));
  const src = host.querySelector('#mbSource');
  if (src) src.addEventListener('change', () => { state.source = src.value ? { slug: src.value } : null; paint(host); });
  const addSec = host.querySelector('[data-act="add-section"]');
  if (addSec) addSec.addEventListener('click', () => { state.sections.push({ id: uid('s'), name: '', note: '', items: [] }); paint(host); });

  host.querySelectorAll('.mb-sec').forEach((secEl) => {
    const si = Number(secEl.dataset.si);
    const sec = state.sections[si];
    secEl.querySelectorAll('[data-s]').forEach((el) => el.addEventListener('input', () => { sec[el.dataset.s] = el.value; }));
    secEl.querySelector('[data-act="sec-up"]').addEventListener('click', () => { move(state.sections, si, -1); paint(host); });
    secEl.querySelector('[data-act="sec-down"]').addEventListener('click', () => { move(state.sections, si, 1); paint(host); });
    secEl.querySelector('[data-act="sec-del"]').addEventListener('click', () => {
      if (sec.items.length && !confirm(t('menu.confirm_delete_section', { name: sec.name || '' }))) return;
      state.sections.splice(si, 1); paint(host);
    });
    secEl.querySelector('[data-act="add-item"]').addEventListener('click', () => { sec.items.push(item('', '')); sec.items[sec.items.length - 1].prices = []; paint(host); });
    secEl.querySelectorAll('.mb-it').forEach((itEl) => {
      const ii = Number(itEl.dataset.ii);
      const it = sec.items[ii];
      itEl.querySelectorAll('[data-i]').forEach((el) => el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
        const k = el.dataset.i;
        if (k === 'sold_out') it.sold_out = el.checked;
        else if (k === 'prices' || k === 'tags') it[k] = list(el.value);
        else it[k] = el.value;
      }));
      itEl.querySelector('[data-act="it-up"]').addEventListener('click', () => { move(sec.items, ii, -1); paint(host); });
      itEl.querySelector('[data-act="it-down"]').addEventListener('click', () => { move(sec.items, ii, 1); paint(host); });
      itEl.querySelector('[data-act="it-del"]').addEventListener('click', () => { sec.items.splice(ii, 1); paint(host); });
      itEl.querySelector('[data-act="it-img"]').addEventListener('click', async () => {
        if (it.image_url && confirm(t('menu.remove_photo'))) { it.image_url = ''; paint(host); return; }
        const url = await openContentPicker({ multiple: false, title: t('menu.item_photo') });
        if (url) { it.image_url = url; paint(host); }
      });
    });
  });
}
