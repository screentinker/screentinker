' ScreenTinker Roku player — entry point.
'
' Deep-link / ECP launch parameters (POST http://<roku>:8060/launch/<channel>?server=...):
'   server   a ScreenTinker server address, saved as this player's server (first-run shortcut, and how
'            a LAN helper or an installer script sets a fleet up without typing on a remote)
'   reset    "identity" forgets the pairing (same as deleting the display in the dashboard)
'
' Roku's own deep links (contentId + mediaType, from search, voice or the certification tests) are
' accepted too. A signage player has no catalogue to open a title from: whatever the link names, it
' opens the player, which then plays what the dashboard assigned (certification 5.1).

sub Main(args as dynamic)
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.SetMessagePort(port)
    scene = screen.CreateScene("MainScene")
    screen.Show()

    launch = {}
    if ST_IsAA(args) then
        if ST_IsString(args.server) then launch.server = args.server
        if ST_IsString(args.reset) then launch.reset = args.reset
        if ST_IsString(args.debug) then launch.debug = args.debug
        logDeepLink(args)
    end if
    scene.launchArgs = launch
    scene.observeField("exitRequested", port)

    ' A launch while running (ECP /input or a second /launch) arrives as roInputEvent.
    input = CreateObject("roInput")
    input.SetMessagePort(port)

    while true
        msg = wait(0, port)
        t = type(msg)
        if t = "roSGScreenEvent" then
            if msg.IsScreenClosed() then return
        else if t = "roSGNodeEvent" then
            if msg.GetField() = "exitRequested" and msg.GetData() = true then
                screen.Close()
                return
            end if
        else if t = "roInputEvent" then
            info = msg.GetInfo()
            if ST_IsAA(info) then
                logDeepLink(info)
                again = {}
                if ST_IsString(info.server) then again.server = info.server
                if ST_IsString(info.reset) then again.reset = info.reset
                if again.Count() > 0 then scene.launchArgs = again
            end if
        end if
    end while
end sub

sub logDeepLink(a as object)
    if ST_IsString(a.contentId) or ST_IsString(a.mediaType) then
        c = ""
        mt = ""
        if ST_IsString(a.contentId) then c = a.contentId
        if ST_IsString(a.mediaType) then mt = a.mediaType
        ST_Log("launch", "deep link contentId=" + c + " mediaType=" + mt + ", opening the player")
    end if
end sub
