'use strict';

/*
 * Fast UTC-instant -> local wall-clock conversion for bounded timeline walks.
 *
 * Intl.DateTimeFormat construction/formatting is expensive enough that doing it
 * once per minute blocks the Node event loop for more than a second over a
 * 14-day schedule horizon. UTC offsets can only change on 15-minute boundaries
 * in the IANA data we support, so resolve and memoize the offset per bucket,
 * then use ordinary UTC arithmetic for each minute.
 */
const MINUTE_MS = 60 * 1000;
const OFFSET_BUCKET_MS = 15 * MINUTE_MS;

function makeClock(timezone) {
  let formatter = null;
  if (timezone) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      });
    } catch (_) {
      formatter = null;
    }
  }

  const offsets = new Map();
  function offsetAt(ms) {
    const bucket = Math.floor(ms / OFFSET_BUCKET_MS) * OFFSET_BUCKET_MS;
    let offset = offsets.get(bucket);
    if (offset !== undefined) return offset;
    if (!formatter) {
      offset = -new Date(bucket).getTimezoneOffset() * MINUTE_MS;
    } else {
      const parts = {};
      for (const part of formatter.formatToParts(new Date(bucket))) parts[part.type] = part.value;
      const wall = Date.UTC(
        +parts.year,
        +parts.month - 1,
        +parts.day,
        (+parts.hour) % 24,
        +parts.minute,
        +parts.second,
      );
      offset = wall - bucket;
    }
    offsets.set(bucket, offset);
    return offset;
  }

  function partsAt(ms) {
    const local = new Date(ms + offsetAt(ms));
    return {
      y: local.getUTCFullYear(),
      mo: local.getUTCMonth() + 1,
      day: local.getUTCDate(),
      dow: local.getUTCDay(),
      min: local.getUTCHours() * 60 + local.getUTCMinutes(),
    };
  }

  partsAt.offsetAt = offsetAt;
  partsAt.zone = formatter ? timezone : null;
  return partsAt;
}

module.exports = { MINUTE_MS, OFFSET_BUCKET_MS, makeClock };
