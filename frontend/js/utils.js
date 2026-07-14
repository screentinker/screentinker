import { t } from './i18n.js';

// HTML escape helper — prevents XSS when inserting user data into innerHTML
export function esc(str) {
  if (str == null) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// v4 liveness badge. The patch4 server derives a 3-state liveness — 'healthy' / 'degraded'
// (temporarily reconnecting) / 'offline' — and emits it as `data.liveness` on dashboard:device-status.
// It is present on SOME emits only (the plain reconnect + disconnect emits, and any device object read
// from the DB, carry just the binary `status`), so we DEGRADE to the binary status when liveness is
// absent — nothing ever renders blank. 'provisioning' is a lifecycle state (never-paired), kept
// distinct from liveness. livenessState() is pure (unit-testable); livenessBadge() adds the i18n label.
const LIVENESS_LABEL_KEY = {
  healthy: 'device.liveness.healthy',
  degraded: 'device.liveness.degraded',
  offline: 'device.liveness.offline',
  provisioning: 'dashboard.awaiting_pairing',
};
export function livenessState(data) {
  const lv = data && data.liveness;
  if (lv === 'healthy' || lv === 'degraded' || lv === 'offline') return lv;  // 3-state signal present
  const st = data && data.status;                     // backward-compat: derive from binary status
  if (st === 'provisioning') return 'provisioning';
  if (st === 'online') return 'healthy';
  if (st === 'offline') return 'offline';
  return 'offline';                                   // unknown / no data yet -> safe default, never blank
}
// Exit-signal contract §8/§10 — honest, reliability-aware manner-of-death sub-label for an Offline
// device. clean_exit is RELIABLE only on the browser /player (pagehide+sendBeacon); best-effort on
// APK/.wgt, so we qualify it there rather than overstate certainty. crashed/silent are labeled plainly.
// Returns null when no reason is known (old data / never went offline) -> plain "Offline".
// short=true -> concise LIST label (drops the parenthetical qualifiers, which the tooltip still carries);
// full (default) -> DETAIL label with the reliability qualifier. Honesty is preserved either way: the
// full meaning lives in the tooltip (both views) and in the detail label.
function offlineReasonLabel(reason, clientType, short) {
  if (reason === 'crashed') return t('device.exit.crashed');
  if (reason === 'clean_exit') {
    if (short) return t('device.exit.clean');                         // list: "clean exit" (tooltip carries best-effort)
    return clientType === 'player' ? t('device.exit.clean') : t('device.exit.clean_besteffort');
  }
  if (reason === 'silent') return short ? t('device.exit.silent_short') : t('device.exit.silent');
  return null;
}
// Honest hover explanation of the manner of death — carries the contract's reliability (esp. 'silent'
// = external/violent, and best-effort clean_exit) so an operator isn't misled by a terse badge label.
function offlineReasonTip(reason, clientType) {
  if (reason === 'crashed') return t('device.exit.crashed.tip');
  if (reason === 'clean_exit') return clientType === 'player' ? t('device.exit.clean.tip') : t('device.exit.clean_besteffort.tip');
  if (reason === 'silent') return t('device.exit.silent.tip');
  return '';
}
export function livenessBadge(data, opts = {}) {
  const state = livenessState(data);
  let label = t(LIVENESS_LABEL_KEY[state]);
  let title = '', reason = '';
  if (state === 'offline') {                      // annotate Offline with the manner of death, if known
    const r = data && data.offline_reason, ct = data && data.client_type;
    const sub = offlineReasonLabel(r, ct, opts.short);
    if (sub) { label += ' · ' + sub; title = offlineReasonTip(r, ct); reason = r || ''; }
  }
  return { state, label, title, reason };        // reason -> data-offline-reason (filter drill-in); '' unless offline+known
}

// Phase 2.1: the Phase 1 schema migration renamed the legacy 'superadmin'
// role to 'platform_admin'. Existing frontend checks still match the old
// string; this helper accepts both so we don't have to splatter the array
// at every call site. Use everywhere the UI gates on platform-level access.
export function isPlatformAdmin(user) {
  return !!(user && (user.role === 'superadmin' || user.role === 'platform_admin'));
}

// Lazy-load authenticated images. A plain <img> can't send the Bearer token,
// and thumbnail/file endpoints require auth — a just-uploaded item's thumbnail
// 403's without it. We fetch with the token and swap in an object URL.
// IntersectionObserver keeps it lazy; the object URL is revoked after load.
let _authImgObserver = null;
export function loadAuthImage(img) {
  const url = img.dataset.authSrc;
  if (!url) return;
  delete img.dataset.authSrc;
  fetch(url, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } })
    .then(r => (r.ok ? r.blob() : Promise.reject(r.status)))
    .then(blob => {
      const obj = URL.createObjectURL(blob);
      img.addEventListener('load', () => URL.revokeObjectURL(obj), { once: true });
      img.src = obj;
    })
    .catch(() => { img.style.opacity = '0.25'; });
}
export function hydrateAuthImages(root) {
  const imgs = root.querySelectorAll('img[data-auth-src]');
  if (typeof IntersectionObserver === 'undefined') { imgs.forEach(loadAuthImage); return; }
  if (!_authImgObserver) {
    _authImgObserver = new IntersectionObserver((entries, obs) => {
      for (const e of entries) if (e.isIntersecting) { obs.unobserve(e.target); loadAuthImage(e.target); }
    }, { rootMargin: '300px' });
  }
  imgs.forEach(img => _authImgObserver.observe(img));
}
