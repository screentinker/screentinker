' queuechime.brs: the "Now serving" chime on a Roku (lib/queue/widget.js, docs/now-serving-queue.md).
'
' A Roku cannot run the queue widget's page: it shows a server-rendered still of it. So the page's
' own chime request never happens here, and the ZonePlayer showing a queue widget watches the queue
' itself (GET /api/widgets/<id>/queue.json, the same answer the page polls) and asks MainScene for a
' chime. Pure functions only, so the rules are tested in brs-node (roku/tests/run-vectors.js, cases
' cross-checked against the page's own queueWidgetStep in server/lib/queue/widget.js):
'
'   ST_QueueChimeConfig(widget_config)      the widget's chime switch and volume, cleaned like widgetConfig()
'   ST_QueueChimeNew()                      the state for one mount of the widget (one item on screen)
'   ST_QueueChimeStep(state, resp, flags)   one poll answer -> chime wanted or not (updates state)
'   ST_QueueChimeGate(lastMs, nowMs, flags) the screen-wide rules: blackout, follower, 3 s spacing
'
' ⚠️ NEVER ON THE FIRST ANSWER. A screen that reboots, or an item that comes round again in the
' playlist, must not announce a number that was called before it was on screen. call_seq only ever
' goes up (a new day does not reset it), so "a number was called" is exactly "call_seq changed
' since an answer this mount already saw".

' The chime gap: a burst of calls is one chime, never a run (same as the web player).
function ST_QueueChimeGapMs() as integer
    return 3000
end function

' How often a mounted queue widget is polled (the page's POLL_MS).
function ST_QueueChimePollSec() as integer
    return 4
end function

' { chime: boolean, volume: integer 0..100 }. Off unless the widget's config says chime: true
' (a real boolean, as widgetConfig() demands); volume 60 when missing or not a number, rounded and
' clamped to 0..100 otherwise.
function ST_QueueChimeConfig(c as dynamic) as object
    if ST_IsString(c) then c = ParseJson(c)
    out = { chime: false, volume: 60 }
    if not ST_IsAA(c) then return out
    out.chime = ST_QueueChimeIsTrueBool(c.chime)
    if c.DoesExist("chime_volume") then out.volume = ST_QueueChimeVolume(ST_QueueChimeJsNumber(c.chime_volume))
    return out
end function

' JavaScript's Number(v) for what a JSON config can hold, so the volume is cleaned exactly as the
' server's widgetConfig() cleans it: null, false and "" are 0, true is 1, a numeric string is its
' number, [] is 0 and [x] is Number(x) for a number or string x, anything else is invalid (NaN
' there, which means the default 60).
function ST_QueueChimeJsNumber(v as dynamic) as dynamic
    if v = invalid then return 0
    if type(v) = "Boolean" or type(v) = "roBoolean" then
        if v then return 1
        return 0
    end if
    if ST_QueueChimeIsNum(v) then return v
    if ST_IsString(v) then
        s = v.Trim()
        if s = "" then return 0
        re = CreateObject("roRegex", "^[+-]?([0-9]+[.]?[0-9]*|[.][0-9]+)([eE][+-]?[0-9]+)?$", "")
        if re.IsMatch(s) then return Val(s)
        return invalid
    end if
    if ST_IsArray(v) then
        if v.Count() = 0 then return 0
        if v.Count() = 1 and (v[0] = invalid or ST_IsString(v[0]) or ST_QueueChimeIsNum(v[0])) then return ST_QueueChimeJsNumber(v[0])
    end if
    return invalid
end function

' A number of any BrightScript numeric type, boxed or not.
function ST_QueueChimeIsNum(v as dynamic) as boolean
    if v = invalid then return false
    t = type(v)
    return t = "Integer" or t = "roInt" or t = "roInteger" or t = "LongInteger" or t = "roLongInteger" or t = "Float" or t = "roFloat" or t = "Double" or t = "roDouble"
end function

function ST_QueueChimeNew() as object
    return { primed: false, hasSeq: false, callSeq: 0#, rev: "", number: 0, sound: false }
end function

' One poll's answer. resp = the parsed JSON, or invalid when the poll failed in any way.
' flags = { chimeOn: the widget's chime switch, volume: 0..100, muted: the item is muted (its own
' flag or a live toggle) }. Returns { chime: boolean }; state is updated in place.
' A chime is wanted only when this mount already had an answer, call_seq changed, a number is being
' served, the staff switch (sound) is on, the widget's own chime is on, the volume is above 0 and
' the item is not muted. A failed poll and an {unchanged:true} answer change nothing.
function ST_QueueChimeStep(state as object, resp as dynamic, flags as object) as object
    out = { chime: false }
    if not ST_IsAA(resp) then return out
    if ST_QueueChimeIsTrueBool(resp.unchanged) then return out
    if not ST_QueueChimeIsNum(resp.now_serving) then return out
    state.rev = ST_Str(resp, "rev")
    n = resp.now_serving
    if n > 0 then state.number = Int(n) else state.number = 0
    state.sound = ST_QueueChimeIsTrueBool(resp.sound)
    if ST_QueueChimeIsNum(resp.call_seq) then
        seq# = 0# + resp.call_seq
        ' "changed": an earlier answer without call_seq counts as different (the page: undefined !== n)
        ' (Parenthesised on purpose: NOT's precedence against AND/OR is easy to misread.)
        changed = (not state.hasSeq) or (seq# <> state.callSeq)
        if state.primed and changed and state.number > 0 and state.sound and ST_IsAA(flags) then
            muted = ST_IsTrue(flags.muted)
            out.chime = ST_IsTrue(flags.chimeOn) and (not muted) and ST_QueueChimeIsNum(flags.volume) and (flags.volume > 0)
        end if
        state.callSeq = seq#
        state.hasSeq = true
    end if
    state.primed = true
    return out
end function

' The screen-wide rules, checked by MainScene for every request from any zone.
' lastMs = when the last chime played (-1 = never), flags = { blank, follower, held } where blank is
' a power window or screen_off, follower is a wall or sync-group follower, held is anything else
' that keeps the screen from playing (suspended, autoplay off and not started yet).
function ST_QueueChimeGate(lastMs as longinteger, nowMs as longinteger, flags as object) as boolean
    if ST_IsAA(flags) then
        if ST_IsTrue(flags.blank) or ST_IsTrue(flags.follower) or ST_IsTrue(flags.held) then return false
    end if
    if lastMs < 0 then return true
    return nowMs - lastMs >= ST_QueueChimeGapMs()
end function

' A volume as a SoundEffect node takes it: 0..100, the percentage of full volume.
function ST_QueueChimeVolume(v as dynamic) as integer
    if not ST_QueueChimeIsNum(v) then return 60
    r = Int(v + 0.5)
    if r < 0 then r = 0
    if r > 100 then r = 100
    return r
end function

' A wall tile or a sync-group member that is not the leader stays silent, as every other sound
' on a follower does (the web player's isWallFollower()). No block = not a follower.
function ST_QueueChimeFollower(payload as dynamic) as boolean
    if not ST_IsAA(payload) then return false
    for each k in ["wall_config", "group_sync"]
        b = payload[k]
        if ST_IsAA(b) and not ST_IsTrue(b.is_leader) then return true
    end for
    return false
end function

' true only for a real boolean true, as the page's `=== true` reads JSON.
function ST_QueueChimeIsTrueBool(v as dynamic) as boolean
    if v = invalid then return false
    if type(v) = "Boolean" or type(v) = "roBoolean" then return v
    return false
end function
