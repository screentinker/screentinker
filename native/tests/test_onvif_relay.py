"""onvif_relay (net/onvif_relay.py): the player's own limits on the server's ONVIF bridge — private
addresses only, header pass-through, size caps, the busy gate — the Probe byte-for-byte equal to the
server's probeMessage(), and real soap/get/probe round trips against tiny local servers.

The round trips run on 127.0.0.1, which the real rule refuses, so they INJECT the address check
(addr_ok) rather than weakening it; test_loopback_is_refused_without_injection proves the default."""
import asyncio
import base64
import http.server
import os
import shutil
import socket
import subprocess
import threading

import pytest

from screentinker_native.net import onvif_relay as r

LOOPBACK_OK = (lambda a: a in ("127.0.0.1", "::1"))

# server/lib/onvif/soap.js probeMessage('uuid:00000000-1111-2222-3333-444444444444'), verbatim.
SERVER_PROBE = (
    '<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" '
    'xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"><s:Header><a:Action s:mustUnderstand="1">'
    'http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action><a:MessageID>'
    'uuid:00000000-1111-2222-3333-444444444444</a:MessageID><a:ReplyTo><a:Address>'
    'http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:Address></a:ReplyTo>'
    '<a:To s:mustUnderstand="1">urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To></s:Header><s:Body>'
    '<Probe xmlns="http://schemas.xmlsoap.org/ws/2005/04/discovery"><Types '
    'xmlns:dn="http://www.onvif.org/ver10/network/wsdl">dn:NetworkVideoTransmitter</Types></Probe>'
    '</s:Body></s:Envelope>')
FIXED_ID = "uuid:00000000-1111-2222-3333-444444444444"
SOAP_JS = os.path.join(os.path.dirname(__file__), "..", "..", "server", "lib", "onvif", "soap.js")


# ---------------------------------------------------------------- the private-address rule
@pytest.mark.parametrize("addr", [
    "10.0.0.1", "10.255.255.254", "172.16.0.1", "172.31.255.254", "192.168.1.64", "169.254.10.20",
    "100.64.0.1", "100.127.255.254", "fd12:3456::1", "fc00::1", "fe80::1", "fe80::1%eth0",
    "::ffff:192.168.1.64", "::ffff:10.1.2.3",
])
def test_private_addresses_are_accepted(addr):
    assert r.is_private_address(addr) is True


@pytest.mark.parametrize("addr", [
    "127.0.0.1", "127.8.8.8", "0.0.0.0", "::1", "::", "8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.255.255",
    "100.128.0.1", "192.169.0.1", "224.0.0.1", "239.255.255.250", "255.255.255.255", "ff02::1",
    "2001:4860:4860::8888", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "::ffff:0.0.0.0", "not-an-ip", "",
    "169.254.169.254", "::ffff:169.254.169.254",
])
def test_everything_else_is_refused(addr):
    assert r.is_private_address(addr) is False


def test_every_resolved_address_must_be_private(monkeypatch):
    def fake(host, port, *a):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("192.168.1.5", port)),
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", port))]
    monkeypatch.setattr(r.socket, "getaddrinfo", fake)
    with pytest.raises(r.RelayError, match="not-private"):
        r.resolve_private("cam.example", 80)


def test_resolved_addresses_are_what_we_connect_to(monkeypatch):
    def fake(host, port, *a):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("192.168.1.5", port)),
                (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("fd00::5", port, 0, 0))]
    monkeypatch.setattr(r.socket, "getaddrinfo", fake)
    got = r.resolve_private("cam.lan", 8080)
    assert [sa[0] for _f, sa in got] == ["192.168.1.5", "fd00::5"]


def test_loopback_is_refused_without_injection():
    with pytest.raises(r.RelayError, match="not-private"):
        r.http_exchange("GET", "http://127.0.0.1:9/x", {}, None, 100, 1000)
    res = asyncio.run(r.perform({"id": "a", "op": "get", "url": "http://localhost:9/x"}))
    assert res == {"id": "a", "ok": False, "error": "not-private"}
    res = asyncio.run(r.perform({"id": "b", "op": "probe", "host": "8.8.8.8"}))
    assert res["ok"] is False and res["error"] == "not-private"


@pytest.mark.parametrize("url", [
    "ftp://192.168.1.5/x", "file:///etc/passwd", "gopher://10.0.0.1/", "http://", "//192.168.1.5/x",
    "http://192.168.1.5/a b", "http://192.168.1.5/\r\nX: y", "http://192.168.1.5:99999/", 5, None,
])
def test_only_http_and_https_urls(url):
    with pytest.raises(r.RelayError, match="bad-url"):
        r.http_exchange("GET", url, {}, None, 100, 1000)


# ---------------------------------------------------------------- headers and limits
def test_only_content_type_and_authorization_pass():
    got = r.filter_headers({"content-type": "application/soap+xml", "AUTHORIZATION": "Digest x",
                            "Host": "evil", "Cookie": "a=b", "X-Forwarded-For": "1.2.3.4",
                            "Transfer-Encoding": "chunked", "Connection": "upgrade"})
    assert got == {"Content-Type": "application/soap+xml", "Authorization": "Digest x"}


def test_header_injection_is_dropped():
    assert r.filter_headers({"Authorization": "Basic a\r\nX-Evil: 1", "Content-Type": "a\nb"}) == {}
    assert r.filter_headers(None) == {} and r.filter_headers(["x"]) == {}


def test_timeouts_default_and_cap():
    assert r.clamp_timeout(None, 8000, 15000) == 8000
    assert r.clamp_timeout(999999, 8000, 15000) == 15000
    assert r.clamp_timeout(999999, 3000, 10000) == 10000
    assert r.clamp_timeout("junk", 3000, 10000) == 3000
    assert r.clamp_timeout(-5, 3000, 10000) == 3000
    assert r.clamp_timeout(1, 3000, 10000) == r.MIN_TIMEOUT_MS


def test_soap_body_over_64k_is_refused_before_any_network():
    with pytest.raises(r.RelayError, match="too-large"):
        r.do_soap({"url": "http://192.168.1.5/onvif", "body": "x" * (64 * 1024 + 1)})
    with pytest.raises(r.RelayError, match="bad-body"):
        r.do_soap({"url": "http://192.168.1.5/onvif", "body": None})


def test_unknown_op_still_gets_one_reply():
    assert asyncio.run(r.perform({"id": "z", "op": "connect"})) == {"id": "z", "ok": False, "error": "bad-op"}
    assert asyncio.run(r.perform(None)) == {"id": "", "ok": False, "error": "bad-op"}


def test_a_fifth_operation_is_busy(monkeypatch):
    gate = threading.Event()

    def slow(p, addr_ok):
        gate.wait(5)
        return {"ok": True, "replies": []}
    monkeypatch.setitem(r._OPS, "probe", slow)

    async def go():
        tasks = [asyncio.ensure_future(r.perform({"id": str(i), "op": "probe"})) for i in range(4)]
        await asyncio.sleep(0.05)
        fifth = await r.perform({"id": "5", "op": "probe"})
        gate.set()
        rest = await asyncio.gather(*tasks)
        after = await r.perform({"id": "6", "op": "probe"})
        return fifth, rest, after
    fifth, rest, after = asyncio.run(go())
    assert fifth == {"id": "5", "ok": False, "error": "busy"}
    assert all(x["ok"] for x in rest) and after["ok"] is True
    assert r._in_flight == 0


# ---------------------------------------------------------------- the Probe
def test_probe_xml_equals_the_servers():
    assert r.probe_message(FIXED_ID) == SERVER_PROBE


@pytest.mark.skipif(not shutil.which("node") or not os.path.exists(SOAP_JS), reason="server/node not here")
def test_probe_xml_equals_the_servers_live():
    js = "process.stdout.write(require(%r).probeMessage(%r))" % (os.path.abspath(SOAP_JS), FIXED_ID)
    out = subprocess.run(["node", "-e", js], capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr
    assert r.probe_message(FIXED_ID) == out.stdout


def test_probe_message_ids_are_fresh():
    a, b = r.probe_message(), r.probe_message()
    assert a != b and "<a:MessageID>uuid:" in a


def test_probe_round_trip_to_one_host():
    srv = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    srv.bind(("127.0.0.1", 0))
    port = srv.getsockname()[1]
    got = []

    def answer():
        srv.settimeout(3)
        try:
            while len(got) < 2:
                data, frm = srv.recvfrom(65536)
                got.append(data)
                srv.sendto(b"<Envelope>match %d</Envelope>" % len(got), frm)
        except socket.timeout:
            pass
    t = threading.Thread(target=answer, daemon=True)
    t.start()
    res = r.do_probe({"host": "127.0.0.1", "timeout_ms": 1000}, addr_ok=LOOPBACK_OK, port=port)
    t.join(5)
    srv.close()
    assert res["ok"] is True
    assert len(got) == 2, "the Probe goes out twice"
    assert got[0].startswith(b'<?xml version="1.0" encoding="UTF-8"?><s:Envelope')
    assert [x["xml"] for x in res["replies"]] == ["<Envelope>match 1</Envelope>", "<Envelope>match 2</Envelope>"]
    assert all(x["from"] == "127.0.0.1" for x in res["replies"])


# ---------------------------------------------------------------- real HTTP round trips
JPEG = b"\xff\xd8\xff\xe0" + b"j" * 1000


class _Cam(http.server.BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        _Cam.seen.append(dict(self.headers.items()))
        if not self.headers.get("Authorization"):
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Digest realm="cam", nonce="1", qop="auth"')
            self.send_header("WWW-Authenticate", 'Basic realm="cam"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if b"Fault" in body:
            out = b"<s:Envelope><s:Body><s:Fault>nope</s:Fault></s:Body></s:Envelope>"
            self.send_response(500)
        else:
            out = b"<s:Envelope>" + body + b"</s:Envelope>"
            self.send_response(200)
        self.send_header("Content-Type", "application/soap+xml; charset=utf-8")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def do_GET(self):
        _Cam.seen.append(dict(self.headers.items()))
        if self.path == "/snap.jpg":
            self._send(200, "image/jpeg", JPEG)
        elif self.path == "/octet":
            self._send(200, "application/octet-stream", JPEG)
        elif self.path == "/big":
            self._send(200, "image/jpeg", b"\xff" * (2 * 1024 * 1024 + 10))
        elif self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "http://8.8.8.8/")
            self.send_header("Content-Length", "0")
            self.end_headers()
        else:
            self._send(404, "text/html", b"<h1>no</h1>")

    def _send(self, status, ct, data):
        self.send_response(status)
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@pytest.fixture
def cam():
    _Cam.seen = []
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Cam)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield "http://127.0.0.1:%d" % srv.server_address[1]
    srv.shutdown()
    srv.server_close()


def _relay(p):
    return asyncio.run(r.perform(p, addr_ok=LOOPBACK_OK))


def test_soap_401_challenge_comes_back_with_every_header(cam):
    res = _relay({"id": "1", "op": "soap", "url": cam + "/onvif/device_service", "body": "<GetX/>",
                  "headers": {"content-type": "application/soap+xml"}})
    assert res["id"] == "1" and res["ok"] is False and res["status"] == 401
    assert res["headers"]["www-authenticate"] == ['Digest realm="cam", nonce="1", qop="auth"', 'Basic realm="cam"']
    assert res["body"] == ""


def test_soap_success_and_header_filtering(cam):
    res = _relay({"id": "2", "op": "soap", "url": cam + "/onvif/device_service", "body": "<GetX>é</GetX>",
                  "headers": {"Content-Type": "application/soap+xml", "Authorization": "Digest y",
                              "Cookie": "s=1", "X-Api-Key": "k"}})
    assert res["ok"] is True and res["status"] == 200
    assert res["body"] == "<s:Envelope><GetX>é</GetX></s:Envelope>"
    assert res["headers"]["content-type"].startswith("application/soap+xml")
    sent = {k.lower(): v for k, v in _Cam.seen[-1].items()}
    assert "cookie" not in sent and "x-api-key" not in sent
    assert sent["authorization"] == "Digest y" and sent["host"] == cam.split("//")[1]


def test_soap_fault_is_a_normal_reply(cam):
    res = _relay({"id": "3", "op": "soap", "url": cam + "/x", "body": "<Fault/>", "headers": {"Authorization": "a"}})
    assert res["ok"] is False and res["status"] == 500 and "s:Fault" in res["body"] and "error" not in res


def test_get_image_is_base64(cam):
    res = _relay({"id": "4", "op": "get", "url": cam + "/snap.jpg"})
    assert res["ok"] is True and res["status"] == 200 and base64.b64decode(res["body_b64"]) == JPEG
    res = _relay({"id": "5", "op": "get", "url": cam + "/octet"})
    assert base64.b64decode(res["body_b64"]) == JPEG, "JPEG magic counts as an image"


def test_get_non_image_has_no_body(cam):
    res = _relay({"id": "6", "op": "get", "url": cam + "/missing"})
    assert res["ok"] is False and res["status"] == 404 and "body_b64" not in res and "body" not in res


def test_get_over_2mb_is_too_large(cam):
    res = _relay({"id": "7", "op": "get", "url": cam + "/big"})
    assert res == {"id": "7", "ok": False, "error": "too-large"}


def test_redirects_are_not_followed(cam):
    n = len(_Cam.seen)
    res = _relay({"id": "8", "op": "get", "url": cam + "/redirect"})
    assert res["status"] == 302 and res["ok"] is False and "body_b64" not in res
    assert len(_Cam.seen) == n + 1


def test_connection_refused_is_an_error_reply():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    res = _relay({"id": "9", "op": "soap", "url": "http://127.0.0.1:%d/" % port, "body": "<x/>"})
    assert res["id"] == "9" and res["ok"] is False and res["error"].startswith("unreachable")


def test_a_silent_camera_times_out():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    s.listen(1)                       # accepts, never answers
    try:
        res = _relay({"id": "10", "op": "get", "url": "http://127.0.0.1:%d/" % s.getsockname()[1], "timeout_ms": 600})
    finally:
        s.close()
    assert res == {"id": "10", "ok": False, "error": "timeout"}
