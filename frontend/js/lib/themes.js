/*
 * The dashboard's themes (css/variables.css has the tokens, css/theme.css the Control room design).
 * A theme is a value of `data-theme` on <html>; the default has none. The choice is remembered in
 * this browser (localStorage `st_theme`) and applied before first paint by js/theme-prime.js.
 *
 * `swatch` is what the picker draws: the sidebar, the page, a card and the accent, as fixed
 * colours, so each option shows ITS OWN look whichever theme is active.
 */
export const THEMES = [
  { id: 'graphite', attr: null, bar: '#15171a',
    swatch: { side: '#1b1e22', page: '#15171a', card: '#07080a', accent: '#3b82f6', ink: '#a6adb7' } },
  { id: 'control-room', attr: 'control-room', bar: '#0a0b0c',
    swatch: { side: '#141618', page: '#0a0b0c', card: '#000000', accent: '#ffb21f', ink: '#ff2a1f' } },
  { id: 'light', attr: 'light', bar: '#f3f4f6',
    swatch: { side: '#ffffff', page: '#f3f4f6', card: '#111317', accent: '#1f6feb', ink: '#7b8490' } },
  { id: 'classic', attr: 'classic', bar: '#111827',
    swatch: { side: '#1f2937', page: '#111827', card: '#1e293b', accent: '#8b5cf6', ink: '#94a3b8' } },
];

const KEY = 'st_theme';

export function currentTheme() {
  let v = null;
  try { v = localStorage.getItem(KEY); } catch { /* blocked */ }
  return THEMES.some((t) => t.id === v) ? v : 'graphite';
}

/** Apply and remember a theme. Unknown ids are ignored. */
export function setTheme(id) {
  const theme = THEMES.find((t) => t.id === id);
  if (!theme) return currentTheme();
  if (theme.attr) document.documentElement.setAttribute('data-theme', theme.attr);
  else document.documentElement.removeAttribute('data-theme');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme.bar);
  try { if (theme.attr) localStorage.setItem(KEY, theme.id); else localStorage.removeItem(KEY); } catch { /* blocked: this page only */ }
  return theme.id;
}
