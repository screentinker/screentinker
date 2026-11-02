(function (root) {
  'use strict';
  /*
   * Fallback for packages written before the complete UTC offline plan existed.
   * Keep its recurrence verdict identical to server/services/scheduler.js: a
   * midnight-spanning recurrence belongs to its start date, not to the local
   * date after midnight. The full plan remains the authoritative offline path.
   */
  function pad(n) { return ('0' + n).slice(-2); }
  function offsetAt(spans, now) {
    var offset = spans[0].offset_min, i;
    for (i = 1; i < spans.length && now >= spans[i].from_ms; i++) offset = spans[i].offset_min;
    return Number(offset) || 0;
  }
  function localParts(now, spans) {
    var d = new Date(now + offsetAt(spans, now) * 60000);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, day: d.getUTCDate(), dow: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
  }
  function dateStamp(p) { return p.y + '-' + pad(p.mo) + '-' + pad(p.day); }
  function ordinal(p) { return Math.floor(Date.UTC(p.y, p.mo - 1, p.day) / 86400000); }
  function shiftDate(p, days) {
    var d = new Date(Date.UTC(p.y, p.mo - 1, p.day + days));
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, day: d.getUTCDate(), dow: d.getUTCDay(), min: p.min };
  }
  function parseDate(stamp) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(stamp || '')), d;
    if (!m) return null;
    d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
    return { y: +m[1], mo: +m[2], day: +m[3], dow: d.getUTCDay(), min: 0 };
  }
  function minutes(stamp) {
    var m = /T(\d{2}):(\d{2})/.exec(String(stamp || ''));
    return m ? +m[1] * 60 + +m[2] : -1;
  }
  function ruleOf(raw) {
    var rule = {}, parts = String(raw || '').split(';'), pair, i, map = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
    for (i = 0; i < parts.length; i++) { pair = parts[i].split('='); rule[pair[0]] = pair[1]; }
    if (!rule.FREQ) return null;
    rule.interval = Math.max(1, parseInt(rule.INTERVAL, 10) || 1);
    rule.days = rule.BYDAY ? rule.BYDAY.split(',').map(function (v) { return map[v]; }).filter(function (v) { return typeof v === 'number'; }) : null;
    return rule;
  }
  function anchorFor(local, startMin, endMin) {
    if (startMin === endMin) return null;
    if (endMin > startMin) return local.min >= startMin && local.min < endMin ? local : null;
    if (local.min >= startMin) return local;
    if (local.min < endMin) return shiftDate(local, -1);
    return null;
  }
  function recurrenceFires(rule, anchor, start) {
    var anchorDay = ordinal(anchor), startDay = ordinal(start), months, wanted, anchorWeek, startWeek;
    if (anchorDay < startDay) return false;
    if (rule.FREQ === 'DAILY') return (anchorDay - startDay) % rule.interval === 0;
    if (rule.FREQ === 'WEEKLY') {
      wanted = rule.days && rule.days.length ? rule.days : [start.dow];
      if (wanted.indexOf(anchor.dow) < 0) return false;
      anchorWeek = anchorDay - anchor.dow; startWeek = startDay - start.dow;
      return Math.floor((anchorWeek - startWeek) / 7) % rule.interval === 0;
    }
    if (rule.FREQ === 'MONTHLY') {
      if (anchor.day !== start.day) return false;
      months = (anchor.y - start.y) * 12 + anchor.mo - start.mo;
      return months >= 0 && months % rule.interval === 0;
    }
    return false;
  }
  function active(meta, now) {
    var s, spans, local, stamp, start, end, rule, anchor, endDate;
    if (!meta || !meta.schedule) return true;
    s = meta.schedule; spans = meta.table && meta.table.spans;
    if (!spans || !spans.length) return false;
    if (meta.table.generated_ms && now > meta.table.generated_ms + 72 * 3600000) return false;
    local = localParts(now, spans);
    stamp = dateStamp(local) + 'T' + pad(Math.floor(local.min / 60)) + ':' + pad(local.min % 60);
    start = String(s.start_time).slice(0, 16); end = String(s.end_time).slice(0, 16);
    if (!s.recurrence || !(rule = ruleOf(s.recurrence))) return stamp >= start && stamp < end;
    start = parseDate(start);
    if (!start) return false;
    anchor = anchorFor(local, minutes(s.start_time), minutes(s.end_time));
    if (!anchor || dateStamp(anchor) < dateStamp(start)) return false;
    if (s.recurrence_end) {
      endDate = String(s.recurrence_end).slice(0, 10);
      if (dateStamp(anchor) > endDate) return false;
    }
    return recurrenceFires(rule, anchor, start);
  }
  root.STOfflineSchedule = { active: active };
})(typeof window !== 'undefined' ? window : this);
