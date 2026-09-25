import { showToast } from '../components/toast.js';
import { api } from '../api.js';
import { t } from '../i18n.js';

// Steps are computed lazily so translated strings refresh on language change.
function getSteps() {
  return [
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
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
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
          <p style="color:var(--text-secondary)">${t('onboarding.step.upload.click_to_select')}</p>
          <p style="color:var(--text-muted);font-size:12px;margin-top:4px">${t('onboarding.step.upload.formats')}</p>
          <input type="file" id="onboardFileInput" style="display:none" accept="video/*,image/*,audio/*">
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
        <div style="background:var(--bg-input);border-radius:8px;padding:16px;margin-bottom:16px">
          <p style="font-size:14px;color:var(--text-primary);font-weight:600;margin-bottom:8px">${t('onboarding.step.done.whats_next')}</p>
          <ul style="color:var(--text-muted);font-size:13px;padding-left:20px;line-height:2">
            <li>${t('onboarding.step.done.next_content')}</li>
            <li>${t('onboarding.step.done.next_layouts')}</li>
            <li>${t('onboarding.step.done.next_schedule')}</li>
            <li>${t('onboarding.step.done.next_widgets')}</li>
            <li>${t('onboarding.step.done.next_kiosk')}</li>
            <li>${t('onboarding.step.done.next_designer')}</li>
          </ul>
        </div>`,
      action: null
    }
  ];
}

export function render(container) {
  let currentStep = 0;
  let pairedDeviceId = null;
  let assignedPlaylistId = null;   // whatever the upload step put on this device, if anything
  let createdPlayerUrl = null;     // #313: set once a no-storage display has been created here
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
      const token = localStorage.getItem('token');
      const res = await fetch(`/api/playlists/${playlistId}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      if (res.ok) { neverPublished.delete(playlistId); return { ok: true }; }
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: data.error };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  function renderStep() {
    const STEPS = getSteps();
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
              ${!isLast ? `<button class="btn btn-secondary" id="skipBtn" style="color:var(--text-muted)">${t('onboarding.skip')}</button>` : ''}
              <button class="btn btn-primary" id="nextBtn">${isLast ? t('onboarding.go_to_dashboard') : step.action === 'pair' ? t('onboarding.pair_display') : t('onboarding.next')}</button>
            </div>
          </div>
        </div>
      </div>
    `;

    document.getElementById('prevBtn')?.addEventListener('click', () => { currentStep--; renderStep(); });
    document.getElementById('skipBtn')?.addEventListener('click', () => {
      localStorage.setItem('rd_onboarded', 'true');
      window.location.hash = '#/';
      window.location.reload();
    });
    document.getElementById('nextBtn')?.addEventListener('click', handleNext);

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
      input?.addEventListener('change', handleUpload);
    }

    if (isLast) {
      populatePlaylistPicker();
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
    const STEPS = getSteps();
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
          if (status) status.textContent = err.message || t('onboarding.toast.pair_failed');
        }
        return;
      }
      if (noStorage && createdPlayerUrl) { currentStep++; renderStep(); return; }

      if (!code || code.length !== 6) {
        if (status) status.textContent = t('onboarding.toast.invalid_code');
        return;
      }

      try {
        if (status) status.textContent = t('onboarding.toast.pairing');
        const token = localStorage.getItem('token');
        const res = await fetch('/api/provision/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ pairing_code: code, name: name || undefined })
        });
        const data = await res.json();
        if (!res.ok) { if (status) status.textContent = data.error || t('onboarding.toast.pair_failed'); return; }
        pairedDeviceId = data.id;
        showToast(t('onboarding.toast.paired'), 'success');
        currentStep++;
        renderStep();
      } catch (err) {
        if (status) status.textContent = t('onboarding.toast.pair_failed_with_error', { error: err.message });
      }
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

      localStorage.setItem('rd_onboarded', 'true');
      window.location.hash = '#/';
      window.location.reload();
      return;
    }

    currentStep++;
    renderStep();
  }

  async function handleUpload() {
    const file = document.getElementById('onboardFileInput')?.files[0];
    if (!file) return;

    const progress = document.getElementById('onboardUploadProgress');
    const bar = document.getElementById('onboardProgressBar');
    const text = document.getElementById('onboardUploadText');
    if (progress) progress.style.display = 'block';

    try {
      const token = localStorage.getItem('token');
      const formData = new FormData();
      formData.append('file', file);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/content');
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && bar) bar.style.width = Math.round((e.loaded / e.total) * 100) + '%';
      };
      xhr.onload = async () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const content = JSON.parse(xhr.responseText);
          if (text) text.textContent = t('onboarding.toast.uploaded_assigning');

          if (pairedDeviceId) {
            try {
              const assignRes = await fetch(`/api/assignments/device/${pairedDeviceId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                // #237: no duration_sec — onboarding never asked the operator for one, and a
                // hardcoded 10 cut their very first video off mid-play. Omitting it lets the
                // server default to the clip's own length (still 10s for a photo).
                body: JSON.stringify({ content_id: content.id })
              });
              // The created item names the playlist this device just got, so the last step can
              // preselect it: "keep what is already playing" must be the default there.
              if (assignRes.ok) assignedPlaylistId = (await assignRes.json()).playlist_id || null;
            } catch {}
          }

          // The assign above only marks the playlist a draft. Publish it, or the screen stays
          // blank behind a success message.
          const published = await publish(assignedPlaylistId);
          if (!published.ok) {
            if (text) text.textContent = published.error || t('onboarding.toast.publish_failed');
            return;
          }

          showToast(t('onboarding.toast.content_assigned'), 'success');
          currentStep++;
          renderStep();
        } else {
          if (text) text.textContent = t('onboarding.toast.upload_failed');
        }
      };
      xhr.onerror = () => { if (text) text.textContent = t('onboarding.toast.upload_failed'); };
      xhr.send(formData);
    } catch (err) {
      if (text) text.textContent = t('onboarding.toast.error_with_error', { error: err.message });
    }
  }

  renderStep();
}

export function cleanup() {}
