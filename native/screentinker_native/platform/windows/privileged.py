"""The ONE door to SYSTEM on Windows: the ScreenTinkerHelper service, over a named pipe.

Same contract as Linux's st-helper (platform/linux/privileged.py): the player runs as the logged-in
user, and the handful of things that need SYSTEM — reboot, the clock, the timezone, the display
timeout, block-uninstall, installing a package — go to a service with a FIXED verb list that
re-validates every argument (winhelper/service.py). One JSON request, one JSON reply, per connection.

⚠️ The helper never runs anything the player hands it on trust. In particular an installer is only
run after the helper has checked its sha256 against the ADMIN-configured server's own announcement;
see winhelper/service.py. A compromised dashboard account can reach `shell` (the player user) but
must not be able to turn that into SYSTEM through this door.
"""

import asyncio
import json
import os
import shutil
import subprocess

PIPE = r"\\.\pipe\screentinker-helper"
CREATE_NO_WINDOW = 0x08000000


def available():
    """Is the helper there? ⚠️ NOT os.path.exists(PIPE): that OPENS a connection, which the helper then
    serves as an empty request, and between two pipe instances it can find none — the player declared
    no privileged capabilities at all after one unlucky probe (seen in the Win11 VM). WaitNamedPipe asks
    without connecting: ERROR_SEM_TIMEOUT means "exists, just busy", which is still yes.

    The answer is kept for AVAILABLE_TTL_S: the menu refresh asks on the UI thread, and a busy pipe
    makes WaitNamedPipe wait up to its full second."""
    import time
    now = time.monotonic()
    if _available_cache[0] is not None and now - _available_cache[1] < AVAILABLE_TTL_S:
        return _available_cache[0]
    _available_cache[:] = [_probe(), now]
    return _available_cache[0]


AVAILABLE_TTL_S = 30
_available_cache = [None, 0.0]     # (answer, monotonic time asked)


def _probe():
    import ctypes
    k32 = ctypes.windll.kernel32
    if k32.WaitNamedPipeW(PIPE, 1000):
        return True
    return k32.GetLastError() == 121       # ERROR_SEM_TIMEOUT: every instance busy, the helper is up


def _call(verb, args, timeout):
    import time
    deadline = time.monotonic() + 5
    while True:
        try:
            f = open(PIPE, "r+b", buffering=0)
            break
        except OSError as e:
            # ERROR_PIPE_BUSY (231): every server instance is serving someone; retry briefly.
            if getattr(e, "winerror", None) == 231 and time.monotonic() < deadline:
                time.sleep(0.1)
                continue
            return False, "helper service not reachable: %s" % e
    try:
        f.write((json.dumps({"verb": verb, "args": [str(a) for a in args]}) + "\n").encode())
        buf = b""
        while not buf.endswith(b"\n"):
            chunk = f.read(65536)
            if not chunk:
                break
            buf += chunk
        r = json.loads(buf.decode() or "{}")
        return bool(r.get("ok")), str(r.get("out") or "")
    except (OSError, ValueError) as e:
        return False, "helper call failed: %s" % e
    finally:
        f.close()


async def run(verb, *args, timeout=120):
    """Run a helper verb. Returns (ok, output). Never raises."""
    if not available():
        return False, "ScreenTinkerHelper service is not running"
    loop = asyncio.get_running_loop()
    try:
        return await asyncio.wait_for(loop.run_in_executor(None, _call, verb, args, timeout), timeout=timeout)
    except asyncio.TimeoutError:
        return False, "helper timed out"


async def run_cmd(argv, timeout=10):
    """Unprivileged command, argv form, no console window. Returns (returncode, output). Never raises."""
    if not shutil.which(argv[0]):
        return 127, "%s: not found" % argv[0]
    loop = asyncio.get_running_loop()

    def go():
        try:
            p = subprocess.run(argv, capture_output=True, timeout=timeout, creationflags=CREATE_NO_WINDOW)
            return p.returncode, (p.stdout + p.stderr).decode(errors="replace").strip()
        except subprocess.TimeoutExpired:
            return 124, "timed out"
        except OSError as e:
            return 126, str(e)
    return await loop.run_in_executor(None, go)


def powershell(script, timeout=20):
    """Synchronous, for startup probes. Returns stdout text or ''. Never raises."""
    try:
        p = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                           capture_output=True, timeout=timeout, creationflags=CREATE_NO_WINDOW)
        return p.stdout.decode(errors="replace").strip()
    except (OSError, subprocess.SubprocessError):
        return ""
