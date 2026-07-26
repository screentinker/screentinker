import { t } from '../i18n.js';

// Help guides + FAQ are documentation. Page chrome is translated; the body
// content is intentionally left in English because partial machine
// translation of multi-paragraph docs reads worse than a single source of
// truth. A native-language docs site is the right long-term answer.
export function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div><h1>${t('help.title')}</h1><div class="subtitle">${t('help.subtitle')}</div></div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;margin-bottom:32px">
      ${[
        { icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:text-bottom;margin-right:4px;color:var(--text-secondary)"><rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect><polyline points="17 2 12 7 7 2"></polyline></svg>', title: 'Setting Up a Display', steps: ['Download the APK <a href="https://github.com/ivandroalves/screentinker/releases" target="_blank" style="color:var(--accent);text-decoration:underline">from GitHub</a> or open the Web Player', 'Enter your server URL', 'Note the 6-digit pairing code', 'Click "Add Display" in the dashboard and enter the code', 'Assign content to the display\'s playlist'] },
        { icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:text-bottom;margin-right:4px;color:var(--text-secondary)"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>', title: 'Uploading Content', steps: ['Go to Content Library', 'Drag and drop files or click the upload area', 'Supports MP4, WebM, JPEG, PNG, GIF, WebP', 'Videos auto-detect duration and generate thumbnails', 'Use Remote URL to stream from external sources'] },
        { icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:text-bottom;margin-right:4px;color:var(--text-secondary)"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>', title: 'Using Widgets', steps: ['Go to Widgets and click "New Widget"', 'Choose a type: Clock, Weather, RSS, Text, Webpage, or Social', 'Configure the widget settings', 'Assign the widget to a device via the Playlist tab', 'Widgets render as live HTML content'] },
        { icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:text-bottom;margin-right:4px;color:var(--accent)"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"></path></svg>', title: 'AI Content Design', steps: ['Open Designer and click the gear on the "AI generate" panel', 'Add an OpenAI-compatible text endpoint + model (OpenAI cloud, or a local Ollama)', 'Optional: pick an image provider for AI backgrounds (OpenAI, or local Stable Diffusion / ComfyUI)', 'Type a prompt, click "Generate design", then tweak and Publish', 'Run it fully local + free — see docs/local-ai-setup.md'] },
        { icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:text-bottom;margin-right:4px;color:var(--text-secondary)"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>', title: 'Multi-Zone Layouts', steps: ['Go to Layouts and create a new layout or use a template', 'Drag zones to position them on the canvas', 'Resize using the corner handle', 'Assign the layout to a device in the Playlist tab', 'Each zone can show different content'] },
        { icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:text-bottom;margin-right:4px;color:var(--text-secondary)"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>', title: 'Content Scheduling', steps: ['Go to Schedule and select a device', 'Click "Add Schedule" to create a time slot', 'Set start/end times and recurrence rules', 'Higher priority schedules override lower ones', 'Content auto-switches based on the schedule'] },
        { icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:text-bottom;margin-right:4px;color:var(--text-secondary)"><rect x="2" y="6" width="20" height="12" rx="2" ry="2"></rect><path d="M12 12h.01"></path><path d="M17 12h.01"></path><path d="M7 12h.01"></path></svg>', title: 'Remote Control', steps: ['Go to a device\'s detail page', 'Click the "Remote Control" tab', 'Click "Start Remote" to begin streaming', 'Use the d-pad, volume, and power buttons', 'Click anywhere on the screen to simulate a tap'] },
        { icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:text-bottom;margin-right:4px;color:var(--text-secondary)"><path d="M12 2a10 10 0 1 0 10 10H12V2z"></path><path d="M12 12 2.1 12"></path><path d="M12 12 21.9 12"></path></svg>', title: 'Kiosk/Touchscreen', steps: ['Go to Kiosk and create a new page', 'Add buttons with labels, icons, and actions', 'Configure the idle screen timeout', 'Preview the page in the editor', 'Assign to a device as a widget'] },
        { icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:text-bottom;margin-right:4px;color:var(--text-secondary)"><rect x="2" y="4" width="20" height="16" rx="2" ry="2"></rect><path d="M10 4v4"></path><path d="M2 8h20"></path><path d="M6 4v4"></path><path d="M14 4v4"></path><path d="M18 4v4"></path></svg>', title: 'Video Walls', steps: ['Go to Video Walls and create a new wall', 'Set the grid size (e.g., 2x2)', 'Drag devices onto grid positions', 'Set bezel compensation if needed', 'Assign content to play across all displays'] },
      ].map(guide => `
        <div class="settings-section" style="margin:0">
          <h3 style="font-size:15px">${guide.icon} ${guide.title}</h3>
          <ol style="padding-left:20px;list-style:decimal;margin-top:8px">
            ${guide.steps.map(s => `<li style="color:var(--text-secondary);font-size:13px;line-height:1.8">${s}</li>`).join('')}
          </ol>
        </div>
      `).join('')}
    </div>

    <div class="settings-section">
      <h3>${t('help.faq')}</h3>
      ${[
        { q: 'What devices are supported?', a: 'Android TV/tablets (APK), Raspberry Pi, Windows, ChromeOS, LG webOS, Samsung Tizen, Fire TV, and any device with a web browser.' },
        { q: 'How does the free trial work?', a: 'New accounts get a 14-day free trial of the Pro plan (15 devices, all features). After 14 days, you\'re moved to the Free plan (1 device) unless you upgrade.' },
        { q: 'Can I use portrait mode displays?', a: 'Yes! Set the orientation to "Portrait" in the device\'s Info tab. The content will be rotated accordingly.' },
        { q: 'What happens when a device goes offline?', a: 'Devices cache content locally, so they continue playing their playlist even without internet. You\'ll receive an email alert after 5 minutes of being offline.' },
        { q: 'Can I self-host SwiftDisplay?', a: 'Yes! Deploy the server on your own infrastructure. All data stays on your network. Set SELF_HOSTED=true in the environment.' },
        { q: 'How do I update the Android app?', a: 'The app checks for updates automatically every 30 minutes. You can also force an update from the device\'s Info tab in the dashboard.' },
        { q: 'What video formats are supported?', a: 'MP4 (H.264), WebM, AVI, MKV, MOV. For best compatibility, use MP4 with H.264 encoding.' },
        { q: 'Can I white-label the dashboard?', a: 'Yes! Go to Settings > White Label to customize the brand name, colors, logo, and domain.' },
        { q: 'How do I export proof-of-play reports?', a: 'Go to Reports, set your date range and filters, then click "Export CSV".' },
        { q: 'What is a video wall?', a: 'A video wall combines multiple displays into one large screen. For example, four TVs in a 2x2 grid showing one big image/video.' },
      ].map(faq => `
        <div style="border-bottom:1px solid var(--border);padding:12px 0">
          <div style="font-weight:600;font-size:14px;margin-bottom:4px">${faq.q}</div>
          <div style="color:var(--text-secondary);font-size:13px">${faq.a}</div>
        </div>
      `).join('')}
    </div>

    <div class="settings-section">
      <h3>${t('help.shortcuts')}</h3>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 16px;font-size:13px">
        <kbd style="background:var(--bg-input);padding:2px 8px;border-radius:4px;font-family:monospace">Esc</kbd> <span style="color:var(--text-secondary)">${t('help.shortcut_esc')}</span>
        <kbd style="background:var(--bg-input);padding:2px 8px;border-radius:4px;font-family:monospace">F</kbd> <span style="color:var(--text-secondary)">${t('help.shortcut_f')}</span>
      </div>
    </div>
  `;
}

export function cleanup() {}
