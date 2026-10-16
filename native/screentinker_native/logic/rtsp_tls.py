"""rtsps:// cameras on the native player (RTSP over TLS).

Qt's FFmpeg backend opens rtsps:// itself, but FFmpeg's TLS does NOT check the certificate
(tls_verify defaults to 0, and QMediaPlayer has no way to pass it). So the player checks the
camera's certificate here first, with the system's trusted authorities and the host name, and hands
the URL to Qt only when that passes. An item marked tls_self_signed skips the check (the operator
ticked it for a camera with a self-signed certificate): still encrypted, but who answers is not
verified. Same rule as Android's RtspSources.kt.

The check runs before any RTSP is spoken, so a camera that fails it is never sent the username and
password in the URL.
"""

import re
import socket
import ssl
import urllib.parse

RTSPS_DEFAULT_PORT = 322
_USERINFO = re.compile(r"(\w+://[^/@:\s'\"]*):[^/@\s'\"]*@")


def is_rtsps(url):
    return isinstance(url, str) and url.strip().lower().startswith("rtsps://")


def needs_check(url, self_signed):
    return is_rtsps(url) and not self_signed


def target(url):
    """(host, port) a TLS connection to this rtsps URL goes to. Port 322 when the URL names none."""
    u = urllib.parse.urlsplit(url.strip())
    return u.hostname, (u.port or RTSPS_DEFAULT_PORT)


def redact(url):
    """The URL with its password replaced, for logs: rtsp://user:pass@cam -> rtsp://user:***@cam"""
    if not isinstance(url, str):
        return str(url)
    return _USERINFO.sub(r"\1:***@", url)


def verify(url, timeout=8.0, context=None):
    """Open a TLS connection to the camera and check its certificate. (True, "") or (False, why).
    Blocking: run it off the UI thread."""
    try:
        host, port = target(url)
    except ValueError as e:
        return False, "bad camera address: %s" % e
    if not host:
        return False, "no host in the camera address"
    ctx = context or ssl.create_default_context()
    try:
        with socket.create_connection((host, port), timeout=timeout) as raw:
            with ctx.wrap_socket(raw, server_hostname=host):
                return True, ""
    except ssl.SSLCertVerificationError as e:
        return False, "camera certificate not trusted (%s); tick \"Camera uses a self-signed certificate\" if it is self-signed" % (e.verify_message or e)
    except (OSError, ssl.SSLError) as e:
        return False, "could not reach the camera over TLS: %s" % e
