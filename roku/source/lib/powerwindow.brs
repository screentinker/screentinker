' powerwindow.brs — display power windows: when a screen's BACKLIGHT should be off.
'
' CONTRACT: shared/power-window-vectors.json. Port of server/lib/power-window.js (the evaluator
' that server/lib/device-power-schedule.js hands its { enabled, timezone, windows } shape to).
'
' Window = { days:[0-6 (0=Sun)], start:"HH:MM", end:"HH:MM"|"24:00" }
'   - windows OR together; >=1 match = off; ZERO windows = never off
'   - start > end crosses midnight; the DAY test anchors to the day the window STARTED
'   - start = end is inert (a zero-length window is not an instruction)
'
' ⚠️ FAILS TO **ON**, the opposite of schedule.brs: unusable tz table, malformed HH:MM, a windows
' list that is not a list -> the screen stays LIT, and one junk window never suppresses a good one.
'
' Zone: the windows are evaluated in tzTable. If the server sends a table alongside the schedule
' (powerSchedule.tz_table) it wins over the playlist's table. The schedule's own `timezone` is the
' zone it must be evaluated in; when it is set and the table describes a DIFFERENT zone (table.zone)
' the Roku cannot evaluate it — and server/lib/tz-table.js substitutes a UTC table for an unknown
' zone, so this is also how an unresolvable zone is detected — so the screen stays LIT.
' No table at all (older server) = the device's own zone, as everywhere else.
'
' next_edge_ms is the exact UTC instant of the next on/off flip within 8 days (advisory, like the
' JS nextEdge, but an instant rather than a local stamp because the table lets us convert back),
' or invalid when there is none (disabled, no windows, always on/off, fail-safe).

function ST_PowerState(powerSchedule as object, utcMs as longinteger, tzTable as object) as object
    res = { on: true, next_edge_ms: invalid }
    if powerSchedule = invalid or GetInterface(powerSchedule, "ifAssociativeArray") = invalid then return res
    en = powerSchedule.enabled
    if en <> invalid
        te = LCase(type(en))
        if te = "boolean" or te = "roboolean"
            if not en then return res                   ' JS: enabled === false only
        end if
    end if
    wins = ST_PwWindows(powerSchedule.windows)
    if wins = invalid then return res

    tbl = tzTable
    if ST_TzHasTable(powerSchedule.tz_table) then tbl = powerSchedule.tz_table
    if not ST_PwZoneMatches(powerSchedule.timezone, tbl) then return res

    L = ST_LocalParts(tbl, utcMs)
    if L = invalid then return res                      ' unresolvable zone -> lit
    off0 = ST_PwCovers(wins, L.dow, L.minuteOfDay)
    res.on = not off0
    res.next_edge_ms = ST_PwNextEdge(wins, utcMs, tbl, off0)
    return res
end function

' ---------------------------------------------------------------------------------------------
' Helpers (ST_Pw*)
' ---------------------------------------------------------------------------------------------

' false only when the schedule names a zone and the table names a different one.
function ST_PwZoneMatches(zone as dynamic, tbl as dynamic) as boolean
    if zone = invalid then return true
    tz = LCase(type(zone))
    if tz <> "string" and tz <> "rostring" then return true
    if zone = "" then return true
    if not ST_TzHasTable(tbl) then return true          ' device zone: nothing to compare against
    tblZone = tbl.zone
    if tblZone = invalid then return true
    tt = LCase(type(tblZone))
    if tt <> "string" and tt <> "rostring" then return true
    if tblZone = "" then return true
    return tblZone = zone
end function

' The well-formed windows as [{ s, e, days[] of 0-6 }], or invalid when the list is unusable
' (not a list / empty = never off). Malformed windows are dropped, i.e. inert.
function ST_PwWindows(windows as dynamic) as dynamic
    if windows = invalid or GetInterface(windows, "ifArray") = invalid then return invalid
    if windows.Count() = 0 then return invalid
    out = []
    for each w in windows
        if w <> invalid and GetInterface(w, "ifAssociativeArray") <> invalid
            s = ST_PwHm(w.start)
            e = ST_PwHm(w.end)
            if s >= 0 and e >= 0 and s <> e
                out.Push({ s: s, e: e, days: ST_PwDays(w.days) })
            end if
        end if
    end for
    return out   ' may be empty: a list of junk is "never off", but still a list
end function

' /^([01]\d|2[0-4]):([0-5]\d)$/ and <= 1440, else -1 ("24:30" is not a time).
function ST_PwHm(v as dynamic) as integer
    if v = invalid then return -1
    t = LCase(type(v))
    if t <> "string" and t <> "rostring" then return -1
    if Len(v) <> 5 or Mid(v, 3, 1) <> ":" then return -1
    for each i in [1, 2, 4, 5]
        c = Mid(v, i, 1)
        if c < "0" or c > "9" then return -1
    end for
    h1 = Mid(v, 1, 1)
    h2 = Mid(v, 2, 1)
    if h1 = "2"
        if h2 > "4" then return -1
    else if h1 <> "0" and h1 <> "1"
        return -1
    end if
    if Mid(v, 4, 1) > "5" then return -1
    mins = Val(Mid(v, 1, 2)) * 60 + Val(Mid(v, 4, 2))
    if mins > 1440 then return -1
    return Int(mins)
end function

' JS dayListed: `+days[i] === dow` — so numbers, numeric strings, booleans and null coerce.
' Returns a 7-slot boolean array (index = dow).
function ST_PwDays(days as dynamic) as object
    flags = [false, false, false, false, false, false, false]
    if days = invalid then return flags
    items = invalid
    if GetInterface(days, "ifArray") <> invalid
        items = days
    else if LCase(type(days)) = "string" or LCase(type(days)) = "rostring"
        items = []
        for i = 1 to Len(days)
            items.Push(Mid(days, i, 1))
        end for
    else
        return flags
    end if
    for each d in items
        n = ST_PwPlus(d)
        if n >= 0 and n <= 6 then flags[n] = true
    end for
    return flags
end function

' JS unary + for JSON values, restricted to what can equal a weekday; -1 = no weekday.
function ST_PwPlus(d as dynamic) as integer
    if d = invalid then return 0                         ' +null === 0
    t = LCase(type(d))
    if t = "boolean" or t = "roboolean"
        if d then return 1
        return 0
    end if
    if t = "string" or t = "rostring"
        s = d.Trim()
        if s = "" then return 0
        if Len(s) <> 1 or s < "0" or s > "9" then
            ' multi-char numeric strings like "01" or "1.0" still coerce in JS
            for i = 1 to Len(s)
                c = Mid(s, i, 1)
                if (c < "0" or c > "9") and c <> "." then return -1
            end for
            v = Val(s)
            if v = Int(v) and v >= 0 and v <= 6 then return Int(v)
            return -1
        end if
        return s.ToInt()
    end if
    if t = "integer" or t = "roint" or t = "rointeger" or t = "longinteger" or t = "rolonginteger" or t = "float" or t = "rofloat" or t = "double" or t = "rodouble"
        if d >= 0 and d <= 6 and d = Int(d) then return Int(d)
    end if
    return -1
end function

function ST_PwCoversOne(w as object, dow as integer, minute as integer) as boolean
    if w.s < w.e
        return w.days[dow] and minute >= w.s and minute < w.e
    end if
    ' overnight: tail of the start day, head of the next day (anchored to yesterday)
    if minute >= w.s then return w.days[dow]
    if minute < w.e then return w.days[(dow + 6) Mod 7]
    return false
end function

function ST_PwCovers(wins as object, dow as integer, minute as integer) as boolean
    for each w in wins
        if ST_PwCoversOne(w, dow, minute) then return true
    end for
    return false
end function

function ST_PwOffAt(wins as object, utcMs as longinteger, tbl as object) as dynamic
    L = ST_LocalParts(tbl, utcMs)
    if L = invalid then return invalid
    return ST_PwCovers(wins, L.dow, L.minuteOfDay)
end function

' Minutes from minuteOfDay to the next local minute at which some window can start or stop
' covering (a window boundary, or midnight when the day-of-week changes). Always >= 1.
function ST_PwMinutesToBoundary(wins as object, minuteOfDay as integer) as integer
    best = 1440 - minuteOfDay
    for each w in wins
        for each b in [w.s, w.e]
            if b > minuteOfDay and b - minuteOfDay < best then best = b - minuteOfDay
        end for
    end for
    if best < 1 then best = 1
    return best
end function

' First UTC minute after utcMs at which the state differs from off0, within 8 days.
' Jumps from boundary to boundary in LOCAL time; a jump that crosses a UTC-offset change is cut
' at the change (found by bisection, so it also works on the device-zone fallback with no table).
function ST_PwNextEdge(wins as object, utcMs as longinteger, tbl as object, off0 as boolean) as dynamic
    if wins.Count() = 0 then return invalid
    limit = utcMs + 8& * 1440& * 60000&
    t = utcMs - ST_TzFloorMod(utcMs, 60000&)           ' start of the current UTC minute
    guard = 0
    while guard < 4000
        guard = guard + 1
        L = ST_LocalParts(tbl, t)
        if L = invalid then return invalid
        tn = t + ST_PwMinutesToBoundary(wins, L.minuteOfDay) * 60000&
        offT = L.offset_min
        if ST_TzOffsetMin(tbl, tn) <> offT
            ' bisect on the minute grid for the first minute whose offset differs from offT
            lo = t
            hi = tn
            while hi - lo > 60000&
                mid = lo + ST_TzFloorDiv((hi - lo) \ 60000&, 2&) * 60000&
                if ST_TzOffsetMin(tbl, mid) <> offT then hi = mid else lo = mid
            end while
            tn = hi
        end if
        if tn > limit then return invalid
        o = ST_PwOffAt(wins, tn, tbl)
        if o = invalid then return invalid
        if o <> off0 then return tn
        t = tn
    end while
    return invalid
end function
