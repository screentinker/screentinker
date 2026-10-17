"""rtsps:// cameras on the native player (RTSP over TLS).

Qt's FFmpeg backend can open rtsps:// itself, but FFmpeg's TLS does NOT check the certificate
(tls_verify defaults to 0, and QMediaPlayer has no way to pass it). So Qt is never given an rtsps
URL: the player opens the TLS connection here, checks the camera's certificate on it (the system's
trusted authorities and the host name), and relays that same connection to Qt as plain RTSP on
loopback (logic/rtsp_relay.py). Checking on a first connection and letting Qt open a second one would
leave the second unchecked. An item marked tls_self_signed skips the check (the operator ticked it
for a camera with a self-signed certificate): still encrypted, but who answers is not verified. Same
rule as Android's RtspSources.kt.

The check runs before any RTSP is spoken, so a camera that fails it is never sent the username and
password in the URL.
"""

import re
import socket
import ssl
import urllib.parse

RTSPS_DEFAULT_PORT = 322
_USERINFO = re.compile(r"(\w+://[^/@:\s'\"]*):[^/@\s'\"]*@")
# A share token in the path (UniFi Protect: rtsps://nvr:7441/Ab12Cd34Ef56Gh78) opens the stream on
# its own, so logs hide it like a password. Same rule as the server's isSecretPathSegment.
_PATH_TOKEN = re.compile(r"(?<=/)(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])[A-Za-z0-9]{16,}(?=[/?#\s'\"]|$)")


def is_rtsps(url):
    return isinstance(url, str) and url.strip().lower().startswith("rtsps://")


def target(url):
    """(host, port) a TLS connection to this rtsps URL goes to. Port 322 when the URL names none."""
    u = urllib.parse.urlsplit(url.strip())
    return u.hostname, (u.port or RTSPS_DEFAULT_PORT)


def redact(url):
    """The URL with its password and any share token replaced, for logs:
    rtsp://user:pass@cam -> rtsp://user:***@cam, rtsps://nvr:7441/<token> -> rtsps://nvr:7441/***"""
    if not isinstance(url, str):
        return str(url)
    out = _USERINFO.sub(r"\1:***@", url)
    return _PATH_TOKEN.sub("***", out) if "://" in out else out


class CameraTlsError(Exception):
    """The camera could not be reached over TLS, or its certificate was refused. str() says which."""


def connect(url, self_signed, timeout=8.0, context=None):
    """Open a TLS connection to the camera, checking its certificate unless `self_signed`. Returns
    the connected SSLSocket (blocking, `timeout` cleared) or raises CameraTlsError. Blocking: run it
    off the UI thread."""
    try:
        host, port = target(url)
    except ValueError as e:
        raise CameraTlsError("bad camera address: %s" % e)
    if not host:
        raise CameraTlsError("no host in the camera address")
    ctx = context
    if ctx is None:
        ctx = ssl.create_default_context()
        if self_signed:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
    raw = None
    try:
        raw = socket.create_connection((host, port), timeout=timeout)
        tls = ctx.wrap_socket(raw, server_hostname=host)
        tls.settimeout(None)
        return tls
    except ssl.SSLCertVerificationError as e:
        _close(raw)
        raise CameraTlsError("camera certificate not trusted (%s); tick \"Camera uses a self-signed certificate\" if it is self-signed" % (e.verify_message or e))
    except (OSError, ssl.SSLError) as e:
        _close(raw)
        raise CameraTlsError("could not reach the camera over TLS: %s" % e)


def _close(s):
    try:
        if s is not None:
            s.close()
    except OSError:
        pass


def verify(url, timeout=8.0, context=None):
    """Check the camera's certificate on a connection of its own. (True, "") or (False, why)."""
    try:
        connect(url, False, timeout=timeout, context=context).close()
        return True, ""
    except CameraTlsError as e:
        return False, str(e)
