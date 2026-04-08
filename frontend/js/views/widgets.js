import { showToast } from '../components/toast.js';

const API = (url, opts = {}) => fetch('/api' + url, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}`, ...opts.headers }, ...opts }).then(r => r.json());

const WIDGET_TYPES = [
  { id: 'clock', name: 'Clock', icon: '&#128339;', desc: 'Digital clock with date' },
  { id: 'weather', name: 'Weather', icon: '&#9925;', desc: 'Current weather conditions' },
  { id: 'rss', name: 'News Ticker', icon: '&#128240;', desc: 'Scrolling RSS feed' },
  { id: 'text', name: 'Text/HTML', icon: '&#128221;', desc: 'Custom text or HTML content' },
  { id: 'webpage', name: 'Webpage', icon: '&#127760;', desc: 'Embed a webpage' },
  { id: 'social', name: 'Social Feed', icon: '&#128172;', desc: 'Social media feed' },
];

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
    }

    document.getElementById('widgetConfigForm').innerHTML = html;
    document.getElementById('widgetModal').style.display = 'flex';
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

  document.getElementById('previewWidgetBtn').onclick = () => {
    if (editingWidget) {
      window.open(`/api/widgets/${editingWidget.id}/render`, '_blank', 'width=600,height=400');
    } else {
      showToast('Save the widget first to preview', 'info');
    }
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
            <div class="content-item-name">${w.name}</div>
            <div class="content-item-size">${typeMeta.name || w.widget_type}</div>
          </div>
          <div class="content-item-actions">
            <button class="btn btn-secondary btn-sm" data-edit-widget="${w.id}">Edit</button>
            <button class="btn btn-danger btn-sm" data-delete-widget="${w.id}">Delete</button>
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
