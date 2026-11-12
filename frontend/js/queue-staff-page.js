/*
 * "Now serving": the staff page for a shared phone or tablet with no account (server:
 * routes/queue-public.js /s/*).
 *
 *   /queue-staff#<queue id>.<token>
 *
 * ⚠️ THE KEY STAYS IN THE FRAGMENT. A browser never sends the fragment to a server, so it is in no
 * access log and no Referer; the page sends it only in the X-Queue-Staff-Key header. Anyone holding
 * the link can call numbers, so the dashboard can replace or switch it off at any time; the page then
 * says so instead of failing silently.
 */
import { t } from './i18n.js';
import { renderLog } from './lib/queue-log.js';

const API = '/api/public/queue/s/';
const POLL_MS = 4000;
const key = decodeURIComponent((location.hash || '').replace(/^#/, ''));
const $ = (id) => document.getElementById(id);

let state = null;
let busy = false;
let lastOk = 0;

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method, credentials: 'omit', cache: 'no-store',
    headers: { 'X-Queue-Staff-Key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  if (!res.ok) { const e = new Error((json && json.error) || t('queue.staff.err')); e.status = res.status; e.code = json && json.code; throw e; }
  return json || {};
}

function labels() {
  $('nowLabel').textContent = t('queue.staff.now_serving');
  $('next').textContent = t('queue.staff.next');
  $('callBtn').textContent = t('queue.staff.call');
  $('callNum').placeholder = t('queue.staff.call_ph');
  $('soundLabel').textContent = t('queue.staff.sound');
  $('reset').textContent = t('queue.staff.start_day');
  $('logTitle').textContent = t('queue.staff.log');
}

function paint() {
  if (!state) return;
  $('app').hidden = false;
  $('bad').hidden = true;
  $('qname').textContent = state.name || '';
  document.title = `${state.name || ''} · ${t('queue.staff.title')}`;
  $('sub').textContent = t('queue.staff.sub', { issued: state.last_issued, max: state.max_per_day });
  $('num').textContent = state.now_serving > 0 ? String(state.now_serving) : '–';
  $('waiting').textContent = state.waiting === 1 ? t('queue.staff.waiting_one') : t('queue.staff.waiting', { n: state.waiting });
  $('next').disabled = busy || state.waiting < 1;
  $('callBtn').disabled = busy || state.last_issued < 1;
  $('callNum').max = String(Math.max(1, state.last_issued));
  $('sound').checked = !!state.sound_on;
  $('sound').disabled = busy;
  $('reset').disabled = busy;
  renderLog($('log'), state.events);
}

function refused(e) {
  if (e && e.status === 401) {
    state = null;
    $('app').hidden = true;
    $('bad').hidden = false;
    $('bad').textContent = t('queue.staff.link_dead');
    return true;
  }
  return false;
}

async function act(path, body) {
  if (busy) return;
  busy = true; paint();
  $('msg').textContent = '';
  try {
    state = await call('POST', path, body);
    lastOk = Date.now();
  } catch (e) {
    if (!refused(e)) $('msg').textContent = e.message;
  } finally { busy = false; paint(); }
}

async function poll() {
  if (busy) return;
  try {
    state = await call('GET', 'state');
    lastOk = Date.now();
    paint();
  } catch (e) { refused(e); }
  $('stale').textContent = lastOk && Date.now() - lastOk > 15000 ? t('queue.staff.offline') : '';
}

$('next').addEventListener('click', () => act('next'));
$('callBtn').addEventListener('click', () => {
  const n = parseInt($('callNum').value, 10);
  if (!Number.isInteger(n) || n < 1) { $('msg').textContent = t('queue.staff.call_invalid'); return; }
  act('call', { number: n }).then(() => { $('callNum').value = ''; });
});
$('sound').addEventListener('change', () => act('sound', { on: $('sound').checked }));
$('reset').addEventListener('click', () => { if (confirm(t('queue.staff.start_day_confirm'))) act('reset'); });

labels();
if (!key) {
  $('bad').hidden = false;
  $('bad').textContent = t('queue.staff.link_dead');
} else {
  poll();
  setInterval(poll, POLL_MS);
}
