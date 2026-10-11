' ScreenTinker Roku player — entry point.
'
' Deep-link / ECP launch parameters (POST http://<roku>:8060/launch/<channel>?server=...):
'   server   a ScreenTinker server address, saved as this player's server (first-run shortcut, and how
'            a LAN helper or an installer script sets a fleet up without typing on a remote)
'   reset    "identity" forgets the pairing (same as deleting the display in the dashboard)

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
    end if
    scene.launchArgs = launch

    ' A launch while running (ECP /input or a second /launch) arrives as roInputEvent.
    input = CreateObject("roInput")
    input.SetMessagePort(port)

    while true
        msg = wait(0, port)
        t = type(msg)
        if t = "roSGScreenEvent" then
            if msg.IsScreenClosed() then return
        else if t = "roInputEvent" then
            info = msg.GetInfo()
            if ST_IsAA(info) then
                again = {}
                if ST_IsString(info.server) then again.server = info.server
                if ST_IsString(info.reset) then again.reset = info.reset
                if again.Count() > 0 then scene.launchArgs = again
            end if
        end if
    end while
end sub
