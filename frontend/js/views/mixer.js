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
let section = 'desk';         // which page of the desk: desk (everything), audio, cameras, graphics, streams
const SECTIONS = ['desk', 'audio', 'cameras', 'graphics', 'streams'];
let cued = null;             // the scene waiting on TAKE, if one was recalled
// The transition TAKE uses, remembered in this browser: { type: cut|fade|flash|wipe, ms }.
let tx = (() => { try { const v = JSON.parse(localStorage.getItem('st_mixer_tx') || 'null'); if (v && typeof v.type === 'string' && Number(v.ms) >= 200) return { type: v.type, ms: Number(v.ms) }; } catch { /* default */ } return { type: 'cut', ms: 600 }; })();
const RATES = [300, 600, 1000, 2000];
const STRIPS = ['programme', 'bed', 'line', 'net', 'net2', 'master'];
let procOpen = null;         // the strip whose processing is open on the desk: { sid, strip }
/** Whether a strip's processing does anything: its EQ key is lit when it does. */
const shaped = (st) => !!(st.hpf || st.gate || st.comp || st.fx || st.denoise || (st.eq && (st.eq.low || st.eq.mid || st.eq.high)));
const knob = (s, strip, ctl, label, value, min, max, step, show) => `<label class="mx-knob">${esc(label)}<input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-proc="${esc(s.id)}" data-strip="${strip}" data-ctl="${ctl}"><output>${esc(show)}</output></label>`;
const sizeOf = (n) => (n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + ' GB' : (n / 1024 ** 2).toFixed(1) + ' MB');
const dB = (v) => (v > 0 ? '+' : '') + v + ' dB';
const pct = (v) => (v ? Math.round(v * 100) + '%' : t('mixer.audio_off'));
/** The processing of one strip: what a desk channel has between its input and its fader. */
function procPanel(s, strip) {
  const st = s.audio.mix[strip], master = strip === 'master';
  return `<div class="mx-proc" role="group" aria-label="${esc(t('mixer.strip.' + strip))}">
    <div class="mx-proc-title">${esc(t('mixer.audio_proc_of', { strip: t('mixer.strip.' + strip) }))}<button type="button" class="btn btn-secondary btn-sm" data-procreset="${esc(s.id)}" data-strip="${strip}">${esc(t('mixer.audio_flat'))}</button></div>
    <div class="mx-knobs">
      ${master ? '' : `<label class="mx-knob mx-knob-check"><input type="checkbox" ${st.hpf ? 'checked' : ''} data-proc="${esc(s.id)}" data-strip="${strip}" data-ctl="hpf"> ${esc(t('mixer.audio_hpf'))}</label>`}
      ${knob(s, strip, 'eq.low', t('mixer.audio_eq_low'), st.eq.low, -12, 12, 1, dB(st.eq.low))}
      ${knob(s, strip, 'eq.mid', t('mixer.audio_eq_mid'), st.eq.mid, -12, 12, 1, dB(st.eq.mid))}
      ${knob(s, strip, 'eq.high', t('mixer.audio_eq_high'), st.eq.high, -12, 12, 1, dB(st.eq.high))}
      ${master ? knob(s, strip, 'decay', t('mixer.audio_room'), s.audio.mix.fx.decay, 0, 1, 0.05, Math.round(s.audio.mix.fx.decay * 100) + '%') : `
        ${knob(s, strip, 'gate', t('mixer.audio_gate'), st.gate, 0, 1, 0.05, pct(st.gate))}
        ${knob(s, strip, 'comp', t('mixer.audio_comp'), st.comp, 0, 1, 0.05, pct(st.comp))}
        ${knob(s, strip, 'fx', t('mixer.audio_reverb'), st.fx, 0, 1, 0.05, pct(st.fx))}
        ${knob(s, strip, 'denoise', t('mixer.audio_denoise'), st.denoise, 0, 1, 0.05, pct(st.denoise))}
        <span class="mx-knob mx-noise">${esc(t(st.noise ? 'mixer.audio_noise_learned' : 'mixer.audio_noise_auto'))}
          <span class="mx-noise-keys"><button type="button" class="btn btn-secondary btn-sm" data-learn="${esc(s.id)}" data-strip="${strip}" ${s.status.state === 'live' ? '' : 'disabled'} title="${esc(t('mixer.audio_noise_learn_tip'))}">${esc(t('mixer.audio_noise_learn'))}</button>
          ${st.noise ? `<button type="button" class="btn btn-secondary btn-sm" data-forget="${esc(s.id)}" data-strip="${strip}">${esc(t('mixer.audio_noise_forget'))}</button>` : ''}</span></span>`}
    </div>
    <p class="mx-note">${esc(t(master ? 'mixer.audio_proc_master_note' : 'mixer.audio_proc_note'))}</p>
  </div>`;
}
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

const call = (path, opts) => api.desk(path, opts);

let pgmFx = null;            // the transition the Program monitor should show for the take just made
const playlistFeed = (id, tag) => ({ page: `/player?preview=1&playlist=${encodeURIComponent(id)}&orientation=landscape`,
  feed: `/api/playlists/${encodeURIComponent(id)}/preview-payload?orientation=landscape`, key: `${tag}:${id}` });
/** Shows `src` in a monitor. A monitor that is already running is switched in place, with the
 *  take's transition when there is one; it is only (re)loaded when it has no player yet. */
function monitor(el, src, emptyText, fx) {
  let f = el.querySelector('iframe');
  if (!src) { el.innerHTML = `<div class="mx-empty">${esc(emptyText)}</div>`; el.dataset.key = ''; return; }
  if (el.dataset.key === src.key && f) return;
  el.dataset.key = src.key;
  if (f && f.dataset.ready === '1') {
    try { f.contentWindow.postMessage({ source: 'screentinker-preview', action: 'load', url: src.feed, take_fx: fx || null }, window.location.origin); return; } catch { /* reload it instead */ }
  }
  el.innerHTML = '';
  f = document.createElement('iframe');
  f.className = 'mx-frame'; f.title = ''; f.tabIndex = -1;
  f.addEventListener('load', () => { f.dataset.ready = '1'; });
  f.src = src.page;
  el.appendChild(f);
}
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
  // The monitors are built ONCE and switched in place (the preview player is told to load the new
  // source): rebuilding them on every key press reloaded both pictures, which read as the screen
  // resetting. Everything else on the desk is redrawn freely.
  if (!root.querySelector('#mxPvwScreen')) {
    root.innerHTML = `
    <div class="page-header">
      <div><h1>${esc(t('mixer.title'))}</h1><div class="subtitle">${esc(t('mixer.subtitle'))}</div></div>
    </div>
    <div class="mx">
      <section class="mx-monitors">
        <div class="mx-mon mx-pvw"><div class="mx-mon-label" id="mxPvwLabel"></div><div class="mx-screen" id="mxPvwScreen"></div></div>
        <div class="mx-take-col" id="mxTakeCol"></div>
        <div class="mx-mon mx-pgm"><div class="mx-mon-label" id="mxPgmLabel"></div><div class="mx-screen" id="mxPgmScreen"></div></div>
      </section>
      <div class="mx-rest" id="mxRest"></div>
    </div>`;
  }
  root.querySelector('.mx').dataset.section = section;
  root.querySelector('.page-header h1').textContent = t('mixer.section.' + section);
  root.querySelector('#mxPvwLabel').innerHTML = `<span class="mx-lamp mx-lamp-pvw"></span>${esc(t('mixer.preview'))}<b>${esc(pvw ? sourceName(pvw) : t('mixer.nothing_selected'))}</b>`;
  root.querySelector('#mxPgmLabel').innerHTML = `<span class="mx-lamp mx-lamp-pgm"></span>${esc(t('mixer.program'))}<b>${esc(pgm ? `${pgm.name}${pgm.playlist_name ? ': ' + pgm.playlist_name : ''}` : t('mixer.nothing_selected'))}</b>`;
  root.querySelector('#mxTakeCol').innerHTML = `
          <button type="button" class="btn mx-take" id="mxTake" ${(pvw || scene) && outputs.size ? '' : 'disabled'}>${esc(t('mixer.take'))}</button>
          <div class="mx-tx" role="radiogroup" aria-label="${esc(t('mixer.transition'))}">
            ${(state.transitions || ['cut']).map((k) => `<button type="button" role="radio" class="mx-tx-key${tx.type === k ? ' is-on' : ''}" aria-checked="${tx.type === k}" data-tx="${esc(k)}">${esc(t(`mixer.tx.${k}`))}</button>`).join('')}
          </div>
          <label class="mx-tx-rate${tx.type === 'cut' ? ' is-off' : ''}">${esc(t('mixer.tx_rate'))}
            <select class="input" id="mxTxRate" ${tx.type === 'cut' ? 'disabled' : ''}>${RATES.map((r) => `<option value="${r}"${r === tx.ms ? ' selected' : ''}>${(r / 1000).toFixed(1)} s</option>`).join('')}</select></label>
          <div class="mx-take-hint">${esc(outputs.size ? t('mixer.to_n_screens', { n: outputs.size }) : t('mixer.pick_output'))}${scene ? `<br><b>${esc(t('mixer.scene_cued', { name: scene.name }))}</b>` : ''}</div>`;
  monitor(root.querySelector('#mxPvwScreen'), pvw ? playlistFeed(pvw, 'p') : null, t('mixer.pick_source'));
  monitor(root.querySelector('#mxPgmScreen'), !pgm ? null : isStream(pgm) ? (pgm.playlist_id ? playlistFeed(pgm.playlist_id, 's:' + pgm.id) : null)
    : { page: `/player?preview=1&device=${encodeURIComponent(pgm.id)}`, feed: `/api/devices/${encodeURIComponent(pgm.id)}/preview-payload`, key: `d:${pgm.id}:${pgm.playlist_id || ''}` },
  pgm && isStream(pgm) ? t('mixer.stream_no_source') : t('mixer.pick_output'), pgmFx);
  pgmFx = null;
  root.querySelector('#mxRest').innerHTML = `
      <section class="mx-bank mx-scenes">
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

      <section class="mx-bank mx-audio">
        <h3>${esc(t('mixer.audio'))}</h3>
        ${selScreens.length || streams().length ? `<div class="mx-console">
          ${streams().map((s) => { const mix = s.audio.mix, pk = s.status.audio_peaks || {}, live = s.status.inputs_live || []; return `
            <div class="mx-group">
              <div class="mx-group-name"><span class="mx-lamp mx-lamp-${streamTally(s)}"></span>${esc(s.name)}${s.status.limiting > 0.5 ? `<span class="mx-limiting">${esc(t('mixer.audio_limiting', { db: s.status.limiting }))}</span>` : ''}</div>
              <div class="mx-strips">${STRIPS.map((k) => { const off = (k === 'programme' && !so.programme_audio) || (k === 'line' && !mix.line.device) || ((k === 'net' || k === 'net2') && !mix[k].url); const open = procOpen && procOpen.sid === s.id && procOpen.strip === k; return `
                <div class="mx-strip${mix[k].muted ? ' is-muted' : ''}${k === 'master' ? ' mx-strip-master' : ''}${off ? ' is-off' : ''}">
                  <span class="mx-strip-name">${esc(t('mixer.strip.' + k))}</span>
                  <div class="mx-meter" aria-hidden="true"><i data-meter="${esc(s.id)}:${k}" style="height:${Math.round(Math.min(1, pk[k] || 0) * 100)}%"></i></div>
                  <input type="range" class="mx-fader" min="0" max="${Math.round((so.max_level || 1.5) * 100)}" value="${Math.round(mix[k].level * 100)}" data-svol="${esc(s.id)}" data-strip="${k}" aria-label="${esc(t('mixer.audio_level_of', { name: s.name + ', ' + t('mixer.strip.' + k) }))}">
                  <span class="mx-strip-val">${mix[k].muted ? esc(t('mixer.audio_muted')) : Math.round(mix[k].level * 100) + '%'}</span>
                  <button type="button" class="mx-mute${mix[k].muted ? ' is-on' : ''}" data-smute="${esc(s.id)}" data-strip="${k}" aria-pressed="${mix[k].muted}">${esc(t('mixer.audio_mute'))}</button>
                  <button type="button" class="mx-mute mx-proc-open${open ? ' is-open' : ''}${shaped(mix[k]) ? ' is-shaped' : ''}" data-procopen="${esc(s.id)}" data-strip="${k}" aria-expanded="${open}">${esc(t('mixer.audio_eq'))}</button>
                </div>`; }).join('')}
              </div>
              ${procOpen && procOpen.sid === s.id ? procPanel(s, procOpen.strip) : ''}
              <div class="mx-group-src">
                <label>${esc(t('mixer.audio_bed'))}<select class="input mx-bed" data-bed="${esc(s.id)}"><option value="">${esc(t('mixer.audio_none_opt'))}</option>${(so.audio_sources || []).map((x) => `<option value="${esc(x.id)}"${x.id === s.audio.content_id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
                <label>${esc(t('mixer.audio_line'))}<select class="input mx-bed" data-line="${esc(s.id)}"><option value="">${esc(t('mixer.audio_none_opt'))}</option>${(so.line_inputs || []).map((x) => `<option value="${esc(x.device)}"${x.device === mix.line.device ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
                ${['net', 'net2'].map((n) => `<label>${esc(t('mixer.strip.' + n))}${live.includes(n) ? ` <span class="mx-live">${esc(t('mixer.audio_connected'))}</span>` : ''}<input class="input mx-bed" data-net="${esc(s.id)}" data-strip="${n}" value="${esc(mix[n].url || '')}" placeholder="srt://  rtsp://  rtp://  udp://" spellcheck="false" autocomplete="off"></label>`).join('')}
              </div>
            </div>`; }).join('')}
          ${selScreens.length ? `<div class="mx-group">
            <div class="mx-group-name">${esc(t('mixer.audio_screens'))}</div>
            <div class="mx-strips">${selScreens.slice(0, 12).map((s) => { const v = volumes.get(s.id) || { level: 100, muted: false }; return `
              <div class="mx-strip${v.muted ? ' is-muted' : ''}"><span class="mx-strip-name" title="${esc(s.name)}">${esc(s.name)}</span>
                <input type="range" class="mx-fader" min="0" max="100" value="${v.level}" data-vol="${esc(s.id)}" aria-label="${esc(t('mixer.audio_level_of', { name: s.name }))}">
                <span class="mx-strip-val">${v.muted ? esc(t('mixer.audio_muted')) : v.level + '%'}</span>
                <button type="button" class="mx-mute${v.muted ? ' is-on' : ''}" data-mute="${esc(s.id)}" aria-pressed="${v.muted}">${esc(t('mixer.audio_mute'))}</button></div>`; }).join('')}
            </div>
          </div>` : ''}
        </div>
        <p class="mx-note">${esc(t(so && so.available && !so.programme_audio && streams().length ? 'mixer.audio_note_no_programme' : 'mixer.audio_note'))}</p>` : `<p class="mx-note mx-note-top">${esc(t('mixer.audio_none'))}</p>`}
      </section>

      <section class="mx-bank mx-sources">
        <h3>${esc(t('mixer.sources'))}</h3>
        <div class="mx-keys">
          ${state.sources.length ? state.sources.map((s, i) => `
            <button type="button" class="mx-key mx-src${s.id === pvw ? ' is-pvw' : ''}${pgm && pgm.playlist_id === s.id ? ' is-pgm' : ''}" data-src="${esc(s.id)}" title="${esc(s.name)}">
              <span class="mx-key-n">${i < 9 ? i + 1 : ''}</span><span class="mx-key-name">${esc(s.name)}</span><span class="mx-key-sub">${esc(t('mixer.n_items', { n: s.items }))}</span>
            </button>`).join('') : `<p class="mx-note">${esc(t('mixer.no_sources'))}</p>`}
        </div>
      </section>

      <section class="mx-bank mx-outputs">
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
              ${s.status.recording ? `<span class="mx-rec" title="${esc(s.status.recording)}">${esc(t('mixer.rec_on'))}</span>` : (s.status.record_skipped ? `<span class="mx-stream-err">${esc(t('mixer.rec_skipped'))}</span>` : '')}
              ${s.file_only ? '' : `<label class="mx-rec-check"><input type="checkbox" data-record="${esc(s.id)}" ${s.record ? 'checked' : ''} ${s.status.state === 'off' ? '' : 'disabled'}> ${esc(t('mixer.rec_also'))}</label>`}
              <span class="mx-stream-state">${esc(t('mixer.stream_state.' + s.status.state))}</span>
              ${s.status.state === 'off'
                ? `<button type="button" class="btn btn-sm mx-golive" data-go="${esc(s.id)}">${esc(t(s.file_only ? 'mixer.rec_start' : 'mixer.stream_go'))}</button><button type="button" class="btn btn-secondary btn-sm" data-del="${esc(s.id)}">${esc(t('common.delete'))}</button>`
                : `<button type="button" class="btn btn-secondary btn-sm" data-stop="${esc(s.id)}">${esc(t('mixer.stream_stop'))}</button>`}
            </div>`).join('')}</div>` : (addingStream ? '' : `<p class="mx-note mx-note-top">${esc(t('mixer.stream_none'))}</p>`)}
          ${addingStream ? `<form class="mx-stream-form" id="mxStreamForm">
            <label>${esc(t('mixer.stream_name'))}<input class="input" name="name" maxlength="80" required placeholder="${esc(t('mixer.stream_name_ph'))}"></label>
            <label>${esc(t('mixer.stream_to'))}<select class="input" name="kind">${so.kinds.map((k) => `<option value="${esc(k.kind)}" data-url="${k.needs_url ? 1 : 0}" data-file="${k.file ? 1 : 0}">${esc(k.label)}</option>`).join('')}</select></label>
            <label class="mx-stream-url" hidden>${esc(t('mixer.stream_url'))}<input class="input" name="url" maxlength="500" placeholder="rtmp://"></label>
            <label class="mx-stream-key">${esc(t('mixer.stream_key'))}<input class="input" name="key" type="password" autocomplete="off" maxlength="600"></label>
            <label>${esc(t('mixer.stream_size'))}<select class="input" name="size">${so.sizes.map((z) => `<option value="${z.width}x${z.height}">${z.height}p</option>`).join('')}</select></label>
            <label class="mx-rec-check mx-stream-rec"><input type="checkbox" name="record"> ${esc(t('mixer.rec_also'))}</label>
            <div class="mx-stream-form-actions"><button type="submit" class="btn btn-primary btn-sm">${esc(t('mixer.stream_save'))}</button><button type="button" class="btn btn-secondary btn-sm" id="mxStreamCancel">${esc(t('common.cancel'))}</button></div>
          </form>` : ''}
          ${(so.recordings || []).length ? `<h4 class="mx-sub">${esc(t('mixer.recordings'))}</h4><div class="mx-stream-list">${so.recordings.map((r) => `
            <div class="mx-stream-row">
              <span class="mx-lamp mx-lamp-${r.recording ? 'air' : 'idle'}"></span>
              <div class="mx-stream-what"><b>${esc(r.name)}</b><span>${esc(new Date(r.at).toLocaleString())} · ${esc(sizeOf(r.bytes))}</span></div>
              ${r.recording ? `<span class="mx-rec">${esc(t('mixer.rec_on'))}</span>` : `<button type="button" class="btn btn-secondary btn-sm" data-recget="${esc(r.name)}">${esc(t('mixer.rec_download'))}</button><button type="button" class="btn btn-secondary btn-sm" data-recdel="${esc(r.name)}">${esc(t('common.delete'))}</button>`}
            </div>`).join('')}</div>` : ''}
          <p class="mx-note">${esc(t('mixer.stream_note', { max: so.max }))}</p>
          ${so.ffmpeg && so.ffmpeg.licence && so.ffmpeg.licence !== 'lgpl' ? `<p class="mx-note mx-licence" role="note"><b>${esc(t('mixer.licence.title'))}</b> ${esc(t('mixer.licence.' + so.ffmpeg.licence, { version: so.ffmpeg.version || '' }))}</p>`
            : `<p class="mx-note">${esc(t('mixer.licence.lgpl'))}</p>`}`}
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

      </div>
`;
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
    const r = await call('/mixer/take', { method: 'POST', body: JSON.stringify({ device_ids: [...outputs].filter((id) => !streamIds.includes(id)), stream_ids: streamIds, playlist_id: pvw,
      transition: { type: tx.type, ms: tx.ms, color: (root.querySelector('#mxC') || {}).value || undefined } }) });
    for (const tk of r.streams || []) { const s = streams().find((x) => x.id === tk.stream_id); if (s) { s.playlist_id = r.playlist.id; s.playlist_name = r.playlist.name; } }
    const n = (r.taken || []).length + (r.streams || []).length, skipped = (r.skipped || []).length;
    showToast(skipped ? t('mixer.toast.taken_skipped', { n, name: r.playlist.name, skipped }) : t('mixer.toast.taken', { n, name: r.playlist.name }), n ? 'success' : 'warning');
    for (const tk of r.taken || []) { const s = state.screens.find((x) => x.id === tk.device_id); if (s) { s.playlist_id = r.playlist.id; s.playlist_name = r.playlist.name; } }
    // Flip-flop: what was on Program is now in Preview, one key press from going back.
    if (tx.type !== 'cut') pgmFx = { type: tx.type, ms: tx.ms, color: (root.querySelector('#mxC') || {}).value };
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
  if (kind === 'countdown' && !/^(\d{1,4}|\d{1,5}s|\d{1,3}:[0-5]\d|\d:[0-5]\d:[0-5]\d)$/i.test(a)) { showToast(t('mixer.gfx_need_time'), 'info'); root.querySelector('#mxA').focus(); return; }
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
    const send = () => streamAudio(el.dataset.svol, { strip: el.dataset.strip, level: Number(el.value) / 100 });
    el.addEventListener('input', async () => { if (busy) return; busy = true; await send(); busy = false; });
    el.addEventListener('change', async () => { await send(); draw(root); });
  });
  root.querySelectorAll('[data-smute]').forEach((b) => b.addEventListener('click', async () => { const s = streams().find((x) => x.id === b.dataset.smute), k = b.dataset.strip; await streamAudio(s.id, { strip: k, muted: !s.audio.mix[k].muted }); draw(root); }));
  root.querySelectorAll('[data-line]').forEach((el) => el.addEventListener('change', async () => { await streamAudio(el.dataset.line, { line_device: el.value || null }); draw(root); }));
  // A strip's processing: open its panel, turn its controls, set it flat.
  root.querySelectorAll('[data-procopen]').forEach((b) => b.addEventListener('click', () => {
    const same = procOpen && procOpen.sid === b.dataset.procopen && procOpen.strip === b.dataset.strip;
    procOpen = same ? null : { sid: b.dataset.procopen, strip: b.dataset.strip }; draw(root);
  }));
  root.querySelectorAll('[data-proc]').forEach((el) => el.addEventListener('change', async () => {
    const ctl = el.dataset.ctl, v = el.type === 'checkbox' ? el.checked : Number(el.value);
    const body = ctl === 'decay' ? { fx: { decay: v } } : { strips: [{ strip: el.dataset.strip, ...(ctl.startsWith('eq.') ? { eq: { [ctl.slice(3)]: v } } : { [ctl]: v }) }] };
    await streamAudio(el.dataset.proc, body); draw(root);
  }));
  root.querySelectorAll('[data-proc][type=range]').forEach((el) => el.addEventListener('input', () => { const o = el.parentNode.querySelector('output'); if (o) o.textContent = el.dataset.ctl.startsWith('eq.') ? dB(Number(el.value)) : Math.round(Number(el.value) * 100) + '%'; }));
  root.querySelectorAll('[data-procreset]').forEach((b) => b.addEventListener('click', async () => {
    await streamAudio(b.dataset.procreset, { strips: [{ strip: b.dataset.strip, hpf: false, eq: { low: 0, mid: 0, high: 0 }, gate: 0, comp: 0, fx: 0, denoise: 0 }] }); draw(root);
  }));
  root.querySelectorAll('[data-learn]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = t('mixer.audio_noise_learning');
    await streamAudio(b.dataset.learn, { learn_noise: b.dataset.strip }); draw(root);
  }));
  root.querySelectorAll('[data-forget]').forEach((b) => b.addEventListener('click', async () => { await streamAudio(b.dataset.forget, { forget_noise: b.dataset.strip }); draw(root); }));
  root.querySelectorAll('[data-net]').forEach((el) => el.addEventListener('change', async () => { await streamAudio(el.dataset.net, { [el.dataset.strip + '_url']: el.value.trim() || null }); draw(root); }));
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
  root.querySelectorAll('[data-record]').forEach((el) => el.addEventListener('change', async () => {
    try { await call(`/stream-out/${encodeURIComponent(el.dataset.record)}`, { method: 'PUT', body: JSON.stringify({ record: el.checked }) }); } catch (err) { showToast(err.message, 'error'); }
    redo();
  }));
  root.querySelectorAll('[data-recget]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const { url } = await call(`/stream-out/recordings/${encodeURIComponent(b.dataset.recget)}/link`, { method: 'POST' });
      const a = document.createElement('a'); a.href = url; a.download = b.dataset.recget; document.body.appendChild(a); a.click(); a.remove();
    } catch (err) { showToast(err.message, 'error'); }
  }));
  root.querySelectorAll('[data-recdel]').forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = t('mixer.rec_delete_sure'); return; }   // second press deletes
    try { await call(`/stream-out/recordings/${encodeURIComponent(b.dataset.recdel)}`, { method: 'DELETE' }); showToast(t('mixer.toast.rec_deleted'), 'info'); } catch (err) { showToast(err.message, 'error'); }
    redo();
  }));
  const add = root.querySelector('#mxAddStream'); if (add) add.addEventListener('click', () => { addingStream = true; draw(root); const f = root.querySelector('#mxStreamForm [name=name]'); if (f) f.focus(); });
  const form = root.querySelector('#mxStreamForm');
  if (form) {
    const kindSel = form.querySelector('[name=kind]'), urlRow = form.querySelector('.mx-stream-url');
    const sync = () => {
      const o = kindSel.selectedOptions[0].dataset;
      urlRow.hidden = o.url !== '1';
      form.querySelector('.mx-stream-key').hidden = o.file === '1'; form.querySelector('.mx-stream-rec').hidden = o.file === '1';
    };
    kindSel.addEventListener('change', sync); sync();
    root.querySelector('#mxStreamCancel').addEventListener('click', () => { addingStream = false; draw(root); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(form); const [width, height] = String(f.get('size')).split('x').map(Number);
      try {
        const made = await call('/stream-out', { method: 'POST', body: JSON.stringify({ name: f.get('name'), kind: f.get('kind'), url: f.get('url'), key: f.get('key'), width, height, record: f.get('record') === 'on' }) });
        addingStream = false; outputs.add(made.id);
        showToast(t('mixer.toast.stream_added'), 'success'); redo();
      } catch (err) { showToast(err.message, 'error'); }
    });
  }
  const none = root.querySelector('#mxNone'); if (none) none.addEventListener('click', () => { outputs = new Set(); draw(root); });
  const tk = root.querySelector('#mxTake'); if (tk) tk.addEventListener('click', () => take(root));
  const keepTx = () => { try { localStorage.setItem('st_mixer_tx', JSON.stringify(tx)); } catch { /* this page only */ } };
  root.querySelectorAll('[data-tx]').forEach((b) => b.addEventListener('click', () => { tx = { ...tx, type: b.dataset.tx }; keepTx(); draw(root); }));
  const rate = root.querySelector('#mxTxRate'); if (rate) rate.addEventListener('change', () => { tx = { ...tx, ms: Number(rate.value) }; keepTx(); });
  root.querySelectorAll('[data-gfx]').forEach((b) => b.addEventListener('click', () => key(root, b.dataset.gfx)));
  const cl = root.querySelector('#mxClear'); if (cl) cl.addEventListener('click', clearGfx);
  for (const [id, k] of [['mxA', 'mx_a'], ['mxB', 'mx_b'], ['mxC', 'mx_c']]) {
    const el = root.querySelector('#' + id); if (el) el.addEventListener('input', () => { try { sessionStorage.setItem(k, el.value); } catch { /* */ } });
  }
}

export async function render(container, which) {
  alive = true;
  section = SECTIONS.includes(which) ? which : 'desk';
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
      if (container.querySelector('#mxStreamForm, #mxSceneForm') || holdTimer || (document.activeElement && document.activeElement.matches && document.activeElement.matches('[data-net], [data-proc], .mx-fader'))) return;      // someone is typing or steering: leave the desk alone
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
        const pk = s.status.audio_peaks || {};
        for (const k of STRIPS) { const bar = container.querySelector(`[data-meter="${CSS.escape(s.id + ':' + k)}"]`); if (bar) bar.style.height = Math.round(Math.min(1, pk[k] || 0) * 100) + '%'; }
        const mine = streams().find((x) => x.id === s.id); if (mine) mine.status = { ...mine.status, audio_peaks: pk };
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
