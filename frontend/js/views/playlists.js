import { api } from '../api.js';
import * as gettingStarted from '../components/getting-started.js';
import { showToast } from '../components/toast.js';
import { esc, hydrateAuthImages } from '../utils.js';
import { openContentPicker } from '../components/content-picker.js';
import { t, tn } from '../i18n.js';
import { frameDeviceOutput, displayAspectRatio } from '../lib/device-frame.js';
import { renderApprovalBar } from '../components/approval-actions.js';
import { openSmartRulesModal, rulesSummary, loadFolders, DEFAULT_RULES } from '../components/smart-rules.js';
import * as cui from '../components/corporate-ui.js';
import { openSlotDialog } from '../components/corporate-slot-dialog.js';

function formatDate(ts) {
  if (!ts) return '--';
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function getTypeIcon(item) {
  if (item.widget_id) return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="8" height="8" rx="1"/><rect x="14" y="2" width="8" height="8" rx="1"/><rect x="2" y="14" width="8" height="8" rx="1"/><rect x="14" y="14" width="8" height="8" rx="1"/></svg>';
  if (item.mime_type && item.mime_type.startsWith('video/')) return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
  return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
}

// #74/#75 per-item schedule editor helpers. Client validation MIRRORS the server
// (server/routes/playlists.js validateBlocks): same time/date regexes, non-empty days.
const SCHED_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const SCHED_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function daysSummary(days) {
  const labels = t('itemsched.dow_short').split(',');
  const s = [...days].sort((a, b) => a - b);
  if (s.length === 7) return t('itemsched.every_day');
  if (s.length === 5 && [1, 2, 3, 4, 5].every(d => s.includes(d))) return t('itemsched.mon_fri');
  if (s.length === 2 && s.includes(0) && s.includes(6)) return t('itemsched.sat_sun');
  return s.map(d => labels[d]).join(' ');
}
function blockSummary(b) {
  let s = `${daysSummary(b.days)} ${b.start}-${b.end}`;
  if (b.start_date || b.end_date) s += ` · ${b.start_date || '…'}→${b.end_date || '…'}`;
  return s;
}
function scheduleSummary(schedules) {
  if (!schedules || !schedules.length) return '';
  return schedules.length === 1 ? blockSummary(schedules[0]) : `${blockSummary(schedules[0])} +${schedules.length - 1}`;
}
function windowSummary(item) {
  if (!item || (!item.play_from && !item.play_until)) return '';
  return `${item.play_from || '…'} → ${item.play_until || '…'}`;
}
function validateScheduleBlocks(blocks) {
  for (const b of blocks) {
    if (!b.days || !b.days.length) return t('itemsched.err.days');
    if (!SCHED_TIME_RE.test(b.start)) return t('itemsched.err.start');
    if (!(SCHED_TIME_RE.test(b.end) || b.end === '24:00')) return t('itemsched.err.end');
    // A zero-length window (start == end) never plays; reject it (start > end is a valid overnight window).
    if (b.start === b.end) return t('itemsched.err.same');
    if (b.start_date && !SCHED_DATE_RE.test(b.start_date)) return t('itemsched.err.start_date');
    if (b.end_date && !SCHED_DATE_RE.test(b.end_date)) return t('itemsched.err.end_date');
  }
  return null;
}

let currentPlaylistId = null;
let currentPlaybackOrder = 'sequential';
// #319: the items exactly as last rendered. Sorting needs the list the operator is looking at, and
// every path that changes it already funnels through renderItems, so that is where it is kept.
let currentPlaylistItems = [];
/*
 * Head office (corporate) editor state, or null for an ordinary playlist (docs/corporate-playlists.md):
 *   { mode: 'corporate', playlistId, slots: Map<slotId, slotView>, canAuthor, screens }
 *   { mode: 'fill', playlistId, slot (slotView), fill (fill view), limits, preview }
 * 'corporate' is head office's own playlist: slot rows render as slots, only authors edit it.
 * 'fill' is a store's content for one local slot: limits, meters, no nesting / repeat / order.
 */
let corpEditor = null;
let selectedItemIds = new Set();
let selectAnchorId = null;
const CLIP_KEY = 'st.playlistClipboard';

export function render(container) {
  const hash = window.location.hash;
  const match = hash.match(/#\/playlists\/(.+)/);
  if (match) {
    currentPlaylistId = match[1];
    renderDetail(container, match[1]);
  } else {
    currentPlaylistId = null;
    renderList(container);
  }
}

export function cleanup() {
  currentPlaylistId = null;
  corpEditor = null;
}

// Deliberately default-ON (commit aca1558): per-device "<Device> playlist" rows and every
// playlist migrated from a legacy DB carry is_auto_generated=1, and those are the playlists
// screens actually play — defaulting off strands operators on an "all auto-generated"
// placeholder. Persisted across reloads like the other rd_* UI prefs.
let showAutoGenerated = true;
try {
  const stored = localStorage.getItem('rd_show_auto_playlists');
  if (stored !== null) showAutoGenerated = stored !== '0';
} catch {}
// Last fetched page, so flipping the toggle filters client-side instead of re-fetching
// GET /playlists for data already in hand.
let cachedPlaylists = null;

async function renderList(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>${t('playlist.title')} <span class="help-tip" data-tip="${t('playlist.help_tip')}">?</span></h1>
        <div class="subtitle">${t('playlist.subtitle')}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-secondary);cursor:pointer">
          <input type="checkbox" id="showAutoToggle" ${showAutoGenerated ? 'checked' : ''}>
          ${t('playlist.show_auto_generated')}
        </label>
        <button class="btn btn-primary" id="createPlaylistBtn">${t('playlist.new_playlist_btn')}</button>
      </div>
    </div>
    <!-- Same reason as the Content Library: the step that sent you here has to still be here. -->
    <div id="gettingStarted"></div>
    <div id="playlistGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px">
      <div style="color:var(--text-muted);padding:40px;text-align:center">${t('common.loading')}</div>
    </div>
  `;

  document.getElementById('createPlaylistBtn').addEventListener('click', () => showCreateModal());
  document.getElementById('showAutoToggle').addEventListener('change', (e) => {
    showAutoGenerated = e.target.checked;
    try { localStorage.setItem('rd_show_auto_playlists', showAutoGenerated ? '1' : '0'); } catch {}
    if (cachedPlaylists) renderPlaylistGrid(cachedPlaylists);
    else loadPlaylists();
  });
  /*
   * The checklist, if this account still has one. Fire-and-forget so the grid never waits on it.
   *
   * ⚠️ onAction IS NOT OPTIONAL HERE. Step 3 points at this page, so its button would otherwise
   * fall through to `location.hash = '#/playlists'` — which does nothing when you are already on
   * /playlists. Reported as "it just sits there doing nothing" while the New Playlist button at
   * the top worked. Same modal, same function, one entry point.
   */
  gettingStarted.mount(document.getElementById('gettingStarted'), {
    onAction: (a) => {
      if (a === 'new-playlist') { showCreateModal(); return true; }
      return false;
    },
  }).catch(() => {});
  loadPlaylists();
}

async function loadPlaylists() {
  try {
    cachedPlaylists = await api.getPlaylists();
    renderPlaylistGrid(cachedPlaylists);
  } catch (err) {
    const grid = document.getElementById('playlistGrid');
    if (grid) grid.innerHTML = `<div style="grid-column:1/-1;color:var(--text-muted);padding:40px;text-align:center">${t('playlist.load_failed', { error: esc(err.message) })}</div>`;
  }

  // #313/checklist: creating a playlist ticks a step, and every create reloads this list.
  gettingStarted.refresh().catch(() => {});
}

function renderPlaylistGrid(playlists) {
  const grid = document.getElementById('playlistGrid');
  if (!grid) return;

  if (!playlists.length) {
    grid.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--text-muted)">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin:0 auto 16px;display:block;opacity:0.4">
          <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
          <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
        </svg>
        <h3 style="margin-bottom:8px;color:var(--text-primary)">${t('playlist.empty_title')}</h3>
        <p>${t('playlist.empty_desc')}</p>
      </div>
    `;
    return;
  }

  const filtered = showAutoGenerated ? playlists : playlists.filter(p => !p.is_auto_generated);
  if (!filtered.length) {
    grid.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-muted)">
        ${playlists.length ? t('playlist.all_auto_generated') : ''}
      </div>
    `;
    return;
  }

    grid.innerHTML = filtered.map(p => `
      <a href="#/playlists/${esc(p.id)}" class="playlist-card" style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:20px;text-decoration:none;color:inherit;display:block;transition:border-color 0.15s;cursor:pointer">
        <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:12px">
          <div style="display:flex;align-items:center;gap:8px">
            <div style="font-size:16px;font-weight:600;color:var(--text-primary)">${esc(p.name)}</div>
            ${p.is_auto_generated ? `<span style="font-size:10px;padding:2px 6px;border-radius:4px;background:var(--bg-input);color:var(--text-muted)">${t('playlist.tag_auto')}</span>` : ''}
            ${p.status === 'draft' ? `<span style="font-size:10px;padding:2px 6px;border-radius:4px;background:#78350f;color:#fbbf24">${t('playlist.tag_draft')}</span>` : ''}
            ${p.smart_rules ? `<span title="${esc(t('smart.badge_tip'))}" style="font-size:10px;padding:2px 6px;border-radius:4px;background:#312e81;color:#c7d2fe">✦ ${t('smart.badge')}</span>` : ''}
            ${/* ⚠️ The lock. Shown BEFORE anyone tries to delete it, because deletion is refused
                  while it is nested and an unexplained refusal is worse than a visible constraint.
                  BrightSign's pattern; the one thing Appspace conspicuously lacks. */ ''}
            ${p.used_by_count ? `<span title="${esc(tn('playlist.used_by_tip', p.used_by_count))}" style="font-size:10px;padding:2px 6px;border-radius:4px;background:#1e3a2f;color:#6ee7b7">🔒 ${esc(tn('playlist.used_by', p.used_by_count))}</span>` : ''}
            ${p.has_children ? `<span title="${esc(t('playlist.contains_tip'))}" style="font-size:10px;padding:2px 6px;border-radius:4px;background:var(--bg-input);color:var(--text-muted)">☰ ${t('playlist.tag_nested')}</span>` : ''}
            ${p.corporate ? cui.chip(t('corp.badge.corporate'), 'hq', t('corp.tip.corporate'), { lock: true }) : ''}
            ${p.corporate_slot ? cui.chip(t('corp.badge.your_slot'), 'slot', t('corp.tip.your_slot', { slot: p.corporate_slot.slot_name || '', playlist: p.corporate_slot.playlist_name || '' })) : ''}
          </div>
          <div style="font-size:12px;color:var(--text-muted);white-space:nowrap;margin-left:12px">${p.smart_rules ? t('smart.by_rules') : tn('playlist.item_count', p.item_count)}</div>
        </div>
        ${p.description ? `<div style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;line-height:1.4">${esc(p.description)}</div>` : ''}
        <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted)">
          <span>${t('playlist.created_at', { date: formatDate(p.created_at) })}</span>
          ${p.display_count ? `<span>${tn('playlist.display_count', p.display_count)}</span>` : ''}
          ${/* ⚠️ "Paused", not "Not used": head office's playlist plays where this one would, and the
                store must not delete it thinking nothing needs it (critique R13). */ ''}
          ${!p.display_count && p.paused_count ? `<span title="${esc(t('corp.tip.paused'))}" style="color:var(--warning)">${esc(tn('corp.badge.paused', p.paused_count))}</span>` : ''}
        </div>
      </a>
    `).join('');
}

function showCreateModal(prefill = {}) {
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000';
  modal.innerHTML = `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;width:400px;max-width:90vw">
      <h3 style="margin-bottom:16px;color:var(--text-primary)">${t('playlist.new_playlist')}</h3>
      <input type="text" id="newPlaylistName" class="input" placeholder="${t('playlist.name_placeholder')}" style="width:100%;margin-bottom:12px" autofocus>
      <textarea id="newPlaylistDesc" class="input" placeholder="${t('playlist.desc_placeholder')}" style="width:100%;height:60px;resize:vertical;margin-bottom:12px"></textarea>
      <label style="display:flex;gap:8px;align-items:flex-start;font-size:13px;color:var(--text-secondary);margin-bottom:16px;cursor:pointer">
        <input type="checkbox" id="newPlaylistSmart" style="margin-top:3px">
        <span><strong style="color:var(--text-primary)">${t('smart.create_label')}</strong><br>${t('smart.create_hint')}</span>
      </label>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-secondary" id="cancelCreateBtn">${t('common.cancel')}</button>
        <button class="btn btn-primary" id="confirmCreateBtn">${t('playlist.create_btn')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const nameInput = document.getElementById('newPlaylistName');
  // Back from the rules step (Cancel there) the operator's typing is restored, not thrown away.
  if (prefill.name) nameInput.value = prefill.name;
  if (prefill.desc) document.getElementById('newPlaylistDesc').value = prefill.desc;
  if (prefill.smart) document.getElementById('newPlaylistSmart').checked = true;
  nameInput.focus();

  document.getElementById('cancelCreateBtn').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  async function doCreate() {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    const desc = document.getElementById('newPlaylistDesc').value.trim();
    // A smart playlist is born with its rules: pick them first, create on save.
    if (document.getElementById('newPlaylistSmart').checked) {
      modal.remove();
      openSmartRulesModal({
        title: t('smart.title_new', { name }),
        initial: DEFAULT_RULES,
        saveLabel: t('playlist.create_btn'),
        onCancel: () => showCreateModal({ name, desc, smart: true }),
        onSave: async (rules) => {
          const pl = await api.createPlaylist(name, desc, rules);
          showToast(t('playlist.toast.created'));
          window.location.hash = `#/playlists/${pl.id}`;
        },
      });
      return;
    }
    try {
      const pl = await api.createPlaylist(name, desc);
      modal.remove();
      showToast(t('playlist.toast.created'));
      window.location.hash = `#/playlists/${pl.id}`;
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  document.getElementById('confirmCreateBtn').addEventListener('click', doCreate);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doCreate(); });
}

async function renderDetail(container, playlistId) {
  container.innerHTML = `
    <div style="color:var(--text-muted);padding:40px;text-align:center">${t('common.loading')}</div>
  `;

  try {
    const playlist = await api.getPlaylist(playlistId);
    renderDetailContent(container, playlist);
  } catch (err) {
    container.innerHTML = `
      <div style="padding:40px;text-align:center;color:var(--text-muted)">
        <p>${t('playlist.load_failed', { error: esc(err.message) })}</p>
        <a href="#/playlists" class="btn btn-secondary" style="margin-top:16px">${t('playlist.back_to_playlists')}</a>
      </div>
    `;
  }
}

// #104: draft preview by REUSING the player. Iframes /player in device-free preview
// mode (same-origin -> dashboard CSP frame-src 'self' allows it). The player fetches
// /api/playlists/:id/preview-payload and renders with its unmodified renderer, so the
// preview is byte-identical to what a device shows. Orientation toggle just reloads
// the iframe with &orientation; the server passes it through.
// #238: Portrait here had the same fault as the device preview — the iframe was given the
// as-displayed 9/16 shape AND the player rotated inside it, so the portrait toggle showed sideways
// content. The stage is the panel's face; the iframe is its landscape framebuffer, turned back by
// the stand-in for the wall mount.
function showPlaylistPreview(playlist) {
  let orientation = 'landscape';
  const aspect = () => displayAspectRatio(orientation);
  const frameSrc = () => `/player?preview=1&playlist=${encodeURIComponent(playlist.id)}&orientation=${orientation}&t=${Date.now()}`;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:10000;padding:16px';
  overlay.innerHTML = `
    <div style="background:var(--bg-card);border-radius:8px;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--border);max-width:95vw;max-height:92vh">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid var(--border);gap:12px">
        <strong style="color:var(--text-primary)">${t('widget.preview')} — ${esc(playlist.name)}</strong>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-primary btn-sm" id="pvpLandscape">${t('device.form.orientation.landscape')}</button>
          <button class="btn btn-secondary btn-sm" id="pvpPortrait">${t('device.form.orientation.portrait')}</button>
          <button class="btn btn-secondary btn-sm" id="pvpClose">${t('widget.close')}</button>
        </div>
      </div>
      <div style="padding:16px;display:flex;align-items:center;justify-content:center;background:#000">
          <!-- The stage is the sized box; the frame inside it is rotated to the panel's own shape
               (#238), so a portrait preview is no longer the double rotation it used to be.
               72vh rather than 78: the modal caps at 92vh with overflow:hidden, and the header plus
               the transport row cost ~12vh — at 78 the skip buttons fell off the bottom. -->
          <div id="pvpStage" style="height:72vh;max-width:92vw;aspect-ratio:${aspect()};background:#000">
            <iframe id="pvpFrame" style="border:0;background:#000" src="${frameSrc()}"></iframe>
          </div>
        </div>
        <div style="display:flex;justify-content:center;align-items:center;gap:12px;padding:10px 16px;border-top:1px solid var(--border)">
          <button class="btn btn-secondary btn-sm" id="pvpPrev" disabled>&#8249; ${t('playlist.preview_prev')}</button>
          <span id="pvpPosition" style="color:var(--text-muted);font-size:13px;min-width:110px;text-align:center">&nbsp;</span>
          <button class="btn btn-secondary btn-sm" id="pvpNext" disabled>${t('playlist.preview_next')} &#8250;</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const stage = overlay.querySelector('#pvpStage');
  const frame = overlay.querySelector('#pvpFrame');
  frameDeviceOutput(stage, frame, orientation);
  const btnL = overlay.querySelector('#pvpLandscape');
  const btnP = overlay.querySelector('#pvpPortrait');
  const btnPrev = overlay.querySelector('#pvpPrev');
  const btnNext = overlay.querySelector('#pvpNext');
  const position = overlay.querySelector('#pvpPosition');

  // #239: skip/next. The preview already IS the real player in device-free preview mode, so the
  // control is a message to that one iframe rather than a second copy of the playback logic.
  // Addressing frame.contentWindow (not a broadcast) and pinning targetOrigin to our own origin is
  // what keeps this off any real screen: a live display holds a socket to the server and is not
  // reachable from this page at all, and the preview player itself ignores the message unless it
  // booted with ?preview=1.
  const send = (action) => {
    try { frame.contentWindow?.postMessage({ source: 'screentinker-preview', action }, window.location.origin); } catch (e) {}
  };
  const onPlayerMessage = (ev) => {
    if (ev.origin !== window.location.origin) return;
    if (ev.source !== frame.contentWindow) return;   // ignore any other frame on the page
    const d = ev.data;
    if (!d || d.source !== 'screentinker-player' || d.type !== 'preview:state') return;
    // A multi-zone playlist plays all zones at once, so there is no single item to step through —
    // showing a counter there would be a lie and the buttons would appear dead.
    if (d.zoned || !d.total) {
      btnPrev.disabled = btnNext.disabled = true;
      position.textContent = d.zoned ? t('playlist.preview_zoned') : '';
      return;
    }
    btnPrev.disabled = btnNext.disabled = false;
    position.textContent = t('playlist.preview_position', { current: (d.index >= 0 ? d.index : 0) + 1, total: d.total });
  };
  window.addEventListener('message', onPlayerMessage);
  // The player posts its state as soon as it has content, but an orientation reload restarts it —
  // ask again on every load so the counter can never be left stale from the previous run.
  frame.addEventListener('load', () => send('sync'));

  const setOrientation = (o) => {
    orientation = o;
      // The stage carries the aspect; the frame is rotated inside it (#238).
      stage.style.aspectRatio = aspect();
      frameDeviceOutput(stage, frame, orientation);
      btnPrev.disabled = btnNext.disabled = true;   // reloading: no item until the player says so
      position.textContent = '';
    frame.src = frameSrc();
    btnL.className = 'btn btn-sm ' + (o === 'landscape' ? 'btn-primary' : 'btn-secondary');
    btnP.className = 'btn btn-sm ' + (o.startsWith('portrait') ? 'btn-primary' : 'btn-secondary');
  };
  btnL.onclick = () => setOrientation('landscape');
  btnP.onclick = () => setOrientation('portrait');
  btnPrev.onclick = () => send('prev');
  btnNext.onclick = () => send('next');
  // Listeners are on window/document, so they outlive the overlay unless close() takes them with
  // it — a leaked keydown handler would keep firing at a closed preview.
  const close = () => {
    overlay.remove();
    window.removeEventListener('message', onPlayerMessage);
    document.removeEventListener('keydown', onKey);
  };
  function onKey(ev) {
    if (ev.key === 'Escape') close();
    else if (ev.key === 'ArrowRight') send('next');
    else if (ev.key === 'ArrowLeft') send('prev');
  }
  overlay.querySelector('#pvpClose').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', onKey);
}

/*
 * A small picture of where this playlist's content actually lands.
 *
 * A playlist has no intrinsic layout — the server derives one from the items' own zone bindings
 * (#104) — so the page could previously show an item tagged "Bottom Ticker" with no indication
 * that the ticker is a thin strip along the bottom. People assigned content to zones by name and
 * found out where it went by looking at a screen.
 *
 * Drawn from the zone percentages, so it is correct for any layout including portrait ones without
 * a stored thumbnail. Zones with no items are dimmed: an empty zone on a real panel shows its
 * background colour, and that is worth seeing BEFORE publishing rather than after.
 */
function layoutMockup(playlist) {
  const layout = playlist && playlist.layout;
  const items = (playlist && playlist.items) || [];

  // No layout means fullscreen — every item shares one frame. Drawing a single empty box would
  // imply a choice was made; say it in words instead.
  if (!layout || !Array.isArray(layout.zones) || layout.zones.length === 0) {
    return `<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">${t('playlist.layout_fullscreen')}</div>`;
  }

  const counts = {};
  for (const it of items) if (it.zone_id) counts[it.zone_id] = (counts[it.zone_id] || 0) + 1;

  const w = Number(layout.width) || 1920;
  const h = Number(layout.height) || 1080;
  const portrait = h > w;
  // Fixed short edge, long edge derived — a portrait mockup must not be as wide as a landscape one
  // or it dominates the page.
  const boxW = portrait ? 90 : 200;
  const boxH = Math.round(boxW * (h / w));

  const zones = layout.zones.map((z) => {
    const n = counts[z.id] || 0;
    const filled = n > 0;
    return `<div title="${esc(z.name)}${filled ? ` — ${n}` : ''}" style="
      position:absolute;
      left:${z.x_percent}%; top:${z.y_percent}%;
      width:${z.width_percent}%; height:${z.height_percent}%;
      box-sizing:border-box;
      border:1px solid ${filled ? 'var(--accent)' : 'var(--border)'};
      background:${filled ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : 'transparent'};
      display:flex;align-items:center;justify-content:center;
      font-size:9px;line-height:1;color:var(--text-muted);overflow:hidden;
    ">${filled ? n : ''}</div>`;
  }).join('');

  return `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      <div style="position:relative;width:${boxW}px;height:${boxH}px;background:var(--bg-primary);border:1px solid var(--border);border-radius:4px;flex:none">
        ${zones}
      </div>
      <div style="font-size:12px;color:var(--text-muted)">
        <div>${esc(layout.name || '')} &middot; ${w}&times;${h}${portrait ? ' (portrait)' : ''}</div>
        <div>${tn('playlist.zones_count', layout.zones.length)}</div>
        ${layout._preview_ambiguous ? `<div style="color:var(--warning)">${t('playlist.layout_ambiguous')}</div>` : ''}
      </div>
    </div>`;
}

function renderDetailContent(container, playlist) {
  const isDraft = playlist.status === 'draft';
  const hasPublished = !!playlist.published_snapshot;
  currentPlaybackOrder = playlist.playback_order || 'sequential';
  // Head office: keep what the last render learnt about this playlist's slots, so a re-render after
  // every edit does not flash slot rows back to their bare form while the details reload.
  const corpMode = playlist.corporate ? 'corporate' : playlist.corporate_slot ? 'fill' : null;
  const prev = corpEditor && corpEditor.playlistId === playlist.id ? corpEditor : null;
  corpEditor = corpMode ? { ...(prev || {}), mode: corpMode, playlistId: playlist.id, slots: (prev && prev.slots) || new Map() } : null;

  container.innerHTML = `
    ${isDraft ? `
    <div id="draftBanner" style="position:sticky;top:0;z-index:50;background:#78350f;border:1px solid #92400e;border-radius:var(--radius-lg);padding:14px 20px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:16px;box-shadow:0 6px 16px rgba(0,0,0,0.4)">
      <div style="display:flex;align-items:center;gap:10px;color:#fbbf24">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <div>
          <div style="font-weight:600;font-size:14px">${t('playlist.draft.banner_title')}</div>
          <div style="font-size:12px;color:#fcd34d;opacity:0.85">${hasPublished ? t('playlist.draft.devices_showing_published') : corpMode === 'fill' ? t('corp.fill.never_published') : t('playlist.draft.never_published')}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0">
        ${hasPublished ? `<button class="btn btn-secondary btn-sm" id="discardDraftBtn" style="color:#fbbf24;border-color:#92400e">${t('playlist.draft.discard_changes')}</button>` : ''}
        <button class="btn btn-sm" id="publishBtn" style="background:#f59e0b;color:#000;font-weight:600;border:none">${t('playlist.draft.publish')}</button>
      </div>
    </div>
    ` : ''}

    <div class="page-header">
      <div style="display:flex;align-items:center;gap:12px">
        <a href="#/playlists" style="color:var(--text-muted);text-decoration:none;font-size:20px" title="${t('playlist.back')}">&larr;</a>
        <div>
          <h1 id="playlistTitle" style="cursor:pointer" title="${t('playlist.click_to_rename')}">${esc(playlist.name)}</h1>
          <div class="subtitle" id="playlistDesc" style="cursor:pointer" title="${t('playlist.click_to_edit_desc')}">${playlist.description ? esc(playlist.description) : `<span style="opacity:0.5">${t('playlist.add_desc_placeholder')}</span>`}</div>
          ${playlist.display_count ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">${tn('playlist.assigned_to', playlist.display_count)}</div>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary" id="previewPlaylistBtn">${t('widget.preview')}</button>
        ${playlist.smart_rules
          ? `<button class="btn btn-primary" id="editRulesBtn">${t('smart.edit_rules')}</button>`
          : `<button class="btn btn-primary" id="addItemBtn">${t('playlist.add_content')}</button>`}
        ${corpMode === 'corporate' ? `<button class="btn btn-secondary" id="addSlotBtn" style="display:none">+ ${esc(t('corp.hq.add_slot'))}</button>` : ''}
        <button class="btn btn-secondary" id="deletePlaylistBtn" style="color:var(--danger)">${t('playlist.delete_playlist')}</button>
      </div>
    </div>
    <div id="playlistApprovalBar" style="margin:-8px 0 12px"></div>
    ${corpMode ? '<div id="corpEditorBar"></div>' : ''}

    <!-- Step 3 sends you here by creating a playlist, and this is where you fill it. Losing the
         checklist at exactly this hop is what made the flow feel like it ended. -->
    <div id="gettingStarted"></div>

    ${layoutMockup(playlist)}
    
    <!-- #319: reordering was one-step-at-a-time only. A playlist of 160 photos spanning several
         screens made "put these in filename order" a manual, error-prone job. -->
    <div id="playlistSortBar" style="display:none;align-items:center;gap:8px;margin-bottom:10px">
      <span style="font-size:13px;color:var(--text-muted)">${t('playlist.sort_label')}</span>
      <select id="playlistSort" class="input" style="width:auto;background:var(--bg-input)">
        <option value="">${t('playlist.sort.manual')}</option>
        <option value="name_asc">${t('playlist.sort.name_asc')}</option>
        <option value="name_desc">${t('playlist.sort.name_desc')}</option>
        <option value="date_desc">${t('playlist.sort.date_desc')}</option>
        <option value="date_asc">${t('playlist.sort.date_asc')}</option>
        <option value="duration_asc">${t('playlist.sort.duration_asc')}</option>
        <option value="duration_desc">${t('playlist.sort.duration_desc')}</option>
      </select>
      <button class="btn btn-secondary btn-sm" id="playlistSortApply">${t('playlist.sort_apply')}</button>
      <span style="width:12px"></span>
      ${/* A slot's own order is ignored: head office's playback order applies to the whole loop. */ ''}
      <span style="font-size:13px;color:var(--text-muted);${corpMode === 'fill' ? 'display:none' : ''}">${t('playlist.order_label')}</span>
      <select id="playlistOrder" class="input" style="width:auto;background:var(--bg-input);${corpMode === 'fill' ? 'display:none' : ''}">
        <option value="sequential" ${playlist.playback_order === 'sequential' || !playlist.playback_order ? 'selected' : ''}>${t('playlist.order.sequential')}</option>
        <option value="shuffle" ${playlist.playback_order === 'shuffle' ? 'selected' : ''}>${t('playlist.order.shuffle')}</option>
        <option value="weighted" ${playlist.playback_order === 'weighted' ? 'selected' : ''}>${t('playlist.order.weighted')}</option>
      </select>
    </div>
    ${playlist.smart_rules ? `<div id="smartPanel" style="background:var(--bg-card);border:1px solid #4338ca;border-radius:var(--radius);padding:12px 16px;margin-bottom:10px"></div>` : ''}
    <div id="playlistSelectBar" style="display:none;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;padding:8px 10px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius)">
    </div>
    <div id="playlistItems" style="display:flex;flex-direction:column;gap:8px">
    </div>
  `;

  if (playlist.smart_rules) renderSmart(playlist);
  else renderItems(playlist.items || []);
  if (corpMode) mountCorporateEditor(container, playlist);

  renderApprovalBar(document.getElementById('playlistApprovalBar'), {
    type: 'playlist', id: playlist.id, name: playlist.name,
    onChanged: async () => { try { renderDetailContent(container, await api.getPlaylist(playlist.id)); } catch {} },
  });
  const publishBtn = document.getElementById('publishBtn');
  if (publishBtn) {
    publishBtn.addEventListener('click', async () => {
      try {
        publishBtn.disabled = true;
        publishBtn.textContent = t('playlist.draft.publishing');
        const updated = await api.publishPlaylist(playlist.id);
        showToast(t('playlist.toast.published'));
        // Only GET /:id resolves a smart playlist's matches, and decorates head office's playlist and a
        // slot's content (corporate_slot); the publish response is the bare row.
        renderDetailContent(container, updated.smart_rules || playlist.corporate || playlist.corporate_slot ? await api.getPlaylist(playlist.id) : updated);
      } catch (err) {
        publishBtn.disabled = false;
        publishBtn.textContent = t('playlist.draft.publish');
        showToast(err.message, 'error');
      }
    });
  }
  const previewBtn = document.getElementById('previewPlaylistBtn');
  if (previewBtn) previewBtn.addEventListener('click', () => showPlaylistPreview(playlist));

  const discardBtn = document.getElementById('discardDraftBtn');
  if (discardBtn) {
    discardBtn.addEventListener('click', async () => {
      if (!confirm(t('playlist.confirm_discard_draft'))) return;
      try {
        const updated = await api.discardPlaylistDraft(playlist.id);
        showToast(t('playlist.toast.draft_discarded'));
        renderDetailContent(container, updated.smart_rules || playlist.corporate || playlist.corporate_slot ? await api.getPlaylist(playlist.id) : updated);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  document.getElementById('playlistTitle').addEventListener('click', () => inlineEdit(playlist, 'name'));
  document.getElementById('playlistDesc').addEventListener('click', () => inlineEdit(playlist, 'description'));

  document.getElementById('addItemBtn')?.addEventListener('click', () => showAddItemModal(playlist.id));
  document.getElementById('editRulesBtn')?.addEventListener('click', () => {
    openSmartRulesModal({
      title: t('smart.title_edit', { name: playlist.name }),
      // ⚠️ Never the defaults while real rules exist: saving them would overwrite the playlist.
      initial: (playlist.smart && playlist.smart.rules) || parseStoredRules(playlist.smart_rules) || DEFAULT_RULES,
      onSave: async (rules) => {
        await api.updatePlaylist(playlist.id, { smart_rules: rules });
        showToast(t('smart.toast.saved'), 'info');
        try { renderDetailContent(container, await api.getPlaylist(playlist.id)); } catch { /* saved; the next load shows it */ }
      },
    });
  });

  /*
   * #319: sort the whole playlist in one go.
   *
   * Computed here and sent to the existing reorder route, which takes the finished order — the
   * server does not need to learn about sort modes, and the operator can still drag afterwards,
   * because the result is ordinary sort_order values rather than a stored sort rule. Widgets and
   * nested playlists have no filename or duration of their own, so they keep their relative order
   * and settle after the content rather than being scattered by a comparator that cannot see them.
   */
  document.getElementById('playlistSortApply')?.addEventListener('click', async () => {
    const mode = document.getElementById('playlistSort')?.value;
    if (!mode) return;
    const btn = document.getElementById('playlistSortApply');
    const items = (currentPlaylistItems || []).slice();
    if (items.length < 2) return;

    const key = (i) => ({
      name: (i.filename || i.widget_name || i.child_playlist_name || '').toLowerCase(),
      when: Number(i.created_at) || 0,
      dur: Number(i.duration_sec) || Number(i.content_duration) || 0,
    });
    const sortable = (i) => !!i.content_id;
    const content = items.filter(sortable);
    const rest = items.filter((i) => !sortable(i));
    const cmp = {
      name_asc:      (a, b) => key(a).name.localeCompare(key(b).name, undefined, { numeric: true }),
      name_desc:     (a, b) => key(b).name.localeCompare(key(a).name, undefined, { numeric: true }),
      date_asc:      (a, b) => key(a).when - key(b).when,
      date_desc:     (a, b) => key(b).when - key(a).when,
      duration_asc:  (a, b) => key(a).dur - key(b).dur,
      duration_desc: (a, b) => key(b).dur - key(a).dur,
    }[mode];
    if (!cmp) return;
    content.sort(cmp);
    const order = content.concat(rest).map((i) => i.id);

    try {
      btn.disabled = true;
      const updated = await api.reorderPlaylistItems(currentPlaylistId, order);
      renderItems(updated);
      refreshAfterMutation();
      showToast(t('playlist.toast.sorted'), 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('playlistOrder')?.addEventListener('change', async (e) => {
    const order = e.target.value;
    if (!order || order === (playlist.playback_order || 'sequential')) return;
    try {
      e.target.disabled = true;
      await api.updatePlaylist(playlist.id, { playback_order: order });
      currentPlaybackOrder = order;
      showToast(t('playlist.bulk.updated').replace('{n}', '1'));
      refreshAfterMutation();
    } catch (err) {
      showToast(err.message, 'error');
      e.target.value = playlist.playback_order || 'sequential';
    } finally {
      e.target.disabled = false;
    }
  });

  /*
   * The checklist follows the user into the playlist they just made.
   *
   * ⚠️ THE STEP MEANS SOMETHING DIFFERENT HERE. On the list page step 3 is "create a playlist";
   * standing inside an empty one it is "put something in THIS playlist" — so the action opens the
   * add-content modal rather than the new-playlist dialog, and ctaFor relabels the button to match.
   * Same step, same action, the honest verb for where you are standing.
   */
  gettingStarted.mount(document.getElementById('gettingStarted'), {
    onAction: (a) => {
      if (a === 'new-playlist') {
        if (playlist.smart_rules) document.getElementById('editRulesBtn')?.click();
        else showAddItemModal(playlist.id);
        return true;
      }
      return false;
    },
    ctaFor: { playlist: t('gs.playlist.cta_here') },
  }).catch(() => {});

  // A slot's content: "delete" means "this level goes back to the next level's content or head
  // office's fallback" — say so, with the screens it changes, as the head office page does.
  if (playlist.corporate_slot) {
    const delBtn = document.getElementById('deletePlaylistBtn');
    delBtn.textContent = t('corp.slot.remove_level');
    delBtn.addEventListener('click', async () => {
      const cs = playlist.corporate_slot;
      const f = (corpEditor && corpEditor.mode === 'fill' && corpEditor.fill) || {};
      const ok = await cui.ask({
        title: t('corp.slot.remove_level'), confirmLabel: t('corp.slot.remove_level'), danger: true,
        text: tn('corp.slot.remove_level_confirm', f.screens || 0, { level: cui.levelLabel(f.scope_kind || cs.scope_kind, f.scope_name) }),
      });
      if (!ok) return;
      try {
        await api.deleteFill(cs.fill_id);
        showToast(t('corp.slot.level_removed'), 'success');
        window.location.hash = '#/corporate';
      } catch (err) { showToast(err.message, 'error'); }
    });
    return;
  }
  document.getElementById('deletePlaylistBtn').addEventListener('click', async () => {
    if (!confirm(t('playlist.confirm_delete', { name: playlist.name }))) return;
    try {
      await api.deletePlaylist(playlist.id);
      showToast(t('playlist.toast.deleted'));
      window.location.hash = '#/playlists';
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

async function refreshAfterMutation() {
  if (!currentPlaylistId) return;
  const mainContainer = document.getElementById('draftBanner')?.parentElement || document.querySelector('.page-header')?.parentElement;
  if (!mainContainer) return;
  try {
    const playlist = await api.getPlaylist(currentPlaylistId);
    renderDetailContent(mainContainer, playlist);
  } catch (e) { /* silent */ }
}

function selectedRows() {
  return currentPlaylistItems.filter((it) => selectedItemIds.has(String(it.id)));
}
function clipPayload(items) {
  return items.map((it) => ({
    content_id: it.content_id || null,
    widget_id: it.widget_id || null,
    child_playlist_id: it.child_playlist_id || null,
    zone_id: it.zone_id || null,
    duration_sec: it.duration_sec,
    muted: it.muted ? 1 : 0,
    play_from: it.play_from || null,
    play_until: it.play_until || null,
    enabled: it.enabled === 0 ? 0 : 1,
    log_play: it.log_play === 0 ? 0 : 1,
    fit_mode: it.fit_mode || null,
    play_when: it.play_when || null,
    weight: it.weight || 1,
    repeat_every_sec: it.repeat_every_sec || null,
    schedules: it.schedules || [],
  }));
}
function setClip(items) {
  // Returns whether the write actually landed — cut relies on this so it never deletes into a void
  // (private mode / quota / disabled storage) and loses the items.
  try {
    sessionStorage.setItem(CLIP_KEY, JSON.stringify(items));
    return sessionStorage.getItem(CLIP_KEY) != null;
  } catch { return false; }
}
function getClip() {
  try { return JSON.parse(sessionStorage.getItem(CLIP_KEY) || 'null'); } catch { return null; }
}

// Field paths a data source offers, derived from its last-fetched values (top level + one nesting).
function fieldPathsOf(data) {
  const out = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return out;
  for (const [k, v] of Object.entries(data)) {
    out.push(k);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k2 of Object.keys(v)) out.push(`${k}.${k2}`);
    }
  }
  return out.slice(0, 100);
}

// The condition editor: data-source, tag, or metadata. Real dropdowns, validated before send.
async function editConditionModal(ids, parsed) {
  let sources = [];
  try { sources = await api.getDataSources(); } catch { sources = []; }
  const OPS = [['eq', '= equals'], ['neq', '≠ not equal'], ['gt', '> greater than'],
    ['gte', '≥ at least'], ['lt', '< less than'], ['lte', '≤ at most'], ['truthy', 'is set / true']];
  const curType = (parsed && parsed.type) || (parsed && parsed.slug ? 'ds' : 'ds');
  const curOp = (parsed && parsed.op) || (curType === 'tag' ? 'has' : 'eq');
  const opts = sources.map((s) => `<option value="${esc(s.slug)}" ${parsed && parsed.slug === s.slug ? 'selected' : ''}>${esc(s.name || s.slug)}</option>`).join('');
  const opOpts = OPS.map(([v, l]) => `<option value="${v}" ${curOp === v ? 'selected' : ''}>${esc(l)}</option>`).join('');

  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000';
  modal.innerHTML = `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;width:440px;max-width:92vw">
      <h3 style="margin-bottom:6px;color:var(--text-primary)">${esc(t('playlist.bulk.condition'))}</h3>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:16px">${esc(t('playlist.condition.hint'))}</p>
      <label style="font-size:12px;color:var(--text-muted)">${esc(t('playlist.condition.type'))}</label>
      <select id="condType" class="input" style="width:100%;margin:4px 0 12px">
        <option value="ds" ${curType === 'ds' || !parsed ? 'selected' : ''}>${esc(t('playlist.condition.type_ds'))}</option>
        <option value="tag" ${curType === 'tag' ? 'selected' : ''}>${esc(t('playlist.condition.type_tag'))}</option>
        <option value="meta" ${curType === 'meta' ? 'selected' : ''}>${esc(t('playlist.condition.type_meta'))}</option>
      </select>
      <div id="condDsWrap">
        ${sources.length ? '' : `<p style="color:#fbbf24;font-size:13px;margin-bottom:12px">${esc(t('playlist.condition.no_sources'))}</p>`}
        <label style="font-size:12px;color:var(--text-muted)">${esc(t('playlist.condition.slug'))}</label>
        <select id="condSlug" class="input" style="width:100%;margin:4px 0 12px">${opts}</select>
        <label style="font-size:12px;color:var(--text-muted)">${esc(t('playlist.condition.path'))}</label>
        <input id="condPath" class="input" list="condFields" placeholder="e.g. status or now.title" value="${esc(parsed && parsed.type !== 'tag' && parsed.type !== 'meta' ? (parsed.path || '') : '')}" style="width:100%;margin:4px 0 12px">
        <datalist id="condFields"></datalist>
        <label style="font-size:12px;color:var(--text-muted)">${esc(t('playlist.condition.op'))}</label>
        <select id="condOp" class="input" style="width:100%;margin:4px 0 12px">${opOpts}</select>
        <div id="condValueWrap">
          <label style="font-size:12px;color:var(--text-muted)">${esc(t('playlist.condition.value'))}</label>
          <input id="condValue" class="input" value="${esc(parsed && parsed.type !== 'tag' && parsed.type !== 'meta' && parsed.value != null ? String(parsed.value) : '')}" style="width:100%;margin:4px 0 12px">
        </div>
      </div>
      <div id="condTagWrap" hidden>
        <label style="font-size:12px;color:var(--text-muted)">${esc(t('playlist.condition.op'))}</label>
        <select id="condTagOp" class="input" style="width:100%;margin:4px 0 12px">
          <option value="has" ${curOp !== 'lacks' ? 'selected' : ''}>${esc(t('playlist.condition.tag_has'))}</option>
          <option value="lacks" ${curOp === 'lacks' ? 'selected' : ''}>${esc(t('playlist.condition.tag_lacks'))}</option>
        </select>
        <label style="font-size:12px;color:var(--text-muted)">${esc(t('playlist.condition.tag'))}</label>
        <input id="condTagValue" class="input" value="${esc(parsed && parsed.type === 'tag' && parsed.value ? String(parsed.value) : '')}" placeholder="${esc(t('content.tags_placeholder'))}" style="width:100%;margin:4px 0 12px">
      </div>
      <div id="condMetaWrap" hidden>
        <label style="font-size:12px;color:var(--text-muted)">${esc(t('playlist.condition.path'))}</label>
        <input id="condMetaPath" class="input" value="${esc(parsed && parsed.type === 'meta' ? (parsed.path || '') : '')}" placeholder="e.g. dept" style="width:100%;margin:4px 0 12px">
        <label style="font-size:12px;color:var(--text-muted)">${esc(t('playlist.condition.op'))}</label>
        <select id="condMetaOp" class="input" style="width:100%;margin:4px 0 12px">${OPS.map(([v, l]) => `<option value="${v}" ${parsed && parsed.type === 'meta' && curOp === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        <div id="condMetaValueWrap">
          <label style="font-size:12px;color:var(--text-muted)">${esc(t('playlist.condition.value'))}</label>
          <input id="condMetaValue" class="input" value="${esc(parsed && parsed.type === 'meta' && parsed.value != null ? String(parsed.value) : '')}" style="width:100%;margin:4px 0 12px">
        </div>
      </div>
      <div style="display:flex;gap:8px;justify-content:space-between;margin-top:8px">
        <button class="btn btn-secondary" id="condClear">${esc(t('playlist.condition.clear'))}</button>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary" id="condCancel">${esc(t('common.cancel'))}</button>
          <button class="btn btn-primary" id="condApply">${esc(t('playlist.bulk.apply'))}</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const typeSel = modal.querySelector('#condType');
  const dsWrap = modal.querySelector('#condDsWrap');
  const tagWrap = modal.querySelector('#condTagWrap');
  const metaWrap = modal.querySelector('#condMetaWrap');
  const showType = () => {
    const ty = typeSel.value;
    dsWrap.hidden = ty !== 'ds';
    tagWrap.hidden = ty !== 'tag';
    metaWrap.hidden = ty !== 'meta';
  };
  typeSel.addEventListener('change', showType);
  showType();

  const slugSel = modal.querySelector('#condSlug');
  const fieldList = modal.querySelector('#condFields');
  const opSel = modal.querySelector('#condOp');
  const valWrap = modal.querySelector('#condValueWrap');
  const bySlug = new Map(sources.map((s) => [s.slug, s]));
  const refreshFields = () => {
    const src = bySlug.get(slugSel.value);
    fieldList.innerHTML = fieldPathsOf(src && src.data).map((p) => `<option value="${esc(p)}">`).join('');
  };
  const refreshValue = () => { valWrap.hidden = opSel.value === 'truthy'; };
  slugSel.addEventListener('change', refreshFields);
  opSel.addEventListener('change', refreshValue);
  refreshFields(); refreshValue();
  const metaOp = modal.querySelector('#condMetaOp');
  const metaValWrap = modal.querySelector('#condMetaValueWrap');
  metaOp.addEventListener('change', () => { metaValWrap.hidden = metaOp.value === 'truthy'; });
  metaValWrap.hidden = metaOp.value === 'truthy';

  const close = () => modal.remove();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.querySelector('#condCancel').addEventListener('click', close);
  modal.querySelector('#condClear').addEventListener('click', async () => {
    close(); await runSelection({ action: 'play_when', ids, play_when: null });
    selectedItemIds.clear(); paintSelectBar(); showToast(t('playlist.bulk.updated').replace('{n}', ids.length));
  });
  modal.querySelector('#condApply').addEventListener('click', async () => {
    const ty = typeSel.value;
    let play_when;
    if (ty === 'tag') {
      const value = modal.querySelector('#condTagValue').value.trim().toLowerCase();
      if (!value) { modal.querySelector('#condTagValue').focus(); return; }
      play_when = { type: 'tag', op: modal.querySelector('#condTagOp').value, value };
    } else if (ty === 'meta') {
      const path = modal.querySelector('#condMetaPath').value.trim();
      const op = metaOp.value;
      if (!path) { modal.querySelector('#condMetaPath').focus(); return; }
      play_when = { type: 'meta', path, op, value: op === 'truthy' ? '' : modal.querySelector('#condMetaValue').value };
    } else {
      const slug = slugSel.value;
      const path = modal.querySelector('#condPath').value.trim();
      const op = opSel.value;
      const value = op === 'truthy' ? '' : modal.querySelector('#condValue').value;
      if (!slug) { showToast(t('playlist.condition.no_sources'), 'error'); return; }
      if (!path) { modal.querySelector('#condPath').focus(); return; }
      play_when = { slug, path, op, value };
    }
    close();
    const r = await runSelection({ action: 'play_when', ids, play_when });
    if (r) { showToast(t('playlist.bulk.updated').replace('{n}', ids.length)); }
  });
}
function paintSelectBar() {
  const bar = document.getElementById('playlistSelectBar');
  if (!bar) return;
  const n = selectedItemIds.size;
  bar.style.display = currentPlaylistItems.length && !corpIsReadOnly() ? 'flex' : 'none';
  const clip = getClip();
  bar.innerHTML = `
    <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-muted);margin:0">
      <input type="checkbox" id="playlistSelectAll" ${n && n === currentPlaylistItems.length ? 'checked' : ''}>
      ${n ? t('playlist.selected').replace('{n}', n) : t('playlist.select_all')}
    </label>
    <span style="flex:1"></span>
    <button class="btn btn-secondary btn-sm" data-sel="copy" ${n ? '' : 'disabled'}>${t('playlist.bulk.copy')}</button>
    <button class="btn btn-secondary btn-sm" data-sel="cut" ${n ? '' : 'disabled'}>${t('playlist.bulk.cut')}</button>
    <button class="btn btn-secondary btn-sm" data-sel="paste" ${clip && clip.length ? '' : 'disabled'}>${t('playlist.bulk.paste')}</button>
    <button class="btn btn-secondary btn-sm" data-sel="duplicate" ${n ? '' : 'disabled'}>${t('playlist.bulk.duplicate')}</button>
    <button class="btn btn-secondary btn-sm" data-sel="duration" ${n ? '' : 'disabled'}>${t('playlist.bulk.duration')}</button>
    <button class="btn btn-secondary btn-sm" data-sel="weight" ${n ? '' : 'disabled'}>${t('playlist.bulk.weight')}</button>
    <button class="btn btn-secondary btn-sm" data-sel="window" ${n ? '' : 'disabled'}>${t('playlist.bulk.window')}</button>
    <button class="btn btn-secondary btn-sm" data-sel="validity" ${n ? '' : 'disabled'}>${t('playlist.bulk.validity')}</button>
    <button class="btn btn-secondary btn-sm" data-sel="activate" ${n ? '' : 'disabled'}>${t('playlist.bulk.activate')}</button>
    <button class="btn btn-secondary btn-sm" data-sel="deactivate" ${n ? '' : 'disabled'}>${t('playlist.bulk.deactivate')}</button>
    <button class="btn btn-secondary btn-sm" data-sel="log_on" ${n ? '' : 'disabled'}>${t('playlist.bulk.log_on')}</button>
    <button class="btn btn-secondary btn-sm" data-sel="log_off" ${n ? '' : 'disabled'}>${t('playlist.bulk.log_off')}</button>
    <select class="input" id="playlistBulkFit" ${n ? '' : 'disabled'} style="width:auto;background:var(--bg-input);font-size:13px">
      <option value="">${t('playlist.bulk.fit')}</option>
      <option value="inherit">${t('playlist.bulk.fit_inherit')}</option>
      <option value="contain">${t('playlist.bulk.fit_contain')}</option>
      <option value="cover">${t('playlist.bulk.fit_cover')}</option>
      <option value="fill">${t('playlist.bulk.fit_fill')}</option>
    </select>
    <button class="btn btn-secondary btn-sm" data-sel="transition" ${n ? '' : 'disabled'}>${t('playlist.bulk.transition')}</button>
    <button class="btn btn-secondary btn-sm" data-sel="condition" ${n ? '' : 'disabled'}>${t('playlist.bulk.condition')}</button>
    <button class="btn btn-sm" data-sel="delete" ${n ? '' : 'disabled'} style="color:var(--danger)">${t('playlist.bulk.delete')}</button>
  `;
  const all = bar.querySelector('#playlistSelectAll');
  if (all) all.onchange = () => {
    if (all.checked) currentPlaylistItems.forEach((it) => selectedItemIds.add(String(it.id)));
    else selectedItemIds.clear();
    renderItems(currentPlaylistItems);
  };
  bar.querySelector('#playlistBulkFit')?.addEventListener('change', async (e) => {
    const v = e.target.value;
    if (!v || !n) return;
    await runSelection({ action: 'fit_mode', ids: [...selectedItemIds], fit_mode: v === 'inherit' ? null : v });
  });
  bar.querySelectorAll('[data-sel]').forEach((btn) => {
    btn.onclick = () => handleSelection(btn.dataset.sel);
  });
}
function bindSelection(itemsEl, items) {
  itemsEl.querySelectorAll('.item-select').forEach((box) => {
    // A `change` event is not a MouseEvent, so e.shiftKey is undefined there. Capture the modifier
    // from the mouse event that precedes it (mousedown/click both fire before change on a checkbox).
    let shiftHeld = false;
    box.addEventListener('mousedown', (e) => { shiftHeld = e.shiftKey; e.stopPropagation(); });
    box.addEventListener('click', (e) => { shiftHeld = e.shiftKey; e.stopPropagation(); });
    box.addEventListener('keydown', (e) => { shiftHeld = e.shiftKey; }); // keyboard toggle
    box.addEventListener('change', (e) => {
      const id = String(e.target.dataset.itemId);
      const idx = Number(e.target.dataset.index);
      // Anchor is tracked by item id, not index, so it survives a re-sort/re-render.
      const anchorIdx = selectAnchorId != null ? items.findIndex((it) => String(it.id) === selectAnchorId) : -1;
      if (shiftHeld && anchorIdx >= 0) {
        const a = Math.min(anchorIdx, idx);
        const b = Math.max(anchorIdx, idx);
        for (let i = a; i <= b; i++) {
          const it = items[i];
          if (it) selectedItemIds.add(String(it.id));
        }
      } else if (e.target.checked) {
        selectedItemIds.add(id);
        selectAnchorId = id;
      } else {
        selectedItemIds.delete(id);
        selectAnchorId = id;
      }
      paintSelectBar();
      itemsEl.querySelectorAll('.playlist-item').forEach((row) => {
        row.style.borderColor = selectedItemIds.has(String(row.dataset.itemId)) ? 'var(--accent, #3B82F6)' : 'var(--border)';
      });
      itemsEl.querySelectorAll('.item-select').forEach((cb) => {
        cb.checked = selectedItemIds.has(String(cb.dataset.itemId));
      });
    });
  });
}
async function refreshSelection() {
  const playlist = await api.getPlaylist(currentPlaylistId);
  renderItems(playlist.items || []);
  refreshAfterMutation();
}
async function runSelection(body) {
  try {
    const r = await api.playlistSelection(currentPlaylistId, body);
    await refreshSelection();
    return r;
  } catch (err) {
    showToast(err.message, 'error');
    return null;
  }
}
async function handleSelection(act) {
  const ids = [...selectedItemIds];
  const rows = selectedRows();
  if (act === 'copy') {
    setClip(clipPayload(rows));
    paintSelectBar();
    showToast(t('playlist.bulk.copied').replace('{n}', rows.length));
    return;
  }
  if (act === 'cut') {
    // Never delete unless the clipboard write is confirmed, or a failed write would lose the items.
    if (!setClip(clipPayload(rows))) { showToast(t('playlist.bulk.clip_failed')); return; }
    const r = await runSelection({ action: 'delete', ids });
    if (r) {
      selectedItemIds.clear();
      showToast(t('playlist.bulk.cut_done').replace('{n}', rows.length));
    }
    return;
  }
  if (act === 'paste') {
    const items = getClip();
    if (!items || !items.length) return;
    const r = await runSelection({ action: 'paste', items });
    if (r) showToast(t('playlist.bulk.pasted').replace('{n}', r.added || items.length));
    return;
  }
  if (act === 'delete') {
    if (!ids.length) return;
    const r = await runSelection({ action: 'delete', ids });
    if (r) { selectedItemIds.clear(); showToast(t('playlist.bulk.deleted').replace('{n}', r.deleted || ids.length)); }
    return;
  }
  if (act === 'duplicate') {
    const r = await runSelection({ action: 'duplicate', ids });
    if (r) showToast(t('playlist.bulk.updated').replace('{n}', r.duplicated || ids.length));
    return;
  }
  if (act === 'activate') {
    const r = await runSelection({ action: 'enabled', ids, enabled: 1 });
    if (r) showToast(t('playlist.bulk.updated').replace('{n}', r.updated || ids.length));
    return;
  }
  if (act === 'deactivate') {
    // Deactivating every currently-enabled item empties the published snapshot, so the screen falls
    // to its "Nothing scheduled" idle state. Confirm before doing that by accident.
    const enabledCount = currentPlaylistItems.filter((it) => it.enabled !== 0).length;
    const deactivatingEnabled = rows.filter((it) => it.enabled !== 0).length;
    if (deactivatingEnabled >= enabledCount && enabledCount > 0
        && !confirm(t('playlist.bulk.deactivate_all_warn'))) return;
    const r = await runSelection({ action: 'enabled', ids, enabled: 0 });
    if (r) showToast(t('playlist.bulk.updated').replace('{n}', r.updated || ids.length));
    return;
  }
  if (act === 'log_on') {
    const r = await runSelection({ action: 'log_play', ids, log_play: 1 });
    if (r) showToast(t('playlist.bulk.updated').replace('{n}', r.updated || ids.length));
    return;
  }
  if (act === 'log_off') {
    const r = await runSelection({ action: 'log_play', ids, log_play: 0 });
    if (r) showToast(t('playlist.bulk.updated').replace('{n}', r.updated || ids.length));
    return;
  }
  if (act === 'duration') {
    const raw = prompt(t('playlist.bulk.duration'), rows[0] && rows[0].duration_sec || 10);
    if (raw == null) return;
    const d = parseInt(raw, 10);
    if (!d || d < 1) return;
    const r = await runSelection({ action: 'duration', ids, duration_sec: d });
    if (r) showToast(t('playlist.bulk.updated').replace('{n}', r.updated || ids.length));
    return;
  }
  if (act === 'weight') {
    const raw = prompt(t('playlist.bulk.weight'), (rows[0] && rows[0].weight) || 1);
    if (raw == null) return;
    let w = parseInt(raw, 10);
    if (!w || w < 1) return;
    if (w > 1000) { w = 1000; showToast(t('playlist.weight_capped'), 'info'); }
    const r = await runSelection({ action: 'weight', ids, weight: w });
    if (r) showToast(t('playlist.bulk.updated').replace('{n}', r.updated || ids.length));
    return;
  }
  if (act === 'window') {
    const from = prompt(t('playlist.play_from'), (rows[0] && rows[0].play_from) || '');
    if (from == null) return;
    const until = prompt(t('playlist.play_until'), (rows[0] && rows[0].play_until) || '');
    if (until == null) return;
    return runSelection({ action: 'play_window', ids, play_from: from || null, play_until: until || null });
  }
  if (act === 'validity') {
    const first = rows[0];
    if (!first) return;
    showScheduleModal(first, { applyIds: ids });
    return;
  }
  if (act === 'transition') {
    try {
      const widgets = await api.getWidgets();
      const trans = (Array.isArray(widgets) ? widgets : []).filter((w) => w.widget_type === 'transition');
      if (!trans.length) { showToast(t('playlist.bulk.no_transition'), 'error'); return; }
      const pick = prompt(trans.map((w, i) => `${i + 1}. ${w.name}`).join('\n'));
      if (pick == null) return;
      const idx = parseInt(pick, 10) - 1;
      const w = trans[idx] || trans.find((x) => x.name === pick);
      if (!w) return;
      return runSelection({ action: 'transition', ids, widget_id: w.id });
    } catch (err) { showToast(err.message, 'error'); }
    return;
  }
  if (act === 'condition') {
    const cur = rows[0] && rows[0].play_when;
    const parsed = typeof cur === 'string' ? (() => { try { return JSON.parse(cur); } catch { return null; } })() : cur;
    return editConditionModal(ids, parsed);
  }
}

/*
 * A smart playlist's items come from its rules (server: lib/smart-playlist.js), so the editor shows
 * what they select right now, read-only. Hand-editing is the rules' job, and the item routes refuse it.
 */
function parseStoredRules(raw) {
  if (!raw) return null;
  try { const r = typeof raw === 'string' ? JSON.parse(raw) : raw; return r && Array.isArray(r.rules) ? r : null; } catch { return null; }
}

async function renderSmart(playlist) {
  currentPlaylistItems = [];
  selectedItemIds = new Set();
  const smart = playlist.smart || { rules: null, count: 0, items: [] };
  const sortBar = document.getElementById('playlistSortBar');
  if (sortBar) {
    // Order is the rules' sort; only the playback order (sequential / shuffle) applies here.
    sortBar.style.display = 'flex';
    for (const id of ['playlistSort', 'playlistSortApply']) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }
    const label = sortBar.querySelector('span');
    if (label) label.style.display = 'none';
  }
  const panel = document.getElementById('smartPanel');
  const itemsEl = document.getElementById('playlistItems');
  const folders = smart.rules && smart.rules.rules.some((r) => r.field === 'folder') ? await loadFolders() : [];
  // The folder fetch is async: if the operator has moved on (another playlist, or a newer render of
  // this one), these elements are gone and this render must not paint into whatever replaced them.
  if ((panel && !panel.isConnected) || (itemsEl && !itemsEl.isConnected) || currentPlaylistId !== playlist.id) return;
  if (panel) {
    panel.innerHTML = `
      <div style="font-size:13px;color:#c7d2fe;font-weight:600;margin-bottom:4px">✦ ${t('smart.panel_title')}</div>
      <div style="font-size:13px;color:var(--text-primary);margin-bottom:4px">${esc(rulesSummary(smart.rules, folders))}</div>
      <div style="font-size:12px;color:var(--text-muted)">${t('smart.panel_hint')}</div>`;
  }
  if (!itemsEl) return;
  if (!smart.items.length) {
    itemsEl.innerHTML = `
      <div style="text-align:center;padding:40px;color:var(--text-muted);border:2px dashed var(--border);border-radius:var(--radius-lg)">
        <p style="margin-bottom:8px">${t('smart.empty')}</p>
        <p style="font-size:13px">${t('smart.empty_hint')}</p>
      </div>`;
    return;
  }
  itemsEl.innerHTML = `
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:2px">${t('smart.preview_count', { n: smart.count })}${smart.count > smart.items.length ? ' · ' + t('smart.showing_first', { n: smart.items.length }) : ''}</div>
    ${smart.items.map((it, i) => `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:10px 16px;display:flex;align-items:center;gap:12px">
      <div style="color:var(--text-muted);font-size:12px;min-width:24px;text-align:center">${i + 1}</div>
      <div style="width:48px;height:36px;border-radius:4px;overflow:hidden;background:var(--bg-input);flex-shrink:0;display:flex;align-items:center;justify-content:center">
        ${it.thumbnail_path ? `<img data-auth-src="/api/content/${esc(it.id)}/thumbnail" style="width:100%;height:100%;object-fit:cover">` : `<div style="color:var(--text-muted);opacity:0.5">${getTypeIcon(it)}</div>`}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(it.filename)}</div>
        <div style="font-size:12px;color:var(--text-muted)">${esc(t(`smart.type.${it.type}`))}</div>
      </div>
    </div>`).join('')}`;
  try { hydrateAuthImages(itemsEl); } catch { /* thumbnails are cosmetic */ }
}

/*
 * "Play every N": weave this item through the loop at about that interval (server:
 * lib/repeat-every.js). Sequential order only; a value that is not one of the presets (set over
 * the API) is still shown, so the select never silently misreports what is stored.
 */
const REPEAT_PRESETS = [30, 60, 120, 300, 600, 900, 1800, 3600];
function repeatLabel(sec) {
  return sec < 60 ? t('repeat.every_sec', { n: sec }) : t('repeat.every_min', { n: Math.round((sec / 60) * 10) / 10 });
}
function repeatSelect(item) {
  const cur = Number(item.repeat_every_sec) || 0;
  const opts = REPEAT_PRESETS.includes(cur) || !cur ? REPEAT_PRESETS : [...REPEAT_PRESETS, cur].sort((a, b) => a - b);
  return `<select class="input item-repeat" data-item-id="${item.id}" title="${esc(t('repeat.hint'))}" style="width:auto;padding:4px 6px;font-size:12px;${cur ? 'border-color:#6366f1;color:#c7d2fe' : ''}">
    <option value="">${t('repeat.once')}</option>
    ${opts.map((s) => `<option value="${s}" ${s === cur ? 'selected' : ''}>↻ ${esc(repeatLabel(s))}</option>`).join('')}
  </select>`;
}

function renderItems(items) {
  const itemsEl = document.getElementById('playlistItems');
  if (!itemsEl) return;
  currentPlaylistItems = items || [];
  const present = new Set(currentPlaylistItems.map((it) => String(it.id)));
  selectedItemIds = new Set([...selectedItemIds].filter((id) => present.has(id)));
  const sortBar = document.getElementById('playlistSortBar');
  // Head office's playlist, for someone who can't change it: no sort/order/selection tools (§7.9).
  const corpReadOnly = corpIsReadOnly();
  if (sortBar) sortBar.style.display = items.length && !corpReadOnly ? 'flex' : 'none';
  paintSelectBar();

  if (!items.length) {
    itemsEl.innerHTML = `
      <div style="text-align:center;padding:40px;color:var(--text-muted);border:2px dashed var(--border);border-radius:var(--radius-lg)">
        <p style="margin-bottom:8px">${t('playlist.items_empty')}</p>
        <p style="font-size:13px">${t('playlist.items_empty_hint')}</p>
      </div>
    `;
    return;
  }

  const fillMode = !!(corpEditor && corpEditor.mode === 'fill');
  itemsEl.innerHTML = items.map((item, i) => item.slot_id ? slotRowHtml(item, i, items.length) : `
    <div class="playlist-item" data-item-id="${item.id}" data-index="${i}" draggable="true" style="background:var(--bg-card);border:1px solid ${selectedItemIds.has(String(item.id)) ? 'var(--accent, #3B82F6)' : 'var(--border)'};border-radius:var(--radius);padding:12px 16px;display:flex;align-items:center;gap:12px;cursor:grab;transition:border-color 0.15s;${item.enabled === 0 ? 'opacity:0.55' : ''}">
      <input type="checkbox" class="item-select" data-item-id="${item.id}" data-index="${i}" ${selectedItemIds.has(String(item.id)) ? 'checked' : ''} style="flex-shrink:0" onclick="event.stopPropagation()">
      <div style="color:var(--text-muted);font-size:12px;min-width:24px;text-align:center;user-select:none">${i + 1}</div>
      <div style="width:48px;height:36px;border-radius:4px;overflow:hidden;background:var(--bg-input);flex-shrink:0;display:flex;align-items:center;justify-content:center">
        ${item.child_playlist_id
          ? '<div style="color:var(--text-muted)">☰</div>'
          : item.thumbnail_path
            ? `<img data-auth-src="/api/content/${esc(item.content_id)}/thumbnail" style="width:100%;height:100%;object-fit:cover">`
            : `<div style="color:var(--text-muted);opacity:0.5">${getTypeIcon(item)}</div>`
        }
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(item.child_playlist_name || item.filename || item.widget_name || t('common.unknown'))}</div>
        <div style="font-size:12px;color:var(--text-muted);display:flex;align-items:center;gap:8px;min-width:0">
          <span style="white-space:nowrap">${item.child_playlist_id ? t('playlist.item_nested') : item.widget_id ? t('playlist.item_widget') : esc(item.mime_type || t('playlist.unknown_type'))}</span>
          ${/* In a slot a video counts at its full length (it always plays to the end), so say so. */ ''}
          ${fillMode && item.content_duration && /^(video|audio)\//.test(item.mime_type || '') ? `<span style="font-size:11px;white-space:nowrap;color:var(--warning)">${esc(t('corp.slot.video_len', { len: cui.formatSec(item.content_duration) }))}</span>` : ''}
          ${item.play_from || item.play_until ? `<span style="font-size:11px;padding:1px 6px;border-radius:4px;background:#1a2e1a;color:#86efac;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(windowSummary(item))}">${esc(windowSummary(item))}</span>` : ''}
          ${item.schedules && item.schedules.length ? `<span style="font-size:11px;padding:1px 6px;border-radius:4px;background:#0c2a3f;color:#7dd3fc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(scheduleSummary(item.schedules))}">🕐 ${esc(scheduleSummary(item.schedules))}</span>` : ''}
          ${Array.isArray(item.tags) && item.tags.length ? `<span style="font-size:11px;padding:1px 6px;border-radius:4px;background:var(--bg-input);color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${item.tags.map((tg) => '#' + esc(tg)).join(' ')}</span>` : ''}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
        ${item.child_playlist_id
          ? `<span style="font-size:12px;color:var(--text-muted)" title="${esc(t('playlist.nested_duration_hint'))}">${esc(t('playlist.plays_through'))}</span>`
          : (item.mime_type === 'video/hls' || item.mime_type === 'video/rtsp')
          // A live stream's duration is DWELL (how long to stay on the channel), not clip length.
          // 0 = stay until the item is skipped (window / enabled / play_when / the playlist advances).
          ? `<label style="font-size:12px;color:var(--text-muted)" title="${esc(t('playlist.dwell_hint'))}">${t('playlist.dwell')}</label>
        <input type="number" class="input item-duration" data-item-id="${item.id}" data-live="1" value="${item.duration_sec || 0}" min="0" title="${esc(t('playlist.dwell_hint'))}" style="width:60px;padding:4px 8px;font-size:13px;text-align:center">
        <span style="font-size:12px;color:var(--text-muted)">${t('playlist.sec')}</span>`
          : `<label style="font-size:12px;color:var(--text-muted)">${t('playlist.duration')}</label>
        <input type="number" class="input item-duration" data-item-id="${item.id}" value="${item.duration_sec}" min="1" style="width:60px;padding:4px 8px;font-size:13px;text-align:center">
        <span style="font-size:12px;color:var(--text-muted)">${t('playlist.sec')}</span>`}
        ${currentPlaybackOrder === 'weighted' && !item.child_playlist_id ? `<label style="font-size:12px;color:var(--text-muted)">${t('playlist.weight')}</label>
        <input type="number" class="input item-weight" data-item-id="${item.id}" value="${item.weight || 1}" min="1" max="1000" style="width:56px;padding:4px 8px;font-size:13px;text-align:center">` : ''}
        ${currentPlaybackOrder === 'sequential' && !item.child_playlist_id && !fillMode ? repeatSelect(item) : ''}
        <label style="font-size:12px;color:var(--text-muted)" title="${esc(t('playlist.play_window_hint'))}">${t('playlist.play_from')}</label>
        <input type="datetime-local" class="input item-play-from" data-item-id="${item.id}" value="${esc(item.play_from || '')}" style="width:168px;padding:4px 6px;font-size:12px">
        <label style="font-size:12px;color:var(--text-muted)">${t('playlist.play_until')}</label>
        <input type="datetime-local" class="input item-play-until" data-item-id="${item.id}" value="${esc(item.play_until || '')}" style="width:168px;padding:4px 6px;font-size:12px">
      </div>
      <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
        <button class="btn-icon item-schedule" data-item-id="${item.id}" title="${t('itemsched.title')}" aria-label="${t('itemsched.title')}" style="color:${item.schedules && item.schedules.length ? '#38bdf8' : 'var(--text-muted)'};background:none;border:none;cursor:pointer;padding:4px;border-radius:4px">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>
        </button>
        <button class="btn-icon item-replace" data-item-id="${item.id}" title="${t('playlist.replace_item')}" aria-label="${t('playlist.replace_item')}" style="color:var(--text-muted);background:none;border:none;cursor:pointer;padding:4px;border-radius:4px">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
        </button>
        <button class="btn-icon item-duplicate" data-item-id="${item.id}" title="${t('playlist.duplicate_item')}" aria-label="${t('playlist.duplicate_item')}" style="color:var(--text-muted);background:none;border:none;cursor:pointer;padding:4px;border-radius:4px">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
        <button class="btn-icon item-move" data-item-id="${item.id}" data-dir="up" title="${t('playlist.move_up')}" aria-label="${t('playlist.move_up')}" ${i === 0 ? 'disabled' : ''} style="color:var(--text-muted);background:none;border:none;cursor:pointer;padding:4px;border-radius:4px;${i === 0 ? 'opacity:0.3;cursor:not-allowed' : ''}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>
        </button>
        <button class="btn-icon item-move" data-item-id="${item.id}" data-dir="down" title="${t('playlist.move_down')}" aria-label="${t('playlist.move_down')}" ${i === items.length - 1 ? 'disabled' : ''} style="color:var(--text-muted);background:none;border:none;cursor:pointer;padding:4px;border-radius:4px;${i === items.length - 1 ? 'opacity:0.3;cursor:not-allowed' : ''}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <button class="btn-icon item-remove" data-item-id="${item.id}" title="${t('common.delete')}" aria-label="${t('playlist.remove_item')}" style="color:var(--text-muted);background:none;border:none;cursor:pointer;padding:4px;border-radius:4px">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>
  `).join('');
  hydrateAuthImages(itemsEl);
  bindSelection(itemsEl, items);
  bindSlotRows(itemsEl);
  if (corpReadOnly) lockCorporateRows(itemsEl);

  itemsEl.querySelectorAll('.item-duration').forEach(input => {
    input.addEventListener('change', async (e) => {
      const itemId = e.target.dataset.itemId;
      // A live stream accepts 0 (dwell 0 = stay until skipped); everything else needs >= 1.
      const isLive = e.target.dataset.live === '1';
      const val = parseInt(e.target.value, 10);
      if (Number.isNaN(val) || val < (isLive ? 0 : 1)) { e.target.value = isLive ? 0 : 10; return; }
      try {
        await api.updatePlaylistItem(currentPlaylistId, itemId, { duration_sec: val });
        refreshAfterMutation();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  itemsEl.querySelectorAll('.item-repeat').forEach(sel => {
    sel.addEventListener('change', async (e) => {
      const v = e.target.value ? Number(e.target.value) : null;
      try {
        await api.updatePlaylistItem(currentPlaylistId, e.target.dataset.itemId, { repeat_every_sec: v });
        showToast(t('repeat.toast_saved'), 'info');
        refreshAfterMutation();
      } catch (err) {
        showToast(err.message, 'error');
        refreshAfterMutation();   // put the select back to what is actually stored
      }
    });
  });

  itemsEl.querySelectorAll('.item-weight').forEach(input => {
    input.addEventListener('change', async (e) => {
      const itemId = e.target.dataset.itemId;
      let val = parseInt(e.target.value, 10);
      if (!val || val < 1) { e.target.value = 1; return; }
      // Weight caps at 1000 (the server clamps too); reflect it so the field never
      // shows a value the stored weight will not match.
      if (val > 1000) { val = 1000; e.target.value = 1000; showToast(t('playlist.weight_capped'), 'info'); }
      try {
        await api.updatePlaylistItem(currentPlaylistId, itemId, { weight: val });
        refreshAfterMutation();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  const savePlayWindow = async (el, field) => {
    const itemId = el.dataset.itemId;
    const val = el.value || null;
    try {
      await api.updatePlaylistItem(currentPlaylistId, itemId, { [field]: val });
      // Was silent, which is how a "set a time frame but it still plays" report happens: the change
      // is a DRAFT and does nothing on screens until Publish. Say so, like the schedule modal does.
      showToast(t('playlist.toast.window_saved'), 'info');
      refreshAfterMutation();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };
  itemsEl.querySelectorAll('.item-play-from').forEach(input => {
    input.addEventListener('change', (e) => savePlayWindow(e.target, 'play_from'));
  });
  itemsEl.querySelectorAll('.item-play-until').forEach(input => {
    input.addEventListener('change', (e) => savePlayWindow(e.target, 'play_until'));
  });

  itemsEl.querySelectorAll('.item-remove').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const itemId = e.currentTarget.dataset.itemId;
      try {
        await api.deletePlaylistItem(currentPlaylistId, itemId);
        const playlist = await api.getPlaylist(currentPlaylistId);
        renderItems(playlist.items || []);
        refreshAfterMutation();
        showToast(t('playlist.toast.item_removed'));
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  itemsEl.querySelectorAll('.item-schedule').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const itemId = e.currentTarget.dataset.itemId;
      const item = items.find(it => String(it.id) === String(itemId));
      if (item) showScheduleModal(item);
    });
  });

  // #105 duplicate: server copies the row + its schedule blocks, appended at the end.
  itemsEl.querySelectorAll('.item-duplicate').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const itemId = e.currentTarget.dataset.itemId;
      try {
        e.currentTarget.disabled = true;
        await api.duplicatePlaylistItem(currentPlaylistId, itemId);
        const playlist = await api.getPlaylist(currentPlaylistId);
        renderItems(playlist.items || []);
        refreshAfterMutation();
        showToast(t('playlist.toast.item_duplicated'));
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  // #105 replace: reuse the add-item picker in "replace" mode — swaps content/widget
  // in place, preserving duration/schedule/zone (server-side).
  itemsEl.querySelectorAll('.item-replace').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const itemId = e.currentTarget.dataset.itemId;
      showAddItemModal(currentPlaylistId, { replaceItemId: itemId });
    });
  });

  itemsEl.querySelectorAll('.item-move').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      if (btn.disabled) return;
      const itemId = parseInt(e.currentTarget.dataset.itemId, 10);
      const dir = e.currentTarget.dataset.dir;
      const order = Array.from(itemsEl.querySelectorAll('.playlist-item'))
        .map(el => parseInt(el.dataset.itemId, 10));
      const idx = order.indexOf(itemId);
      const swap = dir === 'up' ? idx - 1 : idx + 1;
      if (swap < 0 || swap >= order.length) return;
      [order[idx], order[swap]] = [order[swap], order[idx]];
      try {
        const updated = await api.reorderPlaylistItems(currentPlaylistId, order);
        renderItems(updated);
        refreshAfterMutation();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  setupDragReorder(itemsEl);
}

/* ── Head office (corporate) editor ──────────────────────────────────────────────────────────── */

/*
 * A LOCAL SLOT row of head office's playlist: the space each store fills (spec §7.3). Drawn as a
 * dashed card with its limits and what plays when a store leaves it empty, and only the controls a
 * slot has — settings, remove, move, preview. Duration, repeat, dayparts, mute and swap belong to
 * the stores' items inside the slot, not the slot.
 */
function slotRowHtml(item, i, total) {
  const view = (corpEditor && corpEditor.slots && corpEditor.slots.get(item.slot_id)) || null;
  const raw = item.slot || {};
  const name = (view && view.name) || raw.name || t('corp.hq.slot_unnamed');
  const limits = (view && view.limits) || { max_items: raw.max_items ?? null, max_total_sec: raw.max_total_sec ?? null };
  const fb = view && view.fallback;
  const empty = fb ? t('corp.hq.slot_empty_fallback', { name: fb.name || '' }) : (raw.fallback_content_id || raw.fallback_widget_id) && !view ? '' : t('corp.hq.slot_empty_skip');
  const author = !!(corpEditor && corpEditor.canAuthor);
  const btn = (cls, label, extra = '') => `<button class="btn btn-secondary btn-sm ${cls}" data-slot-id="${esc(item.slot_id)}" ${extra}>${esc(label)}</button>`;
  return `
    <div class="playlist-item corp-slot-row" data-item-id="${item.id}" data-index="${i}" draggable="${author ? 'true' : 'false'}" style="background:var(--bg-card);border:1px dashed;border-radius:var(--radius);padding:12px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <div style="color:var(--text-muted);font-size:12px;min-width:24px;text-align:center;user-select:none">${i + 1}</div>
      <div style="flex:1;min-width:220px">
        <div style="font-size:14px;color:var(--text-primary)">${cui.chip(t('corp.badge.local_slot'), 'slot')} ${esc(t('corp.hq.slot_row', { name, limits: cui.limitsText(limits) }))}</div>
        <div class="corp-help">${esc(empty)}${view && view.fills ? ' · ' + esc(tn('corp.hq.slot_levels', view.fills)) : ''}${view && !view.live ? ' · ' + esc(t('corp.hq.slot_not_live')) : ''}</div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${author ? btn('slot-settings', t('corp.hq.slot_settings')) + btn('slot-remove', t('corp.hq.remove_slot')) : ''}
        ${btn('slot-preview', t('corp.hq.preview'))}
        ${author ? `<button class="btn-icon item-move" data-item-id="${item.id}" data-dir="up" title="${t('playlist.move_up')}" aria-label="${t('playlist.move_up')}" ${i === 0 ? 'disabled' : ''} style="color:var(--text-muted);background:none;border:none;cursor:pointer;padding:4px;${i === 0 ? 'opacity:0.3;cursor:not-allowed' : ''}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg></button>
        <button class="btn-icon item-move" data-item-id="${item.id}" data-dir="down" title="${t('playlist.move_down')}" aria-label="${t('playlist.move_down')}" ${i === total - 1 ? 'disabled' : ''} style="color:var(--text-muted);background:none;border:none;cursor:pointer;padding:4px;${i === total - 1 ? 'opacity:0.3;cursor:not-allowed' : ''}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></button>` : ''}
      </div>
    </div>`;
}

function bindSlotRows(itemsEl) {
  const slotOf = (b) => (corpEditor && corpEditor.slots.get(b.dataset.slotId)) || null;
  itemsEl.querySelectorAll('.slot-settings').forEach((b) => b.addEventListener('click', async () => {
    const pl = await api.getPlaylist(currentPlaylistId).catch(() => null);
    openSlotDialog(pl || { id: currentPlaylistId }, slotOf(b), () => refreshAfterMutation());
  }));
  itemsEl.querySelectorAll('.slot-remove').forEach((b) => b.addEventListener('click', async () => {
    const sl = slotOf(b);
    const ok = await cui.ask({
      title: t('corp.hq.remove_slot'), danger: true, confirmLabel: t('corp.hq.remove_slot'),
      text: tn('corp.hq.remove_slot_confirm', sl ? sl.fills || 0 : 0, { name: sl ? sl.name : '' }),
    });
    if (!ok) return;
    try { await api.deleteSlot(b.dataset.slotId); showToast(t('corp.hq.slot_removed'), 'success'); refreshAfterMutation(); }
    catch (e) { showToast(e.message, 'error'); }
  }));
  itemsEl.querySelectorAll('.slot-preview').forEach((b) => b.addEventListener('click', () => {
    cui.openScreenPreview({ playlistId: currentPlaylistId, canDraft: !!(corpEditor && corpEditor.canAuthor) });
  }));
}

/** The corporate / slot editor additions, loaded after the ordinary editor has rendered. */
/*
 * Head office's playlist opened by someone who can't author it (a head office editor when only org
 * admins author). Until the settings answer, it counts as read-only: an author sees the controls a
 * moment later, a non-author never sees a control that would only fail.
 */
function corpIsReadOnly() {
  return !!(corpEditor && corpEditor.mode === 'corporate' && corpEditor.canAuthor !== true);
}

/**
 * Lock every head office item row: inputs read-only, no drag, no selection, and a click on any of
 * them explains (corporate-ui.js: never a silently disabled control). Slot rows have their own.
 */
function lockCorporateRows(itemsEl) {
  itemsEl.querySelectorAll('.playlist-item').forEach((row) => {
    row.draggable = false;
    row.style.cursor = 'default';
    row.querySelectorAll('.item-select').forEach((cb) => { cb.style.display = 'none'; });
    row.querySelectorAll('input, select, button').forEach((el) => {
      if (el.classList.contains('item-select')) return;
      el.dataset.corpLocked = 'hq';
      el.title = t('corp.locked.title');
      if (el.tagName === 'INPUT') el.readOnly = true;
    });
  });
  if (itemsEl._corpLockBound) return;
  itemsEl._corpLockBound = true;
  const handler = (e) => {
    if (!corpIsReadOnly()) return;
    const el = e.target && e.target.closest && e.target.closest('[data-corp-locked="hq"]');
    if (!el) return;
    // A change that got through anyway (typed into a select) never reaches the row's own handler.
    if (e.type === 'change') { e.stopImmediatePropagation(); refreshAfterMutation(); return; }
    if (e.type === 'keydown' && !['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    // One explanation per gesture: a select opens on mousedown, everything else explains on click.
    const isSelect = el.tagName === 'SELECT';
    if (e.type === 'mousedown' && !isSelect) return;
    if (e.type === 'click' && isSelect) return;
    cui.explainLocked({ text: t('corp.hq.read_only') });
  };
  ['click', 'mousedown', 'keydown', 'change'].forEach((ev) => itemsEl.addEventListener(ev, handler, true));
}

async function mountCorporateEditor(container, playlist) {
  const bar = document.getElementById('corpEditorBar');
  if (!bar || !corpEditor) return;
  const ed = corpEditor;
  const s = await cui.corporateSettings();
  if (ed.mode === 'corporate') {
    let detail;
    try { detail = await api.getCorporatePlaylist(playlist.id); }
    catch (e) { bar.innerHTML = `<div class="corp-notice corp-notice-danger">${esc(e.message)}</div>`; return; }
    if (corpEditor !== ed || currentPlaylistId !== playlist.id) return;
    ed.slots = new Map((detail.slots || []).map((sl) => [sl.id, sl]));
    ed.screens = detail.screens || 0;
    ed.canAuthor = !!(s && s.can_author);
    bar.innerHTML = `
      <div class="corp-notice">
        ${cui.chip(t('corp.badge.corporate'), 'hq', '', { lock: true })}
        ${esc(tn('corp.hq.banner', ed.screens || 0))}
        <a class="btn btn-secondary btn-sm" href="#/corporate/where">${esc(t('corp.where.title'))}</a>
        <button class="btn btn-secondary btn-sm" id="corpPvBtn">${esc(t('corp.hq.preview'))}</button>
        ${ed.canAuthor ? '' : `<div class="corp-help" style="margin-top:6px">${esc(t('corp.hq.read_only'))}</div>`}
      </div>`;
    bar.querySelector('#corpPvBtn').addEventListener('click', () => cui.openScreenPreview({ playlistId: playlist.id, canDraft: ed.canAuthor }));
    const publishBtn = document.getElementById('publishBtn');
    if (publishBtn && ed.canAuthor && ed.screens) publishBtn.textContent = tn('corp.hq.publish_n', ed.screens);
    if (!ed.canAuthor) {
      // Approve-but-not-publish (R11): a reviewer here can approve; only an admin can publish.
      if (publishBtn) publishBtn.replaceWith(Object.assign(document.createElement('span'), { className: 'corp-help', textContent: t('corp.hq.waiting_admin') }));
      ['addItemBtn', 'deletePlaylistBtn', 'discardDraftBtn'].forEach((id) => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
      // The name and description are head office's too: a click explains instead of opening an edit.
      ['playlistTitle', 'playlistDesc'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        const copy = el.cloneNode(true);
        copy.title = t('corp.locked.title');
        copy.style.cursor = 'default';
        copy.addEventListener('click', () => cui.explainLocked({ text: t('corp.hq.read_only') }));
        el.replaceWith(copy);
      });
    }
    const addSlot = document.getElementById('addSlotBtn');
    if (addSlot && ed.canAuthor) {
      addSlot.style.display = '';
      addSlot.onclick = () => openSlotDialog(playlist, null, () => refreshAfterMutation());
    }
    renderItems(currentPlaylistItems);
    return;
  }

  // ── fill mode: the store's content for one local slot (§7.8)
  const cs = playlist.corporate_slot;
  let slotsResp = null;
  let pv = null;
  try {
    [slotsResp, pv] = await Promise.all([api.getSlotFills(cs.slot_id), api.previewFill(cs.fill_id).catch(() => null)]);
  } catch (e) { bar.innerHTML = `<div class="corp-notice corp-notice-danger">${esc(e.message)}</div>`; return; }
  if (corpEditor !== ed || currentPlaylistId !== playlist.id) return;
  const slot = slotsResp.slot || {};
  const fill = (slotsResp.fills || []).find((f) => f.id === cs.fill_id) || {};
  const limits = slot.live_limits || slot.limits || {};
  const totals = (pv && pv.draft_totals) || { items: 0, seconds: 0 };
  ed.slot = slot; ed.fill = fill; ed.limits = limits; ed.preview = pv;
  const overItems = limits.max_items != null && totals.items > limits.max_items;
  const overSec = limits.max_total_sec != null && totals.seconds > limits.max_total_sec;
  const level = cui.levelLabel(fill.scope_kind || cs.scope_kind, fill.scope_name);
  bar.innerHTML = `
    <div class="corp-card corp-slot-card">
      <div class="corp-card-head">
        <strong class="corp-card-title">${esc(t('corp.fill.title', { slot: cs.slot_name || '', playlist: cs.playlist_name || '' }))}</strong>
        ${cui.chip(level, 'slot')}
        <span class="corp-help">${esc(tn('corp.fill.plays_on', fill.screens || 0))}</span>
      </div>
      ${slot.help_text ? `<div class="corp-hq-note">${esc(t('corp.store.hq_says'))} ${esc(slot.help_text)}</div>` : ''}
      <div class="corp-meter">
        ${limits.max_items != null ? `<span class="${overItems ? 'over' : ''}">${esc(tn('corp.slot.meter_items', limits.max_items, { used: totals.items }))}</span>` : `<span>${esc(tn('corp.n_items', totals.items))}</span>`}
        ${limits.max_total_sec != null ? `<span class="${overSec ? 'over' : ''}">${esc(t('corp.slot.meter_sec', { s: totals.seconds, max: limits.max_total_sec }))}</span>` : `<span>${esc(t('corp.slot.loop_sec', { s: totals.seconds }))}</span>`}
      </div>
      <div class="corp-help">${esc(t('corp.slot.meter_note'))}${limits.allow_video === 0 || limits.allow_video === false ? ' ' + esc(t('corp.slot.no_video')) : ''}${limits.allow_widgets === 0 || limits.allow_widgets === false ? ' ' + esc(t('corp.slot.no_widgets')) : ''}</div>
      ${pv && pv.violation ? `<div class="corp-notice corp-notice-danger" style="margin-top:8px">${esc(pv.violation.error)}</div>` : ''}
      ${fill.fill_state === 'over_limit' ? `<div class="corp-notice corp-notice-danger" style="margin-top:8px">${esc(t('corp.slot.over_limit'))}</div>` : ''}
      <div class="corp-card-actions">
        <button class="btn btn-secondary btn-sm" id="corpFillPreview">${esc(t('corp.fill.preview'))}</button>
        <a class="btn btn-secondary btn-sm" href="#/corporate">${esc(t('nav.head_office'))}</a>
      </div>
    </div>`;
  bar.querySelector('#corpFillPreview').addEventListener('click', () => openFillPreview(cs.fill_id));
  const publishBtn = document.getElementById('publishBtn');
  if (publishBtn) {
    if (pv && pv.violation) {
      // Refused at publish anyway (FILL_LIMIT); the reason is on the page, not only on click.
      publishBtn.disabled = true;
      publishBtn.title = pv.violation.error;
      publishBtn.style.opacity = '0.55';
    } else if (fill.screens) publishBtn.textContent = tn('corp.hq.publish_n', fill.screens);
  }
}

/** In a slot's editor, the picker offers only what the slot can hold (content-picker.js slotMode). */
function fillSlotMode() {
  if (!corpEditor || corpEditor.mode !== 'fill') return null;
  const l = corpEditor.limits || {};
  return { allowVideo: !(l.allow_video === 0 || l.allow_video === false), allowWidgets: !(l.allow_widgets === 0 || l.allow_widgets === false) };
}

/** Head office's loop with this slot's DRAFT spliced in, for a screen that plays it (critique U3). */
async function openFillPreview(fillId) {
  const m = cui.openModal({ title: t('corp.fill.preview'), wide: true, body: `<div id="corpFpOut">${esc(t('common.loading'))}</div>` });
  try {
    const r = await api.previewFill(fillId);
    m.q('#corpFpOut').innerHTML = `${r.device_id ? '' : `<div class="corp-help">${esc(t('corp.fill.preview_no_screen'))}</div>`}${cui.previewHtml({ ...r, mandate: null, total_sec: r.total_sec != null ? r.total_sec : (r.items || []).reduce((a, i) => a + (i.seconds || 0), 0) })}`;
    hydrateAuthImages(m.overlay);
  } catch (e) { m.q('#corpFpOut').innerHTML = `<div class="corp-notice corp-notice-danger">${esc(e.message)}</div>`; }
}

function setupDragReorder(container) {
  let dragEl = null;

  container.addEventListener('dragstart', (e) => {
    if (e.target.closest('.item-select')) { e.preventDefault(); return; }
    dragEl = e.target.closest('.playlist-item');
    if (!dragEl) return;
    dragEl.style.opacity = '0.4';
    e.dataTransfer.effectAllowed = 'move';
  });

  container.addEventListener('dragend', () => {
    if (dragEl) dragEl.style.opacity = '';
    dragEl = null;
    container.querySelectorAll('.playlist-item').forEach(el => el.style.borderTop = '');
  });

  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('.playlist-item');
    container.querySelectorAll('.playlist-item').forEach(el => el.style.borderTop = '');
    if (target && target !== dragEl) {
      target.style.borderTop = '2px solid var(--primary)';
    }
  });

  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    const target = e.target.closest('.playlist-item');
    if (!target || !dragEl || target === dragEl) return;

    container.insertBefore(dragEl, target);

    const order = Array.from(container.querySelectorAll('.playlist-item'))
      .map(el => parseInt(el.dataset.itemId, 10));

    try {
      const items = await api.reorderPlaylistItems(currentPlaylistId, order);
      renderItems(items);
      refreshAfterMutation();
    } catch (err) {
      showToast(err.message, 'error');
      const playlist = await api.getPlaylist(currentPlaylistId);
      renderItems(playlist.items || []);
    }
  });
}

function inlineEdit(playlist, field) {
  const el = field === 'name' ? document.getElementById('playlistTitle') : document.getElementById('playlistDesc');
  if (!el) return;

  const current = playlist[field] || '';
  const isName = field === 'name';

  if (isName) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'input';
    input.value = current;
    input.style.cssText = 'font-size:24px;font-weight:700;padding:2px 8px;width:100%';
    el.replaceWith(input);
    input.focus();
    input.select();

    async function save() {
      const val = input.value.trim();
      if (!val) { input.value = current; return; }
      try {
        const updated = await api.updatePlaylist(playlist.id, { [field]: val });
        playlist[field] = updated[field];
      } catch (err) {
        showToast(err.message, 'error');
      }
      const newEl = document.createElement('h1');
      newEl.id = 'playlistTitle';
      newEl.style.cursor = 'pointer';
      newEl.title = t('playlist.click_to_rename');
      newEl.textContent = playlist.name;
      input.replaceWith(newEl);
      newEl.addEventListener('click', () => inlineEdit(playlist, 'name'));
    }

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = current; input.blur(); } });
  } else {
    const input = document.createElement('textarea');
    input.className = 'input';
    input.value = current;
    input.style.cssText = 'font-size:13px;padding:4px 8px;width:100%;height:40px;resize:vertical';
    el.replaceWith(input);
    input.focus();

    async function save() {
      const val = input.value.trim();
      try {
        const updated = await api.updatePlaylist(playlist.id, { description: val });
        playlist.description = updated.description;
      } catch (err) {
        showToast(err.message, 'error');
      }
      const newEl = document.createElement('div');
      newEl.className = 'subtitle';
      newEl.id = 'playlistDesc';
      newEl.style.cursor = 'pointer';
      newEl.title = t('playlist.click_to_edit_desc');
      if (playlist.description) {
        newEl.textContent = playlist.description;
      } else {
        newEl.innerHTML = `<span style="opacity:0.5">${t('playlist.add_desc_placeholder')}</span>`;
      }
      input.replaceWith(newEl);
      newEl.addEventListener('click', () => inlineEdit(playlist, 'description'));
    }

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { input.value = current; input.blur(); } });
  }
}

/*
 * The add-content picker is shared with the display page (components/content-picker.js) so the two
 * can never drift apart again. This only says where a picked item goes.
 */
function showAddItemModal(playlistId, opts = {}) {
  const replaceItemId = opts.replaceItemId || null;
  const toData = (item) => (item.type === 'widget' ? { widget_id: item.id }
    : item.type === 'playlist' ? { child_playlist_id: item.id } : { content_id: item.id });
  return openContentPicker({
    targetPlaylistId: playlistId,
    replaceItemId,
    slotMode: opts.slotMode || fillSlotMode(),
    add: (item) => api.addPlaylistItem(playlistId, toData(item)),
    addBulk: (ids) => api.addPlaylistItemsBulk(playlistId, ids),
    // #105: PUT swaps content/widget in place; the server nulls the opposite FK and keeps
    // duration/schedule/zone.
    replace: async (item) => {
      await api.updatePlaylistItem(playlistId, replaceItemId, toData(item));
      const playlist = await api.getPlaylist(playlistId);
      renderItems(playlist.items || []);
      showToast(t('playlist.toast.item_replaced'));
    },
    onChanged: () => refreshAfterMutation(),
  });
}

// #74/#75: per-item schedule editor. Multiple blocks (days + time window + optional
// date range) OR together; an item with no blocks always plays. Client validation
// mirrors the server; saving marks the playlist DRAFT (must re-publish to reach devices).
function showScheduleModal(item, opts = {}) {
  let blocks = (item.schedules || []).map(b => ({
    days: Array.isArray(b.days) ? [...b.days] : [],
    start: b.start || '00:00',
    end: b.end || '24:00',
    start_date: b.start_date || '',
    end_date: b.end_date || ''
  }));

  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000';
  document.body.appendChild(modal);

  function blockRow(b, idx) {
    const eod = b.end === '24:00';
    const dayLabels = t('itemsched.dow_short').split(',');
    return `
      <div style="border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <strong style="font-size:13px">${t('itemsched.block', { n: idx + 1 })}</strong>
          <button class="sched-remove" data-idx="${idx}" title="${t('itemsched.remove_block')}" style="color:var(--text-muted);background:none;border:none;cursor:pointer;font-size:14px">✕</button>
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px">
          ${dayLabels.map((lbl, d) => `<button class="sched-day" data-idx="${idx}" data-day="${d}" style="padding:4px 9px;border-radius:6px;font-size:12px;cursor:pointer;border:1px solid var(--border);background:${b.days.includes(d) ? 'var(--accent)' : 'var(--bg-input)'};color:${b.days.includes(d) ? '#000' : 'var(--text-muted)'}">${lbl}</button>`).join('')}
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
          <label style="font-size:12px;color:var(--text-muted)">${t('itemsched.from')} <input type="time" class="input sched-start" data-idx="${idx}" value="${esc(b.start)}" style="width:118px"></label>
          <label style="font-size:12px;color:var(--text-muted)">${t('itemsched.to')} <input type="time" class="input sched-end" data-idx="${idx}" value="${esc(eod ? '00:00' : b.end)}" ${eod ? 'disabled' : ''} style="width:118px"></label>
          <label style="font-size:12px;color:var(--text-muted)"><input type="checkbox" class="sched-eod" data-idx="${idx}" ${eod ? 'checked' : ''}> ${t('itemsched.end_of_day')}</label>
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-top:10px">
          <label style="font-size:12px;color:var(--text-muted)">${t('itemsched.starts')} <input type="date" class="input sched-sd" data-idx="${idx}" value="${esc(b.start_date)}" style="width:150px"></label>
          <label style="font-size:12px;color:var(--text-muted)">${t('itemsched.ends')} <input type="date" class="input sched-ed" data-idx="${idx}" value="${esc(b.end_date)}" style="width:150px"></label>
          <span style="font-size:11px;color:var(--text-muted)">${t('itemsched.dates_hint')}</span>
        </div>
      </div>`;
  }

  function render() {
    modal.innerHTML = `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;width:580px;max-width:94vw;max-height:88vh;overflow:auto">
        <h3 style="margin:0 0 4px">${t('itemsched.title')}</h3>
        <p style="font-size:12px;color:var(--text-muted);margin:0 0 10px">${esc(item.filename || item.widget_name || 'item')}</p>
        <p style="font-size:12px;color:#7dd3fc;background:#0c2a3f;border-radius:6px;padding:8px 10px;margin:0 0 16px">${t('itemsched.hint')}</p>
        <div>${blocks.length ? blocks.map(blockRow).join('') : `<p style="font-size:13px;color:var(--text-muted);margin:0 0 10px">${t('itemsched.none')}</p>`}</div>
        <button class="btn btn-secondary btn-sm" id="schedAddBlock" style="margin-bottom:4px">${t('itemsched.add_block')}</button>
        <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#fbbf24;background:#78350f;border:1px solid #92400e;border-radius:6px;padding:9px 11px;margin-top:16px">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <span>${t('itemsched.publish_note')}</span>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
          <button class="btn btn-secondary" id="schedCancel">${t('itemsched.cancel')}</button>
          <button class="btn" id="schedSave" style="background:#f59e0b;color:#000;font-weight:600;border:none">${t('itemsched.save')}</button>
        </div>
      </div>`;
    wire();
  }

  function wire() {
    modal.querySelectorAll('.sched-day').forEach(btn => btn.addEventListener('click', () => {
      const i = +btn.dataset.idx, d = +btn.dataset.day;
      const set = new Set(blocks[i].days);
      if (set.has(d)) set.delete(d); else set.add(d);
      blocks[i].days = [...set];
      render();
    }));
    modal.querySelectorAll('.sched-start').forEach(el => el.addEventListener('change', () => { blocks[+el.dataset.idx].start = el.value; }));
    modal.querySelectorAll('.sched-end').forEach(el => el.addEventListener('change', () => { blocks[+el.dataset.idx].end = el.value; }));
    modal.querySelectorAll('.sched-eod').forEach(el => el.addEventListener('change', () => {
      blocks[+el.dataset.idx].end = el.checked ? '24:00' : '17:00';
      render();
    }));
    modal.querySelectorAll('.sched-sd').forEach(el => el.addEventListener('change', () => { blocks[+el.dataset.idx].start_date = el.value; }));
    modal.querySelectorAll('.sched-ed').forEach(el => el.addEventListener('change', () => { blocks[+el.dataset.idx].end_date = el.value; }));
    modal.querySelectorAll('.sched-remove').forEach(btn => btn.addEventListener('click', () => { blocks.splice(+btn.dataset.idx, 1); render(); }));
    document.getElementById('schedAddBlock').addEventListener('click', () => {
      blocks.push({ days: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '17:00', start_date: '', end_date: '' });
      render();
    });
    document.getElementById('schedCancel').addEventListener('click', () => modal.remove());
    document.getElementById('schedSave').addEventListener('click', doSave);
  }

  async function doSave() {
    const payload = blocks.map(b => ({
      days: b.days, start: b.start, end: b.end,
      start_date: b.start_date || null, end_date: b.end_date || null
    }));
    const err = validateScheduleBlocks(payload);
    if (err) { showToast(err, 'error'); return; }
    try {
      if (opts.applyIds && opts.applyIds.length) {
        await api.playlistSelection(currentPlaylistId, { action: 'schedules', ids: opts.applyIds, blocks: payload });
      } else {
        const saved = await api.setItemSchedules(currentPlaylistId, item.id, payload);
        item.schedules = saved;
      }
      modal.remove();
      // Saving makes the playlist a DRAFT — surface the re-publish step explicitly.
      showToast(payload.length ? t('itemsched.toast.saved') : t('itemsched.toast.cleared'));
      const playlist = await api.getPlaylist(currentPlaylistId);
      renderItems(playlist.items || []);
      refreshAfterMutation();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  render();
}
