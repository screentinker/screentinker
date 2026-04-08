import { api } from '../api.js';
import { showToast } from '../components/toast.js';

const API = (url, opts = {}) => fetch('/api' + url, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}`, ...opts.headers }, ...opts }).then(r => r.json());

export async function render(container) {
  const hash = window.location.hash;
  if (hash.startsWith('#/layout/')) {
    const id = hash.split('#/layout/')[1];
    return renderEditor(container, id);
  }
  return renderList(container);
}

async function renderList(container) {
  container.innerHTML = `
    <div class="page-header">
      <div><h1>Layouts <span class="help-tip" data-tip="Create multi-zone screen layouts. Use templates or build custom ones. Drag zones to position, resize with corner handle. Assign layouts to devices in the Playlist tab.">?</span></h1><div class="subtitle">Screen layouts and templates</div></div>
      <button class="btn btn-primary" id="newLayoutBtn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        New Layout
      </button>
    </div>
    <h3 style="margin-bottom:12px;font-size:14px;color:var(--text-secondary)">Templates</h3>
    <div class="content-grid" id="templateGrid"></div>
    <h3 style="margin:24px 0 12px;font-size:14px;color:var(--text-secondary)">My Layouts</h3>
    <div class="content-grid" id="layoutGrid"></div>
  `;

  document.getElementById('newLayoutBtn').onclick = async () => {
    const name = prompt('Layout name:');
    if (!name) return;
    const layout = await API('/layouts', { method: 'POST', body: JSON.stringify({ name, zones: [{ name: 'Main', x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 100 }] }) });
    window.location.hash = `#/layout/${layout.id}`;
  };

  try {
    const layouts = await API('/layouts');
    const templates = layouts.filter(l => l.is_template);
    const custom = layouts.filter(l => !l.is_template);

    document.getElementById('templateGrid').innerHTML = templates.map(l => renderLayoutCard(l, true)).join('');
    document.getElementById('layoutGrid').innerHTML = custom.length ? custom.map(l => renderLayoutCard(l, false)).join('') :
      '<div class="empty-state" style="grid-column:1/-1"><p>No custom layouts yet</p></div>';

    // Use template click
    container.querySelectorAll('[data-use-template]').forEach(btn => {
      btn.onclick = async () => {
        const layout = await API(`/layouts/${btn.dataset.useTemplate}/duplicate`, { method: 'POST', body: '{}' });
        window.location.hash = `#/layout/${layout.id}`;
      };
    });

    // Edit layout click
    container.querySelectorAll('[data-edit-layout]').forEach(btn => {
      btn.onclick = () => { window.location.hash = `#/layout/${btn.dataset.editLayout}`; };
    });

    // Delete layout click
    container.querySelectorAll('[data-delete-layout]').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const name = btn.dataset.layoutName;
        if (!confirm(`Delete layout "${name}"? This cannot be undone.`)) return;
        try {
          await API(`/layouts/${btn.dataset.deleteLayout}`, { method: 'DELETE' });
          showToast('Layout deleted');
          renderList(container);
        } catch (err) {
          showToast(err.message || 'Failed to delete layout', 'error');
        }
      };
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderLayoutCard(layout, isTemplate) {
  return `
    <div class="content-item" style="cursor:pointer">
      <div class="content-item-preview" style="position:relative;background:var(--bg-primary)">
        <div style="position:absolute;inset:8px;border:1px solid var(--border)">
          ${(layout.zones || []).map(z => `
            <div style="position:absolute;left:${z.x_percent}%;top:${z.y_percent}%;width:${z.width_percent}%;height:${z.height_percent}%;
              background:rgba(59,130,246,0.15);border:1px solid rgba(59,130,246,0.4);display:flex;align-items:center;justify-content:center;
              font-size:9px;color:var(--text-muted);overflow:hidden">${z.name}</div>
          `).join('')}
        </div>
      </div>
      <div class="content-item-body">
        <div class="content-item-name">${layout.name}</div>
        <div class="content-item-size">${layout.zones?.length || 0} zone(s) ${isTemplate ? '• Template' : ''}</div>
      </div>
      <div class="content-item-actions">
        ${isTemplate
          ? `<button class="btn btn-primary btn-sm" data-use-template="${layout.id}">Use Template</button>`
          : `<button class="btn btn-secondary btn-sm" data-edit-layout="${layout.id}">Edit</button>`
        }
        <button class="btn btn-danger btn-sm" data-delete-layout="${layout.id}" data-layout-name="${layout.name}" style="margin-left:4px">Delete</button>
      </div>
    </div>
  `;
}

async function renderEditor(container, layoutId) {
  let layout;
  try {
    layout = await API(`/layouts/${layoutId}`);
  } catch { container.innerHTML = '<div class="empty-state"><h3>Layout not found</h3></div>'; return; }

  container.innerHTML = `
    <a href="#/layouts" class="back-link" style="display:inline-flex;align-items:center;gap:6px;color:var(--text-secondary);margin-bottom:16px;font-size:13px">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
      Back to Layouts
    </a>
    <div class="page-header">
      <h1 id="layoutName">${layout.name}</h1>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary btn-sm" id="addZoneBtn">Add Zone</button>
        <button class="btn btn-primary btn-sm" id="saveLayoutBtn">Save</button>
      </div>
    </div>
    <div style="display:flex;gap:20px">
      <div style="flex:1">
        <div id="canvasWrap" style="position:relative;background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden">
          <div id="canvas" style="position:relative;width:100%;padding-top:56.25%">
            <!-- Zones rendered here -->
          </div>
        </div>
      </div>
      <div style="width:280px">
        <h3 style="font-size:14px;margin-bottom:12px">Zones</h3>
        <div id="zoneList"></div>
        <div id="zoneProperties" style="margin-top:16px;display:none">
          <h3 style="font-size:14px;margin-bottom:12px">Properties</h3>
          <div class="form-group"><label>Name</label><input type="text" id="propName" class="input"></div>
          <div class="form-group"><label>X (%)</label><input type="number" id="propX" class="input" min="0" max="100" step="0.1"></div>
          <div class="form-group"><label>Y (%)</label><input type="number" id="propY" class="input" min="0" max="100" step="0.1"></div>
          <div class="form-group"><label>Width (%)</label><input type="number" id="propW" class="input" min="1" max="100" step="0.1"></div>
          <div class="form-group"><label>Height (%)</label><input type="number" id="propH" class="input" min="1" max="100" step="0.1"></div>
          <div class="form-group"><label>Type</label>
            <select id="propType" class="input" style="background:var(--bg-input)">
              <option value="content">Content</option><option value="widget">Widget</option>
            </select>
          </div>
          <button class="btn btn-danger btn-sm" id="deleteZoneBtn" style="width:100%;justify-content:center;margin-top:8px">Delete Zone</button>
        </div>
      </div>
    </div>
  `;

  let zones = layout.zones || [];
  let selectedZone = null;
  let dragging = null;

  function renderZones() {
    const canvas = document.getElementById('canvas');
    // Clear only zone divs
    canvas.querySelectorAll('.zone-el').forEach(z => z.remove());

    zones.forEach((z, i) => {
      const el = document.createElement('div');
      el.className = 'zone-el';
      el.dataset.index = i;
      el.style.cssText = `position:absolute;left:${z.x_percent}%;top:${z.y_percent}%;width:${z.width_percent}%;height:${z.height_percent}%;
        background:${selectedZone === i ? 'rgba(59,130,246,0.3)' : 'rgba(59,130,246,0.1)'};
        border:2px solid ${selectedZone === i ? 'var(--accent)' : 'rgba(59,130,246,0.4)'};
        cursor:move;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--text-secondary);
        user-select:none;z-index:${z.z_index || 0}`;
      el.textContent = z.name;

      // Drag to move
      el.onmousedown = (e) => {
        if (e.target !== el) return;
        e.preventDefault();
        selectedZone = i;
        renderZones();
        updateProperties();
        const rect = canvas.getBoundingClientRect();
        const startX = e.clientX;
        const startY = e.clientY;
        const origX = z.x_percent;
        const origY = z.y_percent;

        const onMove = (e2) => {
          const dx = (e2.clientX - startX) / rect.width * 100;
          const dy = (e2.clientY - startY) / rect.height * 100;
          z.x_percent = Math.max(0, Math.min(100 - z.width_percent, Math.round((origX + dx) * 10) / 10));
          z.y_percent = Math.max(0, Math.min(100 - z.height_percent, Math.round((origY + dy) * 10) / 10));
          el.style.left = z.x_percent + '%';
          el.style.top = z.y_percent + '%';
          updateProperties();
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      };

      // Resize handle
      const handle = document.createElement('div');
      handle.style.cssText = 'position:absolute;right:0;bottom:0;width:12px;height:12px;cursor:se-resize;background:var(--accent);border-radius:2px 0 0 0;opacity:0.7';
      handle.onmousedown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        selectedZone = i;
        const rect = canvas.getBoundingClientRect();
        const onMove = (e2) => {
          const newW = ((e2.clientX - rect.left) / rect.width * 100) - z.x_percent;
          const newH = ((e2.clientY - rect.top) / rect.height * 100) - z.y_percent;
          z.width_percent = Math.max(5, Math.min(100 - z.x_percent, Math.round(newW * 10) / 10));
          z.height_percent = Math.max(5, Math.min(100 - z.y_percent, Math.round(newH * 10) / 10));
          el.style.width = z.width_percent + '%';
          el.style.height = z.height_percent + '%';
          updateProperties();
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      };
      el.appendChild(handle);
      canvas.appendChild(el);
    });

    // Zone list sidebar
    document.getElementById('zoneList').innerHTML = zones.map((z, i) => `
      <div style="padding:8px 10px;background:${selectedZone === i ? 'var(--bg-card-hover)' : 'var(--bg-secondary)'};
        border:1px solid ${selectedZone === i ? 'var(--accent)' : 'var(--border)'};border-radius:var(--radius);
        margin-bottom:4px;cursor:pointer;font-size:13px" data-zone-idx="${i}">
        <div style="font-weight:500">${z.name}</div>
        <div style="font-size:11px;color:var(--text-muted)">${Math.round(z.width_percent)}% x ${Math.round(z.height_percent)}% • ${z.zone_type}</div>
      </div>
    `).join('');

    document.querySelectorAll('[data-zone-idx]').forEach(el => {
      el.onclick = () => { selectedZone = parseInt(el.dataset.zoneIdx); renderZones(); updateProperties(); };
    });
  }

  function updateProperties() {
    const panel = document.getElementById('zoneProperties');
    if (selectedZone === null || !zones[selectedZone]) { panel.style.display = 'none'; return; }
    panel.style.display = 'block';
    const z = zones[selectedZone];
    document.getElementById('propName').value = z.name;
    document.getElementById('propX').value = z.x_percent;
    document.getElementById('propY').value = z.y_percent;
    document.getElementById('propW').value = z.width_percent;
    document.getElementById('propH').value = z.height_percent;
    document.getElementById('propType').value = z.zone_type;
  }

  // Property input handlers
  ['propName', 'propX', 'propY', 'propW', 'propH', 'propType'].forEach(id => {
    document.getElementById(id).oninput = () => {
      if (selectedZone === null) return;
      const z = zones[selectedZone];
      z.name = document.getElementById('propName').value;
      z.x_percent = parseFloat(document.getElementById('propX').value) || 0;
      z.y_percent = parseFloat(document.getElementById('propY').value) || 0;
      z.width_percent = parseFloat(document.getElementById('propW').value) || 10;
      z.height_percent = parseFloat(document.getElementById('propH').value) || 10;
      z.zone_type = document.getElementById('propType').value;
      renderZones();
    };
  });

  document.getElementById('addZoneBtn').onclick = () => {
    zones.push({ id: null, name: `Zone ${zones.length + 1}`, x_percent: 10, y_percent: 10, width_percent: 30, height_percent: 30, z_index: 0, zone_type: 'content', fit_mode: 'cover', background_color: '#000000', sort_order: zones.length });
    selectedZone = zones.length - 1;
    renderZones();
    updateProperties();
  };

  document.getElementById('deleteZoneBtn').onclick = () => {
    if (selectedZone === null) return;
    zones.splice(selectedZone, 1);
    selectedZone = null;
    renderZones();
    updateProperties();
  };

  document.getElementById('saveLayoutBtn').onclick = async () => {
    try {
      // Delete existing zones and recreate
      for (const z of layout.zones || []) {
        await API(`/layouts/${layoutId}/zones/${z.id}`, { method: 'DELETE' });
      }
      for (const z of zones) {
        await API(`/layouts/${layoutId}/zones`, { method: 'POST', body: JSON.stringify(z) });
      }
      showToast('Layout saved', 'success');
      layout = await API(`/layouts/${layoutId}`);
      zones = layout.zones;
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  renderZones();
}

export function cleanup() {}
