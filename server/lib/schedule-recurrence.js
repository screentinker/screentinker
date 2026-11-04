'use strict';

/* Corrected semantics for the recurrence kinds the product creates. Unknown
 * stored rules return null so the caller can retain its legacy fallback. */
function p2(n) { return n < 10 ? '0' + n : String(n); }
function stamp(parts) {
  const hour = Math.floor(parts.min / 60), minute = parts.min % 60;
  return `${parts.y}-${p2(parts.mo)}-${p2(parts.day)}T${p2(hour)}:${p2(minute)}`;
}
function ordinal(parts) { return Math.floor(Date.UTC(parts.y, parts.mo - 1, parts.day) / 86400000); }
function shift(parts, days) {
  const date = new Date(Date.UTC(parts.y, parts.mo - 1, parts.day + days));
  return { y: date.getUTCFullYear(), mo: date.getUTCMonth() + 1, day: date.getUTCDate(), dow: date.getUTCDay(), min: parts.min };
}
function startDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!match) return null;
  const y = Number(match[1]), mo = Number(match[2]), day = Number(match[3]);
  const date = new Date(Date.UTC(y, mo - 1, day));
  if (!y || date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== day) return null;
  return { y, mo, day, dow: date.getUTCDay(), min: 0 };
}
function occurrenceAnchor(local, startHM, endHM) {
  const nowHM = stamp(local).slice(11);
  if (endHM > startHM) return nowHM >= startHM && nowHM <= endHM ? local : false;
  if (endHM === startHM) return false;
  if (nowHM >= startHM) return local;
  return nowHM <= endHM ? shift(local, -1) : false;
}
function fires(rule, anchor, first) {
  const interval = Math.max(1, Number(rule.interval) || 1);
  const day = ordinal(anchor), firstDay = ordinal(first);
  if (day < firstDay) return false;
  if (rule.freq === 'DAILY') return (day - firstDay) % interval === 0;
  if (rule.freq === 'WEEKLY') {
    const weekdays = rule.byDay && rule.byDay.length ? rule.byDay : [first.dow];
    const week = Math.floor(((day - anchor.dow) - (firstDay - first.dow)) / 7);
    return weekdays.includes(anchor.dow) && week >= 0 && week % interval === 0;
  }
  if (rule.freq === 'MONTHLY') {
    const months = (anchor.y - first.y) * 12 + anchor.mo - first.mo;
    return anchor.day === first.day && months >= 0 && months % interval === 0;
  }
  return false;
}

function evaluateKnown(schedule, local, rule) {
  if (!rule || !['DAILY', 'WEEKLY', 'MONTHLY'].includes(rule.freq)) return null;
  const startStamp = String(schedule.start_time || '').slice(0, 16);
  const endStamp = String(schedule.end_time || '').slice(0, 16);
  const first = startDate(startStamp);
  if (!first) return false;
  const anchor = occurrenceAnchor(local, startStamp.slice(11), endStamp.slice(11));
  if (!anchor) return false;
  const date = stamp(anchor).slice(0, 10);
  if (date < startStamp.slice(0, 10)) return false;
  if (schedule.recurrence_end && date > String(schedule.recurrence_end).slice(0, 10)) return false;
  return fires(rule, anchor, first);
}

module.exports = { evaluateKnown };
