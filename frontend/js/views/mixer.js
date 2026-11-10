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

let state = null;            // { screens, groups, sources, graphics, streams }
let so = null;               // GET /api/stream-out: what streaming is possible here, and the outputs
let addingStream = false;
let cued = null;             // the scene waiting on TAKE, if one was recalled
let savingScene = false;
let cam = null;              // the camera being steered: { id, presets, last: { preset, name } | null }
let camSpeed = 0.5;
let holdTimer = null;
let meterTimer = null;
const volumes = new Map();   // screen id -> { level 0..100, muted } as last set from this desk
let pvw = null;              // playlist id in Preview
let outputs = new Set();     // selected screen ids
let onKey = null;
let refreshTimer = null;
let alive = false;

const call = (path, opts) => api.request ? api.request(path, opts) : fetch('/api' + path, {
  ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
}).then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d; });

const frame = (src) => `<iframe class="mx-frame" src="${src}" title="" tabindex="-1"></iframe>`;
const streams = () => (so && so.outputs) || [];
const firstOutput = () => (state ? (state.screens.find((s) => outputs.has(s.id)) || streams().find((s) => outputs.has(s.id))) : null);
const isStream = (o) => !!o && streams().includes(o);
const streamTally = (s) => (s.status.state === 'live' ? 'air' : s.status.state === 'off' ? 'idle' : 'standby');
async function load() {
  const [m, s] = await Promise.all([call('/mixer'), call('/stream-out').catch(() => null)]);
  so = s; return m;
}
const sourceName = (id) => { const s = state && state.sources.find((x) => x.id === id); return s ? s.name : ''; };

function tallyOf(s) {
  if (s.status === 'online') return 'air';
  return s.status === 'offline' ? 'off' : 'standby';
}

const cuedScene = () => (cued && state.scenes.find((s) => s.id === cued)) || null;
const DIRS = [[-1, 1, '↖'], [0, 1, '↑'], [1, 1, '↗'], [-1, 0, '←'], null, [1, 0, '→'], [-1, -1, '↙'], [0, -1, '↓'], [1, -1, '↘']];

function draw(root) {
  const pgm = firstOutput();
  const scene = cuedScene();
  const selScreens = state.screens.filter((s) => outputs.has(s.id));
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
          <button type="button" class="btn mx-take" id="mxTake" ${(pvw || scene) && outputs.size ? '' : 'disabled'}>${esc(t('mixer.take'))}</button>
          <div class="mx-take-hint">${esc(outputs.size ? t('mixer.to_n_screens', { n: outputs.size }) : t('mixer.pick_output'))}${scene ? `<br><b>${esc(t('mixer.scene_cued', { name: scene.name }))}</b>` : ''}</div>
        </div>
        <div class="mx-mon mx-pgm">
          <div class="mx-mon-label"><span class="mx-lamp mx-lamp-pgm"></span>${esc(t('mixer.program'))}<b>${esc(pgm ? `${pgm.name}${pgm.playlist_name ? ': ' + pgm.playlist_name : ''}` : t('mixer.nothing_selected'))}</b></div>
          <div class="mx-screen">${pgm && isStream(pgm) ? (pgm.playlist_id ? frame(`/player?preview=1&playlist=${encodeURIComponent(pgm.playlist_id)}&orientation=landscape&t=${Date.now()}`) : `<div class="mx-empty">${esc(t('mixer.stream_no_source'))}</div>`) : pgm ? frame(`/player?preview=1&device=${encodeURIComponent(pgm.id)}&t=${Date.now()}`) : `<div class="mx-empty">${esc(t('mixer.pick_output'))}</div>`}</div>
        </div>
      </section>

      <section class="mx-bank">
        <h3>${esc(t('mixer.scenes'))}<span class="mx-bank-actions"><button type="button" class="btn btn-secondary btn-sm" id="mxSaveScene">${esc(t('mixer.scene_save'))}</button></span></h3>
        ${savingScene ? `<form class="mx-stream-form" id="mxSceneForm">
          <label>${esc(t('mixer.scene_name'))}<input class="input" name="name" maxlength="60" required placeholder="${esc(t('mixer.scene_name_ph'))}"></label>
          <label>${esc(t('mixer.scene_source'))}<input class="input" value="${esc(pvw ? sourceName(pvw) : t('mixer.scene_no_source'))}" disabled></label>
          <label>${esc(t('mixer.scene_graphic'))}<select class="input" name="gfx"><option value="">${esc(t('mixer.scene_no_graphic'))}</option>${state.graphics.map((g) => `<option value="${esc(g.kind)}">${esc(t(`mixer.gfx.${g.kind}`))}</option>`).join('')}</select></label>
          ${cam && cam.last ? `<label class="mx-check"><input type="checkbox" name="cam" checked> ${esc(t('mixer.scene_camera', { camera: (state.cameras.find((c) => c.id === cam.id) || {}).name || '', preset: cam.last.name }))}</label>` : ''}
          <div class="mx-stream-form-actions"><button type="submit" class="btn btn-primary btn-sm">${esc(t('mixer.scene_save_do'))}</button><button type="button" class="btn btn-secondary btn-sm" id="mxSceneCancel">${esc(t('common.cancel'))}</button></div>
        </form>` : ''}
        <div class="mx-keys">
          ${state.scenes.length ? state.scenes.map((s) => `
            <div class="mx-scene-wrap"><button type="button" class="mx-key mx-scene${s.id === cued ? ' is-pvw' : ''}" data-scene="${esc(s.id)}" title="${esc(s.name)}">
              <span class="mx-key-name">${esc(s.name)}</span><span class="mx-key-sub">${esc([s.playlist_id ? sourceName(s.playlist_id) : '', s.graphic ? t(`mixer.gfx.${s.graphic.kind}`) : '', s.cameras.length ? t('mixer.scene_n_cameras', { n: s.cameras.length }) : ''].filter(Boolean).join(', '))}</span>
            </button><button type="button" class="mx-scene-del" data-scene-del="${esc(s.id)}" aria-label="${esc(t('mixer.scene_delete', { name: s.name }))}" title="${esc(t('mixer.scene_delete', { name: s.name }))}">×</button></div>`).join('') : (savingScene ? '' : `<p class="mx-note mx-note-top">${esc(t('mixer.scene_none'))}</p>`)}
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
            </button>`).join('') : (streams().length ? '' : `<p class="mx-note">${esc(t('mixer.no_screens'))}</p>`)}
          ${streams().map((s) => `
            <button type="button" class="mx-key mx-out mx-stream mx-tally-${streamTally(s)}${outputs.has(s.id) ? ' is-on' : ''}" data-out="${esc(s.id)}" aria-pressed="${outputs.has(s.id)}" title="${esc(s.name)}">
              <span class="mx-key-tally"></span><span class="mx-key-name">${esc(s.name)}</span><span class="mx-key-sub">${esc(s.kind_label)}: ${esc(s.playlist_name || t('mixer.no_playlist'))}</span>
            </button>`).join('')}
        </div>
      </section>

      ${so ? `<section class="mx-bank mx-streams">
        <h3>${esc(t('mixer.streams'))}${so.available ? `<span class="mx-bank-actions"><button type="button" class="btn btn-secondary btn-sm" id="mxAddStream">${esc(t('mixer.stream_add'))}</button></span>` : ''}</h3>
        ${!so.available ? `<p class="mx-note mx-note-top">${esc(t('mixer.stream_unavailable.' + so.reason))}</p>` : `
          ${streams().length ? `<div class="mx-stream-list">${streams().map((s) => `
            <div class="mx-stream-row" data-stream-row="${esc(s.id)}">
              <span class="mx-lamp mx-lamp-${streamTally(s)}"></span>
              <div class="mx-stream-what"><b>${esc(s.name)}</b><span>${esc(s.kind_label)}${s.url ? ' · ' + esc(s.url) : ''} · ${s.height}p${s.fps} · ${s.bitrate_k} kbps</span>
                ${s.status.error || s.status.last_error ? `<span class="mx-stream-err">${esc(s.status.error || s.status.last_error)}</span>` : ''}</div>
              <span class="mx-stream-state">${esc(t('mixer.stream_state.' + s.status.state))}</span>
              ${s.status.state === 'off'
                ? `<button type="button" class="btn btn-sm mx-golive" data-go="${esc(s.id)}">${esc(t('mixer.stream_go'))}</button><button type="button" class="btn btn-secondary btn-sm" data-del="${esc(s.id)}">${esc(t('common.delete'))}</button>`
                : `<button type="button" class="btn btn-secondary btn-sm" data-stop="${esc(s.id)}">${esc(t('mixer.stream_stop'))}</button>`}
            </div>`).join('')}</div>` : (addingStream ? '' : `<p class="mx-note mx-note-top">${esc(t('mixer.stream_none'))}</p>`)}
          ${addingStream ? `<form class="mx-stream-form" id="mxStreamForm">
            <label>${esc(t('mixer.stream_name'))}<input class="input" name="name" maxlength="80" required placeholder="${esc(t('mixer.stream_name_ph'))}"></label>
            <label>${esc(t('mixer.stream_to'))}<select class="input" name="kind">${so.kinds.map((k) => `<option value="${esc(k.kind)}" data-url="${k.needs_url ? 1 : 0}">${esc(k.label)}</option>`).join('')}</select></label>
            <label class="mx-stream-url" hidden>${esc(t('mixer.stream_url'))}<input class="input" name="url" maxlength="500" placeholder="rtmp://"></label>
            <label>${esc(t('mixer.stream_key'))}<input class="input" name="key" type="password" autocomplete="off" maxlength="600"></label>
            <label>${esc(t('mixer.stream_size'))}<select class="input" name="size">${so.sizes.map((z) => `<option value="${z.width}x${z.height}">${z.height}p</option>`).join('')}</select></label>
            <div class="mx-stream-form-actions"><button type="submit" class="btn btn-primary btn-sm">${esc(t('mixer.stream_save'))}</button><button type="button" class="btn btn-secondary btn-sm" id="mxStreamCancel">${esc(t('common.cancel'))}</button></div>
          </form>` : ''}
          <p class="mx-note">${esc(t('mixer.stream_note', { max: so.max }))}</p>
          ${so.ffmpeg && so.ffmpeg.licence && so.ffmpeg.licence !== 'lgpl' ? `<p class="mx-note mx-licence" role="note"><b>${esc(t('mixer.licence_title'))}</b> ${esc(t('mixer.licence_' + so.ffmpeg.licence, { version: so.ffmpeg.version || '' }))}</p>`
            : `<p class="mx-note">${esc(t('mixer.licence_lgpl'))}</p>`}`}
      </section>` : ''}

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

      <div class="mx-pair">
      <section class="mx-bank mx-cams">
        <h3>${esc(t('mixer.cameras'))}</h3>
        ${state.cameras.length ? `
          <div class="mx-keys">${state.cameras.map((c) => `<button type="button" class="mx-key${cam && cam.id === c.id ? ' is-on mx-out' : ''}" data-cam="${esc(c.id)}"><span class="mx-key-name">${esc(c.name)}</span></button>`).join('')}</div>
          ${cam ? `<div class="mx-cam-desk">
            <div class="mx-pad" role="group" aria-label="${esc(t('mixer.cam_move'))}">${DIRS.map((d) => (d
              ? `<button type="button" class="mx-pad-key" data-pan="${d[0]}" data-tilt="${d[1]}" aria-label="${esc(t('mixer.cam_move'))} ${d[2]}">${d[2]}</button>`
              : `<button type="button" class="mx-pad-key mx-pad-home" id="mxCamHome">${esc(t('mixer.cam_home'))}</button>`)).join('')}</div>
            <div class="mx-cam-side">
              <div class="mx-zoom"><button type="button" class="mx-pad-key" data-zoom="1">${esc(t('mixer.cam_zoom_in'))}</button><button type="button" class="mx-pad-key" data-zoom="-1">${esc(t('mixer.cam_zoom_out'))}</button></div>
              <label class="mx-speed">${esc(t('mixer.cam_speed'))}<input type="range" id="mxCamSpeed" min="10" max="100" step="5" value="${Math.round(camSpeed * 100)}"></label>
            </div>
            <div class="mx-presets"><span class="mx-presets-label">${esc(t('mixer.cam_presets'))}</span>
              ${cam.presets === null ? `<span class="mx-note">${esc(t('common.loading'))}</span>` : cam.presets.length ? cam.presets.map((p) => `<button type="button" class="mx-key mx-preset${cam.last && cam.last.preset === p.token ? ' is-pvw' : ''}" data-preset="${esc(p.token)}" data-preset-name="${esc(p.name || p.token)}"><span class="mx-key-name">${esc(p.name || p.token)}</span></button>`).join('') : `<span class="mx-note">${esc(t('mixer.cam_no_presets'))}</span>`}
            </div>
          </div>` : `<p class="mx-note">${esc(t('mixer.cam_pick'))}</p>`}` : `<p class="mx-note mx-note-top">${esc(t('mixer.cam_none'))}</p>`}
      </section>

      <section class="mx-bank mx-audio">
        <h3>${esc(t('mixer.audio'))}</h3>
        ${selScreens.length || streams().length ? `<div class="mx-strips">
          ${selScreens.slice(0, 12).map((s) => { const v = volumes.get(s.id) || { level: 100, muted: false }; return `
            <div class="mx-strip${v.muted ? ' is-muted' : ''}"><span class="mx-strip-name" title="${esc(s.name)}">${esc(s.name)}</span>
              <input type="range" class="mx-fader" min="0" max="100" value="${v.level}" data-vol="${esc(s.id)}" aria-label="${esc(t('mixer.audio_level_of', { name: s.name }))}">
              <span class="mx-strip-val">${v.muted ? esc(t('mixer.audio_muted')) : v.level + '%'}</span>
              <button type="button" class="mx-mute${v.muted ? ' is-on' : ''}" data-mute="${esc(s.id)}" aria-pressed="${v.muted}">${esc(t('mixer.audio_mute'))}</button></div>`; }).join('')}
          ${streams().map((s) => `
            <div class="mx-strip mx-strip-stream${s.audio.muted ? ' is-muted' : ''}"><span class="mx-strip-name" title="${esc(s.name)}">${esc(s.name)}</span>
              <div class="mx-meter" aria-hidden="true"><i data-meter="${esc(s.id)}" style="height:${Math.round(Math.min(1, s.status.audio_peak || 0) * 100)}%"></i></div>
              <input type="range" class="mx-fader" min="0" max="${Math.round((so.max_level || 1.5) * 100)}" value="${Math.round(s.audio.level * 100)}" data-svol="${esc(s.id)}" aria-label="${esc(t('mixer.audio_level_of', { name: s.name }))}">
              <span class="mx-strip-val">${s.audio.muted ? esc(t('mixer.audio_muted')) : Math.round(s.audio.level * 100) + '%'}</span>
              <button type="button" class="mx-mute${s.audio.muted ? ' is-on' : ''}" data-smute="${esc(s.id)}" aria-pressed="${s.audio.muted}">${esc(t('mixer.audio_mute'))}</button>
              <select class="input mx-bed" data-bed="${esc(s.id)}" aria-label="${esc(t('mixer.audio_bed'))}"><option value="">${esc(t('mixer.audio_silence'))}</option>${(so.audio_sources || []).map((a) => `<option value="${esc(a.id)}"${a.id === s.audio.content_id ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>`).join('')}
        </div>
        <p class="mx-note">${esc(t('mixer.audio_note'))}</p>` : `<p class="mx-note mx-note-top">${esc(t('mixer.audio_none'))}</p>`}
      </section>
      </div>
    </div>`;
  bind(root);
}

async function take(root) {
  const scene = cuedScene();
  if ((!pvw && !scene) || !outputs.size) return;
  if (!pvw) { await applyScene(root, scene); cued = null; if (alive) draw(root); return; }
  const before = firstOutput();
  const cutBackTo = before && before.playlist_id && before.playlist_id !== pvw ? before.playlist_id : null;
  const btn = root.querySelector('#mxTake');
  if (btn) btn.disabled = true;
  try {
    const streamIds = streams().filter((s) => outputs.has(s.id)).map((s) => s.id);
    const r = await call('/mixer/take', { method: 'POST', body: JSON.stringify({ device_ids: [...outputs].filter((id) => !streamIds.includes(id)), stream_ids: streamIds, playlist_id: pvw }) });
    for (const tk of r.streams || []) { const s = streams().find((x) => x.id === tk.stream_id); if (s) { s.playlist_id = r.playlist.id; s.playlist_name = r.playlist.name; } }
    const n = (r.taken || []).length + (r.streams || []).length, skipped = (r.skipped || []).length;
    showToast(skipped ? t('mixer.toast.taken_skipped', { n, name: r.playlist.name, skipped }) : t('mixer.toast.taken', { n, name: r.playlist.name }), n ? 'success' : 'warning');
    for (const tk of r.taken || []) { const s = state.screens.find((x) => x.id === tk.device_id); if (s) { s.playlist_id = r.playlist.id; s.playlist_name = r.playlist.name; } }
    // Flip-flop: what was on Program is now in Preview, one key press from going back.
    if (cutBackTo && state.sources.some((s) => s.id === cutBackTo)) pvw = cutBackTo;
    if (scene) { await applyScene(root, scene); cued = null; }
  } catch (err) { showToast(err.message, 'error'); }
  if (alive) draw(root);
}

/** The rest of a scene, once its source is on air: its graphic (or none) and its camera positions. */
async function applyScene(root, scene) {
  if (scene.graphic) await key(root, scene.graphic.kind, scene.graphic); else await clearGfx(true);
  await Promise.all(scene.cameras.map((c) => call(`/onvif/cameras/${encodeURIComponent(c.camera_id)}/ptz`, { method: 'POST', body: JSON.stringify({ action: 'preset', preset: c.preset }) })
    .catch((err) => showToast(t('mixer.toast.cam_failed', { error: err.message }), 'warning'))));
}

async function key(root, kind, given) {
  if (!outputs.size) { showToast(t('mixer.pick_output'), 'info'); return; }
  const a = given ? given.a : root.querySelector('#mxA').value.trim();
  const b = given ? given.b : root.querySelector('#mxB').value.trim();
  const accent = given ? given.accent : root.querySelector('#mxC').value;
  if (!a) { showToast(t('mixer.gfx_need_text'), 'info'); root.querySelector('#mxA').focus(); return; }
  const g = state.graphics.find((x) => x.kind === kind);
  const W = 1920, H = 1080;
  const uri = `${window.location.origin}/gfx/${encodeURIComponent(kind)}?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}&accent=${encodeURIComponent(accent)}`;
  let ok = 0, failed = 0;
  await Promise.all([...outputs].map(async (id) => {
    try {
      if (streams().some((s) => s.id === id)) await call(`/stream-out/${encodeURIComponent(id)}/gfx`, { method: 'POST', body: JSON.stringify({ kind, a, b, accent }) });
      else await call('/pip', { method: 'POST', body: JSON.stringify({ device_id: id, type: 'web', uri, position: g.box.position, keyed: true,
        width: Math.round(W * g.box.w), height: Math.round(H * g.box.h), duration: 0, opacity: 1, border_radius: 0 }) });
      ok++;
    } catch { failed++; }
  }));
  showToast(failed ? t('mixer.toast.gfx_partial', { ok, failed }) : t('mixer.toast.gfx_on', { n: ok }), failed ? 'warning' : 'success');
}

async function clearGfx(quiet) {
  if (!outputs.size) return;
  await Promise.all([...outputs].map((id) => (streams().some((s) => s.id === id)
    ? call(`/stream-out/${encodeURIComponent(id)}/gfx/clear`, { method: 'POST' })
    : call('/pip/clear', { method: 'POST', body: JSON.stringify({ device_id: id }) })).catch(() => null)));
  if (quiet !== true) showToast(t('mixer.toast.gfx_off'), 'info');
}

// ── cameras ──────────────────────────────────────────────────────────────────────────────────────
const ptz = (body) => call(`/onvif/cameras/${encodeURIComponent(cam.id)}/ptz`, { method: 'POST', body: JSON.stringify(body) });
/** Move while a key is held. The camera stops itself a second after the last order, so a lost
 *  "stop" cannot leave it turning; while held, the order is repeated before that second is up. */
function holdMove(vec) {
  releaseMove(false);
  const send = () => ptz({ action: 'move', pan: vec.pan * camSpeed, tilt: vec.tilt * camSpeed, zoom: vec.zoom * camSpeed, timeout: 1 }).catch((err) => { releaseMove(false); showToast(err.message, 'error'); });
  send(); holdTimer = setInterval(send, 700);
}
function releaseMove(stop = true) {
  if (!holdTimer) return;
  clearInterval(holdTimer); holdTimer = null;
  if (stop && cam) ptz({ action: 'stop' }).catch(() => {});
}

function bind(root) {
  root.querySelectorAll('[data-src]').forEach((b) => b.addEventListener('click', () => { pvw = b.dataset.src; cued = null; draw(root); }));
  // Scenes: recall one into Preview (TAKE puts it on air), save the desk as one, remove one.
  root.querySelectorAll('[data-scene]').forEach((b) => b.addEventListener('click', () => {
    const s = state.scenes.find((x) => x.id === b.dataset.scene); if (!s) return;
    cued = s.id;
    if (s.playlist_id && state.sources.some((x) => x.id === s.playlist_id)) pvw = s.playlist_id;
    if (s.graphic) { try { sessionStorage.setItem('mx_a', s.graphic.a); sessionStorage.setItem('mx_b', s.graphic.b || ''); sessionStorage.setItem('mx_c', s.graphic.accent); } catch { /* */ } }
    draw(root);
  }));
  root.querySelectorAll('[data-scene-del]').forEach((b) => b.addEventListener('click', async () => {
    try { await call(`/mixer/scenes/${encodeURIComponent(b.dataset.sceneDel)}`, { method: 'DELETE' }); state.scenes = state.scenes.filter((s) => s.id !== b.dataset.sceneDel); if (cued === b.dataset.sceneDel) cued = null; }
    catch (err) { showToast(err.message, 'error'); }
    draw(root);
  }));
  const saveScene = root.querySelector('#mxSaveScene'); if (saveScene) saveScene.addEventListener('click', () => { savingScene = true; draw(root); const f = root.querySelector('#mxSceneForm [name=name]'); if (f) f.focus(); });
  const sceneForm = root.querySelector('#mxSceneForm');
  if (sceneForm) {
    root.querySelector('#mxSceneCancel').addEventListener('click', () => { savingScene = false; draw(root); });
    sceneForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(sceneForm), kind = f.get('gfx');
      const a = root.querySelector('#mxA').value.trim();
      if (kind && !a) { showToast(t('mixer.gfx_need_text'), 'info'); return; }
      try {
        const made = await call('/mixer/scenes', { method: 'POST', body: JSON.stringify({
          name: f.get('name'), playlist_id: pvw,
          graphic: kind ? { kind, a, b: root.querySelector('#mxB').value.trim(), accent: root.querySelector('#mxC').value } : null,
          cameras: f.get('cam') && cam && cam.last ? [{ camera_id: cam.id, preset: cam.last.preset, preset_name: cam.last.name }] : [],
        }) });
        state.scenes.push(made); savingScene = false; showToast(t('mixer.toast.scene_saved', { name: made.name }), 'success'); draw(root);
      } catch (err) { showToast(err.message, 'error'); }
    });
  }
  // Cameras: choose one, steer it while a key is held, recall its presets.
  root.querySelectorAll('[data-cam]').forEach((b) => b.addEventListener('click', async () => {
    releaseMove();
    cam = { id: b.dataset.cam, presets: null, last: null }; draw(root);
    const mine = cam;
    try { mine.presets = (await call(`/onvif/cameras/${encodeURIComponent(mine.id)}/presets`)).presets || []; }
    catch (err) { mine.presets = []; showToast(err.message, 'error'); }
    if (alive && cam === mine) draw(root);
  }));
  root.querySelectorAll('.mx-pad-key[data-pan], .mx-pad-key[data-zoom]').forEach((b) => {
    const vec = { pan: Number(b.dataset.pan || 0), tilt: Number(b.dataset.tilt || 0), zoom: Number(b.dataset.zoom || 0) };
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch { /* */ } holdMove(vec); });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, () => releaseMove());
    b.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); e.stopPropagation(); holdMove(vec); } });
    b.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.stopPropagation(); releaseMove(); } });
    b.addEventListener('blur', () => releaseMove());
  });
  const home = root.querySelector('#mxCamHome'); if (home) home.addEventListener('click', () => ptz({ action: 'home' }).catch((err) => showToast(err.message, 'error')));
  const speed = root.querySelector('#mxCamSpeed'); if (speed) speed.addEventListener('input', () => { camSpeed = Number(speed.value) / 100; });
  root.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', async () => {
    try { await ptz({ action: 'preset', preset: b.dataset.preset }); cam.last = { preset: b.dataset.preset, name: b.dataset.presetName }; draw(root); }
    catch (err) { showToast(err.message, 'error'); }
  }));
  // Audio: a screen's volume is sent when the fader is let go; a stream's fader is live.
  const setVol = async (id, v) => {
    volumes.set(id, v);
    try { await call(`/devices/${encodeURIComponent(id)}/command`, { method: 'POST', body: JSON.stringify({ type: 'set_volume', payload: { level: v.muted ? 0 : v.level / 100 } }) }); }
    catch (err) { showToast(err.message, 'error'); }
  };
  root.querySelectorAll('[data-vol]').forEach((el) => el.addEventListener('change', async () => { await setVol(el.dataset.vol, { level: Number(el.value), muted: false }); draw(root); }));
  root.querySelectorAll('[data-mute]').forEach((b) => b.addEventListener('click', async () => { const v = volumes.get(b.dataset.mute) || { level: 100, muted: false }; await setVol(b.dataset.mute, { level: v.level, muted: !v.muted }); draw(root); }));
  const streamAudio = async (id, body) => {
    try { const now = await call(`/stream-out/${encodeURIComponent(id)}/audio`, { method: 'POST', body: JSON.stringify(body) }); const i = streams().findIndex((s) => s.id === id); if (i >= 0) so.outputs[i] = now; }
    catch (err) { showToast(err.message, 'error'); }
  };
  root.querySelectorAll('[data-svol]').forEach((el) => {
    let busy = false;
    el.addEventListener('input', async () => { if (busy) return; busy = true; await streamAudio(el.dataset.svol, { level: Number(el.value) / 100 }); busy = false; });
    el.addEventListener('change', async () => { await streamAudio(el.dataset.svol, { level: Number(el.value) / 100 }); draw(root); });
  });
  root.querySelectorAll('[data-smute]').forEach((b) => b.addEventListener('click', async () => { const s = streams().find((x) => x.id === b.dataset.smute); await streamAudio(s.id, { muted: !s.audio.muted }); draw(root); }));
  root.querySelectorAll('[data-bed]').forEach((el) => el.addEventListener('change', async () => { await streamAudio(el.dataset.bed, { content_id: el.value || null }); draw(root); }));
  root.querySelectorAll('[data-out]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.out; if (outputs.has(id)) outputs.delete(id); else outputs.add(id); draw(root);
  }));
  root.querySelectorAll('[data-group]').forEach((b) => b.addEventListener('click', () => {
    const g = state.groups.find((x) => x.id === b.dataset.group); if (!g) return;
    outputs = new Set(g.device_ids.filter((id) => state.screens.some((s) => s.id === id))); draw(root);
  }));
  const all = root.querySelector('#mxAll'); if (all) all.addEventListener('click', () => { outputs = new Set(state.screens.map((s) => s.id)); draw(root); });
  // Streams: add a destination, go live, stop, remove.
  const redo = async () => { try { so = await call('/stream-out'); } catch { /* keep */ } if (alive) draw(root); };
  const act = (sel, attr, fn) => root.querySelectorAll(sel).forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await fn(b.dataset[attr]); } catch (err) { showToast(err.message, 'error'); }
    redo();
  }));
  act('[data-go]', 'go', async (id) => { await call(`/stream-out/${encodeURIComponent(id)}/start`, { method: 'POST' }); showToast(t('mixer.toast.stream_starting'), 'success'); });
  act('[data-stop]', 'stop', (id) => call(`/stream-out/${encodeURIComponent(id)}/stop`, { method: 'POST' }));
  act('[data-del]', 'del', async (id) => { await call(`/stream-out/${encodeURIComponent(id)}`, { method: 'DELETE' }); outputs.delete(id); });
  const add = root.querySelector('#mxAddStream'); if (add) add.addEventListener('click', () => { addingStream = true; draw(root); const f = root.querySelector('#mxStreamForm [name=name]'); if (f) f.focus(); });
  const form = root.querySelector('#mxStreamForm');
  if (form) {
    const kindSel = form.querySelector('[name=kind]'), urlRow = form.querySelector('.mx-stream-url');
    const sync = () => { urlRow.hidden = kindSel.selectedOptions[0].dataset.url !== '1'; };
    kindSel.addEventListener('change', sync); sync();
    root.querySelector('#mxStreamCancel').addEventListener('click', () => { addingStream = false; draw(root); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(form); const [width, height] = String(f.get('size')).split('x').map(Number);
      try {
        const made = await call('/stream-out', { method: 'POST', body: JSON.stringify({ name: f.get('name'), kind: f.get('kind'), url: f.get('url'), key: f.get('key'), width, height }) });
        addingStream = false; outputs.add(made.id);
        showToast(t('mixer.toast.stream_added'), 'success'); redo();
      } catch (err) { showToast(err.message, 'error'); }
    });
  }
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
  try { state = await load(); } catch (err) {
    container.innerHTML = `<div class="empty-state"><h3>${esc(t('mixer.title'))}</h3><p>${esc(err.message)}</p></div>`;
    return;
  }
  if (!alive) return;
  outputs = new Set([...outputs].filter((id) => state.screens.some((s) => s.id === id) || streams().some((s) => s.id === id)));
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
      const sig = () => JSON.stringify([state.screens.map((s) => [s.id, s.status, s.playlist_id]), state.sources.length, streams().map((s) => [s.id, s.status.state, s.status.error, s.playlist_id])]);
      const before = sig();
      if (container.querySelector('#mxStreamForm, #mxSceneForm') || holdTimer) return;      // someone is typing or steering: leave the desk alone
      state = await load();
      if (sig() !== before && alive) draw(container);
    } catch { /* keep the desk as it is */ }
  }, 10000);
  // Level meters of live streams, moved in place twice a second (no redraw).
  meterTimer = setInterval(async () => {
    if (!alive || document.hidden || !streams().some((s) => s.status.state !== 'off')) return;
    try {
      const fresh = await call('/stream-out');
      for (const s of fresh.outputs) {
        const bar = container.querySelector(`[data-meter="${CSS.escape(s.id)}"]`); if (bar) bar.style.height = Math.round(Math.min(1, s.status.audio_peak || 0) * 100) + '%';
        const mine = streams().find((x) => x.id === s.id); if (mine) mine.status = { ...mine.status, audio_peak: s.status.audio_peak };
      }
    } catch { /* next time */ }
  }, 500);
}

export function cleanup() {
  alive = false;
  if (onKey) document.removeEventListener('keydown', onKey);
  onKey = null;
  clearInterval(refreshTimer); refreshTimer = null;
  clearInterval(meterTimer); meterTimer = null;
  releaseMove();
}
