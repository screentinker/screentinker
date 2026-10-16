' ScreenTinker Roku player — small shared helpers.
'
' Pure BrightScript (no SceneGraph), so every function here runs in a Task thread, the render
' thread, and the brs-node test runner alike. Prefix ST_ keeps them out of the way of anything
' Roku or a library defines.
'
' ⚠️ TIME IS ALWAYS LongInteger MILLISECONDS. An Integer holds ±2^31, i.e. 24 days of ms — enough to
' look fine in a quick test and to overflow the first time a real epoch value goes through it.

function ST_NowMs() as longinteger
    dt = CreateObject("roDateTime")
    ms& = dt.AsSeconds()
    return ms& * 1000& + dt.GetMilliseconds()
end function

function ST_IsString(v as dynamic) as boolean
    return v <> invalid and (type(v) = "roString" or type(v) = "String")
end function

function ST_IsNumber(v as dynamic) as boolean
    if v = invalid then return false
    t = type(v)
    return t = "Integer" or t = "roInt" or t = "LongInteger" or t = "roLongInteger" or t = "Float" or t = "roFloat" or t = "Double" or t = "roDouble"
end function

function ST_IsArray(v as dynamic) as boolean
    return v <> invalid and type(v) = "roArray"
end function

function ST_IsAA(v as dynamic) as boolean
    return v <> invalid and type(v) = "roAssociativeArray"
end function

function ST_IsTrue(v as dynamic) as boolean
    if v = invalid then return false
    if type(v) = "Boolean" or type(v) = "roBoolean" then return v
    if ST_IsNumber(v) then return v <> 0
    if ST_IsString(v) then return LCase(v) = "true" or v = "1"
    return false
end function

' A string field, or a default when it is missing / not a string.
function ST_Str(aa as dynamic, key as string, dflt = "" as string) as string
    if not ST_IsAA(aa) then return dflt
    v = aa[key]
    if ST_IsString(v) then return v
    if ST_IsNumber(v) then return ST_NumToStr(v)
    return dflt
end function

' A numeric field as Float, or a default.
function ST_Num(aa as dynamic, key as string, dflt = 0 as float) as float
    if not ST_IsAA(aa) then return dflt
    v = aa[key]
    if ST_IsNumber(v) then return v
    if ST_IsString(v) and v <> "" then return Val(v)
    return dflt
end function

' Integers print without ".0"; everything else via Str().
function ST_NumToStr(n as dynamic) as string
    if n = invalid then return ""
    t = type(n)
    if t = "Integer" or t = "roInt" or t = "LongInteger" or t = "roLongInteger" then return n.ToStr()
    if Int(n) = n and Abs(n) < 2147483647 then return Int(n).ToStr()
    return Str(n).Trim()
end function

' Percent-encode for a query string value.
' ⚠️ NOT roUrlTransfer.Escape(). roUrlTransfer is a MAIN/TASK-only component: creating one on the
' render thread fails, and the next line then crashes the app into the debugger with a black screen.
' ZonePlayer builds media and frame URLs on the render thread. The simulator does not enforce thread
' rules, so this only showed on a real Roku (Streaming Stick 4K, OS 15.3.4). The string method works
' on every thread.
function ST_UrlEncode(s as string) as string
    return s.EncodeUriComponent()
end function

' Join a base URL and a path without doubling or dropping the slash.
function ST_UrlJoin(base as string, path as string) as string
    b = base
    while Len(b) > 0 and Right(b, 1) = "/"
        b = Left(b, Len(b) - 1)
    end while
    if Left(path, 1) = "/" then return b + path
    return b + "/" + path
end function

' Normalise an operator-typed server address: trim, add https:// when no scheme, drop trailing /.
function ST_NormaliseServerUrl(raw as string) as string
    s = raw.Trim()
    if s = "" then return ""
    l = LCase(s)
    if Left(l, 7) <> "http://" and Left(l, 8) <> "https://" then s = "https://" + s
    while Len(s) > 0 and Right(s, 1) = "/"
        s = Left(s, Len(s) - 1)
    end while
    return s
end function

' A fresh 6-digit pairing code, as the web player makes one.
function ST_NewPairingCode() as string
    return (100000 + Rnd(900000) - 1).ToStr()
end function

' Random hex string (for install fingerprints and Engine.IO cache-busting).
function ST_RandomHex(n as integer) as string
    digits = "0123456789abcdef"
    s = ""
    for i = 1 to n
        s = s + Mid(digits, Rnd(16), 1)
    end for
    return s
end function

' ---------------------------------------------------------------- persistent settings

function ST_RegRead(key as string, dflt = "" as string) as string
    sec = CreateObject("roRegistrySection", "screentinker")
    if sec.Exists(key) then return sec.Read(key)
    return dflt
end function

sub ST_RegWrite(key as string, value as string)
    sec = CreateObject("roRegistrySection", "screentinker")
    sec.Write(key, value)
    sec.Flush()
end sub

sub ST_RegDelete(key as string)
    sec = CreateObject("roRegistrySection", "screentinker")
    sec.Delete(key)
    sec.Flush()
end sub

' ---------------------------------------------------------------- media classification

' What the Roku does with an item: "video", "stream", "image", "raster" (server renders it), "skip".
'
' ⚠️ THE DEFAULT IS "raster", NOT "skip". Anything the server can draw — every widget type, web
' pages, HTML bundles, PDFs, types added after this player shipped — is shown as a rendered frame.
' Only the things a frame cannot represent at all (RTSP, HDMI-in, a hold placeholder) are skipped.
function ST_ItemKind(item as object) as string
    if not ST_IsAA(item) then return "skip"
    mime = LCase(ST_Str(item, "mime_type"))
    if item.widget_id <> invalid and item.content_id = invalid then return "raster"
    if mime = "video/rtsp" or mime = "video/hdmi-in" or mime = "application/x-st-hold" then return "skip"
    if mime = "video/hls" or mime = "application/vnd.apple.mpegurl" or mime = "application/x-mpegurl" or mime = "application/dash+xml" then return "stream"
    if Left(mime, 6) = "video/" then return "video"
    if mime = "image/jpeg" or mime = "image/png" or mime = "image/gif" or mime = "image/webp" or mime = "image/bmp" then return "image"
    if Left(mime, 6) = "audio/" then return "skip"
    if item.content_id = invalid and item.widget_id = invalid then return "skip"
    return "raster"
end function

' Roku's streamFormat for a video/stream item.
function ST_StreamFormat(item as object) as string
    mime = LCase(ST_Str(item, "mime_type"))
    name = LCase(ST_Str(item, "filename") + " " + ST_Str(item, "remote_url"))
    if mime = "video/hls" or mime = "application/vnd.apple.mpegurl" or mime = "application/x-mpegurl" or Instr(1, name, ".m3u8") > 0 then return "hls"
    if mime = "application/dash+xml" or Instr(1, name, ".mpd") > 0 then return "dash"
    if mime = "video/x-matroska" or Instr(1, name, ".mkv") > 0 then return "mkv"
    if mime = "video/quicktime" or Instr(1, name, ".mov") > 0 then return "mp4"
    return "mp4"
end function

' The URL a media item is fetched from: a presigned storage URL, a remote URL, or the server's
' immutable /uploads path with ?rev= so a replaced file is never served from a stale cache.
function ST_MediaUrl(serverUrl as string, item as object) as string
    fu = ST_Str(item, "file_url")
    if fu <> "" then return fu
    fp = ST_Str(item, "filepath")
    if fp <> "" then
        if Left(LCase(fp), 4) = "http" then return fp
        u = ST_UrlJoin(serverUrl, "/uploads/content/" + fp)
        rev = ST_Str(item, "content_rev")
        if rev <> "" then u = u + "?rev=" + ST_UrlEncode(rev)
        return u
    end if
    ru = ST_Str(item, "remote_url")
    if ru <> "" then return ru
    cid = ST_Str(item, "content_id")
    if cid <> "" then return ST_UrlJoin(serverUrl, "/api/content/" + cid + "/file")
    return ""
end function

' Stable identity of an item inside a playlist (content or widget, plus its slot).
function ST_ItemIdentity(item as object) as string
    if not ST_IsAA(item) then return ""
    return ST_Str(item, "content_id") + "|" + ST_Str(item, "widget_id") + "|" + ST_Str(item, "slot_id") + "|" + ST_Str(item, "sort_order")
end function

' True for an explicit "off" flag: 0, false, "0", "false". invalid (absent) is NOT off.
' ⚠️ Comparing an Integer with a Boolean is a runtime error in BrightScript, and the server sends
' these flags as 0/1 while JSON from elsewhere may carry true/false — so never `x = 0` directly.
function ST_IsOff(v as dynamic) as boolean
    if v = invalid then return false
    t = type(v)
    if t = "Boolean" or t = "roBoolean" then return not v
    if ST_IsNumber(v) then return v = 0
    if ST_IsString(v) then return v = "0" or LCase(v) = "false"
    return false
end function

' "#rrggbb" / "#rrggbbaa" / "0xRRGGBBAA" -> Roku colour string, else the default.
function ST_ColorOr(c as string, dflt as string) as string
    if c = "" then return dflt
    if Left(c, 1) = "#" then
        hex = Mid(c, 2)
        if Len(hex) = 3 then hex = Mid(hex, 1, 1) + Mid(hex, 1, 1) + Mid(hex, 2, 1) + Mid(hex, 2, 1) + Mid(hex, 3, 1) + Mid(hex, 3, 1)
        if Len(hex) = 6 then return "0x" + UCase(hex) + "FF"
        if Len(hex) = 8 then return "0x" + UCase(hex)
        return dflt
    end if
    if Left(LCase(c), 2) = "0x" then return c
    return dflt
end function

' #657: the fill painted behind a zone. A LAYOUT zone paints none: every zone is saved with
' background_color "#000000" unless someone changes it, and the web player and Android paint no fill
' there, so a full-screen zone holding a transparent PNG is a frame over the zones beneath, not a black
' sheet. The one full-screen zone of a plain playlist keeps the device's background colour. (A web
' frame is still drawn over the zone's colour: rasters are opaque JPEGs.)
function ST_ZoneFill(layoutZone as boolean, background as string) as string
    if layoutZone then return "0x00000000"
    return ST_ColorOr(background, "0x000000FF")
end function

' One console line, "[st] tag: message". On a Roku this is the developer console (port 8085); the
' simulator test harness reads the same lines to follow the player.
sub ST_Log(tag as string, msg as string)
    print "[st] " + tag + ": " + msg
end sub

' ---------------------------------------------------------------- clock text (native clock widget)
' Mirrors routes/widgets.js renderClock() in en-US, which is what toLocaleTimeString/DateString give
' there: hour "2-digit" (09:05:03 AM / 21:05:03), and the date in one of four styles.

function ST_Pad2(n as integer) as string
    if n < 10 then return "0" + n.ToStr()
    return n.ToStr()
end function

function ST_ClockTime(parts as object, use24 as boolean, seconds as boolean) as string
    h = parts.hour
    suffix = ""
    if not use24 then
        suffix = " AM"
        if h >= 12 then suffix = " PM"
        h = h Mod 12
        if h = 0 then h = 12
    end if
    t = ST_Pad2(h) + ":" + ST_Pad2(parts.minute)
    if seconds then t = t + ":" + ST_Pad2(parts.second)
    return t + suffix
end function

function ST_ClockDate(parts as object, style as string) as string
    months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
    days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    mon = months[parts.month - 1]
    if style = "long" then return mon + " " + parts.day.ToStr() + ", " + parts.year.ToStr()
    if style = "medium" then return Left(mon, 3) + " " + parts.day.ToStr() + ", " + parts.year.ToStr()
    if style = "short" then return ST_Pad2(parts.month) + "/" + ST_Pad2(parts.day) + "/" + Right(parts.year.ToStr(), 2)
    return days[parts.dow] + ", " + mon + " " + parts.day.ToStr() + ", " + parts.year.ToStr()
end function
