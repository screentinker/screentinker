import { showToast } from '../components/toast.js';

const STEPS = [
  {
    title: 'Welcome to ScreenTinker!',
    icon: '&#128075;',
    content: `<p style="font-size:16px;color:var(--text-secondary);margin-bottom:16px">Let's get you set up in under 5 minutes.</p>
      <p style="color:var(--text-muted);font-size:14px">This wizard will guide you through:</p>
      <ul style="color:var(--text-muted);font-size:14px;padding-left:20px;margin-top:8px;line-height:2">
        <li>Downloading the player app</li>
        <li>Pairing your first display</li>
        <li>Uploading and assigning content</li>
      </ul>`,
    action: null
  },
  {
    title: 'Step 1: Get the Player App',
    icon: '&#128229;',
    content: `<p style="color:var(--text-secondary);margin-bottom:16px">Install the player on your display device.</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <a href="/download/apk" style="background:var(--bg-input);border:1px solid var(--border);border-radius:8px;padding:16px;text-align:center;text-decoration:none;color:var(--text-primary)">
          <div style="font-size:32px;margin-bottom:8px">&#129302;</div>
          <div style="font-weight:600;font-size:14px">Android APK</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px">TV boxes, tablets, Fire TV</div>
        </a>
        <a href="/player" target="_blank" style="background:var(--bg-input);border:1px solid var(--border);border-radius:8px;padding:16px;text-align:center;text-decoration:none;color:var(--text-primary)">
          <div style="font-size:32px;margin-bottom:8px">&#127760;</div>
          <div style="font-weight:600;font-size:14px">Web Player</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Any browser, Pi, ChromeOS</div>
        </a>
      </div>
      <p style="color:var(--text-muted);font-size:12px;margin-top:12px">Open the app on your display and enter this server URL:</p>
      <code style="display:block;background:var(--bg-input);padding:10px;border-radius:6px;margin-top:6px;font-size:14px;user-select:all">${window.location.origin}</code>`,
    action: null
  },
  {
    title: 'Step 2: Pair Your Display',
    icon: '&#128279;',
    content: `<p style="color:var(--text-secondary);margin-bottom:16px">Enter the 6-digit code shown on your display.</p>
      <div style="text-align:center;margin:20px 0">
        <input type="text" id="onboardPairingCode" maxlength="6" pattern="[0-9]{6}" placeholder="000000"
          style="width:240px;padding:16px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;
          color:var(--text-primary);font-size:32px;font-weight:700;text-align:center;letter-spacing:8px;font-family:monospace">
      </div>
      <div style="text-align:center">
        <input type="text" id="onboardDeviceName" placeholder="Display name (e.g., Lobby TV)"
          style="width:240px;padding:10px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-size:14px;text-align:center">
      </div>
      <p id="onboardPairStatus" style="color:var(--text-muted);font-size:13px;text-align:center;margin-top:12px"></p>`,
    action: 'pair'
  },
  {
    title: 'Step 3: Upload Content',
    icon: '&#128228;',
    content: `<p style="color:var(--text-secondary);margin-bottom:16px">Upload a video or image to display.</p>
      <div style="border:2px dashed var(--border);border-radius:12px;padding:32px;text-align:center;cursor:pointer" id="onboardUploadArea">
        <div style="font-size:32px;margin-bottom:8px">&#128193;</div>
        <p style="color:var(--text-secondary)">Click to select a file</p>
        <p style="color:var(--text-muted);font-size:12px;margin-top:4px">MP4, WebM, JPEG, PNG, GIF</p>
        <input type="file" id="onboardFileInput" style="display:none" accept="video/*,image/*">
      </div>
      <div id="onboardUploadProgress" style="display:none;margin-top:12px">
        <div style="height:4px;background:var(--bg-primary);border-radius:2px;overflow:hidden">
          <div id="onboardProgressBar" style="height:100%;background:var(--accent);width:0%;transition:width 0.3s"></div>
        </div>
        <p id="onboardUploadText" style="font-size:12px;color:var(--text-muted);margin-top:6px">Uploading...</p>
      </div>`,
    action: 'upload'
  },
  {
    title: "You're All Set!",
    icon: '&#127881;',
    content: `<p style="font-size:16px;color:var(--text-secondary);margin-bottom:20px">Your display is paired and content is playing!</p>
      <div style="background:var(--bg-input);border-radius:8px;padding:16px;margin-bottom:16px">
        <p style="font-size:14px;color:var(--text-primary);font-weight:600;margin-bottom:8px">What's next?</p>
        <ul style="color:var(--text-muted);font-size:13px;padding-left:20px;line-height:2">
          <li>Add more content in the <strong>Content Library</strong></li>
          <li>Create multi-zone layouts in <strong>Layouts</strong></li>
          <li>Set up a schedule in the <strong>Schedule</strong> calendar</li>
          <li>Add live widgets (clock, weather, ticker) in <strong>Widgets</strong></li>
          <li>Create interactive screens in <strong>Kiosk</strong></li>
          <li>Design custom content in the <strong>Designer</strong></li>
        </ul>
      </div>`,
    action: null
  }
];

export function render(container) {
  let currentStep = 0;
  let pairedDeviceId = null;

  function renderStep() {
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
            ${isFirst ? '<div></div>' : `<button class="btn btn-secondary" id="prevBtn">Back</button>`}
            <div style="display:flex;gap:8px">
              ${!isLast ? `<button class="btn btn-secondary" id="skipBtn" style="color:var(--text-muted)">Skip Wizard</button>` : ''}
              <button class="btn btn-primary" id="nextBtn">${isLast ? 'Go to Dashboard' : step.action ? (step.action === 'pair' ? 'Pair Display' : 'Next') : 'Next'}</button>
            </div>
          </div>
        </div>
      </div>
    `;

    // Bind buttons
    document.getElementById('prevBtn')?.addEventListener('click', () => { currentStep--; renderStep(); });
    document.getElementById('skipBtn')?.addEventListener('click', () => {
      localStorage.setItem('rd_onboarded', 'true');
      window.location.hash = '#/';
      window.location.reload();
    });
    document.getElementById('nextBtn')?.addEventListener('click', handleNext);

    // Step-specific setup
    if (step.action === 'upload') {
      const area = document.getElementById('onboardUploadArea');
      const input = document.getElementById('onboardFileInput');
      area?.addEventListener('click', () => input.click());
      input?.addEventListener('change', handleUpload);
    }
  }

  async function handleNext() {
    const step = STEPS[currentStep];

    if (step.action === 'pair') {
      const code = document.getElementById('onboardPairingCode')?.value.trim();
      const name = document.getElementById('onboardDeviceName')?.value.trim();
      const status = document.getElementById('onboardPairStatus');

      if (!code || code.length !== 6) {
        if (status) status.textContent = 'Enter a valid 6-digit code';
        return;
      }

      try {
        if (status) status.textContent = 'Pairing...';
        const token = localStorage.getItem('token');
        const res = await fetch('/api/provision/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ pairing_code: code, name: name || undefined })
        });
        const data = await res.json();
        if (!res.ok) { if (status) status.textContent = data.error || 'Pairing failed'; return; }
        pairedDeviceId = data.id;
        showToast('Display paired!', 'success');
        currentStep++;
        renderStep();
      } catch (err) {
        if (status) status.textContent = 'Pairing failed: ' + err.message;
      }
      return;
    }

    if (currentStep === STEPS.length - 1) {
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
          if (text) text.textContent = 'Uploaded! Assigning to display...';

          // Auto-assign to paired device
          if (pairedDeviceId) {
            try {
              await fetch(`/api/assignments/device/${pairedDeviceId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ content_id: content.id, duration_sec: 10 })
              });
            } catch {}
          }

          showToast('Content uploaded and assigned!', 'success');
          currentStep++;
          renderStep();
        } else {
          if (text) text.textContent = 'Upload failed';
        }
      };
      xhr.onerror = () => { if (text) text.textContent = 'Upload failed'; };
      xhr.send(formData);
    } catch (err) {
      if (text) text.textContent = 'Error: ' + err.message;
    }
  }

  renderStep();
}

export function cleanup() {}
