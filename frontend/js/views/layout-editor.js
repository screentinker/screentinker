import { api, assertLocalCallAllowed } from '../api.js';
import { showToast } from '../components/toast.js';
import { t, tn } from '../i18n.js';
import { esc } from '../utils.js';
import { renderApprovalBar } from '../components/approval-actions.js';
import { snapMove, snapResize } from '../components/snap.js';

// A refused request must reject, not resolve.
//
// This helper used to end in `.then(r => r.json())`, so a 403/404/500 body resolved as an ordinary
// value and the surrounding try/catch was unreachable — every handler took the failure for success.
// Concretely: deleting a built-in layout template showed "Layout deleted" while the server had
// returned 403 and the template was still there, and a rejected platform-role change showed "Role
// updated" while the dropdown kept displaying a value the server refused (its revert lives only in
// the dead catch). The shared client in api.js has always thrown on !res.ok; these local copies did
// not. Same contract now, including the 401 session-expiry reload.
const API = (url, opts = {}) => {
  // ⚠️ This helper bypasses api.js's routing, so it must ask the same question itself.
  assertLocalCallAllowed(url, opts.method);
  return fetch('/api' + url, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}`, ...opts.headers }, ...opts }).then(async (r) => {
  if (r.status === 401) { localStorage.removeItem('token'); window.location.reload(); throw new Error('Session expired'); }
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `Request failed (${r.status})`); }
  return r.json();
  });
};

export async function render(container) {
  const hash = window.location.hash;
  if (hash.startsWith('#/layout/')) {
    // "?wall=<id>" when opened from a video wall's "Edit zones": the editor then draws that wall's
    // panels under the zones and snaps to their seams.
    const [id, query] = hash.split('#/layout/')[1].split('?');
    const wallId = new URLSearchParams(query || '').get('wall');
    return renderEditor(container, id, wallId);
  }
  return renderList(container);
}

async function renderList(container) {
  container.innerHTML = `
    <div class="page-header">
      <div><h1>${t('layout.title')} <span class="help-tip" data-tip="${t('layout.help_tip')}">?</span></h1><div class="subtitle">${t('layout.subtitle')}</div></div>
      <button class="btn btn-primary" id="newLayoutBtn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        ${t('layout.new_layout')}
      </button>
    </div>
    <h3 style="margin-bottom:12px;font-size:14px;color:var(--text-secondary)">${t('layout.templates')}</h3>
    <div class="content-grid" id="templateGrid"></div>
    <h3 style="margin:24px 0 12px;font-size:14px;color:var(--text-secondary)">${t('layout.my_layouts')}</h3>
    <div class="content-grid" id="layoutGrid"></div>
  `;

  document.getElementById('newLayoutBtn').onclick = async () => {
    const name = prompt(t('layout.prompt_name'));
    if (!name) return;
    const layout = await API('/layouts', { method: 'POST', body: JSON.stringify({ name, zones: [{ name: t('layout.default_zone_name'), x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 100 }] }) });
    window.location.hash = `#/layout/${layout.id}`;
  };

  try {
    const layouts = await API('/layouts');
    const templates = layouts.filter(l => l.is_template);
    const custom = layouts.filter(l => !l.is_template);

    document.getElementById('templateGrid').innerHTML = templates.map(l => renderLayoutCard(l, true)).join('');
    document.getElementById('layoutGrid').innerHTML = custom.length ? custom.map(l => renderLayoutCard(l, false)).join('') :
      `<div class="empty-state" style="grid-column:1/-1"><p>${t('layout.empty_custom')}</p></div>`;

    container.querySelectorAll('[data-use-template]').forEach(btn => {
      btn.onclick = async () => {
        const layout = await API(`/layouts/${btn.dataset.useTemplate}/duplicate`, { method: 'POST', body: '{}' });
        window.location.hash = `#/layout/${layout.id}`;
      };
    });

    container.querySelectorAll('[data-edit-layout]').forEach(btn => {
      btn.onclick = () => { window.location.hash = `#/layout/${btn.dataset.editLayout}`; };
    });

    container.querySelectorAll('[data-delete-layout]').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const name = btn.dataset.layoutName;
        if (!confirm(t('layout.confirm_delete', { name }))) return;
        try {
          await API(`/layouts/${btn.dataset.deleteLayout}`, { method: 'DELETE' });
          showToast(t('layout.toast.deleted'));
          renderList(container);
        } catch (err) {
          showToast(err.message || t('layout.toast.delete_failed'), 'error');
        }
      };
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderLayoutCard(layout, isTemplate) {
  const zoneCount = layout.zones?.length || 0;
  const zonesText = tn('layout.zone_count', zoneCount);
  return `
    <div class="content-item" style="cursor:pointer">
      <div class="content-item-preview" style="position:relative;background:var(--bg-primary)">
        <div style="position:absolute;inset:8px;border:1px solid var(--border)">
          ${(layout.zones || []).map(z => `
            <div style="position:absolute;left:${z.x_percent}%;top:${z.y_percent}%;width:${z.width_percent}%;height:${z.height_percent}%;
              background:rgba(59,130,246,0.15);border:1px solid rgba(59,130,246,0.4);display:flex;align-items:center;justify-content:center;
              font-size:9px;color:var(--text-muted);overflow:hidden">${esc(z.name)}</div>
          `).join('')}
        </div>
      </div>
      <div class="content-item-body">
        <div class="content-item-name">${esc(layout.name)}</div>
        <div class="content-item-size">${zonesText}${isTemplate ? ' • ' + t('layout.template_label') : ''}</div>
      </div>
      <div class="content-item-actions">
        ${isTemplate
          ? `<button class="btn btn-primary btn-sm" data-use-template="${layout.id}">${t('layout.use_template')}</button>`
          : `<button class="btn btn-secondary btn-sm" data-edit-layout="${layout.id}">${t('common.edit')}</button>`
        }
        <button class="btn btn-danger btn-sm" data-delete-layout="${layout.id}" data-layout-name="${esc(layout.name)}" style="margin-left:4px">${t('common.delete')}</button>
      </div>
    </div>
  `;
}

/*
 * Canvas aspect as a padding-top percentage: the layout's own height/width.
 *
 * Falls back to 16:9 when a layout carries no usable dimensions, and clamps so a pathological
 * value cannot produce a canvas taller than the screen or thinner than a line — these rows are
 * user-editable, and an unusable editor is worse than a slightly wrong aspect.
 */
function canvasRatioPct(layout) {
  const w = Number(layout && layout.width) || 1920;
  const h = Number(layout && layout.height) || 1080;
  if (!(w > 0 && h > 0)) return 56.25;
  // 5% lets a wall layout be as wide as 20:1 (a row of six 1080p panels is 10.7:1); the old 20%
  // floor drew anything wider than 5:1 too tall, so zones were placed on the wrong shape.
  return Math.min(300, Math.max(5, (h / w) * 100));
}

async function renderEditor(container, layoutId, wallId = null) {
  let layout;
  try {
    layout = await API(`/layouts/${layoutId}`);
  } catch { container.innerHTML = `<div class="empty-state"><h3>${t('layout.not_found')}</h3></div>`; return; }
  // The wall's panels in percent of its player rect — the same space the zones live in. Best-effort:
  // without them the editor is exactly the single-screen editor.
  let wallPanels = [];
  let wallName = null;
  if (wallId) {
    try {
      const w = await API(`/walls/${wallId}`);
      const devs = w.devices || [];
      const rects = devs.map(d => ({ name: d.device_name || 'Screen', x: d.canvas_x ?? 0, y: d.canvas_y ?? 0, w: d.canvas_width ?? 320, h: d.canvas_height ?? 180 }));
      let p = (w.player_x != null) ? { x: w.player_x, y: w.player_y, w: w.player_width, h: w.player_height } : null;
      if (!p && rects.length) {
        const x = Math.min(...rects.map(r => r.x)), y = Math.min(...rects.map(r => r.y));
        p = { x, y, w: Math.max(...rects.map(r => r.x + r.w)) - x, h: Math.max(...rects.map(r => r.y + r.h)) - y };
      }
      if (p && p.w > 0 && p.h > 0) {
        wallPanels = rects.map(r => ({ name: r.name, x: (r.x - p.x) / p.w * 100, y: (r.y - p.y) / p.h * 100, w: r.w / p.w * 100, h: r.h / p.h * 100 }));
        wallName = w.name;
      }
    } catch { /* no wall overlay */ }
  }

  container.innerHTML = `
    <a href="${wallId && wallName ? '#/wall/' + esc(wallId) : '#/layouts'}" class="back-link" style="display:inline-flex;align-items:center;gap:6px;color:var(--text-secondary);margin-bottom:16px;font-size:13px">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
      ${wallId && wallName ? esc(t('layout.back_to_wall', { wall: wallName })) : t('layout.back')}
    </a>
    <div class="page-header">
      <!-- Editable in place. Duplicating a template names the copy "<template> (Copy)" and there
           was nowhere at all to change it — the only name field in this editor belongs to the
           selected ZONE, which is easy to mistake for the layout's own. Reported on #234. -->
      <input id="layoutName" class="input" value="${esc((layout.draft && layout.draft.name) || layout.name)}"
             aria-label="${t('layout.rename')}" title="${t('layout.rename')}"
             style="font-size:24px;font-weight:600;background:transparent;border:1px solid transparent;padding:2px 6px;max-width:420px">
      <div style="display:flex;gap:8px;align-items:center">
        <!-- The canvas size: a screen's resolution, or a WALL's player rect (wide and short). Zones are
             percentages either way; this is only the shape they are drawn on. -->
        <label style="font-size:11px;color:var(--text-muted)" title="${t('layout.size_tip')}">${t('layout.size')}</label>
        <input type="number" id="layoutW" class="input" value="${esc(String((layout.draft && layout.draft.width) || layout.width || 1920))}" min="16" step="1" style="width:84px">
        <span style="color:var(--text-muted)">×</span>
        <input type="number" id="layoutH" class="input" value="${esc(String((layout.draft && layout.draft.height) || layout.height || 1080))}" min="16" step="1" style="width:84px">
        <button class="btn btn-secondary btn-sm" id="addZoneBtn">${t('layout.add_zone')}</button>
        <button class="btn btn-primary btn-sm" id="saveLayoutBtn">${t('common.save')}</button>
      </div>
    </div>
    <div id="layoutApprovalBar" style="margin:-8px 0 12px"></div>
    <div style="display:flex;gap:20px">
      <div style="flex:1">
        <div id="canvasWrap" style="position:relative;background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden">
          <!-- Canvas mirrors THIS layout's shape, not a fixed 16:9. It was hardcoded to 56.25%
               (the padding-ratio trick for 16:9), so authoring a portrait layout meant dragging
               zones on a landscape canvas: correct on the panel, wrong everywhere you designed it. -->
          <div id="canvas" style="position:relative;width:100%;padding-top:${canvasRatioPct(layout)}%">
          </div>
        </div>
      </div>
      <div style="width:280px">
        <h3 style="font-size:14px;margin-bottom:12px">${t('layout.zones')}</h3>
        <div id="zoneList"></div>
        <div id="zoneProperties" style="margin-top:16px;display:none">
          <h3 style="font-size:14px;margin-bottom:12px">${t('layout.properties')}</h3>
          <div class="form-group"><label>${t('layout.prop.name')}</label><input type="text" id="propName" class="input"></div>
          <div class="form-group"><label>${t('layout.prop.x')}</label><input type="number" id="propX" class="input" min="0" max="100" step="0.1"></div>
          <div class="form-group"><label>${t('layout.prop.y')}</label><input type="number" id="propY" class="input" min="0" max="100" step="0.1"></div>
          <div class="form-group"><label>${t('layout.prop.width')}</label><input type="number" id="propW" class="input" min="1" max="100" step="0.1"></div>
          <div class="form-group"><label>${t('layout.prop.height')}</label><input type="number" id="propH" class="input" min="1" max="100" step="0.1"></div>
          <div class="form-group"><label>${t('layout.prop.z')}</label><input type="number" id="propZ" class="input" step="1">
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('layout.z_hint')}</div></div>
          <div class="form-group"><label>${t('layout.prop.type')}</label>
            <select id="propType" class="input" style="background:var(--bg-input)">
              <option value="content">${t('layout.type_content')}</option><option value="widget">${t('layout.type_widget')}</option>
            </select>
          </div>
          <div class="form-group"><label>${t('layout.prop.fit')}</label>
            <select id="propFit" class="input" style="background:var(--bg-input)">
              <option value="contain">${t('layout.fit_contain')}</option>
              <option value="cover">${t('layout.fit_cover')}</option>
              <option value="fill">${t('layout.fit_fill')}</option>
            </select>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('layout.fit_hint')}</div>
          </div>
          <button class="btn btn-danger btn-sm" id="deleteZoneBtn" style="width:100%;justify-content:center;margin-top:8px">${t('layout.delete_zone')}</button>
        </div>
      </div>
    </div>
  `;

  // A pending draft (workspace approval on) is the author's unpublished work; the editor opens on
  // it rather than on the live zones, which are what screens are still showing. GET /layouts/:id
  // sends both - `zones` live, `draft` when one exists.
  let zones = (layout.draft && Array.isArray(layout.draft.zones)) ? layout.draft.zones : (layout.zones || []);
  let selectedZone = null;
  let dragging = null;

  // Snapping (components/snap.js), done in on-screen pixels so the pull is the same on both axes of
  // a very wide wall canvas. Targets: the other zones, the canvas edges and centre, and — when
  // opened from a wall — the panels' edges, so a zone lands exactly on a seam. Alt = place freely.
  function snapZone(z, i, dir, ev) {
    const canvas = document.getElementById('canvas');
    if (ev.altKey) { drawGuides([]); return; }
    const r = canvas.getBoundingClientRect();
    const px = (q) => ({ x: q.x / 100 * r.width, y: q.y / 100 * r.height, w: q.w / 100 * r.width, h: q.h / 100 * r.height });
    const me = px({ x: z.x_percent, y: z.y_percent, w: z.width_percent, h: z.height_percent });
    const targets = zones.filter((_, k) => k !== i).map(o => px({ x: o.x_percent, y: o.y_percent, w: o.width_percent, h: o.height_percent }))
      .concat(wallPanels.map(px));
    const opts = { threshold: 12, bounds: { x: 0, y: 0, w: r.width, h: r.height }, minW: 0.05 * r.width, minH: 0.05 * r.height };
    const sn = dir ? snapResize(me, dir, targets, opts) : snapMove(me, targets, opts);
    const pct = (v, total) => Math.round(v / total * 1000) / 10;
    z.x_percent = Math.max(0, pct(sn.x, r.width)); z.y_percent = Math.max(0, pct(sn.y, r.height));
    z.width_percent = Math.min(100 - z.x_percent, pct(sn.w, r.width)); z.height_percent = Math.min(100 - z.y_percent, pct(sn.h, r.height));
    drawGuides(sn.guides.map(g => ({ axis: g.axis, at: g.axis === 'x' ? g.at / r.width * 100 : g.at / r.height * 100 })));
  }
  function drawGuides(guides) {
    const canvas = document.getElementById('canvas');
    canvas.querySelectorAll('.snap-guide').forEach(g => g.remove());
    for (const g of guides) {
      const line = document.createElement('div');
      line.className = 'snap-guide';
      line.style.cssText = 'position:absolute;pointer-events:none;z-index:9999;background:#f472b6;' + (g.axis === 'x'
        ? `left:${g.at}%;top:0;width:1px;height:100%` : `top:${g.at}%;left:0;height:1px;width:100%`);
      canvas.appendChild(line);
    }
  }

  function renderZones() {
    const canvas = document.getElementById('canvas');
    canvas.querySelectorAll('.zone-el').forEach(z => z.remove());
    if (!canvas.querySelector('.wall-panel-el')) {
      for (const p of wallPanels) {
        const el = document.createElement('div');
        el.className = 'wall-panel-el';
        el.style.cssText = `position:absolute;left:${p.x}%;top:${p.y}%;width:${p.w}%;height:${p.h}%;pointer-events:none;
          border:1px dashed rgba(255,255,255,0.35);box-sizing:border-box;z-index:0`;
        el.innerHTML = `<span style="position:absolute;right:4px;bottom:2px;font-size:10px;color:rgba(255,255,255,0.45)">${esc(p.name)}</span>`;
        canvas.appendChild(el);
      }
    }

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

      el.onmousedown = (e) => {
        if (e.target !== el) return;
        e.preventDefault();
        selectedZone = i;
        renderZones();
        updateProperties();
        /*
         * ⚠️ renderZones() JUST DESTROYED THE NODE THIS HANDLER CLOSED OVER (#316).
         *
         * It removes every .zone-el and builds them again to redraw the selection highlight, so
         * from this line on `el` is detached. Dragging still updated z.x_percent — the data object
         * survives — but painted the result onto an orphan, so nothing moved under the pointer and
         * the zone only jumped to its new place at the NEXT render, i.e. the next time you clicked.
         * Reported as "the squares can't be moved freely, their position updates after clicking
         * again", in both Chrome and Firefox, which is what a DOM bug rather than a mouse bug looks
         * like. Re-acquire the live node before anything reads or writes it. The resize handle
         * below never had this because it does not re-render on mousedown.
         */
        const live = canvas.querySelector(`.zone-el[data-index="${i}"]`) || el;
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
          snapZone(z, i, null, e2);
          live.style.left = z.x_percent + '%';
          live.style.top = z.y_percent + '%';
          updateProperties();
        };
        const onUp = () => {
          drawGuides([]);
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      };

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
          snapZone(z, i, 'se', e2);
          el.style.width = z.width_percent + '%';
          el.style.height = z.height_percent + '%';
          updateProperties();
        };
        const onUp = () => {
          drawGuides([]);
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      };
      el.appendChild(handle);
      canvas.appendChild(el);
    });

    document.getElementById('zoneList').innerHTML = zones.map((z, i) => `
      <div style="padding:8px 10px;background:${selectedZone === i ? 'var(--bg-card-hover)' : 'var(--bg-secondary)'};
        border:1px solid ${selectedZone === i ? 'var(--accent)' : 'var(--border)'};border-radius:var(--radius);
        margin-bottom:4px;cursor:pointer;font-size:13px" data-zone-idx="${i}">
        <div style="font-weight:500">${esc(z.name)}</div>
        <div style="font-size:11px;color:var(--text-muted)">${Math.round(z.width_percent)}% x ${Math.round(z.height_percent)}% • ${esc(z.zone_type)}</div>
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
    document.getElementById('propZ').value = z.z_index || 0;
    document.getElementById('propType').value = z.zone_type;
    document.getElementById('propFit').value = z.fit_mode || 'cover';
  }

  ['propName', 'propX', 'propY', 'propW', 'propH', 'propZ', 'propType', 'propFit'].forEach(id => {
    document.getElementById(id).oninput = () => {
      if (selectedZone === null) return;
      const z = zones[selectedZone];
      z.name = document.getElementById('propName').value;
      z.x_percent = parseFloat(document.getElementById('propX').value) || 0;
      z.y_percent = parseFloat(document.getElementById('propY').value) || 0;
      z.width_percent = parseFloat(document.getElementById('propW').value) || 10;
      z.height_percent = parseFloat(document.getElementById('propH').value) || 10;
      z.z_index = parseInt(document.getElementById('propZ').value, 10) || 0;
      z.zone_type = document.getElementById('propType').value;
      z.fit_mode = document.getElementById('propFit').value;
      renderZones();
    };
  });

  document.getElementById('addZoneBtn').onclick = () => {
    zones.push({ id: null, name: t('layout.zone_n', { n: zones.length + 1 }), x_percent: 10, y_percent: 10, width_percent: 30, height_percent: 30, z_index: 0, zone_type: 'content', fit_mode: 'contain', background_color: '#000000', sort_order: zones.length });
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
      // Single atomic update: send the full zone set and the server replaces them
      // exactly. The old per-zone delete-then-add loop could accumulate zones
      // (and regenerated every zone id each save). Keep each zone's id so
      // device->zone assignments survive.
        const newName = (document.getElementById('layoutName')?.value || '').trim();
      const updated = await API(`/layouts/${layoutId}`, {
        method: 'PUT',
        // Name goes with the zones so renaming is part of the Save the user already
        // presses, not a second hidden action.
        body: JSON.stringify({ zones, ...(newName ? { name: newName } : {}), ...canvasSize() }),
      });
      if (updated && updated.error) { showToast(updated.error, 'error'); return; }
      layout = updated;
      zones = layout.zones || [];
      selectedZone = null;
      showToast(updated.pending_review ? t('review.toast.saved_as_draft') : t('layout.toast.saved'), 'success');
      renderApprovalBar(document.getElementById('layoutApprovalBar'), { type: 'layout', id: layoutId, name: layout.name, onChanged: () => renderEditor(container, layoutId, wallId) });
      renderZones();
      updateProperties();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // The canvas size reshapes the canvas live; it is saved with the zones.
  function canvasSize() {
    const w = parseInt(document.getElementById('layoutW')?.value, 10);
    const h = parseInt(document.getElementById('layoutH')?.value, 10);
    return (w >= 16 && h >= 16) ? { width: w, height: h } : {};
  }
  ['layoutW', 'layoutH'].forEach((id) => {
    document.getElementById(id).oninput = () => {
      const sz = canvasSize();
      if (sz.width) document.getElementById('canvas').style.paddingTop = canvasRatioPct(sz) + '%';
    };
  });

  renderZones();
  renderApprovalBar(document.getElementById('layoutApprovalBar'), { type: 'layout', id: layoutId, name: layout.name, onChanged: () => renderEditor(container, layoutId, wallId) });
}

export function cleanup() {}
