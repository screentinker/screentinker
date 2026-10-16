' ZonePlayer — plays one zone's items.
'
' ⚠️ EVERY ASYNC CALLBACK IS CHECKED AGAINST m.gen. A poster that finishes loading, a raster that
' arrives, a video that errors — each belongs to the item that started it. Without the check a late
' callback for item 3 advances the zone while item 5 is on screen; the Android player once skipped
' half a playlist exactly that way (one advance per onerror, unguarded).

sub init()
    m.bg = m.top.findNode("bg")
    m.posters = [m.top.findNode("posterA"), m.top.findNode("posterB")]
    m.video = m.top.findNode("video")
    m.fade = m.top.findNode("fade")
    m.fadeIn = m.top.findNode("fadeIn")
    m.fadeOut = m.top.findNode("fadeOut")
    m.advance = m.top.findNode("advance")
    m.recheck = m.top.findNode("recheck")
    m.refresh = m.top.findNode("refresh")

    m.front = -1            ' index into m.posters of the poster on screen, -1 = none
    m.posterGen = [-1, -1]  ' the m.gen each poster's current load belongs to
    m.gen = 0
    m.idx = -1
    m.current = invalid
    m.order = ST_PlayOrderNew()
    m.rasterSeq = 0
    m.rasterEtag = {}       ' frame key -> last ETag
    m.rasterPath = {}       ' frame key -> tmp:/ path of the last good frame
    m.rasterSlot = {}       ' frame key -> "a" | "b"
    m.failedThisRound = {}  ' item identity -> true, cleared when the round wraps
    m.running = false
    m.videoStarted = false  ' the current video reached "playing"
    m.failRounds = 0        ' consecutive rounds in which nothing could play
    m.holding = false       ' waiting on m.retry after such a round
    m.lastFailReason = ""

    m.raster = CreateObject("roSGNode", "RasterTask")
    m.raster.observeField("result", "onRasterResult")
    m.raster.control = "run"

    for each p in m.posters
        p.observeField("loadStatus", "onPosterStatus")
    end for
    m.video.observeField("state", "onVideoState")
    m.advance.observeField("fire", "onAdvanceFire")
    m.recheck.observeField("fire", "onRecheckFire")
    m.refresh.observeField("fire", "onRefreshFire")
    m.watchdog = m.top.findNode("watchdog")
    m.watchdog.observeField("fire", "onWatchdogFire")
    m.retry = m.top.findNode("retry")
    m.retry.observeField("fire", "onRetryFire")
    m.notice = m.top.findNode("notice")
    m.noticeBg = m.top.findNode("noticeBg")
    m.noticeText = m.top.findNode("noticeText")
    m.clock = m.top.findNode("clock")
    m.clockBg = m.top.findNode("clockBg")
    m.clockTime = m.top.findNode("clockTime")
    m.clockDate = m.top.findNode("clockDate")
    m.clockTick = m.top.findNode("clockTick")
    m.clockTick.observeField("fire", "onClockTick")
end sub

sub onWatchdogFire()
    if m.videoGen <> m.gen or m.current = invalid then return
    ST_Log(m.top.id, "video watchdog: no end after " + Int(m.watchdog.duration).ToStr() + " s, moving on")
    stopVideo()
    itemFailed("A video stopped responding.")
    playNext()
end sub

' ---------------------------------------------------------------- commands

sub onCommand()
    c = m.top.command
    if c = "start" then
        applyGeometry()
        m.running = true
        m.idx = -1
        m.order = ST_PlayOrderNew()
        m.failedThisRound = {}
        endHold()
        m.failRounds = 0
        m.recheck.control = "start"
        playNext()
    else if c = "stop" then
        stopAll()
    else if c = "next" then
        if m.running then playNext()
    else if c = "pause" then
        m.advance.control = "stop"
        m.refresh.control = "stop"
        stopVideo()
    else if c = "resume" then
        if m.running then playNext()
    end if
end sub

sub onMuteChange()
    ch = m.top.muteChange
    if m.current = invalid or not ST_IsAA(ch) then return
    if ST_Str(ch, "content_id") <> "" and ST_Str(ch, "content_id") = ST_Str(m.current, "content_id") then
        m.video.mute = ST_IsTrue(ch.muted)
    end if
end sub

sub applyGeometry()
    cfg = m.top.config
    w = Int(ST_Num(cfg, "width", 1920))
    h = Int(ST_Num(cfg, "height", 1080))
    m.w = w
    m.h = h
    m.bg.width = w
    m.bg.height = h
    m.bg.color = ST_ZoneFill(ST_IsTrue(cfg.layoutZone), ST_Str(cfg, "background"))
    for each p in m.posters
        p.width = w
        p.height = h
    end for
    m.video.width = w
    m.video.height = h
    m.noticeBg.width = w
    m.noticeBg.height = h
    m.noticeText.translation = [Int(w * 0.1), 0]
    m.noticeText.width = Int(w * 0.8)
    m.noticeText.height = h
end sub

sub stopAll()
    stopNativeClock()
    endHold()
    m.running = false
    m.gen = m.gen + 1
    endCurrent(false)
    m.advance.control = "stop"
    m.recheck.control = "stop"
    m.refresh.control = "stop"
    stopVideo()
    for each p in m.posters
        p.opacity = 0
        p.uri = ""
    end for
    m.front = -1
end sub

' ---------------------------------------------------------------- choosing the next item

function cfgOf(key as string) as dynamic
    cfg = m.top.config
    if not ST_IsAA(cfg) then return invalid
    return cfg[key]
end function

function eligibility() as object
    items = m.top.items
    allows = []
    if not ST_IsArray(items) then return allows
    now = ST_NowMs()
    tz = cfgOf("tzTable")
    for each it in items
        ok = ST_IsAA(it)
        if ok then ok = not ST_IsOff(it.enabled)
        if ok then ok = ST_ItemKind(it) <> "skip"
        if ok then ok = not m.failedThisRound.DoesExist(ST_ItemIdentity(it))
        if ok then ok = ST_ItemScheduleActive(it, now, tz)
        allows.Push(ok)
    end for
    return allows
end function

function countTrue(arr as object) as integer
    n = 0
    for each b in arr
        if b then n = n + 1
    end for
    return n
end function

sub playNext()
    if not m.running then return
    items = m.top.items
    allows = eligibility()
    if countTrue(allows) = 0 then
        ' Nothing can play now. If that is because everything FAILED this round, say so on screen and
        ' wait before trying again. ⚠️ Without the wait this was a tight loop on a real Roku: four
        ' undecodable videos cycled about twice a second, a black screen, and a play_start/play_end
        ' pair sent to the server for every attempt.
        failed = m.failedThisRound.Count() > 0
        m.failedThisRound = {}
        showIdle()
        if failed then holdAfterFailures()
        return
    end if
    mode = ST_Str(m.top.config, "playbackOrder", "sequential")
    nxt = ST_PlayOrderNext(items, m.idx, allows, mode, m.order)
    ST_Log(m.top.id, "next " + m.idx.ToStr() + " -> " + nxt.ToStr() + " (" + countTrue(allows).ToStr() + " eligible)")
    if nxt < 0 then
        showIdle()
        return
    end if
    if nxt <= m.idx then m.failedThisRound = {}
    m.eligibleCount = countTrue(allows)
    playIndex(nxt)
end sub

sub onRecheckFire()
    ' Schedules open and close on their own clock. Idle: try again. Playing a looping single item:
    ' re-evaluate, because a second item may have just come into its window.
    if not m.running or m.holding then return
    if m.current = invalid then
        playNext()
    else if m.eligibleCount = 1 then
        allows = eligibility()
        if countTrue(allows) <> 1 then playNext()
    else if m.idx >= 0 then
        allows = eligibility()
        if m.idx < allows.Count() and not allows[m.idx] then playNext()
    end if
end sub

sub onAdvanceFire()
    playNext()
end sub

' ---------------------------------------------------------------- failures

' The current item could not be shown. Recorded as not completed, so a failed attempt is not
' reported to the server as a play.
sub itemFailed(reason as string)
    if m.current <> invalid then m.failedThisRound[ST_ItemIdentity(m.current)] = true
    if reason <> "" then m.lastFailReason = reason
    endCurrent(false)
end sub

' Something played: the playlist works, so forget the backoff and take the notice down.
sub markSuccess()
    m.failRounds = 0
    m.lastFailReason = ""
    m.notice.visible = false
end sub

sub holdAfterFailures()
    m.failRounds = m.failRounds + 1
    d = 30
    for i = 2 to m.failRounds
        d = d * 2
        if d >= 300 then exit for
    end for
    if d > 300 then d = 300
    ST_Log(m.top.id, "nothing in this playlist could play; trying again in " + d.ToStr() + " s")
    msg = "Nothing in this playlist can play on this Roku."
    if m.lastFailReason <> "" then msg = msg + Chr(10) + Chr(10) + m.lastFailReason
    msg = msg + Chr(10) + Chr(10) + "It will try again automatically."
    m.noticeText.text = msg
    m.notice.visible = true
    m.holding = true
    m.retry.duration = d
    m.retry.control = "start"
end sub

sub endHold()
    m.holding = false
    m.retry.control = "stop"
    m.notice.visible = false
end sub

sub onRetryFire()
    m.holding = false
    if m.running then playNext()
end sub

' Roku's own wording ("unsupported video format", "Image height too high") turned into what to do.
function videoFailReason(msg as string, detail as string) as string
    t = LCase(msg + " " + detail)
    if Instr(1, t, "height too high") > 0 or Instr(1, t, "width too high") > 0 then
        return "A video is larger than this Roku can play. Use a copy no bigger than 1920 x 1080 (a portrait video: 1080 pixels tall or less)."
    end if
    if Instr(1, t, "unsupported") > 0 then return "A video is in a format this Roku cannot play (" + msg + ")."
    return "A video could not be played (" + msg + ")."
end function

' ---------------------------------------------------------------- playing one item

sub playIndex(i as integer)
    items = m.top.items
    item = items[i]
    endCurrent(true)
    stopNativeClock()
    m.gen = m.gen + 1
    m.idx = i
    m.current = item
    m.advance.control = "stop"
    m.refresh.control = "stop"
    if not ST_IsOff(item.log_play) then
        m.top.playEvent = { event: "play_start", item: item }
    end if

    kind = ST_ItemKind(item)
    m.top.status = kind + " " + ST_Str(item, "filename", ST_Str(item, "widget_name"))
    ST_Log(m.top.id, "show " + m.top.status)
    if kind = "image" then
        stopVideo()
        loadIntoBack(ST_MediaUrl(ST_Str(m.top.config, "serverUrl"), item), fitOf(item))
        armAdvance(durationOf(item, 10))
    else if kind = "raster" and startNativeClock(item) then
        stopVideo()
        armAdvance(durationOf(item, 15))
    else if kind = "raster" then
        stopVideo()
        requestRaster(item)
        armAdvance(durationOf(item, 15))
    else if kind = "video" or kind = "stream" then
        if ST_IsTrue(cfgOf("canVideo")) then
            playVideo(item, kind)
        else
            ' Roku decodes one video at a time; a secondary zone shows the item's thumbnail instead.
            loadIntoBack(ST_UrlJoin(ST_Str(m.top.config, "serverUrl"), "/api/content/" + ST_Str(item, "content_id") + "/thumbnail"), fitOf(item))
            d = durationOf(item, 0)
            if d <= 0 then d = Int(ST_Num(item, "content_duration", 10))
            if d <= 0 then d = 10
            armAdvance(d)
        end if
    else
        playNext()
    end if
end sub

' The play_end for whatever is on screen. `completed` is true for a normal advance.
sub endCurrent(completed as boolean)
    if m.current <> invalid then
        it = m.current
        if not ST_IsOff(it.log_play) then
            m.top.playEvent = { event: "play_end", item: it, completed: completed }
        end if
    end if
    m.current = invalid
end sub

function durationOf(item as object, dflt as integer) as integer
    d = Int(ST_Num(item, "duration_sec", dflt))
    if d < 1 and dflt > 0 then d = dflt
    return d
end function

sub armAdvance(seconds as integer)
    ' A single eligible item stays up: it is re-checked on the recheck tick instead of reloading.
    if m.eligibleCount <= 1 or seconds <= 0 then return
    m.advance.duration = seconds
    m.advance.control = "start"
end sub

function fitOf(item as object) as string
    f = ST_Str(item, "fit_mode")
    if f = "" then f = ST_Str(m.top.config, "fit", "contain")
    if f = "cover" then return "scaleToZoom"
    if f = "fill" then return "scaleToFill"
    return "scaleToFit"
end function

function transitionSeconds(item as object) as float
    t = item.transition
    if not ST_IsAA(t) then return 0
    ms = ST_Num(t, "durationMs", ST_Num(t, "duration_ms", 800))
    if ms < 0 then ms = 0
    if ms > 3000 then ms = 3000
    return ms / 1000.0
end function

' ---------------------------------------------------------------- posters (images and frames)

function backIndex() as integer
    if m.front = 0 then return 1
    return 0
end function

sub loadIntoBack(uri as string, mode as string)
    b = m.posters[backIndex()]
    b.loadDisplayMode = mode
    b.loadingBitmapUri = ""
    b.failedBitmapUri = ""
    b.opacity = 0
    m.posterGen[backIndex()] = m.gen
    if b.uri = uri then
        ' same file (a 304'd frame, a repeated image): no load event will come — show it now
        b.uri = ""
    end if
    b.uri = uri
end sub

sub onPosterStatus(ev as object)
    p = ev.getRoSGNode()
    st = ev.getData()
    pi = 1
    if p.isSameNode(m.posters[0]) then pi = 0
    if m.posterGen[pi] <> m.gen then return
    if st = "ready" then
        ST_Log(m.top.id, "on screen " + p.uri)
        bringToFront(p)
        if m.current <> invalid then markSuccess()
    else if st = "failed" then
        if m.current = invalid then return  ' default content on the idle screen: stay idle
        itemFailed("An image could not be loaded.")
        m.advance.control = "stop"
        playNext()
    end if
end sub

sub bringToFront(p as object)
    secs = 0
    if m.current <> invalid then secs = transitionSeconds(m.current)
    old = invalid
    if m.front >= 0 then old = m.posters[m.front]
    if p.isSameNode(m.posters[0]) then m.front = 0 else m.front = 1
    if m.video.visible and m.video.state <> "playing" then m.video.visible = false
    if secs <= 0 or old = invalid or old.opacity = 0 then
        p.opacity = 1
        if old <> invalid and not old.isSameNode(p) then old.opacity = 0
        return
    end if
    m.fade.control = "stop"
    m.fade.duration = secs
    m.fadeIn.fieldToInterp = p.id + ".opacity"
    m.fadeOut.fieldToInterp = old.id + ".opacity"
    m.fade.control = "start"
end sub

' ---------------------------------------------------------------- server-rendered frames

sub requestRaster(item as object)
    cfg = m.top.config
    server = ST_Str(cfg, "serverUrl")
    key = rasterKey(item)
    q = "?device_id=" + ST_UrlEncode(ST_Str(cfg, "deviceId"))
    if item.widget_id <> invalid and item.content_id = invalid then
        q = q + "&widget_id=" + ST_UrlEncode(ST_Str(item, "widget_id"))
        rev = ST_Str(item, "widget_rev")
    else
        q = q + "&content_id=" + ST_UrlEncode(ST_Str(item, "content_id"))
        rev = ST_Str(item, "content_rev")
    end if
    q = q + "&w=" + m.w.ToStr() + "&h=" + m.h.ToStr() + "&format=jpeg"
    ' The zone's colour goes under the page: widgets are drawn transparent over a player's background.
    q = q + "&bg=" + Mid(ST_ColorOr(ST_Str(cfg, "background"), "0x000000FF"), 3, 6)
    if rev <> "" then q = q + "&rev=" + ST_UrlEncode(rev)
    m.rasterSeq = m.rasterSeq + 1
    m.rasterWant = { seq: m.rasterSeq, gen: m.gen, key: key }
    etag = ""
    if m.rasterPath.DoesExist(key) and m.rasterEtag.DoesExist(key) then etag = m.rasterEtag[key]
    slot = "b"
    if m.rasterSlot.DoesExist(key) then slot = m.rasterSlot[key]
    m.raster.request = {
        url: ST_UrlJoin(server, "/api/player/raster") + q,
        token: ST_Str(cfg, "deviceToken"),
        etag: etag, key: key, seq: m.rasterSeq, slot: slot
    }
end sub

function rasterKey(item as object) as string
    id = ST_Str(item, "widget_id")
    if id = "" then id = "c" + ST_Str(item, "content_id")
    ' keep tmp file names short and safe
    clean = ""
    for i = 1 to Len(id)
        ch = Mid(id, i, 1)
        if (ch >= "a" and ch <= "z") or (ch >= "A" and ch <= "Z") or (ch >= "0" and ch <= "9") or ch = "-" then clean = clean + ch
    end for
    return Left(clean, 48) + "-" + m.w.ToStr() + "x" + m.h.ToStr()
end function

sub onRasterResult()
    r = m.raster.result
    want = m.rasterWant
    if not ST_IsAA(r) or want = invalid or r.seq <> want.seq or want.gen <> m.gen then return
    key = want.key
    if r.ok then
        if m.current <> invalid then markSuccess()
        if ST_Str(r, "etag") <> "" then m.rasterEtag[key] = r.etag
        if r.notModified = true then
            ' unchanged: show the frame we already have (it may not be on screen if we came from
            ' another item)
            if m.rasterPath.DoesExist(key) then loadIntoBack(m.rasterPath[key], "scaleToFit")
        else
            m.rasterPath[key] = r.path
            m.rasterSlot[key] = r.slot
            loadIntoBack(r.path, "scaleToFit")
        end if
        ' Ask again when the server says the content can next change — but only if this item will
        ' still be on screen then (a single item, or a dwell longer than the refresh).
        refreshIn = Int(r.refreshIn)
        if refreshIn > 0 then
            stay = m.eligibleCount <= 1 or durationOf(m.current, 15) > refreshIn + 1
            if stay then
                m.refresh.duration = refreshIn
                m.refresh.control = "start"
            end if
        end if
    else
        if m.rasterPath.DoesExist(key) then
            ' the server could not render it this time; the last good frame is better than nothing
            loadIntoBack(m.rasterPath[key], "scaleToFit")
            m.refresh.duration = 60
            m.refresh.control = "start"
        else
            m.top.status = "frame failed: " + ST_Str(r, "error")
            ST_Log(m.top.id, m.top.status)
            itemFailed("A page could not be rendered for this screen.")
            m.advance.control = "stop"
            playNext()
        end if
    end if
end sub

sub onRefreshFire()
    if m.current <> invalid and ST_ItemKind(m.current) = "raster" then requestRaster(m.current)
end sub

' ---------------------------------------------------------------- video

sub playVideo(item as object, kind as string)
    url = ST_MediaUrl(ST_Str(m.top.config, "serverUrl"), item)
    if url = "" then
        if m.current = invalid then return
        itemFailed("A video has no address to play from.")
        playNext()
        return
    end if
    c = CreateObject("roSGNode", "ContentNode")
    c.url = url
    c.streamFormat = ST_StreamFormat(item)
    if kind = "stream" then c.live = true
    subs = ST_Str(item, "subtitle_url")
    if subs <> "" then
        c.subtitleTracks = [{ Language: ST_Str(item, "subtitle_lang", "und"), TrackName: subs }]
        if ST_IsTrue(item.captions_enabled) then m.video.globalCaptionMode = "On" else m.video.globalCaptionMode = "Off"
    end if
    m.videoGen = m.gen
    m.videoStarted = false
    m.top.playingVideo = true
    m.video.loop = (m.eligibleCount <= 1 and kind = "video")
    m.video.mute = ST_IsTrue(item.muted)
    m.video.content = c
    m.video.control = "play"
    ' A live stream never "finishes": its dwell is the item duration, if it has one.
    if kind = "stream" then armAdvance(durationOf(item, 0))
    ' ⚠️ A WEDGED DECODER RAISES NO EVENT. Android's did exactly that (#297): no error, no end, the
    ' screen frozen on one frame forever. So a file video that has not finished by its known length
    ' plus 15 s is moved past, and one of unknown length gets 10 minutes.
    if kind = "video" and not m.video.loop then
        known = Int(ST_Num(item, "content_duration", 0))
        if known > 0 then m.watchdog.duration = known + 15 else m.watchdog.duration = 600
        m.watchdog.control = "start"
    end if
end sub

sub stopVideo()
    m.watchdog.control = "stop"
    if m.video.state = "playing" or m.video.state = "buffering" or m.video.state = "paused" then
        m.video.control = "stop"
    end if
    m.video.visible = false
    m.videoGen = -1
    m.top.playingVideo = false
end sub

sub onVideoState()
    if m.videoGen <> m.gen then return
    st = m.video.state
    if st = "playing" then
        ST_Log(m.top.id, "video playing")
        m.videoStarted = true
        if m.current <> invalid then markSuccess()
        m.video.visible = true
        ' the frame underneath is no longer needed
        for each p in m.posters
            p.opacity = 0
        end for
        m.front = -1
    else if st = "finished" then
        m.watchdog.control = "stop"
        ' ⚠️ "finished" WITHOUT EVER "playing" IS A FAILURE. After a decode error the Video node
        ' reported the NEXT video "finished" at once, so a playlist of undecodable videos looked like
        ' every other item played fine and the loop never stopped.
        if not m.videoStarted then
            ST_Log(m.top.id, "video ended without playing")
            stopVideo()
            if m.current = invalid then return
            itemFailed("A video could not be played on this Roku.")
            playNext()
        else if not m.video.loop then
            m.videoGen = -1
            playNext()
        end if
    else if st = "error" then
        ' errorMsg alone ("unsupported video format") cannot tell a codec from a container from a bad
        ' URL. errorCode, errorStr and errorInfo can, without anyone opening the file.
        m.top.status = "video error: " + m.video.errorMsg + " (code " + ST_NumToStr(m.video.errorCode) + ")"
        if m.video.errorStr <> invalid and m.video.errorStr <> "" then m.top.status = m.top.status + " " + m.video.errorStr
        info = m.video.errorInfo
        detail = ""
        if info <> invalid then
            m.top.status = m.top.status + " " + FormatJson(info)
            if ST_IsAA(info) then detail = ST_Str(info, "dbgmsg")
        end if
        ST_Log(m.top.id, m.top.status)
        reason = videoFailReason(m.video.errorMsg, detail)
        ' Reset the node, so the next video does not inherit this one's state. stopVideo() only
        ' stops a playing/buffering/paused node, never one in "error", so stop it here explicitly.
        m.video.control = "stop"
        stopVideo()
        m.video.content = invalid
        if m.current = invalid then return  ' default content on the idle screen: stay idle
        itemFailed(reason)
        playNext()
    end if
end sub

' ---------------------------------------------------------------- idle / default content

sub showIdle()
    endCurrent(true)
    stopNativeClock()
    m.gen = m.gen + 1
    m.idx = -1
    m.advance.control = "stop"
    m.refresh.control = "stop"
    dc = cfgOf("defaultContent")
    if ST_IsAA(dc) then
        kind = ST_ItemKind(dc)
        if kind = "image" then
            stopVideo()
            loadIntoBack(ST_MediaUrl(ST_Str(m.top.config, "serverUrl"), dc), fitOf(dc))
            return
        else if (kind = "video") and ST_IsTrue(cfgOf("canVideo")) then
            m.eligibleCount = 1
            playVideo(dc, kind)
            return
        end if
    end if
    stopVideo()
    for each p in m.posters
        p.opacity = 0
    end for
    m.front = -1
    m.top.status = "idle"
end sub

' ---------------------------------------------------------------- native clock widget

' The offsets for a clock's zone: the screen's table, a payload tz_tables entry, or UTC for a clock
' with no zone (as renderClock() does). invalid when this player cannot know them — then the clock
' is a server frame instead.
function clockTable(zone as string) as dynamic
    if zone = "" or zone = "UTC" or zone = "Etc/UTC" then return { zone: "UTC", spans: [{ from_ms: 0&, offset_min: 0 }] }
    t = cfgOf("tzTable")
    if ST_IsAA(t) and ST_Str(t, "zone") = zone then return t
    all = cfgOf("tzTables")
    if ST_IsAA(all) and ST_IsAA(all[zone]) then return all[zone]
    return invalid
end function

function startNativeClock(item as object) as boolean
    if ST_Str(item, "widget_type") <> "clock" then return false
    c = item.widget_config
    if ST_IsString(c) then c = ParseJson(c)
    if not ST_IsAA(c) then c = {}
    ' English only: other locales' month and day names come from Intl on the server.
    loc = LCase(ST_Str(c, "locale"))
    if loc = "" then
        di = CreateObject("roDeviceInfo")
        loc = LCase(di.GetCurrentLocale())
    end if
    if loc <> "" and Left(loc, 2) <> "en" then return false
    table = clockTable(ST_Str(c, "timezone"))
    if table = invalid then return false

    m.clockCfg = {
        table: table, use24: ST_Str(c, "format") = "24h", seconds: not ST_IsOff(c.show_seconds),
        showDate: not ST_IsOff(c.show_date), dateStyle: ST_Str(c, "date_format"), pos: ST_Str(c, "date_position", "below")
    }
    size = Int(ST_Num(c, "font_size", 64))
    if size < 8 then size = 8
    dsize = Int(ST_Num(c, "date_font_size", 0))
    if dsize <= 0 then dsize = size \ 3
    if dsize < 16 then dsize = 16
    m.clockTime.font = ST_ClockFont("pkg:/fonts/Inter-Bold.ttf", size)
    m.clockDate.font = ST_ClockFont("pkg:/fonts/Inter-Regular.ttf", dsize)
    m.clockTime.color = ST_ColorOr(ST_Str(c, "color"), "0xFFFFFFFF")
    dc = ST_Str(c, "date_color")
    if dc <> "" then
        m.clockDate.color = ST_ColorOr(dc, "0xFFFFFFFF")
        m.clockDate.opacity = 1
    else
        m.clockDate.color = m.clockTime.color
        m.clockDate.opacity = 0.7
    end if
    m.clockBg.color = ST_ColorOr(ST_Str(c, "background"), "0x00000000")
    m.clockBg.width = m.w
    m.clockBg.height = m.h
    m.clockDate.visible = m.clockCfg.showDate
    onClockTick()
    for each p in m.posters
        p.opacity = 0
    end for
    m.front = -1
    m.clock.visible = true
    m.clockTick.control = "start"
    m.top.status = "clock " + ST_Str(item, "widget_name")
    ST_Log(m.top.id, "native clock " + ST_Str(table, "zone"))
    return true
end function

function ST_ClockFont(uri as string, size as integer) as object
    f = CreateObject("roSGNode", "Font")
    f.uri = uri
    f.size = size
    return f
end function

sub stopNativeClock()
    if m.clockTick = invalid then return
    m.clockTick.control = "stop"
    m.clock.visible = false
end sub

sub onClockTick()
    cc = m.clockCfg
    if cc = invalid then return
    parts = ST_LocalParts(cc.table, ST_NowMs())
    if parts = invalid then return
    m.clockTime.text = ST_ClockTime(parts, cc.use24, cc.seconds)
    if cc.showDate then m.clockDate.text = ST_ClockDate(parts, cc.dateStyle)
    layoutClock()
end sub

' Centre time and date in the zone, the date above / below / left / right as configured.
sub layoutClock()
    tb = m.clockTime.boundingRect()
    if not m.clockCfg.showDate then
        m.clockTime.translation = [(m.w - tb.width) / 2, (m.h - tb.height) / 2]
        return
    end if
    db = m.clockDate.boundingRect()
    gap = 8
    where = m.clockCfg.pos
    if where = "left" or where = "right" then
        total = tb.width + gap + db.width
        x = (m.w - total) / 2
        if where = "left" then
            m.clockDate.translation = [x, (m.h - db.height) / 2]
            m.clockTime.translation = [x + db.width + gap, (m.h - tb.height) / 2]
        else
            m.clockTime.translation = [x, (m.h - tb.height) / 2]
            m.clockDate.translation = [x + tb.width + gap, (m.h - db.height) / 2]
        end if
    else
        total = tb.height + gap + db.height
        y = (m.h - total) / 2
        if where = "above" then
            m.clockDate.translation = [(m.w - db.width) / 2, y]
            m.clockTime.translation = [(m.w - tb.width) / 2, y + db.height + gap]
        else
            m.clockTime.translation = [(m.w - tb.width) / 2, y]
            m.clockDate.translation = [(m.w - db.width) / 2, y + tb.height + gap]
        end if
    end if
end sub
