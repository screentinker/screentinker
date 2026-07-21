import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';

// Background swatches: ids resolve to translated names; values are the actual
// CSS to apply.
const BACKGROUNDS = [
  { id: 'black', value: '#000000' },
  { id: 'dark_blue', value: '#0f172a' },
  { id: 'dark_gradient', value: 'linear-gradient(135deg, #0c0c0c 0%, #1a1a2e 50%, #16213e 100%)' },
  { id: 'blue_gradient', value: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' },
  { id: 'sunset', value: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)' },
  { id: 'ocean', value: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)' },
  { id: 'forest', value: 'linear-gradient(135deg, #134e5e 0%, #71b280 100%)' },
  { id: 'dark_red', value: 'linear-gradient(135deg, #200122 0%, #6f0000 100%)' },
  { id: 'white', value: '#FFFFFF' },
];

const FONTS = ['Arial', 'Helvetica', 'Georgia', 'Impact', 'Verdana', 'Trebuchet MS', 'Courier New', 'Times New Roman'];

let elements = [];
let selectedIdx = -1;
let bgValue = '#000000';
let bgImageDataUrl = null;
let dragging = null;
let dragStart = null;
// When editing an existing designer-made widget: its id + name, so Publish UPDATES it (PUT) instead of
// creating a new one. Null = a fresh design (create).
let editingWidgetId = null;
let editingWidgetName = null;

export function render(container, widgetId) {
  elements = [];
  selectedIdx = -1;
  bgValue = '#000000';
  bgImageDataUrl = null;
  editingWidgetId = null;
  editingWidgetName = null;

  container.innerHTML = `
    <div class="page-header">
      <div><h1>${t('designer.title')} <span class="help-tip" data-tip="${t('designer.help_tip')}">?</span></h1><div class="subtitle">${t('designer.subtitle')}</div></div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary" id="loadDesignBtn">${t('designer.load_design')}</button>
        <button class="btn btn-secondary" id="exportPngBtn">${t('designer.export_png')}</button>
        <button class="btn btn-primary" id="publishBtn">${t('designer.publish')}</button>
      </div>
    </div>
    <div style="display:flex;gap:20px">
      <!-- Preview -->
      <div style="flex:1">
        <div id="previewWrap" style="position:relative;border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;background:#000;aspect-ratio:16/9">
          <div id="designPreview" style="position:relative;width:100%;height:100%;overflow:hidden;container-type:inline-size"></div>
        </div>
        <p style="font-size:11px;color:var(--text-muted);margin-top:8px">${t('designer.preview_hint')}</p>
      </div>
      <!-- Sidebar -->
      <div style="width:300px;display:flex;flex-direction:column;gap:12px;max-height:calc(100vh - 120px);overflow-y:auto">
        <!-- AI Generate (#41) -->
        <div style="background:var(--bg-card);border:1px solid var(--accent);border-radius:var(--radius);padding:12px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <h4 style="font-size:13px">${t('designer.ai.title')}</h4>
            <button class="btn-icon" id="aiSettingsBtn" title="${t('designer.ai.settings')}" style="padding:2px">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            </button>
          </div>
          <textarea id="aiPrompt" rows="2" class="input" placeholder="${t('designer.ai.placeholder')}" style="width:100%;resize:vertical;font-size:12px"></textarea>
          <button class="btn btn-primary btn-sm" id="aiGenerateBtn" style="width:100%;justify-content:center;margin-top:6px">${t('designer.ai.generate')}</button>
          <div id="aiStatus" style="font-size:11px;color:var(--text-muted);margin-top:6px"></div>
        </div>

        <!-- Add Elements -->
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:12px">
          <h4 style="font-size:13px;margin-bottom:10px">${t('designer.add_element')}</h4>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
            <button class="btn btn-secondary btn-sm" id="addText" style="justify-content:center">&#128172; ${t('designer.el.text')}</button>
            <button class="btn btn-secondary btn-sm" id="addHeading" style="justify-content:center">&#128220; ${t('designer.el.heading')}</button>
            <button class="btn btn-secondary btn-sm" id="addImage" style="justify-content:center">&#128247; ${t('designer.el.image')}</button>
            <button class="btn btn-secondary btn-sm" id="addVideo" style="justify-content:center">&#127916; ${t('designer.el.video')}</button>
            <button class="btn btn-secondary btn-sm" id="addClock" style="justify-content:center">&#128339; ${t('designer.el.clock')}</button>
            <button class="btn btn-secondary btn-sm" id="addDate" style="justify-content:center">&#128197; ${t('designer.el.date')}</button>
            <button class="btn btn-secondary btn-sm" id="addWeather" style="justify-content:center">&#9925; ${t('designer.el.weather')}</button>
            <button class="btn btn-secondary btn-sm" id="addTicker" style="justify-content:center">&#128240; ${t('designer.el.ticker')}</button>
            <button class="btn btn-secondary btn-sm" id="addShape" style="justify-content:center">&#9632; ${t('designer.el.shape')}</button>
            <button class="btn btn-secondary btn-sm" id="addQR" style="justify-content:center">&#9641; ${t('designer.el.qr')}</button>
            <button class="btn btn-secondary btn-sm" id="addCountdown" style="justify-content:center">&#9201; ${t('designer.el.countdown')}</button>
            <button class="btn btn-secondary btn-sm" id="addWebpage" style="justify-content:center">&#127760; ${t('designer.el.webpage')}</button>
          </div>
        </div>
        <!-- Background -->
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:12px">
          <h4 style="font-size:13px;margin-bottom:8px">${t('designer.background')}</h4>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px">
            ${BACKGROUNDS.map(b => `<div style="width:30px;height:30px;border-radius:4px;cursor:pointer;border:2px solid var(--border);background:${b.value}" data-bg="${b.value}" title="${t('designer.bg.' + b.id)}"></div>`).join('')}
          </div>
          <div style="display:flex;gap:6px">
            <input type="color" id="bgColor" value="#000000" style="flex:1;height:32px;border:none;cursor:pointer;border-radius:4px">
            <button class="btn btn-secondary btn-sm" id="bgImageBtn">${t('designer.bg_image')}</button>
          </div>
          <input type="file" id="bgImageInput" style="display:none" accept="image/*">
        </div>
        <!-- Properties -->
        <div id="propPanel" style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:12px;display:none">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <h4 style="font-size:13px">${t('designer.properties')}</h4>
            <button class="btn btn-danger btn-sm" id="deleteEl">${t('common.delete')}</button>
          </div>
          <div id="propFields"></div>
        </div>
        <!-- Layers -->
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:12px">
          <h4 style="font-size:13px;margin-bottom:8px">${t('designer.layers')}</h4>
          <div id="layerList" style="font-size:12px"></div>
        </div>
      </div>
    </div>
  `;

  // Background handlers
  document.querySelectorAll('[data-bg]').forEach(el => {
    el.onclick = () => { bgValue = el.dataset.bg; bgImageDataUrl = null; redraw(); };
  });
  document.getElementById('bgColor').oninput = (e) => { bgValue = e.target.value; bgImageDataUrl = null; redraw(); };
  document.getElementById('bgImageBtn').onclick = () => document.getElementById('bgImageInput').click();
  document.getElementById('bgImageInput').onchange = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { bgImageDataUrl = ev.target.result; redraw(); };
    reader.readAsDataURL(file);
  };

  // AI generate (#41): prompt -> validated design spec -> load onto the canvas.
  document.getElementById('aiSettingsBtn').onclick = openAiSettings;
  const aiGenBtn = document.getElementById('aiGenerateBtn');
  aiGenBtn.onclick = async () => {
    const prompt = document.getElementById('aiPrompt').value.trim();
    const status = document.getElementById('aiStatus');
    if (!prompt) { status.textContent = t('designer.ai.need_prompt'); return; }
    aiGenBtn.disabled = true; aiGenBtn.textContent = t('designer.ai.generating');
    status.textContent = t('designer.ai.contacting');
    try {
      const design = await api.aiGenerateDesign(prompt);
      elements = []; selectedIdx = -1;
      if (design.backgroundImage) {
        bgImageDataUrl = design.backgroundImage;           // AI-generated backdrop
        if (design.background) bgValue = design.background; // kept as fallback
      } else if (design.background) {
        bgValue = design.background; bgImageDataUrl = null;
        const bc = document.getElementById('bgColor'); if (bc) bc.value = design.background;
      }
      (design.elements || []).forEach(el => elements.push(el));
      redraw();
      status.textContent = design.image_warning
        ? t('designer.ai.done_imgwarn', { n: (design.elements || []).length })
        : t('designer.ai.done', { n: (design.elements || []).length });
    } catch (err) {
      status.textContent = (err && err.message) || t('designer.ai.failed');
    } finally {
      aiGenBtn.disabled = false; aiGenBtn.textContent = t('designer.ai.generate');
    }
  };

  // Add element handlers
  document.getElementById('addText').onclick = () => addElement({ type: 'text', x: 10, y: 60, text: t('designer.default.text'), fontSize: 24, fontFamily: 'Arial', color: '#FFFFFF', bold: false, shadow: false });
  document.getElementById('addHeading').onclick = () => addElement({ type: 'text', x: 5, y: 5, text: t('designer.default.heading'), fontSize: 64, fontFamily: 'Impact', color: '#FFFFFF', bold: true, shadow: true });
  document.getElementById('addImage').onclick = () => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*';
    input.onchange = () => {
      const reader = new FileReader();
      reader.onload = (ev) => addElement({ type: 'image', x: 10, y: 10, width: 30, height: 30, src: ev.target.result });
      reader.readAsDataURL(input.files[0]);
    };
    input.click();
  };
  document.getElementById('addVideo').onclick = () => {
    const url = prompt(t('designer.prompt.video_url'));
    if (url) addElement({ type: 'video', x: 5, y: 5, width: 50, height: 50, src: url, muted: true, loop: true });
  };
  document.getElementById('addClock').onclick = () => addElement({ type: 'clock', x: 60, y: 5, fontSize: 48, fontFamily: 'Arial', color: '#FFFFFF', format: '12h', showSeconds: true, shadow: true });
  document.getElementById('addDate').onclick = () => addElement({ type: 'date', x: 60, y: 20, fontSize: 24, fontFamily: 'Arial', color: '#FFFFFF', shadow: false });
  document.getElementById('addWeather').onclick = () => {
    const location = prompt(t('designer.prompt.weather_location'), 'Milwaukee, WI');
    if (location) addElement({ type: 'weather', x: 5, y: 70, fontSize: 36, color: '#FFFFFF', location, units: 'imperial' });
  };
  document.getElementById('addTicker').onclick = () => {
    const url = prompt(t('designer.prompt.rss_url'), 'https://feeds.bbci.co.uk/news/rss.xml');
    if (url) addElement({ type: 'ticker', x: 0, y: 90, width: 100, height: 10, feedUrl: url, speed: 30, fontSize: 20, color: '#FFFFFF', bgColor: 'rgba(0,0,0,0.7)' });
  };
  document.getElementById('addShape').onclick = () => addElement({ type: 'shape', x: 20, y: 20, width: 30, height: 20, color: '#3b82f6', opacity: 0.7, radius: 8, shape: 'rect' });
  document.getElementById('addQR').onclick = () => {
    const data = prompt(t('designer.prompt.qr_url'), 'https://example.com');
    if (data) addElement({ type: 'qr', x: 80, y: 70, size: 15, data, fgColor: '#FFFFFF', bgColor: '#000000' });
  };
  document.getElementById('addCountdown').onclick = () => {
    const target = prompt(t('designer.prompt.countdown_date'), '2026-04-01');
    if (target) addElement({ type: 'countdown', x: 20, y: 40, fontSize: 48, color: '#FFFFFF', targetDate: target, label: t('designer.default.coming_soon') });
  };
  document.getElementById('addWebpage').onclick = () => {
    const url = prompt(t('designer.prompt.webpage_url'));
    if (url) addElement({ type: 'webpage', x: 5, y: 5, width: 40, height: 40, url });
  };

  document.getElementById('deleteEl').onclick = () => { if (selectedIdx >= 0) { elements.splice(selectedIdx, 1); selectedIdx = -1; redraw(); } };

  // Publish as a widget. The config carries the rendered HTML (what the player shows) AND the `design`
  // source (elements + background) so the widget can be reopened in THIS designer and edited visually
  // instead of dropping into the raw HTML editor. Editing an existing designer widget PUTs it in place.
  document.getElementById('publishBtn').onclick = async () => {
    try {
      const config = { html: generateInnerHTML(), css: '', background: bgValue, design: { elements, bgValue, bgImage: bgImageDataUrl } };
      const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` };
      // The URL is the source of truth for WHICH widget is being edited (#/designer/<id>). route() can
      // re-fire and momentarily reset editingWidgetId, so fall back to the hash — otherwise a save races
      // to POST a duplicate instead of updating the original.
      const targetId = editingWidgetId || (location.hash.match(/#\/designer\/([^/?]+)/) || [])[1] || null;
      let res;
      if (targetId) {
        const body = { config };
        if (editingWidgetName) body.name = editingWidgetName; // preserve the name; server keeps it if omitted
        res = await fetch('/api/widgets/' + targetId, { method: 'PUT', headers: auth, body: JSON.stringify(body) });
      } else {
        res = await fetch('/api/widgets', { method: 'POST', headers: auth, body: JSON.stringify({ widget_type: 'text', name: t('designer.widget_name', { date: new Date().toLocaleDateString() }), config }) });
      }
      if (res.ok) showToast(t('designer.toast.published'), 'success');
      else showToast(t('designer.toast.publish_failed'), 'error');
    } catch (err) { showToast(err.message, 'error'); }
  };

  // Export PNG screenshot
  document.getElementById('exportPngBtn').onclick = async () => {
    try {
      const preview = document.getElementById('designPreview');
      // Use a canvas to capture
      const canvas = document.createElement('canvas');
      canvas.width = 1920; canvas.height = 1080;
      const ctx = canvas.getContext('2d');
      // Draw background
      if (bgImageDataUrl) {
        const img = new Image(); img.src = bgImageDataUrl;
        await new Promise(r => { img.onload = r; });
        ctx.drawImage(img, 0, 0, 1920, 1080);
      } else if (bgValue.startsWith('linear')) {
        const colors = bgValue.match(/#[a-f0-9]{6}/gi) || ['#000'];
        const grad = ctx.createLinearGradient(0, 0, 1920, 1080);
        colors.forEach((c, i) => grad.addColorStop(i / Math.max(1, colors.length - 1), c));
        ctx.fillStyle = grad; ctx.fillRect(0, 0, 1920, 1080);
      } else { ctx.fillStyle = bgValue; ctx.fillRect(0, 0, 1920, 1080); }
      // Draw text elements
      for (const el of elements) {
        if (el.type === 'text' || el.type === 'clock' || el.type === 'date' || el.type === 'countdown') {
          ctx.save();
          ctx.font = `${el.bold ? 'bold ' : ''}${(el.fontSize / 100) * 1080}px ${el.fontFamily || 'Arial'}`;
          ctx.fillStyle = el.color || '#FFF';
          if (el.shadow) { ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 8; ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 2; }
          let text = el.text || el.label || '';
          if (el.type === 'clock') text = new Date().toLocaleTimeString();
          if (el.type === 'date') text = new Date().toLocaleDateString();
          ctx.fillText(text, (el.x / 100) * 1920, (el.y / 100) * 1080 + (el.fontSize / 100) * 1080);
          ctx.restore();
        } else if (el.type === 'shape') {
          ctx.save();
          ctx.globalAlpha = el.opacity || 1;
          ctx.fillStyle = el.color;
          ctx.fillRect((el.x / 100) * 1920, (el.y / 100) * 1080, (el.width / 100) * 1920, (el.height / 100) * 1080);
          ctx.restore();
        }
      }
      const link = document.createElement('a');
      link.download = 'signage-design.png'; link.href = canvas.toDataURL('image/png'); link.click();
    } catch (err) { showToast(t('designer.toast.export_failed', { error: err.message }), 'error'); }
  };

  // Load saved design
  document.getElementById('loadDesignBtn').onclick = () => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
    input.onchange = () => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target.result);
          elements = data.elements || [];
          bgValue = data.bgValue || '#000';
          bgImageDataUrl = data.bgImageDataUrl || null;
          redraw();
          showToast(t('designer.toast.loaded'), 'success');
        } catch { showToast(t('designer.toast.invalid_file'), 'error'); }
      };
      reader.readAsText(input.files[0]);
    };
    input.click();
  };

  // Mouse interaction on preview
  const preview = document.getElementById('designPreview');
  preview.onmousedown = (e) => {
    const rect = preview.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * 100;
    const py = ((e.clientY - rect.top) / rect.height) * 100;

    selectedIdx = -1;
    for (let i = elements.length - 1; i >= 0; i--) {
      const el = elements[i];
      const b = getBounds(el);
      if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) {
        selectedIdx = i;
        dragging = el;
        dragStart = { px, py, ox: el.x, oy: el.y };
        break;
      }
    }
    redraw();
  };
  preview.onmousemove = (e) => {
    if (!dragging || !dragStart) return;
    const rect = preview.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * 100;
    const py = ((e.clientY - rect.top) / rect.height) * 100;
    dragging.x = Math.max(0, Math.min(95, dragStart.ox + (px - dragStart.px)));
    dragging.y = Math.max(0, Math.min(95, dragStart.oy + (py - dragStart.py)));
    redraw();
  };
  preview.onmouseup = () => { dragging = null; dragStart = null; };

  redraw();
  if (widgetId) loadWidgetForEdit(widgetId);
}

// Reopen a designer-made widget for visual editing: pull its stored `design` source back into the
// canvas and remember its id/name so Publish updates it in place. Widgets without a design source
// (e.g. hand-written text widgets) simply don't route here.
async function loadWidgetForEdit(widgetId) {
  try {
    const w = await api.getWidget(widgetId);
    const cfg = typeof w.config === 'string' ? JSON.parse(w.config || '{}') : (w.config || {});
    if (cfg.design && Array.isArray(cfg.design.elements)) {
      // Preferred: the exact design source saved with the widget.
      elements = cfg.design.elements;
      bgValue = cfg.design.bgValue || '#000000';
      bgImageDataUrl = cfg.design.bgImage || null;
    } else if (typeof cfg.html === 'string' && cfg.html) {
      // Legacy widget (published before the design source was stored): best-effort reconstruct the
      // editable elements from the deterministic HTML the designer produced.
      const r = reconstructDesign(cfg.html);
      elements = r.elements;
      bgValue = cfg.background || '#000000';
      bgImageDataUrl = r.bgImage || null;
    } else {
      return; // nothing to rehydrate
    }
    editingWidgetId = w.id;
    editingWidgetName = w.name;
    selectedIdx = -1;
    const pub = document.getElementById('publishBtn');
    if (pub) pub.textContent = t('common.save'); // updating an existing widget, not publishing a new one
    redraw();
    showToast(t('designer.toast.loaded'), 'success');
  } catch (e) { showToast((e && e.message) || t('designer.toast.invalid_file'), 'error'); }
}

// Best-effort reverse of generateInnerHTML() for LEGACY widgets that stored only the rendered HTML.
// The designer's output is deterministic (positioned elements + a known <script> per dynamic type), so
// it round-trips cleanly for designer-made content; unrecognized nodes are skipped. Returns { elements,
// bgImage }.
function reconstructDesign(html) {
  const out = { elements: [], bgImage: null };
  let root;
  try { root = new DOMParser().parseFromString(`<div id="__r">${html}</div>`, 'text/html').getElementById('__r'); }
  catch (e) { return out; }
  if (!root) return out;
  const rgbToHex = (c) => {
    if (!c) return '#FFFFFF';
    if (c[0] === '#') return c;
    const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    return m ? '#' + [1, 2, 3].map((i) => (+m[i]).toString(16).padStart(2, '0')).join('') : '#FFFFFF';
  };
  const pct = (v) => parseFloat(v) || 0;
  const fontVw = (el) => { const f = parseFloat(el.style.fontSize); return isFinite(f) ? Math.round(f * 10) : 36; };
  const scriptFor = (id) => { for (const s of root.querySelectorAll('script')) if ((s.textContent || '').includes(`'${id}'`)) return s.textContent || ''; return ''; };
  for (const node of Array.from(root.children)) {
    const tag = node.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style') continue;
    const st = node.style;
    const x = pct(st.left), y = pct(st.top);
    if (tag === 'img') {
      if (!st.left && (st.inset || st.objectFit === 'cover')) { out.bgImage = node.getAttribute('src'); continue; } // baked background
      out.elements.push({ type: 'image', x, y, width: pct(st.width), height: pct(st.height), src: node.getAttribute('src') });
    } else if (tag === 'video') {
      out.elements.push({ type: 'video', x, y, width: pct(st.width), height: pct(st.height), src: node.getAttribute('src'), muted: node.hasAttribute('muted'), loop: node.hasAttribute('loop') });
    } else if (tag === 'iframe') {
      out.elements.push({ type: 'webpage', x, y, width: pct(st.width), height: pct(st.height), url: node.getAttribute('src') });
    } else if (tag === 'div') {
      const id = node.id || '';
      const base = { x, y, fontSize: fontVw(node), color: rgbToHex(st.color), fontFamily: st.fontFamily || 'Arial' };
      const cd = node.querySelector('[id^="cd"]');   // countdown: inner cdN div
      const tk = node.querySelector('[id^="t"]');    // ticker: inner tN div
      if (/^c\d+$/.test(id)) { const sc = scriptFor(id); out.elements.push({ ...base, bold: true, type: 'clock', showSeconds: /second:'2-digit'/.test(sc), format: /hour12:false/.test(sc) ? '24h' : '12h' }); }
      else if (/^d\d+$/.test(id)) { out.elements.push({ ...base, type: 'date' }); }
      else if (/^w\d+$/.test(id)) { const sc = scriptFor(id); const loc = (sc.match(/wttr\.in\/([^?]+)\?/) || [])[1]; out.elements.push({ ...base, type: 'weather', location: loc ? decodeURIComponent(loc) : '', units: /temp_C/.test(sc) ? 'metric' : 'imperial' }); }
      else if (cd) { const sc = scriptFor(cd.id); const lbl = node.querySelector('div'); out.elements.push({ ...base, type: 'countdown', label: lbl ? lbl.textContent : '', targetDate: (sc.match(/new Date\('([^']+)'\)/) || [])[1] || '' }); }
      else if (tk && (st.overflow === 'hidden' || st.display === 'flex')) { const sc = scriptFor(tk.id); const feed = (sc.match(/rss_url=([^']+)'/) || [])[1]; out.elements.push({ type: 'ticker', x, y, width: pct(st.width), height: pct(st.height), bgColor: rgbToHex(st.background || st.backgroundColor), color: rgbToHex(tk.style.color), feedUrl: feed ? decodeURIComponent(feed) : '', speed: parseFloat((tk.style.animation || '').match(/([\d.]+)s/)?.[1]) || 30, fontSize: fontVw(tk) }); }
      else if ((st.background || st.backgroundColor) && st.width && st.height && !node.textContent.trim()) { const circle = st.borderRadius === '50%'; out.elements.push({ type: 'shape', x, y, width: pct(st.width), height: pct(st.height), color: rgbToHex(st.background || st.backgroundColor), opacity: parseFloat(st.opacity) || 1, shape: circle ? 'circle' : 'rect', radius: circle ? 0 : (parseInt(st.borderRadius) || 0) }); }
      else { out.elements.push({ ...base, type: 'text', text: node.textContent, bold: st.fontWeight === 'bold' || st.fontWeight === '700', shadow: !!st.textShadow }); }
    }
  }
  return out;
}

function addElement(el) {
  elements.push(el);
  selectedIdx = elements.length - 1;
  redraw();
}

// #41: per-workspace AI endpoint config (BYO OpenAI-compatible endpoint + key).
async function openAiSettings() {
  let cur = {};
  try { cur = await api.aiGetSettings(); } catch { /* show empty form */ }
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="modal" style="max-width:520px;width:95vw">
      <div class="modal-header">
        <h3>${t('designer.ai.settings_title')}</h3>
        <button class="btn-icon" data-ai-close aria-label="Close"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="modal-body">
        <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px">${t('designer.ai.settings_desc')}</p>
        <div class="form-group"><label>${t('designer.ai.base_url')}</label>
          <input id="aiBaseUrl" class="input" value="${esc(cur.base_url || '')}" placeholder="https://api.openai.com/v1  ·  http://localhost:11434/v1" style="width:100%"></div>
        <div class="form-group"><label>${t('designer.ai.model')}</label>
          <div style="display:flex;gap:6px">
            <input id="aiModel" class="input" list="aiModelList" value="${esc(cur.model || '')}" placeholder="gpt-4o-mini  ·  llama3.1:8b" style="flex:1" autocomplete="off">
            <button class="btn btn-secondary btn-sm" id="aiLoadModels" type="button" style="white-space:nowrap">${t('designer.ai.load_models')}</button>
          </div>
          <datalist id="aiModelList"></datalist>
          <div id="aiModelMsg" style="font-size:11px;color:var(--text-muted);margin-top:4px"></div></div>
        <div class="form-group"><label>${t('designer.ai.api_key')}</label>
          <input id="aiKey" class="input" type="password" autocomplete="off" placeholder="${cur.has_key ? t('designer.ai.key_set') : t('designer.ai.key_placeholder')}" style="width:100%">
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('designer.ai.key_hint')}</div></div>

        <hr style="border:none;border-top:1px solid var(--border);margin:14px 0 10px">
        <h4 style="font-size:13px;margin-bottom:4px">${t('designer.ai.images_title')}</h4>
        <p style="font-size:11px;color:var(--text-muted);margin-bottom:8px">${t('designer.ai.images_desc')}</p>
        <div class="form-group"><label>${t('designer.ai.image_provider')}</label>
          <select id="aiImageProvider" class="input" style="width:100%">
            <option value="" ${!cur.image_provider ? 'selected' : ''}>${t('designer.ai.image_off')}</option>
            <option value="sdcpp" ${cur.image_provider === 'sdcpp' ? 'selected' : ''}>Stable Diffusion — local (sd.cpp)</option>
            <option value="openai" ${cur.image_provider === 'openai' ? 'selected' : ''}>OpenAI / OpenAI-compatible</option>
            <option value="comfyui" ${cur.image_provider === 'comfyui' ? 'selected' : ''}>ComfyUI</option>
          </select></div>
        <div class="form-group"><label>${t('designer.ai.image_base_url')}</label>
          <input id="aiImageBaseUrl" class="input" value="${esc(cur.image_base_url || '')}" placeholder="http://localhost:8080/v1  ·  http://localhost:8188" style="width:100%"></div>
        <div class="form-group"><label>${t('designer.ai.image_model')}</label>
          <input id="aiImageModel" class="input" value="${esc(cur.image_model || '')}" placeholder="${t('designer.ai.image_model_ph')}" style="width:100%"></div>
        <div class="form-group"><label>${t('designer.ai.image_api_key')}</label>
          <input id="aiImageKey" class="input" type="password" autocomplete="off" placeholder="${cur.has_image_key ? t('designer.ai.key_set') : t('designer.ai.image_key_ph')}" style="width:100%">
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('designer.ai.image_key_hint')}</div></div>
        <div id="aiSettingsErr" style="display:none;color:var(--danger);font-size:13px;margin-top:8px"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-ai-close>${t('common.cancel')}</button>
        <button class="btn btn-primary" id="aiSaveSettings">${t('common.save')}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelectorAll('[data-ai-close]').forEach(b => b.onclick = close);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  // Load the model list from the entered endpoint into the dropdown.
  overlay.querySelector('#aiLoadModels').onclick = async () => {
    const msg = overlay.querySelector('#aiModelMsg');
    const base_url = overlay.querySelector('#aiBaseUrl').value.trim();
    if (!base_url) { msg.style.color = 'var(--danger)'; msg.textContent = t('designer.ai.need_base_url'); return; }
    const btn = overlay.querySelector('#aiLoadModels');
    btn.disabled = true;
    msg.style.color = 'var(--text-muted)'; msg.textContent = t('designer.ai.loading_models');
    try {
      const r = await api.aiListModels(base_url, overlay.querySelector('#aiKey').value || undefined);
      const models = r.models || [];
      overlay.querySelector('#aiModelList').innerHTML = models.map(m => `<option value="${esc(m)}"></option>`).join('');
      const modelInput = overlay.querySelector('#aiModel');
      if (models.length && !modelInput.value) modelInput.value = models[0];
      msg.textContent = t('designer.ai.models_loaded', { n: models.length });
    } catch (e2) {
      msg.style.color = 'var(--danger)'; msg.textContent = (e2 && e2.message) || t('designer.ai.models_failed');
    } finally {
      btn.disabled = false;
    }
  };

  overlay.querySelector('#aiSaveSettings').onclick = async () => {
    const errEl = overlay.querySelector('#aiSettingsErr');
    errEl.style.display = 'none';
    const data = {
      base_url: overlay.querySelector('#aiBaseUrl').value.trim(),
      model: overlay.querySelector('#aiModel').value.trim(),
      image_provider: overlay.querySelector('#aiImageProvider').value,
      image_base_url: overlay.querySelector('#aiImageBaseUrl').value.trim(),
      image_model: overlay.querySelector('#aiImageModel').value.trim(),
    };
    const key = overlay.querySelector('#aiKey').value;
    if (key) data.api_key = key;
    const imgKey = overlay.querySelector('#aiImageKey').value;
    if (imgKey) data.image_api_key = imgKey;
    try {
      await api.aiSaveSettings(data);
      showToast(t('designer.ai.saved'), 'success');
      close();
    } catch (e2) {
      errEl.textContent = (e2 && e2.message) || t('designer.ai.save_failed');
      errEl.style.display = 'block';
    }
  };
}

function getBounds(el) {
  const w = el.width || el.size || (el.fontSize ? el.fontSize * 0.6 * (el.text?.length || 8) / 100 * 100 : 20);
  const h = el.height || el.size || (el.fontSize ? el.fontSize * 1.2 / 100 * 100 : 10);
  return { x: el.x, y: el.y, w: Math.min(w, 100), h: Math.min(h, 100) };
}

function redraw() {
  const preview = document.getElementById('designPreview');
  if (!preview) return;

  let html = '';

  // Background
  if (bgImageDataUrl) {
    preview.style.background = `url(${bgImageDataUrl}) center/cover`;
  } else {
    preview.style.background = bgValue;
  }

  // Elements
  elements.forEach((el, i) => {
    const selected = i === selectedIdx;
    const border = selected ? 'outline:2px solid #3b82f6;outline-offset:2px;' : '';
    const cursor = 'cursor:move;';

    switch (el.type) {
      case 'text':
        html += `<div style="position:absolute;left:${el.x}%;top:${el.y}%;font-size:${el.fontSize / 10}cqw;font-family:${el.fontFamily};color:${el.color};font-weight:${el.bold ? 'bold' : 'normal'};${el.shadow ? 'text-shadow:2px 2px 4px rgba(0,0,0,0.5);' : ''}white-space:nowrap;${border}${cursor}" data-idx="${i}">${el.text}</div>`;
        break;
      case 'clock':
        html += `<div style="position:absolute;left:${el.x}%;top:${el.y}%;font-size:${el.fontSize / 10}cqw;font-family:${el.fontFamily};color:${el.color};font-weight:bold;${el.shadow ? 'text-shadow:2px 2px 4px rgba(0,0,0,0.5);' : ''}${border}${cursor}" data-idx="${i}" id="clock_${i}"></div>`;
        break;
      case 'date':
        html += `<div style="position:absolute;left:${el.x}%;top:${el.y}%;font-size:${el.fontSize / 10}cqw;font-family:${el.fontFamily};color:${el.color};${el.shadow ? 'text-shadow:2px 2px 4px rgba(0,0,0,0.5);' : ''}${border}${cursor}" data-idx="${i}" id="date_${i}"></div>`;
        break;
      case 'image':
        html += `<img src="${el.src}" style="position:absolute;left:${el.x}%;top:${el.y}%;width:${el.width}%;height:${el.height}%;object-fit:contain;${border}${cursor}" data-idx="${i}" draggable="false">`;
        break;
      case 'video':
        html += `<video src="${el.src}" ${el.muted ? 'muted' : ''} ${el.loop ? 'loop' : ''} autoplay playsinline style="position:absolute;left:${el.x}%;top:${el.y}%;width:${el.width}%;height:${el.height}%;object-fit:cover;${border}${cursor}" data-idx="${i}"></video>`;
        break;
      case 'shape':
        html += `<div style="position:absolute;left:${el.x}%;top:${el.y}%;width:${el.width}%;height:${el.height}%;background:${el.color};opacity:${el.opacity};border-radius:${el.radius || 0}px;${el.shape === 'circle' ? 'border-radius:50%;' : ''}${border}${cursor}" data-idx="${i}"></div>`;
        break;
      case 'weather':
        html += `<div style="position:absolute;left:${el.x}%;top:${el.y}%;font-size:${el.fontSize / 10}cqw;color:${el.color};${border}${cursor}" data-idx="${i}" id="weather_${i}">&#9925; ${t('common.loading')}</div>`;
        break;
      case 'ticker':
        html += `<div style="position:absolute;left:${el.x}%;top:${el.y}%;width:${el.width}%;height:${el.height}%;background:${el.bgColor};overflow:hidden;display:flex;align-items:center;${border}" data-idx="${i}">
          <div style="white-space:nowrap;animation:ticker ${el.speed || 30}s linear infinite;font-size:${el.fontSize / 10}cqw;color:${el.color}" id="ticker_${i}">${t('designer.loading_news')}</div>
        </div>`;
        break;
      case 'qr':
        html += `<div style="position:absolute;left:${el.x}%;top:${el.y}%;width:${el.size}%;aspect-ratio:1;background:${el.bgColor};display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:8px;${border}${cursor}" data-idx="${i}">
          <div style="font-size:1.5vw;color:${el.fgColor};font-weight:bold">${t('designer.qr_label')}</div>
          <div style="font-size:0.8vw;color:${el.fgColor};opacity:0.7;margin-top:4px">${el.data?.slice(0, 25)}</div>
        </div>`;
        break;
      case 'countdown':
        html += `<div style="position:absolute;left:${el.x}%;top:${el.y}%;text-align:center;color:${el.color};${border}${cursor}" data-idx="${i}">
          <div style="font-size:${el.fontSize / 15}cqw;opacity:0.8">${el.label || ''}</div>
          <div style="font-size:${el.fontSize / 10}cqw;font-weight:bold" id="countdown_${i}"></div>
        </div>`;
        break;
      case 'webpage':
        html += `<iframe src="${el.url}" style="position:absolute;left:${el.x}%;top:${el.y}%;width:${el.width}%;height:${el.height}%;border:none;pointer-events:none;${border}" data-idx="${i}"></iframe>`;
        break;
    }
  });

  // Add ticker animation CSS
  html += `<style>@keyframes ticker { 0% { transform: translateX(100%); } 100% { transform: translateX(-100%); } }</style>`;

  preview.innerHTML = html;

  // Update dynamic elements
  updateDynamic();

  // Update properties panel
  updateProps();
  updateLayers();
}

function updateDynamic() {
  elements.forEach((el, i) => {
    if (el.type === 'clock') {
      const clockEl = document.getElementById(`clock_${i}`);
      if (clockEl) {
        const update = () => {
          const opts = { hour: '2-digit', minute: '2-digit' };
          if (el.showSeconds) opts.second = '2-digit';
          opts.hour12 = el.format !== '24h';
          clockEl.textContent = new Date().toLocaleTimeString('en-US', opts);
        };
        update();
        // Only set interval if element still exists
        const iv = setInterval(() => { if (document.getElementById(`clock_${i}`)) update(); else clearInterval(iv); }, 1000);
      }
    }
    if (el.type === 'date') {
      const dateEl = document.getElementById(`date_${i}`);
      if (dateEl) dateEl.textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    }
    if (el.type === 'countdown') {
      const cdEl = document.getElementById(`countdown_${i}`);
      if (cdEl && el.targetDate) {
        const update = () => {
          const diff = new Date(el.targetDate) - new Date();
          if (diff <= 0) { cdEl.textContent = t('designer.countdown_now'); return; }
          const days = Math.floor(diff / 86400000);
          const hours = Math.floor((diff % 86400000) / 3600000);
          const mins = Math.floor((diff % 3600000) / 60000);
          cdEl.textContent = `${days}d ${hours}h ${mins}m`;
        };
        update();
        const iv = setInterval(() => { if (document.getElementById(`countdown_${i}`)) update(); else clearInterval(iv); }, 60000);
      }
    }
    if (el.type === 'weather') {
      const wEl = document.getElementById(`weather_${i}`);
      if (wEl && el.location) {
        fetch(`https://wttr.in/${encodeURIComponent(el.location)}?format=j1`).then(r => r.json()).then(d => {
          const cur = d.current_condition?.[0];
          if (cur) {
            const temp = el.units === 'metric' ? cur.temp_C + '°C' : cur.temp_F + '°F';
            wEl.textContent = `${temp} ${cur.weatherDesc?.[0]?.value || ''}`;
          }
        }).catch(() => { wEl.textContent = '⛅ ' + el.location; });
      }
    }
    if (el.type === 'ticker') {
      const tEl = document.getElementById(`ticker_${i}`);
      if (tEl && el.feedUrl) {
        fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(el.feedUrl)}`).then(r => r.json()).then(d => {
          tEl.textContent = (d.items || []).map(item => item.title).join('  •  ') || t('designer.no_items');
        }).catch(() => { tEl.textContent = t('designer.feed_unavailable'); });
      }
    }
  });
}

function updateProps() {
  const panel = document.getElementById('propPanel');
  const fields = document.getElementById('propFields');
  if (selectedIdx < 0 || !elements[selectedIdx]) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  const el = elements[selectedIdx];
  let html = '';

  // Common position
  html += `<div style="display:flex;gap:6px;margin-bottom:8px">
    <div class="form-group" style="flex:1;margin:0"><label>X%</label><input type="number" class="input" value="${Math.round(el.x)}" data-prop="x" min="0" max="100"></div>
    <div class="form-group" style="flex:1;margin:0"><label>Y%</label><input type="number" class="input" value="${Math.round(el.y)}" data-prop="y" min="0" max="100"></div>
  </div>`;

  if (el.type === 'text') {
    html += `<div class="form-group"><label>${t('designer.prop.text')}</label><input type="text" class="input" value="${el.text}" data-prop="text"></div>
      <div class="form-group"><label>${t('designer.prop.size')}</label><input type="range" min="8" max="120" value="${el.fontSize}" data-prop="fontSize" style="width:100%"><span style="font-size:11px;color:var(--text-muted)">${el.fontSize}px</span></div>
      <div class="form-group"><label>${t('designer.prop.font')}</label><select class="input" style="background:var(--bg-input)" data-prop="fontFamily">${FONTS.map(f => `<option ${f === el.fontFamily ? 'selected' : ''}>${f}</option>`).join('')}</select></div>
      <div class="form-group"><label>${t('designer.prop.color')}</label><input type="color" value="${el.color}" data-prop="color" style="width:100%;height:28px;border:none;cursor:pointer"></div>
      <label style="font-size:12px;display:flex;gap:6px;margin:4px 0"><input type="checkbox" ${el.bold ? 'checked' : ''} data-prop="bold"> ${t('designer.prop.bold')}</label>
      <label style="font-size:12px;display:flex;gap:6px;margin:4px 0"><input type="checkbox" ${el.shadow ? 'checked' : ''} data-prop="shadow"> ${t('designer.prop.shadow')}</label>`;
  } else if (el.type === 'clock') {
    html += `<div class="form-group"><label>${t('designer.prop.size')}</label><input type="range" min="16" max="120" value="${el.fontSize}" data-prop="fontSize" style="width:100%"></div>
      <div class="form-group"><label>${t('designer.prop.color')}</label><input type="color" value="${el.color}" data-prop="color" style="width:100%;height:28px;border:none"></div>
      <div class="form-group"><label>${t('designer.prop.format')}</label><select class="input" style="background:var(--bg-input)" data-prop="format"><option ${el.format === '12h' ? 'selected' : ''} value="12h">12h</option><option ${el.format === '24h' ? 'selected' : ''} value="24h">24h</option></select></div>
      <label style="font-size:12px;display:flex;gap:6px;margin:4px 0"><input type="checkbox" ${el.showSeconds ? 'checked' : ''} data-prop="showSeconds"> ${t('designer.prop.show_seconds')}</label>`;
  } else if (el.type === 'image' || el.type === 'video' || el.type === 'webpage') {
    html += `<div style="display:flex;gap:6px"><div class="form-group" style="flex:1;margin:0"><label>W%</label><input type="number" class="input" value="${Math.round(el.width)}" data-prop="width"></div>
      <div class="form-group" style="flex:1;margin:0"><label>H%</label><input type="number" class="input" value="${Math.round(el.height)}" data-prop="height"></div></div>`;
    if (el.type === 'video') html += `<label style="font-size:12px;display:flex;gap:6px;margin:8px 0"><input type="checkbox" ${el.muted ? 'checked' : ''} data-prop="muted"> ${t('designer.prop.muted')}</label>
      <label style="font-size:12px;display:flex;gap:6px;margin:4px 0"><input type="checkbox" ${el.loop ? 'checked' : ''} data-prop="loop"> ${t('designer.prop.loop')}</label>`;
  } else if (el.type === 'shape') {
    html += `<div style="display:flex;gap:6px"><div class="form-group" style="flex:1;margin:0"><label>W%</label><input type="number" class="input" value="${Math.round(el.width)}" data-prop="width"></div>
      <div class="form-group" style="flex:1;margin:0"><label>H%</label><input type="number" class="input" value="${Math.round(el.height)}" data-prop="height"></div></div>
      <div class="form-group"><label>${t('designer.prop.color')}</label><input type="color" value="${el.color}" data-prop="color" style="width:100%;height:28px;border:none"></div>
      <div class="form-group"><label>${t('designer.prop.opacity')}</label><input type="range" min="0" max="1" step="0.1" value="${el.opacity}" data-prop="opacity" style="width:100%"></div>
      <div class="form-group"><label>${t('designer.prop.shape')}</label><select class="input" style="background:var(--bg-input)" data-prop="shape"><option ${el.shape === 'rect' ? 'selected' : ''}>rect</option><option ${el.shape === 'circle' ? 'selected' : ''}>circle</option></select></div>`;
  } else if (el.type === 'weather') {
    html += `<div class="form-group"><label>${t('designer.prop.location')}</label><input type="text" class="input" value="${el.location}" data-prop="location"></div>
      <div class="form-group"><label>${t('widget.field.units')}</label><select class="input" data-prop="units">
        <option value="imperial" ${el.units !== 'metric' ? 'selected' : ''}>${t('widget.field.units_imperial')}</option>
        <option value="metric" ${el.units === 'metric' ? 'selected' : ''}>${t('widget.field.units_metric')}</option>
      </select></div>
      <div class="form-group"><label>${t('designer.prop.size')}</label><input type="range" min="16" max="80" value="${el.fontSize}" data-prop="fontSize" style="width:100%"></div>
      <div class="form-group"><label>${t('designer.prop.color')}</label><input type="color" value="${el.color}" data-prop="color" style="width:100%;height:28px;border:none"></div>`;
  } else if (el.type === 'ticker') {
    html += `<div class="form-group"><label>${t('designer.prop.feed_url')}</label><input type="text" class="input" value="${el.feedUrl}" data-prop="feedUrl"></div>
      <div class="form-group"><label>${t('designer.prop.speed')}</label><input type="number" class="input" value="${el.speed}" data-prop="speed"></div>
      <div class="form-group"><label>${t('designer.prop.text_color')}</label><input type="color" value="${el.color}" data-prop="color" style="width:100%;height:28px;border:none"></div>
      <div class="form-group"><label>${t('designer.prop.bg_color')}</label><input type="text" class="input" value="${el.bgColor}" data-prop="bgColor"></div>`;
  } else if (el.type === 'countdown') {
    html += `<div class="form-group"><label>${t('designer.prop.target_date')}</label><input type="date" class="input" value="${el.targetDate}" data-prop="targetDate"></div>
      <div class="form-group"><label>${t('designer.prop.label')}</label><input type="text" class="input" value="${el.label}" data-prop="label"></div>
      <div class="form-group"><label>${t('designer.prop.size')}</label><input type="range" min="16" max="100" value="${el.fontSize}" data-prop="fontSize" style="width:100%"></div>
      <div class="form-group"><label>${t('designer.prop.color')}</label><input type="color" value="${el.color}" data-prop="color" style="width:100%;height:28px;border:none"></div>`;
  }

  // Save design button
  html += `<button class="btn btn-secondary btn-sm" style="width:100%;margin-top:8px;justify-content:center" onclick="(() => {
    const a = document.createElement('a');
    a.download = 'design.json';
    a.href = 'data:application/json,' + encodeURIComponent(JSON.stringify({elements: ${JSON.stringify(elements)}, bgValue: '${bgValue}'}));
    a.click();
  })()">${t('designer.save_design_file')}</button>`;

  fields.innerHTML = html;

  fields.querySelectorAll('[data-prop]').forEach(input => {
    const handler = () => {
      const prop = input.dataset.prop;
      if (input.type === 'checkbox') el[prop] = input.checked;
      else if (input.type === 'number' || input.type === 'range') el[prop] = parseFloat(input.value);
      else el[prop] = input.value;
      redraw();
    };
    input.oninput = handler;
    input.onchange = handler;
  });
}

function updateLayers() {
  const list = document.getElementById('layerList');
  if (!list) return;
  const typeIcons = { text: '&#128172;', clock: '&#128339;', date: '&#128197;', image: '&#128247;', video: '&#127916;', shape: '&#9632;', weather: '&#9925;', ticker: '&#128240;', qr: '&#9641;', countdown: '&#9201;', webpage: '&#127760;' };
  list.innerHTML = elements.map((el, i) => `
    <div style="padding:4px 8px;margin-bottom:2px;border-radius:4px;cursor:pointer;display:flex;align-items:center;gap:6px;
      background:${i === selectedIdx ? 'var(--accent)' : 'var(--bg-secondary)'};
      color:${i === selectedIdx ? 'white' : 'var(--text-secondary)'}" data-layer="${i}">
      <span>${typeIcons[el.type] || '?'}</span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${el.text || el.type}</span>
    </div>
  `).join('') || `<p style="color:var(--text-muted)">${t('designer.no_elements')}</p>`;

  list.querySelectorAll('[data-layer]').forEach(el => {
    el.onclick = () => { selectedIdx = parseInt(el.dataset.layer); redraw(); };
  });
}

function generateInnerHTML() {
  let html = '';
  // A background image (e.g. AI-generated) is the body background in the editor;
  // bake it into the published HTML as a full-cover bottom layer so it survives.
  if (bgImageDataUrl) html += `<img src="${bgImageDataUrl}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" alt="">`;
  elements.forEach((el, i) => {
    // Use vw units for font sizes (same as designer preview) so output scales to any viewport
    const fs = el.fontSize / 10;
    const fsLabel = el.fontSize / 15;
    switch (el.type) {
      case 'text':
        html += `<div style="position:absolute;left:${el.x}%;top:${el.y}%;font-size:${fs}vw;font-family:${el.fontFamily};color:${el.color};font-weight:${el.bold ? 'bold' : 'normal'};${el.shadow ? 'text-shadow:2px 2px 4px rgba(0,0,0,0.5);' : ''}white-space:nowrap">${el.text}</div>`;
        break;
      case 'clock':
        html += `<div style="position:absolute;left:${el.x}%;top:${el.y}%;font-size:${fs}vw;font-family:${el.fontFamily};color:${el.color};font-weight:bold" id="c${i}"></div>
          <script>setInterval(()=>{const o={hour:'2-digit',minute:'2-digit'${el.showSeconds ? ",second:'2-digit'" : ''},hour12:${el.format !== '24h'}};document.getElementById('c${i}').textContent=new Date().toLocaleTimeString('en-US',o)},1000)</script>`;
        break;
      case 'date':
        html += `<div style="position:absolute;left:${el.x}%;top:${el.y}%;font-size:${fs}vw;font-family:${el.fontFamily};color:${el.color}" id="d${i}"></div>
          <script>document.getElementById('d${i}').textContent=new Date().toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'})</script>`;
        break;
      case 'image':
        html += `<img src="${el.src}" style="position:absolute;left:${el.x}%;top:${el.y}%;width:${el.width}%;height:${el.height}%;object-fit:contain">`;
        break;
      case 'video':
        html += `<video src="${el.src}" ${el.muted ? 'muted' : ''} ${el.loop ? 'loop' : ''} autoplay playsinline style="position:absolute;left:${el.x}%;top:${el.y}%;width:${el.width}%;height:${el.height}%;object-fit:cover"></video>`;
        break;
      case 'shape':
        html += `<div style="position:absolute;left:${el.x}%;top:${el.y}%;width:${el.width}%;height:${el.height}%;background:${el.color};opacity:${el.opacity};${el.shape === 'circle' ? 'border-radius:50%' : `border-radius:${el.radius}px`}"></div>`;
        break;
      case 'weather':
        html += `<div style="position:absolute;left:${el.x}%;top:${el.y}%;font-size:${fs}vw;color:${el.color}" id="w${i}">Loading...</div>
          <script>fetch('https://wttr.in/${encodeURIComponent(el.location)}?format=j1').then(r=>r.json()).then(d=>{const c=d.current_condition[0];document.getElementById('w${i}').textContent=c.temp_${el.units === 'metric' ? 'C' : 'F'}+'°${el.units === 'metric' ? 'C' : 'F'} '+c.weatherDesc[0].value}).catch(()=>{})</script>`;
        break;
      case 'ticker':
        html += `<div style="position:absolute;left:${el.x}%;top:${el.y}%;width:${el.width}%;height:${el.height}%;background:${el.bgColor};overflow:hidden;display:flex;align-items:center">
          <div style="white-space:nowrap;animation:t ${el.speed}s linear infinite;font-size:${fs}vw;color:${el.color}" id="t${i}">Loading...</div></div>
          <style>@keyframes t{0%{transform:translateX(100%)}100%{transform:translateX(-100%)}}</style>
          <script>fetch('https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(el.feedUrl)}').then(r=>r.json()).then(d=>{document.getElementById('t${i}').textContent=d.items.map(i=>i.title).join('  •  ')}).catch(()=>{})</script>`;
        break;
      case 'countdown':
        html += `<div style="position:absolute;left:${el.x}%;top:${el.y}%;text-align:center;color:${el.color}">
          <div style="font-size:${fsLabel}vw;opacity:0.8">${el.label}</div>
          <div style="font-size:${fs}vw;font-weight:bold" id="cd${i}"></div></div>
          <script>setInterval(()=>{const d=new Date('${el.targetDate}')-new Date();if(d<=0){document.getElementById('cd${i}').textContent='NOW!';return}document.getElementById('cd${i}').textContent=Math.floor(d/864e5)+'d '+Math.floor(d%864e5/36e5)+'h '+Math.floor(d%36e5/6e4)+'m'},6e4)</script>`;
        break;
      case 'webpage':
        html += `<iframe src="${el.url}" style="position:absolute;left:${el.x}%;top:${el.y}%;width:${el.width}%;height:${el.height}%;border:none"></iframe>`;
        break;
    }
  });
  return html;
}

function generateHTML() {
  return `<!DOCTYPE html><html><head><style>*{margin:0;padding:0;box-sizing:border-box}body{width:100vw;height:100vh;overflow:hidden;background:${bgImageDataUrl ? `url(${bgImageDataUrl}) center/cover` : bgValue}}</style></head><body>${generateInnerHTML()}</body></html>`;
}

export function cleanup() {}
