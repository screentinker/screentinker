/*
 * The vision mixer: run your screens like a live channel.
 *
 * Laid out as a production desk, left to right the way one is used:
 *
 *   PREVIEW  what you are about to put on air (the real player, rendering the chosen playlist)
 *   PROGRAM  what the first selected screen is showing right now (its own playlist, rendered)
 *   SOURCES  a bank of keys, one per playlist. Pressing one puts it in Preview. Nothing changes on
 *            any screen until TAKE.
 *   OUTPUTS  a bank of keys, one per screen, with its tally. Select the screens the next TAKE
 *            goes to; a group key selects its members.
 *   TAKE     puts Preview on the selected screens, now (POST /api/mixer/take). What was on
 *            Program drops into Preview, so TAKE again cuts back: the mixer's flip-flop.
 *   GRAPHICS lower third, crawl, bug and title card, keyed over the selected screens through the
 *            overlay the players already have (POST /api/pip), and CLEAR to take them off.
 *
 * Keys: 1 to 9 choose a source, Enter or Space takes, Escape clears graphics.
 * The server does the work and enforces the rules (routes/mixer.js); this is the desk.
 */
import { api } from '../api.js';
import { t } from '../i18n.js';
import { esc } from '../utils.js';
import { showToast } from '../components/toast.js';

let state = null;            // { screens, groups, sources, graphics }
let pvw = null;              // playlist id in Preview
let outputs = new Set();     // selected screen ids
let onKey = null;
let refreshTimer = null;
let alive = false;

const call = (path, opts) => api.request ? api.request(path, opts) : fetch('/api' + path, {
  ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
}).then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d; });

const frame = (src) => `<iframe class="mx-frame" src="${src}" title="" tabindex="-1"></iframe>`;
const firstOutput = () => (state ? state.screens.find((s) => outputs.has(s.id)) : null);
const sourceName = (id) => { const s = state && state.sources.find((x) => x.id === id); return s ? s.name : ''; };

function tallyOf(s) {
  if (s.status === 'online') return 'air';
  return s.status === 'offline' ? 'off' : 'standby';
}

function draw(root) {
  const pgm = firstOutput();
  root.innerHTML = `
    <div class="page-header">
      <div><h1>${esc(t('mixer.title'))}</h1><div class="subtitle">${esc(t('mixer.subtitle'))}</div></div>
    </div>
    <div class="mx">
      <section class="mx-monitors">
        <div class="mx-mon mx-pvw">
          <div class="mx-mon-label"><span class="mx-lamp mx-lamp-pvw"></span>${esc(t('mixer.preview'))}<b>${esc(pvw ? sourceName(pvw) : t('mixer.nothing_selected'))}</b></div>
          <div class="mx-screen">${pvw ? frame(`/player?preview=1&playlist=${encodeURIComponent(pvw)}&orientation=landscape&t=${Date.now()}`) : `<div class="mx-empty">${esc(t('mixer.pick_source'))}</div>`}</div>
        </div>
        <div class="mx-take-col">
          <button type="button" class="btn mx-take" id="mxTake" ${pvw && outputs.size ? '' : 'disabled'}>${esc(t('mixer.take'))}</button>
          <div class="mx-take-hint">${esc(outputs.size ? t('mixer.to_n_screens', { n: outputs.size }) : t('mixer.pick_output'))}</div>
        </div>
        <div class="mx-mon mx-pgm">
          <div class="mx-mon-label"><span class="mx-lamp mx-lamp-pgm"></span>${esc(t('mixer.program'))}<b>${esc(pgm ? `${pgm.name}${pgm.playlist_name ? ': ' + pgm.playlist_name : ''}` : t('mixer.nothing_selected'))}</b></div>
          <div class="mx-screen">${pgm ? frame(`/player?preview=1&device=${encodeURIComponent(pgm.id)}&t=${Date.now()}`) : `<div class="mx-empty">${esc(t('mixer.pick_output'))}</div>`}</div>
        </div>
      </section>

      <section class="mx-bank">
        <h3>${esc(t('mixer.sources'))}</h3>
        <div class="mx-keys">
          ${state.sources.length ? state.sources.map((s, i) => `
            <button type="button" class="mx-key mx-src${s.id === pvw ? ' is-pvw' : ''}${pgm && pgm.playlist_id === s.id ? ' is-pgm' : ''}" data-src="${esc(s.id)}" title="${esc(s.name)}">
              <span class="mx-key-n">${i < 9 ? i + 1 : ''}</span><span class="mx-key-name">${esc(s.name)}</span><span class="mx-key-sub">${esc(t('mixer.n_items', { n: s.items }))}</span>
            </button>`).join('') : `<p class="mx-note">${esc(t('mixer.no_sources'))}</p>`}
        </div>
      </section>

      <section class="mx-bank">
        <h3>${esc(t('mixer.outputs'))}
          <span class="mx-bank-actions">
            <button type="button" class="btn btn-secondary btn-sm" id="mxAll">${esc(t('mixer.all'))}</button>
            <button type="button" class="btn btn-secondary btn-sm" id="mxNone">${esc(t('mixer.none'))}</button>
            ${state.groups.filter((g) => g.device_ids.length).map((g) => `<button type="button" class="btn btn-secondary btn-sm" data-group="${esc(g.id)}">${esc(g.name)}</button>`).join('')}
          </span>
        </h3>
        <div class="mx-keys">
          ${state.screens.length ? state.screens.map((s) => `
            <button type="button" class="mx-key mx-out mx-tally-${tallyOf(s)}${outputs.has(s.id) ? ' is-on' : ''}" data-out="${esc(s.id)}" aria-pressed="${outputs.has(s.id)}" title="${esc(s.name)}">
              <span class="mx-key-tally"></span><span class="mx-key-name">${esc(s.name)}</span><span class="mx-key-sub">${esc(s.playlist_name || t('mixer.no_playlist'))}</span>
            </button>`).join('') : `<p class="mx-note">${esc(t('mixer.no_screens'))}</p>`}
        </div>
      </section>

      <section class="mx-bank mx-gfx">
        <h3>${esc(t('mixer.graphics'))}</h3>
        <div class="mx-gfx-row">
          <label>${esc(t('mixer.gfx_line1'))}<input class="input" id="mxA" maxlength="120" value="${esc(sessionStorage.getItem('mx_a') || '')}" placeholder="${esc(t('mixer.gfx_line1_ph'))}"></label>
          <label>${esc(t('mixer.gfx_line2'))}<input class="input" id="mxB" maxlength="200" value="${esc(sessionStorage.getItem('mx_b') || '')}" placeholder="${esc(t('mixer.gfx_line2_ph'))}"></label>
          <label class="mx-gfx-colour">${esc(t('mixer.gfx_colour'))}<input type="color" id="mxC" value="${esc(sessionStorage.getItem('mx_c') || '#ff2a1f')}"></label>
        </div>
        <div class="mx-keys">
          ${state.graphics.map((g) => `<button type="button" class="mx-key mx-gfx-key" data-gfx="${esc(g.kind)}"><span class="mx-key-name">${esc(t(`mixer.gfx.${g.kind}`))}</span><span class="mx-key-sub">${esc(t(`mixer.gfx.${g.kind}.sub`))}</span></button>`).join('')}
          <button type="button" class="mx-key mx-gfx-clear" id="mxClear"><span class="mx-key-name">${esc(t('mixer.gfx_clear'))}</span><span class="mx-key-sub">Esc</span></button>
        </div>
        <p class="mx-note">${esc(t('mixer.gfx_note'))}</p>
      </section>
    </div>`;
  bind(root);
}

async function take(root) {
  if (!pvw || !outputs.size) return;
  const before = firstOutput();
  const cutBackTo = before && before.playlist_id && before.playlist_id !== pvw ? before.playlist_id : null;
  const btn = root.querySelector('#mxTake');
  if (btn) btn.disabled = true;
  try {
    const r = await call('/mixer/take', { method: 'POST', body: JSON.stringify({ device_ids: [...outputs], playlist_id: pvw }) });
    const n = (r.taken || []).length, skipped = (r.skipped || []).length;
    showToast(skipped ? t('mixer.toast.taken_skipped', { n, name: r.playlist.name, skipped }) : t('mixer.toast.taken', { n, name: r.playlist.name }), n ? 'success' : 'warning');
    for (const tk of r.taken || []) { const s = state.screens.find((x) => x.id === tk.device_id); if (s) { s.playlist_id = r.playlist.id; s.playlist_name = r.playlist.name; } }
    // Flip-flop: what was on Program is now in Preview, one key press from going back.
    if (cutBackTo && state.sources.some((s) => s.id === cutBackTo)) pvw = cutBackTo;
  } catch (err) { showToast(err.message, 'error'); }
  if (alive) draw(root);
}

async function key(root, kind) {
  if (!outputs.size) { showToast(t('mixer.pick_output'), 'info'); return; }
  const a = root.querySelector('#mxA').value.trim();
  const b = root.querySelector('#mxB').value.trim();
  const accent = root.querySelector('#mxC').value;
  if (!a) { showToast(t('mixer.gfx_need_text'), 'info'); root.querySelector('#mxA').focus(); return; }
  const g = state.graphics.find((x) => x.kind === kind);
  const W = 1920, H = 1080;
  const uri = `${window.location.origin}/gfx/${encodeURIComponent(kind)}?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}&accent=${encodeURIComponent(accent)}`;
  let ok = 0, failed = 0;
  await Promise.all([...outputs].map(async (id) => {
    try {
      await call('/pip', { method: 'POST', body: JSON.stringify({ device_id: id, type: 'web', uri, position: g.box.position,
        width: Math.round(W * g.box.w), height: Math.round(H * g.box.h), duration: 0, opacity: 1, border_radius: 0 }) });
      ok++;
    } catch { failed++; }
  }));
  showToast(failed ? t('mixer.toast.gfx_partial', { ok, failed }) : t('mixer.toast.gfx_on', { n: ok }), failed ? 'warning' : 'success');
}

async function clearGfx() {
  if (!outputs.size) return;
  await Promise.all([...outputs].map((id) => call('/pip/clear', { method: 'POST', body: JSON.stringify({ device_id: id }) }).catch(() => null)));
  showToast(t('mixer.toast.gfx_off'), 'info');
}

function bind(root) {
  root.querySelectorAll('[data-src]').forEach((b) => b.addEventListener('click', () => { pvw = b.dataset.src; draw(root); }));
  root.querySelectorAll('[data-out]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.out; if (outputs.has(id)) outputs.delete(id); else outputs.add(id); draw(root);
  }));
  root.querySelectorAll('[data-group]').forEach((b) => b.addEventListener('click', () => {
    const g = state.groups.find((x) => x.id === b.dataset.group); if (!g) return;
    outputs = new Set(g.device_ids.filter((id) => state.screens.some((s) => s.id === id))); draw(root);
  }));
  const all = root.querySelector('#mxAll'); if (all) all.addEventListener('click', () => { outputs = new Set(state.screens.map((s) => s.id)); draw(root); });
  const none = root.querySelector('#mxNone'); if (none) none.addEventListener('click', () => { outputs = new Set(); draw(root); });
  const tk = root.querySelector('#mxTake'); if (tk) tk.addEventListener('click', () => take(root));
  root.querySelectorAll('[data-gfx]').forEach((b) => b.addEventListener('click', () => key(root, b.dataset.gfx)));
  const cl = root.querySelector('#mxClear'); if (cl) cl.addEventListener('click', clearGfx);
  for (const [id, k] of [['mxA', 'mx_a'], ['mxB', 'mx_b'], ['mxC', 'mx_c']]) {
    const el = root.querySelector('#' + id); if (el) el.addEventListener('input', () => { try { sessionStorage.setItem(k, el.value); } catch { /* */ } });
  }
}

export async function render(container) {
  alive = true;
  container.innerHTML = `<div class="empty-state"><h3>${esc(t('common.loading'))}</h3></div>`;
  try { state = await call('/mixer'); } catch (err) {
    container.innerHTML = `<div class="empty-state"><h3>${esc(t('mixer.title'))}</h3><p>${esc(err.message)}</p></div>`;
    return;
  }
  if (!alive) return;
  outputs = new Set([...outputs].filter((id) => state.screens.some((s) => s.id === id)));
  if (pvw && !state.sources.some((s) => s.id === pvw)) pvw = null;
  draw(container);

  onKey = (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^[1-9]$/.test(e.key)) { const s = state.sources[Number(e.key) - 1]; if (s) { pvw = s.id; draw(container); e.preventDefault(); } }
    else if (e.key === 'Enter' || e.key === ' ') { if (tag !== 'BUTTON') { e.preventDefault(); take(container); } }
    else if (e.key === 'Escape') clearGfx();
  };
  document.addEventListener('keydown', onKey);
  // Tally follows the room: refresh which screens are up without redrawing the monitors.
  refreshTimer = setInterval(async () => {
    if (!alive || document.hidden) return;
    try {
      const fresh = await call('/mixer');
      const changed = JSON.stringify(fresh.screens.map((s) => [s.id, s.status, s.playlist_id])) !== JSON.stringify(state.screens.map((s) => [s.id, s.status, s.playlist_id]))
        || fresh.sources.length !== state.sources.length;
      state = fresh;
      if (changed && alive) draw(container);
    } catch { /* keep the desk as it is */ }
  }, 10000);
}

export function cleanup() {
  alive = false;
  if (onKey) document.removeEventListener('keydown', onKey);
  onKey = null;
  clearInterval(refreshTimer); refreshTimer = null;
}
