' End-to-end protocol test: the Roku's Engine.IO/socket.io code against a real ScreenTinker server.
' Run by tests/run-protocol.js, which starts the server, writes pkg:/e2e.json and pairs the code.
' Synchronous roUrlTransfer on purpose: this checks the WIRE protocol, not the Task threading.

sub Main()
    cfg = ParseJson(ReadAsciiFile("pkg:/e2e.json"))
    server = cfg.server
    nsp = "/device"

    ' 1. open
    body = httpGet(ST_EioUrl(server, ""))
    sid = ""
    for each p in ST_EioDecodePayload(body)
        if p.type = "0" then
            o = ST_EioParseOpen(p.data)
            if o <> invalid then sid = o.sid
        end if
    end for
    if sid = "" then
        print "FAIL open: " + body
        return
    end if
    print "STEP open sid=" + sid

    ' 2. namespace connect
    httpPost(ST_EioUrl(server, sid), ST_SioConnectPacket(nsp))
    connected = false
    for i = 1 to 3
        for each ev in pollOnce(server, sid)
            if ev.type = "0" then connected = true
        end for
        if connected then exit for
    end for
    if not connected then
        print "FAIL namespace connect"
        return
    end if
    print "STEP connected"

    ' 3. register as an unpaired Roku
    reg = {
        pairing_code: cfg.pairing_code,
        device_info: { app_version: "0.1.0", screen_width: 1920, screen_height: 1080, hardware_model: "4802X", hardware_os_version: "14.0.0 build 4321" },
        client_type: "roku", client_version: "0.1.0", platform: "roku",
        capabilities: cfg.capabilities, contract_version: "v4", fingerprint: "roku:e2e-" + cfg.pairing_code
    }
    httpPost(ST_EioUrl(server, sid), ST_SioEncodeEvent(nsp, "device:register", reg))

    deviceId = ""
    token = ""
    paired = false
    gotPlaylist = false
    deadline = ST_NowMs() + 90000
    while ST_NowMs() < deadline and not (paired and gotPlaylist)
        for each ev in pollOnce(server, sid)
            if ev.type = "2" then
                if ev.name = "device:registered" then
                    deviceId = ev.data.device_id
                    if ST_IsString(ev.data.device_token) then token = ev.data.device_token
                    print "REGISTERED " + deviceId + " " + ST_Str(ev.data, "status")
                else if ev.name = "device:paired" then
                    if not paired then
                        paired = true
                        print "STEP paired name=" + ST_Str(ev.data, "name")
                        ' as MainScene does: register again (now with our id/token) for the first playlist
                        again = { device_id: deviceId, device_token: ev.data.device_token, client_type: "roku", platform: "roku", capabilities: cfg.capabilities, contract_version: "v4", fingerprint: reg.fingerprint, device_info: reg.device_info }
                        if again.device_token = invalid then again.device_token = token
                        httpPost(ST_EioUrl(server, sid), ST_SioEncodeEvent(nsp, "device:register", again))
                    end if
                else if ev.name = "device:playlist-update" then
                    n = 0
                    if ST_IsArray(ev.data.assignments) then n = ev.data.assignments.Count()
                    tz = "no"
                    if ST_IsAA(ev.data.tz_table) then tz = "yes spans=" + ev.data.tz_table.spans.Count().ToStr()
                    print "STEP playlist items=" + n.ToStr() + " tz_table=" + tz
                    if paired then gotPlaylist = true
                else
                    print "EVENT " + ev.name
                end if
            end if
        end for
    end while
    if not paired then
        print "FAIL never paired"
        return
    end if

    ' 4. the things a playing Roku sends
    hb = { device_id: deviceId, client_ms: ST_NowMs(), telemetry: { wifi_rssi: -52, local_ip: "10.0.0.9", video_mode: "1080p", timezone: "US/Central" } }
    httpPost(ST_EioUrl(server, sid), ST_SioEncodeEvent(nsp, "device:heartbeat", hb))
    pe = { device_id: deviceId, event: "play_start", content_id: invalid, widget_id: invalid, content_name: "e2e", duration_sec: 10 }
    httpPost(ST_EioUrl(server, sid), ST_SioEncodeEvent(nsp, "device:play-event", pe))
    acked = false
    for i = 1 to 3
        for each ev in pollOnce(server, sid)
            if ev.type = "2" and ev.name = "device:heartbeat-ack" then acked = true
        end for
        if acked then exit for
    end for
    if acked then print "STEP heartbeat acked" else print "FAIL no heartbeat ack"
    print "DONE " + deviceId
end sub

' One long-poll round: answers pings, returns socket.io packets.
function pollOnce(server as string, sid as string) as object
    out = []
    body = httpGet(ST_EioUrl(server, sid))
    for each p in ST_EioDecodePayload(body)
        if p.type = "2" then
            httpPost(ST_EioUrl(server, sid), "3")
        else if p.type = "4" then
            out.Push(ST_SioDecode(p.data))
        end if
    end for
    return out
end function

function httpGet(url as string) as string
    x = CreateObject("roUrlTransfer")
    x.SetUrl(url)
    return x.GetToString()
end function

sub httpPost(url as string, body as string)
    x = CreateObject("roUrlTransfer")
    x.SetUrl(url)
    x.AddHeader("Content-Type", "text/plain;charset=UTF-8")
    x.PostFromString(body)
end sub
