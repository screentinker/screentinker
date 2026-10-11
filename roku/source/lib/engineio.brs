' Engine.IO v4 (polling transport) + socket.io v5 packet codec.
'
' A Roku has no WebSocket, but Engine.IO's HTTP long-polling transport is plain GET/POST, which
' roUrlTransfer does fine. That is the whole reason this player can speak the SAME protocol as every
' other ScreenTinker player instead of a parallel REST API: the server's device:register,
' device:playlist-update, device:command and play-event handlers are reached unchanged.
'
' Wire format (https://socket.io/docs/v4/engine-io-protocol/):
'   payload  = packet ( U+001E packet )*
'   packet   = <type digit> <data>        0 open, 1 close, 2 ping, 3 pong, 4 message, 5 upgrade, 6 noop
'   message  = socket.io packet:  <type digit> [<nsp> ","] [<ack id>] [<json>]
'              0 CONNECT, 1 DISCONNECT, 2 EVENT, 3 ACK, 4 CONNECT_ERROR, 5 BINARY_EVENT, 6 BINARY_ACK
'
' ⚠️ BINARY PACKETS ARE NOT SUPPORTED, BY DESIGN. Over polling a binary attachment arrives base64
' with a "b" prefix and needs a placeholder-reassembly step. The server never sends a Buffer to a
' device (screenshots go the other way, and as base64 strings), so a binary packet is decoded as
' type "5" and ignored rather than half-handled.

function ST_EioSeparator() as string
    return Chr(30)
end function

' Split a polling response body into Engine.IO packets: [{ type: "4", data: "..." }, ...]
function ST_EioDecodePayload(body as string) as object
    out = []
    if body = invalid or body = "" then return out
    parts = body.Split(ST_EioSeparator())
    for each p in parts
        if Len(p) > 0 then
            out.Push({ type: Left(p, 1), data: Mid(p, 2) })
        end if
    end for
    return out
end function

' Join packets into one POST body. Each packet is { type, data } or a ready string "4...".
function ST_EioEncodePayload(packets as object) as string
    s = ""
    first = true
    for each p in packets
        if not first then s = s + ST_EioSeparator()
        first = false
        if ST_IsString(p) then
            s = s + p
        else
            s = s + p.type + ST_Str(p, "data")
        end if
    end for
    return s
end function

' The Engine.IO "open" packet's JSON: { sid, pingInterval, pingTimeout, maxPayload } or invalid.
function ST_EioParseOpen(data as string) as object
    j = ParseJson(data)
    if not ST_IsAA(j) then return invalid
    if not ST_IsString(j.sid) then return invalid
    return j
end function

' A socket.io CONNECT for a namespace, as an Engine.IO message packet ("40/device,").
function ST_SioConnectPacket(nsp as string) as string
    if nsp = "" or nsp = "/" then return "40"
    return "40" + nsp + ","
end function

' An EVENT packet: 42/device,["name",{...}] — ready to POST (Engine.IO type 4 included).
function ST_SioEncodeEvent(nsp as string, name as string, data as dynamic) as string
    arr = [name]
    if data <> invalid then arr.Push(data)
    head = "42"
    if nsp <> "" and nsp <> "/" then head = head + nsp + ","
    return head + FormatJson(arr)
end function

' Decode the data of an Engine.IO message packet (the part after the leading "4").
' Returns { type: "0".."6", nsp: "/device", ackId: integer or -1, name: string, data: dynamic, raw: string }
function ST_SioDecode(packetData as string) as object
    r = { type: "", nsp: "/", ackId: -1, name: "", data: invalid, raw: packetData }
    if packetData = invalid or Len(packetData) = 0 then return r
    r.type = Left(packetData, 1)
    rest = Mid(packetData, 2)
    ' binary types carry "<n>-" attachment count first; we do not reassemble them
    if r.type = "5" or r.type = "6" then return r
    if Left(rest, 1) = "/" then
        comma = Instr(1, rest, ",")
        if comma > 0 then
            r.nsp = Left(rest, comma - 1)
            rest = Mid(rest, comma + 1)
        else
            r.nsp = rest
            rest = ""
        end if
    end if
    ' optional ack id: leading digits before the JSON
    digits = ""
    i = 1
    while i <= Len(rest)
        c = Mid(rest, i, 1)
        if c >= "0" and c <= "9" then
            digits = digits + c
            i = i + 1
        else
            exit while
        end if
    end while
    if digits <> "" then
        r.ackId = Val(digits)
        rest = Mid(rest, i)
    end if
    if rest <> "" then
        j = ParseJson(rest)
        if r.type = "2" or r.type = "3" then
            if ST_IsArray(j) and j.Count() > 0 then
                if r.type = "2" then
                    if ST_IsString(j[0]) then r.name = j[0]
                    if j.Count() > 1 then r.data = j[1]
                else
                    r.data = j
                end if
            end if
        else
            r.data = j
        end if
    end if
    return r
end function

' An ACK packet answering a server event that asked for one: 43/device,<id>[...]
function ST_SioEncodeAck(nsp as string, ackId as integer, args as object) as string
    head = "43"
    if nsp <> "" and nsp <> "/" then head = head + nsp + ","
    return head + ackId.ToStr() + FormatJson(args)
end function

' The polling URL for a server: https://host/socket.io/?EIO=4&transport=polling[&sid=..]&t=..
function ST_EioUrl(serverUrl as string, sid as string) as string
    u = ST_UrlJoin(serverUrl, "/socket.io/?EIO=4&transport=polling")
    if sid <> "" then u = u + "&sid=" + ST_UrlEncode(sid)
    return u + "&t=" + ST_RandomHex(8)
end function
