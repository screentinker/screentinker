/*
 * "BI dashboards" (server/routes/bi-connections.js, docs/bi-dashboards.md): the organization's
 * Grafana, Power BI and Tableau connections. Org owners and admins only.
 *
 * ⚠️ SECRETS ARE WRITE-ONLY. The form sends a token or secret; nothing the server returns contains
 * one. Editing with the secret left blank keeps the stored one.
 *
 * Escaping follows the SPA rule: values are stored raw and esc()'d where they are rendered.
 */
import { api } from '../api.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';
import { showToast } from './toast.js';

const BASE = '/bi-connections';

// Literal keys (the i18n-keys-exist test reads them), and the fields each kind has.
const KINDS = {
  grafana: {
    label: () => t('bi.kind_grafana'),
    fields: [
      { k: 'base_url', label: () => t('bi.f_grafana_url'), ph: 'https://grafana.example.com' },
    ],
    secret: () => t('bi.f_grafana_token'),
    hint: () => t('bi.hint_grafana'),
  },
  powerbi: {
    label: () => t('bi.kind_powerbi'),
    fields: [
      { k: 'tenant_id', label: () => t('bi.f_tenant_id'), ph: '00000000-0000-0000-0000-000000000000' },
      { k: 'client_id', label: () => t('bi.f_client_id'), ph: '00000000-0000-0000-0000-000000000000' },
    ],
    secret: () => t('bi.f_client_secret'),
    hint: () => t('bi.hint_powerbi'),
  },
  tableau: {
    label: () => t('bi.kind_tableau'),
    fields: [
      { k: 'server_url', label: () => t('bi.f_tableau_url'), ph: 'https://prod-useast-a.online.tableau.com' },
      { k: 'site', label: () => t('bi.f_tableau_site'), ph: 'mycompany' },
      { k: 'client_id', label: () => t('bi.f_ca_client_id'), ph: '' },
      { k: 'secret_id', label: () => t('bi.f_ca_secret_id'), ph: '' },
      { k: 'username', label: () => t('bi.f_tableau_user'), ph: 'screens@example.com' },
    ],
    secret: () => t('bi.f_ca_secret_value'),
    hint: () => t('bi.hint_tableau'),
  },
};
const CHECK_LABELS = {
  token: () => t('bi.check_token'),
  renderer: () => t('bi.check_renderer'),
  sign_in: () => t('bi.check_sign_in'),
  workspaces: () => t('bi.check_workspaces'),
  secret: () => t('bi.check_secret'),
  connection: () => t('bi.check_connection'),
};

export async function mountBiConnections(host) {
  if (!host) return;
  let data;
  try { data = await api.get(BASE); } catch (_) { host.style.display = 'none'; return; }
  if (!data.can_manage) { host.style.display = 'none'; return; }
  host.style.display = '';
  host.innerHTML = `<h3>${esc(t('bi.title'))}</h3>
    <p style="color:var(--text-muted);font-size:12px;margin-bottom:8px">${esc(t('bi.blurb'))}</p>
    <div data-bi="list"></div>
    <details data-bi="add" style="margin-top:12px">
      <summary style="cursor:pointer;font-size:13px">${esc(t('bi.add'))}</summary>
      <div data-bi="addform" style="margin-top:12px;max-width:560px"></div>
    </details>`;
  const list = host.querySelector('[data-bi="list"]');
  const addForm = host.querySelector('[data-bi="addform"]');
  render();
  renderForm(addForm, null, 'grafana');

  async function reload() {
    try { data = await api.get(BASE); } catch (err) { showToast(err.message, 'error'); return; }
    render();
  }

  function render() {
    const rows = data.connections || [];
    if (!rows.length) { list.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${esc(t('bi.none'))}</p>`; return; }
    list.innerHTML = rows.map((c) => `
      <div data-bi-row="${esc(c.id)}" style="border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <div style="min-width:0">
            <strong>${esc(c.name)}</strong>
            <span style="font-size:12px;color:var(--text-muted)"> · ${esc(KINDS[c.kind] ? KINDS[c.kind].label() : c.kind)}</span>
            <div style="font-size:12px;color:var(--text-muted);word-break:break-all">${esc(c.config.base_url || c.config.server_url || c.config.tenant_id || '')}${c.allow_private ? ` · ${esc(t('bi.private_on'))}` : ''}</div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn btn-secondary btn-sm" data-bi-test="${esc(c.id)}">${esc(t('bi.test'))}</button>
            <button class="btn btn-secondary btn-sm" data-bi-edit="${esc(c.id)}">${esc(t('bi.edit'))}</button>
            <button class="btn btn-danger btn-sm" data-bi-del="${esc(c.id)}">${esc(t('bi.delete'))}</button>
          </div>
        </div>
        <div data-bi-out="${esc(c.id)}" style="display:none;margin-top:8px;font-size:12px"></div>
        <div data-bi-editbox="${esc(c.id)}" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--border);max-width:560px"></div>
      </div>`).join('');

    list.querySelectorAll('[data-bi-test]').forEach((b) => b.addEventListener('click', async () => {
      const out = list.querySelector(`[data-bi-out="${b.dataset.biTest}"]`);
      out.style.display = '';
      out.textContent = t('bi.testing');
      try {
        const r = await api.post(`${BASE}/${b.dataset.biTest}/test`, {});
        out.innerHTML = (r.checks || []).map((c) => `<div>${c.ok ? '✅' : (c.warn ? '⚠️' : '❌')} ${esc(CHECK_LABELS[c.name] ? CHECK_LABELS[c.name]() : c.name)} — <span style="color:var(--text-muted)">${esc(c.detail || '')}</span></div>`).join('');
      } catch (err) { out.textContent = err.message; }
    }));
    list.querySelectorAll('[data-bi-edit]').forEach((b) => b.addEventListener('click', () => {
      const box = list.querySelector(`[data-bi-editbox="${b.dataset.biEdit}"]`);
      if (box.style.display === 'none') {
        const row = rows.find((r) => r.id === b.dataset.biEdit);
        renderForm(box, row, row.kind);
        box.style.display = '';
      } else box.style.display = 'none';
    }));
    list.querySelectorAll('[data-bi-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(t('bi.confirm_delete'))) return;
      try { await api.delete(`${BASE}/${b.dataset.biDel}`); }
      catch (err) {
        if (err.status !== 409 || !confirm(`${err.message}\n\n${t('bi.confirm_delete_in_use')}`)) { if (err.status !== 409) showToast(err.message, 'error'); return; }
        try { await api.delete(`${BASE}/${b.dataset.biDel}?force=1`); } catch (e2) { showToast(e2.message, 'error'); return; }
      }
      showToast(t('bi.removed'), 'success');
      reload();
    }));
  }

  function renderForm(box, row, kind) {
    const spec = KINDS[kind];
    const cfg = (row && row.config) || {};
    box.innerHTML = `<div style="display:grid;gap:10px">
      ${row ? '' : `<div class="form-group"><label>${esc(t('bi.f_kind'))}</label>
        <select class="input" data-f="kind">${Object.keys(KINDS).map((k) => `<option value="${k}" ${k === kind ? 'selected' : ''}>${esc(KINDS[k].label())}</option>`).join('')}</select></div>`}
      <div style="font-size:12px;color:var(--text-muted)">${esc(spec.hint())}</div>
      <div class="form-group"><label>${esc(t('bi.f_name'))}</label><input class="input" data-f="name" value="${esc(row ? row.name : '')}"></div>
      ${spec.fields.map((f) => `<div class="form-group"><label>${esc(f.label())}</label><input class="input" data-f="${f.k}" value="${esc(cfg[f.k] || '')}" placeholder="${esc(f.ph)}"></div>`).join('')}
      <div class="form-group"><label>${esc(spec.secret())}</label>
        <input type="password" class="input" data-f="secret" autocomplete="new-password" placeholder="${esc(row && row.has_secret ? t('bi.secret_kept') : '')}"></div>
      ${kind !== 'powerbi' && data.can_allow_private ? `<label style="display:flex;gap:6px;align-items:center;font-size:12px">
        <input type="checkbox" data-f="allow_private" ${row && row.allow_private ? 'checked' : ''}> ${esc(t('bi.f_allow_private'))}</label>` : ''}
      <div><button class="btn btn-primary btn-sm" data-f="save">${esc(row ? t('bi.save') : t('bi.create'))}</button></div>
    </div>`;
    const kindSel = box.querySelector('[data-f="kind"]');
    if (kindSel) kindSel.addEventListener('change', () => renderForm(box, null, kindSel.value));
    box.querySelector('[data-f="save"]').addEventListener('click', async () => {
      const val = (k) => { const el = box.querySelector(`[data-f="${k}"]`); return el ? el.value.trim() : undefined; };
      const body = { name: val('name') };
      if (!row) body.kind = kind;
      for (const f of spec.fields) body[f.k] = val(f.k);
      const secret = box.querySelector('[data-f="secret"]').value;
      if (secret) body.secret = secret;
      const ap = box.querySelector('[data-f="allow_private"]');
      if (ap) body.allow_private = ap.checked;
      try {
        if (row) await api.put(`${BASE}/${row.id}`, body); else await api.post(BASE, body);
      } catch (err) { showToast(err.message, 'error'); return; }
      showToast(t('bi.saved'), 'success');
      if (!row) { host.querySelector('[data-bi="add"]').open = false; renderForm(addForm, null, 'grafana'); }
      reload();
    });
  }
}
