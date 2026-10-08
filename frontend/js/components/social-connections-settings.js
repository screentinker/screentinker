/*
 * "Social connections" (server/routes/social.js, docs/social-feeds.md): the organization's
 * Instagram, Facebook, YouTube and X credentials for social walls. Org owners and admins only.
 * Bluesky and Mastodon are public and need none.
 *
 * ⚠️ SECRETS ARE WRITE-ONLY. The form sends a token or key; nothing the server returns contains
 * one. Editing with the field left blank keeps the stored one.
 */
import { api } from '../api.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';
import { showToast } from './toast.js';

const BASE = '/social/connections';

const KINDS = {
  instagram: {
    label: () => t('social.kind_instagram'),
    fields: [
      { k: 'api', label: () => t('social.f_ig_api'), select: [['instagram_login', () => t('social.ig_api_instagram')], ['facebook_login', () => t('social.ig_api_facebook')]] },
      { k: 'ig_user_id', label: () => t('social.f_ig_user_id'), ph: '17841400000000000', only: (cfg) => cfg.api === 'facebook_login' },
    ],
    secret: () => t('social.f_access_token'),
    hint: () => t('social.hint_instagram'),
  },
  facebook: {
    label: () => t('social.kind_facebook'),
    fields: [{ k: 'page_id', label: () => t('social.f_page_id'), ph: '100000000000000' }],
    secret: () => t('social.f_page_token'),
    hint: () => t('social.hint_facebook'),
  },
  youtube: {
    label: () => t('social.kind_youtube'),
    fields: [],
    secret: () => t('social.f_api_key'),
    hint: () => t('social.hint_youtube'),
  },
  x: {
    label: () => t('social.kind_x'),
    fields: [],
    secret: () => t('social.f_bearer'),
    hint: () => t('social.hint_x'),
  },
};

export async function mountSocialConnections(host) {
  if (!host) return;
  let data;
  try { data = await api.get(BASE); } catch (_) { host.style.display = 'none'; return; }
  if (!data.can_manage) { host.style.display = 'none'; return; }
  host.style.display = '';
  host.innerHTML = `<h3>${esc(t('social.conn_title'))}</h3>
    <p style="color:var(--text-muted);font-size:12px;margin-bottom:8px">${esc(t('social.conn_blurb'))}</p>
    <div data-sc="list"></div>
    <details data-sc="add" style="margin-top:12px">
      <summary style="cursor:pointer;font-size:13px">${esc(t('social.conn_add'))}</summary>
      <div data-sc="addform" style="margin-top:12px;max-width:560px"></div>
    </details>`;
  const list = host.querySelector('[data-sc="list"]');
  const addForm = host.querySelector('[data-sc="addform"]');
  render();
  renderForm(addForm, null, 'instagram');

  async function reload() {
    try { data = await api.get(BASE); } catch (err) { showToast(err.message, 'error'); return; }
    render();
  }

  function render() {
    const rows = data.connections || [];
    if (!rows.length) { list.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${esc(t('social.conn_none'))}</p>`; return; }
    list.innerHTML = rows.map((c) => `
      <div style="border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <div style="min-width:0">
            <strong>${esc(c.name)}</strong>
            <span style="font-size:12px;color:var(--text-muted)"> · ${esc(KINDS[c.kind] ? KINDS[c.kind].label() : c.kind)}</span>
            ${c.token_expires_at ? `<div style="font-size:12px;color:var(--text-muted)">${esc(t('social.token_expires', { date: new Date(c.token_expires_at * 1000).toLocaleDateString() }))}</div>` : ''}
            ${c.last_error ? `<div style="font-size:12px;color:var(--danger,#b91c1c)">${esc(c.last_error)}</div>` : ''}
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn btn-secondary btn-sm" data-sc-test="${esc(c.id)}">${esc(t('social.test'))}</button>
            <button class="btn btn-secondary btn-sm" data-sc-edit="${esc(c.id)}">${esc(t('common.edit'))}</button>
            <button class="btn btn-danger btn-sm" data-sc-del="${esc(c.id)}">${esc(t('common.delete'))}</button>
          </div>
        </div>
        <div data-sc-out="${esc(c.id)}" style="display:none;margin-top:8px;font-size:12px"></div>
        <div data-sc-editbox="${esc(c.id)}" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--border);max-width:560px"></div>
      </div>`).join('');

    list.querySelectorAll('[data-sc-test]').forEach((b) => b.addEventListener('click', async () => {
      const out = list.querySelector(`[data-sc-out="${b.dataset.scTest}"]`);
      out.style.display = '';
      out.textContent = t('social.testing');
      try {
        const r = await api.post(`${BASE}/${b.dataset.scTest}/test`, {});
        out.textContent = `${r.ok ? '✅' : '❌'} ${r.detail || ''}`;
      } catch (err) { out.textContent = err.message; }
    }));
    list.querySelectorAll('[data-sc-edit]').forEach((b) => b.addEventListener('click', () => {
      const box = list.querySelector(`[data-sc-editbox="${b.dataset.scEdit}"]`);
      if (box.style.display === 'none') {
        const row = rows.find((r) => r.id === b.dataset.scEdit);
        renderForm(box, row, row.kind);
        box.style.display = '';
      } else box.style.display = 'none';
    }));
    list.querySelectorAll('[data-sc-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(t('social.conn_confirm_delete'))) return;
      try { await api.delete(`${BASE}/${b.dataset.scDel}`); }
      catch (err) {
        if (err.status !== 409) { showToast(err.message, 'error'); return; }
        if (!confirm(err.message)) return;
        try { await api.delete(`${BASE}/${b.dataset.scDel}?force=1`); } catch (e2) { showToast(e2.message, 'error'); return; }
      }
      showToast(t('social.removed'), 'success');
      reload();
    }));
  }

  function renderForm(box, row, kind, draft = null) {
    const spec = KINDS[kind];
    const cfg = draft || (row && row.config) || {};
    box.innerHTML = `<div style="display:grid;gap:10px">
      ${row ? '' : `<div class="form-group"><label>${esc(t('social.f_network'))}</label>
        <select class="input" data-f="kind">${Object.keys(KINDS).map((k) => `<option value="${k}" ${k === kind ? 'selected' : ''}>${esc(KINDS[k].label())}</option>`).join('')}</select></div>`}
      <div style="font-size:12px;color:var(--text-muted)">${esc(spec.hint())}</div>
      <div class="form-group"><label>${esc(t('social.f_name'))}</label><input class="input" data-f="name" value="${esc(row ? row.name : (draft && draft.name) || '')}"></div>
      ${spec.fields.filter((f) => !f.only || f.only(cfg)).map((f) => (f.select
        ? `<div class="form-group"><label>${esc(f.label())}</label><select class="input" data-f="${f.k}">${f.select.map(([v, l]) => `<option value="${v}" ${(cfg[f.k] || f.select[0][0]) === v ? 'selected' : ''}>${esc(l())}</option>`).join('')}</select></div>`
        : `<div class="form-group"><label>${esc(f.label())}</label><input class="input" data-f="${f.k}" value="${esc(cfg[f.k] || '')}" placeholder="${esc(f.ph || '')}"></div>`)).join('')}
      <div class="form-group"><label>${esc(spec.secret())}</label>
        <input type="password" class="input" data-f="secret" autocomplete="new-password" placeholder="${esc(row && row.has_secret ? t('social.secret_kept') : '')}"></div>
      <div><button class="btn btn-primary btn-sm" data-f="save">${esc(row ? t('common.save') : t('social.conn_create'))}</button></div>
    </div>`;
    const val = (k) => { const el = box.querySelector(`[data-f="${k}"]`); return el ? el.value.trim() : undefined; };
    const kindSel = box.querySelector('[data-f="kind"]');
    if (kindSel) kindSel.addEventListener('change', () => renderForm(box, null, kindSel.value));
    // The Instagram API choice decides which fields exist.
    const apiSel = box.querySelector('[data-f="api"]');
    if (apiSel) apiSel.addEventListener('change', () => renderForm(box, row, kind, { ...cfg, api: apiSel.value, name: val('name') }));
    box.querySelector('[data-f="save"]').addEventListener('click', async () => {
      const body = { name: val('name') };
      if (!row) body.kind = kind;
      for (const f of spec.fields) { const v = val(f.k); if (v !== undefined) body[f.k] = v; }
      const secret = box.querySelector('[data-f="secret"]').value;
      if (secret) body.secret = secret;
      try {
        if (row) await api.put(`${BASE}/${row.id}`, body); else await api.post(BASE, body);
      } catch (err) { showToast(err.message, 'error'); return; }
      showToast(t('social.saved'), 'success');
      if (!row) { host.querySelector('[data-sc="add"]').open = false; renderForm(addForm, null, 'instagram'); }
      reload();
    });
  }
}
