"""Remote shell on macOS: the Linux implementation (POSIX pty, same wire contract), with one change —
how the interactive shell is started.

Linux uses `setsid -c` to give the shell the pty as its controlling terminal; macOS has no setsid(1).
The shell is started through screentinker_native/ptyexec.py instead: a FRESH process that calls
setsid() and ioctl(TIOCSCTTY) and then execs the shell, so job control and ^C work. The one-shot
`shell` command is Linux's as is (/bin/sh -c, its own session).
"""

import os
import subprocess

from ..linux import shell as _posix
from ..linux.shell import CHUNK, FLUSH_S, IDLE_S, MAX_SESSIONS, ONE_SHOT_MAX, run_one_shot  # noqa: F401
from ... import ptyexec


def login_shell():
    shell = os.environ.get("SHELL") or "/bin/zsh"
    return shell if os.path.exists(shell) else "/bin/sh"


class PtySession(_posix.PtySession):
    def _start(self, rows, cols):
        import asyncio
        import pty
        master, slave = pty.openpty()
        _posix._set_winsize(master, rows, cols)
        env = dict(os.environ, TERM="xterm-256color")
        env.pop("ST_SERVER_URL", None)
        try:
            proc = subprocess.Popen(ptyexec.command([login_shell(), "-l"]), stdin=slave, stdout=slave,
                                    stderr=slave, cwd=os.path.expanduser("~"), env=env, close_fds=True)
        finally:
            os.close(slave)
        self.pid, self.master = proc.pid, master
        self._proc = proc
        os.set_blocking(master, False)
        asyncio.get_running_loop().add_reader(master, self._on_readable)


class PtyManager(_posix.PtyManager):
    session_cls = PtySession
