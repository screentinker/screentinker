/*
 * Settings → Organization → "Corporate content" (spec §7.2). Organization owners and admins only —
 * the server enforces that (403 CORPORATE_ADMIN_REQUIRED); this card is simply not shown to anyone
 * else, the same way the SSO card is.
 *
 * ⚠️ LIMITING STORE TRIGGERS CAN END A STORE'S OWN SAFETY NOTICE (an evacuation relay that sends
 * once). Choosing "Limit stuck triggers" or "Don't show store triggers" therefore shows the list of
 * store triggers it changes and needs "I've checked these" ticked before Save — the server refuses
 * the change without that acknowledgement (409 CORPORATE_IMPACT_UNACKNOWLEDGED) whatever this does.
 */
import { api } from '../api.js';
import { t, tn } from '../i18n.js';
import { esc } from '../utils.js';
import { showToast } from './toast.js';
import { ask, forgetCorporateCache } from './corporate-ui.js';
import { openWorkspaceCreateModal } from './workspace-create-modal.js';

export async function mountCorporateSettings(host) {
  if (!host) return;
  let s;
  try { s = await api.getCorporateSettings(); } catch (_) { s = null; }
  if (!s || !s.is_admin) { host.innerHTML = ''; host.style.display = 'none'; return; }
  host.style.display = '';
  const hqLocked = (s.corporate_playlists || 0) > 0;
  const capMin = Math.round((s.store_trigger_cap_sec || 300) / 60);
  host.innerHTML = `
    <h3>${esc(t('corp.settings.title'))}</h3>
    <p class="corp-help" style="margin-bottom:10px">${esc(t('corp.settings.help'))}</p>
    ${!s.available ? `<div class="corp-notice corp-notice-danger">${esc(t('corp.err.CORPORATE_UNAVAILABLE'))}</div>` : ''}
    <label class="corp-check"><input type="checkbox" id="csEnabled" ${s.corporate_enabled ? 'checked' : ''}> <strong>${esc(t('corp.settings.toggle'))}</strong></label>

    <div class="form-group" style="margin-top:12px"><label for="csHq">${esc(t('corp.settings.hq'))}</label>
      <div class="corp-row">
        <select id="csHq" class="input" style="min-width:220px" ${hqLocked ? 'disabled' : ''}>
          <option value="">${esc(t('corp.settings.hq_none'))}</option>
          ${(s.workspaces || []).map((w) => `<option value="${esc(w.id)}" ${w.id === s.hq_workspace_id ? 'selected' : ''} ${w.replicated ? 'disabled' : ''}>${esc(w.name)}${w.replicated ? ' — ' + esc(t('corp.where.replicated')) : ''}</option>`).join('')}
        </select>
        ${hqLocked ? '' : `<button type="button" class="btn btn-secondary btn-sm" id="csCreateHq">${esc(t('corp.settings.hq_create'))}</button>`}
      </div>
      <div class="corp-help">${esc(hqLocked ? tn('corp.settings.hq_locked', s.corporate_playlists) : t('corp.settings.hq_help'))}</div>
    </div>

    <div class="form-group"><label>${esc(t('corp.settings.authors'))}</label>
      <label class="corp-check"><input type="radio" name="csAuthors" value="org_admins" ${s.corporate_authors !== 'org_admins_and_hq_editors' ? 'checked' : ''}> ${esc(t('corp.settings.authors_admins'))}</label>
      <label class="corp-check"><input type="radio" name="csAuthors" value="org_admins_and_hq_editors" ${s.corporate_authors === 'org_admins_and_hq_editors' ? 'checked' : ''}> ${esc(t('corp.settings.authors_editors'))}</label>
    </div>

    <div class="corp-hq-note">${esc(t('corp.settings.store_shape'))}</div>

    <div class="form-group" style="margin-top:12px"><label>${esc(t('corp.settings.store_triggers'))}</label>
      <label class="corp-check" style="display:flex"><input type="radio" name="csPolicy" value="allow" ${s.store_triggers_under_mandate === 'allow' ? 'checked' : ''}> ${esc(t('corp.settings.policy_allow'))}</label>
      <div class="corp-help" style="margin:0 0 6px 22px">${esc(t('corp.settings.policy_allow_help'))}</div>
      <label class="corp-check" style="display:flex"><input type="radio" name="csPolicy" value="leased" ${s.store_triggers_under_mandate === 'leased' ? 'checked' : ''}>
        ${esc(t('corp.settings.policy_leased'))} <input type="number" id="csCap" class="input" min="1" max="60" value="${esc(String(capMin))}" style="width:64px;padding:2px 6px"> ${esc(t('corp.settings.minutes'))}</label>
      <div class="corp-help" style="margin:0 0 6px 22px">${esc(t('corp.settings.policy_leased_help'))}</div>
      <label class="corp-check" style="display:flex"><input type="radio" name="csPolicy" value="off" ${s.store_triggers_under_mandate === 'off' ? 'checked' : ''}> ${esc(t('corp.settings.policy_off'))}</label>
      <div class="corp-help" style="margin:0 0 6px 22px">${esc(t('corp.settings.policy_off_help'))}</div>
      <div id="csImpact"></div>
    </div>

    <div class="form-group"><label class="corp-check"><input type="checkbox" id="csEmergency" ${s.emergency_triggers_enabled ? 'checked' : ''}> <strong>${esc(t('corp.settings.emergency'))}</strong></label>
      <div class="corp-help">${esc(t('corp.settings.emergency_help'))}</div>
    </div>

    <button type="button" class="btn btn-primary" id="csSave">${esc(t('common.save'))}</button>`;

  const q = (sel) => host.querySelector(sel);
  const policy = () => (host.querySelector('input[name="csPolicy"]:checked') || {}).value || 'allow';
  const capSec = () => Math.min(3600, Math.max(30, Math.round(Number(q('#csCap').value || 5) * 60)));
  let impact = [];

  async function showImpact() {
    const box = q('#csImpact');
    const p = policy();
    impact = [];
    if (p === 'allow') { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="corp-help">${esc(t('common.loading'))}</div>`;
    try {
      const r = await api.getStoreTriggerImpact(p, p === 'leased' ? capSec() : undefined);
      impact = r.impact || [];
      box.innerHTML = impact.length ? `
        <div class="corp-notice corp-notice-warn">
          <div>${esc(t(p === 'off' ? 'corp.settings.impact_hidden' : 'corp.settings.impact_limited', { k: impact.length, m: r.workspaces }))}</div>
          <details class="corp-details"><summary>${esc(t('corp.settings.impact_show'))}</summary>
            <ul class="corp-list">${impact.map((i) => `<li>${esc(i.workspace_name)} — ${esc(i.name)} (${esc(i.mode === 'until_cleared' ? t('corp.em.mode_until_short') : t('corp.em.mode_once_short'))}${i.mode === 'until_cleared' && i.lease_sec ? ', ' + esc(t('corp.sec', { n: i.lease_sec })) : ''})</li>`).join('')}</ul>
          </details>
          <label class="corp-check"><input type="checkbox" id="csAck"> ${esc(t('corp.settings.impact_ack'))}</label>
        </div>` : `<div class="corp-help">${esc(t('corp.settings.impact_none'))}</div>`;
    } catch (e) { box.innerHTML = `<div class="corp-notice corp-notice-danger">${esc(e.message)}</div>`; }
  }
  host.querySelectorAll('input[name="csPolicy"]').forEach((r) => r.addEventListener('change', showImpact));
  q('#csCap').addEventListener('change', () => { if (policy() === 'leased') showImpact(); });
  if (policy() !== 'allow') showImpact();

  q('#csCreateHq')?.addEventListener('click', () => openWorkspaceCreateModal());

  q('#csSave').addEventListener('click', async () => {
    const body = {};
    const enabled = q('#csEnabled').checked;
    const hq = q('#csHq').value || null;
    const authors = (host.querySelector('input[name="csAuthors"]:checked') || {}).value;
    if (enabled !== !!s.corporate_enabled) body.corporate_enabled = enabled;
    if (!hqLocked && hq !== (s.hq_workspace_id || null)) body.hq_workspace_id = hq;
    if (authors && authors !== s.corporate_authors) body.corporate_authors = authors;
    const p = policy();
    if (p !== s.store_triggers_under_mandate) body.store_triggers_under_mandate = p;
    if (p === 'leased' && capSec() !== s.store_trigger_cap_sec) body.store_trigger_cap_sec = capSec();
    const em = q('#csEmergency').checked;
    if (em !== !!s.emergency_triggers_enabled) body.emergency_triggers_enabled = em;
    if (!Object.keys(body).length) { showToast(t('corp.settings.nothing'), 'info'); return; }
    if (impact.length && (body.store_triggers_under_mandate || body.store_trigger_cap_sec)) {
      if (!q('#csAck') || !q('#csAck').checked) { showToast(t('corp.settings.impact_need_ack'), 'error'); return; }
      body.acknowledge_impact = true;
    }
    // The kill switch: say exactly what happens before it happens.
    if (body.corporate_enabled === false) {
      if (!await ask({ title: t('corp.settings.kill'), text: t('corp.settings.kill_confirm'), confirmLabel: t('corp.settings.kill'), danger: true })) return;
    }
    if (body.emergency_triggers_enabled === true) {
      if (!await ask({ title: t('corp.settings.emergency'), text: t('corp.settings.emergency_on_confirm'), confirmLabel: t('corp.settings.emergency_on') })) return;
    }
    try {
      const r = await api.updateCorporateSettings(body);
      forgetCorporateCache();
      showToast(tn('corp.settings.saved', r.screens_changed || 0), 'success');
      mountCorporateSettings(host);
      // The sidebar's Corporate item and the head office bar follow these settings.
      if (body.corporate_enabled !== undefined || body.hq_workspace_id !== undefined) setTimeout(() => window.location.reload(), 600);
    } catch (e) { showToast(e.message, 'error'); }
  });
}
