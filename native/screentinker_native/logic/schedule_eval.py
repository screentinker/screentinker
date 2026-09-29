"""Canonical per-playlist-item schedule evaluator (#74 dayparting + #75 expiry + play window).

Python port of server/lib/schedule-eval.js (Kotlin: player/ScheduleEval.kt).

CONTRACT: shared/schedule-vectors.json. If this disagrees with a vector, this is wrong.

Time model: instants are UTC; schedule blocks AND play windows are LOCAL wall-clock rules. Take
utc_now, convert to device-local wall-clock via the IANA zone (DST handled by zoneinfo), then
test. Blocks and windows are never stored or transmitted in UTC — that would break across DST and
zone changes.

Block = {days:[0-6 (0=Sun)], start:"HH:MM", end:"HH:MM"|"24:00",
         start_date:"YYYY-MM-DD"|None, end_date:"YYYY-MM-DD"|None}
  - within a block: day AND date AND time must all pass; blocks OR together
  - zero blocks = always active (the "no schedule = always plays" fallback)
  - time window is [start, end): start inclusive, end exclusive ("24:00" = end of day)
  - start > end crosses midnight; the day/date test anchors to the day the window STARTED
    (a Fri 22:00-02:00 block is active Sat 01:00).

Play window (item.play_from / item.play_until) = local "YYYY-MM-DDTHH:MM", nullable on each side,
inclusive on both ends at minute resolution. An INTERVAL, not a daypart: 3am inside the span
plays. AND'd with blocks. Empty / omitted = no extra gate.

FAILS OPEN: an exception (bad timezone id, malformed stamp) returns True so the item PLAYS. A blank
screen is worse than an over-running promo. (⚠️ power_window.py fails the OTHER way, on purpose.)

`utc_now` may be epoch milliseconds, an ISO-8601 string, or an aware datetime.
"""
from __future__ import annotations

import math
import re
from datetime import date, timedelta
from zoneinfo import ZoneInfo

from . import _jscompat as js
from ._jscompat import UNDEFINED

# [0-9] not \d (Python's \d matches non-ASCII digits) and fullmatch, not `$` (which in Python
# also matches before a trailing newline).
STAMP_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]")


def local_parts(utc_now, iana_tz):
    """UTC instant -> device-local dict {y, mo(1-12), day, dow(0-6, 0=Sun), min(0-1439)}.

    iana_tz falsy -> trust the runtime's own local clock as-is (the device's OS time).
    Raises on an unknown zone or an unparseable instant.
    """
    d = js.to_instant(utc_now)
    local = d.astimezone(ZoneInfo(iana_tz)) if iana_tz else d.astimezone()
    return {
        "y": local.year, "mo": local.month, "day": local.day,
        "dow": local.isoweekday() % 7,  # Mon=1..Sun=7 -> Sun=0..Sat=6
        "min": local.hour * 60 + local.minute,
    }


def _hm(s) -> float:
    # JS: (+a[0]) * 60 + (+a[1]). A malformed time is NaN, NOT an exception — every comparison
    # against NaN is false, so a junk block simply never matches (it does not fail open).
    a = js.string(s).split(":")
    h = js.number(a[0])
    m = js.number(a[1]) if len(a) > 1 else math.nan
    return h * 60 + m  # "24:00" -> 1440


def _ymd(y, mo, day) -> str:
    return "%d-%02d-%02d" % (y, mo, day)


def _day_ok(dow, days) -> bool:
    if not days:
        return False
    for d in days:
        # JS strict equality: a bool or a string "1" never equals the number 1.
        if isinstance(d, (int, float)) and not isinstance(d, bool) and d == dow:
            return True
    return False


def _date_ok(date_str, start_date, end_date) -> bool:
    if js.truthy(start_date) and date_str < start_date:  # ISO YYYY-MM-DD sorts lexicographically
        return False
    if js.truthy(end_date) and date_str > end_date:  # inclusive on both ends
        return False
    return True


def block_matches(b, L) -> bool:
    s, e, now = _hm(b.get("start")), _hm(b.get("end")), L["min"]
    days, sd, ed = b.get("days"), b.get("start_date"), b.get("end_date")
    if s <= e:
        # same-day window [s, e), anchored to today
        if now < s or now >= e:
            return False
        return _day_ok(L["dow"], days) and _date_ok(_ymd(L["y"], L["mo"], L["day"]), sd, ed)
    # overnight wrap
    if now >= s:
        # before-midnight portion: anchor = today
        return _day_ok(L["dow"], days) and _date_ok(_ymd(L["y"], L["mo"], L["day"]), sd, ed)
    if now < e:
        # after-midnight portion: anchor = the day it started = yesterday (device-local)
        y = date(L["y"], L["mo"], L["day"]) - timedelta(days=1)
        return _day_ok((L["dow"] + 6) % 7, days) and _date_ok(_ymd(y.year, y.month, y.day), sd, ed)
    return False  # also reached when s or e is NaN


def _stamp_of(L) -> str:
    return _ymd(L["y"], L["mo"], L["day"]) + "T%02d:%02d" % (L["min"] // 60, L["min"] % 60)


def window_of(item):
    """Pull a play window off a playlist item (or a {play_from, play_until} dict).
    Empty / missing on both sides -> None (no extra gate)."""
    if not item:
        return None
    frm = item.get("play_from") or None
    until = item.get("play_until") or None
    if not frm and not until:
        return None
    return {"play_from": frm, "play_until": until}


def _interval_ok(window, L) -> bool:
    if not window:
        return True
    frm = window.get("play_from") or None
    until = window.get("play_until") or None
    if not frm and not until:
        return True
    if frm and not (isinstance(frm, str) and STAMP_RE.fullmatch(frm)):
        raise ValueError("bad play_from")
    if until and not (isinstance(until, str) and STAMP_RE.fullmatch(until)):
        raise ValueError("bad play_until")
    now = _stamp_of(L)
    if frm and now < frm:
        return False
    if until and now > until:  # inclusive at the minute
        return False
    return True


def _get_path(obj, path):
    if obj is None or obj is UNDEFINED:
        return UNDEFINED
    cur = obj
    for part in js.string(path if js.truthy(path) else "").split("."):
        if not part:
            continue
        if isinstance(cur, dict):
            cur = cur.get(part, UNDEFINED)
        elif isinstance(cur, list):  # JS arrays are objects: a["0"] works
            cur = cur[int(part)] if part.isdigit() and int(part) < len(cur) else UNDEFINED
        else:
            return UNDEFINED
    return cur


def _compare_op(lhs, op, rhs) -> bool:
    if op in ("truthy", "has"):
        return js.truthy(lhs) and lhs != ""
    if op == "eq":
        return js.string(lhs) == js.string(rhs)
    if op == "neq":
        return js.string(lhs) != js.string(rhs)
    ln, rn = js.number(lhs), js.number(rhs)
    if not js.is_finite(ln) or not js.is_finite(rn):
        return True
    if op == "gt":
        return ln > rn
    if op == "gte":
        return ln >= rn
    if op == "lt":
        return ln < rn
    if op == "lte":
        return ln <= rn
    return True


def condition_ok(when, data=UNDEFINED, item=None) -> bool:
    """play_when:
      {type:'ds', slug, path, op, value}  — data-source bag (type optional = ds)
      {type:'tag', op:'has'|'lacks', value} — content tags on the item
      {type:'meta', path, op, value} — content meta key=value on the item
    Missing/unknown op fails OPEN (plays). Tag/meta never consult the DS bag... except as the JS
    fallback when the item carries none. A missing DS bag plays for EVERY op, incl. truthy.
    """
    if not when:
        return True
    typ = when.get("type") or "ds"
    if typ == "tag":
        tags = None
        for src in (item, data):
            if js.truthy(src) and isinstance(src, dict) and js.truthy(src.get("tags", UNDEFINED)):
                tags = src["tags"]
                break
        tags = tags or []
        want = js.string(when.get("value") or "").lower()
        has = any(js.string(t).lower() == want for t in tags)
        return (not has) if when.get("op") == "lacks" else has
    if typ == "meta":
        meta = None
        for src in (item, data):
            if js.truthy(src) and isinstance(src, dict) and js.truthy(src.get("meta", UNDEFINED)):
                meta = src["meta"]
                break
        if meta is None:
            meta = {}
        return _compare_op(_get_path(meta, when.get("path")), when.get("op") or "eq",
                           when.get("value", UNDEFINED))
    op = when.get("op") or "eq"
    # Fail-open guard runs BEFORE every operator (a `truthy` evaluated first used to blank the
    # item until the source first loaded).
    if data is None or data is UNDEFINED:
        return True
    return _compare_op(_get_path(data, when.get("path")), op, when.get("value", UNDEFINED))


def is_item_active_now(blocks, utc_now, iana_tz, window=None) -> bool:
    try:
        L = local_parts(utc_now, iana_tz)
        if not _interval_ok(window, L):
            return False
        if not blocks:
            return True
        return any(block_matches(b, L) for b in blocks)
    except Exception:
        return True  # FAIL OPEN


def item_should_play(item, utc_now, iana_tz) -> bool:
    """The one gate players call: enabled AND window AND daypart AND play_when.
    enabled == 0/False never fails open (the operator said skip). Eval errors still play."""
    try:
        if not item:
            return True
        en = item.get("enabled")
        if isinstance(en, (int, float)) and en == 0:  # 0, 0.0 or False (JS: === 0 || === false)
            return False
        if not is_item_active_now(item.get("schedules"), utc_now, iana_tz, window_of(item)):
            return False
        return condition_ok(item.get("play_when"), item.get("_ds", UNDEFINED), item)
    except Exception:
        return True
