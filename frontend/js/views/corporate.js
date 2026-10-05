/*
 * #/corporate — head office (corporate) playlists. docs/corporate-playlists.md, spec §7.
 *
 * TWO FACES, chosen by who is looking (§7.1, §7.11):
 *
 *   Head office face — corporate authors and org admins. Tabs: Playlists · Where it plays · Store
 *   slots · Emergency alerts. It runs IN the head office workspace: every editor, media picker and
 *   upload is workspace-scoped, so an admin sitting in a store would otherwise get a 404 or pick the
 *   store's media (critique U7). Opening it switches there and the app shows a persistent "You are
 *   editing in Head office" bar with one click back (components/corporate-ui.js).
 *
 *   Store face — everyone else, in a workspace where head office plays something: "What head office
 *   plays here" (read-only) and "Your slots" with each level that has content, plus notices when a
 *   mandate starts or a slot's content stops playing.
 *
 * ⚠️ Every refusal comes from the server with a code; api.js shows it in the viewer's language. The
 * view never decides on its own that something is forbidden — it hides only what the role matrix
 * says a role never has (authoring for store users), and explains the rest.
 */
import { api, downloadSlotReportCsv } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc, hydrateAuthImages } from '../utils.js';
import { t, tn } from '../i18n.js';
import * as cui from '../components/corporate-ui.js';

const TABS = ['playlists', 'where', 'slots', 'emergency'];
let liveTimer = null;
let currentApp = null;

function tabFromHash() {
  const m = (window.location.hash || '').match(/^#\/corporate\/([a-z]+)/);
  return m && TABS.includes(m[1]) ? m[1] : 'playlists';
}

function currentWorkspace() {
  try {
    const me = JSON.parse(localStorage.getItem('user') || 'null');
    const id = me && me.current_workspace_id;
    const w = (me && Array.isArray(me.accessible_workspaces) ? me.accessible_workspaces : []).find((x) => x.id === id);
    return id ? { id, name: (w && w.name) || '' } : null;
  } catch { return null; }
}

const when = (ts) => (ts ? new Date(Number(ts) * 1000).toLocaleDateString() : '');

export async function render(container) {
  currentApp = container;
  stopLiveTimer();
  container.innerHTML = `<div style="color:var(--text-muted);padding:40px;text-align:center">${esc(t('common.loading'))}</div>`;
  const s = await cui.corporateSettings({ force: true });
  cui.renderHqContextBar(s);
  if (!s) {
    container.innerHTML = pageShell(t('nav.head_office'), `<div class="corp-empty">${esc(t('corp.page.no_org'))}</div>`);
    return;
  }
  const hqFace = s.can_author || s.is_admin;
  if (!hqFace) return renderStore(container, s);

  if (!s.hq_workspace_id) {
    container.innerHTML = pageShell(t('corp.hq.title'), `
      <div class="corp-empty">
        <p>${esc(t('corp.page.setup'))}</p>
        <a class="btn btn-primary" href="#/settings">${esc(t('corp.page.open_settings'))}</a>
      </div>`);
    return;
  }
  if (!s.active_workspace_is_hq) {
    // §7.1: head office's editors, pickers and uploads only work inside the head office workspace.
    container.innerHTML = pageShell(t('corp.hq.title'), `<div class="corp-empty">${esc(t('corp.ctx.switching', { name: s.hq_workspace_name || '' }))}</div>`);
    const from = currentWorkspace();
    if (from) cui.rememberReturnWorkspace(from);
    try { await cui.switchWorkspaceTo(s.hq_workspace_id, window.location.hash || '#/corporate'); }
    catch (e) {
      container.innerHTML = pageShell(t('corp.hq.title'), `<div class="corp-empty">${esc(e.message)}</div>`);
    }
    return;
  }
  renderHq(container, s);
}

export function cleanup() {
  stopLiveTimer();
  currentApp = null;
}

function stopLiveTimer() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }

function pageShell(title, inner, subtitle = '') {
  return `
    <div class="page-header"><div>
      <h1>${esc(title)}</h1>
      ${subtitle ? `<div class="subtitle">${esc(subtitle)}</div>` : ''}
    </div></div>
    ${inner}`;
}

/* ════════════════════════════════════════════════════════════════════════ head office face */

function renderHq(container, s) {
  const tab = tabFromHash();
  const tabLabel = { playlists: t('corp.tab.playlists'), where: t('corp.where.title'), slots: t('corp.slots.title'), emergency: t('corp.em.title') };
  container.innerHTML = pageShell(t('corp.hq.title'), `
    ${!s.available ? `<div class="corp-notice corp-notice-danger">${esc(t('corp.err.CORPORATE_UNAVAILABLE'))}</div>` : ''}
    ${!s.corporate_enabled ? `<div class="corp-notice">${esc(t('corp.page.off'))} <a href="#/settings">${esc(t('corp.page.open_settings'))}</a></div>` : ''}
    <div class="tabs corp-tabs" role="tablist">
      ${TABS.map((k) => `<a class="tab ${k === tab ? 'active' : ''}" role="tab" href="#/corporate/${k}" data-corp-tab="${k}">${esc(tabLabel[k])}</a>`).join('')}
    </div>
    <div id="corpTab"></div>`, t('corp.hq.subtitle', { name: s.hq_workspace_name || '' }));
  const host = container.querySelector('#corpTab');
  const run = { playlists: renderPlaylistsTab, where: renderWhereTab, slots: renderSlotsTab, emergency: renderEmergencyTab }[tab];
  run(host, s).catch((e) => { host.innerHTML = `<div class="corp-notice corp-notice-danger">${esc(e.message)}</div>`; });
}

function reloadTab() { if (currentApp) render(currentApp); }

/* ── Playlists tab (§7.3) ─────────────────────────────────────────────────────────────────── */

async function renderPlaylistsTab(host, s) {
  const { playlists } = await api.getCorporatePlaylists();
  const author = s.can_author;
  host.innerHTML = `
    ${author ? `<div class="corp-toolbar">
      <button class="btn btn-primary" id="corpNewPl">${esc(t('corp.hq.new'))}</button>
      <button class="btn btn-secondary" id="corpPromote">${esc(t('corp.hq.promote'))}</button>
    </div>` : `<div class="corp-notice">${esc(t('corp.err.CORPORATE_AUTHOR_REQUIRED'))}</div>`}
    ${playlists.length ? `<div class="corp-cards">${playlists.map((p) => `
      <div class="corp-card" data-pl="${esc(p.id)}">
        <div class="corp-card-head">
          <a class="corp-card-title" href="#/playlists/${esc(p.id)}">${esc(p.name)}</a>
          ${cui.chip(t('corp.badge.corporate'), 'hq', '', { lock: true })}
          ${p.status === 'draft' ? cui.chip(p.has_published ? t('corp.status.changes') : t('corp.status.never'), 'muted') : cui.chip(t('corp.status.published'), 'slot')}
        </div>
        <div class="corp-card-meta">
          ${esc(p.places ? t('corp.hq.plays_on', { screens: tn('corp.n_screens', p.screens), places: tn('corp.n_places', p.places) }) : t('corp.hq.not_playing'))}
          · ${esc(tn('corp.n_items', Math.max(0, p.item_count - (p.slot_count || 0))))}
          · ${esc(tn('corp.n_slots', p.slot_count || 0))}
        </div>
        <div class="corp-card-actions">
          <a class="btn btn-secondary btn-sm" href="#/playlists/${esc(p.id)}">${esc(author ? t('common.edit') : t('corp.open'))}</a>
          <a class="btn btn-secondary btn-sm" href="#/corporate/where">${esc(t('corp.where.title'))}</a>
          <button class="btn btn-secondary btn-sm" data-preview="${esc(p.id)}">${esc(t('corp.hq.preview'))}</button>
          ${author ? `<button class="btn btn-secondary btn-sm" data-demote="${esc(p.id)}">${esc(t('corp.hq.demote'))}</button>` : ''}
        </div>
      </div>`).join('')}</div>` : `<div class="corp-empty">${esc(t('corp.hq.empty'))}</div>`}`;

  host.querySelector('#corpNewPl')?.addEventListener('click', () => newCorporatePlaylist());
  host.querySelector('#corpPromote')?.addEventListener('click', () => promoteDialog());
  host.querySelectorAll('[data-preview]').forEach((b) => b.addEventListener('click', () => cui.openScreenPreview({ playlistId: b.dataset.preview, canDraft: author })));
  host.querySelectorAll('[data-demote]').forEach((b) => b.addEventListener('click', async () => {
    const p = playlists.find((x) => x.id === b.dataset.demote);
    if (!await cui.ask({ title: t('corp.hq.demote'), text: t('corp.hq.demote_confirm', { name: p.name }), confirmLabel: t('corp.hq.demote') })) return;
    try { await api.demoteCorporatePlaylist(p.id); showToast(t('corp.hq.demoted', { name: p.name }), 'success'); reloadTab(); }
    catch (e) { showToast(e.message, 'error'); }
  }));
}

function newCorporatePlaylist() {
  const m = cui.openModal({
    title: t('corp.hq.new'),
    body: `<div class="form-group"><label for="corpPlName">${esc(t('corp.form.name'))}</label><input id="corpPlName" class="input" maxlength="120" style="width:100%"></div>
           <div class="form-group"><label for="corpPlDesc">${esc(t('corp.form.description'))}</label><textarea id="corpPlDesc" class="input" style="width:100%;height:60px"></textarea></div>
           <p class="corp-help">${esc(t('corp.hq.new_help'))}</p>`,
    footer: `<button class="btn btn-secondary" data-corp-close>${esc(t('common.cancel'))}</button><button class="btn btn-primary" id="corpPlCreate">${esc(t('corp.form.create'))}</button>`,
  });
  m.q('#corpPlName').focus();
  m.q('#corpPlCreate').addEventListener('click', async () => {
    const name = m.q('#corpPlName').value.trim();
    if (!name) { m.q('#corpPlName').focus(); return; }
    try {
      const p = await api.createCorporatePlaylist(name, m.q('#corpPlDesc').value.trim());
      m.close();
      window.location.hash = `#/playlists/${p.id}`;
    } catch (e) { showToast(e.message, 'error'); }
  });
}

async function promoteDialog() {
  let rows = [];
  try { rows = (await api.getPlaylists()).filter((p) => !p.corporate && !p.smart_rules && !p.is_auto_generated && !p.corporate_slot); }
  catch (e) { showToast(e.message, 'error'); return; }
  const m = cui.openModal({
    title: t('corp.hq.promote'),
    body: rows.length ? `<p class="corp-help">${esc(t('corp.hq.promote_help'))}</p>
      <select id="corpPromoteSel" class="input" style="width:100%">${rows.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>`
      : `<p class="corp-help">${esc(t('corp.hq.promote_none'))}</p>`,
    footer: `<button class="btn btn-secondary" data-corp-close>${esc(t('common.cancel'))}</button>${rows.length ? `<button class="btn btn-primary" id="corpPromoteGo">${esc(t('corp.hq.promote_go'))}</button>` : ''}`,
  });
  m.q('#corpPromoteGo')?.addEventListener('click', async () => {
    try { await api.promoteCorporatePlaylist(m.q('#corpPromoteSel').value); m.close(); showToast(t('corp.hq.promoted'), 'success'); reloadTab(); }
    catch (e) { showToast(e.message, 'error'); }
  });
}

/* ── Where it plays (§7.4) ────────────────────────────────────────────────────────────────── */

async function renderWhereTab(host, s) {
  const [{ mandates }, { playlists }] = await Promise.all([api.getMandates(), api.getCorporatePlaylists()]);
  const admin = s.is_admin;
  host.innerHTML = `
    ${admin ? `<div class="corp-toolbar"><button class="btn btn-primary" id="corpAssign" ${s.corporate_enabled && s.available ? '' : 'disabled'}>${esc(t('corp.where.assign'))}</button>
      ${!s.corporate_enabled ? `<span class="corp-help">${esc(t('corp.err.CORPORATE_DISABLED'))}</span>` : ''}</div>`
      : `<div class="corp-notice">${esc(t('corp.err.CORPORATE_ADMIN_REQUIRED'))}</div>`}
    <p class="corp-help">${esc(t('corp.where.prefer_levels'))}</p>
    ${admin && (s.store_triggers_under_mandate || 'off') === 'allow' ? `<div class="corp-notice corp-notice-warn">${esc(t('corp.where.store_triggers_allowed'))} <a href="#/settings">${esc(t('corp.page.open_settings'))}</a></div>` : ''}
    ${mandates.length ? `<div class="table-wrap"><table class="corp-table">
      <thead><tr><th>${esc(t('corp.where.col_where'))}</th><th>${esc(t('corp.where.col_playlist'))}</th><th>${esc(t('corp.where.col_layout'))}</th><th>${esc(t('corp.where.col_screens'))}</th><th>${esc(t('corp.where.col_on'))}</th><th></th></tr></thead>
      <tbody>${mandates.map((mm) => `
        <tr data-mandate="${esc(mm.id)}">
          <td>${esc(cui.targetLabel(mm.target_kind, mm.target_name))}</td>
          <td>${mm.dark ? cui.chip(t('corp.badge.dark'), 'dark') : esc(mm.playlist_name || '')}</td>
          <td>${esc(mm.layout_name || t('corp.where.full_screen_short'))}</td>
          <td>${esc(tn('corp.n_screens', mm.screens))}</td>
          <td>${admin ? `<label class="corp-switch"><input type="checkbox" data-toggle="${esc(mm.id)}" ${mm.enabled ? 'checked' : ''} aria-label="${esc(t('corp.where.col_on'))}"></label>` : esc(mm.enabled ? t('corp.yes') : t('corp.no'))}</td>
          <td class="corp-actions-cell">
            ${mm.target_kind === 'device' ? `<button class="btn btn-secondary btn-sm" data-pv="${esc(mm.target_id)}">${esc(t('corp.hq.preview'))}</button>` : ''}
            ${admin ? `<button class="btn btn-secondary btn-sm" data-change="${esc(mm.id)}">${esc(t('corp.where.change'))}</button>
            <button class="btn btn-secondary btn-sm" data-remove="${esc(mm.id)}">${esc(t('corp.where.remove'))}</button>` : ''}
          </td>
        </tr>`).join('')}</tbody></table></div>`
      : `<div class="corp-empty">${esc(t('corp.where.empty'))}</div>`}`;

  host.querySelector('#corpAssign')?.addEventListener('click', () => mandateDialog(null, playlists));
  host.querySelectorAll('[data-change]').forEach((b) => b.addEventListener('click', () => mandateDialog(mandates.find((x) => x.id === b.dataset.change), playlists)));
  host.querySelectorAll('[data-pv]').forEach((b) => b.addEventListener('click', () => cui.openScreenPreview({ deviceId: b.dataset.pv })));
  host.querySelectorAll('[data-toggle]').forEach((cb) => cb.addEventListener('change', async () => {
    const mm = mandates.find((x) => x.id === cb.dataset.toggle);
    // Turning it off hands every screen back to the store, so it is asked like a removal.
    if (!cb.checked) {
      let pv = null;
      try { pv = (await api.previewMandate({ mandate_id: mm.id, remove: '1' })).preview; } catch (_) { pv = null; }
      const ok = await cui.ask({ title: t('corp.where.disable'), text: tn('corp.where.disable_confirm', (pv && pv.screens) || 0), confirmLabel: t('corp.where.disable') });
      if (!ok) { cb.checked = true; return; }
    }
    try {
      let r;
      try { r = await api.updateMandate(mm.id, { enabled: cb.checked }); } catch (e) {
        // Turning it back on would hide store triggers: list them and ask first.
        if (!await cui.confirmStoreTriggerImpact(e)) throw e;
        r = await api.updateMandate(mm.id, { enabled: cb.checked, acknowledge_impact: true });
      }
      showToast(tn('corp.where.changed_screens', r.screens_changed || 0), 'success'); cui.forgetCorporateCache(); reloadTab();
    } catch (e) { cb.checked = !cb.checked; if (e.code !== 'CORPORATE_STORE_TRIGGERS_IMPACT') showToast(e.message, 'error'); }
  }));
  host.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
    const mm = mandates.find((x) => x.id === b.dataset.remove);
    let pv = null;
    try { pv = (await api.previewMandate({ mandate_id: mm.id, remove: '1' })).preview; } catch (_) { pv = null; }
    const ok = await cui.ask({
      title: t('corp.where.remove'), danger: true, confirmLabel: t('corp.where.remove'),
      text: tn('corp.where.remove_confirm', (pv && pv.screens) || 0, { target: cui.targetLabel(mm.target_kind, mm.target_name) }),
    });
    if (!ok) return;
    try { const r = await api.deleteMandate(mm.id); showToast(tn('corp.where.changed_screens', r.screens_changed || 0), 'success'); cui.forgetCorporateCache(); reloadTab(); }
    catch (e) { showToast(e.message, 'error'); }
  }));
}

async function mandateDialog(existing, playlists) {
  let targets;
  let layouts = [];
  try {
    [targets, layouts] = await Promise.all([api.getCorporateTargets(), api.get('/layouts').catch(() => [])]);
  } catch (e) { showToast(e.message, 'error'); return; }
  const pickable = playlists;
  const kind0 = existing ? existing.target_kind : 'workspace';
  const m = cui.openModal({
    title: existing ? t('corp.where.change') : t('corp.where.assign'),
    wide: true,
    body: `
      <div class="form-group"><label>${esc(t('corp.where.step_playlist'))}</label>
        <select id="mdPl" class="input" style="width:100%">
          ${pickable.map((p) => `<option value="${esc(p.id)}" ${p.has_published ? '' : 'disabled'} ${existing && existing.playlist_id === p.id ? 'selected' : ''}>${esc(p.name)}${p.has_published ? '' : ' — ' + esc(t('corp.where.publish_first'))}</option>`).join('')}
        </select>
        <label class="corp-check" style="margin-top:6px"><input type="checkbox" id="mdDark" ${existing && existing.dark ? 'checked' : ''}> ${esc(t('corp.where.dark'))}</label>
        <div class="corp-help">${esc(t('corp.where.dark_help'))}</div>
      </div>
      <div class="form-group"><label>${esc(t('corp.where.step_where'))}</label>
        <div class="corp-row">
          <select id="mdKind" class="input">
            ${['org', 'workspace', 'group', 'wall', 'device'].map((k) => `<option value="${k}" ${k === kind0 ? 'selected' : ''}>${esc(t('corp.kind.' + k))}</option>`).join('')}
          </select>
          <select id="mdTarget" class="input" style="flex:1"></select>
        </div>
        <div class="corp-help">${esc(t('corp.where.wall_note'))}</div>
      </div>
      <div class="form-group"><label>${esc(t('corp.where.col_layout'))}</label>
        <select id="mdLayout" class="input" style="width:100%">
          <option value="">${esc(t('corp.where.full_screen'))}</option>
          ${(layouts || []).map((l) => `<option value="${esc(l.id)}" ${existing && existing.layout_id === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
        </select>
      </div>
      <div id="mdPreview" class="corp-preview-box"></div>`,
    footer: `<button class="btn btn-secondary" data-corp-close>${esc(t('common.cancel'))}</button><button class="btn btn-primary" id="mdSave" disabled>${esc(t('corp.where.confirm'))}</button>`,
  });
  const kindSel = m.q('#mdKind');
  const targetSel = m.q('#mdTarget');
  const fillTargets = () => {
    const k = kindSel.value;
    let opts = [];
    if (k === 'org') opts = [`<option value="${esc(targets.organization_id)}">${esc(targets.organization_name || t('corp.where.org'))}</option>`];
    else {
      opts = targets.workspaces.map((w) => {
        if (k === 'workspace') return `<option value="${esc(w.id)}" ${w.replicated ? 'disabled' : ''}>${esc(w.name)}${w.hq ? ' — ' + esc(t('corp.where.hq_ws')) : ''}${w.replicated ? ' — ' + esc(t('corp.where.replicated')) : ''}</option>`;
        const list = k === 'group' ? w.groups : k === 'wall' ? w.walls : w.devices;
        if (!list.length) return '';
        return `<optgroup label="${esc(w.name)}">${list.map((x) => `<option value="${esc(x.id)}" ${k === 'device' && x.wall_id ? 'disabled' : ''}>${esc(x.name)}${k === 'device' && x.wall_id ? ' — ' + esc(t('corp.where.wall_member', { name: x.wall_name || '' })) : ''}</option>`).join('')}</optgroup>`;
      });
    }
    targetSel.innerHTML = opts.join('') || `<option value="">${esc(t('corp.where.no_targets'))}</option>`;
    targetSel.disabled = k === 'org';
    if (existing && existing.target_kind === k) targetSel.value = existing.target_id;
  };
  fillTargets();
  const body = () => {
    const dark = m.q('#mdDark').checked;
    return {
      target_kind: kindSel.value, target_id: kindSel.value === 'org' ? targets.organization_id : targetSel.value,
      playlist_id: dark ? null : m.q('#mdPl').value, dark, layout_id: m.q('#mdLayout').value || null,
    };
  };
  let seq = 0;
  let impact = [];
  const refreshPreview = async () => {
    const mine = ++seq;
    impact = [];
    const b = body();
    const box = m.q('#mdPreview');
    const save = m.q('#mdSave');
    save.disabled = true;
    if (!b.target_id || (!b.dark && !b.playlist_id)) { box.innerHTML = ''; return; }
    box.innerHTML = esc(t('common.loading'));
    try {
      const params = { target_kind: b.target_kind, target_id: b.target_id, dark: b.dark ? '1' : '0' };
      if (b.playlist_id) params.playlist_id = b.playlist_id;
      if (b.layout_id) params.layout_id = b.layout_id;
      if (existing) params.mandate_id = existing.id;
      const { preview } = await api.previewMandate(params);
      if (mine !== seq) return;
      const name = b.dark ? t('corp.badge.dark') : (playlists.find((p) => p.id === b.playlist_id) || {}).name || '';
      box.innerHTML = `
        ${preview.screens ? `<p><strong>${esc(tn('corp.where.preview', preview.screens, { w: tn('corp.n_workspaces', preview.workspaces.length), name, k: tn('corp.n_schedules', preview.schedules || 0), j: tn('corp.n_screen_playlists', preview.screen_playlists || 0), l: tn('corp.n_store_layouts', preview.store_layouts || 0) }))}</strong></p>` : ''}
        ${preview.workspaces.length ? `<ul class="corp-list">${preview.workspaces.map((w) => `<li>${esc(w.name)} — ${esc(tn('corp.n_screens', w.screens))}</li>`).join('')}</ul>
          <div class="corp-help">${esc(t('corp.where.exclude_hint'))}</div>` : `<div class="corp-help">${esc(t('corp.where.no_change'))}</div>`}
        ${cui.storeTriggerImpactHtml(preview.store_triggers_affected, preview.store_trigger_policy, { ackId: 'mdTrigAck' })}`;
      // Store triggers this would hide: Save waits for "I've checked these".
      impact = preview.store_triggers_affected || [];
      const ack = m.q('#mdTrigAck');
      save.disabled = !!(impact.length && ack && !ack.checked);
      if (ack) ack.addEventListener('change', () => { save.disabled = !ack.checked; });
    } catch (e) {
      if (mine !== seq) return;
      box.innerHTML = `<div class="corp-notice corp-notice-danger">${esc(e.message)}</div>`;
    }
  };
  kindSel.addEventListener('change', () => { fillTargets(); refreshPreview(); });
  ['#mdTarget', '#mdPl', '#mdDark', '#mdLayout'].forEach((sel) => m.q(sel).addEventListener('change', refreshPreview));
  refreshPreview();
  m.q('#mdSave').addEventListener('click', async () => {
    const b = body();
    if (impact.length) {
      const ack = m.q('#mdTrigAck');
      if (!ack || !ack.checked) { showToast(t('corp.settings.impact_need_ack'), 'error'); return; }
      b.acknowledge_impact = true;
    }
    const save = (data) => (existing ? api.updateMandate(existing.id, data) : api.createMandate(data));
    try {
      let r;
      try { r = await save(b); } catch (e) {
        // The screens' triggers changed since the preview: show the server's list and ask again.
        if (!await cui.confirmStoreTriggerImpact(e)) throw e;
        r = await save({ ...b, acknowledge_impact: true });
      }
      m.close();
      showToast(tn('corp.where.changed_screens', r.screens_changed || 0), 'success');
      cui.forgetCorporateCache();
      reloadTab();
    } catch (e) { if (e.code !== 'CORPORATE_STORE_TRIGGERS_IMPACT') showToast(e.message, 'error'); }
  });
}

/* ── Store slots: compliance + corporate airtime (§7.5) ───────────────────────────────────── */

const STATE_TONE = { filled: 'slot', partly_filled: 'slot', fallback: 'muted', skipped: 'muted', over_limit: 'emergency' };
function stateLabel(state) {
  return {
    filled: t('corp.slots.filled'), partly_filled: t('corp.slots.partly'), fallback: t('corp.slots.fallback'),
    skipped: t('corp.slots.skipped'), over_limit: t('corp.slots.over'),
  }[state] || state;
}

async function renderSlotsTab(host) {
  host.innerHTML = `
    <div class="corp-toolbar">
      <label class="corp-check"><input type="checkbox" id="corpOnlyProblems"> ${esc(t('corp.slots.only_problems'))}</label>
      <button class="btn btn-secondary btn-sm" id="corpCsv">${esc(t('corp.slots.csv'))}</button>
    </div>
    <div id="corpSlotRows">${esc(t('common.loading'))}</div>
    <h3 class="corp-h3">${esc(t('corp.slots.airtime'))}</h3>
    <div class="corp-toolbar">
      <select id="corpAirRange" class="input" style="width:auto">
        <option value="7">${esc(tn('corp.slots.last_days', 7))}</option>
        <option value="30">${esc(tn('corp.slots.last_days', 30))}</option>
        <option value="90">${esc(tn('corp.slots.last_days', 90))}</option>
      </select>
    </div>
    <div id="corpAirtime">${esc(t('common.loading'))}</div>`;
  const rowsEl = host.querySelector('#corpSlotRows');
  const problems = host.querySelector('#corpOnlyProblems');
  async function loadRows() {
    try {
      const { rows } = await api.getSlotReport(problems.checked);
      rowsEl.innerHTML = rows.length ? `<div class="table-wrap"><table class="corp-table">
        <thead><tr><th>${esc(t('corp.where.col_playlist'))}</th><th>${esc(t('corp.slots.col_slot'))}</th><th>${esc(t('corp.slots.col_workspace'))}</th><th>${esc(t('corp.slots.col_state'))}</th><th>${esc(t('corp.slots.col_levels'))}</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${esc(r.playlist_name)}</td><td>${esc(r.slot_name)}</td>
          <td>${esc(r.workspace_name || '')}<div class="corp-help">${esc(t('corp.slots.screens_filled', { n: r.screens_filled, of: r.screens }))}</div></td>
          <td>${cui.chip(stateLabel(r.state), STATE_TONE[r.state] || 'muted')}</td>
          <td>${(r.fills || []).map((f) => `<div>${esc(cui.levelLabel(f.scope_kind, f.scope_name))}: ${esc(tn('corp.n_items', f.items))}, ${esc(cui.formatSec(f.seconds))}${f.fill_state === 'over_limit' ? ' ' + cui.chip(t('corp.slots.over'), 'emergency') : ''}${!f.published ? ' ' + cui.chip(t('corp.status.never'), 'muted') : ''}<span class="corp-help"> · ${esc(when(f.updated_at))}</span></div>`).join('') || '—'}</td>
        </tr>`).join('')}</tbody></table></div>` : `<div class="corp-empty">${esc(problems.checked ? t('corp.slots.no_problems') : t('corp.slots.empty'))}</div>`;
    } catch (e) { rowsEl.innerHTML = `<div class="corp-notice corp-notice-danger">${esc(e.message)}</div>`; }
  }
  problems.addEventListener('change', loadRows);
  host.querySelector('#corpCsv').addEventListener('click', async () => {
    try {
      const blob = await downloadSlotReportCsv(problems.checked);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'store-slots.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) { showToast(e.message, 'error'); }
  });
  const airEl = host.querySelector('#corpAirtime');
  const range = host.querySelector('#corpAirRange');
  async function loadAir() {
    const to = Math.floor(Date.now() / 1000);
    const from = to - Number(range.value) * 86400;
    try {
      const r = await api.getAirtimeReport(from, to);
      const table = (rows, nameKey) => rows.length ? `<div class="table-wrap"><table class="corp-table"><thead><tr><th></th><th>${esc(t('corp.slots.plays'))}</th><th>${esc(t('corp.slots.time'))}</th></tr></thead>
        <tbody>${rows.map((x) => `<tr><td>${esc(x[nameKey] || '')}</td><td>${esc(String(x.plays))}</td><td>${esc(cui.formatSec(x.seconds))}</td></tr>`).join('')}</tbody></table></div>` : `<div class="corp-help">${esc(t('corp.slots.no_plays'))}</div>`;
      airEl.innerHTML = `
        <h4 class="corp-h4">${esc(t('corp.slots.by_workspace'))}</h4>${table(r.workspaces || [], 'workspace_name')}
        <h4 class="corp-h4">${esc(t('corp.slots.by_playlist'))}</h4>${table(r.playlists || [], 'playlist_name')}
        <div class="corp-help">${esc(t('corp.slots.airtime_note'))}</div>`;
    } catch (e) { airEl.innerHTML = `<div class="corp-notice corp-notice-danger">${esc(e.message)}</div>`; }
  }
  range.addEventListener('change', loadAir);
  await Promise.all([loadRows(), loadAir()]);
}

/* ── Emergency alerts (§7.6) ──────────────────────────────────────────────────────────────── */

const REASON_KEY = {
  org_switch_off: 'corp.em.reason.switch_off', listener_off: 'corp.em.reason.listener_off', platform_no_triggers: 'corp.em.reason.platform',
  no_secret: 'corp.em.reason.no_secret', clear_all_collision: 'corp.em.reason.collision', not_synced: 'corp.em.reason.not_synced',
  offline: 'corp.em.reason.offline', disabled: 'corp.em.reason.disabled',
};
const reasonText = (r) => (REASON_KEY[r] ? t(REASON_KEY[r]) : r);

function scopeSummary(scopes) {
  if (!scopes || !scopes.length) return t('corp.em.no_scope');
  return scopes.map((x) => cui.targetLabel(x.scope_kind, x.name || '')).join(', ');
}

// Why an alert would fire and show nothing (GET /api/corporate/emergency target_problem).
const EM_TARGET_PROBLEM = { missing: 'corp.em.target_missing', unpublished: 'corp.em.target_unpublished', empty: 'corp.em.target_empty' };

async function renderEmergencyTab(host, s) {
  if (!s.is_admin) { host.innerHTML = `<div class="corp-notice">${esc(t('corp.err.CORPORATE_EMERGENCY'))}</div>`; return; }
  const r = await api.getEmergencyAlerts();
  const alerts = r.triggers || [];
  host.innerHTML = `
    ${!r.enabled_for_org ? `<div class="corp-notice corp-notice-warn">${esc(t('corp.em.off_banner'))} <a href="#/settings">${esc(t('corp.page.open_settings'))}</a></div>` : ''}
    <div class="corp-panel">
      <h4 class="corp-h4">${esc(t('corp.em.how_title'))}</h4>
      <p class="corp-help">${esc(t('corp.em.how'))}</p>
    </div>
    <div class="corp-toolbar"><button class="btn btn-primary" id="emNew">${esc(t('corp.em.new'))}</button></div>
    ${alerts.length ? `<div class="corp-cards">${alerts.map((a) => {
      const live = a.active_activation;
      const cov = a.coverage || { total: 0, trigger_ready: 0, activate_ready: 0, online: 0 };
      return `
      <div class="corp-card ${live ? 'corp-card-live' : ''}" data-em="${esc(a.id)}">
        <div class="corp-card-head">
          <strong class="corp-card-title">${esc(a.name)}</strong>
          ${live ? cui.chip(t('corp.em.live_left', { left: cui.formatSec(live.remaining_sec) }), 'emergency') : a.enabled ? cui.chip(t('corp.em.active'), 'slot') : cui.chip(t('corp.em.off'), 'muted')}
        </div>
        ${a.target_problem ? `<div class="corp-notice corp-notice-danger">${esc(t(EM_TARGET_PROBLEM[a.target_problem] || 'corp.em.target_missing'))}</div>` : ''}
        <div class="corp-card-meta">${esc(scopeSummary(a.scopes))} · ${esc(a.mode === 'once' ? t('corp.em.mode_once_short') : t('corp.em.mode_until_short'))}</div>
        <div class="corp-card-meta">${esc(t('corp.em.cov_trigger', { r: cov.trigger_ready, t: cov.total }))}</div>
        <div class="corp-card-meta">${esc(t('corp.em.cov_activate', { a: cov.activate_ready, t: cov.total, o: cov.online }))}</div>
        <div class="corp-card-actions">
          ${live ? `<button class="btn btn-danger btn-sm" data-act="end">${esc(t('corp.em.end'))}</button>`
            : `<button class="btn btn-danger btn-sm" data-act="activate" ${r.enabled_for_org && a.enabled ? '' : 'disabled'} title="${esc(!r.enabled_for_org ? t('corp.em.off_banner') : !a.enabled ? t('corp.em.alert_off_tip') : '')}">${esc(t('corp.em.activate'))}</button>`}
          <button class="btn btn-secondary btn-sm" data-act="coverage">${esc(t('corp.em.coverage'))}</button>
          <button class="btn btn-secondary btn-sm" data-act="sheet">${esc(t('corp.em.sheet'))}</button>
          <button class="btn btn-secondary btn-sm" data-act="rotate">${esc(t('corp.em.rotate'))}</button>
          <button class="btn btn-secondary btn-sm" data-act="edit">${esc(t('common.edit'))}</button>
          <button class="btn btn-secondary btn-sm" data-act="delete">${esc(t('common.delete'))}</button>
        </div>
        <div class="corp-em-detail" hidden></div>
      </div>`;
    }).join('')}</div>` : `<div class="corp-empty">${esc(t('corp.em.empty'))}</div>`}`;

  host.querySelector('#emNew').addEventListener('click', () => emergencyEditor(null));
  host.querySelectorAll('[data-em]').forEach((card) => {
    const a = alerts.find((x) => x.id === card.dataset.em);
    const detail = card.querySelector('.corp-em-detail');
    card.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
      const act = b.dataset.act;
      try {
        if (act === 'activate') return activateDialog(a);
        if (act === 'end') {
          if (!await cui.ask({ title: t('corp.em.end'), text: t('corp.em.end_confirm', { name: a.name }), confirmLabel: t('corp.em.end') })) return;
          await api.clearEmergency(a.id); showToast(t('corp.em.ended'), 'success'); reloadTab(); return;
        }
        if (act === 'coverage') { detail.hidden = !detail.hidden; if (!detail.hidden) { detail.innerHTML = esc(t('common.loading')); detail.innerHTML = coverageHtml(await api.getEmergencyCoverage(a.id)); } return; }
        if (act === 'sheet') return installerSheetDialog(a, await api.getInstallerSheet(a.id));
        if (act === 'rotate') {
          if (!await cui.ask({ title: t('corp.em.rotate'), text: t('corp.em.rotate_confirm'), confirmLabel: t('corp.em.rotate') })) return;
          const out = await api.rotateEmergencySecrets(a.id);
          showToast(tn('corp.em.rotated', out.rotated || 0), 'success');
          return installerSheetDialog(a, out);
        }
        if (act === 'edit') return emergencyEditor(a);
        if (act === 'delete') {
          if (!await cui.ask({ title: t('common.delete'), text: t('corp.em.delete_confirm', { name: a.name }), danger: true, confirmLabel: t('common.delete') })) return;
          await api.deleteEmergencyAlert(a.id); showToast(t('corp.em.deleted'), 'success'); reloadTab();
        }
      } catch (e) { showToast(e.message, 'error'); }
    }));
  });
  // "Live now" counts down without a reload, and the tab refreshes when an alert ends on its own.
  if (alerts.some((a) => a.active_activation)) {
    const started = Date.now();
    liveTimer = setInterval(() => {
      const gone = Math.floor((Date.now() - started) / 1000);
      let ended = false;
      host.querySelectorAll('[data-em]').forEach((card) => {
        const a = alerts.find((x) => x.id === card.dataset.em);
        if (!a || !a.active_activation) return;
        const left = a.active_activation.remaining_sec - gone;
        const c = card.querySelector('.corp-chip-emergency');
        if (c) c.textContent = t('corp.em.live_left', { left: cui.formatSec(Math.max(0, left)) });
        if (left <= 0) ended = true;
      });
      if (ended) { stopLiveTimer(); setTimeout(reloadTab, 1500); }
    }, 1000);
  }
}

function coverageHtml(c) {
  if (!c) return '';
  const groups = new Map();
  for (const u of c.unreachable || []) {
    for (const r of (u.reasons || [])) { if (!groups.has(r)) groups.set(r, []); groups.get(r).push(u); }
    for (const r of (u.activate_reasons || []).filter((x) => x === 'offline')) { if (!groups.has(r)) groups.set(r, []); groups.get(r).push(u); }
  }
  const n = new Set((c.unreachable || []).map((u) => u.device_id)).size;
  return `
    <div class="corp-help"><strong>${esc(tn('corp.em.cant_receive', n))}</strong></div>
    ${[...groups.entries()].map(([r, list]) => `
      <details class="corp-details"><summary>${esc(reasonText(r))} (${list.length})</summary>
        <ul class="corp-list">${list.map((u) => `<li>${esc(u.name || '')} <span class="corp-help">${esc(u.workspace || '')}</span></li>`).join('')}</ul>
      </details>`).join('')}`;
}

function installerSheetDialog(a, sheet) {
  const lines = [];
  lines.push(`# ${a.name}`);
  for (const s of sheet.screens || []) {
    lines.push('', `## ${s.workspace || ''} — ${s.screen || ''}`, `LAN IP: ${s.lan_ip || '?'}  HTTP ${s.http_port}  UDP ${s.udp_port}`, `secret: ${s.secret || '(none)'}`);
    for (const l of s.lines || []) lines.push(l.line);
  }
  const text = lines.join('\n');
  const m = cui.openModal({
    title: t('corp.em.sheet'), wide: true,
    body: `<p class="corp-help">${esc(t('corp.em.sheet_help'))}</p>
      <div class="corp-help">${esc(t('corp.em.codes', { fire: sheet.trigger.match_token || '', clear: sheet.trigger.clear_token || '—' }))}</div>
      <div class="table-wrap"><table class="corp-table"><thead><tr><th>${esc(t('corp.slots.col_workspace'))}</th><th>${esc(t('corp.em.col_screen'))}</th><th>${esc(t('corp.em.col_ip'))}</th><th>${esc(t('corp.em.col_ports'))}</th><th>${esc(t('corp.em.col_secret'))}</th></tr></thead>
      <tbody>${(sheet.screens || []).map((s) => `<tr><td>${esc(s.workspace || '')}</td><td>${esc(s.screen || '')}</td><td>${esc(s.lan_ip || '?')}</td><td>${esc(`${s.accept_http ? 'HTTP ' + s.http_port : ''}${s.accept_http && s.accept_udp ? ' · ' : ''}${s.accept_udp ? 'UDP ' + s.udp_port : ''}` || t('corp.em.listener_off_short'))}</td><td><code>${esc(s.secret || '—')}</code></td></tr>`).join('')}</tbody></table></div>
      <textarea class="input corp-code" readonly>${esc(text)}</textarea>`,
    footer: `<button class="btn btn-secondary" data-corp-close>${esc(t('common.close'))}</button><button class="btn btn-primary" id="emSheetDl">${esc(t('corp.em.download'))}</button>`,
  });
  m.q('#emSheetDl').addEventListener('click', () => {
    const a2 = document.createElement('a');
    a2.href = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain' }));
    a2.download = `installer-sheet-${String(a.name).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.txt`;
    document.body.appendChild(a2); a2.click(); a2.remove();
    setTimeout(() => URL.revokeObjectURL(a2.href), 2000);
  });
}

async function activateDialog(a) {
  const cov = a.coverage || { activate_ready: 0 };
  const m = cui.openModal({
    title: t('corp.em.activate'),
    body: `
      <div class="form-group"><label for="emDur">${esc(t('corp.em.duration'))}</label>
        <select id="emDur" class="input">${[1, 2, 5, 10, 15, 30, 45, 60].map((n) => `<option value="${n * 60}" ${n === 10 ? 'selected' : ''}>${esc(tn('corp.minutes', n))}</option>`).join('')}</select></div>
      <div class="form-group"><label for="emNote">${esc(t('corp.em.note'))}</label><input id="emNote" class="input" maxlength="200" style="width:100%"></div>
      <p class="corp-explain" id="emAsk"></p>`,
    footer: `<button class="btn btn-secondary" data-corp-close>${esc(t('common.cancel'))}</button><button class="btn btn-danger" id="emGo">${esc(t('corp.em.activate'))}</button>`,
  });
  const dur = m.q('#emDur');
  const say = () => { m.q('#emAsk').textContent = tn('corp.em.activate_confirm', cov.activate_ready, { name: a.name, duration: tn('corp.minutes', Number(dur.value) / 60) }); };
  dur.addEventListener('change', say);
  say();
  m.q('#emGo').addEventListener('click', async () => {
    try {
      const r = await api.activateEmergency(a.id, Number(dur.value), m.q('#emNote').value.trim() || undefined);
      m.close();
      showToast(t('corp.em.activated', { online: r.reached.online, offline: r.reached.offline_will_get_on_reconnect, not: (r.reached.not_eligible || []).length }), 'success');
      reloadTab();
    } catch (e) { showToast(e.message, 'error'); }
  });
}

async function emergencyEditor(a) {
  let playlists = [];
  let targets = null;
  try { [playlists, targets] = await Promise.all([api.getPlaylists(), api.getCorporateTargets()]); }
  catch (e) { showToast(e.message, 'error'); return; }
  const published = playlists.filter((p) => p.published_snapshot || p.status === 'published');
  const scopes = new Set((a && a.scopes || []).map((x) => `${x.scope_kind}:${x.scope_id}`));
  const mode0 = a ? a.mode : 'until_cleared';
  const scopeBox = (kind, id, label, sub = '') => `<label class="corp-check"><input type="checkbox" data-scope="${esc(kind)}:${esc(id)}" ${scopes.has(`${kind}:${id}`) ? 'checked' : ''}> ${esc(label)}${sub ? ` <span class="corp-help">${esc(sub)}</span>` : ''}</label>`;
  const m = cui.openModal({
    title: a ? t('corp.em.edit', { name: a.name }) : t('corp.em.new'), wide: true,
    body: `
      <div class="corp-grid2">
        <div class="form-group"><label for="emName">${esc(t('corp.form.name'))}</label><input id="emName" class="input" maxlength="80" value="${esc(a ? a.name : '')}"></div>
        <div class="form-group"><label for="emPl">${esc(t('corp.em.playlist'))}</label>
          ${published.length ? `<select id="emPl" class="input">${published.map((p) => `<option value="${esc(p.id)}" ${a && a.target_ref === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`
            : `<div class="corp-help">${esc(t('corp.em.no_playlist'))}</div>`}
          <div class="corp-help">${esc(t('corp.em.playlist_help'))}</div></div>
        <div class="form-group"><label for="emMatch">${esc(t('corp.em.match'))}</label><input id="emMatch" class="input" maxlength="64" value="${esc(a ? a.match_token || '' : '')}" autocomplete="off"></div>
        <div class="form-group"><label for="emClear">${esc(t('corp.em.clear_token'))}</label><input id="emClear" class="input" maxlength="64" value="${esc(a ? a.clear_token || '' : '')}" autocomplete="off"></div>
        <div class="form-group"><label>${esc(t('corp.em.sources'))}</label>
          <label class="corp-check"><input type="checkbox" id="emHttp" ${!a || a.source_http ? 'checked' : ''}> HTTP</label>
          <label class="corp-check"><input type="checkbox" id="emUdp" ${!a || a.source_udp ? 'checked' : ''}> UDP</label></div>
        <div class="form-group"><label for="emMode">${esc(t('corp.em.mode'))}</label>
          <select id="emMode" class="input">
            <option value="until_cleared" ${mode0 === 'until_cleared' ? 'selected' : ''}>${esc(t('corp.em.mode_until_short'))}</option>
            <option value="once" ${mode0 === 'once' ? 'selected' : ''}>${esc(t('corp.em.mode_once_short'))}</option>
          </select>
          <div class="corp-row" id="emLeaseRow"><input id="emLease" class="input" type="number" min="5" max="300" value="${esc(String(a && a.lease_sec ? a.lease_sec : 120))}" style="width:90px"> <span class="corp-help">${esc(t('corp.em.lease_help'))}</span></div>
          <div class="corp-row" id="emMaxRow"><input id="emMax" class="input" type="number" min="60" max="3600" value="${esc(String(a && a.max_duration_sec ? a.max_duration_sec : 600))}" style="width:90px"> <span class="corp-help">${esc(t('corp.em.max_help'))}</span></div>
        </div>
        <div class="form-group"><label for="emPri">${esc(t('corp.em.priority'))}</label><input id="emPri" class="input" type="number" min="0" max="1000" value="${esc(String(a ? a.priority || 0 : 0))}">
          <div class="corp-help">${esc(t('corp.em.priority_help'))}</div></div>
        <div class="form-group"><label class="corp-check"><input type="checkbox" id="emEnabled" ${!a || a.enabled ? 'checked' : ''}> ${esc(t('corp.em.enabled'))}</label></div>
      </div>
      <div class="form-group"><label>${esc(t('corp.em.where'))}</label>
        <div class="corp-scope-box">
          ${scopeBox('org', targets.organization_id, t('corp.where.org'))}
          ${targets.workspaces.map((w) => `
            <details class="corp-details"><summary>${esc(w.name)}</summary>
              ${scopeBox('workspace', w.id, t('corp.level.workspace', { name: w.name }))}
              ${w.groups.map((g) => scopeBox('group', g.id, t('corp.level.group', { name: g.name }))).join('')}
              ${w.devices.map((d) => scopeBox('device', d.id, d.name, d.wall_name ? t('corp.where.wall_member', { name: d.wall_name }) : '')).join('')}
            </details>`).join('')}
        </div>
      </div>`,
    footer: `<button class="btn btn-secondary" data-corp-close>${esc(t('common.cancel'))}</button><button class="btn btn-primary" id="emSave" ${published.length ? '' : 'disabled'}>${esc(t('common.save'))}</button>`,
  });
  const mode = m.q('#emMode');
  const syncMode = () => {
    m.q('#emLeaseRow').hidden = mode.value !== 'until_cleared';
    m.q('#emMaxRow').hidden = mode.value !== 'once';
  };
  mode.addEventListener('change', syncMode);
  syncMode();
  m.q('#emSave').addEventListener('click', async () => {
    const until = mode.value === 'until_cleared';
    const body = {
      name: m.q('#emName').value.trim(), target_kind: 'playlist', target_ref: m.q('#emPl') ? m.q('#emPl').value : null,
      match_token: m.q('#emMatch').value.trim(), clear_token: m.q('#emClear').value.trim() || null,
      source_http: m.q('#emHttp').checked, source_udp: m.q('#emUdp').checked, mode: mode.value,
      lease_sec: until ? Number(m.q('#emLease').value) : null,
      max_duration_sec: until ? null : Number(m.q('#emMax').value),
      priority: Number(m.q('#emPri').value) || 0, enabled: m.q('#emEnabled').checked,
      scopes: [...m.overlay.querySelectorAll('[data-scope]:checked')].map((cb) => {
        const [scope_kind, ...rest] = cb.dataset.scope.split(':');
        return { scope_kind, scope_id: rest.join(':') };
      }),
    };
    try {
      if (a) await api.updateEmergencyAlert(a.id, body); else await api.createEmergencyAlert(body);
      m.close(); showToast(t('corp.em.saved'), 'success'); reloadTab();
    } catch (e) { showToast(e.message, 'error'); }
  });
}

/* ════════════════════════════════════════════════════════════════════════ store face (§7.7) */

async function renderStore(container, s) {
  let data;
  try { data = await api.getCorporateStore(); } catch (e) {
    container.innerHTML = pageShell(t('nav.head_office'), `<div class="corp-notice corp-notice-danger">${esc(e.message)}</div>`);
    return;
  }
  const mandates = data.mandates || [];
  if (!mandates.length) {
    container.innerHTML = pageShell(t('nav.head_office'), `<div class="corp-empty">${esc(t('corp.store.none'))}</div>`);
    return;
  }
  const notices = [];
  const weekAgo = Date.now() / 1000 - 7 * 86400;
  for (const p of mandates) {
    if (p.since && p.since > weekAgo) {
      notices.push(p.dark ? t('corp.store.notice_dark', { n: p.screens, date: when(p.since) })
        : t('corp.store.notice_new', { name: p.playlist_name || '', n: p.screens, date: when(p.since), k: data.paused_schedules || 0 }));
    }
  }
  const slotNotices = [];
  for (const sl of data.slots || []) {
    for (const f of sl.fills || []) {
      if (f.fill_state !== 'over_limit') continue;
      const lim = sl.limits || {};
      const k = lim.max_items != null ? f.items - lim.max_items : 0;
      slotNotices.push({
        fill: f,
        text: k > 0 ? tn('corp.store.notice_limit', lim.max_items, { slot: sl.name, k })
          : t('corp.store.notice_over_sec', { slot: sl.name, level: cui.levelLabel(f.scope_kind, f.scope_name), max: lim.max_total_sec || 0, sec: f.seconds }),
      });
    }
  }
  container.innerHTML = pageShell(t('nav.head_office'), `
    ${notices.map((n) => `<div class="corp-notice">${esc(n)}</div>`).join('')}
    ${slotNotices.map((n) => `<div class="corp-notice corp-notice-danger">${esc(n.text)} <a class="btn btn-secondary btn-sm" href="#/playlists/${esc(n.fill.fill_playlist_id)}">${esc(t('corp.store.fix'))}</a></div>`).join('')}
    <h3 class="corp-h3">${esc(t('corp.store.heading'))}</h3>
    ${mandates.map((p) => `
      <div class="corp-card">
        <div class="corp-card-head">
          <strong class="corp-card-title">${esc(p.dark ? t('corp.badge.dark') : p.playlist_name || '')}</strong>
          ${cui.chip(t('corp.store.set_by'), 'hq', t('corp.tip.locked'), { lock: true })}
        </div>
        <div class="corp-card-meta">${esc(tn('corp.store.on_screens', p.screens))}</div>
        ${(p.items || []).length ? `<div class="corp-strip">${p.items.map((it) => `<span class="corp-strip-item" title="${esc(it.filename || '')}">${cui.LOCK_SVG}${esc(it.filename || t('common.unknown'))}</span>`).join('')}</div>` : ''}
      </div>`).join('')}
    <h3 class="corp-h3">${esc(t('corp.store.slots'))}</h3>
    ${(data.slots || []).length ? (data.slots || []).map((sl) => slotCardHtml(sl, data.workspace_id)).join('') : `<div class="corp-empty">${esc(t('corp.store.no_slots'))}</div>`}
    <p class="corp-help">${esc(t('corp.store.can_still'))}</p>`);
  hydrateAuthImages(container);

  container.querySelectorAll('[data-fill-slot]').forEach((b) => b.addEventListener('click', () => {
    const sl = data.slots.find((x) => x.id === b.dataset.fillSlot);
    fillLevelDialog(sl, data.workspace_id);
  }));
  container.querySelectorAll('[data-unfill]').forEach((b) => b.addEventListener('click', async () => {
    const sl = data.slots.find((x) => x.id === b.dataset.slot);
    const f = sl.fills.find((x) => x.id === b.dataset.unfill);
    const ok = await cui.ask({
      title: t('corp.slot.remove_level'), confirmLabel: t('corp.slot.remove_level'), danger: true,
      text: tn('corp.slot.remove_level_confirm', f.screens || 0, { level: cui.levelLabel(f.scope_kind, f.scope_name) }),
    });
    if (!ok) return;
    try { await api.deleteFill(f.id); showToast(t('corp.slot.level_removed'), 'success'); render(container); }
    catch (e) { showToast(e.message, 'error'); }
  }));
}

function slotCardHtml(sl, wsId) {
  const fills = sl.fills || [];
  const lim = sl.limits || {};
  return `
    <div class="corp-card corp-slot-card">
      <div class="corp-card-head">
        <strong class="corp-card-title">${esc(t('corp.store.slot_title', { slot: sl.name }))}</strong>
        ${cui.chip(t('corp.badge.your_slot'), 'slot', t('corp.tip.your_slot', { slot: sl.name, playlist: sl.playlist_name || '' }))}
      </div>
      <div class="corp-card-meta">${esc(t('corp.store.in_playlist', { playlist: sl.playlist_name || '' }))} · ${esc(cui.limitsText(lim))}${lim.allow_video === 0 || lim.allow_video === false ? ' · ' + esc(t('corp.slot.no_video')) : ''}${lim.allow_widgets === 0 || lim.allow_widgets === false ? ' · ' + esc(t('corp.slot.no_widgets')) : ''}</div>
      ${sl.help_text ? `<div class="corp-hq-note">${esc(t('corp.store.hq_says'))} ${esc(sl.help_text)}</div>` : ''}
      ${fills.length ? `<ul class="corp-levels">${fills.map((f) => `
        <li>
          <span class="corp-level-name">${esc(cui.levelLabel(f.scope_kind, f.scope_name))}</span>
          <span class="corp-help">${esc(tn('corp.n_items', f.items))} · ${esc(cui.formatSec(f.seconds))} · ${esc(tn('corp.n_screens', f.screens))}</span>
          ${f.fill_state === 'over_limit' ? cui.chip(t('corp.slots.over'), 'emergency', t('corp.slot.over_limit')) : ''}
          ${f.status === 'draft' ? cui.chip(f.published ? t('corp.status.changes') : t('corp.status.never'), 'muted') : ''}
          <a class="btn btn-secondary btn-sm" href="#/playlists/${esc(f.fill_playlist_id)}">${esc(t('common.edit'))}</a>
          ${f.scope_kind !== 'workspace' || f.workspace_id === wsId ? `<button class="btn btn-secondary btn-sm" data-unfill="${esc(f.id)}" data-slot="${esc(sl.id)}">${esc(t('corp.slot.remove_level'))}</button>` : ''}
        </li>`).join('')}</ul>`
        : `<div class="corp-help">${esc(sl.fallback ? t('corp.store.empty_slot_fallback', { fallback: sl.fallback.name || '' }) : t('corp.store.empty_slot_skip'))}</div>`}
      <div class="corp-card-actions"><button class="btn btn-primary btn-sm" data-fill-slot="${esc(sl.id)}">${esc(fills.length ? t('corp.slot.add_level') : t('corp.slot.fill'))}</button></div>
    </div>`;
}

/** "Fill this slot" → choose the level ("Everyone in {workspace}" first), then open the slot editor. */
async function fillLevelDialog(sl, wsId) {
  let groups = [];
  let walls = [];
  let devices = [];
  try { [groups, walls, devices] = await Promise.all([api.getGroups(), api.getWalls().catch(() => []), api.getDevices()]); }
  catch (e) { showToast(e.message, 'error'); return; }
  const cov = await cui.workspaceCoverage();
  const taken = new Set((sl.fills || []).map((f) => `${f.scope_kind}:${f.scope_id}`));
  const ws = (() => { try { const me = JSON.parse(localStorage.getItem('user') || 'null'); return (me.accessible_workspaces || []).find((w) => w.id === wsId) || { name: '' }; } catch { return { name: '' }; } })();
  const opt = (kind, id, label) => `<option value="${esc(kind)}:${esc(id)}" ${taken.has(`${kind}:${id}`) ? 'disabled' : ''}>${esc(label)}${taken.has(`${kind}:${id}`) ? ' — ' + esc(t('corp.slot.has_content')) : ''}</option>`;
  const mandatedDevices = devices.filter((d) => cov.devices[d.id] && !d.wall_id);
  const m = cui.openModal({
    title: t('corp.slot.fill_title', { slot: sl.name }),
    body: `
      <div class="form-group"><label for="flLevel">${esc(t('corp.slot.which_level'))}</label>
        <select id="flLevel" class="input" style="width:100%">
          ${opt('workspace', wsId, t('corp.level.workspace', { name: ws.name || '' }))}
          ${groups.length ? `<optgroup label="${esc(t('corp.kind.group'))}">${groups.map((g) => opt('group', g.id, t('corp.level.group', { name: g.name }))).join('')}</optgroup>` : ''}
          ${walls.length ? `<optgroup label="${esc(t('corp.kind.wall'))}">${walls.map((w) => opt('wall', w.id, t('corp.level.wall', { name: w.name }))).join('')}</optgroup>` : ''}
          ${mandatedDevices.length ? `<optgroup label="${esc(t('corp.kind.device'))}">${mandatedDevices.map((d) => opt('device', d.id, t('corp.level.named_screen', { name: d.name }))).join('')}</optgroup>` : ''}
        </select>
        <div class="corp-help">${esc(t('corp.slot.level_help'))}</div>
      </div>`,
    footer: `<button class="btn btn-secondary" data-corp-close>${esc(t('common.cancel'))}</button><button class="btn btn-primary" id="flGo">${esc(t('corp.slot.open_editor'))}</button>`,
  });
  m.q('#flGo').addEventListener('click', async () => {
    const [scope_kind, ...rest] = m.q('#flLevel').value.split(':');
    try {
      const f = await api.createFill(sl.id, { scope_kind, scope_id: rest.join(':') });
      m.close();
      window.location.hash = `#/playlists/${f.fill_playlist_id}`;
    } catch (e) {
      // Already has content at that level: open it rather than leave the person at an error.
      if (e.code === 'CORPORATE_FILL_EXISTS' && e.body && e.body.fill) { m.close(); window.location.hash = `#/playlists/${e.body.fill.fill_playlist_id}`; return; }
      showToast(e.message, 'error');
    }
  });
}
