/*
 * 3.0 Simple view: everything is a guided task, in the style of the setup guide.
 *
 *   #/                       "What would you like to do?" — four big tasks and the list of screens
 *   #/simple/change[?device] Change what a screen shows: pick the screen → choose content → it's live
 *   #/simple/upload          Upload photos: choose files → choose screens → done
 *   #/simple/passkey         Sign in with a passkey: confirm your password → the browser's prompt → done
 *   #/simple/share[?device]  Share my screen (3.0): pick the screen → choose what to share → live, Stop
 *   #/simple/sign            Make a sign: pick a template → fill it in → choose screens (views/make-sign.js)
 *   #/simple/news            Show news headlines (3.0): a site or feed → how it looks → choose screens (views/simple-news.js)
 *   #/simple/brand           The workspace brand kit the sign templates use (components/brand-kit-editor.js)
 *   #/simple/ai-setup        Set up my screens with AI (3.0 Private AI): describe the place → pick signs → check each (views/ai-setup.js)
 *   #/simple/import          Import from another app (3.0, views/migrate.js in guide mode): offered on the
 *                            home and in Help only while the workspace has no screens yet
 *   (#/add-screen is the setup guide's add mode, views/onboarding.js)
 *
 * No sidebar here: a small top bar carries the Simple | Advanced switch and an account menu. Every
 * other page still opens normally (with the full shell) from a link or bookmark, and Advanced view
 * restores the full dashboard. Nothing here writes anything the full product cannot already write:
 * uploads go through api.uploadContent, screens are changed through the same assignment, playlist
 * and publish endpoints the screen page uses, so the release gate (review) and plan limits apply.
 *
 * Values from the server reach the page through esc() or textContent only.
 */
import { api } from '../api.js';
import { t, tn } from '../i18n.js';
import { esc, screenshotUrl, hydrateAuthImages } from '../utils.js';
import { showToast } from '../components/toast.js';
import { setUiMode } from '../components/ui-mode.js';
import { plansVisible } from '../components/plan-nudges.js';
import { isPlatformAdmin, inManagerApp, openOutsideApp, isTouchFirst } from '../utils.js';
import { renderStatsPrompt } from './dashboard.js';
import { publishOrSubmit } from '../components/release.js';
import { switchWorkspaceTo } from '../components/corporate-ui.js';
import { mountStockPicker } from '../components/stock-picker.js';
import { passkeysSupported, suggestedPasskeyName } from '../lib/passkeys.js';
import { addPasskey, unavailableMessage } from '../components/passkey-setup.js';
import { startScreenShare, startScreenShareTo, stopScreenShare, activeScreenShare, onScreenShareChange, screenShareUnsupportedText, screenShareUnsupportedNote } from '../components/screen-share.js';
import { renderSign, renderBrand } from './make-sign.js';
import { renderAiSetup, cleanup as cleanupAiSetup } from './ai-setup.js';
import { loadStates as loadVerification, plainStatus } from '../components/screen-verify.js';
import { upcomingChanges } from '../components/preview-at-time.js';
import { mountMigrate, cleanup as cleanupMigrate } from './migrate.js';
import { renderNews } from './simple-news.js';
import { on, off } from '../socket.js';

const SAMPLE_URL = '/assets/samples/welcome-screen.jpg';
const ACCEPT = 'image/*,video/*,audio/*';
let cleanupFns = [];

function cachedUser() {
  try { return JSON.parse(localStorage.getItem('user') || 'null'); } catch { return null; }
}
function brandName() {
  return (document.getElementById('brandName')?.textContent || 'ScreenTinker').trim();
}
function online(d) { return d && d.status === 'online'; }

// ---------------------------------------------------------------------------------------------
// Shell: top bar + a centred column, the same proportions as the setup guide
// ---------------------------------------------------------------------------------------------

export function shell(container, inner) {
  const u = cachedUser() || {};
  const showPlan = plansVisible(u);
  container.innerHTML = `
    <div class="simple-topbar">
      <a href="#/" class="simple-brand">${esc(brandName())}</a>
      <div class="simple-topbar-right">
        <div class="ui-mode-switch simple-switch" role="radiogroup" aria-label="${esc(t('simple.view_label'))}">
          <button type="button" role="radio" aria-checked="true" data-simple-mode="simple">${esc(t('nav.view_simple'))}</button>
          <button type="button" role="radio" aria-checked="false" data-simple-mode="advanced">${esc(t('nav.view_advanced'))}</button>
        </div>
        <details class="simple-account">
          <summary>${esc(u.name || u.email || '')}</summary>
          <div class="simple-account-menu">
            ${workspaceMenu(u)}
            ${isPlatformAdmin(u) ? (inManagerApp()
              ? `<button type="button" data-outside="/app#/platform/overview">${esc(t('simple.menu.admin'))} &#8599;</button>`
              : `<a href="#/platform/overview">${esc(t('simple.menu.admin'))}</a>`) : ''}
            <a href="#/simple/brand">${esc(t('signs.brand.menu'))}</a>
            ${showPlan ? `<a href="#/billing">${esc(t('simple.menu.plan'))}</a>` : ''}
            ${inManagerApp()
              ? `<button type="button" data-outside="/app#/settings">${esc(t('simple.menu.settings'))} &#8599;</button>`
              : `<a href="#/settings">${esc(t('simple.menu.settings'))}</a>`}
            ${inManagerApp() && window.STManager ? `<button type="button" data-change-server>${esc(t('simple.menu.change_server'))}</button>` : ''}
            ${passkeyMenuShown(u) ? `<a href="#/simple/passkey">${esc(t('passkey.simple_menu'))}</a>` : ''}
            <a href="#/simple/help">${esc(t('simple.menu.help'))}</a>
            <a href="#/delete-account">${esc(t('account_delete.menu'))}</a>
            <button type="button" data-simple-signout>${esc(t('auth.sign_out'))}</button>
          </div>
        </details>
      </div>
    </div>
    <div class="simple-page">${inner}</div>`;
  container.querySelector('[data-simple-mode="advanced"]').addEventListener('click', () => setUiMode('advanced'));
  container.querySelectorAll('[data-outside]').forEach((b) => b.addEventListener('click', () => openOutsideApp(b.dataset.outside)));
  container.querySelector('[data-change-server]')?.addEventListener('click', () => window.STManager.changeServer());
  container.querySelectorAll('[data-switch-ws]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await switchWorkspaceTo(b.dataset.switchWs, '#/'); }
    catch (err) { b.disabled = false; showToast(err.message, 'error'); }
  }));
  container.querySelector('[data-simple-signout]').addEventListener('click', () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.hash = '#/login';
    window.location.reload();
  });
}

/** "Org · Workspace" — workspaces are often all called "Default", so the organization tells them apart. */
function workspaceLabel(w) {
  return w.organization_name && w.organization_name !== w.name ? `${w.organization_name} · ${w.name}` : w.name;
}

/** The account menu's workspace section: where you are, and the others you can switch to. */
function workspaceMenu(u) {
  const others = switchableWorkspaces(u);
  if (!others.length) return '';
  const cur = currentWorkspace();
  const label = workspaceLabel;
  const shown = others.slice(0, SWITCH_MAX);
  return `
    <div class="simple-menu-label">${esc(t('simple.menu.workspace'))}</div>
    ${cur ? `<div class="simple-menu-current">&#10003; ${esc(label(cur))}</div>` : ''}
    ${shown.map((w) => `<button type="button" data-switch-ws="${esc(w.id)}">${esc(label(w))}</button>`).join('')}
    ${others.length > shown.length ? `<div class="simple-menu-note">${esc(t('simple.menu.more_workspaces', { n: others.length - shown.length }))}</div>` : ''}
    <hr class="simple-menu-sep">`;
}

/** Guide frame: progress, icon, title, card, footer. Same look as views/onboarding.js.
 *  `cancelHref` is where Cancel goes (home by default); `wide` gives a task with a live preview room. */
export function guideFrame({ step, total, icon, title, body, back = true, next = null, nextLabel = '', cancelHref = '#/', wide = false }) {
  return `
    <div class="simple-guide${wide ? ' simple-guide--wide' : ''}">
      <div class="simple-progress">${Array.from({ length: total }, (_, i) => `<span class="${i <= step ? 'on' : ''}"></span>`).join('')}</div>
      <div class="simple-guide-head"><div class="simple-guide-icon">${icon}</div><h2>${esc(title)}</h2></div>
      <div class="simple-card">${body}</div>
      <div class="simple-guide-foot">
        ${back ? `<button type="button" class="btn btn-secondary" data-guide-back>${esc(t('onboarding.back'))}</button>` : '<span></span>'}
        <div style="display:flex;gap:8px">
          <a href="${esc(cancelHref)}" class="btn btn-secondary" style="color:var(--text-muted)">${esc(t('common.cancel'))}</a>
          ${next ? `<button type="button" class="btn btn-primary" data-guide-next>${esc(nextLabel)}</button>` : ''}
        </div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------------------------

async function renderHome(container) {
  const canChange = simpleCanChange();
  const multiWs = switchableWorkspaces(cachedUser()).length > 0;
  shell(container, `
    <div id="simpleAdminNotices"></div>
    <h1 class="simple-h1">${esc(t(canChange ? 'simple.home.title' : 'simple.home.title_viewer'))}</h1>
    ${multiWs && currentWorkspace() ? `<p class="simple-where">${esc(t('simple.home.in_workspace', { name: workspaceLabel(currentWorkspace()) }))}</p>` : ''}
    ${canChange ? '' : `<p class="simple-muted simple-viewer-note">${esc(t('simple.home.viewer_note'))}</p>`}
    <div id="simpleFreshness"></div>
    <div id="simpleEnergy"></div>
    <div class="simple-tasks">
      ${canChange ? `<a class="simple-task" href="#/add-screen"><span class="simple-task-icon">&#10133;</span><span><strong>${esc(t('simple.task.add'))}</strong><small>${esc(t('simple.task.add_desc'))}</small></span></a>
      <a class="simple-task" href="#/simple/change"><span class="simple-task-icon">&#9998;</span><span><strong>${esc(t('simple.task.change'))}</strong><small>${esc(t('simple.task.change_desc'))}</small></span></a>
      <a class="simple-task" href="#/simple/upload"><span class="simple-task-icon">&#128247;</span><span><strong>${esc(t('simple.task.upload'))}</strong><small>${esc(t('simple.task.upload_desc'))}</small></span></a>
      <a class="simple-task" href="#/simple/sign"><span class="simple-task-icon">&#127991;&#65039;</span><span><strong>${esc(t('signs.task'))}</strong><small>${esc(t('signs.task_desc'))}</small></span></a>
      <a class="simple-task" href="#/simple/news"><span class="simple-task-icon">&#128240;</span><span><strong>${esc(t('news.simple.task'))}</strong><small>${esc(t('news.simple.task_desc'))}</small></span></a>` : ''}
      ${canChange ? `<a class="simple-task" href="#/simple/requests"><span class="simple-task-icon">&#128229;</span><span><strong>${esc(t('simple.task.requests'))}</strong><small>${esc(t('simple.task.requests_desc'))}</small></span></a>` : ''}
      ${canManageTeam() ? `<a class="simple-task" href="#/simple/team"><span class="simple-task-icon">&#128101;</span><span><strong>${esc(t('simple.task.team'))}</strong><small>${esc(t('simple.task.team_desc'))}</small></span></a>` : ''}
      <a class="simple-task" href="#/simple/help"><span class="simple-task-icon">&#10067;</span><span><strong>${esc(t('simple.task.help'))}</strong><small>${esc(t('simple.task.help_desc'))}</small></span></a>
    </div>
    <h2 class="simple-h2">${esc(t('simple.home.your_screens'))}</h2>
    <div id="simpleScreens" class="simple-screens"><p class="simple-muted">${esc(t('common.loading'))}</p></div>`);

  adminNotices(document.getElementById('simpleAdminNotices'));
  if (canChange) freshnessLine(document.getElementById('simpleFreshness'));
  if (canChange) energyLine(document.getElementById('simpleEnergy'));
  if (canChange) aiSetupTask(container);
  const host = document.getElementById('simpleScreens');
  let devices = [];
  try { devices = await api.getDevices(); } catch { devices = []; }
  if (!document.contains(host)) return;
  if (!devices.length) {
    // 3.0: a workspace with no screens yet is new, and may be moving from another app. Once it has a
    // screen this offer is gone; the import stays in Advanced (Content → Add content).
    host.innerHTML = `<div class="simple-empty"><p>${esc(t(canChange ? 'simple.home.no_screens' : 'simple.home.no_screens_viewer'))}</p>
      ${canChange ? `<a class="btn btn-primary" href="#/add-screen">${esc(t('simple.task.add'))}</a>
      <p class="simple-muted simple-import-offer">${esc(t('migrate.simple.offer'))} <a href="#/simple/import">${esc(t('migrate.simple.offer_link'))}</a></p>` : ''}</div>`;
    return;
  }
  // A view-only member gets the same cards, without the link into Change.
  const tag = canChange ? 'a' : 'div';
  // 3.0 screen share: an editor gets "Share my screen" under each screen that can show one.
  const sharing = canChange && await screenShareOn();
  if (!document.contains(host)) return;
  /*
   * 3.0 display-link mirrors: a mirror is the same display open somewhere else, so it sits under
   * its original (a smaller card that says where it is) rather than as a screen of its own.
   */
  const originals = new Set(devices.filter((d) => !d.mirror_of).map((d) => d.id));
  const mirrorsByOriginal = new Map();
  for (const d of devices) {
    if (d.mirror_of && originals.has(d.mirror_of)) {
      if (!mirrorsByOriginal.has(d.mirror_of)) mirrorsByOriginal.set(d.mirror_of, []);
      mirrorsByOriginal.get(d.mirror_of).push(d);
    }
  }
  const mirrorLines = (d) => {
    const list = mirrorsByOriginal.get(d.id) || [];
    if (!list.length) return '';
    return `<div class="simple-mirrors"><p class="simple-muted">${esc(tn('simple.mirrors.title', list.length))}</p>${list.map((m) => `
      <div class="simple-mirror"><span class="simple-screen-name">${esc(m.name)}</span>
        <span class="simple-muted">${esc(m.mirror_location || '')}</span>
        <span class="simple-screen-status ${online(m) ? 'on' : 'off'}">${esc(online(m) ? t('simple.status.online') : t('simple.status.offline'))}</span></div>`).join('')}</div>`;
  };
  host.innerHTML = devices.filter((d) => !(d.mirror_of && originals.has(d.mirror_of))).map((d) => {
    const card = `
    <${tag} class="simple-screen" ${canChange ? `href="#/simple/change?device=${encodeURIComponent(d.id)}" title="${esc(t('simple.task.change'))}"` : ''}>
      <span class="simple-screen-shot" data-shot="${esc(d.id)}">${d.screenshot_path ? `<img src="${screenshotUrl(d.id, d.screenshot_at || '')}" alt="">` : '&#128250;'}</span>
      <span class="simple-screen-name">${esc(d.name)}</span>
      <span class="simple-screen-status ${online(d) ? 'on' : 'off'}" data-sv-plain="${esc(d.id)}">${esc(d.plan_paused ? t('simple.status.paused') : online(d) ? t('simple.status.online') : t('simple.status.offline'))}</span>
    </${tag}>`;
    // Screen share (an editor, on a screen that can show one) and "What's coming up" under each card.
    const share = sharing && canShareTo(d) ? `
      <a class="btn btn-secondary btn-sm simple-screen-share" href="#/simple/share?device=${encodeURIComponent(d.id)}">&#128421;&#65039; ${esc(t('screen_share.start'))}</a>` : '';
    return `<div class="simple-screen-wrap">${card}${mirrorLines(d)}${share}
    <details class="simple-coming" data-coming="${esc(d.id)}"><summary>${esc(t('simple.coming.title'))}</summary><div class="simple-coming-body"></div></details>
    </div>`;
  }).join('');
  // 3.0.1: a screenshot that arrives while the page is open replaces the card's picture — the server
  // asks for one after pairing and after new content (server/lib/preview-refresh.js), so a card no
  // longer shows the pairing code under "Playing" until somebody presses Screenshot.
  const onShot = (data) => applyScreenshot(host, data);
  on('screenshot-ready', onShot);
  cleanupFns.push(() => off('screenshot-ready', onShot));
  host.querySelectorAll('details[data-coming]').forEach((el) => el.addEventListener('toggle', () => {
    if (el.open && !el.dataset.loaded) { el.dataset.loaded = '1'; showComing(el.querySelector('.simple-coming-body'), el.dataset.coming); }
  }));
  if (sharing && devices.some(canShareTo)) {
    const tasks = container.querySelector('.simple-tasks');
    const help = tasks && tasks.querySelector('a[href="#/simple/help"]');
    if (help) help.insertAdjacentHTML('beforebegin', `<a class="simple-task" href="#/simple/share"><span class="simple-task-icon">&#128421;&#65039;</span><span><strong>${esc(t('screen_share.start'))}</strong><small>${esc(t('screen_share.simple.task_desc'))}</small></span></a>`);
  }
  // Screen verification, in plain words: a screen that is online but showing a blank or frozen
  // picture says so here instead of "Playing". Silent when there is nothing to say.
  const states = await loadVerification();
  if (!document.contains(host)) return;
  for (const d of devices) {
    const words = online(d) && !d.plan_paused ? plainStatus(states.get(d.id)) : null;
    const el = host.querySelector(`[data-sv-plain="${CSS.escape(d.id)}"]`);
    if (el && words) { el.textContent = words; el.classList.remove('on'); el.classList.add('warn'); }
  }
}

/*
 * A live screenshot (dashboard:screenshot-ready) onto the home cards. Only an inline image the
 * server relayed (data:image/…) is used; a card that had no picture yet gets one.
 */
export function applyScreenshot(host, data) {
  if (!host || !data || typeof data.device_id !== 'string') return 0;
  if (typeof data.image_data !== 'string' || !data.image_data.startsWith('data:image/')) return 0;
  let n = 0;
  host.querySelectorAll(`[data-shot="${CSS.escape(data.device_id)}"]`).forEach((el) => {
    let img = el.querySelector('img');
    if (!img) {
      el.textContent = '';
      img = document.createElement('img');
      img.alt = '';
      el.appendChild(img);
    }
    img.src = data.image_data;
    n++;
  });
  return n;
}

/*
 * 3.0 Private AI: "Set up my screens with AI" joins the tasks only when this workspace has AI set
 * up — with none, there is nothing to offer, and a task that ends in "not configured" is noise.
 */
async function aiSetupTask(container) {
  let st = null;
  try { st = await api.privateAiStatus(); } catch { return; }
  const tasks = container.querySelector('.simple-tasks');
  if (!st || !st.configured || !st.can_use || !tasks || !document.contains(tasks)) return;
  const sign = tasks.querySelector('a[href="#/simple/sign"]');
  const html = `<a class="simple-task" href="#/simple/ai-setup"><span class="simple-task-icon">&#10024;</span><span><strong>${esc(t('ai_setup.task'))}</strong><small>${esc(t(st.private ? 'ai_setup.task_desc_private' : 'ai_setup.task_desc'))}</small></span></a>`;
  if (sign) sign.insertAdjacentHTML('afterend', html);
}

// ---------------------------------------------------------------------------------------------
// Task: share my screen (3.0) — the person's laptop on a screen, until they press Stop.
// ---------------------------------------------------------------------------------------------

/** Is screen sharing on for this server? (GET /api/status features.screen_share) */
async function screenShareOn() {
  try { const st = await api.getServerStatus(); return !!(st && st.features && st.features.screen_share); } catch { return false; }
}
function canShareTo(d) {
  return Array.isArray(d.capabilities) && d.capabilities.includes('remote.screen_share');
}

async function renderShare(container, presetId) {
  let all = [];
  try { all = await api.getDevices(); } catch { all = []; }
  const devices = (Array.isArray(all) ? all : []).filter(canShareTo);
  const on = await screenShareOn();
  // Arrived from a screen that cannot show a share (a Roku, an old app): say so, plainly, by name.
  if (on && presetId && !devices.some((d) => d.id === presetId)) {
    let note = t('screen_share.reason.unsupported');
    try { const st = await api.getScreenShare(presetId); if (st && !st.supported) note = screenShareUnsupportedNote(st.platform); } catch { /* generic words */ }
    shell(container, guideFrame({ step: 0, total: 1, icon: '&#128421;&#65039;', title: t('screen_share.simple.none_title'), back: false,
      body: `<p class="simple-lead">${esc(note)}</p><div class="simple-done-actions"><a class="btn btn-primary" href="#/">${esc(t('screen_share.simple.home'))}</a></div>` }));
    return;
  }
  if (!on || !devices.length) {
    shell(container, guideFrame({ step: 0, total: 1, icon: '&#128421;&#65039;', title: t('screen_share.simple.none_title'), back: false,
      body: `<p class="simple-lead">${esc(t(on ? 'screen_share.simple.none' : 'screen_share.reason.disabled'))}</p><div class="simple-done-actions"><a class="btn btn-primary" href="#/">${esc(t('screen_share.simple.home'))}</a></div>` }));
    return;
  }
  // 3.0 multi share: the person can pick several screens (up to the server's limit).
  let maxTargets = 6;
  try { const st = await api.getScreenShare(devices[0].id); if (st && st.max_targets) maxTargets = st.max_targets; } catch { /* default */ }
  const preset = devices.find((d) => d.id === presetId) || (devices.length === 1 ? devices[0] : null);
  let chosen = preset ? [preset] : [];
  const skipPick = !!preset;
  const total = skipPick ? 2 : 3;
  const picked = new Set();
  const wireBack = (fn) => container.querySelector('[data-guide-back]')?.addEventListener('click', fn);
  const off = onScreenShareChange(() => { if (document.contains(container)) draw(); });
  cleanupFns.push(off);

  function pickStep() {
    shell(container, guideFrame({ step: 0, total, icon: '&#128250;', title: t('screen_share.simple.pick_many_title'), back: false,
      body: `<p class="simple-lead">${esc(t('screen_share.simple.pick_many_lead', { max: maxTargets }))}</p>
        <div class="simple-pick">${devices.map((d) => `
        <button type="button" class="simple-screen${picked.has(d.id) ? ' is-picked' : ''}" data-pick="${esc(d.id)}" aria-pressed="${picked.has(d.id) ? 'true' : 'false'}" ${online(d) ? '' : 'disabled'}
          style="${picked.has(d.id) ? 'outline:3px solid var(--accent, #3b82f6);outline-offset:2px' : ''}">
          <span class="simple-screen-shot">${d.screenshot_path ? `<img src="${screenshotUrl(d.id, d.screenshot_at || '')}" alt="">` : '&#128250;'}</span>
          <span class="simple-screen-name">${picked.has(d.id) ? '&#10003; ' : ''}${esc(d.name)}</span>
          <span class="simple-screen-status ${online(d) ? 'on' : 'off'}">${esc(online(d) ? t('simple.status.online') : t('simple.status.offline'))}</span>
        </button>`).join('')}</div>
        <div class="simple-done-actions"><button type="button" class="btn btn-primary simple-share-go" data-pick-next ${picked.size ? '' : 'disabled'}>${esc(t('screen_share.simple.next'))}</button></div>` }));
    container.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.pick;
      if (picked.has(id)) picked.delete(id);
      else if (picked.size >= maxTargets) { showToast(t('screen_share.reason.too_many_targets', { max: maxTargets, count: picked.size + 1 }), 'warning'); return; }
      else picked.add(id);
      pickStep();
    }));
    container.querySelector('[data-pick-next]')?.addEventListener('click', () => {
      chosen = devices.filter((d) => picked.has(d.id));
      if (chosen.length) draw();
    });
  }

  function chooseStep() {
    // In the ScreenTinker Manager app the PHONE's screen is shared by the app itself (a WebView cannot
    // capture the screen): the app asks Android, shows "Share your screen to <server>?" and streams.
    const bridge = inManagerApp() && typeof window !== 'undefined' ? window.STManager : null;
    const viaApp = !!(bridge && typeof bridge.shareScreenTo === 'function');
    const why = viaApp ? null : screenShareUnsupportedText();
    const one = chosen.length === 1 ? chosen[0] : null;
    const allOnline = chosen.every(online);
    shell(container, guideFrame({ step: skipPick ? 0 : 1, total, icon: '&#128421;&#65039;',
      title: one ? t('screen_share.simple.choose_title', { name: one.name }) : t('screen_share.simple.choose_title_n', { count: chosen.length }), back: !skipPick,
      body: `
        <p class="simple-lead">${esc(t(viaApp ? 'screen_share.simple.app_lead' : 'screen_share.simple.choose_lead'))}</p>
        ${why ? `<p class="simple-status" style="color:var(--danger)">${esc(why)}</p>` : `
        ${viaApp ? '' : `<label class="simple-share-audio"><input type="checkbox" data-share-audio> ${esc(t('screen_share.include_audio'))}</label>`}
        <div class="simple-done-actions"><button type="button" class="btn btn-primary simple-share-go" data-share-go ${allOnline ? '' : 'disabled'}>${esc(t('screen_share.simple.choose_btn'))}</button></div>
        ${allOnline ? '' : `<p class="simple-status">${esc(t('screen_share.card.offline'))}</p>`}`}` }));
    wireBack(() => { chosen = []; draw(); });
    container.querySelector('[data-share-go]')?.addEventListener('click', async (e) => {
      if (viaApp) {
        let token = null;
        try { token = localStorage.getItem('token'); } catch { token = null; }
        if (token) bridge.shareScreenTo(JSON.stringify(chosen.map((d) => d.id)), chosen.map((d) => d.name).join(', '), token);
        return;
      }
      e.currentTarget.disabled = true;
      const audio = !!container.querySelector('[data-share-audio]')?.checked;
      const started = one
        ? await startScreenShare(one, { audio })
        : await startScreenShareTo({ deviceIds: chosen.map((d) => d.id) }, { audio });
      if (!started && document.contains(container)) draw();
    });
  }

  function liveStep(a) {
    const live = a.state === 'live';
    const many = a.screens > 1;
    const lead = many && live ? t('screen_share.state.live_n', { live: a.live, total: a.screens })
      : t(live ? 'screen_share.state.live' : a.state === 'negotiating' ? 'screen_share.state.negotiating' : 'screen_share.state.connecting');
    shell(container, guideFrame({ step: total - 1, total, icon: live ? '&#128308;' : '&#9203;',
      title: many ? t('screen_share.simple.live_title_n', { count: a.screens }) : t('screen_share.simple.live_title', { name: a.deviceName }), back: false,
      body: `
        <p class="simple-lead">${esc(lead)}</p>
        <p class="simple-muted">${esc(t('screen_share.simple.live_hint'))}</p>
        <div class="simple-done-actions"><button type="button" class="btn btn-danger simple-share-go" data-share-stop>${esc(t('screen_share.stop'))}</button></div>` }));
    container.querySelector('[data-share-stop]')?.addEventListener('click', () => stopScreenShare());
  }

  let wasSharing = false;
  function draw() {
    const a = activeScreenShare();
    if (a) { wasSharing = true; liveStep(a); return; }
    if (wasSharing) {
      wasSharing = false;
      shell(container, guideFrame({ step: total - 1, total, icon: '&#10003;', title: t('screen_share.simple.done_title'), back: false,
        body: `<p class="simple-lead">${esc(t('screen_share.simple.done'))}</p>
          <div class="simple-done-actions"><a class="btn btn-primary" href="#/">${esc(t('screen_share.simple.home'))}</a>
          <button type="button" class="btn btn-secondary" data-share-again>${esc(t('screen_share.simple.again'))}</button></div>` }));
      container.querySelector('[data-share-again]')?.addEventListener('click', () => { if (!skipPick) chosen = []; draw(); });
      return;
    }
    if (!chosen.length) pickStep(); else chooseStep();
  }
  draw();
}

/*
 * 3.0 content freshness: one gentle line when screens have been showing the same thing for a long
 * time ("2 screens haven't changed in 3 months — freshen them up?"), linking into the Change task —
 * straight to the screen when there is only one. Server: lib/freshness.js (GET /api/freshness/chips).
 * "Not now" hides it for a week on this browser; nothing is stored on the server.
 */
const FRESH_DISMISS_KEY = 'st_fresh_simple_dismissed';
async function freshnessLine(host) {
  if (!host) return;
  try {
    const until = Number(localStorage.getItem(FRESH_DISMISS_KEY) || 0);
    if (until > Date.now()) return;
  } catch { /* storage blocked: show it */ }
  let chips;
  try { chips = await api.getFreshnessChips(); } catch { return; }
  if (!chips || Array.isArray(chips) || !document.contains(host)) return;
  const stale = Object.entries(chips.devices || {})
    .filter(([, d]) => (d.status === 'stale' || d.status === 'very_stale') && d.age_days != null);
  if (!stale.length) return;
  const n = stale.length;
  const minDays = Math.floor(Math.min(...stale.map(([, d]) => d.age_days)));
  const text = minDays >= 60
    ? tn('simple.fresh.line_months', n, { months: Math.floor(minDays / 30) })
    : tn('simple.fresh.line_days', n, { days: minDays });
  const href = n === 1 ? `#/simple/change?device=${encodeURIComponent(stale[0][0])}` : '#/simple/change';
  host.innerHTML = `<div class="simple-notice simple-fresh">
    <span>&#127807; ${esc(text)}</span>
    <span style="display:flex;gap:8px">
      <button type="button" class="btn btn-secondary btn-sm" data-fresh-later>${esc(t('simple.fresh.later'))}</button>
      <a class="btn btn-primary btn-sm" href="${href}">${esc(tn('simple.fresh.cta', n))}</a>
    </span>
  </div>`;
  host.querySelector('[data-fresh-later]').addEventListener('click', () => {
    try { localStorage.setItem(FRESH_DISMISS_KEY, String(Date.now() + 7 * 86400000)); } catch { /* fine */ }
    host.innerHTML = '';
  });
}

/*
 * 3.0 energy & carbon: one friendly line for admins and editors — "Your screens used about 42 kWh
 * this month — schedules saved 18 kWh" — linking to the Energy page. Month to date, estimated
 * (docs/energy.md). Silent until there is at least a kWh to talk about.
 */
async function energyLine(host) {
  if (!host) return;
  let g;
  try { g = await api.getEnergyGlance(); } catch { return; }
  if (!g || !document.contains(host) || !(g.kwh >= 1)) return;
  const used = Math.round(g.kwh);
  const saved = Math.round(g.saved_kwh || 0);
  const text = saved >= 1 ? t('simple.energy.line_saved', { kwh: used, saved }) : t('simple.energy.line', { kwh: used });
  host.innerHTML = `<div class="simple-notice simple-energy">
    <span>&#9889; ${esc(text)}</span>
    <a class="btn btn-secondary btn-sm" href="#/energy">${esc(t('simple.energy.more'))}</a>
  </div>`;
}

/*
 * "What's coming up" on a screen card: the next few changes today and tomorrow, read-only, in
 * everyday words (docs/preview-at-time.md). Asked only when someone opens it.
 */
async function showComing(body, deviceId) {
  body.textContent = t('common.loading');
  let r;
  try { r = await upcomingChanges(deviceId); } catch { body.textContent = t('simple.coming.failed'); return; }
  body.textContent = '';
  if (r.now) {
    const p = document.createElement('p');
    p.className = 'simple-coming-now';
    p.textContent = t('simple.coming.now', { what: r.now });
    body.appendChild(p);
  }
  if (!r.changes.length) {
    const p = document.createElement('p');
    p.className = 'simple-muted';
    p.textContent = t('simple.coming.none');
    body.appendChild(p);
    return;
  }
  const ul = document.createElement('ul');
  for (const c of r.changes) {
    const li = document.createElement('li');
    const when = document.createElement('strong');
    when.textContent = c.when;
    li.append(when, ' ', c.text);
    ul.appendChild(li);
  }
  body.appendChild(ul);
}

/*
 * For the person who runs the server (platform admins only): the two things the Advanced shell
 * would have told them — a new version is out (the sidebar's Update badge), and the one-time
 * "share install statistics?" question (the Advanced dashboard's prompt, reused as is: it asks once
 * and only while the decision is unmade).
 */
async function adminNotices(host) {
  const u = cachedUser();
  if (!host || !isPlatformAdmin(u)) return;
  try {
    const v = await (await fetch('/api/version')).json();
    if (v && v.update_available && document.contains(host)) {
      const card = document.createElement('div');
      card.className = 'simple-notice';
      const text = document.createElement('span');
      text.textContent = t('simple.admin.update', { latest: v.latest_version || '', current: v.version || '' });
      const link = document.createElement('a');
      link.className = 'btn btn-primary btn-sm';
      link.href = '#/platform/system';
      link.textContent = t('simple.admin.update_how');
      card.append(text, link);
      host.appendChild(card);
    }
  } catch { /* the version check is a courtesy */ }
  try { await renderStatsPrompt(host); } catch { /* likewise */ }
}

// ---------------------------------------------------------------------------------------------
// Task: your team — invite someone to this workspace, see who is in it.
// Uses the workspace member/invite API the Advanced Members page uses (admin-only server-side).
// ---------------------------------------------------------------------------------------------

function currentWorkspace() {
  const u = cachedUser() || {};
  return (u.accessible_workspaces || []).find((w) => w.id === u.current_workspace_id) || null;
}
function canManageTeam() { const w = currentWorkspace(); return !!(w && w.can_admin); }

/** A view-only member (workspace_viewer) can look but not change. The server enforces it; this only
 *  keeps Simple view from offering tasks that would end in an error. Same rule as content-library. */
export function simpleCanChange(u = cachedUser()) {
  return !(u && u.current_workspace_role === 'workspace_viewer' && !u.acting_as);
}

/** Workspaces to offer in the account menu. Platform staff can see every workspace on the server;
 *  Simple view lists only the ones they belong to (Advanced has the full, searchable switcher). */
const SWITCH_MAX = 8;
function switchableWorkspaces(u) {
  const all = (u && u.accessible_workspaces) || [];
  const mine = isPlatformAdmin(u) || (u && u.role === 'platform_operator') ? all.filter((w) => w.workspace_role) : all;
  return mine.filter((w) => w.id !== u.current_workspace_id);
}

const ROLE_KEYS = {
  workspace_admin: 'simple.team.role_admin', workspace_editor: 'simple.team.role_editor', workspace_viewer: 'simple.team.role_viewer',
  org_owner: 'simple.team.role_owner', org_admin: 'simple.team.role_org_admin',
};

/** Pass an invite link on: Android's share sheet in the app, the browser's, or the clipboard. */
async function passOn(text) {
  if (inManagerApp() && window.STManager && typeof window.STManager.shareText === 'function') { window.STManager.shareText(text); return 'shared'; }
  if (navigator.share) { try { await navigator.share({ text }); return 'shared'; } catch { /* cancelled: fall through */ } }
  try { await navigator.clipboard.writeText(text); return 'copied'; } catch { return 'failed'; }
}

async function renderTeam(container) {
  const ws = currentWorkspace();
  if (!ws || !ws.can_admin) { window.location.hash = '#/'; return; }
  shell(container, `
    <div class="simple-help-top"><a href="#/" class="btn btn-secondary btn-sm">&larr; ${esc(t('simple.done.home'))}</a></div>
    <h1 class="simple-h1">${esc(t('simple.team.title'))}</h1>
    <div class="simple-card">
      <h3 class="simple-card-title">${esc(t('simple.team.invite_title'))}</h3>
      <label class="simple-label" for="teamEmail">${esc(t('simple.team.email'))}</label>
      <input id="teamEmail" class="input" type="email" autocomplete="off" inputmode="email" placeholder="name@example.com">
      <div class="simple-choice" role="radiogroup" aria-label="${esc(t('simple.team.can'))}" style="margin-top:12px">
        ${['workspace_editor', 'workspace_viewer', 'workspace_admin'].map((r, i) => `
          <label><input type="radio" name="teamRole" value="${r}" ${i === 0 ? 'checked' : ''}> <span><strong>${esc(t(ROLE_KEYS[r]))}</strong><small>${esc(t(ROLE_KEYS[r] + '_desc'))}</small></span></label>`).join('')}
      </div>
      <button type="button" class="btn btn-primary" data-invite>${esc(t('simple.team.invite_btn'))}</button>
      <div class="simple-status" data-status></div>
    </div>
    <h2 class="simple-h2">${esc(t('simple.team.people'))}</h2>
    <div class="simple-card simple-people" data-people><p class="simple-muted">${esc(t('common.loading'))}</p></div>`);

  const status = container.querySelector('[data-status]');
  const people = container.querySelector('[data-people]');
  const me = (cachedUser() || {}).id;

  async function loadPeople() {
    let members = [], invites = [];
    try { [members, invites] = await Promise.all([api.getWorkspaceMembers(ws.id), api.getWorkspaceInvites(ws.id)]); } catch { /* shown empty */ }
    const rows = [
      ...members.map((m) => `
        <div class="simple-person">
          <span><strong>${esc(m.name || m.email)}</strong><small>${esc(m.email)}${m.user_id === me ? ` · ${esc(t('simple.team.you'))}` : ''}</small></span>
          <span class="simple-person-role">${esc(t(ROLE_KEYS[m.role] || 'simple.team.role_viewer'))}</span>
          ${!m.via_org && m.user_id !== me ? `<button type="button" class="btn btn-secondary btn-sm" data-remove="${esc(m.user_id)}" data-name="${esc(m.name || m.email)}">${esc(t('simple.team.remove'))}</button>` : '<span></span>'}
        </div>`),
      ...(invites || []).map((i) => `
        <div class="simple-person is-pending">
          <span><strong>${esc(i.email)}</strong><small>${esc(t('simple.team.invited'))}</small></span>
          <span class="simple-person-role">${esc(t(ROLE_KEYS[i.role] || 'simple.team.role_viewer'))}</span>
          <button type="button" class="btn btn-secondary btn-sm" data-cancel="${esc(i.id)}">${esc(t('simple.team.cancel_invite'))}</button>
        </div>`),
    ];
    people.innerHTML = rows.join('') || `<p class="simple-muted">${esc(t('simple.team.nobody'))}</p>`;
    people.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
      try { await api.cancelWorkspaceInvite(ws.id, b.dataset.cancel); loadPeople(); } catch (err) { showToast(err.message, 'error'); }
    }));
    people.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
      if (!window.confirm(t('simple.team.remove_confirm', { name: b.dataset.name }))) return;
      try { await api.removeWorkspaceMember(ws.id, b.dataset.remove); loadPeople(); } catch (err) { showToast(err.message, 'error'); }
    }));
  }

  container.querySelector('[data-invite]').addEventListener('click', async (e) => {
    const email = container.querySelector('#teamEmail').value.trim();
    const role = container.querySelector('input[name="teamRole"]:checked').value;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { status.textContent = t('simple.team.bad_email'); return; }
    e.target.disabled = true;
    status.textContent = t('simple.working_invite');
    try {
      const r = await api.inviteWorkspaceMember(ws.id, { email, role });
      container.querySelector('#teamEmail').value = '';
      status.innerHTML = '';
      const msg = document.createElement('p');
      msg.textContent = r.email_sent ? t('simple.team.sent', { email }) : t('simple.team.not_emailed', { email });
      status.appendChild(msg);
      if (r.accept_url) {
        const share = document.createElement('button');
        share.type = 'button';
        share.className = 'btn btn-secondary btn-sm';
        share.style.marginTop = '8px';
        share.textContent = t(inManagerApp() || navigator.share ? 'simple.team.share_link' : 'simple.team.copy_link');
        share.addEventListener('click', async () => {
          const res = await passOn(t('simple.team.share_text', { name: ws.name, url: r.accept_url }));
          if (res === 'copied') showToast(t('simple.team.copied'), 'success');
        });
        status.appendChild(share);
      }
      loadPeople();
    } catch (err) {
      status.textContent = err.message || t('simple.team.failed');
    } finally { e.target.disabled = false; }
  });
  loadPeople();
}

// ---------------------------------------------------------------------------------------------
// Shared: put content on a screen
// ---------------------------------------------------------------------------------------------

/**
 * Show `contentIds` on `device`, published through the normal endpoint (so a workspace that reviews
 * changes keeps them as a draft for review).
 *
 * 'add': appended to the list the screen plays now.
 * 'replace': the screen ends up playing exactly these items, WITHOUT minting a new playlist each
 * time (Replace used to detach the screen and let the server create "<Screen> playlist" afresh on
 * every use, so the Playlists page filled up with copies):
 *   1. the screen's own auto-generated list, used by no other screen → emptied and refilled in place;
 *   2. otherwise (it follows a shared or hand-made list) → its earlier own list is re-attached if one
 *      exists that no screen uses ("<Screen> playlist", auto-generated), then refilled — so a screen
 *      that went "same as" and back reuses its list;
 *   3. only when neither exists is a list created, once per screen.
 * A shared or hand-made list is never edited by Replace: another screen or a schedule may use it.
 */
export async function showOnScreen(device, contentIds, how, ctx = {}) {
  const devices = ctx.devices || [];
  const playlists = ctx.playlists || [];
  const usedByOthers = (pid) => devices.some((d) => d.id !== device.id && d.playlist_id === pid);
  const current = playlists.find((p) => p.id === device.playlist_id);

  if (how === 'replace') {
    const ownAuto = current && current.is_auto_generated && !usedByOthers(current.id);
    if (!ownAuto) {
      const spare = playlists.find((p) => p.is_auto_generated && p.name === `${device.name} playlist`
        && p.id !== device.playlist_id && !devices.some((d) => d.playlist_id === p.id));
      if (spare) {
        await api.assignPlaylistToDevice(spare.id, device.id);
        device.playlist_id = spare.id;
      } else if (device.playlist_id) {
        await api.clearDevicePlaylist(device.id); // the next add creates this screen's own list, once
        device.playlist_id = null;
      }
    }
    if (device.playlist_id) {
      const existing = await api.getAssignments(device.id).catch(() => []);
      for (const item of existing || []) await api.deleteAssignment(item.id, device.id);
    }
  }

  let playlistId = device.playlist_id || null;
  const added = new Set();
  let redirected = false;
  // An entry is a content id, or an item body as is ({ widget_id, duration_sec } for a sign).
  for (const id of contentIds) {
    const r = await api.addAssignment(device.id, typeof id === 'object' ? id : { content_id: id });
    if (r && r.playlist_id) playlistId = r.playlist_id;
    if (r && r.id != null) added.add(String(r.id));
    if (r && r.redirected_to) redirected = true;
  }
  /*
   * ⚠️ Replace on a screen that INHERITS (its group's or wall's list, incl. after the clear above):
   * the first add FORKED that list (server/lib/fork-device-playlist.js), so the screen's new own list
   * still holds every inherited item and "replace" played as "add". Drop all but what was just added.
   * Only the fork is touched: the group's list and the other screens are not. Skipped when head
   * office's playlist plays here: those adds went into shared slot content, not this screen's list.
   */
  if (how === 'replace' && !redirected && added.size) {
    const now = await api.getAssignments(device.id);
    for (const item of now || []) if (!added.has(String(item.id))) await api.deleteAssignment(item.id, device.id);
  }
  if (!playlistId) return { ok: true };
  device.playlist_id = playlistId;
  const state = await publishOrSubmit(playlistId, { note: ctx.note || `From the Simple view: ${device.name}` });
  return { ok: true, review: state === 'review' };
}

async function useSameAs(device, playlist) {
  await api.assignPlaylistToDevice(playlist.id, device.id);
  if (!playlist.published_snapshot) return (await publishOrSubmit(playlist.id)) === 'review';
  return false;
}

function wireDrop(area, input, onFiles) {
  area.addEventListener('click', (e) => { if (!e.target.closest('button')) input.click(); });
  input.addEventListener('change', () => { const f = [...(input.files || [])]; input.value = ''; if (f.length) onFiles(f); });
  area.addEventListener('dragover', (e) => { e.preventDefault(); area.classList.add('is-over'); });
  area.addEventListener('dragleave', () => area.classList.remove('is-over'));
  area.addEventListener('drop', (e) => { e.preventDefault(); area.classList.remove('is-over'); const f = [...(e.dataTransfer?.files || [])]; if (f.length) onFiles(f); });
}

async function sampleFile() {
  const res = await fetch(SAMPLE_URL);
  if (!res.ok) throw new Error(String(res.status));
  const blob = await res.blob();
  return new File([blob], 'Welcome screen.jpg', { type: blob.type || 'image/jpeg' });
}

/*
 * The workspace's own photos and videos, newest first, as a tap-to-select grid. Capped at
 * LIBRARY_MAX so a large library stays a quick choice here; everything is still in Advanced view's
 * Content page. Hidden when the library has nothing playable yet.
 */
const LIBRARY_MAX = 60;
async function loadLibrary(container, onUse) {
  const block = container.querySelector('[data-library]');
  const grid = container.querySelector('[data-library-grid]');
  const useBtn = container.querySelector('[data-library-use]');
  if (!block || !grid || !useBtn) return;
  let items = [];
  try { items = (await api.getAllContent({ maxItems: 500 })).items || []; } catch { return; }
  items = items
    .filter((c) => /^(image|video)\//.test(c.mime_type || '') && !c.remote_url)
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
    .slice(0, LIBRARY_MAX);
  if (!items.length || !document.contains(block)) return;
  const picked = [];
  grid.innerHTML = items.map((c) => `
    <button type="button" class="simple-lib-item" data-lib-id="${esc(c.id)}" aria-pressed="false" title="${esc(c.filename || '')}">
      ${c.thumbnail_path ? `<img data-auth-src="/api/content/${esc(c.id)}/thumbnail" alt="">` : `<span class="simple-lib-icon">${String(c.mime_type).startsWith('video/') ? '&#127909;' : '&#128444;'}</span>`}
      <span class="simple-lib-check" aria-hidden="true">&#10003;</span>
      <span class="simple-lib-name">${esc(c.filename || '')}</span>
    </button>`).join('');
  block.hidden = false;
  hydrateAuthImages(grid, { eager: true });
  const paint = () => {
    useBtn.disabled = picked.length === 0;
    useBtn.textContent = picked.length ? tn('simple.library.use_n', picked.length) : t('simple.library.use', { n: 0 });
  };
  grid.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lib-id]');
    if (!b) return;
    const id = b.dataset.libId;
    const i = picked.indexOf(id);
    // Order of picking is the order they play in.
    if (i === -1) picked.push(id); else picked.splice(i, 1);
    b.setAttribute('aria-pressed', i === -1 ? 'true' : 'false');
    paint();
  });
  useBtn.addEventListener('click', () => { if (picked.length) onUse(picked.slice()); });
  paint();
}

function doneBody(lines) {
  return `<p class="simple-lead">${esc(lines[0])}</p>${lines[1] ? `<p class="simple-muted">${esc(lines[1])}</p>` : ''}
    <div class="simple-done-actions">
      <a class="btn btn-primary" href="#/">${esc(t('simple.done.home'))}</a>
      <a class="btn btn-secondary" href="#/simple/change">${esc(t('simple.task.change'))}</a>
    </div>`;
}

// ---------------------------------------------------------------------------------------------
// Task: change what a screen shows
// ---------------------------------------------------------------------------------------------

async function renderChange(container, presetId) {
  let devices = [];
  let playlists = [];
  try { [devices, playlists] = await Promise.all([api.getDevices(), api.getPlaylists()]); } catch { /* shown below */ }
  if (!devices.length) {
    shell(container, guideFrame({ step: 0, total: 1, icon: '&#128250;', title: t('simple.change.no_screens_title'), back: false,
      body: `<p class="simple-lead">${esc(t('simple.home.no_screens'))}</p><div class="simple-done-actions"><a class="btn btn-primary" href="#/add-screen">${esc(t('simple.task.add'))}</a></div>` }));
    return;
  }
  let device = devices.find((d) => d.id === presetId) || (devices.length === 1 ? devices[0] : null);
  const skipPick = !!device;
  const total = skipPick ? 2 : 3;
  let how = 'replace';

  const wireBack = (fn) => container.querySelector('[data-guide-back]')?.addEventListener('click', fn);

  function pickStep() {
    shell(container, guideFrame({ step: 0, total, icon: '&#128250;', title: t('simple.change.pick_title'), back: false,
      body: `<div class="simple-pick">${devices.map((d) => `
        <button type="button" class="simple-screen" data-pick="${esc(d.id)}">
          <span class="simple-screen-shot">${d.screenshot_path ? `<img src="${screenshotUrl(d.id, d.screenshot_at || '')}" alt="">` : '&#128250;'}</span>
          <span class="simple-screen-name">${esc(d.name)}</span>
          <span class="simple-screen-status ${online(d) ? 'on' : 'off'}">${esc(online(d) ? t('simple.status.online') : t('simple.status.offline'))}</span>
        </button>`).join('')}</div>` }));
    container.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
      device = devices.find((d) => d.id === b.dataset.pick);
      contentStep();
    }));
  }

  function contentStep() {
    const step = skipPick ? 0 : 1;
    const sharedWith = device.playlist_id ? devices.filter((d) => d.id !== device.id && d.playlist_id === device.playlist_id).map((d) => d.name) : [];
    const others = playlists.filter((p) => (p.item_count || 0) > 0 && p.id !== device.playlist_id);
    shell(container, guideFrame({ step, total, icon: '&#127912;', title: t('simple.change.what_title', { name: device.name }), back: !skipPick,
      body: `
        <div class="simple-choice" role="radiogroup" aria-label="${esc(t('simple.change.how_label'))}">
          <label><input type="radio" name="simpleHow" value="replace" ${how === 'replace' ? 'checked' : ''}> <span><strong>${esc(t('simple.change.replace'))}</strong><small>${esc(t('simple.change.replace_desc'))}</small></span></label>
          <label><input type="radio" name="simpleHow" value="add" ${how === 'add' ? 'checked' : ''}> <span><strong>${esc(t('simple.change.add'))}</strong><small>${esc(sharedWith.length ? t('simple.change.add_shared', { names: sharedWith.join(', ') }) : t('simple.change.add_desc'))}</small></span></label>
        </div>
        <div class="simple-drop" data-drop>
          <div class="simple-drop-icon">&#128193;</div>
          <p>${esc(t(isTouchFirst() ? 'onboarding.step.upload.tap_to_select' : 'onboarding.step.upload.click_to_select'))}</p>
          <input type="file" data-file multiple accept="${ACCEPT}" hidden>
        </div>
        <div class="simple-or"><span>${esc(t('onboarding.step.upload.or'))}</span> <button type="button" class="btn btn-secondary btn-sm" data-sample>${esc(t('onboarding.step.upload.use_sample'))}</button></div>
        <!-- Photos and videos already in this workspace's library: pick instead of uploading again. -->
        <div class="simple-library" data-library hidden>
          <div class="simple-library-head">
            <span>${esc(t('simple.library.title'))}</span>
            <button type="button" class="btn btn-primary btn-sm" data-library-use disabled>${esc(t('simple.library.use', { n: 0 }))}</button>
          </div>
          <div class="simple-library-grid" data-library-grid></div>
        </div>
        <!-- Free stock photos (components/stock-picker.js): hidden when the server has no provider key. -->
        <div class="simple-stock" data-stock hidden></div>
        ${others.length ? `
        <div class="simple-sameas">
          <label for="simpleSameAs">${esc(t('onboarding.step.upload.same_as_label'))}</label>
          <div><select id="simpleSameAs" class="input">${others.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${p.item_count || 0})</option>`).join('')}</select>
          <button type="button" class="btn btn-primary btn-sm" data-sameas>${esc(t('onboarding.step.upload.same_as_btn'))}</button></div>
        </div>` : ''}
        <p class="simple-status" data-status></p>` }));
    wireBack(pickStep);
    container.querySelectorAll('input[name="simpleHow"]').forEach((r) => r.addEventListener('change', () => { how = r.value; }));
    const status = container.querySelector('[data-status]');
    const busy = (msg) => { status.textContent = msg; container.querySelectorAll('button, input').forEach((e) => { e.disabled = true; }); };
    // At a storage limit the upgrade prompt (plan-nudges.js) says it; the status line does not repeat it.
    const fail = (err) => { status.textContent = err && err.planPromptShown ? '' : ((err && err.message) || t('onboarding.toast.upload_failed')); container.querySelectorAll('button, input').forEach((e) => { e.disabled = false; }); };

    const go = async (files) => {
      busy(tn('simple.uploading', files.length));
      try {
        const up = await api.uploadContent(files, (pct) => { status.textContent = `${tn('simple.uploading', files.length)} ${pct}%`; });
        const items = (Array.isArray(up) ? up : [up]).filter((c) => c && c.id);
        const r = await showOnScreen(device, items.map((c) => c.id), how, { devices, playlists });
        doneStep(r.review ? t('simple.done.review', { name: device.name }) : tn('simple.done.shown', items.length, { name: device.name }), r.review);
      } catch (err) { fail(err); }
    };
    wireDrop(container.querySelector('[data-drop]'), container.querySelector('[data-file]'), go);
    loadLibrary(container, async (ids) => {
      busy(t('simple.working'));
      try {
        const r = await showOnScreen(device, ids, how, { devices, playlists });
        doneStep(r.review ? t('simple.done.review', { name: device.name }) : tn('simple.done.shown', ids.length, { name: device.name }), r.review);
      } catch (err) { fail(err); }
    });
    container.querySelector('[data-sample]').addEventListener('click', async () => {
      try { go([await sampleFile()]); } catch { fail(new Error(t('onboarding.toast.sample_failed'))); }
    });
    mountStockPicker(container.querySelector('[data-stock]'), {
      collapsed: true,
      addLabel: (n) => (n ? tn('simple.library.use_n', n) : t('simple.library.use')),
      onAdded: async (rows) => {
        busy(t('simple.working'));
        try {
          const ids = rows.map((c) => c.id);
          const r = await showOnScreen(device, ids, how, { devices, playlists });
          doneStep(r.review ? t('simple.done.review', { name: device.name }) : tn('simple.done.shown', ids.length, { name: device.name }), r.review);
        } catch (err) { fail(err); }
      },
    });
    container.querySelector('[data-sameas]')?.addEventListener('click', async () => {
      const p = others.find((x) => x.id === container.querySelector('#simpleSameAs').value);
      if (!p) return;
      busy(t('simple.working'));
      try {
        const review = await useSameAs(device, p);
        doneStep(review ? t('simple.done.review', { name: device.name }) : t('simple.done.same_as', { name: device.name, playlist: p.name }), review);
      } catch (err) { fail(err); }
    });
  }

  // Live: "It's live!". In review: "Sent for review" — nothing claims to be showing until approved.
  function doneStep(line, review = false) {
    shell(container, guideFrame({ step: total - 1, total, icon: review ? '&#9203;' : '&#127881;',
      title: t(review ? 'simple.done.review_title' : 'onboarding.step.done.title'), back: false,
      body: doneBody([line, t(review ? 'simple.done.review_hint' : 'simple.done.seconds')]) }));
    if (!review) api.trackEvent('first_publish', { from: 'simple_change' });
  }

  if (device) contentStep(); else pickStep();
}

// ---------------------------------------------------------------------------------------------
// Task: upload photos (then choose screens)
// ---------------------------------------------------------------------------------------------

async function renderUpload(container, presetIds = []) {
  let devices = [];
  let playlists = [];
  try { [devices, playlists] = await Promise.all([api.getDevices(), api.getPlaylists()]); } catch { devices = devices || []; }
  const total = devices.length ? 3 : 2;
  let uploaded = [];
  let how = 'add';

  function filesStep() {
    shell(container, guideFrame({ step: 0, total, icon: '&#128247;', title: t('simple.upload.title'), back: false,
      body: `
        <div class="simple-drop" data-drop>
          <div class="simple-drop-icon">&#128193;</div>
          <p>${esc(t(isTouchFirst() ? 'onboarding.step.upload.tap_to_select' : 'onboarding.step.upload.click_to_select'))}</p>
          <input type="file" data-file multiple accept="${ACCEPT}" hidden>
        </div>
        <div class="simple-stock" data-stock hidden></div>
        <p class="simple-status" data-status></p>` }));
    const status = container.querySelector('[data-status]');
    // Free stock photos: added to the library like an upload, then the same "which screens?" step.
    mountStockPicker(container.querySelector('[data-stock]'), {
      collapsed: true,
      onAdded: (rows) => {
        uploaded = rows.filter((c) => c && c.id);
        if (devices.length) screensStep();
        else doneOnly(tn('simple.upload.saved', uploaded.length));
      },
    });
    wireDrop(container.querySelector('[data-drop]'), container.querySelector('[data-file]'), async (files) => {
      status.textContent = tn('simple.uploading', files.length);
      try {
        const up = await api.uploadContent(files, (pct) => { status.textContent = `${tn('simple.uploading', files.length)} ${pct}%`; });
        uploaded = (Array.isArray(up) ? up : [up]).filter((c) => c && c.id);
        if (devices.length) screensStep();
        else doneOnly(tn('simple.upload.saved', uploaded.length));
      } catch (err) { status.textContent = err.planPromptShown ? '' : (err.message || t('onboarding.toast.upload_failed')); }
    });
  }

  function screensStep() {
    shell(container, guideFrame({ step: 1, total, icon: '&#128250;', title: tn('simple.upload.where_title', uploaded.length), back: false,
      next: true, nextLabel: t('simple.upload.show_btn'),
      body: `
        <div class="simple-checks">${devices.map((d) => `
          <label><input type="checkbox" value="${esc(d.id)}" checked> <span>${esc(d.name)}</span>
          <small class="simple-screen-status ${online(d) ? 'on' : 'off'}">${esc(online(d) ? t('simple.status.online') : t('simple.status.offline'))}</small></label>`).join('')}</div>
        <div class="simple-choice" role="radiogroup" aria-label="${esc(t('simple.change.how_label'))}">
          <label><input type="radio" name="simpleHow" value="add" checked> <span><strong>${esc(t('simple.change.add'))}</strong><small>${esc(t('simple.change.add_desc'))}</small></span></label>
          <label><input type="radio" name="simpleHow" value="replace"> <span><strong>${esc(t('simple.change.replace'))}</strong><small>${esc(t('simple.change.replace_desc'))}</small></span></label>
        </div>
        <p class="simple-muted">${esc(t('simple.upload.later_hint'))}</p>
        <p class="simple-status" data-status></p>` }));
    container.querySelectorAll('input[name="simpleHow"]').forEach((r) => r.addEventListener('change', () => { how = r.value; }));
    container.querySelector('[data-guide-next]').addEventListener('click', async (e) => {
      const ids = [...container.querySelectorAll('.simple-checks input:checked')].map((i) => i.value);
      const status = container.querySelector('[data-status]');
      if (!ids.length) { doneOnly(tn('simple.upload.saved', uploaded.length)); return; }
      e.target.disabled = true;
      status.textContent = t('simple.working');
      let review = false;
      try {
        // Screens that share one list are updated once, not once per screen.
        const seen = new Set();
        for (const id of ids) {
          const d = devices.find((x) => x.id === id);
          if (!d) continue;
          if (how === 'add' && d.playlist_id && seen.has(d.playlist_id)) continue;
          if (d.playlist_id) seen.add(d.playlist_id);
          const r = await showOnScreen(d, uploaded.map((c) => c.id), how, { devices, playlists });
          review = review || !!r.review;
        }
        shell(container, guideFrame({ step: total - 1, total, icon: review ? '&#9203;' : '&#127881;',
          title: t(review ? 'simple.done.review_title' : 'onboarding.step.done.title'), back: false,
          body: doneBody([review ? tn('simple.upload.review_on', ids.length) : tn('simple.upload.shown_on', ids.length),
            t(review ? 'simple.done.review_hint' : 'simple.done.seconds')]) }));
      } catch (err) {
        status.textContent = err.message || t('onboarding.toast.assign_failed');
        e.target.disabled = false;
      }
    });
  }

  function doneOnly(line) {
    shell(container, guideFrame({ step: total - 1, total, icon: '&#9989;', title: t('simple.upload.saved_title'), back: false,
      body: `<p class="simple-lead">${esc(line)}</p><div class="simple-done-actions">
        <a class="btn btn-primary" href="#/">${esc(t('simple.done.home'))}</a>
        ${devices.length ? '' : `<a class="btn btn-secondary" href="#/add-screen">${esc(t('simple.task.add'))}</a>`}</div>` }));
  }

  // Shared from the phone's Gallery (Manager app): the files are already uploaded; go straight to
  // "which screens?".
  if (presetIds.length) {
    uploaded = presetIds.map((id) => ({ id }));
    if (devices.length) screensStep(); else doneOnly(tn('simple.upload.saved', uploaded.length));
    return;
  }
  filesStep();
}

// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// 3.0: Sign in with a passkey — a password account adds one, guide-style. Managing them (rename,
// remove) is in Settings; this is the one thing an everyday user needs: "next time, use my phone /
// fingerprint". Not offered inside the Manager app (see lib/passkeys.js passkeysUsableHere).
// ---------------------------------------------------------------------------------------------

function passkeyMenuShown(u) {
  return !!u && u.auth_provider === 'local' && !inManagerApp() && passkeysSupported();
}

async function renderPasskey(container) {
  const u = cachedUser() || {};
  if (!passkeyMenuShown(u)) { window.location.replace('#/'); return; }
  shell(container, `<p class="simple-muted">${esc(t('common.loading'))}</p>`);
  const page = container.querySelector('.simple-page');
  let st;
  try { st = await api.passkeysList(); } catch (err) { st = { error: err.message }; }
  if (!document.contains(page)) return;

  // Anything that stops a passkey being added here is said plainly, with a way home.
  let blocker = '';
  if (st.error) blocker = st.error;
  else if (!st.available) blocker = unavailableMessage(st.reason, isPlatformAdmin(u));
  else if (!st.eligible) blocker = t('passkey.sso_only_note');
  else if (st.origin && st.origin !== window.location.origin) blocker = t('passkey.wrong_address', { origin: st.origin });
  else if (st.passkeys.length >= st.max) blocker = t('passkey.limit', { n: st.max });

  const body = blocker
    ? `<p>${esc(blocker)}</p>`
    : `<p>${esc(t('passkey.simple_intro'))}</p>
       ${st.passkeys.length ? `<p class="simple-muted">${esc(t('passkey.simple_have', { n: st.passkeys.length }))}</p>` : ''}
       <label class="simple-label" for="pkPassword">${esc(t('passkey.simple_password'))}</label>
       <input id="pkPassword" class="input" type="password" autocomplete="current-password">
       ${st.totp_enabled ? `<label class="simple-label" for="pkCode" style="margin-top:10px">${esc(t('auth.mfa_code_label'))}</label>
       <input id="pkCode" class="input" inputmode="numeric" autocomplete="one-time-code" maxlength="6">` : ''}
       <div class="simple-status" data-status></div>`;
  page.innerHTML = guideFrame({
    step: 0, total: 2, icon: '&#128273;', title: t('passkey.simple_title'), body, back: false,
    next: !blocker, nextLabel: t('passkey.simple_set_up'),
  });
  const next = page.querySelector('[data-guide-next]');
  if (!next) return;
  page.querySelector('#pkPassword').focus();
  const status = page.querySelector('[data-status]');
  next.addEventListener('click', async () => {
    const password = page.querySelector('#pkPassword').value;
    if (!password) { status.textContent = t('passkey.password_required'); return; }
    next.disabled = true;
    status.textContent = t('passkey.simple_follow_browser');
    try {
      await addPasskey({ password, code: page.querySelector('#pkCode')?.value.trim(), name: suggestedPasskeyName() });
    } catch (err) {
      status.textContent = err.cancelled ? '' : err.message;
      next.disabled = false;
      return;
    }
    page.innerHTML = guideFrame({
      step: 1, total: 2, icon: '&#10004;', title: t('passkey.simple_done_title'), back: false,
      body: `<p>${esc(t('passkey.simple_done_body'))}</p>
             <a href="#/" class="btn btn-primary">${esc(t('simple.done.home'))}</a>`,
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Task: requests from people without an account (views/requests.js is the Advanced version).
// What is waiting, with a big Approve / Decline each; the request links to pass on; and a three-step
// guide to make a new link for some screens. Server: routes/content-requests.js. Approving goes
// through the same release gate as everything else, so a workspace that requires review still needs
// a reviewer to press it.
// ---------------------------------------------------------------------------------------------

async function renderRequests(container) {
  shell(container, `
    <div class="simple-help-top"><a href="#/" class="btn btn-secondary btn-sm">&larr; ${esc(t('simple.done.home'))}</a></div>
    <h1 class="simple-h1">${esc(t('simple.req.title'))}</h1>
    <p class="simple-muted">${esc(t('simple.req.intro'))}</p>
    <h2 class="simple-h2">${esc(t('simple.req.waiting'))}</h2>
    <div data-waiting><p class="simple-muted">${esc(t('common.loading'))}</p></div>
    <h2 class="simple-h2">${esc(t('simple.req.links'))}</h2>
    <div data-links><p class="simple-muted">${esc(t('common.loading'))}</p></div>
    <a class="btn btn-primary" href="#/simple/requests/new" style="margin-top:12px">${esc(t('simple.req.new'))}</a>`);
  const waiting = container.querySelector('[data-waiting]');
  const links = container.querySelector('[data-links]');

  async function loadWaiting() {
    let rows = [];
    try { rows = await api.get('/content-requests/requests?status=pending'); } catch (e) { waiting.innerHTML = `<p class="simple-status">${esc(e.message)}</p>`; return; }
    if (!rows.length) { waiting.innerHTML = `<div class="simple-card"><p class="simple-muted" style="margin:0">${esc(t('simple.req.none'))}</p></div>`; return; }
    waiting.innerHTML = rows.map((r) => `
      <div class="simple-card" data-req="${esc(r.id)}" style="margin-bottom:12px">
        <img data-auth-src="/api/content/${esc(r.content_id)}/thumbnail" alt="" style="width:100%;max-height:220px;object-fit:contain;border-radius:8px;background:#000">
        <h3 class="simple-card-title" style="margin-top:12px">${esc(r.title)}</h3>
        <p class="simple-lead">${esc(t('creq.from', { name: r.requester_name, email: r.requester_email }))}</p>
        <p class="simple-muted">${esc(t('simple.req.when_where', { start: r.start_date, end: r.end_date, where: r.targets.map((x) => x.label).join(', ') }))}</p>
        <div class="simple-done-actions">
          <button type="button" class="btn btn-primary" data-approve>${esc(t('simple.req.approve'))}</button>
          <button type="button" class="btn btn-secondary" data-decline>${esc(t('simple.req.decline'))}</button>
        </div>
        <div data-why hidden style="margin-top:12px">
          <label class="simple-label">${esc(t('simple.req.why'))}</label>
          <textarea class="input" rows="3" maxlength="1000"></textarea>
          <button type="button" class="btn btn-primary" data-send style="margin-top:8px">${esc(t('simple.req.send_decline'))}</button>
        </div>
        <p class="simple-status" data-status></p>
      </div>`).join('');
    hydrateAuthImages(waiting);
    waiting.querySelectorAll('[data-req]').forEach((el) => {
      const id = el.dataset.req;
      const status = el.querySelector('[data-status]');
      el.querySelector('[data-approve]').addEventListener('click', async (e) => {
        e.target.disabled = true; status.textContent = t('simple.working');
        try {
          const out = await api.post(`/content-requests/requests/${encodeURIComponent(id)}/approve`, {});
          status.textContent = t(out.all_published ? 'simple.req.approved' : 'creq.toast.partial');
          el.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        } catch (err) { status.textContent = err.message; e.target.disabled = false; }
      });
      el.querySelector('[data-decline]').addEventListener('click', () => { el.querySelector('[data-why]').hidden = false; el.querySelector('textarea').focus(); });
      el.querySelector('[data-send]').addEventListener('click', async (e) => {
        const reason = el.querySelector('textarea').value.trim();
        if (!reason) { status.textContent = t('simple.req.why'); return; }
        e.target.disabled = true;
        try {
          await api.post(`/content-requests/requests/${encodeURIComponent(id)}/reject`, { reason });
          status.textContent = t('simple.req.declined');
          el.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        } catch (err) { status.textContent = err.message; e.target.disabled = false; }
      });
    });
  }

  async function loadLinks() {
    let forms = [];
    try { forms = await api.get('/content-requests/forms'); } catch (e) { links.innerHTML = `<p class="simple-status">${esc(e.message)}</p>`; return; }
    const open = forms.filter((f) => f.status === 'open');
    if (!open.length) { links.innerHTML = `<div class="simple-card"><p class="simple-muted" style="margin:0">${esc(t('simple.req.no_links'))}</p></div>`; return; }
    links.innerHTML = open.map((f) => `
      <div class="simple-card" data-form="${esc(f.id)}" style="margin-bottom:12px">
        <h3 class="simple-card-title">${esc(f.title)}</h3>
        <p class="simple-muted" style="word-break:break-all" data-url></p>
        <button type="button" class="btn btn-primary" data-share>${esc(t('simple.req.share'))}</button>
        <p class="simple-status" data-status></p>
      </div>`).join('');
    links.querySelectorAll('[data-form]').forEach((el) => {
      const f = open.find((x) => x.id === el.dataset.form);
      const url = `${location.origin}${f.path}`;
      el.querySelector('[data-url]').textContent = url;
      el.querySelector('[data-share]').addEventListener('click', async () => {
        const how = await passOn(url);
        el.querySelector('[data-status]').textContent = t(how === 'failed' ? 'simple.req.copy_failed' : 'simple.req.shared');
      });
    });
  }
  await Promise.all([loadWaiting(), loadLinks()]);
}

async function renderRequestNew(container) {
  let devices = [];
  try { devices = await api.getDevices(); } catch { devices = []; }
  let title = '';
  const total = 3;

  function nameStep() {
    shell(container, guideFrame({ step: 0, total, icon: '&#128229;', title: t('simple.req.new_q1'), back: false, next: true, nextLabel: t('simple.req.next'),
      body: `<label class="simple-label" for="reqTitle">${esc(t('simple.req.new_q1_label'))}</label>
        <input id="reqTitle" class="input" maxlength="120" placeholder="${esc(t('simple.req.new_q1_placeholder'))}" value="${esc(title)}">
        <p class="simple-status" data-status></p>` }));
    container.querySelector('[data-guide-next]').addEventListener('click', () => {
      title = container.querySelector('#reqTitle').value.trim();
      if (!title) { container.querySelector('[data-status]').textContent = t('simple.req.new_q1_label'); return; }
      screensStep();
    });
  }

  function screensStep() {
    shell(container, guideFrame({ step: 1, total, icon: '&#128250;', title: t('simple.req.new_q2'), next: !!devices.length, nextLabel: t('simple.req.make_link'),
      body: devices.length ? `<div class="simple-checks">${devices.map((d) => `<label><input type="checkbox" value="${esc(d.id)}"> <span>${esc(d.name)}</span></label>`).join('')}</div>
        <p class="simple-muted">${esc(t('simple.req.new_q2_hint'))}</p><p class="simple-status" data-status></p>`
        : `<p class="simple-lead">${esc(t('simple.req.no_screens'))}</p>` }));
    container.querySelector('[data-guide-back]')?.addEventListener('click', nameStep);
    container.querySelector('[data-guide-next]')?.addEventListener('click', async (e) => {
      const ids = [...container.querySelectorAll('.simple-checks input:checked')].map((i) => i.value);
      const status = container.querySelector('[data-status]');
      if (!ids.length) { status.textContent = t('simple.req.new_q2_hint'); return; }
      e.target.disabled = true;
      try {
        const f = await api.post('/content-requests/forms', {
          title, targets: ids.map((id) => ({ label: (devices.find((d) => d.id === id) || {}).name || id, device_id: id })),
        });
        doneStep(f);
      } catch (err) { status.textContent = err.message; e.target.disabled = false; }
    });
  }

  function doneStep(f) {
    const url = `${location.origin}${f.path}`;
    shell(container, guideFrame({ step: 2, total, icon: '&#127881;', title: t('simple.req.new_done'), back: false,
      body: `<p class="simple-lead">${esc(t('simple.req.new_done_body'))}</p>
        <p class="simple-muted" style="word-break:break-all" data-url></p>
        <div class="simple-done-actions"><button type="button" class="btn btn-primary" data-share>${esc(t('simple.req.share'))}</button>
          <a class="btn btn-secondary" href="#/simple/requests">${esc(t('simple.req.title'))}</a></div>
        <p class="simple-status" data-status></p>` }));
    container.querySelector('[data-url]').textContent = url;
    container.querySelector('[data-share]').addEventListener('click', async () => {
      const how = await passOn(url);
      container.querySelector('[data-status]').textContent = t(how === 'failed' ? 'simple.req.copy_failed' : 'simple.req.shared');
    });
  }
  nameStep();
}


// ---------------------------------------------------------------------------------------------
// Help, inside Simple view. The full Help page is about the whole product (widgets, layouts,
// kiosks, video walls) and opens in the full shell; this one answers what Simple view does, keeps
// the top bar, and always has a way home. Fully translated (simple.help.*), unlike views/help.js:
// the people who use Simple view are the ones least likely to read English documentation.
// ---------------------------------------------------------------------------------------------

// Guides and questions for Simple view (translated: i18n keys simple.help.*).
const SIMPLE_GUIDES = [
  { icon: '&#10133;', key: 'simple.help.g1', steps: 4 },
  { icon: '&#9998;', key: 'simple.help.g2', steps: 4 },
  { icon: '&#128247;', key: 'simple.help.g3', steps: 3 },
  { icon: '&#127991;&#65039;', key: 'simple.help.g4', steps: 3 },
];

const SIMPLE_FAQ = [1, 2, 3, 4, 5, 6];

/*
 * 3.0 Import from another app: the import wizard in guide mode (views/migrate.js), in the guide frame.
 * Skip or finish goes home; an import keeps running on the server and this page shows its progress
 * when it is opened again (the Manager app may be backgrounded for the whole import).
 */
function renderImport(container) {
  shell(container, guideFrame({ step: 0, total: 1, icon: '&#128230;', title: t('migrate.guide.title'), body: '<div id="simpleImport"></div>', back: false }));
  mountMigrate(document.getElementById('simpleImport'), { guide: true, onSkip: () => { window.location.hash = '#/'; }, onFinish: () => { window.location.hash = '#/'; } });
  cleanupFns.push(cleanupMigrate);
}

function renderHelp(container) {
  const u = cachedUser() || {};
  const trial = plansVisible(u)
    ? [{ q: t('simple.help.trial_q'), a: t('simple.help.trial_a') }]
    : [];
  shell(container, `
    <div class="simple-help-top"><a href="#/" class="btn btn-secondary btn-sm">&larr; ${esc(t('simple.done.home'))}</a></div>
    <h1 class="simple-h1">${esc(t('simple.help.title'))}</h1>
    <div class="simple-help-guides">${SIMPLE_GUIDES.map((g) => `
      <div class="simple-card">
        <h3>${g.icon} ${esc(t(`${g.key}.title`))}</h3>
        <ol>${Array.from({ length: g.steps }, (_, i) => `<li>${esc(t(`${g.key}.s${i + 1}`))}</li>`).join('')}</ol>
      </div>`).join('')}
    </div>
    <h2 class="simple-h2">${esc(t('simple.help.faq'))}</h2>
    <div class="simple-card simple-faq">${[...SIMPLE_FAQ.map((n) => ({ q: t(`simple.help.q${n}`), a: t(`simple.help.a${n}`) })), ...trial].map((f) => `
      <details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}
    </div>
    <div id="simpleHelpImport"></div>
    <div class="simple-card simple-help-more">
      <p>${esc(t('simple.help.more'))}</p>
      <button type="button" class="btn btn-secondary" data-help-advanced>${esc(t('simple.help.more_btn'))}</button>
    </div>`);
  // 3.0: the import from another app, while the workspace is still new (no screens).
  if (simpleCanChange()) {
    api.getDevices().then((devices) => {
      const el = document.getElementById('simpleHelpImport');
      if (!el || (Array.isArray(devices) && devices.length)) return;
      el.innerHTML = `<div class="simple-card"><h3>&#128230; ${esc(t('migrate.simple.help_title'))}</h3><p>${esc(t('migrate.simple.help_body'))}</p>
        <a class="btn btn-primary" href="#/simple/import">${esc(t('migrate.simple.offer_link'))}</a></div>`;
    }).catch(() => { /* no offer */ });
  }
  container.querySelector('[data-help-advanced]').addEventListener('click', async () => {
    if (inManagerApp()) { openOutsideApp('/app#/switch-advanced?next=help'); return; }
    await setUiMode('advanced');
    window.location.hash = '#/help';
  });
}

/*
 * Simple view, on any OTHER page (Plan & billing, Account settings, a bookmark): no sidebar, and a
 * slim bar with the way home and the view switch, so Simple never strands someone in the full shell.
 * Mounted above #app by app.js; removed in Advanced view and on Simple's own pages (which have a
 * top bar of their own).
 */
export function mountBackBar() {
  if (document.getElementById('simpleBackBar')) return;
  const app = document.getElementById('app');
  if (!app || !app.parentNode) return;
  const bar = document.createElement('div');
  bar.id = 'simpleBackBar';
  bar.className = 'simple-backbar';
  bar.innerHTML = `
    <a href="#/" class="btn btn-secondary btn-sm">&larr; ${esc(t('simple.done.home'))}</a>
    <div class="ui-mode-switch simple-switch" role="radiogroup" aria-label="${esc(t('simple.view_label'))}">
      <button type="button" role="radio" aria-checked="true">${esc(t('nav.view_simple'))}</button>
      <button type="button" role="radio" aria-checked="false" data-simple-mode="advanced">${esc(t('nav.view_advanced'))}</button>
    </div>`;
  bar.querySelector('[data-simple-mode="advanced"]').addEventListener('click', () => setUiMode('advanced'));
  app.parentNode.insertBefore(bar, app);
}

export function removeBackBar() {
  document.getElementById('simpleBackBar')?.remove();
}

export function isSimpleRoute(hash) {
  return hash === '#/' || hash === '#' || hash === '' || hash.startsWith('#/simple/');
}

export function render(container, hash = window.location.hash || '#/') {
  cleanup();
  removeBackBar();
  container.classList.add('simple-mode-app');
  document.documentElement.classList.add('simple-shell');
  // These pages draw from the cached account (localStorage). After a workspace switch or a role
  // change the fresh /me lands a moment later (app.js refreshCurrentUser → 'user-refreshed'): draw
  // home and team again then, or they would show the previous workspace's name, role and tasks.
  // Change and Upload are left alone so a half-finished task is not wiped.
  const accessKey = (u) => (u ? `${u.current_workspace_id}|${u.current_workspace_role}|${(u.accessible_workspaces || []).length}` : '');
  const drawnFor = accessKey(cachedUser());
  const onRefreshed = (e) => {
    const h = window.location.hash || '#/';
    if (accessKey(e.detail) === drawnFor || !isSimpleRoute(h)) return;
    if (h.startsWith('#/simple/change') || h.startsWith('#/simple/upload') || h.startsWith('#/simple/sign') || h.startsWith('#/simple/news') || h.startsWith('#/simple/brand') || h.startsWith('#/simple/share') || h.startsWith('#/simple/requests/new') || h.startsWith('#/simple/ai-setup') || h.startsWith('#/simple/import')) return;
    render(container, h);
  };
  window.addEventListener('user-refreshed', onRefreshed);
  cleanupFns.push(() => window.removeEventListener('user-refreshed', onRefreshed));
  const q = new URLSearchParams(hash.split('?')[1] || '');
  // A view-only member has nothing to do on Change or Upload (bookmark, shared link): go home.
  if (!simpleCanChange() && (hash.startsWith('#/simple/import') || hash.startsWith('#/simple/change') || hash.startsWith('#/simple/upload') || hash.startsWith('#/simple/share') || hash.startsWith('#/simple/sign') || hash.startsWith('#/simple/news') || hash.startsWith('#/simple/requests') || hash.startsWith('#/simple/ai-setup'))) {
    window.location.replace('#/');
    return undefined;
  }
  if (hash.startsWith('#/simple/change')) return renderChange(container, q.get('device'));
  if (hash.startsWith('#/simple/upload')) return renderUpload(container, (q.get('ids') || '').split(',').filter((x) => /^[0-9a-f-]{36}$/i.test(x)));
  if (hash.startsWith('#/simple/sign')) return renderSign(container, { simple: true, device: q.get('device'), from: q.get('from') });
  if (hash.startsWith('#/simple/brand')) return renderBrand(container, { simple: true });
  if (hash.startsWith('#/simple/news')) return renderNews(container);
  if (hash.startsWith('#/simple/ai-setup')) { cleanupFns.push(cleanupAiSetup); return renderAiSetup(container, { simple: true, hash }); }
  if (hash.startsWith('#/simple/help')) return renderHelp(container);
  if (hash.startsWith('#/simple/import')) return renderImport(container);
  if (hash.startsWith('#/simple/passkey')) return renderPasskey(container);
  if (hash.startsWith('#/simple/team')) return renderTeam(container);
  if (hash.startsWith('#/simple/share')) return renderShare(container, q.get('device'));
  if (hash.startsWith('#/simple/requests/new')) return renderRequestNew(container);
  if (hash.startsWith('#/simple/requests')) return renderRequests(container);
  return renderHome(container);
}

export function cleanup() {
  cleanupFns.forEach((fn) => { try { fn(); } catch { /* */ } });
  cleanupFns = [];
  document.getElementById('app')?.classList.remove('simple-mode-app');
  document.documentElement.classList.remove('simple-shell');
}
