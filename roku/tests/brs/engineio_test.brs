' Unit tests for source/lib/engineio.brs. Run by tests/run-protocol.js in brs-node.
' Prints "PASS <name>" / "FAIL <name>: <detail>" and finally "DONE <passes> <fails>".

sub Main()
    t = { pass: 0, fail: 0 }

    ' --- payload framing
    pk = ST_EioDecodePayload("0{" + Chr(34) + "sid" + Chr(34) + ":" + Chr(34) + "abc" + Chr(34) + "}" + Chr(30) + "2" + Chr(30) + "42/device," + "[" + Chr(34) + "x" + Chr(34) + "]")
    check(t, "decode splits on U+001E", pk.Count() = 3)
    check(t, "decode keeps type", pk[0].type = "0" and pk[1].type = "2" and pk[2].type = "4")
    check(t, "decode keeps data", pk[2].data = "2/device,[" + Chr(34) + "x" + Chr(34) + "]")
    check(t, "decode empty body", ST_EioDecodePayload("").Count() = 0)

    open = ST_EioParseOpen(pk[0].data)
    check(t, "open packet sid", open <> invalid and open.sid = "abc")
    check(t, "open packet rejects junk", ST_EioParseOpen("nope") = invalid)

    body = ST_EioEncodePayload(["3", "42/device,[]"])
    check(t, "encode joins with U+001E", body = "3" + Chr(30) + "42/device,[]")

    ' --- socket.io packets
    check(t, "connect packet", ST_SioConnectPacket("/device") = "40/device,")
    check(t, "connect packet root", ST_SioConnectPacket("/") = "40")

    ev = ST_SioEncodeEvent("/device", "device:heartbeat", { device_id: "d1", n: 5 })
    check(t, "encode event prefix", Left(ev, 10) = "42/device,")
    back = ST_SioDecode(Mid(ev, 2))
    check(t, "round trip name", back.name = "device:heartbeat")
    check(t, "round trip data", back.data <> invalid and back.data.device_id = "d1" and back.data.n = 5)
    check(t, "round trip nsp", back.nsp = "/device")

    c = ST_SioDecode("0/device," + "{" + Chr(34) + "sid" + Chr(34) + ":" + Chr(34) + "s9" + Chr(34) + "}")
    check(t, "connect ack", c.type = "0" and c.nsp = "/device" and c.data.sid = "s9")

    a = ST_SioDecode("2/device,17[" + Chr(34) + "ping-me" + Chr(34) + ",{}]")
    check(t, "event with ack id", a.type = "2" and a.ackId = 17 and a.name = "ping-me")

    noData = ST_SioDecode("2/device,[" + Chr(34) + "device:screenshot-request" + Chr(34) + "]")
    check(t, "event without payload", noData.name = "device:screenshot-request" and noData.data = invalid)

    err = ST_SioDecode("4/device,{" + Chr(34) + "message" + Chr(34) + ":" + Chr(34) + "nope" + Chr(34) + "}")
    check(t, "connect error", err.type = "4" and err.data.message = "nope")

    bin = ST_SioDecode("51-/device,[" + Chr(34) + "x" + Chr(34) + ",{" + Chr(34) + "_placeholder" + Chr(34) + ":true}]")
    check(t, "binary is recognised and not parsed", bin.type = "5" and bin.name = "")

    ack = ST_SioEncodeAck("/device", 17, [])
    check(t, "ack packet", ack = "43/device,17[]")

    ' --- unicode survives a round trip (names and messages are not ASCII everywhere)
    u = ST_SioEncodeEvent("/device", "device:log", { message: "Größe 東京 मुंबई" })
    ub = ST_SioDecode(Mid(u, 2))
    check(t, "unicode round trip", ub.data.message = "Größe 東京 मुंबई")

    ' --- big integers (epoch ms) survive ParseJson
    big = ST_SioDecode("2/device,[" + Chr(34) + "t" + Chr(34) + ",{" + Chr(34) + "server_ms" + Chr(34) + ":1791725440123}]")
    ms& = big.data.server_ms
    check(t, "epoch ms parses as a long", ms& = 1791725440123&)

    ' --- URLs
    url = ST_EioUrl("https://example.test/", "a b")
    check(t, "poll url", Instr(1, url, "https://example.test/socket.io/?EIO=4&transport=polling&sid=a%20b&t=") = 1)

    ' --- util
    check(t, "normalise adds https", ST_NormaliseServerUrl(" screentinker.com/ ") = "https://screentinker.com")
    check(t, "normalise keeps http", ST_NormaliseServerUrl("http://10.0.0.5:3001") = "http://10.0.0.5:3001")
    check(t, "is off 0", ST_IsOff(0))
    check(t, "is off false", ST_IsOff(false))
    check(t, "invalid is not off", not ST_IsOff(invalid))
    check(t, "1 is not off", not ST_IsOff(1))
    code = ST_NewPairingCode()
    check(t, "pairing code is 6 digits", Len(code) = 6 and Val(code) >= 100000)
    check(t, "item kind widget", ST_ItemKind({ widget_id: "w1" }) = "raster")
    check(t, "item kind mp4", ST_ItemKind({ content_id: "c", mime_type: "video/mp4" }) = "video")
    check(t, "item kind hls", ST_ItemKind({ content_id: "c", mime_type: "video/hls" }) = "stream")
    check(t, "item kind rtsp skipped", ST_ItemKind({ content_id: "c", mime_type: "video/rtsp" }) = "skip")
    check(t, "item kind jpeg", ST_ItemKind({ content_id: "c", mime_type: "image/jpeg" }) = "image")
    check(t, "item kind web page rendered", ST_ItemKind({ content_id: "c", mime_type: "text/html" }) = "raster")
    check(t, "item kind pdf rendered", ST_ItemKind({ content_id: "c", mime_type: "application/pdf" }) = "raster")
    mu = ST_MediaUrl("https://s.test", { filepath: "ab/cd.mp4", content_rev: "7" })
    check(t, "media url uses uploads + rev", mu = "https://s.test/uploads/content/ab/cd.mp4?rev=7")
    check(t, "media url prefers presigned", ST_MediaUrl("https://s.test", { file_url: "https://b.test/x", filepath: "y" }) = "https://b.test/x")
    check(t, "colour #rgb", ST_ColorOr("#0af", "x") = "0x00AAFFFF")
    check(t, "colour #rrggbb", ST_ColorOr("#112233", "x") = "0x112233FF")
    check(t, "colour junk", ST_ColorOr("red", "dflt") = "dflt")

    ' --- native clock text (en-US, as routes/widgets.js renderClock() formats it)
    pm = { year: 2026, month: 10, day: 11, hour: 21, minute: 5, second: 3, dow: 0 }
    am = { year: 2026, month: 1, day: 2, hour: 0, minute: 0, second: 9, dow: 5 }
    check(t, "clock 12h pm", ST_ClockTime(pm, false, true) = "09:05:03 PM")
    check(t, "clock 12h midnight", ST_ClockTime(am, false, true) = "12:00:09 AM")
    check(t, "clock 24h no seconds", ST_ClockTime(pm, true, false) = "21:05")
    check(t, "date full", ST_ClockDate(pm, "") = "Sunday, October 11, 2026")
    check(t, "date long", ST_ClockDate(pm, "long") = "October 11, 2026")
    check(t, "date medium", ST_ClockDate(am, "medium") = "Jan 2, 2026")
    check(t, "date short", ST_ClockDate(am, "short") = "01/02/26")

    print "DONE " + t.pass.ToStr() + " " + t.fail.ToStr()
end sub

sub check(t as object, name as string, ok as boolean)
    if ok then
        t.pass = t.pass + 1
        print "PASS " + name
    else
        t.fail = t.fail + 1
        print "FAIL " + name
    end if
end sub
