/*
 * Curbside pickup: small DOM helpers shared by the customer page, the staff page and the dashboard
 * (server: lib/curbside/service.js, docs/curbside-pickup.md).
 *
 * ⚠️ NO HTML STRINGS. Order numbers, notes, spot labels, location names and the admin's own texts are
 * all user or admin data, so everything here builds nodes and sets textContent. Nothing in this
 * file, or in the pages that use it, assigns innerHTML with a value from the server.
 */
import { t } from '../i18n.js';

/**
 * h('button', { className: 'x', dataset: { act: 'ack' }, attrs: { type: 'button' }, on: { click } }, 'Text', node)
 * Strings among the children become text nodes. `text` sets textContent.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  const p = props || {};
  if (p.className) el.className = p.className;
  if (p.text != null) el.textContent = String(p.text);
  if (p.style) el.setAttribute('style', p.style);
  if (p.dataset) for (const [k, v] of Object.entries(p.dataset)) el.dataset[k] = String(v);
  if (p.attrs) for (const [k, v] of Object.entries(p.attrs)) { if (v !== false && v != null) el.setAttribute(k, v === true ? '' : String(v)); }
  if (p.on) for (const [k, fn] of Object.entries(p.on)) el.addEventListener(k, fn);
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

/** Swap {spot} and {order} in an admin text, as plain text. */
export function fillText(template, vars = {}) {
  let s = String(template == null ? '' : template);
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(v == null ? '' : String(v));
  return s;
}

/** How long a car has waited, and the colour band: under 5 minutes, under 10, longer. */
export function waitBand(ms) {
  const min = Math.max(0, Math.floor((Number(ms) || 0) / 60000));
  return { min, band: min < 5 ? 'fresh' : (min < 10 ? 'warm' : 'late') };
}

export function waitText(min) {
  if (min < 1) return t('curbside.staff.just_now');
  return min === 1 ? t('curbside.staff.min_one') : t('curbside.staff.min', { n: min });
}

/*
 * The list of cars, oldest first, for the staff page and the dashboard. `serverNow` is the server's
 * clock at the answer and `fetchedAt` this browser's, so "minutes waiting" never depends on the
 * phone's clock being right.
 */
export function renderArrivals(box, arrivals, { serverNow, fetchedAt, canAct = true, busy = false, onAck, onDone } = {}) {
  box.textContent = '';
  const list = Array.isArray(arrivals) ? arrivals : [];
  if (!list.length) {
    box.appendChild(h('div', { className: 'cs-empty', text: t('curbside.staff.empty') }));
    return;
  }
  const now = (Number(serverNow) || Date.now()) + (Date.now() - (Number(fetchedAt) || Date.now()));
  for (const a of list) {
    const { min, band } = waitBand(now - Number(a.created_at));
    const seen = a.status === 'seen';
    const actions = canAct ? h('div', { className: 'cs-actions' },
      seen ? null : h('button', { className: 'cs-ack btn btn-primary', attrs: { type: 'button', disabled: busy }, dataset: { act: 'ack', id: a.id }, text: t('curbside.staff.ack'), on: onAck ? { click: () => onAck(a) } : {} }),
      h('button', { className: 'cs-done btn btn-secondary', attrs: { type: 'button', disabled: busy }, dataset: { act: 'done', id: a.id }, text: t('curbside.staff.done'), on: onDone ? { click: () => onDone(a) } : {} }),
    ) : null;
    box.appendChild(h('div', { className: `cs-car ${band}${seen ? ' seen' : ''}`, dataset: { id: a.id } },
      h('div', { className: 'cs-spot' }, h('span', { className: 'cs-spot-l', text: t('curbside.staff.spot') }), h('b', { text: a.spot })),
      h('div', { className: 'cs-main' },
        h('div', { className: 'cs-order' }, h('span', { text: t('curbside.staff.order') + ' ' }), h('b', { text: a.order_ref })),
        a.note ? h('div', { className: 'cs-note', text: a.note }) : null,
        h('div', { className: 'cs-meta' },
          h('span', { className: `cs-age ${band}`, text: waitText(min) }),
          h('span', { className: `cs-status ${seen ? 'seen' : 'waiting'}`, text: seen ? t('curbside.staff.status_seen') : t('curbside.staff.status_waiting') }))),
      actions));
  }
}

/* A short two-tone chime for the staff page (Web Audio, nothing to download), unlocked by a tap. */
let ctx = null;
export function unlockChime() {
  try {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch { ctx = null; }
}
export function playChime(volume = 0.6) {
  try {
    if (!ctx || ctx.state !== 'running') return false;
    const t0 = ctx.currentTime + 0.02;
    [[660, 0, 0.3], [880, 0.32, 0.45]].forEach(([freq, at, len]) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0 + at);
      g.gain.exponentialRampToValueAtTime(Math.max(0.001, 0.5 * volume), t0 + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(t0 + at); osc.stop(t0 + at + len + 0.05);
    });
    return true;
  } catch { return false; }
}
