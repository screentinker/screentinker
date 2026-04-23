// Applies the current user's saved white-label config to the DOM.
// Runs once after login/route bootstrap. Without this, saved values in the
// white_labels table are read into the Settings form but never applied to
// the actual page — so users see "ScreenTinker" and default colors after
// every reload, as if their save reverted.

let applied = false;

export async function applyBranding() {
  if (applied) return;
  applied = true;

  const token = localStorage.getItem('token');
  if (!token) return;

  let wl;
  try {
    const res = await fetch('/api/white-label', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    wl = await res.json();
  } catch { return; }
  if (!wl) return;

  const root = document.documentElement;
  if (wl.primary_color) root.style.setProperty('--accent', wl.primary_color);
  if (wl.bg_color) {
    root.style.setProperty('--bg-primary', wl.bg_color);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', wl.bg_color);
  }

  if (wl.brand_name) {
    document.title = wl.brand_name;
    const span = document.querySelector('.sidebar-header .logo span');
    if (span) span.textContent = wl.brand_name;
  }

  if (wl.favicon_url) {
    document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]').forEach(l => {
      l.setAttribute('href', wl.favicon_url);
    });
  }

  if (wl.custom_css) {
    let style = document.getElementById('wl-custom-css');
    if (!style) {
      style = document.createElement('style');
      style.id = 'wl-custom-css';
      document.head.appendChild(style);
    }
    style.textContent = wl.custom_css;
  }
}

// Force a re-apply (called from settings.js after save)
export function resetBranding() {
  applied = false;
  return applyBranding();
}
