' ScreenTinker SERVER on a BrightSign player.
'
' TWO OBJECTS, TWO JOBS:
'   roNodeJs      - runs the server. A real Node process.
'   roHtmlWidget  - shows the diagnostic screen. Just a browser, pointed at a local page.
'
' ⚠️ THE SERVER USED TO LIVE INSIDE THE WIDGET, AND THAT COST FOUR BOOT FAILURES.
'
' A widget with nodejs_enabled is a Node context inside an Electron renderer, and it is NOT Node:
'
'   1. shebangs are not stripped, so any `#!/usr/bin/env node` file fails to compile with
'      "Failed to construct 'ContextifyScript': Invalid or unexpected token"
'   2. require() of an ESM-only package is unsupported, which plain Node 24 handles
'   3. setInterval is the DOM's - it returns a NUMBER, so `setInterval(...).unref()` throws
'   4. worker_threads cannot create a thread at all: "The V8 platform used by this instance of
'      Node does not support creating Workers"
'
' Every one of those is invisible to a test on a developer machine, because that test runs on real
' Node. BrightSign's own dev-cookbook is unambiguous about which object to use:
'
'   "Use roNodeJs if you need a long running background process or have more complex needs.
'    Use roHtmlWidget with Node.js enabled for browser-based apps."
'   "You can use this for long running processes like gathering metrics or running a web server."
'
' Their cra-template examples are exactly this shape - server in roNodeJs, widget pointed at
' localhost. A server is not a browser-based app.
'
' ⚠️ IT ALSO FIXES THE LIFECYCLE PROBLEM, which was the original objection to running a server on
' this hardware at all. In a widget the server shares the PAGE's life: a load error, a watchdog
' trip or a deploy tears it down mid-write, and an open SQLite WAL goes with it. roNodeJs "will run
' in the background uninterrupted".
'
' NO NATIVE CODE is involved either way: the server reaches SQLite through node:sqlite (built into
' the Node that BrightSignOS 10 ships) via server/db/sqlite-compat.js, so the same bundle runs on
' x86_64 and on this aarch64 player.

Sub Main()
    msgPort = CreateObject("roMessagePort")

    root$ = StorageRoot()
    print "[st-server] volume "; root$

    ' The server writes its database, uploads and certs under here. On the XT245 this is SSD: - the
    ' 128GB NVMe - which is what makes any of this reasonable. bs-server-boot.js exports DATA_DIR as
    ' <its own directory>/data, deliberately OUTSIDE the payload tree, so a payload update replaces
    ' the code without deleting the data.
    CreateDirectory(root$ + "/data")

    ' ------------------------------------------------------------------------------------------
    ' 1. The server - only if this player has been told to be one.
    ' ------------------------------------------------------------------------------------------
    ' ⚠️ OFF UNLESS ASKED. A fleet gets one package; exactly one box per site should host the
    ' server. Defaulting to on would mean every player that ever received this package started
    ' listening on 8181, and the mistake would be invisible until two of them fought over the same
    ' displays. A device with no config file, an unreadable one, or one that says 0 stays a player.
    serverEnabled = ServerEnabled(root$)
    print "[st-server] local server enabled: "; serverEnabled
    ' Only three keys exist here: message_port, node_arguments, arguments. An invented `env:` key is
    ' what killed the first attempt at this file, with nothing but "Load or runtime error in
    ' autorun. Forcing recovery." to go on - and it sent me to the widget for the wrong reason.
    ' Anything the server needs to be told goes in DATA_DIR/server.env, which it reads itself.
    node = invalid
    if serverEnabled then
        node = CreateObject("roNodeJs", "bs-server-boot.js", { message_port: msgPort })
        if node = invalid then
            print "[st-server] FAILED: could not launch the node process"
        else
            print "[st-server] node process launched"
        end if
    end if

    ' ------------------------------------------------------------------------------------------
    ' 2. The screen.
    ' ------------------------------------------------------------------------------------------
    v = CreateObject("roVideoMode")
    w% = 1920
    h% = 1080
    if v <> invalid then
        w% = v.GetResX()
        h% = v.GetResY()
    end if
    rect = CreateObject("roRectangle", 0, 0, w%, h%)

    ' Spelled out rather than casting the boolean: this file cannot be run anywhere but on the
    ' player, so it is not the place for a clever conversion nobody can check.
    serverParam$ = "0"
    if serverEnabled then serverParam$ = "1"

    ' NOTE what is NOT here: nodejs_enabled. The page no longer requires anything - it polls the
    ' server process over HTTP - so it can be an ordinary browser page. One less hybrid context.
    config = {
        ' The page cannot discover this for itself: when the server is off there is no status
        ' listener to ask, and "nothing is answering" would render as a fault rather than as a
        ' deliberate setting.
        url: "file:///" + LCase(StripColon(root$)) + ":/node-server.html?server=" + serverParam$
        javascript_enabled: true
        brightsign_js_objects_enabled: true
        storage_path: root$ + "/widget-cache"
        storage_quota: 1073741824.0
        port: msgPort
        mouse_enabled: false
    }

    widget = CreateObject("roHtmlWidget", rect, config)
    if widget = invalid then
        print "[st-server] FAILED: could not create the diagnostic widget (the server still runs)"
    else
        widget.Show()
        print "[st-server] diagnostic screen shown"
    end if

    ' Stay alive and report. The script must not return, or the player treats it as an autorun that
    ' ended and forces recovery. Both objects also have to stay in scope - dropping the roNodeJs
    ' reference would take the server down with it.
    while true
        ev = Wait(0, msgPort)
        if type(ev) = "roHtmlWidgetEvent" then
            d = ev.GetData()
            if type(d) = "roAssociativeArray" and d.reason <> invalid then
                print "[st-server] widget: "; d.reason
                ' A page that fails to load leaves a black screen and no explanation anywhere.
                if d.reason = "load-error" then print "[st-server] the page failed to load: "; d.message
            end if
        else if type(ev) = "roNodeJsEvent" then
            ' Whatever the node process sends back over the message port. The server does not rely
            ' on this channel - it reports over HTTP so the screen works across page reloads - but
            ' printing it puts node's own messages on the serial console, which is the only window
            ' into a boot that fails before the screen is up.
            print "[st-server] node: "; ev.GetData()
        end if
    end while
End Sub


'*******************************************************************************************
Function ServerEnabled(root$ As String) As Boolean
'*******************************************************************************************
    ' st-config.json on the storage root, e.g. {"server": 1}
    '
    ' Deliberately at the root rather than inside data/: it is what an operator drops in over the
    ' DWS, and autozip never writes it, so a re-provision cannot silently switch a site's server
    ' off - or on.
    '
    ' Absent, unparseable, or anything other than an affirmative value means DISABLED. There is no
    ' reading of a broken config file that should end with a device deciding to host a server.
    txt$ = ReadAsciiFile(root$ + "/st-config.json")
    if txt$ = "" then return false

    cfg = ParseJSON(txt$)
    if cfg = invalid then
        print "[st-server] st-config.json is not valid JSON - server stays disabled"
        return false
    end if
    if type(cfg) <> "roAssociativeArray" then return false

    v = cfg.server
    if v = invalid then return false

    ' Accept the shapes a human actually writes: 1, true, "1", "true", "yes", "on".
    if type(v) = "Boolean" then return v
    if type(v) = "Integer" then return v <> 0
    if type(v) = "roInt" then return v <> 0
    if type(v) = "String" or type(v) = "roString" then
        low$ = LCase(v)
        return low$ = "1" or low$ = "true" or low$ = "yes" or low$ = "on"
    end if
    return false
End Function

'*******************************************************************************************
Function StripColon(v As String) As String
'*******************************************************************************************
    ' "SSD:" -> "SSD". The url form wants file:///ssd:/... and StorageRoot() hands back "SSD:".
    if Right(v, 1) = ":" then return Left(v, Len(v) - 1)
    return v
End Function

'*******************************************************************************************
Function StorageRoot() As String
'*******************************************************************************************
    ' Which volume did we come up from? The server's data has to live on the same one. On the XT245
    ' the card slot is dead and the priority order (flash, usb1, sd, sd2, ssd) resolves to SSD: with
    ' nothing else present - but probe rather than assume, because extracting to a volume that does
    ' not exist silently does nothing.
    for each v in ["SSD:", "SD:", "USB1:", "FLASH:"]
        if CreateObject("roReadFile", v + "/node-server.html") <> invalid then return v
    end for
    return "SSD:"
End Function
