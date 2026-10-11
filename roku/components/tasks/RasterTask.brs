' RasterTask — long-lived worker: one request field, one result field, requests served in order.

sub init()
    m.top.functionName = "runRaster"
end sub

sub runRaster()
    port = CreateObject("roMessagePort")
    m.top.observeField("request", port)
    fs = CreateObject("roFileSystem")
    if not fs.Exists("tmp:/st") then fs.CreateDirectory("tmp:/st")
    while true
        msg = wait(0, port)
        if type(msg) = "roSGNodeEvent" and msg.GetField() = "request" then
            req = msg.GetData()
            if ST_IsAA(req) then m.top.result = fetchFrame(req, port)
        end if
    end while
end sub

function fetchFrame(req as object, port as object) as object
    res = { seq: req.seq, key: ST_Str(req, "key"), ok: false, status: 0, path: "", etag: "", refreshIn: 0, error: "" }
    url = ST_Str(req, "url")
    if url = "" then
        res.error = "no url"
        return res
    end if
    ' Alternate between two files per key, so the frame on screen is never the file being written.
    slot = "a"
    if ST_Str(req, "slot") = "a" then slot = "b"
    path = "tmp:/st/" + res.key + "-" + slot + ".img"

    x = CreateObject("roUrlTransfer")
    x.SetUrl(url)
    x.SetMessagePort(port)
    if Left(LCase(url), 5) = "https" then
        x.SetCertificatesFile("common:/certs/ca-bundle.crt")
        x.InitClientCertificates()
    end if
    x.RetainBodyOnError(false)
    token = ST_Str(req, "token")
    if token <> "" then x.AddHeader("Authorization", "Bearer " + token)
    etag = ST_Str(req, "etag")
    if etag <> "" then x.AddHeader("If-None-Match", etag)
    x.AddHeader("Accept", "image/jpeg, image/png")
    x.AddHeader("X-ST-Client", "roku")

    if not x.AsyncGetToFile(path) then
        res.error = "could not start"
        return res
    end if
    ' Chromium renders take a few seconds; 40 s covers a cold browser plus a slow page.
    deadline = ST_NowMs() + 40000
    while ST_NowMs() < deadline
        msg = wait(500, port)
        if type(msg) = "roUrlEvent" and msg.GetSourceIdentity() = x.GetIdentity() then
            res.status = msg.GetResponseCode()
            headers = msg.GetResponseHeaders()
            if ST_IsAA(headers) then
                res.etag = ST_Str(headers, "etag")
                res.refreshIn = Int(ST_Num(headers, "x-st-refresh-in", 0))
            end if
            if res.status = 200 then
                res.ok = true
                res.path = path
                res.slot = slot
            else if res.status = 304 then
                res.ok = true
                res.notModified = true
                if res.etag = "" then res.etag = etag
            else
                res.error = "HTTP " + res.status.ToStr() + " " + msg.GetFailureReason()
            end if
            return res
        end if
    end while
    x.AsyncCancel()
    res.error = "timeout"
    return res
end function
