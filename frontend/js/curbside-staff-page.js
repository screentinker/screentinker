/*
 * Curbside pickup: the staff page for a shared phone or tablet with no account (server:
 * routes/curbside-public.js /s/*).
 *
 *   /curbside-staff#<location id>.<token>
 *
 * ⚠️ THE KEY STAYS IN THE FRAGMENT, exactly like the queue's staff page: a browser never sends the
 * fragment to a server, and the page sends the key only in the X-Curbside-Staff-Key header.
 *
 * The cars waiting, oldest first, with spot, order number, note and minutes waiting (green, then
 * yellow after 5 minutes, red after 10). "We got you" tells the customer the order is on the way;
 * "Done" takes the car off the list. With the sound switched on (a tap, which is also what lets a
 * browser play sound) a new car plays a short chime and vibrates the phone where it can.
 */
import { t } from './i18n.js';
import { renderArrivals, unlockChime, playChime } from './lib/curbside-dom.js';

const API = '/api/public/curbside/s/';
const POLL_MS = 4000;
const SOUND_KEY = 'st-curbside-staff-sound';
const key = decodeURIComponent((location.hash || '').replace(/^#/, ''));
const $ = (id) => document.getElementById(id);

let state = null;
let fetchedAt = 0;
let busy = false;
let lastOk = 0;
let known = null;            // arrival ids already seen (null until the first answer: no chime on load)
let sound = false;
try { sound = localStorage.getItem(SOUND_KEY) === '1'; } catch { /* private mode */ }

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method, credentials: 'omit', cache: 'no-store',
    headers: { 'X-Curbside-Staff-Key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  if (!res.ok) { const e = new Error((json && json.error) || t('curbside.staff.err')); e.status = res.status; e.code = json && json.code; throw e; }
  return json || {};
}

function paintSound() {
  $('sound').textContent = sound ? t('curbside.staff.sound_on') : t('curbside.staff.sound_off');
  $('sound').className = sound ? 'on' : '';
}

function announce(next) {
  const ids = new Set((next.arrivals || []).map((a) => a.id));
  if (known) {
    const fresh = [...ids].some((id) => !known.has(id));
    if (fresh && sound) {
      playChime();
      try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch { /* no vibration */ }
    }
  }
  known = ids;
}

function paint() {
  if (!state) return;
  $('bad').hidden = true;
  $('lname').textContent = state.name || '';
  document.title = `${state.name || ''} · ${t('curbside.staff.title')}`;
  const n = (state.arrivals || []).length;
  $('sub').textContent = t('curbside.staff.sub', { waiting: n, done: state.done_today || 0 });
  renderArrivals($('list'), state.arrivals, {
    serverNow: state.now, fetchedAt, busy,
    onAck: (a) => act('ack', { id: a.id }),
    onDone: (a) => act('done', { id: a.id }),
  });
}

function refused(e) {
  if (e && e.status === 401) {
    state = null;
    $('list').textContent = '';
    $('sub').textContent = '';
    $('bad').hidden = false;
    $('bad').textContent = t('curbside.staff.link_dead');
    return true;
  }
  return false;
}

function take(next) {
  announce(next);
  state = next; fetchedAt = Date.now(); lastOk = fetchedAt;
}

async function act(path, body) {
  if (busy) return;
  busy = true; paint();
  $('msg').textContent = '';
  try { take(await call('POST', path, body)); }
  catch (e) { if (!refused(e)) $('msg').textContent = e.message; }
  finally { busy = false; paint(); }
}

async function poll() {
  if (busy) return;
  try { take(await call('GET', 'state')); paint(); }
  catch (e) { refused(e); }
  $('stale').textContent = lastOk && Date.now() - lastOk > 15000 ? t('curbside.staff.offline') : '';
}

$('sound').addEventListener('click', () => {
  sound = !sound;
  try { localStorage.setItem(SOUND_KEY, sound ? '1' : '0'); } catch { /* this visit only */ }
  if (sound) { unlockChime(); playChime(0.4); }
  paintSound();
});
// A browser plays sound only after a tap: any tap on the page unlocks it for the chime.
document.addEventListener('pointerdown', () => { if (sound) unlockChime(); }, { once: false, passive: true });

paintSound();
if (!key) {
  $('bad').hidden = false;
  $('bad').textContent = t('curbside.staff.link_dead');
} else {
  poll();
  setInterval(poll, POLL_MS);
  // Minutes waiting move on between polls too.
  setInterval(() => { if (!busy) paint(); }, 20000);
}
