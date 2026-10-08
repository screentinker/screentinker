"""Remote shell: the one-shot `shell` command (Android parity) and interactive PTY sessions.

ONE-SHOT is exactly Android's WebSocketService shell handler: `sh -c cmd` as the player user, wait,
reply once with stdout + "\\n[stderr]\\n" + stderr, truncated to 8000 chars. The server truncates to
the same figure (deviceSocket.js), so larger output is wasted bytes on the wire.

PTY is new (capability system.pty): a login shell on a pseudo-terminal, streamed both ways as base64
chunks through the device socket. The server owns the authorization and the audit trail; this side
owns the process and must never outlive its session:
  * every session is killed on pty-close, on socket disconnect, and on idle (IDLE_S);
  * output is coalesced (up to CHUNK bytes or FLUSH_S) so `yes` cannot become thousands of events a
    second — the server drops frames over 64 KiB, so CHUNK stays well under it after base64;
  * the shell runs as the player's user, same as one-shot. ⚠️ If that user has sudo, so does the
    dashboard. The Lite installer creates a dedicated user without sudo for exactly this reason.
"""

import asyncio
import base64
import fcntl
import os
import pty
import signal
import struct
import subprocess
import termios
import time

ONE_SHOT_TIMEOUT_S = 60
ONE_SHOT_MAX = 8000

MAX_SESSIONS = 2
CHUNK = 16 * 1024
FLUSH_S = 0.03
IDLE_S = 30 * 60


async def run_one_shot(cmd):
    """Returns (output, exit_code). Output format matches Android byte for byte."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "/bin/sh", "-c", cmd, stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            start_new_session=True)
    except OSError as e:
        return "error: %s" % e, -1
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=ONE_SHOT_TIMEOUT_S)
        code = proc.returncode
    except asyncio.TimeoutError:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        out, err = b"", b"timed out after %ds" % ONE_SHOT_TIMEOUT_S
        code = -1
    text = out.decode(errors="replace")
    e = err.decode(errors="replace")
    if e:
        text += "\n[stderr]\n" + e
    return text[:ONE_SHOT_MAX], code


def _set_winsize(fd, rows, cols):
    rows = max(1, min(int(rows or 24), 500))
    cols = max(1, min(int(cols or 80), 1000))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


class PtySession:
    def __init__(self, sid, rows, cols, emit, on_closed):
        self.sid = sid
        self._emit = emit              # async (event, payload)
        self._on_closed = on_closed
        self._buf = bytearray()
        self._flush_handle = None
        self.last_activity = time.monotonic()
        self.closed = False
        self.pid = None
        self.master = None
        # ⚠️ ONE ordered sender. Output chunks and the final exit must reach the server in the order
        # they happened: the relay drops data for a session it has closed, so an exit that overtakes
        # the last chunk loses the end of the output (seen in e2e: `stty size; exit` printed nothing).
        self._out = asyncio.Queue()
        self._sender = asyncio.ensure_future(self._send_loop())
        self._start(rows, cols)

    def _start(self, rows, cols):
        shell = os.environ.get("SHELL") or "/bin/bash"
        if not os.path.exists(shell):
            shell = "/bin/sh"
        # ⚠️ Not pty.fork(): this process runs Qt and asyncio threads, and forking a threaded process
        # can deadlock the child on a lock another thread held. openpty + Popen execs immediately;
        # `setsid -c` gives the shell a new session with the pty as its CONTROLLING terminal, without
        # which bash prints "no job control" and ^C never reaches the foreground job.
        master, slave = pty.openpty()
        _set_winsize(master, rows, cols)
        env = dict(os.environ, TERM="xterm-256color")
        env.pop("ST_SERVER_URL", None)
        try:
            proc = subprocess.Popen(["setsid", "-c", shell, "-l"], stdin=slave, stdout=slave, stderr=slave,
                                    cwd=os.path.expanduser("~"), env=env, close_fds=True)
        finally:
            os.close(slave)
        self.pid, self.master = proc.pid, master
        self._proc = proc
        os.set_blocking(master, False)
        asyncio.get_running_loop().add_reader(master, self._on_readable)

    def _on_readable(self):
        try:
            data = os.read(self.master, CHUNK)
        except BlockingIOError:
            return
        except OSError:
            data = b""
        if not data:  # EIO on Linux when the child exits
            asyncio.ensure_future(self.close("exited"))
            return
        self.last_activity = time.monotonic()
        self._buf += data
        if len(self._buf) >= CHUNK:
            self._flush()
        elif self._flush_handle is None:
            self._flush_handle = asyncio.get_running_loop().call_later(FLUSH_S, self._flush)

    async def _send_loop(self):
        while True:
            item = await self._out.get()
            if item is None:
                return
            try:
                await self._emit(*item)
            except Exception:
                pass

    def _flush(self):
        if self._flush_handle is not None:
            self._flush_handle.cancel()
        self._flush_handle = None
        while self._buf:
            part = bytes(self._buf[:CHUNK])
            del self._buf[:CHUNK]
            self._out.put_nowait(("device:pty-data", {"session_id": self.sid,
                                                      "data": base64.b64encode(part).decode()}))

    def write(self, b64):
        if self.closed:
            return
        try:
            data = base64.b64decode(b64 or "", validate=False)
        except (ValueError, TypeError):
            return
        self.last_activity = time.monotonic()
        try:
            os.write(self.master, data[:65536])
        except OSError:
            pass

    def resize(self, rows, cols):
        if not self.closed:
            try:
                _set_winsize(self.master, rows, cols)
                os.kill(self.pid, signal.SIGWINCH)
            except (OSError, ValueError, TypeError):
                pass

    async def close(self, reason="closed", notify=True):
        if self.closed:
            return
        self.closed = True
        loop = asyncio.get_running_loop()
        try:
            loop.remove_reader(self.master)
        except Exception:
            pass
        self._flush()
        code = None
        try:
            os.killpg(self.pid, signal.SIGHUP)   # setsid made the shell its own group leader
        except OSError:
            pass
        for _ in range(20):
            code = self._proc.poll()
            if code is not None:
                break
            await asyncio.sleep(0.05)
        else:
            try:
                os.killpg(self.pid, signal.SIGKILL)
            except OSError:
                pass
            try:
                code = self._proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
        # Anything the shell wrote while dying is still in the pty: drain it before the exit.
        try:
            while True:
                tail = os.read(self.master, CHUNK)
                if not tail:
                    break
                self._buf += tail
        except OSError:
            pass
        self._flush()
        try:
            os.close(self.master)
        except OSError:
            pass
        if notify:
            self._out.put_nowait(("device:pty-exit", {"session_id": self.sid, "code": code, "reason": reason}))
        self._out.put_nowait(None)
        try:
            await asyncio.wait_for(self._sender, timeout=5)
        except (asyncio.TimeoutError, Exception):
            pass
        self._on_closed(self.sid)


class PtyManager:
    # The session class is the one per-OS seam: macOS (platform/macos/shell.py) reuses all of this and
    # replaces only how the shell process is started.
    session_cls = PtySession

    def __init__(self, emit):
        self._emit = emit
        self.sessions = {}
        self._reaper = None

    def _start_reaper(self):
        if self._reaper is None:
            self._reaper = asyncio.ensure_future(self._reap())

    async def _reap(self):
        while True:
            await asyncio.sleep(60)
            now = time.monotonic()
            for s in list(self.sessions.values()):
                if now - s.last_activity > IDLE_S:
                    await s.close("idle")

    async def open(self, payload):
        sid = str((payload or {}).get("session_id") or "")
        if not sid or len(sid) > 128:
            return
        if sid in self.sessions:
            return
        if len(self.sessions) >= MAX_SESSIONS:
            await self._emit("device:pty-exit", {"session_id": sid, "code": None, "reason": "too_many_sessions"})
            return
        try:
            s = self.session_cls(sid, payload.get("rows"), payload.get("cols"), self._emit,
                           lambda k: self.sessions.pop(k, None))
        except OSError as e:
            await self._emit("device:pty-exit", {"session_id": sid, "code": None, "reason": "spawn_failed: %s" % e})
            return
        self.sessions[sid] = s
        self._start_reaper()

    def input(self, payload):
        s = self.sessions.get(str((payload or {}).get("session_id") or ""))
        if s:
            s.write(payload.get("data"))

    def resize(self, payload):
        s = self.sessions.get(str((payload or {}).get("session_id") or ""))
        if s:
            s.resize(payload.get("rows"), payload.get("cols"))

    async def close(self, payload):
        s = self.sessions.get(str((payload or {}).get("session_id") or ""))
        if s:
            await s.close("closed")

    async def close_all(self, reason, notify=False):
        for s in list(self.sessions.values()):
            await s.close(reason, notify=notify)
