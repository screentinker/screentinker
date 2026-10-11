' tz.brs — local wall-clock from the server-supplied UTC-offset table.
'
' Roku has no IANA time-zone database for arbitrary zones: roDateTime only knows the device's own
' setting, and the screen must follow the zone set in the dashboard. The server therefore sends
'
'   "tz_table": { "zone": "America/Chicago", "generated_ms": 1791725440000,
'                 "spans": [ { "from_ms": 1791700000000, "offset_min": -300 }, ... ] }
'
' Each span lasts until the next one's from_ms; the last is open-ended. Before the first span the
' first span's offset is used (best effort: the table always starts 24 h in the past).
'
' Three cases, and they are deliberately different:
'   - tzTable invalid / not an assocarray  -> NO TABLE (older server): the device's own zone,
'                                             via roDateTime.ToLocalTime().
'   - tzTable an assocarray whose spans are missing, empty or all malformed
'                                          -> UNUSABLE: the server could not resolve the zone.
'                                             ST_LocalParts returns invalid so every caller fails
'                                             SAFE (items play, the backlight stays on), exactly
'                                             like the JS evaluators do when Intl throws.
'   - a usable table                       -> pure integer civil-date math (Howard Hinnant's
'                                             days-from-civil / civil-from-days). roDateTime is
'                                             NOT used on this path.
'
' All instants are milliseconds since the epoch as LongInteger.

' ---------------------------------------------------------------------------------------------
' Public API (contract: docs/roku-player.md "Interfaces between the pieces")
' ---------------------------------------------------------------------------------------------

' UTC offset in minutes (east positive, e.g. Chicago CDT = -300) at utcMs.
' An unusable table yields 0 (callers that need to fail safe use ST_LocalParts, which says so).
function ST_TzOffsetMin(tzTable as object, utcMs as longinteger) as integer
    spans = ST_TzSpans(tzTable)
    if spans = invalid
        if ST_TzHasTable(tzTable) then return 0
        dp = ST_TzDeviceParts(utcMs)
        if dp = invalid then return 0
        return dp.offset_min
    end if
    return ST_TzSpanOffset(spans, utcMs)
end function

' Local wall-clock parts at utcMs:
'   { year, month, day, hour, minute, second, dow (0=Sun), ymd: "YYYY-MM-DD", hm: "HH:MM",
'     minuteOfDay, epochDay (local days since 1970-01-01), offset_min }
' invalid when the table is present but unusable (see header) — callers must fail safe.
function ST_LocalParts(tzTable as object, utcMs as longinteger) as object
    spans = ST_TzSpans(tzTable)
    if spans = invalid
        if ST_TzHasTable(tzTable) then return invalid
        return ST_TzDeviceParts(utcMs)
    end if
    off = ST_TzSpanOffset(spans, utcMs)
    return ST_TzPartsFromLocalMs(utcMs + off * 60000&, off)
end function

' ---------------------------------------------------------------------------------------------
' Helpers (ST_Tz*)
' ---------------------------------------------------------------------------------------------

function ST_TzHasTable(tzTable as dynamic) as boolean
    return LCase(type(tzTable)) = "roassociativearray"
end function

' Validated spans as an array of { from_ms: LongInteger, offset_min: Integer }, or invalid.
' Malformed entries are skipped; a table with no well-formed entry is unusable.
function ST_TzSpans(tzTable as dynamic) as dynamic
    if not ST_TzHasTable(tzTable) then return invalid
    raw = tzTable.spans
    if raw = invalid or GetInterface(raw, "ifArray") = invalid then return invalid
    out = []
    for each s in raw
        if s <> invalid and GetInterface(s, "ifAssociativeArray") <> invalid
            f = ST_TzToLong(s.from_ms)
            o = ST_TzToLong(s.offset_min)
            if f <> invalid and o <> invalid
                if o >= -1080 and o <= 1080 then out.Push({ from_ms: f, offset_min: ST_TzLongToInt(o) })
            end if
        end if
    end for
    if out.Count() = 0 then return invalid
    return out
end function

' Offset of the span covering utcMs: the one with the greatest from_ms <= utcMs (order-independent,
' though the server sends them sorted). Before every span -> the earliest span.
function ST_TzSpanOffset(spans as object, utcMs as longinteger) as integer
    best = invalid
    first = invalid
    for each s in spans
        if first = invalid or s.from_ms < first.from_ms then first = s
        if s.from_ms <= utcMs
            if best = invalid or s.from_ms >= best.from_ms then best = s
        end if
    end for
    if best = invalid then best = first
    return best.offset_min
end function

' The from_ms of the first span boundary strictly after utcMs, or invalid (last span open-ended).
function ST_TzNextTransitionMs(tzTable as object, utcMs as longinteger) as dynamic
    spans = ST_TzSpans(tzTable)
    if spans = invalid then return invalid
    nxt = invalid
    for each s in spans
        if s.from_ms > utcMs
            if nxt = invalid or s.from_ms < nxt then nxt = s.from_ms
        end if
    end for
    return nxt
end function

' Any JSON number (Integer, LongInteger, Float, Double) -> LongInteger; anything else -> invalid.
' Doubles are split so the conversion never passes through a 32-bit Integer.
function ST_TzToLong(v as dynamic) as dynamic
    if v = invalid then return invalid
    t = LCase(type(v))
    if t = "integer" or t = "roint" or t = "rointeger"
        return 0& + v
    else if t = "longinteger" or t = "rolonginteger"
        return 0& + v
    else if t = "double" or t = "rodouble" or t = "float" or t = "rofloat"
        d# = v
        if d# <> d# then return invalid ' NaN
        if d# > 9.0e15 or d# < -9.0e15 then return invalid
        hi% = Int(d# / 1000000#)
        lo# = d# - (hi% * 1000000#)
        return hi% * 1000000& + Int(lo# + 0.5#)
    end if
    return invalid
end function

function ST_TzLongToInt(v as dynamic) as integer
    i% = v
    return i%
end function

' Floor division / modulo for LongInteger (BrightScript's \ and Mod truncate toward zero).
function ST_TzFloorDiv(a as longinteger, b as longinteger) as longinteger
    q = a \ b
    if (a Mod b) <> 0 and ((a < 0) <> (b < 0)) then q = q - 1
    return q
end function

function ST_TzFloorMod(a as longinteger, b as longinteger) as longinteger
    return a - ST_TzFloorDiv(a, b) * b
end function

' Hinnant: days since 1970-01-01 -> { y, mo, d } (proleptic Gregorian).
function ST_TzCivilFromDays(days as longinteger) as object
    z = days + 719468&
    era = ST_TzFloorDiv(z, 146097&)
    doe = z - era * 146097&                                      ' [0, 146096]
    yoe = (doe - doe \ 1460 + doe \ 36524 - doe \ 146096) \ 365   ' [0, 399]
    y = yoe + era * 400
    doy = doe - (365 * yoe + yoe \ 4 - yoe \ 100)                 ' [0, 365]
    mp = (5 * doy + 2) \ 153                                      ' [0, 11]
    d = doy - (153 * mp + 2) \ 5 + 1                              ' [1, 31]
    if mp < 10 then mo = mp + 3 else mo = mp - 9                  ' [1, 12]
    if mo <= 2 then y = y + 1
    return { y: ST_TzLongToInt(y), mo: ST_TzLongToInt(mo), d: ST_TzLongToInt(d) }
end function

' Hinnant: { y, mo, d } -> days since 1970-01-01.
function ST_TzDaysFromCivil(y as integer, mo as integer, d as integer) as longinteger
    yy& = y
    if mo <= 2 then yy& = yy& - 1
    era = ST_TzFloorDiv(yy&, 400&)
    yoe = yy& - era * 400                                         ' [0, 399]
    if mo > 2 then mp = mo - 3 else mp = mo + 9
    doy = (153 * mp + 2) \ 5 + d - 1                              ' [0, 365]
    doe = yoe * 365 + yoe \ 4 - yoe \ 100 + doy                   ' [0, 146096]
    return era * 146097& + doe - 719468&
end function

function ST_TzPad2(n as integer) as string
    s = StrI(n).Trim()
    if n >= 0 and n < 10 then return "0" + s
    return s
end function

function ST_TzPad4(n as integer) as string
    s = StrI(n).Trim()
    while Len(s) < 4
        s = "0" + s
    end while
    return s
end function

function ST_TzYmd(y as integer, mo as integer, d as integer) as string
    return ST_TzPad4(y) + "-" + ST_TzPad2(mo) + "-" + ST_TzPad2(d)
end function

' Local wall-clock ms (UTC-like) -> parts. offsetMin is carried through for callers.
function ST_TzPartsFromLocalMs(localMs as longinteger, offsetMin as integer) as object
    days = ST_TzFloorDiv(localMs, 86400000&)
    msOfDay = localMs - days * 86400000&
    secOfDay% = ST_TzLongToInt(msOfDay \ 1000&)
    hour% = secOfDay% \ 3600
    minute% = (secOfDay% \ 60) Mod 60
    second% = secOfDay% Mod 60
    c = ST_TzCivilFromDays(days)
    dow% = ST_TzLongToInt(ST_TzFloorMod(days + 4&, 7&))   ' 1970-01-01 was a Thursday
    return {
        year: c.y, month: c.mo, day: c.d,
        hour: hour%, minute: minute%, second: second%,
        dow: dow%,
        ymd: ST_TzYmd(c.y, c.mo, c.d),
        hm: ST_TzPad2(hour%) + ":" + ST_TzPad2(minute%),
        minuteOfDay: hour% * 60 + minute%,
        epochDay: ST_TzLongToInt(days),
        offset_min: offsetMin
    }
end function

' NO TABLE: the device's own zone. roDateTime is fed an ISO string built with our own civil math
' so no LongInteger ever has to squeeze through FromSeconds(Integer).
function ST_TzDeviceParts(utcMs as longinteger) as object
    u = ST_TzPartsFromLocalMs(utcMs, 0)
    dt = CreateObject("roDateTime")
    if dt = invalid then return invalid
    dt.FromISO8601String(u.ymd + "T" + u.hm + ":" + ST_TzPad2(u.second) + "Z")
    dt.ToLocalTime()
    y% = dt.GetYear()
    mo% = dt.GetMonth()
    d% = dt.GetDayOfMonth()
    h% = dt.GetHours()
    mi% = dt.GetMinutes()
    s% = dt.GetSeconds()
    localDays = ST_TzDaysFromCivil(y%, mo%, d%)
    localSec = localDays * 86400& + h% * 3600 + mi% * 60 + s%
    utcSec = ST_TzFloorDiv(utcMs, 1000&)
    off% = ST_TzLongToInt(ST_TzFloorDiv(localSec - utcSec, 60&))
    return ST_TzPartsFromLocalMs(localSec * 1000& + (utcMs - utcSec * 1000&), off%)
end function
