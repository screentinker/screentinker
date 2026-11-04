'use strict';

/*
 * Offline plans use half-open intervals and must be able to pre-resolve
 * overnight and interval recurrences. This deliberately lives outside the
 * live scheduler: changing the established online evaluator is a fleet-wide
 * compatibility migration and is reviewed separately from the SSSP3 plan
 * contract.
 */

function p2(n) { return n < 10 ? '0' + n : String(n); }
function localStamp(parts) {
  const hh = Math.floor(parts.min / 60), mm = parts.min % 60;
  return `${parts.y}-${p2(parts.mo)}-${p2(parts.day)}T${p2(hh)}:${p2(mm)}`;
}
function ordinal(parts) { return Math.floor(Date.UTC(parts.y, parts.mo - 1, parts.day) / 86400000); }
function shift(parts, days) {
  const d = new Date(Date.UTC(parts.y, parts.mo - 1, parts.day + days));
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, day: d.getUTCDate(), dow: d.getUTCDay(), min: parts.min };
}
function dateParts(stamp) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(stamp || ''));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), day = Number(m[3]);
  const d = new Date(Date.UTC(y, mo - 1, day));
  if (!y || d.getUTCFullYear() !== y || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== day) return null;
  return { y, mo, day, dow: d.getUTCDay(), min: 0 };
}
function parse(rrule) {
  if (!rrule) return null;
  const rule = {}, days = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  for (const part of String(rrule).split(';')) {
    const [key, value] = part.split('=');
    if (key === 'FREQ') rule.freq = value;
    if (key === 'BYDAY') rule.byDay = value.split(',').map((d) => days[d]).filter((d) => d !== undefined);
    if (key === 'INTERVAL') rule.interval = parseInt(value, 10);
  }
  return Object.keys(rule).length ? rule : null;
}
function anchorFor(local, startHM, endHM) {
  const nowHM = localStamp(local).slice(11);
  if (endHM > startHM) return nowHM >= startHM && nowHM < endHM ? local : null;
  if (endHM === startHM) return null;
  if (nowHM >= startHM) return local;
  return nowHM < endHM ? shift(local, -1) : null;
}
function fires(rule, anchor, start) {
  const interval = Math.max(1, Number(rule.interval) || 1);
  const day = ordinal(anchor), first = ordinal(start);
  if (day < first) return false;
  if (rule.freq === 'DAILY') return (day - first) % interval === 0;
  if (rule.freq === 'WEEKLY') {
    const wanted = rule.byDay && rule.byDay.length ? rule.byDay : [start.dow];
    return wanted.includes(anchor.dow) && Math.floor(((day - anchor.dow) - (first - start.dow)) / 7) % interval === 0;
  }
  if (rule.freq === 'MONTHLY') {
    const months = (anchor.y - start.y) * 12 + anchor.mo - start.mo;
    return anchor.day === start.day && months >= 0 && months % interval === 0;
  }
  return false;
}
function isActiveAt(schedule, local) {
  const now = localStamp(local);
  const startStamp = String(schedule.start_time || '').slice(0, 16);
  const endStamp = String(schedule.end_time || '').slice(0, 16);
  if (!schedule.recurrence) return now >= startStamp && now <= endStamp;
  const rule = parse(schedule.recurrence), start = dateParts(startStamp);
  if (!rule || !start) return now >= startStamp && now <= endStamp;
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(rule.freq)) {
    const date = now.slice(0, 10), nowHM = now.slice(11);
    if (date < startStamp.slice(0, 10)) return false;
    if (schedule.recurrence_end && date > String(schedule.recurrence_end).slice(0, 10)) return false;
    if (rule.byDay && !rule.byDay.includes(local.dow)) return false;
    return nowHM >= startStamp.slice(11) && nowHM <= endStamp.slice(11);
  }
  const anchor = anchorFor(local, startStamp.slice(11), endStamp.slice(11));
  if (!anchor) return false;
  const date = localStamp(anchor).slice(0, 10);
  if (date < startStamp.slice(0, 10)) return false;
  if (schedule.recurrence_end && date > String(schedule.recurrence_end).slice(0, 10)) return false;
  return fires(rule, anchor, start);
}
function pickActiveScheduleAt(schedules, local) { return schedules.find((schedule) => isActiveAt(schedule, local)); }

module.exports = { isActiveAt, pickActiveScheduleAt };
