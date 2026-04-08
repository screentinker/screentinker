import { api } from '../api.js';
import { showToast } from '../components/toast.js';

const BACKGROUNDS = [
  { name: 'Black', value: '#000000' },
  { name: 'Dark Blue', value: '#0f172a' },
  { name: 'Dark Gradient', value: 'linear-gradient(135deg, #0c0c0c 0%, #1a1a2e 50%, #16213e 100%)' },
  { name: 'Blue Gradient', value: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' },
  { name: 'Sunset', value: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)' },
  { name: 'Ocean', value: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)' },
  { name: 'Forest', value: 'linear-gradient(135deg, #134e5e 0%, #71b280 100%)' },
  { name: 'Dark Red', value: 'linear-gradient(135deg, #200122 0%, #6f0000 100%)' },
  { name: 'White', value: '#FFFFFF' },
];

const FONTS = ['Arial', 'Helvetica', 'Georgia', 'Impact', 'Verdana', 'Trebuchet MS', 'Courier New', 'Times New Roman'];

let elements = [];
let selectedIdx = -1;
let bgValue = '#000000';
let bgImageDataUrl = null;
let dragging = null;
let dragStart = null;

export function render(container) {
  elements = [];
  selectedIdx = -1;
  bgValue = '#000000';
  bgImageDataUrl = null;

  container.innerHTML = `
    <div class="page-header">
      <div><h1>Content Designer <span class="help-tip" data-tip="Create custom signage with live elements: clocks, weather, RSS tickers, countdowns, QR codes. Publish as a widget or export as PNG.">?</span></h1><div class="subtitle">Create dynamic signage content</div></div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary" id="loadDesignBtn">Load Design</button>
        <button class="btn btn-secondary" id="exportPngBtn">Export PNG</button>
        <button class="btn btn-primary" id="publishBtn">Publish to Library</button>
      </div>
    </div>
    <div style="display:flex;gap:20px">
      <!-- Preview -->
      <div style="flex:1">
        <div id="previewWrap" style="position:relative;border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;background:#000;aspect-ratio:16/9">
          <div id="designPreview" style="position:relative;width:100%;height:100%;overflow:hidden"></div>
        </div>
        <p style="font-size:11px;color:var(--text-muted);margin-top:8px">Click elements to select. Drag to reposition. Live preview updates in real-time.</p>
      </div>
      <!-- Sidebar -->
      <div style="width:300px;display:flex;flex-direction:column;gap:12px;max-height:calc(100vh - 120px);overflow-y:auto">
        <!-- Add Elements -->
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:12px">
          <h4 style="font-size:13px;margin-bottom:10px">Add Element</h4>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
            <button class="btn btn-secondary btn-sm" id="addText" style="justify-content:center">&#128172; Text</button>
            <button class="btn btn-secondary btn-sm" id="addHeading" style="justify-content:center">&#128220; Heading</button>
            <button class="btn btn-secondary btn-sm" id="addImage" style="justify-content:center">&#128247; Image</button>
            <button class="btn btn-secondary btn-sm" id="addVideo" style="justify-content:center">&#127916; Video</button>
            <button class="btn btn-secondary btn-sm" id="addClock" style="justify-content:center">&#128339; Clock</button>
            <button class="btn btn-secondary btn-sm" id="addDate" style="justify-content:center">&#128197; Date</button>
            <button class="btn btn-secondary btn-sm" id="addWeather" style="justify-content:center">&#9925; Weather</button>
            <button class="btn btn-secondary btn-sm" id="addTicker" style="justify-content:center">&#128240; Ticker</button>
            <button class="btn btn-secondary btn-sm" id="addShape" style="justify-content:center">&#9632; Shape</button>
            <button class="btn btn-secondary btn-sm" id="addQR" style="justify-content:center">&#9641; QR Code</button>
            <button class="btn btn-secondary btn-sm" id="addCountdown" style="justify-content:center">&#9201; Countdown</button>
            <button class="btn btn-secondary btn-sm" id="addWebpage" style="justify-content:center">&#127760; Webpage</button>
          </div>
        </div>
        <!-- Background -->
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:12px">
          <h4 style="font-size:13px;margin-bottom:8px">Background</h4>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px">
            ${BACKGROUNDS.map(b => `<div style="width:30px;height:30px;border-radius:4px;cursor:pointer;border:2px solid var(--border);background:${b.value}" data-bg="${b.value}" title="${b.name}"></div>`).join('')}
          </div>
          <div style="display:flex;gap:6px">
            <input type="color" id="bgColor" value="#000000" style="flex:1;height:32px;border:none;cursor:pointer;border-radius:4px">
            <button class="btn btn-secondary btn-sm" id="bgImageBtn">Image</button>
          </div>
          <input type="file" id="bgImageInput" style="display:none" accept="image/*">
        </div>
        <!-- Properties -->
        <div id="propPanel" style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:12px;display:none">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <h4 style="font-size:13px">Properties</h4>
            <button class="btn btn-danger btn-sm" id="deleteEl">Delete</button>
          </div>
          <div id="propFields"></div>
        </div>
        <!-- Layers -->
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:12px">
          <h4 style="font-size:13px;margin-bottom:8px">Layers</h4>
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

  // Add element handlers
  document.getElementById('addText').onclick = () => addElement({ type: 'text', x: 10, y: 60, text: 'Your text here', fontSize: 24, fontFamily: 'Arial', color: '#FFFFFF', bold: false, shadow: false });
  document.getElementById('addHeading').onclick = () => addElement({ type: 'text', x: 5, y: 5, text: 'HEADING', fontSize: 64, fontFamily: 'Impact', color: '#FFFFFF', bold: true, shadow: true });
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
    const url = prompt('Video URL (MP4):');
    if (url) addElement({ type: 'video', x: 5, y: 5, width: 50, height: 50, src: url, muted: true, loop: true });
  };
  document.getElementById('addClock').onclick = () => addElement({ type: 'clock', x: 60, y: 5, fontSize: 48, fontFamily: 'Arial', color: '#FFFFFF', format: '12h', showSeconds: true, shadow: true });
  document.getElementById('addDate').onclick = () => addElement({ type: 'date', x: 60, y: 20, fontSize: 24, fontFamily: 'Arial', color: '#FFFFFF', shadow: false });
  document.getElementById('addWeather').onclick = () => {
    const location = prompt('City, State:', 'Milwaukee, WI');
    if (location) addElement({ type: 'weather', x: 5, y: 70, fontSize: 36, color: '#FFFFFF', location, units: 'imperial' });
  };
  document.getElementById('addTicker').onclick = () => {
    const url = prompt('RSS Feed URL:', 'https://feeds.bbci.co.uk/news/rss.xml');
    if (url) addElement({ type: 'ticker', x: 0, y: 90, width: 100, height: 10, feedUrl: url, speed: 30, fontSize: 20, color: '#FFFFFF', bgColor: 'rgba(0,0,0,0.7)' });
  };
  document.getElementById('addShape').onclick = () => addElement({ type: 'shape', x: 20, y: 20, width: 30, height: 20, color: '#3b82f6', opacity: 0.7, radius: 8, shape: 'rect' });
  document.getElementById('addQR').onclick = () => {
    const data = prompt('QR Code URL:', 'https://example.com');
    if (data) addElement({ type: 'qr', x: 80, y: 70, size: 15, data, fgColor: '#FFFFFF', bgColor: '#000000' });
  };
  document.getElementById('addCountdown').onclick = () => {
    const target = prompt('Target date (YYYY-MM-DD):', '2026-04-01');
    if (target) addElement({ type: 'countdown', x: 20, y: 40, fontSize: 48, color: '#FFFFFF', targetDate: target, label: 'Coming Soon' });
  };
  document.getElementById('addWebpage').onclick = () => {
    const url = prompt('Webpage URL:');
    if (url) addElement({ type: 'webpage', x: 5, y: 5, width: 40, height: 40, url });
  };

  document.getElementById('deleteEl').onclick = () => { if (selectedIdx >= 0) { elements.splice(selectedIdx, 1); selectedIdx = -1; redraw(); } };

  // Publish as dynamic HTML content
  document.getElementById('publishBtn').onclick = async () => {
    try {
      const html = generateHTML();
      const blob = new Blob([html], { type: 'text/html' });
      const file = new File([blob], `design-${Date.now()}.html`, { type: 'text/html' });
      // Upload as a widget instead - create a text widget with the HTML
      const res = await fetch('/api/widgets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
        body: JSON.stringify({ widget_type: 'text', name: `Design ${new Date().toLocaleDateString()}`, config: { html: generateInnerHTML(), css: '', background: bgValue } })
      });
      if (res.ok) showToast('Published as widget! Assign it to a layout zone.', 'success');
      else showToast('Publish failed', 'error');
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
    } catch (err) { showToast('Export failed: ' + err.message, 'error'); }
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
          showToast('Design loaded', 'success');
        } catch { showToast('Invalid design file', 'error'); }
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
}

function addElement(el) {
  elements.push(el);
  selectedIdx = elements.length - 1;
  redraw();
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
        html += `<div style="position:absolute;left:${el.x}%;top:${el.y}%;font-size:${el.fontSize / 10}vw;font-family:${el.fontFamily};color:${el.color};font-weight:${el.bold ? 'bold' : 'normal'};${el.shadow ? 'text-shadow:2px 2px 4px rgba(0,0,0,0.5);' : ''}white-space:nowrap;${border}${cursor}" data-idx="${i}">${el.text}</div>`;
        break;
      case 'clock':
        html += `<div style="position:absolute;left:${el.x}%;top:${el.y}%;font-size:${el.fontSize / 10}vw;font-family:${el.fontFamily};color:${el.color};font-weight:bold;${el.shadow ? 'text-shadow:2px 2px 4px rgba(0,0,0,0.5);' : ''}${border}${cursor}" data-idx="${i}" id="clock_${i}"></div>`;
        break;
      case 'date':
        html += `<div style="position:absolute;left:${el.x}%;top:${el.y}%;font-size:${el.fontSize / 10}vw;font-family:${el.fontFamily};color:${el.color};${el.shadow ? 'text-shadow:2px 2px 4px rgba(0,0,0,0.5);' : ''}${border}${cursor}" data-idx="${i}" id="date_${i}"></div>`;
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
        html += `<div style="position:absolute;left:${el.x}%;top:${el.y}%;font-size:${el.fontSize / 10}vw;color:${el.color};${border}${cursor}" data-idx="${i}" id="weather_${i}">&#9925; Loading...</div>`;
        break;
      case 'ticker':
        html += `<div style="position:absolute;left:${el.x}%;top:${el.y}%;width:${el.width}%;height:${el.height}%;background:${el.bgColor};overflow:hidden;display:flex;align-items:center;${border}" data-idx="${i}">
          <div style="white-space:nowrap;animation:ticker ${el.speed || 30}s linear infinite;font-size:${el.fontSize / 10}vw;color:${el.color}" id="ticker_${i}">Loading news...</div>
        </div>`;
        break;
      case 'qr':
        html += `<div style="position:absolute;left:${el.x}%;top:${el.y}%;width:${el.size}%;aspect-ratio:1;background:${el.bgColor};display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:8px;${border}${cursor}" data-idx="${i}">
          <div style="font-size:1.5vw;color:${el.fgColor};font-weight:bold">QR CODE</div>
          <div style="font-size:0.8vw;color:${el.fgColor};opacity:0.7;margin-top:4px">${el.data?.slice(0, 25)}</div>
        </div>`;
        break;
      case 'countdown':
        html += `<div style="position:absolute;left:${el.x}%;top:${el.y}%;text-align:center;color:${el.color};${border}${cursor}" data-idx="${i}">
          <div style="font-size:${el.fontSize / 15}vw;opacity:0.8">${el.label || ''}</div>
          <div style="font-size:${el.fontSize / 10}vw;font-weight:bold" id="countdown_${i}"></div>
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
          if (diff <= 0) { cdEl.textContent = 'NOW!'; return; }
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
        }).catch(() => { wEl.textContent = '&#9925; ' + el.location; });
      }
    }
    if (el.type === 'ticker') {
      const tEl = document.getElementById(`ticker_${i}`);
      if (tEl && el.feedUrl) {
        fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(el.feedUrl)}`).then(r => r.json()).then(d => {
          tEl.textContent = (d.items || []).map(item => item.title).join('  •  ') || 'No items';
        }).catch(() => { tEl.textContent = 'Feed unavailable'; });
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
    html += `<div class="form-group"><label>Text</label><input type="text" class="input" value="${el.text}" data-prop="text"></div>
      <div class="form-group"><label>Size</label><input type="range" min="8" max="120" value="${el.fontSize}" data-prop="fontSize" style="width:100%"><span style="font-size:11px;color:var(--text-muted)">${el.fontSize}px</span></div>
      <div class="form-group"><label>Font</label><select class="input" style="background:var(--bg-input)" data-prop="fontFamily">${FONTS.map(f => `<option ${f === el.fontFamily ? 'selected' : ''}>${f}</option>`).join('')}</select></div>
      <div class="form-group"><label>Color</label><input type="color" value="${el.color}" data-prop="color" style="width:100%;height:28px;border:none;cursor:pointer"></div>
      <label style="font-size:12px;display:flex;gap:6px;margin:4px 0"><input type="checkbox" ${el.bold ? 'checked' : ''} data-prop="bold"> Bold</label>
      <label style="font-size:12px;display:flex;gap:6px;margin:4px 0"><input type="checkbox" ${el.shadow ? 'checked' : ''} data-prop="shadow"> Shadow</label>`;
  } else if (el.type === 'clock') {
    html += `<div class="form-group"><label>Size</label><input type="range" min="16" max="120" value="${el.fontSize}" data-prop="fontSize" style="width:100%"></div>
      <div class="form-group"><label>Color</label><input type="color" value="${el.color}" data-prop="color" style="width:100%;height:28px;border:none"></div>
      <div class="form-group"><label>Format</label><select class="input" style="background:var(--bg-input)" data-prop="format"><option ${el.format === '12h' ? 'selected' : ''} value="12h">12h</option><option ${el.format === '24h' ? 'selected' : ''} value="24h">24h</option></select></div>
      <label style="font-size:12px;display:flex;gap:6px;margin:4px 0"><input type="checkbox" ${el.showSeconds ? 'checked' : ''} data-prop="showSeconds"> Show seconds</label>`;
  } else if (el.type === 'image' || el.type === 'video' || el.type === 'webpage') {
    html += `<div style="display:flex;gap:6px"><div class="form-group" style="flex:1;margin:0"><label>W%</label><input type="number" class="input" value="${Math.round(el.width)}" data-prop="width"></div>
      <div class="form-group" style="flex:1;margin:0"><label>H%</label><input type="number" class="input" value="${Math.round(el.height)}" data-prop="height"></div></div>`;
    if (el.type === 'video') html += `<label style="font-size:12px;display:flex;gap:6px;margin:8px 0"><input type="checkbox" ${el.muted ? 'checked' : ''} data-prop="muted"> Muted</label>
      <label style="font-size:12px;display:flex;gap:6px;margin:4px 0"><input type="checkbox" ${el.loop ? 'checked' : ''} data-prop="loop"> Loop</label>`;
  } else if (el.type === 'shape') {
    html += `<div style="display:flex;gap:6px"><div class="form-group" style="flex:1;margin:0"><label>W%</label><input type="number" class="input" value="${Math.round(el.width)}" data-prop="width"></div>
      <div class="form-group" style="flex:1;margin:0"><label>H%</label><input type="number" class="input" value="${Math.round(el.height)}" data-prop="height"></div></div>
      <div class="form-group"><label>Color</label><input type="color" value="${el.color}" data-prop="color" style="width:100%;height:28px;border:none"></div>
      <div class="form-group"><label>Opacity</label><input type="range" min="0" max="1" step="0.1" value="${el.opacity}" data-prop="opacity" style="width:100%"></div>
      <div class="form-group"><label>Shape</label><select class="input" style="background:var(--bg-input)" data-prop="shape"><option ${el.shape === 'rect' ? 'selected' : ''}>rect</option><option ${el.shape === 'circle' ? 'selected' : ''}>circle</option></select></div>`;
  } else if (el.type === 'weather') {
    html += `<div class="form-group"><label>Location</label><input type="text" class="input" value="${el.location}" data-prop="location"></div>
      <div class="form-group"><label>Size</label><input type="range" min="16" max="80" value="${el.fontSize}" data-prop="fontSize" style="width:100%"></div>
      <div class="form-group"><label>Color</label><input type="color" value="${el.color}" data-prop="color" style="width:100%;height:28px;border:none"></div>`;
  } else if (el.type === 'ticker') {
    html += `<div class="form-group"><label>Feed URL</label><input type="text" class="input" value="${el.feedUrl}" data-prop="feedUrl"></div>
      <div class="form-group"><label>Speed (seconds)</label><input type="number" class="input" value="${el.speed}" data-prop="speed"></div>
      <div class="form-group"><label>Text Color</label><input type="color" value="${el.color}" data-prop="color" style="width:100%;height:28px;border:none"></div>
      <div class="form-group"><label>BG Color</label><input type="text" class="input" value="${el.bgColor}" data-prop="bgColor"></div>`;
  } else if (el.type === 'countdown') {
    html += `<div class="form-group"><label>Target Date</label><input type="date" class="input" value="${el.targetDate}" data-prop="targetDate"></div>
      <div class="form-group"><label>Label</label><input type="text" class="input" value="${el.label}" data-prop="label"></div>
      <div class="form-group"><label>Size</label><input type="range" min="16" max="100" value="${el.fontSize}" data-prop="fontSize" style="width:100%"></div>
      <div class="form-group"><label>Color</label><input type="color" value="${el.color}" data-prop="color" style="width:100%;height:28px;border:none"></div>`;
  }

  // Save design button
  html += `<button class="btn btn-secondary btn-sm" style="width:100%;margin-top:8px;justify-content:center" onclick="(() => {
    const a = document.createElement('a');
    a.download = 'design.json';
    a.href = 'data:application/json,' + encodeURIComponent(JSON.stringify({elements: ${JSON.stringify(elements)}, bgValue: '${bgValue}'}));
    a.click();
  })()">Save Design File</button>`;

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
  `).join('') || '<p style="color:var(--text-muted)">No elements yet</p>';

  list.querySelectorAll('[data-layer]').forEach(el => {
    el.onclick = () => { selectedIdx = parseInt(el.dataset.layer); redraw(); };
  });
}

function generateInnerHTML() {
  let html = '';
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
