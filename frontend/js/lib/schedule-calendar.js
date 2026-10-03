// The calendar's VIEW MODEL, kept apart from the DOM so it can be pinned in Node the way
// schedule-grid.js is. Everything here answers one of four questions and nothing else:
//
//   which dates does this view show, and which does it need to FETCH  (periodRange, stepAnchor)
//   how does a month lay out                                           (monthGrid)
//   how do overlapping blocks share a column                           (packColumns)
//   what does a recurrence rule mean, and how is one written           (parseRRule, composeRRule, describeRecurrence)
//
// The engine (services/scheduler.js) is the source of truth for what a rule DOES. It honours
// BYDAY, the date window and recurrence_end; it does not read COUNT or INTERVAL. So this module
// only ever writes rules the engine can evaluate, and refuses to compose ones it cannot.

import { DAY_MIN, crossesMidnight } from './schedule-grid.js';

export const VIEWS = ['day', 'workweek', 'week', 'month'];
export const DEFAULT_VIEW = 'week';
export const VIEW_STORAGE_KEY = 'st_schedule_view';
export const RAIL_STORAGE_KEY = 'st_schedule_rail';

// The week starts on Sunday because /schedules/week snaps its date to Sunday; a different first
// day here would put the grid and the fetch window out of step.
export const WEEK_START_DOW = 0;
export const WORK_DAYS = [1, 2, 3, 4, 5];           // Mon..Fri
export const WORK_START_MIN = 8 * 60;               // shaded as "working hours"
export const WORK_END_MIN = 17 * 60;
export const MONTH_GRID_WEEKS = 6;                  // Outlook always draws six rows, so the grid never jumps height

export const RRULE_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const DOW_TO_RRULE = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];   // getDay() -> RRULE token

export function startOfDay(d) { const x = new Date(d.getTime()); x.setHours(0, 0, 0, 0); return x; }
export function addDays(d, n) { const x = startOfDay(d); x.setDate(x.getDate() + n); return x; }
export function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
export function startOfWeek(d) { const x = startOfDay(d); return addDays(x, -((x.getDay() - WEEK_START_DOW + 7) % 7)); }
export function startOfMonth(d) { const x = startOfDay(d); x.setDate(1); return x; }

// Local calendar date as the API wants it. Not toISOString(): that is UTC, and west of Greenwich
// it turns an evening into the previous day.
export function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/*
 * What a view shows and what it must fetch. `days` is the list of visible dates in order;
 * `fetchStart`/`fetchDays` is the single /week request that covers them. Day and work-week are
 * carved out of the containing week so navigating between the three views costs no extra fetch.
 */
export function periodRange(view, anchor) {
  const a = startOfDay(anchor);
  switch (view) {
    case 'day':
      return { view, start: a, days: [a], fetchStart: startOfWeek(a), fetchDays: 7 };
    case 'workweek': {
      const ws = startOfWeek(a);
      const days = WORK_DAYS.map((dow) => addDays(ws, (dow - WEEK_START_DOW + 7) % 7));
      return { view, start: days[0], days, fetchStart: ws, fetchDays: 7 };
    }
    case 'month': {
      const gridStart = startOfWeek(startOfMonth(a));
      const days = Array.from({ length: MONTH_GRID_WEEKS * 7 }, (_, i) => addDays(gridStart, i));
      return { view, start: gridStart, days, fetchStart: gridStart, fetchDays: days.length };
    }
    case 'week':
    default: {
      const ws = startOfWeek(a);
      return { view: 'week', start: ws, days: Array.from({ length: 7 }, (_, i) => addDays(ws, i)), fetchStart: ws, fetchDays: 7 };
    }
  }
}

// Prev/next moves by the unit the view shows. A month step keeps the day-of-month where it can
// and clamps at the end of a shorter month rather than spilling into the next one (Jan 31 -> Feb 28).
export function stepAnchor(view, anchor, dir) {
  const a = startOfDay(anchor);
  if (view === 'day') return addDays(a, dir);
  if (view === 'month') {
    const target = new Date(a.getFullYear(), a.getMonth() + dir, 1);
    const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(a.getDate(), last));
    return target;
  }
  return addDays(a, 7 * dir);
}

// Six rows of seven, Sunday-first, always including the whole month plus the leading/trailing
// days that pad it. Each cell knows whether it belongs to the month being shown.
export function monthGrid(anchor) {
  const m = startOfMonth(anchor);
  const { days } = periodRange('month', m);
  const weeks = [];
  for (let i = 0; i < days.length; i += 7) {
    weeks.push(days.slice(i, i + 7).map((d) => ({ date: d, inMonth: d.getMonth() === m.getMonth() })));
  }
  return { year: m.getFullYear(), month: m.getMonth(), weeks };
}

// A whole-day schedule: either the literal 00:00-24:00 window, or a wrap whose end equals its
// start, which the engine treats as running the full 24 hours. Those belong in the all-day row,
// not as a block the height of the entire grid.
export function isAllDay(startMin, endMin) {
  if (startMin === 0 && endMin >= DAY_MIN) return true;
  return crossesMidnight(startMin, endMin) && startMin === endMin;
}

/*
 * Outlook-style packing: blocks that overlap in time share the width side by side instead of
 * stacking full-width on top of each other, where the lower one is unreachable.
 *
 * Interval-graph colouring. Sort by start (then longer first), sweep, and give each block the
 * lowest column whose previous occupant has ended. Blocks that transitively overlap form a
 * cluster, and everything in a cluster divides the width by the cluster's column count, so a
 * lone block next to a busy hour still gets its full width. Returns the same objects, each given
 * `col` (0-based) and `cols` (its cluster's width in columns). Pure: safe on any array of
 * {startMin, endMin}.
 */
export function packColumns(items) {
  const sorted = [...items].sort((a, b) => (a.startMin - b.startMin) || (b.endMin - a.endMin));
  let cluster = [], colEnds = [], clusterEnd = -Infinity;
  const flush = () => { for (const it of cluster) it.cols = colEnds.length; cluster = []; colEnds = []; clusterEnd = -Infinity; };
  for (const it of sorted) {
    if (cluster.length && it.startMin >= clusterEnd) flush();      // no overlap with anything so far: new cluster
    let col = colEnds.findIndex((end) => end <= it.startMin);
    if (col === -1) { col = colEnds.length; colEnds.push(0); }
    colEnds[col] = it.endMin;
    it.col = col;
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.endMin);
  }
  flush();
  return items;
}

// ------------------------------------------------------------------ recurrence

// The subset the engine evaluates, plus INTERVAL because parse should not lose it even though
// nothing downstream reads it. Unknown keys and unknown BYDAY tokens (like "1MO") are dropped,
// which mirrors both server parsers: they filter unrecognised days out rather than failing.
export function parseRRule(str) {
  if (!str) return null;
  const rule = { freq: null, byDay: [], interval: 1 };
  for (const part of String(str).split(';')) {
    const [k, v] = part.split('=');
    if (k === 'FREQ') rule.freq = v;
    else if (k === 'BYDAY') rule.byDay = v.split(',').filter((d) => RRULE_DAYS.includes(d));
    else if (k === 'INTERVAL') rule.interval = Math.max(1, parseInt(v, 10) || 1);
  }
  return rule.freq ? rule : null;
}

/*
 * Write a rule the engine will evaluate the way the calendar draws it.
 *
 * ⚠️ WEEKLY ALWAYS CARRIES BYDAY. The engine ignores FREQ: a bare "FREQ=WEEKLY" has no BYDAY
 * filter and so plays EVERY day, while the calendar draws it once a week on the start's weekday.
 * Writing the weekday explicitly makes the two agree. Existing bare-WEEKLY rows are left as they
 * are; changing what they play is not this module's call.
 *
 * ⚠️ NO nth-WEEKDAY MONTHLY ("BYDAY=1MO"). Neither parser understands it; the token is silently
 * dropped and the rule fires daily. Refusing to write it beats offering a control that lies.
 */
export function composeRRule({ freq, byDay = [], startDate = null } = {}) {
  if (!freq || freq === 'NONE') return null;
  if (freq === 'DAILY') return 'FREQ=DAILY';
  if (freq === 'MONTHLY') return 'FREQ=MONTHLY';
  if (freq === 'WEEKLY') {
    let days = RRULE_DAYS.filter((d) => byDay.includes(d));
    if (!days.length && startDate) days = [DOW_TO_RRULE[startDate.getDay()]];
    return days.length ? `FREQ=WEEKLY;BYDAY=${days.join(',')}` : 'FREQ=WEEKLY';
  }
  return null;
}

export const WEEKDAYS_RULE = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
export const WEEKENDS_RULE = 'FREQ=WEEKLY;BYDAY=SA,SU';

// Which editor preset a stored rule corresponds to, so an existing schedule opens on what it
// actually does. A bare WEEKLY shows as weekly-on-the-start-weekday, which is what the calendar
// draws (and what the engine will do once it is re-saved with an explicit day).
export function presetFor(str, startDate = null) {
  const r = parseRRule(str);
  if (!r) return { preset: 'none', byDay: [] };
  if (r.freq === 'DAILY') return { preset: 'daily', byDay: [] };
  if (r.freq === 'MONTHLY') return { preset: 'monthly', byDay: [] };
  if (r.freq === 'WEEKLY') {
    const key = r.byDay.join(',');
    if (key === 'MO,TU,WE,TH,FR') return { preset: 'weekdays', byDay: r.byDay };
    if (key === 'SA,SU') return { preset: 'weekends', byDay: r.byDay };
    const byDay = r.byDay.length ? r.byDay : (startDate ? [DOW_TO_RRULE[startDate.getDay()]] : []);
    return { preset: 'weekly', byDay };
  }
  return { preset: 'custom', byDay: r.byDay };
}

// The pieces of a human summary ("Every Mon, Wed, Fri from 9:00 AM to 5:00 PM until Oct 31").
// Returned as data rather than a sentence so the view can assemble it through t() in any locale.
export function describeRecurrence(str, { startDate = null } = {}) {
  const { preset, byDay } = presetFor(str, startDate);
  return { kind: preset, days: byDay, dayOfMonth: preset === 'monthly' && startDate ? startDate.getDate() : null };
}

// ------------------------------------------------------------------ "this occurrence only"

/*
 * Outlook's "edit this occurrence" for a repeating schedule, with nothing the backend does not
 * already store. There is no per-occurrence exception in the schema (no EXDATE, no override row),
 * so the series is SPLIT around the day instead:
 *
 *   head    the existing row, cut off the day before the occurrence (recurrence_end)
 *   single  a one-off carrying the edited occurrence, on its day, no recurrence
 *   tail    a copy of the rule resuming the day after, keeping the original end
 *
 * Every one of those is an ordinary row the engine already evaluates. Degenerate ends are handled
 * rather than written as empty ranges: an occurrence on the series' first day has no head (the
 * existing row is repointed to become the tail), one on its last day has no tail, and a one-day
 * series with both is simply replaced by the single.
 *
 * Returns a plan {update, create, delete}; the view performs it. `edited` is the occurrence's new
 * {date, startMin, endMin}. Pure, so the splitting rule is pinned in Node.
 */
export function planOccurrenceEdit(ev, occurrenceDate, edited) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = (date, min) => `${ymd(date)}T${p(Math.floor(min / 60) % 24)}:${p(min % 60)}:00`;
  const hm = (d) => d.getHours() * 60 + d.getMinutes();
  const seriesStart = startOfDay(new Date(ev.start_time));
  const occ = startOfDay(occurrenceDate);
  const s = new Date(ev.start_time), e = new Date(ev.end_time);
  const base = {
    device_id: ev.device_id || null, group_id: ev.group_id || null, zone_id: ev.zone_id || null,
    content_id: ev.content_id || null, playlist_id: ev.playlist_id || null, layout_id: ev.layout_id || null,
    widget_id: ev.widget_id || null, title: ev.title || '', priority: ev.priority || 0, color: ev.color || '#3B82F6',
  };
  const editedDate = edited.date ? startOfDay(edited.date) : occ;
  const single = { ...base, start_time: stamp(editedDate, edited.startMin), end_time: stamp(editedDate, edited.endMin), recurrence: null, recurrence_end: null };

  const dayBefore = addDays(occ, -1), dayAfter = addDays(occ, 1);
  let recEnd = null;
  if (ev.recurrence_end) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ev.recurrence_end));
    if (m) recEnd = new Date(+m[1], +m[2] - 1, +m[3]);
  }
  const hasHead = occ.getTime() > seriesStart.getTime();
  const hasTail = !recEnd || dayAfter.getTime() <= recEnd.getTime();
  const tail = hasTail
    ? { ...base, start_time: stamp(dayAfter, hm(s)), end_time: stamp(dayAfter, hm(e)), recurrence: ev.recurrence, recurrence_end: ev.recurrence_end || null }
    : null;

  if (hasHead) return { update: { recurrence_end: ymd(dayBefore) }, create: [single, tail].filter(Boolean), delete: false };
  if (tail) return { update: { start_time: tail.start_time, end_time: tail.end_time }, create: [single], delete: false };
  return { update: null, create: [single], delete: true };
}
