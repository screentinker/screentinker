' QueueTask: long-lived worker for the queue chime's polls. One request field, one result field.

sub init()
    m.top.functionName = "runQueue"
end sub

sub runQueue()
    port = CreateObject("roMessagePort")
    m.top.observeField("request", port)
    ' ⚠️ THE FIRST REQUEST CAN COME BEFORE THIS THREAD OBSERVES IT. ZonePlayer creates this task when
    ' a queue widget first comes on screen and polls at once; a request set before observeField()
    ' raises no event here, and the zone would wait for its answer forever. So answer it now.
    first = m.top.request
    if ST_IsAA(first) then m.top.result = fetchQueue(first, port)
    while true
        msg = wait(0, port)
        if type(msg) = "roSGNodeEvent" and msg.GetField() = "request" then
            req = msg.GetData()
            if ST_IsAA(req) then m.top.result = fetchQueue(req, port)
        end if
    end while
end sub

function fetchQueue(req as object, port as object) as object
    res = { seq: req.seq, ok: false, status: 0, json: invalid }
    url = ST_Str(req, "url")
    if url = "" then return res
    x = CreateObject("roUrlTransfer")
    x.SetUrl(url)
    x.SetMessagePort(port)
    if Left(LCase(url), 5) = "https" then
        x.SetCertificatesFile("common:/certs/ca-bundle.crt")
        x.InitClientCertificates()
    end if
    x.RetainBodyOnError(false)
    x.AddHeader("Accept", "application/json")
    x.AddHeader("X-ST-Client", "roku")
    if not x.AsyncGetToString() then return res
    ' The page gives up after 8 s; so does this, and the next poll tries again.
    deadline = ST_NowMs() + 8000
    while ST_NowMs() < deadline
        msg = wait(500, port)
        if type(msg) = "roUrlEvent" and msg.GetSourceIdentity() = x.GetIdentity() then
            res.status = msg.GetResponseCode()
            if res.status = 200 then
                j = ParseJson(msg.GetString())
                if ST_IsAA(j) then
                    res.ok = true
                    res.json = j
                end if
            end if
            return res
        end if
    end while
    x.AsyncCancel()
    return res
end function
