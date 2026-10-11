' Vector test runner for the pure libraries (tz, schedule, powerwindow, playorder).
'
' Reads pkg:/fixture.json, written by roku/tests/run-vectors.js, and prints one line per failure
' plus a COUNT line per vector file:
'   FAIL <file> | <id> | <detail>
'   COUNT <file> | <pass> | <fail>
'   DONE <cases>
' The node script parses these lines; run it rather than this file directly.

sub Main()
    raw = ReadAsciiFile("pkg:/fixture.json")
    fx = ParseJson(raw)
    if fx = invalid
        print "FATAL fixture.json missing or not JSON"
        return
    end if
    counts = {}
    order = []
    n = 0
    for each c in fx.cases
        n = n + 1
        detail = TST_RunCase(c)
        f = c.file
        if not counts.DoesExist(f)
            counts[f] = { pass: 0, fail: 0 }
            order.Push(f)
        end if
        if detail = ""
            counts[f].pass = counts[f].pass + 1
        else
            counts[f].fail = counts[f].fail + 1
            print "FAIL " + f + " | " + TST_S(c.id) + " | " + detail
        end if
    end for
    for each f in order
        print "COUNT " + f + " | " + StrI(counts[f].pass).Trim() + " | " + StrI(counts[f].fail).Trim()
    end for
    print "DONE " + StrI(n).Trim()
end sub

' "" = pass, else a description of the mismatch.
function TST_RunCase(c as object) as string
    k = c.kind
    if k = "localparts" then return TST_LocalParts(c)
    if k = "schedule" then return TST_Schedule(c)
    if k = "power" then return TST_Power(c)
    if k = "playorder" then return TST_PlayOrder(c)
    return "unknown case kind " + TST_S(k)
end function

function TST_S(v as dynamic) as string
    if v = invalid then return "null"
    t = LCase(type(v))
    if t = "string" or t = "rostring" then return v
    if t = "boolean" or t = "roboolean"
        if v then return "true"
        return "false"
    end if
    if t = "integer" or t = "roint" or t = "rointeger" or t = "longinteger" or t = "rolonginteger" then return v.ToStr()
    if t = "float" or t = "rofloat" or t = "double" or t = "rodouble" then return Str(v).Trim()
    if t = "roarray"
        s = "["
        for i = 0 to v.Count() - 1
            if i > 0 then s = s + ","
            s = s + TST_S(v[i])
        end for
        return s + "]"
    end if
    return "<" + type(v) + ">"
end function

function TST_Long(v as dynamic) as longinteger
    x& = 0& + v
    return x&
end function

function TST_LocalParts(c as object) as string
    ms = TST_Long(c.utc_ms)
    p = ST_LocalParts(c.tz_table, ms)
    if p = invalid then return "ST_LocalParts returned invalid"
    e = c.expect
    bad = ""
    for each key in ["year", "month", "day", "hour", "minute", "second", "dow", "ymd", "hm", "minuteOfDay"]
        if TST_S(p[key]) <> TST_S(e[key]) then bad = bad + key + "=" + TST_S(p[key]) + " want " + TST_S(e[key]) + "; "
    end for
    off = ST_TzOffsetMin(c.tz_table, ms)
    if off <> e.offset_min then bad = bad + "offset=" + StrI(off).Trim() + " want " + TST_S(e.offset_min) + "; "
    if p.offset_min <> e.offset_min then bad = bad + "parts.offset_min=" + TST_S(p.offset_min) + "; "
    return bad
end function

function TST_Schedule(c as object) as string
    got = ST_ItemScheduleActive(c.item, TST_Long(c.utc_ms), c.tz_table)
    if got <> c.expect then return "active=" + TST_S(got) + " want " + TST_S(c.expect)
    return ""
end function

function TST_Power(c as object) as string
    r = ST_PowerState(c.schedule, TST_Long(c.utc_ms), c.tz_table)
    bad = ""
    if r.on <> c.expect.on then bad = bad + "on=" + TST_S(r.on) + " want " + TST_S(c.expect.on) + "; "
    if c.check_edge = true
        want = c.expect.next_edge_ms
        if want = invalid
            if r.next_edge_ms <> invalid then bad = bad + "next_edge_ms=" + TST_S(r.next_edge_ms) + " want null; "
        else if r.next_edge_ms = invalid
            bad = bad + "next_edge_ms=null want " + TST_S(want) + "; "
        else if r.next_edge_ms <> TST_Long(want)
            bad = bad + "next_edge_ms=" + TST_S(r.next_edge_ms) + " want " + TST_S(want) + "; "
        end if
    end if
    return bad
end function

' Park-Miller minimal standard LCG — the run-vectors.js twin produces the same doubles.
function TST_Lcg(seed as dynamic) as object
    return {
        s: TST_Long(seed),
        next: function() as double
            m.s = (m.s * 48271&) Mod 2147483647&
            return CDbl(m.s) / 2147483647#
        end function
    }
end function

function TST_PlayOrder(c as object) as string
    st = ST_PlayOrderNew()
    st.rnd = TST_Lcg(c.seed)
    fromIdx = -1
    got = []
    for each allows in c.steps
        idx = ST_PlayOrderNext(c.items, fromIdx, allows, c.mode, st)
        got.Push(idx)
        if idx >= 0 then fromIdx = idx
    end for
    if TST_S(got) <> TST_S(c.expect) then return "got " + TST_S(got) + " want " + TST_S(c.expect)
    ' weightOf parity
    if c.weights <> invalid
        for i = 0 to c.items.Count() - 1
            w = ST_PlayOrderWeightOf(c.items[i])
            if w <> c.weights[i] then return "weightOf(" + StrI(i).Trim() + ")=" + StrI(w).Trim() + " want " + TST_S(c.weights[i])
        end for
    end if
    return ""
end function
