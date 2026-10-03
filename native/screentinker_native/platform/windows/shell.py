"""Remote shell on Windows: the one-shot `shell` command and interactive PTY sessions over ConPTY.

Same wire contract as platform/linux/shell.py (device:pty-open/-input/-resize/-close in,
device:pty-data/-exit out, base64 chunks, one ORDERED sender per session so an exit never overtakes
the last output). Differences, and why:
  * the shell is PowerShell — the dashboard's Windows presets are PowerShell, and `cmd` has no useful
    object output for Get-Service/Get-CimInstance;
  * ConPTY (via pywinpty) has no selectable fd, so each session has a reader THREAD that hands chunks
    to the asyncio loop with call_soon_threadsafe;
  * ConPTY speaks text: output is UTF-8 encoded before base64, input decoded from it.
"""

import asyncio
import base64
import logging
import os
import subprocess
import threading
import time

from .privileged import CREATE_NO_WINDOW

log = logging.getLogger("pty")

ONE_SHOT_TIMEOUT_S = 60
ONE_SHOT_MAX = 8000
MAX_SESSIONS = 2
CHUNK = 16 * 1024
FLUSH_S = 0.03
IDLE_S = 30 * 60
SHELL = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "WindowsPowerShell", "v1.0",
                     "powershell.exe")


async def run_one_shot(cmd):
    """Returns (output, exit_code). Output format matches Android byte for byte:
    stdout + "\\n[stderr]\\n" + stderr, truncated to 8000."""
    loop = asyncio.get_running_loop()

    def go():
        try:
            p = subprocess.run([SHELL, "-NoProfile", "-NonInteractive", "-Command", cmd],
                               stdin=subprocess.DEVNULL, capture_output=True, timeout=ONE_SHOT_TIMEOUT_S,
                               creationflags=CREATE_NO_WINDOW)
            out, err, code = p.stdout, p.stderr, p.returncode
        except subprocess.TimeoutExpired as e:
            out, err, code = (e.stdout or b""), b"timed out after %ds" % ONE_SHOT_TIMEOUT_S, -1
        except OSError as e:
            return "error: %s" % e, -1
        text = out.decode("utf-8", errors="replace").replace("\r\n", "\n")
        e2 = err.decode("utf-8", errors="replace").replace("\r\n", "\n")
        if e2:
            text += "\n[stderr]\n" + e2
        return text[:ONE_SHOT_MAX], code
    return await loop.run_in_executor(None, go)


class PtySession:
    def __init__(self, sid, rows, cols, emit, on_closed):
        from winpty import PtyProcess
        self.sid = sid
        self._emit = emit
        self._on_closed = on_closed
        self._loop = asyncio.get_running_loop()
        self._buf = bytearray()
        self._flush_handle = None
        self._out = asyncio.Queue()
        self._sender = asyncio.ensure_future(self._send_loop())
        self.last_activity = time.monotonic()
        self.closed = False
        rows = max(1, min(int(rows or 24), 500))
        cols = max(1, min(int(cols or 80), 1000))
        env = dict(os.environ)
        env.pop("ST_SERVER_URL", None)
        self._proc = PtyProcess.spawn([SHELL, "-NoLogo"], dimensions=(rows, cols),
                                      cwd=os.path.expanduser("~"), env=env)
        log.info("pty %s: spawned %s pid %s (%dx%d)", sid[:8], SHELL, getattr(self._proc, "pid", "?"), cols, rows)
        self._reader = threading.Thread(target=self._read_loop, name="pty-" + sid[:8], daemon=True)
        self._reader.start()
        # pywinpty's read() can stay blocked after the shell exits instead of raising EOF, so the
        # reader alone never notices `exit`; poll liveness from the loop as well.
        self._watch = asyncio.ensure_future(self._watch_alive())

    async def _watch_alive(self):
        while not self.closed:
            await asyncio.sleep(0.5)
            try:
                alive = self._proc.isalive()
            except Exception:
                alive = False
            if not alive and not self.closed:
                await asyncio.sleep(0.2)          # let the reader hand over the last output
                await self.close("exited")
                return

    def _read_loop(self):
        while True:
            try:
                data = self._proc.read(CHUNK)
            except EOFError:
                log.info("pty %s: EOF (alive=%s, status=%s)", self.sid[:8], self._proc.isalive(),
                         getattr(self._proc, "exitstatus", None))
                break
            except Exception as e:
                # Never swallow this silently: a reader that dies takes the whole session with it,
                # and the operator only sees a terminal that stopped answering.
                log.warning("pty %s reader failed: %r", self.sid[:8], e)
                break
            if not data:
                if not self._proc.isalive():
                    break
                time.sleep(0.02)
                continue
            b = data.encode("utf-8", errors="replace") if isinstance(data, str) else bytes(data)
            self._loop.call_soon_threadsafe(self._on_data, b)
        self._loop.call_soon_threadsafe(lambda: asyncio.ensure_future(self.close("exited")))

    def _on_data(self, b):
        self.last_activity = time.monotonic()
        self._buf += b
        if len(self._buf) >= CHUNK:
            self._flush()
        elif self._flush_handle is None:
            self._flush_handle = self._loop.call_later(FLUSH_S, self._flush)

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
            data = base64.b64decode(b64 or "", validate=False)[:65536]
        except (ValueError, TypeError):
            return
        self.last_activity = time.monotonic()
        try:
            self._proc.write(data.decode("utf-8", errors="replace"))
        except Exception:
            pass

    def resize(self, rows, cols):
        if not self.closed:
            try:
                self._proc.setwinsize(max(1, min(int(rows), 500)), max(1, min(int(cols), 1000)))
            except Exception:
                pass

    async def close(self, reason="closed", notify=True):
        if self.closed:
            return
        self.closed = True
        code = None
        try:
            if self._proc.isalive():
                self._proc.terminate(force=True)
            code = self._proc.exitstatus
        except Exception:
            pass
        # Let the reader deliver what ConPTY still held, then drain it before the exit.
        await asyncio.sleep(0.1)
        self._flush()
        if notify:
            self._out.put_nowait(("device:pty-exit", {"session_id": self.sid, "code": code, "reason": reason}))
        self._out.put_nowait(None)
        try:
            await asyncio.wait_for(self._sender, timeout=5)
        except (asyncio.TimeoutError, Exception):
            pass
        self._on_closed(self.sid)


class PtyManager:
    def __init__(self, emit):
        self._emit = emit
        self.sessions = {}
        self._reaper = None

    async def _reap(self):
        while True:
            await asyncio.sleep(60)
            now = time.monotonic()
            for s in list(self.sessions.values()):
                if now - s.last_activity > IDLE_S:
                    await s.close("idle")

    async def open(self, payload):
        sid = str((payload or {}).get("session_id") or "")
        if not sid or len(sid) > 128 or sid in self.sessions:
            return
        if len(self.sessions) >= MAX_SESSIONS:
            await self._emit("device:pty-exit", {"session_id": sid, "code": None, "reason": "too_many_sessions"})
            return
        try:
            s = PtySession(sid, payload.get("rows"), payload.get("cols"), self._emit,
                           lambda k: self.sessions.pop(k, None))
        except Exception as e:
            await self._emit("device:pty-exit", {"session_id": sid, "code": None, "reason": "spawn_failed: %s" % e})
            return
        self.sessions[sid] = s
        if self._reaper is None:
            self._reaper = asyncio.ensure_future(self._reap())

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
