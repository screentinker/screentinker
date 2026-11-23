import { api, getAuthHeaders, browserTimezone } from '../api.js';
import { showToast } from '../components/toast.js';
import { canWrite } from '../utils.js';
import { t } from '../i18n.js';
import { isPrivateHost } from '../components/private-host.js';
import { openModal } from '../components/corporate-ui.js';
import { h, renderArrivals } from '../lib/curbside-dom.js';

/*
 * Curbside pickup (server: routes/curbside.js, lib/curbside/service.js, docs/curbside-pickup.md).
 *
 * One card per location: the cars waiting (with "We got you" and "Done" for members who can write),
 * the QR sheet (one code per spot), the customer link, "Show on a screen", the staff link (writers
 * only: the server never sends it to a read-only member), the settings (name, timezone, spots) and
 * every customer-facing and screen text, each with its default shown. Polls every 4 s.
 *
 * ⚠️ BUILT WITH DOM NODES ONLY. Location names, spot labels, order numbers, notes and the admin's
 * texts are all set with textContent / value; this view never assigns innerHTML with any of them.
 */

const POLL_MS = 4000;
let timer = null;
let locations = [];
let fetchedAt = 0;
let appEl = null;         // the container render() drew into, for a re-render when the set of locations changes

const abs = (p) => `${location.origin}${p}`;

// Labels for the editable texts (server: lib/curbside/texts.js). Order = the order shown.
const TEXT_LABELS = {
  heading: 'curbside.text.heading', intro: 'curbside.text.intro', spot_label: 'curbside.text.spot_label',
  choose_spot: 'curbside.text.choose_spot', order_label: 'curbside.text.order_label', note_label: 'curbside.text.note_label',
  button: 'curbside.text.button', waiting: 'curbside.text.waiting', seen: 'curbside.text.seen', done: 'curbside.text.done',
  spot_taken: 'curbside.text.spot_taken', cancel: 'curbside.text.cancel', cancelled: 'curbside.text.cancelled',
  again: 'curbside.text.again', keep_open: 'curbside.text.keep_open',
  widget_heading: 'curbside.text.widget_heading', widget_order: 'curbside.text.widget_order', widget_spot: 'curbside.text.widget_spot',
  widget_waiting: 'curbside.text.widget_waiting', widget_seen: 'curbside.text.widget_seen', widget_empty: 'curbside.text.widget_empty',
};

const STYLE = `
.cs-car{display:flex;align-items:center;flex-wrap:wrap;border:1px solid var(--border);border-left:6px solid #16a34a;border-radius:10px;padding:10px 12px;margin-bottom:8px}
.cs-car.warm{border-left-color:#ca8a04}.cs-car.late{border-left-color:#dc2626}
.cs-spot{text-align:center;min-width:64px;margin-right:12px}.cs-spot-l{display:block;font-size:11px;color:var(--text-muted);text-transform:uppercase}
.cs-spot b{font-size:30px;line-height:1}.cs-main{flex:1;min-width:140px}.cs-order b{font-size:20px}
.cs-note{font-size:13px;margin-top:2px;word-break:break-word}.cs-meta{font-size:13px;margin-top:4px}
.cs-age{font-weight:700;margin-right:10px}.cs-age.fresh{color:#16a34a}.cs-age.warm{color:#ca8a04}.cs-age.late{color:#dc2626}
.cs-status{color:var(--text-muted)}.cs-status.seen{color:#16a34a;font-weight:700}
.cs-actions{display:flex;flex-wrap:wrap}.cs-actions .btn{margin:2px 0 2px 6px}
.cs-empty{color:var(--text-muted);font-size:14px;padding:8px 0}
.cs-row{display:flex;flex-wrap:wrap;align-items:center}.cs-row>*{margin:0 8px 8px 0}
.cs-grid{display:grid;grid-template-columns:minmax(160px,1fr) 2fr;max-width:760px}.cs-grid>*{margin:0 8px 8px 0}
.cs-hint{font-size:12px;color:var(--text-muted)}`;

function ensureStyle() {
  if (document.getElementById('cs-dash-style')) return;
  const s = document.createElement('style');
  s.id = 'cs-dash-style';
  s.textContent = STYLE;
  document.head.appendChild(s);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); showToast(t('curbside.dash.copied'), 'success'); }
  catch { window.prompt(t('curbside.dash.copy'), text); }
}

async function qrSheet(loc) {
  const r = await fetch(`/api/curbside/${encodeURIComponent(loc.id)}/qr-sheet?origin=${encodeURIComponent(location.origin)}`, { headers: getAuthHeaders(), cache: 'no-store' });
  if (!r.ok) throw new Error(t('curbside.dash.qr_failed'));
  return r.json();
}

// An SVG drawn by this server's QR library, shown as an <img>: an image never runs script.
const svgImg = (doc, svg) => {
  const img = doc.createElement('img');
  img.alt = '';
  // security-ok(url-sink): a data: URI built here from this server's own QR SVG, loaded by an <img>, which never runs script
  img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(String(svg))));
  return img;
};

/** The printable QR sheet: one card per spot with the location name, the spot and a short instruction. */
async function printSheet(loc) {
  let sheet;
  try { sheet = await qrSheet(loc); } catch (e) { showToast(e.message, 'error'); return; }
  const w = window.open('', '_blank');
  if (!w) { showToast(t('curbside.dash.popup_blocked'), 'error'); return; }
  const d = w.document;
  d.title = sheet.name || '';
  const style = d.createElement('style');
  style.textContent = `body{font-family:system-ui,sans-serif;margin:0;padding:8mm;color:#000}
    .sheet{display:grid;grid-template-columns:1fr 1fr}
    .card{border:1px dashed #999;border-radius:6mm;padding:8mm;margin:3mm;text-align:center;page-break-inside:avoid;break-inside:avoid}
    .loc{font-size:16pt;font-weight:600;margin:0 0 2mm}.head{font-size:12pt;color:#333;margin:0 0 4mm}
    .spot{font-size:12pt;text-transform:uppercase;letter-spacing:.1em;color:#333}.spot b{display:block;font-size:54pt;line-height:1;letter-spacing:0;color:#000}
    img{width:62mm;height:62mm;margin:4mm auto;display:block}.how{font-size:12pt;margin:0}
    @page{margin:8mm}`;
  d.head.appendChild(style);
  const grid = d.createElement('div');
  grid.className = 'sheet';
  for (const c of sheet.codes || []) {
    const card = d.createElement('div');
    card.className = 'card';
    const p = (cls, text) => { const e = d.createElement('p'); e.className = cls; e.textContent = text; return e; };
    card.appendChild(p('loc', sheet.name || ''));
    card.appendChild(p('head', sheet.heading || ''));
    const spot = d.createElement('div');
    spot.className = 'spot';
    spot.appendChild(d.createTextNode(sheet.spot_label || ''));
    const b = d.createElement('b'); b.textContent = c.spot; spot.appendChild(b);
    card.appendChild(spot);
    card.appendChild(svgImg(d, c.svg));
    card.appendChild(p('how', t('curbside.print.scan')));
    grid.appendChild(card);
  }
  d.body.appendChild(grid);
  setTimeout(() => { try { w.focus(); w.print(); } catch { /* the person can print from the tab */ } }, 400);
}

const widgetLocationId = (w) => {
  let c = w && w.config;
  if (typeof c === 'string') { try { c = JSON.parse(c); } catch { c = null; } }
  return c && c.location_id != null ? String(c.location_id) : null;
};

async function curbsideWidget(loc) {
  const all = await api.get('/widgets');
  const found = (Array.isArray(all) ? all : []).find((w) => w.widget_type === 'curbside' && w.workspace_id && widgetLocationId(w) === String(loc.id));
  if (found) return { widget: found, created: false };
  const widget = await api.post('/widgets', { widget_type: 'curbside', name: t('curbside.show.widget_name', { name: loc.name }), config: { location_id: loc.id } });
  return { widget, created: true };
}

/** "Show on a screen": the location's Curbside widget, added to a playlist the person picks. */
async function showOnScreen(loc) {
  const m = openModal({ title: t('curbside.show.title'), body: '<div data-f="box"></div>', footer: '<div data-f="foot"></div>' });
  const box = m.q('[data-f="box"]');
  const foot = m.q('[data-f="foot"]');
  foot.append(
    h('a', { className: 'btn btn-secondary', attrs: { href: '#/widgets' }, text: t('curbside.show.edit_widget'), on: { click: m.close } }),
    ' ',
    h('button', { className: 'btn btn-primary', attrs: { type: 'button' }, text: t('common.done'), on: { click: m.close } }));
  const state = h('p', { style: 'margin:0 0 12px', text: t('curbside.show.loading') });
  box.appendChild(state);
  let widget;
  try {
    const r = await curbsideWidget(loc);
    widget = r.widget;
    state.textContent = t(r.created ? 'curbside.show.created' : 'curbside.show.found', { name: widget.name });
  } catch (e) { state.textContent = e.message; state.style.color = 'var(--danger)'; return; }
  let pls = [];
  try { pls = await api.getPlaylists(); } catch { pls = []; }
  pls = Array.isArray(pls) ? pls : [];
  const msg = h('div', { style: 'font-size:13px;margin-top:8px;min-height:18px' });
  if (!pls.length) {
    box.append(msg);
    msg.append(t('curbside.show.no_playlists'), ' ', h('a', { attrs: { href: '#/playlists' }, text: t('nav.playlists'), on: { click: m.close } }));
    return;
  }
  const sel = h('select', { className: 'input', style: 'flex:1;min-width:180px' },
    h('option', { attrs: { value: '' }, text: t('templates.choose_playlist') }),
    pls.map((p) => h('option', { attrs: { value: p.id }, text: p.name })));
  const add = h('button', { className: 'btn btn-primary btn-sm', attrs: { type: 'button', disabled: true }, text: t('templates.add_to_playlist') });
  sel.addEventListener('change', () => { add.disabled = !sel.value; msg.textContent = ''; });
  add.addEventListener('click', async () => {
    add.disabled = true;
    try {
      await api.addPlaylistItem(sel.value, { widget_id: widget.id });
      const pl = pls.find((p) => String(p.id) === sel.value);
      msg.textContent = '';
      msg.append(t('templates.added_to_playlist_draft', { name: pl ? pl.name : '' }), ' ',
        h('a', { attrs: { href: `#/playlists/${encodeURIComponent(sel.value)}` }, text: t('templates.open_playlist'), on: { click: m.close } }));
    } catch (e) { add.disabled = false; msg.textContent = e.message; }
  });
  box.append(
    h('label', { style: 'font-size:13px;display:block;margin-bottom:6px', text: t('curbside.show.pick') }),
    h('div', { className: 'cs-row' }, sel, add),
    msg,
    h('p', { className: 'cs-hint', style: 'margin:12px 0 0', text: t('curbside.show.hint') }));
}

function openStaff(loc) {
  const key = String(loc.staff_path || '').split('#')[1] || '';
  // security-ok(url-sink): this origin plus the fixed /curbside-staff path; the only dynamic part is the fragment
  window.open(`${location.origin}/curbside-staff#${encodeURIComponent(key)}`, '_blank', 'noopener,noreferrer');
}

function staffBox(loc, run) {
  const box = h('div', { className: 'cs-row' });
  if (loc.staff_path) {
    box.append(
      h('code', { style: 'font-size:12px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block', text: `${abs('/curbside-staff')}#…` }),
      h('button', { className: 'btn btn-secondary btn-sm', attrs: { type: 'button' }, text: t('curbside.dash.copy'), on: { click: () => copy(abs(loc.staff_path)) } }),
      h('button', { className: 'btn btn-secondary btn-sm', attrs: { type: 'button' }, text: t('curbside.dash.open'), on: { click: () => openStaff(loc) } }),
      h('button', { className: 'btn btn-secondary btn-sm', attrs: { type: 'button' }, text: t('curbside.dash.rotate'), on: { click: () => { if (confirm(t('curbside.dash.rotate_confirm'))) run(() => api.post(`/curbside/${loc.id}/staff-link`)); } } }),
      h('button', { className: 'btn btn-danger btn-sm', attrs: { type: 'button' }, text: t('curbside.dash.revoke'), on: { click: () => { if (confirm(t('curbside.dash.revoke_confirm'))) run(() => api.delete(`/curbside/${loc.id}/staff-link`)); } } }));
  } else {
    box.append(
      h('span', { style: 'font-size:13px;color:var(--text-muted)', text: t('curbside.dash.staff_off') }),
      h('button', { className: 'btn btn-secondary btn-sm', attrs: { type: 'button' }, text: t('curbside.dash.make_staff'), on: { click: () => run(() => api.post(`/curbside/${loc.id}/staff-link`)) } }));
  }
  return box;
}

function settingsBox(loc, run, app) {
  const name = h('input', { className: 'input', attrs: { maxlength: 80 } }); name.value = loc.name;
  const tz = h('input', { className: 'input' }); tz.value = loc.timezone;
  const spots = h('textarea', { className: 'input', attrs: { rows: 3 } }); spots.value = (loc.spots || []).join(', ');
  const count = h('input', { className: 'input', attrs: { type: 'number', min: 1, max: 200 }, style: 'width:90px' });
  const save = async () => {
    if (await run(() => api.put(`/curbside/${loc.id}`, { name: name.value.trim(), timezone: tz.value.trim(), spots: spots.value }))) {
      showToast(t('curbside.dash.saved'), 'success');
      render(app);
    }
  };
  return h('details', { style: 'margin-top:10px' },
    h('summary', { style: 'cursor:pointer;font-size:14px', text: t('curbside.dash.settings') }),
    h('div', { style: 'display:grid;max-width:520px;margin-top:8px' },
      h('label', { style: 'font-size:13px;margin-bottom:8px' }, t('curbside.dash.f_name'), name),
      h('label', { style: 'font-size:13px' }, t('curbside.dash.f_tz'), tz),
      h('div', { className: 'cs-hint', style: 'margin-bottom:8px', text: t('curbside.dash.f_tz_hint') }),
      h('label', { style: 'font-size:13px' }, t('curbside.dash.f_spots'), spots),
      h('div', { className: 'cs-hint', style: 'margin-bottom:6px', text: t('curbside.dash.f_spots_hint') }),
      h('div', { className: 'cs-row' },
        h('span', { style: 'font-size:13px', text: t('curbside.dash.f_count') }), count,
        h('button', { className: 'btn btn-secondary btn-sm', attrs: { type: 'button' }, text: t('curbside.dash.f_count_make'), on: { click: () => {
          const n = parseInt(count.value, 10);
          if (!Number.isInteger(n) || n < 1 || n > 200) { showToast(t('curbside.dash.f_count_invalid'), 'error'); return; }
          spots.value = Array.from({ length: n }, (_, i) => String(i + 1)).join(', ');
        } } })),
      h('div', { className: 'cs-row' },
        h('button', { className: 'btn btn-primary btn-sm', attrs: { type: 'button' }, text: t('common.save'), on: { click: save } }),
        h('button', { className: 'btn btn-secondary btn-sm', attrs: { type: 'button' }, text: t('curbside.dash.rotate_customer'), on: { click: () => { if (confirm(t('curbside.dash.rotate_customer_confirm'))) run(() => api.post(`/curbside/${loc.id}/customer-link`)); } } }),
        h('button', { className: 'btn btn-danger btn-sm', attrs: { type: 'button' }, text: t('curbside.dash.delete'), on: { click: async () => {
          if (!confirm(t('curbside.dash.delete_confirm', { name: loc.name }))) return;
          try { await api.delete(`/curbside/${loc.id}`); render(app); } catch (e) { showToast(e.message, 'error'); }
        } } }))));
}

function textsBox(loc, run) {
  const defaults = loc.text_defaults || {};
  const max = loc.text_max || {};
  const inputs = {};
  const row = (k) => {
    const long = (max[k] || 0) > 100;
    const el = long ? h('textarea', { className: 'input', attrs: { rows: 2, maxlength: max[k] || 300 } }) : h('input', { className: 'input', attrs: { maxlength: max[k] || 60 } });
    el.placeholder = defaults[k] || '';
    el.value = (loc.texts && loc.texts[k]) || '';
    inputs[k] = el;
    return [h('label', { style: 'font-size:13px;align-self:center', text: t(TEXT_LABELS[k] || 'curbside.text.other') }), el];
  };
  const keys = Object.keys(TEXT_LABELS).filter((k) => k in defaults);
  const save = async () => {
    const out = {};
    for (const k of keys) out[k] = inputs[k].value;
    if (await run(() => api.put(`/curbside/${loc.id}`, { texts: out }))) showToast(t('curbside.dash.saved'), 'success');
  };
  return h('details', { style: 'margin-top:10px' },
    h('summary', { style: 'cursor:pointer;font-size:14px', text: t('curbside.dash.texts') }),
    h('p', { className: 'cs-hint', text: t('curbside.dash.texts_hint') }),
    h('h4', { style: 'margin:10px 0 6px;font-size:13px', text: t('curbside.dash.texts_customer') }),
    h('div', { className: 'cs-grid' }, keys.filter((k) => !k.startsWith('widget_')).map(row)),
    h('h4', { style: 'margin:10px 0 6px;font-size:13px', text: t('curbside.dash.texts_widget') }),
    h('div', { className: 'cs-grid' }, keys.filter((k) => k.startsWith('widget_')).map(row)),
    h('div', { className: 'cs-row' },
      h('button', { className: 'btn btn-primary btn-sm', attrs: { type: 'button' }, text: t('curbside.dash.texts_save'), on: { click: save } }),
      h('button', { className: 'btn btn-secondary btn-sm', attrs: { type: 'button' }, text: t('curbside.dash.texts_reset'), on: { click: () => {
        if (!confirm(t('curbside.dash.texts_reset_confirm'))) return;
        for (const k of keys) inputs[k].value = '';
        save();
      } } })));
}

function subText(loc) {
  return t('curbside.dash.sub', { waiting: (loc.arrivals || []).length, done: loc.done_today || 0, spots: (loc.spots || []).length, tz: loc.timezone });
}

function card(app, loc0) {
  const id = loc0.id;
  const w = loc0.can_write;
  const get = () => locations.find((x) => x.id === id) || loc0;
  const sub = h('div', { style: 'font-size:13px;color:var(--text-muted)', text: subText(loc0) });
  const list = h('div', { style: 'margin-top:12px' });
  const err = h('div', { style: 'color:var(--danger);font-size:13px;min-height:16px;margin-top:8px' });
  const staffHolder = h('div');
  const el = h('div', { className: 'corp-card', dataset: { id }, style: 'margin-bottom:16px;padding:16px' });
  let busy = false;
  const update = (loc) => {
    sub.textContent = subText(loc);
    renderArrivals(list, loc.arrivals, {
      serverNow: loc.now, fetchedAt, canAct: w, busy,
      onAck: (a) => run(() => api.post(`/curbside/${id}/ack`, { id: a.id })),
      onDone: (a) => run(() => api.post(`/curbside/${id}/done`, { id: a.id })),
    });
    if (w) {
      const key = loc.staff_path || '';
      if (staffHolder.dataset.key !== key || !staffHolder.firstChild) {
        staffHolder.dataset.key = key;
        staffHolder.textContent = '';
        staffHolder.appendChild(staffBox(loc, run));
      }
    }
  };
  async function run(fn) {
    err.textContent = '';
    busy = true; update(get());
    let ok = false;
    try {
      const loc = await fn();
      if (loc && loc.id) { fetchedAt = Date.now(); locations = locations.map((x) => (x.id === loc.id ? loc : x)); }
      ok = true;
    } catch (e) { err.textContent = e.message; }
    finally { busy = false; update(get()); }
    return ok;
  }
  el.update = update;
  el.append(
    h('div', { className: 'cs-row', style: 'justify-content:space-between' },
      h('div', {}, h('h3', { style: 'margin:0 0 4px', text: loc0.name }), sub),
      h('div', { className: 'cs-row' },
        h('button', { className: 'btn btn-secondary btn-sm', attrs: { type: 'button' }, text: t('curbside.dash.print'), on: { click: () => printSheet(get()) } }),
        h('button', { className: 'btn btn-secondary btn-sm', attrs: { type: 'button' }, text: t('curbside.dash.copy_customer'), on: { click: () => copy(abs(get().customer_path)) } }),
        w ? h('button', { className: 'btn btn-secondary btn-sm', attrs: { type: 'button' }, text: t('curbside.show.button'), on: { click: () => showOnScreen(get()) } }) : null)),
    list,
    w ? h('div', { style: 'margin-top:16px;padding-top:12px;border-top:1px solid var(--border)' },
      h('strong', { style: 'font-size:14px', text: t('curbside.dash.staff_link') }),
      h('div', { className: 'cs-hint', style: 'margin:4px 0 8px', text: t('curbside.dash.staff_link_hint') }),
      staffHolder) : null,
    w ? settingsBox(loc0, run, app) : null,
    w ? textsBox(loc0, run) : null,
    err);
  update(loc0);
  return el;
}

async function refresh() {
  try {
    const fresh = await api.get('/curbside');
    // Another admin added or deleted a location: draw the page again (a plain update has no card for it).
    if (fresh.length !== locations.length || fresh.some((l, i) => l.id !== locations[i].id)) {
      if (appEl && appEl.isConnected) render(appEl);
      return;
    }
    locations = fresh; fetchedAt = Date.now();
    for (const l of locations) {
      const el = document.querySelector(`.corp-card[data-id="${CSS.escape(l.id)}"]`);
      if (el && el.update) el.update(l);
    }
  } catch { /* keep what is shown; the next poll tries again */ }
}

async function createLocation(app) {
  const name = prompt(t('curbside.dash.new_name'), t('curbside.dash.new_default'));
  if (name === null) return;
  const spots = prompt(t('curbside.dash.new_spots'), '10');
  if (spots === null) return;
  const s = spots.trim();
  const body = { name: name.trim() || t('curbside.dash.new_default'), timezone: browserTimezone() };
  if (/^\d+$/.test(s)) body.spots_count = parseInt(s, 10); else body.spots = s;
  try { await api.post('/curbside', body); render(app); }
  catch (e) { showToast(e.message, 'error'); }
}

export async function render(app) {
  cleanup();
  appEl = app;
  ensureStyle();
  app.textContent = '';
  const body = h('div');
  app.append(
    h('div', { className: 'page-header' }, h('div', {},
      h('h1', { text: t('nav.curbside') }),
      h('div', { className: 'subtitle', text: t('curbside.dash.intro') }))),
    body);
  try { locations = await api.get('/curbside'); fetchedAt = Date.now(); }
  catch (e) { body.append(h('p', { className: 'corp-notice corp-notice-danger', text: e.message })); return; }
  if (canWrite()) {
    body.append(h('div', { className: 'corp-toolbar' },
      h('button', { className: `btn ${locations.length ? 'btn-secondary' : 'btn-primary'}`, attrs: { type: 'button', id: 'curbsideNew' }, text: t('curbside.dash.new'), on: { click: () => createLocation(app) } })));
  } else {
    body.append(h('p', { className: 'corp-notice', text: t('common.read_only_note') }));
  }
  if (!locations.length) body.append(h('div', { className: 'corp-empty', text: t('curbside.dash.empty') }));
  for (const l of locations) body.append(card(app, l));
  if (isPrivateHost(location.hostname)) body.append(h('p', { style: 'font-size:12px;color:#ca8a04;margin-top:12px', text: t('qr.private_origin', { origin: location.origin }) }));
  body.append(h('p', { style: 'font-size:13px;color:var(--text-muted);margin-top:12px', text: t('curbside.dash.widget_hint') }));
  // Polls even with no location yet, so one another admin creates appears here.
  timer = setInterval(refresh, POLL_MS);
}

export function cleanup() {
  if (timer) { clearInterval(timer); timer = null; }
}
