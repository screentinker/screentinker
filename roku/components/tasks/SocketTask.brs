' SocketTask — socket.io over Engine.IO v4 long-polling, in a Task thread.
'
' One GET is always held open (the server answers it when it has something to say, or with a ping),
' and POSTs carry what we send. Engine.IO refuses two overlapping POSTs from one session ("overlap"),
' so outbound packets queue and go one POST at a time, batched with the U+001E separator.
'
' ⚠️ A DEAD NETWORK DOES NOT FAIL A HELD GET — IT JUST NEVER ANSWERS. The only way to notice is the
' server's own heartbeat: it pings every pingInterval and expects us to hear from it within
' pingInterval + pingTimeout. Past that deadline the poll is cancelled and the session rebuilt,
' exactly as a browser client's ping timeout does.

sub init()
    m.top.functionName = "runSocket"
end sub

sub runSocket()
    m.port = CreateObject("roMessagePort")
    m.top.observeField("outbound", m.port)
    m.top.observeField("control", m.port)
    m.queue = []
    m.seq = 0
    m.backoffMs = 1000
    ' ⚠️ READ FIELDS ONCE. Every m.top.<field> read from a Task thread is a rendezvous with the render
    ' thread; doing it in the loop costs a round trip per iteration on a real device. Changes arrive
    ' as observer events instead (handleMessage).
    m.server = m.top.serverUrl
    m.nsp = m.top.namespace
    m.debug = m.top.debug
    m.stopping = false
    resetSession()

    while true
        if m.stopping then
            closeSession("stopped")
            m.top.state = "closed"
            return
        end if

        if m.sid = "" then
            if handshake() then
                ST_Log("socket", "handshake ok, session open")
            else
                ' ⚠️ LOG EVERY FAILED HANDSHAKE. It used to fail silently: after a server close the console
                ' went quiet for the rest of a run while the app backed off 1, 2, 4 ... 30 s, and nothing on
                ' screen or in the log said why it never came back (CI, 2026-10-12, twice).
                ST_Log("socket", "handshake failed: " + m.top.lastError + "; retrying in " + Int(m.backoffMs / 1000).ToStr() + " s")
                waitAndPump(m.backoffMs)
                m.backoffMs = m.backoffMs * 2
                if m.backoffMs > 30000 then m.backoffMs = 30000
            end if
        else
            ensurePoll()
            ensurePost()
            msg = wait(500, m.port)
            if msg <> invalid then handleMessage(msg)
            if m.sid <> "" and ST_NowMs() - m.lastHeard > m.deadlineMs then
                m.top.lastError = "ping timeout"
                closeSession("ping timeout")
            else if m.post <> invalid and ST_NowMs() - m.postStartMs > 15000 then
                ' ⚠️ A POST is answered at once ("ok"); one that has not come back in 15 s is lost
                ' (a dropped connection, or a completion event that never arrived). Waiting for the
                ' ping deadline instead left a fresh display unregistered for ~50 s. Rebuilding the
                ' session re-sends what was in flight and re-registers on the new CONNECT.
                m.top.lastError = "post timeout"
                closeSession("post timeout")
            end if
        end if
    end while
end sub

sub resetSession()
    m.sid = ""
    m.poll = invalid
    m.post = invalid
    m.inFlight = []
    m.connected = false
    m.lastHeard = ST_NowMs()
    m.deadlineMs = 60000&
end sub

' Wait up to ms, but keep accepting outbound emits and control changes while we do.
sub waitAndPump(ms as integer)
    deadline = ST_NowMs() + ms
    while ST_NowMs() < deadline
        msg = wait(250, m.port)
        if msg <> invalid then handleMessage(msg)
        if m.stopping then return
    end while
end sub

function newTransfer(url as string) as object
    x = CreateObject("roUrlTransfer")
    x.SetUrl(url)
    x.SetMessagePort(m.port)
    if Left(LCase(url), 5) = "https" then
        x.SetCertificatesFile("common:/certs/ca-bundle.crt")
        x.InitClientCertificates()
    end if
    x.EnableEncodings(true)
    x.RetainBodyOnError(true)
    x.AddHeader("Content-Type", "text/plain;charset=UTF-8")
    x.AddHeader("X-ST-Client", "roku")
    return x
end function

' GET the open packet, then POST the namespace CONNECT. The CONNECT reply comes on the next poll.
function handshake() as boolean
    m.top.state = "connecting"
    base = m.server
    if base = "" then return false
    x = newTransfer(ST_EioUrl(base, ""))
    m.top.lastError = ""   ' cleared BEFORE the request, so what syncGet records is this attempt's
    body = syncGet(x, 15000)
    if body = invalid then
        if m.top.lastError = "" then m.top.lastError = "no response"
        return false
    end if
    open = invalid
    for each p in ST_EioDecodePayload(body)
        if p.type = "0" then open = ST_EioParseOpen(p.data)
    end for
    if open = invalid then
        m.top.lastError = "no open packet"
        return false
    end if
    m.sid = open.sid
    pi = 25000&
    pt = 20000&
    if ST_IsNumber(open.pingInterval) then pi = open.pingInterval
    if ST_IsNumber(open.pingTimeout) then pt = open.pingTimeout
    m.deadlineMs = pi + pt + 5000&
    m.lastHeard = ST_NowMs()
    m.queue.Unshift(ST_SioConnectPacket(m.nsp))
    return true
end function

' A blocking GET in this thread with our own timeout (roUrlTransfer has none for a held request).
function syncGet(x as object, timeoutMs as integer) as dynamic
    if not x.AsyncGetToString() then return invalid
    deadline = ST_NowMs() + timeoutMs
    while ST_NowMs() < deadline
        msg = wait(250, m.port)
        if type(msg) = "roUrlEvent" then
            if msg.GetSourceIdentity() = x.GetIdentity() then
                if msg.GetResponseCode() = 200 then return msg.GetString()
                m.top.lastError = "handshake HTTP " + msg.GetResponseCode().ToStr() + " " + msg.GetFailureReason()
                return invalid
            end if
        else if msg <> invalid then
            handleMessage(msg)
        end if
    end while
    x.AsyncCancel()
    m.top.lastError = "handshake timeout"
    return invalid
end function

sub ensurePoll()
    if m.poll <> invalid or m.sid = "" then return
    x = newTransfer(ST_EioUrl(m.server, m.sid))
    if x.AsyncGetToString() then
        m.poll = x
        if m.debug then ST_Log("eio", "poll start id=" + x.GetIdentity().ToStr())
    else
        closeSession("poll failed to start")
    end if
end sub

sub ensurePost()
    if m.post <> invalid or m.sid = "" or m.queue.Count() = 0 then return
    batch = []
    ' keep a POST comfortably under the server's maxHttpBufferSize; a screenshot-sized packet
    ' simply goes alone
    size = 0
    while m.queue.Count() > 0 and (batch.Count() = 0 or size + Len(m.queue[0]) < 900000)
        p = m.queue.Shift()
        size = size + Len(p)
        batch.Push(p)
    end while
    x = newTransfer(ST_EioUrl(m.server, m.sid))
    if x.AsyncPostFromString(ST_EioEncodePayload(batch)) then
        m.post = x
        m.postStartMs = ST_NowMs()
        m.inFlight = batch
        if m.debug then ST_Log("eio", "post start id=" + x.GetIdentity().ToStr() + " " + Left(ST_EioEncodePayload(batch), 60))
    else
        ' put them back in order and let the session rebuild
        for i = batch.Count() - 1 to 0 step -1
            m.queue.Unshift(batch[i])
        end for
        closeSession("post failed to start")
    end if
end sub

sub handleMessage(msg as object)
    t = type(msg)
    if t = "roSGNodeEvent" then
        f = msg.GetField()
        if f = "outbound" then
            ev = msg.GetData()
            if ST_IsAA(ev) and ST_IsString(ev.name) then
                if ev.name <> "device:heartbeat" then ST_Log("socket", "emit " + ev.name)
                m.queue.Push(ST_SioEncodeEvent(m.nsp, ev.name, ev.data))
            end if
        else if f = "control" then
            c = msg.GetData()
            if c = "reconnect" then closeSession("reconnect requested")
            if c = "stop" then m.stopping = true
        end if
    else if t = "roUrlEvent" then
        id = msg.GetSourceIdentity()
        if m.debug then ST_Log("eio", "event id=" + id.ToStr() + " code=" + msg.GetResponseCode().ToStr() + " body=" + Left(msg.GetString(), 60))
        if m.poll <> invalid and id = m.poll.GetIdentity() then
            m.poll = invalid
            onPollResponse(msg)
        else if m.post <> invalid and id = m.post.GetIdentity() then
            m.post = invalid
            if msg.GetResponseCode() = 200 then
                m.inFlight = []
            else
                ' the session is gone; what we were sending goes with the next one
                for i = m.inFlight.Count() - 1 to 0 step -1
                    m.queue.Unshift(m.inFlight[i])
                end for
                m.inFlight = []
                m.top.lastError = "post HTTP " + msg.GetResponseCode().ToStr()
                closeSession("post rejected")
            end if
        end if
    end if
end sub

sub onPollResponse(msg as object)
    code = msg.GetResponseCode()
    if code <> 200 then
        m.top.lastError = "poll HTTP " + code.ToStr() + " " + msg.GetFailureReason()
        closeSession("poll rejected")
        return
    end if
    m.lastHeard = ST_NowMs()
    for each p in ST_EioDecodePayload(msg.GetString())
        if p.type = "2" then
            m.queue.Unshift("3" + p.data)
        else if p.type = "1" then
            ' The server ended this Engine.IO session itself (socket.disconnect, a refused reconnect, a
            ' superseded transport). Say so in lastError, which closeSession prints.
            m.top.lastError = "engine.io close from server"
            closeSession("server closed")
            return
        else if p.type = "4" then
            onSocketIo(ST_SioDecode(p.data))
        end if
    end for
end sub

sub onSocketIo(pkt as object)
    if pkt.nsp <> m.nsp and not (m.nsp = "/" and pkt.nsp = "/") then return
    if pkt.type = "0" then
        m.connected = true
        m.backoffMs = 1000
        m.top.state = "open"
        emitInbound("__connect", pkt.data)
    else if pkt.type = "4" then
        m.top.lastError = "connect error"
        emitInbound("__connect_error", pkt.data)
        closeSession("connect error")
    else if pkt.type = "1" then
        closeSession("namespace disconnect")
    else if pkt.type = "2" then
        emitInbound(pkt.name, pkt.data)
        ' The server's handlers never need an answer from a player today, but an event that asks
        ' for one must get it or the server-side callback leaks until the socket closes.
        if pkt.ackId >= 0 then m.queue.Push(ST_SioEncodeAck(m.nsp, pkt.ackId, []))
    end if
end sub

sub emitInbound(name as string, data as dynamic)
    m.seq = m.seq + 1
    m.top.inbound = { name: name, data: data, seq: m.seq }
end sub

sub closeSession(reason as string)
    ST_Log("socket", "session closed: " + reason + " (" + m.top.lastError + ")")
    if m.poll <> invalid then m.poll.AsyncCancel()
    if m.post <> invalid then m.post.AsyncCancel()
    for i = m.inFlight.Count() - 1 to 0 step -1
        m.queue.Unshift(m.inFlight[i])
    end for
    wasConnected = m.connected
    resetSession()
    ' a CONNECT queued for the old session must not ride the new one twice
    keep = []
    for each p in m.queue
        if Left(p, 2) <> "40" and Left(p, 1) <> "3" then keep.Push(p)
    end for
    m.queue = keep
    m.top.state = "connecting"
    if wasConnected then emitInbound("__disconnect", { reason: reason })
end sub
