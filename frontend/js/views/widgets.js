import { showToast } from '../components/toast.js';
import { t } from '../i18n.js';
import { hydrateAuthImages } from '../utils.js';

const API = (url, opts = {}) => fetch('/api' + url, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}`, ...opts.headers }, ...opts }).then(r => r.json());

// Widget type ids only — name + desc are looked up via t() so they switch
// language with the rest of the UI.
const WIDGET_TYPES = ['clock', 'weather', 'rss', 'text', 'webpage', 'social', 'directory-board', 'directory-search', 'transition'];
const WIDGET_ICONS = {
  clock: '&#128339;',
  weather: '&#9925;',
  rss: '&#128240;',
  text: '&#128221;',
  webpage: '&#127760;',
  social: '&#128172;',
  'directory-board': '&#127970;',
  'directory-search': '&#128269;',
  transition: '&#127916;',
};
const widgetTypeName = (id) => t(`widget.type.${id.replace(/-/g, '_')}.name`);
const widgetTypeDesc = (id) => t(`widget.type.${id.replace(/-/g, '_')}.desc`);

function escAttr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Directory-board bulk import: tolerant parser for JSON, CSV/TSV/pipe/semicolon
// tables, or a sectioned "room name" text list. Returns { meta, categories,
// background_images, warnings, stats }. Pure (no DOM) — unit-tested in node. ---
function _diPick(o, keys) {
  if (!o || typeof o !== 'object') return undefined;
  const low = {};
  for (const k of Object.keys(o)) low[k.toLowerCase()] = o[k];
  for (const k of keys) { const v = low[k]; if (v != null && v !== '') return v; }
  return undefined;
}
function _diBool(v) {
  if (v === true) return true;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === 'y' || s === '1' || s === 'available' || s === 'open' || s === 'vacant';
}
function _diEntry(e) {
  if (e == null) return null;
  if (typeof e === 'string' || typeof e === 'number') return { identifier: '', name: String(e).trim(), subtitle: '', available: false };
  const id = _diPick(e, ['room', 'identifier', 'id', 'number', 'no', 'suite', 'unit', 'office', 'space']);
  const name = _diPick(e, ['name', 'title', 'company', 'tenant', 'business', 'label', 'text']);
  const sub = _diPick(e, ['subtitle', 'details', 'detail', 'description', 'desc', 'note', 'notes', 'info']);
  const avail = _diPick(e, ['available', 'vacant', 'is_available', 'open', 'status']);
  return {
    identifier: id == null ? '' : String(id).trim(),
    name: name == null ? '' : String(name).trim(),
    subtitle: sub == null ? '' : String(sub).trim(),
    available: avail == null ? false : _diBool(avail),
  };
}
const _DI_META_ARRAY_KEYS = new Set(['advertisements', 'ads', 'announcements', 'backgroundimages', 'background_images', 'backgrounds']);
function _diNormalizeJson(data) {
  const meta = {}; const warnings = [];
  const title = _diPick(data, ['company', 'title', 'name', 'building', 'property']);
  if (title != null) meta.title = String(title).trim();
  let footer = _diPick(data, ['footer_text', 'footer', 'footertext', 'leasing', 'contact']);
  const ads = data.advertisements || data.ads || data.announcements;
  if (footer == null && Array.isArray(ads)) footer = ads.map(a => (typeof a === 'string' ? a : _diPick(a, ['text', 'message', 'content']))).filter(Boolean).join('   •   ');
  if (footer) meta.footer_text = String(footer).trim();
  const theme = _diPick(data, ['theme']); if (theme) meta.theme = String(theme).toLowerCase();
  const speed = _diPick(data, ['scroll_speed', 'scrollspeed', 'speed']); if (speed) meta.scroll_speed = String(speed).toLowerCase();
  const cols = _diPick(data, ['columns', 'cols']); if (cols != null) meta.columns = String(cols).toLowerCase();
  const logo = _diPick(data, ['logo_url', 'logo', 'logourl']); if (logo) meta.logo_url = String(logo);
  const bgSrc = data.background_images || data.backgroundImages || data.backgrounds || [];
  const background_images = []; let skippedBg = 0;
  if (Array.isArray(bgSrc)) for (const b of bgSrc) {
    const s = typeof b === 'string' ? b : _diPick(b, ['url', 'src', 'path']);
    if (!s) continue;
    if (/^(https?:)?\/\//i.test(s) || String(s).startsWith('/')) background_images.push(String(s)); else skippedBg++;
  }
  if (skippedBg) warnings.push(t('widget.dir.import_warn_bg', { n: skippedBg }));
  let categories = [];
  const mapCat = (c) => ({ name: String(_diPick(c, ['name', 'title', 'floor', 'category', 'section', 'label']) || '').trim(), entries: (c.entries || c.tenants || c.items || c.rooms || []).map(_diEntry).filter(Boolean) });
  const tbf = data.tenantsByFloor || data.byfloor || data.tenantsbyfloor || data.sections;
  if (tbf && typeof tbf === 'object' && !Array.isArray(tbf)) categories = Object.keys(tbf).map(fn => ({ name: fn, entries: (Array.isArray(tbf[fn]) ? tbf[fn] : []).map(_diEntry).filter(Boolean) }));
  else if (Array.isArray(data.categories)) categories = data.categories.map(mapCat);
  else if (Array.isArray(data.floors)) categories = data.floors.map(mapCat);
  else if (Array.isArray(data)) {
    if (data.some(x => x && typeof x === 'object' && (x.entries || x.tenants || x.items || x.rooms))) categories = data.map(mapCat);
    else categories = [{ name: '', entries: data.map(_diEntry).filter(Boolean) }];
  } else {
    const floorKeys = Object.keys(data).filter(k => Array.isArray(data[k]) && !_DI_META_ARRAY_KEYS.has(k.toLowerCase()));
    if (floorKeys.length) categories = floorKeys.map(fn => ({ name: fn, entries: data[fn].map(_diEntry).filter(Boolean) }));
  }
  return { meta, categories, background_images, warnings };
}
function _diSplit(line, delim) {
  if (delim !== ',' && delim !== ';') return line.split(delim);
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur); return out;
}
const _DI_HEAD = {
  floor: ['floor', 'category', 'section', 'level', 'wing', 'building', 'group'],
  id: ['room', 'suite', 'unit', 'id', 'number', 'no', 'no.', 'office', 'space', '#'],
  name: ['name', 'tenant', 'company', 'business', 'title', 'occupant'],
  sub: ['subtitle', 'details', 'detail', 'description', 'desc', 'note', 'notes', 'info'],
  avail: ['available', 'vacant', 'status', 'open'],
};
function _diHeaderRole(cell) {
  const c = cell.trim().toLowerCase();
  for (const role of Object.keys(_DI_HEAD)) if (_DI_HEAD[role].includes(c)) return role;
  return null;
}
function _diParseTable(lines, delim, warnings) {
  const rows = lines.map(l => _diSplit(l, delim).map(c => c.trim()));
  const first = rows[0] || [];
  const roles = first.map(_diHeaderRole);
  const hasHeader = roles.filter(Boolean).length >= 2 || (roles.includes('name') && rows.length > 1);
  const idx = { floor: -1, id: -1, name: -1, sub: -1, avail: -1 };
  let body = rows;
  if (hasHeader) { roles.forEach((r, i) => { if (r && idx[r] === -1) idx[r] = i; }); body = rows.slice(1); }
  else {
    const n = Math.max(...rows.map(r => r.length));
    if (n <= 2) { idx.id = 0; idx.name = 1; }
    else if (n === 3) { idx.id = 0; idx.name = 1; idx.sub = 2; }
    else { idx.floor = 0; idx.id = 1; idx.name = 2; idx.sub = 3; }
    warnings.push(t('widget.dir.import_warn_noheader'));
  }
  if (idx.name === -1 && idx.id === -1) { idx.id = 0; idx.name = 1; }
  const cats = new Map();
  const getCat = (nm) => { const k = nm || ''; if (!cats.has(k)) cats.set(k, { name: k, entries: [] }); return cats.get(k); };
  for (const r of body) {
    if (!r.length || r.every(c => c === '')) continue;
    const cell = (i) => (i >= 0 && i < r.length ? r[i] : '');
    const e = { identifier: cell(idx.id), name: idx.name >= 0 ? cell(idx.name) : '', subtitle: idx.sub >= 0 ? cell(idx.sub) : '', available: idx.avail >= 0 ? _diBool(cell(idx.avail)) : false };
    if (!e.identifier && !e.name) continue;
    getCat(idx.floor >= 0 ? cell(idx.floor) : '').entries.push(e);
  }
  return { meta: {}, categories: [...cats.values()], background_images: [], warnings };
}
function _diHeading(line) {
  const l = line.trim();
  if (/:$/.test(l)) return l.replace(/:$/, '').trim();
  if (/^#{1,6}\s+/.test(l)) return l.replace(/^#{1,6}\s+/, '').trim();
  if (/^\[.+\]$/.test(l)) return l.slice(1, -1).trim();
  if (/^=+\s*(.+?)\s*=+$/.test(l)) return l.replace(/^=+\s*/, '').replace(/\s*=+$/, '').trim();
  if (/^-{3,}\s*(.+?)\s*-{3,}$/.test(l)) return l.replace(/^-+\s*/, '').replace(/\s*-+$/, '').trim();
  if (!/^\W*\d/.test(l) && /\b(floor|level|suite|section|wing|building)\b/i.test(l) && l.split(/\s+/).length <= 4) return l;
  return null;
}
function _diParseSectioned(lines, warnings) {
  const cats = []; let cur = null;
  const ensure = () => { if (!cur) { cur = { name: '', entries: [] }; cats.push(cur); } return cur; };
  for (const raw of lines) {
    const heading = _diHeading(raw);
    if (heading != null) { cur = { name: heading, entries: [] }; cats.push(cur); continue; }
    const l = raw.trim();
    const m = l.match(/^(#?\d+[A-Za-z]?)[\s.)\-:–—|]+(.+)$/);
    const e = m ? { identifier: m[1].replace(/^#/, ''), name: m[2].trim(), subtitle: '', available: false }
                : { identifier: '', name: l, subtitle: '', available: false };
    if (e.identifier || e.name) ensure().entries.push(e);
  }
  if (!(cats.length > 1 || cats.some(c => c.name))) warnings.push(t('widget.dir.import_warn_nosections'));
  return { meta: {}, categories: cats, background_images: [], warnings };
}
function _diParseDelimited(raw) {
  const warnings = [];
  const lines = raw.split(/\r?\n/).map(l => l.replace(/\s+$/, '')).filter(l => l.trim() !== '');
  if (!lines.length) throw new Error(t('widget.dir.import_err_empty'));
  const sample = lines.slice(0, 12);
  let delim = null, best = 1;
  for (const d of ['\t', ',', ';', '|']) {
    const counts = sample.map(l => _diSplit(l, d).length);
    const withCols = counts.filter(c => c >= 2).length;
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
    if (withCols >= Math.ceil(sample.length * 0.6) && avg > best) { best = avg; delim = d; }
  }
  return delim ? _diParseTable(lines, delim, warnings) : _diParseSectioned(lines, warnings);
}
function parseDirectoryImport(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) throw new Error(t('widget.dir.import_err_empty'));
  let json = null;
  if (/^[[{]/.test(raw)) { try { json = JSON.parse(raw); } catch (e) { /* not JSON */ } }
  const res = (json && typeof json === 'object') ? _diNormalizeJson(json) : _diParseDelimited(raw);
  res.categories = (res.categories || [])
    .map(c => ({ name: String(c.name || '').trim(), entries: (c.entries || []).filter(e => (e.identifier || '').trim() || (e.name || '').trim()) }))
    .filter(c => c.name || c.entries.length);
  if (!res.categories.length) throw new Error(t('widget.dir.import_err_norows'));
  res.stats = { categories: res.categories.length, entries: res.categories.reduce((n, c) => n + c.entries.length, 0) };
  return res;
}

function openContentPicker({ multiple = false, title } = {}) {
  return new Promise(async (resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:10000;padding:16px';
    overlay.innerHTML = `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:20px;width:100%;max-width:640px;max-height:90vh;display:flex;flex-direction:column">
        <h3 style="margin:0 0 12px;color:var(--text-primary)">${title || t('widget.picker.default_title')}</h3>
        <input type="text" id="cpSearch" class="input" placeholder="${t('widget.picker.search')}" style="margin-bottom:12px">
        <div id="cpList" style="flex:1;overflow-y:auto;min-height:200px"></div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;gap:8px;flex-wrap:wrap">
          <div style="font-size:12px;color:var(--text-muted)" id="cpSelCount"></div>
          <div style="display:flex;gap:8px;margin-left:auto">
            <button class="btn btn-secondary" id="cpCancel">${t('common.cancel')}</button>
            ${multiple ? `<button class="btn btn-primary" id="cpDone">${t('common.done')}</button>` : ''}
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    let items = [];
    try { items = await API('/content'); } catch {}
    items = (items || []).filter(i => (i.mime_type || '').startsWith('image/'));

    const selected = new Set();
    const resolveUrl = (item) => item.remote_url || `/api/content/${item.id}/file`;
    const updateCount = () => {
      const el = overlay.querySelector('#cpSelCount');
      if (el && multiple) el.textContent = t('widget.picker.selected_count', { n: selected.size });
    };

    function renderList() {
      const q = (overlay.querySelector('#cpSearch').value || '').toLowerCase();
      const filtered = items.filter(i => (i.filename || '').toLowerCase().includes(q));
      const list = overlay.querySelector('#cpList');
      if (!filtered.length) {
        list.innerHTML = `<div style="color:var(--text-muted);padding:32px;text-align:center;font-size:13px">${items.length ? t('widget.picker.no_matches') : t('widget.picker.no_images')}</div>`;
        return;
      }
      list.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px">${
        filtered.map(c => {
          const isSel = selected.has(c.id);
          const isRemote = !!c.remote_url;
          const thumb = c.remote_url || `/api/content/${c.id}/thumbnail`;
          return `
            <div data-pick-id="${escAttr(c.id)}" style="position:relative;cursor:pointer;border-radius:6px;overflow:hidden;border:2px solid ${isSel ? 'var(--primary, #4a7cff)' : 'transparent'};aspect-ratio:4/3;background:var(--bg-input)">
              <img ${isRemote ? `src="${escAttr(thumb)}"` : `data-auth-src="${escAttr(thumb)}"`} style="width:100%;height:100%;object-fit:cover" loading="lazy" onerror="this.style.opacity='0.2'">
              <div style="position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,0.75);color:#fff;padding:4px 6px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escAttr(c.filename)}</div>
              ${isSel ? '<div style="position:absolute;top:6px;right:6px;width:22px;height:22px;background:var(--primary, #4a7cff);color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;line-height:1">&#10003;</div>' : ''}
            </div>`;
        }).join('')
      }</div>`;
      hydrateAuthImages(list, { eager: true });
      list.querySelectorAll('[data-pick-id]').forEach(el => el.onclick = () => {
        const id = el.dataset.pickId;
        if (multiple) {
          if (selected.has(id)) selected.delete(id); else selected.add(id);
          updateCount();
          renderList();
        } else {
          const item = items.find(x => String(x.id) === id);
          if (item) { cleanup(); resolve(resolveUrl(item)); }
        }
      });
    }

    function cleanup() { overlay.remove(); }

    overlay.querySelector('#cpSearch').oninput = renderList;
    overlay.querySelector('#cpCancel').onclick = () => { cleanup(); resolve(multiple ? [] : null); };
    if (multiple) {
      overlay.querySelector('#cpDone').onclick = () => {
        const urls = Array.from(selected).map(id => {
          const item = items.find(x => String(x.id) === id);
          return item ? resolveUrl(item) : null;
        }).filter(Boolean);
        cleanup();
        resolve(urls);
      };
    }
    overlay.onclick = (e) => { if (e.target === overlay) { cleanup(); resolve(multiple ? [] : null); } };
    updateCount();
    renderList();
  });
}

function showPreviewModal(sessionId, widgetType) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:10000;padding:16px';
  // #104: webpage widgets pointing at frame-denying sites (X-Frame-Options) can't be
  // embedded in a browser preview — and an XFO refusal is provably indistinguishable
  // client-side from a working embed, so we don't guess. Always show the honest note.
  const webpageNote = widgetType === 'webpage'
    ? `<div style="padding:8px 16px;border-top:1px solid var(--border);color:var(--text-secondary);font-size:13px;text-align:center">${t('widget.webpage_blocked_note')}</div>`
    : '';
  overlay.innerHTML = `
    <div style="width:100%;max-width:1400px;height:90vh;background:var(--bg-card);border-radius:8px;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--border)">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid var(--border)">
        <strong style="color:var(--text-primary)">${t('widget.preview_title')}</strong>
        <button class="btn btn-secondary btn-sm" id="pvClose">${t('widget.close')}</button>
      </div>
      <iframe id="pvIframe" sandbox="allow-scripts" style="flex:1;width:100%;border:0;background:#000"></iframe>
      ${webpageNote}
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#pvIframe').src = '/api/widgets/preview-session/' + sessionId;
  const close = () => overlay.remove();
  overlay.querySelector('#pvClose').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', function esc(ev) {
    if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
}

export async function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div><h1>${t('widget.title')} <span class="help-tip" data-tip="${t('widget.help_tip')}">?</span></h1><div class="subtitle">${t('widget.subtitle')}</div></div>
      <button class="btn btn-primary" id="newWidgetBtn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        ${t('widget.new_widget')}
      </button>
    </div>
    <div id="widgetTypeGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:24px;display:none">
      ${WIDGET_TYPES.map(id => `
        <div class="content-item" style="cursor:pointer" data-create-type="${id}">
          <div style="padding:20px;text-align:center">
            <div style="font-size:36px;margin-bottom:8px">${WIDGET_ICONS[id]}</div>
            <div style="font-weight:600;font-size:14px">${widgetTypeName(id)}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${widgetTypeDesc(id)}</div>
          </div>
        </div>
      `).join('')}
    </div>
    <div class="content-grid" id="widgetGrid"></div>

    <!-- Widget Config Modal -->
    <div class="modal-overlay" id="widgetModal" style="display:none">
      <div class="modal" style="width:560px">
        <div class="modal-header"><h3 id="widgetModalTitle">${t('widget.configure')}</h3>
          <button class="btn-icon" onclick="document.getElementById('widgetModal').style.display='none'">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="modal-body" id="widgetConfigForm"></div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="document.getElementById('widgetModal').style.display='none'">${t('common.cancel')}</button>
          <button class="btn btn-secondary" id="previewWidgetBtn">${t('widget.preview')}</button>
          <button class="btn btn-primary" id="saveWidgetBtn">${t('common.save')}</button>
        </div>
      </div>
    </div>
  `;

  let editingWidget = null;
  let creatingType = null;
  let dirState = { categories: [], logo_url: '', background_images: [] };
  // Cached widget list from the last load — used to populate the directory-search
  // source-board dropdown without a second fetch.
  let loadedWidgets = [];

  document.getElementById('newWidgetBtn').onclick = () => {
    const grid = document.getElementById('widgetTypeGrid');
    grid.style.display = grid.style.display === 'none' ? 'grid' : 'none';
  };

  container.querySelectorAll('[data-create-type]').forEach(el => {
    el.onclick = () => {
      creatingType = el.dataset.createType;
      editingWidget = null;
      document.getElementById('widgetTypeGrid').style.display = 'none';
      showConfigForm(creatingType, {});
    };
  });

  function showConfigForm(type, config) {
    const typeName = widgetTypeName(type);
    document.getElementById('widgetModalTitle').textContent = editingWidget
      ? t('widget.edit_x', { type: typeName })
      : t('widget.new_x', { type: typeName });

    let html = `<div class="form-group"><label>${t('widget.field.name')}</label><input type="text" id="wName" class="input" value="${escAttr(config._name || typeName)}"></div>`;

    switch (type) {
      case 'clock':
        html += `
          <div class="form-group"><label>${t('widget.field.format')}</label><select id="wFormat" class="input" style="background:var(--bg-input)"><option value="12h" ${config.format === '12h' ? 'selected' : ''}>${t('widget.field.format_12h')}</option><option value="24h" ${config.format === '24h' ? 'selected' : ''}>${t('widget.field.format_24h')}</option></select></div>
          <div class="form-group"><label>${t('widget.field.timezone')}</label><input type="text" id="wTimezone" class="input" value="${config.timezone || 'America/Chicago'}" placeholder="America/New_York"></div>
          <div class="form-group"><label>${t('widget.field.font_size_px')}</label><input type="number" id="wFontSize" class="input" value="${config.font_size || 64}"></div>
          <div class="form-group"><label>${t('widget.field.color')}</label><input type="color" id="wColor" value="${config.color || '#FFFFFF'}" style="width:60px;height:32px;border:none"></div>
          <div class="form-group"><label>${t('widget.field.background')}</label><input type="color" id="wBg" value="${config.background || '#000000'}" style="width:60px;height:32px;border:none"></div>`;
        break;
      case 'weather':
        html += `
          <div class="form-group"><label>${t('widget.field.location')}</label><input type="text" id="wLocation" class="input" value="${config.location || ''}" placeholder="${t('widget.field.location_placeholder')}"></div>
          <div class="form-group"><label>${t('widget.field.units')}</label><select id="wUnits" class="input" style="background:var(--bg-input)"><option value="imperial" ${config.units !== 'metric' ? 'selected' : ''}>${t('widget.field.units_imperial')}</option><option value="metric" ${config.units === 'metric' ? 'selected' : ''}>${t('widget.field.units_metric')}</option></select></div>
          <div class="form-group"><label>${t('widget.field.font_size')}</label><input type="number" id="wFontSize" class="input" value="${config.font_size || 48}"></div>
          <div class="form-group"><label>${t('widget.field.color')}</label><input type="color" id="wColor" value="${config.color || '#FFFFFF'}" style="width:60px;height:32px;border:none"></div>`;
        break;
      case 'rss':
        html += `
          <div class="form-group"><label>${t('widget.field.feed_url')}</label><input type="text" id="wFeedUrl" class="input" value="${config.feed_url || ''}" placeholder="https://example.com/feed.xml"></div>
          <div class="form-group"><label>${t('widget.field.scroll_speed_seconds')}</label><input type="number" id="wScrollSpeed" class="input" value="${config.scroll_speed || 30}"></div>
          <div class="form-group"><label>${t('widget.field.max_items')}</label><input type="number" id="wMaxItems" class="input" value="${config.max_items || 10}"></div>
          <div class="form-group"><label>${t('widget.field.font_size')}</label><input type="number" id="wFontSize" class="input" value="${config.font_size || 24}"></div>
          <div class="form-group"><label>${t('widget.field.color')}</label><input type="color" id="wColor" value="${config.color || '#FFFFFF'}" style="width:60px;height:32px;border:none"></div>
          <div class="form-group"><label>${t('widget.field.background')}</label><input type="color" id="wBg" value="${config.background || '#000000'}" style="width:60px;height:32px;border:none"></div>`;
        break;
      case 'text':
        html += `
          <div class="form-group"><label>${t('widget.field.html_content')}</label><textarea id="wHtml" class="input" rows="6" style="font-family:monospace;font-size:12px">${config.html || '<h1 style="color:white;text-align:center;margin-top:40px">Hello World</h1>'}</textarea></div>
          <div class="form-group"><label>${t('widget.field.css_optional')}</label><textarea id="wCss" class="input" rows="3" style="font-family:monospace;font-size:12px">${config.css || ''}</textarea></div>
          <div class="form-group"><label>${t('widget.field.background')}</label><input type="color" id="wBg" value="${config.background || '#000000'}" style="width:60px;height:32px;border:none"></div>`;
        break;
      case 'webpage':
        html += `
          <div class="form-group"><label>${t('widget.field.url')}</label><input type="text" id="wUrl" class="input" value="${config.url || ''}" placeholder="https://example.com"></div>
          <div class="form-group"><label>${t('widget.field.zoom_pct')}</label><input type="number" id="wZoom" class="input" value="${config.zoom || 100}"></div>
          <div class="form-group"><label>${t('widget.field.refresh_interval')}</label><input type="number" id="wRefresh" class="input" value="${config.refresh_interval || 0}"></div>`;
        break;
      case 'social':
        html += `
          <div class="form-group"><label>${t('widget.field.platform')}</label><select id="wPlatform" class="input" style="background:var(--bg-input)"><option value="twitter">${t('widget.field.platform_twitter')}</option><option value="instagram">${t('widget.field.platform_instagram')}</option></select></div>
          <div class="form-group"><label>${t('widget.field.query')}</label><input type="text" id="wQuery" class="input" value="${config.query || ''}" placeholder="${t('widget.field.query_placeholder')}"></div>`;
        break;
      case 'directory-board':
        html += `
          <div class="form-group" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px;border:1px dashed var(--border);border-radius:6px;background:var(--bg-input)">
            <button type="button" class="btn btn-secondary btn-sm" id="dbImportData">${t('widget.dir.import_btn')}</button>
            <span style="font-size:11px;color:var(--text-muted);flex:1;min-width:160px">${t('widget.dir.import_hint')}</span>
          </div>
          <div class="form-group"><label>${t('widget.dir.title_label')}</label><input type="text" id="wTitle" class="input" value="${escAttr(config.title)}" placeholder="${t('widget.dir.title_placeholder')}"></div>
          <div class="form-group"><label>${t('widget.dir.logo_label')}</label><div id="wLogoBox"></div></div>
          <div class="form-group"><label>${t('widget.dir.footer_text_label')}</label><input type="text" id="wFooter" class="input" value="${escAttr(config.footer_text)}" placeholder="${t('widget.dir.footer_placeholder')}"></div>
          <div class="form-group">
            <label>${t('widget.dir.bg_images_label')}</label>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">${t('widget.dir.bg_images_hint')}</div>
            <div id="wBgList"></div>
            <button type="button" class="btn btn-secondary btn-sm" id="wBgAdd" style="margin-top:8px">${t('widget.dir.add_bg_image')}</button>
          </div>
          <div class="form-group" style="display:flex;gap:12px;flex-wrap:wrap">
            <div style="flex:1;min-width:140px"><label>${t('widget.dir.theme')}</label><select id="wTheme" class="input" style="background:var(--bg-input)">
              <option value="dark" ${!config.theme || config.theme === 'dark' ? 'selected' : ''}>${t('widget.dir.theme_dark')}</option>
              <option value="light" ${config.theme === 'light' ? 'selected' : ''}>${t('widget.dir.theme_light')}</option>
            </select></div>
            <div style="flex:1;min-width:140px"><label>${t('widget.dir.scroll_speed')}</label><select id="wSpeed" class="input" style="background:var(--bg-input)">
              <option value="slow" ${config.scroll_speed === 'slow' ? 'selected' : ''}>${t('widget.dir.speed_slow')}</option>
              <option value="medium" ${!config.scroll_speed || config.scroll_speed === 'medium' ? 'selected' : ''}>${t('widget.dir.speed_medium')}</option>
              <option value="fast" ${config.scroll_speed === 'fast' ? 'selected' : ''}>${t('widget.dir.speed_fast')}</option>
            </select></div>
            <div style="flex:1;min-width:140px"><label>${t('widget.dir.columns')}</label><select id="wCols" class="input" style="background:var(--bg-input)">
              <option value="auto" ${!config.columns || config.columns === 'auto' ? 'selected' : ''}>${t('widget.dir.columns_auto')}</option>
              <option value="1" ${config.columns === '1' ? 'selected' : ''}>1</option>
              <option value="2" ${config.columns === '2' ? 'selected' : ''}>2</option>
              <option value="3" ${config.columns === '3' ? 'selected' : ''}>3</option>
              <option value="4" ${config.columns === '4' ? 'selected' : ''}>4</option>
            </select></div>
          </div>
          <div class="form-group">
            <label>${t('widget.dir.categories')}</label>
            <div id="dbCategories"></div>
            <button type="button" class="btn btn-secondary btn-sm" id="dbAddCategory" style="margin-top:10px">${t('widget.dir.add_category')}</button>
          </div>`;
        break;
      case 'directory-search': {
        const boards = (loadedWidgets || []).filter(w => w.widget_type === 'directory-board');
        const sourceField = boards.length
          ? `<select id="wSource" class="input" style="background:var(--bg-input)">
               ${boards.map(w => `<option value="${escAttr(w.id)}" ${config.source_widget_id === w.id ? 'selected' : ''}>${escAttr(w.name)}</option>`).join('')}
             </select>
             <div style="font-size:11px;color:var(--text-muted);margin-top:6px">${t('widget.dirsearch.source_hint')}</div>`
          : `<div style="font-size:13px;color:var(--text-muted);padding:10px;border:1px dashed var(--border);border-radius:6px">${t('widget.dirsearch.source_empty')}</div>`;
        html += `
          <div class="form-group"><label>${t('widget.dirsearch.source_label')}</label>${sourceField}</div>
          <div class="form-group"><label>${t('widget.dirsearch.title_label')}</label><input type="text" id="wTitle" class="input" value="${escAttr(config.title)}" placeholder="${t('widget.dirsearch.title_placeholder')}"></div>
          <div class="form-group"><label>${t('widget.dirsearch.logo_label')}</label><div id="wLogoBox"></div></div>
          <div class="form-group"><label>${t('widget.dirsearch.placeholder_label')}</label><input type="text" id="wPlaceholder" class="input" value="${escAttr(config.placeholder_text)}" placeholder="${t('widget.dirsearch.placeholder_hint')}"></div>
          <div class="form-group" style="max-width:220px"><label>${t('widget.dirsearch.theme')}</label><select id="wTheme" class="input" style="background:var(--bg-input)">
            <option value="dark" ${!config.theme || config.theme === 'dark' ? 'selected' : ''}>${t('widget.dir.theme_dark')}</option>
            <option value="light" ${config.theme === 'light' ? 'selected' : ''}>${t('widget.dir.theme_light')}</option>
          </select></div>
          <div class="form-group"><label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" id="wKeyboard" ${config.show_onscreen_keyboard === false ? '' : 'checked'}> ${t('widget.dirsearch.keyboard_label')}</label></div>`;
        break;
      }
      case 'transition':
        html += `
          <div class="form-group"><label>${t('widget.trans.shader')}</label>
            <div id="wTransList" style="max-height:158px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:4px;background:var(--bg-input)"></div>
            <div class="hint" style="font-size:11px;color:var(--text-muted);margin-top:6px">${t('widget.trans.multi_hint')}</div>
            <div id="wTransBlurb" style="font-size:11px;color:var(--text-muted);margin-top:4px"></div></div>
          <div class="form-group">
            <div style="position:relative;background:#000;border-radius:8px;overflow:hidden;aspect-ratio:16/9">
              <canvas id="wTransCanvas" style="width:100%;height:100%;display:block"></canvas>
            </div>
            <div style="display:flex;align-items:center;gap:10px;margin-top:8px">
              <button type="button" id="wTransPlay" class="btn btn-secondary" style="min-width:84px">${t('widget.trans.play')}</button>
              <input type="range" id="wTransScrub" min="0" max="1000" value="0" style="flex:1;accent-color:var(--accent)">
            </div>
            <div id="wTransProgress" style="font-size:11px;color:var(--text-muted);text-align:right;margin-top:2px">0.00</div>
          </div>
          <div class="form-group"><label>${t('widget.trans.params')}</label><div id="wTransParams"></div></div>
          <div class="form-group" style="max-width:220px"><label>${t('widget.trans.duration')}</label>
            <input type="number" id="wTransDuration" class="input" value="${config.durationMs || 800}" min="150" max="3000" step="50"></div>
          <div class="form-group" style="max-width:300px"><label>${t('widget.trans.scope')}</label>
            <select id="wTransScope" class="input" style="background:var(--bg-input)">
              <option value="next" ${config.scope !== 'all' ? 'selected' : ''}>${t('widget.trans.scope_next')}</option>
              <option value="all" ${config.scope === 'all' ? 'selected' : ''}>${t('widget.trans.scope_all')}</option>
            </select>
            <div style="font-size:11px;color:var(--text-muted);margin-top:6px">${t('widget.trans.scope_hint')}</div></div>`;
        break;
    }

    document.getElementById('widgetConfigForm').innerHTML = html;
    const modalEl = document.querySelector('#widgetModal .modal');
    if (modalEl) modalEl.style.width = type === 'directory-board' ? '720px' : (type === 'transition' ? '620px' : '560px');
    document.getElementById('widgetModal').style.display = 'flex';
    // Transitions carry their own live preview, so the iframe "Preview" button doesn't apply.
    const pvBtn = document.getElementById('previewWidgetBtn');
    if (pvBtn) pvBtn.style.display = (type === 'transition') ? 'none' : '';

    if (type === 'directory-board') {
      dirState.logo_url = config.logo_url || '';
      dirState.background_images = Array.isArray(config.background_images) ? config.background_images.slice() : [];
      dirState.categories = (config.categories || []).map(cat => ({
        name: cat.name || '',
        _expanded: false,
        entries: (cat.entries || []).map(e => ({
          identifier: e.identifier || '',
          name: e.name || '',
          subtitle: e.subtitle || '',
          available: !!e.available,
        })),
      }));
      renderLogoPicker();
      renderBgList();
      renderDirCategories();
      document.getElementById('dbAddCategory').onclick = () => {
        dirState.categories.push({ name: '', _expanded: true, entries: [] });
        renderDirCategories({ focusCatName: dirState.categories.length - 1 });
      };
      document.getElementById('wBgAdd').onclick = pickBgImages;
      document.getElementById('dbImportData').onclick = openDirImport;
    }

    if (type === 'directory-search') {
      // Reuse the board's logo picker box (#wLogoBox + dirState.logo_url).
      dirState.logo_url = config.logo_url || '';
      renderLogoPicker();
    }

    if (type === 'transition') initTransitionForm(config);
  }

  // Live transition picker: a CHECKLIST of effects (pick one or several — the player randomizes among
  // the chosen set per advance), a WebGL preview of the focused effect crossing two placeholder images,
  // param sliders (from the shader's declared ranges) + duration + scope. Uses the same runtime the
  // player ships (/player/transitions.js), so the preview IS the shipping renderer.
  let transState = { renderer: null, from: null, to: null, raf: 0, playing: false, t0: 0, params: {}, focus: null };
  function ensureTransitionRuntime() {
    if (window.TransitionRenderer && window.__TRANSITION_MANIFEST) return Promise.resolve(true);
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = '/player/transitions.js';
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
  }
  function transPlaceholder(color, label) {
    const c = document.createElement('canvas'); c.width = 640; c.height = 360;
    const cx = c.getContext('2d');
    const g = cx.createLinearGradient(0, 0, 640, 360);
    g.addColorStop(0, color[0]); g.addColorStop(1, color[1]); cx.fillStyle = g; cx.fillRect(0, 0, 640, 360);
    cx.fillStyle = 'rgba(255,255,255,.9)'; cx.textBaseline = 'middle';
    cx.font = '700 64px system-ui,sans-serif'; cx.fillText(label, 44, 176);
    return c;
  }
  async function initTransitionForm(config) {
    const canvas = document.getElementById('wTransCanvas');
    const list = document.getElementById('wTransList');
    const blurb = document.getElementById('wTransBlurb');
    const scrub = document.getElementById('wTransScrub');
    const progLbl = document.getElementById('wTransProgress');
    const playBtn = document.getElementById('wTransPlay');
    const paramsBox = document.getElementById('wTransParams');
    if (!canvas || !list) return;

    const ready = await ensureTransitionRuntime();
    if (!ready || !window.__TRANSITION_MANIFEST) { blurb.textContent = t('widget.trans.unavailable'); return; }
    const MAN = window.__TRANSITION_MANIFEST;
    const byId = (id) => MAN.find((x) => x.id === id);

    // initial selection: config.shaders, else legacy single config.shader, else the first effect
    const initialSel = (Array.isArray(config.shaders) && config.shaders.length ? config.shaders
      : (config.shader ? [config.shader] : [MAN[0].id])).filter(byId);
    transState.params = {}; // id -> resolved param values (lazily seeded)

    canvas.width = 640; canvas.height = 360;
    try {
      transState.renderer = window.TransitionRenderer.createRenderer(canvas, window.TransitionParams, { preserveDrawingBuffer: true });
      transState.from = transPlaceholder(['#f97316', '#b91c1c'], 'A');
      transState.to = transPlaceholder(['#0ea5e9', '#155e75'], 'B');
      transState.renderer.setFrom(transState.from);
      transState.renderer.setTo(transState.to);
    } catch (e) { blurb.textContent = t('widget.trans.unavailable'); return; }

    const paramsFor = (id) => {
      if (transState.params[id]) return transState.params[id];
      const m = byId(id);
      const stored = (config.params && config.params[id]) || (config.shader === id && config.params) || {};
      transState.params[id] = window.TransitionParams.resolveParams(
        m.params.map((pp) => ({ name: pp.name, default: pp.default, min: pp.min, max: pp.max })), stored);
      return transState.params[id];
    };
    const render = () => {
      if (!transState.focus) return;
      const p = (+scrub.value) / 1000; progLbl.textContent = p.toFixed(2);
      try { transState.renderer.render(p, paramsFor(transState.focus)); } catch (e) {}
    };
    const buildSliders = (id) => {
      const m = byId(id), vals = paramsFor(id);
      paramsBox.innerHTML = '';
      m.params.forEach((pp) => {
        const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:6px';
        const lab = document.createElement('label'); lab.textContent = pp.name; lab.style.cssText = 'font-size:12px;color:var(--text-muted);min-width:104px';
        const r = document.createElement('input'); r.type = 'range'; r.min = pp.min; r.max = pp.max; r.step = (pp.max - pp.min) / 200 || 0.001; r.value = vals[pp.name]; r.style.cssText = 'flex:1;accent-color:var(--accent)';
        const v = document.createElement('span'); v.textContent = (+vals[pp.name]).toFixed(2); v.style.cssText = 'font:600 11px ui-monospace,monospace;color:var(--text-muted);min-width:44px;text-align:right';
        r.oninput = () => { vals[pp.name] = +r.value; v.textContent = (+r.value).toFixed(2); render(); };
        row.appendChild(lab); row.appendChild(r); row.appendChild(v); paramsBox.appendChild(row);
      });
    };
    const focusShader = (id) => {
      transState.focus = id;
      const m = byId(id); blurb.textContent = m ? (m.blurb || '') : '';
      list.querySelectorAll('[data-focus]').forEach((el) => { el.style.fontWeight = el.dataset.focus === id ? '700' : '400'; });
      try { transState.renderer.setShader(window.__TRANSITION_SHADERS[id]); }
      catch (e) { blurb.textContent = t('widget.trans.compile_error'); return; }
      buildSliders(id); render();
    };

    list.innerHTML = MAN.map((m) => `
      <label style="display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:6px;cursor:pointer">
        <input type="checkbox" data-id="${escAttr(m.id)}" ${initialSel.includes(m.id) ? 'checked' : ''}>
        <span data-focus="${escAttr(m.id)}" style="flex:1">${escAttr(m.name)}</span>
      </label>`).join('');
    list.querySelectorAll('input[type=checkbox]').forEach((cb) => {
      cb.onchange = () => { if (cb.checked) focusShader(cb.dataset.id); };
    });
    // clicking the NAME previews/tunes it; preventDefault so the label doesn't also toggle its checkbox
    list.querySelectorAll('[data-focus]').forEach((sp) => { sp.onclick = (e) => { e.preventDefault(); focusShader(sp.dataset.focus); }; });
    scrub.oninput = render;

    // auto-play loop (eased, with holds); auto-stops when the modal closes (canvas leaves the DOM)
    const DUR = 1600, HOLD = 500;
    const loop = (ts) => {
      if (!document.body.contains(canvas)) { transState.playing = false; return; }
      if (!transState.t0) transState.t0 = ts;
      const cycle = DUR + HOLD * 2, e = (ts - transState.t0) % cycle;
      let p = e < HOLD ? 0 : e > HOLD + DUR ? 1 : (e - HOLD) / DUR;
      p = p <= 0 ? 0 : p >= 1 ? 1 : (1 - Math.cos(p * Math.PI)) / 2;
      scrub.value = Math.round(p * 1000); render();
      if (transState.playing) transState.raf = requestAnimationFrame(loop);
    };
    playBtn.onclick = () => {
      transState.playing = !transState.playing;
      playBtn.textContent = transState.playing ? t('widget.trans.pause') : t('widget.trans.play');
      if (transState.playing) { transState.t0 = 0; transState.raf = requestAnimationFrame(loop); }
      else cancelAnimationFrame(transState.raf);
    };
    focusShader(initialSel[0] || MAN[0].id);
  }

  function renderDirCategories(opts = {}) {
    const cont = document.getElementById('dbCategories');
    if (!cont) return;
    if (!dirState.categories.length) {
      cont.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-muted);border:1px dashed var(--border);border-radius:6px;font-size:13px">${t('widget.dir.empty_categories')}</div>`;
      return;
    }
    cont.innerHTML = dirState.categories.map((cat, i) => {
      const entryRows = (cat.entries || []).map((e, j) => `
        <div class="db-entry" style="display:flex;gap:6px;align-items:flex-start;margin-bottom:8px;flex-wrap:wrap">
          <input type="text" class="input" data-entry-id="${i}-${j}" value="${escAttr(e.identifier)}" placeholder="${t('widget.dir.entry_id_placeholder')}" style="width:90px">
          <div style="display:flex;flex-direction:column;gap:4px;flex:1;min-width:140px">
            <input type="text" class="input" data-entry-name="${i}-${j}" value="${escAttr(e.name)}" placeholder="${t('widget.dir.entry_name_placeholder')}">
            <input type="text" class="input" data-entry-subtitle="${i}-${j}" value="${escAttr(e.subtitle)}" placeholder="${t('widget.dir.entry_subtitle_placeholder')}" style="font-size:12px">
          </div>
          <label style="display:flex;align-items:center;gap:4px;font-size:12px;white-space:nowrap;color:var(--text-muted);padding-top:8px">
            <input type="checkbox" data-entry-avail="${i}-${j}" ${e.available ? 'checked' : ''}> ${t('widget.dir.available')}
          </label>
          <button type="button" class="btn-icon" data-entry-up="${i}-${j}" ${j === 0 ? 'disabled' : ''} title="${t('widget.dir.move_up')}" style="padding:4px 6px">&#8593;</button>
          <button type="button" class="btn-icon" data-entry-down="${i}-${j}" ${j === cat.entries.length - 1 ? 'disabled' : ''} title="${t('widget.dir.move_down')}" style="padding:4px 6px">&#8595;</button>
          <button type="button" class="btn-icon" data-entry-delete="${i}-${j}" title="${t('widget.dir.delete_entry')}" style="padding:4px 6px;color:#ff6b6b">&#215;</button>
        </div>
      `).join('');

      const entryCount = cat.entries.length;
      const entriesLabel = entryCount === 1 ? t('widget.dir.entry') : t('widget.dir.entries');

      return `
        <div class="db-category" style="border:1px solid var(--border);border-radius:6px;margin-bottom:8px;padding:8px;background:var(--bg-input)">
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            <button type="button" class="btn-icon" data-cat-toggle="${i}" title="${cat._expanded ? t('widget.dir.collapse') : t('widget.dir.expand')}" style="padding:4px 8px">${cat._expanded ? '&#9660;' : '&#9654;'}</button>
            <input type="text" class="input" data-cat-name="${i}" value="${escAttr(cat.name)}" placeholder="${t('widget.dir.category_name_placeholder')}" style="flex:1;min-width:140px;font-weight:600">
            <span style="font-size:11px;color:var(--text-muted);white-space:nowrap">${entryCount} ${entriesLabel}</span>
            <button type="button" class="btn-icon" data-cat-up="${i}" ${i === 0 ? 'disabled' : ''} title="${t('widget.dir.move_up')}" style="padding:4px 6px">&#8593;</button>
            <button type="button" class="btn-icon" data-cat-down="${i}" ${i === dirState.categories.length - 1 ? 'disabled' : ''} title="${t('widget.dir.move_down')}" style="padding:4px 6px">&#8595;</button>
            <button type="button" class="btn-icon" data-cat-delete="${i}" title="${t('widget.dir.delete_category')}" style="padding:4px 6px;color:#ff6b6b">&#215;</button>
          </div>
          ${cat._expanded ? `
            <div style="padding:10px 0 4px 4px;margin-top:8px;border-top:1px solid var(--border)">
              ${entryRows || `<div style="font-size:12px;color:var(--text-muted);padding:4px 0 8px">${t('widget.dir.no_entries')}</div>`}
              <button type="button" class="btn btn-secondary btn-sm" data-add-entry="${i}" style="margin-top:4px">${t('widget.dir.add_entry')}</button>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');

    wireDirHandlers(opts);
  }

  function wireDirHandlers(opts = {}) {
    const cont = document.getElementById('dbCategories');
    if (!cont) return;

    cont.querySelectorAll('[data-cat-toggle]').forEach(b => b.onclick = () => {
      const i = +b.dataset.catToggle;
      dirState.categories[i]._expanded = !dirState.categories[i]._expanded;
      renderDirCategories();
    });
    cont.querySelectorAll('[data-cat-name]').forEach(inp => inp.oninput = () => {
      dirState.categories[+inp.dataset.catName].name = inp.value;
    });
    cont.querySelectorAll('[data-cat-up]').forEach(b => b.onclick = () => {
      const i = +b.dataset.catUp;
      if (i === 0) return;
      [dirState.categories[i - 1], dirState.categories[i]] = [dirState.categories[i], dirState.categories[i - 1]];
      renderDirCategories();
    });
    cont.querySelectorAll('[data-cat-down]').forEach(b => b.onclick = () => {
      const i = +b.dataset.catDown;
      if (i >= dirState.categories.length - 1) return;
      [dirState.categories[i + 1], dirState.categories[i]] = [dirState.categories[i], dirState.categories[i + 1]];
      renderDirCategories();
    });
    cont.querySelectorAll('[data-cat-delete]').forEach(b => b.onclick = () => {
      const i = +b.dataset.catDelete;
      const label = dirState.categories[i].name || t('widget.dir.unnamed');
      if (!confirm(t('widget.dir.confirm_delete_category', { name: label }))) return;
      dirState.categories.splice(i, 1);
      renderDirCategories();
    });

    cont.querySelectorAll('[data-entry-id]').forEach(inp => inp.oninput = () => {
      const [i, j] = inp.dataset.entryId.split('-').map(Number);
      dirState.categories[i].entries[j].identifier = inp.value;
    });
    cont.querySelectorAll('[data-entry-name]').forEach(inp => inp.oninput = () => {
      const [i, j] = inp.dataset.entryName.split('-').map(Number);
      dirState.categories[i].entries[j].name = inp.value;
    });
    cont.querySelectorAll('[data-entry-subtitle]').forEach(inp => inp.oninput = () => {
      const [i, j] = inp.dataset.entrySubtitle.split('-').map(Number);
      dirState.categories[i].entries[j].subtitle = inp.value;
    });
    cont.querySelectorAll('[data-entry-avail]').forEach(inp => inp.onchange = () => {
      const [i, j] = inp.dataset.entryAvail.split('-').map(Number);
      dirState.categories[i].entries[j].available = inp.checked;
    });
    cont.querySelectorAll('[data-entry-up]').forEach(b => b.onclick = () => {
      const [i, j] = b.dataset.entryUp.split('-').map(Number);
      if (j === 0) return;
      const es = dirState.categories[i].entries;
      [es[j - 1], es[j]] = [es[j], es[j - 1]];
      renderDirCategories();
    });
    cont.querySelectorAll('[data-entry-down]').forEach(b => b.onclick = () => {
      const [i, j] = b.dataset.entryDown.split('-').map(Number);
      const es = dirState.categories[i].entries;
      if (j >= es.length - 1) return;
      [es[j + 1], es[j]] = [es[j], es[j + 1]];
      renderDirCategories();
    });
    cont.querySelectorAll('[data-entry-delete]').forEach(b => b.onclick = () => {
      const [i, j] = b.dataset.entryDelete.split('-').map(Number);
      dirState.categories[i].entries.splice(j, 1);
      renderDirCategories();
    });
    cont.querySelectorAll('[data-add-entry]').forEach(b => b.onclick = () => {
      const i = +b.dataset.addEntry;
      dirState.categories[i].entries.push({ identifier: '', name: '', subtitle: '', available: false });
      renderDirCategories({ focusEntryId: `${i}-${dirState.categories[i].entries.length - 1}` });
    });

    if (opts.focusCatName != null) {
      const inp = cont.querySelector(`[data-cat-name="${opts.focusCatName}"]`);
      if (inp) { inp.focus(); inp.select(); }
    }
    if (opts.focusEntryId) {
      const inp = cont.querySelector(`[data-entry-id="${opts.focusEntryId}"]`);
      if (inp) inp.focus();
    }
  }

  function openDirImport() {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:10001;padding:16px';
    const hasExisting = dirState.categories.length > 0;
    overlay.innerHTML = `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:20px;width:100%;max-width:660px;max-height:90vh;display:flex;flex-direction:column;gap:12px">
        <h3 style="font-size:16px;font-weight:600">${t('widget.dir.import_title')}</h3>
        <div style="font-size:12px;color:var(--text-muted)">${t('widget.dir.import_desc')}</div>
        <textarea id="diText" class="input" style="flex:1;min-height:220px;font-family:monospace;font-size:12px;white-space:pre;overflow:auto" placeholder="${escAttr(t('widget.dir.import_placeholder'))}"></textarea>
        <div id="diError" style="display:none;font-size:12px;color:#ff6b6b;white-space:pre-wrap"></div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer"><input type="checkbox" id="diReplace" ${hasExisting ? 'checked' : ''}> ${t('widget.dir.import_replace')}</label>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <button type="button" class="btn btn-secondary" id="diCancel">${t('common.cancel')}</button>
          <button type="button" class="btn btn-primary" id="diGo">${t('widget.dir.import_populate')}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const ta = overlay.querySelector('#diText');
    ta.focus();
    const cleanup = () => overlay.remove();
    overlay.querySelector('#diCancel').onclick = cleanup;
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(); };
    overlay.querySelector('#diGo').onclick = () => {
      const errBox = overlay.querySelector('#diError');
      let result;
      try { result = parseDirectoryImport(ta.value); }
      catch (e) { errBox.textContent = e.message || t('widget.dir.import_err_norows'); errBox.style.display = 'block'; return; }
      applyDirImport(result, overlay.querySelector('#diReplace').checked);
      cleanup();
    };
  }

  function applyDirImport(result, replace) {
    const m = result.meta || {};
    const setVal = (id, v) => { const el = document.getElementById(id); if (el && v != null && v !== '') el.value = v; };
    setVal('wTitle', m.title);
    setVal('wFooter', m.footer_text);
    const setSel = (id, v, allowed) => { if (v == null) return; const el = document.getElementById(id); if (el && allowed.includes(String(v))) el.value = String(v); };
    setSel('wTheme', m.theme, ['dark', 'light']);
    setSel('wSpeed', m.scroll_speed, ['slow', 'medium', 'fast']);
    setSel('wCols', m.columns, ['auto', '1', '2', '3', '4']);
    if (m.logo_url && (/^(https?:)?\/\//i.test(m.logo_url) || m.logo_url.startsWith('/'))) { dirState.logo_url = m.logo_url; renderLogoPicker(); }
    if (Array.isArray(result.background_images) && result.background_images.length) {
      const seen = new Set(dirState.background_images);
      for (const u of result.background_images) if (!seen.has(u)) { dirState.background_images.push(u); seen.add(u); }
      renderBgList();
    }
    const mapped = result.categories.map(c => ({
      name: c.name || '', _expanded: false,
      entries: c.entries.map(e => ({ identifier: e.identifier || '', name: e.name || '', subtitle: e.subtitle || '', available: !!e.available })),
    }));
    dirState.categories = replace ? mapped : dirState.categories.concat(mapped);
    renderDirCategories();
    const warnings = result.warnings || [];
    const msg = [t('widget.dir.import_done', { cats: result.stats.categories, entries: result.stats.entries })].concat(warnings).join(' ');
    showToast(msg, warnings.length ? 'info' : 'success');
  }

  function renderLogoPicker() {
    const box = document.getElementById('wLogoBox');
    if (!box) return;
    if (dirState.logo_url) {
      box.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-input)">
          <img ${dirState.logo_url && dirState.logo_url.startsWith('/api/') ? `data-auth-src="${escAttr(dirState.logo_url)}"` : `src="${escAttr(dirState.logo_url)}"`} style="max-height:50px;max-width:120px;object-fit:contain;background:#0003;border-radius:3px" onerror="this.style.opacity='0.3'">
          <div style="flex:1;min-width:0;font-size:11px;color:var(--text-muted);word-break:break-all;overflow:hidden;text-overflow:ellipsis">${escAttr(dirState.logo_url)}</div>
          <button type="button" class="btn btn-secondary btn-sm" id="wLogoChange">${t('widget.dir.change')}</button>
          <button type="button" class="btn-icon" id="wLogoClear" title="${t('widget.dir.remove_logo')}" style="color:#ff6b6b;padding:4px 8px">&#215;</button>
        </div>`;
      document.getElementById('wLogoChange').onclick = pickLogo;
      document.getElementById('wLogoClear').onclick = () => { dirState.logo_url = ''; renderLogoPicker(); };
    } else {
      box.innerHTML = `<button type="button" class="btn btn-secondary btn-sm" id="wLogoChoose">${t('widget.dir.choose_logo')}</button>`;
      document.getElementById('wLogoChoose').onclick = pickLogo;
    }
    hydrateAuthImages(box);
  }

  async function pickLogo() {
    const url = await openContentPicker({ multiple: false, title: t('widget.picker.select_logo') });
    if (url) { dirState.logo_url = url; renderLogoPicker(); }
  }

  function renderBgList() {
    const list = document.getElementById('wBgList');
    if (!list) return;
    if (!dirState.background_images.length) {
      list.innerHTML = `<div style="font-size:12px;color:var(--text-muted);font-style:italic;padding:4px 0">${t('widget.dir.no_bg_images')}</div>`;
      return;
    }
    list.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap">${
      dirState.background_images.map((u, i) => `
        <div style="position:relative;width:90px;height:68px;border-radius:4px;overflow:hidden;background:var(--bg-input);border:1px solid var(--border)">
          <img ${u && u.startsWith('/api/') ? `data-auth-src="${escAttr(u)}"` : `src="${escAttr(u)}"`} style="width:100%;height:100%;object-fit:cover" onerror="this.style.display='none'">
          <button type="button" data-bg-remove="${i}" title="${t('widget.dir.remove_bg')}" style="position:absolute;top:3px;right:3px;width:22px;height:22px;border-radius:50%;border:0;background:rgba(0,0,0,0.75);color:#fff;cursor:pointer;font-size:14px;line-height:1;padding:0">&#215;</button>
        </div>
      `).join('')
    }</div>`;
    hydrateAuthImages(list);
    list.querySelectorAll('[data-bg-remove]').forEach(b => b.onclick = () => {
      dirState.background_images.splice(+b.dataset.bgRemove, 1);
      renderBgList();
    });
  }

  async function pickBgImages() {
    const urls = await openContentPicker({ multiple: true, title: t('widget.picker.select_bg_images') });
    if (urls && urls.length) {
      dirState.background_images.push(...urls);
      renderBgList();
    }
  }

  function getConfigFromForm(type) {
    const config = {};
    const val = id => document.getElementById(id)?.value;
    switch (type) {
      case 'clock': Object.assign(config, { format: val('wFormat'), timezone: val('wTimezone'), font_size: parseInt(val('wFontSize')) || 64, color: val('wColor'), background: val('wBg'), show_date: true }); break;
      case 'weather': Object.assign(config, { location: val('wLocation'), units: val('wUnits'), font_size: parseInt(val('wFontSize')) || 48, color: val('wColor') }); break;
      case 'rss': Object.assign(config, { feed_url: val('wFeedUrl'), scroll_speed: parseInt(val('wScrollSpeed')) || 30, max_items: parseInt(val('wMaxItems')) || 10, font_size: parseInt(val('wFontSize')) || 24, color: val('wColor'), background: val('wBg') }); break;
      case 'text': Object.assign(config, { html: val('wHtml'), css: val('wCss'), background: val('wBg') }); break;
      case 'webpage': Object.assign(config, { url: val('wUrl'), zoom: parseInt(val('wZoom')) || 100, refresh_interval: parseInt(val('wRefresh')) || 0 }); break;
      case 'social': Object.assign(config, { platform: val('wPlatform'), query: val('wQuery') }); break;
      case 'transition': {
        const shaders = Array.from(document.querySelectorAll('#wTransList input[type=checkbox]:checked')).map(c => c.dataset.id);
        const params = {}; // per-shader tuned values held in transState.params
        shaders.forEach(id => { if (transState.params[id]) params[id] = transState.params[id]; });
        Object.assign(config, {
          shaders,
          params,
          durationMs: parseInt(val('wTransDuration')) || 800,
          scope: val('wTransScope') || 'next',
        });
        break;
      }
      case 'directory-board': Object.assign(config, {
        title: val('wTitle') || ' ',
        logo_url: dirState.logo_url || '',
        footer_text: val('wFooter') || '',
        background_images: dirState.background_images.slice(),
        theme: val('wTheme') || 'dark',
        scroll_speed: val('wSpeed') || 'medium',
        columns: val('wCols') || 'auto',
        categories: dirState.categories.map(cat => ({
          name: cat.name || '',
          entries: (cat.entries || []).map(e => ({
            identifier: e.identifier || '',
            name: e.name || '',
            subtitle: e.subtitle || '',
            available: !!e.available,
          })),
        })),
      }); break;
      case 'directory-search': Object.assign(config, {
        source_widget_id: val('wSource') || '',
        title: val('wTitle') || '',
        logo_url: dirState.logo_url || '',
        theme: val('wTheme') || 'dark',
        placeholder_text: val('wPlaceholder') || '',
        show_onscreen_keyboard: document.getElementById('wKeyboard') ? document.getElementById('wKeyboard').checked : true,
      }); break;
    }
    return config;
  }

  document.getElementById('saveWidgetBtn').onclick = async () => {
    const type = editingWidget?.widget_type || creatingType;
    const name = document.getElementById('wName').value;
    const config = getConfigFromForm(type);
    try {
      if (editingWidget) {
        await API(`/widgets/${editingWidget.id}`, { method: 'PUT', body: JSON.stringify({ name, config }) });
      } else {
        await API('/widgets', { method: 'POST', body: JSON.stringify({ widget_type: type, name, config }) });
      }
      document.getElementById('widgetModal').style.display = 'none';
      showToast(t('widget.toast.saved'), 'success');
      loadWidgets();
    } catch (err) { showToast(err.message, 'error'); }
  };

  document.getElementById('previewWidgetBtn').onclick = async () => {
    const type = editingWidget?.widget_type || creatingType;
    if (!type) return;
    const config = getConfigFromForm(type);
    try {
      const res = await fetch('/api/widgets/preview-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
        body: JSON.stringify({ widget_type: type, config }),
      });
      if (!res.ok) throw new Error(t('widget.toast.preview_failed'));
      const { id } = await res.json();
      showPreviewModal(id, type);
    } catch (err) { showToast(err.message, 'error'); }
  };

  async function loadWidgets() {
    const widgets = await API('/widgets');
    loadedWidgets = Array.isArray(widgets) ? widgets : [];
    const grid = document.getElementById('widgetGrid');
    if (!widgets.length) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>${t('widget.empty_title')}</h3><p>${t('widget.empty_desc')}</p></div>`;
      return;
    }
    grid.innerHTML = widgets.map(w => {
      const icon = WIDGET_ICONS[w.widget_type] || '?';
      const typeLabel = WIDGET_TYPES.includes(w.widget_type) ? widgetTypeName(w.widget_type) : w.widget_type;
      return `
        <div class="content-item">
          <div class="content-item-preview" style="display:flex;align-items:center;justify-content:center;flex-direction:column;gap:4px">
            <span style="font-size:36px">${icon}</span>
          </div>
          <div class="content-item-body">
            <div class="content-item-name">${escAttr(w.name)}</div>
            <div class="content-item-size">${escAttr(typeLabel)}</div>
          </div>
          <div class="content-item-actions">
            <button class="btn btn-secondary btn-sm" data-edit-widget="${escAttr(w.id)}">${t('common.edit')}</button>
            <button class="btn btn-danger btn-sm" data-delete-widget="${escAttr(w.id)}">${t('common.delete')}</button>
          </div>
        </div>
      `;
    }).join('');

    grid.onclick = async (e) => {
      const editBtn = e.target.closest('[data-edit-widget]');
      if (editBtn) {
        const w = widgets.find(x => x.id === editBtn.dataset.editWidget);
        if (w) {
          editingWidget = w;
          creatingType = w.widget_type;
          const config = JSON.parse(w.config || '{}');
          config._name = w.name;
          showConfigForm(w.widget_type, config);
        }
        return;
      }
      const deleteBtn = e.target.closest('[data-delete-widget]');
      if (deleteBtn) {
        const w = widgets.find(x => x.id === deleteBtn.dataset.deleteWidget);
        const label = w ? w.name : t('widget.this_widget');
        if (!confirm(t('widget.confirm_delete', { name: label }))) return;
        try {
          await API(`/widgets/${deleteBtn.dataset.deleteWidget}`, { method: 'DELETE' });
          showToast(t('widget.toast.deleted'), 'success');
          loadWidgets();
        } catch (err) { showToast(err.message, 'error'); }
      }
    };
  }

  loadWidgets();
}

export function cleanup() {}
