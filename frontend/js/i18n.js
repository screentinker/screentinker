// Lightweight i18n loader. Each language is its own file under ./i18n/ so a
// translator can edit one file without touching the others. English is the
// canonical source — every other locale falls back to en for any missing key.
import en from './i18n/en.js';
import es from './i18n/es.js';
import fr from './i18n/fr.js';
import de from './i18n/de.js';
import pt from './i18n/pt.js';
import hi from './i18n/hi.js';
import it from './i18n/it.js';
import ja from './i18n/ja.js';
import zh from './i18n/zh.js';
import nl from './i18n/nl.js';

const fallback = en;
const registry = { en, es, fr, de, pt, hi, it, ja, zh, nl };

let currentLang = localStorage.getItem('rd_lang') || navigator.language?.split('-')[0] || 'en';
if (!registry[currentLang]) currentLang = 'en';

function lookup(key) {
  return registry[currentLang]?.[key] ?? fallback[key] ?? key;
}

// Replace {name} placeholders in a string with the matching property of vars.
// Unknown placeholders pass through unchanged so a missing var is visible
// during development rather than silently dropped.
/*
 * The white-label brand name, available to EVERY string without threading it through call sites.
 *
 * #292: a reseller's customers were shown "ScreenTinker" in a dozen places the white-label settings
 * never touched — setup instructions, the empty-dashboard hint, onboarding, error text. Those are
 * translated strings, so the fix belongs in the translation layer: they say {brandName} and this
 * fills it in. Threading a variable through several hundred t() calls would have been the same fix
 * with several hundred chances to miss one.
 *
 * Read at CALL time, not captured: branding.js refreshes from the server after first paint, and a
 * value captured when this module loaded would keep showing the previous workspace's brand after a
 * switch. The default is the product's own name, so an un-branded install reads exactly as before.
 */
function brandName() {
  try {
    const n = typeof window !== 'undefined' && window.__ST_BRAND_NAME;
    return (typeof n === 'string' && n.trim()) ? n.trim() : 'ScreenTinker';
  } catch (e) { return 'ScreenTinker'; }
}

function format(s, vars) {
  // Note there is no `if (!vars) return s` short-circuit any more: {brandName} has to resolve in
  // strings that take no other variables, which is most of them.
  const all = { brandName: brandName(), ...(vars || {}) };
  return String(s).replace(/\{(\w+)\}/g, (m, k) => (k in all ? String(all[k]) : m));
}

export function t(key, vars) {
  return format(lookup(key), vars);
}

// Plural helper: looks up `${keyBase}_one` for n===1 else `${keyBase}_other`,
// auto-injects `{n}` into vars. Use for any string that varies on a count.
export function tn(keyBase, n, vars = {}) {
  const key = keyBase + (n === 1 ? '_one' : '_other');
  return format(lookup(key), { n, ...vars });
}

const subscribers = new Set();

// Views and the navbar subscribe so they can rebuild themselves on language
// change. Also fires a `language-changed` CustomEvent and a hashchange so the
// existing hash router naturally re-renders the current view.
export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function setLanguage(lang) {
  if (!registry[lang] || lang === currentLang) return;
  currentLang = lang;
  localStorage.setItem('rd_lang', lang);
  document.documentElement.setAttribute('lang', lang);
  subscribers.forEach((fn) => { try { fn(lang); } catch {} });
  window.dispatchEvent(new CustomEvent('language-changed', { detail: { lang } }));
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function getLanguage() {
  return currentLang;
}

export function getAvailableLanguages() {
  return [
    { code: 'en', name: 'English' },
    { code: 'ja', name: '日本語' },
    { code: 'zh', name: '简体中文' },
    { code: 'es', name: 'Español' },
    { code: 'fr', name: 'Français' },
    { code: 'it', name: 'Italiano' },
    { code: 'de', name: 'Deutsch' },
    { code: 'pt', name: 'Português' },
    { code: 'hi', name: 'हिन्दी' },
    { code: 'nl', name: 'Nederlands' },
  ];
}

// Apply the persisted language to <html lang=...> on first load so screen
// readers and CSS :lang() selectors are accurate before any user interaction.
if (typeof document !== 'undefined') {
  document.documentElement.setAttribute('lang', currentLang);
}
