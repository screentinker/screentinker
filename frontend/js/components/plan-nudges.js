/*
 * 3.0: trial-to-paid, done as help rather than a wall. Two surfaces, both HOSTED ONLY — nothing
 * here renders when the account is on a self-hosted instance or billing is hidden (HIDE_BILLING),
 * and nothing renders for a session with no account facts (support / recovery):
 *
 *   1. The trial banner. 2.x showed the trial on the Subscription page and nowhere else, so most
 *      trials ended without the owner ever seeing a day count. Quiet while there is time, plainer in
 *      the last three days, and after the end it says what was KEPT before what is paused. Shown to
 *      the account that owns the organization only (an invited colleague cannot act on it), and
 *      dismissible for the day.
 *
 *   2. The upgrade prompt. A plan limit (DEVICE_LIMIT / STORAGE_LIMIT / FEATURE_LOCKED) used to be
 *      a red toast that read like a bug. The server now names the plan that would have said yes
 *      (`suggested_plan`), and this explains, in the user's terms, what that plan adds, with one
 *      click to that plan on the Subscription page and an equally visible "Not now".
 *
 * Everything shown is built with textContent; values from the server never reach innerHTML.
 */
import { api } from '../api.js';
import { t, tn } from '../i18n.js';
import { isPlatformAdmin, inManagerApp } from '../utils.js';

const BANNER_ID = 'trialBanner';
const DISMISS_KEY = 'st.trialBanner.dismissed';

function cachedUser() {
  try { return JSON.parse(localStorage.getItem('user') || 'null'); } catch { return null; }
}

/** True when conversion UI may appear for this user at all. */
export function plansVisible(user = cachedUser()) {
  if (!user || user.self_hosted || user.hide_billing) return false;
  // Google Play's payments policy: no plan sales or upgrade prompts inside the Manager app. The
  // same account sees them in a browser.
  if (inManagerApp()) return false;
  if (String(user.id || '').includes(':')) return false; // support / recovery identities
  return true;
}

function today() { return new Date().toISOString().slice(0, 10); }
function dismissedToday(state) {
  try { return localStorage.getItem(DISMISS_KEY) === `${today()}:${state}`; } catch { return false; }
}
function dismiss(state) {
  try { localStorage.setItem(DISMISS_KEY, `${today()}:${state}`); } catch { /* fine: shows again */ }
}

function el(tag, attrs = {}, text) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v; else if (k === 'style') n.style.cssText = v; else n.setAttribute(k, v);
  }
  if (text != null) n.textContent = text;
  return n;
}

// ---------------------------------------------------------------------------------------------
// 1. Trial banner
// ---------------------------------------------------------------------------------------------

/**
 * Which banner, if any: 'active' | 'ending' | 'ended' | null. Only the organization owner sees it,
 * and never someone already paying (subscription_status set by Stripe to anything but a default).
 */
export function trialBannerState(user) {
  if (!plansVisible(user)) return null;
  if (user.current_org_role && user.current_org_role !== 'org_owner') return null;
  const tr = user.trial;
  if (!tr) return null;
  if (tr.active) return tr.days_left <= 3 ? 'ending' : 'active';
  if (tr.expired_at && (user.plan_name || '').toLowerCase() === 'free') {
    // Only the first fortnight after the end: after that it is not news, and Subscription says it.
    const age = (Date.now() - Date.parse(tr.expired_at)) / 86400000;
    return age <= 14 ? 'ended' : null;
  }
  return null;
}

export function updateTrialBanner(user = cachedUser()) {
  updateSponsorBanner(user);
  const existing = document.getElementById(BANNER_ID);
  // The first-run guide is the one place the trial is already explained in context.
  const onGuide = /^#\/(onboarding|add-screen)/.test(window.location.hash || '');
  const state = onGuide ? null : trialBannerState(user);
  if (!state || dismissedToday(state)) { if (existing) existing.remove(); return; }
  const tr = user.trial;
  const plan = (tr && tr.plan && tr.plan[0].toUpperCase() + tr.plan.slice(1)) || 'Pro';
  const key = `${state}:${tr.days_left}`;
  if (existing && existing.dataset.key === key) return;
  if (existing) existing.remove();
  const host = document.getElementById('banners');
  if (!host) return;

  const b = el('div', { id: BANNER_ID, class: `trial-banner trial-banner--${state}`, role: 'status' });
  b.dataset.key = key;
  const msg = state === 'ended'
    ? t('trial.banner.ended', { plan })
    : tn(state === 'ending' ? 'trial.banner.ending' : 'trial.banner.active', tr.days_left, { plan });
  b.appendChild(el('span', { class: 'trial-banner-text' }, msg));
  const cta = el('a', { class: 'btn btn-sm trial-banner-cta', href: `#/billing?from=trial_banner_${state}` },
    t(state === 'active' ? 'trial.banner.cta_active' : state === 'ending' ? 'trial.banner.cta_ending' : 'trial.banner.cta_ended'));
  cta.addEventListener('click', () => api.trackEvent('trial_banner_clicked', { state }));
  b.appendChild(cta);
  const close = el('button', { type: 'button', class: 'trial-banner-close', 'aria-label': t('trial.banner.dismiss'), title: t('trial.banner.dismiss') }, '×');
  close.addEventListener('click', () => { dismiss(state); b.remove(); });
  b.appendChild(close);
  host.appendChild(b);
}

// ---------------------------------------------------------------------------------------------
// 1b. Self-hosted: the same banner, asking the OPERATOR to sponsor the project instead.
//
// Respectful by construction: platform admins only (the person who installed it, never their
// team); only once the server says so — at once on an install upgraded from an earlier version, after
// 3 days on a fresh one (routes/auth.js sponsorEligible); only after setup; never on the guides; "Not now" hides it for SPONSOR_SNOOZE_DAYS, "Don't ask again" for good;
// ST_HIDE_SPONSOR=true on the server turns it off for the instance (sponsor_prompt in /me).
// ---------------------------------------------------------------------------------------------

export const SPONSOR_URL = 'https://github.com/sponsors/screentinker?o=esb';
const SPONSOR_ID = 'sponsorBanner';
const SPONSOR_KEY = 'st.sponsorBanner';      // 'never' | snooze-until epoch ms
const SPONSOR_SNOOZE_DAYS = 30;

function sponsorSnoozed() {
  try {
    const v = localStorage.getItem(SPONSOR_KEY);
    return v === 'never' || (v && Number(v) > Date.now());
  } catch { return false; }
}

export function sponsorBannerVisible(user) {
  if (!user || !user.self_hosted || !user.sponsor_prompt) return false;
  if (inManagerApp()) return false; // Play policy: no donation asks in the app (Settings > About in a browser)
  if (!isPlatformAdmin(user) || String(user.id || '').includes(':')) return false;
  if (!user.onboarded_at) return false;
  if (/^#\/(onboarding|add-screen)/.test(window.location.hash || '')) return false;
  return !sponsorSnoozed();
}

export function updateSponsorBanner(user = cachedUser()) {
  const existing = document.getElementById(SPONSOR_ID);
  if (!sponsorBannerVisible(user)) { if (existing) existing.remove(); return; }
  if (existing) return;
  const host = document.getElementById('banners');
  if (!host) return;
  const b = el('div', { id: SPONSOR_ID, class: 'trial-banner trial-banner--sponsor', role: 'status' });
  b.appendChild(el('span', { class: 'trial-banner-text' }, t('sponsor.banner.text')));
  b.appendChild(el('a', { class: 'btn btn-sm trial-banner-cta', href: SPONSOR_URL, target: '_blank', rel: 'noopener' }, t('sponsor.banner.cta')));
  const snooze = (value) => () => {
    try { localStorage.setItem(SPONSOR_KEY, value); } catch { /* shows again next load */ }
    b.remove();
  };
  const later = el('button', { type: 'button', class: 'trial-banner-link' }, t('sponsor.banner.later'));
  later.addEventListener('click', snooze(String(Date.now() + SPONSOR_SNOOZE_DAYS * 86400000)));
  b.appendChild(later);
  const never = el('button', { type: 'button', class: 'trial-banner-link' }, t('sponsor.banner.never'));
  never.addEventListener('click', snooze('never'));
  b.appendChild(never);
  // Opening the sponsors page counts as an answer: no point asking again next week.
  b.querySelector('.trial-banner-cta').addEventListener('click', snooze(String(Date.now() + 180 * 86400000)));
  const close = el('button', { type: 'button', class: 'trial-banner-close', 'aria-label': t('sponsor.banner.later'), title: t('sponsor.banner.later') }, '×');
  close.addEventListener('click', snooze(String(Date.now() + SPONSOR_SNOOZE_DAYS * 86400000)));
  b.appendChild(close);
  host.appendChild(b);
}

// ---------------------------------------------------------------------------------------------
// 2. Upgrade prompt
// ---------------------------------------------------------------------------------------------

function fmtStorage(mb) {
  if (mb == null || mb < 0) return t('plans.unlimited');
  return mb >= 1024 ? `${Math.round(mb / 102.4) / 10} GB` : `${mb} MB`;
}
function fmtScreens(n) {
  return n == null || n < 0 ? t('plans.unlimited_screens') : t('plans.n_screens', { n });
}

/** Title, body and value bullets for one refusal, from the server's own numbers. */
export function promptCopy(code, body = {}, user = cachedUser()) {
  const sp = body.suggested_plan || null;
  const planName = body.plan ? body.plan[0].toUpperCase() + body.plan.slice(1) : '';
  const price = sp && sp.price_monthly ? `$${sp.price_monthly}` : '';
  const trialEnded = !!(user && user.trial && user.trial.expired_at && !user.trial.active);
  if (code === 'DEVICE_LIMIT') {
    return {
      title: t('upgrade.device.title', { n: body.limit, plan: planName }),
      lead: trialEnded ? t('upgrade.device.lead_trial_ended') : t('upgrade.device.lead'),
      offer: sp ? t('upgrade.offer', { plan: sp.display_name, what: fmtScreens(sp.max_devices), price }) : '',
      bullets: [t('upgrade.device.b1'), t('upgrade.device.b2'), t('upgrade.device.b3')],
      secondary: null,
    };
  }
  if (code === 'TRIAL_SCREEN_USED') {
    // One free trial per screen (server lib/trial-screens.js): this screen already had one.
    return {
      title: t('upgrade.trial_screen.title'),
      lead: t('upgrade.trial_screen.lead'),
      offer: sp ? t('upgrade.offer', { plan: sp.display_name, what: fmtScreens(sp.max_devices), price }) : '',
      bullets: [t('upgrade.device.b1'), t('upgrade.device.b2'), t('upgrade.trial_screen.b3')],
      secondary: null,
    };
  }
  if (code === 'STORAGE_LIMIT') {
    return {
      title: t('upgrade.storage.title', { size: fmtStorage(body.limit_mb), plan: planName }),
      lead: t('upgrade.storage.lead'),
      offer: sp ? t('upgrade.offer', { plan: sp.display_name, what: fmtStorage(sp.max_storage_mb), price }) : '',
      bullets: [t('upgrade.storage.b1'), t('upgrade.storage.b2')],
      secondary: { label: t('upgrade.storage.manage'), href: '#/content' },
    };
  }
  // FEATURE_LOCKED (today: remote URL content)
  return {
    title: t('upgrade.feature.remote_url.title', { plan: sp ? sp.display_name : 'Pro' }),
    lead: t('upgrade.feature.remote_url.lead'),
    offer: sp ? t('upgrade.offer_feature', { plan: sp.display_name, price }) : '',
    bullets: [t('upgrade.feature.remote_url.b1'), t('upgrade.feature.remote_url.b2'), t('upgrade.feature.remote_url.b3')],
    secondary: null,
  };
}

let openPrompt = null;

export function showUpgradePrompt(code, body = {}) {
  if (openPrompt) openPrompt.remove();
  const copy = promptCopy(code, body);
  const sp = body.suggested_plan || null;
  const from = code.toLowerCase();

  const overlay = el('div', { class: 'modal-overlay upgrade-prompt', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'upgradePromptTitle' });
  const modal = el('div', { class: 'modal', style: 'max-width:480px' });
  const head = el('div', { class: 'modal-header' });
  head.appendChild(el('h3', { id: 'upgradePromptTitle' }, copy.title));
  modal.appendChild(head);

  const bodyEl = el('div', { class: 'modal-body' });
  bodyEl.appendChild(el('p', { class: 'upgrade-prompt-lead' }, copy.lead));
  const ul = el('ul', { class: 'upgrade-prompt-list' });
  copy.bullets.forEach((b) => ul.appendChild(el('li', {}, b)));
  bodyEl.appendChild(ul);
  if (copy.offer) bodyEl.appendChild(el('p', { class: 'upgrade-prompt-offer' }, copy.offer));
  bodyEl.appendChild(el('p', { class: 'upgrade-prompt-reassure' }, t('upgrade.reassure')));
  modal.appendChild(bodyEl);

  const foot = el('div', { class: 'modal-footer' });
  const later = el('button', { type: 'button', class: 'btn btn-secondary' }, t('upgrade.not_now'));
  foot.appendChild(later);
  if (copy.secondary) {
    const sec = el('a', { class: 'btn btn-secondary', href: copy.secondary.href }, copy.secondary.label);
    sec.addEventListener('click', () => close());
    foot.appendChild(sec);
  }
  const go = el('a', {
    class: 'btn btn-primary',
    href: `#/billing?from=${encodeURIComponent(from)}${sp ? `&plan=${encodeURIComponent(sp.id)}` : ''}`,
  }, sp ? t('upgrade.cta_plan', { plan: sp.display_name }) : t('upgrade.cta_plans'));
  go.addEventListener('click', () => { api.trackEvent('upgrade_prompt_clicked', { code, plan: sp ? sp.id : '' }); close(); });
  foot.appendChild(go);
  modal.appendChild(foot);
  overlay.appendChild(modal);

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (openPrompt === overlay) openPrompt = null;
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  // Any navigation (the CTA's own, or the user going elsewhere) closes it: a prompt left over the
  // page it sent you to reads as a second refusal.
  window.addEventListener('hashchange', close, { once: true });
  later.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);

  overlay.style.display = 'flex';
  document.body.appendChild(overlay);
  openPrompt = overlay;
  go.focus();
  api.trackEvent('upgrade_prompt_shown', { code });
}

// ---------------------------------------------------------------------------------------------
// 3. After the first screen: one line, once, about what the trial unlocks next.
// ---------------------------------------------------------------------------------------------

const FIRST_SCREEN_KEY = 'st.firstScreenNudge';

function firstScreenNudge() {
  const user = cachedUser();
  if (!plansVisible(user) || !user.trial || !user.trial.active) return;
  try { if (localStorage.getItem(FIRST_SCREEN_KEY)) return; localStorage.setItem(FIRST_SCREEN_KEY, '1'); } catch { return; }
  const host = document.getElementById('banners');
  if (!host) return;
  const b = el('div', { class: 'trial-banner trial-banner--celebrate', role: 'status' });
  b.appendChild(el('span', { class: 'trial-banner-text' }, tn('trial.first_screen', user.trial.days_left)));
  const cta = el('a', { class: 'btn btn-sm trial-banner-cta', href: '#/billing?from=first_screen' }, t('trial.first_screen_cta'));
  cta.addEventListener('click', () => api.trackEvent('trial_banner_clicked', { state: 'first_screen' }));
  b.appendChild(cta);
  const close = el('button', { type: 'button', class: 'trial-banner-close', 'aria-label': t('trial.banner.dismiss') }, '×');
  close.addEventListener('click', () => b.remove());
  b.appendChild(close);
  host.prepend(b);
}

let installed = false;
export function installPlanNudges() {
  if (installed) return;
  installed = true;
  window.addEventListener('st:plan-limit', (e) => {
    if (!plansVisible()) return; // self-hosted / billing hidden: the caller's own message stands
    const { code, body } = e.detail || {};
    e.preventDefault();
    showUpgradePrompt(code, body || {});
  });
  window.addEventListener('st:screen-paired', firstScreenNudge);
  window.addEventListener('user-refreshed', (e) => updateTrialBanner(e.detail));
  window.addEventListener('hashchange', () => updateTrialBanner());
}
