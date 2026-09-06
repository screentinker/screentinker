import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';

let dataSourcesList = [];

export async function render(container) {
  container.innerHTML = `
    <div class="view-header" style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;flex-wrap:wrap;gap:16px">
      <div>
        <h1 style="font-size:24px;font-weight:700;margin:0 0 6px 0;color:var(--text-primary,#f8fafc)">${esc(t('data_sources.title'))}</h1>
        <p style="margin:0;color:var(--text-muted,#94a3b8);font-size:14px;max-width:700px">
          ${esc(t('data_sources.subtitle'))}
        </p>
      </div>
      <div style="display:flex;gap:10px">
        <button id="newDataSourceBtn" class="btn btn-primary" style="display:flex;align-items:center;gap:6px">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          <span>${esc(t('data_sources.add_new'))}</span>
        </button>
      </div>
    </div>

    <div id="dataSourcesContainer">
      <div style="display:flex;justify-content:center;padding:48px 0;color:var(--text-muted,#94a3b8)">
        <span class="spinner"></span>
      </div>
    </div>
  `;

  document.getElementById('newDataSourceBtn').onclick = () => openEditModal(null);
  await loadDataSources();
}

async function loadDataSources() {
  const container = document.getElementById('dataSourcesContainer');
  if (!container) return;

  try {
    dataSourcesList = await api.getDataSources();
    renderDataSourcesList(container);
  } catch (err) {
    container.innerHTML = `
      <div class="card" style="padding:24px;text-align:center;color:#ef4444;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2)">
        <p style="margin:0 0 12px 0;font-weight:600">${esc(t('data_sources.failed_load'))}</p>
        <p style="margin:0;font-size:13px;color:var(--text-muted)">${esc(err.message)}</p>
      </div>
    `;
  }
}

function renderDataSourcesList(container) {
  if (!dataSourcesList.length) {
    container.innerHTML = `
      <div class="card" style="padding:48px 24px;text-align:center;background:var(--bg-card,#1e293b);border-radius:12px;border:1px dashed var(--border,#334155)">
        <div style="font-size:42px;margin-bottom:12px">📅</div>
        <h3 style="margin:0 0 8px 0;font-size:18px;font-weight:600;color:var(--text-primary,#f8fafc)">${esc(t('data_sources.empty_title'))}</h3>
        <p style="margin:0 auto 20px auto;max-width:480px;color:var(--text-muted,#94a3b8);font-size:14px;line-height:1.5">
          ${esc(t('data_sources.empty_desc'))}
        </p>
        <button class="btn btn-primary" onclick="document.getElementById('newDataSourceBtn').click()">
          ${esc(t('data_sources.add_first'))}
        </button>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(360px, 1fr));gap:20px">
      ${dataSourcesList.map(ds => renderDataSourceCard(ds)).join('')}
    </div>
  `;

  // Attach card event listeners
  container.querySelectorAll('[data-act="refresh"]').forEach(btn => {
    btn.onclick = async (e) => {
      const id = e.currentTarget.dataset.id;
      btn.disabled = true;
      btn.innerHTML = '⏳ ...';
      try {
        await api.refreshDataSource(id);
        showToast(t('data_sources.synced_ok'), 'success');
        await loadDataSources();
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = `🔄 ${t('data_sources.sync_now')}`;
      }
    };
  });

  container.querySelectorAll('[data-act="edit"]').forEach(btn => {
    btn.onclick = (e) => {
      const id = e.currentTarget.dataset.id;
      const ds = dataSourcesList.find(x => x.id === id);
      if (ds) openEditModal(ds);
    };
  });

  container.querySelectorAll('[data-act="del"]').forEach(btn => {
    btn.onclick = async (e) => {
      const id = e.currentTarget.dataset.id;
      const ds = dataSourcesList.find(x => x.id === id);
      if (!ds) return;
      if (confirm(t('data_sources.confirm_delete', { name: ds.name }))) {
        try {
          await api.deleteDataSource(id);
          showToast(t('data_sources.deleted_ok'), 'success');
          await loadDataSources();
        } catch (err) {
          showToast(err.message, 'error');
        }
      }
    };
  });

  container.querySelectorAll('[data-act="copy-tag"]').forEach(btn => {
    btn.onclick = (e) => {
      const tag = e.currentTarget.dataset.tag;
      navigator.clipboard.writeText(tag).then(() => {
        showToast(t('data_sources.tag_copied'), 'info');
      });
    };
  });

  container.querySelectorAll('[data-act="toggle-variables"]').forEach(btn => {
    btn.onclick = (e) => {
      const id = e.currentTarget.dataset.id;
      const drawer = document.getElementById(`vars-drawer-${id}`);
      if (drawer) {
        const isHidden = drawer.style.display === 'none';
        drawer.style.display = isHidden ? 'block' : 'none';
        btn.querySelector('.arrow').textContent = isHidden ? '▲' : '▼';
      }
    };
  });
}

function renderDataSourceCard(ds) {
  const isOk = ds.last_status === 'ok';
  const isPending = ds.last_status === 'pending';
  const statusColor = isOk ? '#10b981' : isPending ? '#f59e0b' : '#ef4444';
  const statusLabel = isOk ? 'OK' : isPending ? t('common.pending') : t('common.error');
  const lastSync = ds.last_fetched_at ? new Date(ds.last_fetched_at * 1000).toLocaleString() : t('data_sources.never_synced');
  const urlSnippet = ds.config?.url ? ds.config.url.replace(/^https?:\/\//, '').slice(0, 38) + '...' : t('data_sources.inline_data');

  // Standard variables for iCal
  const sampleVars = [
    { key: 'status', label: t('data_sources.status_frei') },
    { key: 'status_detail', label: t('data_sources.status_detail_label') },
    { key: 'current_title', label: t('data_sources.current_event_label') },
    { key: 'next_title', label: t('data_sources.next_event_label') },
    { key: 'next_time', label: t('data_sources.next_time_label') },
    { key: 'agenda_text', label: t('data_sources.agenda_text_label') },
    { key: 'event_0_title', label: t('data_sources.event_1_title_label') },
    { key: 'event_0_time', label: t('data_sources.event_1_time_label') },
    { key: 'event_1_title', label: t('data_sources.event_2_title_label') },
    { key: 'event_1_time', label: t('data_sources.event_2_time_label') },
  ];

  return `
    <div class="card" style="background:var(--bg-card,#1e293b);border-radius:10px;border:1px solid var(--border,#334155);padding:18px;display:flex;flex-direction:column;gap:14px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <h3 style="margin:0;font-size:16px;font-weight:600;color:var(--text-primary,#f8fafc)">${esc(ds.name)}</h3>
            <span class="badge" style="background:rgba(59,130,246,0.15);color:#60a5fa;font-size:11px;font-weight:600;padding:2px 6px;border-radius:4px">
              ${esc(ds.type.toUpperCase())}
            </span>
          </div>
          <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted,#94a3b8)">
            <span>${esc(t('data_sources.slug_label'))}:</span>
            <code style="background:var(--bg-input,#0f172a);padding:2px 6px;border-radius:4px;color:#38bdf8;font-size:11px">${esc(ds.slug)}</code>
            <button class="btn btn-sm" style="padding:1px 6px;font-size:10px;background:none;border:none;color:var(--text-muted);cursor:pointer" data-act="copy-tag" data-tag="{{ds:${esc(ds.slug)}.status}}" title="Copy {{ds:${esc(ds.slug)}.status}}">
              📋
            </button>
          </div>
        </div>

        <div style="display:flex;align-items:center;gap:6px">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${statusColor}"></span>
          <span style="font-size:12px;font-weight:600;color:${statusColor}">${statusLabel}</span>
        </div>
      </div>

      <div style="font-size:12px;background:var(--bg-input,#0f172a);padding:10px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.05);display:flex;flex-direction:column;gap:6px">
        <div style="display:flex;justify-content:space-between">
          <span style="color:var(--text-muted,#64748b)">${esc(t('data_sources.source_label'))}</span>
          <span style="color:var(--text-primary,#e2e8f0);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(ds.config?.url || '')}">${esc(urlSnippet)}</span>
        </div>
        <div style="display:flex;justify-content:space-between">
          <span style="color:var(--text-muted,#64748b)">${esc(t('data_sources.last_sync_label'))}</span>
          <span style="color:var(--text-primary,#e2e8f0)">${esc(lastSync)}</span>
        </div>
        ${ds.last_error ? `<div style="color:#ef4444;font-size:11px;margin-top:2px">⚠️ ${esc(ds.last_error)}</div>` : ''}
      </div>

      <div>
        <button class="btn btn-sm btn-secondary" style="width:100%;font-size:12px;display:flex;justify-content:space-between;align-items:center" data-act="toggle-variables" data-id="${esc(ds.id)}">
          <span>${esc(t('data_sources.view_variables'))}</span>
          <span class="arrow">▼</span>
        </button>

        <div id="vars-drawer-${esc(ds.id)}" style="display:none;margin-top:10px;padding:10px;background:var(--bg-input,#0f172a);border-radius:6px;font-size:12px">
          <p style="margin:0 0 8px 0;font-size:11px;color:var(--text-muted,#94a3b8)">${esc(t('data_sources.click_tag_copy'))}</p>
          <div style="display:flex;flex-direction:column;gap:6px">
            ${sampleVars.map(v => `
              <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
                <span style="font-size:11px;color:var(--text-muted)">${esc(v.label)}:</span>
                <button class="btn btn-sm" style="padding:2px 8px;font-size:11px;font-family:monospace;background:var(--bg-card);border:1px solid var(--border);color:#38bdf8;cursor:pointer" data-act="copy-tag" data-tag="{{ds:${esc(ds.slug)}.${v.key}}}">
                  {{ds:${esc(ds.slug)}.${v.key}}}
                </button>
              </div>
            `).join('')}
          </div>
        </div>
      </div>

      <div style="display:flex;justify-content:space-between;gap:8px;margin-top:auto;border-top:1px solid var(--border,#334155);padding-top:12px">
        <button class="btn btn-sm btn-secondary" data-act="refresh" data-id="${esc(ds.id)}">
          🔄 ${esc(t('data_sources.sync_now'))}
        </button>
        <div style="display:flex;gap:6px">
          <button class="btn btn-sm btn-secondary" data-act="edit" data-id="${esc(ds.id)}">
            ${esc(t('common.edit'))}
          </button>
          <button class="btn btn-sm btn-danger" data-act="del" data-id="${esc(ds.id)}">
            ${esc(t('common.delete'))}
          </button>
        </div>
      </div>
    </div>
  `;
}

// ─── Create / Edit Modal ────────────────────────────────────────────────────────
function openEditModal(ds) {
  const isEdit = !!ds;
  const cfg = ds?.config || {};

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px;overflow-y:auto';

  overlay.innerHTML = `
    <div class="modal" style="background:var(--bg-card,#1e293b);border-radius:12px;border:1px solid var(--border,#334155);width:100%;max-width:640px;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 25px 50px -12px rgba(0,0,0,0.5)">
      <div class="modal-header" style="padding:18px 24px;border-bottom:1px solid var(--border,#334155);display:flex;justify-content:space-between;align-items:center">
        <h2 style="margin:0;font-size:18px;font-weight:600;color:var(--text-primary,#f8fafc)">
          ${isEdit ? esc(t('data_sources.edit_title')) : esc(t('data_sources.create_title'))}
        </h2>
        <button id="closeDsModalBtn" style="background:none;border:none;color:var(--text-muted,#94a3b8);font-size:20px;cursor:pointer">&times;</button>
      </div>

      <div class="modal-body" style="padding:24px;overflow-y:auto;display:flex;flex-direction:column;gap:18px">
        <div>
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px;color:var(--text-primary,#f8fafc)">${esc(t('data_sources.integration_type'))}</label>
          <select id="dsTypeInput" class="input" style="width:100%" ${isEdit ? 'disabled' : ''}>
            <option value="ical" selected>${esc(t('data_sources.type_ical'))}</option>
            <option value="api" disabled>${esc(t('data_sources.type_api_soon'))}</option>
            <option value="sheets" disabled>${esc(t('data_sources.type_sheets_soon'))}</option>
          </select>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <div>
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px;color:var(--text-primary,#f8fafc)">${esc(t('data_sources.name_label'))}</label>
            <input type="text" id="dsNameInput" class="input" style="width:100%" placeholder="${esc(t('data_sources.name_placeholder'))}" value="${esc(ds?.name || '')}">
          </div>
          <div>
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px;color:var(--text-primary,#f8fafc)">${esc(t('data_sources.slug_label'))}</label>
            <input type="text" id="dsSlugInput" class="input" style="width:100%" placeholder="${esc(t('data_sources.slug_placeholder'))}" value="${esc(ds?.slug || '')}">
            <span style="font-size:11px;color:var(--text-muted)">${esc(t('data_sources.slug_hint'))}</span>
          </div>
        </div>

        <div>
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px;color:var(--text-primary,#f8fafc)">${esc(t('data_sources.url_label'))}</label>
          <input type="text" id="dsUrlInput" class="input" style="width:100%" placeholder="${esc(t('data_sources.url_placeholder'))}" value="${esc(cfg.url || '')}">
          <span style="font-size:11px;color:var(--text-muted)">${esc(t('data_sources.url_hint'))}</span>
        </div>

        <!-- Options accordion -->
        <details style="background:var(--bg-input,#0f172a);border-radius:8px;padding:12px;border:1px solid var(--border,#334155)">
          <summary style="font-size:13px;font-weight:600;cursor:pointer;color:var(--text-primary,#f8fafc)">${esc(t('data_sources.advanced_options'))}</summary>
          <div style="margin-top:14px;display:flex;flex-direction:column;gap:12px">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <div>
                <label style="display:block;font-size:12px;margin-bottom:4px;color:var(--text-muted)">${esc(t('data_sources.interval_label'))}</label>
                <select id="dsIntervalInput" class="input" style="width:100%">
                  <option value="1" ${(cfg.interval_min == 1 || cfg.interval_sec == 60) ? 'selected' : ''}>${esc(t('data_sources.interval_1min'))}</option>
                  <option value="5" ${(cfg.interval_min == 5 || cfg.interval_sec == 300) ? 'selected' : ''}>${esc(t('data_sources.interval_5min'))}</option>
                  <option value="15" ${(!cfg.interval_min && !cfg.interval_sec || cfg.interval_min == 15 || cfg.interval_sec == 900) ? 'selected' : ''}>${esc(t('data_sources.interval_15min'))}</option>
                  <option value="60" ${(cfg.interval_min == 60 || cfg.interval_sec == 3600) ? 'selected' : ''}>${esc(t('data_sources.interval_1hr'))}</option>
                </select>
              </div>
              <div>
                <label style="display:block;font-size:12px;margin-bottom:4px;color:var(--text-muted)">${esc(t('data_sources.lookahead_label'))}</label>
                <input type="number" id="dsLookaheadInput" class="input" style="width:100%" value="${cfg.lookahead_days || 14}" min="1" max="90">
              </div>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <div>
                <label style="display:block;font-size:12px;margin-bottom:4px;color:var(--text-muted)">${esc(t('data_sources.filter_include_label'))}</label>
                <input type="text" id="dsFilterIncludeInput" class="input" style="width:100%" placeholder="${esc(t('data_sources.filter_include_placeholder'))}" value="${esc(cfg.filter_include || cfg.filter_text || '')}">
              </div>
              <div>
                <label style="display:block;font-size:12px;margin-bottom:4px;color:var(--text-muted)">${esc(t('data_sources.filter_exclude_label'))}</label>
                <input type="text" id="dsFilterExcludeInput" class="input" style="width:100%" placeholder="${esc(t('data_sources.filter_exclude_placeholder'))}" value="${esc(cfg.filter_exclude || cfg.exclude_text || '')}">
              </div>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <div>
                <label style="display:block;font-size:12px;margin-bottom:4px;color:var(--text-muted)">${esc(t('data_sources.language_label'))}</label>
                <select id="dsLocaleInput" class="input" style="width:100%">
                  <option value="de" ${!cfg.locale || cfg.locale === 'de' ? 'selected' : ''}>${esc(t('data_sources.language_de'))}</option>
                  <option value="en" ${cfg.locale === 'en' ? 'selected' : ''}>${esc(t('data_sources.language_en'))}</option>
                </select>
              </div>
              <div>
                <label style="display:block;font-size:12px;margin-bottom:4px;color:var(--text-muted)">${esc(t('data_sources.timezone_label'))}</label>
                <input type="text" id="dsTzInput" class="input" style="width:100%" value="${esc(cfg.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin')}">
              </div>
            </div>

            <div>
              <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-primary,#f8fafc);cursor:pointer">
                <input type="checkbox" id="dsPrivacyInput" ${cfg.hide_private ? 'checked' : ''}>
                <span>${esc(t('data_sources.privacy_label'))}</span>
              </label>
            </div>
          </div>
        </details>

        <!-- Test Connection & Live Preview Button -->
        <div>
          <button type="button" id="dsTestBtn" class="btn btn-secondary" style="width:100%;font-size:13px">
            ${esc(t('data_sources.test_btn'))}
          </button>
          <div id="dsTestResult" style="margin-top:10px;display:none"></div>
        </div>
      </div>

      <div class="modal-footer" style="padding:16px 24px;border-top:1px solid var(--border,#334155);display:flex;justify-content:flex-end;gap:10px">
        <button type="button" id="cancelDsModalBtn" class="btn btn-secondary">${esc(t('common.cancel'))}</button>
        <button type="button" id="saveDsModalBtn" class="btn btn-primary">${isEdit ? esc(t('common.save')) : esc(t('common.create'))}</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('#closeDsModalBtn').onclick = close;
  overlay.querySelector('#cancelDsModalBtn').onclick = close;

  // Auto-slug on name input
  const nameInput = overlay.querySelector('#dsNameInput');
  const slugInput = overlay.querySelector('#dsSlugInput');
  if (!isEdit) {
    nameInput.oninput = () => {
      slugInput.value = nameInput.value.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/[\s_-]+/g, '_');
    };
  }

  // Test button
  const testBtn = overlay.querySelector('#dsTestBtn');
  const testResult = overlay.querySelector('#dsTestResult');
  testBtn.onclick = async () => {
    const url = overlay.querySelector('#dsUrlInput').value.trim();
    if (!url) {
      testResult.style.display = 'block';
      testResult.innerHTML = `<div style="padding:10px;border-radius:6px;background:rgba(239,68,68,0.1);color:#ef4444;font-size:12px">${esc(t('data_sources.test_url_required'))}</div>`;
      return;
    }

    testBtn.disabled = true;
    testBtn.textContent = t('data_sources.testing');
    testResult.style.display = 'none';

    const testConfig = {
      url,
      interval_min: parseInt(overlay.querySelector('#dsIntervalInput').value, 10) || 15,
      lookahead_days: parseInt(overlay.querySelector('#dsLookaheadInput').value, 10) || 14,
      filter_include: overlay.querySelector('#dsFilterIncludeInput').value.trim(),
      filter_exclude: overlay.querySelector('#dsFilterExcludeInput').value.trim(),
      locale: overlay.querySelector('#dsLocaleInput').value,
      timezone: overlay.querySelector('#dsTzInput').value.trim(),
      hide_private: overlay.querySelector('#dsPrivacyInput').checked,
    };

    try {
      const res = await api.testDataSource('ical', testConfig);
      const prev = res.preview || {};
      testResult.style.display = 'block';
      testResult.innerHTML = `
        <div style="padding:12px;border-radius:6px;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.3);font-size:12px">
          <div style="display:flex;align-items:center;gap:6px;color:#10b981;font-weight:600;margin-bottom:8px">
            <span>${esc(t('data_sources.test_success', { n: prev.event_count || 0 }))}</span>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;background:var(--bg-card);padding:8px;border-radius:4px;color:var(--text-primary)">
            <div><strong>${esc(t('common.status'))}:</strong> ${esc(prev.status || '')}</div>
            <div><strong>${esc(t('data_sources.status_detail_label'))}:</strong> ${esc(prev.status_detail || '')}</div>
            <div><strong>${esc(t('data_sources.next_event_label'))}:</strong> ${esc(prev.next_title || prev.next_event_summary || '–')}</div>
            <div><strong>${esc(t('data_sources.next_time_label'))}:</strong> ${esc(prev.next_time || '')}</div>
          </div>
        </div>
      `;
    } catch (err) {
      testResult.style.display = 'block';
      testResult.innerHTML = `
        <div style="padding:10px;border-radius:6px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);color:#ef4444;font-size:12px">
          ${esc(t('data_sources.test_failed', { err: err.message }))}
        </div>
      `;
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = t('data_sources.test_btn');
    }
  };

  // Save button
  overlay.querySelector('#saveDsModalBtn').onclick = async () => {
    const name = nameInput.value.trim();
    const slug = slugInput.value.trim();
    const url = overlay.querySelector('#dsUrlInput').value.trim();

    if (!name || !url) {
      alert(t('data_sources.fill_required'));
      return;
    }

    const payload = {
      name,
      slug: slug || undefined,
      type: 'ical',
      config: {
        url,
        interval_min: parseInt(overlay.querySelector('#dsIntervalInput').value, 10) || 15,
        lookahead_days: parseInt(overlay.querySelector('#dsLookaheadInput').value, 10) || 14,
        filter_include: overlay.querySelector('#dsFilterIncludeInput').value.trim(),
        filter_exclude: overlay.querySelector('#dsFilterExcludeInput').value.trim(),
        locale: overlay.querySelector('#dsLocaleInput').value,
        timezone: overlay.querySelector('#dsTzInput').value.trim(),
        hide_private: overlay.querySelector('#dsPrivacyInput').checked,
      }
    };

    const saveBtn = overlay.querySelector('#saveDsModalBtn');
    saveBtn.disabled = true;
    saveBtn.textContent = t('data_sources.saving');

    try {
      if (isEdit) {
        await api.updateDataSource(ds.id, payload);
        showToast(t('data_sources.synced_ok'), 'success');
      } else {
        await api.createDataSource(payload);
        showToast(t('data_sources.created_ok'), 'success');
      }
      close();
      await loadDataSources();
    } catch (err) {
      alert(err.message || 'Failed to save data source');
      saveBtn.disabled = false;
      saveBtn.textContent = isEdit ? t('common.save') : t('common.create');
    }
  };
}
