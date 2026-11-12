/*
 * "Now serving": the staff log line for one event (lib/queue/service.js queue_events), shared by
 * the staff page and the dashboard's Queue page. Text only; the caller inserts it with textContent.
 */
import { t } from '../i18n.js';

export function eventText(e) {
  const n = e && e.number != null ? String(e.number) : '';
  switch (e && e.kind) {
    case 'next': return t('queue.log.next', { n });
    case 'call': return t('queue.log.call', { n });
    case 'reset': return t('queue.log.reset');
    case 'new_day': return t('queue.log.new_day');
    case 'sound_on': return t('queue.log.sound_on');
    case 'sound_off': return t('queue.log.sound_off');
    default: return String((e && e.kind) || '');
  }
}

export function eventSource(e) {
  if (!e) return '';
  if (e.source === 'staff_link') return t('queue.log.by_staff_link');
  if (e.source === 'auto') return t('queue.log.by_auto');
  return t('queue.log.by_dashboard');
}

export function eventTime(e) {
  try { return new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  catch { return ''; }
}

/** Fill an <ol> with the log, newest first. */
export function renderLog(ol, events) {
  ol.textContent = '';
  const list = Array.isArray(events) ? events : [];
  if (!list.length) {
    const li = document.createElement('li');
    li.textContent = t('queue.log.empty');
    ol.appendChild(li);
    return;
  }
  for (const e of list) {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = eventTime(e);
    try { time.dateTime = new Date(e.at).toISOString(); } catch { /* bad stamp */ }
    const what = document.createElement('span');
    what.textContent = `${eventText(e)} (${eventSource(e)})`;
    // The space separates time and text in the dashboard's plain list; the staff page's flex row ignores it.
    li.append(time, ' ', what);
    ol.appendChild(li);
  }
}
