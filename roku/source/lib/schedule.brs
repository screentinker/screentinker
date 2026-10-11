' schedule.brs — per-playlist-item schedule evaluation (#74 dayparting + #75 expiry + play window).
'
' CONTRACT: shared/schedule-vectors.json. Port of tizen/js/schedule-eval.js (== server/lib/
' schedule-eval.js), function for function; if this disagrees with a vector, this is wrong.
'
' Block = { days:[0-6 (0=Sun)], start:"HH:MM", end:"HH:MM"|"24:00",
'           start_date:"YYYY-MM-DD"|null, end_date:"YYYY-MM-DD"|null }
'   - within a block: day AND date AND time; blocks OR together; zero blocks = always active
'   - [start, end); start > end crosses midnight and the day/date test anchors to the START day
' Play window = item.play_from / item.play_until, local "YYYY-MM-DDTHH:MM", inclusive at the
'   minute, an INTERVAL (not a daypart), AND'd with the blocks.
'
' FAILS OPEN: where the JS throws (malformed play-window stamp, null block entry, unresolvable
' zone = unusable tz table) this returns TRUE so the item PLAYS.
'
' Scope: exactly isItemActiveNow(item.schedules, now, tz, windowOf(item)). `enabled` and
' `play_when` are the caller's business (itemShouldPlay in the JS), as they are not schedules.

function ST_ItemScheduleActive(item as object, utcMs as longinteger, tzTable as object) as boolean
    L = ST_LocalParts(tzTable, utcMs)
    if L = invalid then return true                       ' unresolvable zone -> plays

    if item = invalid or GetInterface(item, "ifAssociativeArray") = invalid then return true

    ' Play window (JS windowOf + intervalOk). A malformed stamp "throws" -> plays.
    pf = ST_SchedFalsyToInvalid(item.play_from)
    pu = ST_SchedFalsyToInvalid(item.play_until)
    if pf <> invalid or pu <> invalid
        if pf <> invalid and not ST_SchedIsStamp(pf) then return true
        if pu <> invalid and not ST_SchedIsStamp(pu) then return true
        nowStamp = L.ymd + "T" + L.hm
        if pf <> invalid and nowStamp < pf then return false
        if pu <> invalid and nowStamp > pu then return false   ' inclusive at the minute
    end if

    blocks = item.schedules
    if ST_SchedFalsyToInvalid(blocks) = invalid then return true          ' no schedule
    if GetInterface(blocks, "ifArray") = invalid then return false        ' JS: length undefined
    if blocks.Count() = 0 then return true
    for each b in blocks
        if b = invalid then return true                  ' JS: null.start throws -> fails open
        if GetInterface(b, "ifAssociativeArray") <> invalid
            if ST_SchedBlockMatches(b, L) then return true
        end if
    end for
    return false
end function

' ---------------------------------------------------------------------------------------------
' Helpers (ST_Sched*)
' ---------------------------------------------------------------------------------------------

' JS truthiness for the values JSON can carry: invalid, "", false, 0 -> invalid; else the value.
function ST_SchedFalsyToInvalid(v as dynamic) as dynamic
    if v = invalid then return invalid
    t = LCase(type(v))
    if t = "string" or t = "rostring"
        if v = "" then return invalid
    else if t = "boolean" or t = "roboolean"
        if not v then return invalid
    else if ST_SchedIsNum(v)
        if v = 0 then return invalid
    end if
    return v
end function

function ST_SchedIsNum(v as dynamic) as boolean
    if v = invalid then return false
    t = LCase(type(v))
    return t = "integer" or t = "roint" or t = "rointeger" or t = "longinteger" or t = "rolonginteger" or t = "float" or t = "rofloat" or t = "double" or t = "rodouble"
end function

function ST_SchedIsStr(v as dynamic) as boolean
    if v = invalid then return false
    t = LCase(type(v))
    return t = "string" or t = "rostring"
end function

function ST_SchedIsDigit(c as string) as boolean
    return c >= "0" and c <= "9"
end function

' /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/
function ST_SchedIsStamp(v as dynamic) as boolean
    if not ST_SchedIsStr(v) then return false
    if Len(v) <> 16 then return false
    for i = 1 to 16
        c = Mid(v, i, 1)
        if i = 5 or i = 8
            if c <> "-" then return false
        else if i = 11
            if c <> "T" then return false
        else if i = 14
            if c <> ":" then return false
        else if not ST_SchedIsDigit(c)
            return false
        end if
    end for
    h1 = Mid(v, 12, 1)
    h2 = Mid(v, 13, 1)
    if h1 = "2"
        if h2 > "3" then return false
    else if h1 <> "0" and h1 <> "1"
        return false
    end if
    if Mid(v, 15, 1) > "5" then return false
    return true
end function

' JS: +part for one side of "HH:MM" — trimmed; "" -> 0; digits -> value; else NaN (-1 here).
function ST_SchedNumPart(s as string) as integer
    t = s.Trim()
    if t = "" then return 0
    for i = 1 to Len(t)
        if not ST_SchedIsDigit(Mid(t, i, 1)) then return -1
    end for
    if Len(t) > 6 then return -1
    return t.ToInt()
end function

' JS hm(): String(s).split(':'); (+a[0])*60 + (+a[1]). "24:00" -> 1440. NaN -> -1.
' No range check, faithfully (the JS has none either).
function ST_SchedHm(v as dynamic) as integer
    if not ST_SchedIsStr(v) then return -1
    parts = v.Split(":")
    if parts.Count() < 2 then return -1
    h = ST_SchedNumPart(parts[0])
    mi = ST_SchedNumPart(parts[1])
    if h < 0 or mi < 0 then return -1
    return h * 60 + mi
end function

function ST_SchedDayOk(dow as integer, days as dynamic) as boolean
    if days = invalid or GetInterface(days, "ifArray") = invalid then return false
    for each d in days
        if ST_SchedIsNum(d)
            if d = dow then return true                  ' JS === on numbers
        end if
    end for
    return false
end function

' ISO YYYY-MM-DD sorts lexicographically; inclusive on both ends; non-string/empty = no bound.
function ST_SchedDateOk(dateStr as string, startDate as dynamic, endDate as dynamic) as boolean
    if ST_SchedIsStr(startDate)
        if startDate <> "" and dateStr < startDate then return false
    end if
    if ST_SchedIsStr(endDate)
        if endDate <> "" and dateStr > endDate then return false
    end if
    return true
end function

function ST_SchedBlockMatches(b as object, L as object) as boolean
    s = ST_SchedHm(b.start)
    e = ST_SchedHm(b.end)
    now = L.minuteOfDay
    sOk = s >= 0
    eOk = e >= 0
    if sOk and eOk and s <= e
        ' same-day window [s, e), anchored to today
        if now < s or now >= e then return false
        return ST_SchedDayOk(L.dow, b.days) and ST_SchedDateOk(L.ymd, b.start_date, b.end_date)
    end if
    ' overnight wrap (or a NaN side, which the JS also lands here with)
    if sOk and now >= s
        ' before-midnight portion: anchor = today
        return ST_SchedDayOk(L.dow, b.days) and ST_SchedDateOk(L.ymd, b.start_date, b.end_date)
    end if
    if eOk and now < e
        ' after-midnight portion: anchor = the day it started = yesterday (local)
        y = ST_TzCivilFromDays(L.epochDay - 1&)
        return ST_SchedDayOk((L.dow + 6) Mod 7, b.days) and ST_SchedDateOk(ST_TzYmd(y.y, y.mo, y.d), b.start_date, b.end_date)
    end if
    return false
end function
