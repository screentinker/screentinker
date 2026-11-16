'use strict';

/*
 * Per-account display preferences: dashboard language and theme (users.language, users.theme).
 *
 * Both used to live only in the browser (localStorage rd_lang / st_theme), so a choice made on one
 * computer did not follow the person to another, and the next person on a shared computer inherited
 * it. NULL means "not chosen": the browser's own choice (or its default) stands, exactly as before.
 *
 * ⚠️ The two lists must match the dashboard: LANGUAGES = the registry in frontend/js/i18n.js,
 * THEMES = the ids in frontend/js/lib/themes.js. test/account-prefs.test.js pins both.
 */
const LANGUAGES = ['en', 'es', 'fr', 'de', 'pt', 'hi', 'it', 'ja', 'zh', 'nl', 'da'];
const THEMES = ['graphite', 'control-room', 'light', 'classic'];

/**
 * Normalize one submitted value. Returns { set: true, value } to store (value may be null to clear),
 * or { set: false } to leave the column alone (absent or not a value we accept: ignored, not stored,
 * like ui_mode).
 */
function pick(raw, allowed) {
  if (raw === undefined) return { set: false };
  if (raw === null || raw === '') return { set: true, value: null };
  if (typeof raw !== 'string') return { set: false };
  const v = raw.trim().toLowerCase();
  return allowed.includes(v) ? { set: true, value: v } : { set: false };
}

const pickLanguage = (raw) => pick(raw, LANGUAGES);
const pickTheme = (raw) => pick(raw, THEMES);

/** Read back for GET /me: an unknown stored value (a language later removed) reads as not chosen. */
function readPrefs(row) {
  const lang = row && typeof row.language === 'string' ? row.language : null;
  const theme = row && typeof row.theme === 'string' ? row.theme : null;
  return {
    language: LANGUAGES.includes(lang) ? lang : null,
    theme: THEMES.includes(theme) ? theme : null,
  };
}

module.exports = { LANGUAGES, THEMES, pickLanguage, pickTheme, readPrefs };
