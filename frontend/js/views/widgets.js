import { showToast } from '../components/toast.js';

const API = (url, opts = {}) => fetch('/api' + url, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}`, ...opts.headers }, ...opts }).then(r => r.json());

const WIDGET_TYPES = [
  { id: 'clock', name: 'Clock', icon: '&#128339;', desc: 'Digital clock with date' },
  { id: 'weather', name: 'Weather', icon: '&#9925;', desc: 'Current weather conditions' },
  { id: 'rss', name: 'News Ticker', icon: '&#128240;', desc: 'Scrolling RSS feed' },
  { id: 'text', name: 'Text/HTML', icon: '&#128221;', desc: 'Custom text or HTML content' },
  { id: 'webpage', name: 'Webpage', icon: '&#127760;', desc: 'Embed a webpage' },
  { id: 'social', name: 'Social Feed', icon: '&#128172;', desc: 'Social media feed' },
  { id: 'directory-board', name: 'Directory Board', icon: '&#127970;', desc: 'Scrolling tenant/room directory for lobbies' },
];

function escAttr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function openContentPicker({ multiple = false, title = 'Select Image' } = {}) {
  return new Promise(async (resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:10000;padding:16px';
    overlay.innerHTML = `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:20px;width:100%;max-width:640px;max-height:90vh;display:flex;flex-direction:column">
        <h3 style="margin:0 0 12px;color:var(--text-primary)">${title}</h3>
        <input type="text" id="cpSearch" class="input" placeholder="Search images..." style="margin-bottom:12px">
        <div id="cpList" style="flex:1;overflow-y:auto;min-height:200px"></div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;gap:8px;flex-wrap:wrap">
          <div style="font-size:12px;color:var(--text-muted)" id="cpSelCount"></div>
          <div style="display:flex;gap:8px;margin-left:auto">
            <button class="btn btn-secondary" id="cpCancel">Cancel</button>
            ${multiple ? '<button class="btn btn-primary" id="cpDone">Done</button>' : ''}
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
      if (el && multiple) el.textContent = `${selected.size} selected`;
    };

    function renderList() {
      const q = (overlay.querySelector('#cpSearch').value || '').toLowerCase();
      const filtered = items.filter(i => (i.filename || '').toLowerCase().includes(q));
      const list = overlay.querySelector('#cpList');
      if (!filtered.length) {
        list.innerHTML = `<div style="color:var(--text-muted);padding:32px;text-align:center;font-size:13px">${items.length ? 'No matches.' : 'No images in your content library. Upload images first from Content Library.'}</div>`;
        return;
      }
      list.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px">${
        filtered.map(c => {
          const isSel = selected.has(c.id);
          const thumb = c.remote_url || `/api/content/${c.id}/thumbnail`;
          return `
            <div data-pick-id="${escAttr(c.id)}" style="position:relative;cursor:pointer;border-radius:6px;overflow:hidden;border:2px solid ${isSel ? 'var(--primary, #4a7cff)' : 'transparent'};aspect-ratio:4/3;background:var(--bg-input)">
              <img src="${escAttr(thumb)}" style="width:100%;height:100%;object-fit:cover" loading="lazy" onerror="this.style.opacity='0.2'">
              <div style="position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,0.75);color:#fff;padding:4px 6px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escAttr(c.filename)}</div>
              ${isSel ? '<div style="position:absolute;top:6px;right:6px;width:22px;height:22px;background:var(--primary, #4a7cff);color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;line-height:1">&#10003;</div>' : ''}
            </div>`;
        }).join('')
      }</div>`;
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

function showPreviewModal(html) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:10000;padding:16px';
  overlay.innerHTML = `
    <div style="width:100%;max-width:1400px;height:90vh;background:var(--bg-card);border-radius:8px;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--border)">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid var(--border)">
        <strong style="color:var(--text-primary)">Preview</strong>
        <button class="btn btn-secondary btn-sm" id="pvClose">Close</button>
      </div>
      <iframe id="pvIframe" style="flex:1;width:100%;border:0;background:#000"></iframe>
    </div>`;
  document.body.appendChild(overlay);
  // srcdoc resolves relative URLs against about:srcdoc, so inject <base> pointing to our origin
  const baseTag = `<base href="${window.location.origin}/">`;
  const withBase = /<head[^>]*>/i.test(html)
    ? html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`)
    : html.replace(/<html([^>]*)>/i, `<html$1><head>${baseTag}</head>`);
  overlay.querySelector('#pvIframe').srcdoc = withBase;
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
      <div><h1>Widgets <span class="help-tip" data-tip="Dynamic content elements: live clocks, weather, RSS tickers, text, webpages, and social feeds. Create a widget then assign it to a device playlist.">?</span></h1><div class="subtitle">Add dynamic content to your layouts</div></div>
      <button class="btn btn-primary" id="newWidgetBtn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        New Widget
      </button>
    </div>
    <div id="widgetTypeGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:24px;display:none">
      ${WIDGET_TYPES.map(t => `
        <div class="content-item" style="cursor:pointer" data-create-type="${t.id}">
          <div style="padding:20px;text-align:center">
            <div style="font-size:36px;margin-bottom:8px">${t.icon}</div>
            <div style="font-weight:600;font-size:14px">${t.name}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${t.desc}</div>
          </div>
        </div>
      `).join('')}
    </div>
    <div class="content-grid" id="widgetGrid"></div>

    <!-- Widget Config Modal -->
    <div class="modal-overlay" id="widgetModal" style="display:none">
      <div class="modal" style="width:560px">
        <div class="modal-header"><h3 id="widgetModalTitle">Configure Widget</h3>
          <button class="btn-icon" onclick="document.getElementById('widgetModal').style.display='none'">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="modal-body" id="widgetConfigForm"></div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="document.getElementById('widgetModal').style.display='none'">Cancel</button>
          <button class="btn btn-secondary" id="previewWidgetBtn">Preview</button>
          <button class="btn btn-primary" id="saveWidgetBtn">Save</button>
        </div>
      </div>
    </div>
  `;

  let editingWidget = null;
  let creatingType = null;
  let dirState = { categories: [], logo_url: '', background_images: [] };

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
    const typeName = WIDGET_TYPES.find(t => t.id === type)?.name || type;
    document.getElementById('widgetModalTitle').textContent = editingWidget ? `Edit ${typeName}` : `New ${typeName}`;

    let html = '<div class="form-group"><label>Widget Name</label><input type="text" id="wName" class="input" value="' + (config._name || typeName) + '"></div>';

    switch (type) {
      case 'clock':
        html += `
          <div class="form-group"><label>Format</label><select id="wFormat" class="input" style="background:var(--bg-input)"><option value="12h" ${config.format === '12h' ? 'selected' : ''}>12 Hour</option><option value="24h" ${config.format === '24h' ? 'selected' : ''}>24 Hour</option></select></div>
          <div class="form-group"><label>Timezone</label><input type="text" id="wTimezone" class="input" value="${config.timezone || 'America/Chicago'}" placeholder="America/New_York"></div>
          <div class="form-group"><label>Font Size (px)</label><input type="number" id="wFontSize" class="input" value="${config.font_size || 64}"></div>
          <div class="form-group"><label>Color</label><input type="color" id="wColor" value="${config.color || '#FFFFFF'}" style="width:60px;height:32px;border:none"></div>
          <div class="form-group"><label>Background</label><input type="color" id="wBg" value="${config.background || '#000000'}" style="width:60px;height:32px;border:none"></div>`;
        break;
      case 'weather':
        html += `
          <div class="form-group"><label>Location</label><input type="text" id="wLocation" class="input" value="${config.location || ''}" placeholder="City, State"></div>
          <div class="form-group"><label>Units</label><select id="wUnits" class="input" style="background:var(--bg-input)"><option value="imperial" ${config.units !== 'metric' ? 'selected' : ''}>Imperial (°F)</option><option value="metric" ${config.units === 'metric' ? 'selected' : ''}>Metric (°C)</option></select></div>
          <div class="form-group"><label>Font Size</label><input type="number" id="wFontSize" class="input" value="${config.font_size || 48}"></div>
          <div class="form-group"><label>Color</label><input type="color" id="wColor" value="${config.color || '#FFFFFF'}" style="width:60px;height:32px;border:none"></div>`;
        break;
      case 'rss':
        html += `
          <div class="form-group"><label>Feed URL</label><input type="text" id="wFeedUrl" class="input" value="${config.feed_url || ''}" placeholder="https://example.com/feed.xml"></div>
          <div class="form-group"><label>Scroll Speed (seconds)</label><input type="number" id="wScrollSpeed" class="input" value="${config.scroll_speed || 30}"></div>
          <div class="form-group"><label>Max Items</label><input type="number" id="wMaxItems" class="input" value="${config.max_items || 10}"></div>
          <div class="form-group"><label>Font Size</label><input type="number" id="wFontSize" class="input" value="${config.font_size || 24}"></div>
          <div class="form-group"><label>Color</label><input type="color" id="wColor" value="${config.color || '#FFFFFF'}" style="width:60px;height:32px;border:none"></div>
          <div class="form-group"><label>Background</label><input type="color" id="wBg" value="${config.background || '#000000'}" style="width:60px;height:32px;border:none"></div>`;
        break;
      case 'text':
        html += `
          <div class="form-group"><label>HTML Content</label><textarea id="wHtml" class="input" rows="6" style="font-family:monospace;font-size:12px">${config.html || '<h1 style="color:white;text-align:center;margin-top:40px">Hello World</h1>'}</textarea></div>
          <div class="form-group"><label>CSS (optional)</label><textarea id="wCss" class="input" rows="3" style="font-family:monospace;font-size:12px">${config.css || ''}</textarea></div>
          <div class="form-group"><label>Background</label><input type="color" id="wBg" value="${config.background || '#000000'}" style="width:60px;height:32px;border:none"></div>`;
        break;
      case 'webpage':
        html += `
          <div class="form-group"><label>URL</label><input type="text" id="wUrl" class="input" value="${config.url || ''}" placeholder="https://example.com"></div>
          <div class="form-group"><label>Zoom (%)</label><input type="number" id="wZoom" class="input" value="${config.zoom || 100}"></div>
          <div class="form-group"><label>Refresh Interval (seconds, 0 = never)</label><input type="number" id="wRefresh" class="input" value="${config.refresh_interval || 0}"></div>`;
        break;
      case 'social':
        html += `
          <div class="form-group"><label>Platform</label><select id="wPlatform" class="input" style="background:var(--bg-input)"><option value="twitter">Twitter/X</option><option value="instagram">Instagram</option></select></div>
          <div class="form-group"><label>Query</label><input type="text" id="wQuery" class="input" value="${config.query || ''}" placeholder="@handle or #hashtag"></div>`;
        break;
      case 'directory-board':
        html += `
          <div class="form-group"><label>Title</label><input type="text" id="wTitle" class="input" value="${escAttr(config.title)}" placeholder="Lincoln Warehouse"></div>
          <div class="form-group"><label>Logo (optional)</label><div id="wLogoBox"></div></div>
          <div class="form-group"><label>Footer Text</label><input type="text" id="wFooter" class="input" value="${escAttr(config.footer_text)}" placeholder="For Leasing Inquiries: Contact..."></div>
          <div class="form-group">
            <label>Background Images (optional)</label>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">Images crossfade every 15 seconds at 30% opacity. Add multiple for rotation.</div>
            <div id="wBgList"></div>
            <button type="button" class="btn btn-secondary btn-sm" id="wBgAdd" style="margin-top:8px">+ Add Background Image</button>
          </div>
          <div class="form-group" style="display:flex;gap:12px;flex-wrap:wrap">
            <div style="flex:1;min-width:140px"><label>Theme</label><select id="wTheme" class="input" style="background:var(--bg-input)">
              <option value="dark" ${!config.theme || config.theme === 'dark' ? 'selected' : ''}>Dark</option>
              <option value="light" ${config.theme === 'light' ? 'selected' : ''}>Light</option>
            </select></div>
            <div style="flex:1;min-width:140px"><label>Scroll Speed</label><select id="wSpeed" class="input" style="background:var(--bg-input)">
              <option value="slow" ${config.scroll_speed === 'slow' ? 'selected' : ''}>Slow</option>
              <option value="medium" ${!config.scroll_speed || config.scroll_speed === 'medium' ? 'selected' : ''}>Medium</option>
              <option value="fast" ${config.scroll_speed === 'fast' ? 'selected' : ''}>Fast</option>
            </select></div>
            <div style="flex:1;min-width:140px"><label>Columns</label><select id="wCols" class="input" style="background:var(--bg-input)">
              <option value="auto" ${!config.columns || config.columns === 'auto' ? 'selected' : ''}>Auto</option>
              <option value="1" ${config.columns === '1' ? 'selected' : ''}>1</option>
              <option value="2" ${config.columns === '2' ? 'selected' : ''}>2</option>
              <option value="3" ${config.columns === '3' ? 'selected' : ''}>3</option>
              <option value="4" ${config.columns === '4' ? 'selected' : ''}>4</option>
            </select></div>
          </div>
          <div class="form-group">
            <label>Categories</label>
            <div id="dbCategories"></div>
            <button type="button" class="btn btn-secondary btn-sm" id="dbAddCategory" style="margin-top:10px">+ Add Category</button>
          </div>`;
        break;
    }

    document.getElementById('widgetConfigForm').innerHTML = html;
    const modalEl = document.querySelector('#widgetModal .modal');
    if (modalEl) modalEl.style.width = type === 'directory-board' ? '720px' : '560px';
    document.getElementById('widgetModal').style.display = 'flex';

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
    }
  }

  function renderDirCategories(opts = {}) {
    const cont = document.getElementById('dbCategories');
    if (!cont) return;
    if (!dirState.categories.length) {
      cont.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);border:1px dashed var(--border);border-radius:6px;font-size:13px">Add your first floor or department to get started</div>';
      return;
    }
    cont.innerHTML = dirState.categories.map((cat, i) => {
      const entryRows = (cat.entries || []).map((e, j) => `
        <div class="db-entry" style="display:flex;gap:6px;align-items:flex-start;margin-bottom:8px;flex-wrap:wrap">
          <input type="text" class="input" data-entry-id="${i}-${j}" value="${escAttr(e.identifier)}" placeholder="101" style="width:90px">
          <div style="display:flex;flex-direction:column;gap:4px;flex:1;min-width:140px">
            <input type="text" class="input" data-entry-name="${i}-${j}" value="${escAttr(e.name)}" placeholder="Tenant name">
            <input type="text" class="input" data-entry-subtitle="${i}-${j}" value="${escAttr(e.subtitle)}" placeholder="Details (optional)" style="font-size:12px">
          </div>
          <label style="display:flex;align-items:center;gap:4px;font-size:12px;white-space:nowrap;color:var(--text-muted);padding-top:8px">
            <input type="checkbox" data-entry-avail="${i}-${j}" ${e.available ? 'checked' : ''}> Available
          </label>
          <button type="button" class="btn-icon" data-entry-up="${i}-${j}" ${j === 0 ? 'disabled' : ''} title="Move up" style="padding:4px 6px">&#8593;</button>
          <button type="button" class="btn-icon" data-entry-down="${i}-${j}" ${j === cat.entries.length - 1 ? 'disabled' : ''} title="Move down" style="padding:4px 6px">&#8595;</button>
          <button type="button" class="btn-icon" data-entry-delete="${i}-${j}" title="Delete entry" style="padding:4px 6px;color:#ff6b6b">&#215;</button>
        </div>
      `).join('');

      return `
        <div class="db-category" style="border:1px solid var(--border);border-radius:6px;margin-bottom:8px;padding:8px;background:var(--bg-input)">
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            <button type="button" class="btn-icon" data-cat-toggle="${i}" title="${cat._expanded ? 'Collapse' : 'Expand'}" style="padding:4px 8px">${cat._expanded ? '&#9660;' : '&#9654;'}</button>
            <input type="text" class="input" data-cat-name="${i}" value="${escAttr(cat.name)}" placeholder="e.g. First Floor" style="flex:1;min-width:140px;font-weight:600">
            <span style="font-size:11px;color:var(--text-muted);white-space:nowrap">${cat.entries.length} ${cat.entries.length === 1 ? 'entry' : 'entries'}</span>
            <button type="button" class="btn-icon" data-cat-up="${i}" ${i === 0 ? 'disabled' : ''} title="Move up" style="padding:4px 6px">&#8593;</button>
            <button type="button" class="btn-icon" data-cat-down="${i}" ${i === dirState.categories.length - 1 ? 'disabled' : ''} title="Move down" style="padding:4px 6px">&#8595;</button>
            <button type="button" class="btn-icon" data-cat-delete="${i}" title="Delete category" style="padding:4px 6px;color:#ff6b6b">&#215;</button>
          </div>
          ${cat._expanded ? `
            <div style="padding:10px 0 4px 4px;margin-top:8px;border-top:1px solid var(--border)">
              ${entryRows || '<div style="font-size:12px;color:var(--text-muted);padding:4px 0 8px">No entries yet</div>'}
              <button type="button" class="btn btn-secondary btn-sm" data-add-entry="${i}" style="margin-top:4px">+ Add Entry</button>
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
      const label = dirState.categories[i].name || '(unnamed)';
      if (!confirm(`Delete category "${label}" and all its entries?`)) return;
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

  function renderLogoPicker() {
    const box = document.getElementById('wLogoBox');
    if (!box) return;
    if (dirState.logo_url) {
      box.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-input)">
          <img src="${escAttr(dirState.logo_url)}" style="max-height:50px;max-width:120px;object-fit:contain;background:#0003;border-radius:3px" onerror="this.style.opacity='0.3'">
          <div style="flex:1;min-width:0;font-size:11px;color:var(--text-muted);word-break:break-all;overflow:hidden;text-overflow:ellipsis">${escAttr(dirState.logo_url)}</div>
          <button type="button" class="btn btn-secondary btn-sm" id="wLogoChange">Change</button>
          <button type="button" class="btn-icon" id="wLogoClear" title="Remove" style="color:#ff6b6b;padding:4px 8px">&#215;</button>
        </div>`;
      document.getElementById('wLogoChange').onclick = pickLogo;
      document.getElementById('wLogoClear').onclick = () => { dirState.logo_url = ''; renderLogoPicker(); };
    } else {
      box.innerHTML = `<button type="button" class="btn btn-secondary btn-sm" id="wLogoChoose">Choose Logo</button>`;
      document.getElementById('wLogoChoose').onclick = pickLogo;
    }
  }

  async function pickLogo() {
    const url = await openContentPicker({ multiple: false, title: 'Select Logo' });
    if (url) { dirState.logo_url = url; renderLogoPicker(); }
  }

  function renderBgList() {
    const list = document.getElementById('wBgList');
    if (!list) return;
    if (!dirState.background_images.length) {
      list.innerHTML = '<div style="font-size:12px;color:var(--text-muted);font-style:italic;padding:4px 0">No background images selected</div>';
      return;
    }
    list.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap">${
      dirState.background_images.map((u, i) => `
        <div style="position:relative;width:90px;height:68px;border-radius:4px;overflow:hidden;background:var(--bg-input);border:1px solid var(--border)">
          <img src="${escAttr(u)}" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display='none'">
          <button type="button" data-bg-remove="${i}" title="Remove" style="position:absolute;top:3px;right:3px;width:22px;height:22px;border-radius:50%;border:0;background:rgba(0,0,0,0.75);color:#fff;cursor:pointer;font-size:14px;line-height:1;padding:0">&#215;</button>
        </div>
      `).join('')
    }</div>`;
    list.querySelectorAll('[data-bg-remove]').forEach(b => b.onclick = () => {
      dirState.background_images.splice(+b.dataset.bgRemove, 1);
      renderBgList();
    });
  }

  async function pickBgImages() {
    const urls = await openContentPicker({ multiple: true, title: 'Select Background Images' });
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
      showToast('Widget saved', 'success');
      loadWidgets();
    } catch (err) { showToast(err.message, 'error'); }
  };

  document.getElementById('previewWidgetBtn').onclick = async () => {
    const type = editingWidget?.widget_type || creatingType;
    if (!type) return;
    const config = getConfigFromForm(type);
    try {
      const res = await fetch('/api/widgets/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
        body: JSON.stringify({ widget_type: type, config }),
      });
      if (!res.ok) throw new Error('Preview failed');
      const html = await res.text();
      showPreviewModal(html);
    } catch (err) { showToast(err.message, 'error'); }
  };

  async function loadWidgets() {
    const widgets = await API('/widgets');
    const grid = document.getElementById('widgetGrid');
    if (!widgets.length) {
      grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><h3>No widgets yet</h3><p>Create a widget to add dynamic content to your layouts.</p></div>';
      return;
    }
    grid.innerHTML = widgets.map(w => {
      const typeMeta = WIDGET_TYPES.find(t => t.id === w.widget_type) || {};
      return `
        <div class="content-item">
          <div class="content-item-preview" style="display:flex;align-items:center;justify-content:center;flex-direction:column;gap:4px">
            <span style="font-size:36px">${typeMeta.icon || '?'}</span>
          </div>
          <div class="content-item-body">
            <div class="content-item-name">${escAttr(w.name)}</div>
            <div class="content-item-size">${escAttr(typeMeta.name || w.widget_type)}</div>
          </div>
          <div class="content-item-actions">
            <button class="btn btn-secondary btn-sm" data-edit-widget="${escAttr(w.id)}">Edit</button>
            <button class="btn btn-danger btn-sm" data-delete-widget="${escAttr(w.id)}">Delete</button>
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
        const label = w ? w.name : 'this widget';
        if (!confirm(`Delete "${label}"? This cannot be undone.`)) return;
        try {
          await API(`/widgets/${deleteBtn.dataset.deleteWidget}`, { method: 'DELETE' });
          showToast('Widget deleted', 'success');
          loadWidgets();
        } catch (err) { showToast(err.message, 'error'); }
      }
    };
  }

  loadWidgets();
}

export function cleanup() {}
