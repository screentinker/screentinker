"""rtsps:// on the native player: the certificate check, the loopback relay that hands the checked
connection to Qt as plain RTSP (FFmpeg itself accepts any certificate), the default port, log
redaction, the per-item tls_self_signed flag, and the backoff when the only playable item keeps
failing."""

import socket
import ssl
import subprocess
import threading

import pytest

from screentinker_native.logic import playlist_logic as PL
from screentinker_native.logic import rtsp_relay as RR
from screentinker_native.logic import rtsp_tls as R
from screentinker_native.player.items import Item


def test_rtsps_is_recognised():
    assert R.is_rtsps("rtsps://cam/x") and R.is_rtsps("  RTSPS://cam/x")
    assert not R.is_rtsps("rtsp://cam/x") and not R.is_rtsps(None)


def test_target_defaults_to_322_and_keeps_a_named_port():
    assert R.target("rtsps://u:p@cam.local/x") == ("cam.local", 322)
    assert R.target("rtsps://10.0.0.5:7441/abc") == ("10.0.0.5", 7441)
    assert R.target("rtsps://[fd00::5]/s") == ("fd00::5", 322)


def test_logs_never_carry_the_password():
    assert R.redact("rtsps://v:secret@cam:7441/s") == "rtsps://v:***@cam:7441/s"
    assert R.redact("open failed for rtsp://admin:pw@10.0.0.5/s (refused)") == "open failed for rtsp://admin:***@10.0.0.5/s (refused)"
    assert R.redact("rtsp://cam/s") == "rtsp://cam/s"
    assert R.redact("rtsp://user@cam/s") == "rtsp://user@cam/s"


def test_logs_never_carry_a_share_token():
    assert R.redact("rtsps://192.168.1.10:7441/Ab12Cd34Ef56Gh78?enableSrtp") == "rtsps://192.168.1.10:7441/***?enableSrtp"
    assert R.redact("rtsp://cam/h264Preview_01_main") == "rtsp://cam/h264Preview_01_main"
    assert R.redact("rtsp://cam/Streaming/Channels/101") == "rtsp://cam/Streaming/Channels/101"


def test_item_carries_the_flag_and_only_a_set_flag_changes_the_signature():
    a = Item.parse({"content_id": "c", "mime_type": "video/rtsp", "remote_url": "rtsps://h/x", "tls_self_signed": 1})
    b = Item.parse({"content_id": "c", "mime_type": "video/rtsp", "remote_url": "rtsps://h/x"})
    assert a.tls_self_signed and not b.tls_self_signed
    assert a.sig() != b.sig()
    assert a.sig() == b.sig() + "|tls-self-signed"
    assert a.live_connection != b.live_connection
    assert Item.parse({"content_id": "i", "mime_type": "image/png"}).live_connection is None


def test_fault_backoff_waits_longer_each_time_then_holds_at_30s():
    b = PL.FaultBackoff()
    now, waits = 0, []
    for _ in range(7):
        w = b.next(now)
        waits.append(w)
        now += w
    assert waits == [2000, 4000, 8000, 15000, 30000, 30000, 30000]
    assert b.next(now + 30000 + 60001) == 2000, "a new outage starts again at 2 s"


@pytest.fixture(scope="module")
def tls_camera(tmp_path_factory):
    """A TLS listener on loopback with a self-signed certificate for 'localhost'."""
    d = tmp_path_factory.mktemp("cam")
    key, crt = d / "k.pem", d / "c.pem"
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
                    "-addext", "subjectAltName=DNS:localhost", "-keyout", str(key), "-out", str(crt)],
                   check=True, capture_output=True)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(str(crt), str(key))
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(8)
    port = srv.getsockname()[1]
    stop = threading.Event()

    def serve():
        srv.settimeout(0.2)
        while not stop.is_set():
            try:
                c, _ = srv.accept()
            except OSError:
                continue
            try:
                with ctx.wrap_socket(c, server_side=True) as s:
                    s.recv(1)
            except (OSError, ssl.SSLError):
                pass

    t = threading.Thread(target=serve, daemon=True)
    t.start()
    yield port, crt
    stop.set()
    srv.close()


def test_a_self_signed_camera_is_refused_by_default(tls_camera):
    port, _ = tls_camera
    ok, why = R.verify("rtsps://viewer:pw@localhost:%d/cam" % port, timeout=5)
    assert not ok
    assert "not trusted" in why and "pw" not in why


def test_a_camera_with_a_trusted_certificate_passes(tls_camera):
    port, crt = tls_camera
    ctx = ssl.create_default_context(cafile=str(crt))
    ok, why = R.verify("rtsps://localhost:%d/cam" % port, timeout=5, context=ctx)
    assert ok, why


def test_the_wrong_host_name_is_refused_even_with_a_trusted_certificate(tls_camera):
    port, crt = tls_camera
    ctx = ssl.create_default_context(cafile=str(crt))
    ok, _ = R.verify("rtsps://127.0.0.1:%d/cam" % port, timeout=5, context=ctx)   # cert names localhost only
    assert not ok


def test_capability_is_declared():
    from screentinker_native import capabilities
    src = open(capabilities.__file__).read()
    assert '"playback.rtsps"' in src


# ------------------------------------------------------------------ the loopback relay

def test_local_url_keeps_the_login_path_and_query():
    assert RR.local_url("rtsps://v:p%40ss@10.0.0.5:7441/abc?enableSrtp", 5000) == "rtsp://v:p%40ss@127.0.0.1:5000/abc?enableSrtp"
    assert RR.local_url("rtsps://[fd00::5]/s", 5001) == "rtsp://127.0.0.1:5001/s"


def test_a_udp_setup_is_answered_461_here_and_never_reaches_the_camera():
    cs = RR.ClientStream()
    up, back = cs.feed(b"SETUP rtsp://127.0.0.1:9/x/track1 RTSP/1.0\r\nCSeq: 3\r\nTransport: RTP/AVP/UDP;unicast;client_port=5000-5001\r\n\r\n")
    assert up == b""
    assert back == b"RTSP/1.0 461 Unsupported Transport\r\nCSeq: 3\r\n\r\n"
    up, back = cs.feed(b"SETUP rtsp://127.0.0.1:9/x/track1 RTSP/1.0\r\nCSeq: 4\r\nTransport: RTP/AVP;unicast;client_port=5000-5001\r\n\r\n")
    assert up == b"" and b" 461 " in back, "RTP/AVP with no lower transport is UDP"


def test_messages_split_across_reads_and_interleaved_frames_pass_through_whole():
    cs = RR.ClientStream()
    tcp = b"SETUP rtsp://127.0.0.1:9/x RTSP/1.0\r\nCSeq: 5\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n"
    frame = b"$\x01\x00\x03abc"
    body = b"GET_PARAMETER rtsp://127.0.0.1:9/x RTSP/1.0\r\nCSeq: 6\r\nContent-Length: 4\r\n\r\nping"
    stream = tcp + frame + body
    got = b""
    for i in range(0, len(stream), 7):
        up, back = cs.feed(stream[i:i + 7])
        assert back == b""
        got += up
    assert got == stream


@pytest.fixture()
def rtsp_camera(tls_camera_cert):
    """A TLS 'camera' that answers every RTSP request 200 with its CSeq, sends one interleaved frame
    after PLAY, and records the request lines and frames it received."""
    crt, key = tls_camera_cert
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(str(crt), str(key))
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(4)
    seen = []

    def serve():
        try:
            c, _ = srv.accept()
        except OSError:
            return
        try:
            s = ctx.wrap_socket(c, server_side=True)
        except (OSError, ssl.SSLError):
            return                                     # a client that refused the certificate
        with s:
            buf = b""
            while True:
                try:
                    data = s.recv(4096)
                except (OSError, ssl.SSLError):
                    return
                if not data:
                    return
                buf += data
                while buf:
                    if buf[:1] == b"$":
                        n = 4 + int.from_bytes(buf[2:4], "big")
                        if len(buf) < n:
                            break
                        seen.append(buf[:n])
                        buf = buf[n:]
                        continue
                    i = buf.find(b"\r\n\r\n")
                    if i < 0:
                        break
                    head, buf = buf[:i], buf[i + 4:]
                    seen.append(head.split(b"\r\n")[0])
                    cseq = [ln.split(b":", 1)[1].strip() for ln in head.split(b"\r\n") if ln.lower().startswith(b"cseq")][0]
                    s.sendall(b"RTSP/1.0 200 OK\r\nCSeq: " + cseq + b"\r\n\r\n")
                    if head.startswith(b"PLAY "):
                        s.sendall(b"$\x00\x00\x04RTP!")

    threading.Thread(target=serve, daemon=True).start()
    yield srv.getsockname()[1], seen
    srv.close()


@pytest.fixture(scope="module")
def tls_camera_cert(tmp_path_factory):
    d = tmp_path_factory.mktemp("relaycam")
    key, crt = d / "k.pem", d / "c.pem"
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
                    "-addext", "subjectAltName=DNS:localhost", "-keyout", str(key), "-out", str(crt)],
                   check=True, capture_output=True)
    return crt, key


def _read_reply(sock):
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        assert chunk, "relay closed"
        buf += chunk
    return buf


def test_the_relay_refuses_a_self_signed_camera_unless_the_item_says_so(rtsp_camera):
    port, _ = rtsp_camera
    with pytest.raises(R.CameraTlsError) as e:
        RR.RtspsRelay("rtsps://viewer:pw@localhost:%d/cam" % port, False, connect_timeout=5).open()
    assert "not trusted" in str(e.value) and "pw" not in str(e.value)


def test_the_relay_plays_a_session_over_the_one_tls_connection(rtsp_camera):
    port, seen = rtsp_camera
    relay = RR.RtspsRelay("rtsps://viewer:pw@localhost:%d/cam?x=1" % port, True, connect_timeout=5)
    local = relay.open()
    assert local == "rtsp://viewer:pw@127.0.0.1:%d/cam?x=1" % relay.port
    q = socket.create_connection(("127.0.0.1", relay.port), timeout=5)
    try:
        q.sendall(b"OPTIONS rtsp://127.0.0.1/cam RTSP/1.0\r\nCSeq: 1\r\n\r\n")
        assert b"200 OK" in _read_reply(q)
        q.sendall(b"SETUP rtsp://127.0.0.1/cam/t0 RTSP/1.0\r\nCSeq: 2\r\nTransport: RTP/AVP/UDP;unicast;client_port=6000-6001\r\n\r\n")
        assert b" 461 " in _read_reply(q)
        q.sendall(b"SETUP rtsp://127.0.0.1/cam/t0 RTSP/1.0\r\nCSeq: 3\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n")
        assert b"CSeq: 3" in _read_reply(q)
        q.sendall(b"PLAY rtsp://127.0.0.1/cam RTSP/1.0\r\nCSeq: 4\r\n\r\n")
        got = b""
        while b"RTP!" not in got:
            chunk = q.recv(4096)
            assert chunk
            got += chunk
        q.sendall(b"$\x01\x00\x02RR")
        for _ in range(50):
            if b"$\x01\x00\x02RR" in seen:
                break
            threading.Event().wait(0.05)
        assert seen[:4] == [b"OPTIONS rtsp://127.0.0.1/cam RTSP/1.0", b"SETUP rtsp://127.0.0.1/cam/t0 RTSP/1.0",
                            b"PLAY rtsp://127.0.0.1/cam RTSP/1.0", b"$\x01\x00\x02RR"], seen
        assert not any(b"UDP" in x for x in seen), "the UDP SETUP never reached the camera"
        try:
            socket.create_connection(("127.0.0.1", relay.port), timeout=1).close()
            second = True
        except OSError:
            second = False
        assert not second, "one relay serves one connection"
    finally:
        q.close()
    for _ in range(50):
        if relay.closed:
            break
        threading.Event().wait(0.05)
    assert relay.closed, "the relay ends when Qt hangs up"
