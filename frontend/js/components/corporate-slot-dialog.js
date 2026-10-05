/*
 * "Add local slot" / "Slot settings" for a head office (corporate) playlist (spec §7.3).
 *
 * A local slot is the space in head office's playlist that each store fills with its own content,
 * within the limits set here. ⚠️ Changes apply when head office PUBLISHES (R19): the published
 * playlist carries the limits stores are held to. So when an existing slot's limits are lowered the
 * dialog shows the draft-vs-live line from GET /api/corporate/slots/:id/impact — "Live: up to 5 ·
 * After you publish: up to 3 · 2 stores have more than that" — before anyone saves.
 */
import { api } from '../api.js';
import { t, tn } from '../i18n.js';
import { esc } from '../utils.js';
import { showToast } from './toast.js';
import { openModal, limitsText } from './corporate-ui.js';

const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

/**
 * @param {object} playlist  the corporate playlist (its layout, if any, offers zones)
 * @param {object|null} slot the slot's view (GET /api/corporate/playlists/:id slots[]) or null to add
 * @param {Function} onSaved
 */
export async function openSlotDialog(playlist, slot, onSaved) {
  let content = [];
  let widgets = [];
  try {
    const [c, w] = await Promise.all([api.getAllContent().catch(() => ({ items: [] })), api.getWidgets().catch(() => [])]);
    // A fallback plays when a store leaves the slot empty, so it must end like anything in a slot.
    content = (c.items || []).filter((x) => {
      const m = String(x.mime_type || '');
      if (m === 'video/hls' || m === 'video/rtsp' || m === 'video/youtube') return false;
      if ((m.startsWith('video/') || m.startsWith('audio/')) && !(Number(x.duration_sec) > 0)) return false;
      return true;
    });
    widgets = Array.isArray(w) ? w : [];
  } catch (_) { /* the dialog still works without a fallback list */ }
  const lim = (slot && slot.limits) || {};
  const fb = slot && slot.fallback ? `${slot.fallback.kind}:${slot.fallback.id}` : '';
  const zones = (playlist.layout && playlist.layout.zones) || [];
  const zoneId = slot && slot.placement ? slot.placement.zone_id : null;
  const m = openModal({
    title: slot ? t('corp.hq.slot_settings_title', { name: slot.name }) : t('corp.hq.add_slot'),
    wide: true,
    body: `
      <div class="corp-grid2">
        <div class="form-group"><label for="slName">${esc(t('corp.form.name'))}</label>
          <input id="slName" class="input" maxlength="80" value="${esc(slot ? slot.name : '')}" placeholder="${esc(t('corp.hq.slot_name_ph'))}"></div>
        <div class="form-group"><label for="slHelp">${esc(t('corp.hq.slot_help_label'))}</label>
          <input id="slHelp" class="input" maxlength="500" value="${esc(slot && slot.help_text ? slot.help_text : '')}" placeholder="${esc(t('corp.hq.slot_help_ph'))}"></div>
        <div class="form-group"><label for="slMaxItems">${esc(t('corp.hq.slot_max_items'))}</label>
          <input id="slMaxItems" class="input" type="number" min="1" max="100" value="${esc(lim.max_items == null ? '' : String(lim.max_items))}" placeholder="${esc(t('corp.hq.no_limit'))}"></div>
        <div class="form-group"><label for="slMaxSec">${esc(t('corp.hq.slot_max_sec'))}</label>
          <input id="slMaxSec" class="input" type="number" min="5" max="3600" value="${esc(lim.max_total_sec == null ? '' : String(lim.max_total_sec))}" placeholder="${esc(t('corp.hq.no_limit'))}"></div>
      </div>
      <label class="corp-check"><input type="checkbox" id="slVideo" ${lim.allow_video === 0 || lim.allow_video === false ? '' : 'checked'}> ${esc(t('corp.hq.slot_allow_video'))}</label>
      <label class="corp-check"><input type="checkbox" id="slWidgets" ${lim.allow_widgets === 0 || lim.allow_widgets === false ? '' : 'checked'}> ${esc(t('corp.hq.slot_allow_widgets'))}</label>
      <div class="corp-grid2" style="margin-top:12px">
        <div class="form-group"><label for="slFallback">${esc(t('corp.hq.slot_fallback'))}</label>
          <select id="slFallback" class="input">
            <option value="">${esc(t('corp.hq.slot_fallback_none'))}</option>
            ${content.length ? `<optgroup label="${esc(t('playlist.tab_content'))}">${content.map((c) => `<option value="content:${esc(c.id)}" ${fb === `content:${c.id}` ? 'selected' : ''}>${esc(c.filename)}</option>`).join('')}</optgroup>` : ''}
            ${widgets.length ? `<optgroup label="${esc(t('playlist.tab_widgets'))}">${widgets.map((w) => `<option value="widget:${esc(w.id)}" ${fb === `widget:${w.id}` ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</optgroup>` : ''}
          </select></div>
        <div class="form-group"><label for="slFbDur">${esc(t('corp.hq.slot_fallback_sec'))}</label>
          <input id="slFbDur" class="input" type="number" min="1" max="3600" value="${esc(slot && slot.fallback && slot.fallback.duration_sec ? String(slot.fallback.duration_sec) : '')}" placeholder="10"></div>
        ${!slot && zones.length ? `<div class="form-group"><label for="slZone">${esc(t('corp.hq.slot_zone'))}</label>
          <select id="slZone" class="input"><option value="">${esc(t('device.assign.zone_default'))}</option>
            ${zones.map((z) => `<option value="${esc(z.id)}" ${zoneId === z.id ? 'selected' : ''}>${esc(z.name)}</option>`).join('')}</select></div>` : ''}
      </div>
      <p class="corp-help">${esc(t('corp.hq.slot_video_note'))} ${esc(t('corp.slot.no_live'))}</p>
      <p class="corp-help"><strong>${esc(t('corp.hq.slot_apply_note'))}</strong></p>
      <div id="slImpact" class="corp-help"></div>`,
    footer: `<button class="btn btn-secondary" data-corp-close>${esc(t('common.cancel'))}</button><button class="btn btn-primary" id="slSave">${esc(t('common.save'))}</button>`,
  });
  const q = m.q;
  q('#slName').focus();

  let seq = 0;
  async function impact() {
    if (!slot) return;
    const mine = ++seq;
    const params = { max_items: q('#slMaxItems').value, max_total_sec: q('#slMaxSec').value, allow_video: q('#slVideo').checked ? '1' : '0', allow_widgets: q('#slWidgets').checked ? '1' : '0' };
    try {
      const r = await api.getSlotImpact(slot.id, params);
      if (mine !== seq) return;
      q('#slImpact').innerHTML = `<div class="corp-notice ${r.stores ? 'corp-notice-warn' : ''}">${esc(t('corp.hq.slot_impact', {
        live: r.live ? limitsText(r.live) : t('corp.hq.slot_not_live'), next: limitsText(r.next), k: r.stores,
      }))}${r.over && r.over.length ? `<ul class="corp-list">${r.over.map((o) => `<li>${esc(o.workspace_name)} — ${esc(o.scope_label || '')}: ${esc(tn('corp.n_items', o.items))}, ${esc(t('corp.sec', { n: o.seconds }))}</li>`).join('')}</ul>` : ''}</div>`;
    } catch (_) { /* advisory only */ }
  }
  ['#slMaxItems', '#slMaxSec', '#slVideo', '#slWidgets'].forEach((sel) => q(sel).addEventListener('change', impact));
  impact();

  q('#slSave').addEventListener('click', async () => {
    const name = q('#slName').value.trim();
    if (!name) { q('#slName').focus(); return; }
    const [fbKind, ...fbRest] = (q('#slFallback').value || '').split(':');
    const fbId = fbRest.join(':') || null;
    const body = {
      name, help_text: q('#slHelp').value.trim() || null,
      max_items: num(q('#slMaxItems').value), max_total_sec: num(q('#slMaxSec').value),
      allow_video: q('#slVideo').checked, allow_widgets: q('#slWidgets').checked,
      fallback_content_id: fbKind === 'content' ? fbId : null, fallback_widget_id: fbKind === 'widget' ? fbId : null,
      fallback_duration_sec: num(q('#slFbDur').value),
    };
    if (!slot && q('#slZone')) body.zone_id = q('#slZone').value || null;
    try {
      if (slot) await api.updateSlot(slot.id, body); else await api.createSlot(playlist.id, body);
      m.close();
      showToast(t('corp.hq.slot_saved'), 'success');
      if (typeof onSaved === 'function') onSaved();
    } catch (e) { showToast(e.message, 'error'); }
  });
}
