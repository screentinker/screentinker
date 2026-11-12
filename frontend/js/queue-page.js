/*
 * "Now serving": the customer page a queue's QR code opens (server: routes/queue-public.js,
 * lib/queue/service.js).
 *
 *   /queue/<public token>   opening it takes a number (POST), then the page shows that number and
 *                           the one being served, polling every few seconds.
 *
 * The number is remembered in localStorage per queue and per day (and per round, so a manual start
 * of day is noticed). A random client id goes with the request, so even a reload or a second scan
 * that lost the stored number gets the same one back from the server for the rest of that round.
 * Everything from the server is inserted with textContent.
 */
import { t } from './i18n.js';

const API = '/api/public/queue/c/';
const POLL_MS = 4000;
const token = decodeURIComponent((location.pathname.split('/')[2] || '').trim());
const $ = (id) => document.getElementById(id);

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: the server id still holds */ } },
};
// Keyed by queue (a short prefix of its token is enough to tell queues apart on one phone) and day.
const keyFor = (day) => `st-queue:${token.slice(0, 16)}:${day}`;
const clientKey = `st-queue-client:${token.slice(0, 16)}`;

function randomId() {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Mirrors lib/queue/service.js aheadOf: never a negative count.
export function aheadOf(ticket, nowServing) {
  const tk = Number(ticket);
  const s = Number(nowServing) || 0;
  if (!Number.isInteger(tk) || tk < 1) return { status: 'none', ahead: 0 };
  if (s === tk) return { status: 'called', ahead: 0 };
  if (s > tk) return { status: 'passed', ahead: 0 };
  return { status: 'waiting', ahead: Math.max(0, tk - s) };
}

let state = null;
let mine = null;       // { number, round, day }
let rev = null;
let taking = false;

async function call(method, path, body) {
  const res = await fetch(API + encodeURIComponent(token) + path, {
    method, credentials: 'omit', cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  if (!res.ok) { const e = new Error((json && json.error) || t('queue.pub.err')); e.status = res.status; e.code = json && json.code; throw e; }
  return json || {};
}

function paint() {
  if (!state) return;
  $('qname').textContent = state.name || '';
  document.title = mine ? t('queue.pub.title_mine', { n: mine.number }) : (state.name || t('queue.pub.title'));
  $('serving').textContent = '';
  const s = document.createElement('span');
  s.textContent = t('queue.pub.now_serving') + ' ';
  const b = document.createElement('b');
  b.textContent = state.now_serving > 0 ? String(state.now_serving) : '–';
  $('serving').append(s, b);

  const valid = mine && mine.round === state.round && mine.day === state.day;
  $('ticket').hidden = !valid;
  $('again').hidden = true;
  const st = $('status');
  if (valid) {
    $('mineLabel').textContent = t('queue.pub.your_number');
    $('mine').textContent = String(mine.number);
    const a = aheadOf(mine.number, state.now_serving);
    st.hidden = false;
    st.className = 'status ' + a.status;
    if (a.status === 'called') st.textContent = t('queue.pub.called');
    else if (a.status === 'passed') st.textContent = t('queue.pub.passed');
    else st.textContent = a.ahead === 1 ? t('queue.pub.ahead_one') : t('queue.pub.ahead', { n: a.ahead });
  } else if (mine) {
    // The queue was restarted (start of day) since this number was taken.
    st.hidden = false; st.className = 'status passed'; st.textContent = t('queue.pub.restarted');
    $('again').hidden = false; $('again').textContent = t('queue.pub.take_new');
  } else {
    st.hidden = true;
  }
  $('note').textContent = t('queue.pub.note');
}

function showError(e) {
  const m = $('msg');
  m.hidden = !e;
  m.textContent = e ? e.message : '';
}

async function take() {
  if (taking) return;
  taking = true;
  try {
    let cid = store.get(clientKey);
    if (!cid || !cid.day || cid.day !== (state && state.day) || cid.round !== (state && state.round)) {
      cid = { id: randomId(), day: state && state.day, round: state && state.round };
      store.set(clientKey, cid);
    }
    const r = await call('POST', '/ticket', { client_id: cid.id });
    state = r.state; rev = state.rev;
    mine = { number: r.number, round: state.round, day: state.day };
    store.set(keyFor(state.day), mine);
    showError(null);
  } catch (e) { showError(e); }
  finally { taking = false; paint(); }
}

async function poll() {
  try {
    const r = await call('GET', '/state' + (rev ? `?rev=${encodeURIComponent(rev)}` : ''));
    if (!r.unchanged) {
      state = r; rev = r.rev;
      // A new day: yesterday's number means nothing any more.
      if (mine && mine.day !== state.day) mine = null;
      paint();
    }
  } catch (e) {
    if (e.status === 404) { state = null; showError(e); return; }
    // Offline for a moment: keep what is on screen.
  }
}

async function boot() {
  if (!token) { showError(new Error(t('queue.pub.not_found'))); return; }
  try {
    state = await call('GET', '/state'); rev = state.rev;
  } catch (e) { showError(e); return; }
  mine = store.get(keyFor(state.day));
  if (!mine || mine.round !== state.round) {
    mine = null;
    await take();
  } else {
    paint();
  }
  setInterval(poll, POLL_MS);
}

$('again').addEventListener('click', () => { mine = null; take(); });
boot();
