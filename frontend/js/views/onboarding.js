import { showToast } from '../components/toast.js';
import { api } from '../api.js';
import { t } from '../i18n.js';
import { esc, isTouchFirst } from '../utils.js';
import { publishOrSubmit } from '../components/release.js';
import { mountStockPicker } from '../components/stock-picker.js';
import { isSimpleMode } from '../components/ui-mode.js';
import { mountMigrate, cleanup as cleanupMigrate } from './migrate.js';

// 3.0: the sample a first-run user can show instead of hunting for a file (brand-neutral on purpose).
const SAMPLE_URL = '/assets/samples/welcome-screen.jpg';

function cachedUser() {
  try { return JSON.parse(localStorage.getItem('user') || 'null'); } catch { return null; }
}

/*
 * 3.0: the hosted trial, said once at the moment it means most — right after the first screen
 * lights up. Never on a self-hosted instance or one with billing hidden, and never for an account
 * that is not on a running trial.
 */
function trialBlock() {
  const u = cachedUser();
  const tr = u && u.trial;
  if (!u || u.self_hosted || u.hide_billing || !tr || !tr.active) return '';
  const devices = u.plan_limits && u.plan_limits.max_devices > 0 ? u.plan_limits.max_devices : 25;
  return `<div style="background:var(--bg-input);border:1px solid var(--accent);border-radius:8px;padding:16px;margin-bottom:16px">
      <p style="font-size:14px;color:var(--text-primary);font-weight:600;margin-bottom:6px">${esc(t('onboarding.trial.title', { plan: u.plan_name || 'Pro', n: tr.days_left }))}</p>
      <p style="font-size:13px;color:var(--text-secondary);line-height:1.5">${esc(t('onboarding.trial.body', { devices }))}</p>
      <a href="#/billing?from=onboarding" id="onboardSeePlans" style="display:inline-block;margin-top:8px;font-size:13px;color:var(--accent);font-weight:600">${esc(t('onboarding.trial.see_plans'))} →</a>
    </div>`;
}

// Steps are computed lazily so translated strings refresh on language change.
function getSteps(addMode = false) {
  const steps = [
    {
      title: t('onboarding.step.welcome.title'),
      icon: '&#128075;',
      content: `<p style="font-size:16px;color:var(--text-secondary);margin-bottom:16px">${t('onboarding.step.welcome.intro')}</p>
        <p style="color:var(--text-muted);font-size:14px">${t('onboarding.step.welcome.guide_through')}</p>
        <ul style="color:var(--text-muted);font-size:14px;padding-left:20px;margin-top:8px;line-height:2">
          <li>${t('onboarding.step.welcome.bullet_download')}</li>
          <li>${t('onboarding.step.welcome.bullet_pair')}</li>
          <li>${t('onboarding.step.welcome.bullet_upload')}</li>
        </ul>`,
      action: null
    },
    {
      title: t('onboarding.step.player.title'),
      icon: '&#128229;',
      content: `<p style="color:var(--text-secondary);margin-bottom:16px">${t('onboarding.step.player.intro')}</p>
        <!-- 3.0: the fastest path to "a screen is playing something I chose" needs no hardware at all. -->
        <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;background:var(--bg-input);border:1px solid var(--accent);border-radius:8px;padding:14px 16px;margin-bottom:12px">
          <div style="font-size:28px">&#128187;</div>
          <div style="flex:1 1 200px;min-width:0">
            <div style="font-weight:600;font-size:14px">${t('onboarding.step.player.try_browser_title')}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:2px">${t('onboarding.step.player.try_browser_desc')}</div>
          </div>
          <a href="/player" target="_blank" rel="noopener" class="btn btn-primary btn-sm" style="white-space:nowrap;margin-left:auto">${t('onboarding.step.player.try_browser_btn')}</a>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px">
          <a href="/download/apk" style="background:var(--bg-input);border:1px solid var(--border);border-radius:8px;padding:16px;text-align:center;text-decoration:none;color:var(--text-primary)">
            <div style="font-size:32px;margin-bottom:8px">&#129302;</div>
            <div style="font-weight:600;font-size:14px">${t('onboarding.step.player.android_label')}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('onboarding.step.player.android_desc')}</div>
          </a>
          <a href="/player" target="_blank" style="background:var(--bg-input);border:1px solid var(--border);border-radius:8px;padding:16px;text-align:center;text-decoration:none;color:var(--text-primary)">
            <div style="font-size:32px;margin-bottom:8px">&#127760;</div>
            <div style="font-weight:600;font-size:14px">${t('onboarding.step.player.web_label')}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('onboarding.step.player.web_desc')}</div>
          </a>
        </div>
        <!--
          A first-time operator holding a BrightSign, an LG panel or a Chromebox saw only these two
          tiles and reasonably concluded their hardware was not supported. One line to the instance's
          own downloads index, which lists every player it can serve plus a setup guide for each.
        -->
        <p style="font-size:12px;margin-top:12px">
          <a href="/download/" target="_blank" style="color:var(--accent);font-weight:600">${t('onboarding.step.player.all_downloads')}</a>
        </p>
        <p style="color:var(--text-muted);font-size:12px;margin-top:12px">${t('onboarding.step.player.url_hint')}</p>
        <code style="display:block;background:var(--bg-input);padding:10px;border-radius:6px;margin-top:6px;font-size:14px;user-select:all">${window.location.origin}</code>`,
      action: null
    },
    {
      title: t('onboarding.step.pair.title'),
      icon: '&#128279;',
      content: `<p id="onboardPairIntro" style="color:var(--text-secondary);margin-bottom:16px">${t('onboarding.step.pair.intro')}</p>
        <div style="text-align:center;margin:20px 0">
          <input type="text" id="onboardPairingCode" maxlength="6" pattern="[0-9]{6}" placeholder="000000"
            style="max-width:240px;width:100%;padding:16px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;
            color:var(--text-primary);font-size:32px;font-weight:700;text-align:center;letter-spacing:8px;font-family:monospace">
        </div>
        <div style="text-align:center">
          <input type="text" id="onboardDeviceName" placeholder="${t('onboarding.step.pair.name_placeholder')}"
            style="max-width:240px;width:100%;padding:10px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-size:14px;text-align:center">
        </div>
        <!--
          #313 — the same escape hatch the dashboard's Add Display dialog offers, because this is
          where a first-time operator actually is. A vMix browser input deletes its whole profile
          when vMix closes, so pairing it with a code works exactly once; ticking this creates the
          display here and hands back a URL that carries its identity instead.
        -->
        <label id="onboardNoStorageWrap" style="display:flex;gap:8px;align-items:flex-start;max-width:340px;margin:16px auto 0;cursor:pointer">
          <input type="checkbox" id="onboardNoStorage" style="margin-top:3px">
          <span>
            <span style="font-size:13px;color:var(--text-secondary)">${t('add_display.no_storage')}</span>
            <span style="display:block;font-size:11px;color:var(--text-muted);margin-top:2px">${t('add_display.no_storage_hint')}</span>
          </span>
        </label>
        <div id="onboardPlayerUrlWrap" style="display:none;margin-top:16px">
          <p style="font-size:13px;color:var(--text-secondary);margin-bottom:8px">${t('add_display.created_intro')}</p>
          <input class="input" id="onboardPlayerUrl" readonly style="width:100%;font-family:monospace;font-size:11px">
          <div style="margin-top:8px"><button class="btn btn-secondary btn-sm" id="onboardCopyUrlBtn">${t('device.enrol.copy')}</button></div>
          <p style="font-size:11px;color:#fbbf24;margin-top:8px">${t('device.enrol.warning')}</p>
        </div>
        <p id="onboardPairStatus" style="color:var(--text-muted);font-size:13px;text-align:center;margin-top:12px"></p>`,
      action: 'pair'
    },
    {
      title: t('onboarding.step.upload.title'),
      icon: '&#128228;',
      content: `<p style="color:var(--text-secondary);margin-bottom:16px">${t('onboarding.step.upload.intro')}</p>
        <div style="border:2px dashed var(--border);border-radius:12px;padding:32px;text-align:center;cursor:pointer" id="onboardUploadArea">
          <div style="font-size:32px;margin-bottom:8px">&#128193;</div>
          <p style="color:var(--text-secondary)">${t(isTouchFirst() ? 'onboarding.step.upload.tap_to_select' : 'onboarding.step.upload.click_to_select')}</p>
          <p style="color:var(--text-muted);font-size:12px;margin-top:4px">${t('onboarding.step.upload.formats')}</p>
          <input type="file" id="onboardFileInput" style="display:none" accept="video/*,image/*,audio/*" multiple>
        </div>
        <div style="text-align:center;margin-top:12px">
          <span style="color:var(--text-muted);font-size:12px;margin-right:8px">${t('onboarding.step.upload.or')}</span>
          <button type="button" class="btn btn-secondary btn-sm" id="onboardUseSample">${t('onboarding.step.upload.use_sample')}</button>
          <!-- 3.0 Make a sign: no photos needed — a real sign from a built-in template, in a minute. -->
          <button type="button" class="btn btn-secondary btn-sm" id="onboardMakeSign" style="margin-left:4px">&#127991;&#65039; ${esc(t('signs.onboarding_btn'))}</button>
          <p style="color:var(--text-muted);font-size:12px;margin-top:8px">${esc(t('signs.onboarding_hint'))}</p>
        </div>
        <!-- 3.0 free stock photos (components/stock-picker.js); hidden when the server has no key. -->
        <div id="onboardStock" class="onboard-stock" hidden></div>
        <!-- 3.0 Add screen: a second screen usually shows what the first one does. Filled in by
             populateSameAs() from the workspace's playlists; hidden when there are none. -->
        <div id="onboardSameAsBlock" style="display:none;margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
          <label for="onboardSameAs" style="display:block;font-size:13px;color:var(--text-secondary);margin-bottom:8px">${t('onboarding.step.upload.same_as_label')}</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <select class="input" id="onboardSameAs" style="flex:1;min-width:180px"></select>
            <button type="button" class="btn btn-primary btn-sm" id="onboardSameAsBtn">${t('onboarding.step.upload.same_as_btn')}</button>
          </div>
          <p id="onboardSameAsStatus" style="color:var(--text-muted);font-size:12px;margin-top:6px"></p>
        </div>
        <div id="onboardUploadProgress" style="display:none;margin-top:12px">
          <div style="height:4px;background:var(--bg-primary);border-radius:2px;overflow:hidden">
            <div id="onboardProgressBar" style="height:100%;background:var(--accent);width:0%;transition:width 0.3s"></div>
          </div>
          <p id="onboardUploadText" style="font-size:12px;color:var(--text-muted);margin-top:6px">${t('onboarding.step.upload.uploading')}</p>
        </div>`,
      action: 'upload'
    },
    {
      title: t('onboarding.step.done.title'),
      icon: '&#127881;',
      /*
       * ⚠️ THE PLAYLIST PICKER. Onboarding used to end at "a screen exists", which left the one
       * thing the operator actually wanted — something on the screen — as a second hunt through
       * Playlists after the wizard had already congratulated them. A vendor running Juuno
       * alongside this said exactly that, and the ask is small: offer the playlists that already
       * exist, here, before they walk away.
       *
       * Hidden (and left alone) when no display was paired — there is nothing to assign to — and
       * skippable, because a first-run wizard that will not let you leave is worse than one that
       * ends a step early.
       */
      content: `<p style="font-size:16px;color:var(--text-secondary);margin-bottom:20px">${t('onboarding.step.done.intro')}</p>
        <!-- #313: shown only when this run created a display that needs a URL. -->
        <div id="onboardDonePlayerUrl" style="display:none;background:var(--bg-input);border-radius:8px;padding:16px;margin-bottom:16px">
          <p style="font-size:14px;color:var(--text-primary);font-weight:600;margin-bottom:6px">${t('add_display.created_intro')}</p>
          <input class="input" id="onboardDoneUrl" readonly style="width:100%;font-family:monospace;font-size:11px">
          <div style="margin-top:8px"><button class="btn btn-secondary btn-sm" id="onboardDoneCopyBtn">${t('device.enrol.copy')}</button></div>
          <p style="font-size:11px;color:#fbbf24;margin-top:8px">${t('device.enrol.warning')}</p>
        </div>
        <div id="onboardAssignBlock" style="display:none;background:var(--bg-input);border-radius:8px;padding:16px;margin-bottom:16px">
          <label for="onboardPlaylistPick" style="display:block;font-size:14px;color:var(--text-primary);font-weight:600;margin-bottom:8px">${t('onboarding.step.done.assign_label')}</label>
          <select class="input" id="onboardPlaylistPick" style="width:100%">
            <option value="">${t('onboarding.step.done.assign_none')}</option>
          </select>
          <p id="onboardAssignStatus" style="color:var(--text-muted);font-size:12px;margin-top:8px"></p>
        </div>
        ${addMode ? '' : trialBlock()}
        <!-- 3.0: next steps a first-week user can actually take, in the order they tend to need them;
             the power-user surfaces (layouts, kiosk, widgets...) are one toggle away, and say so. -->
        <div style="background:var(--bg-input);border-radius:8px;padding:16px;margin-bottom:16px">
          <p style="font-size:14px;color:var(--text-primary);font-weight:600;margin-bottom:8px">${t('onboarding.step.done.whats_next')}</p>
          <ul style="color:var(--text-muted);font-size:13px;padding-left:20px;line-height:2">
            <li>${t('onboarding.step.done.next_another_screen')}</li>
            <li>${t('onboarding.step.done.next_playlist')}</li>
            <li>${t('onboarding.step.done.next_schedule')}</li>
            <li>${t('onboarding.step.done.next_templates')}</li>
            <li>${t('onboarding.step.done.next_all_features')}</li>
          </ul>
        </div>`,
      action: null
    }
  ];
  // 3.0 Add screen (Simple view): the same guide for every later screen, without the welcome.
  if (addMode) return steps.slice(1);
  /*
   * 3.0 switch to ScreenTinker: right after the welcome, a new account is asked whether it is coming
   * from another signage app. "No, start fresh" is the Next button, so the guide is exactly what it
   * was for everyone who says no. Choosing an app runs the import wizard (views/migrate.js, guide
   * mode) inside this step's card, one question at a time; finishing or skipping it moves on to the
   * player step, and the done step's playlist picker then offers the imported playlists for the
   * first screen. An import keeps running on the server if the person moves on or the app is
   * backgrounded; coming back to this step shows its progress.
   */
  const importStep = {
    title: t('migrate.guide.title'),
    icon: '&#128230;',
    content: '<div id="onboardImport"></div>',
    action: 'import',
  };
  return [steps[0], importStep, ...steps.slice(1)];
}

export function render(container, { mode = 'first' } = {}) {
  // 'add': Simple view's Add screen — the first-run guide for screen two, three... (#/add-screen).
  const addMode = mode === 'add';
  let currentStep = 0;
  let pairedDeviceId = null;
  let assignedPlaylistId = null;   // whatever the upload step put on this device, if anything
  let createdPlayerUrl = null;     // #313: set once a no-storage display has been created here
  let sentForReview = false;       // 3.0: the content went to the review queue, not to the screen
  // Playlists in this workspace that have NEVER been published, from the picker's own fetch.
  // Assigning one of these without publishing hands the screen an empty list (see publish()).
  const neverPublished = new Set();

  /*
   * ⚠️ WITHOUT THIS THE WIZARD LIES. Adding an item to a playlist marks it DRAFT, and the payload
   * a player receives is built from `published_snapshot` — with no fallback to the live items. A
   * playlist that has never been published therefore sends the device an EMPTY list.
   *
   * So the upload step used to upload the file, create the device's playlist, assign it, show
   * "Content uploaded and assigned!", and finish on a screen reading "Your display is paired and
   * content is playing!" — while the display showed nothing at all, with no indication anywhere
   * that a Publish was still owed. The Displays page at least shows a Publish button and a draft
   * marker; onboarding showed neither and claimed success instead.
   *
   * Publishing through the real endpoint (the same one the Displays page uses) rather than writing
   * a snapshot here: publish carries the change-triggered guard that stops an unchanged list
   * restarting every screen, and the pre-expansion structure capture that makes "discard" able to
   * restore nesting.
   */
  async function publish(playlistId) {
    if (!playlistId) return { ok: true };
    try {
      // 3.0: a workspace that requires review gets it SUBMITTED for review (components/release.js),
      // and the last step then says "Sent for review" instead of claiming it is playing.
      const state = await publishOrSubmit(playlistId, { note: 'From the setup guide' });
      neverPublished.delete(playlistId);
      if (state === 'review') sentForReview = true;
      return { ok: true, review: state === 'review' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /*
   * 3.0: finishing or skipping is remembered on the ACCOUNT (users.onboarded_at), not only in this
   * browser, so the guide does not start again on a new laptop. The localStorage flag stays as the
   * offline/old-server fallback the router has always read.
   */
  async function finish(how) {
    if (addMode) { window.location.hash = '#/'; return; } // not the first run: nothing to record
    localStorage.setItem('rd_onboarded', 'true');
    api.trackEvent(how === 'skip' ? 'onboarding_skipped' : 'onboarding_completed', { step: currentStep });
    try { await api.updateMe({ onboarded: true }); } catch { /* the local flag still holds */ }
    window.location.hash = '#/';
    window.location.reload();
  }

  function renderStep() {
    cleanupMigrate();
    const STEPS = getSteps(addMode);
    const step = STEPS[currentStep];
    const isFirst = currentStep === 0;
    const isLast = currentStep === STEPS.length - 1;

    container.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 48px)">
        <div style="width:560px;max-width:95vw">
          <!-- Progress -->
          <div style="display:flex;gap:4px;margin-bottom:32px">
            ${STEPS.map((_, i) => `<div style="flex:1;height:4px;border-radius:2px;background:${i <= currentStep ? 'var(--accent)' : 'var(--border)'}"></div>`).join('')}
          </div>

          <div style="text-align:center;margin-bottom:24px">
            <div style="font-size:48px;margin-bottom:12px">${step.icon}</div>
            <h2 style="font-size:24px">${step.title}</h2>
          </div>

          <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:24px;margin-bottom:24px">
            ${step.content}
          </div>

          <div style="display:flex;justify-content:space-between">
            ${isFirst ? '<div></div>' : `<button class="btn btn-secondary" id="prevBtn">${t('onboarding.back')}</button>`}
            <div style="display:flex;gap:8px">
              ${!isLast ? `<button class="btn btn-secondary" id="skipBtn" style="color:var(--text-muted)">${t(addMode ? 'common.cancel' : 'onboarding.skip')}</button>` : ''}
              <button class="btn btn-primary" id="nextBtn">${isLast ? t('onboarding.go_to_dashboard') : step.action === 'pair' ? t('onboarding.pair_display') : step.action === 'import' ? esc(t('migrate.guide.fresh')) : t('onboarding.next')}</button>
            </div>
          </div>
        </div>
      </div>
    `;

    document.getElementById('prevBtn')?.addEventListener('click', () => { currentStep--; renderStep(); });
    document.getElementById('skipBtn')?.addEventListener('click', () => finish('skip'));
    document.getElementById('nextBtn')?.addEventListener('click', handleNext);

    if (step.action === 'import') {
      const advance = () => { if (currentStep === STEPS.indexOf(step)) { currentStep++; renderStep(); } };
      mountMigrate(document.getElementById('onboardImport'), { guide: true, onSkip: advance, onFinish: advance });
    }

    if (step.action === 'pair') {
      const box = document.getElementById('onboardNoStorage');
      const codeWrap = document.getElementById('onboardPairingCode')?.parentElement;
      const urlWrap = document.getElementById('onboardPlayerUrlWrap');
      const nextBtn = document.getElementById('nextBtn');

      const intro = document.getElementById('onboardPairIntro');
      const sync = () => {
        const noStorage = !!box?.checked;
        // Hidden, not merely optional: a form with two meanings for one input is how someone ends
        // up typing a code into a box that is ignoring it.
        if (codeWrap) codeWrap.style.display = noStorage ? 'none' : '';
        // The prose and the button have to move with it. Leaving "Enter the 6-digit code" above a
        // hidden code box, under a button that says Pair, describes a step that is not happening.
        if (intro) intro.textContent = noStorage ? t('add_display.intro_no_storage') : t('onboarding.step.pair.intro');
        if (nextBtn) nextBtn.textContent = noStorage ? t('add_display.create_btn') : t('onboarding.pair_display');
      };
      box?.addEventListener('change', sync);
      sync();

      // A display created earlier in this wizard: show its URL again rather than the form, so
      // stepping Back and forward does not lose the one thing the operator came away with.
      if (createdPlayerUrl && urlWrap) {
        /*
         * Everything that asked a question is put away — the code box, the name box, the checkbox
         * and the "enter the 6-digit code" line. The display already exists; leaving its inputs on
         * screen invites the operator to fill them in again, and the intro would be describing a
         * step that has already happened. What is left is the one thing they came away with.
         */
        if (codeWrap) codeWrap.style.display = 'none';
        document.getElementById('onboardNoStorageWrap').style.display = 'none';
        const nameEl = document.getElementById('onboardDeviceName');
        if (nameEl && nameEl.parentElement) nameEl.parentElement.style.display = 'none';
        const introEl = document.getElementById('onboardPairIntro');
        if (introEl) introEl.style.display = 'none';
        document.getElementById('onboardPlayerUrl').value = createdPlayerUrl;
        urlWrap.style.display = 'block';
        if (nextBtn) nextBtn.textContent = t('onboarding.next');
      }
      document.getElementById('onboardCopyUrlBtn')?.addEventListener('click', () => {
        const el = document.getElementById('onboardPlayerUrl');
        el.select();
        // execCommand, not navigator.clipboard: a self-hosted dashboard is often plain HTTP on a
        // LAN, where the async clipboard API does not exist.
        try { document.execCommand('copy'); showToast(t('device.enrol.copied')); }
        catch { showToast(t('device.enrol.copy_failed'), 'error'); }
      });
    }

    if (step.action === 'upload') {
      const area = document.getElementById('onboardUploadArea');
      const input = document.getElementById('onboardFileInput');
      area?.addEventListener('click', () => input.click());
      input?.addEventListener('change', () => { const picked = [...(input.files || [])]; input.value = ''; uploadFiles(picked); });
      // Dropping a handful of photos straight from the desktop works too.
      area?.addEventListener('dragover', (e) => { e.preventDefault(); area.style.borderColor = 'var(--accent)'; });
      area?.addEventListener('dragleave', () => { area.style.borderColor = ''; });
      area?.addEventListener('drop', (e) => { e.preventDefault(); area.style.borderColor = ''; uploadFiles([...(e.dataTransfer?.files || [])]); });
      document.getElementById('onboardUseSample')?.addEventListener('click', useSample);
      // Free stock photos land in the library like an upload; then the same assign-and-publish.
      mountStockPicker(document.getElementById('onboardStock'), { collapsed: true, onAdded: (rows) => placeItems(rows) });
      document.getElementById('onboardMakeSign')?.addEventListener('click', makeSign);
      populateSameAs();
    }

    if (isLast && sentForReview) {
      // Nothing is playing yet: the workspace reviews changes first. Say so, plainly.
      const h2 = container.querySelector('h2');
      if (h2) h2.textContent = t('simple.done.review_title');
      const icon = h2?.previousElementSibling;
      if (icon) icon.innerHTML = '&#9203;';
      const intro = document.querySelector('#onboardDonePlayerUrl')?.previousElementSibling;
      if (intro) intro.textContent = t('onboarding.step.done.intro_review');
    }
    if (isLast) {
      populatePlaylistPicker();
      document.getElementById('onboardSeePlans')?.addEventListener('click', () => api.trackEvent('trial_banner_clicked', { from: 'onboarding' }));
      // The URL this run produced, if any — the one thing the operator cannot reconstruct by
      // guessing, so it is on the step they actually finish on.
      if (createdPlayerUrl) {
        /*
         * ⚠️ AND THE HEADLINE HAS TO STOP CLAIMING IT IS PLAYING. "Your display is paired and
         * content is playing!" is true for the pairing path and false for this one: the player has
         * not connected yet — it cannot, until someone pastes this URL into it — and on a fresh
         * account there is no content either. Congratulating an operator for something that has
         * not happened is the same failure as the publish bug earlier in this release.
         */
        const introEl = document.querySelector('#onboardDonePlayerUrl')?.previousElementSibling;
        if (introEl) introEl.textContent = t('onboarding.step.done.intro_url');

        const wrap = document.getElementById('onboardDonePlayerUrl');
        const input = document.getElementById('onboardDoneUrl');
        if (wrap && input) {
          input.value = createdPlayerUrl;
          wrap.style.display = 'block';
          document.getElementById('onboardDoneCopyBtn').addEventListener('click', () => {
            input.select();
            try { document.execCommand('copy'); showToast(t('device.enrol.copied')); }
            catch { showToast(t('device.enrol.copy_failed'), 'error'); }
          });
        }
      }
    }
  }

  // Fill the last step's picker with the workspace's existing playlists. Nothing is created here:
  // the list is whatever Playlists already shows, so the option an operator picks is one they can
  // find again. A failed or empty fetch simply leaves the block hidden — onboarding still finishes.
  async function populatePlaylistPicker() {
    const block = document.getElementById('onboardAssignBlock');
    const select = document.getElementById('onboardPlaylistPick');
    if (!block || !select || !pairedDeviceId) return;

    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/playlists', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const playlists = await res.json();
      if (!Array.isArray(playlists) || playlists.length === 0) return;

      for (const p of playlists) {
        // A playlist with no snapshot has never played anywhere and cannot start now without a
        // publish. Recorded here so the finish handler knows which ones need one.
        if (!p.published_snapshot) neverPublished.add(p.id);
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${p.name} (${p.item_count || 0})`;
        // The upload step already assigned this device's own auto-generated playlist; preselecting
        // it means "keep what is playing" is the default and Finish changes nothing by surprise.
        if (p.id === assignedPlaylistId) opt.selected = true;
        select.appendChild(opt);
      }
      block.style.display = 'block';
    } catch { /* the picker is a convenience; never block finishing on it */ }
  }

  async function handleNext() {
    const STEPS = getSteps(addMode);
    const step = STEPS[currentStep];

    if (step.action === 'pair') {
      const code = document.getElementById('onboardPairingCode')?.value.trim();
      const name = document.getElementById('onboardDeviceName')?.value.trim();
      const status = document.getElementById('onboardPairStatus');

      /*
       * #313 — the no-storage path. Creates the display here and shows its URL, then STAYS on this
       * step: the URL is the only thing the operator takes away from it, and advancing straight
       * past it would hide the one piece of the wizard they cannot get back by guessing. The next
       * press of the button continues, and the label changes to say so.
       */
      const noStorage = document.getElementById('onboardNoStorage')?.checked;
      if (noStorage && !createdPlayerUrl) {
        try {
          if (status) status.textContent = '';
          const r = await api.createWebPlayerDisplay(name || undefined);
          pairedDeviceId = r.device.id;
          createdPlayerUrl = r.player_url;
          showToast(t('onboarding.toast.display_created'), 'success');
          /*
           * ⚠️ KEEP MOVING. The display exists; stopping here to make the operator deal with a URL
           * turns a five-step wizard into a detour, and they cannot act on it yet anyway — the
           * player is not in front of them. The URL rides along and is shown on the last step,
           * where it is the thing they leave with, and it is on the display's own page for good.
           */
          currentStep++;
          renderStep();
        } catch (err) {
          // At the screen limit the upgrade prompt says it (plan-nudges.js); the step stays quiet.
          if (status) status.textContent = err.planPromptShown ? '' : (err.message || t('onboarding.toast.pair_failed'));
        }
        return;
      }
      if (noStorage && createdPlayerUrl) { currentStep++; renderStep(); return; }

      if (!code || code.length !== 6) {
        if (status) status.textContent = t('onboarding.toast.invalid_code');
        return;
      }

      /*
       * ⚠️ THROUGH api.pairDevice, THE SAME CALL THE ADD SCREEN DIALOG MAKES. A raw fetch here never
       * reached api.js's requestError, which is what raises the upgrade prompt on a plan limit, so at
       * the Free limit this step only printed "Device limit reached" where Advanced view explained the
       * plans. A refusal from the server (err.status set) keeps its own words as before; only a request
       * that never got an answer says "Pairing failed: …".
       */
      let data;
      try {
        if (status) status.textContent = t('onboarding.toast.pairing');
        data = await api.pairDevice(code, name || undefined);
      } catch (err) {
        // A plan limit is answered by the upgrade prompt (plan-nudges.js); the step does not repeat it.
        if (err.planPromptShown) { if (status) status.textContent = ''; return; }
        if (status) status.textContent = err.status ? ((err.body && err.body.error) || t('onboarding.toast.pair_failed'))
          : t('onboarding.toast.pair_failed_with_error', { error: err.message });
        return;
      }
      pairedDeviceId = data.id;
      showToast(t('onboarding.toast.paired'), 'success');
      currentStep++;
      renderStep();
      return;
    }

    if (currentStep === STEPS.length - 1) {
      /*
       * ⚠️ THE SAME WRITE THE DISPLAYS PAGE MAKES, through the same endpoint. device-detail's
       * playlist picker calls api.assignPlaylistToDevice -> POST /api/playlists/:id/assign, which
       * stamps devices.playlist_id AND playlist_source = 'device' so the resolver treats it as a
       * real per-screen override. Writing playlist_id from here directly would have produced a
       * screen the inheritance resolver could quietly overwrite from its group later.
       */
      const pick = document.getElementById('onboardPlaylistPick')?.value;
      if (pairedDeviceId && pick && pick !== assignedPlaylistId) {
        const status = document.getElementById('onboardAssignStatus');
        try {
          const token = localStorage.getItem('token');
          const res = await fetch(`/api/playlists/${pick}/assign`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ device_id: pairedDeviceId })
          });
          if (!res.ok) {
            // Say so and stay put: silently dropping it is the gap this step exists to close.
            const data = await res.json().catch(() => ({}));
            if (status) status.textContent = data.error || t('onboarding.toast.assign_failed');
            return;
          }
          /*
           * ⚠️ ONLY WHEN IT HAS NEVER BEEN PUBLISHED. Such a playlist is playing on no screen
           * anywhere, so publishing it can surprise nobody — and not publishing it hands this
           * display an empty list. A playlist that HAS a snapshot is left alone: it may carry
           * draft edits somebody is midway through, and pushing those estate-wide from a setup
           * wizard is not this step's decision to make.
           */
          if (neverPublished.has(pick)) {
            const published = await publish(pick);
            if (!published.ok) {
              if (status) status.textContent = published.error || t('onboarding.toast.publish_failed');
              return;
            }
          }
          showToast(t('onboarding.toast.playlist_assigned'), 'success');
        } catch (err) {
          if (status) status.textContent = t('onboarding.toast.assign_failed');
          return;
        }
      }

      await finish('done');
      return;
    }

    currentStep++;
    renderStep();
  }

  // 3.0: the sample is fetched from this server and uploaded like any other file, so it lands in the
  // library as ordinary content the user owns, edits and deletes — nothing is special-cased server-side.
  async function useSample() {
    const btn = document.getElementById('onboardUseSample');
    if (btn) btn.disabled = true;
    try {
      const res = await fetch(SAMPLE_URL);
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      api.trackEvent('sample_content_used', {});
      uploadFiles([new File([blob], 'Welcome screen.jpg', { type: blob.type || 'image/jpeg' })]);
    } catch {
      showToast(t('onboarding.toast.sample_failed'), 'error');
      if (btn) btn.disabled = false;
    }
  }

  /*
   * 3.0: "Make a sign" instead of a photo. The sign task (views/make-sign.js) takes it from here with
   * this screen preset, so the first thing on it is a real sign rather than a sample picture.
   *
   * ⚠️ THE GUIDE IS RECORDED AS FINISHED ON THE WAY OUT. The screen is paired, which is what the guide
   * is for; the sign task ends at the dashboard, not back here, and leaving the flag unset would send
   * this person through the whole guide again on their next sign-in.
   */
  async function makeSign() {
    if (!addMode) {
      localStorage.setItem('rd_onboarded', 'true');
      api.trackEvent('onboarding_completed', { step: currentStep, via: 'sign' });
      try { await api.updateMe({ onboarded: true }); } catch { /* the local flag still holds */ }
    }
    const q = `device=${encodeURIComponent(pairedDeviceId || '')}&from=${addMode ? 'add' : 'onboarding'}`;
    window.location.hash = isSimpleMode() ? `#/simple/sign?${q}` : `#/signs?${q}`;
  }

  /*
   * Upload one or MANY files and put them all on the screen, in the order picked. A first-run user
   * with a folder of photos should not have to come back three times. Goes through api.uploadContent
   * — the library's own uploader (batched requests, whole-selection progress, the server's reason on
   * a refusal, and the upgrade prompt on a storage limit) — then adds each item to the screen's
   * playlist and publishes ONCE at the end, so the screen restarts once, not per photo.
   */
  async function uploadFiles(files) {
    files = (files || []).filter(Boolean);
    if (!files.length) return;

    const progress = document.getElementById('onboardUploadProgress');
    const bar = document.getElementById('onboardProgressBar');
    const text = document.getElementById('onboardUploadText');
    const area = document.getElementById('onboardUploadArea');
    if (progress) progress.style.display = 'block';
    if (area) area.style.pointerEvents = 'none';
    const fail = (msg) => {
      if (text) text.textContent = msg;
      if (area) area.style.pointerEvents = '';
    };
    if (text) text.textContent = files.length > 1
      ? t('onboarding.step.upload.uploading_n', { n: files.length })
      : t('onboarding.step.upload.uploading');

    let uploaded;
    try {
      uploaded = await api.uploadContent(files, (pct) => { if (bar) bar.style.width = pct + '%'; });
    } catch (err) {
      // At a storage limit the upgrade prompt (plan-nudges.js) says it; the line under the drop area stays quiet.
      return fail(err.planPromptShown ? '' : (err.message || t('onboarding.toast.upload_failed')));
    }
    if (bar) bar.style.width = '100%';
    return placeItems(Array.isArray(uploaded) ? uploaded : [uploaded]);
  }

  /*
   * Put library items (just uploaded, or just added from free stock photos) on the screen in the
   * order given, and publish ONCE at the end, so the screen restarts once, not per photo.
   */
  async function placeItems(items) {
    const progress = document.getElementById('onboardUploadProgress');
    const text = document.getElementById('onboardUploadText');
    const area = document.getElementById('onboardUploadArea');
    if (progress) progress.style.display = 'block';
    const fail = (msg) => {
      if (text) text.textContent = msg;
      if (area) area.style.pointerEvents = '';
    };
    if (text) text.textContent = t('onboarding.toast.uploaded_assigning');

    if (pairedDeviceId) {
      for (const content of items) {
        if (!content || !content.id) continue;
        try {
          // #237: no duration_sec — the server defaults to the clip's own length (10s for a photo).
          const r = await api.addAssignment(pairedDeviceId, { content_id: content.id });
          // The created item names the playlist this device just got, so the last step can
          // preselect it: "keep what is already playing" must be the default there.
          if (r && r.playlist_id) assignedPlaylistId = r.playlist_id;
        } catch { /* one refused item must not strand the rest */ }
      }
    }

    // The adds above only mark the playlist a draft. Publish it, or the screen stays blank behind a
    // success message.
    const published = await publish(assignedPlaylistId);
    if (!published.ok) return fail(published.error || t('onboarding.toast.publish_failed'));

    showToast(published.review ? t('onboarding.toast.sent_for_review')
      : items.length > 1 ? t('onboarding.toast.content_assigned_n', { n: items.length }) : t('onboarding.toast.content_assigned'), 'success');
    if (assignedPlaylistId && !published.review) api.trackEvent('first_publish', { from: 'onboarding', items: items.length });
    currentStep++;
    renderStep();
  }

  /*
   * "Show the same as another screen": the existing playlists, most recently used first as the API
   * returns them. Assigning goes through POST /playlists/:id/assign (the same write the screen page
   * makes, so the screen follows that playlist), and a playlist that was never published is
   * published, exactly as the last step's picker does — otherwise the screen would get an empty list.
   */
  async function populateSameAs() {
    const block = document.getElementById('onboardSameAsBlock');
    const select = document.getElementById('onboardSameAs');
    if (!block || !select || !pairedDeviceId) return;
    let playlists = [];
    try { playlists = await api.getPlaylists(); } catch { return; }
    playlists = (playlists || []).filter((p) => (p.item_count || 0) > 0);
    if (!playlists.length) return;
    for (const p of playlists) {
      if (!p.published_snapshot) neverPublished.add(p.id);
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} (${p.item_count || 0})`;
      select.appendChild(opt);
    }
    block.style.display = 'block';
    document.getElementById('onboardSameAsBtn').addEventListener('click', async (e) => {
      const status = document.getElementById('onboardSameAsStatus');
      const pick = select.value;
      if (!pick) return;
      e.target.disabled = true;
      try {
        await api.assignPlaylistToDevice(pick, pairedDeviceId);
        if (neverPublished.has(pick)) {
          const published = await publish(pick);
          if (!published.ok) throw new Error(published.error || t('onboarding.toast.publish_failed'));
        }
        assignedPlaylistId = pick;
        showToast(t('onboarding.toast.playlist_assigned'), 'success');
        currentStep++;
        renderStep();
      } catch (err) {
        if (status) status.textContent = err.message || t('onboarding.toast.assign_failed');
        e.target.disabled = false;
      }
    });
  }

  if (!addMode) api.trackEvent('onboarding_started', {});
  renderStep();
}

export function cleanup() { cleanupMigrate(); }
