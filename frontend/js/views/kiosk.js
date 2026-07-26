import { showToast } from '../components/toast.js';
import { t } from '../i18n.js';
import { esc } from '../utils.js';

const API = (url, opts = {}) => fetch('/api' + url, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}`, ...opts.headers }, ...opts }).then(r => r.json());

export async function render(container) {
  const hash = window.location.hash;
  if (hash.startsWith('#/kiosk/')) {
    const id = hash.split('#/kiosk/')[1];
    return renderEditor(container, id);
  }
  return renderList(container);
}

async function renderList(container) {
  container.innerHTML = `
    <div class="page-header">
      <div><h1>${t('kiosk.title')} <span class="help-tip" data-tip="${t('kiosk.help_tip')}">?</span></h1><div class="subtitle">${t('kiosk.subtitle')}</div></div>
      <button class="btn btn-primary" id="newKioskBtn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        ${t('kiosk.new_page')}
      </button>
    </div>
    <div class="content-grid" id="kioskGrid"></div>
  `;

  document.getElementById('newKioskBtn').onclick = async () => {
    const name = prompt(t('kiosk.prompt_name'));
    if (!name) return;
    const page = await API('/kiosk', { method: 'POST', body: JSON.stringify({ name }) });
    window.location.hash = `#/kiosk/${page.id}`;
  };

  try {
    const pages = await API('/kiosk');
    const grid = document.getElementById('kioskGrid');
    if (!pages.length) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>${t('kiosk.empty_title')}</h3><p>${t('kiosk.empty_desc')}</p></div>`;
      return;
    }
    grid.innerHTML = pages.map(p => `
      <div class="content-item" style="cursor:pointer" onclick="window.location.hash='#/kiosk/${p.id}'">
        <div class="content-item-preview" style="display:flex;align-items:center;justify-content:center;background:var(--bg-primary)">
          <span style="font-size:48px">&#128433;</span>
        </div>
        <div class="content-item-body">
          <div class="content-item-name">${esc(p.name)}</div>
          <div class="content-item-size">${t('kiosk.label')}</div>
        </div>
        <div class="content-item-actions">
          <a href="/api/kiosk/${p.id}/render" target="_blank" class="btn btn-secondary btn-sm" style="text-decoration:none" onclick="event.stopPropagation()">${t('kiosk.preview')}</a>
          <button class="btn btn-danger btn-sm" data-delete-kiosk="${esc(p.id)}" data-kiosk-name="${esc(p.name)}" onclick="event.stopPropagation()">${t('common.delete')}</button>
        </div>
      </div>
    `).join('');

    grid.querySelectorAll('[data-delete-kiosk]').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const name = btn.dataset.kioskName;
        if (!confirm(t('kiosk.confirm_delete', { name }))) return;
        try {
          await API(`/kiosk/${btn.dataset.deleteKiosk}`, { method: 'DELETE' });
          showToast(t('kiosk.toast.deleted'));
          renderList(container);
        } catch (err) {
          showToast(err.message || t('kiosk.toast.delete_failed'), 'error');
        }
      };
    });
  } catch (err) { showToast(err.message, 'error'); }
}

async function renderEditor(container, pageId) {
  let page;
  try { page = await API(`/kiosk/${pageId}`); } catch { container.innerHTML = `<div class="empty-state"><h3>${t('kiosk.not_found')}</h3></div>`; return; }

  let config = JSON.parse(page.config || '{}');
  if (!config.buttons) config.buttons = [];
  if (!config.style) config.style = {};

  container.innerHTML = `
    <a href="#/kiosk" class="back-link" style="display:inline-flex;align-items:center;gap:6px;color:var(--text-secondary);margin-bottom:16px;font-size:13px">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
      ${t('kiosk.back')}
    </a>
    <div class="page-header">
      <h1>${esc(page.name)}</h1>
      <div style="display:flex;gap:8px">
        <a href="/api/kiosk/${pageId}/render" target="_blank" class="btn btn-secondary" style="text-decoration:none">${t('kiosk.preview')}</a>
        <button class="btn btn-primary" id="saveKioskBtn">${t('common.save')}</button>
      </div>
    </div>
    <div style="display:flex;gap:20px">
      <div style="flex:1">
        <iframe id="kioskPreview" src="/api/kiosk/${pageId}/render" style="width:100%;aspect-ratio:16/9;border:1px solid var(--border);border-radius:var(--radius-lg)"></iframe>
      </div>
      <div style="width:320px;max-height:calc(100vh - 140px);overflow-y:auto;display:flex;flex-direction:column;gap:12px">
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:12px">
          <h4 style="font-size:13px;margin-bottom:10px">${t('kiosk.page_settings')}</h4>
          <div class="form-group"><label>${t('kiosk.title_label')}</label><input type="text" id="kTitle" class="input" value="${esc(config.title || '')}"></div>
          <div class="form-group"><label>${t('kiosk.subtitle_label')}</label><input type="text" id="kSubtitle" class="input" value="${esc(config.subtitle || '')}"></div>
          <div class="form-group"><label>${t('kiosk.logo_url')}</label><input type="text" id="kLogo" class="input" value="${esc(config.logoUrl || '')}" placeholder="https://..."></div>
          <div class="form-group"><label>${t('kiosk.footer_text')}</label><input type="text" id="kFooter" class="input" value="${esc(config.footer || '')}"></div>
          <div class="form-group"><label>${t('kiosk.idle_title')}</label><input type="text" id="kIdleTitle" class="input" value="${esc(config.idleTitle || t('kiosk.idle_default'))}"></div>
          <div class="form-group"><label>${t('kiosk.idle_timeout')}</label><input type="number" id="kIdleTimeout" class="input" value="${config.idleTimeout || 60}"></div>
        </div>

        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:12px">
          <h4 style="font-size:13px;margin-bottom:10px">${t('kiosk.style')}</h4>
          <div class="form-group"><label>${t('kiosk.background')}</label><input type="text" id="kBg" class="input" value="${esc(config.style?.background || '#111827')}"></div>
          <div class="form-group"><label>${t('kiosk.text_color')}</label><input type="color" id="kTextColor" value="${config.style?.textColor || '#f1f5f9'}" style="width:100%;height:28px;border:none;cursor:pointer"></div>
          <div class="form-group"><label>${t('kiosk.columns')}</label><select id="kColumns" class="input" style="background:var(--bg-input)">
            <option ${(config.style?.columns || 3) === 2 ? 'selected' : ''} value="2">2</option>
            <option ${(config.style?.columns || 3) === 3 ? 'selected' : ''} value="3">3</option>
            <option ${(config.style?.columns || 3) === 4 ? 'selected' : ''} value="4">4</option>
          </select></div>
          <div class="form-group"><label>${t('kiosk.button_color')}</label><input type="color" id="kBtnBg" value="${config.style?.buttonBg || '#1e293b'}" style="width:100%;height:28px;border:none;cursor:pointer"></div>
          <div class="form-group"><label>${t('kiosk.button_hover')}</label><input type="color" id="kBtnHover" value="${config.style?.buttonHover || '#e65c00'}" style="width:100%;height:28px;border:none;cursor:pointer"></div>
        </div>

        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:12px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <h4 style="font-size:13px">${t('kiosk.buttons')}</h4>
            <button class="btn btn-secondary btn-sm" id="addBtnBtn">${t('kiosk.add_btn')}</button>
          </div>
          <div id="buttonList"></div>
        </div>
      </div>
    </div>
  `;

  function renderButtons() {
    const list = document.getElementById('buttonList');
    list.innerHTML = config.buttons.map((btn, i) => `
      <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:8px;margin-bottom:6px">
        <div style="display:flex;gap:6px;margin-bottom:6px">
          <input type="text" class="input" value="${esc(btn.icon || '')}" placeholder="${t('kiosk.icon_placeholder')}" style="width:50px;text-align:center" data-btn="${i}" data-field="icon">
          <input type="text" class="input" value="${esc(btn.label || '')}" placeholder="${t('kiosk.label_placeholder')}" style="flex:1" data-btn="${i}" data-field="label">
        </div>
        <input type="text" class="input" value="${esc(btn.sublabel || '')}" placeholder="${t('kiosk.sublabel_placeholder')}" style="font-size:12px;margin-bottom:4px" data-btn="${i}" data-field="sublabel">
        <div style="display:flex;gap:6px;align-items:center">
          <select class="input" style="background:var(--bg-input);font-size:11px;flex:1" data-btn="${i}" data-field="action">
            <option value="" ${!btn.action ? 'selected' : ''}>${t('kiosk.action_none')}</option>
            <option value="url" ${btn.action === 'url' ? 'selected' : ''}>${t('kiosk.action_url')}</option>
            <option value="page" ${btn.action === 'page' ? 'selected' : ''}>${t('kiosk.action_page')}</option>
          </select>
          <button class="btn-icon" style="color:var(--danger)" data-remove-btn="${i}" title="${t('common.delete')}">&#10005;</button>
        </div>
        <input type="text" class="input" value="${esc(btn.url || btn.page || '')}" placeholder="${t('kiosk.url_placeholder')}" style="font-size:11px;margin-top:4px" data-btn="${i}" data-field="url">
      </div>
    `).join('') || `<p style="color:var(--text-muted);font-size:12px">${t('kiosk.no_buttons')}</p>`;

    list.querySelectorAll('[data-btn]').forEach(input => {
      input.oninput = () => {
        const idx = parseInt(input.dataset.btn);
        const field = input.dataset.field;
        if (field === 'url' && config.buttons[idx].action === 'page') config.buttons[idx].page = input.value;
        else config.buttons[idx][field] = input.tagName === 'SELECT' ? input.value : input.value;
      };
    });
    list.querySelectorAll('[data-remove-btn]').forEach(btn => {
      btn.onclick = () => { config.buttons.splice(parseInt(btn.dataset.removeBtn), 1); renderButtons(); };
    });
  }

  document.getElementById('addBtnBtn').onclick = () => {
    config.buttons.push({ label: t('kiosk.new_button'), sublabel: '', icon: '&#11088;', action: '', url: '' });
    renderButtons();
  };

  document.getElementById('saveKioskBtn').onclick = async () => {
    config.title = document.getElementById('kTitle').value;
    config.subtitle = document.getElementById('kSubtitle').value;
    config.logoUrl = document.getElementById('kLogo').value;
    config.footer = document.getElementById('kFooter').value;
    config.idleTitle = document.getElementById('kIdleTitle').value;
    config.idleTimeout = parseInt(document.getElementById('kIdleTimeout').value) || 60;
    config.style = {
      ...config.style,
      background: document.getElementById('kBg').value,
      textColor: document.getElementById('kTextColor').value,
      columns: parseInt(document.getElementById('kColumns').value),
      buttonBg: document.getElementById('kBtnBg').value,
      buttonHover: document.getElementById('kBtnHover').value,
    };

    try {
      await API(`/kiosk/${pageId}`, { method: 'PUT', body: JSON.stringify({ config }) });
      showToast(t('kiosk.toast.saved'), 'success');
      document.getElementById('kioskPreview').src = `/api/kiosk/${pageId}/render?t=${Date.now()}`;
    } catch (err) { showToast(err.message, 'error'); }
  };

  renderButtons();
}

export function cleanup() { }
