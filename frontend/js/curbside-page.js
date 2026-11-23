/*
 * Curbside pickup: the customer page a parking spot's QR code opens (server:
 * routes/curbside-public.js, lib/curbside/service.js, docs/curbside-pickup.md).
 *
 *   /curbside/<public token>?spot=<label>
 *
 * The customer types an order number (and an optional note) and taps "I'm here". The page then shows
 * the check-in's status and polls: waiting, then "we got you" once staff acknowledge, then done. It
 * can be cancelled. Every customer-facing word comes from the location (the admin can change them in
 * the dashboard), and every value from the server is put on the page with textContent.
 *
 * A random client id, kept in localStorage per location, goes in the X-Curbside-Client header (never
 * the URL): opening the page again on the same phone shows the same check-in, and only this phone
 * can cancel it.
 */
import { t } from './i18n.js';
import { h, fillText } from './lib/curbside-dom.js';

const API = '/api/public/curbside/c/';
const POLL_MS = 4000;
const token = decodeURIComponent((location.pathname.split('/')[2] || '').trim());
const askedSpot = new URLSearchParams(location.search).get('spot') || '';
const $ = (id) => document.getElementById(id);

const clientKey = `st-curbside-client:${token.slice(0, 16)}`;
function randomId() {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
let clientId = null;
try { clientId = localStorage.getItem(clientKey); } catch { /* private mode */ }
if (!clientId || !/^[A-Za-z0-9_-]{16,64}$/.test(clientId)) {
  clientId = randomId();
  try { localStorage.setItem(clientKey, clientId); } catch { /* this visit only */ }
}

let state = null;
let rev = null;
let busy = false;
let spot = askedSpot;     // the label the page checks in for
let fresh = false;        // "Check in again" pressed: show the form even though a closed check-in exists
let takenShown = false;

async function call(method, path, body) {
  const res = await fetch(API + encodeURIComponent(token) + path, {
    method, credentials: 'omit', cache: 'no-store',
    headers: { 'X-Curbside-Client': clientId, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  if (!res.ok) { const e = new Error((json && json.error) || t('curbside.pub.err')); e.status = res.status; e.code = json && json.code; throw e; }
  return json || {};
}

const tx = (k) => (state && state.texts && state.texts[k]) || '';
const vars = () => ({ spot: (state && state.arrival && state.arrival.spot) || (state && state.spot) || spot || '', order: (state && state.arrival && state.arrival.order_ref) || '' });

function showMsg(text) {
  $('msg').hidden = !text;
  $('msg').textContent = text || '';
}

function fillPicker() {
  const sel = $('pick');
  const want = state.spot || '';
  const key = JSON.stringify(state.spots);
  if (sel.dataset.key !== key) {
    sel.dataset.key = key;
    sel.textContent = '';
    sel.appendChild(h('option', { attrs: { value: '' }, text: '' }));
    for (const s of state.spots) sel.appendChild(h('option', { attrs: { value: s }, text: s }));
  }
  if (document.activeElement !== sel) sel.value = want;
}

function paint() {
  if (!state) return;
  const a = state.arrival;
  const open = a && (a.status === 'waiting' || a.status === 'seen');
  const showMine = a && (open || !fresh);
  document.title = tx('heading') || t('curbside.pub.title');
  $('loc').textContent = state.name || '';
  $('heading').textContent = tx('heading');
  $('keep').hidden = !open;
  $('keep').textContent = tx('keep_open');

  const shownSpot = showMine ? a.spot : state.spot;
  $('spotBox').hidden = !shownSpot;
  $('spotLabel').textContent = tx('spot_label');
  $('spot').textContent = shownSpot || '';

  $('mine').hidden = !showMine;
  $('form').hidden = !!showMine;
  if (showMine) {
    $('orderLine').textContent = '';
    $('orderLine').append(`${tx('order_label')}: `, h('b', { text: a.order_ref }));
    const st = $('status');
    st.className = `status ${a.status}`;
    st.textContent = fillText(tx(a.status === 'seen' ? 'seen' : a.status === 'done' ? 'done' : a.status === 'cancelled' ? 'cancelled' : 'waiting'), vars());
    $('cancel').hidden = !open;
    $('cancel').textContent = tx('cancel');
    $('cancel').disabled = busy;
    $('again').hidden = open;
    $('again').textContent = tx('again');
    return;
  }
  // The form.
  $('intro').textContent = tx('intro');
  $('pickBox').hidden = !!(askedSpot && state.spot);
  $('pickLabel').textContent = tx('choose_spot');
  if (!$('pickBox').hidden) fillPicker();
  $('orderLabel').textContent = tx('order_label');
  $('noteLabel').textContent = tx('note_label');
  $('submit').textContent = tx('button');
  $('submit').disabled = busy || !state.spot || state.spot_taken;
  // "This spot is taken" comes and goes with the poll; an error message stays until the next try.
  if (state.spot_taken) { showMsg(fillText(tx('spot_taken'), vars())); takenShown = true; }
  else if (takenShown) { showMsg(''); takenShown = false; }
}

async function load() {
  const q = new URLSearchParams();
  if (spot) q.set('spot', spot);
  if (rev) q.set('rev', rev);
  const r = await call('GET', '/state?' + q.toString());
  if (r.unchanged) return false;
  state = r; rev = r.rev;
  return true;
}

async function checkIn(ev) {
  ev.preventDefault();
  if (busy || !state) return;
  const order = $('order').value.trim();
  if (!order) { showMsg(t('curbside.pub.need_order')); $('order').focus(); return; }
  busy = true; paint();
  try {
    const r = await call('POST', '/checkin', { spot: state.spot, order_ref: order, note: $('note').value.trim() });
    state = r.state; rev = state.rev; fresh = false;
    takenShown = false;
    showMsg('');
  } catch (e) {
    if (e.code === 'spot_taken') { rev = null; try { await load(); } catch { /* keep */ } }
    else if (e.code === 'rate_limited') showMsg(t('curbside.pub.slow_down'));
    else if (e.code === 'open_limit') showMsg(t('curbside.pub.open_limit'));
    else if (e.status === 404) showMsg(t('curbside.pub.not_found'));
    else showMsg(e.message);
  } finally { busy = false; paint(); }
}

async function cancel() {
  if (busy || !confirm(t('curbside.pub.cancel_confirm'))) return;
  busy = true; paint();
  try {
    const r = await call('POST', '/cancel', {});
    state = r.state; rev = state.rev;
  } catch (e) { showMsg(e.status === 404 ? '' : e.message); rev = null; try { await load(); } catch { /* keep */ } }
  finally { busy = false; paint(); }
}

async function poll() {
  if (busy) return;
  try { if (await load()) paint(); }
  catch (e) { if (e.status === 404) { showMsg(t('curbside.pub.not_found')); } /* offline for a moment: keep what is on screen */ }
}

$('form').addEventListener('submit', checkIn);
$('cancel').addEventListener('click', cancel);
$('again').addEventListener('click', () => {
  fresh = true;
  if (state && state.arrival) spot = spot || state.arrival.spot;
  $('order').value = ''; $('note').value = '';
  rev = null;
  poll();
  paint();
});
$('pick').addEventListener('change', () => { spot = $('pick').value; rev = null; showMsg(''); poll(); });

async function boot() {
  if (!token) { showMsg(t('curbside.pub.not_found')); return; }
  try { await load(); }
  catch (e) { showMsg(e.status === 404 ? t('curbside.pub.not_found') : e.message); return; }
  paint();
  setInterval(poll, POLL_MS);
}
boot();
