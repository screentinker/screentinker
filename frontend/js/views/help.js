export function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div><h1>Help Center</h1><div class="subtitle">Quick guides and FAQ</div></div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;margin-bottom:32px">
      ${[
        { icon: '&#128250;', title: 'Setting Up a Display', steps: ['Download the APK or open the Web Player', 'Enter your server URL', 'Note the 6-digit pairing code', 'Click "Add Display" in the dashboard and enter the code', 'Assign content to the display\'s playlist'] },
        { icon: '&#128228;', title: 'Uploading Content', steps: ['Go to Content Library', 'Drag and drop files or click the upload area', 'Supports MP4, WebM, JPEG, PNG, GIF, WebP', 'Videos auto-detect duration and generate thumbnails', 'Use Remote URL to stream from external sources'] },
        { icon: '&#9881;', title: 'Using Widgets', steps: ['Go to Widgets and click "New Widget"', 'Choose a type: Clock, Weather, RSS, Text, Webpage, or Social', 'Configure the widget settings', 'Assign the widget to a device via the Playlist tab', 'Widgets render as live HTML content'] },
        { icon: '&#128203;', title: 'Multi-Zone Layouts', steps: ['Go to Layouts and create a new layout or use a template', 'Drag zones to position them on the canvas', 'Resize using the corner handle', 'Assign the layout to a device in the Playlist tab', 'Each zone can show different content'] },
        { icon: '&#128197;', title: 'Content Scheduling', steps: ['Go to Schedule and select a device', 'Click "Add Schedule" to create a time slot', 'Set start/end times and recurrence rules', 'Higher priority schedules override lower ones', 'Content auto-switches based on the schedule'] },
        { icon: '&#128421;', title: 'Remote Control', steps: ['Go to a device\'s detail page', 'Click the "Remote Control" tab', 'Click "Start Remote" to begin streaming', 'Use the d-pad, volume, and power buttons', 'Click anywhere on the screen to simulate a tap'] },
        { icon: '&#128433;', title: 'Kiosk/Touchscreen', steps: ['Go to Kiosk and create a new page', 'Add buttons with labels, icons, and actions', 'Configure the idle screen timeout', 'Preview the page in the editor', 'Assign to a device as a widget'] },
        { icon: '&#127916;', title: 'Video Walls', steps: ['Go to Video Walls and create a new wall', 'Set the grid size (e.g., 2x2)', 'Drag devices onto grid positions', 'Set bezel compensation if needed', 'Assign content to play across all displays'] },
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
      <h3>Frequently Asked Questions</h3>
      ${[
        { q: 'What devices are supported?', a: 'Android TV/tablets (APK), Raspberry Pi, Windows, ChromeOS, LG webOS, Samsung Tizen, Fire TV, and any device with a web browser.' },
        { q: 'How does the free trial work?', a: 'New accounts get a 14-day free trial of the Pro plan (15 devices, all features). After 14 days, you\'re moved to the Free plan (1 device) unless you upgrade.' },
        { q: 'Can I use portrait mode displays?', a: 'Yes! Set the orientation to "Portrait" in the device\'s Info tab. The content will be rotated accordingly.' },
        { q: 'What happens when a device goes offline?', a: 'Devices cache content locally, so they continue playing their playlist even without internet. You\'ll receive an email alert after 5 minutes of being offline.' },
        { q: 'Can I self-host ScreenTinker?', a: 'Yes! Deploy the server on your own infrastructure. All data stays on your network. Set SELF_HOSTED=true in the environment.' },
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
      <h3>Keyboard Shortcuts</h3>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 16px;font-size:13px">
        <kbd style="background:var(--bg-input);padding:2px 8px;border-radius:4px;font-family:monospace">Esc</kbd> <span style="color:var(--text-secondary)">Reset web player (on player page)</span>
        <kbd style="background:var(--bg-input);padding:2px 8px;border-radius:4px;font-family:monospace">F</kbd> <span style="color:var(--text-secondary)">Toggle fullscreen (web player)</span>
      </div>
    </div>
  `;
}

export function cleanup() {}
