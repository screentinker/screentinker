"""rtsps:// on the native player: the certificate check that runs before Qt is given the URL
(FFmpeg itself accepts any certificate), the default port, log redaction, the per-item
tls_self_signed flag, and the backoff when the only playable item keeps failing."""

import socket
import ssl
import subprocess
import threading

import pytest

from screentinker_native.logic import playlist_logic as PL
from screentinker_native.logic import rtsp_tls as R
from screentinker_native.player.items import Item


def test_rtsps_needs_a_check_unless_self_signed():
    assert R.needs_check("rtsps://cam/x", False)
    assert not R.needs_check("rtsps://cam/x", True)
    assert not R.needs_check("rtsp://cam/x", False)
    assert not R.needs_check(None, False)


def test_target_defaults_to_322_and_keeps_a_named_port():
    assert R.target("rtsps://u:p@cam.local/x") == ("cam.local", 322)
    assert R.target("rtsps://10.0.0.5:7441/abc") == ("10.0.0.5", 7441)
    assert R.target("rtsps://[fd00::5]/s") == ("fd00::5", 322)


def test_logs_never_carry_the_password():
    assert R.redact("rtsps://v:secret@cam:7441/s") == "rtsps://v:***@cam:7441/s"
    assert R.redact("open failed for rtsp://admin:pw@10.0.0.5/s (refused)") == "open failed for rtsp://admin:***@10.0.0.5/s (refused)"
    assert R.redact("rtsp://cam/s") == "rtsp://cam/s"
    assert R.redact("rtsp://user@cam/s") == "rtsp://user@cam/s"


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
