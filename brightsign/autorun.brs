' ScreenTinker — BrightSign player host
'
' The ScreenTinker player itself is the ordinary web player (server/player/index.html) running
' in an roHtmlWidget. This script is the HOST around it, and it exists for the things a page
' cannot do for itself:
'
'   1. OWN THE WIDGET LIFECYCLE. A page that calls location.reload() on a BrightSign does not
'      reliably come back — observed in the field on 2026-07-28, where a ScreenTinker deploy
'      reloaded every connected player and the BrightSign was the only one that never returned.
'      So the page NEVER reloads itself here: it posts {type:"restart"} and this script tears the
'      widget down and builds a new one. That is a restart the OS actually performs.
'   2. SURVIVE A DEAD SERVER. load-error retries with backoff and falls back to a local page,
'      instead of leaving a white screen until someone power-cycles the box.
'   3. PERSIST IDENTITY across reboots and content changes, in the registry rather than in
'      localStorage (which is tied to the page's origin and its storage quota).
'   4. REACH BRIGHTSCRIPT-ONLY CAPABILITIES on the page's behalf — video mode, a second output,
'      and native BrightWall synchronisation — over the messageport bridge.
'
' Pair it with st-bridge.js, which is the JavaScript half of the same contract.
'
' SD card layout:  autorun.brs  st-bridge.js  offline.html  [screentinker.json]

'=== storage volume ==========================================================================
' WHERE we are running from is not a given. The obvious answer is the SD card, and every
' BrightSign example assumes it — but this player also boots FLASH:/autorun.brs straight out of
' internal eMMC, which is the ONLY path on a unit whose microSD interface is dead (ours has
' liquid corrosion on the card lines; the host controller probes at 400kHz and no card ever
' answers). Hard-coding "SD:" there means the script loads and then cannot find its own files.
'
' So ask the filesystem instead of assuming: whichever volume holds this script is the volume
' that holds everything else beside it.
Function StorageRoot() As String
    ' Which volume are we actually running from? Everything else is derived from this — the offline
    ' page, the widget's storage directory, the self-update paths — so getting it wrong points the
    ' whole player at a volume that may not physically exist.
    '
    ' Probed in the order the OS itself searches for an autorun script (roStorageHotplug.GetStorages()
    ' documents ["USB1:/", "SD:/", "SD2:/", "SSD:/", "FLASH:/"]), so the answer matches the volume the
    ' player actually booted from. FLASH is last because it is the fallback of last resort: the unit
    ' this was developed on has a dead card slot and boots from internal flash, and an earlier version
    ' of this function knew only FLASH and SD — so fitting real storage to that player and moving the
    ' files onto it would have silently resolved every path to "SD:", a slot with nothing in it.
    '
    ' ReadFile rather than a MatchFiles existence check: MatchFiles takes a DIRECTORY plus a pattern
    ' and returns nothing when the pattern contains a separator, which is why the helper further down
    ' this file never finds anything.
    ba = CreateObject("roByteArray")
    if ba.ReadFile("USB1:/autorun.brs") then return "USB1:"
    if ba.ReadFile("SSD:/autorun.brs") then return "SSD:"
    if ba.ReadFile("SD:/autorun.brs") then return "SD:"
    if ba.ReadFile("SD2:/autorun.brs") then return "SD2:"
    if ba.ReadFile("FLASH:/autorun.brs") then return "FLASH:"
    return "SD:"
End Function

'=== configuration ==========================================================================
' Provisioning order: screentinker.json on the card (imaging a batch) > registry (set once at
' pairing, survives content updates) > the built-in default.

Function LoadConfig() As Object
    cfg = {
        server_url: "https://screentinker.com"
        device_id: ""
        sync_backend: "auto"      ' auto | screentinker | brightsign
        output_mode: "single"     ' single | dual | clone
        inspector: false
        ' Self-update of the host package. Defaults ON: a fleet that cannot be updated remotely is
        ' a fleet that needs a van. The DECISION is still the server's, and it refuses anything it
        ' cannot verify, so "on" does not mean "will apply whatever it is handed".
        self_update: true
        ' Mirrors the Android beta channel. Off by default; an opted-in player also HOLDS a
        ' prerelease of its own core instead of being pulled back to the release.
        allow_prerelease: false
        ' #473 interactive web pages TOP-LEVEL (a second widget over the player). OFF until the wipe
        ' has been proven on a bench unit (README, "Interactive web pages"): without it the host does
        ' not announce kiosk_toplevel and the player uses its framed mode. Opt in with
        ' "kiosk_toplevel": true in screentinker.json, or registry screentinker/kiosk_toplevel = "1".
        kiosk_toplevel: false
    }

    ' 1) registry
    reg = CreateObject("roRegistrySection", "screentinker")
    if reg.Exists("server_url") then cfg.server_url = reg.Read("server_url")
    if reg.Exists("device_id") then cfg.device_id = reg.Read("device_id")
    if reg.Exists("sync_backend") then cfg.sync_backend = reg.Read("sync_backend")
    if reg.Exists("output_mode") then cfg.output_mode = reg.Read("output_mode")
    if reg.Exists("self_update") then cfg.self_update = (reg.Read("self_update") = "1")
    if reg.Exists("allow_prerelease") then cfg.allow_prerelease = (reg.Read("allow_prerelease") = "1")
    if reg.Exists("kiosk_toplevel") then cfg.kiosk_toplevel = (reg.Read("kiosk_toplevel") = "1")

    ' 2) a JSON file on the card wins — that is how a batch gets imaged without touching each box
    ba = CreateObject("roByteArray")
    if ba.ReadFile(StorageRoot() + "/screentinker.json") then
        json = ParseJson(ba.ToAsciiString())
        if json <> invalid then
            if json.server_url <> invalid then cfg.server_url = json.server_url
            if json.device_id <> invalid then cfg.device_id = json.device_id
            if json.sync_backend <> invalid then cfg.sync_backend = json.sync_backend
            if json.output_mode <> invalid then cfg.output_mode = json.output_mode
            if json.inspector <> invalid then cfg.inspector = json.inspector
            if json.self_update <> invalid then cfg.self_update = json.self_update
            if json.allow_prerelease <> invalid then cfg.allow_prerelease = json.allow_prerelease
            ' Only a real JSON true opts in. type() first: `if x then` on a number or a string is a
            ' type mismatch that aborts the script (the ServerEnabledFlag lesson).
            t$ = type(json.kiosk_toplevel)
            if t$ = "Boolean" or t$ = "roBoolean" then cfg.kiosk_toplevel = json.kiosk_toplevel
        end if
    end if

    return cfg
End Function

Function SnapshotDir() As String
    ' DWS writes to ITS primary storage, which is not necessarily the volume the presentation
    ' booted from — so probe rather than assume, in the same order StorageRoot() does.
    for each v in ["USB1:", "SSD:", "SD:", "SD2:", "FLASH:"]
        d$ = v + "/remote_snapshots"
        files = MatchFiles(d$, "*.jpg")
        if files <> invalid and files.Count() > 0 then return d$
    end for
    return ""
End Function

Function NewestFile(dir As String, pattern As String) As String
    ' DWS names captures img-YYYY-MM-DD-HH-MM-SS.jpg, so the lexicographic maximum IS the newest.
    best$ = ""
    files = MatchFiles(dir, pattern)
    if files = invalid then return ""
    for each f in files
        if f > best$ then best$ = f
    end for
    return best$
End Function

Function DwsPort() As String
    ' Which port the local Diagnostic Web Server answers on. Read from the same registry the
    ' DWS itself is configured from, so a player moved off port 80 still gets framebuffer
    ' captures instead of silently degrading to the canvas path.
    port$ = "80"
    reg = CreateObject("roRegistrySection", "networking")
    if reg <> invalid and reg.Exists("http_server") then
        v$ = reg.Read("http_server").Trim()
        if v$ <> "" then port$ = v$
    end if
    return port$
End Function

Sub SaveRegistry(key As String, value As String)
    reg = CreateObject("roRegistrySection", "screentinker")
    reg.Write(key, value)
    reg.Flush()
End Sub

'=== player URL =============================================================================
' Identity is carried in the URL so the page knows who it is before it has any storage of its
' own. serial is the stable hardware id; device_id is what ScreenTinker assigned at pairing.

Function PlayerUrl(cfg As Object, screen As Integer) As String
    di = CreateObject("roDeviceInfo")
    url = cfg.server_url + "/player?platform=brightsign"
    url = url + "&serial=" + di.GetDeviceUniqueId()
    url = url + "&model=" + di.GetModel()
    url = url + "&sync_backend=" + cfg.sync_backend
    if cfg.device_id <> "" then url = url + "&device_id=" + cfg.device_id
    if screen > 1 then url = url + "&screen=" + Stri(screen).Trim()
    return url
End Function

'=== widget construction ====================================================================

Function MakeWidget(url As String, rect As Object, port As Object, cfg As Object) As Object
    config = {
        url: url
        ' THIS is what gates require("@brightsign/*"). Without it the bridge silently degrades to
        ' no-ops and the player loses identity AND restart delegation. ("BrightSign modules are
        ' actually part of the firmware, but in terms of usage they are identical to other Node.js
        ' modules" — so no Node runtime means no modules.)
        nodejs_enabled: true
        ' NOT what gates require(). This flag enables the LEGACY GLOBAL objects — BSDeviceInfo,
        ' BSMessagePort and friends — which this bridge does not use; BrightSign's own cookbook
        ' examples call require("@brightsign/bt") with nodejs_enabled alone. Kept set because
        ' several of their samples set both and it costs nothing, but the comment that used to sit
        ' here credited it with holding the whole bridge up, which would send the next person
        ' debugging a dead bridge to exactly the wrong line.
        brightsign_js_objects_enabled: true
        javascript_enabled: true
        security_params: { websecurity: true }
        hwz_default: "on"                       ' hardware z-order — video on its own plane
        ' An ABSOLUTE path on the volume we booted from. "/cache" carries no BrightSign drive
        ' specifier, so it resolves outside the writable volumes and the widget's local storage —
        ' the backing store a service worker, the Cache API and IndexedDB all need — has nowhere to
        ' persist to. The XT245 on alpha exposes navigator.serviceWorker and then refuses to
        ' register one, which is exactly what a widget with no usable storage would do.
        storage_path: StorageRoot() + "/cache"  ' local storage, on the volume we booted from
        ' 1GB, as a DOUBLE. The docs are explicit: "A BrightScript integer is only guaranteed to be
        ' able to represent a count of bytes up to 2GB so avoid using integers... Use float or double
        ' instead... (string can also be used but is not recommended)". This was a string.
        storage_quota: 1073741824.0
        port: port
        mouse_enabled: false
    }
    if cfg.inspector then config.inspector_server = { port: 2999 }

    w = CreateObject("roHtmlWidget", rect, config)
    return w
End Function

' SyncManager will not work unless the PTP domain is set, and applying it needs a reboot. Done
' ONLY when this player is actually configured for native sync — a reboot on every boot would be
' a boot loop, and a player using our own protocol has no use for it.
'
' The read-before-write is what makes it safe: it reboots at most once, on the first boot after
' the mode is selected, and is a no-op forever after.
Sub EnsurePtpDomain(cfg As Object)
    if cfg.sync_backend <> "brightsign" then return

    regSec = CreateObject("roRegistrySection", "networking")
    if regSec.Read("ptp_domain") = "0" then
        print "[st] ptp_domain already 0"
    else
        print "[st] setting ptp_domain=0 for SyncManager — rebooting once to apply"
        regSec.Write("ptp_domain", "0")
        regSec.Flush()
        RebootSystem()
    end if
End Sub

' Capture what is ACTUALLY on screen, using the player's own Diagnostic Web Server.
'
' The page cannot do this itself. With hwz enabled, video decodes onto a hardware plane the DOM
' cannot see: drawImage(video) on a canvas returns a fully transparent image and throws nothing,
' so an in-page screenshot silently produces a blank frame. The DWS captures the real framebuffer,
' video included.
'
' It has to happen HERE rather than in the page for two reasons: the DWS is http on localhost and
' the player is served over https, so the page would be blocked as mixed content; and BrightScript
' is subject to neither CORS nor mixed-content rules. The credentials are the documented default —
' user "admin", password = the unit serial — which this script can read directly.
'
' ⚠️ Requires PRIMARY STORAGE. With no card or SSD fitted the endpoint answers
' "No primary storage found", because it writes the full-size capture to disk before returning the
' thumbnail. Reported back as-is rather than swallowed, so the dashboard can say why.
Sub TakeSnapshot(widget As Object, req As Object)
    di = CreateObject("roDeviceInfo")
    serial$ = di.GetDeviceUniqueId()

    w% = 640
    h% = 360
    if req <> invalid and req.width <> invalid then w% = req.width
    if req <> invalid and req.height <> invalid then h% = req.height

    ' BrightScript has NO escape sequences in string literals: "" does not mean an escaped quote,
    ' it ends one string and begins another, so `"{""width"":"` is three literals with no operator
    ' between them — a compile error that stops the WHOLE SCRIPT loading, not just this function.
    ' A quote has to come from Chr(34). This line is why the player booted to nothing:
    '   ScriptLoadError: Syntax Error. (compile error &h02) in SSD:/autorun.brs(196)
    q$ = Chr(34)
    body$ = "{" + q$ + "width" + q$ + ":" + Stri(w%).Trim() + "," + q$ + "height" + q$ + ":" + Stri(h%).Trim() + "}"

    ut = CreateObject("roUrlTransfer")
    if ut = invalid then
        widget.PostJSMessage({ type: "snapshot-result", ok: false, error: "no roUrlTransfer" })
        return
    end if

    ' The DWS port is NOT always 80. It is configurable and BSN/Supervisor-provisioned players
    ' are commonly moved off it — the unit this was found on serves DWS on 8080 with nothing
    ' listening on 80 at all. Hardcoding 80 meant every host snapshot failed to connect, fell
    ' through to the in-page canvas, and the canvas cannot read the hardware video plane, so the
    ' operator got a card reading "Video is playing on the hardware plane and cannot be captured"
    ' while the very same capture worked perfectly from the DWS Snapshots tab.
    '
    ' The port lives in the networking registry section as http_server; absent means the default.
    ' 127.0.0.1, NOT "localhost". A name has to be resolved, and on this platform that resolution
    ' is not ours to rely on: if it answers ::1 first the connection goes to an address the DWS is
    ' not listening on and the transfer sits there until something times out — which is exactly the
    ' shape of the failure this chased (the page gave up at 15s having heard nothing at all, not
    ' even this Sub's own timeout). A literal address cannot be resolved wrongly.
    ut.SetUrl("http://127.0.0.1:" + DwsPort() + "/api/v1/snapshot/")
    ut.SetUserAndPassword("admin", serial$)
    ut.AddHeader("Content-Type", "application/json")

    ' SYNCHRONOUS, deliberately — and this is the whole fix.
    '
    ' PostFromStringWithRetry does not exist (calling it raised "Member function not found" from
    ' inside the event loop, i.e. a snapshot request took the whole player down). The obvious
    ' alternative, AsyncPostFromString + Wait on a private port, is the documented way to read a
    ' POST body — and on this hardware its roUrlEvent NEVER ARRIVES. The Sub simply sat in Wait
    ' while st-bridge.js gave up at 15s, so the page reported "host did not answer in time" and
    ' fell back to the canvas, which cannot read the hardware video plane. Every other transfer in
    ' this file is synchronous (GetToString for the package check, GetToFile for the download) and
    ' every one of them works, including the self-update that replaced this very script.
    '
    ' PostFromString returns only the response CODE and discards the body — which would normally
    ' lose the thumbnail. It does not matter here: DWS WRITES THE CAPTURE TO PRIMARY STORAGE before
    ' it answers (the body carries a `filename` pointing at it), so the file is on disk by the time
    ' the call returns and can simply be read back.
    code% = ut.PostFromString(body$)
    if code% <> 200 then
        widget.PostJSMessage({ type: "snapshot-result", ok: false, error: "DWS refused the capture (HTTP " + Stri(code%).Trim() + " on port " + DwsPort() + ")" })
        return
    end if

    dir$ = SnapshotDir()
    if dir$ = "" then
        widget.PostJSMessage({ type: "snapshot-result", ok: false, error: "DWS wrote no capture to any volume" })
        return
    end if

    newest$ = NewestFile(dir$, "*.jpg")
    if newest$ = "" then
        widget.PostJSMessage({ type: "snapshot-result", ok: false, error: "no capture found in " + dir$ })
        return
    end if

    ba2 = CreateObject("roByteArray")
    if not ba2.ReadFile(dir$ + "/" + newest$) then
        widget.PostJSMessage({ type: "snapshot-result", ok: false, error: "could not read " + newest$ })
        return
    end if

    ' Read, hand over, then remove: DWS appends a new file per capture and nothing else prunes
    ' them, so a 1fps remote-control stream would otherwise fill the volume.
    img$ = "data:image/jpeg;base64," + ba2.ToBase64String()
    DeleteFile(dir$ + "/" + newest$)
    widget.PostJSMessage({ type: "snapshot-result", ok: true, image: img$ })
End Sub

' Rotate the OUTPUT, not the DOM.
'
' The web player rotates with a CSS transform, which is correct in a browser and wrong here: with
' hwz enabled the video decodes onto a hardware plane the DOM cannot transform, so a CSS rotation
' turns the images and widgets and leaves the video unrotated. Tizen hit this same wall and routes
' portrait video through AVPlay for exactly this reason.
'
' roVideoMode takes a transform — normal/90/180/270 — and rotating the screen rotates EVERYTHING,
' video included, because it happens below the compositor rather than above it.
'
' Reports success back to the page: if this fails, the page falls back to its CSS transform, which
' rotates most of the content rather than none of it. Silently doing neither would leave a portrait
' panel showing landscape content with no clue why.
Sub SetOrientation(widget As Object, o As String)
    transform$ = "normal"
    if o = "portrait" then transform$ = "90"
    if o = "portrait-flipped" then transform$ = "270"
    if o = "landscape-flipped" then transform$ = "180"

    vm = CreateObject("roVideoMode")
    if vm = invalid then
        widget.PostJSMessage({ type: "orientation-result", ok: false, error: "no roVideoMode" })
        return
    end if

    ' SetMode() takes ONE argument — a mode string. Passing a transform as a second argument was a
    ' "wrong number of function parameters" abort, so this Sub never reached its own reply and the
    ' page never learned to fall back. Rotation lives on SetScreenModes(), whose per-screen config
    ' carries a `transform` of normal|90|180|270 and rotates EVERYTHING including the video plane.
    ' Implemented in BOS 9.0.15+; an older player simply has no method here and is told so.
    ' FindMemberFunction is the documented way to ask whether a method exists on this OS version —
    ' safer than naming a member directly, which would attempt the call. It is itself feature-gated
    ' (see HasFindMember), and a player that cannot ask cannot be told the answer is yes: rotation
    ' is refused rather than risked, and the page keeps its CSS fallback.
    if not HasFindMember() then
        print "[st] orientation: cannot probe this OS for SetScreenModes — keeping the CSS fallback"
        widget.PostJSMessage({ type: "orientation-result", ok: false, error: "cannot probe this OS version" })
        return
    end if
    if FindMemberFunction(vm, "GetScreenModes") = invalid or FindMemberFunction(vm, "SetScreenModes") = invalid then
        print "[st] orientation: this OS has no SetScreenModes — the page keeps its CSS fallback"
        widget.PostJSMessage({ type: "orientation-result", ok: false, error: "SetScreenModes unavailable" })
        return
    end if

    configs = vm.GetScreenModes()
    if configs = invalid or configs.Count() = 0 then
        widget.PostJSMessage({ type: "orientation-result", ok: false, error: "no screen configuration" })
        return
    end if

    ' ⚠️ SetScreenModes REBOOTS the player when it changes the screen configuration. A playlist push
    ' repeats the current orientation on every update, so applying it unconditionally would reboot
    ' the display every time the server spoke to it. Only a real change is worth a reboot.
    changed = false
    for each c in configs
        if c.transform <> transform$ then
            c.transform = transform$
            changed = true
        end if
    end for

    if not changed then
        print "[st] orientation already "; transform$; " — nothing to do"
        widget.PostJSMessage({ type: "orientation-result", ok: true, transform: transform$ })
        return
    end if

    ' Tell the page BEFORE the call: the reboot may take the player out mid-sentence, and a display
    ' that rotates without ever confirming looks like the command was ignored.
    widget.PostJSMessage({ type: "orientation-result", ok: true, transform: transform$, rebooting: true })
    print "[st] orientation "; o; " -> transform "; transform$; " (the player will now reboot)"
    sleep(1000)
    vm.SetScreenModes(configs)
End Sub

'=== capability probe =======================================================================
' What this unit can actually do, answered by the only component that can see it.
'
' The page cannot determine any of this. There is no JavaScript API for device storage —
' @brightsign/storage exposes format/eject and nothing that enumerates volumes — so a player asked
' "do you have a disk?" could only guess. It matters because the DWS snapshot endpoint writes the
' full-size capture to disk before returning a thumbnail: with no card or SSD fitted it answers
' "No primary storage found", which is exactly what our XT245 does today. Declaring
' remote.screenshot on such a unit puts a button in the dashboard that cannot work.
'
' FLASH: is deliberately NOT counted. This player boots from internal flash because its card
' interface is physically dead, and the DWS still refuses the capture — internal flash is not
' "primary storage" as that endpoint means it. Counting it would re-create the exact lie this
' probe exists to prevent.
' Drop a trailing "/" from a drive specifier. roStorageHotplug.GetStorages() answers with one
' ("SSD:/"), the rest of this script speaks the bare form ("SSD:"), and roStorageInfo takes either.
Function TrimDrive(raw As String) As String
    n% = Len(raw)
    if n% > 0 and Mid(raw, n%, 1) = "/" then return Left(raw, n% - 1)
    return raw
End Function

' Turn a drive specifier into the one GetStorageStatus() actually accepts.
'
' GetStorages() -> ["USB1:/", "SD:/", "SD2:/", "SSD:/", "Flash:/"]
' GetStorageStatus() understands "USB:", "SD:", "SSD:", "SD2:/", "Flash:" and is documented as
' UNRELIABLE for "USBn:". So: drop the trailing slash, and collapse any USBn to a bare "USB:".
' roStorageInfo, by contrast, is documented for the NUMBERED form — so the two callers get
' different strings and the numbering is only thrown away where it does harm.
Function StatusDrive(raw As String) As String
    d$ = TrimDrive(raw)
    if LCase(Left(d$, 3)) = "usb" then return "USB:"
    return d$
End Function

Function StorageProbe() As Object
    result = { present: false, volume: "", free_mb: 0, total_mb: 0 }

    ' "USB:" not "USB1:" — the docs warn that GetStorageStatus() results are UNRELIABLE when called
    ' with a "USBn:" parameter, and list "USB:", "SD:", "SSD:", "SD2:/", "Flash:" as the drive
    ' strings it understands. One roStorageHotplug for the whole loop rather than one per volume.
    hp = CreateObject("roStorageHotplug")
    ' Ask the platform which volumes exist rather than guessing; the static list is the fallback for
    ' an OS without the enumerator. Same shape BrightSign's own boilerplate uses.
    '
    ' FLASH: is on this list and is NOT on GetStorageStatus()'s. The documented drive strings for
    ' that method are "SD:", "SSD:" and "USB:" — internal flash is simply not one of the things it
    ' can answer about, so a player booting from flash (which is how the XT245 in this office ran
    ' until an NVMe went in) can never be reported as mounted no matter what is actually there.
    ' Hence the roStorageInfo pass below: the mount check is treated as a hint, not a gate.
    volumes = ["SSD:", "SD:", "SD2:", "USB:", "FLASH:"]
    ' Feature-gated (see HasFindMember). A player that cannot be probed simply keeps the static list,
    ' which is the answer the enumerator would have given anyway on every model we ship.
    if hp <> invalid and HasFindMember() then
        if FindMemberFunction(hp, "GetStorages") <> invalid then
            found = hp.GetStorages()
            if found <> invalid and found.Count() > 0 then volumes = found
        end if
    end if
    for each raw in volumes
        ' ⚠️ GetStorages() answers in a DIFFERENT vocabulary to the one GetStorageStatus() accepts:
        ' it returns ["USB1:/", "SD:/", "SD2:/", "SSD:/", "Flash:/"] — trailing slash, and USB
        ' NUMBERED. GetStorageStatus() is documented as UNRELIABLE when called with a "USBn:"
        ' parameter and understands "USB:", "SD:", "SSD:", "SD2:/", "Flash:". So handing the
        ' enumerator's own output straight back to it re-creates exactly the bug the static list was
        ' written to avoid — silently, and only on the OS versions that HAVE the enumerator, which is
        ' why the static fallback looked correct in testing.
        v = TrimDrive(raw)
        mounted = false
        if hp <> invalid then
            st = hp.GetStorageStatus(StatusDrive(raw))
            if st <> invalid and st.mounted then mounted = true
        end if

        if mounted then
            if FillStorage(result, v) then return result
        end if
    end for

    ' Nothing claimed to be mounted — which is not the same as nothing being there.
    '
    ' GetStorageStatus() cannot answer for FLASH:, roStorageHotplug may not exist at all on an older
    ' build, and either way the whole probe hung on one call whose "no" was indistinguishable from
    ' "cannot say". roStorageInfo is the direct question: a volume that reports a non-zero size IS
    ' the disk, whatever the hotplug object thinks. The dashboard was showing 1025 MB for a player
    ' with an NVMe in it — the widget's own cache quota, reported through the fallback in
    ' st-bridge.js — because this function returned present:false and the page had nothing better.
    '
    ' The mount check still runs FIRST: it is the more meaningful answer where it works, and it
    ' picks the removable volume ahead of internal flash on a player that has both.
    for each raw in volumes
        if FillStorage(result, TrimDrive(raw)) then return result
    end for

    return result
End Function

' Real device capacity for [drive], into [result]. True when the volume answered.
'
' The widget's storage quota — all the page can see via navigator.storage.estimate() — is the cache
' budget, not the disk, which is the entire reason the host is asked at all.
Function FillStorage(result As Object, drive As String) As Boolean
    si = CreateObject("roStorageInfo", drive)
    if si = invalid then return false
    total = si.GetSizeInMegabytes()
    if total = invalid or total <= 0 then return false
    result.present = true
    result.volume = drive
    result.total_mb = total
    free = si.GetFreeInMegabytes()
    if free <> invalid and free >= 0 then result.free_mb = free
    return true
End Function

' Everything the page cannot ask the hardware directly.
Sub SendProbeResult(widget As Object, kioskOk As Boolean)
    di = CreateObject("roDeviceInfo")
    storage = StorageProbe()

    osVer$ = ""
    model$ = ""
    if di <> invalid then
        osVer$ = di.GetVersion()
        model$ = di.GetModel()
    end if

    widget.PostJSMessage({
        type: "probe-result"
        storage_present: storage.present
        storage_volume: storage.volume
        storage_free_mb: storage.free_mb
        storage_total_mb: storage.total_mb
        os_version: osVer$
        model: model$
        ' #473: this host can open an interactive web page top-level in its own widget (see the
        ' kiosk section below). False on a dual-output player: the second widget's page would open
        ' it over output ONE, and kiosk-open carries no screen.
        kiosk_toplevel: kioskOk
    })
End Sub

Function FullScreenRect() As Object
    vm = CreateObject("roVideoMode")
    return CreateObject("roRectangle", 0, 0, vm.GetResX(), vm.GetResY())
End Function

' Where the SECOND output lives inside the combined canvas, or invalid on a single-output player.
'
' GetResX/GetResY only ever describe output 1, so they cannot answer this. The per-screen
' configuration can: each entry carries display_x/display_y (its origin within the canvas built by
' SetScreenModes) and `enabled`. A widget placed at that origin paints that output; there is no
' other mechanism, because roHtmlWidget has no output selector.
'
' Returns invalid unless a SECOND, ENABLED screen genuinely exists — the caller then stays
' single-screen and says so, rather than stacking two widgets on output one. The docs warn that
' GetScreenModes on a player with unconnected outputs "won't get a valid return" for them, so an
' entry that does not describe a real screen is treated as absent.
Function SecondScreenRect() As Object
    if not HasFindMember() then return invalid
    vm = CreateObject("roVideoMode")
    if vm = invalid then return invalid
    if FindMemberFunction(vm, "GetScreenModes") = invalid then return invalid

    configs = vm.GetScreenModes()
    if configs = invalid or configs.Count() < 2 then return invalid

    s = configs[1]
    if s = invalid then return invalid
    if s.enabled <> invalid and s.enabled = false then return invalid
    if s.display_x = invalid or s.display_y = invalid then return invalid

    return CreateObject("roRectangle", s.display_x, s.display_y, vm.GetResX(), vm.GetResY())
End Function

'=== self-update ============================================================================
'
' The package (autorun.zip) can replace THIS SCRIPT. That makes it the most dangerous thing the
' player does: a truncated or half-applied autorun.brs is a dark panel and a site visit, because
' there is no app underneath to fall back to.
'
' The ordering below is the safety, and it is deliberate at every step:
'
'   1. Download to autorun.zip.part — never straight to autorun.zip. A file that is still
'      downloading, or that stopped halfway, must never be a candidate for extraction.
'   2. Verify sha256 AND size before promoting. A captive portal that answers with a login page
'      produces a perfectly well-formed small file; the size floor catches it, the hash catches
'      everything else.
'   3. Only then promote: delete the .done marker, rename .part -> autorun.zip, reboot.
'      The marker MUST go first — leaving it would make ApplyPendingPackage skip the new archive
'      on the next boot and the update would silently never happen.
'   4. Extraction failure renames the archive to .bad rather than retrying forever. A zip that
'      cannot be unpacked will not unpack on the tenth attempt either, and retrying it on every
'      boot is a loop that looks exactly like a hardware fault.
'
' THE VERSION IS BAKED IN, not stored in a side file. A version record that can disagree with the
' code actually running is the OTA-loop condition in another guise: the player applies an update,
' reports the old version, is offered it again, forever. Stamped at build time by both
' scripts/build-autorun-zip.sh and server/lib/brightsign-package.js.

Function PackageVersion() As String
    return "0.0.0-dev"   ' ST_PACKAGE_VERSION (stamped at build time — do not edit by hand)
End Function

' Can this player use FindMemberFunction() at all?
'
' ⚠️ It is NOT unconditionally available: "It is only available if
' roDeviceInfo.HasFeature("FindMemberFunction") returns true." Calling it on a player without the
' feature is a runtime error — and both call sites are reached FROM THE EVENT LOOP (the capability
' probe on every boot, the storage figures in host telemetry every 60 seconds), so on such a player
' the host script would die within a minute of starting and take the display with it. The guard it
' was being used AS is the thing that needed guarding.
Function HasFindMember() As Boolean
    di = CreateObject("roDeviceInfo")
    if di = invalid then return false
    return di.HasFeature("FindMemberFunction")
End Function

' Does [path] exist?
'
' roReadFile + a type() check — the idiom BrightSign's own boilerplate uses (CheckFile in their
' published autozip.brs). It takes a FULL PATH, which is what every call site naturally has.
'
' MatchFiles is deliberately not used here. It is for LISTING a directory: it takes a directory plus
' a pattern, returns nothing when the pattern contains a separator, and — as this player
' demonstrated — does not reliably answer for a volume root like "SSD:/". The first version of this
' function passed a path as both arguments and could never return true at all; the second passed a
' directory and a bare name and still answered "no" for a file sitting right there. An existence
' check that is subtly wrong is worse than none, because every guard built on it silently opens.
Function FileExists(path As String) As Boolean
    f = CreateObject("roReadFile", path)
    return type(f) = "roReadFile"
End Function

' Unpack a package that is sitting on storage waiting to be applied. Runs BEFORE the widget so a
' pending update lands before the player starts, not halfway through a playlist.
'
' Note this duplicates autozip.brs on purpose. autozip.brs handles the FIRST install, where a bare
' card holds nothing but autorun.zip and the OS processes it. Once autorun.brs exists at the
' storage root the OS no longer auto-processes the archive — so from then on the host has to do it
' itself, or self-update would work exactly once.
Sub ApplyPendingPackage(root As String, buf As Object)
    dir$ = root + "/"
    zipPath$ = root + "/autorun.zip"
    donePath$ = root + "/autorun.zip.done"
    badPath$ = root + "/autorun.zip.bad"
    stage$ = root + "/st-staging"

    if not FileExists(dir$ + "autorun.zip") then return
    if FileExists(dir$ + "autorun.zip.done") then return  ' already unpacked; again is the boot loop

    LogTo(buf, "update", "unpacking pending package")

    package = CreateObject("roBrightPackage", zipPath$)
    if package = invalid then
        LogTo(buf, "update", "ERROR: archive unreadable — parking it as .bad")
        MoveFile(zipPath$, badPath$)
        return
    end if

    ' ⚠️ Unpack() DELETES everything already in its target directory: "Providing a destination path
    ' of SD:/ will wipe all preexisting files from the card". Unpacking straight to the volume root
    ' would therefore erase this player's provisioning and its entire content pool on every update —
    ' the update would work and the display would come back empty and unpaired.
    '
    ' So it goes to a staging directory of its own, and the files are moved into place afterwards.
    ' The wipe is then a FEATURE: it clears any half-extracted remains of a previous attempt.
    CreateDirectory(stage$)
    package.Unpack(stage$ + "/")

    ' Unpack() returns Void, so success is proven by looking for what should now exist rather than
    ' by testing a return value that was never there.
    if not FileExists(stage$ + "/autorun.brs") then
        LogTo(buf, "update", "ERROR: extract produced no autorun.brs — parking it as .bad")
        MoveFile(zipPath$, badPath$)
        return
    end if

    ' screentinker.json is deliberately NOT copied over: it carries THIS player's provisioning
    ' (server URL, device id), and the copy inside a package carries the build's defaults. Letting
    ' an update overwrite it would re-point or unpair the display as a side effect of a routine
    ' upgrade — silently, and on every player at once.
    moved% = 0
    for each name in MatchFiles(stage$, "*")
        if name <> "screentinker.json" then
            if MoveFile(stage$ + "/" + name, root + "/" + name) then moved% = moved% + 1
        end if
    end for
    LogTo(buf, "update", "installed " + Stri(moved%).Trim() + " file(s)")

    if not MoveFile(zipPath$, donePath$) then
        ' Refusing to reboot without the marker: we would extract and reboot forever.
        LogTo(buf, "update", "ERROR: could not mark done — not rebooting")
        return
    end if

    LogTo(buf, "update", "package applied — rebooting into it")
    sleep(2000)
    RebootSystem()
End Sub

' Ask the server what to do, and do exactly that. The DECISION lives on the server
' (server/lib/brightsign-update.js, which is unit-tested); this only executes it. Re-implementing
' the version comparison here would put the prerelease trap somewhere it cannot be tested.
Sub CheckPackageUpdate(cfg As Object, root As String)
    if cfg.server_url = "" then return

    ' A package already staged and waiting for its apply-reboot is not a reason to fetch another.
    ' Observed on hardware: the periodic check fired in the gap between staging and rebooting and
    ' pulled the whole archive down a second time. Harmless here; on a metered or marginal link it
    ' is the same waste this product spent a release eliminating everywhere else.
    if FileExists(root + "/autorun.zip") then
        print "[st-update] a package is already staged — waiting for it to apply"
        return
    end if

    partPath$ = root + "/autorun.zip.part"
    reg = CreateObject("roRegistrySection", "screentinker")
    attempts% = 0
    if reg.Exists("pkg_attempts") then attempts% = Val(reg.Read("pkg_attempts"))

    url$ = cfg.server_url + "/api/brightsign/package?version=" + PackageVersion()
    url$ = url$ + "&attempts=" + Stri(attempts%).Trim()
    if cfg.allow_prerelease then url$ = url$ + "&allow_prerelease=1"

    xfer = CreateObject("roUrlTransfer")
    if xfer = invalid then return
    xfer.SetUrl(url$)
    xfer.EnablePeerVerification(true)
    body$ = xfer.GetToString()
    if body$ = "" then return                  ' unreachable server: keep running what works

    manifest = ParseJson(body$)
    if manifest = invalid then return
    if manifest.action = invalid then return
    if manifest.action <> "download" then
        if manifest.reason <> invalid then print "[st-update] no action: "; manifest.reason
        return
    end if

    ' Guard the manifest HERE, at the call site, because that is the only place a guard can help.
    ' VerifyPackage takes `As String` / `As Integer` parameters, and a missing key is `invalid`:
    ' handing invalid to a typed parameter is a runtime error raised at the CALL, before a single
    ' line inside the function runs. The check inside VerifyPackage reads like it covers this and
    ' cannot — the script would already have aborted, from inside the event loop, taking playback
    ' down with it. url is checked for the same reason (it is concatenated into a `As String`).
    if manifest.url = invalid or manifest.sha256 = invalid or manifest.size = invalid then
        print "[st-update] manifest says download but is missing url/sha256/size — ignoring it"
        return
    end if

    print "[st-update] downloading package "; manifest.version

    ' Any earlier partial is deleted first: resuming into an existing file would concatenate two
    ' downloads into something that hashes to neither.
    if FileExists(root + "/autorun.zip.part") then DeleteFile(partPath$)

    dl = CreateObject("roUrlTransfer")
    if dl = invalid then return
    dl.SetUrl(cfg.server_url + manifest.url)
    dl.EnablePeerVerification(true)
    if dl.GetToFile(partPath$) <> 200 then
        print "[st-update] download failed"
        RecordPackageAttempt(reg, attempts% + 1)
        DeleteFile(partPath$)
        return
    end if

    ' Verify before promoting. This is the gate that stops a truncated file becoming the boot script.
    if not VerifyPackage(partPath$, manifest.sha256, manifest.size) then
        print "[st-update] VERIFICATION FAILED — discarding, staying on "; PackageVersion()
        RecordPackageAttempt(reg, attempts% + 1)
        DeleteFile(partPath$)
        return
    end if

    ' Promote. Marker first — see the ordering note above.
    if FileExists(root + "/autorun.zip.done") then DeleteFile(root + "/autorun.zip.done")
    if FileExists(root + "/autorun.zip") then DeleteFile(root + "/autorun.zip")
    if not MoveFile(partPath$, root + "/autorun.zip") then
        print "[st-update] ERROR: could not stage the package — staying put"
        RecordPackageAttempt(reg, attempts% + 1)
        return
    end if

    ' A clean attempt counter, so the next version starts from zero rather than inheriting this
    ' version's failures and being refused before it is ever tried.
    RecordPackageAttempt(reg, 0)
    print "[st-update] staged "; manifest.version; " — rebooting to apply"
    sleep(2000)
    RebootSystem()
End Sub

Sub RecordPackageAttempt(reg As Object, n As Integer)
    if reg = invalid then return
    reg.Write("pkg_attempts", Stri(n).Trim())
    reg.Flush()
End Sub

' sha256 + size. Both matter: the hash proves the bytes are the ones we were promised, the size
' floor catches an error page or captive-portal login saved under the package's name.
Function VerifyPackage(path As String, expected As String, expectedSize As Integer) As Boolean
    ' Guard the arguments before the type declarations do it for us: a manifest missing sha256 or
    ' size passes `invalid` into an `As String`/`As Integer` parameter, which is a runtime error at
    ' the CALL — before any check inside the function could help.
    if expected = "" then return false

    ' roByteArray + roHashGenerator. The previous version used roFileSystem.Stat/OpenInputFile and
    ' roMessageDigest — all three are Roku objects that do not exist on BrightSign, so this function
    ' returned false unconditionally and every self-update failed verification and burned an
    ' attempt. The package is tens of kilobytes, so reading it whole is cheaper than the streaming
    ' loop it replaces.
    ba = CreateObject("roByteArray")
    if ba = invalid then return false
    if not ba.ReadFile(path) then
        print "[st-update] package unreadable at "; path
        return false
    end if

    size% = ba.Count()
    if size% < 1024 then
        print "[st-update] package is implausibly small ("; size%; " bytes)"
        return false
    end if
    if expectedSize > 0 and size% <> expectedSize then
        print "[st-update] size mismatch: got "; size%; " expected "; expectedSize
        return false
    end if

    hg = CreateObject("roHashGenerator", "sha256")
    if hg = invalid then return false
    digest = hg.Hash(ba)
    if digest = invalid then return false

    ' Hash() answers with an roByteArray, not a string.
    return LCase(digest.ToHexString()) = LCase(expected)
End Function

'=== host diagnostics =======================================================================
'
' Everything the host knows that the PAGE cannot ask for, routed into the same channels the other
' players already use: the dashboard log stream, the device-event feed, and the heartbeat telemetry.
'
' This exists because of a specific, expensive afternoon. A single bad string literal stopped this
' script compiling, and the only evidence anywhere was a line on a serial console — the server saw a
' player that simply never appeared, and the display showed nothing. Every other player reports its
' own failures; this one printed them to a cable. A panel on a wall has no cable.
'
' The pre-widget phase is the part that matters most and is the part that is hardest to reach: the
' storage probe, a pending package being applied, the video mode being set, all happen before there
' is a page to talk to. Those lines accumulate in a buffer and are flushed the moment the widget
' exists, so the boot story arrives even though it happened before anyone could listen.

' Append a diagnostic to the pre-widget buffer AND put it on the console. The buffer is an roArray
' created in Main and passed down; BrightScript has no global store (no GetGlobalAA here), and
' threading it explicitly beats the alternative of losing the boot entirely.
Sub LogTo(buf As Object, tag As String, message As String)
    print "[st-"; tag; "] "; message
    if buf <> invalid then
        if buf.Count() < 200 then                 ' a boot that logs 200 lines has a worse problem
            buf.Push({ tag: tag, message: message })
        end if
    end if
End Sub

' Send one diagnostic to the page, which forwards it to the server as a device:log line.
Sub HostLog(widget As Object, tag As String, message As String)
    print "[st-"; tag; "] "; message
    if widget = invalid then return
    widget.PostJSMessage({ type: "host-log", tag: tag, level: "i", message: message })
End Sub

' Hand the buffered boot diagnostics to the page in one go, oldest first.
Sub FlushLog(widget As Object, buf As Object)
    if widget = invalid or buf = invalid then return
    for each line in buf
        widget.PostJSMessage({ type: "host-log", tag: line.tag, level: "i", message: line.message })
    end for
    buf.Clear()
End Sub

' A device EVENT rather than a log line: these land in the incident feed the dashboard shows against
' a display, so they are reserved for things an operator would want explained — a reboot, a network
' change, the player falling over.
Sub HostEvent(widget As Object, event As String, reason As String, detail As String)
    print "[st-event] "; event; " "; reason; " "; detail
    if widget = invalid then return
    widget.PostJSMessage({ type: "host-event", event: event, reason: reason, detail: detail })
End Sub

' The facts only the host can see. The page has no API for any of this: @brightsign/storage exposes
' format and eject, not volumes; there is no JavaScript route to the uptime, the wired IP, the video
' mode actually in force, or which volume the player booted from.
Sub SendHostTelemetry(widget As Object, cfg As Object)
    if widget = invalid then return

    t = { type: "host-telemetry" }

    ' Seconds since boot. A display that reports a small uptime every time it is polled is
    ' rebooting in a loop, which is otherwise indistinguishable from a healthy one.
    up = UpTime(0)
    if up <> invalid then t.uptime_seconds = Int(up)

    di = CreateObject("roDeviceInfo")
    if di <> invalid then
        t.model = di.GetModel()
        t.os_version = di.GetVersion()
    end if

    ' The address this player holds on the LAN — the one an integrator needs to reach its DWS on
    ' site, and the one the dashboard has never been able to show for a BrightSign.
    '
    ' Interface 0 alone was not enough. Our XT245 produced 6000 telemetry rows with local_ip NULL
    ' while sitting on a healthy PoE network with a perfectly good address, and every other field in
    ' this same payload arrived. So try each interface the platform documents rather than assuming
    ' the first one answers: 0/"eth0" is the Ethernet port, "eth1" the control port on players that
    ' have one, 1/"wlan0" the internal WiFi.
    '
    ' ⚠️ The STRING forms matter. Per the Object Reference, an INTEGER interface "must currently
    ' exist on the player; otherwise the object-creation function will return Invalid" — the string
    ' names carry no such condition, so they are the ones that answer when the integer does not.
    '
    ' NOT roDeviceInfo.GetIPAddrs(): that is Roku's API. BrightSign's roDeviceInfo has no network
    ' method at all, and calling it would raise "Member function not found" here every minute. This
    ' is the exact family of mistake server/test/brightscript-api-surface.test.js exists to catch.
    ' The list is mixed integer/string on purpose (see above) and is walked in full rather than with
    ' an early exit, because the guard is the same either way and a typed `exit for` inside a nested
    ' if is exactly the sort of thing that cannot be checked from this repo.
    for each iface in [0, "eth0", "eth1", 1, "wlan0"]
        if t.local_ip = invalid then
            nc = CreateObject("roNetworkConfiguration", iface)
            if nc <> invalid then
                cur = nc.GetCurrentConfig()
                if cur <> invalid and cur.ip4_address <> invalid and cur.ip4_address <> "" then
                    t.local_ip = cur.ip4_address
                end if
            end if
        end if
    end for

    ' Say so when nothing answered. Silence here is what made this invisible for a whole fleet: the
    ' field simply stayed NULL and looked like a server-side gap rather than a player that never
    ' sent it. One line on the host log costs nothing and names the real state.
    if t.local_ip = invalid then
        HostLog(widget, "net", "no ip4_address on any interface (0/eth0/eth1/1/wlan0)")
    end if

    vm = CreateObject("roVideoMode")
    if vm <> invalid then t.video_mode = vm.GetMode()

    ' Which volume is actually in use, and how much of it is left. The page's
    ' navigator.storage.estimate() reports the widget's CACHE QUOTA, not the disk — a panel can
    ' report gigabytes free while the volume holding them is full.
    st = StorageProbe()
    if st.present then
        t.storage_volume = st.volume
        t.storage_free_mb = st.free_mb
        t.storage_total_mb = st.total_mb
    end if
    t.boot_volume = StorageRoot()
    t.package_version = PackageVersion()

    widget.PostJSMessage(t)
End Sub

'=== interactive web pages (#473) ===========================================================
' The web player can only show a site in an <iframe> of its own page, where it can neither wipe the
' site's cookies nor enforce the domain allowlist (it cannot see inside a cross-origin frame). On
' this platform it does not have to: the page asks for kiosk-open and THIS script opens a second
' roHtmlWidget pointed at the site TOP-LEVEL, over the player's widget, with:
'
'   storage_path         a fresh directory per session, deleted when the session closes and all of
'                        them deleted at boot - so a power cut mid-session is wiped too
'   javascript_injection a script the player built (base64 data: URL) that runs in EVERY document
'                        before the site's own scripts: it reports touches, media, navigation and
'                        consent cookies, enforces the allowlist and draws the Home button and the
'                        "Still there?" overlay (the player's widget is underneath and cannot)
'   brightsign_js_objects_enabled   only for BSMessagePort, which that script takes first (one per
'                        widget) and then deletes every BS* global before the site can see it
'   NO nodejs_enabled    a third-party web page must never get require("fs")
'
' Everything that arrives from the kiosk widget is RELAYED to the player and nothing else: no
' message from a website can reach the restart / reboot / identity handlers, because those listen on
' the player's port and the kiosk widget has its own.
'
' The idle clock, the session, the playlist hold and every report stay in the player (one engine
' for every platform). This host only opens, relays and closes.

Function KioskStr(v As Dynamic) As String
    ' A missing member is invalid, a number is not a string, and comparing either to a string
    ' literal is a type mismatch that aborts the script. Everything from a page goes through here.
    t$ = type(v)
    if t$ = "String" or t$ = "roString" then return v
    return ""
End Function

Function KioskRoot() As String
    return StorageRoot() + "/st-kiosk"
End Function

' Boot: every session's storage lives under one directory, so whatever a crash left behind goes.
Sub KioskWipeAll()
    DeleteDirectory(KioskRoot())
End Sub

Function KioskOpenWidget(req As Object, rect As Object, kport As Object, ks As Object) As Object
    url$ = KioskStr(req.url)
    if url$ = "" then return invalid
    root$ = KioskRoot()
    CreateDirectory(root$)
    dir$ = root$ + "/s" + Stri(ks.seq).Trim()
    DeleteDirectory(dir$)
    CreateDirectory(dir$)
    ks.dir = dir$
    config = {
        url: url$
        javascript_enabled: true
        brightsign_js_objects_enabled: true
        mouse_enabled: true                     ' "Enables mouse/touchscreen/USB keyboard events"
        focus_enabled: true
        ' Off, unlike the player: the Home button and the countdown are DOM in this page, and with a
        ' hardware video plane a playing video in the site would sit on top of them.
        hwz_default: "off"
        security_params: { websecurity: true }
        storage_path: dir$
        storage_quota: 268435456.0              ' 256MB, a DOUBLE (an integer this size is unsafe)
        port: kport
    }
    inject$ = KioskStr(req.inject)
    if inject$ <> "" then config.javascript_injection = { document_creation: [{ source: inject$ }] }
    w = CreateObject("roHtmlWidget", rect, config)
    if w = invalid then return invalid
    ' LAYOUT zoom: Chromium's page zoom reflows the page, the same model as the passive render.
    zoom$ = KioskStr(req.zoom)
    if zoom$ <> "" and zoom$ <> "1" then
        z = Val(zoom$)
        ' Nested, not `and`: FindMemberFunction itself only exists when HasFindMember() says so.
        if z > 0 and HasFindMember() then
            if FindMemberFunction(w, "SetZoomLevel") <> invalid then w.SetZoomLevel(z)
        end if
    end if
    w.Show()
    return w
End Function

Sub KioskClose(ks As Object, player As Object, notify As Boolean)
    if ks.widget <> invalid then
        ks.widget.Hide()
        ks.widget = invalid                     ' the last reference: the widget is destroyed here
    end if
    if ks.dir <> "" then
        DeleteDirectory(ks.dir)
        ks.dir = ""
    end if
    if notify then player.PostJSMessage({ type: "kiosk-closed", session: ks.session, wiped: "1" })
    ks.session = ""
    ks.start = ""
End Sub

Sub KioskFromPage(ks As Object, req As Object, rect As Object, kport As Object, player As Object, allowed As Boolean)
    t$ = KioskStr(req.type)
    if t$ = "kiosk-open" then
        session$ = KioskStr(req.session)
        if not allowed then
            player.PostJSMessage({ type: "kiosk-opened", session: session$, ok: "0", error: "not on this output" })
            return
        end if
        KioskClose(ks, player, false)
        ks.seq = ks.seq + 1
        w = KioskOpenWidget(req, rect, kport, ks)
        if w = invalid then
            KioskClose(ks, player, false)
            player.PostJSMessage({ type: "kiosk-opened", session: session$, ok: "0", error: "could not create the widget" })
            return
        end if
        ks.widget = w
        ks.session = session$
        ks.start = KioskStr(req.url)
        ks.alive.Mark()
        print "[st-kiosk] opened "; ks.start
        player.PostJSMessage({ type: "kiosk-opened", session: session$, ok: "1" })
    else if t$ = "kiosk-close" then
        ' A retried close names its session: one for a page that is already gone (or a NEWER page is
        ' open) is answered, idempotently, without touching anything.
        s$ = KioskStr(req.session)
        if s$ <> "" and s$ <> ks.session then
            player.PostJSMessage({ type: "kiosk-closed", session: s$, wiped: "1" })
        else
            print "[st-kiosk] closed"
            KioskClose(ks, player, true)
        end if
    else if t$ = "kiosk-keepalive" then
        if ks.widget <> invalid and KioskStr(req.session) = ks.session then ks.alive.Mark()
    else if t$ = "kiosk-home" then
        if ks.widget <> invalid and ks.start <> "" then ks.widget.SetURL(ks.start)
    else if t$ = "kiosk-goto" then
        u$ = KioskStr(req.url)
        if ks.widget <> invalid and u$ <> "" then ks.widget.SetURL(u$)
    else if t$ = "kiosk-eval" then
        c$ = KioskStr(req.code)
        if ks.widget <> invalid and c$ <> "" and HasFindMember() then
            if FindMemberFunction(ks.widget, "InjectJavaScript") <> invalid then ks.widget.InjectJavaScript(c$)
        end if
    end if
End Sub

' A message the kiosk page's injected script posted. Copied field by field into a FRESH flat
' object: only known kiosk types, only string values, bounded - whatever a website does with the
' port, the player receives nothing else.
Sub KioskRelay(ks As Object, req As Dynamic, player As Object)
    if type(req) <> "roAssociativeArray" then return
    t$ = KioskStr(req.type)
    if t$ <> "kiosk-activity" and t$ <> "kiosk-nav" and t$ <> "kiosk-blocked" and t$ <> "kiosk-error" and t$ <> "kiosk-consent" then return
    out = { type: t$, session: ks.session }
    for each k in ["url", "reload", "touch", "media", "home", "reason", "detail", "host", "cookies", "what"]
        v$ = KioskStr(req[k])
        if v$ <> "" then out[k] = Left(v$, 4000)
    end for
    player.PostJSMessage(out)
End Sub

' Drain the kiosk widget's own port. Called on every pass of the main loop.
Sub KioskPump(ks As Object, kport As Object, player As Object)
    n = 0
    km = kport.GetMessage()
    while km <> invalid and n < 50
        n = n + 1
        if type(km) = "roHtmlWidgetEvent" and ks.widget <> invalid then
            d = km.GetData()
            if type(d) = "roAssociativeArray" then
                r$ = KioskStr(d.reason)
                if r$ = "message" then
                    KioskRelay(ks, d.message, player)
                else if r$ = "load-error" then
                    ' The site itself failed to load (the key is `uri` on a load-error).
                    player.PostJSMessage({ type: "kiosk-error", session: ks.session, reason: "load_error", url: KioskStr(d.uri), detail: "load error " + KioskStr(d.message) })
                else if r$ = "load-finished" then
                    player.PostJSMessage({ type: "kiosk-loaded", session: ks.session })
                else if r$ = "new-window-request" then
                    ' The player decides (allowlist) and answers kiosk-goto to load it in place.
                    player.PostJSMessage({ type: "kiosk-newwindow", session: ks.session, url: KioskStr(d.uri) })
                else if r$ = "download-request" then
                    ' Never downloaded: there is no handler, the request is only reported.
                    player.PostJSMessage({ type: "kiosk-blocked", session: ks.session, url: KioskStr(d.url), what: "download" })
                end if
            end if
        end if
        km = kport.GetMessage()
    end while
End Sub

'=== main ===================================================================================

Sub Main()
    ' Diagnostics from before there is a page to send them to. Flushed the moment the widget exists.
    boot = CreateObject("roArray", 32, true)

    cfg = LoadConfig()
    LogTo(boot, "boot", "host " + PackageVersion() + " from " + StorageRoot() + " -> " + cfg.server_url)

    ' Crash dumps land here if the widget ever falls over — cheap, and the only forensic trail
    ' available on a panel nobody can reach.
    dir = CreateDirectory(StorageRoot() + "/brightsign-dumps")

    ' Must happen BEFORE the widget starts: it can reboot.
    EnsurePtpDomain(cfg)

    ' A package staged by a previous run lands here, before anything is on screen. Doing it after
    ' the widget started would mean rebooting out of a playing playlist, and the panel would blink
    ' mid-content for a reason nobody watching could explain.
    ApplyPendingPackage(StorageRoot(), boot)

    port = CreateObject("roMessagePort")

    ' #473: the interactive-page widget has its OWN port, so nothing a website posts can reach the
    ' handlers below. Leftover session storage from a crash or power cut is deleted before anything.
    kport = CreateObject("roMessagePort")
    ks = { widget: invalid, dir: "", session: "", start: "", seq: 0, alive: CreateObject("roTimespan") }
    KIOSK_SILENCE_MS = 20000
    KioskWipeAll()

    ' Second output. The XC5 family exposes more than one HDMI connector (XC2055 dual, XC4055
    ' quad). Do NOT trust the series-level spec blurb here: it credits the whole XT5 family with
    ' "dual HDMI outputs", but an XT245 in hand is single-output — that phrase appears to cover
    ' HDMI in + out. Check the individual model, not the family.
    '
    ' Every single-output model must fall through this cleanly. GetResX/GetResY only ever
    ' describe output 1, so a second widget is created ONLY when the config asks for it — an
    ' unsupported model then keeps working as a normal single-screen player rather than failing
    ' to start. Screen 2 loads the SAME player with &screen=2, so the server can hand it its own
    ' playlist ("dual" = independent) or the same one ("clone").
    dual = (cfg.output_mode = "dual" or cfg.output_mode = "clone")

    rect = FullScreenRect()
    widget = MakeWidget(PlayerUrl(cfg, 1), rect, port, cfg)
    widget.Show()

    ' NOT flushed here. Show() only creates the widget — the page has not been fetched, let alone
    ' run st-bridge.js, so there is nothing on the other end of PostJSMessage yet and every line
    ' would go into the void. Buffered instead until the page says hello (its `probe` message,
    ' which st-bridge.js posts as soon as it loads), which is the whole reason the buffer exists.
    ' The same window ate SendHostTelemetry; telemetry repeats every 60s so it self-healed and the
    ' boot report — the one that only ever happens once — did not.
    widget2 = invalid
    if dual then
        ' ⚠️ There is NO per-widget output selector. roHtmlWidget takes a rectangle and nothing else:
        ' its init parameters have no `screen`/`output` key, and neither does the JavaScript
        ' HtmlWidgetParams. A second output is addressed by BUILDING ONE TALL CANVAS with
        ' SetScreenModes (display_x/display_y stack the outputs) and then placing the second widget
        ' at that offset inside it.
        '
        ' Which means the previous version could not work: it passed the SAME full-screen rect for
        ' both widgets, so widget 2 was composited directly on top of widget 1 on output ONE — two
        ' players fighting over one screen while the second output stayed dark. "dual" and "clone"
        ' were configuration options that made the display worse and reported nothing.
        rect2 = SecondScreenRect()
        if rect2 = invalid then
            ' Refused rather than guessed. Multi-output is documented for the XC2055 (two) and
            ' XC4055 (four); the XT line has HDMI IN and HDMI OUT, which the series blurb describes
            ' as "dual HDMI" and which is not a second output at all.
            LogTo(boot, "boot", "output_mode=" + cfg.output_mode + " but this player exposes one output — staying single-screen")
            HostEvent(widget, "app_error", "output-mode", "dual/clone requested; this player has a single output")
        else
            screen2 = 2
            if cfg.output_mode = "clone" then screen2 = 1
            widget2 = MakeWidget(PlayerUrl(cfg, screen2), rect2, port, cfg)
            if widget2 <> invalid then widget2.Show()
        end if
    end if

    retries = 0
    lastBeat = CreateObject("roTimespan")
    lastBeat.Mark()

    ' Update check runs AFTER the widget is up, deliberately. A slow or unreachable server must
    ' never delay first frame — content on screen is the job, updating is housekeeping. It also
    ' runs on a timer rather than only at boot, because a panel that is never power-cycled would
    ' otherwise never see an update at all.
    lastPkgCheck = CreateObject("roTimespan")
    lastPkgCheck.Mark()
    PKG_CHECK_MS = 6 * 60 * 60 * 1000    ' 6h: this replaces the boot script, so rarely is right
    if cfg.self_update then CheckPackageUpdate(cfg, StorageRoot())

    ' A watchdog on TOP of load-error: a page can load fine and then wedge (dead socket, JS
    ' exception, decoder stall) without the OS ever reporting an error. st-bridge.js posts a
    ' heartbeat every 30s; three missed beats and we rebuild the widget. This is the difference
    ' between a panel that recovers on its own and one that needs a site visit.
    ' Seconds first, milliseconds derived: the diagnostic message needs an INTEGER to format, and
    ' dividing at the call site would hand Stri a float.
    WATCHDOG_S = 120
    WATCHDOG_MS = WATCHDOG_S * 1000

    lastHostTel = CreateObject("roTimespan")
    lastHostTel.Mark()
    HOST_TEL_MS = 60000

    while true
        ' While an interactive page is open its touches must reach the player promptly.
        waitMs = 5000
        if ks.widget <> invalid then waitMs = 200
        msg = wait(waitMs, port)

        if type(msg) = "roHtmlWidgetEvent" then
            data = msg.GetData()

            if data.reason = "load-finished" then
                retries = 0
                lastBeat.Mark()
                print "[st] player loaded"

            else if data.reason = "load-error" then
                ' Back off, then fall back to the local page so the screen says something
                ' truthful instead of showing white. The local page keeps retrying the server.
                retries = retries + 1
                ' The key is `uri` on a load-error; `url` belongs to download-request. Printing
                ' the wrong one meant the single diagnostic that names the failing resource always
                ' printed "invalid".
                ' data.uri is already a String per the event contract, so no conversion is wanted:
                ' Str() is for numbers and would abort the event loop. Guarded because a missing key
                ' yields invalid, and assigning invalid to a $-typed name is a runtime error.
                uri$ = ""
                if data.uri <> invalid then uri$ = data.uri
                HostEvent(widget, "app_error", "load-error", "attempt " + Stri(retries).Trim() + ": " + uri$)
                KioskClose(ks, widget, false)
                sleep(ChooseBackoff(retries))
                if retries >= 3 then
                    ' The server URL rides along so the fallback page can name it on screen and
                    ' keep probing it — the page has no other way to learn where home is.
                    widget = RebuildWidget(widget, "file:/" + StorageRoot() + "/offline.html?server=" + cfg.server_url, rect, port, cfg)
                else
                    widget = RebuildWidget(widget, PlayerUrl(cfg, 1), rect, port, cfg)
                end if

            else if data.reason = "message" then
                m = data.message
                lastBeat.Mark()

                ' A missing member is `invalid`, and comparing invalid to a literal is a TYPE
                ' MISMATCH that aborts the script — taking the whole player down with it. Every
                ' field is existence-checked before it is compared.
                if m = invalid or m.type = invalid then
                    ' nothing addressable in this message
                else if m.type = "heartbeat" then
                    ' nothing to do — marking the timespan above IS the handling

                else if m.type = "restart" then
                    ' The page asks to be restarted (deploy, version change, unrecoverable
                    ' error). NEVER let the page do this with location.reload().
                    print "[st] restart requested: "; m.reason
                    KioskClose(ks, widget, false)
                    widget = RebuildWidget(widget, PlayerUrl(cfg, 1), rect, port, cfg)

                else if m.type = "identity" then
                    ' Pairing completed in the page — persist it where a reboot can find it.
                    ' clear:true is the operator reset; the registry must forget the display or
                    ' the next boot re-adopts it and the reset silently does nothing.
                    if m.clear <> invalid and m.clear = true then
                        SaveRegistry("device_id", "")
                        cfg.device_id = ""
                    end if
                    if m.device_id <> invalid then
                        SaveRegistry("device_id", m.device_id)
                        cfg.device_id = m.device_id
                    end if
                    if m.server_url <> invalid then
                        SaveRegistry("server_url", m.server_url)
                        cfg.server_url = m.server_url
                    end if

                else if m.type = "probe" then
                    ' Asked once during boot, before the player registers: the answer decides which
                    ' controls the dashboard is allowed to offer for this display.
                    SendProbeResult(widget, cfg.kiosk_toplevel and (widget2 = invalid))
                    ' ...and this is the first PROOF that a page is listening, so it is the earliest
                    ' moment the buffered boot story can actually be delivered. st-bridge.js holds it
                    ' until the player's socket is up, so late here is still in time.
                    FlushLog(widget, boot)
                    SendHostTelemetry(widget, cfg)

                else if m.type = "set-orientation" then
                    if m.orientation <> invalid then SetOrientation(widget, m.orientation)

                else if m.type = "snapshot" then
                    TakeSnapshot(widget, m)

                else if m.type = "set-video-mode" then
                    vm = CreateObject("roVideoMode")
                    if m.mode <> invalid then vm.SetMode(m.mode)

                else if m.type = "set-sync-backend" then
                    ' The server decided which protocol this deployment uses (see
                    ' server/lib/sync-backend.js). Persist it so a cold boot with no network
                    ' still starts in the right mode.
                    if m.backend <> invalid then
                        SaveRegistry("sync_backend", m.backend)
                        cfg.sync_backend = m.backend
                    end if

                else if m.type = "reboot" then
                    print "[st] reboot requested"
                    RebootSystem()

                else if Left(KioskStr(m.type), 6) = "kiosk-" then
                    KioskFromPage(ks, m, rect, kport, widget, cfg.kiosk_toplevel and (widget2 = invalid))
                end if
            end if
        end if

        ' #473: relay whatever the interactive page reported since the last pass.
        KioskPump(ks, kport, widget)
        ' The player keeps a kiosk page alive every 5s. Silence (player wedged or reloaded, or its
        ' messages no longer reaching us) closes the page, so a site can never be left over the screen.
        if ks.widget <> invalid then
            if ks.alive.TotalMilliseconds() > KIOSK_SILENCE_MS then
                print "[st-kiosk] no keep-alive from the player — closing the kiosk page"
                KioskClose(ks, widget, true)
            end if
        end if

        ' watchdog
        if lastBeat.TotalMilliseconds() > WATCHDOG_MS then
            ' Reported as a crash, because that is what it is from the floor: the page stopped
            ' answering and the host restarted it. Previously this healed the panel in silence, so a
            ' display rebuilding itself every two minutes looked identical to one that was fine.
            HostEvent(widget, "crash", "watchdog", "no heartbeat for " + Stri(WATCHDOG_S).Trim() + "s — rebuilt the widget")
            KioskClose(ks, widget, false)
            widget = RebuildWidget(widget, PlayerUrl(cfg, 1), rect, port, cfg)
            lastBeat.Mark()
        end if

        ' Host facts, on the same cadence as the package check is cheap but far too slow to be
        ' useful; every telemetry tick would be too chatty. A minute is what the dashboard shows.
        if lastHostTel.TotalMilliseconds() > HOST_TEL_MS then
            lastHostTel.Mark()
            SendHostTelemetry(widget, cfg)
        end if

        ' Periodic package check. Marked BEFORE the call, not after: a check that blocks on a slow
        ' server would otherwise be retried immediately on the next tick and hammer it.
        if cfg.self_update and lastPkgCheck.TotalMilliseconds() > PKG_CHECK_MS then
            lastPkgCheck.Mark()
            CheckPackageUpdate(cfg, StorageRoot())
        end if
    end while
End Sub

Function ChooseBackoff(retries As Integer) As Integer
    if retries <= 1 then return 5000
    if retries = 2 then return 15000
    if retries = 3 then return 30000
    return 60000
End Function

' Tear the old widget down explicitly before building the new one. Dropping the reference alone
' leaves the old widget composited and holding its decoder until GC gets to it, which shows up
' as two players fighting over the screen.
Function RebuildWidget(old As Object, url As String, rect As Object, port As Object, cfg As Object) As Object
    if old <> invalid then
        old.Hide()
        old = invalid
    end if
    w = MakeWidget(url, rect, port, cfg)
    w.Show()
    return w
End Function
