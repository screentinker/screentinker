/*
 * 3.0: a layout on a playlist (docs/layouts-and-campaigns.md).
 *
 * The playlist editor's "Layout" row, the per-item zone picker, and the dialog that moves items
 * between zones when the layout changes. The server decides what plays (the resolver view puts the
 * playlist's layout below a schedule's and above the screen's own); this only edits the choice.
 *
 * ⚠️ A layout change is a DRAFT like any other playlist edit: screens get it on Publish, together
 * with the moved items, so the two can never be seen half-applied.
 */
import { api } from '../api.js';
import { showToast } from './toast.js';
import { esc } from '../utils.js';
import { t, tn } from '../i18n.js';

let layoutsCache = null;

async function loadLayouts() {
  if (layoutsCache) return layoutsCache;
  layoutsCache = await api.getLayouts();
  setTimeout(() => { layoutsCache = null; }, 30000);
  return layoutsCache;
}

/** The row under the playlist header. Read-only playlists (head office's, a slot's content) get none. */
export function layoutPickerHtml(playlist) {
  if (!playlist || playlist.corporate || playlist.corporate_slot) return '';
  // A campaign switches between whole layouts (its layout items); it does not play in one.
  if ((playlist.items || []).some((it) => it.layout_ref_id)) return '';
  const explicit = !!(playlist.layout && playlist.layout.explicit);
  return `
    <div id="playlistLayoutRow" ${explicit ? "" : "data-advanced-ui"} style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:-4px 0 12px;font-size:13px">
      <label for="playlistLayoutSelect" style="color:var(--text-muted)">${esc(t('layoutpl.label'))}</label>
      <select id="playlistLayoutSelect" class="input" style="width:auto;max-width:280px;background:var(--bg-input);font-size:13px;padding:4px 8px">
        <option value="">${esc(t('layoutpl.screen_own'))}</option>
        ${explicit ? `<option value="${esc(playlist.layout.id)}" selected>${esc(playlist.layout.name || '')}</option>` : ''}
      </select>
      <span style="font-size:12px;color:var(--text-muted)">${esc(explicit ? t('layoutpl.hint_set') : t('layoutpl.hint_unset'))}</span>
      ${explicit ? defaultZonePickerHtml(playlist.layout) : ''}
    </div>`;
}

/**
 * Where this playlist's zone-less items play: everything added without a zone (the Manager app,
 * the API, Make a sign, content requests...) lands here on Publish. The empty value follows the
 * layout's main zone. Only for a layout with two or more zones; one zone has nothing to choose.
 */
function defaultZonePickerHtml(layout) {
  if (!layout || !Array.isArray(layout.zones) || layout.zones.length < 2) return '';
  const main = layout.zones.find((z) => z.id === layout.layout_main_zone_id);
  const chosen = layout.default_zone_id || '';
  return `
      <span style="display:flex;align-items:center;gap:8px;flex-basis:100%;flex-wrap:wrap">
        <label for="playlistDefaultZoneSelect" style="color:var(--text-muted)">${esc(t('layoutpl.default_zone'))}</label>
        <select id="playlistDefaultZoneSelect" class="input" style="width:auto;max-width:280px;background:var(--bg-input);font-size:13px;padding:4px 8px">
          <option value="" ${chosen ? '' : 'selected'}>${esc(t('layoutpl.default_zone_layout_main', { name: main ? main.name : '' }))}</option>
          ${layout.zones.map((z) => `<option value="${esc(z.id)}" ${z.id === chosen ? 'selected' : ''}>${esc(z.name)}</option>`).join('')}
        </select>
        <span style="font-size:12px;color:var(--text-muted)">${esc(t('layoutpl.default_zone_hint'))}</span>
      </span>`;
}

/** Fill the select once the layouts arrive, and wire the change. */
export async function mountLayoutPicker(playlist, onChanged) {
  const dz = document.getElementById('playlistDefaultZoneSelect');
  if (dz) {
    const was = dz.value;
    dz.addEventListener('change', async () => {
      try {
        await api.updatePlaylist(playlist.id, { default_zone_id: dz.value || null });
        showToast(t('layoutpl.toast_default_zone'), 'info');
        onChanged && onChanged();
      } catch (err) {
        showToast(err.message, 'error');
        dz.value = was;
      }
    });
  }
  const sel = document.getElementById('playlistLayoutSelect');
  if (!sel) return;
  let layouts = [];
  try { layouts = await loadLayouts(); } catch { return; }
  const current = playlist.layout && playlist.layout.explicit ? playlist.layout.id : '';
  const opt = (l) => `<option value="${esc(l.id)}" ${l.id === current ? 'selected' : ''}>${esc(l.is_template ? t('layoutpl.template_name', { name: l.name }) : l.name)} (${esc(tn('playlist.zones_count', (l.zones || []).length))})</option>`;
  sel.innerHTML = `<option value="">${esc(t('layoutpl.screen_own'))}</option>`
    + layouts.filter((l) => !l.is_template).map(opt).join('')
    + layouts.filter((l) => l.is_template).map(opt).join('');
  sel.addEventListener('change', async () => {
    const next = sel.value || null;
    try {
      const done = await changeLayout(playlist, next);
      if (done) { showToast(t('layoutpl.toast_changed'), 'info'); onChanged && onChanged(); }
      else sel.value = current;
    } catch (err) {
      showToast(err.message, 'error');
      sel.value = current;
    }
  });
}

/**
 * Change the layout, offering to move the items first. Resolves true when saved, false when the
 * person backed out.
 */
async function changeLayout(playlist, layoutId) {
  if (!layoutId) {
    // Back to "the screen's own layout": items keep their zones (a screen whose own layout has
    // those zones still places them), so there is nothing to map.
    await api.updatePlaylist(playlist.id, { layout_id: null });
    return true;
  }
  const plan = await api.getPlaylistLayoutZoneMap(playlist.id, layoutId);
  if (!plan.zones || !plan.zones.length) {
    await api.updatePlaylist(playlist.id, { layout_id: layoutId });
    return true;
  }
  const map = await zoneMapDialog(plan);
  if (!map) return false;
  await api.updatePlaylist(playlist.id, { layout_id: layoutId, zone_map: map });
  return true;
}

/** The "where should these items go?" dialog. Resolves the confirmed map, or null on cancel. */
function zoneMapDialog(plan) {
  return new Promise((resolve) => {
    const zones = (plan.layout && plan.layout.zones) || [];
    const option = (z, selected) => `<option value="${esc(z.id)}" ${selected ? 'selected' : ''}>${esc(z.name)}${z.id === plan.main_zone_id ? ' ' + esc(t('layoutpl.main_suffix')) : ''}</option>`;
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000';
    modal.innerHTML = `
      <div role="dialog" aria-modal="true" aria-labelledby="zoneMapTitle" style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;width:520px;max-width:92vw;max-height:86vh;overflow:auto">
        <h3 id="zoneMapTitle" style="margin:0 0 8px;color:var(--text-primary)">${esc(t('layoutpl.map_title', { name: plan.layout ? plan.layout.name : '' }))}</h3>
        <p style="font-size:13px;color:var(--text-muted);margin:0 0 14px">${esc(t('layoutpl.map_intro'))}</p>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${plan.zones.map((z) => `
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
              <div style="flex:1;min-width:160px;font-size:13px">
                <strong>${esc(z.name)}</strong>
                <span style="color:var(--text-muted)">${z.layout_name ? ' · ' + esc(z.layout_name) : ''} · ${esc(tn('layoutpl.items_n', z.items))}</span>
              </div>
              <span aria-hidden="true" style="color:var(--text-muted)">&rarr;</span>
              <select class="input zone-map-target" data-from="${esc(z.id)}" aria-label="${esc(t('layoutpl.map_target_for', { name: z.name }))}" style="width:200px;background:var(--bg-input)">
                ${zones.map((n) => option(n, n.id === (z.suggested || plan.main_zone_id))).join('')}
              </select>
            </div>`).join('')}
        </div>
        ${plan.unzoned_items ? `<p style="font-size:12px;color:var(--text-muted);margin:12px 0 0">${esc(tn('layoutpl.unzoned_note', plan.unzoned_items))}</p>` : ''}
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px">
          <button class="btn btn-secondary" id="zoneMapCancel">${esc(t('common.cancel'))}</button>
          <button class="btn btn-primary" id="zoneMapOk">${esc(t('layoutpl.map_confirm'))}</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const close = (v) => { modal.remove(); resolve(v); };
    modal.querySelector('#zoneMapCancel').addEventListener('click', () => close(null));
    modal.addEventListener('click', (e) => { if (e.target === modal) close(null); });
    modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); });
    modal.querySelector('#zoneMapOk').addEventListener('click', () => {
      const map = {};
      modal.querySelectorAll('.zone-map-target').forEach((s) => { map[s.dataset.from] = s.value || null; });
      close(map);
    });
    modal.querySelector('#zoneMapOk').focus();
  });
}

/**
 * The per-item zone picker, shown only on a playlist that chose a multi-zone layout. "Main zone" (or
 * "Default zone", when the playlist chose one) is the empty value: the item has no zone of its own
 * and plays where every zone-less item does.
 */
export function zoneSelectHtml(item, layout) {
  if (!layout || !layout.explicit || !Array.isArray(layout.zones) || layout.zones.length < 2) return '';
  if (item.child_playlist_id || item.slot_id) return '';
  const known = layout.zones.some((z) => z.id === item.zone_id);
  const main = layout.zones.find((z) => z.id === layout.main_zone_id);
  return `<select class="input item-zone" data-item-id="${esc(String(item.id))}" aria-label="${esc(t('layoutpl.zone_for_item'))}" title="${esc(t('layoutpl.zone_for_item'))}" style="width:130px;padding:4px 6px;font-size:12px;background:var(--bg-input)${item.zone_id && !known ? ';border-color:var(--danger)' : ''}">
    <option value="" ${!item.zone_id ? 'selected' : ''}>${esc(t(layout.default_zone_id ? 'layoutpl.zone_default_auto' : 'layoutpl.zone_main_auto', { name: main ? main.name : '' }))}</option>
    ${layout.zones.map((z) => `<option value="${esc(z.id)}" ${z.id === item.zone_id ? 'selected' : ''}>${esc(z.name)}</option>`).join('')}
    ${item.zone_id && !known ? `<option value="${esc(item.zone_id)}" selected>${esc(t('layoutpl.zone_other_layout'))}</option>` : ''}
  </select>`;
}

/** Wire the zone pickers rendered by zoneSelectHtml. */
export function bindZoneSelects(root, playlistId, onChanged) {
  root.querySelectorAll('.item-zone').forEach((sel) => {
    sel.addEventListener('click', (e) => e.stopPropagation());
    sel.addEventListener('change', async () => {
      try {
        await api.updatePlaylistItem(playlistId, sel.dataset.itemId, { zone_id: sel.value || null });
        showToast(t('layoutpl.toast_zone'), 'info');
        onChanged && onChanged();
      } catch (err) { showToast(err.message, 'error'); onChanged && onChanged(); }
    });
  });
}
