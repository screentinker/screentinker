"""An rtsps:// camera handed to Qt as plain RTSP on loopback.

FFmpeg (Qt's video engine) accepts any TLS certificate, and QMediaPlayer cannot be told otherwise. So
the player makes the TLS connection itself (rtsp_tls.connect, certificate checked unless the item is
tls_self_signed), listens on 127.0.0.1, and gives Qt rtsp://127.0.0.1:<port>/<same path>. Every byte
Qt sends goes down that one checked connection; nothing else ever talks to the camera.

Two RTSP details make that work:
- Qt's FFmpeg asks for RTP over UDP first. Over a relay that would send the picture to this machine
  in the clear, outside the TLS connection, so a SETUP that asks for anything but TCP is answered here
  with 461 Unsupported Transport. FFmpeg then asks again for TCP-interleaved, which rides the
  connection, as on Android (setForceUseRtpTcp).
- Requests carry absolute URLs (rtsp://127.0.0.1:<port>/...). They are passed on unchanged: a Digest
  login signs that URL, so rewriting it would break the login, and cameras answer by path.

One relay serves one connection: the first loopback client is accepted, the listener closes, and the
relay ends when either side closes. A Qt that never connects is given up on after ACCEPT_TIMEOUT_S.

Pure sockets, no Qt, so it runs under pytest.
"""

import re
import select
import socket
import threading
import urllib.parse

from . import rtsp_tls

ACCEPT_TIMEOUT_S = 30.0
MAX_HEADER = 64 * 1024
_CSEQ = re.compile(rb"^cseq:\s*(\S+)", re.I | re.M)
_TRANSPORT = re.compile(rb"^transport:\s*(.+)$", re.I | re.M)
_CONTENT_LENGTH = re.compile(rb"^content-length:\s*(\d+)", re.I | re.M)


def local_url(url, port):
    """The camera URL with its host and port replaced by 127.0.0.1:<port> and the scheme by rtsp.
    The username and password stay (FFmpeg answers the camera's login with them)."""
    u = urllib.parse.urlsplit(url.strip())
    netloc = u.netloc
    userinfo = netloc.rsplit("@", 1)[0] + "@" if "@" in netloc else ""
    return urllib.parse.urlunsplit(("rtsp", "%s127.0.0.1:%d" % (userinfo, port), u.path, u.query, ""))


def _unsupported_transport(cseq):
    return b"RTSP/1.0 461 Unsupported Transport\r\nCSeq: " + cseq + b"\r\n\r\n"


class ClientStream:
    """Splits what Qt sends into whole RTSP messages and interleaved ($) frames. feed() returns
    (to_camera, to_client): the bytes to pass on, and any answer made here (461 for a UDP SETUP)."""

    def __init__(self):
        self.buf = b""

    def feed(self, data):
        self.buf += data
        up, back = [], []
        while self.buf:
            if self.buf[:1] == b"$":
                if len(self.buf) < 4:
                    break
                end = 4 + int.from_bytes(self.buf[2:4], "big")
                if len(self.buf) < end:
                    break
                up.append(self.buf[:end])
                self.buf = self.buf[end:]
                continue
            head_end = self.buf.find(b"\r\n\r\n")
            if head_end < 0:
                if len(self.buf) > MAX_HEADER:
                    raise ValueError("RTSP request header too long")
                break
            head = self.buf[:head_end]
            m = _CONTENT_LENGTH.search(head)
            end = head_end + 4 + (int(m.group(1)) if m else 0)
            if len(self.buf) < end:
                break
            msg, self.buf = self.buf[:end], self.buf[end:]
            if head[:6].upper() == b"SETUP ":
                t = _TRANSPORT.search(head)
                if not t or b"/TCP" not in t.group(1).upper():
                    c = _CSEQ.search(head)
                    back.append(_unsupported_transport(c.group(1) if c else b"0"))
                    continue
            up.append(msg)
        return b"".join(up), b"".join(back)


class RtspsRelay:
    def __init__(self, url, self_signed, connect_timeout=8.0, context=None):
        self.url = url
        self.self_signed = self_signed
        self.connect_timeout = connect_timeout
        self.context = context
        self.cam = None
        self.listener = None
        self.port = None
        self._closed = threading.Event()

    def open(self):
        """Connect to the camera (certificate checked unless self_signed) and start listening.
        Returns the rtsp://127.0.0.1 URL to give Qt. Raises rtsp_tls.CameraTlsError. Blocking."""
        self.cam = rtsp_tls.connect(self.url, self.self_signed, timeout=self.connect_timeout, context=self.context)
        try:
            self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.listener.bind(("127.0.0.1", 0))
            self.listener.listen(1)
            self.listener.settimeout(ACCEPT_TIMEOUT_S)
            self.port = self.listener.getsockname()[1]
        except OSError:
            self.close()
            raise
        threading.Thread(target=self._serve, name="rtsps-relay", daemon=True).start()
        return local_url(self.url, self.port)

    def close(self):
        self._closed.set()
        for s in (self.listener, self.cam):
            try:
                if s is not None:
                    s.close()
            except OSError:
                pass

    @property
    def closed(self):
        return self._closed.is_set()

    def _serve(self):
        client = None
        try:
            try:
                client, addr = self.listener.accept()
            except (OSError, socket.timeout):
                return
            finally:
                try:
                    self.listener.close()
                except OSError:
                    pass
            if addr[0] != "127.0.0.1":
                return
            client.settimeout(None)
            self._pump(client)
        finally:
            if client is not None:
                try:
                    client.close()
                except OSError:
                    pass
            self.close()

    def _pump(self, client):
        """One thread, both directions: an SSL socket must not be read and written from two threads."""
        stream = ClientStream()
        cam = self.cam
        try:
            self._pump_loop(client, cam, stream)
        except OSError:
            return

    def _pump_loop(self, client, cam, stream):
        while not self._closed.is_set():
            if cam.pending():
                ready = [cam]
            else:
                ready, _, _ = select.select([client, cam], [], [], 1.0)
            for s in ready:
                try:
                    data = s.recv(65536)
                except ValueError:
                    return
                if not data:
                    return
                if s is cam:
                    client.sendall(data)
                else:
                    try:
                        up, back = stream.feed(data)
                    except ValueError:
                        return
                    if back:
                        client.sendall(back)
                    if up:
                        cam.sendall(up)
