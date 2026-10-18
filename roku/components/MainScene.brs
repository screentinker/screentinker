' MainScene — the player: setup -> pairing -> playing, and everything the server says over the socket.

sub init()
    m.stage = m.top.findNode("stage")
    m.pairing = m.top.findNode("pairing")
    m.blackout = m.top.findNode("blackout")
    m.overlay = m.top.findNode("overlay")
    m.backdrop = m.top.findNode("backdrop")
    m.heartbeat = m.top.findNode("heartbeat")
    m.reregister = m.top.findNode("reregister")
    m.powerTick = m.top.findNode("powerTick")

    m.zones = []
    m.signature = ""
    m.payload = invalid
    m.tzTable = invalid
    m.powerSchedule = invalid
    m.powerOff = false
    m.screenOffByCommand = false
    m.suspended = false
    m.lastBackMs = 0&
    m.deviceName = ""
    m.launchSignalled = false
    m.dialogBeacon = false
    ' Roku's autoplay policy (certification 4.8): with Autoplay switched off in the Roku's settings,
    ' nothing may start playing until the viewer asks. Asked once per launch, by pressing OK.
    m.awaitingStart = not ST_AutoPlayEnabled()

    m.cfg = {
        server: ST_RegRead("server_url"),
        deviceId: ST_RegRead("device_id"),
        deviceToken: ST_RegRead("device_token"),
        pairingCode: ST_RegRead("pairing_code"),
        paired: ST_RegRead("paired") = "1"
    }

    m.heartbeat.observeField("fire", "onHeartbeat")
    m.reregister.observeField("fire", "onReregister")
    m.powerTick.observeField("fire", "onPowerTick")

    ' The launch is complete once a first screen is up and answering the remote. If the server is
    ' slow, that screen is "Connecting to …", which is a fully rendered screen too.
    m.launchTimer = m.top.findNode("launchTimer")
    m.launchTimer.observeField("fire", "signalLaunchComplete")

    m.top.setFocus(true)
    if m.cfg.server = "" then
        openSetup()
    else
        startSocket()
        m.launchTimer.control = "start"
    end if
end sub

' The AppLaunchComplete beacon (certification 3.2 is measured with it), once per launch.
sub signalLaunchComplete()
    if m.launchSignalled then return
    m.launchSignalled = true
    m.launchTimer.control = "stop"
    ST_Log("launch", "complete")
    m.top.signalBeacon("AppLaunchComplete")
end sub

sub exitApp()
    ST_Log("launch", "exit")
    m.top.exitRequested = true
end sub

' ---------------------------------------------------------------- launch arguments / setup

sub onLaunchArgs()
    a = m.top.launchArgs
    if not ST_IsAA(a) then return
    if ST_Str(a, "reset") = "identity" then forgetIdentity()
    if ST_Str(a, "debug") = "1" then ST_RegWrite("debug_socket", "1")
    if ST_Str(a, "debug") = "0" then ST_RegDelete("debug_socket")
    s = ST_NormaliseServerUrl(ST_Str(a, "server"))
    if s <> "" then
        if m.setup <> invalid then
            d = m.setup
            m.setup = invalid
            d.close = true
            endSetupDialog()
        end if
        if s <> m.cfg.server then
            moveToServer(s)
        else if m.socket = invalid then
            startSocket()
        end if
    end if
end sub

sub openSetup()
    ' StandardKeyboardDialog, not the legacy KeyboardDialog: Roku's static analysis flags KeyboardDialog
    ' as invalid for voice entry (requirement 4.12). Its message is an ARRAY of lines.
    d = CreateObject("roSGNode", "StandardKeyboardDialog")
    d.title = "ScreenTinker server"
    d.message = ["Enter your ScreenTinker server address. Using the ScreenTinker cloud? Keep screentinker.com."]
    d.buttons = ["Connect", "Cancel"]
    cur = m.cfg.server
    if cur = "" then cur = "https://screentinker.com"
    d.text = cur
    d.observeField("buttonSelected", "onSetupButton")
    d.observeField("wasClosed", "onSetupClosed")
    m.setup = d
    ' A dialog that waits for input before the first screen must be bracketed by AppDialog beacons,
    ' so the time a viewer spends typing is not counted as launch time.
    if not m.launchSignalled and not m.dialogBeacon then
        m.dialogBeacon = true
        m.top.signalBeacon("AppDialogInitiate")
    end if
    m.top.dialog = d
end sub

sub endSetupDialog()
    if m.dialogBeacon then
        m.dialogBeacon = false
        m.top.signalBeacon("AppDialogComplete")
    end if
end sub

' Back on the keyboard closes it without a button. With no server yet there is nothing behind it,
' so that is "leave the app", as Back must be (certification 4.6).
sub onSetupClosed()
    if m.setup = invalid then return
    m.setup = invalid
    endSetupDialog()
    if m.cfg.server = "" then exitApp()
end sub

sub onSetupButton()
    d = m.setup
    if d = invalid then return
    if d.buttonSelected = 0 then
        s = ST_NormaliseServerUrl(setupText(d))
        m.setup = invalid
        d.close = true
        if s = "" then
            openSetup()
            return
        end if
        endSetupDialog()
        if s <> m.cfg.server then
            moveToServer(s)
        else if m.socket = invalid then
            startSocket()
        end if
        signalLaunchComplete()
    else
        m.setup = invalid
        d.close = true
        endSetupDialog()
        ' Cancel on first run used to reopen the dialog, a loop with no way out but Home.
        if m.cfg.server = "" then exitApp()
    end if
end sub

' The typed address. StandardKeyboardDialog exposes it as `text`; its textEditBox holds the same.
function setupText(d as object) as string
    t = d.text
    if (t = invalid or t = "") and d.textEditBox <> invalid then t = d.textEditBox.text
    if t = invalid then return ""
    return t
end function

sub moveToServer(url as string)
    ' A new server knows nothing about this display: start from a clean identity there.
    forgetIdentity()
    m.cfg.server = url
    ST_RegWrite("server_url", url)
    stopSocket()
    startSocket()
end sub

sub forgetIdentity()
    m.cfg.deviceId = ""
    m.cfg.deviceToken = ""
    m.cfg.pairingCode = ""
    m.cfg.paired = false
    ST_RegDelete("device_id")
    ST_RegDelete("device_token")
    ST_RegDelete("pairing_code")
    ST_RegDelete("paired")
end sub

' ---------------------------------------------------------------- socket

sub startSocket()
    m.socket = CreateObject("roSGNode", "SocketTask")
    m.socket.serverUrl = m.cfg.server
    m.socket.debug = ST_RegRead("debug_socket") = "1"
    m.socket.observeField("inbound", "onInbound")
    m.socket.control = "run"
    showStatus("Connecting to " + m.cfg.server + "…")
end sub

sub stopSocket()
    if m.socket <> invalid then
        m.socket.unobserveField("inbound")
        m.socket.control = "stop"
        m.socket = invalid
    end if
end sub

sub emit(name as string, data as object)
    if m.socket <> invalid then m.socket.outbound = { name: name, data: data }
end sub

sub onInbound()
    ev = m.socket.inbound
    if not ST_IsAA(ev) then return
    name = ev.name
    data = ev.data
    if name <> "device:heartbeat-ack" then ST_Log("socket", name)
    if name = "__connect" then
        hideStatus()
        register()
        m.heartbeat.control = "start"
        m.reregister.control = "start"
    else if name = "__disconnect" then
        ' keep playing what we have; say so only on the info overlay
        m.offline = true
    else if name = "device:registered" then
        onRegistered(data)
    else if name = "device:paired" then
        onPaired(data)
    else if name = "device:unpaired" then
        forgetIdentity()
        m.signature = ""
        clearStage()
        register()
    else if name = "device:auth-error" then
        forgetIdentity()
        m.signature = ""
        clearStage()
        register()
    else if name = "device:playlist-update" then
        applyPayload(data)
    else if name = "device:command" then
        onCommand(data)
    else if name = "device:mute-changed" then
        for each z in m.zones
            z.muteChange = data
        end for
    end if
end sub

sub register()
    d = {
        device_info: ST_DeviceInfo(),
        client_type: "roku",
        client_version: ST_AppVersion(),
        platform: "roku",
        capabilities: ST_Capabilities(),
        contract_version: "v4",
        fingerprint: ST_Fingerprint()
    }
    if m.cfg.deviceId <> "" then
        d.device_id = m.cfg.deviceId
        if m.cfg.deviceToken <> "" then d.device_token = m.cfg.deviceToken
    end if
    if not m.cfg.paired then
        ' Reuse the code across reconnects, so the operator is not chasing a new number.
        if m.cfg.pairingCode = "" then
            m.cfg.pairingCode = ST_NewPairingCode()
            ST_RegWrite("pairing_code", m.cfg.pairingCode)
        end if
        d.pairing_code = m.cfg.pairingCode
    end if
    emit("device:register", d)
end sub

sub onRegistered(data as object)
    if not ST_IsAA(data) then return
    id = ST_Str(data, "device_id")
    if id <> "" then
        m.cfg.deviceId = id
        ST_RegWrite("device_id", id)
    end if
    tok = ST_Str(data, "device_token")
    if tok <> "" then
        m.cfg.deviceToken = tok
        ST_RegWrite("device_token", tok)
    end if
    ' ⚠️ ONLY device:paired MAKES US PAIRED, never the status here. The server answers a re-register
    ' of an UNCLAIMED display it adopts (same pairing code + fingerprint: the first register reached
    ' it, its reply was lost with the session) with status "online" and deliberately no
    ' device:paired. Reading "not provisioning" as paired hid the code for good: the operator had
    ' nothing to claim and the display sat on an empty playlist (CI, 2026-10-12/13, three times).
    ' A claimed display gets device:paired straight after this, on every register (#143/#146).
    if ST_Str(data, "status") = "provisioning" then
        m.cfg.paired = false
        ST_RegWrite("paired", "0")
    end if
    if not m.cfg.paired then showPairing()
end sub

sub onPaired(data as object)
    if ST_IsAA(data) then m.deviceName = ST_Str(data, "name")
    wasPaired = m.cfg.paired
    markPaired()
    ' Pairing in the dashboard only tells us we are claimed; the first playlist comes from the next
    ' register. ⚠️ ONLY ON THE TRANSITION: the server re-sends device:paired on every register of an
    ' already-paired display (#146), so answering every one with a register would loop forever.
    if not wasPaired then register()
end sub

sub markPaired()
    m.cfg.paired = true
    ST_RegWrite("paired", "1")
    m.cfg.pairingCode = ""
    ST_RegDelete("pairing_code")
    m.pairing.visible = false
end sub

sub showPairing()
    ST_Log("pairing", "code " + m.cfg.pairingCode)
    m.signature = ""
    clearStage()
    m.pairing.code = m.cfg.pairingCode
    m.pairing.server = m.cfg.server
    m.pairing.visible = true
    signalLaunchComplete()
end sub

sub onReregister()
    ' Refreshes the time-zone table and the payload on a slow clock; pushes do the fast path.
    register()
end sub

sub onHeartbeat()
    if m.cfg.deviceId = "" then return
    emit("device:heartbeat", { device_id: m.cfg.deviceId, client_ms: ST_NowMs(), telemetry: ST_Telemetry() })
end sub

' ---------------------------------------------------------------- payload -> stage

sub applyPayload(p as object)
    if not ST_IsAA(p) then return
    m.payload = p
    if ST_IsTrue(p.suspended) then
        m.suspended = true
        m.signature = ""
        clearStage()
        showStatus(ST_Str(p, "message", "This display is suspended."))
        return
    end if
    if m.suspended then
        m.suspended = false
        hideStatus()
    end if
    m.tzTable = invalid
    if ST_IsAA(p.tz_table) then m.tzTable = p.tz_table
    m.powerSchedule = p.power_schedule
    m.backdrop.color = ST_ColorOr(ST_Str(p, "background_color"), "0x000000FF")

    n = 0
    if ST_IsArray(p.assignments) then n = p.assignments.Count()
    tzs = "none"
    if ST_IsAA(m.tzTable) and ST_IsArray(m.tzTable.spans) then tzs = ST_Str(m.tzTable, "zone") + "/" + m.tzTable.spans.Count().ToStr()
    ST_Log("payload", "items=" + n.ToStr() + " tz=" + tzs + " orientation=" + ST_Str(p, "orientation"))
    sig = payloadSignature(p)
    if sig = m.signature and m.zones.Count() > 0 then
        ' Same structure: hand the fresh items over without restarting playback (#234 — an edit to
        ' a mute flag or a data value must not send every screen back to item one).
        distributeItems(p, false)
    else
        ST_Log("payload", "structure changed, rebuilding the stage")
        m.signature = sig
        buildStage(p)
    end if
    onPowerTick()
    m.powerTick.control = "start"
end sub

' The structural fingerprint, the same fields the web player compares.
function payloadSignature(p as object) as string
    parts = []
    if ST_IsArray(p.assignments) then
        for each a in p.assignments
            if ST_IsAA(a) then
                parts.Push(ST_Str(a, "content_id") + "|" + ST_Str(a, "widget_id") + "|" + ST_Str(a, "widget_rev") + "|" + ST_Str(a, "zone_id") + "|" + ST_Str(a, "remote_url") + "|" + ST_Str(a, "filepath") + "|" + FormatJson(a.schedules) + "|" + ST_Str(a, "play_from") + "|" + ST_Str(a, "play_until") + "|" + FormatJson(a.enabled) + "|" + ST_Str(a, "fit_mode") + "|" + FormatJson(a.transition) + ST_TransparentSig(a))
            end if
        end for
    end if
    lay = ""
    if ST_IsAA(p.layout) and ST_IsArray(p.layout.zones) then
        for each z in p.layout.zones
            lay = lay + ST_Str(z, "id") + ":" + ST_Str(z, "x_percent") + ":" + ST_Str(z, "y_percent") + ":" + ST_Str(z, "width_percent") + ":" + ST_Str(z, "height_percent") + ":" + ST_Str(z, "z_index") + ":" + ST_Str(z, "fit_mode") + ";"
        end for
    end if
    dc = ""
    if ST_IsAA(p.default_content) then dc = ST_Str(p.default_content, "content_id") + ST_Str(p.default_content, "content_rev")
    ' #660: the colour is baked into every server-rendered frame (raster bg), so a new one rebuilds.
    ' Appended only when set, so a screen with none keeps the signature it had.
    bg = ST_Str(p, "background_color")
    if bg <> "" then dc = dc + "#bg" + bg
    return parts.Join(",") + "#" + lay + "#" + ST_Str(p, "orientation") + "#" + ST_Str(p, "playback_order") + "#" + dc
end function

' #660 "Transparent background" on an item: part of its signature only when set.
function ST_TransparentSig(a as object) as string
    if ST_Str(a, "transparent_bg") = "1" then return "|t"
    return ""
end function

sub clearStage()
    for each z in m.zones
        z.command = "stop"
    end for
    m.stage.removeChildrenIndex(m.stage.getChildCount(), 0)
    m.zones = []
    ' ⚠️ The signature is NOT cleared here: buildStage() calls this right after recording the new
    ' one, and clearing it made every payload look new — each push restarted playback at item one.
    ' Callers that tear the stage down for good (pairing, refresh, suspension) clear it themselves.
end sub

sub buildStage(p as object)
    clearStage()
    ' Orientation: lay out on a logical canvas, then turn the whole stage. Positive Roku rotation is
    ' counter-clockwise; the server's degrees are clockwise (CSS), hence the minus.
    ori = ST_Str(p, "orientation", "landscape")
    deg = 0
    if ori = "portrait" then deg = 90
    if ori = "landscape-flipped" then deg = 180
    if ori = "portrait-flipped" then deg = 270
    W = 1920
    H = 1080
    if deg = 90 or deg = 270 then
        W = 1080
        H = 1920
    end if
    m.stage.scaleRotateCenter = [W / 2, H / 2]
    m.stage.rotation = -deg * 3.14159265 / 180
    m.stage.translation = [960 - W / 2, 540 - H / 2]
    m.canvasW = W
    m.canvasH = H

    zones = []
    if ST_IsAA(p.layout) and ST_IsArray(p.layout.zones) and p.layout.zones.Count() >= 2 then
        for each z in p.layout.zones
            x = Int(ST_Num(z, "x_percent") * W / 100)
            y = Int(ST_Num(z, "y_percent") * H / 100)
            zw = Int(ST_Num(z, "width_percent", 100) * W / 100)
            zh = Int(ST_Num(z, "height_percent", 100) * H / 100)
            zones.Push({ id: ST_Str(z, "id"), x: x, y: y, w: zw, h: zh, z: Int(ST_Num(z, "z_index")), fit: ST_Str(z, "fit_mode"), bg: ST_Str(z, "background_color") })
        end for
        ' paint order follows z_index
        zones.SortBy("z")
    else
        zones.Push({ id: "", x: 0, y: 0, w: W, h: H, z: 0, fit: "", bg: ST_Str(p, "background_color") })
    end if

    ' Roku decodes one video at a time. The largest zone gets it; smaller zones show thumbnails.
    best = 0
    for i = 1 to zones.Count() - 1
        if zones[i].w * zones[i].h > zones[best].w * zones[best].h then best = i
    end for

    for i = 0 to zones.Count() - 1
        z = zones[i]
        node = CreateObject("roSGNode", "ZonePlayer")
        node.translation = [z.x, z.y]
        node.id = "zone_" + i.ToStr()
        node.config = {
            serverUrl: m.cfg.server, deviceId: m.cfg.deviceId, deviceToken: m.cfg.deviceToken,
            tzTable: m.tzTable, tzTables: p.tz_tables, playbackOrder: ST_Str(p, "playback_order", "sequential"),
            fit: z.fit, background: z.bg, layoutZone: z.id <> "", width: z.w, height: z.h,
            canVideo: (i = best), defaultContent: p.default_content, zoneId: z.id
        }
        node.observeField("playEvent", "onPlayEvent")
        m.stage.appendChild(node)
        m.zones.Push(node)
    end for
    distributeItems(p, true)
end sub

' Split payload.assignments across the zones. An item whose zone_id matches no zone goes to the
' first zone, as on every other player.
sub distributeItems(p as object, start as boolean)
    buckets = []
    for each z in m.zones
        buckets.Push([])
    end for
    if m.zones.Count() = 0 then return
    if ST_IsArray(p.assignments) then
        for each a in p.assignments
            target = 0
            zid = ST_Str(a, "zone_id")
            if zid <> "" then
                for i = 0 to m.zones.Count() - 1
                    if m.zones[i].config.zoneId = zid then target = i
                end for
            end if
            buckets[target].Push(a)
        end for
    end if
    for i = 0 to m.zones.Count() - 1
        cfg = m.zones[i].config
        cfg.tzTable = m.tzTable
        cfg.tzTables = p.tz_tables
        m.zones[i].config = cfg
        m.zones[i].items = buckets[i]
        if start and not m.awaitingStart then m.zones[i].command = "start"
    end for
    if start then signalLaunchComplete()
    ' Shown again after every payload: a reconnect clears the status line.
    if m.awaitingStart then
        if start then ST_Log("autoplay", "off on this Roku, waiting for OK")
        showStatus("Autoplay is off on this Roku." + Chr(10) + "Press OK to start playback.")
    end if
end sub

' The viewer asked for playback; from here on this launch plays as normal.
sub startPlayback()
    m.awaitingStart = false
    hideStatus()
    ST_Log("autoplay", "started by the viewer")
    for each z in m.zones
        z.command = "start"
        ' OK pressed while a power window or screen_off has the screen black: start, then hold
        if m.blackout.visible then z.command = "pause"
    end for
end sub

sub onPlayEvent(ev as object)
    pe = ev.getData()
    if not ST_IsAA(pe) or m.cfg.deviceId = "" then return
    it = pe.item
    zone = ev.getRoSGNode()
    d = {
        device_id: m.cfg.deviceId,
        event: pe.event,
        content_id: it.content_id,
        widget_id: it.widget_id,
        content_name: invalid,
        zone_id: invalid
    }
    nm = ST_Str(it, "filename", ST_Str(it, "widget_name", ST_Str(it, "title")))
    if nm <> "" then d.content_name = nm
    zid = ST_Str(zone.config, "zoneId")
    if zid <> "" then d.zone_id = zid
    if pe.event = "play_start" then
        d.duration_sec = it.duration_sec
    else
        d.completed = ST_IsTrue(pe.completed)
    end if
    ST_Log("play", pe.event + " " + nm)
    emit("device:play-event", d)
end sub

' ---------------------------------------------------------------- power windows and screen off

sub onPowerTick()
    off = false
    if m.powerSchedule <> invalid then
        st = ST_PowerState(m.powerSchedule, ST_NowMs(), m.tzTable)
        if ST_IsAA(st) then off = not st.on
    end if
    if off <> m.powerOff then
        m.powerOff = off
        if off then ST_Log("power", "scheduled off") else ST_Log("power", "scheduled on")
        applyBlank()
    end if
end sub

' A Roku app cannot switch the TV off. "Off" is a black screen with playback paused, which on most
' panels is the closest an app can get; the TV's own power settings do the rest if an operator wants.
sub applyBlank()
    blank = m.powerOff or m.screenOffByCommand
    if blank = m.blackout.visible then return
    m.blackout.visible = blank
    for each z in m.zones
        if blank then z.command = "pause" else z.command = "resume"
    end for
end sub

' ---------------------------------------------------------------- commands

sub onCommand(d as object)
    if not ST_IsAA(d) then return
    t = ST_Str(d, "type")
    ST_Log("command", t)
    payload = d.payload
    if t = "refresh" then
        m.signature = ""
        clearStage()
        register()
    else if t = "screen_off" then
        m.screenOffByCommand = true
        applyBlank()
    else if t = "screen_on" or t = "launch" then
        m.screenOffByCommand = false
        applyBlank()
    else if t = "set_debug" then
        en = false
        if ST_IsAA(payload) then en = ST_IsTrue(payload.enabled) else en = ST_IsTrue(d.enabled)
        m.overlay.visible = en
        updateOverlay()
    else if t = "set_server_url" then
        url = ""
        if ST_IsAA(payload) then url = ST_Str(payload, "url")
        if url = "" then url = ST_Str(d, "url")
        url = ST_NormaliseServerUrl(url)
        if url <> "" then moveToServer(url)
    else
        ' reboot, volume, shutdown, screenshots…: not available to a Roku app. The dashboard hides
        ' these for this platform; anything that still arrives is reported, not pretended.
        emit("device:log", { tag: "command", level: "warn", message: "unsupported on Roku: " + t })
    end if
end sub

' ---------------------------------------------------------------- overlay / status

sub showStatus(text as string)
    m.overlay.message = text
    m.overlay.visible = true
end sub

sub hideStatus()
    m.overlay.message = ""
    m.overlay.visible = false
end sub

sub updateOverlay()
    lines = []
    lines.Push("ScreenTinker " + ST_AppVersion() + " · " + m.cfg.server)
    if m.deviceName <> "" then lines.Push("Display: " + m.deviceName)
    for each z in m.zones
        lines.Push(z.id + ": " + z.status)
    end for
    m.overlay.message = lines.Join(Chr(10))
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if key = "options" then
        openSetup()
        return true
    else if key = "OK" and m.awaitingStart and m.zones.Count() > 0 then
        startPlayback()
        return true
    else if key = "OK" or key = "info" then
        if m.overlay.visible then
            m.overlay.visible = false
        else
            updateOverlay()
            m.overlay.visible = true
        end if
        return true
    else if key = "back" then
        ' A signage screen must not quit on one stray press; two within 3 s exit, as Roku requires.
        now = ST_NowMs()
        if now - m.lastBackMs < 3000 then return false
        m.lastBackMs = now
        m.overlay.message = "Press Back again to exit ScreenTinker"
        m.overlay.visible = true
        return true
    end if
    return false
end function
