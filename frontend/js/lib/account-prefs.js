/*
 * Dashboard language and theme that follow the ACCOUNT (users.language / users.theme via
 * /api/auth/me, server/lib/account-prefs.js), not just this browser.
 *
 * The browser keeps its own copy (localStorage rd_lang / st_theme) so the first paint is right
 * before /me answers; the account's value wins when it arrives. An account with nothing chosen
 * (null) leaves the browser's choice alone, which is how every account starts, so nobody's current
 * look changes on upgrade.
 *
 * Applying never saves and saving never applies through here, so the two cannot loop.
 */
import { api } from '../api.js';
import { getLanguage, setLanguage } from '../i18n.js';
import { currentTheme, setTheme } from './themes.js';

/** Apply the account's saved choices, if any. Called with a fresh /me. */
export function applyAccountPrefs(user) {
  if (!user || typeof user !== 'object') return;
  try {
    if (typeof user.theme === 'string' && user.theme && user.theme !== currentTheme()) setTheme(user.theme);
  } catch { /* an unknown theme is ignored by setTheme */ }
  try {
    if (typeof user.language === 'string' && user.language && user.language !== getLanguage()) setLanguage(user.language);
  } catch { /* an unknown language is ignored by setLanguage */ }
}

/**
 * Remember a choice on the account as well as in this browser. Signed out (the login page), it
 * stays a browser choice. A failed save is not an error to show: the browser still has it, and the
 * next choice saves again.
 */
export function saveAccountPref(field, value) {
  if (field !== 'language' && field !== 'theme') return;
  let token = null;
  try { token = localStorage.getItem('token'); } catch { /* storage blocked */ }
  if (!token) return;
  try {
    const cached = JSON.parse(localStorage.getItem('user') || 'null');
    if (cached && typeof cached === 'object') localStorage.setItem('user', JSON.stringify({ ...cached, [field]: value }));
  } catch { /* no cached account */ }
  api.updateMe({ [field]: value }).catch(() => {});
}
